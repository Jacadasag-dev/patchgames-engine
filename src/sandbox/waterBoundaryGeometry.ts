/** Bounded partial-cell geometry for the existing water system. Each convex
 * region is one connected control volume with a planar bed. A grounded wall's
 * actual footprint has its crest as bed: flow can cross it only by overtopping.
 * No topology or volume is inferred from a renderer or from cell-centre samples. */
import type {PhysicsScene} from './physics.ts';
import type {WaterBodyManifest} from './waterBody.ts';
import {liquidGrounds,liquidObstacles,liquidRotate} from './liquidCollision.ts';
import {createWaterSupportGeometry,type WaterSupportPatch} from './waterSupportGeometry.ts';

export interface BoundaryPoint {x:number;z:number;bed:number}
export interface WaterPlacementSupports {patches:WaterSupportPatch[];layer:number;terrain?:PhysicsScene['terrain'];terrainChunks?:PhysicsScene['terrainChunks']}
export interface WaterBoundaryRegion {
  cell:number;polygon:BoundaryPoint[];area:number;center:{x:number;z:number};bedMin:number;bedMax:number;
  solid?:{id:string;bottom:number;top:number};
  /** Original rectangular hydraulic storage. */
  bulk?:boolean;
  /** Exact static support and overhead clearance. Empty support means dry void. */
  supportId?:string;ceiling?:number;
}
export interface WaterBoundaryFace {
  a:number;b:number;start:BoundaryPoint;end:BoundaryPoint;nx:number;nz:number;length:number;
  /** No shared free vertical interval; topology barrier, never a physical load. */
  closed?:true;
}
export interface WaterBoundaryMesh {revision:string;regions:WaterBoundaryRegion[];cells:number[][];faces:WaterBoundaryFace[];sourceKey:string;
  /** Runtime refinement changes placement footprints only; terrain uses the original grid. */
  placementOnly?:true;
  /** Explicit placement support rank; ordinary terrain never enables this. */
  supportLayer?:number;
  /** Exact display/contact geometry and its region-to-hydraulic-owner map. */
  surface?:{mesh:WaterBoundaryMesh;owners:number[]}}
/** Exact checkpoint provenance after structural validation. Property insertion
 * order and the sign of zero do not change geometry (JSON normalizes both).
 * Array order and every finite numeric value must match the compiled mesh. */
export function sameWaterBoundaryMesh(a:WaterBoundaryMesh,b:WaterBoundaryMesh):boolean {
  const point=(p:BoundaryPoint,q:BoundaryPoint)=>p.x===q.x&&p.z===q.z&&p.bed===q.bed;
  return a===b||a.revision===b.revision&&a.sourceKey===b.sourceKey&&a.placementOnly===b.placementOnly&&a.supportLayer===b.supportLayer&&a.regions.length===b.regions.length&&a.faces.length===b.faces.length&&a.cells.length===b.cells.length
    &&a.regions.every((r,i)=>{const s=b.regions[i];return r.cell===s.cell&&r.area===s.area&&r.center.x===s.center.x&&r.center.z===s.center.z
      &&r.bedMin===s.bedMin&&r.bedMax===s.bedMax&&r.bulk===s.bulk&&r.supportId===s.supportId&&r.ceiling===s.ceiling&&r.polygon.length===s.polygon.length&&r.polygon.every((p,j)=>point(p,s.polygon[j]))
      &&(r.solid===undefined?s.solid===undefined:s.solid!==undefined&&r.solid.id===s.solid.id&&r.solid.bottom===s.solid.bottom&&r.solid.top===s.solid.top);})
    &&a.cells.every((list,i)=>list.length===b.cells[i].length&&list.every((v,j)=>v===b.cells[i][j]))
    &&a.faces.every((f,i)=>{const g=b.faces[i];return f.a===g.a&&f.b===g.b&&f.closed===g.closed&&point(f.start,g.start)&&point(f.end,g.end)&&f.nx===g.nx&&f.nz===g.nz&&f.length===g.length;})
    &&(a.surface===undefined?b.surface===undefined:b.surface!==undefined&&a.surface.owners.length===b.surface.owners.length&&a.surface.owners.every((v,i)=>v===b.surface!.owners[i])&&sameWaterBoundaryMesh(a.surface.mesh,b.surface.mesh));
}
/** Explicit ceilings fail closed rather than dropping a narrow barrier. */
export const WATER_BOUNDARY_LIMITS=Object.freeze({regionsPerCell:64,regions:32768,vertices:64,points:262144,faces:131072,work:16_000_000});
const EPS=1e-10;
type Plane={x:number;z:number;c:number};
type Piece={polygon:BoundaryPoint[];plane:Plane;ground:boolean;solid?:WaterBoundaryRegion['solid'];supportId?:string;ceiling?:number};
type Surface={polygon:BoundaryPoint[];plane:Plane};
const height=(p:Plane,x:number,z:number)=>p.x*x+p.z*z+p.c;
const cache=new Map<string,WaterBoundaryMesh>();
const hash=(s:string)=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0).toString(16);};
interface RegionTriangleIntegral {area:number;low:number;middle:number;high:number}
interface RegionIntegral {meanOffset:number;triangles:RegionTriangleIntegral[];quadratic:number;cubic:number;lastVolume?:number;lastLevel?:number}
const integrals=new WeakMap<WaterBoundaryRegion,RegionIntegral>();
const validated=new WeakMap<WaterBoundaryMesh,Set<string>>();
const immutableValues=new WeakSet<object>();

/** Build transport data bottom-up without certifying any caller-owned object.
 * The factory creates every property itself and accepts object children only
 * after their immutability has been proved. This certifies immutability alone;
 * the complete geometry/topology validator must still accept the mesh. */
function immutableWaterChild(value:unknown):unknown {
  const type=typeof value;if(value!==null&&(type==='object'?!immutableValues.has(value as object):type!=='number'&&type!=='string'&&type!=='boolean'))throw new Error('Unproven immutable water data child');return value;
}
export function createImmutableWaterBoundaryObjectFactory(shape:readonly string[]):(read:(index:number)=>unknown)=>object {
  if(!Array.isArray(shape))throw new Error('Invalid immutable water data shape');const count=shape.length;
  if(count>32)throw new Error('Invalid immutable water data shape');
  const keys:string[]=Object.setPrototypeOf(new Array(count),null),seen=new Set<string>();
  for(let i=0;i<count;i++){const key=shape[i];if(typeof key!=='string'||key==='__proto__'||seen.has(key))throw new Error('Invalid immutable water data key');keys[i]=key;seen.add(key);}Object.freeze(keys);
  return read=>{
    // The shape is privately copied once. No caller can add a setter or mutate
    // its keys between instances, and the fresh container has no prototype.
    const result:Record<string,unknown>=Object.create(null);
    for(let i=0;i<keys.length;i++)result[keys[i]]=immutableWaterChild(read(i));
    Object.setPrototypeOf(result,Object.prototype);Object.freeze(result);immutableValues.add(result);return result;
  };
}
export function createImmutableWaterBoundaryData(shape:readonly string[]|number,read:(index:number)=>unknown):object {
  if(typeof shape!=='number')return createImmutableWaterBoundaryObjectFactory(shape)(read);
  if(!Number.isSafeInteger(shape)||shape<0||shape>300000)throw new Error('Invalid immutable water data shape');
  const result:unknown[]=Object.setPrototypeOf(new Array(shape),null);
  for(let i=0;i<shape;i++)result[i]=immutableWaterChild(read(i));
  Object.setPrototypeOf(result,Array.prototype);Object.freeze(result);immutableValues.add(result);return result;
}

/** Unsigned XZ area; translating before summation avoids cancellation far
 * from the origin. All compiler polygons have counterclockwise winding. */
export function polygonArea(polygon:readonly BoundaryPoint[]):number {
  if(polygon.length<3)return 0;const a=polygon[0];let area=0;
  for(let i=1;i+1<polygon.length;i++){const b=polygon[i],c=polygon[i+1];area+=(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);}
  return Math.abs(area)*.5;
}
function tidy(polygon:BoundaryPoint[]):BoundaryPoint[]{
  const result:BoundaryPoint[]=[];
  for(const p of polygon){const previous=result.at(-1);if(!previous||Math.hypot(p.x-previous.x,p.z-previous.z)>EPS)result.push(p);}
  if(result.length>1&&Math.hypot(result[0].x-result.at(-1)!.x,result[0].z-result.at(-1)!.z)<=EPS)result.pop();
  return result.length>=3&&polygonArea(result)>EPS*EPS?result:[];
}
/** Sutherland-Hodgman half-plane clip, retaining nx*x+nz*z <= offset.
 * Interpolate bed along the original plane, including wet/dry intersections. */
