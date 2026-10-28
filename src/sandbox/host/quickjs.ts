import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { loadPhysics, PhysicsBridge } from './physics.ts';
import {WaterBridge,warmWaterBridge} from './water.ts';
import { ExecutionBudget, executionClock, type ExecutionClock } from './executionBudget.ts';

// The host side of the logic sandbox, for Node and the browser alike. Game
// logic runs in QuickJS compiled to WebAssembly: a separate JavaScript
// engine with its own memory, holding only standard JavaScript. The host
// exposes bounded, versioned physics and water JSON endpoints: no host objects,
// filesystem, networking or arbitrary callbacks. Otherwise only JSON strings
// in and out. Every call has a deadline, and memory and stack are capped.

export interface SandboxLimits {
  memoryBytes: number;
  stackBytes: number;
  /** Time allowed to evaluate the bundle. */
  loadMs: number;
  /** Largest JSON answer accepted from a call. */
  maxOutputChars: number;
}

/** Trusted build-time hooks; a game cannot request them. */
export interface SandboxHooks {
  /** Receives each world plan compiled while the bundle loads (game build only). */
  worldPlanCapture?: (key: string, json: string) => void;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  loadMs: 1000,
  maxOutputChars: 1024 * 1024,
};

/** Game code failed: it threw, ran out of time or memory, or answered with something unusable. */
export class SandboxError extends Error {
  readonly logs: string[];
  constructor(message: string, logs: string[] = []) {
    super(message);
    this.name = 'SandboxError';
    this.logs = logs;
  }
}

interface CompletedReadinessBudgetFailure {
  readonly reason: 'cpu' | 'wall';
  readonly limitMs: number;
}
// Only the trusted host can classify a completed readiness hint. Authored
// errors, JSON fields and copied error properties cannot manufacture a receipt.
const completedReadinessFailures = new WeakMap<SandboxError, CompletedReadinessBudgetFailure>();
export function completedReadinessBudgetFailure(error: unknown): CompletedReadinessBudgetFailure | undefined {
  return error instanceof SandboxError ? completedReadinessFailures.get(error) : undefined;
}

/** Entry points of the logic bundle (src/sandbox/runtime.ts). */
export const LOGIC_ENTRIES = ['describe', 'setup', 'step', 'writeInput', 'predict', 'hudLines'];

// Time allowed to turn a thrown value into a message.
const DESCRIBE_MS = 50;

let loading: Promise<QuickJSWASMModule> | null = null;
let loaded: QuickJSWASMModule | null = null;

/** Whether loadQuickJS has finished in this process. */
export function quickJSReady(): boolean { return loaded !== null; }

/** Loads the QuickJS WebAssembly module once per process (or page). */
export function loadQuickJS(): Promise<QuickJSWASMModule> {
  if (!loading) {
    // Async Wasm compilation does not always retain a Node event-loop handle.
    // Keep CLI inspections alive while it finishes, with the same bounded cold
    // startup allowance as a match worker (also useful for failed browser loads).
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Game runtime initialization exceeded 15 seconds')), 15000);
    });
    loading = Promise.race([Promise.all([newQuickJSWASMModuleFromVariant(variant), loadPhysics()]).then(([module]) => module), timeout])
      .then(module => (loaded = module)).finally(() => clearTimeout(timer));
  }
  return loading;
}

function quickJS(): QuickJSWASMModule {
  if (!loaded) throw new Error('QuickJS is not loaded yet: await loadQuickJS() first');
  return loaded;
}

export class Sandbox {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly entries = new Map<string, QuickJSHandle>();
  private readonly limits: SandboxLimits;
  private disposed = false;
  private readonly physics = new PhysicsBridge();
  private readonly water = new WaterBridge();
  private budget: ExecutionBudget | undefined;
  private physicsCalls = 0;
  private physicsMs = 0;
  private waterCalls = 0;
  private waterMs = 0;
  private readonly clock: ExecutionClock;

