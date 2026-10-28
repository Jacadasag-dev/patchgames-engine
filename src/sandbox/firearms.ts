/** Replayable firearm handling. Angles are radians; time is simulation milliseconds.
 * Keep this state in declared player state. Rendering never rolls shot randomness. */
export interface FirearmRecoilState { shots:number; lastShotMs:number; seed:number; pitch:number; yaw:number; weapon:number }
export const firearmRecoilShape = { shots:'uint16', lastShotMs:'number', seed:'uint32', pitch:'number', yaw:'number', weapon:'int16' } as const;
export function createFirearmRecoilState():FirearmRecoilState { return {shots:0,lastShotMs:-1e9,seed:0,pitch:0,yaw:0,weapon:-1}; }
export interface FirearmProfile {
  /** Cumulative climb per shot; last value is the sustained-spray ceiling. */
  climb:readonly number[];
  deterministicShots:number;
  sway:number;
  swayShots:number;
  spread:number;
  spreadGrowth:number;
  maxSpread:number;
  movingSpread:number;
  airborneSpread:number;
  adsMultiplier:number;
  crouchMultiplier:number;
  recoveryDelayMs:number;
  recoveryPerSecond:number;
  resetMs:number;
}
const rad=(degrees:number)=>degrees*Math.PI/180;
const base:FirearmProfile={climb:[0,.4,.9,1.6,2.5,3.5,4.5,5.4,6.2,6.8].map(rad),deterministicShots:5,sway:rad(1.7),swayShots:5,
  spread:rad(.12),spreadGrowth:rad(.045),maxSpread:rad(.65),movingSpread:rad(2.2),airborneSpread:rad(5),
  adsMultiplier:.7,crouchMultiplier:.85,recoveryDelayMs:140,recoveryPerSecond:rad(20),resetMs:440};
