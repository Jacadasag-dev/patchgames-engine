import { createTerrainWorld } from '../sandbox/terrainWorld.ts';
import { circularArenaWalls } from '../sandbox/characters.ts';
import type { GameTuning } from './tuning.ts';

/** Editable base recipe. Mods add their own biomes, paths and placements. */
export const sharedTerrain = createTerrainWorld((tuning: GameTuning) => ({ version: 1, seed: 17,
  bounds: { width: tuning.arenaRadius * 2, depth: tuning.arenaRadius * 2, cells: 24 },
  assets: [], regions: [{ id: 'arena', mask: { kind: 'box', width: tuning.arenaRadius * 2, depth: tuning.arenaRadius * 2,
    center: { x: 0, z: 0 } }, color: '#aa967c', layers: [] }],
}), { colliders: tuning => circularArenaWalls(tuning.arenaRadius),
  contains: (point, radius, tuning) => Math.hypot(point.x, point.z) + radius <= tuning.arenaRadius,
});

