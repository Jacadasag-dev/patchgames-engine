/** Internal finite-depth pressure response for small, resolved surface waves. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';
import {waterBodyCells,type WaterCellFace} from './waterBodyCells.ts';
import type {WaterBoundaryMesh} from './waterBoundaryGeometry.ts';

const weights=Array.from({length:4},(_,n)=>8/(Math.PI*Math.PI*(2*n+1)**2));
const remainder=1-weights.reduce((a,b)=>a+b,0);
const iterationLimits=[12,12,8,8];
export const WATER_BODY_DISPERSION_LIMITS=Object.freeze({terms:4,iterations:40,cells:16384});
interface Work {
  head:Float64Array;source:Float64Array;active:Uint8Array;eligible:Uint8Array;
  faceX:Float64Array;faceZ:Float64Array;diagonal:Float64Array;
  solution:Float64Array;residual:Float64Array;direction:Float64Array;product:Float64Array;preconditioned:Float64Array;
  component:Int32Array;queue:Int32Array;minimum:Float64Array;maximum:Float64Array;
  /** Each term's last solution, a starting guess for the next stage's solve. */
  previous:Float64Array[];previousValid:boolean;
  /** Linked faces in matrix order (x then z per ascending cell) and the
   * ascending cells that have any face; other rows are identity. */
  faceFrom:Int32Array;faceTo:Int32Array;faceWeight:Float64Array;faceCount:number;cells:Int32Array;cellCount:number;
}
export interface WaterBodyDispersiveHead {
  /** Borrowed scratch arrays: consume before calling again with this manifest. */
  head:Float64Array;active:Uint8Array;
  /** Pressure correction at the transport solver's hydraulic resolution. */
  groupCorrection?:Float64Array;
  stats:{iterations:number;relativeResidual:number;fallback:number;activeCells:number;faces:number};
}
export interface WaterBodyDispersionGroups {
  owner:Int32Array;area:Float64Array;volume:Float64Array;head:Float64Array;cx:Float64Array;cz:Float64Array;
}
const cache=new WeakMap<WaterBodyManifest,Work>();
function workspace(w:WaterBodyManifest):Work {
  const n=w.columns*w.rows,old=cache.get(w);if(old?.head.length===n)return old;
  if(n>WATER_BODY_DISPERSION_LIMITS.cells)throw new Error('Water body dispersion cell budget exceeded');
  const array=()=>new Float64Array(n),next={head:array(),source:array(),active:new Uint8Array(n),eligible:new Uint8Array(n),faceX:array(),faceZ:array(),
    diagonal:array(),solution:array(),residual:array(),direction:array(),product:array(),preconditioned:array(),component:new Int32Array(n),queue:new Int32Array(n),minimum:array(),maximum:array(),
    previous:weights.map(()=>array()),previousValid:false,faceFrom:new Int32Array(2*n),faceTo:new Int32Array(2*n),faceWeight:new Float64Array(2*n),faceCount:0,cells:new Int32Array(n),cellCount:0};
  cache.set(w,next);return next;
}
function multiply(a:Work,alpha:number,input:Float64Array,output:Float64Array):void {
  output.set(input);
  for(let k=0;k<a.faceCount;k++){const i=a.faceFrom[k],j=a.faceTo[k],d=alpha*a.faceWeight[k]*(input[i]-input[j]);output[i]+=d;output[j]-=d;}
}

/** Positive Helmholtz terms approximate tanh(kh)/(kh), rather than changing g.
 * Four terms are within 1.3% for kh<=5. Symmetric reflecting wet faces preserve
 * constants; bounded CG falls back toward the nondispersive pressure on error.
 * This filters pressure only: callers retain conservative positive-depth fluxes.
 * warm starts each solve from this manifest's previous solve. Pass it only
 * within one water step, after its first solve, so every step stays a pure
 * function of its input state (checkpoints replay identically). Convergence
 * is still judged against the cold-start residual. */
