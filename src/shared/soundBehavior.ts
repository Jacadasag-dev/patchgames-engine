import { z } from 'zod';

/** Positions use game world units; velocities use those same units per second. */
export type SoundVector3 = [number, number, number];
export interface SoundMotionState { position: SoundVector3; velocity?: SoundVector3; forward?: SoundVector3 }
export interface SoundMotionUpdate extends SoundMotionState { teleport?: boolean }

const finite = z.number().finite();
function curveSchema(minimum: number, maximum: number) {
  return z.array(z.tuple([finite.min(-1_000_000).max(1_000_000), finite.min(minimum).max(maximum)]))
    .min(2).max(8).superRefine((points, context) => {
      for (let i = 1; i < points.length; i++) if (points[i][0] <= points[i - 1][0]) context.addIssue({
        code: 'custom', path: [i, 0], message: 'Curve input coordinates must be strictly increasing.',
      });
    });
}

export const soundLayerResponseSchema = z.object({
  input: z.enum(['approach', 'distance', 'sourceFacing', 'listenerFacing', 'speed']),
  gain: curveSchema(0, 4).optional(),
  lowpass: curveSchema(20, 24000).optional(),
}).strict().superRefine((response, context) => {
  if (!response.gain && !response.lowpass) context.addIssue({ code: 'custom', message: 'Provide a gain or lowpass response curve.' });
  if (['approach', 'sourceFacing', 'listenerFacing'].includes(response.input)) {
    for (const field of ['gain', 'lowpass'] as const) response[field]?.forEach((point, index) => {
      if (Math.abs(point[0]) > 1) context.addIssue({ code: 'custom', path: [field, index, 0], message: 'Approach and facing inputs range from -1 to 1.' });
    });
  } else {
    for (const field of ['gain', 'lowpass'] as const) response[field]?.forEach((point, index) => {
      if (point[0] < 0) context.addIssue({ code: 'custom', path: [field, index, 0], message: 'Distance and speed inputs are nonnegative world units.' });
    });
  }
});

export const soundBehaviorSchema = z.object({
  smoothingMs: finite.min(0).max(2000).default(80),
  refDistance: finite.min(0.01).max(1_000_000).default(2),
  maxDistance: finite.min(0.01).max(1_000_000).default(1000),
  rolloffFactor: finite.min(0).max(10).default(1),
  approachSpeed: finite.min(0.01).max(1_000_000).default(30),
  doppler: z.object({
    strength: finite.min(0).max(2).default(1),
    speedOfSound: finite.min(1).max(1_000_000).default(343),
    maxSemitones: finite.min(0).max(12).default(12),
  }).strict().optional(),
}).strict().superRefine((behavior, context) => {
  if (behavior.maxDistance < behavior.refDistance) context.addIssue({ code: 'custom', path: ['maxDistance'], message: 'maxDistance must be at least refDistance.' });
});

export type SoundBehavior = z.output<typeof soundBehaviorSchema>;
export type SoundBehaviorInput = z.input<typeof soundBehaviorSchema>;
export type SoundLayerResponse = z.output<typeof soundLayerResponseSchema>;
export type SoundLayerResponseInput = z.input<typeof soundLayerResponseSchema>;
export interface SoundBehaviorLayer { id: string; response?: SoundLayerResponse }
export interface SoundLayerBehaviorEvaluation { id: string; gain: number; lowpass?: number }
export interface SoundBehaviorEvaluation {
  distance: number;
  /** Positive means the emitter and listener are moving closer together. */
  radialSpeed: number;
  approach: number;
  /** Cosines: +1 faces the other participant, -1 faces away. */
  sourceFacing: number;
  listenerFacing: number;
  /** Relative speed in world units per second, independent of facing. */
  speed: number;
  normalizedDistance: number;
  /** For offline audition only; live PannerNode already applies this attenuation. */
  distanceGain: number;
  pitchRate: number;
  pitchSemitones: number;
  layers: SoundLayerBehaviorEvaluation[];
}

const ZERO: SoundVector3 = [0, 0, 0];
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const dot = (a: SoundVector3, b: SoundVector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: SoundVector3, b: SoundVector3): SoundVector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const copy = (value: SoundVector3): SoundVector3 => [...value];
function unit(value: SoundVector3): SoundVector3 | undefined {
  const length = Math.hypot(...value);
  return length > 1e-9 ? [value[0] / length, value[1] / length, value[2] / length] : undefined;
}

export function evaluateSoundResponseCurve(points: [number, number][], input: number): number {
  if (input <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (input > points[i][0]) continue;
    const previous = points[i - 1], next = points[i], fraction = (input - previous[0]) / (next[0] - previous[0]);
    return previous[1] + (next[1] - previous[1]) * fraction;
  }
  return points[points.length - 1][1];
}

