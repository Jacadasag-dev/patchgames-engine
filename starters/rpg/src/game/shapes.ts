import type { GameShapes, InputOf, StateOf } from '../shared/gameApi.ts';

export const shapes = {
  world: {
    terrainRevision: 'string',
    elapsedMs: 'number', stage: 'uint8', kills: 'uint8', partySize: 'uint8',
    enemies: [{ id: 'uint8', group: 'uint8', kind: 'uint8', x: 'number', z: 'number', facing: 'number', hp: 'number', maxHp: 'number',
      windupMs: 'number', strikeMs: 'number', attackId: 'uint16', aimX: 'number', aimZ: 'number', hitMs: 'number' }],
  },
  player: {
    physicsId: 'uint8', x: 'number', y: 'number', z: 'number', facing: 'number',
    velocityX: 'number', velocityY: 'number', velocityZ: 'number', grounded: 'number',
    intentX: 'number', intentZ: 'number',
    classId: 'uint8', downed: 'boolean', reviving: 'boolean', attackId: 'uint32', skillId: 'uint32', attackMs: 'number', skillMs: 'number', skillCooldownMs: 'number',
    targetX: 'number', targetZ: 'number', dashX: 'number', dashZ: 'number', kills: 'uint16',
  },
  input: { moveX: { min: -1, max: 1 }, moveZ: { min: -1, max: 1 }, attack: 'boolean', skill: 'boolean', revive: 'boolean' },
} as const satisfies GameShapes;

export type Enemy = StateOf<typeof shapes.world.enemies[0]> & { cooldownMs: number };
export type WorldState = Omit<StateOf<typeof shapes.world>, 'enemies'> & { enemies: Enemy[] };
export type PlayerState = StateOf<typeof shapes.player> & { cooldownMs: number };
export type FightInput = InputOf<typeof shapes.input>;
export const createInput = (overrides: Partial<FightInput> = {}): FightInput => ({ moveX: 0, moveZ: 0, attack: false, skill: false, revive: false, ...overrides });
