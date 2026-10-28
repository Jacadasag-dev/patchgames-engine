import type { ObjectShape, StateOf } from '../shared/gameApi.ts';
import {freezeWaterDepthGraph,type WaterDepthGraph} from './waterBodyDepthGraph.ts';
import { validateWaterBodyState, type WaterBodyManifest, type WaterBodyState } from './waterBody.ts';
import { WATER_BOUNDARY_LIMITS, sameWaterBoundaryMesh, type BoundaryPoint, type WaterBoundaryMesh } from './waterBoundaryGeometry.ts';
import {WATER_BODY_FLIGHT_LIMITS,type WaterBodyFlight} from './waterBodyFlights.ts';

/** Lossless checkpoints; a full snapshot approaches 1 MB. Budget replication. */
export const WATER_BODY_WIRE_LIMITS = Object.freeze({ cells: 4096, barrierIds: 256, stringLength: 128, arrays: 28, entries: 256, bytes: 688128, jsonCharacters: 1000000 });
const dataShape = {
  a:['string'],b:['string'],c:['string'],d:['string'],e:['string'],f:['string'],g:['string'],h:['string'],
  i:['string'],j:['string'],k:['string'],l:['string'],m:['string'],n:['string'],o:['string'],p:['string'],
  q:['string'],r:['string'],s:['string'],t:['string'],u:['string'],v:['string'],w:['string'],x:['string'],
  y:['string'],z:['string'],aa:['string'],ab:['string'],
} as const;
/** Nest once: world:{water:waterBodyStateShape}. Uses 36 declared fields. */
export const waterBodyStateShape = { data:dataShape, labels:{water:'string',liquid:'string',scene:'string',barriers:['string'],sources:['string'],checksum:'string'} } as const satisfies ObjectShape;
export type WaterBodyWireState = StateOf<typeof waterBodyStateShape>;
const chunks = Object.keys(dataShape) as (keyof typeof dataShape)[];
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const alphabetValues = new Int16Array(128).fill(-1);
for (let i = 0; i < alphabet.length; i++) alphabetValues[alphabet.charCodeAt(i)] = i;
const gridNumbers = ['revision','time','initialVolume','externalAddedVolume','externalRemovedVolume'] as const;
/** 'WBO1' is the body-only layout. 'HYB1'+flags payloads carried 3D particle water and are refused. */
const VERSION = 0x57424f31, LEGACY_VERSION = 0x48594231;
// Optional flag bits: 1 solid columns, 2 depth currents, 4 boundary regions,
// 8 depth graph, 16 conserved airborne water. Absent flights keep old bytes.
// With bit 4 absent the raw layout remains byte-for-byte compatible.
const gridArrays = ['depth','flowX','flowZ','quietTime','bed'] as const;
function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length > WATER_BODY_WIRE_LIMITS.stringLength) throw new Error(`Water body wire ${name} exceeds the 128-character string limit`);
}
function dimensions(water: WaterBodyManifest) {
  const cells = water.columns * water.rows, vertices = (water.columns + 1) * (water.rows + 1), x = (water.columns + 1) * water.rows, z = water.columns * (water.rows + 1);
  if (!Number.isInteger(water.columns) || !Number.isInteger(water.rows) || water.columns < 1 || water.rows < 1 || cells > WATER_BODY_WIRE_LIMITS.cells) throw new Error('Water body wire supports at most 4096 cells; larger grids remain local');
  return { cells, vertices, x, z };
}
function depthDimensions(columns:number,rows:number,layers:number,stride:number) {
  if(![columns,rows,layers,stride].every(Number.isSafeInteger)||columns<1||rows<1||layers<2||layers>12||stride<1||columns*rows*layers>32768)throw new Error('Invalid water body wire depth-current dimensions');
  const cells=columns*rows*layers,x=(columns+1)*rows*layers,y=columns*rows*(layers+1),z=columns*(rows+1)*layers;
  return{cells,x,y,z,bytes:41+cells+(x+y+z)*8};
}
function graphDimensions(graph:WaterDepthGraph){
  text(graph.revision,'depth graph revision');
  const cells=graph.nodes.length,faces=graph.edges.length,members=graph.nodes.reduce((sum,node)=>sum+node.regions.length,0);
  if(cells>32768||faces>32768*12||members>WATER_BOUNDARY_LIMITS.regions*12)throw new Error('Water body wire depth graph budget exceeded');
  const graphBytes=12+graph.revision.length*2+cells*36+members*4+faces*61;
  return{cells,x:faces,y:faces,z:faces,bytes:41+graphBytes+cells+faces*24};
}
function writeDepthGraph(view:DataView,at:number,graph:WaterDepthGraph){
  const uint=(n:number)=>{view.setUint32(at,n,true);at+=4;},number=(n:number)=>{if(!Number.isFinite(n))throw new Error('Invalid water depth graph number');view.setFloat64(at,n,true);at+=8;};
  uint(graph.revision.length);for(let i=0;i<graph.revision.length;i++){view.setUint16(at,graph.revision.charCodeAt(i),true);at+=2;}
  uint(graph.nodes.length);uint(graph.edges.length);
  for(const node of graph.nodes){uint(node.layer);uint(node.bin);uint(node.regions.length);number(node.volume);number(node.x);number(node.z);for(const region of node.regions)uint(region);}
  for(const edge of graph.edges){uint(edge.a);uint(edge.b);view.setUint8(at++,edge.axis);view.setInt32(at,edge.group,true);at+=4;for(const key of ['area','distance','volume','x','y','z'] as const)number(edge[key]);}
  return at;
}
function readDepthGraph(view:DataView,at:number):{graph:WaterDepthGraph;at:number}{
  const require=(n:number)=>{if(n<0||at+n>view.byteLength)throw new Error('Truncated water depth graph');};
  const uint=()=>{require(4);const n=view.getUint32(at,true);at+=4;return n;},number=()=>{require(8);const n=view.getFloat64(at,true);at+=8;if(!Number.isFinite(n))throw new Error('Invalid water depth graph number');return n;};
  const length=uint();if(length>WATER_BODY_WIRE_LIMITS.stringLength)throw new Error('Invalid water depth graph revision');require(length*2);let revision='';for(let i=0;i<length;i++){revision+=String.fromCharCode(view.getUint16(at,true));at+=2;}
  const count=uint(),faces=uint();if(count>32768||faces>32768*12)throw new Error('Water body wire depth graph budget exceeded');require(count*36+faces*61);
  const nodes:WaterDepthGraph['nodes']=[],edges:WaterDepthGraph['edges']=[];let members=0;
  for(let i=0;i<count;i++){const layer=uint(),bin=uint(),size=uint();members+=size;if(members>WATER_BOUNDARY_LIMITS.regions*12)throw new Error('Water depth graph membership budget exceeded');const volume=number(),x=number(),z=number();require(size*4);const regions=Array.from({length:size},uint);nodes.push({layer,bin,volume,x,z,regions});}
  for(let i=0;i<faces;i++){const a=uint(),b=uint();require(5);const axis=view.getUint8(at++) as 0|1|2,group=view.getInt32(at,true);at+=4;const area=number(),distance=number(),volume=number(),x=number(),y=number(),z=number();edges.push({a,b,axis,group,area,distance,volume,x,y,z});}
  return{graph:freezeWaterDepthGraph({revision,nodes,edges}),at};
}
function byteCount(d: ReturnType<typeof dimensions>, solids=false, depthBytes=0): number {
  return 20 + depthBytes + gridNumbers.length * 8 + (gridArrays.length + (solids ? 1 : 0)) * d.cells * 8 + d.vertices * 8 + d.cells + (d.x + d.z) * 2;
}
const flightNumbers=['volume','time','duration','sourceDepth'] as const;
const flightBytes=(flights:readonly WaterBodyFlight[])=>4+flights.reduce((sum,f)=>sum+113+(f.emittedTime===undefined?0:8)+2*(f.id.length+(f.destination?.length??0)),0);
/** Exact transaction allowance; existing and incoming IDs are already known.
 * Reserve each packet's possible later reanchor and World ownership tag. */
