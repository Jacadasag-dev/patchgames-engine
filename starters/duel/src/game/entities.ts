import type { EntityContext, GameEntities, PlayerBody, PlayerList } from '../shared/gameApi.ts';
import type { FighterState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
export function fighterBody(state: FighterState, tuning: GameTuning): PlayerBody {
  return { at: { x: state.x, y: state.y, z: state.z }, radius: tuning.fighterRadius, height: tuning.fighterHeight };
}
/** Reach/guard resolution creates one target-scoped sweep; only the checked host changes health. */
export function entities({ players, world, tuning }: EntityContext<WorldState, FighterState, GameTuning>): GameEntities {
  return { bodies: players.map(player => fighterBody(player.state, tuning)) as PlayerList<PlayerBody>,
    damage: world.strikes.map(strike => ({ id: `sword-${strike.owner}-${strike.id}`, label: 'two handed sword', kind: 'strike',
      owner: strike.owner, target: strike.target, damage: strike.damage, shape: 'sphere', radius: 0.13,
      from: { x: strike.fromX, y: strike.y, z: strike.fromZ }, at: { x: strike.x, y: strike.y, z: strike.z } })) };
}
