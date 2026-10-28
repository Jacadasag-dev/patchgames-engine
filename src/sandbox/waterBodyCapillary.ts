/** Resolved, deliberately game-scale capillarity for shallow partial wetting.
 * Curvature pressure smooths the meniscus; a bounded local wetting potential
 * favors a millimetre-thick patch over an indefinitely spreading film. These
 * supply local surface stresses, not attraction to a puddle's centroid.
 * The exaggerated length scale is not water's physical surface tension. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';
import {WATER_BODY_PUDDLE_DEPTH} from './waterBodyPuddles.ts';
import {waterBodyCells,type WaterBodyCells,type WaterCellFace} from './waterBodyCells.ts';

interface Work {head:Float64Array;active:Uint8Array;xx:Float64Array;zz:Float64Array;xz:Float64Array}
export interface WaterCapillaryGroups {owner:Int32Array;area:Float64Array;head:Float64Array;volume:Float64Array}
const cache=new WeakMap<WaterBodyManifest,Work>();
const strength=(w:WaterBodyManifest)=>w.puddleCohesion??.5;
const fade=(h:number)=>{const t=Math.max(0,Math.min(1,(WATER_BODY_PUDDLE_DEPTH-h)/.02));return t*t*(3-2*t);};
/** Only locally connected surfaces share a meniscus. A high dry rim, solid
 * wall, or actual terrain drop supplies a contact boundary, never a bridge. */
export function waterBodyCapillaryFace(w:WaterBodyManifest,s:WaterBodyState,geo:WaterBodyGeometry,i:number,j:number,axis:'x'|'z'):boolean {
  if(s.boundary){
    const cells=waterBodyCells(w,s);
    return cells.faces(geo).some(face=>(face.a===i&&face.b===j||face.a===j&&face.b===i)&&boundaryCapillaryFace(w,cells,face));
  }
  if(i<0||j<0||i>=s.depth.length||j>=s.depth.length||geo.blocked[i]||geo.blocked[j])return false;
  const bi=geo.bed[i]+(s.solidDepth?.[i]??0),bj=geo.bed[j]+(s.solidDepth?.[j]??0),hi=s.depth[i],hj=s.depth[j];
  if(Math.min(hi,hj)>=WATER_BODY_PUDDLE_DEPTH||Math.max(hi,hj)<=w.dryDepth)return false;
  if(Math.abs(bi-bj)>Math.max(hi,hj,.002)+1e-9||bi+hi<bj-1e-9||bj+hj<bi-1e-9)return false;
  const barrier=axis==='x'?geo.x[Math.max(i,j)]:geo.z[Math.floor(i/w.rows)*(w.rows+1)+Math.max(i%w.rows,j%w.rows)];
  return !barrier||barrier.top<Math.min(bi+hi,bj+hj)-1e-8;
}
/** Additional capillary-wave signal bound for the explicit conservative solve.
 * The bounded wetting derivative and discrete fourth-order curvature term are
 * both included, even when currentMixing/currents is disabled. */