export function waterBodyFlightReservation(water:WaterBodyManifest,state:WaterBodyState):{bytes:number;charge:(flight:WaterBodyFlight)=>number} {
  const charge=(flight:WaterBodyFlight)=>121+2*(flight.id.length+(flight.destination?.length??water.revision.length));
  // Larger local grids were never wire-encodable; keep their existing runtime
  // support under the independent in-memory flight bound.
  if(water.columns*water.rows>WATER_BODY_WIRE_LIMITS.cells)return{bytes:Number.MAX_SAFE_INTEGER,charge};
  const depth=state.depthCurrents,depthSize=depth?depth.graph?graphDimensions(depth.graph):depthDimensions(depth.columns,depth.rows,depth.layers,depth.stride):undefined;
  const base=byteCount(dimensions(water),state.solidDepth!==undefined,depthSize?.bytes)+(state.boundary?boundaryLayout(water,state.boundary).bytes:0);
  return{bytes:WATER_BODY_WIRE_LIMITS.bytes-base-4,charge};
}
/** Conservative count for callers that do not own a byte-tracked queue. */
export function waterBodyFlightCapacity(water:WaterBodyManifest,state:WaterBodyState):number {
  const reservation=waterBodyFlightReservation(water,state);
  const existing=state.flights??[];
  // Existing identifiers are known. Charging every short face ID as two
  // 128-character strings artificially choked continuous falls far below the
  // checkpoint limit. Reserve only the unknown future records at their maximum.
  // A later collision can add emittedTime, and a World step may tag an unowned
  // packet with this body's revision; leave room for both before accepting flux.
  const occupied=existing.reduce((sum,f)=>sum+reservation.charge(f),0);
  return Math.max(0,Math.min(WATER_BODY_FLIGHT_LIMITS.packets,existing.length+Math.floor((reservation.bytes-occupied)/633)));
}
function writeFlights(view:DataView,at:number,flights:readonly WaterBodyFlight[]):number {
  const uint=(n:number)=>{view.setUint32(at,n,true);at+=4;},number=(n:number)=>{view.setFloat64(at,n,true);at+=8;};
  const string=(value:string)=>{text(value,'flight identifier');uint(value.length);for(let k=0;k<value.length;k++){view.setUint16(at,value.charCodeAt(k),true);at+=2;}};
  uint(flights.length);for(const f of flights){string(f.id);string(f.destination??'');for(const p of [...f.edge,f.velocity])for(const axis of ['x','y','z'] as const)number(p[axis]);for(const key of flightNumbers)number(f[key]);view.setUint8(at++,f.emittedTime===undefined?0:1);if(f.emittedTime!==undefined)number(f.emittedTime);}return at;
}
function readFlights(view:DataView,at:number):{flights:WaterBodyFlight[];at:number} {
  const require=(n:number)=>{if(at+n>view.byteLength)throw new Error('Truncated water flight checkpoint');};
  const uint=()=>{require(4);const n=view.getUint32(at,true);at+=4;return n;},number=()=>{require(8);const n=view.getFloat64(at,true);at+=8;return n;};
  const string=()=>{const size=uint();if(size>128)throw new Error('Invalid water flight identifier');require(size*2);let result='';for(let k=0;k<size;k++){result+=String.fromCharCode(view.getUint16(at,true));at+=2;}return result;};
  const count=uint();if(count>WATER_BODY_FLIGHT_LIMITS.packets)throw new Error('Invalid water flight checkpoint count');require(count*113);
  const vector=()=>({x:number(),y:number(),z:number()}),flights:WaterBodyFlight[]=[];
  for(let k=0;k<count;k++){const id=string(),destination=string(),edge:[ReturnType<typeof vector>,ReturnType<typeof vector>]=[vector(),vector()],velocity=vector(),volume=number(),time=number(),duration=number(),sourceDepth=number();require(1);const hasEmission=view.getUint8(at++);if(hasEmission>1)throw new Error('Invalid water flight emission flag');flights.push({id,...(destination?{destination}:{}),edge,velocity,volume,time,duration,sourceDepth,...(hasEmission?{emittedTime:number()}: {})});}
  return{flights,at};
}
type BoundaryState = NonNullable<WaterBodyState['boundary']>;
/** Geometry is immutable between static scene edits. Ordinary checkpoints refer
 * to the manifest mesh; checkpoints after a geometry edit carry that topology
 * in the same bounded payload. Every number, including signed zero, remains
 * an IEEE float64. */
