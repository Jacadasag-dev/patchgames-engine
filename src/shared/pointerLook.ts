import type { PointerLook, PointerState } from './gameApi.ts';
import type { InputKind } from './shapes.ts';
import { setStatePath, statePathValue } from './statePaths.ts';

/** Apply one declared look input with the same wire and angle bounds on the
 * server and in presentation. The caller owns state; decoded authority must be
 * copied before using this for a display-only preview. */
export function applyPointerLook(state: Record<string, unknown>, input: unknown, look: PointerLook, inputKinds: InputKind, tuning: Readonly<Record<string, number>> = {}): void {
  if (look.disabledWhen?.some(field => Boolean(statePathValue(state, field)))) return;
  const values = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  for (const axis of [look.x, look.y]) {
    if (!axis) continue;
    const current = statePathValue(state, axis.field), bounds = inputKinds.find(([name]) => name === axis.input)?.[1];
    if (typeof current !== 'number' || !Number.isFinite(current) || bounds?.kind !== 'range') continue;
    const raw = values[axis.input], delta = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    const multiplier=axis.scaleTuning===undefined?1:tuning[axis.scaleTuning];
    if(typeof multiplier!=='number'||!Number.isFinite(multiplier)||!Number.isFinite(axis.scale*multiplier))throw new Error('Pointer look requires finite declared tuning sensitivity');
    const next = Math.max(axis.min ?? -Infinity, Math.min(axis.max ?? Infinity,
      current + Math.max(bounds.min, Math.min(bounds.max, delta)) * axis.scale * multiplier));
    if (Number.isFinite(next)) setStatePath(state, axis.field, next);
  }
}

/** Preview motion still awaiting the next fixed input sample, without consuming
 * it or advancing gameplay. The next sent input applies that motion exactly once. */
export function previewPointerLook(state: Record<string, unknown>, pointer: Pick<PointerState, 'deltaX' | 'deltaY'>, look: PointerLook, inputKinds: InputKind, tuning: Readonly<Record<string, number>> = {}): void {
  const input: Record<string, number> = {};
  if (look.x) input[look.x.input] = pointer.deltaX;
  if (look.y) input[look.y.input] = pointer.deltaY;
  applyPointerLook(state, input, look, inputKinds, tuning);
}
