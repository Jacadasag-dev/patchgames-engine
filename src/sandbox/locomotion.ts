/**
 * Bounded, presentation-only locomotion math. Time is seconds, distance is in
 * the game's world units, angles are radians, and gait phase is cycles [0, 1).
 * These helpers never move a collider or infer support from rendered geometry.
 * Supply support sampled from the same world geometry used by gameplay.
 */
export const LOCOMOTION_VERSION = 'locomotion-v1';

export interface LocomotionVector { x: number; y: number; z: number }
/** World-space axes. Forward is a facing/reference axis, independent of travel. */
export interface MovementFrame { up: LocomotionVector; forward: LocomotionVector }
export interface LocomotionSupport {
  point: LocomotionVector;
  normal: LocomotionVector;
  observedAt: number;
  grounded?: boolean;
  /** Stable identity is useful for distinguishing two neighboring surfaces. */
  id?: string;
}
export type SupportStatus = 'current' | 'missing' | 'stale' | 'airborne';
export interface LocomotionIntent { velocity: LocomotionVector; observedAt?: number }
export interface TrajectorySample {
  /** Seconds after the query, rather than a wall-clock timestamp. */
  time: number;
  position: LocomotionVector;
  velocity: LocomotionVector;
}
export interface LocomotionPrediction {
  mode: 'intent' | 'observed';
  support: SupportStatus;
  samples: TrajectorySample[];
  warnings: string[];
}
export interface LocomotionPredictionInput {
  time: number;
  position: LocomotionVector;
  velocity: LocomotionVector;
  frame: MovementFrame;
  intent?: LocomotionIntent;
  support?: LocomotionSupport;
  /** 0..3 seconds. This estimates one current support plane, not future terrain. */
  horizon?: number;
  /** 1..16 future samples. Integration uses steps no larger than 1/60 second. */
  samples?: number;
  acceleration?: number;
  braking?: number;
  /** Maximum change in travel direction, radians per second. Facing is untouched. */
  turnRate?: number;
  maxSpeed?: number;
  /** Maximum age of intent/support evidence; defaults to 0.25 seconds. */
  maxAge?: number;
}

const EPS = 1e-8;
const ZERO: LocomotionVector = { x: 0, y: 0, z: 0 };
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const add = (a: LocomotionVector, b: LocomotionVector): LocomotionVector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: LocomotionVector, b: LocomotionVector): LocomotionVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: LocomotionVector, s: number): LocomotionVector => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: LocomotionVector, b: LocomotionVector): number => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (v: LocomotionVector): number => Math.hypot(v.x, v.y, v.z);
const cross = (a: LocomotionVector, b: LocomotionVector): LocomotionVector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const project = (v: LocomotionVector, normal: LocomotionVector): LocomotionVector => sub(v, scale(normal, dot(v, normal)));

function fail(message: string): never { throw new Error(`Locomotion: ${message}`); }
function number(value: unknown, name: string, lo = -1e6, hi = 1e6): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) fail(`${name} must be finite and between ${lo} and ${hi}`);
  return value;
}
function vector(v: LocomotionVector, name: string): LocomotionVector {
  if (!v || typeof v !== 'object') fail(`${name} needs {x, y, z}`);
  return { x: number(v.x, `${name}.x`), y: number(v.y, `${name}.y`), z: number(v.z, `${name}.z`) };
}
function unit(v: LocomotionVector, name: string): LocomotionVector {
  const size = length(v);
  if (size < EPS) fail(`${name} must not be zero or parallel to up`);
  return scale(v, 1 / size);
}
function axes(frame: MovementFrame): { up: LocomotionVector; forward: LocomotionVector; right: LocomotionVector } {
  if (!frame) fail('frame needs explicit up and forward axes');
  const up = unit(vector(frame.up, 'frame.up'), 'frame.up');
  const forward = unit(project(vector(frame.forward, 'frame.forward'), up), 'frame.forward');
  return { up, forward, right: cross(up, forward) };
}
function fresh(time: number, observedAt: number, maxAge: number): boolean {
  const age = time - number(observedAt, 'observedAt', -1e12, 1e12);
  return age >= -EPS && age <= maxAge;
}
function supportStatus(support: LocomotionSupport | undefined, time: number, maxAge: number): SupportStatus {
  if (!support) return 'missing';
  vector(support.point, 'support.point');
  unit(vector(support.normal, 'support.normal'), 'support.normal');
  if (support.id !== undefined && (typeof support.id !== 'string' || !support.id.length || support.id.length > 128)) fail('support.id must contain 1..128 characters');
  if (!fresh(time, support.observedAt, maxAge)) return 'stale';
  return support.grounded === false ? 'airborne' : 'current';
}
function bounded(v: LocomotionVector, maxLength: number): LocomotionVector {
  const size = length(v);
  return size > maxLength ? scale(v, maxLength / size) : { ...v };
}

