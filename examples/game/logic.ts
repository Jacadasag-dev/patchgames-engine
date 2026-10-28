import type {GameLogic} from '../../src/shared/gameApi.ts';
type World={ticks:number};
type Player={x:number;z:number};
type Input={moveX:number;moveZ:number};
type Tuning={maxHp:number;moveSpeed:number};
const game:GameLogic<World,Player,Input,Tuning>={
 mode:'duel',shapes:{world:{ticks:'uint32'},player:{x:'number',z:'number'},input:{moveX:{min:-1,max:1},moveZ:{min:-1,max:1}}},
 setupMatch({world,players,tuning}){world.ticks=0;for(const p of players){p.hp=p.maxHp=tuning.maxHp;p.state.x=p.index*2;p.state.z=0;}},
 step({world,players,inputs,tuning,dtMs}){world.ticks++;for(const p of players){p.state.x+=(inputs[p.index]?.moveX??0)*tuning.moveSpeed*dtMs/1000;p.state.z+=(inputs[p.index]?.moveZ??0)*tuning.moveSpeed*dtMs/1000;}},
 controls:{bindings:[],writeInput(){}},smoothFields:[],hudLines:()=>[],
 describePlayer:({state})=>`Player at ${state.x}, ${state.z}`,
};
export default game;
