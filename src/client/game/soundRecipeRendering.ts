import type { SoundRecipe } from '../../shared/soundRecipes.ts';
import type { SoundSamples } from '../../shared/soundRecipeRenderer.ts';
import type { SoundAuditionInput, RenderedSoundPreview } from '../../shared/soundBehaviorPreview.ts';

export interface SoundRenderRequest { id: number; recipe: SoundRecipe; sources: [string, SoundSamples][]; audition?: SoundAuditionInput }
export type SoundRenderReply = { id: number; sound: RenderedSoundPreview } | { id: number; error: string };
export interface SoundRenderer {
  render(recipe: SoundRecipe, sources: Map<string, SoundSamples>, audition?: SoundAuditionInput): Promise<RenderedSoundPreview>;
  dispose(): void;
}

interface PendingRender {
  resolve: (value: RenderedSoundPreview) => void;
  reject: (error: Error) => void;
  request: SoundRenderRequest;
  transfer: ArrayBuffer[];
  timer?: ReturnType<typeof setTimeout>;
}

/** A worker isolates even the most expensive permitted recipe from game/UI frames. */
export class SoundRecipeRendering implements SoundRenderer {
  private readonly worker: Worker;
  private readonly jobs = new Map<number, PendingRender>();
  private nextId = 1;
  private activeId: number | undefined;
  private disposed = false;

  constructor(createWorker: () => Worker = () => new Worker(new URL('./soundRecipeWorker.ts', import.meta.url), { type: 'module' })) {
    this.worker = createWorker();
    this.worker.onmessage = (event: MessageEvent<SoundRenderReply>) => {
      const message = event.data, job = this.jobs.get(message.id);
      if (!job || message.id !== this.activeId) return;
      clearTimeout(job.timer); this.jobs.delete(message.id); this.activeId = undefined;
      if ('error' in message) job.reject(new Error(message.error)); else job.resolve(message.sound);
      this.startNext();
    };
    this.worker.onerror = () => this.fail('Sound preparation worker failed.');
    this.worker.onmessageerror = () => this.fail('Sound preparation worker returned invalid data.');
  }

  render(recipe: SoundRecipe, sources: Map<string, SoundSamples>, audition?: SoundAuditionInput): Promise<RenderedSoundPreview> {
    if (this.disposed) return Promise.reject(new Error('Sound preparation worker was disposed.'));
    if (this.jobs.size >= 4) return Promise.reject(new Error('Sound preparation queue is full.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      try {
        // Transfer private copies; shared source cache buffers must remain usable by other recipes.
        const copies: [string, SoundSamples][] = [...sources].map(([key, source]) => [key,
          { sampleRate: source.sampleRate, channels: source.channels.map(channel => new Float32Array(channel)) }]);
        const transfer = copies.flatMap(([, source]) => source.channels.map(channel => channel.buffer as ArrayBuffer));
        // Snapshot queued inputs now, matching postMessage's immediate clone semantics.
        this.jobs.set(id, { resolve, reject, request: { id, recipe: structuredClone(recipe), sources: copies,
          ...(audition ? { audition: structuredClone(audition) } : {}) }, transfer });
        this.startNext();
      } catch (error) {
        this.jobs.delete(id); reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private startNext(): void {
    if (this.disposed || this.activeId !== undefined) return;
    const next = this.jobs.entries().next().value;
    if (!next) return;
    const [id, job] = next;
    this.activeId = id;
    // A queued job does not consume another job's CPU budget. Maximum four jobs
    // remain bounded, and an active timeout still cancels the worker and queue.
    job.timer = setTimeout(() => this.fail('Sound preparation exceeded its 15 second time budget.'), 15_000);
    try { this.worker.postMessage(job.request, job.transfer); }
    catch (error) {
      clearTimeout(job.timer); this.jobs.delete(id); this.activeId = undefined;
      job.reject(error instanceof Error ? error : new Error(String(error)));
      this.startNext();
    }
  }

  private fail(message: string): void {
    if (this.disposed) return;
    this.disposed = true; this.activeId = undefined; this.worker.terminate();
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(new Error(message)); }
    this.jobs.clear();
  }

  dispose(): void { this.fail('Sound preparation worker was disposed.'); }
}
