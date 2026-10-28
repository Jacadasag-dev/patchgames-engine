/** Optional host-side recording of predictable water effects. A clip contains
 * accepted surfaces, not solver impulses. Interactive playback is valid only
 * while the caller's complete environment/configuration signatures match. */
export interface WaterEffectSignature { environment: string; configuration: string }
export interface WaterEffectCheckpoint { time: number }
export interface WaterEffectSurface {
  positions: Float32Array; normals: Float32Array; indices?: Uint16Array | Uint32Array;
  colors?: Float32Array; uvs?: Float32Array; vertexKeys?: Float64Array; cellIds?: Uint32Array;
  /** Displayed waterBody pool patches: 12 finite values per grid cell. */
  patches?: Float32Array;
  /** Optional smooth center/corner normals: 16 finite values per grid cell. */
  normalPatches?: Float32Array;
  /** Optional current presentation: flow X/Z, terrain contact, depth per vertex. */
  flowData?: Float32Array;
  /** Water body center/corner flow presentation, five RGBA controls per cell. */
  flowPatches?: Float32Array;
  /** Optional baked presentation default; physical velocities remain recorded. */
  currents?:boolean;
  spacing?: number; stats?: object;
}
export interface WaterEffectFrame<C extends WaterEffectCheckpoint, S extends WaterEffectSurface> {
  time: number; surface: S; checkpoint?: C;
}
export interface WaterEffectClip<C extends WaterEffectCheckpoint = WaterEffectCheckpoint, S extends WaterEffectSurface = WaterEffectSurface> {
  readonly version: 'water-effect-v1'; readonly mode: 'interactive' | 'cosmetic';
  readonly signature: Readonly<WaterEffectSignature>; readonly frames: readonly WaterEffectFrame<C, S>[];
  readonly startTime: number; readonly endTime: number;
  /** Typed-array bytes plus conservative UTF-16 JSON storage for plain data;
   * runtime object overhead is additionally bounded by frame/vertex limits. */
  readonly bytes: number;
}
export interface WaterEffectRecorderOptions<C extends WaterEffectCheckpoint> {
  mode: 'interactive' | 'cosmetic'; signature: WaterEffectSignature;
  maxFrames?: number; maxBytes?: number; maxDuration?: number;
  /** Validate the authoritative water body and coupled-world snapshot. */
  validateCheckpoint?: (checkpoint: C) => void;
}
export type WaterEffectStopReason = 'environment-changed' | 'configuration-changed' | 'interaction' | 'time-reversed' | 'complete';
export interface WaterEffectBlend {
  /** Buffers use the CURRENT surface topology. Unmatched vertices stay put;
   * changed topology appears only when its accepted frame is reached. */
  toPositions: Float32Array; toNormals: Float32Array; alpha: number; matchedVertices: number;
  toFlowData?:Float32Array;
}
export type WaterEffectSample<C extends WaterEffectCheckpoint, S extends WaterEffectSurface> =
  | { kind: 'frame'; surface: S; frameIndex: number; time: number; physicalTime: number; checkpoint?: C; blend?: WaterEffectBlend; cosmetic: boolean }
  | { kind: 'live'; reason: WaterEffectStopReason; checkpoint: C; resumeTime: number; requestedTime: number; replayImpulses: false }
  | { kind: 'stopped'; reason: WaterEffectStopReason };

const finite = (v: number, name: string) => { if (!Number.isFinite(v)) throw new Error(`Invalid water effect ${name}`); };
function signature(value: WaterEffectSignature): void {
  if (!value || [value.environment, value.configuration].some(v => typeof v !== 'string' || !v.length || v.length > 4096)) throw new Error('Water effect requires explicit environment and configuration signatures');
}
function limit(value: number | undefined, fallback: number, maximum: number, name: string, integer = true): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || result > maximum || (integer && !Number.isInteger(result))) throw new Error(`Invalid water effect ${name}`);
  return result;
}
/** Checkpoint data must be portable, finite plain data, with bounded depth and
 * node count. Reject functions, cyclic references and hidden class state. */
