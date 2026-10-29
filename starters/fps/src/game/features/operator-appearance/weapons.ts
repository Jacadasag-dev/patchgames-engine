import {FIREARM_PROFILES} from '../../../sandbox/firearms.ts';
export const GUNS=[
{name:'FINCH / Glock',type:'Glock pistol',kind:'glock',slot:'sidearm',cost:0,damage:26,head:3.4,leg:.75,near:20,far:45,floor:.65,interval:260,mag:12,reserve:60,reload:1400,style:'magazine',pellets:1,cone:0,color:'#b5c9ce'},
{name:'KESTREL',type:'Long-range assault',kind:'rifle-heavy',slot:'primary',cost:2900,damage:44,head:4,leg:.75,near:100,far:120,floor:1,interval:115,mag:25,reserve:100,reload:2300,style:'magazine',pellets:1,cone:0,color:'#58d5c7'},
{name:'TEMPEST',type:'Submachine gun',kind:'smg',slot:'primary',cost:1500,damage:24,head:3.5,leg:.75,near:15,far:40,floor:.55,interval:70,mag:30,reserve:120,reload:1800,style:'magazine',pellets:1,cone:0,color:'#e7bb58'},
{name:'MONARCH',type:'Light sniper',kind:'sniper-light',slot:'primary',cost:2500,damage:80,head:3,leg:.8,near:100,far:120,floor:1,interval:1100,mag:5,reserve:25,reload:2600,style:'bolt',pellets:1,cone:0,color:'#c397e6'},
{name:'ANVIL',type:'Light machine gun',kind:'lmg',slot:'primary',cost:3200,damage:35,head:3.5,leg:.75,near:30,far:70,floor:.8,interval:95,mag:80,reserve:160,reload:4400,style:'belt',pellets:1,cone:0,color:'#f08e6b'},
{name:'MARSHAL',type:'Revolver pistol',kind:'revolver',slot:'sidearm',cost:800,damage:55,head:4,leg:.75,near:30,far:70,floor:.7,interval:400,mag:6,reserve:36,reload:2400,style:'revolver',pellets:1,cone:0,color:'#d5b992'},
{name:'POCKET STORM',type:'Shotgun pistol',kind:'short-shotgun',slot:'sidearm',cost:300,damage:14,head:1.5,leg:.8,near:5,far:18,floor:.25,interval:480,mag:2,reserve:24,reload:1900,style:'shell',pellets:10,cone:.12,color:'#a6babc'},
{name:'SWIFT',type:'Fast assault rifle',kind:'rifle-fast',slot:'primary',cost:2900,damage:38,head:5,leg:.75,near:25,far:55,floor:.55,interval:85,mag:30,reserve:90,reload:2100,style:'magazine',pellets:1,cone:0,color:'#729de5'},
{name:'SOVEREIGN',type:'Heavy sniper',kind:'sniper-heavy',slot:'primary',cost:4700,damage:250,head:2,leg:.8,near:100,far:120,floor:1,interval:1500,mag:5,reserve:15,reload:3300,style:'bolt',pellets:1,cone:0,color:'#d9a856'},
{name:'BREAKER',type:'Pump shotgun',kind:'shotgun-pump',slot:'primary',cost:1700,damage:20,head:1.6,leg:.8,near:15,far:35,floor:.45,interval:950,mag:6,reserve:30,reload:3100,style:'shell',pellets:8,cone:.043,color:'#80ad91'},
{name:'TORRENT',type:'Automatic shotgun',kind:'shotgun-auto',slot:'primary',cost:2100,damage:16,head:1.5,leg:.8,near:7,far:25,floor:.23,interval:220,mag:10,reserve:40,reload:2800,style:'magazine',pellets:8,cone:.085,color:'#c87a6c'}
] as const;
const r=FIREARM_PROFILES;
export const GUN_RECOIL=[r.sidearm,r.rifle,r.smg,r.marksman,r.heavy,
{...r.sidearm,climb:[0,.04,.065,.08],sway:.018,resetMs:550},
{...r.sidearm,climb:[0,.055,.085],sway:.03,resetMs:650},
{...r.rifle,climb:r.rifle.climb.map(v=>v*.62),sway:r.rifle.sway*.65,resetMs:380},
{...r.marksman,climb:[0,.06,.09],sway:.006,resetMs:900},
{...r.heavy,climb:[0,.045,.075,.1],sway:.018,resetMs:750},
{...r.heavy,climb:[0,.025,.05,.08,.1,.12],sway:.035,resetMs:550}];
export const ARMOR_LIGHT=GUNS.length,ARMOR_HEAVY=GUNS.length+1,SHOP_ITEMS=GUNS.length+2;

