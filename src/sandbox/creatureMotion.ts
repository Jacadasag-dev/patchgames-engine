/** Recorded creature poses searched against explicit movement references. Most
 * imported loops are in-place: their default speeds below are authoring choices,
 * not motion-capture measurements. Gameplay always owns the actor's world root. */
import { blendAnimationPoses, defineAnimationClip, sampleAnimationClip, type AnimationPose, type AnimationVector } from './animation.ts';
import { CreatureAnimationController, sharedCreatureAnimations, type CreatureAnimationResult,
  type SharedCreatureBank, type SharedCreatureClip } from './creatureAnimationLibrary.ts';
import { MotionDatabase, MotionMatcher, type MotionJointFeature, type MotionMatcherDiagnostics,
  type MotionMatcherOptions, type MotionSource, type MotionTrajectorySample } from './motionMatching.ts';

export type CreatureMotionMode = 'ground' | 'flight' | 'swim';
export type CreatureMotionGait = 'idle' | 'walk' | 'run' | 'trot' | 'sneak' | 'slither' | 'swim' | 'fly' | 'glide';
export interface CreatureMotionReferenceInput {
  mode?: CreatureMotionMode;
  /** Authored metres/second in the actor reference frame (+Z forward, +Y up).
   * An explicit override also replaces measured travel for this clip. */
  velocity?: AnimationVector;
  direction?: AnimationVector;
}
export interface CreatureMotionReference {
  readonly clipId: string; readonly mode: CreatureMotionMode; readonly gait: CreatureMotionGait;
  readonly velocity: AnimationVector; readonly direction: AnimationVector;
  readonly trajectorySource: 'authored-reference' | 'measured-root';
}
export interface CreatureMotionOptions {
  referenceSpeeds?: Partial<Record<CreatureMotionGait, number>>;
  /** Exact clip ID overrides, useful for differently sized/custom actors. */
  references?: Readonly<Record<string, CreatureMotionReferenceInput>>;
  joints?: readonly MotionJointFeature[];
  sampleIntervalMs?: number;
}
export interface CreatureMotionSet {
  readonly bank: SharedCreatureBank; readonly database: MotionDatabase;
  readonly references: readonly CreatureMotionReference[]; readonly modes: readonly CreatureMotionMode[];
  readonly trajectoryTimesMs: readonly number[];
  readonly coverage: Readonly<{ poses: 'recorded'; trajectories: 'authored' | 'authored-and-measured';
    contacts: 'unavailable'; turns: 'unavailable'; transitions: 'blended' }>;
  readonly warnings: readonly string[];
}
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
const FORWARD = Object.freeze({ x: 0, y: 0, z: 1 });
const TIMES = Object.freeze([150, 350, 650]);
const SPEEDS: Readonly<Record<CreatureMotionGait, number>> = Object.freeze({
  idle: 0, walk: 1.4, run: 4, trot: 2.5, sneak: .65, slither: 1, swim: 2, fly: 5, glide: 7,
});
const EXCLUDED = new Set(['attack', 'jump', 'death', 'hit', 'reaction', 'reference', 'transition']);
const MODES: readonly CreatureMotionMode[] = ['ground', 'flight', 'swim'];
const fail = (message: string): never => { throw new Error(`Creature motion: ${message}.`); };
function finite(value: number, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`invalid ${label}`);
  return value;
}
function vector(value: AnimationVector, label: string, max = 1000): AnimationVector {
  if (!value || typeof value !== 'object') return fail(`invalid ${label}`);
  return Object.freeze({ x: finite(value.x, -max, max, label), y: finite(value.y, -max, max, label), z: finite(value.z, -max, max, label) });
}
function direction(value: AnimationVector): AnimationVector {
  const v = vector(value, 'reference direction', 1e6), length = Math.hypot(v.x, v.y, v.z);
  if (length < 1e-8) return fail('reference direction must not be zero');
  return Object.freeze({ x: v.x / length, y: v.y / length, z: v.z / length });
}
const scale = (v: AnimationVector, amount: number): AnimationVector => ({ x: v.x * amount, y: v.y * amount, z: v.z * amount });
const subtract = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
function gaitOf(clip: SharedCreatureClip): CreatureMotionGait | undefined {
  if (!clip.loop || clip.tags.some(tag => EXCLUDED.has(tag))) return undefined;
  return (['glide', 'fly', 'swim', 'run', 'trot', 'sneak', 'slither', 'walk', 'idle'] as const).find(tag => clip.tags.includes(tag));
}
function modeOf(gait: CreatureMotionGait, bank: SharedCreatureBank): CreatureMotionMode {
  return gait === 'fly' || gait === 'glide' ? 'flight' : gait === 'swim' || gait === 'idle' && bank.family === 'fish' ? 'swim' : 'ground';
}
/** Root displacement extended across complete loop cycles, retaining measured
 * within-cycle variation instead of replacing it with a guessed constant speed. */
