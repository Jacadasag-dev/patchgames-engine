/** Optional liquid/rigid-body/structural coupling. Keep the returned liquid state
 * authoritative and apply each contact batch exactly once. */
import type { PhysicsCompoundBody, PhysicsVector } from './physics.ts';
import { physicsShapeVolume } from './physicsGeometry.ts';
import { physicsBodyMassProperties, physicsApplyInverseInertia } from './physicsMassProperties.ts';
import { damageStructure, loadStructure, structuralColliderId, structuralDeformationPanel, structuralMemberColliders,
  type DestructionState, type StructuralManifest, type StructuralDeformationContact } from './destruction.ts';
import type { LiquidContact } from './waterDomain.ts';
import { liquidAdd as add, liquidSub as sub, liquidScale as scale, liquidLength as length, liquidZero as zero } from './liquidCollision.ts';

function validateContacts(contacts: LiquidContact[]): void {
  if (!Array.isArray(contacts) || contacts.length > 512) throw new Error('Liquid contact budget exceeded');
  for (const c of contacts) {
    if (!c || typeof c.colliderId !== 'string' || !c.colliderId || c.colliderId.length > 1024 || (c.bodyId !== undefined && typeof c.bodyId !== 'string')
      || !Number.isFinite(c.kineticEnergy) || c.kineticEnergy < 0 || c.kineticEnergy > 1e12 || !Number.isFinite(c.speed) || c.speed < 0 || c.speed > 10000)
      throw new Error('Invalid liquid contact');
    for (const v of [c.point,c.impulse,c.force,...(c.angularImpulse!==undefined?[c.angularImpulse]:[])]) if (!v || [v.x,v.y,v.z].some(n => !Number.isFinite(n) || Math.abs(n)>1e12)) throw new Error('Invalid liquid contact vector');
  }
}
/** Apply fluid momentum once before native integration. Producers that resolve
 * distributed moments supply their total angularImpulse about the body's COM.
 * Legacy particle contacts resolve translational recoil only: their averaged
 * contact point cannot reconstruct a moment and must not invent extra energy. */
export function applyLiquidImpulses(bodies: PhysicsCompoundBody[], contacts: LiquidContact[]): PhysicsCompoundBody[] {
  validateContacts(contacts);
  if (!Array.isArray(bodies) || bodies.length > 64) throw new Error('Liquid body budget exceeded');
  return bodies.map(body => {
    const hits = contacts.filter(c => c.bodyId === body.id);
    if (!hits.length || body.fixed) return body;
    // Rapier's default density is one kg/m³ when total body mass is omitted.
    // Small valid colliders can therefore weigh less than the explicit native
    // mass minimum. Match the finite-mass range accepted by liquidObstacles.
    const mass = body.mass ?? body.colliders.reduce((sum,c)=>sum+physicsShapeVolume(c.shape),0);
    if (!Number.isFinite(mass) || mass < .000001 || mass > 1e7) throw new Error('Invalid liquid body mass');
    let impulse = zero(), angularImpulse=zero();
    for (const hit of hits){impulse = add(impulse,hit.impulse);if(hit.angularImpulse)angularImpulse=add(angularImpulse,hit.angularImpulse);}
    const angular=body.lockRotations||length(angularImpulse)<=1e-15?undefined
      :add(body.angularVelocity??zero(),physicsApplyInverseInertia(physicsBodyMassProperties(body),angularImpulse));
    return {...body,velocity:add(body.velocity,scale(impulse,1/mass)),...(angular?{angularVelocity:angular}:{})};
  });
}
function members(structure: StructuralManifest): Map<string,string> {
  const result = new Map<string,string>();
  for (const member of structure.members) {
    const count = structuralDeformationPanel(member)?.triangles.length ?? member.colliders.length;
    for(let i=0;i<count;i++)result.set(structuralColliderId(structure,member.id,i),member.id);
  }
  return result;
}
/** Include these active debris bodies in stepLiquid.bodies together with actors.
 * Settled debris already lives in prepareDestructionScene and is omitted here. */
