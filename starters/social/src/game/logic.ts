import type { DamageEntity, GameEvent, GameLogic, GamePlayer, MatchContext, PlayerBody, PlayerList } from '../shared/gameApi.ts';
import { GAME_MODE_IDS } from '../shared/gameModes.ts';
import { applyCharacterMovement, moveCharacters } from '../sandbox/characters.ts';
import { preparePhysics } from '../sandbox/physics.ts';
import { DRESSING_AREA, seatExit, seats, spawnPoints } from './layout.ts';
import { DEFAULT_MODE } from './mode.ts';
import { BUILTIN_PLAYER_MODELS } from './models.ts';
import { shapes, type LoungeInput, type PlayerState, type WorldState } from './shapes.ts';
import { CARD_COLORS, EMOTES, chooseTruthPrompt, completeTruthPrompt, createTables, drawAndPass, playSelectedCard, reconcileTables, startCardRound } from './socialGames.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain, safeLoungeSpawns } from './terrainWorld.ts';
import { loungeInspectionSetups } from './inspectionSetups.ts';
export { loungePhysics } from './terrainWorld.ts';

type Context = MatchContext<WorldState, PlayerState, GameTuning>;
const freshHeld = (): PlayerState['held'] => ({ wheel: false, left: false, right: false, up: false, down: false,
  secondary: false, truth: false, color: false, cancel: false, emote: 0 });
