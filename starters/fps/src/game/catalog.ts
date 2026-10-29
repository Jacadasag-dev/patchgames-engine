export const OPERATORS=[
{id:'vapor',name:'VAPOR',color:'#46cfc1',role:'Entry specialist',a:'Mist sphere',b:'Slipstream',description:'Obscure sightlines with smoke; surge into cover.'},
{id:'pulse',name:'PULSE',color:'#e5b747',role:'Recon specialist',a:'Echo scan',b:'Static snare',description:'Reveal opponents; disrupt a contested lane.'},
{id:'ember',name:'EMBER',color:'#eb7956',role:'Demolition specialist',a:'Thermite pool',b:'Concussive charge',description:'Deny ground; detonate a close blast.'},
{id:'bastion',name:'BASTION',color:'#729de5',role:'Defense specialist',a:'Prism barrier',b:'Kinetic weave',description:'Block incoming fire; reinforce personal armor.'},
{id:'wraith',name:'WRAITH',color:'#c68ee5',role:'Infiltration specialist',a:'Echo lure',b:'Veil',description:'Create a false contact; fade at distance.'}];
export {GUNS,GUN_RECOIL,ARMOR_LIGHT,ARMOR_HEAVY,SHOP_ITEMS} from './features/operator-appearance/weapons.ts';
export const BUY_MS=15000, ROUND_MS=115000,BOMB_MS=35000,PLANT_MS=3000,DEFUSE_MS=5000;
export function radarContacts(players:readonly {team?:number,state:{x:number,z:number,reveal:number}}[],effects:readonly {kind:number,owner:number,x:number,z:number}[],team:number|undefined){return [
...players.filter(p=>p.team===team||p.state.reveal>0).map(p=>({x:p.state.x,z:p.state.z,friendly:p.team===team,decoy:false})),
...effects.filter(e=>e.kind===8&&players[e.owner]?.team!==team).map(e=>({x:e.x,z:e.z,friendly:false,decoy:true}))
];}


