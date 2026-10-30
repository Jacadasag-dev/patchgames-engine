/** Camera-relative planetary ocean presentation using the engine's water wave
 * and weather profiles. This is not a spherical WaterWorld fluid solver. */
import {BufferGeometry,Color,DoubleSide,DynamicDrawUsage,Float32BufferAttribute,Group,Mesh,MeshPhysicalMaterial,SphereGeometry,type Texture} from 'three';
import type {CompiledPlanet,PlanetVector} from '../shared/planet.ts';
import {compileWater,prepareWaterWaves,samplePreparedWaterWaveSurface,waterAppearance,type PreparedWaterWaves,type WaterAppearance,type WaterConditions,type WaterLocation,type WaterManifest,type WaterRecipe,type WaterWavePhase} from './water.ts';

type Vec=[number,number,number];
const clamp=(n:number,a=0,b=1)=>Math.max(a,Math.min(b,n));
const dot=(a:PlanetVector,b:PlanetVector)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:PlanetVector,b:PlanetVector):Vec=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function direction(value:PlanetVector):Vec {
  if(!Array.isArray(value)||value.length!==3||!value.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e9))throw Error('Planet water requires three finite coordinates within ±1000000000m.');
  const length=Math.hypot(...value);if(length<1e-20)throw Error('Planet water direction must be nonzero.');
  return[value[0]/length,value[1]/length,value[2]/length];
}
function bounded(value:number|undefined,fallback:number,min:number,max:number,name:string,integer=false):number {
  const n=value??fallback;if(!Number.isFinite(n)||n<min||n>max||integer&&!Number.isInteger(n))throw Error(`Planet water ${name} must be ${integer?'an integer':'finite'} in ${min}..${max}.`);return n;
}
export type PlanetWaterRecipe=Omit<WaterRecipe,'kind'|'level'|'size'|'center'|'path'|'width'|'depth'>;
const defaultWater=new WeakMap<CompiledPlanet,WaterManifest>();
/** Water's level is local zero; the planet supplies the absolute sea level. */
export function compilePlanetWater(planet:CompiledPlanet,recipe?:Partial<PlanetWaterRecipe>):WaterManifest {
  if(!recipe){const cached=defaultWater.get(planet);if(cached)return cached;}
  const water=compileWater({...recipe,id:recipe?.id??'planet-ocean',seed:recipe?.seed??(planet.recipe.seed>>>0),kind:'ocean',level:0,depth:10000,size:{width:100000,depth:100000}});
  if(!recipe)defaultWater.set(planet,water);return water;
}
export interface PlanetWaterSampleOptions {
  water?:WaterManifest;conditions?:WaterConditions;
  /** A view's accepted weather/phase snapshot can also drive gameplay queries. */
  appearance?:WaterAppearance;phases?:WaterWavePhase;
  /** Cached source height; omit for an authoritative planet.sample query. */
  groundHeightMeters?:number;
}
export interface PlanetWaterSample {
  wet:boolean;depthMeters:number;heightMeters:number;position:PlanetVector;normal:PlanetVector;
  foam:number;roughness:number;color:readonly [number,number,number];
}
interface Wave {height:number;normal:Vec;foam:number}
/** Blend three global planar engine wave charts, weighted by radial normal.
 * There is no cube-face, longitude, pole, or floating-origin phase reset. The
 * weight derivatives are included in the radial surface normal. */
