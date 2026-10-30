import {expect,it} from 'vitest';
import {InstancedMesh,Material,Mesh,MeshDepthMaterial,MeshDistanceMaterial,PerspectiveCamera,Scene,Texture,type MeshPhysicalMaterial} from 'three';
import {FoliageView,generateFoliage,createFoliageTerrainLibrary} from '../src/sandbox/foliageGenerator.ts';
import {readGeneratedGeometryLod,readGeneratedMeshLod} from '../src/sandbox/generatedLod.ts';
import {RenderVisibility} from '../src/sandbox/renderVisibility.ts';
import {TerrainView} from '../src/sandbox/terrainView.ts';
import {compileTerrain} from '../src/sandbox/terrain.ts';
import {generateMaterial} from '../src/shared/materialGenerator.ts';
import {MATERIAL_OPTICAL_PRESETS} from '../src/shared/materialOpticalPresets.ts';

const recipe={kind:'foliage' as const,version:1 as const,seed:19,heightMeters:2,crownRadiusMeters:.6,trunkRadiusMeters:.045,branchLevels:1,branches:3,branchSegments:6,density:28,flowers:{density:2,sizeMeters:.15,petals:5}};
const visible=(mesh:Mesh)=>mesh.material as MeshPhysicalMaterial;
function checkCoverage(mesh:Mesh){
 const material=visible(mesh),depth=mesh.customDepthMaterial as MeshDepthMaterial,distance=mesh.customDistanceMaterial as MeshDistanceMaterial;
 expect(material.alphaHash).toBe(true);expect(material.alphaTest).toBe(0);expect(material.transparent).toBe(false);
 expect(depth).toBeInstanceOf(MeshDepthMaterial);expect(distance).toBeInstanceOf(MeshDistanceMaterial);
 for(const shadow of [depth,distance]){expect(shadow.alphaHash).toBe(true);expect(shadow.alphaTest).toBe(0);expect(shadow.map).toBe(material.map);expect(shadow.alphaToCoverage).toBe(false);}
 return{depth,distance};
}
function hashMeshes(root:Mesh['parent']){const meshes:Mesh[]=[];root?.traverse(object=>{if(object instanceof Mesh&&!Array.isArray(object.material)&&object.material.alphaHash)meshes.push(object);});return meshes;}
function watched(resources:readonly (Material|Texture)[]){const counts=new Map<Material|Texture,number>();for(const resource of resources)if(!counts.has(resource)){counts.set(resource,0);resource.addEventListener('dispose',()=>counts.set(resource,counts.get(resource)!+1));}return counts;}
function manifest(library:ReturnType<typeof createFoliageTerrainLibrary>){return compileTerrain({version:1,seed:1,bounds:{width:20,depth:20,cells:4},assets:library.assets,regions:[],placements:[{id:'tree',asset:'tree',position:{x:0,z:0}}]});}

it.each(['instanced','merged'] as const)('%s leaves and petals use the same hashed coverage for every prepared shadow tier',async leafMode=>{
 const bake=await generateFoliage(recipe,{resolution:32}),view=new FoliageView(bake,{leafMode});
 try{
  const meshes=hashMeshes(view.root);expect(meshes).toHaveLength(2);expect((view.root.children[0] as Mesh).customDepthMaterial).toBeUndefined();
  for(const mesh of meshes){const initial=checkCoverage(mesh),source=mesh.geometry,bank=readGeneratedMeshLod(mesh)!;expect(bank).toHaveLength(4);
   for(const level of bank){mesh.geometry=level.geometry;expect(checkCoverage(mesh)).toEqual(initial);}mesh.geometry=source;
  }
 }finally{view.dispose();}
});

it('engine-owned alpha shadows do not disable distant foliage LOD or change source state after restoration',async()=>{
 const bake=await generateFoliage(recipe,{resolution:32}),view=new FoliageView(bake),leaf=view.root.children[1] as InstancedMesh,source=leaf.geometry,bank=readGeneratedMeshLod(leaf)!,scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,5000),policy=new RenderVisibility();
 view.root.position.z=-1000;scene.add(view.root);
 try{policy.prepare(scene,camera,720);expect(leaf.geometry).toBe(bank[3].geometry);expect(leaf.count).toBe(bake.model.leaves.length);checkCoverage(leaf);policy.restore();expect(leaf.geometry).toBe(source);checkCoverage(leaf);}finally{policy.dispose();view.dispose();}
});
it('retains correct leaf and petal shadows when standalone and terrain LOD are disabled',async()=>{
 const bake=await generateFoliage(recipe,{resolution:32}),view=new FoliageView(bake,{lod:false}),library=createFoliageTerrainLibrary([{id:'tree',bake}]),terrain=new TerrainView(manifest(library),{surface:false,lod:false,assetFactory:library.assetFactory});
 try{for(const root of [view.root,terrain.root]){const meshes=hashMeshes(root);expect(meshes).toHaveLength(2);for(const mesh of meshes)checkCoverage(mesh);}}finally{view.dispose();terrain.dispose();library.dispose();}
});

