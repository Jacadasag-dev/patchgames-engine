import type {GameLogic,GamePlayer,MatchContext,DamageEntity,PlayerList,PlayerBody} from '../shared/gameApi.ts';
import {applyCharacterMovement,moveCharacters} from '../sandbox/characters.ts';
import {preparePhysics,raycastPhysics} from '../sandbox/physics.ts';
import {groundPhysics,SITES,DEFENDER_NESTS} from './ground.ts';
import {shapes,createInput,type PlayerState,type WorldState,type BlankInput} from './shapes.ts';
import {applyBlankLook,BLANK_POINTER_LOOK} from './look.ts';
import type {GameTuning} from './tuning.ts';
import {createFirearmRecoilState,fireFirearm,recoverFirearm,traceFirearm,firearmDamage,firearmPelletDirections,firearmMuzzle,FIREARM_LENGTHS} from '../sandbox/firearms.ts';
import {OPERATORS,GUNS,GUN_RECOIL,ARMOR_LIGHT,SHOP_ITEMS,BUY_MS,ROUND_MS,BOMB_MS,PLANT_MS,DEFUSE_MS} from './catalog.ts';
type Ctx=MatchContext<WorldState,PlayerState,GameTuning>;
const dist=(a:{x:number,z:number},b:{x:number,z:number})=>Math.hypot(a.x-b.x,a.z-b.z);
function steerPlayer(s:PlayerState,i:BlankInput|undefined,t:GameTuning){
applyBlankLook(s,s.shop?undefined:i,t);const speed=t.moveSpeed*(s.aim?.65:1)*(s.slow>0?.48:1)*(s.boost>0?1.8:1);
const a=s.shop?0:i?.moveZ??0,b=s.shop?0:i?.moveX??0;
applyCharacterMovement(s,{moveX:Math.sin(s.facing)*a-Math.cos(s.facing)*b,moveZ:Math.cos(s.facing)*a+Math.sin(s.facing)*b},speed);
if(i?.jump&&s.grounded&&!s.shop){s.velocityY=t.jumpSpeed;s.grounded=0;}
}
export function movePlayer(s:PlayerState,i:BlankInput|undefined,dt:number,t:GameTuning,others:readonly PlayerState[]=[]){steerPlayer(s,i,t);moveCharacters([s,...others.map(o=>({...o}))],dt,t,groundPhysics);}
function equip(s:PlayerState,w:number){s.weapon=w;s.ammo=GUNS[w].mag;s.reserve=GUNS[w].reserve;s.reload=0;}
function setupPlayer(ctx:Ctx,p:GamePlayer<PlayerState>){
const s=p.state,r=ctx.world.round,pistol=r.number<=1?0:s.stash.pistol;s.recoil=createFirearmRecoilState(); const team=p.team??p.index%2, attack=team===r.attackingTeam;
s.physicsId=p.index;s.x=(Math.floor(p.index/2)-2)*2.1;s.z=attack?-39:39;s.y=0;s.facing=attack?0:Math.PI;s.aimPitch=0;
s.velocityX=s.velocityY=s.velocityZ=0;s.grounded=1;p.hp=p.maxHp=100;
s.operator=Math.max(0,OPERATORS.findIndex(o=>o.id===p.classId));s.credits=r.number<=1?800:Math.min(9000,s.credits+(r.winner===team?3000:2100));
s.armor=0;s.primary=r.number<=1?0:s.primary;s.skillA=s.skillB=s.boost=s.slow=s.reveal=s.cloak=s.channel=s.cooldown=0;s.shop=false;s.selection=1;s.aim=false;s.third=false;s.stash.notice='';s.stash={pistol,pistolAmmo:GUNS[pistol].mag,pistolReserve:GUNS[pistol].reserve,primaryAmmo:GUNS[s.primary].mag,primaryReserve:GUNS[s.primary].reserve,notice:''};equip(s,s.primary||pistol);
}
export function purchase(s:PlayerState){const q=s.selection;if(!Number.isInteger(q)||q<0||q>=SHOP_ITEMS)return;const cost=q<GUNS.length?GUNS[q].cost:q===ARMOR_LIGHT?400:1000;if(s.credits<cost){s.stash.notice='Insufficient credits';return;}
if(q>=GUNS.length&&s.armor>=(q===ARMOR_LIGHT?25:50)){s.stash.notice='Armor already equipped';return;}s.credits-=cost;
if(q<GUNS.length){if(GUNS[q].slot==='sidearm'){s.stash.pistol=q;s.stash.pistolAmmo=GUNS[q].mag;s.stash.pistolReserve=GUNS[q].reserve;}else{s.primary=q;s.stash.primaryAmmo=GUNS[q].mag;s.stash.primaryReserve=GUNS[q].reserve;}equip(s,q);}else s.armor=q===ARMOR_LIGHT?25:50;
s.stash.notice=q<GUNS.length?GUNS[q].name+' equipped':'Armor equipped';}
function effect(ctx:Ctx,p:GamePlayer<PlayerState>,kind:number,radius:number,life:number,forward=7){const s=p.state;ctx.world.effects.push({id:++ctx.world.serial,kind,owner:p.index,x:s.x+Math.sin(s.facing)*forward,z:s.z+Math.cos(s.facing)*forward,radius,life});}
export function ability(ctx:Ctx,p:GamePlayer<PlayerState>,slot:number){
const s=p.state,key=slot===0?'skillA':'skillB';if(s[key]>0)return;s[key]=slot===0?18000:22000;
const kind=s.operator*2+slot;
if(kind===0)effect(ctx,p,0,4,9000);
if(kind===1){s.boost=900;s.stash.notice='Slipstream';}
if(kind===2){effect(ctx,p,2,22,2000,0);for(const t of ctx.players)if(t.team!==p.team&&dist(s,t.state)<22)t.state.reveal=6500;}
if(kind===3)effect(ctx,p,3,5,6000);
if(kind===4)effect(ctx,p,4,4,6000);
if(kind===5)effect(ctx,p,5,5,250,5);
if(kind===6)effect(ctx,p,6,3,9000,5);
if(kind===7){s.armor=Math.min(75,s.armor+35);effect(ctx,p,7,1,1200,0);}
if(kind===8)effect(ctx,p,8,1,9000,5);
if(kind===9){s.cloak=6500;effect(ctx,p,9,1,700,0);}
}
function fire(ctx:Ctx,p:GamePlayer<PlayerState>){const s=p.state,w=GUNS[s.weapon];if(s.cooldown>0||s.reload>0||s.ammo<=0)return;s.ammo--;s.cooldown=w.interval;s.cloak=0;
const origin={x:s.x,y:s.y+ctx.tuning.fighterHeight*.9,z:s.z};
const shot=fireFirearm(s.recoil,GUN_RECOIL[s.weapon],{weapon:s.weapon,nowMs:ctx.world.elapsedMs,random:()=>ctx.random('recoil:'+p.index),yaw:s.facing,pitch:s.aimPitch,speed:Math.hypot(s.velocityX,s.velocityZ),airborne:!s.grounded,ads:s.aim});
const muzzle=firearmMuzzle(origin,shot.direction,{forward:.16+FIREARM_LENGTHS[w.kind]*.82});const group=++ctx.world.serial;for(const direction of firearmPelletDirections(shot.direction,shot.seed+shot.shotIndex,w.pellets,w.cone)){const impact=traceFirearm({origin,muzzle,direction,range:100,
 targets:ctx.players.filter(t=>t.index!==p.index&&t.hp>0&&t.active!==false&&t.team!==p.team).map(t=>({id:t.index,position:t.state,facing:t.state.facing,radius:.4,height:ctx.tuning.fighterHeight})),
 raycast:(at,direction,distance)=>{let hit=raycastPhysics({scene:groundPhysics,origin:at,direction,distance});for(const e of ctx.world.effects)if(e.kind===6&&ctx.players[e.owner].team!==p.team){const dx=e.x-at.x,dz=e.z-at.z,t=dx*direction.x+dz*direction.z;if(t>0&&t<(hit?.distance??distance)&&Math.hypot(dx-direction.x*t,dz-direction.z*t)<e.radius)hit={distance:t,normal:{x:-direction.x,y:0,z:-direction.z}};}return hit;}});
ctx.world.shots.push({id:++ctx.world.serial,group,owner:p.index,target:impact.target,x:muzzle.x,y:muzzle.y,z:muzzle.z,ex:impact.point.x,ey:impact.point.y,ez:impact.point.z,nx:impact.normal.x,ny:impact.normal.y,nz:impact.normal.z,surface:impact.surface,timeMs:ctx.world.elapsedMs,weapon:s.weapon,region:impact.region==='head'?1:impact.region==='arm'?2:impact.region==='leg'?3:0,damage:firearmDamage(w.damage,impact.region??'torso',impact.distance,{head:w.head,arm:.9,leg:w.leg,falloffStart:w.near,falloffEnd:w.far,minimum:w.floor})});}
}
const game:GameLogic<WorldState,PlayerState,BlankInput,GameTuning>={
mode:'just-chatting',featureCapabilities:['player.position.v1','player.vertical-motion.v1','player.appearance.v1'],
playerClasses:OPERATORS.map(o=>({id:o.id,label:o.name,description:o.description})),
rounds:{stateField:'round',winsToMatch:5,intermissionMs:4500,sideSwitchEvery:4,carryPlayerFields:['credits','primary','stash'],carryWorldFields:['serial']},
shapes,setupPlayer,
setupMatch(ctx){preparePhysics(groundPhysics);const w=ctx.world;w.elapsedMs=0;w.winner=-1;w.reason='';w.effects=[];w.shots=[];w.kills=[];w.bomb={state:0,carrier:-1,x:0,z:-39,timer:0,progress:0,actor:-1};for(const p of ctx.players){setupPlayer(ctx,p);if(w.bomb.carrier<0&&p.team===w.round.attackingTeam)w.bomb.carrier=p.index;}},
pendingTeamObjective:({world})=>world.bomb.state===1?world.round.attackingTeam:null,
teamObjective:({world})=>world.winner<0?null:world.winner,
onEliminations(ctx,eliminations){for(const e of eliminations){const owner=e.hit.owner;if(owner==null)continue;const shot=ctx.world.shots.find(sh=>'shot'+sh.id===e.hit.entity);ctx.players[owner].state.credits=Math.min(9000,ctx.players[owner].state.credits+200);ctx.world.kills.push({id:++ctx.world.serial,owner,target:e.player,head:shot?.region===1,timeMs:ctx.world.elapsedMs});}},
step(ctx){const {world:w,players,inputs,dtMs,tuning}=ctx;w.elapsedMs+=dtMs;w.shots=w.shots.filter(shot=>w.elapsedMs-shot.timeMs<250).slice(-256);w.kills=w.kills.filter(k=>w.elapsedMs-k.timeMs<4000);w.effects=w.effects.map(e=>({...e,life:e.life-dtMs})).filter(e=>e.life>0);
for(const hit of ctx.hits){const s=players[hit.player].state;s.armor=Math.max(0,s.armor-(hit.fullDamage-hit.damage));s.channel=0;}

const buy=w.elapsedMs<BUY_MS;
for(const p of players){const s=p.state,i=inputs[p.index]??createInput();recoverFirearm(s.recoil,GUN_RECOIL[s.weapon],w.elapsedMs,dtMs);for(const k of ['cooldown','skillA','skillB','boost','slow','reveal','cloak'] as const)s[k]=Math.max(0,s[k]-dtMs);
if(p.hp<=0||p.active===false){if(w.bomb.carrier===p.index){w.bomb.carrier=-1;w.bomb.x=s.x;w.bomb.z=s.z;}continue;}
if(i.camera)s.third=!s.third;if(i.closeUi)s.shop=false;else if(i.shop&&buy)s.shop=!s.shop;if(!buy)s.shop=false;
const directChoice=Number.isInteger(i.buySelection)&&i.buySelection>=1&&i.buySelection<=SHOP_ITEMS;
if(buy&&s.shop&&directChoice)s.selection=i.buySelection-1;
if(i.previous)s.selection=(s.selection+SHOP_ITEMS-1)%SHOP_ITEMS;if(i.next)s.selection=(s.selection+1)%SHOP_ITEMS;
if(i.buy&&buy&&s.shop&&(i.buySelection===0||directChoice))purchase(s);
s.aim=i.aim&&!s.shop;if(i.swap&&s.primary!==0){if(GUNS[s.weapon].slot==='sidearm'){s.stash.pistolAmmo=s.ammo;s.stash.pistolReserve=s.reserve;s.weapon=s.primary;s.ammo=s.stash.primaryAmmo;s.reserve=s.stash.primaryReserve;}else{s.stash.primaryAmmo=s.ammo;s.stash.primaryReserve=s.reserve;s.weapon=s.stash.pistol;s.ammo=s.stash.pistolAmmo;s.reserve=s.stash.pistolReserve;}s.reload=0;}
if(i.reload&&s.reload<=0&&s.ammo<GUNS[s.weapon].mag&&s.reserve>0)s.reload=GUNS[s.weapon].reload;
if(s.reload>0){s.reload=Math.max(0,s.reload-dtMs);if(s.reload===0){const n=Math.min(GUNS[s.weapon].mag-s.ammo,s.reserve);s.ammo+=n;s.reserve-=n;}}
if(!buy&&!s.shop){if(i.skillA)ability(ctx,p,0);if(i.skillB)ability(ctx,p,1);if(i.fire)fire(ctx,p);}
steerPlayer(s,buy?createInput({...i,moveX:0,moveZ:0,jump:false}):i,tuning);
for(const e of w.effects){if(e.kind===3&&players[e.owner].team!==p.team&&dist(s,e)<e.radius)s.slow=500;}
if(w.bomb.state===0&&w.bomb.carrier<0&&p.team===w.round.attackingTeam&&dist(s,w.bomb)<1.8)w.bomb.carrier=p.index;
}
moveCharacters(players.filter(p=>p.hp>0&&p.active!==false).map(p=>p.state),dtMs/1000,tuning,groundPhysics);
if(!buy&&w.winner<0){const b=w.bomb;let channeler=-1;
for(const p of players){const s=p.state,i=inputs[p.index];if(p.hp<=0||!i?.interact||s.shop||Math.hypot(i.moveX,i.moveZ)>.1||ctx.hits.some(h=>h.player===p.index&&h.damage>0)){s.channel=0;continue;}
const canPlant=b.state===0&&b.carrier===p.index&&SITES.some(site=>dist(s,site)<5);
const canDefuse=b.state===1&&p.team!==w.round.attackingTeam&&dist(s,b)<2.6;
if((canPlant||canDefuse)&&channeler<0){channeler=p.index;s.channel+=dtMs;b.progress=s.channel/(canPlant?PLANT_MS:DEFUSE_MS);b.actor=p.index;
if(s.channel>=(canPlant?PLANT_MS:DEFUSE_MS)){if(canPlant){b.state=1;b.carrier=-1;b.x=s.x;b.z=s.z;b.timer=BOMB_MS;w.reason='DEVICE ARMED';}else{b.state=2;w.winner=p.team??0;w.reason='DEVICE DEFUSED';}s.channel=0;b.progress=0;}}else s.channel=0;}
if(channeler<0){b.progress=0;b.actor=-1;}
if(b.state===1){b.timer-=dtMs;if(b.timer<=0){b.state=3;w.winner=w.round.attackingTeam;w.reason='DEVICE DETONATED';effect(ctx,players[0],10,18,2500,0);const e=w.effects[w.effects.length-1];e.x=b.x;e.z=b.z;}}
else if(w.elapsedMs>ROUND_MS){w.winner=1-w.round.attackingTeam;w.reason='TIME EXPIRED';}
}
},
entities({players,world:w,tuning}){const damage:DamageEntity[]=[];
for(const sh of w.shots)if(sh.target>=0)damage.push({id:'shot'+sh.id,label:'ballistic',owner:sh.owner,target:sh.target,kind:'strike',shape:'sphere',at:{x:sh.ex,y:sh.ey,z:sh.ez},radius:.2,damage:sh.damage});
for(const e of w.effects)if(e.kind===4||e.kind===5)damage.push({id:'effect'+e.id,label:e.kind===4?'thermite':'blast',owner:e.owner,kind:e.kind===4?'zone':'strike',shape:'sphere',at:{x:e.x,y:.8,z:e.z},radius:e.radius,damage:e.kind===4?22:60});
return{bodies:players.map(p=>({at:{x:p.state.x,y:p.state.y,z:p.state.z},radius:tuning.fighterRadius,height:tuning.fighterHeight,guard:p.state.armor>0?.6:1})) as PlayerList<PlayerBody>,damage};},
describePlayer:p=>OPERATORS[p.state.operator].name+' '+GUNS[p.state.weapon].name+' '+(p.hp<=0?'DOWN':'READY'),
inspectionSetups:[
...GUNS.map((g,index)=>({id:'weapon-'+index,label:g.name+' handling',description:'Inspect '+g.type+' handling and reload.',stage(ctx:Ctx){ctx.world.elapsedMs=BUY_MS+1;ctx.players.forEach((p,i)=>{p.state.x=i===0?0:25;p.state.z=i===0?0:38;p.state.facing=0;equip(p.state,index);p.state.ammo=Math.max(0,g.mag-1);});}})),
...DEFENDER_NESTS.map((site,index)=>({id:'nest-'+index,label:'Defender nest '+site.label,description:'Elevated defender position above the site.',stage(ctx:Ctx){ctx.world.elapsedMs=BUY_MS+1;Object.assign(ctx.players[0].state,{x:site.x,y:site.y,z:site.z,facing:Math.PI});equip(ctx.players[0].state,3);}})),
{id:'spray-wall',label:'Rifle spray wall',description:'Rifle at a tall wall for inspecting recoil, tracers and retained impact marks.',stage(ctx){ctx.world.elapsedMs=BUY_MS+1;ctx.players.forEach((p,i)=>{p.state.x=i===0?-4:25;p.state.z=i===0?0:38;p.state.facing=i===0?-Math.PI/2:Math.PI;equip(p.state,1);});}},
{id:'combat',label:'Combat lane',description:'Two opponents facing each other with rifles and armor.',stage(ctx){ctx.world.elapsedMs=BUY_MS+1;ctx.players.forEach((p,i)=>{p.state.x=i<2?0:25;p.state.z=i===0?-6:i===1?6:38;p.state.facing=i%2?Math.PI:0;equip(p.state,1);p.state.armor=50;});}},
{id:'operators',label:'Operator lineup',description:'Ten humans, all five operator designs.',stage(ctx){ctx.world.elapsedMs=BUY_MS+1;ctx.players.forEach((p,i)=>{p.state.x=(i%5-2)*2;p.state.z=0+Math.floor(i/5)*4;p.state.facing=Math.PI;});}}
],
controls:{pointer:{mode:'lock'},inspection:{forward:{moveZ:1},right:{moveX:1},jump:{jump:true},attack:{fire:true}},
bindings:[{name:'moveX',label:'Strafe',kind:'axis',role:'move-x',keys:['a','d']},{name:'moveZ',label:'Move',kind:'axis',role:'move-y',keys:['s','w']},{name:'jump',label:'Jump',kind:'held',keys:[' ']},{name:'fire',label:'Fire',kind:'held',mouse:0},{name:'aim',label:'Aim',kind:'held',mouse:2},{name:'reload',label:'Reload',kind:'tap',keys:['r']},{name:'skillA',label:'Primary ability',kind:'tap',keys:['q']},{name:'skillB',label:'Secondary ability',kind:'tap',keys:['e']},{name:'interact',label:'Plant / defuse',kind:'held',keys:['f']},{name:'shop',label:'Open buy station',kind:'tap',keys:['b']},{name:'previous',label:'Previous item',kind:'tap',keys:['arrowleft']},{name:'next',label:'Next item',kind:'tap',keys:['arrowright']},{name:'buy',label:'Purchase item',kind:'tap',keys:['enter']},{name:'swap',label:'Switch weapon',kind:'tap',keys:['x']},{name:'camera',label:'Camera perspective',kind:'tap',keys:['v']}],
writeInput(input,buttons){for(const k of ['moveX','moveZ'] as const)input[k]=buttons.value(k);input.lookX=buttons.pointer.deltaX;input.lookY=buttons.pointer.deltaY;for(const k of ['jump','fire','aim','interact'] as const)input[k]=buttons.held(k);for(const k of ['reload','skillA','skillB','shop','previous','next','buy','swap','camera'] as const)input[k]=buttons.tapped(k);
input.shop=input.shop||(buttons.ui?.('openUi')??[]).length>0;
input.buySelection=0;input.closeUi=(buttons.ui?.('closeUi')??[]).length>0;
const choice=(buttons.ui?.('buyItem')??[]).find(event=>typeof event.index==='number'&&Number.isInteger(event.index)&&event.index>=0&&event.index<SHOP_ITEMS);
if(choice){input.buySelection=choice.index!+1;input.buy=true;}}},
prediction:{pointerLook:{...BLANK_POINTER_LOOK,disabledWhen:['shop']},fields:['x','y','z','facing','aimPitch','velocityX','velocityY','velocityZ','grounded'],snapFields:['x','y','z'],step(s,i,dt,{tuning,world,opponents}){movePlayer(s,world.elapsedMs<BUY_MS?createInput():i,dt,tuning,opponents);}},
smoothFields:['x','y','z','facing','aimPitch','recoil.pitch','recoil.yaw'],
hudLines:({world,players})=>{const p=players.find(p=>p.isLocal);return world&&p?['KESTREL PROTOCOL | '+world.round.scoreA+' : '+world.round.scoreB+' | ROUND '+world.round.number,world.elapsedMs<BUY_MS?'BUY PHASE':world.bomb.state===1?'DEVICE '+Math.ceil(world.bomb.timer/1000)+'s':world.reason||'Secure A, B or C',OPERATORS[p.state.operator].name+' | '+GUNS[p.state.weapon].name+' '+p.state.ammo+'/'+p.state.reserve+' | ARMOR '+Math.ceil(p.state.armor)+' | $'+p.state.credits]:[];}
};export default game;

