import {describe,it,expect} from 'vitest';
import {compileGenerationMaps,generationDataRevision,generationIdentitySeed,GenerationMapError,GENERATION_MAP_LIMITS,type GenerationMapNode,type GenerationMapRecipe} from '../src/shared/generationMaps.ts';
const recipe=(maps:Record<string,GenerationMapNode>,seed=42):GenerationMapRecipe=>({kind:'generation-maps',version:1,seed,maps});
const normalized=(value:number):GenerationMapNode=>({type:'constant',value,unit:'normalized'});
const world={world:[-12.5,3,78] as const};
describe('generation map contracts and composition',()=>{
 it('mixes normalized maps, reports bounded output and explains the reachable value chain',()=>{
  const maps=compileGenerationMaps(recipe({left:normalized(.2),right:normalized(.8),blend:{type:'mix',inputs:[{map:'left',weight:1},{map:'right',weight:3}]},unused:{type:'random',scope:'part'}}));
  expect(maps.sample('blend')).toBeCloseTo(.65,15);expect(maps.output('blend')).toMatchObject({unit:'normalized',range:[.6500000000000001,.6500000000000001],dynamic:false,cost:3,spaces:[],scopes:[]});
  const inspection=maps.inspect('blend');expect(inspection.trace.map(t=>t.mapId)).toEqual(['left','right','blend']);expect(inspection.value).toBe(maps.sample('blend'));expect(JSON.parse(JSON.stringify(inspection))).toHaveProperty('revision',maps.revision);
 });
 it('adds physical layers, multiplies by dimensionless masks and preserves declared units',()=>{
  const maps=compileGenerationMaps(recipe({height:{type:'constant',value:80,unit:'metres'},mask:normalized(.25),local:{type:'constant',value:2,unit:'metres'},masked:{type:'multiply',inputs:['height','mask']},total:{type:'add',inputs:[{map:'masked'},{map:'local',weight:-2}]}}));
  expect(maps.sample('total')).toBe(16);expect(maps.output('total')).toMatchObject({unit:'metres',range:[16,16]});
 });
 it('requires explicit unit conversion and rejects unsupported compound units',()=>{
  expect(()=>compileGenerationMaps(recipe({n:normalized(.5),h:{type:'constant',value:1,unit:'metres'},bad:{type:'add',inputs:[{map:'n'},{map:'h'}]}}))).toThrow(/units/);
  expect(()=>compileGenerationMaps(recipe({h:{type:'constant',value:1,unit:'metres'},angle:{type:'constant',value:1,unit:'radians'},bad:{type:'multiply',inputs:['h','angle']}}))).toThrow(/physical-unit/);
  expect(()=>compileGenerationMaps(recipe({n:normalized(.5),bad:{type:'remap',input:'n',from:[0,1],to:[10,20]}}))).toThrow(/unit/);
  expect(()=>compileGenerationMaps(recipe({n:normalized(.5),bad:{type:'clamp',input:'n',range:[2,3]}}))).toThrow(/normalized/);
 });
 it('supports descending ranges and distinguishes clamped and extrapolated remaps',()=>{
  const maps=compileGenerationMaps(recipe({n:{type:'constant',value:2},clamped:{type:'remap',input:'n',from:[1,0],to:[10,20],unit:'metres'},extended:{type:'remap',input:'n',from:[1,0],to:[10,20],unit:'metres',clamp:false},limited:{type:'clamp',input:'extended',range:[3,6]}}));
  expect(maps.sample('clamped')).toBe(10);expect(maps.sample('extended')).toBe(0);expect(maps.sample('limited')).toBe(3);expect(maps.output('limited').unit).toBe('metres');
 });
 it('requires an explicit zero-weight fallback, and disallows negative mix weights',()=>{
  expect(()=>compileGenerationMaps(recipe({n:normalized(.2),mix:{type:'mix',inputs:[{map:'n',weight:0}]}}))).toThrow(/fallback/);
  const maps=compileGenerationMaps(recipe({n:normalized(.2),mix:{type:'mix',inputs:[{map:'n',weight:0}],fallback:.7}}));expect(maps.sample('mix')).toBe(.7);expect(maps.output('mix').unit).toBe('normalized');
  expect(()=>compileGenerationMaps(recipe({n:normalized(.2),mix:{type:'mix',inputs:[{map:'n',weight:-1}]}}))).toThrow(/weight/);
 });
 it('counts shared dependencies once per sample plan, including octave work',()=>{
  const maps:Record<string,GenerationMapNode>={noise:{type:'noise',space:'world',scaleMeters:3,octaves:8}};for(let i=0;i<16;i++)maps['copy'+i]={type:'remap',input:'noise',from:[0,1],to:[0,1]};maps.sum={type:'mix',inputs:Array.from({length:16},(_,i)=>({map:'copy'+i}))};
  const m=compileGenerationMaps(recipe(maps));expect(m.output('sum').cost).toBe(81);expect(m.inspect('sum',world).trace).toHaveLength(18);
 });
});
describe('identity, spaces and time',()=>{
 it('separates cache revisions from stable object and part random identities',()=>{
  const source={tree:{type:'random',scope:'object',channel:'shape'},branch:{type:'random',scope:'part',channel:'pitch'},bark:normalized(.3)} satisfies Record<string,GenerationMapNode>,a=compileGenerationMaps(recipe(source)),reordered=compileGenerationMaps(recipe({bark:source.bark,branch:source.branch,tree:source.tree})),edited=compileGenerationMaps(recipe({...source,bark:normalized(.9)})),ctx={objectId:'tree:34,-12',partId:'trunk/east/3'};
  expect(a.revision).toBe(reordered.revision);expect(a.revision).not.toBe(edited.revision);for(const id of ['tree','branch']){expect(a.sample(id,ctx)).toBe(reordered.sample(id,ctx));expect(a.sample(id,ctx)).toBe(edited.sample(id,ctx));}
  expect(a.sample('branch',ctx)).not.toBe(a.sample('branch',{...ctx,partId:'trunk/east/4'}));expect(a.sample('tree',ctx)).toBe(a.sample('tree',{...ctx,partId:'other'}));expect(a.sample('tree',ctx)).not.toBe(a.sample('tree',{...ctx,objectId:'other'}));
 });
 it('never depends on sample order, chunk origins, cache state or world rebasing',()=>{
  const r=recipe({macro:{type:'noise',space:'world',scaleMeters:64,octaves:4},ridge:{type:'noise',space:'world',scaleMeters:17,octaves:3,ridged:true}}),a=compileGenerationMaps(r),b=compileGenerationMaps(r),points=[[-64,0,-32],[-32,4,0],[0,0,0],[32,0,64],[64,8,-64]] as const,expected=points.map(p=>a.sample('macro',{world:p}));
  for(let i=points.length-1;i>=0;i--)expect(b.sample('macro',{world:points[i]})).toBe(expected[i]);for(const [i,p]of points.entries()){const renderOrigin=[1000,0,-1000],renderLocal=p.map((v,j)=>v-renderOrigin[j]),absolute=renderLocal.map((v,j)=>v+renderOrigin[j]) as [number,number,number];expect(b.sample('macro',{world:absolute})).toBe(expected[i]);}
  expect(a.sample('ridge',{world:[-32.000001,0,0]})).toBeCloseTo(a.sample('ridge',{world:[-31.999999,0,0]}),6);
 });
 it('requires explicit coordinate frames and semantic identities',()=>{
  const maps=compileGenerationMaps(recipe({object:{type:'noise',space:'object',scaleMeters:1},surface:{type:'gradient',space:'surface',axis:'x',from:-1,to:1},random:{type:'random',scope:'part'}}));
  expect(()=>maps.sample('object',world)).toThrow(/object coordinates/);expect(()=>maps.sample('surface',world)).toThrow(/surface coordinates/);expect(()=>maps.sample('random',{objectId:'tree'})).toThrow(/partId/);expect(()=>maps.sample('random',{partId:'branch'})).toThrow(/objectId/);
  expect(maps.sample('object',{...world,object:[.2,.3,.4]})).toBe(maps.sample('object',{world:[999,999,999],object:[.2,.3,.4]}));expect(maps.sample('surface',{surface:[0,999,0]})).toBe(.5);expect(maps.output('random').scopes).toEqual(['part']);
 });
 it('propagates reachable domain, scope and dynamic requirements',()=>{
  const m=compileGenerationMaps(recipe({a:{type:'noise',space:'world',scaleMeters:2},b:{type:'noise',space:'object',scaleMeters:2},c:{type:'random',scope:'object'},time:{type:'time',periodSeconds:4},mixed:{type:'mix',inputs:[{map:'a'},{map:'b'},{map:'c'},{map:'time'}]},static:normalized(.1)}));
  expect(m.output('mixed')).toMatchObject({spaces:['object','world'],scopes:['object'],dynamic:true});expect(m.output('static')).toMatchObject({spaces:[],scopes:[],dynamic:false});expect(m.sample('static')).toBe(.1);
  expect(()=>m.sample('time')).toThrow(/timeSeconds/);expect(m.sample('time',{timeSeconds:0})).toBe(.5);expect(m.sample('time',{timeSeconds:1})).toBe(1);expect(m.sample('time',{timeSeconds:4})).toBeCloseTo(.5,15);
 });
 it('supports directional and radial masks with bounded normalized values',()=>{
  const m=compileGenerationMaps(recipe({gradient:{type:'gradient',space:'object',axis:'x',from:2,to:-2},radial:{type:'distance',space:'world',center:[1,2,3],radiusMeters:5}}));
  expect(m.sample('gradient',{object:[2,0,0]})).toBe(0);expect(m.sample('gradient',{object:[-2,0,0]})).toBe(1);expect(m.sample('radial',{world:[1,2,3]})).toBe(1);expect(m.sample('radial',{world:[6,2,3]})).toBe(0);expect(m.sample('radial',{world:[3.5,2,3]})).toBe(.5);
 });
});
describe('serialization and bounded compilation',()=>{
 it('clones and deeply freezes recipes and metadata without freezing the caller',()=>{
  const r=recipe({a:normalized(.2),b:{type:'mix',inputs:[{map:'a'}]}}),m=compileGenerationMaps(r);(r.maps.a as {value:number}).value=.9;expect(m.sample('b')).toBe(.2);expect(Object.isFrozen(r)).toBe(false);expect(Object.isFrozen(m.recipe)).toBe(true);expect(Object.isFrozen(m.recipe.maps)).toBe(true);expect(Object.isFrozen(m.output('b').range)).toBe(true);expect(Object.isFrozen(m.output('b').spaces)).toBe(true);expect(()=>{(m.recipe.maps.a as {value:number}).value=.8;}).toThrow();
 });
 it('rejects cycles and missing references with useful map IDs',()=>{
  try{compileGenerationMaps(recipe({a:{type:'clamp',input:'b',range:[0,1]},b:{type:'clamp',input:'a',range:[0,1]}}));throw Error('expected rejection');}catch(error){expect(error).toBeInstanceOf(GenerationMapError);expect(error).toMatchObject({code:'cycle',mapId:'a'});}
  expect(()=>compileGenerationMaps(recipe({a:{type:'multiply',inputs:['missing']}}))).toThrow(/missing/);expect(()=>compileGenerationMaps(recipe({a:normalized(.1)})).output('missing')).toThrow(/missing/);
 });
 it('accepts depth 16 and rejects deeper graphs and excessive maps/inputs',()=>{
  const maps:Record<string,GenerationMapNode>={a0:normalized(.2)};for(let i=1;i<16;i++)maps['a'+i]={type:'clamp',input:'a'+(i-1),range:[0,1]};expect(compileGenerationMaps(recipe(maps)).sample('a15')).toBe(.2);maps.a16={type:'clamp',input:'a15',range:[0,1]};expect(()=>compileGenerationMaps(recipe(maps))).toThrow(/depth/);
  expect(()=>compileGenerationMaps(recipe(Object.fromEntries(Array.from({length:65},(_,i)=>['a'+i,normalized(.2)]))))).toThrow(/1–64/);expect(()=>compileGenerationMaps(recipe({a:normalized(.1),b:{type:'multiply',inputs:Array(17).fill('a')}}))).toThrow(/1–16/);expect(GENERATION_MAP_LIMITS.cost).toBe(4096);
 });
 it('rejects unknown fields, invalid ranges, nonfinite values and hostile prototypes',()=>{
  for(const value of [{kind:'generation-maps',version:2,seed:1,maps:{a:normalized(.1)}},recipe({a:{type:'constant',value:NaN}}),recipe({a:{type:'constant',value:2,unit:'normalized'}}),recipe({a:{type:'gradient',space:'world',axis:'x',from:1,to:1}}),recipe({a:{type:'noise',space:'world',scaleMeters:0}}),recipe({a:{type:'noise',space:'world',scaleMeters:1,octaves:9}}),{...recipe({a:normalized(.1)}),extra:true}])expect(()=>compileGenerationMaps(value)).toThrow();
  expect(()=>compileGenerationMaps(recipe({a:Object.assign(Object.create({evil:true}),{type:'constant',value:1})}))).toThrow(/plain/);const m=compileGenerationMaps(recipe({a:normalized(.1)}));expect(()=>m.sample('a',{world:[0,NaN,0]})).toThrow();
 });
 it('rejects sparse arrays, accessors and executable recipe data without invoking getters',()=>{
  const sparse=Array(2);sparse[1]='a';expect(()=>compileGenerationMaps(recipe({a:normalized(.1),bad:{type:'multiply',inputs:sparse}}))).toThrow(/dense|sparse/);let invoked=0;const node={type:'constant',get value(){invoked++;return 1;}};expect(()=>compileGenerationMaps(recipe({a:node as GenerationMapNode}))).toThrow(/accessor/);expect(invoked).toBe(0);
  expect(()=>compileGenerationMaps(recipe({a:{type:'constant',value:(()=>1) as unknown as number}}))).toThrow();
 });
 it('rejects output explosion before evaluation',()=>{
  const maps:Record<string,GenerationMapNode>={a:{type:'constant',value:1e9},b:{type:'multiply',inputs:['a','a']}};expect(()=>compileGenerationMaps(recipe(maps))).toThrow(/range/);
 });
});

