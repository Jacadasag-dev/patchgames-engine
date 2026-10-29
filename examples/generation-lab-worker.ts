import {compileTerrain,type TerrainManifest} from '../src/sandbox/terrain.ts';
import {compileFoliageGeneration} from '../src/shared/generationFoliage.ts';
import {generateFoliage,type FoliageBake} from '../src/sandbox/foliageGenerator.ts';
import {generateObjectSurface,type ObjectSurfaceBake} from '../src/shared/objectSurface.ts';
import {compileGenerationMaps} from '../src/shared/generationMaps.ts';
import {generationLabTerrain,parseGenerationLabRecipe} from './generation-lab-data.ts';
export interface GenerationLabResult {revision:string;terrain:TerrainManifest;trees:{id:string;position:{x:number;y:number;z:number};yaw:number;bake:FoliageBake;values:Record<string,number>;geometryKey:string;materialKey:string;inspection:unknown}[];wall:ObjectSurfaceBake;diagnostics:unknown;elapsedMs:number}
export async function generateGenerationLab(input:unknown):Promise<GenerationLabResult>{
 const start=performance.now(),r=parseGenerationLabRecipe(input),terrain=compileTerrain(generationLabTerrain(r));if(!terrain.diagnostics.valid)throw Error(terrain.diagnostics.issues.map(i=>i.code+': '+i.message).join('\n'));
 const variation=compileFoliageGeneration({recipe:r.foliage.recipe,graph:r.graph,bindings:r.foliage.bindings,instances:terrain.instances.map(i=>({id:i.id,world:[i.position.x,i.position.y,i.position.z] as [number,number,number]}))}),trees:GenerationLabResult['trees']=[];
 for(const instance of terrain.instances){const variant=variation.variants.find(v=>v.id===instance.id);if(!variant)throw Error('Missing prepared tree variant for '+instance.id);trees.push({id:instance.id,position:instance.position,yaw:instance.yaw,bake:await generateFoliage(variant.recipe,{resolution:64}),values:variant.values,geometryKey:variant.geometryKey,materialKey:variant.materialKey,inspection:variation.inspect(instance.id).bindings});}
 const wall=await generateObjectSurface({...r.wall,generation:{graph:r.graph,bindings:r.wallBindings}},{resolution:256}),result:GenerationLabResult={revision:compileGenerationMaps(r.graph).revision,terrain,trees,wall,diagnostics:variation.diagnostics,elapsedMs:performance.now()-start};return result;
}
if(typeof self!=='undefined')self.onmessage=async event=>{const {id,recipe}=event.data;try{const result=await generateGenerationLab(recipe),buffers=new Set<ArrayBuffer>();
 const collect=(value:unknown)=>{if(ArrayBuffer.isView(value)){if(value.buffer instanceof ArrayBuffer)buffers.add(value.buffer);}else if(value instanceof ArrayBuffer)buffers.add(value);else if(value&&typeof value==='object')for(const child of Object.values(value))collect(child);};collect(result);self.postMessage({id,result},{transfer:[...buffers]});
 }catch(error){self.postMessage({id,error:error instanceof Error?error.message:String(error)});}};
