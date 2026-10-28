/**
 * The test API for the game's own tests (tests/game/*.test.ts). Those tests
 * run inside the same QuickJS sandbox as the game, never in Node: import
 * describe/it/expect from here, not from vitest. `npm test` runs them and
 * reports each one alongside the locked tests.
 *
 *     import { describe, expect, it, newMatch, stepMatch } from '../../src/sandbox/testkit.ts';
 *     import game from '../../src/game/logic.ts';
 */
import type { GameLogic, InputOf, InputShape, ObjectShape, TuningValues } from '../shared/gameApi.ts';
import type { FeatureConfigShape, FeatureDefinition, FeatureState, InstalledFeature } from '../shared/gameFeatures.ts';
import { joinMatch as addPlayer, newMatch as startMatch, stepMatch as advanceMatch, inputDefaults as defaultInputs, type MatchState, type MatchOptions } from './match.ts';
import type { GameModeId } from '../shared/gameModes.ts';
import type { GameSceneAction } from '../shared/gameScenes.ts';
import { composeGame, featureInputKey, featureStateKey } from './features.ts';
export { defaults, inputDefaults, type MatchState } from './match.ts';

let installedFeatures: readonly InstalledFeature[] = [];
let installedRules: MatchOptions = {};
/** Trusted build metadata: request tests use the same tags and roster as the saved game. */
export function installTestRules(rules: MatchOptions): void { installedRules = rules; }
let featureGames = new WeakMap<object, GameLogic<any, any, any, any>>();
/** The trusted test bundler supplies the same feature registrations as the match bundle. */
export function installTestFeatures(features: readonly InstalledFeature[]): void { installedFeatures = features; featureGames = new WeakMap(); }
function testGame<W,P,I,T extends TuningValues>(game: GameLogic<W,P,I,T>): GameLogic<W,P,I,T> {
  if (!installedFeatures.length) return game;
  let composed = featureGames.get(game);
  if (!composed) { composed = composeGame(game, installedFeatures); featureGames.set(game, composed); }
  return composed;
}
/** Request tests exercise the complete installed feature stack, like actual matches. */
export function newMatch<W,P,I,T extends TuningValues>(game: GameLogic<W,P,I,T>, tuning: T, playerCount = typeof installedRules.roster?.players==='number'?installedRules.roster.players:installedRules.roster?.players?.[0] ?? 2,
  mode: GameModeId = game.mode ?? 'duel', classIds?: readonly string[], options: MatchOptions = {}): MatchState<W,P,T> {
  return startMatch(testGame(game), tuning, playerCount, mode, classIds, {...installedRules,...options});
}
/** Optional sceneActions are trusted test fixtures naming stable participant
 * indices and the current sequence. Ordinary inputs still exercise gameplay;
 * stale or invalid scene actions are checked by the same engine as live play. */
export function stepMatch<W,P,I,T extends TuningValues>(game: GameLogic<W,P,I,T>, match: MatchState<W,P,T>, inputs: readonly (I | undefined)[], dtMs: number, finishWindow = false, sceneActions: readonly GameSceneAction[] = []) {
  return advanceMatch(testGame(game), match, inputs, dtMs, finishWindow, true, undefined, undefined, undefined, sceneActions);
}
/** Add or replace one participant in a session while preserving the running world. */
export function joinMatch<W,P,I,T extends TuningValues>(game: GameLogic<W,P,I,T>, match: MatchState<W,P,T>, index = match.players.length) {
  return addPlayer(testGame(game), match, index);
}