  /**
   * Evaluates a bundle built by build.ts (lockdown, game code, then a
   * runtime that publishes its entry points) and keeps handles to those
   * entry points, so nothing game code does to globals afterwards matters.
   */
  constructor(source: string, entryNames: string[], limits: Partial<SandboxLimits> = {}, clock: ExecutionClock = executionClock, optionalEntries: readonly string[] = [], hooks: SandboxHooks = {}) {
    // Only games that reach the host water bridge pay for compiling its solver,
    // once per process and before this sandbox's own load budget starts. Warming
    // on every QuickJS load cost each match worker about half a second of CPU.
    if (source.includes('__patchduelWater')) warmWaterBridge();
    this.clock = clock;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.runtime = quickJS().newRuntime();
    this.runtime.setMemoryLimit(this.limits.memoryBytes);
    this.runtime.setMaxStackSize(this.limits.stackBytes);
    this.context = this.runtime.newContext();
    try {
      const budget = this.beginBudget(this.limits.loadMs);
      const physics = this.context.newFunction('__patchduelPhysics', (arg) => {
        if (this.budget!.expired()) return { error: this.context.newError('Physics call exceeded sandbox deadline') };
        if (!arg || this.context.typeof(arg) !== 'string') return { error: this.context.newError('Physics accepts only a JSON string') };
        const started = performance.now();
        this.physicsCalls++;
        try {
          const output = this.physics.dispatch(this.context.getString(arg));
          // Native work is bounded by the physics schemas, but cannot be
          // interrupted by QuickJS. Reject its result if it used the budget.
          if (this.budget!.expired()) return { error: this.context.newError('Physics call exceeded sandbox deadline') };
          return this.context.newString(output);
        }
        finally { this.physicsMs += performance.now() - started; }
      });
      this.context.setProp(this.context.global, '__patchduelPhysics', physics);
      physics.dispose();
      const water=this.context.newFunction('__patchduelWater',(arg)=>{
        if(this.budget!.expired())return{error:this.context.newError('Water call exceeded sandbox deadline')};
        if(!arg||this.context.typeof(arg)!=='string')return{error:this.context.newError('Water accepts only a JSON string')};
        const started=performance.now();this.waterCalls++;
        try{
          const output=this.water.dispatch(this.context.getString(arg));
          // Host work is bounded by water manifests/state and shares the current
          // guest CPU/wall budget. A late host result is never accepted.
          if(this.budget!.expired())return{error:this.context.newError('Water call exceeded sandbox deadline')};
          return this.context.newString(output);
        }finally{this.waterMs+=performance.now()-started;}
      });
      this.context.setProp(this.context.global,'__patchduelWater',water);water.dispose();
      if (hooks.worldPlanCapture) {
        const capture = hooks.worldPlanCapture, record = this.context.newFunction('__patchduelWorldPlanCapture', (key, json) => {
          if (!key || !json || this.context.typeof(key) !== 'string' || this.context.typeof(json) !== 'string')
            return { error: this.context.newError('World plan capture accepts only a key and JSON string') };
          capture(this.context.getString(key), this.context.getString(json));
        });
        this.context.setProp(this.context.global, '__patchduelWorldPlanCapture', record); record.dispose();
      }
      const result = this.context.evalCode(source, 'game.js');
      if (result.error) {
        this.beginBudget(DESCRIBE_MS);
        throw new SandboxError(`Loading the game failed: ${this.describe(result.error)}`);
      }
      if (budget.expired()) {
        result.value.dispose();
        throw new SandboxError('Loading the game failed: execution deadline exceeded');
      }
      result.value.dispose();

      // Every handle is released on every path: a leaked one aborts QuickJS when the runtime is freed.
      const holder = this.context.getProp(this.context.global, '__duel');
      const published = this.context.getProp(holder, 'entries');
      holder.dispose();
      try {
        for (const name of [...entryNames, ...optionalEntries]) {
          const handle = this.context.getProp(published, name);
          if (optionalEntries.includes(name) && this.context.typeof(handle) === 'undefined') { handle.dispose(); continue; }
          if (this.context.typeof(handle) !== 'function') {
            handle.dispose();
            throw new SandboxError(`The game bundle has no "${name}" entry point`);
          }
          this.entries.set(name, handle);
        }
      } finally {
        published.dispose();
      }
      this.runtime.removeInterruptHandler();
    } catch (error) {
      this.dispose();
      throw error instanceof SandboxError ? error : new SandboxError(String(error));
    }
  }

  /** Live server steps may budget executing-thread CPU with a bounded wall backstop. */
  hasEntry(name: string): boolean { return this.entries.has(name); }