/** Evaluate already validated recipe data. No rendering, network, or artistic pass/fail rules. */
export function evaluateSoundBehavior(behavior: SoundBehavior, layers: SoundBehaviorLayer[], emitter: SoundMotionState,
  listener: SoundMotionState): SoundBehaviorEvaluation {
  const separation = subtract(listener.position, emitter.position), distance = Math.hypot(...separation), direction = unit(separation);
  const emitterVelocity = emitter.velocity ?? ZERO, listenerVelocity = listener.velocity ?? ZERO;
  const relativeVelocity = subtract(emitterVelocity, listenerVelocity), speed = Math.hypot(...relativeVelocity);
  const radialSpeed = direction ? dot(relativeVelocity, direction) : 0;
  const approach = clamp(radialSpeed / behavior.approachSpeed, -1, 1);
  // Explicit facing is separate from travel. A projectile without facing can use its travel direction.
  const emitterForward = unit(emitter.forward ?? emitterVelocity), listenerForward = listener.forward && unit(listener.forward);
  const sourceFacing = direction && emitterForward ? clamp(dot(emitterForward, direction), -1, 1) : 1;
  const listenerFacing = direction && listenerForward ? clamp(-dot(listenerForward, direction), -1, 1) : 1;
  let pitchSemitones = 0;
  if (behavior.doppler && direction) {
    const { speedOfSound, strength, maxSemitones } = behavior.doppler;
    // Bounded subsonic approximation. Supersonic shocks require separate authored effects;
    // singular denominators and teleports must never create an unbounded playback rate.
    const sourceRadial = clamp(dot(emitterVelocity, direction), -speedOfSound * 0.95, speedOfSound * 0.95);
    const listenerRadial = clamp(dot(listenerVelocity, direction), -speedOfSound * 0.95, speedOfSound * 0.95);
    const rate = (speedOfSound - listenerRadial) / (speedOfSound - sourceRadial);
    pitchSemitones = clamp(12 * Math.log2(rate) * strength, -maxSemitones, maxSemitones);
  }
  const limitedDistance = clamp(distance, behavior.refDistance, behavior.maxDistance);
  const distanceGain = behavior.refDistance / (behavior.refDistance + behavior.rolloffFactor * (limitedDistance - behavior.refDistance));
  const inputs = { approach, distance, sourceFacing, listenerFacing, speed };
  return { distance, radialSpeed, approach, sourceFacing, listenerFacing, speed,
    normalizedDistance: clamp((distance - behavior.refDistance) / Math.max(1e-9, behavior.maxDistance - behavior.refDistance), 0, 1),
    distanceGain, pitchSemitones, pitchRate: 2 ** (pitchSemitones / 12),
    layers: layers.map(layer => {
      const response = layer.response, value = response ? inputs[response.input] : 0;
      return { id: layer.id, gain: response?.gain ? evaluateSoundResponseCurve(response.gain, value) : 1,
        ...(response?.lowpass ? { lowpass: evaluateSoundResponseCurve(response.lowpass, value) } : {}) };
    }) };
}

export interface SoundMotionTrackerOptions {
  staleAfterMs?: number;
  maxGapMs?: number;
  teleportDistance?: number;
  maxSpeed?: number;
}

/** One tracker per source/listener. The host clock is monotonic milliseconds. */
export function createSoundMotionTracker(options: SoundMotionTrackerOptions = {}) {
  const staleAfterMs = options.staleAfterMs ?? 250, maxGapMs = options.maxGapMs ?? 500;
  const teleportDistance = options.teleportDistance ?? 100, maxSpeed = options.maxSpeed ?? 10000;
  if (![staleAfterMs, maxGapMs, teleportDistance, maxSpeed].every(value => Number.isFinite(value) && value > 0)) throw new Error('Sound motion tracker limits must be positive and finite.');
  let state: SoundMotionState | undefined, lastTime = -Infinity;
  const snapshot = (velocity = state?.velocity ?? ZERO): SoundMotionState | undefined => state && ({ position: copy(state.position), velocity: copy(velocity),
    ...(state.forward ? { forward: copy(state.forward) } : {}) });
  return {
    update(update: SoundMotionUpdate, nowMs: number): SoundMotionState {
      if (!Number.isFinite(nowMs) || ![update.position, update.velocity, update.forward].filter(Boolean).every(vector => vector!.length === 3 && vector!.every(Number.isFinite)))
        throw new Error('Sound motion requires finite positions, velocities, facing and timestamps.');
      const elapsed = nowMs - lastTime, delta = state ? subtract(update.position, state.position) : ZERO;
      // A fast, explicitly tracked projectile may legitimately travel farther
      // than the stationary teleport threshold between network updates.
      const knownSpeed = Math.min(maxSpeed, Math.max(Math.hypot(...(state?.velocity ?? ZERO)), Math.hypot(...(update.velocity ?? ZERO))));
      const allowedTravel = teleportDistance + knownSpeed * Math.max(0, elapsed) / 1000 * 2;
      const discontinuity = update.teleport || (!!state && (elapsed < 0 || elapsed > maxGapMs || Math.hypot(...delta) > allowedTravel));
      let velocity: SoundVector3 = discontinuity ? ZERO : update.velocity ?? (state && elapsed > 0
        ? [delta[0] * 1000 / elapsed, delta[1] * 1000 / elapsed, delta[2] * 1000 / elapsed]
        : state && elapsed === 0 && delta.every(value => value === 0) ? state.velocity ?? ZERO : ZERO);
      const speed = Math.hypot(...velocity);
      if (speed > maxSpeed) velocity = [velocity[0] * maxSpeed / speed, velocity[1] * maxSpeed / speed, velocity[2] * maxSpeed / speed];
      const forward = update.forward ?? state?.forward;
      state = { position: copy(update.position), velocity: copy(velocity), ...(forward ? { forward: copy(forward) } : {}) };
      lastTime = nowMs; return snapshot()!;
    },
    sample(nowMs: number): SoundMotionState | undefined {
      return snapshot(!Number.isFinite(nowMs) || nowMs < lastTime || nowMs - lastTime > staleAfterMs ? ZERO : state?.velocity);
    },
    reset(): void { state = undefined; lastTime = -Infinity; },
  };
}
