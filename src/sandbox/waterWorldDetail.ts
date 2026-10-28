/** Cosmetic presentation of accepted transfers between geometry-derived layers.
 * No routing, liquid storage, forces or clocks are modified here. */
import type {WaterWorldManifest} from './waterWorld.ts';
import type {WaterSystemState} from './waterSystem.ts';
import type {WaterDetailEvent} from './waterDetail.ts';
import type {PhysicsVector} from './physics.ts';
import {waterBodyCells} from './waterBodyCells.ts';

export function waterWorldDetailEvents(world:WaterWorldManifest,states:readonly WaterSystemState[],volumes:readonly number[],dt:number):WaterDetailEvent[][] {
  if(!(dt>0&&Number.isFinite(dt))||states.length!==world.layers.length||volumes.length!==world.links.length)throw new Error('Invalid world water detail sample');
  const events=world.layers.map(()=>[] as WaterDetailEvent[]),cells=world.layers.map((layer,k)=>waterBodyCells(layer.system.water,states[k].water));
  for(let index=0;index<world.links.length;index++){
    const signed=volumes[index];if(!Number.isFinite(signed))throw new Error('Invalid world water detail discharge');if(!signed)continue;
    const link=world.links[index],forward=signed>0,from=forward?link.a:link.b,to=forward?link.b:link.a,pa=forward?link.pointA:link.pointB,pb=forward?link.pointB:link.pointA,a=cells[from],b=cells[to],ia=a.locate(pa),ib=b.locate(pb);
    if(ia===undefined||ib===undefined)continue;
    const start=Math.max(a.level(ia),link.sill),end=Math.max(b.level(ib),b.bedAt(ib,pb.x,pb.z)),drop=start-end;if(drop<.04)continue;
    const volume=Math.abs(signed),w=world.layers[from].system.water,g=-w.liquid.gravity.y,rho=w.liquid.restDensity,dx=pb.x-pa.x,dz=pb.z-pa.z,distance=Math.hypot(dx,dz);if(!distance)continue;
    const depth=Math.max(w.wetDepth,a.level(ia)-link.sill),speed=Math.min(w.maxFlowSpeed,volume/(dt*link.width*depth)),velocity={x:dx/distance*speed,y:-Math.sqrt(2*g*drop),z:dz/distance*speed};
    const event:WaterDetailEvent={kind:'impact',source:`world-opening:${index}`,position:{x:pb.x,y:end,z:pb.z},normal:{x:0,y:1,z:0},velocity,volume,duration:dt,energy:.5*rho*volume*(speed*speed+2*g*drop),depth:b.depth(ib),wet:b.depth(ib)>world.layers[to].system.water.wetDepth,radius:link.width*.5,time:states[to].water.time};
    if(link.opening){
      const opening=link.opening,middle={x:(opening.start.x+opening.end.x)*.5,z:(opening.start.z+opening.end.z)*.5},polygon=b.polygon(ib);
      const cap=(edge:{x:number;z:number}):PhysicsVector=>{
        const x=edge.x-middle.x,z=edge.z-middle.z;let fraction=1;
        for(let k=0;k<polygon.length;k++){const p=polygon[k],q=polygon[(k+1)%polygon.length],ex=q.x-p.x,ez=q.z-p.z,own=ex*(pb.z-p.z)-ez*(pb.x-p.x),change=ex*z-ez*x;if(change<0)fraction=Math.min(fraction,Math.max(0,own/-change));}
        const bed=b.bedAt(ib,pb.x,pb.z),rise=b.bedAt(ib,pb.x+x,pb.z+z)-bed;
        if(rise>0)fraction=Math.min(fraction,Math.max(0,(start-.001-bed)/rise));
        const px=pb.x+x*fraction,pz=pb.z+z*fraction;return{x:px,y:Math.max(end,b.bedAt(ib,px,pz)),z:pz};
      };
      event.fall={from:[{...opening.start,y:start},{...opening.end,y:start}],to:[cap(opening.start),cap(opening.end)]};
    }
    const list=events[to];list.push(event);if(list.length>64){list.sort((a,b)=>b.energy-a.energy);list.length=64;}
  }
  return events;
}
