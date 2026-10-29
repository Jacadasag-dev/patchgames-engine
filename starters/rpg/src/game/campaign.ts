import type { GameTuning } from './tuning.ts';
import type { Enemy } from './shapes.ts';

/** Extend these encounters or add a new destination to grow the starter campaign. */
export const CAMPAIGN = {
  start: { x: 0, z: 15 },
  destination: { x: 0, z: -77, radius: 7 },
  width: 32, north: -87, south: 25,
  encounters: [
    { name: 'Whispering trail', z: -8, group: 1, enemies: [{ x: -3, z: -6 }, { x: 3, z: -11 }] },
    { name: 'Old crossing', z: -35, group: 2, enemies: [{ x: -4, z: -33 }, { x: 4, z: -37 }, { x: 0, z: -39 }] },
    { name: 'The gatekeeper', z: -65, group: 3, enemies: [{ x: 0, z: -65 }] },
  ],
} as const;

export function createEnemies(tuning: GameTuning, partySize: number): Enemy[] {
  let id = 0;
  const scale = 1 + (Math.max(1, partySize) - 1) * tuning.partyHealthScale;
  return CAMPAIGN.encounters.flatMap(encounter => encounter.enemies.map(position => {
    const hp = (encounter.group === 3 ? tuning.bossHp : tuning.enemyHp) * scale;
    return { id: id++, group: encounter.group, kind: encounter.group === 3 ? 1 : 0, ...position, facing: 0, hp, maxHp: hp,
      windupMs: 0, strikeMs: 0, attackId: 0, aimX: position.x, aimZ: position.z, hitMs: 0, cooldownMs: 600 };
  }));
}
