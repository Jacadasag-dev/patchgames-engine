import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';
import type {PhysicsVector} from './physics.ts';
import {addWaterBodyDepthImpulse} from './waterBodyDepthCurrents.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {polygonArea} from './waterBoundaryGeometry.ts';

/** A presentation transition, not a second liquid or a minimum stored depth.
 * Millimetre films remain at their physical height and gradually acquire the
 * same pool shading as water accumulates. All depths are in metres. */
export const WATER_BODY_PUDDLE_DEPTH=.04;
const smooth=(v:number)=>{const t=Math.max(0,Math.min(1,v));return t*t*(3-2*t);};
/** Internal scalar hot-path for the already validated surface builder. */
export const waterBodyFilmOpacity=(depth:number):number=>.2*smooth(depth/.002);
export interface WaterBodyPuddleInspection {
  /** A shallow cell can border a deep pool; neither creates a separate solver. */
  shallowCells:number;poolCells:number;dryCells:number;
  shallowVolume:number;poolVolume:number;wetArea:number;coveredFraction:number;
  maximumDepth:number;thresholdDepth:number;
}
/** Read-only coverage/volume diagnostics for authoring and runtime budgets.
 * Coverage is the simulated domain, not an assertion that an entire connected
 * terrain basin is filled. Topology and flow remain in the conservative grid. */
export function inspectWaterBodyPuddles(water:WaterBodyManifest,state:WaterBodyState):WaterBodyPuddleInspection{
  const n=water.columns*water.rows;
  if(state.waterRevision!==water.revision||state.depth.length!==n)throw new Error('Puddle state must match its water manifest');
  const result:WaterBodyPuddleInspection={shallowCells:0,poolCells:0,dryCells:0,shallowVolume:0,poolVolume:0,wetArea:0,coveredFraction:0,maximumDepth:0,thresholdDepth:WATER_BODY_PUDDLE_DEPTH};
  if(state.boundary){
    const cells=waterBodyCells(water,state);
    for(let i=0;i<cells.count;i++){
      const depth=cells.depth(i),volume=cells.volume(i);
      if(!Number.isFinite(depth)||depth<0)throw new Error('Invalid puddle depth');
      result.maximumDepth=Math.max(result.maximumDepth,depth);
      if(depth<WATER_BODY_PUDDLE_DEPTH)result.shallowVolume+=volume;else result.poolVolume+=volume;
      if(depth<=water.dryDepth){result.dryCells++;continue;}
      const polygon=cells.polygon(i),head=cells.level(i),wet:typeof polygon=[];
      for(let k=0;k<polygon.length;k++){
        const a=polygon[k],b=polygon[(k+1)%polygon.length],inside=a.bed<head,nextInside=b.bed<head;
        if(inside)wet.push(a);
        if(inside!==nextInside){const t=(head-a.bed)/(b.bed-a.bed);wet.push({x:a.x+t*(b.x-a.x),z:a.z+t*(b.z-a.z),bed:head});}
      }
      result.wetArea+=polygonArea(wet);
      if(depth<WATER_BODY_PUDDLE_DEPTH)result.shallowCells++;else result.poolCells++;
    }
    result.coveredFraction=result.wetArea/(n*water.cellArea);return result;
  }
  for(const depth of state.depth){
    if(!Number.isFinite(depth)||depth<0)throw new Error('Invalid puddle depth');
    result.maximumDepth=Math.max(result.maximumDepth,depth);
    if(depth<WATER_BODY_PUDDLE_DEPTH)result.shallowVolume+=depth*water.cellArea;else result.poolVolume+=depth*water.cellArea;
    if(depth<=water.dryDepth){result.dryCells++;continue;}
    result.wetArea+=water.cellArea;
    if(depth<WATER_BODY_PUDDLE_DEPTH)result.shallowCells++;else result.poolCells++;
  }
  result.coveredFraction=(result.shallowCells+result.poolCells)/n;
  return result;
}

/** Turn a bounded fraction of incident vertical energy into a local spreading
 * current once a falling parcel rejoins a connected sheet. Opposing impulses
 * preserve horizontal momentum exactly; terrain/walls/dry cells are never
 * crossed. An unresolved isolated landing first spreads by ordinary pressure. */
