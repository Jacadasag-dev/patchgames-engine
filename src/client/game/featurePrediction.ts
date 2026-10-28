import type { SimReconcilerOptions } from '@colyseus/sdk';

type World = { values: Record<string, number> };
type Pose = Record<string, number>;
interface Controller { reset(): void; dispose(): void; value(field: string): number }

/** Display error only: fresh inputs still update the simulated pose immediately. */
export const LOCAL_CORRECTION_MS = 65;
type Options<I> = Omit<SimReconcilerOptions<I, Pose, World>, 'pose' | 'snap'>;

/**
 * One authoritative simulation; render observers with independent units.
 * The SDK snaps an entire pose when ANY component exceeds its threshold. Keep
 * positions separate from cooldowns/counters so milliseconds cannot teleport a
 * fighter. Register the passive observers after the primary: SDK ticks/send listeners
 * run in registration order, so they see the primary's already adopted/replayed state.
 *
 * Server corrections ease in only for numbers players watch move: positions, declared
 * look fields (`immediateFields`) and declared smooth fields. Every other number (a
 * timer, a cooldown, a velocity) takes the corrected value exactly: an eased timer reads
 * wrong for several frames, and its exponential tail never quite reaches zero, so a
 * `stunMs > 0` check would stay true for the rest of the round.
 */
export function featurePrediction<I>(create: (options: SimReconcilerOptions<I, Pose, World>) => Controller,
  options: Options<I>, fields: readonly string[], spatialFields: readonly string[], snap: number, immediateFields: readonly string[] = [],
  smoothedFields: readonly string[] = []): Controller {
  const spatial = new Set(spatialFields), immediate = new Set(immediateFields), smoothed = new Set(smoothedFields);
  const ordinary = fields.filter(field => !spatial.has(field));
  const gliding = ordinary.filter(field => immediate.has(field) || smoothed.has(field));
  const exact = new Set(ordinary.filter(field => !immediate.has(field) && !smoothed.has(field)));
  const pose = (selected: readonly string[]) => (world: World): Pose => Object.fromEntries(selected.map(field => [field, world.values[field]]));
  // Local look follows the latest input immediately. The SDK supplies already
  // smooth-corrected endpoints, so reconciliation still eases its errors out;
  // only the extra fixed-step interpolation delay is bypassed for these fields.
  // A whole-number pair (a counter, a phase, a whole-millisecond timer) also holds
  // its latest value: a fraction between two counts would read as an event of its own.
  const interpolate = (selected: readonly string[]) => (a: Pose, b: Pose, t: number) => Object.fromEntries(selected.map(field => {
    const from = a[field], to = b[field];
    return [field, immediate.has(field) || (Number.isInteger(from) && Number.isInteger(to)) ? to : from + (to - from) * t];
  }));
  const primary = create({ ...options, ...(spatial.size ? {smoothMs:options.smoothMs??LOCAL_CORRECTION_MS} : {}), snap: spatial.size ? snap : 0, pose: pose(spatialFields) });
  // Primary alone changes state, including rollback and input replay.
  const observer = (selected: readonly string[], extra: Partial<SimReconcilerOptions<I, Pose, World>>) => selected.length
    ? create({ ...options, snap: 0, pose: pose(selected), adopt() {}, step() {}, onReconcile: undefined, interpolate: interpolate(selected), ...extra })
    : undefined;
  const glide = observer(gliding, {});
  const precise = observer([...exact], { smoothMs: 0 });
  let disposed = false;
  return {
    value: field => spatial.has(field) ? primary.value(field) : exact.has(field) ? precise!.value(field) : glide!.value(field),
    reset() { if (!disposed) { primary.reset(); glide?.reset(); precise?.reset(); } },
    dispose() { if (!disposed) { disposed = true; primary.dispose(); glide?.dispose(); precise?.dispose(); } },
  };
}
