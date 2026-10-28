/** Sandbox-only feature composition. No host resources or game-module imports. */
import type {
  Binding, Buttons, CreateView, GameEntities, GameEvent, GameLogic,
  InputShape, MatchContext, ObjectShape, PlayerModelOption, StepContext, TuningValues, ViewFrame,
} from '../shared/gameApi.ts';
import type {
  AnyFeatureDefinition, FeatureConfig, FeatureConfigShape, FeatureContext, FeatureDefinition, FeatureFrame,
  FeatureGameState, FeatureView, InstalledFeature, InstalledFeatureView,
} from '../shared/gameFeatures.ts';
import { defaultValue, parsePlayerModels, parseShape } from '../shared/shapes.ts';
import { matchEventLimit } from '../shared/gameModes.ts';
import type { ActorPresentationSignals } from './animation.ts';
import { composeViewDiagnostics } from './viewDiagnostics.ts';
import type { InstalledTerrainContribution, TerrainWorldSnapshot } from './terrainWorld.ts';
import type { GameUiAction, GameUiDocument, GameUiNode, GameUiPanel } from '../shared/gameUi.ts';

type RecordState = Record<string, unknown>;
type Game = GameLogic<RecordState, RecordState, RecordState, TuningValues>;
type Context = MatchContext<RecordState, RecordState, TuningValues> & Partial<StepContext<RecordState, RecordState, RecordState, TuningValues>>;
type Frame = ViewFrame<RecordState, RecordState, TuningValues>;
type Prepared = InstalledFeature & { key: string; config: FeatureConfig; inputNames: Record<string, string>; playerModels: PlayerModelOption[] };
const MAX_FEATURES = 64;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const fieldPattern = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const own = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = (value: unknown): value is RecordState => value !== null && typeof value === 'object' && !Array.isArray(value);

export class FeatureCompositionError extends Error {
  constructor(message: string) { super(`Feature composition: ${message}`); this.name = 'FeatureCompositionError'; }
}
const fail = (message: string): never => { throw new FeatureCompositionError(message); };

/** Infers each feature's configuration, synced state and inputs for its callbacks. */
export function defineFeature<const W extends ObjectShape = Record<never, never>,
  const P extends ObjectShape = Record<never, never>, const I extends InputShape = Record<never, never>,
  const C extends FeatureConfigShape = Record<never, never>>(feature: FeatureDefinition<W, P, I, C>): FeatureDefinition<W, P, I, C> {
  return feature;
}

function hash(text: string, seed: number): string {
  let value = seed;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return value.toString(16).padStart(8, '0');
}
/** Stable across reorder/removal/version updates. Hash collisions are checked at registration. */
export function featureStateKey(id: string): string {
  return 'f' + hash(id, 0x811c9dc5) + hash(id, 0x7f4a7c15);
}
export function featureInputKey(id: string, local: string): string { return 'i' + featureStateKey(id + '\0' + local).slice(1); }
export function featureIdentifier(id: string, local: string): string {
  if (typeof local !== 'string' || !local || local.length > 96) return fail(`${id}: local identifiers must contain 1–96 characters`);
  return featureStateKey(id) + '_' + hash(local, 0x811c9dc5) + hash(local, 0x7f4a7c15).slice(0, 6);
}

function featureUi(id: string, document: GameUiDocument): GameUiDocument {
  // Only known reserved intents are handled by the host, outside feature input.
  // Unknown host-prefixed names remain private to their declaring feature.
  const name = (value: string) => hostUiAction(value) ? value : featureIdentifier(id, value);
  const action = (value: GameUiAction): GameUiAction => ({ ...value, name: name(value.name) });
  const node = (value: GameUiNode): GameUiNode => {
    if (value.kind === 'row' || value.kind === 'stack') return { ...value, children: value.children.map(node) };
    if (value.kind === 'tabs') return { ...value, tabs: value.tabs.map(tab => ({ ...tab, children: tab.children.map(node) })) };
    if (value.kind === 'button') return { ...value, action: action(value.action) };
    if (value.kind === 'grid' || value.kind === 'choices') return { ...value,
      ...(value.action ? { action: action(value.action) } : {}),
      ...(value.kind === 'grid' && value.moveAction ? { moveAction: action(value.moveAction) } : {}),
      items: value.items.map(item => ({ ...item, ...(item.action ? { action: action(item.action) } : {}) })),
    } as GameUiNode;
    return { ...value };
  };
  return { ...document, panels: document.panels.map(panel => ({ ...panel, id: featureIdentifier(id, panel.id),
    ...(panel.onDismiss ? { onDismiss: action(panel.onDismiss) } : {}), children: panel.children.map(node) })),
    ...(document.actions ? { actions: document.actions.map(value => ({ ...value, name: name(value.name) })) } : {}) };
}

const hostUiAction=(name:string)=>['host:chooseClass','host:sceneChoose','host:sceneReady','host:sceneUnready','host:sceneSkip','host:sceneCustom'].includes(name);

/** Explicit replacements resolve in priority order; skins compose without
 * changing any source document or creating competing HTML roots. */
