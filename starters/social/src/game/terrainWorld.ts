import { createTerrainWorld } from '../sandbox/terrainWorld.ts';
import type { PhysicsCollider, PhysicsScene } from '../sandbox/physics.ts';
import { furniture, LOUNGE, seats, spawnPoints } from './layout.ts';
import type { GameTuning } from './tuning.ts';

const box = (x: number, y: number, z: number, width: number, height: number, depth: number, facing = 0): PhysicsCollider => ({
  shape: { kind: 'box', halfExtents: { x: width / 2, y: height / 2, z: depth / 2 } },
  position: { x, y, z }, rotation: { x: 0, y: Math.sin(facing / 2), z: 0, w: Math.cos(facing / 2) },
});
/** Shared, finite furniture collision under authority and local prediction. */
export const loungePhysics: PhysicsScene = { colliders: [
  box(0, -.5, 0, LOUNGE.halfWidth * 2, 1, LOUNGE.halfDepth * 2),
  ...[-1, 1].map(side => box(side * (LOUNGE.halfWidth + .2), LOUNGE.wallHeight / 2, 0, .4, LOUNGE.wallHeight, LOUNGE.halfDepth * 2 + .8)),
  ...[-1, 1].map(side => box(0, LOUNGE.wallHeight / 2, side * (LOUNGE.halfDepth + .2), LOUNGE.halfWidth * 2, LOUNGE.wallHeight, .4)),
  box(0, LOUNGE.wallHeight + .2, 0, LOUNGE.halfWidth * 2, .4, LOUNGE.halfDepth * 2),
  ...furniture.map(prop => box(prop.x, prop.height / 2, prop.z, prop.width, prop.height, prop.depth, prop.facing)),
] };
export const sharedTerrain = createTerrainWorld((_tuning: GameTuning) => ({
  version: 1, seed: 37, bounds: { width: LOUNGE.halfWidth * 2, depth: LOUNGE.halfDepth * 2, cells: 32 }, assets: [], regions: [],
}), {
  fixedHeight: 0,
  colliders: () => loungePhysics.colliders.slice(1),
  reservations: () => [
    ...furniture.map(prop => ({ kind: 'box' as const, width: prop.width + .3, depth: prop.depth + .3,
      center: { x: prop.x, z: prop.z }, yaw: prop.facing })),
    ...seats.map(seat => ({ kind: 'box' as const, width: 1.1, depth: 1.1, center: seat.exit })),
    { kind: 'box' as const, width: 8, depth: 24, center: { x: 0, z: 0 } },
  ],
});
let spawnKey = '', spawns: { x: number; y: number; z: number }[] = [];
export function safeLoungeSpawns(tuning: GameTuning) {
  const terrain = sharedTerrain.read(tuning);
  const key = JSON.stringify([terrain.revision, tuning.fighterRadius, tuning.fighterHeight, tuning.maxSlopeDegrees]);
  if (key !== spawnKey) {
    spawns = terrain.spawns({ count: 32, radius: tuning.fighterRadius, height: tuning.fighterHeight,
      maxSlopeDegrees: tuning.maxSlopeDegrees, preferred: spawnPoints });
    spawnKey = key;
  }
  return spawns;
}