export function clipBoundaryPolygon(polygon:readonly BoundaryPoint[],nx:number,nz:number,offset:number):BoundaryPoint[]{
  const result:BoundaryPoint[]=[];if(!polygon.length)return result;
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i],b=polygon[(i+1)%polygon.length],da=nx*a.x+nz*a.z-offset,db=nx*b.x+nz*b.z-offset;
    if(da<=0)result.push({...a});
    if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db);result.push({x:a.x+t*(b.x-a.x),z:a.z+t*(b.z-a.z),bed:a.bed+t*(b.bed-a.bed)});}
  }
  return tidy(result);
}
function bedPlane(polygon:readonly BoundaryPoint[]):Plane {
  const a=polygon[0];let largest=0,plane:Plane|undefined;
  for(let i=1;i+1<polygon.length;i++){
    const b=polygon[i],c=polygon[i+1],dx=b.x-a.x,dz=b.z-a.z,ex=c.x-a.x,ez=c.z-a.z,d=dx*ez-dz*ex;
    if(Math.abs(d)>Math.max(EPS*EPS,largest)){const x=((b.bed-a.bed)*ez-(c.bed-a.bed)*dz)/d,z=(dx*(c.bed-a.bed)-ex*(b.bed-a.bed))/d;largest=Math.abs(d);plane={x,z,c:a.bed-x*a.x-z*a.z};}
  }
  if(plane)return plane;
  throw new Error('Water boundary degenerate bed polygon');
}
function integral(region:WaterBoundaryRegion):RegionIntegral{
  const cached=integrals.get(region);if(cached)return cached;
  const p=region.polygon,a=p[0],triangles:RegionTriangleIntegral[]=[];let bed=0,quadratic=0,cubic=0;
  for(let i=1;i+1<p.length;i++){
    const b=p[i],c=p[i+1],area=Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))*.5;if(!area)continue;
    const [low,middle,high]=[a.bed,b.bed,c.bed].sort((x,y)=>x-y);
    triangles.push({area,low,middle,high});bed+=area*((a.bed-region.bedMin)+(b.bed-region.bedMin)+(c.bed-region.bedMin))/3;
    if(low===region.bedMin&&high>low){
      if(middle===low)quadratic+=area/(high-low);
      else cubic+=area/(3*(middle-low)*(high-low));
    }
  }
  const result={meanOffset:bed/region.area,triangles,quadratic,cubic};
  if(Object.isFrozen(region)&&Object.isFrozen(p)&&p.every(Object.isFrozen))integrals.set(region,result);return result;
}
export function boundaryRegionMeanBed(region:WaterBoundaryRegion):number{return region.bedMin+integral(region).meanOffset;}
/** Exact piecewise-cubic triangle integral and its wet-area derivative. The
 * upper branch is expanded about the middle height, avoiding cancellation
 * when two low vertices coincide or the water volume is extremely small. */
function triangleWater(triangle:RegionTriangleIntegral,level:number):{volume:number;area:number}{
  const {area,low,middle,high}=triangle;
  if(level<=low)return{volume:0,area:0};
  if(level>=high)return{volume:area*((level-low)-((middle-low)+(high-low))/3),area};
  const span=high-low;
  if(level<middle){const depth=level-low,wet=area*(depth/(middle-low))*(depth/span);return{volume:wet*depth/3,area:wet};}
  const a=middle-low,u=level-middle,b=high-middle;
  return{volume:area*((a/span)*(a/3+u)+(u/span)*u*(1-u/(3*b))),area:area*(a/span+(u/span)*(2-u/b))};
}
function regionWater(region:WaterBoundaryRegion,data:RegionIntegral,level:number):{volume:number;area:number}{
  if(level<=region.bedMin)return{volume:0,area:0};
  if(level>=region.bedMax)return{volume:region.area*((level-region.bedMin)-data.meanOffset),area:region.area};
  let volume=0,area=0;for(const triangle of data.triangles){const wet=triangleWater(triangle,level);volume+=wet.volume;area+=wet.area;}return{volume,area};
}
/** Exact integral of max(level-bed(x,z),0) over a convex planar-bed region. */
export function boundaryRegionVolume(region:WaterBoundaryRegion,level:number):number {
  if(!Number.isFinite(level))throw new Error('Invalid water boundary level');
  if(level<=region.bedMin)return 0;
  const data=integral(region);
  if(level>=region.bedMax)return region.area*((level-region.bedMin)-data.meanOffset);
  // Face apertures and grouped storage ask only for volume, many times per
  // tick. Keep the same exact triangle formula without allocating wet-area
  // records or calculating derivatives that these callers never consume.
  let volume=0;
  for(const {area,low,middle,high} of data.triangles){
    if(level<=low)continue;
    if(level>=high){volume+=area*((level-low)-((middle-low)+(high-low))/3);continue;}
    const span=high-low;
    if(level<middle){const depth=level-low,wet=area*(depth/(middle-low))*(depth/span);volume+=wet*depth/3;}
    else{const a=middle-low,u=level-middle,b=high-middle;volume+=area*((a/span)*(a/3+u)+(u/span)*u*(1-u/(3*b)));}
  }
  return volume;
}
/** Exact dV/dh for coupled region storage inversion. */
export function boundaryRegionWetArea(region:WaterBoundaryRegion,level:number):number {
  if(!Number.isFinite(level))throw new Error('Invalid water boundary level');
  if(level<=region.bedMin)return 0;
  if(level>=region.bedMax)return region.area;
  let result=0;
  for(const {area,low,middle,high} of integral(region).triangles){
    if(level<=low)continue;
    if(level>=high){result+=area;continue;}
    const span=high-low;
    if(level<middle){const depth=level-low;result+=area*(depth/(middle-low))*(depth/span);}
    else{const a=middle-low,u=level-middle,b=high-middle;result+=area*(a/span+(u/span)*(2-u/b));}
  }
  return result;
}
/** Monotone inversion of the exact integral. The fully wet branch is linear;
 * a safeguarded Newton step uses exact wet area and keeps a valid bracket. */
export function boundaryRegionLevel(region:WaterBoundaryRegion,volume:number):number {
  if(!Number.isFinite(volume)||volume<0)throw new Error('Invalid water boundary volume');
  if(volume===0)return region.bedMin;
  const data=integral(region),full=region.area*((region.bedMax-region.bedMin)-data.meanOffset);
  if(volume>=full)return region.bedMin+(data.meanOffset+volume/region.area);
  if(data.lastVolume===volume)return data.lastLevel!;
  let low=region.bedMin,high=region.bedMax;
  // Near a minimum edge V~h²; at a minimum vertex V~h³. Factoring the
  // roots avoids underflow in V/coefficient for subnormal stored volumes.
  const depth=data.quadratic>0?Math.sqrt(volume)/Math.sqrt(data.quadratic):Math.cbrt(volume)/Math.cbrt(data.cubic);
  let level=low+Math.min(high-low,depth);
  if(!(level>low&&level<high))level=low+(high-low)*.5;
  for(let iteration=0;iteration<48;iteration++){
    const wet=regionWater(region,data,level),error=wet.volume-volume;
    if(Math.abs(error)<=Math.max(volume*2e-14,Number.MIN_VALUE*2)){data.lastVolume=volume;data.lastLevel=level;return level;}
    if(error<0)low=level;else high=level;
    let next=wet.area>0?level-error/wet.area:NaN;
    if(!(next>low&&next<high))next=low+(high-low)*.5;
    if(next===level||next===low||next===high){level=Math.abs(regionWater(region,data,low).volume-volume)<=Math.abs(regionWater(region,data,high).volume-volume)?low:high;break;}
    level=next;
  }
  data.lastVolume=volume;data.lastLevel=level;return level;
}
function rect(x:number,z:number,width:number,depth:number,plane:Plane):BoundaryPoint[]{
  return [[x,z],[x+width,z],[x+width,z+depth],[x,z+depth]].map(([px,pz])=>({x:px,z:pz,bed:height(plane,px,pz)}));
}
function centroid(polygon:BoundaryPoint[]):{x:number;z:number}{
  const a=polygon[0];let area=0,x=0,z=0;
  for(let i=1;i+1<polygon.length;i++){const b=polygon[i],c=polygon[i+1],part=Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x));area+=part;x+=part*(a.x+b.x+c.x)/3;z+=part*(a.z+b.z+c.z)/3;}
  return{x:x/area,z:z/area};
}
function withPlane(polygon:BoundaryPoint[],plane:Plane):BoundaryPoint[]{return polygon.map(p=>({x:p.x,z:p.z,bed:height(plane,p.x,p.z)}));}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

