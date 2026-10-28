import { ExecutionBudget, executionClock, type ExecutionClock } from './executionBudget.ts';
import { SandboxError } from './quickjs.ts';

/** A separate trusted host pass: never exposed to the game's damage formulas. */
export function createDamageCheckpoint(deadlineMs: number, threadCpu = false, clock: ExecutionClock = executionClock, nativeCreditMs = 0): () => void {
  const budget = new ExecutionBudget(deadlineMs, threadCpu, clock, nativeCreditMs);
  return () => {
    if (!budget.expired()) return;
    const timing = budget.snapshot();
    const detail = timing.reason === 'clock' ? 'execution clock unavailable'
      : timing.reason === 'wall' ? `${budget.wallLimitMs}ms wall limit`
        : `${budget.limitMs}ms of thread CPU`;
    throw new SandboxError(`Host damage pass exceeded ${detail} [thread CPU ${timing.cpuMs === undefined ? 'unavailable' : timing.cpuMs.toFixed(2) + 'ms'}; wall ${timing.wallMs.toFixed(2)}ms/${budget.wallLimitMs}ms]`);
  };
}
