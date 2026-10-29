import type { GameShapes, InputOf, StateOf } from '../shared/gameApi.ts';
export const ATTACK_STATES = ['idle', 'light', 'charging', 'heavy', 'bash', 'recovery', 'stunned', 'dodge'] as const;
export type AttackState = typeof ATTACK_STATES[number];
export const GUARD_NAMES = ['LEFT', 'HIGH', 'RIGHT'] as const;
export const shapes = {
  world: { terrain: {}, terrainRevision: 'string', elapsedMs: 'number',
    strikes: [{ id: 'number', owner: 'uint8', target: 'uint8', damage: 'number', x: 'number', y: 'number', z: 'number', fromX: 'number', fromZ: 'number' }] },
  player: {
    physicsId: 'uint8', x: 'number', y: 'number', z: 'number', velocityX: 'number', velocityY: 'number', velocityZ: 'number', intentX: 'number', intentZ: 'number',
    grounded: 'number', facing: 'number', aimPitch: 'number',
    // One coherent namespace leaves root fields available for installed mods.
    combat: { guard: 'uint8', guardAgeMs: 'number', isBlocking: 'boolean',
      attackState: 'string', actionMs: 'number', actionDurationMs: 'number', attackGuard: 'uint8', attackSeq: 'number',
      chargeMs: 'number', stunMs: 'number', dodgeMs: 'number', dodgeX: 'number', dodgeZ: 'number', sprint: 'boolean',
      downMs: 'number', actionFeedback: 'string', feedbackMs: 'number', feedbackSeq: 'number' },
    // Numeric rollback state, recorded after authority resolves contact. Float64
    // timers preserve exact action boundaries through serialization and replay.
    motion: { phase: 'uint8', buttons: 'uint8', previousGuard: 'uint8', guard: 'uint8', guardAgeMs: 'float64',
      actionMs: 'float64', actionDurationMs: 'float64', attackGuard: 'uint8', chargeMs: 'float64', stunMs: 'float64',
      dodgeMs: 'float64', dodgeX: 'float64', dodgeZ: 'float64', dodgeHeldMs: 'float64', dodgeCooldownMs: 'float64',
      parryRearmMs: 'float64', lastBashMs: 'float64' },
  },
  input: { moveX: { min: -1, max: 1 }, moveZ: { min: -1, max: 1 }, attack: 'boolean', heavy: 'boolean', bash: 'boolean', dodge: 'boolean',
    guardLeft: 'boolean', guardUp: 'boolean', guardRight: 'boolean', lookX: { min: -1000, max: 1000 }, lookY: { min: -1000, max: 1000 } },
} as const satisfies GameShapes;
export type WorldState = StateOf<typeof shapes.world>;
export type TerrainWorld = Pick<WorldState, 'terrain'>;
export type FighterState = Omit<StateOf<typeof shapes.player>, 'combat'> & {
  combat: Omit<StateOf<typeof shapes.player.combat>, 'attackState'> & { attackState: AttackState };
  /** Authority's working values; motion supplies their numeric rollback snapshot. */
  previousAttack: boolean; previousHeavy: boolean; previousBash: boolean; previousDodge: boolean;
  previousGuard: number; dodgeHeldMs: number; dodgeCooldownMs: number; parryRearmMs: number; lastBashMs: number;
};
export type FightInput = InputOf<typeof shapes.input>;
