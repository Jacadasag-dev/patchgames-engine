/** Persist alongside water/destruction. Stable floats skip native integration
 * and follow small measured wakes; disturbances restore physical motion. */
import type {PhysicsCompoundBody,PhysicsImpact,PhysicsRotation,PhysicsScene,PhysicsVector} from './physics.ts';
import type {LiquidContact} from './waterDomain.ts';
import {sampleWaterBody,type WaterBodyManifest,type WaterBodyState} from './waterBody.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {waterBodyDepthCurrentCoupling} from './waterBodyDepthCurrents.ts';
import {applyWaterBodyBuoyancy,type WaterBodyBuoyancyOptions} from './waterBodyBuoyancy.ts';
import {liquidDestructionBodies} from './liquidCoupling.ts';
import {liquidObstacles,liquidRotate} from './liquidCollision.ts';
import {structuralColliderId,type DestructionState,type StructuralManifest} from './destruction.ts';

export const WATER_BODY_FLOATING_LIMITS=Object.freeze({bodies:64,probeInterval:.25,settleSeconds:1.5,stabilityCandidates:4,
  /** A visible surface drift must return to current-relative drag. Use a
   * lower entry limit so small changes cannot alternate rest and wake. */
  currentWakeSpeed:.015,currentRestSpeed:.0075});
export interface WaterBodyFloatingBody {
  bodyId:string;memberKey:string;mass:number;displacementScale:number;colliderIds:string[];
  /** World-axis bounds relative to the body's settled pivot. */
  min:PhysicsVector;max:PhysicsVector;
  referenceSurface:number;referenceBed:number;surfaceOffset:number;targetY:number;
  position:PhysicsVector;rotation:PhysicsRotation;
}
export interface WaterBodyFloatingState {
  waterRevision:string;structureRevision:string;time:number;nextProbeAt:number;
  resting:WaterBodyFloatingBody[];quiet:Record<string,number>;
  previousPositions:Record<string,PhysicsVector>;
}
export interface WaterBodyFloatingStep {
  water:WaterBodyManifest;state:WaterBodyState;structure:StructuralManifest;destruction:DestructionState;
  floating:WaterBodyFloatingState;dt:number;
  /** Base solid scene, excluding this structure's generated settled colliders. */
  scene?:PhysicsScene;
  /** Actual liquid contacts and native impacts from this accepted step. */
  contacts?:LiquidContact[];impacts?:PhysicsImpact[];
  /** Pass native ground contacts to reject bodies resting on other objects. */
  groundedBodyIds?:string[];
  /** Match authored displacement settings used by the active buoyancy call. */
  displacementScale?:number;bodyOptions?:Record<string,WaterBodyBuoyancyOptions>;
}
export interface WaterBodyFloatingResult {
  destruction:DestructionState;floating:WaterBodyFloatingState;
  stats:{resting:number;entered:number;woken:number;surfaceSamples:number;buoyancyProbes:number;stabilityProbes:number};
}
const zero=():PhysicsVector=>({x:0,y:0,z:0});
const speed=(v:PhysicsVector)=>Math.hypot(v.x,v.y,v.z);
const finite=(n:number)=>Number.isFinite(n);
const vector=(v:PhysicsVector)=>!!v&&[v.x,v.y,v.z].every(finite);
const distance=(a:PhysicsVector,b:PhysicsVector)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const rotationChanged=(a:PhysicsRotation,b:PhysicsRotation)=>1-Math.abs(a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w)>1e-6;
const key=(ids:string[])=>JSON.stringify(ids);