export function waterBodyCapillaryRate(w:WaterBodyManifest,s:WaterBodyState,groups?:WaterCapillaryGroups):number {
  const amount=strength(w);if(!amount)return 0;
  if(s.boundary){
    const cells=waterBodyCells(w,s),count=groups?.area.length??cells.count,rows=new Float64Array(count),gradients=new Float64Array(count);
    const area=(i:number)=>groups?groups.area[i]:cells.area(i),depth=(i:number)=>groups?groups.volume[i]/groups.area[i]:cells.depth(i);
    for(const face of cells.faces()){
      if(face.b<0)continue;
      const a=groups?groups.owner[face.a]:face.a,b=groups?groups.owner[face.b]:face.b;if(a===b||a<0||b<0)continue;
      if(groups?!groupCapillaryFace(w,groups,face,a,b):!boundaryCapillaryFace(w,cells,face))continue;
      // The grouped solve has one head per combined control volume. Internal
      // cut edges therefore supply neither a wave nor a vanishing CFL length.
      const ordinary=cells.region(face.a)?.bulk&&cells.region(face.b)?.bulk;
      const distance=groups&&!ordinary?Math.max(face.distance,(Math.sqrt(area(a))+Math.sqrt(area(b)))*.5):face.distance;
      for(const i of [a,b]){rows[i]+=face.length/(area(i)*distance);gradients[i]+=face.length/area(i);}
    }
    let rate=0;
    for(let i=0;i<count;i++)if(area(i)>0&&depth(i)<WATER_BODY_PUDDLE_DEPTH){
      const wet=depth(i)*fade(depth(i));
      rate=Math.max(rate,Math.sqrt(-w.liquid.gravity.y*wet*(6.6*amount+4*.04*amount*rows[i]*.5))*gradients[i]*.5);
    }
    return rate;
  }
  const inverse=1/w.cellSizeX**2+1/w.cellSizeZ**2,lengthSquared=.04*amount,g=-w.liquid.gravity.y;
  let depth=0;for(const h of s.depth)if(h<WATER_BODY_PUDDLE_DEPTH)depth=Math.max(depth,h*fade(h));
  return Math.sqrt(g*depth*(6.6*amount+4*lengthSquared*inverse))*(1/w.cellSizeX+1/w.cellSizeZ);
}
export function waterBodyCapillaryHead(w:WaterBodyManifest,s:WaterBodyState,geo:WaterBodyGeometry,groups?:WaterCapillaryGroups):Work {
  if(s.boundary)return boundaryCapillaryHead(w,s,geo,groups);
  let work=cache.get(w);if(!work||work.head.length!==s.depth.length){const array=()=>new Float64Array(s.depth.length);work={head:array(),active:new Uint8Array(s.depth.length),xx:array(),zz:array(),xz:array()};cache.set(w,work);}
  const amount=strength(w);work.head.fill(0);work.active.fill(0);work.xx.fill(0);work.zz.fill(0);work.xz.fill(0);if(!amount)return work;
  const lengthSquared=.04*amount;
  // Surface step to a connected neighbour, or NaN where no meniscus is shared.
  const step=(i:number,j:number,axis:'x'|'z',eta:number)=>waterBodyCapillaryFace(w,s,geo,i,j,axis)?geo.bed[j]+(s.solidDepth?.[j]??0)+s.depth[j]-eta:NaN;
  for(let i=0;i<s.depth.length;i++){
    const h=s.depth[i];if(geo.blocked[i]||h>=WATER_BODY_PUDDLE_DEPTH)continue;
    const eta=geo.bed[i]+(s.solidDepth?.[i]??0)+h;let curvature=0,gradientX=0,gradientZ=0,connected=false;
    for(let k=0;k<4;k++){
      const axis=k<2?'x':'z',spacing=k<2?w.cellSizeX:w.cellSizeZ,j=k===0?i-w.rows:k===1?i+w.rows:k===2?(i%w.rows?i-1:-1):(i%w.rows+1<w.rows?i+1:-1);
      const difference=step(i,j,axis,eta);if(difference!==difference)continue;
      curvature+=difference/(spacing*spacing);if(axis==='x')gradientX+=Math.sign(j-i)*difference/(2*spacing);else gradientZ+=Math.sign(j-i)*difference/(2*spacing);connected=true;
    }
    if(!connected)continue;
    // Smooth, nonsingular partial-wetting potential. No precursor water is
    // created on dry terrain, and its correction vanishes in a filled pool.
    const wetting=-6.6*amount*h*Math.exp(-h/.008),capillary=-lengthSquared*curvature;
    work.head[i]=fade(h)*(wetting+Math.max(-.02*amount,Math.min(.02*amount,capillary)));work.active[i]=1;
    // Korteweg surface stress and the local wetting-pressure primitive. Face
    // fluxes apply this tensor equally and oppositely, so an asymmetric patch
    // cannot acquire horizontal momentum from its own cohesive forces.
    const t=h/.008,pressure=6.6*amount*.008**2*(1-(t*t+t+1)*Math.exp(-t)),blend=fade(h),g=-w.liquid.gravity.y;
    // Bound unresolved steep shoreline curvature by a small head, rather than
    // dividing an arbitrary deep-neighbor height jump by an almost-dry mass.
    const normal=h*Math.max(-.02*amount,Math.min(.02*amount,capillary));
    const bound=.01*amount*h,tension=Math.max(-bound,Math.min(bound,.5*lengthSquared*(gradientX*gradientX-gradientZ*gradientZ))),cross=Math.max(-bound,Math.min(bound,lengthSquared*gradientX*gradientZ));
    work.xx[i]=g*blend*(pressure+normal+tension);work.zz[i]=g*blend*(pressure+normal-tension);work.xz[i]=g*blend*cross;
  }
  return work;
}

