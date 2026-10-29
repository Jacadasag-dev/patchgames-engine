import type { PointerLook } from '../shared/gameApi.ts';
import type { InputKind } from '../shared/shapes.ts';
import { applyPointerLook } from '../shared/pointerLook.ts';
import { shapes, type FightInput, type PlayerState } from './shapes.ts';

/** Simulation and display use the same sensitivity, angle bounds and menu gate. */
export const ARENA_POINTER_LOOK = {
  x: { field: 'facing', input: 'lookX', scale: -.003 },
  y: { field: 'aimPitch', input: 'lookY', scale: -.003, min: -1.35, max: 1.35 },
  disabledWhen: ['chestId', 'eliminated'],
} as const satisfies PointerLook;
const INPUT_KINDS: InputKind = [
  ['lookX', { kind: 'range', ...shapes.input.lookX }],
  ['lookY', { kind: 'range', ...shapes.input.lookY }],
];

export function applyArenaLook(state: PlayerState, input: FightInput | undefined): void {
  applyPointerLook(state, input, ARENA_POINTER_LOOK, INPUT_KINDS);
}
