import * as THREE from 'three';
import {compileFoliage,type FoliageRecipe,type FoliageModel} from '../shared/foliageGenerator.ts';
import {materialRecipe,onMaterialRecipesChanged} from '../shared/materialRegistry.ts';
import {generateMaterial,type GeneratedMaterialPixels} from '../shared/materialGenerator.ts';
import {createGeneratedMaterialFromPixels} from './materialGenerator.ts';
export {compileFoliage,parseFoliageRecipe,foliageColliders} from '../shared/foliageGenerator.ts';
export type {FoliageRecipe,FoliageModel} from '../shared/foliageGenerator.ts';
export {FOLIAGE_PRESETS} from '../shared/foliagePresets.ts';
export interface FoliageBake {model:FoliageModel;bark:GeneratedMaterialPixels;leaf:GeneratedMaterialPixels}
/** Bake in an authoring worker/loading stage, never in a gameplay frame. */
export async function generateFoliage(input:FoliageRecipe,options:{resolution?:number;signal?:AbortSignal}={}):Promise<FoliageBake>{
  options.signal?.throwIfAborted();return bakeFoliageModel(compileFoliage(input),options);
}
/** Reuse a compiled skeleton when only shared materials change. */
export async function bakeFoliageModel(model:FoliageModel,options:{resolution?:number;signal?:AbortSignal}={}):Promise<FoliageBake>{
  options.signal?.throwIfAborted();
  const resolve=(slot:typeof model.recipe.materials.bark)=>{if(!('ref'in slot))return slot;const value=materialRecipe(slot.ref);if(!value)throw Error('Unresolved foliage material: '+slot.ref);return value;};
  const bark=resolve(model.recipe.materials.bark),leaf=resolve(model.recipe.materials.leaf);
  if(!['leaf','needle'].includes(leaf.pattern.family)&&!model.diagnostics.warnings.includes('Leaf material has no plant silhouette; full rectangular cards will render.'))model.diagnostics.warnings.push('Leaf material has no plant silhouette; full rectangular cards will render.');
  const resolution=options.resolution??{low:64,medium:128,high:256}[model.recipe.quality];
  const pixels=await Promise.all([generateMaterial(bark,{resolution,signal:options.signal}),generateMaterial(leaf,{resolution,signal:options.signal})]);
  return{model,bark:pixels[0],leaf:pixels[1]};
}
function woodGeometry(model:FoliageModel){
  const sides={low:5,medium:8,high:12}[model.recipe.quality],positions:number[]=[],uvs:number[]=[],indices:number[]=[];
  for(const branch of model.branches){const a=new THREE.Vector3(...branch.start),b=new THREE.Vector3(...branch.end),axis=b.clone().sub(a).normalize(),x=new THREE.Vector3(Math.abs(axis.y)<.9?0:1,Math.abs(axis.y)<.9?1:0,0).cross(axis).normalize(),z=axis.clone().cross(x),base=positions.length/3,length=a.distanceTo(b);
    for(let ring=0;ring<2;ring++)for(let j=0;j<=sides;j++){const angle=j/sides*Math.PI*2,radius=ring?branch.radiusEnd:branch.radiusStart,p=(ring?b:a).clone().addScaledVector(x,Math.cos(angle)*radius).addScaledVector(z,Math.sin(angle)*radius);positions.push(p.x,p.y,p.z);uvs.push(j/sides*Math.PI*2*branch.radiusStart,ring*length);}
    for(let j=0;j<sides;j++){const k=base+j,l=k+sides+1;indices.push(k,k+1,l,k+1,l+1,l);}
    const bottom=positions.length/3;positions.push(a.x,a.y,a.z,b.x,b.y,b.z);uvs.push(0,0,0,length);for(let j=0;j<sides;j++){indices.push(bottom,base+j+1,base+j);indices.push(bottom+1,base+sides+1+j,base+sides+2+j);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setIndex(indices);g.computeVertexNormals();g.computeBoundingSphere();return g;
}
function mergedLeaves(instances:THREE.InstancedMesh){
  const source=instances.geometry,p=source.attributes.position,n=source.attributes.normal,uv=source.attributes.uv,index=source.index!,count=p.count*instances.count;
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3),uvs=new Float32Array(count*2),indices=new Uint32Array(index.count*instances.count),matrix=new THREE.Matrix4(),normalMatrix=new THREE.Matrix3(),v=new THREE.Vector3();
  for(let i=0;i<instances.count;i++){instances.getMatrixAt(i,matrix);normalMatrix.getNormalMatrix(matrix);for(let j=0;j<p.count;j++){const k=i*p.count+j;v.fromBufferAttribute(p,j).applyMatrix4(matrix);positions.set(v.toArray(),k*3);v.fromBufferAttribute(n,j).applyMatrix3(normalMatrix).normalize();normals.set(v.toArray(),k*3);uvs[k*2]=uv.getX(j);uvs[k*2+1]=uv.getY(j);}for(let j=0;j<index.count;j++)indices[i*index.count+j]=i*p.count+index.getX(j);}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.computeBoundingSphere();return geometry;
}
/** Two foliage meshes: merged tapered branches and instanced curved leaf cards. */
export class FoliageView {
  readonly root=new THREE.Group();private owned:(()=>void)[]=[];private materialsOwned:(()=>void)[]=[];private geometryKey='';private disposed=false;
  private readonly options:{leafMode?:'instanced'|'merged'};
  constructor(bake:FoliageBake,options:{leafMode?:'instanced'|'merged'}={}){this.options=options;this.update(bake);}
  update(bake:FoliageBake){
    if(this.disposed)throw Error('Foliage view disposed.');
    const {model}=bake,bark=createGeneratedMaterialFromPixels(bake.bark,{uvSpace:'metres'}),leaf=createGeneratedMaterialFromPixels(bake.leaf);
    leaf.material.side=THREE.DoubleSide;leaf.material.alphaTest=.5;leaf.material.emissive.set(bake.leaf.recipe.color);leaf.material.emissiveIntensity=.08;
    const plant=bake.leaf.recipe.pattern,length=plant.family==='leaf'||plant.family==='needle'?plant.lengthMeters:bake.leaf.recipe.tileMeters[1],scale=model.recipe.leafSizeMeters/length;
    const key=JSON.stringify([{...model.recipe,name:undefined,materials:undefined},bake.leaf.recipe.tileMeters,length]);
    const oldMaterials=this.materialsOwned;this.materialsOwned=[()=>bark.dispose(),()=>leaf.dispose()];
    this.root.name=model.recipe.name;this.root.userData.foliage={recipe:model.recipe,diagnostics:model.diagnostics,bounds:model.bounds};
    if(this.geometryKey===key){(this.root.children[0] as THREE.Mesh).material=bark.material;(this.root.children[1] as THREE.Mesh).material=leaf.material;oldMaterials.forEach(dispose=>dispose());return;}
    this.geometryKey=key;const wood=woodGeometry(model),woody=new THREE.Mesh(wood,bark.material);woody.castShadow=woody.receiveShadow=true;
    const w=bake.leaf.recipe.tileMeters[0]*scale,h=bake.leaf.recipe.tileMeters[1]*scale,leafGeometry=new THREE.PlaneGeometry(w,h,2,4),p=leafGeometry.attributes.position;
    for(let i=0;i<p.count;i++){const y=p.getY(i)+model.recipe.leafSizeMeters/2;p.setY(i,y);p.setZ(i,Math.sin(Math.max(0,Math.min(1,y/model.recipe.leafSizeMeters))*Math.PI)*model.recipe.leafSizeMeters*.09);}leafGeometry.computeVertexNormals();
    const foliage=new THREE.InstancedMesh(leafGeometry,leaf.material,model.leaves.length),matrix=new THREE.Matrix4(),rotation=new THREE.Matrix4(),q=new THREE.Quaternion();foliage.castShadow=foliage.receiveShadow=true;
    model.leaves.forEach((l,i)=>{const y=new THREE.Vector3(...l.direction).normalize(),normal=new THREE.Vector3(Math.sin(l.roll)*.8,.55,Math.cos(l.roll)*.8);normal.addScaledVector(y,-normal.dot(y)).normalize();if(normal.lengthSq()<.001)normal.set(0,0,1);const x=y.clone().cross(normal).normalize(),z=x.clone().cross(y).normalize();rotation.makeBasis(x,y,z);q.setFromRotationMatrix(rotation);matrix.compose(new THREE.Vector3(...l.anchor),q,new THREE.Vector3(l.sizeScale,l.sizeScale,l.sizeScale));foliage.setMatrixAt(i,matrix);});foliage.instanceMatrix.needsUpdate=true;foliage.computeBoundingSphere();
    const merged=this.options.leafMode==='merged'?mergedLeaves(foliage):undefined,leafMesh=merged?new THREE.Mesh(merged,leaf.material):foliage;leafMesh.castShadow=leafMesh.receiveShadow=true;
    const previous=this.owned;this.root.clear();this.root.add(woody,leafMesh);this.root.userData.foliage={recipe:model.recipe,diagnostics:model.diagnostics,bounds:model.bounds};
    this.owned=[()=>{wood.dispose();leafGeometry.dispose();merged?.dispose();foliage.dispose();}];previous.forEach(dispose=>dispose());oldMaterials.forEach(dispose=>dispose());
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.owned.forEach(dispose=>dispose());this.materialsOwned.forEach(dispose=>dispose());this.owned=[];this.materialsOwned=[];this.root.clear();}
}
/** TerrainView instances this plain-mesh prototype across its placements. Its
 * terrain batches own the returned resources; do not share it with another view. */
export function createFoliageTerrainPrototype(bake:FoliageBake){return new FoliageView(bake,{leafMode:'merged'}).root;}
/** Named bark/leaf recipes follow registry edits; the last valid view survives errors. */
export async function createFoliage(input:FoliageRecipe,options:Parameters<typeof generateFoliage>[1]={}){
  const initial=await generateFoliage(input,options),view=new FoliageView(initial),ids=Object.values(initial.model.recipe.materials).flatMap(slot=>'ref'in slot?[slot.ref]:[]);let disposed=false,generation=0,ready=Promise.resolve(),currentModel=initial.model;
  const off=onMaterialRecipesChanged(changed=>{if(!ids.some(id=>changed.has(id)))return;const current=++generation;ready=bakeFoliageModel(currentModel,options).then(bake=>{if(!disposed&&current===generation){view.update(bake);delete view.root.userData.foliageError;}},error=>{if(!disposed&&current===generation)view.root.userData.foliageError=String(error);throw error;});void ready.catch(()=>{});});
  return{root:view.root,get ready(){return ready;},update:(bake:FoliageBake)=>{generation++;currentModel=bake.model;view.update(bake);},dispose(){if(disposed)return;disposed=true;generation++;off();view.dispose();}};
}
