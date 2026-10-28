import type {PhysicsCompoundBody,PhysicsScene,PhysicsVector} from './physics.ts';
import type {LiquidContact,WaterDomain,WaterSource} from './waterDomain.ts';
import {waterBodyGeometry,stepWaterBodyGrid,type WaterBodyGeometry} from './waterBodyGrid.ts';
import {waterBodySolidDepth} from './waterBodySolids.ts';
import {waterBodySolidPressure} from './waterBodyPressure.ts';
import {solveWaterBodyHulls,type WaterBodyHull} from './waterBodyHulls.ts';
import {applyWaterBodyLanding} from './waterBodyPuddles.ts';
import {applyWaterWind,resolveWaterWind} from './waterWind.ts';
import type {WaterWind} from './waterSystem.ts';
import type {WaterBoundaryMesh} from './waterBoundaryGeometry.ts';
import {compileWaterBodyBoundaryMesh} from './waterBodyBoundaryMesh.ts';
import type {WaterPlacementSupports} from './waterBoundaryGeometry.ts';
import {createBoundaryState,cloneBoundaryState,validateBoundaryState,sampleBoundaryWater,pourBoundaryWater,prepareBoundaryScene,type WaterBoundaryState} from './waterBoundary.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {cloneWaterBodyFlights,waterBodyFlightsVolume,validateWaterBodyFlights,advanceWaterBodyFlights,appendWaterBodyFlight,waterFlightPoint,prepareWaterFlightSolidCollision,waterFlightDomainCollision,createWaterFlightSolidResponse,type WaterBodyFlight,type WaterFlightArrival} from './waterBodyFlights.ts';
import {waterBodyFlightCapacity} from './waterBodyWire.ts';
import {physicsBodyMassProperties} from './physicsMassProperties.ts';
import {applyLiquidImpulses} from './liquidCoupling.ts';
import {resolveWaterBodyDepthCurrentConfig,cloneWaterBodyDepthCurrents,validateWaterBodyDepthCurrents,addWaterBodyDepthImpulse,addWaterBodyDepthImpulses,stepWaterBodyDepthCurrents,sampleWaterBodyDepthCurrent,type WaterBodyDepthCurrentConfig,type WaterBodyDepthCurrentState} from './waterBodyDepthCurrents.ts';

export const WATER_BODY_VERSION='water-body-v1';
/** Engine-generated impermeable interfaces between independent water sheets.
 * X indices use x*rows+z; Z indices use x*(rows+1)+z. No physical collider or load. */
