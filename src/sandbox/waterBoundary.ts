/** Geometry-conforming storage shared by the full water pipeline. Volumes are authoritative;
 * the legacy rectangular arrays are conservative summaries for diagnostics. */
import type {PhysicsScene,PhysicsVector} from './physics.ts';
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterSystemFill} from './waterSystem.ts';
import {rememberWaterBodyDepthCurrentGeometry} from './waterBodyDepthCurrents.ts';
import {boundaryRegionLevel,boundaryRegionVolume,clipBoundaryPolygon,polygonArea,
  validateWaterBoundaryMesh,sameWaterBoundaryMesh,type BoundaryPoint,type WaterBoundaryMesh,type WaterBoundaryRegion} from './waterBoundaryGeometry.ts';
import {compileWaterBodyBoundaryMesh} from './waterBodyBoundaryMesh.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';

export interface WaterBoundaryState {mesh:WaterBoundaryMesh;volume:number[];flowX:number[];flowZ:number[];solidDepth?:number[]}
const EPS=1e-9;
const meshLinks=new WeakMap<object,number[][]>();
function links(m:WaterBoundaryMesh,faces=m.faces):number[][] {let value=meshLinks.get(faces);if(!value){value=m.regions.map(()=>[]);for(let i=0;i<faces.length;i++){const f=faces[i];value[f.a].push(i);if(f.b>=0)value[f.b].push(i);}if(Object.isFrozen(m))meshLinks.set(faces,value);}return value;}
const finite=(x:number)=>Number.isFinite(x)&&Math.abs(x)<=1e10;
export function cloneBoundaryState(s:WaterBoundaryState):WaterBoundaryState{return{mesh:s.mesh,volume:s.volume.slice(),flowX:s.flowX.slice(),flowZ:s.flowZ.slice(),...(s.solidDepth?{solidDepth:s.solidDepth.slice()}: {})};}
export function createBoundaryState(mesh:WaterBoundaryMesh):WaterBoundaryState {return{mesh,volume:mesh.regions.map(()=>0),flowX:mesh.regions.map(()=>0),flowZ:mesh.regions.map(()=>0)};}
export function validateBoundaryState(w:WaterBodyManifest,s:WaterBodyState):void {
  const b=s.boundary;
  if(!w.boundaryCells){if(b)throw new Error('Water boundary state requires boundaryCells');return;}
  if(!b)throw new Error('Water boundary state is missing');validateWaterBoundaryMesh(w,b.mesh);
  const n=b.mesh.regions.length;
  if(!Array.isArray(b.volume)||!Array.isArray(b.flowX)||!Array.isArray(b.flowZ)||b.volume.length!==n||b.flowX.length!==n||b.flowZ.length!==n)throw new Error('Water boundary state size mismatch');
  const sums=new Float64Array(w.columns*w.rows);
  for(let i=0;i<n;i++){
    if(!finite(b.volume[i])||b.volume[i]<0||!finite(b.flowX[i])||Math.abs(b.flowX[i])>1000||!finite(b.flowZ[i])||Math.abs(b.flowZ[i])>1000)throw new Error('Invalid water boundary volume or flow');
    sums[b.mesh.regions[i].cell]+=b.volume[i];
  }
  for(let c=0;c<sums.length;c++)if(Math.abs(s.depth[c]*w.cellArea-sums[c])>Math.max(1e-9,sums[c]*1e-9))throw new Error('Water boundary summary is inconsistent');
  if(b.solidDepth&&(!Array.isArray(b.solidDepth)||b.solidDepth.length!==n||b.solidDepth.some(v=>!finite(v)||v<0)))throw new Error('Invalid partial-cell solid displacement');
}
export function syncBoundarySummary(w:WaterBodyManifest,s:WaterBodyState):void {
  const b=s.boundary!;s.depth.fill(0);s.flowX.fill(0);s.flowZ.fill(0);
  for(let i=0;i<b.volume.length;i++){const c=b.mesh.regions[i].cell,v=b.volume[i];s.depth[c]+=v;s.flowX[c]+=v*b.flowX[i];s.flowZ[c]+=v*b.flowZ[i];}
  for(let c=0;c<s.depth.length;c++){const v=s.depth[c];if(v){s.flowX[c]/=v;s.flowZ[c]/=v;}s.depth[c]/=w.cellArea;}
}
function contains(p:BoundaryPoint[],x:number,z:number):boolean {
  let sign=0;for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length],cross=(b.x-a.x)*(z-a.z)-(b.z-a.z)*(x-a.x);if(Math.abs(cross)>EPS){if(sign&&Math.sign(cross)!==sign)return false;sign=Math.sign(cross);}}return true;
}
function bedAt(r:WaterBoundaryRegion,x:number,z:number):number {
  const a=r.polygon[0];for(let i=1;i+1<r.polygon.length;i++){const b=r.polygon[i],c=r.polygon[i+1],det=(b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z);if(Math.abs(det)>1e-18){const dx=((b.bed-a.bed)*(c.z-a.z)-(c.bed-a.bed)*(b.z-a.z))/det,dz=((b.x-a.x)*(c.bed-a.bed)-(c.x-a.x)*(b.bed-a.bed))/det;return a.bed+dx*(x-a.x)+dz*(z-a.z);}}return r.bedMin;
}
export function sampleBoundaryWater(w:WaterBodyManifest,s:WaterBodyState,p:Pick<PhysicsVector,'x'|'z'>&{y?:number}){
  const b=s.boundary!,u=(p.x-w.origin.x)/w.cellSizeX,v=(p.z-w.origin.z)/w.cellSizeZ;
  if(!Number.isFinite(u)||!Number.isFinite(v)||u<0||v<0||u>w.columns||v>w.rows)return;
  // Authoring bounds include their outer edge; assign it to the last cell.
  const x=Math.min(w.columns-1,Math.floor(u)),z=Math.min(w.rows-1,Math.floor(v));
  const display=b.mesh.surface?.mesh??b.mesh,candidates=display.cells[x*w.rows+z].filter(i=>contains(display.regions[i].polygon,p.x,p.z));
  if(!candidates.length)return;
  // A point exactly on a wall belongs to its solid side, never the water behind it.
  const exact=candidates.reduce((a,c)=>bedAt(display.regions[c],p.x,p.z)>bedAt(display.regions[a],p.x,p.z)?c:a),i=b.mesh.surface?.owners[exact]??exact,r=b.mesh.regions[i];
  // Bulk cells retain the original hydraulic sampling contract. Exact terrain
  // clipping belongs to the surface mesh, while real cuts retain point beds.
  const bed=r.bulk?r.bedMin:bedAt(display.regions[exact],p.x,p.z),liquidDepth=b.volume[i]/r.area,
    surface=r.bulk?bed+liquidDepth+(b.solidDepth?.[i]??0):b.volume[i]>0?Math.max(bed,boundaryRegionLevel(r,b.volume[i]+(b.solidDepth?.[i]??0)*r.area)):bed,
    depth=r.bulk?liquidDepth:Math.max(0,surface-bed),y=p.y??surface-1e-6;
  if(!Number.isFinite(y))throw new Error('Invalid water sample height');
  const wet=depth>w.dryDepth&&y>=bed&&y<=surface;
  return{depth,surface,bed,velocity:wet?{x:b.flowX[i],y:0,z:b.flowZ[i]}:{x:0,y:0,z:0},sleeping:s.sleeping[r.cell],region:i};
}
function boxClip(p:BoundaryPoint[],min:{x:number;z:number},max:{x:number;z:number}){
  for(const [x,z,d] of [[-1,0,-min.x],[1,0,max.x],[0,-1,-min.z],[0,1,max.z]])p=clipBoundaryPolygon(p,x,z,d);return p;
}
function polygonVolume(p:BoundaryPoint[],level:number):number {
  if(p.length<3)return 0;const area=polygonArea(p);if(area<=1e-16)return 0;
  return boundaryRegionVolume({cell:0,polygon:p,area,center:{x:0,z:0},bedMin:Math.min(...p.map(v=>v.bed)),bedMax:Math.max(...p.map(v=>v.bed))},level);
}
/** Exact union of rectangular initial fills, integrated over each planar region. */
export function fillBoundaryWater(w:WaterBodyManifest,s:WaterBodyState,fills:WaterSystemFill[]):void {
  const b=s.boundary!;
  for(let i=0;i<b.mesh.regions.length;i++){
    const r=b.mesh.regions[i],minX=Math.min(...r.polygon.map(p=>p.x)),maxX=Math.max(...r.polygon.map(p=>p.x)),minZ=Math.min(...r.polygon.map(p=>p.z)),maxZ=Math.max(...r.polygon.map(p=>p.z));
    const active=fills.filter(f=>f.min.x<maxX&&f.max.x>minX&&f.min.z<maxZ&&f.max.z>minZ);
    const xs=[...new Set([minX,maxX,...active.flatMap(f=>[Math.max(minX,f.min.x),Math.min(maxX,f.max.x)])])].sort((a,b)=>a-b),zs=[...new Set([minZ,maxZ,...active.flatMap(f=>[Math.max(minZ,f.min.z),Math.min(maxZ,f.max.z)])])].sort((a,b)=>a-b);
    let volume=0,mx=0,mz=0;
    for(let x=1;x<xs.length;x++)for(let z=1;z<zs.length;z++){
      const cx=(xs[x-1]+xs[x])/2,cz=(zs[z-1]+zs[z])/2,fill=active.filter(f=>cx>=f.min.x&&cx<=f.max.x&&cz>=f.min.z&&cz<=f.max.z).sort((a,b)=>b.level-a.level)[0];if(!fill)continue;
      const v=polygonVolume(boxClip(r.polygon,{x:xs[x-1],z:zs[z-1]},{x:xs[x],z:zs[z]}),fill.level);volume+=v;mx+=v*(fill.velocity?.x??0);mz+=v*(fill.velocity?.z??0);
    }
    b.volume[i]=volume;b.flowX[i]=volume?mx/volume:0;b.flowZ[i]=volume?mz/volume:0;
  }syncBoundarySummary(w,s);
}
function overlap(p:BoundaryPoint[],mask:BoundaryPoint[]):BoundaryPoint[]{
  const signed=mask.reduce((sum,a,i)=>{const b=mask[(i+1)%mask.length];return sum+a.x*b.z-b.x*a.z;},0),orientation=Math.sign(signed);
  for(let i=0;i<mask.length&&p.length;i++){const a=mask[i],b=mask[(i+1)%mask.length],nx=orientation*(b.z-a.z),nz=orientation*(a.x-b.x);p=clipBoundaryPolygon(p,nx,nz,nx*a.x+nz*a.z);}return p;
}
/** Static scene edits remap the existing liquid, never copy a cell's head to
 * both sides. Intersection weights preserve volume and horizontal momentum. */
