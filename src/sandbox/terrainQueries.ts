import { sampleTerrain, type TerrainManifest, type TerrainPoint } from './terrain.ts';
import type { PhysicsCollider, PhysicsVector } from './physics.ts';
import { physicsShapeBounds } from './physicsGeometry.ts';
import type { ActorPresentationSignals } from './animation.ts';

/** World XZ points, typically { ground: actorPosition } or feet.positions(). */
export type TerrainSupportPoints = Readonly<Record<string, Readonly<TerrainPoint>>>;
export interface TerrainFootSupport {
  point: PhysicsVector;
  normal: PhysicsVector;
  observedAtMs: number;
  /** A changed surface releases foot locks held against the previous revision. */
  id: string;
}

/** Fresh support on the generated Y-up ground, keyed to the queried limbs.
 * Omits outside-map points rather than treating clamped edge heights as ground.
 * This is not a raycast against buildings/bridges or proof of physical contact:
 * callers still supply authoritative grounded state and authored stance weights. */
export function terrainFootSupports(manifest: TerrainManifest, points: TerrainSupportPoints, timeMs: number): Record<string, TerrainFootSupport> {
  if (!manifest.diagnostics.valid) throw new Error('Terrain support requires a valid manifest.');
  const entries = Object.entries(points);
  if (!Number.isFinite(timeMs) || Math.abs(timeMs) > Number.MAX_SAFE_INTEGER || entries.length > 32
    || entries.some(([id, point]) => !id.length || id.length > 96 || !point || !Number.isFinite(point.x) || !Number.isFinite(point.z)))
    throw new Error('Terrain support requires a finite timeMs and at most 32 named finite XZ query points.');
  const result: Record<string, TerrainFootSupport> = Object.create(null);
  for (const [id, point] of entries) {
    const support = sampleTerrain(manifest, point.x, point.z);
    if (support.inside) result[id] = { point: { x: point.x, y: support.height, z: point.z }, normal: support.normal,
      observedAtMs: timeMs, id: manifest.revision };
  }
  return result;
}

/** Same exact terrain queries in the shared actor presentation signal format.
 * Use frame.now; do not cache support observations between presentation frames. */
export function terrainActorSupports(manifest: TerrainManifest, points: TerrainSupportPoints, timeMs: number): NonNullable<ActorPresentationSignals['supports']> {
  return Object.fromEntries(Object.entries(terrainFootSupports(manifest, points, timeMs)).map(([id, support]) => [id, {
    position: support.point, normal: support.normal, observedAtMs: support.observedAtMs,
  }]));
}

export interface TerrainSpawnOptions {
  count: number;
  radius: number;
  height: number;
  maxSlopeDegrees?: number;
  spacing?: number;
  preferred?: readonly TerrainPoint[];
  /** Additional deterministic host/game policy (e.g. stay inside arena walls).
   * Called only for the bounded set of otherwise safe candidate positions. */
  accept?: (point: Readonly<PhysicsVector>) => boolean;
}
/** Conservative upright-capsule clearance against the actual generated obstacles.
 * Does not establish navigation/connectivity; decorative instances do not block. */
export function terrainClearance(manifest: TerrainManifest, point: PhysicsVector, radius: number, height: number): boolean {
  if (!manifest.diagnostics.valid) return false;
  if (![point.x, point.y, point.z, radius, height].every(Number.isFinite) || radius <= 0 || height < radius * 2) return false;
  if (Math.abs(point.x - (manifest.origin?.x ?? 0)) + radius > manifest.bounds.width / 2
    || Math.abs(point.z - (manifest.origin?.z ?? 0)) + radius > manifest.bounds.depth / 2) return false;
  return manifest.colliders.every(collider => !intersects(collider, point, radius, height));
}
function intersects(collider: PhysicsCollider, point: PhysicsVector, radius: number, height: number): boolean {
  const shape = collider.shape;
  if (shape.kind === 'convex') {
    const { min, max } = physicsShapeBounds(shape, collider.rotation), p = collider.position;
    if (p.y + max.y <= point.y + .01 || p.y + min.y >= point.y + height) return false;
    return Math.hypot(Math.max(0, p.x + min.x - point.x, point.x - p.x - max.x),
      Math.max(0, p.z + min.z - point.z, point.z - p.z - max.z)) < radius + .02;
  }
  const q = collider.rotation, tilted = q && (Math.abs(q.x) > 1e-8 || Math.abs(q.z) > 1e-8);
  const enclosingRadius = shape.kind === 'box' ? Math.hypot(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z)
    : shape.kind === 'ball' ? shape.radius : shape.radius + shape.halfHeight;
  // Rotated rubble may extend above its original local Y extent. Use the same
  // conservative bound for vertical rejection and horizontal overlap.
  const halfY = tilted ? enclosingRadius : shape.kind === 'box' ? shape.halfExtents.y : shape.kind === 'ball' ? shape.radius : shape.radius + shape.halfHeight;
  if (collider.position.y + halfY <= point.y + .01 || collider.position.y - halfY >= point.y + height) return false;
  const dx = point.x - collider.position.x, dz = point.z - collider.position.z;
  if (shape.kind !== 'box') return Math.hypot(dx, dz) < radius + (tilted ? enclosingRadius : shape.radius) + .02;
  // Terrain compiler obstacle rotations are yaw only. All other rotations use a
  // conservative enclosing sphere rather than claiming exact upright clearance.
  if (tilted) return Math.hypot(dx, dz) < radius + enclosingRadius;
  const angle = q ? 2 * Math.atan2(q.y, q.w) : 0, c = Math.cos(angle), s = Math.sin(angle);
  const x = c * dx - s * dz, z = s * dx + c * dz;
  return Math.hypot(Math.max(0, Math.abs(x) - shape.halfExtents.x), Math.max(0, Math.abs(z) - shape.halfExtents.z)) < radius + .02;
}
/** Stable bounded roster placement using the same surface/obstacles as physics.
 * Preferred points are attempted first. Throws instead of spawning an unsafe
 * roster. This is sampled support/clearance, not a route or fairness guarantee. */
