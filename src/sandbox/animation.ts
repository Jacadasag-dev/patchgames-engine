/**
 * Deterministic, renderer-independent animation math. Poses are LOCAL deltas
 * from a rig's rest pose: world units, quaternion rotations, and multiplicative scale.
 * This module never moves physics or decides damage, cooldowns or action timing.
 * Legacy rig.ts Euler animation helpers intentionally retain their old behavior.
 */
export const ANIMATION_VERSION = 'animation-v1';

export interface AnimationVector { x: number; y: number; z: number }
export interface AnimationQuaternion extends AnimationVector { w: number }
export interface AnimationJointTransform {
  position?: AnimationVector;
  rotation?: AnimationQuaternion;
  scale?: AnimationVector;
}
export type AnimationPose = Readonly<Record<string, Readonly<AnimationJointTransform>>>;
/** A supplied mask excludes unlisted joints. Values are weights in [0, 1]. */
export type AnimationMask = Readonly<Record<string, number>>;
export type AnimationParameters = Readonly<Record<string, number | boolean>>;
export type AnimationBlendMode = 'override' | 'additive';

/** A base/feature adapts its state into these signals; clips need no mode-private fields. */
export interface ActorPresentationSignals {
  id: string;
  timeMs: number;
  /** Change when an actor is replaced or the session clock restarts. */
  epoch?: string | number;
  /** Authoritative world origin; presentation never writes it back to gameplay. */
  position?: AnimationVector;
  velocity?: AnimationVector;
  intendedVelocity?: AnimationVector;
  facing?: AnimationVector;
  up?: AnimationVector;
  grounded?: boolean;
  posture?: string;
  parameters?: AnimationParameters;
  actions?: readonly AnimationAction[];
  /** Actual support samples in the same world/movement frame as the actor. */
  supports?: Readonly<Record<string, { position: AnimationVector; normal: AnimationVector; observedAtMs: number; weight?: number }>>;
  /** Estimated, not authoritative, WORLD positions and facing directions.
   * afterMs is relative to timeMs; motion drivers convert to actor-local space. */
  trajectory?: readonly { afterMs: number; position: AnimationVector; facing?: AnimationVector }[];
}

export interface AnimationSampleContext {
  /** Local clip time, clamped for one-shots or wrapped for looping clips. */
  timeMs: number;
  phase: number;
  cycle: number;
  parameters: AnimationParameters;
  signals?: Readonly<ActorPresentationSignals>;
}
interface AnimationClipBase { durationMs: number; loop?: boolean }
export type AnimationClip = AnimationClipBase & (
  | { keyframes: readonly { atMs: number; pose: AnimationPose }[]; sample?: never }
  | { sample(context: Readonly<AnimationSampleContext>): AnimationPose; keyframes?: never }
);
export interface AnimationSampleOptions {
  /** Overrides local time with a shared normalized phase, for synchronized gaits. */
  phase?: number;
  parameters?: AnimationParameters;
  signals?: Readonly<ActorPresentationSignals>;
}
export interface AnimationPoseLayer {
  pose: AnimationPose;
  weight?: number;
  mask?: AnimationMask;
  mode?: AnimationBlendMode;
}
export interface AnimationClipLayer extends Omit<AnimationPoseLayer, 'pose'> {
  id?: string;
  clip: string;
  /** Explicit elapsed clip time. Defaults to frame time; it never uses a wall clock. */
  timeMs?: number;
  phase?: number;
}
export interface AnimationAction extends Omit<AnimationClipLayer, 'timeMs' | 'phase' | 'id'> {
  /** Unique instance ID, not a boolean attack flag or merely a clip name. */
  id: string;
  startedAtMs: number;
  channel?: string;
  priority?: number;
  /** Which new actions can interrupt this one. Default: equal-or-higher. */
  interruption?: 'higher' | 'equal-or-higher' | 'never';
  fadeInMs?: number;
  /** Fade to the underlying layers during the final interval of this clip. */
  fadeOutMs?: number;
}
export interface AnimationFrame extends AnimationSampleOptions {
  timeMs: number;
  epoch?: string | number;
  base?: AnimationPose;
  /** Optional unmodified reference base. Reuses this frame's sampled layers and
   * actions to preserve matcher history when presentation modifies base motion. */
  referenceBase?: AnimationPose;
  layers?: readonly AnimationClipLayer[];
  /** Newly observed or repeated current instances. Accepted instances finish even if omitted later. */
  actions?: readonly AnimationAction[];
}
export interface AnimationLayerDiagnostic {
  id: string; clip: string; timeMs: number; phase: number; weight: number; mode: AnimationBlendMode;
}
export interface AnimationActionDiagnostic {
  id: string; clip: string; channel: string; elapsedMs: number; phase: number; weight: number;
  status: 'active' | 'completed' | 'future' | 'suppressed' | 'missing';
}
export interface AnimationDiagnostics {
  reset: boolean;
  layers: AnimationLayerDiagnostic[];
  actions: AnimationActionDiagnostic[];
  warnings: string[];
}
export interface AnimationResult { pose: AnimationPose; diagnostics: AnimationDiagnostics; referencePose?: AnimationPose }

