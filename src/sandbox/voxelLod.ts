import * as THREE from 'three';
import type {VoxelSurface} from './voxels.ts';
import {generatedLodMaterialSafe} from './generatedLod.ts';
const coalescedGeometry=new WeakSet<THREE.BufferGeometry>();
/** Renderer-side material compatibility must be checked again after live edits. */
export function markVoxelCoalescedGeometry(source:THREE.BufferGeometry):void{coalescedGeometry.add(source);}
export function isVoxelCoalescedGeometry(source:THREE.BufferGeometry):boolean{return coalescedGeometry.has(source);}

/** Texture phases must repeat identically at every integer block boundary.
 * Clamp, mirrored, fractional-repeat and custom shader materials stay unmerged. */
export function voxelMaterialCanMerge(material:THREE.Material):boolean{
  if(!generatedLodMaterialSafe(material))return false;
  const descriptors=Object.getOwnPropertyDescriptors(material);
  if(Object.values(descriptors).some(descriptor=>!('value'in descriptor)))return false;
  if('vertexColors'in material&&material.vertexColors)return false;
  for(const descriptor of Object.values(descriptors)){const value=descriptor.value;if(value instanceof THREE.Texture){
    const fields=Object.getOwnPropertyDescriptors(value),repeat=fields.repeat;
    if(['wrapS','wrapT','matrixAutoUpdate','rotation','repeat'].some(key=>!fields[key]||!('value'in fields[key]))||!repeat.value||typeof repeat.value!=='object')return false;
    const axes=Object.getOwnPropertyDescriptors(repeat.value);
    if(!axes.x||!('value'in axes.x)||!axes.y||!('value'in axes.y)||fields.wrapS.value!==THREE.RepeatWrapping||fields.wrapT.value!==THREE.RepeatWrapping||!fields.matrixAutoUpdate.value||fields.rotation.value!==0||!Number.isInteger(axes.x.value)||!Number.isInteger(axes.y.value))return false;
  }}
  return true;
}
const directions=[{n:[1,0,0],u:1,v:2},{n:[-1,0,0],u:2,v:1},{n:[0,1,0],u:2,v:0},{n:[0,-1,0],u:0,v:2},{n:[0,0,1],u:0,v:1},{n:[0,0,-1],u:1,v:0}];
const corners=[[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]];
interface Face {face:number;u:number;v:number}
interface Plane {material:number;direction:typeof directions[number];axis:number;plane:number;cells:Map<string,Face>}

/** Exact zero-error coplanar coalescing, prepared inside the existing yielded
 * chunk job. Integer perimeter vertices prevent T-junctions, including chunk
 * seams. No coarse voxel sampling, cave filling, boundary or collision edits. */
export function* coalesceVoxelSurfaceSteps(source:VoxelSurface,canMerge:(material:number)=>boolean):Generator<void,VoxelSurface>{
  const faces=source.materials.length;
  if(source.positions.length!==faces*18||source.normals.length!==faces*18||source.uvs.length!==faces*12)throw Error('Voxel LOD requires complete source faces.');
  // A complex checkerboard chunk retains its already valid source. This bounds
  // the disposable optimization's extra hash-map/array working set.
  if(faces>65536)return source;
  const planes=new Map<string,Plane>(),out:VoxelSurface={positions:[],normals:[],uvs:[],materials:[]};
  const copy=(face:number)=>{for(let i=0;i<18;i++){out.positions.push(source.positions[face*18+i]);out.normals.push(source.normals[face*18+i]);}for(let i=0;i<12;i++)out.uvs.push(source.uvs[face*12+i]);out.materials.push(source.materials[face]);};
  for(let face=0;face<faces;face++){
    const p=source.positions.slice(face*18,face*18+3),n=source.normals.slice(face*18,face*18+3),direction=directions.find(d=>d.n.every((value,index)=>value===n[index]));
    let eligible=canMerge(source.materials[face])&&!!direction&&p.every(Number.isSafeInteger);
    if(eligible){for(let i=0;i<6&&eligible;i++)for(let axis=0;axis<3;axis++)if(source.positions[face*18+i*3+axis]!==p[axis]+(axis===direction!.u?corners[i][0]:axis===direction!.v?corners[i][1]:0)||source.normals[face*18+i*3+axis]!==n[axis])eligible=false;for(let i=0;i<6&&eligible;i++)if(source.uvs[face*12+i*2]!==corners[i][0]||source.uvs[face*12+i*2+1]!==corners[i][1])eligible=false;}
    if(!eligible)copy(face);else{const d=direction!,axis=d.n.findIndex(value=>value!==0),key=source.materials[face]+':'+directions.indexOf(d)+':'+p[axis];let plane=planes.get(key);if(!plane){plane={material:source.materials[face],direction:d,axis,plane:p[axis],cells:new Map()};planes.set(key,plane);}const cell=p[d.u]+':'+p[d.v];if(plane.cells.has(cell))return source;plane.cells.set(cell,{face,u:p[d.u],v:p[d.v]});}
    if(face%128===127)yield;
  }
  let regionsSinceYield=0;
  for(const plane of planes.values()){
    const ordered=[...plane.cells.values()].sort((a,b)=>a.u-b.u||a.v-b.v),cells=plane.cells;
    for(const face of ordered){if(!cells.has(face.u+':'+face.v))continue;let width=1,height=1;
      while(cells.has((face.u+width)+':'+face.v))width++;
      rows:while(true){for(let u=0;u<width;u++)if(!cells.has((face.u+u)+':'+(face.v+height)))break rows;height++;}
      for(let u=0;u<width;u++)for(let v=0;v<height;v++){const key=(face.u+u)+':'+(face.v+v),cell=cells.get(key)!;if(2*(width+height)>=width*height*2)copy(cell.face);cells.delete(key);}
      if(2*(width+height)<width*height*2){
        const perimeter:number[][]=[];for(let u=0;u<width;u++)perimeter.push([u,0]);for(let v=0;v<height;v++)perimeter.push([width,v]);for(let u=width;u>0;u--)perimeter.push([u,height]);for(let v=height;v>0;v--)perimeter.push([0,v]);
        for(let i=0;i<perimeter.length;i++){for(const [u,v]of [[width/2,height/2],perimeter[i],perimeter[(i+1)%perimeter.length]]){const p=[0,0,0];p[plane.axis]=plane.plane;p[plane.direction.u]=face.u+u;p[plane.direction.v]=face.v+v;out.positions.push(...p);out.normals.push(...plane.direction.n);out.uvs.push(u,v);}if(i%2===1)out.materials.push(plane.material);}
      }
      if(++regionsSinceYield>=64||width*height>=128){regionsSinceYield=0;yield;}
    }
  }
  return out.positions.length<source.positions.length?out:source;
}
