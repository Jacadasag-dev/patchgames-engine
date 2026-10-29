import {parseMaterialFracture,createMaterialFractureSampler,type MaterialFracture} from './materialFracture.ts';
import {z} from 'zod';
import type {TexturePixels} from './materialRecipeRenderer.ts';

const unit=z.number().finite().min(0).max(1);
const color=z.string().regex(/^#[0-9a-f]{6}$/i);
const length=z.number().finite().min(0.002).max(100);
/** Data-only recipes. All lengths are metres; unrelated family controls are rejected. */
export const materialGeneratorSchema=z.object({
  version:z.literal(1).default(1),seed:z.number().int().min(-2147483648).max(2147483647).default(1),
  name:z.string().min(1).max(120).default('Generated material'),tileMeters:z.tuple([length,length]).default([2,2]),
  color:color.default('#967b60'),secondaryColor:color.default('#514637'),variation:unit.default(0.3),roughness:unit.default(0.8),weathering:unit.default(0.15),
  fracture:z.unknown().transform((input,ctx)=>{try{return parseMaterialFracture(input);}catch(error){ctx.addIssue({code:'custom',message:String(error)});return z.NEVER;}}).optional(),
  optics:z.object({transmission:unit.default(0),ior:z.number().finite().min(1).max(2.5).default(1.5),thicknessMeters:z.number().finite().min(0).max(2).default(.02),attenuationColor:color.default('#ffffff'),attenuationDistanceMeters:z.number().finite().min(.001).max(100).default(1),envMapIntensity:z.number().finite().min(0).max(4).default(1)}).strict().optional(),
  reliefMeters:z.number().finite().min(0).max(0.2).default(0.008),
  output:z.object({resolution:z.union([z.literal(32),z.literal(64),z.literal(128),z.literal(256),z.literal(512),z.literal(1024),z.literal(2048)]).default(256),style:z.enum(['realistic','stylized','pixel']).default('realistic'),paletteSteps:z.number().int().min(2).max(32).default(8)}).strict().default({resolution:256,style:'realistic',paletteSteps:8}),
  pattern:z.discriminatedUnion('family',[
    z.object({family:z.literal('masonry'),shape:z.enum(['rectangle','square','triangle']).default('rectangle'),blockMeters:z.tuple([length,length]).default([0.4,0.2]),bond:z.enum(['stack','staggered']).default('staggered'),mortarMeters:z.number().finite().min(0).max(0.1).default(0.012),irregularity:unit.default(0.2),chipping:unit.default(0.15)}).strict(),
    z.object({family:z.literal('rock'),grainMeters:length.default(0.08),fractures:unit.default(0.3),layering:unit.default(0.2)}).strict(),
    z.object({family:z.literal('wood'),plankMeters:length.default(0.2),grain:unit.default(0.7),knots:unit.default(0.3),gapMeters:z.number().finite().min(0).max(0.05).default(0.004),direction:z.enum(['vertical','horizontal']).default('vertical')}).strict(),
    z.object({family:z.literal('dirt'),grainMeters:length.default(0.05),clumping:unit.default(0.6),moisture:unit.default(0.1),stones:unit.default(0.2)}).strict(),
    z.object({family:z.literal('gravel'),stoneMeters:length.default(0.08),roundness:unit.default(0.6),sizeVariation:unit.default(0.4)}).strict(),
    z.object({family:z.literal('grass'),bladeMeters:length.default(0.03),density:unit.default(0.8),dryness:unit.default(0.2),barePatches:unit.default(0.15)}).strict(),
    z.object({family:z.literal('metal'),brushing:unit.default(0.4),oxidation:unit.default(0.1),metalness:unit.default(0.95)}).strict(),
    z.object({family:z.literal('plaster'),grainMeters:length.default(0.02),cracks:unit.default(0.15)}).strict(),
    z.object({family:z.literal('bark'),ridgeMeters:length.default(.04),fissures:unit.default(.7),peeling:unit.default(.2),knots:unit.default(.3),direction:z.enum(['vertical','horizontal']).default('vertical')}).strict(),
    z.object({family:z.literal('leaf'),lengthMeters:length.default(.18),widthMeters:length.default(.08),veinSpacingMeters:length.default(.015),veins:unit.default(.7),edgeSerration:unit.default(.2),damage:unit.default(.05),outline:z.enum(['pointed','oval','lobed','palmate']).default('pointed')}).strict(),
    z.object({family:z.literal('needle'),lengthMeters:length.default(.12),widthMeters:length.default(.006),taper:unit.default(.8),veins:unit.default(.5),damage:unit.default(0)}).strict(),
    z.object({family:z.literal('exposed-wood'),ringMeters:length.default(.008),grain:unit.default(.6),knots:unit.default(.2),cut:z.enum(['end','lengthwise']).default('end')}).strict(),
  ]),
}).strict().superRefine((r,ctx)=>{
  if(r.pattern.family==='masonry' && r.pattern.mortarMeters>=Math.min(...r.pattern.blockMeters)/2)
    ctx.addIssue({code:'custom',path:['pattern','mortarMeters'],message:'Mortar must be thinner than half the smallest block dimension.'});
  if(r.pattern.family==='wood' && r.pattern.gapMeters>=r.pattern.plankMeters/2)
    ctx.addIssue({code:'custom',path:['pattern','gapMeters'],message:'Gap must be thinner than half the plank width.'});
});
export type MaterialGeneratorRecipe=z.input<typeof materialGeneratorSchema>;
export type ResolvedMaterialGenerator=z.output<typeof materialGeneratorSchema>;
export type MaterialOptics=NonNullable<ResolvedMaterialGenerator['optics']>;
export const MATERIAL_FAMILIES=['masonry','rock','wood','dirt','gravel','grass','metal','plaster','bark','leaf','needle','exposed-wood'] as const;
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const wrap=(v:number,n=1)=>((v%n)+n)%n;
function hash(x:number,y:number,seed:number){let v=Math.imul(x^seed,374761393)^Math.imul(y+seed,668265263);v=Math.imul(v^(v>>>13),1274126177);return((v^(v>>>16))>>>0)/4294967295;}
function noise(u:number,v:number,nx:number,ny:number,seed:number){
  const x=wrap(u)*nx,y=wrap(v)*ny,ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
  return mix(mix(hash(ix,iy,seed),hash((ix+1)%nx,iy,seed),sx),mix(hash(ix,(iy+1)%ny,seed),hash((ix+1)%nx,(iy+1)%ny,seed),sx),sy);
}
const cells=(span:number,size:number)=>Math.max(1,Math.min(256,Math.round(span/size)));
const defaultFracture=parseMaterialFracture({});
const fractureCache=new Map<string,ReturnType<typeof createMaterialFractureSampler>>();
/** Shared fracture field for map baking, object surfaces and point probes. */
export function materialFractureAt(r:ResolvedMaterialGenerator,u:number,v:number,footprintMeters=0){
  const familyStrength=r.pattern.family==='plaster'?r.pattern.cracks:r.pattern.family==='rock'?r.pattern.fractures:0;
  const fracture:MaterialFracture|undefined=r.fracture??(familyStrength?{...defaultFracture,strength:familyStrength,spreadMeters:Math.max(...r.tileMeters)}:undefined);
  if(!fracture)return;
  const key=JSON.stringify([fracture,r.tileMeters,r.seed]);let sampler=fractureCache.get(key);if(!sampler){if(fractureCache.size>=128)fractureCache.clear();sampler=createMaterialFractureSampler(fracture,r.tileMeters,r.seed);fractureCache.set(key,sampler);}
  return{fracture,weight:sampler.sample(wrap(u),wrap(v),footprintMeters)};
}
/** Periodic fields: colour, height, roughness, metalness and cavity shade describe one surface. */
export function sampleMaterialGenerator(r:ResolvedMaterialGenerator,u:number,v:number,footprintMeters=0):[number,number,number,number,number]{
  u=wrap(u);v=wrap(v);const p=r.pattern,s=r.seed,coarse=noise(u,v,8,8,s),fine=noise(u,v,64,64,s+91),micro=noise(u,v,256,256,s+157);
  let h=0.4+0.15*coarse,t=coarse,rough=r.roughness,metal=0,ao=1;
  if(p.family==='masonry'){
    const nx=cells(r.tileMeters[0],p.shape==='square'?p.blockMeters[1]:p.blockMeters[0]);let ny=cells(r.tileMeters[1],p.blockMeters[1]);
    if(p.bond==='staggered'&&ny%2)ny++;
    const row=Math.floor(v*ny),x=u*nx+(p.bond==='staggered'?(row%2)*0.5:0),col=Math.floor(x),fx=wrap(x),fy=wrap(v*ny),id=hash(wrap(col,nx),row,s);
    const edge=Math.min(Math.min(fx,1-fx)*r.tileMeters[0]/nx,Math.min(fy,1-fy)*r.tileMeters[1]/ny,p.shape==='triangle'?Math.abs(fx-fy)*Math.min(r.tileMeters[0]/nx,r.tileMeters[1]/ny):Infinity);
    const damaged=edge-(fine-0.4)*p.chipping*0.012-(coarse-0.5)*p.irregularity*0.012,top=clamp((damaged-p.mortarMeters/2)/0.008);
    h=0.12+top*(0.65+(id-0.5)*p.irregularity*0.3)+fine*0.04;t=top*(0.55+(id-0.5)*r.variation)+0.08;ao=0.65+0.35*top;
  }else if(p.family==='wood'){
    const a=p.direction==='vertical'?u:v,b=p.direction==='vertical'?v:u,span=p.direction==='vertical'?r.tileMeters[0]:r.tileMeters[1],nx=cells(span,p.plankMeters),fx=wrap(a*nx);
    const plank=Math.floor(a*nx),knotY=hash(plank,1,s),kx=(fx-0.5)*3,ky=(wrap(b-knotY+0.5)-0.5)*12;
    const knotDistance=Math.hypot(kx,ky),knot=p.knots*Math.exp(-knotDistance*knotDistance*3),bend=noise(a,b,nx,8,s)*1.3+knot*1.8;
    const grain=(Math.sin(2*Math.PI*(a*nx*4+bend))+1)/2,edge=Math.min(fx,1-fx)*span/nx,top=clamp((edge-p.gapMeters/2)/0.002);
    t=(0.4+grain*p.grain*0.3+hash(plank,0,s)*r.variation*0.2-knot*0.3)*top;h=0.15+top*(0.5+grain*0.04*p.grain-knot*0.03);ao=0.6+0.4*top;
  }else if(p.family==='gravel'){
    const nx=cells(r.tileMeters[0],p.stoneMeters),ny=cells(r.tileMeters[1],p.stoneMeters),x=u*nx,y=v*ny;let best=9,second=9,id=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const cx=Math.floor(x)+dx,cy=Math.floor(y)+dy,kx=wrap(cx,nx),ky=wrap(cy,ny),k=hash(kx,ky,s),px=cx+0.5+(k-0.5)*p.sizeVariation,py=cy+0.5+(hash(kx,ky,s+1)-0.5)*p.sizeVariation;
      const dist=Math.pow(Math.abs(x-px),mix(1,2,p.roundness))+Math.pow(Math.abs(y-py),mix(1,2,p.roundness));if(dist<best){second=best;best=dist;id=k;}else second=Math.min(second,dist);
    }
    const gap=clamp((second-best)*12);h=clamp(1-best*1.5)*gap;t=(0.3+id*0.55)*(0.6+gap*0.4)+(micro-0.5)*0.1;ao=0.55+0.45*gap;
  }else if(p.family==='rock'){
    const n=noise(u,v,cells(r.tileMeters[0],p.grainMeters),cells(r.tileMeters[1],p.grainMeters),s+3);
    h=0.3+n*0.4;t=n*0.7+0.15+Math.sin(v*Math.PI*16+coarse*2)*p.layering*0.1;ao=1;
  }else if(p.family==='dirt'){
    const n=noise(u,v,cells(r.tileMeters[0],p.grainMeters),cells(r.tileMeters[1],p.grainMeters),s+3);h=0.2+coarse*p.clumping*0.4+n*0.2+(n>0.8?p.stones*0.2:0);t=n*0.3+coarse*0.4-p.moisture*0.2;rough*=1-p.moisture*0.65;
  }else if(p.family==='grass'){
    const n=noise(u,v,cells(r.tileMeters[0],p.bladeMeters),cells(r.tileMeters[1],p.bladeMeters*4),s+3),growth=coarse>p.barePatches?1:0.15;h=n*p.density*growth*0.6;t=0.2+n*p.density*growth*0.6+p.dryness*0.2;
  }else if(p.family==='metal'){
    h=0.5+noise(u,v,4,128,s)*p.brushing*0.04;t=0.5+fine*0.2-coarse*p.oxidation*0.3;metal=p.metalness*(1-p.oxidation*coarse);rough=clamp(rough+coarse*p.oxidation*0.3);
  }else if(p.family==='bark'){
    const a=p.direction==='vertical'?u:v,b=p.direction==='vertical'?v:u,span=p.direction==='vertical'?r.tileMeters[0]:r.tileMeters[1],nx=cells(span,p.ridgeMeters);
    const bend=noise(u,v,8,8,s)*.9+Math.sin(b*Math.PI*8)*p.knots*.4,phase=(a*nx+bend)*Math.PI*2,ridge=(Math.sin(phase)+1)/2,crack=Math.pow(1-ridge,5)*p.fissures;
    const peel=Math.max(0,noise(u,v,nx,16,s+7)-.55)*p.peeling;
    h=.35+ridge*.3-crack*.3+peel*.5;t=.22+ridge*.45-crack*.2+peel;ao=1-crack*.6;rough=clamp(r.roughness+peel*.2);
  }else if(p.family==='leaf'||p.family==='needle'){
    const x=(u-.5)*r.tileMeters[0],y=(v-.5)*r.tileMeters[1],half=p.lengthMeters/2;
    const centre=Math.exp(-Math.abs(x)/Math.max(.0002,p.widthMeters*.025)),spacing=p.family==='leaf'?p.veinSpacingMeters:p.lengthMeters*.2;
    const branch=(1-Math.abs(Math.sin((y-Math.abs(x)*.7)*Math.PI/spacing)))**12;
    const vein=clamp(centre+branch*.6)*p.veins;h=.45+vein*.18+Math.max(0,1-Math.abs(x)/(p.widthMeters/2))*.08;t=.35+coarse*.25+vein*.15+(y/half)*.04;ao=1-vein*.08;
  }else if(p.family==='exposed-wood'){
    const x=(u-.5)*r.tileMeters[0],y=(v-.5)*r.tileMeters[1],radius=Math.hypot(x,y);
    const phase=(p.cut==='end'?radius:x)/p.ringMeters+coarse*p.knots*2,ring=(Math.sin(phase*Math.PI*2)+1)/2;
    t=.3+ring*p.grain*.35+coarse*.2;h=.4+ring*p.grain*.07;ao=1-(1-ring)*.1;
  }else{
    const n=noise(u,v,cells(r.tileMeters[0],p.grainMeters),cells(r.tileMeters[1],p.grainMeters),s+3);h=0.5+n*0.08;t=0.6+n*0.15;ao=1;
  }
  const damage=materialFractureAt(r,u,v,footprintMeters);if(damage){rough=mix(rough,damage.fracture.roughness,damage.weight);metal*=1-damage.weight*.95;ao*=1-damage.weight*.25;}
  return[clamp(t+(fine-0.5)*r.variation*0.15+(micro-0.5)*0.06),clamp(h-fine*r.weathering*0.05+(micro-0.5)*0.012),clamp(rough+(fine-0.5)*r.variation*0.12),metal,ao];
}
/** Alpha silhouette for individual leaves/needles, centred in their physical tile.
 * Not a leaf mesh or a transparency/lighting model. Other families are opaque.
 */
