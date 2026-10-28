/** Geometry for the existing depth-current projection, expressed as a bounded
 * graph of wet world-height layers. Coarsening merges only connected fluid in
 * the same spatial bin, so a thin wall retains distinct columns in one cell. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';
import type {PhysicsVector} from './physics.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {collideLiquid,type LiquidObstacle} from './liquidCollision.ts';
export interface WaterDepthGraph {
  revision:string;
  nodes:{regions:number[];layer:number;volume:number;x:number;z:number;bin:number}[];
  edges:{a:number;b:number;axis:0|1|2;area:number;distance:number;volume:number;x:number;y:number;z:number;group:number}[];
}
const validatedGraphs=new WeakMap<WaterDepthGraph,{water:WaterBodyManifest;mesh:object;rows:number;layers:number;maxCells:number;bottom:number;height:number;stride:number}>();
const immutableMeshes=new WeakSet<object>();
function immutableGeometry(mesh:object):boolean {
  if(immutableMeshes.has(mesh))return true;
  const seen=new Set<object>();
  const frozen=(value:unknown):boolean=>{
    if(!value||typeof value!=='object'||seen.has(value))return true;
    if(!Object.isFrozen(value))return false;seen.add(value);return Object.values(value).every(frozen);
  };
  if(!frozen(mesh))return false;immutableMeshes.add(mesh);return true;
}
/** Exact XZ clipping plus every crossed height layer. Global connectivity alone
 * is insufficient: fluid connected around a shelf cannot trace through it. */
