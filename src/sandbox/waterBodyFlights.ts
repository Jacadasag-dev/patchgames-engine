/** Conserved water travelling through air between supported surface controls.
 * A packet is one accepted finite-volume emission interval, not a cosmetic
 * particle. Rendering may thin these records; authoritative storage may not. */
import type {PhysicsVector,PhysicsCompoundBody} from './physics.ts';
import {collideLiquid,type LiquidObstacle,type LiquidCollision} from './liquidCollision.ts';
import {physicsBodyMassProperties,physicsApplyInverseInertia} from './physicsMassProperties.ts';

export interface WaterBodyFlight {
  /** Stable emitting face/link; time distinguishes successive intervals. */
  id:string;
  /** Cross-body destination hint. Actual swept contact selects the receiver. */
  destination?:string;
  edge:[PhysicsVector,PhysicsVector];velocity:PhysicsVector;volume:number;
  /** Absolute midpoint of the accepted emission interval, in seconds. */
  time:number;duration:number;sourceDepth:number;
  /** Original midpoint when a solid contact starts a new ballistic segment. */
  emittedTime?:number;
}
export interface WaterFlightSurface {height:number;destination:string;region:number}
export interface WaterFlightArrival {flight:WaterBodyFlight;surface:WaterFlightSurface;position:PhysicsVector;velocity:PhysicsVector;time:number}
export interface WaterFlightCollision extends LiquidCollision {colliderId?:string;bodyId?:string;velocity?:PhysicsVector}
/** A real solid absorbs the removed fluid momentum; density is supplied by
 * the owning water body when this becomes a native contact impulse. */
export interface WaterFlightContact {flight:WaterBodyFlight;point:PhysicsVector;normal:PhysicsVector;velocityBefore:PhysicsVector;velocityAfter:PhysicsVector;solidVelocity:PhysicsVector;colliderId:string;bodyId?:string;time:number}
export type WaterFlightSolidResponse=(flight:WaterBodyFlight,solid:WaterFlightCollision,velocity:PhysicsVector,time:number)=>PhysicsVector;
/** Sequential reduced-mass impacts. Shadow body velocities accumulate the
 * same impulses later applied once to native bodies, so a stream cannot spend
 * each parcel against a stale, infinitely massive version of a light book. */
