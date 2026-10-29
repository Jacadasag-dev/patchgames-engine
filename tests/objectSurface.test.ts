import {it,expect} from 'vitest';
import {generateObjectSurface,objectSurfaceSchema,OBJECT_SURFACE_EXAMPLES,BOX_SURFACES,boxSurfaceFrame,surfaceCoverage,slashCoverage,sampleObjectSurface,resolveSurfaceName} from '../src/shared/objectSurface.ts';
import {ObjectSurfaceView,createObjectSurfaceView} from '../src/sandbox/objectSurface.ts';
import {replaceMaterialRecipes} from '../src/shared/materialRegistry.ts';
import {materialGeneratorSchema} from '../src/shared/materialGenerator.ts';
import {DataTexture} from 'three';

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
  expect(()=>objectSurfaceSchema.parse({...OBJECT_SURFACE_EXAMPLES.grass,layers:[{id:'grass',material:{pattern:{family:'grass'}},coverage:{kind:'top-fringe',space:'world',depthMeters:0.2}}]})).toThrow();
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