export function waterBodyDispersiveHead(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,warm=false,groups?:WaterBodyDispersionGroups):WaterBodyDispersiveHead {
  if(s.boundary)return refinedDispersiveHead(w,s,geometry,warm,groups);
  const a=workspace(w),n=a.head.length,rows=w.rows,minDepth=Math.max(.03,w.wetDepth*8);
  // A cold call forgets every earlier solve, so no step inherits another's.
  const useWarm=warm&&a.previousValid;a.previousValid=false;
  const stats={iterations:0,relativeResidual:0,fallback:0,activeCells:0,faces:0};
  a.faceX.fill(0);a.faceZ.fill(0);a.diagonal.fill(0);a.component.fill(-1);
  for(let i=0;i<n;i++){
    a.source[i]=geometry.bed[i]+s.depth[i]+(s.solidDepth?.[i]??0);a.head[i]=a.source[i];
    a.eligible[i]=a.active[i]=s.depth[i]>=minDepth&&!geometry.blocked[i]?1:0;
  }
  const open=(i:number,j:number,axis:'x'|'z')=>{
    const barrier=axis==='x'?geometry.x[j]:geometry.z[Math.floor(j/rows)*(rows+1)+j%rows];
    return !barrier||barrier.top<Math.min(a.source[i],a.source[j])-1e-8;
  };
  // The wet front, overtopping jumps and impact-scale steep waves retain the
  // nonlinear shallow-water solve. No dispersive correction crosses that rim.
  // Per-face helpers instead of per-cell neighbour tuples: no allocation.
  const rim=(i:number,j:number,axis:'x'|'z')=>{
    if(j>=n||!a.eligible[i]||!a.eligible[j]||!open(i,j,axis))return;
    if(Math.abs(a.source[i]-a.source[j])>Math.min(s.depth[i],s.depth[j])*.15){a.active[i]=0;a.active[j]=0;}
  };
  for(let i=0;i<n;i++){rim(i,i+rows,'x');rim(i,i%rows+1<rows?i+1:n,'z');}
  const link=(i:number,j:number,axis:'x'|'z',spacing:number)=>{
    if(j>=n||!a.active[j]||!open(i,j,axis))return;
    const depth=2*s.depth[i]*s.depth[j]/(s.depth[i]+s.depth[j]),weight=(depth/spacing)**2;
    if(axis==='x')a.faceX[i]=weight;else a.faceZ[i]=weight;
    a.diagonal[i]+=weight;a.diagonal[j]+=weight;stats.faces++;
  };
  for(let i=0;i<n;i++){
    if(!a.active[i])continue;stats.activeCells++;
    link(i,i+rows,'x',w.cellSizeX);link(i,i%rows+1<rows?i+1:n,'z',w.cellSizeZ);
  }
  // Per-component bounds prevent a poorly converged solve from overshooting or
  // borrowing a pressure range from a different, hydraulically isolated pool.
  let components=0,variation=0;
  for(let start=0;start<n;start++)if(a.active[start]&&a.component[start]<0){
    let count=1;a.queue[0]=start;a.component[start]=components;let min=a.source[start],max=min;
    const visit=(j:number)=>{if(j>=0&&a.component[j]<0){a.component[j]=components;a.queue[count++]=j;}};
    for(let at=0;at<count;at++){
      const i=a.queue[at];min=Math.min(min,a.source[i]);max=Math.max(max,a.source[i]);
      visit(a.faceX[i]?i+rows:-1);visit(a.faceZ[i]?i+1:-1);visit(i>=rows&&a.faceX[i-rows]?i-rows:-1);visit(i%rows&&a.faceZ[i-1]?i-1:-1);
    }
    a.minimum[components]=min;a.maximum[components]=max;variation=Math.max(variation,max-min);components++;
  }
  if(variation<1e-10||!stats.faces)return{head:a.head,active:a.active,stats};
  // Faceless rows are identity: their residual and search direction stay
  // exactly zero, so the solver's vector loops visit only linked cells.
  a.faceCount=0;a.cellCount=0;
  for(let i=0;i<n;i++){
    if(a.faceX[i]){a.faceFrom[a.faceCount]=i;a.faceTo[a.faceCount]=i+rows;a.faceWeight[a.faceCount++]=a.faceX[i];}
    if(a.faceZ[i]){a.faceFrom[a.faceCount]=i;a.faceTo[a.faceCount]=i+1;a.faceWeight[a.faceCount++]=a.faceZ[i];}
    if(a.diagonal[i]>0)a.cells[a.cellCount++]=i;
  }
  const cells=a.cells,m=a.cellCount;
  for(let i=0;i<n;i++)a.head[i]*=remainder;
  for(let term=0;term<weights.length;term++){
    const weight=weights[term],alpha=weight/2;
    a.solution.set(a.source);multiply(a,alpha,a.solution,a.product);
    let rz=0,initialSquared=0;a.residual.fill(0);a.preconditioned.fill(0);a.direction.fill(0);
    for(let k=0;k<m;k++){
      const i=cells[k],r=a.source[i]-a.product[i],z=r;
      a.residual[i]=r;a.preconditioned[i]=a.direction[i]=z;rz+=r*z;initialSquared+=r*r;
    }
    let squared=initialSquared;
    if(useWarm){
      // Keep the cold residual as the convergence reference; continue from
      // the previous stage's solution only when it is already closer.
      // Faceless rows keep the cold value, so their residual stays zero.
      const guess=a.product;guess.set(a.source);for(let k=0;k<m;k++){const i=cells[k];guess[i]=a.previous[term][i];}
      a.residual.set(guess);multiply(a,alpha,a.residual,a.product);let warmRz=0;
      for(let k=0;k<m;k++){const i=cells[k],r=a.source[i]-a.product[i];warmRz+=r*r;}
      if(warmRz<initialSquared){
        for(let k=0;k<m;k++){const i=cells[k],r=a.source[i]-a.product[i];a.solution[i]=a.residual[i];a.preconditioned[i]=a.direction[i]=r;}
        for(let k=0;k<m;k++){const i=cells[k];a.residual[i]=a.preconditioned[i];}
        rz=warmRz;squared=warmRz;
      }else for(let k=0;k<m;k++){const i=cells[k];a.residual[i]=a.direction[i];}
    }
    for(let iteration=0;iteration<iterationLimits[term]&&squared>Math.max(1e-24,initialSquared*1e-6);iteration++){
      multiply(a,alpha,a.direction,a.product);let denominator=0;
      for(let k=0;k<m;k++){const i=cells[k];denominator+=a.direction[i]*a.product[i];}
      if(!(denominator>0)||!Number.isFinite(denominator))break;
      const step=rz/denominator;let nextRz=0;squared=0;
      for(let k=0;k<m;k++){
        const i=cells[k];a.solution[i]+=step*a.direction[i];a.residual[i]-=step*a.product[i];
        const r=a.residual[i],z=r;a.preconditioned[i]=z;nextRz+=r*z;squared+=r*r;
      }
      const beta=rz>0?nextRz/rz:0;for(let k=0;k<m;k++){const i=cells[k];a.direction[i]=a.preconditioned[i]+beta*a.direction[i];}
      rz=nextRz;stats.iterations++;
    }
    a.previous[term].set(a.solution);
    const error=initialSquared?Math.sqrt(squared/initialSquared):0;
    stats.relativeResidual=Math.max(stats.relativeResidual,error);
    // Weak convergence cannot invent a large pressure correction. Fade rather
    // than throwing or applying an unbounded last iterate during a wet edit.
    const confidence=Number.isFinite(error)?Math.max(0,Math.min(1,(.1-error)/.08)):0;
    if(confidence<1)stats.fallback++;
    for(let i=0;i<n;i++){
      const component=a.component[i],raw=a.solution[i],bounded=component<0?a.source[i]:Math.max(a.minimum[component],Math.min(a.maximum[component],raw));
      a.head[i]+=weight*(a.source[i]+confidence*(Number.isFinite(bounded)?bounded-a.source[i]:0));
    }
  }
  a.previousValid=true;
  // Keep an unchanged inactive/constant component bit-for-bit unchanged.
  for(let i=0;i<n;i++){const c=a.component[i];if(c<0||a.minimum[c]===a.maximum[c])a.head[i]=a.source[i];}
  return{head:a.head,active:a.active,stats};
}

