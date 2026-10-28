/** Cosmetic secondary water detail driven by WaterDetailEvent inputs.
 *
 * Spray inherits incident motion and follows gravity until it meets water or
 * ground. Mist relaxes toward the wind and fades. Foam forms only from wet
 * impacts or breaking flow, rides the accepted surface current, gathers where
 * that current converges and decays. Bubbles start beneath energetic wet
 * impacts, rise through the depth and surface as foam.
 *
 * Particles are bounded, use fixed internal substeps independent of render
 * rate, and never write volume, momentum or forces back to the simulation.
 * Turning this view off or lowering its quality leaves physics identical. */
import {AdditiveBlending,BufferAttribute,BufferGeometry,CircleGeometry,Color,DataTexture,DynamicDrawUsage,Group,InstancedMesh,LinearFilter,MeshBasicMaterial,Object3D,Points,RGBAFormat,ShaderMaterial,type Texture} from 'three';
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodySurfaceBuffers} from './waterBodyView.ts';
import type {WaterDetailEvent} from './waterDetail.ts';
import type {WaterBodyFlight} from './waterBodyFlights.ts';
import {sampleBoundaryWater} from './waterBoundary.ts';
import type {PhysicsScene,PhysicsVector} from './physics.ts';
import {collideLiquid,liquidObstacles,type LiquidObstacle} from './liquidCollision.ts';

export type WaterDetailQuality='off'|'low'|'high';
export interface WaterDetailViewOptions {
  /** Cosmetic budget only. Default 'high'. */quality?:WaterDetailQuality;
  /** Shared water palette; foam defaults to the pool foam colour. */color?:string;foamColor?:string;
  /** Air velocity for mist drift in m/s; use the water system's wind. */wind?:{x:number;z:number};
  /** Optional deterministic seed for reproducible captures. */seed?:number;
  /** Native solid geometry, including floors above/below this water layer. */scene?:PhysicsScene;
}
// Airborne and submerged kinds; foam lives in its own surface pool.
const SPRAY=0,MIST=1,BUBBLE=3;
const budgets={off:{air:0,foam:0,scale:0},low:{air:900,foam:500,scale:.45},high:{air:2600,foam:1400,scale:1}} as const;
const STEP=1/60,G=-9.81;
// Prepared once per changed scene, never once per particle. The native liquid
// collider limit bounds this tree to 256 leaves and eight balanced levels.
interface DetailSolidNode {min:PhysicsVector;max:PhysicsVector;items?:LiquidObstacle[];left?:DetailSolidNode;right?:DetailSolidNode}
function solidTree(items:LiquidObstacle[]):DetailSolidNode|undefined {
  if(!items.length)return;
  const min={x:Infinity,y:Infinity,z:Infinity},max={x:-Infinity,y:-Infinity,z:-Infinity};
  for(const item of items)for(const axis of ['x','y','z'] as const){min[axis]=Math.min(min[axis],item.min[axis]);max[axis]=Math.max(max[axis],item.max[axis]);}
  if(items.length<=4)return{min,max,items};
  const axis=max.x-min.x>=max.y-min.y&&max.x-min.x>=max.z-min.z?'x':max.y-min.y>=max.z-min.z?'y':'z';
  items.sort((a,b)=>(a.min[axis]+a.max[axis])-(b.min[axis]+b.max[axis]));const half=items.length>>1;
  return{min,max,left:solidTree(items.slice(0,half)),right:solidTree(items.slice(half))};
}
function hitsSolid(node:DetailSolidNode|undefined,a:PhysicsVector,b:PhysicsVector,radius=.01):boolean {
  if(!node)return false;
  if(Math.max(a.x,b.x)<node.min.x-radius||Math.min(a.x,b.x)>node.max.x+radius
    ||Math.max(a.y,b.y)<node.min.y-radius||Math.min(a.y,b.y)>node.max.y+radius
    ||Math.max(a.z,b.z)<node.min.z-radius||Math.min(a.z,b.z)>node.max.z+radius)return false;
  if(node.items){for(const obstacle of node.items)if(collideLiquid(a,b,radius,obstacle,0))return true;return false;}
  return hitsSolid(node.left,a,b,radius)||hitsSolid(node.right,a,b,radius);
}
/** Shared prepared native-solid sweep for cosmetic particles and ribbons. */
export function createWaterDetailSolidQuery(scene:PhysicsScene):(from:PhysicsVector,to:PhysicsVector,radius?:number)=>boolean {
  const tree=solidTree(liquidObstacles({colliders:scene.colliders},[]));return(from,to,radius=.01)=>hitsSolid(tree,from,to,radius);
}
function deeplyFrozen(value:unknown):boolean {
  return !value||typeof value!=='object'||Object.isFrozen(value)&&Object.values(value).every(deeplyFrozen);
}

