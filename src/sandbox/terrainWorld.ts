import { compileTerrain, sampleTerrain, terrainInspection, terrainPhysicsScene, terrainUsesStreaming,
  type TerrainRecipe, type TerrainManifest, type TerrainAsset, type TerrainRegion, type TerrainRoute, type TerrainPlacement, type TerrainMask } from './terrain.ts';
import { terrainSpawns, terrainClearance, terrainActorSupports, terrainFootSupports,
  type TerrainSpawnOptions, type TerrainSupportPoints } from './terrainQueries.ts';
import type { PhysicsCollider, PhysicsScene, PhysicsVector } from './physics.ts';
import { physicsShapeBounds, physicsShapeVolume } from './physicsGeometry.ts';
import { validateResolvedTerrainChannels } from './terrainChannels.ts';
import type { GameShapes } from '../shared/gameApi.ts';
import { createWireConformer } from '../shared/shapes.ts';
import { TerrainStream, type TerrainChunk, type TerrainInterest, type TerrainPreparation, type TerrainStreamingInspection, type TerrainPreparedChunks } from './terrainStreaming.ts';
export type { TerrainChunk, TerrainInterest, TerrainPreparation, TerrainStreamingInspection } from './terrainStreaming.ts';

/** Additive world edits. Local IDs and local asset references are namespaced by
 * the feature owner; references to existing base assets remain unchanged.
 * Paths and placements reserve their space before any biome is scattered. */
export interface TerrainContribution {
  assets?: TerrainAsset[];
  regions?: TerrainRegion[];
  routes?: TerrainRoute[];
  channels?: TerrainRecipe['channels'];
  placements?: TerrainPlacement[];
  reservations?: TerrainRecipe['reservations'];
}
export interface InstalledTerrainContribution { id: string; priority: number; terrain: TerrainContribution }
export interface TerrainWorldSnapshot {
  readonly version: 1;
  readonly revision: string;
  /** Frozen accepted result shared by collision, rendering and every query. */
  readonly manifest?: TerrainManifest;
  readonly recipe: TerrainRecipe;
  readonly instances: readonly TerrainManifest['instances'][number][];
  readonly chunks: readonly TerrainChunk[];
  readonly loadedRevision: string;
  readonly streaming: TerrainStreamingInspection;
  readonly scene: PhysicsScene;
  readonly contributionCount: number;
  readonly constraints: { surface: 'heightfield' | 'fixed-flat'; height?: number };
  /** True only when every chunk touched by this footprint is collision-ready. */
  available(x: number, z: number, radius?: number): boolean;
  sample(x: number, z: number): ReturnType<typeof sampleTerrain>;
  spawns(options: TerrainSpawnOptions): PhysicsVector[];
  clearance(point: PhysicsVector, radius: number, height: number): boolean;
  footSupports(points: TerrainSupportPoints, timeMs: number): ReturnType<typeof terrainFootSupports>;
  actorSupports(points: TerrainSupportPoints, timeMs: number): ReturnType<typeof terrainActorSupports>;
  inspection(): ReturnType<typeof terrainInspection> & { constraints: TerrainWorldSnapshot['constraints']; contributionCount: number };
  /** Stop on source/seed drift; never draw a different world over server physics. */
  assertRevision(revision: unknown): void;
}
export interface TerrainWorldHost<T> {
  readonly version: 1;
  /** Cheap capability discovery; does not generate terrain or load physics. */
  readonly constraints: TerrainWorldSnapshot['constraints'];
  /** Replaces the complete installed set; removal restores the original recipe. */
  setContributions(contributions: readonly InstalledTerrainContribution[]): void;
  /** Serializable edits belong to authoritative world state, not the disposable chunk cache. */
  setEdits(edits: NonNullable<TerrainRecipe['overrides']>): void;
  /** Project serializable gameplay state into terrain edits without generating. */
  sync(tuning: T, world: unknown): void;
  /** Optional cheap edit-identity query. False schedules bounded synchronization;
   * readiness must never build collision or mutate the accepted world. */
  synchronized?(tuning: T, world: unknown): boolean;
  /** Stable sparse-edit identity, including while a new collision revision is pending. */
  editIdentity?(tuning:T,world:unknown):string;
  /** Engine-owned voxel source cache; never advances gameplay. */
  importCollisionChunk?(tuning:T,chunk:TerrainCollisionChunk,manifest?:TerrainManifest):boolean|void;
  primeCollisionSource?(tuning:T,manifest:TerrainManifest):boolean;
  prepareLocalEdits?(tuning:T,world:unknown,interests:readonly TerrainInterest[]):TerrainPreparation|undefined;
  /** Refresh only collision edits over the existing accepted chunk set. */
  prepareCollisionEdits?(tuning:T):TerrainPreparation|undefined;
  /** This host's view can render while new collision chunks prepare. The
   * runtime advances one preparation unit per frame after initial readiness. */
  backgroundPreparation?: boolean;
  /** Smaller render-worker slice, sharing that frame with mesh work. */
  prepareFrame?(tuning:T,interests?:readonly TerrainInterest[]):TerrainPreparation;
  /** Optional speculative cache warming. One bounded unit, outside gameplay;
   * never changes the accepted scene or makes current collision less ready. */
  prefetch?(tuning:T,interests?:readonly TerrainInterest[]):TerrainPreparation;
  /** The core supplies the final composed world shape before gameplay. Edits
   * see a wire-equivalent copy; the authored world remains untouched. */
  bindWorldShape?(shape: GameShapes['world']): void;
  /** Compose and validate recipe metadata without generating geometry or physics. */
  prepareMetadata?(tuning: T, incremental?: boolean): boolean | void;
  /** Call outside gameplay ticks; at most one new chunk is generated per call. */
  prepare(tuning: T, interests?: readonly TerrainInterest[], includeInitial?: boolean): TerrainPreparation;
  /** Pure readiness query; never composes or generates a recipe. */
  prepared(tuning: T, interests?: readonly TerrainInterest[], includeInitial?: boolean): boolean;
  exportPrepared(tuning: T): TerrainPreparedWorld;
  adoptPrepared(tuning: T, data: TerrainPreparedWorld, verified?: boolean): TerrainPreparation;
  read(tuning: T): TerrainWorldSnapshot;
}
export interface TerrainPreparedWorld {
  version: 1;
  revision: string;
  loadedRevision: string;
  checksum: string;
  /** Collision-only authoritative edit identity; absent for unchanged legacy worlds. */
  collisionRevision?: string;
  /** Complete prepared native scene; avoids recompiling/composing it in prediction. */
  scene: PhysicsScene;
  /** Eager worlds also transfer their one complete manifest, avoiding generation on the page. */
  eager?: TerrainManifest;
  streamed?: TerrainPreparedChunks;
  collisionChunks?:TerrainCollisionChunk[];
}
export interface TerrainCollisionChunk {x:number;z:number;colliders:PhysicsCollider[]}
/** Direct tools/visual fixtures may drain preparation outside a gameplay tick.
 * Runtime workers already prepared for this interest take the constant-work path. */
