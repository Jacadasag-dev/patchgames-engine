import * as THREE from 'three';
import {generateMaterial,type GeneratedMaterialPixels,type MaterialGeneratorRecipe} from '../shared/materialGenerator.ts';
import {mapBoxMaterialMeters} from './materialMapping.ts';
export {mapBoxMaterialMeters,inspectTextureDensity,createMaterialMappingDebug} from './materialMapping.ts';
export {generateMaterial,materialGeneratorSchema,MATERIAL_GENERATOR_PRESETS,MATERIAL_FAMILIES} from '../shared/materialGenerator.ts';
export type {MaterialGeneratorRecipe,GeneratedMaterialPixels} from '../shared/materialGenerator.ts';

/** Upload a previously baked result. Reuse the returned material; dispose after the last mesh releases it. */
export interface GeneratedMaterialMapping {
  /** Recommended for boxes: maps every face in physical metres, including narrow edges. Mutates UVs. */
  geometry?:THREE.BoxGeometry;
  /** For geometry already authored in metres (terrain/buildings). */
  uvSpace?:'metres';
  /** Normalized UV plane only; do not use one pair for all six box faces. */
  surfaceMeters?:[number,number];
}
export function createGeneratedMaterialFromPixels(baked:GeneratedMaterialPixels,options:GeneratedMaterialMapping={}){
  if(options.surfaceMeters&&(options.geometry||options.uvSpace))throw Error('Choose physical geometry/UVs or normalized surface dimensions, not both.');
  if(options.geometry)mapBoxMaterialMeters(options.geometry);
  if(options.surfaceMeters && !options.surfaceMeters.every(v=>Number.isFinite(v)&&v>0&&v<=20000))throw Error('Surface dimensions must be positive finite metres, up to 20000.');
  const maps=Object.fromEntries((['color','normal','roughness','metalness','height','ao'] as const).map(name=>{
    const pixels=baked[name],map=new THREE.DataTexture(pixels.data,pixels.width,pixels.height,THREE.RGBAFormat,THREE.UnsignedByteType);
    map.colorSpace=name==='color'?THREE.SRGBColorSpace:THREE.NoColorSpace;
    map.wrapS=map.wrapT=THREE.RepeatWrapping;
    if(options.surfaceMeters)map.repeat.set(options.surfaceMeters[0]/baked.recipe.tileMeters[0],options.surfaceMeters[1]/baked.recipe.tileMeters[1]);
    else if(options.geometry||options.uvSpace==='metres')map.repeat.set(1/baked.recipe.tileMeters[0],1/baked.recipe.tileMeters[1]);
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
export async function createGeneratedMaterial(recipe:MaterialGeneratorRecipe,options:NonNullable<Parameters<typeof generateMaterial>[1]>&GeneratedMaterialMapping={}){
  const baked=await generateMaterial(recipe,{yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0)),...options});
  return createGeneratedMaterialFromPixels(baked,options);
}
/** Safe default for generated box surfaces. Dimensions are metres; all faces share
 * physical texture density. Change dimensions by rebuilding, rather than scaling the mesh.
 * The returned disposer owns both geometry and material/maps.
 */
export async function createGeneratedMaterialBox(recipe:MaterialGeneratorRecipe,sizeMeters:[number,number,number],options:Parameters<typeof generateMaterial>[1]={}){
  if(!sizeMeters.every(v=>Number.isFinite(v)&&v>0&&v<=20000))throw Error('Box dimensions must be positive finite metres, up to 20000.');
  const geometry=new THREE.BoxGeometry(...sizeMeters);
  try{const handle=await createGeneratedMaterial(recipe,{...options,geometry});const mesh=new THREE.Mesh(geometry,handle.material);let disposed=false;
    return{...handle,mesh,dispose(){if(disposed)return;disposed=true;geometry.dispose();handle.dispose();}};
  }catch(error){geometry.dispose();throw error;}
}
