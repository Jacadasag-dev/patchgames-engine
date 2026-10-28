/** Unified inputs for cosmetic water detail: falling sheets, spray and foam.
 * Events sample accepted physical flow and contact energy. They carry no
 * volume of their own, are never stepped back into physics, and dropping or
 * thinning them cannot change authoritative water, currents or forces. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {PhysicsVector} from './physics.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import type {LiquidContact} from './waterDomain.ts';
import {waterFlightPoint,type WaterBodyFlight,type WaterFlightArrival} from './waterBodyFlights.ts';

/** intake/impact: retained cosmetic event shapes for external emitters and
 * recorded detail; these do not create a 3D or airborne liquid simulation.
 * rapid: supercritical, fast body flow that can break and aerate.
 * splash: converging/turning surface current or resolved solid impact. */
export type WaterDetailKind='intake'|'impact'|'rapid'|'splash'|'flight';
export interface WaterDetailEvent {
  kind:WaterDetailKind;
  /** Fall region or body cell that produced the event. */source:string;
  position:PhysicsVector;
  /** Contact or free-surface normal; up for a level receiving surface. */normal:PhysicsVector;
  /** Mean incident velocity of the accepted water. */velocity:PhysicsVector;
  /** Visual liquid-flow sample over duration seconds, never a mass transfer. */volume:number;duration:number;
  /** Incident kinetic energy of that volume in joules. */energy:number;
  /** Receiving water depth before contact; zero for a dry bed. */depth:number;wet:boolean;
  /** Footprint radius in metres. */radius:number;
  /** Simulation time at the end of the interval. */time:number;
  /** Read-only accepted airborne packet. Only actual arrivals emit impacts. */
  flight?:(WaterBodyFlight&{gravity:number});
  /** Emitting sheet depth for matching the water palette after landing. */sourceDepth?:number;
  /** Legacy accepted opening edges for externally supplied cosmetic falls. */
  fall?:{from:[PhysicsVector,PhysicsVector];to:[PhysicsVector,PhysicsVector]};
}
export const WATER_DETAIL_EVENT_LIMIT=256;

/** Combine events from consecutive fixed steps for one presented frame.
 * Same kind/source/footprint events merge by volume, preserving momentum and
 * energy; the strongest events survive a bounded list. Pure and allocation-light. */
export function mergeWaterDetailEvents(into:WaterDetailEvent[],events:readonly WaterDetailEvent[],limit=WATER_DETAIL_EVENT_LIMIT):WaterDetailEvent[] {
  if(!Number.isInteger(limit)||limit<1||limit>4096)throw new Error('Invalid water detail event limit');
  for(const e of events){
    const same=into.find(o=>o.kind===e.kind&&o.source===e.source&&(e.kind==='flight'||Math.hypot(o.position.x-e.position.x,o.position.z-e.position.z)<=Math.max(o.radius,e.radius)));
    if(!same){into.push({...e,position:{...e.position},normal:{...e.normal},velocity:{...e.velocity}});continue;}
    if(e.kind==='flight'){if(e.time>=same.time)Object.assign(same,e,{position:{...e.position},normal:{...e.normal},velocity:{...e.velocity}});continue;}
    const total=same.volume+e.volume,a=total?same.volume/total:.5,b=1-a;
    for(const axis of ['x','y','z'] as const){same.position[axis]=same.position[axis]*a+e.position[axis]*b;same.velocity[axis]=same.velocity[axis]*a+e.velocity[axis]*b;same.normal[axis]=same.normal[axis]*a+e.normal[axis]*b;}
    const n=Math.hypot(same.normal.x,same.normal.y,same.normal.z)||1;same.normal.x/=n;same.normal.y/=n;same.normal.z/=n;
    same.volume=total;same.energy+=e.energy;// Same-step events share one interval; later steps extend it.
    same.duration=Math.abs(e.time-same.time)>1e-9?same.duration+e.duration:Math.max(same.duration,e.duration);
    same.depth=Math.max(same.depth,e.depth);same.wet||=e.wet;same.radius=Math.max(same.radius,e.radius);same.time=Math.max(same.time,e.time);
    if(e.fall)same.fall=e.fall;
  }
  if(into.length>limit){into.sort((x,y)=>y.energy-x.energy||y.volume-x.volume);into.length=limit;}
  return into;
}