it('material-only foliage edits rebind fresh coverage maps and release each shadow pair once',async()=>{
 const bake=await generateFoliage(recipe,{resolution:32}),view=new FoliageView(bake),leaf=view.root.children[1] as Mesh,geometry=leaf.geometry,oldMaterial=visible(leaf),oldMap=oldMaterial.map!,oldShadows=checkCoverage(leaf),oldCounts=watched([oldMaterial,oldMap,oldShadows.depth,oldShadows.distance]);
 const replacement=await generateMaterial({...bake.leaf.recipe,color:'#748b32'},{resolution:32,alphaMode:'hash'});
 view.update({...bake,leaf:replacement});expect(leaf.geometry).toBe(geometry);expect(visible(leaf)).not.toBe(oldMaterial);expect(visible(leaf).map).not.toBe(oldMap);const current=checkCoverage(leaf),currentCounts=watched([visible(leaf),visible(leaf).map!,current.depth,current.distance]);
 for(const count of oldCounts.values())expect(count).toBe(1);view.dispose();view.dispose();for(const count of oldCounts.values())expect(count).toBe(1);for(const count of currentCounts.values())expect(count).toBe(1);
});

it.each([false,true])('terrain prototype shadows are view-owned with geometry loans %s',async loans=>{
 const bake=await generateFoliage(recipe,{resolution:32}),library=createFoliageTerrainLibrary([{id:'tree',bake}]),accepted=manifest(library),a=new TerrainView(accepted,{surface:false,assetFactory:loans?library.assetFactory:asset=>library.assetFactory(asset)}),b=new TerrainView(accepted,{surface:false,assetFactory:loans?library.assetFactory:asset=>library.assetFactory(asset)});
 try{
  const am=hashMeshes(a.root),bm=hashMeshes(b.root);expect(am).toHaveLength(8);expect(bm).toHaveLength(8);
  for(const mesh of [...am,...bm])checkCoverage(mesh);
  const shadowByMaterial=(meshes:Mesh[])=>{const byMaterial=new Map<Material,{depth:MeshDepthMaterial;distance:MeshDistanceMaterial}>();for(const mesh of meshes){const material=visible(mesh),pair=checkCoverage(mesh);if(byMaterial.has(material)){expect(pair.depth).toBe(byMaterial.get(material)!.depth);expect(pair.distance).toBe(byMaterial.get(material)!.distance);}else byMaterial.set(material,pair);}return byMaterial;};
  const ap=shadowByMaterial(am),bp=shadowByMaterial(bm);expect(ap.size).toBe(2);expect(bp.size).toBe(2);
  for(const av of ap.values())for(const bv of bp.values()){expect(av.depth).not.toBe(bv.depth);expect(av.distance).not.toBe(bv.distance);}
  const resources=(pairs:ReturnType<typeof shadowByMaterial>)=>[...pairs].flatMap(([material,pair])=>[material,pair.depth,pair.distance,(material as MeshPhysicalMaterial).map!]);
  const ac=watched(resources(ap)),bc=watched(resources(bp)),woodA=a.root.getObjectsByProperty('isInstancedMesh',true)[0] as InstancedMesh,woodB=b.root.getObjectsByProperty('isInstancedMesh',true)[0] as InstancedMesh;
  if(loans)expect(woodA.geometry).toBe(woodB.geometry);const bank=readGeneratedGeometryLod(woodB.geometry)!,geometryReleases=bank.map(()=>0);bank.forEach((level,index)=>level.geometry.addEventListener('dispose',()=>geometryReleases[index]++));
  library.dispose();for(const count of [...ac.values(),...bc.values()])expect(count).toBe(0);a.dispose();a.dispose();for(const count of ac.values())expect(count).toBe(1);for(const count of bc.values())expect(count).toBe(0);expect(geometryReleases).toEqual([0,0,0,0]);
  for(const mesh of bm)checkCoverage(mesh);b.dispose();b.dispose();for(const count of bc.values())expect(count).toBe(1);expect(geometryReleases).toEqual([1,1,1,1]);
 }finally{a.dispose();b.dispose();library.dispose();}
});

it('does not turn optical foliage materials into hashed cutouts or replace their optical policy',async()=>{
 const initial=await generateFoliage(recipe,{resolution:32}),glass=MATERIAL_OPTICAL_PRESETS.find(p=>p.id==='clear-glass')!.recipe,bake=await generateFoliage({...recipe,flowers:{density:0},materials:{bark:initial.bark.recipe,leaf:glass}},{resolution:32}),view=new FoliageView(bake);
 try{const leaf=view.root.children[1] as Mesh,material=visible(leaf);expect(material.transmission).toBe(1);expect(material.alphaHash).toBe(false);expect(material.alphaTest).toBe(0);expect(leaf.customDepthMaterial).toBeUndefined();expect(leaf.customDistanceMaterial).toBeUndefined();}finally{view.dispose();}
});
