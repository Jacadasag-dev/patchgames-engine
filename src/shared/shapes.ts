import type { Binding, CooperativeRules, NumberField, PlayerClass, PlayerModelOption, PointerControls, PointerLook, PointerLookAxis, LearningInterface, LearningValue } from './gameApi.ts';
import { GAME_MODE_IDS, isGameMode, MAX_MATCH_PLAYERS, MAX_TEAMS, matchEventLimit, type GameModeId } from './gameModes.ts';
import { parseVoiceDeclaration, type VoiceDeclaration } from './voicePolicy.ts';
import {parseRoundRules,roundStateShape,type RoundRules} from './roundSeries.ts';
import {parseSceneRules,sceneStateShape,type GameSceneRules} from './gameScenes.ts';
import { FAST_PLAYER_BYTES, FAST_STRING_BYTES, fastPlayerBytes, scalarKind } from './fastLane.ts';

// Everything the game module hands the core is untrusted data. This module
// turns the game's shape declarations into a checked description (Kind),
// and forces every value coming back out of the sandbox into that
// description, with hard size limits, before the core touches it.

export const SHAPE_LIMITS = {
  depth: 4,
  fieldsPerObject: 32,
  totalFields: 256,
  entries: 256,
  stringLength: 128,
  mapKeyLength: 32,
  bindings: 16,
  keysPerBinding: 8,
  descriptionLength: 140,
  /** Legacy on-screen control text; parsed for compatibility, never shown. */
  hintLength: 120,
  events: 32,
  eventDetails: 8,
  viewInfo: 16,
} as const;

const NUMBER_RANGES: Record<NumberField, [number, number] | null> = {
  number: null,
  float32: null,
  float64: null,
  int8: [-128, 127],
  uint8: [0, 255],
  int16: [-32768, 32767],
  uint16: [0, 65535],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
};

export type Kind =
  | { kind: 'number'; type: NumberField }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'array'; of: Kind }
  | { kind: 'map'; of: Kind }
  | ObjectKind;
export interface ObjectKind {
  kind: 'object';
  fields: [string, Kind][];
}
export type InputKind = [string, { kind: 'boolean' } | { kind: 'range'; min: number; max: number }][];

/** What the game module declares, after checking. */
export interface GameInfo {
  scenes?: GameSceneRules;
  rounds?: RoundRules;
  mode: GameModeId;
  supportedModes?: readonly GameModeId[];
  /** Host-selected game tags (withGameRules); never read from a game's describe(). */
  tags?: readonly import('./gameTags.ts').GameTagId[];
  /** Validated declarations, not evidence that a capability behaves correctly. */
  featureCapabilities?: readonly string[];
  /** Terrain adapter limits declared without generating or simulating a world. */
  terrainConstraints?: { surface: 'heightfield' } | { surface: 'fixed-flat'; height: number };
  terrainPrefetch?: boolean;
  cooperative?: CooperativeRules;
  /** The validated roster the game declares in src/game/roster.json (docs/game-tags.md), attached by
   * the host from the game package; absent when it declares none. */
  roster?: RosterDeclaration;
  /** The game's in-game voice declaration (docs/voice-chat.md); absent when the game declares none. */
  voice?: VoiceDeclaration;
  playerClasses?: readonly PlayerClass[];
  playerModels?: readonly PlayerModelOption[];
  world: ObjectKind;
  player: ObjectKind;
  input: InputKind;
  bindings: Binding[];
  pointer: PointerControls;
  controlsHint: string;
  inspectionControls?: import('./gameApi.ts').InspectionControls;
  inspectionSetups?: readonly import('./gameApi.ts').InspectionSetupInfo[];
  smoothFields: string[];
  /** Numeric local-fighter fields the engine predicts and reconciles: every continuous (float) field unless the game narrows it. */
  predictionFields: string[];
  /** The game declares its own per-fighter prediction step (the older contract): the engine runs that
   * instead of the game's `step`, and shows no overlay. Absent for games the engine predicts itself. */
  legacyPredictionStep?: true;
  /** Spatial subset, in world units; other values can have unrelated units. Defaults to x/y/z when nothing is declared. */
  predictionSnapFields: string[];
  /** The local fighter's remaining scalar fields (numbers, booleans, strings): when the engine runs the
   * game's real step locally, their latest predicted values are shown as-is, so feedback the step writes
   * (a hit flash, a stance name) appears at once instead of a round trip later. */
  predictionOverlayFields: string[];
  pointerLook?: PointerLook;
  /** Player fields that also ride the fast lane (datagrams, latest value wins) to players on
   * WebTransport: smoothFields plus `network.fast`, minus `network.reliable`. Everything else,
   * and these too for players on a WebSocket, travels only in the reliable state. */
  fastFields: string[];
  /** Stable id of the shapes, for naming generated schema classes. */
  shapesId: string;
  learning?: LearningInterface;
}

export class ContractError extends Error {}

