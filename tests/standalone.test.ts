import {expect,it} from 'vitest';
import {runExample} from '../examples/headless.ts';
import {sharedHumanoidLocomotion} from '../src/sandbox/animationLibrary.ts';
it('builds and runs authored game code without the hosted PatchGames service',async()=>{
 expect((await runExample()).ticks).toBe(60);
});
it('ships usable original procedural locomotion',()=>{
 const clips=sharedHumanoidLocomotion();
 expect(clips.map(clip=>clip.id)).toEqual(['starter-idle','starter-walk','starter-run']);
 expect(clips[1].trajectory(0,1000).position.z).toBeCloseTo(1.6);
});