const MAX_JOINTS = 128;
const MAX_LAYERS = 32;
const MAX_ACTIONS = 32;
const MAX_CHANNELS = 16;
const MAX_HISTORY = 256;
const ZERO: AnimationVector = Object.freeze({ x: 0, y: 0, z: 0 });
const ONE: AnimationVector = Object.freeze({ x: 1, y: 1, z: 1 });
export const ANIMATION_IDENTITY_ROTATION: Readonly<AnimationQuaternion> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
function fail(message: string): never { throw new Error(`Animation: ${message}`); }
function finite(value: number, label: string, limit = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value) || Math.abs(value) > limit) fail(`${label} must be finite within ±${limit}`);
  return value;
}
// Joint/clip/parameter names are immutable strings, even when the surrounding
// authored pose is mutable. Bound the cache independently of actor lifetime.
const validNames = new Set<string>();
function name(value: string, label: string): string {
  if (validNames.has(value)) return value;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,95}$/.test(value)) fail(`${label} must be a nonempty name (max 96 characters)`);
  if (validNames.size === 512) validNames.delete(validNames.values().next().value!);
  validNames.add(value);
  return value;
}
function unitWeight(value: number, label = 'weight'): number {
  finite(value, label, 1);
  if (value < 0) fail(`${label} must be in [0, 1]`);
  return value;
}
function vector(value: AnimationVector, label: string): AnimationVector {
  return vectorInto(value, label, { x: 0, y: 0, z: 0 });
}
function vectorInto(value: AnimationVector, label: string, output: AnimationVector): AnimationVector {
  if (!value || typeof value !== 'object') fail(`${label} must be {x, y, z}`);
  output.x = finite(value.x, `${label}.x`, 1e4); output.y = finite(value.y, `${label}.y`, 1e4); output.z = finite(value.z, `${label}.z`, 1e4);
  return output;
}
export function normalizeAnimationQuaternion(value: AnimationQuaternion): AnimationQuaternion {
  return quaternionInto(value, { x: 0, y: 0, z: 0, w: 1 });
}
function quaternionInto(value: AnimationQuaternion, output: AnimationQuaternion): AnimationQuaternion {
  if (!value || typeof value !== 'object') fail('rotation must be {x, y, z, w}');
  const x = finite(value.x, 'rotation.x', 1e4);
  const y = finite(value.y, 'rotation.y', 1e4);
  const z = finite(value.z, 'rotation.z', 1e4);
  const w = finite(value.w, 'rotation.w', 1e4);
  const length = Math.hypot(x, y, z, w);
  if (length < 1e-9) fail('rotation quaternion must not be zero');
  output.x = x / length; output.y = y / length; output.z = z / length; output.w = w / length;
  return output;
}
/** XYZ Euler RADIANS. The legacy rig.ts API continues to use degrees. */
export function quaternionFromEuler(angles: Partial<AnimationVector>): AnimationQuaternion {
  const x = finite(angles.x ?? 0, 'Euler.x', 1e4) / 2;
  const y = finite(angles.y ?? 0, 'Euler.y', 1e4) / 2;
  const z = finite(angles.z ?? 0, 'Euler.z', 1e4) / 2;
  const cx = Math.cos(x), cy = Math.cos(y), cz = Math.cos(z);
  const sx = Math.sin(x), sy = Math.sin(y), sz = Math.sin(z);
  return { x: sx * cy * cz + cx * sy * sz, y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz, w: cx * cy * cz - sx * sy * sz };
}
/** Compose local rotations in order: base * delta. */
export function multiplyAnimationQuaternions(base: AnimationQuaternion, delta: AnimationQuaternion): AnimationQuaternion {
  const a = normalizeAnimationQuaternion(base), b = normalizeAnimationQuaternion(delta);
  return normalizeAnimationQuaternion({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  });
}
/** Shortest-arc interpolation, including equivalent q / -q representations. */
export function slerpAnimationQuaternions(from: AnimationQuaternion, to: AnimationQuaternion, amount: number): AnimationQuaternion {
  const t = unitWeight(amount);
  const a = normalizeAnimationQuaternion(from);
  let b = normalizeAnimationQuaternion(to);
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  if (dot < 0) { b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }; dot = -dot; }
  dot = Math.min(1, dot);
  let left = 1 - t, right = t;
  if (dot < 0.9995) {
    const angle = Math.acos(dot), sine = Math.sin(angle);
    left = Math.sin((1 - t) * angle) / sine;
    right = Math.sin(t * angle) / sine;
  }
  return normalizeAnimationQuaternion({ x: a.x * left + b.x * right, y: a.y * left + b.y * right,
    z: a.z * left + b.z * right, w: a.w * left + b.w * right });
}
/** Validate atomically and return a detached copy with unit quaternions. */
export function validateAnimationPose(pose: AnimationPose): AnimationPose {
  if (!pose || typeof pose !== 'object' || Array.isArray(pose)) fail('pose must be a joint dictionary');
  const entries = Object.entries(pose);
  if (entries.length > MAX_JOINTS) fail(`pose exceeds ${MAX_JOINTS} joints`);
  const result = dictionary<AnimationJointTransform>();
  for (const [joint, transform] of entries) {
    name(joint, 'joint');
    if (!transform || typeof transform !== 'object' || Array.isArray(transform)) fail(`${joint} needs a transform`);
    for (const property of Object.keys(transform)) {
      if (property !== 'position' && property !== 'rotation' && property !== 'scale') fail(`${joint}.${property} is unknown; use position, rotation and scale`);
    }
    const out: AnimationJointTransform = {};
    if (transform.position !== undefined) out.position = vector(transform.position, `${joint}.position`);
    if (transform.rotation !== undefined) out.rotation = normalizeAnimationQuaternion(transform.rotation);
    if (transform.scale !== undefined) out.scale = vector(transform.scale, `${joint}.scale`);
    result[joint] = out;
  }
  return result;
}
const readonlySamples = new WeakSet<AnimationPose>();
const validatedReadonlySamples = new WeakMap<AnimationPose, AnimationPose>();
/** @internal Feature readers can share the next validation/normalization of an
 * engine-owned immutable sample. Mutable or externally frozen poses are always
 * validated anew with ordinary detached output; normalized outputs are not
 * registered as sample provenance. */