export function createWaterBodyFloatingState(water:WaterBodyManifest,structure:StructuralManifest):WaterBodyFloatingState {
  return{waterRevision:water.revision,structureRevision:structure.revision,time:0,nextProbeAt:0,resting:[],quiet:{},previousPositions:{}};
}
/** Validate checkpoints against the exact water and structure manifests. */
export function validateWaterBodyFloatingState(w:WaterBodyManifest,structure:StructuralManifest,s:WaterBodyFloatingState):void {
  if(!s||s.waterRevision!==w.revision||s.structureRevision!==structure.revision||!finite(s.time)||s.time<0
    ||!finite(s.nextProbeAt)||s.nextProbeAt<0||!Array.isArray(s.resting)||s.resting.length>64||!s.quiet||typeof s.quiet!=='object'||Array.isArray(s.quiet)
    ||Object.keys(s.quiet).length>64||Object.values(s.quiet).some(v=>!finite(v)||v<0||v>60)
    ||!s.previousPositions||typeof s.previousPositions!=='object'||Array.isArray(s.previousPositions)||Object.keys(s.previousPositions).length>64
    ||Object.values(s.previousPositions).some(p=>!vector(p)))throw new Error('Invalid water body floating state');
  const ids=new Set<string>();
  for(const b of s.resting){
    if(!b||typeof b.bodyId!=='string'||!b.bodyId||ids.has(b.bodyId)||typeof b.memberKey!=='string'||!finite(b.mass)||b.mass<=0
      ||!finite(b.displacementScale)||b.displacementScale<0||b.displacementScale>1
      ||!Array.isArray(b.colliderIds)||b.colliderIds.length>32||b.colliderIds.some(id=>typeof id!=='string')
      ||![b.min,b.max,b.position,b.rotation].every(vector)||!finite(b.rotation.w)||Math.abs(Math.hypot(b.rotation.x,b.rotation.y,b.rotation.z,b.rotation.w)-1)>.001
      ||![b.referenceSurface,b.referenceBed,b.surfaceOffset,b.targetY].every(finite)
      ||(['x','y','z'] as const).some(a=>b.min[a]>b.max[a]))throw new Error('Invalid water body floating body');
    ids.add(b.bodyId);
  }
}

type Bounds={min:PhysicsVector;max:PhysicsVector};
function bounds(body:PhysicsCompoundBody):Bounds|undefined {
  const obstacles=liquidObstacles({colliders:[]},[body]);if(!obstacles.length)return;
  return{min:{x:Math.min(...obstacles.map(o=>o.min.x)),y:Math.min(...obstacles.map(o=>o.min.y)),z:Math.min(...obstacles.map(o=>o.min.z))},
    max:{x:Math.max(...obstacles.map(o=>o.max.x)),y:Math.max(...obstacles.map(o=>o.max.y)),z:Math.max(...obstacles.map(o=>o.max.z))}};
}
function relative(b:Bounds,p:PhysicsVector):Bounds{return{min:{x:b.min.x-p.x,y:b.min.y-p.y,z:b.min.z-p.z},max:{x:b.max.x-p.x,y:b.max.y-p.y,z:b.max.z-p.z}};}
function world(b:Bounds,p:PhysicsVector):Bounds{return{min:{x:b.min.x+p.x,y:b.min.y+p.y,z:b.min.z+p.z},max:{x:b.max.x+p.x,y:b.max.y+p.y,z:b.max.z+p.z}};}
function overlaps(a:Bounds,b:Bounds,margin=0):boolean{return (['x','y','z'] as const).every(k=>a.max[k]+margin>=b.min[k]&&a.min[k]-margin<=b.max[k]);}
/** Nine probes stay inside the solid's footprint. Expanding them beyond the
 * object rejected perfectly supported floats beside a pool wall because a
 * probe could land outside the basin. Exact entry buoyancy still checks the
 * actual displaced volume, so these samples never invent edge support. */
