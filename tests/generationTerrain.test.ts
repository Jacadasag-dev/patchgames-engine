import {expect,it} from 'vitest';
import {compileGenerationMaps,type GenerationMapRecipe} from '../src/shared/generationMaps.ts';
import {TerrainCompiler,compileTerrain,compileTerrainChunk,createTerrainBaseHeightSampler,createTerrainHeightSampler,sampleTerrain,terrainRecipeRevision,type TerrainRecipe} from '../src/sandbox/terrain.ts';
import {terrainEditDependencies} from '../src/sandbox/terrainDependencies.ts';
const graph:GenerationMapRecipe={kind:'generation-maps',version:1,seed:127,maps:{
 broad:{type:'noise',space:'world',scaleMeters:80,octaves:2,ridged:true},
 mountain:{type:'remap',input:'broad',from:[0,1],to:[-4,18],unit:'metres'},
 detail:{type:'noise',space:'world',scaleMeters:11,octaves:3},
 hills:{type:'remap',input:'detail',from:[0,1],to:[-2,2],unit:'metres'},
 plains:{type:'gradient',space:'world',axis:'x',from:-32,to:32},
}};
const recipe=():TerrainRecipe=>({version:1,seed:87,bounds:{width:128,depth:128,cells:32},base:{height:2,maps:{graph:structuredClone(graph),layers:[{id:'mountain-range',map:'mountain',weight:.6},{id:'plain-hills',map:'hills',mask:'plains'}]}},assets:[],regions:[]});
it('composes metre layers and normalized masks before legacy regional elevation',()=>{
 const r=recipe();r.base!.noise={amplitude:.25,wavelength:31,octaves:2};r.regions=[{id:'plateau',mask:{kind:'circle',radius:30,center:{x:0,z:0}},elevation:3,blend:4,layers:[]}];
 const baseline=structuredClone(r);delete baseline.base!.maps;
 const expected=createTerrainBaseHeightSampler(baseline),sample=createTerrainBaseHeightSampler(r),maps=compileGenerationMaps(graph);
 for(const [x,z]of [[0,0],[-29,-11],[15,-28],[42,40]]){const c={world:[x,0,z] as const};expect(sample(x,z)).toBeCloseTo(expected(x,z)+maps.sample('mountain',c)*.6+maps.sample('hills',c)*maps.sample('plains',c),12);}
 const old=sample(0,0);r.base!.maps!.layers[0].weight=0;r.base!.maps!.graph.seed=9;expect(sample(0,0)).toBe(old);expect(createTerrainBaseHeightSampler(r)(0,0)).not.toBe(old);
});
it('samples absolute world coordinates across negative chunk boundaries independent of load order',()=>{
 const r=recipe(),a=compileTerrainChunk(r,{x:-1,z:-1,size:32,cells:8}),b=compileTerrainChunk(r,{x:0,z:-1,size:32,cells:8}),repeat=compileTerrainChunk(r,{x:-1,z:-1,size:32,cells:8}),sample=createTerrainBaseHeightSampler(r);
 expect(a.diagnostics.valid).toBe(true);expect(b.diagnostics.valid).toBe(true);expect(repeat.heights).toEqual(a.heights);
 for(let row=0;row<=8;row++){const z=-32+row*4;expect(a.heights[8*9+row]).toBe(b.heights[row]);expect(a.heights[8*9+row]).toBe(Math.fround(sample(0,z)));}
 const full=compileTerrain(r);expect(full.diagnostics.valid).toBe(true);for(const [x,z]of [[-32,-32],[0,-16],[16,0]])expect(sampleTerrain(full,x,z).height).toBeCloseTo(sample(x,z),5);
});
it('keeps foundations and analytic final-height queries on the same mapped pre-foundation terrain',()=>{
 const r=recipe();r.assets=[{id:'house',footprint:{kind:'box',width:4,depth:4}}];r.placements=[{id:'lot',asset:'house',position:{x:-12,z:4},foundation:{blend:4,maxCutFill:20}}];
 const base=createTerrainBaseHeightSampler(r),final=createTerrainHeightSampler(r),m=compileTerrain(r);expect(m.diagnostics.valid).toBe(true);expect(final(-12,4)).toBe(Math.fround(base(-12,4)));expect(m.instances[0].position.y).toBeCloseTo(base(-12,4),5);
});
it('zero-weight layers are neutral and non-elevation edits never reroll the accepted heightfield',()=>{
 const a=recipe();a.base!.maps!.layers[0].weight=0;const b=structuredClone(a);b.base!.maps!.layers=b.base!.maps!.layers.filter(l=>l.id!=='mountain-range');expect(compileTerrain(a).heights).toEqual(compileTerrain(b).heights);
 const before=recipe();before.assets=[{id:'tree',footprint:{kind:'circle',radius:.5},appearance:{kind:'tree',color:'#336633'}}];before.placements=[{id:'tree-one',asset:'tree',position:{x:0,z:0}}];
 const after=structuredClone(before);after.assets[0].appearance!.color='#668844';after.base!.maps!.graph.maps.unused={type:'constant',value:11,unit:'metres'};const x=compileTerrain(before),y=compileTerrain(after);expect(y.heights).toEqual(x.heights);expect(y.instances).toEqual(x.instances);
 const change=structuredClone(before);change.base!.maps!.layers[0].weight=.3;expect(terrainRecipeRevision(change)).not.toBe(terrainRecipeRevision(before));expect(terrainEditDependencies(before,change,4).fullRebuild).toBe(true);
});
it('rejects dynamic, object-domain, incompatible-unit and over-budget map layers before geometry',()=>{
 const invalid:unknown[]=[
  {layers:[{id:'raw',map:'broad'}]},
  {graph:{...graph,maps:{t:{type:'time',periodSeconds:2},height:{type:'remap',input:'t',from:[0,1],to:[0,1],unit:'metres'}}},layers:[{id:'dynamic',map:'height'}]},
  {graph:{...graph,maps:{t:{type:'noise',space:'object',scaleMeters:2},height:{type:'remap',input:'t',from:[0,1],to:[0,1],unit:'metres'}}},layers:[{id:'object-space',map:'height'}]},
  {layers:[{id:'bad-mask',map:'mountain',mask:'hills'}]},
  {layers:[{id:'bad-weight',map:'mountain',weight:11}]},
  {layers:[{id:'duplicate',map:'mountain'},{id:'duplicate',map:'hills'}]},
  {graph:{...graph,maps:{high:{type:'constant',value:9000,unit:'metres'}}},layers:[{id:'reach',map:'high',weight:2}]},
  {layers:[{id:'unknown',map:'missing'}]},
  {layers:Array.from({length:9},(_,i)=>({id:'layer-'+i,map:'hills'}))},
 ];
 for(const extra of invalid){const r=recipe();r.base!.maps={...r.base!.maps!,...extra as object} as any;const m=compileTerrain(r);expect(m.diagnostics.valid).toBe(false);expect(m.diagnostics.issues.some(i=>i.code==='elevation-maps')).toBe(true);expect(m.heights.every(h=>h===0)).toBe(true);expect(()=>createTerrainBaseHeightSampler(r)).toThrow();}
});

