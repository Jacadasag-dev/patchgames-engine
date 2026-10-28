import { beforeAll } from 'vitest';

/**
 * Trusted engine/index initialization is fixture setup, not authored behavior.
 * The QuickJS loader retains its own 15-second combined engine startup deadline;
 * this outer allowance lets that failure surface instead of a 10-second hook
 * cutting it off first. Physics-only callers do not load QuickJS unnecessarily.
 * Keep fixture builds and behavioral assertions in their ordinary hooks/tests.
 */
export function beforeRuntimeInitialization(initialize: () => unknown): void {
  beforeAll(async () => { await initialize(); }, 20_000);
}