function support(w:WaterBodyManifest,s:WaterBodyState,b:Bounds){
  const insetX=Math.min(.015,(b.max.x-b.min.x)*.05),insetZ=Math.min(.015,(b.max.z-b.min.z)*.05);
  const points=[b.min.x+insetX,(b.min.x+b.max.x)/2,b.max.x-insetX]
    .flatMap(x=>[b.min.z+insetZ,(b.min.z+b.max.z)/2,b.max.z-insetZ].map(z=>({x,z})));
  const samples=points.map(p=>sampleWaterBody(w,s,p));
  if(samples.some(p=>!p||p.depth<=w.wetDepth))return;
  const wet=samples as NonNullable<ReturnType<typeof sampleWaterBody>>[];
  const surfaces=wet.map(p=>p.surface);
  // Resolve the surface's tilt over this object's own footprint. An absolute
  // five-centimetre spread misses a substantial roll on a narrow plank, even
  // while correctly following a uniform level change as cheap vertical bobbing.
  const slopeX=(surfaces[6]+surfaces[7]+surfaces[8]-surfaces[0]-surfaces[1]-surfaces[2])/(3*Math.max(.01,b.max.x-b.min.x-2*insetX));
  const slopeZ=(surfaces[2]+surfaces[5]+surfaces[8]-surfaces[0]-surfaces[3]-surfaces[6])/(3*Math.max(.01,b.max.z-b.min.z-2*insetZ));
  // A bobbing hull makes opposed outward/inward currents that should not
  // revive its full rigid-body solve. Detect coherent translation and yaw
  // across the footprint instead. The existing stronger local-flow limit
  // still catches jets that these symmetric probes might average away.
  const centerX=(b.min.x+b.max.x)/2,centerZ=(b.min.z+b.max.z)/2;
  // Depth currents vanish at the closed surface. Sample the submerged hull,
  // otherwise a downwelling under a resting float would never wake it.
  const coupling=waterBodyDepthCurrentCoupling(w,s),d=s.depthCurrents,cells=waterBodyCells(w,s);
  const currents=wet.map((p,i)=>{
    const point={...points[i],y:(Math.max(p.bed,b.min.y)+Math.min(p.surface,b.max.y))*.5};
    const sample=sampleWaterBody(w,s,point)?.velocity??p.velocity;
    if(!coupling||!d)return sample;
    const residual={x:0,y:0,z:0},axes=['x','y','z'] as const,faces=[d.velocityX,d.velocityY,d.velocityZ];
    for(const entry of coupling.stencil(point))residual[axes[entry.axis]]+=faces[entry.axis][entry.face]*entry.weight;
    const index=cells.locate(point);if(index===undefined)return sample;
    return{x:cells.flowX[index]+residual.x,y:residual.y,z:cells.flowZ[index]+residual.z};
  });
  let meanX=0,meanY=0,meanZ=0,turn=0,radiusSquared=0,maxRadius=0;
  for(let i=0;i<wet.length;i++){
    const x=points[i].x-centerX,z=points[i].z-centerZ,r2=x*x+z*z;
    meanX+=currents[i].x;meanY+=currents[i].y;meanZ+=currents[i].z;
    turn+=x*currents[i].z-z*currents[i].x;
    radiusSquared+=r2;maxRadius=Math.max(maxRadius,Math.sqrt(r2));
  }
  const currentMotion=Math.max(Math.hypot(meanX,meanY,meanZ)/wet.length,Math.abs(turn)*maxRadius/Math.max(1e-8,radiusSquared));
  return{surface:surfaces.reduce((a,b)=>a+b,0)/wet.length,bed:Math.max(...wet.map(p=>p.bed)),
    spread:Math.max(...surfaces)-Math.min(...surfaces),tilt:Math.hypot(slopeX,slopeZ),flow:Math.max(...currents.map(speed)),currentMotion};
}
function colliderIds(structure:StructuralManifest,ids:string[]):string[]{
  return ids.flatMap(id=>structure.members.find(m=>m.id===id)!.colliders.map((_,i)=>structuralColliderId(structure,id,i)));
}
/** Native body/body contacts have two directed records, while a hit on a
 * sleeping static has one. Canonicalize each collider pair before summing, so
 * simultaneous contacts all contribute and the reverse record contributes
 * nothing extra. Native already aggregates the substeps of each pair. */
function nativeReaction(body:WaterBodyFloatingBody,impacts:PhysicsImpact[]){
  const pairs=new Map<string,{magnitude:number;normal?:PhysicsVector}>();
  for(const hit of impacts){
    const first=hit.bodyId===body.bodyId||body.colliderIds.includes(hit.colliderId);
    const second=hit.otherBodyId===body.bodyId||!!hit.otherColliderId&&body.colliderIds.includes(hit.otherColliderId);
    if(first===second||hit.impulse/body.mass<=.03)continue;
    const own=first?hit.colliderId:hit.otherColliderId;
    const otherBody=first?hit.otherBodyId:hit.bodyId,otherCollider=first?hit.otherColliderId:hit.colliderId;
    const pair=JSON.stringify([own??'',otherBody??'',otherCollider??'']);
    const old=pairs.get(pair);if(old&&(old.magnitude>hit.impulse||old.magnitude===hit.impulse&&old.normal))continue;
    const sign=first?1:-1,normal=hit.normal&&{x:sign*hit.normal.x,y:sign*hit.normal.y,z:sign*hit.normal.z};
    pairs.set(pair,{magnitude:hit.impulse,normal});
  }
  const velocity=zero();
  for(const [,hit] of [...pairs].sort(([a],[b])=>a<b?-1:a>b?1:0))if(hit.normal){
    const delta=hit.magnitude/body.mass;
    velocity.x+=hit.normal.x*delta;velocity.y+=hit.normal.y*delta;velocity.z+=hit.normal.z*delta;
  }
  return{disturbed:pairs.size>0,velocity};
}

