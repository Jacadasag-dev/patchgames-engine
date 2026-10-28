import { gameModeLabel, isSessionMode } from '../../shared/gameModes.ts';
import {rulesOf} from '../../shared/gameTags.ts';
import { withGameMode, type LoadedGame } from './game.ts';
import {createHash} from 'node:crypto';
import { MatchSandbox, type MatchUpdate } from './match.ts';

export const COMPATIBILITY_SEEDS = [17, 91, 4093];
export const COMPATIBILITY_STEPS = 120;
/** Exercise declared controls, boundaries and combinations. Each seeded trace
 * runs twice in independent sandboxes. This is evidence, not proof that every
 * possible gameplay interaction is compatible. Never runs game code in Node. */
export function probeCompatibility(game:LoadedGame,tuning:Record<string,number>) {
  for(const mode of game.info.supportedModes??[game.info.mode]) probeMode(mode===game.info.mode&&game.info.tags?game:withGameMode(game,mode),tuning);
}
function probeMode(game:LoadedGame,tuning:Record<string,number>) {
  const {minPlayers,maxPlayers}=rulesOf(game.info);
  for(const count of new Set([minPlayers,maxPlayers]))probeRoster(game,tuning,count);
}
function probeRoster(game:LoadedGame,tuning:Record<string,number>,playerCount:number) {
  for(const seed of COMPATIBILITY_SEEDS){
    const traces:string[][]=[];
    for(let run=0;run<2;run++){
      const match=new MatchSandbox(game,'offline'),trace:string[]=[];
      try{
        let state=match.setup(tuning,seed,playerCount);trace.push(stateKey(state));
        for(let step=0;step<COMPATIBILITY_STEPS;step++){
          const inputs=state.players.map((_,player)=>Object.fromEntries(game.info.input.map(([name,field],index)=>{
            const phase=(Math.floor(step/4)+index+player)%4;
            return [name,field.kind==='boolean'?phase<2:phase===0?field.min:phase===1?field.max:phase===2?(field.min+field.max)/2:Math.max(field.min,Math.min(field.max,0))];
          })));
          const health=state.players.map(p=>({hp:p.hp??tuning.maxHp,maxHp:p.maxHp??tuning.maxHp}));
          state=match.step(inputs,1000/30,(step+1)*1000/30,health,!isSessionMode(game.info.mode)&&step>=100);
          trace.push(stateKey(state));
        }
      }finally{match.dispose();}
      traces.push(trace);
    }
    if(traces[0].some((state,index)=>state!==traces[1][index]))throw new Error(`Combined mods produced inconsistent ${gameModeLabel(game.info.mode)} replay state for seed ${seed}.`);
  }
}
function stateKey({players,world,events,hits}:MatchUpdate){return createHash('sha256').update(JSON.stringify({players,world,events,hits})).digest('hex');}
