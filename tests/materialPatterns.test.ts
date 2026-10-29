import {it,expect} from 'vitest';
import {DoubleSide} from 'three';
import {MATERIAL_PATTERN_TYPES,parseMaterialPattern,sampleMaterialPattern} from '../src/shared/materialPatterns.ts';
import {materialGeneratorSchema,MATERIAL_GENERATOR_PRESETS,generateMaterial} from '../src/shared/materialGenerator.ts';
import {parseMaterialGeneratorData} from '../src/shared/materialGeneratorData.ts';
import {objectSurfaceSchema,OBJECT_SURFACE_EXAMPLES,boxSurfaceFrame,surfaceCoverage,sampleObjectSurface,generateObjectSurface} from '../src/shared/objectSurface.ts';
import {parseTextureRecipeData} from '../src/shared/materialRecipeData.ts';
import {textureRecipeSchema} from '../src/shared/mediaRecipes.ts';
import {renderMaterialRecipe} from '../src/shared/materialRecipeRenderer.ts';
import {createGeneratedMaterialFromPixels} from '../src/sandbox/materialGenerator.ts';
import {replaceMaterialRecipes} from '../src/shared/materialRegistry.ts';
import {createRecipeMaterial} from '../src/sandbox/materialRecipes.ts';
import {SurfaceMaterialCache} from '../src/sandbox/surfaceMaterialView.ts';
import {resolveSurfaceMaterial} from '../src/sandbox/surfaceMaterials.ts';