/** Editable ingredients, not replicas of another game's weapon numbers. */
export const FIREARM_PROFILES:Readonly<Record<'sidearm'|'rifle'|'smg'|'marksman'|'heavy',FirearmProfile>>={
  sidearm:{...base,climb:[0,.75,1.45,2.05,2.5,2.85].map(rad),deterministicShots:3,sway:rad(.7),spread:rad(.18),resetMs:330},
  rifle:{...base},
  smg:{...base,climb:[0,.25,.55,.95,1.45,2.05,2.8,3.5,4.2,4.8,5.3].map(rad),deterministicShots:4,sway:rad(2.2),swayShots:4,spread:rad(.22),maxSpread:rad(.95),movingSpread:rad(1.4),resetMs:360},
  marksman:{...base,climb:[0,2.1,3.4,4.1].map(rad),deterministicShots:3,sway:rad(.35),spread:rad(.015),spreadGrowth:rad(.02),maxSpread:rad(.12),adsMultiplier:.25,resetMs:700,recoveryPerSecond:rad(12)},
  heavy:{...base,climb:[0,.65,1.5,2.6,3.8,4.9,5.8,6.6,7.2,7.7].map(rad),deterministicShots:4,sway:rad(2.5),swayShots:6,spread:rad(.18),resetMs:520},
};
function noise(seed:number,index:number):number { let n=(seed^Math.imul(index+1,0x9e3779b1))>>>0;n=Math.imul(n^(n>>>16),0x21f0aaad);n=Math.imul(n^(n>>>15),0x735a2d97);return ((n^(n>>>15))>>>0)/4294967296; }
const approach=(n:number,amount:number)=>Math.sign(n)*Math.max(0,Math.abs(n)-amount);
export function recoverFirearm(state:FirearmRecoilState,profile:FirearmProfile,nowMs:number,dtMs:number):void {
  const active=Math.max(0,Math.min(dtMs,nowMs-state.lastShotMs-profile.recoveryDelayMs));
  state.pitch=approach(state.pitch,profile.recoveryPerSecond*active/1000);
  state.yaw=approach(state.yaw,profile.recoveryPerSecond*active/1000);
}
export function fireFirearm(state:FirearmRecoilState,profile:FirearmProfile,options:{weapon:number;nowMs:number;random:()=>number;yaw:number;pitch:number;speed?:number;airborne?:boolean;ads?:boolean;crouched?:boolean}) {
  if(!Number.isFinite(options.nowMs)||!Number.isFinite(options.yaw)||!Number.isFinite(options.pitch))throw new Error('Firearm shot requires finite aim and time.');
  if(!profile.climb.length||profile.climb.length>256||profile.climb.some((n,i)=>!Number.isFinite(n)||n<0||i>0&&n<profile.climb[i-1])
    ||Object.entries(profile).some(([key,n])=>key!=='climb'&&(!Number.isFinite(n)||Number(n)<0))||profile.swayShots<1)throw new Error('Invalid firearm profile.');
  if(state.weapon!==options.weapon||options.nowMs-state.lastShotMs>=profile.resetMs){Object.assign(state,createFirearmRecoilState(),{weapon:options.weapon,seed:Math.floor(Math.max(0,Math.min(.999999999,options.random()))*4294967296)});}
  const index=state.shots,scale=(options.ads?profile.adsMultiplier:1)*(options.crouched?profile.crouchMultiplier:1);
  const beforePitch=state.pitch,beforeYaw=state.yaw;
  const climb=profile.climb[Math.min(index+1,profile.climb.length-1)];
  // Non-uniform upward steps, then a ceiling. Bounded drift has a learnable
  // tendency without making the extended spray perfectly memorizable.
  const previous=profile.climb[Math.min(index,profile.climb.length-1)];
  state.pitch=Math.min(profile.climb.at(-1)!*scale, state.pitch+Math.max(0,climb-previous)*scale*(index<profile.deterministicShots?1:.8+.4*noise(state.seed,index*3)));
  const progress=Math.max(0,index-profile.deterministicShots+1)/profile.swayShots;
  const segment=Math.floor(progress),fraction=progress-segment,smooth=fraction*fraction*(3-2*fraction);
  const a=segment===0?0:(noise(state.seed,1000+segment)-.5)*2,b=(noise(state.seed,1001+segment)-.5)*2;
  state.yaw=(a+(b-a)*smooth)*profile.sway*scale;
  const cone=(Math.min(profile.maxSpread,profile.spread+index*profile.spreadGrowth)
    +Math.min(1,Math.max(0,options.speed??0)/5)*profile.movingSpread+(options.airborne?profile.airborneSpread:0))*scale;
  const radius=Math.sqrt(noise(state.seed,index*3+1))*cone,angle=noise(state.seed,index*3+2)*Math.PI*2;
  // Resolve the shot before its kick, then present the post-shot camera offset.
  // Slow single-shot weapons must still kick even when every shot is a new burst.
  const yaw=options.yaw+beforeYaw+Math.cos(angle)*radius,pitch=options.pitch+beforePitch+Math.sin(angle)*radius;
  state.shots=Math.min(65535,index+1);state.lastShotMs=options.nowMs;
  return {shotIndex:index,seed:state.seed,yaw,pitch,direction:{x:Math.sin(yaw)*Math.cos(pitch),y:Math.sin(pitch),z:Math.cos(yaw)*Math.cos(pitch)}};
}

export interface FirearmVector {x:number;y:number;z:number}
export type FirearmHitRegion='head'|'torso'|'arm'|'leg';
export interface FirearmImpact { point:FirearmVector; normal:FirearmVector; distance:number; target:number; surface:boolean; region?:FirearmHitRegion; colliderId?:string }
export interface FirearmTarget {id:number;position:FirearmVector;radius:number;height:number;facing?:number}
/** Camera aim selects the target; the muzzle ray prevents firing through nearby
 * cover. Targets are vertical capsules with bottom-at-feet coordinates. */
