/** Cosmetic outlet envelopes around accepted airborne water. Short numerical
 * pulses are filtered, while source-off gaps over75ms remain separate and
 * physical leading/trailing positions never extend. Geometry does not write liquid volume or advance flight. */
import type {WaterBodyFlight} from './waterBodyFlights.ts';
import type {PhysicsVector} from './physics.ts';
import {waterFlightJunction,type WaterFlightJunctionVertex} from './waterFlightJunction.ts';

type P=PhysicsVector;
export const WATER_FLIGHT_RING_SIDES=12;
/** Cosmetic filtering never extends an episode's leading/trailing end. */
export const WATER_FLIGHT_PULSE_SMOOTHING=.075;
export interface WaterFlightSection {center:P;across:P;normal:P;halfWidth:number;halfDepth:number;speed:number;sourceDepth:number}
export interface WaterFlightPath {id:string;sections:WaterFlightSection[];volume:number;start:number;end:number;attached?:true;family?:string;startJoins?:[number,number][];endJoins?:[number,number][];startJoinIds?:string[];endJoinIds?:string[]}
export interface WaterFlightMesh {positions:Float32Array;normals:Float32Array;uvs:Float32Array;activity:Float32Array;optics:Float32Array;openings:number;paths:WaterFlightPath[]}
export type WaterFlightSourceSample=number|{height:number;normal:P;tone?:number};
export type WaterFlightSourceSurface=(point:P,flow:P)=>WaterFlightSourceSample|undefined;
export interface WaterFlightSourceEndpoint {point:P;flow:P;maxOffset:number}
/** A bounded path on the accepted wet surface. Missing coverage rejects a join. */
export type WaterFlightSourceConnection=((a:WaterFlightSourceEndpoint,b:WaterFlightSourceEndpoint)=>P[]|undefined)&{readonly maxDistance?:number};
const add=(a:P,b:P,t=1):P=>({x:a.x+b.x*t,y:a.y+b.y*t,z:a.z+b.z*t});
const sub=(a:P,b:P):P=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const cross=(a:P,b:P):P=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const length=(a:P)=>Math.hypot(a.x,a.y,a.z);
const unit=(a:P):P=>{const n=length(a);return n>0?{x:a.x/n,y:a.y/n,z:a.z/n}:{x:0,y:1,z:0};};
const mix=(a:P,b:P,t:number):P=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
const midpoint=(a:P,b:P)=>mix(a,b,.5);
const scalar=(a:number,b:number,t:number)=>a+(b-a)*t;
function blend(a:WaterFlightSection,b:WaterFlightSection,t:number):WaterFlightSection {
  const across=unit(mix(a.across,b.across,t)),raw=mix(a.normal,b.normal,t),normal=unit(sub(raw,{x:across.x*(raw.x*across.x+raw.y*across.y+raw.z*across.z),y:across.y*(raw.x*across.x+raw.y*across.y+raw.z*across.z),z:across.z*(raw.x*across.x+raw.y*across.y+raw.z*across.z)}));
  const halfWidth=scalar(a.halfWidth,b.halfWidth,t),speed=scalar(a.speed,b.speed,t),flux=scalar(a.halfWidth*a.halfDepth*a.speed,b.halfWidth*b.halfDepth*b.speed,t);
  return{center:mix(a.center,b.center,t),across,normal,halfWidth,halfDepth:flux/Math.max(1e-24,halfWidth*speed),speed,sourceDepth:scalar(a.sourceDepth,b.sourceDepth,t)};
}
function section(f:WaterBodyFlight,age:number,gravity:number):WaterFlightSection {
  const origin=midpoint(f.edge[0],f.edge[1]),center=add(origin,f.velocity,age);center.y-=gravity*age*age*.5;
  const width=length(sub(f.edge[1],f.edge[0])),across=unit(sub(f.edge[1],f.edge[0])),velocity={...f.velocity,y:f.velocity.y-gravity*age},speed=length(velocity);
  let normal=cross(across,velocity);if(length(normal)<1e-12)normal=cross(across,Math.abs(across.y)<.8?{x:0,y:1,z:0}:{x:1,y:0,z:0});normal=unit(normal);
  // Polygonal cross-sectional area is N/2 sin(2pi/N) a*b. Use the
  // accepted discharge and local ballistic speed, with no opaque minimum.
  const halfWidth=width*.5,area=f.volume/f.duration/Math.max(speed,1e-9),factor=WATER_FLIGHT_RING_SIDES*.5*Math.sin(2*Math.PI/WATER_FLIGHT_RING_SIDES);
  const halfDepth=Math.min(Math.max(halfWidth,f.sourceDepth*.5),area/(factor*Math.max(halfWidth,1e-12)));
  return{center,across,normal,halfWidth,halfDepth,speed,sourceDepth:f.sourceDepth};
}
function packetSections(f:WaterBodyFlight,now:number,gravity:number):WaterFlightSection[] {
  const age=Math.max(0,now-f.time),front=f.emittedTime===undefined?age+f.duration*.5:age,trail=Math.max(0,age-f.duration*.5),a=section(f,trail,gravity),b=section(f,front,gravity);
  const steps=Math.max(1,Math.min(32,Math.ceil(length(sub(a.center,b.center))/.08))),result:WaterFlightSection[]=[];
  for(let i=0;i<=steps;i++)result.push(i===0?a:i===steps?b:section(f,trail+(front-trail)*i/steps,gravity));return result;
}
function distance(a:WaterFlightSection,b:WaterFlightSection):number{return length(sub(a.center,b.center));}
function resample(rows:WaterFlightSection[],segments:number):WaterFlightSection[] {
  const cumulative=[0];for(let i=1;i<rows.length;i++)cumulative.push(cumulative[i-1]+distance(rows[i-1],rows[i]));const total=cumulative[cumulative.length-1],result=[rows[0]];let at=1;
  for(let i=1;i<segments;i++){const target=total*i/segments;while(at<cumulative.length-1&&cumulative[at]<target)at++;const span=cumulative[at]-cumulative[at-1];result.push(blend(rows[at-1],rows[at],span>0?(target-cumulative[at-1])/span:0));}result.push(rows[rows.length-1]);return result;
}
function clippedRing(poly:WaterFlightJunctionVertex[],axis:P,lo:number,hi:number):WaterFlightJunctionVertex[] {
  const projection=(p:P)=>p.x*axis.x+p.y*axis.y+p.z*axis.z;
  const clip=(poly:WaterFlightJunctionVertex[],at:number,above:boolean)=>{const out:typeof poly=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],da=projection(a.p)-at,db=projection(b.p)-at,inside=above?da>=0:da<=0,next=above?db>=0:db<=0;if(inside)out.push(a);if(inside!==next){const t=da/(da-db);out.push({p:mix(a.p,b.p,t),n:mix(a.n,b.n,t),u:scalar(a.u,b.u,t),tone:scalar(a.tone,b.tone,t)});}}return out;};
  return clip(clip(poly,lo,true),hi,false);
}

