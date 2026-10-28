/** Bounded free-surface water on stacked geometry. Static support topology is
 * compiled once; moving bodies never create, merge, or remesh water layers. */
import type {PhysicsScene,PhysicsVector,PhysicsCompoundBody,PhysicsTerrainChunk} from './physics.ts';
import {compileWaterSystem,createWaterSystemState,stepWaterSystem,type WaterSystemManifest,type WaterSystemState,type WaterSystemResult,type WaterSystemSource,type WaterQuality} from './waterSystem.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {createWaterBodyState} from './waterBody.ts';
import {exchangeWaterBodyConnections} from './waterBodyConnections.ts';
import {liquidObstacles,liquidGrounds,collideLiquidGround,liquidRotate,type LiquidObstacle} from './liquidCollision.ts';
import {createWaterSupportGeometry,waterSupportHeight as height,waterSolidSpan as solidSpan,type WaterSupportGeometry as SupportGeometry,type WaterSupportPatch} from './waterSupportGeometry.ts';
import type {WaterBounds,LiquidContact} from './waterDomain.ts';
import {callWaterWorldHost} from './waterSystemBridge.ts';
import {physicsConvexFaces} from './physicsGeometry.ts';
import type {WaterBoundaryRegion} from './waterBoundaryGeometry.ts';
import {mergeWaterDetailEvents,waterFlightDetailEvents} from './waterDetail.ts';
import {waterBodyFlightsVolume,createWaterFlightSolidResponse,type WaterFlightContact} from './waterBodyFlights.ts';
import {applyLiquidImpulses} from './liquidCoupling.ts';
import {physicsBodyMassProperties} from './physicsMassProperties.ts';