export function liquidDestructionBodies(structure: StructuralManifest, state: DestructionState): PhysicsCompoundBody[] {
  return state.clusters.filter(c=>!c.settled).map(cluster=>({id:cluster.id,position:{...cluster.position},rotation:{...cluster.rotation},
    velocity:{...cluster.velocity},angularVelocity:{...cluster.angularVelocity},
    mass:cluster.memberIds.reduce((sum,id)=>sum+structure.members.find(m=>m.id===id)!.mass,0),
    colliders:cluster.memberIds.flatMap(id=>structuralMemberColliders(structure.members.find(m=>m.id===id)!,state).map((c,i)=>({...c,
      id:structuralColliderId(structure,id,i),position:sub(c.position,cluster.origin)})))}));
}
export interface LiquidDebrisSleepOptions {
  /** Match the subsequent native destruction step. Default {x:0,y:-9.81,z:0}. */ gravity?: PhysicsVector;
  /** Approximate static friction on the supporting ground. Default .5. Use 0
   * for frictionless support; complex/sloped contacts can disable this filter. */ friction?: number;
  /** Incident impacts wake when both speed and net velocity change exceed the
   * thresholds. Defaults .25m/s and .02m/s. Sustained force is checked separately. */
  minimumImpactSpeed?: number;
  minimumDeltaSpeed?: number;
  /** Torque-only incident contacts must change angular speed by this amount
   * to wake grounded debris. Default .02 radians/s. */
  minimumDeltaAngularSpeed?: number;
}
function debrisSleepOptions(value: LiquidDamageOptions['debrisSleep']): Required<LiquidDebrisSleepOptions> | false {
  if(value===false)return false;
  if(value!==undefined&&(!value||typeof value!=='object'))throw new Error('Invalid liquid debris sleep setting');
  const options={gravity:value?.gravity??{x:0,y:-9.81,z:0},friction:value?.friction??.5,
    minimumImpactSpeed:value?.minimumImpactSpeed??.25,minimumDeltaSpeed:value?.minimumDeltaSpeed??.02,
    minimumDeltaAngularSpeed:value?.minimumDeltaAngularSpeed??.02};
  if(!options.gravity||['x','y','z'].some(axis=>!Number.isFinite(options.gravity[axis as keyof PhysicsVector])||Math.abs(options.gravity[axis as keyof PhysicsVector])>10000))
    throw new Error('Invalid liquid debris gravity');
  for(const n of [options.friction,options.minimumImpactSpeed,options.minimumDeltaSpeed,options.minimumDeltaAngularSpeed])
    if(!Number.isFinite(n)||n<0||n>10000)throw new Error('Invalid liquid debris sleep tuning');
  return options;
}
function debrisImpulses(structure: StructuralManifest, state: DestructionState, contacts: LiquidContact[], sleep: Required<LiquidDebrisSleepOptions> | false): DestructionState {
  const active = liquidDestructionBodies(structure,state), current = new Map(active.map(body=>[body.id,body]));
  // Reuse the same body construction for settled pieces when pressure wakes them.
  const settled = state.clusters.filter(c=>c.settled);
  if(settled.length)for(const body of liquidDestructionBodies(structure,{...state,clusters:settled.map(c=>({...c,settled:false}))}))current.set(body.id,body);
  const lookup=members(structure), memberClusters=new Map(state.clusters.flatMap(c=>c.memberIds.map(id=>[id,c.id] as const)));
  const mapped=contacts.map(c=>c.bodyId?c:{...c,bodyId:memberClusters.get(lookup.get(c.colliderId)??'')});
  const touched=new Set<string>();
  for(const cluster of state.clusters){
    const body=current.get(cluster.id);if(!body)continue;
    const hits=mapped.filter(c=>c.bodyId===cluster.id);
    let impulse=zero(),force=zero(),angularImpulse=zero(),incidentSpeed=0;
    for(const hit of hits){impulse=add(impulse,hit.impulse);force=add(force,hit.force);if(hit.angularImpulse)angularImpulse=add(angularImpulse,hit.angularImpulse);if(hit.kineticEnergy>0)incidentSpeed=Math.max(incidentSpeed,hit.speed);}
    const magnitude=length(impulse),angularMagnitude=body.lockRotations?0:length(angularImpulse);if(magnitude<=1e-12&&angularMagnitude<=1e-12)continue;
    if(!cluster.settled||sleep===false){touched.add(cluster.id);continue;}
    const mass=body.mass!,g=length(sleep.gravity),up=g>0?scale(sleep.gravity,-1/g):zero();
    const lift=force.x*up.x+force.y*up.y+force.z*up.z;
    const lateral=length(sub(force,scale(up,lift))),normalLoad=Math.max(0,mass*g-lift);
    // The supporting ground balances submerged weight and weak lateral water
    // loads. Only forces outside that support cone need a fresh native solve.
    // This is a ground-normal approximation; disable for authored steep slopes.
    const forceEpsilon=mass*1e-5;
    const unsupported=lift>mass*g+forceEpsilon||lateral>sleep.friction*normalLoad+forceEpsilon;
    // Quiet supported hydrostatic moments do not repeatedly wake grounded
    // debris. An actual incident torque may wake even when net linear impulse
    // cancels (for example two opposite impacts forming a couple).
    const deltaAngular=angularMagnitude>1e-12?length(physicsApplyInverseInertia(physicsBodyMassProperties(body),angularImpulse)):0;
    const impact=incidentSpeed>sleep.minimumImpactSpeed&&(magnitude/mass>sleep.minimumDeltaSpeed||deltaAngular>sleep.minimumDeltaAngularSpeed);
    if(unsupported||impact)touched.add(cluster.id);
  }
  if(!touched.size)return state;
  const moved=new Map(applyLiquidImpulses([...current.values()],mapped).map(body=>[body.id,body]));
  return {...state,revision:state.revision+1,clusters:state.clusters.map(c=>{
    // Native grounded velocity determines quietTime for an already active body.
    // Resetting it for every tiny fluid contact prevented sinking debris from
    // ever settling. A local fluid impulse must not wake unrelated rubble.
    const body=moved.get(c.id);return body&&touched.has(c.id)?{...c,velocity:{...body.velocity},angularVelocity:{...(body.angularVelocity??zero())},settled:false,quietTime:c.settled?0:c.quietTime}:c;
  })};
}
/** Pass these contacts to stepDestruction/stepDestructionWorld.deformationContacts
 * so ductile panels advance once alongside native contacts, rather than applying
 * brittle damage or advancing their solver twice in the same frame. */
