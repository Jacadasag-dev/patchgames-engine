import {validateWaterBodyState,type WaterBodyManifest,type WaterBodyState} from './waterBody.ts';
import type {PhysicsVector,PhysicsScene,PhysicsCompoundBody} from './physics.ts';
import {addWaterBodyDepthImpulse,cloneWaterBodyDepthCurrents,stepWaterBodyDepthCurrents,projectWaterBodyDepthCurrents} from './waterBodyDepthCurrents.ts';
import {waterBodyGeometry,type WaterBodyGeometry} from './waterBodyGrid.ts';
import {waterBodyCells,type WaterBodyCells} from './waterBodyCells.ts';
import {cloneBoundaryState} from './waterBoundary.ts';

export const WATER_BODY_PIPE_LIMITS={pipes:32,portCells:256,catchmentCells:1024,segments:256,segmentsPerPipe:64} as const;
export interface WaterBodyPipePort {
  /** World opening elevation. */
  point:PhysicsVector;
  radius:number;
}
export interface WaterBodyPipe {
  id:string;from:WaterBodyPipePort;to:WaterBodyPipePort;
  diameter:number;length:number;
  /** Finite-storage route, initially empty; endpoints match ports. */
  path?:PhysicsVector[];
  /** Default 0.7. */
  dischargeCoefficient?:number;
  /** Darcy factor, default 0.025. */
  frictionFactor?:number;
  /** Default -Y. */
  outletDirection?:PhysicsVector;
  /** Thin films move locally downhill, respecting walls and gravity time. */
  drainage?:{radius:number;filmDepth?:number};
  enabled?:boolean;
}
export interface WaterBodyPipeStats {
  id:string;rate:number;transferredVolume:number;sourceHead:number;targetHead:number;filmMovedVolume:number;
  status:'flowing'|'dry'|'blocked'|'closed'|'retained'|'filling';
  storedVolume?:number;inletRate?:number;
  segments?:{from:PhysicsVector;to:PhysicsVector;volume:number;capacity:number;surface:number;velocity:number}[];
}
export interface WaterBodyPipesState {
  waterRevision:string;configurationRevision:string;revision:number;time:number;
  /** Internal grid/pipe transfers. */
  fromGridVolume:number;toGridVolume:number;
  pipes:{id:string;volumes:number[];velocities:number[]}[];
}
export interface WaterBodyPipesStep {
  water:WaterBodyManifest;state:WaterBodyState;pipes:WaterBodyPipe[];dt:number;pipeState?:WaterBodyPipesState;
  /** Current solids for submerged outlet circulation. WaterSystem supplies these automatically. */scene?:PhysicsScene;bodies?:PhysicsCompoundBody[];
}
export interface WaterBodyPipesResult {
  state:WaterBodyState;pipeState?:WaterBodyPipesState;stats:{pipes:WaterBodyPipeStats[];transferredVolume:number};
}
const finite=(n:number,label:string,min:number,max:number)=>{
  if(!Number.isFinite(n)||n<min||n>max)throw new Error(`Invalid water body pipe ${label}`);
};
function footprint(w:WaterBodyManifest,s:WaterBodyState,port:WaterBodyPipePort,limit:number=WATER_BODY_PIPE_LIMITS.portCells,catchment=false):number[]{
  if(!port?.point)throw new Error('Invalid water body pipe port');
  for(const axis of ['x','y','z'] as const)finite(port.point[axis],'port position',-10000,10000);
  finite(port.radius,'port radius',.01,16);
  if(s.boundary){
    const cells=waterBodyCells(w,s),home=cells.locate(port.point);
    if(home===undefined)throw new Error('Water body pipe port has no grid cells');
    const result=[home],seen=new Set(result),faces=cells.faces(),adjacent=new Map<number,typeof faces>();
    for(const f of faces){if(f.b<0)continue;for(const i of [f.a,f.b]){const list=adjacent.get(i)??[];list.push(f);adjacent.set(i,list);}}
    const head=Math.max(port.point.y,cells.level(home));
    for(let k=0;k<result.length;k++)for(const f of adjacent.get(result[k])??[]){
      const j=f.a===result[k]?f.b:f.a,p=cells.center(j);
      if(seen.has(j)||Math.hypot(p.x-port.point.x,p.z-port.point.z)>port.radius)continue;
      // A drainage catchment includes uphill films even after its inlet is
      // dry. Local routing below still checks downhill drop, receiving head,
      // walls and gravity travel time; an instantaneous inlet head cannot
      // erase the uphill part of that geometric catchment.
      if(catchment?!!f.barrier:Math.min(f.start.bed,f.end.bed)>=head||f.barrier&&port.point.y>=f.barrier.bottom&&port.point.y<f.barrier.top)continue;
      seen.add(j);result.push(j);if(result.length>limit)throw new Error('Water body pipe port cell budget exceeded');
    }
    return result;
  }
  const indices:number[]=[],x0=Math.max(0,Math.floor((port.point.x-port.radius-w.origin.x)/w.cellSizeX)),x1=Math.min(w.columns-1,Math.floor((port.point.x+port.radius-w.origin.x)/w.cellSizeX));
  const z0=Math.max(0,Math.floor((port.point.z-port.radius-w.origin.z)/w.cellSizeZ)),z1=Math.min(w.rows-1,Math.floor((port.point.z+port.radius-w.origin.z)/w.cellSizeZ));
  for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){
    const px=w.origin.x+(x+.5)*w.cellSizeX,pz=w.origin.z+(z+.5)*w.cellSizeZ;
    if(Math.hypot(px-port.point.x,pz-port.point.z)<=port.radius)indices.push(x*w.rows+z);
  }
  if(!indices.length)throw new Error('Water body pipe port has no grid cells');
  if(indices.length>limit)throw new Error('Water body pipe port cell budget exceeded');
  return indices;
}
const copy=(s:WaterBodyState):WaterBodyState=>({...s,revision:s.revision+1,depth:s.depth.slice(),flowX:s.flowX.slice(),flowZ:s.flowZ.slice(),sleeping:s.sleeping.slice(),quietTime:s.quietTime.slice(),...(s.boundary?{boundary:cloneBoundaryState(s.boundary)}:{}),...(s.solidDepth?{solidDepth:s.solidDepth.slice()}:{}),...(s.depthCurrents?{depthCurrents:cloneWaterBodyDepthCurrents(s.depthCurrents)}:{})});
function headForVolume(_s:WaterBodyState,cells:WaterBodyCells,i:number,volume:number){return cells.levelAtVolume(i,volume);}
interface PipeSegment {from:PhysicsVector;to:PhysicsVector;length:number;capacity:number;bottom:number;top:number;fractions:number[]}
const geometryCache=new WeakMap<WaterBodyPipe,{key:string;segments:PipeSegment[]}>();
const hash=(s:string)=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0).toString(16);};
const configuration=(pipes:WaterBodyPipe[])=>hash(JSON.stringify(pipes.filter(p=>p.path).map(({enabled,...p})=>p).sort((a,b)=>a.id.localeCompare(b.id))));
const circleFraction=(u:number)=>u<=-1?0:u>=1?1:(Math.acos(-u)+u*Math.sqrt(1-u*u))/Math.PI;
function segmentsFor(pipe:WaterBodyPipe):PipeSegment[]{
  finite(pipe.diameter,'diameter',.001,8);finite(pipe.length,'length',.001,10000);
  const key=JSON.stringify([pipe.path,pipe.diameter,pipe.length]),cached=geometryCache.get(pipe);if(cached?.key===key)return cached.segments;
  const path=pipe.path!;if(!Array.isArray(path)||path.length<2||path.length>32)throw new Error('Invalid water body pipe route');
  for(const p of path)for(const axis of ['x','y','z'] as const)finite(p[axis],'route coordinate',-10000,10000);
  for(const [actual,port] of [[path[0],pipe.from.point],[path.at(-1)!,pipe.to.point]])if(Math.hypot(actual.x-port.x,actual.y-port.y,actual.z-port.z)>1e-7)throw new Error('Water body pipe route must meet its ports');
  const radius=pipe.diameter/2,area=Math.PI*radius*radius,result:PipeSegment[]=[];let total=0;
  for(let i=1;i<path.length;i++){
    const a=path[i-1],b=path[i],length=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);finite(length,'route segment length',.001,10000);total+=length;
    const divisions=Math.ceil(length/.3),verticalRadius=radius*Math.sqrt(Math.max(0,1-((b.y-a.y)/length)**2));
    if(result.length+divisions>WATER_BODY_PIPE_LIMITS.segmentsPerPipe)throw new Error('Water body pipe segment budget exceeded');
    for(let j=0;j<divisions;j++){
      const lerp=(t:number)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
      const from=lerp(j/divisions),to=lerp((j+1)/divisions),bottom=Math.min(from.y,to.y)-verticalRadius,top=Math.max(from.y,to.y)+verticalRadius;
      const fractions:number[]=[];
      for(let k=0;k<=32;k++){
        if(k===0){fractions.push(0);continue;}if(k===32){fractions.push(1);continue;}
        const h=bottom+(top-bottom)*k/32;
        if(verticalRadius<1e-8){fractions.push((h-bottom)/(top-bottom));continue;}
        let sum=0;for(let q=0;q<=8;q++){const y=from.y+(to.y-from.y)*q/8;sum+=circleFraction((h-y)/verticalRadius)*(q===0||q===8?1:q%2?4:2);}fractions.push(sum/24);
      }
      result.push({from,to,length:length/divisions,capacity:area*length/divisions,bottom,top,fractions});
    }
  }
  if(Math.abs(total-pipe.length)>Math.max(1e-6,total*.001))throw new Error('Water body pipe length does not match its route');
  if(result.length>WATER_BODY_PIPE_LIMITS.segmentsPerPipe)throw new Error('Water body pipe segment budget exceeded');
  geometryCache.set(pipe,{key,segments:result});return result;
}
function surfaceFor(segment:PipeSegment,volume:number){
  if(volume<=0)return segment.bottom;if(volume>=segment.capacity)return segment.top;
  const fraction=volume/segment.capacity;let low=0,high=32;
  while(high-low>1){const mid=(low+high)>>1;if(segment.fractions[mid]<fraction)low=mid;else high=mid;}
  const t=(fraction-segment.fractions[low])/(segment.fractions[high]-segment.fractions[low]);
  return segment.bottom+(segment.top-segment.bottom)*(low+t)/32;
}
export function waterBodyPipesVolume(state:WaterBodyPipesState):number{return state.pipes.reduce((n,p)=>n+p.volumes.reduce((sum,v)=>sum+v,0),0);}
/** Initialize empty pipe routes. */
export function createWaterBodyPipesState(water:WaterBodyManifest,pipes:WaterBodyPipe[]):WaterBodyPipesState {
  const state:WaterBodyPipesState={waterRevision:water.revision,configurationRevision:configuration(pipes),revision:0,time:0,fromGridVolume:0,toGridVolume:0,
    pipes:pipes.filter(p=>p.path).sort((a,b)=>a.id.localeCompare(b.id)).map(p=>{const segments=segmentsFor(p);return{id:p.id,volumes:segments.map(()=>0),velocities:Array(segments.length+1).fill(0)};})};
  validateWaterBodyPipesState(water,pipes,state);return state;
}
export function validateWaterBodyPipesState(water:WaterBodyManifest,pipes:WaterBodyPipe[],state:WaterBodyPipesState):void {
  if(!state||state.waterRevision!==water.revision||state.configurationRevision!==configuration(pipes))throw new Error('Water body pipe state revision mismatch');
  finite(state.revision,'state revision',0,Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(state.revision))throw new Error('Invalid water body pipe state revision');
  finite(state.time,'state time',0,1e9);finite(state.fromGridVolume,'ingress ledger',0,1e9);finite(state.toGridVolume,'egress ledger',0,1e9);
  const routed=pipes.filter(p=>p.path).sort((a,b)=>a.id.localeCompare(b.id));
  if(!Array.isArray(state.pipes)||state.pipes.length!==routed.length)throw new Error('Water body pipe state size mismatch');let count=0;
  for(let i=0;i<routed.length;i++){
    const p=state.pipes[i],segments=segmentsFor(routed[i]);count+=segments.length;
    if(p.id!==routed[i].id||p.volumes.length!==segments.length||p.velocities.length!==segments.length+1)throw new Error('Water body pipe state segment mismatch');
    p.volumes.forEach((v,j)=>finite(v,'stored volume',0,segments[j].capacity+1e-10));p.velocities.forEach(v=>finite(v,'face velocity',-100,100));
  }
  if(count>WATER_BODY_PIPE_LIMITS.segments)throw new Error('Water body pipe total segment budget exceeded');
  if(Math.abs(waterBodyPipesVolume(state)-(state.fromGridVolume-state.toGridVolume))>Math.max(1e-9,state.fromGridVolume*1e-9))throw new Error('Water body pipe volume ledger is inconsistent');
}
function routeFilm(w:WaterBodyManifest,s:WaterBodyState,pipe:WaterBodyPipe,catchment:number[],port:number[],dt:number,moved:Set<number>){
  const cells=waterBodyCells(w,s),allowed=new Set(catchment),outlet=new Set(port),limit=pipe.drainage!.filmDepth??.001;
  const transfers:{from:number;to:number;volume:number;vx:number;vz:number}[]=[],reserved=new Map<number,number>();
  const adjacent=new Map<number,ReturnType<WaterBodyCells['faces']>>();
  for(const face of cells.faces())if(face.b>=0)for(const i of [face.a,face.b]){const list=adjacent.get(i)??[];list.push(face);adjacent.set(i,list);}
  for(const i of catchment){
    if(outlet.has(i)||moved.has(i)||cells.depth(i)<=0||cells.depth(i)>limit)continue;
    const p=cells.center(i),distance=Math.hypot(p.x-pipe.from.point.x,p.z-pipe.from.point.z),ownBed=cells.bed(i)+cells.solidDepth[i];
    let selected=-1,bestDrop=0;
    for(const face of adjacent.get(i)??[]){
      const j=face.a===i?face.b:face.a;if(!allowed.has(j))continue;
      const q=cells.center(j),drop=ownBed-cells.bed(j)-cells.solidDepth[j];
      if(drop<=bestDrop||Math.hypot(q.x-pipe.from.point.x,q.z-pipe.from.point.z)>=distance)continue;
      if(headForVolume(s,cells,j,cells.volume(j)+(reserved.get(j)??0)+cells.volume(i))>ownBed)continue;
      const barrier=face.barrier;
      if(barrier&&(!Number.isFinite(barrier.top)||!Number.isFinite(barrier.bottom)||barrier.bottom<cells.level(i)&&barrier.top>=cells.bed(j)))continue;
      if(Math.min(face.start.bed,face.end.bed)>cells.level(i))continue;
      selected=j;bestDrop=drop;
    }
    if(selected<0)continue;
    const q=cells.center(selected),distanceXZ=Math.hypot(q.x-p.x,q.z-p.z),gravity=-w.liquid.gravity.y;
    const travel=Math.sqrt(2*(distanceXZ**2+bestDrop**2)/(gravity*bestDrop));
    if(Math.floor((s.time+1e-10)/travel)===Math.floor((Math.max(0,s.time-dt)+1e-10)/travel))continue;
    const speed=Math.min(w.maxFlowSpeed,Math.sqrt(2*gravity*bestDrop)),volume=cells.volume(i);
    transfers.push({from:i,to:selected,volume,vx:(q.x-p.x)/distanceXZ*speed,vz:(q.z-p.z)/distanceXZ*speed});
    reserved.set(selected,(reserved.get(selected)??0)+volume);
  }
  if(!transfers.length)return{state:s,volume:0};
  const state=copy(s),next=waterBodyCells(w,state),incoming=new Map<number,{volume:number;mx:number;mz:number}>();let volume=0;
  for(const t of transfers){
    next.setVolume(t.from,0);next.flowX[t.from]=0;next.flowZ[t.from]=0;moved.add(t.from);moved.add(t.to);next.wake(t.from);
    const old=incoming.get(t.to)??{volume:0,mx:0,mz:0};old.volume+=t.volume;old.mx+=t.volume*t.vx;old.mz+=t.volume*t.vz;incoming.set(t.to,old);volume+=t.volume;
  }
  for(const [i,added] of incoming){const old=next.volume(i),total=old+added.volume;
    next.flowX[i]=(old*next.flowX[i]+added.mx)/total;next.flowZ[i]=(old*next.flowZ[i]+added.mz)/total;next.setVolume(i,total);next.wake(i);}
  next.commit();return{state,volume};
}
function portAvailable(w:WaterBodyManifest,s:WaterBodyState,indices:number[],port:WaterBodyPipePort){const cells=waterBodyCells(w,s);return indices.reduce((n,i)=>n+Math.max(0,cells.volume(i)-cells.capacityAtHead(i,port.point.y)),0);}
function takeGrid(w:WaterBodyManifest,s:WaterBodyState,indices:number[],port:WaterBodyPipePort,volume:number){
  const cells=waterBodyCells(w,s),amounts=indices.map(i=>Math.max(0,cells.volume(i)-cells.capacityAtHead(i,port.point.y))),total=amounts.reduce((a,b)=>a+b,0),fraction=Math.min(1,volume/Math.max(total,1e-30));let removed=0;
  for(let j=0;j<indices.length;j++)if(amounts[j]>0){const i=indices[j],amount=amounts[j]*fraction;cells.setVolume(i,Math.max(0,cells.volume(i)-amount));removed+=amount;cells.wake(i);if(!cells.volume(i)){cells.flowX[i]=0;cells.flowZ[i]=0;}}
  cells.commit();s.externalRemovedVolume+=removed;return removed;
}
function outletCurrent(w:WaterBodyManifest,s:WaterBodyState,indices:number[],volume:number,velocity:PhysicsVector,port:WaterBodyPipePort,geometry?:WaterBodyGeometry,energy?:number){
  if(volume>0&&velocity.y){const cells=waterBodyCells(w,s),i=indices.reduce((best,j)=>cells.depth(j)>cells.depth(best)?j:best),surface=cells.level(i);
    addWaterBodyDepthImpulse(w,s,{point:{...port.point,y:Math.max(cells.bed(i)+.001,Math.min(surface-.001,port.point.y))},radius:port.radius,
      impulse:{x:0,y:w.liquid.restDensity*volume*velocity.y,z:0},energy:energy??.5*w.liquid.restDensity*volume*velocity.y**2,deferProjection:true},geometry);
  }
}
function giveGrid(w:WaterBodyManifest,s:WaterBodyState,indices:number[],volume:number,velocity:PhysicsVector){
  const cells=waterBodyCells(w,s),area=indices.reduce((sum,i)=>sum+cells.area(i),0);
  for(const i of indices){const share=volume*cells.area(i)/area,old=cells.volume(i),total=old+share;if(!total)continue;
    cells.flowX[i]=(old*cells.flowX[i]+share*velocity.x)/total;cells.flowZ[i]=(old*cells.flowZ[i]+share*velocity.z)/total;cells.setVolume(i,total);cells.wake(i);}
  cells.commit();s.externalAddedVolume+=volume;
}
function stepRouted(w:WaterBodyManifest,s:WaterBodyState,pipe:WaterBodyPipe,from:number[],to:number[],runtime:WaterBodyPipesState,dt:number,filmMovedVolume:number,geometry?:WaterBodyGeometry):WaterBodyPipeStats {
  const segments=segmentsFor(pipe),record=runtime.pipes.find(p=>p.id===pipe.id)!,count=segments.length,area=Math.PI*pipe.diameter**2/4,g=-w.liquid.gravity.y;
  let inlet=0,outlet=0,remaining=dt,substeps=0,maxRate=0,sourceHead=pipe.from.point.y,targetHead=pipe.to.point.y;
  let jetVolume=0,jetMomentum=0,jetEnergy=0;
  while(remaining>1e-10){
    const speed=Math.max(...record.velocities.map(Math.abs),Math.sqrt(g*pipe.diameter));
    const sub=Math.min(remaining,.3*Math.min(...segments.map(p=>p.length))/(speed+Math.sqrt(g*pipe.diameter)));
    if(++substeps>64)throw new Error('Water body pipe flow budget exceeded');
    const sourceAvailable=portAvailable(w,s,from,pipe.from),receiverAvailable=portAvailable(w,s,to,pipe.to);
    const grid=waterBodyCells(w,s);
    sourceHead=sourceAvailable>0?Math.max(...from.map(i=>grid.level(i))):Math.max(pipe.from.point.y,...from.map(i=>grid.bed(i)+grid.solidDepth[i]));
    targetHead=Math.max(pipe.to.point.y,...to.map(i=>grid.level(i)));
    const heads=segments.map((cell,i)=>surfaceFor(cell,record.volumes[i]));
    // Full sections transmit pressure from neighboring free surfaces. They
    // retain their finite volume; pressure is not represented as extra water.
    for(let i=0;i<count;i++)if(record.volumes[i]>=segments[i].capacity*(1-1e-8)){
      const first=i;while(i+1<count&&record.volumes[i+1]>=segments[i+1].capacity*(1-1e-8))i++;const last=i;
      const left=first?heads[first-1]:sourceHead,right=last+1<count?heads[last+1]:targetHead;
      const length=segments.slice(first,last+1).reduce((n,p)=>n+p.length,0)+(first?segments[first-1].length:segments[first].length)/2+(last+1<count?segments[last+1].length:segments[last].length)/2;
      let distance=(first?segments[first-1].length:segments[first].length)/2;
      for(let j=first;j<=last;j++){distance+=segments[j].length/2;heads[j]=Math.max(segments[j].top,left+(right-left)*distance/length);distance+=segments[j].length/2;}
    }
    const flows=Array(count+1).fill(0),wetFaces=Array(count+1).fill(0);
    for(let face=0;face<=count;face++){
      const left=face?heads[face-1]:sourceHead,right=face<count?heads[face]:targetHead,distance=(face?segments[face-1].length:0)/2+(face<count?segments[face].length:0)/2;
      let velocity=record.velocities[face]+g*(left-right)/distance*sub;
      const friction=(pipe.frictionFactor??.025)/(2*pipe.diameter)+(face===0||face===count?(1/(pipe.dischargeCoefficient??.7)**2-1)/(2*Math.max(distance,.01)):0);
      velocity/=1+friction*Math.abs(velocity)*sub;
      // Small residual velocities decay at hydrostatic equilibrium; this is
      // unresolved viscosity, not an imposed draining animation.
      velocity*=Math.exp(-.35*sub);velocity=Math.max(-w.maxFlowSpeed,Math.min(w.maxFlowSpeed,velocity));
      if(pipe.enabled===false&&face===0)velocity=0;
      const donor=velocity>=0?face-1:face,wet=donor<0?sourceAvailable>0?1:0:donor>=count?receiverAvailable>0?1:0:Math.min(1,record.volumes[donor]/segments[donor].capacity);
      flows[face]=velocity*area*wet*sub;wetFaces[face]=wet;record.velocities[face]=wet?velocity:0;
    }
    flows[0]=Math.max(-segments[0].capacity,Math.min(sourceAvailable,flows[0]));flows[count]=Math.max(-receiverAvailable,flows[count]);
    // Limit outgoing mass, then propagate finite receiving-space constraints
    // along the chain. A full segment can pass its departing volume onward.
    for(let i=0;i<count;i++){
      const outgoing=Math.max(0,-flows[i])+Math.max(0,flows[i+1]);
      if(outgoing>record.volumes[i]){const scale=record.volumes[i]/outgoing;if(flows[i]<0)flows[i]*=scale;if(flows[i+1]>0)flows[i+1]*=scale;}
    }
    for(let pass=0;pass<=count;pass++){
      let changed=false;
      for(let i=0;i<count;i++){
        const incoming=Math.max(0,flows[i])+Math.max(0,-flows[i+1]),outgoing=Math.max(0,-flows[i])+Math.max(0,flows[i+1]);
        const room=Math.max(0,segments[i].capacity-record.volumes[i]+outgoing);
        if(incoming>room+1e-15){const scale=room/incoming;if(flows[i]>0)flows[i]*=scale;if(flows[i+1]<0)flows[i+1]*=scale;changed=true;}
      }
      if(!changed)break;
    }
    if(flows[0]>0){flows[0]=takeGrid(w,s,from,pipe.from,flows[0]);runtime.fromGridVolume+=flows[0];}
    else if(flows[0]<0){giveGrid(w,s,from,-flows[0],{x:0,y:0,z:0});runtime.toGridVolume-=flows[0];}
    if(flows[count]<0){const taken=takeGrid(w,s,to,pipe.to,-flows[count]);flows[count]=-taken;runtime.fromGridVolume+=taken;}
    else if(flows[count]>0){const direction=pipe.outletDirection??{x:0,y:-1,z:0},length=Math.hypot(direction.x,direction.y,direction.z),speed=flows[count]/(sub*area);
      const vy=direction.y/length*speed;
      giveGrid(w,s,to,flows[count],{x:direction.x/length*speed,y:vy,z:direction.z/length*speed});runtime.toGridVolume+=flows[count];
      jetVolume+=flows[count];jetMomentum+=flows[count]*vy;jetEnergy+=.5*w.liquid.restDensity*flows[count]*vy*vy;}
    for(let i=0;i<count;i++){const value=record.volumes[i]+flows[i]-flows[i+1];record.volumes[i]=Math.max(0,Math.min(segments[i].capacity,value));}
    for(let face=0;face<=count;face++){record.velocities[face]=wetFaces[face]>1e-12?flows[face]/(sub*area*wetFaces[face]):0;maxRate=Math.max(maxRate,Math.abs(flows[face]/sub));}
    inlet+=flows[0];outlet+=flows[count];remaining-=sub;
  }
  // One submerged impulse per outlet, independent of hydraulic substep count.
  if(jetVolume)outletCurrent(w,s,to,jetVolume,{x:0,y:jetMomentum/jetVolume,z:0},pipe.to,geometry,jetEnergy);
  const stored=record.volumes.reduce((n,v)=>n+v,0),active=maxRate>area*.001;
  return{id:pipe.id,rate:outlet/dt,inletRate:inlet/dt,transferredVolume:outlet,sourceHead,targetHead,filmMovedVolume,storedVolume:stored,
    status:pipe.enabled===false?'closed':active?Math.abs(outlet)>1e-9?'flowing':'filling':stored>1e-9?'retained':'dry',
    segments:segments.map((cell,i)=>({from:cell.from,to:cell.to,volume:record.volumes[i],capacity:cell.capacity,surface:surfaceFor(cell,record.volumes[i]),velocity:(record.velocities[i]+record.velocities[i+1])/2}))};
}

