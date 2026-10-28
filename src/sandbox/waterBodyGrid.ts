/** Internal finite-volume terrain water. Hydrostatic reconstruction keeps a
 * lake at rest balanced even on a sloping bed (Audusse et al., 2004). */
import type {PhysicsCompoundBody,PhysicsScene,PhysicsVector} from './physics.ts';
import type {LiquidContact} from './waterDomain.ts';
import {collideLiquidGround,liquidGrounds,liquidObstacles,liquidRotate,type LiquidObstacle,type LiquidCollision} from './liquidCollision.ts';
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import {physicsShapeBounds} from './physicsGeometry.ts';
import {waterBodyDispersiveHead} from './waterBodyDispersion.ts';
import {WATER_BODY_PUDDLE_DEPTH} from './waterBodyPuddles.ts';
import {mixWaterBodyCurrents} from './waterBodyCurrents.ts';
import {waterBodyCapillaryFace,waterBodyCapillaryHead,waterBodyCapillaryRate} from './waterBodyCapillary.ts';
import {stepWaterBodyRegions} from './waterBodyGridRegions.ts';
import type {WaterBoundaryMesh} from './waterBoundaryGeometry.ts';
import {createWaterBodyFlightQueue,waterFlightSolidCollision,waterFlightDomainCollision,type WaterBodyFlight} from './waterBodyFlights.ts';
import {waterBodyFlightReservation} from './waterBodyWire.ts';

export interface WaterBodyBarrier {id:string;bodyId?:string;bottom:number;top:number;dynamic?:boolean;domain?:true}
export interface WaterBodyBarrierSpan extends WaterBodyBarrier {start:number;end:number}
export interface WaterBodyGeometry {bed:number[];bedVertices:number[];blocked:boolean[];x:(WaterBodyBarrier|undefined)[];z:(WaterBodyBarrier|undefined)[];
  /** Identities of retaining proxies covering each blocked column centre. */
  blockedBy?:(Pick<WaterBodyBarrier,'id'|'bodyId'>[]|undefined)[];
  loadsX:(WaterBodyBarrierSpan[]|undefined)[];loadsZ:(WaterBodyBarrierSpan[]|undefined)[];obstacles:LiquidObstacle[];
  terrainHeight:(x:number,z:number)=>number;
  /** Same sphere clearance query used by the local 3D liquid solver. */
  terrainContact:(position:PhysicsVector,radius:number)=>LiquidCollision|undefined;
  /** Exact straight-prefix clearance against the native heightfield triangles. */
  terrainClear?:(start:PhysicsVector,end:PhysicsVector)=>boolean}
/** Coalescing may not start a packet beyond an intervening physical contact. */
export function waterBodyFlightCoalescing(w:WaterBodyManifest,geometry:WaterBodyGeometry,dt:number){return{gravity:-w.liquid.gravity.y,maxDuration:dt,canMove:(start:PhysicsVector,end:PhysicsVector,fromTime:number,toTime:number)=>{
  if(start.x===end.x&&start.y===end.y&&start.z===end.z)return true;
  if(Math.min(start.y,end.y)<w.liquid.bounds.min.y)return false;
  // A quadrature origin can move backward in emission time. Do not reverse a
  // moving solid's physical sweep: conservatively retain the original parcels
  // whenever the prefix overlaps its swept bounding box in either direction.
  for(const obstacle of geometry.obstacles)if(obstacle.bodyMotion||obstacle.velocity.x||obstacle.velocity.y||obstacle.velocity.z){let overlap=true;
    for(const axis of ['x','y','z'] as const){const a=obstacle.bodyMotion?.previousOffset[axis]??obstacle.velocity[axis]*fromTime,b=obstacle.bodyMotion?.offset[axis]??obstacle.velocity[axis]*toTime;
      if(Math.max(start[axis],end[axis])<obstacle.min[axis]+Math.min(a,b)||Math.min(start[axis],end[axis])>obstacle.max[axis]+Math.max(a,b)){overlap=false;break;}}
    if(overlap)return false;}
  return Boolean(geometry.terrainClear?.(start,end))&&!waterFlightDomainCollision(w.liquid.bounds,start,end)&&!waterFlightSolidCollision(geometry.obstacles,start,end,toTime,fromTime);
}};}
/** Separate only unsupported drops. Ordinary bed slopes remain the supported
 * shallow-water operator; a geometric step or a steeper-than-45-degree terrain
 * descent can carry an airborne sheet when its receiving head is below the lip. */
