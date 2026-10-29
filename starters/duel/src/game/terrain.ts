import settings from './tuning.schema.json' with { type: 'json' };
import type { TerrainWorld } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';

/** Shared deterministic heightfield: physics, spawns, camera and rendering sample this surface. */
export interface Vec3 { x: number; y: number; z: number }
export const UP: Vec3 = { x: 0, y: 1, z: 0 };
export const DEFAULT_WORLD: TerrainWorld = { terrain: {} };

/** Shared invalidation for geometry only. World objects can move without rebuilding
 * terrain, lights or static colliders. Declare terrain data in shapes.world.terrain.
 * Tuning participates so new terrain parameters invalidate automatically.
 */
export function arenaGeometryKey(world: TerrainWorld, tuning: GameTuning): string {
  return JSON.stringify([world.terrain ?? {}, tuning, sharedTerrain.read(tuning).revision]);
}

export function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/** The base has a flat floor. Future terrain code belongs here so all systems see it. */
export function terrainHeight(x: number, z: number, _world: TerrainWorld, tuning: GameTuning): number { return sharedTerrain.read(tuning).sample(x, z).height; }

export const TERRAIN_CELLS = 24;
/** The same piecewise planar surface used by Rapier's sampled heightfield. */
export function terrainSurfaceHeight(x: number, z: number, _world: TerrainWorld, tuning: GameTuning): number {
  const snapshot = sharedTerrain.read(tuning);
  return sampledSurfaceHeight(x, z, tuning, (x, z) => snapshot.sample(x, z).height);
}

