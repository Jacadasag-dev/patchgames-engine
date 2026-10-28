import { compileTerrainChunk, prepareTerrainRecipe, terrainRecipeRevision, terrainChunkRevision, terrainAssetColliderReach, type TerrainRecipe, type TerrainManifest, type TerrainPoint } from './terrain.ts';
import { terrainEditDependencies, terrainDependencyTouches } from './terrainDependencies.ts';
import { validateResolvedTerrainChannels } from './terrainChannels.ts';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function physicsPrecision<T>(value: T): T {
  if (typeof value === 'number') return (Math.round(value * 1e9) / 1e9) as T;
  if (Array.isArray(value)) return value.map(physicsPrecision) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, physicsPrecision(item)])) as T;
  return value;
}

export interface TerrainInterest extends TerrainPoint {
  /** Collider footprint plus any required interaction distance. */
  radius?: number;
  /** Swept lookahead for the next half second; explicit teleports prepare their destination. */
  velocity?: TerrainPoint;
}
export interface TerrainChunk {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly manifest: TerrainManifest;
}
export interface TerrainPreparation {
  readonly ready: boolean;
  readonly pending: number;
  readonly revision: string;
  readonly loadedRevision: string;
}
export interface TerrainPreparedChunks {
  version: 1;
  revision: string;
  chunks: readonly TerrainChunk[];
}
export interface TerrainStreamingInspection extends TerrainPreparation {
  readonly enabled: boolean;
  readonly chunkSize: number;
  readonly cells: number;
  /** Maximum horizontal reach from an instance's owning center chunk. */
  readonly colliderReach: number;
  readonly loaded: readonly string[];
  readonly missing: readonly string[];
  readonly cached: number;
  readonly generated: number;
  /** Existing immutable geometry retained across a local recipe edit. */
  readonly reused?: number;
  readonly evicted: number;
  readonly validation: 'global-metadata-and-loaded-chunks';
}

class TerrainStreamMetadata {
  readonly recipe: TerrainRecipe;
  readonly revision: string;
  readonly chunkSize: number;
  readonly cells: number;
  readonly colliderReach: number;
  constructor(recipe: TerrainRecipe, revision: string, chunkSize: number, cells: number, colliderReach: number) {
    this.recipe = recipe; this.revision = revision; this.chunkSize = chunkSize;
    this.cells = cells; this.colliderReach = colliderReach;
  }
}

/** The cache is disposable derived data. Gameplay edits stay in the caller's
 * serializable world state/recipe overrides and are reapplied on every revisit. */
export class TerrainStream {
  readonly recipe: TerrainRecipe;
  readonly revision: string;
  readonly chunkSize: number;
  readonly cells: number;
  readonly colliderReach: number;
  private readonly cache = new Map<string, TerrainChunk>();
  private wanted: { id: string; x: number; z: number; distance: number }[] = [];
  private active: readonly TerrainChunk[] = [];
  private activeIds = new Set<string>();
  private activeKey = '';
  private generated = 0;
  private reused = 0;
  private evicted = 0;
  private inspectionDirty = true;
  private inspectionReport: TerrainStreamingInspection | undefined;

  constructor(recipe: TerrainRecipe | TerrainStream | TerrainStreamMetadata) {
    // Adoption stages a new cache so a rejected transfer cannot alter the old
    // world. Its already validated immutable metadata does not need compiling,
    // serializing or hashing again just to create that independent cache.
    if (recipe instanceof TerrainStream || recipe instanceof TerrainStreamMetadata) {
      this.recipe = recipe.recipe; this.revision = recipe.revision;
      this.chunkSize = recipe.chunkSize; this.cells = recipe.cells;
      this.colliderReach = recipe.colliderReach;
      return;
    }
    const work = TerrainStream.metadata(recipe);
    let result = work.next();
    while (!result.done) result = work.next();
    const metadata = result.value;
    this.recipe = metadata.recipe; this.revision = metadata.revision;
    this.chunkSize = metadata.chunkSize; this.cells = metadata.cells; this.colliderReach = metadata.colliderReach;
  }