it('derives stable signed identity seeds without coupling objects or channels',()=>{const a=generationIdentitySeed(42,'tree/93','geometry');expect(a).toBe(generationIdentitySeed(42,'tree/93','geometry'));expect(a).not.toBe(generationIdentitySeed(42,'tree/94','geometry'));expect(a).not.toBe(generationIdentitySeed(42,'tree/93','bark'));expect(Number.isInteger(a)).toBe(true);expect(a).toBeGreaterThanOrEqual(-2147483648);expect(a).toBeLessThanOrEqual(2147483647);expect(()=>generationIdentitySeed(1.5,'id','geometry')).toThrow();});

it('fingerprints bounded plain recipe data independently of property order and identity seed caps',()=>{const data={name:undefined,recipe:{materials:{bark:'x'.repeat(1000)},size:[1,2,3]}};expect(generationDataRevision(data)).toBe(generationDataRevision({recipe:{size:[1,2,3],materials:{bark:'x'.repeat(1000)}}}));expect(generationDataRevision({...data,recipe:{...data.recipe,size:[1,2,4]}})).not.toBe(generationDataRevision(data));expect(()=>generationDataRevision({bad:Infinity})).toThrow();expect(()=>generationDataRevision({large:'x'.repeat(1048577)})).toThrow(/budget/);const cycle:{self?:unknown}={};cycle.self=cycle;expect(()=>generationDataRevision(cycle)).toThrow(/cyclic/);expect(()=>generationDataRevision([undefined])).toThrow();});