it('eager exact-count scatter returns four valid placements with stable choices and an actionable underfill',()=>{
 const r:TerrainRecipe={version:1,seed:12,bounds:{width:32,depth:32,cells:8},assets:[{id:'tree',footprint:{kind:'circle',radius:1}}],regions:[{id:'grove',mask:{kind:'box',width:32,depth:32,center:{x:0,z:0}},layers:[{id:'four-trees',assets:['tree'],spacing:5,density:1,count:4,scale:[.85,1.15]}]}]};
 const a=compileTerrain(r),b=compileTerrain(structuredClone(r));expect(a.diagnostics.valid).toBe(true);expect(a.instances).toHaveLength(4);expect(b.instances).toEqual(a.instances);
 for(let i=0;i<a.instances.length;i++)for(let j=i+1;j<a.instances.length;j++){const x=a.instances[i],y=a.instances[j];expect(Math.hypot(x.position.x-y.position.x,x.position.z-y.position.z)).toBeGreaterThan(x.scale+y.scale);}
 const sparse=structuredClone(r);sparse.regions[0].layers[0].density=0;const failed=compileTerrain(sparse);expect(failed.diagnostics.valid).toBe(false);expect(failed.instances).toHaveLength(0);expect(failed.diagnostics.issues).toContainEqual(expect.objectContaining({code:'exact-count-underfill',ids:['grove','four-trees'],message:expect.stringContaining('Requested 4 instances but accepted 0')}));
 const off=structuredClone(r);off.regions[0].layers[0].count=0;const none=compileTerrain(off);expect(none.diagnostics.valid).toBe(true);expect(none.instances).toHaveLength(0);expect(none.diagnostics.counts.candidates).toBe(0);
});
it('rejects ambiguous streamed quotas and invalid exact counts before generating placements',()=>{
 const r:TerrainRecipe={version:1,seed:12,bounds:{width:256,depth:256,cells:8},assets:[{id:'tree',footprint:{kind:'circle',radius:.5}}],regions:[{id:'grove',mask:{kind:'box',width:256,depth:256,center:{x:0,z:0}},layers:[{id:'trees',assets:['tree'],spacing:16,density:1,count:4}]}]};
 expect(compileTerrain(r).diagnostics.issues.some(i=>i.code==='scatter-count-streaming')).toBe(true);expect(compileTerrainChunk({...r,streaming:false},{x:0,z:0,size:32,cells:4}).diagnostics.issues.some(i=>i.code==='scatter-count-streaming')).toBe(true);
 const eager=compileTerrain({...r,streaming:false});expect(eager.diagnostics.valid).toBe(true);expect(eager.instances).toHaveLength(4);
 r.streaming=false;r.regions[0].layers[0].count=257;expect(compileTerrain(r).diagnostics.issues.some(i=>i.code==='scatter-count')).toBe(true);
});

