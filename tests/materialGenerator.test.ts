import {describe,it,expect} from 'vitest';
import {generateMaterial,materialGeneratorSchema,MATERIAL_FAMILIES,sampleMaterialGenerator} from '../src/shared/materialGenerator.ts';
import {createGeneratedMaterial} from '../src/sandbox/materialGenerator.ts';
import {renderMaterialRecipe} from '../src/shared/materialRecipeRenderer.ts';

describe('material generator',()=>{
  it.each(MATERIAL_FAMILIES)('%s produces repeatable coordinated maps with periodic fields',async family=>{
    const recipe=materialGeneratorSchema.parse({pattern:{family}}),a=await generateMaterial(recipe,{resolution:32}),b=await generateMaterial(recipe,{resolution:32});
    expect(a.color.data).toEqual(b.color.data);expect(new Set(a.color.data).size).toBeGreaterThan(4);
    for(const map of [a.color,a.normal,a.roughness,a.metalness,a.height,a.ao])expect(map.data.length).toBe(32*32*4);
    expect(sampleMaterialGenerator(recipe,0.123,0.287)).toEqual(sampleMaterialGenerator(recipe,1.123,1.287));
    const changed=await generateMaterial({...recipe,seed:29},{resolution:32});expect(changed.color.data).not.toEqual(a.color.data);
  });
  it('rejects meaningless family fields, unbounded output and nonfinite values',async()=>{
    expect(()=>materialGeneratorSchema.parse({pattern:{family:'wood',mortarMeters:0.1}})).toThrow();
    expect(()=>materialGeneratorSchema.parse({pattern:{family:'dirt'},tileMeters:[NaN,2]})).toThrow();
    await expect(generateMaterial({pattern:{family:'rock'}},{resolution:8192})).rejects.toThrow();
  });
  it('supports cancellation, 1024 output and palette quantization',async()=>{
    const controller=new AbortController();controller.abort();await expect(generateMaterial({pattern:{family:'wood'}},{signal:controller.signal})).rejects.toThrow();
    const hd=await generateMaterial({pattern:{family:'metal'},output:{resolution:2048}});expect(hd.color.width).toBe(2048);expect(hd.diagnostics.bytes).toBe(96*1024*1024);
    const pixel=await generateMaterial({pattern:{family:'rock'},output:{resolution:32,style:'pixel',paletteSteps:4}});
    const colors=new Set(Array.from({length:1024},(_,i)=>pixel.color.data.slice(i*4,i*4+3).join(',')));expect(colors.size).toBeLessThanOrEqual(4);
  });
  it('keeps grout lower than stone and provides flat normals at zero relief',async()=>{
    const recipe=materialGeneratorSchema.parse({pattern:{family:'masonry',bond:'stack',blockMeters:[0.5,0.5],chipping:0,irregularity:0},weathering:0});
    expect(sampleMaterialGenerator(recipe,0.125,0.125)[1]).toBeGreaterThan(sampleMaterialGenerator(recipe,0,0)[1]);
    const flat=await generateMaterial({...recipe,reliefMeters:0},{resolution:32});
    for(let k=0;k<flat.normal.data.length;k+=4)expect(Array.from(flat.normal.data.slice(k,k+4))).toEqual([128,128,255,255]);
    expect(()=>materialGeneratorSchema.parse({pattern:{family:'wood',plankMeters:0.01,gapMeters:0.02}})).toThrow();
  });
  it('creates a real PBR material and mixes generated sources without a hosted resolver',async()=>{
    const result=await createGeneratedMaterial({pattern:{family:'masonry'},output:{resolution:32,style:'pixel'}},{surfaceMeters:[10,4]});
    for(const map of Object.values(result.maps))expect(map.repeat.toArray()).toEqual([5,2]);
    expect(result.material.aoMap).toBe(result.maps.ao);expect(result.material.normalMap).toBe(result.maps.normal);result.dispose();result.dispose();
    const mixed=await renderMaterialRecipe({kind:'texture',version:1,name:'Mossy stone',resolution:32,layers:[{source:{kind:'generator',recipe:{pattern:{family:'masonry'}}}},{source:{kind:'noise',colors:['#254022','#627b35']},opacity:0.25}]});
    expect(mixed.diagnostics.sourceIds).toEqual([]);expect(new Set(mixed.color.data).size).toBeGreaterThan(4);
  });
});