/** Read-only accepted air storage and landing contacts. Snapshot events never
 * spawn droplets or claim a receiving impact before the physical sweep lands. */
export function waterFlightDetailEvents(w:WaterBodyManifest,s:WaterBodyState,flights:readonly WaterBodyFlight[],arrivals:readonly WaterFlightArrival[],dt:number,limit=WATER_DETAIL_EVENT_LIMIT):WaterDetailEvent[] {
  if(!Number.isFinite(dt)||dt<=0||!Number.isInteger(limit)||limit<1||limit>WATER_DETAIL_EVENT_LIMIT)throw new Error('Invalid water flight detail sample');
  const result:WaterDetailEvent[]=[],rho=w.liquid.restDensity,cells=arrivals.length?waterBodyCells(w,s):undefined;
  const radius=(f:WaterBodyFlight)=>Math.max(.005,Math.hypot(f.edge[1].x-f.edge[0].x,f.edge[1].z-f.edge[0].z)*.5);
  for(const arrival of arrivals){const {flight,position,velocity}=arrival,i=cells!.locate(position),depth=i===undefined?0:cells!.depth(i);
    result.push({kind:'impact',sourceDepth:flight.sourceDepth,source:`flight-impact:${flight.id}:${flight.emittedTime??flight.time}`,position:{...position},normal:{x:0,y:1,z:0},velocity:{...velocity},volume:flight.volume,duration:Math.min(dt,flight.duration),energy:.5*rho*flight.volume*(velocity.x**2+velocity.y**2+velocity.z**2),depth,wet:depth>w.wetDepth,radius:radius(flight),time:arrival.time});
  }
  if(result.length>limit){result.sort((a,b)=>b.energy-a.energy);result.length=limit;}
  const active=flights.length>limit-result.length?flights.slice().sort((a,b)=>b.volume-a.volume||a.time-b.time).slice(0,limit-result.length):flights;
  for(const flight of active)result.push(waterFlightSnapshotEvent(w,s.time,flight));
  return result;
}

/** One accepted physical packet for presentation. Views read the complete
 * authoritative flight list; bounded optional event lists may omit snapshots. */
export function waterFlightSnapshotEvent(w:WaterBodyManifest,time:number,flight:WaterBodyFlight):WaterDetailEvent {
  const gravity=-w.liquid.gravity.y,age=Math.max(0,time-flight.time),velocity={x:flight.velocity.x,y:flight.velocity.y-gravity*age,z:flight.velocity.z};
  return{kind:'flight',source:`flight:${flight.id}:${flight.emittedTime??flight.time}`,position:waterFlightPoint(flight,age,gravity),normal:{x:0,y:1,z:0},velocity,volume:flight.volume,duration:flight.duration,energy:.5*w.liquid.restDensity*flight.volume*(velocity.x**2+velocity.y**2+velocity.z**2),depth:flight.sourceDepth,wet:false,radius:Math.max(.005,Math.hypot(flight.edge[1].x-flight.edge[0].x,flight.edge[1].z-flight.edge[0].z)*.5),time,flight:{...flight,edge:[{...flight.edge[0]},{...flight.edge[1]}],velocity:{...flight.velocity},gravity}};
}

/** Fast supercritical body flow, where a resolved shallow-water current would
 * break and aerate. Read-only; returns at most `limit` strongest cells. */
