import {expect,it} from 'vitest';
import * as THREE from 'three';
import {compileTerrain,type TerrainRecipe} from '../src/sandbox/terrain.ts';
import {TerrainView} from '../src/sandbox/terrainView.ts';
import {GeneratedLodAdapters,registerGeneratedGeometryLod} from '../src/sandbox/generatedLod.ts';
import {readGeneratedGeometryLod} from '../src/sandbox/generatedLod.ts';
import {TerrainInstanceLod} from '../src/sandbox/terrainInstanceLod.ts';

const recipe:TerrainRecipe={version:1,seed:2,bounds:{width:1000,depth:1000,cells:8},streaming:false,assets:[{id:'tree',footprint:{kind:'circle',radius:2},environment:{wind:{bendRadians:.08,swayHz:.6,referenceHeight:4}}}],regions:[],placements:[{id:'near',asset:'tree',position:{x:0,z:0}},{id:'far',asset:'tree',position:{x:0,z:-300}}]};
function prototype(geometries:THREE.BufferGeometry[]){
 const root=new THREE.Group(),material=new THREE.MeshStandardMaterial();
 const near=new THREE.CylinderGeometry(.2,.4,4,16),far=new THREE.CylinderGeometry(.2,.4,4,4);
 near.translate(0,2,0);far.translate(0,2,0);geometries.push(near,far);registerGeneratedGeometryLod(near,[{geometry:near,error:0},{geometry:far,error:.08}]);
 root.add(new THREE.Mesh(near,material));return root;
}
function batches(view:TerrainView){const out:THREE.InstancedMesh[]=[];view.root.traverse(object=>{if(object instanceof THREE.InstancedMesh)out.push(object);});return out;}
function frame(){const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,2000);camera.position.set(0,2,10);camera.lookAt(0,2,0);return{scene,camera,adapters:new GeneratedLodAdapters()};}
it('partitions individual source placements into different prepared tiers and restores full authored detail',()=>{
 const geometries:THREE.BufferGeometry[]=[],view=new TerrainView(compileTerrain(recipe),{surface:false,registerEnvironment:false,assetFactory:()=>prototype(geometries)}),f=frame();f.scene.add(view.root);
 const meshes=batches(view);expect(meshes.map(mesh=>mesh.count)).toEqual([2,0]);
 f.adapters.prepare(f.scene,f.camera,900);expect(meshes.map(mesh=>mesh.count)).toEqual([1,1]);const near=new THREE.Matrix4(),far=new THREE.Matrix4();meshes[0].getMatrixAt(0,near);meshes[1].getMatrixAt(0,far);expect(near.elements[14]).toBe(0);expect(far.elements[14]).toBe(-300);
 expect(view.inspection().lod).toMatchObject({instanceGroups:[{selectedCounts:[1,1],draws:2}]});f.adapters.restore();expect(meshes.map(mesh=>mesh.count)).toEqual([2,0]);
 f.adapters.prepare(f.scene,f.camera,900,false);expect(meshes.map(mesh=>mesh.count)).toEqual([2,0]);f.adapters.restore();
 const positions=Array.from({length:2},(_,i)=>{meshes[0].getMatrixAt(i,near);return near.elements[14];});expect(positions.sort((a,b)=>a-b)).toEqual([-300,0]);view.dispose();f.adapters.dispose();
});
it('wind keeps stable source identities as the visible tier buckets reorder',()=>{
 const geometries:THREE.BufferGeometry[]=[],view=new TerrainView(compileTerrain(recipe),{surface:false,registerEnvironment:false,assetFactory:()=>prototype(geometries)}),f=frame();f.scene.add(view.root);view.stepWind(3,{x:0,z:0},1);f.adapters.prepare(f.scene,f.camera,900);
 const meshes=batches(view),near=new THREE.Matrix4(),far=new THREE.Matrix4();meshes[0].getMatrixAt(0,near);meshes[1].getMatrixAt(0,far);expect(near.elements.slice(12,15)).toEqual([0,0,0]);expect(near.elements[1]!==0||near.elements[2]!==0||near.elements[4]!==0||near.elements[6]!==0).toBe(true);expect(far.elements.slice(12,15)).toEqual([0,0,-300]);
 f.adapters.restore();view.stepWind(4,{x:0,z:-300},0);f.adapters.prepare(f.scene,f.camera,900);meshes[0].getMatrixAt(0,near);expect(near.elements).toEqual(new THREE.Matrix4().elements);f.adapters.restore();view.dispose();f.adapters.dispose();
});
it.each([false,true])('disposes all prepared variant resources exactly once with LOD %s',lod=>{
 const geometries:THREE.BufferGeometry[]=[],view=new TerrainView(compileTerrain(recipe),{surface:false,lod,registerEnvironment:false,assetFactory:()=>prototype(geometries)});let count=0;for(const geometry of geometries)geometry.addEventListener('dispose',()=>count++);view.dispose();view.dispose();expect(count).toBe(geometries.length);
});
it('retains the valid single-cell terrain surface without requiring a reducible bank',()=>{
 const view=new TerrainView(compileTerrain({version:1,seed:1,bounds:{width:8,depth:8,cells:1},assets:[],regions:[]}),{registerEnvironment:false});expect(view.inspection().triangles).toBe(2);view.dispose();
});
it.each(['transparent','wireframe','shader','displacement','accessor'] as const)('keeps the entire instance group at source detail after %s material changes',change=>{
 const geometries:THREE.BufferGeometry[]=[],view=new TerrainView(compileTerrain(recipe),{surface:false,registerEnvironment:false,assetFactory:()=>prototype(geometries)}),f=frame();f.scene.add(view.root);
 const meshes=batches(view),material=(meshes[1].material as THREE.MeshStandardMaterial).clone();meshes[1].material=material;let calls=0;
 if(change==='transparent')material.transparent=true;
 else if(change==='wireframe')material.wireframe=true;
 else if(change==='shader')material.onBeforeCompile=()=>{calls++;};
 else if(change==='displacement')material.displacementMap=new THREE.Texture();
 else Object.defineProperty(material,'transparent',{get(){calls++;return false;},configurable:true});
 f.adapters.prepare(f.scene,f.camera,900);expect(meshes.map(mesh=>mesh.count)).toEqual([2,0]);expect(calls).toBe(0);
 expect(view.inspection().lod).toMatchObject({instanceGroups:[{fallbackReason:'unsupported-material'}]});
 f.adapters.restore();if(change==='accessor')Object.defineProperty(material,'transparent',{value:false,writable:true,configurable:true});view.dispose();f.adapters.dispose();
});
it.each(['positions','morph'] as const)('rejects stale per-instance banks after source %s change',change=>{
 const geometries:THREE.BufferGeometry[]=[],view=new TerrainView(compileTerrain(recipe),{surface:false,registerEnvironment:false,assetFactory:()=>prototype(geometries)}),f=frame();f.scene.add(view.root);
 const source=geometries[0];if(change==='positions'){const position=source.getAttribute('position');position.setX(0,position.getX(0)+1);position.needsUpdate=true;}
 else source.morphAttributes.position=[source.getAttribute('position').clone()];
 f.adapters.prepare(f.scene,f.camera,900);expect(batches(view).map(mesh=>mesh.count)).toEqual([2,0]);
 expect(view.inspection().lod).toMatchObject({instanceGroups:[{fallbackReason:'source-bank-changed'}]});f.adapters.restore();view.dispose();f.adapters.dispose();
});
it('never restores extra instances after the canonical source count is reduced',()=>{
 const geometries:THREE.BufferGeometry[]=[],object=prototype(geometries),mesh=object.children[0] as THREE.Mesh,source=new THREE.InstancedMesh(mesh.geometry,mesh.material,2),near=new THREE.InstancedMesh(mesh.geometry,mesh.material,2),far=new THREE.InstancedMesh(geometries[1],mesh.material,2);
 const instances=compileTerrain(recipe).instances,group=new TerrainInstanceLod(instances,[{source,batches:[near,far],levels:readGeneratedGeometryLod(mesh.geometry)!,scale:1}],5),camera=new THREE.PerspectiveCamera();
 source.count=1;group.prepare({camera,viewportHeight:900,diameter:()=>1},new THREE.Matrix4());expect(near.count).toBe(1);expect(far.count).toBe(0);group.restore();expect(near.count).toBe(1);
 group.dispose();near.dispose();far.dispose();geometries.forEach(geometry=>geometry.dispose());(mesh.material as THREE.Material).dispose();
});
it('retains source detail for authored shadow shaders on a prepared tier',()=>{
 const geometries:THREE.BufferGeometry[]=[],view=new TerrainView(compileTerrain(recipe),{surface:false,registerEnvironment:false,assetFactory:()=>prototype(geometries)}),f=frame();f.scene.add(view.root);const meshes=batches(view),depth=new THREE.MeshDepthMaterial();depth.onBeforeCompile=()=>{};meshes[1].customDepthMaterial=depth;
 f.adapters.prepare(f.scene,f.camera,900);expect(meshes.map(mesh=>mesh.count)).toEqual([2,0]);expect(view.inspection().lod).toMatchObject({instanceGroups:[{fallbackReason:'unsupported-shadow'}]});f.adapters.restore();view.dispose();depth.dispose();f.adapters.dispose();
});