function boundaryCapillaryFace(w:WaterBodyManifest,cells:WaterBodyCells,face:WaterCellFace):boolean{
  const {a,b}=face;if(a<0||b<0||a>=cells.count||b>=cells.count)return false;
  const ha=cells.depth(a),hb=cells.depth(b);if(Math.min(ha,hb)>=WATER_BODY_PUDDLE_DEPTH||Math.max(ha,hb)<=w.dryDepth)return false;
  const ba=cells.bed(a)+cells.solidDepth[a],bb=cells.bed(b)+cells.solidDepth[b],la=cells.level(a),lb=cells.level(b);
  if(Math.abs(ba-bb)>Math.max(ha,hb,.002)+1e-9||la<bb-1e-9||lb<ba-1e-9)return false;
  if(Math.min(la,lb)<Math.min(face.start.bed,face.end.bed)-1e-9)return false;
  return !face.barrier||face.barrier.top<Math.min(la,lb)-1e-8;
}
function groupCapillaryFace(w:WaterBodyManifest,groups:WaterCapillaryGroups,face:WaterCellFace,a:number,b:number):boolean{
  if(a===b||a<0||b<0||groups.area[a]<=0||groups.area[b]<=0)return false;
  const ha=groups.volume[a]/groups.area[a],hb=groups.volume[b]/groups.area[b],la=groups.head[a],lb=groups.head[b],ba=la-ha,bb=lb-hb;
  if(Math.min(ha,hb)>=WATER_BODY_PUDDLE_DEPTH||Math.max(ha,hb)<=w.dryDepth||Math.abs(ba-bb)>Math.max(ha,hb,.002)+1e-9||la<bb-1e-9||lb<ba-1e-9
    ||Math.min(la,lb)<Math.min(face.start.bed,face.end.bed)-1e-9)return false;
  return !face.barrier||face.barrier.top<Math.min(la,lb)-1e-8;
}
function boundaryCapillaryHead(w:WaterBodyManifest,s:WaterBodyState,geo:WaterBodyGeometry,groups?:WaterCapillaryGroups):Work{
  const cells=waterBodyCells(w,s),n=cells.count;let work=cache.get(w);
  if(!work||work.head.length!==n){const array=()=>new Float64Array(n);work={head:array(),active:new Uint8Array(n),xx:array(),zz:array(),xz:array()};cache.set(w,work);}
  work.head.fill(0);work.active.fill(0);work.xx.fill(0);work.zz.fill(0);work.xz.fill(0);
  const amount=strength(w);if(!amount)return work;
  const count=groups?.area.length??n,curvature=new Float64Array(count),gradientX=new Float64Array(count),gradientZ=new Float64Array(count),active=new Uint8Array(count),lengthSquared=.04*amount;
  const area=(i:number)=>groups?groups.area[i]:cells.area(i),head=(i:number)=>groups?groups.head[i]:cells.level(i);
  for(const face of cells.faces(geo)){
    if(face.b<0)continue;
    const a=groups?groups.owner[face.a]:face.a,b=groups?groups.owner[face.b]:face.b;
    if(groups?!groupCapillaryFace(w,groups,face,a,b):!boundaryCapillaryFace(w,cells,face))continue;
    const ordinary=cells.region(face.a)?.bulk&&cells.region(face.b)?.bulk;
    const {nx,nz,length}=face,distance=groups&&!ordinary?Math.max(face.distance,(Math.sqrt(area(a))+Math.sqrt(area(b)))*.5):face.distance,difference=head(b)-head(a);
    curvature[a]+=difference*length/(area(a)*distance);curvature[b]-=difference*length/(area(b)*distance);
    gradientX[a]+=difference*nx*length/(2*area(a));gradientX[b]+=difference*nx*length/(2*area(b));
    gradientZ[a]+=difference*nz*length/(2*area(a));gradientZ[b]+=difference*nz*length/(2*area(b));
    active[a]=active[b]=1;
  }
  for(let i=0;i<n;i++){
    const j=groups?groups.owner[i]:i,h=groups?groups.volume[j]/groups.area[j]:cells.depth(i);if(j<0||!active[j]||h>=WATER_BODY_PUDDLE_DEPTH)continue;
    work.active[i]=1;
    const wetting=-6.6*amount*h*Math.exp(-h/.008),capillary=-lengthSquared*curvature[j],blend=fade(h),g=-w.liquid.gravity.y;
    const bounded=Math.max(-.02*amount,Math.min(.02*amount,capillary));work.head[i]=blend*(wetting+bounded);
    const t=h/.008,pressure=6.6*amount*.008**2*(1-(t*t+t+1)*Math.exp(-t)),normal=h*bounded,bound=.01*amount*h;
    const tension=Math.max(-bound,Math.min(bound,.5*lengthSquared*(gradientX[j]**2-gradientZ[j]**2))),cross=Math.max(-bound,Math.min(bound,lengthSquared*gradientX[j]*gradientZ[j]));
    work.xx[i]=g*blend*(pressure+normal+tension);work.zz[i]=g*blend*(pressure+normal-tension);work.xz[i]=g*blend*cross;
  }
  return work;
}