export function validateAnimationPoseReadonly(pose: AnimationPose): AnimationPose {
  if (!readonlySamples.has(pose)) return validateAnimationPose(pose);
  const cached = validatedReadonlySamples.get(pose);
  if (cached) return cached;
  const result = freezePose(validateAnimationPose(pose));
  validatedReadonlySamples.set(pose, result);
  return result;
}
type PoseSlot = { transform: AnimationJointTransform; position?: AnimationVector; rotation?: AnimationQuaternion; scale?: AnimationVector };

/** Per-owner scratch storage for the render hot path. read() still validates
 * every input; its borrowed result is valid only until the next read(). It
 * never aliases the input or another buffer and retains at most 128 joints. */
export class AnimationPoseBuffer {
  private readonly slots: PoseSlot[] = [];
  private readonly pose = dictionary<AnimationJointTransform>();
  read(input: AnimationPose): AnimationPose {
    return validatedPoseInto(input === this.pose ? validateAnimationPose(input) : input, this.pose, this.slots);
  }
}
function validatedPoseInto(pose: AnimationPose, result: Record<string, AnimationJointTransform>, slots: PoseSlot[]): AnimationPose {
  if (!pose || typeof pose !== 'object' || Array.isArray(pose)) fail('pose must be a joint dictionary');
  const entries = Object.entries(pose);
  if (entries.length > MAX_JOINTS) fail(`pose exceeds ${MAX_JOINTS} joints`);
  for (const joint of Object.keys(result)) if (!own(pose, joint)) delete result[joint];
  for (let index = 0; index < entries.length; index++) {
    const [joint, transform] = entries[index];
    name(joint, 'joint');
    if (!transform || typeof transform !== 'object' || Array.isArray(transform)) fail(`${joint} needs a transform`);
    for (const property of Object.keys(transform)) {
      if (property !== 'position' && property !== 'rotation' && property !== 'scale') fail(`${joint}.${property} is unknown; use position, rotation and scale`);
    }
    const slot = slots[index] ??= { transform: {} };
    const out = slot.transform;
    if (transform.position !== undefined) out.position = vectorInto(transform.position, `${joint}.position`, slot.position ??= { x: 0, y: 0, z: 0 });
    else delete out.position;
    if (transform.rotation !== undefined) out.rotation = quaternionInto(transform.rotation, slot.rotation ??= { x: 0, y: 0, z: 0, w: 1 });
    else delete out.rotation;
    if (transform.scale !== undefined) out.scale = vectorInto(transform.scale, `${joint}.scale`, slot.scale ??= { x: 0, y: 0, z: 0 });
    else delete out.scale;
    result[joint] = out;
  }
  return result;
}

/** @internal Reusable rig input in binding order: position[0..2], quaternion
 * [3..6], scale[7..9]. Float64 preserves the ordinary pose validator's exact
 * values. Channel bits are position=1, rotation=2, scale=4; absent joints reset
 * to rest. A complete read succeeds before any renderer node may be changed. */
