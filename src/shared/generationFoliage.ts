import {parseFoliageRecipe,type FoliageRecipe,type ResolvedFoliage,type FoliageMaterial} from './foliageGenerator.ts';
import {compileGenerationBindings,type GenerationBinding,type GenerationTarget} from './generationBindings.ts';
import {generationIdentitySeed,generationDataRevision,type GenerationMapRecipe,type GenerationSampleContext} from './generationMaps.ts';
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;}
export const FOLIAGE_GENERATION_TARGETS:readonly GenerationTarget[]=freeze([
  ...([['heightMeters','metres',.2,30],['crownRadiusMeters','metres',.1,10],['branchAngle','radians',.15,1.5],['branchPitchVariation','normalized',0,1],['leafSizeMeters','metres',.02,1],['density','scalar',0,256]] as const).map(([key,unit,min,max])=>({id:'foliage.'+key,unit,range:[min,max] as const,effect:'geometry' as const,stage:'prepare' as const,spaces:['world','object'] as const,scopes:['object'] as const})),
  ...['roughness','variation'].map(key=>({id:'bark.'+key,unit:'normalized' as const,range:[0,1] as const,effect:'material' as const,stage:'prepare' as const,spaces:['world','object'] as const,scopes:['object'] as const})),
]);
export interface FoliageGenerationInput {recipe:FoliageRecipe;graph:GenerationMapRecipe;bindings:readonly GenerationBinding[];instances:readonly{id:string;world?:readonly[number,number,number]}[]}
function dimensions(material:FoliageMaterial){if('ref'in material)return{ref:material.ref};const pattern=material.pattern;return{tileMeters:material.tileMeters,lengthMeters:pattern&&(pattern.family==='leaf'||pattern.family==='needle')?pattern.lengthMeters:material.tileMeters?.[1]};}
/** Joint variant budget, not a Cartesian product of independent variant banks.
 * Source recipes remain editable; no model/texture work happens in this planner. */
export function compileFoliageGeneration(input:FoliageGenerationInput){
  // Validate bounded serializable data before reading any accessor-backed values.
  generationDataRevision(input);
  if(Object.keys(input).some(k=>!['recipe','graph','bindings','instances'].includes(k)))throw Error('Foliage generation requires supported plain input fields.');
  if(!Array.isArray(input.instances)||!input.instances.length||input.instances.length>16)throw Error('Foliage generation requires 1–16 prepared joint variants.');
  const ids=new Set<string>(),base=parseFoliageRecipe(input.recipe),bindings=compileGenerationBindings(input.graph,input.bindings,FOLIAGE_GENERATION_TARGETS);
  if('ref'in base.materials.bark&&bindings.bindings.some(b=>b.target.startsWith('bark.')))throw Error('Mapped bark parameters require an inline material recipe, not a registry reference.');
  const instances=input.instances.map(instance=>{if(!instance||typeof instance!=='object'||Array.isArray(instance)||Object.keys(instance).some(k=>!['id','world'].includes(k)))throw Error('Foliage instances require plain id/world fields.');
    if(typeof instance.id!=='string'||!instance.id.length||instance.id.length>200||ids.has(instance.id))throw Error('Foliage instances require unique stable IDs (max 200 characters).');ids.add(instance.id);
    const world=instance.world;if(world!==undefined&&(!Array.isArray(world)||world.length!==3||!world.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e9)))throw Error('Foliage instance '+instance.id+' requires three finite world coordinates.');return freeze({id:instance.id,...(world?{world:[...world] as [number,number,number]}:{})});
  });
  const baseValues:Record<string,number>={};for(const t of FOLIAGE_GENERATION_TARGETS){if(t.id.startsWith('foliage.'))baseValues[t.id]=base[t.id.slice(8) as keyof ResolvedFoliage] as number;else if(!('ref'in base.materials.bark))baseValues[t.id]=base.materials.bark[t.id.slice(5) as 'roughness'|'variation'];}freeze(baseValues);
  const contexts=new Map<string,GenerationSampleContext>();
  const variants=instances.map(instance=>{
    const context=freeze({...(instance.world?{world:instance.world}:{}),object:[0,0,0] as const,objectId:instance.id}),r=structuredClone(base);contexts.set(instance.id,context);
    const applied=bindings.sample(context,baseValues);
    for(const [target,value]of Object.entries(applied)){if(target.startsWith('foliage.'))Object.assign(r,{[target.slice(8)]:value});else{if('ref'in r.materials.bark)throw Error('Mapped bark parameters require an inline material recipe, not a registry reference.');Object.assign(r.materials.bark,{[target.slice(5)]:value});}}
    r.seed=generationIdentitySeed(base.seed,instance.id,'foliage-geometry');
    const recipe=parseFoliageRecipe(r),geometry={...recipe,name:undefined,materials:undefined,leafDimensions:dimensions(recipe.materials.leaf),...(recipe.flowers.density?{flowerDimensions:dimensions(recipe.materials.flower)}:{})},geometryKey='foliage-geometry:'+generationDataRevision(geometry),materialKey='foliage-material:'+generationDataRevision(recipe.materials);
    return freeze({id:instance.id,assetId:'generated-'+generationDataRevision(instance.id).split(':')[1],recipe,values:applied,geometryKey,materialKey});
  });
  const revision='foliage-plan:'+generationDataRevision({bindingRevision:bindings.revision,recipe:base,instances:[...instances].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)}),byId=new Map(variants.map(v=>[v.id,v]));
  return freeze({variants,revision,diagnostics:{variants:variants.length,maxVariants:16,preparationOnly:true},inspect(instanceId:string){const variant=byId.get(instanceId),context=contexts.get(instanceId);if(!variant||!context)throw Error('Unknown foliage instance '+instanceId);return{instanceId,variant,maps:bindings.graph,bindings:bindings.inspect(context,baseValues)};}});
}
