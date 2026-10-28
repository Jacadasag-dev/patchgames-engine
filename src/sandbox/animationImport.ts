import {
  defineAnimationClip, multiplyAnimationQuaternions, normalizeAnimationQuaternion,
  slerpAnimationQuaternions, validateAnimationPose,
  type AnimationClip, type AnimationJointTransform, type AnimationQuaternion, type AnimationVector,
} from './animation.ts';

export const ANIMATION_IMPORT_VERSION = 'animation-import-v1';
export interface ImportedTransform { position: AnimationVector; rotation: AnimationQuaternion; scale: AnimationVector }
export interface AnimationImportBinding {
  /** Source node's unique name or canonical hierarchy path, resolved by the importer. */
  source: string;
  /** Source parent translation axes -> clip translation axes. */
  translationBasis?: AnimationQuaternion;
  /** Source rest-local rotation axes -> clip rotation axes. These may differ from translation axes. */
  rotationBasis?: AnimationQuaternion;
  /** Explicit reference pose, in source units. Defaults to the source scene's rest transform. */
  reference?: ImportedTransform;
}
export interface AnimationImportMapping {
  /** Source distance multiplied by this value gives game-world distance, e.g. centimeters: 0.01. */
  unitScale: number;
  joints: Readonly<Record<string, AnimationImportBinding>>;
  /** Extract this node's translation/rotation to metadata and omit it from the pose. */
  rootMotion?: { source: string; basis?: AnimationQuaternion };
}
export interface AnimationImportInput extends AnimationImportMapping {
  rest: Readonly<Record<string, ImportedTransform>>;
  frames: readonly { timeSeconds: number; transforms: Readonly<Record<string, ImportedTransform>> }[];
  loop?: boolean;
}
export interface ImportedRootMotion {
  source: string;
  space: 'root-parent';
  authoritative: false;
  durationMs: number;
  /** Converted axes; positions are relative to the first frame. Rotations retain its initial orientation. */
  samples: { atMs: number; position: AnimationVector; rotation: AnimationQuaternion }[];
  displacement: AnimationVector;
  /** Path distance / duration, not merely net displacement / duration. */
  averageSpeed: number;
}
export interface ImportedAnimation {
  version: typeof ANIMATION_IMPORT_VERSION;
  clip: AnimationClip;
  unitScale: number;
  referencePose: Record<string, Required<AnimationImportBinding>>;
  rootMotion?: ImportedRootMotion;
  diagnostics: { warnings: string[]; mappedJoints: number; sampledFrames: number };
}

