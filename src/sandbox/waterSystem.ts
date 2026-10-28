/** Engine-owned water setup and coupling. Plain manifests/state are portable;
 * generation, warm-up and recording are separate from authoritative ticks.
 * Supported water uses the shallow-water body; unsupported discharge retains
 * volume and momentum in bounded ballistic transit until actual contact. */
import {compileWaterDomain,type WaterBounds,type LiquidContact} from './waterDomain.ts';
import {compileWaterBody,createWaterBodyState,stepWaterBody,validateWaterBodyState,type WaterBodyManifest,type WaterBodyState,type WaterBodyStats} from './waterBody.ts';
import {applyWaterBodyBuoyancy} from './waterBodyBuoyancy.ts';
import {applyLiquidImpulses} from './liquidCoupling.ts';
import {createWaterBodyPipesState,stepWaterBodyPipes,validateWaterBodyPipesState,waterBodyPipesVolume,type WaterBodyPipe,type WaterBodyPipesState} from './waterBodyPipes.ts';
import {sampleTerrainChannel,validateResolvedTerrainChannels,type ResolvedTerrainChannel} from './terrainChannels.ts';
import type {PhysicsScene,PhysicsCompoundBody} from './physics.ts';
import {callWaterSystemHost} from './waterSystemBridge.ts';
import {resolveWaterWind} from './waterWind.ts';
import {seedWaterSwell} from './waterSwell.ts';
import {addWaterBodyDepthImpulse,cloneWaterBodyDepthCurrents,resolveWaterBodyDepthCurrentConfig,type WaterBodyDepthCurrentConfig} from './waterBodyDepthCurrents.ts';
import {waterBodyGeometry} from './waterBodyGrid.ts';
import {waterBodyDetailEvents,waterFlightDetailEvents,mergeWaterDetailEvents,type WaterDetailEvent} from './waterDetail.ts';
import {appendWaterBodyFlight,cloneWaterBodyFlights,waterBodyFlightsVolume,type WaterBodyFlight} from './waterBodyFlights.ts';
import {waterBodyFlightCapacity} from './waterBodyWire.ts';
import {fillBoundaryWater,cloneBoundaryState,pourBoundaryWater,prepareBoundaryScene} from './waterBoundary.ts';
import {waterBodyCells} from './waterBodyCells.ts';

export interface WaterWind {
  /** Horizontal air velocity in m/s, magnitude <=60. Zero disables forcing. */velocity:{x:number;z:number};
  /** Resolved stress variation, 0..1; default .35, not a wave-height control. */gustiness?:number;
  /** Dimensionless bulk air/water drag, 0..0.01; default .0013. */dragCoefficient?:number;
}
export interface WaterSwell {
  center:{x:number;z:number};direction:{x:number;z:number};
  /** Requested crest-to-trough height in metres, limited by available depth. */height:number;
  /** Metres; at least eight cells so dispersion can resolve it. */wavelength:number;
  /** Finite packet footprint in metres. Defaults: domain diagonal and 3*wavelength. */width?:number;length?:number;
}