/** The canonical position (player.position.v1): the fields a large server correction snaps together. */
const POSITION_FIELDS = ['x', 'y', 'z'];
/** Wire types that hold continuous values; the integer types hold counters, phases and flags. */
const CONTINUOUS_NUMBERS = new Set<string>(['number', 'float32', 'float64']);
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
// Names that would shadow methods of the synced objects or of Object itself.
const RESERVED = new Set([
  'constructor', 'prototype', 'toJSON', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', 'assign', 'clone', 'setDirty', 'discardAllChanges',
  'restore', 'encode', 'decode', 'onChange', 'listen', 'then',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldName(name: string, path: string): string {
  if (!FIELD_NAME.test(name) || RESERVED.has(name)) {
    throw new ContractError(`${path}: "${name}" is not a valid field name (letters, digits and _, starting with a letter; not a reserved name)`);
  }
  return name;
}

/** Checks a shape declaration and turns it into a Kind. */
export function parseShape(raw: unknown, path: string, depth = 0, budget = { fields: 0 }): Kind {
  if (typeof raw === 'string') {
    if (raw === 'boolean') return { kind: 'boolean' };
    if (raw === 'string') return { kind: 'string' };
    if (raw in NUMBER_RANGES) return { kind: 'number', type: raw as NumberField };
    throw new ContractError(`${path}: unknown field type "${raw}"`);
  }
  if (depth >= SHAPE_LIMITS.depth) throw new ContractError(`${path}: nested deeper than ${SHAPE_LIMITS.depth} levels`);
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw new ContractError(`${path}: a list is declared as [shape], with exactly one element`);
    return { kind: 'array', of: parseShape(raw[0], `${path}[]`, depth + 1, budget) };
  }
  if (!isRecord(raw)) throw new ContractError(`${path}: expected a field type, [shape] or an object`);
  const names = Object.keys(raw);
  if (names.length === 1 && names[0] === '*') return { kind: 'map', of: parseShape(raw['*'], `${path}{}`, depth + 1, budget) };
  return parseObject(raw, path, depth, budget);
}

function parseObject(raw: unknown, path: string, depth = 0, budget = { fields: 0 }): ObjectKind {
  if (!isRecord(raw)) throw new ContractError(`${path}: expected an object of fields`);
  const names = Object.keys(raw);
  if (names.length > SHAPE_LIMITS.fieldsPerObject) throw new ContractError(`${path}: more than ${SHAPE_LIMITS.fieldsPerObject} fields`);
  budget.fields += names.length;
  if (budget.fields > SHAPE_LIMITS.totalFields) throw new ContractError(`shapes: more than ${SHAPE_LIMITS.totalFields} fields in total`);
  return {
    kind: 'object',
    fields: names.map((name) => [fieldName(name, path), parseShape(raw[name], `${path}.${name}`, depth + 1, budget)]),
  };
}

function parseInput(raw: unknown): InputKind {
  if (!isRecord(raw)) throw new ContractError('shapes.input: expected an object of fields');
  const names = Object.keys(raw);
  if (names.length > SHAPE_LIMITS.fieldsPerObject) throw new ContractError(`shapes.input: more than ${SHAPE_LIMITS.fieldsPerObject} fields`);
  return names.map((name) => {
    const field = raw[name];
    fieldName(name, 'shapes.input');
    if (field === 'boolean') return [name, { kind: 'boolean' }];
    if (isRecord(field) && isFiniteNumber(field.min) && isFiniteNumber(field.max) && field.min <= field.max) {
      return [name, { kind: 'range', min: field.min, max: field.max }];
    }
    throw new ContractError(`shapes.input.${name}: expected 'boolean' or { min, max } with finite numbers`);
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function stringList(raw: unknown, path: string, max: number, maxLength: number): string[] {
  if (!Array.isArray(raw) || raw.length > max || !raw.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxLength)) {
    throw new ContractError(`${path}: expected up to ${max} strings of 1-${maxLength} characters`);
  }
  return [...new Set(raw as string[])];
}

function parseBindings(raw: unknown): Binding[] {
  if (!Array.isArray(raw) || raw.length > SHAPE_LIMITS.bindings) {
    throw new ContractError(`controls.bindings: expected up to ${SHAPE_LIMITS.bindings} bindings`);
  }
  const names = new Set<string>();
  const roles = new Set<string>();
  return raw.map((binding, i) => {
    const path = `controls.bindings[${i}]`;
    if (!isRecord(binding) || typeof binding.name !== 'string' || !FIELD_NAME.test(binding.name)) {
      throw new ContractError(`${path}: expected { name, kind, keys, mouse? } with an identifier name`);
    }
    fieldName(binding.name, `${path}.name`);
    if (names.has(binding.name)) throw new ContractError(`${path}: duplicate action name`);
    names.add(binding.name);
    if (!['held', 'tap', 'axis'].includes(binding.kind as string)) throw new ContractError(`${path}.kind: expected held, tap or axis`);
    const keys = stringList(binding.keys ?? [], `${path}.keys`, SHAPE_LIMITS.keysPerBinding, 16).map((key) => key.toLowerCase());
    if (binding.kind === 'axis' && keys.length !== 0 && keys.length !== 2) throw new ContractError(`${path}: axis keys must be [negative, positive]`);
    if (binding.label !== undefined && (typeof binding.label !== 'string' || !binding.label.trim() || binding.label.length > 32)) throw new ContractError(`${path}.label: expected 1–32 characters`);
    if (binding.description !== undefined && (typeof binding.description !== 'string' || !binding.description.trim() || binding.description.length > SHAPE_LIMITS.descriptionLength)) throw new ContractError(`${path}.description: expected 1–${SHAPE_LIMITS.descriptionLength} characters`);
    if (binding.touch !== undefined && binding.touch !== 'button' && binding.touch !== 'hidden') throw new ContractError(`${path}.touch: expected button or hidden`);
    if (binding.role !== undefined) {
      if (binding.kind !== 'axis' || !['move-x', 'move-y'].includes(binding.role as string) || roles.has(binding.role as string)) throw new ContractError(`${path}.role: unique move-x or move-y axis required`);
      roles.add(binding.role as string);
    }
    if (keys.some(key => key === 'escape' || key === 'esc')) throw new ContractError(`${path}.keys: Escape is reserved for the host match menu`);
    if (binding.mouse !== undefined && binding.mouse !== 0 && binding.mouse !== 1 && binding.mouse !== 2) {
      throw new ContractError(`${path}.mouse: expected 0, 1 or 2`);
    }
    return { name: binding.name, kind: binding.kind as Binding['kind'], keys,
      ...(binding.label === undefined ? {} : { label: binding.label as string }),
      ...(binding.description === undefined ? {} : { description: (binding.description as string).replace(/[\p{Cc}\p{Cf}]/gu, '').trim() }),
      ...(binding.role === undefined ? {} : { role: binding.role as Binding['role'] }),
      ...(binding.mouse === undefined ? {} : { mouse: binding.mouse }),
      ...(binding.touch === undefined ? {} : { touch: binding.touch as Binding['touch'] }) };
  });
}

function parsePointer(raw: unknown): PointerControls {
  if (raw === undefined) return { mode: 'free' };
  if (!isRecord(raw) || !['free', 'capture', 'lock'].includes(raw.mode as string)
    || (raw.button !== undefined && raw.button !== 0 && raw.button !== 1 && raw.button !== 2)
    || (raw.cursor !== undefined && raw.cursor !== 'visible' && raw.cursor !== 'hidden')) {
    throw new ContractError('controls.pointer: expected { mode: free | capture | lock, button?: 0 | 1 | 2 }');
  }
  return { mode: raw.mode as PointerControls['mode'], ...(raw.button === undefined ? {} : { button: raw.button as 0 | 1 | 2 }),
    ...(raw.cursor === undefined ? {} : { cursor: raw.cursor as 'visible' | 'hidden' }) };
}

/** Metadata is untrusted like shapes. Resolve paths now, not during policy inference. */
function parseLearning(raw: unknown, player: ObjectKind, world: ObjectKind, input: InputKind): LearningInterface {
  const fail = (): never => { throw new ContractError('learning: invalid declaration, shape path, or scale'); };
  const positive = (v: unknown): v is number => isFiniteNumber(v) && v >= 1e-9 && v <= 1e9;
  function target(root: Kind, path: string): Kind {
    if (!path || path.length > 256) return fail();
    let node = root;
    for (const part of path.split('.')) {
      const next = node.kind === 'object' ? node.fields.find(([name]) => name === part)?.[1]
        : (node.kind === 'array' || node.kind === 'map') && part === '*' ? node.of : undefined;
      if (!next) return fail();
      node = next;
    }
    return node;
  }
  function fields(value: unknown, root: Kind): Record<string, LearningValue> {
    if (!isRecord(value) || Object.keys(value).length > 256) return fail();
    return Object.fromEntries(Object.entries(value).map(([path, spec]) => {
      const node = target(root, path);
      if (!isRecord(spec)) return fail();
      if (spec.kind === 'scalar' && node.kind === 'number' && positive(spec.scale)
        && (spec.center === undefined || isFiniteNumber(spec.center))) {
        return [path, { kind: 'scalar', scale: spec.scale, ...(spec.center === undefined ? {} : { center: spec.center }) }];
      }
      if (spec.kind === 'angle' && node.kind === 'number' && positive(spec.period)) return [path, { kind: 'angle', period: spec.period }];
      if (spec.kind === 'category' && node.kind === 'string' && Array.isArray(spec.values)
        && spec.values.length > 0 && spec.values.length <= 32
        && spec.values.every(v => typeof v === 'string' && v.length <= 128)
        && new Set(spec.values).size === spec.values.length) return [path, { kind: 'category', values: [...spec.values] }];
      return fail();
    }));
  }
  if (!isRecord(raw) || Object.keys(raw).some(k => !['player', 'world', 'playerVectors', 'inputs'].includes(k))) return fail();
  const result: LearningInterface = {};
  if (raw.player !== undefined) result.player = fields(raw.player, player);
  if (raw.world !== undefined) result.world = fields(raw.world, world);
  if (raw.playerVectors !== undefined) {
    if (!Array.isArray(raw.playerVectors) || raw.playerVectors.length > 16) return fail();
    result.playerVectors = raw.playerVectors.map(vector => {
      if (!isRecord(vector) || !positive(vector.scale) || !Array.isArray(vector.components)
        || vector.components.length < 2 || vector.components.length > 4
        || new Set(vector.components).size !== vector.components.length
        || vector.components.some(p => typeof p !== 'string' || p.includes('*') || target(player, p).kind !== 'number')) return fail();
      return { components: [...vector.components], scale: vector.scale };
    });
  }
  if (raw.inputs !== undefined) {
    if (!isRecord(raw.inputs) || Object.keys(raw.inputs).length > 32) return fail();
    result.inputs = Object.fromEntries(Object.entries(raw.inputs).map(([name, spec]) => {
      const kind = input.find(([key]) => key === name)?.[1];
      if (!kind || kind.kind !== 'range' || !isRecord(spec) || !positive(spec.scale)
        || !isFiniteNumber(spec.neutral) || spec.neutral < kind.min || spec.neutral > kind.max
        || !Number.isFinite((spec.neutral - kind.min) / spec.scale)
        || !Number.isFinite((kind.max - spec.neutral) / spec.scale)) return fail();
      return [name, { neutral: spec.neutral, scale: spec.scale }];
    }));
  }
  return result;
}

/** Plain-data cosmetic catalog. Model objects never cross the view sandbox. */
export function parsePlayerModels(raw: unknown, path = 'playerModels', maximum = 128, local = false): PlayerModelOption[] {
  if (!Array.isArray(raw) || raw.length > maximum) throw new ContractError(`${path}: expected up to ${maximum} models`);
  const ids = new Set<string>(), pattern = local ? /^[a-z][a-z0-9-]{0,31}$/ : /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/;
  return raw.map(value => {
    if (!isRecord(value) || typeof value.id !== 'string' || !pattern.test(value.id) || ids.has(value.id)
      || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 100
      || (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 160))
      || /[\p{Cc}\p{Cf}]/u.test(value.label + (value.description ?? '')))
      throw new ContractError(`${path}: expected unique stable IDs, visible labels up to 100 characters and descriptions up to 160`);
    ids.add(value.id);
    return { id: value.id, label: value.label.trim(), ...(value.description === undefined ? {} : { description: value.description as string }) };
  });
}

/** Checks what the game's logic declares about itself (the sandbox's `describe` answer). */
/** A game's roster declaration after validation: a [min, max] player range, a team count (0: none)
 * and the players per team, each present only when the game declared it (teamSize fixes players). */
export interface RosterDeclaration {
  players?: readonly [number, number];
  teams?: number;
  teamSize?: number;
}
/** The single validation of a roster declaration; used by the contract parser and by tests. */
export function parseRoster(raw: unknown): RosterDeclaration {
  if (!isRecord(raw) || Object.keys(raw).some(key => !['players', 'teams', 'teamSize'].includes(key)))
    throw new ContractError('roster: expected {players?, teams?, teamSize?}');
  const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
  const roster: { players?: [number, number]; teams?: number; teamSize?: number } = {};
  if (raw.players !== undefined) {
    const range = integer(raw.players) ? [raw.players, raw.players]
      : Array.isArray(raw.players) && raw.players.length === 2 && raw.players.every(integer) ? raw.players as number[] : undefined;
    if (!range || range[0] < 1 || range[1] > MAX_MATCH_PLAYERS || range[0] > range[1])
      throw new ContractError(`roster.players: expected a count or [min, max] within 1–${MAX_MATCH_PLAYERS}`);
    roster.players = [range[0], range[1]];
  }
  if (raw.teams !== undefined) {
    if (!integer(raw.teams) || raw.teams < 0 || raw.teams === 1 || raw.teams > MAX_TEAMS)
      throw new ContractError(`roster.teams: expected 0 (no teams) or 2–${MAX_TEAMS}`);
    roster.teams = raw.teams;
  }
  if (raw.teamSize !== undefined) {
    if (!integer(raw.teamSize) || raw.teamSize < 1) throw new ContractError('roster.teamSize: expected a positive count of players per team');
    if (!roster.teams) throw new ContractError('roster.teamSize: declare teams (2–16) with a team size');
    const total = roster.teams * raw.teamSize;
    if (total > MAX_MATCH_PLAYERS) throw new ContractError(`roster.teamSize: ${roster.teams} teams of ${raw.teamSize} exceed ${MAX_MATCH_PLAYERS} players`);
    if (roster.players && (total < roster.players[0] || total > roster.players[1]))
      throw new ContractError('roster.teamSize: teams × teamSize must fall within the declared players');
    roster.teamSize = raw.teamSize;
    roster.players ??= [total, total];
  }
  if (roster.teams && roster.players && roster.players[1] < roster.teams) throw new ContractError('roster.players: fewer players than teams');
  return roster;
}

export function parseGameInfo(raw: unknown): GameInfo {
  if (!isRecord(raw) || !isRecord(raw.shapes)) throw new ContractError('the game must export { shapes, ... }');
  if (raw.mode !== undefined && !isGameMode(raw.mode)) throw new ContractError(`mode: expected ${GAME_MODE_IDS.join(', ')}`);
  const supportedModes = raw.supportedModes ?? [raw.mode ?? 'duel'];
  if (!Array.isArray(supportedModes) || !supportedModes.length || supportedModes.length > GAME_MODE_IDS.length
    || supportedModes.some(mode => !isGameMode(mode))
    || new Set(supportedModes).size !== supportedModes.length || !supportedModes.includes(raw.mode ?? 'duel'))
    throw new ContractError('supportedModes: declare unique supported modes including the default mode');
  const budget = { fields: 0 };
  const world = parseObject(raw.shapes.world ?? {}, 'shapes.world', 0, budget);
  const player = parseObject(raw.shapes.player, 'shapes.player', 0, budget);
  const input = parseInput(raw.shapes.input);
  const featureCapabilities = raw.featureCapabilities === undefined ? undefined
    : [...new Set(stringList(raw.featureCapabilities, 'featureCapabilities', 64, 128))];
  if (featureCapabilities?.some(value => !value.length || /[\p{Cc}\p{Cf}]/u.test(value)))
    throw new ContractError('featureCapabilities: expected visible nonempty identifiers');
  let terrainConstraints: GameInfo['terrainConstraints'];
  if(raw.terrainPrefetch!==undefined&&typeof raw.terrainPrefetch!=='boolean')throw new ContractError('terrainPrefetch: expected a boolean');
  if (raw.terrainConstraints !== undefined) {
    const value = raw.terrainConstraints;
    if (!isRecord(value) || Object.keys(value).some(key => !['surface', 'height'].includes(key))
      || (value.surface !== 'heightfield' && value.surface !== 'fixed-flat')
      || (value.surface === 'heightfield' ? value.height !== undefined : typeof value.height !== 'number' || !Number.isFinite(value.height)))
      throw new ContractError('terrainConstraints: expected heightfield or fixed-flat with a finite height');
    terrainConstraints = value.surface === 'heightfield' ? { surface: 'heightfield' }
      : { surface: 'fixed-flat', height: value.height as number };
  }
  let inspectionControls: import('./gameApi.ts').InspectionControls | undefined;
  if (raw.inspectionControls !== undefined) {
    if (!isRecord(raw.inspectionControls) || Object.keys(raw.inspectionControls).some(key => !['forward', 'right', 'attack', 'jump'].includes(key)))
      throw new ContractError('controls.inspection: expected declared forward/right/attack/jump inputs');
    inspectionControls = {};
    for (const [action, values] of Object.entries(raw.inspectionControls)) {
      if (!isRecord(values) || !Object.keys(values).length || Object.keys(values).length > input.length)
        throw new ContractError(`controls.inspection.${action}: expected nonempty partial input`);
      for (const [name, value] of Object.entries(values)) {
        const field = input.find(([key]) => key === name)?.[1];
        if (!field || (field.kind === 'boolean' ? typeof value !== 'boolean'
          : typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max))
          throw new ContractError(`controls.inspection.${action}.${name}: expected a legal declared input`);
      }
      inspectionControls[action as keyof typeof inspectionControls] = values as Record<string, number | boolean>;
    }
  }
  let inspectionSetups: import('./gameApi.ts').InspectionSetupInfo[] | undefined;
  if (raw.inspectionSetups !== undefined) {
    if (!Array.isArray(raw.inspectionSetups) || raw.inspectionSetups.length > 16)
      throw new ContractError('inspectionSetups: expected at most 16 named setups');
    const ids = new Set<string>();
    inspectionSetups = raw.inspectionSetups.map(value => {
      if (!isRecord(value) || Object.keys(value).some(key => !['id', 'label', 'description', 'recommendedScenario', 'relevance', 'canStage'].includes(key))
        || value.canStage !== true || typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) || ids.has(value.id)
        || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80
        || typeof value.description !== 'string' || !value.description.trim() || value.description.length > 500
        || /[\p{Cc}\p{Cf}]/u.test(value.label + value.description))
        throw new ContractError('inspectionSetups: expected unique stable IDs, visible labels/descriptions and a stage function');
      ids.add(value.id);
      let relevance: import('./gameApi.ts').InspectionSetupInfo['relevance'];
      if (value.relevance !== undefined) {
        const hints = value.relevance;
        if (!isRecord(hints) || Object.keys(hints).some(key => !['sourcePaths', 'featureIds', 'tags'].includes(key))
          || !Object.keys(hints).length || Object.entries(hints).some(([key, entries]) => !Array.isArray(entries)
            || entries.length < 1 || entries.length > 16 || new Set(entries).size !== entries.length
            || entries.some(entry => typeof entry !== 'string' || !entry.trim() || entry !== entry.trim()
              || entry.length > (key === 'sourcePaths' ? 240 : 80) || /[\p{Cc}\p{Cf}]/u.test(entry)
              || key === 'sourcePaths' && (!/^(src\/game|tests\/game)\/[\w./-]+$/.test(entry)
                || entry.includes('..') || entry.includes('//')))))
          throw new ContractError('inspectionSetups.relevance: expected bounded source paths, feature IDs or tags');
        relevance = hints as typeof relevance;
      }
      let recommendedScenario: import('./gameApi.ts').InspectionSetupInfo['recommendedScenario'];
      if (value.recommendedScenario !== undefined) {
        const spec = value.recommendedScenario;
        if (!isRecord(spec) || Object.keys(spec).some(key => !['recipe', 'durationMs', 'holdMs'].includes(key))
          || !['locomotion', 'attack', 'jump', 'character-quality'].includes(spec.recipe as string))
          throw new ContractError('inspectionSetups.recommendedScenario: expected a supported inspection recipe');
        const duration = spec.durationMs ?? (spec.recipe === 'character-quality' ? 10000 : 2000);
        if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < (spec.recipe === 'character-quality' ? 2000 : 500) || duration > 20000
          || spec.holdMs !== undefined && (spec.recipe !== 'attack' || typeof spec.holdMs !== 'number' || !Number.isInteger(spec.holdMs)
            || spec.holdMs < 34 || spec.holdMs > 5000 || Math.floor(duration * .4) + spec.holdMs + 34 > duration))
          throw new ContractError('inspectionSetups.recommendedScenario: duration/hold must fit the bounded recipe');
        const needed = spec.recipe === 'character-quality' || spec.recipe === 'locomotion' ? ['forward', 'right'] : [spec.recipe as string];
        if (needed.some(action => !inspectionControls?.[action as keyof typeof inspectionControls]))
          throw new ContractError('inspectionSetups.recommendedScenario: recipe requires declared semantic inspection controls');
        recommendedScenario = spec as typeof recommendedScenario;
      }
      return { id: value.id, label: value.label, description: value.description, ...(relevance ? { relevance } : {}), ...(recommendedScenario ? { recommendedScenario } : {}) };
    });
  }
  let cooperative: CooperativeRules | undefined;
  if (raw.cooperative !== undefined) {
    const reviveInput = isRecord(raw.cooperative) ? raw.cooperative.reviveInput : undefined;
    if (typeof reviveInput !== 'string'
      || !input.some(([name, field]) => name === reviveInput && field.kind === 'boolean'))
      throw new ContractError('cooperative.reviveInput: expected a declared boolean input');
    cooperative = { reviveInput };
  }
  // The roster moved out of the logic into src/game/roster.json; a stale declaration is refused, not ignored.
  if (raw.roster !== undefined) throw new ContractError('roster: moved to src/game/roster.json; remove it from the logic');
  // In-game voice is declared once; omitted means none once play starts (docs/voice-chat.md).
  const voice = raw.voice === undefined ? undefined : parseVoiceDeclaration(raw.voice, message => { throw new ContractError(message); });
  let playerClasses: PlayerClass[] | undefined;
  if (raw.playerClasses !== undefined) {
    if (!Array.isArray(raw.playerClasses) || !raw.playerClasses.length || raw.playerClasses.length > 16)
      throw new ContractError('playerClasses: expected 1–16 classes');
    const ids = new Set<string>();
    playerClasses = raw.playerClasses.map(value => {
      if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.id) || ids.has(value.id)
        || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 40
        || typeof value.description !== 'string' || value.description.length > 160
        || /[\p{Cc}\p{Cf}]/u.test(value.label + value.description))
        throw new ContractError('playerClasses: expected unique stable IDs, labels up to 40 characters and descriptions up to 160');
      ids.add(value.id);
      return { id: value.id, label: value.label, description: value.description };
    });
  }
  const numericPlayerFields = new Set<string>(), scalarPlayerFields = new Set<string>(), continuousPlayerFields = new Set<string>();
  const numericFields=(shape:ObjectKind,prefix='')=>{for(const [name,kind]of shape.fields){
    const path=prefix+name;
    if(kind.kind==='number'){numericPlayerFields.add(path);if(CONTINUOUS_NUMBERS.has(kind.type))continuousPlayerFields.add(path);}
    if(kind.kind==='number'||kind.kind==='boolean'||kind.kind==='string')scalarPlayerFields.add(path);
    else if(kind.kind==='object')numericFields(kind,path+'.');
  }};
  numericFields(player);
  const playerNumbers = (value: unknown, path: string) => {
    const fields = stringList(value ?? [], path, SHAPE_LIMITS.totalFields, (SHAPE_LIMITS.depth+1)*33);
    const unknown = fields.filter((field) => !numericPlayerFields.has(field));
    if (unknown.length) throw new ContractError(`${path}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a' : 'are not'} numeric field${unknown.length === 1 ? '' : 's'} of shapes.player`);
    return fields;
  };
  const hint = typeof raw.controlsHint === 'string' ? raw.controlsHint : '';
  // Prediction is the engine's by default: every continuous (float) field is reconciled with
  // smoothing and the canonical position snaps; integers, booleans and strings are discrete and
  // show as the latest local step left them. A declared list narrows it (older bundles, or a game
  // that must keep a field server-paced).
  const declaredPrediction = raw.predictionFields !== undefined;
  const predictionFields = declaredPrediction ? playerNumbers(raw.predictionFields, 'prediction.fields') : [...continuousPlayerFields];
  const predictionSnapFields = raw.predictionSnapFields !== undefined ? playerNumbers(raw.predictionSnapFields, 'prediction.snapFields')
    : declaredPrediction ? [] : POSITION_FIELDS.filter(field => continuousPlayerFields.has(field));
  if (predictionSnapFields.some(field => !predictionFields.includes(field))) throw new ContractError('prediction.snapFields must be a subset of prediction.fields');
  const predictionOverlayFields = [...scalarPlayerFields].filter(field => !predictionFields.includes(field));
  const legacyPredictionStep = raw.legacyPredictionStep === true;
  const smoothFields = playerNumbers(raw.smoothFields, 'smoothFields');
  let pointerLook: PointerLook | undefined;
  if (raw.pointerLook !== undefined) {
    const path = 'prediction.pointerLook';
    if (!isRecord(raw.pointerLook) || Object.keys(raw.pointerLook).some(key => !['x', 'y', 'disabledWhen'].includes(key)))
      throw new ContractError(`${path}: expected x/y mappings and optional disabledWhen paths`);
    const fields = new Set<string>(), inputs = new Set<string>();
    const parseAxis = (value: unknown): PointerLookAxis | undefined => {
      if (value === undefined) return;
      if (!isRecord(value) || Object.keys(value).some(key => !['field', 'input', 'scale', 'scaleTuning', 'min', 'max'].includes(key))
        || typeof value.field !== 'string' || !predictionFields.includes(value.field) || predictionSnapFields.includes(value.field)
        || fields.has(value.field) || typeof value.input !== 'string' || inputs.has(value.input)
        || typeof value.scale !== 'number' || !Number.isFinite(value.scale)
        || value.scaleTuning !== undefined && (typeof value.scaleTuning !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.scaleTuning))
        || value.min !== undefined && (typeof value.min !== 'number' || !Number.isFinite(value.min))
        || value.max !== undefined && (typeof value.max !== 'number' || !Number.isFinite(value.max))
        || typeof value.min === 'number' && typeof value.max === 'number' && value.min >= value.max)
        throw new ContractError(`${path}: axes require unique non-spatial predicted fields, numeric inputs and finite scales/bounds`);
      const bounds = input.find(([name]) => name === value.input)?.[1];
      if (bounds?.kind !== 'range' || bounds.min > 0 || bounds.max < 0)
        throw new ContractError(`${path}: input must be a declared numeric range containing zero`);
      fields.add(value.field); inputs.add(value.input);
      return { field: value.field, input: value.input, scale: value.scale,
        ...(typeof value.scaleTuning === 'string' ? { scaleTuning: value.scaleTuning } : {}),
        ...(typeof value.min === 'number' ? { min: value.min } : {}), ...(typeof value.max === 'number' ? { max: value.max } : {}) };
    };
    const x = parseAxis(raw.pointerLook.x), y = parseAxis(raw.pointerLook.y);
    if (!x && !y) throw new ContractError(`${path}: declare at least one axis`);
    const disabledWhen = stringList(raw.pointerLook.disabledWhen ?? [], `${path}.disabledWhen`, 16, (SHAPE_LIMITS.depth + 1) * 33);
    if (disabledWhen.some(field => !scalarPlayerFields.has(field))) throw new ContractError(`${path}.disabledWhen: expected declared scalar player-state paths`);
    pointerLook = { ...(x ? { x } : {}), ...(y ? { y } : {}), ...(disabledWhen.length ? { disabledWhen } : {}) };
  }
  const rounds=parseRoundRules(raw.rounds);
  if(rounds){
    const field=world.fields.find(([name])=>name===rounds.stateField)?.[1];
    if(JSON.stringify(field)!==JSON.stringify(parseShape(roundStateShape,'rounds.stateField',0)))throw new ContractError('rounds.stateField: declare roundStateShape in shapes.world');
    for(const [names,shape]of [[rounds.carryWorldFields,world],[rounds.carryPlayerFields,player]]as const)
      if(names?.some(name=>!shape.fields.some(([key])=>key===name)))throw new ContractError('rounds: carry fields must exist in the declared shape');
  }
  const scenes=parseSceneRules(raw.scenes);
  if(scenes){
    const field=world.fields.find(([name])=>name===scenes.stateField)?.[1];
    if(JSON.stringify(field)!==JSON.stringify(parseShape(sceneStateShape,'scenes.stateField',0)))throw new ContractError('scenes.stateField: declare sceneStateShape in shapes.world');
    if(rounds&&(rounds.stateField===scenes.stateField||rounds.carryWorldFields?.includes(scenes.stateField)))throw new ContractError('scenes: reserved scene state cannot be the round state or a carried authored field');
  }
  return {
    ...(rounds?{rounds}:{}),
    ...(scenes?{scenes}:{}),
    mode: raw.mode ?? 'duel',
    supportedModes,
    ...(featureCapabilities ? {featureCapabilities} : {}),
    ...(terrainConstraints ? {terrainConstraints} : {}),
    ...(raw.terrainPrefetch===true?{terrainPrefetch:true}:{}),
    ...(cooperative ? { cooperative } : {}),
    ...(voice && voice.scope !== 'off' ? { voice } : {}),
    ...(playerClasses ? { playerClasses } : {}),
    ...(raw.playerModels === undefined ? {} : { playerModels: parsePlayerModels(raw.playerModels) }),
    world,
    player,
    input,
    ...(inspectionControls ? { inspectionControls } : {}),
    ...(inspectionSetups ? { inspectionSetups } : {}),
    ...(raw.learning === undefined ? {} : { learning: parseLearning(raw.learning, player, world, input) }),
    bindings: parseBindings(raw.bindings ?? []),
    pointer: parsePointer(raw.pointer),
    controlsHint: hint.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, SHAPE_LIMITS.hintLength),
    smoothFields,
    predictionFields,
    predictionSnapFields,
    predictionOverlayFields,
    fastFields: parseNetwork(raw.network, smoothFields, scalarPlayerFields, player),
    ...(legacyPredictionStep ? { legacyPredictionStep: true as const } : {}),
    ...(pointerLook ? { pointerLook } : {}),
    shapesId: hashString(JSON.stringify([raw.shapes.world ?? {}, raw.shapes.player, raw.shapes.input,...(scenes?['scene-input-v1']:[])])),
  };
}