it('rejects invalid discriminators without invoking coercion callbacks',()=>{let coercions=0;const hostile={toString(){coercions++;throw Error('coercion executed');},valueOf(){coercions++;throw Error('coercion executed');},[Symbol.toPrimitive](){coercions++;throw Error('coercion executed');}};for(const node of [{type:hostile},{type:'gradient',space:'world',axis:hostile,from:0,to:1},{type:'random',scope:hostile}]){expect(()=>compileGenerationMaps(recipe({a:node as unknown as GenerationMapNode}))).toThrow(GenerationMapError);expect(coercions).toBe(0);}const m=compileGenerationMaps(recipe({a:normalized(.2)}));expect(()=>m.sample(hostile as unknown as string)).toThrow(GenerationMapError);expect(coercions).toBe(0);});
it('keeps algorithm-version noise samples exact with precompiled octave seeds',()=>{const m=compileGenerationMaps(recipe({noise:{type:'noise',space:'world',scaleMeters:17,octaves:5},ridge:{type:'noise',space:'world',scaleMeters:17,octaves:5,ridged:true}})),points=[[-32.25,2,7],[0,0,0],[192.5,-3,-64.125]] as const;expect(points.map(world=>[m.sample('noise',{world}),m.sample('ridge',{world})])).toEqual([[.6658734983398237,.8028797038000097],[.47796336140093065,.45008016298074394],[.39054538540849815,.8490398208776848]]);});