interface BoundaryMeshLayout {bytes:number;regionRefs:number[];faceRefs:number[];supports:boolean}
const meshLayouts=new WeakMap<WaterBoundaryMesh,WeakMap<WaterBoundaryMesh,BoundaryMeshLayout>>();
const geometryKey=(value:unknown)=>JSON.stringify(value,(_key,v)=>typeof v==='number'&&Object.is(v,-0)?'-0':v);
const regionKey=(r:WaterBoundaryMesh['regions'][number])=>geometryKey([r.cell,r.area,r.center.x,r.center.z,r.bedMin,r.bedMax,r.bulk??false,r.solid?[r.solid.id,r.solid.bottom,r.solid.top]:null,r.polygon.map(p=>[p.x,p.z,p.bed]),r.supportId,r.ceiling]);
const faceKey=(f:WaterBoundaryMesh['faces'][number])=>geometryKey([f.start.x,f.start.z,f.start.bed,f.end.x,f.end.z,f.end.bed,f.nx,f.nz,f.length,f.closed??false]);
const layoutImmutable=new WeakSet<object>();
function immutableLayout(value:unknown):boolean{
  const visited=new Set<object>(),check=(value:unknown):boolean=>{
    if(!value||typeof value!=='object'||layoutImmutable.has(value)||visited.has(value))return true;visited.add(value);
    const prototype=Object.getPrototypeOf(value);
    return Object.isFrozen(value)&&(prototype===Object.prototype||prototype===Array.prototype)&&Object.values(Object.getOwnPropertyDescriptors(value)).every(p=>'value'in p&&check(p.value));
  };
  if(!check(value))return false;
  for(const entry of visited)layoutImmutable.add(entry);return true;
}
/** Lossless mesh dictionaries keep a static edit from duplicating the entire
 * exact terrain reference. Only immutable geometry is cached. */
