import { RENDERER_MIN_SAMPLES, RENDERER_MIN_WARMUP_FRAMES } from './rendererSelection.ts';
import type { RendererBackend, RendererConditions, RendererMeasurement } from './rendererSelection.ts';
import { compareRendererVisualParity } from './rendererVisualParity.ts';

/** Loading-time renderer comparison. Drivers must await CPU+GPU completion,
 * including messaging. These serial latencies are not presentation FPS. */
export type CalibrationBackend = RendererBackend;
export type CalibrationConditions = RendererConditions;

export interface CalibrationSnapshot {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
}

export interface RendererCalibrationDriver<Frame> {
  /** Resolve only after this exact frame's CPU and GPU work has completed.
   * Warmup may compile new pipelines; its time never enters the scored samples. */
  render(frame: Frame, signal: AbortSignal, phase?: 'warmup' | 'sample'): Promise<void>;
  snapshot(signal: AbortSignal): Promise<CalibrationSnapshot>;
  /** Stop rendering and terminate the candidate synchronously, then release any
   * remaining resources. A cancelled candidate must never continue into play. */
  dispose(): void | Promise<void>;
}

export interface RendererCalibrationCandidate<Frame> {
  backend: CalibrationBackend;
  /** Must respect cancellation, including during asynchronous GPU startup. */
  create(signal: AbortSignal): Promise<RendererCalibrationDriver<Frame>>;
}

export interface RendererCalibrationMeasurement extends RendererMeasurement {
  backend: CalibrationBackend;
  visualParity: 'baseline' | 'passed';
}

export type CalibrationRejectionCode = 'cancelled' | 'environment-changed' | 'timeout'
  | 'render-error' | 'invalid-samples' | 'invalid-snapshot' | 'visual-mismatch'
  | 'cleanup-failed' | 'invalid-replay' | 'invalid-candidates';

export interface RendererCalibrationResult {
  status: 'complete' | 'cancelled' | 'invalid';
  metric: 'gpu-completed-frame-latency';
  measurements: RendererCalibrationMeasurement[];
  rejected: { backend: CalibrationBackend; code: CalibrationRejectionCode; detail: string }[];
  reason?: CalibrationRejectionCode;
}

export interface RendererCalibrationLimits {
  minimumWarmupFrames: number;
  minimumSamples: number;
  warmupTimeoutMs: number;
  operationTimeoutMs: number;
  totalTimeoutMs: number;
  cleanupTimeoutMs: number;
  minimumSnapshotPixels: number;
  /** Differences at or below this value do not count as changed channels. */
  channelTolerance: number;
  maximumChangedPixelRatio: number;
  maximumMeanChannelDifference: number;
}

const defaultLimits: RendererCalibrationLimits = {
  minimumWarmupFrames: RENDERER_MIN_WARMUP_FRAMES,
  minimumSamples: RENDERER_MIN_SAMPLES,
  warmupTimeoutMs: 15000,
  operationTimeoutMs: 3000,
  totalTimeoutMs: 30000,
  cleanupTimeoutMs: 1000,
  minimumSnapshotPixels: 64,
  channelTolerance: 2,
  maximumChangedPixelRatio: 0.001,
  maximumMeanChannelDifference: 0.1,
};

export interface RendererCalibrationOptions<Frame> {
  /** Only engine-qualified, available candidates belong in this list. */
  candidates: readonly RendererCalibrationCandidate<Frame>[];
  baseline?: CalibrationBackend;
  /** Captured simulation/interpolation output. The same cloned input is used for
   * each backend; calibration never advances or mutates the live simulation. */
  replay: {
    warmup: readonly Frame[];
    samples: readonly Frame[];
    checkpoints: readonly Frame[];
    /** Capture these zero-based sample frames in sequence, without rewinding
     * stateful views after timing. Readback itself is excluded from the timing. */
    checkpointSampleIndices?: readonly number[];
  };
  environment(): CalibrationConditions & { visible: boolean };
  /** Subscribe to visibility, size and quality changes. This detects changes
   * even when they occur and are reverted between two frame acknowledgements. */
  subscribeEnvironmentChanges?(listener: () => void): () => void;
  signal?: AbortSignal;
  limits?: Partial<RendererCalibrationLimits>;
  now?: () => number;
}

