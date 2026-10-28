import {validateWaterBodyState,type WaterBodyManifest,type WaterBodyState} from './waterBody.ts';
import {waterBodyCells,type WaterBodyCells} from './waterBodyCells.ts';
import {cloneBoundaryState} from './waterBoundary.ts';
import {waterBodyRegionGroupHead} from './waterBodyGridRegions.ts';
import type {WaterCellFace} from './waterBodyCells.ts';
import {appendWaterBodyFlight,canAppendWaterBodyFlight,cloneWaterBodyFlights,advanceWaterBodyFlights,waterFlightSolidCollision,prepareWaterFlightSolidCollision,waterFlightDomainCollision,waterFlightPoint,type WaterBodyFlight,type WaterFlightArrival,type WaterFlightContact,type WaterFlightSolidResponse} from './waterBodyFlights.ts';
import type {LiquidObstacle} from './liquidCollision.ts';
import {waterBodyFlightCapacity} from './waterBodyWire.ts';
import {addWaterBodyDepthImpulses,cloneWaterBodyDepthCurrents,type WaterBodyDepthCurrentImpulse} from './waterBodyDepthCurrents.ts';

export interface WaterBodyConnectionEnd {
  water:WaterBodyManifest;state:WaterBodyState;
  /** World position in the cell immediately beside the shared opening. */
  point:{x:number;z:number};
}
export interface WaterBodyConnection {
  a:WaterBodyConnectionEnd;b:WaterBodyConnectionEnd;
  /** Width of this local opening, in metres. Use distinct pairs for a wider opening. */
  width:number;
  /** Physical centre-to-centre travel distance; defaults to endpoint spacing. */
  distance?:number;
  /** Actual solid crest across the local opening, when higher than either bed. */
  sill?:number;
  /** Upper edge of an open free-surface interval. Pressurized flow is unsupported. */
  ceiling?:number;
  /** Stable geometry-derived opening identity and its actual shared edge. */
  id?:string;opening?:{start:{x:number;z:number};end:{x:number;z:number}};
  dt:number;
}
export interface WaterBodyConnectionResult {
  a:WaterBodyState;b:WaterBodyState;
  /** Net liquid volume in m³, positive from A to B. */
  volume:number;
  /** Net volume / dt, in m³/s. */
  discharge:number;
  substeps:number;
}
export const WATER_BODY_CONNECTION_LIMITS={substeps:64,maxDt:.1} as const;
export interface WaterBodyConnections {
  layers:{water:WaterBodyManifest;state:WaterBodyState}[];
  connections:{a:number;b:number;pointA:{x:number;z:number};pointB:{x:number;z:number};width:number;distance?:number;sill?:number;ceiling?:number;id?:string;opening?:WaterBodyConnection['opening']}[];
  dt:number;
  /** Prepared real solids for airborne travel; no additional authored routes. */
  obstacles?:readonly LiquidObstacle[];
  bounds?:WaterBodyManifest['liquid']['bounds'];
  respond?:WaterFlightSolidResponse;
}
export interface WaterBodyConnectionsResult {states:WaterBodyState[];volumes:number[];transferredVolume:number;arrivals:WaterFlightArrival[][];contacts:WaterFlightContact[][]}
interface Topology {adjacent:WaterCellFace[][]}
interface Transaction {owned:Set<WaterBodyState>;validated:Set<WaterBodyState>;pending:Map<WaterBodyState,{water:WaterBodyManifest;cells:WaterBodyCells}>;topologies:Map<WaterBodyState,Topology>}
const finite=(value:number,name:string,min:number,max:number)=>{
  if(!Number.isFinite(value)||value<min||value>max)throw new Error(`Invalid water body connection ${name}`);
};
function copy(s:WaterBodyState):WaterBodyState {
  // Geometry, hull support and layered residual currents are not modified by
  // this planar interface. The next system step owns their usual update.
  return {...s,revision:s.revision+1,depth:s.depth.slice(),flowX:s.flowX.slice(),flowZ:s.flowZ.slice(),sleeping:s.sleeping.slice(),quietTime:s.quietTime.slice(),
    ...(s.solidDepth?{solidDepth:s.solidDepth.slice()}:{}),...(s.boundary?{boundary:cloneBoundaryState(s.boundary)}:{}),
    ...(s.flights?{flights:cloneWaterBodyFlights(s.flights)}:{}),...(s.depthCurrents?{depthCurrents:cloneWaterBodyDepthCurrents(s.depthCurrents)}:{})};
}
function span(c:WaterBodyCells,i:number,nx:number,nz:number):number {
  let low=Infinity,high=-Infinity;
  for(const p of c.polygon(i)){const t=-nz*p.x+nx*p.z;low=Math.min(low,t);high=Math.max(high,t);}
  return high-low;
}
function checkCeiling(c:WaterBodyCells,i:number,ceiling:number|undefined):void {
  if(ceiling!==undefined&&c.volume(i)>1e-12&&c.level(i)>=ceiling-1e-7)throw new Error('Water body connection reached a solid ceiling; pressure-filled flow is unsupported');
}
/** A fragment of one open planar floor is not an independent microscopic
 * reservoir. Use the same conservative small-control principle as the grid
 * stage, restricted to a bounded wet-connected neighborhood. */
