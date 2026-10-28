/** Shared exact support/solid interval queries for authored placement sheets. */
import type {PhysicsScene,PhysicsVector} from './physics.ts';
import {liquidGrounds,liquidObstacles,liquidRotate,collideLiquidGround,type LiquidGround,type LiquidObstacle} from './liquidCollision.ts';
import {physicsConvexFaces} from './physicsGeometry.ts';

export interface WaterSupportPatch {id:string;colliderId?:string;vertices:[PhysicsVector,PhysicsVector,PhysicsVector]}
export interface WaterSupportPlane {x:number;z:number;c:number}
export interface WaterSupportNode {bed:number;ceiling:number;support:string;plane?:WaterSupportPlane;placement:boolean}
export interface WaterSupportGeometry {
  patches:WaterSupportPatch[];placementPatches:WaterSupportPatch[];
  supportById:Map<string,WaterSupportPatch>;grounds:LiquidGround[];obstacles:LiquidObstacle[];
  maxY:number;sx:number;sz:number;
  at(x:number,z:number,retainPlacementParents?:boolean):WaterSupportNode[];
}
const EPS=1e-7;
const nativePrefix='@water-native:';
interface SupportBounds {minX:number;maxX:number;minZ:number;maxZ:number}
interface SupportIndexNode extends SupportBounds {left?:SupportIndexNode;right?:SupportIndexNode;indices?:number[]}
/** One bounded index per prepared static geometry. It only prunes impossible
 * XZ hits; the original exact support/solid predicates still decide coverage. */
function supportIndex(bounds:(SupportBounds|undefined)[]):(x:number,z:number)=>number[] {
  const build=(indices:number[]):SupportIndexNode|undefined=>{
    if(!indices.length)return;
    const node:SupportIndexNode={minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity};
    for(const i of indices){const b=bounds[i]!;node.minX=Math.min(node.minX,b.minX);node.maxX=Math.max(node.maxX,b.maxX);node.minZ=Math.min(node.minZ,b.minZ);node.maxZ=Math.max(node.maxZ,b.maxZ);}
    if(indices.length<=8){node.indices=indices;return node;}
    const alongX=node.maxX-node.minX>=node.maxZ-node.minZ;
    indices.sort((a,b)=>alongX?(bounds[a]!.minX+bounds[a]!.maxX)-(bounds[b]!.minX+bounds[b]!.maxX)||a-b:(bounds[a]!.minZ+bounds[a]!.maxZ)-(bounds[b]!.minZ+bounds[b]!.maxZ)||a-b);
    const middle=Math.floor(indices.length/2);node.left=build(indices.slice(0,middle));node.right=build(indices.slice(middle));return node;
  };
  const always:number[]=[],indexed:number[]=[];for(let i=0;i<bounds.length;i++)(bounds[i]?indexed:always).push(i);const root=build(indexed);
  return(x,z)=>{
    const result=always.slice(),pending=root?[root]:[];
    while(pending.length){const node=pending.pop()!;if(x<node.minX||x>node.maxX||z<node.minZ||z>node.maxZ)continue;
      if(node.indices)for(const i of node.indices){const b=bounds[i]!;if(x>=b.minX&&x<=b.maxX&&z>=b.minZ&&z<=b.maxZ)result.push(i);}
      else{pending.push(node.left!,node.right!);}
    }
    return result.sort((a,b)=>a-b);
  };
}
/** Fixed native surfaces participate automatically. This is the actual box or
 * convex hull face, never a support inferred from a bounding box or a body. */
