/** Bounded wet-face pressure exchange. Uses real solid normals and point motion;
 * wakes are subsequently propagated by the shared water solver. */
import type {PhysicsCompoundBody,PhysicsVector} from './physics.ts';
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';
import type {LiquidContact} from './waterDomain.ts';
import {waterBodySolid} from './waterBodySolids.ts';
import {liquidRotate} from './liquidCollision.ts';
import {physicsBodyMassProperties,physicsApplyInverseInertia} from './physicsMassProperties.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import type {BoundaryPoint} from './waterBoundaryGeometry.ts';

const zero=():PhysicsVector=>({x:0,y:0,z:0});
const add=(a:PhysicsVector,b:PhysicsVector)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub=(a:PhysicsVector,b:PhysicsVector)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const scale=(v:PhysicsVector,s:number)=>({x:v.x*s,y:v.y*s,z:v.z*s});
const dot=(a:PhysicsVector,b:PhysicsVector)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:PhysicsVector,b:PhysicsVector)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
function clip(points:PhysicsVector[],axis:'x'|'y'|'z',limit:number,sign:number):PhysicsVector[]{
  const result:PhysicsVector[]=[];
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],da=sign*(a[axis]-limit),db=sign*(b[axis]-limit);
    if(da<=0)result.push(a);
    if(da<0&&db>0||da>0&&db<0){const t=da/(da-db);result.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});}
  }
  return result;
}
function patch(points:PhysicsVector[]){
  let area=0,px=0,py=0,pz=0;
  for(let i=1;i+1<points.length;i++){
    const a=points[0],b=points[i],c=points[i+1],ux=b.x-a.x,uy=b.y-a.y,uz=b.z-a.z,vx=c.x-a.x,vy=c.y-a.y,vz=c.z-a.z;
    const part=Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx)*.5,share=part/3;
    area+=part;px=px+((a.x+b.x)+c.x)*share;py=py+((a.y+b.y)+c.y)*share;pz=pz+((a.z+b.z)+c.z)*share;
  }
  return{area,point:area?{x:px*(1/area),y:py*(1/area),z:pz*(1/area)}:zero()};
}
function clipFootprint(points:PhysicsVector[],polygon:BoundaryPoint[]):PhysicsVector[]{
  const signed=polygon.reduce((sum,a,i)=>{const b=polygon[(i+1)%polygon.length];return sum+a.x*b.z-b.x*a.z;},0),sign=Math.sign(signed);
  for(let k=0;k<polygon.length&&points.length;k++){
    const p=polygon[k],q=polygon[(k+1)%polygon.length],nx=sign*(q.z-p.z),nz=sign*(p.x-q.x),offset=nx*p.x+nz*p.z,next:PhysicsVector[]=[];
    for(let j=0;j<points.length;j++){
      const a=points[j],b=points[(j+1)%points.length],da=nx*a.x+nz*a.z-offset,db=nx*b.x+nz*b.z-offset;
      if(da<=1e-12)next.push(a);
      if(da<0&&db>0||da>0&&db<0){const t=da/(da-db);next.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});}
    }
    points=next;
  }
  return points;
}
function clipBed(points:PhysicsVector[],height:(point:PhysicsVector)=>number):PhysicsVector[]{
  const result:PhysicsVector[]=[];
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],da=height(a)-a.y,db=height(b)-b.y;
    if(da<=0)result.push(a);
    if(da<0&&db>0||da>0&&db<0){const t=da/(da-db);result.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});}
  }
  return result;
}

/** Mutate only grid momentum. Returned virtual velocities include these
 * contacts, so a later solve of the same bodies cannot spend the same momentum. */
