import {materialRecipe} from '../shared/materialRegistry.ts';
import {generateMaterial} from '../shared/materialGenerator.ts';
import type {MaterialSourcePixels} from '../shared/materialRecipeRenderer.ts';
let localResolver:((id:string)=>MaterialSourcePixels|undefined)|undefined,loaded=0,failed=0;
const pending=new Set<Promise<MaterialSourcePixels>>();
export function setLocalTextureResolver(resolver:(id:string)=>MaterialSourcePixels|undefined):()=>void{const old=localResolver;localResolver=resolver;return()=>{if(localResolver===resolver)localResolver=old;};}
export function resolveTextureSource(id:string):Promise<MaterialSourcePixels>{
  const task=(async()=>{try{const recipe=materialRecipe(id),source=recipe?await generateMaterial(recipe):localResolver?.(id);if(!source)throw Error('Unknown material recipe: '+id);loaded++;return source;}catch(error){failed++;throw error;}})();
  pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;
}
export async function settleMediaSources():Promise<void>{do{await Promise.allSettled([...pending]);await Promise.resolve();await Promise.resolve();}while(pending.size);}
export function mediaSourceInfo():Record<string,number>{return{mediaPending:pending.size,mediaLoaded:loaded,mediaErrors:failed};}
