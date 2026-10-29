/** Juniper Monastery, architectural revision II. North (-Z) attacks;
 * the three sanctuaries face south. Exact authored routes remain editable.
 * The rectangles describe usable space, not three parallel lanes: their union
 * is compiled into disjoint, shared collision/render building masses below. */
export const GROUND={halfExtent:48,thickness:1};
export interface MapRoom {id:string;x0:number;x1:number;z0:number;z1:number;finish:'stone'|'earth'|'timber';}
const room=(id:string,x0:number,x1:number,z0:number,z1:number,finish:MapRoom['finish']='stone'):MapRoom=>({id,x0,x1,z0,z1,finish});
export const MAP_ROOMS:MapRoom[]=[
 room('attacker-spawn',-11,11,-45,-34),
 room('attacker-crossing',-20,23,-35,-28),
 room('a-garden',-27,-14,-31,-19,'earth'),
 room('a-lobby',-29,-17,-20,-7),
 room('a-long-entrance',-38,-21,-13,-7),
 room('a-long',-41,-32,-11,21,'earth'),
 room('a-site',-41,-23,18,32),
 room('a-short',-23,-17,-7,19),
 room('a-short-mouth',-27,-16,14,23),
 room('window-entry',-18,-5,-26,-19),
 room('mid-window',-13,-4,-22,-11,'timber'),
 room('window-stair',-11,-6,-13,-7),
 room('mid-courtyard',-17,5,-9,5),
 room('b-approach',-5,5,3,17),
 room('b-site',-10,9,14,29),
 room('b-back',-9,9,27,38),
 room('c-lobby',10,29,-31,-22,'earth'),
 room('c-long-entry',24,38,-28,-20),
 room('c-long',32,41,-25,21,'earth'),
 room('c-long-cubby',28,36,-7,0),
 room('garage-entry',13,21,-24,-10),
 room('mid-doors',10,23,-13,2,'timber'),
 room('courtyard-garage-link',3,15,-9,-3),
 room('c-short',12,20,0,19),
 room('c-window',18,28,13,22,'timber'),
 room('c-site',23,42,19,33),
 room('a-tower',-40,-29,30,37,'timber'),
 room('a-link',-31,-8,32,39),
 room('c-tower',29,40,30,37,'timber'),
 room('c-link',8,31,32,40),
 room('defender-crossing',-19,20,35,42),
 room('defender-spawn',-11,11,39,46),
];

export type MapFinish='plaster'|'ochre'|'redwood'|'stone'|'crate'|'step';
export interface MapSolid {id:string;x:number;z:number;w:number;d:number;h:number;y?:number;finish:MapFinish;kind:'building'|'cover'|'step'|'platform'|'screen'|'ceiling';}
const solid=(id:string,x:number,z:number,w:number,d:number,h:number,finish:MapFinish='plaster',kind:MapSolid['kind']='building',y=0):MapSolid=>({id,x,z,w,d,h,y,finish,kind});

/** Merge identical row spans; every wall footprint is the exact complement of
 * the playable room union. No hidden route blockers or visual-only cover. */
function enclosure():MapSolid[]{
 const xs=[...new Set([-48,48,...MAP_ROOMS.flatMap(r=>[r.x0,r.x1])])].sort((a,b)=>a-b);
 const zs=[...new Set([-48,48,...MAP_ROOMS.flatMap(r=>[r.z0,r.z1])])].sort((a,b)=>a-b);
 const result:MapSolid[]=[],active=new Map<string,MapSolid>();
 for(let zi=0;zi<zs.length-1;zi++){
  const spans:Array<[number,number]>=[];let start:number|undefined;
  for(let xi=0;xi<xs.length-1;xi++){
   const x=(xs[xi]+xs[xi+1])/2,z=(zs[zi]+zs[zi+1])/2;
   const blocked=!MAP_ROOMS.some(r=>x>r.x0&&x<r.x1&&z>r.z0&&z<r.z1);
   if(blocked&&start===undefined)start=xs[xi];
   if(start!==undefined&&(!blocked||xi===xs.length-2)){spans.push([start,blocked?xs[xi+1]:xs[xi]]);start=undefined;}
  }
  const next=new Map<string,MapSolid>();
  for(const [lo,hi]of spans){
   const key=lo+':'+hi,prior=active.get(key);
   if(prior){prior.d=zs[zi+1]-(prior.z-prior.d/2);prior.z=zs[zi+1]-prior.d/2;next.set(key,prior);}
   else{const x=(lo+hi)/2,z=(zs[zi]+zs[zi+1])/2;
    const q=solid('monastery-'+result.length,x,z,hi-lo,zs[zi+1]-zs[zi],x<-14?6.2:x>22?5.8:6.6,x<-14?'ochre':x>22?'plaster':'redwood');result.push(q);next.set(key,q);}
  }
  active.clear();for(const [key,value]of next)active.set(key,value);
 }
 return result;
}

