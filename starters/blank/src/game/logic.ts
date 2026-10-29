import type { GameLogic, GamePlayer, MatchContext, PlayerBody, PlayerList } from '../shared/gameApi.ts';
import { GAME_MODE_IDS } from '../shared/gameModes.ts';
import { applyCharacterMovement, moveCharacters } from '../sandbox/characters.ts';
import { preparePhysics } from '../sandbox/physics.ts';
import { groundPhysics, spawnPoint } from './ground.ts';
import { DEFAULT_MODE } from './mode.ts';
import { shapes, type BlankInput, type PlayerState, type WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { applyBlankLook, BLANK_POINTER_LOOK } from './look.ts';

// A blank canvas: flat ground, shared character movement and mouse look, and no
// rules of play yet. Every mode's host rules (rosters, timers, health, outcomes)
// apply unchanged; this content deals no damage, so nothing here decides a match.
// Build the game by adding state to shapes.ts, behavior here and visuals in view.ts.

type Context = MatchContext<WorldState, PlayerState, GameTuning>;

function respawnPlayer(_ctx: Context, player: GamePlayer<PlayerState>): void {
  const spawn = spawnPoint(player.index);
  Object.assign(player.state, { x: spawn.x, y: 0, z: spawn.z, facing: spawn.facing, aimPitch: -0.3,
    velocityX: 0, velocityY: 0, velocityZ: 0, grounded: 1 });
}
function setupPlayer(ctx: Context, player: GamePlayer<PlayerState>): void {
  player.hp = player.maxHp = ctx.tuning.maxHp;
  player.state.physicsId = player.index;
  respawnPlayer(ctx, player);
}
/** Inputs are relative to the participant's facing, so inspection "forward" is forward. */
function steer(state: PlayerState, input: BlankInput | undefined, tuning: GameTuning): void {
  applyBlankLook(state, input, tuning);
  const ahead = input?.moveZ ?? 0, side = input?.moveX ?? 0;
  const forwardX = Math.sin(state.facing), forwardZ = Math.cos(state.facing);
  applyCharacterMovement(state, { moveX: forwardX * ahead - forwardZ * side, moveZ: forwardZ * ahead + forwardX * side }, tuning.moveSpeed);
  if (input?.jump && state.grounded) { state.velocityY = tuning.jumpSpeed; state.grounded = 0; }
}
/** Shared by the server step and local prediction so both move identically. */
export function movePlayer(state: PlayerState, input: BlankInput | undefined, dt: number, tuning: GameTuning, others: readonly PlayerState[] = []): void {
  steer(state, input, tuning);
  moveCharacters([state, ...others.map(other => ({ ...other }))], dt, tuning, groundPhysics);
}

const game: GameLogic<WorldState, PlayerState, BlankInput, GameTuning> = {
  mode: DEFAULT_MODE, supportedModes: GAME_MODE_IDS,
  featureCapabilities: ['player.position.v1', 'player.vertical-motion.v1', 'player.appearance.v1'],
  shapes, setupPlayer, respawnPlayer,
  setupMatch(ctx) {
    ctx.world.elapsedMs = 0;
    preparePhysics(groundPhysics);
    for (const player of ctx.players) setupPlayer(ctx, player);
  },
  step({ world, players, inputs, tuning, elapsedMs, dtMs }) {
    world.elapsedMs = elapsedMs;
    const moving: PlayerState[] = [];
    for (const player of players) {
      if (player.active === false || player.hp <= 0) continue;
      steer(player.state, inputs[player.index], tuning);
      moving.push(player.state);
    }
    moveCharacters(moving, dtMs / 1000, tuning, groundPhysics);
  },
  entities({ players, tuning }) {
    const bodies = players.map(player => ({ at: { x: player.state.x, y: player.state.y, z: player.state.z },
      radius: tuning.fighterRadius, height: tuning.fighterHeight })) as PlayerList<PlayerBody>;
    return { bodies, damage: [] };
  },
  describePlayer: player => player.hp <= 0 ? 'DOWN' : player.state.grounded ? 'STANDING' : 'AIRBORNE',
  controls: {
    inspection: { forward: { moveZ: 1 }, right: { moveX: 1 }, jump: { jump: true } },
    bindings: [
      { name: 'moveX', label: 'Move sideways', kind: 'axis', role: 'move-x', keys: ['a', 'd'], description: 'Strafe left and right.' },
      { name: 'moveZ', label: 'Move forward', kind: 'axis', role: 'move-y', keys: ['s', 'w'], description: 'Walk forward and back.' },
      { name: 'jump', label: 'Jump', kind: 'held', keys: [' '] },
    ],
    pointer: { mode: 'lock' },
    writeInput(input, buttons, frame) {
      const me = frame.players.find(player => player.isLocal);
      if (!me || me.hp <= 0) return;
      input.moveX = buttons.value('moveX'); input.moveZ = buttons.value('moveZ');
      input.lookX = buttons.pointer.deltaX; input.lookY = buttons.pointer.deltaY;
      input.jump = buttons.held('jump');
    },
  },
  prediction: {
    pointerLook: BLANK_POINTER_LOOK,
    fields: ['x', 'y', 'z', 'facing', 'aimPitch', 'velocityX', 'velocityY', 'velocityZ', 'grounded'],
    snapFields: ['x', 'y', 'z'],
    step(state, input, dt, { tuning, opponents, opponent }) { movePlayer(state, input, dt, tuning, opponents ?? (opponent ? [opponent] : [])); },
  },
  smoothFields: ['x', 'y', 'z', 'facing', 'aimPitch'],
  hudLines: () => [],
};
export default game;
