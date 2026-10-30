import {compileTerrain,compileTerrainChunk} from '../src/sandbox/terrain.ts';
import {TerrainView} from '../src/sandbox/terrainView.ts';
import {it,expect} from 'vitest';
import {Vector3,Matrix4,Mesh,InstancedMesh} from 'three';
import {compileFoliage,parseFoliageRecipe,foliageColliders,type FoliageRecipe} from '../src/shared/foliageGenerator.ts';
import {FOLIAGE_PRESETS} from '../src/shared/foliagePresets.ts';
import {generateFoliage,FoliageView,createFoliage,createFoliageTerrainPrototype,prepareFoliageTerrain} from '../src/sandbox/foliageGenerator.ts';
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
 expect(leaves).toBeInstanceOf(InstancedMesh);expect(leaves.count).toBe(bake.model.leaves.length);expect(leaves.material).toHaveProperty('alphaTest',0);expect(leaves.material).toHaveProperty('alphaHash',true);expect(leaves.material).toHaveProperty('alphaToCoverage',false);expect(bake.leaf.color.data.some((v,i)=>i%4===3&&v===0)).toBe(true);
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

it('generic growth controls change architecture while preserving connected fronds and independent blossoms',async()=>{
 const base=compileFoliage({...small,branchSegments:12}),winding=compileFoliage({...small,branchSegments:12,winding:.9});expect(winding.branches).not.toEqual(base.branches);expect(base.branches[0].path).toBe(0);expect(base.branches[11].step).toBe(11);
 const palm=compileFoliage(FOLIAGE_PRESETS.find(p=>p.id==='palm')!.recipe);expect(palm.leaves.some((l,i)=>i>0&&l.direction[0]*palm.leaves[i-1].direction[0]<0)).toBe(true);expect(palm.branches.filter(b=>b.level===1).every(b=>b.start[1]>3)).toBe(true);
 const bake=await generateFoliage({...small,density:0,flowers:{density:5,sizeMeters:.3,petals:7}},{resolution:32});expect(bake.model.leaves).toHaveLength(0);expect(bake.model.flowers.length).toBeGreaterThan(0);expect(bake.flower).toBeDefined();const view=new FoliageView(bake);expect(view.root.children).toHaveLength(3);expect((view.root.children[2] as InstancedMesh).count).toBe(bake.model.flowers.length*7);const geometry=(view.root.children[2] as Mesh).geometry;view.update(bake);expect((view.root.children[2] as Mesh).geometry).toBe(geometry);view.dispose();
 const proto=createFoliageTerrainPrototype(bake);expect(proto.children).toHaveLength(3);expect(proto.children.every(c=>!(c instanceof InstancedMesh))).toBe(true);proto.traverse(c=>{if(c instanceof Mesh){c.geometry.dispose();const m=c.material as any;for(const key of ['map','normalMap','roughnessMap','metalnessMap','aoMap'])m[key]?.dispose();m.dispose();}});
});
it('validates new architecture and bloom controls',()=>{for(const extra of [{branchSegments:3},{winding:2},{leafArrangement:'invalid'},{flowers:{density:-1}},{flowers:{petals:2}},{trunkTaper:0}])expect(()=>parseFoliageRecipe({...small,...extra})).toThrow();});

it('sweeps welded bend rings with continuous bark UVs and no internal caps',async()=>{
 const bake=await generateFoliage({...small,branchSegments:12,winding:.8},{resolution:32}),view=new FoliageView(bake),g=(view.root.children[0] as Mesh).geometry,uv=g.attributes.uv,n=g.attributes.normal,sides=8;
 const paths=new Set(bake.model.branches.map(b=>b.path)).size;expect(g.attributes.position.count).toBe(paths*((12+1)*(sides+1)+2*(sides+2)));expect(g.index!.count).toBe(paths*(12*6*sides+2*3*sides));
 for(let i=1;i<=12;i++)expect(uv.getY(i*(sides+1))).toBeGreaterThan(uv.getY((i-1)*(sides+1)));
 for(let i=0;i<=12;i++){const a=i*(sides+1),b=a+sides;expect([n.getX(a),n.getY(a),n.getZ(a)]).toEqual([n.getX(b),n.getY(b),n.getZ(b)]);}view.dispose();
});

