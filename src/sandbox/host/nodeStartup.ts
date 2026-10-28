/**
 * Compile trusted QuickJS/Rapier Wasm before live ticks and bound compiler
 * concurrency on two-CPU hosts. Backend and test workers must use the same
 * startup policy so live-budget checks exercise the production runtime.
 */
export const SANDBOX_NODE_EXEC_ARGV = [
  '--no-liftoff',
  '--no-wasm-lazy-compilation',
  '--v8-pool-size=1',
] as const;