/**
 * Estimate a short path with explicit controller limits. Missing/stale intent or
 * support falls back to observed velocity. No future inputs, collisions, gravity
 * forces, or terrain are invented. A fresh support plane is only a local estimate.
 */
export function predictLocomotion(input: LocomotionPredictionInput): LocomotionPrediction {
  const time = number(input.time, 'time', -1e12, 1e12);
  const frame = axes(input.frame);
  let position = vector(input.position, 'position');
  let velocity = vector(input.velocity, 'velocity');
  const horizon = number(input.horizon ?? 0.6, 'horizon', 0, 3);
  const count = number(input.samples ?? 6, 'samples', 1, 16);
  if (!Number.isInteger(count)) fail('samples must be an integer');
  const acceleration = number(input.acceleration ?? 18, 'acceleration', 0, 1e4);
  const braking = number(input.braking ?? 24, 'braking', 0, 1e4);
  const turnRate = number(input.turnRate ?? Math.PI * 3, 'turnRate', 0, Math.PI * 32);
  const maxSpeed = number(input.maxSpeed ?? 12, 'maxSpeed', 0, 1e4);
  const maxAge = number(input.maxAge ?? 0.25, 'maxAge', 0, 10);
  const support = supportStatus(input.support, time, maxAge);
  const warnings: string[] = [];
  if (support !== 'current') warnings.push(`support-${support}`);
  const intent = input.intent && vector(input.intent.velocity, 'intent.velocity');
  const currentIntent = !!input.intent && fresh(time, input.intent.observedAt ?? time, maxAge);
  if (!input.intent) warnings.push('intent-missing');
  else if (!currentIntent) warnings.push('intent-stale');
  const mode = currentIntent && support === 'current' ? 'intent' : 'observed';
  const normal = support === 'current' ? unit(input.support!.normal, 'support.normal') : frame.up;
  const desired = bounded(project(intent ?? ZERO, normal), maxSpeed);
  if (mode === 'intent') warnings.push('support-plane-only');
  warnings.push('collisions-not-predicted');
  const samples: TrajectorySample[] = [];
  let elapsed = 0;
  for (let index = 0; index < count; index++) {
    const sampleTime = horizon * (index + 1) / count;
    while (sampleTime - elapsed > EPS) {
      const delta = Math.min(1 / 60, sampleTime - elapsed);
      let next = velocity;
      if (mode === 'intent') {
        const planar = project(velocity, normal);
        const speed = length(planar), desiredSpeed = length(desired);
        const rate = desiredSpeed < speed ? braking : acceleration;
        const nextSpeed = speed + clamp(desiredSpeed - speed, -rate * delta, rate * delta);
        let direction = speed > EPS ? scale(planar, 1 / speed) : desiredSpeed > EPS ? scale(desired, 1 / desiredSpeed) : ZERO;
        if (speed > EPS && desiredSpeed > EPS) {
          const targetDirection = scale(desired, 1 / desiredSpeed);
          const angle = Math.atan2(dot(normal, cross(direction, targetDirection)), clamp(dot(direction, targetDirection), -1, 1));
          const turn = clamp(angle, -turnRate * delta, turnRate * delta);
          direction = add(scale(direction, Math.cos(turn)), scale(cross(normal, direction), Math.sin(turn)));
        }
        // Preserve the observed normal component; this does not simulate gravity.
        next = add(scale(direction, nextSpeed), scale(normal, dot(velocity, normal)));
      }
      position = add(position, scale(add(velocity, next), delta / 2));
      velocity = next;
      elapsed += delta;
    }
    samples.push({ time: sampleTime, position: { ...position }, velocity: { ...velocity } });
  }
  return { mode, support, samples, warnings };
}

