// Runs first inside the QuickJS sandbox, before any game code. It captures
// what the sandbox runtime needs, seeds Math.random, collects console output
// for the host, and freezes every built-in so game code can't change how the
// runtime (or anything else) behaves. The sandbox itself is what keeps game
// code away from the host; this keeps the runtime inside it honest.

const { defineProperty, freeze, getOwnPropertyDescriptor, getOwnPropertyNames, getPrototypeOf } = Object;
const ownKeys = Reflect.ownKeys;

export const parse = JSON.parse;
export const stringify = JSON.stringify;

// --- Deterministic randomness (mulberry32), shared by ctx.random and Math.random.
let randomState = 1;
let matchSeed = 1;
const randomStreams = new Map<string,number>();
export function seedRandom(seed: number): void {
  randomState = seed >>> 0;
  matchSeed = randomState;
  randomStreams.clear();
}
export function random(): number {
  randomState = (randomState + 0x6d2b79f5) >>> 0;
  let t = randomState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Stable named streams do not consume the shared generator or each other's draws. */
export function randomFor(stream?: string): number {
  if (stream === undefined) return random();
  if (typeof stream !== 'string' || !stream.length || stream.length > 128) throw new Error('Random stream needs a stable 1–128 character entity ID.');
  let state = randomStreams.get(stream);
  if (state === undefined) {
    if (randomStreams.size >= 1024) throw new Error('A match supports at most 1024 random streams. Reuse stable entity IDs.');
    state = (2166136261 ^ matchSeed) >>> 0;
    for (let i=0;i<stream.length;i++) state = Math.imul(state ^ stream.charCodeAt(i),16777619) >>> 0;
  }
  state = (state + 0x6d2b79f5) >>> 0;
  randomStreams.set(stream,state);
  let value=state;
  value=Math.imul(value ^ (value>>>15),value|1);
  value^=value+Math.imul(value ^ (value>>>7),value|61);
  return ((value ^ (value>>>14))>>>0)/4294967296;
}
defineProperty(Math, 'random', { value: random, writable: false, configurable: false });

// --- console: kept in a small buffer the host collects after every call.
const MAX_LOGS = 50;
const MAX_LOG_CHARS = 500;
const logs: string[] = [];

function show(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return stringify(value) ?? String(value);
  } catch {
    return '[unprintable]';
  }
}

function log(level: string, args: unknown[]): void {
  if (logs.length >= MAX_LOGS) logs.shift();
  logs.push(`${level}: ${args.map(show).join(' ')}`.slice(0, MAX_LOG_CHARS));
}

export function takeLogs(): string[] {
  return logs.splice(0, logs.length);
}

const console = {
  log: (...args: unknown[]) => log('log', args),
  info: (...args: unknown[]) => log('info', args),
  debug: (...args: unknown[]) => log('debug', args),
  warn: (...args: unknown[]) => log('warn', args),
  error: (...args: unknown[]) => log('error', args),
};
defineProperty(globalThis, 'console', { value: console, writable: false, configurable: false, enumerable: false });

/** A readable message for anything thrown by game code, without trusting it. */
export function describeError(error: unknown): string {
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}${error.stack ? `\n${String(error.stack).slice(0, 1500)}` : ''}`;
    return `Thrown: ${show(error)}`;
  } catch {
    return 'Thrown: [unprintable]';
  }
}

// --- Freeze the built-ins.

/**
 * Freezing a prototype makes assigning a property it has (like `error.name =
 * 'X'` or `obj.toString = fn`) fail on every object that inherits it. These
 * common ones become accessors that create the property on the object
 * instead, as they would without freezing.
 */
function allowOverride(proto: object, key: PropertyKey): void {
  const descriptor = getOwnPropertyDescriptor(proto, key);
  if (!descriptor || !('value' in descriptor) || !descriptor.configurable) return;
  const value: unknown = descriptor.value;
  defineProperty(proto, key, {
    get: () => value,
    set(this: object, next: unknown) {
      if (this === proto) throw new TypeError(`Built-ins are frozen: cannot set ${String(key)}`);
      defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true });
    },
    enumerable: descriptor.enumerable,
    configurable: false,
  });
}

const errorTypes = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'InternalError'];
for (const key of ownKeys(Object.prototype)) if (key !== '__proto__') allowOverride(Object.prototype, key);
for (const key of ['toString', 'constructor']) allowOverride(Function.prototype, key);
for (const name of errorTypes) {
  const type = (globalThis as Record<string, unknown>)[name] as { prototype?: object } | undefined;
  if (type?.prototype) for (const key of ['name', 'message', 'toString', 'constructor']) allowOverride(type.prototype, key);
}

const hardened = new WeakSet<object>();
function harden(value: unknown): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || hardened.has(value)) return;
  hardened.add(value);
  freeze(value);
  harden(getPrototypeOf(value));
  for (const key of ownKeys(value)) {
    const descriptor = getOwnPropertyDescriptor(value, key)!;
    harden(descriptor.value);
    harden(descriptor.get);
    harden(descriptor.set);
  }
}

// Every global that exists before game code runs is a built-in: freeze it,
// and pin the global name so game code can't swap it out either.
for (const name of getOwnPropertyNames(globalThis)) {
  if (name === 'globalThis') continue;
  const descriptor = getOwnPropertyDescriptor(globalThis, name)!;
  harden(descriptor.value);
  if (descriptor.configurable) defineProperty(globalThis, name, { ...descriptor, writable: false, configurable: false });
}
// Prototypes only reachable through syntax.
harden(getPrototypeOf(function* () {}));
harden(getPrototypeOf(async function () {}));
harden(getPrototypeOf(async function* () {}));
harden(getPrototypeOf([][Symbol.iterator]()));
harden(getPrototypeOf(new Map().entries()));
harden(getPrototypeOf(new Set().values()));
harden(getPrototypeOf(''[Symbol.iterator]()));
harden(getPrototypeOf(/x/[Symbol.matchAll]('')));

// --- The one place the runtime publishes its entry points; game code can't replace it.
// (Defined after the freeze above, which would otherwise freeze it empty.)
const holder: { entries?: Record<string, (json: string) => string> } = {};
defineProperty(globalThis, '__duel', { value: holder, writable: false, configurable: false, enumerable: false });

export function publish(entries: Record<string, (json: string) => string>): void {
  defineProperty(holder, 'entries', { value: freeze({ ...entries }), writable: false, configurable: false, enumerable: true });
  freeze(holder);
}
