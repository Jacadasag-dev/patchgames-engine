/** Grid-only rigid-body support. Local 3D particles already transfer pressure
 * and shear in stepLiquid; never add this force for that particle volume.
 * Solid occupancy in stepWaterBody raises hydraulic head and launches
 * displacement waves without adding liquid. This call supplies body support;
 * it never displaces that volume twice. Horizontal drag exchanges equal and
 * opposite momentum with the actual grid water mass. */
import {physicsGravityDisplacement,type PhysicsCompoundBody,type PhysicsVector} from './physics.ts';
import type {LiquidContact} from './waterDomain.ts';
import {validateWaterBodyState,type WaterBodyManifest,type WaterBodyState} from './waterBody.ts';
import {liquidObstacles} from './liquidCollision.ts';
import {waterBodySolid as solid,waterBodyObstacleRegion} from './waterBodySolids.ts';
import {physicsBodyMassProperties,physicsApplyInverseInertia} from './physicsMassProperties.ts';
import {cloneWaterBodyDepthCurrents,waterBodyDepthCurrentCoupling,prepareWaterBodyDepthCurrents} from './waterBodyDepthCurrents.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {cloneBoundaryState} from './waterBoundary.ts';

export const WATER_BODY_BUOYANCY_LIMITS=Object.freeze({bodies:64,colliders:256,cellTests:32768});
export interface WaterBodyBuoyancyOptions {
  /** 0..1 effective displaced solid fraction. Use real solid colliders for open
   * pallets; a sealed hollow shell can displace its full enclosed volume. */
  displacementScale?:number;
  /** Vertical relaxation / second at equal immersed/body mass. Default 4.
   * Explicit values also set horizontalDrag unless overridden. */
  drag?:number;
  /** Current-relative horizontal relaxation / second. Default .35. */
  horizontalDrag?:number;
  /** Roll/pitch relaxation / second. Default 4; explicit values also set yawDrag. */
  angularDrag?:number;
  /** Yaw relaxation / second. Default .25. Spin dissipates into unresolved turbulence. */
  yawDrag?:number;
}
export interface WaterBodyBuoyancyStep extends WaterBodyBuoyancyOptions {
  water:WaterBodyManifest;state:WaterBodyState;bodies:PhysicsCompoundBody[];dt:number;
  /** Optional overrides keyed by stable body identity. */
  bodyOptions?:Record<string,WaterBodyBuoyancyOptions>;
  /** Inspect sleeping bodies without reacting against the water. Apply contacts
   * only after deciding to wake them; active bodies use the normal call. */
  probe?:boolean;
}
export interface WaterBodyBuoyancyBodyStats {
  bodyId:string;mass:number;solidVolume:number;submergedVolume:number;displacedVolume:number;
  buoyancyForce:PhysicsVector;dragImpulse:PhysicsVector;
  centerOfMass:PhysicsVector;centerOfBuoyancy?:PhysicsVector;
  buoyancyTorque:PhysicsVector;dragTorqueImpulse:PhysicsVector;
}
export interface WaterBodyBuoyancyResult {
  state:WaterBodyState;contacts:LiquidContact[];
  stats:{bodies:WaterBodyBuoyancyBodyStats[];cellTests:number;gridReaction:PhysicsVector};
}
type Portion={cell:number;colliderId:string;volume:number;point:PhysicsVector;hull:boolean};
const zero=():PhysicsVector=>({x:0,y:0,z:0});
const add=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const scale=(v:PhysicsVector,s:number):PhysicsVector=>({x:v.x*s,y:v.y*s,z:v.z*s});
const dot=(a:PhysicsVector,b:PhysicsVector)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const magnitude=(v:PhysicsVector)=>Math.hypot(v.x,v.y,v.z);
const number=(v:number,name:string,min:number,max:number)=>{if(!Number.isFinite(v)||v<min||v>max)throw new Error(`Invalid water body buoyancy ${name}`);return v;};

/** Use post-flow velocities; apply combined contacts once to original bodies
 * before native integration. Probe sleepers without water reaction. */
