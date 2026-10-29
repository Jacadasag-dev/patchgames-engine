import {materialRecipe} from '../shared/materialRegistry.ts';
import {generateMaterial} from '../shared/materialGenerator.ts';
import type {MaterialSourcePixels} from '../shared/materialRecipeRenderer.ts';
let localResolver:((id:string)=>MaterialSourcePixels|undefined)|undefined,loaded=0,failed=0;
export function setLocalTextureResolver(resolver:(id:string)=>MaterialSourcePixels|undefined):()=>void{const old=localResolver;localResolver=resolver;return()=>{if(localResolver===resolver)localResolver=old;};}
export async function resolveTextureSource(id:string):Promise<MaterialSourcePixels>{
  try{const recipe=materialRecipe(id),source=recipe?await generateMaterial(recipe):localResolver?.(id);if(!source)throw Error('Unknown material recipe: '+id);loaded++;return source;}catch(error){failed++;throw error;}
}
export async function settleMediaSources():Promise<void>{await Promise.resolve();}
export function mediaSourceInfo():Record<string,number>{return{mediaPending:0,mediaLoaded:loaded,mediaErrors:failed};}
