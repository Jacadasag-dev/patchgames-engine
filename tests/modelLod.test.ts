import {expect,it} from 'vitest';
import {CylinderGeometry,Mesh,PerspectiveCamera,Scene,SphereGeometry} from 'three';
import {prepareModelSphereLod,prepareModelCylinderLod} from '../src/sandbox/modelLod.ts';
import {readGeneratedGeometryLod} from '../src/sandbox/generatedLod.ts';
import {createModelView} from '../src/sandbox/modelView.ts';
import {inspectModel,type ModelDefinition} from '../src/sandbox/model.ts';
import {AssetFamilyViewCache} from '../src/sandbox/assetFamilyView.ts';
import {createAssetCatalog,defineAssetFamily} from '../src/sandbox/assetFamilies.ts';
import {RenderVisibility} from '../src/sandbox/renderVisibility.ts';

const count=(g:SphereGeometry|CylinderGeometry)=>(g.index?.count??g.getAttribute('position').count)/3;
it('prepares analytic model tiers once with lower triangle counts, bounded error and intact attributes',()=>{
  for(const bank of [prepareModelSphereLod(2),prepareModelCylinderLod(.5,3)]){
    expect(bank.levels).toHaveLength(3);expect(readGeneratedGeometryLod(bank.geometry)).toBeDefined();
    for(let i=0;i<bank.levels.length;i++){
      const level=bank.levels[i];expect(level.error).toBeGreaterThanOrEqual(0);expect(level.error).toBeLessThan(.3);
      for(const name of ['position','normal','uv'])expect(Array.from(level.geometry.getAttribute(name).array).every(Number.isFinite)).toBe(true);
      if(i){expect(count(level.geometry)).toBeLessThan(count(bank.levels[i-1].geometry));expect(level.error).toBeGreaterThan(bank.levels[i-1].error);}
      expect(level.geometry.boundingSphere!.center.length()).toBeCloseTo(0,6);
    }
    expect(count(bank.levels.at(-1)!.geometry)).toBeLessThan(count(bank.geometry)*.4);bank.dispose();
  }
});
it('owns every prepared geometry once and unregisters on disposal',()=>{
  const bank=prepareModelSphereLod(1),source=bank.geometry;let disposed=0;
  for(const level of bank.levels)level.geometry.addEventListener('dispose',()=>disposed++);
  bank.dispose();bank.dispose();expect(disposed).toBe(bank.levels.length);expect(readGeneratedGeometryLod(source)).toBeUndefined();
  for(const radius of [NaN,0,Infinity,129])expect(()=>prepareModelSphereLod(radius)).toThrow();
  for(const segments of [0,4,1.5,129])expect(()=>prepareModelCylinderLod(1,1,segments)).toThrow();
});
it('releases every allocated tier if a metric-UV preparation step fails',()=>{
  const allocated:SphereGeometry[]=[];let disposed=0;
  expect(()=>prepareModelSphereLod(1,24,16,geometry=>{allocated.push(geometry);geometry.addEventListener('dispose',()=>disposed++);if(allocated.length===2)throw Error('mapping failed');})).toThrow(/mapping failed/);
  expect(allocated).toHaveLength(2);expect(disposed).toBe(2);expect(readGeneratedGeometryLod(allocated[0])).toBeUndefined();
});
it('model render LOD preserves named parts, attachments, poses and authoritative collision',()=>{
  const definition:ModelDefinition={name:'actor',root:'body',ground:'ignore',parts:[
    {name:'body',size:{x:1,y:1,z:1},position:{x:0,y:.5,z:0},collision:true},
    {name:'head',shape:'sphere',size:{x:.5,y:.5,z:.5},attach:{part:'body',face:'top',mode:'joint'},collision:true},
  ]};
  const before=inspectModel(definition),view=createModelView(definition);view.apply({head:{rotate:{y:40}}});
  const head=view.parts.get('head')!,source=head.geometry,matrix=head.matrix.clone(),scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,20000),visibility=new RenderVisibility();
  scene.add(view.root);camera.position.set(0,1,10000);camera.lookAt(0,1,0);camera.updateMatrixWorld(true);
  visibility.prepare(scene,camera,1080);expect(head.geometry).not.toBe(source);expect(head.matrix.equals(matrix)).toBe(true);
  expect([...view.parts.keys()]).toEqual(['body','head']);expect(inspectModel(definition)).toEqual(before);
  visibility.restore();expect(head.geometry).toBe(source);expect(head.matrix.equals(matrix)).toBe(true);
  visibility.dispose();view.dispose();view.dispose();expect(readGeneratedGeometryLod(source)).toBeUndefined();
});
it('textured parametric assets retain physical UV density in every shared tier',async()=>{
  const family=defineAssetFamily({id:'lod-column',version:'1',parameters:{},generate:()=>({parts:[{
    id:'column',shape:'cylinder',position:{x:0,y:2,z:0},size:{x:2,y:4,z:1},color:'#889977',
    material:{texture:{kind:'texture',version:1,name:'plain stone',resolution:16,layers:[{source:{kind:'solid',color:'#889977'}}]}},
  }]})}),catalog=createAssetCatalog([family]),manifest=catalog.resolve('lod-column',{seed:1,instanceId:'one'}),before=JSON.stringify(manifest),cache=new AssetFamilyViewCache();
  const first=cache.create(manifest),second=cache.create(manifest),mesh=first.object.children[0] as Mesh,source=mesh.geometry;
  await cache.readyMaterials();expect((second.object.children[0] as Mesh).geometry).toBe(source);
  const levels=readGeneratedGeometryLod(source)!;expect(levels).toHaveLength(3);
  const a=1,b=.5,circumference=Math.PI*(3*(a+b)-Math.sqrt((3*a+b)*(a+3*b)));
  for(const level of levels){const uv=level.geometry.getAttribute('uv'),normal=level.geometry.getAttribute('normal');const u:number[]=[],v:number[]=[];
    for(let i=0;i<uv.count;i++)if(Math.abs(normal.getY(i))<.5){u.push(uv.getX(i));v.push(uv.getY(i));}
    expect(Math.min(...u)).toBeCloseTo(0,5);expect(Math.max(...u)).toBeCloseTo(circumference,5);
    expect(Math.min(...v)).toBeCloseTo(0,5);expect(Math.max(...v)).toBeCloseTo(4,5);
  }
  const scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,20000),visibility=new RenderVisibility();scene.add(first.object);camera.position.set(0,2,10000);camera.lookAt(0,2,0);camera.updateMatrixWorld(true);
  visibility.prepare(scene,camera,1080);expect(mesh.geometry).not.toBe(source);visibility.restore();expect(mesh.geometry).toBe(source);visibility.dispose();
  first.dispose();expect(readGeneratedGeometryLod(source)).toBeDefined();second.dispose();expect(readGeneratedGeometryLod(source)).toBeUndefined();cache.dispose();
  expect(JSON.stringify(manifest)).toBe(before);
});
