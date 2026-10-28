/** GPU scheduling shared by loading calibration and normal rendering. Full
 * queue drains are loading-only; gameplay keeps two submissions overlapping. */
export interface CompletableRenderer {
  backend?: {
    isWebGPUBackend?: boolean;
    device?: { queue?: { onSubmittedWorkDone(): Promise<void> } };
  };
  getContext?(): {
    finish(): void;
    isContextLost(): boolean;
  };
}

export interface RenderCompletionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const submittedRenderers = new Set<CompletableRenderer>();
interface SubmittedCompletion { done: boolean; wait: Promise<void> }
interface SubmissionWindow {
  pending: SubmittedCompletion[];
  controller: AbortController;
  failed: boolean;
  failure?: unknown;
}
const submissionWindows = new WeakMap<CompletableRenderer, SubmissionWindow>();

function clearSubmissionWindow(renderer: CompletableRenderer, reason: Error): void {
  const window = submissionWindows.get(renderer);
  if (!window) return;
  submissionWindows.delete(renderer);
  window.controller.abort(reason);
}

/** Called once before the engine invokes a view update, including gameplay.
 * Tracking submissions does not drain or otherwise synchronize GPU work. */
export function beginRenderedFrame(): void { submittedRenderers.clear(); }

export function recordRendererSubmission(renderer: CompletableRenderer): void { submittedRenderers.add(renderer); }
/** Empty loading frames cannot warm GPU pipelines. The startup wrapper defers
 * its one barrier until the view has actually submitted supported render work. */
export function hasRendererSubmission(): boolean { return submittedRenderers.size > 0; }

export function forgetRendererCompletion(renderer: CompletableRenderer): void {
  submittedRenderers.delete(renderer);
  clearSubmissionWindow(renderer, new Error('Renderer disposed before GPU completion.'));
}

/** Called after a normal view update and before acknowledging it. One GPU
 * submission overlaps CPU work freely; at two, wait only for the older one.
 * The host then coalesces new input instead of queuing unbounded stale frames.
 * WebGL keeps its native browser backpressure and receives no extra fences. */
export function applyRenderedFrameBackpressure(options?: RenderCompletionOptions): Promise<void> | undefined {
  let waits: Promise<void>[] | undefined;
  try {
    for (const renderer of submittedRenderers) {
      if (renderer.backend?.isWebGPUBackend !== true) continue;
      const wait = applyRendererBackpressure(renderer, options);
      if (wait) (waits ??= []).push(wait);
    }
  } finally { submittedRenderers.clear(); }
  if (!waits) return;
  return waits.length === 1 ? waits[0] : Promise.all(waits).then(() => undefined);
}

function applyRendererBackpressure(renderer: CompletableRenderer, options: RenderCompletionOptions = {}): Promise<void> | undefined {
  let window = submissionWindows.get(renderer);
  if (!window) {
    window = { pending: [], controller: new AbortController(), failed: false };
    submissionWindows.set(renderer, window);
  }
  if (window.failed) throw window.failure;
  while (window.pending[0]?.done) window.pending.shift();
  const state = window;
  const aborted = () => state.controller.abort(options.signal?.reason ?? new Error('Renderer completion cancelled.'));
  if (options.signal?.aborted) aborted();
  else options.signal?.addEventListener('abort', aborted, { once: true });
  const completion: SubmittedCompletion = { done: false, wait: Promise.resolve() };
  // Convert rejection into stored state immediately, so a first outstanding
  // submission can fail between frames without an unhandled rejection.
  completion.wait = waitForRendererCompletion(renderer, { ...options, signal: state.controller.signal }).then(() => {
    completion.done = true;
  }, error => {
    completion.done = true; state.failed = true;
    state.failure = error ?? new Error('GPU completion failed.');
  }).finally(() => options.signal?.removeEventListener('abort', aborted));
  state.pending.push(completion);
  if (state.pending.length >= 2) return state.pending[0].wait.then(() => {
    if (state.failed) throw state.failure;
    while (state.pending[0]?.done) state.pending.shift();
  });
}

/** Calibration frames complete all renderers that actually drew that frame.
 * An empty frame cannot claim a successful GPU completion measurement. */
export async function completeRenderedFrame(options: RenderCompletionOptions = {}): Promise<true> {
  const renderers = [...submittedRenderers];
  submittedRenderers.clear();
  if (!renderers.length) throw new Error('The calibration frame submitted no supported renderer work.');
  await Promise.all(renderers.map(async renderer => {
    try { await waitForRendererCompletion(renderer, options); }
    finally { clearSubmissionWindow(renderer, new Error('Renderer completion window reset after full drain.')); }
  }));
  return true;
}

/** Wait for commands already submitted by this renderer, not canvas
 * presentation. WebGL finish is deliberately restricted to calibration: an
 * asynchronous clientWaitSync timer loop adds scheduler/clamping delay that
 * can dominate a 4.17 ms sample and bias comparison against that backend. */
export async function waitForRendererCompletion(renderer: CompletableRenderer,
  options: RenderCompletionOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid renderer completion timeout.');
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Renderer completion cancelled.');
  if (renderer.backend?.isWebGPUBackend === true) {
    const queue = renderer.backend.device?.queue;
    if (!queue || typeof queue.onSubmittedWorkDone !== 'function') throw new Error('WebGPU queue completion is unavailable.');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        if (error !== undefined) reject(error); else resolve();
      };
      const aborted = () => finish(options.signal?.reason ?? new Error('Renderer completion cancelled.'));
      const timer = setTimeout(() => finish(new Error('GPU completion timed out.')), timeoutMs);
      options.signal?.addEventListener('abort', aborted, { once: true });
      try { Promise.resolve(queue.onSubmittedWorkDone()).then(() => finish(), error => finish(error)); }
      catch (error) { finish(error); }
    });
    return;
  }
  const context = renderer.getContext?.();
  if (!context || typeof context.finish !== 'function' || typeof context.isContextLost !== 'function') {
    throw new Error('Renderer does not expose a supported GPU completion barrier.');
  }
  if (context.isContextLost()) throw new Error('WebGL context was lost before completion.');
  context.finish();
  if (context.isContextLost()) throw new Error('WebGL context was lost during completion.');
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Renderer completion cancelled.');
}
