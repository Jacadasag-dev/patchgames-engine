import {ArrayCamera,BufferAttribute,BufferGeometry,Camera,DirectionalLight,Frustum,InstancedMesh,Matrix4,Mesh,Object3D,OrthographicCamera,PerspectiveCamera,PointLight,Sphere,SpotLight,Vector3} from 'three';
import {Material,MeshBasicMaterial,MeshDepthMaterial,MeshDistanceMaterial,MeshLambertMaterial,MeshMatcapMaterial,MeshNormalMaterial,MeshPhongMaterial,MeshStandardMaterial,MeshToonMaterial} from 'three';

/** Prepared geometry cannot certify authored shader deformation or executable
 * material accessors. Preserve those render paths at their source detail. */
export function generatedLodMaterialSafe(material:Material):boolean{
  if(!(material instanceof MeshBasicMaterial||material instanceof MeshStandardMaterial||material instanceof MeshLambertMaterial||material instanceof MeshToonMaterial||material instanceof MeshPhongMaterial||material instanceof MeshMatcapMaterial||material instanceof MeshNormalMaterial||material instanceof MeshDepthMaterial||material instanceof MeshDistanceMaterial))return false;
  const value=(key:string)=>{let at:object|null=material;for(let depth=0;at&&depth<16;depth++,at=Object.getPrototypeOf(at)){const d=Object.getOwnPropertyDescriptor(at,key);if(d)return'value'in d?{valid:true,value:d.value}:{valid:false,value:undefined};}return{valid:true,value:undefined};};
  const transparent=value('transparent'),wireframe=value('wireframe'),displacement=value('displacementMap'),render=value('onBeforeRender'),compile=value('onBeforeCompile'),program=value('customProgramCacheKey');
  return transparent.valid&&transparent.value===false&&wireframe.valid&&!wireframe.value&&displacement.valid&&!displacement.value&&render.valid&&render.value===Material.prototype.onBeforeRender&&compile.valid&&compile.value===Material.prototype.onBeforeCompile&&program.valid&&program.value===Material.prototype.customProgramCacheKey;
}

/** Prepared presentation geometry. Error is a conservative displacement divided
 * by the ORIGINAL geometry's bounding-sphere radius; zero means exact. Banks
 * borrow resources and never transfer ownership to the renderer. */
