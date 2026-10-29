/** Pure, bounded pattern data and sampling. Coordinates and sizes are model metres;
 * never feed a source material's repeated UVs into this mask.
 */
export const MATERIAL_PATTERN_TYPES=['patches','clusters','veins','cells','stripes','speckles'] as const;
export interface PatternConcentration {
  strength:number;space:'face'|'model';axes:'x'|'y'|'z'|'xy'|'xz'|'yz'|'xyz';
  center:[number,number,number];radius:number;softness:number;
}
/** Normalized coordinates: zero at the centre, +/-1 at each boundary.
 * Geometry adapters supply these independently of material UVs and pattern warping.
 */
export interface MaterialPatternFrame {face?:readonly[number,number,number];model?:readonly[number,number,number];faceMeters?:readonly[number,number];modelMeters?:readonly[number,number,number]}
export interface MaterialPattern {
  mode:'features'|'solid';
  type:typeof MATERIAL_PATTERN_TYPES[number];sizeMeters:number;coverage:number;irregularity:number;
  shapeVariation:number;sizeVariation:number;concentration:PatternConcentration;
  density:number;clumping:number;groupSizeMeters:number;placementRegularity:number;boundary?:PatternConcentration;
  edgeSoftnessMeters:number;angleRadians:number;seed:number;invert:boolean;
}
export interface MaterialPatternMask extends MaterialPattern {
  gates:{operation:'intersect'|'union'|'subtract';pattern:MaterialPattern}[];
}
const defaults={mode:'features',sizeMeters:.12,coverage:.2,irregularity:.5,shapeVariation:0,sizeVariation:0,density:32,clumping:0,groupSizeMeters:.6,placementRegularity:0,edgeSoftnessMeters:.003,angleRadians:0,seed:1,invert:false};
function plain(input:unknown,keys:string[]){if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).some(k=>!keys.includes(k)))throw Error('Pattern must contain only supported plain-data fields.');return input as Record<string,unknown>;}
function number(v:unknown,min:number,max:number){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error('Pattern parameter outside finite bounds.');return v;}
function concentration(input:unknown):PatternConcentration{
  const value=input===undefined?{}:plain(input,['strength','space','axes','center','radius','softness']);
  const r={strength:0,space:'face',axes:'xy',center:[0,0,0],radius:.85,softness:.2,...Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined))};
  number(r.strength,-1,1);number(r.radius,.01,2);number(r.softness,0,1);
  if(!['face','model'].includes(r.space)||!['x','y','z','xy','xz','yz','xyz'].includes(r.axes))throw Error('Concentration needs face/model space and supported axes.');
  if(!Array.isArray(r.center)||r.center.length!==3)throw Error('Concentration center needs three normalized coordinates.');
  return{...r,center:r.center.map(v=>number(v,-1,1))} as PatternConcentration;
}
function parseSingle(input:unknown):MaterialPattern{
  const value=plain(input,['type',...Object.keys(defaults),'concentration','boundary']),r={...defaults,...Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined)),concentration:concentration(value.concentration),...(value.boundary===undefined?{}:{boundary:concentration(value.boundary)})};
  if(!MATERIAL_PATTERN_TYPES.includes(value.type as MaterialPattern['type']))throw Error('Unknown material pattern.');
  number(r.sizeMeters,.002,20);number(r.coverage,0,1);number(r.irregularity,0,1);number(r.edgeSoftnessMeters,0,.2);number(r.angleRadians,-Math.PI*2,Math.PI*2);number(r.seed,-2147483648,2147483647);
  number(r.shapeVariation,0,1);number(r.sizeVariation,0,1);
  number(r.clumping,0,1);number(r.groupSizeMeters,.004,20);
  number(r.placementRegularity,0,1);
  number(r.density,0,256);if(!['features','solid'].includes(r.mode))throw Error('Pattern mode must be features or solid.');
  if(!Number.isInteger(r.seed)||typeof r.invert!=='boolean')throw Error('Pattern seed must be integer and invert boolean.');return r as unknown as MaterialPattern;
}
export function parseMaterialPattern(input:unknown):MaterialPatternMask{
  const value=plain(input,['type',...Object.keys(defaults),'concentration','boundary','gates']),{gates,...base}=value;
  if(gates!==undefined&&(!Array.isArray(gates)||gates.length>3))throw Error('A pattern supports up to three non-recursive gates.');
  return{...parseSingle(base),gates:(gates as unknown[]|undefined??[]).map(input=>{
    const gate=plain(input,['operation','pattern']);if(!['intersect','union','subtract'].includes(String(gate.operation)))throw Error('Unknown pattern gate operation.');
    return{operation:gate.operation as 'intersect'|'union'|'subtract',pattern:parseSingle(gate.pattern)};
  })};
}
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
function hash(x:number,y:number,z:number,seed:number){let n=Math.imul(x^seed,374761393)^Math.imul(y,668265263)^Math.imul(z,1274126177);n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967295;}
function field(x:number,y:number,z:number,seed:number){const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),f=[x-ix,y-iy,z-iz].map(v=>v*v*(3-2*v));let result=0;for(let dz=0;dz<=1;dz++)for(let dy=0;dy<=1;dy++)for(let dx=0;dx<=1;dx++)result+=hash(ix+dx,iy+dy,iz+dz,seed)*(dx?f[0]:1-f[0])*(dy?f[1]:1-f[1])*(dz?f[2]:1-f[2]);return result;}
type Vec=readonly[number,number,number];
function profile(r:PatternConcentration,p:Vec){
  const radius=Math.hypot(...r.axes.split('').map(axis=>{const i={x:0,y:1,z:2}[axis]!;return(p[i]-r.center[i])/r.radius;}));
  const t=r.softness===0?(radius<=1?1:0):clamp((1-radius)/r.softness),inside=t*t*(3-2*t);return r.strength>=0?inside:1-inside;
}
function boundaryWeight(r:PatternConcentration|undefined,frame?:MaterialPatternFrame){
  if(!r||r.strength===0)return 1;const p=frame?.[r.space];
  if(!p||!p.every(Number.isFinite))throw Error('Boundary requires normalized '+r.space+' coordinates.');
  return 1-Math.abs(r.strength)+Math.abs(r.strength)*profile(r,p);
}
function domain(r:MaterialPattern,frame?:MaterialPatternFrame){
  const meters=r.concentration.space==='face'?frame?.faceMeters:frame?.modelMeters;
  if(meters&&(meters.length!==(r.concentration.space==='face'?2:3)||!meters.every(v=>Number.isFinite(v)&&v>0)))throw Error('Pattern domain dimensions must match the selected space and be positive finite metres.');
  if(r.concentration.strength!==0&&!meters)throw Error('Distribution requires '+r.concentration.space+' dimensions in MaterialPatternFrame.');
  return{meters,dimensions:meters?.length===2?2:3};
}
export interface MaterialPatternFeature {id:string;proposal:'grid'|'scatter'|'group';center:[number,number,number];probability:number;accepted:boolean;sizeScale:number;groupId?:string}
/** Deterministic feature proposal and binary generation decision. Useful for authoring
 * diagnostics: changing distribution never scales a surviving feature's opacity/size.
 * Cell coordinates are integers in the pattern's physical generation domain.
 */