function nativeSupports(obstacles:LiquidObstacle[]):WaterSupportPatch[]{
  const result:WaterSupportPatch[]=[];
  for(const [index,o] of obstacles.entries()){
    if(o.collider.waterBoundary===false)continue;
    const shape=o.collider.shape;if(shape.kind!=='box'&&shape.kind!=='convex')continue;
    const local=shape.kind==='convex'?shape.vertices:Array.from({length:8},(_,i)=>({x:(i&1?1:-1)*shape.halfExtents.x,y:(i&2?1:-1)*shape.halfExtents.y,z:(i&4?1:-1)*shape.halfExtents.z}));
    const faces=shape.kind==='convex'?physicsConvexFaces(shape):[[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]],vertices=local.map(v=>{
      const p=liquidRotate(v,o.collider.rotation);return{x:p.x+o.collider.position.x,y:p.y+o.collider.position.y,z:p.z+o.collider.position.z};
    });
    for(const [faceIndex,face] of faces.entries())for(let i=1;i+1<face.length;i++){
      const a=vertices[face[0]],b=vertices[face[i]],c=vertices[face[i+1]],up=(b.z-a.z)*(c.x-a.x)-(b.x-a.x)*(c.z-a.z);
      if(up<=1e-12)continue;
      result.push({id:`${nativePrefix}${index}:${faceIndex}:${i}`,colliderId:o.colliderId,vertices:[a,b,c]});
    }
  }
  return result;
}
export function waterSupportHeight(p:WaterSupportPatch,x:number,z:number,inside=true):number|undefined {
  const [a,b,c]=p.vertices,det=(b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z);
  const u=((x-a.x)*(c.z-a.z)-(z-a.z)*(c.x-a.x))/det,v=((b.x-a.x)*(z-a.z)-(b.z-a.z)*(x-a.x))/det;
  if(inside&&(u< -EPS||v< -EPS||u+v>1+EPS))return;
  return a.y+u*(b.y-a.y)+v*(c.y-a.y);
}
export function waterSolidSpan(o:LiquidObstacle,x:number,z:number):[number,number]|undefined {
  if(x<o.min.x-EPS||x>o.max.x+EPS||z<o.min.z-EPS||z>o.max.z+EPS)return;
  const raw={x:x-o.collider.position.x,y:-o.collider.position.y,z:z-o.collider.position.z},p=liquidRotate(raw,o.inverseRotation),up=liquidRotate({x:0,y:1,z:0},o.inverseRotation);
  if(!o.planes)return;
  let low=-Infinity,high=Infinity;
  for(const {normal:n,offset} of o.planes){const rate=n.x*up.x+n.y*up.y+n.z*up.z,d=offset-n.x*p.x-n.y*p.y-n.z*p.z;
    if(Math.abs(rate)<1e-12){if(d< -EPS)return;}else if(rate>0)high=Math.min(high,d/rate);else low=Math.max(low,d/rate);}
  return low<=high+EPS?[low,high]:undefined;
}
export function createWaterSupportGeometry(scene:PhysicsScene,patches:WaterSupportPatch[],options:{maxY:number;cellSizeX:number;cellSizeZ:number}):WaterSupportGeometry {
  if(!Array.isArray(patches)||patches.length>8192||!Number.isFinite(options.maxY)||!Number.isFinite(options.cellSizeX)||options.cellSizeX<=0||!Number.isFinite(options.cellSizeZ)||options.cellSizeZ<=0)throw new Error('Invalid water support geometry');
  // Own the prepared placement data. Caller edits require a fresh preparation;
  // bounds, planes and exact predicates must always describe the same snapshot.
  const ownedScene={...scene,colliders:JSON.parse(JSON.stringify(scene.colliders)) as PhysicsScene['colliders']};
  patches=JSON.parse(JSON.stringify(patches)) as WaterSupportPatch[];
  const obstacles=liquidObstacles(ownedScene,[]),all=patches.slice(),declared=new Map(patches.map(p=>[p.id,p]));
  for(const generated of nativeSupports(obstacles)){
    const existing=declared.get(generated.id);
    if(existing){
      if(existing.colliderId!==generated.colliderId||existing.vertices?.length!==3||existing.vertices.some((p,i)=>p.x!==generated.vertices[i].x||p.y!==generated.vertices[i].y||p.z!==generated.vertices[i].z))throw new Error('Invalid native water support identity');
    }else all.push(generated);
  }
  if(all.length>8192)throw new Error('Water support triangle budget exceeded');patches=all;
  const supportById=new Map<string,WaterSupportPatch>(),planes=new Map<string,WaterSupportPlane>(),placement=new Set<string>(),colliders=new Map(scene.colliders.map((c,i)=>[c.id??`liquid-static-${i}`,c]));
  for(const p of patches){if(!p.id||supportById.has(p.id)||p.vertices?.length!==3||p.vertices.some(v=>!v||['x','y','z'].some(axis=>!Number.isFinite(v[axis as keyof PhysicsVector])||Math.abs(v[axis as keyof PhysicsVector])>10000)))throw new Error('Invalid water support triangle');
    const [a,b,c]=p.vertices,det=(b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z);if(Math.abs(det)<1e-12)throw new Error('Invalid water support plane');
    const x=((b.y-a.y)*(c.z-a.z)-(c.y-a.y)*(b.z-a.z))/det,z=((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y))/det;planes.set(p.id,{x,z,c:a.y-x*a.x-z*a.z});supportById.set(p.id,p);
    if(!p.colliderId||colliders.get(p.colliderId)?.waterBoundary!==false)placement.add(p.id);
  }
  const patchCandidates=supportIndex(patches.map(p=>{
    const [a,b,c]=p.vertices,first=(b.x-a.x)*(c.z-a.z),second=(c.x-a.x)*(b.z-a.z),det=first-second;
    // Near-collinear triangles can have cancellation in the existing floating
    // barycentric predicate. Leave them unpruned instead of changing its hits.
    if(Math.abs(det)<=32*Number.EPSILON*Math.max(1,Math.abs(first),Math.abs(second))/EPS)return;
    const minX=Math.min(...p.vertices.map(v=>v.x)),maxX=Math.max(...p.vertices.map(v=>v.x)),minZ=Math.min(...p.vertices.map(v=>v.z)),maxZ=Math.max(...p.vertices.map(v=>v.z));
    // The barycentric predicate admits u,v >= -EPS and u+v <=1+EPS.
    // Expanding each axis by3*EPS*extent contains that entire larger triangle.
    const margin=3*EPS*Math.max(1,maxX-minX,maxZ-minZ);return{minX:minX-margin,maxX:maxX+margin,minZ:minZ-margin,maxZ:maxZ+margin};
  })),obstacleCandidates=supportIndex(obstacles.map(o=>({minX:o.min.x-EPS,maxX:o.max.x+EPS,minZ:o.min.z-EPS,maxZ:o.max.z+EPS})));
  const freeze=(value:unknown):void=>{if(!value||typeof value!=='object'||Object.isFrozen(value))return;for(const child of Object.values(value))freeze(child);Object.freeze(value);};
  freeze(patches);freeze(obstacles);
  const grounds=liquidGrounds(scene),g:WaterSupportGeometry={patches,placementPatches:patches.filter(p=>placement.has(p.id)),supportById,grounds,obstacles,maxY:options.maxY,sx:options.cellSizeX,sz:options.cellSizeZ,at};
  function at(x:number,z:number,_retainPlacementParents=false):WaterSupportNode[]{
    const candidates:Omit<WaterSupportNode,'ceiling'>[]=[];
    for(const i of patchCandidates(x,z)){const p=patches[i],bed=waterSupportHeight(p,x,z);if(bed!==undefined)candidates.push({bed,support:p.id,plane:planes.get(p.id),placement:placement.has(p.id)});}
    for(const ground of grounds){const hit=collideLiquidGround({x,y:-10001,z},.001,ground);if(hit)candidates.push({bed:hit.point.y,support:ground.id,placement:false});}
    candidates.sort((a,b)=>a.bed-b.bed||a.support.localeCompare(b.support));const result:WaterSupportNode[]=[],ordered:typeof candidates=[];
    for(let i=0;i<candidates.length;){let j=i+1;while(j<candidates.length&&candidates[j].bed-candidates[i].bed<EPS)j++;
      // Preserve declared provenance where its plane and a native face overlap.
      ordered.push(candidates.slice(i,j).find(p=>!p.support.startsWith(nativePrefix))??candidates[i]);i=j;
    }
    const spans=obstacleCandidates(x,z).flatMap(i=>{const o=obstacles[i],span=waterSolidSpan(o,x,z);return span?[{o,span}]:[];});
    for(const candidate of ordered){if(result.length&&Math.abs(result.at(-1)!.bed-candidate.bed)<EPS)continue;
      // Real native top supports now represent wall/tread crests directly.
      // Keeping their buried parent floor would create a second coincident
      // water sheet when the footprint raises that floor to the solid top.
      const buried=spans.some(({span:[bottom,top]})=>bottom<=candidate.bed+EPS&&top>candidate.bed+EPS);
      if(buried)continue;
      const ceiling=Math.min(g.maxY,...spans.filter(({span:[bottom]})=>bottom>candidate.bed+EPS).map(({span:[bottom]})=>bottom));result.push({...candidate,ceiling});
      if(result.length>8)throw new Error('Water support layer budget exceeded');
    }
    return result;
  }
  return g;
}
