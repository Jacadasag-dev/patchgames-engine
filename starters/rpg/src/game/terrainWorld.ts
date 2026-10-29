import { createTerrainWorld } from '../sandbox/terrainWorld.ts';
import type { GameTuning } from './tuning.ts';
import { CAMPAIGN } from './campaign.ts';
/** Preserve the authored campaign floor; generated regions and props remain
 * available while elevation edits fail clearly instead of floating scenery. */
export const sharedTerrain = createTerrainWorld((_tuning: GameTuning) => ({ version: 1, seed: 17,
  bounds: { width: 32, depth: 174, cells: 32 }, assets: [], regions: [],
}), { fixedHeight: 0,
  contains: (point, radius) => Math.abs(point.x) + radius <= 16 && point.z - radius >= -87 && point.z + radius <= 25,
  colliders: () => [
    ...[-16.5, 16.5].map(x => ({ shape: { kind: 'box' as const, halfExtents: { x: .5, y: 100, z: 56 } }, position: { x, y: 0, z: -31 } })),
    ...[-87.5, 25.5].map(z => ({ shape: { kind: 'box' as const, halfExtents: { x: 17, y: 100, z: .5 } }, position: { x: 0, y: 0, z } })),
  ],
  reservations: () => [
    { kind: 'box', width: 4, depth: 108, center: { x: 0, z: -30 } },
    { kind: 'box', width: 14, depth: 16, center: { x: 0, z: 15 } },
    { kind: 'circle', radius: 7, center: { x: 0, z: -75 } },
    { kind: 'box', width: 34, depth: 62, center: { x: 0, z: 56 } },
    // Some authored encounters begin beside the central trail. Leave their
    // actual body footprints clear so added props cannot trap them at setup.
    ...CAMPAIGN.encounters.flatMap(encounter => encounter.enemies.map(center => ({
      kind: 'circle' as const, radius: encounter.group === 3 ? 1.2 : .7, center,
    }))),
  ],
});
