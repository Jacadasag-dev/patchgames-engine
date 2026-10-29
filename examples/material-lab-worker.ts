import {generateMaterial} from '../src/shared/materialGenerator.ts';
self.onmessage=async(event)=>{
  const {id,recipe,resolution,thumbnail}=event.data;
  try{
    const baked=await generateMaterial(recipe,{resolution});
    if(thumbnail)self.postMessage({id,color:baked.color}, {transfer:[baked.color.data.buffer]});
    else self.postMessage({id,baked},{transfer:[baked.color,baked.normal,baked.height,baked.roughness,baked.metalness,baked.ao].map(map=>map.data.buffer)});
  }catch(error){self.postMessage({id,error:error instanceof Error?error.message:String(error)});}
};