class CalibrationFailure extends Error {
  readonly code: CalibrationRejectionCode;
  constructor(code: CalibrationRejectionCode, message: string) {
    super(message);
    this.code = code;
  }
}

function failure(error: unknown): CalibrationFailure {
  return error instanceof CalibrationFailure ? error
    : new CalibrationFailure('render-error', error instanceof Error ? error.message : String(error));
}

function cancellation(signal: AbortSignal): CalibrationFailure {
  return signal.reason instanceof CalibrationFailure ? signal.reason
    : new CalibrationFailure('cancelled', 'Renderer calibration cancelled.');
}

/** Race even non-cooperative drivers without leaving unresolved rejection
 * handlers. A factory that resolves after cancellation is disposed immediately. */
function bounded<T>(operation: () => Promise<T> | T, timeoutMs: number,
  signal?: AbortSignal, lateResult?: (result: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancellation(signal)); return; }
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const aborted = () => finish(cancellation(signal!));
    const timer = setTimeout(() => finish(new CalibrationFailure('timeout', 'Renderer operation timed out.')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw cancellation(signal);
      return operation();
    }).then(value => {
      if (settled) lateResult?.(value);
      else finish(undefined, value);
    }, error => finish(error));
  });
}

function sameConditions(a: CalibrationConditions, b: CalibrationConditions): boolean {
  return a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio
    && a.qualityHash === b.qualityHash && a.workloadHash === b.workloadHash;
}

function validConditions(value: CalibrationConditions & { visible: boolean }): boolean {
  return value.visible && Number.isSafeInteger(value.width) && value.width > 0
    && Number.isSafeInteger(value.height) && value.height > 0
    && Number.isFinite(value.pixelRatio) && value.pixelRatio > 0
    && value.qualityHash.length > 0 && value.workloadHash.length > 0;
}

function snapshotCopy(snapshot: CalibrationSnapshot, limits: RendererCalibrationLimits): CalibrationSnapshot {
  const count = snapshot.width * snapshot.height;
  if (!Number.isSafeInteger(snapshot.width) || snapshot.width <= 0
    || !Number.isSafeInteger(snapshot.height) || snapshot.height <= 0
    || count < limits.minimumSnapshotPixels || count > 16_777_216
    || !(snapshot.pixels instanceof Uint8Array || snapshot.pixels instanceof Uint8ClampedArray)
    || snapshot.pixels.length !== count * 4) {
    throw new CalibrationFailure('invalid-snapshot', 'Renderer snapshot is missing or has invalid dimensions.');
  }
  // An empty, transparent or solid-color canvas cannot establish gameplay parity.
  let varied = false;
  let visible = false;
  for (let offset = 0; offset < snapshot.pixels.length; offset += 4) {
    if (snapshot.pixels[offset + 3] > 0) visible = true;
    for (let channel = 0; channel < 4; channel++) {
      if (Math.abs(snapshot.pixels[offset + channel] - snapshot.pixels[channel]) > 8) varied = true;
    }
  }
  if (!visible || !varied) throw new CalibrationFailure('invalid-snapshot', 'Renderer snapshot contains no usable gameplay detail.');
  // Drivers may reuse readback buffers on the next capture.
  return { width: snapshot.width, height: snapshot.height, pixels: new Uint8Array(snapshot.pixels) };
}

function compareSnapshots(baseline: CalibrationSnapshot, candidate: CalibrationSnapshot,
  limits: RendererCalibrationLimits): void {
  const parity = compareRendererVisualParity(baseline, candidate, limits);
  if (!parity.passed) throw new CalibrationFailure('visual-mismatch', `Renderer checkpoint differs from the baseline image: ${parity.reason}; `
    + `${(parity.metrics.unexcusedChangedPixelRatio * 100).toFixed(3)}% unexplained changed pixels, `
    + `${parity.metrics.meanChannelDifference.toFixed(4)} mean channel difference.`);
}

