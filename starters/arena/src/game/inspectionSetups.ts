import type { InspectionSetup, MatchContext } from '../shared/gameApi.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';

type Context = MatchContext<WorldState, PlayerState, GameTuning>;

/** Stages only the inspection subject. The map, inventory rules, attack logic,
 * terrain support and subsequent movement all remain the actual Arena game. */
function equip(ctx: Context, equipped: 1 | 2, slope = false): void {
  const terrain = sharedTerrain.read(ctx.tuning), scale = ctx.tuning.arenaRadius / 96;
  let point = { x: 0, z: 12 * scale }, facing = Math.PI;
  if (slope) {
    // Prefer the plaza shoulder used by the animation lab, with a bounded
    // deterministic search when a seed/mod moves it. Never claim hill coverage
    // after silently substituting a flat or obstructed patch.
    const candidates = [point, ...[-1, 1].flatMap(sign => [15, 20, 25, 30].flatMap(x =>
      [10, 15, 20, 25].map(z => ({ x: sign * x * scale, z: z * scale }))))];
    const selected = candidates.find(candidate => {
      const sample = terrain.sample(candidate.x, candidate.z), steepness = Math.hypot(sample.normal.x, sample.normal.z) / Math.max(.001, sample.normal.y);
      return sample.inside && steepness >= .06 && steepness <= Math.tan(Math.min(30, ctx.tuning.maxSlopeDegrees) * Math.PI / 180)
        && terrain.clearance({ ...candidate, y: sample.height }, ctx.tuning.fighterRadius, ctx.tuning.fighterHeight);
    });
    if (!selected) throw new Error('Arena inspection setup: no clear walkable slope found in the bounded shoulder search. Adjust the fixture for this terrain.');
    point = selected;
    const normal = terrain.sample(point.x, point.z).normal;
    facing = Math.atan2(-normal.x, -normal.z);
  }
  const surface = terrain.sample(point.x, point.z), position = { ...point, y: surface.height };
  if (!surface.inside || !terrain.clearance(position, ctx.tuning.fighterRadius, ctx.tuning.fighterHeight))
    throw new Error('Arena inspection setup: the authored staging position is obstructed by this terrain/mod combination.');
  Object.assign(ctx.players[0].state, position, { facing, aimPitch: 0, velocityX: 0, velocityY: 0, velocityZ: 0,
    grounded: 1, equipped, weapon: true, sword: true, bow: true, arrows: 30,
    attackMs: 0, cooldownMs: 0, bowDrawMs: 0, bowShotDrawMs: 0, attackHeld: false, drawBlocked: false,
    bandageMs: 0, chestId: '' });
}

export const arenaInspectionSetups: readonly InspectionSetup<WorldState, PlayerState, GameTuning>[] = [
  { id: 'arena-sword-carry', label: 'Sword carry and attack',
    relevance: { sourcePaths: ['src/game/equipmentPose.ts', 'src/game/animations.ts', 'src/game/actor.ts', 'src/game/combat.ts'],
      tags: ['sword', 'swordSwing', 'swordGrip', 'swordCarry'] },
    description: 'Equip the subject with a sword on the central plaza. Exercise idle, running, moving attack, turn, jump and recovery using ordinary Arena simulation.',
    recommendedScenario: { recipe: 'character-quality' }, stage: ctx => equip(ctx, 1) },
  { id: 'arena-bow-draw', label: 'Bow draw and release',
    relevance: { sourcePaths: ['src/game/equipmentPose.ts', 'src/game/animations.ts', 'src/game/actor.ts', 'src/game/combat.ts'],
      tags: ['bow', 'bowDrawMs', 'bowShotDrawMs', 'drawBlocked', 'bowDraw', 'bowRelease'] },
    description: 'Equip a bow and arrows on the plaza for a held draw, release and recovery. Inventory is staged; chest acquisition is not exercised.',
    recommendedScenario: { recipe: 'attack', holdMs: 900, durationMs: 2500 }, stage: ctx => equip(ctx, 2) },
  { id: 'arena-bow-uphill', label: 'Bow movement on a slope',
    relevance: { sourcePaths: ['src/game/terrainWorld.ts', 'src/game/terrain.ts', 'src/game/layout.ts', 'src/game/equipmentPose.ts'],
      tags: ['slope', 'maxSlopeDegrees', 'grounded', 'terrain', 'bow', 'bowDrawMs'] },
    description: 'Equip a bow on a verified clear shoulder slope, facing uphill. Inputs exercise movement, attack, turn, jump and settling on real generated terrain.',
    recommendedScenario: { recipe: 'character-quality' }, stage: ctx => equip(ctx, 2, true) },
];
