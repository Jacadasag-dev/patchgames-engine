import {it,expect} from 'vitest';
import {DoubleSide} from 'three';
import {MATERIAL_PATTERN_TYPES,parseMaterialPattern,sampleMaterialPattern,materialPatternFeatureAtCell,materialPatternGroupedFeaturesAtCell,inspectMaterialPatternDistribution,materialPatternFeaturesAtCell,createMaterialPatternSampler} from '../src/shared/materialPatterns.ts';
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

it.each(MATERIAL_PATTERN_TYPES)('%s supports ordered, mixed and genuinely scattered placement',type=>{
  function measure(placementRegularity:number){const r=parseMaterialPattern({type,placementRegularity,irregularity:1,sizeMeters:.1});let count=0,empty=0,multiple=0,cx=0,sx=0,cy=0,sy=0;
    for(let y=-16;y<16;y++)for(let x=-16;x<16;x++){const features=materialPatternFeaturesAtCell(r,[x,y,0],{faceMeters:[4,4]});empty+=Number(features.length===0);multiple+=Number(features.length>1);
      for(const f of features){count++;cx+=Math.cos(f.center[0]/Math.pow(r.density,-.5)*2*Math.PI);sx+=Math.sin(f.center[0]/Math.pow(r.density,-.5)*2*Math.PI);cy+=Math.cos(f.center[1]/Math.pow(r.density,-.5)*2*Math.PI);sy+=Math.sin(f.center[1]/Math.pow(r.density,-.5)*2*Math.PI);}
    }return{count,empty,multiple,alignment:(Math.hypot(cx,sx)+Math.hypot(cy,sy))/(2*count)};
  }
  const grid=measure(1),mixed=measure(.5),scatter=measure(0);
  expect(grid.alignment).toBeCloseTo(1,8);expect(scatter.alignment).toBeLessThan(.08);expect(mixed.alignment).toBeGreaterThan(scatter.alignment+.2);expect(mixed.alignment).toBeLessThan(grid.alignment-.2);
  expect(scatter.empty).toBeGreaterThan(200);expect(scatter.multiple).toBeGreaterThan(150);
  for(const result of [grid,mixed,scatter])expect(result.count/1024).toBeGreaterThan(.9);
  for(const result of [grid,mixed,scatter])expect(result.count/1024).toBeLessThan(1.1);
});
it('keeps scatter distribution, grouping, individual sizes and opacity independent',()=>{
  const r=parseMaterialPattern({type:'clusters',sizeMeters:.1,placementRegularity:0}),focused=parseMaterialPattern({...r,concentration:{strength:1,radius:.8}}),frame={faceMeters:[2,2] as const};let inner=0,outer=0,innerTotal=0,outerTotal=0;
  for(let y=-10;y<10;y++)for(let x=-10;x<10;x++){
    const a=materialPatternFeaturesAtCell(r,[x,y,0],frame),b=materialPatternFeaturesAtCell(focused,[x,y,0],frame);expect(a.map(f=>[f.id,f.center,f.sizeScale])).toEqual(b.map(f=>[f.id,f.center,f.sizeScale]));
    for(const f of b){const distance=Math.hypot(f.center[0],f.center[1]);if(distance<.45){innerTotal++;inner+=Number(f.accepted);}if(distance>.9){outerTotal++;outer+=Number(f.accepted);}}
  }expect(inner/innerTotal).toBeGreaterThan(outer/outerTotal+.3);
  for(const placementRegularity of [-1,2,NaN])expect(()=>parseMaterialPattern({type:'clusters',placementRegularity})).toThrow();
});
it('cached scatter samplers match stateless output across domains and retain immutable snapshots',()=>{
  const r=parseMaterialPattern({type:'clusters',placementRegularity:0,clumping:.8,shapeVariation:.6,sizeVariation:.4,concentration:{strength:.8}}),sampler=createMaterialPatternSampler(r);
  const samples=Array.from({length:40},(_,i)=>({point:[i*.013,i*.007,0] as const,frame:{face:[i*.026-1,i*.014-1,0] as const,faceMeters:[1,2] as const}}));
  const values=samples.map(s=>sampler(s.point,s.frame));expect(values).toEqual(samples.map(s=>sampleMaterialPattern(r,s.point,s.frame)));
  const other={face:[.4,.2,0] as const,faceMeters:[2,1] as const};expect(sampler([.4,.1,0],other)).toBe(sampleMaterialPattern(r,[.4,.1,0],other));
  r.seed=900;r.placementRegularity=1;expect(samples.map(s=>sampler(s.point,s.frame))).toEqual(values);
});