function wave(planet:CompiledPlanet,n:PlanetVector,prepared:PreparedWaterWaves,depth:number):Wave {
  if(depth<=0)return{height:0,normal:[n[0],n[1],n[2]],foam:0};
  const radius=planet.radius+planet.recipe.seaLevelMeters;
  const location:WaterLocation={inside:depth>0,level:0,depth:Math.max(0,depth),edgeDistance:Math.max(0,depth),flow:{x:prepared.components[0].directionX,z:prepared.components[0].directionZ}};
  let height=0,gx=0,gy=0,gz=0,foam=0;
  for(let axis=0;axis<3;axis++){
    const weight=n[axis]*n[axis];if(weight===0)continue;
    const point=axis===0?{x:radius*n[2],z:radius*n[1]}:axis===1?{x:radius*n[0],z:radius*n[2]}:{x:radius*n[0],z:radius*n[1]};
    const sample=samplePreparedWaterWaveSurface(prepared,point,location),sx=sample.slopeX,sz=sample.slopeZ;
    height+=weight*sample.height;foam+=weight*sample.foam;
    if(axis===0){gz+=weight*sx;gy+=weight*sz;gx+=2*n[0]*sample.height/radius;}
    else if(axis===1){gx+=weight*sx;gz+=weight*sz;gy+=2*n[1]*sample.height/radius;}
    else{gx+=weight*sx;gy+=weight*sz;gz+=2*n[2]*sample.height/radius;}
  }
  const radial=gx*n[0]+gy*n[1]+gz*n[2],scale=radius/(radius+height);
  const nx=n[0]-(gx-radial*n[0])*scale,ny=n[1]-(gy-radial*n[1])*scale,nz=n[2]-(gz-radial*n[2])*scale,length=Math.hypot(nx,ny,nz);
  return{height,normal:[nx/length,ny/length,nz/length],foam};
}
/** Deterministic spherical water query. It shares the displayed wave source;
 * far visual LOD deliberately flattens unresolved waves. No collision body is
 * created, and ocean pressure/currents are not simulated over the globe. */
export function samplePlanetWater(planet:CompiledPlanet,input:PlanetVector,timeSeconds:number,options:PlanetWaterSampleOptions={}):PlanetWaterSample {
  const n=direction(input),water=options.water??compilePlanetWater(planet),appearance=options.appearance??waterAppearance(water,options.conditions);
  const ground=options.groundHeightMeters??planet.sample(n).heightMeters;
  if(!Number.isFinite(ground))throw Error('Planet water ground height must be finite.');
  const depth=Math.max(0,planet.recipe.seaLevelMeters-ground),sample=wave(planet,n,prepareWaterWaves(water,timeSeconds,appearance,options.phases),depth);
  const heightMeters=planet.recipe.seaLevelMeters+sample.height,radius=planet.radius+heightMeters;
  return{wet:depth>0,depthMeters:depth,heightMeters,position:[n[0]*radius,n[1]*radius,n[2]*radius],normal:sample.normal,foam:sample.foam,roughness:appearance.roughness,color:[...appearance.color]};
}

export interface PlanetWaterViewOptions {
  /** Azimuth segments; topology is allocated once. */
  segments?:number;nearRings?:number;farRings?:number;
  /** Dense near rings resolve metre-scale waves. Outside them waves fade to
   * the far sea-level proxy; a fluid simulation is never allocated. */
  detailRadiusMeters?:number;prepareVerticesPerFrame?:number;prepareTimeBudgetMs?:number;updateHz?:number;
  water?:WaterManifest;conditions?:WaterConditions;
  /** Borrowed native environment map; ownership remains with the caller. */
  envMap?:Texture;
}
export interface PlanetWaterFrame {position:PlanetVector;origin?:PlanetVector;timeSeconds:number;conditions?:WaterConditions;sunDirection?:PlanetVector}
interface Bank {
  geometry:BufferGeometry;mesh:Mesh;directions:Float64Array;depths:Float64Array;
  anchor:Vec;origin:Vec;east:Vec;north:Vec;cursor:number;ready:boolean;
}

/** One closed spherical sheet, with dense near rings and logarithmic distant
 * rings. Near and far geometry share vertices, rather than overlapping water
 * layers. Two fixed banks amortize recentering and source-height preparation. */
