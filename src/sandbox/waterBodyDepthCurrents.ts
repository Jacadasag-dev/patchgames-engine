/** Bounded, non-hydrostatic circulation inside existing water columns.
 * This field owns momentum only: SWE remains the sole owner of water volume
 * and depth-averaged transport. A constrained MAC pressure projection removes
 * divergence while requiring zero integrated residual flux at each XZ face.
 * Thus a downward jet can turn along the bed and return upward without adding
 * a second horizontal transport solver. World-height layers approximate slopes
 * by impermeable steps; this is not a free-surface/overturning liquid solver. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';
import type {PhysicsVector} from './physics.ts';
import {collideLiquid,type LiquidObstacle} from './liquidCollision.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {buildWaterDepthGraph,validateWaterDepthGraph,traceWaterDepthGraph,type WaterDepthGraph} from './waterBodyDepthGraph.ts';

export interface WaterBodyDepthCurrentConfig {layers?:number;maxCells?:number;iterations?:number;damping?:number;sleepSpeed?:number;sleepAfter?:number;maxSpeed?:number}
export interface WaterBodyDepthCurrentState {
  columns:number;rows:number;layers:number;stride:number;bottom:number;cellHeight:number;
  velocityX:number[];velocityY:number[];velocityZ:number[];wet:number[];quietTime:number;sleeping:boolean;
  graph?:WaterDepthGraph;
}
export interface WaterBodyDepthCurrentStats {cells:number;activeCells:number;iterations:number;divergenceBefore:number;divergenceAfter:number;maxSpeed:number;kineticEnergy:number;sleeping:boolean;budgetLimited:boolean}
type Water=WaterBodyManifest&{depthCurrents?:WaterBodyDepthCurrentConfig|false};
type State=WaterBodyState&{depthCurrents?:WaterBodyDepthCurrentState};
type Config=Required<WaterBodyDepthCurrentConfig>;
/** Immutable once built: cloned states share it. Edges are struct-of-arrays
 * in their original construction order; group g spans groupEdges
 * [groupStart[g],groupStart[g+1]). */
type Topology={count:number;ea:Int32Array;eb:Int32Array;axis:Uint8Array;face:Int32Array;h:Float64Array;
  groupStart:Int32Array;groupEdges:Int32Array;open:Uint8Array[];component:Int32Array;dx:number;dz:number;active:number;
  graph?:WaterDepthGraph;ca?:Float64Array;cb?:Float64Array;mass?:Float64Array;nodeAt?:(p:PhysicsVector)=>number;trace?:(a:PhysicsVector,b:PhysicsVector)=>boolean;adjacent?:number[][]};
const topologyCache=new WeakMap<WaterBodyDepthCurrentState,Topology>();
const couplingCache=new WeakMap<WaterBodyDepthCurrentState,{mass:number;stencil:(point:PhysicsVector)=>WaterBodyDepthCouplingWeight[]}>();
const zero=():PhysicsVector=>({x:0,y:0,z:0});
const valid=(v:number,min:number,max:number)=>Number.isFinite(v)&&v>=min&&v<=max;
export function resolveWaterBodyDepthCurrentConfig(input:WaterBodyDepthCurrentConfig|false={}):Config|false {
  if(input===false)return false;
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid water body depth currents configuration');
  // 1024 cells: object scenes ran 11-28% faster than at 4096, with circulation
  // that still resolves wakes and downwelling at the workshop scales.
  const c:Config={layers:input.layers??4,maxCells:input.maxCells??1024,iterations:input.iterations??24,damping:input.damping??.55,sleepSpeed:input.sleepSpeed??.008,sleepAfter:input.sleepAfter??1,maxSpeed:input.maxSpeed??12};
  for(const [key,min,max] of [['layers',2,12],['maxCells',32,32768],['iterations',1,128],['damping',0,20],['sleepSpeed',0,.5],['sleepAfter',.05,60],['maxSpeed',.01,100]] as const)
    if(!valid(c[key],min,max)||(['layers','maxCells','iterations'].includes(key)&&!Number.isInteger(c[key])))throw new Error(`Invalid water body depth currents ${key}`);
  return c;
}
export function cloneWaterBodyDepthCurrents(s:WaterBodyDepthCurrentState):WaterBodyDepthCurrentState{const copy={...s,velocityX:s.velocityX.slice(),velocityY:s.velocityY.slice(),velocityZ:s.velocityZ.slice(),wet:s.wet.slice()};const cached=topologyCache.get(s);if(cached)topologyCache.set(copy,cached);return copy;}
export function validateWaterBodyDepthCurrents(w:Water,s:State):void {
  const d=s.depthCurrents;if(!d)return;
  if(d.graph){
    const config=resolveWaterBodyDepthCurrentConfig(w.depthCurrents);if(!config)throw new Error('Depth current graph requires enabled currents');
    if(!Number.isInteger(d.layers)||d.layers<2||d.layers>12||!Number.isFinite(d.bottom)||!Number.isFinite(d.cellHeight)||d.cellHeight<=0||!Number.isInteger(d.stride)||d.stride<1)throw new Error('Invalid water body depth current graph dimensions');
    validateWaterDepthGraph(w,s,d.graph,d.layers,config.maxCells,d.bottom,d.cellHeight,d.stride);
    for(const values of arrays(d))if(!Array.isArray(values)||values.length!==d.graph.edges.length||values.some(v=>!valid(v,-1000,1000)))throw new Error('Invalid water body depth current graph velocities');
    if(!Array.isArray(d.wet)||d.wet.length!==d.graph.nodes.length||d.wet.some(v=>v!==0&&v!==1)||!valid(d.quietTime,0,1e9)||typeof d.sleeping!=='boolean')throw new Error('Invalid water body depth current graph state');
    return;
  }
  for(const [v,min,max] of [[d.columns,1,w.columns],[d.rows,1,w.rows],[d.layers,2,12],[d.stride,1,Math.max(w.columns,w.rows)]])if(!Number.isInteger(v)||!valid(v,min,max))throw new Error('Invalid water body depth current dimensions');
  if(d.columns!==Math.ceil(w.columns/d.stride)||d.rows!==Math.ceil(w.rows/d.stride)||d.columns*d.rows*d.layers>32768)throw new Error('Water body depth current cell budget exceeded');
  if(!valid(d.bottom,-10000,10000)||!valid(d.cellHeight,1e-6,10000)||!valid(d.quietTime,0,1e9)||typeof d.sleeping!=='boolean')throw new Error('Invalid water body depth current state');
  for(const [values,count] of [[d.velocityX,(d.columns+1)*d.rows*d.layers],[d.velocityY,d.columns*d.rows*(d.layers+1)],[d.velocityZ,d.columns*(d.rows+1)*d.layers]] as [number[],number][])
    if(!Array.isArray(values)||values.length!==count||values.some(v=>!valid(v,-1000,1000)))throw new Error('Invalid water body depth current face velocities');
  if(!Array.isArray(d.wet)||d.wet.length!==d.columns*d.rows*d.layers||d.wet.some(v=>v!==0&&v!==1))throw new Error('Invalid water body depth current wet mask');
}
const cell=(d:WaterBodyDepthCurrentState,x:number,y:number,z:number)=>(x*d.rows+z)*d.layers+y;
const faceX=(d:WaterBodyDepthCurrentState,x:number,y:number,z:number)=>(x*d.rows+z)*d.layers+y;
const faceY=(d:WaterBodyDepthCurrentState,x:number,y:number,z:number)=>(x*d.rows+z)*(d.layers+1)+y;
const faceZ=(d:WaterBodyDepthCurrentState,x:number,y:number,z:number)=>(x*(d.rows+1)+z)*d.layers+y;
const arrays=(d:WaterBodyDepthCurrentState)=>[d.velocityX,d.velocityY,d.velocityZ];
const depthGraphModeCache=new WeakMap<object,boolean>();
/** Exact surface triangles do not create a second circulation discretization
 * when hydraulic storage is the original uncut rectangular grid. Retain the
 * original MAC budget, interpolation and advection in that ordinary bulk. */
