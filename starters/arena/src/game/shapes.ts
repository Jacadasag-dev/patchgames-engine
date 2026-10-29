import type { GameShapes, InputOf, StateOf } from '../shared/gameApi.ts';

export const shapes = {
  world: {
    terrainRevision: 'string',
    zoneRadius: 'number', zoneClosed: 'boolean', elapsedMs: 'number',
    supplies: [{ id: 'string', kind: 'string', x: 'number', y: 'number', z: 'number', claimedBy: 'int16', loot: 'uint16' }],
    arrows: [{ id: 'string', owner: 'uint8', x: 'number', y: 'number', z: 'number',
      fromX: 'number', fromY: 'number', fromZ: 'number', vx: 'number', vy: 'number', vz: 'number', lifeMs: 'number', target: 'int16' }],
  },
  player: {
    physicsId: 'uint8', velocityX: 'number', velocityY: 'number', velocityZ: 'number', grounded: 'number',
    x: 'number', y: 'number', z: 'number', facing: 'number', aimPitch: 'number',
    weapon: 'boolean', eliminated: 'boolean', attackMs: 'number', attackId: 'uint32', attackWeapon: 'uint8', bowDrawMs: 'number', bowShotDrawMs: 'number',
    equipped: 'uint8', sword: 'boolean', bow: 'boolean', arrows: 'uint16', bandages: 'uint8', bandageMs: 'number',
    armorFace: 'boolean', armorChest: 'boolean', armorLegs: 'boolean', armorArms: 'boolean', chestId: 'string',
    chestCursorX: 'number', chestCursorY: 'number',
  },
  input: { moveX: { min: -1, max: 1 }, moveZ: { min: -1, max: 1 },
    lookX: { min: -1000, max: 1000 }, lookY: { min: -1000, max: 1000 },
    attack: 'boolean', interact: 'boolean', jump: 'boolean', bandage: 'boolean', sword: 'boolean', bow: 'boolean',
    take: { min: 0, max: 9 }, closeChest: 'boolean', menuX: { min: 0, max: 1 }, menuY: { min: 0, max: 1 } },
} as const satisfies GameShapes;

export type WorldState = StateOf<typeof shapes.world>;
export type PlayerState = StateOf<typeof shapes.player> & {
  // Private timers and unique strike IDs do not need network bandwidth.
  cooldownMs: number;
  healId: number;
  healPulse: boolean;
  previousHp: number;
  interactHeld: boolean;
  attackHeld: boolean;
  drawBlocked: boolean;
};
export type FightInput = InputOf<typeof shapes.input>;

/** Complete neutral input for tests and scripted players; overrides stay typed. */
export function createInput(overrides: Partial<FightInput> = {}): FightInput {
  const input = Object.fromEntries(Object.entries(shapes.input).map(([name, field]) =>
    [name, field === 'boolean' ? false : 0])) as FightInput;
  return Object.assign(input, overrides);
}