interface Outlet {id:string;records:WaterBodyFlight[];volume:number;edge:WaterBodyFlight['edge'];start:number;end:number;episodes:{start:number;end:number}[];family?:string;startJoins?:string[];endJoins?:string[]}
const startOf=(f:WaterBodyFlight)=>(f.emittedTime??f.time)-f.duration*.5;
const endOf=(f:WaterBodyFlight)=>(f.emittedTime??f.time)+f.duration*.5;
function emissionEpisodes(records:readonly WaterBodyFlight[]):Outlet['episodes'] {
  const episodes:Outlet['episodes']=[];
  for(const f of records){const start=startOf(f),end=endOf(f),last=episodes[episodes.length-1];
    if(!last||last.start-end>WATER_FLIGHT_PULSE_SMOOTHING)episodes.push({start,end});else{last.start=Math.min(last.start,start);last.end=Math.max(last.end,end);}}
  return episodes;
}
function overlappingEpisodes(a:Outlet,b:Outlet):boolean {
  // Arrival removes a different old tail from each adjacent opening. Its full
  // history length cannot determine whether the currently active lip joins.
  // Compare bounded, descending emission episodes instead of matching tails.
  let i=0,j=0;while(i<a.episodes.length&&j<b.episodes.length){const x=a.episodes[i],y=b.episodes[j];
    if(Math.min(x.end,y.end)>Math.max(x.start,y.start))return true;
    if(x.start>=y.end)i++;else j++;}
  return false;
}
function prepareOutlets(flights:readonly WaterBodyFlight[],maxOpenings:number,blocked?: (a:P,b:P)=>boolean,sourceConnected?:WaterFlightSourceConnection):Outlet[] {
  const map=new Map<string,WaterBodyFlight[]>();for(const f of flights){if(!(f.volume>0&&f.duration>0))continue;const key=`${f.id}|${f.destination??''}|${f.emittedTime===undefined?'free':f.time}`;if(!map.has(key))map.set(key,[]);map.get(key)!.push(f);}
  const outlets:Outlet[]=[...map.values()].map(records=>{records.sort((a,b)=>endOf(b)-endOf(a));return{id:records[0].id,records,volume:records.reduce((sum,f)=>sum+f.volume,0),edge:records[0].edge,start:Math.min(...records.map(startOf)),end:Math.max(...records.map(endOf)),episodes:emissionEpisodes(records)};}).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const owner=outlets.map((_,i)=>i),root=(i:number):number=>owner[i]===i?i:owner[i]=root(owner[i]),adjacentTo=outlets.map(()=>new Set<number>());
  // Emission quadrature can move an aperture by at most half its duration's
  // horizontal travel. A wet-source path, not a pressure threshold, proves the join.
  const reach=outlets.map(o=>{const f=o.records[0],scale=Math.max(1,...o.edge.flatMap(p=>[Math.abs(p.x),Math.abs(p.z)]));return .5*f.duration*Math.hypot(f.velocity.x,f.velocity.z)+4*2**-23*scale;});
  const sourceDistance=sourceConnected&&Number.isFinite(sourceConnected.maxDistance)?Math.max(0,sourceConnected.maxDistance!):0;
  const entries=outlets.flatMap((o,i)=>o.edge.map(p=>({i,p,r:sourceConnected?reach[i]+sourceDistance*.5:Math.max(reach[i],length(sub(...o.edge))*.15)}))).map(e=>({...e,low:e.p.x-e.r,high:e.p.x+e.r})).sort((a,b)=>a.low-b.low||a.i-b.i);
  const visited=new Set<string>(),workLimit=Math.max(4096,maxOpenings*maxOpenings*4);let adjacencyWork=0;
  // Spatial sweep avoids all-pairs work, and the fixed budget fails to separate
  // envelopes rather than inventing connections. Group before opening ranking,
  // so a weak middle aperture is not dropped between stronger neighbors.
  for(let at=0;at<entries.length&&adjacencyWork<workLimit;at++)for(let next=at+1;next<entries.length&&entries[next].low<=entries[at].high&&adjacencyWork<workLimit;next++){
    const p=entries[at],q=entries[next];adjacencyWork++;if(p.i===q.i||Math.abs(p.p.z-q.p.z)>p.r+q.r)continue;const i=Math.min(p.i,q.i),j=Math.max(p.i,q.i),key=`${i}:${j}`;if(visited.has(key))continue;visited.add(key);
    const a=outlets[i],b=outlets[j],fa=a.records[0],fb=b.records[0];if(fa.emittedTime!==undefined||fb.emittedTime!==undefined||fa.destination!==fb.destination||!overlappingEpisodes(a,b))continue;
    const aa=unit(sub(a.edge[1],a.edge[0])),bb=unit(sub(b.edge[1],b.edge[0]));if(Math.abs(aa.x*bb.x+aa.z*bb.z)<.999)continue;
    const ca=midpoint(...a.edge),cb=midpoint(...b.edge),widthA=length(sub(...a.edge)),widthB=length(sub(...b.edge)),width=Math.min(widthA,widthB),drift=reach[i]+reach[j];if(Math.abs((ca.x-cb.x)*aa.x+(ca.z-cb.z)*aa.z)<(widthA+widthB)*.5-(sourceConnected?drift:1e-6))continue;let adjacent=false;
    for(const p of a.edge)for(const q of b.edge){const d=sub(p,q),tangent=Math.abs(d.x*aa.x+d.z*aa.z),normal=Math.abs(d.x*aa.z-d.z*aa.x);if(sourceConnected?tangent<=drift&&normal<=drift+sourceDistance:tangent<1e-6&&normal<width*.15&&Math.abs(d.y)<width*.5)adjacent=true;}
    if(!adjacent)continue;const va=fa.velocity,vb=fb.velocity;if(va.x*vb.x+va.z*vb.z<0)continue;
    if(sourceConnected){const path=sourceConnected({point:ca,flow:va,maxOffset:reach[i]},{point:cb,flow:vb,maxOffset:reach[j]});if(!path||path.length<2||path.length>64||path.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(p.z))||blocked&&path.some((p,k)=>blocked(p,p)||k>0&&blocked(path[k-1],p)))continue;}
    else if(blocked&&(blocked(ca,cb)||blocked(midpoint(ca,cb),midpoint(ca,cb))))continue;
    adjacentTo[i].add(j);adjacentTo[j].add(i);const x=root(i),y=root(j);if(x!==y)owner[Math.max(x,y)]=Math.min(x,y);
  }
  const groups=new Map<number,number[]>();for(let i=0;i<outlets.length;i++){const r=root(i);if(!groups.has(r))groups.set(r,[]);groups.get(r)!.push(i);}
  const combine=(indices:number[]):Outlet=>{const first=outlets[indices[0]],records=indices.flatMap(i=>outlets[i].records);return{...first,records,volume:records.reduce((n,f)=>n+f.volume,0),start:Math.min(...indices.map(i=>outlets[i].start)),end:Math.max(...indices.map(i=>outlets[i].end))};};
  let temporalWork=0;
  const split=(indices:number[]):Outlet[]=>{
    const merged=combine(indices);merged.family=merged.id;if(indices.length<3)return[merged];
    const allowed=new Set(indices),events:{time:number;index:number;add:boolean}[]=[];
    for(const index of indices)for(const episode of outlets[index].episodes)events.push({time:episode.start,index,add:true},{time:episode.end,index,add:false});events.sort((a,b)=>a.time-b.time);
    const active=new Set<number>(),spans:{start:number;end:number;members:number[]}[]=[],pending=new Map<string,typeof spans[number]>();let disconnected=false;
    for(let i=0;i<events.length;){const time=events[i].time;do{const e=events[i++];if(e.add)active.add(e.index);else active.delete(e.index);}while(i<events.length&&events[i].time===time);if(i===events.length)break;
      const end=events[i].time,unseen=new Set(active),components:number[][]=[];
      while(unseen.size){const first=unseen.values().next().value!,todo=[first];unseen.delete(first);
        for(let at=0;at<todo.length;at++){if(++temporalWork>workLimit)return indices.map(i=>outlets[i]);for(const neighbor of adjacentTo[todo[at]])if(allowed.has(neighbor)&&unseen.delete(neighbor))todo.push(neighbor);}
        components.push(todo.sort((a,b)=>a-b));}
      if(components.length>1)disconnected=true;
      for(const members of components){const key=members.join(','),prior=pending.get(key);if(prior?.end===time)prior.end=end;else{const span={start:time,end,members};pending.set(key,span);spans.push(span);}}
    }
    if(!disconnected)return[merged];
    // A landed middle tail must not split the still-connected newer lip.
    // Conversely a true middle shutdown leaves separate newer side branches.
    const continues=(index:number,time:number)=>outlets[index].episodes.some(e=>e.start<time&&e.end>time);
    return spans.flatMap(span=>{const part=combine(span.members),records:WaterBodyFlight[]=[];for(const f of part.records){const lo=Math.max(startOf(f),span.start),hi=Math.min(endOf(f),span.end);if(!(hi>lo))continue;records.push({...f,time:(lo+hi)*.5,duration:hi-lo,volume:f.volume*(hi-lo)/f.duration});}
      if(!records.length)return[];return[{...part,family:merged.id,records,start:span.start,end:span.end,volume:records.reduce((n,f)=>n+f.volume,0),startJoins:span.members.filter(i=>continues(i,span.start)).map(i=>outlets[i].id),endJoins:span.members.filter(i=>continues(i,span.end)).map(i=>outlets[i].id)}];});
  };
  return[...groups.values()].map(indices=>({indices,volume:indices.reduce((n,i)=>n+outlets[i].volume,0)})).sort((a,b)=>b.volume-a.volume).slice(0,maxOpenings).flatMap(g=>split(g.indices));
}
function envelope(outlet:Outlet,records:WaterBodyFlight[],now:number,gravity:number):WaterFlightPath|undefined {
  const start=Math.min(...records.map(startOf)),end=Math.max(...records.map(endOf)),sources=new Map<string,WaterBodyFlight[]>();for(const f of records){if(!sources.has(f.id))sources.set(f.id,[]);sources.get(f.id)!.push(f);}for(const list of sources.values())list.sort((a,b)=>a.time-b.time);
  const axis=unit(sub(outlet.edge[1],outlet.edge[0])),factor=WATER_FLIGHT_RING_SIDES*.5*Math.sin(2*Math.PI/WATER_FLIGHT_RING_SIDES);
  const row=(emission:number,endpoint=false):WaterFlightSection=>{const age=Math.max(0,now-emission);let totalQ=0,cx=0,cy=0,cz=0,vx=0,vy=0,vz=0,depth=0,low=Infinity,high=-Infinity;
    for(const list of sources.values()){let sum=0,q=0,x=0,y=0,z=0,ux=0,uy=0,uz=0,d=0,l=0,h=0;let lo=0,hi=list.length;while(lo<hi){const mid=(lo+hi)>>1;if(list[mid].time<emission)lo=mid+1;else hi=mid;}
      const radius=.04;let first=Math.max(0,lo-1);while(first>0&&endOf(list[first-1])>=emission-radius)first--;
      for(let k=first;k<list.length;k++){const f=list[k];if(startOf(f)>emission+radius)break;const distance=Math.max(0,startOf(f)-emission,emission-endOf(f));let weight=Math.max(0,1-distance/radius);if(endpoint)weight=distance<1e-8?1:0;if(!weight)continue;
        const a=add(f.edge[0],f.velocity,age),b=add(f.edge[1],f.velocity,age);a.y-=gravity*age*age*.5;b.y-=gravity*age*age*.5;const center=midpoint(a,b),flux=f.volume/f.duration;
        sum+=weight;q+=flux*weight;x+=center.x*weight;y+=center.y*weight;z+=center.z*weight;ux+=f.velocity.x*weight;uy+=(f.velocity.y-gravity*age)*weight;uz+=f.velocity.z*weight;d+=f.sourceDepth*weight;l+=Math.min(a.x*axis.x+a.y*axis.y+a.z*axis.z,b.x*axis.x+b.y*axis.y+b.z*axis.z)*weight;h+=Math.max(a.x*axis.x+a.y*axis.y+a.z*axis.z,b.x*axis.x+b.y*axis.y+b.z*axis.z)*weight;
      }
      if(!sum)continue;const flux=q/sum;totalQ+=flux;cx+=x/sum*flux;cy+=y/sum*flux;cz+=z/sum*flux;vx+=ux/sum*flux;vy+=uy/sum*flux;vz+=uz/sum*flux;depth+=d/sum*flux;low=Math.min(low,l/sum);high=Math.max(high,h/sum);
    }
    if(!totalQ)return section(records[0],age,gravity);const center={x:cx/totalQ,y:cy/totalQ,z:cz/totalQ},velocity={x:vx/totalQ,y:vy/totalQ,z:vz/totalQ},projection=center.x*axis.x+center.y*axis.y+center.z*axis.z,shift=(low+high)*.5-projection;center.x+=axis.x*shift;center.y+=axis.y*shift;center.z+=axis.z*shift;
    const speed=length(velocity),halfWidth=Math.max(1e-12,(high-low)*.5),sourceDepth=depth/totalQ;let normal=cross(axis,velocity);if(length(normal)<1e-12)normal=cross(axis,{x:0,y:1,z:0});
    return{center,across:axis,normal:unit(normal),halfWidth,halfDepth:Math.min(Math.max(halfWidth,sourceDepth*.5),totalQ/(factor*halfWidth*Math.max(speed,1e-9))),speed,sourceDepth};
  };
  const first=row(end,true),last=row(start,true),steps=Math.max(2,Math.min(256,Math.ceil(length(sub(first.center,last.center))/.06))),sections:WaterFlightSection[]=[];
  if(distance(first,last)<1e-12)return;for(let k=0;k<=steps;k++)sections.push(k===0?first:k===steps?last:row(end+(start-end)*k/steps));
  // Filter the profile over physical distance; endpoints remain exact. This
  // is one flowing outlet envelope, not visible individual parcel bulges.
  const raw=sections.slice();for(let i=1;i<sections.length-1;i++)sections[i]=blend(blend(raw[i-1],raw[i+1],.5),raw[i],.5);
  const attached=Math.abs(end-now)<=8*Number.EPSILON*Math.max(1,Math.abs(now),Math.abs(end));
  if(attached){
    // Accepted edge heights are the source's free surface, not the centre of
    // a round pipe. Put the upper contour at that surface while the first
    // rounded cross section turns into the falling stream. The
    // correction vanishes with actual descent; the exposed front is untouched.
    const source=sections[0],height=source.center.y,radius=Math.hypot(source.across.y*source.halfWidth,source.normal.y*source.halfDepth);
    for(let i=0;i<sections.length-1;i++){const row=sections[i],extent=Math.hypot(row.across.y*row.halfWidth,row.normal.y*row.halfDepth),amount=Math.min(radius,Math.max(0,row.center.y+extent-height));
      if(!(amount>0))break;sections[i]={...row,center:{...row.center,y:row.center.y-amount}};}
  }
  const joinRanges=(ids:string[]|undefined,emission:number):[number,number][]|undefined=>ids?.flatMap(id=>{const list=sources.get(id);if(!list?.length)return[];const f=list.reduce((best,f)=>Math.abs(f.time-emission)<Math.abs(best.time-emission)?f:best),age=Math.max(0,now-emission),points=f.edge.map(p=>add(p,f.velocity,age));for(const p of points)p.y-=gravity*age*age*.5;const values=points.map(p=>p.x*axis.x+p.y*axis.y+p.z*axis.z);return[[Math.min(...values),Math.max(...values)] as [number,number]];});
  return{id:outlet.id,sections,volume:records.reduce((sum,f)=>sum+f.volume,0),start,end,family:outlet.family,...(attached?{attached:true as const}:{}),startJoins:joinRanges(outlet.startJoins,start),endJoins:joinRanges(outlet.endJoins,end),startJoinIds:outlet.startJoins,endJoinIds:outlet.endJoins};
}