function endpointGroup(w:WaterBodyManifest,s:WaterBodyState,c:WaterBodyCells,home:number,transaction?:Transaction):number[]{
  const target=w.cellArea*.25,members=[home];if(c.area(home)>=target||!s.boundary||c.volume(home)<=0)return members;
  let topology=transaction?.topologies.get(s);
  if(!topology){const adjacent=Array.from({length:c.count},()=>[] as WaterCellFace[]);for(const f of c.faces()){adjacent[f.a].push(f);if(f.b>=0)adjacent[f.b].push(f);}topology={adjacent};transaction?.topologies.set(s,topology);}
  const region=c.region(home)!,parent=c.parent(home),x=Math.floor(parent/w.rows),z=parent%w.rows,seen=new Set(members);let area=c.area(home),volume=c.volume(home);
  while(area<target&&members.length<64){let choice=-1,best=-Infinity;
    for(const i of members)for(const f of topology.adjacent[i]){const j=f.a===i?f.b:f.a;if(j<0||seen.has(j)||f.barrier)continue;
      const other=c.region(j)!,base=c.parent(j);if(Math.abs(Math.floor(base/w.rows)-x)+Math.abs(base%w.rows-z)>1||area+c.area(j)>w.cellArea*2)continue;
      if(region.ceiling!==other.ceiling||other.polygon.some(p=>Math.abs(c.bedAt(home,p.x,p.z)-p.bed)>1e-8))continue;
      const crest=Math.min(f.start.bed,f.end.bed)+Math.max(c.solidDepth[i],c.solidDepth[j]);let capacity=c.capacityAtHead(j,crest+w.dryDepth);
      for(const member of members)capacity+=c.capacityAtHead(member,crest+w.dryDepth);
      if(volume+c.volume(j)<=capacity)continue;
      const score=f.length*(base===parent?2:1);if(score>best){best=score;choice=j;}
    }
    if(choice<0)break;members.push(choice);seen.add(choice);area+=c.area(choice);volume+=c.volume(choice);
  }
  return members;
}
function inventory(c:WaterBodyCells,members:number[]){
  if(members.length===1){const i=members[0];return{area:c.area(i),volume:c.volume(i),head:c.level(i),x:c.flowX[i],z:c.flowZ[i]};}
  let area=0,volume=0,x=0,z=0;for(const i of members){const v=c.volume(i);area+=c.area(i);volume+=v;x+=v*c.flowX[i];z+=v*c.flowZ[i];}
  return{area,volume,head:waterBodyRegionGroupHead(c,members,volume),x:volume?x/volume:0,z:volume?z/volume:0};
}

/** Join adjacent cells in separately stepped water bodies through an authored
 * open face (for example the foot of a stair ramp). This is a local finite-
 * volume interface, not a pipe or a remote source. Its hydrostatic Rusanov
 * flux matches the rectangular solver, including back pressure and upwind
 * tangential momentum. Author only unobstructed openings; this helper does
 * not perform scene collision queries or another floating-body solve.
 *
 * Both clocks stay unchanged. Each body's external ledger records the same
 * liquid crossing the interface, so their combined inventory is conserved.
 */