export function traceFirearm(options:{origin:FirearmVector;direction:FirearmVector;range:number;targets:readonly FirearmTarget[];
  raycast:(origin:FirearmVector,direction:FirearmVector,distance:number)=>{distance:number;normal:FirearmVector;colliderId?:string}|null;muzzle?:FirearmVector}):FirearmImpact {
  const {origin,range}=options;const len=Math.hypot(options.direction.x,options.direction.y,options.direction.z);
  if(!Number.isFinite(len)||len<1e-8||!Number.isFinite(range)||range<=0)throw new Error('Invalid firearm ray.');
  const d={x:options.direction.x/len,y:options.direction.y/len,z:options.direction.z/len};
  const solid=options.raycast(origin,d,range);let distance=solid?.distance??range,target=-1,normal=solid?.normal??{x:-d.x,y:-d.y,z:-d.z},surface=!!solid,colliderId=solid?.colliderId;
  for(const t of options.targets){
    const ox=origin.x-t.position.x,oz=origin.z-t.position.z,r=t.radius;
    const candidates:number[]=[];const a=d.x*d.x+d.z*d.z,b=2*(ox*d.x+oz*d.z),c=ox*ox+oz*oz-r*r,disc=b*b-4*a*c;
    if(a>1e-10&&disc>=0)for(const s of [-1,1]){const v=(-b+s*Math.sqrt(disc))/(2*a),y=origin.y+d.y*v;if(y>=t.position.y+r&&y<=t.position.y+t.height-r)candidates.push(v);}
    for(const cy of [t.position.y+r,t.position.y+Math.max(r,t.height-r)]){const oy=origin.y-cy,q=ox*d.x+oy*d.y+oz*d.z,h=q*q-(ox*ox+oy*oy+oz*oz-r*r);if(h>=0)candidates.push(-q-Math.sqrt(h),-q+Math.sqrt(h));}
    for(const hit of candidates)if(hit>=0&&hit<distance){distance=hit;target=t.id;surface=false;const y=origin.y+d.y*hit,cy=Math.max(t.position.y+r,Math.min(t.position.y+t.height-r,y)),nx=ox+d.x*hit,ny=y-cy,nz=oz+d.z*hit,n=Math.hypot(nx,ny,nz)||1;normal={x:nx/n,y:ny/n,z:nz/n};}
  }
  let point={x:origin.x+d.x*distance,y:origin.y+d.y*distance,z:origin.z+d.z*distance};
  if(options.muzzle){const m=options.muzzle,dx=point.x-m.x,dy=point.y-m.y,dz=point.z-m.z,n=Math.hypot(dx,dy,dz);if(n>1e-6){const blocked=options.raycast(m,{x:dx/n,y:dy/n,z:dz/n},n);if(blocked&&blocked.distance<n-.01){point={x:m.x+dx/n*blocked.distance,y:m.y+dy/n*blocked.distance,z:m.z+dz/n*blocked.distance};normal=blocked.normal;target=-1;surface=true;colliderId=blocked.colliderId;distance=Math.hypot(point.x-origin.x,point.y-origin.y,point.z-origin.z);}}}
  const victim=options.targets.find(t=>t.id===target);
  const region=victim?firearmHitRegion(point,victim):undefined;
  return {point,normal,distance,target,surface,...(region?{region}:{}),...(surface&&colliderId?{colliderId}:{})};
}

/** Capsule-proxy regions, independent of render bones. Games needing animated
 * per-bone hitboxes can supply their own region and reuse firearmDamage. */