/** maxVertices includes rounded sides AND end caps. Resampling complete
 * episodes, rather than dropping packets, keeps an accepted stream connected
 * within the same bounded work/geometry budget as the old planar sheets. */
export function buildWaterFlightMesh(flights:readonly WaterBodyFlight[],now:number,gravity:number,maxOpenings:number,maxVertices:number,blocked?:(a:P,b:P)=>boolean,sourceSurface?:WaterFlightSourceSurface,sourceConnected?:WaterFlightSourceConnection):WaterFlightMesh {
  if(!(maxOpenings>0&&maxVertices>=12*WATER_FLIGHT_RING_SIDES))return{positions:new Float32Array(),normals:new Float32Array(),uvs:new Float32Array(),activity:new Float32Array(),optics:new Float32Array(),openings:0,paths:[]};
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[],activity:number[]=[],optics:number[]=[],paths:WaterFlightPath[]=[];
  const chains:WaterFlightPath[]=[];
  for(const outlet of prepareOutlets(flights,maxOpenings,blocked,sourceConnected)){const records=outlet.records.sort((a,b)=>endOf(b)-endOf(a));let episode:WaterBodyFlight[]=[],start=Infinity;
    const finish=()=>{if(!episode.length)return;const p=envelope(outlet,episode,now,gravity);if(p)chains.push(p);episode=[];start=Infinity;};
    for(const f of records){if(f.emittedTime!==undefined){finish();const sections=packetSections(f,now,gravity);if(distance(sections[0],sections[sections.length-1])>1e-12)chains.push({id:f.id,sections,volume:f.volume,start:startOf(f),end:endOf(f)});continue;}if(episode.length&&(start-endOf(f)>WATER_FLIGHT_PULSE_SMOOTHING||episode[0].velocity.x*f.velocity.x+episode[0].velocity.z*f.velocity.z<0))finish();episode.push(f);start=Math.min(start,startOf(f));}finish();
  }
  // Reserve complete branch caps and junctions BEFORE distributing longitudinal
  // samples. Overload may omit a whole weak outlet, never half its connector.
  const unitCost=6*WATER_FLIGHT_RING_SIDES,groups=new Map<string,WaterFlightPath[]>();for(const p of chains){const key=p.family??p.id;if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(p);}
  const capCost=(p:WaterFlightPath)=>unitCost+6*((p.startJoins?.length?(p.startJoins.length+1):0)+(p.endJoins?.length?(p.endJoins.length+1):0));
  const junctionCount=(paths:WaterFlightPath[])=>{const old=new Map<string,WaterFlightPath[]>();for(const p of paths)if(p.endJoinIds?.length){const key=p.end.toFixed(9);if(!old.has(key))old.set(key,[]);old.get(key)!.push(p);}let n=0;for(const p of paths)if(p.startJoinIds?.length)for(const q of old.get(p.start.toFixed(9))??[])if(p.startJoinIds.some(id=>q.endJoinIds!.includes(id)))n++;return n;};
  const candidates=[...groups.values()].map(paths=>({paths,volume:paths.reduce((n,p)=>n+p.volume,0),fixed:paths.reduce((n,p)=>n+capCost(p),0)+junctionCount(paths)*6*(WATER_FLIGHT_RING_SIDES+4)})).sort((a,b)=>b.volume-a.volume),selected:WaterFlightPath[]=[];let reserved=0;
  for(const group of candidates){const minimum=group.fixed+group.paths.length*unitCost;if(reserved+selected.length*unitCost+minimum>maxVertices)continue;selected.push(...group.paths);reserved+=group.fixed;}
  const lengths=selected.map(c=>c.sections.slice(1).reduce((sum,r,i)=>sum+distance(c.sections[i],r),0)),desired=lengths.map(l=>Math.max(1,Math.ceil(l/.08)));let remaining=Math.floor((maxVertices-reserved)/unitCost)-selected.length;
  const allocations=desired.map(()=>1);
  // Allocate remaining samples proportionally to path length. Stable
  // residual ordering makes identical accepted checkpoints reproducible.
  while(remaining>0){let best=-1,score=0;for(let i=0;i<allocations.length;i++)if(allocations[i]<desired[i]&&lengths[i]/allocations[i]>score){best=i;score=lengths[i]/allocations[i];}if(best<0)break;allocations[best]++;remaining--;}
  const emit=(a:P,b:P,c:P,na:P,nb:P,nc:P,ua:number,ub:number,uc:number,row:WaterFlightSection,ta=1,tb=1,tc=1)=>{
    if(positions.length+9>maxVertices*3)return;
    if(blocked){const middle={x:(a.x+b.x+c.x)/3,y:(a.y+b.y+c.y)/3,z:(a.z+b.z+c.z)/3};if(blocked(a,b)||blocked(b,c)||blocked(c,a)||blocked(middle,middle))return;}
    const opacity=Math.min(1,row.halfDepth/.001);for(const [p,n,u,tone] of [[a,na,ua,ta],[b,nb,ub,tb],[c,nc,uc,tc]] as const){positions.push(p.x,p.y,p.z);normals.push(n.x,n.y,n.z);uvs.push(u,-p.y);activity.push(1,row.speed,tone);optics.push(row.sourceDepth,opacity);}
  };
  const openings=new Set<string>();
  type JunctionEnd={time:number;row:WaterFlightSection;ring:WaterFlightJunctionVertex[];ids:string[];ranges:[number,number][]};
  const olderEnds=new Map<string,JunctionEnd[]>(),newerEnds:JunctionEnd[]=[];
  for(let pathIndex=0;pathIndex<selected.length;pathIndex++){const path={...selected[pathIndex],sections:resample(selected[pathIndex].sections,allocations[pathIndex])},before=positions.length;
    const source=path.sections[0],sourceExtent=Math.hypot(source.across.y*source.halfWidth,source.normal.y*source.halfDepth),flow=unit(cross(source.normal,source.across));
    const profile=path.attached&&sourceSurface?Array.from({length:WATER_FLIGHT_RING_SIDES},(_,k)=>{const angle=k*2*Math.PI/WATER_FLIGHT_RING_SIDES,co=Math.cos(angle),si=Math.sin(angle);if(si*source.normal.y<-1e-12)return;
      const point=add(source.center,source.across,co*source.halfWidth);point.y+=sourceExtent;const sample=sourceSurface(point,flow),height=typeof sample==='number'?sample:sample?.height;if(height===undefined||!Number.isFinite(height))return;
      return{delta:height-(source.center.y+source.across.y*co*source.halfWidth+source.normal.y*si*source.halfDepth),normal:typeof sample==='number'?undefined:sample?.normal,tone:typeof sample!=='number'&&Number.isFinite(sample?.tone)?sample!.tone!:1};}):undefined;
    const transition=Math.max(source.sourceDepth,source.halfDepth*2),weights:number[]=[];let travelled=0;
    for(let j=0;j<path.sections.length;j++){if(j)travelled+=distance(path.sections[j-1],path.sections[j]);const t=transition>0?Math.min(1,travelled/transition):1;weights.push(j===path.sections.length-1?0:1-t*t*(3-2*t));}
    const rings=path.sections.map((row,j)=>Array.from({length:WATER_FLIGHT_RING_SIDES},(_,k)=>{const angle=k*2*Math.PI/WATER_FLIGHT_RING_SIDES,co=Math.cos(angle),si=Math.sin(angle),offset=add({x:row.across.x*co*row.halfWidth,y:row.across.y*co*row.halfWidth,z:row.across.z*co*row.halfWidth},row.normal,si*row.halfDepth);if(profile?.[k])offset.y+=profile[k]!.delta*weights[j];let fraction=1;
      if(blocked&&blocked(row.center,add(row.center,offset))){let low=0,high=1;for(let step=0;step<8;step++){const mid=(low+high)*.5;if(blocked(row.center,add(row.center,offset,mid)))high=mid;else low=mid;}fraction=low;}
      return{p:add(row.center,offset,fraction),n:unit(add({x:row.across.x*co/Math.max(row.halfWidth,1e-12),y:row.across.y*co/Math.max(row.halfWidth,1e-12),z:row.across.z*co/Math.max(row.halfWidth,1e-12)},row.normal,si/Math.max(row.halfDepth,1e-12))),u:(co+1)*row.halfWidth,tone:1+((profile?.[k]?.tone??1)-1)*weights[j]};}));
    if(profile?.some(Boolean))for(let j=0;j<rings.length;j++)for(let k=0;k<WATER_FLIGHT_RING_SIDES;k++){
      const along=sub(rings[Math.min(rings.length-1,j+1)][k].p,rings[Math.max(0,j-1)][k].p),around=sub(rings[j][(k+1)%WATER_FLIGHT_RING_SIDES].p,rings[j][(k+WATER_FLIGHT_RING_SIDES-1)%WATER_FLIGHT_RING_SIDES].p),geometric=cross(along,around);
      if(length(geometric)>1e-12)rings[j][k].n=unit(geometric);const normal=profile[k]?.normal;if(normal&&length(normal)>1e-12)rings[j][k].n=unit(mix(rings[j][k].n,unit(normal),weights[j]));
    }
    for(let j=1;j<rings.length;j++)for(let k=0;k<WATER_FLIGHT_RING_SIDES;k++){const next=(k+1)%WATER_FLIGHT_RING_SIDES,a=rings[j-1][k],b=rings[j-1][next],c=rings[j][k],d=rings[j][next],row=blend(path.sections[j-1],path.sections[j],.5);emit(a.p,c.p,b.p,a.n,c.n,b.n,a.u,c.u,b.u,row,a.tone,c.tone,b.tone);emit(c.p,d.p,b.p,c.n,d.n,b.n,c.u,d.u,b.u,row,c.tone,d.tone,b.tone);}
    for(const end of [0,rings.length-1]){if(end===0&&path.attached)continue;const row=path.sections[end],ring=rings[end],normal=unit(sub(row.center,end===0?path.sections[1].center:path.sections[end-1].center)),joins=end===0?path.endJoins:path.startJoins;
      if(joins?.length){
        // An interval split is not an exposed fluid end. Cap only the aperture
        // portions whose emission really stops/starts here, never continuations.
        const projection=(p:P)=>p.x*row.across.x+p.y*row.across.y+p.z*row.across.z,values=ring.map(v=>projection(v.p)),low=Math.min(...values),high=Math.max(...values),ranges=joins.slice().sort((a,b)=>a[0]-b[0]),exposed:[number,number][]=[];let from=low;
        for(const [a,b] of ranges){if(a>from)exposed.push([from,Math.min(a,high)]);from=Math.max(from,b);if(from>=high)break;}if(from<high)exposed.push([from,high]);
        for(const [a,b] of exposed){if(!(b>a))continue;const poly=clippedRing(ring,row.across,a,b);for(let i=1;i+1<poly.length;i++){const first=poly[0],left=poly[i],right=poly[i+1];if(end===0)emit(first.p,left.p,right.p,normal,normal,normal,first.u,left.u,right.u,row);else emit(first.p,right.p,left.p,normal,normal,normal,first.u,right.u,left.u,row);}}
      }else for(let k=0;k<WATER_FLIGHT_RING_SIDES;k++){const a=ring[k],b=ring[(k+1)%WATER_FLIGHT_RING_SIDES];if(end===0)emit(row.center,a.p,b.p,normal,normal,normal,row.halfWidth,a.u,b.u,row);else emit(row.center,b.p,a.p,normal,normal,normal,row.halfWidth,b.u,a.u,row);}}
    if(positions.length>before){openings.add(path.id);paths.push(path);
      if(path.endJoinIds?.length&&path.endJoins){const end={time:path.end,row:path.sections[0],ring:rings[0],ids:path.endJoinIds,ranges:path.endJoins},key=path.end.toFixed(9);if(!olderEnds.has(key))olderEnds.set(key,[]);olderEnds.get(key)!.push(end);}
      if(path.startJoinIds?.length&&path.startJoins)newerEnds.push({time:path.start,row:path.sections.at(-1)!,ring:rings.at(-1)!,ids:path.startJoinIds,ranges:path.startJoins});
    }
  }
  // Temporal components share a real continuation, not independent capped
  // ellipses. Loft their exact exposed contours without moving a true front.
  let junctionWork=0;for(const newer of newerEnds)for(const older of olderEnds.get(newer.time.toFixed(9))??[]){if(++junctionWork>4096)break;const ids=newer.ids.filter(id=>older.ids.includes(id));if(!ids.length)continue;
    const cut=(end:JunctionEnd)=>{const ranges=ids.map(id=>end.ranges[end.ids.indexOf(id)]).filter(Boolean);return clippedRing(end.ring,end.row.across,Math.min(...ranges.map(r=>r[0])),Math.max(...ranges.map(r=>r[1])));};
    const newerContour=cut(newer),olderContour=cut(older),row=blend(newer.row,older.row,.5);for(const [a,b,c] of waterFlightJunction(newerContour,olderContour,newer.row.across))emit(a.p,b.p,c.p,a.n,b.n,c.n,a.u,b.u,c.u,row,a.tone,b.tone,c.tone);
  }
  return{positions:Float32Array.from(positions),normals:Float32Array.from(normals),uvs:Float32Array.from(uvs),activity:Float32Array.from(activity),optics:Float32Array.from(optics),openings:openings.size,paths};
}
