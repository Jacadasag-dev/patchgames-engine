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
  let disposed = false;
  return { material, maps, recipe: rendered.recipe, diagnostics: rendered.diagnostics, dispose() {
    if (disposed) return;
    disposed = true; material.dispose(); Object.values(maps).forEach(map => map.dispose());
  } };
}