function needsDepthGraph(s:State):boolean {
  const mesh=s.boundary?.mesh;if(!mesh)return false;
  if(Object.isFrozen(mesh)){const previous=depthGraphModeCache.get(mesh);if(previous!==undefined)return previous;}
  const result=!mesh.surface||mesh.regions.length!==mesh.cells.length||mesh.regions.some(r=>!r.bulk)||mesh.cells.some(cell=>cell.length!==1);
  if(Object.isFrozen(mesh))depthGraphModeCache.set(mesh,result);return result;
}
function extent(w:Water,s:State){const cells=waterBodyCells(w,s);let bottom=Infinity,top=-Infinity;for(let i=0;i<cells.count;i++)if(cells.depth(i)>w.wetDepth){bottom=Math.min(bottom,cells.bed(i));top=Math.max(top,cells.level(i));}return{bottom,top};}
function create(w:Water,s:State,c:Config,geo?:WaterBodyGeometry,obstacles?:LiquidObstacle[]):WaterBodyDepthCurrentState|undefined {
  const range=extent(w,s);if(!Number.isFinite(range.bottom)||range.top-range.bottom<.04)return;
  if(needsDepthGraph(s)){
    const cellHeight=(range.top-range.bottom)/c.layers,{graph,stride}=buildWaterDepthGraph(w,s,range.bottom,cellHeight,c.layers,c.maxCells,geo,obstacles);
    return{columns:Math.ceil(w.columns/stride),rows:Math.ceil(w.rows/stride),layers:c.layers,stride,bottom:range.bottom,cellHeight,graph,velocityX:Array(graph.edges.length).fill(0),velocityY:Array(graph.edges.length).fill(0),velocityZ:Array(graph.edges.length).fill(0),wet:Array(graph.nodes.length).fill(1),quietTime:0,sleeping:false};
  }
  let stride=1;while(Math.ceil(w.columns/stride)*Math.ceil(w.rows/stride)*c.layers>c.maxCells)stride++;
  const columns=Math.ceil(w.columns/stride),rows=Math.ceil(w.rows/stride),layers=c.layers;
  return{columns,rows,layers,stride,bottom:range.bottom,cellHeight:(range.top-range.bottom)/layers,velocityX:Array((columns+1)*rows*layers).fill(0),velocityY:Array(columns*rows*(layers+1)).fill(0),velocityZ:Array(columns*(rows+1)*layers).fill(0),wet:Array(columns*rows*layers).fill(0),quietTime:0,sleeping:false};
}
function graphTopology(w:Water,s:State,d:WaterBodyDepthCurrentState):Topology {
  const cached=topologyCache.get(d);if(cached)return cached;
  const graph=d.graph!,n=graph.nodes.length,m=graph.edges.length,cells=waterBodyCells(w,s),owner=new Map<number,number>(),component=Int32Array.from({length:n},(_,i)=>i),adjacent:number[][]=graph.nodes.map(()=>[]);
  const root=(i:number):number=>{while(component[i]!==i){component[i]=component[component[i]];i=component[i];}return i;};
  graph.nodes.forEach((node,i)=>{for(const region of node.regions)owner.set(region*d.layers+node.layer,i);});
  for(const edge of graph.edges){const a=root(edge.a),b=root(edge.b);if(a!==b)component[b]=a;}
  for(let i=0;i<n;i++)component[i]=root(i);
  const ea=new Int32Array(m),eb=new Int32Array(m),axis=new Uint8Array(m),face=new Int32Array(m),h=new Float64Array(m),ca=new Float64Array(m),cb=new Float64Array(m),mass=new Float64Array(m),open=arrays(d).map(a=>new Uint8Array(a.length)),groupMap=new Map<string,number[]>();
  graph.edges.forEach((e,i)=>{ea[i]=e.a;eb[i]=e.b;axis[i]=e.axis;face[i]=i;h[i]=e.distance;mass[i]=e.volume;
    ca[i]=e.area/Math.sqrt(graph.nodes[e.a].volume*e.volume);cb[i]=e.area/Math.sqrt(graph.nodes[e.b].volume*e.volume);open[e.axis][i]=1;adjacent[e.a].push(i);adjacent[e.b].push(i);
    if(e.group>=0){const key=`${e.group}:${component[e.a]}`,list=groupMap.get(key)??[];list.push(i);groupMap.set(key,list);}
  });
  const starts=[0],members:number[]=[];for(const list of groupMap.values()){members.push(...list);starts.push(members.length);}
  const nodeAt=(p:PhysicsVector)=>{const region=cells.locate(p),layer=Math.floor((p.y-d.bottom)/d.cellHeight);return region===undefined||layer<0||layer>=d.layers?-1:owner.get(region*d.layers+layer)??-1;};
  const traceContext={cells,graph,nodeAt,component,adjacent,bottom:d.bottom,height:d.cellHeight,layers:d.layers};
  const trace=(a:PhysicsVector,b:PhysicsVector)=>traceWaterDepthGraph(traceContext,a,b);
  const t:Topology={count:m,ea,eb,axis,face,h,groupStart:Int32Array.from(starts),groupEdges:Int32Array.from(members),open,component,dx:w.cellSizeX*d.stride,dz:w.cellSizeZ*d.stride,active:n,graph,ca,cb,mass,nodeAt,trace,adjacent};topologyCache.set(d,t);return t;
}
function geometry(w:Water,s:State,d:WaterBodyDepthCurrentState,geo?:WaterBodyGeometry,preserveWet=false,obstacles=geo?.obstacles??[]):Topology {
  if(d.graph)return graphTopology(w,s,d);
  if(preserveWet){const cached=topologyCache.get(d);if(cached)return cached;}else{topologyCache.delete(d);couplingCache.delete(d);}
  const dx=w.cellSizeX*d.stride,dz=w.cellSizeZ*d.stride;if(!preserveWet)d.wet.fill(0);let active=preserveWet?d.wet.reduce((sum,v)=>sum+v,0):0,checks=0;
  const hit=(p:PhysicsVector)=>{
    for(let k=0;k<obstacles.length;k++){const o=obstacles[k];if(p.x<o.min.x||p.x>o.max.x||p.y<o.min.y||p.y>o.max.y||p.z<o.min.z||p.z>o.max.z)continue;
      // Fail closed at the explicit obstacle-query ceiling.
      if(++checks>262144||collideLiquid(p,p,.00001,o,0))return true;
    }return false;
  };
  const barrier=(axis:'x'|'z',x:number,z:number,y:number)=>{
    const fineX=x*d.stride,fineZ=z*d.stride;
    for(let offset=0;offset<d.stride;offset++){
      const fx=axis==='x'?fineX:Math.min(w.columns-1,fineX+offset),fz=axis==='z'?fineZ:Math.min(w.rows-1,fineZ+offset);
      const index=axis==='x'?fx*w.rows+fz:fx*(w.rows+1)+fz,b=geo?(axis==='x'?geo.x[index]:geo.z[index]):undefined;
      if(b&&y>=b.bottom&&y<=b.top)return true;
      if(!geo){const signature=(axis==='x'?s.barrierX:s.barrierZ)[index];if(signature){const parts=signature.split('|'),top=Number(parts.at(-1)),bottom=Number(parts.at(-2));if(y>=bottom&&y<=top)return true;}}
    }return false;
  };
  if(!preserveWet)for(let x=0;x<d.columns;x++)for(let z=0;z<d.rows;z++)for(let y=0;y<d.layers;y++){
    const px=w.origin.x+(x+.5)*dx,pz=w.origin.z+(z+.5)*dz,py=d.bottom+(y+.5)*d.cellHeight;
    const fx=Math.min(w.columns-1,x*d.stride+Math.floor(d.stride/2)),fz=Math.min(w.rows-1,z*d.stride+Math.floor(d.stride/2)),i=fx*w.rows+fz;
    if(s.depth[i]<=w.wetDepth||py<=s.bed[i]||py>=s.bed[i]+s.depth[i]+(s.solidDepth?.[i]??0)||geo?.blocked[i]||hit({x:px,y:py,z:pz}))continue;
    // Coarsened cells spanning a retaining wall are excluded rather than
    // allowing a subgrid dam to disappear between coarse face coordinates.
    let blocked=false;if(d.stride>1)for(let k=1;k<d.stride&&!blocked;k++){
      const xx=x*d.stride+k,zz=z*d.stride+k;
      if(xx<w.columns){const b=geo?.x[xx*w.rows+fz];blocked=!!b&&py>=b.bottom&&py<=b.top;}
      if(zz<w.rows){const b=geo?.z[fx*(w.rows+1)+zz];blocked||=!!b&&py>=b.bottom&&py<=b.top;}
    }
    if(!blocked){d.wet[cell(d,x,y,z)]=1;active++;}
  }
  const capacity=Math.max(0,(d.columns-1)*d.rows*d.layers)+Math.max(0,d.columns*(d.rows-1)*d.layers)+d.columns*d.rows*(d.layers-1);
  const ea=new Int32Array(capacity),eb=new Int32Array(capacity),axes=new Uint8Array(capacity),faces=new Int32Array(capacity),heights=new Float64Array(capacity),starts:number[]=[],members:number[]=[];let count=0;
  const add=(a:number,b:number,axis:0|1|2,face:number,h:number,p:PhysicsVector,grouped:boolean)=>{if(d.wet[a]&&d.wet[b]&&!hit(p)){if(grouped)members.push(count);ea[count]=a;eb[count]=b;axes[count]=axis;faces[count]=face;heights[count]=h;count++;}};
  for(let x=1;x<d.columns;x++)for(let z=0;z<d.rows;z++){
    const start=members.length;for(let y=0;y<d.layers;y++){const py=d.bottom+(y+.5)*d.cellHeight;if(!barrier('x',x,z,py))add(cell(d,x-1,y,z),cell(d,x,y,z),0,faceX(d,x,y,z),dx,{x:w.origin.x+x*dx,y:py,z:w.origin.z+(z+.5)*dz},true);}if(members.length>start)starts.push(start);
  }
  for(let x=0;x<d.columns;x++)for(let z=1;z<d.rows;z++){
    const start=members.length;for(let y=0;y<d.layers;y++){const py=d.bottom+(y+.5)*d.cellHeight;if(!barrier('z',x,z,py))add(cell(d,x,y,z-1),cell(d,x,y,z),2,faceZ(d,x,y,z),dz,{x:w.origin.x+(x+.5)*dx,y:py,z:w.origin.z+z*dz},true);}if(members.length>start)starts.push(start);
  }
  for(let x=0;x<d.columns;x++)for(let z=0;z<d.rows;z++)for(let y=1;y<d.layers;y++)add(cell(d,x,y-1,z),cell(d,x,y,z),1,faceY(d,x,y,z),d.cellHeight,{x:w.origin.x+(x+.5)*dx,y:d.bottom+y*d.cellHeight,z:w.origin.z+(z+.5)*dz},false);
  starts.push(members.length);
  const open=arrays(d).map(values=>new Uint8Array(values.length));for(let i=0;i<count;i++)open[axes[i]][faces[i]]=1;
  const component=Int32Array.from(d.wet,(_,i)=>i),find=(i:number):number=>{let root=i;while(component[root]!==root)root=component[root];while(component[i]!==i){const next=component[i];component[i]=root;i=next;}return root;};
  for(let i=0;i<count;i++){const a=find(ea[i]),b=find(eb[i]);if(a!==b)component[b]=a;}for(let i=0;i<component.length;i++)component[i]=find(i);
  const result:Topology={count,ea:ea.subarray(0,count),eb:eb.subarray(0,count),axis:axes.subarray(0,count),face:faces.subarray(0,count),h:heights.subarray(0,count),
    groupStart:Int32Array.from(starts),groupEdges:Int32Array.from(members),open,component,dx,dz,active};
  topologyCache.set(d,result);return result;
}
/** Reject a semi-Lagrangian trace which crosses a closed MAC face. Sampling
 * only the end position lets strong currents tunnel through a thin dam. */
