import {it,expect} from 'vitest';
import {generateObjectSurface,objectSurfaceSchema,OBJECT_SURFACE_EXAMPLES,BOX_SURFACES,boxSurfaceFrame,surfaceCoverage,slashCoverage,sampleObjectSurface,resolveSurfaceName} from '../src/shared/objectSurface.ts';
import {ObjectSurfaceView,createObjectSurfaceView} from '../src/sandbox/objectSurface.ts';
import {replaceMaterialRecipes} from '../src/shared/materialRegistry.ts';
import {materialGeneratorSchema} from '../src/shared/materialGenerator.ts';
import {materialPatternBoundaryWeight} from '../src/shared/materialPatterns.ts';
import {DataTexture} from 'three';

it('samples grass in two dimensions on every vertical face instead of extruding a top-down row',()=>{
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.grass);
  r.output.style='realistic';r.layers[0].coverage.band={from:'top',space:'model',depthMeters:0.8,variation:0,featherMeters:0};
  for(const face of ['front','back','left','right'] as const){
    const rows=Array.from({length:12},(_,i)=>sampleObjectSurface(r,face,0.37,0.3+i*0.05).color.join(','));
    expect(new Set(rows).size).toBeGreaterThan(1);
  }
});

it('assigns grass to the top, dirt to the bottom and continuous fringe coverage at side corners',()=>{
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.grass),layer=r.layers[0];
  expect(surfaceCoverage(r,layer,'top',[0,0.5,0])).toBe(1);expect(surfaceCoverage(r,layer,'bottom',[0,-0.5,0])).toBe(0);
  for(let v=0;v<=1;v+=0.05){const a=boxSurfaceFrame(r.sizeMeters,'right').point(0,v),b=boxSurfaceFrame(r.sizeMeters,'front').point(1,v);expect(a).toEqual(b);expect(surfaceCoverage(r,layer,'right',a)).toBe(surfaceCoverage(r,layer,'front',b));}
});
it('references shared materials and follows live changes without replacing the object',async()=>{
  const material=(color:string)=>materialGeneratorSchema.parse({pattern:{family:'plaster'},color,secondaryColor:color,output:{resolution:32}});
  replaceMaterialRecipes({'test.soil':material('#ff0000')});
  const view=await createObjectSurfaceView({...OBJECT_SURFACE_EXAMPLES.grass,base:{ref:'test.soil'},layers:[]},{resolution:16}),mesh=view.root;
  try{
    replaceMaterialRecipes({'test.soil':material('#00ff00')});await view.ready;
    expect(view.root).toBe(mesh);expect((mesh.material[0].map as DataTexture).image.data![1]).toBe(255);
    const valid=mesh.material[0];replaceMaterialRecipes({});await expect(view.ready).rejects.toThrow('Unresolved surface material');expect(mesh.material[0]).toBe(valid);expect(mesh.userData.objectSurfaceError).toContain('test.soil');
  }finally{view.dispose();replaceMaterialRecipes({});}
});
it('keeps semantic model fronts distinct from geometric box faces',()=>{
  expect(resolveSurfaceName('-x','front','model')).toBe('left');expect(resolveSurfaceName('-x','front','geometry')).toBe('front');expect(resolveSurfaceName('+x','right','model')).toBe('back');
  expect(resolveSurfaceName('-z','top','model')).toBe('top');
});
it('repeats the brick base while applying one bounded slash to only its selected surface',()=>{
  const input=structuredClone(OBJECT_SURFACE_EXAMPLES.slash);input.sizeMeters=[4,2,0.3];input.base.tileMeters=[1,1];input.effects![0]={...input.effects![0],pathMeters:[[0.5,0.2],[0.5,1.8]],chipping:0,branching:0,depthMeters:0.03};
  const r=objectSurfaceSchema.parse(input),effect=r.effects[0];
  expect(slashCoverage(r,effect,'front',0.5/4,0.5)).toBe(1);
  for(const x of [1.5,2.5,3.5])expect(slashCoverage(r,effect,'front',x/4,0.5)).toBe(0);
  expect(slashCoverage(r,effect,'back',0.5/4,0.5)).toBe(0);
  const clean={...r,effects:[]},a=sampleObjectSurface(clean,'front',0.5/4,0.5),b=sampleObjectSurface(clean,'front',1.5/4,0.5);expect(a.color).toEqual(b.color);
  const damaged=sampleObjectSurface(r,'front',0.5/4,0.5);expect(a.height-damaged.height).toBeCloseTo(0.03);expect(damaged.ao).toBeLessThan(a.ao);expect(damaged.color).not.toEqual(a.color);
});
it('rejects ambiguous or unsupported transforms and out-of-surface slash paths',()=>{
  for(const extra of [{scale:[1,2,1]},{mirror:'x'},{orientation:{front:'+z',up:'+z'}}])expect(()=>objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,...extra})).toThrow();
  const r=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.slash);r.effects[0].pathMeters[0][0]=19;expect(()=>objectSurfaceSchema.parse(r)).toThrow();
  expect(()=>objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,layers:[{id:'grass',material:{pattern:{family:'grass'}},coverage:{band:{from:'top',space:'world',depthMeters:0.2}}}]})).toThrow();
});
it('bakes deterministic six-face PBR maps and updates the same mesh during live changes',async()=>{
  const a=await generateObjectSurface(OBJECT_SURFACE_EXAMPLES.grass,{resolution:16}),b=await generateObjectSurface(OBJECT_SURFACE_EXAMPLES.grass,{resolution:16});
  for(const name of BOX_SURFACES)expect(a.faces[name].color.data).toEqual(b.faces[name].color.data);
  expect(a.faces.top.color.data).not.toEqual(a.faces.bottom.color.data);
  const view=new ObjectSurfaceView(a),mesh=view.root,geometry=mesh.geometry,old=mesh.material[0];let disposed=0;old.addEventListener('dispose',()=>disposed++);
  const next=structuredClone(OBJECT_SURFACE_EXAMPLES.grass);next.layers=[];view.update(await generateObjectSurface(next,{resolution:16}));
  expect(view.root).toBe(mesh);expect(mesh.geometry).toBe(geometry);expect(disposed).toBe(1);expect(mesh.material[0]).not.toBe(old);view.dispose();view.dispose();
  const controller=new AbortController();controller.abort();await expect(generateObjectSurface(OBJECT_SURFACE_EXAMPLES.slash,{signal:controller.signal})).rejects.toThrow();
});