export const WALLS:MapSolid[]=[...enclosure(),
 // Both teams must leave a screened courtyard before encountering a lane.
 solid('attacker-moon-screen',0,-33.4,14,2.2,5.1,'plaster','screen'),
 solid('defender-moon-screen',0,36.3,15,1.8,4.8,'plaster','screen'),
 // Landmark cover has distinct silhouettes and deliberate flanking space.
 solid('garden-planter',-24,-25,3.8,3.8,1.05,'stone','cover'),
 solid('a-lobby-chest',-20,-13,2.3,2.6,1.25,'crate','cover'),
 solid('a-long-shrine',-39,4,3,4.5,2.2,'redwood','cover'),
 solid('a-site-reliquary',-31,24.5,4.4,3.6,2.25,'crate','cover'),
 solid('a-site-low-cover',-38,20.5,2.8,2.2,1.05,'stone','cover'),
 solid('courtyard-shrine',-7,-1.5,3.4,3.4,2.5,'redwood','cover'),
 solid('b-site-vault',0,22,4.4,4,2.1,'crate','cover'),
 solid('b-site-wing',-7.6,19,2,3.2,1.1,'stone','cover'),
 solid('garage-workbench',21,-5,2,4,1.2,'crate','cover'),
 solid('c-lobby-planter',25,-25,3,3,1.05,'stone','cover'),
 solid('c-long-break',39,5.5,3.3,3,1.65,'crate','cover'),
 solid('c-site-reliquary',32,25,4.4,4,2.25,'crate','cover'),
 solid('c-site-low-cover',25.1,22,2.2,2.4,1.05,'stone','cover'),
 // Mid window is a low sill crossed through a five metre wide opening.
 solid('mid-window-sill',-8.5,-11.7,5,.55,.3,'stone','cover'),
 // Covered rooms use the same slabs for bullets, movement and rendering.
 solid('garage-ceiling',16.5,-5.5,13,15,.45,'redwood','ceiling',4.8),
 solid('mid-window-ceiling',-8.5,-16.5,9,11,.4,'redwood','ceiling',4.8),
 solid('mid-window-lintel',-8.5,-11,5,.6,1.2,'redwood','ceiling',3.6),
 // Rear nests stand 2.4m up, with a broad 8m stair run and a clear landing.
 ...[-1,1].flatMap(side=>[
  solid(side<0?'a-nest':'c-nest',side*35,33.7,8,6.6,2.4,'stone','platform'),
  ...Array.from({length:16},(_,i)=>solid((side<0?'a':'c')+'-stair-'+i,side*(23.25+i*.5),35.2,.5,2.8,.15*(i+1),'step','step')),
  solid((side<0?'a':'c')+'-nest-left-merlon',side*37.7,30.8,2.4,.65,.9,'stone','cover',2.4),
  solid((side<0?'a':'c')+'-nest-right-merlon',side*32.1,30.8,1.8,.65,.9,'stone','cover',2.4),
  solid((side<0?'a':'c')+'-nest-rear',side*35,36.7,8,.55,1.1,'redwood','cover',2.4),
 ]),
];

export const SITES=[{x:-32,z:22,label:'A'},{x:0,z:18,label:'B'},{x:32,z:22,label:'C'}];
export const DEFENDER_NESTS=[{label:'A',x:-35,y:2.4,z:33.7},{label:'C',x:35,y:2.4,z:33.7}];
export const MAP_NAME='Juniper Monastery II';
export const MAP_CALLOUTS=[
 {label:'ATTACKER SPAWN',x:0,z:-40},{label:'A GARDEN',x:-21,z:-23},{label:'A LOBBY',x:-23,z:-15},
 {label:'A LONG',x:-36.5,z:1},{label:'A SHORT',x:-20,z:6},{label:'A TOWER',x:-35,z:34},
 {label:'MID WINDOW',x:-8.5,z:-17},{label:'COURTYARD',x:-8,z:2},{label:'B SITE',x:0,z:18},
 {label:'C LOBBY',x:18,z:-27},{label:'GARAGE',x:16,z:-5},{label:'C LONG',x:36,z:-11},
 {label:'C SHORT',x:16,z:7},{label:'C WINDOW',x:23,z:17},{label:'C TOWER',x:35,z:34},
 {label:'A LINK',x:-18,z:36},{label:'B BACK',x:0,z:32},{label:'C LINK',x:18,z:37},
 {label:'DEFENDER SPAWN',x:0,z:42},
];
export function spawnPoint(index:number){return{x:(Math.floor(index/2)-2)*2.1,z:index%2?39:-39,facing:index%2?Math.PI:0};}