export interface WaterBodyClosedFaces {x:number[];z:number[]}
export interface WaterBodyRecipe {
  liquid:WaterDomain;scene:PhysicsScene;cellSize?:number;maxCells?:number;maxGridSubsteps?:number;
  closedFaces?:WaterBodyClosedFaces;
  /** Static placement support topology supplied by the shared world compiler. */
  placementSupports?:WaterPlacementSupports;
  /** Default true. Refine grounded placement footprints only; terrain retains the original grid.
   * False selects the original rectangular mode. All flow, body, source, pipe and current features remain enabled. */
  boundaryCells?:boolean;
  friction?:number;dryDepth?:number;wetDepth?:number;sleepSpeed?:number;sleepAfter?:number;sleepSurfaceTolerance?:number;
  /** Effective horizontal eddy viscosity in m²/s. Default .05, range 0..2.
   * Local velocity shear adds bounded mixing; resting water stays at rest. */
  currentMixing?:number;
  /** Default true. False disables optional shear mixing and horizontal body
   * reaction currents; gravity transport, waves, buoyancy and body drag remain. */
  currents?:boolean;
  /** Lazy, bounded underwater circulation. False keeps depth-averaged flow only. */
  depthCurrents?:WaterBodyDepthCurrentConfig|false;
  /** Local shallow-water cohesion/wetting, 0..1; default .5. A bounded
   * game-scale capillary approximation, not attraction to a global centre. */
  puddleCohesion?:number;
  maxFlowSpeed?:number;
}
export interface WaterBodyManifest {
  version:typeof WATER_BODY_VERSION;revision:string;liquid:WaterDomain;columns:number;rows:number;
  origin:{x:number;z:number};cellSizeX:number;cellSizeZ:number;cellArea:number;bed:number[];bedVertices:number[];
  maxGridSubsteps:number;friction:number;dryDepth:number;wetDepth:number;sleepSpeed:number;sleepAfter:number;sleepSurfaceTolerance:number;
  currentMixing?:number;
  currents?:boolean;
  depthCurrents?:Required<WaterBodyDepthCurrentConfig>|false;
  puddleCohesion?:number;
  maxFlowSpeed:number;
  boundaryCells?:boolean;boundaryMesh?:WaterBoundaryMesh;
  closedFaces?:WaterBodyClosedFaces;
  placementSupports?:WaterPlacementSupports;
}
export interface WaterBodyState {
  waterRevision:string;revision:number;time:number;depth:number[];flowX:number[];flowZ:number[];sleeping:boolean[];quietTime:number[];
  /** Runtime terrain samples, initially equal to manifest samples. */
  bed:number[];bedVertices:number[];sceneRevision:string;barrierX:string[];barrierZ:string[];
  /** Submerged solid volume / cell area. depth remains liquid volume / area;
   * the physical free surface is bed + depth + solidDepth. Legacy states omit it. */
  solidDepth?:number[];
  /** Optional layered circulation; it contains velocity, never additional water. */
  depthCurrents?:WaterBodyDepthCurrentState;
  /** Columns whose vertical support each floating body received from the
   * latest stepWaterBody. applyWaterBodyBuoyancy reads it in the same tick
   * so that support is not counted twice; each step replaces it, and it is
   * omitted when no hull touches water. Not part of the network wire. */
  hulls?:WaterBodyHull[];
  initialVolume:number;externalAddedVolume:number;externalRemovedVolume:number;
  /** Independent fluid regions; rectangular depth/flow arrays are summaries. */
  boundary?:WaterBoundaryState;
  /** Conserved liquid travelling through air; it joins the surface on contact. */
  flights?:WaterBodyFlight[];
}
export interface WaterBodyStats {
  volume:number;wetCells:number;sleepingCells:number;gridSubsteps:number;gridFaces:number;
  airVolume?:number;
  /** Extra hydro steps restricted to tiny wet regions and adjacent faces. */
  gridLocalSubsteps?:number;
  /** Lid columns and conjugate-gradient iterations of the floating hull solve. */
  hullCells:number;hullIterations:number;
}
export interface WaterBodyStep {water:WaterBodyManifest;state:WaterBodyState;scene:PhysicsScene;bodies?:PhysicsCompoundBody[];dt:number;wind?:WaterWind|false;
  /** World-owned step: defer airborne landing to the shared multi-layer sweep. */
  flightDestination?:string;
}
export interface WaterBodyResult {state:WaterBodyState;contacts:LiquidContact[];stats:WaterBodyStats;flightArrivals?:WaterFlightArrival[]}
const cache=new WeakMap<WaterBodyManifest,{key:string;geometry:WaterBodyGeometry;scene:PhysicsScene}>();
// Retain moving/static provenance in checkpointed face identities. Renderer
// readers still consume the final |bottom|top fields. Escape a static ID with
// the reserved prefix so arbitrary authored names cannot look like motion.
const movingBarrierPrefix='@moving|';
const barrierSignature=(b:WaterBodyGeometry['x'][number])=>b?`${b.domain?'@domain|':b.dynamic?movingBarrierPrefix:b.id.startsWith(movingBarrierPrefix)||b.id.startsWith('@domain|')?'@fixed|':''}${b.id}|${b.bottom}|${b.top}`:'';
const number=(v:number,name:string,min=0,max=1e9)=>{if(!Number.isFinite(v)||v<min||v>max)throw new Error(`Invalid water body ${name}`);};
const hash=(s:string)=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0).toString(16);};
const gridVolume=(w:WaterBodyManifest,s:WaterBodyState)=>s.depth.reduce((a,b)=>a+b,0)*w.cellArea;
const geometryKey=(scene:PhysicsScene,bodies:PhysicsCompoundBody[])=>hash(JSON.stringify([scene,bodies]));
function geometry(w:WaterBodyManifest,scene:PhysicsScene,bodies:PhysicsCompoundBody[]){const key=geometryKey(scene,bodies),old=cache.get(w);if(old?.key===key)return{key,geometry:old.geometry};const value=waterBodyGeometry(w,scene,bodies);cache.set(w,{key,geometry:value,scene});return{key,geometry:value};}
// The copy never carries the previous step's hulls. Deleting a property
// instead would drop the state into slow dictionary mode for the grid loops.
function copy({hulls:_,...s}:WaterBodyState):WaterBodyState{return{...s,depth:s.depth.slice(),...(s.flights?{flights:cloneWaterBodyFlights(s.flights)}:{}),...(s.boundary?{boundary:cloneBoundaryState(s.boundary)}:{}),...(s.depthCurrents?{depthCurrents:cloneWaterBodyDepthCurrents(s.depthCurrents)}:{}),...(s.solidDepth?{solidDepth:s.solidDepth.slice()}:{}),flowX:s.flowX.slice(),flowZ:s.flowZ.slice(),sleeping:s.sleeping.slice(),quietTime:s.quietTime.slice(),bed:s.bed.slice(),bedVertices:s.bedVertices.slice(),barrierX:s.barrierX.slice(),barrierZ:s.barrierZ.slice()};}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}

/** One terrain-supported layer per XZ cell; -Y gravity only. Water crosses
 * cliffs and ledges as conservative grid flow. Impacts, splashes and dam
 * breaks become surface waves and underwater currents, never 3D particles. */
