import { blendAnimationPoses, defineAnimationClip, registerDecodedAnimationClip, sampleAnimationClip, slerpAnimationQuaternions,
  type AnimationClip, type AnimationJointTransform, type AnimationPose, type AnimationQuaternion, type AnimationVector } from './animation.ts';
import { validateCreatureRig, type CreatureRig } from './creatureRigs.ts';
import { CREATURE_ANIMATION_DATA } from './creatureAnimationData.ts';

/** Uniformly sampled rest-relative tracks. A constant channel contains one
 * vector/quaternion; a varying channel contains one per frame, including both
 * endpoints. Source transforms are preserved without inventing root travel. */
export type PackedCreatureChannel = readonly number[] | string;
export interface PackedCreatureBank {
  version: 'packed-creature-v1';
  id: string;
  label: string;
  family: string;
  tags: readonly string[];
  rig: CreatureRig;
  positionScale: number;
  rotationScale: number;
  scaleScale: number;
  clips: readonly {
    id: string; sourceName: string; aliases?: readonly string[]; durationMs: number; loop: boolean; tags: readonly string[]; frameCount: number;
    tracks: readonly { joint: string; position?: PackedCreatureChannel; rotation?: PackedCreatureChannel; scale?: PackedCreatureChannel }[];
    /** Optional measured source displacement, extracted out of pose tracks. */
    rootMotion?: { joint: string; positions: readonly number[] };
  }[];
}
export interface CreatureClipMetadata {
  readonly id: string; readonly sourceName: string; readonly durationMs: number; readonly loop: boolean; readonly tags: readonly string[];
  readonly aliases: readonly string[];
}
export interface SharedCreatureClip extends CreatureClipMetadata {
  readonly clip: AnimationClip;
  /** Source displacement within one cycle, clamped 0..duration, in source world
   * axes/meters. Applying travel is opt-in and owned by gameplay, not the rig. */
  readonly rootMotion?: Readonly<{ joint: string; sample(timeMs: number): AnimationVector }>;
}
export interface CreatureAnimationCatalogEntry {
  readonly id: string; readonly label: string; readonly family: string; readonly tags: readonly string[];
  readonly rigId: string; readonly actions: readonly string[]; readonly clipCount: number;
  readonly clips: readonly CreatureClipMetadata[];
  readonly coverage: Readonly<{ contacts: 'unknown'; trajectory: 'unavailable' }>;
}
export interface SharedCreatureBank extends Omit<CreatureAnimationCatalogEntry, 'clips'> {
  readonly rig: CreatureRig; readonly clips: readonly SharedCreatureClip[];
}
export interface CreatureAnimationFilter { family?: string; tag?: string; action?: string }
const coverage = Object.freeze({ contacts: 'unknown', trajectory: 'unavailable' } as const);
const fail = (message: string): never => { throw new Error(`Creature animation: ${message}.`); };
function finite(value: number, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`invalid ${label}`);
  return value;
}
function name(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,95}$/.test(value)) fail('invalid name');
  return value;
}
function text(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim().length || value.length > 2048) fail(`invalid ${label}`);
  return value;
}
function tags(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 64) fail('invalid tags');
  return Object.freeze([...new Set(values.map(name))]);
}
/** Small portable decoder: simulation sandboxes provide standard JavaScript but
 * need not expose browser atob or Node Buffer. Accept canonical padded base64. */