function composeUi(documents: readonly GameUiDocument[]): GameUiDocument | null {
  if (!documents.length) return null;
  const panels: GameUiPanel[] = [], aliases = new Map<string, string>();
  const result: GameUiDocument = { version: 1, panels };
  const scope=documents.find(document=>document.scene)?.scene;
  if(scope&&documents.some(document=>document.scene&&(document.scene.id!==scope.id||document.scene.sequence!==scope.sequence)))
    fail('UI documents belong to different scene instances; scope every scene UI to the current frame.scene id and sequence');
  if(scope)result.scene={...scope};
  for (const document of documents) {
    if(scope&&(document.scene?.id!==scope.id||document.scene.sequence!==scope.sequence))continue;
    for (const panel of document.panels) {
      const { replaces, ...copy } = panel;
      if (replaces !== undefined) {
        const target = aliases.get(replaces) ?? replaces;
        const index = panels.findIndex(item => item.id === target);
        if (index < 0) fail(`UI panel ${panel.id} replaces missing panel ${replaces}`);
        if (panels.some((item, at) => at !== index && item.id === panel.id)) fail(`duplicate UI panel ${panel.id}`);
        panels.splice(index, 1, copy);
        for (const [alias, value] of aliases) if (value === target) aliases.set(alias, copy.id);
        aliases.set(replaces, copy.id);
      } else {
        if (panels.some(item => item.id === panel.id)) fail(`duplicate UI panel ${panel.id}`);
        panels.push(copy);
      }
    }
    for (const action of document.actions ?? []) {
      // Multiple views may offer the same trusted class picker. Ordinary
      // duplicate game actions still reach validation as composition errors.
      if (hostUiAction(action.name) && result.actions?.some(value => value.name === action.name)) continue;
      (result.actions ??= []).push(action);
    }
    if (document.defaults) result.defaults = { ...result.defaults, ...document.defaults };
    if (document.theme) result.theme = { ...result.theme, ...document.theme,
      tokens: { ...result.theme?.tokens, ...document.theme.tokens },
      css: [result.theme?.css, document.theme.css].filter(Boolean).join('\n') };
  }
  return result;
}

function configFor(id: string, feature: AnyFeatureDefinition, supplied: FeatureConfig = {}): FeatureConfig {
  const schema = feature.config ?? {};
  if (!isRecord(schema) || !isRecord(supplied)) return fail(`${id}: configuration must be an object`);
  for (const name of Object.keys(supplied)) if (!own(schema, name)) fail(`${id}: unknown configuration setting ${name}`);
  const values: FeatureConfig = Object.create(null);
  for (const [name, field] of Object.entries(schema)) {
    if (reserved.has(name) || !isRecord(field)) return fail(`${id}: invalid configuration setting ${name}`);
    const value = own(supplied, name) ? supplied[name] : field.default;
    if (field.type === 'number') {
      if (typeof field.default !== 'number' || !Number.isFinite(field.default)
        || (field.min !== undefined && (typeof field.min !== 'number' || !Number.isFinite(field.min)))
        || (field.max !== undefined && (typeof field.max !== 'number' || !Number.isFinite(field.max)))
        || (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max)
        || typeof value !== 'number' || !Number.isFinite(value)
        || (typeof field.min === 'number' && value < field.min) || (typeof field.max === 'number' && value > field.max)
        || (field.integer === true && !Number.isInteger(value))) return fail(`${id}: ${name} requires a finite number within its declared range`);
    } else if (field.type === 'boolean') {
      if (typeof field.default !== 'boolean' || typeof value !== 'boolean') return fail(`${id}: ${name} requires a boolean`);
    } else if (field.type === 'string') {
      if (typeof field.default !== 'string' || typeof value !== 'string' || value.length > (typeof field.maxLength === 'number' ? field.maxLength : 128)
        || (field.values !== undefined && (!Array.isArray(field.values) || !field.values.every(item => typeof item === 'string') || !field.values.includes(value)))) {
        return fail(`${id}: ${name} requires an allowed string`);
      }
    } else return fail(`${id}: ${name} has an unknown configuration type`);
    values[name] = value as string | number | boolean;
  }
  return Object.freeze(values);
}

