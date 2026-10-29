import type { GameLogic } from '../shared/gameApi.ts';
import { controls } from './controls.ts';
import { learning } from './learning.ts';
import { entities } from './entities.ts';
import { respawnPlayer, setupMatch, setupPlayer, step, SUPPORTED_MODES } from './rules.ts';
import { shapes, GUARD_NAMES, type FighterState, type FightInput, type WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';
const game: GameLogic<WorldState, FighterState, FightInput, GameTuning> = {
  supportedModes: SUPPORTED_MODES,
  featureCapabilities: ['player.position.v1', 'player.vertical-motion.v1', 'player.appearance.v1', 'world.terrain.v1'],
  terrainWorld: sharedTerrain, shapes, learning, setupMatch, setupPlayer, respawnPlayer, step, entities, controls,
  describePlayer: ({ state }) => state.combat.stunMs > 0 ? 'STUNNED' : state.combat.attackState === 'idle' ? `${GUARD_NAMES[state.combat.guard]} GUARD` : state.combat.attackState.toUpperCase(),
  inspectionSetups: [{ id: 'duel-melee', label: 'Sword exchange distance',
    description: 'Test-only placement of the two knights within sword reach. Normal players close the distance using ordinary movement.',
    relevance: { sourcePaths: ['src/game/rules.ts', 'src/game/view/duelView.ts'], tags: ['sword', 'guard', 'parry', 'hilt', 'heavy', 'dodge'] },
    recommendedScenario: { recipe: 'attack', durationMs: 1800 },
    stage(ctx) { ctx.players.forEach((player, index) => Object.assign(player.state, { x: 0, y: 0, z: index === 0 ? -0.75 : 0.75, facing: index === 0 ? 0 : Math.PI })); },
  }],
  // No prediction block: the Patch Engine predicts the local knight by running `step` itself.
  smoothFields: ['x', 'y', 'z'],
  // Where the opponent looks and what their sword is doing: the newest value matters more than
  // every value arriving, so these ride UDP with x/y/z. Each state travels with the counter the
  // view uses to tell a new swing or hit from the last one (attackSeq, feedbackSeq).
  network: { fast: ['facing', 'aimPitch', 'combat.guard', 'combat.isBlocking', 'combat.attackState', 'combat.attackGuard', 'combat.attackSeq',
    'combat.actionMs', 'combat.actionDurationMs', 'combat.chargeMs', 'combat.stunMs', 'combat.dodgeMs',
    'combat.actionFeedback', 'combat.feedbackMs', 'combat.feedbackSeq'] },
  hudLines(frame) {
    const me = frame.players.find(player => player.isLocal);
    if (!me) return [];
    const state = me.state;
    if (state.combat.stunMs > 0) return ['STUNNED — recover your footing'];
    if (state.combat.attackState === 'charging') return [`HEAVY ${Math.round(100 * state.combat.chargeMs / frame.tuning.heavyChargeMs)}% · release to strike`];
    return [`${GUARD_NAMES[state.combat.guard]} GUARD · switch just before impact to parry`, 'A hilt strike stuns a guard and counters an enemy hilt strike'];
  },
};
export default game;