export function exchangeWaterBodyConnection(options:WaterBodyConnection):WaterBodyConnectionResult {
  const landed=advanceConnectionFlights([options.a,options.b],options.dt),result=exchange({...options,a:{...options.a,state:landed.states[0]},b:{...options.b,state:landed.states[1]}});
  return result;
}
function exchange(options:WaterBodyConnection,transaction?:Transaction):WaterBodyConnectionResult {
  const {a,b,width,dt}=options;
  if(!a?.point||!b?.point||a.state===b.state)throw new Error('Invalid water body connection endpoints');
  finite(dt,'step time',Number.MIN_VALUE,WATER_BODY_CONNECTION_LIMITS.maxDt);
  finite(width,'width',1e-6,8);
  if(options.sill!==undefined)finite(options.sill,'sill',-10000,10000);
  if(options.ceiling!==undefined)finite(options.ceiling,'ceiling',-10000,10000);
  for(const p of [a.point,b.point]){finite(p.x,'position',-10000,10000);finite(p.z,'position',-10000,10000);}
  for(const end of [a,b])if(!transaction?.validated.has(end.state)){validateWaterBodyState(end.water,end.state);transaction?.validated.add(end.state);}
  const g=-a.water.liquid.gravity.y;
  if(g!==-b.water.liquid.gravity.y||a.water.liquid.restDensity!==b.water.liquid.restDensity)throw new Error('Water body connection requires matching gravity and liquid density');
  const dx=b.point.x-a.point.x,dz=b.point.z-a.point.z,separation=Math.hypot(dx,dz),distance=options.distance??separation;
  const locality=(Math.hypot(a.water.cellSizeX,a.water.cellSizeZ)+Math.hypot(b.water.cellSizeX,b.water.cellSizeZ))*.5;
  finite(separation,'endpoint spacing',1e-6,locality+1e-9);finite(distance,'distance',separation,locality+1e-9);
  const nx=dx/separation,nz=dz/separation;
  let ca=waterBodyCells(a.water,a.state),cb=waterBodyCells(b.water,b.state);
  const ia=ca.locate(a.point),ib=cb.locate(b.point);
  if(ia===undefined||ib===undefined)throw new Error('Water body connection endpoint is outside its water body');
  if(width>Math.min(span(ca,ia,nx,nz),span(cb,ib,nx,nz))+1e-9)throw new Error('Water body connection width exceeds its local cell opening');
  let sa=a.state,sb=b.state,remaining=dt,volume=0,substeps=0,changed=false;
  const prepare=(s:WaterBodyState)=>{
    if(transaction?.owned.has(s)){s.revision++;return s;}
    const result=copy(s);transaction?.owned.add(result);transaction?.validated.add(result);return result;
  };
  const bedA=ca.bedAt(ia,a.point.x,a.point.z)+ca.solidDepth[ia],bedB=cb.bedAt(ib,b.point.x,b.point.z)+cb.solidDepth[ib],sill=Math.max(bedA,bedB,options.sill??-Infinity);
  while(remaining>0){
    checkCeiling(ca,ia,options.ceiling);checkCeiling(cb,ib,options.ceiling);
    const membersA=endpointGroup(a.water,sa,ca,ia,transaction),membersB=endpointGroup(b.water,sb,cb,ib,transaction),qa=inventory(ca,membersA),qb=inventory(cb,membersB),areaA=qa.area,areaB=qb.area,spacing=Math.min(distance,areaA/width,areaB/width);
    const va=qa.volume,vb=qb.volume,ha=Math.max(0,qa.head-sill),hb=Math.max(0,qb.head-sill);
    const ua=qa.x*nx+qa.z*nz,ub=qb.x*nx+qb.z*nz;
    const ta=-qa.x*nz+qa.z*nx,tb=-qb.x*nz+qb.z*nx;
    const wave=Math.max(Math.abs(ua)+Math.sqrt(g*ha),Math.abs(ub)+Math.sqrt(g*hb));
    if(!wave||!ha&&!hb)break;
    const sub=Math.min(remaining,.25*spacing/wave);
    if(++substeps>WATER_BODY_CONNECTION_LIMITS.substeps)throw new Error(`Water body connection flow budget exceeded: ${JSON.stringify({pointA:a.point,pointB:b.point,ia,ib,areaA,areaB,width,spacing,ha,hb,ua,ub,remaining})}`);
    let rate=(.5*(ha*ua+hb*ub)-.5*wave*(hb-ha))*width;
    // A raised receiving bed cannot draw the donor below the opening. This
    // cap also makes near-dry roundoff conservative on arbitrarily cut cells.
    if(rate>0)rate=Math.min(rate,Math.max(0,va-membersA.reduce((sum,i)=>sum+ca.capacityAtHead(i,sill),0))/sub);
    else rate=Math.max(rate,-Math.max(0,vb-membersB.reduce((sum,i)=>sum+cb.capacityAtHead(i,sill),0))/sub);
    const moved=rate*sub,normal=.5*(ha*ua*ua+hb*ub*ub+.5*g*(ha*ha+hb*hb))-.5*wave*(hb*ub-ha*ua);
    const falling=moved>0&&qb.head<sill-1e-7||moved<0&&qa.head<sill-1e-7;
    let flight:WaterBodyFlight|undefined;
    if(falling){
      const forward=moved>0,sign=forward?1:-1,donor=forward?a:b,recipient=forward?b:a,source=forward?sa:sb,depth=forward?ha:hb;
      const midpoint={x:(a.point.x+b.point.x)*.5,z:(a.point.z+b.point.z)*.5},opening=options.opening??{start:{x:midpoint.x-nz*width*.5,z:midpoint.z+nx*width*.5},end:{x:midpoint.x+nz*width*.5,z:midpoint.z-nx*width*.5}};
      const speed=Math.min(donor.water.maxFlowSpeed,Math.max(0,normal*width/Math.max(1e-30,Math.abs(rate)))),tangent=forward?ta:tb,inset=Math.min(donor.water.cellSizeX,donor.water.cellSizeZ)*1e-7;
      const keyA=`${a.point.x},${a.point.z}`,keyB=`${b.point.x},${b.point.z}`,id=options.id??`connection:${[keyA,keyB].sort().join(':')}`;
      flight={id,destination:recipient.water.revision,edge:[opening.start,opening.end].map(p=>({x:p.x+sign*nx*inset,y:sill+depth*.5,z:p.z+sign*nz*inset})).sort((a,b)=>a.x-b.x||a.z-b.z) as WaterBodyFlight['edge'],
        velocity:{x:sign*nx*speed-nz*tangent,y:0,z:sign*nz*speed+nx*tangent},volume:Math.abs(moved),time:source.time-dt+(dt-remaining)+sub*.5,duration:sub,sourceDepth:depth};
      if(!canAppendWaterBodyFlight(source.flights,flight,waterBodyFlightCapacity(donor.water,source)))break;
    }
    // Subtract each closed boundary's own hydrostatic pressure. Thus an
    // equal-head lake stays at rest, while an opening accelerates real flow.
    const impulseA=(normal-.5*g*ha*ha)*width*sub,impulseB=(normal-.5*g*hb*hb)*width*sub,tangent=moved*(moved>=0?ta:tb);
    if(!moved&&!impulseA&&!impulseB)break;
    if(moved||impulseA||impulseB){
      if(!changed){sa=prepare(sa);sb=prepare(sb);ca=waterBodyCells(a.water,sa);cb=waterBodyCells(b.water,sb);changed=true;}
      const nextA=Math.max(0,va-(flight&&moved<0?0:moved)),nextB=Math.max(0,vb+(flight&&moved>0?0:moved));
      const write=(c:WaterBodyCells,members:number[],w:WaterBodyManifest,v:number,mn:number,mt:number,area:number)=>{
        const head=members.length>1?waterBodyRegionGroupHead(c,members,v):0,capacities=members.length>1?members.map(i=>c.capacityAtHead(i,head)):[v],sum=capacities.reduce((a,b)=>a+b,0),largest=capacities.indexOf(Math.max(...capacities));let assigned=0;
        for(let k=0;k<members.length;k++)if(k!==largest){const value=sum?capacities[k]*v/sum:0;c.setVolume(members[k],value);assigned+=value;}c.setVolume(members[largest],Math.max(0,v-assigned));
        let x=0,z=0;
        if(v>w.dryDepth*area){
          const vx=(mn*nx-mt*nz)/v,vz=(mn*nz+mt*nx)/v,limit=Math.min(1,w.maxFlowSpeed/Math.max(1e-30,Math.hypot(vx,vz)));
          x=vx*limit||0;z=vz*limit||0;
        }
        for(const i of members){c.flowX[i]=x;c.flowZ[i]=z;c.wake(i);checkCeiling(c,i,options.ceiling);}
      };
      if(!flight||moved>0)write(ca,membersA,a.water,nextA,va*ua-impulseA,va*ta-tangent,areaA);
      if(!flight||moved<0)write(cb,membersB,b.water,nextB,vb*ub+impulseB,vb*tb+tangent,areaB);
      if(flight){const source=moved>0?sa:sb;if(appendWaterBodyFlight(source.flights??= [],flight,waterBodyFlightCapacity(moved>0?a.water:b.water,source))!==Math.abs(moved))throw new Error('Water flight reservation changed during connection');}
      else if(moved>=0){sa.externalRemovedVolume+=moved;sb.externalAddedVolume+=moved;}else{sa.externalAddedVolume-=moved;sb.externalRemovedVolume-=moved;}
      volume+=moved;
    }
    remaining=sub===remaining?0:remaining-sub;
  }
  checkCeiling(ca,ia,options.ceiling);checkCeiling(cb,ib,options.ceiling);
  if(changed){
    if(transaction){transaction.pending.set(sa,{water:a.water,cells:ca});transaction.pending.set(sb,{water:b.water,cells:cb});}
    else{ca.commit();cb.commit();validateWaterBodyState(a.water,sa);validateWaterBodyState(b.water,sb);}
  }
  return{a:sa,b:sb,volume,discharge:volume/dt,substeps};
}