export type WaterWorldSupportPatch=WaterSupportPatch;
export interface WaterWorldInitial {point:PhysicsVector;radius:number;level:number}
export interface WaterWorldRecipe {
  id:string;scene:PhysicsScene;supports?:WaterWorldSupportPatch[];bounds?:WaterBounds;
  quality?:WaterQuality;boundaryCells?:boolean;sources?:WaterSystemSource[];initial?:WaterWorldInitial[];
}
export interface WaterWorldLayer {id:string;system:WaterSystemManifest;active:boolean[];ceilings:number[];supportIds:string[]}
export interface WaterWorldLink {a:number;b:number;pointA:{x:number;z:number};pointB:{x:number;z:number};opening?:{start:{x:number;z:number};end:{x:number;z:number}};width:number;distance?:number;sill:number;ceiling:number}
export interface WaterWorldManifest {
  version:'water-world-v1';revision:string;id:string;scene:PhysicsScene;bounds:WaterBounds;
  supports:WaterWorldSupportPatch[];
  layers:WaterWorldLayer[];links:WaterWorldLink[];initial:(WaterWorldInitial&{layer:number})[];
  diagnostics:{columns:number;rows:number;cells:number;layers:number;links:number};
}
export interface WaterWorldState {worldRevision:string;layers:WaterSystemState[];steps:number}
export interface WaterWorldStep {world:WaterWorldManifest;state:WaterWorldState;bodies?:PhysicsCompoundBody[];dt:number;disabledSources?:string[];detail?:boolean}
export interface WaterWorldResult {
  state:WaterWorldState;bodies:PhysicsCompoundBody[];bodyLayers:Record<string,string>;
  layers:WaterSystemResult[];transferredVolume:number;
}
export const WATER_WORLD_LIMITS={layers:8,cells:16384,supports:8192,links:2048,initial:32} as const;
type Point={x:number;z:number};
interface Node {bed:number;ceiling:number;support:string}
// Only compiler-owned, deeply frozen worlds enter this cache. Decoded mutable
// checkpoints prepare geometry per call, so edits cannot retain stale routes.
const supportGeometry=new WeakMap<WaterWorldManifest,SupportGeometry>();
const EPS=1e-7;
function fail(message:string):never{throw new Error(`Invalid water world: ${message}`);}
const hash=(text:string)=>{let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return(h>>>0).toString(16);};
const clone=<T>(value:T):T=>Array.isArray(value)?value.map(clone) as T:value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clone(v)])) as T:value;
function freeze<T>(value:T):T {if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function finite(n:number,label:string,min=-10000,max=10000){if(!Number.isFinite(n)||n<min||n>max)fail(label);}
function representedLayer(g:SupportGeometry,p:PhysicsVector,actual:Node[],parents:(Node|undefined)[],tolerance=0):number|undefined {
  for(let j=actual.length-1;j>=0;j--){const node=actual[j];if(node.bed>p.y+tolerance||p.y>=node.ceiling-EPS)continue;
    for(let k=0;k<parents.length;k++){const parent=parents[k];if(!parent)continue;if(parent.support===node.support)return k;
      // Crossing a triangle diagonal on the same plane is still the same
      // sheet. A missing or unrelated subcell surface is not extrapolated.
      const patch=g.supportById.get(parent.support);if(patch&&Math.abs(height(patch,p.x,p.z,false)!-node.bed)<EPS)return k;
    }
    return;
  }
}
function exactLayer(g:SupportGeometry,p:PhysicsVector,tolerance=0):number|undefined {
  const actual=g.at(p.x,p.z),parents=g.at(p.x,p.z,true);
  for(let j=actual.length-1;j>=0;j--){const node=actual[j];if(node.bed>p.y+tolerance||p.y>=node.ceiling-EPS)continue;
    const k=parents.findIndex(parent=>parent.support===node.support&&Math.abs(parent.bed-node.bed)<EPS);return k<0?undefined:k;
  }
}
function hull(points:Point[]):Point[]{
  const sorted=points.slice().sort((a,b)=>a.x-b.x||a.z-b.z),cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
  const lower:Point[]=[],upper:Point[]=[];for(const p of sorted){while(lower.length>1&&cross(lower.at(-2)!,lower.at(-1)!,p)<=0)lower.pop();lower.push(p);}
  for(const p of sorted.slice().reverse()){while(upper.length>1&&cross(upper.at(-2)!,upper.at(-1)!,p)<=0)upper.pop();upper.push(p);}return lower.slice(0,-1).concat(upper.slice(0,-1));
}
function footprint(o:LiquidObstacle):Point[]{
  const shape=o.collider.shape,vertices=shape.kind==='convex'?shape.vertices:shape.kind==='box'?Array.from({length:8},(_,i)=>({x:(i&1?1:-1)*shape.halfExtents.x,y:(i&2?1:-1)*shape.halfExtents.y,z:(i&4?1:-1)*shape.halfExtents.z})):[];
  return hull(vertices.map(v=>{const p=liquidRotate(v,o.collider.rotation);return{x:p.x+o.collider.position.x,z:p.z+o.collider.position.z};}));
}
function solidPolygons(o:LiquidObstacle):PhysicsVector[][]{
  const shape=o.collider.shape;if(shape.kind!=='box'&&shape.kind!=='convex')return[];
  const vertices=shape.kind==='convex'?shape.vertices:Array.from({length:8},(_,i)=>({x:(i&1?1:-1)*shape.halfExtents.x,y:(i&2?1:-1)*shape.halfExtents.y,z:(i&4?1:-1)*shape.halfExtents.z}));
  const world=vertices.map(v=>{const p=liquidRotate(v,o.collider.rotation);return{x:p.x+o.collider.position.x,y:p.y+o.collider.position.y,z:p.z+o.collider.position.z};});
  const faces=shape.kind==='convex'?physicsConvexFaces(shape):[[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]];return faces.map(f=>f.map(i=>world[i]));
}
function clipSolidColumn(faces:PhysicsVector[][],x0:number,x1:number,z0:number,z1:number):PhysicsVector[]{
  const result:PhysicsVector[]=[];
  for(const face of faces){let polygon=face;for(const [axis,sign,bound] of [['x',-1,-x0],['x',1,x1],['z',-1,-z0],['z',1,z1]] as const){const next:PhysicsVector[]=[];
      for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length],da=sign*a[axis]-bound,db=sign*b[axis]-bound;if(da<=0)next.push(a);if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db);next.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});}}
      polygon=next;if(!polygon.length)break;
    }result.push(...polygon);
  }return result;
}
function segment(poly:Point[],a:Point,b:Point):[number,number]|undefined {
  if(poly.length<3)return;let low=0,high=1;
  for(let i=0;i<poly.length;i++){const p=poly[i],q=poly[(i+1)%poly.length],value=(q.x-p.x)*(a.z-p.z)-(q.z-p.z)*(a.x-p.x),rate=(q.x-p.x)*(b.z-a.z)-(q.z-p.z)*(b.x-a.x);
    if(Math.abs(rate)<1e-12){if(value< -EPS)return;}else if(rate>0)low=Math.max(low,-value/rate);else high=Math.min(high,-value/rate);}
  return low<=high+EPS&&high>=0&&low<=1?[Math.max(0,low),Math.min(1,high)]:undefined;
}
function cellAt(world:WaterWorldManifest,p:Point):number|undefined {
  const w=world.layers[0].system.water,x=Math.floor((p.x-w.origin.x)/w.cellSizeX),z=Math.floor((p.z-w.origin.z)/w.cellSizeZ);
  return x>=0&&z>=0&&x<w.columns&&z<w.rows?x*w.rows+z:undefined;
}
function select(world:WaterWorldManifest,g:SupportGeometry,p:PhysicsVector):number|undefined {
  const i=cellAt(world,p);if(i===undefined)return;
  if(world.layers[0].system.water.boundaryMesh?.supportLayer!==undefined){const k=exactLayer(g,p,.025);return k!==undefined&&k<world.layers.length?k:undefined;}
  return representedLayer(g,p,g.at(p.x,p.z),world.layers.map(layer=>layer.active[i]?{bed:layer.system.water.bed[i],ceiling:layer.ceilings[i],support:layer.supportIds[i]}:undefined),.025);
}
/** Match actual regional edges, including internal subcell edges and open
 * strips beside walls. Coarse column centres are never connection endpoints. */
