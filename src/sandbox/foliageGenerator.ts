import type {TerrainAsset} from './terrain.ts';
import type {TerrainAssetEnvironment} from './terrainEnvironment.ts';
import type {TerrainAssetFactoryContext} from './terrainView.ts';
import * as THREE from 'three';
import {compileFoliage,type FoliageRecipe,type FoliageModel} from '../shared/foliageGenerator.ts';
import {materialRecipe,onMaterialRecipesChanged} from '../shared/materialRegistry.ts';
import {generateMaterial,type GeneratedMaterialPixels} from '../shared/materialGenerator.ts';
import {createGeneratedMaterialFromPixels} from './materialGenerator.ts';
import {compileFoliageGeneration} from '../shared/generationFoliage.ts';
import {prepareFoliageLod,foliageLodPathIndices,type FoliageLodTier} from '../shared/foliageLod.ts';
import {registerGeneratedGeometryLod,registerGeneratedMeshLod,readGeneratedGeometryLod} from './generatedLod.ts';
import {createGeneratedAlphaShadows} from './generatedAlpha.ts';
export {compileFoliageGeneration,FOLIAGE_GENERATION_TARGETS} from '../shared/generationFoliage.ts';
export {compileFoliage,parseFoliageRecipe,foliageColliders} from '../shared/foliageGenerator.ts';
export type {FoliageRecipe,FoliageModel} from '../shared/foliageGenerator.ts';
export {FOLIAGE_PRESETS} from '../shared/foliagePresets.ts';
export {prepareFoliageLod} from '../shared/foliageLod.ts';
export interface FoliageBake {model:FoliageModel;bark:GeneratedMaterialPixels;leaf:GeneratedMaterialPixels;flower?:GeneratedMaterialPixels}
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
  const pixels=await Promise.all([generateMaterial(bark,{resolution,signal:options.signal}),generateMaterial(leaf,{resolution,signal:options.signal,alphaMode:'hash'})]);
  return{model,bark:pixels[0],leaf:pixels[1],flower:model.flowers.length?await generateMaterial(resolve(model.recipe.materials.flower),{resolution,signal:options.signal,alphaMode:'hash'}):undefined};
}
/** Sweep one welded tube per woody path. Shared bend rings prevent stacked cylinders,
 * internal caps and independently rotated cross sections from showing through. */
