import {MATERIAL_RECIPE_LIBRARY} from './materialRecipeLibrary.ts';
import {parseMaterialGeneratorData} from './materialGeneratorData.ts';
import type {ResolvedMaterialGenerator} from './materialGenerator.ts';
export const MATERIALS_FILE='src/game/materials.json';
export type MaterialRecipes=Record<string,ResolvedMaterialGenerator>;
let overrides:MaterialRecipes={};
const listeners=new Set<(ids:ReadonlySet<string>)=>void>();
export function readMaterialRecipes(source:string|undefined):MaterialRecipes{
  if(source===undefined)return {};
  if(source.length>262144)throw Error('Material recipes exceed 256 KiB.');
  const input=JSON.parse(source);
  if(!input||input.version!==1||!input.materials||Array.isArray(input.materials)||typeof input.materials!=='object'||Object.keys(input).some(key=>!['version','materials'].includes(key)))throw Error('Expected {version:1,materials:{id:generatorRecipe}}.');
  if(Object.keys(input.materials).length>128)throw Error('At most 128 material recipes per game.');
  const out:MaterialRecipes={};for(const[id,recipe]of Object.entries(input.materials)){if(!/^[a-z][a-z0-9._-]{0,119}$/i.test(id)||['__proto__','constructor','prototype'].includes(id))throw Error('Invalid material identifier.');out[id]=parseMaterialGeneratorData(recipe);}return out;
}
export function materialRecipe(id:string):ResolvedMaterialGenerator|undefined{return Object.hasOwn(overrides,id)?overrides[id]:Object.hasOwn(MATERIAL_RECIPE_LIBRARY,id)?MATERIAL_RECIPE_LIBRARY[id]:undefined;}
/** Whole-document replacement: deletions are observable and invalid edits leave the current set intact. */
export function replaceMaterialRecipes(input:MaterialRecipes):ReadonlySet<string>{
  const next=readMaterialRecipes(JSON.stringify({version:1,materials:input})),changed=new Set<string>();
  for(const id of new Set([...Object.keys(overrides),...Object.keys(next)]))if(JSON.stringify(overrides[id])!==JSON.stringify(next[id]))changed.add(id);
  overrides=next;if(changed.size)for(const listener of listeners)listener(changed);return changed;
}
export function onMaterialRecipesChanged(listener:(ids:ReadonlySet<string>)=>void):()=>void{listeners.add(listener);return()=>{listeners.delete(listener);};}
