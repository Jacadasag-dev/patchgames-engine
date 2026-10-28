import { executionClockCapability } from './executionClock.ts';

/** Trusted host clocks. None of these functions are exposed to game code. */
export interface ExecutionClock {
  wallNow(): number;
  /** Milliseconds of user + system CPU on the current executing thread. */
  threadCpuNow?: () => number;
}

const wallNow = performance.now.bind(performance);
export const executionClock: ExecutionClock = {
  wallNow,
  // Native Linux retains thread CPU accounting; gVisor, browsers, other
  // platforms and unknown capabilities keep the original strict wall limits.
  ...(executionClockCapability.threadCpuNow ? { threadCpuNow: executionClockCapability.threadCpuNow } : {}),
};

export type BudgetFailure = 'cpu' | 'wall' | 'clock';
/** CPU accounting tolerates scheduler pauses, but never an unbounded wall stall. */
const LIVE_WALL_LIMIT_MS = 100;

/** A bounded allowance for occasional slow live ticks. Cheap ticks repay the
 * credit; sustained expensive ticks cannot keep receiving the burst allowance.
 * Charge elapsed wall time conservatively, including scheduling and GC. */
export class ExecutionBurstBudget {
  private credit:number;
  readonly baselineMs:number;
  constructor(baselineMs:number){
    if(!Number.isFinite(baselineMs)||baselineMs<=0)throw new Error('Invalid live execution baseline');
    this.baselineMs=baselineMs;
    this.credit=baselineMs;
  }
  get limitMs():number{return this.baselineMs+this.credit;}
  charge(elapsedMs:number):void{
    this.credit=Number.isFinite(elapsedMs)&&elapsedMs>=0
      ?Math.max(0,Math.min(this.baselineMs,this.credit+this.baselineMs-elapsedMs)):0;
  }
}

export class ExecutionBudget {
  readonly limitMs: number;
  readonly mode: 'thread-cpu' | 'wall';
  readonly wallLimitMs: number;
  private readonly wallStart: number;
  private readonly cpuStart: number | undefined;
  private failure: BudgetFailure | null = null;
  private wallMs = 0;
  private clockWallMs = 0;
  private lastWall: number;
  private cpuMs: number | undefined;
  private readonly clock: ExecutionClock;

  constructor(limitMs: number, preferThreadCpu = false, clock: ExecutionClock = executionClock, nativeCreditMs = 0) {
    if (!Number.isFinite(limitMs) || limitMs < 0) throw new Error('Invalid sandbox execution budget');
    // Trusted live hosts may spend at most one baseline of available burst credit.
    // Select it only after proving the CPU clock is usable for this operation;
    // absent/broken clocks and strict wall callers retain their original limit.
    if (!Number.isFinite(nativeCreditMs) || nativeCreditMs < 0 || nativeCreditMs > limitMs) throw new Error('Invalid native execution credit');
    this.clock = clock;
    this.wallStart = clock.wallNow();
    this.lastWall = this.wallStart;
    // Browsers and older Node versions retain the original wall-time limit.
    // A clock unavailable at entry must not silently grant extra execution time.
    if (preferThreadCpu && clock.threadCpuNow) {
      try {
        const value = this.sampleThreadCpu();
        if (Number.isFinite(value) && value >= 0) this.cpuStart = value;
      } catch { /* Fall back to the strict wall budget. */ }
    }
    this.mode = this.cpuStart === undefined ? 'wall' : 'thread-cpu';
    this.limitMs = limitMs + (this.mode === 'thread-cpu' ? nativeCreditMs : 0);
    this.wallLimitMs = this.mode === 'thread-cpu' ? LIVE_WALL_LIMIT_MS : limitMs;
  }

  private sampleThreadCpu(): number {
    const before = this.clock.wallNow();
    if (!Number.isFinite(before) || !Number.isFinite(this.lastWall) || before < this.lastWall) {
      this.failure = 'clock'; return Number.NaN;
    }
    const value = this.clock.threadCpuNow!();
    const after = this.clock.wallNow();
    if (!Number.isFinite(after) || after < before) { this.failure = 'clock'; return Number.NaN; }
    // Guest execution is stopped during this trusted measurement. In runsc a
    // CPU-clock read can itself wait several milliseconds. Count that interval
    // in the full wall backstop, but not in the authored operation's CPU cap.
    this.clockWallMs += after - before;
    this.lastWall = after;
    this.wallMs = after - this.wallStart;
    return value;
  }

  /** Sticky: catching a bridge error cannot reset or evade the execution limit. */
  expired(): boolean {
    if (this.failure) return true;
    try {
      // Sample CPU inside the wall interval. Linux accounting can publish a
      // delayed scheduler quantum (for example 4ms during a 0.16ms query), so
      // its delta alone is not a physical bound on this call's execution.
      const cpuNow = this.cpuStart === undefined ? undefined : this.sampleThreadCpu();
      const wallNow = this.clock.wallNow();
      this.wallMs = wallNow - this.wallStart;
      if (!Number.isFinite(wallNow) || !Number.isFinite(this.wallMs) || wallNow < this.lastWall || this.wallMs < 0) this.failure = 'clock';
      else if (!this.failure && this.wallMs >= this.wallLimitMs) this.failure = 'wall';
      this.lastWall = wallNow;
      if (!this.failure && this.cpuStart !== undefined) {
        const measuredCpuMs = cpuNow! - this.cpuStart;
        if (!Number.isFinite(measuredCpuMs) || measuredCpuMs < 0) this.failure = 'clock';
        else {
          // Authored execution cannot exceed wall time outside CPU sampling.
          // Do not subtract sampler wall time from raw CPU: a slow read may
          // have waited without consuming CPU. Other host work and GC remain
          // charged, and repeated measurements cannot evade the wall backstop.
          this.cpuMs = Math.min(measuredCpuMs, Math.max(0, this.wallMs - this.clockWallMs));
          if (this.cpuMs >= this.limitMs) this.failure = 'cpu';
        }
      }
    } catch { this.failure = 'clock'; }
    return this.failure !== null;
  }

  snapshot() {
    return { mode: this.mode, reason: this.failure, wallMs: this.wallMs, cpuMs: this.cpuMs, clockWallMs: this.clockWallMs, wallLimitMs: this.wallLimitMs };
  }
}
