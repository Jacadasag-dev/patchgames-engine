interface SnapshotClock {
  lastServerTime(): number;
  jitter(): number;
  patchInterval?(): number;
}

/** Release rate while the buffer shrinks: 25 ms per second plays the remote
 * fighter 2.5% fast, below what players notice, and returns a 150 ms spike to
 * the 50 ms floor in four seconds instead of holding it for most of a round. */
const RELEASE_PER_MS = .025;

/** A small snapshot buffer that grows for delivery jitter and releases gently.
 * Sampling server AND arrival gaps avoids treating delta-encoded idle periods
 * as congestion. Call observe for each patch, then update before render reads. */
export class InterpolationDelay {
  private readonly fallbackInterval: number;
  private delay: number;
  private desired: number;
  private deliveryJitter = 0;
  /** Valid arrival-versus-server-gap samples since the last reset. */
  private samples = 0;
  private previousArrival: number | undefined;
  private previousStamp: number | undefined;
  private previousFrame: number | undefined;

  constructor(fallbackInterval: number) {
    if (!Number.isFinite(fallbackInterval) || fallbackInterval <= 0) throw new Error('Snapshot interval must be positive');
    this.fallbackInterval = fallbackInterval;
    this.delay = this.desired = fallbackInterval * 1.5;
  }

  get value(): number { return this.delay; }
  /** Where the buffer is heading: the cadence floor plus three times the measured jitter. */
  get target(): number { return this.desired; }
  /** Smoothed arrival-versus-server gap deviation, the buffer's own jitter estimate. */
  get jitter(): number { return this.deliveryJitter; }

  /** New connection / round: old packet timing does not describe this stream. */
  reset(): void {
    this.delay = this.desired = this.fallbackInterval * 1.5;
    this.deliveryJitter = 0; this.samples = 0;
    this.previousArrival = this.previousStamp = this.previousFrame = undefined;
  }

  /** One snapshot arrived at `now`, sent at `stamp` (the clock's last patch time unless the
   * snapshot came another way, such as a fast-lane datagram). */
  observe(now: number, clock: SnapshotClock, stamp = clock.lastServerTime()): void {
    if (!Number.isFinite(now) || !Number.isFinite(stamp) || stamp <= 0) return;
    const advertised = clock.patchInterval?.();
    const interval = advertised !== undefined && Number.isFinite(advertised) && advertised > 0 ? advertised : this.fallbackInterval;
    if (this.previousStamp !== undefined && this.previousArrival !== undefined) {
      const arrivalGap = now - this.previousArrival, serverGap = stamp - this.previousStamp;
      // Duplicate timestamps contain no new timing evidence. A clock reset or a
      // suspended tab starts a new baseline rather than poisoning the estimate.
      if (serverGap === 0) return;
      if (serverGap > 0 && arrivalGap >= 0 && arrivalGap < 1000) {
        const deviation = Math.min(150, Math.abs(arrivalGap - serverGap));
        this.deliveryJitter += (deviation - this.deliveryJitter) * .25;
        this.samples++;
      } else { this.deliveryJitter = 0; this.samples = 0; }
    }
    this.previousStamp = stamp;
    this.previousArrival = now;
    // The SDK's jitter compares arrivals with the advertised cadence, so a server whose
    // ticks land unevenly (timer granularity, catch-up steps) reads as network jitter.
    // Playback already follows the server's own timestamps, which carry that unevenness;
    // only delivery jitter against them needs buffering. Use the SDK figure only until
    // this stream has given enough samples of its own.
    const reported = this.samples >= 8 ? 0 : clock.jitter();
    const jitter = Math.max(this.deliveryJitter, Number.isFinite(reported) && reported > 0 ? reported : 0);
    const base = interval * 1.5;
    this.desired = Math.min(Math.max(150, base), base + jitter * 3);
  }

  update(now: number): number {
    if (!Number.isFinite(now)) return this.delay;
    const elapsed = this.previousFrame === undefined ? 0 : Math.max(0, now - this.previousFrame);
    this.previousFrame = now;
    // Adding less delay than elapsed time keeps the playback timeline moving
    // forward. Releasing at RELEASE_PER_MS keeps the catch-up speed invisible.
    const change = this.desired - this.delay;
    this.delay += change > 0 ? Math.min(change, elapsed * .25) : Math.max(change, -elapsed * RELEASE_PER_MS);
    return this.delay;
  }
}
