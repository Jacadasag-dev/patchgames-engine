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
it.each(MATERIAL_PATTERN_TYPES)('%s supports independent shape/size variation and inward/outward focus',type=>{
  const base=parseMaterialPattern({type,sizeMeters:.2,coverage:.5,irregularity:.8});
  const points=Array.from({length:144},(_,i)=>[(i%12)*.021,Math.floor(i/12)*.021,.071] as const);
  const original=points.map(p=>sampleMaterialPattern(base,p));
  for(const key of ['shapeVariation','sizeVariation'] as const){const changed={...base,[key]:.9},values=points.map(p=>sampleMaterialPattern(changed,p));expect(values).not.toEqual(original);expect(values).toEqual(points.map(p=>sampleMaterialPattern(parseMaterialPattern(changed),p)));expect(values.every(v=>Number.isFinite(v)&&v>=0&&v<=1)).toBe(true);}
  const inward=parseMaterialPattern({type,coverage:1,concentration:{strength:1,radius:.8,softness:.2}}),outward=parseMaterialPattern({...inward,concentration:{...inward.concentration,strength:-1}});
  expect(sampleMaterialPattern(inward,[8,9,10],{face:[0,0,0]})).toBe(1);expect(sampleMaterialPattern(inward,[8,9,10],{face:[1,0,0]})).toBe(0);
  expect(sampleMaterialPattern(outward,[8,9,10],{face:[0,0,0]})).toBe(0);expect(sampleMaterialPattern(outward,[8,9,10],{face:[1,0,0]})).toBe(1);
});
it('keeps model cross-sections distinct from face centres and validates missing frames',()=>{
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES['wood-core']),layer=r.layers[0];
  expect(surfaceCoverage(r,layer,'top',[0,r.sizeMeters[1]/2,0])).toBe(1);
  expect(surfaceCoverage(r,layer,'top',[r.sizeMeters[0]/2,r.sizeMeters[1]/2,0])).toBe(0);
  expect(surfaceCoverage(r,layer,'front',[0,0,r.sizeMeters[2]/2])).toBe(0); // selected end faces only
  const p=parseMaterialPattern({type:'patches',coverage:1,concentration:{space:'model',axes:'xz',strength:1,radius:.3,softness:0,center:[.4,0,-.2]}});
  expect(()=>sampleMaterialPattern(p,[0,0,0],{face:[0,0,0]})).toThrow('model coordinates');
  expect(sampleMaterialPattern(p,[0,0,0],{model:[.4,1,-.2]})).toBe(1);expect(sampleMaterialPattern(p,[0,0,0],{model:[0,1,0]})).toBe(0);
});
it('applies root concentration after union gates and after inversion',()=>{
  const r=parseMaterialPattern({type:'cells',coverage:1,invert:true,concentration:{strength:1},gates:[{operation:'union',pattern:{type:'patches',coverage:1}}]});
  expect(sampleMaterialPattern(r,[0,0,0],{face:[0,0,0]})).toBe(1);expect(sampleMaterialPattern(r,[0,0,0],{face:[1,1,0]})).toBe(0);
});
it('rejects malformed focus/variation parameters and does not share mutable defaults',()=>{
  for(const bad of [{shapeVariation:2},{sizeVariation:NaN},{concentration:{strength:2}},{concentration:{center:[0,0]}},{concentration:{radius:0}},{concentration:{axes:'yx'}},{concentration:{space:'world'}}])expect(()=>parseMaterialPattern({type:'patches',...bad})).toThrow();
  const a=parseMaterialPattern({type:'patches'}),b=parseMaterialPattern({type:'patches'});a.concentration.center[0]=.5;expect(b.concentration.center[0]).toBe(0);
});
it('keeps focused planar masks independent of source repeats and validates parser parity',async()=>{
  const recipe={kind:'texture' as const,version:1 as const,name:'Focused mask',resolution:32,layers:[{source:{kind:'solid' as const,color:'#000000'}},{source:{kind:'solid' as const,color:'#ffffff'},mask:{kind:'pattern' as const,pattern:{type:'patches',coverage:1,shapeVariation:.8,sizeVariation:.4,concentration:{strength:1,radius:.6}}}}]};
  expect(parseTextureRecipeData(recipe)).toEqual(textureRecipeSchema.parse(recipe));const a=await renderMaterialRecipe(recipe),b=await renderMaterialRecipe({...recipe,layers:[recipe.layers[0],{...recipe.layers[1],repeat:[4,4]}]});expect(a.color.data).toEqual(b.color.data);
  expect(a.color.data[(16*32+16)*4]).toBe(255);expect(a.color.data[0]).toBe(0);
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