export function waterBodyGridFlight(w:WaterBodyManifest,geometry:WaterBodyGeometry,o:{id:string;edge:[PhysicsVector,PhysicsVector];nx:number;nz:number;spacing:number;donorHead:number;receiverHead:number;donorDepth:number;bedDrop?:number;terrainDrop?:number;flux:number;normal:number;tangent:number;volume:number;time:number;duration:number}):WaterBodyFlight|undefined {
  if(!o.volume||!o.flux||o.receiverHead>=o.donorHead-o.donorDepth-w.dryDepth)return;
  const sign=Math.sign(o.flux),x=(o.edge[0].x+o.edge[1].x)*.5,z=(o.edge[0].z+o.edge[1].z)*.5,d=o.spacing*.5;
  if(!(o.bedDrop!==undefined&&o.bedDrop>1e-7)){
    const drop=o.terrainDrop??geometry.terrainHeight(x-sign*o.nx*d,z-sign*o.nz*d)-geometry.terrainHeight(x+sign*o.nx*d,z+sign*o.nz*d);if(!(drop>o.spacing))return;
  }
  const normal=o.normal/o.flux,velocity={x:normal*o.nx-o.tangent*o.nz,y:0,z:normal*o.nz+o.tangent*o.nx};
  if(!Number.isFinite(normal))throw new Error('Water flight momentum flux is non-finite');
  return{id:o.id,edge:o.edge.map(p=>({...p,y:o.donorHead})) as [PhysicsVector,PhysicsVector],velocity,volume:o.volume,time:o.time,duration:o.duration,sourceDepth:o.donorDepth};
}
const zero=()=>({x:0,y:0,z:0});
// One sample set per live manifest, replaced on a terrain edit and released
// with the manifest. Moving debris changes obstacle geometry every tick, but
// must not resample every terrain cell and vertex of an otherwise static pool.
// Exact content keys also detect in-place height/chunk edits during replay or
// authoring; object identity or a caller-provided revision is not sufficient.
interface TerrainSamples {key:string;bed:number[];bedVertices:number[];terrainHeight:(x:number,z:number)=>number;terrainContact:WaterBodyGeometry['terrainContact'];terrainClear:NonNullable<WaterBodyGeometry['terrainClear']>}
const terrainCache=new WeakMap<WaterBodyManifest,TerrainSamples>();
function terrainSamples(w:WaterBodyManifest,scene:PhysicsScene):TerrainSamples{
  const key=JSON.stringify([w.columns,w.rows,w.origin.x,w.origin.z,w.cellSizeX,w.cellSizeZ,w.liquid.bounds.min.y,scene.terrain,scene.terrainChunks]);
  const cached=terrainCache.get(w);if(cached?.key===key)return cached;
  const grounds=liquidGrounds(scene);
  // Layer sheet heightfields are hydraulic bookkeeping, not extra physical
  // floors. Exact placement supports collide through the native solids; only
  // the original ground fields may obstruct an airborne origin prefix.
  const clearanceGrounds=w.placementSupports?liquidGrounds({colliders:[],terrain:w.placementSupports.terrain,terrainChunks:w.placementSupports.terrainChunks}):grounds;
  const height=(x:number,z:number)=>{let y=-Infinity;for(const ground of grounds){const hit=collideLiquidGround({x,y:-10001,z},.01,ground);if(hit)y=Math.max(y,hit.point.y);}return Number.isFinite(y)?y:w.liquid.bounds.min.y;};
  const terrainContact:WaterBodyGeometry['terrainContact']=(position,radius)=>{
    let nearest:LiquidCollision|undefined,penetration=0;
    for(const ground of grounds){const hit=collideLiquidGround(position,radius,ground);if(!hit)continue;
      const amount=Math.hypot(hit.position.x-position.x,hit.position.y-position.y,hit.position.z-position.z);
      if(amount>penetration){nearest=hit;penetration=amount;}}
    return nearest;
  };
  const terrainClear:NonNullable<WaterBodyGeometry['terrainClear']>=(start,end)=>{
    let work=0;
    for(const ground of clearanceGrounds){const f=ground.field,u0=((start.x-ground.position.x)/f.width+.5)*f.columns,v0=((start.z-ground.position.z)/f.depth+.5)*f.rows,du=(end.x-start.x)/f.width*f.columns,dv=(end.z-start.z)/f.depth*f.rows;
      let first=0,last=1;
      for(const [p,d,max] of [[u0,du,f.columns],[v0,dv,f.rows]]){if(!d){if(p<0||p>max){last=-1;break;}}else{const a=-p/d,b=(max-p)/d;first=Math.max(first,Math.min(a,b));last=Math.min(last,Math.max(a,b));}}
      if(first>last)continue;const cuts=[first,last];
      // Each supported triangle is affine. These three families contain every
      // grid edge and native h10--h01 diagonal crossed by the segment, so its
      // clearance minimum is attained at one of these endpoints.
      for(const [p,d] of [[u0,du],[v0,dv],[u0+v0,du+dv]]){if(!d)continue;const low=Math.ceil(Math.min(p+d*first,p+d*last)),high=Math.floor(Math.max(p+d*first,p+d*last));
        if((work+=Math.max(0,high-low+1))>128)return false;for(let n=low;n<=high;n++){const t=(n-p)/d;if(t>first&&t<last)cuts.push(t);}}
      for(const t of cuts){const u=Math.max(0,Math.min(f.columns,u0+du*t)),v=Math.max(0,Math.min(f.rows,v0+dv*t)),x=Math.min(f.columns-1,Math.floor(u)),z=Math.min(f.rows-1,Math.floor(v)),tx=u-x,tz=v-z,at=x*(f.rows+1)+z,h00=f.heights[at],h10=f.heights[at+f.rows+1],h01=f.heights[at+1],h11=f.heights[at+f.rows+2];
        const bed=ground.position.y+(tx+tz<=1?h00+(h10-h00)*tx+(h01-h00)*tz:h11-(h11-h01)*(1-tx)-(h11-h10)*(1-tz));if(bed>start.y+(end.y-start.y)*t)return false;}
    }
    return true;
  };
  const bed:number[]=[],bedVertices:number[]=[];
  for(let x=0;x<w.columns;x++)for(let z=0;z<w.rows;z++)bed.push(height(w.origin.x+(x+.5)*w.cellSizeX,w.origin.z+(z+.5)*w.cellSizeZ));
  for(let x=0;x<=w.columns;x++)for(let z=0;z<=w.rows;z++)bedVertices.push(height(w.origin.x+x*w.cellSizeX,w.origin.z+z*w.cellSizeZ));
  // Consumers copy these before changing authoritative state. Immutability
  // prevents one obstacle rebuild from corrupting later cached terrain reads.
  Object.freeze(bed);Object.freeze(bedVertices);
  const sampled={key,bed,bedVertices,terrainHeight:height,terrainContact,terrainClear};terrainCache.set(w,sampled);return sampled;
}
/** A flow face may straddle adjacent panels. Keep its conservative flow proxy,
 * but partition pressure by actual covered width instead of awarding a whole
 * cell to whichever panel contains its midpoint. Overlaps count only once. */
function partitionSpans(spans:WaterBodyBarrierSpan[]):WaterBodyBarrierSpan[]{
  const ends=[...new Set(spans.flatMap(s=>[s.start,s.end]))].sort((a,b)=>a-b),result:WaterBodyBarrierSpan[]=[];
  for(let i=1;i<ends.length;i++){
    const start=ends[i-1],end=ends[i],mid=(start+end)*.5;
    const owner=spans.filter(s=>s.start<=mid&&s.end>=mid).sort((a,b)=>b.top-a.top||a.id.localeCompare(b.id))[0];
    if(owner)result.push({...owner,start,end});
  }
  return result;
}
/** World height range where the vertical line at (x,z) passes through a
 * collider's oriented local bounds; undefined when it misses. */
