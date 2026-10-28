/** Opt-in ownership adapters. Load-bearing relationships are authored; room
 * walls, visual contact and material names never infer structural support. */
import type { BuildingManifest } from './building.ts';
import { transformAssetColliders, validateAssetManifest, type AssetManifest } from './assetFamilies.ts';
import { compileStructure, structuralColliderId, structuralMemberColliders, type StructuralManifest, type StructuralBond, type DestructionState } from './destruction.ts';
import type { DeformationConfiguration } from './deformation.ts';
import type { PhysicsCollider, PhysicsRotation, PhysicsVector } from './physics.ts';

export interface StructuralBinding {
  id: string; mass: number; strength: number; durability?: number; anchor?: boolean;
  /** Maximum distance through connected material to a surviving bearing. */
  maxSupportDistance?: number;
  deformation?: DeformationConfiguration;
  /** Optional world-space centre of mass; otherwise derived from owned parts. */
  position?: PhysicsVector;
  partIds: string[]; surfaceIds?: string[]; lightIds?: string[];
}
export interface StructuralBindings {
  id: string; version: string; gravity?: number; members: StructuralBinding[]; bonds: StructuralBond[];
}
export interface StructuralOwnership {
  memberId: string; partIds: readonly string[]; surfaceIds: readonly string[]; lightIds: readonly string[];
}
export interface BuildingStructure extends StructuralManifest {
  source: { kind: 'building'; id: string; revision: string; fingerprint: string };
  ownership: readonly StructuralOwnership[];
}
export interface AssetStructure extends StructuralManifest {
  source: { kind: 'asset'; key: string; position: PhysicsVector; yaw: number };
  ownership: readonly StructuralOwnership[];
}
export interface BuildingDestructionProjection extends BuildingManifest {
  destruction: { structureRevision: string; topologyRevision: string; removedMemberIds: string[];
    removedPartIds: string[]; removedSurfaceIds: string[]; removedLightIds: string[]; navigation: 'not-revalidated' };
}
export interface AssetDestructionProjection {
  model: AssetManifest; position: PhysicsVector; yaw: number; revision: string;
  attachedPartIds: string[]; removedPartIds: string[]; colliders: PhysicsCollider[];
  surfaces: NonNullable<AssetManifest['surfaces']>;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} requires supported plain fields.`);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => compare(a, b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  const text = canonical(value); let a = 2166136261, b = 0x6d2b79f5;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b); }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
function fingerprint(building: BuildingManifest): string {
  return hash({ parts: building.parts, colliders: building.colliders, surfaces: building.surfaces, lights: building.lights ?? [] });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
const identity = (): PhysicsRotation => ({ x: 0, y: 0, z: 0, w: 1 });
function near(a: number, b: number): boolean { return Math.abs(a - b) <= 1e-4; }
function vectorNear(a: PhysicsVector, b: PhysicsVector): boolean { return near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z); }
function sameCollider(a: PhysicsCollider, b: PhysicsCollider): boolean {
  const q = a.rotation ?? identity(), r = b.rotation ?? identity();
  if (!vectorNear(a.position, b.position) || !([1, -1].some(sign => near(q.x, sign * r.x) && near(q.y, sign * r.y) && near(q.z, sign * r.z) && near(q.w, sign * r.w)))) return false;
  if (a.shape.kind === 'box' && b.shape.kind === 'box') return vectorNear(a.shape.halfExtents, b.shape.halfExtents);
  if (a.shape.kind === 'ball' && b.shape.kind === 'ball') return near(a.shape.radius, b.shape.radius);
  if (a.shape.kind === 'convex' && b.shape.kind === 'convex') {
    const one = a.shape.vertices, two = b.shape.vertices;
    return one.length === two.length && one.every((vertex, index) => vectorNear(vertex, two[index]));
  }
  return a.shape.kind === 'capsule' && b.shape.kind === 'capsule' && near(a.shape.radius, b.shape.radius) && near(a.shape.halfHeight, b.shape.halfHeight);
}
/** Existing primitives and model compounds are retained exactly after matching,
 * including compiler-specific rounding and friction. No envelope replacement. */
function buildingPartColliders(building: BuildingManifest): Map<string, PhysicsCollider[]> {
  const remaining = new Set(building.colliders.map((_, index) => index)), result = new Map<string, PhysicsCollider[]>();
  for (const part of building.parts) {
    if (result.has(part.id)) throw new Error('Building destruction requires unique compiled part IDs.');
    let expected: PhysicsCollider[] = [];
    if (part.collidable) {
      if (part.model) {
        if (Math.abs(part.rotation.x) + Math.abs(part.rotation.z) > 1e-6) throw new Error('Destructible model wrappers must retain their compiled upright pose.');
        const yaw = 2 * Math.atan2(part.rotation.y, part.rotation.w);
        expected = transformAssetColliders(part.model, { ...part.position, y: part.position.y - part.size.y / 2 }, yaw);
      } else expected = [{ shape: part.geometry ? { kind: 'convex', vertices: part.geometry.vertices }
        : { kind: 'box', halfExtents: { x: part.size.x / 2, y: part.size.y / 2, z: part.size.z / 2 } }, position: part.position, rotation: part.rotation }];
    }
    const colliders = expected.map(collider => {
      const index = [...remaining].find(index => sameCollider(collider, building.colliders[index]));
      if (index === undefined) throw new Error(`Compiled part ${part.id} has no matching original collider.`);
      remaining.delete(index); return building.colliders[index];
    });
    result.set(part.id, colliders);
  }
  if (remaining.size) throw new Error('Building destruction found collision without an owning compiled part.');
  return result;
}
function names(input: unknown, allowed: Set<string>, owned: Set<string>, label: string, required = false): string[] {
  if (input === undefined && !required) return [];
  if (!Array.isArray(input) || input.length > 4096 || required && !input.length) throw new Error(`${label} requires a bounded ${required ? 'nonempty ' : ''}array.`);
  return Array.from(input, id => {
    if (typeof id !== 'string' || !allowed.has(id) || owned.has(id)) throw new Error(`${label} contains unknown or multiply owned ID: ${String(id)}.`);
    owned.add(id); return id;
  }).sort(compare);
}
/** Compiler attachments share their parent's authored rigid member unless a
 * caller owns them explicitly. This adds geometry, never mass or load paths. */
function inheritBuildingAttachments(building: BuildingManifest, input: StructuralBindings): StructuralBindings {
  const parents = new Map<string, string>(), parts = new Map(building.parts.map(part => [part.id, part]));
  for (const part of building.parts) if (part.attachmentParentId !== undefined) {
    if (typeof part.attachmentParentId !== 'string' || !parts.has(part.attachmentParentId))
      throw new Error(`Building attachment ${part.id} requires a known parent part.`);
    parents.set(part.id, part.attachmentParentId);
  }
  if (!parents.size) return input;
  const checked = new Set<string>();
  for (const start of parents.keys()) {
    const path = new Set<string>(); let current: string | undefined = start;
    while (current !== undefined && !checked.has(current)) {
      if (path.has(current)) throw new Error('Building attachment parents must not contain cycles.');
      path.add(current); current = parents.get(current);
    }
    for (const id of path) checked.add(id);
  }
  fields(input, ['id', 'version', 'gravity', 'members', 'bonds'], 'Structural bindings');
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 64) throw new Error('Structural bindings require 1..64 members.');
  const allParts = new Set(parts.keys()), owned = new Set<string>(), owners = new Map<string, number>();
  const explicit = input.members.map((member, index) => {
    fields(member, ['id', 'mass', 'strength', 'durability', 'anchor', 'maxSupportDistance', 'deformation', 'position', 'partIds', 'surfaceIds', 'lightIds'], 'Structural binding');
    const ids = names(member.partIds, allParts, owned, 'Structural parts', true);
    for (const id of ids) owners.set(id, index);
    return ids;
  });
  const inherited = new Map<number, string[]>();
  for (const start of parents.keys()) {
    if (owners.has(start)) continue;
    const path: string[] = []; let current: string | undefined = start;
    while (current !== undefined && !owners.has(current)) { path.push(current); current = parents.get(current); }
    if (current === undefined) throw new Error(`Building attachment ${start} has no explicitly owned parent.`);
    const owner = owners.get(current)!;
    for (const id of path) {
      owners.set(id, owner); const ids = inherited.get(owner) ?? []; ids.push(id); inherited.set(owner, ids);
    }
  }
  if (!inherited.size) return input;
  return { ...input, members: input.members.map((member, index) => {
    const children = inherited.get(index); if (!children) return member;
    // Retain the centre derived before compiler children were added. Existing
    // bindings keep their chosen mass and centre when the shell gains detail.
    const source = explicit[index].map(id => parts.get(id)!);
    const weights = source.map(part => Math.max(1e-9, part.size.x * part.size.y * part.size.z)), total = weights.reduce((sum, value) => sum + value, 0);
    const center = (axis: keyof PhysicsVector) => source.reduce((sum, part, i) => sum + part.position[axis] * weights[i], 0) / total;
    return { ...member, position: member.position ?? { x: center('x'), y: center('y'), z: center('z') }, partIds: [...explicit[index], ...children].sort(compare) };
  }) };
}
function bind(input: StructuralBindings, parts: readonly { id: string; position: PhysicsVector; size: PhysicsVector }[],
  colliders: Map<string, PhysicsCollider[]>, surfaceIds: readonly string[], lightIds: readonly string[]): { manifest: StructuralManifest; ownership: StructuralOwnership[] } {
  fields(input, ['id', 'version', 'gravity', 'members', 'bonds'], 'Structural bindings');
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 64) throw new Error('Structural bindings require 1..64 members.');
  const partMap = new Map(parts.map(part => [part.id, part]));
  const allParts = new Set(partMap.keys()), allSurfaces = new Set(surfaceIds), allLights = new Set(lightIds);
  if (allParts.size !== parts.length || allSurfaces.size !== surfaceIds.length || allLights.size !== lightIds.length) throw new Error('Structural source components require unique IDs.');
  const ownedParts = new Set<string>(), ownedSurfaces = new Set<string>(), ownedLights = new Set<string>(), ownership: StructuralOwnership[] = [];
  const members = Array.from(input.members, member => {
    fields(member, ['id', 'mass', 'strength', 'durability', 'anchor', 'maxSupportDistance', 'deformation', 'position', 'partIds', 'surfaceIds', 'lightIds'], 'Structural binding');
    const partIds = names(member.partIds, allParts, ownedParts, 'Structural parts', true);
    const memberSurfaces = names(member.surfaceIds, allSurfaces, ownedSurfaces, 'Structural surfaces');
    const memberLights = names(member.lightIds, allLights, ownedLights, 'Structural lights');
    const source = partIds.map(id => partMap.get(id)!);
    const weight = source.map(part => Math.max(1e-9, part.size.x * part.size.y * part.size.z)), total = weight.reduce((a, b) => a + b, 0);
    const center = (axis: keyof PhysicsVector) => source.reduce((sum, part, index) => sum + part.position[axis] * weight[index], 0) / total;
    const position = member.position ?? { x: center('x'), y: center('y'), z: center('z') };
    ownership.push({ memberId: member.id, partIds, surfaceIds: memberSurfaces, lightIds: memberLights });
    return { id: member.id, mass: member.mass, strength: member.strength, ...(member.durability === undefined ? {} : { durability: member.durability }),
      ...(member.anchor === undefined ? {} : { anchor: member.anchor }),
      ...(member.deformation === undefined ? {} : { deformation: member.deformation }),
      ...(member.maxSupportDistance === undefined ? {} : { maxSupportDistance: member.maxSupportDistance }), position, colliders: partIds.flatMap(id => colliders.get(id)!),
      partIds, surfaceIds: memberSurfaces, lightIds: memberLights };
  });
  if (ownedParts.size !== allParts.size || ownedSurfaces.size !== allSurfaces.size || ownedLights.size !== allLights.size)
    throw new Error('Structural bindings must own every compiled part, walkable surface and fixture light exactly once.');
  const manifest = compileStructure({ id: input.id, version: input.version, members, bonds: input.bonds, ...(input.gravity === undefined ? {} : { gravity: input.gravity }) });
  return { manifest, ownership: ownership.sort((a, b) => compare(a.memberId, b.memberId)) };
}
/** Bind all components, including noncolliding decorations and hidden stair
 * ramps. Omitted compiler attachments inherit their explicitly owned parent;
 * surface/light ownership remains explicit and is removed with its member. */
export function compileBuildingStructure(building: BuildingManifest, bindings: StructuralBindings): BuildingStructure {
  if (!building.diagnostics.valid) throw new Error('Destruction requires a valid compiled building.');
  if (!Array.isArray(building.parts) || building.parts.length > 4096 || !Array.isArray(building.colliders) || building.colliders.length > 256
    || !Array.isArray(building.surfaces) || building.surfaces.length > 4096 || building.lights && building.lights.length > 4096)
    throw new Error('Building exceeds the bounded structural source budget.');
  const { manifest, ownership } = bind(inheritBuildingAttachments(building, bindings), building.parts, buildingPartColliders(building), building.surfaces.map(surface => surface.id), (building.lights ?? []).map(light => light.id));
  return freeze({ ...manifest, source: { kind: 'building', id: building.id, revision: building.revision, fingerprint: fingerprint(building) }, ownership });
}
/** Bind custom family parts (trees, furniture, structures) at a world pose.
 * The original validated model remains reusable; partial models are not recentered. */
export function compileAssetStructure(input: AssetManifest, bindings: StructuralBindings,
  pose: { position?: PhysicsVector; yaw?: number } = {}): AssetStructure {
  fields(pose, ['position', 'yaw'], 'Structural asset pose');
  const model = validateAssetManifest(input), position = pose.position ?? { x: 0, y: 0, z: 0 }, yaw = pose.yaw ?? 0;
  if (!plain(position) || !['x', 'y', 'z'].every(axis => finite(position[axis as keyof PhysicsVector])) || !finite(yaw)) throw new Error('Structural asset pose requires finite world coordinates and yaw.');
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const transform = (p: PhysicsVector) => ({ x: position.x + c * p.x + s * p.z, y: position.y + p.y, z: position.z - s * p.x + c * p.z });
  const worldColliders = transformAssetColliders(model, position, yaw), partColliders = new Map<string, PhysicsCollider[]>(); let index = 0;
  for (const part of model.parts) partColliders.set(part.id, part.collision === false ? [] : [worldColliders[index++]]);
  const { manifest, ownership } = bind(bindings, model.parts.map(part => ({ ...part, position: transform(part.position) })), partColliders,
    (model.surfaces ?? []).map(surface => surface.id), []);
  return freeze({ ...manifest, source: { kind: 'asset', key: model.key, position: { ...position }, yaw }, ownership });
}
/** Stable membership key; pose-only simulation does not rebuild static views. */
export function destructionTopologyKey(structure: StructuralManifest, state: DestructionState): string {
  if (state.structureRevision !== structure.revision) throw new Error('Destruction state belongs to another structure revision.');
  const known = new Set(structure.members.map(member => member.id)), detached = new Set<string>();
  if (!Array.isArray(state.clusters) || state.clusters.length > 64) throw new Error('Destruction state has invalid clusters.');
  for (const cluster of state.clusters) {
    if (!Array.isArray(cluster.memberIds) || !cluster.memberIds.length) throw new Error('Destruction cluster requires member IDs.');
    for (const id of cluster.memberIds) { if (!known.has(id) || detached.has(id)) throw new Error('Destruction cluster contains unknown or repeated members.'); detached.add(id); }
  }
  return hash([structure.revision, [...detached].sort(compare)]);
}
function attached(structure: StructuralManifest, state: DestructionState): Set<string> {
  destructionTopologyKey(structure, state);
  const removed = new Set(state.clusters.flatMap(cluster => cluster.memberIds));
  return new Set(structure.members.filter(member => !removed.has(member.id)).map(member => member.id));
}
function checkOwnership(structure: BuildingStructure | AssetStructure): void {
  if (!Array.isArray(structure.ownership) || structure.ownership.length !== structure.members.length) throw new Error('Structural adapter ownership differs from its members.');
  const owners = new Map(structure.ownership.map(owner => [owner.memberId, owner]));
  if (owners.size !== structure.members.length) throw new Error('Structural adapter ownership contains duplicate members.');
  for (const member of structure.members) {
    const owner = owners.get(member.id);
    if (!owner || ['partIds', 'surfaceIds', 'lightIds'].some(key => {
      const field = key as 'partIds' | 'surfaceIds' | 'lightIds';
      return !Array.isArray(owner[field]) || canonical([...owner[field]].sort(compare)) !== canonical([...(member[field] ?? [])].sort(compare));
    })) throw new Error('Structural adapter ownership differs from its compiled member geometry.');
  }
}
function staticColliders(structure: StructuralManifest, active: Set<string>, state: DestructionState): PhysicsCollider[] {
  return structure.members.filter(member => active.has(member.id)).flatMap(member => structuralMemberColliders(member,state).map((collider, index) => ({ ...collider,
    id: structuralColliderId(structure, member.id, index) })));
}
/** Static geometry only. Detached bodies come from the destruction runtime;
 * keeping them here too would create invisible, immovable duplicate obstacles. */
export function projectBuildingDestruction(building: BuildingManifest, structure: BuildingStructure, state: DestructionState): BuildingDestructionProjection {
  checkOwnership(structure);
  if (structure.source.kind !== 'building' || building.id !== structure.source.id || building.revision !== structure.source.revision || fingerprint(building) !== structure.source.fingerprint)
    throw new Error('Building destruction source differs from its compiled ownership.');
  const active = attached(structure, state), removed = structure.ownership.filter(owner => !active.has(owner.memberId));
  const removedPartIds = removed.flatMap(owner => [...owner.partIds]).sort(compare), removedSurfaceIds = removed.flatMap(owner => [...owner.surfaceIds]).sort(compare), removedLightIds = removed.flatMap(owner => [...owner.lightIds]).sort(compare);
  const partIds = new Set(removedPartIds), surfaceIds = new Set(removedSurfaceIds), lightIds = new Set(removedLightIds);
  const parts = building.parts.filter(part => !partIds.has(part.id)), surfaces = building.surfaces.filter(surface => !surfaceIds.has(surface.id));
  const colliders = staticColliders(structure, active,state), lights = building.lights?.filter(light => !lightIds.has(light.id));
  const removedDoors = new Set((building.doors ?? []).filter(door => door.partIds.some(id => partIds.has(id))).map(door => door.id));
  const topologyRevision = destructionTopologyKey(structure, state);
  return { ...building, revision: `${building.revision}:destruction:${topologyRevision}`, parts, colliders, surfaces,
    ...(lights ? { lights } : {}), ...(building.doors ? { doors: building.doors.filter(door => !removedDoors.has(door.id)) } : {}),
    portals: building.portals.map(portal => { if (!portal.doorId || !removedDoors.has(portal.doorId)) return portal;
      const { doorId: _doorId, currentClearWidth: _clear, ...open } = portal; return open; }),
    diagnostics: { ...building.diagnostics, counts: { ...building.diagnostics.counts, parts: parts.reduce((n, part) => n + (part.model?.parts.length ?? 1), 0), colliders: colliders.length },
      reachableRooms: [], unreachableRooms: [], coverage: 'Destruction projection; authored room navigation has not been revalidated.', publicAccess: undefined, traversal: undefined },
    destruction: { structureRevision: structure.revision, topologyRevision, removedMemberIds: removed.map(owner => owner.memberId).sort(compare), removedPartIds, removedSurfaceIds, removedLightIds, navigation: 'not-revalidated' } };
}
export function projectAssetDestruction(input: AssetManifest, structure: AssetStructure, state: DestructionState): AssetDestructionProjection {
  checkOwnership(structure);
  const model = validateAssetManifest(input); if (model.key !== structure.source.key) throw new Error('Asset destruction source differs from its compiled ownership.');
  const active = attached(structure, state), owners = structure.ownership.filter(owner => active.has(owner.memberId));
  const partIds = new Set(owners.flatMap(owner => [...owner.partIds])), surfaceIds = new Set(owners.flatMap(owner => [...owner.surfaceIds]));
  return { model, position: structure.source.position, yaw: structure.source.yaw, revision: destructionTopologyKey(structure, state),
    attachedPartIds: [...partIds].sort(compare), removedPartIds: model.parts.filter(part => !partIds.has(part.id)).map(part => part.id),
    colliders: staticColliders(structure, active,state), surfaces: (model.surfaces ?? []).filter(surface => surfaceIds.has(surface.id)) };
}