function decodeChannelBase64(encoded: string, expected: number): Uint8Array {
  if (!encoded.length || encoded.length % 4 !== 0) return fail('invalid compressed channel base64');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const length = encoded.length / 4 * 3 - padding;
  if (length < expected || length > expected * 5) return fail('invalid compressed channel length');
  const bytes = new Uint8Array(length);
  const digit = (code: number): number => {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    if (code === 43) return 62;
    if (code === 47) return 63;
    return fail('invalid compressed channel base64');
  };
  let output = 0;
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const last = offset + 4 === encoded.length;
    const a = digit(encoded.charCodeAt(offset)), b = digit(encoded.charCodeAt(offset + 1));
    const c = last && padding === 2 ? 0 : digit(encoded.charCodeAt(offset + 2));
    const d = last && padding > 0 ? 0 : digit(encoded.charCodeAt(offset + 3));
    if (last && (padding === 2 && (b & 15) !== 0 || padding === 1 && (c & 3) !== 0))
      return fail('invalid compressed channel base64 padding');
    bytes[output++] = a * 4 + (b >> 4);
    if (output < length) bytes[output++] = (b & 15) * 16 + (c >> 2);
    if (output < length) bytes[output++] = (c & 3) * 64 + d;
  }
  return bytes;
}
/** v1 channels encode signed deltas against the preceding frame's same scalar
 * using zigzag unsigned varints, then base64. Bounds are checked before/while
 * decoding, so corrupt data cannot allocate an unbounded sample buffer. */
function unpackChannel(values: PackedCreatureChannel, width: number, count: number): readonly number[] | Float64Array {
  if (typeof values !== 'string') {
    if (!Array.isArray(values) || (values.length !== width && values.length !== width * count)) fail('invalid channel length');
    return values;
  }
  const expected = width * count;
  if (!values.startsWith('v1:') || values.length > 3 + Math.ceil(expected * 5 / 3) * 4) fail('invalid compressed channel length/version');
  const bytes = decodeChannelBase64(values.slice(3), expected);
  const result = new Float64Array(expected);
  let cursor = 0;
  for (let i = 0; i < expected; i++) {
    let encoded = 0, multiplier = 1, complete = false;
    for (let j = 0; j < 5 && cursor < bytes.length; j++) {
      const byte = bytes[cursor++];
      encoded += (byte & 127) * multiplier;
      if (encoded > 0xffffffff) fail('compressed channel integer overflow');
      if (!(byte & 128)) { complete = true; break; }
      multiplier *= 128;
    }
    if (!complete) fail('truncated/oversized compressed channel integer');
    const delta = encoded % 2 ? -(encoded + 1) / 2 : encoded / 2;
    const value = delta + (i >= width ? result[i - width] : 0);
    if (value < -0x80000000 || value > 0x7fffffff) fail('compressed channel sample overflow');
    result[i] = value;
  }
  if (cursor !== bytes.length) fail('compressed channel has trailing samples');
  return result;
}
function metadata(data: PackedCreatureBank): CreatureAnimationCatalogEntry {
  if (!data || data.version !== 'packed-creature-v1') fail('unsupported format');
  if (!Array.isArray(data.clips) || !data.clips.length || data.clips.length > 512) fail('expected 1..512 clips');
  const ids = new Set<string>();
  const clips = data.clips.map(value => {
    const id = name(value.id);
    if (ids.has(id)) fail('duplicate clip ID'); ids.add(id);
    if (typeof value.loop !== 'boolean') fail('invalid clip loop');
    if (value.aliases && (!Array.isArray(value.aliases) || value.aliases.length > 64)) fail('invalid source aliases');
    return Object.freeze({ id, sourceName: text(value.sourceName, 'clip source name'),
      aliases: Object.freeze((value.aliases ?? []).map(alias => text(alias, 'source alias'))),
      durationMs: finite(value.durationMs, 1, 600_000, 'duration'), loop: value.loop, tags: tags(value.tags) });
  });
  return Object.freeze({ id: name(data.id), label: text(data.label, 'label'), family: name(data.family), tags: tags(data.tags),
    rigId: name(data.rig?.id), clips: Object.freeze(clips), clipCount: clips.length,
    actions: Object.freeze([...new Set(clips.flatMap(clip => clip.tags))].sort()),
    coverage });
}

/** Decode and validate only the requested bank. Packed channels are copied once;
 * sampling interpolates two frames without materializing every pose up front. */