function traceOpen(w:Water,d:WaterBodyDepthCurrentState,t:Topology,sx:number,sy:number,sz:number,ex:number,ey:number,ez:number):boolean {
  if(t.trace)return t.trace({x:sx,y:sy,z:sz},{x:ex,y:ey,z:ez});
  const count=Math.ceil(Math.max(Math.abs(ex-sx)/t.dx,Math.abs(ey-sy)/d.cellHeight,Math.abs(ez-sz)/t.dz)*2.1);
  if(count>128)return false;
  let ox=Math.floor((sx-w.origin.x)/t.dx),oy=Math.floor((sy-d.bottom)/d.cellHeight),oz=Math.floor((sz-w.origin.z)/t.dz);
  if(!(ox>=0&&ox<d.columns&&oy>=0&&oy<d.layers&&oz>=0&&oz<d.rows&&d.wet[cell(d,ox,oy,oz)]!==0))return false;
  for(let k=1;k<=count;k++){
    const fraction=k/count,nx=Math.floor((sx+(ex-sx)*fraction-w.origin.x)/t.dx),ny=Math.floor((sy+(ey-sy)*fraction-d.bottom)/d.cellHeight),nz=Math.floor((sz+(ez-sz)*fraction-w.origin.z)/t.dz);
    if(!(nx>=0&&nx<d.columns&&ny>=0&&ny<d.layers&&nz>=0&&nz<d.rows&&d.wet[cell(d,nx,ny,nz)]!==0))return false;
    if(nx!==ox&&!t.open[0][faceX(d,Math.max(nx,ox),oy,oz)])return false;
    if(ny!==oy&&!t.open[1][faceY(d,nx,Math.max(ny,oy),oz)])return false;
    if(nz!==oz&&!t.open[2][faceZ(d,nx,ny,Math.max(nz,oz))])return false;
    ox=nx;oy=ny;oz=nz;
  }
  return true;
}
function constrain(values:Float64Array,t:Topology,weighted=false){
  const starts=t.groupStart,members=t.groupEdges;
  for(let g=0;g+1<starts.length;g++){
    const from=starts[g],to=starts[g+1];let sum=0,denominator=0;
    for(let k=from;k<to;k++){const i=members[k],area=t.graph?.edges[i].area??1,mass=t.mass?.[i]??1,coefficient=weighted?area/Math.sqrt(mass):area;sum+=values[i]*coefficient;denominator+=area*area/mass;}
    if(!denominator)continue;
    for(let k=from;k<to;k++){const i=members[k],area=t.graph?.edges[i].area??1,mass=t.mass?.[i]??1;values[i]-=sum/denominator*area/(weighted?Math.sqrt(mass):mass);}
  }
}
function divergence(t:Topology,u:Float64Array,result:Float64Array){result.fill(0);for(let i=0;i<t.count;i++){result[t.ea[i]]+=u[i]*(t.ca?.[i]??1/t.h[i]);result[t.eb[i]]-=u[i]*(t.cb?.[i]??1/t.h[i]);}return result;}
const norm=(v:Float64Array)=>{let sum=0;for(let i=0;i<v.length;i++)sum+=v[i]*v[i];return Math.sqrt(sum);};
/** Reused solver buffers. A projection never re-enters, so sharing them is safe. */
const pool:Float64Array[]=[];
function buffer(slot:number,size:number):Float64Array{let b=pool[slot];if(!b||b.length<size)b=pool[slot]=new Float64Array(Math.max(size,(b?.length??0)*2));return b.subarray(0,size);}
function buffers(cells:number,edges:number){return{cell:(i:number)=>buffer(i,cells),edge:(i:number)=>buffer(8+i,edges)};}
function project(d:WaterBodyDepthCurrentState,t:Topology,c:Config){
  const faces=arrays(d),n=d.wet.length,m=t.count,b=buffers(n,m),u=b.edge(0),g=b.edge(1);
  for(let i=0;i<m;i++)u[i]=faces[t.axis[i]][t.face[i]]*Math.sqrt(t.mass?.[i]??1);constrain(u,t,true);
  const div=divergence(t,u,b.cell(0)),before=norm(div)/Math.sqrt(Math.max(1,t.active)),r=b.cell(1),direction=b.cell(2),pressure=b.cell(3),ap=b.cell(4);
  for(let i=0;i<n;i++){r[i]=-div[i];direction[i]=r[i];}pressure.fill(0);g.fill(0);
  let rr=0;for(let i=0;i<n;i++)rr+=r[i]*r[i];let iterations=0;const target=Math.max(1e-16,rr*1e-8);
  for(;iterations<c.iterations&&rr>target;iterations++){
    for(let i=0;i<m;i++)g[i]=(direction[t.eb[i]]*(t.cb?.[i]??1/t.h[i])-direction[t.ea[i]]*(t.ca?.[i]??1/t.h[i]));constrain(g,t,true);ap.fill(0);
    for(let i=0;i<m;i++){ap[t.ea[i]]-=g[i]*(t.ca?.[i]??1/t.h[i]);ap[t.eb[i]]+=g[i]*(t.cb?.[i]??1/t.h[i]);}
    let denominator=0;for(let i=0;i<n;i++)denominator+=direction[i]*ap[i];if(denominator<1e-24)break;
    const alpha=rr/denominator;let next=0;for(let i=0;i<n;i++){pressure[i]+=alpha*direction[i];r[i]-=alpha*ap[i];next+=r[i]*r[i];}
    const beta=next/rr;for(let i=0;i<n;i++)direction[i]=r[i]+beta*direction[i];rr=next;
  }
  for(let i=0;i<m;i++)g[i]=(pressure[t.eb[i]]*(t.cb?.[i]??1/t.h[i])-pressure[t.ea[i]]*(t.ca?.[i]??1/t.h[i]));constrain(g,t,true);
  let energy=0,original=0,maxSpeed=0;for(let i=0;i<m;i++){original+=u[i]*u[i];u[i]-=g[i];energy+=u[i]*u[i];maxSpeed=Math.max(maxSpeed,Math.abs(u[i])/Math.sqrt(t.mass?.[i]??1));}
  // Truncated/singular solves may not be an exact orthogonal projection.
  // A uniform scale enforces both energy and speed bounds without adding
  // divergence or changing the zero-mean constraint.
  const scale=Math.min(1,energy>original?Math.sqrt(original/Math.max(energy,1e-30)):1,c.maxSpeed/Math.max(maxSpeed,1e-30));
  for(const a of faces)a.fill(0);for(let i=0;i<m;i++){u[i]*=scale;faces[t.axis[i]][t.face[i]]=u[i]/Math.sqrt(t.mass?.[i]??1);}
  return{iterations,divergenceBefore:before,divergenceAfter:norm(divergence(t,u,div))/Math.sqrt(Math.max(1,t.active)),maxSpeed:maxSpeed*scale,kineticEnergy:energy*scale*scale*(t.mass?1:t.dx*t.dz*d.cellHeight)*.5};
}
type Values=ArrayLike<number>;
/** Face-centred trilinear sample. With a topology, only open faces of the
 * sampled cell's own component contribute (no reach through a wall). */