function plainBytes(value: unknown): number {
  const active = new Set<object>(); let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 1000000 || depth > 32) throw new Error('Water effect plain data exceeds its structural budget');
    if (item === null || item === undefined || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { finite(item, 'plain data'); return; }
    if (typeof item !== 'object' || item === undefined || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw new Error('Water effect checkpoints and metadata must be plain data');
    if (active.has(item)) throw new Error('Water effect plain data is cyclic');
    active.add(item); for (const child of Object.values(item)) visit(child, depth + 1); active.delete(item);
  }
  visit(value, 0); return (JSON.stringify(value)?.length ?? 0) * 2;
}
function surfaceBytes(surface: WaterEffectSurface): number {
  if (!surface || !(surface.positions instanceof Float32Array) || !(surface.normals instanceof Float32Array)
    || (surface.indices !== undefined && !(surface.indices instanceof Uint16Array || surface.indices instanceof Uint32Array))) throw new Error('Invalid water effect surface buffers');
  const vertices = surface.positions.length / 3;
  if (!Number.isInteger(vertices) || vertices > 600000 || surface.normals.length !== surface.positions.length
    || (surface.indices ? surface.indices.length % 3 || surface.indices.length > 1200000 : vertices % 3)) throw new Error('Water effect surface exceeds its geometry budget');
  let bytes = 0;
  for (const [key, value] of Object.entries(surface)) {
    if (ArrayBuffer.isView(value)) {
      if (!['positions', 'normals', 'indices', 'colors', 'uvs', 'vertexKeys', 'cellIds', 'patches', 'normalPatches','flowData','flowPatches'].includes(key)) throw new Error('Unknown water effect surface buffer');
      bytes += value.byteLength;
      for (const n of value as unknown as Iterable<number>) finite(n, 'surface value');
    } else if (value !== undefined) bytes += plainBytes(value);
  }
  if (surface.colors && (!(surface.colors instanceof Float32Array) || ![vertices * 3, vertices * 4].includes(surface.colors.length))) throw new Error('Invalid water effect colors');
  if (surface.uvs && (!(surface.uvs instanceof Float32Array) || surface.uvs.length !== vertices * 2)) throw new Error('Invalid water effect UVs');
  if(surface.flowData!==undefined&&(!(surface.flowData instanceof Float32Array)||surface.flowData.length!==vertices*4))throw new Error('Invalid water effect current data');
  if(surface.currents!==undefined&&typeof surface.currents!=='boolean')throw new Error('Invalid water effect currents flag');
  if(surface.flowPatches!==undefined&&(!(surface.flowPatches instanceof Float32Array)||!surface.patches||surface.flowPatches.length!==surface.patches.length/12*20))throw new Error('Invalid water effect current patches');
  if (surface.vertexKeys && (!(surface.vertexKeys instanceof Float64Array) || surface.vertexKeys.length !== vertices || surface.vertexKeys.some(v => !Number.isSafeInteger(v) || v < -1))) throw new Error('Invalid water effect vertex keys');
  if (surface.vertexKeys) { const keys = new Set<number>(); for (const key of surface.vertexKeys) if (key >= 0) { if (keys.has(key)) throw new Error('Duplicate water effect vertex key'); keys.add(key); } }
  if (surface.cellIds && !(surface.cellIds instanceof Uint32Array)) throw new Error('Invalid water effect cell identifiers');
  if (surface.patches !== undefined) {
    if (!(surface.patches instanceof Float32Array) || surface.patches.length === 0 || surface.patches.length % 12 || surface.patches.length > 16384 * 12)
      throw new Error('Invalid water effect water body patches');
    if (surface.cellIds?.some(id => id >= surface.patches!.length / 12)) throw new Error('Invalid water effect water body patch cell identifier');
  }
  if (surface.normalPatches !== undefined && (!(surface.normalPatches instanceof Float32Array)
    || !surface.patches || surface.normalPatches.length !== surface.patches.length / 12 * 16))
    throw new Error('Invalid water effect water body normal patches');
  for (const index of surface.indices ?? []) if (index >= vertices) throw new Error('Invalid water effect triangle index');
  const spacing = surfaceSpacing(surface);
  if (spacing !== undefined && (!Number.isFinite(spacing) || spacing <= 0)) throw new Error('Invalid water effect spacing');
  return bytes;
}
function surfaceSpacing(surface: WaterEffectSurface): number | undefined { return surface.spacing ?? (surface.stats as { spacing?: number } | undefined)?.spacing; }
/** Copy just the validated view ranges. structuredClone(view) would retain an
 * arbitrarily large backing buffer hidden behind a small accepted subarray. */
