/** Exact, static architecture. Metres, Y up, +Z front, yaw in radians.
 * Shared geometry is compiled once; validation never runs in a gameplay tick. */
import type { PhysicsScene, PhysicsVector } from './physics.ts';
import { resolveSurfaceMaterial, type SurfaceMaterialInput, type ResolvedSurfaceMaterial } from './surfaceMaterials.ts';

export type MapVector = PhysicsVector;
export type MapRole = 'floor' | 'terrain' | 'wall' | 'roof' | 'post' | 'beam' | 'fixture' | 'trim' | 'cover' | 'sign' | 'decoration';
export type MapShape = { kind: 'box'; size: MapVector } | { kind: 'gable'; width: number; depth: number; rise: number; thickness?: number };
/** Face-local coordinates in metres, centred on the face. Built-in box faces:
 * top/bottom/front/back/left/right. Gables: bottom/front/back/slope-left/slope-right. */
export interface MapFaceRef { part: string; face: string; region?: { minU: number; maxU: number; minV: number; maxV: number } }
export interface MapMount {
  part: string; face: string; ownFace: string;
  /** Offsets in the target's actual face frame. No arbitrary gap: use a real bracket/chain. */
  u?: number; v?: number; ownU?: number; ownV?: number;
  /** Rotation around Y, relative to parent; only horizontal mating faces allow it. */
  yaw?: number;
  /** Fraction of the smaller mating patch that must meet, default .95. */
  minCoverage?: number;
}
export interface MapPartRecipe {
  id: string; role: MapRole; shape: MapShape;
  /** Absolute placement. A mount replaces position/yaw, never combines guessed coordinates. */
  position?: MapVector; yaw?: number; mount?: MapMount;
  color?: string; material?: SurfaceMaterialInput; collidable?: boolean;
  /** A declared terrain/floor foundation terminates support traversal.
   * Decorative exemption is explicit and remains visible in inspection. */
  support?: 'foundation' | 'decorative';
  /** Optional explicit template bearing zones on this part. Every zone must be
   * covered by verified contacts. Roofs default to two distributed underside strips. */
  bearingRegions?: { face: string; region: NonNullable<MapFaceRef['region']> }[];
}
export interface MapConnection {
  id: string; a: MapFaceRef; b: MapFaceRef;
  kind: 'mate' | 'bearing';
  /** Coverage of a by b, default .95. Define actual bearing zones for overhangs. */
  minCoverage?: number;
}
export interface MapSign {
  /** References a box part; text is placed on its front (+Z) face. */
  part: string; text: string; color?: string; background?: string;
  /** Required static approach points, in world coordinates at actual eye height. */
  approaches: { id: string; position: MapVector; minVisibleFraction?: number; minPixelHeight?: number; viewportHeight?: number; fov?: number }[];
}
export interface MapInspectionView { id: string; position: MapVector; target: MapVector; kind: 'roof' | 'sign' | 'connection' | 'surface' | 'overview' }
export interface MapAssemblyRecipe {
  version: 1; id: string; parts: MapPartRecipe[]; connections?: MapConnection[]; signs?: MapSign[];
  views?: MapInspectionView[];
  /** Custom/imported geometry outside this compiler cannot inherit passing coverage. */
  external?: { id: string; reason: string }[];
}
export interface MapFace {
  id: string; vertices: MapVector[]; normal: MapVector; center: MapVector; u: MapVector; v: MapVector;
}
export interface MapPart {
  id: string; role: MapRole; position: MapVector; yaw: number;
  /** Vertices and outward faces are part-local. Both physics and view use these vertices. */
  vertices: MapVector[]; indices: number[]; faces: MapFace[];
  color: string; material?: ResolvedSurfaceMaterial; collidable: boolean;
  bounds: { min: MapVector; max: MapVector }; sourcePath: string;
}
export type MapCheck = 'geometry' | 'connections' | 'support' | 'surfaces' | 'readability' | 'rendering' | 'traversal';
export interface MapIssue { code: string; check: MapCheck; severity: 'error' | 'incomplete'; ids: string[]; message: string; sourcePath: string; measured?: number; expected?: number }
export interface MapCoverage { check: MapCheck; status: 'passed' | 'failed' | 'incomplete' | 'notApplicable'; checked: number; total: number }
export interface MapAssemblyManifest {
  version: 1; id: string; revision: string; parts: MapPart[]; scene: PhysicsScene;
  signs: MapSign[]; views: MapInspectionView[];
  connections: { id: string; a: MapFaceRef; b: MapFaceRef; gap: number; penetration: number; coverage: number; aligned: boolean }[];
  diagnostics: { valid: boolean; issues: MapIssue[]; issueCount: number; omittedIssues: number; coverage: MapCoverage[]; operations: number };
}
export const MAP_ASSEMBLY_LIMITS = Object.freeze({ parts: 1024, connections: 2048, signs: 64, approaches: 16, views: 256, issues: 128, operations: 2000000, contactTolerance: .002, coplanarTolerance: .004 });

/** Partition overlapping authored XZ regions into disjoint solid floor tiles.
 * Higher priority owns the finish; equal-priority overlaps with different owners fail. */
export interface MapFloorRegion { id: string; x0: number; x1: number; z0: number; z1: number; priority: number; color?: string; material?: SurfaceMaterialInput }
export interface MapFloorOptions { id: string; regions: MapFloorRegion[]; y?: number; thickness?: number; foundation?: boolean }

