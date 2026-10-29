import type {GameLogic,GamePlayer,MatchContext,PlayerList,PlayerBody} from '../shared/gameApi.ts';
import {applyCharacterMovement,moveCharacters} from '../sandbox/characters.ts';
import {shapes,type World,type Player,type Input,type Tuning} from './shapes.ts';
import {world,terrainWorld} from './world.ts';
import {MATERIALS} from './generation.ts';
type Context=MatchContext<World,Player,Tuning>;
const inventory=(m:number):'dirt'|'wood'|'stone'|'planks'|'coal'|'iron'=>m===4?'wood':m===3?'stone':m===10?'planks':m===6?'coal':m===7?'iron':'dirt';
const choices=[2,4,3,10];
function respawn(ctx:Context,p:GamePlayer<Player>){const x=(p.index%4)*2+.5,z=Math.floor(p.index/4)*2+.5;Object.assign(p.state,{physicsId:p.index,x,z,y:world.field(ctx.tuning).surfaceHeight(x,z)+.05,facing:.65,aimPitch:-.12,velocityX:0,velocityY:0,velocityZ:0,grounded:0,mineTime:0,target:''});}
function setupPlayer(ctx:Context,p:GamePlayer<Player>){p.hp=p.maxHp=ctx.tuning.maxHp;Object.assign(p.state,{selected:0,dirt:16,stone:0,wood:0,planks:0,coal:0,iron:0,food:4,pickaxe:0,cooldown:0,mineTime:0,action:0,actionKind:0,heal:false,message:'Gather timber. Craft planks, then a pickaxe.'});respawn(ctx,p);}
function steer(s:Player,i:Input|undefined,t:Tuning){s.facing-=Math.max(-1000,Math.min(1000,i?.lookX??0))*t.lookSpeed;s.aimPitch=Math.max(-1.5,Math.min(1.5,s.aimPitch-(i?.lookY??0)*t.lookSpeed));const x=Math.sin(s.facing),z=Math.cos(s.facing);applyCharacterMovement(s,{moveX:x*(i?.moveZ??0)-z*(i?.moveX??0),moveZ:z*(i?.moveZ??0)+x*(i?.moveX??0)},t.moveSpeed*(i?.sprint?1.45:1));if(i?.jump&&s.grounded){s.velocityY=t.jumpSpeed;s.grounded=0;}}
export const game:GameLogic<World,Player,Input,Tuning>={
 mode:'just-chatting',supportedModes:['just-chatting'],
 terrainWorld,featureCapabilities:['player.position.v1','player.vertical-motion.v1','player.appearance.v1','world.terrain.v1'],shapes,
 setupMatch(ctx){ctx.world.elapsedMs=0;ctx.world.edits=[];ctx.world.terrainRevision=terrainWorld.read(ctx.tuning).revision;for(const p of ctx.players)setupPlayer(ctx,p);},setupPlayer,respawnPlayer:respawn,
 step(ctx){const {tuning,players,inputs}=ctx,f=world.field(tuning),snapshot=terrainWorld.read(tuning);ctx.world.elapsedMs=ctx.elapsedMs;ctx.world.terrainRevision=snapshot.revision;
  for(const p of players){const s=p.state,i=inputs[p.index];s.heal=false;s.cooldown=Math.max(0,s.cooldown-ctx.dtMs);if(p.active===false||p.hp<=0)continue;
   steer(s,i,tuning);if(i?.next)s.selected=(s.selected+1)%choices.length;
   if(i?.craft){if(s.planks>=4&&!s.pickaxe){s.planks-=4;s.pickaxe=1;s.message='Wooden pickaxe crafted. Stone and ore are mineable.';}else if(s.wood>0){s.wood--;s.planks+=4;s.message='Crafted four planks.';}else if(s.pickaxe===1&&s.stone>=3){s.stone-=3;s.pickaxe=2;s.message='Stone pickaxe crafted.';}else s.message='Need timber for planks, four planks for a pickaxe, or three stone to upgrade.';}
   if(i?.eat&&s.food>0&&p.hp<p.maxHp){s.food--;s.heal=true;s.action++;s.actionKind=3;s.message='Ate an apple.';}
   const dir={x:Math.sin(s.facing)*Math.cos(s.aimPitch),y:Math.sin(s.aimPitch),z:Math.cos(s.facing)*Math.cos(s.aimPitch)},hit=f.raycast({x:s.x+Math.sin(s.facing)*.26,y:s.y+1.6,z:s.z+Math.cos(s.facing)*.26},dir,6);
   const target=hit?`${hit.block.x}:${hit.block.y}:${hit.block.z}`:'';
   if(target!==s.target){s.target=target;s.mineTime=0;}
   if(!i?.mine)s.mineTime=0;
   const stone=hit&&[3,6,7].includes(hit.material);
   if(i?.mine&&hit&&s.cooldown===0){if(stone&&!s.pickaxe){s.message='Craft a pickaxe before mining stone.';s.mineTime=0;}else{s.mineTime+=ctx.dtMs;}}
   const required=stone?(s.pickaxe===2?280:650):hit?.material===4?500:200;
   const mining=!!(i?.mine&&hit&&s.mineTime>=required&&s.cooldown===0);
   if((mining||i?.place)&&hit&&s.cooldown===0){const pos=mining?hit.block:hit.previous,material=mining?0:choices[s.selected],item=inventory(material);
    if(!f.inside(pos.x,pos.y,pos.z)||pos.y===f.bounds.minY){s.message='Bedrock and the world boundary cannot be changed.';continue;}
    if(!snapshot.available(pos.x+.5,pos.z+.5,.6)){s.message='Waiting for this chunk to load.';continue;}
    if(!mining&&s[item]===0){s.message='Gather more '+MATERIALS[material]+'.';continue;}
    if(!mining&&players.some(q=>q.active!==false&&q.hp>0&&Math.abs(q.state.x-pos.x-.5)<.87&&Math.abs(q.state.z-pos.z-.5)<.87&&q.state.y<pos.y+1&&q.state.y+1.8>pos.y)){s.message='That space is occupied.';continue;}
    const next=ctx.world.edits.filter(e=>e.x!==pos.x||e.y!==pos.y||e.z!==pos.z);if(next.length>=256){s.message='This session reached its edit budget.';continue;}
    next.push({...pos,material});f.setEdits(next);
    try{f.assertEditBudget();}catch{f.setEdits(ctx.world.edits);s.message='This session reached its collision edit budget.';continue;}
    ctx.world.edits=next;ctx.world.terrainRevision='';s.action++;s.actionKind=mining?1:2;s.actionX=pos.x+.5;s.actionY=pos.y+.5;s.actionZ=pos.z+.5;s.mineTime=0;s.cooldown=180;
    if(mining){if(hit.material===5){s.food++;s.message='Found an apple in the leaves.';}else{s[inventory(hit.material)]++;s.message='Collected '+MATERIALS[hit.material]+'.';}}
    else{s[item]--;s.message='Placed '+MATERIALS[material]+'.';}
   }
  }
  moveCharacters(players.filter(p=>p.active!==false&&p.hp>0).map(p=>p.state),ctx.dtMs/1000,tuning,snapshot.scene);
  for(const p of players)if(p.state.y<-9)respawn(ctx,p);
 },
 entities({players,tuning}){return{bodies:players.map(p=>({at:{x:p.state.x,y:p.state.y,z:p.state.z},radius:tuning.fighterRadius,height:tuning.fighterHeight})) as unknown as PlayerList<PlayerBody>,damage:[],healing:players.filter(p=>p.state.heal).map(p=>({id:`apple:${p.index}:${p.state.action}`,label:'apple',owner:p.index,target:p.index,amount:30,at:{x:p.state.x,y:p.state.y+.8,z:p.state.z},radius:1}))};},
 describePlayer:p=>p.hp<=0?'RESPAWNING':p.state.mineTime>0?'MINING':p.state.grounded?'EXPLORING':'AIRBORNE',
 controls:{pointer:{mode:'lock',cursor:'hidden'},inspection:{forward:{moveZ:1},right:{moveX:1},jump:{jump:true},attack:{mine:true}},bindings:[
 {name:'moveX',label:'Strafe',kind:'axis',role:'move-x',keys:['a','d']},{name:'moveZ',label:'Walk',kind:'axis',role:'move-y',keys:['s','w']},{name:'jump',label:'Jump',kind:'held',keys:[' ']},
 {name:'mine',label:'Mine',kind:'held',mouse:0,description:'Hold to mine the targeted block. Stone requires a crafted pickaxe.'},{name:'place',label:'Place block',kind:'tap',mouse:2,description:'Place your selected material on the targeted face.'},
 {name:'next',label:'Next material',kind:'tap',keys:['q']},{name:'craft',label:'Craft',kind:'tap',keys:['c'],description:'Timber makes four planks. Four planks make a pickaxe. Three stone upgrade it.'},{name:'eat',label:'Eat apple',kind:'tap',keys:['e']},{name:'sprint',label:'Sprint',kind:'held',keys:['shift']}],
 writeInput(i,b){i.moveX=b.value('moveX');i.moveZ=b.value('moveZ');i.lookX=b.pointer.deltaX;i.lookY=b.pointer.deltaY;i.jump=b.held('jump');i.mine=b.held('mine');i.place=b.tapped('place');i.next=b.tapped('next');i.craft=b.tapped('craft');i.eat=b.tapped('eat');i.sprint=b.held('sprint');}},
 prediction:{fields:['x','y','z','facing','aimPitch','velocityX','velocityY','velocityZ','grounded'],snapFields:['x','y','z'],step(s,i,dt,{tuning,opponents,opponent}){steer(s,i,tuning);moveCharacters([s,...(opponents??(opponent?[opponent]:[])).map(p=>({...p}))],dt,tuning,terrainWorld.read(tuning).scene);}},
 smoothFields:['x','y','z','facing','aimPitch'],
 hudLines(frame){const p=frame.players.find(p=>p.isLocal)?.state;return p?[`${MATERIALS[choices[p.selected]]} selected • Dirt ${p.dirt} • Timber ${p.wood} • Stone ${p.stone} • Planks ${p.planks}`,`Apples ${p.food} • ${p.pickaxe===2?'Stone pickaxe':p.pickaxe?'Wooden pickaxe':'Bare hands'} • Coal ${p.coal} • Iron ${p.iron}`,p.message]:[];},
};export default game;