/** Apply the same ordered local operators as individual calls, but validate
 * and copy each touched body once. All writes stay in transaction-owned state;
 * an invalid later connection cannot mutate any supplied checkpoint. */
export function exchangeWaterBodyConnections({layers,connections,dt,obstacles,bounds,respond}:WaterBodyConnections):WaterBodyConnectionsResult {
  finite(dt,'step time',Number.MIN_VALUE,WATER_BODY_CONNECTION_LIMITS.maxDt);
  if(!Array.isArray(layers)||!layers.length||layers.length>16||!Array.isArray(connections)||connections.length>2048)throw new Error('Water body connection batch budget exceeded');
  const landed=advanceConnectionFlights(layers,dt,obstacles,bounds,respond),transaction:Transaction={owned:new Set(),validated:new Set(),pending:new Map(),topologies:new Map()},states=landed.states,volumes:number[]=[];
  if(new Set(states).size!==states.length)throw new Error('Water body connection batch requires distinct states');
  for(const layer of layers){validateWaterBodyState(layer.water,layer.state);transaction.validated.add(layer.state);}
  for(const link of connections){
    if(!Number.isInteger(link.a)||!Number.isInteger(link.b)||link.a<0||link.b<0||link.a>=layers.length||link.b>=layers.length||link.a===link.b)throw new Error('Invalid water body connection batch endpoints');
    const result=exchange({a:{water:layers[link.a].water,state:states[link.a],point:link.pointA},b:{water:layers[link.b].water,state:states[link.b],point:link.pointB},width:link.width,distance:link.distance,sill:link.sill,ceiling:link.ceiling,id:link.id,opening:link.opening,dt},transaction);
    states[link.a]=result.a;states[link.b]=result.b;volumes.push(result.volume);
  }
  // A later opening can raise an endpoint of an earlier one. Validate all
  // final intervals before publishing the transaction, including such links.
  if(connections.some(link=>link.ceiling!==undefined)){
    const cells=layers.map((layer,k)=>transaction.pending.get(states[k])?.cells??waterBodyCells(layer.water,states[k]));
    for(const link of connections)if(link.ceiling!==undefined){checkCeiling(cells[link.a],cells[link.a].locate(link.pointA)!,link.ceiling);checkCeiling(cells[link.b],cells[link.b].locate(link.pointB)!,link.ceiling);}
  }
  for(const [state,{water,cells}] of transaction.pending){cells.commit();validateWaterBodyState(water,state);}
  return{states,volumes,transferredVolume:volumes.reduce((sum,v)=>sum+Math.abs(v),0),arrivals:landed.arrivals,contacts:landed.contacts};
}

