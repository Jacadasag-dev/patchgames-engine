import {describe,it,expect,newMatch,stepMatch} from '../../src/sandbox/testkit.ts';
import game from '../../src/game/logic.ts';import tuning from '../../src/game/tuning.json';import {sample} from '../../src/game/generation.ts';
const fresh=()=>newMatch(game,tuning,2,'just-chatting',undefined,{tags:['survival']});
const input=(extra={})=>({moveX:0,moveZ:0,lookX:0,lookY:0,jump:false,mine:false,place:false,next:false,craft:false,eat:false,sprint:false,...extra});
describe('voxel survival starter',()=>{
 it('spawns separate players with starter inventory',()=>{const m=fresh();expect(m.players.length).toBe(2);expect(m.players[0].state.x===m.players[1].state.x).toBe(false);expect(m.players[0].state.dirt).toBe(16);});
 it('generates the same terrain independently of traversal order',()=>{const a=sample(4,0,8,173);sample(100,4,-70,173);expect(sample(4,0,8,173)).toBe(a);});
 it('crafts planks and a pickaxe from acquired timber',()=>{const m=fresh();m.players[0].state.wood=1;stepMatch(game,m,[input({craft:true}),input()],50);expect(m.players[0].state.planks).toBe(4);stepMatch(game,m,[input({craft:true}),input()],50);expect(m.players[0].state.pickaxe).toBe(1);expect(m.players[0].state.planks).toBe(0);});
 it('mines while another player can keep moving',()=>{const m=fresh();m.players[0].state.aimPitch=-1.4;const z=m.players[1].state.z;for(let i=0;i<20;i++)stepMatch(game,m,[input({mine:true}),input({moveZ:1})],50);expect(m.world.edits.length>0).toBe(true);expect(m.players[1].state.z===z).toBe(false);});
});