const tiltAngle=.025;
/** Test hydrostatic stability about the actual mass center, never the authored
 * mesh pivot. A symmetric upright plank can have exactly zero current torque
 * while any small tilt makes it fall farther. The largest eigenvalue of the
 * horizontal torque derivative detects that unstable direction, including a
 * diagonal roll axis. Four bounded probes run only at a quiet rest candidate;
 * sleeping bodies and ordinarily moving bodies pay nothing for this test. */
function tilted(body:PhysicsCompoundBody,center:PhysicsVector,axis:'x'|'z',angle:number):PhysicsCompoundBody {
  const q:PhysicsRotation={x:axis==='x'?Math.sin(angle/2):0,y:0,z:axis==='z'?Math.sin(angle/2):0,w:Math.cos(angle/2)};
  const r=body.rotation??{x:0,y:0,z:0,w:1};
  const offset=liquidRotate({x:body.position.x-center.x,y:body.position.y-center.y,z:body.position.z-center.z},q);
  return{...body,position:{x:center.x+offset.x,y:center.y+offset.y,z:center.z+offset.z},rotation:{
    x:q.w*r.x+q.x*r.w+q.y*r.z-q.z*r.y,y:q.w*r.y-q.x*r.z+q.y*r.w+q.z*r.x,
    z:q.w*r.z+q.x*r.y-q.y*r.x+q.z*r.w,w:q.w*r.w-q.x*r.x-q.y*r.y-q.z*r.z},
    velocity:zero(),angularVelocity:zero()};
}
function stability(input:WaterBodyFloatingStep,body:PhysicsCompoundBody,center:PhysicsVector,b:Bounds){
  const torque=(axis:'x'|'z',angle:number)=>applyWaterBodyBuoyancy({water:input.water,state:input.state,
    bodies:[tilted(body,center,axis,angle)],dt:input.dt,probe:true,drag:0,
    displacementScale:input.displacementScale,bodyOptions:input.bodyOptions}).stats.bodies[0].buoyancyTorque;
  const xp=torque('x',tiltAngle),xm=torque('x',-tiltAngle),zp=torque('z',tiltAngle),zm=torque('z',-tiltAngle);
  const xx=(xp.x-xm.x)/(2*tiltAngle),zz=(zp.z-zm.z)/(2*tiltAngle),xz=(xp.z-xm.z+zp.x-zm.x)/(4*tiltAngle);
  const eigenvalue=(xx+zz)/2+Math.hypot((xx-zz)/2,xz);
  const scale=body.mass!*Math.abs(input.water.liquid.gravity.y)*Math.max(.01,b.max.x-b.min.x,b.max.y-b.min.y,b.max.z-b.min.z);
  if(eigenvalue<=scale*.002)return;
  const axis=Math.abs(xz)>1e-10?{x:xz,z:eigenvalue-xx}:xx>=zz?{x:1,z:0}:{x:0,z:1};
  const length=Math.hypot(axis.x,axis.z);
  // Pick a deterministic sign so serializing/replaying identical symmetric
  // scenes does not depend on randomness or floating point neighbor ordering.
  const sign=axis.x<0||axis.x===0&&axis.z<0?-1:1;
  return{x:sign*axis.x/length,y:0,z:sign*axis.z/length};
}

/** After fluid/native steps, pass contacts/impacts. Exclude resting IDs from
 * ground-sleeper buoyancy probes; quiet water probes run at most 4 Hz. */