function identifiers(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FEATURES || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
    return fail(`${label}: expected up to ${MAX_FEATURES} identifiers`);
  }
  return [...new Set(value as string[])];
}
function shapeAt(shape: ObjectShape, path: string): ReturnType<typeof parseShape> | undefined {
  let current: unknown = shape;
  for (const part of path.split('.')) {
    if (!fieldPattern.test(part) || reserved.has(part) || !isRecord(current) || !own(current, part)) return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? parseShape(current, path) : undefined;
}
const numericPath = (shape: ObjectShape, path: string) => shapeAt(shape, path)?.kind === 'number';
const scalarPath = (shape: ObjectShape, path: string) => ['number', 'boolean', 'string'].includes(shapeAt(shape, path)?.kind ?? '');
const byPriority = (a: InstalledFeature, b: InstalledFeature) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function prepare(installed: readonly InstalledFeature[], baseCapabilities: readonly string[] = [], checkCapabilities = true): { ordered: Prepared[]; priority: Prepared[]; capabilities: Set<string>; metrics: Set<string> } {
  if (!Array.isArray(installed) || installed.length > MAX_FEATURES) return fail(`at most ${MAX_FEATURES} features can be installed`);
  const ids = new Set<string>(), keys = new Set<string>();
  const capabilities = new Set(identifiers(baseCapabilities, 'base capabilities'));
  const metrics = new Set<string>();
  const priority = installed.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(item.id) || ids.has(item.id)) {
      return fail(`invalid or duplicate feature ID ${item?.id}`);
    }
    ids.add(item.id);
    if (!Number.isSafeInteger(item.priority)) return fail(`${item.id}: priority must be a safe integer`);
    if (!item.feature || item.feature.apiVersion !== 1) return fail(`${item.id}: unsupported feature API version`);
    if (item.feature.terrain && (typeof item.feature.terrain !== 'function' || !item.feature.requires?.includes('world.terrain.v1')))
      return fail(`${item.id}: terrain contributions require world.terrain.v1`);
    const key = featureStateKey(item.id);
    if (keys.has(key)) return fail(`${item.id}: namespace collision`);
    keys.add(key);
    for (const capability of identifiers(item.feature.provides, `${item.id} provides`)) capabilities.add(capability);
    for (const target of identifiers(item.feature.metrics, `${item.id} metrics`)) {
      if (target.startsWith('tuning.')) fail(`${item.id}: tuning metrics are defined by the season`);
      metrics.add(target);
    }
    const inputNames: Record<string, string> = Object.create(null);
    for (const [name, field] of Object.entries(item.feature.shapes?.input ?? {})) {
      // Check the local contract before hashing; malformed names must not be hidden by namespacing.
      parseShape({ [name]: 'boolean' }, `${item.id}.input`);
      if (field !== 'boolean' && (!isRecord(field) || typeof field.min !== 'number' || !Number.isFinite(field.min)
        || typeof field.max !== 'number' || !Number.isFinite(field.max) || field.min > field.max)) fail(`${item.id}: input ${name} requires boolean or a finite min/max range`);
      inputNames[name] = featureInputKey(item.id, name);
    }
    for (const binding of item.feature.controls?.bindings ?? []) {
      const custom = typeof item.feature.controls?.writeInput === 'function';
      if (!binding || !fieldPattern.test(binding.name) || reserved.has(binding.name)
        || (!custom && !own(inputNames, binding.name))) fail(`${item.id}: binding ${binding?.name} must name a declared input or use a custom writeInput mapping`);
      const field = item.feature.shapes?.input?.[binding.name];
      if (!['held', 'tap', 'axis'].includes(binding.kind)
        || (!custom && (binding.kind === 'axis' ? field === 'boolean' : field !== 'boolean'))) fail(`${item.id}: binding ${binding.name} kind does not match its input type`);
    }
    for (const modifier of item.feature.modifiers ?? []) {
      if (!modifier || typeof modifier.target !== 'string' || !modifier.target || modifier.target.length > 128
        || !['add', 'multiply', 'override', 'min', 'max'].includes(modifier.operation)
        || (typeof modifier.value !== 'function' && (typeof modifier.value !== 'number' || !Number.isFinite(modifier.value)))) {
        return fail(`${item.id}: invalid numeric modifier`);
      }
    }
    const playerModels = parsePlayerModels(item.feature.playerModels ?? (item.feature.requires?.includes('player.appearance.v1')
      ? [{ id: 'default', label: item.name ?? item.id }] : []), `${item.id}.playerModels`, 8, true);
    if (playerModels.length && !item.feature.requires?.includes('player.appearance.v1'))
      fail(`${item.id}: selectable player models require player.appearance.v1`);
    return { ...item, key, inputNames, playerModels, config: configFor(item.id, item.feature, item.config) };
  }).sort(byPriority);
  const dependencies = new Map<string, string[]>();
  for (const item of priority) {
    for (const modifier of item.feature.modifiers ?? []) {
      if (!modifier.target.startsWith('tuning.') && !metrics.has(modifier.target)) fail(`${item.id}: undeclared numeric metric ${modifier.target}`);
    }
    const needs = identifiers(item.requires, `${item.id} manifest dependencies`);
    for (const dependency of identifiers(item.feature.dependencies, `${item.id} dependencies`)) {
      if (!needs.includes(dependency)) fail(`${item.id}: declare dependency ${dependency} in manifest.requires so it is included when packaging`);
    }
    for (const dep of needs) if (!ids.has(dep)) fail(`${item.id} requires missing feature ${dep}`);
    dependencies.set(item.id, needs);
    if (checkCapabilities) for (const cap of identifiers(item.feature.requires, `${item.id} required capabilities`)) {
      if (!capabilities.has(cap)) fail(`${item.id} requires missing capability ${cap}`);
    }
  }
  const ordered: Prepared[] = [], visited = new Set<string>();
  while (ordered.length < priority.length) {
    const ready = priority.find(item => !visited.has(item.id) && dependencies.get(item.id)!.every(dep => visited.has(dep)));
    if (!ready) return fail(`cyclic feature dependencies: ${priority.filter(item => !visited.has(item.id)).map(item => item.id).join(', ')}`);
    visited.add(ready.id); ordered.push(ready);
  }
  return { ordered, priority, capabilities, metrics };
}

function metric(priority: Prepared[], tuning: TuningValues, target: string, initial: number, player?: number): number {
  if (!Number.isFinite(initial)) return fail(`${target}: modifier baseline must be finite`);
  let baseline = initial, add = 0, multiply = 1;
  const bounds: { operation: string; value: number }[] = [];
  for (const item of priority) for (const modifier of item.feature.modifiers ?? []) {
    if (modifier.target !== target) continue;
    const value = typeof modifier.value === 'function' ? modifier.value({ config: item.config, player, tuning }) : modifier.value;
    if (!Number.isFinite(value)) return fail(`${item.id}: ${target} modifier returned a non-finite number`);
    if (modifier.operation === 'override') baseline = value;
    else if (modifier.operation === 'add') add += value;
    else if (modifier.operation === 'multiply') multiply *= value;
    else bounds.push({ operation: modifier.operation, value });
  }
  let value = (baseline + add) * multiply;
  for (const bound of bounds) value = bound.operation === 'min' ? Math.min(value, bound.value) : Math.max(value, bound.value);
  if (!Number.isFinite(value)) return fail(`${target}: combined modifiers produced a non-finite number`);
  return value;
}
function modifiedTuning(priority: Prepared[], tuning: TuningValues): TuningValues {
  const values = { ...tuning };
  const targets = new Set(priority.flatMap(item => (item.feature.modifiers ?? []).map(mod => mod.target)).filter(target => target.startsWith('tuning.')));
  for (const target of targets) {
    const name = target.slice(7);
    if (!own(tuning, name) || !Number.isFinite(tuning[name])) return fail(`${target}: this season does not expose the requested tuning value`);
    values[name] = metric(priority, tuning, target, tuning[name]);
  }
  return values;
}