function rootAt(clip: SharedCreatureClip, timeMs: number): AnimationVector {
  const cycles = Math.floor(timeMs / clip.durationMs), local = timeMs - cycles * clip.durationMs;
  const origin = clip.rootMotion!.sample(0), end = subtract(clip.rootMotion!.sample(clip.durationMs), origin);
  const sample = subtract(clip.rootMotion!.sample(local), origin);
  return { x: sample.x + end.x * cycles, y: sample.y + end.y * cycles, z: sample.z + end.z * cycles };
}
/** Pick informative animated joints without assuming a human skeleton or a
 * particular naming scheme. Rotation and translation scores use source poses. */
function defaultJoints(clips: readonly SharedCreatureClip[]): readonly MotionJointFeature[] {
  const energy = new Map<string, number>();
  for (const clip of clips) for (const phase of [0, .21, .47, .73]) {
    const pose = sampleAnimationClip(clip.clip, clip.durationMs * phase);
    for (const [name, joint] of Object.entries(pose)) {
      if (/^(?:PoleTarget|IK)/i.test(name)) continue;
      const p = joint.position ?? ZERO, q = joint.rotation;
      energy.set(name, (energy.get(name) ?? 0) + Math.hypot(p.x, p.y, p.z) + (q ? 1 - Math.abs(q.w) : 0));
    }
  }
  return [...energy].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
    .map(([joint]) => ({ joint, positionWeight: .025, rotationWeight: .06, velocityWeight: .003, angularVelocityWeight: .003 }));
}
/** Build an exact frame index from a compatible bank. Only continuous idle and
 * locomotion loops enter automatic search; actions remain explicitly triggered. */
