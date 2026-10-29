import {defineMapAssembly,mapFloorRegions,type MapAssemblyRecipe,type MapPartRecipe,type MapConnection,type MapSign,type MapInspectionView} from '../sandbox/mapAssembly.ts';
import {MAP_ROOMS,WALLS,type MapSolid} from './mapLayout.ts';
import {MAP_PALETTE as palette} from './mapPalette.ts';

/** Rebuilt with the shared engine's runtime-stable assembly fingerprints.
 * The map's architecture is ordinary engine-authored data. No view-only walls,
 * guessed roof elevations, disconnected lamps, or overlapping floor skins. */
export const MAP_INSPECTION_VIEWS:MapInspectionView[]=[
 {id:'attack-courtyard',kind:'overview',position:{x:7,y:1.575,z:-40},target:{x:0,y:3.4,z:-33.4}},
 {id:'west-shrine',kind:'roof',position:{x:-35,y:1.575,z:0},target:{x:-39,y:2.7,z:4}},
 {id:'mid-shrine',kind:'roof',position:{x:-2,y:1.575,z:-6},target:{x:-7,y:3,z:-1.5}},
 {id:'a-site',kind:'sign',position:{x:-33,y:1.575,z:18},target:{x:-41,y:3.6,z:26}},
 {id:'b-site',kind:'sign',position:{x:4,y:1.575,z:18},target:{x:9,y:3.8,z:25}},
 {id:'c-site',kind:'sign',position:{x:35.5,y:1.575,z:18.5},target:{x:42,y:3.6,z:26}},
 {id:'garage-lantern',kind:'connection',position:{x:16.5,y:1.575,z:-5},target:{x:16.5,y:3.7,z:1}},
 {id:'short-lantern',kind:'connection',position:{x:-20,y:1.575,z:8},target:{x:-20,y:3.8,z:13}},
 {id:'a-nest',kind:'surface',position:{x:-35,y:3.975,z:34},target:{x:-32,y:1.8,z:22}},
 {id:'c-nest',kind:'surface',position:{x:35,y:3.975,z:34},target:{x:32,y:1.8,z:22}},
 {id:'central-roofline',kind:'roof',position:{x:0,y:13,z:15},target:{x:-13,y:6.8,z:8}},
 {id:'defender-courtyard',kind:'overview',position:{x:-7,y:1.575,z:42},target:{x:0,y:3.4,z:36.3}},
];
export const MAP_LANTERNS=['a-short-gate-lantern','b-gate-lantern','garage-gate-lantern','c-window-gate-lantern','mid-window-lintel-lantern','garage-ceiling-lantern'];