export function waterBodyRapidEvents(w:WaterBodyManifest,s:WaterBodyState,dt:number,limit=24):WaterDetailEvent[] {
  const g=-w.liquid.gravity.y,rho=w.liquid.restDensity,result:WaterDetailEvent[]=[],cells=waterBodyCells(w,s);
  for(let i=0;i<cells.count;i++){
    const h=cells.depth(i);if(h<.02)continue;
    const u=cells.flowX[i],v=cells.flowZ[i],speed=Math.hypot(u,v),froude=speed/Math.sqrt(g*h);
    if(speed<1.2||froude<1.05)continue;
    const width=Math.sqrt(cells.area(i)),volume=speed*h*width*dt,energy=.5*rho*volume*speed*speed*Math.min(1,froude-1),center=cells.center(i);
    result.push({kind:'rapid',source:`body:${i}`,position:{x:center.x,y:cells.level(i),z:center.z},
      normal:{x:0,y:1,z:0},velocity:{x:u,y:0,z:v},volume,duration:dt,energy,depth:h,wet:true,radius:width*.5,time:s.time});
  }
  if(result.length>limit){result.sort((a,b)=>b.energy-a.energy);result.length=limit;}
  return result;
}

/** Secondary detail sampled from an accepted physical step. Face events use
 * the resolved velocity and wet opening, not an extra liquid transfer: their
 * volume is only a bounded visual flow sample. Contact events use the energy
 * actually delivered to the collider. No state, mass or momentum is changed.
 * Uniform translation and resting pressure never produce splash events. */
