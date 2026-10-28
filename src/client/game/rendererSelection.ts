/** Selection is host-owned. Games cannot qualify an alternative renderer by
 * supplying these values; the engine supplies compatibility evidence. */
export type RendererBackend = 'webgl' | 'webgpu';
export type RendererEvidenceStatus = 'passed' | 'failed' | 'pending' | 'unsupported';

export interface RendererCompatibilityEvidence {
  readonly revision: string;
  readonly compatibility: RendererEvidenceStatus;
  readonly visualParity: RendererEvidenceStatus;
  readonly stability: RendererEvidenceStatus;
}

export interface RendererConditions {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly qualityHash: string;
  readonly workloadHash: string;
}

/** Sequential CPU+GPU completion latency, including worker transport. This is
 * a drained-queue loading comparison, not GPU presentation FPS. */
export interface RendererMeasurement {
  readonly frameTimesMs: readonly number[];
  readonly warmupFrames: number;
  readonly conditions: RendererConditions;
  /** Cold frames are excluded from the speed score but must fit live startup.
   * Optional only for older callers; engine calibration always records both. */
  readonly startupMaxFrameMs?: number;
  readonly startupPostFirstMaxMs?: number;
}

export interface RendererCandidate {
  readonly backend: RendererBackend;
  readonly available: boolean;
  readonly evidence: RendererCompatibilityEvidence;
  readonly measurement?: RendererMeasurement;
}

export interface RendererFrameTimeMetrics {
  readonly sampleCount: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly jankCount: number;
  readonly stallCount: number;
  readonly jankRatio: number;
  readonly stallRatio: number;
  readonly startupMaxFrameMs?: number;
  readonly startupPostFirstMaxMs?: number;
}

export type RendererSelectionReason =
  | 'no-compatible-renderer'
  | 'only-compatible-renderer'
  | 'insufficient-measurements'
  | 'mismatched-render-conditions'
  | 'webgpu-startup-regression'
  | 'webgpu-tail-regression'
  | 'webgpu-not-meaningfully-faster'
  | 'webgpu-faster';

export interface RendererSelectionDecision {
  readonly backend: RendererBackend | null;
  readonly reason: RendererSelectionReason;
  readonly metrics: Partial<Record<RendererBackend, RendererFrameTimeMetrics>>;
}

export const RENDERER_SELECTION_POLICY_VERSION = '3';
export const RENDERER_MIN_WARMUP_FRAMES = 60;
export const RENDERER_MIN_SAMPLES = 120;
export const RENDERER_SELECTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RENDERER_SELECTION_CACHE_MAX_ENTRIES = 16;
export const RENDERER_SELECTION_CACHE_STORAGE_KEY = 'patchgames.renderer-selection.v3';
// A newly created live renderer only receives a long allowance for its first
// draw. Later cold variants must fit the ordinary runtime/watchdog bound.
export const RENDERER_MAX_FIRST_FRAME_MS = 12000;
export const RENDERER_MAX_POST_FIRST_FRAME_MS = 3000;
const JANK_THRESHOLD_MS = 2 * 1000 / 240;
const STALL_THRESHOLD_MS = 50;
const MAX_MEASUREMENT_SAMPLES = 10_000;

