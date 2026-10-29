import { createTerrainWorld } from '../sandbox/terrainWorld.ts';
import { circularArenaWalls } from '../sandbox/characters.ts';
import type { PhysicsCollider } from '../sandbox/physics.ts';
import type { GameTuning } from './tuning.ts';
import { arenaTerrain } from './terrain.ts';
import { arenaBuildingParts, arenaBuildingPoint } from './layout.ts';
export const sharedTerrain = createTerrainWorld(arenaTerrain, { colliders: (tuning: GameTuning, manifest) => [
  ...circularArenaWalls(tuning.arenaRadius, 16),
  // Collision uses accepted placement transforms and the same wall pieces as the
  // asset factory. Adding a mod path cannot create an invisible solid room.
  ...manifest.instances.filter(instance => instance.source.kind === 'placement' && /^arena-(camp|lookout|ruin|shrine)$/.test(instance.asset))
    .flatMap(instance => arenaBuildingParts().map(part => {
      const position = arenaBuildingPoint({ ...instance.position, yaw: instance.yaw }, part.x, part.z, instance.scale);
      return { shape: { kind: 'box', halfExtents: { x: part.width * instance.scale / 2,
        y: part.height * instance.scale / 2, z: part.depth * instance.scale / 2 } },
        position: { ...position, y: instance.position.y + part.y * instance.scale },
        rotation: { x: 0, y: Math.sin(instance.yaw / 2), z: 0, w: Math.cos(instance.yaw / 2) } } satisfies PhysicsCollider;
    })),
], contains: (point, radius, tuning) => Math.hypot(point.x, point.z) + radius <= tuning.arenaRadius });

