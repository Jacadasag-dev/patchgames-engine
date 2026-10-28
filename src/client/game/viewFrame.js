// @ts-check
// Locked iframe bootstrap, emitted separately to satisfy embedding CSPs.
const MAX_ERRORS_PER_SECOND = 2;
// More messages than this per second from the worker means it's flooding: stop it.
const MAX_MESSAGES_PER_SECOND = 600;

// A blob worker inherits the opaque iframe's insecure context in Chromium, so
// it cannot expose navigator.gpu. A short data worker has its own secure opaque
// context and still inherits our restrictive CSP. Pass the large bundle in the
// first message, then import only a worker-owned blob (revoked immediately).
// Network imports, fetch, eval, DOM and parent access remain unavailable.
const RENDERER_DATA_WORKER_BOOTSTRAP = `self.onmessage = event => {
  if (event.data?.type !== 'init' || typeof event.data.code !== 'string') throw new Error('Expected renderer worker initialization.');
  const { code, ...message } = event.data;
  self.onmessage = null;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try { importScripts(url); } finally { URL.revokeObjectURL(url); }
  if (typeof self.onmessage !== 'function') throw new Error('Renderer bundle did not install its message handler.');
  self.onmessage(new MessageEvent('message', { data: message }));
};`;

/**
 * Runs inside the sandboxed iframe (locked code, in the iframe's own realm:
 * the worker's code can't reach it). Starts the worker on the canvas and
 * relays: frames in, one answer per frame out, errors rate-limited.
 * @param {number} maxMessagesPerSecond
 * @param {number} maxErrorsPerSecond
 */
function bootstrap(maxMessagesPerSecond, maxErrorsPerSecond) {
  const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('canvas'));
  /** @type {Worker | null} */
  let worker = null;
  let windowStart = 0;
  let messages = 0;
  let errors = 0;
  /** @param {unknown} message */
  const toPage = (message) => parent.postMessage(message, '*');

  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    /** @type {{ type?: string; code?: unknown; backend?: unknown }} */
    const message = event.data;
    if (message?.type === 'init' && !worker && typeof message.code === 'string') {
      const useDataWorker = message.backend === 'webgpu';
      const workerUrl = useDataWorker
        ? 'data:text/javascript;charset=utf-8,' + encodeURIComponent(RENDERER_DATA_WORKER_BOOTSTRAP)
        : URL.createObjectURL(new Blob([message.code], { type: 'text/javascript' }));
      try { worker = new Worker(workerUrl); }
      catch (error) {
        toPage({ type: 'error', message: `Renderer worker startup failed: ${String(error)}`.slice(0, 500) });
        return;
      } finally { if (!useDataWorker) URL.revokeObjectURL(workerUrl); }
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: 'init', canvas: offscreen, ...(useDataWorker ? { code: message.code } : {}) }, [offscreen]);
      worker.onmessage = (answer) => {
        const now = Date.now();
        if (now - windowStart > 1000) {
          windowStart = now;
          messages = 0;
          errors = 0;
        }
        if (++messages > maxMessagesPerSecond) {
          worker?.terminate();
          toPage({ type: 'error', message: 'the view flooded the page with messages and was stopped' });
          return;
        }
        /** @type {{ type?: unknown; info?: unknown; message?: unknown; ready?: unknown; gpuCompleted?: unknown }} */
        const data = answer.data;
        if (data?.type === 'rendered') {
          const timing=data.frameProfile;
          const validTiming=timing&&['prepareMs','updateMs'].every(key=>typeof timing[key]==='number'&&Number.isFinite(timing[key])&&timing[key]>=0&&timing[key]<=60000);
          // Authored documents cross only as bounded JSON text. Host code owns
          // parsing, validation and DOM rendering; the worker never gets DOM.
          const hasUi = Object.prototype.hasOwnProperty.call(data, 'ui');
          const validUi = data.ui === null || typeof data.ui === 'string' && data.ui.length <= 131072 && new Blob([data.ui]).size <= 131072;
          const sceneEpoch=typeof data.sceneEpoch==='string'&&data.sceneEpoch.length<=160?data.sceneEpoch:undefined;
          toPage({ type: 'rendered', info: data.info, gpuCompleted: data.gpuCompleted === true,
            ...(sceneEpoch!==undefined?{sceneEpoch}:{}),
            ...(hasUi ? { ui: validUi ? data.ui : null } : {}),
            ...(validTiming?{frameProfile:{prepareMs:timing.prepareMs,updateMs:timing.updateMs}}:{}) });
        }
        else if (data?.type === 'audio' || data?.type === 'media-request') toPage(data);
        else if ((data?.type === 'terrain-preparing' || data?.type === 'media-preparing') && typeof data.ready === 'boolean') toPage({ type: data.type, ready: data.ready });
        else if (data?.type === 'error' && ++errors <= maxErrorsPerSecond) toPage({ type: 'error', message: String(data.message).slice(0, 500) });
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (++errors <= maxErrorsPerSecond) toPage({ type: 'error', message: String(event.message).slice(0, 500) });
      };
    } else if (message?.type === 'dispose') {
      worker?.terminate();
      worker = null;
    } else if (message?.type === 'renderer-snapshot') {
      // Full-frame readback is available only to the trusted parent during
      // loading calibration. Worker messages cannot request or forge this relay.
      try {
        const width = canvas.width, height = canvas.height;
        if (width * height > 4_194_304) throw new Error('Calibration image too large');
        const copy = document.createElement('canvas'); copy.width = width; copy.height = height;
        const context = copy.getContext('2d');
        if (!context) throw new Error('Readback unavailable');
        context.drawImage(canvas, 0, 0);
        toPage({ type: 'renderer-snapshot', snapshot: { width, height, pixels: context.getImageData(0, 0, width, height).data } });
      } catch { toPage({ type: 'renderer-snapshot', snapshot: null }); }
    } else if (message?.type === 'snapshot') {
      try {
        const size=Math.min(canvas.width,canvas.height),crop=document.createElement('canvas');crop.width=512;crop.height=512;
        crop.getContext('2d')?.drawImage(canvas,(canvas.width-size)/2,(canvas.height-size)/2,size,size,0,0,512,512);
        toPage({type:'snapshot',image:crop.toDataURL('image/png')});
      } catch { toPage({type:'snapshot',image:null}); }
    } else if (message?.type === 'frame' || message?.type === 'media-response') {
      worker?.postMessage(message);
    }
  });
  toPage({ type: 'ready' });
}

bootstrap(MAX_MESSAGES_PER_SECOND, MAX_ERRORS_PER_SECOND);