function installedFeature(id: string): InstalledFeature {
  const feature = installedFeatures.find(item => item.id === id);
  if (!feature) throw new Error(`Feature ${id} is not installed in this test. Use the exact feature ID from its manifest.`);
  return feature;
}
function featureState(state: unknown, id: string, label: string): unknown {
  installedFeature(id);
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[featureStateKey(id)] : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Feature ${id} has no ${label} state in this match. Declare its shape and create the match with the composed testkit newMatch.`);
  return value;
}
/** Typed access to a feature's private world state without depending on generated storage keys. */
export function featureWorld<W extends ObjectShape, P extends ObjectShape, I extends InputShape, C extends FeatureConfigShape>(
  match: {world: unknown}, id: string, _definition: FeatureDefinition<W, P, I, C>,
): FeatureState<W> {
  return featureState(match.world, id, 'world') as FeatureState<W>;
}
/** Typed access to one fighter's private feature state. IDs, not module object identity, identify features. */
export function featurePlayer<W extends ObjectShape, P extends ObjectShape, I extends InputShape, C extends FeatureConfigShape>(
  match: {players: readonly {state: unknown}[]}, id: string, _definition: FeatureDefinition<W, P, I, C>, index: number,
): FeatureState<P> {
  if (!Number.isInteger(index) || index < 0 || index >= match.players.length) throw new Error('Feature player index must identify a participant in this match.');
  return featureState(match.players[index]?.state, id, `player ${index}`) as FeatureState<P>;
}
/** Add typed local inputs to the existing season/feature inputs, preserving everything else. */
export function featureInput<B extends object, W extends ObjectShape, P extends ObjectShape, I extends InputShape, C extends FeatureConfigShape>(
  baseInput: B, id: string, _definition: FeatureDefinition<W, P, I, C>, values: NoInfer<Partial<InputOf<I>>>,
): B & Record<string, number | boolean> {
  const feature = installedFeature(id), shape = feature.feature.shapes?.input ?? {};
  for (const name of Object.keys(values)) if (!Object.hasOwn(shape, name)) throw new Error(`Feature ${id} has no input named ${name}.`);
  const input = {...baseInput} as Record<string, unknown>;
  for (const [name, fallback] of Object.entries(defaultInputs(shape))) {
    const key = featureInputKey(id, name);
    if (Object.hasOwn(values, name)) {
      const value = values[name];
      if (shape[name] === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Feature ${id} input ${name} has an invalid value.`);
      input[key] = value as number | boolean;
    } else if (!Object.hasOwn(input, key)) input[key] = fallback;
  }
  return input as B & Record<string, number | boolean>;
}

export interface TestCase {
  name: string;
  run: () => void;
}

const tests: TestCase[] = [];
const prefix: string[] = [];

/** Structural, request-specific alignment assertion. Both samples must describe the
 * same coordinate frame and simulation instant (e.g. birth, before projectile movement).
 * Choose tolerances from the request; this asserts no universal gameplay policy. */