export function createCreatureMotionSet(bank: SharedCreatureBank, options: CreatureMotionOptions = {}): CreatureMotionSet {
  if (!bank?.rig?.id || !bank.clips?.length) return fail('expected a decoded creature bank');
  const speeds = { ...SPEEDS };
  for (const [gait, value] of Object.entries(options.referenceSpeeds ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(SPEEDS, gait)) fail(`unknown gait ${gait}`);
    speeds[gait as CreatureMotionGait] = finite(value, 0, 1000, `${gait} speed`);
  }
  const clips = bank.clips.filter(clip => gaitOf(clip));
  if (!clips.length) return fail('bank has no continuous idle/locomotion loops');
  const clipIds = new Set(clips.map(clip => clip.id));
  for (const id of Object.keys(options.references ?? {})) if (!clipIds.has(id)) fail(`reference ${id} is not a continuous locomotion clip`);
  const references = clips.map((clip): CreatureMotionReference => {
    const gait = gaitOf(clip)!, override = options.references?.[clip.id], mode = override?.mode ?? modeOf(gait, bank);
    if (!MODES.includes(mode)) return fail('invalid locomotion mode');
    const measured = !!clip.rootMotion && !override?.velocity && options.referenceSpeeds?.[gait] === undefined;
    const velocity = measured ? scale(subtract(clip.rootMotion!.sample(clip.durationMs), clip.rootMotion!.sample(0)), 1000 / clip.durationMs)
      : override?.velocity ?? { x: 0, y: 0, z: speeds[gait] };
    return Object.freeze({ clipId: clip.id, mode, gait, velocity: vector(velocity, 'reference velocity'),
      direction: direction(override?.direction ?? FORWARD), trajectorySource: measured ? 'measured-root' : 'authored-reference' });
  });
  const joints = options.joints ?? defaultJoints(clips);
  const rigJoints = new Set(bank.rig.joints.map(joint => joint.name));
  for (const joint of joints) if (!rigJoints.has(joint.joint)) fail(`unknown feature joint ${joint.joint}`);
  // Sparse channels omitted by the importer mean a measured identity/rest delta,
  // not an absent bone. Make those implicit values explicit for feature coverage.
  const rest = Object.fromEntries(joints.map(joint => [joint.joint, {}]));
  const sources: MotionSource[] = clips.map((clip, index) => {
    const reference = references[index];
    const indexedClip = defineAnimationClip({ durationMs: clip.durationMs, loop: true,
      sample: ({ timeMs }) => ({ ...rest, ...sampleAnimationClip(clip.clip, timeMs) }) });
    return { id: clip.id, rig: bank.rig.id, tags: [...clip.tags, `mode-${reference.mode}`, reference.gait === 'idle' ? 'travel-idle' : 'travel-moving'], clip: indexedClip,
      trajectory(timeMs, afterMs) {
        return { position: reference.trajectorySource === 'measured-root'
          ? subtract(rootAt(clip, timeMs + afterMs), rootAt(clip, timeMs)) : scale(reference.velocity, afterMs / 1000),
        direction: reference.direction };
      } };
  });
  const measured = references.some(reference => reference.trajectorySource === 'measured-root');
  const database = new MotionDatabase({ sources, sampleIntervalMs: options.sampleIntervalMs ?? 80,
    schema: { trajectoryTimesMs: TIMES, trajectoryPositionWeight: 6, trajectoryDirectionWeight: 1,
      joints, normalizationFloor: .08 }, maxFrames: 4096 });
  return Object.freeze({ bank, database, references: Object.freeze(references),
    modes: Object.freeze([...new Set(references.map(reference => reference.mode))]), trajectoryTimesMs: TIMES,
    coverage: Object.freeze({ poses: 'recorded', trajectories: measured ? 'authored-and-measured' : 'authored',
      contacts: 'unavailable', turns: 'unavailable', transitions: 'blended' }),
    warnings: Object.freeze(['In-place loop speeds are authored references; tune them to the actor and gameplay.',
      'These sparse banks have no recorded turn/start/stop coverage or verified contact annotations.']) });
}
const shared = new Map<string, CreatureMotionSet>();
const byBank = new WeakMap<SharedCreatureBank, CreatureMotionSet>();
/** Shared immutable index; construct one controller per actor, not per frame. */
export function sharedCreatureMotion(bankId: string): CreatureMotionSet {
  let set = shared.get(bankId);
  if (!set) { set = createCreatureMotionSet(sharedCreatureAnimations(bankId)); shared.set(bankId, set); byBank.set(set.bank, set); }
  return set;
}
export interface CreatureWorldPrediction {
  readonly samples: readonly { time: number; position: AnimationVector; velocity: AnimationVector; direction?: AnimationVector }[];
}
/** Convert predictLocomotion/predictFlight output directly into exact matcher
 * offsets. Predictor times are seconds; returned afterMs values are milliseconds.
 * Positions become displacements in the current actor frame, never world origins.
 * Interpolates available observations, refusing to extrapolate a short horizon. */
