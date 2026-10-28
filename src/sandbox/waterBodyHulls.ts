/** Floating hulls are lids on the shallow-water grid. Where a free body
 * crosses the water level in a column, the liquid there and the body's heave,
 * roll and pitch are solved together in one pressure correction per step.
 *
 * The explicit grid step is the predictor. Exchanging displacement one step
 * late instead feeds the large added mass of the water a light board pushes
 * aside back into the board, and that pumped boards into a permanent bounce.
 * Here the head offset `solidDepth` in each lid column is the unknown: it must
 * equal the hull's solid below the corrected water level at the hull's next
 * pose, the water moves under the matching pressure gradient, and the body
 * receives that same pressure as its support. The system is symmetric
 * positive definite (column compliance + grid Laplacian + rigid-body
 * response), so a fixed-tolerance conjugate gradient solves it exactly.
 * Nothing carries over between steps beyond the stored water state. */
import {physicsGravityDisplacement,type PhysicsCompoundBody,type PhysicsVector} from './physics.ts';
import type {LiquidContact} from './waterDomain.ts';
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';
import {waterBodyObstacleRegionClearance,waterBodyObstacleRegion,waterBodyObstacleRegionSection,waterBodySolid} from './waterBodySolids.ts';
import {physicsBodyMassProperties,physicsApplyInverseInertia,type PhysicsBodyMassProperties} from './physicsMassProperties.ts';
import {waterBodyCells} from './waterBodyCells.ts';

/** Grid columns whose vertical support a body received from the hull solve. */
export interface WaterBodyHull {bodyId:string;cells:number[]}
export interface WaterBodyHullWork {hulls:WaterBodyHull[];unknowns:number;iterations:number}
export const WATER_BODY_HULL_LIMITS=Object.freeze({cells:4096,cellTests:32768,passes:8,
  /** A body this close to the bed anywhere under it is grounded, not afloat. */ clearance:.01});

// A body's share of one column: its waterplane fraction of the column's and
// the lever (-r.z,0,r.x) at the waterplane centroid, which turns the body's
// spin into vertical motion there and is where added or removed support
// acts. `offset` is the fixed moment of the predicted support about that
// point: displaced volume times the offset of its own centroid.
type Share={body:number;weight:number;arm:PhysicsVector;offset:PhysicsVector;colliderId:string;area:number};
interface Lid {cell:number;area:number;sigma:number;maximum:number;compliance:number;target:number;shares:Share[];diagonal:number}
interface Face {a:number;b:number;nx:number;nz:number;kappa:number;depth:number;spacing:number;length:number}
interface Free {body:PhysicsCompoundBody;properties:PhysicsBodyMassProperties;mass:number}
const dot=(a:PhysicsVector,b:PhysicsVector)=>a.x*b.x+a.y*b.y+a.z*b.z;
// Half the end-of-step pressure velocity moves mass during the step: a
// pressure held over the step accelerates the water linearly from rest.
const THETA=.5;

/** Correct the predicted grid state in place and add one support contact
 * per supported body. Call after the explicit grid step. */