export function applyWaterBodyLanding(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,i:number,volume:number,downSpeed:number,
  options:{point?:PhysicsVector;depthImpulses?:Parameters<typeof addWaterBodyDepthImpulse>[2][]}={}):void {
  if(downSpeed<=.25||volume<=0)return;
  if(s.boundary){applyBoundaryLanding(w,s,geometry,i,volume,downSpeed,options);return;}
  const speed=Math.min(w.liquid.maxSpeed,downSpeed),rho=w.liquid.restDensity;
  // The existing sheet-spreading response spends 25% of incident energy.
  // The remaining budget drives real subsurface circulation, not a second
  // volume or a second full-strength copy of the impact.
  const incident:Parameters<typeof addWaterBodyDepthImpulse>[2]={point:options.point??{x:w.origin.x+(Math.floor(i/w.rows)+.5)*w.cellSizeX,
    y:s.bed[i]+(s.solidDepth?.[i]??0)+Math.max(0,s.depth[i]-.01),z:w.origin.z+(i%w.rows+.5)*w.cellSizeZ},
    radius:Math.max(w.cellSizeX,w.cellSizeZ),impulse:{x:0,y:-rho*volume*speed,z:0},energy:.375*rho*volume*speed*speed,deferProjection:true};
  if(options.depthImpulses)options.depthImpulses.push(incident);else addWaterBodyDepthImpulse(w,s,incident,geometry);
  const head=(j:number)=>geometry.bed[j]+s.depth[j]+(s.solidDepth?.[j]??0);
  const connected=(j:number,axis:'x'|'z')=>{
    if(j<0||j>=s.depth.length||geometry.blocked[j]||s.depth[j]<=w.dryDepth*4)return false;
    if(axis==='z'&&Math.floor(i/w.rows)!==Math.floor(j/w.rows))return false;
    if(Math.min(head(i),head(j))<Math.max(geometry.bed[i],geometry.bed[j]))return false;
    const barrier=axis==='x'?geometry.x[Math.max(i,j)]:geometry.z[Math.floor(i/w.rows)*(w.rows+1)+Math.max(i%w.rows,j%w.rows)];
    return !barrier||barrier.top<Math.min(head(i),head(j))-1e-8;
  };
  const pairs=([['x',i-w.rows,i+w.rows],['z',i-1,i+1]] as const).filter(([axis,a,b])=>connected(a,axis)&&connected(b,axis));
  if(!pairs.length)return;
  // Energy per unit density, so all volumes/momenta use the grid's same units.
  // Most impact energy remains dissipation/splash; this quarter drives the
  // resolved sheet. The quadratic includes its existing current exactly.
  const budget=.125*volume*Math.min(w.liquid.maxSpeed,downSpeed)**2/pairs.length;
  for(const [axis,a,b] of pairs){
    const flow=axis==='x'?s.flowX:s.flowZ,ma=s.depth[a]*w.cellArea,mb=s.depth[b]*w.cellArea;
    const quadratic=.5*(1/ma+1/mb),linear=flow[b]-flow[a];
    let impulse=2*budget/(Math.sqrt(linear*linear+4*quadratic*budget)+linear);
    if(!Number.isFinite(impulse))impulse=(-linear+Math.sqrt(linear*linear+4*quadratic*budget))/(2*quadratic);
    impulse=Math.max(0,Math.min(impulse,ma*(w.maxFlowSpeed+flow[a]),mb*(w.maxFlowSpeed-flow[b])));
    flow[a]-=impulse/ma;flow[b]+=impulse/mb;
    if(impulse)for(const j of [a,b]){s.sleeping[j]=false;s.quietTime[j]=0;}
  }
}

function applyBoundaryLanding(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,i:number,volume:number,downSpeed:number,
  options:{point?:PhysicsVector;depthImpulses?:Parameters<typeof addWaterBodyDepthImpulse>[2][]}):void{
  const cells=waterBodyCells(w,s),speed=Math.min(w.liquid.maxSpeed,downSpeed),rho=w.liquid.restDensity,center=cells.center(i);
  const incident:Parameters<typeof addWaterBodyDepthImpulse>[2]={point:options.point??{...center,y:cells.level(i)-.01},
    radius:Math.max(w.cellSizeX,w.cellSizeZ),impulse:{x:0,y:-rho*volume*speed,z:0},energy:.375*rho*volume*speed*speed,deferProjection:true};
  if(options.depthImpulses)options.depthImpulses.push(incident);else addWaterBodyDepthImpulse(w,s,incident,geometry);
  const neighbors=new Set<number>();
  for(const face of cells.faces(geometry)){
    const j=face.a===i?face.b:face.b===i?face.a:-1;
    if(j<0||cells.depth(j)<=w.dryDepth*4)continue;
    const crest=Math.max(Math.min(face.start.bed,face.end.bed),face.barrier?.top??-Infinity);
    if(Math.min(cells.level(i),cells.level(j))<=crest+1e-8)continue;
    neighbors.add(j);
  }
  const near=[...neighbors],pairs:{a:number;b:number;nx:number;nz:number}[]=[];
  for(let a=0;a<near.length;a++)for(let b=a+1;b<near.length;b++){
    const pa=cells.center(near[a]),pb=cells.center(near[b]),ax=pa.x-center.x,az=pa.z-center.z,bx=pb.x-center.x,bz=pb.z-center.z;
    if(ax*bx+az*bz>=-.25*Math.hypot(ax,az)*Math.hypot(bx,bz))continue;
    const distance=Math.hypot(pb.x-pa.x,pb.z-pa.z);if(distance<=1e-12)continue;
    pairs.push({a:near[a],b:near[b],nx:(pb.x-pa.x)/distance,nz:(pb.z-pa.z)/distance});
  }
  if(!pairs.length){cells.commit();return;}
  const budget=.125*volume*speed*speed/pairs.length;
  if(!(budget>0)){cells.commit();return;}
  for(const {a,b,nx,nz} of pairs){
    const ma=cells.volume(a),mb=cells.volume(b),ax=cells.flowX[a],az=cells.flowZ[a],bx=cells.flowX[b],bz=cells.flowZ[b];
    const ua=ax*nx+az*nz,ub=bx*nx+bz*nz,quadratic=.5*(1/ma+1/mb),linear=ub-ua,root=Math.sqrt(linear*linear+4*quadratic*budget);
    let impulse=linear>=0?2*budget/(root+linear):(-linear+root)/(2*quadratic);
    const maxA=Math.max(w.maxFlowSpeed,Math.hypot(ax,az)),maxB=Math.max(w.maxFlowSpeed,Math.hypot(bx,bz));
    const capA=ma*(ua+Math.sqrt(Math.max(0,ua*ua+maxA*maxA-ax*ax-az*az))),capB=mb*(-ub+Math.sqrt(Math.max(0,ub*ub+maxB*maxB-bx*bx-bz*bz)));
    impulse=Math.max(0,Math.min(impulse,capA,capB));
    cells.flowX[a]-=impulse/ma*nx;cells.flowZ[a]-=impulse/ma*nz;cells.flowX[b]+=impulse/mb*nx;cells.flowZ[b]+=impulse/mb*nz;
    if(impulse){cells.wake(a);cells.wake(b);}
  }
  cells.commit();
}
