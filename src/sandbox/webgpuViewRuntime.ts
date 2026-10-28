import type { CreateView, GameView, TuningValues } from '../shared/gameApi.ts';
import { start as startView } from './viewRuntime.ts';
import { beginRendererFrame, initializeRenderers } from './rendererWebGPU.ts';
import { hasRendererSubmission } from './renderCompletion.ts';

type View = GameView<unknown, unknown, TuningValues>;
/** Every alternate bundle uses the same view/runtime as its baseline. This
 * engine wrapper finishes asynchronous GPU initialization before accepting any
 * frame, and advances Three's renderer clock only with an actual game update. */
export function start(createView: CreateView<unknown, unknown, TuningValues>, initialize?: () => Promise<void>): void {
  let prepared: View | undefined;
  startView(() => {
    if (!prepared) throw new Error('The WebGPU view has not initialized.');
    return prepared;
  });
  const scope = globalThis as unknown as { onmessage: (event: MessageEvent) => unknown; postMessage(value: unknown, ...transfer: unknown[]): void };
  const runtime = scope.onmessage;
  let initialization: Promise<unknown> | undefined;
  let firstFrame = true;
  let startupDrawn: (() => void) | undefined;

  async function warmFirstFrame(event: MessageEvent): Promise<unknown> {
    const post = scope.postMessage;
    const pendingPreparation = new Set<string>();
    let preparationAnnounced = false;
    // Terrain and texture preparation may finish before the first GPU command
    // buffer does. Keep their ready:true messages from ending the host's one
    // bounded startup allowance while cold GPU pipelines are still compiling.
    const preparingPost = (value: unknown, ...transfer: unknown[]) => {
      if (value && typeof value === 'object') {
        const message = value as { type?: unknown; ready?: unknown; gpuCompleted?: unknown };
        if (message.type === 'rendered' && message.gpuCompleted === true) firstFrame = false;
        if ((message.type === 'media-preparing' || message.type === 'terrain-preparing')
          && typeof message.ready === 'boolean') {
          if (message.ready) { pendingPreparation.delete(message.type); return; }
          pendingPreparation.add(message.type);
          preparationAnnounced = true;
        }
      }
      post.call(scope, value, ...transfer);
    };
    scope.postMessage = preparingPost;
    startupDrawn = () => {
      if (hasRendererSubmission() && !preparationAnnounced) {
        preparationAnnounced = true;
        post.call(scope, { type: 'media-preparing', ready: false });
      }
    };
    try {
      // Reuse the runtime's single completion barrier. Calibration frames already
      // request it; ordinary gameplay requests it only for this cold first draw.
      return await runtime(event.data.gpuCompletion === true ? event
        : new MessageEvent('message', { data: { ...event.data, gpuStartup: true } }));
    } finally {
      startupDrawn = undefined;
      if (scope.postMessage === preparingPost) scope.postMessage = post;
      // This ends a preparation phase, not a successful-render acknowledgment.
      // Runtime errors and gpuCompleted:false remain the host's failure signal.
      // Do not clear an independently outstanding texture/terrain preparation.
      if (preparationAnnounced && !pendingPreparation.size) post.call(scope, { type: 'media-preparing', ready: true });
    }
  }
  scope.onmessage = (event: MessageEvent) => {
    if (event.data?.type === 'init') {
      if (initialization) return;
      initialization = (async () => {
        await initialize?.();
        prepared = createView(event.data.canvas);
        const update = prepared.update.bind(prepared);
        prepared.update = frame => {
          beginRendererFrame();
          try { return update(frame); }
          finally { startupDrawn?.(); }
        };
        await initializeRenderers();
        return runtime(event);
      })();
      // Report startup failure to the trusted host; keep the rejected promise so
      // subsequent frames cannot masquerade as successfully rendered updates.
      void initialization.catch(error => scope.postMessage({ type: 'error',
        message: `WebGPU initialization: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }));
      return initialization;
    }
    // Asset replies must remain live during asynchronous initialization.
    if (event.data?.type === 'media-response') return runtime(event);
    if (!initialization) return;
    return initialization.then(() => {
      if (event.data?.type === 'frame' && firstFrame) {
        return warmFirstFrame(event);
      }
      return runtime(event);
    }, () => undefined);
  };
}