function woodGeometry(model:FoliageModel,tier?:FoliageLodTier){
  const sides=tier?.radialSegments??{low:5,medium:8,high:12}[model.recipe.quality],positions:number[]=[],uvs:number[]=[],indices:number[]=[],seams:[number,number][]=[];
  const paths=new Map<number,typeof model.branches>();for(const branch of model.branches){const path=paths.get(branch.path)??[];path.push(branch);paths.set(branch.path,path);}
  for(const path of paths.values()){
    const source=[path[0].start,...path.map(b=>b.end)],chosen=foliageLodPathIndices(source,tier?.axialToleranceMeters??0),points=chosen.map(i=>new THREE.Vector3(...source[i])),sourceRadii=[path[0].radiusStart,...path.map(b=>b.radiusEnd)],radii=chosen.map(i=>sourceRadii[i]),axes=points.slice(1).map((point,i)=>point.clone().sub(points[i]).normalize()),base=positions.length/3;
    const sourceDistance=[0];for(let i=1;i<source.length;i++)sourceDistance.push(sourceDistance[i-1]+Math.hypot(...source[i].map((v,j)=>v-source[i-1][j])));
    let previous=axes[0].clone(),x=new THREE.Vector3(Math.abs(previous.y)<.9?0:1,Math.abs(previous.y)<.9?1:0,0).cross(previous).normalize(),distance=0;
    for(let i=0;i<points.length;i++){
      const tangent=i===0?axes[0].clone():i===points.length-1?axes[i-1].clone():axes[i-1].clone().add(axes[i]).normalize();
      x.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(previous,tangent));x.addScaledVector(tangent,-x.dot(tangent)).normalize();const z=tangent.clone().cross(x);previous=tangent;
      distance=sourceDistance[chosen[i]];
      for(let j=0;j<=sides;j++){const angle=j/sides*Math.PI*2,p=points[i].clone().addScaledVector(x,Math.cos(angle)*radii[i]).addScaledVector(z,Math.sin(angle)*radii[i]);positions.push(p.x,p.y,p.z);uvs.push(j/sides*Math.PI*2*radii[i],distance);}
      seams.push([base+i*(sides+1),base+i*(sides+1)+sides]);
      if(i)for(let j=0;j<sides;j++){const k=base+(i-1)*(sides+1)+j,l=k+sides+1;indices.push(k,k+1,l,k+1,l+1,l);}
    }
    // Only terminal caps have separate vertices/normals; no disks inside bends.
    for(const end of [0,points.length-1]){const center=positions.length/3;positions.push(...points[end].toArray());uvs.push(0,0);const cap=positions.length/3;for(let j=0;j<=sides;j++){const k=(base+end*(sides+1)+j)*3;positions.push(positions[k],positions[k+1],positions[k+2]);uvs.push(j/sides,1);}for(let j=0;j<sides;j++)indices.push(center,cap+j+(end?0:1),cap+j+(end?1:0));}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setIndex(indices);g.computeVertexNormals();
  const normals=g.attributes.normal;for(const [a,b]of seams){const n=new THREE.Vector3().fromBufferAttribute(normals,a).add(new THREE.Vector3().fromBufferAttribute(normals,b)).normalize();normals.setXYZ(a,n.x,n.y,n.z);normals.setXYZ(b,n.x,n.y,n.z);}g.computeBoundingSphere();return g;
}
function mergedLeaves(instances:THREE.InstancedMesh){
  const source=instances.geometry,p=source.attributes.position,n=source.attributes.normal,uv=source.attributes.uv,index=source.index!,count=p.count*instances.count;
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3),uvs=new Float32Array(count*2),indices=new Uint32Array(index.count*instances.count),matrix=new THREE.Matrix4(),normalMatrix=new THREE.Matrix3(),v=new THREE.Vector3();
  for(let i=0;i<instances.count;i++){instances.getMatrixAt(i,matrix);normalMatrix.getNormalMatrix(matrix);for(let j=0;j<p.count;j++){const k=i*p.count+j;v.fromBufferAttribute(p,j).applyMatrix4(matrix);positions.set(v.toArray(),k*3);v.fromBufferAttribute(n,j).applyMatrix3(normalMatrix).normalize();normals.set(v.toArray(),k*3);uvs[k*2]=uv.getX(j);uvs[k*2+1]=uv.getY(j);}for(let j=0;j<index.count;j++)indices[i*index.count+j]=i*p.count+index.getX(j);}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.computeBoundingSphere();return geometry;
}
function leafLodGeometry(w:number,h:number,leafSize:number,tier:FoliageLodTier){
  const geometry=new THREE.PlaneGeometry(w,h,...tier.leafSegments),p=geometry.attributes.position;
  for(let i=0;i<p.count;i++){const y=p.getY(i)+leafSize/2;p.setX(i,p.getX(i)*tier.leafScale);p.setY(i,y*tier.leafScale);p.setZ(i,Math.sin(Math.max(0,Math.min(1,y/leafSize))*Math.PI)*leafSize*.09*tier.leafScale);}geometry.computeVertexNormals();geometry.computeBoundingSphere();return geometry;
}
function mergedLod(instances:THREE.InstancedMesh,geometry:THREE.BufferGeometry,count:number){
  const previousGeometry=instances.geometry,previousCount=instances.count;try{instances.geometry=geometry;instances.count=count;return mergedLeaves(instances);}finally{instances.geometry=previousGeometry;instances.count=previousCount;}
}
/** Native shadow materials borrow the visible maps and are owned by that
 * visible material, including independently cloned terrain material handles. */