function trilinear(a:Values,nx:number,ny:number,nz:number,x:number,y:number,z:number,d:WaterBodyDepthCurrentState,t:Topology|undefined,axis:0|1|2,component:number){
  if(x<-.5||x>nx-.5||y<-.5||y>ny-.5||z<-.5||z>nz-.5)return 0;
  x=Math.max(0,Math.min(nx-1,x));y=Math.max(0,Math.min(ny-1,y));z=Math.max(0,Math.min(nz-1,z));const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z);let result=0;
  const open=t?.open[axis];
  for(let xx=0;xx<2;xx++)for(let yy=0;yy<2;yy++)for(let zz=0;zz<2;zz++){
    const fx=Math.min(nx-1,ix+xx),fy=Math.min(ny-1,iy+yy),fz=Math.min(nz-1,iz+zz),face=(fx*nz+fz)*ny+fy;
    // Open faces have two fluid neighbors; the positive-side neighbor is in
    // range and identifies this face's component without crossing a wall.
    if(t&&(!open![face]||t.component[cell(d,fx,fy,fz)]!==component))continue;
    result+=a[face]*(xx?x-ix:1-x+ix)*(yy?y-iy:1-y+iy)*(zz?z-iz:1-z+iz);
  }return result;
}
function connectedFace(d:WaterBodyDepthCurrentState,t:Topology,component:number,axis:0|1|2,x:number,y:number,z:number,face:number){
  if(!t.open[axis][face])return false;
  return t.component[cell(d,x,y,z)]===component;
}
/** Sample one (axis>=0) or every (axis<0) velocity component at a world point. */
function sampleInto(w:Water,d:WaterBodyDepthCurrentState,t:Topology|undefined,vx:Values,vy:Values,vz:Values,px:number,py:number,pz:number,out:PhysicsVector,only=-1):PhysicsVector {
  if(t?.graph){
    out.x=out.y=out.z=0;const home=t.nodeAt!({x:px,y:py,z:pz});if(home<0)return out;
    const weights=[0,0,0],values=[vx,vy,vz],result=[0,0,0];
    for(const k of t.adjacent![home]){const axis=t.axis[k];if(only>=0&&axis!==only)continue;const e=t.graph.edges[k],weight=Math.abs(e.area);result[axis]+=values[axis][k]*weight;weights[axis]+=weight;}
    out.x=weights[0]?result[0]/weights[0]:0;out.y=weights[1]?result[1]/weights[1]:0;out.z=weights[2]?result[2]/weights[2]:0;return out;
  }
  const x=(px-w.origin.x)/(w.cellSizeX*d.stride),z=(pz-w.origin.z)/(w.cellSizeZ*d.stride),y=(py-d.bottom)/d.cellHeight;
  out.x=0;out.y=0;out.z=0;
  if(x<0||x>=d.columns||z<0||z>=d.rows||y<0||y>=d.layers)return out;
  const home=cell(d,Math.floor(x),Math.floor(y),Math.floor(z));if(!d.wet[home])return out;
  const component=t?t.component[home]:0;
  if(only<0||only===0)out.x=trilinear(vx,d.columns+1,d.layers,d.rows,x,y-.5,z-.5,d,t,0,component);
  if(only<0||only===1)out.y=trilinear(vy,d.columns,d.layers+1,d.rows,x-.5,y,z-.5,d,t,1,component);
  if(only<0||only===2)out.z=trilinear(vz,d.columns,d.layers,d.rows+1,x-.5,y-.5,z,d,t,2,component);
  return out;
}
function sample(w:Water,d:WaterBodyDepthCurrentState,p:PhysicsVector):PhysicsVector {
  return sampleInto(w,d,topologyCache.get(d),d.velocityX,d.velocityY,d.velocityZ,p.x,p.y,p.z,zero());
}
export function sampleWaterBodyDepthCurrent(w:Water,s:State,p:PhysicsVector):PhysicsVector {
  if(w.currents===false||w.depthCurrents===false||!s.depthCurrents||s.depthCurrents.sleeping)return zero();if(!topologyCache.has(s.depthCurrents))geometry(w,s,s.depthCurrents,undefined,true);return sample(w,s.depthCurrents,p);
}
/** MAC kinetic energy estimate used by the impulse limiter, in joules. */
export function waterBodyDepthCurrentEnergy(w:Water,s:State):number {
  const d=s.depthCurrents;if(!d)return 0;let sum=0;for(const values of arrays(d))for(let i=0;i<values.length;i++)sum+=values[i]**2*(d.graph?.edges[i].volume??w.cellArea*d.stride*d.stride*d.cellHeight);
  return sum*.5*w.liquid.restDensity;
}
/** Allocate or wake zero-momentum circulation for a real submerged mover.
 * The caller then transfers momentum through adjoint drag; waking itself adds
 * no velocity/energy. Existing accepted obstacle masks remain authoritative. */
