import {compileTerrain} from '../src/sandbox/terrain.ts';
import {TerrainView} from '../src/sandbox/terrainView.ts';
import {it,expect} from 'vitest';
import {Vector3,Mesh,InstancedMesh} from 'three';
import {compileFoliage,parseFoliageRecipe,foliageColliders,type FoliageRecipe} from '../src/shared/foliageGenerator.ts';
import {FOLIAGE_PRESETS} from '../src/shared/foliagePresets.ts';
import {generateFoliage,FoliageView,createFoliage,createFoliageTerrainPrototype} from '../src/sandbox/foliageGenerator.ts';
import {replaceMaterialRecipes} from '../src/shared/materialRegistry.ts';
import {materialGeneratorSchema} from '../src/shared/materialGenerator.ts';
const small:FoliageRecipe={kind:'foliage',version:1,heightMeters:2,crownRadiusMeters:.6,trunkRadiusMeters:.04,branchLevels:2,branches:3,density:80};
it.each(FOLIAGE_PRESETS)('$id compiles deterministic, bounded, physically attached foliage',({recipe})=>{
 const m=compileFoliage(recipe);expect(m).toEqual(compileFoliage(recipe));expect(m.branches.length).toBeLessThanOrEqual(8192);expect(m.leaves.length).toBeGreaterThan(10);expect(m.leaves.length).toBeLessThanOrEqual(16000);
 for(const b of m.branches){expect(b.radiusEnd).toBeLessThanOrEqual(b.radiusStart);if(b.parent<0){expect(b.start).toEqual([0,0,0]);continue;}const parent=m.branches[b.parent],a=new Vector3(...parent.start),axis=new Vector3(...parent.end).sub(a),point=new Vector3(...b.start),t=point.clone().sub(a).dot(axis)/axis.lengthSq();expect(t).toBeGreaterThanOrEqual(-1e-9);expect(t).toBeLessThanOrEqual(1+1e-9);expect(a.addScaledVector(axis,t).distanceTo(point)).toBeLessThan(1e-8);}
 for(const l of m.leaves){const b=m.branches[l.branch],anchor=b.start.map((v,i)=>v+(b.end[i]-v)*l.t);expect(l.anchor).toEqual(anchor);expect(l.sizeScale).toBeGreaterThan(0);expect(l.anchor.every((v,i)=>v>=m.bounds.min[i]&&v<=m.bounds.max[i])).toBe(true);}
});
it('changes amount independently of size and retains shared grouping at very large group scales',()=>{
 const a=compileFoliage({...small,density:20}),b=compileFoliage({...small,density:100}),large=compileFoliage({...small,clumping:1,groupSizeMeters:20});expect(b.leaves.length).toBeGreaterThan(a.leaves.length*2);expect(large.leaves.length).toBeGreaterThan(100);expect(compileFoliage({...small,density:0}).leaves).toEqual([]);
 const changed=compileFoliage({...small,leafSizeMeters:.4});expect(changed.branches).toEqual(compileFoliage(small).branches);expect(changed.leaves).toEqual(compileFoliage(small).leaves);
});
it('quality thinning preserves an exact deterministic subset and never changes branch growth',()=>{
 const recipe={...small,heightMeters:4,crownRadiusMeters:1.5,density:200},high=compileFoliage({...recipe,quality:'high'}),low=compileFoliage({...recipe,quality:'low'});expect(low.branches).toEqual(high.branches);expect(low.leaves).toEqual(high.leaves.slice(0,1800));expect(low.diagnostics.qualityThinning).toBe(true);
});
it('rejects unsupported fields, invalid dimensions and unbounded recipes before heavy work',()=>{
 for(const extra of [{heightMeters:NaN},{density:300},{branches:1},{trunkRadiusMeters:1},{kind:'tree'},{materials:{bark:{ref:'../bad'},leaf:{}}},{unknown:true}])expect(()=>parseFoliageRecipe({...small,...extra})).toThrow();
 expect(()=>compileFoliage({...small,heightMeters:30,crownRadiusMeters:10,density:256})).toThrow('proposal budget');expect(()=>compileFoliage({...small,type:'bush',branches:7,branchLevels:4})).toThrow('branch budget');
});
it('emits bounded trunk capsules aligned to the generated wood, excluding all leaves',()=>{
 const model=compileFoliage(small),capsules=foliageColliders(model);expect(capsules.length).toBe(4);for(const [i,c]of capsules.entries()){const b=model.branches[i];expect(c.shape.kind).toBe('capsule');expect(c.position.y).toBe((b.start[1]+b.end[1])/2);expect(Math.hypot(c.rotation.x,c.rotation.y,c.rotation.z,c.rotation.w)).toBeCloseTo(1);}
 expect(()=>foliageColliders(model,{maxLevel:2,maxColliders:4})).toThrow('budget');
});
it('renders outward-facing wood and attached instanced cutout leaves using shared material recipes',async()=>{
 const bake=await generateFoliage(small,{resolution:32}),view=new FoliageView(bake),[wood,leaves]=view.root.children as [Mesh,InstancedMesh];
 expect(leaves).toBeInstanceOf(InstancedMesh);expect(leaves.count).toBe(bake.model.leaves.length);expect(leaves.material).toHaveProperty('alphaTest',.5);expect(bake.leaf.color.data.some((v,i)=>i%4===3&&v===0)).toBe(true);
 const pos=wood.geometry.attributes.position,index=wood.geometry.index!,a=new Vector3().fromBufferAttribute(pos,index.getX(0)),b=new Vector3().fromBufferAttribute(pos,index.getX(1)),c=new Vector3().fromBufferAttribute(pos,index.getX(2)),normal=b.clone().sub(a).cross(c.clone().sub(a));
 const branch=bake.model.branches[0],axis=new Vector3(...branch.end).sub(new Vector3(...branch.start)).normalize(),radial=a.clone().sub(new Vector3(...branch.start));radial.addScaledVector(axis,-radial.dot(axis));expect(normal.dot(radial)).toBeGreaterThan(0);
 let disposed=0;wood.geometry.addEventListener('dispose',()=>disposed++);view.update(bake);expect(disposed).toBe(0);expect((view.root.children[0] as Mesh).geometry).toBe(wood.geometry);view.update(await generateFoliage({...small,heightMeters:2.2},{resolution:32}));expect(disposed).toBe(1);view.dispose();view.dispose();
});
it('named material updates preserve the foliage root and retain the last valid view on missing references',async()=>{
 const bark=materialGeneratorSchema.parse({pattern:{family:'bark'}}),leaf=materialGeneratorSchema.parse({pattern:{family:'leaf'},tileMeters:[.12,.22]});replaceMaterialRecipes({'test.foliage-bark':bark,'test.foliage-leaf':leaf});
 const h=await createFoliage({...small,materials:{bark:{ref:'test.foliage-bark'},leaf:{ref:'test.foliage-leaf'}}},{resolution:32}),root=h.root;
 try{replaceMaterialRecipes({'test.foliage-bark':bark,'test.foliage-leaf':{...leaf,color:'#aabb44'}});await h.ready;expect(h.root).toBe(root);expect(root.userData.foliageError).toBeUndefined();const previous=root.children[1];replaceMaterialRecipes({});await expect(h.ready).rejects.toThrow('Unresolved foliage material');expect(root.children[1]).toBe(previous);}finally{h.dispose();replaceMaterialRecipes({});}
});

it('terrain batches the explicit plain-mesh foliage prototype without missing-model fallbacks',async()=>{
 const bake=await generateFoliage({...small,quality:'low'},{resolution:32}),terrain=compileTerrain({version:1,seed:1,bounds:{width:12,depth:12,cells:4},assets:[{id:'plant',footprint:{kind:'circle',radius:1}}],regions:[],placements:[{id:'a',asset:'plant',position:{x:-2,z:0}},{id:'b',asset:'plant',position:{x:2,z:0}}]});
 const view=new TerrainView(terrain,{surface:false,assetFactory:()=>createFoliageTerrainPrototype(bake)});try{expect(view.inspection().missingAssetCount).toBe(0);expect(view.inspection().drawBatches).toBe(2);}finally{view.dispose();}
});
