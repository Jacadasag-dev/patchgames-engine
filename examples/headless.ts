import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {buildLogic} from '../src/sandbox/host/build.ts';
import {initSandbox,describeGame} from '../src/sandbox/host/game.ts';
import {MatchSandbox} from '../src/sandbox/host/match.ts';

/** Two independently supplied input streams, one authoritative sandbox. */
export async function runExample(){
 await initSandbox();
 const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
 const game=describeGame(buildLogic(root,'examples/game'));
 const match=new MatchSandbox(game,'offline');
 try{
  const tuning={maxHp:100,moveSpeed:5};
  let update=match.setup(tuning,42,2);
  for(let tick=1;tick<=60;tick++)update=match.step([{moveX:1,moveZ:0},{moveX:0,moveZ:1}],1000/30,tick*1000/30,update.players.map(p=>({hp:p.hp??100,maxHp:p.maxHp??100})));
  assert.equal(update.world.ticks,60);
  assert.ok(Math.abs(Number(update.players[0].state.x)-10)<1e-8);
  assert.ok(Math.abs(Number(update.players[1].state.z)-10)<1e-8);
  return{ticks:update.world.ticks,players:update.players.map(p=>p.state)};
 }finally{match.dispose();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runExample(),null,2));
