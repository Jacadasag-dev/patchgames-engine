import {firearmDamage,firearmHitRegion,firearmPelletDirections,sampleFirearmReload} from '../../src/sandbox/firearms.ts';
import {expect,it} from 'vitest';
import {createFirearmRecoilState,fireFirearm,FIREARM_PROFILES,recoverFirearm,traceFirearm} from '../../src/sandbox/firearms.ts';
const shot=(s:ReturnType<typeof createFirearmRecoilState>,i:number,seed=.25,profile=FIREARM_PROFILES.rifle)=>fireFirearm(s,profile,{weapon:1,nowMs:i*100,random:()=>seed,yaw:0,pitch:0});
it('replays identical seeded sprays and keeps the opening recoil predictable',()=>{
  const a=createFirearmRecoilState(),b=createFirearmRecoilState(),c=createFirearmRecoilState();
  for(let i=0;i<25;i++){const sa=shot(a,i),sb=shot(b,i),unused=shot(c,i,.8);expect(sa).toEqual(sb);expect(unused.direction).toBeDefined();expect(Math.hypot(...Object.values(sa.direction))).toBeCloseTo(1);if(i<5){expect(a.pitch).toBe(c.pitch);expect(a.yaw).toBe(c.yaw);}else if(i===20)expect(a.yaw).not.toBe(c.yaw);expect(a.pitch).toBeGreaterThanOrEqual(0);expect(a.pitch).toBeLessThanOrEqual(FIREARM_PROFILES.rifle.climb.at(-1)!);}
});
it('has different weapon envelopes, recovery, and ADS/movement accuracy',()=>{
  const a=createFirearmRecoilState(),b=createFirearmRecoilState();for(let i=0;i<8;i++){shot(a,i);shot(b,i,.25,FIREARM_PROFILES.smg);}expect(a.pitch).not.toBe(b.pitch);
  recoverFirearm(a,FIREARM_PROFILES.rifle,2000,1000);expect(a.pitch).toBe(0);expect(shot(a,21).shotIndex).toBe(0);
  const stationary=fireFirearm(createFirearmRecoilState(),FIREARM_PROFILES.rifle,{weapon:1,nowMs:0,random:()=>.2,yaw:0,pitch:0,ads:true});
  const moving=fireFirearm(createFirearmRecoilState(),FIREARM_PROFILES.rifle,{weapon:1,nowMs:0,random:()=>.2,yaw:0,pitch:0,speed:5,airborne:true});
  expect(Math.abs(stationary.yaw)).toBeLessThan(Math.abs(moving.yaw));
});
it('hits a capsule before the wall and returns a true surface normal for wall hits',()=>{
  const wall=()=>({distance:20,normal:{x:0,y:0,z:-1},colliderId:'wall'});
  const input={origin:{x:0,y:1,z:0},direction:{x:0,y:0,z:1},range:100,raycast:wall,targets:[{id:3,position:{x:0,y:0,z:10},radius:.4,height:1.8}]};
  const hit=traceFirearm(input);expect(hit.target).toBe(3);expect(hit.point.z).toBeCloseTo(9.6);expect(hit.surface).toBe(false);
  const miss=traceFirearm({...input,targets:[]});expect(miss.surface).toBe(true);expect(miss.normal).toEqual({x:0,y:0,z:-1});
  const corner=traceFirearm({...input,muzzle:{x:1,y:1,z:0},raycast:origin=>origin.x===1?{distance:1,normal:{x:-1,y:0,z:0}}:wall()});expect(corner.target).toBe(-1);expect(corner.surface).toBe(true);
});

it('resolves body regions, falloff, seeded pellets and smooth reload phases',()=>{
 const target={id:1,position:{x:0,y:0,z:0},radius:.4,height:1.75,facing:0};
 expect(firearmHitRegion({x:0,y:1.6,z:.35},target)).toBe('head');expect(firearmHitRegion({x:0,y:1,z:.4},target)).toBe('torso');expect(firearmHitRegion({x:.39,y:1,z:0},target)).toBe('arm');expect(firearmHitRegion({x:0,y:.4,z:.3},target)).toBe('leg');
 const profile={head:4,leg:.75,arm:.9,falloffStart:20,falloffEnd:50,minimum:.5};expect(firearmDamage(40,'head',10,profile)).toBe(160);expect(firearmDamage(40,'leg',50,profile)).toBe(15);
 const pellets=firearmPelletDirections({x:0,y:0,z:1},32,8,.05);expect(pellets).toEqual(firearmPelletDirections({x:0,y:0,z:1},32,8,.05));expect(new Set(pellets.map(p=>p.x)).size).toBe(8);
 for(const style of ['magazine','revolver','shell','bolt','belt'] as const){expect(sampleFirearmReload(0,style).pitch).toBe(0);expect(sampleFirearmReload(.5,style).pitch).toBeGreaterThan(0);expect(sampleFirearmReload(1,style).pitch).toBeCloseTo(0);}
});

it('kicks slow single-shot weapons after resolving the pre-kick aim',()=>{const state=createFirearmRecoilState(),profile={...FIREARM_PROFILES.marksman,spread:0};for(const nowMs of [0,1500,3000]){const shot=fireFirearm(state,profile,{weapon:0,nowMs,random:()=>.5,yaw:0,pitch:0});expect(shot.direction.y).toBe(0);expect(state.pitch).toBeGreaterThan(0);}});