export function waterBodyDetailEvents(w:WaterBodyManifest,s:WaterBodyState,dt:number,contacts:readonly LiquidContact[]=[],limit=64):WaterDetailEvent[] {
  if(!Number.isFinite(dt)||dt<=0)throw new Error('Invalid water detail duration');
  if(!Number.isInteger(limit)||limit<1||limit>WATER_DETAIL_EVENT_LIMIT)throw new Error('Invalid water detail event limit');
  const cells=waterBodyCells(w,s),rho=w.liquid.restDensity,result=waterBodyRapidEvents(w,s,dt,Math.min(24,limit));
  const used=new Float64Array(cells.count),heads=new Float64Array(cells.count).fill(NaN);
  const head=(i:number)=>Number.isNaN(heads[i])?(heads[i]=cells.level(i)):heads[i];
  const push=(event:WaterDetailEvent)=>{
    if(!(event.volume>0&&event.energy>0))return;
    if(result.length<limit){result.push(event);return;}
    let weakest=0;for(let i=1;i<result.length;i++)if(result[i].energy<result[weakest].energy)weakest=i;
    if(event.energy>result[weakest].energy)result[weakest]=event;
  };
  // A positive-part integral gives the exact aperture for a linear face bed.
  const aperture=(h:number,a:number,b:number)=>{const lo=h-Math.min(a,b),hi=h-Math.max(a,b);return lo<=0?0:hi>=0?(lo+hi)*.5:lo*lo/(2*(lo-hi));};
  const face=(a:number,b:number,nx:number,nz:number,length:number,x:number,z:number,bed0:number,bed1:number)=>{
    if(b<0||cells.depth(a)<=w.wetDepth||cells.depth(b)<=w.wetDepth)return;
    const ax=cells.flowX[a],az=cells.flowZ[a],bx=cells.flowX[b],bz=cells.flowZ[b],ua=ax*nx+az*nz,ub=bx*nx+bz*nz;
    // Only compression along an open interface can break a current. Pure
    // tangential shear and a coherent straight stream remain splash-free.
    const closing=ua-ub;if(closing<=.5)return;
    const fromA=ua>=-ub,i=fromA?a:b,j=fromA?b:a,incoming=fromA?ua:-ub;
    if(incoming<=.75)return;
    const u=cells.flowX[i],v=cells.flowZ[i],speed2=u*u+v*v;
    const opening=aperture(head(i),bed0,bed1);if(opening<=w.dryDepth)return;
    const volume=Math.min(Math.max(0,cells.volume(i)-used[i]),incoming*opening*length*dt);
    if(!(volume>0))return;used[i]+=volume;
    const difference2=(ax-bx)**2+(az-bz)**2,energy=.5*rho*volume*Math.min(speed2,difference2);
    const sign=fromA?1:-1,receiving=head(j),position=receiving<Math.min(bed0,bed1)?cells.center(j):{x,z};
    // Below a ledge, the shared face lies inside the cliff. The receiving
    // control's wet center is the resolved foot of the descending flow.
    push({kind:'splash',source:`flow:${a}:${b}`,position:{...position,y:Math.min(head(i),receiving)},normal:{x:-nx*sign,y:0,z:-nz*sign},
      velocity:{x:u,y:0,z:v},volume,duration:dt,energy,depth:cells.depth(j),wet:true,radius:Math.min(length*.5,Math.sqrt(cells.area(i))*.5),time:s.time});
  };
  if(s.boundary){
    for(const f of cells.faces())face(f.a,f.b,f.nx,f.nz,f.length,(f.start.x+f.end.x)*.5,(f.start.z+f.end.z)*.5,f.start.bed,f.end.bed);
  }else{
    // The ordinary grid needs no temporary face objects or scene rebuild.
    const crest=(a:number,b:number,saved:string)=>Math.max(s.bed[a],s.bed[b],saved?Number(saved.slice(saved.lastIndexOf('|')+1)):-Infinity);
    for(let x=1;x<w.columns;x++)for(let z=0;z<w.rows;z++){const a=(x-1)*w.rows+z,b=a+w.rows,bed=crest(a,b,s.barrierX[x*w.rows+z]);
      face(a,b,1,0,w.cellSizeZ,w.origin.x+x*w.cellSizeX,w.origin.z+(z+.5)*w.cellSizeZ,bed,bed);}
    for(let x=0;x<w.columns;x++)for(let z=1;z<w.rows;z++){const a=x*w.rows+z-1,b=a+1,bed=crest(a,b,s.barrierZ[x*(w.rows+1)+z]);
      face(a,b,0,1,w.cellSizeX,w.origin.x+(x+.5)*w.cellSizeX,w.origin.z+z*w.cellSizeZ,bed,bed);}
  }
  for(const contact of contacts){
    if(!(contact.kineticEnergy>0&&contact.speed>.75))continue;
    const magnitude=Math.hypot(contact.impulse.x,contact.impulse.y,contact.impulse.z);if(!(magnitude>0))continue;
    const normal={x:-contact.impulse.x/magnitude,y:-contact.impulse.y/magnitude,z:-contact.impulse.z/magnitude};
    let i:number|undefined;
    for(const offset of [1e-6,.1,.5]){const distance=Math.min(w.cellSizeX,w.cellSizeZ)*offset,candidate=cells.locate({x:contact.point.x+normal.x*distance,z:contact.point.z+normal.z*distance});
      if(candidate!==undefined&&cells.depth(candidate)>w.wetDepth){i=candidate;break;}}
    if(i===undefined)continue;
    const speed=Math.min(w.maxFlowSpeed,contact.speed),volume=Math.min(cells.volume(i),2*contact.kineticEnergy/(rho*speed*speed));
    const energy=Math.min(contact.kineticEnergy,.5*rho*volume*speed*speed);
    push({kind:'splash',source:`contact:${contact.bodyId??''}:${contact.colliderId}`,position:{x:contact.point.x,y:head(i),z:contact.point.z},normal,
      velocity:{x:-normal.x*speed,y:-normal.y*speed,z:-normal.z*speed},volume,duration:dt,energy,depth:cells.depth(i),wet:true,
      radius:Math.min(Math.sqrt(cells.area(i))*.5,Math.sqrt(volume/Math.max(cells.depth(i),w.wetDepth))),time:s.time});
  }
  return result;
}