it.each(MATERIAL_PATTERN_TYPES)('%s is deterministic, bounded and responds to physical size',type=>{
  const p=parseMaterialPattern({type,sizeMeters:.2,coverage:.55,irregularity:.8}),changed={...p,sizeMeters:.31};
  const points=Array.from({length:512},(_,i)=>[(i*.754877666)%1,(i*.569840291)%1,(i*.43828911)%1] as const);
  const values=points.map(point=>sampleMaterialPattern(p,point));
  expect(values.every(v=>Number.isFinite(v)&&v>=0&&v<=1)).toBe(true);expect(new Set(values).size).toBeGreaterThan(1);
  expect(points.map(point=>sampleMaterialPattern(parseMaterialPattern(p),point))).toEqual(values);
  expect(points.map(point=>sampleMaterialPattern(changed,point))).not.toEqual(values);
});
it.each(MATERIAL_PATTERN_TYPES)('%s supports independent shape/size variation and inward/outward focus',type=>{
  const base=parseMaterialPattern({type,sizeMeters:.2,coverage:.5,irregularity:.8,placementRegularity:1});
  const points=Array.from({length:144},(_,i)=>[(i%12)*.07,Math.floor(i/12)*.07,.17] as const);
  const original=points.map(p=>sampleMaterialPattern(base,p));
  for(const key of ['shapeVariation','sizeVariation'] as const){const changed={...base,[key]:.9},values=points.map(p=>sampleMaterialPattern(changed,p));expect(values).not.toEqual(original);expect(values).toEqual(points.map(p=>sampleMaterialPattern(parseMaterialPattern(changed),p)));expect(values.every(v=>Number.isFinite(v)&&v>=0&&v<=1)).toBe(true);}
  const inward=parseMaterialPattern({...base,concentration:{strength:1,radius:.8}}),outward=parseMaterialPattern({...base,concentration:{strength:-1,radius:.8}}),frame={faceMeters:[2,2] as const};
  let innerIn=0,outerIn=0,innerOut=0,outerOut=0,innerCount=0,outerCount=0;
  for(let y=-5;y<5;y++)for(let x=-5;x<5;x++){const a=materialPatternFeatureAtCell(inward,[x,y,0],frame),b=materialPatternFeatureAtCell(outward,[x,y,0],frame),radius=Math.hypot(a.center[0],a.center[1]);
    if(radius<.45){innerCount++;innerIn+=Number(a.accepted);innerOut+=Number(b.accepted);}if(radius>.85){outerCount++;outerIn+=Number(a.accepted);outerOut+=Number(b.accepted);}
  }
  expect(innerIn/innerCount).toBeGreaterThan(outerIn/outerCount+.4);expect(outerOut/outerCount).toBeGreaterThan(innerOut/innerCount+.4);
});
it('keeps model cross-sections distinct from face centres and validates missing frames',()=>{
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES['wood-core']),layer=r.layers[0];
  expect(surfaceCoverage(r,layer,'top',[0,r.sizeMeters[1]/2,0])).toBe(1);
  expect(surfaceCoverage(r,layer,'top',[r.sizeMeters[0]/2,r.sizeMeters[1]/2,0])).toBe(0);
  expect(surfaceCoverage(r,layer,'front',[0,0,r.sizeMeters[2]/2])).toBe(0); // selected end faces only
  const p=parseMaterialPattern({type:'patches',mode:'solid' as const,coverage:1,boundary:{space:'model',axes:'xz',strength:1,radius:.3,softness:0,center:[.4,0,-.2]}});
  expect(()=>sampleMaterialPattern(p,[0,0,0],{face:[0,0,0]})).toThrow('model coordinates');
  expect(sampleMaterialPattern(p,[0,0,0],{model:[.4,1,-.2]})).toBe(1);expect(sampleMaterialPattern(p,[0,0,0],{model:[0,1,0]})).toBe(0);
});
it('applies an explicit boundary mask after union gates and inversion',()=>{
  const r=parseMaterialPattern({type:'cells',coverage:1,invert:true,boundary:{strength:1},gates:[{operation:'union',pattern:{type:'patches',mode:'solid' as const,coverage:1}}]});
  expect(sampleMaterialPattern(r,[0,0,0],{face:[0,0,0]})).toBe(1);expect(sampleMaterialPattern(r,[0,0,0],{face:[1,1,0]})).toBe(0);
});
it('rejects malformed focus/variation parameters and does not share mutable defaults',()=>{
  for(const bad of [{shapeVariation:2},{sizeVariation:NaN},{concentration:{strength:2}},{concentration:{center:[0,0]}},{concentration:{radius:0}},{concentration:{axes:'yx'}},{concentration:{space:'world'}}])expect(()=>parseMaterialPattern({type:'patches',...bad})).toThrow();
  const a=parseMaterialPattern({type:'patches'}),b=parseMaterialPattern({type:'patches'});a.concentration.center[0]=.5;expect(b.concentration.center[0]).toBe(0);
});
it.each(MATERIAL_PATTERN_TYPES)('%s distribution uses whole-feature decisions without fading surviving interiors',type=>{
  const plain=parseMaterialPattern({type,sizeMeters:.1,coverage:.5,irregularity:0,placementRegularity:1,edgeSoftnessMeters:0}),focused=parseMaterialPattern({...plain,concentration:{strength:1,radius:.8}}),bounds={faceMeters:[2,2] as const};let survivors=0;
  for(let y=-5;y<5;y++)for(let x=-5;x<5;x++){
    const a=materialPatternFeatureAtCell(plain,[x,y,0],bounds),b=materialPatternFeatureAtCell(focused,[x,y,0],bounds);expect(b.center).toEqual(a.center);expect(b.sizeScale).toBe(a.sizeScale);
    if(!a.accepted||!b.accepted)continue;survivors++;const frame={...bounds,face:a.center};
    expect(sampleMaterialPattern(plain,a.center,frame)).toBe(1);expect(sampleMaterialPattern(focused,a.center,frame)).toBe(1);
  }expect(survivors).toBeGreaterThan(10);
});
it('clumping correlates nearby feature presence without changing their individual shape/size',()=>{
  const base=parseMaterialPattern({type:'clusters',sizeMeters:.05,placementRegularity:1}),grouped=parseMaterialPattern({...base,clumping:1,groupSizeMeters:.5});
  function correlation(r:typeof base){const present=new Set<string>();let pairs=0,occupied=0;
    for(let y=-20;y<20;y++)for(let x=-20;x<20;x++)if(materialPatternFeatureAtCell(r,[x,y,0]).accepted)present.add(x+','+y);
    for(let y=-20;y<19;y++)for(let x=-20;x<19;x++)if(present.has(x+','+y)){occupied++;if(present.has((x+1)+','+y))pairs++;}
    return pairs/occupied-present.size/1600;
  }
  expect(correlation(grouped)).toBeGreaterThan(correlation(base)+.08);
  const a=materialPatternFeatureAtCell(base,[3,4,0]),b=materialPatternFeatureAtCell(grouped,[3,4,0]);expect(a.center).toEqual(b.center);expect(a.sizeScale).toBe(b.sizeScale);
  expect(()=>parseMaterialPattern({type:'patches',clumping:2})).toThrow();expect(()=>parseMaterialPattern({type:'patches',groupSizeMeters:0})).toThrow();
});
it('keeps focused planar masks independent of source repeats and validates parser parity',async()=>{
  const recipe={kind:'texture' as const,version:1 as const,name:'Focused mask',resolution:32,layers:[{source:{kind:'solid' as const,color:'#000000'}},{source:{kind:'solid' as const,color:'#ffffff'},mask:{kind:'pattern' as const,pattern:{type:'patches',mode:'solid' as const,coverage:1,shapeVariation:.8,sizeVariation:.4,boundary:{strength:1,radius:.6}}}}]};
  expect(parseTextureRecipeData(recipe)).toEqual(textureRecipeSchema.parse(recipe));const a=await renderMaterialRecipe(recipe),b=await renderMaterialRecipe({...recipe,layers:[recipe.layers[0],{...recipe.layers[1],repeat:[4,4]}]});expect(a.color.data).toEqual(b.color.data);
  expect(a.color.data[(16*32+16)*4]).toBe(255);expect(a.color.data[0]).toBe(0);
});
it('combines bounded gates and rejects unbounded/ambiguous data',()=>{
  const p=parseMaterialPattern({type:'patches',mode:'solid' as const,coverage:1,gates:[{operation:'subtract',pattern:{type:'veins',mode:'solid' as const,coverage:1}}]});
  expect(sampleMaterialPattern(p,[.2,.3,.4])).toBe(0);
  expect(sampleMaterialPattern(parseMaterialPattern({type:'patches',coverage:0,invert:true}),[0,0,0])).toBe(1);
  for(const bad of [{type:'missing'},{type:'patches',sizeMeters:0},{type:'patches',coverage:NaN},{type:'veins',seed:.5},{type:'cells',gates:Array(4).fill({})},{type:'cells',gates:[{operation:'intersect',pattern:{type:'veins',gates:[]}}]}])expect(()=>parseMaterialPattern(bad)).toThrow();
});
it('uses continuous corner coverage independently of source repeats and semantic orientation',()=>{
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.iron),layer=r.layers[0];if(layer.coverage.kind==='pattern'){layer.coverage.pattern.concentration.space='model';layer.coverage.pattern.concentration.strength=0;}
  for(let v=0;v<=1;v+=.1){const a=boxSurfaceFrame(r.sizeMeters,'front').point(1,v),b=boxSurfaceFrame(r.sizeMeters,'right').point(0,v);expect(a).toEqual(b);expect(surfaceCoverage(r,layer,'front',a)).toBe(surfaceCoverage(r,layer,'right',b));}
  const point=boxSurfaceFrame(r.sizeMeters,'front').point(.37,.63),before=surfaceCoverage(r,layer,'front',point);layer.material.tileMeters=[.02,2];expect(surfaceCoverage(r,layer,'front',point)).toBe(before);
});
it('blends physical height and material responses with the same mask, including zero-opacity removal',async()=>{
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.gold);r.output.resolution=32;
  const a=await generateObjectSurface(r),clean=await generateObjectSurface({...r,layers:[]});expect(a.faces.front.color.data).not.toEqual(clean.faces.front.color.data);expect(a.faces.front.metalness.data).not.toEqual(clean.faces.front.metalness.data);expect(a.faces.front.normal.data).not.toEqual(clean.faces.front.normal.data);
  r.layers[0].opacity=0;expect((await generateObjectSurface(r)).faces.front.color.data).toEqual(clean.faces.front.color.data);
  const full=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.iron);if(full.layers[0].coverage.kind==='pattern'){full.layers[0].coverage.pattern.mode='solid';full.layers[0].coverage.pattern.coverage=1;full.layers[0].coverage.pattern.concentration.strength=0;}
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

