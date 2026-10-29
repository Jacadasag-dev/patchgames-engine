import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {sharedCreatureCatalog,sharedCreatureAnimations,CreatureAnimationController} from '../src/sandbox/creatureAnimationLibrary.ts';
import {createCreatureModel} from '../src/sandbox/creatureModelView.ts';
import {creatureFootProfile} from '../src/sandbox/creatureFootPlacement.ts';
import {createModStarter} from '../src/sandbox/modStarters.ts';

it('uses neutral and consistent identities for every built-in bank, rig, clip and body',()=>{
 const catalog=sharedCreatureCatalog();expect(catalog).toHaveLength(20);
 for(const entry of catalog){
  expect(entry.id).toMatch(/^creature-[a-z-]+-\d{2}$/);
  expect(entry.label).not.toMatch(/mesh2motion|quaternius|unreal/i);
  expect(entry.rigId).toBe(entry.id+'-v1');
  const bank=sharedCreatureAnimations(entry.id);
  expect(bank.clips.every(clip=>clip.id.startsWith(entry.id+'-'))).toBe(true);
  const actor=createCreatureModel(entry.id);
  expect(actor.meshes.length).toBeGreaterThan(0);
  expect(creatureFootProfile(bank).rigId).toBe(bank.rigId);
  const controller=new CreatureAnimationController(bank);
  expect(controller.sample({timeMs:0,action:bank.clips[0].id}).diagnostics.warnings).toEqual([]);
  actor.dispose();
 }
});
it('provides neutral starter source without compatibility lookups',()=>{
 for(const template of ['creatures','player-appearance'] as const){
  const starter=createModStarter(template,'naming-check',undefined,{actor:'creature'});
  expect(JSON.stringify(starter)).toContain('creature-fox-02');
  expect(JSON.stringify(starter)).not.toMatch(/mesh2motion|quaternius|unreal/i);
 }
 expect(()=>sharedCreatureAnimations('mesh2motion-fox')).toThrow('unknown bank');
 expect(()=>sharedCreatureAnimations('quaternius-fox')).toThrow('unknown bank');
});

it('keeps reproducible source manifests aligned with the runtime catalog',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../third-party/creature-animations/sources.json',import.meta.url),'utf8'));
 const sources=manifest.sources.map((source:{id:string;label:string})=>({id:source.id,label:source.label}));
 expect(sources).toEqual(sharedCreatureCatalog().map(({id,label})=>({id,label})));
});
