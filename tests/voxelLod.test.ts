import {expect,it} from 'vitest';
import * as THREE from 'three';
import {VoxelField,type VoxelSurface} from '../src/sandbox/voxels.ts';
import {VoxelWorldView} from '../src/sandbox/voxelView.ts';
import {coalesceVoxelSurfaceSteps,voxelMaterialCanMerge} from '../src/sandbox/voxelLod.ts';
import {readGeneratedGeometryLod} from '../src/sandbox/generatedLod.ts';
import {RenderVisibility} from '../src/sandbox/renderVisibility.ts';

function coalesce(source:VoxelSurface){const work=coalesceVoxelSurfaceSteps(source,()=>true);let value=work.next();while(!value.done)value=work.next();return value.value;}
/** Sample every integer face cell at an off-diagonal interior point. This
 * catches filling holes, dropping material boundaries and incorrect winding. */
function coverage(surface:VoxelSurface,textureSamples?:Map<string,number[]>){
 const output=new Set<string>();
 for(let triangle=0;triangle<surface.positions.length/9;triangle++){
  const p=Array.from({length:3},(_,i)=>surface.positions.slice(triangle*9+i*3,triangle*9+i*3+3)),n=surface.normals.slice(triangle*9,triangle*9+3),axis=n.findIndex(value=>value!==0),u=(axis+1)%3,v=(axis+2)%3;
  const minU=Math.floor(Math.min(...p.map(q=>q[u]))),maxU=Math.ceil(Math.max(...p.map(q=>q[u]))),minV=Math.floor(Math.min(...p.map(q=>q[v]))),maxV=Math.ceil(Math.max(...p.map(q=>q[v]))),a=p[0],b=p[1],c=p[2],den=(b[v]-c[v])*(a[u]-c[u])+(c[u]-b[u])*(a[v]-c[v]);
  const normal=new THREE.Vector3(...b as [number,number,number]).sub(new THREE.Vector3(...a as [number,number,number])).cross(new THREE.Vector3(...c as [number,number,number]).sub(new THREE.Vector3(...a as [number,number,number])));expect(normal.dot(new THREE.Vector3(...n as [number,number,number]))).toBeGreaterThan(0);
  for(let x=minU;x<maxU;x++)for(let y=minV;y<maxV;y++){const q=x+.371,r=y+.413,w1=((b[v]-c[v])*(q-c[u])+(c[u]-b[u])*(r-c[v]))/den,w2=((c[v]-a[v])*(q-c[u])+(a[u]-c[u])*(r-c[v]))/den,w3=1-w1-w2;if(w1>=0&&w2>=0&&w3>=0){const key=[axis,n[axis],a[axis],x,y,surface.materials[Math.floor(triangle/2)]].join(':');output.add(key);if(textureSamples){const uv=[0,1].map(channel=>{const value=surface.uvs[triangle*6+channel]*w1+surface.uvs[triangle*6+2+channel]*w2+surface.uvs[triangle*6+4+channel]*w3;return value-Math.floor(value);});textureSamples.set(key,uv);}}}
 }return output;
}
const flat=()=>new VoxelField({bounds:{minX:0,maxX:32,minY:0,maxY:8,minZ:0,maxZ:32},chunkSize:32,sample:(_x,y)=>y<4?1:0});
it('prepares substantially fewer exact triangles without removing integer perimeter vertices',()=>{
 const field=flat(),source=field.surface(0,0),before=JSON.stringify(source),lower=coalesce(source);
 expect(lower.positions.length).toBeLessThan(source.positions.length*.15);expect(coverage(lower)).toEqual(coverage(source));expect(JSON.stringify(source)).toBe(before);
 const points=new Set(Array.from({length:lower.positions.length/3},(_,i)=>lower.positions.slice(i*3,i*3+3).join(':')));
 for(let x=0;x<=32;x++)for(const z of [0,32])expect(points.has([x,4,z].join(':'))).toBe(true);
});
it('preserves caves, material boundaries, negative-coordinate seams and mined/placed cells',()=>{
 const field=new VoxelField({bounds:{minX:-8,maxX:8,minY:0,maxY:8,minZ:-8,maxZ:8},chunkSize:8,sample:(x,y,z)=>y<6&&!(y===2&&z>=-2&&z<=2)?(x<0?1:2):0});
 for(const edits of [[],[{x:-1,y:5,z:0,material:0},{x:0,y:7,z:0,material:3}]]){field.setEdits(edits);for(const x of [-1,0])for(const z of [-1,0]){const source=field.surface(x,z),lower=coalesce(source);expect(coverage(lower)).toEqual(coverage(source));}}
});
it('preserves the original repeated UV phase on every block face orientation',()=>{
 const source=flat().surface(0,0),lower=coalesce(source),a=new Map<string,number[]>(),b=new Map<string,number[]>();coverage(source,a);coverage(lower,b);expect(b.size).toBe(a.size);for(const [key,uv]of a){expect(b.get(key)![0]).toBeCloseTo(uv[0],10);expect(b.get(key)![1]).toBeCloseTo(uv[1],10);}
});
it('keeps clamped/fractional-repeat/custom materials on their original face representation',()=>{
 const material=new THREE.MeshStandardMaterial(),texture=new THREE.DataTexture(new Uint8Array(16),2,2);material.map=texture;
 expect(voxelMaterialCanMerge(material)).toBe(false);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;expect(voxelMaterialCanMerge(material)).toBe(true);texture.repeat.x=.5;expect(voxelMaterialCanMerge(material)).toBe(false);texture.repeat.x=2;texture.rotation=.2;expect(voxelMaterialCanMerge(material)).toBe(false);texture.rotation=0;material.transparent=true;expect(voxelMaterialCanMerge(material)).toBe(false);material.transparent=false;material.onBeforeCompile=()=>{};expect(voxelMaterialCanMerge(material)).toBe(false);material.dispose();texture.dispose();
});
it('registers a zero-error bank and releases its reduced geometry when a voxel chunk is unloaded',()=>{
 const materials=[new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial()],view=new VoxelWorldView(materials),field=flat();view.update(field,[{x:0,z:0}]);const source=(view.root.children[0] as THREE.Mesh).geometry,bank=readGeneratedGeometryLod(source)!;expect(bank).toHaveLength(2);expect(bank[1].error).toBe(0);expect(bank[1].geometry.groups.map(group=>group.materialIndex)).toEqual([1]);let count=0;bank[1].geometry.addEventListener('dispose',()=>count++);view.update(field,[]);view.dispose();expect(count).toBe(1);materials.forEach(material=>material.dispose());
});
it('selects exact coalescing inside the source chunk despite an unused transparent palette slot',()=>{
 const materials=[new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial({transparent:true,opacity:.5})],view=new VoxelWorldView(materials);view.update(flat(),[{x:0,z:0}]);const mesh=view.root.children[0] as THREE.Mesh,source=mesh.geometry,bank=readGeneratedGeometryLod(source)!,scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(70,1,.1,1000),visibility=new RenderVisibility();camera.position.set(16,2,16);camera.lookAt(16,2,0);scene.add(view.root);
 visibility.prepare(scene,camera,900);expect(mesh.geometry).toBe(bank[1].geometry);visibility.restore();expect(mesh.geometry).toBe(source);
 // A live clamp/fractional repeat edit invalidates the exact UV-phase contract.
 const texture=new THREE.DataTexture(new Uint8Array(16),2,2);materials[1].map=texture;visibility.prepare(scene,camera,900);expect(mesh.geometry).toBe(source);visibility.restore();texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.x=.5;visibility.prepare(scene,camera,900);expect(mesh.geometry).toBe(source);visibility.restore();texture.repeat.x=1;visibility.prepare(scene,camera,900);expect(mesh.geometry).toBe(bank[1].geometry);visibility.restore();
 visibility.dispose();view.dispose();materials.forEach(material=>material.dispose());texture.dispose();
});
it('continues publishing edited cave chunks when mining changes arrive every six frames',()=>{
 const field=new VoxelField({bounds:{minX:0,maxX:32,minY:0,maxY:64,minZ:0,maxZ:32},chunkSize:32,sample:(x,y,z)=>y<32+Math.floor(Math.sin(x*.6)*5+Math.cos(z*.4)*4)&&!(y>8&&y<13&&x>3&&x<28&&z>3&&z<28)?1+y%3:0}),materials=Array.from({length:4},()=>new THREE.MeshBasicMaterial()),view=new VoxelWorldView(materials);view.update(field,[{x:0,z:0}]);let previous=view.root.children[0],published=0;
 for(let frame=0;frame<180;frame++){if(frame%6===0)field.setEdits([{x:1,y:30,z:1,material:(frame/6)%2?1:0}]);view.update(field,[{x:0,z:0}]);if(view.root.children[0]!==previous){published++;previous=view.root.children[0];}}
 expect(published).toBeGreaterThan(0);view.dispose();materials.forEach(material=>material.dispose());
});