export function decodeCreatureAnimationBank(data: PackedCreatureBank): SharedCreatureBank {
  const info = metadata(data), rig = validateCreatureRig(data.rig);
  const positionScale = finite(data.positionScale, 1, 1e9, 'position scale');
  const rotationScale = finite(data.rotationScale, 1, 1e9, 'rotation scale');
  const scaleScale = finite(data.scaleScale, 1, 1e9, 'scale scale');
  const joints = new Set(rig.joints.map(joint => joint.name));
  let totalValues = 0;
  const clips = data.clips.map((source, index): SharedCreatureClip => {
    const count = finite(source.frameCount, 2, 2048, 'frame count');
    if (!Number.isInteger(count)) fail('frame count must be an integer');
    if (!Array.isArray(source.tracks) || source.tracks.length > rig.joints.length) fail('invalid track count');
    const tracked = new Set<string>();
    const channel = (values: PackedCreatureChannel | undefined, width: number, divisor: number, label: string): Float64Array | undefined => {
      if (values === undefined) return undefined;
      const unpacked = unpackChannel(values, width, count);
      totalValues += unpacked.length;
      if (totalValues > 8_000_000) fail('bank exceeds sample budget');
      const result = new Float64Array(unpacked.length);
      for (let i = 0; i < unpacked.length; i++) {
        if (!Number.isSafeInteger(unpacked[i])) fail(`invalid packed ${label}`);
        result[i] = finite(unpacked[i] / divisor, -1e4, 1e4, label);
      }
      if (width === 4) for (let i = 0; i < result.length; i += 4) {
        const length = Math.hypot(result[i], result[i + 1], result[i + 2], result[i + 3]);
        if (length < 1e-8) fail('zero quaternion');
        for (let j = 0; j < 4; j++) result[i + j] /= length;
      }
      return result;
    };
    const tracks = source.tracks.map(track => {
      if (!track || !joints.has(track.joint) || tracked.has(track.joint)) fail('tracks require unique joints in this rig');
      tracked.add(track.joint);
      if (!track.position && !track.rotation && !track.scale) fail('empty track');
      return { joint: track.joint, position: channel(track.position, 3, positionScale, 'position'),
        rotation: channel(track.rotation, 4, rotationScale, 'rotation'), scale: channel(track.scale, 3, scaleScale, 'scale') };
    });
    const vectorAt = (values: Float64Array, frame: number): AnimationVector => {
      const offset = values.length === 3 ? 0 : frame * 3;
      return { x: values[offset], y: values[offset + 1], z: values[offset + 2] };
    };
    const rotationAt = (values: Float64Array, frame: number): AnimationQuaternion => {
      const offset = values.length === 4 ? 0 : frame * 4;
      return { x: values[offset], y: values[offset + 1], z: values[offset + 2], w: values[offset + 3] };
    };
    const interpolate = (values: Float64Array, a: number, b: number, t: number): AnimationVector => {
      const from = vectorAt(values, a), to = vectorAt(values, b);
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
    };
    const durationMs = source.durationMs;
    let rootMotion: SharedCreatureClip['rootMotion'];
    if (source.rootMotion) {
      if (!joints.has(source.rootMotion.joint)) fail('root motion must reference a rig joint');
      if (!Array.isArray(source.rootMotion.positions)) fail('root motion requires recorded positions');
      const values = channel(source.rootMotion.positions, 3, positionScale, 'root motion')!;
      rootMotion = Object.freeze({ joint: source.rootMotion.joint, sample(timeMs: number) {
        finite(timeMs, -1e12, 1e12, 'root motion time');
        const fractional = Math.max(0, Math.min(durationMs, timeMs)) / durationMs * (count - 1);
        const a = Math.min(count - 2, Math.floor(fractional));
        return interpolate(values, a, a + 1, fractional - a);
      } });
    }
    const clip = registerDecodedAnimationClip(defineAnimationClip({ durationMs, loop: source.loop, sample({ timeMs }) {
      const fractional = timeMs / durationMs * (count - 1), a = Math.min(count - 2, Math.floor(fractional));
      const b = a + 1, t = fractional - a;
      const pose: Record<string, AnimationJointTransform> = Object.create(null);
      for (const track of tracks) {
        const transform: AnimationJointTransform = {};
        if (track.position) transform.position = interpolate(track.position, a, b, t);
        if (track.rotation) transform.rotation = slerpAnimationQuaternions(rotationAt(track.rotation, a), rotationAt(track.rotation, b), t);
        if (track.scale) transform.scale = interpolate(track.scale, a, b, t);
        pose[track.joint] = transform;
      }
      return pose;
    } }));
    return Object.freeze({ ...info.clips[index], clip, ...(rootMotion ? { rootMotion } : {}) });
  });
  return Object.freeze({ ...info, rig, clips: Object.freeze(clips) });
}