export function prepareTerrainWorld<T>(host: TerrainWorldHost<T>, tuning: T, interests?: readonly TerrainInterest[], includeInitial = false): TerrainWorldSnapshot {
  if (host.prepared(tuning, interests, includeInitial)) return host.read(tuning);
  for (let call = 0; call < 128; call++) if (host.prepare(tuning, interests, includeInitial).ready) return host.read(tuning);
  throw new Error('Terrain preparation did not complete within its 128-chunk bound.');
}
export interface TerrainWorldOptions<T, W = unknown> {
  collisionChunks?:(tuning:T,chunks:readonly TerrainChunk[])=>TerrainCollisionChunk[];
  /** Voxel source solids always touch their owning chunk. */
  localColliders?:boolean;
  /** Shared authority/view/prediction projection. Undefined is the initial world. */
  edits?: (world: W | undefined, tuning: T) => NonNullable<TerrainRecipe['overrides']>;
  /** Replace original collider descriptors without regenerating terrain. Persist
   * source removals in world state so they also apply after chunk reload. */
  collisionEdits?: (world: W | undefined, tuning: T) => TerrainCollisionEdits;
  /** Streamed providers may bind a prepared collision plan to a compact plain
   * state identity. Sync then stays metadata-only; prepare builds descriptors,
   * and adoption verifies the identity without generating on the page. */
  collisionIdentity?: (world: W | undefined, tuning:T) => string;
  /** Authored off-origin starts to prepare before player state exists. */
  initialInterests?: (tuning: T) => readonly TerrainInterest[];
  /** Existing authored walls/obstacles participate in collision and spawn clearance. */
  colliders?: (tuning: T, manifest: TerrainManifest) => PhysicsCollider[];
  /** Existing interiors/campaigns can preserve their authored floor until a
   * sculpted-world redesign. Unsupported elevation is rejected explicitly. */
  fixedHeight?: number;
  /** Clear space around existing gameplay/furniture before any mod scatters.
   * These conservative route reservations also reject overlapping placements. */
  reservations?: (tuning: T) => TerrainMask[];
  /** Restrict spawn/clearance candidates to the playable side of base walls. */
  contains?: (point: Readonly<PhysicsVector>, radius: number, tuning: T) => boolean;
}
export interface TerrainCollisionEdits {
  /** Original full descriptors, including optional IDs, matched at physics precision. */
  remove?: PhysicsCollider[];
  /** Current attached/settled geometry; moving bodies belong in the physics step. */
  add?: PhysicsCollider[];
}

/** Shared authority/view/prediction interest extraction. Invalid or dead actors
 * do not request geometry; preparation falls back to authored initial interests. */
export function terrainInterestsFor(players: readonly { hp?: number; state?: unknown }[]): TerrainInterest[] {
  const interests: TerrainInterest[] = [];
  for (const player of players) {
    if (player.hp !== undefined && player.hp <= 0 || !record(player.state)) continue;
    const state = player.state, x = state.x, z = state.z;
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) continue;
    const vx = state.velocityX ?? state.vx ?? 0, vz = state.velocityZ ?? state.vz ?? 0;
    interests.push({ x, z, velocity: { x: typeof vx === 'number' && Number.isFinite(vx) ? vx : 0,
      z: typeof vz === 'number' && Number.isFinite(vz) ? vz : 0 } });
    if (interests.length > 32) throw new Error('Terrain interest supports at most 32 active players.');
  }
  return interests;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function plain<T>(value: T, budget = { left: 150000 }, depth = 0): T {
  if (--budget.left < 0 || depth > 32) throw new Error('Terrain world data exceeds its bounded plain-data budget.');
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Terrain world requires finite data.'); return value; }
  if (Array.isArray(value)) return value.map(item => plain(item, budget, depth + 1)) as T;
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Terrain world requires plain data.');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item, budget, depth + 1)])) as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : record(value) ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
export function terrainContributionId(owner: string, local: string): string {
  if (typeof local !== 'string' || !local.length || local.length > 96) throw new Error('Terrain contribution IDs must contain 1..96 characters.');
  return `mod:${encodeURIComponent(owner)}:${encodeURIComponent(local)}`;
}
function fingerprint(value: string): string {
  let a = 2166136261, b = 0x7f4a7c15;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 16777619); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

// Hash immutable subtrees once. A shallow freeze alone is not enough: cache a
// parent only when every descendant is immutable too. Mutable inputs are always
// re-read. The version prefix keeps archived whole-document checksums readable.
const treeFingerprints=new WeakMap<object,string>();
function treeFingerprint(value:unknown):{hash:string;immutable:boolean}{
  if(!value||typeof value!=='object')return{hash:'scalar:'+(canonical(value)??'undefined'),immutable:true};
  const cached=treeFingerprints.get(value);if(cached)return{hash:cached,immutable:true};
  let immutable=Object.isFrozen(value);
  for(const key of Object.keys(value))if(!('value' in Object.getOwnPropertyDescriptor(value,key)!))immutable=false;
  const child=(item:unknown)=>{const result=treeFingerprint(item);immutable=immutable&&result.immutable;return result.hash.length+':'+result.hash;};
  const text=Array.isArray(value)?'array:'+value.map(child).join(',')
    :'object:'+Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined)
      .map(key=>key.length+':'+key+':'+child((value as Record<string,unknown>)[key])).join(',');
  const hash=fingerprint(text);if(immutable)treeFingerprints.set(value,hash);return{hash,immutable};
}
function geometryChecksum(value:unknown):string{return 'tree-v1-'+treeFingerprint(value).hash;}

/** Host-side validation before the small sandbox adoption call. This function
 * is pure data validation and exposes no host capability to game code. */
export function validateTerrainPreparedWorld(data: unknown): TerrainPreparedWorld {
  const copy = plain(data, { left: 2000000 }) as TerrainPreparedWorld;
  if (!copy || copy.version !== 1 || typeof copy.revision !== 'string' || copy.revision.length > 256
    || typeof copy.loadedRevision !== 'string' || copy.loadedRevision.length > 256 || typeof copy.checksum !== 'string'
    || !!copy.eager === !!copy.streamed || !copy.scene || !Array.isArray(copy.scene.colliders) || copy.scene.colliders.length > 12288)
    throw new Error('Prepared terrain transfer is malformed or exceeds its bounded envelope.');
  const manifests = copy.streamed ? copy.streamed.chunks?.map(chunk => chunk.manifest) : [copy.eager!];
  if (!Array.isArray(manifests) || !manifests.length || manifests.length > 128) throw new Error('Prepared terrain chunk count exceeds its bound.');
  for (const manifest of manifests) if (!manifest || !manifest.diagnostics?.valid || !Number.isInteger(manifest.rows) || manifest.rows < 1 || manifest.rows > 32
    || !Number.isInteger(manifest.columns) || manifest.columns < 1 || manifest.columns > 32
    || !Array.isArray(manifest.heights) || manifest.heights.length !== (manifest.rows + 1) * (manifest.columns + 1)
    || manifest.heights.some((height: number) => !Number.isFinite(height) || Math.abs(height) > 10000)
    || !Array.isArray(manifest.colors) || manifest.colors.length !== manifest.heights.length
    || manifest.colors.some((color: number) => !Number.isInteger(color) || color < 0 || color > 0xffffff)
    || !Array.isArray(manifest.instances) || manifest.instances.length > 4096 || !Array.isArray(manifest.colliders) || manifest.colliders.length > 96)
    throw new Error('Prepared terrain geometry exceeds its bounded sample/instance envelope.');
  for (const manifest of manifests) if (manifest.channels !== undefined) validateResolvedTerrainChannels(manifest.channels);
  if (copy.collisionRevision !== undefined && (typeof copy.collisionRevision !== 'string' || !/^[0-9a-f]{16}$/.test(copy.collisionRevision)))
    throw new Error('Prepared terrain collision edit revision is malformed.');
  const geometry = { ...(copy.streamed ? { streamed: copy.streamed, scene: copy.scene } : { eager: copy.eager, scene: copy.scene }),
    ...(copy.collisionRevision === undefined ? {} : { collisionRevision: copy.collisionRevision }),
    ...(copy.collisionChunks===undefined?{}:{collisionChunks:copy.collisionChunks}) };
  if(copy.collisionChunks!==undefined){
    if(!copy.streamed||!Array.isArray(copy.collisionChunks)||copy.collisionChunks.length!==copy.streamed.chunks.length)throw new Error('Prepared collision source chunks differ from active chunks.');
    let count=0;const keys=new Set(copy.streamed.chunks.map(c=>`${c.x}:${c.z}`));
    for(const chunk of copy.collisionChunks){
      if(!chunk||!Number.isSafeInteger(chunk.x)||!Number.isSafeInteger(chunk.z)||!keys.delete(`${chunk.x}:${chunk.z}`)||!Array.isArray(chunk.colliders))throw new Error('Invalid prepared collision source chunk.');
      count+=chunk.colliders.length;if(count>12800)throw new Error('Prepared collision source exceeds its bound.');
      for(const c of chunk.colliders)if(!c||c.shape?.kind!=='box'||typeof c.id!=='string'||c.id.length>128
        ||![c.position?.x,c.position?.y,c.position?.z,c.shape.halfExtents?.x,c.shape.halfExtents?.y,c.shape.halfExtents?.z].every(v=>typeof v==='number'&&Number.isFinite(v)))throw new Error('Invalid prepared voxel solid.');
    }
  }
  const expected=copy.checksum.startsWith('tree-v1-')?geometryChecksum(geometry):fingerprint(canonical(geometry));
  if (copy.checksum !== expected) throw new Error('Prepared terrain geometry checksum differs.');
  return copy;
}
/** Engine libm implementations can differ by a last bit in sin/cos. Accept one
 * plain-data physics precision before hashing AND simulation; this is far finer
 * than Rapier's Float32 coordinates and preserves minimum dimensions like .02. */