export function prepareWaterBodyDepthCurrents(w:Water,s:State,obstacles:LiquidObstacle[]=[]):boolean {
  const c=resolveWaterBodyDepthCurrentConfig(w.depthCurrents);if(c===false||w.currents===false)return false;
  if(!s.depthCurrents){const d=create(w,s,c,undefined,obstacles);if(!d)return false;s.depthCurrents=d;geometry(w,s,d,undefined,false,obstacles);}
  s.depthCurrents.sleeping=false;s.depthCurrents.quietTime=0;return true;
}
export interface WaterBodyDepthCouplingWeight {axis:0|1|2;face:number;weight:number;mass?:number}
/** Adjoint interpolation/scatter weights for finite-mass body coupling. A
 * horizontal stencil has its per-column mean removed; this does not change
 * its sampled constrained velocity, but makes its reaction preserve the SWE
 * ownership of depth-averaged momentum. Construct once per coupling batch. */
export function waterBodyDepthCurrentCoupling(w:Water,s:State):{mass:number;stencil:(point:PhysicsVector)=>WaterBodyDepthCouplingWeight[]}|undefined {
  const d=s.depthCurrents;if(!d||d.sleeping||w.currents===false||w.depthCurrents===false)return;
  const cached=couplingCache.get(d);if(cached)return cached;
  if(d.graph){
    const t=graphTopology(w,s,d),graph=d.graph;
    const result={mass:w.cellArea*d.cellHeight*w.liquid.restDensity,stencil:(point:PhysicsVector)=>{
      let home=t.nodeAt!(point);
      if(home<0||!t.adjacent![home].length){home=-1;let best=(Math.max(t.dx,t.dz)*1.5)**2;
        for(let i=0;i<graph.nodes.length;i++){if(!t.adjacent![i].length)continue;const node=graph.nodes[i],p={x:node.x,y:d.bottom+(node.layer+.5)*d.cellHeight,z:node.z},distance=(p.x-point.x)**2+(p.y-point.y)**2+(p.z-point.z)**2;
          if(distance<best&&t.trace!(point,p)){home=i;best=distance;}}
      }
      if(home<0)return[];
      const weights=new Float64Array(t.count),total=[0,0,0];
      for(const i of t.adjacent![home])total[t.axis[i]]+=Math.abs(graph.edges[i].area);
      for(const i of t.adjacent![home])weights[i]=Math.abs(graph.edges[i].area)/total[t.axis[i]];
      // Adjoint of the mass-weighted zero-depth-mean projection. Sampling
      // and scattering use exactly the same stencil and per-face fluid mass.
      for(let group=0;group+1<t.groupStart.length;group++){
        const first=t.groupStart[group],last=t.groupStart[group+1];let sum=0,denominator=0;
        for(let k=first;k<last;k++){const i=t.groupEdges[k],e=graph.edges[i];sum+=weights[i]*e.area/e.volume;denominator+=e.area*e.area/e.volume;}
        if(denominator)for(let k=first;k<last;k++){const i=t.groupEdges[k];weights[i]-=graph.edges[i].area*sum/denominator;}
      }
      const entries:WaterBodyDepthCouplingWeight[]=[];
      for(let i=0;i<weights.length;i++)if(Math.abs(weights[i])>1e-15)entries.push({axis:t.axis[i] as 0|1|2,face:i,weight:weights[i],mass:graph.edges[i].volume*w.liquid.restDensity});
      return entries;
    }};couplingCache.set(d,result);return result;
  }
  const t=geometry(w,s,d,undefined,true),groupOfFace=[new Int32Array(d.velocityX.length).fill(-1),new Int32Array(0),new Int32Array(d.velocityZ.length).fill(-1)];
  for(let g=0;g+1<t.groupStart.length;g++)for(let k=t.groupStart[g];k<t.groupStart[g+1];k++){const index=t.groupEdges[k];groupOfFace[t.axis[index]][t.face[index]]=g;}
  const key=(axis:number,face:number)=>axis*1e8+face;
  const result={mass:t.dx*t.dz*d.cellHeight*w.liquid.restDensity,stencil:(point:PhysicsVector)=>{
    let p=point,x=(p.x-w.origin.x)/t.dx,z=(p.z-w.origin.z)/t.dz,y=(p.y-d.bottom)/d.cellHeight;
    if(x<0||x>=d.columns||z<0||z>=d.rows||y<0||y>=d.layers)return [];
    // A submerged collider centroid lies inside its own solid mask. Extend
    // the nearest surrounding fluid velocity one cell into that boundary,
    // retaining the real centroid height instead of sampling the water top.
    if(!d.wet[cell(d,Math.floor(x),Math.floor(y),Math.floor(z))]){
      let best=Infinity;let candidate:PhysicsVector|undefined;
      for(let xx=Math.max(0,Math.floor(x)-1);xx<=Math.min(d.columns-1,Math.floor(x)+1);xx++)for(let zz=Math.max(0,Math.floor(z)-1);zz<=Math.min(d.rows-1,Math.floor(z)+1);zz++){
        if(!d.wet[cell(d,xx,Math.floor(y),zz)])continue;const distance=(xx+.5-x)**2+(zz+.5-z)**2;
        if(distance<best){best=distance;candidate={x:w.origin.x+(xx+.5)*t.dx,y:p.y,z:w.origin.z+(zz+.5)*t.dz};}
      }
      if(!candidate)return [];p=candidate;x=(p.x-w.origin.x)/t.dx;z=(p.z-w.origin.z)/t.dz;y=(p.y-d.bottom)/d.cellHeight;
    }
    const component=t.component[cell(d,Math.floor(x),Math.floor(y),Math.floor(z))],weights=new Map<number,WaterBodyDepthCouplingWeight>();
    const interpolate=(axis:0|1|2,nx:number,ny:number,nz:number,gx:number,gy:number,gz:number)=>{
      gx=Math.max(0,Math.min(nx-1,gx));gy=Math.max(0,Math.min(ny-1,gy));gz=Math.max(0,Math.min(nz-1,gz));const ix=Math.floor(gx),iy=Math.floor(gy),iz=Math.floor(gz);
      for(let xx=0;xx<2;xx++)for(let yy=0;yy<2;yy++)for(let zz=0;zz<2;zz++){
        const face=(Math.min(nx-1,ix+xx)*nz+Math.min(nz-1,iz+zz))*ny+Math.min(ny-1,iy+yy),weight=(xx?gx-ix:1-gx+ix)*(yy?gy-iy:1-gy+iy)*(zz?gz-iz:1-gz+iz);
        if(weight<=0||!connectedFace(d,t,component,axis,Math.min(nx-1,ix+xx),Math.min(ny-1,iy+yy),Math.min(nz-1,iz+zz),face))continue;const k=key(axis,face),prior=weights.get(k);if(prior)prior.weight+=weight;else weights.set(k,{axis,face,weight});
      }
    };
    interpolate(0,d.columns+1,d.layers,d.rows,x,y-.5,z-.5);interpolate(1,d.columns,d.layers+1,d.rows,x-.5,y,z-.5);interpolate(2,d.columns,d.layers,d.rows+1,x-.5,y-.5,z);
    const groups=new Set<number>();for(const entry of weights.values())if(entry.axis!==1){const group=groupOfFace[entry.axis][entry.face];if(group>=0)groups.add(group);}
    for(const group of groups){const from=t.groupStart[group],to=t.groupStart[group+1];let sum=0;for(let k=from;k<to;k++){const index=t.groupEdges[k];sum+=weights.get(key(t.axis[index],t.face[index]))?.weight??0;}const mean=sum/(to-from);
      for(let k=from;k<to;k++){const index=t.groupEdges[k],axis=t.axis[index] as 0|1|2,face=t.face[index],prior=weights.get(key(axis,face));if(prior)prior.weight-=mean;else weights.set(key(axis,face),{axis,face,weight:-mean});}
    }
    return [...weights.values()].filter(entry=>Math.abs(entry.weight)>1e-15);
  }};couplingCache.set(d,result);return result;
}
/** Scene edits may change the storage representation. Sample the remembered
 * old topology in world coordinates before replacing its field; projection
 * then enforces the new openings. Remapping never creates kinetic energy. */