export function materialPatternFeatureAtCell(r:MaterialPattern,cell:Vec,frame?:MaterialPatternFrame):MaterialPatternFeature{
  if(!cell.every(Number.isSafeInteger))throw Error('Feature cell coordinates must be safe integers.');
  const {dimensions}=domain(r,frame),[a,b,d]=cell,j=0,spacing=Math.pow(r.density||1,-1/dimensions);
  const center:[number,number,number]=[
    (a+.5+(hash(a,b,d,r.seed)-.5)*j)*spacing,
    (b+.5+(hash(a,b,d,r.seed+1)-.5)*j)*spacing,
    dimensions===2?0:(d+.5+(hash(a,b,d,r.seed+2)-.5)*j)*spacing,
  ];
  return feature(r,cell,center,frame,-1,r.mode==='features'&&r.density>0&&hash(a,b,d,r.seed+1003)<r.placementRegularity);
}
function feature(r:MaterialPattern,cell:Vec,center:[number,number,number],frame:MaterialPatternFrame|undefined,slot:number,selected=true,proposal:'grid'|'scatter'|'group'=slot<0?'grid':'scatter',idPrefix=''):MaterialPatternFeature{
  const {meters}=domain(r,frame),[a,b,d]=cell,offset=slot<0?0:(slot+1)*43;
  const normalized=center.map((v,i)=>meters?.[i]?v*2/meters[i]!:0) as [number,number,number];
  let probability=1;
  if(r.concentration.strength)probability=1-Math.abs(r.concentration.strength)+Math.abs(r.concentration.strength)*profile(r.concentration,normalized);
  // Ordered placements retain their grid; grouping modulates occupancy there.
  // Scattered/grouped proposals instead come from actual parent/offspring births.
  if(r.clumping&&proposal==='grid'){const g=field(center[0]/r.groupSizeMeters,center[1]/r.groupSizeMeters,center[2]/r.groupSizeMeters,r.seed+941);probability=clamp(probability*((1-r.clumping)+r.clumping*clamp(.7+(g-.5)*5)/.7));}
  // A finite face/object cannot generate feature centres outside its bounds.
  if(!selected||meters&&normalized.some(v=>Math.abs(v)>1))probability=0;
  return{id:idPrefix+cell.join(':')+':'+slot,proposal,center,probability,accepted:hash(a,b,d,r.seed+977+offset)<probability,sizeScale:1+r.sizeVariation*.35*(hash(a,b,d,r.seed+983+offset)*2-1)};
}
function poisson(lambda:number,u:number,cap:number){let count=0,mass=Math.exp(-lambda),cdf=mass;while(u>cdf&&count<cap){count++;mass*=lambda/count;cdf+=mass;}return count;}
/** Full proposal set: a density-preserving mixture of ordered points and a
 * bounded Poisson process. Random regions may contain zero or several points;
 * this is not one jittered feature per cell. Cell boundaries are implementation
 * partitions, not visible placement rows. At most four scatter proposals/region.
 */
