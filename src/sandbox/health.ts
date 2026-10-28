// Locked health rules. They apply wherever a match runs: live rooms, replay
// checks, training and the game's own tests. Direct health writes are ignored.
// Arena and cooperative RPG permit checked contact healing; RPG also has teammate revives;
// legacy RPG uses automatic respawns. Just Chatting ignores damage entirely.
//
// - The game sets hp and maxHp at match setup. After that, health changes only
//   by checked damage/recovery the core applies; direct hp writes are ignored.
// - Duel health never goes up. Arena healing cannot revive. maxHp is fixed.
// - Cooperative RPG requires a 3-second teammate revive; all downed means defeat.
//   Legacy RPG restores health after 3 seconds without a teammate.
// - A fighter at 0 health is eliminated. Duels stop immediately; Arena
//   continues until at most one survivor remains (zero survivors is a draw).
//   The live room continues the scene for its finish window with health held.
//   (Unrated training only: after the knockout pause the core itself, never the
//   game, puts the knocked-out fighter back at full health; see GameRoom.)

import type { GameModeId } from '../shared/gameModes.ts';
import { gameRules, tagsFromLegacy, teamStandings, type GameRules } from '../shared/gameTags.ts';
import type { CooperativeOutcome } from '../shared/gameApi.ts';
import { touches, type CheckedEntities } from './damage.ts';

export interface Health {
  hp: number;
  maxHp: number;
}

export const RPG_RESPAWN_MS = 3000;

/** Locked session lifecycle, shared by host simulation and standalone game tests.
 * Deadlines belong to the core; a game cannot request an early respawn or heal. */
export function sessionHealth(mode: GameModeId, health: readonly Health[], respawnAt: (number | null)[], elapsedMs: number, dtMs: number, active?: readonly boolean[], cooperative = false, rules: GameRules = gameRules(tagsFromLegacy(mode))): { health: Health[]; respawned: number[] } {
  const respawned: number[] = [];
  return { health: health.map((player, index) => {
    if (active?.[index] === false) { respawnAt[index] = null; return { hp: 0, maxHp: player.maxHp }; }
    // Just Chatting and creative rounds pin health: nothing can hurt anyone.
    if (!rules.damage) return { hp: player.maxHp, maxHp: player.maxHp };
    // Open worlds respawn a knocked-out player after the rules' delay; cooperative parties revive instead.
    if (!rules.respawnMs || cooperative) return { ...player };
    if (player.hp > 0) { respawnAt[index] = null; return { ...player }; }
    respawnAt[index] ??= elapsedMs - dtMs + rules.respawnMs;
    if (elapsedMs < respawnAt[index]!) return { ...player };
    respawnAt[index] = null;
    respawned.push(index);
    return { hp: player.maxHp, maxHp: player.maxHp };
  }), respawned };
}

/** Survival hunger (docs/game-rule-flags.md): a host-owned drain on every living, active
 * participant, applied before content damage so a lethal hit still lands on a starving
 * fighter and checked healing can answer it on the same tick. Deterministic per tick. */
export function attrition(health: readonly Health[], rules: GameRules, dtMs: number, active?: readonly boolean[]): Health[] {
  if (!rules.attritionMs || !rules.damage || !(dtMs > 0)) return health.map(player => ({ ...player }));
  return health.map((player, index) => active?.[index] === false || player.hp <= 0 ? { ...player }
    : { hp: Math.max(0, player.hp - player.maxHp * dtMs / rules.attritionMs), maxHp: player.maxHp });
}

export const COOPERATIVE_REVIVE_MS = 3000;
export const COOPERATIVE_REVIVE_RANGE = 3;

export interface CooperativeState {
  reviveMs: number[];
  revivers: number[];
  healed: Set<string>;
}

export function newCooperativeState(): CooperativeState {
  return { reviveMs: [], revivers: [], healed: new Set() };
}

/** Checked one-shot recovery shared by Arena and cooperative RPG. Call after
 * damage: a lethal hit always wins, even if that tick also emits a healing pulse.
 * Retain only current pulses so persistent sessions use bounded bookkeeping.
 * Authors must use a fresh ID for every use, as with damage strikes. */
export function contactHealing(health: readonly Health[], entities: CheckedEntities | null,
  healed: Set<string>, active?: readonly boolean[], damage?: readonly number[], teams?: readonly number[]): Health[] {
  const next = health.map(player => ({ ...player }));
  const alive = health.map((player, index) => player.hp > 0 && active?.[index] !== false);
  const activeHealing = new Set((entities?.healing ?? []).map(entity => entity.id));
  for (const key of healed) if (!activeHealing.has(key.slice(key.indexOf('|') + 1))) healed.delete(key);
  for (const entity of entities?.healing ?? []) {
    if (!alive[entity.owner]) continue;
    for (let target = 0; target < next.length; target++) {
      if (!alive[target] || (entity.target !== undefined && target !== entity.target)) continue;
      // Team games: healing reaches teammates only.
      if (teams && teams[entity.owner] !== teams[target]) continue;
      const key = `${target}|${entity.id}`;
      if (healed.has(key) || !touches({ ...entity, shape: 'sphere', kind: 'strike', damage: 0 }, entities!.bodies[target])) continue;
      healed.add(key);
      if (entity.interruptOnDamage && (damage?.[target] ?? 0) > 0) continue;
      next[target].hp = Math.min(next[target].maxHp, next[target].hp + entity.amount);
    }
  }
  return next;
}