export function createWaterFlightSolidResponse(bodies:readonly PhysicsCompoundBody[],density:number):WaterFlightSolidResponse {
  if(!Number.isFinite(density)||density<=0)throw new Error('Invalid water flight density');
  const states=new Map<string,{body:PhysicsCompoundBody;properties:ReturnType<typeof physicsBodyMassProperties>;velocity:PhysicsVector;omega:PhysicsVector}>();
  const cross=(a:PhysicsVector,b:PhysicsVector)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
  return(flight,solid,before)=>{
    const n=solid.normal,body=solid.bodyId?bodies.find(b=>b.id===solid.bodyId):undefined;
    if(!body||body.fixed){const wall=solid.velocity??{x:0,y:0,z:0},inward=Math.min(0,(before.x-wall.x)*n.x+(before.y-wall.y)*n.y+(before.z-wall.z)*n.z);return{x:before.x-inward*n.x,y:before.y-inward*n.y,z:before.z-inward*n.z};}
    let state=states.get(body.id);if(!state){state={body,properties:physicsBodyMassProperties(body),velocity:{...body.velocity},omega:{...(body.angularVelocity??{x:0,y:0,z:0})}};states.set(body.id,state);}
    const {properties}=state,r={x:solid.point.x-properties.center.x,y:solid.point.y-properties.center.y,z:solid.point.z-properties.center.z},spin=cross(state.omega,r),wall={x:state.velocity.x+spin.x,y:state.velocity.y+spin.y,z:state.velocity.z+spin.z};solid.velocity=wall;
    const inward=(before.x-wall.x)*n.x+(before.y-wall.y)*n.y+(before.z-wall.z)*n.z;if(inward>=0)return{...before};
    const lever=cross(r,n),rotated=body.lockRotations?{x:0,y:0,z:0}:physicsApplyInverseInertia(properties,lever),compliance=1/properties.mass+lever.x*rotated.x+lever.y*rotated.y+lever.z*rotated.z,mass=density*flight.volume;
    const impulse=-inward/(1/mass+compliance),waterDelta=impulse/mass,bodyDelta=impulse/properties.mass;
    state.velocity.x-=bodyDelta*n.x;state.velocity.y-=bodyDelta*n.y;state.velocity.z-=bodyDelta*n.z;
    state.omega.x-=impulse*rotated.x;state.omega.y-=impulse*rotated.y;state.omega.z-=impulse*rotated.z;
    return{x:before.x+waterDelta*n.x,y:before.y+waterDelta*n.y,z:before.z+waterDelta*n.z};
  };
}
export const WATER_BODY_FLIGHT_LIMITS={packets:4096,sweepSteps:128,maxDt:.1} as const;
const valid=(v:number,min:number,max:number)=>Number.isFinite(v)&&v>=min&&v<=max;
export function cloneWaterBodyFlights(flights:readonly WaterBodyFlight[]):WaterBodyFlight[]{return flights.map(f=>({...f,edge:[{...f.edge[0]},{...f.edge[1]}],velocity:{...f.velocity}}));}
export function waterBodyFlightsVolume(flights:readonly WaterBodyFlight[]|undefined):number{return flights?.reduce((sum,f)=>sum+f.volume,0)??0;}
export function validateWaterBodyFlights(flights:readonly WaterBodyFlight[]|undefined,time=1e9):void {
  if(flights===undefined)return;
  if(!Array.isArray(flights)||flights.length>WATER_BODY_FLIGHT_LIMITS.packets)throw new Error('Water flight packet budget exceeded');
  for(const f of flights){
    if(!f||typeof f.id!=='string'||!f.id||f.id.length>128||f.destination!==undefined&&(typeof f.destination!=='string'||!f.destination||f.destination.length>128)
      ||!valid(f.volume,Number.MIN_VALUE,1e6)||!valid(f.time,-.1,time+.1)||!valid(f.duration,Number.MIN_VALUE,.1)||!valid(f.sourceDepth,0,10000)||f.emittedTime!==undefined&&!valid(f.emittedTime,-.1,f.time)
      ||!Array.isArray(f.edge)||f.edge.length!==2)throw new Error('Invalid water flight packet');
    for(const p of f.edge)if(!p||!valid(p.x,-10000,10000)||!valid(p.y,-10000,10000)||!valid(p.z,-10000,10000))throw new Error('Invalid water flight edge');
    if(!f.velocity||!valid(f.velocity.x,-1000,1000)||!valid(f.velocity.y,-1000,1000)||!valid(f.velocity.z,-1000,1000))throw new Error('Invalid water flight velocity');
  }
}
function sameEmission(a:WaterBodyFlight,b:WaterBodyFlight):boolean {
  return a.id===b.id&&a.destination===b.destination&&a.time===b.time&&a.emittedTime===b.emittedTime&&a.duration===b.duration
    &&a.edge.every((p,i)=>p.x===b.edge[i].x&&p.z===b.edge[i].z);
}
function mergeEmission(same:WaterBodyFlight,flight:WaterBodyFlight):number {
  const total=same.volume+flight.volume,a=same.volume/total,b=flight.volume/total;
  for(const axis of ['x','y','z'] as const)same.velocity[axis]=same.velocity[axis]*a+flight.velocity[axis]*b;
  for(let k=0;k<2;k++)same.edge[k].y=same.edge[k].y*a+flight.edge[k].y*b;
  same.sourceDepth=same.sourceDepth*a+flight.sourceDepth*b;same.volume=total;return flight.volume;
}
/** Index only transaction-owned records. The caller must finish this context
 * before changing packet identity, sorting, replacing, or removing records.
 * No lookup survives a solver transaction or observes an external checkpoint.
 * Optional coalescing is temporal quadrature within one solver step; callers
 * with collision geometry must supply canMove (Grid supplies the native
 * solid/terrain guard). Omission describes a known collision-free domain. */
