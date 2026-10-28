import type { MatchSandbox, MatchUpdate } from '../../sandbox/host/match.ts';
import type { GameInfo } from '../../shared/shapes.ts';
import type { GameModeId } from '../../shared/gameModes.ts';

export type PreviewRules = Pick<GameInfo, 'tags' | 'roster'>;
type Operation = 'setup' | 'step';
export type PreviewSimulationRequest = { type: 'init'; source: string; mode?: GameModeId; rules?: PreviewRules } | {
  [K in Operation]: { type: 'call'; id: number; operation: K; args: Parameters<MatchSandbox[K]> }
}[Operation];
export type PreviewSimulationResponse = { type: 'ready'; info: GameInfo }
  | { type: 'result'; id: number; update: MatchUpdate }
  | { type: 'failed'; id?: number; error: string };

/** One persistent browser worker owns the preview VM and native physics.
 * No operation queue: a slow generation cannot accumulate animation ticks. */
export class PreviewSimulation {
  readonly ready: Promise<GameInfo>;
  private readonly worker: Worker;
  private resolveReady!: (info: GameInfo) => void;
  private rejectReady!: (error: Error) => void;
  private initialized = false;
  private stopped = false;
  private nextId = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: { id: number; resolve(update: MatchUpdate): void; reject(error: Error): void } | undefined;

  constructor(source: string, mode?: GameModeId, rules?: PreviewRules) {
    this.worker = new Worker(new URL('./previewSimulationWorker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.worker.onmessage = (event: MessageEvent<PreviewSimulationResponse>) => {
      if (this.stopped) return;
      const message = event.data;
      if (message?.type === 'failed') { this.dispose(new Error(message.error)); return; }
      if (message?.type === 'ready' && !this.initialized && !this.active) {
        clearTimeout(this.timer); this.initialized = true; this.resolveReady(message.info); return;
      }
      if (message?.type !== 'result' || !this.active || message.id !== this.active.id) {
        this.dispose(new Error('Preview simulation answered out of sequence')); return;
      }
      clearTimeout(this.timer);
      const request = this.active; this.active = undefined; request.resolve(message.update);
    };
    this.worker.onerror = () => this.dispose(new Error('Preview simulation worker stopped'));
    this.worker.onmessageerror = () => this.dispose(new Error('Preview simulation returned invalid data'));
    this.timer = setTimeout(() => this.dispose(new Error('Preview simulation startup exceeded its time limit')), 15_000);
    try { this.worker.postMessage({ type: 'init', source, mode, rules } satisfies PreviewSimulationRequest); }
    catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))); }
  }

  setup(...args: Parameters<MatchSandbox['setup']>): Promise<MatchUpdate> { return this.call({ type: 'call', id: this.nextId++, operation: 'setup', args }); }
  step(...args: Parameters<MatchSandbox['step']>): Promise<MatchUpdate> { return this.call({ type: 'call', id: this.nextId++, operation: 'step', args }); }

  dispose(error = new Error('Preview simulation was cancelled')): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.worker.terminate();
    this.rejectReady(error);
    const active = this.active; this.active = undefined; active?.reject(error);
  }

  private call(request: Extract<PreviewSimulationRequest, { type: 'call' }>): Promise<MatchUpdate> {
    if (this.stopped) return Promise.reject(new Error('Preview simulation is disposed'));
    if (!this.initialized) return Promise.reject(new Error('Preview simulation is not ready'));
    if (this.active) return Promise.reject(new Error('Preview simulation already has a request in flight'));
    return new Promise((resolve, reject) => {
      this.active = { id: request.id, resolve, reject };
      // Includes bounded terrain preparation, then the ordinary setup/tick VM budget.
      this.timer = setTimeout(() => this.dispose(new Error('Preview simulation exceeded its time limit')), 30_000);
      try { this.worker.postMessage(request); }
      catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