export type WaterQuality='economy'|'balanced'|'detailed';
export interface WaterSystemFill {min:{x:number;z:number};max:{x:number;z:number};level:number;velocity?:{x:number;z:number}}
export interface WaterSystemSource {id:string;point:{x:number;y?:number;z:number};radius:number;/** Cubic metres/second supplied from outside this domain. */rate:number;velocity?:{x:number;y?:number;z:number}}
export interface WaterSystemEmitter extends WaterSystemSource {cells:number[]}
export interface WaterSystemRecipe {
  id:string;scene:PhysicsScene;bounds:WaterBounds;quality?:WaterQuality;
  /** Engine-generated sheet interfaces; normally supplied by compileWaterWorld. */
  closedFaces?:import('./waterBody.ts').WaterBodyClosedFaces;
  /** Geometry-derived placement sheets; authors normally use compileWaterWorld. */
  placementSupports?:import('./waterBoundaryGeometry.ts').WaterPlacementSupports;
  /** Default true. Split grounded box placements only; terrain keeps the regular grid. False selects the original rectangular mode. */
  boundaryCells?:boolean;
  initial?:WaterSystemFill[];channels?:ResolvedTerrainChannel[];
  /** Start the authored reach wet and moving. Inflow maintains it from upstream. */
  river?:{depth?:number;speed?:number;inflow?:number};
  sources?:WaterSystemSource[];boundary?:'closed'|'open';pipes?:WaterBodyPipe[];
  /** External air stress; off by default. Drives real flow/waves, not render animation. */wind?:WaterWind|false;
  /** Optional physical dissipation in 1/seconds; default .25. */friction?:number;
  /** Local horizontal current mixing in m²/s; default .05. Conserves water and exchanges momentum locally. */currentMixing?:number;
  /** Bounded circulation through the depth, enabled lazily by default. False disables it independently of horizontal currents. */depthCurrents?:WaterBodyDepthCurrentConfig|false;
  /** Default true. False disables optional persistent body-reaction currents,
   * shear mixing and default current shading, while retaining gravity flow,
   * pressure waves, buoyancy and body drag. It never freezes or deletes water. */currents?:boolean;
  /** Shallow-water surface tension/wetting at game scale. Default .5, range
   * 0..1; 0 disables it. Local only, never a global centre-of-mass attraction. */puddleCohesion?:number;
}
export interface WaterSystemManifest {
  version:'water-system-v1';revision:string;id:string;quality:WaterQuality;
  water:WaterBodyManifest;scene:PhysicsScene;initial:WaterSystemFill[];channels:ResolvedTerrainChannel[];
  river:{depth:number;speed:number;inflow:number};sources:WaterSystemEmitter[];pipes:WaterBodyPipe[];
  wind?:Required<WaterWind>|false;
  diagnostics:{cellSize:number;cells:number;warnings:string[]};
}
export interface WaterSystemState {systemRevision:string;water:WaterBodyState;pipes:WaterBodyPipesState;steps:number}
export interface WaterSystemStep {system:WaterSystemManifest;state:WaterSystemState;dt:number;scene?:PhysicsScene;bodies?:PhysicsCompoundBody[];disabledSources?:string[];
  /** Omit to keep compiled wind; false/zero stops new wind energy. Existing waves decay. */wind?:WaterWind|false;
  /** Delegate airborne contacts to the containing World; must equal water.revision. */flightDestination?:string;
  /** Return cosmetic rapid, convergence and contact detail. Default off. Never changes the physical result. */detail?:boolean}
export interface WaterSystemStats extends WaterBodyStats {pipeVolume:number;totalVolume:number}
export interface WaterSystemResult {state:WaterSystemState;contacts:LiquidContact[];/** Flow and buoyancy applied once. Integrate these bodies with native physics. */bodies:PhysicsCompoundBody[];stats:WaterSystemStats;
  /** Cosmetic inputs for spray, foam, mist and bubbles. Present when detail is on. */detail?:WaterDetailEvent[]}
// Cell budgets are ceilings, not targets. Small deep pools must not acquire
// millimetre-scale cells and excessive CFL substeps just to use the budget.
const presets={economy:{cells:1024,minCell:.25},balanced:{cells:2304,minCell:.18},detailed:{cells:4096,minCell:.12}} as const;
const finite=(n:number,name:string,min:number,max:number)=>{if(!Number.isFinite(n)||n<min||n>max)throw new Error(`Invalid water system ${name}`);};
const hash=(text:string)=>{let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return(h>>>0).toString(16);};
function freeze<T>(v:T):T {if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
// QuickJS intentionally has no host structuredClone. Recipes contain plain
// data; retain non-finite numbers so validators reject rather than sanitize them.
function clone<T>(v:T):T {if(Array.isArray(v))return v.map(clone) as T;if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([key,value])=>[key,clone(value)])) as T;return v;}

