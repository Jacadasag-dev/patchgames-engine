import {compileGenerationMaps,generationDataRevision,type GenerationMapRecipe} from './generationMaps.ts';
import type {CompiledPlanet,PlanetVector} from './planet.ts';

export const PLANET_BIOME_IDS=['ocean','beach','grassland','temperate-forest','taiga','tropical-forest','desert','tundra','alpine'] as const;
export type PlanetBiomeId=typeof PLANET_BIOME_IDS[number];
export interface PlanetBiomeRecipe {
  kind:'planet-biomes';version:1;seed:number;fields:GenerationMapRecipe;
  temperatureMap:string;moistureMap:string;forestDensity:number;settlementDensity:number;
}
export interface PlanetBiomeSample {
  id:PlanetBiomeId;name:string;heightMeters:number;/** Degrees from radial up. */slope:number;
  temperature:number;moisture:number;forestFamily:'temperate'|'conifer'|'tropical'|'none';
  treeDensity:number;buildingSuitability:number;color:PlanetVector;
}
export interface CompiledPlanetBiomes {
  readonly recipe:PlanetBiomeRecipe;readonly revision:string;
  sample(direction:PlanetVector):PlanetBiomeSample;
}
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const colors:Record<PlanetBiomeId,string>={ocean:'#77786a',beach:'#c2b78c',grassland:'#7a9156','temperate-forest':'#627e45',taiga:'#667f68','tropical-forest':'#588849',desert:'#c8a46d',tundra:'#a1a18d',alpine:'#c2c5c0'};
const names:Record<PlanetBiomeId,string>={ocean:'Ocean',beach:'Coast',grassland:'Grassland','temperate-forest':'Temperate forest',taiga:'Conifer forest','tropical-forest':'Tropical forest',desert:'Desert',tundra:'Tundra',alpine:'Alpine'};
const linear=(hex:string):PlanetVector=>[1,3,5].map(i=>{const v=parseInt(hex.slice(i,i+2),16)/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}) as [number,number,number];
const palette=Object.fromEntries(PLANET_BIOME_IDS.map(id=>[id,linear(colors[id])])) as Record<PlanetBiomeId,PlanetVector>;
export function createPlanetBiomeRecipe(seed=42,radiusMeters=6_371_000):PlanetBiomeRecipe {
  if(!Number.isFinite(radiusMeters)||radiusMeters<1000||radiusMeters>1e8)throw Error('Planet biome radius must be within 1000..100000000 metres.');
  return {kind:'planet-biomes',version:1,seed,temperatureMap:'temperature',moistureMap:'moisture',forestDensity:1,settlementDensity:1,fields:{kind:'generation-maps',version:1,seed,maps:{
    temperature:{type:'noise',space:'world',scaleMeters:Math.min(1e6,radiusMeters*.12),octaves:2},
    moisture:{type:'noise',space:'world',scaleMeters:Math.min(1e6,radiusMeters*.045),octaves:3},
  }}};
}
/** One static climate field serves terrain tint, generated forest families and
 * settlement eligibility. Placement and terrain workers compile the same data. */
export function compilePlanetBiomes(planet:CompiledPlanet,input:PlanetBiomeRecipe):CompiledPlanetBiomes {
  generationDataRevision(input); // Reject accessors, nonfinite or executable recipe data before copying.
  const keys=['kind','version','seed','fields','temperatureMap','moistureMap','forestDensity','settlementDensity'];
  if(input.kind!=='planet-biomes'||input.version!==1||Object.keys(input).some(k=>!keys.includes(k))||!Number.isInteger(input.seed)||input.seed< -2147483648||input.seed>2147483647)throw Error('Use a supported version 1 planet-biomes recipe and signed integer seed.');
  for(const n of [input.forestDensity,input.settlementDensity])if(!Number.isFinite(n)||n<0||n>2)throw Error('Planet biome densities must be within 0..2.');
  const fields=compileGenerationMaps(input.fields);
  for(const id of [input.temperatureMap,input.moistureMap]){const out=fields.output(id);if(out.dynamic||out.scopes.length||out.spaces.some(s=>s!=='world')||out.unit!=='normalized'||out.range[0]<0||out.range[1]>1)throw Error('Planet climate maps must be static normalized world fields without object identity.');}
  const recipe=Object.freeze({...input,fields:fields.recipe}),revision=generationDataRevision({planet:planet.revision,recipe});
  return Object.freeze({recipe,revision,sample(direction:PlanetVector):PlanetBiomeSample{
    const surface=planet.sample(direction),length=Math.hypot(...direction),up=direction.map(v=>v/length),world=up.map(v=>v*planet.radius) as [number,number,number];
    const scale=planet.radius/6_371_000,above=Math.max(0,surface.heightMeters-planet.recipe.seaLevelMeters)/scale;
    const slope=Math.acos(Math.max(-1,Math.min(1,up.reduce((n,v,i)=>n+v*surface.normal[i],0))))*180/Math.PI;
    const temperature=clamp(1-Math.abs(up[1])*1.16+(fields.sample(recipe.temperatureMap,{world})-.5)*.65-above/6500);
    const moisture=clamp((fields.sample(recipe.moistureMap,{world})-.5)*1.8+.5);
    let id:PlanetBiomeId=surface.heightMeters<=planet.recipe.seaLevelMeters?'ocean':above<12?'beach':above>3900?'alpine':temperature<.2?'tundra':temperature<.46&&moisture>.3?'taiga':temperature>.68&&moisture>.54?'tropical-forest':temperature>.56&&moisture<.32?'desert':moisture>.47?'temperate-forest':'grassland';
    const forestFamily=id==='taiga'?'conifer':id==='tropical-forest'?'tropical':id==='temperate-forest'||id==='grassland'?'temperate':'none';
    const density=id==='grassland'?.12:id==='taiga'?.75:id==='tropical-forest'?.96:id==='temperate-forest'?.8:0;
    const treeDensity=clamp(density*recipe.forestDensity*clamp((42-slope)/16));
    const buildingSuitability=['grassland','temperate-forest','taiga','tropical-forest','desert'].includes(id)?clamp((10-slope)/7)*recipe.settlementDensity:0;
    // Preserve low-frequency tint variation while detail maps supply metre-scale texture.
    const shade=.92+moisture*.16,color=palette[id].map(v=>v*shade) as [number,number,number];
    return {id,name:names[id],heightMeters:surface.heightMeters,slope,temperature,moisture,forestFamily,treeDensity,buildingSuitability,color};
  }});
}
