import * as THREE from 'three';
import type {TerrainInstance} from './terrain.ts';
import {generatedLodDiameter,generatedLodMaterialSafe,readGeneratedGeometryLod,selectGeneratedLodLevel,type GeneratedLodLevel} from './generatedLod.ts';
import {isGeneratedAlphaShadowMaterial} from './generatedAlpha.ts';

export interface TerrainInstanceLodFrame {
  camera:THREE.Camera;viewportHeight:number;
  enabled?:boolean;
  diameter(sphere:THREE.Sphere,castsShadow?:boolean):number;
}
export interface TerrainInstanceLodPart {source:THREE.InstancedMesh;batches:THREE.InstancedMesh[];levels:readonly GeneratedLodLevel[];scale:number}

/** Compact source placements into prepared tier batches. Wind owns the hidden
 * source matrices; render compaction never overwrites their stable source IDs. */
export class TerrainInstanceLod {
  readonly instances:readonly TerrainInstance[];
  readonly parts:readonly TerrainInstanceLodPart[];
  readonly radius:number;
  private readonly choices:Uint8Array;
  private readonly matrix=new THREE.Matrix4();
  private readonly sphere=new THREE.Sphere();
  private selectedCounts:number[];
  private changed=0;
  private prepared=false;
  private fallbackReason:string|null=null;
  private readonly checkedMaterials=new Set<THREE.Material>();
  readonly levels:readonly GeneratedLodLevel[];
  constructor(instances:readonly TerrainInstance[],parts:readonly TerrainInstanceLodPart[],radius:number){
    this.instances=instances;this.parts=parts;this.radius=radius;
    this.choices=new Uint8Array(instances.length);const count=Math.max(...parts.map(part=>part.levels.length));
    this.levels=Array.from({length:count},(_,level)=>({geometry:parts[0].levels[Math.min(level,parts[0].levels.length-1)].geometry,error:Math.max(...parts.map(part=>{
      const variant=part.levels[Math.min(level,part.levels.length-1)],geometry=part.levels[0].geometry;geometry.computeBoundingSphere();
      return variant.error*(geometry.boundingSphere?.radius??radius)*part.scale/radius;
    }))}));this.selectedCounts=Array(count).fill(0);this.selectedCounts[0]=instances.length;
  }
  prepare(frame:TerrainInstanceLodFrame,worldMatrix:THREE.Matrix4):void{
    this.fallbackReason=frame.enabled===false?'disabled':this.unsafeReason();
    if(this.fallbackReason){
      this.changed=0;for(const level of this.choices)if(level!==0)this.changed++;
      this.choices.fill(0);this.selectedCounts.fill(0);this.selectedCounts[0]=this.instances.length;
      this.syncSource();this.prepared=true;return;
    }
    const counts=Array(this.levels.length).fill(0) as number[],scale=worldMatrix.getMaxScaleOnAxis();this.changed=0;
    const castsShadow=this.parts.some(part=>part.batches[0].castShadow);
    for(let index=0;index<this.instances.length;index++){
      const instance=this.instances[index];this.sphere.center.set(instance.position.x,instance.position.y,instance.position.z).applyMatrix4(worldMatrix);this.sphere.radius=this.radius*instance.scale*scale;
      const diameter=frame.diameter?frame.diameter(this.sphere,castsShadow):generatedLodDiameter(frame.camera,frame.viewportHeight,this.sphere),level=frame.enabled===false?0:selectGeneratedLodLevel(this.levels,diameter,this.choices[index]);
      if(level!==this.choices[index])this.changed++;this.choices[index]=level;const slot=counts[level]++;
      for(const part of this.parts){part.source.getMatrixAt(index,this.matrix);part.batches[level].setMatrixAt(slot,this.matrix);}
    }
    for(const part of this.parts)for(let level=0;level<part.batches.length;level++){part.batches[level].count=counts[level];if(counts[level])part.batches[level].instanceMatrix.needsUpdate=true;}
    this.selectedCounts=counts;this.prepared=true;
  }
  private unsafeReason():string|null{
    this.checkedMaterials.clear();
    const materialSafe=(material:THREE.Material|THREE.Material[])=>{
      if(Array.isArray(material))return false;if(this.checkedMaterials.has(material))return true;
      if(!generatedLodMaterialSafe(material))return false;this.checkedMaterials.add(material);return true;
    };
    const shadowsSafe=(mesh:THREE.Mesh)=>(!mesh.customDepthMaterial||isGeneratedAlphaShadowMaterial(mesh.customDepthMaterial))&&(!mesh.customDistanceMaterial||isGeneratedAlphaShadowMaterial(mesh.customDistanceMaterial));
    for(const part of this.parts){
      const geometry=part.source.geometry;
      if(geometry!==part.levels[0].geometry||part.source.count!==this.instances.length||Object.keys(geometry.morphAttributes).length
        ||part.levels.length>1&&readGeneratedGeometryLod(geometry)!==part.levels)return'source-bank-changed';
      for(const level of part.levels)if(Object.keys(level.geometry.morphAttributes).length)return'morphed-tier';
      if(!materialSafe(part.source.material))return'unsupported-material';
      if(!shadowsSafe(part.source))return'unsupported-shadow';
      for(const mesh of part.batches){if(!materialSafe(mesh.material))return'unsupported-material';if(!shadowsSafe(mesh))return'unsupported-shadow';}
    }
    return null;
  }
  /** Authored queries and inspection outside the render boundary see full detail. */
  restore():void{
    if(!this.prepared)return;
    this.syncSource();this.prepared=false;
  }
  /** Preserve TerrainView.stepWind's immediate full-detail presentation contract
   * for standalone callers as well as renderer-scoped LOD consumers. */
  syncSource():void{
    for(const part of this.parts){part.batches[0].geometry=part.source.geometry;part.batches[0].instanceMatrix.array.set(part.source.instanceMatrix.array);part.batches[0].instanceMatrix.needsUpdate=true;part.batches[0].count=Math.max(0,Math.min(part.source.instanceMatrix.count,Number.isInteger(part.source.count)?part.source.count:0));for(let level=1;level<part.batches.length;level++)part.batches[level].count=0;}
  }
  inspection(){const triangles=this.selectedCounts.reduce((sum,count,level)=>sum+count*this.parts.reduce((n,part)=>{const g=part.levels[Math.min(level,part.levels.length-1)].geometry;return n+(g.index?.count??g.getAttribute('position').count)/3;},0),0);return{instances:this.instances.length,levels:this.levels.length,selectedCounts:[...this.selectedCounts],triangles,draws:this.selectedCounts.filter(count=>count>0).length*this.parts.length,changed:this.changed,fallbackReason:this.fallbackReason,mode:'per-instance-prepared-buckets'};}
  dispose():void{this.restore();for(const part of this.parts)part.source.dispose();}
}

export function terrainInstanceLodLevels(geometry:THREE.BufferGeometry):readonly GeneratedLodLevel[]{return readGeneratedGeometryLod(geometry)??[{geometry,error:0}];}
