import {onMaterialRecipesChanged} from '../shared/materialRegistry.ts';
import {materialRecipeAssetIds} from '../shared/mediaRecipes.ts';
import * as THREE from 'three';
import { renderMaterialRecipe, type MaterialRecipeOptions, type MaterialRecipePixels, type TexturePixels } from '../shared/materialRecipeRenderer.ts';
import type { TextureRecipe } from '../shared/mediaRecipes.ts';
import { resolveTextureSource } from './media.ts';

export { textureRecipeSchema, materialRecipeAssetIds } from '../shared/mediaRecipes.ts';
export type { TextureRecipe, TextureLayer, TextureMask } from '../shared/mediaRecipes.ts';
export type { TexturePixels, MaterialRecipeOptions, MaterialSurfaceFields, MaterialRecipePixels } from '../shared/materialRecipeRenderer.ts';

export interface RecipeMaterial {
  material: THREE.MeshStandardMaterial;
  maps: { color: THREE.DataTexture; normal: THREE.DataTexture; roughness: THREE.DataTexture; metalness: THREE.DataTexture; height: THREE.DataTexture };
  recipe: MaterialRecipePixels['recipe'];
  diagnostics: MaterialRecipePixels['diagnostics'];
  onUpdate(listener:()=>void):()=>void;
  dispose(): void;
}
function texture(pixels: TexturePixels, color: boolean): THREE.DataTexture {
  const map = new THREE.DataTexture(pixels.data, pixels.width, pixels.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter; map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true; map.needsUpdate = true;
  return map;
}

/** Works in every mode's view. The default resolver uses trusted-host media delivery; no worker networking. */
export async function createRecipeMaterial(recipe: TextureRecipe, options: MaterialRecipeOptions = {}): Promise<RecipeMaterial> {
  const rendered = await renderMaterialRecipe(recipe, { ...options, resolveSource: options.resolveSource ?? resolveTextureSource });
  const maps = { color: texture(rendered.color, true), normal: texture(rendered.normal, false),
    roughness: texture(rendered.roughness, false), metalness: texture(rendered.metalness, false), height: texture(rendered.height, false) };
  const transparent = rendered.color.data.some((value, index) => index % 4 === 3 && value < 255);
  const material = new THREE.MeshStandardMaterial({ map: maps.color, normalMap: maps.normal,
    roughnessMap: maps.roughness, metalnessMap: maps.metalness, roughness: 1, metalness: 1, transparent });
  material.name = recipe.name;
  material.userData.materialRecipe = { id: recipe.id, name: recipe.name, ...rendered.diagnostics };
  let disposed = false, generation=0;
  const callbacks=new Set<()=>void>(),ids=new Set(materialRecipeAssetIds(recipe));
  const unsubscribe=onMaterialRecipesChanged(changed=>{
    if(![...changed].some(id=>ids.has(id)))return;
    const version=++generation;
    void renderMaterialRecipe(recipe,{...options,resolveSource:options.resolveSource??resolveTextureSource}).then(next=>{
      if(disposed||version!==generation)return;
      for(const name of Object.keys(maps) as (keyof typeof maps)[]){maps[name].dispose();maps[name].source=new THREE.Source(next[name]);maps[name].needsUpdate=true;}
      Object.assign(rendered.diagnostics,next.diagnostics);material.userData.materialRecipe={id:recipe.id,name:recipe.name,...next.diagnostics};
      for(const callback of callbacks)callback();
    },error=>{
      if(disposed||version!==generation)return;
      rendered.diagnostics.warnings=[String(error)];material.userData.materialRecipe.error=String(error);
      for(const name of Object.keys(maps) as (keyof typeof maps)[]){const rgba=name==='normal'?[128,128,255,255]:name==='metalness'?[0,0,0,255]:[128,128,128,255];maps[name].dispose();maps[name].source=new THREE.Source({width:1,height:1,data:new Uint8Array(rgba)});maps[name].needsUpdate=true;}
      for(const callback of callbacks)callback();
    });
  });
  return { material, maps, recipe: rendered.recipe, diagnostics: rendered.diagnostics, onUpdate(listener){callbacks.add(listener);return()=>{callbacks.delete(listener);};}, dispose() {
    if (disposed) return;
    disposed = true; generation++;unsubscribe();callbacks.clear();material.dispose(); Object.values(maps).forEach(map => map.dispose());
  } };
}
