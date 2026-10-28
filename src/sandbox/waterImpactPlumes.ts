/** Continuous, feathered spray volumes from accepted impacts. These are
 * layered wisps and churning foam, never round particle droplets or mass. */
import type {WaterBodyManifest} from './waterBody.ts';
import type {WaterDetailEvent} from './waterDetail.ts';
import type {PhysicsVector} from './physics.ts';
export const WATER_IMPACT_LIMITS={low:12,high:32,wisps:6,segments:4,foamSegments:12,lifetime:1.2,events:256} as const;
export interface WaterImpactPlumeBuffers {positions:Float32Array;uvs:Float32Array;activity:Float32Array;optics:Float32Array;count:number}
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
export function waterImpactLifetime(w:WaterBodyManifest,event:WaterDetailEvent):number {
 const speed=Math.sqrt(2*Math.max(0,event.energy)/(w.liquid.restDensity*Math.max(event.volume,1e-12)));
 return Math.min(WATER_IMPACT_LIMITS.lifetime,.45+speed*.07);
}
interface Plume {key:string;volume:number;energy:number;depth:number;radius:number;position:PhysicsVector;normal:PhysicsVector;velocity:PhysicsVector}
/** A fixed temporal kernel combines consecutive arrivals from one opening.
 * Rendering cadence never creates a new burst or resets its turbulence. */
