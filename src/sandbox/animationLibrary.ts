import { defineAnimationClip, type AnimationClip, type AnimationJointTransform, type AnimationPose, type AnimationVector } from './animation.ts';
import { HUMANOID_JOINTS, HUMANOID_RIG_ID } from './humanoidRig.ts';
import { registerDecodedMotionSource, type MotionSource, type MotionTrajectory } from './motionMatching.ts';
import { DEFAULT_LOCOMOTION_DATA } from './defaultLocomotionData.ts';

/** A portable, engine-independent data format. Every frame stores
 * the first joint's XYZ translation, each joint's XYZW rotation, root XYZ/yaw,
 * and left/right foot contacts, in that order. All are quantized integers.
 * Samples span 0..durationMs uniformly, including the final endpoint. */
export interface PackedLocomotionLibrary {
  version: 'packed-locomotion-v1';
  rig: string;
  joints: readonly string[];
  unitScale: number;
  rotationScale: number;
  positionScale: number;
  yawScale: number;
  contactScale: number;
  frameStride: number;
  source: { name: string; engineVersion: string; skeleton: string };
  clips: readonly {
    id: string;
    sourceName: string;
    sourceSha256: string;
    durationMs: number;
    loop: boolean;
    frameCount: number;
    speedMps: number;
    tags: readonly string[];
    samples: readonly number[];
  }[];
}
export interface SharedLocomotionClip extends MotionSource {
  readonly clip: AnimationClip;
  readonly rig: string;
  readonly tags: readonly string[];
  readonly provenance: Readonly<{ library: string; sourceName: string; sourceSha256: string; skeleton: string }>;
  readonly averageSpeed: number;
  contacts(timeMs: number): Readonly<Record<string, number>>;
  speed(timeMs: number): number;
}