/**
 * Which player fields ride the fast lane (fastLane.ts): the declared smoothFields by default,
 * plus `network.fast`, minus `network.reliable`. Fast fields are scalars (latest value
 * wins) and must fit a per-player byte budget so a full roster stays in a few datagrams.
 */
function parseNetwork(raw: unknown, smooth: readonly string[], scalars: ReadonlySet<string>, player: ObjectKind): string[] {
  if (raw !== undefined && (!isRecord(raw) || Object.keys(raw).some(key => key !== 'fast' && key !== 'reliable'))) {
    throw new ContractError('network: expected { fast?: string[], reliable?: string[] }');
  }
  const network = (raw ?? {}) as { fast?: unknown; reliable?: unknown };
  const list = (value: unknown, path: string) => {
    const fields = stringList(value ?? [], path, 64, (SHAPE_LIMITS.depth + 1) * 33);
    const bad = fields.filter(field => !scalars.has(field));
    if (bad.length) throw new ContractError(`${path}: ${bad.join(', ')} ${bad.length === 1 ? 'is not a scalar field' : 'are not scalar fields'} of shapes.player (numbers, booleans or strings, not lists or maps)`);
    return fields;
  };
  const fast = list(network.fast, 'network.fast'), reliable = new Set(list(network.reliable, 'network.reliable'));
  const both = fast.filter(field => reliable.has(field));
  if (both.length) throw new ContractError(`network: ${both.join(', ')} cannot be both fast and reliable`);
  const fields = [...new Set([...smooth, ...fast])].filter(field => !reliable.has(field));
  const bytes = fastPlayerBytes(fields.map(path => ({ path, kind: scalarKind(player, path)! })));
  if (bytes > FAST_PLAYER_BYTES) {
    throw new ContractError(`network.fast: these fields take up to ${bytes} bytes per player each tick; keep them under ${FAST_PLAYER_BYTES} (a number takes 4, a float64, int32 or uint32 8, a boolean 1, a string up to ${FAST_STRING_BYTES + 1})`);
  }
  return fields;
}