export function materialPatternFeaturesAtCell(r:MaterialPattern,cell:Vec,frame?:MaterialPatternFrame):MaterialPatternFeature[]{
  if(!cell.every(Number.isSafeInteger))throw Error('Feature cell coordinates must be safe integers.');
  const {dimensions}=domain(r,frame),[a,b,d]=cell,result:MaterialPatternFeature[]=[];
  if(r.density===0||r.mode==='solid')return result;
  const spacing=Math.pow(r.density,-1/dimensions);
  if(hash(a,b,d,r.seed+1003)<r.placementRegularity)result.push(materialPatternFeatureAtCell(r,cell,frame));
  const lambda=(1-r.placementRegularity)*(1-r.clumping),count=poisson(lambda,hash(a,b,d,r.seed+1013),4);
  for(let slot=0;slot<count;slot++){const offset=slot*53;
    const center:[number,number,number]=[(a+hash(a,b,d,r.seed+1103+offset))*spacing,(b+hash(a,b,d,r.seed+1117+offset))*spacing,dimensions===2?0:(d+hash(a,b,d,r.seed+1123+offset))*spacing];
    result.push(feature(r,cell,center,frame,slot));
  }return result;
}
/** Parent/offspring grouping. Group size sets parent spacing and the radius of
 * child collections. Density changes child counts, not their individual sizes.
 */
export function materialPatternGroupedFeaturesAtCell(r:MaterialPattern,cell:Vec,frame?:MaterialPatternFrame):MaterialPatternFeature[]{
  if(!cell.every(Number.isSafeInteger))throw Error('Group cell coordinates must be safe integers.');
  if(!r.clumping||!r.density||r.placementRegularity===1||r.mode==='solid')return[];
  const {dimensions}=domain(r,frame),lambda=r.density*r.clumping*(1-r.placementRegularity)*Math.pow(r.groupSizeMeters,dimensions);
  if(lambda>256)throw Error('Group size and feature amount exceed the group sampling budget. Reduce group size or feature amount.');
  const [a,b,d]=cell,result:MaterialPatternFeature[]=[],parents=poisson(1,hash(a,b,d,r.seed+2003),4);
  for(let parent=0;parent<parents;parent++){
    const seed=r.seed+parent*997,center=[(a+hash(a,b,d,seed+2011))*r.groupSizeMeters,(b+hash(a,b,d,seed+2017))*r.groupSizeMeters,dimensions===2?0:(d+hash(a,b,d,seed+2027))*r.groupSizeMeters];
    const children=poisson(lambda,hash(a,b,d,seed+2039),512),groupId=cell.join(':')+':parent:'+parent;
    for(let child=0;child<children;child++){
      const offset=child*59,radius=.45*r.groupSizeMeters*Math.pow(hash(a,b,d,seed+2053+offset),1.5),angle=hash(a,b,d,seed+2063+offset)*Math.PI*2,z=dimensions===2?0:hash(a,b,d,seed+2069+offset)*2-1,radial=Math.sqrt(1-z*z);
      const point:[number,number,number]=[center[0]+radius*radial*Math.cos(angle),center[1]+radius*radial*Math.sin(angle),center[2]+radius*z];
      const f=feature(r,cell,point,frame,child+parent*1024,true,'group','group:');f.groupId=groupId;result.push(f);
    }
  }return result;
}