export interface GeneratedLodLevel {geometry:BufferGeometry;error:number;instanceCount?:number}
const geometryBanks=new WeakMap<BufferGeometry,readonly GeneratedLodLevel[]>();
const meshBanks=new WeakMap<Mesh,readonly GeneratedLodLevel[]>();
const instanceCounts=new WeakMap<Mesh,number>();
type BankStamp={index:BufferAttribute|null;indexVersion:number;start:number;count:number;groups:readonly{start:number;count:number;materialIndex?:number}[];attributes:readonly{key:string;attribute:unknown;version:number}[]};
const bankStamps=new WeakMap<readonly GeneratedLodLevel[],BankStamp>();
const attributeVersion=(attribute:ReturnType<BufferGeometry['getAttribute']>)=>attribute instanceof BufferAttribute?attribute.version:attribute.data.version;
function stamp(source:BufferGeometry,levels:readonly GeneratedLodLevel[]){bankStamps.set(levels,{index:source.index,indexVersion:source.index?.version??0,start:source.drawRange.start,count:source.drawRange.count,groups:source.groups.map(g=>({...g})),attributes:Object.keys(source.attributes).map(key=>({key,attribute:source.getAttribute(key),version:attributeVersion(source.getAttribute(key))}))});}
function current(source:BufferGeometry,levels:readonly GeneratedLodLevel[]|undefined){if(!levels||levels[0].geometry!==source||Object.keys(source.morphAttributes).length)return;const s=bankStamps.get(levels)!;if(source.index!==s.index||(source.index?.version??0)!==s.indexVersion||source.drawRange.start!==s.start||source.drawRange.count!==s.count||Object.keys(source.attributes).length!==s.attributes.length||source.groups.length!==s.groups.length)return;for(let i=0;i<s.groups.length;i++){const a=source.groups[i],b=s.groups[i];if(a.start!==b.start||a.count!==b.count||a.materialIndex!==b.materialIndex)return;}for(const a of s.attributes){const value=source.getAttribute(a.key);if(value!==a.attribute||attributeVersion(value)!==a.version)return;}return levels;}
export const GENERATED_LOD_POLICY=Object.freeze({enterErrorPixels:1,leaveErrorPixels:1.5,nearDiameterPixels:96,maxLevels:5});
function bank(source:BufferGeometry,input:readonly GeneratedLodLevel[],mesh?:Mesh){
  if(!Array.isArray(input)||Object.keys(input).length!==input.length||input.length<2||input.length>5||input[0]?.geometry!==source||input[0]?.error!==0)throw Error('Generated LOD requires 2–5 prepared levels starting with the exact source at error 0.');
  let previous=-1,previousCount=mesh instanceof InstancedMesh?mesh.count:Infinity;
  const result=input.map((level,index)=>{
    if(!level||!(level.geometry instanceof BufferGeometry)||!Number.isFinite(level.error)||level.error<previous||level.error<0||level.error>10)throw Error('Generated LOD errors must be finite, nondecreasing bounds in 0..10.');
    if(level.instanceCount!==undefined&&(!(mesh instanceof InstancedMesh)||!Number.isInteger(level.instanceCount)||level.instanceCount<0||level.instanceCount>mesh.instanceMatrix.count))throw Error('Instance LOD counts require a bounded InstancedMesh prefix.');
    if(index===0&&mesh instanceof InstancedMesh&&level.instanceCount!==undefined&&level.instanceCount!==mesh.count)throw Error('Instance LOD level zero must preserve the complete authored count.');
    if(level.instanceCount!==undefined){if(level.instanceCount>previousCount)throw Error('Instance LOD counts must be nested nonincreasing prefixes.');previousCount=level.instanceCount;}
    const p=level.geometry.getAttribute('position');if(!p||p.itemSize!==3||p.count>2_000_000)throw Error('Generated LOD geometry requires bounded prepared positions.');
    previous=level.error;return Object.freeze({...level});
  });
  const levels=Object.freeze(result);stamp(source,levels);return levels;
}
export function registerGeneratedGeometryLod(source:BufferGeometry,levels:readonly GeneratedLodLevel[]):()=>void{
  if(geometryBanks.has(source))throw Error('This source geometry already has a prepared LOD bank.');
  const value=bank(source,levels);geometryBanks.set(source,value);let released=false;
  const release=()=>{if(released)return;released=true;if(geometryBanks.get(source)===value)geometryBanks.delete(source);source.removeEventListener('dispose',release);};
  source.addEventListener('dispose',release);return release;
}
export function readGeneratedGeometryLod(source:BufferGeometry){return current(source,geometryBanks.get(source));}
export function registerGeneratedMeshLod(mesh:Mesh,levels:readonly GeneratedLodLevel[]):()=>void{
  if(meshBanks.has(mesh))throw Error('This mesh already has a prepared LOD bank.');
  const source=mesh.geometry,value=bank(source,levels,mesh);meshBanks.set(mesh,value);if(mesh instanceof InstancedMesh)instanceCounts.set(mesh,mesh.count);let released=false;
  const release=()=>{if(released)return;released=true;if(meshBanks.get(mesh)===value)meshBanks.delete(mesh);source.removeEventListener('dispose',release);};
  source.addEventListener('dispose',release);return release;
}
export function readGeneratedMeshLod(mesh:Mesh){return readGeneratedExplicitMeshLod(mesh)??readGeneratedGeometryLod(mesh.geometry);}
export function readGeneratedExplicitMeshLod(mesh:Mesh){if(mesh instanceof InstancedMesh&&instanceCounts.get(mesh)!==mesh.count)return;return current(mesh.geometry,meshBanks.get(mesh));}
/** No generation, texture upload, randomness or geometry allocation occurs here. */
export function selectGeneratedLodLevel(levels:readonly GeneratedLodLevel[],diameterPixels:number,previousLevel=0,nearPixels:number=GENERATED_LOD_POLICY.nearDiameterPixels):number{
  let selected=0;
  // Exact coalescing (e.g. coplanar voxel faces) improves near views too, with
  // no projection-dependent quality tradeoff or need to exit the chunk bounds.
  for(let i=1;i<levels.length&&levels[i].error===0;i++)selected=i;
  if(!Number.isFinite(diameterPixels)||diameterPixels<0||diameterPixels>=nearPixels&&nearPixels>0)return selected;
  for(let i=1;i<levels.length;i++){
    const allowance=i<=previousLevel?GENERATED_LOD_POLICY.leaveErrorPixels:GENERATED_LOD_POLICY.enterErrorPixels;
    if(diameterPixels*.5*levels[i].error<=allowance)selected=i;
  }
  return selected;
}
const center=new Vector3();
/** Uses the nearest sphere depth, so close intersections and orthographic/zoomed
 * cameras cannot accidentally select a distant tier. Stereo stays conservative. */