export function createWaterBodyFlightQueue(flights:WaterBodyFlight[],limit:number,reservation?:{bytes:number;charge:(flight:WaterBodyFlight)=>number},coalesce?:{gravity:number;maxDuration:number;canMove?:(start:PhysicsVector,end:PhysicsVector,fromTime:number,toTime:number)=>boolean}){
  if(!Number.isInteger(limit)||limit<0||limit>WATER_BODY_FLIGHT_LIMITS.packets)throw new Error('Invalid water flight capacity');
  if(reservation&&!Number.isSafeInteger(reservation.bytes))throw new Error('Invalid water flight byte capacity');
  if(coalesce&&(!valid(coalesce.gravity,Number.MIN_VALUE,1000)||!valid(coalesce.maxDuration,Number.MIN_VALUE,.1)))throw new Error('Invalid water flight coalescing interval');
  const charge=(flight:WaterBodyFlight)=>{const value=reservation?.charge(flight)??0;if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid water flight byte charge');return value;};
  let bytes=reservation?.bytes??Number.MAX_SAFE_INTEGER;for(const flight of flights)bytes-=charge(flight);
  const key=(f:WaterBodyFlight)=>JSON.stringify([f.id,f.destination,f.time,f.emittedTime,f.duration,f.edge[0].x,f.edge[0].z,f.edge[1].x,f.edge[1].z]);
  type Group={flight:WaterBodyFlight;fresh:boolean;start:number;end:number};
  const index=new Map<string,Group[]>(),latest=new Map<string,Group>();
  const family=(f:WaterBodyFlight)=>JSON.stringify([f.id,f.destination,f.edge[0].x,f.edge[0].z,f.edge[1].x,f.edge[1].z]);
  const remember=(k:string,group:Group)=>{const list=index.get(k);if(list){if(!list.includes(group))list.push(group);}else index.set(k,[group]);};
  for(const flight of flights)remember(key(flight),{flight,fresh:false,start:flight.time-flight.duration*.5,end:flight.time+flight.duration*.5});
  const clear=(group:Group,flight:WaterBodyFlight)=>{
    if(!coalesce?.canMove||!group.fresh||group.flight.time===flight.time&&group.flight.duration===flight.duration)return true;
    const old=group.flight,start=Math.min(group.start,flight.time-flight.duration*.5),end=Math.max(group.end,flight.time+flight.duration*.5),time=(start+end)*.5,total=old.volume+flight.volume,a=old.volume/total,b=flight.volume/total,da=time-old.time,db=time-flight.time;
    const p={x:(old.edge[0].x+old.edge[1].x)*.5,y:(old.edge[0].y+old.edge[1].y)*.5,z:(old.edge[0].z+old.edge[1].z)*.5},q={x:(flight.edge[0].x+flight.edge[1].x)*.5,y:(flight.edge[0].y+flight.edge[1].y)*.5,z:(flight.edge[0].z+flight.edge[1].z)*.5},center={x:0,y:0,z:0};
    for(const axis of ['x','y','z'] as const){const gravity=axis==='y'?coalesce.gravity:0;center[axis]=(p[axis]+old.velocity[axis]*da-gravity*da*da*.5)*a+(q[axis]+flight.velocity[axis]*db-gravity*db*db*.5)*b;}
    return coalesce.canMove(p,center,old.time,time)&&coalesce.canMove(q,center,flight.time,time);
  };
  const match=(flight:WaterBodyFlight)=>{
    const same=index.get(key(flight))?.find(g=>g.flight.volume+flight.volume<=1e6&&clear(g,flight));if(same)return same;
    if(!coalesce||flight.emittedTime!==undefined)return;
    const g=latest.get(family(flight));if(!g||g.flight.volume+flight.volume>1e6)return;
    const start=flight.time-flight.duration*.5,end=flight.time+flight.duration*.5,tolerance=4*Number.EPSILON*Math.max(1,Math.abs(start),Math.abs(g.end));
    if(Math.abs(start-g.end)>tolerance||end<=g.end||end-g.start>coalesce.maxDuration)return;
    // A reversal is a different jet even when its source interval touches.
    const a=g.flight.velocity,b=flight.velocity,dx=flight.edge[1].x-flight.edge[0].x,dz=flight.edge[1].z-flight.edge[0].z;
    if((a.x*dz-a.z*dx)*(b.x*dz-b.z*dx)<0||a.x*b.x+a.z*b.z<0||a.y*b.y<0)return;
    return clear(g,flight)?g:undefined;
  };
  const combine=(group:Group,flight:WaterBodyFlight)=>{
    const old=group.flight;
    if(!coalesce||!group.fresh||old.time===flight.time&&old.duration===flight.duration)return mergeEmission(old,flight);
    const start=Math.min(group.start,flight.time-flight.duration*.5),end=Math.max(group.end,flight.time+flight.duration*.5),time=(start+end)*.5,total=old.volume+flight.volume,a=old.volume/total,b=flight.volume/total;
    const da=time-old.time,db=time-flight.time,g=coalesce.gravity;
    // Express both ballistic trajectories at one physical time before taking
    // their volume-weighted mean. This preserves the complete centre-of-mass
    // trajectory and momentum; only contact-time quadrature is coarsened.
    for(let k=0;k<2;k++)for(const axis of ['x','y','z'] as const){const gravity=axis==='y'?g:0;
      old.edge[k][axis]=(old.edge[k][axis]+old.velocity[axis]*da-gravity*da*da*.5)*a+(flight.edge[k][axis]+flight.velocity[axis]*db-gravity*db*db*.5)*b;}
    for(const axis of ['x','y','z'] as const){const gravity=axis==='y'?g:0;old.velocity[axis]=(old.velocity[axis]-gravity*da)*a+(flight.velocity[axis]-gravity*db)*b;}
    old.sourceDepth=old.sourceDepth*a+flight.sourceDepth*b;old.volume=total;old.time=time;old.duration=end-start;group.start=start;group.end=end;return flight.volume;
  };
  return{flights,canAppend:(flight:WaterBodyFlight)=>flights.length<limit&&charge(flight)<=bytes||!!match(flight),append:(flight:WaterBodyFlight)=>{
    validateWaterBodyFlights([flight]);const same=match(flight);if(same){const amount=combine(same,flight);remember(key(flight),same);return amount;}
    const cost=charge(flight);if(flights.length>=limit||cost>bytes)return 0;const copy={...flight,edge:[{...flight.edge[0]},{...flight.edge[1]}] as WaterBodyFlight['edge'],velocity:{...flight.velocity}};
    flights.push(copy);bytes-=cost;const group={flight:copy,fresh:true,start:copy.time-copy.duration*.5,end:copy.time+copy.duration*.5};remember(key(copy),group);if(coalesce&&copy.emittedTime===undefined)latest.set(family(copy),group);return flight.volume;
  }};
}
/** Pure capacity decision for provisional RK stages. A caller may choose a
 * smaller wire-derived limit. Full storage blocks discharge at the opening. */
export function canAppendWaterBodyFlight(flights:readonly WaterBodyFlight[]|undefined,flight:WaterBodyFlight,limit:number=WATER_BODY_FLIGHT_LIMITS.packets):boolean {
  if(!Number.isInteger(limit)||limit<0||limit>WATER_BODY_FLIGHT_LIMITS.packets)throw new Error('Invalid water flight capacity');
  return (flights?.length??0)<limit||!!flights?.some(f=>sameEmission(f,flight)&&f.volume+flight.volume<=1e6);
}
/** Append only to transaction-owned storage. RK quadrature at one physical
 * emission time combines volume and momentum; differing times stay separate. */
export function appendWaterBodyFlight(flights:WaterBodyFlight[],flight:WaterBodyFlight,limit:number=WATER_BODY_FLIGHT_LIMITS.packets):number {
  validateWaterBodyFlights([flight]);
  const same=flights.find(f=>sameEmission(f,flight)&&f.volume+flight.volume<=1e6);
  if(same)return mergeEmission(same,flight);
  if(!canAppendWaterBodyFlight(flights,flight,limit))return 0;
  flights.push({...flight,edge:[{...flight.edge[0]},{...flight.edge[1]}],velocity:{...flight.velocity}});return flight.volume;
}
export function waterFlightPoint(flight:WaterBodyFlight,age:number,gravity:number):PhysicsVector {
  const t=Math.max(0,age),a=flight.edge[0],b=flight.edge[1];return{x:(a.x+b.x)*.5+flight.velocity.x*t,y:(a.y+b.y)*.5+flight.velocity.y*t-gravity*t*t*.5,z:(a.z+b.z)*.5+flight.velocity.z*t};
}
/** Reuse the native water collision primitives. The closest swept solid wins;
 * no point may tunnel through a thin wall just because both endpoints are dry. */
export function waterFlightSolidCollision(obstacles:readonly LiquidObstacle[],start:PhysicsVector,end:PhysicsVector,time:number,fromTime:number):WaterFlightCollision|undefined {
  let nearest:WaterFlightCollision|undefined,distance=Infinity;
  for(const obstacle of obstacles){const hit=collideLiquid(start,end,0,obstacle,time,fromTime);if(!hit)continue;
    const d=(hit.point.x-start.x)**2+(hit.point.y-start.y)**2+(hit.point.z-start.z)**2;if(d<distance){nearest={...hit,colliderId:obstacle.colliderId,velocity:obstacle.velocity,...(obstacle.bodyId?{bodyId:obstacle.bodyId}:{})};distance=d;}}
  return nearest;
}
/** Build once per accepted step, after geometry edits. Static bounds form an
 * exact broad phase; moving bodies always use their current swept offsets.
 * Original obstacle order is retained for equal-distance collision ties. */
export function prepareWaterFlightSolidCollision(obstacles:readonly LiquidObstacle[]):(start:PhysicsVector,end:PhysicsVector,time:number,fromTime:number)=>WaterFlightCollision|undefined {
  if(obstacles.length<16)return(start,end,time,fromTime)=>waterFlightSolidCollision(obstacles,start,end,time,fromTime);
  type Node={min:PhysicsVector;max:PhysicsVector;ids?:number[];left?:Node;right?:Node};
  const fixed:number[]=[],moving:number[]=[];
  obstacles.forEach((o,i)=>(!o.bodyMotion&&o.velocity.x===0&&o.velocity.y===0&&o.velocity.z===0?fixed:moving).push(i));
  const build=(ids:number[]):Node=>{
    const min={x:Infinity,y:Infinity,z:Infinity},max={x:-Infinity,y:-Infinity,z:-Infinity};
    for(const i of ids){const o=obstacles[i];for(const axis of ['x','y','z'] as const){min[axis]=Math.min(min[axis],o.min[axis]);max[axis]=Math.max(max[axis],o.max[axis]);}}
    if(ids.length<=4)return{min,max,ids};
    const axis=max.x-min.x>=max.y-min.y&&max.x-min.x>=max.z-min.z?'x':max.y-min.y>=max.z-min.z?'y':'z';
    ids.sort((a,b)=>(obstacles[a].min[axis]+obstacles[a].max[axis])-(obstacles[b].min[axis]+obstacles[b].max[axis])||a-b);
    const middle=ids.length>>1;return{min,max,left:build(ids.slice(0,middle)),right:build(ids.slice(middle))};
  };
  const root=build(fixed);
  return(start,end,time,fromTime)=>{
    const minX=Math.min(start.x,end.x),maxX=Math.max(start.x,end.x),minY=Math.min(start.y,end.y),maxY=Math.max(start.y,end.y),minZ=Math.min(start.z,end.z),maxZ=Math.max(start.z,end.z),ids=moving.slice();
    const visit=(node:Node)=>{
      if(maxX<node.min.x||minX>node.max.x||maxY<node.min.y||minY>node.max.y||maxZ<node.min.z||minZ>node.max.z)return;
      if(node.ids)ids.push(...node.ids);else{visit(node.left!);visit(node.right!);}
    };
    visit(root);ids.sort((a,b)=>a-b);
    return waterFlightSolidCollision(ids.map(i=>obstacles[i]),start,end,time,fromTime);
  };
}
/** The finite water domain has reflecting side walls. Keep airborne inventory
 * inside the same horizontal domain rather than abandoning escaped packets. */
export function waterFlightDomainCollision(bounds:{min:PhysicsVector;max:PhysicsVector},start:PhysicsVector,end:PhysicsVector):LiquidCollision|undefined {
  let fraction=Infinity,normal:PhysicsVector|undefined;
  for(const axis of ['x','z'] as const)for(const side of ['min','max'] as const){const limit=bounds[side][axis],sign=side==='min'?1:-1;
    if((end[axis]-limit)*sign>=0)continue;const delta=end[axis]-start[axis],t=delta?Math.max(0,(limit-start[axis])/delta):0;
    if(t>=0&&t<=1&&t<fraction){fraction=t;normal={x:0,y:0,z:0};normal[axis]=sign;}}
  if(!normal)return;const point={x:start.x+(end.x-start.x)*fraction,y:start.y+(end.y-start.y)*fraction,z:start.z+(end.z-start.z)*fraction};
  return{point,position:{...point},normal};
}
/** Sweep the actual ballistic path. The callback selects a supported surface
 * at each XZ sample, including intermediate floors; destination is only a hint.
 * A packet never contributes to receiving water or impact before contact. */
export function advanceWaterBodyFlights(options:{flights:readonly WaterBodyFlight[];fromTime:number;toTime:number;gravity:number;maxDistance:number;
  surface:(point:PhysicsVector,previous:PhysicsVector,flight:WaterBodyFlight)=>WaterFlightSurface|undefined;
  collide?:(start:PhysicsVector,end:PhysicsVector,time:number,fromTime:number)=>WaterFlightCollision|undefined;
  respond?:WaterFlightSolidResponse;
}):{flights:WaterBodyFlight[];arrivals:WaterFlightArrival[];contacts:WaterFlightContact[]} {
  const {flights,fromTime,toTime,gravity,maxDistance,surface}=options;
  if(!valid(fromTime,0,1e9)||!valid(toTime,fromTime,fromTime+WATER_BODY_FLIGHT_LIMITS.maxDt)||!valid(gravity,Number.MIN_VALUE,1000)||!valid(maxDistance,1e-6,10000))throw new Error('Invalid water flight step');
  validateWaterBodyFlights(flights,toTime);
  const pending:WaterBodyFlight[]=[],arrivals:WaterFlightArrival[]=[],solidContacts:WaterFlightContact[]=[];
  for(const original of flights){
    let flight=original,clock=Math.max(fromTime,flight.time),landed=false,contacts=0,work=0;
    while(clock<toTime){
      if(++work>WATER_BODY_FLIGHT_LIMITS.sweepSteps)throw new Error('Water flight collision work budget exceeded');
      const horizontal=Math.hypot(flight.velocity.x,flight.velocity.z),next=Math.min(toTime,clock+(horizontal?maxDistance/horizontal:toTime-clock)),age=Math.max(0,clock-flight.time),nextAge=Math.max(0,next-flight.time);
      const previous=waterFlightPoint(flight,age,gravity),point=waterFlightPoint(flight,nextAge,gravity),hit=surface(point,previous,flight),solid=options.collide?.(previous,point,next,clock);
      let contactTime=Infinity,target:WaterFlightSurface|undefined;
      // An already buried launch can exit above the support during an upward
      // sweep. Confirm its support at the origin before accepting t=0; a higher
      // surface ahead is not evidence of initial overlap. Ordinary downward
      // sweeps incur no extra surface query.
      const origin=hit&&previous.y<=hit.height&&point.y>hit.height+1e-9?surface(previous,previous,flight):undefined;
      if(origin&&previous.y<=origin.height){target=origin;contactTime=clock;}
      else if(hit&&point.y<=hit.height+1e-9){
        let low=age,high=previous.y<=hit.height?age:nextAge;target=hit;
        for(let n=0;n<16;n++){const middle=(low+high)*.5,p=waterFlightPoint(flight,middle,gravity),candidate=surface(p,previous,flight);
          if(candidate&&p.y<=candidate.height){high=middle;target=candidate;}else low=middle;}
        contactTime=flight.time+high;
      }
      const dx=point.x-previous.x,dy=point.y-previous.y,dz=point.z-previous.z,denominator=dx*dx+dy*dy+dz*dz;
      const fraction=solid?Math.max(0,Math.min(1,((solid.point.x-previous.x)*dx+(solid.point.y-previous.y)*dy+(solid.point.z-previous.z)*dz)/Math.max(1e-30,denominator))):1,solidTime=solid?clock+(next-clock)*fraction:Infinity;
      if(target&&contactTime<=solidTime+1e-7){
        const age=contactTime-flight.time,position=waterFlightPoint(flight,age,gravity);position.y=target.height;
        arrivals.push({flight,surface:target,position,velocity:{x:flight.velocity.x,y:flight.velocity.y-gravity*age,z:flight.velocity.z},time:contactTime});landed=true;break;
      }
      if(solid){
        const age=Math.max(0,solidTime-flight.time),velocity={x:flight.velocity.x,y:flight.velocity.y-gravity*age,z:flight.velocity.z},normal=solid.normal;
        const top=normal.y>.5?surface({...solid.point,y:solid.point.y+1e-7},previous,flight):undefined;
        if(top&&Math.abs(top.height-solid.point.y)<1e-5){arrivals.push({flight,surface:top,position:{...solid.point,y:top.height},velocity,time:solidTime});landed=true;break;}
        const before={...velocity};
        if(options.respond)Object.assign(velocity,options.respond(flight,solid,before,solidTime));
        else{const wall=solid.velocity??{x:0,y:0,z:0},inward=Math.min(0,(velocity.x-wall.x)*normal.x+(velocity.y-wall.y)*normal.y+(velocity.z-wall.z)*normal.z);velocity.x-=inward*normal.x;velocity.y-=inward*normal.y;velocity.z-=inward*normal.z;}
        const solidVelocity=solid.velocity??{x:0,y:0,z:0};
        if((before.x!==velocity.x||before.y!==velocity.y||before.z!==velocity.z)&&solid.colliderId)solidContacts.push({flight,point:{...solid.point},normal:{...normal},velocityBefore:before,velocityAfter:{...velocity},solidVelocity:{...solidVelocity},colliderId:solid.colliderId,...(solid.bodyId?{bodyId:solid.bodyId}:{}),time:solidTime});
        const center={x:solid.point.x+normal.x*1e-6,y:solid.point.y+normal.y*1e-6,z:solid.point.z+normal.z*1e-6},oldCenter=waterFlightPoint(flight,0,gravity);
        flight={...flight,emittedTime:flight.emittedTime??flight.time,time:solidTime,velocity,edge:flight.edge.map(p=>({x:center.x+p.x-oldCenter.x,y:center.y+p.y-oldCenter.y,z:center.z+p.z-oldCenter.z})) as WaterBodyFlight['edge']};
        clock=solidTime;
        // A pathological corner cannot consume unbounded collision work. Keep
        // its full inventory at the last valid contact and resume next tick.
        if(++contacts>=4){flight={...flight,time:toTime};break;}
      }else clock=next;
    }
    if(!landed)pending.push(flight);
  }
  return{flights:pending,arrivals,contacts:solidContacts};
}
