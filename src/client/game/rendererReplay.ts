import type { ReviewCamera } from '../../shared/gameApi.ts';
import { RENDERER_MIN_SAMPLES, RENDERER_MIN_WARMUP_FRAMES, type RendererConditions } from './rendererSelection.ts';

export interface RendererReplayFrame {
  readonly frame: unknown;
  readonly reviewCamera?: ReviewCamera | null;
}

export interface RendererReplay {
  readonly frames: readonly RendererReplayFrame[];
  readonly warmupFrames: number;
  readonly sampleFrames: number;
  readonly checkpointIndices: readonly number[];
  readonly conditions: RendererConditions;
}

export interface RendererReplayViewport {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly visible: boolean;
}

export interface RendererReplayOptions {
  readonly now?: () => number;
  readonly maxBytes?: number;
  readonly maxCopyMs?: number;
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_COPY_MS = 1.5;
const FRAME_COUNT = RENDERER_MIN_WARMUP_FRAMES + RENDERER_MIN_SAMPLES;
const MAX_NODES = 65_536;

/** Content fingerprint for invalidation, never authorization or cryptographic
 * integrity. Two independent 32-bit accumulators keep this synchronous helper
 * cheap enough to use before a match without browser GPU or storage access. */
class Fingerprint {
  private first = 0x811c9dc5;
  private second = 0x85ebca77;
  private length = 0;
  add(value: string): void {
    this.length += value.length;
    for (let index = 0; index < value.length; index++) {
      const char = value.charCodeAt(index);
      this.first = Math.imul(this.first ^ char, 0x01000193);
      this.second = Math.imul(this.second ^ char, 0xc2b2ae3d);
    }
  }
  get value(): string {
    return (this.first >>> 0).toString(16).padStart(8, '0')
      + (this.second >>> 0).toString(16).padStart(8, '0') + ':' + this.length;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Stable match context, independent of current poses, health, world and phase.
 * Canonical keys make a new but equivalent tuning/model object share a key;
 * different mode, tuning, roster size, activity or model/class choices invalidate
 * the old replay. Player order is retained because views can use stable seats. */
export function rendererReplayQuality(frame: unknown): string | null {
  if (!record(frame) || !record(frame.tuning) || !Array.isArray(frame.players) || frame.players.length > 256) return null;
  const fingerprint = new Fingerprint();
  let nodes = 0, characters = 0;
  const add = (value: string): void => {
    characters += value.length;
    if (characters > 32_768) throw new Error('Quality context is too large.');
    fingerprint.add(value);
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 4_096 || depth > 12) throw new Error('Quality context is too complex.');
    if (value === null || value === undefined) { add(value === null ? 'null;' : 'undefined;'); return; }
    if (typeof value === 'string') { add('s' + value.length + ':' + value); return; }
    if (typeof value === 'number' && Number.isFinite(value)) { add('n' + value + ';'); return; }
    if (typeof value === 'boolean') { add(value ? 'true;' : 'false;'); return; }
    if (typeof value !== 'object') throw new Error('Quality context must be plain data.');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error('Quality context must be plain data.');
    const keys = Object.keys(value).sort();
    if (keys.length > 4_096) throw new Error('Quality context is too complex.');
    add(array ? '[' + value.length + ':' : '{');
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property)) throw new Error('Quality context contains an accessor.');
      add('k' + key.length + ':' + key); visit(property.value, depth + 1);
    }
    add(array ? ']' : '}');
  };
  try {
    const roster = frame.players.map(player => {
      if (!record(player)) throw new Error('Replay participants must be plain data.');
      return { active: player.active !== false, modelId: player.modelId ?? '', classId: player.classId ?? '' };
    });
    visit({ mode: frame.mode ?? 'duel', tuning: frame.tuning, playerModels: frame.playerModels ?? [], roster }, 0);
    return 'renderer-quality-1:' + fingerprint.value;
  } catch { return null; }
}

/** Captures one short, exact sequence only when the host needs calibration.
 * It never renders, persists data, changes frame timing, or mutates live input.
 * The host must call observe only for frames accepted by its live worker, and
 * replay the result at a subsequent loading boundary, never during the fight. */