const IDENTITY: AnimationQuaternion = { x: 0, y: 0, z: 0, w: 1 };
const ZERO: AnimationVector = { x: 0, y: 0, z: 0 };
function fail(message: string): never { throw new Error(`Animation import: ${message}`); }
function finite(value: unknown, label: string, min = -1e6, max = 1e6): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be finite in [${min}, ${max}]`);
  return value;
}
function sourceName(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 1024 || value.includes('\0')) fail('source names/paths must contain 1..1024 non-NUL characters');
  return value;
}
function vector(value: AnimationVector, label: string): AnimationVector {
  if (!value || typeof value !== 'object') fail(`${label} needs x/y/z`);
  return { x: finite(value.x, `${label}.x`), y: finite(value.y, `${label}.y`), z: finite(value.z, `${label}.z`) };
}
function transform(value: ImportedTransform, label: string): ImportedTransform {
  if (!value || typeof value !== 'object') fail(`missing ${label}`);
  const scale = vector(value.scale, `${label}.scale`);
  if (Math.min(scale.x, scale.y, scale.z) <= 1e-8) fail(`${label} needs positive nonzero scale; reflected/sheared rigs must be baked before import`);
  return { position: vector(value.position, `${label}.position`), rotation: normalizeAnimationQuaternion(value.rotation), scale };
}
const add = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const multiply = (v: AnimationVector, scale: number): AnimationVector => ({ x: v.x * scale, y: v.y * scale, z: v.z * scale });
const inverse = (q: AnimationQuaternion): AnimationQuaternion => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const conjugate = (q: AnimationQuaternion, basis: AnimationQuaternion): AnimationQuaternion => multiplyAnimationQuaternions(multiplyAnimationQuaternions(basis, q), inverse(basis));
function rotate(v: AnimationVector, q: AnimationQuaternion): AnimationVector {
  // q*v*q^-1 without normalizing the vector quaternion.
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + q.y * tz - q.z * ty, y: v.y + q.w * ty + q.z * tx - q.x * tz, z: v.z + q.w * tz + q.x * ty - q.y * tx };
}

/** Convert already sampled local transforms. No loaders, files, network or renderer in this helper. */
export function compileAnimationImport(input: AnimationImportInput): ImportedAnimation {
  const unitScale = finite(input.unitScale, 'unitScale', 1e-6, 1000);
  const entries = Object.entries(input.joints ?? {});
  if (!entries.length || entries.length > 128) fail('map 1..128 semantic joints');
  validateAnimationPose(Object.fromEntries(entries.map(([name]) => [name, {}])));
  if (!Array.isArray(input.frames) || input.frames.length < 2 || input.frames.length > 128) fail('provide 2..128 samples; trim the source clip or lower the sample rate');
  const referencePose: ImportedAnimation['referencePose'] = Object.create(null);
  const sources = new Set<string>();
  const rootSource = input.rootMotion ? sourceName(input.rootMotion.source) : undefined;
  const rootBasis = normalizeAnimationQuaternion(input.rootMotion?.basis ?? IDENTITY);
  for (const [name, binding] of entries) {
    const source = sourceName(binding?.source);
    if (sources.has(source)) fail(`source ${source} is mapped more than once`);
    if (source === rootSource) fail(`root-motion node ${source} must be separate from mapped pose joints; map its children or omit root extraction`);
    sources.add(source);
    referencePose[name] = {
      source, reference: transform(binding.reference ?? input.rest[source], `reference for ${name}`),
      translationBasis: normalizeAnimationQuaternion(binding.translationBasis ?? IDENTITY),
      rotationBasis: normalizeAnimationQuaternion(binding.rotationBasis ?? IDENTITY),
    };
  }
  const firstTime = finite(input.frames[0].timeSeconds, 'first sample time', 0, 600);
  const durationMs = (finite(input.frames.at(-1)!.timeSeconds, 'last sample time', 0, 600) - firstTime) * 1000;
  if (durationMs <= 0) fail('sample duration must be positive');
  let previousTime = -1;
  const rootSamples: ImportedRootMotion['samples'] = [];
  const firstRoot = rootSource ? transform(input.frames[0].transforms[rootSource], 'first root sample') : undefined;
  const keyframes = input.frames.map((frame, index) => {
    const atMs = (finite(frame.timeSeconds, `sample ${index} time`, 0, 600) - firstTime) * 1000;
    if (atMs <= previousTime) fail('sample times must increase strictly');
    previousTime = atMs;
    const pose: Record<string, AnimationJointTransform> = Object.create(null);
    for (const [name, binding] of Object.entries(referencePose)) {
      const current = transform(frame.transforms[binding.source], `sample ${index} ${binding.source}`), rest = binding.reference;
      const scale = { x: current.scale.x / rest.scale.x, y: current.scale.y / rest.scale.y, z: current.scale.z / rest.scale.z };
      if (Math.max(Math.abs(scale.x - scale.y), Math.abs(scale.x - scale.z)) > 1e-6
        && Math.hypot(binding.rotationBasis.x, binding.rotationBasis.y, binding.rotationBasis.z) > 1e-6)
        fail(`${name} has nonuniform animated scale with a rotated basis; bake scale before retargeting to avoid shear`);
      pose[name] = {
        position: rotate(multiply(subtract(current.position, rest.position), unitScale), binding.translationBasis),
        rotation: conjugate(multiplyAnimationQuaternions(inverse(rest.rotation), current.rotation), binding.rotationBasis),
        scale,
      };
    }
    if (rootSource && firstRoot) {
      const current = transform(frame.transforms[rootSource], `sample ${index} root`);
      if (Math.max(Math.abs(current.scale.x - firstRoot.scale.x), Math.abs(current.scale.y - firstRoot.scale.y), Math.abs(current.scale.z - firstRoot.scale.z)) > 1e-6)
        fail('animated root scale cannot be represented by a rigid root trajectory; bake it before import');
      rootSamples.push({ atMs, position: rotate(multiply(subtract(current.position, firstRoot.position), unitScale), rootBasis), rotation: conjugate(current.rotation, rootBasis) });
    }
    return { atMs, pose };
  });
  const clip = defineAnimationClip({ durationMs, loop: !!input.loop, keyframes });
  const warnings = ['Uniformly sampled keyframes approximate source interpolation; inspect the imported motion.', 'Reference poses and basis mappings are explicit; this is not automatic anatomical retargeting.'];
  let rootMotion: ImportedRootMotion | undefined;
  if (rootSource) {
    let distance = 0;
    for (let i = 1; i < rootSamples.length; i++) {
      const d = subtract(rootSamples[i].position, rootSamples[i - 1].position); distance += Math.hypot(d.x, d.y, d.z);
    }
    rootMotion = { source: rootSource, space: 'root-parent', authoritative: false, durationMs, samples: rootSamples,
      displacement: { ...rootSamples.at(-1)!.position }, averageSpeed: distance / (durationMs / 1000) };
    warnings.push('Root translation and rotation are metadata only; gameplay movement is unchanged.');
  } else warnings.push('No root trajectory extracted; supply explicit reference travel before trajectory matching an in-place clip.');
  return validateImportedAnimation({ version: ANIMATION_IMPORT_VERSION, clip, unitScale, referencePose, ...(rootMotion ? { rootMotion } : {}), diagnostics: { warnings, mappedJoints: entries.length, sampledFrames: keyframes.length } });
}

function validateRootMotion(value: ImportedRootMotion, expectedDuration?: number): ImportedRootMotion {
  if (!value || value.space !== 'root-parent' || value.authoritative !== false) fail('root metadata must declare root-parent space and authoritative:false');
  const durationMs = finite(value.durationMs, 'root duration', 0.001, 600_000);
  if (expectedDuration !== undefined && durationMs !== expectedDuration) fail('root and pose durations differ');
  if (!Array.isArray(value.samples) || value.samples.length < 2 || value.samples.length > 128) fail('root trajectory needs 2..128 samples');
  let previousTime = -1;
  const samples = value.samples.map(sample => {
    const atMs = finite(sample.atMs, 'root sample time', 0, durationMs);
    if (atMs <= previousTime) fail('root sample times must increase strictly');
    previousTime = atMs;
    return { atMs, position: vector(sample.position, 'root position'), rotation: normalizeAnimationQuaternion(sample.rotation) };
  });
  if (samples[0].atMs !== 0 || samples.at(-1)!.atMs !== durationMs || Math.hypot(samples[0].position.x, samples[0].position.y, samples[0].position.z) > 1e-6) fail('root samples must start at origin/time zero and span their duration');
  const displacement = vector(value.displacement, 'root displacement');
  const mismatch = subtract(displacement, samples.at(-1)!.position);
  if (Math.hypot(mismatch.x, mismatch.y, mismatch.z) > 1e-6) fail('root displacement must match its last sample');
  return { source: sourceName(value.source), space: 'root-parent', authoritative: false, durationMs, samples, displacement,
    averageSpeed: finite(value.averageSpeed, 'root average speed', 0, 1e6) };
}

/** Revalidate JSON-loaded artifacts before registering their clip or trajectory. */
export function validateImportedAnimation(value: unknown): ImportedAnimation {
  if (!value || typeof value !== 'object') fail('expected an imported animation object');
  const data = value as ImportedAnimation;
  if (data.version !== ANIMATION_IMPORT_VERSION) fail('unsupported imported animation version');
  if (!data.clip || !Array.isArray(data.clip.keyframes) || data.clip.sample) fail('imported clips must contain plain keyframes');
  const clip = defineAnimationClip(data.clip), unitScale = finite(data.unitScale, 'unitScale', 1e-6, 1000);
  const entries = Object.entries(data.referencePose ?? {});
  if (!entries.length || entries.length > 128) fail('referencePose needs 1..128 joints');
  validateAnimationPose(Object.fromEntries(entries.map(([name]) => [name, {}])));
  const referencePose: ImportedAnimation['referencePose'] = Object.create(null), sources = new Set<string>();
  for (const [name, binding] of entries) {
    const source = sourceName(binding.source);
    if (sources.has(source)) fail('duplicate source in referencePose'); sources.add(source);
    referencePose[name] = { source, reference: transform(binding.reference, `reference ${name}`),
      translationBasis: normalizeAnimationQuaternion(binding.translationBasis), rotationBasis: normalizeAnimationQuaternion(binding.rotationBasis) };
  }
  for (const frame of clip.keyframes!) for (const name of Object.keys(frame.pose)) if (!Object.hasOwn(referencePose, name)) fail(`keyframe joint ${name} has no reference mapping`);
  const warnings = data.diagnostics?.warnings;
  if (!Array.isArray(warnings) || warnings.length > 64 || warnings.some(warning => typeof warning !== 'string' || warning.length > 2048)) fail('invalid import diagnostics');
  const rootMotion = data.rootMotion ? validateRootMotion(data.rootMotion, clip.durationMs) : undefined;
  if (rootMotion && sources.has(rootMotion.source)) fail('extracted root motion must not also animate a pose joint');
  return { version: ANIMATION_IMPORT_VERSION, clip, unitScale, referencePose, ...(rootMotion ? { rootMotion } : {}),
    diagnostics: { warnings: [...warnings], mappedJoints: entries.length, sampledFrames: clip.keyframes!.length } };
}

interface RootTransform { position: AnimationVector; rotation: AnimationQuaternion }
function composeRoot(a: RootTransform, b: RootTransform): RootTransform {
  return { position: add(a.position, rotate(b.position, a.rotation)), rotation: multiplyAnimationQuaternions(a.rotation, b.rotation) };
}
function rootAt(root: ImportedRootMotion, timeMs: number, loop: boolean): RootTransform {
  const cycles = loop ? Math.floor(timeMs / root.durationMs) : 0;
  const localTime = loop ? timeMs % root.durationMs : Math.min(timeMs, root.durationMs);
  let index = 1;
  while (index < root.samples.length - 1 && root.samples[index].atMs < localTime) index++;
  const a = root.samples[index - 1], b = root.samples[index], t = (localTime - a.atMs) / (b.atMs - a.atMs);
  const local = { position: add(a.position, multiply(subtract(b.position, a.position), t)), rotation: slerpAnimationQuaternions(a.rotation, b.rotation, t) };
  if (!cycles) return local;
  // Exponentiation by squaring bounds work even after long-running playback.
  let remaining = cycles, accumulated: RootTransform = { position: ZERO, rotation: IDENTITY };
  let step: RootTransform = { position: root.displacement, rotation: multiplyAnimationQuaternions(root.samples.at(-1)!.rotation, inverse(root.samples[0].rotation)) };
  while (remaining > 0) {
    if (remaining % 2 === 1) accumulated = composeRoot(accumulated, step);
    remaining = Math.floor(remaining / 2);
    if (remaining) step = composeRoot(step, step);
  }
  return composeRoot(accumulated, local);
}

/** MotionSource.trajectory adapter: future displacement and facing in the current root-local frame. */
export function importedRootTrajectory(rootMotion: ImportedRootMotion, timeMs: number, afterMs: number, loop = false): { position: AnimationVector; direction: AnimationVector } {
  const root = validateRootMotion(rootMotion);
  finite(timeMs, 'trajectory time', 0, 1e12); finite(afterMs, 'trajectory horizon', 0, 60_000);
  const current = rootAt(root, timeMs, loop), future = rootAt(root, timeMs + afterMs, loop), inverseCurrent = inverse(current.rotation);
  return { position: rotate(subtract(future.position, current.position), inverseCurrent),
    direction: rotate({ x: 0, y: 0, z: 1 }, multiplyAnimationQuaternions(inverseCurrent, future.rotation)) };
}