function verticalSpan(o:LiquidObstacle,local:{min:PhysicsVector;max:PhysicsVector},x:number,z:number):[number,number]|undefined{
  const p=o.collider.position,q=o.inverseRotation;
  // Local coordinates along the line: base (at world y=0) + y * up.
  const base=q?liquidRotate({x:x-p.x,y:-p.y,z:z-p.z},q):{x:x-p.x,y:-p.y,z:z-p.z},up=q?liquidRotate({x:0,y:1,z:0},q):{x:0,y:1,z:0};
  let low=-Infinity,high=Infinity;
  for(const axis of ['x','y','z'] as const){
    const a=up[axis],b=base[axis],min=local.min[axis],max=local.max[axis];
    // Rotation round-off must not drop a wall whose face lies exactly on a
    // column centre; the tolerance changes membership, never heights.
    if(Math.abs(a)<1e-12){if(b<min-1e-9||b>max+1e-9)return;continue;}
    const t0=(min-b)/a,t1=(max-b)/a;low=Math.max(low,Math.min(t0,t1));high=Math.min(high,Math.max(t0,t1));
  }
  return low<=high?[low,high]:undefined;
}
/** Lowest and highest point of a collider across one grid face: the face
 * line at `at` on `axis`, between `from` and `to` along the other axis. */
function faceSpan(o:LiquidObstacle,local:{min:PhysicsVector;max:PhysicsVector},axis:'x'|'z',at:number,from:number,to:number):[number,number]|undefined{
  let low=Infinity,high=-Infinity;
  for(let k=0;k<=4;k++){const t=from+(to-from)*k/4,span=axis==='x'?verticalSpan(o,local,at,t):verticalSpan(o,local,t,at);
    if(span){low=Math.min(low,span[0]);high=Math.max(high,span[1]);}}
  return low<=high?[low,high]:undefined;
}
export function waterBodyGeometry(w:WaterBodyManifest,scene:PhysicsScene,bodies:PhysicsCompoundBody[]=[]):WaterBodyGeometry{
  const {bed,bedVertices,terrainHeight,terrainContact,terrainClear}=terrainSamples(w,scene),obstacles=liquidObstacles(scene,bodies),blocked=Array(w.columns*w.rows).fill(false),blockedBy:NonNullable<WaterBodyGeometry['blockedBy']>=Array(blocked.length);
  const fx:(WaterBodyBarrier|undefined)[]=Array((w.columns+1)*w.rows).fill(undefined),fz:(WaterBodyBarrier|undefined)[]=Array(w.columns*(w.rows+1)).fill(undefined);
  const loadsX:(WaterBodyBarrierSpan[]|undefined)[]=Array(fx.length),loadsZ:(WaterBodyBarrierSpan[]|undefined)[]=Array(fz.length);
  for(const o of obstacles){
    // Volumetric objects displace exact columns. A closed AABB around a rock or
    // crate traps a second pool inside its solid volume and exposes false skirts.
    // Only thin, horizontally extended vertical walls need the unresolved
    // retaining-face approximation; the volume solve handles ordinary objects.
    if(o.collider.shape.kind!=='box'&&o.collider.shape.kind!=='convex')continue;
    const local=physicsShapeBounds(o.collider.shape),half={x:(local.max.x-local.min.x)/2,y:(local.max.y-local.min.y)/2,z:(local.max.z-local.min.z)/2};
    const thin=Math.min(half.x,half.z),long=Math.max(half.x,half.z);
    if(thin>Math.min(w.cellSizeX,w.cellSizeZ)||long<thin*3||half.y<thin)continue;
    // Use the rotated thin axis so a 90-degree authored wall works identically.
    const normal=liquidRotate(half.x<=half.z?{x:1,y:0,z:0}:{x:0,y:0,z:1},o.collider.rotation);
    // A sheet leaning more than 60 degrees from upright (a fallen panel) is an
    // ordinary solid: it displaces water and floats, and flow passes around it.
    if(Math.abs(normal.y)>Math.sin(Math.PI/3))continue;
    const barrier={id:o.colliderId,bodyId:o.bodyId,dynamic:!!o.bodyMotion};
    // A retaining sheet can sit entirely between grid faces. Merely testing
    // face coordinates against its thickness then deletes the dam. Project
    // that unresolved normal extent to its closest conservative face; keep
    // the original tangential span, height, collider and pressure-load area.
    // Every face and column uses the sheet's real oriented extent there, not
    // its bounding box: a leaning panel walls only where its body actually is.
    const missingFace=(min:number,max:number,origin:number,cell:number)=>Math.ceil((min-origin-1e-8)/cell)>Math.floor((max-origin+1e-8)/cell);
    const projectX=Math.abs(normal.x)>=Math.max(Math.abs(normal.z),Math.abs(normal.y))&&missingFace(o.min.x,o.max.x,w.origin.x,w.cellSizeX)
      ?Math.round(((o.min.x+o.max.x)*.5-w.origin.x)/w.cellSizeX):undefined;
    const projectZ=Math.abs(normal.z)>Math.max(Math.abs(normal.x),Math.abs(normal.y))&&missingFace(o.min.z,o.max.z,w.origin.z,w.cellSizeZ)
      ?Math.round(((o.min.z+o.max.z)*.5-w.origin.z)/w.cellSizeZ):undefined;
    const x0=Math.max(0,Math.min(Math.floor((o.min.x-w.origin.x)/w.cellSizeX),projectX??Infinity)),x1=Math.min(w.columns,Math.max(Math.ceil((o.max.x-w.origin.x)/w.cellSizeX),projectX??-Infinity));
    const z0=Math.max(0,Math.min(Math.floor((o.min.z-w.origin.z)/w.cellSizeZ),projectZ??Infinity)),z1=Math.min(w.rows,Math.max(Math.ceil((o.max.z-w.origin.z)/w.cellSizeZ),projectZ??-Infinity));
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){
      if(x<w.columns&&z<w.rows){const i=x*w.rows+z,px=w.origin.x+(x+.5)*w.cellSizeX,pz=w.origin.z+(z+.5)*w.cellSizeZ;
        if(px>=o.min.x&&px<=o.max.x&&pz>=o.min.z&&pz<=o.max.z){const span=verticalSpan(o,local,px,pz);if(span&&span[0]<=bed[i]+.05&&span[1]>bed[i]){blocked[i]=true;(blockedBy[i]??=[]).push(barrier);}}}
      if(z<w.rows){const px=w.origin.x+x*w.cellSizeX,pz=w.origin.z+(z+.5)*w.cellSizeZ,j=x*w.rows+z,b=Math.max(bed[Math.max(0,x-1)*w.rows+z],bed[Math.min(w.columns-1,x)*w.rows+z]);
        const start=Math.max(w.origin.z+z*w.cellSizeZ,o.min.z),end=Math.min(w.origin.z+(z+1)*w.cellSizeZ,o.max.z);
        // A projected sheet is measured on its own centre plane, not the face line.
        const span=(px>=o.min.x-1e-8&&px<=o.max.x+1e-8||x===projectX)&&end>start+1e-10?faceSpan(o,local,'x',x===projectX?(o.min.x+o.max.x)/2:px,start,end):undefined;
        if(span&&span[0]<=b+.05&&span[1]>b){
          const face={...barrier,bottom:span[0],top:span[1]};(loadsX[j]??=[]).push({...face,start,end});
          if(pz>=o.min.z&&pz<=o.max.z&&(!fx[j]||fx[j]!.top<face.top))fx[j]=face;
        }}
      if(x<w.columns){const px=w.origin.x+(x+.5)*w.cellSizeX,pz=w.origin.z+z*w.cellSizeZ,j=x*(w.rows+1)+z,b=Math.max(bed[x*w.rows+Math.max(0,z-1)],bed[x*w.rows+Math.min(w.rows-1,z)]);
        const start=Math.max(w.origin.x+x*w.cellSizeX,o.min.x),end=Math.min(w.origin.x+(x+1)*w.cellSizeX,o.max.x);
        const span=(pz>=o.min.z-1e-8&&pz<=o.max.z+1e-8||z===projectZ)&&end>start+1e-10?faceSpan(o,local,'z',z===projectZ?(o.min.z+o.max.z)/2:pz,start,end):undefined;
        if(span&&span[0]<=b+.05&&span[1]>b){
          const face={...barrier,bottom:span[0],top:span[1]};(loadsZ[j]??=[]).push({...face,start,end});
          if(px>=o.min.x&&px<=o.max.x&&(!fz[j]||fz[j]!.top<face.top))fz[j]=face;
        }}
    }
  }
  for(const [faces,loads] of [[fx,loadsX],[fz,loadsZ]] as const)for(let i=0;i<loads.length;i++)if(loads[i]){
    loads[i]=partitionSpans(loads[i]!);
    // Even a narrow edge occupies part of this coarse flow face. Closing the
    // proxy avoids leaks; its structural load still uses only real wet area.
    const highest=loads[i]!.reduce((a,b)=>a.top>=b.top?a:b);
    if(!faces[i]||faces[i]!.top<highest.top)faces[i]=highest;
  }
  if(w.closedFaces)for(const [axis,faces,loads] of [['x',fx,loadsX],['z',fz,loadsZ]] as const)for(const index of w.closedFaces[axis]){
    // The face array already stores location. Share the synthetic identity so
    // sparse layers do not spend a persistence barrier ID on every dry face.
    faces[index]={id:`water-sheet-${axis}`,bottom:-10000,top:10001,domain:true};loads[index]=[];
  }
  return{bed,bedVertices,blocked,blockedBy,x:fx,z:fz,loadsX,loadsZ,obstacles,terrainHeight,terrainContact,terrainClear};
}