export class RendererReplayRecorder {
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxCopyMs: number;
  private readonly frames: RendererReplayFrame[] = [];
  private readonly fingerprint = new Fingerprint();
  private readonly shapes = new WeakMap<object, { keys: string[]; prototype: object | null }>();
  private capturedBytes = 0;
  private context: RendererReplayViewport | null = null;
  private quality: string | null = null;
  private completed: RendererReplay | null = null;
  private currentStatus: 'waiting' | 'recording' | 'ready' | 'abandoned' = 'waiting';
  private failure: string | null = null;
  private lastTime: number | null = null;

  constructor(options: RendererReplayOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.maxBytes = Number.isFinite(options.maxBytes) ? Math.min(MAX_BYTES, Math.max(0, options.maxBytes!)) : MAX_BYTES;
    this.maxCopyMs = Number.isFinite(options.maxCopyMs) ? Math.min(MAX_COPY_MS, Math.max(0, options.maxCopyMs!)) : MAX_COPY_MS;
  }

  get replay(): RendererReplay | null { return this.completed; }
  get workloadHash(): string | null { return this.completed?.conditions.workloadHash ?? null; }
  get qualityHash(): string | null { return this.quality; }
  get status(): 'waiting' | 'recording' | 'ready' | 'abandoned' { return this.currentStatus; }
  get reason(): string | null { return this.failure; }

  private abandon(reason: string): void {
    this.frames.length = 0;
    this.capturedBytes = 0;
    this.context = null;
    this.quality = null;
    this.failure = reason;
    this.currentStatus = 'abandoned';
  }