export const HUMANOID_LOCOMOTION_RIG = HUMANOID_RIG_ID;
export const HUMANOID_LOCOMOTION_REFERENCE = HUMANOID_JOINTS;
export const HUMANOID_LOCOMOTION_JOINTS = Object.freeze(HUMANOID_JOINTS.map(joint => joint.name));
const finite = (value: number, min: number, max: number, name: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Animation library: invalid ${name}.`);
  return value;
};
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,95}$/;
function name(value: string): string {
  if (typeof value !== 'string' || !namePattern.test(value)) throw new Error('Animation library: invalid name.');
  return value;
}
interface RootFrame { position: AnimationVector; yaw: number }
const rotate = (value: AnimationVector, yaw: number): AnimationVector => {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return { x: cos * value.x + sin * value.z, y: value.y, z: -sin * value.x + cos * value.z };
};
const add = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const compose = (a: RootFrame, b: RootFrame): RootFrame => ({ position: add(a.position, rotate(b.position, a.yaw)), yaw: a.yaw + b.yaw });
const zeroRoot = (): RootFrame => ({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });

/** Decode once per library. Poses contain no root travel: trajectory() exposes
 * it only to motion matching, while gameplay continues owning actor movement.
 * Validation/copying prevents later edits to input data changing a live index. */
export function decodeLocomotionLibrary(data: PackedLocomotionLibrary): readonly SharedLocomotionClip[] {
  if (!data || data.version !== 'packed-locomotion-v1') throw new Error('Animation library: unsupported format.');
  const rig = name(data.rig), joints = [...data.joints];
  if (!joints.length || joints.length > 128 || new Set(joints.map(name)).size !== joints.length) throw new Error('Animation library: expected 1..128 unique joints.');
  const stride = 3 + joints.length * 4 + 4 + 2;
  if (data.frameStride !== stride) throw new Error('Animation library: invalid frame stride.');
  finite(data.unitScale, .000001, 1000, 'source unit scale');
  const positionScale = finite(data.positionScale, 1, 1e9, 'position scale');
  const rotationScale = finite(data.rotationScale, 1, 1e9, 'rotation scale');
  const yawScale = finite(data.yawScale, 1, 1e9, 'yaw scale');
  const contactScale = finite(data.contactScale, 1, 1e9, 'contact scale');
  if (!data.source || [data.source.name, data.source.skeleton, data.source.engineVersion].some(value => typeof value !== 'string' || !value.length || value.length > 1024))
    throw new Error('Animation library: source provenance is required.');
  if (!Array.isArray(data.clips) || !data.clips.length || data.clips.length > 128) throw new Error('Animation library: expected 1..128 clips.');
  const clips: PackedLocomotionLibrary['clips'] = data.clips;
  const ids = new Set<string>(); let totalFrames = 0;
  return Object.freeze(clips.map(packed => {
    const id = name(packed.id);
    if (ids.has(id)) throw new Error('Animation library: duplicate clip ID.'); ids.add(id);
    if (typeof packed.sourceName !== 'string' || !packed.sourceName.length || packed.sourceName.length > 256 || !/^[a-f0-9]{64}$/i.test(packed.sourceSha256))
      throw new Error('Animation library: clip needs source name and SHA-256.');
    const durationMs = finite(packed.durationMs, 1, 600_000, 'clip duration');
    const count = finite(packed.frameCount, 2, 128, 'frame count');
    totalFrames += count;
    if (!Number.isInteger(count) || totalFrames > 8192 || typeof packed.loop !== 'boolean') throw new Error('Animation library: invalid clip frames/loop.');
    finite(packed.speedMps, 0, 1000, 'average speed');
    if (!Array.isArray(packed.tags) || packed.tags.length > 32) throw new Error('Animation library: invalid tags.');
    const tags = Object.freeze([...new Set<string>(packed.tags.map((value: string) => name(value)))]);
    if (!Array.isArray(packed.samples) || packed.samples.length !== count * stride || packed.samples.some(value => !Number.isSafeInteger(value) || Math.abs(value) > 1e12))
      throw new Error('Animation library: invalid packed samples.');
    const roots: RootFrame[] = [], contactFrames: number[][] = [];
    const keyframes = Array.from({ length: count }, (_, frame) => {
      let cursor = frame * stride;
      const pose: Record<string, AnimationJointTransform> = {};
      const translation = { x: packed.samples[cursor++] / positionScale, y: packed.samples[cursor++] / positionScale, z: packed.samples[cursor++] / positionScale };
      for (const joint of joints) {
        const rotation = { x: packed.samples[cursor++] / rotationScale, y: packed.samples[cursor++] / rotationScale,
          z: packed.samples[cursor++] / rotationScale, w: packed.samples[cursor++] / rotationScale };
        pose[joint] = { rotation, ...(joint === joints[0] ? { position: translation } : {}) };
      }
      roots.push({ position: { x: packed.samples[cursor++] / positionScale, y: packed.samples[cursor++] / positionScale, z: packed.samples[cursor++] / positionScale }, yaw: packed.samples[cursor++] / yawScale });
      contactFrames.push([finite(packed.samples[cursor++] / contactScale, 0, 1, 'left contact'), finite(packed.samples[cursor++] / contactScale, 0, 1, 'right contact')]);
      return { atMs: frame === count - 1 ? durationMs : frame * durationMs / (count - 1), pose: pose as AnimationPose };
    });
    // Normalize initial root orientation/position, so loop powers represent a
    // transform from the first frame, even for sources beginning turned away.
    const initial = roots[0];
    const relativeRoots = roots.map(root => ({ position: rotate(subtract(root.position, initial.position), -initial.yaw), yaw: root.yaw - initial.yaw }));
    const loop = packed.loop, clip = defineAnimationClip({ durationMs, loop, keyframes });
    const localIndices = (timeMs: number) => {
      const time = loop ? ((timeMs % durationMs) + durationMs) % durationMs : Math.max(0, Math.min(durationMs, timeMs));
      const fractional = time / durationMs * (count - 1), a = Math.min(count - 2, Math.floor(fractional));
      return { a, b: a + 1, t: fractional - a };
    };
    const rootAt = (timeMs: number): RootFrame => {
      const { a, b, t } = localIndices(timeMs), from = relativeRoots[a], to = relativeRoots[b];
      const local = { position: { x: lerp(from.position.x, to.position.x, t), y: lerp(from.position.y, to.position.y, t), z: lerp(from.position.z, to.position.z, t) }, yaw: lerp(from.yaw, to.yaw, t) };
      let cycles = loop ? Math.floor(timeMs / durationMs) : 0;
      if (!cycles) return local;
      let step = relativeRoots.at(-1)!, accumulated = zeroRoot();
      if (cycles < 0) { step = { position: rotate({ x: -step.position.x, y: -step.position.y, z: -step.position.z }, -step.yaw), yaw: -step.yaw }; cycles = -cycles; }
      while (cycles > 0) {
        if (cycles % 2) accumulated = compose(accumulated, step);
        cycles = Math.floor(cycles / 2);
        if (cycles) step = compose(step, step);
      }
      return compose(accumulated, local);
    };
    const trajectory = (timeMs: number, afterMs: number): MotionTrajectory => {
      finite(timeMs, -1e12, 1e12, 'trajectory time'); finite(afterMs, 0, 60_000, 'trajectory horizon');
      const current = rootAt(timeMs), future = rootAt(timeMs + afterMs);
      return { position: rotate(subtract(future.position, current.position), -current.yaw), direction: rotate({ x: 0, y: 0, z: 1 }, future.yaw - current.yaw) };
    };
    return registerDecodedMotionSource(Object.freeze({ id, clip, rig, tags, trajectory,
      provenance: Object.freeze({ library: data.source.name, sourceName: packed.sourceName, sourceSha256: packed.sourceSha256, skeleton: data.source.skeleton }),
      averageSpeed: packed.speedMps,
      contacts(timeMs: number) {
        finite(timeMs, -1e12, 1e12, 'contact time');
        const { a, b, t } = localIndices(timeMs);
        return { 'left-foot': lerp(contactFrames[a][0], contactFrames[b][0], t), 'right-foot': lerp(contactFrames[a][1], contactFrames[b][1], t) };
      },
      speed(timeMs: number) {
        finite(timeMs, -1e12, 1e12, 'speed time');
        if (!loop && (timeMs < 0 || timeMs >= durationMs)) return 0;
        const { a, b } = localIndices(timeMs), delta = subtract(relativeRoots[b].position, relativeRoots[a].position);
        return Math.hypot(delta.x, delta.z) * (count - 1) * 1000 / durationMs;
      },
    }));
  }));
}

let shared: readonly SharedLocomotionClip[] | undefined;
/** Install a validated bank whose redistribution rights belong to the caller. */
export function configureSharedHumanoidLocomotion(data: PackedLocomotionLibrary): void {
  shared = decodeLocomotionLibrary(data);
}
/** Original procedural starter motions, decoded lazily and shared by all games.
 * Build a MotionDatabase once, then one MotionMatcher per visible actor. */
export function sharedHumanoidLocomotion(): readonly SharedLocomotionClip[] {
  return shared ??= decodeLocomotionLibrary(DEFAULT_LOCOMOTION_DATA);
}