function sampledSurfaceHeight(x: number, z: number, tuning: GameTuning, heightAt: (x: number, z: number) => number): number {
  const r = tuning.arenaRadius;
  if (Math.abs(x) > r || Math.abs(z) > r) return heightAt(x, z);
  const gx = (x / (2 * r) + 0.5) * TERRAIN_CELLS, gz = (z / (2 * r) + 0.5) * TERRAIN_CELLS;
  const col = Math.min(TERRAIN_CELLS - 1, Math.floor(gx)), row = Math.min(TERRAIN_CELLS - 1, Math.floor(gz));
  const u = gx - col, v = gz - row;
  const at = (cx: number, cz: number) => Math.fround(heightAt((cx / TERRAIN_CELLS - 0.5) * r * 2,
    (cz / TERRAIN_CELLS - 0.5) * r * 2));
  const a = at(col, row), b = at(col + 1, row), c = at(col, row + 1), d = at(col + 1, row + 1);
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

export type HeightQuery = (x: number, z: number, world: TerrainWorld, tuning: GameTuning) => number;
/** Surface geometry utility; alternate height queries are supplied by mechanics or tests. */
export function surfaceAt(x: number, z: number, world: TerrainWorld, tuning: GameTuning, heightAt: HeightQuery = terrainSurfaceHeight) {
  // The default query is synchronous and samples one immutable snapshot. Reuse
  // it across the normal's five heights instead of revalidating tuning 20 times.
  // Explicit authored callbacks still run in their original order on every call.
  if (heightAt === terrainSurfaceHeight) {
    const snapshot = sharedTerrain.read(tuning);
    heightAt = (x, z) => sampledSurfaceHeight(x, z, tuning, (x, z) => snapshot.sample(x, z).height);
  }
  const e = 0.02;
  const height = heightAt(x, z, world, tuning);
  const dx = (heightAt(x - e, z, world, tuning) - heightAt(x + e, z, world, tuning)) / (2 * e);
  const dz = (heightAt(x, z - e, world, tuning) - heightAt(x, z + e, world, tuning)) / (2 * e);
  // This shortcut follows the sampled geometry, so new terrain cannot silently bypass it.
  return { height, normal: dx === 0 && dz === 0 ? UP : normalize({ x: dx, y: 1, z: dz }) };
}

/** Reject impossible geometry instead of starting an unplayable match. */
export function validateArena(tuning: GameTuning): void {
  if (!(Object.keys(settings.fields) as (keyof GameTuning)[]).every((key) => Number.isFinite(tuning[key]))) {
    throw new Error('Game tuning is missing required finite values');
  }
  if (tuning.fighterRadius <= 0 || tuning.arenaRadius < tuning.fighterRadius * 3
    || tuning.fighterHeight < tuning.fighterRadius * 2 || tuning.gravity <= 0
    || tuning.moveSpeed < 0
    || tuning.maxSlopeDegrees <= 0 || tuning.maxSlopeDegrees >= 89) {
    throw new Error('Invalid arena, fighter, gravity or terrain dimensions');
  }
}

export function walkable(normal: Vec3, tuning: GameTuning): boolean {
  if (normal.y === 1) return true;
  return normal.y >= Math.cos(tuning.maxSlopeDegrees * Math.PI / 180);
}

/** Bounded search for safe, separated spawns; preferred spots remain unchanged on a flat map. */
export function terrainSpawns(world: TerrainWorld, tuning: GameTuning, heightAt: HeightQuery = terrainSurfaceHeight): [Vec3, Vec3] {
  validateArena(tuning);
  const limit = tuning.arenaRadius - tuning.fighterRadius;
  const offset = Math.max(tuning.fighterRadius, Math.min(limit, Math.abs(tuning.spawnOffsetX)));
  const candidates = [{ x: -offset, z: 0 }, { x: offset, z: 0 }];
  for (let ring = 1; ring <= 8; ring++) for (let spoke = 0; spoke < 32; spoke++) {
    const angle = spoke * Math.PI / 16;
    candidates.push({ x: Math.cos(angle) * limit * ring / 8, z: Math.sin(angle) * limit * ring / 8 });
  }
  const safe: Vec3[] = [];
  for (const p of candidates) {
    const probes = [[0, 0], [tuning.fighterRadius, 0], [-tuning.fighterRadius, 0], [0, tuning.fighterRadius], [0, -tuning.fighterRadius]];
    if (!probes.every(([dx, dz]) => {
      const s = surfaceAt(p.x + dx, p.z + dz, world, tuning, heightAt);
      return walkable(s.normal, tuning);
    })) continue;
    const b = { ...p, y: heightAt(p.x, p.z, world, tuning) };
    for (const a of safe) if (Math.hypot(a.x - b.x, a.z - b.z) >= tuning.fighterRadius * 2) return [a, b];
    safe.push(b);
  }
  throw new Error('Terrain has no safe pair of fighter spawns');
}

/** Same terrain/body foundation for larger rosters; preserve established duel starts. */
export function participantSpawns(world: TerrainWorld, tuning: GameTuning, count: number): Vec3[] {
  const terrain = sharedTerrain.read(tuning);
  if (terrain.instances.length || terrain.recipe.regions.length > 1 || terrain.recipe.routes?.length) {
    const offset = Math.min(Math.abs(tuning.spawnOffsetX), tuning.arenaRadius - tuning.fighterRadius);
    return terrain.spawns({ count, radius: tuning.fighterRadius, height: tuning.fighterHeight, maxSlopeDegrees: tuning.maxSlopeDegrees,
      preferred: [{ x: -offset, z: 0 }, { x: offset, z: 0 }] });
  }
  if (count === 2) return terrainSpawns(world, tuning);
  validateArena(tuning);
  const limit = tuning.arenaRadius - tuning.fighterRadius;
  const safe: Vec3[] = [];
  for (let ring = 8; ring >= 1; ring--) for (let spoke = 0; spoke < Math.max(32, count); spoke++) {
    const angle = spoke * Math.PI * 2 / Math.max(32, count);
    const x = Math.sin(angle) * limit * ring / 8, z = Math.cos(angle) * limit * ring / 8;
    if (safe.some(other => Math.hypot(other.x - x, other.z - z) < tuning.fighterRadius * 2)) continue;
    const probes = [[0, 0], [tuning.fighterRadius, 0], [-tuning.fighterRadius, 0], [0, tuning.fighterRadius], [0, -tuning.fighterRadius]];
    if (!probes.every(([dx, dz]) => walkable(surfaceAt(x + dx, z + dz, world, tuning).normal, tuning))) continue;
    safe.push({ x, y: terrainSurfaceHeight(x, z, world, tuning), z });
    if (safe.length === count) return safe;
  }
  throw new Error(`Terrain has no safe set of ${count} participant spawns`);
}