it('feature density controls quantity independently of individual size',()=>{
 const frame={faceMeters:[4,4] as const};
 const r=parseMaterialPattern({type:'clusters',density:8,sizeMeters:.12});
 const a=inspectMaterialPatternDistribution(r,frame),b=inspectMaterialPatternDistribution({...r,density:64},frame);
 expect(a.complete&&b.complete).toBe(true);expect(b.count).toBeGreaterThan(a.count*5);
 expect(inspectMaterialPatternDistribution({...r,density:0},frame).count).toBe(0);
 expect(materialPatternFeaturesAtCell(r,[0,0,0],frame).map(f=>f.sizeScale)).toEqual(materialPatternFeaturesAtCell({...r,sizeMeters:.3},[0,0,0],frame).map(f=>f.sizeScale));
});
it('grouping births actual parent collections and group size changes their scale',()=>{
 const frame={faceMeters:[4,4] as const},r=parseMaterialPattern({type:'clusters',density:64,clumping:1,groupSizeMeters:.4});
 const small=inspectMaterialPatternDistribution(r,frame),large=inspectMaterialPatternDistribution({...r,groupSizeMeters:1.2},frame);
 expect(small.count).toBeGreaterThan(500);expect(large.count).toBeGreaterThan(500);expect(small.groups).toBeGreaterThan(large.groups*2);
 const features=Array.from({length:25},(_,i)=>materialPatternGroupedFeaturesAtCell(r,[i%5,Math.floor(i/5),0],frame)).flat();
 expect(features.length).toBeGreaterThan(20);expect(features.every(f=>f.proposal==='group'&&f.groupId&&f.sizeScale===1)).toBe(true);
 expect(inspectMaterialPatternDistribution(r,{faceMeters:[100,100]}).complete).toBe(false);
});

