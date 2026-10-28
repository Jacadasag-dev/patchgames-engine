import type {PackedLocomotionLibrary} from './animationLibrary.ts';
import {HUMANOID_JOINTS,HUMANOID_RIG_ID} from './humanoidRig.ts';

/** Original procedural starter, independent of imported motion-capture assets.
 * Replace through configureSharedHumanoidLocomotion with your own licensed bank. */
const joints=HUMANOID_JOINTS.map(joint=>joint.name);
const rotationScale=32767,positionScale=10000;
const recipes=[{id:'starter-idle',speed:0,duration:2000,amplitude:0},{id:'starter-walk',speed:1.6,duration:1000,amplitude:.4},{id:'starter-run',speed:4.3,duration:700,amplitude:.7}];
export const DEFAULT_LOCOMOTION_DATA:PackedLocomotionLibrary={
 version:'packed-locomotion-v1',rig:HUMANOID_RIG_ID,joints,unitScale:1,rotationScale,positionScale,yawScale:10000,contactScale:10000,
 frameStride:3+joints.length*4+4+2,source:{name:'PatchGames procedural starter',engineVersion:'procedural-v1',skeleton:HUMANOID_RIG_ID},
 clips:recipes.map(recipe=>{
  const frameCount=17,samples:number[]=[];
  for(let frame=0;frame<frameCount;frame++){
   const t=frame/(frameCount-1),wave=Math.sin(t*Math.PI*2);
   samples.push(0,Math.round((.95+Math.abs(wave)*recipe.amplitude*.04)*positionScale),0);
   for(const joint of joints){
    const side=joint.startsWith('left-')?1:-1;
    const angle=joint.endsWith('-hip')?side*wave*recipe.amplitude:joint.endsWith('-knee')?Math.max(0,-side*wave)*recipe.amplitude:joint.endsWith('-shoulder')?-side*wave*recipe.amplitude*.5:0;
    samples.push(Math.round(Math.sin(angle/2)*rotationScale),0,0,Math.round(Math.cos(angle/2)*rotationScale));
   }
   samples.push(0,0,Math.round(recipe.speed*recipe.duration/1000*t*positionScale),0,wave<=0?10000:0,wave>=0?10000:0);
  }
  // Hashes identify the authored procedural recipes, populated by the export finalizer.
  return{id:recipe.id,sourceName:recipe.id,sourceSha256:recipe.id==='starter-idle'?'82462119b375cade76baf9868f4123cdb8da89bcd7fbf83ca1f066ea44faa3cd':recipe.id==='starter-walk'?'fce70a8d9f8d0a9d1046ca1be78c708cf55d3eeecc62d1810c82a2bf4c9532c4':'40d73b45ee92c160199a21bcc3533ca6cb12f3d2d97e0dcec6c448bbebe38638',durationMs:recipe.duration,loop:true,frameCount,speedMps:recipe.speed,tags:['grounded',recipe.speed?'locomotion':'idle'],samples};
 }),
};