/** Quality selects a bounded grid for the given domain, including wire budgets.
 * Split large worlds into reaches; never silently allocate an ocean-sized solve. */
export function compileWaterSystem(recipe:WaterSystemRecipe):WaterSystemManifest {
  const hosted=callWaterSystemHost<WaterSystemManifest>('compile',{recipe});if(hosted)return freeze(hosted);
  if(!recipe||typeof recipe.id!=='string'||!recipe.id.length||recipe.id.length>96)throw new Error('Water system requires an id up to 96 characters');
  // Removed options: say so rather than silently simulating something else.
  const legacy=recipe as {falls?:unknown;ledgeDrops?:unknown;streamCohesion?:unknown;wetting?:unknown};
  if(legacy.falls!==undefined&&legacy.falls!==false)throw new Error('Water system falls were removed: the body carries water over cliffs as grid flow; omit falls');
  if(legacy.ledgeDrops!==undefined&&legacy.ledgeDrops!==false)throw new Error('Water system ledge drops were removed: the body never releases airborne water; omit ledgeDrops');
  for(const key of ['streamCohesion','wetting'] as const)if(legacy[key]!==undefined)throw new Error(`Water system 3D particle liquid was removed: the body has no falling streams; omit ${key}`);
  const quality=recipe.quality??'economy',budget=presets[quality];if(!budget)throw new Error('Invalid water quality');
  const wind=resolveWaterWind(recipe.wind);
  const bounds=recipe.bounds;
  for(const side of ['min','max'] as const)for(const axis of ['x','y','z'] as const)finite(bounds?.[side]?.[axis],`bounds ${axis}`,-10000,10000);
  const width=bounds.max.x-bounds.min.x,depth=bounds.max.z-bounds.min.z;
  if(width<=0||depth<=0||bounds.max.y<=bounds.min.y)throw new Error('Water system bounds must have positive extent');
  let cell=Math.max(budget.minCell,Math.sqrt(width*depth/budget.cells));
  while(Math.ceil(width/cell)*Math.ceil(depth/cell)>budget.cells)cell*=1.01;
  if(cell>4)throw new Error('Water domain is too large for this quality; split it into smaller river reaches or basins');
  const initial=clone(recipe.initial??[]),channels=clone(recipe.channels??[]),sources=clone(recipe.sources??[]),pipes=clone(recipe.pipes??[]);
  if(initial.length>32||channels.length>32||sources.length>32)throw new Error('Water system region/source budget exceeded');
  for(const fill of initial){
    finite(fill.level,'fill level',bounds.min.y,bounds.max.y);
    for(const axis of ['x','z'] as const){finite(fill.min[axis],'fill bounds',bounds.min[axis],bounds.max[axis]);finite(fill.max[axis],'fill bounds',fill.min[axis],bounds.max[axis]);finite(fill.velocity?.[axis]??0,'fill velocity',-30,30);}
  }
  validateResolvedTerrainChannels(channels);
  for(const fill of initial)if(fill.min.x===fill.max.x||fill.min.z===fill.max.z)throw new Error('Water fill requires positive area');
  const river={depth:recipe.river?.depth??.4,speed:recipe.river?.speed??.7,inflow:recipe.river?.inflow??(channels.length?channels[0].points[0].width*Math.min(recipe.river?.depth??.4,channels[0].points[0].depth)*(recipe.river?.speed??.7):0)};
  finite(river.depth,'river depth',.001,100);finite(river.speed,'river speed',0,30);finite(river.inflow,'river inflow',0,10000);
  for(const channel of channels){
    if(!channel.points||channel.points.length<2)throw new Error('Water channel requires resolved terrain points');
    // The terrain compiler validates channel geometry. Sample all nodes here so
    // malformed external manifests cannot bypass its finite-coordinate checks.
    for(const p of channel.points){for(const key of ['x','z','bedY','width','depth'] as const)finite(p[key],`channel ${key}`,-10000,10000);if(p.width<=0||p.depth<=0)throw new Error('Invalid water channel dimensions');if(p.bedY+Math.min(river.depth,p.depth)>bounds.max.y)throw new Error('Water channel surface exceeds the simulation bounds');}
    if(river.inflow){const a=channel.points[0],b=channel.points[1],length=Math.hypot(b.x-a.x,b.z-a.z);
      sources.push({id:`river:${channel.id}`,point:{x:a.x,z:a.z},radius:Math.max(cell*.75,a.width*.4),rate:river.inflow,velocity:{x:(b.x-a.x)/length*river.speed,z:(b.z-a.z)/length*river.speed}});}
  }
  const ids=new Set<string>();
  for(const source of sources){if(typeof source.id!=='string'||!source.id.length||source.id.length>128||ids.has(source.id))throw new Error('Water sources require unique ids');ids.add(source.id);
    finite(source.radius,'source radius',.01,256);finite(source.rate,'source rate',0,10000);
    for(const axis of ['x','z'] as const){finite(source.point[axis],'source point',bounds.min[axis],bounds.max[axis]);finite(source.velocity?.[axis]??0,'source velocity',-30,30);}
    if(source.point.y!==undefined)finite(source.point.y,'source height',bounds.min.y,bounds.max.y);
    finite(source.velocity?.y??0,'source vertical velocity',-30,30);}
  if(sources.length>32)throw new Error('Water source budget exceeded');
  const liquid=compileWaterDomain({id:recipe.id,bounds,boundary:recipe.boundary??(channels.length?'open':'closed')});
  const resolvedDepthCurrents=resolveWaterBodyDepthCurrentConfig(recipe.depthCurrents);
  const depthCurrents=resolvedDepthCurrents===false?false:{...resolvedDepthCurrents,layers:recipe.depthCurrents&&recipe.depthCurrents.layers!==undefined?recipe.depthCurrents.layers:quality==='economy'?4:quality==='balanced'?6:8};
  const water=compileWaterBody({liquid,scene:recipe.scene,cellSize:cell,maxCells:budget.cells,friction:recipe.friction,currentMixing:recipe.currentMixing,currents:recipe.currents,depthCurrents,puddleCohesion:recipe.puddleCohesion,boundaryCells:recipe.boundaryCells,closedFaces:recipe.closedFaces,placementSupports:recipe.placementSupports});
  const emitters=sources.map(source=>{const cells:number[]=[],channel=channels.find(c=>source.id===`river:${c.id}`);
    for(let i=0;i<water.bed.length;i++){const x=water.origin.x+(Math.floor(i/water.rows)+.5)*water.cellSizeX,z=water.origin.z+(i%water.rows+.5)*water.cellSizeZ;
      if(Math.hypot(x-source.point.x,z-source.point.z)>source.radius)continue;
      if(channel){const at=sampleTerrainChannel(channel,x,z);if(at.weight<=0||water.bed[i]>=at.bedY+Math.min(river.depth,at.depth))continue;}
      cells.push(i);
    }
    if(!cells.length&&water.boundaryCells){const x=Math.min(water.columns-1,Math.floor((source.point.x-water.origin.x)/water.cellSizeX)),z=Math.min(water.rows-1,Math.floor((source.point.z-water.origin.z)/water.cellSizeZ));cells.push(x*water.rows+z);}
    if(!cells.length)throw new Error(`Water source ${source.id} has no resolved wet channel cells; increase width, radius or quality`);
    return{...source,cells};
  });
  createWaterBodyPipesState(water,pipes);
  const warnings:string[]=[];
  for(const channel of channels)if(channel.points.some(p=>p.width<cell*3))warnings.push(`Channel ${channel.id} is under three cells wide; use detailed quality or a smaller domain for its banks and ripples.`);
  // Inspect the same sampled terrain used by the solve. Authored bed grades
  // can be downhill yet sit above a bend's surrounding bank: then seeding a
  // perfectly valid river immediately floods the hillside. Diagnose that
  // condition rather than silently clamping its volume or hiding the runoff.
  const samples=channels.map(channel=>water.bed.map((_,i)=>sampleTerrainChannel(channel,
    water.origin.x+(Math.floor(i/water.rows)+.5)*water.cellSizeX,water.origin.z+(i%water.rows+.5)*water.cellSizeZ)));
  for(let c=0;c<channels.length;c++){
    let outlets=0;
    for(let i=0;i<water.bed.length;i++){
      const at=samples[c][i],head=at.bedY+Math.min(river.depth,at.depth);
      if(at.weight<=0||head<=water.bed[i]+.01)continue;
      const x=Math.floor(i/water.rows),z=i%water.rows;
      for(const [xx,zz] of [[x-1,z],[x+1,z],[x,z-1],[x,z+1]]){
        if(xx<0||zz<0||xx>=water.columns||zz>=water.rows)continue;
        const j=xx*water.rows+zz;if(samples.some(channel=>channel[j].weight>0))continue;
        const left=water.origin.x+xx*water.cellSizeX,near=water.origin.z+zz*water.cellSizeZ;
        if(initial.some(fill=>fill.min.x<left+water.cellSizeX&&fill.max.x>left&&fill.min.z<near+water.cellSizeZ&&fill.max.z>near&&fill.level>water.bed[j]))continue;
        const v=x!==xx?Math.max(x,xx)*(water.rows+1)+z:x*(water.rows+1)+Math.max(z,zz);
        const next=v+(x!==xx?1:water.rows+1);
        const crest=Math.max(water.bed[i],water.bed[j],Math.min(water.bedVertices[v],water.bedVertices[next]));
        if(head>crest+.03){outlets++;break;}
      }
    }
    if(outlets)warnings.push(`Channel ${channels[c].id} may overtop its banks at the initial water depth (${outlets} boundary cells); lower its bed/depth or raise surrounding banks. Initial lake fills are excluded.`);
  }
  const result:WaterSystemManifest={version:'water-system-v1',revision:'',id:recipe.id,quality,water,scene:clone(recipe.scene),initial,channels,river,sources:emitters,pipes,...(wind!==undefined?{wind}:{}),diagnostics:{cellSize:cell,cells:water.columns*water.rows,warnings}};
  result.revision=hash(JSON.stringify(result));return freeze(result);
}