function remapDepthField(w:Water,s:State,old:WaterBodyDepthCurrentState,fresh:WaterBodyDepthCurrentState,geo:WaterBodyGeometry|undefined,oldEnergy:number){
  if(!topologyCache.has(old))geometry(w,s,old,undefined,true);
  fresh.quietTime=old.quietTime;fresh.sleeping=old.sleeping;
  if(fresh.graph){
    for(let i=0;i<fresh.graph.edges.length;i++){const edge=fresh.graph.edges[i],v=sample(w,old,edge);arrays(fresh)[edge.axis][i]=edge.axis===0?v.x:edge.axis===1?v.y:v.z;}
  }else{
    const dx=w.cellSizeX*fresh.stride,dz=w.cellSizeZ*fresh.stride;
    for(let x=0;x<fresh.columns;x++)for(let z=0;z<fresh.rows;z++)for(let y=0;y<fresh.layers;y++){
      const p={x:w.origin.x+(x+.5)*dx,y:fresh.bottom+(y+.5)*fresh.cellHeight,z:w.origin.z+(z+.5)*dz};
      fresh.velocityX[faceX(fresh,x,y,z)]=sample(w,old,{...p,x:p.x-dx*.5}).x;
      fresh.velocityY[faceY(fresh,x,y,z)]=sample(w,old,{...p,y:p.y-fresh.cellHeight*.5}).y;
      fresh.velocityZ[faceZ(fresh,x,y,z)]=sample(w,old,{...p,z:p.z-dz*.5}).z;
    }
  }
  s.depthCurrents=fresh;const t=geometry(w,s,fresh,geo),energy=waterBodyDepthCurrentEnergy(w,s);
  if(energy>oldEnergy&&energy>0){const scale=Math.sqrt(oldEnergy/energy);for(const values of arrays(fresh))for(let i=0;i<values.length;i++)values[i]*=scale;}
  return{d:fresh,t};
}
function ensure(w:Water,s:State,c:Config,geo?:WaterBodyGeometry){
  if(needsDepthGraph(s)){
    const old=s.depthCurrents,oldEnergy=old?waterBodyDepthCurrentEnergy(w,s):0,fresh=create(w,s,c,geo);if(!fresh){delete s.depthCurrents;return;}
    if(old)return remapDepthField(w,s,old,fresh,geo,oldEnergy);
    s.depthCurrents=fresh;return{d:fresh,t:geometry(w,s,fresh,geo)};
  }
  if(s.depthCurrents?.graph){
    const old=s.depthCurrents,energy=waterBodyDepthCurrentEnergy(w,s),fresh=create(w,s,c,geo);if(!fresh){delete s.depthCurrents;return;}
    return remapDepthField(w,s,old,fresh,geo,energy);
  }
  if(!s.depthCurrents)s.depthCurrents=create(w,s,c);let d=s.depthCurrents;if(!d)return;
  const range=extent(w,s);if(s.boundary&&!Number.isFinite(range.bottom)){delete s.depthCurrents;return;}
  if(range.bottom<d.bottom-d.cellHeight*.2||range.top>d.bottom+d.layers*d.cellHeight+d.cellHeight*.2){
    const oldEnergy=waterBodyDepthCurrentEnergy(w,s),fresh=create(w,s,c);if(fresh){geometry(w,s,fresh,geo);const old=d;d=fresh;s.depthCurrents=fresh;
      const dx=w.cellSizeX*d.stride,dz=w.cellSizeZ*d.stride;
      for(let x=0;x<d.columns;x++)for(let z=0;z<d.rows;z++)for(let y=0;y<d.layers;y++){
        const p={x:w.origin.x+(x+.5)*dx,y:d.bottom+(y+.5)*d.cellHeight,z:w.origin.z+(z+.5)*dz};
        d.velocityX[faceX(d,x,y,z)]=sample(w,old,{...p,x:p.x-dx*.5}).x;d.velocityY[faceY(d,x,y,z)]=sample(w,old,{...p,y:p.y-d.cellHeight*.5}).y;d.velocityZ[faceZ(d,x,y,z)]=sample(w,old,{...p,z:p.z-dz*.5}).z;
      }
      const remappedEnergy=waterBodyDepthCurrentEnergy(w,s);if(remappedEnergy>oldEnergy){const factor=Math.sqrt(oldEnergy/remappedEnergy);for(const a of arrays(d))for(let i=0;i<a.length;i++)a[i]*=factor;}
    }
  }
  return{d,t:geometry(w,s,d,geo)};
}
/** impulse is N·s; optional energy is the maximum kinetic energy added in J.
 * Couplers should supply the incoming momentum and its remaining energy after
 * their existing depth-averaged impulse, avoiding an unlimited jet source. */