/** Checkpoints are untrusted. Validate the actual partition and every hydraulic
 * connection, not just array sizes or caller-supplied area/centroid fields.
 * Only a deeply frozen mesh can reuse a successful check, and only for exactly
 * the same manifest geometry. A revision string is not a validation token. */
export function validateWaterBoundaryMesh(w:WaterBodyManifest,mesh:WaterBoundaryMesh):void {
  const key=JSON.stringify([w.columns,w.rows,w.origin.x,w.origin.z,w.cellSizeX,w.cellSizeZ,w.cellArea]);
  if(mesh&&validated.get(mesh)?.has(key))return;
  const fail=(reason:string):never=>{throw new Error(`Invalid water boundary mesh: ${reason}`);};
  const finite=Number.isFinite;
  const owns=(value:object,keys:readonly string[])=>{for(let i=0;i<keys.length;i++)if(!Object.hasOwn(value,keys[i]))return false;return true;};
  const regionKeys=['cell','polygon','area','center','bedMin','bedMax'],pointKeys=['x','z','bed'],centerKeys=['x','z'],solidKeys=['id','bottom','top'],faceKeys=['a','b','start','end','nx','nz','length'];
  const visited=new Set<object>();
  const deeplyFrozen=(value:unknown):boolean=>{
    if(!value||typeof value!=='object'||immutableValues.has(value)||visited.has(value))return true;visited.add(value);
    const prototype=Object.getPrototypeOf(value);
    if(!Object.isFrozen(value)||(prototype!==Object.prototype&&prototype!==Array.prototype))return false;
    const descriptors=Object.getOwnPropertyDescriptors(value);
    for(const name in descriptors){if(!Object.hasOwn(descriptors,name))continue;const descriptor=descriptors[name];if(!('value' in descriptor)||!deeplyFrozen(descriptor.value))return false;}
    return true;
  };
  const remember=()=>{
    for(const value of visited)immutableValues.add(value);
    const keys=validated.get(mesh)??new Set<string>();keys.add(key);validated.set(mesh,keys);
  };
  const count=w.columns*w.rows,tolerance=Math.max(w.cellSizeX,w.cellSizeZ)*1e-8;
  if(!mesh||typeof mesh!=='object'||!Array.isArray(mesh.regions)||!Array.isArray(mesh.cells)||!Array.isArray(mesh.faces)
    ||!mesh.regions.length||mesh.regions.length>WATER_BOUNDARY_LIMITS.regions||mesh.cells.length!==count||mesh.faces.length>WATER_BOUNDARY_LIMITS.faces)fail('dimensions/budget');
  if(!owns(mesh,['sourceKey','revision','regions','cells','faces'])||typeof mesh.sourceKey!=='string'||!/^[0-9a-f]{1,8}-[0-9a-f]{1,8}$/.test(mesh.sourceKey)||mesh.revision!==`water-boundary-${mesh.sourceKey}`)fail('source identity');
  const surface=mesh.surface,referenceFaces=new Map<string,WaterBoundaryFace[]>();
  if(mesh.supportLayer!==undefined&&(!Number.isInteger(mesh.supportLayer)||mesh.supportLayer<0||mesh.supportLayer>=8))fail('support layer');
  if(mesh.placementOnly!==undefined&&(mesh.placementOnly!==true||!surface||mesh.supportLayer===undefined&&mesh.regions.some(r=>r.bedMin!==r.bedMax)))fail('placement-only geometry');
  if(surface){
    if(!surface.mesh||surface.mesh.surface||!Array.isArray(surface.owners))fail('surface reference');
    if(surface.mesh.supportLayer!==mesh.supportLayer)fail('surface support layer');
    validateWaterBoundaryMesh(w,surface.mesh);
    if(surface.owners.length!==surface.mesh.regions.length||surface.owners.some((owner,i)=>!Number.isInteger(owner)||owner<0||owner>=mesh.regions.length||mesh.regions[owner].cell!==surface.mesh.regions[i].cell))fail('surface ownership');
    // A placement wrapper adds only canonical rectangular bulk markers to an
    // otherwise identical partition. Reuse the reference's topology proof
    // only when the complete graph is immutable and every shared field is
    // identical. Literal, mutable or changed geometry takes the full path.
    const reference=surface.mesh;
    if(mesh.placementOnly===true&&validated.get(reference)?.has(key)&&mesh.cells===reference.cells&&mesh.faces===reference.faces
      &&mesh.regions.length===reference.regions.length&&deeplyFrozen(mesh)){
      let identical=true;
      for(let i=0;i<mesh.regions.length&&identical;i++){
        const r=mesh.regions[i],exact=reference.regions[i];
        identical=surface.owners[i]===i&&!!r&&owns(r,regionKeys)
          &&r.cell===exact.cell&&r.polygon===exact.polygon&&r.area===exact.area&&r.center===exact.center
          &&r.bedMin===exact.bedMin&&r.bedMax===exact.bedMax&&r.solid===exact.solid&&r.supportId===exact.supportId&&r.ceiling===exact.ceiling
          &&(r.bulk===undefined||r.bulk===true);
        if(identical&&r.bulk){
          identical=Object.hasOwn(r,'bulk')&&!r.solid&&r.bedMin===r.bedMax&&r.polygon.length===4&&mesh.cells[r.cell].length===1;
          const x=w.origin.x+Math.floor(r.cell/w.rows)*w.cellSizeX,z=w.origin.z+(r.cell%w.rows)*w.cellSizeZ,corners=new Set<number>();
          for(const p of r.polygon){const dx=p.x===x?0:p.x===x+w.cellSizeX?1:-1,dz=p.z===z?0:p.z===z+w.cellSizeZ?1:-1;if(dx<0||dz<0)identical=false;corners.add(dx*2+dz);}
          if(corners.size!==4)identical=false;
        }
      }
      if(identical){remember();return;}
    }
    // A failed immutability walk cannot supply partial cache proofs later.
    visited.clear();
    for(const f of surface.mesh.faces){const a=surface.owners[f.a],b=f.b<0?-1:surface.owners[f.b];if(a===b)continue;const key=`${Math.min(a,b)},${Math.max(a,b)}`,list=referenceFaces.get(key)??[];list.push(f);referenceFaces.set(key,list);}
  }
  let work=0,points=0;
  const spend=(n=1)=>{work+=n;if(work>WATER_BOUNDARY_LIMITS.work)fail('validation work budget');};
  type PerimeterEdge={length:number;x:number;z:number;dx:number;dz:number;nx:number;nz:number;epsilon:number;intervals:[number,number][]};
  const planes:Plane[]=[],regionBounds:{minX:number;maxX:number;minZ:number;maxZ:number}[]=[],perimeters:PerimeterEdge[][]=[];
  for(const r of mesh.regions){
    if(!r||!owns(r,regionKeys)||!Number.isInteger(r.cell)||r.cell<0||r.cell>=count||!Array.isArray(r.polygon)||r.polygon.length<3||r.polygon.length>WATER_BOUNDARY_LIMITS.vertices)fail('region polygon');
    points+=r.polygon.length;if(points>WATER_BOUNDARY_LIMITS.points)fail('point budget');
    const x=w.origin.x+Math.floor(r.cell/w.rows)*w.cellSizeX,z=w.origin.z+(r.cell%w.rows)*w.cellSizeZ;
    let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,minBed=Infinity,maxBed=-Infinity;
    for(const p of r.polygon){
      if(!p||!owns(p,pointKeys)||!finite(p.x)||!finite(p.z)||!finite(p.bed)||Math.abs(p.bed)>30000||p.x<x-tolerance||p.x>x+w.cellSizeX+tolerance||p.z<z-tolerance||p.z>z+w.cellSizeZ+tolerance)fail('vertex outside cell');
      minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);
      minBed=Math.min(minBed,p.bed);maxBed=Math.max(maxBed,p.bed);
    }
    regionBounds.push({minX,maxX,minZ,maxZ});
    const area=polygonArea(r.polygon);
    if(!(area>EPS*EPS)||!finite(r.area)||Math.abs(r.area-area)>area*1e-8+1e-18)fail('region area');
    const plane=bedPlane(r.polygon);planes.push(plane);
    for(const p of r.polygon)if(Math.abs(height(plane,p.x,p.z)-p.bed)>1e-8)fail('nonplanar bed');
    const center=centroid(r.polygon);
    if(!r.center||!owns(r.center,centerKeys)||!finite(r.center.x)||!finite(r.center.z)||!finite(r.bedMin)||!finite(r.bedMax)||Math.hypot(center.x-r.center.x,center.z-r.center.z)>tolerance
      ||Math.abs(r.bedMin-minBed)>1e-8||Math.abs(r.bedMax-maxBed)>1e-8)fail('centroid or bed extrema');
    if(r.solid){
      const solid=r.solid;
      if(!owns(solid,solidKeys)||!solid.id||typeof solid.id!=='string'||solid.id.length>1024||!finite(solid.bottom)||!finite(solid.top)||solid.bottom>solid.top)fail('solid crest');
      for(const p of r.polygon)if(Math.abs(p.bed-solid.top)>1e-8)fail('solid crest');
    }
    if(mesh.supportLayer!==undefined&&(typeof r.supportId!=='string'||r.supportId.length>1024||!finite(r.ceiling!)||r.ceiling!<r.bedMin-1e-8))fail('support clearance');
    if(mesh.supportLayer===undefined&&(r.supportId!==undefined||r.ceiling!==undefined))fail('unexpected support metadata');
    if(r.bulk!==undefined&&(r.bulk!==true||!surface||r.solid||r.bedMin!==r.bedMax||r.polygon.length!==4))fail('bulk region');
    if(r.bulk){const corners=new Set<number>();for(const p of r.polygon){const dx=p.x===x?0:p.x===x+w.cellSizeX?1:-1,dz=p.z===z?0:p.z===z+w.cellSizeZ?1:-1;if(dx<0||dz<0)fail('bulk footprint');corners.add(dx*2+dz);}if(corners.size!==4)fail('bulk footprint');}
    const perimeter:PerimeterEdge[]=[];
    for(let j=0;j<r.polygon.length;j++){
      const a=r.polygon[j],b=r.polygon[(j+1)%r.polygon.length],dx=b.x-a.x,dz=b.z-a.z,length=Math.hypot(dx,dz);if(length<=EPS)fail('degenerate polygon edge');
      for(const p of r.polygon){spend();if(dx*(p.z-a.z)-dz*(p.x-a.x)<-tolerance*length)fail('nonconvex or clockwise polygon');}
      const unitX=dx/length,unitZ=dz/length;
      perimeter.push({length,x:a.x,z:a.z,dx:unitX,dz:unitZ,nx:unitZ,nz:-unitX,epsilon:Math.min(tolerance,length*1e-7),intervals:[]});
    }
    perimeters.push(perimeter);
  }
  const seen=new Set<number>();
  for(let cell=0;cell<count;cell++){
    const members=mesh.cells[cell];if(!Array.isArray(members)||!members.length||members.length>WATER_BOUNDARY_LIMITS.regionsPerCell)fail('cell members');
    let area=0;
    for(const i of members){if(!Number.isInteger(i)||i<0||i>=mesh.regions.length||seen.has(i)||mesh.regions[i].cell!==cell)fail('cell region identity');seen.add(i);area+=mesh.regions[i].area;}
    if(Math.abs(area-w.cellArea)>w.cellArea*1e-8)fail('cell coverage');
    for(let j=0;j<members.length;j++)for(let k=j+1;k<members.length;k++){
      const aBounds=regionBounds[members[j]],bBounds=regionBounds[members[k]];
      // Exact disjoint/touching bounds prove zero intersection. Overlapping
      // bounds still receive the complete convex-polygon clipping check.
      if(aBounds.maxX<=bBounds.minX||bBounds.maxX<=aBounds.minX||aBounds.maxZ<=bBounds.minZ||bBounds.maxZ<=aBounds.minZ)continue;
      const a=mesh.regions[members[j]],b=mesh.regions[members[k]];let intersection=a.polygon;
      for(let edge=0;edge<b.polygon.length&&intersection.length;edge++){
        spend(intersection.length);const p=b.polygon[edge],q=b.polygon[(edge+1)%b.polygon.length],nx=q.z-p.z,nz=p.x-q.x;
        intersection=clipBoundaryPolygon(intersection,nx,nz,nx*p.x+nz*p.z);
      }
      if(polygonArea(intersection)>Math.min(a.area,b.area)*1e-8+1e-18)fail('overlapping cell regions');
    }
  }
  if(seen.size!==mesh.regions.length)fail('unreferenced region');
  if(surface){
    const ownership=mesh.regions.map(()=>[] as number[]);for(let i=0;i<surface.owners.length;i++)ownership[surface.owners[i]].push(i);
    for(let i=0;i<mesh.regions.length;i++){
      const r=mesh.regions[i],members=ownership[i];if(!members.length)fail('surface owner coverage');
      if(members.some(j=>surface.mesh.regions[j].supportId!==r.supportId||surface.mesh.regions[j].ceiling!==r.ceiling))fail('surface support ownership');
      if(r.bulk){
        if(mesh.cells[r.cell].length!==1||members.length!==surface.mesh.cells[r.cell].length||members.some(j=>surface.mesh.regions[j].solid))fail('bulk surface coverage');
        let bed=-Infinity;for(const j of members){const exact=surface.mesh.regions[j],p=exact.polygon;
          if(p.every((a,k)=>{const b=p[(k+1)%p.length];return(b.x-a.x)*(r.center.z-a.z)-(b.z-a.z)*(r.center.x-a.x)>=-tolerance;}))bed=Math.max(bed,height(bedPlane(p),r.center.x,r.center.z));}
        if(!Number.isFinite(bed)||Math.abs(bed-r.bedMin)>1e-8)fail('bulk center bed');
      }else{
        const exact=surface.mesh.regions[members[0]];
        if(members.length!==1||r.supportId!==exact.supportId||r.ceiling!==exact.ceiling||r.polygon.length!==exact.polygon.length||r.polygon.some((p,k)=>p.x!==exact.polygon[k].x||p.z!==exact.polygon[k].z||p.bed!==exact.polygon[k].bed)
          ||r.area!==exact.area||r.bedMin!==exact.bedMin||r.bedMax!==exact.bedMax||(r.solid===undefined?exact.solid!==undefined:exact.solid===undefined||r.solid.id!==exact.solid.id||r.solid.bottom!==exact.solid.bottom||r.solid.top!==exact.solid.top))fail('cut surface owner');
      }
    }
  }
  const onEdge=(region:number,start:BoundaryPoint,end:BoundaryPoint,faceX:number,faceZ:number)=>{
    for(const edge of perimeters[region]){
      spend();const {length,x,z,dx,dz,epsilon}=edge;
      // A valid short face near a corner may lie inside both adjacent edges'
      // positional tolerance. Direction must match before choosing its owner;
      // otherwise the first edge supplies an unrelated outward normal.
      if(Math.abs(dx*faceZ-dz*faceX)>1e-8)continue;
      const from=dx*(start.x-x)+dz*(start.z-z),to=dx*(end.x-x)+dz*(end.z-z);
      if(Math.abs(dx*(start.z-z)-dz*(start.x-x))<=epsilon&&Math.abs(dx*(end.z-z)-dz*(end.x-x))<=epsilon
        &&Math.min(from,to)>=-epsilon&&Math.max(from,to)<=length+epsilon){
        edge.intervals.push([Math.max(0,Math.min(from,to)),Math.min(length,Math.max(from,to))]);return edge;
      }
    }
    return fail('face endpoint not on region edge');
  };
  for(const f of mesh.faces){
    if(!f||!owns(f,faceKeys)||!Number.isInteger(f.a)||!Number.isInteger(f.b)||f.a<0||f.a>=mesh.regions.length||f.b< -1||f.b>=mesh.regions.length||f.a===f.b
      ||!f.start||!f.end||!owns(f.start,pointKeys)||!owns(f.end,pointKeys)||!finite(f.start.x)||!finite(f.start.z)||!finite(f.start.bed)
      ||!finite(f.end.x)||!finite(f.end.z)||!finite(f.end.bed)||!finite(f.nx)||!finite(f.nz)||!finite(f.length))fail('face data');
    const closed=mesh.supportLayer!==undefined&&f.b>=0&&(!mesh.regions[f.a].supportId||!mesh.regions[f.b].supportId||Math.min(f.start.bed,f.end.bed)>=Math.min(mesh.regions[f.a].ceiling!,mesh.regions[f.b].ceiling!)-EPS);
    if(f.closed!==undefined&&f.closed!==true||Boolean(f.closed)!==Boolean(closed))fail('support interface');
    const length=Math.hypot(f.end.x-f.start.x,f.end.z-f.start.z);
    if(length<=EPS||Math.abs(length-f.length)>length*1e-8||Math.abs(Math.hypot(f.nx,f.nz)-1)>1e-8)fail('face length/normal');
    const faceX=(f.end.x-f.start.x)/length,faceZ=(f.end.z-f.start.z)/length;
    const edge=onEdge(f.a,f.start,f.end,faceX,faceZ);if(Math.hypot(edge.nx-f.nx,edge.nz-f.nz)>1e-8)fail('face outward normal');
    if(f.b>=0){
      const other=onEdge(f.b,f.start,f.end,faceX,faceZ),a=mesh.regions[f.a].center,b=mesh.regions[f.b].center;
      if(Math.hypot(other.nx+f.nx,other.nz+f.nz)>1e-8||(b.x-a.x)*f.nx+(b.z-a.z)*f.nz<=0)fail('internal face normal');
      const planeA=planes[f.a],planeB=planes[f.b];
      // A split exactly at a bed-plane intersection can evaluate one ULP to
      // either side. Require a sign resolved beyond the dot-product rounding
      // bound at both endpoints; genuine interior crossings still fail.
      const startDifference=height(planeA,f.start.x,f.start.z)-height(planeB,f.start.x,f.start.z),endDifference=height(planeA,f.end.x,f.end.z)-height(planeB,f.end.x,f.end.z);
      if(startDifference*endDifference<-1e-16){
        const rounding=(p:BoundaryPoint)=>Number.EPSILON*4*(1+(Math.abs(planeA.x*p.x)+Math.abs(planeA.z*p.z)+Math.abs(planeA.c)+Math.abs(planeB.x*p.x)+Math.abs(planeB.z*p.z)+Math.abs(planeB.c)));
        if(Math.abs(startDifference)>rounding(f.start)&&Math.abs(endDifference)>rounding(f.end))fail('unsplit face bed crossing');
      }
    }else{
      const at=(axis:'x'|'z',value:number)=>Math.abs(f.start[axis]-value)<=tolerance&&Math.abs(f.end[axis]-value)<=tolerance;
      if(!at('x',w.origin.x)&&!at('x',w.origin.x+w.columns*w.cellSizeX)&&!at('z',w.origin.z)&&!at('z',w.origin.z+w.rows*w.cellSizeZ))fail('interior face marked exterior');
    }
    const mixed=surface&&f.b>=0&&Boolean(mesh.regions[f.a].bulk)!==Boolean(mesh.regions[f.b].bulk);
    const references=mixed?referenceFaces.get(`${Math.min(f.a,f.b)},${Math.max(f.a,f.b)}`):undefined;
    for(let endpoint=0;endpoint<2;endpoint++){const p=endpoint===0?f.start:f.end;let bed=Math.max(height(planes[f.a],p.x,p.z),f.b<0?-Infinity:height(planes[f.b],p.x,p.z));
      if(mixed){let exact=-Infinity;for(const ref of references??[]){const dx=ref.end.x-ref.start.x,dz=ref.end.z-ref.start.z,t=((p.x-ref.start.x)*dx+(p.z-ref.start.z)*dz)/(ref.length*ref.length);
          if(t>=-1e-8&&t<=1+1e-8&&Math.abs(dx*(p.z-ref.start.z)-dz*(p.x-ref.start.x))<=tolerance*ref.length)exact=Math.max(exact,ref.start.bed+(ref.end.bed-ref.start.bed)*Math.max(0,Math.min(1,t)));}
        if(!Number.isFinite(exact))fail('mixed face reference');bed=Math.max(bed,exact);}
      if(Math.abs(p.bed-bed)>1e-8)fail('face bed');}
  }
  const intervalOrder=(a:[number,number],b:[number,number])=>a[0]-b[0];
  for(const perimeter of perimeters)for(const edge of perimeter){
    const sorted=edge.intervals,epsilon=edge.epsilon;let covered=0;
    if(sorted.length>1)sorted.sort(intervalOrder);
    for(let i=0;i<sorted.length;i++){const from=sorted[i][0],to=sorted[i][1];if(Math.abs(from-covered)>epsilon||to<=from)fail('incomplete or overlapping perimeter');covered=to;}
    if(Math.abs(covered-edge.length)>epsilon)fail('incomplete perimeter');
  }
  if(deeplyFrozen(mesh)){
    // Commit the proof only after every reachable value passed. A frozen
    // cycle can otherwise appear complete before a mutable sibling is found.
    remember();
  }
}