it('prunes unreachable maps for geometry revisions while retaining and validating the full edited source',()=>{
 const before=recipe();before.base!.maps!.graph.maps.bark={type:'constant',value:.3,unit:'normalized'};const after=structuredClone(before);after.base!.maps!.graph.maps.bark={type:'constant',value:.7,unit:'normalized'};
 expect(terrainRecipeRevision(after)).toBe(terrainRecipeRevision(before));expect(terrainEditDependencies(before,after,4)).toEqual({fullRebuild:false,bounds:[]});
 const compiler=new TerrainCompiler(),a=compiler.compile(before),b=compiler.compile(after);expect(b).not.toBe(a);expect(b.revision).toBe(a.revision);expect(b.heights).toBe(a.heights);expect(b.instances).toBe(a.instances);expect(b.changes.surfaceChanged).toBe(false);expect(b.recipe.base!.maps!.graph.maps.bark).toHaveProperty('value',.7);
 const invalid=structuredClone(after);invalid.base!.maps!.graph.maps.bark={type:'constant',value:NaN,unit:'normalized'};expect(compiler.compile(invalid).diagnostics.valid).toBe(false);expect(compiler.compile(after)).toBe(b);
 const height=structuredClone(after);height.base!.maps!.graph.maps.detail={type:'noise',space:'world',scaleMeters:8};expect(terrainRecipeRevision(height)).not.toBe(b.revision);expect(terrainEditDependencies(after,height,4).fullRebuild).toBe(true);expect(compiler.compile(height).heights).not.toBe(b.heights);
});