function regionalLinks(layers:WaterWorldLayer[]):WaterWorldLink[]{
  type Edge={layer:number;region:WaterBoundaryRegion;nx:number;nz:number;a:Point;b:Point;from:number;to:number;ux:number;uz:number;offset:number};
  const bins=new Map<string,Edge[]>(),links:WaterWorldLink[]=[];let work=0;
  for(let layer=0;layer<layers.length;layer++){const mesh=layers[layer].system.water.boundaryMesh!;
    for(const face of mesh.faces)for(const [i,sign] of [[face.a,1],[face.b,-1]]){if(i<0)continue;const region=mesh.regions[i];if(!region.supportId)continue;
      let ux=(face.end.x-face.start.x)/face.length,uz=(face.end.z-face.start.z)/face.length;if(ux< -EPS||Math.abs(ux)<=EPS&&uz<0){ux=-ux;uz=-uz;}
      const offset=-uz*face.start.x+ux*face.start.z,first=ux*face.start.x+uz*face.start.z,last=ux*face.end.x+uz*face.end.z,key=[ux,uz,offset].map(v=>Math.round(v*1e8)).join(','),list=bins.get(key)??[];
      list.push({layer,region,nx:sign*face.nx,nz:sign*face.nz,a:face.start,b:face.end,from:Math.min(first,last),to:Math.max(first,last),ux,uz,offset});bins.set(key,list);
    }
  }
  const planes=new Map<WaterBoundaryRegion,{x:number;z:number}>();
  const planeAt=(r:WaterBoundaryRegion,p:Point)=>{
    if(r.bedMin===r.bedMax)return r.bedMin;
    const polygon=r.polygon,a=polygon[0];let plane=planes.get(r);
    if(!plane){let largest=0;
      for(let k=1;k+1<polygon.length;k++){const b=polygon[k],c=polygon[k+1],det=(b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z);
        if(Math.abs(det)>largest){largest=Math.abs(det);plane={x:((b.bed-a.bed)*(c.z-a.z)-(c.bed-a.bed)*(b.z-a.z))/det,z:((b.x-a.x)*(c.bed-a.bed)-(c.x-a.x)*(b.bed-a.bed))/det};}}
      if(!plane||!Number.isFinite(plane.x)||!Number.isFinite(plane.z))fail('invalid regional opening plane');planes.set(r,plane);
    }
    return a.bed+plane.x*(p.x-a.x)+plane.z*(p.z-a.z);
  };
  const inside=(edge:Edge,p:Point)=>{let distance=Infinity;const dx=-edge.nx,dz=-edge.nz,poly=edge.region.polygon;
    for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],value=(b.x-a.x)*(p.z-a.z)-(b.z-a.z)*(p.x-a.x),rate=(b.x-a.x)*dz-(b.z-a.z)*dx;if(rate< -1e-12)distance=Math.min(distance,Math.max(0,value)/-rate);}
    if(!Number.isFinite(distance)||distance<1e-8)return;return{x:p.x+dx*distance*.5,z:p.z+dz*distance*.5};};
  for(const list of bins.values()){list.sort((a,b)=>a.from-b.from||a.to-b.to||a.layer-b.layer);
    for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length&&list[j].from<list[i].to-EPS;j++){if(++work>8_000_000)fail('regional connection work budget');const a=list[i],b=list[j];if(a.layer===b.layer||a.nx*b.nx+a.nz*b.nz>-.999999)continue;
      const from=Math.max(a.from,b.from),to=Math.min(a.to,b.to);if(to-from<EPS)continue;
      const at=(t:number)=>({x:a.ux*t-a.uz*a.offset,z:a.uz*t+a.ux*a.offset}),start=at(from),end=at(to),middle=at((from+to)*.5),sill=Math.max(planeAt(a.region,start),planeAt(a.region,end),planeAt(b.region,start),planeAt(b.region,end)),ceiling=Math.min(a.region.ceiling!,b.region.ceiling!);
      if(!Number.isFinite(sill)||!Number.isFinite(ceiling))fail('nonfinite regional opening');
      if(ceiling<=sill+EPS)continue;const pointA=inside(a,middle),pointB=inside(b,middle);if(!pointA||!pointB)continue;
      const w=layers[a.layer].system.water,distance=Math.max(Math.hypot(pointB.x-pointA.x,pointB.z-pointA.z),Math.min(w.cellSizeX,w.cellSizeZ));
      links.push({a:a.layer,b:b.layer,pointA,pointB,opening:{start,end},width:to-from,distance,sill,ceiling});if(links.length>WATER_WORLD_LIMITS.links)fail('local connection budget');
    }
  }
  return links;
}
const presets={economy:{cells:1024,minCell:.25},balanced:{cells:2304,minCell:.18},detailed:{cells:4096,minCell:.12}} as const;