export function waterBodySolidPressure(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,bodies:PhysicsCompoundBody[],dt:number,contacts:Map<string,LiquidContact>):PhysicsCompoundBody[]{
  let tests=0;const cells=waterBodyCells(w,s);
  const result=[...bodies].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(body=>{
    if(body.fixed)return body;
    const properties=physicsBodyMassProperties(body),mass=properties.mass;
    let velocity={...body.velocity},omega={...(body.angularVelocity??zero())};
    if(Object.values(omega).some(n=>!Number.isFinite(n)||Math.abs(n)>10000))throw new Error('Invalid water body pressure angular velocity');
    const exchanges:{colliderId:string;point:PhysicsVector;impulse:PhysicsVector;torque:PhysicsVector;relative:number}[]=[];
    const cellImpulses=new Map<number,PhysicsVector>();let totalImpulse=zero(),totalTorque=zero();
    for(const o of geometry.obstacles){
      if(o.bodyId!==body.id)continue;
      const mesh=waterBodySolid(o.collider.shape);
      for(const local of mesh.faces){
        const face=local.map(p=>add(o.collider.position,liquidRotate(p,o.collider.rotation)));
        if(face.length<3)continue;
        const n=cross(sub(face[1],face[0]),sub(face[2],face[0])),length=Math.hypot(n.x,n.y,n.z),horizontal=Math.hypot(n.x,n.z);
        if(horizontal<1e-10||length<1e-10)continue;
        const normal={x:n.x/horizontal,y:0,z:n.z/horizontal};
        const footprint=cells.indices({min:{x:Math.min(...face.map(p=>p.x)),z:Math.min(...face.map(p=>p.z))},max:{x:Math.max(...face.map(p=>p.x)),z:Math.max(...face.map(p=>p.z))}});
        for(const i of footprint){
          if(++tests>32768)throw new Error('Water body pressure face budget exceeded; stream fewer solids');
          let points=clipFootprint(face,cells.polygon(i));
          const full=patch(points);if(full.area<1e-10)continue;
          // Exchange with the neighboring liquid outside the physical face,
          // not an imaginary water reservoir in the solid's occupied column.
          const refined=!!s.boundary&&!cells.region(i)?.bulk;
          const reach=refined?Math.min(w.cellSizeX,w.cellSizeZ)*1e-6:Math.max(w.cellSizeX,w.cellSizeZ)*.55;
          const cell=cells.locate({x:full.point.x+normal.x*reach,z:full.point.z+normal.z*reach});if(cell===undefined)continue;
          if(refined&&cell!==i)continue;
          const depth=cells.depth(cell),bed=cells.bedAt(cell,full.point.x,full.point.z),surface=cells.level(cell);
          if(depth<=w.wetDepth||(!s.boundary||cells.region(cell)?.bulk)&&geometry.blocked[cells.parent(cell)])continue;
          points=s.boundary?clipBed(points,p=>cells.bedAt(cell,p.x,p.z)):clip(points,'y',bed,-1);
          points=clip(points,'y',surface,1);const wet=patch(points);
          if(wet.area<1e-10)continue;
          const lever=sub(wet.point,properties.center),pointVelocity=add(velocity,cross(omega,lever));
          const relative=dot(sub(pointVelocity,{x:cells.flowX[cell],y:0,z:cells.flowZ[cell]}),normal);
          if(relative<=1e-7)continue;
          const waterMass=w.liquid.restDensity*cells.volume(cell),arm=cross(lever,normal);
          const rotational=body.lockRotations?0:Math.max(0,dot(arm,physicsApplyInverseInertia(properties,arm)));
          const reduced=1/(1/mass+1/waterMass+rotational),sweptMass=.5*w.liquid.restDensity*wet.area*(horizontal/length)*relative*dt;
          const impulse=reduced*relative*(1-Math.exp(-sweptMass/reduced));if(impulse<=1e-12)continue;
          const waterImpulse=scale(normal,impulse),bodyImpulse=scale(waterImpulse,-1),angularImpulse=cross(lever,bodyImpulse);
          exchanges.push({colliderId:o.colliderId,point:wet.point,impulse:bodyImpulse,torque:angularImpulse,relative});
          totalImpulse=add(totalImpulse,bodyImpulse);totalTorque=add(totalTorque,angularImpulse);
          cellImpulses.set(cell,add(cellImpulses.get(cell)??zero(),waterImpulse));
        }
      }
    }
    // Evaluate all surface patches at one accepted rigid velocity. Sequential
    // face kicks otherwise make a symmetric translating hull acquire yaw.
    // Bound their combined rigid+water energy, not merely each patch alone.
    const angularDelta=body.lockRotations?zero():physicsApplyInverseInertia(properties,totalTorque);
    let linear=dot(velocity,totalImpulse)+dot(omega,totalTorque),quadratic=(dot(totalImpulse,totalImpulse)/mass+dot(totalTorque,angularDelta))*.5;
    for(const [cell,impulse] of cellImpulses){
      const waterMass=w.liquid.restDensity*cells.volume(cell);
      linear+=cells.flowX[cell]*impulse.x+cells.flowZ[cell]*impulse.z;quadratic+=dot(impulse,impulse)/(2*waterMass);
    }
    let alpha=quadratic>0?Math.max(0,Math.min(1,-linear/(2*quadratic))):0;
    for(const [cell,impulse] of cellImpulses){
      const waterMass=w.liquid.restDensity*cells.volume(cell),current={x:cells.flowX[cell],y:0,z:cells.flowZ[cell]},delta=scale(impulse,1/waterMass);
      const limit=Math.max(w.maxFlowSpeed,Math.hypot(current.x,current.z));
      if(Math.hypot(current.x+delta.x*alpha,current.z+delta.z*alpha)>limit){
        const a=dot(delta,delta),b=2*dot(current,delta),c=dot(current,current)-limit*limit;
        alpha=Math.min(alpha,a?Math.max(0,(-b+Math.sqrt(Math.max(0,b*b-4*a*c)))/(2*a)):0);
      }
    }
    velocity=add(velocity,scale(totalImpulse,alpha/mass));omega=add(omega,scale(angularDelta,alpha));
    for(const [cell,impulse] of cellImpulses)if(alpha>0){
      const waterMass=w.liquid.restDensity*cells.volume(cell);
      cells.flowX[cell]+=alpha*impulse.x/waterMass;cells.flowZ[cell]+=alpha*impulse.z/waterMass;cells.wake(cell);
    }
    for(const exchange of exchanges)if(alpha>0){
      const key=`${body.id}/${exchange.colliderId}`,prior=contacts.get(key),impulse=scale(exchange.impulse,alpha),angularImpulse=scale(exchange.torque,alpha);
      if(prior){prior.impulse=add(prior.impulse,impulse);prior.angularImpulse=add(prior.angularImpulse??zero(),angularImpulse);prior.speed=Math.max(prior.speed,exchange.relative);}
      else contacts.set(key,{bodyId:body.id,colliderId:exchange.colliderId,point:exchange.point,impulse,angularImpulse,force:zero(),kineticEnergy:0,speed:exchange.relative});
    }
    return{...body,velocity,angularVelocity:omega};
  });
  cells.commit();return result;
}
