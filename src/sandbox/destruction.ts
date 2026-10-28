import { stepCompoundPhysics, raycastPhysicsBatch, type PhysicsCollider, type PhysicsCompoundBody, type PhysicsCompoundBodyResult,
  type PhysicsCompoundResult, type PhysicsImpact, type PhysicsRotation, type PhysicsScene, type PhysicsVector } from './physics.ts';
import { physicsShapeVolume, physicsConvexFaces, physicsShapeBounds } from './physicsGeometry.ts';
import type { ObjectShape, StateOf } from '../shared/gameApi.ts';
import type { TerrainCollisionEdits } from './terrainWorld.ts';
import { compileDeformationPanel, createDeformationState, validateDeformationState, deformationColliders, stepDeformation,
  deformationRotate, DEFORMATION_LIMITS, type DeformationConfiguration, type DeformationState, type DeformationPanel, type DeformationContact } from './deformation.ts';

/** Bounded, authored load paths. Units: kilograms, metres, seconds, newtons.
 * This is a game model of load sharing, not a finite-element engineering solver.
 * Support bonds point from a member to its support; their graph is acyclic.
 * Cohesive bonds join neighboring fragments and may contain undirected cycles.
 */
export const DESTRUCTION_LIMITS = Object.freeze({ members: 64, bonds: 256, colliders: 256, collidersPerBody: 32, hits: 256 });
export interface StructuralMember {
  id: string;
  mass: number;
  strength: number;
  /** Damage hit points; defaults to strength. Damage proportionally weakens capacity. */
  durability?: number;
  anchor?: boolean;
  /** Optional unsupported reach in metres. The shortest intact cohesive path
   * ends at an anchor or live directed support. Each neighbor adds its center
   * distance; the final support adds distance to that support's geometry.
   * This local span rule is a game approximation, not bending/stress analysis. */
  maxSupportDistance?: number;
  /** Opt-in ductile thin panel. One box collider and one render part only. */
  deformation?: DeformationConfiguration;
  position: PhysicsVector;
  /** Original world-space collision geometry. An empty array is useful for decoration. */
  colliders: PhysicsCollider[];
  partIds?: string[];
  surfaceIds?: string[];
  lightIds?: string[];
}
export interface StructuralBond {
  id: string;
  from: string;
  to: string;
  /** Omitted means directed support. Cohesive joins fragments in both directions. */
  kind?: 'cohesive';
  capacity: number;
  durability?: number;
  /** Relative stiffness/load share among surviving supports; defaults to one. */
  weight?: number;
}
export interface StructuralRecipe {
  id: string;
  version: string;
  members: StructuralMember[];
  bonds: StructuralBond[];
  /** Magnitude used for static weight; defaults to 9.81. */
  gravity?: number;
}
export interface StructuralManifest extends StructuralRecipe { revision: string }
export interface DestructionCluster {
  id: string;
  memberIds: string[];
  /** Original world center. Transform any source point by position + rotation*(point-origin). */
  origin: PhysicsVector;
  position: PhysicsVector;
  rotation: PhysicsRotation;
  velocity: PhysicsVector;
  angularVelocity: PhysicsVector;
  settled: boolean;
  quietTime: number;
}
/** Plain authoritative state. Persist it in declared game state, never just in a view cache. */
export interface DestructionState {
  structureRevision: string;
  revision: number;
  /** Pending world-wide wake after damage; persisted across preparation/replay. */
  wake: boolean;
  damage: Record<string, number>;
  bondDamage: Record<string, number>;
  brokenMembers: string[];
  brokenBonds: string[];
  clusters: DestructionCluster[];
  /** Present only on structures containing ductile members; fully authoritative. */
  deformations?: Record<string, DeformationState>;
}
export interface StructuralDeformationContact extends DeformationContact { structureId: string; memberId: string }
export interface StructuralHit { memberId?: string; bondId?: string; amount: number }
export interface StructuralSpatialHit {
  position: PhysicsVector;
  radius: number;
  amount: number;
  /** Radial exponent: 1 is linear (default); 0 is uniform inside the radius. */
  falloff?: number;
}
export interface DestructionStep {
  structure: StructuralManifest;
  state: DestructionState;
  /** Static scene containing IDs from structuralColliderId; no stale duplicate colliders. */
  scene: PhysicsScene;
  dt: number;
  /** Players/other bodies must join this batch to collide with moving debris. */
  bodies?: PhysicsCompoundBody[];
  /** External liquid/pressure impulses, combined once with accepted native contacts. */
  deformationContacts?: StructuralDeformationContact[];
  gravity?: PhysicsVector;
  /** Optional game tuning; standing weight impulses are subtracted before damage. */
  impactDamage?: { minimumImpulse: number; damagePerImpulse: number; minimumSpeed?: number;
    /** Optional local spread around the native contact point. Omit for legacy member damage. */
    radius?: number; falloff?: number };
  /** Gravity-directed native contact forces add bearing load to attached members. Default true. */
  contactLoads?: boolean;
  /** Coupled impact retries the same time step after predicted fracture, so
   * newly released fragments participate in the accepted native collision.
   * Omit (or use deferred) for the original post-step fracture behavior. */
  impactResponse?: 'deferred' | 'coupled';
  settleSeconds?: number;
}
export interface DestructionStepResult {
  state: DestructionState;
  scene: PhysicsScene;
  bodies: PhysicsCompoundBodyResult[];
  /** Active debris with native support/ground probes in this accepted step.
   * `bodies` contains only caller-supplied actors; water rest controllers need
   * this separate list to avoid classifying supported debris as freely afloat. */
  groundedDebrisIds: string[];
  impacts: PhysicsImpact[];
  impactsTruncated: boolean;
  /** Present only for coupled response. limited means the final new fracture
   * was committed after the last native run and takes effect next step. */
  impactResponse?: { mode: 'coupled'; correctionPasses: number; limited: boolean };
}
export interface DestructionWorldStep extends Omit<DestructionStep, 'structure' | 'state'> {
  /** Up to 64 independently authored structures, all sharing one native batch. */
  structures: { structure: StructuralManifest; state: DestructionState }[];
}
export interface DestructionWorldStepResult extends Omit<DestructionStepResult, 'state'> {
  /** Same order as the supplied structures, regardless of canonical simulation order. */
  states: DestructionState[];
}

