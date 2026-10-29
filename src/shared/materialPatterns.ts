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
export interface MaterialPatternFrame {face?:readonly[number,number,number];model?:readonly[number,number,number]}
export interface MaterialPattern {
  type:typeof MATERIAL_PATTERN_TYPES[number];sizeMeters:number;coverage:number;irregularity:number;
  shapeVariation:number;sizeVariation:number;concentration:PatternConcentration;
  edgeSoftnessMeters:number;angleRadians:number;seed:number;invert:boolean;
}
export interface MaterialPatternMask extends MaterialPattern {
  gates:{operation:'intersect'|'union'|'subtract';pattern:MaterialPattern}[];
}
const defaults={sizeMeters:.12,coverage:.2,irregularity:.5,shapeVariation:0,sizeVariation:0,edgeSoftnessMeters:.003,angleRadians:0,seed:1,invert:false};
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
  const value=plain(input,['type',...Object.keys(defaults),'concentration']),r={...defaults,...Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined)),concentration:concentration(value.concentration)};
  if(!MATERIAL_PATTERN_TYPES.includes(value.type as MaterialPattern['type']))throw Error('Unknown material pattern.');
  number(r.sizeMeters,.002,20);number(r.coverage,0,1);number(r.irregularity,0,1);number(r.edgeSoftnessMeters,0,.2);number(r.angleRadians,-Math.PI*2,Math.PI*2);number(r.seed,-2147483648,2147483647);
  number(r.shapeVariation,0,1);number(r.sizeVariation,0,1);
  if(!Number.isInteger(r.seed)||typeof r.invert!=='boolean')throw Error('Pattern seed must be integer and invert boolean.');return r as unknown as MaterialPattern;
}
export function parseMaterialPattern(input:unknown):MaterialPatternMask{
  const value=plain(input,['type',...Object.keys(defaults),'concentration','gates']),{gates,...base}=value;
  if(gates!==undefined&&(!Array.isArray(gates)||gates.length>3))throw Error('A pattern supports up to three non-recursive gates.');
  return{...parseSingle(base),gates:(gates as unknown[]|undefined??[]).map(input=>{
    const gate=plain(input,['operation','pattern']);if(!['intersect','union','subtract'].includes(String(gate.operation)))throw Error('Unknown pattern gate operation.');
    return{operation:gate.operation as 'intersect'|'union'|'subtract',pattern:parseSingle(gate.pattern)};
  })};
}
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
function hash(x:number,y:number,z:number,seed:number){let n=Math.imul(x^seed,374761393)^Math.imul(y,668265263)^Math.imul(z,1274126177);n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967295;}
function field(x:number,y:number,z:number,seed:number){const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),f=[x-ix,y-iy,z-iz].map(v=>v*v*(3-2*v));let result=0;for(let dz=0;dz<=1;dz++)for(let dy=0;dy<=1;dy++)for(let dx=0;dx<=1;dx++)result+=hash(ix+dx,iy+dy,iz+dz,seed)*(dx?f[0]:1-f[0])*(dy?f[1]:1-f[1])*(dz?f[2]:1-f[2]);return result;}
function focus(r:PatternConcentration,frame?:MaterialPatternFrame){
  if(r.strength===0)return 1;
  const p=frame?.[r.space];if(!p||!p.every(Number.isFinite))throw Error('Concentration requires normalized '+r.space+' coordinates; use a geometry adapter or provide MaterialPatternFrame.');
  const radius=Math.hypot(...r.axes.split('').map(axis=>{const i={x:0,y:1,z:2}[axis]!;return(p[i]-r.center[i])/r.radius;}));
  const t=r.softness===0?(radius<=1?1:0):clamp((1-radius)/r.softness),inside=t*t*(3-2*t),profile=r.strength>0?inside:1-inside;
  return 1-Math.abs(r.strength)+Math.abs(r.strength)*profile;
}
function single(r:MaterialPattern,point:readonly[number,number,number],frame?:MaterialPatternFrame,applyFocus=true){
  const envelope=applyFocus?focus(r.concentration,frame):1,finish=(w:number)=>(r.invert?1-w:w)*envelope;
  if(r.coverage===0)return finish(0);if(r.coverage===1)return finish(1);
  const c=Math.cos(r.angleRadians),s=Math.sin(r.angleRadians);
  let x=(point[0]*c-point[1]*s)/r.sizeMeters,y=(point[0]*s+point[1]*c)/r.sizeMeters,z=point[2]/r.sizeMeters;
  // A smooth, bounded coordinate warp affects every pattern, not just cell centres.
  // Independent fields distort feature boundaries; a slower field changes spacing/size.
  if(r.shapeVariation||r.sizeVariation){
    const a=x,b=y,d=z;
    x=a+r.sizeVariation*1.4*(field(a*.35,b*.35,d*.35,r.seed+601)*2-1)+r.shapeVariation*.65*(field(a*2.7,b*2.7,d*2.7,r.seed+701)*2-1);
    y=b+r.sizeVariation*1.4*(field(a*.35,b*.35,d*.35,r.seed+607)*2-1)+r.shapeVariation*.65*(field(a*2.7,b*2.7,d*2.7,r.seed+709)*2-1);
    z=d+r.sizeVariation*1.4*(field(a*.35,b*.35,d*.35,r.seed+613)*2-1)+r.shapeVariation*.65*(field(a*2.7,b*2.7,d*2.7,r.seed+719)*2-1);
  }
  let distance=0;
  if(r.type==='stripes')distance=Math.abs(((x+r.irregularity*(field(x,y,z,r.seed)-.5))%1+1)%1-.5)*2;
  else if(r.type==='veins')distance=Math.abs(Math.sin((x+r.irregularity*3*field(x*.7,y*.7,z*.7,r.seed))*Math.PI));
  else if(r.type==='patches')distance=field(x,y,z,r.seed);
  else{
    let first=Infinity,second=Infinity;
    for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const a=Math.floor(x)+dx,b=Math.floor(y)+dy,d=Math.floor(z)+dz,j=r.irregularity*.8;
      const px=a+.5+(hash(a,b,d,r.seed)-.5)*j,py=b+.5+(hash(a,b,d,r.seed+1)-.5)*j,pz=d+.5+(hash(a,b,d,r.seed+2)-.5)*j;
      const dist=Math.hypot(x-px,y-py,z-pz);if(dist<first){second=first;first=dist;}else second=Math.min(second,dist);
    }
    distance=r.type==='cells'?clamp((second-first)*2):clamp(first/(r.type==='speckles'?.7:1));
  }
  // Coverage is an artistic amount, not a promise of exact projected area.
  const softness=Math.max(.000001,r.edgeSoftnessMeters/r.sizeMeters),t=clamp((r.coverage-distance)/softness+.5),weight=t*t*(3-2*t);return finish(weight);
}
export function sampleMaterialPattern(pattern:MaterialPatternMask,point:readonly[number,number,number],frame?:MaterialPatternFrame):number{
  let weight=single(pattern,point,frame,false);for(const gate of pattern.gates){const v=single(gate.pattern,point,frame);weight=gate.operation==='intersect'?weight*v:gate.operation==='union'?1-(1-weight)*(1-v):weight*(1-v);}return weight*focus(pattern.concentration,frame);
}
