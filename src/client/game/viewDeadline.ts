/** One bounded terrain preparation phase per frame. Repeated progress messages
 * cannot extend the deadline; ordinary rendering keeps its shorter watchdog. */
export class ViewFrameDeadline {
  private sentAt: number | null = null;
  private deadline = 0;
  private phase: 'ordinary' | 'preparing' | 'prepared' = 'ordinary';
  private readonly renderMs: number;
  private readonly prepareMs: number;
  constructor(renderMs = 3000, prepareMs = 30000) { this.renderMs = renderMs; this.prepareMs = prepareMs; }
  get pending(): boolean { return this.sentAt !== null; }
  start(now: number): void { this.sentAt = now; this.deadline = now + this.renderMs; this.phase = 'ordinary'; }
  stop(): void { this.sentAt = null; }
  expired(now: number): boolean { return this.pending && now > this.deadline; }
  terrainReady(ready: boolean, now: number): void {
    if (this.sentAt === null || this.expired(now)) return;
    if (!ready && this.phase === 'ordinary') {
      this.phase = 'preparing'; this.deadline = this.sentAt + this.prepareMs;
    } else if (ready && this.phase === 'preparing') {
      this.phase = 'prepared'; this.deadline = Math.min(now + this.renderMs, this.sentAt + this.prepareMs + this.renderMs);
    }
  }
}
