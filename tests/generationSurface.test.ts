import {describe,it,expect} from 'vitest';
import {objectSurfaceSchema,objectSurfaceDocumentSchema,resolveObjectSurfaceDocument,sampleObjectSurface,generateObjectSurface,inspectObjectSurfaceGeneration,type ObjectSurfaceRecipe} from '../src/shared/objectSurface.ts';
import {materialGeneratorSchema} from '../src/shared/materialGenerator.ts';
import {replaceMaterialRecipes} from '../src/shared/materialRegistry.ts';
import type {GenerationMapRecipe} from '../src/shared/generationMaps.ts';
const graph:GenerationMapRecipe={kind:'generation-maps',version:1,seed:42,maps:{exposure:{type:'gradient',space:'object',axis:'x',from:-2,to:2}}};
const wall:ObjectSurfaceRecipe={kind:'object-surface',version:2,name:'Castle wall',sizeMeters:[4,2,.2],base:{pattern:{family:'plaster',cracks:0},roughness:.4,variation:0},generation:{graph,bindings:[{id:'weathered-side',target:'base.roughness',map:'exposure',range:[.2,.9]}]}};
describe('generation maps on object surfaces',()=>{
 it('varies a physical material parameter across model metres independently of source UV tiling',()=>{
  const r=objectSurfaceSchema.parse(wall),left=sampleObjectSurface(r,'front',.05,.5),right=sampleObjectSurface(r,'front',.95,.5);expect(right.roughness-left.roughness).toBeGreaterThan(.5);expect(r.base.roughness).toBe(.4);
  const tiled=objectSurfaceSchema.parse({...wall,base:{...wall.base,tileMeters:[.13,.27]}});expect(sampleObjectSurface(tiled,'front',.05,.5).roughness).toBe(left.roughness);
  expect(sampleObjectSurface(r,'right',0,.5).roughness).toBe(sampleObjectSurface(r,'front',1,.5).roughness);
  expect(inspectObjectSurfaceGeneration(r,'front',.95,.5)?.values['base.roughness']).toBeCloseTo(.865);
 });
 it('binds stable layer opacity without changing leaf count semantics or mutating base material data',()=>{
  const r=objectSurfaceSchema.parse({...wall,base:{pattern:{family:'plaster',cracks:0},roughness:.2,variation:0},layers:[{id:'weathering',material:{pattern:{family:'plaster',cracks:0},roughness:.9,variation:0},coverage:{pattern:{type:'patches',mode:'solid'}}}],generation:{graph,bindings:[{id:'weathering-mask',target:'layer:weathering.opacity',map:'exposure',range:[0,1]}]}});
  const a=sampleObjectSurface(r,'front',0,.5),b=sampleObjectSurface(r,'front',1,.5);expect(a.roughness).toBeCloseTo(.2);expect(b.roughness).toBeCloseTo(.9);expect(a.opacity).toBe(1);expect(b.opacity).toBe(1);expect(r.layers[0].opacity).toBe(1);
 });
 it('rejects missing frames, runtime inputs, entity randomness, incompatible units and conflicting targets before baking',()=>{
  const invalidGraphs:GenerationMapRecipe[]=[{...graph,maps:{exposure:{type:'gradient',space:'world',axis:'x',from:-2,to:2}}},{...graph,maps:{exposure:{type:'time',periodSeconds:2}}},{...graph,maps:{exposure:{type:'random',scope:'object'}}},{...graph,maps:{exposure:{type:'constant',unit:'metres',value:.5}}}];
  for(const graph of invalidGraphs)expect(()=>objectSurfaceSchema.parse({...wall,generation:{graph,bindings:wall.generation!.bindings}})).toThrow();
  expect(()=>objectSurfaceSchema.parse({...wall,generation:{graph,bindings:[...wall.generation!.bindings,{...wall.generation!.bindings[0],id:'duplicate'}]}})).toThrow(/multiple writes/);
  expect(()=>objectSurfaceSchema.parse({...wall,generation:{graph,bindings:[{...wall.generation!.bindings[0],target:'layer:missing.opacity'}]}})).toThrow(/unknown target/);
  expect(()=>objectSurfaceSchema.parse({...wall,generation:{graph,bindings:[{...wall.generation!.bindings[0],range:[0,2]}]}})).toThrow(/bounds/);
 });
 it('supports surface-local metre fields, explicit masks and safe multiplicative ranges',()=>{
  const g:GenerationMapRecipe={...graph,maps:{...graph.maps,face:{type:'gradient',space:'surface',axis:'x',from:0,to:4},half:{type:'constant',value:.5,unit:'normalized'}}},r=objectSurfaceSchema.parse({...wall,generation:{graph:g,bindings:[{id:'masked-roughness',target:'base.roughness',map:'face',mask:'half',range:[1,2],operation:'multiply'}]}});
  expect(sampleObjectSurface(r,'front',0,.5).roughness).toBeCloseTo(.4);expect(sampleObjectSurface(r,'front',1,.5).roughness).toBeCloseTo(.6);
  expect(()=>objectSurfaceSchema.parse({...wall,generation:{graph:g,bindings:[{id:'too-much',target:'base.roughness',map:'face',range:[1,4],operation:'multiply'}]}})).toThrow(/multiplier/);
 });
 it('resolves named materials before checking their parameter-specific multiplier limits',()=>{
  replaceMaterialRecipes({'wall.stone':materialGeneratorSchema.parse({pattern:{family:'plaster',cracks:0},roughness:.2,variation:0})});
  try{const doc={...wall,base:{ref:'wall.stone'},generation:{graph,bindings:[{id:'roughness',target:'base.roughness',map:'exposure',range:[1,2] as [number,number],operation:'multiply' as const}]}};expect(()=>objectSurfaceDocumentSchema.parse(doc)).not.toThrow();const r=resolveObjectSurfaceDocument(doc);expect(sampleObjectSurface(r,'front',1,.5).roughness).toBeCloseTo(.4);}finally{replaceMaterialRecipes({});}
 });
 it('bakes repeatable directionally different maps and caps the total map evaluation work before pixel allocation',async()=>{
  const a=await generateObjectSurface(wall,{resolution:32}),b=await generateObjectSurface(wall,{resolution:32});expect(a.faces.front.roughness.data).toEqual(b.faces.front.roughness.data);expect(new Set(a.faces.front.roughness.data).size).toBeGreaterThan(4);
  const costly:GenerationMapRecipe={...graph,maps:{exposure:{type:'noise',space:'object',scaleMeters:.2,octaves:8}}};await expect(generateObjectSurface({...wall,sizeMeters:[1,1,1],generation:{graph:costly,bindings:wall.generation!.bindings}},{resolution:512})).rejects.toThrow(/binding budget/);
 });
});