const zero = (): PhysicsVector => ({ x: 0, y: 0, z: 0 });
const identity = (): PhysicsRotation => ({ x: 0, y: 0, z: 0, w: 1 });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function number(value: number, name: string, min = 0, max = 1e12): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid structural ${name}`);
}
function id(value: string): void {
  if (typeof value !== 'string' || !value.length || value.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(value))
    throw new Error('Structural IDs must be safe nonempty strings of at most 128 characters');
}
function vector(value: PhysicsVector): void {
  if (!value) throw new Error('Missing structural vector');
  for (const axis of ['x', 'y', 'z'] as const) number(value[axis], 'coordinate', -10000, 10000);
}
function quaternion(value: PhysicsRotation): void {
  vector(value); number(value.w, 'rotation', -1, 1);
  if (Math.abs(Math.hypot(value.x, value.y, value.z, value.w) - 1) > 0.001) throw new Error('Structural rotation must be a unit quaternion');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function hash(value: string): string {
  let a = 2166136261, b = 2246822507;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 3266489909); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
const plus = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const minus = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: PhysicsVector, b: PhysicsVector): PhysicsVector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
function rotate(q: PhysicsRotation, v: PhysicsVector): PhysicsVector {
  const t = cross(q, v), u = cross(q, t);
  return { x: v.x + 2 * (q.w * t.x + u.x), y: v.y + 2 * (q.w * t.y + u.y), z: v.z + 2 * (q.w * t.z + u.z) };
}
function multiply(a: PhysicsRotation, b: PhysicsRotation): PhysicsRotation {
  return { x: a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y, y: a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z: a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w, w: a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z };
}
function validateCollider(c: PhysicsCollider): void {
  vector(c.position); if (c.rotation) quaternion(c.rotation);
  if (c.friction !== undefined) number(c.friction, 'friction', 0, 2);
  if (c.restitution !== undefined) number(c.restitution, 'restitution', 0, 1);
  if(c.waterBoundary!==undefined&&c.waterBoundary!==false)throw new Error('Invalid structural collider waterBoundary');
  if (c.shape.kind === 'box') for (const axis of ['x', 'y', 'z'] as const) number(c.shape.halfExtents[axis], 'dimension', .02, 1000);
  else if (c.shape.kind === 'ball' || c.shape.kind === 'capsule') {
    number(c.shape.radius, 'radius', .02, 1000);
    if (c.shape.kind === 'capsule') number(c.shape.halfHeight, 'half height', 0, 1000);
  } else if (c.shape.kind === 'convex') physicsShapeVolume(c.shape);
  else throw new Error('Unsupported structural collider');
}
interface Graph { members: Map<string, StructuralMember>; bonds: Map<string, StructuralBond>; outgoing: Map<string, StructuralBond[]>;
  cohesive: Map<string, StructuralBond[]>; order: string[]; spatialSupport: boolean; supportDistances: Map<string, number> }
const graphs = new WeakMap<StructuralManifest, Graph>();
const panels = new WeakMap<StructuralMember, DeformationPanel>();
export function structuralDeformationPanel(member: StructuralMember): DeformationPanel | undefined {
  if (!member.deformation) return undefined;
  const cacheable=Object.isFrozen(member);
  let panel = cacheable?panels.get(member):undefined;
  if (!panel) {
    if (member.colliders.length !== 1 || member.partIds && member.partIds.length !== 1) throw new Error('Ductile members require one box collider and one source part');
    panel = compileDeformationPanel(member.colliders[0], member.deformation); if(cacheable)panels.set(member, panel);
  }
  return panel;
}
function colliderCount(member: StructuralMember): number { return structuralDeformationPanel(member)?.triangles.length ?? member.colliders.length; }
function colliderIds(structure: StructuralManifest, member: StructuralMember): string[] {
  return Array.from({ length: colliderCount(member) }, (_, i) => structuralColliderId(structure, member.id, i));
}
export function structuralMemberColliders(member: StructuralMember, state: DestructionState): PhysicsCollider[] {
  const panel = structuralDeformationPanel(member);
  return panel ? deformationColliders(panel, state.deformations![member.id]) : member.colliders;
}
function graph(recipe: StructuralRecipe): Graph {
  id(recipe.id); id(recipe.version); number(recipe.gravity ?? 9.81, 'gravity', .001, 1000);
  if (!Array.isArray(recipe.members) || !recipe.members.length || recipe.members.length > DESTRUCTION_LIMITS.members ||
    !Array.isArray(recipe.bonds) || recipe.bonds.length > DESTRUCTION_LIMITS.bonds) throw new Error('Structural graph exceeds member/bond limits');
  const members = new Map<string, StructuralMember>(), bonds = new Map<string, StructuralBond>(), outgoing = new Map<string, StructuralBond[]>(), cohesive = new Map<string, StructuralBond[]>();
  let count = 0;
  for (const m of recipe.members) {
    id(m.id); if (members.has(m.id)) throw new Error('Duplicate structural member');
    number(m.mass, 'mass', .01, 1e7 / DESTRUCTION_LIMITS.members); number(m.strength, 'strength', .001);
    number(m.durability ?? m.strength, 'durability', .001); vector(m.position);
    if (m.anchor !== undefined && typeof m.anchor !== 'boolean') throw new Error('Invalid structural anchor');
    if (m.maxSupportDistance !== undefined) number(m.maxSupportDistance, 'maximum support distance', 0, 10000);
    if (!Array.isArray(m.colliders) || m.colliders.length > DESTRUCTION_LIMITS.collidersPerBody) throw new Error('Structural member collider limit exceeded');
    count += colliderCount(m); m.colliders.forEach(validateCollider);
    for (const keys of [m.partIds, m.surfaceIds, m.lightIds]) if (keys) {
      if (!Array.isArray(keys) || keys.length > 4096 || new Set(keys).size !== keys.length) throw new Error('Invalid structural ownership');
      keys.forEach(key => { if (typeof key !== 'string' || !key.length || key.length > 1024) throw new Error('Invalid structural ownership ID'); });
    }
    members.set(m.id, m); outgoing.set(m.id, []); cohesive.set(m.id, []);
  }
  if (count > DESTRUCTION_LIMITS.colliders) throw new Error('Structural collider budget exceeded');
  if (recipe.members.filter(member => member.deformation).length > DEFORMATION_LIMITS.panels) throw new Error('Structural deformation panel budget exceeded');
  const incoming = new Map([...members.keys()].map(key => [key, 0]));
  for (const b of recipe.bonds) {
    id(b.id); if (bonds.has(b.id)) throw new Error('Duplicate structural bond');
    if (!members.has(b.from) || !members.has(b.to) || b.from === b.to) throw new Error('Unknown or self-referencing structural support');
    if (b.kind !== undefined && b.kind !== 'cohesive') throw new Error('Invalid structural bond kind');
    if (!b.kind && members.get(b.from)!.anchor) throw new Error('Anchored members cannot depend on another support');
    number(b.capacity, 'bond capacity', .001); number(b.durability ?? b.capacity, 'bond durability', .001); number(b.weight ?? 1, 'bond weight', .001, 1e6);
    bonds.set(b.id, b);
    if (b.kind === 'cohesive') { cohesive.get(b.from)!.push(b); cohesive.get(b.to)!.push(b); }
    else { outgoing.get(b.from)!.push(b); incoming.set(b.to, incoming.get(b.to)! + 1); }
  }
  for (const list of outgoing.values()) list.sort((a, b) => compare(a.id, b.id));
  for (const list of cohesive.values()) list.sort((a, b) => compare(a.id, b.id));
  const ready = [...members.keys()].filter(key => !incoming.get(key)).sort(compare), order: string[] = [];
  while (ready.length) {
    const key = ready.shift()!; order.push(key);
    for (const bond of outgoing.get(key)!) { const left = incoming.get(bond.to)! - 1; incoming.set(bond.to, left); if (!left) { ready.push(bond.to); ready.sort(compare); } }
  }
  if (order.length !== members.size) throw new Error('Structural support graph must be acyclic');
  const result: Graph = { members, bonds, outgoing, cohesive, order,
    supportDistances: new Map(),
    spatialSupport: [...cohesive.values()].some(list => list.length > 0) || [...members.values()].some(m => m.maxSupportDistance !== undefined) };
  if ([...cohesive.values()].some(list => list.length > 0)) supportComponents(result, new Set(members.keys()), () => true);
  return result;
}
/** Contract cohesive fragments before sorting directed support dependencies.
 * A directed edge within a cohesive assembly would create circular support. */
function supportComponents(g: Graph, keys: Set<string>, enabled: (bond: StructuralBond) => boolean): string[][] {
  const groups: string[][] = [], groupOf = new Map<string, number>();
  for (const start of [...keys].sort(compare)) if (!groupOf.has(start)) {
    const group: string[] = [], pending = [start], index = groups.length; groupOf.set(start, index);
    while (pending.length) {
      const key = pending.shift()!; group.push(key);
      for (const bond of g.cohesive.get(key)!) {
        const other = bond.from === key ? bond.to : bond.from;
        if (!enabled(bond) || !keys.has(other) || groupOf.has(other)) continue;
        groupOf.set(other, index); pending.push(other);
      }
    }
    group.sort(compare); groups.push(group);
  }
  const dependencies = groups.map(() => [] as number[]), incoming = groups.map(() => 0);
  for (const key of keys) for (const bond of g.outgoing.get(key)!) if (enabled(bond) && keys.has(bond.to)) {
    const from = groupOf.get(key)!, to = groupOf.get(bond.to)!;
    if (from === to) throw new Error('Directed supports cannot lie inside a cohesive assembly');
    dependencies[from].push(to); incoming[to]++;
  }
  const order: string[][] = [], compareGroup = (a: number, b: number) => compare(groups[a][0], groups[b][0]);
  const ready = groups.map((_, index) => index).filter(index => incoming[index] === 0).sort(compareGroup);
  while (ready.length) {
    const index = ready.shift()!; order.push(groups[index]);
    for (const next of dependencies[index]) if (--incoming[next] === 0) { ready.push(next); ready.sort(compareGroup); }
  }
  if (order.length !== groups.length) throw new Error('Cohesive assemblies must have acyclic directed supports');
  return order;
}
function getGraph(manifest: StructuralManifest): Graph {
  let result = graphs.get(manifest);
  if (!result) { result = graph(manifest); graphs.set(manifest, result); }
  return result;
}
function empty(manifest: StructuralManifest): DestructionState {
  const deformable = manifest.members.filter(member => member.deformation);
  return { structureRevision: manifest.revision, revision: 0, wake: false, damage: {}, bondDamage: {}, brokenMembers: [], brokenBonds: [], clusters: [],
    ...(deformable.length ? { deformations: Object.fromEntries(deformable.map(member => [member.id, createDeformationState(structuralDeformationPanel(member)!)])) } : {}) };
}
/** Validates authored bounds, ownership data, acyclic support paths and undamaged stability. */
export function compileStructure(recipe: StructuralRecipe): StructuralManifest {
  const checked = graph(recipe);
  const data: StructuralRecipe = { id: recipe.id, version: recipe.version, gravity: recipe.gravity ?? 9.81,
    members: [...checked.members.values()].sort((a,b) => compare(a.id,b.id)).map(m => ({ id:m.id,mass:m.mass,strength:m.strength,
      ...(m.durability!==undefined ? {durability:m.durability}:{}),...(m.anchor!==undefined ? {anchor:m.anchor}:{}),
      ...(m.maxSupportDistance!==undefined ? {maxSupportDistance:m.maxSupportDistance}:{}),
      ...(m.deformation ? {deformation:JSON.parse(JSON.stringify(structuralDeformationPanel(m)!.configuration)) as DeformationConfiguration} : {}),
      position: {x:m.position.x,y:m.position.y,z:m.position.z}, colliders: m.colliders.map(c => ({
        ...(c.id!==undefined ? {id:c.id}:{}),...(c.friction!==undefined ? {friction:c.friction}:{}),...(c.restitution!==undefined ? {restitution:c.restitution}:{}),...(c.waterBoundary===false?{waterBoundary:false as const}:{}),
        position:{x:c.position.x,y:c.position.y,z:c.position.z},
        ...(c.rotation ? {rotation:{x:c.rotation.x,y:c.rotation.y,z:c.rotation.z,w:c.rotation.w}} : {}),
        shape:c.shape.kind==='box' ? {kind:'box',halfExtents:{x:c.shape.halfExtents.x,y:c.shape.halfExtents.y,z:c.shape.halfExtents.z}} :
          c.shape.kind==='capsule' ? {kind:'capsule',radius:c.shape.radius,halfHeight:c.shape.halfHeight} :
            c.shape.kind==='convex' ? {kind:'convex',vertices:c.shape.vertices.map(v=>({x:v.x,y:v.y,z:v.z}))} : {kind:'ball',radius:c.shape.radius}})),
      ...(m.partIds ? {partIds:[...m.partIds]} : {}), ...(m.surfaceIds ? {surfaceIds:[...m.surfaceIds]} : {}), ...(m.lightIds ? {lightIds:[...m.lightIds]} : {}) })),
    bonds: [...checked.bonds.values()].sort((a,b) => compare(a.id,b.id)).map(b => ({id:b.id,from:b.from,to:b.to,capacity:b.capacity,
      ...(b.kind!==undefined ? {kind:b.kind}:{}),
      ...(b.durability!==undefined ? {durability:b.durability}:{}),...(b.weight!==undefined ? {weight:b.weight}:{})})) };
  const manifest: StructuralManifest = { ...data, revision: 'structure-v1-' + hash(JSON.stringify(data)) };
  graphs.set(manifest, graph(manifest));
  const initial = solve(manifest, empty(manifest));
  if (initial.clusters.length || initial.brokenMembers.length || initial.brokenBonds.length)
    throw new Error('Undamaged structure is unstable: disconnected or overloaded members/bonds');
  return freeze(manifest);
}
export function createDestructionState(structure: StructuralManifest): DestructionState {
  getGraph(structure); return freeze(empty(structure));
}
/** The same ID must be used for a member's statics, debris and impact targeting. */
export function structuralColliderId(structure: StructuralManifest, memberId: string, index: number): string {
  return 'structure:' + hash(JSON.stringify([structure.revision, memberId, index]));
}
function validateState(structure: StructuralManifest, state: DestructionState): void {
  const g = getGraph(structure);
  if (!state || state.structureRevision !== structure.revision) throw new Error('Destruction state belongs to a different structural revision');
  number(state.revision, 'state revision', 0, Number.MAX_SAFE_INTEGER - 1);
  if (!Number.isInteger(state.revision)) throw new Error('Invalid destruction revision');
  if (typeof state.wake !== 'boolean') throw new Error('Invalid destruction wake flag');
  const deformable = structure.members.filter(member => member.deformation);
  if (deformable.length || state.deformations !== undefined) {
    if (!state.deformations || typeof state.deformations !== 'object' || Array.isArray(state.deformations) || Object.keys(state.deformations).length !== deformable.length)
      throw new Error('Invalid structural deformation state');
    for (const member of deformable) validateDeformationState(structuralDeformationPanel(member)!, state.deformations[member.id]);
  }
  for (const [values, entries] of [[state.damage, g.members], [state.bondDamage, g.bonds]] as const) {
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > entries.size) throw new Error('Invalid destruction damage map');
    for (const [key, value] of Object.entries(values)) { if (!entries.has(key)) throw new Error('Unknown damaged structural ID'); number(value, 'damage'); }
  }
  for (const [list, entries] of [[state.brokenMembers, g.members], [state.brokenBonds, g.bonds]] as const) {
    if (!Array.isArray(list) || list.length > entries.size || new Set(list).size !== list.length || list.some(key => !entries.has(key))) throw new Error('Invalid broken structural IDs');
  }
  if (!Array.isArray(state.clusters) || state.clusters.length > DESTRUCTION_LIMITS.members) throw new Error('Invalid debris clusters');
  const seen = new Set<string>(), clusterIds = new Set<string>();
  for (const c of state.clusters) {
    id(c.id); if (clusterIds.has(c.id)) throw new Error('Duplicate debris identity'); clusterIds.add(c.id);
    if (!Array.isArray(c.memberIds) || !c.memberIds.length || c.memberIds.length > g.members.size) throw new Error('Invalid debris membership');
    let colliderCount = 0;
    for (const key of c.memberIds) { if (!g.members.has(key) || seen.has(key)) throw new Error('Invalid or duplicate debris member'); seen.add(key); colliderCount += structuralDeformationPanel(g.members.get(key)!)?.triangles.length ?? g.members.get(key)!.colliders.length; }
    if (colliderCount > DESTRUCTION_LIMITS.collidersPerBody) throw new Error('Debris collider budget exceeded');
    vector(c.origin); vector(c.position); vector(c.velocity); vector(c.angularVelocity); quaternion(c.rotation);
    if (typeof c.settled !== 'boolean') throw new Error('Invalid settled debris flag');
    number(c.quietTime, 'quiet time', 0, 3600);
  }
}
function cloneState(state: DestructionState): DestructionState {
  return { ...state, damage: { ...state.damage }, bondDamage: { ...state.bondDamage }, brokenMembers: [...state.brokenMembers],
    brokenBonds: [...state.brokenBonds], clusters: state.clusters.map(c => ({ ...c, memberIds: [...c.memberIds], origin: {...c.origin},
      position: {...c.position}, rotation: {...c.rotation}, velocity: {...c.velocity}, angularVelocity: {...c.angularVelocity} })) };
}
function cluster(structure: StructuralManifest, memberIds: string[], previous?: DestructionCluster): DestructionCluster {
  const g = getGraph(structure), origin = zero(); let mass = 0;
  memberIds.sort(compare);
  for (const key of memberIds) { const m = g.members.get(key)!; mass += m.mass; origin.x += m.position.x*m.mass; origin.y += m.position.y*m.mass; origin.z += m.position.z*m.mass; }
  origin.x /= mass; origin.y /= mass; origin.z /= mass;
  const offset = previous ? rotate(previous.rotation, minus(origin, previous.origin)) : zero();
  return { id: 'debris:' + hash(JSON.stringify([structure.revision, memberIds])), memberIds, origin,
    position: previous ? plus(previous.position, offset) : {...origin}, rotation: previous ? {...previous.rotation} : identity(),
    velocity: previous ? plus(previous.velocity, cross(previous.angularVelocity, offset)) : zero(),
    angularVelocity: previous ? {...previous.angularVelocity} : zero(), settled: false, quietTime: 0 };
}
function components(structure: StructuralManifest, ids: Set<string>, brokenMembers: Set<string>, brokenBonds: Set<string>): string[][] {
  const g = getGraph(structure), neighbors = new Map([...ids].map(key => [key, [] as string[]]));
  for (const b of structure.bonds) if (!brokenBonds.has(b.id) && !brokenMembers.has(b.from) && !brokenMembers.has(b.to) && ids.has(b.from) && ids.has(b.to)) {
    neighbors.get(b.from)!.push(b.to); neighbors.get(b.to)!.push(b.from);
  }
  const result: string[][] = [], visited = new Set<string>();
  for (const start of [...ids].sort(compare)) if (!visited.has(start)) {
    const queue = [start], group: string[] = []; let count = 0;
    visited.add(start);
    while (queue.length) {
      const key = queue.shift()!, added = colliderCount(g.members.get(key)!);
      // Large assemblies use deterministic coarse chunks, never omit geometry.
      if (count + added > DESTRUCTION_LIMITS.collidersPerBody && group.length) { result.push(group.splice(0)); count = 0; }
      group.push(key); count += added;
      for (const next of neighbors.get(key)!.sort(compare)) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
    if (group.length) result.push(group);
  }
  return result;
}
interface SupportRoute { bond: StructuralBond; target: string }
interface SupportPaths { supported: Set<string>; routes: Map<string, SupportRoute[]>; order: string[]; exceeded: string[] }
const length = (point: PhysicsVector): number => Math.hypot(point.x, point.y, point.z);
const dot = (a: PhysicsVector, b: PhysicsVector): number => a.x*b.x + a.y*b.y + a.z*b.z;
const scaled = (point: PhysicsVector, factor: number): PhysicsVector => ({x:point.x*factor,y:point.y*factor,z:point.z*factor});
const inverse = (q: PhysicsRotation): PhysicsRotation => ({x:-q.x,y:-q.y,z:-q.z,w:q.w});
// New spatial calculations cross V8 and QuickJS. Canonical precision absorbs
// their final Math.hypot/sqrt ulp without altering legacy authored hit amounts.
const spatialNumber = (value: number): number => Number(value.toPrecision(12));
const hullFaces = new WeakMap<object, [number, number, number][]>();
/** Closest point on a filled triangle, including its edges and vertices. */
function triangleDistance(point: PhysicsVector, a: PhysicsVector, b: PhysicsVector, c: PhysicsVector): number {
  const ab=minus(b,a), ac=minus(c,a), ap=minus(point,a), d1=dot(ab,ap), d2=dot(ac,ap);
  if (d1<=0 && d2<=0) return length(ap);
  const bp=minus(point,b), d3=dot(ab,bp), d4=dot(ac,bp);
  if (d3>=0 && d4<=d3) return length(bp);
  const vc=d1*d4-d3*d2;
  if (vc<=0 && d1>=0 && d3<=0) return length(minus(point,plus(a,scaled(ab,d1/(d1-d3)))));
  const cp=minus(point,c), d5=dot(ab,cp), d6=dot(ac,cp);
  if (d6>=0 && d5<=d6) return length(cp);
  const vb=d5*d2-d1*d6;
  if (vb<=0 && d2>=0 && d6<=0) return length(minus(point,plus(a,scaled(ac,d2/(d2-d6)))));
  const va=d3*d6-d5*d4;
  if (va<=0 && d4-d3>=0 && d5-d6>=0) return length(minus(point,plus(b,scaled(minus(c,b),(d4-d3)/((d4-d3)+(d5-d6))))));
  const denominator=va+vb+vc;
  if (Math.abs(denominator)<1e-24) return Math.min(length(ap),length(bp),length(cp));
  return length(minus(point,plus(a,plus(scaled(ab,vb/denominator),scaled(ac,vc/denominator)))));
}
function rawColliderDistance(point: PhysicsVector, collider: PhysicsCollider): number {
  const local=rotate(inverse(collider.rotation ?? identity()),minus(point,collider.position)), shape=collider.shape;
  if (shape.kind==='ball') return Math.max(0,length(local)-shape.radius);
  if (shape.kind==='capsule') return Math.max(0,Math.hypot(local.x,Math.max(0,Math.abs(local.y)-shape.halfHeight),local.z)-shape.radius);
  if (shape.kind==='box') return Math.hypot(Math.max(0,Math.abs(local.x)-shape.halfExtents.x),
    Math.max(0,Math.abs(local.y)-shape.halfExtents.y),Math.max(0,Math.abs(local.z)-shape.halfExtents.z));
  let faces=hullFaces.get(shape);
  if (!faces) {faces=physicsConvexFaces(shape);hullFaces.set(shape,faces);}
  let inside=true, closest=Infinity;
  for (const [ia,ib,ic] of faces) {
    const a=shape.vertices[ia],b=shape.vertices[ib],c=shape.vertices[ic], normal=cross(minus(b,a),minus(c,a));
    if (dot(normal,minus(local,a))>1e-9*length(normal)) inside=false;
    closest=Math.min(closest,triangleDistance(local,a,b,c));
  }
  return inside ? 0 : closest;
}
function distanceToCollider(point: PhysicsVector, collider: PhysicsCollider): number {
  return spatialNumber(rawColliderDistance(point,collider));
}
function supportDistance(g: Graph, bond: StructuralBond): number {
  let distance=g.supportDistances.get(bond.id);
  if (distance===undefined) {
    const from=g.members.get(bond.from)!,to=g.members.get(bond.to)!;
    distance=to.colliders.length ? Math.min(...to.colliders.map(c=>distanceToCollider(from.position,c))) : spatialNumber(length(minus(from.position,to.position)));
    g.supportDistances.set(bond.id,distance);
  }
  return distance;
}
/** Intact fragments share loads along surviving directed supports and cohesive
 * paths with decreasing support distance. Shortest distance limits reach; it
 * does not discard a farther support that can still carry part of the load.
 * Directed supports connect separate assemblies. A span limit is local: once
 * load enters the next supported assembly its unsupported reach starts again. */
function spatialSupportPaths(g: Graph, remaining: Set<string>, brokenMembers: Set<string>, brokenBonds: Set<string>): SupportPaths {
  const intact=new Set([...remaining].filter(key=>!brokenMembers.has(key)));
  const enabled=(bond:StructuralBond)=>!brokenBonds.has(bond.id)&&intact.has(bond.from)&&intact.has(bond.to);
  const groups=supportComponents(g,intact,enabled),supported=new Set<string>(),routes=new Map<string,SupportRoute[]>(),exceeded:string[]=[],order:string[]=[];
  const distances=new Map<string,number>(),hops=new Map<string,number>(),epsilon=1e-8;
  for (const group of [...groups].reverse()) {
    const inGroup=new Set(group),pending=new Set(group);
    for (const key of group) {
      const member=g.members.get(key)!;
      const direct=g.outgoing.get(key)!.filter(bond=>enabled(bond)&&supported.has(bond.to));
      const distance=member.anchor ? 0 : Math.min(Infinity,...direct.map(bond=>supportDistance(g,bond)));
      distances.set(key,distance);hops.set(key,Number.isFinite(distance)?0:Infinity);
    }
    while (pending.size) {
      const key=[...pending].sort((a,b)=>distances.get(a)!-distances.get(b)!||hops.get(a)!-hops.get(b)!||compare(a,b))[0];
      pending.delete(key);const distance=distances.get(key)!;
      if (!Number.isFinite(distance)) break;
      for (const bond of g.cohesive.get(key)!) if (enabled(bond)) {
        const other=bond.from===key?bond.to:bond.from;if (!pending.has(other)) continue;
        const candidate=spatialNumber(distance+spatialNumber(length(minus(g.members.get(key)!.position,g.members.get(other)!.position)))),count=hops.get(key)!+1;
        if (candidate<distances.get(other)!-epsilon || Math.abs(candidate-distances.get(other)!)<=epsilon&&count<hops.get(other)!) {
          distances.set(other,candidate);hops.set(other,count);
        }
      }
    }
    for (const key of group) {
      const distance=distances.get(key)!,member=g.members.get(key)!;
      if (!Number.isFinite(distance)) continue;
      if (distance>(member.maxSupportDistance??Infinity)+epsilon) {exceeded.push(key);continue;}
      supported.add(key);
    }
    for (const key of group) {
      const paths:SupportRoute[]=[];routes.set(key,paths);
      if (!supported.has(key)||g.members.get(key)!.anchor) continue;
      const distance=distances.get(key)!;
      for (const bond of g.outgoing.get(key)!) if (enabled(bond)&&supported.has(bond.to))
        paths.push({bond,target:bond.to});
      for (const bond of g.cohesive.get(key)!) if (enabled(bond)) {
        const target=bond.from===key?bond.to:bond.from;
        if (!inGroup.has(target)||!supported.has(target)) continue;
        const next=distances.get(target)!;
        // Use a strict potential ordering for loads. Treating almost-equal
        // distances as ties can create A->B->C->A cycles around the tolerance.
        if (next<distance || next===distance&&hops.get(target)!<hops.get(key)!)
          paths.push({bond,target});
      }
      paths.sort((a,b)=>compare(a.bond.id,b.bond.id));
    }
  }
  for (const group of groups) order.push(...[...group].sort((a,b)=>distances.get(b)!-distances.get(a)!||hops.get(b)!-hops.get(a)!||compare(a,b)));
  return {supported,routes,order,exceeded};
}
/** Bounded propagation: every nonterminal pass breaks at least one node or bond. */
function solve(structure: StructuralManifest, state: DestructionState, externalLoads = new Map<string,number>()): DestructionState {
  const g = getGraph(structure), brokenMembers = new Set(state.brokenMembers), brokenBonds = new Set(state.brokenBonds);
  const detached = new Set(state.clusters.flatMap(c => c.memberIds));
  for (const m of structure.members) if ((state.damage[m.id] ?? 0) >= (m.durability ?? m.strength)) brokenMembers.add(m.id);
  for (const b of structure.bonds) if ((state.bondDamage[b.id] ?? 0) >= (b.durability ?? b.capacity)) brokenBonds.add(b.id);
  const remaining = new Set(g.members.keys()); for (const key of detached) remaining.delete(key);
  for (let pass = 0; pass <= g.members.size + g.bonds.size; pass++) {
    let supported = new Set<string>(), order = g.order;
    let routes: Map<string,SupportRoute[]> | undefined;
    const active = (b: StructuralBond) => !brokenBonds.has(b.id) && !brokenMembers.has(b.from) && !brokenMembers.has(b.to) && remaining.has(b.to) && supported.has(b.to);
    if (g.spatialSupport) {
      const paths=spatialSupportPaths(g,remaining,brokenMembers,brokenBonds);
      if (paths.exceeded.length) {paths.exceeded.forEach(key=>brokenMembers.add(key));continue;}
      supported=paths.supported;order=paths.order;routes=paths.routes;
    } else {
      for (let i = g.order.length - 1; i >= 0; i--) {
        const key = g.order[i]; if (!remaining.has(key) || brokenMembers.has(key)) continue;
        if (g.members.get(key)!.anchor || g.outgoing.get(key)!.some(active)) supported.add(key);
      }
    }
    for (const key of remaining) if (!supported.has(key)) { detached.add(key); remaining.delete(key); }
    const loads = new Map([...remaining].map(key => [key, g.members.get(key)!.mass * (structure.gravity ?? 9.81)+(externalLoads.get(key) ?? 0)]));
    let failed = false;
    for (const key of order) if (remaining.has(key)) {
      const m = g.members.get(key)!, load = loads.get(key)!;
      const strength = m.strength * Math.max(0, 1 - (state.damage[key] ?? 0)/(m.durability ?? m.strength));
      if (load > strength + 1e-7) { brokenMembers.add(key); failed = true; }
      const supports = routes ? routes.get(key)!.filter(path=>!brokenBonds.has(path.bond.id)&&!brokenMembers.has(path.target)&&!brokenMembers.has(key))
        : g.outgoing.get(key)!.filter(active).map(bond=>({bond,target:bond.to}));
      const weight = supports.reduce((sum,path) => sum+(path.bond.weight ?? 1), 0);
      for (const {bond:b,target} of supports) {
        const transmitted = load*(b.weight ?? 1)/weight;
        const capacity = b.capacity * Math.max(0, 1-(state.bondDamage[b.id] ?? 0)/(b.durability ?? b.capacity));
        if (transmitted > capacity + 1e-7) { brokenBonds.add(b.id); failed = true; }
        loads.set(target, loads.get(target)! + transmitted);
      }
    }
    if (!failed) break;
  }
  const clusters: DestructionCluster[] = [];
  for (const previous of state.clusters) {
    const groups = components(structure, new Set(previous.memberIds), brokenMembers, brokenBonds);
    if (groups.length === 1 && groups[0].length === previous.memberIds.length) clusters.push(previous);
    else for (const group of groups) clusters.push(cluster(structure, group, previous));
    for (const key of previous.memberIds) detached.delete(key);
  }
  for (const group of components(structure, detached, brokenMembers, brokenBonds)) clusters.push(cluster(structure, group));
  return { ...state, brokenMembers: [...brokenMembers].sort(compare), brokenBonds: [...brokenBonds].sort(compare), clusters: clusters.sort((a,b) => compare(a.id,b.id)) };
}
/** Atomic pure damage transaction. Replaying the same input produces the same result. */
export function damageStructure(structure: StructuralManifest, state: DestructionState, hits: StructuralHit[]): DestructionState {
  validateState(structure, state);
  if (!Array.isArray(hits) || hits.length > DESTRUCTION_LIMITS.hits) throw new Error('Structural hit budget exceeded');
  const g = getGraph(structure), next = cloneState(state);
  const totals = new Map<string, { memberId?: string; bondId?: string; amount: number }>();
  for (const hit of hits) {
    number(hit.amount, 'hit damage');
    if ((hit.memberId === undefined) === (hit.bondId === undefined)) throw new Error('A structural hit must target exactly one member or bond');
    const member = hit.memberId !== undefined, key = member ? hit.memberId! : hit.bondId!;
    if (!(member ? g.members.has(key) : g.bonds.has(key))) throw new Error('Unknown structural hit target');
    const tag = JSON.stringify([member,key]), previous = totals.get(tag);
    if (previous) previous.amount = Math.min(1e12, previous.amount+hit.amount); else totals.set(tag,{...hit});
  }
  let changed = false;
  for (const [,hit] of [...totals].sort((a,b) => compare(a[0],b[0]))) {
    const member = hit.memberId !== undefined, key = member ? hit.memberId! : hit.bondId!;
    const target = member ? g.members.get(key)! : g.bonds.get(key)!;
    const limit = target.durability ?? ('strength' in target ? target.strength : target.capacity);
    const map = member ? next.damage : next.bondDamage, value = Math.min(limit,(map[key] ?? 0)+hit.amount);
    if (value !== (map[key] ?? 0)) { map[key] = value; changed = true; }
  }
  if (!changed) return state;
  next.revision++;
  next.wake = true;
  for (const c of next.clusters) if (c.settled) { c.settled = false; c.quietTime = 0; }
  return freeze(solve(structure,next));
}

function spatialHits(structure: StructuralManifest, state: DestructionState, hit: StructuralSpatialHit): StructuralHit[] {
  vector(hit.position);number(hit.radius,'damage radius',.000001,10000);number(hit.amount,'hit damage');
  const exponent=hit.falloff??1;number(exponent,'damage falloff',0,8);
  const moving=new Map<string,DestructionCluster>();
  for (const cluster of state.clusters) for (const key of cluster.memberIds) moving.set(key,cluster);
  const result:StructuralHit[]=[];
  for (const member of structure.members) {
    const cluster=moving.get(member.id);
    // The authored colliders remain immutable. Move the query into their
    // original frame so repeated hits follow both active and settled rubble.
    const point=cluster ? plus(cluster.origin,rotate(inverse(cluster.rotation),minus(hit.position,cluster.position))) : hit.position;
    const distance=member.colliders.length ? Math.min(...member.colliders.map(collider=>distanceToCollider(point,collider))) : spatialNumber(length(minus(point,member.position)));
    if (distance>hit.radius) continue;
    const amount=spatialNumber(hit.amount*(exponent===0 ? 1 : Math.max(0,1-distance/hit.radius)**exponent));
    if (amount>0) result.push({memberId:member.id,amount});
  }
  return result;
}
/** Damage intersecting material, with distance measured to its real collision
 * shape rather than its center or bounding box. Authored cells determine the
 * smallest fragment. This does not generate new geometry during the hit. */
export function damageStructureAt(structure: StructuralManifest, state: DestructionState, hit: StructuralSpatialHit): DestructionState {
  validateState(structure,state);
  return damageStructure(structure,state,spatialHits(structure,state,hit));
}

function debrisColliders(structure: StructuralManifest, c: DestructionCluster, world: boolean, state: DestructionState): (PhysicsCollider & {id:string})[] {
  const g = getGraph(structure);
  return c.memberIds.flatMap(key => structuralMemberColliders(g.members.get(key)!, state).map((source,index) => {
    const local = minus(source.position,c.origin);
    return { ...source, id: structuralColliderId(structure,key,index), position: world ? plus(c.position,rotate(c.rotation,local)) : local,
      rotation: world ? multiply(c.rotation,source.rotation ?? identity()) : source.rotation ?? identity() };
  }));
}
const sceneCaches = new WeakMap<PhysicsScene, {structure:StructuralManifest; key:string; value:PhysicsScene}>();
const worldSceneCaches = new WeakMap<PhysicsScene, {key:string; value:PhysicsScene}>();
/** Replaces every owned static collider using the accepted revision, retaining terrain.
 * Use the result in preparation/support queries and render the same state revision.
 * Untagged duplicate source colliders must be removed by the building/asset adapter.
 */
export function prepareDestructionScene(structure: StructuralManifest, state: DestructionState, base: PhysicsScene): PhysicsScene {
  validateState(structure,state);
  const key = JSON.stringify([state.deformations,state.clusters.map(c => c.settled ? [c.memberIds,c.origin,c.position,c.rotation] : [c.memberIds])]);
  const cached = sceneCaches.get(base); if (cached?.structure === structure && cached.key === key) return cached.value;
  const owned = new Set(structure.members.flatMap(m => colliderIds(structure,m)));
  const detached = new Set(state.clusters.flatMap(c => c.memberIds));
  const colliders = base.colliders.filter(c => !c.id || !owned.has(c.id));
  for (const m of structure.members) if (!detached.has(m.id)) structuralMemberColliders(m,state).forEach((c,i) => colliders.push({...c,id:structuralColliderId(structure,m.id,i)}));
  // Resting detached rubble is still ordinary collision geometry. Settling
  // never turns a former moving body into a new fixed water placement.
  for (const c of state.clusters) if (c.settled) colliders.push(...debrisColliders(structure,c,true,state).map(collider=>({...collider,waterBoundary:false as const})));
  const value = {...base,colliders}; sceneCaches.set(base,{structure,key,value}); return value;
}
const emptyScenes = new WeakMap<StructuralManifest,PhysicsScene>();
/** Plug into createTerrainWorld/createPlannedWorld's collisionEdits(world,tuning).
 * Replaces original source colliders with current tagged statics/settled rubble.
 * Terrain instance visuals need their authored removal edit or destruction view too.
 */
export function destructionTerrainEdits(structure: StructuralManifest, state: DestructionState): TerrainCollisionEdits {
  let empty=emptyScenes.get(structure); if (!empty) {empty={colliders:[]};emptyScenes.set(structure,empty);}
  return {remove:structure.members.flatMap(m=>m.colliders),add:prepareDestructionScene(structure,state,empty).colliders};
}
function activeDebris(structure: StructuralManifest, state: DestructionState): PhysicsCompoundBody[] {
  const g = getGraph(structure);
  const active = state.clusters.filter(c => !c.settled && c.memberIds.some(key => g.members.get(key)!.colliders.length));
  return active.map(c => ({ id:c.id,position:c.position,rotation:c.rotation,velocity:c.velocity,angularVelocity:c.angularVelocity,
    mass:c.memberIds.reduce((sum,key) => sum+g.members.get(key)!.mass,0),colliders:debrisColliders(structure,c,false,state) }));
}
interface CoupledDamageHistory {
  baseline: DestructionState;
  structuralIds: Set<string>;
  /** Strongest predicted increment per stable contact pair and target. */
  contacts: Map<string, Map<string, number>>;
}
function stableContactPair(hit: PhysicsImpact, history: CoupledDamageHistory): string {
  const one=history.structuralIds.has(hit.colliderId) ? ['structure',hit.colliderId] : ['body',hit.bodyId,hit.colliderId];
  const two=hit.otherColliderId!==undefined&&history.structuralIds.has(hit.otherColliderId) ? ['structure',hit.otherColliderId]
    : hit.otherBodyId!==undefined ? ['body',hit.otherBodyId,hit.otherColliderId??'unnamed'] : ['static',hit.otherColliderId??'unnamed'];
  return JSON.stringify([JSON.stringify(one),JSON.stringify(two)].sort(compare));
}
/** Reconstructed native contact solves can retain a small velocity into their
 * support even when contact correction keeps the accepted pose stationary.
 * Recognize only that constrained component; a real slide, bounce, or rotation
 * must still keep the body active. The ordinary quiet-time window still applies. */
function restingContactResidual(previous: DestructionCluster, body: PhysicsCompoundBodyResult, gravity: PhysicsVector, dt: number): boolean {
  if(!body.ground)return false;
  const n=body.ground.normal,size=length(n);if(size<1e-9)return false;
  const normal={x:n.x/size,y:n.y/size,z:n.z/size},g=length(gravity);
  const acceleration=-(gravity.x*normal.x+gravity.y*normal.y+gravity.z*normal.z);
  if(acceleration<=g*.5)return false;
  const v=body.velocity,inward=-(v.x*normal.x+v.y*normal.y+v.z*normal.z);
  if(inward<0||inward>Math.max(.08,acceleration*dt))return false;
  const tangent={x:v.x+normal.x*inward,y:v.y+normal.y*inward,z:v.z+normal.z*inward};
  // Sub-millimetre contact corrections can alternate each tick while the body
  // stays in one place. Keep their displacement speed below a quarter of the
  // ordinary .08m/s quiet limit, while separately rejecting lateral velocity.
  if(length(tangent)>.01||length(minus(body.position,previous.position))>dt*.02)return false;
  const a=previous.rotation,b=body.rotation;
  const cosine=Math.min(1,Math.abs(a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w)/
    (Math.hypot(a.x,a.y,a.z,a.w)*Math.hypot(b.x,b.y,b.z,b.w)));
  // Use the same angular quiet limit as the ordinary velocity criterion. A
  // stricter derivative limit would reject harmless grounded contact rocking
  // solely because its linear solver also retained an inward residual.
  return 2*Math.acos(cosine)<=dt*.08;
}
/** Rebuilt contact manifolds can alternate a small angular velocity even when
 * their accepted poses only rock by sub-milliradians. Require actual upward
 * contact support and quiet measured translation/rotation before treating that
 * bounded residual as rest. Airborne motion and real rolling stay dynamic. */
function restingAngularResidual(previous:DestructionCluster,body:PhysicsCompoundBodyResult,gravity:PhysicsVector,dt:number,impacts:PhysicsImpact[],source?:PhysicsCompoundBody):boolean {
  const g=length(gravity);
  if(!body.ground||g<=0||length(body.angularVelocity)>.25||length(body.velocity)>=.08
    ||length(minus(body.position,previous.position))>dt*.04)return false;
  const upward=(normal:PhysicsVector)=>-(normal.x*gravity.x+normal.y*gravity.y+normal.z*gravity.z)>g*.5;
  if(!upward(body.ground.normal))return false;
  const support=impacts.some(hit=>{
    if(hit.bodyId!==body.id||hit.impulse<=0)return false;
    if(hit.normal)return upward(hit.normal);
    // Terrain contact records may have no sampled normal. Require the actual
    // unnamed-static impulse plus a ray touching the body's lower envelope;
    // a nearby floor below an airborne piece is not supporting contact.
    if(hit.otherBodyId||hit.otherColliderId||!source)return false;
    const lower=Math.min(...source.colliders.map(c=>rotate(body.rotation,c.position).y+
      physicsShapeBounds(c.shape,multiply(body.rotation,c.rotation??identity())).min.y));
    return body.ground!.distance<=-lower+.015;
  });
  if(!support)return false;
  const a=previous.rotation,b=body.rotation;
  const cosine=Math.min(1,Math.abs(a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w)/
    (Math.hypot(a.x,a.y,a.z,a.w)*Math.hypot(b.x,b.y,b.z,b.w)));
  return 2*Math.acos(cosine)<=dt*.05;
}
/** Native `ground` also reports proximity for character movement. Resting-water
 * controllers need contact-distance support, not a floor half a metre below a
 * tilted floating body. Keep the native proximity API unchanged. */
function supportedDebrisIds(result:PhysicsCompoundResult,bodies:PhysicsCompoundBody[],actors:Set<string>,gravity:PhysicsVector):string[]{
  const g=length(gravity);if(g<=0)return[];
  const sources=new Map(bodies.map(body=>[body.id,body]));
  return result.bodies.filter(body=>{
    if(actors.has(body.id)||!body.ground)return false;
    const normal=body.ground.normal;
    if(-(normal.x*gravity.x+normal.y*gravity.y+normal.z*gravity.z)<=g*.5)return false;
    const source=sources.get(body.id);if(!source?.colliders.length)return false;
    const lower=Math.min(...source.colliders.map(c=>rotate(body.rotation,c.position).y+
      physicsShapeBounds(c.shape,multiply(body.rotation,c.rotation??identity())).min.y));
    return body.ground.distance<=-lower+.02;
  }).map(body=>body.id);
}
function acceptDestructionStep(input: DestructionStep, scene: PhysicsScene, bodies: PhysicsCompoundBody[],
  result: PhysicsCompoundResult, gravity: PhysicsVector, settleSeconds: number, history?: CoupledDamageHistory): DestructionState {
  const {structure,state} = input;
  const byId = new Map(result.bodies.map(body => [body.id,body])), next = cloneState(state);
  let changed = false;
  for (const c of next.clusters) {
    const body = byId.get(c.id); if (!body) continue;
    const quietRotation=length(body.angularVelocity)<.08||restingAngularResidual(c,body,gravity,input.dt,result.impacts,bodies.find(b=>b.id===body.id));
    const quiet=quietRotation&&(length(body.velocity)<.08||restingContactResidual(c,body,gravity,input.dt));
    c.position = body.position; c.rotation = body.rotation; c.velocity = body.velocity; c.angularVelocity = body.angularVelocity;
    c.quietTime = quiet && body.ground ? c.quietTime+input.dt : 0;
    if (c.quietTime >= settleSeconds) { c.settled = true; c.velocity = zero(); c.angularVelocity = zero(); }
    changed = true;
  }
  // Collision-free decorations use swept rays to settle at their pivot without
  // becoming invisible gameplay obstacles or falling forever through terrain.
  const cosmetics = next.clusters.filter(c => !c.settled && !byId.has(c.id));
  const motions = cosmetics.map(c => {
    const velocity = plus(c.velocity,{x:gravity.x*input.dt,y:gravity.y*input.dt,z:gravity.z*input.dt});
    const delta = {x:velocity.x*input.dt,y:velocity.y*input.dt,z:velocity.z*input.dt}, distance = Math.hypot(delta.x,delta.y,delta.z);
    return {velocity,delta,distance,direction:distance ? {x:delta.x/distance,y:delta.y/distance,z:delta.z/distance} : {x:0,y:-1,z:0}};
  });
  const hits = cosmetics.length ? raycastPhysicsBatch({scene,rays:cosmetics.map((c,i) => ({origin:c.position,direction:motions[i].direction,distance:Math.max(.000001,motions[i].distance)}))}) : [];
  cosmetics.forEach((c,i) => {
    const motion = motions[i], hit = hits[i]; c.velocity = motion.velocity;
    if (hit) {
      c.position = plus(c.position,{x:motion.direction.x*hit.distance,y:motion.direction.y*hit.distance,z:motion.direction.z*hit.distance});
      c.settled=true; c.quietTime=settleSeconds; c.velocity=zero(); c.angularVelocity=zero();
    } else c.position=plus(c.position,motion.delta);
    changed=true;
  });
  next.revision += changed ? 1 : 0;
  let accepted: DestructionState = changed ? freeze(next) : state;
  // A yielding sheet stays attached while it bends. At its distinct tearing
  // threshold, prepare its final dent and release it during the same prediction
  // as brittle fracture. Coupled retries then transfer momentum to a real
  // moving body instead of bouncing off the old anchored sheet.
  accepted=ruptureDeformations(input,structure,accepted,result,gravity);
  const colliderMembers = new Map(structure.members.flatMap(m => colliderIds(structure,m).map(id => [id,m.id] as const)));
  if (input.contactLoads !== false) {
    const loads = new Map<string,number>(), detached = new Set(accepted.clusters.flatMap(c=>c.memberIds));
    const magnitude = length(gravity);
    for (const hit of result.impacts) if (!hit.otherBodyId) {
      const member = colliderMembers.get(hit.otherColliderId ?? '');
      // The support graph carries gravity loads. Only the force applied in that
      // direction adds bearing load: a fragment pressing UP on a ceiling must
      // not be interpreted as additional weight sitting on top of it.
      const normal = hit.normal;
      const bearing = normal && magnitude > 0 ? Math.max(0,-(normal.x*gravity.x+normal.y*gravity.y+normal.z*gravity.z)/magnitude) : 1;
      if (member && !detached.has(member) && bearing > 0) loads.set(member,Math.min(1e12,(loads.get(member) ?? 0)+hit.impulse*bearing/input.dt));
    }
    if (loads.size) {
      const stressed = solve(structure,cloneState(accepted),loads);
      if (stressed.brokenMembers.length!==accepted.brokenMembers.length || stressed.brokenBonds.length!==accepted.brokenBonds.length || stressed.clusters.length!==accepted.clusters.length) {
        stressed.revision++; stressed.wake=true; accepted=freeze(stressed);
      }
    }
  }
  if (input.impactDamage && input.impactDamage.damagePerImpulse > 0) {
    const amounts = new Map<string,number>(), seen = new Set<string>();
    const movingBodies = new Map(bodies.map(b=>[b.id,b]));
    const masses = new Map(bodies.map(b => [b.id,b.mass ?? b.colliders.reduce((sum,c) => sum+physicsShapeVolume(c.shape),0)]));
    for (const hit of result.impacts) {
      const pair = history ? stableContactPair(hit,history)
        : JSON.stringify([JSON.stringify([hit.bodyId,hit.colliderId]),JSON.stringify([hit.otherBodyId ?? '',hit.otherColliderId ?? 'ground'])].sort(compare));
      if (seen.has(pair)) continue; seen.add(pair);
      const first=movingBodies.get(hit.bodyId),second=movingBodies.get(hit.otherBodyId ?? '');
      const relative=minus(first?.velocity ?? zero(),second?.velocity ?? zero());
      const spinSpeed=(body: PhysicsCompoundBody | undefined) => {
        if (!body?.angularVelocity) return 0;
        const reach=body.colliders.reduce((radius,c) => Math.max(radius,Math.hypot(c.position.x,c.position.y,c.position.z)+
          (c.shape.kind==='box' ? Math.hypot(c.shape.halfExtents.x,c.shape.halfExtents.y,c.shape.halfExtents.z) :
            c.shape.kind==='convex' ? Math.max(...c.shape.vertices.map(length)) : c.shape.radius+(c.shape.kind==='capsule' ? c.shape.halfHeight : 0))),0);
        return reach*Math.hypot(body.angularVelocity.x,body.angularVelocity.y,body.angularVelocity.z);
      };
      if (Math.hypot(relative.x,relative.y,relative.z)+spinSpeed(first)+spinSpeed(second)<(input.impactDamage.minimumSpeed ?? .5)) continue;
      const resting = ((masses.get(hit.bodyId) ?? 0)+(masses.get(hit.otherBodyId ?? '') ?? 0))*Math.hypot(gravity.x,gravity.y,gravity.z)*input.dt;
      const amount = Math.max(0,hit.impulse-resting-input.impactDamage.minimumImpulse)*input.impactDamage.damagePerImpulse;
      if (!amount) continue;
      const targets=[...new Set([colliderMembers.get(hit.colliderId ?? ''),colliderMembers.get(hit.otherColliderId ?? '')])].filter((key):key is string=>key!==undefined);
      if (!targets.length) continue;
      const localAmounts=new Map<string,number>();
      if (input.impactDamage.radius!==undefined && hit.point) {
        for (const local of spatialHits(structure,accepted,{position:hit.point,radius:input.impactDamage.radius,amount,falloff:input.impactDamage.falloff})) {
          if (!getGraph(structure).members.get(local.memberId!)?.deformation) localAmounts.set(local.memberId!,local.amount);
        }
        // The native point belongs to a contact substep. Moving rubble may have
        // advanced by the final pose used for the radial query, but the members
        // that actually made contact must still receive the direct impact.
        for (const key of targets) if (!getGraph(structure).members.get(key)?.deformation) localAmounts.set(key,amount);
      } else for (const key of targets) if (!getGraph(structure).members.get(key)?.deformation) localAmounts.set(key,amount);
      if (history) {
        let strongest=history.contacts.get(pair);
        if (!strongest) {strongest=new Map();history.contacts.set(pair,strongest);}
        for (const [key,local] of localAmounts) strongest.set(key,Math.max(strongest.get(key)??0,local));
      } else for (const [key,local] of localAmounts) amounts.set(key,Math.min(1e12,(amounts.get(key)??0)+local));
    }
    if (history) {
      for (const contact of history.contacts.values()) for (const [key,amount] of contact)
        amounts.set(key,Math.min(1e12,(amounts.get(key)??0)+amount));
      for (const [key,amount] of amounts) amounts.set(key,Math.max(0,(history.baseline.damage[key]??0)+amount-(accepted.damage[key]??0)));
    }
    const hits = [...amounts].sort((a,b) => compare(a[0],b[0])).map(([memberId,amount]) => ({memberId,amount}));
    if (hits.length) {
      const damaged = damageStructure(structure,accepted,hits), waking = cloneState(damaged);
      let woke = false;
      for (const c of waking.clusters) if (c.settled && c.memberIds.some(key => amounts.has(key))) { c.settled = false; c.quietTime = 0; woke = true; }
      if (woke) { waking.revision++; accepted = freeze(waking); } else accepted = damaged;
    }
  }
  return accepted;
}

function wakeSettled(state: DestructionState): DestructionState {
  if (!state.wake && !state.clusters.some(c=>c.settled)) return state;
  const next = cloneState(state); next.wake = false; next.revision++;
  for (const c of next.clusters) if (c.settled) { c.settled = false; c.quietTime = 0; }
  return freeze(next);
}
/** Apply externally computed bearing loads (N) without manufacturing damage.
 * Loads apply for this solve only; call again while water/wind remains present. */
export function loadStructure(structure: StructuralManifest, state: DestructionState, loads: {memberId:string;force:number}[]): DestructionState {
  validateState(structure,state);
  if(!Array.isArray(loads)||loads.length>DESTRUCTION_LIMITS.hits)throw new Error('Structural load budget exceeded');
  const total=new Map<string,number>(), g=getGraph(structure);
  for(const load of loads){if(!g.members.has(load.memberId))throw new Error('Unknown loaded structural member');number(load.force,'external load',0,1e12);
    const force=(total.get(load.memberId)??0)+load.force;number(force,'total external load',0,1e12);total.set(load.memberId,force);}
  const next=solve(structure,cloneState(state),total);
  if(topologyKey(next)===topologyKey(state))return state;
  next.revision++;next.wake=true;return freeze(next);
}
/** Advance ductile members once, with externally supplied world-space impulses.
 * Native integration calls this after its final accepted collision pass, so
 * coupled fracture retries cannot multiply plastic deformation. */
export function deformStructure(structure: StructuralManifest, state: DestructionState, options:{dt:number;gravity?:PhysicsVector;
  contacts?: (DeformationContact & {memberId:string})[]}): DestructionState {
  validateState(structure,state);number(options.dt,'deformation time step',Number.EPSILON,.25);
  const contacts=options.contacts??[];
  if(!Array.isArray(contacts)||contacts.length>DEFORMATION_LIMITS.contacts)throw new Error('Structural deformation contact budget exceeded');
  const g=getGraph(structure), detached=new Set(state.clusters.flatMap(c=>c.memberIds));
  for(const c of contacts)if(!g.members.get(c.memberId)?.deformation)throw new Error('Deformation contact requires a ductile member');
  if(!state.deformations)return state;
  const next=cloneState(state);next.deformations={...state.deformations};const hits:StructuralHit[]=[];let changed=false;
  for(const member of structure.members)if(member.deformation&&!detached.has(member.id)){
    const previous=state.deformations[member.id],deformed=stepDeformation(structuralDeformationPanel(member)!,previous,{mass:member.mass,dt:options.dt,
      gravity:options.gravity,contacts:contacts.filter(c=>c.memberId===member.id)});
    if(JSON.stringify(previous)!==JSON.stringify(deformed)){next.deformations[member.id]=deformed;changed=true;}
    if(deformed.ruptured&&!previous.ruptured)hits.push({memberId:member.id,amount:member.durability??member.strength});
  }
  if(changed)next.revision++;
  const accepted=changed?freeze(next):state;
  return hits.length?damageStructure(structure,accepted,hits):accepted;
}
function deformationContacts(input:Pick<DestructionStep,'deformationContacts'>,structure:StructuralManifest,state:DestructionState,result:PhysicsCompoundResult):(DeformationContact & {memberId:string})[] {
  const members=new Map(structure.members.filter(m=>m.deformation).flatMap(m=>colliderIds(structure,m).map(id=>[id,m.id] as const)));
  const contacts:(DeformationContact & {memberId:string})[]=(input.deformationContacts??[]).filter(c=>c.structureId===structure.id);
  const detached=new Set(state.clusters.flatMap(c=>c.memberIds));
  for(const hit of result.impacts){
    const memberId=members.get(hit.otherColliderId??'');if(!memberId||detached.has(memberId)||!hit.point||!hit.normal)continue;
    contacts.push({memberId,point:hit.point,impulse:{x:-hit.normal.x*hit.impulse,y:-hit.normal.y*hit.impulse,z:-hit.normal.z*hit.impulse}});
  }
  return contacts;
}
function ruptureDeformations(input:DestructionStep,structure:StructuralManifest,state:DestructionState,result:PhysicsCompoundResult,gravity:PhysicsVector):DestructionState {
  if(!state.deformations)return state;
  const contacts=deformationContacts(input,structure,state,result),detached=new Set(state.clusters.flatMap(c=>c.memberIds));
  let next:DestructionState|undefined;const hits:StructuralHit[]=[];
  for(const member of structure.members)if(member.deformation&&!detached.has(member.id)){
    const panel=structuralDeformationPanel(member)!,own=contacts.filter(c=>c.memberId===member.id);
    const impulse=own.reduce((sum,c)=>sum+Math.abs(deformationRotate(c.impulse,panel.collider.rotation,true)[panel.normalAxis]),0);
    if(impulse<panel.configuration.ruptureImpulse)continue;
    if(!next){next=cloneState(state);next.deformations={...state.deformations};next.revision++;}
    next.deformations![member.id]=stepDeformation(panel,state.deformations[member.id],{mass:member.mass,dt:input.dt,gravity,contacts:own});
    hits.push({memberId:member.id,amount:member.durability??member.strength});
  }
  return next?damageStructure(structure,freeze(next),hits):state;
}
function acceptDeformation(input:DestructionWorldStep,structure:StructuralManifest,state:DestructionState,result:PhysicsCompoundResult,gravity:PhysicsVector):DestructionState {
  if(!state.deformations)return state;
  const contacts=deformationContacts(input,structure,state,result);
  return deformStructure(structure,state,{dt:input.dt,gravity,contacts});
}
function topologyKey(state: DestructionState): string {
  return JSON.stringify(state.clusters.map(c=>[...c.memberIds].sort(compare)).sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b))));
}
/** Retry collision from input time, not from the motion produced by a trial.
 * Splits inherit the original rigid body's point velocity. Newly released
 * statics begin at rest and receive momentum only through the native solve. */
function rebaseFracture(structure: StructuralManifest, baseline: DestructionState, predicted: DestructionState, wake: boolean): DestructionState {
  const parents=new Map<string,DestructionCluster>();
  for (const c of baseline.clusters) for (const key of c.memberIds) parents.set(key,c);
  const state=cloneState(predicted);state.wake=false;
  state.clusters=predicted.clusters.map(c=>{
    const parent=parents.get(c.memberIds[0]);
    if (c.memberIds.some(key=>parents.get(key)!==parent)) throw new Error('Coupled fracture cannot merge separate input bodies');
    if (parent&&parent.memberIds.length===c.memberIds.length) {
      const woke=wake || parent.settled&&!c.settled;
      return {...parent,memberIds:[...parent.memberIds],origin:{...parent.origin},position:{...parent.position},rotation:{...parent.rotation},
        velocity:{...parent.velocity},angularVelocity:{...parent.angularVelocity},settled:woke?false:parent.settled,quietTime:woke?0:parent.quietTime};
    }
    return cluster(structure,[...c.memberIds],parent);
  });
  return freeze(state);
}

/** Shared simulation for all structures and players in the active neighborhood.
 * Body/child limits apply to the complete batch, never separately per structure.
 * Static scene identity survives active pose changes; detaching/settling members
 * replaces collision atomically. Supplied scenes must omit untagged duplicates
 * of owned geometry, as with prepareDestructionScene. With no explicit gravity,
 * all structures must agree on their authored gravity magnitude (default 9.81).
 */
export function stepDestructionWorld(input: DestructionWorldStep): DestructionWorldStepResult {
  if (!Array.isArray(input.structures) || input.structures.length > DESTRUCTION_LIMITS.members)
    throw new Error('Destruction world structure limit exceeded');
  number(input.dt,'time step',Number.EPSILON,.25);
  const settleSeconds = input.settleSeconds ?? 1; number(settleSeconds,'settle duration',.1,60);
  if (input.impactDamage) {
    number(input.impactDamage.minimumImpulse,'minimum impact impulse',0);number(input.impactDamage.damagePerImpulse,'impact damage',0,1e6);
    number(input.impactDamage.minimumSpeed??.5,'minimum impact speed',0,1000);
    if (input.impactDamage.radius!==undefined) number(input.impactDamage.radius,'damage radius',.000001,10000);
    if (input.impactDamage.falloff!==undefined) number(input.impactDamage.falloff,'damage falloff',0,8);
  }
  if (input.contactLoads !== undefined && typeof input.contactLoads !== 'boolean') throw new Error('Invalid structural contact load setting');
  if (input.impactResponse!==undefined&&input.impactResponse!=='deferred'&&input.impactResponse!=='coupled') throw new Error('Invalid structural impact response');
  const structureIds = new Set<string>(), revisions = new Set<string>(), debrisIds = new Set<string>();
  const entries: {structure:StructuralManifest; state:DestructionState; index:number}[] = [];
  for (let index = 0; index < input.structures.length; index++) {
    const entry = input.structures[index];
    if (!entry || !entry.structure || !entry.state) throw new Error('Missing destruction world structure/state');
    const {structure,state} = entry; id(structure.id); id(structure.revision); validateState(structure,state);
    if (structureIds.has(structure.id) || revisions.has(structure.revision)) throw new Error('Duplicate destruction world structure identity');
    structureIds.add(structure.id); revisions.add(structure.revision);
    for (const cluster of state.clusters) {
      if (debrisIds.has(cluster.id)) throw new Error('Duplicate destruction world debris identity');
      debrisIds.add(cluster.id);
    }
    entries.push({...entry,index});
  }
  entries.sort((a,b)=>compare(a.structure.id,b.structure.id));
  const magnitude = entries[0]?.structure.gravity ?? 9.81;
  if (input.gravity === undefined && entries.some(entry=>(entry.structure.gravity ?? 9.81)!==magnitude))
    throw new Error('Different structural gravity magnitudes require explicit world gravity');
  const gravity = input.gravity ?? {x:0,y:-magnitude,z:0}; vector(gravity);
  const actors = input.bodies ?? [];
  if(input.deformationContacts!==undefined){
    if(!Array.isArray(input.deformationContacts)||input.deformationContacts.length>DEFORMATION_LIMITS.contacts)throw new Error('Structural deformation contact budget exceeded');
    for(const contact of input.deformationContacts)if(!entries.some(entry=>entry.structure.id===contact.structureId&&entry.structure.members.some(m=>m.id===contact.memberId&&m.deformation)))
      throw new Error('External deformation contact requires a known ductile member');
  }
  if (!Array.isArray(actors) || actors.length > 64) throw new Error('Destruction world body limit exceeded');
  const actorIds = new Set<string>();
  for (const actor of actors) {
    if (!actor) throw new Error('Missing destruction world body');
    if (typeof actor.id !== 'string' || !actor.id.length || actor.id.length > 128) throw new Error('Invalid destruction world body identity');
    if (actorIds.has(actor.id) || debrisIds.has(actor.id)) throw new Error('Duplicate destruction world body identity');
    actorIds.add(actor.id);
  }
  const combinedScene = (states: DestructionState[]) => {
    const key = JSON.stringify(entries.map(entry=>[entry.structure.revision,states[entry.index].deformations,states[entry.index].clusters.map(c=>
      c.settled ? [c.memberIds,c.origin,c.position,c.rotation] : [c.memberIds])]));
    const retained = worldSceneCaches.get(input.scene);
    if (retained?.key === key) return retained.value;
    let scene = input.scene;
    for (const entry of entries) scene = prepareDestructionScene(entry.structure,states[entry.index],scene);
    const cached = {key,value:scene}; worldSceneCaches.set(input.scene,cached); worldSceneCaches.set(scene,cached);
    return scene;
  };
  const pendingWake = entries.some(entry=>entry.state.wake);
  const initial = input.structures.map(entry=>pendingWake ? wakeSettled(entry.state) : entry.state);
  if (input.impactResponse==='coupled') {
    const structuralIds=new Set(entries.flatMap(entry=>entry.structure.members.flatMap(member=>colliderIds(entry.structure,member))));
    const history=input.structures.map((_,index):CoupledDamageHistory=>({baseline:initial[index],structuralIds,contacts:new Map()}));
    let working=initial,correctionPasses=0;
    for (;;) {
      const scene=combinedScene(working),bodies=[...actors,...entries.flatMap(({structure,index})=>activeDebris(structure,working[index]))];
      const result:PhysicsCompoundResult=bodies.length ? stepCompoundPhysics({scene,bodies,gravity,dt:input.dt})
        : {bodies:[],impacts:[],impactsTruncated:false};
      const predicted=[...working];
      for (const entry of entries) predicted[entry.index]=acceptDestructionStep({...input,...entry,state:working[entry.index]},scene,bodies,result,gravity,settleSeconds,history[entry.index]);
      const wake=predicted.some(state=>state.wake);
      const changed=predicted.some((state,index)=>{
        if (topologyKey(state)!==topologyKey(working[index])) return true;
        const active=new Set(state.clusters.filter(c=>!c.settled).flatMap(c=>c.memberIds));
        return working[index].clusters.some(c=>c.settled&&(wake||c.memberIds.some(key=>active.has(key))));
      });
      if (!changed||correctionPasses===3) {
        // At the bound, retain the final physical motion and explicit fracture
        // result. Only this last cascade is deferred; no pending damage event
        // or hidden solver state is required for persistence or replay.
        for(const entry of entries)predicted[entry.index]=acceptDeformation(input,entry.structure,predicted[entry.index],result,gravity);
        if (predicted.some(state=>state.wake)) for (let index=0;index<predicted.length;index++) predicted[index]=wakeSettled(predicted[index]);
        return {states:predicted,scene:combinedScene(predicted),bodies:result.bodies.filter(body=>actorIds.has(body.id)),
          groundedDebrisIds:supportedDebrisIds(result,bodies,actorIds,gravity),
          impacts:result.impacts,impactsTruncated:result.impactsTruncated,
          impactResponse:{mode:'coupled',correctionPasses,limited:changed}};
      }
      working=input.structures.map((entry,index)=>rebaseFracture(entry.structure,initial[index],predicted[index],wake));
      correctionPasses++;
    }
  }
  const scene = combinedScene(initial);
  const bodies = [...actors,...entries.flatMap(({structure,index})=>activeDebris(structure,initial[index]))];
  const result: PhysicsCompoundResult = bodies.length ? stepCompoundPhysics({scene,bodies,gravity,dt:input.dt})
    : {bodies:[],impacts:[],impactsTruncated:false};
  const states = [...initial];
  for (const entry of entries) states[entry.index] = acceptDestructionStep({...input,...entry,state:initial[entry.index]},scene,bodies,result,gravity,settleSeconds);
  for(const entry of entries)states[entry.index]=acceptDeformation(input,entry.structure,states[entry.index],result,gravity);
  if (states.some(state=>state.wake)) for (let index=0;index<states.length;index++) states[index]=wakeSettled(states[index]);
  return {states,scene:combinedScene(states),bodies:result.bodies.filter(body=>actorIds.has(body.id)),
    groundedDebrisIds:supportedDebrisIds(result,bodies,actorIds,gravity),
    impacts:result.impacts,impactsTruncated:result.impactsTruncated};
}

/** One-structure convenience wrapper. Use stepDestructionWorld when debris from
 * separate structures or players must interact in the same simulation step.
 */
export function stepDestruction(input: DestructionStep): DestructionStepResult {
  const {structure,state,...options} = input;
  const {states,...result} = stepDestructionWorld({...options,structures:[{structure,state}]});
  return {...result,state:states[0]};
}

/** Put this directly under a world field, e.g. world: { destruction: destructionStateShape }.
 * Flat cluster poses and separate membership links fit the network's four-level
 * depth limit, 128-character strings and 256-entry lists without relaxing limits.
 */
export const destructionStateShape = {
  structureRevision: 'string', revision: 'float64', wake: 'boolean',
  damage: [{ id: 'string', amount: 'float64' }], bondDamage: [{ id: 'string', amount: 'float64' }],
  brokenMembers: ['string'], brokenBonds: ['string'],
  deformationNodes: [{ memberId:'string', node:'uint8', offset:'float64', velocity:'float64', plastic:'float64' }],
  rupturedPanels: ['string'],
  links: [{ clusterId: 'string', memberId: 'string' }],
  clusters: [{ id: 'string', ox:'float64',oy:'float64',oz:'float64',x:'float64',y:'float64',z:'float64',
    qx:'float64',qy:'float64',qz:'float64',qw:'float64',vx:'float64',vy:'float64',vz:'float64',
    wx:'float64',wy:'float64',wz:'float64',settled:'boolean',quietTime:'float64' }],
} as const satisfies ObjectShape;
export type DestructionWireState = StateOf<typeof destructionStateShape>;
export function encodeDestructionState(structure: StructuralManifest, state: DestructionState): DestructionWireState {
  validateState(structure,state);
  return {structureRevision:state.structureRevision,revision:state.revision,wake:state.wake,
    damage:Object.entries(state.damage).sort(([a],[b])=>compare(a,b)).map(([id,amount])=>({id,amount})),
    bondDamage:Object.entries(state.bondDamage).sort(([a],[b])=>compare(a,b)).map(([id,amount])=>({id,amount})),
    brokenMembers:[...state.brokenMembers],brokenBonds:[...state.brokenBonds],
    deformationNodes:Object.entries(state.deformations??{}).sort(([a],[b])=>compare(a,b)).flatMap(([memberId,panel])=>panel.offsets.map((offset,node)=>
      ({memberId,node,offset,velocity:panel.velocities[node],plastic:panel.plasticOffsets[node]}))),
    rupturedPanels:Object.entries(state.deformations??{}).filter(([,panel])=>panel.ruptured).map(([id])=>id).sort(compare),
    links:state.clusters.flatMap(c=>c.memberIds.map(memberId=>({clusterId:c.id,memberId}))),
    clusters:state.clusters.map(c=>({id:c.id,ox:c.origin.x,oy:c.origin.y,oz:c.origin.z,x:c.position.x,y:c.position.y,z:c.position.z,
      qx:c.rotation.x,qy:c.rotation.y,qz:c.rotation.z,qw:c.rotation.w,vx:c.velocity.x,vy:c.velocity.y,vz:c.velocity.z,
      wx:c.angularVelocity.x,wy:c.angularVelocity.y,wz:c.angularVelocity.z,settled:c.settled,quietTime:c.quietTime}))};
}
export function decodeDestructionState(structure: StructuralManifest, wire: DestructionWireState): DestructionState {
  const map = (values: DestructionWireState['damage']): Record<string,number> => {
    if (!Array.isArray(values) || values.length > DESTRUCTION_LIMITS.bonds) throw new Error('Invalid destruction wire damage');
    const result: Record<string,number> = {};
    for (const entry of values) { id(entry.id); if (Object.hasOwn(result,entry.id)) throw new Error('Duplicate destruction wire damage'); result[entry.id]=entry.amount; }
    return result;
  };
  if (!wire || !Array.isArray(wire.clusters) || wire.clusters.length > DESTRUCTION_LIMITS.members || !Array.isArray(wire.links) || wire.links.length > DESTRUCTION_LIMITS.members)
    throw new Error('Invalid destruction wire clusters');
  const ids = new Set(wire.clusters.map(c=>c.id));
  for (const link of wire.links) if (!ids.has(link.clusterId)) throw new Error('Unknown destruction wire cluster');
  const state: DestructionState = {structureRevision:wire.structureRevision,revision:wire.revision,wake:wire.wake,damage:map(wire.damage),bondDamage:map(wire.bondDamage),
    brokenMembers:[...wire.brokenMembers],brokenBonds:[...wire.brokenBonds],clusters:wire.clusters.map(c=>({id:c.id,
      memberIds:wire.links.filter(link=>link.clusterId===c.id).map(link=>link.memberId),origin:{x:c.ox,y:c.oy,z:c.oz},position:{x:c.x,y:c.y,z:c.z},
      rotation:{x:c.qx,y:c.qy,z:c.qz,w:c.qw},velocity:{x:c.vx,y:c.vy,z:c.vz},angularVelocity:{x:c.wx,y:c.wy,z:c.wz},settled:c.settled,quietTime:c.quietTime}))};
  const nodes=wire.deformationNodes??[],ruptures=wire.rupturedPanels??[];
  if(!Array.isArray(nodes)||nodes.length>DEFORMATION_LIMITS.panels*DEFORMATION_LIMITS.nodes||!Array.isArray(ruptures)||ruptures.length>DEFORMATION_LIMITS.panels||new Set(ruptures).size!==ruptures.length)
    throw new Error('Invalid deformation wire state');
  const members=structure.members.filter(m=>m.deformation);
  if(members.length){state.deformations={};for(const member of members){
    const panel=structuralDeformationPanel(member)!,values=nodes.filter(n=>n.memberId===member.id).sort((a,b)=>a.node-b.node);
    if(values.length!==panel.points.length||values.some((value,index)=>value.node!==index))throw new Error('Incomplete or duplicate deformation wire nodes');
    state.deformations[member.id]={offsets:values.map(v=>v.offset),velocities:values.map(v=>v.velocity),plasticOffsets:values.map(v=>v.plastic),ruptured:ruptures.includes(member.id)};
  }}
  if(nodes.some(n=>!members.some(m=>m.id===n.memberId))||ruptures.some(id=>!members.some(m=>m.id===id)))throw new Error('Unknown deformation wire member');
  validateState(structure,state); return freeze(state);
}