export function remapBoundaryWater(w:WaterBodyManifest,s:WaterBodyState,mesh:WaterBoundaryMesh):void {
  const old=s.boundary!;if(old.mesh===mesh)return;
  const next=createBoundaryState(mesh);
  for(let i=0;i<old.volume.length;i++){
    if(!old.volume[i])continue;const r=old.mesh.regions[i],head=boundaryRegionLevel(r,old.volume[i]);
    // Target capacity preserves a common free surface when a bulk cell is
    // split. Integrating the source bed would put liquid under a new wall.
    let shares=mesh.cells[r.cell].map(j=>({j,v:polygonVolume(overlap(mesh.regions[j].polygon,r.polygon),head)})),sum=shares.reduce((s,v)=>s+v.v,0);
    if(sum<=0){shares=mesh.cells[r.cell].map(j=>({j,v:polygonVolume(overlap(r.polygon,mesh.regions[j].polygon),head)}));sum=shares.reduce((s,v)=>s+v.v,0);}
    // A residual depth can be smaller than one ULP of its world elevation.
    // Translate only the vertical integral, preserving its exact XZ footprint
    // and all liquid instead of deleting it or spreading it over a whole cell.
    if(sum<=0){const relative={...r,polygon:r.polygon.map(p=>({...p,bed:p.bed-r.bedMin})),bedMin:0,bedMax:r.bedMax-r.bedMin},level=boundaryRegionLevel(relative,old.volume[i]);
      shares=mesh.cells[r.cell].map(j=>({j,v:polygonVolume(overlap(relative.polygon,mesh.regions[j].polygon),level)}));sum=shares.reduce((s,v)=>s+v.v,0);}
    if(sum<=0)throw new Error('Water boundary remap lost its source region');
    for(const {j,v} of shares){const part=old.volume[i]*(v/sum);next.volume[j]+=part;next.flowX[j]+=part*old.flowX[i];next.flowZ[j]+=part*old.flowZ[i];}
  }
  for(let i=0;i<next.volume.length;i++)if(next.volume[i]){next.flowX[i]/=next.volume[i];next.flowZ[i]/=next.volume[i];}
  s.boundary=next;syncBoundarySummary(w,s);
}
export function pourBoundaryWater(w:WaterBodyManifest,s:WaterBodyState,point:{x:number;z:number},radius:number,volume:number,velocity:{x:number;z:number},options?:{cells?:readonly number[];blocked?:readonly boolean[];fallbackCell?:number;geometry?:WaterBodyGeometry}):boolean {
  const b=s.boundary!,at=sampleBoundaryWater(w,s,point);if(!at)throw new Error('Water body inflow is outside the grid');
  // Point-directed sources stay in their connected side even when the radius
  // overlaps a thin wall. A source on a wall pours onto its actual crest.
  const faces=waterBodyCells(w,s).faces(options?.geometry),ordinary=b.mesh.regions.every(r=>r.bulk)&&!faces.some(f=>f.barrier),selected:number[]=[];
  // An embedded wall blocks only its exact footprint. Unembedded retaining
  // proxies still use the original blocked-column source contract.
  const embedded=options?.blocked?new Set(b.mesh.regions.flatMap(r=>r.solid?[r.solid.id]:[])):undefined,
    blocked=(i:number)=>{const cell=b.mesh.regions[i].cell;if(!options?.blocked?.[cell])return false;const owners=options.geometry?.blockedBy?.[cell];return !owners?.length||owners.some(o=>o.bodyId!==undefined||!embedded!.has(o.id));};
  if(ordinary){
    const candidates=options?.cells??b.mesh.regions.filter(r=>Math.hypot(r.center.x-point.x,r.center.z-point.z)<=radius).map(r=>r.cell);
    for(const cell of candidates)if(!options?.blocked?.[cell])selected.push(b.mesh.cells[cell][0]);
    if(!selected.length&&options?.fallbackCell!==undefined&&!options.blocked?.[options.fallbackCell])selected.push(b.mesh.cells[options.fallbackCell][0]);
    if(!selected.length){if(options?.blocked)return false;throw new Error('Water body inflow is outside the grid');}
  }else{if(blocked(at.region))return false;selected.push(at.region);}
  const seen=new Set(selected),adjacent=links(b.mesh,faces);
  for(let k=0;!ordinary&&k<selected.length;k++)for(const edge of adjacent[selected[k]]){const f=faces[edge],j=f.a===selected[k]?f.b:f.b===selected[k]?f.a:-1;if(j<0||seen.has(j))continue;
    const r=b.mesh.regions[j],head=Math.max(at.surface,at.bed+w.wetDepth);
    if(!blocked(j)&&Math.hypot(r.center.x-point.x,r.center.z-point.z)<=radius&&Math.max(f.start.bed,f.end.bed)<=head+EPS&&!r.solid){seen.add(j);selected.push(j);}}
  const total=selected.reduce((sum,i)=>sum+b.mesh.regions[i].area,0);
  for(const i of selected){const share=ordinary?volume/selected.length:volume*b.mesh.regions[i].area/total,old=b.volume[i],v=old+share;if(v){b.flowX[i]=(old*b.flowX[i]+share*velocity.x)/v;b.flowZ[i]=(old*b.flowZ[i]+share*velocity.z)/v;}b.volume[i]=v;s.sleeping[b.mesh.regions[i].cell]=false;s.quietTime[b.mesh.regions[i].cell]=0;}
  s.externalAddedVolume+=volume;syncBoundarySummary(w,s);return true;
}

/** Prepare a cloned state before any source is emitted into an edited scene. */
export function prepareBoundaryScene(w:WaterBodyManifest,s:WaterBodyState,scene:PhysicsScene):void {
  const mesh=compileWaterBodyBoundaryMesh(w,scene);
  if(mesh.revision!==s.boundary!.mesh.revision){rememberWaterBodyDepthCurrentGeometry(w,s);remapBoundaryWater(w,s,mesh);}
  else if(s.boundary!.mesh!==mesh){if(!sameWaterBoundaryMesh(s.boundary!.mesh,mesh))throw new Error('Water boundary checkpoint topology does not match its scene revision');s.boundary!.mesh=mesh;}
}
