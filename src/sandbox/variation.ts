/** General deterministic variation. This module chooses values and expands
 * bounded plain data; geometry, physics and material validation remain with
 * their existing consumers. It does not change any legacy random sequence. */
export interface VariationOptions { seed: number; id: string; version: string; instanceId: string }
export interface VariationNumberOptions { min: number; max: number; step?: number }
export interface VariationChoice<T> { id: string; weight?: number; value: T }
export interface VariationContext {
  scope(id: string): VariationContext;
  unit(key: string): number;
  number(key: string, options: VariationNumberOptions): number;
  integer(key: string, min: number, max: number): number;
  chance(key: string, probability: number): boolean;
  choice<T>(key: string, choices: readonly VariationChoice<T>[]): T;
  repeat<T>(key: string, count: number, generate: (context: VariationContext, index: number) => T): T[];
}
export interface VariationExpansionLimits {
  maxDepth: number; maxNodes: number; maxChildren: number;
  /** Shared UTF-8 JSON budget for copied states and emitted node data. Default 64KiB. */
  maxDataBytes?: number;
}
export interface VariationRoot<TState> { id: string; state: TState }
export interface VariationVisitNode<TState> {
  /** JSON path array: distinct segments cannot collide through punctuation. */
  id: string; parentId?: string; depth: number; state: TState; terminal: boolean;
}
export interface VariationVisitResult<TState, TValue> { value: TValue; children?: readonly VariationRoot<TState>[] }
export interface VariationExpandedNode<TValue> { id: string; parentId?: string; depth: number; value: TValue }
export interface VariationExpansionIssue { code: string; message: string; id?: string }
export interface VariationExpansionResult<TValue> {
  nodes: readonly VariationExpandedNode<TValue>[];
  diagnostics: { valid: boolean; visited: number; issues: readonly VariationExpansionIssue[] };
}
export interface VariationExpansionRequest<TState> {
  context: VariationContext; roots: readonly VariationRoot<TState>[]; limits: VariationExpansionLimits;
}
export const VARIATION_LIMITS = Object.freeze({ keyLength: 128, instanceIdLength: 8192, scopeDepth: 32, choices: 512, repeat: 512,
  maxDepth: 16, maxNodes: 512, maxChildren: 64, maxDataBytes: 1024 * 1024, dataDepth: 32, dataNodes: 65536, issues: 64 });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(input: unknown, allowed: readonly string[], label: string): asserts input is Record<string, unknown> {
  if (!plain(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error(`${label} needs supported plain fields.`);
}
function name(value: unknown, label: string, maximum: number = VARIATION_LIMITS.keyLength): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > maximum) throw new Error(`${label} needs a nonempty string of at most ${maximum} characters.`);
}
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15; value = Math.imul(value, 0x846ca68b); return (value ^ value >>> 16) >>> 0;
}
interface ContextIdentity { base: readonly [number, string, string, string]; path: readonly string[] }
const identities = new WeakMap<VariationContext, ContextIdentity>();
function context(identity: ContextIdentity): VariationContext {
  // Hash a canonical tuple for every roll. Delimiters in user IDs have no
  // structural meaning, and no call advances a random stream.
  const unit = (key: string): number => {
    name(key, 'Variation key'); return hash(JSON.stringify([identity.base, identity.path, key])) / 4294967296;
  };
  const value: VariationContext = {
    scope(id) {
      name(id, 'Variation scope');
      if (identity.path.length >= VARIATION_LIMITS.scopeDepth) throw new Error('Variation scope exceeds its depth budget.');
      return context({ base: identity.base, path: Object.freeze([...identity.path, id]) });
    },
    unit,
    number(key, options) {
      name(key, 'Variation key'); fields(options, ['min', 'max', 'step'], 'Variation number');
      const { min, max, step } = options;
      if (!finite(min) || !finite(max) || min > max || !finite(max - min) || step !== undefined && (!finite(step) || step <= 0))
        throw new Error('Variation number needs ordered finite endpoints, a finite span and a positive optional step.');
      if (step === undefined) return Math.min(max, min + (max - min) * unit(key));
      const ratio = (max - min) / step;
      if (!finite(ratio) || ratio > Number.MAX_SAFE_INTEGER - 1) throw new Error('Variation numeric step exceeds the safe lattice budget.');
      // Include an intended endpoint such as .1+.1+.1 despite one-ULP division
      // error, then clamp only that final floating-point contact to max.
      const steps = Math.floor(ratio + Math.min(1e-7, Number.EPSILON * 8 * Math.max(1, ratio)));
      return Math.min(max, min + Math.floor(unit(key) * (steps + 1)) * step);
    },
    integer(key, min, max) {
      name(key, 'Variation key');
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || !Number.isSafeInteger(max - min + 1))
        throw new Error('Variation integer needs ordered safe integer endpoints and an exact inclusive span.');
      return min + Math.floor(unit(key) * (max - min + 1));
    },
    chance(key, probability) {
      name(key, 'Variation key');
      if (!finite(probability) || probability < 0 || probability > 1) throw new Error('Variation chance requires probability in 0..1.');
      return unit(key) < probability;
    },
    choice<T>(key: string, choices: readonly VariationChoice<T>[]): T {
      name(key, 'Variation key');
      if (!Array.isArray(choices) || !choices.length || choices.length > VARIATION_LIMITS.choices) throw new Error('Variation choice requires 1..512 alternatives.');
      const seen = new Set<string>();
      const checked = Array.from(choices as readonly VariationChoice<T>[], entry => {
        fields(entry, ['id', 'weight', 'value'], 'Variation alternative'); name(entry.id, 'Variation alternative ID');
        if (seen.has(entry.id) || !Object.hasOwn(entry, 'value') || entry.weight !== undefined && (!finite(entry.weight) || entry.weight <= 0)) throw new Error('Variation alternatives need unique IDs, values and positive finite weights.');
        seen.add(entry.id); return entry;
      }).sort((a, b) => compare(a.id, b.id));
      // Normalize before summing to preserve uniformly scaled weights, even
      // subnormals or individually finite weights whose raw sum overflows.
      // Sorted addition also makes authored array order irrelevant.
      const maximumWeight = Math.max(...checked.map(entry => entry.weight ?? 1));
      const total = checked.reduce((sum, entry) => sum + (entry.weight ?? 1) / maximumWeight, 0);
      let roll = unit(key) * total;
      for (const entry of checked) { roll -= (entry.weight ?? 1) / maximumWeight; if (roll < 0) return entry.value; }
      return checked.at(-1)!.value;
    },
    repeat<T>(key: string, count: number, generate: (context: VariationContext, index: number) => T): T[] {
      name(key, 'Variation repeat key');
      if (!Number.isInteger(count) || count < 0 || count > VARIATION_LIMITS.repeat || typeof generate !== 'function') throw new Error('Variation repeat requires a callback and count in 0..512.');
      if (!count) return [];
      const repeated = value.scope(key); return Array.from({ length: count }, (_, index) => generate(repeated.scope(String(index)), index));
    },
  };
  Object.freeze(value); identities.set(value, identity); return value;
}
/** A versioned deterministic namespace. instanceId may contain canonical
 * parameter JSON; equal cache inputs must produce equal namespace inputs. */