/** Enumerate support/solid intervals, preserve one regular solve per sheet,
 * and connect only adjacent free intervals. Ceiling pressure and arbitrary
 * overfilled closed cavities are deliberately rejected by this milestone. */
export function compileWaterWorld(recipe:WaterWorldRecipe):WaterWorldManifest {
  const hosted=callWaterWorldHost(recipe);if(hosted)return hosted;
  if(!recipe||typeof recipe.id!=='string'||!recipe.id||recipe.id.length>70)fail('id');
  const supports=clone(recipe.supports??[]),scene=clone(recipe.scene),quality=recipe.quality??'economy',preset=presets[quality];if(!preset)fail('quality');
  if(supports.length>WATER_WORLD_LIMITS.supports)fail('support budget');
  const ids=new Set<string>();for(const p of supports){if(!p.id||ids.has(p.id)||p.vertices?.length!==3)fail('support identity/triangle');ids.add(p.id);for(const v of p.vertices)for(const axis of ['x','y','z'] as const)finite(v[axis],'support coordinate');const [a,b,c]=p.vertices;if(Math.abs((b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z))<1e-12)fail('support must be an upward nonvertical plane');}
  const grounds=liquidGrounds(scene),obstacles=liquidObstacles(scene,[]),polygons=obstacles.map(footprint);
  const points=supports.flatMap(s=>s.vertices).concat(grounds.flatMap(g=>[{x:g.position.x-g.field.width/2,y:g.position.y+Math.min(...g.field.heights),z:g.position.z-g.field.depth/2},{x:g.position.x+g.field.width/2,y:g.position.y+Math.max(...g.field.heights),z:g.position.z+g.field.depth/2}]));
  if(!points.length)for(const o of obstacles)if(o.collider.waterBoundary!==false&&(o.collider.shape.kind==='box'||o.collider.shape.kind==='convex'))points.push({...o.min},{...o.max});
  if(!points.length)fail('at least one real terrain or support surface is required');
  const bounds=clone(recipe.bounds??{min:{x:Math.min(...points.map(p=>p.x)),y:Math.min(...points.map(p=>p.y))-1,z:Math.min(...points.map(p=>p.z))},max:{x:Math.max(...points.map(p=>p.x)),y:Math.max(...points.map(p=>p.y),...obstacles.map(o=>o.max.y))+2,z:Math.max(...points.map(p=>p.z))}});
  for(const axis of ['x','y','z'] as const){finite(bounds.min[axis],'bounds');finite(bounds.max[axis],'bounds');if(bounds.max[axis]<=bounds.min[axis])fail('positive bounds required');}
  const width=bounds.max.x-bounds.min.x,depth=bounds.max.z-bounds.min.z;let cell=Math.max(preset.minCell,Math.sqrt(width*depth/preset.cells));while(Math.ceil(width/cell)*Math.ceil(depth/cell)>preset.cells)cell*=1.01;
  const columns=Math.ceil(width/cell),rows=Math.ceil(depth/cell),sx=width/columns,sz=depth/rows,count=columns*rows;
  const geometry=createWaterSupportGeometry(scene,supports,{maxY:bounds.max.y,cellSizeX:sx,cellSizeZ:sz}),precise=recipe.boundaryCells!==false&&geometry.placementPatches.length>0;
  if((2*columns+1)*(2*rows+1)*(geometry.patches.length+obstacles.length+grounds.length)>8_000_000)fail('geometry preprocessing work budget');
  const sampled=new Map<string,Node[]>();
  const at=(x:number,z:number):Node[]=>{
    const key=`${x},${z}`,cached=sampled.get(key);if(cached)return cached;
    const result=geometry.at(x,z,true);sampled.set(key,result);return result;
  };
  const centers=Array.from({length:count},(_,i)=>({x:bounds.min.x+(Math.floor(i/rows)+.5)*sx,z:bounds.min.z+(i%rows+.5)*sz})),nodes=centers.map(p=>at(p.x,p.z).map(n=>({...n}))),n=Math.max(...nodes.map(c=>c.length));
  if(!n&&!precise||n>WATER_WORLD_LIMITS.layers||count*n>WATER_WORLD_LIMITS.cells)fail('layer/cell budget');
  // A solid roof need not cover a column's centre. Bound each entire control
  // column by any genuinely overhead solid footprint, retaining the exact
  // support plane test so a ramp never becomes its own overhead ceiling.
  const solids=precise?[]:obstacles.map(solidPolygons);
  for(let i=0;!precise&&i<count;i++){const p=centers[i],x0=p.x-sx/2,x1=p.x+sx/2,z0=p.z-sz/2,z1=p.z+sz/2;
    for(let j=0;j<obstacles.length;j++){const o=obstacles[j];if(o.max.x<=x0+EPS||o.min.x>=x1-EPS||o.max.z<=z0+EPS||o.min.z>=z1-EPS)continue;
      const vertices=clipSolidColumn(solids[j],x0,x1,z0,z1);if(!vertices.length)continue;
      for(const node of nodes[i]){const patch=geometry.supportById.get(node.support),ground=grounds.find(g=>g.id===node.support),bed=(v:PhysicsVector)=>patch?height(patch,v.x,v.z,false)!:ground?collideLiquidGround({x:v.x,y:-10001,z:v.z},.001,ground)?.point.y??node.bed:node.bed;
        if(vertices.every(v=>v.y>bed(v)+EPS))node.ceiling=Math.min(node.ceiling,...vertices.map(v=>v.y));
      }
    }
  }
  const masks=Array.from({length:n},()=>({x:[] as number[],z:[] as number[]})),links:WaterWorldLink[]=[];
  const opening=(a:Node,b:Node,pa:Point,pb:Point):[number,number]|undefined=>{
    let intervals:[number,number][]=[[Math.max(a.bed,b.bed),Math.min(a.ceiling,b.ceiling)]];
    for(let k=0;k<obstacles.length&&intervals.length;k++){
      const clip=segment(polygons[k],pa,pb);if(!clip)continue;const spans:[number,number][]=[];
      for(const t of [clip[0],(clip[0]+clip[1])*.5,clip[1]]){const s=solidSpan(obstacles[k],pa.x+(pb.x-pa.x)*t,pa.z+(pb.z-pa.z)*t);if(s)spans.push(s);}
      if(!spans.length)continue;const low=Math.min(...spans.map(s=>s[0])),high=Math.max(...spans.map(s=>s[1]));
      intervals=intervals.flatMap(([a,b])=>high<=a+EPS||low>=b-EPS?[[a,b] as [number,number]]:[[a,Math.min(b,low)],[Math.max(a,high),b]].filter(([a,b])=>b-a>EPS) as [number,number][]);
    }
    return intervals.find(([a,b])=>b-a>EPS);
  };
  const face=(i:number,j:number,axis:'x'|'z',index:number)=>{
    for(let k=0;k<n;k++)if(!nodes[i][k]||!nodes[j][k]||!opening(nodes[i][k],nodes[j][k],centers[i],centers[j]))masks[k][axis].push(index);
    for(let a=0;a<nodes[i].length;a++)for(let b=0;b<nodes[j].length;b++)if(a!==b){const open=opening(nodes[i][a],nodes[j][b],centers[i],centers[j]);if(open){links.push({a,b,pointA:centers[i],pointB:centers[j],width:axis==='x'?sz:sx,sill:open[0],ceiling:open[1]});if(links.length>WATER_WORLD_LIMITS.links)fail('local connection budget');}}
  };
  for(let x=0;!precise&&x<columns;x++)for(let z=0;z<rows;z++){const i=x*rows+z;if(x+1<columns)face(i,i+rows,'x',(x+1)*rows+z);if(z+1<rows)face(i,i+1,'z',x*(rows+1)+z+1);}
  // Twice the hydraulic resolution includes every centre and vertex exactly.
  // Tile within the existing terrain caps; no phantom interpolated floor is
  // introduced at a stair hole or where support ranks change.
  const terrain=(layer:number):PhysicsTerrainChunk[]=>{
    const chunks:PhysicsTerrainChunk[]=[];
    for(let x=0;x<columns*2;x+=32)for(let z=0;z<rows*2;z+=32){const cx=Math.min(32,columns*2-x),cz=Math.min(32,rows*2-z),heights:number[]=[];
      for(let u=0;u<=cx;u++)for(let v=0;v<=cz;v++)heights.push(at(bounds.min.x+(x+u)*sx/2,bounds.min.z+(z+v)*sz/2)[layer]?.bed??bounds.max.y);
      chunks.push({id:`${recipe.id}:sheet-${layer}:${x}:${z}`,columns:cx,rows:cz,width:cx*sx/2,depth:cz*sz/2,position:{x:bounds.min.x+(x+cx/2)*sx/2,y:0,z:bounds.min.z+(z+cz/2)*sz/2},heights});}
    if(chunks.length>16)fail('terrain tile budget');return chunks;
  };
  const sourceLists=Array.from({length:precise?WATER_WORLD_LIMITS.layers:n},()=>[] as WaterSystemSource[]),sourceIds=new Set<string>();
  const choose=(p:PhysicsVector)=>{const x=Math.floor((p.x-bounds.min.x)/sx),z=Math.floor((p.z-bounds.min.z)/sz);if(x<0||z<0||x>=columns||z>=rows)fail('source/fill point outside bounds');
    const layer=precise?exactLayer(geometry,p):representedLayer(geometry,p,geometry.at(p.x,p.z),nodes[x*rows+z]);if(layer===undefined)fail('source/fill point has no represented supported free interval');if(layer>=WATER_WORLD_LIMITS.layers)fail('layer/cell budget');return layer;};
  if((recipe.sources?.length??0)>32)fail('source budget');
  for(const source of recipe.sources??[]){if(sourceIds.has(source.id))fail('duplicate source id');sourceIds.add(source.id);if(source.point.y===undefined&&n>1)fail('stacked water source requires world Y');const layer=source.point.y===undefined?0:choose(source.point as PhysicsVector);sourceLists[layer].push(source);}
  const layers:WaterWorldLayer[]=[];
  for(let k=0;k<(precise?WATER_WORLD_LIMITS.layers:n);k++){
    if((k+1)*count>WATER_WORLD_LIMITS.cells)fail('layer/cell budget');
    const system=compileWaterSystem({id:`${recipe.id}:layer-${k}`,quality,boundaryCells:recipe.boundaryCells,bounds,sources:sourceLists[k],scene:!supports.length&&!precise&&n===1?scene:{colliders:scene.colliders,terrainChunks:terrain(k)},
      ...(precise?{placementSupports:{patches:geometry.patches,layer:k,...(scene.terrain?{terrain:scene.terrain}:{}),...(scene.terrainChunks?{terrainChunks:scene.terrainChunks}:{})}}:masks[k].x.length||masks[k].z.length?{closedFaces:masks[k]}:{})});
    const mesh=system.water.boundaryMesh;
    if(precise&&!mesh?.regions.some(r=>r.supportId)){if(!k)fail('no supported water region');break;}
    const active=nodes.map(v=>!!v[k]),ceilings=nodes.map(v=>v[k]?.ceiling??bounds.max.y),supportIds=nodes.map(v=>v[k]?.support??'');
    if(precise){active.fill(false);supportIds.fill('');ceilings.fill(bounds.max.y);const areas=Array(count).fill(0);
      for(const region of mesh!.regions)if(region.supportId){active[region.cell]=true;ceilings[region.cell]=Math.min(ceilings[region.cell],region.ceiling!);if(region.area>areas[region.cell]){areas[region.cell]=region.area;supportIds[region.cell]=region.supportId;}}
    }
    layers.push({id:`${recipe.id}:layer-${k}`,system,active,ceilings,supportIds});
  }
  if(layers.length>1&&recipe.sources?.some(source=>source.point.y===undefined))fail('stacked water source requires world Y');
  if(precise)links.push(...regionalLinks(layers));
  // Cut endpoints can occupy less than a whole coarse face. Limit each local
  // opening to its actual region's projected width, retaining distinct pools.
  const lookup=links.length?layers.map(l=>waterBodyCells(l.system.water,createWaterBodyState(l.system.water))):[];
  for(const link of links){const dx=link.pointB.x-link.pointA.x,dz=link.pointB.z-link.pointA.z,length=Math.hypot(dx,dz);for(const [k,p] of [[link.a,link.pointA],[link.b,link.pointB]] as const){const c=lookup[k],i=c.locate(p);if(i===undefined)fail('local link outside support');const values=c.polygon(i).map(v=>(-dz*v.x+dx*v.z)/length);link.width=Math.min(link.width,Math.max(...values)-Math.min(...values));}}
  const initial=(recipe.initial??[]).map(fill=>{for(const axis of ['x','y','z'] as const)finite(fill.point[axis],'fill point');finite(fill.level,'fill level',bounds.min.y,bounds.max.y);finite(fill.radius,'fill radius',.001,256);return{...clone(fill),layer:choose(fill.point)};});if(initial.length>WATER_WORLD_LIMITS.initial)fail('initial fill budget');
  const world:WaterWorldManifest={version:'water-world-v1',revision:'',id:recipe.id,scene,bounds,supports,layers,links,initial,diagnostics:{columns,rows,cells:count*layers.length,layers:layers.length,links:links.length}};
  // Each immutable system revision already covers its complete manifest,
  // including exact placement geometry. Hash only that reference here rather
  // than serializing the same multi-megabyte meshes a second time in the guest.
  world.revision=hash(JSON.stringify({...world,layers:layers.map(({system,...layer})=>({...layer,system:system.revision}))}));freeze(world);supportGeometry.set(world,geometry);return world;
}

