import {beforeAll,expect,it} from 'vitest';
import {buildLogic} from '../../src/sandbox/host/build.ts';
import {describeGame,initSandbox,withGameRules} from '../../src/sandbox/host/game.ts';
import {MatchSandbox,type MatchUpdate} from '../../src/sandbox/host/match.ts';
import {advanceRound,initialRound,parseRoundRules} from '../../src/shared/roundSeries.ts';
let game:ReturnType<typeof describeGame>;
beforeAll(async()=>{await initSandbox();game=withGameRules(describeGame(buildLogic(process.cwd(),'tests/core/fixtures/round-series')),['team']);});
const health=(u:MatchUpdate)=>u.players.map(p=>({hp:p.hp!,maxHp:p.maxHp!}));
it('keeps a planted objective alive after attacker elimination, then resets health, carries economy and switches sides',()=>{
  const host=new MatchSandbox(game,'offline');
  try{let u=host.setup({},17,10);let now=0;
    const tick=(input:unknown={},hp=health(u),dt=34)=>u=host.step([input,...Array(9).fill(undefined)],dt,now+=dt,hp);
    tick({arm:true,spend:true});expect(u.players[0].state.credits).toBe(80);
    tick({},health(u).map((p,i)=>({...p,hp:i%2?100:0})));expect((u.world.round as any).phase).toBe(0);expect(u.teamObjective).toBeUndefined();
    tick({award:true,team:1});
    expect((u.world.round as any).phase).toBe(0);
    u=host.step([undefined,{award:true,team:1},...Array(8).fill(undefined)],34,now+=34,health(u));
    expect((u.world.round as any)).toMatchObject({phase:1,scoreB:1});
    tick({},health(u),100);expect(u.players.every(p=>p.hp===100)).toBe(true);expect(u.players[0].state.credits).toBe(90);
  }finally{host.dispose();}
});
it('runs multiple objective rounds in one sandbox and only ends the host match at the win target',()=>{
  const host=new MatchSandbox(game,'offline');
  try{let u=host.setup({},17,10),now=0;
    const tick=(input:unknown={},dt=34)=>u=host.step([input,...Array(9).fill(undefined)],dt,now+=dt,health(u));
    tick({spend:true,award:true,team:0});expect((u.world.round as any).phase).toBe(1);expect(u.teamObjective).toBeUndefined();
    tick({},100);expect((u.world.round as any)).toMatchObject({number:2,phase:0,scoreA:1,attackingTeam:1});expect(u.players[0].state.credits).toBe(90);expect(u.players.every(p=>p.hp===100)).toBe(true);
    tick({award:true,team:0});expect((u.world.round as any)).toMatchObject({phase:2,scoreA:2});expect(u.teamObjective).toBe(0);
  }finally{host.dispose();}
});
it('resolves normal team elimination and retains an unresolved attacking objective even with nobody alive',()=>{
 const state=initialRound(),rules=parseRoundRules({stateField:'round',winsToMatch:2,intermissionMs:100})!;
 advanceRound(state,rules,34,[{hp:0},{hp:100}],[0,1],undefined,0);expect(state.phase).toBe(0);
 advanceRound(state,rules,34,[{hp:0},{hp:0}],[0,1],undefined,0);expect(state.phase).toBe(0);
 advanceRound(state,rules,34,[{hp:0},{hp:0}],[0,1],0,0);expect(state).toMatchObject({phase:1,scoreA:1,winner:0});
});
it('rejects malformed or unbounded round settings',()=>{
 expect(()=>parseRoundRules({stateField:'round',winsToMatch:0,intermissionMs:100})).toThrow();
 expect(()=>parseRoundRules({stateField:'round',winsToMatch:2,intermissionMs:100,carryWorldFields:['round']})).toThrow();
});
