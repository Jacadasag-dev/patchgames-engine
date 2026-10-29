import * as THREE from 'three';
import {generateMaterial,type GeneratedMaterialPixels,type MaterialGeneratorRecipe} from '../shared/materialGenerator.ts';
export {generateMaterial,materialGeneratorSchema,MATERIAL_GENERATOR_PRESETS,MATERIAL_FAMILIES} from '../shared/materialGenerator.ts';
export type {MaterialGeneratorRecipe,GeneratedMaterialPixels} from '../shared/materialGenerator.ts';

/** Upload a previously baked result. Reuse the returned material; dispose after the last mesh releases it. */
export function createGeneratedMaterialFromPixels(baked:GeneratedMaterialPixels,options:{surfaceMeters?:[number,number]}={}){
  if(options.surfaceMeters && !options.surfaceMeters.every(v=>Number.isFinite(v)&&v>0&&v<=20000))throw Error('Surface dimensions must be positive finite metres, up to 20000.');
  const maps=Object.fromEntries((['color','normal','roughness','metalness','height','ao'] as const).map(name=>{
    const pixels=baked[name],map=new THREE.DataTexture(pixels.data,pixels.width,pixels.height,THREE.RGBAFormat,THREE.UnsignedByteType);
    map.colorSpace=name==='color'?THREE.SRGBColorSpace:THREE.NoColorSpace;
    map.wrapS=map.wrapT=THREE.RepeatWrapping;
    if(options.surfaceMeters)map.repeat.set(options.surfaceMeters[0]/baked.recipe.tileMeters[0],options.surfaceMeters[1]/baked.recipe.tileMeters[1]);
    map.magFilter=baked.recipe.output.style==='pixel'?THREE.NearestFilter:THREE.LinearFilter;
    map.minFilter=baked.recipe.output.style==='pixel'?THREE.NearestMipmapNearestFilter:THREE.LinearMipmapLinearFilter;
    map.generateMipmaps=true;map.needsUpdate=true;
    return[name,map];
  })) as Record<'color'|'normal'|'roughness'|'metalness'|'height'|'ao',THREE.DataTexture>;
  const material=new THREE.MeshStandardMaterial({name:baked.recipe.name,map:maps.color,normalMap:maps.normal,roughnessMap:maps.roughness,metalnessMap:maps.metalness,aoMap:maps.ao,roughness:1,metalness:1});
  material.userData.materialGenerator={recipe:baked.recipe,diagnostics:baked.diagnostics};
  let disposed=false;
  return{material,maps,recipe:baked.recipe,diagnostics:baked.diagnostics,dispose(){if(disposed)return;disposed=true;material.dispose();Object.values(maps).forEach(map=>map.dispose());}};
}
/** For loading screens. High-resolution authoring should bake in a worker and upload with FromPixels. */
export async function createGeneratedMaterial(recipe:MaterialGeneratorRecipe,options:NonNullable<Parameters<typeof generateMaterial>[1]>&{surfaceMeters?:[number,number]}={}){
  const baked=await generateMaterial(recipe,{yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0)),...options});
  return createGeneratedMaterialFromPixels(baked,options);
}
