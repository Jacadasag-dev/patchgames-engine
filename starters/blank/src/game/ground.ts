import type { PhysicsScene } from '../sandbox/physics.ts';

/** One flat, finite floor and nothing on it. Replace or extend it with terrain,
 * props and walls; keep rendering and collision described from the same numbers. */
export const GROUND = { halfExtent: 24, thickness: 1 } as const;

/** Shared, finite collision under authority and local prediction. */
export const groundPhysics: PhysicsScene = { colliders: [
  { id: 'ground', shape: { kind: 'box', halfExtents: { x: GROUND.halfExtent, y: GROUND.thickness / 2, z: GROUND.halfExtent } },
    position: { x: 0, y: -GROUND.thickness / 2, z: 0 } },
] };

/** Participants start spread around the centre and face it. Placement depends only
 * on the stable participant index, so late arrivals never move anyone else. */
export function spawnPoint(index: number): { x: number; z: number; facing: number } {
  const angle = index * Math.PI * (3 - Math.sqrt(5)), radius = Math.min(GROUND.halfExtent - 2, 2.5 * Math.sqrt(index + 1));
  const x = Math.sin(angle) * radius, z = Math.cos(angle) * radius;
  return { x, z, facing: Math.atan2(-x, -z) };
}
