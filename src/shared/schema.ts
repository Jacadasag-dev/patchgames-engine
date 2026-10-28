import { ArraySchema, MapSchema, schema, t, type Schema } from '@colyseus/schema';
import type { GameInfo, Kind, ObjectKind } from './shapes.ts';
import type { Phase } from './types.ts';

// Room state. The core owns the match (phase, timer, result) and each
// player's identity and health; the game module's `world` and per-player
// `game` state are built here from its checked shape declarations, and only
// ever written by applyGameState() with values that already passed conform().

type SchemaClass = new () => Schema;
type AnyRecord = Record<string, unknown>;

const ActivityMember = schema({
  name: t.string(),
  avatar: t.string(),
  /** Stable media identity across game-room handoffs. */
  voiceIdentity: t.string(),
  connected: t.boolean().default(true),
  /** -1 watches; 0 and 1 are the two duel slots. */
  slot: t.int8().default(-1),
  ready: t.boolean(),
  /** The participant's chosen campaign class; empty for games without classes. */
  classId: t.string().default(''),
  /** Cosmetic model selected by this participant from the game catalog. */
  modelId: t.string().default(''),
  /** JSON array of the session ids voting to remove this member while host control is off; empty when none. */
  kickVotes: t.string().default(''),
}, 'ActivityMember');
export type ActivityMemberState = InstanceType<typeof ActivityMember>;

const PRIMITIVE = { boolean: 'boolean', string: 'string' } as const;

/** The element class of each list/map/object Kind, for creating entries. */
const classes = new WeakMap<Kind, SchemaClass>();

function fieldBuilder(kind: Kind, name: string) {
  switch (kind.kind) {
    case 'number': return t[kind.type]().default(0);
    case 'boolean': return t.boolean().default(false);
    case 'string': return t.string().default('');
    case 'object': return t.ref(objectClass(kind, name));
    case 'array': return kind.of.kind === 'object' ? t.array(objectClass(kind.of, name)) : t.array(primitiveType(kind.of));
    case 'map': return kind.of.kind === 'object' ? t.map(objectClass(kind.of, name)) : t.map(primitiveType(kind.of));
  }
}

function primitiveType(kind: Kind) {
  if (kind.kind === 'number') return kind.type;
  if (kind.kind === 'boolean' || kind.kind === 'string') return PRIMITIVE[kind.kind];
  // parseShape allows nested collections; the wire format doesn't.
  throw new Error('Lists and maps must hold numbers, booleans, strings or objects');
}

function objectClass(kind: ObjectKind, name: string): SchemaClass {
  const existing = classes.get(kind);
  if (existing) return existing;
  const fields = Object.fromEntries(kind.fields.map(([field, child]) => [field, fieldBuilder(child, `${name}_${field}`)]));
  const created = schema(fields, name) as unknown as SchemaClass;
  classes.set(kind, created);
  return created;
}

function inputClass(info: GameInfo): SchemaClass {
  const fields = Object.fromEntries(info.input.map(([name, field]) => [name, field.kind === 'boolean' ? t.boolean() : t.float32()]));
  // Engine-only epoch: authored input identifiers cannot begin with underscore.
  if(info.scenes)fields.__sceneSequence=t.uint32().default(0);
  return schema(fields, `GameInput_${info.shapesId}`) as unknown as SchemaClass;
}