export interface WaterBodyDepthCurrentImpulse {point:PhysicsVector;radius:number;impulse:PhysicsVector;energy?:number;deferProjection?:boolean}
export function addWaterBodyDepthImpulse(w:Water,s:State,input:WaterBodyDepthCurrentImpulse,geo?:WaterBodyGeometry):void {addWaterBodyDepthImpulses(w,s,[input],geo);}
/** One topology/component build and at most one projection for a packet batch.
 * Every impulse retains its individual energy allowance. If every entry is
 * deferred, the main water step performs the pressure projection instead. */
export function addWaterBodyDepthImpulses(w:Water,s:State,inputs:WaterBodyDepthCurrentImpulse[],geo?:WaterBodyGeometry):void {
  const config=resolveWaterBodyDepthCurrentConfig(w.depthCurrents);if(config===false||w.currents===false)return;
  if(!Array.isArray(inputs)||inputs.length>8192)throw new Error('Water body depth current impulse budget exceeded');
  for(const input of inputs)if(!valid(input.radius,.001,1000)||Object.values(input.point).some(v=>!Number.isFinite(v))||Object.values(input.impulse).some(v=>!Number.isFinite(v))||input.energy!==undefined&&!valid(input.energy,0,1e15)||input.deferProjection!==undefined&&typeof input.deferProjection!=='boolean')throw new Error('Invalid water body depth current impulse');
  const effective=inputs.filter(input=>Math.hypot(input.impulse.x,input.impulse.y,input.impulse.z)>=1e-12&&input.energy!==0);if(!effective.length)return;
  const prepared=ensure(w,s,config,geo);if(!prepared)return;const{d,t}=prepared,faces=arrays(d);
  // A broad impact kernel must not apply force to a separate pool through a
  // dam merely because both pools are near its Euclidean point of impact.
  let changed=false;for(const input of effective){
  const sourceX=Math.floor((input.point.x-w.origin.x)/w.cellSizeX),sourceZ=Math.floor((input.point.z-w.origin.z)/w.cellSizeZ),cells=waterBodyCells(w,s),source=cells.locate(input.point);
  if(source===undefined||cells.depth(source)<=w.wetDepth)continue;
  // An unresolved shallow receiving column cannot borrow another pool's layer
  // across dry ground. Ignore its sub-layer circulation instead of teleporting
  // the incident momentum into the globally nearest resolved water cell.
  const x=Math.floor(sourceX/d.stride),z=Math.floor(sourceZ/d.stride);let nearest=-1,nearestDistance=Infinity;
  if(t.graph){for(let i=0;i<t.graph.nodes.length;i++){const node=t.graph.nodes[i];if(!node.regions.includes(source))continue;const distance=Math.abs(d.bottom+(node.layer+.5)*d.cellHeight-input.point.y);if(distance<nearestDistance){nearest=i;nearestDistance=distance;}}}
  else for(let y=0;y<d.layers;y++){const i=cell(d,x,y,z);if(!d.wet[i])continue;const distance=Math.abs(d.bottom+(y+.5)*d.cellHeight-input.point.y);if(distance<nearestDistance){nearest=i;nearestDistance=distance;}}
  if(nearest<0)continue;const component=t.component[nearest],b=buffers(1,t.count),weights=b.edge(2),delta=b.edge(3),totals=[0,0,0],impulse=[input.impulse.x,input.impulse.y,input.impulse.z];
  const ry=Math.max(input.radius,d.cellHeight*1.5);
  for(let i=0;i<t.count;i++){const a=t.ea[i],axis=t.axis[i];weights[i]=0;if(t.component[a]!==component)continue;
    const y=a%d.layers,x=Math.floor(Math.floor(a/d.layers)/d.rows),z=Math.floor(a/d.layers)%d.rows;
    const edge=t.graph?.edges[i],px=edge?.x??w.origin.x+(x+.5+(axis===0?.5:0))*t.dx,pz=edge?.z??w.origin.z+(z+.5+(axis===2?.5:0))*t.dz,py=edge?.y??d.bottom+(y+.5+(axis===1?.5:0))*d.cellHeight;
    const distance=((px-input.point.x)/Math.max(input.radius,t.dx))**2+((pz-input.point.z)/Math.max(input.radius,t.dz))**2+((py-input.point.y)/ry)**2;
    weights[i]=distance<4?Math.exp(-distance*2):0;
  }
  for(let i=0;i<t.count;i++)totals[t.axis[i]]+=weights[i];const mass=t.dx*t.dz*d.cellHeight*w.liquid.restDensity;
  for(let i=0;i<t.count;i++){const axis=t.axis[i];delta[i]=totals[axis]?impulse[axis]*weights[i]/((t.mass?.[i]!==undefined?t.mass[i]*w.liquid.restDensity:mass)*totals[axis]):0;}constrain(delta,t);
  let quadratic=0,linear=0;for(let i=0;i<t.count;i++){const faceMass=t.mass?.[i]!==undefined?t.mass[i]*w.liquid.restDensity:mass;quadratic+=.5*faceMass*delta[i]**2;linear+=faceMass*delta[i]*faces[t.axis[i]][t.face[i]];}
  let scale=1;if(input.energy!==undefined&&quadratic+linear>input.energy&&quadratic>0)scale=Math.max(0,Math.min(1,(-linear+Math.sqrt(linear*linear+4*quadratic*input.energy))/(2*quadratic)));
  for(let i=0;i<t.count;i++)faces[t.axis[i]][t.face[i]]+=delta[i]*scale;d.sleeping=false;d.quietTime=0;
  let maximum=0;for(const a of faces)for(const v of a)maximum=Math.max(maximum,Math.abs(v));if(maximum>config.maxSpeed)for(const a of faces)for(let i=0;i<a.length;i++)a[i]*=config.maxSpeed/maximum;
  changed=true;
  }
  if(changed&&effective.some(input=>!input.deferProjection))project(d,t,config);
}
const empty=():WaterBodyDepthCurrentStats=>({cells:0,activeCells:0,iterations:0,divergenceBefore:0,divergenceAfter:0,maxSpeed:0,kineticEnergy:0,sleeping:true,budgetLimited:false});
/** Complete a batch of adjoint body reactions without advancing or resampling
 * the water. Keeps the accepted solid mask from the main simulation step. */