export interface GaitState { phase: number; distance: number }
export interface GaitAdvance {
  /** Actual traveled distance is preferred. Do not include a teleport here. */
  distance?: number;
  /** Speed and delta are a fallback when an observed distance is unavailable. */
  speed?: number;
  delta?: number;
  /** Travel distance of one complete cycle, not the distance of a single step. */
  strideLength: number;
  /** Clear continuity after a teleport, actor replacement or playback seek. */
  reset?: boolean;
}

/** Distance-driven gait keeps looping clips in phase across speed/direction blends. */
export function advanceGait(previous: GaitState | undefined, input: GaitAdvance): GaitState {
  const stride = number(input.strideLength, 'strideLength', 0.001, 1e4);
  const phase = number(previous?.phase ?? 0, 'phase', 0, 1);
  const traveled = number(previous?.distance ?? 0, 'gait.distance', 0, 1e12);
  if (input.distance !== undefined && (input.speed !== undefined || input.delta !== undefined)) fail('supply distance or speed/delta, not both');
  if ((input.speed === undefined) !== (input.delta === undefined)) fail('supply speed and delta together');
  const distance = input.distance !== undefined ? number(input.distance, 'distance', 0, 1e4)
    : number(input.speed ?? 0, 'speed', 0, 1e4) * number(input.delta ?? 0, 'delta', 0, 1);
  if (input.reset) return { phase: 0, distance: 0 };
  return { phase: (phase + distance / stride) % 1, distance: traveled + distance };
}

/** Reference motion descriptors; a clip family can use its own selector instead. */
export interface LocomotionCandidate {
  id: string;
  speed: number;
  /** Travel relative to the actor's forward/right axes. Omit for an idle clip. */
  direction?: { forward: number; right: number };
  rig?: string;
  tags?: readonly string[];
}
export interface LocomotionBlendQuery {
  velocity: LocomotionVector;
  frame: MovementFrame;
  prediction?: LocomotionPrediction;
  rig?: string;
  requiredTags?: readonly string[];
  currentId?: string;
  continuityBias?: number;
  maxBlends?: number;
  coverageThreshold?: number;
}
export interface LocomotionBlend {
  selected: string | null;
  weights: { id: string; weight: number; score: number }[];
  /** Compatible candidates only, sorted by score. Lower is better. */
  scores: { id: string; score: number }[];
  target: { forward: number; right: number };
  warnings: string[];
}

function labels(values: readonly string[] | undefined, name: string): readonly string[] {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > 32 || values.some(v => typeof v !== 'string' || v.length < 1 || v.length > 128)) fail(`${name} needs at most 32 nonempty strings of at most 128 characters`);
  return values;
}

/**
 * Small directional/speed blend selector, not an indexed motion-matching search.
 * Scores make sparse coverage visible; prediction cannot invent a missing clip.
 */