export function traceWaterDepthGraph(t:{cells:ReturnType<typeof waterBodyCells>;graph:WaterDepthGraph;nodeAt:(p:PhysicsVector)=>number;component:Int32Array;adjacent:number[][];bottom:number;height:number;layers:number},a:PhysicsVector,b:PhysicsVector):boolean {
  const {cells,graph,nodeAt,component,adjacent}=t,source=nodeAt(a),target=nodeAt(b),startRegion=cells.locate(a);
  if(target<0||source>=0&&component[source]!==component[target])return false;
  const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,segments:{low:number;high:number;i:number}[]=[];
  for(const i of cells.indices({min:{x:Math.min(a.x,b.x),z:Math.min(a.z,b.z)},max:{x:Math.max(a.x,b.x),z:Math.max(a.z,b.z)}})){
    let low=0,high=1;const polygon=cells.polygon(i);
    for(let k=0;k<polygon.length&&low<=high;k++){
      const p=polygon[k],q=polygon[(k+1)%polygon.length],start=(q.x-p.x)*(a.z-p.z)-(q.z-p.z)*(a.x-p.x),change=(q.x-p.x)*dz-(q.z-p.z)*dx;
      if(Math.abs(change)<1e-15){if(start< -1e-10){low=1;high=0;}continue;}
      const crossing=-start/change;if(change>0)low=Math.max(low,crossing);else high=Math.min(high,crossing);
    }
    if(high-low<1e-10)continue;
    const cuts=[low,high];if(Math.abs(dy)>1e-15)for(let layer=0;layer<=t.layers;layer++){const fraction=(t.bottom+layer*t.height-a.y)/dy;if(fraction>low&&fraction<high)cuts.push(fraction);}
    cuts.sort((x,y)=>x-y);for(let k=1;k<cuts.length;k++)segments.push({low:cuts[k-1],high:cuts[k],i});
  }
  segments.sort((x,y)=>x.low-y.low||x.high-y.high);let previous=-1,entered=false,covered=0;
  for(const segment of segments){
    // A trace exactly on a region edge belongs to the same region selected by
    // point sampling; ignore the duplicate polygon interval at that edge.
    const {low,high,i}=segment,fraction=(low+high)/2,p={x:a.x+dx*fraction,y:a.y+dy*fraction,z:a.z+dz*fraction};
    if(cells.locate(p)!==i)continue;if(low>covered+1e-9)return false;covered=Math.max(covered,high);
    const node=nodeAt(p),head=cells.level(i);
    // Bed and trace are linear in each convex region. Endpoint tests detect
    // even a small intersection that the interval midpoint would miss.
    for(const f of [low+(high-low)*1e-9,high-(high-low)*1e-9]){const x=a.x+dx*f,z=a.z+dz*f,y=a.y+dy*f;if(y<=cells.bedAt(i,x,z)||y>=head)return false;}
    if(node<0){if(source>=0||entered||i!==startRegion)return false;continue;}
    if(previous>=0&&previous!==node&&!adjacent[previous].some(k=>{const e=graph.edges[k];return e.a===node||e.b===node;}))return false;
    previous=node;entered=true;
  }
  return entered&&covered>=1-1e-9;
}
export function buildWaterDepthGraph(w:WaterBodyManifest,s:WaterBodyState,bottom:number,height:number,layers:number,maxCells:number,geo?:WaterBodyGeometry,obstacles:LiquidObstacle[]=geo?.obstacles??[]):{graph:WaterDepthGraph;stride:number}{
  const cells=waterBodyCells(w,s),faces=cells.faces(geo),n=cells.count,total=n*layers,wet=new Float64Array(total),x=new Float64Array(n),z=new Float64Array(n);
  let checks=0;
  const blocked=(p:PhysicsVector)=>{
    for(const o of obstacles)if(p.x>=o.min.x&&p.x<=o.max.x&&p.y>=o.min.y&&p.y<=o.max.y&&p.z>=o.min.z&&p.z<=o.max.z){if(++checks>262144)throw new Error('Water body depth current obstacle budget exceeded');if(collideLiquid(p,p,.00001,o,0))return true;}return false;
  };
  for(let i=0;i<n;i++){
    const p=cells.center(i);x[i]=p.x;z[i]=p.z;if(cells.depth(i)<=w.wetDepth)continue;
    const head=cells.level(i);
    for(let layer=0;layer<layers;layer++){
      const low=bottom+layer*height,high=Math.min(head,low+height),py=low+height*.5;
      if(high<=low||blocked({x:p.x,y:py,z:p.z}))continue;
      wet[i*layers+layer]=Math.max(0,cells.capacityAtHead(i,high)-cells.capacityAtHead(i,low));
    }
  }
  // Coarsening and emitted edges must see the same solid face mask. Cache
  // collision queries across both passes and any budget-driven stride retries.
  const faceMask=new Uint8Array(faces.length*layers);
  const open=(face:number,layer:number)=>{
    const f=faces[face];
    const py=bottom+(layer+.5)*height;
    if(f.barrier&&py>=f.barrier.bottom&&py<=f.barrier.top)return 0;
    const low=Math.min(f.start.bed,f.end.bed),high=Math.max(f.start.bed,f.end.bed);
    if(py<=low)return 0;
    const key=face*layers+layer;
    if(!faceMask[key])faceMask[key]=blocked({x:(f.start.x+f.end.x)/2,y:py,z:(f.start.z+f.end.z)/2})?1:2;
    return faceMask[key]===1?0:py>=high?f.length:f.length*(py-low)/(high-low);
  };
  // Each node covers at most stride² base cells in one layer. Skip only
  // resolutions that provably cannot fit, retaining the finest fitting graph.
  const activeBaseLayers=new Set<number>();for(let i=0;i<total;i++)if(wet[i]>1e-15)activeBaseLayers.add(cells.parent(Math.floor(i/layers))*layers+i%layers);
  let stride=Math.max(1,Math.ceil(Math.sqrt(activeBaseLayers.size/maxCells)));
  while(true){
    const parent=Int32Array.from({length:total},(_,i)=>i),root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const rows=Math.ceil(w.rows/stride),bin=(i:number)=>Math.floor(Math.floor(cells.parent(i)/w.rows)/stride)*rows+Math.floor((cells.parent(i)%w.rows)/stride);
    for(let face=0;face<faces.length;face++){const f=faces[face];if(f.b>=0&&bin(f.a)===bin(f.b))for(let layer=0;layer<layers;layer++){
      const a=f.a*layers+layer,b=f.b*layers+layer;if(!wet[a]||!wet[b]||!open(face,layer))continue;
      const aa=root(a),bb=root(b);if(aa!==bb)parent[bb]=aa;
    }}
    const groups=new Map<number,number[]>();
    for(let i=0;i<total;i++)if(wet[i]>1e-15){const key=root(i),group=groups.get(key)??[];group.push(i);groups.set(key,group);}
    if(groups.size>maxCells){if(stride>=Math.max(w.columns,w.rows))throw new Error('Water body depth current disconnected cell budget exceeded');stride++;continue;}
    const nodes:WaterDepthGraph['nodes']=[],owner=new Int32Array(total).fill(-1);
    for(const members of groups.values()){
      let volume=0,px=0,pz=0;const regions:number[]=[];
      for(const j of members){const i=Math.floor(j/layers);regions.push(i);volume+=wet[j];px+=wet[j]*x[i];pz+=wet[j]*z[i];owner[j]=nodes.length;}
      nodes.push({regions,layer:members[0]%layers,volume,x:px/volume,z:pz/volume,bin:bin(regions[0])});
    }
    const edges:WaterDepthGraph['edges']=[],horizontal=new Map<string,number>();
    const add=(a:number,b:number,axis:0|1|2,area:number,distance:number,p:PhysicsVector,group:number)=>{
      if(a<0||b<0||a===b||Math.abs(area)<1e-15)return;
      const swap=axis===1?nodes[a].layer>nodes[b].layer:nodes[a].bin>nodes[b].bin;if(swap){[a,b]=[b,a];area=-area;}
      const key=`${a}:${b}:${axis}`,previous=horizontal.get(key),v=Math.max(1e-15,Math.abs(area)*distance);
      if(previous!==undefined){const e=edges[previous],weight=Math.abs(e.area)+Math.abs(area);e.x=(e.x*Math.abs(e.area)+p.x*Math.abs(area))/weight;e.y=(e.y*Math.abs(e.area)+p.y*Math.abs(area))/weight;e.z=(e.z*Math.abs(e.area)+p.z*Math.abs(area))/weight;e.area+=area;e.volume+=v;return;}
      horizontal.set(key,edges.length);edges.push({a,b,axis,area,distance,volume:v,x:p.x,y:p.y,z:p.z,group});
    };
    const groupIds=new Map<string,number>();
    for(let face=0;face<faces.length;face++){const f=faces[face];if(f.b>=0)for(let layer=0;layer<layers;layer++){
      const a=owner[f.a*layers+layer],b=owner[f.b*layers+layer];if(a<0||b<0||a===b)continue;
      const length=open(face,layer);if(!length)continue;
      const p={x:(f.start.x+f.end.x)/2,y:bottom+(layer+.5)*height,z:(f.start.z+f.end.z)/2};
      const key=`${Math.min(nodes[a].bin,nodes[b].bin)}:${Math.max(nodes[a].bin,nodes[b].bin)}`,group=groupIds.get(key)??groupIds.size;groupIds.set(key,group);
      const distance=Math.max(Math.min(w.cellSizeX,w.cellSizeZ)*.05,Math.hypot(nodes[a].x-nodes[b].x,nodes[a].z-nodes[b].z));
      add(a,b,0,f.nx*length*height,distance,p,group*2);add(a,b,2,f.nz*length*height,distance,p,group*2+1);
    }}
    for(let i=0;i<n;i++)for(let layer=1;layer<layers;layer++){
      const a=owner[i*layers+layer-1],b=owner[i*layers+layer];if(a<0||b<0)continue;
      const p={x:x[i],y:bottom+layer*height,z:z[i]};if(blocked(p))continue;
      // The integrated layer volume determines the submerged cross-section;
      // dry terrain and displaced solids cannot create an open vertical face.
      const area=Math.min(cells.area(i),wet[i*layers+layer-1]/height,wet[i*layers+layer]/height);
      add(a,b,1,area,height,p,-1);
    }
    if(edges.length>maxCells*12)throw new Error('Water body depth current face budget exceeded');
    return{graph:freezeWaterDepthGraph({revision:s.boundary!.mesh.revision,nodes,edges}),stride};
  }
}
export function validateWaterDepthGraph(w:WaterBodyManifest,s:WaterBodyState,graph:WaterDepthGraph,layers:number,maxCells:number,bottom:number,height:number,stride:number){
  if(!s.boundary||!graph||graph.revision!==s.boundary.mesh.revision||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||graph.nodes.length>maxCells||graph.edges.length>maxCells*12)throw new Error('Invalid water body depth current graph');
  const previous=validatedGraphs.get(graph);
  if(previous?.water===w&&previous.mesh===s.boundary.mesh&&previous.rows===w.rows&&previous.layers===layers&&previous.maxCells===maxCells&&previous.bottom===bottom&&previous.height===height&&previous.stride===stride)return;
  const seen=new Set<number>(),mesh=s.boundary.mesh,regions=mesh.regions.length,owner=new Map<number,number>(),rows=Math.ceil(w.rows/stride);
  let nodeIndex=0;
  for(const node of graph.nodes){
    if(!Number.isInteger(node.layer)||node.layer<0||node.layer>=layers||!Number.isInteger(node.bin)||node.bin<0||!Number.isFinite(node.volume)||node.volume<=0||!Number.isFinite(node.x)||!Number.isFinite(node.z)||!Array.isArray(node.regions)||!node.regions.length)throw new Error('Invalid water body depth current node');
    for(const i of node.regions){const key=i*layers+node.layer;if(!Number.isInteger(i)||i<0||i>=regions||seen.has(key))throw new Error('Invalid water body depth current membership');seen.add(key);owner.set(key,nodeIndex);
      const cell=mesh.regions[i].cell,bin=Math.floor(Math.floor(cell/w.rows)/stride)*rows+Math.floor((cell%w.rows)/stride);
      if(bin!==node.bin)throw new Error('Water depth graph merged different spatial bins');
    }
    const area=node.regions.reduce((sum,i)=>sum+mesh.regions[i].area,0);
    if(node.volume>area*height*(1+1e-8))throw new Error('Water depth graph volume exceeds its geometry');
    nodeIndex++;
  }
  const allowed=new Set<string>(),connected=new Map<number,number>(),root=(key:number):number=>{let current=key;while(connected.has(current)&&connected.get(current)!==current)current=connected.get(current)!;return current;};
  const pair=(a:number,b:number)=>`${Math.min(a,b)}:${Math.max(a,b)}`;
  for(const key of seen)connected.set(key,key);
  for(const face of mesh.faces)if(face.b>=0)for(let layer=0;layer<layers;layer++){
    const py=bottom+(layer+.5)*height,a=owner.get(face.a*layers+layer),b=owner.get(face.b*layers+layer);
    if(a===undefined||b===undefined||py<=Math.min(face.start.bed,face.end.bed))continue;
    const wall=mesh.regions[face.a].solid??mesh.regions[face.b].solid;if(wall&&py>=wall.bottom&&py<=wall.top)continue;
    if(a===b)connected.set(root(face.b*layers+layer),root(face.a*layers+layer));else allowed.add(pair(a,b));
  }
  for(const node of graph.nodes)if(node.regions.some(i=>root(i*layers+node.layer)!==root(node.regions[0]*layers+node.layer)))throw new Error('Water depth graph merged disconnected water');
  const groupKeys=new Map<number,string>();
  for(const edge of graph.edges){
    if(![edge.a,edge.b,edge.axis,edge.group].every(Number.isInteger)||edge.a<0||edge.b<0||edge.a>=graph.nodes.length||edge.b>=graph.nodes.length||edge.a===edge.b||edge.axis<0||edge.axis>2||edge.group< -1||!['area','distance','volume','x','y','z'].every(key=>Number.isFinite(edge[key as keyof typeof edge]))||edge.distance<=0||edge.volume<=0)throw new Error('Invalid water body depth current edge');
    const a=graph.nodes[edge.a],b=graph.nodes[edge.b];
    if(edge.axis===1){if(edge.group!==-1||Math.abs(a.layer-b.layer)!==1||!a.regions.some(i=>b.regions.includes(i)))throw new Error('Invalid water depth graph vertical connection');}
    else{
      if(edge.group<0||a.layer!==b.layer||!allowed.has(pair(edge.a,edge.b)))throw new Error('Water depth graph crosses a closed boundary');
      const key=`${edge.axis}:${Math.min(a.bin,b.bin)}:${Math.max(a.bin,b.bin)}`,previous=groupKeys.get(edge.group);
      if(previous&&previous!==key)throw new Error('Invalid water depth graph transport group');groupKeys.set(edge.group,key);
    }

  }
  freezeWaterDepthGraph(graph);
  // Momentum copies share this frozen graph. Validate it once per exact
  // immutable geometry/configuration; decoded mutable geometry still checks
  // every membership, area and connection on every call.
  if(immutableGeometry(mesh))validatedGraphs.set(graph,{water:w,mesh,rows:w.rows,layers,maxCells,bottom,height,stride});
}

/** Geometry metadata is immutable; cloned momentum states can safely share it. */
export function freezeWaterDepthGraph(graph:WaterDepthGraph):WaterDepthGraph {
  for(const node of graph.nodes){Object.freeze(node.regions);Object.freeze(node);}for(const edge of graph.edges)Object.freeze(edge);
  Object.freeze(graph.nodes);Object.freeze(graph.edges);return Object.freeze(graph);
}