  /** The client yields between metadata validation, identity and freezing. The
   * ordinary constructor drains these same steps synchronously in its worker. */
  static *prepare(recipe: TerrainRecipe): Generator<void, TerrainStream> {
    return new TerrainStream(yield* TerrainStream.metadata(recipe));
  }

  private static *metadata(recipe: TerrainRecipe): Generator<void, TerrainStreamMetadata> {
    const config = recipe.streaming || {};
    const chunkSize = config.chunkSize ?? 128, cells = config.cells ?? 16;
    if (![32, 64, 128, 256, 512].includes(chunkSize) || !Number.isInteger(cells) || cells < 1 || cells > 32)
      throw new Error('Terrain streaming requires a chunk size of 32,64,128,256 or512 and1..32 cells.');
    const prepared = prepareTerrainRecipe(recipe), metadata = prepared.diagnostics;
    if (!metadata.valid) throw new Error(`Terrain world rejected metadata: ${metadata.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('; ')}`);
    yield;
    const accepted = prepared.recipe;
    const assetReach = new Map(accepted.assets.map(asset => [asset.id, terrainAssetColliderReach(asset)]));
    const colliderReach = Math.max(0,
      ...accepted.regions.flatMap(region => region.layers.flatMap(layer => layer.assets.map(id => assetReach.get(id)! * (layer.scale?.[1] ?? 1)))),
      ...[...accepted.placements ?? [], ...accepted.overrides?.pin ?? []].map(placement => assetReach.get(placement.asset)! * (placement.scale ?? 1)));
    if (!Number.isFinite(colliderReach)) throw new Error('Terrain streaming collider reach exceeds finite physics bounds.');
    const revision = terrainRecipeRevision(accepted);
    yield;
    freeze(accepted);
    return new TerrainStreamMetadata(accepted, revision, chunkSize, cells, colliderReach);
  }

  get chunks(): readonly TerrainChunk[] { return this.active; }
  get loadedRevision(): string { return `${this.revision}:${this.activeKey}`; }

  exportPrepared(): TerrainPreparedChunks {
    return { version: 1, revision: this.revision, chunks: this.active };
  }

  /** Stage only chunks outside every known edit dependency. The prior stream
   * remains untouched and this stream becomes active through normal prepare(). */
  reusePrepared(previous: TerrainStream): number {
    if (previous === this || previous.chunkSize !== this.chunkSize || previous.cells !== this.cells) return 0;
    const changes = terrainEditDependencies(previous.recipe, this.recipe, this.chunkSize / this.cells);
    if (changes.fullRebuild) return 0;
    let count = 0;
    for (const chunk of previous.cache.values()) {
      if (this.cache.has(chunk.id)) continue;
      const origin = chunk.manifest.origin!, halfX = chunk.manifest.bounds.width / 2, halfZ = chunk.manifest.bounds.depth / 2;
      const window = { minX: origin.x - halfX, maxX: origin.x + halfX, minZ: origin.z - halfZ, maxZ: origin.z + halfZ };
      if (changes.bounds.some(bound => terrainDependencyTouches(bound, window))) continue;
      const manifest: TerrainManifest = { ...chunk.manifest, recipe: this.recipe,
        revision: terrainChunkRevision(this.recipe, { x: chunk.x, z: chunk.z, size: this.chunkSize, cells: this.cells }),
        changes: { added: chunk.manifest.instances.map(instance => instance.id), removed: [], updated: [], unchanged: 0, surfaceChanged: true } };
      this.cache.set(chunk.id, freeze({ ...chunk, manifest })); count++;
    }
    this.reused += count; this.inspectionDirty = true; return count;
  }

