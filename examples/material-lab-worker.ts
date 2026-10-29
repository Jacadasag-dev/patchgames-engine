import {generateObjectSurface,BOX_SURFACES,boxSurfaceFrame,surfaceCoverage} from '../src/shared/objectSurface.ts';
import {generateMaterial} from '../src/shared/materialGenerator.ts';
import {createMaterialPatternSampler} from '../src/shared/materialPatterns.ts';
self.onmessage=async(event)=>{
  const {id,recipe,resolution,thumbnail,surfaceRecipe}=event.data;
  try{
    if(surfaceRecipe){const surface=await generateObjectSurface(surfaceRecipe,{resolution}),samplers=new Map(surface.recipe.layers.map(layer=>[layer,createMaterialPatternSampler(layer.coverage.pattern)] as const)),masks=Object.fromEntries(BOX_SURFACES.map(face=>{
      const {width,height}=surface.faces[face].color,data=new Uint8Array(width*height*4),frame=boxSurfaceFrame(surface.recipe.sizeMeters,face);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){const point=frame.point((x+.5)/width,(y+.5)/height);let uncovered=1;
        for(const layer of surface.recipe.layers)uncovered*=1-surfaceCoverage(surface.recipe,layer,face,point,samplers.get(layer))*layer.opacity;
        const k=(y*width+x)*4;data[k]=data[k+1]=data[k+2]=Math.round((1-uncovered)*255);data[k+3]=255;
      }return[face,{width,height,data}];
    }));self.postMessage({id,surface,masks},{transfer:[...Object.values(surface.faces).flatMap(face=>[face.color,face.normal,face.height,face.roughness,face.metalness,face.ao].map(map=>map.data.buffer)),...Object.values(masks).map(map=>map.data.buffer)]});return;}
    const baked=await generateMaterial(recipe,{resolution});
    if(thumbnail)self.postMessage({id,color:baked.color}, {transfer:[baked.color.data.buffer]});
    else self.postMessage({id,baked},{transfer:[baked.color,baked.normal,baked.height,baked.roughness,baked.metalness,baked.ao].map(map=>map.data.buffer)});
  }catch(error){self.postMessage({id,error:error instanceof Error?error.message:String(error)});}
};
