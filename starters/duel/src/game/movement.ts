import type { FightInput, FighterState, TerrainWorld } from './shapes.ts';
import { moveFighters } from './physics.ts';
import type { GameTuning } from './tuning.ts';
import { DEFAULT_WORLD, terrainSpawns } from './terrain.ts';
import { applyCharacterMovement } from '../sandbox/characters.ts';
export interface Point { x: number; z: number }
export type MoveCommand = Pick<FightInput, 'moveX' | 'moveZ'>;
export const IDLE_MOVEMENT: MoveCommand = { moveX: 0, moveZ: 0 };
export const spawnPoints = (tuning: GameTuning, world: TerrainWorld = DEFAULT_WORLD) => terrainSpawns(world, tuning);
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
export const facingToward = (from: Point, to: Point) => Math.atan2(to.x - from.x, to.z - from.z);
export function applyMovementInput(me: FighterState, input: MoveCommand, tuning: GameTuning): void {
  if (me.combat.stunMs > 0 || me.combat.downMs > 0) applyCharacterMovement(me, IDLE_MOVEMENT, 0);
  else if (me.combat.dodgeMs > 0) applyCharacterMovement(me, { moveX: me.combat.dodgeX, moveZ: me.combat.dodgeZ }, tuning.dodgeSpeed);
  else {
    const busy = me.combat.attackState !== 'idle';
    applyCharacterMovement(me, input, tuning.moveSpeed * (me.combat.sprint ? tuning.sprintMultiplier : busy ? 0.38 : tuning.blockMoveMultiplier));
  }
  // Keep the requested velocity before collision response, for shared motion matching.
  me.intentX = me.velocityX; me.intentZ = me.velocityZ;
}
export function stepFighters(fighters: FighterState[], inputs: (MoveCommand | undefined)[], dt: number, tuning: GameTuning, world: TerrainWorld = DEFAULT_WORLD): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  fighters.forEach((fighter, i) => applyMovementInput(fighter, inputs[i] ?? IDLE_MOVEMENT, tuning));
  moveFighters(fighters, Math.min(dt, 0.25), tuning, world);
}
export function stepMovement(me: FighterState, input: MoveCommand, dt: number, tuning: GameTuning, opponent?: FighterState, world: TerrainWorld = DEFAULT_WORLD, opponents?: readonly FighterState[]): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  applyMovementInput(me, input, tuning);
  moveFighters([me, ...(opponents ?? (opponent ? [opponent] : [])).map(player => ({ ...player }))], Math.min(dt, 0.25), tuning, world);
}
