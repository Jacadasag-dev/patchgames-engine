/**
 * Indexed, presentation-only motion matching. Features use root-local reference
 * coordinates and explicit milliseconds. No search result moves game physics.
 * A database samples actual clips; samplers and descriptors must stay stable
 * after construction. Motion matching can select only motions in its library.
 */
import {
  ANIMATION_IDENTITY_ROTATION, blendAnimationPoses, defineAnimationClip, multiplyAnimationQuaternions,
  normalizeAnimationQuaternion, sampleAnimationClip, sampleAnimationClipReadonly, validateAnimationPose, validateAnimationPoseReadonly,
  type AnimationClip, type AnimationJointTransform, type AnimationParameters, type AnimationPose,
  type AnimationQuaternion, type AnimationVector,
} from './animation.ts';

export const MOTION_MATCHING_VERSION = 'motion-matching-v1';
/** Symmetric pose derivative used by indexed sources and continuation queries. */
export const MOTION_POSE_DERIVATIVE_MS = 10;
export interface MotionTrajectory { position: AnimationVector; direction: AnimationVector }
export interface MotionTrajectorySample extends MotionTrajectory { afterMs: number }
export interface MotionJointFeature { joint: string; positionWeight?: number; rotationWeight?: number; velocityWeight?: number; angularVelocityWeight?: number }
export interface MotionSchema {
  /** Strictly increasing offsets in [0, 3000] ms; 1..8 samples. */
  trajectoryTimesMs: readonly number[];
  joints: readonly MotionJointFeature[];
  trajectoryPositionWeight?: number;
  trajectoryDirectionWeight?: number;
  trajectorySampleWeights?: readonly number[];
  contacts?: readonly { name: string; weight?: number }[];
  /** Minimum per-dimension standard deviation, preventing amplification of noise. */
  normalizationFloor?: number;
}
export interface MotionSource {
  id: string;
  clip: AnimationClip;
  rig?: string;
  tags?: readonly string[];
  /** Future displacement and facing relative to the root at timeMs. */
  trajectory(timeMs: number, afterMs: number): MotionTrajectory;
  /** Optional declared contact confidence in [0, 1]; no humanoid names are required. */
  contacts?(timeMs: number, pose: AnimationPose): Readonly<Record<string, number>>;
  parameters?: AnimationParameters;
  /** Nonlooping motion normally selects a continuation. Holding its final pose is opt-in. */
  endBehavior?: 'select' | 'hold';
}
export interface MotionDatabaseDefinition {
  schema: MotionSchema;
  sources: readonly MotionSource[];
  sampleIntervalMs?: number;
  /** Hard construction budget, 1..4096 indexed frames. Never silently truncates. */
  maxFrames?: number;
}

const decodedSources = new WeakSet<MotionSource>();
/** @internal Packed-data decoders register sources whose samplers close only
 * over their own immutable decoded data. Their exact features are shared
 * automatically by every database; arbitrary authored closures still run. */
export function registerDecodedMotionSource<T extends MotionSource>(source: T): T {
  if (!Object.isFrozen(source)) fail('decoded source must be frozen');
  decodedSources.add(source);
  return source;
}
export interface MotionQuery {
  trajectory: readonly MotionTrajectorySample[];
  /** Reference-rig local deltas at the presentation time being matched. */
  pose: AnimationPose;
  previousPose?: AnimationPose;
  /** Optional derivative endpoint after pose. With previousPose, permits a
   * centered derivative; poseDeltaMs spans these two endpoints. */
  nextPose?: AnimationPose;
  poseDeltaMs?: number;
  contacts?: Readonly<Record<string, number>>;
  rig?: string;
  requiredTags?: readonly string[];
  excludedTags?: readonly string[];
}
export interface MotionFrame { index: number; sourceId: string; timeMs: number; rig?: string; tags: readonly string[] }
export interface MotionSearchResult {
  frame: MotionFrame | null;
  score: number | null;
  method: 'indexed' | 'brute-force';
  visited: number;
  evaluated: number;
  candidateCount: number;
  warnings: string[];
}
export interface MotionSearchOptions {
  method?: 'indexed' | 'brute-force';
  excludedSources?: readonly string[];
  /** Optional per-source upper bounds for entering a segment, not playback limits. */
  startTimeLimits?: Readonly<Record<string, number>>;
  /** Require playable source time after entering a nonlooping select-end motion.
   * Capped at half each clip's duration so short motions remain usable. Loops
   * and deliberate hold-end motions are unrestricted. Default 0 preserves raw
   * frame search; this never truncates playback or removes indexed frames. */
  minimumRemainingMs?: number;
}
export interface MotionFeatureStatistic { name: string; mean: number; deviation: number; weight: number }
export interface MotionMatcherOptions {
  blendMs?: number;
  transition?: 'inertial' | 'crossfade';
  searchIntervalMs?: number;
  switchCooldownMs?: number;
  /** The best candidate must beat continuous playback by this normalized cost. */
  continuityBias?: number;
  /** Ignore tiny same-clip jumps around the current playback segment. */
  continuationWindowMs?: number;
  /** Sparse loop libraries can prefer natural cyclic continuation over seeking
   * the same loop's best phase repeatedly. Other sources remain searchable. */
  preserveLoopPhase?: boolean;
  /** Reinitialize on a discontinuous/late frame; do not replay missed frames. */
  maxFrameGapMs?: number;
  coverageThreshold?: number;
}
export interface MotionMatcherInput { timeMs: number; epoch?: string | number; query: MotionQuery; playbackRate?: number; reset?: boolean }
export interface MotionMatcherDiagnostics {
  selectedClip: string | null;
  selectedTimeMs: number | null;
  selectedPhase: number | null;
  selectedDurationMs?: number;
  selectedLoop?: boolean;
  selectedHoldsEnd?: boolean;
  /** The rate applied to this frame's playback, including an explicit pause. */
  playbackRate: number;
  score: number | null;
  coverageScore: number | null;
  candidate: MotionFrame | null;
  candidateScore: number | null;
  candidateCount: number;
  frameCount: number;
  visited: number;
  searched: boolean;
  switched: boolean;
  reset: boolean;
  transitionWeight: number;
  transition: 'inertial' | 'crossfade';
  warnings: string[];
}
export interface MotionMatcherResult { pose: AnimationPose; diagnostics: MotionMatcherDiagnostics }