it.each(MATERIAL_PATTERN_TYPES)('%s is deterministic, bounded and responds to physical size',type=>{
  const p=parseMaterialPattern({type,sizeMeters:.2,coverage:.55,irregularity:.8}),changed={...p,sizeMeters:.31};
  const points=Array.from({length:60},(_,i)=>[i*.017,.037+i*.011,.051] as const);
  const values=points.map(point=>sampleMaterialPattern(p,point));
  expect(values.every(v=>Number.isFinite(v)&&v>=0&&v<=1)).toBe(true);expect(new Set(values).size).toBeGreaterThan(1);
  expect(points.map(point=>sampleMaterialPattern(parseMaterialPattern(p),point))).toEqual(values);
  expect(points.map(point=>sampleMaterialPattern(changed,point))).not.toEqual(values);
});
it('combines bounded gates and rejects unbounded/ambiguous data',()=>{
  const p=parseMaterialPattern({type:'patches',coverage:1,gates:[{operation:'subtract',pattern:{type:'veins',coverage:1}}]});
  expect(sampleMaterialPattern(p,[.2,.3,.4])).toBe(0);
  expect(sampleMaterialPattern(parseMaterialPattern({type:'patches',coverage:0,invert:true}),[0,0,0])).toBe(1);
  for(const bad of [{type:'missing'},{type:'patches',sizeMeters:0},{type:'patches',coverage:NaN},{type:'veins',seed:.5},{type:'cells',gates:Array(4).fill({})},{type:'cells',gates:[{operation:'intersect',pattern:{type:'veins',gates:[]}}]}])expect(()=>parseMaterialPattern(bad)).toThrow();
});
it('uses continuous corner coverage independently of source repeats and semantic orientation',()=>{
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.iron),layer=r.layers[0];
  for(let v=0;v<=1;v+=.1){const a=boxSurfaceFrame(r.sizeMeters,'front').point(1,v),b=boxSurfaceFrame(r.sizeMeters,'right').point(0,v);expect(a).toEqual(b);expect(surfaceCoverage(r,layer,'front',a)).toBe(surfaceCoverage(r,layer,'right',b));}
  const point=boxSurfaceFrame(r.sizeMeters,'front').point(.37,.63),before=surfaceCoverage(r,layer,'front',point);layer.material.tileMeters=[.02,2];expect(surfaceCoverage(r,layer,'front',point)).toBe(before);
});
it('blends physical height and material responses with the same mask, including zero-opacity removal',async()=>{
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.gold);r.output.resolution=32;
  const a=await generateObjectSurface(r),clean=await generateObjectSurface({...r,layers:[]});expect(a.faces.front.color.data).not.toEqual(clean.faces.front.color.data);expect(a.faces.front.metalness.data).not.toEqual(clean.faces.front.metalness.data);expect(a.faces.front.normal.data).not.toEqual(clean.faces.front.normal.data);
  r.layers[0].opacity=0;expect((await generateObjectSurface(r)).faces.front.color.data).toEqual(clean.faces.front.color.data);
  const full=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.iron);if(full.layers[0].coverage.kind==='pattern')full.layers[0].coverage.pattern.coverage=1;
  const before=sampleObjectSurface(full,'front',.2,.7);full.layers[0].heightOffsetMeters-=.02;const after=sampleObjectSurface(full,'front',.2,.7);expect(before.height-after.height).toBeCloseTo(.02);
});
it('supports the same pattern masks through texture recipes with data-parser parity',async()=>{
  const recipe={kind:'texture' as const,version:1 as const,name:'Pattern test',resolution:32,layers:[{source:{kind:'solid' as const,color:'#333333'}},{source:{kind:'solid' as const,color:'#e7bc49'},mask:{kind:'pattern' as const,pattern:{type:'veins',sizeMeters:.12,coverage:.3},tileMeters:[1,1] as [number,number]}}]};
  expect(parseTextureRecipeData(recipe)).toEqual(textureRecipeSchema.parse(recipe));
  const a=await renderMaterialRecipe(recipe),b=await renderMaterialRecipe({...recipe,layers:[recipe.layers[0],{...recipe.layers[1],repeat:[4,3]}]});expect(a.color.data).toEqual(b.color.data);
  expect(new Set(a.color.data).size).toBeGreaterThan(4);
});
it.each(['bark','leaf','needle','exposed-wood'])('%s has validated deterministic plant maps and actual leaf cutouts',async family=>{
  const preset=MATERIAL_GENERATOR_PRESETS.find(p=>p.recipe.pattern.family===family)!;
  expect(parseMaterialGeneratorData(preset.recipe)).toEqual(materialGeneratorSchema.parse(preset.recipe));
  const a=await generateMaterial(preset.recipe,{resolution:64}),b=await generateMaterial(preset.recipe,{resolution:64});expect(a.color.data).toEqual(b.color.data);
  const alpha=Array.from(a.color.data).filter((_,i)=>i%4===3);
  if(family==='leaf'||family==='needle'){
    expect(alpha).toContain(0);expect(alpha).toContain(255);const handle=createGeneratedMaterialFromPixels(a);expect(handle.material.alphaTest).toBe(.5);expect(handle.material.side).toBe(DoubleSide);expect(handle.material.transparent).toBe(false);handle.dispose();
  }else expect(alpha.every(v=>v===255)).toBe(true);
});
it('updates cutout rendering state on named-recipe edits and cached surface copies',async()=>{
  const leaf=materialGeneratorSchema.parse(MATERIAL_GENERATOR_PRESETS.find(p=>p.recipe.pattern.family==='leaf')!.recipe);
  const recipe={kind:'texture' as const,version:1 as const,name:'Live foliage',resolution:32,layers:[{source:{kind:'asset' as const,id:'test.leaf'}}]};
  replaceMaterialRecipes({'test.leaf':leaf});const handle=await createRecipeMaterial(recipe),cache=new SurfaceMaterialCache(),lease=cache.acquire(resolveSurfaceMaterial({texture:recipe,tileSize:[.12,.22]},{seed:1,key:'leaf'})!);
  try{await lease.ready;expect(handle.material.alphaTest).toBe(.5);expect(lease.material.alphaTest).toBe(.5);expect(lease.material.side).toBe(DoubleSide);
    const changed=new Promise<void>(resolve=>{const off=handle.onUpdate(()=>{off();resolve();});});
    replaceMaterialRecipes({'test.leaf':materialGeneratorSchema.parse({pattern:{family:'plaster'}})});await changed;
    // The cache has a separate material owner; await its source update too.
    for(let i=0;i<100&&lease.material.alphaTest!==0;i++)await new Promise(resolve=>setTimeout(resolve,1));
    expect(handle.material.alphaTest).toBe(0);expect(handle.material.transparent).toBe(false);expect(lease.material.alphaTest).toBe(0);
    const restored=new Promise<void>(resolve=>{const off=handle.onUpdate(()=>{off();resolve();});});replaceMaterialRecipes({'test.leaf':leaf});await restored;
    for(let i=0;i<100&&lease.material.alphaTest!==.5;i++)await new Promise(resolve=>setTimeout(resolve,1));
    expect(handle.material.alphaTest).toBe(.5);expect(lease.material.alphaTest).toBe(.5);expect(lease.material.side).toBe(DoubleSide);
  }finally{handle.dispose();lease.dispose();cache.dispose();replaceMaterialRecipes({});}
});