/** Seed an already wet river or quiet pool directly in the grid.
 * Overlapping fills describe the union of water heads, never duplicate mass. */
export function createWaterSystemState(system:WaterSystemManifest):WaterSystemState {
  const hosted=callWaterSystemHost<WaterSystemState>('create',{revision:system.revision});if(hosted)return hosted;
  const w=system.water,s=createWaterBodyState(w);
  if(w.boundaryCells){
    fillBoundaryWater(w,s,system.initial);const cells=waterBodyCells(w,s);
    for(let i=0;i<cells.count;i++)for(const channel of system.channels){const p=cells.center(i),at=sampleTerrainChannel(channel,p.x,p.z);if(!at||at.weight<=0)continue;
      const volume=cells.capacityAtHead(i,at.bedY+Math.min(system.river.depth,at.depth));if(volume>cells.volume(i)){cells.setVolume(i,volume);cells.flowX[i]=at.tangent.x*system.river.speed;cells.flowZ[i]=at.tangent.z*system.river.speed;}}
    cells.commit();
  }
  else for(let i=0;i<s.depth.length;i++){
    const left=w.origin.x+Math.floor(i/w.rows)*w.cellSizeX,near=w.origin.z+(i%w.rows)*w.cellSizeZ,x=left+w.cellSizeX*.5,z=near+w.cellSizeZ*.5;
    let amount=0,vx=0,vz=0;
    const fills=system.initial.filter(f=>f.min.x<left+w.cellSizeX&&f.max.x>left&&f.min.z<near+w.cellSizeZ&&f.max.z>near);
    const xs=[...new Set([left,left+w.cellSizeX,...fills.flatMap(f=>[Math.max(left,f.min.x),Math.min(left+w.cellSizeX,f.max.x)])])].sort((a,b)=>a-b);
    const zs=[...new Set([near,near+w.cellSizeZ,...fills.flatMap(f=>[Math.max(near,f.min.z),Math.min(near+w.cellSizeZ,f.max.z)])])].sort((a,b)=>a-b);
    for(let a=1;a<xs.length;a++)for(let b=1;b<zs.length;b++){
      const px=(xs[a]+xs[a-1])/2,pz=(zs[b]+zs[b-1])/2,fill=fills.filter(f=>px>=f.min.x&&px<=f.max.x&&pz>=f.min.z&&pz<=f.max.z).sort((a,b)=>b.level-a.level)[0];
      if(!fill)continue;const share=(xs[a]-xs[a-1])*(zs[b]-zs[b-1])/w.cellArea*Math.max(0,fill.level-s.bed[i]);amount+=share;vx+=share*(fill.velocity?.x??0);vz+=share*(fill.velocity?.z??0);
    }
    if(amount){vx/=amount;vz/=amount;}
    for(const channel of system.channels){const at=sampleTerrainChannel(channel,x,z);if(!at)continue;
      const candidate=at.weight>0?Math.max(0,at.bedY+Math.min(system.river.depth,at.depth)-s.bed[i]):0;
      if(candidate>amount){amount=candidate;vx=at.tangent.x*system.river.speed;vz=at.tangent.z*system.river.speed;}}
    s.depth[i]=amount;s.flowX[i]=vx;s.flowZ[i]=vz;
  }
  s.initialVolume=s.depth.reduce((sum,h)=>sum+h*w.cellArea,0);
  const result:WaterSystemState={systemRevision:system.revision,water:s,pipes:createWaterBodyPipesState(w,system.pipes),steps:0};validateWaterSystemState(system,result);return result;
}