export class AnimationTransformBuffer {
  readonly values: Float64Array;
  readonly channels: Uint8Array;
  private readonly indices = new Map<string, number>();
  private readonly scratchOffset: number;
  constructor(joints: readonly string[]) {
    if (joints.length > MAX_JOINTS) fail(`pose exceeds ${MAX_JOINTS} joints`);
    for (const [index, joint] of joints.entries()) {
      name(joint, 'joint');
      if (this.indices.has(joint)) fail('rig joints must be unique');
      this.indices.set(joint, index);
    }
    this.scratchOffset = joints.length * 10;
    this.values = new Float64Array(this.scratchOffset + 10);
    this.channels = new Uint8Array(joints.length);
  }
  read(pose: AnimationPose): { mapped: number; unmapped: string[] } {
    if (!pose || typeof pose !== 'object' || Array.isArray(pose)) fail('pose must be a joint dictionary');
    const entries = Object.entries(pose);
    if (entries.length > MAX_JOINTS) fail(`pose exceeds ${MAX_JOINTS} joints`);
    this.channels.fill(0);
    const unmapped: string[] = [], values = this.values;
    let mapped = 0;
    for (const [joint, transform] of entries) {
      name(joint, 'joint');
      if (!transform || typeof transform !== 'object' || Array.isArray(transform)) fail(`${joint} needs a transform`);
      for (const property of Object.keys(transform)) {
        if (property !== 'position' && property !== 'rotation' && property !== 'scale') fail(`${joint}.${property} is unknown; use position, rotation and scale`);
      }
      const index = this.indices.get(joint), offset = index === undefined ? this.scratchOffset : index * 10;
      let channels = 0;
      if (transform.position !== undefined) {
        vectorIntoArray(transform.position, `${joint}.position`, values, offset); channels |= 1;
      }
      if (transform.rotation !== undefined) {
        const rotation = transform.rotation;
        if (!rotation || typeof rotation !== 'object') fail('rotation must be {x, y, z, w}');
        const x = finite(rotation.x, 'rotation.x', 1e4), y = finite(rotation.y, 'rotation.y', 1e4);
        const z = finite(rotation.z, 'rotation.z', 1e4), w = finite(rotation.w, 'rotation.w', 1e4);
        const length = Math.hypot(x, y, z, w);
        if (length < 1e-9) fail('rotation quaternion must not be zero');
        values[offset + 3] = x / length; values[offset + 4] = y / length;
        values[offset + 5] = z / length; values[offset + 6] = w / length; channels |= 2;
      }
      if (transform.scale !== undefined) {
        vectorIntoArray(transform.scale, `${joint}.scale`, values, offset + 7); channels |= 4;
      }
      if (index === undefined) unmapped.push(joint);
      else { this.channels[index] = channels; mapped++; }
    }
    return { mapped, unmapped };
  }
}
function vectorIntoArray(value: AnimationVector, label: string, output: Float64Array, offset: number): void {
  if (!value || typeof value !== 'object') fail(`${label} must be {x, y, z}`);
  output[offset] = finite(value.x, `${label}.x`, 1e4);
  output[offset + 1] = finite(value.y, `${label}.y`, 1e4);
  output[offset + 2] = finite(value.z, `${label}.z`, 1e4);
}
function validateMask(mask: AnimationMask | undefined): void {
  if (mask === undefined) return;
  if (!mask || typeof mask !== 'object' || Array.isArray(mask) || Object.keys(mask).length > MAX_JOINTS) fail('invalid joint mask');
  for (const [joint, weight] of Object.entries(mask)) { name(joint, 'mask joint'); unitWeight(weight, `mask.${joint}`); }
}
function maskWeight(mask: AnimationMask | undefined, joint: string): number {
  return mask === undefined ? 1 : own(mask, joint) ? mask[joint] : 0;
}
function mixVector(a: AnimationVector, b: AnimationVector, t: number): AnimationVector {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
function blendPoses(from: AnimationPose, to: AnimationPose, weight: number, mask?: AnimationMask): AnimationPose {
  const result = dictionary<AnimationJointTransform>();
  const joints = new Set([...Object.keys(from), ...Object.keys(to)]);
  if (joints.size > MAX_JOINTS) fail(`blended pose exceeds ${MAX_JOINTS} joints`);
  for (const joint of joints) {
    const a = from[joint] ?? {}, b = to[joint] ?? {}, t = weight * maskWeight(mask, joint);
    const out: AnimationJointTransform = {};
    if (a.position || b.position) out.position = mixVector(a.position ?? ZERO, b.position ?? ZERO, t);
    if (a.rotation || b.rotation) out.rotation = slerpAnimationQuaternions(a.rotation ?? ANIMATION_IDENTITY_ROTATION, b.rotation ?? ANIMATION_IDENTITY_ROTATION, t);
    if (a.scale || b.scale) out.scale = mixVector(a.scale ?? ONE, b.scale ?? ONE, t);
    result[joint] = out;
  }
  return result;
}
/** Crossfade complete poses. Missing channels on either side mean rest identity. */
export function blendAnimationPoses(from: AnimationPose, to: AnimationPose, weight: number, mask?: AnimationMask): AnimationPose {
  unitWeight(weight); validateMask(mask);
  return blendPoses(validateAnimationPose(from), validateAnimationPose(to), weight, mask);
}
/** Layers run in explicit array order. A layer only touches its declared channels. */
export function composeAnimationLayers(base: AnimationPose, layers: readonly AnimationPoseLayer[]): AnimationPose {
  if (layers.length > MAX_LAYERS) fail(`at most ${MAX_LAYERS} pose layers`);
  const result = validateAnimationPose(base) as Record<string, AnimationJointTransform>;
  return composeOwnedLayers(result, layers);
}

/** Only used on a detached, already validated pose owned by this call. Preserve
 * the same numeric checks/normalization without allocating a second full pose. */
function normalizeOwnedPose(pose: Record<string, AnimationJointTransform>, passes = 1, checkVectors = true): AnimationPose {
  for (const joint of Object.keys(pose)) {
    const transform = pose[joint];
    if (checkVectors && transform.position) vectorInto(transform.position, `${joint}.position`, transform.position);
    // Inputs and quaternion operations have already validated these private
    // channels. Keep the normalization result (including its rounding), without
    // repeating shape/name/component checks on values that cannot have escaped.
    const rotation = transform.rotation;
    if (rotation) for (let pass = 0; pass < passes; pass++) {
      const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
      // Division by exactly one is a fixed point; all remaining passes return
      // identical component bits, including signed zero.
      if (length === 1) break;
      rotation.x /= length; rotation.y /= length; rotation.z /= length; rotation.w /= length;
    }
    if (checkVectors && transform.scale) vectorInto(transform.scale, `${joint}.scale`, transform.scale);
  }
  return pose;
}
function composeOwnedLayers(result: Record<string, AnimationJointTransform>, layers: readonly AnimationPoseLayer[]): AnimationPose {
  for (const layer of layers) {
    const weight = unitWeight(layer.weight ?? 1); validateMask(layer.mask);
    const mode = layer.mode ?? 'override';
    if (mode !== 'override' && mode !== 'additive') fail('unknown blend mode');
    const pose = validateAnimationPose(layer.pose);
    for (const [joint, delta] of Object.entries(pose)) {
      const t = weight * maskWeight(layer.mask, joint);
      if (t === 0) continue;
      const target = result[joint] ??= {};
      if (delta.position) {
        const a = target.position ?? ZERO;
        target.position = mode === 'override' ? mixVector(a, delta.position, t)
          : { x: a.x + delta.position.x * t, y: a.y + delta.position.y * t, z: a.z + delta.position.z * t };
      }
      if (delta.rotation) target.rotation = mode === 'override'
        ? slerpAnimationQuaternions(target.rotation ?? ANIMATION_IDENTITY_ROTATION, delta.rotation, t)
        : multiplyAnimationQuaternions(target.rotation ?? ANIMATION_IDENTITY_ROTATION, slerpAnimationQuaternions(ANIMATION_IDENTITY_ROTATION, delta.rotation, t));
      if (delta.scale) {
        const a = target.scale ?? ONE;
        const scale = mixVector(ONE, delta.scale, t);
        target.scale = mode === 'override' ? mixVector(a, delta.scale, t)
          : { x: a.x * scale.x, y: a.y * scale.y, z: a.z * scale.z };
      }
    }
    if (Object.keys(result).length > MAX_JOINTS) fail(`composed pose exceeds ${MAX_JOINTS} joints`);
  }
  return normalizeOwnedPose(result);
}

function freezePose(pose: AnimationPose): AnimationPose {
  for (const value of Object.values(pose)) {
    if (value.position) Object.freeze(value.position);
    if (value.rotation) Object.freeze(value.rotation);
    if (value.scale) Object.freeze(value.scale);
    Object.freeze(value);
  }
  return Object.freeze(pose);
}
function readonlySample(pose: AnimationPose): AnimationPose {
  if (!Object.isFrozen(pose)) freezePose(pose);
  readonlySamples.add(pose);
  return pose;
}
const definedClips = new WeakSet<AnimationClip>();
const decodedTimeClips = new WeakSet<AnimationClip>();
/** @internal Packed-data decoders register privately owned immutable samplers
 * that depend only on clip-local time. Arbitrary authored samplers are never
 * assumed pure, even if their surrounding function object is frozen. */
export function registerDecodedAnimationClip(clip: AnimationClip): AnimationClip {
  if (!definedClips.has(clip)) fail('decoded clip must be defined first');
  decodedTimeClips.add(clip);
  return clip;
}
// Cache exact clip-local times, never a quantized animation clock. The global
// bound includes every clip, and eviction releases both the pose and clip.
type SharedClipSample = { clip: AnimationClip; timeMs: number; pose: AnimationPose };
const clipSamples = new WeakMap<AnimationClip, Map<number, SharedClipSample>>();
const sampleOrder = new Set<SharedClipSample>();
const MAX_SHARED_CLIP_SAMPLES = 128;

function copySample(pose: AnimationPose): AnimationPose {
  const result = dictionary<AnimationJointTransform>();
  for (const joint of Object.keys(pose)) {
    const transform = pose[joint];
    const out: AnimationJointTransform = {};
    const position = transform.position, rotation = transform.rotation, scale = transform.scale;
    if (position) out.position = { x: position.x, y: position.y, z: position.z };
    if (rotation) out.rotation = { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w };
    if (scale) out.scale = { x: scale.x, y: scale.y, z: scale.z };
    result[joint] = out;
  }
  return result;
}
/** Data clips are copied/frozen. Procedural samplers must do bounded synchronous work. */
export function defineAnimationClip(definition: AnimationClip): AnimationClip {
  // A previously defined clip already owns deeply frozen keyframes. Keeping
  // its identity lets every actor/player share its exact sample calculations.
  if (definedClips.has(definition)) return definition;
  finite(definition.durationMs, 'clip duration', 600_000);
  if (definition.durationMs <= 0) fail('clip duration must be positive');
  if (definition.loop !== undefined && typeof definition.loop !== 'boolean') fail('loop must be boolean');
  let clip: AnimationClip;
  if (typeof definition.sample === 'function') {
    if (definition.keyframes !== undefined) fail('provide keyframes or a sampler, not both');
    clip = Object.freeze({ durationMs: definition.durationMs, loop: !!definition.loop, sample: definition.sample });
  } else {
    const frames = definition.keyframes;
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 128) fail('a data clip needs 1 to 128 keyframes');
    let previous = -1;
    const keyframes = frames.map(frame => {
      const time = finite(frame.atMs, 'keyframe time', definition.durationMs);
      if (time < 0 || time <= previous) fail('keyframe times must increase strictly within clip duration');
      previous = time;
      return Object.freeze({ atMs: time, pose: freezePose(validateAnimationPose(frame.pose)) });
    });
    if (keyframes[0].atMs !== 0 || (keyframes.length > 1 && keyframes.at(-1)!.atMs !== definition.durationMs)) fail('keyframes must span time 0 through the clip duration');
    clip = Object.freeze({ durationMs: definition.durationMs, loop: !!definition.loop, keyframes: Object.freeze(keyframes) });
  }
  definedClips.add(clip);
  return clip;
}
function clipContext(clip: AnimationClip, timeMs: number, options: AnimationSampleOptions): AnimationSampleContext {
  finite(timeMs, 'clip time');
  let local: number, cycle: number;
  if (options.phase !== undefined) {
    finite(options.phase, 'phase');
    cycle = Math.floor(options.phase);
    local = (clip.loop ? options.phase - cycle : Math.max(0, Math.min(1, options.phase))) * clip.durationMs;
  } else {
    cycle = clip.loop ? Math.floor(timeMs / clip.durationMs) : 0;
    local = clip.loop ? timeMs - cycle * clip.durationMs : Math.max(0, Math.min(clip.durationMs, timeMs));
  }
  const parameters = options.parameters ?? options.signals?.parameters ?? {};
  if (Object.keys(parameters).length > 64) fail('at most 64 animation parameters');
  for (const [key, value] of Object.entries(parameters)) {
    name(key, 'parameter');
    if (typeof value !== 'boolean') finite(value, `parameter.${key}`);
  }
  return { timeMs: local, phase: local / clip.durationMs, cycle, parameters, signals: options.signals };
}
/** A one-shot clamps to its endpoint. Loop endpoints wrap back to phase zero. */
export function sampleAnimationClip(definition: AnimationClip, timeMs: number, options: AnimationSampleOptions = {}): AnimationPose {
  const clip = definedClips.has(definition) ? definition : defineAnimationClip(definition);
  const context = clipContext(clip, timeMs, options);
  return sampleClipContext(clip, context);
}
/** @internal Read-only engine calculations can borrow a deeply frozen sample.
 * Existing public sampling remains detached/mutable. Procedural callbacks still
 * execute on every call; only keyframes and privately decoded clips are cached. */