it.each(MATERIAL_PATTERN_TYPES)('%s irregularity changes contours independently of generation and opacity',type=>{
 const frame={faceMeters:[1,1] as const},base=parseMaterialPattern({type,irregularity:0,shapeVariation:0,sizeVariation:0,density:64,sizeMeters:.2,coverage:.6,edgeSoftnessMeters:0});
 const changed={...base,irregularity:1},a=createMaterialPatternSampler(base),b=createMaterialPatternSampler(changed);
 const points=Array.from({length:4096},(_,i)=>[(i%64)/63- .5,Math.floor(i/64)/63- .5,0] as const);
 const values=points.map(p=>a(p,{...frame,face:[p[0]*2,p[1]*2,0]})),other=points.map(p=>b(p,{...frame,face:[p[0]*2,p[1]*2,0]}));
 expect(other).not.toEqual(values);expect(other.every(v=>v===0||v===1)).toBe(true);
 expect(inspectMaterialPatternDistribution(changed,frame)).toEqual(inspectMaterialPatternDistribution(base,frame));
 for(let x=-2;x<2;x++)expect(materialPatternFeaturesAtCell(changed,[x,0,0],frame)).toEqual(materialPatternFeaturesAtCell(base,[x,0,0],frame));
 expect(other).toEqual(points.map(p=>sampleMaterialPattern(changed,p,{...frame,face:[p[0]*2,p[1]*2,0]})));
});
