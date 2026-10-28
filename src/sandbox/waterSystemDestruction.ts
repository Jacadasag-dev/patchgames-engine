/** Turnkey shared fluid/destruction/native integration for authored games. */
import {createWaterSystemState,stepWaterSystem,type WaterSystemManifest,type WaterSystemState,type WaterWind} from './waterSystem.ts';
import {createDestructionState,prepareDestructionScene,stepDestruction,type StructuralManifest,type DestructionState} from './destruction.ts';
import {createWaterBodyFloatingState,stepWaterBodyFloating,validateWaterBodyFloatingState,type WaterBodyFloatingState} from './waterBodyFloating.ts';
import {liquidDestructionBodies,applyLiquidDestruction,applyLiquidImpulses} from './liquidCoupling.ts';
import type {PhysicsCompoundBody,PhysicsScene} from './physics.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {mergeWaterDetailEvents,type WaterDetailEvent} from './waterDetail.ts';

export interface WaterSystemDestructionState {water:WaterSystemState;destruction:DestructionState;floating:WaterBodyFloatingState}
export function createWaterSystemDestructionState(system:WaterSystemManifest,structure:StructuralManifest,destruction=createDestructionState(structure)):WaterSystemDestructionState {
  return{water:createWaterSystemState(system),destruction,floating:createWaterBodyFloatingState(system.water,structure)};
}
/** Engine native bridge required, as for stepDestruction. External bodies are
 * integrated once here; do not step the returned bodies a second time. */
export interface WaterSystemDestructionStep {
  system:WaterSystemManifest;structure:StructuralManifest;state:WaterSystemDestructionState;dt:number;
  scene?:PhysicsScene;bodies?:PhysicsCompoundBody[];damage?:boolean;disabledSources?:string[];wind?:WaterWind|false;detail?:boolean;
}
export function stepWaterSystemDestruction(input:WaterSystemDestructionStep) {
  if(!Number.isFinite(input.dt)||input.dt<1e-5||input.dt>.05)throw new Error('Invalid coupled water step time');
  const moving=!!input.bodies?.length||input.state.destruction.clusters.some(c=>!c.settled);
  const cells=waterBodyCells(input.system.water,input.state.water.water);
  let wet=false;for(let i=0;i<cells.count&&!wet;i++)wet=cells.depth(i)>input.system.water.dryDepth;
  // Buoyancy/rigid-body feedback needs a shorter interval than empty river
  // advection. Keep it automatic, with no extra solves for calm sleeping props.
  const ticks=moving&&wet?Math.ceil(input.dt*60):1;
  let state=input.state,bodies=input.bodies??[],result:ReturnType<typeof stepWaterSystemDestructionOnce>|undefined;
  const contacts:ReturnType<typeof stepWaterSystemDestructionOnce>['contacts']=[],impacts:ReturnType<typeof stepWaterSystemDestructionOnce>['impacts']=[];
  const detail:WaterDetailEvent[]=[];
  for(let tick=0;tick<ticks;tick++){
    result=stepWaterSystemDestructionOnce({...input,state,bodies,dt:input.dt/ticks});state=result.state;
    contacts.push(...result.contacts);impacts.push(...result.impacts);
    if(result.detail)mergeWaterDetailEvents(detail,result.detail);
    bodies=bodies.map(body=>{const updated=result!.bodies.find(b=>b.id===body.id);return updated?{...body,position:updated.position,rotation:updated.rotation,velocity:updated.velocity,angularVelocity:updated.angularVelocity}:body;});
  }
  // Report one frame-average force per contact, while preserving the exact
  // summed impulse already applied by the internal solves.
  const combined=new Map<string,(typeof contacts)[number]>();
  for(const hit of contacts){
    const key=JSON.stringify([hit.bodyId??'',hit.colliderId]),old=combined.get(key);
    if(!old){combined.set(key,{...hit,impulse:{...hit.impulse},force:{...hit.force},...(hit.angularImpulse?{angularImpulse:{...hit.angularImpulse}}:{})});continue;}
    const a=Math.hypot(old.impulse.x,old.impulse.y,old.impulse.z),b=Math.hypot(hit.impulse.x,hit.impulse.y,hit.impulse.z);
    if(a+b>0)old.point={x:(old.point.x*a+hit.point.x*b)/(a+b),y:(old.point.y*a+hit.point.y*b)/(a+b),z:(old.point.z*a+hit.point.z*b)/(a+b)};
    for(const axis of ['x','y','z'] as const)old.impulse[axis]+=hit.impulse[axis];
    if(hit.angularImpulse){old.angularImpulse??={x:0,y:0,z:0};for(const axis of ['x','y','z'] as const)old.angularImpulse[axis]+=hit.angularImpulse[axis];}
    old.kineticEnergy+=hit.kineticEnergy;old.speed=Math.max(old.speed,hit.speed);
  }
  for(const hit of combined.values())hit.force={x:hit.impulse.x/input.dt,y:hit.impulse.y/input.dt,z:hit.impulse.z/input.dt};
  return{...result!,contacts:[...combined.values()],impacts,...(input.detail?{detail}:{})};
}
function stepWaterSystemDestructionOnce({system,structure,state,dt,scene=system.scene,bodies=[],damage=true,disabledSources=[],wind,detail}:WaterSystemDestructionStep) {
  validateWaterBodyFloatingState(system.water,structure,state.floating);
  const afloat=new Set(state.floating.resting.map(b=>b.bodyId));
  const probe=state.water.steps===0||Math.floor((state.water.water.time+dt)*2)>Math.floor(state.water.water.time*2)?{...state.destruction,clusters:state.destruction.clusters.map(c=>c.settled&&!afloat.has(c.id)?{...c,settled:false}:c)}:state.destruction;
  const fluidScene=prepareDestructionScene(structure,probe,scene),debris=liquidDestructionBodies(structure,probe);
  const flow=stepWaterSystem({system,state:state.water,scene:fluidScene,bodies:[...debris,...bodies],dt,disabledSources,wind,detail});
  const coupled=applyLiquidDestruction(structure,state.destruction,flow,damage?{}:{loads:false,damagePerJoule:0});
  const native=stepDestruction({structure,state:coupled.state,scene,dt,bodies:applyLiquidImpulses(bodies,flow.contacts),contactLoads:damage,deformationContacts:damage?coupled.deformationContacts:[]});
  const rest=stepWaterBodyFloating({water:system.water,state:flow.state.water,structure,destruction:native.state,floating:state.floating,dt,scene,contacts:flow.contacts,impacts:native.impacts,groundedBodyIds:native.groundedDebrisIds});
  return{state:{water:flow.state,destruction:rest.destruction,floating:rest.floating},bodies:native.bodies,impacts:native.impacts,contacts:flow.contacts,stats:flow.stats,floatingStats:rest.stats,...(flow.detail?{detail:flow.detail}:{})};
}
