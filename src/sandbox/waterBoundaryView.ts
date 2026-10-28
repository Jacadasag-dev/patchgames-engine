import {waterSurfaceTint} from './waterSurfaceOptics.ts';
/** Connected surface reconstruction over authoritative physical water regions. */
import { Color } from 'three';
import type { WaterBodyManifest, WaterBodyState } from './waterBody.ts';
import { boundaryRegionLevel, type BoundaryPoint, type WaterBoundaryMesh } from './waterBoundaryGeometry.ts';
import { waterBodyFilmOpacity } from './waterBodyPuddles.ts';
import {buildWaterBodySurface,WaterBodySurfaceWorkspace,type WaterBodyStyle,type WaterBodySurfaceBuffers} from './waterBodyView.ts';
import { waterBodyCells } from './waterBodyCells.ts';
import { waterBodyTerrainPartitions } from './waterBodyTerrainPartitions.ts';
import { createWaterRegionStorage } from './waterBodyRegionStorage.ts';

const MAX_VERTICES = 600000;
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const immutableMeshes = new WeakSet<object>();
function immutableMesh(mesh: object): boolean {
  if (immutableMeshes.has(mesh)) return true;
  const visited = new Set<object>();
  const frozen = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || visited.has(value)) return true;
    visited.add(value);
    const prototype = Object.getPrototypeOf(value);
    return Object.isFrozen(value) && (prototype === Object.prototype || prototype === Array.prototype)
      && Object.values(Object.getOwnPropertyDescriptors(value)).every(property => 'value' in property && frozen(property.value));
  };
  if (!frozen(mesh)) return false;
  immutableMeshes.add(mesh); return true;
}

const flatMeshes=new WeakMap<WaterBoundaryMesh,{water:WaterBodyManifest;eligible:boolean}>();
/** Use the regular renderer's accumulated tolerances only when this is exactly
 * its uncut, flat-per-cell geometry. Compiler endpoint arithmetic matters for
 * nonbinary grid spacing; no geometric epsilon can hide a small real cut. */