function validateLimits(limits: RendererCalibrationLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) throw new CalibrationFailure('invalid-replay', `Invalid calibration limit: ${name}.`);
  }
  if (limits.minimumSamples < 1 || limits.minimumWarmupFrames < 1 || limits.minimumSnapshotPixels < 1
    || limits.warmupTimeoutMs < 1 || limits.operationTimeoutMs < 1 || limits.totalTimeoutMs < 1 || limits.cleanupTimeoutMs < 1
    || limits.maximumChangedPixelRatio > 1 || limits.channelTolerance > 255) {
    throw new CalibrationFailure('invalid-replay', 'Calibration limits are out of range.');
  }
}

export async function calibrateRenderers<Frame>(options: RendererCalibrationOptions<Frame>): Promise<RendererCalibrationResult> {
  const result: RendererCalibrationResult = { status: 'complete', metric: 'gpu-completed-frame-latency', measurements: [], rejected: [] };
  const limits = { ...defaultLimits, ...options.limits };
  const now = options.now ?? (() => performance.now());
  const controller = new AbortController();
  const externalAbort = () => controller.abort(new CalibrationFailure('cancelled', 'Renderer calibration cancelled.'));
  let unsubscribe: (() => void) | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    validateLimits(limits);
    if (options.signal?.aborted) throw new CalibrationFailure('cancelled', 'Renderer calibration cancelled.');
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    const initial = options.environment();
    if (!validConditions(initial)) throw new CalibrationFailure('environment-changed', 'Calibration requires a visible, sized viewport and fixed quality.');
    const conditions: CalibrationConditions = { width: initial.width, height: initial.height,
      pixelRatio: initial.pixelRatio, qualityHash: initial.qualityHash, workloadHash: initial.workloadHash };
    const validateEnvironment = () => {
      if (controller.signal.aborted) throw cancellation(controller.signal);
      const current = options.environment();
      if (!validConditions(current) || !sameConditions(conditions, current)) {
        throw new CalibrationFailure('environment-changed', 'Visibility, resolution, quality or workload changed during calibration.');
      }
    };
    unsubscribe = options.subscribeEnvironmentChanges?.(() => {
      try { validateEnvironment(); } catch (error) { controller.abort(failure(error)); }
    });
    totalTimer = setTimeout(() => controller.abort(new CalibrationFailure('timeout', 'Renderer calibration exceeded its loading-time budget.')), limits.totalTimeoutMs);
    const baseline = options.baseline ?? 'webgl';
    const candidates = [...options.candidates].sort((a, b) => Number(b.backend === baseline) - Number(a.backend === baseline));
    if (!candidates.length || candidates[0].backend !== baseline
      || new Set(candidates.map(candidate => candidate.backend)).size !== candidates.length) {
      throw new CalibrationFailure('invalid-candidates', 'Calibration needs a unique candidate list containing its baseline.');
    }
    // Clone once to isolate an in-progress live replay buffer, and again on each
    // render so a candidate cannot mutate another candidate's workload.
    const replay = structuredClone(options.replay);
    const checkpointSampleIndices = replay.checkpointSampleIndices ?? [];
    const checkpointCount = replay.checkpoints.length + checkpointSampleIndices.length;
    if (replay.warmup.length < limits.minimumWarmupFrames || replay.samples.length < limits.minimumSamples
      || replay.samples.length > 10000 || replay.warmup.length > 10000 || !checkpointCount
      || checkpointCount > 32 || new Set(checkpointSampleIndices).size !== checkpointSampleIndices.length
      || checkpointSampleIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= replay.samples.length)) {
      throw new CalibrationFailure('invalid-replay', 'Calibration requires enough warmup/sample frames and representative visual checkpoints.');
    }
    const sampleCheckpoints = new Set(checkpointSampleIndices);
    const baselineSnapshots: CalibrationSnapshot[] = [];
    for (const candidate of candidates) {
      validateEnvironment();
      const candidateController = new AbortController();
      const abortCandidate = () => candidateController.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', abortCandidate, { once: true });
      let driver: RendererCalibrationDriver<Frame> | undefined;
      let measurement: RendererCalibrationMeasurement | undefined;
      let candidateFailure: CalibrationFailure | undefined;
      try {
        driver = await bounded(() => candidate.create(candidateController.signal), limits.operationTimeoutMs,
          controller.signal, late => { void Promise.resolve().then(() => late.dispose()).catch(() => {}); });
        let renderedFrames = 0;
        const render = async (frame: Frame, phase: 'warmup' | 'sample' = 'sample') => {
          validateEnvironment();
          const input = structuredClone(frame);
          const started = now();
          const timeoutMs = phase === 'warmup' ? limits.warmupTimeoutMs : limits.operationTimeoutMs;
          const index = renderedFrames++;
          try { await bounded(() => driver!.render(input, candidateController.signal, phase), timeoutMs, controller.signal); }
          catch (error) {
            const rejected = failure(error);
            throw new CalibrationFailure(rejected.code, `Frame ${index} (${index < replay.warmup.length ? 'warmup' : 'sample'}): ${rejected.message}`);
          }
          const elapsed = now() - started;
          validateEnvironment();
          if (!Number.isFinite(elapsed) || elapsed <= 0) throw new CalibrationFailure('invalid-samples', 'Frame timing is nonfinite or has insufficient clock resolution.');
          return elapsed;
        };
        let checkpointIndex = 0;
        const captureCheckpoint = async () => {
          const snapshot = snapshotCopy(await bounded(() => driver!.snapshot(candidateController.signal), limits.operationTimeoutMs, controller.signal), limits);
          validateEnvironment();
          if (candidate.backend === baseline) baselineSnapshots.push(snapshot);
          else compareSnapshots(baselineSnapshots[checkpointIndex], snapshot, limits);
          checkpointIndex++;
        };
        let startupMaxFrameMs = 0, startupPostFirstMaxMs = 0;
        for (const [index, frame] of replay.warmup.entries()) {
          const elapsed = await render(frame, 'warmup');
          startupMaxFrameMs = Math.max(startupMaxFrameMs, elapsed);
          if (index > 0) startupPostFirstMaxMs = Math.max(startupPostFirstMaxMs, elapsed);
        }
        const frameTimesMs: number[] = [];
        for (let index = 0; index < replay.samples.length; index++) {
          frameTimesMs.push(await render(replay.samples[index]));
          if (sampleCheckpoints.has(index)) await captureCheckpoint();
        }
        for (const frame of replay.checkpoints) {
          await render(frame);
          await captureCheckpoint();
        }
        measurement = { backend: candidate.backend, frameTimesMs, warmupFrames: replay.warmup.length,
          startupMaxFrameMs, startupPostFirstMaxMs,
          conditions: { ...conditions }, visualParity: candidate.backend === baseline ? 'baseline' : 'passed' };
      } catch (error) {
        candidateFailure = failure(error);
      } finally {
        candidateController.abort(candidateFailure ?? new CalibrationFailure('cancelled', 'Candidate completed.'));
        controller.signal.removeEventListener('abort', abortCandidate);
        if (driver) {
          try { await bounded(() => driver!.dispose(), limits.cleanupTimeoutMs); }
          catch { throw new CalibrationFailure('cleanup-failed', 'Candidate did not complete cleanup; calibration cannot continue.'); }
        }
      }
      if (controller.signal.aborted) throw cancellation(controller.signal);
      validateEnvironment();
      if (candidateFailure) {
        result.rejected.push({ backend: candidate.backend, code: candidateFailure.code, detail: candidateFailure.message });
        if (candidate.backend === baseline) throw candidateFailure;
      } else if (measurement) result.measurements.push(measurement);
    }
  } catch (error) {
    const rejected = failure(error);
    result.status = rejected.code === 'cancelled' ? 'cancelled' : 'invalid';
    result.reason = rejected.code;
    // A changed environment or incomplete baseline invalidates the whole comparison.
    result.measurements = [];
  } finally {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', externalAbort);
    unsubscribe?.();
    controller.abort(new CalibrationFailure('cancelled', 'Calibration completed.'));
  }
  return result;
}
