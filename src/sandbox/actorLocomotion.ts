/** Ready-to-use humanoid locomotion for ActorAnimationController. Reference
 * poses stay in humanoid-v1 coordinates; apply body adaptation after layering.
 * World movement, future intent and support remain supplied by the game. */
import type { ActorPresentationSignals, AnimationPose, AnimationVector } from './animation.ts';
import type { ActorAnimationContext, ActorLocomotionDriver, ActorLocomotionResult } from './actorAnimation.ts';
import { HUMANOID_LOCOMOTION_RIG, sharedHumanoidLocomotion, type SharedLocomotionClip } from './animationLibrary.ts';
import { predictLocomotion, type LocomotionPrediction, type LocomotionPredictionInput } from './locomotion.ts';
import { MotionDatabase, MotionMatcher, type MotionMatcherDiagnostics, type MotionMatcherOptions, type MotionTrajectorySample } from './motionMatching.ts';

export const HUMANOID_TRAJECTORY_TIMES = Object.freeze([200, 400, 600]);
let database: MotionDatabase | undefined;
let humanoidSources: ReadonlyMap<string, SharedLocomotionClip> | undefined;
function humanoidSource(id: string | null | undefined): SharedLocomotionClip | undefined {
  if (id == null) return;
  humanoidSources ??= new Map(sharedHumanoidLocomotion().map(source => [source.id, source]));
  return humanoidSources.get(id);
}
/** One lazily built immutable index for all actors and all modes. */
export function sharedHumanoidMotionDatabase(): MotionDatabase {
  return database ??= new MotionDatabase({ schema: { trajectoryTimesMs: HUMANOID_TRAJECTORY_TIMES,
    trajectoryPositionWeight: 1, trajectoryDirectionWeight: .2, normalizationFloor: .1,
    contacts: [{ name: 'left-foot', weight: .025 }, { name: 'right-foot', weight: .025 }],
    joints: ['hips', 'left-hip', 'right-hip', 'left-knee', 'right-knee'].map(joint => ({ joint,
      positionWeight: joint === 'hips' ? .05 : 0, rotationWeight: .035,
      velocityWeight: joint === 'hips' ? .005 : 0, angularVelocityWeight: .005 })) },
    // Decoded clips and their trajectory/contact arrays are immutable. Sharing
    // exact samples avoids repeating the same work for a crowd's idle poses.
    sources: sharedHumanoidLocomotion(), sampleIntervalMs: 1000 / 30 });
}
export interface HumanoidLocomotionOptions {
  matcher?: MotionMatcherOptions;
  /** Name in signals.supports. Default: ground, root, then first supplied sample. */
  support?: string;
  prediction?: Pick<LocomotionPredictionInput, 'acceleration' | 'braking' | 'turnRate' | 'maxSpeed' | 'maxAge'>;
  /** Source playback follows observed velocity with a nonzero lower bound,
   * keeping outgoing gaits alive while motion matching selects a stop. */
  minPlaybackRate?: number;
  maxPlaybackRate?: number;
  playbackResponse?: number;
  contactResponse?: number;
}
const ZERO = { x: 0, y: 0, z: 0 }, UP = { x: 0, y: 1, z: 0 }, FORWARD = { x: 0, y: 0, z: 1 };
const dot = (a: AnimationVector, b: AnimationVector) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const lerp = (a: AnimationVector, b: AnimationVector, t: number): AnimationVector => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** Presentation-only heading for upright actors. The host still owns immediate
 * gameplay facing. Apply offsetYaw to a child of that host-oriented root, and
 * pass forward to animation/IK so the query uses the body's displayed frame. */
export class ActorHeading {
  private yaw = 0;
  private timeMs: number | undefined;
  private id: string | undefined;
  private epoch: string | number | undefined;
  private readonly response: number;
  private readonly maxFrameGapMs: number;
  constructor(options: { response?: number; maxFrameGapMs?: number } = {}) {
    this.response = options.response ?? 20;
    this.maxFrameGapMs = options.maxFrameGapMs ?? 1000;
    if (!Number.isFinite(this.response) || this.response < 0 || this.response > 100
      || !Number.isFinite(this.maxFrameGapMs) || this.maxFrameGapMs < 1 || this.maxFrameGapMs > 60000)
      throw new Error('Actor heading: response must be within 0..100 and maxFrameGapMs within 1..60000.');
  }
  reset(): void { this.timeMs = undefined; this.id = undefined; this.epoch = undefined; }
  sample(signals: Readonly<ActorPresentationSignals>, reset = false) {
    const facing = signals.facing ?? FORWARD;
    if (!Number.isFinite(signals.timeMs) || ![facing.x, facing.y, facing.z].every(Number.isFinite)
      || Math.hypot(facing.x, facing.z) < 1e-8)
      throw new Error('Actor heading: finite time and a nonzero horizontal facing are required.');
    const targetYaw = Math.atan2(facing.x, facing.z);
    const deltaMs = this.timeMs === undefined ? 0 : signals.timeMs - this.timeMs;
    const discontinuity = reset || this.timeMs === undefined || this.id !== signals.id || this.epoch !== signals.epoch
      || deltaMs < 0 || deltaMs > this.maxFrameGapMs;
    if (discontinuity || this.response === 0) this.yaw = targetYaw;
    else {
      const difference = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
      this.yaw += difference * (1 - Math.exp(-deltaMs / 1000 * this.response));
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    }
    this.timeMs = signals.timeMs; this.id = signals.id; this.epoch = signals.epoch;
    return { yaw: this.yaw, targetYaw,
      offsetYaw: Math.atan2(Math.sin(this.yaw - targetYaw), Math.cos(this.yaw - targetYaw)),
      forward: { x: Math.sin(this.yaw), y: 0, z: Math.cos(this.yaw) } };
  }
}