export interface GridWork {substeps:number;localSubsteps?:number;faces:number;sleepingCells:number;outflow:number}
const contactKeys=new WeakMap<object,string>();
/** Stable per-collider contact key; barrier and span objects live for a step. */
function contactKey(barrier:{id:string;bodyId?:string}):string{let key=contactKeys.get(barrier);if(key===undefined){key=`${barrier.bodyId??''}/${barrier.id}`;contactKeys.set(barrier,key);}return key;}
/** Accumulate contact impulse, not force samples; callers may merge substeps.
 * The first sample's point is kept; objects are built only for a new key. */
function waterBodyContact(contacts:Map<string,LiquidContact>,key:string,id:string,bodyId:string|undefined,px:number,py:number,pz:number,ix:number,iy:number,iz:number,energy:number,speed:number):void{
  const c=contacts.get(key);
  if(c){c.impulse.x+=ix;c.impulse.y+=iy;c.impulse.z+=iz;c.kineticEnergy+=energy;c.speed=Math.max(c.speed,speed);}
  else contacts.set(key,{colliderId:id,bodyId,point:{x:px,y:py,z:pz},impulse:{x:ix,y:iy,z:iz},force:zero(),kineticEnergy:energy,speed});
}

const boundaryIds={x:['water-body-boundary-x-min','water-body-boundary-x-max'],z:['water-body-boundary-z-min','water-body-boundary-z-max']} as const;
const boundaryKeys={x:boundaryIds.x.map(id=>`/${id}`),z:boundaryIds.z.map(id=>`/${id}`)};
type Scratch=Float64Array<ArrayBuffer>;
interface GridScratch {change:Scratch;mx:Scratch;mz:Scratch;etaX:Scratch;etaZ:Scratch;ux:Scratch;uz:Scratch;vx:Scratch;vz:Scratch;
  pressureX:Scratch;pressureZ:Scratch;stageDepth:Scratch;stageX:Scratch;stageZ:Scratch;pressureOffset:Scratch}
const gridScratches=new WeakMap<WaterBodyManifest,GridScratch>();
/** Per-manifest flux scratch. Every array is fully written before it is read
 * within one call, so reuse carries no state between steps. */
function gridScratch(w:WaterBodyManifest,count:number):GridScratch {
  const old=gridScratches.get(w);if(old?.change.length===count)return old;
  const a=()=>new Float64Array(count),next={change:a(),mx:a(),mz:a(),etaX:a(),etaZ:a(),ux:a(),uz:a(),vx:a(),vz:a(),pressureX:a(),pressureZ:a(),stageDepth:a(),stageX:a(),stageZ:a(),pressureOffset:a()};
  gridScratches.set(w,next);return next;
}

const rectangularMeshes=new WeakMap<WaterBoundaryMesh,{water:WaterBodyManifest;eligible:boolean}>();
/** Accept only canonical uncut rectangles with a flat bed. Derived areas and
 * faces use the compiler's endpoint arithmetic: for nonbinary spacing,
 * (x+dx)-x can differ from dx without describing different geometry. */