const V = (x = 0, y = 0, z = 0): MapVector => ({ x, y, z });
const add = (a: MapVector, b: MapVector) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: MapVector, b: MapVector) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: MapVector, s: number) => V(a.x * s, a.y * s, a.z * s);
const dot = (a: MapVector, b: MapVector) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: MapVector, b: MapVector) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const length = (v: MapVector) => Math.hypot(v.x, v.y, v.z);
const unit = (v: MapVector) => mul(v, 1 / length(v));
const snap = (n: number) => Math.round(n * 1e7) / 1e7;
const rotate = (p: MapVector, yaw: number) => V(snap(p.x * Math.cos(yaw) + p.z * Math.sin(yaw)), p.y, snap(p.z * Math.cos(yaw) - p.x * Math.sin(yaw)));
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(id);
const vector = (p: unknown): p is MapVector => plain(p) && keys(p,['x','y','z']) && ['x', 'y', 'z'].every(k => finite(p[k]) && Math.abs(p[k] as number) <= 9000);
const plain = (p: unknown): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p) && [Object.prototype, null].includes(Object.getPrototypeOf(p));
const keys = (p: object, allowed: string[]) => Object.keys(p).every(k => allowed.includes(k));
const bounded = (n: unknown, a: number, b: number): n is number => finite(n) && n >= a && n <= b;
const color = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const requireValue = (ok: unknown, message: string): void => { if (!ok) throw new Error(message); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
/** Runtime Math.hypot implementations can differ by a few ulps. Only the hash
 * copies of derived, dimensionless face directions use a 1e-12 grid (at most
 * 5e-13 per component). Authored coordinates, topology and all other evidence
 * retain exact serialization; the manifest and renderer keep original doubles. */
function revisionParts(parts: MapPart[]): MapPart[] {
  const direction=(v:MapVector):MapVector=>V(Math.round(v.x*1e12)/1e12,Math.round(v.y*1e12)/1e12,Math.round(v.z*1e12)/1e12);
  return parts.map(part=>({...part,faces:part.faces.map(face=>({...face,normal:direction(face.normal),u:direction(face.u),v:direction(face.v)}))}));
}
function hash(value: string): string { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16); }
const generatedId=(value:string)=>value.length<=96?value:`${value.slice(0,80)}:${hash(value)}`;
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function centre(vertices: MapVector[]): MapVector { return mul(vertices.reduce(add, V()), 1 / vertices.length); }

/** Frames are right-handed: top U=+X,V=-Z; bottom U=+X,V=+Z;
 * front U=+X,V=+Y; back U=-X,V=+Y; left U=+Z,V=+Y; right U=-Z,V=+Y. */