function copySurface<S extends WaterEffectSurface>(surface: S): S {
  const plain: Record<string, unknown> = {}, arrays: Record<string, Float32Array | Float64Array | Uint16Array | Uint32Array> = {};
  for (const [key, value] of Object.entries(surface)) {
    if (ArrayBuffer.isView(value)) arrays[key] = (value as Float32Array | Float64Array | Uint16Array | Uint32Array).slice();
    else plain[key] = value;
  }
  return Object.assign(structuredClone(plain), arrays) as S;
}

export function createWaterEffectRecorder<C extends WaterEffectCheckpoint = WaterEffectCheckpoint, S extends WaterEffectSurface = WaterEffectSurface>(options: WaterEffectRecorderOptions<C>) {
  signature(options.signature);
  if (!['interactive', 'cosmetic'].includes(options.mode)) throw new Error('Invalid water effect mode');
  const maxFrames = limit(options.maxFrames, 240, 4096, 'frame budget');
  const maxBytes = limit(options.maxBytes, 64 * 1024 * 1024, 256 * 1024 * 1024, 'byte budget');
  const maxDuration = limit(options.maxDuration, 30, 600, 'duration', false);
  const mode = options.mode, validateCheckpoint = options.validateCheckpoint;
  const frames: WaterEffectFrame<C, S>[] = []; const capturedSignature = { ...options.signature }; let bytes = plainBytes(capturedSignature), finished = false;
  return {
    /** Copies accepted input. Failed writes leave the recorder unchanged. Every
     * interactive frame needs a same-time physical checkpoint; cosmetic clips
     * deliberately retain no physical state. */
    record(frame: WaterEffectFrame<C, S>): void {
      if (finished) throw new Error('Water effect recorder is finished');
      finite(frame.time, 'frame time');
      if (frame.time < 0 || (frames.length && frame.time <= frames[frames.length - 1].time)) throw new Error('Water effect frame times must increase');
      if (frames.length >= maxFrames || (frames.length && frame.time - frames[0].time > maxDuration)) throw new Error('Water effect recording exceeds frame or duration budget');
      let added = surfaceBytes(frame.surface) + 8;
      if (mode === 'interactive') {
        if (!frame.checkpoint || frame.checkpoint.time !== frame.time) throw new Error('Interactive water frames require a same-time physical checkpoint');
        added += plainBytes(frame.checkpoint); validateCheckpoint?.(frame.checkpoint);
      } else if (frame.checkpoint !== undefined) throw new Error('Cosmetic water effects cannot contain physical checkpoints');
      if (bytes + added > maxBytes) throw new Error('Water effect recording exceeds byte budget');
      frames.push(Object.freeze({ time: frame.time, surface: copySurface(frame.surface), ...(frame.checkpoint === undefined ? {} : { checkpoint: structuredClone(frame.checkpoint) }) })); bytes += added;
    },
    inspection(): { frames: number; bytes: number; duration: number } { return { frames: frames.length, bytes, duration: frames.length ? frames[frames.length - 1].time - frames[0].time : 0 }; },
    /** Clip arrays become caller-owned read-only assets. Do not transfer/detach
     * or mutate them while a player uses the clip. */
    finish(): WaterEffectClip<C, S> {
      if (finished || !frames.length) throw new Error('Water effect recorder is finished or empty');
      finished = true;
      return Object.freeze({ version: 'water-effect-v1', mode, signature: Object.freeze(capturedSignature), frames: Object.freeze(frames), startTime: frames[0].time, endTime: frames[frames.length - 1].time, bytes });
    },
  };
}