function canonicalFlatMesh(w:WaterBodyManifest,mesh:WaterBoundaryMesh):boolean {
  const immutable=immutableMesh(mesh),known=immutable?flatMeshes.get(mesh):undefined;if(known?.water===w)return known.eligible;
  const count=w.columns*w.rows;
  let eligible=mesh.regions.length===count&&mesh.cells.length===count&&mesh.faces.length===(w.columns+1)*w.rows+w.columns*(w.rows+1);
  for(let i=0;i<count&&eligible;i++){
    const r=mesh.regions[i],x=w.origin.x+Math.floor(i/w.rows)*w.cellSizeX,z=w.origin.z+i%w.rows*w.cellSizeZ,area=(x+w.cellSizeX-x)*(z+w.cellSizeZ-z);
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
  if(immutable)flatMeshes.set(mesh,{water:w,eligible});return eligible;
}

/** Structured cloning removes Object.freeze without changing geometry. Scan
 * mutable packets each time; revision strings and bulk flags alone are not a
 * proof that their polygons, mapping and beds still match the original grid. */
function placementGridMesh(water:WaterBodyManifest,state:WaterBodyState,mesh:WaterBoundaryMesh):boolean {
  if(mesh.supportLayer!==undefined)return false;
  const surface=mesh.surface,bed=state.bed??water.bed;
  return !!surface&&canonicalFlatMesh(water,mesh)&&canonicalFlatMesh(water,surface.mesh)
    &&surface.owners.length===mesh.regions.length&&surface.owners.every((owner,i)=>owner===i)
    &&mesh.regions.every((r,i)=>r.bulk&&r.bedMin===bed[i]&&surface.mesh.regions[i].bedMin===r.bedMin);
}

export interface WaterBoundarySurface {
  meshRevision: string;
  regionCount: number;
  /** Active hydraulic owner at clipped shores and walls. Fully submerged,
   * single-basin original-cell fans use a representative owner in that basin;
   * retained terrain triangles never expose their separate display indices. */
  triangleRegions: Uint32Array;
  /** Stable interior vertices interpolate; clipped/contact vertices use -1. */
  vertexKeys: Float64Array;
}

/** Shared samples along actual submerged openings in another hydraulic layer.
 * Geometry is fixed; values are recomputed from each accepted world state. */
export interface WaterSurfaceConnection {
  region:number;start:{x:number;z:number};end:{x:number;z:number};
}
export interface WaterSurfaceConnectionValue {height:number;nx:number;ny:number;nz:number;u:number;v:number}
export interface WaterSurfaceConnections {
  segments:readonly WaterSurfaceConnection[];
  values:readonly ({start:WaterSurfaceConnectionValue;end:WaterSurfaceConnectionValue}|undefined)[];
  revision:number;
}

export class WaterBoundarySurfaceWorkspace {
  regular?:WaterBodySurfaceWorkspace;
  mesh?: WaterBoundaryMesh;
  style = '';
  volume: number[] = [];
  solidDepth: number[] = [];
  flowX: number[] = [];
  flowZ: number[] = [];
  barriers = '';
  surface?: WaterBodySurfaceBuffers;
  storage?:SurfaceStorage;
  connectionSegments?:WaterSurfaceConnections['segments'];
  connectionValues?:WaterSurfaceConnections['values'];
}
interface SurfaceStorage {capacity:number;positions:Float32Array;normals:Float32Array;colors:Float32Array;uvs:Float32Array;flows:Float32Array;keys:Float64Array;regions:Uint32Array}
function surfaceStorage(capacity:number):SurfaceStorage {return{capacity,positions:new Float32Array(capacity*3),normals:new Float32Array(capacity*3),colors:new Float32Array(capacity*4),uvs:new Float32Array(capacity*2),flows:new Float32Array(capacity*4),keys:new Float64Array(capacity),regions:new Uint32Array(Math.ceil(capacity/3))};}

interface SurfacePoint { x:number;z:number;y:number;bed:number;nx:number;ny:number;nz:number;u:number;v:number;key:number }
function wetPolygon(polygon: readonly SurfacePoint[]): SurfacePoint[] {
  const result: SurfacePoint[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const insideA = a.bed < a.y, insideB = b.bed < b.y;
    if (insideA) result.push(a);
    if (insideA !== insideB) {
      const da=a.y-a.bed,db=b.y-b.bed;
      result.push(interpolate(a,b,da/(da-db),-1));
    }
  }
  return result;
}
function interpolate(a:SurfacePoint,b:SurfacePoint,t:number,key=-1):SurfacePoint {
  const mix=(x:number,y:number)=>x+(y-x)*t;
  return{x:mix(a.x,b.x),z:mix(a.z,b.z),y:mix(a.y,b.y),bed:mix(a.bed,b.bed),nx:mix(a.nx,b.nx),ny:mix(a.ny,b.ny),nz:mix(a.nz,b.nz),u:mix(a.u,b.u),v:mix(a.v,b.v),key};
}
interface SurfaceTopology {nodes:{region:number;x:number;z:number;bed:number;sector:number;wa:number;wb:number;wc:number}[];rings:number[][];edges:{a0:number;a1:number;b0:number;b1:number;t0:number;t1:number}[][];centers:BoundaryPoint[];bedAxes:number[][];patches:{region:number;nodes:number[];key:number}[];gridFans:{cell:number;nodes:number[];key:number}[]}
const topologies=new WeakMap<WaterBoundaryMesh,SurfaceTopology>();
const connectedTopologies=new WeakMap<object,WeakMap<WaterBoundaryMesh,SurfaceTopology>>();
function onSegment(p:{x:number;z:number},a:{x:number;z:number},b:{x:number;z:number}):number|undefined {
  const dx=b.x-a.x,dz=b.z-a.z,length2=dx*dx+dz*dz;if(length2<=1e-20)return;
  const t=((p.x-a.x)*dx+(p.z-a.z)*dz)/length2;
  if(t< -1e-8||t>1+1e-8||Math.abs(dx*(p.z-a.z)-dz*(p.x-a.x))>1e-8*Math.sqrt(length2))return;
  return Math.max(0,Math.min(1,t));
}
const CORNER_X=[0,1,1,0],CORNER_Z=[0,0,1,1];
/** Intersect a physical terrain polygon with one original grid fan sector.
 * The result reads a single affine water field, regardless of terrain detail. */
function sectorPolygon(polygon:readonly BoundaryPoint[],triangle:readonly {x:number;z:number}[]):BoundaryPoint[]{
  let result=polygon.slice();
  for(let k=0;k<3&&result.length;k++){
    const a=triangle[k],b=triangle[(k+1)%3],side=(p:{x:number;z:number})=>(b.x-a.x)*(p.z-a.z)-(b.z-a.z)*(p.x-a.x),next:BoundaryPoint[]=[];
    for(let i=0;i<result.length;i++){const p=result[i],q=result[(i+1)%result.length],dp=side(p),dq=side(q),inside=dp>=-1e-12;
      if(inside)next.push(p);if(inside!==(dq>=-1e-12)){const t=Math.max(0,Math.min(1,dp/(dp-dq)));next.push({x:p.x+(q.x-p.x)*t,z:p.z+(q.z-p.z)*t,bed:p.bed+(q.bed-p.bed)*t});}}
    result=next;
  }
  return result;
}
/** Face endpoints are included in both rings: coarse/cut T-junctions therefore
 * share the same edge segmentation instead of meeting a long unsplit triangle. */
function surfaceTopology(water:WaterBodyManifest,state:WaterBodyState,connections?:WaterSurfaceConnections):SurfaceTopology {
  let cache=topologies;
  if(connections){cache=immutableMesh(connections.segments)?connectedTopologies.get(connections.segments)??new WeakMap():new WeakMap();if(immutableMesh(connections.segments))connectedTopologies.set(connections.segments,cache);}
  const mesh=state.boundary!.mesh,known=cache.get(mesh);if(known)return known;
  const cells=waterBodyCells(water,state),nodes:SurfaceTopology['nodes']=[],rings=mesh.regions.map(()=>[] as number[]),maps=mesh.regions.map(()=>new Map<string,number>());
  const add=(region:number,p:{x:number;z:number},ring=true)=>{const key=`${Math.round(p.x*1e10)},${Math.round(p.z*1e10)}`,map=maps[region],old=map.get(key);if(old!==undefined)return old;
    const cell=mesh.regions[region].cell,u=(p.x-water.origin.x)/water.cellSizeX-Math.floor(cell/water.rows),v=(p.z-water.origin.z)/water.cellSizeZ-cell%water.rows,dx=u-.5,dz=v-.5;
    const sector=Math.abs(dx)>Math.abs(dz)?dx>0?1:3:dz>0?2:0,j=(sector+1)%4,ax=CORNER_X[sector]-.5,az=CORNER_Z[sector]-.5,bx=CORNER_X[j]-.5,bz=CORNER_Z[j]-.5,det=ax*bz-az*bx,wa=(dx*bz-dz*bx)/det,wb=(ax*dz-az*dx)/det;
    const id=nodes.length;nodes.push({region,x:p.x,z:p.z,bed:cells.bedAt(region,p.x,p.z),sector,wa,wb,wc:1-wa-wb});if(ring)rings[region].push(id);map.set(key,id);return id;};
  for(let i=0;i<mesh.regions.length;i++)for(const p of mesh.regions[i].polygon)add(i,p);
  const connectionsByRegion=mesh.regions.map(()=>[] as WaterSurfaceConnection[]);
  for(const c of connections?.segments??[]){connectionsByRegion[c.region].push(c);add(c.region,c.start);add(c.region,c.end);}
  const edges=mesh.faces.map(f=>{
    const cell=mesh.regions[f.a].cell,x=water.origin.x+Math.floor(cell/water.rows)*water.cellSizeX,z=water.origin.z+cell%water.rows*water.cellSizeZ,cuts=[0,1],u=(p:BoundaryPoint)=>(p.x-x)/water.cellSizeX,v=(p:BoundaryPoint)=>(p.z-z)/water.cellSizeZ;
    for(const side of [(p:BoundaryPoint)=>u(p)-v(p),(p:BoundaryPoint)=>u(p)+v(p)-1]){const a=side(f.start),b=side(f.end);if(a*b<0){const t=a/(a-b);if(t>1e-10&&t<1-1e-10&&!cuts.some(c=>Math.abs(c-t)<1e-10))cuts.push(t);}}
    for(const c of [...connectionsByRegion[f.a],...(f.b<0?[]:connectionsByRegion[f.b])])for(const p of [c.start,c.end]){const t=onSegment(p,f.start,f.end);if(t!==undefined&&t>1e-10&&t<1-1e-10&&!cuts.some(c=>Math.abs(c-t)<1e-10))cuts.push(t);}
    cuts.sort((a,b)=>a-b);
    const at=(t:number)=>({x:f.start.x+(f.end.x-f.start.x)*t,z:f.start.z+(f.end.z-f.start.z)*t});
    return cuts.slice(1).map((t1,i)=>{const t0=cuts[i],start=at(t0),end=at(t1);return{a0:add(f.a,start),a1:add(f.a,end),b0:f.b<0?-1:add(f.b,start),b1:f.b<0?-1:add(f.b,end),t0,t1};});
  });
  const centers=mesh.regions.map((r,i)=>({...r.center,bed:cells.bedAt(i,r.center.x,r.center.z)}));
  for(let i=0;i<rings.length;i++){const center=centers[i];rings[i].sort((a,b)=>Math.atan2(nodes[a].z-center.z,nodes[a].x-center.x)-Math.atan2(nodes[b].z-center.z,nodes[b].x-center.x));}
  const patches:SurfaceTopology['patches']=[];let key=0;
  for(let i=0;i<mesh.regions.length;i++){const r=mesh.regions[i],x=water.origin.x+Math.floor(r.cell/water.rows)*water.cellSizeX,z=water.origin.z+r.cell%water.rows*water.cellSizeZ,center={x:x+water.cellSizeX*.5,z:z+water.cellSizeZ*.5};
    if(mesh.supportLayer!==undefined){
      // Native support cuts form T-junctions inside a parent cell. Fan from
      // the physical polygon's center so every shared face subdivision is
      // an actual rendered edge, including collinear midpoint vertices.
      const middle=add(i,r.center,false),ring=rings[i];
      for(let j=0;j<ring.length;j++){patches.push({region:i,nodes:[middle,ring[j],ring[(j+1)%ring.length]],key});key+=3;}
      continue;
    }
    for(let side=0;side<4;side++){const j=(side+1)%4,triangle=[center,{x:x+CORNER_X[side]*water.cellSizeX,z:z+CORNER_Z[side]*water.cellSizeZ},{x:x+CORNER_X[j]*water.cellSizeX,z:z+CORNER_Z[j]*water.cellSizeZ}],polygon=sectorPolygon(r.polygon,triangle),ids=polygon.map(p=>add(i,p,false)).filter((id,k,list)=>id!==list[(k+list.length-1)%list.length]);
      if(ids.length<3)continue;patches.push({region:i,nodes:ids,key});key+=(ids.length-2)*3;}}
  // A submerged basin has the original four visible water triangles. Keep
  // exact bed pieces only for clipping, storage, and the eligibility proof.
  const gridFans:SurfaceTopology['gridFans']=[];
  for(let cell=0;cell<mesh.cells.length;cell++){
    if(mesh.supportLayer!==undefined)continue;
    const members=mesh.cells[cell];if(members.length<2||members.some(i=>mesh.regions[i].solid))continue;
    const x=water.origin.x+Math.floor(cell/water.rows)*water.cellSizeX,z=water.origin.z+cell%water.rows*water.cellSizeZ;
    if(Math.abs(members.reduce((sum,i)=>sum+mesh.regions[i].area,0)-water.cellArea)>1e-10*Math.max(1,water.cellArea))continue;
    const controls=[...CORNER_X.map((dx,k)=>({x:x+dx*water.cellSizeX,z:z+CORNER_Z[k]*water.cellSizeZ})),{x:x+water.cellSizeX*.5,z:z+water.cellSizeZ*.5}],ids:number[]=[];
    for(const p of controls){const region=members.find(i=>{const polygon=mesh.regions[i].polygon;return polygon.every((a,k)=>{const b=polygon[(k+1)%polygon.length];return(b.x-a.x)*(p.z-a.z)-(b.z-a.z)*(p.x-a.x)>=-1e-10;});});if(region===undefined)break;ids.push(add(region,p,false));}
    if(ids.length===5){gridFans.push({cell,nodes:ids,key});key+=12;}
  }
  // Cache exact directional bed samples. The symmetric decomposition retains
  // the complete residual, including terrain cross terms, without letting a
  // downhill head gradient prolong water up a transverse bank.
  const exactBed=(cell:number,x:number,z:number)=>{const member=mesh.cells[cell].find(i=>mesh.regions[i].polygon.every((a,k,list)=>{const b=list[(k+1)%list.length];return(b.x-a.x)*(z-a.z)-(b.z-a.z)*(x-a.x)>=-1e-10;}));if(member===undefined)throw new Error('Missing terrain sample in surface cell.');return cells.bedAt(member,x,z);};
  const bedAxes=nodes.map(n=>{const cell=mesh.regions[n.region].cell,cx=water.origin.x+(Math.floor(cell/water.rows)+.5)*water.cellSizeX,cz=water.origin.z+(cell%water.rows+.5)*water.cellSizeZ;return[exactBed(cell,n.x,cz),exactBed(cell,cx,n.z),exactBed(cell,cx,cz)];});
  const result={nodes,rings,edges,centers,bedAxes,patches,gridFans};if(immutableMesh(mesh))cache.set(mesh,result);return result;
}

function copied(surface: WaterBodySurfaceBuffers, copy: boolean): WaterBodySurfaceBuffers {
  if (!copy) return surface;
  return { ...surface, cellIds: surface.cellIds.slice(), positions: surface.positions.slice(), normals: surface.normals.slice(),
    colors: surface.colors.slice(), uvs: surface.uvs.slice(), flowData: surface.flowData!.slice(), patches: surface.patches.slice(),
    boundary: { ...surface.boundary!, triangleRegions: surface.boundary!.triangleRegions.slice(), vertexKeys: surface.boundary!.vertexKeys.slice() },
    stats: { ...surface.stats } };
}

/** Placement refinement has no terrain reconstruction in open water. Reuse
 * the original renderer verbatim, retaining compact boundary packets for
 * callers that also need independent placement-side surface sampling. */
function placementGridSurface(water:WaterBodyManifest,state:WaterBodyState,options:WaterBodyStyle&{copy?:boolean},workspace:WaterBoundarySurfaceWorkspace):WaterBodySurfaceBuffers {
  const mesh=state.boundary!.mesh,start=performance.now();
  if(workspace.mesh!==mesh)workspace.regular=undefined;
  const b=state.boundary!,amount=b.volume.reduce((sum,v)=>sum+v,0),depth=mesh.cells.map(ids=>b.volume[ids[0]]/water.cellArea),flowX=mesh.cells.map(ids=>b.flowX[ids[0]]),flowZ=mesh.cells.map(ids=>b.flowZ[ids[0]]),solidDepth=b.solidDepth?mesh.cells.map(ids=>b.solidDepth![ids[0]]):state.solidDepth;
  const regular=buildWaterBodySurface({...water,boundaryCells:false},{...state,boundary:undefined,depth,flowX,flowZ,solidDepth},{...options,copy:false,workspace:workspace.regular??=new WaterBodySurfaceWorkspace()});
  const previous=workspace.surface;
  if(previous&&workspace.mesh===mesh&&!regular.cellIds.length){workspace.surface={...previous,revision:state.revision,time:state.time,baseRevision:previous.revision,cellIds:regular.cellIds,stats:{...previous.stats,gridVolume:amount,rebuiltCells:0,reusedCells:regular.stats.cells,buildMs:performance.now()-start}};return copied(workspace.surface,options.copy!==false);}
  const p=regular.positions,selected:number[]=[];
  for(let at=0;at<p.length;at+=9){const ax=p[at+3]-p[at],ay=p[at+4]-p[at+1],az=p[at+5]-p[at+2],bx=p[at+6]-p[at],by=p[at+7]-p[at+1],bz=p[at+8]-p[at+2];if(Math.hypot(ay*bz-az*by,az*bx-ax*bz,ax*by-ay*bx)>1e-12)selected.push(at/3);}
  const extract=(values:Float32Array,stride:number)=>{const result=new Float32Array(selected.length*3*stride);for(let k=0;k<selected.length;k++)result.set(values.subarray(selected[k]*stride,(selected[k]+3)*stride),k*3*stride);return result;};
  const keys=new Float64Array(selected.length*3),owners=new Uint32Array(selected.length);
  const safe=new Uint8Array(mesh.cells.length).fill(1);
  for(let cell=0;cell<safe.length;cell++){const x=Math.floor(cell/water.rows),z=cell%water.rows,patch=regular.patches.subarray(cell*12,(cell+1)*12);if((patch[11]&15)!==15)safe[cell]=0;for(let k=0;k<4;k++)if(patch[k+1]<=patch[k+6]+water.wetDepth)safe[cell]=0;if(state.barrierX[x*water.rows+z]||state.barrierX[(x+1)*water.rows+z]||state.barrierZ[x*(water.rows+1)+z]||state.barrierZ[x*(water.rows+1)+z+1])safe[cell]=0;}
  for(let k=0;k<selected.length;k++){const vertex=selected[k],cell=Math.floor(vertex/48);owners[k]=mesh.cells[cell][0];for(let j=0;j<3;j++)keys[k*3+j]=safe[cell]&&vertex%48<24&&regular.flowData![(vertex+j)*4+3]>water.wetDepth?vertex+j:-1;}
  workspace.mesh=mesh;
  workspace.surface={...regular,baseRevision:previous?.revision??-1,cellIds:Uint32Array.from({length:regular.stats.cells},(_,i)=>i),positions:extract(p,3),normals:extract(regular.normals,3),colors:extract(regular.colors,4),uvs:extract(regular.uvs,2),flowData:extract(regular.flowData!,4),patches:new Float32Array(),normalPatches:undefined,flowPatches:undefined,
    boundary:{meshRevision:mesh.revision,regionCount:mesh.regions.length,triangleRegions:owners,vertexKeys:keys},stats:{...regular.stats,vertices:selected.length*3,triangles:selected.length,buildMs:performance.now()-start}};
  return copied(workspace.surface,options.copy!==false);
}

/** Preserve basin volume while placing an inferred slope over its exact bed.
 * Work relative to the old head, so large world heights do not cancel a film.
 * Fully submerged transformed beds need only the analytic area/mean formula. */
function affineBasinCenter(water:WaterBodyManifest,mesh:WaterBoundaryMesh,members:number[],head:number,volume:number,sx:number,sz:number,cells:ReturnType<typeof waterBodyCells>):number {
  if(sx===0&&sz===0)return head;
  const cell=mesh.regions[members[0]].cell,cx=water.origin.x+(Math.floor(cell/water.rows)+.5)*water.cellSizeX,cz=water.origin.z+(cell%water.rows+.5)*water.cellSizeZ;
  let area=0,moment=0,low=Infinity,high=-Infinity;
  for(const i of members){const r=mesh.regions[i];area+=r.area;moment+=r.area*((cells.bedAt(i,r.center.x,r.center.z)-head)-sx*(r.center.x-cx)-sz*(r.center.z-cz));for(const p of r.polygon){const bed=(p.bed-head)-sx*(p.x-cx)-sz*(p.z-cz);low=Math.min(low,bed);high=Math.max(high,bed);}}
  const full=(volume+moment)/area;if(full>=high)return head+full;
  // Use the same stable piecewise-cubic triangle integral as exact storage,
  // but collect volume and derivative together. Avoid constructing and
  // freezing a temporary mesh on every changing shoreline frame.
  const pieces:number[]=[],shift=(p:BoundaryPoint)=>(p.bed-head)-sx*(p.x-cx)-sz*(p.z-cz);
  for(const i of members){const polygon=mesh.regions[i].polygon,a=polygon[0],ha=shift(a);for(let k=1;k+1<polygon.length;k++){
    const b=polygon[k],c=polygon[k+1],part=Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))*.5,hb=shift(b),hc=shift(c);
    const lo=Math.min(ha,hb,hc),hi=Math.max(ha,hb,hc),middle=ha<=hb?hb<=hc?hb:Math.max(ha,hc):ha<=hc?ha:Math.max(hb,hc);pieces.push(part,lo,middle,hi);
  }}
  let upper=high+volume/area,value=Math.max(low,Math.min(upper,full));
  for(let k=0;k<40;k++){let total=0,wetArea=0;for(let i=0;i<pieces.length;i+=4){const part=pieces[i],lo=pieces[i+1],middle=pieces[i+2],hi=pieces[i+3];if(value<=lo)continue;if(value>=hi){total+=part*((value-lo)-((middle-lo)+(hi-lo))/3);wetArea+=part;continue;}
      const span=hi-lo;if(value<middle){const depth=value-lo,wet=part*(depth/(middle-lo))*(depth/span);total+=wet*depth/3;wetArea+=wet;}else{const a=middle-lo,u=value-middle,b=hi-middle;total+=part*((a/span)*(a/3+u)+(u/span)*u*(1-u/(3*b)));wetArea+=part*(a/span+(u/span)*(2-u/b));}}
    const error=total-volume;if(Math.abs(error)<=Math.max(volume*2e-13,Number.MIN_VALUE*2))return head+value;
    if(error<0)low=value;else upper=value;let next=wetArea>0?value-error/wetArea:NaN;if(!(next>low&&next<upper))next=low+(upper-low)*.5;if(next===value||next===low||next===upper)break;value=next;}
  return head+value;
}

