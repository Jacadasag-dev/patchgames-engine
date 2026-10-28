import type { ReviewCamera } from '../../shared/gameApi.ts';
import { loadTextureAsset } from './mediaAssets.ts';
import type { CalibrationSnapshot, RendererCalibrationDriver } from './rendererCalibration.ts';
import type { RendererBackend, RendererConditions } from './rendererSelection.ts';

export interface RendererReplayFrame { frame: unknown; reviewCamera?: ReviewCamera | null }

/** The same opaque iframe, CSP and worker protocol as play. Calibration grants
 * no additional permissions, ignores sound, and has only one operation in flight. */
export function createSandboxRendererDriver(options: {
  container: HTMLElement; code: string; documentSource: string; conditions: RendererConditions; backend?: RendererBackend;
}, signal: AbortSignal): Promise<RendererCalibrationDriver<RendererReplayFrame>> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true'); iframe.tabIndex = -1;
    iframe.dataset.testid = 'renderer-calibration';
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none';
    iframe.srcdoc = options.documentSource;
    let disposed = false, initialized = false, mediaRequests = 0;
    let pending: { type: 'rendered' | 'renderer-snapshot'; resolve(value?: CalibrationSnapshot): void; reject(error: Error): void } | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('message', message);
      signal.removeEventListener('abort', aborted);
      try { iframe.contentWindow?.postMessage({ type: 'dispose' }, '*'); }
      catch { /* A torn-down window is already unable to render. */ }
      finally { iframe.remove(); }
      const error = new Error('Renderer calibration stopped.');
      pending?.reject(error); pending = undefined; reject(error);
    };
    const aborted = () => dispose();
    const fail = (error: Error) => { pending?.reject(error); pending = undefined; reject(error); dispose(); };
    const operation = (type: 'rendered' | 'renderer-snapshot', data: unknown, operationSignal: AbortSignal): Promise<CalibrationSnapshot | undefined> => {
      if (disposed || signal.aborted || operationSignal.aborted) return Promise.reject(new Error('Renderer calibration stopped.'));
      if (pending) return Promise.reject(new Error('Renderer calibration operation already pending.'));
      return new Promise((done, failed) => {
        const abortedOperation = () => dispose();
        const cleanup = () => operationSignal.removeEventListener('abort', abortedOperation);
        operationSignal.addEventListener('abort', abortedOperation, { once: true });
        pending = { type, resolve: result => { cleanup(); done(result); }, reject: error => { cleanup(); failed(error); } };
        try { iframe.contentWindow!.postMessage(data, '*'); } catch (error) { fail(error as Error); }
      });
    };
    const message = (event: MessageEvent) => {
      if (disposed || event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (data?.type === 'ready' && !initialized) {
        initialized = true;
        try { iframe.contentWindow!.postMessage({ type: 'init', code: options.code, backend: options.backend ?? 'webgl' }, '*'); }
        catch (error) { fail(error as Error); return; }
        resolve({
          async render(input, operationSignal, phase) { await operation('rendered', { type: 'frame', ...input, gpuCompletion: true,
            ...(phase === 'warmup' ? { gpuWarmup: true } : {}),
            width: options.conditions.width, height: options.conditions.height, pixelRatio: options.conditions.pixelRatio }, operationSignal); },
          async snapshot(operationSignal) {
            const result = await operation('renderer-snapshot', { type: 'renderer-snapshot' }, operationSignal);
            if (!result) throw new Error('Renderer could not capture its full image.');
            return result;
          }, dispose,
        });
      } else if (data?.type === 'error') fail(new Error(String(data.message).slice(0, 500)));
      else if (pending && data?.type === pending.type) {
        if (data.type === 'rendered' && data.gpuCompleted !== true) {
          fail(new Error('The renderer did not confirm GPU completion for calibration.')); return;
        }
        const active = pending!; pending = undefined;
        active.resolve(data.type === 'renderer-snapshot' ? data.snapshot : undefined);
      } else if (data?.type === 'media-request') {
        if (!Number.isSafeInteger(data.requestId) || typeof data.id !== 'string' || data.id.length > 120) return;
        const requestId = data.requestId;
        if (mediaRequests >= 16) { fail(new Error('Renderer exceeded pending media limit.')); return; }
        mediaRequests++;
        void loadTextureAsset(data.id).then(source => {
          if (!disposed) iframe.contentWindow?.postMessage({ type: 'media-response', requestId, source }, '*');
        }, error => {
          if (!disposed) iframe.contentWindow?.postMessage({ type: 'media-response', requestId, error: String(error).slice(0, 300) }, '*');
        }).finally(() => { mediaRequests--; }).catch(error => {
          if (!disposed) fail(error instanceof Error ? error : new Error(String(error)));
        });
      }
    };
    window.addEventListener('message', message);
    signal.addEventListener('abort', aborted, { once: true });
    options.container.append(iframe);
  });
}