export function selectLocomotionBlend(candidates: readonly LocomotionCandidate[], query: LocomotionBlendQuery): LocomotionBlend {
  if (!Array.isArray(candidates) || candidates.length > 64) fail('at most 64 locomotion candidates are supported');
  const frame = axes(query.frame);
  const actual = vector(query.velocity, 'velocity');
  const prediction = query.prediction;
  if (prediction && (!Array.isArray(prediction.samples) || prediction.samples.length > 16)) fail('prediction needs at most 16 samples');
  const future = prediction?.mode === 'intent' ? prediction.samples.at(-1)?.velocity : undefined;
  const velocity = future ? add(scale(actual, 0.35), scale(vector(future, 'predicted velocity'), 0.65)) : actual;
  const target = { forward: dot(velocity, frame.forward), right: dot(velocity, frame.right) };
  const speed = Math.hypot(target.forward, target.right);
  const tags = labels(query.requiredTags, 'requiredTags');
  const continuity = number(query.continuityBias ?? 0.08, 'continuityBias', 0, 0.5);
  const maxBlends = number(query.maxBlends ?? 2, 'maxBlends', 1, 4);
  if (!Number.isInteger(maxBlends)) fail('maxBlends must be an integer');
  const threshold = number(query.coverageThreshold ?? 0.75, 'coverageThreshold', 0, 4);
  const seen = new Set<string>();
  const scores: { id: string; score: number; coverage: number }[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id.length || candidate.id.length > 128 || seen.has(candidate.id)) fail('candidate IDs must be unique nonempty strings of at most 128 characters');
    seen.add(candidate.id);
    const candidateSpeed = number(candidate.speed, `${candidate.id}.speed`, 0, 1e4);
    const candidateTags = labels(candidate.tags, `${candidate.id}.tags`);
    if (candidate.rig !== undefined && candidate.rig !== query.rig) continue;
    if (tags.some(tag => !candidateTags.includes(tag))) continue;
    let forward = 0, right = 0;
    if (candidate.direction) {
      forward = number(candidate.direction.forward, `${candidate.id}.forward`, -1e4, 1e4);
      right = number(candidate.direction.right, `${candidate.id}.right`, -1e4, 1e4);
    }
    const directionLength = Math.hypot(forward, right);
    if (candidateSpeed > EPS && directionLength < EPS) fail(`${candidate.id} needs reference travel direction for a moving clip`);
    const factor = directionLength > EPS ? candidateSpeed / directionLength : 0;
    const coverage = Math.hypot(target.forward - forward * factor, target.right - right * factor) / Math.max(0.25, speed, candidateSpeed);
    scores.push({ id: candidate.id, coverage, score: coverage - (candidate.id === query.currentId ? continuity : 0) });
  }
  scores.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = scores[0];
  const weights = scores.slice(0, maxBlends).map(score => ({ id: score.id, score: score.score, weight: Math.exp(-4 * (score.score - selected.score)) }));
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weights) item.weight /= total;
  const warnings: string[] = [];
  if (!selected) warnings.push('no-compatible-clips');
  else if (selected.coverage > threshold) warnings.push('sparse-motion-coverage');
  if (!future) warnings.push('observed-velocity-selection');
  return { selected: selected?.id ?? null, weights, scores: scores.map(({ id, score }) => ({ id, score })), target, warnings };
}

export interface FootAnchor { point: LocomotionVector; normal: LocomotionVector; supportId?: string }
export interface FootPlacement {
  target: LocomotionVector;
  normal: LocomotionVector;
  anchor?: FootAnchor;
  contactWeight: number;
  support: SupportStatus;
  reachable: boolean;
  warnings: string[];
}
export interface FootPlacementInput {
  time: number;
  hip: LocomotionVector;
  desired: LocomotionVector;
  frame: MovementFrame;
  support?: LocomotionSupport;
  /** An authored stance/contact curve, not a contact inferred from height. */
  contactWeight: number;
  previous?: FootPlacement;
  maxReach: number;
  /** Maximum support correction from the already reach-clamped desired target. */
  maxAdjustment?: number;
  maxAge?: number;
  reset?: boolean;
}

/**
 * Cosmetic world-space foot target with an optional planted anchor. A stale,
 * changed, unreachable or released contact clears its anchor. Callers solve their
 * own rig and must not use this target to replace authoritative ground queries.
 */
