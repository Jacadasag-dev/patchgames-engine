import {BoxGeometry,BufferGeometry,DynamicDrawUsage,Euler,Group,InstancedMesh,Material,Matrix4,Mesh,Quaternion,Texture,Vector3} from 'three';
import {FOLIAGE_PRESETS} from '../shared/foliagePresets.ts';
import {generateMaterial,type GeneratedMaterialPixels} from '../shared/materialGenerator.ts';
import {planetPopulationCells,planetPopulationCellKey,planetPopulationFrame,resolvePlanetPopulationOptions,type PlanetPopulationCell,type PlanetPopulationInstance,type PlanetPopulationOptions,type PlanetPopulationWorld,type ResolvedPlanetPopulationOptions} from '../shared/planetPopulation.ts';
import type {PlanetTile,PlanetVector} from '../shared/planet.ts';
import {generateFoliage,createFoliageTerrainLibrary,type FoliageBake} from './foliageGenerator.ts';
import {compileBuilding,type BuildingManifest,type BuildingRecipe} from './building.ts';
import {BuildingWorldView,createBuildingBoxAppearance} from './buildingView.ts';
import {createGeneratedMaterialFromPixels,mapBoxMaterialMeters} from './materialGenerator.ts';
import {readGeneratedGeometryLod} from './generatedLod.ts';
import {sampleTerrainAssetEnvironment,type TerrainAssetEnvironment} from './terrainEnvironment.ts';

export interface PlanetPopulationBake {
  version:1;trees:{id:string;bake:FoliageBake}[];buildings:{id:string;manifest:BuildingManifest}[];
  buildingMaterials:{wall:GeneratedMaterialPixels;roof:GeneratedMaterialPixels;wood:GeneratedMaterialPixels};
}
export interface PlanetPopulationSource {request(cell:PlanetTile,options:ResolvedPlanetPopulationOptions,signal?:AbortSignal):Promise<PlanetPopulationCell>;dispose():void}
interface PrototypePart {geometry:BufferGeometry;levels:readonly BufferGeometry[];material:Material|Material[];local:Matrix4;castShadow:boolean;depth?:Material;distance?:Material}
export interface PlanetPopulationVariant {id:string;kind:'tree'|'building';parts:readonly PrototypePart[];height:number;radius:number;environment?:TerrainAssetEnvironment}
/** Prepared resources support multiple concurrent population views. Retiring a
 * library waits for the last view loan before releasing immutable geometry. */
export interface PreparedPlanetPopulation {readonly variants:ReadonlyMap<string,PlanetPopulationVariant>;borrow():()=>void;dispose():void}
const species=['oak','maple','birch','evergreen','pine','jungle','palm'] as const;
function home(id:string,seed:number):BuildingRecipe{return{version:1,id,seed:seed>>>0,width:id==='cottage'?8:10,depth:8,floorThickness:.5,wallThickness:.24,
  colors:{wall:'#c3b297',floor:'#827159',roof:id==='cottage'?'#575b5c':'#674c38'},doors:{style:'panel',open:1,color:'#715238'},primaryEntrance:'entry',
  floors:[{id:'ground',y:0,height:3.2,rooms:[{id:'room',x:0,z:0,width:id==='cottage'?8:10,depth:8,access:'public'}],openings:[
    {id:'entry',room:'room',side:'south',kind:'door',width:1.5,height:2.4},
    {id:'window-e',room:'room',side:'east',kind:'window',width:1.5,height:1.3,bottom:1.1},
    {id:'window-w',room:'room',side:'west',kind:'window',width:1.5,height:1.3,bottom:1.1},
    {id:'window-n',room:'room',side:'north',kind:'window',width:1.8,height:1.3,bottom:1.1},
  ]}],roof:{kind:'gable',rise:id==='cottage'?1.8:2.5,enclosure:true}};}
/** Worker-safe preparation. The only branch compilation, building compilation
 * and texture baking for the population happens here, once per bounded bank. */