export function monasteryRecipe():MapAssemblyRecipe{
 const parts:MapPartRecipe[]=[],connections:MapConnection[]=[],signs:MapSign[]=[];
 const box=(id:string,role:MapPartRecipe['role'],w:number,h:number,d:number,material:MapPartRecipe['material'],color='#d8cdb5'):MapPartRecipe=>({
  id,role,shape:{kind:'box',size:{x:w,y:h,z:d}},material,color,
 });
 const add=(part:MapPartRecipe)=>{parts.push(part);return part;};
 const mount=(part:MapPartRecipe,target:string,face:string,ownFace='bottom',u=0,v=0,ownU=0,ownV=0)=>
  add({...part,mount:{part:target,face,ownFace,u,v,ownU,ownV}});
 const foot=(part:MapPartRecipe,x:number,z:number)=>mount(part,'monastery-foundation','top','bottom',x,-z);
 const bearing=(id:string,part:string,target:string,x:number,z:number,w:number,d:number)=>connections.push({id,kind:'bearing',
  a:{part,face:'bottom',region:{minU:x-w/2,maxU:x+w/2,minV:z-d/2,maxV:z+d/2}},b:{part:target,face:'top'},minCoverage:.98});
 add({...box('monastery-foundation','terrain',96,.88,96,palette.earth,'#a6997b'),position:{x:0,y:-.56,z:0},support:'foundation'});
 parts.push(...mapFloorRegions({id:'courtyard',y:0,thickness:.12,foundation:true,regions:[
  ...MAP_ROOMS.map((room,index)=>({id:room.id,x0:room.x0,x1:room.x1,z0:room.z0,z1:room.z1,priority:index+1,
   material:room.finish==='earth'?palette.earth:room.finish==='timber'?palette.timber:palette.paving})),
 ]}));
 const material=(q:MapSolid)=>q.finish==='step'?palette.stone:palette[q.finish];

 // Solid wall footings reach the actual foundation. The floor finish is a
 // partitioned surrounding surface, not another sheet over the same floor.
 for(const q of WALLS.filter(q=>q.kind!=='ceiling')){
  const role:MapPartRecipe['role']=q.kind==='building'||q.kind==='screen'?'wall':q.kind==='step'||q.kind==='platform'?'floor':'cover';
  if((q.y??0)===0)foot(box(q.id,role,q.w,q.h+.12,q.d,material(q)),q.x,q.z);
  else{
   const platform=q.id.startsWith('a-')?WALLS.find(w=>w.id==='a-nest')!:WALLS.find(w=>w.id==='c-nest')!;
   mount(box(q.id,role,q.w,q.h,q.d,material(q)),platform.id,'top','bottom',q.x-platform.x,-(q.z-platform.z));
  }
 }
 const walkable=(x:number,z:number)=>MAP_ROOMS.some(r=>x>r.x0&&x<r.x1&&z>r.z0&&z<r.z1);
 for(const q of WALLS.filter(q=>q.kind==='building'||q.kind==='screen')){
  const cap=mount(box(q.id+'-cornice','trim',q.w,.22,q.d,palette.wood,'#554939'),q.id,'top');
  if(q.kind==='screen'||Math.min(q.w,q.d)>2.1&&Math.max(q.w,q.d)<32){
   const turned=q.w>q.d,width=turned?q.d:q.w,depth=turned?q.w:q.d;
   add({id:q.id+'-roof',role:'roof',shape:{kind:'gable',width,depth,rise:Math.min(2,width*.24),thickness:.16},
    mount:{part:cap.id,face:'top',ownFace:'bottom',yaw:turned?Math.PI/2:0},material:palette.roof,color:'#4d7168'});
  }else mount(box(q.id+'-roof-cap','roof',q.w,.16,q.d,palette.roof,'#4d7168'),cap.id,'top');
  // Only façades facing playable space receive attached stone plinths and a
  // cedar cornice. No independent trim crosses the readable sign band.
  const faces=[{id:'front',x:q.x,z:q.z+q.d/2+.1,width:q.w},{id:'back',x:q.x,z:q.z-q.d/2-.1,width:q.w},
   {id:'left',x:q.x-q.w/2-.1,z:q.z,width:q.d},{id:'right',x:q.x+q.w/2+.1,z:q.z,width:q.d}];
  for(const f of faces)if(f.width>.4&&walkable(f.x,f.z)){
   mount(box(q.id+'-'+f.id+'-plinth','trim',f.width-.2,.5,.07,palette.stone,'#9da99e'),q.id,f.id,'back',0,.25-(q.h-.12)/2);
   mount(box(q.id+'-'+f.id+'-frieze','trim',f.width-.2,.14,.08,palette.wood,'#554939'),q.id,f.id,'back',0,q.h-.35-(q.h-.12)/2);
  }
 }

 // Covered rooms have visible bearing posts. The ceiling is mounted to the
 // first post and independently checked against all other bearing patches.
 for(const q of WALLS.filter(q=>q.kind==='ceiling')){
  const inset=q.d<1?.0:.35,postW=q.d<1?.32:.42;
  const corners=q.d<1?[[-q.w/2+postW/2,0],[q.w/2-postW/2,0]]:
   [[-q.w/2+inset,-q.d/2+inset],[q.w/2-inset,-q.d/2+inset],[-q.w/2+inset,q.d/2-inset],[q.w/2-inset,q.d/2-inset]];
  corners.forEach(([dx,dz],i)=>foot(box(q.id+'-post-'+i,'post',postW,(q.y??0)+.12,postW,palette.wood,'#554939'),q.x+dx,q.z+dz));
  const [firstX,firstZ]=corners[0];
  mount(box(q.id,'beam',q.w,q.h,q.d,palette.wood,'#75614b'),q.id+'-post-0','top','bottom',0,0,firstX,firstZ);
  corners.forEach(([dx,dz],i)=>bearing(q.id+'-bearing-'+i,q.id,q.id+'-post-'+i,dx,dz,postW,postW));
  if(q.d>1)add({id:q.id+'-roof',role:'roof',shape:{kind:'gable',width:q.w,depth:q.d,rise:1.1,thickness:.16},
   mount:{part:q.id,face:'top',ownFace:'bottom'},material:palette.roof,color:'#4d7168'});
 }

 for(const q of WALLS.filter(q=>q.id==='courtyard-shrine'||q.id==='a-long-shrine')){
  const cap=mount(box(q.id+'-stone-cap','trim',q.w,.16,q.d,palette.stone,'#b3b9a7'),q.id,'top');
  add({id:q.id+'-roof',role:'roof',shape:{kind:'gable',width:q.w+.24,depth:q.d+.24,rise:.78,thickness:.14},
   mount:{part:cap.id,face:'top',ownFace:'bottom'},material:palette.roof,color:'#4d7168'});
  mount(box(q.id+'-seal','trim',.16,.9,.045,palette.brass,'#c9ae74'),q.id,'front','back',0,.05);
 }
 // Chest lids and fittings are mounted to their actual box, so resizing cover
 // cannot leave a detached lid or straps suspended in front of it.
 for(const q of WALLS.filter(q=>q.finish==='crate')){
  mount(box(q.id+'-lid','trim',q.w,.13,q.d,palette.wood,'#554939'),q.id,'top');
  for(const side of [-1,1])mount(box(q.id+'-strap-'+side,'trim',.11,q.h-.14,.045,palette.brass,'#c9ae74'),q.id,'front','back',side*(q.w/2-.2),.06);
 }
 for(const q of WALLS.filter(q=>q.id.includes('planter'))){
  mount(box(q.id+'-soil','decoration',q.w-.24,.09,q.d-.24,palette.earth,'#746749'),q.id,'top');
  // Contained sculpted planting is authored geometry, not independent scatter.
  for(const [i,dx]of [-.24,.24].entries())mount({...box(q.id+'-plant-'+i,'decoration',q.w*.38,.42,q.d*.7,undefined,i?'#81936a':'#607955'),collidable:false},q.id+'-soil','top','bottom',dx*q.w,0);
 }

 const lantern=(id:string,ceiling:string)=>{
  mount(box(id+'-chain','fixture',.055,.5,.055,palette.brass,'#b99e68'),ceiling,'bottom','top');
  mount(box(id+'-cap','fixture',.54,.1,.54,palette.wood,'#4a5145'),id+'-chain','bottom','top');
  mount(box(id+'-body','fixture',.4,.48,.4,undefined,'#f1d494'),id+'-cap','bottom','top');
  mount(box(id+'-base','fixture',.54,.1,.54,palette.wood,'#4a5145'),id+'-body','bottom','top');
 };
 const gate=(id:string,x:number,z:number,width:number,yaw=0)=>{
  const post=.42,depth=.7,dx=Math.cos(yaw)*width/2,dz=-Math.sin(yaw)*width/2;
  foot({...box(id+'-left','post',post,4.32,depth,palette.wood,'#554939'),yaw},x-dx,z-dz);
  foot({...box(id+'-right','post',post,4.32,depth,palette.wood,'#554939'),yaw},x+dx,z+dz);
  // Foundation mounts take the intended horizontal rotation explicitly.
  parts[parts.length-2].mount!.yaw=yaw;delete parts[parts.length-2].yaw;
  parts[parts.length-1].mount!.yaw=yaw;delete parts[parts.length-1].yaw;
  mount(box(id+'-beam','beam',width+post,.36,depth,palette.wood,'#554939'),id+'-left','top','bottom',0,0,-width/2,0);
  bearing(id+'-right-bearing',id+'-beam',id+'-right',width/2,0,post,depth);
  add({id:id+'-roof',role:'roof',shape:{kind:'gable',width:width+post,depth:depth,rise:.72,thickness:.13},
   mount:{part:id+'-beam',face:'top',ownFace:'bottom'},material:palette.roof,color:'#4d7168'});
  lantern(id+'-lantern',id+'-beam');
 };
 gate('a-short-gate',-20,13,5.1);
 gate('b-gate',0,13.1,8.8);
 gate('garage-gate',16.5,1,10.8);
 gate('c-window-gate',23,17.5,7.2,Math.PI/2);
 lantern('mid-window-lintel-lantern','mid-window-lintel');
 lantern('garage-ceiling-lantern','garage-ceiling');

 const sign=(id:string,text:string,target:MapSolid,face:'front'|'back'|'left'|'right',along:number,height:number,w:number,h:number,
  approaches:{x:number;z:number}[],background='#244b48')=>{
  const u=face==='front'?along-target.x:face==='back'?target.x-along:face==='left'?along-target.z:target.z-along;
  mount({...box(id,'sign',w,h,.045,undefined,background),collidable:false},target.id,face,'back',u,height-((target.y??0)===0?(target.h-.12)/2:(target.y??0)+target.h/2));
  signs.push({part:id,text,background,color:'#f6e7bc',approaches:approaches.map((p,i)=>({id:id+'-approach-'+i,position:{x:p.x,y:1.575,z:p.z},minVisibleFraction:.95,minPixelHeight:20,viewportHeight:720,fov:65}))});
 };
 const facade=(face:'left'|'right',x:number,z:number)=>{
  const result=WALLS.find(q=>q.kind==='building'&&Math.abs(q.x+(face==='left'?-q.w/2:q.w/2)-x)<.001&&z>q.z-q.d/2+1.3&&z<q.z+q.d/2-1.3);
  if(!result)throw new Error('Missing authored sign wall '+face+' '+x+' '+z);return result;
 };
 sign('attack-name','JUNIPER',WALLS.find(q=>q.id==='attacker-moon-screen')!,'back',0,2.7,5.6,1.45,[{x:0,z:-40},{x:5,z:-39}]);
 sign('defender-name','SANCTUARY',WALLS.find(q=>q.id==='defender-moon-screen')!,'front',0,2.8,5.8,1.45,[{x:0,z:42},{x:-5,z:42}]);
 sign('site-a','A',facade('right',-41,26),'right',26,3.6,2.1,2.1,[{x:-33,z:18},{x:-35,z:26}],'#8b6046');
 sign('site-b','B',facade('left',9,25),'left',25,3.8,2.1,2.1,[{x:4,z:18},{x:4,z:26}],'#695c70');
 sign('site-c','C',facade('left',42,26),'left',26,3.6,2.1,2.1,[{x:35.5,z:18.5},{x:37,z:27}],'#3f6e63');
 sign('a-long-name','A LONG',facade('left',-32,-3),'left',-3,3.3,2.8,.85,[{x:-36,z:-8},{x:-36,z:0}]);
 sign('garage-name','GARAGE',facade('left',23,-5),'left',-5,3.5,3.1,.9,[{x:16,z:-9},{x:16,z:-1}]);
 sign('c-long-name','C LONG',facade('right',32,-15),'right',-15,3.3,2.8,.85,[{x:36,z:-20},{x:36,z:-10}]);
 return{version:1,id:'juniper-monastery-ii',parts,connections,signs,views:MAP_INSPECTION_VIEWS};
}
export const MAP_ASSEMBLY=defineMapAssembly('juniper-monastery-ii',monasteryRecipe);


