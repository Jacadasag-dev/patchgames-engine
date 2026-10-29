import type { LearningInterface } from '../shared/gameApi.ts';
export const learning: LearningInterface = {
  player: { x: { kind: 'scalar', scale: 9 }, y: { kind: 'scalar', scale: 2 }, z: { kind: 'scalar', scale: 9 },
    facing: { kind: 'angle', period: 2 * Math.PI }, 'combat.guard': { kind: 'scalar', scale: 2 },
    'combat.guardAgeMs': { kind: 'scalar', scale: 1000 }, 'combat.chargeMs': { kind: 'scalar', scale: 1000 }, 'combat.stunMs': { kind: 'scalar', scale: 1000 },
    'combat.actionMs': { kind: 'scalar', scale: 1000 }, 'combat.dodgeMs': { kind: 'scalar', scale: 320 },
    'combat.attackState': { kind: 'category', values: ['idle', 'light', 'charging', 'heavy', 'bash', 'recovery', 'stunned', 'dodge'] } },
  playerVectors: [{ components: ['x', 'y', 'z'], scale: 9 }, { components: ['velocityX', 'velocityY', 'velocityZ'], scale: 8 }],
  inputs: { moveX: { neutral: 0, scale: 1 }, moveZ: { neutral: 0, scale: 1 }, lookX: { neutral: 0, scale: 1 }, lookY: { neutral: 0, scale: 1 } },
};