/** One connected physical basin has one storage head. A trace in an uphill
 * fragment must not gain an entire fragment's area weight in that head. */
function basinStorageHead(cells:ReturnType<typeof waterBodyCells>,members:number[],volume:number):number {
  const storage=createWaterRegionStorage(cells,members);
  if(volume>=storage.full)return storage.high+(volume-storage.full)/storage.area;
  let low=storage.low,high=Infinity;for(const i of members)high=Math.min(high,cells.levelAtVolume(i,volume));
  let head=high;
  for(let k=0;k<48;k++){const sample=storage.evaluate(head),error=sample.volume-volume;if(Math.abs(error)<=Math.max(volume*2e-13,Number.MIN_VALUE*2))return head;
    if(error<0)low=head;else high=head;let next=sample.area>0?head-error/sample.area:NaN;if(!(next>low&&next<high))next=low+(high-low)*.5;if(next===head||next===low||next===high)break;head=next;}
  return head;
}

/** Original-resolution water controls. Exact terrain pieces contribute storage
 * within a connected basin; they do not become independent visible pyramids. */
function baseSurfaceField(water:WaterBodyManifest,mesh:WaterBoundaryMesh,heads:number[],flowX:number[],flowZ:number[],visible:boolean[],faces:ReturnType<ReturnType<typeof waterBodyCells>['faces']>,cells:ReturnType<typeof waterBodyCells>,ordinary?:Uint8Array,placementOnly=false){
  const count=mesh.regions.length,parent=Int32Array.from({length:count},(_,i)=>i),partitions=waterBodyTerrainPartitions(cells,faces),pinned=partitions.pinned.slice(),partitionCounts=new Uint16Array(mesh.cells.length);
  for(const cell of partitions.cell)partitionCounts[cell]++;
  for(let i=0;i<count;i++)if(cells.solidDepth[i]>0)pinned[mesh.regions[i].cell]=1;
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(a:number,b:number)=>{a=root(a);b=root(b);if(a!==b)parent[Math.max(a,b)]=Math.min(a,b);};
  // An ordinary hydraulic cell has one original center head. Its exact bed
  // pieces are display geometry, including under a moving volumetric body.
  if(ordinary)for(let i=0;i<count;i++)if(ordinary[i])join(mesh.cells[mesh.regions[i].cell][0],i);
  // Dry uphill pieces belong to the same original control volume. Omitting
  // them biases corner weights and leaves holes in a thin sloping sheet.
  if(!placementOnly)for(let k=0;k<partitions.groups.length;k++)if(!pinned[partitions.cell[k]]){const group=partitions.groups[k];for(let j=1;j<group.length;j++)join(group[0],group[j]);}
  if(!placementOnly)for(const f of faces)if(f.b>=0&&mesh.regions[f.a].cell===mesh.regions[f.b].cell&&visible[f.a]&&visible[f.b]&&Math.min(heads[f.a],heads[f.b])>Math.max(Math.min(f.start.bed,f.end.bed),f.barrier?.top??-Infinity)+water.wetDepth)join(f.a,f.b);
  const area=new Float64Array(count),headWeight=new Float64Array(count),height=new Float64Array(count),u=new Float64Array(count),v=new Float64Array(count),volume=new Float64Array(count),wet=new Uint8Array(count),basinSafe=new Uint8Array(count).fill(1),neighbors:number[][]=Array.from({length:count},()=>[]),members:number[][]=Array.from({length:count},()=>[]);
  for(let i=0;i<count;i++){parent[i]=root(i);const group=parent[i],r=mesh.regions[i],amount=cells.volume(i);members[group].push(i);area[group]+=r.area;volume[group]+=amount;
    if(visible[i])wet[group]=1;
    if(amount>0){headWeight[group]+=r.area;height[group]+=r.area*heads[i];u[group]+=amount*flowX[i];v[group]+=amount*flowZ[i];}}
  for(let i=0;i<count;i++)if(volume[i]>0){height[i]=!ordinary?.[i]&&members[i].length>1?basinStorageHead(cells,members[i],volume[i]):height[i]/headWeight[i];u[i]/=volume[i];v[i]/=volume[i];}
  for(const f of faces){const a=parent[f.a],b=f.b<0?-1:parent[f.b];if(a===b)continue;
    // A shallow downstream sheet need not submerge its uphill edge to receive
    // flow. A real wall still requires both surfaces above its crest; actual
    // dry terrain crests with both heads below remain separate.
    const stepped=b>=0&&(Math.abs(f.bedA0-f.bedB0)>1e-10*Math.max(1,Math.abs(f.bedA0),Math.abs(f.bedB0))||Math.abs(f.bedA1-f.bedB1)>1e-10*Math.max(1,Math.abs(f.bedA1),Math.abs(f.bedB1)));
    const crest=Math.max(Math.min(f.start.bed,f.end.bed),f.barrier?.top??-Infinity);
    const open=b>=0&&wet[a]&&wet[b]&&(placementOnly&&mesh.supportLayer===undefined&&!f.barrier|| (f.barrier||stepped?Math.min(height[a],height[b]):Math.max(height[a],height[b]))>crest+water.wetDepth);
    if(open){if(!neighbors[a].includes(b)){neighbors[a].push(b);neighbors[b].push(a);}}
    else{basinSafe[a]=0;if(b>=0)basinSafe[b]=0;}}
  const corrected=height.slice(),bedCenter=new Float64Array(count),coupling=new Float64Array(count*2),couplingKnown=new Uint8Array(count*2),bedGradient=new Float64Array(count*2);
  for(let i=0;i<count;i++)if(wet[i])bedCenter[i]=height[i]-volume[i]/area[i];
  // Well-balanced prolongation of ordinary depth over unresolved bed bends.
  // A constant lake has d(head)=0; a constant-depth sheet has d(head)=d(bed).
  // Only signed, connected wet samples contribute, never opposite wall heads.
  if(ordinary&&!placementOnly)for(let i=0;i<count;i++)if(wet[i]&&ordinary[i]&&!pinned[mesh.regions[i].cell]){
    const numerator=[0,0],denominator=[0,0],gradient=[0,0],samples=[0,0],cell=mesh.regions[i].cell;
    for(const j of neighbors[i])if(ordinary[j]&&!pinned[mesh.regions[j].cell]){const db=bedCenter[j]-bedCenter[i],dh=height[j]-height[i],axis=Math.floor(mesh.regions[j].cell/water.rows)!==Math.floor(cell/water.rows)?0:1;
      // A reconstructed flat axis can differ by a few ULPs. Dividing two
      // such residuals invents full terrain coupling up an unrelated bank.
      if(Math.abs(db)<=64*Number.EPSILON*Math.max(1,Math.abs(bedCenter[i]),Math.abs(bedCenter[j])))continue;
      numerator[axis]+=db*dh;denominator[axis]+=db*db;const delta=axis===0?(Math.floor(mesh.regions[j].cell/water.rows)-Math.floor(cell/water.rows))*water.cellSizeX:(mesh.regions[j].cell%water.rows-cell%water.rows)*water.cellSizeZ;gradient[axis]+=db/delta;samples[axis]++;}
    for(let axis=0;axis<2;axis++){bedGradient[i*2+axis]=samples[axis]?gradient[axis]/samples[axis]:0;if(denominator[axis]>0){coupling[i*2+axis]=Math.max(0,Math.min(1,numerator[axis]/denominator[axis]));couplingKnown[i*2+axis]=1;}}
  }
  if(!placementOnly)for(let i=0;i<count;i++)if(wet[i]){const cell=mesh.regions[i].cell;if(pinned[cell]||partitionCounts[cell]!==1)continue;
    if(ordinary?.[i])continue;
    const x=Math.floor(cell/water.rows),z=cell%water.rows;let left=0,right=0,near=0,far=0,ln=0,rn=0,nn=0,fn=0;
    for(const j of neighbors[i]){const other=mesh.regions[j].cell,dx=Math.floor(other/water.rows)-x,dz=other%water.rows-z;if(dx<0){left+=height[j];ln++;}if(dx>0){right+=height[j];rn++;}if(dz<0){near+=height[j];nn++;}if(dz>0){far+=height[j];fn++;}}
    const sx=ln&&rn?(right/rn-left/ln)/(2*water.cellSizeX):rn?(right/rn-height[i])/water.cellSizeX:ln?(height[i]-left/ln)/water.cellSizeX:0,sz=nn&&fn?(far/fn-near/nn)/(2*water.cellSizeZ):fn?(far/fn-height[i])/water.cellSizeZ:nn?(height[i]-near/nn)/water.cellSizeZ:0;
    corrected[i]=affineBasinCenter(water,mesh,members[i],height[i],volume[i],sx,sz,cells);
  }
  // A corner uses only the connected wet neighborhood in its four original
  // cells. Closed walls and dry crests never join otherwise separate basins.
  const field=new Float64Array(count*30),bedField=new Float64Array(count*5),cornerGroups:number[][]=Array(count*4),corners=new Map<string,Float64Array>();
  for(let source=0;source<count;source++)if(wet[source]){
    const cell=mesh.regions[source].cell,cx=Math.floor(cell/water.rows),cz=cell%water.rows;
    for(let k=0;k<4;k++){
      const x=cx+CORNER_X[k],z=cz+CORNER_Z[k],reached=[source];
      const touches=(i:number)=>!placementOnly||mesh.regions[i].polygon.every((a,k,list)=>{const b=list[(k+1)%list.length],px=water.origin.x+x*water.cellSizeX,pz=water.origin.z+z*water.cellSizeZ;return(b.x-a.x)*(pz-a.z)-(b.z-a.z)*(px-a.x)>=-1e-10;});
      if(touches(source))for(let at=0;at<reached.length;at++)for(const next of neighbors[reached[at]]){const cell=mesh.regions[next].cell,nx=Math.floor(cell/water.rows),nz=cell%water.rows;if(nx>=x-1&&nx<=x&&nz>=z-1&&nz<=z&&!reached.includes(next)&&touches(next)&&(!placementOnly||mesh.regions[reached[at]].cell!==cell))reached.push(next);}
      reached.sort((a,b)=>a-b);const key=`${x},${z}:${reached.join(',')}`;let corner=corners.get(key);
      if(!corner){let weight=0,h=0,bed=0,fx=0,fz=0,left=0,right=0,near=0,far=0,lw=0,rw=0,nw=0,fw=0;
        for(const i of reached){const a=area[i],cell=mesh.regions[i].cell,level=corrected[i];weight+=a;h+=a*level;bed+=a*bedCenter[i];fx+=a*u[i];fz+=a*v[i];if(Math.floor(cell/water.rows)<x){left+=a*level;lw+=a;}else{right+=a*level;rw+=a;}if(cell%water.rows<z){near+=a*level;nw+=a;}else{far+=a*level;fw+=a;}}
        const sx=lw&&rw?(right/rw-left/lw)/water.cellSizeX:0,sz=nw&&fw?(far/fw-near/nw)/water.cellSizeZ:0,length=Math.hypot(sx,1,sz);corner=Float64Array.of(h/weight,-sx/length,1/length,-sz/length,fx/weight,fz/weight,bed/weight);corners.set(key,corner);}
      field.set(corner.subarray(0,6),source*30+k*6);bedField[source*5+k]=corner[6];cornerGroups[source*4+k]=reached;
    }
    const at=source*30+24;field[at]=corrected[source];field[at+4]=u[source];field[at+5]=v[source];bedField[source*5+4]=bedCenter[source];let nx=0,ny=0,nz=0;for(let k=0;k<4;k++){nx+=field[source*30+k*6+1];ny+=field[source*30+k*6+2];nz+=field[source*30+k*6+3];}const length=Math.hypot(nx,ny,nz);field[at+1]=nx/length;field[at+2]=ny/length;field[at+3]=nz/length;
  }
  return{parent,neighbors,height,volume,field,bedField,coupling,couplingKnown,bedGradient,cornerGroups,area,depth:Float64Array.from(volume,(v,i)=>area[i]>0?v/area[i]:0),safe:basinSafe,pinned,visible:mesh.regions.map((r,i)=>!!wet[parent[i]]&&(!r.solid||heads[i]>r.solid.top))};
}

