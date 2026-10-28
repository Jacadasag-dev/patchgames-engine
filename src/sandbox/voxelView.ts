import * as THREE from 'three';
import type {VoxelField,VoxelSurfaceCache} from './voxels.ts';
import {isInspectionCameraFrameActive} from './inspectionCamera.ts';

/** One culled chunk mesh, with shared caller-owned materials. Only changed chunks
 * are replaced. Caller selects a bounded horizon and owns lights/camera/palette. */
export class VoxelWorldView {
  readonly root=new THREE.Group();
  private chunks=new Map<string,{mesh:THREE.Mesh;revision:number}>();
  private field:VoxelField|undefined;
  private readonly materials:THREE.Material[];
  private readonly maxChunks:number;
  private jobs=new Map<string,{x:number;z:number;revision:number;work:Generator<void,THREE.BufferGeometry>}>();
  private initialized=false;
  private columnCaches=new Map<string,VoxelSurfaceCache>();
  constructor(materials:THREE.Material[],maxChunks=81){
    this.materials=materials;this.maxChunks=maxChunks;
    if(!Number.isInteger(maxChunks)||maxChunks<1||maxChunks>128)throw new Error('Voxel view supports 1..128 active chunks.');
  }
  update(field:VoxelField,coordinates:readonly {x:number;z:number}[]):void{
    if(this.field!==field){this.dispose();this.field=field;}
    const wanted=new Set(coordinates.map(p=>`${p.x}:${p.z}`));
    if(wanted.size>this.maxChunks)throw new Error('Voxel view chunk budget exceeded.');
    for(const [key,item] of this.chunks)if(!wanted.has(key)){item.mesh.removeFromParent();item.mesh.geometry.dispose();this.chunks.delete(key);}
    for(const key of this.jobs.keys())if(!wanted.has(key))this.jobs.delete(key);
    for(const key of this.columnCaches.keys())if(!wanted.has(key))this.columnCaches.delete(key);
    for(const {x,z} of coordinates){
      if(!Number.isSafeInteger(x)||!Number.isSafeInteger(z))throw new Error('Invalid voxel view chunk.');
      const key=`${x}:${z}`,old=this.chunks.get(key),revision=field.chunkRevision(x,z);if(old?.revision===revision)continue;
      if(this.jobs.get(key)?.revision!==revision){
        const cache=this.columnCaches.get(key)??new Map();this.columnCaches.set(key,cache);
        this.jobs.set(key,{x,z,revision,work:this.build(field,x,z,cache)});
      }
    }
    // Initial construction and fixed-time inspection finish before display.
    // Ordinary edits/streaming retain their old meshes while bounded column
    // slices run; no one chunk rebuild can drain every pending mesh in a frame.
    const drain=!this.initialized||isInspectionCameraFrameActive(),started=performance.now();let columns=0;
    for(const [key,job] of this.jobs){
      while(drain||(columns<128&&performance.now()-started<3)){
        const result=job.work.next();columns++;
        if(result.done){this.install(key,job.revision,result.value);this.jobs.delete(key);if(!drain)return;break;}
      }
      if(!drain&&(columns>=128||performance.now()-started>=3))break;
    }
    if(!this.jobs.size&&wanted.size)this.initialized=true;
  }
  private *build(field:VoxelField,x:number,z:number,cache:VoxelSurfaceCache):Generator<void,THREE.BufferGeometry>{
      const data=yield* field.surfaceSteps(x,z,cache,true),counts=new Map<number,number>();
      for(let face=0;face<data.materials.length;face++){
        const id=data.materials[face];if(!this.materials[id])throw new Error('Missing voxel material.');
        counts.set(id,(counts.get(id)??0)+1);if(face%128===127)yield;
      }
      const geometry=new THREE.BufferGeometry(),offsets=new Map<number,number>();let offset=0;
      for(const [material,count] of [...counts].sort((a,b)=>a[0]-b[0])){
        offsets.set(material,offset);geometry.addGroup(offset*6,count*6,material);offset+=count;
      }
      const positions=new Float32Array(offset*18),normals=new Float32Array(offset*18),uvs=new Float32Array(offset*12);
      yield;
      for(let face=0;face<data.materials.length;face++){
        const id=data.materials[face],to=offsets.get(id)!;offsets.set(id,to+1);
        for(let i=0;i<18;i++){positions[to*18+i]=data.positions[face*18+i];normals[to*18+i]=data.normals[face*18+i];}
        for(let i=0;i<12;i++)uvs[to*12+i]=data.uvs[face*12+i];
        if(face%128===127)yield;
      }
      // BufferAttribute retains the typed storage; Float32BufferAttribute copies it.
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));
      geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
      // Avoid Three scanning every vertex on the first rendered frame.
      const size=field.chunkSize,b=field.bounds,center=new THREE.Vector3((x+.5)*size,(b.minY+b.maxY)/2,(z+.5)*size);
      geometry.boundingSphere=new THREE.Sphere(center,Math.hypot(size/2,(b.maxY-b.minY)/2,size/2));
      return geometry;
  }
  private install(key:string,revision:number,geometry:THREE.BufferGeometry):void{
      const old=this.chunks.get(key);
      const mesh=new THREE.Mesh(geometry,this.materials);mesh.castShadow=mesh.receiveShadow=true;
      if(old){old.mesh.removeFromParent();old.mesh.geometry.dispose();}
      this.root.add(mesh);this.chunks.set(key,{mesh,revision});
  }
  inspection(){return{chunks:this.chunks.size,pendingChunks:this.jobs.size,triangles:[...this.chunks.values()].reduce((n,item)=>n+item.mesh.geometry.getAttribute('position').count/3,0)};}
  dispose(){for(const item of this.chunks.values())item.mesh.geometry.dispose();this.chunks.clear();this.jobs.clear();this.columnCaches.clear();this.initialized=false;this.root.clear();}
}