export function createWaterWorldState(world:WaterWorldManifest):WaterWorldState {
  const layers=world.layers.map(l=>createWaterSystemState(l.system));
  for(const fill of world.initial){const layer=world.layers[fill.layer],s=layers[fill.layer].water,c=waterBodyCells(layer.system.water,s),home=c.locate(fill.point);if(home===undefined)fail('initial point');
    const adjacent=Array.from({length:c.count},()=>[] as {i:number;sill:number}[]),w=layer.system.water,closedX=new Set(w.closedFaces?.x),closedZ=new Set(w.closedFaces?.z);
    for(const face of c.faces())if(face.b>=0&&!face.barrier?.domain){const a=c.parent(face.a),b=c.parent(face.b),ax=Math.floor(a/w.rows),bx=Math.floor(b/w.rows),az=a%w.rows,bz=b%w.rows;
      if(ax!==bx&&closedX.has(Math.max(ax,bx)*w.rows+az)||az!==bz&&closedZ.has(ax*(w.rows+1)+Math.max(az,bz)))continue;
      const sill=Math.max(face.start.bed,face.end.bed);adjacent[face.a].push({i:face.b,sill});adjacent[face.b].push({i:face.a,sill});}
    const queue=[home],seen=new Set(queue);for(let k=0;k<queue.length;k++){const i=queue[k],p=c.center(i),base=c.parent(i),region=c.region(i),active=s.boundary?.mesh.supportLayer!==undefined?!!region?.supportId:layer.active[base],ceiling=s.boundary?.mesh.supportLayer!==undefined?region!.ceiling!:layer.ceilings[base];if(!active||Math.hypot(p.x-fill.point.x,p.z-fill.point.z)>fill.radius)continue;if(fill.level>=ceiling-EPS)fail('initial fill reaches a solid ceiling; pressure-filled cavities are unsupported');
      c.setVolume(i,Math.max(c.volume(i),c.capacityAtHead(i,fill.level)));for(const edge of adjacent[i])if(!seen.has(edge.i)&&edge.sill<fill.level){seen.add(edge.i);queue.push(edge.i);}}
    c.commit();s.initialVolume=s.depth.reduce((sum,v)=>sum+v*layer.system.water.cellArea,0);
  }
  return{worldRevision:world.revision,layers,steps:0};
}
/** Apply buoyancy/flow to each native body exactly once. Integrate returned
 * poses with the ordinary native physics step in the caller. */