export function buildWaterBoundarySurface(water: WaterBodyManifest, state: WaterBodyState,
  options: WaterBodyStyle & { copy?: boolean;connections?:WaterSurfaceConnections } = {}, workspace = new WaterBoundarySurfaceWorkspace()): WaterBodySurfaceBuffers {
  const started = performance.now();let boundary = state.boundary;
  if (!boundary) throw new Error('Boundary surface requires authoritative boundary regions.');
  let { mesh, volume, flowX, flowZ } = boundary,count = mesh.regions.length;
  const cells = water.columns * water.rows,sourceMesh=mesh,sourceVolume=volume,sourceFlowX=flowX,sourceFlowZ=flowZ,sourceCount=count;
  const placementOnly=mesh.placementOnly===true;
  if(placementOnly&&placementGridMesh(water,state,mesh))return placementGridSurface(water,state,options,workspace);
  // A mutable packet can leave and re-enter the canonical shape under the
  // same identity. Do not reuse a regular frame across the intervening path.
  workspace.regular=undefined;
  let solidDepth = boundary.solidDepth ?? Array(count).fill(0);const sourceSolidDepth=solidDepth;
  if (volume.length !== count || flowX.length !== count || flowZ.length !== count
    || volume.some(value => !Number.isFinite(value) || value < 0)
    || flowX.some(value => !Number.isFinite(value)) || flowZ.some(value => !Number.isFinite(value))
    || solidDepth.length !== count || solidDepth.some(value => !Number.isFinite(value) || value < 0))
    throw new Error('Invalid boundary surface state.');
  const shallow = options.shallowDepth ?? .15, edgeOpacity = options.edgeOpacity ?? 0;
  if (!Number.isFinite(shallow) || shallow < .001 || shallow > 20 || !Number.isFinite(edgeOpacity) || edgeOpacity < 0 || edgeOpacity > 1
    || (options.sides !== undefined && typeof options.sides !== 'boolean')) throw new Error('Invalid boundary surface style.');
  for (const [value, maximum] of [[options.heightTolerance, .002], [options.flowTolerance, .1]] as const)
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > maximum)) throw new Error('Invalid boundary surface tolerance.');
  const heightTolerance=options.heightTolerance??.0005,flowTolerance=options.flowTolerance??.01;
  const style = JSON.stringify([water.revision, water.wetDepth, options.color, options.shallowColor, options.foamColor, shallow, edgeOpacity, options.sides,heightTolerance,flowTolerance,options.connections?.revision]);
  const barriers=JSON.stringify([state.barrierX,state.barrierZ]);
  // Revision labels are untrusted metadata. Decoded meshes can retain them
  // while replacing geometry; mutable nested polygons can change in place.
  // Flat hydraulic storage alone does not prove flat display geometry.
  const tolerant=canonicalFlatMesh(water,mesh)&&(!mesh.surface||canonicalFlatMesh(water,mesh.surface.mesh));
  const unchanged = workspace.mesh === mesh && immutableMesh(mesh) && workspace.style === style && workspace.barriers===barriers
    && workspace.connectionSegments===options.connections?.segments&&workspace.connectionValues===options.connections?.values
    &&(!options.connections||immutableMesh(options.connections.values)&&immutableMesh(options.connections.segments))
    && workspace.volume.length === count && volume.every((value,i)=>tolerant
      ?(value>0)===(workspace.volume[i]>0)&&(value/mesh.regions[i].area>water.wetDepth)===(workspace.volume[i]/mesh.regions[i].area>water.wetDepth)
        &&Math.abs(value-workspace.volume[i])/mesh.regions[i].area<=heightTolerance
      :value===workspace.volume[i])
    && solidDepth.every((value,i)=>tolerant?Math.abs(value-workspace.solidDepth[i])<=heightTolerance:value===workspace.solidDepth[i])
    && flowX.every((value,i)=>tolerant?Math.abs(value-workspace.flowX[i])<=flowTolerance:value===workspace.flowX[i])
    && flowZ.every((value,i)=>tolerant?Math.abs(value-workspace.flowZ[i])<=flowTolerance:value===workspace.flowZ[i]);
  const baseRevision = workspace.surface?.revision ?? -1;
  if (unchanged && workspace.surface) {
    const old = workspace.surface;
    workspace.surface = { ...old, revision: state.revision, time: state.time, baseRevision, cellIds: new Uint32Array(),
      stats: { ...old.stats, gridVolume:volume.reduce((sum,v)=>sum+v,0),rebuiltCells: 0, reusedCells: cells, buildMs: performance.now() - started } };
    return copied(workspace.surface, options.copy !== false);
  }
  let mappedHeads:number[]|undefined,ordinary:Uint8Array|undefined,owners:number[]|undefined;
  if(mesh.surface){
    const exact=mesh.surface.mesh;owners=mesh.surface.owners;
    const active=waterBodyCells(water,state),activeHeads=sourceVolume.map((_,i)=>active.level(i));
    ordinary=Uint8Array.from(owners,i=>sourceMesh.regions[i].bulk?1:0);
    mappedHeads=owners.map(i=>activeHeads[i]);
    // These display weights are never physical storage. All pieces belonging
    // to an ordinary owner read its original center head and velocity; only
    // exact cut owners retain the inverse-volume reconstruction below.
    volume=owners.map((i,j)=>sourceMesh.regions[i].bulk?sourceVolume[i]*exact.regions[j].area/sourceMesh.regions[i].area:sourceVolume[i]);
    flowX=owners.map(i=>sourceFlowX[i]);flowZ=owners.map(i=>sourceFlowZ[i]);solidDepth=owners.map(i=>sourceSolidDepth[i]);
    mesh=exact;count=mesh.regions.length;
    boundary={...boundary,mesh,volume,flowX,flowZ,solidDepth};state={...state,boundary};
  }
  const color = new Color(options.color ?? '#258b9f'), shallowColor = new Color(options.shallowColor ?? '#65b9ba'),foamColor=new Color(options.foamColor??'#e5f7f3');
  let storage=workspace.storage??=surfaceStorage(1536),{positions,normals,colors,uvs,flows,regions:triangleRegions,keys:vertexKeys}=storage,vertices=0,triangles=0;
  function reserve(){if(vertices+3<=storage.capacity)return;const next=surfaceStorage(Math.min(MAX_VERTICES,storage.capacity*2));next.positions.set(positions.subarray(0,vertices*3));next.normals.set(normals.subarray(0,vertices*3));next.colors.set(colors.subarray(0,vertices*4));next.uvs.set(uvs.subarray(0,vertices*2));next.flows.set(flows.subarray(0,vertices*4));next.keys.set(vertexKeys.subarray(0,vertices));next.regions.set(triangleRegions.subarray(0,triangles));storage=workspace.storage=next;({positions,normals,colors,uvs,flows,regions:triangleRegions,keys:vertexKeys}=next);}
  const heads = mappedHeads??volume.map((amount, i) => boundaryRegionLevel(mesh.regions[i], amount + solidDepth[i] * mesh.regions[i].area));
  const cellsAccess=waterBodyCells(water,state),faces=cellsAccess.faces(),topology=surfaceTopology(water,state,options.connections),{nodes,rings,edges,centers}=topology;
  // Ordinary cells use the same visible-depth threshold as the original
  // renderer. A microscopic bank residual has a high center-bed head, but
  // must not paint a deep downhill wedge or raise a wet neighbour's corners.
  // Exact cut basins still use actual maximum depth, including narrow pools.
  const visible=mesh.regions.map((r,i)=>volume[i]>0&&(ordinary?.[i]?volume[i]/r.area:heads[i]-r.bedMin)>water.wetDepth&&(!r.solid||heads[i]>r.solid.top));
  const controls=baseSurfaceField(water,mesh,heads,flowX,flowZ,visible,faces,cellsAccess,ordinary,placementOnly);
  for(let i=0;i<count;i++)visible[i]=controls.visible[i];
  const emptyPoint:SurfacePoint={x:0,z:0,y:0,bed:0,nx:0,ny:1,nz:0,u:0,v:0,key:-1};
  const points:SurfacePoint[]=nodes.map((n,i)=>{if(!visible[n.region])return emptyPoint;const group=controls.parent[n.region],a=group*30+n.sector*6,b=group*30+((n.sector+1)%4)*6,c=group*30+24,field=controls.field;
    const value=(axis:number)=>field[a+axis]*n.wa+field[b+axis]*n.wb+field[c+axis]*n.wc,nx=value(1),ny=value(2),nz=value(3),length=Math.hypot(nx,ny,nz);
    const cell=mesh.regions[n.region].cell,x=Math.floor(cell/water.rows),z=cell%water.rows,bedVertices=state.bedVertices??water.bedVertices,next=(n.sector+1)%4;
    // Terrain alone retains the original fan. Declared placement supports
    // (treads, slabs, counters) have exact region planes, never a center-bed
    // ramp through their physical horizontal surfaces.
    const bed=placementOnly&&mesh.supportLayer===undefined?bedVertices[(x+CORNER_X[n.sector])*(water.rows+1)+z+CORNER_Z[n.sector]]*n.wa+bedVertices[(x+CORNER_X[next])*(water.rows+1)+z+CORNER_Z[next]]*n.wb+(state.bed??water.bed)[cell]*n.wc:n.bed;
    return{x:n.x,z:n.z,bed:Math.max(bed,mesh.regions[n.region].solid?.top??-Infinity),y:value(0),nx:nx/length,ny:ny/length,nz:nz/length,u:value(4),v:value(5),key:controls.safe[group]?i:-1};});
  const prolonged=new Uint8Array(cells);
  if(!placementOnly){
  const terrainSensitive=new Uint8Array(count),couplingField=new Float64Array(count*10);
  const bedAtNode=(n:SurfaceTopology['nodes'][number],group:number)=>controls.bedField[group*5+n.sector]*n.wa+controls.bedField[group*5+(n.sector+1)%4]*n.wb+controls.bedField[group*5+4]*n.wc;
  for(const n of nodes)if(visible[n.region]&&ordinary?.[n.region]){const group=controls.parent[n.region];if(Math.abs(n.bed-bedAtNode(n,group))>controls.depth[group])terrainSensitive[group]=1;}
  for(let group=0;group<count;group++)if(controls.cornerGroups[group*4])for(let axis=0;axis<2;axis++){
    couplingField[group*10+8+axis]=terrainSensitive[group]?controls.coupling[group*2+axis]:0;
    for(let k=0;k<4;k++){const reached=controls.cornerGroups[group*4+k];if(!reached.some(i=>terrainSensitive[i])||reached.some(i=>!ordinary?.[i]||controls.pinned[mesh.regions[i].cell]))continue;
      let weight=0,value=0;for(const i of reached)if(controls.couplingKnown[i*2+axis]){weight+=controls.area[i];value+=controls.area[i]*controls.coupling[i*2+axis];}if(weight)couplingField[group*10+k*2+axis]=value/weight;}
  }
  for(let i=0;i<nodes.length;i++){const n=nodes[i];if(!visible[n.region]||!ordinary?.[n.region])continue;const group=controls.parent[n.region],next=(n.sector+1)%4,lambda=(axis:number)=>couplingField[group*10+n.sector*2+axis]*n.wa+couplingField[group*10+next*2+axis]*n.wb+couplingField[group*10+8+axis]*n.wc,lx=lambda(0),lz=lambda(1);
    if(lx>0||lz>0){const cell=mesh.regions[n.region].cell,cx=water.origin.x+(Math.floor(cell/water.rows)+.5)*water.cellSizeX,cz=water.origin.z+(cell%water.rows+.5)*water.cellSizeZ,bed=bedAtNode(n,group),exact=topology.bedAxes[i],gx=controls.bedGradient[group*2],gz=controls.bedGradient[group*2+1],linearX=gx*(n.x-cx),linearZ=gz*(n.z-cz),fanResidual=bed-controls.bedField[group*5+4]-linearX-linearZ,gradientWeight=gx*gx+gz*gz,wx=gradientWeight?gx*gx/gradientWeight:.5,rx=((n.bed-exact[1])+(exact[0]-exact[2]))*.5-linearX-wx*fanResidual,rz=n.bed-bed-rx;
      points[i].y+=lx*rx+lz*rz;prolonged[cell]=1;points[i].key=-1;}}
  const shoreCandidate=new Uint8Array(count);
  for(let i=0;i<nodes.length;i++){const n=nodes[i],group=controls.parent[n.region];if(visible[n.region]&&ordinary?.[n.region]&&!controls.pinned[mesh.regions[n.region].cell]&&points[i].y<=n.bed){
    const head=controls.height[group],sameHead=controls.neighbors[group].every(j=>Math.abs(controls.height[j]-head)<=64*Number.EPSILON*Math.max(1,Math.abs(head),Math.abs(controls.height[j])));if(!sameHead)shoreCandidate[group]=1;}}
  if(prolonged.some(value=>value!==0)||shoreCandidate.some(value=>value!==0)){
  // Directional reconstructions share one value along open original-cell
  // interfaces. Pair the exact face nodes; walls and steps remain separate.
  const joined=Int32Array.from({length:nodes.length},(_,i)=>i),find=(i:number):number=>{while(joined[i]!==i){joined[i]=joined[joined[i]];i=joined[i];}return i;},join=(a:number,b:number)=>{a=find(a);b=find(b);if(a!==b)joined[Math.max(a,b)]=Math.min(a,b);};
  for(let k=0;k<faces.length;k++){const f=faces[k];if(f.b<0||f.barrier||!ordinary?.[f.a]||!ordinary?.[f.b]||!visible[f.a]||!visible[f.b])continue;
    const a=controls.parent[f.a],b=controls.parent[f.b];if(a!==b&&!controls.neighbors[a].includes(b))continue;
    if(Math.abs(f.bedA0-f.bedB0)>1e-10||Math.abs(f.bedA1-f.bedB1)>1e-10)continue;
    for(const e of edges[k]){join(e.a0,e.b0);join(e.a1,e.b1);}}
  const joinedHeight=new Float64Array(nodes.length),joinedCount=new Uint16Array(nodes.length);
  for(let i=0;i<nodes.length;i++)if(visible[nodes[i].region]){const root=find(i);joinedHeight[root]+=points[i].y;joinedCount[root]++;}
  for(let i=0;i<nodes.length;i++)if(visible[nodes[i].region]){const root=find(i);if(joinedCount[root]>1)points[i].y=joinedHeight[root]/joinedCount[root];}
  // A partly wet ordinary cell stores mean depth over its center bed. Its
  // interpolated head can otherwise paint a large downhill wedge from only a
  // trace of liquid. Lower its reconstructed head until its clipped capacity matches physical
  // liquid volume; this contracts the shoreline instead of coating its old
  // extent with an ever-thinner film. Shared vertices take the largest drop,
  // preserving continuity and never increasing a neighbor's volume. A
  // common-head lake keeps its horizontal equilibrium surface; cut basins and
  // solid displacement retain their separate exact storage reconstruction.
  const shorePieces:number[][]=Array(count),headDrop=new Float64Array(count);
  for(const patch of topology.patches){const group=controls.parent[patch.region];if(!visible[patch.region]||!shoreCandidate[group])continue;const a=points[patch.nodes[0]],pieces=shorePieces[group]??=[];
    for(let k=1;k+1<patch.nodes.length;k++){const b=points[patch.nodes[k]],c=points[patch.nodes[k+1]],area=Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))*.5;if(area<=1e-14)continue;const da=a.y-a.bed,db=b.y-b.bed,dc=c.y-c.bed,lo=Math.min(da,db,dc),hi=Math.max(da,db,dc),middle=da<=db?db<=dc?db:Math.max(da,dc):da<=dc?da:Math.max(db,dc);pieces.push(area,lo,middle,hi);}}
  for(let group=0;group<count;group++){const pieces=shorePieces[group];if(!pieces)continue;const target=controls.volume[group];let low=0,high=0,drop=0;
    for(let k=3;k<pieces.length;k+=4)high=Math.max(high,pieces[k]);
    for(let pass=0;pass<40;pass++){let volume=0,wetArea=0;for(let k=0;k<pieces.length;k+=4){const area=pieces[k],lo=pieces[k+1],mid=pieces[k+2],hi=pieces[k+3];if(drop>=hi)continue;if(drop<=lo){volume+=area*((lo-drop)+(mid-drop)+(hi-drop))/3;wetArea+=area;}else if(drop>=mid){const d=hi-drop,fraction=(d/(hi-lo))*(d/(hi-mid));volume+=area*fraction*d/3;wetArea+=area*fraction;}else{const d=drop-lo,fraction=(d/(mid-lo))*(d/(hi-lo));volume+=area*((lo-drop)+(mid-drop)+(hi-drop)+fraction*d)/3;wetArea+=area*(1-fraction);}}
      const error=volume-target;if(pass===0&&error<=0)break;if(Math.abs(error)<=Math.max(target*2e-13,Number.MIN_VALUE*2)){headDrop[group]=drop;break;}if(error>0)low=drop;else high=drop;let next=wetArea>0?drop+error/wetArea:NaN;if(!(next>low&&next<high))next=low+(high-low)*.5;headDrop[group]=next;if(next===drop||next===low||next===high)break;drop=next;}}
  const vertexDrop=new Float64Array(nodes.length);
  for(let i=0;i<nodes.length;i++)if(visible[nodes[i].region]){const root=find(i);vertexDrop[root]=Math.max(vertexDrop[root],headDrop[controls.parent[nodes[i].region]]);}
  for(let i=0;i<nodes.length;i++)if(visible[nodes[i].region]){const drop=vertexDrop[find(i)];if(drop>0){points[i].y-=drop;points[i].key=-1;prolonged[mesh.regions[nodes[i].region].cell]=1;}}
  // Prolongated heights follow the clipped terrain, but lighting retains the
  // connected original-resolution water field. Area-weighted gradients avoid
  // turning every terrain triangulation edge into a separate specular facet.
  const slopeX=new Float64Array(count),slopeZ=new Float64Array(count),slopeArea=new Float64Array(count),smoothNormals=new Float64Array(count*15);
  for(const patch of topology.patches){const i=patch.region;if(!visible[i]||!ordinary?.[i]||!prolonged[mesh.regions[i].cell])continue;const group=controls.parent[i],a=points[patch.nodes[0]];
    for(let k=1;k+1<patch.nodes.length;k++){const b=points[patch.nodes[k]],c=points[patch.nodes[k+1]],dx=b.x-a.x,dz=b.z-a.z,ex=c.x-a.x,ez=c.z-a.z,det=dx*ez-dz*ex;if(Math.abs(det)<1e-14)continue;
      const area=Math.abs(det)*.5;slopeX[group]+=area*((b.y-a.y)*ez-(c.y-a.y)*dz)/det;slopeZ[group]+=area*(dx*(c.y-a.y)-ex*(b.y-a.y))/det;slopeArea[group]+=area;}}
  for(let group=0;group<count;group++)if(controls.cornerGroups[group*4]){
    const at=group*30+24;if(slopeArea[group]){slopeX[group]/=slopeArea[group];slopeZ[group]/=slopeArea[group];}else{slopeX[group]=-controls.field[at+1]/controls.field[at+2];slopeZ[group]=-controls.field[at+3]/controls.field[at+2];}}
  for(let group=0;group<count;group++)if(controls.cornerGroups[group*4])for(let k=0;k<5;k++){
    const reached=k===4?[group]:controls.cornerGroups[group*4+k];let sx=0,sz=0,weight=0;for(const j of reached){const a=controls.area[j];sx+=a*slopeX[j];sz+=a*slopeZ[j];weight+=a;}sx/=weight;sz/=weight;const length=Math.hypot(sx,1,sz),at=group*15+k*3;smoothNormals[at]=-sx/length;smoothNormals[at+1]=1/length;smoothNormals[at+2]=-sz/length;}
  for(let i=0;i<nodes.length;i++){const n=nodes[i];if(!visible[n.region]||!ordinary?.[n.region])continue;const group=controls.parent[n.region];if(!prolonged[mesh.regions[n.region].cell]&&![0,1,2,3].some(k=>controls.cornerGroups[group*4+k]?.some(j=>prolonged[mesh.regions[j].cell])))continue;
    const a=group*15+n.sector*3,b=group*15+(n.sector+1)%4*3,c=group*15+12,value=(k:number)=>smoothNormals[a+k]*n.wa+smoothNormals[b+k]*n.wb+smoothNormals[c+k]*n.wc,nx=value(0),ny=value(1),nz=value(2),length=Math.hypot(nx,ny,nz);points[i].nx=nx/length;points[i].ny=ny/length;points[i].nz=nz/length;}
  }
  }
  const connectionValues=mesh.regions.map(()=>[] as {segment:WaterSurfaceConnection;value:{start:WaterSurfaceConnectionValue;end:WaterSurfaceConnectionValue}}[]);
  for(let i=0;i<(options.connections?.segments.length??0);i++){const value=options.connections!.values[i],segment=options.connections!.segments[i];if(value)connectionValues[segment.region].push({segment,value});}
  if(mesh.supportLayer!==undefined){
    // Exact support cuts can meet inside a parent square. Their conservative
    // physical heads differ during flow, but the visible open border needs
    // one height/normal, just as an ordinary grid shares corner samples.
    // Join only wet openings: retaining walls and unsubmerged step crests
    // continue to carry independent visible heads.
    const pinned=new Uint8Array(nodes.length);
    for(let i=0;i<nodes.length;i++){const p=points[i];if(!visible[nodes[i].region])continue;
      for(const {segment,value} of connectionValues[nodes[i].region]){const t=onSegment(p,segment.start,segment.end);if(t===undefined)continue;const mix=(key:keyof WaterSurfaceConnectionValue)=>value.start[key]+(value.end[key]-value.start[key])*t;
        p.y=mix('height');p.nx=mix('nx');p.ny=mix('ny');p.nz=mix('nz');const length=Math.hypot(p.nx,p.ny,p.nz);p.nx/=length;p.ny/=length;p.nz/=length;p.u=mix('u');p.v=mix('v');p.key=-1;pinned[i]=1;break;}}
    const touched=new Uint8Array(nodes.length),parent=Int32Array.from({length:nodes.length},(_,i)=>i),root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const join=(a:number,b:number)=>{if(points[a].y<=points[a].bed+water.wetDepth||points[b].y<=points[b].bed+water.wetDepth)return;touched[a]=touched[b]=1;a=root(a);b=root(b);if(a!==b)parent[Math.max(a,b)]=Math.min(a,b);};
    for(let index=0;index<faces.length;index++){const f=faces[index];if(f.b<0||!visible[f.a]||!visible[f.b])continue;
      const crest=Math.max(f.start.bed,f.end.bed,f.barrier?.top??-Infinity);if(Math.min(heads[f.a],heads[f.b])<=crest+water.wetDepth)continue;
      for(const e of edges[index]){join(e.a0,e.b0);join(e.a1,e.b1);}}
    const sums=new Map<number,{weight:number;y:number;nx:number;ny:number;nz:number;u:number;v:number;count:number;pinned:boolean}>();
    for(let i=0;i<nodes.length;i++){if(!touched[i])continue;const group=root(i),p=points[i],weight=mesh.regions[nodes[i].region].area;let sum=sums.get(group);if(sum?.pinned&&!pinned[i])continue;
      if(!sum||pinned[i]&&!sum.pinned)sum={weight:0,y:0,nx:0,ny:0,nz:0,u:0,v:0,count:0,pinned:!!pinned[i]};sum.weight+=weight;sum.y+=p.y*weight;sum.nx+=p.nx*weight;sum.ny+=p.ny*weight;sum.nz+=p.nz*weight;sum.u+=p.u*weight;sum.v+=p.v*weight;sum.count++;sums.set(group,sum);}
    for(let i=0;i<nodes.length;i++){if(!touched[i])continue;const sum=sums.get(root(i));if(!sum||sum.count<2&&!sum.pinned)continue;const p=points[i],length=Math.hypot(sum.nx,sum.ny,sum.nz);p.y=sum.y/sum.weight;p.nx=sum.nx/length;p.ny=sum.ny/length;p.nz=sum.nz/length;p.u=sum.u/sum.weight;p.v=sum.v/sum.weight;p.key=-1;}
  }
  for(let i=0;i<nodes.length;i++)if(visible[nodes[i].region]&&points[i].y<=points[i].bed+water.wetDepth)controls.safe[controls.parent[nodes[i].region]]=0;
  for(let i=0;i<nodes.length;i++)if(!controls.safe[controls.parent[nodes[i].region]])points[i].key=-1;
  const terrainContact=mesh.regions.map((r,i)=>visible[i]&&!r.solid&&(placementOnly?Math.max(...rings[i].map(j=>points[j].bed))-Math.min(...rings[i].map(j=>points[j].bed)):r.bedMax-r.bedMin)>1e-8&&rings[i].some(j=>points[j].y<=points[j].bed+water.wetDepth)?1:0);
  const wetCells = new Set<number>();
  function emit(region: number, points: SurfacePoint[], nx: number, ny: number, nz: number,keyBase=-1) {
    const a = points[0], b = points[1], c = points[2];
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const crossX = uy * vz - uz * vy, crossY = uz * vx - ux * vz, crossZ = ux * vy - uy * vx;
    if (Math.hypot(crossX, crossY, crossZ) <= 1e-12) return;
    if (vertices + 3 > MAX_VERTICES) throw new Error('Boundary surface exceeds its vertex budget.');reserve();
    if (crossX * nx + crossY * ny + crossZ * nz < 0) points = [a, c, b];
    const r = mesh.regions[region];
    for (const point of points) {
      const top=ny>.5,depth = Math.max(0, point.y - point.bed), edge = 1 - smooth(depth / shallow), tint = waterSurfaceTint(depth,shallow,!top),foam=top?terrainContact[region]*(1-smooth(depth/(shallow*.3)))*.04:0;
      const p=vertices*3,q=vertices*4,u=vertices*2;
      positions[p]=point.x;positions[p+1]=point.y;positions[p+2]=point.z;normals[p]=top?point.nx:nx;normals[p+1]=top?point.ny:ny;normals[p+2]=top?point.nz:nz;uvs[u]=point.x;uvs[u+1]=point.z;vertexKeys[vertices]=top&&point.key>=0&&keyBase>=0?keyBase+(point===a?0:point===b?1:2):-1;
      colors[q]=(color.r * (1 - tint) + shallowColor.r * tint)*(1-foam)+foamColor.r*foam;colors[q+1]=(color.g * (1 - tint) + shallowColor.g * tint)*(1-foam)+foamColor.g*foam;
      colors[q+2]=(color.b * (1 - tint) + shallowColor.b * tint)*(1-foam)+foamColor.b*foam;colors[q+3]=(top ? 1 : .65) * Math.max(1 - (1 - edgeOpacity) * edge, waterBodyFilmOpacity(depth));
      flows[q]=top?point.u:0;flows[q+1]=top?point.v:0;flows[q+2]=top?terrainContact[region]:0;flows[q+3]=depth;vertices++;
    }
    triangleRegions[triangles++]=owners?.[region]??region; wetCells.add(r.cell);
  }
  const drawn=new Uint8Array(count),submerged=new Uint8Array(count).fill(1),coalesced=new Uint8Array(cells);
  for(let i=0;i<nodes.length;i++)if(!visible[nodes[i].region]||points[i].y<=points[i].bed+water.wetDepth)submerged[nodes[i].region]=0;
  for(const fan of topology.gridFans){const members=mesh.cells[fan.cell],group=controls.parent[members[0]];
    if(prolonged[fan.cell]||controls.pinned[fan.cell]||members.some(i=>controls.parent[i]!==group||!submerged[i]))continue;
    const representative=members.find(i=>volume[i]>0)!;
    for(let k=0;k<4;k++)emit(representative,[points[fan.nodes[4]],points[fan.nodes[k]],points[fan.nodes[(k+1)%4]]],0,1,0,fan.key+k*3);
    coalesced[fan.cell]=1;for(const i of members)drawn[i]=1;
  }
  for(const patch of topology.patches){const i=patch.region;if(!visible[i]||coalesced[mesh.regions[i].cell])continue;
    const original=patch.nodes.map(j=>points[j]),clipped=original.some(p=>p.y<=p.bed),polygon=clipped?wetPolygon(original):original,before=triangles;
    for(let j=1;j+1<polygon.length;j++)emit(i,[polygon[0],polygon[j],polygon[j+1]],0,1,0,clipped?-1:patch.key+(j-1)*3);
    if(triangles>before)drawn[i]=1;
  }
  // A locally wet fragment can outlive its coarse visible interpolation near
  // a receding shore. Keep a physical wet anchor only in that exceptional
  // fragment, instead of erasing real water or lifting the whole cell field.
  for(let i=0;i<count;i++)if(!placementOnly&&visible[i]&&volume[i]>0&&!drawn[i]&&!ordinary?.[i]){
    const ring=rings[i],row=controls.parent[i]*30+24,field=controls.field;
    const center:SurfacePoint={...centers[i],y:heads[i],nx:field[row+1],ny:field[row+2],nz:field[row+3],u:flowX[i],v:flowZ[i],key:-1};
    if(center.bed>=center.y){let x=0,z=0,bed=0,number=0;const polygon=mesh.regions[i].polygon;
      for(let k=0;k<polygon.length;k++){const a=polygon[k],b=polygon[(k+1)%polygon.length],inside=a.bed<center.y;if(inside){x+=a.x;z+=a.z;bed+=a.bed;number++;}if(inside!==(b.bed<center.y)){const t=(center.y-a.bed)/(b.bed-a.bed);x+=a.x+(b.x-a.x)*t;z+=a.z+(b.z-a.z)*t;bed+=center.y;number++;}}
      if(number){center.x=x/number;center.z=z/number;center.bed=bed/number;}
    }
    for(let k=0;k<ring.length;k++){const polygon=wetPolygon([center,points[ring[k]],points[ring[(k+1)%ring.length]]]);for(let j=1;j+1<polygon.length;j++)emit(i,[polygon[0],polygon[j],polygon[j+1]],0,1,0);}
  }
  if (options.sides !== false) for(let index=0;index<faces.length;index++) {
    const face=faces[index];
    if(face.b>=0&&controls.parent[face.a]===controls.parent[face.b])continue;
    for(const edge of edges[index]) {
    for(const [region,neighbor,ia,ib,ja,jb,nx,nz] of [[face.a,face.b,edge.a0,edge.a1,edge.b0,edge.b1,face.nx,face.nz],[face.b,face.a,edge.b0,edge.b1,edge.a0,edge.a1,-face.nx,-face.nz]]){
      if(region<0||!visible[region])continue;
      const a0=points[ia],b0=points[ib],solid=neighbor<0?undefined:mesh.regions[neighbor].solid;
      if(connectionValues[region].some(({segment})=>onSegment(a0,segment.start,segment.end)!==undefined&&onSegment(b0,segment.start,segment.end)!==undefined))continue;
      if(neighbor>=0&&visible[neighbor]&&a0.y<=points[ja].y&&b0.y<=points[jb].y)continue;
      const lower:[[number,number],...[number,number][]]=[placementOnly?[a0.bed,b0.bed]:[face.start.bed+(face.end.bed-face.start.bed)*edge.t0,face.start.bed+(face.end.bed-face.start.bed)*edge.t1]];
      if(solid)lower.push([solid.top,solid.top]);
      if(neighbor>=0&&visible[neighbor])lower.push([points[ja].y,points[jb].y]);
      // Preserve every kink of max(bed, adjacent surface), so sloping steps
      // neither expose internal translucent skirts nor leave an edge gap.
      const cuts=[0,1];for(let i=0;i<lower.length;i++)for(let j=i+1;j<lower.length;j++){const da=lower[i][0]-lower[j][0],db=lower[i][1]-lower[j][1];if(da*db<0)cuts.push(da/(da-db));}cuts.sort((a,b)=>a-b);
      const at=(t:number)=>({...interpolate(a0,b0,t),bed:Math.max(...lower.map(([a,b])=>a+(b-a)*t))});
      for(let i=1;i<cuts.length;i++){
        let a=at(cuts[i-1]),b=at(cuts[i]);if(a.y<=a.bed&&b.y<=b.bed)continue;
        if(a.y<=a.bed||b.y<=b.bed){const da=a.y-a.bed,db=b.y-b.bed,p=interpolate(a,b,da/(da-db));if(da<=0)a=p;else b=p;}
        emit(region,[a,{...a,y:a.bed},b],nx,0,nz);emit(region,[b,{...a,y:a.bed},{...b,y:b.bed}],nx,0,nz);
      }
    }
  }
  }
  workspace.mesh = sourceMesh; workspace.style = style;workspace.barriers=barriers; workspace.volume = sourceVolume.slice(); workspace.solidDepth = sourceSolidDepth.slice(); workspace.flowX = sourceFlowX.slice(); workspace.flowZ = sourceFlowZ.slice();
  workspace.connectionSegments=options.connections?.segments;workspace.connectionValues=options.connections?.values;
  workspace.surface = { waterRevision: water.revision, revision: state.revision, time: state.time, baseRevision,
    cellIds: Uint32Array.from({ length: cells }, (_, i) => i), positions:positions.subarray(0,vertices*3), normals:normals.subarray(0,vertices*3),
    colors:colors.subarray(0,vertices*4), uvs:uvs.subarray(0,vertices*2), flowData:flows.subarray(0,vertices*4), patches: new Float32Array(),
    boundary: { meshRevision: sourceMesh.revision, regionCount: sourceCount, triangleRegions:triangleRegions.subarray(0,triangles), vertexKeys:vertexKeys.subarray(0,vertices) },
    stats: { cells, wetCells: wetCells.size, rebuiltCells: cells, reusedCells: 0, vertices, triangles: vertices / 3,
      gridVolume: sourceVolume.reduce((total, amount) => total + amount, 0), buildMs: performance.now() - started } };
  return copied(workspace.surface, options.copy !== false);
}