interface RegionWork {
  mesh:WaterBoundaryMesh;head:Float64Array;source:Float64Array;scaledSource:Float64Array;scale:Float64Array;depth:Float64Array;active:Uint8Array;eligible:Uint8Array;
  solution:Float64Array;residual:Float64Array;direction:Float64Array;product:Float64Array;
  guess:Float64Array;component:Int32Array;queue:Int32Array;minimum:Float64Array;maximum:Float64Array;linked:Int32Array;linkedCount:number;
  candidate:Int32Array;edgeFrom:Int32Array;edgeTo:Int32Array;edgeWeight:Float64Array;edgeCount:number;
  adjacentHead:Int32Array;adjacentNext:Int32Array;adjacentTo:Int32Array;
  previous:Float64Array[];previousValid:boolean;
  owner?:Int32Array;regionalHead?:Float64Array;regionalActive?:Uint8Array;correction?:Float64Array;
}
const regionCache=new WeakMap<WaterBodyManifest,RegionWork>();
const groupedCache=new WeakMap<WaterBodyManifest,RegionWork>();
interface GroupFaces {faces:WaterCellFace[];index:Int32Array;from:Int32Array;to:Int32Array;distance:Float64Array}
const groupFacesCache=new WeakMap<Int32Array,GroupFaces>();
function groupFaces(w:WaterBodyManifest,faces:WaterCellFace[],groups:WaterBodyDispersionGroups):GroupFaces {
  const saved=groupFacesCache.get(groups.owner);if(saved?.faces===faces)return saved;
  const index:number[]=[],from:number[]=[],to:number[]=[],distance:number[]=[];
  for(let k=0;k<faces.length;k++){const f=faces[k];if(f.b<0)continue;const a=groups.owner[f.a],b=groups.owner[f.b];if(a===b)continue;
    index.push(k);from.push(a);to.push(b);distance.push(Math.max(Math.min(w.cellSizeX,w.cellSizeZ)*.05,Math.abs((groups.cx[b]-groups.cx[a])*f.nx+(groups.cz[b]-groups.cz[a])*f.nz)));
  }
  const result={faces,index:Int32Array.from(index),from:Int32Array.from(from),to:Int32Array.from(to),distance:Float64Array.from(distance)};groupFacesCache.set(groups.owner,result);return result;
}
/** M + alpha L is positive definite on the actual regions. Transform by
 * sqrt(M), where M is region area, so CG keeps the same Euclidean norm and
 * bounded iteration policy as the rectangular solver. Never average heads
 * across the multiple hydraulic regions belonging to one authoring square. */