function leafShadows(mesh:THREE.Mesh,material:THREE.Material){
  const shadow=material.alphaHash?createGeneratedAlphaShadows(material):undefined;
  mesh.customDepthMaterial=shadow?.depth;mesh.customDistanceMaterial=shadow?.distance;
}
/** Batched tapered wood, curved leaf cards and optional attached petal instances. */
export class FoliageView {
  readonly root=new THREE.Group();private owned:(()=>void)[]=[];private materialsOwned:(()=>void)[]=[];private geometryKey='';private disposed=false;
  private readonly options:{leafMode?:'instanced'|'merged';lod?:boolean};
  constructor(bake:FoliageBake,options:{leafMode?:'instanced'|'merged';lod?:boolean}={}){this.options=options;this.update(bake);}
  update(bake:FoliageBake){
    if(this.disposed)throw Error('Foliage view disposed.');
    const {model}=bake,bark=createGeneratedMaterialFromPixels(bake.bark,{uvSpace:'metres'}),leaf=createGeneratedMaterialFromPixels(bake.leaf,{alphaMode:'hash'});
    leaf.material.side=THREE.DoubleSide;leaf.material.emissive.set(bake.leaf.recipe.color);leaf.material.emissiveIntensity=.08;
    const plant=bake.leaf.recipe.pattern,length=plant.family==='leaf'||plant.family==='needle'?plant.lengthMeters:bake.leaf.recipe.tileMeters[1],scale=model.recipe.leafSizeMeters/length;
    const flower=bake.flower?createGeneratedMaterialFromPixels(bake.flower,{alphaMode:'hash'}):undefined;if(flower)flower.material.side=THREE.DoubleSide;
    const key=JSON.stringify([{...model.recipe,name:undefined,materials:undefined},bake.leaf.recipe.tileMeters,length,bake.flower?.recipe.tileMeters,bake.flower?.recipe.pattern,this.options.lod!==false]);
    const oldMaterials=this.materialsOwned;this.materialsOwned=[()=>bark.dispose(),()=>leaf.dispose(),()=>flower?.dispose()];
    this.root.name=model.recipe.name;this.root.userData.foliage={recipe:model.recipe,diagnostics:model.diagnostics,bounds:model.bounds,...(this.root.userData.foliage?.lod?{lod:this.root.userData.foliage.lod}:{})};
    if(this.geometryKey===key){(this.root.children[0] as THREE.Mesh).material=bark.material;const leaves=this.root.children[1] as THREE.Mesh;leaves.material=leaf.material;leafShadows(leaves,leaf.material);if(flower&&this.root.children[2]){const bloom=this.root.children[2] as THREE.Mesh;bloom.material=flower.material;leafShadows(bloom,flower.material);}oldMaterials.forEach(dispose=>dispose());return;}
    this.geometryKey=key;const lod=this.options.lod===false?undefined:prepareFoliageLod(model),wood=woodGeometry(model),woody=new THREE.Mesh(wood,bark.material);woody.castShadow=woody.receiveShadow=true;
    const w=bake.leaf.recipe.tileMeters[0]*scale,h=bake.leaf.recipe.tileMeters[1]*scale,leafGeometry=new THREE.PlaneGeometry(w,h,2,4),p=leafGeometry.attributes.position;
    for(let i=0;i<p.count;i++){const y=p.getY(i)+model.recipe.leafSizeMeters/2;p.setY(i,y);p.setZ(i,Math.sin(Math.max(0,Math.min(1,y/model.recipe.leafSizeMeters))*Math.PI)*model.recipe.leafSizeMeters*.09);}leafGeometry.computeVertexNormals();
    const foliage=new THREE.InstancedMesh(leafGeometry,leaf.material,model.leaves.length),matrix=new THREE.Matrix4(),rotation=new THREE.Matrix4(),q=new THREE.Quaternion();foliage.castShadow=foliage.receiveShadow=true;
    (lod?lod[0].leafIndices.map(i=>model.leaves[i]):model.leaves).forEach((l,i)=>{const y=new THREE.Vector3(...l.direction).normalize(),normal=new THREE.Vector3(Math.sin(l.roll)*.8,.55,Math.cos(l.roll)*.8);normal.addScaledVector(y,-normal.dot(y)).normalize();if(normal.lengthSq()<.001)normal.set(0,0,1);const x=y.clone().cross(normal).normalize(),z=x.clone().cross(y).normalize();rotation.makeBasis(x,y,z);q.setFromRotationMatrix(rotation);matrix.compose(new THREE.Vector3(...l.anchor),q,new THREE.Vector3(l.sizeScale,l.sizeScale,l.sizeScale));foliage.setMatrixAt(i,matrix);});foliage.instanceMatrix.needsUpdate=true;foliage.computeBoundingSphere();
    const merged=this.options.leafMode==='merged'?mergedLeaves(foliage):undefined,leafMesh=merged?new THREE.Mesh(merged,leaf.material):foliage;leafMesh.castShadow=leafMesh.receiveShadow=true;
    let blossoms:THREE.Mesh|undefined,bloomInstances:THREE.InstancedMesh|undefined;const bloomOwned:(()=>void)[]=[];
    if(flower&&bake.flower){const size=model.recipe.flowers.sizeMeters/2,pattern=bake.flower.recipe.pattern,sourceLength=pattern.family==='leaf'||pattern.family==='needle'?pattern.lengthMeters:bake.flower.recipe.tileMeters[1],scale=size/sourceLength,g=new THREE.PlaneGeometry(bake.flower.recipe.tileMeters[0]*scale,bake.flower.recipe.tileMeters[1]*scale,2,4);g.translate(0,size/2,0);
      const petals=model.recipe.flowers.petals,inst=new THREE.InstancedMesh(g,flower.material,model.flowers.length*petals),up=new THREE.Vector3(0,1,0);
      (lod?lod[0].flowerIndices.map(i=>model.flowers[i]):model.flowers).forEach((b,i)=>{const normal=new THREE.Vector3(...b.normal),orient=new THREE.Quaternion().setFromUnitVectors(up,normal);for(let j=0;j<petals;j++){const angle=j/petals*Math.PI*2,y=new THREE.Vector3(Math.cos(angle),.55,Math.sin(angle)).normalize().applyQuaternion(orient),z=normal.clone().addScaledVector(y,-normal.dot(y)).normalize(),x=y.clone().cross(z).normalize();rotation.makeBasis(x,y,z);q.setFromRotationMatrix(rotation);matrix.compose(new THREE.Vector3(...b.anchor),q,new THREE.Vector3(b.sizeScale,b.sizeScale,b.sizeScale));inst.setMatrixAt(i*petals+j,matrix);}});inst.instanceMatrix.needsUpdate=true;inst.computeBoundingSphere();const mergedBloom=this.options.leafMode==='merged'?mergedLeaves(inst):undefined;blossoms=mergedBloom?new THREE.Mesh(mergedBloom,flower.material):inst;bloomInstances=inst;blossoms.castShadow=true;bloomOwned.push(()=>{g.dispose();mergedBloom?.dispose();inst.dispose();});
    }
    leafShadows(leafMesh,leaf.material);if(blossoms&&flower)leafShadows(blossoms,flower.material);
    const previous=this.owned;this.root.clear();this.root.add(woody,leafMesh);if(blossoms)this.root.add(blossoms);this.root.userData.foliage={recipe:model.recipe,diagnostics:model.diagnostics,bounds:model.bounds};
    this.owned=[()=>{wood.dispose();leafGeometry.dispose();merged?.dispose();foliage.dispose();},...bloomOwned];previous.forEach(dispose=>dispose());oldMaterials.forEach(dispose=>dispose());
    if(lod){
      const woodLevels=[{geometry:wood,error:0}],leafLevels=[{geometry:leafMesh.geometry,error:0,instanceCount:model.leaves.length}],flowerLevels=blossoms?[{geometry:blossoms.geometry,error:0,instanceCount:model.flowers.length*model.recipe.flowers.petals}]:undefined;
      const lower:THREE.BufferGeometry[]=[];let woodError=0,leafError=0;
      const leafRadius=Math.max(.001,merged?merged.boundingSphere!.radius:foliage.boundingSphere!.radius),maxLeafScale=Math.max(1,...model.leaves.map(l=>l.sizeScale));
      for(const tier of lod.slice(1)){
        const g=woodGeometry(model,tier);lower.push(g);woodError=Math.max(woodError,(Math.max(...model.branches.map(b=>b.radiusStart))*(1-Math.cos(Math.PI/tier.radialSegments))+tier.axialToleranceMeters)/Math.max(.001,wood.boundingSphere!.radius));woodLevels.push({geometry:g,error:woodError});
        const plane=leafLodGeometry(w,h,model.recipe.leafSizeMeters,tier),geometry=merged?mergedLod(foliage,plane,tier.leafIndices.length):plane;lower.push(plane);if(geometry!==plane)lower.push(geometry);leafError=model.leaves.length?Math.max(leafError,model.recipe.leafSizeMeters*.09*maxLeafScale/leafRadius):0;leafLevels.push({geometry,error:leafError,instanceCount:tier.leafIndices.length});
        if(blossoms&&bloomInstances&&flowerLevels){const source=(bloomInstances.geometry as THREE.PlaneGeometry).parameters,g=new THREE.PlaneGeometry(source.width,source.height,1,1);g.translate(0,model.recipe.flowers.sizeMeters/4,0);lower.push(g);const count=tier.flowerIndices.length*model.recipe.flowers.petals,geometry=this.options.leafMode==='merged'?mergedLod(bloomInstances,g,count):g;if(geometry!==g)lower.push(geometry);flowerLevels.push({geometry,error:0,instanceCount:count});}
      }
      const releases=[registerGeneratedGeometryLod(wood,woodLevels)];
      if(merged){releases.push(registerGeneratedGeometryLod(leafMesh.geometry,leafLevels.map(({geometry,error})=>({geometry,error}))));if(blossoms&&flowerLevels)releases.push(registerGeneratedGeometryLod(blossoms.geometry,flowerLevels.map(({geometry,error})=>({geometry,error}))));}
      else{releases.push(registerGeneratedMeshLod(foliage,leafLevels));if(blossoms&&flowerLevels)releases.push(registerGeneratedMeshLod(blossoms,flowerLevels));}
      this.root.userData.foliage.lod={prepared:true,levels:lod.map((tier,i)=>({level:i,woodTriangles:woodLevels[i].geometry.index!.count/3,leaves:tier.leafIndices.length,leafTriangles:tier.leafIndices.length*leafLevels[i].geometry.index!.count/3/(merged?Math.max(1,tier.leafIndices.length):1)}))};
      this.owned.push(()=>{releases.forEach(release=>release());lower.forEach(g=>g.dispose());});
    }
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.owned.forEach(dispose=>dispose());this.materialsOwned.forEach(dispose=>dispose());this.owned=[];this.materialsOwned=[];this.root.clear();}
}
/** TerrainView instances this plain-mesh prototype across its placements. Its
 * terrain batches own the returned resources; do not share it with another view. */
