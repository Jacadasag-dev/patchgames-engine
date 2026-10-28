import { rendererReplayQuality } from './rendererReplay.ts';

interface RendererLoadingBoundaryOptions {
  /** Null after this room has been left or replaced. */
  frame(): unknown;
  canPrepare(frame: unknown): boolean;
  prepare(frame: unknown, allowed: () => boolean, subscribe: (listener: () => void) => () => void): Promise<void>;
  subscribe(listener: () => void): () => void;
  onError(error: unknown): void;
}

function loadingKey(frame: unknown): string | null {
  if (!frame || typeof frame !== 'object') return null;
  const phase = (frame as { phase?: unknown }).phase;
  // Rematches move directly from ended to countdown; neither countdown nor an
  // active game is a safe place to rebuild a renderer or compare backends.
  if (phase !== 'waiting' && phase !== 'ended') return null;
  const quality = rendererReplayQuality(frame);
  return quality ? `${phase}:${quality}` : null;
}

/** Revisit renderer selection between rounds in a persistent multiplayer room.
 * A short quiet period lets roster/tuning changes settle without restarting the
 * view for every room patch. The live predicate cancels a comparison immediately
 * when that loading context changes, including when the next countdown starts. */
export class RendererLoadingBoundary {
  private readonly options: RendererLoadingBoundaryOptions;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentKey: string | null = null;
  private attempted = false;
  private running = false;
  private disposed = false;

  constructor(options: RendererLoadingBoundaryOptions) {
    this.options = options;
    this.unsubscribe = options.subscribe(() => this.changed());
    this.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.unsubscribe();
    // The preparation owns cancellation and worker cleanup. Notify its existing
    // environment subscription rather than allowing it to finish after leaving.
    for (const listener of this.listeners) listener();
  }

  private changed(): void {
    if (this.disposed) return;
    const frame = this.options.frame();
    const key = loadingKey(frame);
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.attempted = false;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const listener of this.listeners) listener();
    if (key && !this.running && !this.timer && !this.attempted && this.options.canPrepare(frame)) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.prepare(key); }, 500);
    }
  }

  private async prepare(key: string): Promise<void> {
    const frame = this.options.frame();
    if (this.disposed || this.running || key !== this.currentKey || loadingKey(frame) !== key
      || !this.options.canPrepare(frame)) return;
    this.attempted = true;
    this.running = true;
    const allowed = () => !this.disposed && this.currentKey === key && loadingKey(this.options.frame()) === key;
    try {
      await this.options.prepare(frame, allowed, listener => {
        this.listeners.add(listener);
        if (!allowed()) listener();
        return () => { this.listeners.delete(listener); };
      });
    } catch (error) {
      if (allowed()) this.options.onError(error);
    } finally {
      this.running = false;
      this.changed();
    }
  }
}
