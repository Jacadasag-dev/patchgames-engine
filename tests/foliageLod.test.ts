import {expect,it} from 'vitest';
import {InstancedMesh,Mesh,Matrix4,Texture} from 'three';
import {compileFoliage,foliageColliders,type FoliageRecipe} from '../src/shared/foliageGenerator.ts';
import {prepareFoliageLod,foliageLodPathIndices} from '../src/shared/foliageLod.ts';
import {FoliageView,generateFoliage,createFoliageTerrainLibrary} from '../src/sandbox/foliageGenerator.ts';
import {readGeneratedGeometryLod,readGeneratedMeshLod} from '../src/sandbox/generatedLod.ts';
import {TerrainView} from '../src/sandbox/terrainView.ts';
import {compileTerrain} from '../src/sandbox/terrain.ts';
const recipe:FoliageRecipe={kind:'foliage',version:1,seed:8,heightMeters:3,crownRadiusMeters:1,branches:3,branchLevels:2,branchSegments:12,density:80};
it('prepares nested spatial leaf subsets without rerolling trees or authoritative colliders',()=>{
 const model=compileFoliage(recipe),before=structuredClone(model),tiers=prepareFoliageLod(model);expect(model).toEqual(before);expect(tiers).toEqual(prepareFoliageLod(model));expect(tiers).toHaveLength(4);
 for(let i=1;i<tiers.length;i++){expect(tiers[i].leafIndices).toEqual(tiers[0].leafIndices.slice(0,tiers[i].leafIndices.length));expect(tiers[i].leafIndices.length).toBeLessThanOrEqual(tiers[i-1].leafIndices.length);expect(tiers[i].error).toBeGreaterThanOrEqual(tiers[i-1].error);}
 expect(foliageColliders(model)).toEqual(foliageColliders(before));expect(Object.isFrozen(tiers[0].leafIndices)).toBe(true);
});
it('simplifies woody paths within a physical deviation bound while retaining endpoints',()=>{
 const points=[[0,0,0],[.01,1,0],[0,2,0],[.4,3,0],[0,4,0]];expect(foliageLodPathIndices(points,0)).toEqual([0,1,2,3,4]);expect(foliageLodPathIndices(points,.05)).toEqual([0,2,3,4]);expect(foliageLodPathIndices(points,.5)).toEqual([0,4]);
 expect(()=>foliageLodPathIndices(points,-1)).toThrow();
});
it('prepares much cheaper borrowed geometry banks once and keeps source meshes stable',async()=>{
 const bake=await generateFoliage(recipe,{resolution:32}),view=new FoliageView(bake),[wood,leaves]=view.root.children as [Mesh,InstancedMesh],woodBank=readGeneratedGeometryLod(wood.geometry)!,leafBank=readGeneratedMeshLod(leaves)!,metadata=view.root.userData.foliage.lod;
 expect(woodBank).toHaveLength(4);expect(leafBank).toHaveLength(4);expect(metadata.prepared).toBe(true);expect(metadata.levels[3].woodTriangles).toBeLessThan(metadata.levels[0].woodTriangles*.35);expect(metadata.levels[3].leafTriangles).toBeLessThan(metadata.levels[0].leafTriangles*.1);
 const tiers=prepareFoliageLod(bake.model),matrix=new Matrix4();for(let i=0;i<Math.min(20,leaves.count);i++){leaves.getMatrixAt(i,matrix);expect(matrix.elements.slice(12,15)).toEqual(bake.model.leaves[tiers[0].leafIndices[i]].anchor.map(Math.fround));}
 const disposed=woodBank.map(()=>0);woodBank.forEach((entry,i)=>entry.geometry.addEventListener('dispose',()=>disposed[i]++));view.update(bake);expect(readGeneratedGeometryLod(wood.geometry)).toBe(woodBank);expect(view.root.userData.foliage.lod).toBe(metadata);expect(disposed).toEqual([0,0,0,0]);view.dispose();view.dispose();expect(disposed).toEqual([1,1,1,1]);expect(readGeneratedGeometryLod(wood.geometry)).toBeUndefined();
});
it('clones merged prototype banks with independent ownership across terrain libraries',async()=>{
 const bake=await generateFoliage(recipe,{resolution:32}),library=createFoliageTerrainLibrary([{id:'tree',bake}]),a=library.assetFactory(library.assets[0])!,b=library.assetFactory(library.assets[0])!,am=a.children[0] as Mesh,bm=b.children[0] as Mesh,abank=readGeneratedGeometryLod(am.geometry)!,bbank=readGeneratedGeometryLod(bm.geometry)!;
 try{expect(abank).toHaveLength(4);for(let i=0;i<abank.length;i++)expect(abank[i].geometry).not.toBe(bbank[i].geometry);let disposed=0;bbank[3].geometry.addEventListener('dispose',()=>disposed++);library.dispose();expect(disposed).toBe(0);expect(bbank[3].geometry.attributes.position.count).toBeGreaterThan(0);}finally{for(const root of [a,b])root.traverse(o=>{if(o instanceof Mesh){const bank=readGeneratedGeometryLod(o.geometry),geometries=new Set(bank?.map(e=>e.geometry)??[o.geometry]);geometries.forEach(g=>g.dispose());const materials=Array.isArray(o.material)?o.material:[o.material];for(const material of materials){for(const value of Object.values(material))if(value instanceof Texture)value.dispose();material.dispose();}}});library.dispose();}
});
it('supports bare and flower-only trees without dividing LOD error by an empty canopy',async()=>{
 for(const density of [0,2]){const bake=await generateFoliage({...recipe,density:0,flowers:{density}},{resolution:32});for(const leafMode of ['instanced','merged'] as const){const view=new FoliageView(bake,{leafMode});try{expect(view.root.children.length).toBe(density?3:2);expect(view.root.userData.foliage.lod.levels.every((l:{leaves:number})=>l.leaves===0)).toBe(true);}finally{view.dispose();}}}
});
it.each([true,false])('shares prepared geometry loans across terrain views with LOD %s and releases after the final owner',async lod=>{
 const bake=await generateFoliage(recipe,{resolution:32}),library=createFoliageTerrainLibrary([{id:'tree',bake}]),source={version:1 as const,seed:1,bounds:{width:20,depth:20,cells:4},assets:library.assets,regions:[],placements:[{id:'tree-a',asset:'tree',position:{x:0,z:0}}]},manifest=compileTerrain(source),a=new TerrainView(manifest,{surface:false,lod,assetFactory:library.assetFactory}),b=new TerrainView(manifest,{surface:false,lod,assetFactory:library.assetFactory});
 const meshes=(view:TerrainView)=>{const values:InstancedMesh[]=[];view.root.traverse(o=>{if(o instanceof InstancedMesh&&o.count)values.push(o);});return values;},am=meshes(a),bm=meshes(b),bank=readGeneratedGeometryLod(am[0].geometry)!;
 expect(am[0].geometry).toBe(bm[0].geometry);expect(am[0].material).not.toBe(bm[0].material);expect(bank).toHaveLength(4);
 const releases=bank.map(()=>0);bank.forEach((entry,i)=>entry.geometry.addEventListener('dispose',()=>releases[i]++));
 a.update(compileTerrain({...source,seed:2}));expect(meshes(a)[0].geometry).toBe(bm[0].geometry);expect(releases).toEqual([0,0,0,0]);
 library.dispose();expect(releases).toEqual([0,0,0,0]);expect(()=>library.assetFactory(library.assets[0])).toThrow('disposed');
 a.dispose();a.dispose();expect(releases).toEqual([0,0,0,0]);expect(b.stepWind(3)).toBe(1);expect(bank[3].geometry.attributes.position.count).toBeGreaterThan(0);
 b.dispose();b.dispose();expect(releases).toEqual([1,1,1,1]);
});
it('releases a failed construction loan without disposing shared geometry early',async()=>{
 const bake=await generateFoliage(recipe,{resolution:32}),library=createFoliageTerrainLibrary([{id:'tree',bake}]),manifest=compileTerrain({version:1,seed:1,bounds:{width:20,depth:20,cells:4},assets:library.assets,regions:[],placements:[{id:'tree-a',asset:'tree',position:{x:0,z:0}}]});
 let releases=0;expect(()=>new TerrainView(manifest,{surface:false,assetFactory(asset,context){library.assetFactory(asset,{borrowGeometry(geometries,release){for(const g of geometries)g.addEventListener('dispose',()=>releases++);context!.borrowGeometry(geometries,release);}});throw Error('factory failure');}})).toThrow('factory failure');
 expect(releases).toBe(0);library.dispose();expect(releases).toBe(8);
});
