import { normalize, terrainSurfaceHeight, UP, type HeightQuery, type Vec3 } from './terrain.ts';
import type { TerrainWorld } from './shapes.ts';
import type { GameTuning } from './tuning.ts';

/** Visual slope alignment uses a footprint, not a single triangle/contact bit.
 * Small contact gaps must not alternate the model between tilted and upright.
 * Blend toward upright continuously as the fighter moves away from the ground.
 * This is presentation only: never feed smoothed normals into physics or combat.
 */
export function visualGroundUp(position: Vec3, world: TerrainWorld, tuning: GameTuning,
  heightAt: HeightQuery = terrainSurfaceHeight): Vec3 {
  const radius = Math.max(0.02, tuning.fighterRadius * 0.5);
  const { x, y, z } = position;
  const up = normalize({
    x: (heightAt(x - radius, z, world, tuning) - heightAt(x + radius, z, world, tuning)) / (2 * radius),
    y: 1,
    z: (heightAt(x, z - radius, world, tuning) - heightAt(x, z + radius, world, tuning)) / (2 * radius),
  });
  const capsuleClearance = tuning.fighterRadius * (1 / up.y - 1);
  const gap = y - heightAt(x, z, world, tuning) - capsuleClearance;
  const weight = 1 - Math.min(1, Math.max(0, gap - 0.08) / (tuning.fighterHeight * 0.5));
  if (weight === 0) return UP;
  return normalize({ x: up.x * weight, y: 1 + (up.y - 1) * weight, z: up.z * weight });
}

/** Frame-rate-aware visual damping; reset to the target on spawn/teleport/seek. */
export function smoothVisualUp(previous: Vec3, target: Vec3, dt: number): Vec3 {
  const blend = 1 - Math.exp(-16 * Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0)));
  return normalize({ x: previous.x + (target.x - previous.x) * blend,
    y: previous.y + (target.y - previous.y) * blend, z: previous.z + (target.z - previous.z) * blend });
}

/** Ground indicators follow the surface, independently of model tilt or altitude. */
export function groundMarkerPoint(center: Vec3, offsetX: number, offsetZ: number, world: TerrainWorld,
  tuning: GameTuning, heightAt: HeightQuery = terrainSurfaceHeight): Vec3 {
  const x = center.x + offsetX, z = center.z + offsetZ;
  return { x, y: heightAt(x, z, world, tuning) + 0.035, z };
}
