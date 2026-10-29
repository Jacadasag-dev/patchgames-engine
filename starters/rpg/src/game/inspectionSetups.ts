import type { InspectionSetup } from '../shared/gameApi.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';

export const rpgInspectionSetups: readonly InspectionSetup<WorldState, PlayerState, GameTuning>[] = [{
  id: 'rpg-boss-approach', label: 'Party near the gatekeeper',
  relevance: { sourcePaths: ['src/game/campaign.ts', 'src/game/enemyVisuals.ts', 'src/game/logic.ts', 'src/game/adventurerMotions.ts', 'src/game/terrainWorld.ts'],
    tags: ['boss', 'gatekeeper', 'revive', 'downed', 'windupMs'] },
  description: 'Stage the party near the living boss with earlier encounters cleared. Ordinary movement and combat follow. This skips campaign progression and does not prove a complete playable campaign.',
  recommendedScenario: { recipe: 'character-quality' },
  stage(ctx) {
    const boss = ctx.world.enemies.find(enemy => enemy.kind === 1 && enemy.hp > 0);
    if (!boss || ctx.mode !== 'rpg') throw new Error('RPG boss inspection setup requires a living campaign boss in RPG mode.');
    ctx.world.stage = boss.group;
    for (const enemy of ctx.world.enemies) if (enemy.group < boss.group) {
      if (enemy.hp > 0) ctx.world.kills++;
      enemy.hp = 0; enemy.windupMs = enemy.strikeMs = 0;
    }
    const terrain = sharedTerrain.read(ctx.tuning);
    const positions = terrain.spawns({ count: ctx.players.length, radius: ctx.tuning.fighterRadius, height: ctx.tuning.fighterHeight,
      maxSlopeDegrees: ctx.tuning.maxSlopeDegrees,
      preferred: ctx.players.map((_, index) => ({ x: boss.x + (index - (ctx.players.length - 1) / 2) * 2, z: boss.z + 10 })),
      accept: point => Math.hypot(point.x - boss.x, point.z - boss.z) <= 15 });
    for (const [index, player] of ctx.players.entries()) Object.assign(player.state, positions[index], {
      facing: Math.atan2(boss.x - positions[index].x, boss.z - positions[index].z),
      velocityX: 0, velocityY: 0, velocityZ: 0, intentX: 0, intentZ: 0, grounded: 1,
      attackMs: 0, skillMs: 0, skillCooldownMs: 0, cooldownMs: 0, targetX: boss.x, targetZ: boss.z,
    });
  },
}];