  observe(input: RendererReplayFrame, viewport: RendererReplayViewport): void {
    if (this.currentStatus === 'ready' || this.currentStatus === 'abandoned') return;
    const frame = input.frame;
    const valid = record(frame) && frame.phase === 'fighting' && record(frame.world)
      && Array.isArray(frame.players) && frame.players.some(player => record(player) && player.active !== false)
      && typeof frame.now === 'number' && Number.isFinite(frame.now)
      && typeof frame.dt === 'number' && Number.isFinite(frame.dt) && frame.dt > 0
      && viewport.visible && Number.isInteger(viewport.width) && viewport.width > 0
      && Number.isInteger(viewport.height) && viewport.height > 0
      && Number.isFinite(viewport.pixelRatio) && viewport.pixelRatio > 0;
    if (!valid) {
      if (this.currentStatus === 'recording') this.abandon('Gameplay or viewport changed during replay capture.');
      return;
    }
    const frameTime = frame.now as number;
    const started = this.now();
    const quality = rendererReplayQuality(frame);
    if (!quality) { this.abandon('The game context cannot be captured within the replay limits.'); return; }
    if (this.context && (quality !== this.quality || viewport.width !== this.context.width
      || viewport.height !== this.context.height || viewport.pixelRatio !== this.context.pixelRatio)) {
      this.abandon('Game quality or viewport changed during replay capture.'); return;
    }
    if (this.lastTime !== null && frameTime <= this.lastTime) {
      this.abandon('The accepted frame timeline changed during replay capture.'); return;
    }
    let bytes = 0, nodes = 0;
    const seen = new Map<object, { value: unknown; id: number }>();
    const active = new Set<object>();
    const claimed = new Set<object>();
    const reserve = (amount: number): void => {
      bytes += amount;
      if (this.capturedBytes + bytes > this.maxBytes) throw new Error('Replay capture exceeded its memory budget.');
    };
    const copy = (value: unknown, previous: unknown, depth = 0): unknown => {
      if (depth > 32) throw new Error('Replay input is too deeply nested.');
      if (++nodes > MAX_NODES || nodes % 64 === 0 && this.now() - started > this.maxCopyMs)
        throw new Error('Replay capture exceeded its copy budget.');
      if ((value === null || typeof value !== 'object') && !Object.is(value, previous)) reserve(16);
      if (value === null || value === undefined) { this.fingerprint.add(value === null ? 'null;' : 'undefined;'); return value; }
      if (typeof value === 'string') {
        if (value !== previous) reserve(value.length * 2);
        this.fingerprint.add('s' + value.length + ':' + value); return value;
      }
      if (typeof value === 'number' && Number.isFinite(value)) { this.fingerprint.add('n' + value + ';'); return value; }
      if (typeof value === 'boolean') { this.fingerprint.add(value ? 'true;' : 'false;'); return value; }
      if (typeof value !== 'object') throw new Error('Replay input must be plain data.');
      if (active.has(value)) throw new Error('Replay input contains a cyclic object.');
      const existing = seen.get(value);
      if (existing) { this.fingerprint.add('ref' + existing.id + ';'); return existing.value; }
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      if (!array && prototype !== Object.prototype && prototype !== null) throw new Error('Replay input must be plain data.');
      const keys = Object.keys(value);
      const oldShape = previous && typeof previous === 'object' ? this.shapes.get(previous) : undefined;
      const reusable = oldShape !== undefined && !claimed.has(previous as object)
        && oldShape.prototype === prototype && Array.isArray(previous) === array
        && (!array || value.length === (previous as unknown[]).length)
        && keys.length === oldShape.keys.length && keys.every((key, index) => key === oldShape.keys[index]);
      let result = reusable ? previous as Record<string, unknown> : null;
      // Snapshot objects are private, never live game objects. Share unchanged
      // branches across frames, comparing values again even if the game mutates
      // an object in place. Allocate only the path to an actual changed value.
      const allocate = (): Record<string, unknown> => {
        reserve(80 + keys.reduce((size, key) => size + 24 + key.length * 2, 0) + (array ? value.length * 8 : 0));
        const created = array ? new Array(value.length) : Object.create(prototype);
        if (reusable) Object.defineProperties(created, Object.getOwnPropertyDescriptors(previous));
        this.shapes.set(created, { keys, prototype });
        return created;
      };
      if (!reusable) result = allocate();
      active.add(value);
      this.fingerprint.add(array ? '[' + value.length + ':' : '{');
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !('value' in property)) throw new Error('Replay input contains an accessor.');
        this.fingerprint.add('k' + key.length + ':' + key);
        const oldValue = reusable ? (previous as Record<string, unknown>)[key] : undefined;
        const next = copy(property.value, oldValue, depth + 1);
        if (!reusable || !Object.is(next, oldValue)) {
          if (result === previous) result = allocate();
          if (key === '__proto__') Object.defineProperty(result, key, { value: next, writable: true, enumerable: true, configurable: true });
          else result![key] = next;
        }
      }
      active.delete(value);
      claimed.add(result!);
      seen.set(value, { value: result, id: seen.size });
      this.fingerprint.add(array ? ']' : '}');
      return result;
    };
    try {
      const snapshot = copy(input, this.frames.at(-1)) as RendererReplayFrame;
      if (this.now() - started > this.maxCopyMs) throw new Error('Replay capture exceeded its copy budget.');
      this.capturedBytes += bytes;
      this.frames.push(snapshot);
      this.lastTime = frameTime;
      this.quality = quality;
      this.context ??= { ...viewport };
      this.currentStatus = 'recording';
      if (this.frames.length === FRAME_COUNT) {
        this.completed = Object.freeze({ frames: Object.freeze(this.frames.slice()),
          warmupFrames: RENDERER_MIN_WARMUP_FRAMES, sampleFrames: RENDERER_MIN_SAMPLES,
          checkpointIndices: Object.freeze([RENDERER_MIN_WARMUP_FRAMES,
            RENDERER_MIN_WARMUP_FRAMES + Math.floor(RENDERER_MIN_SAMPLES / 2) - 1, FRAME_COUNT - 1]),
          conditions: Object.freeze({ width: viewport.width, height: viewport.height, pixelRatio: viewport.pixelRatio,
            qualityHash: quality, workloadHash: 'renderer-workload-1:' + this.fingerprint.value }) });
        this.currentStatus = 'ready';
      }
    } catch (error) { this.abandon(error instanceof Error ? error.message : 'Replay capture failed.'); }
  }
}
