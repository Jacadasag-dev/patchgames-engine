import type { GameLogic } from '../shared/gameApi.ts';
import { shapes, type FightInput, type FighterState, type WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
export function createInput(overrides: Partial<FightInput> = {}): FightInput {
  return Object.assign(Object.fromEntries(Object.entries(shapes.input).map(([key, field]) => [key, field === 'boolean' ? false : 0])) as FightInput, overrides);
}
export const controls: GameLogic<WorldState, FighterState, FightInput, GameTuning>['controls'] = {
  inspection: { forward: { moveZ: 1 }, right: { moveX: 1 }, attack: { attack: true } },
  // Declared once: the engine binds keys, mouse and touch, and lists these for players in the Games browser.
  bindings: [
    { name: 'moveSide', label: 'Strafe', kind: 'axis', role: 'move-x', keys: ['a', 'd'], description: 'Step left and right relative to where you look.' },
    { name: 'moveAhead', label: 'Advance / retreat', kind: 'axis', role: 'move-y', keys: ['s', 'w'], description: 'Close in or back away from your opponent.' },
    { name: 'attack', label: 'Light slash', kind: 'tap', keys: ['j'], mouse: 0, description: 'A quick slash from your current guard.' },
    { name: 'heavy', label: 'Charge heavy strike', kind: 'held', keys: ['k'], mouse: 2, description: 'Hold to charge, release to strike. A full charge hits hardest.' },
    { name: 'bash', label: 'Hilt strike', kind: 'tap', keys: ['f'], description: 'Stun a guarding opponent; also counters an incoming hilt strike.' },
    { name: 'dodge', label: 'Dodge / sprint', kind: 'held', keys: [' '], description: 'Tap to dodge, hold to sprint.' },
    { name: 'guardLeft', label: 'Left guard', kind: 'tap', keys: ['q', 'arrowleft'], description: 'Guard left. Switch just before impact to parry.' },
    { name: 'guardUp', label: 'High guard', kind: 'tap', keys: ['e', 'arrowup'], description: 'Guard high. Switch just before impact to parry.' },
    { name: 'guardRight', label: 'Right guard', kind: 'tap', keys: ['r', 'arrowright'], description: 'Guard right. Switch just before impact to parry.' },
  ],
  pointer: { mode: 'lock' },
  writeInput(input, buttons, frame) {
    const taps = { attack: buttons.tapped('attack'), bash: buttons.tapped('bash'), guardLeft: buttons.tapped('guardLeft'), guardUp: buttons.tapped('guardUp'), guardRight: buttons.tapped('guardRight') };
    const me = frame.players.find(player => player.isLocal);
    if (!me || me.hp <= 0) return;
    const ahead = buttons.value('moveAhead'), side = buttons.value('moveSide');
    const fx = frame.view.forwardX ?? Math.sin(me.state.facing), fz = frame.view.forwardZ ?? Math.cos(me.state.facing);
    Object.assign(input, taps, { moveX: fx * ahead - fz * side, moveZ: fz * ahead + fx * side,
      heavy: buttons.held('heavy'), dodge: buttons.held('dodge'), lookX: buttons.pointer.deltaX, lookY: buttons.pointer.deltaY });
  },
};
