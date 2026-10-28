import { defineModel, repeatModelPart, type ModelDefinition, type ModelPart } from './model.ts';
import type { RigPose } from './rig.ts';

export type ModelStarter = 'quadruped' | 'humanoid' | 'prop';
/** Low-level model-definition examples for props or custom construction.
 * For a complete animated character, prefer createModStarter('player-appearance', ...)
 * or createModStarter('creatures', ...): those include shared detailed rigs, motion
 * matching, semantic actions, lifecycle and inspection. These legacy part rigs do
 * not automatically inherit humanoid-v1 or a creature bank's rest skeleton.
 * Replace, split, add or remove parts freely; update attachments and clip tracks. */
export function createModelStarter(kind: ModelStarter, name = 'myModel'): ModelDefinition {
  const color = 0x929aa3;
  const body: ModelPart = {name:'body',size:{x:.8,y:.6,z:1.2},position:{x:0,y:.8,z:0},color,collision:true};
  const idle = {durationMs:1000,loop:true,keyframes:[{atMs:0,pose:{}},{atMs:1000,pose:{}}]};
  if (kind === 'prop') return defineModel({name,root:'body',parts:[{...body,size:{x:1,y:1,z:1},position:{x:0,y:.5,z:0}}],grounding:{parts:['body']},animations:{idle}});
  const names = kind === 'quadruped' ? ['frontLeft','frontRight','backLeft','backRight'] : ['leftLeg','rightLeg'];
  const legHeight = kind === 'quadruped' ? .5 : .8;
  const legs = repeatModelPart({size:{x:.15,y:legHeight,z:.15},attach:{part:'body',face:'bottom',mode:'joint'},color},names.map((leg,i) => ({name:leg,offset:{x:kind === 'quadruped' ? 0 : i%2 ? .25 : -.25,y:0,z:0}})));
  // Relative corner placement follows changes to body/leg dimensions automatically.
  if (kind === 'quadruped') legs.forEach((leg,i) => {
    leg.attach!.align = {x:i%2 ? .8 : -.8,z:i<2 ? .8 : -.8};
  });
  const parts: ModelPart[] = [body,...legs];
  if (kind === 'quadruped') parts.push(
    {name:'head',size:{x:.4,y:.4,z:.4},attach:{part:'body',face:'front',mode:'joint'},color},
    {name:'tail',size:{x:.12,y:.12,z:.4},attach:{part:'body',face:'back',mode:'joint'},color},
  );
  else if (kind === 'humanoid') {
    body.size = {x:.7,y:.9,z:.35}; body.position = {x:0,y:1.25,z:0};
    parts.push({name:'head',shape:'sphere',size:{x:.36,y:.36,z:.36},attach:{part:'body',face:'top'},color},
      {name:'leftArm',size:{x:.18,y:.7,z:.18},attach:{part:'body',face:'left',align:{y:1},mode:'joint'},color},
      {name:'rightArm',size:{x:.18,y:.7,z:.18},attach:{part:'body',face:'right',align:{y:1},mode:'joint'},color});
  } else throw new Error('Unknown model starter');
  const stride = (direction: number): RigPose => Object.fromEntries(names.map((leg,i) => [leg,{rotate:{x:(i===0 || i===3 ? 1 : -1)*20*direction}}]));
  return defineModel({name,root:'body',parts,grounding:{parts:names},animations:{idle,walk:{durationMs:1000,loop:true,keyframes:[{atMs:0,pose:stride(1)},{atMs:500,pose:stride(-1)},{atMs:1000,pose:stride(1)}]}}});
}