export function createFoliageTerrainPrototype(bake:FoliageBake){return new FoliageView(bake,{leafMode:'merged'}).root;}
/** Named bark/leaf/flower recipes follow registry edits; the last valid view survives errors. */
export async function createFoliage(input:FoliageRecipe,options:Parameters<typeof generateFoliage>[1]={}){
  const initial=await generateFoliage(input,options),view=new FoliageView(initial),ids=Object.values(initial.model.recipe.materials).flatMap(slot=>'ref'in slot?[slot.ref]:[]);let disposed=false,generation=0,ready=Promise.resolve(),currentModel=initial.model;
  const off=onMaterialRecipesChanged(changed=>{if(!ids.some(id=>changed.has(id)))return;const current=++generation;ready=bakeFoliageModel(currentModel,options).then(bake=>{if(!disposed&&current===generation){view.update(bake);delete view.root.userData.foliageError;}},error=>{if(!disposed&&current===generation)view.root.userData.foliageError=String(error);throw error;});void ready.catch(()=>{});});
  return{root:view.root,get ready(){return ready;},update:(bake:FoliageBake)=>{generation++;currentModel=bake.model;view.update(bake);},dispose(){if(disposed)return;disposed=true;generation++;off();view.dispose();}};
}

export interface FoliageTerrainEntry {id:string;recipe:FoliageRecipe;environment?:TerrainAssetEnvironment}
/** Prepare bounded species once during loading; chunk views only clone prepared
 * resources. Each returned prototype owns its geometry/materials/textures. */