/** Host-owned recovery. Damage resolves first, so a teammate downed on this
 * tick cannot heal or finish a revive. One helper channels one nearest target. */
export function cooperativeRecovery(health: readonly Health[], entities: CheckedEntities | null,
  inputs: readonly unknown[], reviveInput: string, dtMs: number, state: CooperativeState, active?: readonly boolean[], damage?: readonly number[]): {
    health: Health[]; reviveProgress: number[]; revived: number[];
  } {
  const next = contactHealing(health, entities, state.healed, active, damage);
  const alive = health.map((player, index) => player.hp > 0 && active?.[index] !== false);
  const helpers = Array<number>(next.length).fill(-1);
  if (entities) for (let helper = 0; helper < next.length; helper++) {
    const input = inputs[helper];
    if (!alive[helper] || !input || typeof input !== 'object' || (input as Record<string, unknown>)[reviveInput] !== true) continue;
    const at = entities.bodies[helper].at;
    let nearest = -1, distance = COOPERATIVE_REVIVE_RANGE ** 2;
    for (let target = 0; target < next.length; target++) {
      if (active?.[target] === false || health[target].hp > 0 || target === helper) continue;
      const to = entities.bodies[target].at;
      const squared = (at.x - to.x) ** 2 + (at.y - to.y) ** 2 + (at.z - to.z) ** 2;
      if (squared <= distance && (squared < distance || nearest < 0)) { nearest = target; distance = squared; }
    }
    // An additional helper must not steal and restart an existing channel.
    if (nearest >= 0 && (helpers[nearest] < 0 || state.revivers[nearest] === helper)) helpers[nearest] = helper;
  }
  const revived: number[] = [], reviveProgress = Array<number>(next.length).fill(0);
  for (let target = 0; target < next.length; target++) {
    const helper = helpers[target];
    if (helper < 0) { state.reviveMs[target] = 0; state.revivers[target] = -1; continue; }
    if (state.revivers[target] !== helper) state.reviveMs[target] = 0;
    state.revivers[target] = helper;
    state.reviveMs[target] = (state.reviveMs[target] ?? 0) + Math.max(0, dtMs);
    reviveProgress[target] = Math.min(1, state.reviveMs[target] / COOPERATIVE_REVIVE_MS);
    if (state.reviveMs[target] < COOPERATIVE_REVIVE_MS) continue;
    next[target].hp = next[target].maxHp * 0.5;
    state.reviveMs[target] = 0; state.revivers[target] = -1;
    revived.push(target);
  }
  return { health: next, reviveProgress, revived };
}

/** Objective completion is content-owned; party survival and defeat priority
 * are locked and evaluated using post-damage, post-recovery authoritative HP. */
export function cooperativeOutcome(health: readonly Health[], complete: boolean, active?: readonly boolean[]): CooperativeOutcome | undefined {
  const party = health.filter((_, index) => active?.[index] !== false);
  if (!party.length) return undefined;
  if (party.every(player => player.hp <= 0)) return 'defeat';
  if (complete && party.every(player => player.hp > 0)) return 'victory';
  return undefined;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A fighter's health at match setup: between 0 and maxHp (maxHp above 0). Bad values fall back. */
export function healthAtSetup(hp: unknown, maxHp: unknown, fallback: Health): Health {
  const max = finite(maxHp) && maxHp > 0 ? maxHp : fallback.maxHp;
  return { hp: Math.max(0, Math.min(max, finite(hp) ? hp : fallback.hp)), maxHp: max };
}

/** A fighter's health after a fight step: what it was, minus the damage the core applied. */
export function healthAfterDamage(before: Health, damage: number): Health {
  return { hp: Math.max(0, before.hp - (finite(damage) && damage > 0 ? damage : 0)), maxHp: before.maxHp };
}

/** True when a fighter is out of health: the match is over. */
export function knockedOut(fighters: readonly Health[]): boolean {
  return fighters.some((fighter) => fighter.hp <= 0);
}

/** A duel stops on the first knockout; one-life rounds continue until at most one survivor
 * (or one team) remains; open and non-competitive sessions never finish here. */
export function matchFinished(fighters: readonly Health[], mode: GameModeId = 'duel', rules: GameRules = gameRules(tagsFromLegacy(mode)), teams?: readonly number[]): boolean {
  if (rules.openSession || !rules.competitive) return false;
  if (rules.teams && teams) return teamStandings(rules, fighters.map((fighter, index) => ({ team: teams[index], hp: fighter.hp }))).filter(team => team.alive > 0).length <= 1;
  return rules.oneLife ? fighters.filter(fighter => fighter.hp > 0).length <= 1 : knockedOut(fighters);
}