export function sampleAnimationClipReadonly(definition: AnimationClip, timeMs: number, options: AnimationSampleOptions = {}): AnimationPose {
  const clip = definedClips.has(definition) ? definition : defineAnimationClip(definition);
  return sampleClipContext(clip, clipContext(clip, timeMs, options), true);
}
function sampleClipContext(clip: AnimationClip, context: AnimationSampleContext, readonly = false): AnimationPose {
  if (clip.sample && !decodedTimeClips.has(clip)) {
    const pose = validateAnimationPose(clip.sample(context));
    return readonly ? readonlySample(pose) : pose;
  }
  const frames = clip.keyframes;
  if (frames?.length === 1) return readonly ? readonlySample(frames[0].pose) : copySample(frames[0].pose);
  let samples = clipSamples.get(clip);
  const existing = samples?.get(context.timeMs);
  if (existing) return readonly ? readonlySample(existing.pose) : copySample(existing.pose);
  let pose: AnimationPose;
  if (clip.sample) pose = validateAnimationPose(clip.sample(context));
  else {
    let index = 1;
    while (index < frames!.length - 1 && frames![index].atMs < context.timeMs) index++;
    const from = frames![index - 1], to = frames![index];
    pose = blendPoses(from.pose, to.pose, (context.timeMs - from.atMs) / (to.atMs - from.atMs));
  }
  if (sampleOrder.size >= MAX_SHARED_CLIP_SAMPLES) {
    const oldest = sampleOrder.values().next().value!;
    sampleOrder.delete(oldest);
    clipSamples.get(oldest.clip)!.delete(oldest.timeMs);
  }
  if (!samples) clipSamples.set(clip, samples = new Map());
  const sample = { clip, timeMs: context.timeMs, pose };
  samples.set(context.timeMs, sample); sampleOrder.add(sample);
  // The cached pose never escapes to custom layers or a different actor.
  return readonly ? readonlySample(pose) : copySample(pose);
}