export function generatedLodDiameter(camera:Camera,viewportHeight:number,sphere:Sphere):number{
  if(!Number.isFinite(viewportHeight)||viewportHeight<=0||sphere.isEmpty()||!Number.isFinite(sphere.radius)||camera instanceof ArrayCamera)return Infinity;
  if(camera instanceof OrthographicCamera)return sphere.radius*Math.abs(camera.projectionMatrix.elements[5])*viewportHeight;
  if(!(camera instanceof PerspectiveCamera))return Infinity;
  center.copy(sphere.center).applyMatrix4(camera.matrixWorldInverse);const depth=-center.z-sphere.radius;
  return depth>camera.near?sphere.radius*Math.abs(camera.projectionMatrix.elements[5])*viewportHeight/depth:Infinity;
}
export interface GeneratedLodFrame {camera:Camera;viewportHeight:number;enabled:boolean;diameter(sphere:Sphere,castsShadow?:boolean):number}
export interface GeneratedLodAdapter {prepare(frame:GeneratedLodFrame):void;restore():void}
const adapters=new WeakMap<Object3D,GeneratedLodAdapter>();
export function hasGeneratedLodAdapter(root:Object3D){return adapters.has(root);}
export function registerGeneratedLodAdapter(root:Object3D,adapter:GeneratedLodAdapter):()=>void{
  if(adapters.has(root))throw Error('This generated root already has a LOD adapter.');adapters.set(root,adapter);let released=false;
  return()=>{if(released)return;released=true;if(adapters.get(root)===adapter)adapters.delete(root);};
}
/** Per-render context; adapters may compact prepared instance buckets, but restore
 * authored state after every draw (including nested/minimap draws). */
export class GeneratedLodAdapters {
  private readonly active:GeneratedLodAdapter[]=[];
  private readonly lights:(DirectionalLight|PointLight|SpotLight)[]=[];
  private readonly projection=new Matrix4();
  private readonly shadowData=new WeakMap<Object3D,{volume:Frustum;orthographic:boolean;scale:number;position:Vector3;far:number}>();
  private camera:Camera=new Camera();private height=1;
  private lastCount=0;
  private readonly frame:GeneratedLodFrame={camera:this.camera,viewportHeight:1,enabled:true,diameter:(sphere,castsShadow=false)=>{
    let pixels=generatedLodDiameter(this.camera,this.height,sphere);
    if(!castsShadow)return pixels;
    for(const light of this.lights){const data=this.shadowData.get(light)!;
      if(data.orthographic){if(data.volume.intersectsSphere(sphere))pixels=Math.max(pixels,sphere.radius*data.scale);}
      else{const distance=data.position.distanceTo(sphere.center)-sphere.radius;if(distance>data.far)continue;pixels=Math.max(pixels,distance>0?sphere.radius*data.scale/distance:Infinity);}
    }return pixels;
  }};
  get count(){return this.lastCount;}
  prepare(scene:Object3D,camera:Camera,height:number,enabled=true,roots?:readonly Object3D[],lights?:readonly (DirectionalLight|PointLight|SpotLight)[]){
    this.restore();this.camera=camera;this.height=height;this.frame.camera=camera;this.frame.viewportHeight=height;this.frame.enabled=enabled;this.lastCount=0;
    if(roots&&roots.length===0)return;
    if(scene.matrixWorldAutoUpdate)scene.updateMatrixWorld();if(!camera.parent&&camera.matrixWorldAutoUpdate)camera.updateMatrixWorld();
    if(lights)this.lights.push(...lights);else scene.traverseVisible(object=>{if(object.castShadow&&(object instanceof DirectionalLight||object instanceof PointLight||object instanceof SpotLight))this.lights.push(object);});
    for(const light of this.lights){let data=this.shadowData.get(light);if(!data){data={volume:new Frustum(),orthographic:false,scale:0,position:new Vector3(),far:Infinity};this.shadowData.set(light,data);}const shadow=light.shadow;shadow.updateMatrices(light);const camera=shadow.camera,size=Math.max(shadow.mapSize.x,shadow.mapSize.y);data.orthographic=camera instanceof OrthographicCamera;
      if(data.orthographic){this.projection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);data.volume.setFromProjectionMatrix(this.projection,camera.coordinateSystem);data.scale=Math.max(Math.abs(camera.projectionMatrix.elements[0]),Math.abs(camera.projectionMatrix.elements[5]))*size;}
      else{data.position.setFromMatrixPosition(light.matrixWorld);data.scale=(light instanceof SpotLight?1/Math.tan(light.angle*light.shadow.focus):Math.sqrt(3))*size;data.far=camera.far;}
    }
    const apply=(object:Object3D)=>{const adapter=adapters.get(object);if(!adapter)return;if(this.active.length>=4096)throw Error('Generated LOD adapter budget exceeds 4096 visible roots.');this.active.push(adapter);adapter.prepare(this.frame);};
    try{if(roots)for(const root of roots)apply(root);else scene.traverseVisible(apply);this.lastCount=this.active.length;}
    catch(error){this.restore();throw error;}
  }
  restore(){let failed=false,failure:unknown;for(let i=this.active.length-1;i>=0;i--)try{this.active[i].restore();}catch(error){if(!failed){failed=true;failure=error;}}this.active.length=this.lights.length=0;if(failed)throw failure;}
  dispose(){this.restore();}
}
