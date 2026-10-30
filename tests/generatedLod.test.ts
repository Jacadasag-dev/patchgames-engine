import {expect,it,vi} from 'vitest';
import {BoxGeometry,InstancedMesh,Matrix4,MeshStandardMaterial,Object3D,OrthographicCamera,PerspectiveCamera,Scene,Sphere,SpotLight,Vector3} from 'three';
import {GeneratedLodAdapters,generatedLodDiameter,readGeneratedGeometryLod,registerGeneratedGeometryLod,registerGeneratedMeshLod,registerGeneratedLodAdapter,selectGeneratedLodLevel} from '../src/sandbox/generatedLod.ts';
import {RenderVisibility} from '../src/sandbox/renderVisibility.ts';

it('borrows immutable tier metadata and unregisters without disposing owner resources',()=>{
 const high=new BoxGeometry(),low=new BoxGeometry(),dispose=vi.spyOn(low,'dispose'),levels=[{geometry:high,error:0},{geometry:low,error:.1}],off=registerGeneratedGeometryLod(high,levels);
 levels[1].error=1;expect(readGeneratedGeometryLod(high)![1].error).toBe(.1);expect(Object.isFrozen(readGeneratedGeometryLod(high))).toBe(true);
 off();off();expect(readGeneratedGeometryLod(high)).toBeUndefined();expect(dispose).not.toHaveBeenCalled();high.dispose();low.dispose();
});
it('invalidates prepared banks when source attributes or draw range change',()=>{
 const high=new BoxGeometry(),low=new BoxGeometry(),off=registerGeneratedGeometryLod(high,[{geometry:high,error:0},{geometry:low,error:.1}]);
 high.getAttribute('position').needsUpdate=true;expect(readGeneratedGeometryLod(high)).toBeUndefined();off();
 const off2=registerGeneratedGeometryLod(high,[{geometry:high,error:0},{geometry:low,error:.1}]);high.setDrawRange(0,3);expect(readGeneratedGeometryLod(high)).toBeUndefined();off2();high.dispose();low.dispose();
});
it('rejects malformed banks and nonnested instance counts before rendering',()=>{
 const high=new BoxGeometry(),low=new BoxGeometry(),mesh=new InstancedMesh(high,new MeshStandardMaterial(),10);
 for(const levels of [Array(2),[{geometry:high,error:.1},{geometry:low,error:0}],[{geometry:high,error:0},{geometry:low,error:Infinity}]])expect(()=>registerGeneratedGeometryLod(high,levels)).toThrow();
 expect(()=>registerGeneratedMeshLod(mesh,[{geometry:high,error:0,instanceCount:10},{geometry:low,error:.1,instanceCount:11}])).toThrow();
 expect(()=>registerGeneratedMeshLod(mesh,[{geometry:high,error:0,instanceCount:4},{geometry:low,error:.1,instanceCount:5}])).toThrow();high.dispose();low.dispose();mesh.material.dispose();mesh.dispose();
});
it('uses projected error hysteresis, respects near protection and permits exact coarse terrain',()=>{
 const geometry=new BoxGeometry(),levels=[{geometry,error:0},{geometry,error:.1}];
 expect(selectGeneratedLodLevel(levels,18)).toBe(1);expect(selectGeneratedLodLevel(levels,25,1)).toBe(1);expect(selectGeneratedLodLevel(levels,32,1)).toBe(0);
 expect(selectGeneratedLodLevel([{geometry,error:0},{geometry,error:0}],200)).toBe(1);
 expect(selectGeneratedLodLevel([{geometry,error:0},{geometry,error:0}],Infinity)).toBe(1);
 expect(selectGeneratedLodLevel([{geometry,error:0},{geometry,error:0}],200,0,0)).toBe(1);geometry.dispose();
});
it('accounts for zoom, projection and the nearest bound rather than centre distance',()=>{
 const camera=new PerspectiveCamera(60,1,.1,1000),sphere=new Sphere(new Vector3(0,0,-100),1);camera.updateMatrixWorld();const normal=generatedLodDiameter(camera,720,sphere);camera.zoom=2;camera.updateProjectionMatrix();expect(generatedLodDiameter(camera,720,sphere)).toBeCloseTo(normal*2);
 sphere.center.z=-.5;expect(generatedLodDiameter(camera,720,sphere)).toBe(Infinity);
 const ortho=new OrthographicCamera(-10,10,10,-10,.1,1000);ortho.updateMatrixWorld();sphere.center.z=-100;expect(generatedLodDiameter(ortho,1000,sphere)).toBeCloseTo(100);
});
it('selects prepared instanced leaf prefixes using aggregate bounds and restores authored state',()=>{
 const high=new BoxGeometry(.2,.4,.01),low=new BoxGeometry(.2,.4,.01),mat=new MeshStandardMaterial(),mesh=new InstancedMesh(high,mat,10),scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,1000),policy=new RenderVisibility();
 for(let i=0;i<10;i++)mesh.setMatrixAt(i,new Matrix4().makeTranslation(i/10,0,0));mesh.position.z=-200;mesh.computeBoundingSphere();scene.add(mesh);
 const off=registerGeneratedMeshLod(mesh,[{geometry:high,error:0,instanceCount:10},{geometry:low,error:.02,instanceCount:3}]);
 policy.prepare(scene,camera,720);expect(mesh.geometry).toBe(low);expect(mesh.count).toBe(3);expect(policy.stats.preparedLodMeshes).toBe(1);
 policy.restore();expect(mesh.geometry).toBe(high);expect(mesh.count).toBe(10);
 policy.prepare(scene,camera,720,undefined,false);expect(mesh.count).toBe(10);expect(mesh.geometry).toBe(high);policy.dispose();off();high.dispose();low.dispose();mat.dispose();mesh.dispose();
});
it('restores every partially prepared adapter after a failed render preparation',()=>{
 const scene=new Scene(),a=new Object3D(),b=new Object3D(),camera=new PerspectiveCamera(),order:string[]=[],manager=new GeneratedLodAdapters();scene.add(a,b);
 const offA=registerGeneratedLodAdapter(a,{prepare(frame){expect(frame.enabled).toBe(false);order.push('a');},restore(){order.push('restore-a');}}),offB=registerGeneratedLodAdapter(b,{prepare(){order.push('b');throw Error('failed');},restore(){order.push('restore-b');}});
 expect(()=>manager.prepare(scene,camera,720,false)).toThrow('failed');expect(order).toEqual(['a','b','restore-b','restore-a']);manager.restore();offA();offB();
});
it('does not resurrect hidden instances or replace newly morphed source geometry',()=>{
 const high=new BoxGeometry(),low=new BoxGeometry(),material=new MeshStandardMaterial(),mesh=new InstancedMesh(high,material,10),scene=new Scene(),camera=new PerspectiveCamera(60,1,.1,1000),policy=new RenderVisibility();
 for(let i=0;i<10;i++)mesh.setMatrixAt(i,new Matrix4());mesh.position.z=-200;scene.add(mesh);const off=registerGeneratedMeshLod(mesh,[{geometry:high,error:0,instanceCount:10},{geometry:low,error:.02,instanceCount:5}]);
 mesh.count=2;policy.prepare(scene,camera,720);expect(mesh.count).toBe(2);expect(mesh.geometry).toBe(high);policy.restore();off();mesh.count=10;
 const off2=registerGeneratedGeometryLod(high,[{geometry:high,error:0},{geometry:low,error:.02}]);high.morphAttributes.position=[high.getAttribute('position').clone()];expect(readGeneratedGeometryLod(high)).toBeUndefined();policy.prepare(scene,camera,720);expect(mesh.geometry).toBe(high);expect(mesh.count).toBe(10);policy.dispose();off2();high.dispose();low.dispose();material.dispose();mesh.dispose();
});
it('uses the current spotlight range before evaluating distant shadow detail',()=>{
 const scene=new Scene(),root=new Object3D(),light=new SpotLight(0xffffff,1,2000,.1),camera=new PerspectiveCamera(60,1,.1,5000),sphere=new Sphere(new Vector3(0,0,-1000),1),manager=new GeneratedLodAdapters();
 light.castShadow=true;light.target.position.z=-2000;scene.add(root,light,light.target);let projected=0;
 const off=registerGeneratedLodAdapter(root,{prepare(frame){projected=frame.diameter(sphere,true);},restore(){}});manager.prepare(scene,camera,720);expect(light.shadow.camera.far).toBe(2000);expect(projected).toBeGreaterThan(generatedLodDiameter(camera,720,sphere)*2);manager.restore();off();
});