export function buildWaterImpactPlumes(w:WaterBodyManifest,events:readonly WaterDetailEvent[],seconds:number,quality:'off'|'low'|'high',blocked?:(from:PhysicsVector,to:PhysicsVector)=>boolean):WaterImpactPlumeBuffers {
 const positions:number[]=[],uvs:number[]=[],activity:number[]=[],optics:number[]=[];let count=0;
 const limit=quality==='off'?0:WATER_IMPACT_LIMITS[quality],groups=new Map<string,Plume>();
 if(limit)for(const e of events.slice(-WATER_IMPACT_LIMITS.events)){if((e.kind!=='impact'&&e.kind!=='splash')||!(e.volume>0&&e.energy>0))continue;
  const age=seconds-e.time,life=waterImpactLifetime(w,e);if(age<=0||age>=life)continue;
  const weight=clamp(age/.04)*(1-age/life)**2,volume=e.volume*weight,key=e.source.startsWith('flight-impact:')?e.source.slice(0,e.source.lastIndexOf(':')):e.source;
  if(!(volume>0))continue;
  let group=groups.get(key);if(!group){group={key,volume:0,energy:0,depth:0,radius:0,position:{x:0,y:0,z:0},normal:{x:0,y:0,z:0},velocity:{x:0,y:0,z:0}};groups.set(key,group);}
  group.volume+=volume;group.energy+=e.energy*weight;group.depth+=(e.sourceDepth??e.depth)*volume;group.radius+=e.radius*volume;
  for(const axis of ['x','y','z'] as const){group.position[axis]+=e.position[axis]*volume;group.normal[axis]+=e.normal[axis]*volume;group.velocity[axis]+=e.velocity[axis]*volume;}
 }
 for(const p of [...groups.values()].sort((a,b)=>b.energy-a.energy||a.key.localeCompare(b.key)).slice(0,limit)){
  const start=positions.length;for(const axis of ['x','y','z'] as const){p.position[axis]/=p.volume;p.velocity[axis]/=p.volume;p.normal[axis]/=p.volume;}p.depth/=p.volume;p.radius/=p.volume;
  const nl=Math.hypot(p.normal.x,p.normal.y,p.normal.z)||1,n={x:p.normal.x/nl,y:p.normal.y/nl,z:p.normal.z/nl},normalSpeed=p.velocity.x*n.x+p.velocity.y*n.y+p.velocity.z*n.z;
  let tx=p.velocity.x-n.x*normalSpeed,ty=p.velocity.y-n.y*normalSpeed,tz=p.velocity.z-n.z*normalSpeed;const tangential=Math.hypot(tx,ty,tz);
  if(tangential<1e-8){if(Math.abs(n.y)<.9){tx=-n.z;ty=0;tz=n.x;}else{tx=n.y;ty=-n.x;tz=0;}}
  const tl=Math.hypot(tx,ty,tz);tx/=tl;ty/=tl;tz/=tl;const bx=n.y*tz-n.z*ty,by=n.z*tx-n.x*tz,bz=n.x*ty-n.y*tx;
  const speed=Math.sqrt(2*p.energy/(w.liquid.restDensity*p.volume)),scale=Math.cbrt(p.volume),radius=Math.min(1.5,p.radius*.45+scale*2.5),height=Math.min(2,speed*speed/(-2*w.liquid.gravity.y)*.28,scale*6),opacity=1-Math.exp(-Math.sqrt(p.volume)*16);
  let seed=0;for(let k=0;k<p.key.length;k++)seed=(Math.imul(seed,31)+p.key.charCodeAt(k))|0;const phase=(seed>>>0)/4294967296*Math.PI*2;
  const point=(u:number,v:number,h:number):PhysicsVector=>({x:p.position.x+tx*u+bx*v+n.x*(h+.003),y:p.position.y+ty*u+by*v+n.y*(h+.003),z:p.position.z+tz*u+bz*v+n.z*(h+.003)});
  const triangle=(a:PhysicsVector,b:PhysicsVector,c:PhysicsVector,uv:readonly number[],kind:number)=>{
   if(blocked){const center={x:(a.x+b.x+c.x)/3,y:(a.y+b.y+c.y)/3,z:(a.z+b.z+c.z)/3};if(blocked(a,b)||blocked(b,c)||blocked(c,a)||blocked(center,center)||blocked(point(0,0,0),center))return;}
   for(const [i,q] of [a,b,c].entries()){positions.push(q.x,q.y,q.z);uvs.push(uv[i*2],uv[i*2+1]);activity.push(kind,speed,1);optics.push(p.depth,opacity);}
  };
  // Intersecting curved wisps give an approximately volumetric silhouette
  // from every camera angle. Their shader feathers every edge into noise.
  for(let k=0;k<WATER_IMPACT_LIMITS.wisps;k++){
   const angle=k*Math.PI/WATER_IMPACT_LIMITS.wisps,dx=Math.cos(angle),dz=Math.sin(angle),curl=phase+k*1.7;
   const row=(t:number):[PhysicsVector,PhysicsVector]=>{const sway=Math.sin(seconds*(.8+speed*.08)+curl+t*3)*radius*.16*t,drift=Math.min(1,tangential/Math.max(speed,1e-9))*radius*t,h=height*t*(.75+.25*Math.sin(curl)**2),width=radius*(.65+.5*t),u=drift-dz*sway,v=dx*sway;return[point(u-dx*width,v-dz*width,h),point(u+dx*width,v+dz*width,h)];};
   for(let j=0;j<WATER_IMPACT_LIMITS.segments;j++){const t0=j/WATER_IMPACT_LIMITS.segments,t1=(j+1)/WATER_IMPACT_LIMITS.segments,a=row(t0),b=row(t1);triangle(a[0],a[1],b[0],[0,t0,1,t0,0,t1],2);triangle(b[0],a[1],b[1],[0,t1,1,t0,1,t1],2);}
  }
  // The same accepted energy drives a soft, rotating whitewater footprint.
  for(let k=0;k<WATER_IMPACT_LIMITS.foamSegments;k++){const a=k/WATER_IMPACT_LIMITS.foamSegments*Math.PI*2,b=(k+1)/WATER_IMPACT_LIMITS.foamSegments*Math.PI*2;triangle(point(0,0,0),point(Math.cos(a)*radius*1.4,Math.sin(a)*radius*1.4,0),point(Math.cos(b)*radius*1.4,Math.sin(b)*radius*1.4,0),[.5,.5,.5+Math.cos(a)*.5,.5+Math.sin(a)*.5,.5+Math.cos(b)*.5,.5+Math.sin(b)*.5],3);}
  if(positions.length>start)count++;
 }
 return{positions:Float32Array.from(positions),uvs:Float32Array.from(uvs),activity:Float32Array.from(activity),optics:Float32Array.from(optics),count};
}
