import type { MatchInterest } from '../../sandbox/host/match.ts';

export interface TerrainPreparationRequest {
  id: number;
  tuning: unknown;
  world?: unknown;
  interests: readonly MatchInterest[];
}
export type TerrainPreparationMessage = { type: 'init'; source: string } | ({ type: 'prepare' } & TerrainPreparationRequest);
export type TerrainPreparationResponse = { type: 'prepared'; id: number; cache: unknown } | { type: 'failed'; id?: number; error: string };
interface Work { key: string; identity: string; request: TerrainPreparationRequest }

/** Terrain generation has one active request and one replaceable latest request.
 * Only compiled data crosses back; asynchronous predictions are never applied. */
export class TerrainPreparationClient {
  private readonly worker: Worker;
  private active: Work | undefined;
  private latest: Work | undefined;
  private nextId = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly accept: (key: string, cache: unknown) => void;
  private readonly failure: (error: string) => void;

  constructor(source: string, accept: (key: string, cache: unknown) => void, failure: (error: string) => void) {
    this.accept = accept;
    this.failure = failure;
    this.worker = new Worker(new URL('./terrainPreparationWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<TerrainPreparationResponse>) => {
      if (this.stopped) return;
      const message = event.data;
      if (message.type === 'failed') { this.fail(message.error); return; }
      if (!this.active || message.id !== this.active.request.id) { this.fail('Terrain preparation answered out of sequence'); return; }
      const work = this.active;
      clearTimeout(this.timer);
      this.active = undefined;
      this.accept(work.key, message.cache);
      this.dispatch();
    };
    this.worker.onerror = () => this.fail('Terrain preparation worker stopped');
    this.worker.onmessageerror = () => this.fail('Terrain preparation worker returned invalid data');
    this.worker.postMessage({ type: 'init', source } satisfies TerrainPreparationMessage);
  }

  request(key: string, tuning: unknown, interests: readonly MatchInterest[], world?: unknown): void {
    if (this.stopped) return;
    const identity = JSON.stringify([key, tuning, interests]);
    // Returning to the active interest cancels an obsolete queued movement.
    if (this.active?.identity === identity) { this.latest = undefined; return; }
    if (this.latest?.identity === identity) return;
    // Overwrite, never append: camera/input updates cannot accumulate work.
    this.latest = { key, identity, request: structuredClone({ id: this.nextId++, tuning, interests, world }) };
    this.dispatch();
  }

  dispose(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.active = this.latest = undefined;
    this.worker.terminate();
  }

  /** A completed lookahead will be checked against the latest position after
   * adoption. Do not let an obsolete queued position restart that adoption. */
  cancelQueued(key:string):void { if(this.latest?.key===key)this.latest=undefined; }

  private dispatch() {
    if (this.stopped || this.active || !this.latest) return;
    const work = this.active = this.latest;
    this.latest = undefined;
    this.timer = setTimeout(() => this.fail('Terrain preparation exceeded its time limit'), 30_000);
    this.worker.postMessage({ type: 'prepare', ...work.request } satisfies TerrainPreparationMessage);
  }

  private fail(error: string) {
    if (this.stopped) return;
    this.dispose();
    this.failure(error);
  }
}
