import type { GameEvent, GamePlayer, MatchContext, StepContext } from '../shared/gameApi.ts';
import { GAME_MODE_IDS } from '../shared/gameModes.ts';
import { facingToward, stepFighters } from './movement.ts';
import { participantSpawns, type Vec3 } from './terrain.ts';
import { ATTACK_STATES, type AttackState, type FightInput, type FighterState, type WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { preparePhysics } from '../sandbox/physics.ts';
import { arenaPhysics, physicsLineClear } from './physics.ts';
import { sharedTerrain } from './terrainWorld.ts';
import { createInput } from './controls.ts';
type Fighter = GamePlayer<FighterState>;
type Action = { player: Fighter; kind: 'light' | 'heavy' | 'bash'; lane: number; charge: number; sequence: number };
export const SUPPORTED_MODES = GAME_MODE_IDS;

export function setupMatch(ctx: MatchContext<WorldState, FighterState, GameTuning>): void {
  ctx.world.strikes = []; ctx.world.elapsedMs = 0;
  ctx.world.terrainRevision = sharedTerrain.read(ctx.tuning).revision;
  preparePhysics(arenaPhysics(ctx.world, ctx.tuning));
  const spawns = participantSpawns(ctx.world, ctx.tuning, Math.max(2, ctx.players.length));
  ctx.players.forEach(player => {
    player.hp = player.maxHp = ctx.tuning.maxHp;
    initializePlayer(player, spawns[player.index]);
  });
}
export function setupPlayer(ctx: MatchContext<WorldState, FighterState, GameTuning>, player: Fighter): void {
  player.hp = player.maxHp = ctx.tuning.maxHp;
  const spawn = participantSpawns(ctx.world, ctx.tuning, Math.max(2, ctx.players.length))[player.index];
  initializePlayer(player, spawn);
}
function initializePlayer(player: Fighter, spawn: Vec3): void {
  Object.assign(player.state, spawn, { physicsId: player.index, velocityX: 0, velocityY: 0, velocityZ: 0, intentX: 0, intentZ: 0, grounded: 1,
    facing: facingToward(spawn, { x: 0, z: 0 }), aimPitch: 0,
    combat: { guard: 1, guardAgeMs: 1000, isBlocking: true,
      attackState: 'idle', actionMs: 0, actionDurationMs: 0, attackGuard: 1, attackSeq: 0, chargeMs: 0, stunMs: 0,
      dodgeMs: 0, dodgeX: 0, dodgeZ: 0, sprint: false, downMs: 0, actionFeedback: '', feedbackMs: 0, feedbackSeq: 0 },
    previousAttack: false, previousHeavy: false, previousBash: false, previousDodge: false, previousGuard: 0,
    dodgeHeldMs: 0, dodgeCooldownMs: 0, parryRearmMs: 0, lastBashMs: -10000 });
  captureMovementPrediction(player.state);
}
export const respawnPlayer = setupPlayer;

/** The browser replays local intentions only. Contact, damage and their stun
 * outcomes come from the next authoritative snapshot, never a guessed target. */
export function captureMovementPrediction(s: FighterState): void {
  const { previousGuard, dodgeHeldMs, dodgeCooldownMs, parryRearmMs, lastBashMs } = s;
  const { guard, guardAgeMs, actionMs, actionDurationMs, attackGuard, chargeMs, stunMs, dodgeMs, dodgeX, dodgeZ } = s.combat;
  s.motion = { phase: ATTACK_STATES.indexOf(s.combat.attackState),
    buttons: (s.previousAttack ? 1 : 0) | (s.previousHeavy ? 2 : 0) | (s.previousBash ? 4 : 0) | (s.previousDodge ? 8 : 0),
    previousGuard, guard, guardAgeMs, actionMs, actionDurationMs, attackGuard, chargeMs, stunMs,
    dodgeMs, dodgeX, dodgeZ, dodgeHeldMs, dodgeCooldownMs, parryRearmMs, lastBashMs };
}
export function restoreMovementPrediction(s: FighterState): void {
  const { phase, buttons, previousGuard, dodgeHeldMs, dodgeCooldownMs, parryRearmMs, lastBashMs, ...combat } = s.motion;
  Object.assign(s.combat, combat, { attackState: ATTACK_STATES[phase] });
  Object.assign(s, { previousGuard, dodgeHeldMs, dodgeCooldownMs, parryRearmMs, lastBashMs, previousAttack: !!(buttons & 1),
    previousHeavy: !!(buttons & 2), previousBash: !!(buttons & 4), previousDodge: !!(buttons & 8) });
}

function begin(state: FighterState, kind: AttackState, ms: number): void {
  state.combat.attackState = kind; state.combat.actionMs = state.combat.actionDurationMs = ms;
  state.combat.attackGuard = state.combat.guard; state.combat.attackSeq++; state.combat.sprint = false; state.combat.isBlocking = false;
}
function feedback(state: FighterState, name: string): void {
  state.combat.actionFeedback = name; state.combat.feedbackMs = 500; state.combat.feedbackSeq++;
}
function recover(state: FighterState, ms: number): void {
  state.combat.attackState = 'recovery'; state.combat.actionMs = state.combat.actionDurationMs = ms; state.combat.isBlocking = false;
}
function stun(state: FighterState, ms: number): void {
  state.combat.stunMs = Math.max(state.combat.stunMs, ms); state.combat.attackState = 'stunned';
  state.combat.actionMs = state.combat.actionDurationMs = state.combat.stunMs; state.combat.isBlocking = false; state.combat.sprint = false; state.combat.chargeMs = 0;
}
export function applyLook(state: FighterState, input: FightInput): void {
  state.facing -= Math.max(-1000, Math.min(1000, input.lookX || 0)) * 0.003;
  state.aimPitch = Math.max(-0.7, Math.min(0.85, state.aimPitch - (input.lookY || 0) * 0.002));
}
function guardMask(input: FightInput): number { return (input.guardLeft ? 1 : 0) | (input.guardUp ? 2 : 0) | (input.guardRight ? 4 : 0); }
export function advanceLocal(s: FighterState, cmd: FightInput, dt: number, now: number, tuning: GameTuning,
  emit?: (type: string) => void): Omit<Action, 'player'> | undefined {
  s.combat.guardAgeMs = Math.min(10000, s.combat.guardAgeMs + dt);
  s.parryRearmMs = Math.max(0, s.parryRearmMs - dt); s.combat.feedbackMs = Math.max(0, s.combat.feedbackMs - dt);
  s.dodgeCooldownMs = Math.max(0, s.dodgeCooldownMs - dt); s.combat.stunMs = Math.max(0, s.combat.stunMs - dt);
  s.combat.dodgeMs = Math.max(0, s.combat.dodgeMs - dt);
  let connecting: Omit<Action, 'player'> | undefined;
  if (s.combat.attackState !== 'idle' && s.combat.attackState !== 'charging') {
    // A 400ms windup is exactly twelve 30Hz ticks; floating point residue must not add a thirteenth.
    s.combat.actionMs = Math.max(0, s.combat.actionMs - dt);
    if (s.combat.actionMs < 0.00001) s.combat.actionMs = 0;
    if (s.combat.actionMs <= 0) {
      if (s.combat.attackState === 'light' || s.combat.attackState === 'heavy' || s.combat.attackState === 'bash') {
        connecting = { kind: s.combat.attackState, lane: s.combat.attackGuard, charge: s.combat.chargeMs, sequence: s.combat.attackSeq };
        recover(s, s.combat.attackState === 'heavy' ? tuning.heavyRecoveryMs : s.combat.attackState === 'bash' ? tuning.bashRecoveryMs : tuning.attackRecoveryMs);
      } else { s.combat.attackState = 'idle'; s.combat.chargeMs = 0; }
    }
  }
  applyLook(s, cmd);
  const mask = guardMask(cmd);
  if (mask && mask !== s.previousGuard && s.combat.stunMs <= 0) {
    s.combat.guard = cmd.guardUp ? 1 : cmd.guardLeft ? 0 : 2;
    if (s.parryRearmMs <= 0) { s.combat.guardAgeMs = 0; s.parryRearmMs = tuning.parryRearmMs; }
  }
  const freshAttack = cmd.attack && !s.previousAttack, freshHeavy = cmd.heavy && !s.previousHeavy;
  const freshBash = cmd.bash && !s.previousBash;
  const releasedDodge = !cmd.dodge && s.previousDodge;
  if (cmd.dodge) s.dodgeHeldMs += dt;
  const canAct = s.combat.stunMs <= 0 && (s.combat.attackState === 'idle' || s.combat.attackState === 'charging');
  if (releasedDodge && s.dodgeHeldMs < tuning.sprintHoldMs && canAct && s.dodgeCooldownMs <= 0) {
    const length = Math.hypot(cmd.moveX, cmd.moveZ);
    s.combat.dodgeX = length > 0.1 ? cmd.moveX / length : -Math.sin(s.facing);
    s.combat.dodgeZ = length > 0.1 ? cmd.moveZ / length : -Math.cos(s.facing);
    s.combat.dodgeMs = tuning.dodgeDurationMs; s.dodgeCooldownMs = tuning.dodgeCooldownMs;
    s.combat.chargeMs = 0; begin(s, 'dodge', tuning.dodgeDurationMs); emit?.('dodge');
  } else if (canAct && freshBash) {
    s.combat.chargeMs = 0; s.lastBashMs = now; begin(s, 'bash', tuning.bashWindupMs); emit?.('bash');
  } else if (s.combat.attackState === 'charging') {
    s.combat.chargeMs = Math.min(tuning.heavyChargeMs, s.combat.chargeMs + dt);
    if (!cmd.heavy) { begin(s, 'heavy', tuning.heavyWindupMs); emit?.('heavy'); }
  } else if (s.combat.attackState === 'idle' && s.combat.stunMs <= 0) {
    if (freshAttack) { s.combat.chargeMs = 0; begin(s, 'light', tuning.attackWindupMs); emit?.('light'); }
    else if (freshHeavy) { s.combat.chargeMs = 0; begin(s, 'charging', tuning.heavyChargeMs); emit?.('charge'); }
  }
  s.combat.sprint = s.combat.attackState === 'idle' && s.combat.stunMs <= 0 && cmd.dodge && s.dodgeHeldMs >= tuning.sprintHoldMs && Math.hypot(cmd.moveX, cmd.moveZ) > 0.1;
  s.combat.isBlocking = s.combat.attackState === 'idle' && s.combat.stunMs <= 0 && !s.combat.sprint;
  if (!cmd.dodge) s.dodgeHeldMs = 0;
  s.previousAttack = cmd.attack; s.previousHeavy = cmd.heavy; s.previousBash = cmd.bash; s.previousDodge = cmd.dodge; s.previousGuard = mask;
  return connecting;
}
function inReach(a: FighterState, b: FighterState, reach: number): boolean {
  const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  return length <= reach && Math.abs(a.y - b.y) < 1.2 && (length < 0.01 || (dx * Math.sin(a.facing) + dz * Math.cos(a.facing)) / length > 0.28);
}
/** Both actors advance before contact resolution. Simultaneous attacks are evaluated from the same snapshot. */
export function step({ players, inputs, tuning, dtMs, world, mode }: StepContext<WorldState, FighterState, FightInput, GameTuning>): GameEvent[] {
  const events: GameEvent[] = [], dt = Math.max(0, Math.min(250, dtMs));
  world.strikes = []; world.elapsedMs += dt;
  const living = players.filter(player => player.hp > 0 && player.active !== false);
  // The browser predicts from synced state alone: a knight arriving without the
  // authority's working values rebuilds them from the mirror the last step recorded.
  for (const player of living) if (player.state.dodgeCooldownMs === undefined) restoreMovementPrediction(player.state);
  const actions: Action[] = [];
  for (const player of living) {
    const action = advanceLocal(player.state, inputs[player.index] ?? createInput(), dt, world.elapsedMs, tuning,
      type => events.push({ type, player: player.index }));
    if (action && mode !== 'just-chatting') actions.push({ player, ...action });
  }
  stepFighters(living.map(player => player.state), living.map(player => inputs[player.index]), dt / 1000, tuning, world);
  const snapshots = new Map(living.map(player => [player.index, { ...player.state, combat: { ...player.state.combat } }]));
  const countered = new Set<number>();
  for (const action of actions) {
    const attacker = action.player, a = snapshots.get(attacker.index)!;
    const target = living.filter(player => player.index !== attacker.index)
      .filter(player => inReach(a, snapshots.get(player.index)!, action.kind === 'bash' ? tuning.bashRange : tuning.attackRange))
      .sort((left, right) => Math.hypot(left.state.x - a.x, left.state.z - a.z) - Math.hypot(right.state.x - a.x, right.state.z - a.z))[0];
    if (!target) continue;
    const b = snapshots.get(target.index)!, live = target.state;
    if (!physicsLineClear({ x: a.x, y: a.y + 1.1, z: a.z }, { x: b.x, y: b.y + 1.1, z: b.z }, world, tuning)) continue;
    const dodgeAge = tuning.dodgeDurationMs - b.combat.dodgeMs;
    if (b.combat.dodgeMs > 0 && dodgeAge >= tuning.dodgeInvulnerableStartMs && dodgeAge <= tuning.dodgeInvulnerableEndMs) {
      feedback(live, 'evade'); events.push({ type: 'evade', player: target.index }); continue;
    }
    if (action.kind === 'bash') {
      if (world.elapsedMs - b.lastBashMs <= tuning.bashCounterMs && (b.combat.attackState === 'bash' || b.combat.attackState === 'recovery')) {
        countered.add(attacker.index); countered.add(target.index);
        feedback(attacker.state, 'hiltCounter'); feedback(live, 'hiltCounter');
        events.push({ type: 'hiltCounter', player: target.index, target: attacker.index });
      } else {
        stun(live, tuning.bashStunMs); feedback(live, 'hiltHit'); events.push({ type: 'hiltHit', player: attacker.index, target: target.index });
      }
      continue;
    }
    const facesAttacker = inReach(b, a, tuning.attackRange + 0.2);
    if (b.combat.isBlocking && b.combat.guard === action.lane && facesAttacker) {
      if (b.combat.guardAgeMs <= tuning.parryWindowMs) {
        stun(attacker.state, tuning.parryStunMs); feedback(live, 'parry'); feedback(attacker.state, 'parried');
        events.push({ type: 'parry', player: target.index, target: attacker.index });
      } else { feedback(live, 'block'); events.push({ type: 'block', player: target.index, target: attacker.index }); }
      continue;
    }
    const damage = action.kind === 'heavy' ? tuning.heavyDamage + tuning.heavyChargeDamage * action.charge / tuning.heavyChargeMs : tuning.attackDamage;
    world.strikes.push({ id: action.sequence, owner: attacker.index, target: target.index, damage, x: b.x, y: b.y + tuning.fighterHeight * 0.55, z: b.z, fromX: a.x, fromZ: a.z });
    stun(live, tuning.hitStunMs); feedback(live, 'hit'); events.push({ type: 'hit', player: attacker.index, target: target.index, damage });
  }
  for (const index of countered) { const state = players[index].state; state.combat.stunMs = 0; recover(state, tuning.bashRecoveryMs); }
  for (const player of living) captureMovementPrediction(player.state);
  return events;
}