export function compileWaterBody(recipe:WaterBodyRecipe):WaterBodyManifest{
  if(recipe.boundaryCells!==undefined&&typeof recipe.boundaryCells!=='boolean')throw new Error('Invalid water boundaryCells');
  if(recipe.currents!==undefined&&typeof recipe.currents!=='boolean')throw new Error('Invalid water body currents');
  if(recipe.puddleCohesion!==undefined)number(recipe.puddleCohesion,'puddle cohesion',0,1);
  const legacy=recipe as {ledgeDrops?:unknown;maxActivationsPerStep?:unknown;particleResidence?:unknown;particleSettleSpeed?:unknown};
  if(legacy.ledgeDrops!==undefined&&legacy.ledgeDrops!==false)throw new Error('Water body ledge drops were removed: water crosses ledges as grid flow; omit ledgeDrops');
  for(const key of ['maxActivationsPerStep','particleResidence','particleSettleSpeed'] as const)
    if(legacy[key]!==undefined)throw new Error(`Water body 3D particles were removed: splashes are waves and currents in the body; omit ${key}`);
  const liquid=recipe.liquid;
  if(!liquid||typeof liquid.revision!=='string'||!liquid.revision.startsWith('water-domain-'))throw new Error('Water body needs a compiled water domain (compileWaterDomain)');
  if(Math.abs(liquid.gravity.x)>1e-9||Math.abs(liquid.gravity.z)>1e-9||liquid.gravity.y>=0)throw new Error('Water body requires downward Y gravity');
  const cell=recipe.cellSize??.25,maxCells=recipe.maxCells??4096;number(cell,'cell size',.05,4);number(maxCells,'cell budget',1,16384);
  const columns=Math.ceil((liquid.bounds.max.x-liquid.bounds.min.x)/cell),rows=Math.ceil((liquid.bounds.max.z-liquid.bounds.min.z)/cell);
  if(columns*rows>maxCells||!Number.isInteger(maxCells))throw new Error('Water body grid budget exceeded');
  const cellSizeX=(liquid.bounds.max.x-liquid.bounds.min.x)/columns,cellSizeZ=(liquid.bounds.max.z-liquid.bounds.min.z)/rows;
  const result:WaterBodyManifest={version:WATER_BODY_VERSION,revision:'',liquid,columns,rows,origin:{x:liquid.bounds.min.x,z:liquid.bounds.min.z},cellSizeX,cellSizeZ,cellArea:cellSizeX*cellSizeZ,bed:[],bedVertices:[],
    maxGridSubsteps:recipe.maxGridSubsteps??32,friction:recipe.friction??.25,currentMixing:recipe.currentMixing??.05,currents:recipe.currents??true,depthCurrents:resolveWaterBodyDepthCurrentConfig(recipe.depthCurrents),puddleCohesion:recipe.puddleCohesion??.5,dryDepth:recipe.dryDepth??1e-6,wetDepth:recipe.wetDepth??.001,
    sleepSpeed:recipe.sleepSpeed??.02,sleepAfter:recipe.sleepAfter??1,sleepSurfaceTolerance:recipe.sleepSurfaceTolerance??.0001,
    maxFlowSpeed:recipe.maxFlowSpeed??30};
  if(typeof result.currents!=='boolean')throw new Error('Invalid water body currents');
  number(result.currentMixing!,'current mixing',0,2);
  for(const [key,min,max] of [['maxGridSubsteps',1,128],['friction',0,20],['dryDepth',1e-10,.01],['wetDepth',1e-6,.1],['sleepSpeed',0,.2],['sleepAfter',.1,60],['sleepSurfaceTolerance',1e-8,.01],['maxFlowSpeed',.1,100]] as const)number(result[key],key,min,max);
  if(!Number.isInteger(result.maxGridSubsteps)||result.wetDepth<result.dryDepth)throw new Error('Invalid water body budgets');
  if(recipe.closedFaces!==undefined){
    const masks=recipe.closedFaces;
    if(!masks||typeof masks!=='object'||Object.keys(masks).some(key=>key!=='x'&&key!=='z'))throw new Error('Invalid water closed faces');
    const indices=(value:unknown,length:number)=>{
      if(!Array.isArray(value)||value.length>length||value.some(i=>!Number.isSafeInteger(i)||i<0||i>=length)||new Set(value).size!==value.length)throw new Error('Invalid water closed face index');
      return [...value].sort((a,b)=>a-b) as number[];
    };
    result.closedFaces={x:indices(masks.x,(columns+1)*rows),z:indices(masks.z,columns*(rows+1))};
  }
  if(recipe.placementSupports!==undefined){
    if(recipe.boundaryCells===false)throw new Error('Placement supports require precise placement boundaries');
    result.placementSupports=JSON.parse(JSON.stringify(recipe.placementSupports));
  }
  const compiled=waterBodyGeometry(result,recipe.scene);result.bed=compiled.bed;result.bedVertices=compiled.bedVertices;
  if(recipe.boundaryCells!==false){result.boundaryCells=true;result.boundaryMesh=compileWaterBodyBoundaryMesh(result,recipe.scene,compiled.bed);}
  result.revision=hash(JSON.stringify(result));cache.set(result,{key:geometryKey(recipe.scene,[]),geometry:compiled,scene:recipe.scene});return freeze(result);
}
export function createWaterBodyState(w:WaterBodyManifest):WaterBodyState{
  if(arguments.length>1)throw new Error('Water body no longer starts from 3D particle state; add initial water to depth');
  const n=w.columns*w.rows;
  return{waterRevision:w.revision,revision:0,time:0,depth:Array(n).fill(0),flowX:Array(n).fill(0),flowZ:Array(n).fill(0),sleeping:Array(n).fill(false),quietTime:Array(n).fill(0),bed:w.bed.slice(),bedVertices:w.bedVertices.slice(),
    sceneRevision:'',barrierX:Array((w.columns+1)*w.rows).fill(''),barrierZ:Array(w.columns*(w.rows+1)).fill(''),initialVolume:0,externalAddedVolume:0,externalRemovedVolume:0,...(w.boundaryCells?{boundary:createBoundaryState(w.boundaryMesh!)}:{})};
}
export function validateWaterBodyState(w:WaterBodyManifest,s:WaterBodyState):void{
  if(!s||s.waterRevision!==w.revision)throw new Error('Water body state revision mismatch');
  if('active' in s||'toParticlesVolume' in s)throw new Error('Water body state holds 3D particle water, which was removed');
  number(s.time,'time');number(s.revision,'revision',0,Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(s.revision))throw new Error('Invalid water body revision');
  const n=w.columns*w.rows;
  for(const key of ['depth','flowX','flowZ','quietTime','sleeping','bed'] as const)if(!Array.isArray(s[key])||s[key].length!==n)throw new Error('Water body cell state size mismatch');
  if(s.solidDepth!==undefined&&(!Array.isArray(s.solidDepth)||s.solidDepth.length!==n))throw new Error('Water body solid column size mismatch');
  for(const value of s.solidDepth??[])number(value,'solid depth',0,10000);
  for(let i=0;i<n;i++){number(s.depth[i],'depth',0,10000);number(s.flowX[i],'flow',-1000,1000);number(s.flowZ[i],'flow',-1000,1000);number(s.quietTime[i],'quiet time');number(s.bed[i],'bed',-10000,10000);if(typeof s.sleeping[i]!=='boolean')throw new Error('Invalid water body sleeping flag');}
  if(!Array.isArray(s.bedVertices)||s.bedVertices.length!==(w.columns+1)*(w.rows+1)||s.bedVertices.some(v=>!Number.isFinite(v)))throw new Error('Invalid water body terrain vertices');
  if(!Array.isArray(s.barrierX)||s.barrierX.length!==(w.columns+1)*w.rows||!Array.isArray(s.barrierZ)||s.barrierZ.length!==w.columns*(w.rows+1)||s.barrierX.some(v=>typeof v!=='string'||v.length>2048)||s.barrierZ.some(v=>typeof v!=='string'||v.length>2048)||typeof s.sceneRevision!=='string')throw new Error('Invalid water body barriers');
  for(const key of ['initialVolume','externalAddedVolume','externalRemovedVolume'] as const)number(s[key],key);
  validateWaterBodyDepthCurrents(w,s);
  validateBoundaryState(w,s);
  if(s.hulls!==undefined){
    if(!Array.isArray(s.hulls)||!s.hulls.length||s.hulls.length>64)throw new Error('Invalid water body hulls');
    let cells=0;for(const hull of s.hulls){if(!hull||typeof hull.bodyId!=='string'||!hull.bodyId||hull.bodyId.length>1024||!Array.isArray(hull.cells)||(cells+=hull.cells.length)>4096
      ||hull.cells.some(i=>!Number.isSafeInteger(i)||i<0||i>=(s.boundary?.mesh.regions.length??n)))throw new Error('Invalid water body hulls');}
  }
  validateWaterBodyFlights(s.flights,s.time);
  const expected=s.initialVolume+s.externalAddedVolume-s.externalRemovedVolume,actual=gridVolume(w,s)+waterBodyFlightsVolume(s.flights);
  if(Math.abs(expected-actual)>Math.max(1e-8,expected*1e-9))throw new Error('Water body volume ledger is inconsistent');
}
function cellAt(w:WaterBodyManifest,p:Pick<PhysicsVector,'x'|'z'>):number{
  const x=Math.floor((p.x-w.origin.x)/w.cellSizeX),z=Math.floor((p.z-w.origin.z)/w.cellSizeZ);return x<0||z<0||x>=w.columns||z>=w.rows?-1:x*w.rows+z;
}
function center(w:WaterBodyManifest,s:WaterBodyState,i:number):PhysicsVector{return{x:w.origin.x+(Math.floor(i/w.rows)+.5)*w.cellSizeX,y:s.bed[i]+s.depth[i]+(s.solidDepth?.[i]??0),z:w.origin.z+(i%w.rows+.5)*w.cellSizeZ};}
function wake(w:WaterBodyManifest,s:WaterBodyState,i:number,rings=1){const x=Math.floor(i/w.rows),z=i%w.rows;for(let xx=Math.max(0,x-rings);xx<=Math.min(w.columns-1,x+rings);xx++)for(let zz=Math.max(0,z-rings);zz<=Math.min(w.rows-1,z+rings);zz++){const j=xx*w.rows+zz;s.sleeping[j]=false;s.quietTime[j]=0;}}