/** Counts generated centres in a finite domain, before gates, opacity and overlap.
 * Bounded inspection reports incomplete rather than blocking on huge domains. */
export function inspectMaterialPatternDistribution(r:MaterialPattern,frame:MaterialPatternFrame){
  const {meters,dimensions}=domain(r,frame);
  if(!meters)throw Error('Distribution inspection requires physical domain dimensions.');
  let count=0,groups=new Set<string>(),regions=0,complete=true;
  if(r.mode==='solid'||!r.density)return{count,groups:0,regions,complete,solid:r.mode==='solid'};
  for(const grouped of [false,true]){
    if(grouped&&(!r.clumping||r.placementRegularity===1))continue;
    const spacing=grouped?r.groupSizeMeters:Math.pow(r.density,-1/dimensions),pad=grouped?.45:0;
    const low=meters.map(v=>Math.floor(-v/2/spacing-pad)),high=meters.map(v=>Math.floor(v/2/spacing+pad));
    outer:for(let z=dimensions===2?0:low[2];z<=(dimensions===2?0:high[2]);z++)for(let y=low[1];y<=high[1];y++)for(let x=low[0];x<=high[0];x++){
      if(regions++>=4096){complete=false;break outer;}
      for(const f of (grouped?materialPatternGroupedFeaturesAtCell:materialPatternFeaturesAtCell)(r,[x,y,z],frame))if(f.accepted){count++;if(f.groupId)groups.add(f.groupId);}
    }
    if(!complete)break;
  }
  return{count,groups:groups.size,regions,complete,solid:false};
}
type Proposals=(cell:Vec,frame?:MaterialPatternFrame,grouped?:boolean)=>readonly MaterialPatternFeature[];
function single(r:MaterialPattern,point:Vec,frame?:MaterialPatternFrame,applyBoundary=true,proposals:Proposals=(cell,frame,grouped)=>grouped?materialPatternGroupedFeaturesAtCell(r,cell,frame):materialPatternFeaturesAtCell(r,cell,frame)){
  const finish=(w:number)=>(r.invert?1-w:w)*(applyBoundary?boundaryWeight(r.boundary,frame):1);
  if(r.mode==='solid')return finish(1);
  if(r.coverage===0||r.density===0)return finish(0);
  const {meters,dimensions}=domain(r,frame);
  if(dimensions===2&&!frame?.face)throw Error('Face generation requires normalized face coordinates.');
  const p:Vec=dimensions===2&&meters&&frame?.face?[frame.face[0]*meters[0]/2,frame.face[1]*meters[1]/2,0]:point;
  if(!p.every(Number.isFinite))throw Error('Pattern sample coordinates must be finite.');
  const spacing=Math.pow(r.density,-1/dimensions),raw=p.map(v=>v/r.sizeMeters),warped=raw.map((v,i)=>v+r.shapeVariation*.25*(field(raw[0]*3,raw[1]*3,raw[2]*3,r.seed+701+i*11)*2-1));
  const c=Math.cos(r.angleRadians),s=Math.sin(r.angleRadians),radius=.5*Math.sqrt(r.coverage),softness=Math.max(.000001,r.edgeSoftnessMeters/r.sizeMeters);
  let weight=0,first=Infinity,second=Infinity,winner:MaterialPatternFeature|undefined;
  const draw=(feature:MaterialPatternFeature)=>{
    const x=(warped[0]-feature.center[0]/r.sizeMeters)/feature.sizeScale,y=(warped[1]-feature.center[1]/r.sizeMeters)/feature.sizeScale,z=dimensions===2?0:(warped[2]-feature.center[2]/r.sizeMeters)/feature.sizeScale;
    const u=x*c-y*s,v=x*s+y*c,dist=Math.hypot(u,v,z);
    if(dist<first){second=first;first=dist;winner=feature;}else second=Math.min(second,dist);
    if(!feature.accepted||r.type==='cells')return;
    let signed:number;
    if(r.type==='stripes'||r.type==='veins'){
      const bend=r.type==='veins'?Math.sin(v*5+feature.center[0]/r.sizeMeters*7)*(.04+r.irregularity*.16):0;
      signed=Math.max(Math.hypot(u+bend,z)-radius*.4,Math.abs(v)-.6);
    }else{
      const scale=r.type==='speckles'?.5:r.type==='patches'?1.25:1;
      signed=dist-radius*scale;
    }
    const t=clamp(.5-signed/softness);weight=Math.max(weight,t*t*(3-2*t));
  };
  const support=r.type==='cells'?1.5:.9+softness*.675,reach=Math.ceil((support+.25)*r.sizeMeters/spacing)+1;
  if(reach>8)throw Error('Feature amount and size exceed the sampling budget. Reduce density or feature size.');
  const queryBase=warped.map(v=>v*r.sizeMeters/spacing),baseSupport=support*r.sizeMeters/spacing;
  for(let dz=dimensions===2?0:-reach;dz<= (dimensions===2?0:reach);dz++)for(let dy=-reach;dy<=reach;dy++)for(let dx=-reach;dx<=reach;dx++){
    const cell:Vec=[Math.floor(queryBase[0])+dx,Math.floor(queryBase[1])+dy,dimensions===2?0:Math.floor(queryBase[2])+dz];
    if(Math.hypot(...cell.slice(0,dimensions).map((v,i)=>Math.max(v-queryBase[i],queryBase[i]-v-1,0)))>baseSupport)continue;
    for(const feature of proposals(cell,frame))draw(feature);
  }
  if(r.clumping&&r.placementRegularity<1){
    const groupReach=Math.ceil(support*r.sizeMeters/r.groupSizeMeters+.45)+1;
    if(groupReach>8)throw Error('Group size is too small for the feature-size sampling budget. Increase group size or reduce feature size.');
    const query=warped.map(v=>v*r.sizeMeters/r.groupSizeMeters),groupSupport=support*r.sizeMeters/r.groupSizeMeters+.45;
    for(let dz=dimensions===2?0:-groupReach;dz<=(dimensions===2?0:groupReach);dz++)for(let dy=-groupReach;dy<=groupReach;dy++)for(let dx=-groupReach;dx<=groupReach;dx++){
      const cell:Vec=[Math.floor(query[0])+dx,Math.floor(query[1])+dy,dimensions===2?0:Math.floor(query[2])+dz];
      if(Math.hypot(...cell.slice(0,dimensions).map((v,i)=>Math.max(v-query[i],query[i]-v-1,0)))>groupSupport)continue;
      for(const feature of proposals(cell,frame,true))draw(feature);
    }
  }
  if(r.type==='cells'&&winner?.accepted){const t=clamp((Math.pow(r.coverage,.3)-first/Math.max(Math.min(second,1.5),.000001))/softness+.5),cap=clamp(.5-(first-.85)/softness);weight=t*t*(3-2*t)*cap*cap*(3-2*cap);}
  return finish(weight);
}
export type MaterialPatternSampler=(point:Vec,frame?:MaterialPatternFrame)=>number;
/** Compile a validated snapshot for a bake. The bounded per-domain proposal cache
 * avoids regenerating random points for every pixel. External recipe edits require
 * a new sampler; old sampler snapshots remain deterministic and independent.
 */