let catalog: readonly CreatureAnimationCatalogEntry[] | undefined;
const decoded = new Map<string, SharedCreatureBank>();
/** Lightweight discovery does not decode clip samples. A body family is only a
 * search category; use the selected entry's exact rig for compatible playback. */
export function sharedCreatureCatalog(filter: CreatureAnimationFilter = {}): readonly CreatureAnimationCatalogEntry[] {
  catalog ??= Object.freeze(CREATURE_ANIMATION_DATA.map(metadata));
  if (Object.keys(filter).length === 0) return catalog;
  return Object.freeze(catalog.filter(entry => (!filter.family || entry.family === filter.family)
    && (!filter.tag || entry.tags.includes(filter.tag)) && (!filter.action || entry.actions.includes(filter.action))
   ));
}
/** Cached shared data, with a separate controller/skeleton per visible actor. */
export function sharedCreatureAnimations(bankId: string): SharedCreatureBank {
  name(bankId);
  const existing = decoded.get(bankId); if (existing) return existing;
  const packed = CREATURE_ANIMATION_DATA.find(value => value.id === bankId);
  if (!packed) return fail(`unknown bank ${bankId}; discover available banks with sharedCreatureCatalog()`);
  const bank = decodeCreatureAnimationBank(packed);
  decoded.set(bankId, bank); return bank;
}

export interface CreatureAnimationFrame {
  timeMs: number; action: string; variant?: number; playbackRate?: number; epoch?: string | number;
  /** Change for a new attack/jump/etc. Repeating the same value never restarts. */
  actionId?: string | number;
}
export interface CreatureAnimationResult {
  pose: AnimationPose;
  diagnostics: { clipId: string; requestedAction: string; resolvedAction: string; timeMs: number;
    blendProgress: number; completed: boolean; reset: boolean; warnings: string[] };
}
type Playing = { source: SharedCreatureClip; timeMs: number };

/** Semantic playback and crossfades for sparse creature libraries. Gameplay
 * supplies actions and owns movement. This is deliberately not a trajectory
 * motion matcher: these banks have no verified root-motion/contact annotations. */