/** FNV-1a, as 8 hex digits. */
function hashString(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Values

export function defaultValue(kind: Kind): unknown {
  switch (kind.kind) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'string': return '';
    case 'array': return [];
    case 'map': return {};
    case 'object': return Object.fromEntries(kind.fields.map(([name, field]) => [name, defaultValue(field)]));
  }
}

/**
 * Forces an untrusted value into `kind`: missing fields get their default,
 * undeclared fields are dropped, strings are cut to length and integers are
 * rounded and clamped. Anything else wrong (a non-finite number, the wrong
 * type, too many entries) throws, naming the field.
 */
export function conform(value: unknown, kind: Kind, path: string): unknown {
  return conformValue(value, kind, path, false);
}

/** The declared world as consumers receive it: validate/copy like conform(),
 * then apply the numeric precision of the installed Colyseus wire codec.
 * Keep this separate from player/input validation and authored simulation state. */
export function conformWire(value: unknown, kind: Kind, path: string): unknown {
  return conformValue(value, kind, path, true);
}

/** Bind a fixed declaration once; each projection still copies current values.
 * Before match setup there is deliberately no world to project. */
export function createWireConformer(shape: unknown, path = 'world'): (value: unknown) => unknown {
  const kind = parseShape(shape, path);
  return value => value === undefined ? undefined : conformWire(value, kind, path);
}

