import {generateObjectSurface} from '../src/shared/objectSurface.ts';
import {generateMaterial} from '../src/shared/materialGenerator.ts';
self.onmessage=async(event)=>{
  const {id,recipe,resolution,thumbnail,surfaceRecipe}=event.data;
  try{
    if(surfaceRecipe){const surface=await generateObjectSurface(surfaceRecipe,{resolution});self.postMessage({id,surface},{transfer:Object.values(surface.faces).flatMap(face=>[face.color,face.normal,face.height,face.roughness,face.metalness,face.ao].map(map=>map.data.buffer))});return;}
    const baked=await generateMaterial(recipe,{resolution});
    if(thumbnail)self.postMessage({id,color:baked.color}, {transfer:[baked.color.data.buffer]});
    else self.postMessage({id,baked},{transfer:[baked.color,baked.normal,baked.height,baked.roughness,baked.metalness,baked.ao].map(map=>map.data.buffer)});
  }catch(error){self.postMessage({id,error:error instanceof Error?error.message:String(error)});}
};