export function validateWaterSystemState(system:WaterSystemManifest,state:WaterSystemState):void {
  if(state.systemRevision!==system.revision||!Number.isSafeInteger(state.steps)||state.steps<0)throw new Error('Water system state revision/step mismatch');
  validateWaterBodyState(system.water,state.water);validateWaterBodyPipesState(system.water,system.pipes,state.pipes);
  if((state as {falls?:unknown}).falls!==undefined)throw new Error('Water system state holds 3D fall regions, which were removed');
}

/** Preparation only: add a finite incoming offshore wind-swell packet using
 * existing water. Save this checkpoint; waves then travel and decay normally.
 * Repeated seeding is repeated external energy, not a passive animation. */
export function seedWaterSystemSwell({system,state,swell}: {system:WaterSystemManifest;state:WaterSystemState;swell:WaterSwell}):WaterSystemState {
  const hosted=callWaterSystemHost<WaterSystemState>('swell',{revision:system.revision,state,swell});if(hosted)return hosted;
  validateWaterSystemState(system,state);
  const next={...state,water:seedWaterSwell(system.water,state.water,system.scene,swell)};validateWaterSystemState(system,next);return next;
}

/** Fixed-step shared water: sources, pressure, pipes, buoyancy, and body reaction.
 * Supply the current scene after opening/breaking a dam. Terrain edits need remapping. */