interface DetailTopTriangle {x:number;z:number;y:number;ux:number;uz:number;uy:number;vx:number;vz:number;vy:number;inverse:number}
/** Accepted top triangles are local to their original control cell. Index them
 * once per accepted frame, copying coefficients so worker buffer reuse cannot
 * leave stale bounds. Queries never extrapolate across a dry gap or wall and
 * never inspect another water layer's surface. */
class DetailTopIndex {
  private readonly bins=new Map<number,DetailTopTriangle[]>();
  private readonly water:WaterBodyManifest;
  constructor(water:WaterBodyManifest,surface:WaterBodySurfaceBuffers){
    this.water=water;
    const p=surface.positions,n=surface.normals,w=water;
    for(let i=0;i<p.length;i+=9){
      if(n[i+1]+n[i+4]+n[i+7]<=0)continue;
      const ux=p[i+3]-p[i],uz=p[i+5]-p[i+2],vx=p[i+6]-p[i],vz=p[i+8]-p[i+2],det=ux*vz-uz*vx;if(Math.abs(det)<1e-18)continue;
      const triangle={x:p[i],z:p[i+2],y:p[i+1],ux,uz,uy:p[i+4]-p[i+1],vx,vz,vy:p[i+7]-p[i+1],inverse:1/det};
      const x0=Math.max(0,Math.floor((Math.min(p[i],p[i+3],p[i+6])-w.origin.x)/w.cellSizeX)),x1=Math.min(w.columns-1,Math.floor((Math.max(p[i],p[i+3],p[i+6])-w.origin.x)/w.cellSizeX));
      const z0=Math.max(0,Math.floor((Math.min(p[i+2],p[i+5],p[i+8])-w.origin.z)/w.cellSizeZ)),z1=Math.min(w.rows-1,Math.floor((Math.max(p[i+2],p[i+5],p[i+8])-w.origin.z)/w.cellSizeZ));
      for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){const key=x*w.rows+z;let bin=this.bins.get(key);if(!bin){bin=[];this.bins.set(key,bin);}bin.push(triangle);}
    }
  }
  height(x:number,z:number,reference:number):number|undefined {
    const w=this.water,cx=Math.floor((x-w.origin.x)/w.cellSizeX),cz=Math.floor((z-w.origin.z)/w.cellSizeZ);if(cx<0||cz<0||cx>=w.columns||cz>=w.rows)return;
    let top:number|undefined,distance=Infinity;
    for(const t of this.bins.get(cx*w.rows+cz)??[]){const dx=x-t.x,dz=z-t.z,u=(dx*t.vz-dz*t.vx)*t.inverse,v=(t.ux*dz-t.uz*dx)*t.inverse;
      if(u< -1e-7||v< -1e-7||u+v>1+1e-7)continue;
      const y=t.y+u*t.uy+v*t.vy,d=Math.abs(y-reference);if(d<distance){top=y;distance=d;}
    }
    return top;
  }
}