function shapeGeometry(shape: MapShape): Pick<MapPart, 'vertices' | 'indices' | 'faces'> {
  requireValue(plain(shape), 'Shape must be a box or closed gable.');
  let vertices: MapVector[], definitions: [string, number[], MapVector][];
  if (shape.kind === 'box') {
    requireValue(keys(shape, ['kind', 'size']) && vector(shape.size) && Object.values(shape.size).every(n => bounded(n, .02, 1000)), 'Box dimensions must be .02..1000 metres.');
    const x = shape.size.x / 2, y = shape.size.y / 2, z = shape.size.z / 2;
    vertices = [V(-x,-y,-z),V(x,-y,-z),V(x,y,-z),V(-x,y,-z),V(-x,-y,z),V(x,-y,z),V(x,y,z),V(-x,y,z)];
    definitions = [['bottom',[0,1,5,4],V(1,0,0)],['top',[3,7,6,2],V(1,0,0)],['front',[4,5,6,7],V(1,0,0)],['back',[1,0,3,2],V(-1,0,0)],['left',[0,4,7,3],V(0,0,1)],['right',[5,1,2,6],V(0,0,-1)]];
  } else {
    requireValue(shape.kind === 'gable' && keys(shape, ['kind', 'width', 'depth', 'rise', 'thickness']) && bounded(shape.width,.04,1000) && bounded(shape.depth,.04,1000) && bounded(shape.rise,.02,100) && (shape.thickness === undefined || bounded(shape.thickness,.02,4)), 'Gable dimensions are invalid.');
    const x=shape.width/2,z=shape.depth/2,t=shape.thickness??.18,r=shape.rise;
    vertices=[V(-x,0,-z),V(x,0,-z),V(x,t,-z),V(0,t+r,-z),V(-x,t,-z),V(-x,0,z),V(x,0,z),V(x,t,z),V(0,t+r,z),V(-x,t,z)];
    definitions=[['bottom',[0,1,6,5],V(1,0,0)],['front',[5,6,7,8,9],V(1,0,0)],['back',[1,0,4,3,2],V(-1,0,0)],['left',[0,5,9,4],V(0,0,1)],['right',[6,1,2,7],V(0,0,-1)],['slope-left',[4,9,8,3],V(0,0,1)],['slope-right',[8,7,2,3],V(0,0,-1)]];
  }
  const indices: number[] = [], faces: MapFace[] = [], interior = centre(vertices);
  for (const [id, source, u] of definitions) {
    let order = [...source], points = order.map(i => vertices[i]);
    let normal = unit(cross(sub(points[1],points[0]),sub(points[2],points[0])));
    if (dot(normal,sub(centre(points),interior)) < 0) { order.reverse(); points=order.map(i=>vertices[i]); normal=mul(normal,-1); }
    for (let i=1;i<order.length-1;i++) indices.push(order[0],order[i],order[i+1]);
    faces.push({id,vertices:points,normal,center:centre(points),u,v:unit(cross(normal,u))});
  }
  return {vertices,indices,faces};
}
function worldFace(part: MapPart, face: MapFace): MapFace {
  return {...face,vertices:face.vertices.map(p=>add(rotate(p,part.yaw),part.position)),center:add(rotate(face.center,part.yaw),part.position),normal:rotate(face.normal,part.yaw),u:rotate(face.u,part.yaw),v:rotate(face.v,part.yaw)};
}
export function mapPartFace(manifest: MapAssemblyManifest, id: string, face: string): MapFace | undefined {
  const part=manifest.parts.find(p=>p.id===id), found=part?.faces.find(f=>f.id===face); return part&&found?worldFace(part,found):undefined;
}
type Point2 = {x:number;y:number};
function area(points: Point2[]): number { let sum=0; for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];sum+=a.x*b.y-b.x*a.y;}return Math.abs(sum)/2; }
function clipHalfPlane(input:Point2[],ax:number,ay:number,c:number):Point2[]{
  const output:Point2[]=[];for(let i=0;i<input.length;i++){const a=input[i],b=input[(i+1)%input.length],da=ax*a.x+ay*a.y+c,db=ax*b.x+ay*b.y+c;if(da>=-1e-9)output.push(a);if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db);output.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});}}return output;
}
/** Exact convex subtraction, retaining disjoint convex remainder pieces. */
function uncoveredPolygons(base:Point2[],covers:Point2[][],tick:()=>void):Point2[][] {
  let remaining=[base];for(const polygon of covers){if(area(polygon)<1e-10)continue;const next:Point2[][]=[];
    let signed=0;for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length];signed+=a.x*b.y-b.x*a.y;}const sign=signed>=0?1:-1;
    for(const original of remaining){let inside=original;for(let i=0;i<polygon.length&&inside.length;i++){tick();const a=polygon[i],b=polygon[(i+1)%polygon.length],ax=-(b.y-a.y)*sign,ay=(b.x-a.x)*sign;if(Math.hypot(ax,ay)<1e-10)continue;const c=-(ax*a.x+ay*a.y);const outside=clipHalfPlane(inside,-ax,-ay,-c);if(area(outside)>1e-9)next.push(outside);inside=clipHalfPlane(inside,ax,ay,c);}}
    if(next.length>512)throw new Error('Surface partition budget exhausted.');remaining=next;
  }return remaining;
}
function clipPolygon(subject: Point2[], boundary: Point2[]): Point2[] {
  let output=subject;
  let signed=0;for(let i=0;i<boundary.length;i++){const a=boundary[i],b=boundary[(i+1)%boundary.length];signed+=a.x*b.y-b.x*a.y;}
  const sign=signed>=0?1:-1;
  for(let i=0;i<boundary.length&&output.length;i++){
    const c=boundary[i],d=boundary[(i+1)%boundary.length],input=output;output=[];
    const side=(p:Point2)=>sign*((d.x-c.x)*(p.y-c.y)-(d.y-c.y)*(p.x-c.x));
    for(let j=0;j<input.length;j++){const a=input[j],b=input[(j+1)%input.length],da=side(a),db=side(b);if(da>=-1e-9)output.push(a);if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db);output.push({x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)});}}
  }return output;
}
const project=(p:MapVector,face:MapFace):Point2=>({x:dot(sub(p,face.center),face.u),y:dot(sub(p,face.center),face.v)});
function regionFace(face:MapFace,region:MapFaceRef['region']):MapFace {
  if(!region)return face;
  requireValue(plain(region)&&keys(region,['minU','maxU','minV','maxV'])&&Object.values(region).every(finite)&&region.maxU>region.minU&&region.maxV>region.minV,'Contact region needs ordered finite metre bounds.');
  const rect=[{x:region.minU,y:region.minV},{x:region.maxU,y:region.minV},{x:region.maxU,y:region.maxV},{x:region.minU,y:region.maxV}];
  requireValue(region.maxU-region.minU>=.001&&region.maxV-region.minV>=.001,'Contact regions require at least 1mm width and height.');
  const boundary=face.vertices.map(p=>project(p,face));let signed=0;for(let i=0;i<boundary.length;i++){const a=boundary[i],b=boundary[(i+1)%boundary.length];signed+=a.x*b.y-b.x*a.y;}
  const sign=signed>=0?1:-1;
  requireValue(rect.every(p=>boundary.every((a,i)=>{const b=boundary[(i+1)%boundary.length],dx=b.x-a.x,dy=b.y-a.y;return sign*(dx*(p.y-a.y)-dy*(p.x-a.x))>=-1e-7*Math.hypot(dx,dy);})), 'Contact region extends beyond the actual face.');
  return {...face,vertices:rect.map(p=>add(face.center,add(mul(face.u,p.x),mul(face.v,p.y))))};
}
function overlapArea(a:MapFace,b:MapFace):number {return area(clipPolygon(a.vertices.map(p=>project(p,a)),b.vertices.map(p=>project(p,a))));}
function overlapPolygon(a:MapFace,b:MapFace):MapVector[]{return clipPolygon(a.vertices.map(p=>project(p,a)),b.vertices.map(p=>project(p,a))).map(p=>add(a.center,add(mul(a.u,p.x),mul(a.v,p.y))));}
function bounds(vertices:MapVector[]):MapPart['bounds'] {return {min:V(Math.min(...vertices.map(p=>p.x)),Math.min(...vertices.map(p=>p.y)),Math.min(...vertices.map(p=>p.z))),max:V(Math.max(...vertices.map(p=>p.x)),Math.max(...vertices.map(p=>p.y)),Math.max(...vertices.map(p=>p.z)))};}
function nearBounds(a:MapPart['bounds'],b:MapPart['bounds'],margin=0):boolean{return ['x','y','z'].every(k=>a.max[k as keyof MapVector]>=b.min[k as keyof MapVector]-margin&&b.max[k as keyof MapVector]>=a.min[k as keyof MapVector]-margin);}
function convexHull(points:Point2[]):Point2[]{
  const sorted=points.sort((a,b)=>a.x-b.x||a.y-b.y).filter((p,i,list)=>!i||Math.abs(p.x-list[i-1].x)+Math.abs(p.y-list[i-1].y)>1e-9);
  if(sorted.length<3)return sorted;const turn=(a:Point2,b:Point2,c:Point2)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const half=(list:Point2[])=>{const out:Point2[]=[];for(const p of list){while(out.length>=2&&turn(out[out.length-2],out[out.length-1],p)<=0)out.pop();out.push(p);}return out;};const lower=half(sorted),upper=half([...sorted].reverse());return [...lower.slice(0,-1),...upper.slice(0,-1)];
}
/** Clip each convex occluder to the eye/sign depth slab, then project its actual
 * silhouette. This catches narrow trim between sample rays and crossing edges. */
function signShadow(eye:MapVector,front:MapFace,occluder:MapFace[]):Point2[]{
  const target=add(front.center,mul(front.normal,.001)),distance=dot(front.normal,sub(eye,target));if(distance<=1e-5)return [];
  const points:MapVector[]=[],depth=(p:MapVector)=>dot(front.normal,sub(eye,p)),near=1e-5,far=distance-1e-5;
  for(const face of occluder)for(let i=0;i<face.vertices.length;i++){const a=face.vertices[i],b=face.vertices[(i+1)%face.vertices.length],da=depth(a),db=depth(b);if(da>=near&&da<=far)points.push(a);
    for(const plane of [near,far])if((da<plane&&db>plane)||(da>plane&&db<plane)){const t=(plane-da)/(db-da);points.push(add(a,mul(sub(b,a),t)));}}
  return convexHull(points.map(p=>project(add(eye,mul(sub(p,eye),distance/depth(p))),front)));
}
function solidPenetration(a:MapFace[],b:MapFace[]):number {
  const av=a.flatMap(f=>f.vertices),bv=b.flatMap(f=>f.vertices),axes=[...a,...b].map(f=>f.normal);
  const edges=(faces:MapFace[])=>faces.flatMap(f=>f.vertices.map((p,i)=>unit(sub(f.vertices[(i+1)%f.vertices.length],p))));
  for(const ea of edges(a))for(const eb of edges(b)){const n=cross(ea,eb);if(length(n)>1e-6)axes.push(unit(n));}
  let depth=Infinity;for(const axis of axes){const ap=av.map(p=>dot(p,axis)),bp=bv.map(p=>dot(p,axis));const overlap=Math.min(Math.max(...ap),Math.max(...bp))-Math.max(Math.min(...ap),Math.min(...bp));if(overlap<=1e-7)return 0;depth=Math.min(depth,overlap);}return depth;
}