export class CreatureAnimationController {
  readonly bank: SharedCreatureBank;
  private readonly blendMs: number;
  private readonly fallbackAction: string;
  private current?: Playing;
  private outgoing?: Playing;
  private outgoingPose?: AnimationPose;
  private blendElapsed = 0;
  private previousTime?: number;
  private previousEpoch?: string | number;
  private previousActionId?: string | number;
  constructor(bank: SharedCreatureBank, options: { blendMs?: number; fallbackAction?: string } = {}) {
    if (!bank?.clips?.length) fail('controller requires a nonempty decoded bank');
    this.bank = bank;
    this.blendMs = finite(options.blendMs ?? 160, 0, 10_000, 'blend duration');
    this.fallbackAction = name(options.fallbackAction ?? 'idle');
  }
  reset(): void {
    this.current = undefined; this.outgoing = undefined; this.outgoingPose = undefined;
    this.blendElapsed = 0; this.previousTime = undefined; this.previousEpoch = undefined;
    this.previousActionId = undefined;
  }
  private pose(): AnimationPose {
    const target = sampleAnimationClip(this.current!.source.clip, this.current!.timeMs);
    const progress = this.blendMs === 0 ? 1 : Math.min(1, this.blendElapsed / this.blendMs);
    if (progress === 1 || (!this.outgoing && !this.outgoingPose)) return target;
    const from = this.outgoing ? sampleAnimationClip(this.outgoing.source.clip, this.outgoing.timeMs) : this.outgoingPose!;
    if (progress === 0) return from;
    const eased = progress * progress * (3 - 2 * progress);
    return blendAnimationPoses(from, target, eased);
  }
  sample(frame: CreatureAnimationFrame): CreatureAnimationResult {
    finite(frame.timeMs, -1e12, 1e12, 'frame time');
    const action = name(frame.action), rate = finite(frame.playbackRate ?? 1, 0, 8, 'playback rate');
    const variant = finite(frame.variant ?? 0, 0, 1e6, 'variant');
    if (!Number.isInteger(variant)) fail('variant must be an integer');
    for (const [label, value] of [['action instance ID', frame.actionId], ['epoch', frame.epoch]] as const) {
      if (value === undefined) continue;
      if (typeof value === 'number') finite(value, -1e12, 1e12, label);
      else if (typeof value !== 'string' || value.length > 256) fail(`invalid ${label}`);
    }
    const warnings: string[] = [];
    const resolve = (requested: string) => this.bank.clips.filter(clip => clip.id === requested || clip.tags.includes(requested));
    let resolvedAction = action, candidates = resolve(action);
    if (!candidates.length) {
      resolvedAction = this.fallbackAction; candidates = resolve(resolvedAction);
      warnings.push(`Action "${action}" is unavailable in ${this.bank.id}; using ${resolvedAction}.`);
      if (!candidates.length) {
        candidates = [this.bank.clips[0]]; resolvedAction = candidates[0].id;
        warnings.push(`Fallback "${this.fallbackAction}" is unavailable; using ${resolvedAction}.`);
      }
    }
    const selected = candidates[variant % candidates.length];
    const reset = this.previousTime === undefined || frame.timeMs < this.previousTime || frame.epoch !== this.previousEpoch;
    const delta = reset ? 0 : frame.timeMs - this.previousTime!;
    if (reset) this.reset();
    if (this.current) this.current.timeMs += delta * rate;
    if (this.outgoing) this.outgoing.timeMs += delta * rate;
    this.blendElapsed += delta;
    if (this.blendElapsed >= this.blendMs) { this.outgoing = undefined; this.outgoingPose = undefined; }
    const restart = frame.actionId !== undefined && frame.actionId !== this.previousActionId;
    if (!this.current || this.current.source.id !== selected.id || restart) {
      const previous = this.current;
      if (previous && this.blendMs > 0) {
        if (this.outgoing || this.outgoingPose) { this.outgoingPose = this.pose(); this.outgoing = undefined; }
        else { this.outgoing = { ...previous }; this.outgoingPose = undefined; }
      }
      this.current = { source: selected, timeMs: 0 };
      this.blendElapsed = previous ? 0 : this.blendMs;
    }
    this.previousTime = frame.timeMs; this.previousEpoch = frame.epoch;
    this.previousActionId = frame.actionId;
    return { pose: this.pose(), diagnostics: { clipId: this.current.source.id, requestedAction: action, resolvedAction,
      timeMs: this.current.timeMs, blendProgress: this.blendMs === 0 ? 1 : Math.min(1, this.blendElapsed / this.blendMs),
      completed: !this.current.source.loop && this.current.timeMs >= this.current.source.durationMs, reset, warnings } };
  }
}