export async function prepareFoliageTerrain(entries:readonly FoliageTerrainEntry[],options:Parameters<typeof generateFoliage>[1]={}){
  validateFoliageEntries(entries);const bakes:{id:string;bake:FoliageBake;environment?:TerrainAssetEnvironment}[]=[];
  for(const entry of entries){options.signal?.throwIfAborted();bakes.push({id:entry.id,bake:await generateFoliage(entry.recipe,options),environment:entry.environment});}
  return createFoliageTerrainLibrary(bakes);
}
function validateFoliageEntries(entries:readonly {id:string}[]){if(!entries.length||entries.length>16||entries.some(e=>!/^[-a-z0-9._]{1,80}$/i.test(e.id))||new Set(entries.map(e=>e.id)).size!==entries.length)throw Error('Foliage terrain needs 1–16 unique valid species IDs.');}
/** Prepare stable object variants during loading. The returned asset IDs can be
 * used by terrain placement without any per-frame branch or material generation. */
export async function prepareFoliageGeneration(input:Parameters<typeof compileFoliageGeneration>[0],options:Parameters<typeof generateFoliage>[1]={}){
  options.signal?.throwIfAborted();const plan=compileFoliageGeneration(input);
  const library=await prepareFoliageTerrain(plan.variants.map(v=>({id:v.assetId,recipe:v.recipe})),options);
  return{...library,variants:plan.variants,revision:plan.revision,diagnostics:plan.diagnostics,inspect:plan.inspect};
}
/** Worker-bake counterpart of prepareFoliageTerrain. No texture baking or branch
 * generation occurs in the terrain asset factory or the wind update loop. */