export function isRendererEligible(candidate: RendererCandidate): boolean {
  const evidence = candidate.evidence;
  return candidate.available && nonempty(evidence.revision)
    && evidence.compatibility === 'passed' && evidence.visualParity === 'passed'
    && evidence.stability === 'passed';
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function validResolution(value: { width: unknown; height: unknown; pixelRatio: unknown }): boolean {
  return Number.isInteger(value.width) && Number(value.width) > 0 && Number(value.width) <= 32_768
    && Number.isInteger(value.height) && Number(value.height) > 0 && Number(value.height) <= 32_768
    && typeof value.pixelRatio === 'number' && Number.isFinite(value.pixelRatio)
    && value.pixelRatio > 0 && value.pixelRatio <= 16;
}

function validConditions(value: RendererConditions): boolean {
  return validResolution(value) && nonempty(value.qualityHash) && nonempty(value.workloadHash);
}

function sameConditions(left: RendererConditions, right: RendererConditions): boolean {
  return left.width === right.width && left.height === right.height
    && left.pixelRatio === right.pixelRatio && left.qualityHash === right.qualityHash
    && left.workloadHash === right.workloadHash;
}

function validStartupTiming(value: { startupMaxFrameMs?: unknown; startupPostFirstMaxMs?: unknown }): boolean {
  const first = value.startupMaxFrameMs, later = value.startupPostFirstMaxMs;
  if (first === undefined && later === undefined) return true;
  return typeof first === 'number' && Number.isFinite(first) && first > 0 && first <= 60_000
    && typeof later === 'number' && Number.isFinite(later) && later >= 0 && later <= first;
}

function startupRegression(metrics: RendererFrameTimeMetrics): boolean {
  return metrics.startupMaxFrameMs !== undefined && metrics.startupMaxFrameMs > RENDERER_MAX_FIRST_FRAME_MS
    || metrics.startupPostFirstMaxMs !== undefined && metrics.startupPostFirstMaxMs > RENDERER_MAX_POST_FIRST_FRAME_MS;
}

export function summarizeRendererMeasurement(measurement: RendererMeasurement): RendererFrameTimeMetrics | null {
  const values = measurement.frameTimesMs;
  if (!Number.isInteger(measurement.warmupFrames) || measurement.warmupFrames < RENDERER_MIN_WARMUP_FRAMES
    || !validConditions(measurement.conditions) || !validStartupTiming(measurement) || values.length < RENDERER_MIN_SAMPLES
    || values.length > MAX_MEASUREMENT_SAMPLES
    || values.some(value => !Number.isFinite(value) || value <= 0 || value > 60_000)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  const jankCount = values.filter(value => value > JANK_THRESHOLD_MS).length;
  const stallCount = values.filter(value => value >= STALL_THRESHOLD_MS).length;
  return {
    sampleCount: values.length,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    maxMs: sorted[sorted.length - 1]!, jankCount, stallCount,
    jankRatio: jankCount / values.length, stallRatio: stallCount / values.length,
    ...(measurement.startupMaxFrameMs === undefined ? {} : {
      startupMaxFrameMs: measurement.startupMaxFrameMs, startupPostFirstMaxMs: measurement.startupPostFirstMaxMs,
    }),
  };
}

function compareMetrics(baseline: RendererFrameTimeMetrics, alternative: RendererFrameTimeMetrics): RendererSelectionReason {
  if (startupRegression(alternative)) return 'webgpu-startup-regression';
  if (alternative.p95Ms > baseline.p95Ms * 1.02 || alternative.p99Ms > baseline.p99Ms * 1.02
    || alternative.jankRatio > baseline.jankRatio || alternative.stallRatio > baseline.stallRatio
    || (alternative.maxMs >= STALL_THRESHOLD_MS && alternative.maxMs > baseline.maxMs * 1.02)) return 'webgpu-tail-regression';
  return alternative.meanMs > baseline.meanMs * 0.9 ? 'webgpu-not-meaningfully-faster' : 'webgpu-faster';
}

/** Alternatives must win by at least 10% in average work and preserve tail
 * latency. A 2% percentile tolerance avoids switching on tiny timing noise;
 * increased jank or stall frequency still disqualifies an apparent win. */
export function selectRenderer(candidates: readonly RendererCandidate[]): RendererSelectionDecision {
  const gl = candidates.find(candidate => candidate.backend === 'webgl' && isRendererEligible(candidate));
  const gpu = candidates.find(candidate => candidate.backend === 'webgpu' && isRendererEligible(candidate));
  const metrics: RendererSelectionDecision['metrics'] = {};
  const glMetrics = gl?.measurement && summarizeRendererMeasurement(gl.measurement);
  const gpuMetrics = gpu?.measurement && summarizeRendererMeasurement(gpu.measurement);
  if (glMetrics) metrics.webgl = glMetrics;
  if (gpuMetrics) metrics.webgpu = gpuMetrics;
  const decide = (backend: RendererBackend | null, reason: RendererSelectionReason): RendererSelectionDecision => ({ backend, reason, metrics });
  if (!gl && !gpu) return decide(null, 'no-compatible-renderer');
  if (!gpu) return decide('webgl', 'only-compatible-renderer');
  if (gpuMetrics && startupRegression(gpuMetrics)) return decide(gl ? 'webgl' : null, 'webgpu-startup-regression');
  if (!gl) return metrics.webgpu
    ? decide('webgpu', 'only-compatible-renderer') : decide(null, 'insufficient-measurements');
  const baseline = metrics.webgl, alternative = metrics.webgpu;
  if (!baseline || !alternative) return decide('webgl', 'insufficient-measurements');
  if (!sameConditions(gl.measurement!.conditions, gpu.measurement!.conditions)) {
    return decide('webgl', 'mismatched-render-conditions');
  }
  const reason = compareMetrics(baseline, alternative);
  return decide(reason === 'webgpu-faster' ? 'webgpu' : 'webgl', reason);
}

/** Include the actual device/driver identity where available. A missing identity
 * must be handled by the host by declining persistent reuse. Workload identity
 * belongs to the measurement, while the game bundle defines the cache scope. */
export interface RendererSelectionCacheKey {
  readonly device: string;
  readonly browser: string;
  readonly gameBundleHash: string;
  readonly engineVersion: string;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly qualityHash: string;
}

export interface RendererSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CachedSelection {
  key: string;
  evidence: string;
  savedAt: number;
  decision: RendererSelectionDecision;
}

function cacheKey(key: RendererSelectionCacheKey): string | null {
  if (!validResolution(key) || !nonempty(key.device) || !nonempty(key.browser)
    || !nonempty(key.gameBundleHash) || !nonempty(key.engineVersion) || !nonempty(key.qualityHash)) return null;
  return JSON.stringify([RENDERER_SELECTION_POLICY_VERSION, key.device, key.browser,
    key.gameBundleHash, key.engineVersion, key.width, key.height, key.pixelRatio, key.qualityHash]);
}

function evidenceKey(candidates: readonly RendererCandidate[]): string {
  return JSON.stringify(['webgl', 'webgpu'].map(backend => {
    const candidate = candidates.find(value => value.backend === backend);
    return candidate ? [backend, candidate.available, candidate.evidence.revision,
      candidate.evidence.compatibility, candidate.evidence.visualParity, candidate.evidence.stability] : [backend];
  }));
}

const reasons: readonly RendererSelectionReason[] = ['no-compatible-renderer', 'only-compatible-renderer',
  'insufficient-measurements', 'mismatched-render-conditions', 'webgpu-startup-regression', 'webgpu-tail-regression',
  'webgpu-not-meaningfully-faster', 'webgpu-faster'];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validMetrics(value: unknown): value is RendererFrameTimeMetrics {
  if (!record(value) || !validStartupTiming(value)) return false;
  const fields = ['sampleCount', 'meanMs', 'medianMs', 'p95Ms', 'p99Ms', 'maxMs', 'jankCount', 'stallCount', 'jankRatio', 'stallRatio'];
  if (fields.some(field => typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0)) return false;
  const metrics = value as unknown as RendererFrameTimeMetrics;
  return Number.isInteger(metrics.sampleCount) && metrics.sampleCount >= RENDERER_MIN_SAMPLES
    && metrics.sampleCount <= MAX_MEASUREMENT_SAMPLES && metrics.meanMs > 0
    && metrics.medianMs > 0 && metrics.medianMs <= metrics.p95Ms && metrics.p95Ms <= metrics.p99Ms
    && metrics.p99Ms <= metrics.maxMs && metrics.maxMs <= 60_000 && metrics.meanMs <= metrics.maxMs
    && Number.isInteger(metrics.jankCount) && Number.isInteger(metrics.stallCount)
    && metrics.stallCount <= metrics.jankCount && metrics.jankCount <= metrics.sampleCount
    && metrics.jankRatio === metrics.jankCount / metrics.sampleCount
    && metrics.stallRatio === metrics.stallCount / metrics.sampleCount;
}

function validDecision(value: unknown): value is RendererSelectionDecision {
  if (!record(value) || (value.backend !== 'webgl' && value.backend !== 'webgpu')
    || !reasons.includes(value.reason as RendererSelectionReason) || !record(value.metrics)) return false;
  if (Object.keys(value.metrics).some(backend => backend !== 'webgl' && backend !== 'webgpu')) return false;
  if (!Object.values(value.metrics).every(validMetrics)) return false;
  const decision = value as unknown as RendererSelectionDecision;
  if (decision.reason === 'only-compatible-renderer') return decision.backend === 'webgl'
    || !!decision.metrics.webgpu && !startupRegression(decision.metrics.webgpu);
  if (!decision.metrics.webgl || !decision.metrics.webgpu) return false;
  const expectedReason = compareMetrics(decision.metrics.webgl, decision.metrics.webgpu);
  return decision.reason === expectedReason && decision.backend === (expectedReason === 'webgpu-faster' ? 'webgpu' : 'webgl');
}

/** Storage is advisory: errors, stale versions, changed qualification and bad
 * records are cache misses. It never grants eligibility to a renderer. */
export class RendererSelectionCache {
  private readonly storage: RendererSelectionStorage | null;
  private readonly now: () => number;

  constructor(storage: RendererSelectionStorage | null, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
  }

  get(key: RendererSelectionCacheKey, candidates: readonly RendererCandidate[]): RendererSelectionDecision | null {
    const serializedKey = cacheKey(key);
    if (!serializedKey) return null;
    const evidence = evidenceKey(candidates);
    const entry = this.read().find(value => value.key === serializedKey && value.evidence === evidence);
    if (!entry || !candidates.some(candidate => candidate.backend === entry.decision.backend && isRendererEligible(candidate))) return null;
    if (entry.decision.reason === 'only-compatible-renderer' && candidates.filter(isRendererEligible).length !== 1) return null;
    return entry.decision;
  }

  set(key: RendererSelectionCacheKey, decision: RendererSelectionDecision, candidates: readonly RendererCandidate[]): void {
    const serializedKey = cacheKey(key);
    if (!serializedKey || decision.backend === null || !validDecision(decision)
      || !candidates.some(candidate => candidate.backend === decision.backend && isRendererEligible(candidate))) return;
    // Do not persist an unfinished comparison; the next load should try again.
    if (decision.reason === 'insufficient-measurements' || decision.reason === 'mismatched-render-conditions') return;
    if (candidates.some(candidate => {
      if (!decision.metrics[candidate.backend] || !candidate.measurement) return false;
      const actual = candidate.measurement.conditions;
      return actual.width !== key.width || actual.height !== key.height
        || actual.pixelRatio !== key.pixelRatio || actual.qualityHash !== key.qualityHash;
    })) return;
    const entries = this.read().filter(value => value.key !== serializedKey);
    entries.push({ key: serializedKey, evidence: evidenceKey(candidates), savedAt: this.now(), decision });
    try {
      this.storage?.setItem(RENDERER_SELECTION_CACHE_STORAGE_KEY,
        JSON.stringify({ version: RENDERER_SELECTION_POLICY_VERSION, entries: entries.slice(-RENDERER_SELECTION_CACHE_MAX_ENTRIES) }));
    } catch { /* Private mode, disabled storage or quota exhaustion: use this session's choice. */ }
  }

  invalidate(): void {
    try { this.storage?.removeItem(RENDERER_SELECTION_CACHE_STORAGE_KEY); } catch { /* Best effort. */ }
  }

  private read(): CachedSelection[] {
    try {
      const raw = this.storage?.getItem(RENDERER_SELECTION_CACHE_STORAGE_KEY);
      if (!raw || raw.length > 512_000) return [];
      const value: unknown = JSON.parse(raw);
      if (!record(value) || value.version !== RENDERER_SELECTION_POLICY_VERSION || !Array.isArray(value.entries)) return [];
      const now = this.now();
      return value.entries.filter((entry: unknown): entry is CachedSelection => record(entry)
        && nonempty(entry.key) && nonempty(entry.evidence) && typeof entry.savedAt === 'number'
        && Number.isFinite(entry.savedAt) && entry.savedAt <= now
        && now - entry.savedAt < RENDERER_SELECTION_CACHE_TTL_MS && validDecision(entry.decision))
        .slice(-RENDERER_SELECTION_CACHE_MAX_ENTRIES);
    } catch { return []; }
  }
}