export async function bakePlanetPopulation(seed:number,options:{resolution?:number;signal?:AbortSignal}={}):Promise<PlanetPopulationBake>{
  if(!Number.isInteger(seed)||seed< -2147483648||seed>2147483647)throw Error('Population seed must be a signed 32-bit integer.');
  const resolution=options.resolution??64;if(![32,64,128].includes(resolution))throw Error('Population material resolution must be 32, 64 or 128.');
  options.signal?.throwIfAborted();const trees:PlanetPopulationBake['trees']=[];
  for(const [index,id]of species.entries()){
    options.signal?.throwIfAborted();const source=FOLIAGE_PRESETS.find(preset=>preset.id===id)!.recipe;
    const recipe={...source,seed:(seed+index*7919)%2147483647,quality:'low' as const,density:Math.min(source.density,55),branchLevels:Math.min(source.branchLevels,2),branchSegments:Math.min(source.branchSegments,8)};
    trees.push({id,bake:await generateFoliage(recipe,{resolution,signal:options.signal})});
  }
  const material=async(id:string)=>generateMaterial(id==='wall'?{pattern:{family:'masonry',shape:'rectangle',blockMeters:[.55,.28],irregularity:.22},color:'#b3a68b',secondaryColor:'#726c5d',tileMeters:[2.2,1.12],seed:seed%2147483647}:id==='roof'?{pattern:{family:'masonry',shape:'rectangle',blockMeters:[.28,.36],mortarMeters:.008},color:'#555e60',secondaryColor:'#31383d',tileMeters:[1.12,1.44],seed:seed%2147483647}:{pattern:{family:'wood',direction:'vertical'},color:'#856846',secondaryColor:'#443724',tileMeters:[1,2],seed:seed%2147483647},{resolution,signal:options.signal});
  const wall=await material('wall'),roof=await material('roof'),wood=await material('wood');
  const buildings=['cottage','lodge'].map(id=>({id,manifest:compileBuilding(home(id,seed))}));
  for(const entry of buildings)if(!entry.manifest.diagnostics.valid)throw Error('Invalid planet building '+entry.id+': '+JSON.stringify(entry.manifest.diagnostics));
  return{version:1,trees,buildings,buildingMaterials:{wall,roof,wood}};
}
function disposeMaterials(root:Group){const materials=new Set<Material>(),textures=new Set<Texture>();root.traverse(object=>{if(object instanceof Mesh)for(const material of Array.isArray(object.material)?object.material:[object.material]){materials.add(material);for(const value of Object.values(material))if(value instanceof Texture)textures.add(value);}});for(const texture of textures)texture.dispose();for(const material of materials)material.dispose();root.clear();}
function prototype(root:Group,id:string,kind:'tree'|'building',height:number,radius:number,environment?:TerrainAssetEnvironment):PlanetPopulationVariant{root.updateMatrixWorld(true);const parts:PrototypePart[]=[];root.traverse(object=>{if(!(object instanceof Mesh))return;let visible=true;for(let at=object;at;at=at.parent as Mesh){if(!at.visible)visible=false;}if(!visible)return;parts.push({geometry:object.geometry,levels:readGeneratedGeometryLod(object.geometry)?.map(level=>level.geometry)??[object.geometry],material:object.material,local:object.matrixWorld.clone(),castShadow:object.castShadow,depth:object.customDepthMaterial,distance:object.customDistanceMaterial});});return{id,kind,parts,height,radius,environment};}
export function createPreparedPlanetPopulation(bake:PlanetPopulationBake):PreparedPlanetPopulation{
  if(bake.version!==1||bake.trees.length!==7||bake.buildings.length!==2||species.some(id=>!bake.trees.some(tree=>tree.id===id))||new Set(bake.trees.map(tree=>tree.id)).size!==7)throw Error('Population bake requires the bounded seven-species/two-building bank.');
  const variants=new Map<string,PlanetPopulationVariant>(),owned:(()=>void)[]=[],foliage=createFoliageTerrainLibrary(bake.trees);let loans=0,retired=false,released=false;
  const release=()=>{if(!retired||loans||released)return;released=true;for(const dispose of owned.splice(0))dispose();foliage.dispose();};
  try{
    for(const asset of foliage.assets){const root=foliage.assetFactory(asset,{borrowGeometry(_geometry,releaseLoan){owned.push(releaseLoan);}})! as Group;
      owned.push(()=>disposeMaterials(root));variants.set(asset.id,prototype(root,asset.id,'tree',Number(asset.appearance!.height),asset.footprint.kind==='circle'?asset.footprint.radius:5,asset.environment));}
    const wall=createGeneratedMaterialFromPixels(bake.buildingMaterials.wall,{uvSpace:'metres'}),roof=createGeneratedMaterialFromPixels(bake.buildingMaterials.roof,{uvSpace:'metres'}),wood=createGeneratedMaterialFromPixels(bake.buildingMaterials.wood,{uvSpace:'metres'});owned.push(()=>wall.dispose(),()=>roof.dispose(),()=>wood.dispose());
    for(const entry of bake.buildings){const view=new BuildingWorldView([entry.manifest],{fixtureLights:false,maxLights:0,activationDistance:64,interiorDistance:64,maxActiveBuildings:1,partFactory(part){
      if(part.geometry||part.model||part.kind==='furniture')return;
      const appearance=createBuildingBoxAppearance(part);if(appearance.geometry instanceof BoxGeometry)mapBoxMaterialMeters(appearance.geometry);
      const mesh=new Mesh(appearance.geometry,part.kind==='roof'?roof.material:part.kind==='door'||part.kind==='floor'?wood.material:wall.material);mesh.castShadow=mesh.receiveShadow=true;
      return{object:mesh,dispose:()=>appearance.dispose()};
    }});view.update({x:0,y:1,z:0});owned.push(()=>view.dispose());
      // Convex roof solids and gables already have metre UVs from the native
      // renderer. Door model trim keeps its authored material/orientation.
      const parts=new Map(entry.manifest.parts.map(part=>[part.id,part]));view.root.traverse(object=>{if(!(object instanceof Mesh))return;for(let at=object.parent;at;at=at.parent){const part=parts.get(at.name);if(part){if(part.geometry)object.material=part.kind==='roof'?roof.material:wall.material;break;}}});
      const bounds=entry.manifest.bounds;variants.set(entry.id,prototype(view.root,entry.id,'building',bounds.max.y-bounds.min.y,Math.hypot(10,8)));}
  }catch(error){retired=true;release();throw error;}
  return{variants,borrow(){if(retired)throw Error('Planet population library is retired.');loans++;let done=false;return()=>{if(done)return;done=true;loans--;release();};},dispose(){if(retired)return;retired=true;release();}};
}
interface Batch {variant:PlanetPopulationVariant;tier:number;mesh:InstancedMesh;part:PrototypePart}
interface RecordCell {cell:PlanetTile;data?:PlanetPopulationCell;pending?:PlanetPopulationCell;abort?:AbortController;failed:boolean}
interface Pose {orientation:Quaternion;wind:[number,number]}
export interface PlanetPopulationViewOptions extends PlanetPopulationOptions {maxUploadsPerFrame?:number;maxAnimatedTrees?:number}
/** Radial, camera-relative presentation only. Generated prototypes are instanced
 * globally rather than rebuilt per terrain patch or cell. No physics is implied. */