/** Hide feature namespaces when exposing the season's fields to another feature. */
function seasonState(state: RecordState, privateKeys: Set<string>): RecordState {
  return new Proxy(state, {
    get: (target, key) => typeof key === 'string' && privateKeys.has(key) ? undefined : Reflect.get(target, key),
    has: (target, key) => !(typeof key === 'string' && privateKeys.has(key)) && Reflect.has(target, key),
    ownKeys: target => Reflect.ownKeys(target).filter(key => typeof key !== 'string' || !privateKeys.has(key)),
    getOwnPropertyDescriptor: (target, key) => typeof key === 'string' && privateKeys.has(key) ? undefined : Reflect.getOwnPropertyDescriptor(target, key),
    set: (target, key, value) => {
      if (typeof key === 'string' && (privateKeys.has(key) || reserved.has(key))) return fail('cannot overwrite another feature namespace');
      return Reflect.set(target, key, value);
    },
    deleteProperty: (target, key) => {
      if (typeof key === 'string' && privateKeys.has(key)) return fail('cannot delete another feature namespace');
      return Reflect.deleteProperty(target, key);
    },
    defineProperty: (target, key, attributes) => {
      if (typeof key === 'string' && (privateKeys.has(key) || reserved.has(key))) return fail('cannot redefine another feature namespace');
      return Reflect.defineProperty(target, key, attributes);
    },
  });
}
const privateState = (state: RecordState, key: string): RecordState => isRecord(state[key]) ? state[key] as RecordState : {};
function ownInput(item: Prepared, input: RecordState | undefined): RecordState | undefined {
  return input && Object.fromEntries(Object.entries(item.inputNames).map(([name, key]) => [name, input[key]]));
}
function featureFrame(item: Prepared, frame: Frame, keys: Set<string>, presentations?: Readonly<Record<string, ActorPresentationSignals>>, terrain?: TerrainWorldSnapshot): FeatureFrame {
  return {
    featureId: item.id, mode: frame.mode, config: item.config, terrain, world: frame.world ? privateState(frame.world, item.key) : null,
    players: frame.players.map((player, index) => {
      const { x, y, z, facing } = player.state;
      const pose = [x, y, z, facing].every(value => typeof value === 'number' && Number.isFinite(value))
        ? Object.freeze({ x: x as number, y: y as number, z: z as number, facing: facing as number }) : undefined;
      return { ...player, index, state: privateState(player.state, item.key), pose, presentation: presentations?.[player.id] };
    }),
    game: { ...frame, world: frame.world ? seasonState(frame.world, keys) : null,
      players: frame.players.map(player => ({ ...player, state: seasonState(player.state, keys) })) },
    now: frame.now, dt: frame.dt, phase: frame.phase,scene:frame.scene,
  };
}

/** Copy plain signal data once per frame; a feature cannot alter another model's
 * inputs or the base's retained adapter state. The adapter never exports code. */
function presentationSnapshot<T>(value: T, depth = 0, budget = { left: 4096 }): T {
  if (--budget.left < 0 || depth > 8) return fail('actor presentation exceeds its data budget');
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) return fail('actor presentation needs finite numbers'); return value; }
  if (typeof value !== 'object') return fail('actor presentation must contain plain data');
  if (Array.isArray(value)) return Object.freeze(value.map(item => presentationSnapshot(item, depth + 1, budget))) as T;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail('actor presentation must contain plain data');
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, presentationSnapshot(item, depth + 1, budget)]))) as T;
}

/**
 * Add private contributions without merging/replacing source functions. Features run in
 * dependency order, then priority, and all failures are explicit build/runtime diagnostics.
 */
