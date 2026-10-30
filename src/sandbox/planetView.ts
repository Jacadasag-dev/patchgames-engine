import {BufferAttribute,BufferGeometry,Group,Material,Mesh,MeshStandardMaterial,Ray,Vector3} from 'three';
import {planetCoordinates,planetTileChildren,planetTileKey,type CompiledPlanet,type PlanetPatchData,type PlanetTile,type PlanetVector} from '../shared/planet.ts';
import {planPlanetTiles,type PlanetLodFrame} from '../shared/planetLod.ts';

/** Trusted preparation service. Requests must run outside the render thread. */
export interface PlanetPatchSource {
  request(tile:PlanetTile,signal?:AbortSignal):Promise<PlanetPatchData>;
  dispose():void;
}
export interface PlanetViewOptions {
  maxResidentPatches?:number;
  maxSelectedPatches?:number;
  maxResidentBytes?:number;
  maxInFlight?:number;
  maxUploadsPerFrame?:number;
  targetCellPixels?:number;
  material?:Material|Material[];
}
export interface PlanetViewFrame extends PlanetLodFrame {origin?:PlanetVector}
interface Patch {
  tile:PlanetTile;
  mesh?:Mesh;
  origin?:PlanetVector;
  bytes:number;
  prepared?:PlanetPatchData;
  abort?:AbortController;
  lastNeeded:number;
  failedUntil:number;
}
function bounded(value:number|undefined,fallback:number,min:number,max:number,name:string,integer=true):number {
  const n=value??fallback;
  if(!Number.isFinite(n)||n<min||n>max||integer&&!Number.isInteger(n))throw Error(`Planet ${name} must be ${integer?'an integer':'finite'} in ${min}..${max}.`);
  return n;
}
const vector=(v:PlanetVector)=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e9);
const parent=(tile:PlanetTile):PlanetTile|undefined=>tile.level?{face:tile.face,level:tile.level-1,x:Math.floor(tile.x/2),y:Math.floor(tile.y/2)}:undefined;

/** A resident coarse globe with bounded asynchronous refinement. Geometry is
 * patch-local; update rebases presentation only, never recipe/query coordinates.
 * This is a visual surface, not a spherical gameplay/physics controller. */