export function createVariation(options: VariationOptions): VariationContext {
  fields(options, ['seed', 'id', 'version', 'instanceId'], 'Variation context');
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) throw new Error('Variation seed must be uint32.');
  name(options.id, 'Variation ID'); name(options.version, 'Variation version'); name(options.instanceId, 'Variation instance ID', VARIATION_LIMITS.instanceIdLength);
  return context({ base: Object.freeze([options.seed, options.id, options.version, options.instanceId]), path: Object.freeze([]) });
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
interface DataBudget { bytes: number; nodes: number; maximum: number }
class ExpansionDataError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function charge(budget: DataBudget, bytes: number): void {
  budget.bytes += bytes;
  if (budget.bytes > budget.maximum) throw new ExpansionDataError('data-budget', 'Variation expansion exceeds its copied-state/output byte budget.');
}
function snapshot<T>(input: T, budget: DataBudget): T {
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++budget.nodes > VARIATION_LIMITS.dataNodes || depth > VARIATION_LIMITS.dataDepth) throw new ExpansionDataError('data-budget', 'Variation expansion exceeds its plain-data depth/node budget.');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || finite(value)) {
      if (typeof value === 'string' && value.length > budget.maximum - budget.bytes) charge(budget, value.length);
      const serialized = JSON.stringify(value); charge(budget, utf8Bytes(serialized)); return Object.is(value, -0) ? 0 : value;
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value) && !plain(value)) throw new ExpansionDataError('data', 'Expansion states and values must be finite plain JSON data.');
    if (ancestors.has(value)) throw new ExpansionDataError('data', 'Expansion state/value contains a reference cycle.');
    if (Object.getOwnPropertySymbols(value).length) throw new ExpansionDataError('data', 'Expansion data cannot contain symbol fields.');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > VARIATION_LIMITS.dataNodes || Object.keys(value).length !== value.length) throw new ExpansionDataError('data', 'Expansion arrays must be dense and contain no extra fields.');
        charge(budget, 2 + Math.max(0, value.length - 1));
        const result = Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor)) throw new ExpansionDataError('data', 'Expansion data cannot contain accessor properties.');
          return copy(descriptor.value, depth + 1);
        });
        return Object.freeze(result);
      }
      const names = Object.keys(value).sort(compare);
      if (names.length > VARIATION_LIMITS.dataNodes - budget.nodes) throw new ExpansionDataError('data-budget', 'Variation expansion exceeds its plain-data node budget.');
      charge(budget, 2 + Math.max(0, names.length - 1));
      const result: Record<string, unknown> = {};
      for (const key of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new ExpansionDataError('data', 'Expansion data cannot contain accessor properties.');
        if (key.length > budget.maximum - budget.bytes) charge(budget, key.length);
        charge(budget, utf8Bytes(JSON.stringify(key)) + 1);
        Object.defineProperty(result, key, { enumerable: true, configurable: false, writable: false, value: copy(descriptor.value, depth + 1) });
      }
      return Object.freeze(result);
    } finally { ancestors.delete(value); }
  };
  return copy(input, 0) as T;
}
function children<T>(input: unknown, maximum: number, label: string): VariationRoot<T>[] {
  if (!Array.isArray(input)) throw new ExpansionDataError('children', `${label} must be an array.`);
  if (input.length > maximum) throw new ExpansionDataError('children-budget', `${label} exceeds its child count budget.`);
  const seen = new Set<string>();
  return Array.from(input as VariationRoot<T>[], root => {
    fields(root, ['id', 'state'], label); name(root.id, `${label} ID`);
    if (seen.has(root.id) || !Object.hasOwn(root, 'state')) throw new ExpansionDataError('children', `${label} requires unique sibling IDs and explicit state.`);
    seen.add(root.id); return root;
  }).sort((a, b) => compare(a.id, b.id));
}
/** Expand an authored tree into a frozen flat graph. Root depth is zero;
 * terminal nodes are visited once and must return no children. Budget or data
 * failures produce an invalid diagnostic draft, never a rerolled alternative.
 * Child IDs/order are independent of array position; array values retain order. */