export function stepWaterSystem({system,state,dt,scene=system.scene,bodies=[],disabledSources=[],wind,detail,flightDestination}:WaterSystemStep):WaterSystemResult {
  if(flightDestination!==undefined&&flightDestination!==system.water.revision)throw new Error('Invalid water flight destination context');
  const hosted=callWaterSystemHost<WaterSystemResult>('step',{revision:system.revision,state,dt,...(scene!==system.scene?{scene}:{}),bodies,disabledSources,wind,...(flightDestination!==undefined?{flightDestination}:{}),...(detail!==undefined?{detail}:{})});if(hosted)return hosted;
  if(detail!==undefined&&typeof detail!=='boolean')throw new Error('Invalid water detail option');
  const events=detail??false;
  validateWaterSystemState(system,state);finite(dt,'step time',1e-5,.05);
  const forcing=resolveWaterWind(wind===undefined?system.wind:wind);
  let water=state.water;
  let sources=system.sources.filter(source=>!disabledSources.includes(source.id)&&source.rate);
  if(sources.some(source=>source.point.y!==undefined)){
    const cells=waterBodyCells(system.water,water),surfaceSources:typeof sources=[];let owned=false;
    for(const source of sources){const i=cells.locate(source.point),y=source.point.y;
      if(y===undefined||i===undefined||y<=cells.level(i)+1e-7){surfaceSources.push(source);continue;}
      if(!owned){water={...water,flights:cloneWaterBodyFlights(water.flights??[])};owned=true;}
      const packet:WaterBodyFlight={id:`source:${hash(source.id)}`,edge:[{x:source.point.x-source.radius,y,z:source.point.z},{x:source.point.x+source.radius,y,z:source.point.z}],velocity:{x:source.velocity?.x??0,y:source.velocity?.y??0,z:source.velocity?.z??0},
        volume:source.rate*dt,time:water.time+dt*.5,duration:dt,sourceDepth:source.radius*2,...(flightDestination?{destination:flightDestination}:{})};
      water.externalAddedVolume+=appendWaterBodyFlight(water.flights!,packet,waterBodyFlightCapacity(system.water,water));
    }
    sources=surfaceSources;
  }
  const sourceGeometry=sources.length&&(system.water.boundaryCells||sources.some(source=>source.velocity?.y)&&system.water.currents!==false&&system.water.depthCurrents!==false)?waterBodyGeometry(system.water,scene,bodies):undefined;
  if(sources.length&&system.water.boundaryCells){water={...water,boundary:cloneBoundaryState(water.boundary!),depth:water.depth.slice(),flowX:water.flowX.slice(),flowZ:water.flowZ.slice(),sleeping:water.sleeping.slice(),quietTime:water.quietTime.slice(),...(water.depthCurrents?{depthCurrents:cloneWaterBodyDepthCurrents(water.depthCurrents)}:{})};
    prepareBoundaryScene(system.water,water,scene);
    for(const source of sources){
      const volume=source.rate*dt;pourBoundaryWater(system.water,water,source.point,source.radius,volume,source.velocity??{x:0,z:0},{cells:source.cells,geometry:sourceGeometry});
      const vy=source.velocity?.y??0;if(vy){const cells=waterBodyCells(system.water,water),i=cells.locate(source.point);if(i!==undefined){const head=cells.level(i),y=Math.max(cells.bed(i)+.001,Math.min(head-.001,source.point.y??head-.001));addWaterBodyDepthImpulse(system.water,water,{point:{...source.point,y},radius:source.radius,impulse:{x:0,y:system.water.liquid.restDensity*volume*vy,z:0},energy:.5*system.water.liquid.restDensity*volume*vy*vy,deferProjection:true},sourceGeometry);}}
    }water.revision++;
  }else if(sources.length){water={...water,depth:water.depth.slice(),flowX:water.flowX.slice(),flowZ:water.flowZ.slice(),sleeping:water.sleeping.slice(),quietTime:water.quietTime.slice(),...(water.depthCurrents?{depthCurrents:cloneWaterBodyDepthCurrents(water.depthCurrents)}:{})};
    for(const source of sources){const volume=source.rate*dt,share=volume/source.cells.length;
      for(const i of source.cells){const old=water.depth[i]*system.water.cellArea,total=old+share;water.flowX[i]=(old*water.flowX[i]+share*(source.velocity?.x??0))/total;water.flowZ[i]=(old*water.flowZ[i]+share*(source.velocity?.z??0))/total;water.depth[i]=total/system.water.cellArea;water.sleeping[i]=false;water.quietTime[i]=0;}
      water.externalAddedVolume+=volume;
      const vy=source.velocity?.y??0;
      if(vy){const w=system.water,i=source.cells.reduce((best,i)=>{
        const distance=(j:number)=>(w.origin.x+(Math.floor(j/w.rows)+.5)*w.cellSizeX-source.point.x)**2+(w.origin.z+(j%w.rows+.5)*w.cellSizeZ-source.point.z)**2;
        return distance(i)<distance(best)?i:best;
      }),surface=water.bed[i]+water.depth[i]+(water.solidDepth?.[i]??0);
        addWaterBodyDepthImpulse(w,water,{point:{x:source.point.x,z:source.point.z,y:Math.max(water.bed[i]+.001,Math.min(surface-.001,source.point.y??surface-.001))},radius:source.radius,
          impulse:{x:0,y:w.liquid.restDensity*volume*vy,z:0},energy:.5*w.liquid.restDensity*volume*vy*vy,deferProjection:true},sourceGeometry);
      }
    }water.revision++;
  }
  const flow=stepWaterBody({water:system.water,state:water,scene,bodies,dt,wind:forcing,flightDestination});water=flow.state;
  let pipes=state.pipes;
  if(system.pipes.length){const result=stepWaterBodyPipes({water:system.water,state:water,pipes:system.pipes,pipeState:pipes,dt,scene,bodies});water=result.state;pipes=result.pipeState??pipes;}
  const support=applyWaterBodyBuoyancy({water:system.water,state:water,bodies:applyLiquidImpulses(bodies,flow.contacts),dt});
  const contacts=[...flow.contacts,...support.contacts],next:WaterSystemState={systemRevision:system.revision,water:support.state,pipes,steps:state.steps+1};
  const airVolume=waterBodyFlightsVolume(next.water.flights),volume=next.water.depth.reduce((sum,h)=>sum+h,0)*system.water.cellArea+airVolume,pipeVolume=waterBodyPipesVolume(pipes);
  const stats:WaterSystemStats={...flow.stats,volume,airVolume,pipeVolume,totalVolume:volume+pipeVolume,wetCells:next.water.depth.filter(h=>h>=system.water.wetDepth).length,sleepingCells:next.water.sleeping.filter(Boolean).length};
  const result:WaterSystemResult={state:next,contacts,bodies:applyLiquidImpulses(bodies,contacts),stats};
  if(events)result.detail=mergeWaterDetailEvents(waterBodyDetailEvents(system.water,next.water,dt,contacts),waterFlightDetailEvents(system.water,next.water,next.water.flights?.filter(f=>!f.destination)??[],flow.flightArrivals??[],dt));
  return result;
}

/** Authoring-time pre-roll. Save the returned state so runtime starts flowing.
 * Bodies/destruction require the coupled helper and a complete world checkpoint. */
export function warmStartWaterSystem({system,state=createWaterSystemState(system),seconds,dt=1/30}:{system:WaterSystemManifest;state?:WaterSystemState;seconds:number;dt?:number}):WaterSystemState {
  finite(seconds,'warm-up duration',0,120);finite(dt,'warm-up step',1/240,.05);
  if(seconds>0&&seconds<1e-5)throw new Error('Water warm-up is shorter than one supported step');
  const ticks=Math.ceil(seconds/dt);if(ticks>3600)throw new Error('Water warm-up step budget exceeded');
  let next=state;for(let i=0;i<ticks;i++)next=stepWaterSystem({system,state:next,dt:seconds/ticks}).state;return next;
}