export class PlanetView {
  readonly root=new Group();
  readonly planet:CompiledPlanet;
  private readonly source:PlanetPatchSource;
  private readonly patches=new Map<string,Patch>();
  private readonly material:Material|Material[];
  private readonly coarseMaterial?:MeshStandardMaterial;
  private readonly ownsMaterial:boolean;
  private readonly options:Required<Omit<PlanetViewOptions,'material'>>;
  private wanted=new Set<string>();
  private refined=new Set<string>();
  private nextPlan=0;
  private disposed=false;
  private inFlight=0;
  private residentBytes=0;
  private generation=0;
  private visible=0;
  private triangles=0;
  private deepest=0;
  private requested=0;
  private completed=0;
  private rejected=0;
  private evicted=0;
  private failed=0;
  private budgetLimited=false;
  private selectedPatches=6;
  private installCpuMs=0;
  private planCpuMs=0;
  private installedThisFrame=0;
  private lastError='';
  constructor(planet:CompiledPlanet,source:PlanetPatchSource,options:PlanetViewOptions={}) {
    this.planet=planet;this.source=source;
    this.options={
      maxResidentPatches:bounded(options.maxResidentPatches,768,12,2048,'resident patches'),
      maxSelectedPatches:bounded(options.maxSelectedPatches,192,6,512,'selected patches'),
      maxResidentBytes:bounded(options.maxResidentBytes,64*1024*1024,256*1024,256*1024*1024,'resident bytes'),
      maxInFlight:bounded(options.maxInFlight,2,1,8,'concurrent requests'),
      maxUploadsPerFrame:bounded(options.maxUploadsPerFrame,2,1,8,'uploads per frame'),
      targetCellPixels:bounded(options.targetCellPixels,12,2,128,'target cell pixels',false),
    };
    if(this.options.maxResidentPatches<Math.ceil(this.options.maxSelectedPatches*4/3)+6)throw Error('Planet resident patch budget must retain selected patches and their fallback ancestors.');
    const n=planet.recipe.segments,patchBytes=((n+1)**2+4*n)*36+(6*n*n+24*n)*2;
    if(this.options.maxResidentBytes<6*patchBytes)throw Error('Planet resident byte budget must retain all six coarse roots.');
    this.ownsMaterial=!options.material;
    this.material=options.material??new MeshStandardMaterial({vertexColors:true,roughness:1,metalness:0});
    if(Array.isArray(this.material))this.coarseMaterial=new MeshStandardMaterial({vertexColors:true,roughness:1,metalness:0});
    this.root.name='GeneratedPlanet';
    for(let face=0;face<6;face++)this.record({face,level:0,x:0,y:0});
  }
  private record(tile:PlanetTile):Patch {
    const key=planetTileKey(tile);let record=this.patches.get(key);
    if(!record){record={tile,bytes:0,lastNeeded:this.generation,failedUntil:0};this.patches.set(key,record);}
    return record;
  }
  private plan(frame:PlanetViewFrame,now:number):void {
    const start=performance.now(),plan=planPlanetTiles(this.planet,frame,{maxPatches:this.options.maxSelectedPatches,targetCellPixels:this.options.targetCellPixels});
    this.wanted=new Set();this.refined=new Set();this.generation++;
    for(let tile of plan.tiles){
      this.wanted.add(planetTileKey(tile));
      for(let ancestor=parent(tile);ancestor;ancestor=parent(ancestor)){
        const key=planetTileKey(ancestor);this.wanted.add(key);this.refined.add(key);
      }
    }
    this.budgetLimited=plan.budgetLimited;
    this.selectedPatches=plan.tiles.length;
    for(const [key,record] of this.patches){
      if(this.wanted.has(key))record.lastNeeded=this.generation;
      else if(record.abort){record.abort.abort();record.abort=undefined;}
    }
    this.nextPlan=now+100;this.planCpuMs=performance.now()-start;
  }
  private validate(data:PlanetPatchData,record:Patch):void {
    if(data.revision!==this.planet.revision||data.key!==planetTileKey(record.tile)||planetTileKey(data.tile)!==data.key
      ||!vector(data.origin)||!(data.positions instanceof Float32Array)||!(data.normals instanceof Float32Array)
      ||!(data.colors instanceof Float32Array)||!(data.indices instanceof Uint16Array)
      ||data.positions.length<12||data.positions.length%3||data.positions.length>8192*3
      ||data.normals.length!==data.positions.length||data.colors.length!==data.positions.length
      ||!data.indices.length||data.indices.length%3||data.indices.length>32768)throw Error('Planet worker returned invalid or stale patch data.');
    const vertices=data.positions.length/3;
    for(const values of [data.positions,data.normals,data.colors])for(const value of values)if(!Number.isFinite(value))throw Error('Planet patch contains a nonfinite vertex.');
    for(const index of data.indices)if(index>=vertices)throw Error('Planet patch index is outside its vertex buffer.');
    if(data.uvs&&(!(data.uvs instanceof Float32Array)||data.uvs.length!==vertices*2||!data.uvs.every(Number.isFinite)))throw Error('Planet patch UVs must be finite and match its vertices.');
    if(data.groups){let end=0;for(const group of data.groups){if(!Number.isInteger(group.start)||group.start!==end||!Number.isInteger(group.count)||group.count<=0||group.count%3||!Number.isInteger(group.materialIndex)||group.materialIndex<0||group.materialIndex>=(Array.isArray(this.material)?this.material.length:1))throw Error('Planet material groups must cover contiguous triangles with valid material indices.');end+=group.count;}if(end!==data.indices.length)throw Error('Planet material groups must cover the full index buffer.');}
    const bytes=data.positions.byteLength+data.normals.byteLength+data.colors.byteLength+data.indices.byteLength+(data.uvs?.byteLength??0);
    if(bytes!==data.byteLength)throw Error('Planet patch byte accounting differs from its buffers.');
  }
  private install():void {
    const start=performance.now();this.installedThisFrame=0;let attempted=0;
    const ready=[...this.patches.values()].filter(record=>record.prepared).sort((a,b)=>a.tile.level-b.tile.level||a.lastNeeded-b.lastNeeded);
    for(const record of ready){
      if(attempted++>=this.options.maxUploadsPerFrame)break;
      const data=record.prepared!;record.prepared=undefined;
      if(!this.wanted.has(data.key)){this.rejected++;continue;}
      let geometry:BufferGeometry|undefined;
      try{
        this.validate(data,record);
        if(this.residentBytes+data.byteLength>this.options.maxResidentBytes){this.budgetLimited=true;record.failedUntil=performance.now()+1000;continue;}
        geometry=new BufferGeometry();
        geometry.setAttribute('position',new BufferAttribute(data.positions,3));
        geometry.setAttribute('normal',new BufferAttribute(data.normals,3));
        geometry.setAttribute('color',new BufferAttribute(data.colors,3));
        if(data.uvs)geometry.setAttribute('uv',new BufferAttribute(data.uvs,2));
        for(const group of data.groups??[])geometry.addGroup(group.start,group.count,group.materialIndex);
        geometry.setIndex(new BufferAttribute(data.indices,1));geometry.computeBoundingSphere();
        const mesh=new Mesh(geometry,data.uvs?this.material:this.coarseMaterial??this.material);mesh.name='PlanetPatch:'+data.key;mesh.visible=false;
        record.mesh=mesh;record.origin=data.origin;record.bytes=data.byteLength;this.residentBytes+=record.bytes;
        this.root.add(mesh);this.completed++;this.installedThisFrame++;
      }catch(error){geometry?.dispose();this.failure(record,error);}
    }
    this.installCpuMs=performance.now()-start;
  }
  private failure(record:Patch,error:unknown):void {
    this.failed++;record.failedUntil=performance.now()+5000;
    this.lastError=(error instanceof Error?error.message:String(error)).slice(0,500);
  }
  private trim():void {
    const candidates=[...this.patches.entries()].filter(([key,record])=>!this.wanted.has(key)&&!record.mesh?.visible&&!record.abort).sort((a,b)=>a[1].lastNeeded-b[1].lastNeeded);
    for(const [key,record] of candidates){
      if(this.patches.size<this.options.maxResidentPatches&&this.residentBytes<this.options.maxResidentBytes*.85&&this.generation-record.lastNeeded<3)continue;
      record.mesh?.geometry.dispose();record.mesh?.removeFromParent();this.residentBytes-=record.bytes;this.patches.delete(key);this.evicted++;
    }
  }
  private request(now:number):void {
    const candidates:PlanetTile[]=[];
    // Walk only the demanded hierarchy. A child request needs its fallback parent.
    const visit=(tile:PlanetTile)=>{
      const key=planetTileKey(tile),record=this.patches.get(key);
      if(!record?.mesh){if(!record?.abort&&!record?.prepared&&(!record||record.failedUntil<=now))candidates.push(tile);return;}
      if(this.refined.has(key))for(const child of planetTileChildren(tile))visit(child);
    };
    for(let face=0;face<6;face++)visit({face,level:0,x:0,y:0});
    candidates.sort((a,b)=>a.level-b.level);
    for(const tile of candidates){
      if(this.inFlight>=this.options.maxInFlight)break;
      const key=planetTileKey(tile);
      if(!this.patches.has(key)&&this.patches.size>=this.options.maxResidentPatches){this.budgetLimited=true;break;}
      const record=this.record(tile),abort=new AbortController();record.abort=abort;record.lastNeeded=this.generation;this.inFlight++;this.requested++;
      // Promise boundary also catches a misbehaving source that throws synchronously.
      void Promise.resolve().then(()=>this.source.request(tile,abort.signal)).then(data=>{
        if(this.disposed||abort.signal.aborted||this.patches.get(key)!==record||record.abort!==abort){this.rejected++;return;}
        record.prepared=data;
      },error=>{if(!this.disposed&&!abort.signal.aborted)this.failure(record,error);}).finally(()=>{
        this.inFlight--;if(record.abort===abort)record.abort=undefined;
      });
    }
  }
  private show():void {
    this.visible=this.triangles=this.deepest=0;
    for(const record of this.patches.values())if(record.mesh)record.mesh.visible=false;
    const visit=(tile:PlanetTile)=>{
      const key=planetTileKey(tile),record=this.patches.get(key);if(!record?.mesh)return;
      const children=this.refined.has(key)?planetTileChildren(tile):[];
      if(children.length&&children.every(child=>this.patches.get(planetTileKey(child))?.mesh))for(const child of children)visit(child);
      else{record.mesh.visible=true;this.visible++;this.triangles+=(record.mesh.geometry.index?.count??0)/3;this.deepest=Math.max(this.deepest,tile.level);}
    };
    for(let face=0;face<6;face++)visit({face,level:0,x:0,y:0});
  }
  update(frame:PlanetViewFrame):void {
    if(this.disposed)return;
    const origin=frame.origin??frame.position;if(!vector(origin))throw Error('Planet render origin must be a finite absolute metre position.');
    const now=performance.now();if(now>=this.nextPlan||!this.wanted.size)this.plan(frame,now);
    this.install();this.show();this.trim();this.request(now);
    this.rebase(origin);
  }
  /** Move presentation into a new double-precision origin without preparing or
   * publishing more geometry. Cameras, props and lights must use the same origin. */
  rebase(origin:PlanetVector):void {
    if(this.disposed)return;
    if(!vector(origin))throw Error('Planet render origin must be a finite absolute metre position.');
    for(const record of this.patches.values())if(record.mesh&&record.origin)record.mesh.position.set(record.origin[0]-origin[0],record.origin[1]-origin[1],record.origin[2]-origin[2]);
  }
  /** Radial query against the CURRENT displayed triangles, excluding skirts.
   * Useful for visual-flight clearance while coarse fallback is still visible.
   * Source authority remains planet.sample; this is never a gameplay collider. */
  displayedSurface(direction:PlanetVector):{heightMeters:number;level:number}|undefined {
    const coordinates=planetCoordinates(direction),segments=this.planet.recipe.segments;
    const ray=new Ray(new Vector3(),new Vector3(...direction).normalize()),a=new Vector3(),b=new Vector3(),c=new Vector3(),hit=new Vector3();
    for(const record of this.patches.values()){
      if(!record.mesh?.visible||!record.origin||record.tile.face!==coordinates.face)continue;
      const divisions=2**record.tile.level;
      const u=(coordinates.u+1)*.5*divisions-record.tile.x,v=(coordinates.v+1)*.5*divisions-record.tile.y;
      if(u< -1e-8||u>1+1e-8||v< -1e-8||v>1+1e-8)continue;
      const x=Math.max(0,Math.min(segments-1,Math.floor(u*segments))),y=Math.max(0,Math.min(segments-1,Math.floor(v*segments)));
      const geometry=record.mesh.geometry,positions=geometry.getAttribute('position'),indices=geometry.index!;
      const load=(target:Vector3,index:number)=>target.set(positions.getX(index)+record.origin![0],positions.getY(index)+record.origin![1],positions.getZ(index)+record.origin![2]);
      const offset=(y*segments+x)*6;
      for(let triangle=0;triangle<2;triangle++){
        load(a,indices.getX(offset+triangle*3));load(b,indices.getX(offset+triangle*3+1));load(c,indices.getX(offset+triangle*3+2));
        if(ray.intersectTriangle(a,b,c,false,hit))return{heightMeters:hit.length()-this.planet.radius,level:record.tile.level};
      }
    }
    return undefined;
  }
  inspection(){
    let rootsReady=0,prepared=0,preparedBytes=0;for(const record of this.patches.values()){if(record.tile.level===0&&record.mesh)rootsReady++;if(record.prepared){prepared++;preparedBytes+=record.prepared.byteLength;}}
    return{revision:this.planet.revision,radiusMeters:this.planet.radius,rootsReady,coverageReady:rootsReady===6,visiblePatches:this.visible,residentPatches:this.patches.size,
      residentBytes:this.residentBytes,preparedBytes,byteMetric:'CPU vertex/index payload; excludes GPU copies, object and worker memory',inFlight:this.inFlight,preparedPatches:prepared,selectedPatches:this.selectedPatches,neededPatches:this.wanted.size,deepestVisibleLevel:this.deepest,
      approximateFinestCellMeters:Math.PI*this.planet.radius/(2**(this.deepest+1)*this.planet.recipe.segments),triangles:this.triangles,
      requests:this.requested,completed:this.completed,rejected:this.rejected,evicted:this.evicted,failures:this.failed,lastError:this.lastError,
      budgetLimited:this.budgetLimited,installedThisFrame:this.installedThisFrame,installCpuMs:this.installCpuMs,planCpuMs:this.planCpuMs,
      limits:{...this.options},disposed:this.disposed};
  }
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    for(const record of this.patches.values()){record.abort?.abort();record.mesh?.geometry.dispose();}
    this.source.dispose();this.patches.clear();this.root.clear();this.residentBytes=0;
    if(this.ownsMaterial)for(const material of Array.isArray(this.material)?this.material:[this.material])material.dispose();
    this.coarseMaterial?.dispose();
  }
}