function physicsPrecision<T>(value: T): T {
  if (typeof value === 'number') return (Math.round(value * 1e9) / 1e9) as T;
  if (Array.isArray(value)) return value.map(physicsPrecision) as T;
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, physicsPrecision(item)])) as T;
  return value;
}
const immutableCollisionInputs=new WeakSet<object>();
function deeplyImmutable(value:unknown):boolean{
  if(!value||typeof value!=='object')return true;
  if(immutableCollisionInputs.has(value))return true;
  if(!Object.isFrozen(value))return false;
  for(const key of Object.keys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if(!('value' in descriptor)||!deeplyImmutable(descriptor.value))return false;
  }
  immutableCollisionInputs.add(value);return true;
}
const collisionCopies=new WeakMap<object,{copy:PhysicsCollider;nodes:number}>();
const collisionSortKeys=new WeakMap<PhysicsCollider,string>();
function collisionSortKey(collider:PhysicsCollider):string{
  let key=collisionSortKeys.get(collider);if(key===undefined){key=canonical(collider);collisionSortKeys.set(collider,key);}return key;
}
function snapshotCollisionEdits(value: TerrainCollisionEdits): TerrainCollisionEdits {
  const object = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => record(value)
    && Object.keys(value).every(key => keys.includes(key));
  const numeric = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  const vector = (value: unknown, min: number, max: number) => object(value, ['x', 'y', 'z'])
    && ['x', 'y', 'z'].every(axis => numeric(value[axis], min, max));
  if (!object(value, ['remove', 'add'])||![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error('Terrain collision edits require remove/add arrays.');
  const copy:TerrainCollisionEdits={},budget={left:149999};
  for (const name of ['remove', 'add'] as const) {
    const source = value[name];
    if (source === undefined) continue;
    if (!Array.isArray(source) || source.length > 512) throw new Error('Terrain collision edits support at most 512 removals and 512 additions.');
    budget.left--;const list:PhysicsCollider[]=[];copy[name]=list;
    for (const input of source) {
      const cached=input&&typeof input==='object'?collisionCopies.get(input):undefined;
      if(cached){budget.left-=cached.nodes;if(budget.left<0)throw new Error('Terrain world data exceeds its bounded plain-data budget.');list.push(cached.copy);continue;}
      const before=budget.left,collider=physicsPrecision(plain(input,budget,2));
      if (!object(collider, ['id', 'shape', 'position', 'rotation', 'friction', 'restitution', 'waterBoundary']) || !vector(collider.position, -10000, 10000)
        || collider.id !== undefined && (typeof collider.id !== 'string' || !collider.id.length || collider.id.length > 128)
        || collider.friction !== undefined && !numeric(collider.friction, 0, 2)
        || collider.waterBoundary !== undefined && collider.waterBoundary !== false
        || collider.restitution !== undefined && !numeric(collider.restitution, 0, 1)) throw new Error('Invalid terrain collision edit collider.');
      const rotation = collider.rotation;
      if (rotation !== undefined && (!object(rotation, ['x', 'y', 'z', 'w']) || !['x', 'y', 'z', 'w'].every(axis => numeric(rotation[axis], -1.001, 1.001))
        || Math.abs(Math.hypot(rotation.x as number, rotation.y as number, rotation.z as number, rotation.w as number) - 1) >= .001))
        throw new Error('Terrain collision edit rotation must be a unit quaternion.');
      const shape = collider.shape;
      if (!record(shape) || !(shape.kind === 'box' && object(shape, ['kind', 'halfExtents']) && vector(shape.halfExtents, .02, 1000)
        || shape.kind === 'ball' && object(shape, ['kind', 'radius']) && numeric(shape.radius, .02, 1000)
        || shape.kind === 'capsule' && object(shape, ['kind', 'radius', 'halfHeight']) && numeric(shape.radius, .02, 1000) && numeric(shape.halfHeight, 0, 1000)
        || shape.kind === 'convex' && object(shape, ['kind', 'vertices']) && Array.isArray(shape.vertices) && shape.vertices.length >= 4 && shape.vertices.length <= 64
          && shape.vertices.every(point => vector(point, -1000, 1000))))
        throw new Error('Invalid terrain collision edit shape.');
      if (shape.kind === 'convex') physicsShapeVolume(shape as unknown as PhysicsCollider['shape']);
      const accepted=freeze(collider) as unknown as PhysicsCollider;list.push(accepted);
      if(deeplyImmutable(input))collisionCopies.set(input,{copy:accepted,nodes:before-budget.left});
    }
    list.sort((a, b) => { const left = collisionSortKey(a), right = collisionSortKey(b); return left < right ? -1 : left > right ? 1 : 0; });
  }
  const validated = copy as TerrainCollisionEdits;
  return { ...(validated.remove?.length ? { remove: validated.remove } : {}), ...(validated.add?.length ? { add: validated.add } : {}) };
}

/** Copy the shared bounded plain-data contribution envelope. Asset references,
 * slopes and geometry are validated against the complete composed recipe. */
export function snapshotTerrainContribution(input: TerrainContribution): TerrainContribution {
  const extra = plain(input);
  if (!record(extra)) throw new Error('Terrain contribution requires a plain object.');
  for (const key of Object.keys(extra)) if (!['assets', 'regions', 'routes', 'channels', 'placements', 'reservations'].includes(key)) throw new Error(`Unknown terrain contribution field ${key}.`);
  for (const list of Object.values(extra)) if (!Array.isArray(list) || list.length > 256) throw new Error('Terrain contribution lists must contain at most 256 entries.');
  return extra;
}

/** One deterministic composition, independent of installation enumeration order. */
export function composeTerrainRecipe(base: TerrainRecipe, contributions: readonly InstalledTerrainContribution[]): TerrainRecipe {
  const recipe = plain(base), owners = new Set<string>();
  if (contributions.length > 64) throw new Error('Terrain world supports at most 64 contributions.');
  for (const entry of [...contributions].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry.id)
      || owners.has(entry.id) || !Number.isSafeInteger(entry.priority) || !record(entry.terrain)) throw new Error('Invalid or duplicate terrain contribution owner.');
    owners.add(entry.id);
    const extra = snapshotTerrainContribution(entry.terrain), id = (local: string) => terrainContributionId(entry.id, local);
    const localAssets = new Set((extra.assets ?? []).map(asset => asset.id));
    const assetId = (local: string) => localAssets.has(local) ? id(local) : local;
    const localRoutes = new Set((extra.routes ?? []).map(route => route.id));
    const routeId = (local: string) => localRoutes.has(local) ? id(local) : local;
    const facing = (value: TerrainPlacement['facing']) => value && 'route' in value ? { ...value, route: routeId(value.route) } : value;
    recipe.assets.push(...(extra.assets ?? []).map(asset => ({ ...asset, id: id(asset.id) })));
    recipe.regions.push(...(extra.regions ?? []).map(region => ({ ...region, id: id(region.id), layers: region.layers.map(layer => ({ ...layer,
      id: id(layer.id), assets: layer.assets.map(assetId), ...(layer.facing ? { facing: facing(layer.facing) } : {}),
      ...(layer.preferences ? { preferences: layer.preferences.map(preference => ({ ...preference,
        target: 'route' in preference.target ? { ...preference.target, route: routeId(preference.target.route) } : preference.target })) } : {}) })) })));
    recipe.routes = [...recipe.routes ?? [], ...(extra.routes ?? []).map(route => ({ ...route, id: id(route.id) }))];
    if (extra.channels) recipe.channels = [...recipe.channels ?? [], ...extra.channels.map(channel => ({ ...channel, id: id(channel.id) }))];
    recipe.placements = [...recipe.placements ?? [], ...(extra.placements ?? []).map(placement => ({ ...placement, id: id(placement.id), asset: assetId(placement.asset),
      ...(placement.facing ? { facing: facing(placement.facing) } : {}),
      ...(placement.foundationGroup ? { foundationGroup: id(placement.foundationGroup) } : {}),
      entrances: placement.entrances?.map(entrance => ({ ...entrance, id: id(entrance.id) })) }))];
    if (extra.reservations) recipe.reservations = [...recipe.reservations ?? [], ...extra.reservations.map(reservation => ({ ...reservation, id: id(reservation.id) }))];
  }
  return recipe;
}