export function creatureMotionTrajectory(prediction: CreatureWorldPrediction,
  actor: { position: AnimationVector; frame: { up: AnimationVector; forward: AnimationVector } },
  timesMs: readonly number[] = TIMES): MotionTrajectorySample[] {
  const origin = vector(actor?.position, 'actor position', 1e6), forward = direction(actor?.frame?.forward);
  const suppliedUp = direction(actor?.frame?.up);
  const dot = (a: AnimationVector, b: AnimationVector) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  let right = cross(suppliedUp, forward);
  if (Math.hypot(right.x, right.y, right.z) < 1e-8) right = cross(Math.abs(forward.x) < .8 ? { x: 1, y: 0, z: 0 } : FORWARD, forward);
  right = direction(right);
  const up = direction(cross(forward, right));
  const local = (value: AnimationVector): AnimationVector => ({ x: dot(value, right), y: dot(value, up), z: dot(value, forward) });
  if (!Array.isArray(prediction?.samples) || !prediction.samples.length || prediction.samples.length > 32) fail('prediction requires 1..32 samples');
  if (!Array.isArray(timesMs) || !timesMs.length || timesMs.length > 8) fail('trajectory requires 1..8 offsets');
  let previous = -1;
  const requested = timesMs.map(time => {
    finite(time, 0, 3000, 'trajectory offset');
    if (time <= previous) fail('trajectory offsets must increase');
    previous = time; return time;
  });
  previous = -1;
  const samples = prediction.samples.map(sample => {
    const time = finite(sample.time, 0, 3, 'prediction time') * 1000;
    if (time <= previous) fail('prediction sample times must increase');
    previous = time;
    const velocity = vector(sample.velocity, 'prediction velocity', 1e6);
    const facing = sample.direction ? direction(sample.direction) : Math.hypot(velocity.x, velocity.y, velocity.z) > 1e-8 ? direction(velocity) : forward;
    return { time, position: vector(sample.position, 'prediction position', 1e6), direction: facing };
  });
  if (requested[requested.length - 1] > samples[samples.length - 1].time + 1e-7) fail('prediction horizon does not cover requested trajectory offsets');
  if (samples[0].time > 0) samples.unshift({ time: 0, position: origin, direction: forward });
  const mix = (a: AnimationVector, b: AnimationVector, t: number): AnimationVector => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  return requested.map(afterMs => {
    let upper = samples.findIndex(sample => sample.time >= afterMs - 1e-7);
    if (upper < 0) upper = samples.length - 1;
    const b = samples[upper], a = samples[Math.max(0, upper - 1)];
    const amount = a === b ? 0 : Math.max(0, Math.min(1, (afterMs - a.time) / (b.time - a.time)));
    let facing = mix(a.direction, b.direction, amount);
    if (Math.hypot(facing.x, facing.y, facing.z) < 1e-8) facing = amount < .5 ? a.direction : b.direction;
    return { afterMs, position: local(subtract(mix(a.position, b.position, amount), origin)), direction: local(direction(facing)) };
  });
}
export interface CreatureMotionFrame {
  timeMs: number; epoch?: string | number; reset?: boolean;
  /** Current movement in the actor reference frame, not world coordinates. */
  velocity: AnimationVector;
  mode?: CreatureMotionMode;
  /** Predicted future root displacement/facing in the same actor reference frame.
   * Omit for a straight constant-velocity query; supplying prediction lets the
   * matcher anticipate braking/acceleration without changing gameplay physics. */
  trajectory?: readonly MotionTrajectorySample[];
  action?: { name: string; id?: string | number; variant?: number };
  playbackRate?: number;
}
export interface CreatureMotionResult {
  pose: AnimationPose;
  diagnostics: MotionMatcherDiagnostics & {
    state: 'locomotion' | 'action'; mode: CreatureMotionMode;
    reference: CreatureMotionReference | null;
    /** True when the requested travel exceeds this mode's calibrated references. */
    referenceLimited: boolean;
    /** Outer locomotion/action crossfade, independent from matcher transitions. */
    presentationBlend: number;
    action?: CreatureAnimationResult['diagnostics'];
  };
}
/** Pose/velocity/trajectory matching plus interruptible action transitions. The
 * locomotion clock continues beneath actions, so returning never restarts a loop.
 * This wrapper adds no collision, gravity, root movement or gameplay decisions. */