function buildStateSchemas(info: GameInfo) {
  const WorldState = objectClass(info.world, `GameWorld_${info.shapesId}`);
  const GameState = objectClass(info.player, `GamePlayer_${info.shapesId}`);

  const PlayerState = schema({
    name: t.string().default(''),
    hp: t.number().default(0),
    maxHp: t.number().default(1),
    rematchReady: t.boolean().default(false),
    connected: t.boolean().default(true),
    /** Open-session participants retain inactive seats until another player joins. */
    active: t.boolean().default(true),
    /** Chosen before a cooperative campaign starts, fixed for that run. */
    classId: t.string().default(''),
    /** Host-validated cosmetic choice; never changes collision or identity. */
    modelId: t.string().default(''),
    /** Host-assigned team in team rounds (seat parity); -1 otherwise. */
    team: t.int8().default(-1),
    /** Authoritative progress towards reviving this downed participant (0–1). */
    reviveProgress: t.number().default(0),
    isBot: t.boolean().default(false),
    /** Leaderboard rating (rounded); 0 for a player without a saved identity. */
    rating: t.number().default(0),
    /** How the last match changed the rating (rounded). */
    ratingChange: t.number().default(0),
    /** The game's per-player voice state as JSON ({channel?, effect?, hearing?, silent?}), or '' (docs/voice-chat.md). */
    voice: t.string().default(''),
    game: t.ref(GameState),
  }, `PlayerState_${info.shapesId}`);

  const RoomState = schema({
    discordActivity: t.boolean(),
    friendsLobby: t.boolean(),
    lobbyHost: t.string().default(''),
    lobbyControl: t.boolean().default(true),
    /** The host's lobby voice switch: private lobbies open with voice on (docs/voice-chat.md). */
    lobbyVoice: t.boolean().default(true),
    /** The game's voice declaration as JSON ({scope, spatial}), or '' for no in-game voice. */
    gameVoice: t.string().default(''),
    customRevisionId: t.string(),
    customGameName: t.string(),
    lobbyPacks: t.string().default(''),
    members: t.map(ActivityMember),
    matchId: t.string(),
    phase: t.string<Phase>().default('waiting'),
    countdown: t.uint8(),
    /** Spawn-region generation is in progress; the countdown is paused. */
    preparing: t.boolean().default(false),
    /** The cancellable lobby countdown precedes the normal in-arena countdown. */
    lobbyCountdown: t.boolean(),
    mode: t.string().default('duel'),
    /** The game's tags as a JSON list (docs/game-tags.md); `mode` is the shape they select. */
    tags: t.string().default('[]'),
    /** 0 for individual play, 2 for team rounds. */
    teams: t.uint8().default(0),
    /** The game's roster declaration as JSON, or '' (docs/game-tags.md). */
    roster: t.string().default(''),
    maxPlayers: t.uint8().default(2),
    /** Whether this content uses cooperative campaign rules in RPG mode. */
    cooperative: t.boolean().default(false),
    /** Validated authored class choices, for the lobby's generic class picker. */
    playerClasses: t.string().default('[]'),
    /** Seconds left under the selected mode's time limit. */
    secondsLeft: t.uint16(),
    winnerId: t.string(),
    winnerName: t.string(),
    /** The winning team of a team round; -1 otherwise. */
    winnerTeam: t.int8().default(-1),
    /** Decided result shown over the continuing game during the finish window. */
    resultReason: t.string(),
    /** Cooperative campaigns have a party result instead of an individual winner. */
    cooperativeResult: t.string<'' | 'victory' | 'defeat'>().default(''),
    /** The match ended with equal health: no one wins. */
    draw: t.boolean(),
    /** A newer version of the game is live; the next rematch moves this match to it. */
    outdated: t.boolean(),
    /** A rated match the matchmaking queue made (private matches are never rated, and have rematches). */
    ranked: t.boolean(),
    /** A learned specialist is published for this exact game edition. */
    canAddBot: t.boolean(),
    /** Local practice experiments available for this exact edition; empty in production. */
    botExperiments: t.string().default('[]'),
    /** Private practice with an idle opponent, independent of game bot policies. */
    canStartTraining: t.boolean(),
    /** After a match: '' (not ended), 'pending', 'rated' or 'unrated' (see unratedReason). */
    ratingStatus: t.string<'' | 'pending' | 'rated' | 'unrated'>(),
    unratedReason: t.string(),
    /** Exact gameplay/terrain identity inputs; automatic number encoding may round to float32. */
    tuning: t.map('float64'),
    players: t.map(PlayerState),
    world: t.ref(WorldState),
  }, `RoomState_${info.shapesId}`);

  return { RoomState, PlayerState, ActivityMember, Input: inputClass(info) };
}

export type StateSchemas = ReturnType<typeof buildStateSchemas>;
export type RoomState = InstanceType<StateSchemas['RoomState']>;
export type PlayerState = InstanceType<StateSchemas['PlayerState']>;

const built = new Map<string, StateSchemas>();

const builtFrom = new Map<string, GameInfo>();

/** The room state classes for a game's shapes (cached: one set per distinct shapes). */
export function stateSchemas(info: GameInfo): StateSchemas {
  let schemas = built.get(info.shapesId);
  if (!schemas) {
    schemas = buildStateSchemas(info);
    built.set(info.shapesId, schemas);
    builtFrom.set(info.shapesId, info);
  } else {
    // Same shapes, parsed again: point its Kinds at the classes already built.
    const original = builtFrom.get(info.shapesId)!;
    linkKinds(original.world, info.world);
    linkKinds(original.player, info.player);
  }
  return schemas;
}

function linkKinds(from: Kind, to: Kind): void {
  if (from === to) return;
  const known = classes.get(from);
  if (known) classes.set(to, known);
  if (from.kind === 'object' && to.kind === 'object') from.fields.forEach(([, child], i) => linkKinds(child, to.fields[i][1]));
  if ((from.kind === 'array' || from.kind === 'map') && (to.kind === 'array' || to.kind === 'map')) linkKinds(from.of, to.of);
}

/** Copies a conformed value into a synced object, touching only what changed. */
export function applyGameState(target: Schema, value: AnyRecord, kind: ObjectKind): void {
  const record = target as unknown as AnyRecord;
  for (const [name, field] of kind.fields) {
    const next = value[name];
    switch (field.kind) {
      case 'object': {
        let child = record[name] as Schema | undefined;
        if (!child) record[name] = child = new (classes.get(field)!)();
        applyGameState(child, next as AnyRecord, field);
        break;
      }
      case 'array':
        applyArray(record[name] as ArraySchema<unknown>, next as unknown[], field.of);
        break;
      case 'map':
        applyMap(record[name] as MapSchema<unknown>, next as AnyRecord, field.of);
        break;
      default:
        if (record[name] !== next) record[name] = next;
    }
  }
}

function applyArray(target: ArraySchema<unknown>, value: unknown[], of: Kind): void {
  while (target.length > value.length) target.pop();
  value.forEach((item, i) => {
    if (of.kind === 'object') {
      if (i >= target.length) target.push(new (classes.get(of)!)());
      applyGameState(target[i] as Schema, item as AnyRecord, of);
    } else if (i >= target.length) {
      target.push(item);
    } else if (target[i] !== item) {
      target[i] = item;
    }
  });
}

function applyMap(target: MapSchema<unknown>, value: AnyRecord, of: Kind): void {
  for (const key of [...target.keys()]) if (!Object.hasOwn(value, key)) target.delete(key);
  for (const [key, item] of Object.entries(value)) {
    if (of.kind === 'object') {
      let child = target.get(key) as Schema | undefined;
      if (!child) target.set(key, (child = new (classes.get(of)!)()));
      applyGameState(child, item as AnyRecord, of);
    } else if (target.get(key) !== item) {
      target.set(key, item);
    }
  }
}