/** Stir real water: horizontal momentum enters the depth-averaged flow and
 * vertical momentum drives underwater circulation. Supply current bodies so
 * the circulation respects moving solids. */
export function disturbWaterBody(w:WaterBodyManifest,previous:WaterBodyState,options:{point:PhysicsVector;radius:number;impulse:PhysicsVector;activate?:false;bodies?:PhysicsCompoundBody[]},scene?:PhysicsScene):WaterBodyState{
  validateWaterBodyState(w,previous);number(options.radius,'disturbance radius',.01,256);for(const v of [options.point,options.impulse])for(const k of ['x','y','z'] as const)number(v[k],'disturbance vector',-1e9,1e9);
  if((options as {activate?:unknown}).activate!==undefined&&(options as {activate?:unknown}).activate!==false)throw new Error('Water body 3D particles were removed; a disturbance cannot activate splash packets');
  if(w.boundaryCells){
    const s=copy(previous);if(scene)prepareBoundaryScene(w,s,scene);
    const cached=cache.get(w),geo=scene||options.bodies!==undefined?geometry(w,scene??cached?.scene??{colliders:[]},options.bodies??[]).geometry:cached?.geometry;
    const c=waterBodyCells(w,s),faces=c.faces(geo),indices:number[]=[];
    if(s.boundary!.mesh.regions.every(r=>r.bulk)&&!faces.some(f=>f.barrier)){
      for(let i=0;i<c.count;i++){const p=c.center(i);if(Math.hypot(p.x-options.point.x,p.z-options.point.z)<=options.radius&&c.depth(i)>w.dryDepth)indices.push(i);}
    }else{
      const at=sampleBoundaryWater(w,s,options.point);if(!at||at.depth<=w.dryDepth)return s;
      indices.push(at.region);const seen=new Set(indices),adjacent=Array.from({length:c.count},()=>[] as number[]);
      for(let k=0;k<faces.length;k++){const f=faces[k];adjacent[f.a].push(k);if(f.b>=0)adjacent[f.b].push(k);}
      for(let k=0;k<indices.length;k++)for(const edge of adjacent[indices[k]]){const f=faces[edge],j=f.a===indices[k]?f.b:f.a;if(j<0||seen.has(j)||c.depth(j)<=w.dryDepth)continue;const p=c.center(j);
        if(Math.hypot(p.x-options.point.x,p.z-options.point.z)>options.radius||Math.min(c.level(f.a),c.level(f.b))<=Math.min(f.start.bed,f.end.bed)+w.dryDepth)continue;
        seen.add(j);indices.push(j);}
    }
    const mass=indices.reduce((sum,i)=>sum+c.volume(i)*w.liquid.restDensity,0);
    if(!mass)return s;
    if(mass>0)for(const i of indices){c.flowX[i]=Math.max(-w.maxFlowSpeed,Math.min(w.maxFlowSpeed,c.flowX[i]+options.impulse.x/mass));c.flowZ[i]=Math.max(-w.maxFlowSpeed,Math.min(w.maxFlowSpeed,c.flowZ[i]+options.impulse.z/mass));c.wake(i);}
    c.commit();
    addWaterBodyDepthImpulse(w,s,options,geo);
    s.revision++;validateWaterBodyState(w,s);return s;
  }
  const s=copy(previous),indices:number[]=[];let volume=0;
  for(let i=0;i<s.depth.length;i++){const p=center(w,s,i);if(Math.hypot(p.x-options.point.x,p.z-options.point.z)<=options.radius&&s.depth[i]>w.dryDepth){indices.push(i);volume+=s.depth[i]*w.cellArea;}}
  const cached=cache.get(w),geo=scene||options.bodies!==undefined?geometry(w,scene??cached?.scene??{colliders:[]},options.bodies??[]).geometry:cached?.geometry;
  if(!volume)return s;const mass=volume*w.liquid.restDensity,dv={x:options.impulse.x/mass,z:options.impulse.z/mass};
  for(const i of indices){s.flowX[i]=Math.max(-w.maxFlowSpeed,Math.min(w.maxFlowSpeed,s.flowX[i]+dv.x));s.flowZ[i]=Math.max(-w.maxFlowSpeed,Math.min(w.maxFlowSpeed,s.flowZ[i]+dv.z));wake(w,s,i);}
  addWaterBodyDepthImpulse(w,s,{point:options.point,radius:options.radius,impulse:options.impulse},geo);
  s.revision++;validateWaterBodyState(w,s);return s;
}
/** Add an explicitly accounted external inflow to terrain cells. */
export function pourWaterBody(w:WaterBodyManifest,previous:WaterBodyState,options:{point:PhysicsVector;radius:number;volume:number;velocity?:PhysicsVector}):WaterBodyState{
  validateWaterBodyState(w,previous);number(options.radius,'inflow radius',.01,256);number(options.volume,'inflow volume',0,1e6);
  const v=options.velocity??{x:0,y:0,z:0};for(const p of [options.point,v])for(const k of ['x','y','z'] as const)number(p[k],'inflow vector',-10000,10000);
  if(w.boundaryCells){const s=copy(previous);pourBoundaryWater(w,s,options.point,options.radius,options.volume,v);const at=sampleBoundaryWater(w,s,options.point);
    if(v.y&&options.volume&&at)addWaterBodyDepthImpulse(w,s,{point:{...options.point,y:Math.max(at.bed+1e-5,Math.min(at.surface-1e-5,options.point.y))},radius:options.radius,impulse:{x:0,y:options.volume*w.liquid.restDensity*v.y,z:0},energy:.5*w.liquid.restDensity*options.volume*v.y*v.y},cache.get(w)?.geometry);s.revision++;validateWaterBodyState(w,s);return s;}
  const s=copy(previous),indices:number[]=[];for(let i=0;i<s.depth.length;i++){const p=center(w,s,i);if(Math.hypot(p.x-options.point.x,p.z-options.point.z)<=options.radius)indices.push(i);}
  if(!indices.length)throw new Error('Water body inflow is outside the grid');const share=options.volume/indices.length;
  for(const i of indices){const old=s.depth[i]*w.cellArea,total=old+share;if(total){s.flowX[i]=(old*s.flowX[i]+share*v.x)/total;s.flowZ[i]=(old*s.flowZ[i]+share*v.z)/total;}s.depth[i]+=share/w.cellArea;wake(w,s,i);}
  if(v.y&&options.volume){const i=cellAt(w,options.point);if(i>=0){
    const surface=s.bed[i]+s.depth[i]+(s.solidDepth?.[i]??0);
    addWaterBodyDepthImpulse(w,s,{point:{...options.point,y:Math.max(s.bed[i]+1e-5,Math.min(surface-1e-5,options.point.y))},radius:options.radius,
      impulse:{x:0,y:w.liquid.restDensity*options.volume*v.y,z:0},energy:.5*w.liquid.restDensity*options.volume*v.y*v.y},cache.get(w)?.geometry);
  }}
  s.externalAddedVolume+=options.volume;s.revision++;validateWaterBodyState(w,s);return s;
}
/** Omit y for surface flow, or supply world y for submerged current velocity. */
export function sampleWaterBody(w:WaterBodyManifest,s:WaterBodyState,p:Pick<PhysicsVector,'x'|'z'>&{y?:number}){
  if(w.boundaryCells){const at=sampleBoundaryWater(w,s,p);if(!at)return;const y=p.y??at.surface-1e-6,wet=at.depth>w.dryDepth&&y>=at.bed&&y<=at.surface,residual=wet?sampleWaterBodyDepthCurrent(w,s,{x:p.x,z:p.z,y}):{x:0,y:0,z:0};return{...at,velocity:{x:at.velocity.x+residual.x,y:residual.y,z:at.velocity.z+residual.z},sleeping:at.sleeping&&(s.depthCurrents?.sleeping??true)};}
  const i=cellAt(w,p);if(i<0)return;
  const depth=s.depth[i],bed=s.bed[i],surface=bed+depth+(s.solidDepth?.[i]??0),y=p.y??surface-1e-6;
  if(!Number.isFinite(y))throw new Error('Invalid water sample height');
  const wet=depth>w.dryDepth&&y>=bed&&y<=surface;
  const residual=wet?sampleWaterBodyDepthCurrent(w,s,{x:p.x,y,z:p.z}):{x:0,y:0,z:0};
  return{depth,surface,bed,velocity:wet?{x:s.flowX[i]+residual.x,y:residual.y,z:s.flowZ[i]+residual.z}:{x:0,y:0,z:0},sleeping:s.sleeping[i]&&(s.depthCurrents?.sleeping??true)};
}
/** Where a steady jet from a source outlet meets the water or bed: ballistic
 * flight under gravity, re-solved against the surface it reaches. */