export function compileWaterBoundaryMesh(w:WaterBodyManifest,scene:PhysicsScene):WaterBoundaryMesh {
  return compileBoundaryMesh(w,scene);
}

/** Exact placement footprints over the same center-sampled terrain storage as
 * the original solver. Native terrain triangulation must not add controls,
 * lower a face sill, or introduce subcell drainage basins in this mode. */
export function compileWaterPlacementBoundaryMesh(w:WaterBodyManifest,scene:PhysicsScene,centerBeds:readonly number[]):WaterBoundaryMesh {
  if(centerBeds.length!==w.columns*w.rows||centerBeds.some(v=>!Number.isFinite(v)))throw new Error('Invalid water placement center beds');
  return compileBoundaryMesh(w,scene,centerBeds);
}

function compileBoundaryMesh(w:WaterBodyManifest,scene:PhysicsScene,centerBeds?:readonly number[]):WaterBoundaryMesh {
  // Detached rubble can enter the scene after settling. Its collision and
  // displacement remain active, but its pose must not invalidate fixed cuts.
  const placementColliders=scene.colliders.flatMap((c,i)=>c.waterBoundary===false?[]:[c.id?c:{...c,id:`liquid-static-${i}`}]);
  const content=JSON.stringify([w.columns,w.rows,w.origin,w.cellSizeX,w.cellSizeZ,w.cellArea,w.liquid.bounds,
    centerBeds?['placement-only-v1',centerBeds]:scene.terrain,centerBeds?undefined:scene.terrainChunks,placementColliders,w.placementSupports]);
  const old=cache.get(content);if(old)return old;
  const sourceKey=`${hash(content)}-${hash('boundary:'+content)}`;
  const count=w.columns*w.rows,tolerance=Math.max(w.cellSizeX,w.cellSizeZ)*1e-8;
  const support=w.placementSupports;
  if(support&&(!Number.isInteger(support.layer)||support.layer<0||support.layer>=8))throw new Error('Invalid placement support layer');
  const supportGeometry=support?createWaterSupportGeometry({colliders:scene.colliders,terrain:support.terrain,terrainChunks:support.terrainChunks},support.patches,{maxY:w.liquid.bounds.max.y,cellSizeX:w.cellSizeX,cellSizeZ:w.cellSizeZ}):undefined;
  // Native face triangulation must not create tiny independent reservoirs.
  // Coincident declared/native triangles on the same solid share provenance;
  // actual footprint, bed and ceiling differences still prevent coalescing.
  const supportIds=new Map<string,string>(),supportPlanes=new Map<string,{id:string;plane:Plane}[]>();
  for(const patch of supportGeometry?.patches??[]){
    if(!patch.colliderId){supportIds.set(patch.id,patch.id);continue;}
    const polygon=patch.vertices.map(p=>({x:p.x,z:p.z,bed:p.y})),plane=bedPlane(polygon),groups=supportPlanes.get(patch.colliderId)??[];
    const group=groups.find(g=>polygon.every(p=>Math.abs(p.bed-height(g.plane,p.x,p.z))<=1e-9)&&Math.abs(g.plane.x-plane.x)+Math.abs(g.plane.z-plane.z)<=1e-9);
    supportIds.set(patch.id,group?.id??patch.id);if(!group){groups.push({id:patch.id,plane});supportPlanes.set(patch.colliderId,groups);}
  }
  let work=0;
  const spend=(amount=1)=>{work+=amount;if(work>WATER_BOUNDARY_LIMITS.work)throw new Error('Water boundary geometry work budget exceeded');};
  const check=(pieces:Piece[])=>{if(pieces.length>WATER_BOUNDARY_LIMITS.regionsPerCell)throw new Error('Water boundary regions per cell budget exceeded');for(const p of pieces)if(p.polygon.length>WATER_BOUNDARY_LIMITS.vertices)throw new Error('Water boundary polygon vertex budget exceeded');};
  const split=(polygon:BoundaryPoint[],nx:number,nz:number,offset:number):[BoundaryPoint[],BoundaryPoint[]]=>{
    // Footprint edges can be much shorter than a cell. Classify by physical
    // distance, not an unnormalised dot product that erases narrow fragments.
    const normal=Math.hypot(nx,nz);if(normal){nx/=normal;nz/=normal;offset/=normal;}
    spend(polygon.length);let low=Infinity,high=-Infinity;
    for(const p of polygon){const d=nx*p.x+nz*p.z-offset;low=Math.min(low,d);high=Math.max(high,d);}
    if(high<=EPS)return[polygon,[]];if(low>=-EPS)return[[],polygon];
    return[clipBoundaryPolygon(polygon,nx,nz,offset),clipBoundaryPolygon(polygon,-nx,-nz,-offset)];
  };
  /** Separate a convex footprint from a piece without overlapping its outside
   * fragments. Every piece retains its own plane until the overlay is chosen. */
  const partition=(piece:Piece,footprint:BoundaryPoint[]):{outside:Piece[];inside:BoundaryPoint[]}=>{
    let inside=piece.polygon;const outside:Piece[]=[];
    for(let j=0;j<footprint.length&&inside.length;j++){
      const a=footprint[j],b=footprint[(j+1)%footprint.length],nx=b.z-a.z,nz=a.x-b.x;
      const [keep,other]=split(inside,nx,nz,nx*a.x+nz*a.z);if(other.length)outside.push({...piece,polygon:other});inside=keep;
    }
    // Extended supporting lines may cross a polygon even when the finite
    // footprint does not. Do not retain those unrelated artificial cuts.
    return inside.length?{outside,inside}:{outside:[piece],inside:[]};
  };
  // Triangulation is an authoring detail when two adjacent pieces describe
  // the same plane. Merge only convex unions: a shared edge plus equality of
  // hull area and original area excludes gaps, concavities and point contacts.
  const coalesce=(input:Piece[]):Piece[]=>{
    const result=input.slice(),cross=(a:BoundaryPoint,b:BoundaryPoint,c:BoundaryPoint)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
    const adjacent=(a:BoundaryPoint[],b:BoundaryPoint[])=>{
      for(let i=0;i<a.length;i++){
        const p=a[i],q=a[(i+1)%a.length],length=Math.hypot(q.x-p.x,q.z-p.z),dx=(q.x-p.x)/length,dz=(q.z-p.z)/length;
        for(let j=0;j<b.length;j++){
          const r=b[j],s=b[(j+1)%b.length];spend();
          if(Math.abs(dx*(r.z-p.z)-dz*(r.x-p.x))>EPS||Math.abs(dx*(s.z-p.z)-dz*(s.x-p.x))>EPS)continue;
          const from=dx*(r.x-p.x)+dz*(r.z-p.z),to=dx*(s.x-p.x)+dz*(s.z-p.z);
          if(to<from&&Math.min(length,from)-Math.max(0,to)>EPS)return true;
        }
      }
      return false;
    };
    const hull=(points:BoundaryPoint[])=>{
      const sorted=points.slice().sort((a,b)=>a.x-b.x||a.z-b.z),unique=sorted.filter((p,i)=>!i||p.x!==sorted[i-1].x||p.z!==sorted[i-1].z);
      const half=(vertices:BoundaryPoint[])=>{const out:BoundaryPoint[]=[];for(const p of vertices){while(out.length>1&&cross(out[out.length-2],out[out.length-1],p)<=0)out.pop();out.push(p);}out.pop();return out;};
      const polygon=[...half(unique),...half(unique.slice().reverse())];
      // Keep every extreme vertex, including small real corners, while making
      // the first triangle numerically well conditioned for bedPlane readers.
      let first=0,best=0;for(let i=0;i<polygon.length;i++){const determinant=Math.abs(cross(polygon[i],polygon[(i+1)%polygon.length],polygon[(i+2)%polygon.length]));if(determinant>best){best=determinant;first=i;}}
      return [...polygon.slice(first),...polygon.slice(0,first)];
    };
    for(let i=0;i<result.length;i++)for(let j=i+1;j<result.length;j++){
      const a=result[i],b=result[j];spend(a.polygon.length+b.polygon.length);
      if(a.ground!==b.ground||a.supportId!==b.supportId||a.ceiling!==b.ceiling||(a.solid===undefined?b.solid!==undefined:b.solid===undefined||a.solid.id!==b.solid.id||a.solid.bottom!==b.solid.bottom||a.solid.top!==b.solid.top)
        ||b.polygon.some(p=>Math.abs(p.bed-height(a.plane,p.x,p.z))>1e-9)||!adjacent(a.polygon,b.polygon))continue;
      const polygon=hull([...a.polygon,...b.polygon]),area=polygonArea(a.polygon)+polygonArea(b.polygon);
      if(polygon.length>WATER_BOUNDARY_LIMITS.vertices||polygon.some((p,k)=>Math.hypot(p.x-polygon[(k+1)%polygon.length].x,p.z-polygon[(k+1)%polygon.length].z)<=EPS)
        ||Math.abs(polygonArea(polygon)-area)>Math.max(EPS*EPS,area*Number.EPSILON*64))continue;
      // Area equality alone can hide a tiny concavity beside a narrow tread.
      // Every hull edge must already exist on the two input perimeters; a new
      // chord would swallow a neighbouring fragment and duplicate its water.
      const exactPerimeter=polygon.every((p,k)=>{
        const q=polygon[(k+1)%polygon.length],length=Math.hypot(q.x-p.x,q.z-p.z),dx=(q.x-p.x)/length,dz=(q.z-p.z)/length,intervals:[number,number][]=[];
        for(const original of [a.polygon,b.polygon])for(let n=0;n<original.length;n++){
          const r=original[n],s=original[(n+1)%original.length];spend();
          if(Math.abs(dx*(r.z-p.z)-dz*(r.x-p.x))>EPS||Math.abs(dx*(s.z-p.z)-dz*(s.x-p.x))>EPS)continue;
          const from=dx*(r.x-p.x)+dz*(r.z-p.z),to=dx*(s.x-p.x)+dz*(s.z-p.z);if(to>from)intervals.push([Math.max(0,from),Math.min(length,to)]);
        }
        intervals.sort((u,v)=>u[0]-v[0]);let covered=0;for(const [from,to] of intervals){if(from>covered+EPS)return false;covered=Math.max(covered,to);}return covered>=length-EPS;
      });
      if(!exactPerimeter)continue;
      result[i]={...a,polygon:withPlane(polygon,a.plane)};result.splice(j,1);i=-1;break;
    }
    return result;
  };
  const bins:Surface[][]=Array.from({length:count},()=>[]);
  const assign=(polygon:BoundaryPoint[],visit:(cell:number)=>void)=>{
    const minX=Math.min(...polygon.map(p=>p.x)),maxX=Math.max(...polygon.map(p=>p.x)),minZ=Math.min(...polygon.map(p=>p.z)),maxZ=Math.max(...polygon.map(p=>p.z));
    const x0=Math.max(0,Math.floor((minX-w.origin.x)/w.cellSizeX)),x1=Math.min(w.columns-1,Math.ceil((maxX-w.origin.x)/w.cellSizeX)-1),
      z0=Math.max(0,Math.floor((minZ-w.origin.z)/w.cellSizeZ)),z1=Math.min(w.rows-1,Math.ceil((maxZ-w.origin.z)/w.cellSizeZ)-1);
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){spend();visit(x*w.rows+z);}
  };
  // The native terrain diagonal joins h10 to h01 (tx+tz=1), not h00 to h11.
  for(const ground of centerBeds?[]:liquidGrounds(scene)){
    const f=ground.field,dx=f.width/f.columns,dz=f.depth/f.rows,ox=ground.position.x-f.width/2,oz=ground.position.z-f.depth/2;
    const point=(cx:number,cz:number):BoundaryPoint=>({x:ox+cx*dx,z:oz+cz*dz,bed:ground.position.y+f.heights[cx*(f.rows+1)+cz]});
    const plane=bedPlane([point(0,0),point(f.columns,0),point(0,f.rows)]);
    if(f.heights.every((v,i)=>Math.abs(v+ground.position.y-height(plane,ox+Math.floor(i/(f.rows+1))*dx,oz+(i%(f.rows+1))*dz))<=1e-9)){
      const polygon=rect(ox,oz,f.width,f.depth,plane),surface={polygon,plane};assign(polygon,cell=>bins[cell].push(surface));continue;
    }
    for(let x=0;x<f.columns;x++)for(let z=0;z<f.rows;z++){
      const a=point(x,z),b=point(x+1,z),c=point(x,z+1),d=point(x+1,z+1);
      for(const polygon of [[a,b,c],[d,c,b]]){const surface={polygon,plane:bedPlane(polygon)};assign(polygon,cell=>bins[cell].push(surface));}
    }
  }
  const wallBins:{polygon:BoundaryPoint[];solid:NonNullable<WaterBoundaryRegion['solid']>}[][]=Array.from({length:count},()=>[]);
  // Only explicit placement supports add cuts. Ordinary terrain remains the
  // existing centre-sampled hydraulic bed, including in mixed terrain worlds.
  const supportBins:Surface[][]=Array.from({length:count},()=>[]),cutBins:BoundaryPoint[][][]=Array.from({length:count},()=>[]);
  for(const patch of supportGeometry?.placementPatches??[]){
    let polygon=patch.vertices.map(p=>({x:p.x,z:p.z,bed:p.y}));
    if((polygon[1].x-polygon[0].x)*(polygon[2].z-polygon[0].z)-(polygon[1].z-polygon[0].z)*(polygon[2].x-polygon[0].x)<0)polygon=polygon.slice().reverse();
    const surface={polygon,plane:bedPlane(polygon)};assign(polygon,cell=>{supportBins[cell].push(surface);cutBins[cell].push(polygon);});
  }
  for(const obstacle of supportGeometry?.obstacles??[]){
    if(obstacle.collider.waterBoundary===false)continue;
    const shape=obstacle.collider.shape,vertices=shape.kind==='convex'?shape.vertices:shape.kind==='box'?Array.from({length:8},(_,i)=>({x:(i&1?1:-1)*shape.halfExtents.x,y:(i&2?1:-1)*shape.halfExtents.y,z:(i&4?1:-1)*shape.halfExtents.z})):[];
    const points=vertices.map(v=>{const p=liquidRotate(v,obstacle.collider.rotation);return{x:obstacle.collider.position.x+p.x,z:obstacle.collider.position.z+p.z,bed:0};}).sort((a,b)=>a.x-b.x||a.z-b.z);
    const cross=(a:BoundaryPoint,b:BoundaryPoint,c:BoundaryPoint)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x),half=(values:BoundaryPoint[])=>{const out:BoundaryPoint[]=[];for(const p of values){while(out.length>1&&cross(out.at(-2)!,out.at(-1)!,p)<=0)out.pop();out.push(p);}out.pop();return out;};
    const polygon=[...half(points),...half(points.slice().reverse())];if(polygon.length>=3)assign(polygon,cell=>cutBins[cell].push(polygon));
  }
  for(const obstacle of liquidObstacles({...scene,colliders:placementColliders},[])){
    const bounds=w.liquid.bounds;
    if(obstacle.max.x<=bounds.min.x||obstacle.min.x>=bounds.max.x||obstacle.max.z<=bounds.min.z||obstacle.min.z>=bounds.max.z||obstacle.max.y<=bounds.min.y||obstacle.min.y>=bounds.max.y)continue;
    // Only grounded upright boxes change the terrain footprint. Other solids
    // retain the existing volumetric displacement/contact representation.
    const c=obstacle.collider;if(c.shape.kind!=='box')continue;
    const half=c.shape.halfExtents;
    const up=liquidRotate({x:0,y:1,z:0},c.rotation);
    if(Math.abs(up.x)>1e-8||Math.abs(up.z)>1e-8||up.y<1-1e-8)continue;
    const polygon=[[-half.x,-half.z],[half.x,-half.z],[half.x,half.z],[-half.x,half.z]].map(([x,z])=>{
      const p=liquidRotate({x,y:0,z},c.rotation);return{x:c.position.x+p.x,z:c.position.z+p.z,bed:c.position.y+half.y};
    });
    const wall={polygon,solid:{id:obstacle.colliderId,bottom:c.position.y-half.y,top:c.position.y+half.y}};
    assign(polygon,cell=>wallBins[cell].push(wall));
  }
  const regions:WaterBoundaryRegion[]=[],cells:number[][]=Array.from({length:count},()=>[]);let pointCount=0;
  for(let cell=0;cell<count;cell++){
    const x=w.origin.x+Math.floor(cell/w.rows)*w.cellSizeX,z=w.origin.z+(cell%w.rows)*w.cellSizeZ,fallback={x:0,z:0,c:centerBeds?.[cell]??w.liquid.bounds.min.y};
    let pieces:Piece[]=[{polygon:rect(x,z,w.cellSizeX,w.cellSizeZ,fallback),plane:fallback,ground:false}];
    for(const surface of bins[cell]){
      const next:Piece[]=[];
      for(const piece of pieces){
        if(piece.ground&&piece.polygon.every(p=>height(surface.plane,p.x,p.z)<=p.bed+EPS)){
          // A lower/equal planar surface cannot win anywhere in this convex
          // region. Its triangle outline therefore introduces no new boundary.
          next.push(piece);continue;
        }
        const {outside,inside}=partition(piece,surface.polygon);next.push(...outside);if(!inside.length)continue;
        if(!piece.ground)next.push({polygon:withPlane(inside,surface.plane),plane:surface.plane,ground:true});
        else{
          // Topmost terrain wins, including where two sloping chunks cross.
          const difference={x:piece.plane.x-surface.plane.x,z:piece.plane.z-surface.plane.z,c:piece.plane.c-surface.plane.c};
          const [higher,lower]=split(inside,difference.x,difference.z,-difference.c);
          if(higher.length)next.push({polygon:withPlane(higher,surface.plane),plane:surface.plane,ground:true});
          if(lower.length)next.push({...piece,polygon:lower});
        }
      }
      pieces=next;check(pieces);
    }
    // Flat or uniformly sloping terrain retains the original regular cell,
    // even if it crosses many triangulation edges or overlapping chunks.
    const first=pieces[0].plane;
    if(pieces.every(p=>p.polygon.every(v=>Math.abs(v.bed-height(first,v.x,v.z))<=1e-9)))pieces=[{polygon:rect(x,z,w.cellSizeX,w.cellSizeZ,first),plane:first,ground:true}];
    else pieces=coalesce(pieces);
    if(supportGeometry&&support){
      // Split only cells touched by declared placement edges. Selecting each
      // resulting convex fragment independently preserves a small floor ledge,
      // a stair tread or a real opening even when the parent centre misses it.
      for(const cut of cutBins[cell]){const next:Piece[]=[];for(const piece of pieces){const {outside,inside}=partition(piece,cut);next.push(...outside);if(inside.length)next.push({...piece,polygon:inside});}pieces=next;check(pieces);}
      const planes=supportBins[cell].map(s=>s.plane);
      for(let a=0;a<planes.length;a++)for(let b=0;b<a;b++){
        const nx=planes[a].x-planes[b].x,nz=planes[a].z-planes[b].z;if(Math.hypot(nx,nz)<1e-12)continue;
        const offset=planes[b].c-planes[a].c,next:Piece[]=[];
        for(const piece of pieces){const [low,high]=split(piece.polygon,nx,nz,offset);for(const polygon of [low,high])if(polygon.length)next.push({...piece,polygon});}pieces=next;check(pieces);
      }
      const ceilings=supportGeometry.obstacles.filter(o=>o.planes&&o.max.x>x&&o.min.x<x+w.cellSizeX&&o.max.z>z&&o.min.z<z+w.cellSizeZ).map(o=>({o,planes:o.planes!.map(p=>{
        const normal=liquidRotate(p.normal,o.collider.rotation),offset=p.offset+normal.x*o.collider.position.x+normal.y*o.collider.position.y+normal.z*o.collider.position.z;
        return{normal,offset};
      })}));
      pieces=pieces.map(piece=>{
        const center=centroid(piece.polygon),node=supportGeometry.at(center.x,center.z,true)[support.layer];
        if(!node){const plane={x:0,z:0,c:w.liquid.bounds.max.y};return{polygon:withPlane(piece.polygon,plane),plane,ground:true,supportId:'',ceiling:w.liquid.bounds.max.y};}
        const plane=node.placement&&node.plane?node.plane:{x:0,z:0,c:centerBeds?.[cell]??node.bed};
        // Footprints already partition this fragment. Select actual overhead
        // solids at its interior, without the contact query's expanded edge
        // epsilon; a nearby platform must not roof the open strip beside it.
        // A convex underside is the maximum of its downward planes. Partition
        // that lower hull before minimizing so sloped/creased ceilings retain
        // their true conservative clearance, including an interior minimum.
        let ceiling=w.liquid.bounds.max.y;
        for(const {o,planes} of ceilings){
          if(center.x<o.min.x||center.x>o.max.x||center.z<o.min.z||center.z>o.max.z)continue;
          let bottom=-Infinity,top=Infinity,inside=true;const lower:Plane[]=[];
          for(const {normal:n,offset} of planes){
            spend();const d=offset-n.x*center.x-n.z*center.z;
            if(Math.abs(n.y)<1e-12){if(d<0){inside=false;break;}}
            else if(n.y>0)top=Math.min(top,d/n.y);
            else{bottom=Math.max(bottom,d/n.y);lower.push({x:-n.x/n.y,z:-n.z/n.y,c:offset/n.y});}
          }
          if(!inside||bottom>top||bottom<=node.bed+1e-7)continue;
          for(const underside of lower){
            let polygon=piece.polygon;
            for(const other of lower){
              if(other===underside)continue;spend();const nx=other.x-underside.x,nz=other.z-underside.z;
              if(nx===0&&nz===0){if(other.c>underside.c)polygon=[];}
              else polygon=split(polygon,nx,nz,underside.c-other.c)[0];
              if(!polygon.length)break;
            }
            for(const p of polygon)ceiling=Math.min(ceiling,height(underside,p.x,p.z));
          }
        }
        return{polygon:withPlane(piece.polygon,plane),plane,ground:true,supportId:supportIds.get(node.support)??node.support,ceiling};
      });
      pieces=coalesce(pieces);
    }
    for(const wall of wallBins[cell]){
      const next:Piece[]=[],plane={x:0,z:0,c:wall.solid.top};
      for(const piece of pieces){const {outside,inside}=partition(piece,wall.polygon);next.push(...outside);if(!inside.length)continue;
        if(inside.every(p=>p.bed>=wall.solid.top-EPS)){next.push({...piece,polygon:inside});continue;}
        if(inside.some(p=>p.bed<wall.solid.bottom-1e-8)){next.push({...piece,polygon:inside});continue;}
        const [raised,above]=split(inside,piece.plane.x,piece.plane.z,wall.solid.top-piece.plane.c);
        if(raised.length)next.push({...piece,polygon:withPlane(raised,plane),plane,ground:true,solid:wall.solid});
        if(above.length)next.push({...piece,polygon:above});
      }
      pieces=next;check(pieces);
    }
    if(support)pieces=pieces.map(piece=>{
      if(piece.supportId&&piece.ceiling!<=Math.min(...piece.polygon.map(p=>p.bed))+EPS){const plane={x:0,z:0,c:w.liquid.bounds.max.y};return{polygon:withPlane(piece.polygon,plane),plane,ground:true,supportId:'',ceiling:w.liquid.bounds.max.y};}
      return piece;
    });
    pieces=coalesce(pieces);
    const area=pieces.reduce((sum,p)=>sum+polygonArea(p.polygon),0);
    if(Math.abs(area-w.cellArea)>w.cellArea*1e-8)throw new Error('Water boundary partition lost cell area');
    for(const piece of pieces){
      const polygon=piece.polygon,index=regions.length;
      if(index>=WATER_BOUNDARY_LIMITS.regions)throw new Error('Water boundary region budget exceeded');
      pointCount+=polygon.length;if(pointCount>WATER_BOUNDARY_LIMITS.points)throw new Error('Water boundary point budget exceeded');
      regions.push({cell,polygon,area:polygonArea(polygon),center:centroid(polygon),bedMin:Math.min(...polygon.map(p=>p.bed)),bedMax:Math.max(...polygon.map(p=>p.bed)),...(piece.solid?{solid:piece.solid}:{}),...(support?{supportId:piece.supportId!,ceiling:piece.ceiling!}:{})});cells[cell].push(index);
    }
  }
  type Edge={region:number;start:BoundaryPoint;end:BoundaryPoint;length:number;dx:number;dz:number};
  const edges:Edge[][]=Array.from({length:count},()=>[]);
  regions.forEach((r,region)=>r.polygon.forEach((start,j)=>{const end=r.polygon[(j+1)%r.polygon.length],length=Math.hypot(end.x-start.x,end.z-start.z);
    if(length>EPS)edges[r.cell].push({region,start,end,length,dx:(end.x-start.x)/length,dz:(end.z-start.z)/length});}));
  const faces:WaterBoundaryFace[]=[];
  for(let cell=0;cell<count;cell++){
    const cx=Math.floor(cell/w.rows),cz=cell%w.rows,near=[cell,...(cx?[cell-w.rows]:[]),...(cx+1<w.columns?[cell+w.rows]:[]),...(cz?[cell-1]:[]),...(cz+1<w.rows?[cell+1]:[])].flatMap(i=>edges[i]);
    for(const edge of edges[cell]){
      const overlaps:{other:Edge;from:number;to:number}[]=[],cuts=[0,edge.length];
      for(const other of near){spend();if(other.region===edge.region||edge.dx*other.dx+edge.dz*other.dz>-.999999999)continue;
        const cross=(p:BoundaryPoint)=>edge.dx*(p.z-edge.start.z)-edge.dz*(p.x-edge.start.x);
        if(Math.abs(cross(other.start))>tolerance||Math.abs(cross(other.end))>tolerance)continue;
        const at=(p:BoundaryPoint)=>edge.dx*(p.x-edge.start.x)+edge.dz*(p.z-edge.start.z),from=Math.max(0,Math.min(at(other.start),at(other.end))),to=Math.min(edge.length,Math.max(at(other.start),at(other.end)));
        if(to-from>EPS){
          overlaps.push({other,from,to});cuts.push(from,to);
          // The maximum of two adjoining bed planes can have a kink along
          // this face. Split there so interpolation never raises a false sill.
          const difference=(t:number)=>{const x=edge.start.x+edge.dx*t,z=edge.start.z+edge.dz*t,
            u=((x-other.start.x)*other.dx+(z-other.start.z)*other.dz)/other.length;
            return edge.start.bed+(edge.end.bed-edge.start.bed)*t/edge.length-other.start.bed-(other.end.bed-other.start.bed)*u;
          };
          const low=difference(from),high=difference(to);
          if(low*high<0){const crossing=from+(to-from)*low/(low-high);if(crossing>from+EPS&&crossing<to-EPS)cuts.push(crossing);}
        }
      }
      cuts.sort((a,b)=>a-b);const unique=cuts.filter((value,index)=>!index||value-cuts[index-1]>EPS);
      for(let j=1;j<unique.length;j++){
        const from=unique[j-1],to=unique[j],middle=(from+to)*.5,owners=overlaps.filter(o=>middle>o.from-EPS&&middle<o.to+EPS);
        if(owners.length>1)throw new Error('Water boundary face has overlapping neighbours');
        const other=owners[0]?.other,b=other?.region??-1;if(b>=0&&edge.region>b)continue;
        const point=(t:number):BoundaryPoint=>{const x=edge.start.x+edge.dx*t,z=edge.start.z+edge.dz*t,bed=edge.start.bed+(edge.end.bed-edge.start.bed)*t/edge.length;
          if(!other)return{x,z,bed};const u=((x-other.start.x)*other.dx+(z-other.start.z)*other.dz)/other.length;
          return{x,z,bed:Math.max(bed,other.start.bed+(other.end.bed-other.start.bed)*u)};
        };
        const start=point(from),end=point(to);
        if(b<0){const px=(start.x+end.x)*.5,pz=(start.z+end.z)*.5;
          if(Math.abs(px-w.origin.x)>tolerance&&Math.abs(px-w.origin.x-w.columns*w.cellSizeX)>tolerance&&Math.abs(pz-w.origin.z)>tolerance&&Math.abs(pz-w.origin.z-w.rows*w.cellSizeZ)>tolerance)throw new Error(`Water boundary interior face has no neighbour: ${JSON.stringify({cell,region:edge.region,start,end,support:regions[edge.region].supportId})}`);}
        if(faces.length>=WATER_BOUNDARY_LIMITS.faces)throw new Error('Water boundary face budget exceeded');
        const closed=support&&b>=0&&(!regions[edge.region].supportId||!regions[b].supportId||Math.min(start.bed,end.bed)>=Math.min(regions[edge.region].ceiling!,regions[b].ceiling!)-EPS);
        faces.push({a:edge.region,b,start,end,nx:edge.dz||0,nz:-edge.dx||0,length:to-from,...(closed?{closed:true as const}:{})});
      }
    }
  }
  const result=freeze({revision:`water-boundary-${sourceKey}`,regions,cells,faces,sourceKey,...(support?{supportLayer:support.layer}:{})});
  validateWaterBoundaryMesh(w,result);
  if(cache.size>=4)cache.delete(cache.keys().next().value!);cache.set(content,result);return result;
}