export class PlanetWaterView {
  readonly root=new Group();readonly planet:CompiledPlanet;readonly water:WaterManifest;
  private readonly material:MeshPhysicalMaterial;private readonly proxy:Mesh;
  private readonly banks:Bank[];private readonly radii:number[];private readonly sides:number;
  private readonly nearCount:number;private readonly vertexCount:number;private readonly detailRadius:number;
  private readonly preparationBudget:number;private readonly preparationTimeBudget:number;private readonly interval:number;
  private readonly seaRadius:number;private readonly foamColor=new Color('#e6f6ed');
  private appearance:WaterAppearance;private phases:WaterWavePhase={temporal:[0,0,0],currentX:[0,0,0],currentZ:[0,0,0]};
  private conditions:WaterConditions;private active=-1;private pending=-1;private disposed=false;
  private lastTime:number|undefined;private time=0;private updates=0;private preparedThisFrame=0;private swaps=0;
  private origin:Vec=[0,0,0];private updateCpuMs=0;private preparationCpuMs=0;private refresh=false;private nearVisible=true;
  constructor(planet:CompiledPlanet,options:PlanetWaterViewOptions={}) {
    this.planet=planet;this.water=options.water??compilePlanetWater(planet);if(this.water.kind!=='ocean')throw Error('Planet water requires an ocean manifest.');
    this.seaRadius=planet.radius+planet.recipe.seaLevelMeters;if(!(this.seaRadius>0))throw Error('Planet water sea radius must be positive.');
    this.sides=bounded(options.segments,80,32,256,'segments',true);
    const nearRings=bounded(options.nearRings,16,8,64,'near rings',true),farRings=bounded(options.farRings,64,16,96,'far rings',true);
    this.detailRadius=bounded(options.detailRadiusMeters,Math.min(24,this.seaRadius*.02),8,Math.min(512,this.seaRadius*.02),'detail radius');
    this.preparationBudget=bounded(options.prepareVerticesPerFrame,512,32,4096,'preparation budget',true);
    this.preparationTimeBudget=bounded(options.prepareTimeBudgetMs,1.5,.1,16,'preparation time budget');
    this.interval=1/bounded(options.updateHz,30,1,60,'update Hz');this.conditions={...options.conditions};this.appearance=waterAppearance(this.water,this.conditions);
    this.radii=[];for(let i=1;i<=nearRings;i++)this.radii.push(this.detailRadius*i/nearRings);
    for(const ratio of [1.5,2,3,4])this.radii.push(this.detailRadius*ratio);
    const start=this.radii.at(-1)!/this.seaRadius;
    for(let i=1;i<farRings;i++)this.radii.push(this.seaRadius*start*(Math.PI/start)**(i/farRings));
    this.nearCount=1+(nearRings+4)*this.sides;this.vertexCount=2+this.radii.length*this.sides;
    this.material=new MeshPhysicalMaterial({color:0xffffff,vertexColors:true,roughness:this.appearance.roughness,metalness:0,ior:1.333,
      specularIntensity:1,clearcoat:.6,clearcoatRoughness:this.appearance.roughness*.7,side:DoubleSide,envMap:options.envMap??null});
    this.material.name='PlanetWater:engine-physical-water';this.root.name='PlanetWater';
    this.proxy=new Mesh(new SphereGeometry(1,96,48),this.material);this.proxy.name='PlanetWater:initial-far-proxy';this.proxy.scale.setScalar(this.seaRadius);this.proxy.frustumCulled=false;
    // Orbit uses a coarse sea-level proxy. The same physical material also
    // works while the first near sheet is preparing after descent.
    const proxyColors=new Float32Array(this.proxy.geometry.getAttribute('position').count*3);
    for(let i=0;i<proxyColors.length;i+=3)proxyColors.set(this.appearance.color,i);
    this.proxy.geometry.setAttribute('color',new Float32BufferAttribute(proxyColors,3));this.root.add(this.proxy);
    this.banks=[this.bank(),this.bank()];
  }
  private bank():Bank {
    const geometry=new BufferGeometry(),count=this.vertexCount;
    for(const name of ['position','normal','color'])geometry.setAttribute(name,new Float32BufferAttribute(new Float32Array(count*3),3).setUsage(DynamicDrawUsage));
    const uv=new Float32Array(count*2),indices:number[]=[];
    for(let ring=0;ring<this.radii.length;ring++)for(let side=0;side<this.sides;side++){
      const a=1+ring*this.sides+side,b=1+ring*this.sides+(side+1)%this.sides;
      uv[a*2]=side/this.sides;uv[a*2+1]=this.radii[ring]/(Math.PI*this.seaRadius);
      if(ring===0)indices.push(0,a,b);
      else{const c=a-this.sides,d=b-this.sides;indices.push(c,a,b,c,b,d);}
      if(ring===this.radii.length-1)indices.push(a,count-1,b);
    }
    geometry.setAttribute('uv',new Float32BufferAttribute(uv,2));geometry.setIndex(indices);
    const mesh=new Mesh(geometry,this.material);mesh.name='PlanetWater:radial-wave-sheet';mesh.visible=false;mesh.frustumCulled=false;this.root.add(mesh);
    return{geometry,mesh,directions:new Float64Array(count*3),depths:new Float64Array(count),anchor:[0,1,0],origin:[0,this.seaRadius,0],east:[1,0,0],north:[0,0,1],cursor:0,ready:false};
  }
  private prepare(anchor:Vec):void {
    const index=this.active===0?1:0,bank=this.banks[index];this.pending=index;
    bank.anchor=anchor;bank.origin=[anchor[0]*this.seaRadius,anchor[1]*this.seaRadius,anchor[2]*this.seaRadius];
    bank.east=direction(cross(Math.abs(anchor[1])<.95?[0,1,0]:[0,0,1],anchor));bank.north=cross(anchor,bank.east);
    bank.cursor=0;bank.ready=false;bank.mesh.visible=false;
  }
  private prepareSlice():void {
    if(this.pending<0)return;const started=performance.now(),bank=this.banks[this.pending],end=Math.min(this.vertexCount,bank.cursor+this.preparationBudget);
    const positions=bank.geometry.getAttribute('position'),normals=bank.geometry.getAttribute('normal'),colors=bank.geometry.getAttribute('color');
    const initial=bank.cursor;
    for(;bank.cursor<end;bank.cursor++){
      if(bank.cursor>initial&&performance.now()-started>=this.preparationTimeBudget)break;
      const i=bank.cursor,ring=Math.floor((i-1)/this.sides),side=(i-1)%this.sides;
      const angle=i===0?0:i===this.vertexCount-1?Math.PI:this.radii[ring]/this.seaRadius,azimuth=side/this.sides*2*Math.PI;
      const c=Math.cos(angle),s=Math.sin(angle),x=Math.cos(azimuth)*s,z=Math.sin(azimuth)*s;
      const n:Vec=[bank.anchor[0]*c+bank.east[0]*x+bank.north[0]*z,bank.anchor[1]*c+bank.east[1]*x+bank.north[1]*z,bank.anchor[2]*c+bank.east[2]*x+bank.north[2]*z];
      bank.directions.set(n,i*3);bank.depths[i]=i<this.nearCount?Math.max(0,this.planet.recipe.seaLevelMeters-this.planet.sample(n).heightMeters):10000;
      positions.setXYZ(i,n[0]*this.seaRadius-bank.origin[0],n[1]*this.seaRadius-bank.origin[1],n[2]*this.seaRadius-bank.origin[2]);
      normals.setXYZ(i,...n);colors.setXYZ(i,...this.appearance.color);this.preparedThisFrame++;
    }
    if(bank.cursor===this.vertexCount){
      bank.ready=true;if(this.active>=0)this.banks[this.active].mesh.visible=false;
      this.active=this.pending;this.pending=-1;bank.mesh.visible=true;this.proxy.visible=false;this.swaps++;
      for(const name of ['position','normal','color'])bank.geometry.getAttribute(name).needsUpdate=true;
      this.refresh=true;
    }
    this.preparationCpuMs=performance.now()-started;
  }
  private advance(time:number,conditions:WaterConditions):void {
    const dt=this.lastTime===undefined?Infinity:Math.max(0,time-this.lastTime);if(!this.refresh&&dt<this.interval&&time>=this.lastTime!)return;this.refresh=false;
    const target=waterAppearance(this.water,conditions),alpha=1-Math.exp(-dt/.6);
    for(const key of ['amplitude','wavelength','speed','roughness','foam','shoreFoam','windSpeed','currentSpeed'] as const)this.appearance[key]+=(target[key]-this.appearance[key])*alpha;
    this.appearance.windDirection+=Math.atan2(Math.sin(target.windDirection-this.appearance.windDirection),Math.cos(target.windDirection-this.appearance.windDirection))*alpha;
    let colorChanged=false;
    for(let i=0;i<3;i++){const change=(target.color[i]-this.appearance.color[i])*alpha;this.appearance.color[i]+=change;colorChanged ||= Math.abs(change)>1e-8;}
    // Match WaterView's accepted temporal/current phase clock, including rewind.
    if(this.lastTime===undefined||time<this.lastTime)this.phases={temporal:[0,0,0],currentX:[0,0,0],currentZ:[0,0,0]};
    const phaseDt=this.lastTime===undefined||time<this.lastTime?time:dt;
    for(let i=0;i<3;i++){
      const k=2*Math.PI/(this.appearance.wavelength/(1+i*.8)),angle=this.appearance.windDirection+i*1.13;
      this.phases.temporal[i]-=phaseDt*k*this.appearance.speed/(1+i*.3);
      this.phases.currentX[i]+=phaseDt*k*this.appearance.currentSpeed*Math.cos(angle);this.phases.currentZ[i]+=phaseDt*k*this.appearance.currentSpeed*Math.sin(angle);
    }
    this.lastTime=time;this.material.roughness=this.appearance.roughness;this.material.clearcoatRoughness=this.appearance.roughness*.7;
    if(colorChanged){
      const proxyColors=this.proxy.geometry.getAttribute('color') as Float32BufferAttribute;
      for(let i=0;i<proxyColors.count;i++)proxyColors.setXYZ(i,...this.appearance.color);proxyColors.needsUpdate=true;
      for(const bank of this.banks)if(bank.ready){const colors=bank.geometry.getAttribute('color') as Float32BufferAttribute;
        for(let i=this.nearCount;i<this.vertexCount;i++)colors.setXYZ(i,...this.appearance.color);colors.clearUpdateRanges();colors.addUpdateRange(this.nearCount*3,(this.vertexCount-this.nearCount)*3);colors.needsUpdate=true;}
    }
    if(this.active<0||!this.nearVisible)return;const bank=this.banks[this.active],positions=bank.geometry.getAttribute('position'),normals=bank.geometry.getAttribute('normal'),colors=bank.geometry.getAttribute('color');
    const prepared=prepareWaterWaves(this.water,time,this.appearance,this.phases);
    for(let i=0;i<this.nearCount;i++){
      const n:Vec=[bank.directions[i*3],bank.directions[i*3+1],bank.directions[i*3+2]],sample=wave(this.planet,n,prepared,bank.depths[i]);
      const ring=i===0?0:Math.floor((i-1)/this.sides),distance=i===0?0:this.radii[ring],blend=1-clamp((distance-this.detailRadius)/(this.detailRadius*3));
      const radius=this.seaRadius+sample.height*blend;
      positions.setXYZ(i,n[0]*radius-bank.origin[0],n[1]*radius-bank.origin[1],n[2]*radius-bank.origin[2]);
      const nx=n[0]+(sample.normal[0]-n[0])*blend,ny=n[1]+(sample.normal[1]-n[1])*blend,nz=n[2]+(sample.normal[2]-n[2])*blend,length=Math.hypot(nx,ny,nz);normals.setXYZ(i,nx/length,ny/length,nz/length);
      const foam=sample.foam*blend,depthTint=.65+.35*Math.min(1,bank.depths[i]/3);
      colors.setXYZ(i,this.appearance.color[0]*depthTint*(1-foam)+this.foamColor.r*foam,this.appearance.color[1]*depthTint*(1-foam)+this.foamColor.g*foam,this.appearance.color[2]*depthTint*(1-foam)+this.foamColor.b*foam);
    }
    for(const attribute of [positions,normals,colors] as Float32BufferAttribute[]){attribute.clearUpdateRanges();attribute.addUpdateRange(0,(attribute===colors&&colorChanged?this.vertexCount:this.nearCount)*3);attribute.needsUpdate=true;}
    this.updates++;
  }
  update(frame:PlanetWaterFrame):void {
    if(this.disposed)return;const started=performance.now(),anchor=direction(frame.position),origin=frame.origin??frame.position;
    if(!Array.isArray(origin)||origin.length!==3||!origin.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e9))throw Error('Planet water origin requires finite bounded coordinates.');
    bounded(frame.timeSeconds,0,-1e9,1e9,'time');if(frame.sunDirection)direction(frame.sunDirection);
    this.time=frame.timeSeconds;this.origin=[origin[0],origin[1],origin[2]];if(frame.conditions)this.conditions={...frame.conditions};
    const wasNear=this.nearVisible;this.nearVisible=Math.hypot(...frame.position)-this.seaRadius<Math.max(1000,this.appearance.amplitude*200);if(wasNear!==this.nearVisible)this.refresh=true;
    this.preparedThisFrame=0;this.preparationCpuMs=0;
    const active=this.active<0?undefined:this.banks[this.active];
    if(this.nearVisible&&this.pending<0&&(!active||Math.acos(clamp(dot(anchor,active.anchor),-1,1))*this.seaRadius>this.detailRadius*.4))this.prepare(anchor);
    this.prepareSlice();this.advance(frame.timeSeconds,this.conditions);
    this.proxy.position.set(-origin[0],-origin[1],-origin[2]);this.proxy.visible=!this.nearVisible||this.active<0;
    for(const bank of this.banks)bank.mesh.visible=this.nearVisible&&bank===this.banks[this.active];
    for(const bank of this.banks)bank.mesh.position.set(bank.origin[0]-origin[0],bank.origin[1]-origin[1],bank.origin[2]-origin[2]);
    this.updateCpuMs=performance.now()-started;
  }
  sample(input:PlanetVector,timeSeconds=this.lastTime??this.time):PlanetWaterSample {
    if(this.lastTime===undefined)return samplePlanetWater(this.planet,input,timeSeconds,{water:this.water,appearance:this.appearance});
    const dt=timeSeconds-this.lastTime,phases:WaterWavePhase={temporal:this.phases.temporal.slice(),currentX:this.phases.currentX.slice(),currentZ:this.phases.currentZ.slice()};
    for(let i=0;i<3;i++){
      const k=2*Math.PI/(this.appearance.wavelength/(1+i*.8)),angle=this.appearance.windDirection+i*1.13;
      phases.temporal[i]-=dt*k*this.appearance.speed/(1+i*.3);phases.currentX[i]+=dt*k*this.appearance.currentSpeed*Math.cos(angle);phases.currentZ[i]+=dt*k*this.appearance.currentSpeed*Math.sin(angle);
    }
    return samplePlanetWater(this.planet,input,timeSeconds,{water:this.water,appearance:this.appearance,phases});
  }
  inspection() {
    const active=this.active<0?undefined:this.banks[this.active];
    return{kind:'planet-ocean' as const,seaLevelMeters:this.planet.recipe.seaLevelMeters,seaRadiusMeters:this.seaRadius,detailReady:!!active,detailVisible:this.nearVisible&&!!active,
      nearVertices:this.nearCount,verticesPerBank:this.vertexCount,banks:this.banks.length,triangles:(this.banks[0].geometry.index?.count??0)/3,
      preparing:this.pending>=0,preparedThisFrame:this.preparedThisFrame,preparationBudget:this.preparationBudget,preparationTimeBudgetMs:this.preparationTimeBudget,swaps:this.swaps,updates:this.updates,
      updateCpuMs:this.updateCpuMs,preparationCpuMs:this.preparationCpuMs,origin:[...this.origin],disposed:this.disposed,
      physicsBodies:0,fluidCells:0,waveSource:'engine-water' as const,farRepresentation:'sea-level physical proxy' as const};
  }
  dispose():void {
    if(this.disposed)return;this.disposed=true;for(const bank of this.banks)bank.geometry.dispose();this.proxy.geometry.dispose();this.material.dispose();this.root.clear();this.root.removeFromParent();
  }
}