/** Shared base-world adapter. Put this in the game's editable world.ts and use
 * the prepared snapshot.scene for authority/prediction, the complete snapshot
 * for TerrainWorldView, and its query methods for spawns/animation. Expose it as
 * logic/view.terrainWorld.
 * Contributions are static per installed mod set, not unsynchronised live edits.
 * Invalid generations throw and never replace the previously accepted snapshot. */
export function createTerrainWorld<T, W = unknown>(recipeFor: (tuning: T) => TerrainRecipe, options: TerrainWorldOptions<T, W> = {}): TerrainWorldHost<T> {
  let boundWorldShape: GameShapes['world'];
  let wireWorld: ((world: unknown) => unknown) | undefined;
  // Ordinary tuning is flat numeric data. Compare its complete current value
  // before reusing serialization; callers may mutate or replace the object.
  // Generic authored tuning retains the original canonicalization semantics.
  let tuningMemo: { values: Record<string, number>; count: number; key: string } | undefined;
  const tuningKey = (tuning: T): string => {
    if (!record(tuning)) return canonical(tuning);
    const prototype = Object.getPrototypeOf(tuning);
    if (prototype !== Object.prototype && prototype !== null) return canonical(tuning);
    const keys = Object.keys(tuning);
    if (keys.length > 128) return canonical(tuning);
    let same = tuningMemo?.count === keys.length;
    for (const name of keys) {
      const property = Object.getOwnPropertyDescriptor(tuning, name);
      // Inspect descriptors so checking eligibility never invokes a getter
      // before the fallback serializer would have invoked it.
      if (!property || !('value' in property) || typeof property.value !== 'number' || !Number.isFinite(property.value)) return canonical(tuning);
      const value = tuning[name];
      if (typeof value !== 'number' || !Number.isFinite(value)) return canonical(tuning);
      if (same && (!Object.hasOwn(tuningMemo!.values, name) || tuningMemo!.values[name] !== value)) same = false;
    }
    if (same) return tuningMemo!.key;
    const key = canonical(tuning), values: Record<string, number> = Object.create(null);
    for (const name of keys) values[name] = tuning[name] as number;
    tuningMemo = { values, count: keys.length, key };
    return key;
  };
  let installed: readonly InstalledTerrainContribution[] = [], supplied: readonly InstalledTerrainContribution[] | undefined;
  let contributionKey = '', key = '', snapshot: TerrainWorldSnapshot | undefined;
  let edits: NonNullable<TerrainRecipe['overrides']> = {}, editKey = '', recipeKey = '', preparedRecipe: TerrainRecipe | undefined;
  let collisionEdits: TerrainCollisionEdits = {}, collisionKey = '', acceptedCollisionKey = '';
  let collisionRevision: string | undefined;
  let pendingCollision:{world:W|undefined;tuning:T}|undefined;
  let removedColliders = new Set<string>();
  const colliderKeys=new WeakMap<PhysicsCollider,string>();
  const colliderKey=(collider:PhysicsCollider)=>{
    if(!Object.isFrozen(collider))return canonical(collider);
    let cached=colliderKeys.get(collider);if(cached===undefined){cached=canonical(collider);colliderKeys.set(collider,cached);}return cached;
  };
  const chunkExtras=new WeakMap<TerrainManifest,{tuning:string;entries:[string,PhysicsCollider][]}>();
  const retainedExtras=new Map<string,{tuning:string;entries:[string,PhysicsCollider][]}>();
  const extraKey=(tuning:T,manifest:TerrainManifest)=>JSON.stringify([tuningKey(tuning),manifest.revision,manifest.origin?.x,manifest.origin?.z]);
  const prepareExtras=(tuning:T,manifest:TerrainManifest)=>{
    const colliders=freeze(physicsPrecision(plain(options.colliders?.(tuning,manifest)??[])));
    for(const collider of colliders)treeFingerprint(collider);
    const cached={tuning:tuningKey(tuning),entries:colliders.map(collider=>[colliderKey(collider),collider] as [string,PhysicsCollider])};
    if(retainedExtras.size>=256)retainedExtras.delete(retainedExtras.keys().next().value!);
    retainedExtras.set(extraKey(tuning,manifest),cached);chunkExtras.set(manifest,cached);return cached;
  };
  let extraWork:{key:string;tuning:string;source:PhysicsCollider[];entries:[string,PhysicsCollider][];offset:number}|undefined;
  let sourceGeometry:{chunks:readonly TerrainChunk[];tuning:string;extra:PhysicsCollider[];colliders:PhysicsCollider[];hash:string;terrainChunks?:PhysicsScene['terrainChunks']}|undefined;
  let stream: TerrainStream | undefined;
  // Preserve the last accepted cache solely as a reuse source. Pending reads
  // expose the new metadata with no active geometry until prepare completes;
  // runtime scene installation keeps its prior accepted collision meanwhile.
  let retainedStream: TerrainStream | undefined;
  let snapshotStreamInspection: TerrainStreamingInspection | undefined;
  const constraints = Object.freeze(options.fixedHeight === undefined ? { surface: 'heightfield' as const } : { surface: 'fixed-flat' as const, height: options.fixedHeight });
  let adoptedEager: TerrainManifest | undefined;
  let eagerSourceRevision = '';
  let eagerGeometry: { recipe: TerrainRecipe; manifest: TerrainManifest; extra?: PhysicsCollider[]; terrain?: PhysicsScene['terrain'] } | undefined;
  let metadataWork: { key: string; recipe: TerrainRecipe; work: Generator<void, TerrainStream> } | undefined;
  const composeRecipeForTuning = (tuning: T) => {
    const recipe = composeTerrainRecipe(recipeFor(tuning), installed);
    if(options.collisionIdentity&&!terrainUsesStreaming(recipe))throw new Error('Prepared collision identities require streamed terrain.');
    recipe.overrides = { ...(recipe.overrides ?? {}),
      ...(edits.remove ? { remove: [...new Set([...(recipe.overrides?.remove ?? []), ...edits.remove])].sort() } : {}),
      ...(edits.pin ? { pin: [...(recipe.overrides?.pin ?? []), ...edits.pin] } : {}) };
    if (!Object.keys(recipe.overrides).length) delete recipe.overrides;
    const reservations = options.reservations?.(tuning) ?? [];
    recipe.routes = [...recipe.routes ?? [], ...reservations.map((mask, index) => {
      const depth = mask.kind === 'circle' ? .01 : Math.max(.01, Math.abs(mask.depth - mask.width));
      const width = mask.kind === 'circle' ? mask.radius * 2 : Math.min(mask.width, mask.depth) * Math.SQRT2;
      const yaw = (mask.yaw ?? 0) + (mask.kind === 'box' && mask.width > mask.depth ? Math.PI / 2 : 0);
      return { id: `base-reservation-${index}`, width, points: [-1, 1].map(side => ({
        x: mask.center.x + side * Math.sin(yaw) * depth / 2, z: mask.center.z + side * Math.cos(yaw) * depth / 2,
      })) };
    })];
    return recipe;
  };
  const recipeForTuning = (tuning: T, next = tuningKey(tuning)) => {
    if (preparedRecipe && recipeKey === next) return preparedRecipe;
    const recipe = composeRecipeForTuning(tuning);
    acceptStream(terrainUsesStreaming(recipe) ? new TerrainStream(recipe) : undefined);
    metadataWork = undefined;
    preparedRecipe = recipe; recipeKey = next; return recipe;
  };
  const acceptStream = (next: TerrainStream | undefined) => {
    if (next && retainedStream) {
      if (next.revision === retainedStream.revision) next = retainedStream;
      else next.reusePrepared(retainedStream);
    }
    stream = next;
  };
  const invalidate = () => { key = ''; recipeKey = ''; preparedRecipe = undefined; stream = undefined; adoptedEager = undefined; eagerGeometry = undefined; metadataWork = undefined; };
  const installCollisionEdits=(copy:TerrainCollisionEdits)=>{
    collisionEdits=freeze(copy);removedColliders=new Set((copy.remove??[]).map(colliderKey));key='';
  };
  const acceptCollisionEdits = (copy: TerrainCollisionEdits) => {
    const next = Object.keys(copy).length ? canonical(copy) : '';
    if (next === collisionKey) return;
    installCollisionEdits(copy); collisionKey = next; collisionRevision = next ? fingerprint(next) : undefined;
    // Retain recipe, stream/chunks and eager source geometry. Only the accepted
    // collision/query snapshot becomes stale; old snapshots remain immutable.
    key = '';
  };
  const editColliders = (source: PhysicsCollider[], streamed: boolean, contains?: (collider: PhysicsCollider) => boolean) => {
    const colliders = [...source.filter(collider => !removedColliders.has(colliderKey(collider))),
      ...(collisionEdits.add ?? []).filter(collider => !contains || contains(collider))];
    if (colliders.length > (streamed ? 12288 : 96)) throw new Error(`Terrain collision edits exceed the ${streamed ? 12288 : 96}-collider physics budget.`);
    const ids = new Set<string>();
    for (const collider of colliders) if (collider.id !== undefined) {
      if (ids.has(collider.id)) throw new Error('Terrain collision edits produce duplicate static collider IDs.');
      ids.add(collider.id);
    }
    return colliders;
  };
  const streamRevision = (source: string, tuning: T) => `world-stream-v1-${fingerprint(canonical(collisionRevision === undefined
    ? [source, tuning] : [source, tuning, collisionRevision]))}`;

  const streamedSnapshot = (tuning: T, transferred?: TerrainPreparedWorld): TerrainWorldSnapshot => {
    const acceptedStream = stream!, recipe = acceptedStream.recipe, chunks = acceptedStream.chunks;
    const revision = streamRevision(acceptedStream.revision, tuning);
    const instances = chunks.flatMap(chunk => chunk.manifest.instances).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const colliderMap = new Map<string, PhysicsCollider>();
    const touchesLoaded = (collider: PhysicsCollider) => {
      if (collider.shape.kind === 'convex') {
        const { min, max } = physicsShapeBounds(collider.shape, collider.rotation);
        return chunks.some(({ manifest }) => collider.position.x + max.x >= manifest.origin!.x - manifest.bounds.width / 2
          && collider.position.x + min.x <= manifest.origin!.x + manifest.bounds.width / 2
          && collider.position.z + max.z >= manifest.origin!.z - manifest.bounds.depth / 2
          && collider.position.z + min.z <= manifest.origin!.z + manifest.bounds.depth / 2);
      }
      const shape = collider.shape, radius = shape.kind === 'box' ? Math.hypot(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z)
        : shape.kind === 'ball' ? shape.radius : shape.radius + shape.halfHeight;
      return chunks.some(({ manifest }) => Math.abs(collider.position.x - manifest.origin!.x) <= manifest.bounds.width / 2 + radius
        && Math.abs(collider.position.z - manifest.origin!.z) <= manifest.bounds.depth / 2 + radius);
    };
    if(transferred&&options.localColliders&&chunks.every(c=>retainedExtras.has(extraKey(tuning,c.manifest)))){
      const accepted=new Map(transferred.scene.colliders.map(c=>[c.id,c]));
      for(const chunk of chunks)for(const [id,c] of retainedExtras.get(extraKey(tuning,chunk.manifest))!.entries){
        const retained=accepted.get(c.id)??c;colliderKeys.set(retained,id);colliderMap.set(id,retained);
      }
      const extra=[...colliderMap.values()],hash=transferred.loadedRevision.slice(transferred.loadedRevision.lastIndexOf(':')+1);
      sourceGeometry={chunks,tuning:tuningKey(tuning),extra,colliders:[...chunks.flatMap(c=>c.manifest.colliders),...extra],hash,terrainChunks:transferred.scene.terrainChunks};
    }
    const cachedSource=sourceGeometry?.chunks===chunks&&sourceGeometry.tuning===tuningKey(tuning)?sourceGeometry:undefined;
    if (!transferred&&!cachedSource) for (const chunk of chunks) {
      if (options.fixedHeight !== undefined && (!Number.isFinite(options.fixedHeight) || chunk.manifest.heights.some(height => Math.abs(height - options.fixedHeight!) > 1e-5)))
        throw new Error(`This base preserves a fixed flat surface at ${options.fixedHeight}m; elevation-changing terrain needs a heightfield-capable base.`);
      const identity=tuningKey(tuning);let cached=chunkExtras.get(chunk.manifest)??retainedExtras.get(extraKey(tuning,chunk.manifest));
      if(!cached||cached.tuning!==identity){
        cached=prepareExtras(tuning,chunk.manifest);
      }
      for(const [identity,collider] of cached.entries)if(options.localColliders||touchesLoaded(collider))colliderMap.set(identity,collider);
    }
    const extra = cachedSource?.extra??[...colliderMap.values()], sourceColliders = cachedSource?.colliders??[...chunks.flatMap(chunk => chunk.manifest.colliders), ...extra];
    const sourceHash=cachedSource?.hash??treeFingerprint([chunks.map(chunk => [chunk.id, chunk.manifest.revision]), extra]).hash;
    if(!transferred&&!cachedSource)sourceGeometry={chunks,tuning:tuningKey(tuning),extra,colliders:sourceColliders,hash:sourceHash};
    const colliders = transferred?.scene.colliders ?? (options.collisionEdits ? editColliders(sourceColliders, true, touchesLoaded) : sourceColliders);
    const scene: PhysicsScene = transferred?.scene ?? { colliders, terrainChunks: cachedSource?.terrainChunks??chunks.map(({ id, manifest }) => ({ id,
      rows: manifest.rows, columns: manifest.columns, heights: manifest.heights, width: manifest.bounds.width, depth: manifest.bounds.depth,
      position: { x: manifest.origin!.x, y: 0, z: manifest.origin!.z } })) };
    const find = (x: number, z: number) => chunks.find(({ manifest }) => Math.abs(x - manifest.origin!.x) <= manifest.bounds.width / 2
      && Math.abs(z - manifest.origin!.z) <= manifest.bounds.depth / 2)?.manifest;
    // Movement checks each touched coordinate for every actor. Index the
    // immutable snapshot once instead of scanning all resident chunks per cell.
    const chunkCoordinates = new Set(chunks.map(chunk => `${chunk.x}:${chunk.z}`));
    const available = (x: number, z: number, radius = 0) => {
      if (![x, z, radius].every(Number.isFinite) || radius < 0 || Math.abs(x) + radius > recipe.bounds.width / 2 || Math.abs(z) + radius > recipe.bounds.depth / 2) return false;
      const size = acceptedStream.chunkSize;
      const reach = radius + acceptedStream.colliderReach;
      const minX = Math.floor(Math.max(-recipe.bounds.width / 2, x - reach) / size), maxX = Math.ceil(Math.min(recipe.bounds.width / 2, x + reach) / size) - 1;
      const minZ = Math.floor(Math.max(-recipe.bounds.depth / 2, z - reach) / size), maxZ = Math.ceil(Math.min(recipe.bounds.depth / 2, z + reach) / size) - 1;
      if (!reach) return !!find(x, z);
      for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) if (!chunkCoordinates.has(`${cx}:${cz}`)) return false;
      return true;
    };
    const sample = (x: number, z: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('Terrain sample coordinates must be finite');
      const manifest = find(x, z);
      if (!manifest) throw new Error(`Terrain at ${x},${z} is not loaded; prepare its collision interest before querying or moving.`);
      return sampleTerrain(manifest, x, z);
    };
    const acceptedTuning = freeze(plain(tuning));
    const clearance = (point: PhysicsVector, radius: number, height: number) => {
      const manifest = find(point.x, point.z);
      if (!manifest || !available(point.x, point.z, radius) || !(options.contains?.(point, radius, acceptedTuning) ?? true)) return false;
      // Clearance tests the union's colliders; synthetic bounds only remove the
      // local-window boundary check, which available() already checked exactly.
      return terrainClearance({ ...manifest, origin: undefined, bounds: recipe.bounds, colliders }, point, radius, height);
    };
    const footSupports = (points: TerrainSupportPoints, timeMs: number) => {
      if (!Number.isFinite(timeMs) || Math.abs(timeMs) > Number.MAX_SAFE_INTEGER || Object.entries(points).length > 32
        || Object.entries(points).some(([id, point]) => !id.length || id.length > 96 || !point || !Number.isFinite(point.x) || !Number.isFinite(point.z)))
        throw new Error('Terrain support requires a finite timeMs and at most 32 named finite XZ query points.');
      const result: ReturnType<typeof terrainFootSupports> = {};
      for (const [id, point] of Object.entries(points)) {
        const manifest = find(point.x, point.z);
        if (manifest) Object.assign(result, terrainFootSupports(manifest, { [id]: point }, timeMs));
      }
      return result;
    };
    const spawns = (spawn: TerrainSpawnOptions) => {
      if (!chunks.length) throw new Error('Terrain spawn capacity: prepare spawn interest before placing players.');
      return terrainSpawns(chunks[0].manifest, spawn, { regions: chunks.map(chunk => chunk.manifest), clearance,
        sample: (x, z) => { const manifest = find(x, z); return manifest ? sampleTerrain(manifest, x, z) : undefined; } });
    };
    const loadedRevision = transferred?.loadedRevision ?? `${revision}:${sourceHash}`;
    const rawStreaming = acceptedStream.inspection();
    const streaming = Object.freeze({ ...rawStreaming, revision, loadedRevision });
    // Comparing transferred instances is useful to inspection, but unrelated
    // to adopting collision. Capture this snapshot's immutable baseline now;
    // perform and memoize the comparison only when its report is requested.
    const previousSnapshotInstances = snapshot?.instances;
    let instanceChanges: { added: number; removed: number; updated: number; unchanged: number } | undefined;
    const inspectInstanceChanges = () => {
      if (!instanceChanges) {
        const previousInstances = new Map(previousSnapshotInstances?.map(instance => [instance.id, instance]) ?? []);
        let added = 0, updated = 0, unchanged = 0;
        for (const instance of instances) {
          const previous = previousInstances.get(instance.id);
          if (!previous) added++; else if (previous === instance || canonical(previous) === canonical(instance)) unchanged++; else updated++;
          previousInstances.delete(instance.id);
        }
        instanceChanges = { added, removed: previousInstances.size, updated, unchanged };
      }
      // Reports remain independently mutable without changing cached evidence.
      return { ...instanceChanges };
    };
    const reasons = new Map<string, number>();
    for (const chunk of chunks) for (const [reason, count] of Object.entries(chunk.manifest.diagnostics.excludedBy)) reasons.set(reason, (reasons.get(reason) ?? 0) + count);
    const reasonEntries = [...reasons.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    // Global recipe warnings can recur unchanged in every loaded chunk. Keep
    // their evidence once with all contributing chunks, rather than allowing
    // duplicates to crowd distinct issues and actor diagnostics out of captures.
    const groupedIssues = new Map<string, TerrainManifest['diagnostics']['issues'][number] & { chunks: string[] }>();
    let issueOccurrenceCount = 0;
    for (const chunk of chunks) for (const issue of chunk.manifest.diagnostics.issues) {
      issueOccurrenceCount++;
      const identity = canonical(issue), existing = groupedIssues.get(identity);
      if (existing) { if (!existing.chunks.includes(chunk.id)) existing.chunks.push(chunk.id); }
      else groupedIssues.set(identity, { ...issue, chunks: [chunk.id] });
    }
    const issues = [...groupedIssues.values()];
    const surfaceChanged = snapshot?.loadedRevision !== loadedRevision;
    const inspection = () => ({ version: 'terrain-v1' as const, revision, valid: true,
      counts: { candidates: chunks.reduce((n, chunk) => n + chunk.manifest.diagnostics.counts.candidates, 0), instances: instances.length,
        colliders: colliders.length, excluded: chunks.reduce((n, chunk) => n + chunk.manifest.diagnostics.counts.excluded, 0) },
      excludedBy: Object.fromEntries(reasonEntries.slice(0, 16)), excludedReasonCount: reasons.size,
      truncated: reasons.size > 16 || issues.length > 12, sampling: { cellWidth: acceptedStream.chunkSize / acceptedStream.cells, cellDepth: acceptedStream.chunkSize / acceptedStream.cells,
        surface: 'heightfield-y-up' as const, navigation: 'unsupported' as const }, issues: issues.slice(0, 12), issueCount: issues.length, issueOccurrenceCount,
      changes: { ...inspectInstanceChanges(), surfaceChanged }, constraints, contributionCount: installed.length, streaming });
    freeze(chunks); freeze(scene); freeze(recipe); freeze(instances);
    const accepted: TerrainWorldSnapshot = Object.freeze({ version: 1, revision, recipe, instances, chunks, loadedRevision, streaming, scene, constraints, contributionCount: installed.length,
      available, sample, clearance, spawns, footSupports,
      actorSupports: (points: TerrainSupportPoints, timeMs: number) => Object.fromEntries(Object.entries(footSupports(points, timeMs)).map(([id, support]) => [id,
        { position: support.point, normal: support.normal, observedAtMs: support.observedAtMs }])), inspection,
      assertRevision: (value: unknown) => { if (value !== revision) throw new Error(`Terrain world revision differs from authoritative physics: view ${revision}, authority ${String(value).slice(0, 96)}.`); } });
    snapshotStreamInspection = rawStreaming;
    acceptedCollisionKey = collisionKey;
    return accepted;
  };
  return {
    version: 1, constraints,
    primeCollisionSource(tuning,manifest){
      const key=extraKey(tuning,manifest);if(retainedExtras.has(key))return true;
      if(extraWork?.key!==key)extraWork={key,tuning:tuningKey(tuning),source:options.colliders?.(tuning,manifest)??[],entries:[],offset:0};
      const work=extraWork,end=Math.min(work.offset+32,work.source.length);
      for(;work.offset<end;work.offset++){
        const c=freeze(physicsPrecision(plain(work.source[work.offset])));treeFingerprint(c);work.entries.push([colliderKey(c),c]);
      }
      if(work.offset<work.source.length)return false;
      if(retainedExtras.size>=256)retainedExtras.delete(retainedExtras.keys().next().value!);
      retainedExtras.set(key,{tuning:work.tuning,entries:work.entries});extraWork=undefined;return true;
    },
    setContributions(contributions) {
      if (contributions === supplied) return;
      const copy = plain(contributions), next = canonical(copy);
      // Validate now without compiling an unrelated/default recipe.
      composeTerrainRecipe({ version: 1, seed: 0, bounds: { width: 10, depth: 10 }, assets: [], regions: [] }, copy);
      supplied = contributions;
      if (next !== contributionKey) { installed = freeze(copy); contributionKey = next; invalidate(); }
    },
    setEdits(value) {
      const copy = plain(value);
      if (!record(copy) || Object.keys(copy).some(key => key !== 'remove' && key !== 'pin')
        || copy.remove && (!Array.isArray(copy.remove) || copy.remove.length > 16384 || copy.remove.some(id => typeof id !== 'string' || id.length > 512))
        || copy.pin && (!Array.isArray(copy.pin) || copy.pin.length > 96)) throw new Error('Terrain edits require at most16384 removed IDs and96 pinned placements.');
      const next = canonical(copy);
      if (next !== editKey) { edits = freeze(copy); editKey = next; invalidate(); }
    },
    sync(tuning, world) {
      if (!options.edits && !options.collisionEdits) return;
      const projected = (wireWorld ? wireWorld(world) : world) as W | undefined;
      const collision = options.collisionEdits&&!options.collisionIdentity ? snapshotCollisionEdits(options.collisionEdits(projected, tuning)) : undefined;
      if (options.edits) this.setEdits(options.edits(projected, tuning));
      if (collision) acceptCollisionEdits(collision);
      if(options.collisionEdits&&options.collisionIdentity){
        const identity=options.collisionIdentity(projected,tuning);
        if(typeof identity!=='string'||identity.length>65536)throw new Error('Terrain collision identity exceeds its bounded string contract.');
        const next='state:'+identity;
        if(next!==collisionKey){
          pendingCollision={world:plain(projected),tuning:plain(tuning)};
          collisionKey=next;collisionRevision=fingerprint(next);key='';
        }
      }
    },
    bindWorldShape(shape) {
      // Games without dynamic edits keep their existing preparation cost.
      // Cache the declared shape, never the mutable world or projected edits.
      if (!options.edits && !options.collisionEdits || wireWorld && boundWorldShape === shape) return;
      wireWorld = createWireConformer(shape ?? {}, 'world');
      boundWorldShape = shape;
    },
    prepareMetadata(tuning, incremental = false) {
      if (!incremental) { recipeForTuning(tuning); return true; }
      const next = tuningKey(tuning);
      if (preparedRecipe && recipeKey === next) return true;
      if (!metadataWork || metadataWork.key !== next) {
        const recipe = composeRecipeForTuning(tuning);
        if (!terrainUsesStreaming(recipe)) {
          preparedRecipe = recipe; recipeKey = next; stream = undefined; metadataWork = undefined; return true;
        }
        metadataWork = { key: next, recipe, work: TerrainStream.prepare(recipe) };
        return false;
      }
      let result: IteratorResult<void, TerrainStream>;
      try { result = metadataWork.work.next(); }
      catch (error) { metadataWork = undefined; throw error; }
      if (!result.done) return false;
      preparedRecipe = metadataWork.recipe; recipeKey = next; acceptStream(result.value); metadataWork = undefined;
      return true;
    },
    prepare(tuning, interests, includeInitial = false) {
      if(pendingCollision){
        const pending=pendingCollision;
        installCollisionEdits(snapshotCollisionEdits(options.collisionEdits!(pending.world,pending.tuning)));
        pendingCollision=undefined;
      }
      recipeForTuning(tuning);
      if (!stream) { const accepted = this.read(tuning); return { ready: true, pending: 0, revision: accepted.revision, loadedRevision: accepted.loadedRevision }; }
      const initial = options.initialInterests?.(tuning);
      const progress = stream.prepare(interests?.length ? interests : initial, includeInitial && interests?.length ? initial ?? [{ x: 0, z: 0 }] : undefined);
      const accepted = this.read(tuning);
      return { ...progress, revision: accepted.revision, loadedRevision: accepted.loadedRevision };
    },
    prepareCollisionEdits(tuning){
      if(!pendingCollision||!preparedRecipe||recipeKey!==tuningKey(tuning)||!stream||!snapshot)return;
      const pending=pendingCollision;
      installCollisionEdits(snapshotCollisionEdits(options.collisionEdits!(pending.world,pending.tuning)));
      pendingCollision=undefined;
      const accepted=this.read(tuning);
      return{ready:true,pending:0,revision:accepted.revision,loadedRevision:accepted.loadedRevision};
    },
    prepared(tuning, interests, includeInitial = false) {
      if (pendingCollision||!preparedRecipe || recipeKey !== tuningKey(tuning) || !snapshot || acceptedCollisionKey !== collisionKey) return false;
      const initial = options.initialInterests?.(tuning);
      return stream ? stream.prepared(interests?.length ? interests : initial, includeInitial && interests?.length ? initial ?? [{ x: 0, z: 0 }] : undefined) : true;
    },
    exportPrepared(tuning) {
      if(pendingCollision)throw new Error('Terrain collision edits require preparation before export.');
      const accepted = this.read(tuning);
      if (!accepted.streaming.ready) throw new Error('Terrain preparation must complete before exporting geometry.');
      const geometry = { ...(stream ? { streamed: stream.exportPrepared(), scene: accepted.scene } : { eager: { ...accepted.manifest!, revision: eagerSourceRevision }, scene: accepted.scene }),
        ...(collisionRevision === undefined ? {} : { collisionRevision }),
        ...(options.collisionChunks?{collisionChunks:options.collisionChunks(tuning,accepted.chunks)}:{}) };
      return { version: 1, revision: accepted.revision, loadedRevision: accepted.loadedRevision, checksum: geometryChecksum(geometry), ...geometry };
    },
    adoptPrepared(tuning, data, verified = false) {
      const copy = verified ? data : validateTerrainPreparedWorld(data);
      if (!copy || copy.version !== 1 || typeof copy.revision !== 'string' || typeof copy.loadedRevision !== 'string'
        || typeof copy.checksum !== 'string' || !!copy.eager === !!copy.streamed || !copy.scene)
        throw new Error('Prepared terrain transfer is malformed or its geometry checksum differs.');
      if (copy.collisionRevision !== collisionRevision) throw new Error('Prepared terrain collision edit revision differs from authoritative state.');
      const oldStream = stream, oldRetainedStream = retainedStream, oldSnapshot = snapshot, oldKey = key, oldEager = adoptedEager, oldSourceRevision = eagerSourceRevision;
      const oldEagerGeometry = eagerGeometry, oldAcceptedCollisionKey = acceptedCollisionKey;
      const oldPendingCollision=pendingCollision;
      const oldRecipeKey = recipeKey, oldPreparedRecipe = preparedRecipe;
      const oldStreamInspection = snapshotStreamInspection;
      try {
        const recipe = recipeForTuning(tuning);
        if (stream) {
          if (!copy.streamed || copy.eager) throw new Error('Prepared terrain mode differs from the current recipe.');
          if (streamRevision(stream.revision, tuning) !== copy.revision) throw new Error('Prepared terrain source, tuning or collision revision differs.');
          const accepted = new TerrainStream(stream); accepted.adoptPrepared(copy.streamed, verified); stream = accepted;
          snapshot = streamedSnapshot(tuning, copy); key = `${tuningKey(tuning)}:${stream.loadedRevision}`;
          retainedStream = stream;
          pendingCollision=undefined;
          return { ready: true, pending: 0, revision: snapshot.revision, loadedRevision: snapshot.loadedRevision };
        } else {
          const manifest = copy.eager;
          const normalized = { ...recipe, regions: [...recipe.regions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
          if (!manifest || copy.streamed || !manifest.diagnostics?.valid || canonical(manifest.recipe) !== canonical(normalized)
            || manifest.rows !== (recipe.bounds.cells ?? 32) || manifest.columns !== manifest.rows
            || manifest.heights.length !== (manifest.rows + 1) ** 2 || manifest.colors.length !== manifest.heights.length
            || manifest.instances.length > 4096 || manifest.colliders.length > 96) throw new Error('Prepared eager terrain differs from its recipe or exceeds geometry bounds.');
          adoptedEager = manifest;
        }
        snapshot = undefined; key = '';
        const accepted = this.read(tuning);
        if (accepted.revision !== copy.revision || accepted.loadedRevision !== copy.loadedRevision) throw new Error('Prepared terrain source, tuning or collision revision differs.');
        return { ready: true, pending: 0, revision: accepted.revision, loadedRevision: accepted.loadedRevision };
      } catch (error) {
        stream = oldStream; retainedStream = oldRetainedStream; snapshot = oldSnapshot; key = oldKey; adoptedEager = oldEager; eagerSourceRevision = oldSourceRevision;
        eagerGeometry = oldEagerGeometry; acceptedCollisionKey = oldAcceptedCollisionKey;
        recipeKey = oldRecipeKey; preparedRecipe = oldPreparedRecipe;
        snapshotStreamInspection = oldStreamInspection;
        pendingCollision=oldPendingCollision;
        throw error;
      }
    },
    read(tuning) {
      const next = tuningKey(tuning);
      const recipe = recipeForTuning(tuning, next);
      if (stream) {
        const streamKey = `${next}:${stream.loadedRevision}`;
        if (snapshot && key === streamKey) {
          const current = stream.inspection();
          if (current !== snapshotStreamInspection) {
            const streaming = Object.freeze({ ...current, revision: snapshot.revision, loadedRevision: snapshot.loadedRevision });
            const report = snapshot.inspection();
            snapshot = Object.freeze({ ...snapshot, streaming, inspection: () => ({ ...report, streaming }) });
            snapshotStreamInspection = current;
          }
          return snapshot;
        }
        snapshot = streamedSnapshot(tuning); key = streamKey;
        if (stream.inspection().ready) retainedStream = stream;
        return snapshot;
      }
      if (snapshot && key === next) return snapshot;
      const cachedGeometry = options.collisionEdits && eagerGeometry?.recipe === recipe ? eagerGeometry : undefined;
      const source = adoptedEager ?? cachedGeometry?.manifest ?? compileTerrain(recipe, snapshot?.manifest);
      const manifest = options.collisionEdits ? { ...source } : source;
      adoptedEager = undefined;
      eagerSourceRevision = manifest.revision;
      if (!manifest.diagnostics.valid) throw new Error(`Terrain world rejected generation: ${manifest.diagnostics.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('; ')}`);
      if (options.fixedHeight !== undefined && (!Number.isFinite(options.fixedHeight) || manifest.heights.some(height => Math.abs(height - options.fixedHeight!) > 1e-5)))
        throw new Error(`This base preserves a fixed flat surface at ${options.fixedHeight}m; elevation-changing terrain needs a heightfield-capable base.`);
      manifest.colliders = physicsPrecision(manifest.colliders);
      if (options.collisionEdits && (!cachedGeometry || cachedGeometry.manifest !== source)) eagerGeometry = { recipe, manifest: freeze({ ...manifest }) };
      const extra = eagerGeometry?.recipe === recipe && eagerGeometry.extra
        ? eagerGeometry.extra : physicsPrecision(plain(options.colliders?.(tuning, manifest) ?? []));
      if (eagerGeometry?.recipe === recipe) eagerGeometry.extra = extra;
      manifest.revision = `world-v1-${fingerprint(canonical(collisionRevision === undefined ? [manifest.revision, extra] : [manifest.revision, extra, collisionRevision]))}`;
      let scene: PhysicsScene;
      if (options.collisionEdits) {
        const terrain = eagerGeometry!.terrain ?? { rows: manifest.rows, columns: manifest.columns,
          heights: manifest.heights, width: manifest.bounds.width, depth: manifest.bounds.depth };
        eagerGeometry!.terrain = terrain;
        scene = { colliders: editColliders([...manifest.colliders, ...extra], false), terrain };
      } else scene = terrainPhysicsScene(manifest, extra);
      // Clearance/spawn queries include authored base obstacles as well as scatter.
      const queryManifest = options.collisionEdits ? { ...manifest, colliders: scene.colliders }
        : extra.length ? { ...manifest, colliders: [...manifest.colliders, ...extra] } : manifest;
      freeze(manifest); freeze(scene); freeze(queryManifest);
      const contributionCount = installed.length;
      const acceptedTuning = freeze(plain(tuning));
      const chunks = freeze([{ id: 'eager', x: 0, z: 0, manifest }]);
      const streaming: TerrainStreamingInspection = { enabled: false, ready: true, pending: 0, revision: manifest.revision, loadedRevision: manifest.revision,
        chunkSize: Math.max(manifest.bounds.width, manifest.bounds.depth), cells: manifest.rows, colliderReach: 0, loaded: ['eager'], missing: [], cached: 1, generated: 1, evicted: 0,
        validation: 'global-metadata-and-loaded-chunks' };
      const accepted: TerrainWorldSnapshot = Object.freeze({ version: 1, revision: manifest.revision, loadedRevision: manifest.revision,
        manifest, recipe: manifest.recipe, instances: manifest.instances, chunks, streaming, scene, constraints, contributionCount,
        available: (x: number, z: number, radius = 0) => [x, z, radius].every(Number.isFinite) && radius >= 0
          && Math.abs(x) + radius <= manifest.bounds.width / 2 && Math.abs(z) + radius <= manifest.bounds.depth / 2,
        sample: (x: number, z: number) => sampleTerrain(manifest, x, z),
        spawns: (spawn: TerrainSpawnOptions) => terrainSpawns(queryManifest, { ...spawn, accept: point =>
          (options.contains?.(point, spawn.radius, acceptedTuning) ?? true) && (spawn.accept?.(point) ?? true) }),
        clearance: (point: PhysicsVector, radius: number, height: number) => (options.contains?.(point, radius, acceptedTuning) ?? true) && terrainClearance(queryManifest, point, radius, height),
        footSupports: (points: TerrainSupportPoints, timeMs: number) => terrainFootSupports(manifest, points, timeMs),
        actorSupports: (points: TerrainSupportPoints, timeMs: number) => terrainActorSupports(manifest, points, timeMs),
        inspection: () => ({ ...terrainInspection(queryManifest), ...(options.collisionEdits ? { counts: { ...manifest.diagnostics.counts, colliders: scene.colliders.length } } : {}), constraints, contributionCount }),
        assertRevision: (revision: unknown) => { if (revision !== manifest.revision) throw new Error(`Terrain world revision differs from authoritative physics: view ${manifest.revision}, authority ${String(revision).slice(0, 96)}.`); },
      });
      snapshot = accepted; key = next; acceptedCollisionKey = collisionKey; return accepted;
    },
  };
}