export function applyWaterBodyBuoyancy(input:WaterBodyBuoyancyStep):WaterBodyBuoyancyResult {
  const {water:w,state:previous,bodies,dt}=input;
  validateWaterBodyState(w,previous);number(dt,'step time',1e-5,.05);
  if(Math.abs(w.liquid.gravity.x)>1e-9||Math.abs(w.liquid.gravity.z)>1e-9||w.liquid.gravity.y>=0)throw new Error('Water body buoyancy requires downward Y gravity');
  const displacement=number(input.displacementScale??1,'displacement scale',0,1),drag=number(input.drag??4,'drag',0,100),angularDrag=number(input.angularDrag??4,'angular drag',0,100);
  const horizontalDefault=number(input.horizontalDrag??input.drag??.35,'horizontal drag',0,100),yawDefault=number(input.yawDrag??input.angularDrag??.25,'yaw drag',0,100);
  if(input.probe!==undefined&&typeof input.probe!=='boolean')throw new Error('Invalid water body buoyancy probe');
  if(!Array.isArray(bodies)||bodies.length>WATER_BODY_BUOYANCY_LIMITS.bodies)throw new Error('Water body buoyancy body budget exceeded');
  for(const body of bodies)if(body?.angularVelocity!==undefined&&(!body.angularVelocity||[body.angularVelocity.x,body.angularVelocity.y,body.angularVelocity.z].some(n=>!Number.isFinite(n)||Math.abs(n)>10000)))throw new Error('Invalid water body buoyancy angular velocity');
  if(input.bodyOptions&&(typeof input.bodyOptions!=='object'||Array.isArray(input.bodyOptions)||Object.keys(input.bodyOptions).length>WATER_BODY_BUOYANCY_LIMITS.bodies))throw new Error('Invalid water body buoyancy body options');
  const ordered=[...bodies].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),obstacles=liquidObstacles({colliders:[]},ordered);
  const contacts=new Map<string,LiquidContact>(),bodyStats:WaterBodyBuoyancyBodyStats[]=[],gridReaction=zero();
  const rho=w.liquid.restDensity,g=-w.liquid.gravity.y;
  // Clone only mutable momentum fields. Depth, particles and volume accounting
  // are unchanged and remain shared immutable inputs in this pure operation.
  let state=previous,cellTests=0,cells=waterBodyCells(w,state);const initialCells=cells;
  const mutable=()=>{if(state===previous){state={...previous,revision:previous.revision+1,flowX:previous.flowX.slice(),flowZ:previous.flowZ.slice(),sleeping:previous.sleeping.slice(),quietTime:previous.quietTime.slice(),...(previous.depthCurrents?{depthCurrents:cloneWaterBodyDepthCurrents(previous.depthCurrents)}:{}),...(previous.boundary?{boundary:cloneBoundaryState(previous.boundary),depth:previous.depth.slice(),...(previous.solidDepth?{solidDepth:previous.solidDepth.slice()}:{})}:{})};cells=waterBodyCells(w,state);}};
  for(const body of ordered){
    if(body.fixed)continue;
    const options=input.bodyOptions?.[body.id],fraction=number(options?.displacementScale??displacement,'body displacement scale',0,1),rate=number(options?.drag??drag,'body drag',0,100),angularRate=number(options?.angularDrag??angularDrag,'body angular drag',0,100);
    const horizontalRate=number(options?.horizontalDrag??options?.drag??horizontalDefault,'body horizontal drag',0,100),yawRate=number(options?.yawDrag??options?.angularDrag??yawDefault,'body yaw drag',0,100);
    const matching=obstacles.filter(o=>o.bodyId===body.id),solidVolume=matching.reduce((sum,o)=>sum+solid(o.collider.shape).volume,0);
    const properties=physicsBodyMassProperties(body),mass=properties.mass;
    const diagnostic:WaterBodyBuoyancyBodyStats={bodyId:body.id,mass,solidVolume,submergedVolume:0,displacedVolume:0,buoyancyForce:zero(),dragImpulse:zero(),centerOfMass:properties.center,buoyancyTorque:zero(),dragTorqueImpulse:zero()};
    bodyStats.push(diagnostic);if(fraction===0)continue;
    // The water step already solved this body's vertical support in its hull
    // columns together with the water. Drag still applies there: the grid
    // resolves pressure, not viscous or form drag. A probe sees hydrostatics.
    const portions:Portion[]=[],hullCells=new Set(input.probe?undefined:previous.hulls?.find(entry=>entry.bodyId===body.id)?.cells);
    for(const obstacle of matching){
      const mesh=solid(obstacle.collider.shape);
      for(const i of initialCells.indices({min:obstacle.min,max:obstacle.max})){
        if(++cellTests>WATER_BODY_BUOYANCY_LIMITS.cellTests)throw new Error('Water body buoyancy cell budget exceeded; stream fewer active bodies');
        const depth=initialCells.depth(i),bed=initialCells.bed(i),surface=initialCells.level(i);
        if(depth<=w.dryDepth||obstacle.min.y>=surface||obstacle.max.y<=bed)continue;
        const part=waterBodyObstacleRegion(w,previous,obstacle,i,bed,surface);
        const volume=part.volume*mesh.scale;if(volume<=1e-12)continue;
        portions.push({cell:i,colliderId:obstacle.colliderId,volume,point:part.point,hull:hullCells.has(i)});
        diagnostic.submergedVolume+=volume;
      }
    }
    const totalDisplaced=diagnostic.submergedVolume*fraction,supportVolume=portions.reduce((sum,p)=>p.hull?sum:sum+p.volume*fraction,0);
    diagnostic.displacedVolume=totalDisplaced;diagnostic.buoyancyForce.y=rho*g*supportVolume;
    // A hull's drag opposes the motion the water step solved for it: its
    // velocity over this native step. The post-flow velocity already holds
    // the hull support, which native gravity cancels within the step, so at
    // rest that mean motion is zero. Dragging against the start velocity
    // instead pumped the water under a resting hull. Other bodies keep the
    // explicit law on their pre-support velocity.
    const hull=!input.probe&&previous.hulls?.some(entry=>entry.bodyId===body.id);
    const motion=hull?{x:body.velocity.x,y:body.velocity.y+(rho*g*supportVolume/mass-g*physicsGravityDisplacement(dt))*dt,z:body.velocity.z}:body.velocity;
    // Vertical drag uses the total immersed mass so subdividing a collider or
    // crossing cell boundaries cannot change the aggregate damping rate.
    const verticalDrag=-mass*motion.y*(1-Math.exp(-rate*rho*totalDisplaced*dt/mass));
    if(totalDisplaced>0)diagnostic.centerOfBuoyancy=scale(portions.reduce((sum,p)=>add(sum,scale(p.point,p.volume*fraction)),zero()),1/totalDisplaced);
    // Locked recoil does not erase an explicitly prescribed motor turn.
    const omega=body.angularVelocity??zero(),tensor=properties.inertia;
    if(!input.probe&&w.currents!==false&&w.depthCurrents!==false&&totalDisplaced>1e-10&&(!state.depthCurrents||state.depthCurrents.sleeping)
      &&portions.some(part=>Math.abs(motion.y+cross(omega,sub(part.point,properties.center)).y)>Math.max(.03,w.sleepSpeed))){
      mutable();prepareWaterBodyDepthCurrents(w,state,obstacles);
    }
    const dragParts:{part:Portion;displaced:number;impulse:PhysicsVector;moment:PhysicsVector;relative:PhysicsVector}[]=[];
    const cellImpulses=new Map<number,PhysicsVector>();let dragImpulse=zero(),dragMoment=zero();
    const coupling=waterBodyDepthCurrentCoupling(w,state),depthFaces=state.depthCurrents?[state.depthCurrents.velocityX,state.depthCurrents.velocityY,state.depthCurrents.velocityZ]:[];
    const residualDeltas=new Map<string,{axis:0|1|2;face:number;delta:number;mass:number}>();
    // All portions see the same initial rigid velocity. Sequentially changing
    // just COM velocity made a symmetric board develop a spurious yaw because
    // cells visited first received more drag. Include actual point velocity and
    // rotational effective mass, then bound the combined simultaneous update.
    for(const part of portions){
      const displaced=part.volume*fraction,cell=part.cell,waterMass=rho*initialCells.volume(cell);
      const lever=sub(part.point,properties.center),current={x:cells.flowX[cell],y:0,z:cells.flowZ[cell]},stencil=coupling?.stencil(part.point)??[];
      for(const entry of stencil)current[entry.axis===0?'x':entry.axis===1?'y':'z']+=entry.weight*depthFaces[entry.axis][entry.face];
      const relative=sub(current,add(motion,cross(omega,lever))),horizontal=Math.hypot(relative.x,relative.z);
      const direction=horizontal?{x:relative.x/horizontal,y:0,z:relative.z/horizontal}:zero(),arm=cross(lever,direction);
      const rotational=body.lockRotations?0:dot(arm,physicsApplyInverseInertia(properties,arm));
      const reducedMass=1/(1/mass+1/waterMass+Math.max(0,rotational)),relaxation=1-Math.exp(-horizontalRate*rho*displaced*dt/reducedMass);
      const impulse={x:relative.x*reducedMass*relaxation,y:totalDisplaced?verticalDrag*displaced/totalDisplaced:0,z:relative.z*reducedMass*relaxation};
      if(coupling){
        for(const [axis,index] of [['x',0],['y',1],['z',2]] as const){
          const unit=zero();unit[axis]=1;const axisArm=cross(lever,unit),rotation=body.lockRotations?0:Math.max(0,dot(axisArm,physicsApplyInverseInertia(properties,axisArm)));
          const fluidInverseMass=stencil.filter(entry=>entry.axis===index).reduce((sum,entry)=>sum+entry.weight*entry.weight/(entry.mass??coupling.mass),0)+(axis==='y'?0:1/waterMass);
          const effectiveMass=1/(1/mass+rotation+fluidInverseMass),coefficient=axis==='y'?rate:horizontalRate;
          impulse[axis]=relative[axis]*effectiveMass*(1-Math.exp(-coefficient*rho*displaced*dt/effectiveMass));
        }
        // Scatter is the adjoint of the exact sampled face stencil. Its work
        // is therefore -J·u, allowing a joint body/grid energy bound below.
        for(const entry of stencil){const key=`${entry.axis}/${entry.face}`,mass=entry.mass??coupling.mass,delta=-impulse[entry.axis===0?'x':entry.axis===1?'y':'z']*entry.weight/mass,prior=residualDeltas.get(key);
          if(prior)prior.delta+=delta;else residualDeltas.set(key,{axis:entry.axis,face:entry.face,delta,mass});}
      }
      // Vertical damping is an aggregate COM law. Adding its moment at each
      // submerged centroid would double-count unresolved rotational damping.
      const horizontalImpulse={x:impulse.x,y:0,z:impulse.z},moment=cross(lever,coupling?impulse:horizontalImpulse);
      dragParts.push({part,displaced,impulse,moment,relative});dragImpulse=add(dragImpulse,impulse);dragMoment=add(dragMoment,moment);
      cellImpulses.set(cell,add(cellImpulses.get(cell)??zero(),horizontalImpulse));
    }
    // Delta horizontal/angular kinetic energy plus all affected grid masses is
    // alpha*linear + alpha²*quadratic. Keep the step on its dissipative side and
    // no farther than the energy minimum, including simultaneous collider/cell
    // contacts. Independent COM-only vertical damping is already bounded by
    // its exact exponential law. This prevents high drag from adding spin.
    const angularDelta=body.lockRotations?zero():physicsApplyInverseInertia(properties,dragMoment);
    const horizontalDrag={x:dragImpulse.x,y:coupling?dragImpulse.y:0,z:dragImpulse.z};
    let linear=dot(motion,horizontalDrag)+dot(omega,dragMoment),quadratic=(dot(horizontalDrag,horizontalDrag)/mass+dot(dragMoment,angularDelta))/2;
    for(const [cell,impulse] of cellImpulses){
      const waterMass=rho*initialCells.volume(cell);
      // With persistent currents disabled, water acts as an externally held
      // local flow for drag. Preserve relative-flow damping without writing a
      // body reaction into the grid; gravity/pressure momentum remains intact.
      linear-=cells.flowX[cell]*impulse.x+cells.flowZ[cell]*impulse.z;
      if(w.currents!==false)quadratic+=dot(impulse,impulse)/(2*waterMass);
    }
    if(coupling)for(const entry of residualDeltas.values()){
      linear+=entry.mass*depthFaces[entry.axis][entry.face]*entry.delta;quadratic+=entry.mass*entry.delta*entry.delta/2;
    }
    let alpha=quadratic>0?Math.max(0,Math.min(1,-linear/(2*quadratic))):0;
    // A joint energy minimum alone could spend vertical kinetic energy to
    // reverse horizontal translation under extreme drag. Keep each COM axis
    // within the range of fluid/point-motion targets actually encountered.
    if(coupling)for(const axis of ['x','y','z'] as const){
      let low=Infinity,high=-Infinity;for(const part of dragParts){const target=motion[axis]+part.relative[axis];low=Math.min(low,target);high=Math.max(high,target);}
      const velocity=motion[axis],delta=dragImpulse[axis]/mass;
      if(delta<0&&velocity>=high)alpha=Math.min(alpha,Math.max(0,(low-velocity)/delta));
      if(delta>0&&velocity<=low)alpha=Math.min(alpha,Math.max(0,(high-velocity)/delta));
    }
    if(coupling)for(const entry of residualDeltas.values()){
      const current=depthFaces[entry.axis][entry.face],maximum=Math.max(w.depthCurrents&&w.depthCurrents.maxSpeed||12,Math.abs(current)),delta=entry.delta;
      if(delta>0)alpha=Math.min(alpha,Math.max(0,(maximum-current)/delta));else if(delta<0)alpha=Math.min(alpha,Math.max(0,(-maximum-current)/delta));
    }
    for(const [cell,impulse] of cellImpulses)if(w.currents!==false){
      const waterMass=rho*initialCells.volume(cell),current={x:cells.flowX[cell],y:0,z:cells.flowZ[cell]};
      const delta=scale(impulse,-1/waterMass),limit=Math.max(w.maxFlowSpeed,magnitude(current));
      if(magnitude(add(current,scale(delta,alpha)))>limit+1e-10){
        const a=dot(delta,delta),b=2*dot(current,delta),c=dot(current,current)-limit*limit;
        alpha=Math.min(alpha,a?Math.max(0,(-b+Math.sqrt(Math.max(0,b*b-4*a*c)))/(2*a)):0);
      }
    }
    for(const [cell,impulse] of cellImpulses)if(w.currents!==false&&!input.probe&&alpha>0&&(Math.abs(impulse.x)>1e-12||Math.abs(impulse.z)>1e-12)){
      const applied=scale(impulse,alpha),waterMass=rho*initialCells.volume(cell);
      mutable();cells.flowX[cell]-=applied.x/waterMass;cells.flowZ[cell]-=applied.z/waterMass;
      cells.wake(cell);gridReaction.x-=applied.x;gridReaction.z-=applied.z;
    }
    if(coupling&&!input.probe&&alpha>0&&residualDeltas.size){
      mutable();const d=state.depthCurrents!,faces=[d.velocityX,d.velocityY,d.velocityZ];for(const entry of residualDeltas.values())faces[entry.axis][entry.face]+=entry.delta*alpha;
      d.sleeping=false;d.quietTime=0;gridReaction.y-=dragImpulse.y*alpha;
    }
    // Damp the resulting spin, not the stale incoming spin: otherwise two
    // individually bounded updates can overshoot when their torques cancel.
    const virtualOmega=add(omega,scale(angularDelta,alpha));
    const angularMomentum={x:tensor[0]*virtualOmega.x+tensor[1]*virtualOmega.y+tensor[2]*virtualOmega.z,y:tensor[3]*virtualOmega.x+tensor[4]*virtualOmega.y+tensor[5]*virtualOmega.z,z:tensor[6]*virtualOmega.x+tensor[7]*virtualOmega.y+tensor[8]*virtualOmega.z};
    // A uniform relaxation is exact for every inertia tensor. Apply any extra
    // axis damping as symmetric exact one-axis solves. Each torque opposes the
    // current spin and reduces kinetic energy, including rotated compound
    // bodies with off-diagonal inertia. Scaling omega axes independently would
    // not have that guarantee. Surface yaw can coast while roll/pitch settle.
    const immersedStep=rho*totalDisplaced*dt/mass,baseRate=Math.min(angularRate,yawRate);
    const spinDrag=body.lockRotations?zero():scale(angularMomentum,-(1-Math.exp(-baseRate*immersedStep)));
    let dampedOmega=scale(virtualOmega,Math.exp(-baseRate*immersedStep));
    const dampAxis=(axis:'x'|'y'|'z',extra:number,share=1)=>{
      if(extra<=0||body.lockRotations)return;
      const index=axis==='x'?0:axis==='y'?4:8,impulse=zero();
      impulse[axis]=-dampedOmega[axis]*(1-Math.exp(-extra*immersedStep*share))/properties.inverseInertia[index];
      dampedOmega=add(dampedOmega,physicsApplyInverseInertia(properties,impulse));
      spinDrag.x+=impulse.x;spinDrag.y+=impulse.y;spinDrag.z+=impulse.z;
    };
    dampAxis('x',angularRate-baseRate,.5);dampAxis('z',angularRate-baseRate);dampAxis('x',angularRate-baseRate,.5);
    dampAxis('y',yawRate-baseRate);
    diagnostic.dragImpulse={x:dragImpulse.x*alpha,y:dragImpulse.y*(coupling?alpha:1),z:dragImpulse.z*alpha};
    for(const {part,displaced,impulse:rawImpulse,moment,relative} of dragParts){
      const impulse={x:rawImpulse.x*alpha,y:rawImpulse.y*(coupling?alpha:1),z:rawImpulse.z*alpha},buoyancy={x:0,y:part.hull?0:rho*g*displaced,z:0};
      const buoyancyMoment=cross(sub(part.point,properties.center),buoyancy),appliedMoment=add(scale(moment,alpha),scale(spinDrag,displaced/totalDisplaced));
      diagnostic.buoyancyTorque=add(diagnostic.buoyancyTorque,buoyancyMoment);diagnostic.dragTorqueImpulse=add(diagnostic.dragTorqueImpulse,appliedMoment);
      const angularImpulse=add(scale(buoyancyMoment,dt),appliedMoment),forceImpulse=add(impulse,scale(buoyancy,dt)),key=`${body.id}/${part.colliderId}`;
      const contact=contacts.get(key);
      if(contact){contact.impulse=add(contact.impulse,forceImpulse);contact.angularImpulse=add(contact.angularImpulse!,angularImpulse);contact.point=add(contact.point,scale(part.point,displaced));contact.force.y+=displaced;contact.speed=Math.max(contact.speed,magnitude(relative));}
      else contacts.set(key,{bodyId:body.id,colliderId:part.colliderId,point:scale(part.point,displaced),impulse:forceImpulse,angularImpulse,force:{x:0,y:displaced,z:0},kineticEnergy:0,speed:magnitude(relative)});
    }
  }
  for(const contact of contacts.values()){contact.point=scale(contact.point,1/contact.force.y);contact.force=scale(contact.impulse,1/dt);}
  // The body reactions stay unprojected: the next water step's projection,
  // which runs after advection anyway, makes them divergence-free. A second
  // solve here cost as much as the main one in scenes with submerged bodies.
  if(state!==previous){cells.commit();validateWaterBodyState(w,state);}
  return{state,contacts:[...contacts.values()],stats:{bodies:bodyStats,cellTests,gridReaction}};
}