export interface TerrainSpawnSurface {
  sample(x: number, z: number): ReturnType<typeof sampleTerrain> | undefined;
  clearance(point: PhysicsVector, radius: number, height: number): boolean;
  regions: readonly { bounds: { width: number; depth: number }; origin?: TerrainPoint }[];
}
export function terrainSpawns(manifest: TerrainManifest, options: TerrainSpawnOptions, surface?: TerrainSpawnSurface): PhysicsVector[] {
  const { count, radius, height } = options, slope = options.maxSlopeDegrees ?? 40;
  const spacing = options.spacing ?? radius * 2 + .5;
  if (!manifest.diagnostics.valid) throw new Error('Terrain spawns require a valid manifest.');
  if (!Number.isInteger(count) || count < 1 || count > 32 || ![radius, height, slope, spacing].every(Number.isFinite)
    || radius <= 0 || height < radius * 2 || slope < 0 || slope >= 89 || spacing < radius * 2 || (options.preferred?.length ?? 0) > 256)
    throw new Error('Terrain spawns require 1..32 upright actors and valid dimensions.');
  const result: PhysicsVector[] = [], cosine = Math.cos(slope * Math.PI / 180);
  const accept = (point: TerrainPoint): boolean => {
    if (![point.x, point.z].every(Number.isFinite) || result.some(other => Math.hypot(other.x - point.x, other.z - point.z) < spacing)) return false;
    const probes = [[0, 0], [-radius, 0], [radius, 0], [0, -radius], [0, radius]]
      .map(([dx, dz]) => surface ? surface.sample(point.x + dx, point.z + dz) : sampleTerrain(manifest, point.x + dx, point.z + dz));
    if (probes.some(sample => !sample?.inside || sample.normal.y < cosine)) return false;
    const candidate = { ...point, y: probes[0]!.height };
    if (!(surface ? surface.clearance(candidate, radius, height) : terrainClearance(manifest, candidate, radius, height))) return false;
    if (options.accept && !options.accept(candidate)) return false;
    result.push(candidate); return result.length === count;
  };
  // Authored starts/loot normally already have a reserved footprint. Avoid
  // allocating and sorting a map-sized fallback grid when they are accepted.
  const preferred = options.preferred ?? [];
  for (const point of preferred) if (accept(point)) return result;
  const grid: TerrainPoint[] = [];
  const regions = surface?.regions ?? [manifest];
  const sharedStep = surface ? Math.sqrt(regions.reduce((sum, region) => sum + region.bounds.width * region.bounds.depth, 0) / 4096) : 0;
  for (const region of regions) {
    const center = region.origin ?? { x: 0, z: 0 }, step = Math.max(spacing, sharedStep, region.bounds.width / 64, region.bounds.depth / 64);
    for (let x = center.x - region.bounds.width / 2 + radius; x <= center.x + region.bounds.width / 2 - radius; x += step)
      for (let z = center.z - region.bounds.depth / 2 + radius; z <= center.z + region.bounds.depth / 2 - radius; z += step) grid.push({ x, z });
  }
  const origin = preferred[0] ?? { x: 0, z: 0 };
  grid.sort((a, b) => Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z) || a.x - b.x || a.z - b.z);
  for (const point of grid.slice(0, 5000 - preferred.length)) {
    if (accept(point)) return result;
  }
  throw new Error(`Terrain spawn capacity: found ${result.length} of ${count} safe positions for radius ${radius}, height ${height}, slope ${slope} degrees within 5000 samples.`);
}