export function assertAttachmentAligned(
  actual: { position: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } },
  expected: typeof actual,
  options: { label: string; positionTolerance: number; directionToleranceRadians: number },
): void {
  const { label, positionTolerance, directionToleranceRadians } = options;
  if (!Number.isFinite(positionTolerance) || positionTolerance < 0 || !Number.isFinite(directionToleranceRadians)
    || directionToleranceRadians < 0 || directionToleranceRadians > Math.PI) throw new Error(`${label}: invalid alignment tolerances`);
  for (const sample of [actual, expected]) {
    const length = Math.hypot(sample.direction.x, sample.direction.y, sample.direction.z);
    if (![sample.position.x, sample.position.y, sample.position.z, sample.direction.x, sample.direction.y, sample.direction.z].every(Number.isFinite)
      || !Number.isFinite(length) || length < 1e-12) {
      throw new Error(`${label}: alignment samples must be finite with nonzero directions`);
    }
  }
  const distance = Math.hypot(actual.position.x - expected.position.x, actual.position.y - expected.position.y, actual.position.z - expected.position.z);
  const a = actual.direction, b = expected.direction;
  const al = Math.hypot(a.x, a.y, a.z), bl = Math.hypot(b.x, b.y, b.z);
  // Chord length remains accurate for nearly identical directions, unlike acos(dot).
  const angle = 2 * Math.asin(Math.min(1, Math.hypot(a.x / al - b.x / bl, a.y / al - b.y / bl, a.z / al - b.z / bl) / 2));
  if (distance > positionTolerance || angle > directionToleranceRadians) {
    throw new Error(`${label}: attachment alignment failed: position error ${distance} (max ${positionTolerance}), direction error ${angle} rad (max ${directionToleranceRadians}); actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
  }
}

/**
 * Request-specific aim assertion: a shot's line (from `shot.position` along
 * `shot.direction`, e.g. at its birth) passes within `tolerance` of `point` in
 * front of it, e.g. what the crosshair is on. A shot fired parallel to the view
 * from an offset muzzle misses the crosshair by that offset at every distance;
 * fire from the muzzle toward the crosshair point instead, and check near and far.
 */
export function assertAimsAt(
  shot: { position: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } },
  point: { x: number; y: number; z: number },
  options: { label: string; tolerance: number },
): void {
  const { label, tolerance } = options;
  const d = shot.direction, length = Math.hypot(d.x, d.y, d.z);
  if (![shot.position.x, shot.position.y, shot.position.z, d.x, d.y, d.z, point.x, point.y, point.z, tolerance].every(Number.isFinite)
    || length < 1e-12 || tolerance < 0) throw new Error(`${label}: aim samples must be finite, with a nonzero direction`);
  const v = { x: point.x - shot.position.x, y: point.y - shot.position.y, z: point.z - shot.position.z };
  const along = (v.x * d.x + v.y * d.y + v.z * d.z) / length;
  if (along <= 0) throw new Error(`${label}: the point is behind the shot`);
  const miss = Math.hypot(v.x - d.x / length * along, v.y - d.y / length * along, v.z - d.z / length * along);
  if (miss > tolerance) {
    throw new Error(`${label}: the shot misses the point by ${miss.toFixed(3)} (max ${tolerance}) at ${along.toFixed(2)} ahead; shot=${JSON.stringify(shot)}, point=${JSON.stringify(point)}`);
  }
}

export function describe(name: string, body: () => void): void {
  prefix.push(name);
  try {
    body();
  } finally {
    prefix.pop();
  }
}

export function it(name: string, run: () => void): void {
  tests.push({ name: [...prefix, name].join(' > '), run });
}
export const test = it;

/** Tests registered so far (read by the test runtime). */
export function registeredTests(): readonly TestCase[] {
  return tests;
}

// --- expect

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined || value === null) return String(value);
  if (typeof value === 'function') return '[function]';
  try {
    const text = JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
  return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (!isObject(expected)) return deepEqual(actual, expected);
  if (!isObject(actual)) return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => matchesObject(actual[i], item));
  }
  return Object.keys(expected).every((key) => matchesObject(actual[key], expected[key]));
}

type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toMatchObject(expected: object): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toBeNaN(): void;
  toContain(item: unknown): void;
  toHaveLength(length: number): void;
  toHaveProperty(path: string, value?: unknown): void;
  toThrow(expected?: string | RegExp): void;
};

function matchers(actual: unknown, negate: boolean): Matchers {
  const check = (pass: boolean, message: string) => {
    if (pass === negate) throw new AssertionError(`expected ${show(actual)} ${negate ? 'not ' : ''}${message}`);
  };
  const number = (name: string): number => {
    if (typeof actual !== 'number') throw new AssertionError(`${name}: expected a number, got ${show(actual)}`);
    return actual;
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), `to be ${show(expected)}`),
    toEqual: (expected) => check(deepEqual(actual, expected), `to equal ${show(expected)}`),
    toStrictEqual: (expected) => check(deepEqual(actual, expected), `to equal ${show(expected)}`),
    toMatchObject: (expected) => check(matchesObject(actual, expected), `to match ${show(expected)}`),
    toBeCloseTo: (expected, digits = 2) =>
      check(Math.abs(number('toBeCloseTo') - expected) < 10 ** -digits / 2, `to be close to ${expected} (${digits} digits)`),
    toBeGreaterThan: (expected) => check(number('toBeGreaterThan') > expected, `to be greater than ${expected}`),
    toBeGreaterThanOrEqual: (expected) => check(number('toBeGreaterThanOrEqual') >= expected, `to be at least ${expected}`),
    toBeLessThan: (expected) => check(number('toBeLessThan') < expected, `to be less than ${expected}`),
    toBeLessThanOrEqual: (expected) => check(number('toBeLessThanOrEqual') <= expected, `to be at most ${expected}`),
    toBeTruthy: () => check(!!actual, 'to be truthy'),
    toBeFalsy: () => check(!actual, 'to be falsy'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeNaN: () => check(Number.isNaN(actual), 'to be NaN'),
    toContain: (item) =>
      check((Array.isArray(actual) || typeof actual === 'string') && (actual as unknown[]).includes(item as never), `to contain ${show(item)}`),
    toHaveLength: (length) => check(isObject(actual) || typeof actual === 'string' ? (actual as { length?: unknown }).length === length : false, `to have length ${length}`),
    toHaveProperty: (path, ...value) => {
      let current: unknown = actual;
      let found = true;
      for (const key of path.split('.')) {
        if (!isObject(current) || !(key in current)) {
          found = false;
          break;
        }
        current = current[key];
      }
      check(found && (value.length === 0 || deepEqual(current, value[0])), `to have property ${path}${value.length ? ` = ${show(value[0])}` : ''}`);
    },
    toThrow: (expected) => {
      if (typeof actual !== 'function') throw new AssertionError('toThrow: expected a function');
      let thrown: unknown;
      let didThrow = false;
      try {
        (actual as () => unknown)();
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const matches = expected === undefined || (typeof expected === 'string' ? message.includes(expected) : expected.test(message));
      if (negate ? didThrow : !(didThrow && matches)) {
        throw new AssertionError(`expected function ${negate ? 'not ' : ''}to throw${expected === undefined ? '' : ` ${String(expected)}`}${didThrow ? `, it threw: ${message}` : ''}`);
      }
    },
  };
}

export function expect(actual: unknown): Matchers & { not: Matchers } {
  return { ...matchers(actual, false), not: matchers(actual, true) };
}