type ActiveAction = { action: Readonly<AnimationAction>; clip: AnimationClip; endsAtMs: number; key: string };
type SeenAction = { startedAtMs: number; endsAtMs: number; clip: string };
function actionKey(action: AnimationAction): string { return `${action.channel ?? 'action'}\0${action.id}`; }
function canInterrupt(current: AnimationAction, candidate: AnimationAction): boolean {
  const policy = current.interruption ?? 'equal-or-higher';
  const difference = (candidate.priority ?? 0) - (current.priority ?? 0);
  return policy !== 'never' && difference >= 0 && (policy !== 'higher' || difference > 0);
}
function actionDiagnostic(action: AnimationAction, clip: AnimationClip | undefined, timeMs: number,
  status: AnimationActionDiagnostic['status'], weight = 0): AnimationActionDiagnostic {
  const elapsedMs = timeMs - action.startedAtMs;
  return { id: action.id, clip: action.clip, channel: action.channel ?? 'action', elapsedMs,
    phase: clip ? Math.max(0, Math.min(1, elapsedMs / clip.durationMs)) : 0, status, weight };
}
function validatedAction(action: AnimationAction): AnimationAction {
  name(action.id, 'action ID'); name(action.clip, 'clip name'); name(action.channel ?? 'action', 'action channel');
  finite(action.startedAtMs, 'action start'); finite(action.priority ?? 0, 'action priority', 1e4);
  unitWeight(action.weight ?? 1); validateMask(action.mask);
  if (action.interruption !== undefined && !['higher', 'equal-or-higher', 'never'].includes(action.interruption)) fail('invalid interruption rule');
  if (action.mode !== undefined && !['override', 'additive'].includes(action.mode)) fail('invalid action blend mode');
  for (const duration of [action.fadeInMs ?? 0, action.fadeOutMs ?? 0]) {
    finite(duration, 'action fade', 600_000);
    if (duration < 0) fail('action fades must not be negative');
  }
  return Object.freeze({ ...action, mask: action.mask ? Object.freeze({ ...action.mask }) : undefined });
}
/**
 * One player per actor. Locomotion layers are supplied each frame; action channels
 * retain accepted instances until completion. Explicit starts handle late joins
 * and repeated messages without restarting attacks. Interrupted instances cannot
 * resume. A clock rewind/epoch change clears history; timestamps still determine
 * the sampled phase, so historical completed actions are never replayed at zero.
 */
