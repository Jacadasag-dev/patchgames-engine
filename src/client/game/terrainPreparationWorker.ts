import { TerrainPreparationRuntime } from './terrainPreparationRuntime.ts';
import type { TerrainPreparationMessage, TerrainPreparationResponse } from './terrainPreparation.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TerrainPreparationMessage>) => void) | null;
  postMessage(message: TerrainPreparationResponse): void;
  close(): void;
};
let runtime: Promise<TerrainPreparationRuntime> | undefined;
let busy = false;
let stopped = false;
const fail = (error: unknown, id?: number) => {
  stopped = true;
  scope.postMessage({ type: 'failed', id, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
  void runtime?.then(value => value.dispose(), () => {});
  scope.close();
};
scope.onmessage = event => {
  if (stopped) return;
  const message = event.data;
  if (message.type === 'init') {
    if (runtime) { fail(new Error('Terrain worker was already initialized')); return; }
    runtime = TerrainPreparationRuntime.load(message.source);
    void runtime.catch(error => fail(error));
    return;
  }
  if (!runtime || busy) { fail(new Error('Terrain worker received overlapping preparation'), message.id); return; }
  busy = true;
  void runtime.then(value => value.prepare(message)).then(cache => {
    if (!stopped) scope.postMessage({ type: 'prepared', id: message.id, cache });
    busy = false;
  }, error => fail(error, message.id));
};