  call<T = unknown>(entry: string, arg: unknown, deadlineMs: number, maxOutputChars = this.limits.maxOutputChars,
    options: { threadCpu?: boolean } = {}): { value: T; logs: string[] } {
    if (this.disposed) throw new SandboxError('The sandbox was disposed');
    const handle = this.entries.get(entry);
    if (!handle) throw new SandboxError(`Unknown entry point "${entry}"`);

    const argument = this.context.newString(JSON.stringify(arg ?? null));
    this.physicsCalls = 0;
    this.physicsMs = 0;
    this.waterCalls = 0;
    this.waterMs = 0;
    const budget = this.beginBudget(deadlineMs, options.threadCpu === true);
    const result = this.context.callFunction(handle, this.context.undefined, argument);
    const failedDuringCall = budget.snapshot().reason !== null;
    argument.dispose();

    const expired = budget.expired();
    if (result.error) {
      // Printing the error can run game code (a thrown object's toJSON), so it gets a deadline too.
      this.beginBudget(DESCRIBE_MS);
      const message = this.describe(result.error);
      this.runtime.removeInterruptHandler();
      const reason = /interrupted/.test(message) ? `${entry} took longer than ${deadlineMs}ms and was stopped` : `${entry}: ${message}`;
      throw this.failure(reason, deadlineMs, [], budget);
    }
    // A final native call or short return path may finish before the VM's next
    // interrupt callback. Never accept an answer after either limit was crossed.
    if (expired) {
      const text = this.context.typeof(result.value) === 'string' ? this.context.getString(result.value) : '';
      result.value.dispose();
      this.runtime.removeInterruptHandler();
      const reason = budget.snapshot().reason;
      const detail = reason === 'wall' && budget.mode === 'thread-cpu' ? `${budget.wallLimitMs}ms wall backstop`
        : reason === 'clock' ? 'execution clock unavailable' : `${deadlineMs}ms${budget.mode === 'thread-cpu' ? ' of thread CPU' : ''}`;
      // Preserve an existing runtime diagnostic (for example memory exhaustion)
      // while still rejecting every over-budget answer, including successful ones.
      let diagnostic = '';
      let completedReadiness = false;
      if (text.length <= maxOutputChars) try {
        const envelope = JSON.parse(text) as { ok?: unknown; error?: unknown; logs?: unknown } | null;
        if (typeof envelope?.error === 'string') diagnostic = `: ${envelope.error.slice(0, 2000)}`;
        completedReadiness = entry === 'preparationReady' && !failedDuringCall && (reason === 'cpu' || reason === 'wall')
          && envelope !== null && !Array.isArray(envelope) && typeof envelope.ok === 'boolean'
          && Object.keys(envelope).every(key => key === 'ok' || key === 'logs')
          && (envelope.logs === undefined || Array.isArray(envelope.logs) && envelope.logs.every(line => typeof line === 'string'));
      } catch { /* The expired call is rejected regardless of its output. */ }
      const error = this.failure(`${entry} took longer than ${detail} and was stopped${diagnostic}`, deadlineMs, [], budget);
      if (completedReadiness) completedReadinessFailures.set(error, Object.freeze({ reason: reason as 'cpu' | 'wall', limitMs: deadlineMs }));
      throw error;
    }
    this.runtime.removeInterruptHandler();
    const kind = this.context.typeof(result.value);
    const text = kind === 'string' ? this.context.getString(result.value) : '';
    result.value.dispose();
    if (kind !== 'string') throw new SandboxError(`${entry} did not answer with JSON`);
    if (text.length > maxOutputChars) throw new SandboxError(`${entry} answered with ${text.length} characters (limit ${maxOutputChars})`);

    let envelope: { ok?: unknown; error?: unknown; logs?: unknown };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new SandboxError(`${entry} did not answer with JSON`);
    }
    const logs = Array.isArray(envelope.logs) ? envelope.logs.filter((line): line is string => typeof line === 'string').slice(0, 50) : [];
    if (typeof envelope.error === 'string') throw this.failure(`${entry}: ${envelope.error.slice(0, 2000)}`, deadlineMs, logs, budget);
    return { value: envelope.ok as T, logs };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.entries.values()) handle.dispose();
    this.entries.clear();
    this.physics.dispose();
    this.water.dispose();
    this.context.dispose();
    this.runtime.dispose();
  }

  private beginBudget(limitMs: number, threadCpu = false): ExecutionBudget {
    const budget = this.budget = new ExecutionBudget(limitMs, threadCpu, this.clock);
    this.runtime.setInterruptHandler(() => budget.expired());
    return budget;
  }

  private failure(reason: string, deadlineMs: number, logs: string[] = [], budget?: ExecutionBudget): SandboxError {
    // Include errors caught by the JSON runtime envelope, not just raw VM errors.
    // Timing precedes embedded stack frames so reporters retain it.
    const newline = reason.indexOf('\n');
    const first = newline < 0 ? reason : reason.slice(0, newline);
    const stack = newline < 0 ? '' : reason.slice(newline);
    const measured = budget?.snapshot();
    const timing = measured?.mode === 'thread-cpu'
      ? `; thread CPU ${measured.cpuMs === undefined ? 'unavailable' : measured.cpuMs.toFixed(2) + 'ms'}; wall ${measured.wallMs.toFixed(2)}ms/${measured.wallLimitMs}ms` : '';
    const water=this.waterCalls?`; native water calls ${this.waterCalls}, time ${this.waterMs.toFixed(2)}ms`:'';
    return new SandboxError(`${first} [Sandbox budget ${deadlineMs}ms; native physics calls ${this.physicsCalls}, time ${this.physicsMs.toFixed(2)}ms${water}${timing}]${stack}`, logs);
  }

  private describe(errorHandle: QuickJSHandle): string {
    try {
      const dumped = this.context.dump(errorHandle) as { name?: unknown; message?: unknown; stack?: unknown } | unknown;
      if (dumped && typeof dumped === 'object' && 'message' in dumped) {
        const { name, message, stack } = dumped as { name?: unknown; message?: unknown; stack?: unknown };
        return `${String(name ?? 'Error')}: ${String(message)}${stack ? `\n${String(stack).slice(0, 1500)}` : ''}`.slice(0, 2000);
      }
      return String(dumped).slice(0, 2000);
    } catch {
      return 'unknown error';
    } finally {
      errorHandle.dispose();
    }
  }
}