export class CreatureMotionController {
  readonly motion: CreatureMotionSet;
  private readonly matcher: MotionMatcher;
  private readonly actions: CreatureAnimationController;
  private readonly blendMs: number;
  private readonly maxFrameGapMs: number;
  private pose: AnimationPose = {};
  private locomotionPose: AnimationPose = {};
  private previousLocomotionPose?: AnimationPose;
  private moving = false;
  private previousTime?: number;
  private previousEpoch?: string | number;
  private state: 'locomotion' | 'action' = 'locomotion';
  private outgoing?: AnimationPose;
  private blendElapsed = 0;
  constructor(bankOrSet: SharedCreatureBank | CreatureMotionSet, options: MotionMatcherOptions = {}) {
    if ('database' in bankOrSet) this.motion = bankOrSet;
    else {
      let motion = byBank.get(bankOrSet);
      if (!motion) { motion = createCreatureMotionSet(bankOrSet); byBank.set(bankOrSet, motion); }
      this.motion = motion;
    }
    this.blendMs = finite(options.blendMs ?? 160, 0, 2000, 'blend duration');
    this.maxFrameGapMs = finite(options.maxFrameGapMs ?? 1000, 1, 60_000, 'maximum frame gap');
    this.matcher = new MotionMatcher(this.motion.database, { blendMs: this.blendMs, continuityBias: .3,
      switchCooldownMs: 180, searchIntervalMs: 80, continuationWindowMs: 200, preserveLoopPhase: true, ...options });
    this.actions = new CreatureAnimationController(this.motion.bank, { blendMs: this.blendMs });
  }
  reset(): void {
    this.matcher.reset(); this.actions.reset(); this.pose = {}; this.locomotionPose = {}; this.previousLocomotionPose = undefined; this.moving = false;
    this.previousTime = undefined; this.previousEpoch = undefined; this.state = 'locomotion';
    this.outgoing = undefined; this.blendElapsed = 0;
  }
  sample(frame: CreatureMotionFrame): CreatureMotionResult {
    finite(frame.timeMs, -1e12, 1e12, 'time');
    const velocity = vector(frame.velocity, 'velocity');
    if (frame.mode !== undefined && !MODES.includes(frame.mode)) fail('invalid locomotion mode');
    const reset = !!frame.reset || this.previousTime === undefined || frame.timeMs < this.previousTime
      || frame.timeMs - this.previousTime > this.maxFrameGapMs || frame.epoch !== this.previousEpoch;
    if (reset) this.reset();
    const deltaMs = this.previousTime === undefined ? 0 : frame.timeMs - this.previousTime;
    const requestedMode = frame.mode ?? (this.motion.modes.includes('ground') ? 'ground' : this.motion.modes[0]);
    const mode = this.motion.modes.includes(requestedMode) ? requestedMode : this.motion.modes[0];
    const warnings = [...this.motion.warnings];
    if (mode !== requestedMode) warnings.push(`No ${requestedMode} locomotion in ${this.motion.bank.id}; using ${mode}.`);
    const rawTrajectory = frame.trajectory ?? this.motion.trajectoryTimesMs.map(afterMs => ({ afterMs, position: scale(velocity, afterMs / 1000), direction: FORWARD }));
    if (!Array.isArray(rawTrajectory) || rawTrajectory.length !== this.motion.trajectoryTimesMs.length)
      fail('prediction must include the exact database trajectory offsets');
    const requestedTrajectory = rawTrajectory.map((sample, index) => {
      if (!sample || sample.afterMs !== this.motion.trajectoryTimesMs[index]) fail('prediction must include the exact database trajectory offsets');
      return { afterMs: sample.afterMs, position: vector(sample.position, 'trajectory position', 1e6), direction: direction(sample.direction) };
    });
    const predicted = requestedTrajectory.find(sample => sample.afterMs > 0);
    const speed = Math.max(Math.hypot(velocity.x, velocity.y, velocity.z), predicted
      ? Math.hypot(predicted.position.x, predicted.position.y, predicted.position.z) * 1000 / predicted.afterMs : 0);
    this.moving = speed > (this.moving ? .08 : .15);
    const travel = this.moving ? 'travel-moving' : 'travel-idle';
    const hasTravel = this.motion.references.some(reference => reference.mode === mode && (reference.gait !== 'idle') === this.moving);
    if (!hasTravel) warnings.push(`No ${this.moving ? 'moving' : 'idle'} ${mode} loop in ${this.motion.bank.id}; using available ${mode} motion.`);
    // Outside recorded/authored speed coverage, chasing a cycle's isolated peak
    // creates repeated switches without ever satisfying the query. Select the
    // nearest calibrated travel while reporting the deficit. This affects only
    // feature search; the actor's real movement and supplied prediction stay intact.
    const maxSpeed = Math.max(...this.motion.references.filter(reference => reference.mode === mode)
      .map(reference => Math.hypot(reference.velocity.x, reference.velocity.y, reference.velocity.z)));
    let referenceLimited = false;
    const trajectory = requestedTrajectory.map(sample => {
      const distance = Math.hypot(sample.position.x, sample.position.y, sample.position.z);
      const maximum = maxSpeed * sample.afterMs / 1000;
      if (distance <= maximum + 1e-8 || sample.afterMs === 0) return sample;
      referenceLimited = true;
      return { ...sample, position: scale(sample.position, maximum / distance) };
    });
    if (referenceLimited) warnings.push(`Requested travel exceeds ${mode} reference coverage (${maxSpeed.toFixed(2)} m/s); using the nearest calibrated motion.`);
    const matched = this.matcher.sample({ timeMs: frame.timeMs, epoch: frame.epoch, playbackRate: frame.playbackRate,
      query: { rig: this.motion.bank.rig.id, requiredTags: [`mode-${mode}`, ...(hasTravel ? [travel] : [])], trajectory, pose: this.locomotionPose,
        ...(this.previousLocomotionPose && deltaMs > 0 ? { previousPose: this.previousLocomotionPose, poseDeltaMs: deltaMs } : {}) } });
    const state = frame.action ? 'action' : 'locomotion';
    let target = matched.pose, action: CreatureAnimationResult['diagnostics'] | undefined;
    if (frame.action) {
      if (this.state !== 'action') this.actions.reset();
      const result = this.actions.sample({ timeMs: frame.timeMs, epoch: frame.epoch, action: frame.action.name,
        actionId: frame.action.id, variant: frame.action.variant, playbackRate: frame.playbackRate });
      target = result.pose; action = result.diagnostics; warnings.push(...action.warnings);
    }
    this.blendElapsed += deltaMs;
    if (state !== this.state && this.previousTime !== undefined && this.blendMs > 0) {
      this.outgoing = this.pose; this.blendElapsed = 0;
    }
    const progress = this.blendMs ? Math.min(1, this.blendElapsed / this.blendMs) : 1;
    const output = this.outgoing && progress < 1 ? progress === 0 ? this.outgoing
      : blendAnimationPoses(this.outgoing, target, progress * progress * (3 - 2 * progress)) : target;
    if (progress === 1) this.outgoing = undefined;
    this.previousLocomotionPose = this.locomotionPose; this.locomotionPose = matched.pose; this.pose = output; this.state = state;
    this.previousTime = frame.timeMs; this.previousEpoch = frame.epoch;
    const reference = this.motion.references.find(value => value.clipId === matched.diagnostics.selectedClip) ?? null;
    return { pose: output, diagnostics: { ...matched.diagnostics, reset: reset || matched.diagnostics.reset,
      state, mode, reference, referenceLimited, presentationBlend: this.outgoing ? progress : 1, ...(action ? { action } : {}),
      warnings: [...new Set([...warnings, ...matched.diagnostics.warnings])] } };
  }
}