export function stepWaterWorld({world,state,bodies=[],dt,disabledSources,detail}:WaterWorldStep):WaterWorldResult {
  if(state.worldRevision!==world.revision||state.layers.length!==world.layers.length||!Number.isSafeInteger(state.steps)||state.steps<0)fail('state revision');
  const lists=world.layers.map(()=>[] as PhysicsCompoundBody[]),bodyLayers:Record<string,string>={},seen=new Set<string>();
  const w=world.layers[0].system.water,geometry=bodies.length||state.layers.some(l=>l.water.flights?.length)||world.layers.some(l=>l.system.sources.some(source=>source.point.y!==undefined))?(supportGeometry.get(world)??createWaterSupportGeometry(world.scene,world.supports,{maxY:world.bounds.max.y,cellSizeX:w.cellSizeX,cellSizeZ:w.cellSizeZ})):undefined;
  for(const body of bodies){if(seen.has(body.id))fail('duplicate body');seen.add(body.id);const k=select(world,geometry!,body.position);if(k!==undefined){lists[k].push(body);bodyLayers[body.id]=world.layers[k].id;}}
  const results=world.layers.map((layer,k)=>stepWaterSystem({system:layer.system,state:state.layers[k],bodies:lists[k],dt,disabledSources,detail,...(world.layers.length>1||layer.system.water.placementSupports?{flightDestination:layer.system.water.revision}:{})}));
  const coupled=new Map(results.flatMap(r=>r.bodies).map(b=>[b.id,b])),coupledBodies=bodies.map(b=>coupled.get(b.id)??b);
  const hasFlights=results.some(r=>r.state.water.flights?.some(f=>f.destination)),obstacles=hasFlights&&coupledBodies.length?[...(geometry?.obstacles??[]),...liquidObstacles({colliders:[]},coupledBodies)]:geometry?.obstacles;
  const exchange=world.links.length||results.some(r=>r.state.water.flights?.some(f=>f.destination))?exchangeWaterBodyConnections({layers:world.layers.map((layer,k)=>({water:layer.system.water,state:results[k].state.water})),connections:world.links.map((link,i)=>({...link,id:`world-opening:${i}`})),dt,obstacles,bounds:world.bounds,...(hasFlights?{respond:createWaterFlightSolidResponse(coupledBodies,w.liquid.restDensity)}:{})}):{states:results.map(r=>r.state.water),volumes:[],transferredVolume:0,arrivals:world.layers.map(()=>[]),contacts:world.layers.map(()=>[])};
  for(let k=0;k<results.length;k++)if(exchange.states[k]!==results[k].state.water)results[k].state={...results[k].state,water:exchange.states[k]};
  if(detail===true){
    for(let k=0;k<results.length;k++){const w=world.layers[k].system.water;results[k].detail=mergeWaterDetailEvents((results[k].detail??[]).filter(event=>event.kind!=='flight'),waterFlightDetailEvents(w,results[k].state.water,results[k].state.water.flights??[],exchange.arrivals[k],dt));}}
  for(let k=0;k<results.length;k++){const layer=world.layers[k],result=results[k],cells=waterBodyCells(layer.system.water,result.state.water);let volume=0;
    for(let i=0;i<cells.count;i++){const v=cells.volume(i),base=cells.parent(i),region=cells.region(i),precise=result.state.water.boundary?.mesh.supportLayer!==undefined;volume+=v;if(v>1e-12&&(!(precise?region?.supportId:layer.active[base])||cells.level(i)>=(precise?region!.ceiling!:layer.ceilings[base])-EPS))fail('water reached an unsupported column or solid ceiling; pressure-filled cavities are unsupported');}
    const airVolume=waterBodyFlightsVolume(result.state.water.flights);volume+=airVolume;result.stats={...result.stats,volume,airVolume,totalVolume:volume+result.stats.pipeVolume};}
  const reactions=exchange.contacts.map((hits,k)=>flightReactions(hits,coupledBodies,world.layers[k].system.water.liquid.restDensity,dt));
  const moved=applyLiquidImpulses(coupledBodies,flightReactions(exchange.contacts.flat(),coupledBodies,w.liquid.restDensity,dt)),movedById=new Map(moved.map(b=>[b.id,b]));
  for(let k=0;k<results.length;k++){results[k].contacts.push(...reactions[k]);results[k].bodies=results[k].bodies.map(b=>movedById.get(b.id)??b);}
  return{state:{worldRevision:world.revision,layers:results.map(r=>r.state),steps:state.steps+1},bodies:moved,bodyLayers,layers:results,transferredVolume:exchange.transferredVolume};
}