function correspondence(current: WaterEffectSurface, next: WaterEffectSurface): Omit<WaterEffectBlend, 'alpha'> | undefined {
  const spacing = surfaceSpacing(current);
  if (!spacing || spacing !== surfaceSpacing(next) || !current.vertexKeys || !next.vertexKeys) return undefined;
  const lookup = new Map<number, number>();
  for (let i = 0; i < next.vertexKeys.length; i++) if (next.vertexKeys[i] >= 0) lookup.set(next.vertexKeys[i], i);
  const toPositions = current.positions.slice(), toNormals = current.normals.slice(); let matchedVertices = 0;
  const toFlowData=current.flowData&&next.flowData?current.flowData.slice():undefined;
  for (let i = 0; i < current.vertexKeys.length; i++) {
    const key = current.vertexKeys[i], nextIndex = key < 0 ? undefined : lookup.get(key); if (nextIndex === undefined) continue;
    const a = i * 3, b = nextIndex * 3;
    const distance2 = (current.positions[a] - next.positions[b]) ** 2 + (current.positions[a + 1] - next.positions[b + 1]) ** 2 + (current.positions[a + 2] - next.positions[b + 2]) ** 2;
    const dot = current.normals[a] * next.normals[b] + current.normals[a + 1] * next.normals[b + 1] + current.normals[a + 2] * next.normals[b + 2];
    if (distance2 > 4 * spacing * spacing || dot < .25) continue;
    for (let axis = 0; axis < 3; axis++) { toPositions[a + axis] = next.positions[b + axis]; toNormals[a + axis] = next.normals[b + axis]; }
    if(toFlowData)for(let component=0;component<4;component++)toFlowData[i*4+component]=next.flowData![nextIndex*4+component];
    matchedVertices++;
  }
  return { toPositions, toNormals, matchedVertices,...(toFlowData?{toFlowData}:{}) };
}