export function projectWaterBodyDepthCurrents(w:Water,s:State):void {
  const config=resolveWaterBodyDepthCurrentConfig(w.depthCurrents),d=s.depthCurrents;if(!d||config===false||w.currents===false)return;project(d,geometry(w,s,d,undefined,true),config);
}
/** Preserve world-space sampling before a scene edit replaces region ids. */
export function rememberWaterBodyDepthCurrentGeometry(w:Water,s:State):void {
  if(s.depthCurrents)geometry(w,s,s.depthCurrents,undefined,true);
}
export function stepWaterBodyDepthCurrents(w:Water,s:State,dt:number,geo?:WaterBodyGeometry):WaterBodyDepthCurrentStats {
  if(!valid(dt,0,.1))throw new Error('Invalid water body depth current time');const config=resolveWaterBodyDepthCurrentConfig(w.depthCurrents);
  if(config===false||w.currents===false){delete s.depthCurrents;return empty();}if(!s.depthCurrents||s.depthCurrents.sleeping&&Boolean(s.depthCurrents.graph)===needsDepthGraph(s)&&(!s.depthCurrents.graph||s.depthCurrents.graph.revision===s.boundary?.mesh.revision))return empty();
  const prepared=ensure(w,s,config,geo);if(!prepared)return empty();const{d,t}=prepared;
  // Backtrace the bounded residual with the actual depth-averaged current.
  // Projection restores wall/column constraints after this inexpensive step.
  const faces=arrays(d),cells=waterBodyCells(w,s),retention=Math.exp(-config.damping*dt),old=[Float64Array.from(d.velocityX),Float64Array.from(d.velocityY),Float64Array.from(d.velocityZ)],v=zero(),next=zero();let beforeEnergy=0,afterEnergy=0;
  for(let k=0;k<t.count;k++){const a=t.ea[k],axis=t.axis[k],face=t.face[k],y=a%d.layers,x=Math.floor(Math.floor(a/d.layers)/d.rows),z=Math.floor(a/d.layers)%d.rows;
    const edge=t.graph?.edges[k],px=edge?.x??w.origin.x+(x+.5+(axis===0?.5:0))*t.dx,py=edge?.y??d.bottom+(y+.5+(axis===1?.5:0))*d.cellHeight,pz=edge?.z??w.origin.z+(z+.5+(axis===2?.5:0))*t.dz;
    sampleInto(w,d,t,old[0],old[1],old[2],px,py,pz,v);const fx=Math.min(w.columns-1,Math.floor((px-w.origin.x)/w.cellSizeX)),fz=Math.min(w.rows-1,Math.floor((pz-w.origin.z)/w.cellSizeZ)),i=fx*w.rows+fz;
    const region=cells.locate({x:px,z:pz}),ux=px-(v.x+(region===undefined?s.flowX[i]:cells.flowX[region]))*dt,uy=py-v.y*dt,uz=pz-(v.z+(region===undefined?s.flowZ[i]:cells.flowZ[region]))*dt;
    let component=0;if(traceOpen(w,d,t,px,py,pz,ux,uy,uz)){sampleInto(w,d,t,old[0],old[1],old[2],ux,uy,uz,next,axis);component=axis===0?next.x:axis===1?next.y:next.z;}
    const value=component*retention;
    beforeEnergy+=faces[axis][face]**2*(t.mass?.[k]??1);afterEnergy+=value*value*(t.mass?.[k]??1);faces[axis][face]=value;
  }
  if(afterEnergy>beforeEnergy*retention*retention){const scale=Math.sqrt(beforeEnergy/Math.max(afterEnergy,1e-30))*retention;for(let k=0;k<t.count;k++)faces[t.axis[k]][t.face[k]]*=scale;}
  const result=project(d,t,config);d.quietTime=result.maxSpeed<config.sleepSpeed?d.quietTime+dt:0;
  if(d.quietTime>=config.sleepAfter){d.sleeping=true;for(const a of faces)a.fill(0);result.maxSpeed=0;result.kineticEnergy=0;}
  return{...result,kineticEnergy:result.kineticEnergy*w.liquid.restDensity,cells:d.wet.length,activeCells:t.active,sleeping:d.sleeping,budgetLimited:d.stride>1};
}