function softDisc():DataTexture {
  const size=32,data=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const dx=(x+.5)/size*2-1,dy=(y+.5)/size*2-1,r=Math.hypot(dx,dy),a=Math.max(0,1-r)**1.4*(.82+.18*Math.cos(r*9));
    const i=(y*size+x)*4;data[i]=data[i+1]=data[i+2]=255;data[i+3]=Math.round(255*Math.min(1,a*1.4));
  }
  const texture=new DataTexture(data,size,size,RGBAFormat);texture.magFilter=texture.minFilter=LinearFilter;texture.needsUpdate=true;return texture;
}
const airVertex=`
#include <clipping_planes_pars_vertex>
attribute float size;attribute float alpha;attribute vec3 tint;
varying float vAlpha;varying vec3 vTint;
uniform float scale;
void main(){vec4 mvPosition=modelViewMatrix*vec4(position,1.);
#include <clipping_planes_vertex>
gl_Position=projectionMatrix*mvPosition;gl_PointSize=clamp(size*scale/max(.05,-mvPosition.z),1.,96.);vAlpha=alpha;vTint=tint;}`;
const airFragment=`
#include <clipping_planes_pars_fragment>
varying float vAlpha;varying vec3 vTint;
void main(){
#include <clipping_planes_fragment>
vec2 p=gl_PointCoord*2.-1.;float r=dot(p,p);if(r>1.)discard;float a=vAlpha*smoothstep(1.,.15,r);gl_FragColor=vec4(vTint,a);}`;