export function composeGame<W, P, I, T extends TuningValues>(base: GameLogic<W, P, I, T>, installed: readonly InstalledFeature[]): GameLogic<W, P, I, T> {
  const game = base as unknown as Game;
  const { ordered, priority, capabilities, metrics } = prepare(installed, game.featureCapabilities);
  const terrains: InstalledTerrainContribution[] = ordered.filter(item => item.feature.terrain).map(item => ({ id: item.id, priority: item.priority, terrain: item.feature.terrain!(item.config) }));
  if (capabilities.has('world.terrain.v1') && (!game.terrainWorld || game.terrainWorld.version !== 1)) fail('world.terrain.v1 requires a terrainWorld adapter');
  if (terrains.length && !game.terrainWorld) fail('terrain contributions require a terrainWorld adapter');
  const playerModels = parsePlayerModels([...(game.playerModels ?? []), ...[...ordered].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .flatMap(item => item.playerModels.map(model => ({ ...model, id: featureIdentifier(item.id, model.id) })))]);
  if (!ordered.length && !game.terrainWorld) return base;
  const keys = new Set(ordered.map(item => item.key));
  const world = { ...game.shapes.world }, player = { ...game.shapes.player }, input = { ...game.shapes.input };
  const roles = new Map<string, string>();
  const bindings: Binding[] = game.controls.bindings.map(binding => ({ ...binding }));
  for (const binding of bindings) if (binding.role) roles.set(binding.role, binding.name);
  for (const item of priority) {
    const prediction = item.feature.prediction;
    if (prediction && (typeof prediction.step !== 'function' || (prediction.phase !== undefined && !['before', 'after'].includes(prediction.phase)))) {
      fail(`${item.id}: invalid prediction hook or phase`);
    }
    for (const field of [...identifiers(prediction?.fields, `${item.id} prediction fields`), ...identifiers(item.feature.smoothFields, `${item.id} smoothing fields`)]) {
      if (!fieldPattern.test(field) || !numericPath(item.feature.shapes?.player ?? {}, field)) fail(`${item.id}: ${field} must be a declared private numeric player field`);
    }
    for (const field of [...identifiers(item.feature.network?.fast, `${item.id} fast network fields`), ...identifiers(item.feature.network?.reliable, `${item.id} reliable network fields`)]) {
      if (!scalarPath(item.feature.shapes?.player ?? {}, field)) fail(`${item.id}: network field ${field} must be a declared private scalar player field (a number, boolean or string)`);
    }
    for (const field of identifiers(prediction?.snapFields, `${item.id} spatial prediction fields`)) {
      if (!prediction?.fields?.includes(field)) fail(`${item.id}: spatial field ${field} must also be a private prediction field`);
    }
    for (const field of identifiers(prediction?.gameFields, `${item.id} public prediction fields`)) {
      if (!numericPath(game.shapes.player, field)) fail(`${item.id}: ${field} must be a declared numeric season player field`);
    }
    for (const [kind, shape] of [['world', world], ['player', player]] as const) {
      const contribution = item.feature.shapes?.[kind];
      if (contribution && Object.keys(contribution).length) {
        if (own(shape, item.key)) fail(`${item.id}: namespace conflicts with the season ${kind} shape`);
        parseShape(contribution, `${item.id}.${kind}`);
        shape[item.key] = contribution;
      }
    }
    for (const [name, field] of Object.entries(item.feature.shapes?.input ?? {})) {
      const key = item.inputNames[name];
      if (own(input, key)) fail(`${item.id}: input namespace collision`);
      input[key] = field as InputShape[string];
    }
    for (const binding of item.feature.controls?.bindings ?? []) {
      const name = featureInputKey(item.id, binding.name);
      if (bindings.some(existing => existing.name === name)) fail(`${item.id}: duplicate input binding ${binding.name}`);
      // A joystick axis is a shared physical resource; highest-priority claimant wins the role.
      if (binding.role) {
        const prior = roles.get(binding.role);
        const existing = bindings.find(entry => entry.name === prior);
        if (existing) delete existing.role;
        roles.set(binding.role, name);
      }
      bindings.push({ ...binding, name });
    }
  }
  const originals = new WeakMap<object, TuningValues>();
  const tune = (values: TuningValues) => {
    game.terrainWorld?.setContributions(terrains);
    const original = originals.get(values) ?? values;
    const result = modifiedTuning(priority, original);
    originals.set(result, original); return result;
  };
  const value = (tuning: TuningValues, target: string, initial: number, index?: number) => {
    if (target.startsWith('tuning.')) {
      if (!own(tuning, target.slice(7))) fail(`${target}: this season does not expose the requested tuning value`);
    } else if (!metrics.has(target)) fail(`undeclared numeric metric ${target}`);
    return metric(priority, tuning, target, initial, index);
  };
  type QueuedEvent = { event: GameEvent; owner?: string };
  function context(item: Prepared, ctx: Context, queue?: QueuedEvent[]): FeatureContext {
    const state = () => privateState(ctx.world, item.key);
    const ownPlayers = ctx.players.map(source => ({
      index: source.index, classId: source.classId, reviveProgress: source.reviveProgress, active: source.active, hp: source.hp, maxHp: source.maxHp,
      get state() { return privateState(source.state, item.key); }, set state(value: RecordState) { source.state[item.key] = value; },
    })) as FeatureContext['players'];
    const gameState: FeatureGameState = {
      mode: ctx.mode,
      world: seasonState(ctx.world, keys),
      players: ctx.players.map(source => ({ ...source, state: seasonState(source.state, keys) })) as unknown as FeatureGameState['players'],
      tuning: ctx.tuning,
    };
    const emit = (type: string, details: Omit<GameEvent, 'type'> = {}, owner?: string) => {
      if (!queue) return fail(`${item.id}: events can only be emitted from step/event hooks`);
      if (typeof type !== 'string' || !type || type.length > 32) return fail(`${item.id}: event types must contain 1–32 characters`);
      const limit = matchEventLimit(ctx.players.length);
      if (queue.length >= limit) return fail(`event budget of ${limit} exceeded (possible event cycle in ${item.id})`);
      queue.push({ event: { ...details, type }, owner });
    };
    return {
      featureId: item.id, mode: ctx.mode, config: item.config,
      get world() { return state(); }, set world(value) { ctx.world[item.key] = value; },
      players: ownPlayers, game: gameState,
      terrain: game.terrainWorld?.read(ctx.tuning),
      inputs: ctx.players.map((_, index) => ownInput(item, ctx.inputs?.[index])) as unknown as FeatureContext['inputs'],
      dtMs: ctx.dtMs ?? 0, elapsedMs: ctx.elapsedMs ?? 0, hits: ctx.hits ?? [],
      id: local => featureIdentifier(item.id, local), eventType: local => featureIdentifier(item.id, local),
      random: (stream = 'default') => {
        if (!ctx.random) return fail(`${item.id}: randomness is unavailable while describing entities`);
        return ctx.random(featureIdentifier(item.id, stream));
      },
      value: (target, initial, index) => value(originals.get(ctx.tuning) ?? ctx.tuning, target, initial, index),
      hasCapability: capability => capabilities.has(capability),
      emit: (type, details) => emit(featureIdentifier(item.id, type), details, item.id),
      emitShared: (type, details) => emit(type, details),
    };
  }
  const composed: Game = {
    ...game, shapes: { world, player, input }, featureCapabilities: [...capabilities],
    ...(game.terrainWorld ? { terrainWorld: { ...game.terrainWorld,
      bindWorldShape: shape => game.terrainWorld!.bindWorldShape?.(shape),
      sync: (values, world) => game.terrainWorld!.sync(tune(values), world),
      prepare: (values, interests, includeInitial) => game.terrainWorld!.prepare(tune(values), interests, includeInitial),
      prepared: (values, interests, includeInitial) => game.terrainWorld!.prepared(tune(values), interests, includeInitial),
      prepareMetadata: (values, incremental) => game.terrainWorld!.prepareMetadata?.(tune(values), incremental),
      exportPrepared: values => game.terrainWorld!.exportPrepared(tune(values)),
      adoptPrepared: (values, data, verified) => game.terrainWorld!.adoptPrepared(tune(values), data, verified),
      read: values => game.terrainWorld!.read(tune(values)),
    } } : {}),
    ...(playerModels.length || game.playerModels ? { playerModels } : {}),
    // A base fixture must see the same effective tuning/terrain as ordinary
    // setup and ticks, including installed mods. Feature state stays intact.
    ...(game.inspectionSetups ? { inspectionSetups: game.inspectionSetups.map(setup => ({ ...setup,
      stage(ctx: MatchContext<RecordState, RecordState, TuningValues>) { setup.stage({ ...ctx, tuning: tune(ctx.tuning) }); },
    })) } : {}),
    setupPlayer(ctx, player) {
      const current = { ...ctx, tuning: tune(ctx.tuning) };
      const initial = ordered.map(item => {
        const shape = item.feature.shapes?.player;
        return shape && Object.keys(shape).length ? player.state[item.key] ?? defaultValue(parseShape(shape, `${item.id}.player`)) : undefined;
      });
      if (game.setupPlayer) game.setupPlayer(current, player);
      else game.respawnPlayer?.(current, player);
      for (const [index, item] of ordered.entries()) {
        if (initial[index] !== undefined) player.state[item.key] = initial[index];
        const featureContext = context(item, current);
        item.feature.hooks?.setupPlayer?.(featureContext, featureContext.players[player.index]);
      }
    },
    respawnPlayer: game.respawnPlayer ? (ctx, player) => game.respawnPlayer!({ ...ctx, tuning: tune(ctx.tuning) }, player) : undefined,
    onEliminations: game.onEliminations ? (ctx, eliminations) => game.onEliminations!({ ...ctx, tuning: tune(ctx.tuning) }, eliminations) : undefined,
    sceneStep:game.sceneStep?ctx=>game.sceneStep!({...ctx,tuning:tune(ctx.tuning)}):undefined,
    sceneRequest:game.sceneRequest?ctx=>game.sceneRequest!({...ctx,tuning:tune(ctx.tuning)}):undefined,
    onSceneEnter:game.onSceneEnter?ctx=>{
      const retained=ctx.players.map(source=>Object.fromEntries(ordered.map(item=>[item.key,source.state[item.key]])));
      game.onSceneEnter!({...ctx,tuning:tune(ctx.tuning)});
      ctx.players.forEach((source,index)=>{for(const item of ordered)if(source.state[item.key]===undefined&&retained[index][item.key]!==undefined)source.state[item.key]=retained[index][item.key];});
    }:undefined,
    setupMatch(ctx) {
      const current = { ...ctx, tuning: tune(ctx.tuning) };
      game.setupMatch(current);
      if (game.terrainWorld) game.terrainWorld.read(current.tuning).assertRevision(current.world.terrainRevision);
      for (const item of ordered) {
        const shapes = item.feature.shapes ?? {};
        if (shapes.world && Object.keys(shapes.world).length) current.world[item.key] = defaultValue(parseShape(shapes.world, `${item.id}.world`));
        for (const source of current.players) if (shapes.player && Object.keys(shapes.player).length) source.state[item.key] = defaultValue(parseShape(shapes.player, `${item.id}.player`));
      }
      for (const item of ordered) item.feature.hooks?.setup?.(context(item, current));
    },
    step(ctx) {
      const current = { ...ctx, tuning: tune(ctx.tuning) }, queue: QueuedEvent[] = [];
      if (game.terrainWorld) game.terrainWorld.read(current.tuning).assertRevision(current.world.terrainRevision);
      for (const item of ordered) item.feature.hooks?.beforeStep?.(context(item, current, queue));
      for (const event of game.step(current) ?? []) {
        if (queue.length >= matchEventLimit(current.players.length)) fail(`event budget of ${matchEventLimit(current.players.length)} exceeded by the game`);
        queue.push({ event });
      }
      for (const item of ordered) item.feature.hooks?.step?.(context(item, current, queue));
      for (let index = 0; index < queue.length; index++) {
        const { event, owner } = queue[index];
        for (const item of ordered) if (!owner || owner === item.id) item.feature.hooks?.onEvent?.(context(item, current, queue), Object.freeze({ ...event }));
      }
      return queue.map(entry => entry.event);
    },
    entities: game.entities || ordered.some(item => item.feature.entities) ? ctx => {
      const current = { ...ctx, tuning: tune(ctx.tuning) };
      const result = game.entities?.(current);
      if (!result) return fail('entity contributions require the season to expose fighter bodies');
      const combined: GameEntities = { bodies: [...result.bodies], damage: [...result.damage], blockers: [...(result.blockers ?? [])], healing: [...(result.healing ?? [])] };
      for (const item of priority) {
        const extra = item.feature.entities?.(context(item, current as unknown as Context));
        if (!extra) continue;
        const identify = (local: string) => local.startsWith(item.key + '_') ? local : featureIdentifier(item.id, local);
        combined.damage.push(...(extra.damage ?? []).map(entity => ({ ...entity, id: identify(entity.id) })));
        combined.healing!.push(...(extra.healing ?? []).map(entity => ({ ...entity, id: identify(entity.id) })));
        combined.blockers!.push(...(extra.blockers ?? []).map(entity => ({ ...entity, id: identify(entity.id) })));
        extra.bodies?.forEach((body, index) => { if (body) combined.bodies[index] = body; });
      }
      return combined;
    } : undefined,
    controls: {
      ...game.controls, bindings,
      writeInput(input, buttons, frame) {
        const current = { ...frame, tuning: tune(frame.tuning) };
        game.controls.writeInput(input, buttons, current);
        for (const item of ordered) {
          const values: Record<string, number | boolean> = Object.fromEntries(Object.entries(item.feature.shapes?.input ?? {}).map(([name, shape]) => [name, shape === 'boolean' ? false : 0]));
          const privateButtons: Buttons = {
            pointer: buttons.pointer, held: name => buttons.held(featureInputKey(item.id, name)),
            tapped: name => buttons.tapped(featureInputKey(item.id, name)), value: name => buttons.value(featureInputKey(item.id, name)),
            ...(buttons.ui ? { ui: (name: string) => buttons.ui!(featureIdentifier(item.id, name)).map(event => ({ ...event, name })) } : {}),
          };
          if (item.feature.controls?.writeInput) item.feature.controls.writeInput(values, privateButtons, featureFrame(item, current, keys, undefined, game.terrainWorld?.read(current.tuning)));
          else for (const binding of item.feature.controls?.bindings ?? []) if (own(values, binding.name)) {
            values[binding.name] = binding.kind === 'axis' ? privateButtons.value(binding.name) : binding.kind === 'tap' ? privateButtons.tapped(binding.name) : privateButtons.held(binding.name);
          }
          for (const [name, key] of Object.entries(item.inputNames)) input[key] = values[name];
        }
      },
    },
    prediction: game.prediction || ordered.some(item => item.feature.prediction) ? {
      // A base that declares no lists keeps the engine's defaults, which already cover features'
      // private fields through the composed shape; a base that narrows them takes the features' too.
      ...(game.prediction?.fields !== undefined ? { fields: [...new Set([...game.prediction.fields, ...ordered.flatMap(item => [
        ...(item.feature.prediction?.fields ?? []).map(field => `${item.key}.${field}`),
        ...(item.feature.prediction?.gameFields ?? []),
      ])])] } : {}),
      ...(game.prediction?.snapFields !== undefined ? { snapFields: [...new Set([...game.prediction.snapFields,
        ...ordered.flatMap(item => (item.feature.prediction?.snapFields ?? []).map(field => `${item.key}.${field}`))])] } : {}),
      pointerLook: game.prediction?.pointerLook,
      // Only a base or feature with its own prediction step keeps the older path; otherwise the
      // engine predicts from the composed step, feature hooks included.
      ...(!game.prediction?.step && !ordered.some(item => item.feature.prediction?.step) ? {} : { step(state, input, dt, ctx) {
        const tuning = tune(ctx.tuning);
        const predict = (item: Prepared) => item.feature.prediction?.step({
          terrain: game.terrainWorld?.read(tuning),
          mode: ctx.mode, config: item.config, state: privateState(state, item.key), input: (ownInput(item, input) ?? {}) as Record<string, number | boolean>,
          opponent: ctx.opponent ? privateState(ctx.opponent, item.key) : undefined,
          opponents: (ctx.opponents ?? (ctx.opponent ? [ctx.opponent] : [])).map(player => privateState(player, item.key)),
          world: privateState(ctx.world, item.key), dt, dtMs: dt * 1000,
          game: { mode: ctx.mode, state: seasonState(state, keys), opponent: ctx.opponent ? seasonState(ctx.opponent, keys) : undefined,
            opponents: (ctx.opponents ?? (ctx.opponent ? [ctx.opponent] : [])).map(player => seasonState(player, keys)),
            world: seasonState(ctx.world, keys), tuning },
          value: (target, initial) => value(ctx.tuning, target, initial),
        });
        for (const item of ordered) if (item.feature.prediction?.phase === 'before') predict(item);
        game.prediction?.step?.(state, input, dt, { ...ctx, tuning });
        for (const item of ordered) if (item.feature.prediction?.phase !== 'before') predict(item);
      } }),
    } : undefined,
    smoothFields: [...new Set([...game.smoothFields, ...ordered.flatMap(item => (item.feature.smoothFields ?? []).map(field => `${item.key}.${field}`))])],
    ...(game.network || ordered.some(item => item.feature.network) ? { network: {
      fast: [...new Set([...game.network?.fast ?? [], ...ordered.flatMap(item => (item.feature.network?.fast ?? []).map(field => `${item.key}.${field}`))])],
      reliable: [...new Set([...game.network?.reliable ?? [], ...ordered.flatMap(item => (item.feature.network?.reliable ?? []).map(field => `${item.key}.${field}`))])],
    } } : {}),
    hudLines(frame) {
      const current = { ...frame, tuning: tune(frame.tuning) };
      return [...game.hudLines(current), ...ordered.flatMap(item => item.feature.hudLines?.(featureFrame(item, current, keys, undefined, game.terrainWorld?.read(current.tuning))) ?? [])];
    },
  };
  return composed as unknown as GameLogic<W, P, I, T>;
}