/** The owning body's air inventory crosses its external ledger only when it
 * physically arrives. The highest supported surface swept on the trajectory
 * wins, including an intermediate floor different from the original hint. */
function advanceConnectionFlights(layers:readonly {water:WaterBodyManifest;state:WaterBodyState}[],dt:number,obstacles?:readonly LiquidObstacle[],bounds?:WaterBodyConnections['bounds'],respond?:WaterFlightSolidResponse):{states:WaterBodyState[];arrivals:WaterFlightArrival[][];contacts:WaterFlightContact[][]} {
  const states=layers.map(l=>l.state),arrivals=layers.map(()=>[] as WaterFlightArrival[]),contacts=layers.map(()=>[] as WaterFlightContact[]);
  if(!states.some(s=>s.flights?.some(f=>f.destination)))return{states,arrivals,contacts};
  const now=states[0].time;if(states.some(s=>s.time!==now))throw new Error('Water connection flight clocks differ');
  const cells=layers.map(l=>waterBodyCells(l.water,l.state)),owned=new Set<number>(),depthImpulses=layers.map(()=>[] as WaterBodyDepthCurrentImpulse[]),solidCollision=obstacles?prepareWaterFlightSolidCollision(obstacles):undefined;
  const edit=(k:number)=>{if(!owned.has(k)){states[k]=copy(states[k]);cells[k]=waterBodyCells(layers[k].water,states[k]);owned.add(k);}return states[k];};
  for(let from=0;from<layers.length;from++){
    const active=states[from].flights?.filter(f=>f.destination);if(!active?.length)continue;
    const w=layers[from].water,result=advanceWaterBodyFlights({flights:active,respond,fromTime:Math.max(0,now-dt),toTime:now,gravity:-w.liquid.gravity.y,maxDistance:Math.min(...layers.flatMap(l=>[l.water.cellSizeX,l.water.cellSizeZ]))*.25,
      ...(obstacles||bounds?{collide:(start:Parameters<typeof waterFlightSolidCollision>[1],end:Parameters<typeof waterFlightSolidCollision>[2],time:number,fromTime:number)=>{
        const solid=solidCollision?.(start,end,time,fromTime),wall=bounds?waterFlightDomainCollision(bounds,start,end):undefined;
        if(!solid)return wall;if(!wall)return solid;const distance=(p:typeof start)=>(p.x-start.x)**2+(p.y-start.y)**2+(p.z-start.z)**2;return distance(solid.point)<=distance(wall.point)?solid:wall;}}:{}),
      surface:(point,previous)=>{let hit:ReturnType<Parameters<typeof advanceWaterBodyFlights>[0]['surface']>;
        for(let k=0;k<layers.length;k++){const c=cells[k],i=c.locate(point);if(i===undefined)continue;const r=c.region(i);if(r?.supportId==='')continue;
          const bed=c.bedAt(i,point.x,point.z),height=Math.max(bed,c.level(i));if(bed>previous.y+1e-7||height>(r?.ceiling??Infinity)-1e-7)continue;
          if(!hit||height>hit.height)hit={height,destination:layers[k].water.revision,region:i};}
        return hit;}});
    if(bounds&&result.flights.some(f=>waterFlightPoint(f,now-f.time,-w.liquid.gravity.y).y<bounds.min.y-1e-7))throw new Error('Water flight reached the closed domain bottom without a supported receiving surface; add a physical floor support');
    contacts[from].push(...result.contacts);const source=edit(from);source.flights=[...(source.flights?.filter(f=>!f.destination)??[]),...result.flights];
    for(const arrival of result.arrivals){const to=layers.findIndex(l=>l.water.revision===arrival.surface.destination);if(to<0)throw new Error('Water flight receiver is unavailable');
      const target=edit(to),c=cells[to],i=arrival.surface.region,old=c.volume(i),v=arrival.flight.volume,total=old+v;
      c.flowX[i]=(old*c.flowX[i]+v*arrival.velocity.x)/total;c.flowZ[i]=(old*c.flowZ[i]+v*arrival.velocity.z)/total;c.setVolume(i,total);c.wake(i);
      if(from!==to){source.externalRemovedVolume+=v;target.externalAddedVolume+=v;}
      const depth=Math.max(0,c.level(i)-c.bed(i)),point={...arrival.position,y:c.level(i)-Math.min(depth*.5,.001)};
      if(depth>0&&arrival.velocity.y)depthImpulses[to].push({point,radius:Math.max(.01,Math.sqrt(c.area(i))*.5),impulse:{x:0,y:v*layers[to].water.liquid.restDensity*arrival.velocity.y,z:0},energy:.5*layers[to].water.liquid.restDensity*v*arrival.velocity.y**2});
      arrivals[to].push(arrival);
    }
  }
  // All accepted arrivals belong to this tick. Prepare the final receiving
  // topology once: repeatedly remapping it for every parcel both dominates
  // cost and numerically damps earlier parcels' circulation. The existing
  // batch operator retains each impulse's individual energy allowance.
  for(const k of owned){cells[k].commit();const impulses=depthImpulses[k];for(let i=0;i<impulses.length;i+=8192)addWaterBodyDepthImpulses(layers[k].water,states[k],impulses.slice(i,i+8192));validateWaterBodyState(layers[k].water,states[k]);}
  return{states,arrivals,contacts};
}