export function liquidDeformationContacts(structure: StructuralManifest, contacts: LiquidContact[]): StructuralDeformationContact[] {
  validateContacts(contacts); const lookup = members(structure);
  return contacts.flatMap(contact => {
    const memberId = lookup.get(contact.colliderId), member = structure.members.find(m=>m.id===memberId);
    return member?.deformation ? [{structureId:structure.id,memberId:member.id,point:{...contact.point},impulse:{...contact.impulse}}] : [];
  });
}
export interface LiquidDamageOptions {
  /** Loads use actual mean force. Disable only when another system already applies it. Default true. */ loads?: boolean;
  /** Only incident impacts faster than this count as brittle damage. Default 1m/s. */ minimumSpeed?: number;
  /** Subtract per member per step before applying impact damage. Default 20J. */ minimumEnergy?: number;
  /** Authored damage points per excess joule. Default .02. */ damagePerJoule?: number;
  /** Keep grounded debris asleep under balanced/weak water loads. Active debris
   * always receives its full impulse. False wakes on any nonzero net impulse;
   * use that with a custom support solver or complex/sloped support contacts. */
  debrisSleep?: LiquidDebrisSleepOptions | false;
}
/** Apply sustained fluid loads and optional impact damage to an existing support
 * graph. Supports can fail under standing water. Ductile panels receive no brittle
 * impact damage here; use returned deformationContacts in the native step. */
export function applyLiquidDestruction(structure: StructuralManifest, state: DestructionState, result: { contacts: LiquidContact[] },
  options: LiquidDamageOptions = {}): { state: DestructionState; deformationContacts: StructuralDeformationContact[] } {
  validateContacts(result.contacts);
  const speed = options.minimumSpeed ?? 1, minimum = options.minimumEnergy ?? 20, rate = options.damagePerJoule ?? .02;
  for (const value of [speed,minimum,rate]) if (!Number.isFinite(value) || value < 0 || value > 1e9) throw new Error('Invalid liquid damage tuning');
  if (options.loads !== undefined && typeof options.loads !== 'boolean') throw new Error('Invalid liquid load setting');
  const sleep=debrisSleepOptions(options.debrisSleep);
  const lookup = members(structure), detached = new Set(state.clusters.flatMap(c=>c.memberIds)), forces = new Map<string,PhysicsVector>(), energies = new Map<string,number>();
  for (const contact of result.contacts) {
    const id = lookup.get(contact.colliderId); if (!id || detached.has(id)) continue;
    forces.set(id,add(forces.get(id) ?? zero(),contact.force));
    if (contact.speed >= speed) energies.set(id,(energies.get(id) ?? 0)+contact.kineticEnergy);
  }
  let next = debrisImpulses(structure,state,result.contacts,sleep);
  if(options.loads!==false)next=loadStructure(structure,next,[...forces].map(([memberId,force])=>({memberId,force:length(force)})));
  const hits = [...energies].filter(([id])=>!structure.members.find(m=>m.id===id)?.deformation)
    .map(([memberId,energy])=>({memberId,amount:Math.max(0,energy-minimum)*rate})).filter(hit=>hit.amount>0);
  if (hits.length) next = damageStructure(structure,next,hits);
  return { state: next, deformationContacts: liquidDeformationContacts(structure,result.contacts).filter(c=>!next.clusters.some(cluster=>cluster.memberIds.includes(c.memberId))) };
}