function vector(value: AnimationVector): AnimationVector {
  if (!value || ![value.x, value.y, value.z].every(n => Number.isFinite(n) && Math.abs(n) <= 1e6))
    throw new Error('Actor locomotion: expected finite world vectors within ±1000000.');
  return value;
}
function unit(value: AnimationVector): AnimationVector {
  vector(value); const length = Math.hypot(value.x, value.y, value.z);
  if (length < 1e-8) throw new Error('Actor locomotion: facing/up must be nonzero and independent.');
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}
function frame(signals: Readonly<ActorPresentationSignals>) {
  const up = unit(signals.up ?? UP), supplied = unit(signals.facing ?? FORWARD);
  const forward = unit(sub(supplied, { x: up.x * dot(up, supplied), y: up.y * dot(up, supplied), z: up.z * dot(up, supplied) }));
  return { up, forward, right: cross(up, forward) };
}
/** World future positions become root-local displacements at the shared index's
 * exact offsets. Explicit trajectories must cover 600 ms; no extrapolation. */
export function humanoidMotionTrajectory(signals: Readonly<ActorPresentationSignals>, prediction?: LocomotionPrediction): MotionTrajectorySample[] {
  const origin = vector(signals.position ?? ZERO), axes = frame(signals);
  const local = (value: AnimationVector) => ({ x: dot(value, axes.right), y: dot(value, axes.up), z: dot(value, axes.forward) });
  const supplied = signals.trajectory;
  // Library direction describes root orientation, not travel (animationLibrary
  // derives it from root yaw). A side/backward step or downhill drift must not
  // invent a turn. Preserve all predicted displacement; explicit trajectories
  // can still supply future facing when the game actually predicts a rotation.
  const entries = supplied ? supplied.map(sample => ({ afterMs: sample.afterMs, position: vector(sample.position),
    direction: sample.facing ? unit(sample.facing) : axes.forward })) : (prediction?.samples ?? []).map(sample => ({ afterMs: sample.time * 1000,
    position: vector(sample.position), direction: axes.forward }));
  if (!entries.length || entries.length > 32) throw new Error('Actor locomotion: trajectory needs 1..32 samples.');
  let previous = -1;
  for (const sample of entries) {
    if (!Number.isFinite(sample.afterMs) || sample.afterMs < 0 || sample.afterMs > 3000 || sample.afterMs <= previous)
      throw new Error('Actor locomotion: trajectory offsets must increase within 0..3000 ms.');
    previous = sample.afterMs;
  }
  if (entries.at(-1)!.afterMs < 600 - 1e-7) throw new Error('Actor locomotion: trajectory must cover the 600 ms search horizon.');
  if (entries[0].afterMs > 0) entries.unshift({ afterMs: 0, position: origin, direction: axes.forward });
  return HUMANOID_TRAJECTORY_TIMES.map(afterMs => {
    const upper = entries.findIndex(sample => sample.afterMs >= afterMs - 1e-7);
    const b = entries[upper], a = entries[Math.max(0, upper - 1)];
    const t = a === b ? 0 : Math.max(0, Math.min(1, (afterMs - a.afterMs) / (b.afterMs - a.afterMs)));
    let facing = lerp(a.direction, b.direction, t);
    if (Math.hypot(facing.x, facing.y, facing.z) < 1e-8) facing = t < .5 ? a.direction : b.direction;
    return { afterMs, position: local(sub(lerp(a.position, b.position, t), origin)), direction: local(unit(facing)) };
  });
}