/** Query the accepted triangles, including separate heads within one base cell. */
export function sampleWaterBoundarySurface(surface: WaterBodySurfaceBuffers, point: { x: number; z: number }) {
  if (!surface.boundary) throw new Error('Expected a boundary surface.');
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) throw new Error('Water surface sample must be finite.');
  for (let vertex = 0; vertex < surface.positions.length / 3; vertex += 3) {
    const p = surface.positions, a = vertex * 3, b = a + 3, c = a + 6;
    const ux = p[b] - p[a], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vz = p[c + 2] - p[a + 2];
    const determinant = ux * vz - uz * vx;
    if (Math.abs(determinant) < 1e-14) continue;
    const dx = point.x - p[a], dz = point.z - p[a + 2], u = (dx * vz - dz * vx) / determinant, v = (ux * dz - uz * dx) / determinant;
    if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
    const interpolate = (values: Float32Array, stride: number, offset: number) => values[vertex * stride + offset] * (1 - u - v)
      + values[(vertex + 1) * stride + offset] * u + values[(vertex + 2) * stride + offset] * v;
    const nx=interpolate(surface.normals,3,0),ny=interpolate(surface.normals,3,1),nz=interpolate(surface.normals,3,2),length=Math.hypot(nx,ny,nz);
    return { surface: interpolate(p, 3, 1), depth: surface.flowData ? interpolate(surface.flowData, 4, 3) : 0,
      normal: { x:nx/length,y:ny/length,z:nz/length }, velocity: { x: surface.flowData ? interpolate(surface.flowData, 4, 0) : 0, y: 0, z: surface.flowData ? interpolate(surface.flowData, 4, 1) : 0 },
      region: surface.boundary.triangleRegions[vertex / 3] };
  }
  return undefined;
}
