/** Bounded, deterministic socket assemblies. Models remain reusable plain data;
 * no renderer, terrain or building dependency is required. */
import { assetPartBounds, createAssetCatalog, defineAssetFamily, validateAssetManifest,
  type AssetManifest, type AssetPart, type AssetResolveOptions, type AssetSocket, type AssetSurface } from './assetFamilies.ts';
import type { PhysicsVector } from './physics.ts';
import { spatialAngle, spatialCoordinate, transformSpatialPoint } from './spatial.ts';

export interface AssetGroupCatalog { resolve(familyId: string, options: AssetResolveOptions): AssetManifest }
export interface AssetGroupAttachment {
  /** Stable rule ID. Matching root sockets are selected in socket-ID order. */
  id: string; socketTag: string; family: string; count: number;
  parameters?: Record<string, string | number>;
}
export interface AssetGroupRequest extends AssetResolveOptions {
  family: string; attachments?: readonly AssetGroupAttachment[];
}
export interface AssetGroupInstance {
  id: string; model: AssetManifest; position: PhysicsVector; yaw: number;
  parentId?: string; socketId?: string;
}
export interface AssetGroup {
  version: 1; id: string; seed: number; instances: readonly AssetGroupInstance[];
  bounds: { min: PhysicsVector; max: PhysicsVector }; size: PhysicsVector;
}
export const ASSET_GROUP_LIMITS = Object.freeze({ attachments: 8, instances: 33, parts: 512, colliders: 384 });
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const trustedGroups = new WeakSet<AssetGroup>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** This identity rule deliberately preserves existing furnishing socket IDs. */
function joinedId(parent: string, child: string): string {
  const key = `${parent}:${child}`; if (key.length <= 96) return key;
  let h = 0; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  return `${key.slice(0,80)}:${((h ^ h >>> 16) >>> 0).toString(16)}`;
}
/** Validate rule structure independently of a particular family's sockets. */
export function validateAssetGroupAttachments(input: readonly AssetGroupAttachment[] | undefined): void {
  if (input === undefined) return;
  if (!Array.isArray(input) || input.length > ASSET_GROUP_LIMITS.attachments) throw new Error('Asset group attachment rules exceed their budget.');
  const ids = new Set<string>(); let count = 1;
  for (const rule of input) {
    if (!rule || !validId(rule.id) || ids.has(rule.id) || !validId(rule.socketTag) || !validId(rule.family)
      || !Number.isInteger(rule.count) || rule.count < 1 || rule.count > 32
      || Object.keys(rule).some(key => !['id', 'socketTag', 'family', 'count', 'parameters'].includes(key))) throw new Error('Asset group needs unique rule IDs, socket tags, families and bounded positive counts.');
    ids.add(rule.id); count += rule.count;
    if (rule.parameters !== undefined && (!rule.parameters || typeof rule.parameters !== 'object' || Array.isArray(rule.parameters)
      || Object.keys(rule.parameters).length > 24)) throw new Error('Asset group parameters must be a bounded dictionary.');
  }
  if (count > ASSET_GROUP_LIMITS.instances) throw new Error('Asset group exceeds its instance budget.');
}
function partAt(instance: AssetGroupInstance, part: AssetPart): AssetPart {
  const position = transformSpatialPoint(part.position, instance.position, instance.yaw);
  return { ...part, id: joinedId(instance.id, part.id), position: { ...position, y: spatialCoordinate(instance.position.y + part.position.y) },
    size: { ...part.size }, yaw: spatialAngle(instance.yaw + (part.yaw ?? 0)) };
}
function groupBounds(instances: readonly AssetGroupInstance[]) {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  let parts = 0, colliders = 0;
  for (const instance of instances) {
    parts += instance.model.parts.length; colliders += instance.model.colliders.length;
    if (parts > ASSET_GROUP_LIMITS.parts || colliders > ASSET_GROUP_LIMITS.colliders) throw new Error('Asset group exceeds its part/collider budget.');
    for (const part of instance.model.parts) {
      const bounds = assetPartBounds(partAt(instance, part));
      for (const axis of ['x', 'y', 'z'] as const) { min[axis] = Math.min(min[axis], bounds.min[axis]); max[axis] = Math.max(max[axis], bounds.max[axis]); }
    }
  }
  for (const axis of ['x', 'y', 'z'] as const) { min[axis] = spatialCoordinate(min[axis]); max[axis] = spatialCoordinate(max[axis]); }
  return { bounds: { min, max }, size: { x: spatialCoordinate(max.x - min.x), y: spatialCoordinate(max.y - min.y), z: spatialCoordinate(max.z - min.z) } };
}

/** Resolve one parent plus one level of attachments. Counts are exact; missing
 * or multiply claimed sockets fail instead of silently omitting children.
 * No collision/ground support is implied by a socket: placement adapters must
 * check their own room, doorway, terrain and actor clearance constraints. */