export class HumanoidLocomotionDriver implements ActorLocomotionDriver {
  private readonly options: HumanoidLocomotionOptions;
  private readonly matcher: MotionMatcher;
  private pose: AnimationPose = {};
  private contacts: Record<string, number> = {};
  private motion: MotionMatcherDiagnostics | undefined;
  private rate = 1;
  private readonly minRate: number;
  private readonly maxRate: number;
  private readonly response: number;
  private readonly contactResponse: number;
  constructor(options: HumanoidLocomotionOptions = {}) {
    this.options = options;
    this.minRate = options.minPlaybackRate ?? .65; this.maxRate = options.maxPlaybackRate ?? 3;
    this.response = options.playbackResponse ?? 16; this.contactResponse = options.contactResponse ?? 14;
    if (![this.minRate, this.maxRate, this.response, this.contactResponse].every(Number.isFinite)
      || this.minRate <= 0 || this.maxRate < this.minRate || this.maxRate > 4 || this.response < 0 || this.response > 100 || this.contactResponse < 0 || this.contactResponse > 100)
      throw new Error('Actor locomotion: invalid playback/contact response options.');
    this.matcher = new MotionMatcher(sharedHumanoidMotionDatabase(), { blendMs: 140, searchIntervalMs: 80,
      switchCooldownMs: 180, continuityBias: .04, ...options.matcher });
  }
  reset(): void {
    this.matcher.reset(); this.pose = {}; this.contacts = {}; this.motion = undefined; this.rate = 1;
  }
  sample(context: Readonly<ActorAnimationContext>): ActorLocomotionResult {
    if (context.reset) this.reset();
    const signals = context.signals, delta = context.deltaMs / 1000, axes = frame(signals);
    const velocity = vector(signals.velocity ?? ZERO), origin = vector(signals.position ?? ZERO);
    const supports = signals.supports ?? {};
    const support = this.options.support ? supports[this.options.support] : supports.ground ?? supports.root ?? Object.values(supports)[0];
    const prediction = signals.trajectory ? undefined : predictLocomotion({ ...this.options.prediction, time: signals.timeMs / 1000,
      position: origin, velocity, frame: axes, samples: 3, horizon: .6,
      intent: signals.intendedVelocity ? { velocity: signals.intendedVelocity, observedAt: signals.timeMs / 1000 } : undefined,
      support: support && { point: support.position, normal: support.normal, observedAt: support.observedAtMs / 1000, grounded: signals.grounded } });
    const source = humanoidSource(this.motion?.selectedClip);
    const sourceSpeed = source?.speed(this.motion?.selectedTimeMs ?? 0) ?? 0;
    const planar = sub(velocity, { x: axes.up.x * dot(velocity, axes.up), y: axes.up.y * dot(velocity, axes.up), z: axes.up.z * dot(velocity, axes.up) });
    const planarSpeed = Math.hypot(planar.x, planar.y, planar.z);
    const requestedRate = !source?.clip.loop || sourceSpeed < .1 ? 1 : Math.max(this.minRate, Math.min(this.maxRate, planarSpeed / sourceSpeed));
    this.rate = delta > 0 ? this.rate + (requestedRate - this.rate) * (1 - Math.exp(-delta * this.response)) : requestedRate;
    // Match the pose about to render, not last frame's pose. The latter rewards
    // rewinding one frame, especially at low render rates. A centered derivative
    // uses the index's interval rather than a render-rate-dependent average.
    const continuation = this.matcher.continuationForOwnedQuery({ timeMs: signals.timeMs, epoch: signals.epoch,
      reset: context.reset, playbackRate: this.rate });
    const result = this.matcher.sampleWithOwnedQuery({ timeMs: signals.timeMs, epoch: signals.epoch, reset: context.reset, playbackRate: this.rate,
      query: { rig: HUMANOID_LOCOMOTION_RIG, requiredTags: ['grounded'], pose: this.pose, ...continuation,
        contacts: { 'left-foot': this.contacts['left-foot'] ?? 1, 'right-foot': this.contacts['right-foot'] ?? 1 },
        trajectory: humanoidMotionTrajectory(signals, prediction) } });
    this.pose = result.pose; this.motion = result.diagnostics;
    const selected = humanoidSource(result.diagnostics.selectedClip);
    const selectedContacts = selected?.contacts(result.diagnostics.selectedTimeMs ?? 0) ?? {};
    const contactAlpha = delta > 0 ? 1 - Math.exp(-delta * this.contactResponse) : 1;
    for (const name of ['left-foot', 'right-foot']) {
      const desired = selectedContacts[name] ?? 0, previous = this.contacts[name] ?? desired;
      this.contacts[name] = delta > 0 ? previous + (desired - previous) * contactAlpha : desired;
    }
    return { pose: this.pose, contacts: { ...this.contacts }, diagnostics: { source: this.motion.selectedClip,
      sourceTimeMs: this.motion.selectedTimeMs, phase: this.motion.selectedPhase, playbackRate: this.motion.playbackRate,
      ...(selected ? { sourceDurationMs: selected.clip.durationMs, loop: !!selected.clip.loop,
        idle: selected.tags.includes('idle'), holdsEnd: selected.endBehavior === 'hold' } : {}),
      state: signals.grounded === false ? 'airborne-fallback' : 'grounded', score: this.motion.score, switched: this.motion.switched,
      warnings: [...prediction?.warnings ?? [], ...this.motion.warnings,
        ...(signals.grounded === false ? ['Humanoid library currently supplies grounded locomotion; author an airborne driver/layer.'] : [])] } };
  }
}