function sourceLanding(w:WaterBodyManifest,s:WaterBodyState,source:WaterSource){
  const cells=waterBodyCells(w,s);
  const g=-w.liquid.gravity.y,v=source.velocity??{x:0,y:0,z:0};
  const start={x:(source.min.x+source.max.x)/2,y:source.min.y,z:(source.min.z+source.max.z)/2};let point={x:start.x,z:start.z},t=0;
  for(let iteration=0;iteration<4;iteration++){
    const i=cells.locate(point);if(i===undefined)return;
    const drop=start.y-cells.level(i);if(drop<=0){t=0;break;}
    t=(v.y+Math.sqrt(v.y*v.y+2*g*drop))/g;point={x:start.x+v.x*t,z:start.z+v.z*t};
  }
  const i=cells.locate(point);if(i===undefined)return;
  return{i,point,velocity:{x:v.x,y:v.y-g*t,z:v.z},radius:Math.max((source.max.x-source.min.x)/2,(source.max.z-source.min.z)/2,Math.min(w.cellSizeX,w.cellSizeZ)/2)};
}

export function stepWaterBody({water:w,state:previous,scene,bodies=[],dt,wind,flightDestination}:WaterBodyStep):WaterBodyResult{
  validateWaterBodyState(w,previous);number(dt,'step time',1e-5,.05);
  if(flightDestination!==undefined&&flightDestination!==w.revision)throw new Error('Water flight destination revision mismatch');
  const forcing=resolveWaterWind(wind),prepared=geometry(w,scene,bodies),geo=prepared.geometry;
  // Reuse current collision geometry: buried/blocked water receives no air stress.
  let s=copy(previous);if(w.boundaryCells)prepareBoundaryScene(w,s,scene);
  s=applyWaterWind(w,s,forcing,dt,geo.blocked);const contacts=new Map<string,LiquidContact>();
  if(prepared.key!==s.sceneRevision){
    if(!w.boundaryCells&&geo.bed.some((h,i)=>Math.abs(h-s.bed[i])>1e-9)&&gridVolume(w,s)>1e-10)throw new Error('Water body terrain elevation changed with stored water; remap or recompile the basin first');
    s.bed=geo.bed.slice();s.bedVertices=geo.bedVertices.slice();
    // A breached or moved face wakes the water beside it; the grid flux then
    // releases the dam break as a real surge.
    const bx=geo.x.map(barrierSignature),bz=geo.z.map(barrierSignature);
    for(let x=0;x<=w.columns;x++)for(let z=0;z<w.rows;z++)if(bx[x*w.rows+z]!==s.barrierX[x*w.rows+z]){if(x)wake(w,s,(x-1)*w.rows+z);if(x<w.columns)wake(w,s,x*w.rows+z);}
    for(let x=0;x<w.columns;x++)for(let z=0;z<=w.rows;z++)if(bz[x*(w.rows+1)+z]!==s.barrierZ[x*(w.rows+1)+z]){if(z)wake(w,s,x*w.rows+z-1);if(z<w.rows)wake(w,s,x*w.rows+z);}
    s.barrierX=bx;s.barrierZ=bz;s.sceneRevision=prepared.key;
  }
  // Moving solids change hydraulic head rather than deleting liquid or adding
  // a canned ring. The same conservative pressure solve then propagates and
  // reflects the resulting waves, including vertical entry and floating hulls.
  const occupied=waterBodySolidDepth(w,s,geo.obstacles);
  for(let i=0;i<occupied.length;i++)if(Math.abs(occupied[i]-(s.solidDepth?.[i]??0))>1e-8)wake(w,s,i);
  s.solidDepth=occupied;
  // Ordinary buoyancy bobbing settles through solidDepth changes; only a fast
  // body keeps its whole footprint awake.
  const movingCells=waterBodyCells(w,s);
  for(const o of geo.obstacles){if(!o.bodyMotion||Math.hypot(o.bodyMotion.velocity.x,o.bodyMotion.velocity.y,o.bodyMotion.velocity.z)<.65)continue;
    for(const i of movingCells.indices(o))if(movingCells.depth(i)>w.wetDepth&&o.min.y<=movingCells.level(i)&&o.max.y>=movingCells.bed(i))wake(w,s,movingCells.parent(i),1);
  }
  waterBodySolidPressure(w,s,geo,bodies,dt,contacts);
  s.time+=dt;s.revision++;
  // Elevated sources first add conserved airborne water. Their vertical
  // momentum enters the pool only after the gravity trajectory makes contact.
  const depthImpulses:Parameters<typeof addWaterBodyDepthImpulse>[2][]=[];
  for(const source of w.liquid.sources){
    const start={x:(source.min.x+source.max.x)*.5,y:source.min.y,z:(source.min.z+source.max.z)*.5},sourceCells=waterBodyCells(w,s),sourceCell=sourceCells.locate(start);
    if(source.rate>0&&sourceCell!==undefined&&start.y>Math.max(sourceCells.level(sourceCell),geo.terrainHeight(start.x,start.z))+w.dryDepth){
      const id=`source-${w.liquid.sources.indexOf(source)}`,width=Math.max(source.max.x-source.min.x,source.max.z-source.min.z),alongX=source.max.x-source.min.x>=source.max.z-source.min.z;
      const edge:[PhysicsVector,PhysicsVector]=alongX?[{...start,x:start.x-width*.5},{...start,x:start.x+width*.5}]:[{...start,z:start.z-width*.5},{...start,z:start.z+width*.5}];
      const volume=appendWaterBodyFlight(s.flights??=[],{id,edge,velocity:source.velocity??{x:0,y:0,z:0},volume:source.rate*dt,time:s.time-dt*.5,duration:dt,sourceDepth:0},waterBodyFlightCapacity(w,s));
      s.externalAddedVolume+=volume;continue;
    }
    const volume=source.rate*dt,landing=volume>0?sourceLanding(w,s,source):undefined;if(!landing)continue;
    if(s.boundary){
      if(!pourBoundaryWater(w,s,landing.point,landing.radius,volume,landing.velocity,{blocked:geo.blocked,fallbackCell:s.boundary.mesh.regions[landing.i].cell,geometry:geo}))continue;
      const cells=waterBodyCells(w,s),point={...landing.point,y:cells.level(landing.i)};
      applyWaterBodyLanding(w,s,geo,landing.i,volume,-landing.velocity.y,{point,depthImpulses});
      continue;
    }
    const cells:number[]=[];
    for(let i=0;i<s.depth.length;i++){if(geo.blocked[i])continue;const p=center(w,s,i);if(Math.hypot(p.x-landing.point.x,p.z-landing.point.z)<=landing.radius)cells.push(i);}
    if(!cells.length&&!geo.blocked[landing.i])cells.push(landing.i);if(!cells.length)continue;
    const share=volume/cells.length;
    for(const i of cells){const old=s.depth[i]*w.cellArea,total=old+share;s.flowX[i]=(old*s.flowX[i]+share*landing.velocity.x)/total;s.flowZ[i]=(old*s.flowZ[i]+share*landing.velocity.z)/total;s.depth[i]+=share/w.cellArea;wake(w,s,i);}
    s.externalAddedVolume+=volume;
    applyWaterBodyLanding(w,s,geo,landing.i,volume,-landing.velocity.y,{point:{x:landing.point.x,y:center(w,s,landing.i).y,z:landing.point.z},depthImpulses});
  }
  if(depthImpulses.length){addWaterBodyDepthImpulses(w,s,depthImpulses,geo);depthImpulses.length=0;}
  // Accepted flux at an unsupported cliff enters the airborne inventory.
  const work=stepWaterBodyGrid(w,s,geo,dt,contacts);s.externalRemovedVolume+=work.outflow;
  if(flightDestination!==undefined)for(const flight of s.flights??[])if(flight.destination===undefined)flight.destination=flightDestination;
  let flightArrivals:WaterFlightArrival[]=[];
  if(s.flights?.some(f=>!f.destination)){
    const cells=waterBodyCells(w,s),g=-w.liquid.gravity.y,minX=w.origin.x,minZ=w.origin.z,maxX=minX+w.columns*w.cellSizeX,maxZ=minZ+w.rows*w.cellSizeZ,solidCollision=prepareWaterFlightSolidCollision(geo.obstacles);
    const result=advanceWaterBodyFlights({flights:s.flights.filter(f=>!f.destination),fromTime:previous.time,toTime:s.time,gravity:g,maxDistance:Math.min(w.cellSizeX,w.cellSizeZ)*.25,
      respond:createWaterFlightSolidResponse(contacts.size?applyLiquidImpulses(bodies,[...contacts.values()]):bodies,w.liquid.restDensity),
      collide(start,end,time,fromTime){const hit=solidCollision(start,end,time,fromTime),wall=w.liquid.boundary==='closed'?waterFlightDomainCollision(w.liquid.bounds,start,end):undefined;
        const distance=(p:PhysicsVector)=>Math.hypot(p.x-start.x,p.y-start.y,p.z-start.z);return wall&&(!hit||distance(wall.point)<distance(hit.point))?wall:hit;},
      surface(point,previous){
        // A coarse hydraulic face can launch below a steep native terrain plane.
        // Resolve that existing overlap at the sweep origin, never at a higher
        // surface ahead of the packet.
        const start={x:Math.max(minX+1e-9,Math.min(maxX-1e-9,previous.x)),z:Math.max(minZ+1e-9,Math.min(maxZ-1e-9,previous.z))},ground=geo.terrainHeight(start.x,start.z);
        if(ground>previous.y+1e-7){const region=cells.locate(start);if(region!==undefined)return{height:Math.max(ground,cells.volume(region)>0?cells.level(region):ground),destination:w.revision,region};}
        const p={x:Math.max(minX+1e-9,Math.min(maxX-1e-9,point.x)),z:Math.max(minZ+1e-9,Math.min(maxZ-1e-9,point.z))},i=cells.locate(p);if(i===undefined)return;
        const bed=Math.max(geo.terrainHeight(p.x,p.z),cells.bedAt(i,p.x,p.z));if(bed>previous.y+1e-7)return;
        return{height:Math.max(bed,cells.level(i)),destination:w.revision,region:i};}});
    s.flights=[...s.flights.filter(f=>!!f.destination),...result.flights.filter(f=>{const p=waterFlightPoint(f,s.time-f.time,g),outside=p.x<minX||p.x>maxX||p.z<minZ||p.z>maxZ;if(outside&&w.liquid.boundary!=='closed'){s.externalRemovedVolume+=f.volume;return false;}return true;})];
    const bodyCenters=new Map<string,PhysicsVector>();
    for(const impact of result.contacts){const mass=impact.flight.volume*w.liquid.restDensity,impulse={x:mass*(impact.velocityBefore.x-impact.velocityAfter.x),y:mass*(impact.velocityBefore.y-impact.velocityAfter.y),z:mass*(impact.velocityBefore.z-impact.velocityAfter.z)},speed=Math.hypot(impulse.x,impulse.y,impulse.z)/mass;
      const energy=Math.max(0,.5*mass*((impact.velocityBefore.x-impact.solidVelocity.x)**2+(impact.velocityBefore.y-impact.solidVelocity.y)**2+(impact.velocityBefore.z-impact.solidVelocity.z)**2-(impact.velocityAfter.x-impact.solidVelocity.x)**2-(impact.velocityAfter.y-impact.solidVelocity.y)**2-(impact.velocityAfter.z-impact.solidVelocity.z)**2)),key=`${impact.bodyId??''}/${impact.colliderId}`,old=contacts.get(key);
      let angularImpulse:PhysicsVector|undefined;
      if(impact.bodyId){let center=bodyCenters.get(impact.bodyId);if(!center){const body=bodies.find(b=>b.id===impact.bodyId);if(body){center=physicsBodyMassProperties(body).center;bodyCenters.set(body.id,center);}}
        if(center){const r={x:impact.point.x-center.x,y:impact.point.y-center.y,z:impact.point.z-center.z};angularImpulse={x:r.y*impulse.z-r.z*impulse.y,y:r.z*impulse.x-r.x*impulse.z,z:r.x*impulse.y-r.y*impulse.x};}}
      if(old){old.impulse.x+=impulse.x;old.impulse.y+=impulse.y;old.impulse.z+=impulse.z;old.speed=Math.max(old.speed,speed);old.kineticEnergy+=energy;if(angularImpulse){old.angularImpulse??={x:0,y:0,z:0};old.angularImpulse.x+=angularImpulse.x;old.angularImpulse.y+=angularImpulse.y;old.angularImpulse.z+=angularImpulse.z;}}
      else contacts.set(key,{colliderId:impact.colliderId,...(impact.bodyId?{bodyId:impact.bodyId}:{}),point:{...impact.point},impulse,...(angularImpulse?{angularImpulse}:{}),force:{x:0,y:0,z:0},kineticEnergy:energy,speed});
    }
    flightArrivals=result.arrivals;
    for(const arrival of flightArrivals){const i=arrival.surface.region,old=cells.volume(i),total=old+arrival.flight.volume;
      cells.flowX[i]=(old*cells.flowX[i]+arrival.flight.volume*arrival.velocity.x)/total;cells.flowZ[i]=(old*cells.flowZ[i]+arrival.flight.volume*arrival.velocity.z)/total;
      cells.setVolume(i,total);cells.wake(i);
    }cells.commit();
    for(const arrival of flightArrivals)applyWaterBodyLanding(w,s,geo,arrival.surface.region,arrival.flight.volume,Math.max(0,-arrival.velocity.y),{point:arrival.position,depthImpulses});
    if(depthImpulses.length)addWaterBodyDepthImpulses(w,s,depthImpulses,geo);
  }
  // Floating hulls and the water under them are corrected together.
  const hulls=solveWaterBodyHulls(w,s,geo,bodies,dt,contacts);
  if(hulls.hulls.length)s.hulls=hulls.hulls;
  const cells=waterBodyCells(w,s);
  for(let i=0;i<cells.count;i++)for(const drain of w.liquid.drains){const p=cells.center(i);if(p.x<drain.min.x||p.x>drain.max.x||p.z<drain.min.z||p.z>drain.max.z)continue;
    const top=cells.level(i),take=Math.min(cells.volume(i),Math.max(0,cells.capacityAtHead(i,Math.min(top,drain.max.y))-cells.capacityAtHead(i,Math.min(top,drain.min.y))));cells.setVolume(i,cells.volume(i)-take);s.externalRemovedVolume+=take;}
  cells.commit();
  stepWaterBodyDepthCurrents(w,s,dt,geo);
  for(const c of contacts.values())c.force={x:c.impulse.x/dt,y:c.impulse.y/dt,z:c.impulse.z/dt};
  validateWaterBodyState(w,s);
  return{state:s,contacts:[...contacts.values()],...(flightArrivals.length?{flightArrivals}:{}),stats:{volume:gridVolume(w,s)+waterBodyFlightsVolume(s.flights),airVolume:waterBodyFlightsVolume(s.flights),wetCells:s.depth.filter(d=>d>=w.wetDepth).length,sleepingCells:work.sleepingCells,gridSubsteps:work.substeps,...(work.localSubsteps===undefined?{}:{gridLocalSubsteps:work.localSubsteps}),gridFaces:work.faces,hullCells:hulls.unknowns,hullIterations:hulls.iterations}};
}
