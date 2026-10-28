import type {GameLogic} from '../../../../src/shared/gameApi.ts';
import {roundStateShape,type RoundState} from '../../../../src/shared/roundSeries.ts';
type World={round:RoundState;objective:number;pending:number};
type Player={x:number;credits:number};
const game:GameLogic<World,Player,{award:boolean;team:number;arm:boolean;spend:boolean},Record<string,number>>={
  playerClasses:Array.from({length:5},(_,i)=>({id:'class'+i,label:'Class '+i,description:'Test role '+i})),
  mode:'just-chatting',shapes:{world:{round:roundStateShape,objective:'int8',pending:'int8'},player:{x:'number',credits:'number'},input:{award:'boolean',team:{min:0,max:1},arm:'boolean',spend:'boolean'}},
  rounds:{stateField:'round',winsToMatch:2,intermissionMs:100,sideSwitchEvery:1,carryPlayerFields:['credits']},
  setupMatch({world,players}){world.objective=-1;world.pending=-1;for(const p of players){p.hp=p.maxHp=100;p.state.x=p.index;p.state.credits=world.round.number===1?100:p.state.credits+10;}},
  step({world,players,inputs}){const award=inputs.find(i=>i?.award);if(award)world.objective=award.team;if(inputs[0]?.arm)world.pending=0;if(inputs[0]?.spend)players[0].state.credits-=20;},
  teamObjective:({world})=>world.objective<0?undefined:world.objective,
  pendingTeamObjective:({world})=>world.pending<0?undefined:world.pending,
  describePlayer:()=>'',controls:{bindings:[],writeInput(){}},smoothFields:[],hudLines:()=>[],
};export default game;