function rectangularBoundaryGrid(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry):boolean {
  const boundary=s.boundary!,mesh=boundary.mesh,count=w.columns*w.rows,cached=rectangularMeshes.get(mesh);
  // A support sheet can be a whole rectangle yet have a closed vertical
  // interface. Only the region graph carries those explicit topology barriers.
  if(mesh.supportLayer!==undefined||mesh.faces.some(f=>f.closed))return false;
  let eligible=cached?.water===w?cached.eligible:undefined;
  if(eligible===undefined){
    eligible=mesh.regions.length===count&&mesh.cells.length===count&&mesh.faces.length===(w.columns+1)*w.rows+w.columns*(w.rows+1);
    for(let i=0;i<count&&eligible;i++){
      const r=mesh.regions[i],x=w.origin.x+Math.floor(i/w.rows)*w.cellSizeX,z=w.origin.z+(i%w.rows)*w.cellSizeZ;
      const area=(x+w.cellSizeX-x)*(z+w.cellSizeZ-z);
      if(r.cell!==i||mesh.cells[i].length!==1||mesh.cells[i][0]!==i||r.solid||r.area!==area||r.bedMin!==r.bedMax||r.polygon.length!==4){eligible=false;break;}
      const corners=new Set<number>();for(const p of r.polygon){const dx=p.x===x?0:p.x===x+w.cellSizeX?1:-1,dz=p.z===z?0:p.z===z+w.cellSizeZ?1:-1;
        if(dx<0||dz<0||p.bed!==r.bedMin){eligible=false;break;}corners.add(dx*2+dz);}
      if(corners.size!==4)eligible=false;
    }
    for(const f of mesh.faces){if(!eligible)break;
      const x=Math.floor(f.a/w.rows),z=f.a%w.rows,bed=Math.max(mesh.regions[f.a].bedMin,f.b<0?-Infinity:mesh.regions[f.b].bedMin);
      if(f.start.bed!==bed||f.end.bed!==bed){eligible=false;break;}
      if(Math.abs(f.nx)===1&&f.nz===0){const at=w.origin.x+x*w.cellSizeX+(f.nx>0?w.cellSizeX:0),from=w.origin.z+z*w.cellSizeZ,to=from+w.cellSizeZ,neighbor=x+f.nx;
        eligible=f.length===to-from&&f.start.x===at&&f.end.x===at&&Math.min(f.start.z,f.end.z)===from&&Math.max(f.start.z,f.end.z)===to&&f.b===(neighbor<0||neighbor>=w.columns?-1:neighbor*w.rows+z);
      }else if(Math.abs(f.nz)===1&&f.nx===0){const at=w.origin.z+z*w.cellSizeZ+(f.nz>0?w.cellSizeZ:0),from=w.origin.x+x*w.cellSizeX,to=from+w.cellSizeX,neighbor=z+f.nz;
        eligible=f.length===to-from&&f.start.z===at&&f.end.z===at&&Math.min(f.start.x,f.end.x)===from&&Math.max(f.start.x,f.end.x)===to&&f.b===(neighbor<0||neighbor>=w.rows?-1:x*w.rows+neighbor);
      }else eligible=false;
    }
    // Raw decoded objects remain mutable; only cache deeply immutable meshes.
    if(Object.isFrozen(mesh)&&Object.isFrozen(mesh.regions)&&mesh.regions.every(r=>Object.isFrozen(r)&&Object.isFrozen(r.polygon)&&r.polygon.every(Object.isFrozen))
      &&Object.isFrozen(mesh.cells)&&mesh.cells.every(Object.isFrozen)&&Object.isFrozen(mesh.faces)&&mesh.faces.every(f=>Object.isFrozen(f)&&Object.isFrozen(f.start)&&Object.isFrozen(f.end)))rectangularMeshes.set(mesh,{water:w,eligible});
  }
  if(!eligible)return false;
  // A canonical polygon's area uses endpoint subtraction, while the original
  // grid uses cellArea. Compare the same conservative projection as commit(),
  // so nonbinary spacing does not switch a floating hull to another solver.
  for(let i=0;i<count;i++)if(mesh.regions[i].bedMin!==geometry.bed[i]||s.bed[i]!==geometry.bed[i]||(boundary.solidDepth?.[i]??0)*mesh.regions[i].area/w.cellArea!==(s.solidDepth?.[i]??0))return false;
  return true;
}
/** Conservative grid flux on every face, cliffs and ledges included. */
export function stepWaterBodyGrid(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,dt:number,contacts:Map<string,LiquidContact>):GridWork{
  if(!s.boundary)return stepRectangularWaterBodyGrid(w,s,geometry,dt,contacts);
  if(!rectangularBoundaryGrid(w,s,geometry))return stepWaterBodyRegions(w,s,geometry,dt,contacts);
  const boundary=s.boundary;
  // The region arrays remain authoritative before and after this stage. A
  // shallow view selects the existing rectangular kernels without changing the
  // caller's boundary property, array identities, depth currents or ledgers.
  for(let i=0;i<s.depth.length;i++){s.depth[i]=boundary.volume[i]/w.cellArea;s.flowX[i]=boundary.flowX[i];s.flowZ[i]=boundary.flowZ[i];}
  const regular={...s,boundary:undefined};
  try{return stepRectangularWaterBodyGrid(w,regular,geometry,dt,contacts,()=>waterBodyFlightReservation(w,s));}
  finally{s.flights=regular.flights;for(let i=0;i<s.depth.length;i++){boundary.volume[i]=s.depth[i]*w.cellArea;boundary.flowX[i]=s.flowX[i];boundary.flowZ[i]=s.flowZ[i];}}
}
function stepRectangularWaterBodyGrid(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,dt:number,contacts:Map<string,LiquidContact>,flightReservation?:()=>ReturnType<typeof waterBodyFlightReservation>):GridWork{
  const count=s.depth.length,g=-w.liquid.gravity.y,rho=w.liquid.restDensity;
  const bed=geometry.bed.map((height,i)=>height+(s.solidDepth?.[i]??0));
  let remaining=dt,steps=0,faces=0,outflow=0;
  let flightQueue:ReturnType<typeof createWaterBodyFlightQueue>|undefined;
  const oldDepth=s.depth.slice(),{change,mx,mz,etaX,etaZ,ux,uz,vx,vz,pressureX,pressureZ,stageDepth,stageX,stageZ,pressureOffset}=gridScratch(w,count);
  const limited=(a:number,b:number)=>a*b<=0?0:Math.sign(a)*Math.min(Math.abs(a)*2,Math.abs(b)*2,Math.abs(a+b)*.5);
  const open=(i:number,j:number,axis:'x'|'z')=>{
    const barrier=axis==='x'?geometry.x[Math.max(i,j)]:geometry.z[Math.floor(i/w.rows)*(w.rows+1)+Math.max(i%w.rows,j%w.rows)];
    return !barrier||barrier.top<Math.min(bed[i]+s.depth[i],bed[j]+s.depth[j])-1e-8;
  };
  while(remaining>1e-10){
    let rate=0;for(let i=0;i<count;i++){const wave=Math.sqrt(g*s.depth[i]);rate=Math.max(rate,(Math.abs(s.flowX[i])+wave)/w.cellSizeX+(Math.abs(s.flowZ[i])+wave)/w.cellSizeZ);}
    rate+=waterBodyCapillaryRate(w,s);
    // SSPRK2 with limited reconstruction is stable to a summed CFL of .5;
    // .45 keeps a margin. Positivity does not rely on it: every face below is
    // capped at a quarter of its donor cell per substep.
    const step=Math.min(remaining,rate>0?.45/rate:remaining);
    if(++steps>w.maxGridSubsteps)throw new Error('Water body CFL budget exceeded; reduce dt or flow speed');
    for(let i=0;i<count;i++){stageDepth[i]=s.depth[i];stageX[i]=s.depth[i]*s.flowX[i];stageZ[i]=s.depth[i]*s.flowZ[i];}
    // Spatial reconstruction alone makes forward Euler amplify smooth gravity
    // waves. SSPRK2 combines conserved h/hu/hv, with pressure recomputed at each
    // stage; freezing its dispersive offset would give short waves a phase lag.
    for(let stage=0;stage<2;stage++){
    const dispersion=waterBodyDispersiveHead(w,s,geometry,steps>1||stage>0);
    const capillary=waterBodyCapillaryHead(w,s,geometry);
    for(let i=0;i<count;i++)pressureOffset[i]=dispersion.head[i]-bed[i]-s.depth[i];
    change.fill(0);mx.fill(0);mz.fill(0);
    // Per-axis limited slopes; a function call rather than per-cell tuples
    // keeps this inner loop allocation-free.
    const slopes=(i:number,axis:'x'|'z',left:number,right:number,eta:Float64Array,normal:Float64Array,tangent:Float64Array,pressure:Float64Array)=>{
      eta[i]=normal[i]=tangent[i]=pressure[i]=0;
      if(left<0||right>=count||Math.min(s.depth[left],s.depth[i],s.depth[right])<=w.wetDepth||!open(left,i,axis)||!open(i,right,axis))return;
      const head=bed[i]+s.depth[i],dl=head-bed[left]-s.depth[left],dr=bed[right]+s.depth[right]-head;
      if(Math.max(Math.abs(dl),Math.abs(dr))>Math.min(s.depth[left],s.depth[i],s.depth[right])*.25)return;
      eta[i]=limited(dl,dr);
      if(dispersion.active[left]&&dispersion.active[i]&&dispersion.active[right])
        pressure[i]=limited(pressureOffset[i]-pressureOffset[left],pressureOffset[right]-pressureOffset[i]);
      const u=axis==='x'?s.flowX:s.flowZ,v=axis==='x'?s.flowZ:s.flowX;
      normal[i]=limited(u[i]-u[left],u[right]-u[i]);tangent[i]=limited(v[i]-v[left],v[right]-v[i]);
    };
    for(let i=0;i<count;i++){slopes(i,'x',i-w.rows,i+w.rows,etaX,ux,vx,pressureX);slopes(i,'z',i%w.rows?i-1:-1,i%w.rows+1<w.rows?i+1:count,etaZ,uz,vz,pressureZ);}
    // One reflecting wall side: dynamic pressure, matching capillary traction
    // and the wetted hydrostatic load on each static span (or the whole face).
    const wallSide=(i:number,h:number,u:number,b:number,sign:number,axis:'x'|'z',spacing:number,length:number,px:number,pz:number,
      spans:WaterBodyBarrierSpan[]|undefined,barrier:WaterBodyBarrier|undefined,boundary:number,bottom:number)=>{
      const normal=u*sign,a=Math.abs(normal)+Math.sqrt(g*h),dynamic=h*normal*normal+a*h*normal;
      const delta=-sign*dynamic*step/spacing;if(axis==='x')mx[i]+=delta;else mz[i]+=delta;
      // Reflecting contact supplies the matching cohesive traction; an
      // otherwise uniform film must not accelerate away from its walls.
      const stress=axis==='x'?capillary.xx[i]:capillary.zz[i];
      if(axis==='x')mx[i]-=sign*stress*step/spacing;else mz[i]-=sign*stress*step/spacing;
      const load=(start:number,end:number,spanBottom:number,spanTop:number,key:string,id:string,bodyId:string|undefined,spanned:boolean)=>{
        const width=end-start,lower=Math.max(b,spanBottom),wetTop=Math.min(b+h,spanTop),height=Math.max(0,wetTop-lower);
        const pressure=g*height*(b+h-(lower+wetTop)*.5),force=Math.max(0,pressure+dynamic*height/h)*rho*width;
        if(force>0)waterBodyContact(contacts,key,id,bodyId,axis==='z'&&spanned?(start+end)*.5:px,lower+height/3,axis==='x'&&spanned?(start+end)*.5:pz,
          axis==='x'?sign*force*step*.5:0,0,axis==='z'?sign*force*step*.5:0,.25*rho*height*width*Math.max(0,normal)**3*step,Math.max(0,normal));
      };
      if(spans){for(const span of spans)if(!span.dynamic)load(span.start,span.end,span.bottom,span.top,contactKey(span),span.id,span.bodyId,true);}
      else if(barrier){if(!barrier.dynamic)load(0,length,barrier.bottom,barrier.top,contactKey(barrier),barrier.id,barrier.bodyId,false);}
      else load(0,length,bottom,Infinity,boundaryKeys[axis][boundary],boundaryIds[axis][boundary],undefined,false);
    };
    // Overtopping removes the flux obstruction, not pressure on the
    // submerged wall below its crest. Integrate over the actual wet face.
    const submergedLoad=(span:WaterBodyBarrierSpan,h:number,b:number,sign:number,axis:'x'|'z',px:number,pz:number)=>{
      const bottom=Math.max(b,span.bottom),wetTop=Math.min(b+h,span.top),height=Math.max(0,wetTop-bottom);
      const force=rho*g*height*(b+h-(bottom+wetTop)*.5)*(span.end-span.start);
      if(force>0)waterBodyContact(contacts,contactKey(span),span.id,span.bodyId,axis==='z'?(span.start+span.end)*.5:px,(bottom+wetTop)*.5,axis==='x'?(span.start+span.end)*.5:pz,
        axis==='x'?sign*force*step*.5:0,0,axis==='z'?sign*force*step*.5:0,0,0);
    };
    function face(left:number,right:number,axis:'x'|'z',barrier:WaterBodyBarrier|undefined,spans:WaterBodyBarrierSpan[]|undefined,px:number,pz:number){
      const length=axis==='x'?w.cellSizeZ:w.cellSizeX,spacing=axis==='x'?w.cellSizeX:w.cellSizeZ;
      const hl=left>=0?s.depth[left]:0,hr=right>=0?s.depth[right]:0;
      if(hl===0&&hr===0)return;
      const bl=left>=0?bed[left]:bed[right],br=right>=0?bed[right]:bed[left];
      const ul=left>=0?(axis==='x'?s.flowX[left]:s.flowZ[left]):0,ur=right>=0?(axis==='x'?s.flowX[right]:s.flowZ[right]):0;
      const vl=left>=0?(axis==='x'?s.flowZ[left]:s.flowX[left]):0,vr=right>=0?(axis==='x'?s.flowZ[right]:s.flowX[right]):0;
      // Quiet water can still carry a slow film toward a drain. Sleep is an
      // optimization for an equilibrated face, never permission to discard
      // existing advective flow or a resolvable wet/dry pressure gradient.
      const filmFace=Math.min(hl,hr)<WATER_BODY_PUDDLE_DEPTH;
      const capillaryFace=(capillary.active[left]||capillary.active[right])&&waterBodyCapillaryFace(w,s,geometry,left,right,axis);
      if(left>=0&&right>=0&&s.sleeping[left]&&s.sleeping[right]&&!barrier&&!capillaryFace&&(!filmFace||Math.abs(ul)+Math.abs(ur)<1e-8)
        &&Math.abs(Math.max(bl+hl,br)-Math.max(br+hr,bl))<(filmFace?Math.min(w.sleepSurfaceTolerance,w.dryDepth):w.sleepSurfaceTolerance))return;
      faces++;
      const boundary=left<0||right<0,wall=barrier&&barrier.top>=Math.max(bl+hl,br+hr)-1e-8||boundary&&w.liquid.boundary==='closed';
      if(wall){
        const side=left<0?0:1,lowest=Math.min(bl,br);
        if(left>=0&&hl>0)wallSide(left,hl,ul,bl,1,axis,spacing,length,px,pz,spans,barrier,side,lowest);
        if(right>=0&&hr>0)wallSide(right,hr,ur,br,-1,axis,spacing,length,px,pz,spans,barrier,side,lowest);
        return;
      }
      const eta=axis==='x'?etaX:etaZ,normalSlope=axis==='x'?ux:uz,tangentSlope=axis==='x'?vx:vz;
      const rawLeft=Math.max(0,hl+(left>=0?eta[left]*.5:0)),rawRight=Math.max(0,hr-(right>=0?eta[right]*.5:0));
      const top=Math.max(bl,br,barrier?.top??-Infinity),lh=Math.max(0,bl+rawLeft-top),rh=Math.max(0,br+rawRight-top);
      const lu=ul+(left>=0?normalSlope[left]*.5:0),ru=ur-(right>=0?normalSlope[right]*.5:0),lv=vl+(left>=0?tangentSlope[left]*.5:0),rv=vr-(right>=0?tangentSlope[right]*.5:0);
      const a=Math.max(Math.abs(lu)+Math.sqrt(g*lh),Math.abs(ru)+Math.sqrt(g*rh));
      if(barrier&&spans)for(const span of spans)if(!span.dynamic){submergedLoad(span,hl,bl,1,axis,px,pz);submergedLoad(span,hr,br,-1,axis,px,pz);}
      let flux=.5*(lh*lu+rh*ru)-.5*a*(rh-lh);
      if(left<0)flux=Math.min(0,flux);if(right<0)flux=Math.max(0,flux);
      // The multidimensional CFL bound leaves each cell enough water for all
      // outgoing faces. The extra local cap protects near-dry roundoff.
      if(flux>0&&left>=0)flux=Math.min(flux,hl*spacing/(4*step));
      if(flux<0&&right>=0)flux=Math.max(flux,-hr*spacing/(4*step));
      const normal=.5*(lh*lu*lu+rh*ru*ru+.5*g*(lh*lh+rh*rh))-.5*a*(rh*ru-lh*lu);
      const detached=left>=0&&right>=0&&flux!==0&&(flux>0?br+hr<bl-w.dryDepth:bl+hl<br-w.dryDepth)&&(geometry.bed[left]-geometry.bed[right])*Math.sign(flux)>spacing;
      const flight=detached?waterBodyGridFlight(w,geometry,{id:`grid-${axis}-${left}-${right}`,edge:axis==='x'?[{x:px,y:0,z:pz-length*.5},{x:px,y:0,z:pz+length*.5}]:[{x:px-length*.5,y:0,z:pz},{x:px+length*.5,y:0,z:pz}],nx:axis==='x'?1:0,nz:axis==='z'?1:0,spacing,
        // The shared flight helper uses tangent (-nz,nx); the rectangular
        // Z-face's stored tangent is world +X, which has the opposite sign.
        donorHead:flux>=0?bl+hl:br+hr,receiverHead:flux>=0?br+hr:bl+hl,donorDepth:flux>=0?hl:hr,terrainDrop:(geometry.bed[left]-geometry.bed[right])*Math.sign(flux),flux,normal,tangent:(flux>=0?lv:rv)*(axis==='z'?-1:1),volume:Math.abs(flux)*length*step*.5,time:s.time-remaining+step*.5,duration:step}):undefined;
      if(flight){flightQueue??=createWaterBodyFlightQueue(s.flights??[],4096,flightReservation?.()??waterBodyFlightReservation(w,s),waterBodyFlightCoalescing(w,geometry,dt));if(!flightQueue.canAppend(flight)){
        if(left>=0&&hl>0)wallSide(left,hl,ul,bl,1,axis,spacing,length,px,pz,undefined,undefined,1,Math.min(bl,br));
        if(right>=0&&hr>0)wallSide(right,hr,ur,br,-1,axis,spacing,length,px,pz,undefined,undefined,0,Math.min(bl,br));return;}
        flightQueue.append(flight);s.flights=flightQueue.flights;
      }
      // Tangential momentum travels with the liquid crossing this face, not
      // with the much faster gravity-wave signal. Rusanov diffusion here was
      // erasing a hull's trailing current even when neither side crossed the
      // face. Physical local shear is mixed separately with a bounded budget.
      const tangent=flux*(flux>=0?lv:rv),scale=step/spacing;
      const leftPressure=normal+.5*g*(rawLeft*rawLeft-lh*lh-hl*hl),rightPressure=normal+.5*g*(rawRight*rawRight-rh*rh-hr*hr);
      if(left>=0&&!(flight&&flux<0)){change[left]-=flux*scale;if(axis==='x'){mx[left]-=leftPressure*scale;mz[left]-=tangent*scale;}else{mz[left]-=leftPressure*scale;mx[left]-=tangent*scale;}}
      else if(left<0)outflow-=flux*length*step*.5;
      if(right>=0&&!(flight&&flux>0)){change[right]+=flux*scale;if(axis==='x'){mx[right]+=rightPressure*scale;mz[right]+=tangent*scale;}else{mz[right]+=rightPressure*scale;mx[right]+=tangent*scale;}}
      else if(right<0)outflow+=flux*length*step*.5;
      if(capillaryFace){
        if(hl>w.dryDepth&&hr>w.dryDepth){
          const target=axis==='x'?mx:mz,tangentTarget=axis==='x'?mz:mx,stress=axis==='x'?capillary.xx:capillary.zz;
          const impulse=(stress[left]+stress[right])*.5*scale,cross=(capillary.xz[left]+capillary.xz[right])*.5*scale;
          target[left]-=impulse;target[right]+=impulse;tangentTarget[left]-=cross;tangentTarget[right]+=cross;
        }
      }
    }
    for(let x=0;x<=w.columns;x++)for(let z=0;z<w.rows;z++)face(x?((x-1)*w.rows+z):-1,x<w.columns?x*w.rows+z:-1,'x',geometry.x[x*w.rows+z],geometry.loadsX[x*w.rows+z],w.origin.x+x*w.cellSizeX,w.origin.z+(z+.5)*w.cellSizeZ);
    for(let x=0;x<w.columns;x++)for(let z=0;z<=w.rows;z++)face(z?x*w.rows+z-1:-1,z<w.rows?x*w.rows+z:-1,'z',geometry.z[x*(w.rows+1)+z],geometry.loadsZ[x*(w.rows+1)+z],w.origin.x+(x+.5)*w.cellSizeX,w.origin.z+z*w.cellSizeZ);
    const dispersive=(i:number,j:number,axis:'x'|'z',spacing:number)=>{
      if(j>=count||!dispersion.active[j]||!open(i,j,axis))return;
      // Use the same reconstructed face pressure as the base hydrostatic
      // flux. A central-only correction leaves its high-order pressure term
      // nondispersive and makes short resolved waves travel much too fast.
      const slopes=axis==='x'?pressureX:pressureZ,gradient=(pressureOffset[j]-pressureOffset[i])*.5,slope=(slopes[i]-slopes[j])*.25,target=axis==='x'?mx:mz;
      target[i]-=g*s.depth[i]*(gradient+slope)*step/spacing;target[j]-=g*s.depth[j]*(gradient-slope)*step/spacing;
    };
    for(let i=0;i<count;i++)if(dispersion.active[i]){dispersive(i,i+w.rows,'x',w.cellSizeX);dispersive(i,i%w.rows+1<w.rows?i+1:count,'z',w.cellSizeZ);}
    for(let i=0;i<count;i++){
      const old=s.depth[i],raw=old+change[i];if(raw< -1e-9)throw new Error('Water body flux became negative');
      let depth=Math.max(0,raw),px=0,pz=0;
      if(depth>w.dryDepth){
        const ux=(old*s.flowX[i]+mx[i])/depth,uz=(old*s.flowZ[i]+mz[i])/depth,speed=Math.hypot(ux,uz);
        // A millimetre film couples far more strongly to its bed than a deep
        // lake. Linear depth-independent drag let a landing sheet skim to the
        // distant wall before building a puddle beside the fall. Resolve the
        // extra shallow-layer viscous term (3 nu / h²) and bed shear
        // (Cf |u| / h) below the film/pool transition. The existing authored
        // friction already supplies the deep-water resistance. Subtracting
        // that reference gives a continuous correction with no change to deep
        // wakes. It vanishes with friction=0 and never changes water volume.
        const roughness=w.friction/.25,inverseDepth=1/depth,reference=1/WATER_BODY_PUDDLE_DEPTH;
        const viscous=roughness*3e-6*Math.max(0,inverseDepth*inverseDepth-reference*reference),shear=roughness*.01*speed*Math.max(0,inverseDepth-reference);
        const damping=Math.exp(-(w.friction+viscous)*step)/(1+shear*step),limit=Math.min(1,w.maxFlowSpeed/Math.max(speed,1e-10));
        px=depth*ux*damping*limit;pz=depth*uz*damping*limit;
      }
      if(stage){depth=(stageDepth[i]+depth)*.5;px=(stageX[i]+px)*.5;pz=(stageZ[i]+pz)*.5;}
      s.depth[i]=depth;s.flowX[i]=depth>w.dryDepth?px/depth:0;s.flowZ[i]=depth>w.dryDepth?pz/depth:0;
    }
    }
    // Reuse the finished flux scratch so entrainment adds no per-substep arrays.
    mixWaterBodyCurrents(w,s,geometry,step,mx,mz);
    remaining-=step;
  }
  let sleepingCells=0;
  for(let i=0;i<count;i++){
    if(Math.hypot(s.flowX[i],s.flowZ[i])<=w.sleepSpeed&&Math.abs(s.depth[i]-oldDepth[i])<=w.sleepSurfaceTolerance)s.quietTime[i]+=dt;else s.quietTime[i]=0;
    s.sleeping[i]=s.quietTime[i]>=w.sleepAfter;if(s.sleeping[i])sleepingCells++;
  }
  return{substeps:steps,faces,sleepingCells,outflow};
}