/** One bounded pool per detail kind; airborne/underwater points plus flat foam. */
export class WaterDetailView {
  readonly root=new Group();
  private readonly water:WaterBodyManifest;
  private quality:WaterDetailQuality;
  private readonly wind:{x:number;z:number};
  private state?:WaterBodyState;
  private topIndex?:DetailTopIndex;
  private readonly flightBins=new Map<number,WaterBodyFlight[]>();
  private readonly launchCandidates=new Set<WaterBodyFlight>();
  private seed:number;private readonly initialSeed:number;private accumulator=0;
  // Airborne (spray, mist) and submerged (bubble) samples.
  private readonly air:{position:Float32Array;velocity:Float32Array;age:Float32Array;life:Float32Array;size:Float32Array;kind:Uint8Array;count:number};
  private readonly foam:{position:Float32Array;velocity:Float32Array;airborne:Uint8Array;age:Float32Array;life:Float32Array;size:Float32Array;count:number};
  private readonly points:Points;private readonly bubbles:Points;private readonly foamMesh:InstancedMesh;
  private readonly airMaterial:ShaderMaterial;private readonly bubbleMaterial:ShaderMaterial;private readonly foamMaterial:MeshBasicMaterial;
  private readonly disc:Texture;private readonly dummy=new Object3D();
  private readonly colors:{water:Color;foam:Color;mist:Color};
  private disposed=false;
  private collisionScene?:PhysicsScene;private collisionKey?:string;private solids?:DetailSolidNode;
  private collisionColliders?:PhysicsScene['colliders'];private immutableColliders=false;
  private readonly sweepFrom={x:0,y:0,z:0};private readonly sweepTo={x:0,y:0,z:0};
  constructor(water:WaterBodyManifest,options:WaterDetailViewOptions={}){
    this.water=water;this.quality=options.quality??'high';if(!(this.quality in budgets))throw new Error('Invalid water detail quality');
    this.wind={x:options.wind?.x??0,z:options.wind?.z??0};if(!Number.isFinite(this.wind.x+this.wind.z))throw new Error('Invalid water detail wind');
    this.seed=this.initialSeed=(options.seed??1)>>>0||1;
    const air=budgets.high.air,foam=budgets.high.foam;
    this.air={position:new Float32Array(air*3),velocity:new Float32Array(air*3),age:new Float32Array(air),life:new Float32Array(air),size:new Float32Array(air),kind:new Uint8Array(air),count:0};
    this.foam={position:new Float32Array(foam*3),velocity:new Float32Array(foam*3),airborne:new Uint8Array(foam),age:new Float32Array(foam),life:new Float32Array(foam),size:new Float32Array(foam),count:0};
    const water_=new Color(options.color??'#257d86'),foamColor=new Color(options.foamColor??'#eef8f4');
    this.colors={water:water_.clone().lerp(new Color('#ffffff'),.55),foam:foamColor,mist:foamColor.clone().lerp(new Color('#ffffff'),.4)};
    const geometry=(n:number)=>{const g=new BufferGeometry();
      for(const [name,size] of [['position',3],['size',1],['alpha',1],['tint',3]] as const){const a=new BufferAttribute(new Float32Array(n*size),size);a.setUsage(DynamicDrawUsage);g.setAttribute(name,a);}
      g.setDrawRange(0,0);return g;};
    this.airMaterial=new ShaderMaterial({vertexShader:airVertex,fragmentShader:airFragment,clipping:true,uniforms:{scale:{value:520}},transparent:true,depthWrite:false});
    this.bubbleMaterial=new ShaderMaterial({vertexShader:airVertex,fragmentShader:airFragment,clipping:true,uniforms:{scale:{value:520}},transparent:true,depthWrite:false,blending:AdditiveBlending});
    this.points=new Points(geometry(air),this.airMaterial);this.points.frustumCulled=false;this.points.renderOrder=12;this.points.name='water-detail:spray-mist';
    // Submerged bubbles draw before the transparent pool so its surface tints them.
    this.bubbles=new Points(geometry(air),this.bubbleMaterial);this.bubbles.frustumCulled=false;this.bubbles.renderOrder=-2;this.bubbles.name='water-detail:bubbles';
    this.disc=softDisc();
    this.foamMaterial=new MeshBasicMaterial({color:this.colors.foam,alphaMap:this.disc,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,opacity:.85});
    const circle=new CircleGeometry(.5,12);circle.rotateX(-Math.PI/2);
    this.foamMesh=new InstancedMesh(circle,this.foamMaterial,foam);this.foamMesh.instanceMatrix.setUsage(DynamicDrawUsage);this.foamMesh.count=0;this.foamMesh.frustumCulled=false;this.foamMesh.renderOrder=11;this.foamMesh.name='water-detail:foam';
    this.root.add(this.bubbles,this.foamMesh,this.points);this.root.visible=this.quality!=='off';
    if(options.scene)this.setScene(options.scene);
  }
  setQuality(quality:WaterDetailQuality):void {
    if(!(quality in budgets))throw new Error('Invalid water detail quality');this.quality=quality;this.root.visible=quality!=='off';
    const b=budgets[quality];this.air.count=Math.min(this.air.count,b.air);this.foam.count=Math.min(this.foam.count,b.foam);this.upload();
    if(quality!=='off'&&this.collisionScene)this.setScene(this.collisionScene);
  }
  /** Call when presenting accepted native geometry. A content key handles
   * cloned worker scenes and mutable collider edits without stale floors. */
  setScene(scene:PhysicsScene):void {
    this.collisionScene=scene;if(this.quality==='off')return;
    if(scene.colliders===this.collisionColliders&&this.immutableColliders)return;
    if(scene.colliders!==this.collisionColliders){this.collisionColliders=scene.colliders;this.immutableColliders=deeplyFrozen(scene.colliders);}
    const key=JSON.stringify(scene.colliders);if(key===this.collisionKey)return;
    const solids=solidTree(liquidObstacles({colliders:scene.colliders},[]));this.solids=solids;this.collisionKey=key;
  }
  get counts():{spray:number;mist:number;bubbles:number;foam:number} {
    const c={spray:0,mist:0,bubbles:0,foam:this.foam.count};for(let i=0;i<this.air.count;i++){const k=this.air.kind[i];if(k===SPRAY)c.spray++;else if(k===MIST)c.mist++;else c.bubbles++;}return c;
  }
  /** Clear presentation history when the accepted simulation is reset/rewound. */
  reset():void {this.air.count=this.foam.count=0;this.accumulator=0;this.seed=this.initialSeed;this.state=undefined;this.topIndex=undefined;this.flightBins.clear();this.launchCandidates.clear();this.upload();}
  /** Add detail for one accepted frame. Supply that frame's body state so
   * foam and bubbles follow the same surface and currents the pool shows. */
  ingest(events:readonly WaterDetailEvent[],state?:WaterBodyState,surface?:WaterBodySurfaceBuffers):void {
    if(this.disposed)return;
    if(surface&&(!state||surface.waterRevision!==this.water.revision||surface.revision!==state.revision||surface.time!==state.time))throw new Error('Water detail surface must match its accepted water state');
    if(state){this.state=state;this.topIndex=surface?new DetailTopIndex(this.water,surface):undefined;this.indexFoamFlights(state);}
    const b=budgets[this.quality];if(!b.scale)return;
    for(const e of events){
      if(e.kind==='flight')continue;
      if(!(e.duration>0&&Number.isFinite(e.duration)))continue;
      const speed=Math.hypot(e.velocity.x,e.velocity.y,e.velocity.z),power=e.energy/e.duration;
      // Emission represents physical time, not the number of worker packets.
      // Keep the established 30 Hz density while allowing merged/substeps.
      const scale=b.scale*Math.min(.1,Math.max(0,e.duration))*30;
      if(e.kind==='impact'||e.kind==='splash'){
        const breakup=Math.min(speed,Math.sqrt(2*e.energy/(this.water.liquid.restDensity*Math.max(e.volume,1e-12))));
        // Impact/contact spray is a soft persistent plume in the shared
        // terrain-effects view. Keep only waterborne bubbles and foam here;
        // separate point droplets would duplicate the same physical event.
        if(e.wet){
          const foam=this.count(Math.min(10,e.volume/e.duration*40+power/900)*scale);
          for(let k=0;k<foam;k++)this.emitFoam(this.jitter(e.position,e.radius*1.2,0),5+5*this.random(),.08+.12*this.random());
          const bubbles=this.count(Math.min(10,power/700)*scale),reach=Math.min(e.depth*.9,.06+(e.kind==='splash'?breakup:Math.abs(e.velocity.y))*.06);
          for(let k=0;k<bubbles;k++){const p=this.jitter(e.position,e.radius*.8,0);p.y-=reach*this.random();this.emitAir(BUBBLE,p,{x:e.velocity.x*.05,y:.12+.18*this.random(),z:e.velocity.z*.05},4,.025+.03*this.random());}
        }
      }else if(e.kind==='rapid'){
        const foam=this.count(Math.min(3,power/400)*scale);
        for(let k=0;k<foam;k++)this.emitFoam(this.jitter(e.position,e.radius,0),3+3*this.random(),.06+.08*this.random());
      }else if(speed>3){
        // A lip only throws droplets when it is genuinely fast and turbulent.
        const spray=this.count(Math.min(1,power/6000)*scale);
        for(let k=0;k<spray;k++)this.emitAir(SPRAY,this.jitter(e.position,e.radius,.02),{x:e.velocity.x*(.9+.2*this.random()),y:.2*this.random(),z:e.velocity.z*(.9+.2*this.random())},.5,.03);
      }
    }
    if(this.topIndex){const f=this.foam;for(let i=0;i<f.count;i++){if(f.airborne[i])continue;const p=i*3,top=this.topIndex.height(f.position[p],f.position[p+2],f.position[p+1]-.006);if(top!==undefined)f.position[p+1]=top+.006;}this.uploadFoam();}
  }
  /** Advance by displayed seconds (excluding pauses). Fixed 1/60 substeps;
   * at most 0.1 s per call so a hidden tab does not burst. */
  animate(elapsedSeconds:number):void {
    if(this.disposed||this.quality==='off'||!(elapsedSeconds>0))return;
    this.accumulator=Math.min(.1,this.accumulator+elapsedSeconds);
    while(this.accumulator>=STEP){this.step(STEP);this.accumulator-=STEP;}
    this.upload();
  }
  private surface(x:number,z:number):{top:number;wet:boolean;u:number;v:number}|undefined {
    const w=this.water,s=this.state;if(!s)return;
    if(s.boundary){const sample=sampleBoundaryWater(w,s,{x,z});return sample?{top:sample.surface,wet:sample.depth>w.wetDepth,u:sample.velocity.x,v:sample.velocity.z}:undefined;}
    const cx=Math.floor((x-w.origin.x)/w.cellSizeX),cz=Math.floor((z-w.origin.z)/w.cellSizeZ);if(cx<0||cz<0||cx>=w.columns||cz>=w.rows)return;
    const i=cx*w.rows+cz,depth=s.depth[i];return{top:s.bed[i]+depth+(s.solidDepth?.[i]??0),wet:depth>w.wetDepth,u:s.flowX[i],v:s.flowZ[i]};
  }
  /** Only a fresh physical emission crossed in its outgoing direction can
   * carry existing surface foam into flight. No new water or foam is emitted. */
  private indexFoamFlights(state:WaterBodyState):void {
    const w=this.water;this.flightBins.clear();
    for(const f of state.flights??[]){
      const age=state.time-f.time;if(f.destination||f.emittedTime!==undefined||age< -1e-7||age>f.duration*.5+1e-7)continue;
      const x0=Math.max(0,Math.floor((Math.min(f.edge[0].x,f.edge[1].x)-w.origin.x)/w.cellSizeX)-1),x1=Math.min(w.columns-1,Math.floor((Math.max(f.edge[0].x,f.edge[1].x)-w.origin.x)/w.cellSizeX)+1);
      const z0=Math.max(0,Math.floor((Math.min(f.edge[0].z,f.edge[1].z)-w.origin.z)/w.cellSizeZ)-1),z1=Math.min(w.rows-1,Math.floor((Math.max(f.edge[0].z,f.edge[1].z)-w.origin.z)/w.cellSizeZ)+1);
      for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){const key=x*w.rows+z,list=this.flightBins.get(key);if(list)list.push(f);else this.flightBins.set(key,[f]);}
    }
  }
  private foamLaunch(from:PhysicsVector,to:PhysicsVector):{flight:WaterBodyFlight;t:number;y:number}|undefined {
    const state=this.state;if(!state||!this.flightBins.size)return;
    const w=this.water,candidates=this.launchCandidates;candidates.clear();
    const x0=Math.max(0,Math.floor((Math.min(from.x,to.x)-w.origin.x)/w.cellSizeX)),x1=Math.min(w.columns-1,Math.floor((Math.max(from.x,to.x)-w.origin.x)/w.cellSizeX));
    const z0=Math.max(0,Math.floor((Math.min(from.z,to.z)-w.origin.z)/w.cellSizeZ)),z1=Math.min(w.rows-1,Math.floor((Math.max(from.z,to.z)-w.origin.z)/w.cellSizeZ));
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++)for(const f of this.flightBins.get(x*w.rows+z)??[])candidates.add(f);
    const rx=to.x-from.x,rz=to.z-from.z;
    let result:{flight:WaterBodyFlight;t:number;y:number}|undefined;
    for(const flight of candidates){
      const age=state.time-flight.time;
      if(flight.destination||flight.emittedTime!==undefined||age< -1e-7||age>flight.duration*.5+1e-7||rx*flight.velocity.x+rz*flight.velocity.z<=0)continue;
      const [a,b]=flight.edge,sx=b.x-a.x,sz=b.z-a.z,den=rx*sz-rz*sx;if(Math.abs(den)<1e-12)continue;
      const qx=a.x-from.x,qz=a.z-from.z,t=(qx*sz-qz*sx)/den,u=(qx*rz-qz*rx)/den;
      if(t<0||t>1||u<0||u>1||result&&t>=result.t)continue;
      const y=a.y+(b.y-a.y)*u;
      if(Math.abs(from.y-.006-y)>Math.max(.03,flight.sourceDepth*.1))continue;
      result={flight,t,y};
    }
    return result;
  }
  private advanceFoamFlight(i:number,dt:number):boolean {
    const f=this.foam,p=i*3,from=this.sweepFrom,to=this.sweepTo;
    from.x=f.position[p];from.y=f.position[p+1];from.z=f.position[p+2];
    to.x=from.x+f.velocity[p]*dt;to.y=from.y+f.velocity[p+1]*dt+G*dt*dt*.5;to.z=from.z+f.velocity[p+2]*dt;
    if(hitsSolid(this.solids,from,to))return false;
    f.velocity[p+1]+=G*dt;
    const s=this.surface(to.x,to.z);
    if(s?.wet&&f.velocity[p+1]<0&&from.y>=s.top+.006&&to.y<=s.top+.006){
      to.y=(this.topIndex?.height(to.x,to.z,s.top)??s.top)+.006;f.airborne[i]=0;
    }
    f.position.set([to.x,to.y,to.z],p);return true;
  }
  private step(dt:number):void {
    const a=this.air;
    for(let i=0;i<a.count;){
      a.age[i]+=dt;const k=a.kind[i],p=i*3;
      const from=this.sweepFrom;from.x=a.position[p];from.y=a.position[p+1];from.z=a.position[p+2];
      if(k===BUBBLE){
        const s=this.surface(a.position[p],a.position[p+2]);
        a.position[p]+=((s?.u??0)+a.velocity[p])*dt;a.position[p+1]+=a.velocity[p+1]*dt;a.position[p+2]+=((s?.v??0)+a.velocity[p+2])*dt;
        const to=this.sweepTo;to.x=a.position[p];to.y=a.position[p+1];to.z=a.position[p+2];
        if(hitsSolid(this.solids,from,to)){this.removeAir(i);continue;}
        if(!s||!s.wet||a.position[p+1]>=s.top-.01){if(s?.wet&&this.random()<.35)this.emitFoam({x:a.position[p],y:s.top,z:a.position[p+2]},2+2*this.random(),.05+.04*this.random());this.removeAir(i);continue;}
      }else{
        if(k===MIST){const relax=1-Math.exp(-1.2*dt);a.velocity[p]+=(this.wind.x-a.velocity[p])*relax;a.velocity[p+2]+=(this.wind.z-a.velocity[p+2])*relax;a.velocity[p+1]+=(.05-a.velocity[p+1])*relax;}
        else{a.velocity[p+1]+=G*dt;const drag=Math.exp(-.35*dt);a.velocity[p]*=drag;a.velocity[p+2]*=drag;}
        a.position[p]+=a.velocity[p]*dt;a.position[p+1]+=a.velocity[p+1]*dt;a.position[p+2]+=a.velocity[p+2]*dt;
        const to=this.sweepTo;to.x=a.position[p];to.y=a.position[p+1];to.z=a.position[p+2];
        if(hitsSolid(this.solids,from,to)){this.removeAir(i);continue;}
        const s=this.surface(a.position[p],a.position[p+2]);
        if(k===SPRAY&&s&&a.velocity[p+1]<0&&a.position[p+1]<=s.top){if(s.wet&&this.random()<.2)this.emitFoam({x:a.position[p],y:s.top,z:a.position[p+2]},2+2*this.random(),.04+.03*this.random());this.removeAir(i);continue;}
      }
      if(a.age[i]>=a.life[i]){this.removeAir(i);continue;}
      i++;
    }
    const f=this.foam;
    for(let i=0;i<f.count;){
      f.age[i]+=dt;const p=i*3;
      if(f.age[i]>=f.life[i]){this.removeFoam(i);continue;}
      if(f.airborne[i]){if(!this.advanceFoamFlight(i,dt)){this.removeFoam(i);continue;}i++;continue;}
      const s=this.surface(f.position[p],f.position[p+2]);
      if(!s||!s.wet){this.removeFoam(i);continue;}
      const from=this.sweepFrom,to=this.sweepTo;from.x=f.position[p];from.y=f.position[p+1];from.z=f.position[p+2];
      to.x=from.x+s.u*dt;to.y=from.y;to.z=from.z+s.v*dt;
      const launch=this.foamLaunch(from,to);
      if(launch){
        f.position.set([from.x+(to.x-from.x)*launch.t,launch.y+.006,from.z+(to.z-from.z)*launch.t],p);
        f.velocity.set([launch.flight.velocity.x,launch.flight.velocity.y,launch.flight.velocity.z],p);f.airborne[i]=1;
        if(!this.advanceFoamFlight(i,dt*(1-launch.t))){this.removeFoam(i);continue;}i++;continue;
      }
      f.position[p]+=s.u*dt;f.position[p+2]+=s.v*dt;
      f.position[p+1]=(this.topIndex?.height(f.position[p],f.position[p+2],s.top)??s.top)+.006;i++;
    }
  }
  private upload():void {
    const a=this.air,ga=this.points.geometry,gb=this.bubbles.geometry;
    const write=(g:BufferGeometry,want:(k:number)=>boolean)=>{
      const pos=g.getAttribute('position') as BufferAttribute,size=g.getAttribute('size') as BufferAttribute,alpha=g.getAttribute('alpha') as BufferAttribute,tint=g.getAttribute('tint') as BufferAttribute;
      let n=0;
      for(let i=0;i<a.count;i++){const k=a.kind[i];if(!want(k))continue;const t=a.age[i]/a.life[i];
        pos.setXYZ(n,a.position[i*3],a.position[i*3+1],a.position[i*3+2]);size.setX(n,a.size[i]);
        alpha.setX(n,k===MIST?.22*Math.sin(Math.PI*Math.min(1,t)):k===BUBBLE?.55*(1-t*.5):.9*(1-t*t));
        const c=k===MIST?this.colors.mist:k===BUBBLE?this.colors.foam:this.colors.water;tint.setXYZ(n,c.r,c.g,c.b);n++;}
      for(const attribute of [pos,size,alpha,tint])attribute.needsUpdate=true;g.setDrawRange(0,n);
    };
    write(ga,k=>k!==BUBBLE);write(gb,k=>k===BUBBLE);
    this.uploadFoam();
  }
  private uploadFoam():void {
    const f=this.foam;
    for(let i=0;i<f.count;i++){const t=f.age[i]/f.life[i],grow=Math.min(1,f.age[i]*3),fade=Math.sqrt(Math.max(0,1-t));
      this.dummy.position.set(f.position[i*3],f.position[i*3+1],f.position[i*3+2]);this.dummy.scale.setScalar(Math.max(.001,f.size[i]*(.5+.5*grow)*(.35+.65*fade)));this.dummy.updateMatrix();this.foamMesh.setMatrixAt(i,this.dummy.matrix);}
    this.foamMesh.count=f.count;this.foamMesh.instanceMatrix.needsUpdate=true;
  }
  private emitAir(kind:number,p:{x:number;y:number;z:number},v:{x:number;y:number;z:number},life:number,size:number):void {
    const a=this.air,limit=budgets[this.quality].air;if(a.count>=limit)return;const i=a.count++;
    a.position.set([p.x,p.y,p.z],i*3);a.velocity.set([v.x,v.y,v.z],i*3);a.age[i]=0;a.life[i]=life;a.size[i]=size;a.kind[i]=kind;
  }
  private emitFoam(p:{x:number;y:number;z:number},life:number,size:number):void {
    const f=this.foam,limit=budgets[this.quality].foam;if(f.count>=limit)return;const i=f.count++;
    f.position.set([p.x,p.y+.006,p.z],i*3);f.velocity.fill(0,i*3,i*3+3);f.airborne[i]=0;f.age[i]=0;f.life[i]=life;f.size[i]=size;
  }
  private removeAir(i:number):void {const a=this.air,j=--a.count;if(i===j)return;a.position.copyWithin(i*3,j*3,j*3+3);a.velocity.copyWithin(i*3,j*3,j*3+3);a.age[i]=a.age[j];a.life[i]=a.life[j];a.size[i]=a.size[j];a.kind[i]=a.kind[j];}
  private removeFoam(i:number):void {const f=this.foam,j=--f.count;if(i===j)return;f.position.copyWithin(i*3,j*3,j*3+3);f.velocity.copyWithin(i*3,j*3,j*3+3);f.airborne[i]=f.airborne[j];f.age[i]=f.age[j];f.life[i]=f.life[j];f.size[i]=f.size[j];}
  /** Fractional expected counts become stable integers over many frames. */
  private count(expected:number):number {const whole=Math.floor(expected);return whole+(this.random()<expected-whole?1:0);}
  private jitter(p:{x:number;y:number;z:number},radius:number,up:number){const angle=this.random()*Math.PI*2,r=Math.sqrt(this.random())*radius;return{x:p.x+Math.cos(angle)*r,y:p.y+up*this.random(),z:p.z+Math.sin(angle)*r};}
  private random():number {this.seed^=this.seed<<13;this.seed^=this.seed>>>17;this.seed^=this.seed<<5;return(this.seed>>>0)/4294967296;}
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    this.topIndex=undefined;
    this.points.geometry.dispose();this.bubbles.geometry.dispose();this.foamMesh.geometry.dispose();this.foamMesh.dispose();
    this.airMaterial.dispose();this.bubbleMaterial.dispose();this.foamMaterial.dispose();this.disc.dispose();this.root.clear();this.root.removeFromParent();
  }
}