  /** Transfer only derived, bounded geometry from the matching preparation
   * worker. Native physics still validates every collider at scene installation. */
  adoptPrepared(data: TerrainPreparedChunks, verified = false): void {
    if (!data || data.version !== 1 || data.revision !== this.revision || !Array.isArray(data.chunks) || data.chunks.length < 1 || data.chunks.length > 128)
      throw new Error('Prepared terrain has a stale recipe revision or invalid chunk count.');
    const ids = new Set<string>(), accepted: TerrainChunk[] = [];
    for (const chunk of data.chunks) {
      if (!chunk || !Number.isSafeInteger(chunk.x) || !Number.isSafeInteger(chunk.z) || chunk.id !== `${chunk.x}:${chunk.z}` || ids.has(chunk.id))
        throw new Error('Prepared terrain has invalid or duplicate chunk coordinates.');
      const manifest = chunk.manifest;
      const minX = Math.max(chunk.x * this.chunkSize, -this.recipe.bounds.width / 2), maxX = Math.min((chunk.x + 1) * this.chunkSize, this.recipe.bounds.width / 2);
      const minZ = Math.max(chunk.z * this.chunkSize, -this.recipe.bounds.depth / 2), maxZ = Math.min((chunk.z + 1) * this.chunkSize, this.recipe.bounds.depth / 2);
      if (!manifest || !manifest.diagnostics?.valid || manifest.rows !== this.cells || manifest.columns !== this.cells
        || maxX - minX < .02 || maxZ - minZ < .02 || manifest.bounds?.width !== maxX - minX || manifest.bounds?.depth !== maxZ - minZ
        || manifest.origin?.x !== (minX + maxX) / 2 || manifest.origin?.z !== (minZ + maxZ) / 2
        || !verified && terrainRecipeRevision(manifest.recipe) !== this.revision
        || !Array.isArray(manifest.heights) || manifest.heights.length !== (this.cells + 1) ** 2 || !verified && manifest.heights.some((height: number) => !Number.isFinite(height) || Math.abs(height) > 10000)
        || !Array.isArray(manifest.colors) || manifest.colors.length !== manifest.heights.length || !verified && manifest.colors.some((color: number) => !Number.isInteger(color) || color < 0 || color > 0xffffff)
        || !Array.isArray(manifest.instances) || manifest.instances.length > 4096 || !Array.isArray(manifest.colliders) || manifest.colliders.length > 96)
        throw new Error('Prepared terrain geometry does not match the bounded recipe window.');
      if (!verified && manifest.channels !== undefined) validateResolvedTerrainChannels(manifest.channels);
      // A JSON transfer repeats the same global recipe per chunk. Restore the
      // compiler's immutable shared metadata before freezing the accepted set.
      ids.add(chunk.id); accepted.push({ ...chunk, manifest: { ...manifest, recipe: this.recipe } });
    }
    accepted.sort((a, b) => a.x - b.x || a.z - b.z);
    this.inspectionDirty = true;
    this.cache.clear(); for (const chunk of accepted) this.cache.set(chunk.id, chunk);
    this.active = accepted; this.activeKey = accepted.map(chunk => chunk.id).join(',');
    this.activeIds = ids;
    this.wanted = accepted.map(chunk => ({ id: chunk.id, x: chunk.x, z: chunk.z, distance: 0 }));
  }

