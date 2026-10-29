import {it,expect} from 'vitest';
import {MeshPhysicalMaterial} from 'three';
import {MATERIAL_OPTICAL_PRESETS} from '../src/shared/materialOpticalPresets.ts';
import {materialGeneratorSchema,generateMaterial} from '../src/shared/materialGenerator.ts';
import {parseMaterialGeneratorData} from '../src/shared/materialGeneratorData.ts';
import {createGeneratedMaterialFromPixels} from '../src/sandbox/materialGenerator.ts';
import {createRecipeMaterial} from '../src/sandbox/materialRecipes.ts';
import {replaceMaterialRecipes} from '../src/shared/materialRegistry.ts';
import {SurfaceMaterialCache} from '../src/sandbox/surfaceMaterialView.ts';
import {resolveSurfaceMaterial} from '../src/sandbox/surfaceMaterials.ts';
import {renderMaterialRecipe} from '../src/shared/materialRecipeRenderer.ts';
import {generateObjectSurface,OBJECT_SURFACE_EXAMPLES,objectSurfaceSchema} from '../src/shared/objectSurface.ts';

it.each(MATERIAL_OPTICAL_PRESETS)('$id produces validated optical maps and physical rendering settings',async({recipe})=>{
 expect(parseMaterialGeneratorData(recipe)).toEqual(materialGeneratorSchema.parse(recipe));
 const a=await generateMaterial(recipe,{resolution:32}),b=await generateMaterial(recipe,{resolution:32});expect(a.color.data).toEqual(b.color.data);
 const h=createGeneratedMaterialFromPixels(a);try{expect(h.material).toBeInstanceOf(MeshPhysicalMaterial);expect(h.material.transmission).toBe(recipe.optics!.transmission);expect(h.material.ior).toBe(recipe.optics!.ior);expect(h.material.thickness).toBe(recipe.optics!.thicknessMeters);expect(h.material.transparent).toBe(false);expect(h.material.alphaTest).toBe(0);expect(a.diagnostics.warnings.join(' ')).toContain('PNG');}finally{h.dispose();}
});
it('rejects invalid optics consistently in both parsers',()=>{
 for(const optics of [{ior:.5},{transmission:2},{thicknessMeters:-1},{attenuationColor:'blue'},{attenuationDistanceMeters:0},{envMapIntensity:Infinity},{secret:1}])for(const parse of [materialGeneratorSchema.parse.bind(materialGeneratorSchema),parseMaterialGeneratorData])expect(()=>parse({pattern:{family:'plaster'},optics})).toThrow();
});
it('propagates named optical updates through recipe and cached surface materials, then resets to opaque',async()=>{
 const glass=MATERIAL_OPTICAL_PRESETS[0].recipe,mirror=MATERIAL_OPTICAL_PRESETS.find(p=>p.id==='silver-mirror')!.recipe;
 replaceMaterialRecipes({'test.optical':glass});const recipe={kind:'texture' as const,version:1 as const,name:'Optical live',resolution:32,layers:[{source:{kind:'asset' as const,id:'test.optical'}}]};
 const h=await createRecipeMaterial(recipe),cache=new SurfaceMaterialCache(),lease=cache.acquire(resolveSurfaceMaterial({texture:recipe,tileSize:[1,1]},{seed:1,key:'optical'})!);
 try{await lease.ready;expect(h.material.transmission).toBe(1);expect(lease.material.transmission).toBe(1);
  for(const next of [mirror,materialGeneratorSchema.parse({pattern:{family:'plaster'}})]){
   const changed=new Promise<void>(resolve=>{const off=h.onUpdate(()=>{off();resolve();});});replaceMaterialRecipes({'test.optical':next});await changed;await lease.ready;
   for(let i=0;i<100&&lease.material.transmission!==0;i++)await new Promise(resolve=>setTimeout(resolve,1));
   expect(h.material.transmission).toBe(0);expect(lease.material.transmission).toBe(0);expect(h.material.thickness).toBe(next.optics?.thicknessMeters??0);expect(lease.material.thickness).toBe(next.optics?.thicknessMeters??0);
  }
 }finally{h.dispose();lease.dispose();cache.dispose();replaceMaterialRecipes({});}
});
it('does not silently flatten optical response into partial opaque layer blends',async()=>{
 const glass=MATERIAL_OPTICAL_PRESETS[0].recipe,layer={source:{kind:'generator' as const,recipe:glass}};
 const base={kind:'texture' as const,version:1 as const,name:'Glass',layers:[layer],resolution:32};expect((await renderMaterialRecipe(base)).optics).toEqual(glass.optics);
 await expect(renderMaterialRecipe({...base,layers:[layer,{source:{kind:'solid',color:'#000000'}}]})).rejects.toThrow('separate meshes');
 await expect(renderMaterialRecipe({...base,layers:[{...layer,opacity:.5}]})).rejects.toThrow('full-opacity');
 const pane={...OBJECT_SURFACE_EXAMPLES.grass,base:glass,layers:[]};expect((await generateObjectSurface(pane,{resolution:16})).faces.front.recipe.optics).toEqual(glass.optics);
 expect(()=>objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,base:glass})).toThrow('separate meshes');
});