export function createMaterialPatternSampler(input:unknown):MaterialPatternSampler{
  const pattern=parseMaterialPattern(input);
  function cached(r:MaterialPattern):Proposals{
    const domains=new Map<string,Map<string,readonly MaterialPatternFeature[]>>();let entries=0,features=0;
    return(cell,frame,grouped)=>{const {meters,dimensions}=domain(r,frame),key=Number(Boolean(grouped))+':'+dimensions+':'+(meters?.join(',')??'unbounded');
      if(entries>=8192||features>=32768){domains.clear();entries=0;features=0;}let cache=domains.get(key);if(!cache){cache=new Map();domains.set(key,cache);}
      const id=cell.join(',');let value=cache.get(id);if(!value){value=grouped?materialPatternGroupedFeaturesAtCell(r,cell,frame):materialPatternFeaturesAtCell(r,cell,frame);cache.set(id,value);entries++;features+=value.length;}return value;
    };
  }
  const root=cached(pattern),gates=pattern.gates.map(gate=>({...gate,proposals:cached(gate.pattern)}));
  return(point,frame)=>{let weight=single(pattern,point,frame,false,root);for(const gate of gates){const v=single(gate.pattern,point,frame,true,gate.proposals);weight=gate.operation==='intersect'?weight*v:gate.operation==='union'?1-(1-weight)*(1-v):weight*(1-v);}return weight*boundaryWeight(pattern.boundary,frame);};
}
export function sampleMaterialPattern(pattern:MaterialPatternMask,point:Vec,frame?:MaterialPatternFrame):number{
  let weight=single(pattern,point,frame,false);for(const gate of pattern.gates){const v=single(gate.pattern,point,frame);weight=gate.operation==='intersect'?weight*v:gate.operation==='union'?1-(1-weight)*(1-v):weight*(1-v);}return weight*boundaryWeight(pattern.boundary,frame);
}