export function sampleMaterialOpacity(r:ResolvedMaterialGenerator,u:number,v:number):number{
  const p=r.pattern;if(p.family!=='leaf'&&p.family!=='needle')return 1;
  const x=Math.abs((wrap(u)-.5)*r.tileMeters[0]),y=(wrap(v)-.5)*r.tileMeters[1],t=(y/p.lengthMeters+.5);
  if(t<=0||t>=1)return 0;
  let width=p.widthMeters*.5*(p.family==='needle'?Math.pow(Math.sin(t*Math.PI),.25+p.taper*1.5):p.outline==='oval'?Math.sqrt(Math.max(0,1-(2*t-1)**2)):Math.sin(t*Math.PI));
  if(p.family==='leaf'){width*=1-p.edgeSerration*.15*(.5+.5*Math.sin(t*90));if(p.outline==='lobed')width*=.65+.35*Math.sin(t*5*Math.PI)**2;}
  if(p.family==='leaf'&&p.outline==='palmate'){
    const profile=[[0,.025],[.18,.08],[.28,.75],[.4,.42],[.62,1],[.68,.38],[.82,.48],[1,0]];let k=1;while(k<profile.length-1&&t>profile[k][0])k++;const a=profile[k-1],b=profile[k],f=(t-a[0])/(b[0]-a[0]);width=p.widthMeters*.5*(a[1]+(b[1]-a[1])*f)*(1-p.edgeSerration*.1*(.5+.5*Math.sin(t*110)));
  }
  if(x>width)return 0;
  if(p.damage>0&&noise(u,v,24,24,r.seed+887)>1-p.damage*.3)return 0;
  return 1;
}
export interface GeneratedMaterialPixels {recipe:ResolvedMaterialGenerator;color:TexturePixels;normal:TexturePixels;height:TexturePixels;roughness:TexturePixels;metalness:TexturePixels;ao:TexturePixels;diagnostics:{resolution:number;bytes:number;tileMeters:[number,number];warnings:string[]}}
/** Bake during authoring/loading, not frame updates. Supply a scheduler when rendering on a UI thread. */
export async function generateMaterial(input:MaterialGeneratorRecipe,options:{resolution?:number;signal?:AbortSignal;yieldControl?:()=>Promise<void>}={}):Promise<GeneratedMaterialPixels>{
  const recipe=materialGeneratorSchema.parse(input),size=options.resolution??recipe.output.resolution;
  if(!Number.isInteger(size)||size<16||size>2048)throw Error('Generator resolution must be an integer from 16 to 2048.');
  options.signal?.throwIfAborted();
  const image=():TexturePixels=>({width:size,height:size,data:new Uint8Array(size*size*4)});
  const color=image(),normal=image(),height=image(),roughness=image(),metalness=image(),ao=image(),heights=new Float32Array(size*size);
  const low=[1,3,5].map(i=>parseInt(recipe.secondaryColor.slice(i,i+2),16)),high=[1,3,5].map(i=>parseInt(recipe.color.slice(i,i+2),16));
  for(let y=0;y<size;y++){
    if(y%32===0){options.signal?.throwIfAborted();await(options.yieldControl?.()??Promise.resolve());}
    for(let x=0;x<size;x++){
      const i=y*size+x,k=i*4,[value,h,r,m,a]=sampleMaterialGenerator(recipe,(x+0.5)/size,(y+0.5)/size,Math.max(...recipe.tileMeters)/size);const damage=materialFractureAt(recipe,(x+.5)/size,(y+.5)/size,Math.max(...recipe.tileMeters)/size);heights[i]=h*recipe.reliefMeters-(damage?.weight??0)*(damage?.fracture.depthMeters??0);
      const crackColor=damage?[1,3,5].map(i=>parseInt(damage.fracture.color.slice(i,i+2),16)):low;
      const projected=clamp(crackColor.reduce((n,c,i)=>n+(c-low[i])*(high[i]-low[i]),0)/Math.max(1,high.reduce((n,c,i)=>n+(c-low[i])**2,0)));
      const t=recipe.output.style==='realistic'?value:Math.round(mix(value,projected,damage?.weight??0)*(recipe.output.paletteSteps-1))/(recipe.output.paletteSteps-1);
      for(let c=0;c<3;c++)color.data[k+c]=Math.round(recipe.output.style==='realistic'?mix(mix(low[c],high[c],t),crackColor[c],damage?.weight??0):mix(low[c],high[c],t));color.data[k+3]=Math.round(sampleMaterialOpacity(recipe,(x+.5)/size,(y+.5)/size)*255);
      for(const[map,v]of[[height,clamp(h-(damage?.weight??0)*(damage?.fracture.depthMeters??0)/Math.max(.01,recipe.reliefMeters))],[roughness,r],[metalness,m],[ao,a]]as const){map.data[k]=map.data[k+1]=map.data[k+2]=Math.round(v*255);map.data[k+3]=255;}
    }
  }
  for(let y=0;y<size;y++){
    if(y%32===0){options.signal?.throwIfAborted();await(options.yieldControl?.()??Promise.resolve());}
    for(let x=0;x<size;x++){
      const at=(dx:number,dy:number)=>heights[wrap(y+dy,size)*size+wrap(x+dx,size)],k=(y*size+x)*4;
      const dx=(at(1,0)-at(-1,0))*size/(2*recipe.tileMeters[0]),dy=(at(0,1)-at(0,-1))*size/(2*recipe.tileMeters[1]),len=Math.hypot(dx,dy,1);
      normal.data[k]=Math.round((1-dx/len)*127.5);normal.data[k+1]=Math.round((1-dy/len)*127.5);normal.data[k+2]=Math.round((1+1/len)*127.5);normal.data[k+3]=255;
    }
  }
  const warnings:string[]=[];
  if(recipe.fracture)warnings.push('Fractures change surface color, physical relief and roughness; they do not create holes or detached shards. Use a pane-sized tile for a single impact.');
  if(recipe.optics)warnings.push('Optical response requires a physical material and scene environment. Mirrors reflect the environment; live planar reflections require a separate scene reflection system. PNG maps alone do not preserve optics.');
  if(recipe.pattern.family==='leaf'||recipe.pattern.family==='needle'){
    if(recipe.pattern.widthMeters>recipe.tileMeters[0]||recipe.pattern.lengthMeters>recipe.tileMeters[1])warnings.push('Plant silhouette exceeds its tile and will be clipped. Increase tileMeters to fit.');
    if(recipe.pattern.widthMeters/recipe.tileMeters[0]*size<2)warnings.push('Plant width is below two texels. Increase resolution or reduce the physical tile size.');
    warnings.push('Leaf/needle opacity is a cutout. No geometric thickness, wind or subsurface transmission is generated.');
  }
  if(recipe.pattern.family==='masonry')warnings.push('Block counts are rounded to whole repeats to keep the tile seamless.');
  if(recipe.reliefMeters>0)warnings.push('Height supplies shading relief, not collision or silhouette geometry.');
  return{recipe,color,normal,height,roughness,metalness,ao,diagnostics:{resolution:size,bytes:size*size*24,tileMeters:recipe.tileMeters,warnings}};
}
export const MATERIAL_GENERATOR_PRESETS:ReadonlyArray<{id:string;name:string;recipe:MaterialGeneratorRecipe}>=MATERIAL_FAMILIES.map(family=>({id:'generator-'+family,name:family+' material',recipe:materialGeneratorSchema.parse({name:family+' material',pattern:{family},...({grass:{color:'#658344',secondaryColor:'#384124'},metal:{color:'#bcc2cc',secondaryColor:'#51565e'},plaster:{color:'#e8deca',secondaryColor:'#a89983'},rock:{color:'#a4a6a5',secondaryColor:'#515859'},wood:{color:'#b78045',secondaryColor:'#503322'},dirt:{color:'#94724e',secondaryColor:'#453426'},gravel:{color:'#a8a49b',secondaryColor:'#575a55'},masonry:{color:'#c1aa86',secondaryColor:'#625a4c'},bark:{color:'#866142',secondaryColor:'#30291e',tileMeters:[.4,.8]},leaf:{color:'#689b36',secondaryColor:'#203d15',tileMeters:[.12,.22],reliefMeters:.001},needle:{color:'#3f6936',secondaryColor:'#152d1b',tileMeters:[.016,.15],reliefMeters:.0005},'exposed-wood':{color:'#c99a65',secondaryColor:'#775131',tileMeters:[.2,.2]}}[family])})}));