it('uses one composable coverage schema for all examples and defaults to solid full coverage',()=>{
 for(const recipe of Object.values(OBJECT_SURFACE_EXAMPLES))for(const layer of objectSurfaceSchema.parse(recipe).layers){expect(layer.coverage).not.toHaveProperty('kind');expect(layer.coverage.pattern).toBeDefined();}
 const r=objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,layers:[{id:'all',material:{pattern:{family:'grass'}}}]});
 expect(r.layers[0].coverage.pattern.mode).toBe('solid');for(const face of BOX_SURFACES)expect(surfaceCoverage(r,r.layers[0],face,boxSurfaceFrame(r.sizeMeters,face).point(.5,.5))).toBe(1);
 expect(()=>objectSurfaceSchema.parse({...r,version:1})).toThrow();expect(()=>objectSurfaceSchema.parse({...r,layers:[{...r.layers[0],coverage:{kind:'faces',selection:{faces:['top']}}}]})).toThrow();
});
it.each(BOX_SURFACES)('coverage bands support %s with continuous shared corner fields',from=>{
 const r=objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,layers:[{...OBJECT_SURFACE_EXAMPLES.grass.layers![0],coverage:{band:{from,space:'geometry',depthMeters:.3,variation:.8}}}]});
 const layer=r.layers[0],anchor=boxSurfaceFrame(r.sizeMeters,from);
 expect(surfaceCoverage(r,layer,from,anchor.point(.5,.5))).toBe(1);
 const opposite=BOX_SURFACES.find(n=>boxSurfaceFrame(r.sizeMeters,n).normal.every((v,i)=>v===-anchor.normal[i]))!;
 expect(surfaceCoverage(r,layer,opposite,boxSurfaceFrame(r.sizeMeters,opposite).point(.5,.5))).toBe(0);
 const sides=BOX_SURFACES.filter(n=>n!==from&&n!==opposite);
 for(const a of sides)for(const b of sides){if(a===b)continue;const af=boxSurfaceFrame(r.sizeMeters,a),bf=boxSurfaceFrame(r.sizeMeters,b);if(af.normal.some((v,i)=>v&&bf.normal[i]))continue;
  for(let t=0;t<=1;t+=.1){const p=af.normal.map((v,i)=>v*r.sizeMeters[i]/2+bf.normal[i]*r.sizeMeters[i]/2+anchor.normal[i]*(t-.5)*r.sizeMeters[i]) as [number,number,number];expect(surfaceCoverage(r,layer,a,p)).toBe(surfaceCoverage(r,layer,b,p));}
 }
});
it('multiplies face, band and pattern masks rather than switching coverage paths',()=>{
 const r=objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.iron,layers:[{...OBJECT_SURFACE_EXAMPLES.iron.layers![0],coverage:{selection:{faces:['front','top']},band:{from:'top',depthMeters:.6,variation:0},pattern:{type:'clusters',density:128,sizeMeters:.3,coverage:.8}}}]});
 const layer=r.layers[0],band=structuredClone(layer),pattern=structuredClone(layer);band.coverage.pattern=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.grass).layers[0].coverage.pattern;delete pattern.coverage.band;
 let covered=0;for(const face of BOX_SURFACES)for(let y=0;y<12;y++)for(let x=0;x<12;x++){const p=boxSurfaceFrame(r.sizeMeters,face).point((x+.5)/12,(y+.5)/12),value=surfaceCoverage(r,layer,face,p);covered+=Number(value>0);expect(value).toBeCloseTo(surfaceCoverage(r,band,face,p)*surfaceCoverage(r,pattern,face,p),10);if(!['front','top'].includes(face))expect(value).toBe(0);}
 expect(covered).toBeGreaterThan(5);
});
it('validates directional band extent and resolves semantic front',()=>{
 const r=objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,orientation:{front:'+x'},sizeMeters:[.2,1,2],layers:[{...OBJECT_SURFACE_EXAMPLES.grass.layers![0],coverage:{band:{from:'front',depthMeters:.1}}}]});
 expect(surfaceCoverage(r,r.layers[0],'right',[.1,0,0])).toBe(1);expect(surfaceCoverage(r,r.layers[0],'left',[-.1,0,0])).toBe(0);
 r.layers[0].coverage.band!.depthMeters=.3;expect(()=>objectSurfaceSchema.parse(r)).toThrow('Coverage band depth');
});

it('composes a coverage-level boundary without requiring a fake feature pattern',()=>{
 const r=objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,layers:[{...OBJECT_SURFACE_EXAMPLES.grass.layers![0],coverage:{selection:{faces:['front']},band:{from:'top',depthMeters:.6,variation:0},boundary:{strength:1,space:'face',axes:'xy',radius:.85,softness:.4}}}]});
 const layer=r.layers[0],without=structuredClone(layer);delete without.coverage.boundary;expect(layer.coverage.pattern.mode).toBe('solid');
 for(let y=0;y<15;y++)for(let x=0;x<15;x++){const u=(x+.5)/15,v=(y+.5)/15,p=boxSurfaceFrame(r.sizeMeters,'front').point(u,v);expect(surfaceCoverage(r,layer,'front',p)).toBeCloseTo(surfaceCoverage(r,without,'front',p)*materialPatternBoundaryWeight(layer.coverage.boundary,{face:[u*2-1,v*2-1,0]}),10);}
 expect(()=>objectSurfaceSchema.parse({...r,layers:[{...layer,coverage:{boundary:{axes:'world'}}}]})).toThrow();
});