function boundaryMeshLayout(mesh:WaterBoundaryMesh,base?:WaterBoundaryMesh):BoundaryMeshLayout {
  const known=base&&meshLayouts.get(mesh)?.get(base);if(known)return known;
  for(const value of [mesh.revision,mesh.sourceKey])text(value,'boundary identifier');
  const regionMap=new Map(base?.regions.map((r,i)=>[regionKey(r),i+1])),faceMap=new Map(base?.faces.map((f,i)=>[faceKey(f),i+1]));
  const supports=mesh.supportLayer!==undefined;
  let bytes=12+(supports?4:0)+(mesh.revision.length+mesh.sourceKey.length)*2+mesh.cells.length+mesh.regions.length*2;
  const regionRefs=mesh.regions.map(r=>{const ref=regionMap.get(regionKey(r))??0;bytes+=2;if(!ref)bytes+=49+r.polygon.length*24+(r.solid?20+r.solid.id.length*2:0)+(supports?12+r.supportId!.length*2:0);return ref;}),
    faceRefs=mesh.faces.map(f=>{const ref=faceMap.get(faceKey(f))??0;bytes+=ref?8:80+(supports?1:0);return ref;});
  const result={bytes,regionRefs,faceRefs,supports};
  if(base&&immutableLayout(mesh)&&immutableLayout(base)){const byBase=meshLayouts.get(mesh)??new WeakMap<WaterBoundaryMesh,BoundaryMeshLayout>();byBase.set(base,result);meshLayouts.set(mesh,byBase);}return result;
}
function boundaryLayout(water:WaterBodyManifest,boundary:BoundaryState) {
  const mesh=boundary.mesh,n=mesh.regions.length;
  if(!n||n>WATER_BOUNDARY_LIMITS.regions||mesh.faces.length>WATER_BOUNDARY_LIMITS.faces||mesh.cells.length!==water.columns*water.rows)throw new Error('Invalid water body wire boundary dimensions');
  for(const values of [boundary.volume,boundary.flowX,boundary.flowZ])if(!Array.isArray(values)||values.length!==n)throw new Error('Invalid water body wire boundary state size');
  for(const value of [mesh.revision,mesh.sourceKey])text(value,'boundary identifier');
  const reference=water.boundaryMesh!==undefined&&mesh.revision===water.boundaryMesh.revision;
  if(reference&&!sameWaterBoundaryMesh(mesh,water.boundaryMesh!))throw new Error('Water body wire boundary mesh identity mismatch');
  if(boundary.solidDepth&&boundary.solidDepth.length!==n)throw new Error('Invalid water body wire boundary solid state');
  let size=12+n*(boundary.solidDepth?32:24),points=0,members=0;
  const active=reference?undefined:boundaryMeshLayout(mesh,water.boundaryMesh),surfaceBase=water.boundaryMesh?.surface?.mesh??water.boundaryMesh;
  const surface=!reference&&mesh.surface?{reference:!!surfaceBase&&sameWaterBoundaryMesh(mesh.surface.mesh,surfaceBase),layout:undefined as BoundaryMeshLayout|undefined}:undefined;
  if(active)size+=active.bytes;
  if(surface){if(!surface.reference)surface.layout=boundaryMeshLayout(mesh.surface!.mesh,surfaceBase);size+=8+mesh.surface!.owners.length*2+(surface.layout?.bytes??0);}
  for(const region of mesh.regions){
    const count=region.polygon.length;points+=count;
    if(count<3||count>WATER_BOUNDARY_LIMITS.vertices||points>WATER_BOUNDARY_LIMITS.points)throw new Error('Water body wire boundary polygon budget exceeded');
    if(region.solid&& (typeof region.solid.id!=='string'||region.solid.id.length>1024))throw new Error('Invalid water body wire boundary solid identifier');
  }
  for(const list of mesh.cells){if(!Array.isArray(list)||list.length>WATER_BOUNDARY_LIMITS.regionsPerCell||(members+=list.length)>n)throw new Error('Invalid water body wire boundary cell membership');}
  if(members!==n)throw new Error('Invalid water body wire boundary cell membership');
  if(size>WATER_BODY_WIRE_LIMITS.bytes)throw new Error('Water body wire payload budget exceeded');
  return{bytes:size,reference,active,surface};
}
function writeBoundary(view:DataView,at:number,boundary:BoundaryState,layout:ReturnType<typeof boundaryLayout>):number {
  const start=at,mesh=boundary.mesh;
  const uint=(value:number)=>{view.setUint32(at,value,true);at+=4;};
  const short=(value:number)=>{view.setUint16(at,value,true);at+=2;};
  const number=(value:number)=>{if(!Number.isFinite(value))throw new Error('Non-finite water body wire boundary value');view.setFloat64(at,value,true);at+=8;};
  const string=(value:string)=>{uint(value.length);for(let i=0;i<value.length;i++){view.setUint16(at,value.charCodeAt(i),true);at+=2;}};
  const point=(p:BoundaryPoint)=>{number(p.x);number(p.z);number(p.bed);};
  uint(layout.bytes-4);uint((layout.reference?0:9)+(boundary.solidDepth?2:0)+(layout.surface?4:0)+(layout.active&&mesh.placementOnly?16:0)+(layout.active?.supports?32:0));uint(mesh.regions.length);
  const writeMesh=(mesh:WaterBoundaryMesh,data:BoundaryMeshLayout)=>{
    string(mesh.revision);string(mesh.sourceKey);uint(mesh.faces.length);if(data.supports)uint(mesh.supportLayer!);
    for(let i=0;i<mesh.regions.length;i++){const region=mesh.regions[i];short(data.regionRefs[i]);if(data.regionRefs[i])continue;
      uint(region.cell);uint(region.polygon.length);for(const value of [region.area,region.center.x,region.center.z,region.bedMin,region.bedMax])number(value);
      view.setUint8(at++,(region.solid?1:0)+(region.bulk?2:0));if(region.solid){string(region.solid.id);number(region.solid.bottom);number(region.solid.top);}
      if(data.supports){string(region.supportId!);number(region.ceiling!);}
      for(const p of region.polygon)point(p);
    }
    for(const list of mesh.cells){view.setUint8(at++,list.length);for(const index of list)short(index);}
    for(let i=0;i<mesh.faces.length;i++){const face=mesh.faces[i];uint(data.faceRefs[i]);short(face.a);short(face.b+1);if(data.faceRefs[i])continue;point(face.start);point(face.end);number(face.nx);number(face.nz);number(face.length);if(data.supports)view.setUint8(at++,face.closed?1:0);}
  };
  if(layout.active)writeMesh(mesh,layout.active);
  if(layout.surface){const surface=mesh.surface!;uint(layout.surface.reference?0:layout.surface.layout!.supports?2:1);uint(surface.owners.length);if(layout.surface.layout)writeMesh(surface.mesh,layout.surface.layout);for(const owner of surface.owners){view.setUint16(at,owner,true);at+=2;}}
  for(const values of [boundary.volume,boundary.flowX,boundary.flowZ,...(boundary.solidDepth?[boundary.solidDepth]:[])])for(const value of values)number(value);
  if(at-start!==layout.bytes)throw new Error('Water body wire boundary length mismatch');
  return at;
}
function readBoundary(water:WaterBodyManifest,view:DataView,at:number):BoundaryState {
  const require=(count:number)=>{if(count<0||at+count>view.byteLength)throw new Error('Truncated water body wire boundary payload');};
  const uint=()=>{require(4);const value=view.getUint32(at,true);at+=4;return value;};
  const short=()=>{require(2);const value=view.getUint16(at,true);at+=2;return value;};
  const number=()=>{require(8);const value=view.getFloat64(at,true);at+=8;if(!Number.isFinite(value))throw new Error('Non-finite water body wire boundary value');return value;};
  const string=(limit:number=WATER_BODY_WIRE_LIMITS.stringLength)=>{const length=uint();if(length>limit)throw new Error('Invalid water body wire boundary identifier');require(length*2);let value='';for(let i=0;i<length;i++){value+=String.fromCharCode(view.getUint16(at,true));at+=2;}return value;};
  const point=():BoundaryPoint=>({x:number(),z:number(),bed:number()});
  const length=uint();if(length!==view.byteLength-at)throw new Error('Water body wire boundary length mismatch');
  const kind=uint(),count=uint();
  if(kind>63||!(kind&1)&&(kind&60)||(kind&16)&&!(kind&4)||(kind&32)&&!(kind&8)||!count||count>WATER_BOUNDARY_LIMITS.regions)throw new Error('Invalid water body wire boundary dimensions');
  const readMesh=(count:number,compact:boolean,base?:WaterBoundaryMesh,supports=false):WaterBoundaryMesh=>{
    const revision=string(),sourceKey=string(),faceCount=uint(),supportLayer=supports?uint():undefined;
    if(supportLayer!==undefined&&supportLayer>=8)throw new Error('Invalid water body wire support layer');
    if(faceCount>WATER_BOUNDARY_LIMITS.faces)throw new Error('Invalid water body wire boundary face count');
    const regions:WaterBoundaryMesh['regions']=[],cells:WaterBoundaryMesh['cells']=[],faces:WaterBoundaryMesh['faces']=[];let points=0,members=0;
    // Minimum serialized sizes bound every allocation, even before the shared
    // geometry validator checks convexity, ownership and reciprocal faces.
    require(count*(compact?2:49+3*24)+faceCount*(compact?8:80)+water.columns*water.rows*(compact?1:4)+count*(compact?2:4));
    for(let i=0;i<count;i++){
      const ref=compact?short():0;if(ref){if(!base||ref>base.regions.length)throw new Error('Invalid water body wire boundary region reference');const region=base.regions[ref-1];points+=region.polygon.length;if(points>WATER_BOUNDARY_LIMITS.points)throw new Error('Invalid water body wire boundary polygon');regions.push(region);continue;}
      const cell=uint(),vertices=uint();points+=vertices;
      if(cell>=water.columns*water.rows||vertices<3||vertices>WATER_BOUNDARY_LIMITS.vertices||points>WATER_BOUNDARY_LIMITS.points)throw new Error('Invalid water body wire boundary polygon');
      const area=number(),center={x:number(),z:number()},bedMin=number(),bedMax=number();require(1);const flags=view.getUint8(at++);
      if(flags>(compact?3:1))throw new Error('Invalid water body wire boundary solid flag');
      const solid=flags&1?{id:string(1024),bottom:number(),top:number()}:undefined;
      const metadata=supports?{supportId:string(1024),ceiling:number()}:{};
      const polygon=Array.from({length:vertices},point);regions.push({cell,polygon,area,center,bedMin,bedMax,...(solid?{solid}:{}),...(flags&2?{bulk:true}:{}),...metadata});
    }
    for(let i=0;i<water.columns*water.rows;i++){
      require(compact?1:4);const size=compact?view.getUint8(at++):uint();members+=size;if(size>WATER_BOUNDARY_LIMITS.regionsPerCell||members>count)throw new Error('Invalid water body wire boundary cell membership');
      require(size*(compact?2:4));const list=Array.from({length:size},compact?short:uint);if(list.some(index=>index>=count))throw new Error('Invalid water body wire boundary region index');cells.push(list);
    }
    if(members!==count)throw new Error('Invalid water body wire boundary cell membership');
    for(let i=0;i<faceCount;i++){
      const ref=compact?uint():0;require(compact?ref?4:76:80);const a=compact?short():view.getInt32(at,true),b=compact?short()-1:view.getInt32(at+4,true);if(!compact)at+=8;
      if(a<0||a>=count||b< -1||b>=count||a===b)throw new Error('Invalid water body wire boundary face index');
      if(ref){if(!base||ref>base.faces.length)throw new Error('Invalid water body wire boundary face reference');faces.push({...base.faces[ref-1],a,b});}
      else{const face={a,b,start:point(),end:point(),nx:number(),nz:number(),length:number()};if(supports){require(1);const closed=view.getUint8(at++);if(closed>1)throw new Error('Invalid water body wire support interface');faces.push({...face,...(closed?{closed:true as const}:{})});}else faces.push(face);}
    }
    return{revision,sourceKey,regions,cells,faces,...(supports?{supportLayer}:{})};
  };
  let mesh:WaterBoundaryMesh;
  if(!(kind&1)){
    if(!water.boundaryMesh||water.boundaryMesh.regions.length!==count)throw new Error('Water body wire boundary manifest mesh mismatch');mesh=water.boundaryMesh;
  }else mesh=readMesh(count,!!(kind&8),water.boundaryMesh,!!(kind&32));
  if(kind&4){
    const literal=uint(),surfaceCount=uint(),base=water.boundaryMesh?.surface?.mesh??water.boundaryMesh;
    if(literal>2||!surfaceCount||surfaceCount>WATER_BOUNDARY_LIMITS.regions||!literal&&(!base||base.regions.length!==surfaceCount))throw new Error('Invalid water body wire surface reference');
    const reference=literal?readMesh(surfaceCount,true,base,literal===2):base!;require(surfaceCount*2);
    const owners=Array.from({length:surfaceCount},()=>{const owner=view.getUint16(at,true);at+=2;if(owner>=count)throw new Error('Invalid water body wire surface owner');return owner;});mesh.surface={mesh:reference,owners};
  }
  if(kind&16)mesh.placementOnly=true;
  require(count*24);const volume=Array.from({length:count},number),flowX=Array.from({length:count},number),flowZ=Array.from({length:count},number);
  const solidDepth=kind&2?Array.from({length:count},number):undefined;
  if(at!==view.byteLength)throw new Error('Water body wire boundary length mismatch');
  return{mesh,volume,flowX,flowZ,...(solidDepth?{solidDepth}:{})};
}
function checksum(bytes: Uint8Array, labels: Omit<WaterBodyWireState['labels'], 'checksum'>): string {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
  const metadata = JSON.stringify([labels.water, labels.liquid, labels.scene, labels.barriers, labels.sources]);
  for (let i = 0; i < metadata.length; i++) hash = Math.imul(hash ^ metadata.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
// One reused 128-character code buffer per packed string: no per-character
// string concatenation (the wire is ~100k characters every tick). A plain
// small-integer array lets fromCharCode.apply avoid copying its arguments.
const alphabetCodes = Uint8Array.from(alphabet, c => c.charCodeAt(0)), packCodes: number[] = new Array(128).fill(0), PAD = 61;
function pack(bytes: Uint8Array): WaterBodyWireState['data'] {
  const strings: string[] = [], codes = packCodes; let n = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    codes[n++] = alphabetCodes[a >> 2]; codes[n++] = alphabetCodes[((a & 3) << 4) | (b >> 4)];
    codes[n++] = i + 1 < bytes.length ? alphabetCodes[((b & 15) << 2) | (c >> 6)] : PAD;
    codes[n++] = i + 2 < bytes.length ? alphabetCodes[c & 63] : PAD;
    if (n === 128) { strings.push(String.fromCharCode.apply(null, codes)); n = 0; }
  }
  if (n) strings.push(String.fromCharCode.apply(null, codes.slice(0, n)));
  if (strings.length > chunks.length * 256) throw new Error('Water body wire payload budget exceeded');
  return Object.fromEntries(chunks.map((key, i) => [key, strings.slice(i * 256, (i + 1) * 256)])) as WaterBodyWireState['data'];
}
/** Exact JSON.stringify(data).length: keys and base64 strings never need escaping. */
function packedJsonLength(data: WaterBodyWireState['data']): number {
  let length = 1 + chunks.length;
  for (const key of chunks) { const list = data[key]; length += key.length + 5 + Math.max(0, list.length - 1); for (const value of list) length += value.length + 2; }
  return length;
}
/** Lossless zero-run coding of the raw payload. Dry cells, absent solids and
 * quiet depth currents are long runs of 0.0, so a coded payload is usually a
 * fraction of the raw one; it is used only when smaller. A coded payload
 * starts with ZERO_RUNS (outside every raw header version) and the raw length.
 * Each 0 byte is followed by its run length (1-255); other bytes are literal.
 * The checksum and all validation always apply to the expanded raw bytes. */
const ZERO_RUNS = 0x5a594231;
function zeroRuns(bytes: Uint8Array): Uint8Array {
  let size = 8;
  for (let i = 0; i < bytes.length;) { if (bytes[i]) { size++; i++; continue; } let n = 0; while (i < bytes.length && !bytes[i] && n < 255) { n++; i++; } size += 2; }
  if (size >= bytes.length) return bytes;
  const out = new Uint8Array(size), view = new DataView(out.buffer); view.setUint32(0, ZERO_RUNS, true); view.setUint32(4, bytes.length, true); let at = 8;
  for (let i = 0; i < bytes.length;) { if (bytes[i]) { out[at++] = bytes[i++]; continue; } let n = 0; while (i < bytes.length && !bytes[i] && n < 255) { n++; i++; } out[at++] = 0; out[at++] = n; }
  return out;
}
function expandZeroRuns(stored: Uint8Array): Uint8Array {
  if (stored.length < 8) return stored;
  const view = new DataView(stored.buffer, stored.byteOffset, stored.length);
  if (view.getUint32(0, true) !== ZERO_RUNS) return stored;
  const length = view.getUint32(4, true);
  if (length > WATER_BODY_WIRE_LIMITS.bytes) throw new Error('Invalid water body wire payload size');
  const bytes = new Uint8Array(length); let at = 0;
  for (let i = 8; i < stored.length;) {
    const value = stored[i++];
    if (value) { if (at >= length) throw new Error('Invalid water body wire zero-run coding'); bytes[at++] = value; continue; }
    const run = i < stored.length ? stored[i++] : 0;
    if (!run || at + run > length) throw new Error('Invalid water body wire zero-run coding');
    at += run;
  }
  if (at !== length) throw new Error('Truncated water body wire zero-run coding');
  return bytes;
}
function unpack(data: WaterBodyWireState['data']): Uint8Array {
  if (!data || Object.keys(data).length !== chunks.length) throw new Error('Invalid water body wire chunks');
  const strings: string[] = []; let ended = false;
  for (const key of chunks) {
    const list = data[key];
    if (!Array.isArray(list) || list.length > 256 || (ended && list.length)) throw new Error('Invalid water body wire chunk size');
    if (list.length < 256) ended = true;
    for (const value of list) { text(value, 'payload'); if (!value.length) throw new Error('Empty water body wire payload string'); strings.push(value); }
  }
  if (!strings.length || strings.slice(0, -1).some(value => value.length !== 128)) throw new Error('Truncated water body wire payload');
  const encoded = strings.join('');
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid water body wire base64');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(encoded.length / 4 * 3 - padding); let offset = 0;
  for (let i = 0; i < encoded.length; i += 4) {
    const a = alphabetValues[encoded.charCodeAt(i)], b = alphabetValues[encoded.charCodeAt(i + 1)], c = alphabetValues[encoded.charCodeAt(i + 2)], d = alphabetValues[encoded.charCodeAt(i + 3)];
    if (a < 0 || b < 0 || (c < 0 && i + 4 !== encoded.length) || (d < 0 && i + 4 !== encoded.length)) throw new Error('Invalid water body wire base64 padding');
    bytes[offset++] = (a << 2) | (b >> 4);
    if (offset < bytes.length) bytes[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < bytes.length) bytes[offset++] = ((c & 3) << 6) | d;
    if (i + 4 === encoded.length && ((padding === 2 && (b & 15)) || (padding === 1 && (c & 3)))) throw new Error('Noncanonical water body wire base64 padding');
  }
  return bytes;
}

export function encodeWaterBodyState(water: WaterBodyManifest, state: WaterBodyState): WaterBodyWireState {
  const d = dimensions(water); validateWaterBodyState(water, state);
  const barriers = [...new Set([...state.barrierX, ...state.barrierZ].filter(Boolean))].sort();
  if (barriers.length > 256) throw new Error('Water body wire supports at most 256 barrier IDs');
  const labels = { water:state.waterRevision, liquid:water.liquid.revision, scene:state.sceneRevision, barriers, sources:[] as string[] };
  for (const value of [labels.water, labels.liquid, labels.scene, ...labels.barriers]) text(value, 'identifier');
  const depth=state.depthCurrents,depthSize=depth?depth.graph?graphDimensions(depth.graph):depthDimensions(depth.columns,depth.rows,depth.layers,depth.stride):undefined;
  const boundary=state.boundary,boundarySize=boundary?boundaryLayout(water,boundary):undefined;
  const flights=state.flights;
  const solids=state.solidDepth!==undefined,size = byteCount(d,solids,depthSize?.bytes)+(boundarySize?.bytes??0)+(flights?flightBytes(flights):0);
  if (size > WATER_BODY_WIRE_LIMITS.bytes) throw new Error('Water body wire payload budget exceeded');
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer); let at = 0;
  const uint = (n: number) => { view.setUint32(at, n, true); at += 4; };
  const number = (n: number) => { if (!Number.isFinite(n)) throw new Error('Non-finite water body wire value'); view.setFloat64(at, n, true); at += 8; };
  for (const n of [VERSION, (solids?1:0)+(depth?2:0)+(boundary?4:0)+(depth?.graph?8:0)+(flights?16:0), d.cells, d.vertices, d.x]) uint(n);
  if(depth){for(const n of [depth.columns,depth.rows,depth.layers,depth.stride])uint(n);for(const n of [depth.bottom,depth.cellHeight,depth.quietTime])number(n);bytes[at++]=depth.sleeping?1:0;if(depth.graph)at=writeDepthGraph(view,at,depth.graph);}
  for (const key of gridNumbers) number(state[key]);
  for (const key of gridArrays) for (const n of state[key]) number(n);
  if(solids)for(const n of state.solidDepth!)number(n);
  for (const n of state.bedVertices) number(n);
  for (const sleeping of state.sleeping) bytes[at++] = sleeping ? 1 : 0;
  const ids = new Map(barriers.map((id, i) => [id, i + 1]));
  for (const list of [state.barrierX, state.barrierZ]) for (const id of list) { view.setUint16(at, id ? ids.get(id)! : 0, true); at += 2; }
  if(depth){for(const wet of depth.wet)bytes[at++]=wet;for(const values of [depth.velocityX,depth.velocityY,depth.velocityZ])for(const value of values)number(value);}
  if(flights)at=writeFlights(view,at,flights);
  if(boundary&&boundarySize)at=writeBoundary(view,at,boundary,boundarySize);
  if(at!==size)throw new Error('Water body wire length mismatch');
  const result = { data:pack(zeroRuns(bytes)), labels:{...labels, checksum:checksum(bytes, labels)} };
  // Same bound as JSON.stringify(result).length without building the string.
  if (JSON.stringify({data:{},labels:result.labels}).length - 2 + packedJsonLength(result.data) > WATER_BODY_WIRE_LIMITS.jsonCharacters) throw new Error('Water body wire exceeds the JSON snapshot budget');
  return result;
}

