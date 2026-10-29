import type { PointerLook } from '../shared/gameApi.ts';
import type { InputKind } from '../shared/shapes.ts';
import { applyPointerLook } from '../shared/pointerLook.ts';
import { shapes, type BlankInput, type PlayerState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';

/** One editable declaration for authority, prediction and unsent display motion. */
export const BLANK_POINTER_LOOK = {
  x: { field: 'facing', input: 'lookX', scale: -1, scaleTuning: 'lookSpeed' },
  y: { field: 'aimPitch', input: 'lookY', scale: -1, scaleTuning: 'lookSpeed', min: -1.35, max: 1.35 },
} as const satisfies PointerLook;
const INPUT_KINDS: InputKind = [
  ['lookX', { kind: 'range', ...shapes.input.lookX }],
  ['lookY', { kind: 'range', ...shapes.input.lookY }],
];
export function applyBlankLook(state: PlayerState, input: BlankInput | undefined, tuning: GameTuning): void {
  applyPointerLook(state, input, BLANK_POINTER_LOOK, INPUT_KINDS, tuning);
}