/** Same renderer/canvas, independent addon objects and private synced frame projections. */
export function composeFeatureViews<W, P, T extends TuningValues>(base: CreateView<W, P, T>, installed: readonly InstalledFeatureView[]): CreateView<W, P, T> {
  const records = installed.map(({ definition, feature: _view, ...item }) => ({ ...item, feature: definition }));
  const { ordered, priority } = prepare(records, [], false);
  const terrains: InstalledTerrainContribution[] = ordered.filter(item => item.feature.terrain).map(item => ({ id: item.id, priority: item.priority, terrain: item.feature.terrain!(item.config) }));
  const keys = new Set(ordered.map(item => item.key));
  const modelOwners = new Map(ordered.flatMap(item => item.playerModels.map(model =>
    [featureIdentifier(item.id, model.id), { featureId: item.id, localId: model.id }] as const)));
  return canvas => {
    const view = base(canvas);
    if (terrains.length && !view.terrainWorld) { view.dispose?.(); fail('terrain contributions require a matching view terrainWorld adapter'); }
    view.terrainWorld?.setContributions(terrains);
    const addons: { item: Prepared; view: FeatureView; objects: Set<unknown>; appearances: Map<string, Map<string, unknown>>;
      inspectionTargets: Map<string, unknown> }[] = [];
    const addonsById = new Map<string, typeof addons[number]>();
    const appearances = new Map<string, unknown>();
    let selections = new Map<string, string>();
    const resolveAppearance = (id: string) => {
      let selected: unknown = null;
      const selection = selections.get(id);
      if (selection) {
        const owner = modelOwners.get(selection);
        if (owner) selected = addonsById.get(owner.featureId)?.appearances.get(id)?.get(owner.localId) ?? null;
      } else for (const item of priority) {
        const candidate = addonsById.get(item.id)?.appearances.get(id)?.get(item.playerModels[0]?.id ?? 'default');
        if (candidate !== undefined) selected = candidate;
      }
      if ((appearances.get(id) ?? null) === selected) return;
      view.featureHost!.setPlayerAppearance!(id, selected);
      if (selected === null) appearances.delete(id); else appearances.set(id, selected);
    };
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      let failure: unknown;
      for (const addon of addons) {
        try { addon.view.dispose?.(); } catch (error) { failure ??= error; }
        for (const id of addon.inspectionTargets.keys()) {
          try { view.featureHost?.setInspectionTarget?.(id, null); } catch (error) { failure ??= error; }
        }
        addon.inspectionTargets.clear();
        for (const object of addon.objects) view.featureHost?.remove(object);
      }
      for (const id of appearances.keys()) {
        try { view.featureHost?.setPlayerAppearance?.(id, null); } catch (error) { failure ??= error; }
      }
      appearances.clear();
      try { view.dispose?.(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    };
    try {
      for (const item of ordered) {
        const create = installed.find(entry => entry.id === item.id)!.feature;
        if (!create) continue;
        const objects = new Set<unknown>();
        // Register ownership before invoking user setup, so partial setup failures detach objects too.
        const addon = { item, objects, appearances: new Map<string, Map<string, unknown>>(),
          inspectionTargets: new Map<string, unknown>(), view: { update: () => {} } as FeatureView };
        addons.push(addon);
        addonsById.set(item.id, addon);
        addon.view = create({ featureId: item.id, config: item.config,
          id: local => featureIdentifier(item.id, local), eventType: local => featureIdentifier(item.id, local),
          host: {
            add(object) {
              if (disposed) return;
              if (!view.featureHost) fail(`${item.id}: this season view does not support feature objects`);
              objects.add(object); view.featureHost!.add(object);
            },
            remove(object) {
              if (!objects.delete(object)) return;
              for (const [id, target] of addon.inspectionTargets) if (target === object) {
                view.featureHost!.setInspectionTarget!(id, null); addon.inspectionTargets.delete(id);
              }
              view.featureHost!.remove(object);
            },
            setInspectionTarget: view.featureHost?.setInspectionTarget ? (localId, object, label, relatedTargets) => {
              if (disposed) return;
              const id = featureIdentifier(item.id, localId);
              view.featureHost!.setInspectionTarget!(id, object, label, relatedTargets);
              if (object === null) addon.inspectionTargets.delete(id);
              else addon.inspectionTargets.set(id, object);
            } : undefined,
            setPlayerAppearance(id, object, localModelId) {
              if (disposed) return;
              if (!view.featureHost?.setPlayerAppearance) fail(`${item.id}: this game does not support player appearances`);
              if (typeof id !== 'string' || !id || id.length > 128) fail(`${item.id}: invalid player appearance ID`);
              const localId = localModelId ?? item.playerModels[0]?.id ?? 'default';
              if (localModelId !== undefined && !item.playerModels.some(model => model.id === localId))
                fail(`${item.id}: player appearance must name a declared local model`);
              const models = addon.appearances.get(id) ?? new Map<string, unknown>();
              if (object === null) {
                models.delete(localId);
                if (!models.size) addon.appearances.delete(id);
              } else {
                if (!addon.appearances.has(id) && addon.appearances.size >= 32) fail(`${item.id}: at most 32 player appearances are allowed`);
                models.set(localId, object);
                addon.appearances.set(id, models);
              }
              resolveAppearance(id);
            },
          },
        });
      }
    } catch (error) { cleanup(); throw error; }
    return {
      terrainWorld: view.terrainWorld ? { ...view.terrainWorld,
        bindWorldShape: shape => view.terrainWorld!.bindWorldShape?.(shape),
        sync: (values, world) => view.terrainWorld!.sync(modifiedTuning(priority, values) as T, world),
        prepare: (values, interests, includeInitial) => view.terrainWorld!.prepare(modifiedTuning(priority, values) as T, interests, includeInitial),
        prepared: (values, interests, includeInitial) => view.terrainWorld!.prepared(modifiedTuning(priority, values) as T, interests, includeInitial),
        prepareMetadata: (values, incremental) => view.terrainWorld!.prepareMetadata?.(modifiedTuning(priority, values) as T, incremental),
        exportPrepared: values => view.terrainWorld!.exportPrepared(modifiedTuning(priority, values) as T),
        adoptPrepared: (values, data, verified) => view.terrainWorld!.adoptPrepared(modifiedTuning(priority, values) as T, data, verified),
        read: values => view.terrainWorld!.read(modifiedTuning(priority, values) as T),
      } : undefined,
      featureHost: view.featureHost,
      actorSignals: view.actorSignals ? frame => view.actorSignals!(frame) : undefined,
      resize(width, height, ratio) { view.resize(width, height, ratio); for (const addon of addons) addon.view.resize?.(width, height, ratio); },
      update(frame) {
        if (disposed) return;
        selections = new Map(frame.players.map(player => [player.id, player.modelId ?? '']));
        const current = { ...frame, tuning: modifiedTuning(priority, frame.tuning) };
        view.terrainWorld?.setContributions(terrains);
        const terrain = view.terrainWorld?.read(current.tuning as T);
        if (terrain && current.world) terrain.assertRevision((current.world as RecordState).terrainRevision);
        const adapted = view.actorSignals?.(current as ViewFrame<W, P, T>);
        const presentations: Record<string, ActorPresentationSignals> = Object.create(null);
        for (const player of current.players) {
          const signal = adapted?.[player.id];
          if (!signal) continue;
          if (signal.id !== player.id || signal.timeMs !== current.now) fail('actor presentation must identify the current player and frame time');
          presentations[player.id] = presentationSnapshot(signal);
        }
        for (const addon of addons) addon.view.update(featureFrame(addon.item, current as unknown as Frame, keys, presentations, terrain));
        const present = new Set(frame.players.map(player => player.id));
        for (const addon of addons) for (const id of addon.appearances.keys()) if (!present.has(id)) {
          addon.appearances.delete(id); resolveAppearance(id);
        }
        // Selection can change without a feature replacing its cached model object.
        for (const id of present) resolveAppearance(id);
        view.update(current as ViewFrame<W, P, T>);
      },
      info: view.info ? () => view.info!() : undefined,
      ui: view.ui || addons.some(addon => addon.view.ui) ? frame => {
        if (disposed) return null;
        const current = { ...frame, tuning: modifiedTuning(priority, frame.tuning) };
        const documents: GameUiDocument[] = [];
        const baseUi = view.ui?.(current as ViewFrame<W, P, T>);
        if (baseUi) documents.push(baseUi);
        for (const item of priority) {
          const addon = addonsById.get(item.id);
          const extra = addon?.view.ui?.(featureFrame(item, current as unknown as Frame, keys, undefined,
            view.terrainWorld?.read(current.tuning as T)));
          if (extra) documents.push(featureUi(item.id, extra));
        }
        return composeUi(documents);
      } : undefined,
      inspection: view.inspection || addons.some(addon => addon.view.inspection) ? () => {
        return composeViewDiagnostics(view.inspection ? () => view.inspection!() : undefined,
          addons.filter(addon => addon.view.inspection).map(addon => ({
            id: addon.item.id, read: () => addon.view.inspection!(),
          })));
      } : undefined,
      setReviewCamera: view.setReviewCamera ? camera => view.setReviewCamera!(camera) : undefined,
      setInspectionFocus: view.setInspectionFocus ? focus => view.setInspectionFocus!(focus) : undefined,
      inspectionFocus: view.inspectionFocus ? () => view.inspectionFocus!() : undefined,
      dispose: cleanup,
    };
  };
}