export function resolveAssetGroup(catalog: AssetGroupCatalog, request: AssetGroupRequest): AssetGroup {
  if (!request || !validId(request.instanceId) || !validId(request.family) || !Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff)
    throw new Error('Asset group requires a family, stable instance ID and unsigned seed.');
  validateAssetGroupAttachments(request.attachments);
  const model = validateAssetManifest(catalog.resolve(request.family, request));
  const instances: AssetGroupInstance[] = [{ id: request.instanceId, model, position: { x: 0, y: 0, z: 0 }, yaw: 0 }];
  const sockets = new Set<string>(), ids = new Set([request.instanceId]);
  for (const rule of [...request.attachments ?? []].sort((a, b) => compare(a.id, b.id))) {
    const matching = model.sockets.filter(socket => socket.tags.includes(rule.socketTag)).sort((a, b) => compare(a.id, b.id));
    if (matching.length < rule.count) throw new Error(`Family ${request.family} supplies ${matching.length} ${rule.socketTag} sockets; ${rule.count} required.`);
    for (const socket of matching.slice(0, rule.count)) {
      if (sockets.has(socket.id)) throw new Error(`Asset socket ${socket.id} is claimed by more than one attachment rule.`);
      sockets.add(socket.id); const childId = joinedId(request.instanceId, socket.id);
      if (ids.has(childId)) throw new Error(`Asset group instance ID collision: ${childId}`); ids.add(childId);
      const child = validateAssetManifest(catalog.resolve(rule.family, { seed: request.seed, instanceId: childId, parameters: rule.parameters }));
      instances.push({ id: childId, model: child, position: { ...socket.position }, yaw: socket.yaw ?? 0, parentId: request.instanceId, socketId: socket.id });
    }
  }
  const group: AssetGroup = freeze({ version: 1, id: request.instanceId, seed: request.seed, instances, ...groupBounds(instances) });
  trustedGroups.add(group); return group;
}

function validatedInstances(group: AssetGroup): readonly AssetGroupInstance[] {
  if (trustedGroups.has(group)) return group.instances;
  if (!group || group.version !== 1 || !validId(group.id) || !Number.isInteger(group.seed) || group.seed < 0 || group.seed > 0xffffffff
    || !Array.isArray(group.instances) || !group.instances.length || group.instances.length > ASSET_GROUP_LIMITS.instances) throw new Error('Malformed asset group.');
  const ids = new Set<string>();
  const instances = Array.from(group.instances).map(instance => {
    if (!instance || !validId(instance.id) || ids.has(instance.id) || !instance.position
      || !['x', 'y', 'z'].every(axis => { const value = instance.position[axis as keyof PhysicsVector]; return Number.isFinite(value) && Math.abs(value) <= 256; })
      || !Number.isFinite(instance.yaw) || instance.parentId !== undefined && !validId(instance.parentId)
      || instance.socketId !== undefined && !validId(instance.socketId)) throw new Error('Malformed asset group instance.');
    ids.add(instance.id); return { ...instance, model: validateAssetManifest(instance.model) };
  });
  groupBounds(instances); return instances;
}

/** Flatten a resolved group for terrain instancing or another single-model
 * consumer. Standard asset limits (128 parts/96 colliders/32 remaining sockets)
 * apply. Instances retain their source parameters in the original group.
 * The returned model is recentered X/Z and rests at Y=0. originOffset is its
 * origin in the original group's coordinates; add its rotated value when an
 * existing root anchor must stay fixed. Consumed parent sockets are omitted. */
export function assetGroupModel(group: AssetGroup, options: { id: string; version: string }): { model: AssetManifest; originOffset: PhysicsVector } {
  const instances = validatedInstances(group), parts = instances.flatMap(instance => instance.model.parts.map(part => partAt(instance, part)));
  const { bounds } = groupBounds(instances), originOffset = { x: spatialCoordinate((bounds.min.x + bounds.max.x) / 2), y: bounds.min.y, z: spatialCoordinate((bounds.min.z + bounds.max.z) / 2) };
  const consumed = new Set(instances.filter(instance => instance.parentId && instance.socketId).map(instance => `${instance.parentId}\u0000${instance.socketId}`));
  const sockets: AssetSocket[] = [];
  const surfaces: AssetSurface[] = [];
  for (const instance of instances) for (const socket of instance.model.sockets) {
    if (consumed.has(`${instance.id}\u0000${socket.id}`)) continue;
    const position = transformSpatialPoint(socket.position, instance.position, instance.yaw);
    sockets.push({ id: joinedId(instance.id, socket.id), tags: [...socket.tags], position: { x: spatialCoordinate(position.x - originOffset.x),
      y: spatialCoordinate(instance.position.y + socket.position.y - originOffset.y), z: spatialCoordinate(position.z - originOffset.z) }, yaw: spatialAngle(instance.yaw + (socket.yaw ?? 0)) });
  }
  for (const instance of instances) for (const surface of instance.model.surfaces ?? []) {
    const position = transformSpatialPoint(surface.position, instance.position, instance.yaw);
    surfaces.push({ ...surface, id: joinedId(instance.id, surface.id), partId: joinedId(instance.id, surface.partId), tags: [...surface.tags],
      position: { x: spatialCoordinate(position.x - originOffset.x), y: spatialCoordinate(instance.position.y + surface.position.y - originOffset.y), z: spatialCoordinate(position.z - originOffset.z) },
      yaw: spatialAngle(instance.yaw + (surface.yaw ?? 0)) });
  }
  for (const part of parts) for (const axis of ['x', 'y', 'z'] as const) part.position[axis] = spatialCoordinate(part.position[axis] - originOffset[axis]);
  const hasSurfaces = instances.some(instance => instance.model.surfaces !== undefined);
  const family = defineAssetFamily({ id: options.id, version: options.version, parameters: {}, generate: () => ({ parts, sockets, ...(hasSurfaces ? { surfaces } : {}) }) });
  const model = createAssetCatalog([family], { maxVariants: 1 }).resolve(family.id, { seed: group.seed, instanceId: group.id });
  return freeze({ model, originOffset });
}