function wireNumber(value: number, type: NumberField, path: string): number {
  if (type === 'float32') {
    value = Math.fround(value);
    if (!Number.isFinite(value)) throw new ContractError(`${path}: expected a finite float32 number`);
  } else if (type === 'number' && value !== (value | 0) && Math.abs(value) <= 3.4028235e+38) {
    // @colyseus/schema's automatic number codec chooses f32 only when this
    // absolute-error check passes; larger/inexact values remain f64.
    const rounded = Math.fround(value);
    if (Math.abs(Math.abs(rounded) - Math.abs(value)) < 1e-4) value = rounded;
  }
  // Integer/automatic encodings do not retain signed zero, including an
  // automatic f32 underflow that will be encoded again after projection.
  return type !== 'float32' && type !== 'float64' && value === 0 ? 0 : value;
}

function conformValue(value: unknown, kind: Kind, path: string, wire: boolean): unknown {
  switch (kind.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ContractError(`${path}: expected a finite number, got ${describe(value)}`);
      const range = NUMBER_RANGES[kind.type];
      const number = range ? Math.min(range[1], Math.max(range[0], Math.round(value))) : value;
      return wire ? wireNumber(number, kind.type, path) : number;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new ContractError(`${path}: expected true or false, got ${describe(value)}`);
      return value;
    case 'string':
      if (typeof value !== 'string') throw new ContractError(`${path}: expected a string, got ${describe(value)}`);
      return value.slice(0, SHAPE_LIMITS.stringLength);
    case 'array': {
      if (!Array.isArray(value)) throw new ContractError(`${path}: expected a list, got ${describe(value)}`);
      if (value.length > SHAPE_LIMITS.entries) throw new ContractError(`${path}: more than ${SHAPE_LIMITS.entries} entries`);
      return value.map((item, i) => conformValue(item, kind.of, `${path}[${i}]`, wire));
    }
    case 'map': {
      if (!isRecord(value)) throw new ContractError(`${path}: expected an object map, got ${describe(value)}`);
      const keys = Object.keys(value);
      if (keys.length > SHAPE_LIMITS.entries) throw new ContractError(`${path}: more than ${SHAPE_LIMITS.entries} entries`);
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (key.length === 0 || key.length > SHAPE_LIMITS.mapKeyLength || key === '__proto__') throw new ContractError(`${path}: invalid key ${describe(key)}`);
        out[key] = conformValue(value[key], kind.of, `${path}.${key}`, wire);
      }
      return out;
    }
    case 'object': {
      if (!isRecord(value)) throw new ContractError(`${path}: expected an object, got ${describe(value)}`);
      const out: Record<string, unknown> = {};
      for (const [name, field] of kind.fields) {
        out[name] = Object.hasOwn(value, name) && value[name] !== undefined ? conformValue(value[name], field, `${path}.${name}`, wire) : defaultValue(field);
      }
      return out;
    }
  }
}