export function stepWaterBodyFloating(input:WaterBodyFloatingStep):WaterBodyFloatingResult {
  const {water:w,state:s,structure,destruction:previous,floating:old,dt}=input;
  validateWaterBodyFloatingState(w,structure,old);
  if(!finite(dt)||dt<=0||dt>.05)throw new Error('Invalid water body floating step time');
  if(s.waterRevision!==w.revision||previous.structureRevision!==structure.revision)throw new Error('Water body floating manifest mismatch');
  if(!Array.isArray(previous.clusters)||previous.clusters.length>WATER_BODY_FLOATING_LIMITS.bodies)throw new Error('Water body floating body budget exceeded');
  if((input.contacts?.length??0)>512||(input.impacts?.length??0)>512)throw new Error('Water body floating contact budget exceeded');
  const time=old.time+dt,probe=time+1e-9>=old.nextProbeAt;
  const next:WaterBodyFloatingState={...old,time,nextProbeAt:probe?time+WATER_BODY_FLOATING_LIMITS.probeInterval:old.nextProbeAt,resting:[],quiet:{},
    previousPositions:Object.fromEntries(previous.clusters.map(c=>[c.id,{...c.position}]))};
  const stats={resting:0,entered:0,woken:0,surfaceSamples:0,buoyancyProbes:0,stabilityProbes:0};
  let destruction=previous;
  const change=(id:string,update:Partial<DestructionState['clusters'][number]>)=>{
    if(destruction===previous)destruction={...previous,revision:previous.revision+1,clusters:previous.clusters.slice()};
    destruction.clusters=destruction.clusters.map(c=>c.id===id?{...c,...update}:c);
  };
  const existing=new Map(old.resting.map(b=>[b.bodyId,b]));
  let staticBounds:ReturnType<typeof liquidObstacles>|undefined;
  const touchesStatic=(b:Bounds)=>{
    if(!input.scene)return false;
    staticBounds??=liquidObstacles({colliders:input.scene.colliders},[]);
    return staticBounds.some(o=>{
      if(!overlaps(b,o,.015))return false;
      // A vertical retaining wall may touch a buoyant object from the side;
      // that is not ground support. Permit only a thin contact tolerance on
      // the horizontal separating axis. A supporting top, a ceiling or a new
      // obstacle penetrating the body must keep/reactivate the native solve.
      const side=Math.min(b.max.x-o.min.x,o.max.x-b.min.x,b.max.z-o.min.z,o.max.z-b.min.z);
      const verticalFace=o.min.y<b.min.y-.04&&o.max.y>b.min.y+.04;
      return !(verticalFace&&side<=.02);
    });
  };
  const quietMotion=(c:DestructionState['clusters'][number])=>{
    if(Math.hypot(c.angularVelocity.x,c.angularVelocity.z)>=.08||Math.abs(c.angularVelocity.y)>=.02
      ||Math.hypot(c.velocity.x,c.velocity.z)>=.015)return false;
    if(speed(c.velocity)<.08)return true;
    // Fluid support is applied before native gravity substeps. The accepted
    // velocity retains a small downward splitting residual even while its pose
    // is motionless. Require actual quiet displacement as well as a residual
    // bounded by this step's gravity impulse; never treat freefall as sleep.
    const last=old.previousPositions[c.id];
    return !!last&&distance(last,c.position)<dt*.025&&c.velocity.y<=0&&-c.velocity.y<=Math.abs(w.liquid.gravity.y)*dt*.75;
  };
  // Stable IDs also map particle contacts against a resting static collider.
  const contacts=input.contacts??[],impacts=input.impacts??[],grounded=new Set(input.groundedBodyIds??[]);
  for(const cluster of previous.clusters){
    const record=existing.get(cluster.id);
    if(!record)continue;
    let wake=previous.wake||!cluster.settled||speed(cluster.velocity)>1e-6||speed(cluster.angularVelocity)>1e-6
      ||record.memberKey!==key(cluster.memberIds)||distance(cluster.position,record.position)>.01||rotationChanged(cluster.rotation,record.rotation)
      ||grounded.has(cluster.id)||!!previous.deformations&&cluster.memberIds.some(id=>previous.deformations?.[id])
      ||record.displacementScale!==(input.bodyOptions?.[cluster.id]?.displacementScale??input.displacementScale??1);
    const incident=contacts.some(c=>(c.bodyId===cluster.id||record.colliderIds.includes(c.colliderId))&&c.kineticEnergy>0&&c.speed>.25&&speed(c.impulse)/record.mass>.02);
    const reaction=nativeReaction(record,impacts);
    wake ||=incident||reaction.disturbed;
    let targetY=record.targetY;
    const b=world(record,cluster.position);
    if(probe&&!wake){
      const water=support(w,s,b);stats.surfaceSamples+=9;
      // Gentle uniform bobbing remains cheap. A sloping or moving wave must
      // return the body to physics so it can pitch, roll and drift with it.
      wake=!water||water.flow>.11||water.currentMotion>WATER_BODY_FLOATING_LIMITS.currentWakeSpeed||water.spread>.055||water.tilt>tiltAngle||Math.abs(water.surface-record.referenceSurface)>.06
        ||Math.abs(water.bed-record.referenceBed)>.025||b.min.y<=water.bed+.04||b.max.y<=water.surface+.01;
      wake ||=touchesStatic(b);
      if(water&&!wake)targetY=water.surface+record.surfaceOffset;
    }
    if(wake){
      stats.woken++;
      if(cluster.settled){
        // Native contact with a sleeping static is directed from the moving
        // body. Carry its reaction into the newly dynamic object exactly once.
        const velocity={x:cluster.velocity.x+reaction.velocity.x,y:cluster.velocity.y+reaction.velocity.y,z:cluster.velocity.z+reaction.velocity.z};
        change(cluster.id,{settled:false,quietTime:0,velocity});
      }
      continue;
    }
    // No autonomous sine wave or artificial drift: only a bounded, smoothed
    // vertical response to actual sampled small wakes. Calm water stays still.
    const y=cluster.position.y+(targetY-cluster.position.y)*(1-Math.exp(-dt*6));
    const position={...cluster.position,y};
    if(Math.abs(y-cluster.position.y)>1e-8)change(cluster.id,{position,velocity:zero(),angularVelocity:zero()});
    next.resting.push({...record,targetY,position});
  }
  if(probe){
    const candidates=previous.clusters.filter(c=>!existing.has(c.id)&&!grounded.has(c.id)&&quietMotion(c)
      &&!previous.wake&&!c.memberIds.some(id=>previous.deformations?.[id]));
    // Native quiet detection can finish just before this controller's longer
    // entry window. Adopt a proven water-supported sleeper, or wake it if its
    // apparently balanced orientation is unstable. Bed/solid checks above and
    // below still leave genuinely grounded sleepers with native destruction.
    const bodies=liquidDestructionBodies(structure,{...previous,clusters:candidates.map(c=>({...c,settled:false}))});
    let stabilityCandidates=0;
    for(const body of bodies){
      const cluster=candidates.find(c=>c.id===body.id)!,b=bounds(body);if(!b)continue;
      const water=support(w,s,b);stats.surfaceSamples+=9;
      if(!water||water.flow>.06||water.currentMotion>WATER_BODY_FLOATING_LIMITS.currentRestSpeed||water.spread>.03||water.tilt>tiltAngle*.5||b.min.y<=water.bed+.06||b.max.y<=water.surface+.02)continue;
      if(touchesStatic(b))continue;
      const result=applyWaterBodyBuoyancy({water:w,state:s,bodies:[body],dt,probe:true,displacementScale:input.displacementScale,bodyOptions:input.bodyOptions});stats.buoyancyProbes++;
      const measured=result.stats.bodies[0],mass=body.mass!;
      const fraction=input.bodyOptions?.[body.id]?.displacementScale??input.displacementScale??1;
      if(!measured||measured.solidVolume*w.liquid.restDensity*fraction<mass*1.05||Math.abs(measured.displacedVolume*w.liquid.restDensity-mass)>mass*.15){
        if(cluster.settled)change(body.id,{settled:false,quietTime:0});
        continue;
      }
      const quiet=(old.quiet[body.id]??0)+WATER_BODY_FLOATING_LIMITS.probeInterval;
      if(quiet+1e-9<WATER_BODY_FLOATING_LIMITS.settleSeconds){next.quiet[body.id]=quiet;continue;}
      // An almost motionless body is not necessarily in rotational equilibrium.
      // Do not freeze a slow roll, nor an exactly balanced but unstable plank.
      const length=Math.max(.01,b.max.x-b.min.x,b.max.y-b.min.y,b.max.z-b.min.z);
      const torqueTolerance=mass*Math.abs(w.liquid.gravity.y)*length*.002;
      if(speed(measured.buoyancyTorque)>torqueTolerance){
        if(cluster.settled)change(body.id,{settled:false,quietTime:0});
        continue;
      }
      if(stabilityCandidates>=WATER_BODY_FLOATING_LIMITS.stabilityCandidates){next.quiet[body.id]=WATER_BODY_FLOATING_LIMITS.settleSeconds;continue;}
      stabilityCandidates++;stats.stabilityProbes+=4;stats.buoyancyProbes+=4;
      const unstable=stability(input,body,measured.centerOfMass,b);
      if(unstable){
        // Break exact mathematical symmetry with a tiny reproducible angular
        // disturbance. Subsequent motion comes from ordinary buoyancy torque;
        // there is no shape-specific upright/sideways pose or forced rotation.
        change(body.id,{angularVelocity:{x:cluster.angularVelocity.x+unstable.x*.025,
          y:cluster.angularVelocity.y,z:cluster.angularVelocity.z+unstable.z*.025},settled:false,quietTime:0});
        continue;
      }
      const record:WaterBodyFloatingBody={bodyId:body.id,memberKey:key(cluster.memberIds),mass,displacementScale:fraction,colliderIds:colliderIds(structure,cluster.memberIds),
        ...relative(b,cluster.position),referenceSurface:water.surface,referenceBed:water.bed,surfaceOffset:cluster.position.y-water.surface,
        targetY:cluster.position.y,position:{...cluster.position},rotation:{...cluster.rotation}};
      next.resting.push(record);stats.entered++;change(body.id,{settled:true,quietTime:0,velocity:zero(),angularVelocity:zero()});
    }
  }else{
    for(const cluster of previous.clusters)if(!existing.has(cluster.id)&&quietMotion(cluster)&&old.quiet[cluster.id]!==undefined)
      next.quiet[cluster.id]=old.quiet[cluster.id];
  }
  stats.resting=next.resting.length;
  return{destruction,floating:next,stats};
}

