import type {CreateFeatureView} from '../../../shared/gameFeatures.ts';
import type {config} from './logic.ts';
import {createActor} from './model.ts';
const colors=['#46cfc1','#e5b747','#eb7956','#729de5','#c68ee5'];
const classes=['vapor','pulse','ember','bastion','wraith'];

const createView: CreateFeatureView<{}, {}, typeof config> = ({host, config, id}) => {
  const actors = new Map<string, ReturnType<typeof createActor>>();
  const modelId = id('default');
  function remove(playerId: string) {
    host.setPlayerAppearance(playerId, null, 'default'); actors.get(playerId)?.dispose(); actors.delete(playerId);
  }
  return {
    update(frame) {
      // Downed actors still wear their selected model while waiting for a revive.
      const selected = (player: typeof frame.players[number]) => player.active !== false
        && (player.hp > 0 || player.presentation?.posture === 'downed') && (!player.modelId || player.modelId === modelId);
      const visible = new Set(frame.players.filter(selected).map(player => player.id));
      for (const id of actors.keys()) if (!visible.has(id)) remove(id);
      for (const player of frame.players) {
        if (!selected(player)) continue;
        let actor = actors.get(player.id);
        if (!actor) {
          actor = createActor(colors[Math.max(0, classes.indexOf(player.classId ?? 'vapor'))]); actor.root.scale.setScalar(config.scale);
          actors.set(player.id, actor); host.setPlayerAppearance(player.id, actor.root, 'default');
        }
        // The shared host owns the player's position and yaw; do not copy private season fields.
        actor.update(player.presentation ?? {id: player.id, timeMs: frame.now});
      }
    },
    inspection() { return {actorCount: actors.size, actors: [...actors].slice(0, 4).map(([id, actor]) => ({id, ...actor.inspection()}))}; },
    dispose() { for (const id of [...actors.keys()]) remove(id); },
  };
};
export default createView;

