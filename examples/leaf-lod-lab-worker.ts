import {generateFoliage,type FoliageBake} from '../src/sandbox/foliageGenerator.ts';
import {leafLodLabRecipe} from './leaf-lod-lab-data.ts';
export async function prepareLeafLodLab(id:string):Promise<FoliageBake>{
 return generateFoliage(leafLodLabRecipe(id),{resolution:128});
}
if(typeof self!=='undefined')self.onmessage=async event=>{const {sequence,id}=event.data;try{const bake=await prepareLeafLodLab(id),buffers=new Set<ArrayBuffer>();const collect=(value:unknown)=>{if(ArrayBuffer.isView(value)){if(value.buffer instanceof ArrayBuffer)buffers.add(value.buffer);}else if(value instanceof ArrayBuffer)buffers.add(value);else if(value&&typeof value==='object')Object.values(value).forEach(collect);};collect(bake);self.postMessage({sequence,bake},{transfer:[...buffers]});}catch(error){self.postMessage({sequence,error:error instanceof Error?error.message:String(error)});}};