function refinedDispersiveHead(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,warm:boolean,groups?:WaterBodyDispersionGroups):WaterBodyDispersiveHead {
  const cells=waterBodyCells(w,s),n=groups?.area.length??cells.count,mesh=s.boundary!.mesh;
  if(cells.count>WATER_BODY_DISPERSION_LIMITS.cells)throw new Error('Water body dispersion cell budget exceeded');
  const faces=cells.faces(geometry),mapped=groups?groupFaces(w,faces,groups):undefined,faceCount=mapped?.index.length??faces.length;
  const cache=groups?groupedCache:regionCache;
  let a=cache.get(w);
  if(!a||a.mesh!==mesh||a.head.length!==n){
    const array=()=>new Float64Array(n);
    a={mesh,head:array(),source:array(),scaledSource:array(),scale:array(),depth:array(),active:new Uint8Array(n),eligible:new Uint8Array(n),
      solution:array(),residual:array(),direction:array(),product:array(),guess:array(),component:new Int32Array(n),queue:new Int32Array(n),minimum:array(),maximum:array(),linked:new Int32Array(n),linkedCount:0,
      candidate:new Int32Array(faceCount),edgeFrom:new Int32Array(faceCount),edgeTo:new Int32Array(faceCount),edgeWeight:new Float64Array(faceCount),edgeCount:0,
      adjacentHead:new Int32Array(n),adjacentNext:new Int32Array(faceCount*2),adjacentTo:new Int32Array(faceCount*2),previous:weights.map(array),previousValid:false};
    if(groups){a.regionalHead=new Float64Array(cells.count);a.regionalActive=new Uint8Array(cells.count);a.correction=new Float64Array(n);}
    cache.set(w,a);
  }
  if(a.candidate.length<faceCount){a.candidate=new Int32Array(faceCount);a.edgeFrom=new Int32Array(faceCount);a.edgeTo=new Int32Array(faceCount);a.edgeWeight=new Float64Array(faceCount);a.adjacentNext=new Int32Array(faceCount*2);a.adjacentTo=new Int32Array(faceCount*2);}
  const useWarm=warm&&a.previousValid&&a.owner===groups?.owner;a.previousValid=false;a.owner=groups?.owner;
  const stats={iterations:0,relativeResidual:0,fallback:0,activeCells:0,faces:0};
  const minDepth=Math.max(.03,w.wetDepth*8),depth=a.depth,eligible=a.eligible;
  for(let i=0;i<n;i++){
    a.head[i]=a.source[i]=groups?groups.head[i]:cells.level(i);a.scale[i]=Math.sqrt(groups?groups.area[i]:cells.area(i));depth[i]=groups?groups.volume[i]/groups.area[i]:cells.depth(i);
    eligible[i]=a.active[i]=depth[i]>=minDepth?1:0;
  }
  let candidateCount=0;
  for(let k=0;k<faceCount;k++){const f=faces[mapped?mapped.index[k]:k],i=mapped?mapped.from[k]:f.a,j=mapped?mapped.to[k]:f.b;if(j>=0&&eligible[i]&&eligible[j]
    &&(!groups||cells.depth(f.a)>=minDepth&&cells.depth(f.b)>=minDepth)
    &&Math.max(f.start.bed,f.end.bed,f.barrier?.top??-Infinity)<Math.min(a.source[i],a.source[j])-1e-8)a.candidate[candidateCount++]=k;}
  for(let k=0;k<candidateCount;k++){const edge=a.candidate[k],f=faces[mapped?mapped.index[edge]:edge],i=mapped?mapped.from[edge]:f.a,j=mapped?mapped.to[edge]:f.b;if(Math.abs(a.source[i]-a.source[j])>Math.min(depth[i],depth[j])*.15){a.active[i]=0;a.active[j]=0;}}
  a.edgeCount=0;a.adjacentHead.fill(-1);
  for(let k=0;k<candidateCount;k++){const candidate=a.candidate[k],f=faces[mapped?mapped.index[candidate]:candidate],i=mapped?mapped.from[candidate]:f.a,j=mapped?mapped.to[candidate]:f.b;if(a.active[i]&&a.active[j]){
    const d=2*depth[i]*depth[j]/(depth[i]+depth[j]),weight=d*d*f.length/(mapped?mapped.distance[candidate]:f.distance);
    const edge=a.edgeCount++;a.edgeFrom[edge]=i;a.edgeTo[edge]=j;a.edgeWeight[edge]=weight;
    // Adjacency is only for connected-component bounds. Matrix faces retain
    // their original order and arithmetic; no term or connection is skipped.
    const left=edge*2,right=left+1;a.adjacentTo[left]=j;a.adjacentNext[left]=a.adjacentHead[i];a.adjacentHead[i]=left;
    a.adjacentTo[right]=i;a.adjacentNext[right]=a.adjacentHead[j];a.adjacentHead[j]=right;
  }}
  const component=a.component,minimum=a.minimum,maximum=a.maximum;component.fill(-1);let variation=0,components=0;
  for(let start=0;start<n;start++)if(a.active[start]&&component[start]<0){
    const id=components++,queue=a.queue;let count=1;queue[0]=start;component[start]=id;let min=a.source[start],max=min;
    for(let k=0;k<count;k++){
      const i=queue[k];min=Math.min(min,a.source[i]);max=Math.max(max,a.source[i]);
      for(let edge=a.adjacentHead[i];edge>=0;edge=a.adjacentNext[edge]){const j=a.adjacentTo[edge];if(component[j]<0){component[j]=id;queue[count++]=j;}}
    }
    minimum[id]=min;maximum[id]=max;variation=Math.max(variation,max-min);
  }
  stats.faces=a.edgeCount;for(let i=0;i<n;i++)stats.activeCells+=a.active[i];
  const result=():WaterBodyDispersiveHead=>{
    if(!groups)return{head:a.head,active:a.active,stats};
    const head=a.regionalHead!,active=a.regionalActive!,correction=a.correction!;
    for(let i=0;i<n;i++)correction[i]=a.head[i]-a.source[i];
    for(let i=0;i<cells.count;i++){const group=groups.owner[i];active[i]=a.active[group]&&cells.depth(i)>=minDepth?1:0;head[i]=cells.level(i)+(active[i]?correction[group]:0);}
    return{head,active,groupCorrection:correction,stats};
  };
  if(variation<1e-10||!a.edgeCount)return result();
  const linked=a.linked,source=a.scaledSource;a.linkedCount=0;
  for(let i=0;i<n;i++){if(a.adjacentHead[i]>=0)linked[a.linkedCount++]=i;source[i]=a.source[i]*a.scale[i];}
  const linkedCount=a.linkedCount,edgeCount=a.edgeCount,edgeFrom=a.edgeFrom,edgeTo=a.edgeTo,edgeWeight=a.edgeWeight,scale=a.scale;
  const multiply=(alpha:number,input:Float64Array,output:Float64Array)=>{
    // Unlinked rows are identity and never enter CG dot products. Avoid
    // copying those dry/isolated rows on every matrix-vector application.
    for(let k=0;k<linkedCount;k++){const i=linked[k];output[i]=input[i];}
    for(let k=0;k<edgeCount;k++){const i=edgeFrom[k],j=edgeTo[k],delta=alpha*edgeWeight[k]*(input[i]/scale[i]-input[j]/scale[j]);output[i]+=delta/scale[i];output[j]-=delta/scale[j];}
  };
  for(let i=0;i<n;i++)a.head[i]*=remainder;
  for(let term=0;term<weights.length;term++){
    const weight=weights[term],alpha=weight/2;a.solution.set(source);multiply(alpha,a.solution,a.product);
    let initialSquared=0;
    for(let k=0;k<linkedCount;k++){const i=linked[k],r=source[i]-a.product[i];a.residual[i]=a.direction[i]=r;initialSquared+=r*r;}
    let squared=initialSquared;
    if(useWarm){
      const guess=a.guess;for(let k=0;k<linkedCount;k++){const i=linked[k];guess[i]=a.previous[term][i];}multiply(alpha,guess,a.product);let warmSquared=0;
      for(let k=0;k<linkedCount;k++){const i=linked[k],r=source[i]-a.product[i];warmSquared+=r*r;}
      if(warmSquared<initialSquared){for(let k=0;k<linkedCount;k++){const i=linked[k];a.solution[i]=guess[i];a.residual[i]=a.direction[i]=source[i]-a.product[i];}squared=warmSquared;}
    }
    for(let iteration=0;iteration<iterationLimits[term]&&squared>Math.max(1e-24,initialSquared*1e-6);iteration++){
      multiply(alpha,a.direction,a.product);let denominator=0;
      for(let k=0;k<linkedCount;k++){const i=linked[k];denominator+=a.direction[i]*a.product[i];}if(!(denominator>0)||!Number.isFinite(denominator))break;
      const step=squared/denominator;let next=0;
      for(let k=0;k<linkedCount;k++){const i=linked[k];a.solution[i]+=step*a.direction[i];a.residual[i]-=step*a.product[i];next+=a.residual[i]*a.residual[i];}
      const beta=squared>0?next/squared:0;for(let k=0;k<linkedCount;k++){const i=linked[k];a.direction[i]=a.residual[i]+beta*a.direction[i];}squared=next;stats.iterations++;
    }
    a.previous[term].set(a.solution);const error=initialSquared?Math.sqrt(squared/initialSquared):0;
    stats.relativeResidual=Math.max(stats.relativeResidual,error);
    const confidence=Number.isFinite(error)?Math.max(0,Math.min(1,(.1-error)/.08)):0;if(confidence<1)stats.fallback++;
    for(let i=0;i<n;i++){
      const c=component[i],raw=a.solution[i]/a.scale[i],bounded=c<0?a.source[i]:Math.max(minimum[c],Math.min(maximum[c],raw));
      a.head[i]+=weight*(a.source[i]+confidence*(Number.isFinite(bounded)?bounded-a.source[i]:0));
    }
  }
  a.previousValid=true;
  for(let i=0;i<n;i++){const c=component[i];if(c<0||maximum[c]-minimum[c]<1e-10)a.head[i]=a.source[i];}
  return result();
}
