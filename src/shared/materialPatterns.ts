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
  type:typeof MATERIAL_PATTERN_TYPES[number];sizeMeters:number;coverage:number;irregularity:number;
  shapeVariation:number;sizeVariation:number;concentration:PatternConcentration;
  clumping:number;groupSizeMeters:number;boundary?:PatternConcentration;
  edgeSoftnessMeters:number;angleRadians:number;seed:number;invert:boolean;
}
export interface MaterialPatternMask extends MaterialPattern {
  gates:{operation:'intersect'|'union'|'subtract';pattern:MaterialPattern}[];
}
const defaults={sizeMeters:.12,coverage:.2,irregularity:.5,shapeVariation:0,sizeVariation:0,clumping:0,groupSizeMeters:.6,edgeSoftnessMeters:.003,angleRadians:0,seed:1,invert:false};
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
export interface MaterialPatternFeature {center:[number,number,number];probability:number;accepted:boolean;sizeScale:number}
/** Deterministic feature proposal and binary generation decision. Useful for authoring
 * diagnostics: changing distribution never scales a surviving feature's opacity/size.
 * Cell coordinates are integers in the pattern's physical generation domain.
 */
export function materialPatternFeatureAtCell(r:MaterialPattern,cell:Vec,frame?:MaterialPatternFrame):MaterialPatternFeature{
  if(!cell.every(Number.isSafeInteger))throw Error('Feature cell coordinates must be safe integers.');
  const {meters,dimensions}=domain(r,frame),[a,b,d]=cell,j=r.irregularity*.6;
  const center:[number,number,number]=[
    (a+.5+(hash(a,b,d,r.seed)-.5)*j)*r.sizeMeters,
    (b+.5+(hash(a,b,d,r.seed+1)-.5)*j)*r.sizeMeters,
    dimensions===2?0:(d+.5+(hash(a,b,d,r.seed+2)-.5)*j)*r.sizeMeters,
  ];
  const normalized=center.map((v,i)=>meters?.[i]?v*2/meters[i]!:0) as [number,number,number];
  let probability=.7;
  if(r.concentration.strength)probability=(1-Math.abs(r.concentration.strength))*.7+Math.abs(r.concentration.strength)*profile(r.concentration,normalized);
  if(r.clumping){const g=field(center[0]/r.groupSizeMeters,center[1]/r.groupSizeMeters,center[2]/r.groupSizeMeters,r.seed+941);probability=clamp(probability*((1-r.clumping)+r.clumping*clamp(.7+(g-.5)*5)/.7));}
  // A finite face/object cannot generate feature centres outside its bounds.
  if(meters&&normalized.some(v=>Math.abs(v)>1))probability=0;
  return{center,probability,accepted:hash(a,b,d,r.seed+977)<probability,sizeScale:1+r.sizeVariation*.35*(hash(a,b,d,r.seed+983)*2-1)};
}
function single(r:MaterialPattern,point:Vec,frame?:MaterialPatternFrame,applyBoundary=true){
  const finish=(w:number)=>(r.invert?1-w:w)*(applyBoundary?boundaryWeight(r.boundary,frame):1);
  if(r.coverage===0)return finish(0);
  if(r.coverage===1&&r.concentration.strength===0&&r.clumping===0)return finish(1);
  const {meters,dimensions}=domain(r,frame);
  if(dimensions===2&&!frame?.face)throw Error('Face generation requires normalized face coordinates.');
  const p:Vec=dimensions===2&&meters&&frame?.face?[frame.face[0]*meters[0]/2,frame.face[1]*meters[1]/2,0]:point;
  if(!p.every(Number.isFinite))throw Error('Pattern sample coordinates must be finite.');
  const raw=p.map(v=>v/r.sizeMeters),warped=raw.map((v,i)=>v+r.shapeVariation*.25*(field(raw[0]*3,raw[1]*3,raw[2]*3,r.seed+701+i*11)*2-1));
  const c=Math.cos(r.angleRadians),s=Math.sin(r.angleRadians),radius=.5*Math.sqrt(r.coverage),softness=Math.max(.000001,r.edgeSoftnessMeters/r.sizeMeters);
  let weight=0,first=Infinity,second=Infinity,winner:MaterialPatternFeature|undefined;
  for(let dz=dimensions===2?0:-1;dz<= (dimensions===2?0:1);dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    const cell:Vec=[Math.floor(raw[0])+dx,Math.floor(raw[1])+dy,dimensions===2?0:Math.floor(raw[2])+dz],feature=materialPatternFeatureAtCell(r,cell,frame);
    const x=(warped[0]-feature.center[0]/r.sizeMeters)/feature.sizeScale,y=(warped[1]-feature.center[1]/r.sizeMeters)/feature.sizeScale,z=dimensions===2?0:(warped[2]-feature.center[2]/r.sizeMeters)/feature.sizeScale;
    const u=x*c-y*s,v=x*s+y*c,dist=Math.hypot(u,v,z);
    if(dist<first){second=first;first=dist;winner=feature;}else second=Math.min(second,dist);
    if(!feature.accepted||r.type==='cells')continue;
    let signed:number;
    if(r.type==='stripes'||r.type==='veins'){
      const bend=r.type==='veins'?Math.sin(v*5+hash(...cell,r.seed+31)*6)*(.04+r.irregularity*.16):0;
      signed=Math.max(Math.hypot(u+bend,z)-radius*.4,Math.abs(v)-.6);
    }else{
      const scale=r.type==='speckles'?.5:r.type==='patches'?1.25:1;
      signed=dist-radius*scale;
    }
    const t=clamp(.5-signed/softness);weight=Math.max(weight,t*t*(3-2*t));
  }
  if(r.type==='cells'&&winner?.accepted){const t=clamp((Math.pow(r.coverage,.3)-first/Math.max(second,.000001))/softness+.5);weight=t*t*(3-2*t);}
  return finish(weight);
}
export function sampleMaterialPattern(pattern:MaterialPatternMask,point:Vec,frame?:MaterialPatternFrame):number{
  let weight=single(pattern,point,frame,false);for(const gate of pattern.gates){const v=single(gate.pattern,point,frame);weight=gate.operation==='intersect'?weight*v:gate.operation==='union'?1-(1-weight)*(1-v):weight*(1-v);}return weight*boundaryWeight(pattern.boundary,frame);
}