/** Compile immutable exact geometry plus independent bounded architecture checks.
 * A passing compile does not imply rendered inspection or controller traversal. */
export function compileMapAssembly(recipe: MapAssemblyRecipe): MapAssemblyManifest {
  const parts:MapPart[]=[],issues:MapIssue[]=[],connections:MapAssemblyManifest['connections']=[],checks:MapCheck[]=['geometry','connections','support','surfaces','readability','rendering','traversal'];
  let issueCount=0,operations=0;
  const totals=new Map<MapCheck,number>(),checked=new Map<MapCheck,number>(),failed=new Set<MapCheck>(),incomplete=new Set<MapCheck>();
  const issue=(check:MapCheck,code:string,ids:string[],message:string,sourcePath:string,measured?:number,expected?:number,severity:MapIssue['severity']='error')=>{issueCount++;(severity==='error'?failed:incomplete).add(check);if(issues.length<MAP_ASSEMBLY_LIMITS.issues)issues.push({check,code,ids,message,sourcePath,...(measured===undefined?{}:{measured}),...(expected===undefined?{}:{expected}),severity});};
  const tick=()=>{if(++operations>MAP_ASSEMBLY_LIMITS.operations)throw new Error('Map validation work budget exhausted; remaining coverage is incomplete.');};
  const attempt=(check:MapCheck,fn:()=>void)=>{try{fn();}catch(e){issue(check,'validation-budget',[],e instanceof Error?e.message:'Validation incomplete','',undefined,undefined,'incomplete');}};
  const sources=new Map<string,MapPartRecipe>(),resolved=new Map<string,MapPart>(),resolving=new Set<string>(),supportEdges=new Map<string,Set<string>>(),allFaces=new Map<string,MapFace[]>();
  const materialCache=new Map<string,ResolvedSurfaceMaterial>();
  const recipeOk=plain(recipe)&&keys(recipe,['version','id','parts','connections','signs','views','external'])&&recipe.version===1&&validId(recipe.id)&&Array.isArray(recipe.parts)&&recipe.parts.length>0&&recipe.parts.length<=MAP_ASSEMBLY_LIMITS.parts;
  if(!recipeOk)issue('geometry','recipe',[],'A version 1 map needs a stable ID and 1..1024 parts.','');
  if(recipeOk)for(let i=0;i<recipe.parts.length;i++){
    const part=recipe.parts[i];if(!plain(part)||!validId(part.id)||sources.has(part.id)){issue('geometry','part-id',[], 'Parts require unique stable IDs.',`parts[${i}]`);continue;}sources.set(part.id,part);
  }
  totals.set('geometry',recipeOk?recipe.parts.length:1);
  function resolve(id:string):MapPart|undefined {
    if(resolved.has(id))return resolved.get(id);
    const source=sources.get(id),path=`parts.${id}`;
    if(!source)return;
    if(resolving.has(id))throw new Error(`Placement cycle at ${id}.`);
    resolving.add(id);
    try{
      requireValue(keys(source,['id','role','shape','position','yaw','mount','color','material','collidable','support','bearingRegions'])&&['floor','terrain','wall','roof','post','beam','fixture','trim','cover','sign','decoration'].includes(source.role),'Unsupported part properties or role.');
      requireValue(source.color===undefined||color(source.color),'Part color must be #rrggbb.');
      requireValue(source.collidable===undefined||typeof source.collidable==='boolean','collidable must be a boolean.');
      requireValue(source.support===undefined||source.support==='foundation'||source.support==='decorative','Invalid support declaration.');
      requireValue(source.support!=='foundation'||['floor','terrain'].includes(source.role),'Only floor/terrain parts can declare a foundation.');
      requireValue(!(source.mount&&(source.position!==undefined||source.yaw!==undefined)),'Mounted parts cannot also carry guessed position/yaw.');
      const geometry=shapeGeometry(source.shape);let position=source.position??V(),yaw=source.yaw??0;
      requireValue(vector(position)&&bounded(yaw,-Math.PI*100,Math.PI*100),'Position/yaw is invalid.');
      if(source.mount){
        const mount=source.mount;
        requireValue(plain(mount)&&keys(mount,['part','face','ownFace','u','v','ownU','ownV','yaw','minCoverage'])&&validId(mount.part)&&['u','v','ownU','ownV'].every(k=>mount[k as 'u']===undefined||bounded(mount[k as 'u'],-1000,1000))&&(mount.minCoverage===undefined||bounded(mount.minCoverage,.5,1)),'Mount needs bounded face offsets and .5..1 coverage.');
        const parent=resolve(mount.part),target=parent?.faces.find(f=>f.id===mount.face),own=geometry.faces.find(f=>f.id===mount.ownFace);
        requireValue(parent&&target&&own,`Mount references missing part/face ${mount.part}.${mount.face} or ${mount.ownFace}.`);
        const actual=worldFace(parent!,target!);const vertical=Math.abs(actual.normal.y)<1e-6&&Math.abs(own!.normal.y)<1e-6;
        const horizontal=Math.abs(actual.normal.y)>.999999&&Math.abs(own!.normal.y)>.999999;
        requireValue(vertical||horizontal,'V1 mounts support horizontal/vertical faces. Sloped joints require explicit bearing checks and authored placement.');
        requireValue(mount.yaw===undefined||horizontal&&bounded(mount.yaw,-Math.PI*2,Math.PI*2),'Relative yaw is supported only on horizontal mounts.');
        yaw=vertical?Math.atan2(actual.normal.x,actual.normal.z)+Math.PI-Math.atan2(own!.normal.x,own!.normal.z):parent!.yaw+(mount.yaw??0);
        requireValue(dot(rotate(own!.normal,yaw),actual.normal)<-.99999,'Mating faces must oppose one another.');
        const targetPoint=add(actual.center,add(mul(actual.u,mount.u??0),mul(actual.v,mount.v??0))),ownPoint=add(own!.center,add(mul(own!.u,mount.ownU??0),mul(own!.v,mount.ownV??0)));
        position=sub(targetPoint,rotate(ownPoint,yaw));
      }
      position=V(snap(position.x),snap(position.y),snap(position.z));yaw=snap(yaw);
      requireValue(vector(position),'Resolved mount is outside map bounds.');
      let material:ResolvedSurfaceMaterial|undefined;
      if(source.material){const key=canonical(source.material);material=materialCache.get(key);if(!material){material=resolveSurfaceMaterial(source.material,{seed:0,key:`map:${hash(key)}`});materialCache.set(key,material);}}
      const part:MapPart={id,role:source.role,...geometry,position,yaw,color:source.color??'#c9bca5',...(material?{material}:{}),collidable:source.collidable??!['trim','fixture','sign','decoration'].includes(source.role),bounds:bounds(geometry.vertices.map(p=>add(rotate(p,yaw),position))),sourcePath:path};
      resolved.set(id,part);allFaces.set(id,part.faces.map(f=>worldFace(part,f)));checked.set('geometry',(checked.get('geometry')??0)+1);return part;
    }catch(e){issue('geometry','part-geometry',[id],e instanceof Error?e.message:'Part could not compile.',path);return undefined;}finally{resolving.delete(id);}
  }
  for(const id of [...sources.keys()].sort())resolve(id);
  parts.push(...[...resolved.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
  const requested:{value:MapConnection; smaller?:boolean}[]=[];
  for(const source of sources.values())if(source.mount)requested.push({value:{id:generatedId(`mount:${source.id}`),kind:'mate',a:{part:source.id,face:source.mount.ownFace},b:{part:source.mount.part,face:source.mount.face},minCoverage:source.mount.minCoverage},smaller:true});
  if(recipeOk&&recipe.connections!==undefined){if(!Array.isArray(recipe.connections)||recipe.connections.length>MAP_ASSEMBLY_LIMITS.connections)issue('connections','connection-budget',[],'Connections exceed the bounded list.','connections');else for(const value of recipe.connections)requested.push({value});}
  totals.set('connections',requested.length);const connectionIds=new Set<string>();
  for(const {value,smaller} of requested){
    const path=`connections.${value?.id??'unknown'}`;
    try{
      requireValue(plain(value)&&keys(value,['id','a','b','kind','minCoverage'])&&validId(value.id)&&!connectionIds.has(value.id)&&['mate','bearing'].includes(value.kind)&&(value.minCoverage===undefined||bounded(value.minCoverage,.5,1)),'Connection needs a unique ID, kind and .5..1 coverage.');connectionIds.add(value.id);
      const face=(ref:MapFaceRef)=>{requireValue(plain(ref)&&keys(ref,['part','face','region'])&&validId(ref.part)&&typeof ref.face==='string','Invalid contact face reference.');const f=allFaces.get(ref.part)?.find(f=>f.id===ref.face);requireValue(f,`Missing contact face ${ref.part}.${ref.face}.`);return regionFace(f!,ref.region);};
      const a=face(value.a),b=face(value.b);requireValue(value.a.part!==value.b.part,'A part cannot support itself.');
      const distances=a.vertices.map(p=>dot(b.normal,sub(p,b.vertices[0]))),gap=Math.max(0,...distances),penetration=Math.max(0,...distances.map(d=>-d)),aligned=dot(a.normal,b.normal)<-.99999;
      const areaA=area(a.vertices.map(p=>project(p,a))),areaB=area(b.vertices.map(p=>project(p,b)));
      const coverage=aligned?Math.min(1,overlapArea(a,b)/(smaller?Math.min(areaA,areaB):areaA)):0;
      connections.push({id:value.id,a:JSON.parse(JSON.stringify(value.a)),b:JSON.parse(JSON.stringify(value.b)),gap,penetration,coverage,aligned});checked.set('connections',(checked.get('connections')??0)+1);
      if(!aligned)issue('connections','contact-orientation',[value.a.part,value.b.part],'Contact surfaces do not face one another.',path);
      else if(gap>MAP_ASSEMBLY_LIMITS.contactTolerance||penetration>MAP_ASSEMBLY_LIMITS.contactTolerance)issue('connections','contact-gap',[value.a.part,value.b.part],`Connection has ${gap.toFixed(4)}m gap / ${penetration.toFixed(4)}m penetration.`,path,Math.max(gap,penetration),MAP_ASSEMBLY_LIMITS.contactTolerance);
      else if(coverage+1e-6<(value.minCoverage??.95))issue('connections','contact-coverage',[value.a.part,value.b.part],'Actual mating area is insufficient. Define the intended bearing region or fit the components.',path,coverage,value.minCoverage??.95);
      else {let parents=supportEdges.get(value.a.part);if(!parents)supportEdges.set(value.a.part,parents=new Set());parents.add(value.b.part);}
    }catch(e){issue('connections','contact-definition',[value?.id??'unknown'],e instanceof Error?e.message:'Invalid contact.',path);}
  }
  const required=parts.filter(p=>!['decoration','trim'].includes(p.role));totals.set('support',required.length);
  // Reverse reachability is linear even for cyclic/converging support graphs.
  // A naive recursive path search becomes exponential on unsupported assemblies.
  const rooted=new Set(parts.filter(p=>sources.get(p.id)?.support==='foundation').map(p=>p.id)),dependents=new Map<string,Set<string>>();
  for(const [child,parents] of supportEdges)for(const parent of parents){let children=dependents.get(parent);if(!children)dependents.set(parent,children=new Set());children.add(child);}
  const queue=[...rooted];for(let i=0;i<queue.length;i++)for(const child of dependents.get(queue[i])??[])if(!rooted.has(child)){rooted.add(child);queue.push(child);}
  const supported=(id:string)=>rooted.has(id);
  for(const part of required){checked.set('support',(checked.get('support')??0)+1);if(sources.get(part.id)?.support==='decorative')issue('support','decorative-support',[part.id],'Support was explicitly exempted; this component has no verified support claim.',part.sourcePath,undefined,undefined,'incomplete');else if(!supported(part.id))issue('support','unsupported-part',[part.id],'No verified connection path reaches a floor/terrain foundation.',part.sourcePath);}
  for(const part of parts){const source=sources.get(part.id)!,shape=source.shape;
    const roofSize=shape.kind==='gable'?{width:shape.width,depth:shape.depth}:part.role==='roof'?{width:shape.size.x,depth:shape.size.z}:undefined;
    const regions=source.bearingRegions??(roofSize?[{face:'bottom',region:{minU:-roofSize.width*.3,maxU:-roofSize.width*.2,minV:-roofSize.depth*.375,maxV:roofSize.depth*.375}},{face:'bottom',region:{minU:roofSize.width*.2,maxU:roofSize.width*.3,minV:-roofSize.depth*.375,maxV:roofSize.depth*.375}}]:[]);
    if(!Array.isArray(regions)||regions.length>16||source.bearingRegions!==undefined&&!regions.length){issue('support','bearing-regions',[part.id],'Explicit bearing regions need 1..16 real face areas; an empty list cannot disable template support.',part.sourcePath);continue;}
    for(const region of regions){try{
      requireValue(plain(region)&&keys(region,['face','region'])&&typeof region.face==='string'&&region.region,'Bearing region requires a real face and metre bounds.');const face=allFaces.get(part.id)!.find(f=>f.id===region.face);requireValue(face,'Bearing face does not exist.');const patch=regionFace(face!,region.region),patchArea=area(patch.vertices.map(p=>project(p,patch)));
      // The declared connected supports must cover each template zone; unrelated
      // nearby decoration and a tiny single contact cannot support a whole roof.
      let covered:Point2[][]=[];
      const patch2=patch.vertices.map(p=>project(p,patch));
      for(const parent of supportEdges.get(part.id)??[]){if(!supported(parent))continue;for(const f of allFaces.get(parent)??[]){if(dot(f.normal,patch.normal)>-.99999||Math.abs(dot(f.normal,sub(patch.center,f.center)))>MAP_ASSEMBLY_LIMITS.contactTolerance)continue;const polygon=clipPolygon(patch2,f.vertices.map(p=>project(p,patch)));if(area(polygon)>1e-8)covered.push(polygon);}}
      // Count the union, never double-count overlapping parents. Partition the
      // convex patch by each support polygon and retain uncovered convex pieces.
      const remaining=uncoveredPolygons(patch2,covered,tick);
      const coverage=1-remaining.reduce((sum,p)=>sum+area(p),0)/patchArea;if(coverage<.95-1e-6)issue('support','bearing-coverage',[part.id],`Required ${region.face} bearing zone is insufficiently supported.`,part.sourcePath+'.bearingRegions',coverage,.95);
    }catch(e){issue('support','bearing-definition',[part.id],e instanceof Error?e.message:'Invalid bearing region.',part.sourcePath);}}
  }
  totals.set('surfaces',parts.length*(parts.length-1)/2);
  attempt('surfaces',()=>{const sorted=[...parts].sort((a,b)=>a.bounds.min.x-b.bounds.min.x);
    for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length;j++){tick();checked.set('surfaces',(checked.get('surfaces')??0)+1);const a=sorted[i],b=sorted[j];if(b.bounds.min.x>a.bounds.max.x+MAP_ASSEMBLY_LIMITS.coplanarTolerance)continue;if(!nearBounds(a.bounds,b.bounds,MAP_ASSEMBLY_LIMITS.coplanarTolerance))continue;
      for(const af of allFaces.get(a.id)!)for(const bf of allFaces.get(b.id)!){tick();if(dot(af.normal,bf.normal)<.99999||Math.abs(dot(af.normal,sub(bf.center,af.center)))>MAP_ASSEMBLY_LIMITS.coplanarTolerance)continue;const overlap=overlapArea(af,bf);if(overlap<=.0001)continue;
        const polygon=overlapPolygon(af,bf).map(p=>project(p,af)),covers:Point2[][]=[];
        for(const p of parts){tick();if(p.id===a.id||p.id===b.id||!nearBounds(p.bounds,a.bounds,.01))continue;let hidden=polygon;
          // Clip the overlap against actual third-solid halfspaces just outside
          // the faces. A union of adjacent floor tiles can bury an entire seam.
          const probe=add(af.center,mul(af.normal,.0001));for(const face of allFaces.get(p.id)!){tick();hidden=clipHalfPlane(hidden,-dot(face.normal,af.u),-dot(face.normal,af.v),-dot(face.normal,sub(probe,face.vertices[0])));if(!hidden.length)break;}if(area(hidden)>1e-9)covers.push(hidden);
        }
        const exposed=uncoveredPolygons(polygon,covers,tick).reduce((sum,p)=>sum+area(p),0);
        if(exposed>.0001)issue('surfaces','surface-overlap',[a.id,b.id],`Competing exposed near-coplanar ${af.id}/${bf.id} surfaces overlap. Partition ownership or use an explicit material region.`,`${a.sourcePath}/${b.sourcePath}`,exposed,0);}
      if(['fixture','sign'].includes(a.role)||['fixture','sign'].includes(b.role)){const depth=solidPenetration(allFaces.get(a.id)!,allFaces.get(b.id)!);if(depth>MAP_ASSEMBLY_LIMITS.contactTolerance)issue('connections','fixture-intersection',[a.id,b.id],'Fixture/sign geometry intersects another solid instead of meeting its surface.',`${a.sourcePath}/${b.sourcePath}`,depth,MAP_ASSEMBLY_LIMITS.contactTolerance);}
    }});
  const signs:MapSign[]=[];const signIds=new Set<string>();
  if(recipeOk&&recipe.signs!==undefined){if(!Array.isArray(recipe.signs)||recipe.signs.length>MAP_ASSEMBLY_LIMITS.signs)issue('readability','sign-budget',[],'Sign list exceeds the bounded limit.','signs');else for(const sign of recipe.signs){try{requireValue(plain(sign)&&keys(sign,['part','text','color','background','approaches'])&&validId(sign.part)&&!signIds.has(sign.part)&&typeof sign.text==='string'&&sign.text.trim().length>0&&sign.text.length<=96&&(!sign.color||color(sign.color))&&(!sign.background||color(sign.background))&&Array.isArray(sign.approaches)&&sign.approaches.length<=MAP_ASSEMBLY_LIMITS.approaches,'Sign requires a unique box part, short text and bounded approach views.');const source=sources.get(sign.part);requireValue(source?.shape.kind==='box'&&resolved.has(sign.part),'Sign part must be a compiled box.');signIds.add(sign.part);signs.push(JSON.parse(JSON.stringify(sign)));}catch(e){issue('readability','sign-definition',[sign?.part??'unknown'],e instanceof Error?e.message:'Invalid sign.','signs');}}}
  totals.set('readability',signs.reduce((n,s)=>n+Math.max(1,s.approaches.length),0));
  attempt('readability',()=>{for(const sign of signs){const front=allFaces.get(sign.part)!.find(f=>f.id==='front')!,xy=front.vertices.map(p=>project(p,front)),w=Math.max(...xy.map(p=>p.x))-Math.min(...xy.map(p=>p.x)),h=Math.max(...xy.map(p=>p.y))-Math.min(...xy.map(p=>p.y));
    if(!sign.approaches.length){issue('readability','sign-approaches',[sign.part],'Sign has no declared approach views.','signs.'+sign.part,undefined,undefined,'incomplete');continue;}
    const ids=new Set<string>();for(const approach of sign.approaches){
      if(!plain(approach)||!keys(approach,['id','position','minVisibleFraction','minPixelHeight','viewportHeight','fov'])||!validId(approach.id)||ids.has(approach.id)||!vector(approach.position)||(approach.minVisibleFraction!==undefined&&!bounded(approach.minVisibleFraction,.5,1))||(approach.minPixelHeight!==undefined&&!bounded(approach.minPixelHeight,8,500))||(approach.viewportHeight!==undefined&&!bounded(approach.viewportHeight,200,4000))||(approach.fov!==undefined&&!bounded(approach.fov,30,120))){issue('readability','sign-approach',[sign.part],'Approach requires a unique ID, finite eye position and bounded view parameters.','signs.'+sign.part);continue;}ids.add(approach.id);checked.set('readability',(checked.get('readability')??0)+1);
      const toEye=sub(approach.position,front.center),distance=length(toEye),facing=distance?dot(front.normal,mul(toEye,1/distance)):0;
      const textArea=[{x:-w*.4,y:-h*.32},{x:w*.4,y:-h*.32},{x:w*.4,y:h*.32},{x:-w*.4,y:h*.32}],shadows:Point2[][]=[],blockers=new Set<string>();
      for(const p of parts){tick();if(p.id===sign.part)continue;const shadow=clipPolygon(signShadow(approach.position,front,allFaces.get(p.id)!),textArea);if(area(shadow)>1e-9){shadows.push(shadow);blockers.add(p.id);}}
      const fraction=facing>=.25?uncoveredPolygons(textArea,shadows,tick).reduce((n,p)=>n+area(p),0)/area(textArea):0,pixels=h*.64*(approach.viewportHeight??1080)/(2*Math.max(distance,.001)*Math.tan((approach.fov??75)*Math.PI/360));
      if(facing<.25)issue('readability','sign-angle',[sign.part],`Sign is viewed too obliquely from approach ${approach.id}.`,'signs.'+sign.part+'.approaches.'+approach.id,facing,.25);
      if(fraction+1e-6<(approach.minVisibleFraction??1))issue('readability','sign-occluded',[sign.part,...[...blockers].slice(0,6)],`Sign is obscured or faces away from approach ${approach.id}.`,'signs.'+sign.part+'.approaches.'+approach.id,fraction,approach.minVisibleFraction??1);
      if(pixels<(approach.minPixelHeight??12))issue('readability','sign-too-small',[sign.part],`Sign text region is too small from approach ${approach.id}.`,'signs.'+sign.part+'.approaches.'+approach.id,pixels,approach.minPixelHeight??12);
    }
  }});
  const views:MapInspectionView[]=[];
  if(recipeOk&&recipe.views!==undefined){if(!Array.isArray(recipe.views)||recipe.views.length>MAP_ASSEMBLY_LIMITS.views)issue('rendering','view-budget',[],'Inspection views exceed the bounded list.','views');else{const ids=new Set<string>();for(const view of recipe.views){if(!plain(view)||!keys(view,['id','position','target','kind'])||!validId(view.id)||ids.has(view.id)||!vector(view.position)||!vector(view.target)||length(sub(view.position,view.target))<.01||!['roof','sign','connection','surface','overview'].includes(view.kind)){issue('rendering','view-definition',[],'Inspection views require unique IDs and distinct finite position/target.','views');continue;}ids.add(view.id);views.push(JSON.parse(JSON.stringify(view)));}}}
  if(recipeOk&&recipe.external!==undefined){if(!Array.isArray(recipe.external)||recipe.external.length>128)issue('geometry','external-budget',[],'External coverage declarations exceed the bounded list.','external');else for(const external of recipe.external){if(!plain(external)||!validId(external.id)||typeof external.reason!=='string'||!external.reason.trim()||external.reason.length>512){issue('geometry','external-definition',[],'External geometry needs an ID and coverage reason.','external');continue;}for(const check of ['geometry','connections','support','surfaces','readability'] as MapCheck[])issue(check,'external-geometry',[external.id],external.reason,'external.'+external.id,undefined,undefined,'incomplete');}}
  incomplete.add('rendering');incomplete.add('traversal');
  totals.set('rendering',parts.length);totals.set('traversal',1);
  const coverage=checks.map(check=>({check,status:failed.has(check)?'failed' as const:incomplete.has(check)?'incomplete' as const:!(totals.get(check)??0)?'notApplicable' as const:'passed' as const,checked:checked.get(check)??0,total:totals.get(check)??0}));
  // Hash only bounded validated outputs. Invalid input may contain cycles or
  // unrelated enormous properties and must never enter recursive serialization.
  const revision='map-assembly-v1-'+hash(canonical({id:recipeOk?recipe.id:'invalid',parts:revisionParts(parts),signs,views,connections,coverage,issues,issueCount}));
  const scene:PhysicsScene={staticMap:{revision},colliders:parts.filter(p=>p.collidable).map(p=>({id:p.id,shape:{kind:'convex' as const,vertices:p.vertices},position:p.position,rotation:{x:0,y:Math.sin(p.yaw/2),z:0,w:Math.cos(p.yaw/2)},friction:.8,restitution:0}))};
  return freeze({version:1,id:recipeOk?recipe.id:'invalid',revision,parts,scene,signs,views,connections,diagnostics:{valid:!failed.size,issues,issueCount,omittedIssues:issueCount-issues.length,coverage,operations}});
}

/** Uses the build-time capture store shared with exact world plans. Namespaced IDs
 * prevent map and world identities colliding. Builders must be static module data. */
export function defineMapAssembly(id:string,build:()=>MapAssemblyRecipe):MapAssemblyManifest {
  requireValue(validId(id),'Map ID is invalid.');
  const globals=globalThis as {__patchduelWorldPlans?:Readonly<Record<string,string>>;__patchduelWorldPlanCapture?:(key:string,json:string)=>void};
  const key=`map-assembly:${id}`,stored=globals.__patchduelWorldPlans?.[key];
  if(typeof stored==='string')return freeze(JSON.parse(stored) as MapAssemblyManifest);
  const manifest=compileMapAssembly(build());requireValue(manifest.id===id,`defineMapAssembly(${id}) received a different recipe ID.`);
  const blocking=manifest.diagnostics.coverage.filter(c=>!['rendering','traversal'].includes(c.check)&&['failed','incomplete'].includes(c.status));
  requireValue(!blocking.length,`Map ${id} failed ${blocking.map(c=>c.check).join(', ')}: ${manifest.diagnostics.issues.slice(0,6).map(i=>i.ids.join('/')+': '+i.message).join('; ')}`);
  globals.__patchduelWorldPlanCapture?.(key,JSON.stringify(manifest));return manifest;
}
export function mapAssemblyInspection(manifest:MapAssemblyManifest,options:{offset?:number;limit?:number}={}) {
  const offset=options.offset??0,limit=options.limit??16;requireValue(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>=1&&limit<=64,'Inspection page requires nonnegative offset and 1..64 limit.');
  return {id:manifest.id,revision:manifest.revision,valid:manifest.diagnostics.valid,coverage:manifest.diagnostics.coverage,parts:manifest.parts.length,colliders:manifest.scene.colliders.length,inspectionViews:manifest.views,issues:manifest.diagnostics.issues.slice(offset,offset+limit),issueCount:manifest.diagnostics.issueCount,omittedIssues:manifest.diagnostics.omittedIssues,nextOffset:offset+limit<manifest.diagnostics.issues.length?offset+limit:null,scope:'Static compiled architecture; rendered representation and real controller traversal require separate inspection.'};
}

export function mapFloorRegions(options:MapFloorOptions):MapPartRecipe[] {
  requireValue(plain(options)&&keys(options,['id','regions','y','thickness','foundation'])&&validId(options.id)&&Array.isArray(options.regions)&&options.regions.length>0&&options.regions.length<=64,'Floor regions need a stable ID and 1..64 regions.');
  const y=options.y??0,thickness=options.thickness??.12;requireValue(bounded(y,-1000,1000)&&bounded(thickness,.02,10)&&(options.foundation===undefined||typeof options.foundation==='boolean'),'Floor elevation/thickness is invalid.');
  const ids=new Set<string>();for(const r of options.regions){requireValue(plain(r)&&keys(r,['id','x0','x1','z0','z1','priority','color','material'])&&validId(r.id)&&!ids.has(r.id)&&[r.x0,r.x1,r.z0,r.z1].every(n=>bounded(n,-1000,1000))&&r.x1>r.x0&&r.z1>r.z0&&Number.isSafeInteger(r.priority),'Floor regions need unique IDs, ordered bounds and integer priorities.');ids.add(r.id);}
  const xs=[...new Set(options.regions.flatMap(r=>[r.x0,r.x1]))].sort((a,b)=>a-b),zs=[...new Set(options.regions.flatMap(r=>[r.z0,r.z1]))].sort((a,b)=>a-b);
  requireValue(xs.length*zs.length<=16384,'Floor partition exceeds the bounded grid.');
  const owners:Array<Array<MapFloorRegion|undefined>>=Array.from({length:zs.length-1},()=>Array(xs.length-1));
  for(let z=0;z<zs.length-1;z++)for(let x=0;x<xs.length-1;x++){
    const candidates=options.regions.filter(r=>r.x0<=xs[x]&&r.x1>=xs[x+1]&&r.z0<=zs[z]&&r.z1>=zs[z+1]).sort((a,b)=>b.priority-a.priority);
    requireValue(candidates.length<2||candidates[0].priority!==candidates[1].priority,'Overlapping floor owners require distinct explicit priorities.');owners[z][x]=candidates[0];
  }
  const result:MapPartRecipe[]=[];
  for(let z=0;z<zs.length-1;z++)for(let x=0;x<xs.length-1;x++){const owner=owners[z][x];if(!owner)continue;let endX=x+1,endZ=z+1;while(endX<xs.length-1&&owners[z][endX]===owner)endX++;while(endZ<zs.length-1&&owners[endZ].slice(x,endX).every(r=>r===owner))endZ++;for(let row=z;row<endZ;row++)for(let col=x;col<endX;col++)owners[row][col]=undefined;
    result.push({id:generatedId(`${options.id}:${hash(owner.id+':'+[xs[x],xs[endX],zs[z],zs[endZ]].join(','))}`),role:'floor',shape:{kind:'box',size:V(xs[endX]-xs[x],thickness,zs[endZ]-zs[z])},position:V((xs[x]+xs[endX])/2,y-thickness/2,(zs[z]+zs[endZ])/2),...(owner.color?{color:owner.color}:{}),...(owner.material?{material:owner.material}:{}),...(options.foundation!==false?{support:'foundation' as const}:{})});
  }
  requireValue(result.length<=MAP_ASSEMBLY_LIMITS.parts,'Floor partition exceeds the part budget.');return result;
}