export function createWaterEffectPlayback<C extends WaterEffectCheckpoint, S extends WaterEffectSurface>(clip: WaterEffectClip<C, S>, options: { validateCheckpoint?: (checkpoint: C) => void } = {}) {
  if (clip.version !== 'water-effect-v1' || !['interactive', 'cosmetic'].includes(clip.mode) || !clip.frames.length || clip.frames.length > 4096
    || !Number.isFinite(clip.bytes) || clip.bytes > 256 * 1024 * 1024 || clip.startTime !== clip.frames[0].time || clip.endTime !== clip.frames[clip.frames.length - 1].time
    || clip.endTime - clip.startTime > 600) throw new Error('Invalid water effect clip');
  signature(clip.signature);
  let measuredBytes = plainBytes(clip.signature), previousTime = -1;
  for (const frame of clip.frames) {
    finite(frame.time, 'frame time'); if (frame.time < 0 || frame.time <= previousTime) throw new Error('Invalid water effect frame sequence'); previousTime = frame.time;
    measuredBytes += surfaceBytes(frame.surface) + 8;
    if (clip.mode === 'interactive') {
      if (!frame.checkpoint || frame.checkpoint.time !== frame.time) throw new Error('Interactive water frames require a same-time physical checkpoint');
      measuredBytes += plainBytes(frame.checkpoint); options.validateCheckpoint?.(frame.checkpoint);
    } else if (frame.checkpoint !== undefined) throw new Error('Cosmetic water effects cannot contain physical checkpoints');
    if (measuredBytes > 256 * 1024 * 1024) throw new Error('Water effect clip exceeds byte budget');
  }
  if (clip.bytes !== measuredBytes) throw new Error('Invalid water effect clip byte count');
  let index = 0, lastTime = clip.startTime, terminal: WaterEffectStopReason | undefined, transitionIndex = -1;
  let transition: Omit<WaterEffectBlend, 'alpha'> | undefined;
  return {
    /** Signatures must include terrain/obstacles, source setup, authored physics
     * and initial world state. Hosts invalidate BEFORE applying interactions.
     * No contacts or impulses are replayed. On a live handoff restore once and
     * resume from resumeTime; retain external changes that caused invalidation.
     * The requested display time is not permission to replay past world effects. */
    sample(time: number, context: { signature: WaterEffectSignature; interaction?: boolean }): WaterEffectSample<C, S> {
      finite(time, 'playback time'); signature(context.signature);
      if (terminal) return { kind: 'stopped', reason: terminal };
      const reversed = time < lastTime, physicalTime = reversed ? lastTime : time;
      while (index + 1 < clip.frames.length && clip.frames[index + 1].time <= physicalTime) index++;
      const reason: WaterEffectStopReason | undefined = context.signature.configuration !== clip.signature.configuration ? 'configuration-changed'
        : context.signature.environment !== clip.signature.environment ? 'environment-changed' : context.interaction ? 'interaction' : reversed ? 'time-reversed' : time > clip.endTime ? 'complete' : undefined;
      if (reason) {
        terminal = reason; transition = undefined;
        if (clip.mode === 'interactive') {
          const checkpoint = clip.frames[index].checkpoint;
          if (!checkpoint) throw new Error('Interactive water clip has no physical checkpoint');
          return { kind: 'live', reason, checkpoint: structuredClone(checkpoint), resumeTime: checkpoint.time, requestedTime: time, replayImpulses: false };
        }
        return { kind: 'stopped', reason };
      }
      lastTime = time;
      const frame = clip.frames[index], next = clip.frames[index + 1];
      if (transitionIndex !== index) { transitionIndex = index; transition = next ? correspondence(frame.surface, next.surface) : undefined; }
      const alpha = next ? Math.max(0, Math.min(1, (time - frame.time) / (next.time - frame.time))) : 0;
      return { kind: 'frame', surface: frame.surface, frameIndex: index, time, physicalTime: frame.time, checkpoint: frame.checkpoint,
        blend: transition ? { ...transition, alpha } : undefined, cosmetic: clip.mode === 'cosmetic' };
    },
  };
}

/** Optional CPU materialization for hosts without a presentation shader. Reuse
 * output arrays to avoid allocation; sample() itself never copies mesh buffers. */
export function interpolateWaterEffectSurface<C extends WaterEffectCheckpoint, S extends WaterEffectSurface>(sample: Extract<WaterEffectSample<C, S>, { kind: 'frame' }>, output?: { positions: Float32Array; normals: Float32Array }) {
  const { surface, blend } = sample;
  const result = output ?? { positions: new Float32Array(surface.positions.length), normals: new Float32Array(surface.normals.length) };
  const protectedBuffers = [surface.positions.buffer, surface.normals.buffer, blend?.toPositions.buffer, blend?.toNormals.buffer];
  if (result.positions.length !== surface.positions.length || result.normals.length !== surface.normals.length || result.positions.buffer === result.normals.buffer
    || protectedBuffers.includes(result.positions.buffer) || protectedBuffers.includes(result.normals.buffer)) throw new Error('Invalid water effect interpolation output');
  const alpha = blend?.alpha ?? 0;
  for (let i = 0; i < surface.positions.length; i++) {
    result.positions[i] = surface.positions[i] + ((blend?.toPositions[i] ?? surface.positions[i]) - surface.positions[i]) * alpha;
    result.normals[i] = surface.normals[i] + ((blend?.toNormals[i] ?? surface.normals[i]) - surface.normals[i]) * alpha;
  }
  for (let i = 0; i < result.normals.length; i += 3) { const length = Math.hypot(result.normals[i], result.normals[i + 1], result.normals[i + 2]) || 1; for (let a = 0; a < 3; a++) result.normals[i + a] /= length; }
  return result;
}