export function createFoliageTerrainLibrary(entries:readonly {id:string;bake:FoliageBake;environment?:TerrainAssetEnvironment}[]){
  validateFoliageEntries(entries);const templates=new Map<string,{view:FoliageView;references:number}>(),assets:TerrainAsset[]=[];let disposed=false;
  const retire=(id:string,entry:{view:FoliageView;references:number})=>{if(disposed&&entry.references===0){templates.delete(id);entry.view.dispose();}};
  try{for(const e of entries){const m=e.bake.model,r=m.recipe;templates.set(e.id,{view:new FoliageView(e.bake,{leafMode:'merged'}),references:0});let hash=2166136261;for(const c of JSON.stringify([r,e.environment]))hash=Math.imul(hash^c.charCodeAt(0),16777619);
    const radius=Math.hypot(Math.max(Math.abs(m.bounds.min[0]),Math.abs(m.bounds.max[0])),Math.max(Math.abs(m.bounds.min[2]),Math.abs(m.bounds.max[2])));
    assets.push({id:e.id,version:'foliage-'+(hash>>>0).toString(16),footprint:{kind:'circle',radius},appearance:{kind:'foliage',height:m.bounds.max[1]},environment:e.environment??{wind:{bendRadians:r.type==='bush'?.055:.025,swayHz:r.type==='bush'?.8:.3,flutter:.12,referenceHeight:r.heightMeters,sizeExponent:.5}}});
  }}catch(error){templates.forEach(entry=>entry.view.dispose());throw error;}
  return{assets,assetFactory(asset:Readonly<TerrainAsset>,context?:TerrainAssetFactoryContext){
    if(disposed)throw Error('Foliage terrain library disposed.');const source=templates.get(asset.id);if(!source)return undefined;
    const root=source.view.root.clone(true),geometries=new Set<THREE.BufferGeometry>();
    root.traverse(object=>{if(!(object instanceof THREE.Mesh))return;const bank=readGeneratedGeometryLod(object.geometry);
      if(context){for(const level of bank??[{geometry:object.geometry}])geometries.add(level.geometry);}
      else{object.geometry=object.geometry.clone();if(bank)registerGeneratedGeometryLod(object.geometry,bank.map((level,index)=>({geometry:index===0?object.geometry:level.geometry.clone(),error:level.error})));}
      const copies=new Map<THREE.Texture,THREE.Texture>();const clone=(source:THREE.Material)=>{const material=source.clone();for(const [key,value]of Object.entries(material))if(value instanceof THREE.Texture){let texture=copies.get(value);if(!texture){texture=value.clone();copies.set(value,texture);}Object.assign(material,{[key]:texture});}return material;};object.material=Array.isArray(object.material)?object.material.map(clone):clone(object.material);if(!Array.isArray(object.material))leafShadows(object,object.material);
    });
    if(context){source.references++;let released=false;const release=()=>{if(released)return;released=true;source.references--;retire(asset.id,source);};
      try{context.borrowGeometry([...geometries],release);}catch(error){release();root.traverse(object=>{if(object instanceof THREE.Mesh)for(const material of Array.isArray(object.material)?object.material:[object.material]){for(const value of Object.values(material))if(value instanceof THREE.Texture)value.dispose();material.dispose();}});throw error;}
    }
    return root;
  },dispose(){if(disposed)return;disposed=true;for(const [id,entry]of templates)retire(id,entry);}};
}
