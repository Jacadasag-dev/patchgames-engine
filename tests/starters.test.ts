import {beforeAll,afterAll,expect,it} from 'vitest';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {listEngineStarters,readEngineStarter,installEngineStarter} from '../tools/starters.ts';import {materializeEngine} from '../tools/materialize-engine.ts';
import {buildLogic,buildView} from '../src/sandbox/host/build.ts';import {initSandbox,describeGame,withGameRules} from '../src/sandbox/host/game.ts';import {MatchSandbox} from '../src/sandbox/host/match.ts';import type {GameTagId} from '../src/shared/gameTags.ts';import {runGameTests} from '../src/sandbox/host/gameTests.ts';
const engine=resolve(import.meta.dirname,'..'),roots:string[]=[];
function project(id:Parameters<typeof installEngineStarter>[0]){const root=mkdtempSync(join(tmpdir(),'engine-starter-'));roots.push(root);writeFileSync(join(root,'package.json'),JSON.stringify({dependencies:{'@patchgames/engine':'test'}}));materializeEngine({root,engineRoot:engine});installEngineStarter(id,root);return root;}
beforeAll(async()=>{await initSandbox();});afterAll(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true});});
it('ships six complete starters and keeps the blank canvas explicit',()=>{expect(listEngineStarters().map(s=>s.id)).toEqual(['duel','arena','rpg','social','fps','voxel-survival']);expect(listEngineStarters({includeBlank:true})).toHaveLength(7);for(const s of listEngineStarters())expect(Object.keys(readEngineStarter(s.id).files)).toEqual(expect.arrayContaining(['src/game/logic.ts','src/game/view.ts','src/game/tuning.json']));});
for(const starter of listEngineStarters())it(`${starter.id} builds logic/view and runs multiple players`,()=>{
 const root=project(starter.id), loaded=withGameRules(describeGame(buildLogic(root)),starter.tags as GameTagId[]);expect(buildView(root).length).toBeGreaterThan(100);
 const tuning=JSON.parse(readEngineStarter(starter.id).files['src/game/tuning.json']);const count=starter.id==='fps'?10:starter.id==='rpg'?3:2;const match=new MatchSandbox(loaded,'offline');
 try{let state=match.setup(tuning,7,count,loaded.info.playerClasses?Array.from({length:count},(_,i)=>loaded.info.playerClasses![i%loaded.info.playerClasses!.length].id):undefined);
 for(let tick=1;tick<=10;tick++)state=match.step(Array.from({length:count},()=>Object.fromEntries(loaded.info.input.map(([name,kind])=>[name,kind.kind==='boolean'?false:Math.max(kind.min,Math.min(kind.max,0))]))),50,tick*50,state.players.map(p=>({hp:p.hp??100,maxHp:p.maxHp??100})));
 expect(state.players).toHaveLength(count);expect(JSON.stringify(state)).not.toMatch(/NaN|Infinity/);
 }finally{match.dispose();}
},60000);
it('runs the tactical FPS authored mechanics, map and UI tests in the sandbox',async()=>{const results=await runGameTests(project('fps'));expect(results.length).toBeGreaterThan(0);for(const file of results){expect(file.error,file.file).toBeUndefined();for(const result of file.results)expect(result.error,result.name).toBeUndefined();}},60000);

it('runs voxel terrain, crafting and concurrent mining/movement checks',async()=>{const results=await runGameTests(project('voxel-survival'));for(const file of results){expect(file.error,file.file).toBeUndefined();for(const result of file.results)expect(result.error,result.name).toBeUndefined();}},60000);

it('compiles feature imports from the generated host starter directory',()=>{const root=project('fps');expect(buildLogic(root,'src/gameModes/fps').length).toBeGreaterThan(100);expect(buildView(root,'src/gameModes/fps').length).toBeGreaterThan(100);},60000);