  private visitRequired(interests: readonly TerrainInterest[] = [{ x: 0, z: 0 }], visit: (x: number, z: number, point: TerrainInterest) => void) {
    if (!Array.isArray(interests) || interests.length > 32) throw new Error('Terrain interest supports at most32 active players.');
    const size = this.chunkSize;
    for (const point of interests.length ? interests : [{ x: 0, z: 0 }]) {
      // Center-owned obstacles may cross a chunk boundary. Include their owner
      // chunks before declaring swept player collision ready, even for a large
      // authored building or a scaled scatter asset.
      // Keep a useful visible neighborhood by default while a small-collider
      // player still touches at most four normal chunks. Explicit radii let an
      // authored camera or interaction choose a different bounded footprint.
      const requestedRadius = point.radius ?? size / 4;
      const radius = requestedRadius + size / this.cells + this.colliderReach;
      const endX = point.x + (point.velocity?.x ?? 0) * .5, endZ = point.z + (point.velocity?.z ?? 0) * .5;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.z) || !Number.isFinite(requestedRadius)
        || !Number.isFinite(radius) || !Number.isFinite(endX) || !Number.isFinite(endZ) || requestedRadius < 0
        || Math.abs(point.x) > this.recipe.bounds.width / 2 || Math.abs(point.z) > this.recipe.bounds.depth / 2)
        throw new Error('Terrain interests require finite in-world positions, nonnegative radii and finite motion.');
      const minX = Math.max(-this.recipe.bounds.width / 2, Math.min(point.x, endX) - radius);
      const maxX = Math.min(this.recipe.bounds.width / 2, Math.max(point.x, endX) + radius);
      const minZ = Math.max(-this.recipe.bounds.depth / 2, Math.min(point.z, endZ) - radius);
      const maxZ = Math.min(this.recipe.bounds.depth / 2, Math.max(point.z, endZ) + radius);
      const firstX = Math.floor(minX / size), lastX = Math.ceil(maxX / size) - 1;
      const firstZ = Math.floor(minZ / size), lastZ = Math.ceil(maxZ / size) - 1;
      if ((lastX - firstX + 1) * (lastZ - firstZ + 1) > 128) throw new Error('Terrain interest exceeds the128 active-chunk budget; prepare a bounded destination before moving.');
      for (let x = firstX; x <= lastX; x++) for (let z = firstZ; z <= lastZ; z++) visit(x, z, point);
    }
  }

  private plan(interests?: readonly TerrainInterest[]) {
    const size = this.chunkSize, wanted = new Map<string, { id: string; x: number; z: number; distance: number }>();
    this.visitRequired(interests, (x, z, point) => {
      const id = `${x}:${z}`, distance = Math.hypot((x + .5) * size - point.x, (z + .5) * size - point.z);
      const prior = wanted.get(id);
      if (!prior || prior.distance > distance) wanted.set(id, { id, x, z, distance });
    });
    if (wanted.size > 128) throw new Error('Terrain multiplayer interest exceeds the128 active-chunk budget; no collision was discarded.');
    return [...wanted.values()].sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z);
  }

  private planUnion(interests?: readonly TerrainInterest[], initial?: readonly TerrainInterest[]) {
    const wanted = new Map(this.plan(interests).map(chunk => [chunk.id, chunk]));
    if (initial) for (const chunk of this.plan(initial)) {
      const prior = wanted.get(chunk.id);
      if (!prior || chunk.distance < prior.distance) wanted.set(chunk.id, chunk);
    }
    if (wanted.size > 128) throw new Error('Terrain current and initial interests exceed the128 active-chunk budget; no collision was discarded.');
    return [...wanted.values()].sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z);
  }

  prepared(interests?: readonly TerrainInterest[], initial?: readonly TerrainInterest[]): boolean {
    const wanted = new Set<string>();
    let ready = true;
    const check = (points: readonly TerrainInterest[] | undefined) => {
      // The usual single plan needs only one set. Retain the per-plan bound
      // for a spawn union without rebuilding the resident coverage each tick.
      const required = wanted.size ? new Set<string>() : wanted;
      this.visitRequired(points, (x, z) => {
        const id = `${x}:${z}`;
        required.add(id);
        if (required !== wanted) wanted.add(id);
        if (!this.activeIds.has(id)) ready = false;
      });
      if (required.size > 128) throw new Error('Terrain multiplayer interest exceeds the128 active-chunk budget; no collision was discarded.');
    };
    // Readiness needs coverage, not generation priority. Validate every point
    // and both plan/union caps even after finding a missing chunk.
    check(interests);
    if (initial) check(initial);
    if (wanted.size > 128) throw new Error('Terrain current and initial interests exceed the128 active-chunk budget; no collision was discarded.');
    return ready;
  }

  /** One generation per call. A new interest set becomes visible atomically
   * only after every required collision chunk has passed its compiler checks. */
  prepare(interests?: readonly TerrainInterest[], initial?: readonly TerrainInterest[]): TerrainPreparation {
    this.wanted = this.planUnion(interests, initial);
    // A valid plan may evict/prune before generation throws. Those changes
    // must be visible, while an invalid plan leaves the accepted report intact.
    this.inspectionDirty = true;
    // Geometry outside the complete new interest union is disposable. Native
    // collision remains installed until the caller commits a ready scene; no
    // current actor/swept-interest chunk is removed to make room for another.
    const required = new Set(this.wanted.map(chunk => chunk.id));
    for (const id of this.cache.keys()) if (!required.has(id)) { this.cache.delete(id); this.evicted++; }
    const retained = this.active.filter(chunk => required.has(chunk.id));
    if (retained.length !== this.active.length) {
      this.active = retained; this.activeKey = retained.map(chunk => chunk.id).join(',');
      this.activeIds = new Set(retained.map(chunk => chunk.id));
    }
    const missing = this.wanted.find(chunk => !this.cache.has(chunk.id));
    if (missing) {
      const manifest = compileTerrainChunk(this.recipe, { x: missing.x, z: missing.z, size: this.chunkSize, cells: this.cells });
      if (!manifest.diagnostics.valid) throw new Error(`Terrain chunk ${missing.id} rejected generation: ${manifest.diagnostics.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('; ')}`);
      // Share immutable global metadata and normalize/freeze each new chunk in
      // its own preparation slice, never all resident geometry on the final call.
      manifest.recipe = this.recipe; manifest.colliders = physicsPrecision(manifest.colliders); freeze(manifest);
      this.cache.set(missing.id, Object.freeze({ id: missing.id, x: missing.x, z: missing.z, manifest })); this.generated++;
    }
    const pending = this.wanted.filter(chunk => !this.cache.has(chunk.id)).length;
    if (!pending) {
      const chunks = this.wanted.map(chunk => this.cache.get(chunk.id)!).sort((a, b) => a.x - b.x || a.z - b.z);
      const key = chunks.map(chunk => chunk.id).join(',');
      if (key !== this.activeKey) { this.active = chunks; this.activeKey = key; this.activeIds = required; }
      for (const chunk of chunks) { this.cache.delete(chunk.id); this.cache.set(chunk.id, chunk); }
    }
    return { ready: !pending, pending, revision: this.revision, loadedRevision: this.loadedRevision };
  }

  inspection(): TerrainStreamingInspection {
    if (!this.inspectionDirty && this.inspectionReport) return this.inspectionReport;
    const missing = this.wanted.filter(chunk => !this.cache.has(chunk.id)).map(chunk => chunk.id);
    const next: TerrainStreamingInspection = { enabled: true, ready: this.active.length > 0 && !missing.length, pending: missing.length,
      revision: this.revision, loadedRevision: this.loadedRevision, chunkSize: this.chunkSize, cells: this.cells, colliderReach: this.colliderReach,
      loaded: this.active.map(chunk => chunk.id), missing, cached: this.cache.size, generated: this.generated, reused: this.reused, evicted: this.evicted,
      validation: 'global-metadata-and-loaded-chunks' };
    const previous = this.inspectionReport;
    // Compare only after a mutating operation. A no-op preparation preserves
    // report identity; ordinary reads perform no array work or serialization.
    if (!previous || Object.keys(next).some(key => {
      const field = key as keyof TerrainStreamingInspection, value = next[field], old = previous[field];
      return Array.isArray(value) ? !Array.isArray(old) || value.length !== old.length || value.some((id, index) => id !== old[index]) : value !== old;
    })) this.inspectionReport = freeze(next);
    this.inspectionDirty = false;
    return this.inspectionReport!;
  }
}