export class PlanetPopulationView {
  readonly root=new Group();private readonly world:PlanetPopulationWorld;private readonly source:PlanetPopulationSource;private readonly options:ResolvedPlanetPopulationOptions;private readonly release:()=>void;
  private readonly records=new Map<string,RecordCell>();private readonly batches:Batch[]=[];private readonly uploadBudget:number;private readonly windBudget:number;
  private readonly variants:ReadonlyMap<string,PlanetPopulationVariant>;private readonly poses=new WeakMap<PlanetPopulationInstance,Pose>();
  private wanted=new Set<string>();private lastPosition:PlanetVector=[Infinity,Infinity,Infinity];private nextPlan=-Infinity;private disposed=false;private inFlight=0;private stale=0;private failed=0;private generated=0;private installedThisFrame=0;private treeCount=0;private buildingCount=0;private uploadCpuMs=0;private lastError='';
  private readonly matrix=new Matrix4();private readonly local=new Matrix4();private readonly orientation=new Quaternion();private readonly yaw=new Quaternion();private readonly sway=new Quaternion();private readonly euler=new Euler();private readonly position=new Vector3();private readonly size=new Vector3();private readonly up=new Vector3(0,1,0);
  constructor(world:PlanetPopulationWorld,library:PreparedPlanetPopulation,source:PlanetPopulationSource,options:PlanetPopulationViewOptions={}){
    this.world=world;this.source=source;this.options=resolvePlanetPopulationOptions(options);this.uploadBudget=options.maxUploadsPerFrame??1;this.windBudget=options.maxAnimatedTrees??96;
    if(!Number.isInteger(this.uploadBudget)||this.uploadBudget<1||this.uploadBudget>4||!Number.isInteger(this.windBudget)||this.windBudget<0||this.windBudget>512)throw Error('Population upload/wind budgets are invalid.');
    this.release=library.borrow();this.variants=library.variants;this.root.name='PlanetPopulation';
    try{for(const variant of library.variants.values()){const capacity=variant.kind==='tree'?this.options.maxTrees:this.options.maxBuildings;if(!capacity)continue;const tiers=Math.max(...variant.parts.map(part=>part.levels.length));for(let tier=0;tier<tiers;tier++)for(const part of variant.parts){const mesh=new InstancedMesh(part.levels[Math.min(tier,part.levels.length-1)],part.material,capacity);mesh.name=`planet:${variant.id}:lod${tier}`;mesh.count=0;mesh.visible=false;mesh.instanceMatrix.setUsage(DynamicDrawUsage);mesh.castShadow=part.castShadow;mesh.receiveShadow=true;mesh.customDepthMaterial=part.depth;mesh.customDistanceMaterial=part.distance;this.root.add(mesh);this.batches.push({variant,tier,part,mesh});}}}catch(error){this.dispose();throw error;}
  }
  update(cameraPosition:PlanetVector,renderOrigin:PlanetVector,nowSeconds:number):void{
    if(this.disposed)return;if(![...cameraPosition,...renderOrigin,nowSeconds].every(Number.isFinite))throw Error('Population frame requires finite positions and time.');
    this.installedThisFrame=0;const cameraRadius=Math.hypot(...cameraPosition),altitude=cameraRadius-this.world.planet.radius-this.world.planet.maxHeight;
    const active=altitude<=this.options.maxAltitudeMeters;this.root.visible=active;
    if(!active){for(const record of this.records.values())record.abort?.abort();this.records.clear();this.wanted.clear();this.treeCount=this.buildingCount=0;this.nextPlan=-Infinity;for(const batch of this.batches){batch.mesh.count=0;batch.mesh.visible=false;}return;}
    if(nowSeconds>=this.nextPlan||Math.hypot(...cameraPosition.map((n,i)=>n-this.lastPosition[i]))>this.options.cellMeters*.2){
      const cells=planetPopulationCells(this.world.planet.radius,cameraPosition,this.options);this.wanted=new Set(cells.map(planetPopulationCellKey));this.nextPlan=nowSeconds+.25;this.lastPosition=[...cameraPosition];
      for(const [key,record]of this.records)if(!this.wanted.has(key)){record.abort?.abort();this.records.delete(key);}
      for(const cell of cells){const key=planetPopulationCellKey(cell);if(!this.records.has(key))this.records.set(key,{cell,failed:false});}
    }
    for(const record of this.records.values())if(record.pending&&this.installedThisFrame<this.uploadBudget){record.data=record.pending;record.pending=undefined;this.installedThisFrame++;}
    for(const [key,record]of this.records){if(this.inFlight>=2)break;if(record.data||record.pending||record.abort||record.failed)continue;const abort=new AbortController();record.abort=abort;this.inFlight++;
      void this.source.request(record.cell,this.options,abort.signal).then(data=>{if(this.disposed||abort.signal.aborted||this.records.get(key)!==record){this.stale++;return;}if(data.key!==key||data.instances.length>this.options.treesPerCell+1)throw Error('Population worker returned an invalid cell.');record.pending=data;this.generated++;},error=>{if(!abort.signal.aborted&&!this.disposed){record.failed=true;this.failed++;this.lastError=String(error).slice(0,300);}}).catch(error=>{record.failed=true;this.failed++;this.lastError=String(error).slice(0,300);}).finally(()=>{this.inFlight--;});
    }
    this.draw(cameraPosition,renderOrigin,nowSeconds);
  }
  private draw(camera:PlanetVector,origin:PlanetVector,time:number){
    const start=performance.now(),available=[...this.records.values()].filter(record=>record.data),items=available.flatMap(record=>record.data!.instances).map(item=>({item,distance:Math.hypot(...item.position.map((n,i)=>n-camera[i]))})).filter(value=>value.distance<=this.options.radiusMeters).sort((a,b)=>a.distance-b.distance||a.item.id.localeCompare(b.item.id));
    let trees=0,buildings=0;const selected=items.filter(({item})=>item.kind==='tree'?trees++<this.options.maxTrees:buildings++<this.options.maxBuildings),counters=new Map<InstancedMesh,number>();this.treeCount=Math.min(trees,this.options.maxTrees);this.buildingCount=Math.min(buildings,this.options.maxBuildings);
    // CPU matrices and small instance buffers only. The prepared source geometry,
    // material maps and all LOD canopy triangles remain immutable and shared.
    let animated=0;for(const {item,distance}of selected){let pose=this.poses.get(item);if(!pose){const frame=planetPopulationFrame(item.up);this.local.makeBasis(this.position.set(...frame.x),new Vector3(...frame.y),new Vector3(...frame.z));this.orientation.setFromRotationMatrix(this.local);this.yaw.setFromAxisAngle(this.up,item.yaw);this.orientation.multiply(this.yaw);
        const globalWind=new Vector3(.8,0,.6).addScaledVector(new Vector3(...item.up),-(.8*item.up[0]+.6*item.up[2])).normalize(),wx=globalWind.dot(new Vector3(...frame.x)),wz=globalWind.dot(new Vector3(...frame.z)),c=Math.cos(item.yaw),s=Math.sin(item.yaw);pose={orientation:this.orientation.clone(),wind:[c*wx-s*wz,s*wx+c*wz]};this.poses.set(item,pose);}
      this.orientation.copy(pose.orientation);const variant=this.variants.get(item.variant);if(!variant)continue;
      if(item.kind==='tree'&&animated++<this.windBudget){const sampled=sampleTerrainAssetEnvironment(variant.environment,{id:item.id,height:variant.height*item.scale,position:{x:item.position[0],z:item.position[2]},timeSeconds:time,wind:{direction:pose.wind,strength:.45+.15*Math.sin(time*.7+(item.position[0]+item.position[2])*.02),gust:0}});this.sway.setFromEuler(this.euler.set(sampled.bend.x,0,sampled.bend.z));this.orientation.multiply(this.sway);}
      this.position.set(item.position[0]-origin[0],item.position[1]-origin[1],item.position[2]-origin[2]);this.size.setScalar(item.scale);this.matrix.compose(this.position,this.orientation,this.size);
      const tiers=Math.max(...variant.parts.map(part=>part.levels.length)),tier=item.kind==='tree'?Math.min(tiers-1,distance<45?0:distance<110?1:distance<220?2:3):0;
      for(const batch of this.batches)if(batch.variant===variant&&batch.tier===tier){const index=counters.get(batch.mesh)??0;this.local.multiplyMatrices(this.matrix,batch.part.local);batch.mesh.setMatrixAt(index,this.local);counters.set(batch.mesh,index+1);}
    }
    // One global bounded upload is cheaper than streaming prototype allocations.
    for(const batch of this.batches){const count=counters.get(batch.mesh)??0;batch.mesh.count=count;batch.mesh.visible=count>0;if(count){batch.mesh.instanceMatrix.needsUpdate=true;batch.mesh.computeBoundingSphere();}}
    this.uploadCpuMs=performance.now()-start;
  }
  inspection(){return{residentCells:this.records.size,maxCells:this.options.maxCells,inFlight:this.inFlight,preparedCells:this.generated,staleResults:this.stale,failed:this.failed,lastError:this.lastError,trees:this.treeCount,buildings:this.buildingCount,maxTrees:this.options.maxTrees,maxBuildings:this.options.maxBuildings,treeVariants:species.length,buildingVariants:2,batches:this.batches.length,drawCalls:this.batches.filter(batch=>batch.mesh.visible).length,triangles:this.batches.reduce((sum,batch)=>sum+batch.mesh.count*(batch.mesh.geometry.index?.count??batch.mesh.geometry.attributes.position.count)/3,0),uploadCpuMs:this.uploadCpuMs,installedThisFrame:this.installedThisFrame,scope:'visual population; static prototype doors; no spherical physics'};}
  dispose(){if(this.disposed)return;this.disposed=true;for(const record of this.records.values())record.abort?.abort();this.records.clear();this.source.dispose();for(const batch of this.batches)batch.mesh.dispose();this.batches.length=0;this.release();this.root.removeFromParent();this.root.clear();}
}
