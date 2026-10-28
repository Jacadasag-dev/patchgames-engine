import { PreviewSimulationRuntime } from './previewSimulationRuntime.ts';
import type { PreviewSimulationRequest, PreviewSimulationResponse } from './previewSimulation.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<PreviewSimulationRequest>) => void) | null;
  postMessage(message: PreviewSimulationResponse): void;
  close(): void;
};
let runtime: PreviewSimulationRuntime | undefined;
let initializing = false, busy = false, stopped = false;
function fail(error: unknown, id?: number) {
  stopped = true;
  scope.postMessage({ type: 'failed', id, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
  runtime?.dispose(); scope.close();
}
scope.onmessage = event => {
  if (stopped) return;
  const request = event.data;
  if (request.type === 'init') {
    if (runtime || initializing) { fail(new Error('Preview simulation was already initialized')); return; }
    initializing = true;
    void PreviewSimulationRuntime.load(request.source, request.mode, request.rules).then(value => {
      if (stopped) { value.dispose(); return; }
      runtime = value; scope.postMessage({ type: 'ready', info: value.info });
    }, error => fail(error));
    return;
  }
  if (!runtime || busy) { fail(new Error('Preview simulation received an overlapping or premature call'), request.id); return; }
  busy = true;
  try { scope.postMessage({ type: 'result', id: request.id, update: runtime.execute(request) }); }
  catch (error) { fail(error, request.id); }
  finally { busy = false; }
};
