import type {GameUiDocument} from '../shared/gameUi.ts';
import type {ViewFrame} from '../shared/gameApi.ts';
import type {World,Player,Tuning} from './shapes.ts';
const materials=['Dirt','Timber','Stone','Planks'] as const;
export function voxelUi(frame:ViewFrame<World,Player,Tuning>):GameUiDocument|null{
 const player=frame.players.find(p=>p.isLocal);if(!player)return null;const s=player.state;
 return{version:1,defaults:{health:false,timer:false,status:false,info:false,crosshair:false},panels:[
  {id:'voxel:health',role:'health',width:180,height:66,children:[{kind:'bar',label:'Health',value:Math.max(0,player.hp),max:Math.max(1,player.maxHp),tone:'health'}]},
  {id:'voxel:inventory',role:'inventory',presentation:'hud',region:'bottom-center',width:420,height:100,children:[{kind:'row',children:materials.map((name,i)=>({kind:'text',text:`${name} ${[s.dirt,s.wood,s.stone,s.planks][i]}`,tone:i===s.selected?'accent':'muted'}))},{kind:'text',text:`Apples ${s.food} · ${s.pickaxe===2?'Stone pickaxe':s.pickaxe?'Wooden pickaxe':'Bare hands'}`,tone:'muted'},...(s.mineTime>0?[{kind:'bar' as const,label:'Mining',value:Math.min(1,s.mineTime/650),max:1,tone:'energy' as const}]:[])]},
  {id:'voxel:status',role:'objective',width:360,height:54,children:[{kind:'text',text:s.message}]},
  {id:'voxel:crosshair',role:'crosshair',width:22,height:22,children:[{kind:'crosshair',shape:'plus',color:'#fff8dd'}]}
 ]};
}