it('curves trunks independently of their initial lean and preserves palm bark recipes',()=>{const straight=compileFoliage({...small,trunkCurve:0,irregularity:0}),curved=compileFoliage({...small,trunkCurve:.7,irregularity:0});expect(curved.branches[0].end).not.toEqual(straight.branches[0].end);for(const id of ['palm','fan-palm']){const r=FOLIAGE_PRESETS.find(p=>p.id===id)!.recipe;expect(r.materials.bark).toHaveProperty('pattern.direction','horizontal');expect(r.rootFlare).toBeGreaterThan(0);}});

it('fits crown radius around a leaning stem rather than shrinking it toward the origin',()=>{const m=compileFoliage({...small,trunkLean:.6,trunkCurve:.4}),tip=m.branches[m.recipe.branchSegments-1].end,sx=tip[0]/tip[1],sz=tip[2]/tip[1];expect(Math.max(...m.branches.map(b=>Math.hypot(b.end[0]-sx*b.end[1],b.end[2]-sz*b.end[1])))).toBeCloseTo(m.recipe.crownRadiusMeters,8);expect(()=>parseFoliageRecipe({...small,trunkCurve:2})).toThrow();});

it('weeping controls lengthen terminal twigs and turn their tips downward',()=>{const r=FOLIAGE_PRESETS.find(p=>p.id==='willow')!.recipe,m=compileFoliage(r),ends=m.branches.filter(b=>b.level===r.branchLevels&&b.step===r.branchSegments-1);expect(ends.filter(b=>b.end[1]<b.start[1]).length).toBeGreaterThan(ends.length*.9);expect(()=>parseFoliageRecipe({...r,terminalLength:4})).toThrow();expect(()=>parseFoliageRecipe({...r,terminalDroop:2})).toThrow();});

it('whorled branching places multiple supported limbs at each trunk tier',()=>{const r=FOLIAGE_PRESETS.find(p=>p.id==='evergreen')!.recipe,m=compileFoliage({...r,tierHeightVariation:0,density:0}),roots=m.branches.filter(b=>b.level===1&&b.step===0),tiers=new Map<string,number>();for(const b of roots){const key=b.start.join(',');tiers.set(key,(tiers.get(key)??0)+1);}expect([...tiers.values()]).toEqual(Array(r.branches+2).fill(r.branchWhorls));expect(()=>parseFoliageRecipe({...r,branchWhorls:5})).toThrow();});

it('conical crowns progressively shorten upper tiers and scale their tip foliage',()=>{const r=FOLIAGE_PRESETS.find(p=>p.id==='evergreen')!.recipe,m=compileFoliage(r),roots=m.branches.filter(b=>b.level===1&&b.step===0),length=(id:number)=>m.branches.filter(b=>b.path===id).reduce((n,b)=>n+Math.hypot(...b.end.map((v,i)=>v-b.start[i])),0);expect(length(roots.at(-1)!.path)).toBeLessThan(length(roots[0].path)*.3);const full=compileFoliage({...r,tipLeafScale:1});expect(m.leaves.length).toBe(full.leaves.length);expect(m.leaves.some((l,i)=>l.sizeScale<full.leaves[i].sizeScale*.5)).toBe(true);expect(()=>parseFoliageRecipe({...r,crownTaper:4})).toThrow();});

it('tier spacing bias compresses upper or lower gaps without adding branches',()=>{const r=FOLIAGE_PRESETS.find(p=>p.id==='evergreen')!.recipe,tiers=(bias:number)=>{const m=compileFoliage({...r,tierSpacingBias:bias,tierHeightVariation:0,density:0});return [...new Set(m.branches.filter(b=>b.level===1&&b.step===0).map(b=>b.start[1]))];},a=tiers(0),top=tiers(.6),base=tiers(-.6),gap=(v:number[],i:number)=>v[i+1]-v[i];expect(top.length).toBe(a.length);expect(gap(top,top.length-2)).toBeLessThan(gap(top,0)*.2);expect(gap(base,0)).toBeLessThan(gap(base,base.length-2)*.2);expect(top[0]).toBeCloseTo(a[0],8);expect(top.at(-1)).toBeCloseTo(a.at(-1)!,8);expect(()=>parseFoliageRecipe({...r,tierSpacingBias:2})).toThrow();});