/** Clamps an input to its declared fields: numbers into their range (non-finite -> 0), booleans as booleans. */
export function conformInput(value: unknown, input: InputKind): Record<string, number | boolean> {
  const source = isRecord(value) ? value : {};
  const out: Record<string, number | boolean> = {};
  for (const [name, field] of input) {
    const raw = source[name];
    if (field.kind === 'boolean') out[name] = raw === true;
    else out[name] = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(field.max, Math.max(field.min, raw)) : 0;
  }
  return out;
}

/** Bounded per-roster events, each a short type plus primitive details. Invalid ones are dropped. */
export function conformEvents(value: unknown, playerCount = 2): { type: string; player?: number; [detail: string]: unknown }[] {
  if (!Array.isArray(value)) return [];
  const events = [];
  for (const raw of value.slice(0, matchEventLimit(playerCount))) {
    if (!isRecord(raw) || typeof raw.type !== 'string' || !raw.type || raw.type.length > 32) continue;
    const event: { type: string; player?: number; [detail: string]: unknown } = { type: raw.type };
    if (typeof raw.player === 'number' && Number.isInteger(raw.player) && raw.player >= 0 && raw.player < Math.min(playerCount, MAX_MATCH_PLAYERS)) event.player = raw.player;
    let details = 0;
    for (const [key, detail] of Object.entries(raw)) {
      if (key === 'type' || key === 'player' || !FIELD_NAME.test(key) || details >= SHAPE_LIMITS.eventDetails) continue;
      if (typeof detail === 'number' && Number.isFinite(detail)) event[key] = detail;
      else if (typeof detail === 'boolean') event[key] = detail;
      else if (typeof detail === 'string') event[key] = detail.slice(0, 64);
      else continue;
      details++;
    }
    events.push(event);
  }
  return events;
}

/** Health from the game: ignored unless finite (maxHp above 0). */
export function conformHealth(value: unknown, current: { hp: number; maxHp: number }): { hp: number; maxHp: number } {
  const raw = isRecord(value) ? value : {};
  return {
    hp: isFiniteNumber(raw.hp) ? raw.hp : current.hp,
    maxHp: isFiniteNumber(raw.maxHp) && raw.maxHp > 0 ? raw.maxHp : current.maxHp,
  };
}

/** Up to 16 finite numbers under identifier names (the view's `info()`). */
export function conformViewInfo(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, number] of Object.entries(value).slice(0, SHAPE_LIMITS.viewInfo)) {
    if (FIELD_NAME.test(key) && isFiniteNumber(number)) out[key] = number;
  }
  return out;
}

/** Plain-text HUD lines: at most `maxLines` lines of `maxChars` characters, control characters removed. */
export function conformLines(value: unknown, maxLines: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxLines).map((line) => String(typeof line === 'string' ? line : '').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, maxChars));
}

function describe(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 20));
  return Array.isArray(value) ? 'a list' : typeof value;
}