export function firearmHitRegion(point:FirearmVector,target:FirearmTarget):FirearmHitRegion {
  const height=(point.y-target.position.y)/target.height;
  if(height>=.8)return 'head';
  if(height<.43)return 'leg';
  const lateral=(point.x-target.position.x)*Math.cos(target.facing??0)-(point.z-target.position.z)*Math.sin(target.facing??0);
  return Math.abs(lateral)>target.radius*.65?'arm':'torso';
}
export function firearmDamage(base:number,region:FirearmHitRegion,distance:number,profile:{head:number;arm?:number;leg:number;falloffStart:number;falloffEnd:number;minimum:number}):number {
  const t=Math.max(0,Math.min(1,(distance-profile.falloffStart)/Math.max(.001,profile.falloffEnd-profile.falloffStart)));
  return base*(1-t*(1-profile.minimum))*(region==='head'?profile.head:region==='leg'?profile.leg:region==='arm'?(profile.arm??1):1);
}
/** One trigger consumes one recoil step; each pellet gets a replayable cone. */
export function firearmPelletDirections(direction:FirearmVector,seed:number,count:number,spread:number):FirearmVector[] {
  const length=Math.hypot(direction.x,direction.y,direction.z);if(!Number.isFinite(length)||length<1e-8||!Number.isFinite(count)||!Number.isFinite(spread)||spread<0)throw new Error('Invalid firearm pellet fan.');const pelletCount=Math.max(1,Math.min(32,Math.floor(count))),d={x:direction.x/length,y:direction.y/length,z:direction.z/length};
  const yaw=Math.atan2(d.x,d.z),pitch=Math.asin(Math.max(-1,Math.min(1,d.y)));
  return Array.from({length:pelletCount},(_,i)=>{const radius=Math.sqrt((i+.5)/pelletCount)*spread,angle=i*2.3999632297+noise(seed,i)*.5;
    const y=yaw+Math.cos(angle)*radius,p=pitch+Math.sin(angle)*radius;return{x:Math.sin(y)*Math.cos(p),y:Math.sin(p),z:Math.cos(y)*Math.cos(p)};});
}

export type FirearmReloadStyle='magazine'|'revolver'|'shell'|'bolt'|'belt';
export type FirearmModelKind='glock'|'revolver'|'short-shotgun'|'rifle-heavy'|'rifle-fast'|'sniper-light'|'sniper-heavy'|'shotgun-pump'|'shotgun-auto'|'smg'|'lmg';
export const FIREARM_LENGTHS:Readonly<Record<FirearmModelKind,number>>={glock:.28,revolver:.36,'short-shotgun':.28,'rifle-heavy':.68,'rifle-fast':.68,'sniper-light':.87,'sniper-heavy':1.04,'shotgun-pump':.82,'shotgun-auto':.68,smg:.48,lmg:.8};
/** Replayable muzzle proxy for host cover checks. Supply authored offsets when
 * the actor's rig/scale differs; rendering can still use its exact socket. */
export function firearmMuzzle(origin:FirearmVector,direction:FirearmVector,options:{forward:number;side?:number;lower?:number}):FirearmVector{
  const n=Math.hypot(direction.x,direction.y,direction.z),h=Math.hypot(direction.x,direction.z)||1;
  return{x:origin.x+direction.x/n*options.forward-direction.z/h*(options.side??.08),y:origin.y+direction.y/n*options.forward-(options.lower??.33),z:origin.z+direction.z/n*options.forward+direction.x/h*(options.side??.08)};
}
/** Smooth key phases shared by the hand solver and animated magazine/bolt. */
export function sampleFirearmReload(progress:number,style:FirearmReloadStyle){
  const p=Math.max(0,Math.min(1,progress)),wave=Math.sin(Math.PI*p),smooth=(a:number,b:number)=>{const t=Math.max(0,Math.min(1,(p-a)/(b-a)));return t*t*(3-2*t);};
  const transfer=smooth(.1,.28)*(1-smooth(.65,.84));
  return {pitch:(style==='shell'?.25:style==='bolt'?.12:.38)*wave,roll:(style==='revolver'?.85:style==='belt'?-.5:.22)*wave,
    hand:{x:(style==='revolver'?.15:style==='belt'?-.12:0)*wave,y:-(style==='shell'?.15:.23)*transfer,z:(style==='bolt'?-.16:.1)*wave},
    contact:transfer,magazine:style==='magazine'?transfer:0,bolt:style==='bolt'?Math.sin(Math.PI*smooth(.5,.8))*.12:0,cylinder:style==='revolver'?wave:0,
    shell:style==='shell'?Math.sin(p*Math.PI*6)*wave:0,lid:style==='belt'?wave:0};
}
