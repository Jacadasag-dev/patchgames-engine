/** Shared canvas layout and hit testing. The host validates every requested item. */
import {ARENA_LOOT} from './loot.ts';
export {ARENA_LOOT};
export interface LootRect {x:number;y:number;width:number;height:number}
export function lootPanelLayout(width:number,height:number) {
  const scale=Math.min(1,width/560,height/590),w=500*scale,h=450*scale,x=(width-w)/2,y=(height-h)/2;
  const rect=(rx:number,ry:number,rw:number,rh:number):LootRect=>({x:x+rx*scale,y:y+ry*scale,width:rw*scale,height:rh*scale});
  return {scale,panel:{x,y,width:w,height:h},close:rect(446,15,38,36),
    slots:ARENA_LOOT.map((_,index)=>rect(20+(index%2)*235,85+Math.floor(index/2)*70,225,60)),
    all:rect(20,379,460,48)};
}
export function lootPanelHit(x:number,y:number,width:number,height:number):{take:number;close:boolean} {
  const layout=lootPanelLayout(width,height),px=x*width,py=y*height;
  const inside=(r:LootRect)=>px>=r.x&&py>=r.y&&px<=r.x+r.width&&py<=r.y+r.height;
  if(inside(layout.close))return {take:0,close:true};
  if(inside(layout.all))return {take:9,close:false};
  return {take:layout.slots.findIndex(inside)+1,close:false};
}
