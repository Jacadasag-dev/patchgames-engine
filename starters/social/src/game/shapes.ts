import type { GameShapes, InputOf, StateOf } from '../shared/gameApi.ts';

export const shapes = {
  world: {
    elapsedMs: 'number', terrainRevision: 'string',
    tables: [{
      id: 'uint8', kind: 'string', phase: 'string', round: 'uint32',
      playerOrder: ['uint8'], turn: 'int16', direction: 'int8',
      topCard: 'int16', currentColor: 'uint8', deck: ['uint8'], discard: ['uint8'],
      winner: 'int16', prompt: 'string', promptKind: 'string', promptIndex: 'uint32', message: 'string',
    }],
  },
  player: {
    physicsId: 'uint8', x: 'number', y: 'number', z: 'number', facing: 'number', aimPitch: 'number',
    velocityX: 'number', velocityY: 'number', velocityZ: 'number', grounded: 'number',
    seatIndex: 'int16', eliminated: 'boolean', attackMs: 'number',
    sitHeld: 'boolean', cooldownMs: 'number', attackId: 'uint32',
    tableId: 'int16', hand: ['uint8'], selectedCard: 'uint8', selectedColor: 'uint8',
    emoteId: 'uint8', emoteStartedMs: 'number', emoteUntilMs: 'number', wheelOpen: 'boolean', wheelChoice: 'uint8',
    held: { wheel: 'boolean', left: 'boolean', right: 'boolean', up: 'boolean', down: 'boolean',
      secondary: 'boolean', truth: 'boolean', color: 'boolean', cancel: 'boolean', emote: 'uint8' },
  },
  input: {
    moveX: { min: -1, max: 1 }, moveZ: { min: -1, max: 1 },
    lookX: { min: -1000, max: 1000 }, lookY: { min: -1000, max: 1000 },
    sit: 'boolean', jump: 'boolean', attack: 'boolean', wheel: 'boolean',
    left: 'boolean', right: 'boolean', up: 'boolean', down: 'boolean',
    secondary: 'boolean', truth: 'boolean', color: 'boolean', cancel: 'boolean',
    emote: { min: 0, max: 6 },
  },
} as const satisfies GameShapes;

export type WorldState = StateOf<typeof shapes.world>;
export type TableState = WorldState['tables'][number];
export type PlayerState = StateOf<typeof shapes.player>;
export type LoungeInput = InputOf<typeof shapes.input>;
export function createInput(overrides: Partial<LoungeInput> = {}): LoungeInput {
  return { moveX: 0, moveZ: 0, lookX: 0, lookY: 0, sit: false, jump: false, attack: false,
    wheel: false, left: false, right: false, up: false, down: false,
    secondary: false, truth: false, color: false, cancel: false, emote: 0, ...overrides };
}
