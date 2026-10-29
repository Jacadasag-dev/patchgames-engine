import {z} from 'zod';
import {materialGeneratorSchema,sampleMaterialGenerator,sampleMaterialOpacity,type ResolvedMaterialGenerator,type GeneratedMaterialPixels} from './materialGenerator.ts';
import {materialRecipe} from './materialRegistry.ts';
import {materialPatternSchema,materialBoundarySchema} from './materialPatternSchema.ts';
import {materialPatternBoundaryWeight,sampleMaterialPattern,createMaterialPatternSampler,type MaterialPatternSampler} from './materialPatterns.ts';

export const BOX_SURFACES=['right','left','top','bottom','front','back'] as const;
export type BoxSurface=typeof BOX_SURFACES[number];
type Vec=[number,number,number];
const unit=z.number().finite().min(0).max(1),metres=z.number().finite().min(0.001).max(20);
const face=z.enum(BOX_SURFACES),color=z.string().regex(/^#[0-9a-f]{6}$/i);
const selection=z.object({space:z.enum(['geometry','model']).default('model'),faces:z.array(face).min(1).max(6)}).strict();
/** One composable mask: face selection × edge band × boundary × generated pattern. */
export const surfaceCoverageSchema=z.object({
  selection:selection.optional(),boundary:materialBoundarySchema.optional(),
  band:z.object({from:face.default('top'),space:z.enum(['geometry','model']).default('model'),depthMeters:z.number().finite().min(0).max(20),variation:unit.default(.5),featherMeters:z.number().finite().min(0).max(.2).default(.01)}).strict().optional(),
  pattern:materialPatternSchema.prefault({type:'patches',mode:'solid'}),
}).strict();
export const objectSurfaceSchema=z.object({
  kind:z.literal('object-surface'),version:z.literal(2),name:z.string().min(1).max(120),
  sizeMeters:z.tuple([metres,metres,metres]),
  orientation:z.object({front:z.enum(['+z','-z','+x','-x']).default('+z'),up:z.literal('+y').default('+y')}).strict().default({front:'+z',up:'+y'}),
  seed:z.number().int().min(-2147483648).max(2147483647).default(1),base:materialGeneratorSchema,
  layers:z.array(z.object({id:z.string().min(1).max(64),material:materialGeneratorSchema,opacity:unit.default(1),heightOffsetMeters:z.number().finite().min(-.1).max(.1).default(0),coverage:surfaceCoverageSchema.prefault({})}).strict()).max(4).default([]),
  effects:z.array(z.object({id:z.string().min(1).max(64),kind:z.literal('slash'),enabled:z.boolean().default(true),
    surface:face,space:z.enum(['geometry','model']).default('model'),
    pathMeters:z.array(z.tuple([z.number().finite().min(0).max(20),z.number().finite().min(0).max(20)])).min(2).max(12),
    widthMeters:z.number().finite().min(0.002).max(0.5),depthMeters:z.number().finite().min(0).max(0.1),
    branching:unit.default(0.3),chipping:unit.default(0.4),exposedColor:color.default('#625449'),
  }).strict()).max(4).default([]),
  output:z.object({resolution:z.union([z.literal(32),z.literal(64),z.literal(128),z.literal(256),z.literal(512)]).default(128),style:z.enum(['realistic','stylized','pixel']).default('realistic'),paletteSteps:z.number().int().min(2).max(32).default(8)}).strict().default({resolution:128,style:'realistic',paletteSteps:8}),
}).strict().superRefine((r,ctx)=>{
  if(r.layers.some(l=>l.material.optics)||r.base.optics&&(r.layers.length||r.effects.length))ctx.addIssue({code:'custom',message:'Optical surfaces require a single base material without layers or effects. Use separate meshes for optical and opaque surfaces.'});
  const ids=new Set<string>();for(const item of [...r.layers,...r.effects]){if(ids.has(item.id))ctx.addIssue({code:'custom',message:'Surface layer/effect IDs must be unique.'});ids.add(item.id);}
  for(const [i,effect]of r.effects.entries()){
    const target=resolveSurfaceName(r.orientation.front,effect.surface,effect.space),span=boxSurfaceFrame(r.sizeMeters,target).span;
    if(effect.pathMeters.some(([u,v])=>u>span[0]||v>span[1]))ctx.addIssue({code:'custom',path:['effects',i,'pathMeters'],message:'Slash path lies outside its selected surface. Coordinates are metres from its lower-left corner.'});
    if(effect.pathMeters.every(p=>Math.hypot(p[0]-effect.pathMeters[0][0],p[1]-effect.pathMeters[0][1])<0.00001))ctx.addIssue({code:'custom',path:['effects',i,'pathMeters'],message:'Slash path must have nonzero length.'});
  }
  for(const [i,layer]of r.layers.entries()){const band=layer.coverage.band;if(!band)continue;
    const name=resolveSurfaceName(r.orientation.front,band.from,band.space),extent=normals[name].reduce((n,v,j)=>n+Math.abs(v)*r.sizeMeters[j],0);
    if(band.depthMeters>extent)ctx.addIssue({code:'custom',path:['layers',i,'coverage','band','depthMeters'],message:'Coverage band depth must fit the object along its selected direction.'});
  }
});
export type ObjectSurfaceRecipe=z.input<typeof objectSurfaceSchema>;
export type ResolvedObjectSurface=z.output<typeof objectSurfaceSchema>;
const materialSlot=z.union([materialGeneratorSchema,z.object({ref:z.string().min(1).max(120).regex(/^[a-z][a-z0-9._-]*$/i)}).strict()]);
/** Named slots reference the shared registry; inline recipes remain useful for portable lab examples. */
export const objectSurfaceDocumentSchema=z.object({...objectSurfaceSchema.shape,base:materialSlot,layers:z.array(objectSurfaceSchema.shape.layers.unwrap().element.extend({material:materialSlot})).max(4).default([])}).strict().superRefine((doc,ctx)=>{
  const placeholder=materialGeneratorSchema.parse({pattern:{family:'plaster'}}),result=objectSurfaceSchema.safeParse({...doc,base:'ref'in doc.base?placeholder:doc.base,layers:doc.layers.map(layer=>({...layer,material:'ref'in layer.material?placeholder:layer.material}))});
  if(!result.success)for(const issue of result.error.issues)ctx.addIssue({code:'custom',path:issue.path,message:issue.message});
});
export type ObjectSurfaceDocument=z.input<typeof objectSurfaceDocumentSchema>;
export function objectSurfaceMaterialIds(input:ObjectSurfaceDocument):string[]{const doc=objectSurfaceDocumentSchema.parse(input);return [...new Set([doc.base,...doc.layers.map(l=>l.material)].flatMap(slot=>'ref'in slot?[slot.ref]:[]))];}
export function resolveObjectSurfaceDocument(input:ObjectSurfaceDocument):ResolvedObjectSurface{
  const doc=objectSurfaceDocumentSchema.parse(input);
  const resolve=(slot:z.output<typeof materialSlot>)=>{if(!('ref'in slot))return slot;const material=materialRecipe(slot.ref);if(!material)throw Error('Unresolved surface material: '+slot.ref);return material;};
  return objectSurfaceSchema.parse({...doc,base:resolve(doc.base),layers:doc.layers.map(layer=>({...layer,material:resolve(layer.material)}))});
}
const clamp=(n:number)=>Math.max(0,Math.min(1,n)),mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const normals:Record<BoxSurface,Vec>={right:[1,0,0],left:[-1,0,0],top:[0,1,0],bottom:[0,-1,0],front:[0,0,1],back:[0,0,-1]};
/** Geometric face IDs always name fixed box axes. Semantic model faces use declared front/+Y up. */
export function resolveSurfaceName(front:ResolvedObjectSurface['orientation']['front'],name:BoxSurface,space:'geometry'|'model'):BoxSurface{
  if(space==='geometry'||name==='top'||name==='bottom')return name;
  const order:BoxSurface[]=['front','right','back','left'],index={'+z':0,'+x':1,'-z':2,'-x':3}[front];
  return order[(index+order.indexOf(name))%4];
}
/** Matches Three BoxGeometry's six material groups and UV handedness. Origin is the model centre. */
export function boxSurfaceFrame(size:Vec,name:BoxSurface){
  const u:Vec=name==='right'?[0,0,-1]:name==='left'?[0,0,1]:name==='back'?[-1,0,0]:[1,0,0];
  const v:Vec=name==='top'?[0,0,-1]:name==='bottom'?[0,0,1]:[0,1,0],normal=normals[name];
  const extent=(axis:Vec)=>axis.reduce((n,a,i)=>n+Math.abs(a)*size[i],0);
  return{u,v,normal,span:[extent(u),extent(v)] as [number,number],point:(x:number,y:number)=>normal.map((n,i)=>n*size[i]/2+u[i]*(x-0.5)*extent(u)+v[i]*(y-0.5)*extent(v)) as Vec};
}
function hash(x:number,y:number,seed:number){let n=Math.imul(x^seed,374761393)^Math.imul(y+seed,668265263);n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967295;}
function field(x:number,z:number,seed:number){const ix=Math.floor(x),iz=Math.floor(z),a=x-ix,b=z-iz,s=a*a*(3-2*a),t=b*b*(3-2*b);return mix(mix(hash(ix,iz,seed),hash(ix+1,iz,seed),s),mix(hash(ix,iz+1,seed),hash(ix+1,iz+1,seed),s),t);}
/** One continuous model-space field is shared by all side faces, including corners. */
export function surfaceCoverage(r:ResolvedObjectSurface,layer:ResolvedObjectSurface['layers'][number],faceName:BoxSurface,point:Vec,sampler?:MaterialPatternSampler):number{
  const c=layer.coverage;
  if(c.selection&&!c.selection.faces.some(f=>resolveSurfaceName(r.orientation.front,f,c.selection!.space)===faceName))return 0;
  let bandWeight=1;
  if(c.band){
    const band=c.band,name=resolveSurfaceName(r.orientation.front,band.from,band.space),edge=boxSurfaceFrame(r.sizeMeters,name),normal=edge.normal;
    const facing=normal.reduce((n,v,i)=>n+v*normals[faceName][i],0);
    if(facing<0)return 0;
    if(facing===0){
      const u=point.reduce((n,p,i)=>n+p*edge.u[i],0),v=point.reduce((n,p,i)=>n+p*edge.v[i],0);
      const noise=field(u*7,v*7,r.seed)*.7+field(u*23,v*23,r.seed+11)*.3;
      const extent=normal.reduce((n,v,i)=>n+Math.abs(v)*r.sizeMeters[i],0);
      const delta=point.reduce((n,p,i)=>n+p*normal[i],0)-(extent/2-band.depthMeters*(1-band.variation+band.variation*noise));
      const t=band.featherMeters===0?Number(delta>=0):clamp((delta+band.featherMeters/2)/band.featherMeters);bandWeight=t*t*(3-2*t);
    }
  }
  if(!bandWeight)return 0;
  const frame=boxSurfaceFrame(r.sizeMeters,faceName),frameData={
    face:[point.reduce((sum,p,i)=>sum+p*frame.u[i],0)*2/frame.span[0],point.reduce((sum,p,i)=>sum+p*frame.v[i],0)*2/frame.span[1],0] as Vec,
    model:point.map((p,i)=>p*2/r.sizeMeters[i]) as Vec,faceMeters:frame.span,modelMeters:r.sizeMeters,
  };
  return bandWeight*materialPatternBoundaryWeight(c.boundary,frameData)*(sampler?sampler(point,frameData):sampleMaterialPattern(c.pattern,point,frameData));
}

function distance(p:[number,number],a:[number,number],b:[number,number]){const x=b[0]-a[0],y=b[1]-a[1],t=clamp(((p[0]-a[0])*x+(p[1]-a[1])*y)/(x*x+y*y||1));return Math.hypot(p[0]-a[0]-t*x,p[1]-a[1]-t*y);}
export function slashCoverage(r:ResolvedObjectSurface,e:ResolvedObjectSurface['effects'][number],name:BoxSurface,u:number,v:number):number{
  if(!e.enabled||resolveSurfaceName(r.orientation.front,e.surface,e.space)!==name)return 0;
  const span=boxSurfaceFrame(r.sizeMeters,name).span,p:[number,number]=[u*span[0],v*span[1]];let d=Infinity;
  for(let i=1;i<e.pathMeters.length;i++){
    const a=e.pathMeters[i-1],b=e.pathMeters[i];d=Math.min(d,distance(p,a,b));
    if(e.branching>0){const side=hash(i,1,r.seed)>0.5?1:-1,dx=b[0]-a[0],dy=b[1]-a[1],start:[number,number]=[mix(a[0],b[0],0.55),mix(a[1],b[1],0.55)],end:[number,number]=[start[0]+(dx*0.12-dy*side*0.3)*e.branching,start[1]+(dy*0.12+dx*side*0.3)*e.branching];d=Math.min(d,distance(p,start,end));}
  }
  const rough=(field(p[0]*70,p[1]*70,r.seed+7)-0.5)*e.chipping*e.widthMeters;
  return clamp((e.widthMeters*0.5+rough-d)/Math.max(0.001,e.widthMeters*0.22));
}
const rgb=(hex:string)=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
function materialSample(m:ResolvedMaterialGenerator,u:number,v:number,output:ResolvedObjectSurface['output']){
  const [value,h,roughness,metalness,ao]=sampleMaterialGenerator(m,u,v),t=output.style==='realistic'?value:Math.round(value*(output.paletteSteps-1))/(output.paletteSteps-1),low=rgb(m.secondaryColor),high=rgb(m.color);
  return{color:low.map((n,i)=>mix(n,high[i],t)),height:h*m.reliefMeters,roughness,metalness,ao,opacity:sampleMaterialOpacity(m,u,v)};
}
/** Base UVs repeat in metres. Slash coordinates remain bounded to one face and never use those UVs. */
export function sampleObjectSurface(r:ResolvedObjectSurface,name:BoxSurface,u:number,v:number,samplers?:ReadonlyMap<ResolvedObjectSurface['layers'][number],MaterialPatternSampler>){
  const frame=boxSurfaceFrame(r.sizeMeters,name),point=frame.point(u,v),result=materialSample(r.base,u*frame.span[0]/r.base.tileMeters[0],v*frame.span[1]/r.base.tileMeters[1],r.output);
  for(const layer of r.layers){let weight=surfaceCoverage(r,layer,name,point,samplers?.get(layer))*layer.opacity;if(!weight)continue;const m=layer.material;
    // Coverage shares one model-space field, but texture projection must span the
    // actual face. Top-down projection on vertical faces collapses one axis.
    const sample=materialSample(m,u*frame.span[0]/m.tileMeters[0],v*frame.span[1]/m.tileMeters[1],r.output);
    sample.height+=layer.heightOffsetMeters;
    weight*=sample.opacity;const previousOpacity=result.opacity;result.opacity+=weight*(1-result.opacity);
    result.color=result.color.map((c,i)=>(c*previousOpacity*(1-weight)+sample.color[i]*weight)/Math.max(1e-9,result.opacity));for(const key of ['height','roughness','metalness','ao'] as const)result[key]=mix(result[key],sample[key],weight);
  }
  for(const effect of r.effects){const weight=slashCoverage(r,effect,name,u,v);if(!weight)continue;const inner=rgb(effect.exposedColor);result.color=result.color.map((c,i)=>mix(c,inner[i]*0.65,weight));result.height-=effect.depthMeters*weight;result.roughness=mix(result.roughness,0.95,weight);result.metalness*=1-weight;result.ao=mix(result.ao,0.3,weight);}
  return result;
}
export interface ObjectSurfaceBake {recipe:ResolvedObjectSurface;faces:Record<BoxSurface,GeneratedMaterialPixels>;diagnostics:{bytes:number;warnings:string[]}}
/** Authoring bake, intended for a worker. Resolution caps the longest model axis;
 * rectangular faces keep approximately equal texels/metre (one-pixel minimum).
 */
export async function generateObjectSurface(input:ObjectSurfaceDocument,options:{resolution?:number;signal?:AbortSignal;yieldControl?:()=>Promise<void>}={}):Promise<ObjectSurfaceBake>{
  const recipe=resolveObjectSurfaceDocument(input),size=options.resolution??recipe.output.resolution;
  if(!Number.isInteger(size)||size<16||size>512)throw Error('Object surfaces support 16–512 pixels per face.');
  const faces={} as ObjectSurfaceBake['faces'];let bytes=0;const pixelsPerMeter=size/Math.max(...recipe.sizeMeters);
  const samplers=new Map(recipe.layers.map(layer=>[layer,createMaterialPatternSampler(layer.coverage.pattern)] as const));
  for(const name of BOX_SURFACES){
    const span=boxSurfaceFrame(recipe.sizeMeters,name).span,width=Math.max(1,Math.round(span[0]*pixelsPerMeter)),rows=Math.max(1,Math.round(span[1]*pixelsPerMeter));
    const image=()=>({width,height:rows,data:new Uint8Array(width*rows*4)}),color=image(),normal=image(),height=image(),roughness=image(),metalness=image(),ao=image(),heights=new Float32Array(width*rows);
    for(let y=0;y<rows;y++){
      if(y%16===0){options.signal?.throwIfAborted();await(options.yieldControl?.()??Promise.resolve());}
      for(let x=0;x<width;x++){const index=y*width+x,k=index*4,sample=sampleObjectSurface(recipe,name,(x+0.5)/width,(y+0.5)/rows,samplers);heights[index]=sample.height;
        for(let c=0;c<3;c++)color.data[k+c]=Math.round(sample.color[c]);color.data[k+3]=Math.round(sample.opacity*255);
        for(const[map,value]of[[height,clamp(0.5+sample.height/0.4)],[roughness,sample.roughness],[metalness,sample.metalness],[ao,sample.ao]]as const){map.data[k]=map.data[k+1]=map.data[k+2]=Math.round(value*255);map.data[k+3]=255;}
      }
    }
    for(let y=0;y<rows;y++)for(let x=0;x<width;x++){const at=(dx:number,dy:number)=>heights[Math.max(0,Math.min(rows-1,y+dy))*width+Math.max(0,Math.min(width-1,x+dx))],dx=(at(1,0)-at(-1,0))*width/(2*span[0]),dy=(at(0,1)-at(0,-1))*rows/(2*span[1]),len=Math.hypot(dx,dy,1),k=(y*width+x)*4;normal.data.set([Math.round((1-dx/len)*127.5),Math.round((1-dy/len)*127.5),Math.round((1+1/len)*127.5),255],k);}
    faces[name]={recipe:{...recipe.base,output:{...recipe.output,resolution:size as ResolvedMaterialGenerator['output']['resolution']}},color,normal,height,roughness,metalness,ao,diagnostics:{resolution:size,bytes:width*rows*24,tileMeters:span,warnings:[]}};
    bytes+=width*rows*24;
  }
  const warnings=['Box surfaces use model-local metres and +Y up. Unsupported scale/mirror/world-space fields are rejected.'];
  if(recipe.effects.some(e=>e.enabled&&e.depthMeters>0))warnings.push('Slash depth is shading relief, not a hole or collision change.');
  return{recipe,faces,diagnostics:{bytes,warnings}};
}
export const OBJECT_SURFACE_EXAMPLES:Record<'grass'|'slash'|'iron'|'diamond'|'gold'|'moss-bark'|'wood-core',ObjectSurfaceRecipe>={
  'wood-core':{kind:'object-surface',version:2,name:'Wood core cross-section',sizeMeters:[.5,.7,.5],base:{pattern:{family:'bark'},tileMeters:[.4,.8],color:'#896347',secondaryColor:'#33281f'},layers:[{id:'core',material:{pattern:{family:'exposed-wood'},tileMeters:[.5,.5],color:'#c99a65',secondaryColor:'#775131',reliefMeters:.003},coverage:{selection:{space:'model',faces:['top','bottom']},boundary:{strength:1,space:'model',axes:'xz',radius:.75,softness:.15}}}],output:{resolution:128,style:'realistic',paletteSteps:8}},
  iron:{kind:'object-surface',version:2,name:'Iron ore in stone',sizeMeters:[1,1,1],base:{pattern:{family:'rock'},tileMeters:[1,1],color:'#92958e',secondaryColor:'#484e4e'},layers:[{id:'ore',material:{pattern:{family:'metal',oxidation:.7,metalness:.65},tileMeters:[.3,.3],color:'#b78a65',secondaryColor:'#674332',reliefMeters:.01},coverage:{pattern:{type:'clusters',sizeMeters:.17,coverage:.36,irregularity:.9,shapeVariation:.65,sizeVariation:.4,concentration:{strength:1,space:'face',radius:.95,softness:.3},seed:19,edgeSoftnessMeters:.005}},heightOffsetMeters:-.006}],output:{resolution:128,style:'pixel',paletteSteps:8}},
  diamond:{kind:'object-surface',version:2,name:'Diamond mineral in stone',sizeMeters:[1,1,1],base:{pattern:{family:'rock'},tileMeters:[1,1],color:'#92958e',secondaryColor:'#484e4e'},layers:[{id:'mineral',material:{pattern:{family:'rock',grainMeters:.012,fractures:.05},tileMeters:[.25,.25],color:'#67e9e5',secondaryColor:'#156c83',roughness:.2,reliefMeters:.014},coverage:{pattern:{type:'clusters',sizeMeters:.18,coverage:.34,irregularity:1,shapeVariation:.7,sizeVariation:.35,concentration:{strength:1,space:'face',radius:.9,softness:.25},seed:42,edgeSoftnessMeters:.002}},heightOffsetMeters:.003}],output:{resolution:128,style:'pixel',paletteSteps:8}},
  gold:{kind:'object-surface',version:2,name:'Gold veins in rock',sizeMeters:[1,1,1],base:{pattern:{family:'rock'},tileMeters:[1,1],color:'#878c91',secondaryColor:'#343a40'},layers:[{id:'veins',material:{pattern:{family:'metal',metalness:1,brushing:0},tileMeters:[.3,.3],color:'#e7bc49',secondaryColor:'#836017',roughness:.25},coverage:{pattern:{type:'veins',sizeMeters:.2,coverage:.17,irregularity:.7,shapeVariation:.4,sizeVariation:.3,concentration:{strength:.8,space:'face',radius:.95,softness:.3},seed:8,edgeSoftnessMeters:.002}},heightOffsetMeters:-.005}],output:{resolution:128,style:'realistic',paletteSteps:8}},
  'moss-bark':{kind:'object-surface',version:2,name:'Moss patches on bark',sizeMeters:[.5,1,.5],base:{pattern:{family:'bark'},tileMeters:[.4,.8],color:'#896347',secondaryColor:'#33281f'},layers:[{id:'moss',material:{pattern:{family:'grass',bladeMeters:.008,density:.8},tileMeters:[.2,.2],color:'#6f8d3b',secondaryColor:'#263e21',reliefMeters:.006},coverage:{pattern:{type:'patches',sizeMeters:.15,coverage:.5,seed:7,edgeSoftnessMeters:.015}},heightOffsetMeters:.003}],output:{resolution:128,style:'realistic',paletteSteps:8}},
  grass:{kind:'object-surface',version:2,name:'Grass-topped dirt block',sizeMeters:[1,1,1],seed:42,base:{pattern:{family:'dirt',clumping:0.8},tileMeters:[1,1],color:'#987044',secondaryColor:'#493324'},layers:[{id:'grass',material:{pattern:{family:'grass',density:1,barePatches:0.05},tileMeters:[1,1],color:'#77a649',secondaryColor:'#36582b'},coverage:{band:{from:'top',depthMeters:0.24,variation:0.65,featherMeters:0.015}}}],output:{resolution:128,style:'pixel',paletteSteps:8}},
  slash:{kind:'object-surface',version:2,name:'Brick wall with a slash',sizeMeters:[4,2.5,0.22],seed:42,base:{pattern:{family:'masonry',blockMeters:[0.3,0.12],mortarMeters:0.012,chipping:0.3},tileMeters:[1.2,0.6],color:'#b86c4b',secondaryColor:'#54433a'},effects:[{id:'slash',kind:'slash',surface:'front',space:'model',pathMeters:[[0.65,1.9],[1.8,1.25],[3.25,0.65]],widthMeters:0.065,depthMeters:0.025,branching:0.6,chipping:0.5,exposedColor:'#9e9078'}],output:{resolution:256,style:'realistic',paletteSteps:8}},
};