export function solveWaterBodyHulls(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,bodies:PhysicsCompoundBody[],dt:number,contacts:Map<string,LiquidContact>):WaterBodyHullWork{
  const movable=new Set(bodies.filter(b=>!b.fixed).map(b=>b.id));
  if(!movable.size||!s.solidDepth)return{hulls:[],unknowns:0,iterations:0};
  const grid=waterBodyCells(w,s),solid=grid.solidDepth;
  const g=-w.liquid.gravity.y,rho=w.liquid.restDensity;
  const head=(i:number)=>grid.level(i);
  const footprint=(o:WaterBodyGeometry['obstacles'][number],visit:(i:number)=>void)=>{
    for(const i of grid.indices({min:o.min,max:o.max})){if(++tests>WATER_BODY_HULL_LIMITS.cellTests)throw new Error('Water body hull cell budget exceeded; stream fewer floating bodies');visit(i);}
  };
  let tests=0;
  const crosses=(o:WaterBodyGeometry['obstacles'][number],i:number)=>{
    if(!s.boundary&&geometry.blocked[i]||grid.depth(i)<=w.wetDepth)return false;const level=head(i);return o.min.y<level&&o.max.y>level;};
  // Bounds alone find the bodies that may cross the water anywhere.
  const crossing=new Set<string>();
  for(const o of geometry.obstacles)if(o.bodyId!==undefined&&movable.has(o.bodyId)&&!crossing.has(o.bodyId))
    footprint(o,i=>{if(crosses(o,i))crossing.add(o.bodyId!);});
  // Only afloat bodies are lids. The solve predicts free fall plus its own
  // support, so a body touching the bed anywhere would be propped up by the
  // water against a contact that native physics resolves. Grounded bodies
  // keep explicit buoyancy and their native contacts.
  const grounded=new Set<string>();
  for(const o of geometry.obstacles)if(o.bodyId!==undefined&&crossing.has(o.bodyId)&&!grounded.has(o.bodyId))
    footprint(o,i=>{if(!grounded.has(o.bodyId!)&&waterBodyObstacleRegionClearance(w,s,o,i,geometry.terrainHeight)<=WATER_BODY_HULL_LIMITS.clearance)grounded.add(o.bodyId!);});
  const free:Free[]=bodies.filter(b=>crossing.has(b.id)&&!grounded.has(b.id)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(body=>{
    const properties=physicsBodyMassProperties(body);return{body,properties,mass:properties.mass};
  });
  if(!free.length)return{hulls:[],unknowns:0,iterations:0};
  const index=new Map(free.map((f,k)=>[f.body.id,k]));
  // Lid columns: a free body's solid crosses that column's own water level
  // over liquid deep enough to flow. Grounded columns are native contacts.
  const cuts=new Map<number,{area:number;shares:Map<number,{area:number;x:number;z:number;volume:number;vx:number;vz:number;colliderId:string;largest:number}>}>();
  for(const o of geometry.obstacles){
    const body=o.bodyId===undefined?undefined:index.get(o.bodyId);if(body===undefined)continue;
    footprint(o,i=>{
      if(!crosses(o,i))return;
      const level=head(i),cut=waterBodyObstacleRegionSection(w,s,o,i,level);if(cut.area<=grid.area(i)*1e-9)return;
      let entry=cuts.get(i);if(!entry){entry={area:0,shares:new Map()};cuts.set(i,entry);}
      entry.area+=cut.area;
      let share=entry.shares.get(body);if(!share){share={area:0,x:0,z:0,volume:0,vx:0,vz:0,colliderId:o.colliderId,largest:0};entry.shares.set(body,share);}
      share.area+=cut.area;share.x+=cut.x*cut.area;share.z+=cut.z*cut.area;
      if(cut.area>share.largest){share.largest=cut.area;share.colliderId=o.colliderId;}
    });
  }
  if(!cuts.size)return{hulls:[],unknowns:0,iterations:0};
  if(cuts.size>WATER_BODY_HULL_LIMITS.cells)throw new Error('Water body hull budget exceeded; stream fewer floating bodies');
  // Every solid in a lid column, fixed walls and fully submerged parts
  // included, sets how much solid lies below the predicted level there.
  const volume=new Map<number,number>(),maximum=new Map<number,number>(),fixed=new Map<number,number>();
  for(const o of geometry.obstacles){
    const scale=waterBodySolid(o.collider.shape).scale,body=o.bodyId===undefined?undefined:index.get(o.bodyId),coupled=body!==undefined;
    footprint(o,i=>{
      const entry=cuts.get(i);if(!entry)return;const level=head(i);
      if(o.max.y>grid.bed(i))maximum.set(i,(maximum.get(i)??0)+waterBodyObstacleRegion(w,s,o,i,grid.bed(i),o.max.y).volume*scale);
      if(o.max.y>grid.bed(i)&&o.min.y<level){
        const column=waterBodyObstacleRegion(w,s,o,i,grid.bed(i),level),solid=column.volume*scale,share=body===undefined?undefined:entry.shares.get(body);
        volume.set(i,(volume.get(i)??0)+solid);
        if(share){share.volume+=solid;share.vx+=column.point.x*solid;share.vz+=column.point.z*solid;}
      }
      if(!coupled&&o.min.y<level&&o.max.y>level)fixed.set(i,(fixed.get(i)??0)+waterBodyObstacleRegionSection(w,s,o,i,level).area);
    });
  }
  const cells=[...cuts.keys()].sort((a,b)=>a-b),slot=new Map(cells.map((cell,k)=>[cell,k]));
  const lids:Lid[]=cells.map(cell=>{
    const area=grid.area(cell),entry=cuts.get(cell)!,waterplane=Math.min(area,entry.area+(fixed.get(cell)??0)),fraction=waterplane/area;
    const shares:Share[]=[...entry.shares].sort((a,b)=>a[0]-b[0]).map(([body,share])=>{
      const center=free[body].properties.center,x=share.x/share.area,z=share.z/share.area;
      const offset=share.volume>0?{x:-(share.vz-z*share.volume),y:0,z:share.vx-x*share.volume}:{x:0,y:0,z:0};
      return{body,weight:share.area/waterplane,arm:{x:-(z-center.z),y:0,z:x-center.x},offset,colliderId:share.colliderId,area:share.area};
    });
    // Linearized column: solid below level grows by the waterplane per metre
    // of rise. Divided by that fraction, an open column is a soft spring and
    // a fully covered one a rigid constraint.
    return{cell,area,sigma:solid[cell],maximum:(maximum.get(cell)??0)/area,compliance:(1-fraction)/fraction,target:(volume.get(cell)??0)/area/fraction,shares,diagonal:0};
  });
  // Pressure faces: same open-face rule as the grid flux. A face to water
  // outside the lids keeps that side's head (zero correction there).
  const faces:Face[]=[];
  for(const f of grid.faces(geometry)){
    const {a,b}=f;if(b<0||!slot.has(a)&&!slot.has(b))continue;
    if(!s.boundary&&(geometry.blocked[a]||geometry.blocked[b]))continue;
    const crest=Math.max(f.start.bed,f.end.bed,f.barrier?.top??-Infinity);
    if(crest>=Math.min(head(a),head(b))-1e-8)continue;
    const depth=Math.min(grid.depth(a),grid.depth(b));if(depth<=w.dryDepth)continue;
    faces.push({a,b,nx:f.nx,nz:f.nz,kappa:THETA*dt*dt*g*depth*f.length/f.distance,depth,spacing:f.distance,length:f.length});
  }
  const links:{k:number;kappa:number}[][]=lids.map(()=>[]);
  for(const f of faces){const a=slot.get(f.a),b=slot.get(f.b);
    if(a!==undefined)lids[a].diagonal+=f.kappa;if(b!==undefined)lids[b].diagonal+=f.kappa;
    if(a!==undefined&&b!==undefined){links[a].push({k:b,kappa:f.kappa});links[b].push({k:a,kappa:f.kappa});}}
  // A unit of head offset in a column is rho g A of support on its bodies.
  // Multiply each row by its actual region area. Face exchange and rigid
  // response remain symmetric, so the same joint conjugate-gradient solve
  // works for unequal regions without coupling the two sides of a wall.
  const beta=dt*dt*rho*g,n=lids.length,active=Array(n).fill(true) as boolean[];
  const response=(f:Free,arm:PhysicsVector,force:number,torque:PhysicsVector)=>
    force/f.mass+(f.body.lockRotations?0:dot(arm,physicsApplyInverseInertia(f.properties,torque)));
  // Free vertical travel of each lid point this step, per dt, under gravity
  // and the fixed support moments as native integration moves it; support
  // impulses add dt·J/m.
  const fall=w.liquid.gravity.y*dt*physicsGravityDisplacement(dt),drift=new Float64Array(lids.length);
  const moments=()=>{const result=free.map(()=>({x:0,y:0,z:0}));
    for(let k=0;k<lids.length;k++)if(active[k])for(const share of lids[k].shares){result[share.body].x+=rho*g*dt*share.offset.x;result[share.body].z+=rho*g*dt*share.offset.z;}
    return result;};
  const force=new Float64Array(free.length),torque=free.map(()=>({x:0,y:0,z:0}));
  const apply=(x:Float64Array,y:Float64Array)=>{
    force.fill(0);for(const t of torque){t.x=0;t.z=0;}
    for(let k=0;k<n;k++)if(active[k])for(const share of lids[k].shares){const amount=lids[k].area*share.weight*x[k];force[share.body]+=amount;
      torque[share.body].x+=amount*share.arm.x;torque[share.body].z+=amount*share.arm.z;}
    for(let k=0;k<n;k++){
      if(!active[k]){y[k]=0;continue;}
      let sum=(lids[k].area*lids[k].compliance+lids[k].diagonal)*x[k];
      for(const link of links[k])if(active[link.k])sum-=link.kappa*x[link.k];
      for(const share of lids[k].shares)sum+=beta*lids[k].area*share.weight*response(free[share.body],share.arm,force[share.body],torque[share.body]);
      y[k]=sum;
    }
  };
  const preconditioner=lids.map(lid=>lid.area*lid.compliance+lid.diagonal+lid.shares.reduce((sum,share)=>
    sum+beta*lid.area*lid.area*share.weight*share.weight*response(free[share.body],share.arm,1,share.arm),0));
  const x=new Float64Array(n),rhs=new Float64Array(n),r=new Float64Array(n),z=new Float64Array(n),p=new Float64Array(n),q=new Float64Array(n);
  let iterations=0;
  for(let pass=0;pass<WATER_BODY_HULL_LIMITS.passes;pass++){
    // Right side: predicted solid head, the head already applied by the
    // predictor, and the bodies' free fall. Detached neighbours keep theirs.
    const moment=moments(),spin=free.map((f,b)=>{const omega=f.body.angularVelocity??{x:0,y:0,z:0};if(f.body.lockRotations)return omega;
      const turn=physicsApplyInverseInertia(f.properties,moment[b]);return{x:omega.x+turn.x,y:omega.y+turn.y,z:omega.z+turn.z};});
    for(let k=0;k<n;k++)drift[k]=lids[k].shares.reduce((sum,share)=>sum+share.weight*(free[share.body].body.velocity.y+fall+dot(spin[share.body],share.arm)),0);
    let norm=0;
    for(let k=0;k<n;k++){
      x[k]=active[k]?Math.max(0,lids[k].sigma):0;if(!active[k]){rhs[k]=0;continue;}
      let value=lids[k].area*(lids[k].target-lids[k].sigma-dt*drift[k])+lids[k].diagonal*lids[k].sigma;
      for(const link of links[k])if(active[link.k])value-=link.kappa*lids[link.k].sigma;
      rhs[k]=value;norm=Math.max(norm,Math.abs(value));
    }
    apply(x,q);let rz=0;
    for(let k=0;k<n;k++){r[k]=rhs[k]-q[k];z[k]=active[k]?r[k]/preconditioner[k]:0;p[k]=z[k];rz+=r[k]*z[k];}
    const tolerance=1e-9*Math.max(norm,1e-3),limit=4*n+40;
    for(let iteration=0;iteration<limit;iteration++){
      let residual=0;for(let k=0;k<n;k++)residual=Math.max(residual,Math.abs(r[k]));if(residual<=tolerance)break;
      apply(p,q);let pq=0;for(let k=0;k<n;k++)pq+=p[k]*q[k];if(!(pq>0))break;
      const alpha=rz/pq;let next=0;
      for(let k=0;k<n;k++){x[k]+=alpha*p[k];r[k]-=alpha*q[k];z[k]=active[k]?r[k]/preconditioner[k]:0;next+=r[k]*z[k];}
      const ratio=next/rz;rz=next;for(let k=0;k<n;k++)p[k]=z[k]+ratio*p[k];iterations++;
    }
    // The lid approximation applies only while the waterline cuts the hull.
    // Negative displacement detaches it; more than its entire solid column
    // submerges it. Either transition returns that column to explicit body
    // buoyancy instead of storing impact pressure as invented solid volume.
    let released=false;for(let k=0;k<n;k++)if(active[k]&&(x[k]<0||x[k]>lids[k].maximum)){active[k]=false;released=true;}
    if(!released)break;
  }
  for(let k=0;k<n;k++)if(!active[k]||x[k]<0){active[k]=false;x[k]=lids[k].sigma;}
  // Conservative correction: face transfers move volume between columns, and
  // the same pressure gradient changes the cell-centred momentum on both sides.
  const change=(k:number|undefined)=>k===undefined||!active[k]?0:x[k]-lids[k].sigma;
  const depthChange=new Map<number,number>(),momentum=new Map<number,{x:number;z:number}>();
  for(const f of faces){
    const a=change(slot.get(f.a)),b=change(slot.get(f.b));if(a===b)continue;
    const transfer=f.kappa*(b-a),push=-dt*g*f.depth*(b-a)*f.length*.5;
    depthChange.set(f.a,(depthChange.get(f.a)??0)+transfer);depthChange.set(f.b,(depthChange.get(f.b)??0)-transfer);
    for(const cell of [f.a,f.b]){const m=momentum.get(cell)??{x:0,z:0};m.x+=push*f.nx;m.z+=push*f.nz;momentum.set(cell,m);}
  }
  // Positivity: a strong correction may not drain a shallow neighbour. Scale
  // the whole correction (water and bodies alike) to the largest safe step.
  let fraction=1;
  for(const [cell,delta] of depthChange)if(delta<0&&grid.volume(cell)+delta<0)fraction=Math.min(fraction,.999*grid.volume(cell)/-delta);
  for(const [cell,delta] of depthChange){
    const old=grid.volume(cell),volume=Math.max(0,old+delta*fraction),m=momentum.get(cell)!,wet=volume>w.dryDepth*grid.area(cell);
    let px=old*grid.flowX[cell]+m.x*fraction,pz=old*grid.flowZ[cell]+m.z*fraction;
    if(wet){const speed=Math.hypot(px,pz)/volume;if(speed>w.maxFlowSpeed){px*=w.maxFlowSpeed/speed;pz*=w.maxFlowSpeed/speed;}}else px=pz=0;
    grid.setVolume(cell,volume);grid.flowX[cell]=wet?px/volume:0;grid.flowZ[cell]=wet?pz/volume:0;
    if(Math.abs(delta*fraction)>1e-9*grid.area(cell))grid.wake(cell);
  }
  const support=free.map(()=>({force:0,torque:{x:0,y:0,z:0},cells:[] as number[],colliders:new Map<string,number>()})),moment=moments();
  moment.forEach((m,b)=>{support[b].torque.x+=m.x;support[b].torque.z+=m.z;});
  for(let k=0;k<n;k++){
    if(!active[k])continue;const sigma=lids[k].sigma+(x[k]-lids[k].sigma)*fraction;
    if(Math.abs(sigma-solid[lids[k].cell])>1e-9)grid.wake(lids[k].cell);
    solid[lids[k].cell]=sigma;
    for(const share of lids[k].shares){const entry=support[share.body],amount=rho*g*lids[k].area*share.weight*sigma*dt;
      entry.force+=amount;entry.torque.x+=amount*share.arm.x;entry.torque.z+=amount*share.arm.z;entry.cells.push(lids[k].cell);
      entry.colliders.set(share.colliderId,(entry.colliders.get(share.colliderId)??0)+share.area);}
  }
  const hulls:WaterBodyHull[]=[];
  support.forEach((entry,k)=>{
    if(!entry.cells.length)return;const body=free[k].body,center=free[k].properties.center;
    const colliderId=[...entry.colliders].sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1))[0][0];
    contacts.set(`${body.id}/water-body-hull`,{colliderId,bodyId:body.id,point:{...center},impulse:{x:0,y:entry.force,z:0},
      ...(body.lockRotations?{}:{angularImpulse:entry.torque}),force:{x:0,y:0,z:0},kineticEnergy:0,speed:0});
    hulls.push({bodyId:body.id,cells:entry.cells});
  });
  grid.commit();return{hulls,unknowns:n,iterations};
}