function respawnPlayer(ctx: Context, player: GamePlayer<PlayerState>): void {
  const spawn = sharedTerrain.read(ctx.tuning).contributionCount
    ? safeLoungeSpawns(ctx.tuning)[player.index % 32] : spawnPoints[player.index % spawnPoints.length];
  Object.assign(player.state, spawn, { y: 0, facing: Math.PI, aimPitch: 0, velocityX: 0, velocityY: 0, velocityZ: 0,
    grounded: 1, seatIndex: -1, eliminated: false, sitHeld: false, attackMs: 0, cooldownMs: 0,
    tableId: -1, hand: [], selectedCard: 0, selectedColor: 0, emoteId: 0, emoteStartedMs: 0, emoteUntilMs: 0,
    wheelOpen: false, wheelChoice: 0, held: freshHeld() });
}
function setupPlayer(ctx: Context, player: GamePlayer<PlayerState>): void {
  player.hp = player.maxHp = ctx.tuning.maxHp;
  Object.assign(player.state, { physicsId: player.index, attackId: 0 });
  respawnPlayer(ctx, player);
}
function stand(state: PlayerState, tuning: GameTuning): void {
  const seat = seats[state.seatIndex];
  if (seat) {
    const terrain = sharedTerrain.read(tuning), exit = seatExit(seat);
    const position = terrain.contributionCount
      ? terrain.spawns({ count: 1, radius: tuning.fighterRadius, height: tuning.fighterHeight, preferred: [exit] })[0]
      : { ...exit, y: 0 };
    Object.assign(state, position);
  }
  Object.assign(state, { seatIndex: -1, tableId: -1, grounded: 1, velocityX: 0, velocityY: 0, velocityZ: 0 });
}
function moving(input: LoungeInput | undefined): boolean {
  return !!input && (Math.hypot(input.moveX, input.moveZ) > .001 || input.jump);
}
function applyMovement(state: PlayerState, input: LoungeInput | undefined, tuning: GameTuning): void {
  state.facing -= Math.max(-1000, Math.min(1000, input?.lookX || 0)) * .003;
  state.aimPitch = Math.max(-1.35, Math.min(1.35, state.aimPitch - Math.max(-1000, Math.min(1000, input?.lookY || 0)) * .003));
  if (state.seatIndex >= 0 && moving(input)) stand(state, tuning);
  if (state.seatIndex >= 0) return;
  applyCharacterMovement(state, input, tuning.moveSpeed);
  if (input?.jump && state.grounded) { state.velocityY = tuning.jumpSpeed; state.grounded = 0; }
}
/** Shared movement keeps local prediction aligned with authoritative furniture collision. */
export function movePlayer(state: PlayerState, input: LoungeInput | undefined, dt: number, tuning: GameTuning, opponents: readonly PlayerState[] = []): void {
  if (state.eliminated) return;
  applyMovement(state, input, tuning);
  if (state.seatIndex >= 0) return;
  moveCharacters([state, ...opponents.filter(other => !other.eliminated && other.seatIndex < 0).map(other => ({ ...other }))], dt, tuning, sharedTerrain.read(tuning).scene);
}
function emote(state: PlayerState, id: number, now: number, duration: number): void {
  if (!Number.isInteger(id) || id < 1 || id > EMOTES.length) return;
  Object.assign(state, { emoteId: id, emoteStartedMs: now, emoteUntilMs: now + duration, wheelOpen: false });
}
const game: GameLogic<WorldState, PlayerState, LoungeInput, GameTuning> = {
  mode: DEFAULT_MODE, supportedModes: GAME_MODE_IDS, playerModels: BUILTIN_PLAYER_MODELS,
  featureCapabilities: ['player.position.v1', 'player.vertical-motion.v1', 'player.appearance.v1', 'world.terrain.v1'],
  terrainWorld: sharedTerrain, inspectionSetups: loungeInspectionSetups, shapes, setupPlayer, respawnPlayer,
  setupMatch(ctx) {
    ctx.world.elapsedMs = 0; ctx.world.tables = createTables();
    ctx.world.terrainRevision = sharedTerrain.read(ctx.tuning).revision;
    preparePhysics(sharedTerrain.read(ctx.tuning).scene);
    for (const player of ctx.players) setupPlayer(ctx, player);
  },
  step(ctx) {
    const { world, players, inputs, tuning, elapsedMs, dtMs, mode } = ctx;
    const events: GameEvent[] = [], actions: { player: GamePlayer<PlayerState>; input: LoungeInput | undefined; pressed: Record<string, boolean> }[] = [];
    world.elapsedMs = elapsedMs;
    for (const player of players) if (player.active === false && player.state.seatIndex >= 0) stand(player.state, tuning);
    const occupied = new Set(players.filter(player => player.active !== false && player.hp > 0).map(player => player.state.seatIndex));
    for (const player of [...players].sort((a, b) => a.index - b.index)) {
      const state = player.state, input = inputs[player.index];
      state.eliminated = player.hp <= 0;
      state.attackMs = Math.max(0, state.attackMs - dtMs); state.cooldownMs = Math.max(0, state.cooldownMs - dtMs);
      if (player.active === false || state.eliminated) {
        if (state.seatIndex >= 0) { occupied.delete(state.seatIndex); stand(state, tuning); }
        state.attackMs = 0; state.emoteId = 0; state.wheelOpen = false;
        continue;
      }
      const pressed: Record<string, boolean> = { sit: !!input?.sit && !state.sitHeld };
      state.sitHeld = !!input?.sit;
      for (const key of ['wheel', 'left', 'right', 'up', 'down', 'secondary', 'truth', 'color', 'cancel'] as const) {
        pressed[key] = !!input?.[key] && !state.held[key]; state.held[key] = !!input?.[key];
      }
      const emoteInput = Number.isInteger(input?.emote) ? input!.emote : 0;
      pressed.emote = emoteInput > 0 && emoteInput !== state.held.emote; state.held.emote = emoteInput;
      if (elapsedMs >= state.emoteUntilMs || moving(input)) state.emoteId = 0;
      if (pressed.wheel) state.wheelOpen = !state.wheelOpen;
      const handledWheel = state.wheelOpen;
      if (state.wheelOpen) {
        if (pressed.left || pressed.up) state.wheelChoice = (state.wheelChoice + EMOTES.length - 1) % EMOTES.length;
        if (pressed.right || pressed.down) state.wheelChoice = (state.wheelChoice + 1) % EMOTES.length;
        if (pressed.sit && !pressed.cancel && !moving(input)) emote(state, state.wheelChoice + 1, elapsedMs, tuning.emoteDurationMs);
        if (pressed.cancel) state.wheelOpen = false;
      } else if (pressed.cancel) {
        state.emoteId = 0;
        if (state.seatIndex >= 0) { occupied.delete(state.seatIndex); stand(state, tuning); events.push({ type: 'stand', player: player.index }); }
      }
      if (pressed.emote && !pressed.cancel && !moving(input)) emote(state, emoteInput, elapsedMs, tuning.emoteDurationMs);
      const oldSeat = state.seatIndex;
      if (oldSeat >= 0 && (moving(input) || (!handledWheel && state.tableId < 0 && pressed.sit))) {
        occupied.delete(oldSeat); stand(state, tuning); events.push({ type: 'stand', player: player.index });
      } else if (oldSeat < 0 && pressed.sit && !handledWheel && !pressed.cancel && !moving(input) && Math.abs(state.y) < 1.25) {
        const nearest = seats.map((seat, index) => ({ seat, index, distance: Math.hypot(seat.x - state.x, seat.z - state.z) }))
          .filter(candidate => !occupied.has(candidate.index) && candidate.distance <= tuning.sitDistance)
          .sort((a, b) => a.distance - b.distance || a.index - b.index)[0];
        if (nearest) {
          Object.assign(state, { x: nearest.seat.x, y: nearest.seat.y, z: nearest.seat.z, facing: nearest.seat.facing, aimPitch: 0,
            seatIndex: nearest.index, tableId: nearest.seat.tableId ?? -1, velocityX: 0, velocityY: 0, velocityZ: 0, grounded: 1 });
          occupied.add(nearest.index); events.push({ type: 'sit', player: player.index, seat: nearest.index });
          pressed.sit = false;
        }
      }
      applyMovement(state, input, tuning);
      if (!handledWheel && !pressed.cancel) actions.push({ player, input, pressed });
      if (mode !== 'just-chatting' && state.seatIndex < 0 && !state.wheelOpen && input?.attack && state.cooldownMs <= 0) {
        state.attackId++; state.attackMs = tuning.attackDurationMs; state.cooldownMs = tuning.attackCooldownMs;
        events.push({ type: 'attack', player: player.index });
      }
    }
    reconcileTables(world.tables, players);
    for (const { player, pressed } of actions) {
      const state = player.state, table = world.tables.find(table => table.id === state.tableId);
      if (!table || state.seatIndex < 0) continue;
      if (table.kind === 'truth') {
        if (pressed.sit) completeTruthPrompt(table, player);
        else if (pressed.truth || pressed.secondary) chooseTruthPrompt(table, player, pressed.secondary ? 'dare' : 'truth');
      } else {
        if (pressed.left || pressed.up) state.selectedCard = (state.selectedCard + Math.max(1, state.hand.length) - 1) % Math.max(1, state.hand.length);
        if (pressed.right || pressed.down) state.selectedCard = (state.selectedCard + 1) % Math.max(1, state.hand.length);
        if (pressed.color) state.selectedColor = (state.selectedColor + 1) % CARD_COLORS.length;
        const random = () => ctx.random(`lounge-table-${table.id}`);
        if (table.phase !== 'playing') { if (pressed.truth || pressed.sit) startCardRound(table, players, random); }
        else if (pressed.sit) playSelectedCard(table, player, players, random);
        else if (pressed.secondary) drawAndPass(table, player, players, random);
      }
    }
    moveCharacters(players.filter(player => player.active !== false && player.hp > 0 && player.state.seatIndex < 0).map(player => player.state), dtMs / 1000, tuning, sharedTerrain.read(tuning).scene);
    return events;
  },
  entities({ players, tuning, mode }) {
    const bodies = players.map(player => ({ at: { x: player.state.x, y: player.state.y, z: player.state.z },
      radius: tuning.fighterRadius, height: tuning.fighterHeight, guard: player.hp > 0 ? 1 : 0 })) as PlayerList<PlayerBody>;
    const damage: DamageEntity[] = [];
    if (mode !== 'just-chatting') for (const player of players) {
      const state = player.state;
      if (player.active === false || player.hp <= 0 || state.attackMs <= 0) continue;
      damage.push({ id: `punch-${player.index}-${state.attackId}`, label: 'punch', kind: 'strike', owner: player.index,
        damage: tuning.attackDamage, shape: 'sphere', radius: tuning.attackReach * .4,
        at: { x: state.x + Math.sin(state.facing) * tuning.attackReach * .6, y: state.y + tuning.fighterHeight / 2,
          z: state.z + Math.cos(state.facing) * tuning.attackReach * .6 } });
    }
    return { bodies, damage };
  },
  describePlayer: player => player.hp <= 0 ? 'DOWN' : player.state.emoteId ? EMOTES[player.state.emoteId - 1]?.name ?? 'EMOTING'
    : player.state.tableId >= 0 ? 'AT A GAME TABLE' : player.state.seatIndex >= 0 ? 'RELAXING' : 'EXPLORING',
  controls: {
    inspection: { forward: { moveZ: -1 }, right: { moveX: 1 }, jump: { jump: true } },
    bindings: [
      { name: 'moveX', label: 'Move sideways', kind: 'axis', role: 'move-x', keys: ['a', 'd'], description: 'Strafe left and right.' },
      { name: 'moveZ', label: 'Move forward', kind: 'axis', role: 'move-y', keys: ['s', 'w'], description: 'Walk forward and back.' },
      { name: 'sit', label: 'Confirm', kind: 'held', keys: ['e'], description: 'Sit at a table, perform the chosen emote, play a card, or pass.' },
      { name: 'jump', label: 'Jump', kind: 'held', keys: [' '] },
      { name: 'wheel', label: 'Emotes', kind: 'held', keys: ['q'], description: 'Open the emote wheel.' },
      { name: 'left', label: 'Previous', kind: 'held', keys: ['arrowleft', 'arrowup'], description: 'Choose the previous emote or card.' },
      { name: 'right', label: 'Next', kind: 'held', keys: ['arrowright', 'arrowdown'], description: 'Choose the next emote or card.' },
      { name: 'secondary', label: 'Draw / dare', kind: 'held', keys: ['r'], description: 'Draw a card and pass, or ask for a dare.' },
      { name: 'truth', label: 'Start / truth', kind: 'held', keys: ['t'], description: 'Start a round at your table, or ask for a truth.' },
      { name: 'color', label: 'Wild color', kind: 'held', keys: ['c'], description: 'Cycle the color a wild card will take.' },
      { name: 'cancel', label: 'Leave', kind: 'held', keys: ['x'], description: 'Leave the table, close the wheel, or stop an emote.' },
    ],
    pointer: { mode: 'lock' },
    writeInput(input, buttons, frame) {
      const me = frame.players.find(player => player.isLocal);
      if (!me || me.hp <= 0) return;
      const ahead = buttons.value('moveZ'), side = buttons.value('moveX');
      const forwardX = frame.view.forwardX ?? Math.sin(me.state.facing), forwardZ = frame.view.forwardZ ?? Math.cos(me.state.facing);
      input.moveX = forwardX * ahead - forwardZ * side; input.moveZ = forwardZ * ahead + forwardX * side;
      input.lookX = buttons.pointer.deltaX; input.lookY = buttons.pointer.deltaY;
      for (const key of ['sit', 'jump', 'wheel', 'left', 'right', 'secondary', 'truth', 'color', 'cancel'] as const) input[key] = buttons.held(key);
      input.up = false; input.down = false; input.emote = 0; input.attack = false;
    },
  },
  prediction: {
    fields: ['x', 'y', 'z', 'facing', 'aimPitch', 'velocityX', 'velocityY', 'velocityZ', 'grounded', 'seatIndex'],
    snapFields: ['x', 'y', 'z'],
    step(state, input, dt, { tuning, opponents, opponent }) { movePlayer(state, input, dt, tuning, opponents ?? (opponent ? [opponent] : [])); },
  },
  smoothFields: ['x', 'y', 'z'],
  hudLines(frame) {
    const me = frame.players.find(player => player.isLocal);
    if (!me) return ['The Afterglow Lounge', 'Meet friends, try a table game, and make yourself at home.'];
    const state = me.state, table = frame.world?.tables?.find(table => table.id === state.tableId);
    if (state.wheelOpen) return ['Emote wheel · Choose an emote, then confirm', EMOTES[state.wheelChoice]?.name ?? 'Wave'];
    if (table?.kind === 'cards') return [table.phase === 'waiting' ? 'Color Clash · Two to four seated players · Start when ready' : table.message,
      'Match the top color or symbol · Draw and pass when stuck · Wild cards take your chosen color'];
    if (table?.kind === 'truth') return [table.prompt || 'Truth or Dare · Ask for a truth or a dare', 'Every prompt is optional · Answer in chat or out loud · Leave any time'];
    if (Math.hypot(state.x - DRESSING_AREA.x, state.z - DRESSING_AREA.z) <= DRESSING_AREA.radius)
      return ['The dressing mirror · See your look from head to toe', 'Use the Avatar button to change your look · Try an emote'];
    return ['Welcome to Afterglow · Find a seat at a glowing game table', 'Sit down to join a game · Open the emote wheel · Chat with your neighbors'];
  },
};
export default game;
