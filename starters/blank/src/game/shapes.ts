import type { GameShapes, InputOf, StateOf } from '../shared/gameApi.ts';

/** The least a playable game syncs: where each participant stands and looks.
 * Add world objects and player fields here as the game grows. */
export const shapes = {
  world: { elapsedMs: 'number' },
  player: {
    physicsId: 'uint8', x: 'number', y: 'number', z: 'number', facing: 'number', aimPitch: 'number',
    velocityX: 'number', velocityY: 'number', velocityZ: 'number', grounded: 'number',
  },
  input: {
    moveX: { min: -1, max: 1 }, moveZ: { min: -1, max: 1 },
    lookX: { min: -1000, max: 1000 }, lookY: { min: -1000, max: 1000 },
    jump: 'boolean',
  },
} as const satisfies GameShapes;

export type WorldState = StateOf<typeof shapes.world>;
export type PlayerState = StateOf<typeof shapes.player>;
export type BlankInput = InputOf<typeof shapes.input>;

/** Complete neutral input for tests and scripted players; overrides stay typed. */
export function createInput(overrides: Partial<BlankInput> = {}): BlankInput {
  return { moveX: 0, moveZ: 0, lookX: 0, lookY: 0, jump: false, ...overrides };
}