export class AnimationPlayer {
  private readonly clips = new Map<string, AnimationClip>();
  private readonly active = new Map<string, ActiveAction>();
  // Retain recent completed IDs as well as active ones. Eviction only removes
  // completed entries; original timestamps still prevent replay after eviction.
  private readonly seen = new Map<string, SeenAction>();
  private lastTime: number | undefined;
  private epoch: string | number | undefined;

  constructor(clips: Readonly<Record<string, AnimationClip>>) {
    const entries = Object.entries(clips);
    if (entries.length > 128) fail('at most 128 clips per player');
    for (const [id, clip] of entries) this.clips.set(name(id, 'clip name'), defineAnimationClip(clip));
  }

  reset(): void { this.active.clear(); this.seen.clear(); this.lastTime = undefined; this.epoch = undefined; }

  sample(frame: AnimationFrame): AnimationResult {
    const now = finite(frame.timeMs, 'frame time');
    if ((frame.layers?.length ?? 0) > MAX_LAYERS || (frame.actions?.length ?? 0) > MAX_ACTIONS) fail('at most 32 layers and 32 action instances per frame');
    const reset = this.lastTime !== undefined && (now < this.lastTime || frame.epoch !== this.epoch);
    if (reset) this.reset();
    this.lastTime = now; this.epoch = frame.epoch;
    const diagnostics: AnimationDiagnostics = { reset, layers: [], actions: [], warnings: [] };
    const layers: AnimationPoseLayer[] = [];
    for (const [index, layer] of (frame.layers ?? []).entries()) {
      const clip = this.clips.get(layer.clip);
      if (!clip) { diagnostics.warnings.push(`Missing animation clip: ${layer.clip}`); continue; }
      const time = layer.timeMs ?? now;
      const phase = layer.phase ?? frame.phase;
      const context = clipContext(clip, time, { ...frame, phase });
      const weight = unitWeight(layer.weight ?? 1);
      layers.push({ pose: sampleClipContext(clip, context), weight, mask: layer.mask, mode: layer.mode });
      diagnostics.layers.push({ id: layer.id ?? `layer-${index}`, clip: layer.clip, timeMs: context.timeMs,
        phase: context.phase, weight, mode: layer.mode ?? 'override' });
    }
    for (const [channel, current] of this.active) {
      if (current.endsAtMs <= now) {
        this.active.delete(channel);
        diagnostics.actions.push(actionDiagnostic(current.action, current.clip, now, 'completed'));
      }
    }
    const candidates = (frame.actions ?? []).map(validatedAction).sort((a, b) => a.startedAtMs - b.startedAtMs
      || (a.priority ?? 0) - (b.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const action of candidates) {
      const clip = this.clips.get(action.clip);
      if (!clip) {
        diagnostics.actions.push(actionDiagnostic(action, undefined, now, 'missing'));
        diagnostics.warnings.push(`Missing action clip: ${action.clip}`); continue;
      }
      if (clip.loop) { diagnostics.warnings.push(`Action ${action.id} needs a one-shot clip, not looping ${action.clip}`); continue; }
      const endsAtMs = action.startedAtMs + clip.durationMs, key = actionKey(action), channel = action.channel ?? 'action';
      const previous = this.seen.get(key);
      if (previous && (previous.startedAtMs !== action.startedAtMs || previous.clip !== action.clip)) {
        diagnostics.warnings.push(`Action ${action.id} changed its start or clip; use a new instance ID`);
        diagnostics.actions.push(actionDiagnostic(action, clip, now, 'suppressed')); continue;
      }
      if (now < action.startedAtMs) { diagnostics.actions.push(actionDiagnostic(action, clip, now, 'future')); continue; }
      if (now >= endsAtMs) {
        // A late join may receive several historical instances together. A
        // completed interruption must still prevent its older action resuming.
        const current = this.active.get(channel);
        if (current && current.key !== key && action.startedAtMs >= current.action.startedAtMs
          && action.startedAtMs < current.endsAtMs && canInterrupt(current.action, action)) {
          this.active.delete(channel);
          diagnostics.actions.push(actionDiagnostic(current.action, current.clip, now, 'suppressed'));
        }
        diagnostics.actions.push(actionDiagnostic(action, clip, now, 'completed')); continue;
      }
      if (previous) {
        if (this.active.get(channel)?.key !== key) diagnostics.actions.push(actionDiagnostic(action, clip, now, 'suppressed'));
        continue;
      }
      if (this.seen.size >= MAX_HISTORY) {
        for (const [oldKey, old] of this.seen) {
          if (old.endsAtMs <= now) { this.seen.delete(oldKey); break; }
        }
      }
      if (this.seen.size >= MAX_HISTORY) {
        diagnostics.warnings.push('Action history budget reached; new instance skipped'); continue;
      }
      this.seen.set(key, { startedAtMs: action.startedAtMs, endsAtMs, clip: action.clip });
      const current = this.active.get(channel);
      if (current) {
        if (action.startedAtMs < current.action.startedAtMs || !canInterrupt(current.action, action)) {
          diagnostics.actions.push(actionDiagnostic(action, clip, now, 'suppressed')); continue;
        }
        diagnostics.actions.push(actionDiagnostic(current.action, current.clip, now, 'suppressed'));
      } else if (this.active.size >= MAX_CHANNELS) {
        diagnostics.warnings.push('Action channel budget reached; new instance skipped'); continue;
      }
      this.active.set(channel, { action, clip, endsAtMs, key });
    }
    const actions = [...this.active.values()].sort((a, b) => (a.action.priority ?? 0) - (b.action.priority ?? 0)
      || ((a.action.channel ?? 'action') < (b.action.channel ?? 'action') ? -1 : 1));
    for (const { action, clip, endsAtMs } of actions) {
      const elapsedMs = now - action.startedAtMs;
      const fadeIn = action.fadeInMs ? Math.min(1, elapsedMs / action.fadeInMs) : 1;
      const fadeOut = action.fadeOutMs ? Math.min(1, (endsAtMs - now) / action.fadeOutMs) : 1;
      const weight = (action.weight ?? 1) * Math.min(fadeIn, fadeOut);
      // Actions deliberately ignore a frame's gait phase override.
      const pose = sampleAnimationClip(clip, elapsedMs, { parameters: frame.parameters, signals: frame.signals });
      layers.push({ pose, weight, mask: action.mask, mode: action.mode });
      diagnostics.actions.push(actionDiagnostic(action, clip, now, 'active', weight));
    }
    // Composition itself has a 32-layer bound. Frame clips and action channels
    // have independent bounds, so apply these two bounded groups separately.
    const baseCount = diagnostics.layers.length;
    const baseLayers = layers.slice(0, baseCount), actionLayers = layers.slice(baseCount);
    const finish = (result: Record<string, AnimationJointTransform>) => {
      // This is the only owner of result. Match the old second pass's base and
      // final normalization without cloning it, including when actions are empty.
      if (!actionLayers.length) return normalizeOwnedPose(result, 2, false);
      normalizeOwnedPose(result, 1, false);
      return composeOwnedLayers(result, actionLayers);
    };
    const basePose = composeAnimationLayers(frame.base ?? {}, baseLayers) as Record<string, AnimationJointTransform>;
    const referencePose = frame.referenceBase === undefined ? undefined
      : finish(composeAnimationLayers(frame.referenceBase, baseLayers) as Record<string, AnimationJointTransform>);
    const pose = finish(basePose);
    return { pose, diagnostics,
      ...(referencePose ? { referencePose } : {}) };
  }
}