const ZERO: AnimationVector = { x: 0, y: 0, z: 0 };
const ONE: AnimationVector = { x: 1, y: 1, z: 1 };
const MAX_DIMENSIONS = 256;
const MAX_FRAMES = 4096;
const MAX_SAMPLE_CACHE = 128;
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
function fail(message: string): never { throw new Error(`Motion matching: ${message}`); }
function finite(value: number, name: string, min = -1e12, max = 1e12): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} must be finite in [${min}, ${max}]`);
  return value;
}
function label(value: string, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,95}$/.test(value)) fail(`${name} must be a name of 1..96 characters`);
  return value;
}
function labels(values: readonly string[] | undefined, name: string): readonly string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 32) fail(`${name} supports at most 32 tags`);
  return Object.freeze([...new Set(values.map(value => label(value, name)))].sort());
}
function vec(value: AnimationVector, name: string): AnimationVector {
  if (!value || typeof value !== 'object') fail(`${name} needs x, y, z`);
  return { x: finite(value.x, `${name}.x`, -1e6, 1e6), y: finite(value.y, `${name}.y`, -1e6, 1e6), z: finite(value.z, `${name}.z`, -1e6, 1e6) };
}
const add = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: AnimationVector, b: AnimationVector): AnimationVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (v: AnimationVector, amount: number): AnimationVector => ({ x: v.x * amount, y: v.y * amount, z: v.z * amount });
const values = (v: AnimationVector) => [v.x, v.y, v.z];
const inverse = (q: AnimationQuaternion): AnimationQuaternion => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const identityJoint: AnimationJointTransform = { position: ZERO, rotation: ANIMATION_IDENTITY_ROTATION, scale: ONE };
function direction(value: AnimationVector): AnimationVector {
  const v = vec(value, 'trajectory direction'), length = Math.hypot(v.x, v.y, v.z);
  if (length < 1e-8) fail('trajectory direction must not be zero');
  return scale(v, 1 / length);
}
function rotationAxes(q: AnimationQuaternion): number[] {
  const { x, y, z, w } = q;
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
}
function localTime(clip: AnimationClip, timeMs: number): number {
  return clip.loop ? ((timeMs % clip.durationMs) + clip.durationMs) % clip.durationMs : Math.max(0, Math.min(clip.durationMs, timeMs));
}
function rememberSample<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= MAX_SAMPLE_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}
type JointSchema = Required<MotionJointFeature>;
type ContactSchema = { name: string; weight: number };
type ValidSchema = {
  trajectoryTimesMs: readonly number[]; joints: readonly JointSchema[]; contacts: readonly ContactSchema[];
  positionWeight: number; directionWeight: number; sampleWeights: readonly number[]; normalizationFloor: number;
};
type CompiledSource = Omit<MotionSource, 'tags'> & { tags: readonly string[]; endBehavior: 'select' | 'hold'; cacheFeatures: boolean };
type TreeNode = { index: number; axis: number; left?: TreeNode; right?: TreeNode };
type PreparedQuery = { features: Float64Array; rig?: string; required: readonly string[]; excluded: readonly string[]; warnings: string[] };

function schemaOf(schema: MotionSchema): ValidSchema {
  if (!schema || !Array.isArray(schema.trajectoryTimesMs) || schema.trajectoryTimesMs.length < 1 || schema.trajectoryTimesMs.length > 8) fail('schema needs 1..8 future trajectory offsets');
  let previous = -1;
  const trajectoryTimesMs = schema.trajectoryTimesMs.map(time => {
    finite(time, 'trajectory offset', 0, 3000);
    if (time <= previous) fail('trajectory offsets must strictly increase');
    previous = time; return time;
  });
  if (!Array.isArray(schema.joints) || schema.joints.length > 24) fail('schema supports at most 24 pose joints');
  const names = new Set<string>();
  const joints = schema.joints.map(joint => {
    const name = label(joint.joint, 'joint');
    if (names.has(name)) fail(`duplicate pose joint ${name}`);
    names.add(name);
    return Object.freeze({ joint: name, positionWeight: finite(joint.positionWeight ?? 1, 'position weight', 0, 100),
      rotationWeight: finite(joint.rotationWeight ?? 1, 'rotation weight', 0, 100), velocityWeight: finite(joint.velocityWeight ?? 0, 'velocity weight', 0, 100),
      angularVelocityWeight: finite(joint.angularVelocityWeight ?? 0, 'angular velocity weight', 0, 100) });
  });
  if (schema.contacts && (!Array.isArray(schema.contacts) || schema.contacts.length > 16)) fail('schema supports at most 16 contacts');
  const contactNames = new Set<string>();
  const contacts = (schema.contacts ?? []).map(contact => {
    const name = label(contact.name, 'contact');
    if (contactNames.has(name)) fail(`duplicate contact ${name}`);
    contactNames.add(name);
    return Object.freeze({ name, weight: finite(contact.weight ?? 1, 'contact weight', 0, 100) });
  });
  if (schema.trajectorySampleWeights && schema.trajectorySampleWeights.length !== trajectoryTimesMs.length) fail('trajectory sample weights must match offsets');
  return Object.freeze({ trajectoryTimesMs: Object.freeze(trajectoryTimesMs), joints: Object.freeze(joints), contacts: Object.freeze(contacts),
    positionWeight: finite(schema.trajectoryPositionWeight ?? 1, 'trajectory position weight', 0, 100),
    directionWeight: finite(schema.trajectoryDirectionWeight ?? 1, 'trajectory direction weight', 0, 100),
    sampleWeights: Object.freeze(trajectoryTimesMs.map((_, i) => finite(schema.trajectorySampleWeights?.[i] ?? 1, 'sample weight', 0, 100))),
    normalizationFloor: finite(schema.normalizationFloor ?? 0.05, 'normalization floor', 1e-6, 1e4) });
}

/** Immutable frame features with a deterministic exact k-d tree. */
export class MotionDatabase {
  readonly frameCount: number;
  readonly dimensionCount: number;
  readonly sampleIntervalMs: number;
  readonly statistics: readonly MotionFeatureStatistic[];
  private readonly schema: ValidSchema;
  private readonly sources = new Map<string, CompiledSource>();
  private readonly jointCoverage = new Map<string, Set<string>>();
  private readonly sourceWarnings = new Map<string, readonly string[]>();
  private collectCoverage = true;
  private readonly frames: readonly MotionFrame[];
  private readonly sourceFrames = new Map<string, Readonly<{ first: number; count: number }>>();
  private readonly features: Float64Array;
  private readonly weightScales: Float64Array;
  private readonly tree: TreeNode;
  private readonly sampledFeatures = new Map<string, Float64Array>();
  private readonly decodedOnly: boolean;
  private ownedQuery: { query: MotionQuery; prepared?: PreparedQuery } | undefined;

  constructor(definition: MotionDatabaseDefinition) {
    this.schema = schemaOf(definition.schema);
    this.sampleIntervalMs = finite(definition.sampleIntervalMs ?? 100, 'sample interval', 8, 1000);
    const maxFrames = finite(definition.maxFrames ?? MAX_FRAMES, 'frame budget', 1, MAX_FRAMES);
    if (!Number.isInteger(maxFrames)) fail('frame budget must be an integer');
    if (!Array.isArray(definition.sources) || definition.sources.length < 1 || definition.sources.length > 128) fail('database needs 1..128 motion sources');
    const stat: MotionFeatureStatistic[] = [];
    const group = (prefix: string, dimensions: number, weight: number) => {
      if (weight === 0) return;
      for (let i = 0; i < dimensions; i++) stat.push({ name: `${prefix}.${i}`, mean: 0, deviation: 0, weight: weight / dimensions });
    };
    for (let i = 0; i < this.schema.trajectoryTimesMs.length; i++) {
      const weight = this.schema.sampleWeights[i] / this.schema.trajectoryTimesMs.length;
      group(`trajectory.${this.schema.trajectoryTimesMs[i]}.position`, 3, this.schema.positionWeight * weight);
      group(`trajectory.${this.schema.trajectoryTimesMs[i]}.direction`, 3, this.schema.directionWeight * weight);
    }
    for (const joint of this.schema.joints) {
      group(`joint.${joint.joint}.position`, 3, joint.positionWeight);
      group(`joint.${joint.joint}.rotation`, 6, joint.rotationWeight);
      group(`joint.${joint.joint}.velocity`, 3, joint.velocityWeight);
      group(`joint.${joint.joint}.angularVelocity`, 3, joint.angularVelocityWeight);
    }
    for (const contact of this.schema.contacts) group(`contact.${contact.name}`, 1, contact.weight);
    if (stat.length < 1 || stat.length > MAX_DIMENSIONS) fail(`schema needs 1..${MAX_DIMENSIONS} weighted feature dimensions`);
    this.dimensionCount = stat.length;
    const frames: MotionFrame[] = [];
    for (const source of definition.sources) {
      const id = label(source.id, 'source ID');
      if (this.sources.has(id)) fail(`duplicate source ${id}`);
      if (typeof source.trajectory !== 'function') fail(`${id} needs a trajectory descriptor`);
      if (source.contacts !== undefined && typeof source.contacts !== 'function') fail(`${id} contacts must be a sampler`);
      const clip = defineAnimationClip(source.clip), tags = labels(source.tags, 'source tags');
      const rig = source.rig === undefined ? undefined : label(source.rig, 'rig');
      const parameters = source.parameters ? Object.freeze({ ...source.parameters }) : undefined;
      const endBehavior = source.endBehavior ?? 'select';
      if (endBehavior !== 'select' && endBehavior !== 'hold') fail('end behavior must be select or hold');
      this.sources.set(id, Object.freeze({ ...source, id, clip, rig, tags, parameters, endBehavior, cacheFeatures: decodedSources.has(source) }));
      this.jointCoverage.set(id, new Set());
      const count = Math.ceil(clip.durationMs / this.sampleIntervalMs) + (!clip.loop && endBehavior === 'hold' ? 1 : 0);
      if (frames.length + count > maxFrames) fail(`database exceeds ${maxFrames} frames; increase sample interval or reduce clips`);
      this.sourceFrames.set(id, { first: frames.length, count });
      for (let i = 0; i < count; i++) frames.push(Object.freeze({ index: frames.length, sourceId: id,
        timeMs: Math.min(clip.durationMs, i * this.sampleIntervalMs), ...(rig === undefined ? {} : { rig }), tags }));
    }
    this.frames = Object.freeze(frames);
    this.decodedOnly = [...this.sources.values()].every(source => source.cacheFeatures);
    this.frameCount = frames.length;
    // Welford normalization avoids cancellation for large reference positions.
    const raw = new Float64Array(this.frameCount * this.dimensionCount);
    for (const frame of frames) {
      const row = this.sourceFeatures(this.sources.get(frame.sourceId)!, frame.timeMs);
      raw.set(row, frame.index * this.dimensionCount);
      for (let d = 0; d < this.dimensionCount; d++) {
        const difference = row[d] - stat[d].mean;
        stat[d].mean += difference / (frame.index + 1);
        stat[d].deviation += difference * (row[d] - stat[d].mean);
      }
    }
    for (const source of this.sources.values()) this.sourceWarnings.set(source.id,
      Object.freeze(this.schema.joints.filter(joint => (joint.positionWeight + joint.rotationWeight + joint.velocityWeight + joint.angularVelocityWeight) > 0
        && !this.jointCoverage.get(source.id)!.has(joint.joint))
        .map(joint => `source-joint-untracked:${source.id}:${joint.joint}`)));
    this.collectCoverage = false;
    this.statistics = Object.freeze(stat.map(item => Object.freeze({ ...item,
      deviation: Math.max(this.schema.normalizationFloor, Math.sqrt(Math.max(0, item.deviation / this.frameCount))) })));
    this.weightScales = Float64Array.from(this.statistics, statistic => Math.sqrt(statistic.weight));
    this.features = raw;
    for (let index = 0; index < this.frameCount; index++) {
      for (let d = 0; d < this.dimensionCount; d++) {
        const statistic = this.statistics[d], offset = index * this.dimensionCount + d;
        raw[offset] = (raw[offset] - statistic.mean) / statistic.deviation * this.weightScales[d];
      }
    }
    this.tree = this.buildTree(frames.map(frame => frame.index))!;
  }

  /** Pose sampling uses the same frozen clip definition/parameters as the index. */
  sample(sourceId: string, timeMs: number): AnimationPose {
    const source = this.source(sourceId);
    return this.sourcePose(source, finite(timeMs, 'clip time'));
  }
  /** @internal Query preparation immediately validates/copies these endpoints;
   * the engine does not need another mutable copy of decoded data first. */
  sampleForOwnedQuery(sourceId: string, timeMs: number): AnimationPose {
    return this.sourceFeaturePose(this.source(sourceId), finite(timeMs, 'clip time'));
  }
  duration(sourceId: string): number { return this.source(sourceId).clip.durationMs; }
  get trajectoryHorizonMs(): number { return this.schema.trajectoryTimesMs[this.schema.trajectoryTimesMs.length - 1]; }
  loops(sourceId: string): boolean { return !!this.source(sourceId).clip.loop; }
  holdsEnd(sourceId: string): boolean { return this.source(sourceId).endBehavior === 'hold'; }
  playbackTime(sourceId: string, timeMs: number): number { return localTime(this.source(sourceId).clip, finite(timeMs, 'clip time')); }
  compatible(sourceId: string, query: MotionQuery): boolean {
    if (this.ownedQuery?.query === query && this.ownedQuery.prepared) return this.matches(this.source(sourceId), this.ownedQuery.prepared);
    return this.matches(this.source(sourceId), { rig: query.rig, required: labels(query.requiredTags, 'required tags'), excluded: labels(query.excludedTags, 'excluded tags') });
  }
  /** @internal The engine constructs a fresh private query for this synchronous
   * sample. Only privately decoded sources can reuse its prepared features:
   * authored samplers can mutate a query between score() and search(). */
  withOwnedQuery<T>(query: MotionQuery, sample: () => T): T {
    if (!this.decodedOnly) return sample();
    const previous = this.ownedQuery;
    this.ownedQuery = { query };
    try { return sample(); }
    finally { this.ownedQuery = previous; }
  }
  /** Continuous playback cost, not merely the nearest indexed frame's cost. */
  score(sourceId: string, timeMs: number, query: MotionQuery): number {
    const prepared = this.prepareQuery(query), source = this.source(sourceId);
    if (!this.matches(source, prepared)) return Infinity;
    const time = this.playbackTime(sourceId, timeMs), key = sourceId + '\0' + time;
    let features = source.cacheFeatures ? this.sampledFeatures.get(key) : undefined;
    if (!features) {
      features = this.normalize(this.sourceFeatures(source, time));
      if (source.cacheFeatures) rememberSample(this.sampledFeatures, key, features);
    }
    return this.distance(features, prepared.features);
  }
  search(query: MotionQuery, options: MotionSearchOptions = {}): MotionSearchResult {
    const method = options.method ?? 'indexed';
    if (method !== 'indexed' && method !== 'brute-force') fail('unknown search method');
    const prepared = this.prepareQuery(query);
    const excluded = new Set(labels(options.excludedSources, 'excluded source'));
    const minimumRemainingMs = finite(options.minimumRemainingMs ?? 0, 'minimum remaining time', 0, 600_000);
    if (options.startTimeLimits && Object.keys(options.startTimeLimits).length > 128) fail('at most 128 source time limits');
    for (const [id, time] of Object.entries(options.startTimeLimits ?? {})) { label(id, 'source limit'); finite(time, 'source start time limit', 0, 600_000); }
    const allowed = new Map([...this.sources.values()].filter(source => !excluded.has(source.id) && this.matches(source, prepared)).map(source => {
      const playableLimit = source.clip.loop || source.endBehavior === 'hold' ? Infinity
        : source.clip.durationMs - Math.min(minimumRemainingMs, source.clip.durationMs / 2);
      const explicitLimit = options.startTimeLimits && own(options.startTimeLimits, source.id) ? options.startTimeLimits[source.id] : Infinity;
      return [source.id, Math.min(playableLimit, explicitLimit)] as const;
    }));
    const eligible = (frame: MotionFrame) => {
      const limit = allowed.get(frame.sourceId);
      return limit !== undefined && frame.timeMs <= limit;
    };
    // Frames of each immutable source are contiguous and time-ordered. Count
    // their eligible prefix with an upper bound search instead of traversing
    // the entire index again before every k-d search. Compare stored times
    // directly so fractional intervals and held endpoints retain exact bounds.
    let candidateCount = 0;
    for (const [id, limit] of allowed) {
      const span = this.sourceFrames.get(id)!;
      let low = 0, high = span.count;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (this.frames[span.first + middle].timeMs <= limit) low = middle + 1;
        else high = middle;
      }
      candidateCount += low;
    }
    let bestIndex = -1, bestScore = Infinity, visited = 0, evaluated = 0;
    const consider = (index: number) => {
      visited++;
      if (!eligible(this.frames[index])) return;
      evaluated++;
      let score = 0; const start = index * this.dimensionCount;
      for (let d = 0; d < this.dimensionCount; d++) {
        const difference = this.features[start + d] - prepared.features[d];
        score += difference * difference;
      }
      if (score < bestScore || (score === bestScore && (bestIndex < 0 || index < bestIndex))) { bestScore = score; bestIndex = index; }
    };
    const visit = (node: TreeNode | undefined): void => {
      if (!node) return;
      consider(node.index);
      const difference = prepared.features[node.axis] - this.features[node.index * this.dimensionCount + node.axis];
      visit(difference <= 0 ? node.left : node.right);
      // Equality must visit the other side for deterministic index tie-breaking.
      if (difference * difference <= bestScore) visit(difference <= 0 ? node.right : node.left);
    };
    if (candidateCount > 0) {
      if (method === 'indexed') visit(this.tree);
      else for (let i = 0; i < this.frameCount; i++) consider(i);
    }
    return { frame: bestIndex < 0 ? null : this.frames[bestIndex], score: bestIndex < 0 ? null : bestScore,
      method, visited, evaluated, candidateCount, warnings: [...prepared.warnings,
        ...(bestIndex < 0 ? ['no-compatible-motion'] : this.sourceWarnings.get(this.frames[bestIndex].sourceId) ?? [])] };
  }

  private source(id: string): CompiledSource { const source = this.sources.get(id); if (!source) fail(`unknown source ${id}`); return source; }
  private sourcePose(source: CompiledSource, timeMs: number): AnimationPose {
    // Generic sampling owns the bounded exact keyframe cache for every player
    // and database. Its returned pose remains detached for contact callbacks.
    return sampleAnimationClip(source.clip, timeMs, { parameters: source.parameters });
  }
  private sourceFeaturePose(source: CompiledSource, timeMs: number): AnimationPose {
    // Decoded descriptors close only over immutable library data. They can read
    // a shared frozen sample while arbitrary authored contacts retain the same
    // detached mutable pose they received before this optimization.
    return source.cacheFeatures ? sampleAnimationClipReadonly(source.clip, timeMs, { parameters: source.parameters })
      : this.sourcePose(source, timeMs);
  }
  private matches(source: Pick<CompiledSource, 'rig' | 'tags'>, query: Pick<PreparedQuery, 'rig' | 'required' | 'excluded'>): boolean {
    return (source.rig === undefined || source.rig === query.rig)
      && query.required.every(tag => source.tags.includes(tag)) && query.excluded.every(tag => !source.tags.includes(tag));
  }
  private normalize(raw: readonly number[]): Float64Array {
    const result = new Float64Array(raw.length);
    for (let index = 0; index < raw.length; index++) {
      const statistic = this.statistics[index];
      result[index] = (raw[index] - statistic.mean) / statistic.deviation * this.weightScales[index];
    }
    return result;
  }
  private distance(a: Float64Array, b: Float64Array): number {
    let result = 0;
    for (let i = 0; i < a.length; i++) { const delta = a[i] - b[i]; result += delta * delta; }
    return result;
  }
  private prepareQuery(query: MotionQuery): PreparedQuery {
    if (this.ownedQuery?.query === query && this.ownedQuery.prepared) return this.ownedQuery.prepared;
    if (!query || !Array.isArray(query.trajectory) || query.trajectory.length !== this.schema.trajectoryTimesMs.length) fail('query trajectory must match schema offsets');
    const trajectory = query.trajectory.map((point, index) => {
      if (point.afterMs !== this.schema.trajectoryTimesMs[index]) fail('query trajectory offsets must exactly match schema order');
      return { position: vec(point.position, 'trajectory position'), direction: direction(point.direction) };
    });
    const pose = validateAnimationPoseReadonly(query.pose);
    const velocities: Record<string, AnimationVector> = Object.create(null);
    const angularVelocities: Record<string, AnimationVector> = Object.create(null);
    const warnings: string[] = this.schema.joints.filter(joint => (joint.positionWeight + joint.rotationWeight + joint.velocityWeight + joint.angularVelocityWeight) > 0
      && !own(pose, joint.joint)).map(joint => `query-joint-unavailable:${joint.joint}`);
    if (query.poseDeltaMs !== undefined) finite(query.poseDeltaMs, 'pose delta', 0, 1000);
    if (this.schema.joints.some(joint => joint.velocityWeight > 0 || joint.angularVelocityWeight > 0)) {
      if (query.previousPose && query.poseDeltaMs !== undefined && query.poseDeltaMs > 0) {
        const previous = validateAnimationPoseReadonly(query.previousPose), next = query.nextPose ? validateAnimationPoseReadonly(query.nextPose) : pose;
        const delta = finite(query.poseDeltaMs, 'pose delta', 0.001, 1000) / 1000;
        for (const joint of this.schema.joints) {
          if (joint.velocityWeight > 0) velocities[joint.joint] = scale(sub(next[joint.joint]?.position ?? ZERO, previous[joint.joint]?.position ?? ZERO), 1 / delta);
          if (joint.angularVelocityWeight > 0) angularVelocities[joint.joint] = scale(rotationVector(multiplyAnimationQuaternions(next[joint.joint]?.rotation ?? ANIMATION_IDENTITY_ROTATION,
            inverse(previous[joint.joint]?.rotation ?? ANIMATION_IDENTITY_ROTATION))), 1 / delta);
        }
      } else warnings.push('pose-velocity-unavailable');
    }
    const prepared = { features: this.normalize(this.rawFeatures(trajectory, pose, velocities, angularVelocities, query.contacts)),
      rig: query.rig === undefined ? undefined : label(query.rig, 'query rig'), required: labels(query.requiredTags, 'required tags'),
      excluded: labels(query.excludedTags, 'excluded tags'), warnings };
    if (this.ownedQuery?.query === query) this.ownedQuery.prepared = prepared;
    return prepared;
  }
  private sourceFeatures(source: CompiledSource, timeMs: number): number[] {
    const pose = this.sourceFeaturePose(source, timeMs);
    if (this.collectCoverage) for (const name of Object.keys(pose)) this.jointCoverage.get(source.id)?.add(name);
    const trajectory = this.schema.trajectoryTimesMs.map(afterMs => {
      const sample = source.trajectory(timeMs, afterMs);
      return { position: vec(sample.position, 'source trajectory position'), direction: direction(sample.direction) };
    });
    const velocities: Record<string, AnimationVector> = Object.create(null);
    const angularVelocities: Record<string, AnimationVector> = Object.create(null);
    if (this.schema.joints.some(joint => joint.velocityWeight > 0 || joint.angularVelocityWeight > 0)) {
      const half = MOTION_POSE_DERIVATIVE_MS / 2;
      const fromTime = source.clip.loop ? timeMs - half : Math.max(0, timeMs - half);
      const toTime = source.clip.loop ? timeMs + half : Math.min(source.clip.durationMs, timeMs + half);
      const from = this.sourceFeaturePose(source, fromTime);
      const to = this.sourceFeaturePose(source, toTime);
      for (const joint of this.schema.joints) {
        if (joint.velocityWeight > 0) velocities[joint.joint] = scale(sub(to[joint.joint]?.position ?? ZERO, from[joint.joint]?.position ?? ZERO), 1000 / (toTime - fromTime));
        if (joint.angularVelocityWeight > 0) angularVelocities[joint.joint] = scale(rotationVector(multiplyAnimationQuaternions(to[joint.joint]?.rotation ?? ANIMATION_IDENTITY_ROTATION,
          inverse(from[joint.joint]?.rotation ?? ANIMATION_IDENTITY_ROTATION))), 1000 / (toTime - fromTime));
      }
    }
    return this.rawFeatures(trajectory, pose, velocities, angularVelocities, source.contacts?.(timeMs, pose));
  }
  private rawFeatures(trajectory: readonly MotionTrajectory[], pose: AnimationPose, velocities: Readonly<Record<string, AnimationVector>>,
    angularVelocities: Readonly<Record<string, AnimationVector>>, contacts: Readonly<Record<string, number>> | undefined): number[] {
    const result: number[] = [];
    for (let i = 0; i < trajectory.length; i++) {
      if (this.schema.positionWeight * this.schema.sampleWeights[i] > 0) result.push(...values(trajectory[i].position));
      if (this.schema.directionWeight * this.schema.sampleWeights[i] > 0) result.push(...values(trajectory[i].direction));
    }
    for (const joint of this.schema.joints) {
      const value = pose[joint.joint] ?? identityJoint;
      if (joint.positionWeight > 0) result.push(...values(value.position ?? ZERO));
      if (joint.rotationWeight > 0) result.push(...rotationAxes(value.rotation ?? ANIMATION_IDENTITY_ROTATION));
      if (joint.velocityWeight > 0) result.push(...values(velocities[joint.joint] ?? ZERO));
      if (joint.angularVelocityWeight > 0) result.push(...values(angularVelocities[joint.joint] ?? ZERO));
    }
    for (const contact of this.schema.contacts) if (contact.weight > 0) {
      if (!contacts || !own(contacts, contact.name)) fail(`missing declared contact ${contact.name}`);
      result.push(finite(contacts[contact.name], `contact.${contact.name}`, 0, 1));
    }
    return result.map(value => finite(value, 'feature'));
  }
  private buildTree(indices: number[]): TreeNode | undefined {
    if (!indices.length) return undefined;
    let axis = 0, widest = -1;
    for (let d = 0; d < this.dimensionCount; d++) {
      let min = Infinity, max = -Infinity;
      for (const index of indices) { const value = this.features[index * this.dimensionCount + d]; min = Math.min(min, value); max = Math.max(max, value); }
      if (max - min > widest) { widest = max - min; axis = d; }
    }
    indices.sort((a, b) => this.features[a * this.dimensionCount + axis] - this.features[b * this.dimensionCount + axis] || a - b);
    const middle = Math.floor(indices.length / 2);
    return { index: indices[middle], axis, left: this.buildTree(indices.slice(0, middle)), right: this.buildTree(indices.slice(middle + 1)) };
  }
}

type VectorOffset = { value: AnimationVector; velocity: AnimationVector; logarithmic?: { x: boolean; y: boolean; z: boolean } };
type JointOffset = { position?: VectorOffset; rotation?: VectorOffset; scale?: VectorOffset };
type Transition = { atMs: number; from: AnimationPose; offsets: Readonly<Record<string, JointOffset>> };
type Playback = { sourceId: string; timeMs: number };
function rotationVector(value: AnimationQuaternion, reference?: AnimationQuaternion): AnimationVector {
  let q = normalizeAnimationQuaternion(value);
  const sign = reference ? q.x * reference.x + q.y * reference.y + q.z * reference.z + q.w * reference.w : q.w;
  if (sign < 0) q = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
  const size = Math.hypot(q.x, q.y, q.z);
  return size < 1e-9 ? scale(q, 2) : scale(q, 2 * Math.atan2(size, q.w) / size);
}
function fromRotationVector(value: AnimationVector): AnimationQuaternion {
  const angle = Math.hypot(value.x, value.y, value.z);
  if (angle < 1e-9) return normalizeAnimationQuaternion({ x: value.x / 2, y: value.y / 2, z: value.z / 2, w: 1 });
  const v = scale(value, Math.sin(angle / 2) / angle);
  return { ...v, w: Math.cos(angle / 2) };
}
function transitionOffsets(from: AnimationPose, futureFrom: AnimationPose, to: AnimationPose, futureTo: AnimationPose, seconds: number): Readonly<Record<string, JointOffset>> {
  const result: Record<string, JointOffset> = Object.create(null);
  const joints = new Set([...Object.keys(from), ...Object.keys(futureFrom), ...Object.keys(to), ...Object.keys(futureTo)]);
  if (joints.size > 128) fail('transition exceeds 128 joints');
  const offset = (a: AnimationVector, futureA: AnimationVector, b: AnimationVector, futureB: AnimationVector): VectorOffset => {
    const value = sub(a, b);
    return { value, velocity: scale(sub(sub(futureA, futureB), value), 1 / seconds) };
  };
  for (const joint of joints) {
    const a = from[joint] ?? {}, fa = futureFrom[joint] ?? {}, b = to[joint] ?? {}, fb = futureTo[joint] ?? {}, out: JointOffset = {};
    if (a.position || fa.position || b.position || fb.position) out.position = offset(a.position ?? ZERO, fa.position ?? ZERO, b.position ?? ZERO, fb.position ?? ZERO);
    if (a.scale || fa.scale || b.scale || fb.scale) {
      const av = a.scale ?? ONE, fav = fa.scale ?? ONE, bv = b.scale ?? ONE, fbv = fb.scale ?? ONE;
      const value = offset(av, fav, bv, fbv), logarithmic = { x: false, y: false, z: false };
      for (const axis of ['x', 'y', 'z'] as const) {
        // A positive-size blend must not accidentally flip a model inside out.
        // Same-sign mirrored scales work too. Deliberate zero/sign changes keep
        // linear interpolation, since their logarithm is not defined.
        if (av[axis] !== 0 && Math.sign(av[axis]) === Math.sign(fav[axis])
          && Math.sign(av[axis]) === Math.sign(bv[axis]) && Math.sign(av[axis]) === Math.sign(fbv[axis])) {
          logarithmic[axis] = true;
          value.value[axis] = Math.log(Math.abs(av[axis])) - Math.log(Math.abs(bv[axis]));
          const later = Math.log(Math.abs(fav[axis])) - Math.log(Math.abs(fbv[axis]));
          value.velocity[axis] = (later - value.value[axis]) / seconds;
        }
      }
      out.scale = { ...value, logarithmic };
    }
    if (a.rotation || fa.rotation || b.rotation || fb.rotation) {
      const delta = multiplyAnimationQuaternions(a.rotation ?? ANIMATION_IDENTITY_ROTATION, inverse(b.rotation ?? ANIMATION_IDENTITY_ROTATION));
      const future = multiplyAnimationQuaternions(fa.rotation ?? ANIMATION_IDENTITY_ROTATION, inverse(fb.rotation ?? ANIMATION_IDENTITY_ROTATION));
      const value = rotationVector(delta), later = rotationVector(future, delta);
      out.rotation = { value, velocity: scale(sub(later, value), 1 / seconds) };
    }
    result[joint] = out;
  }
  return result;
}
function decay(offset: VectorOffset, phase: number, durationSeconds: number): AnimationVector {
  const squared = phase * phase, cubed = squared * phase;
  return add(scale(offset.value, 2 * cubed - 3 * squared + 1), scale(offset.velocity, (cubed - 2 * squared + phase) * durationSeconds));
}

/** Actor-local playback and selection state. Share the immutable database across actors. */
export class MotionMatcher {
  private readonly database: MotionDatabase;
  private readonly options: Required<MotionMatcherOptions>;
  private playback: Playback | undefined;
  private transition: Transition | undefined;
  private lastTime: number | undefined;
  private epoch: string | number | undefined;
  private lastSearch = -Infinity;
  private lastSwitch = -Infinity;
  private lastResult: MotionSearchResult | undefined;

  constructor(database: MotionDatabase, options: MotionMatcherOptions = {}) {
    this.database = database;
    const transition = options.transition ?? 'inertial';
    if (transition !== 'inertial' && transition !== 'crossfade') fail('unknown transition type');
    if (options.preserveLoopPhase !== undefined && typeof options.preserveLoopPhase !== 'boolean') fail('preserveLoopPhase must be boolean');
    this.options = { blendMs: finite(options.blendMs ?? 120, 'blend duration', 0, 2000), transition,
      searchIntervalMs: finite(options.searchIntervalMs ?? 80, 'search interval', 0, 2000),
      switchCooldownMs: finite(options.switchCooldownMs ?? 160, 'switch cooldown', 0, 5000),
      continuityBias: finite(options.continuityBias ?? 0.08, 'continuity bias', 0, 100),
      continuationWindowMs: finite(options.continuationWindowMs ?? database.sampleIntervalMs * 1.5, 'continuation window', 0, 5000),
      preserveLoopPhase: options.preserveLoopPhase ?? false,
      maxFrameGapMs: finite(options.maxFrameGapMs ?? 1000, 'frame gap', 1, 60_000),
      coverageThreshold: finite(options.coverageThreshold ?? 4, 'coverage threshold', 0, 1e6) };
  }
  reset(): void {
    this.playback = undefined; this.transition = undefined; this.lastTime = undefined; this.epoch = undefined;
    this.lastSearch = -Infinity; this.lastSwitch = -Infinity; this.lastResult = undefined;
  }
  /** Preview uninterrupted rendered pose and its centered velocity at the next
   * presentation time, including any active inertial blend. Does not search,
   * advance playback, consume a reset, or change diagnostics. Undefined before
   * initial playback or across the same discontinuities that reset sample().
   * Trajectory and contact queries remain the caller's responsibility. */
  continuation(input: Omit<MotionMatcherInput, 'query'>): Pick<MotionQuery, 'pose' | 'previousPose' | 'nextPose' | 'poseDeltaMs'> | undefined {
    return this.continuationAt(input, false);
  }
  /** @internal Decoded endpoints may be frozen shared samples. The driver
   * passes them directly to query validation and never exposes or mutates them. */
  continuationForOwnedQuery(input: Omit<MotionMatcherInput, 'query'>): Pick<MotionQuery, 'pose' | 'previousPose' | 'nextPose' | 'poseDeltaMs'> | undefined {
    return this.continuationAt(input, true);
  }
  private continuationAt(input: Omit<MotionMatcherInput, 'query'>, ownedQuery: boolean): Pick<MotionQuery, 'pose' | 'previousPose' | 'nextPose' | 'poseDeltaMs'> | undefined {
    const now = finite(input.timeMs, 'frame time'), rate = finite(input.playbackRate ?? 1, 'playback rate', 0, 4);
    if (!this.playback || this.lastTime === undefined || input.reset || now < this.lastTime
      || input.epoch !== this.epoch || now - this.lastTime > this.options.maxFrameGapMs) return undefined;
    const advance = (now - this.lastTime) * rate, half = MOTION_POSE_DERIVATIVE_MS / 2;
    return { pose: this.outputAt(now, advance, ownedQuery),
      previousPose: this.outputAt(now - half, advance - half * rate, ownedQuery),
      nextPose: this.outputAt(now + half, advance + half * rate, ownedQuery), poseDeltaMs: MOTION_POSE_DERIVATIVE_MS };
  }
  /** @internal Used by engine drivers that own their freshly built query. This
   * is a per-call scope, never a cache of caller-owned poses across frames. */
  sampleWithOwnedQuery(input: MotionMatcherInput): MotionMatcherResult {
    return this.database.withOwnedQuery(input.query, () => this.sample(input));
  }
  sample(input: MotionMatcherInput): MotionMatcherResult {
    const now = finite(input.timeMs, 'frame time');
    if (input.epoch !== undefined && typeof input.epoch !== 'string' && typeof input.epoch !== 'number') fail('epoch must be a string or number');
    if (typeof input.epoch === 'number') finite(input.epoch, 'epoch');
    if (typeof input.epoch === 'string' && input.epoch.length > 128) fail('epoch is too long');
    const rate = finite(input.playbackRate ?? 1, 'playback rate', 0, 4);
    const reset = !!input.reset || (this.lastTime !== undefined && (now < this.lastTime || input.epoch !== this.epoch || now - this.lastTime > this.options.maxFrameGapMs));
    if (reset) this.reset();
    if (this.playback && this.lastTime !== undefined) this.playback.timeMs += (now - this.lastTime) * rate;
    this.lastTime = now; this.epoch = input.epoch;
    let switched = false, searched = false;
    const frameWarnings: string[] = [];
    let score: number | null = this.playback ? this.database.score(this.playback.sourceId, this.playback.timeMs, input.query) : null;
    const incompatible = this.playback ? !this.database.compatible(this.playback.sourceId, input.query) : false;
    const exhausted = !!this.playback && !this.database.loops(this.playback.sourceId) && !this.database.holdsEnd(this.playback.sourceId)
      && this.playback.timeMs >= this.database.duration(this.playback.sourceId);
    if (!this.playback || incompatible || exhausted || now - this.lastSearch >= this.options.searchIntervalMs) {
      // Clamped trajectories at the end of a moving one-shot can look like a
      // perfect stop. Entering those last few frames immediately exhausts the
      // clip and repeatedly interrupts blending as other endpoints win. Keep
      // enough recorded future for matching and enough playback for settling;
      // a selected motion may still play all the way through its actual end.
      const minimumRemainingMs = Math.max(this.database.sampleIntervalMs, this.database.trajectoryHorizonMs,
        this.options.blendMs * rate, this.options.searchIntervalMs * rate, this.options.switchCooldownMs * rate);
      let result = this.database.search(input.query, { minimumRemainingMs,
        ...(exhausted ? { excludedSources: [this.playback!.sourceId] } : {}) });
      if (this.options.preserveLoopPhase && this.playback && this.database.loops(this.playback.sourceId)
        && result.frame?.sourceId === this.playback.sourceId) {
        // A better phase of the same loop must not hide a genuine better source.
        // Compare the best alternative with uninterrupted current playback.
        const alternate = this.database.search(input.query, { minimumRemainingMs, excludedSources: [this.playback.sourceId] });
        if (alternate.frame) result = alternate;
      }
      if (exhausted && !result.frame) {
        // A library containing only this one-shot still cannot hold its endpoint
        // accidentally. Permit a real earlier segment, and report the coverage gap.
        result = this.database.search(input.query, { minimumRemainingMs,
          startTimeLimits: { [this.playback!.sourceId]: this.database.duration(this.playback!.sourceId) / 2 } });
        frameWarnings.push('nonloop-motion-restarted:no-other-compatible-source');
      }
      this.lastResult = result; this.lastSearch = now; searched = true;
      if (result.frame) {
        const current = this.playback;
        let closeContinuation = false;
        if (current?.sourceId === result.frame.sourceId) {
          const duration = this.database.duration(current.sourceId), time = this.database.playbackTime(current.sourceId, current.timeMs);
          const difference = Math.abs(time - result.frame.timeMs);
          closeContinuation = this.options.preserveLoopPhase && this.database.loops(current.sourceId)
            || (this.database.loops(current.sourceId) ? Math.min(difference, duration - difference) : difference) <= this.options.continuationWindowMs;
        }
        const maySwitch = !current || incompatible || exhausted || (now - this.lastSwitch >= this.options.switchCooldownMs && !closeContinuation
          && result.score! + this.options.continuityBias < (score ?? Infinity));
        if (maySwitch) {
          const from = current ? this.outputAt(now, 0) : undefined;
          const futureFrom = current ? this.outputAt(now + 1, rate) : undefined;
          this.playback = { sourceId: result.frame.sourceId, timeMs: result.frame.timeMs };
          this.transition = undefined;
          if (from && futureFrom && this.options.blendMs > 0) {
            const to = this.database.sample(this.playback.sourceId, this.playback.timeMs);
            const futureTo = this.database.sample(this.playback.sourceId, this.playback.timeMs + rate);
            this.transition = { atMs: now, from, offsets: transitionOffsets(from, futureFrom, to, futureTo, 0.001) };
          }
          this.lastSwitch = now; switched = true; score = result.score;
        }
      } else if (incompatible) { this.playback = undefined; this.transition = undefined; score = null; }
    }
    const pose = this.playback ? this.outputAt(now, 0) : {};
    const phase = this.transition ? Math.min(1, Math.max(0, (now - this.transition.atMs) / this.options.blendMs)) : 1;
    if (phase === 1) this.transition = undefined;
    const playbackTime = this.playback ? this.database.playbackTime(this.playback.sourceId, this.playback.timeMs) : null;
    const warnings = [...(this.lastResult?.warnings ?? []), ...frameWarnings];
    if (score !== null && score > this.options.coverageThreshold) warnings.push('sparse-motion-coverage');
    if (reset) warnings.push('playback-reinitialized');
    return { pose, diagnostics: { selectedClip: this.playback?.sourceId ?? null, selectedTimeMs: playbackTime,
      selectedPhase: this.playback && playbackTime !== null ? playbackTime / this.database.duration(this.playback.sourceId) : null,
      ...(this.playback ? { selectedDurationMs: this.database.duration(this.playback.sourceId),
        selectedLoop: this.database.loops(this.playback.sourceId), selectedHoldsEnd: this.database.holdsEnd(this.playback.sourceId) } : {}),
      playbackRate: rate,
      score: score !== null && Number.isFinite(score) ? score : null, coverageScore: score !== null && Number.isFinite(score) ? score : null,
      candidate: this.lastResult?.frame ?? null, candidateScore: this.lastResult?.score ?? null,
      candidateCount: this.lastResult?.candidateCount ?? 0, frameCount: this.database.frameCount,
      visited: searched ? this.lastResult?.visited ?? 0 : 0, searched, switched, reset,
      transitionWeight: phase, transition: this.options.transition, warnings } };
  }
  private outputAt(now: number, advanceMs: number, ownedQuery = false): AnimationPose {
    if (!this.playback) return {};
    const target = ownedQuery ? this.database.sampleForOwnedQuery(this.playback.sourceId, this.playback.timeMs + advanceMs)
      : this.database.sample(this.playback.sourceId, this.playback.timeMs + advanceMs);
    const transition = this.transition;
    if (!transition || this.options.blendMs === 0) return target;
    const phase = Math.max(0, Math.min(1, (now - transition.atMs) / this.options.blendMs));
    if (phase >= 1) return target;
    if (this.options.transition === 'crossfade') return blendAnimationPoses(transition.from, target, phase * phase * (3 - 2 * phase));
    const result = validateAnimationPose(target) as Record<string, AnimationJointTransform>;
    for (const [joint, offset] of Object.entries(transition.offsets)) {
      const value = result[joint] ??= {};
      if (offset.position) value.position = add(value.position ?? ZERO, decay(offset.position, phase, this.options.blendMs / 1000));
      if (offset.scale) {
        const base = value.scale ?? ONE, delta = decay(offset.scale, phase, this.options.blendMs / 1000);
        const result = add(base, delta);
        for (const axis of ['x', 'y', 'z'] as const) if (offset.scale.logarithmic?.[axis] && base[axis] !== 0) {
          const logarithm = Math.log(Math.abs(base[axis])) + delta[axis];
          result[axis] = Math.sign(base[axis]) * Math.exp(Math.max(-700, Math.min(Math.log(1e4), logarithm)));
        }
        value.scale = result;
      }
      if (offset.rotation) value.rotation = multiplyAnimationQuaternions(fromRotationVector(decay(offset.rotation, phase, this.options.blendMs / 1000)), value.rotation ?? ANIMATION_IDENTITY_ROTATION);
    }
    return validateAnimationPose(result);
  }
}