/** Sum one native reaction per collider, retaining the true contact moment. */
function flightReactions(hits:readonly WaterFlightContact[],bodies:readonly PhysicsCompoundBody[],density:number,dt:number):LiquidContact[]{
  const contacts=new Map<string,LiquidContact>(),centers=new Map<string,PhysicsVector>();
  for(const hit of hits){const mass=density*hit.flight.volume,impulse={x:mass*(hit.velocityBefore.x-hit.velocityAfter.x),y:mass*(hit.velocityBefore.y-hit.velocityAfter.y),z:mass*(hit.velocityBefore.z-hit.velocityAfter.z)},key=`${hit.bodyId??''}/${hit.colliderId}`,speed=Math.hypot(impulse.x,impulse.y,impulse.z)/mass;
    const energy=Math.max(0,.5*mass*((hit.velocityBefore.x-hit.solidVelocity.x)**2+(hit.velocityBefore.y-hit.solidVelocity.y)**2+(hit.velocityBefore.z-hit.solidVelocity.z)**2-(hit.velocityAfter.x-hit.solidVelocity.x)**2-(hit.velocityAfter.y-hit.solidVelocity.y)**2-(hit.velocityAfter.z-hit.solidVelocity.z)**2));
    let angularImpulse:PhysicsVector|undefined;
    if(hit.bodyId){let center=centers.get(hit.bodyId);if(!center){const body=bodies.find(b=>b.id===hit.bodyId);if(body){center=physicsBodyMassProperties(body).center;centers.set(body.id,center);}}
      if(center){const r={x:hit.point.x-center.x,y:hit.point.y-center.y,z:hit.point.z-center.z};angularImpulse={x:r.y*impulse.z-r.z*impulse.y,y:r.z*impulse.x-r.x*impulse.z,z:r.x*impulse.y-r.y*impulse.x};}}
    const old=contacts.get(key);
    if(old){old.impulse.x+=impulse.x;old.impulse.y+=impulse.y;old.impulse.z+=impulse.z;old.kineticEnergy+=energy;old.speed=Math.max(old.speed,speed);if(angularImpulse){old.angularImpulse??={x:0,y:0,z:0};old.angularImpulse.x+=angularImpulse.x;old.angularImpulse.y+=angularImpulse.y;old.angularImpulse.z+=angularImpulse.z;}}
    else contacts.set(key,{colliderId:hit.colliderId,...(hit.bodyId?{bodyId:hit.bodyId}:{}),point:{...hit.point},impulse,...(angularImpulse?{angularImpulse}:{}),force:{x:0,y:0,z:0},kineticEnergy:energy,speed});
  }
  for(const c of contacts.values())c.force={x:c.impulse.x/dt,y:c.impulse.y/dt,z:c.impulse.z/dt};return[...contacts.values()];
}