/** Advance pipe storage/gravity/backwater after the fluid tick. No path uses
 * the legacy immediate connector. Grid time is unchanged; no air simulation. */
export function stepWaterBodyPipes({water:w,state:previous,pipes,dt,pipeState:previousPipes,scene,bodies=[]}:WaterBodyPipesStep):WaterBodyPipesResult {
  validateWaterBodyState(w,previous);finite(dt,'step time',1e-5,.05);
  if(!Array.isArray(pipes)||pipes.length>WATER_BODY_PIPE_LIMITS.pipes)throw new Error('Water body pipe budget exceeded');
  if(pipes.some(p=>p.path)&&!previousPipes)throw new Error('Routed water body pipes require stored pipe state');
  if(previousPipes)validateWaterBodyPipesState(w,pipes,previousPipes);
  const geometry=scene&&w.currents!==false&&w.depthCurrents!==false?waterBodyGeometry(w,scene,bodies):undefined;
  const pipeState=previousPipes?{...previousPipes,revision:previousPipes.revision+1,time:previous.time,pipes:previousPipes.pipes.map(p=>({...p,volumes:p.volumes.slice(),velocities:p.velocities.slice()}))}:undefined;
  const ids=new Set<string>();
  const prepared=pipes.map(pipe=>{
    if(!pipe||typeof pipe.id!=='string'||!pipe.id.length||pipe.id.length>128||ids.has(pipe.id))throw new Error('Invalid water body pipe id');
    ids.add(pipe.id);finite(pipe.diameter,'diameter',.001,8);finite(pipe.length,'length',.001,10000);
    finite(pipe.dischargeCoefficient??.7,'discharge coefficient',.001,1);finite(pipe.frictionFactor??.025,'friction factor',0,1);
    if(pipe.enabled!==undefined&&typeof pipe.enabled!=='boolean')throw new Error('Invalid water body pipe enabled flag');
    if(pipe.path)segmentsFor(pipe);
    const from=footprint(w,previous,pipe.from),to=footprint(w,previous,pipe.to),target=new Set(to);
    if(from.some(i=>target.has(i)))throw new Error('Water body pipe ports overlap');
    const direction=pipe.outletDirection??{x:0,y:-1,z:0};for(const axis of ['x','y','z'] as const)finite(direction[axis],'outlet direction',-10000,10000);
    const magnitude=Math.hypot(direction.x,direction.y,direction.z);if(magnitude<1e-9)throw new Error('Invalid water body pipe outlet direction');
    let catchment:number[]=[];
    if(pipe.drainage){finite(pipe.drainage.radius,'drainage radius',pipe.from.radius,16);finite(pipe.drainage.filmDepth??.001,'film depth',1e-8,.002);
      catchment=footprint(w,previous,{point:pipe.from.point,radius:pipe.drainage.radius},WATER_BODY_PIPE_LIMITS.catchmentCells,true);}
    return{pipe,from,to,catchment,direction:{x:direction.x/magnitude,y:direction.y/magnitude,z:direction.z/magnitude}};
  }).sort((a,b)=>a.pipe.id.localeCompare(b.pipe.id));
  let state=previous,transferredVolume=0;const reports:WaterBodyPipeStats[]=[],filmMoved=new Set<number>();
  for(const {pipe,from,to,direction,catchment} of prepared){
    const film=pipe.drainage&&pipe.enabled!==false?routeFilm(w,state,pipe,catchment,from,dt,filmMoved):{state,volume:0};state=film.state;
    if(pipe.path){
      if(state===previous)state=copy(previous);
      const report=stepRouted(w,state,pipe,from,to,pipeState!,dt,film.volume,geometry);reports.push(report);transferredVolume+=report.transferredVolume;continue;
    }
    // The footprint is one authored opening. Its highest pressure controls
    // the connection, preventing uniform deposition into an uphill wet cell.
    let grid=waterBodyCells(w,state);
    const receivingSurface=Math.max(...to.map(i=>grid.level(i))),receivingArea=to.reduce((sum,i)=>sum+grid.area(i),0);
    const targetHead=Math.max(pipe.to.point.y,receivingSurface);
    const donors=from.filter(i=>grid.volume(i)>0&&grid.level(i)>pipe.from.point.y);
    const sourceHead=donors.length?donors.reduce((n,i)=>n+grid.level(i),0)/donors.length:pipe.from.point.y;
    const report:WaterBodyPipeStats={id:pipe.id,rate:0,transferredVolume:0,sourceHead,targetHead,filmMovedVolume:film.volume,status:pipe.enabled===false?'closed':donors.length?'blocked':'dry'};reports.push(report);
    if(pipe.enabled===false||!donors.length||sourceHead<=targetHead)continue;
    const area=Math.PI*pipe.diameter**2/4,loss=1+(pipe.frictionFactor??.025)*pipe.length/pipe.diameter;
    const speed=(pipe.dischargeCoefficient??.7)*Math.sqrt(2*-w.liquid.gravity.y*(sourceHead-targetHead)/loss);
    const receivingHeadAt=(volume:number)=>Math.max(pipe.to.point.y,...to.map(i=>headForVolume(state,grid,i,grid.volume(i)+volume*grid.area(i)/receivingArea)));
    const availableAt=(volume:number)=>donors.reduce((n,i)=>n+Math.max(0,grid.volume(i)-grid.capacityAtHead(i,Math.max(pipe.from.point.y,receivingHeadAt(volume)))),0);
    let amount=Math.min(area*speed*dt,availableAt(0));
    if(amount>availableAt(amount)){let low=0,high=amount;for(let j=0;j<36;j++){const mid=(low+high)/2;if(mid<=availableAt(mid))low=mid;else high=mid;}amount=low;}
    if(amount<=0)continue;
    if(state===previous)state=copy(previous);grid=waterBodyCells(w,state);
    const limitingHead=Math.max(pipe.from.point.y,receivingHeadAt(amount));
    const capacities=donors.map(i=>Math.max(0,grid.volume(i)-grid.capacityAtHead(i,limitingHead)));
    const takeAt=(i:number,capacity:number,drop:number)=>Math.min(capacity,Math.max(0,grid.volume(i)-grid.capacityAtHead(i,grid.level(i)-drop)));
    let low=0,high=Math.max(...donors.map(i=>grid.level(i)-grid.bed(i)));
    for(let j=0;j<36;j++){const mid=(low+high)/2,sum=donors.reduce((n,i,k)=>n+takeAt(i,capacities[k],mid),0);if(sum<amount)low=mid;else high=mid;}
    const drainAll=amount>=capacities.reduce((n,v)=>n+v,0);let removed=0;
    for(let j=0;j<donors.length;j++){
      const i=donors[j],take=drainAll?capacities[j]:Math.min(takeAt(i,capacities[j],high),amount-removed);
      if(take<=0)continue;grid.setVolume(i,Math.max(0,grid.volume(i)-take));removed+=take;
      if(grid.volume(i)===0){grid.flowX[i]=0;grid.flowZ[i]=0;}grid.wake(i);
    }
    const exitSpeed=Math.min(w.maxFlowSpeed,removed/(dt*area));
    for(const i of to){
      const existing=grid.volume(i),share=removed*grid.area(i)/receivingArea,total=existing+share;
      grid.flowX[i]=(existing*grid.flowX[i]+share*exitSpeed*direction.x)/total;
      grid.flowZ[i]=(existing*grid.flowZ[i]+share*exitSpeed*direction.z)/total;
      grid.setVolume(i,total);grid.wake(i);
    }
    grid.commit();
    outletCurrent(w,state,to,removed,{x:exitSpeed*direction.x,y:exitSpeed*direction.y,z:exitSpeed*direction.z},pipe.to,geometry);
    report.rate=removed/dt;report.transferredVolume=removed;report.status='flowing';transferredVolume+=removed;
  }
  // Project all outlet/substep impulses together, without advancing the clock
  // or dissipating twice after the main water tick.
  if(state!==previous&&state.depthCurrents){if(geometry)stepWaterBodyDepthCurrents(w,state,0,geometry);else projectWaterBodyDepthCurrents(w,state);}
  validateWaterBodyState(w,state);if(pipeState)validateWaterBodyPipesState(w,pipes,pipeState);return{state,...(pipeState?{pipeState}:{}),stats:{pipes:reports,transferredVolume}};
}