export function decodeWaterBodyState(water: WaterBodyManifest, wire: WaterBodyWireState): WaterBodyState {
  const d = dimensions(water), labels = wire?.labels;
  if (!labels || !Array.isArray(labels.barriers) || labels.barriers.length > 256 || !Array.isArray(labels.sources)) throw new Error('Invalid water body wire labels');
  if (labels.sources.length) throw new Error('Water body checkpoint holds 3D particle sources, which were removed');
  for (const value of [labels.water, labels.liquid, labels.scene, labels.checksum, ...labels.barriers]) text(value, 'identifier');
  if (JSON.stringify(wire).length > WATER_BODY_WIRE_LIMITS.jsonCharacters) throw new Error('Water body wire exceeds the JSON snapshot budget');
  if (labels.water !== water.revision || labels.liquid !== water.liquid.revision) throw new Error('Water body wire manifest mismatch');
  if (labels.barriers.some(id => !id) || new Set(labels.barriers).size !== labels.barriers.length) throw new Error('Invalid water body wire barrier dictionary');
  const bytes = expandZeroRuns(unpack(wire.data));
  if (checksum(bytes, labels) !== labels.checksum) throw new Error('Water body wire checksum mismatch');
  if (bytes.length < 20) throw new Error('Truncated water body wire header');
  const view = new DataView(bytes.buffer); let at = 0;
  const uint = () => { const n = view.getUint32(at, true); at += 4; return n; };
  const number = () => { const n = view.getFloat64(at, true); at += 8; if (!Number.isFinite(n)) throw new Error('Non-finite water body wire value'); return n; };
  const version=uint();
  if (version >= LEGACY_VERSION && version < LEGACY_VERSION + 4096) throw new Error('Water body checkpoint predates the removal of 3D particle water; record it again');
  const flags=uint(),solids=!!(flags&1),hasDepth=!!(flags&2),hasBoundary=!!(flags&4),hasGraph=!!(flags&8),hasFlights=!!(flags&16);
  if (version !== VERSION || flags > 31 || hasGraph&&(!hasDepth||!hasBoundary) || uint() !== d.cells || uint() !== d.vertices || uint() !== d.x) throw new Error('Water body wire version or dimensions mismatch');
  let depth:NonNullable<WaterBodyState['depthCurrents']>|undefined,depthSize:ReturnType<typeof depthDimensions>|undefined;
  if(hasDepth){if(bytes.length<at+41)throw new Error('Truncated water body depth-current header');const columns=uint(),rows=uint(),layers=uint(),stride=uint();if(!hasGraph)depthSize=depthDimensions(columns,rows,layers,stride);
    const bottom=number(),cellHeight=number(),quietTime=number(),sleeping=bytes[at++];if(sleeping>1)throw new Error('Invalid water body wire depth-current sleeping flag');
    depth={columns,rows,layers,stride,bottom,cellHeight,quietTime,sleeping:!!sleeping,velocityX:[],velocityY:[],velocityZ:[],wet:[]};if(hasGraph){const decoded=readDepthGraph(view,at);depth.graph=decoded.graph;at=decoded.at;depthSize=graphDimensions(decoded.graph);}}
  const baseSize=byteCount(d,solids,depthSize?.bytes);
  if (hasBoundary||hasFlights?bytes.length<baseSize+(hasBoundary?12:0)+(hasFlights?4:0):bytes.length!==baseSize) throw new Error('Water body wire length mismatch');
  const state = {waterRevision:labels.water,sceneRevision:labels.scene} as WaterBodyState;
  for (const key of gridNumbers) state[key] = number();
  for (const key of gridArrays) state[key] = Array.from({length:d.cells}, number);
  if(solids)state.solidDepth=Array.from({length:d.cells},number);
  state.bedVertices = Array.from({length:d.vertices}, number);
  state.sleeping = Array.from({length:d.cells}, () => { const value = bytes[at++]; if (value > 1) throw new Error('Invalid water body wire sleeping flag'); return !!value; });
  const barrier = () => { const index = view.getUint16(at, true); at += 2; if (index > labels.barriers.length) throw new Error('Invalid water body wire barrier index'); return index ? labels.barriers[index - 1] : ''; };
  state.barrierX = Array.from({length:d.x}, barrier); state.barrierZ = Array.from({length:d.z}, barrier);
  if(depth&&depthSize){depth.wet=Array.from({length:depthSize.cells},()=>{const value=bytes[at++];if(value>1)throw new Error('Invalid water body wire depth-current wet flag');return value;});
    depth.velocityX=Array.from({length:depthSize.x},number);depth.velocityY=Array.from({length:depthSize.y},number);depth.velocityZ=Array.from({length:depthSize.z},number);state.depthCurrents=depth;}
  if(hasFlights){const decoded=readFlights(view,at);state.flights=decoded.flights;at=decoded.at;}
  if(hasBoundary)state.boundary=readBoundary(water,view,at);else if(at!==bytes.length)throw new Error('Water body wire length mismatch');
  validateWaterBodyState(water, state);
  if(state.boundary&&water.boundaryMesh&&state.boundary.mesh.revision===water.boundaryMesh.revision&&!sameWaterBoundaryMesh(state.boundary.mesh,water.boundaryMesh))throw new Error('Water body wire boundary mesh identity mismatch');
  return state;
}