export function expandVariation<TState, TValue>(request: VariationExpansionRequest<TState>,
  visit: (node: VariationVisitNode<TState>, context: VariationContext) => VariationVisitResult<TState, TValue>): VariationExpansionResult<TValue> {
  fields(request, ['context', 'roots', 'limits'], 'Variation expansion'); fields(request.limits, ['maxDepth', 'maxNodes', 'maxChildren', 'maxDataBytes'], 'Variation expansion limits');
  if (!identities.has(request.context) || typeof visit !== 'function') throw new Error('Variation expansion requires a created context and a visit callback.');
  const limits = request.limits, maximum = limits.maxDataBytes ?? 65536;
  if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 0 || limits.maxDepth > VARIATION_LIMITS.maxDepth
    || !Number.isInteger(limits.maxNodes) || limits.maxNodes < 1 || limits.maxNodes > VARIATION_LIMITS.maxNodes
    || !Number.isInteger(limits.maxChildren) || limits.maxChildren < 0 || limits.maxChildren > VARIATION_LIMITS.maxChildren
    || !Number.isInteger(maximum) || maximum < 1 || maximum > VARIATION_LIMITS.maxDataBytes) throw new Error('Variation expansion limits exceed their bounded ranges.');
  const nodes: VariationExpandedNode<TValue>[] = [], issues: VariationExpansionIssue[] = [], diagnostics = { valid: true, visited: 0, issues };
  const budget: DataBudget = { bytes: 0, nodes: 0, maximum };
  const issue = (code: string, message: string, id?: string) => {
    diagnostics.valid = false; if (issues.length < VARIATION_LIMITS.issues) issues.push(Object.freeze({ code, message: message.slice(0, 512), ...(id === undefined ? {} : { id }) }));
  };
  const error = (problem: unknown, id?: string) => issue(problem instanceof ExpansionDataError ? problem.code : 'data', problem instanceof Error ? problem.message : String(problem), id);
  type Pending = { path: string[]; parentId?: string; state: TState; context: VariationContext };
  const queue: Pending[] = [];
  try {
    for (const root of children<TState>(request.roots, limits.maxNodes, 'Variation roots')) {
      const state = snapshot(root.state, budget), scoped = request.context.scope(root.id); queue.push({ path: [root.id], state, context: scoped });
    }
  } catch (problem) { error(problem); }
  let scheduled = queue.length;
  for (let index = 0; index < queue.length; index++) {
    if (budget.bytes > maximum || budget.nodes > VARIATION_LIMITS.dataNodes) break;
    const pending = queue[index], id = JSON.stringify(pending.path), depth = pending.path.length - 1, terminal = depth === limits.maxDepth;
    let generated: VariationVisitResult<TState, TValue>;
    diagnostics.visited++;
    try { generated = visit(Object.freeze({ id, ...(pending.parentId === undefined ? {} : { parentId: pending.parentId }), depth, state: pending.state, terminal }), pending.context); }
    catch (problem) { issue('visit', problem instanceof Error ? problem.message : String(problem), id); continue; }
    try {
      fields(generated, ['value', 'children'], 'Variation visit result');
      if (!Object.hasOwn(generated, 'value')) throw new ExpansionDataError('data', 'Variation visit result requires an explicit value.');
      const metadata = JSON.stringify({ id, ...(pending.parentId === undefined ? {} : { parentId: pending.parentId }), depth });
      charge(budget, utf8Bytes(metadata) + 9); // comma, value key/colon, and output array separator
      const value = snapshot(generated.value, budget);
      nodes.push(Object.freeze({ id, ...(pending.parentId === undefined ? {} : { parentId: pending.parentId }), depth, value }));
      const next = children<TState>(generated.children === undefined ? [] : generated.children, limits.maxChildren, 'Variation children');
      if (terminal && next.length) { issue('depth-budget', 'Terminal expansion node returned children beyond maxDepth.', id); continue; }
      if (scheduled + next.length > limits.maxNodes) { issue('node-budget', 'Expansion children exceed the total maxNodes budget.', id); continue; }
      const prepared = next.map(child => ({ path: [...pending.path, child.id], parentId: id, state: snapshot(child.state, budget), context: pending.context.scope(child.id) }));
      queue.push(...prepared); scheduled += prepared.length;
    } catch (problem) { error(problem, id); }
  }
  return Object.freeze({ nodes: Object.freeze(nodes), diagnostics: Object.freeze({ ...diagnostics, issues: Object.freeze(issues) }) });
}
