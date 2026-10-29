import {DataTexture} from 'three';
import {afterEach,it,expect} from 'vitest';
import {readMaterialRecipes,replaceMaterialRecipes,materialRecipe} from '../src/shared/materialRegistry.ts';
import {materialGeneratorSchema,MATERIAL_GENERATOR_PRESETS} from '../src/shared/materialGenerator.ts';
import {parseMaterialGeneratorData} from '../src/shared/materialGeneratorData.ts';
import {createRecipeMaterial} from '../src/sandbox/materialRecipes.ts';
import {SurfaceMaterialCache} from '../src/sandbox/surfaceMaterialView.ts';
import {resolveSurfaceMaterial} from '../src/sandbox/surfaceMaterials.ts';
import {MEDIA_ASSETS} from '../src/shared/mediaAssets.ts';
import {resolveTextureSource,settleMediaSources,mediaSourceInfo} from '../src/sandbox/media.ts';
afterEach(()=>replaceMaterialRecipes({}));
it('waits for procedural source preparation before a first-frame inspection',async()=>{
  const source=resolveTextureSource('texture.stone');expect(mediaSourceInfo().mediaPending).toBe(1);
  await settleMediaSources();expect(mediaSourceInfo().mediaPending).toBe(0);expect((await source).color.width).toBe(128);
});
const generator=(color:string)=>materialGeneratorSchema.parse({pattern:{family:'plaster'},color,secondaryColor:color,output:{resolution:32}});
const recipe={kind:'texture' as const,version:1 as const,name:'Live stone',resolution:16,layers:[{source:{kind:'asset' as const,id:'custom.stone'}}]};
it('stores recipes only and validates generator sources without a renderer dependency',()=>{
  expect(MEDIA_ASSETS.every(asset=>asset.kind==='sound')).toBe(true);
  expect(materialRecipe('texture.stone')?.pattern.family).toBe('rock');
  for(const preset of MATERIAL_GENERATOR_PRESETS)expect(parseMaterialGeneratorData(preset.recipe)).toEqual(materialGeneratorSchema.parse(preset.recipe));
  for(const input of [{pattern:{family:'wood'}},{seed:undefined,output:{style:undefined},pattern:{family:'wood',grain:undefined}}])expect(parseMaterialGeneratorData(input)).toEqual(materialGeneratorSchema.parse(input));
  expect(()=>readMaterialRecipes('{"version":1,"materials":{"x":{"pattern":{"family":"bad"}}}}')).toThrow();
});
it('hot-swaps texture pixels in place and visibly clears deleted recipe references',async()=>{
  replaceMaterialRecipes({'custom.stone':generator('#ff0000')});
  const handle=await createRecipeMaterial(recipe),identity=handle.material,oldSource=handle.maps.color.source;let released=0;handle.maps.color.addEventListener('dispose',()=>released++);
  const changed=new Promise<void>(resolve=>{const off=handle.onUpdate(()=>{off();resolve();});});
  replaceMaterialRecipes({'custom.stone':generator('#00ff00')});await changed;
  expect(handle.material).toBe(identity);expect(handle.maps.color.source).not.toBe(oldSource);expect(released).toBeGreaterThan(0);expect(handle.maps.color.image.data![1]).toBe(255);expect(handle.maps.color.image.data![0]).toBe(0);
  const removed=new Promise<void>(resolve=>{const off=handle.onUpdate(()=>{off();resolve();});});
  replaceMaterialRecipes({});await removed;expect(handle.maps.color.image.width).toBe(1);expect(handle.diagnostics.warnings[0]).toContain('custom.stone');handle.dispose();
});
it('updates cloned cached surfaces without replacing geometry or their UV transforms',async()=>{
  replaceMaterialRecipes({'custom.stone':generator('#ff0000')});const cache=new SurfaceMaterialCache();
  const resolved=resolveSurfaceMaterial({texture:recipe,tileSize:[2,3]},{seed:1,key:'wall'}),lease=cache.acquire(resolved!);await lease.ready;
  const original=lease.material,map=original.map as DataTexture;
  replaceMaterialRecipes({'custom.stone':generator('#0000ff')});
  for(let i=0;i<100&&map.image.data![2]!==255;i++)await new Promise(resolve=>setTimeout(resolve,1));
  expect(map.image.data![2]).toBe(255);expect(lease.material).toBe(original);expect(map.repeat.toArray()).toEqual([0.5,1/3]);lease.dispose();cache.dispose();
});