/** Wake before a stir, impact or edit; this preserves existing velocities. */
export function wakeWaterBodyFloating(input:{floating:WaterBodyFloatingState;destruction:DestructionState;point?:PhysicsVector;radius?:number;bodyIds?:string[]}):{floating:WaterBodyFloatingState;destruction:DestructionState} {
  const {floating,destruction,point,radius=0,bodyIds}=input;
  if(point&&!vector(point)||!finite(radius)||radius<0)throw new Error('Invalid water body floating wake region');
  const selected=new Set(floating.resting.filter(b=>bodyIds?.includes(b.bodyId)||point&&distance(point,b.position)<=radius+Math.max(speed(b.min),speed(b.max))||!bodyIds&&!point).map(b=>b.bodyId));
  if(!selected.size)return{floating,destruction};
  return{floating:{...floating,resting:floating.resting.filter(b=>!selected.has(b.bodyId)),quiet:Object.fromEntries(Object.entries(floating.quiet).filter(([id])=>!selected.has(id)))},
    destruction:{...destruction,revision:destruction.revision+1,clusters:destruction.clusters.map(c=>selected.has(c.id)?{...c,settled:false,quietTime:0}:c)}};
}

/** Release a moved/rotated body with measured world-space m/s and rad/s.
 * Omitted components retain momentum. Call before the fluid/native step. */
export function releaseWaterBodyFloating(input:{floating:WaterBodyFloatingState;destruction:DestructionState;bodyId:string;
  velocity?:PhysicsVector;angularVelocity?:PhysicsVector}):{floating:WaterBodyFloatingState;destruction:DestructionState} {
  const {floating,destruction,bodyId,velocity,angularVelocity}=input;
  if(!destruction.clusters.some(c=>c.id===bodyId))throw new Error('Unknown floating release body');
  for(const value of [velocity,angularVelocity])if(value!==undefined&&(!vector(value)||speed(value)>10000))
    throw new Error('Invalid floating release velocity');
  const quiet={...floating.quiet};delete quiet[bodyId];
  return{floating:{...floating,quiet,resting:floating.resting.filter(b=>b.bodyId!==bodyId)},
    destruction:{...destruction,revision:destruction.revision+1,clusters:destruction.clusters.map(c=>c.id===bodyId
      ?{...c,settled:false,quietTime:0,...(velocity?{velocity:{...velocity}}:{}),...(angularVelocity?{angularVelocity:{...angularVelocity}}:{})}:c)}};
}