it('tier variation staggers whorl attachments and tip density thins whole leaves independently of flowers',()=>{const r=FOLIAGE_PRESETS.find(p=>p.id==='evergreen')!.recipe,a=compileFoliage({...r,density:0,tierHeightVariation:0}),b=compileFoliage({...r,density:0,tierHeightVariation:1});expect(b.branches.length).toBe(a.branches.length);const heights=(m:typeof a)=>new Set(m.branches.filter(b=>b.level===1&&b.step===0).map(b=>b.start[1]));expect(heights(b).size).toBeGreaterThan(heights(a).size);const full=compileFoliage({...small,tipDensity:1,flowers:{density:2}}),thin=compileFoliage({...small,tipDensity:0,flowers:{density:2}});expect(thin.leaves.length).toBeLessThan(full.leaves.length);expect(thin.flowers).toEqual(full.flowers);expect(()=>parseFoliageRecipe({...small,tierHeightVariation:2})).toThrow();});

it('branch pitch variation produces both upward and downward departures on subbranches',()=>{const r={...small,density:0,branchAngle:1.3,irregularity:0,shapeVariation:0,branchPitchVariation:1},a=compileFoliage(r),b=compileFoliage({...r,branchPitchVariation:0}),d=a.branches.filter(b=>b.level===2&&b.step===0).map(b=>b.end[1]-b.start[1]);expect(d.some(v=>v>0)).toBe(true);expect(d.some(v=>v<0)).toBe(true);expect(a.branches).not.toEqual(b.branches);expect(a).toEqual(compileFoliage(r));expect(()=>parseFoliageRecipe({...r,branchPitchVariation:2})).toThrow();});

it('prepared foliage scatters deterministically across chunks with coherent budgeted wind and isolated ownership',async()=>{
 const library=await prepareFoliageTerrain([{id:'woodland',recipe:{...small,quality:'low'}}],{resolution:32}),recipe={version:1 as const,seed:91,bounds:{width:128,depth:128,cells:8},assets:library.assets,environment:{wind:{strength:1,gustStrength:.2}},regions:[{id:'forest',mask:{kind:'box' as const,width:128,depth:128,center:{x:0,z:0}},color:'#335533',layers:[{id:'trees',assets:['woodland'],spacing:5,density:1}]}]},chunk=compileTerrainChunk(recipe,{x:0,z:0,size:32,cells:4}),again=compileTerrainChunk(recipe,{x:0,z:0,size:32,cells:4}),next=compileTerrainChunk(recipe,{x:1,z:0,size:32,cells:4});
 expect(chunk.diagnostics.valid).toBe(true);expect(chunk.instances.length).toBeGreaterThan(0);expect(again.instances).toEqual(chunk.instances);const ids=new Set(chunk.instances.map(i=>i.id));expect(next.instances.every(i=>!ids.has(i.id))).toBe(true);
 const a=new TerrainView(chunk,{surface:false,assetFactory:library.assetFactory}),b=new TerrainView(again,{surface:false,assetFactory:library.assetFactory}),meshes=(v:TerrainView)=>{const list:InstancedMesh[]=[];v.root.traverse(o=>{if(o instanceof InstancedMesh&&o.count>0)list.push(o);});return list;},am=meshes(a),bm=meshes(b),rest=new Matrix4(),m=new Matrix4(),n=new Matrix4();
 try{expect(a.inspection().missingAssetCount).toBe(0);expect(am).toHaveLength(2);expect(am[0].geometry).toBe(bm[0].geometry);expect(am[0].material).not.toBe(bm[0].material);expect((am[0].material as any).map).not.toBe((bm[0].material as any).map);am[0].getMatrixAt(0,rest);expect(a.stepWind(3,{x:0,z:0},512)).toBe(chunk.instances.length);b.stepWind(3,{x:0,z:0},512);am[0].getMatrixAt(0,m);bm[0].getMatrixAt(0,n);expect(m.elements).toEqual(n.elements);expect(m.elements).not.toEqual(rest.elements);expect(m.elements.slice(12,15)).toEqual(rest.elements.slice(12,15));am[1].getMatrixAt(0,n);expect(m.elements).toEqual(n.elements);expect(a.stepWind(4,undefined,0)).toBe(0);am[0].getMatrixAt(0,m);expect(m.elements).toEqual(rest.elements);let otherDisposed=0;bm[0].geometry.addEventListener('dispose',()=>otherDisposed++);a.dispose();expect(otherDisposed).toBe(0);library.dispose();expect(()=>library.assetFactory(library.assets[0])).toThrow('disposed');expect(b.stepWind(5)).toBe(chunk.instances.length);}finally{a.dispose();b.dispose();library.dispose();}
});