export function placeFoot(input: FootPlacementInput): FootPlacement {
  const time = number(input.time, 'time', -1e12, 1e12);
  const frame = axes(input.frame), hip = vector(input.hip, 'hip'), desired = vector(input.desired, 'desired');
  const contactWeight = number(input.contactWeight, 'contactWeight', 0, 1);
  const maxReach = number(input.maxReach, 'maxReach', 0.001, 1e4);
  const maxAdjustment = number(input.maxAdjustment ?? 0.35, 'maxAdjustment', 0, 1e4);
  const maxAge = number(input.maxAge ?? 0.25, 'maxAge', 0, 10);
  const support = supportStatus(input.support, time, maxAge);
  const base = add(hip, bounded(sub(desired, hip), maxReach));
  const warnings: string[] = [];
  if (length(sub(desired, hip)) > maxReach + EPS) warnings.push('desired-out-of-reach');
  let normal = frame.up, target = base, anchor: FootAnchor | undefined;
  let reachable = warnings.length === 0;
  if (support !== 'current') warnings.push(`support-${support}`);
  if (input.reset) warnings.push('contact-reset');
  if (support === 'current' && contactWeight > 0) {
    const surface = input.support!;
    normal = unit(surface.normal, 'support.normal');
    const denominator = dot(frame.up, normal);
    if (denominator <= 0.05) {
      warnings.push('unsupported-surface');
      normal = frame.up;
      reachable = false;
    } else {
      let ground = add(base, scale(frame.up, dot(sub(surface.point, base), normal) / denominator));
      const previous = !input.reset && input.previous?.contactWeight !== undefined && input.previous.contactWeight >= 0.5 && contactWeight >= 0.5 ? input.previous.anchor : undefined;
      if (previous) {
        const point = vector(previous.point, 'previous.anchor.point');
        if (previous.supportId !== surface.id || Math.abs(dot(sub(point, surface.point), normal)) > 0.02) warnings.push('contact-surface-changed');
        else if (length(sub(point, hip)) > maxReach + EPS || length(sub(point, base)) > maxAdjustment + EPS) warnings.push('contact-released-reach');
        else ground = point;
      }
      const correction = sub(ground, base);
      const withinReach = length(sub(ground, hip)) <= maxReach + EPS;
      const withinAdjustment = length(correction) <= maxAdjustment + EPS;
      reachable &&= withinReach && withinAdjustment;
      if (!withinReach) warnings.push('support-out-of-reach');
      if (!withinAdjustment) warnings.push('support-adjustment-limited');
      target = add(hip, bounded(sub(add(base, scale(bounded(correction, maxAdjustment), contactWeight)), hip), maxReach));
      if (contactWeight >= 0.5 && withinReach && withinAdjustment) anchor = { point: { ...ground }, normal: { ...normal }, ...(surface.id !== undefined ? { supportId: surface.id } : {}) };
    }
  }
  return { target, normal, ...(anchor ? { anchor } : {}), contactWeight, support, reachable, warnings };
}

export interface TwoBoneInput {
  /** Relative to the root: positive forward and positive up. */
  target: { forward: number; up: number };
  upperLength: number;
  lowerLength: number;
  bend?: 1 | -1;
}
export interface TwoBoneSolution {
  /** Local rotations in radians: zero points down, negative turns forward. */
  rootAngle: number;
  bendAngle: number;
  /** Optional end rotation that keeps an attached foot/tool level. */
  endAngle: number;
  target: { forward: number; up: number };
  distance: number;
  clamped: boolean;
}

/** Deterministic planar two-segment solve. No anatomy, skeleton or physics implied. */
export function solveTwoBone(input: TwoBoneInput): TwoBoneSolution {
  const forward = number(input.target?.forward, 'target.forward');
  const up = number(input.target?.up, 'target.up');
  const upper = number(input.upperLength, 'upperLength', 0.001, 1e4);
  const lower = number(input.lowerLength, 'lowerLength', 0.001, 1e4);
  const bend = input.bend ?? 1;
  if (bend !== 1 && bend !== -1) fail('bend must be 1 or -1');
  const requestedDistance = Math.hypot(forward, up);
  const epsilon = Math.min(upper, lower) * 1e-6;
  const distance = clamp(requestedDistance, Math.abs(upper - lower) + epsilon, upper + lower - epsilon);
  const target = requestedDistance > EPS ? { forward: forward * distance / requestedDistance, up: up * distance / requestedDistance } : { forward: 0, up: -distance };
  const rootAngle = -Math.atan2(target.forward, -target.up) - bend * Math.acos(clamp((upper * upper + distance * distance - lower * lower) / (2 * upper * distance), -1, 1));
  const bendAngle = bend * (Math.PI - Math.acos(clamp((upper * upper + lower * lower - distance * distance) / (2 * upper * lower), -1, 1)));
  return { rootAngle, bendAngle, endAngle: -rootAngle - bendAngle, target, distance, clamped: Math.abs(requestedDistance - distance) > EPS };
}
