import type { GameModeId } from './gameModes.ts';
import type { RosterDeclaration } from './shapes.ts';
import { MAX_MATCH_PLAYERS, MAX_TEAMS } from './gameModes.ts';
export { MAX_TEAMS } from './gameModes.ts';

/** A game is described by up to three tags; the tags decide the host rules it runs
 * under (docs/game-tags.md). Archetype tags (duel, arena, rpg, social) set the session
 * shape and are mutually exclusive; modifier tags (team, creative, survival) blend in.
 * Content never declares a tag: it still sees the legacy shape id as ctx.mode and
 * declares the shapes it supports in supportedModes. Ids are persisted on games,
 * revisions and plays; labels are display text. */
export const GAME_TAG_IDS = ['duel', 'arena', 'rpg', 'social', 'team', 'creative', 'survival'] as const;
export type GameTagId = typeof GAME_TAG_IDS[number];
export const ARCHETYPE_TAGS = ['duel', 'arena', 'rpg', 'social'] as const;
export type ArchetypeTag = typeof ARCHETYPE_TAGS[number];
export const MODIFIER_TAGS = ['team', 'creative', 'survival'] as const;
export type ModifierTag = typeof MODIFIER_TAGS[number];
/** A game carries at most this many tags. With this vocabulary the largest valid set is
 * an archetype and two modifiers; the cap is the structural limit later tags obey. */
export const MAX_GAME_TAGS = 3;
/** Team games have two teams unless the game declares more (up to MAX_TEAMS); seat parity decides the team. */
export const TEAM_COUNT = 2;
/** Names and colours for up to sixteen teams, by team index. */
export const TEAM_NAMES = ['Blue', 'Orange', 'Green', 'Red', 'Purple', 'Gold', 'Teal', 'Pink', 'Lime', 'Crimson', 'Sky', 'Amber', 'Violet', 'Mint', 'Coral', 'Slate'] as const;
export const TEAM_COLORS = ['#4f8cff', '#ff9a3c', '#3ecf6e', '#ff5c5c', '#a46bff', '#e8c547', '#2fd3c8', '#ff6fb5', '#b6e34a', '#c83f5f', '#6fd0ff', '#ffb347', '#7f5cff', '#7ff0c0', '#ff8070', '#8a9bb0'] as const;
/** Survival hunger: a full health bar drains over this long, from the start of play. */
export const SURVIVAL_STARVATION_MS = 240_000;
/** Open worlds without one-life rules put a knocked-out player back after this long. */
export const FREE_PLAY_RESPAWN_MS = 3000;

/** Legacy ids still accepted on input. */
const TAG_ALIASES: Readonly<Record<string, GameTagId>> = Object.freeze({ 'just-chatting': 'social', 'battle-royale': 'arena' });
/** The legacy shape id content sees as ctx.mode and declares in supportedModes. */
const SHAPE_OF_ARCHETYPE: Readonly<Record<ArchetypeTag, GameModeId>> = Object.freeze({ duel: 'duel', arena: 'battle-royale', rpg: 'rpg', social: 'just-chatting' });
const ARCHETYPE_OF_MODE: Readonly<Record<GameModeId, ArchetypeTag>> = Object.freeze({ duel: 'duel', 'battle-royale': 'arena', rpg: 'rpg', 'just-chatting': 'social' });

interface TagDefinition { label: string; summary: string }
const TAGS: Readonly<Record<GameTagId, TagDefinition>> = Object.freeze({
  duel: Object.freeze({ label: 'Duel', summary: '60 seconds, one life, the last one standing or the highest health wins. Opens with two seats; rated when the queue made the room.' }),
  arena: Object.freeze({ label: 'Arena', summary: 'Five minutes, one life, contact healing. The last one standing wins. Opens with 32 seats.' }),
  rpg: Object.freeze({ label: 'RPG', summary: 'No clock. Cooperative content locks the party, downs players and lets teammates revive them. Opens with five seats.' }),
  social: Object.freeze({ label: 'Just Chatting', summary: 'No damage, no clock, host text chat. Opens with 32 seats.' }),
  team: Object.freeze({ label: 'Teams', summary: 'Two teams by seat. No friendly fire; a knocked-out player stays down, and a team with nobody standing loses.' }),
  creative: Object.freeze({ label: 'Creative', summary: 'No damage, no winner and no clock. Build and explore; the host ends the session.' }),
  survival: Object.freeze({ label: 'Survival', summary: 'Hunger drains health over time; healing items keep you alive.' }),
});
const CONFLICTS: readonly (readonly [GameTagId, GameTagId, string])[] = [
  ['creative', 'survival', 'Creative turns damage off, so Survival has nothing to drain.'],
  ['creative', 'team', 'Creative removes the competition that Teams need.'],
  ['team', 'rpg', 'An RPG party is already one team.'],
  ['team', 'social', 'Social games have no competition for teams.'],
  ['survival', 'social', 'Social games have no damage for hunger to drain.'],
  ['creative', 'social', 'Social games already have no damage, clock or winner.'],
];

export class GameTagError extends Error {}

export function isGameTag(value: unknown): value is GameTagId {
  return typeof value === 'string' && (GAME_TAG_IDS as readonly string[]).includes(value);
}
export function isArchetypeTag(tag: unknown): tag is ArchetypeTag {
  return typeof tag === 'string' && (ARCHETYPE_TAGS as readonly string[]).includes(tag);
}
export function tagLabel(tag: GameTagId): string { return TAGS[tag].label; }
export function tagSummary(tag: GameTagId): string { return TAGS[tag].summary; }
/** A tag id, a legacy alias, or nothing. */
function resolveTag(value: unknown): GameTagId | undefined {
  if (isGameTag(value)) return value;
  return typeof value === 'string' ? TAG_ALIASES[value] : undefined;
}
/** A tag id or a legacy mode id (the archetype it meant) as a tag; undefined for anything else. */
export function toGameTag(value: unknown): GameTagId | undefined { return resolveTag(value); }
/** The legacy shape id an archetype tag's rows were keyed by; modifiers have none. */
export function legacyShapeOf(tag: GameTagId): GameModeId | undefined {
  return isArchetypeTag(tag) ? SHAPE_OF_ARCHETYPE[tag] : undefined;
}

/** Why `candidate` cannot join `selected`, or undefined when it can. The same text
 * explains a disabled toggle and a rejected request. Another archetype is not a
 * problem for an archetype candidate: the picker swaps them (toggleTag). */
export function tagProblem(selected: readonly GameTagId[], candidate: GameTagId): string | undefined {
  const others = selected.filter(tag => tag !== candidate && !(isArchetypeTag(candidate) && isArchetypeTag(tag)));
  for (const [a, b, reason] of CONFLICTS) {
    if ((candidate === a && others.includes(b)) || (candidate === b && others.includes(a))) return reason;
  }
  if (others.length >= MAX_GAME_TAGS) return `A game can have at most ${MAX_GAME_TAGS} tags.`;
  return undefined;
}

/** The single validation of a tag set: known ids (aliases mapped), no duplicates, the
 * cap, one archetype at most and no conflicting pair. Returns the canonical order. */
export function normalizeTags(tags: unknown): GameTagId[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new GameTagError('Tags must be a list of tag ids.');
  const resolved = tags.map(value => {
    const tag = resolveTag(value);
    if (!tag) throw new GameTagError(`Unknown tag ${JSON.stringify(value)}. Choose from ${GAME_TAG_IDS.join(', ')}.`);
    return tag;
  });
  const unique = GAME_TAG_IDS.filter(tag => resolved.includes(tag));
  if (unique.length !== resolved.length) throw new GameTagError('Choose each tag once.');
  if (unique.length > MAX_GAME_TAGS) throw new GameTagError(`A game can have at most ${MAX_GAME_TAGS} tags.`);
  const archetypes = unique.filter(isArchetypeTag);
  if (archetypes.length > 1) throw new GameTagError(`${archetypes.map(tagLabel).join(' and ')} are both game kinds; keep one.`);
  for (let index = 0; index < unique.length; index++) {
    const problem = tagProblem(unique.slice(0, index), unique[index]);
    if (problem) throw new GameTagError(problem);
  }
  return unique;
}

/** Stored JSON (or an already parsed list) to tags; aliases are mapped and unknown values
 * dropped so a row written by a newer release still loads. Validation happens on write. */
export function readTags(value: unknown): GameTagId[] {
  let list: unknown = value;
  if (typeof value === 'string') { try { list = value ? JSON.parse(value) : []; } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  const resolved = list.map(resolveTag).filter((tag): tag is GameTagId => tag !== undefined);
  return GAME_TAG_IDS.filter(tag => resolved.includes(tag));
}

/** Keep what fits, in the given order: the first archetype wins, later tags that conflict
 * are dropped. Used when a mode changes under existing tags and when migrating rows. */
export function compatibleTags(tags: readonly unknown[]): GameTagId[] {
  const kept: GameTagId[] = [];
  for (const value of tags) {
    const tag = resolveTag(value);
    if (!tag || kept.includes(tag) || (isArchetypeTag(tag) && kept.some(isArchetypeTag)) || tagProblem(kept, tag)) continue;
    kept.push(tag);
  }
  return GAME_TAG_IDS.filter(tag => kept.includes(tag));
}

/** The tags a legacy mode (and the flags of the interim design) describe. */
export function tagsFromLegacy(mode?: string | null, flags?: unknown): GameTagId[] {
  const archetype = mode ? resolveTag(mode) : undefined;
  return readTags([...(archetype ? [archetype] : []), ...readTags(flags)]);
}
export function archetypeTag(mode: GameModeId): ArchetypeTag { return ARCHETYPE_OF_MODE[mode]; }
export function archetypeOf(tags: readonly GameTagId[]): ArchetypeTag | 'free' {
  return ARCHETYPE_TAGS.find(tag => tags.includes(tag)) ?? 'free';
}
/** The legacy shape content sees: the archetype's id, or the 1–32 open roster of just-chatting for free play. */
export function shapeOf(tags: readonly GameTagId[]): GameModeId {
  const archetype = archetypeOf(tags);
  return archetype === 'free' ? 'just-chatting' : SHAPE_OF_ARCHETYPE[archetype];
}
export function archetypeLabel(archetype: ArchetypeTag | 'free'): string {
  return archetype === 'free' ? 'Free play' : tagLabel(archetype);
}
/** "Duel", "Duel · Teams", "Arena · Teams · Survival", "Free play". */
export function gameTagsLabel(tags: readonly GameTagId[]): string {
  return tags.length ? GAME_TAG_IDS.filter(tag => tags.includes(tag)).map(tagLabel).join(' · ') : 'Free play';
}

/** Starters: the seeded game a new game begins from and a lobby can pick. One per tag
 * (its category's stock content or the game the last season elected) plus the blank
 * canvas. Choosing one pre-fills its game's tags. */
export const GAME_STARTER_IDS = [...GAME_TAG_IDS, 'fps', 'voxel-survival', 'blank'] as const;
export type GameStarterId = typeof GAME_STARTER_IDS[number];
export function isGameStarter(value: unknown): value is GameStarterId {
  return typeof value === 'string' && (GAME_STARTER_IDS as readonly string[]).includes(value);
}
/** The tags a starter's stock content pre-fills; an elected starter pre-fills its game's tags instead. */
export function starterTags(starter: GameStarterId): GameTagId[] {
  return starter === 'blank' ? [] : starter === 'fps' ? ['team'] : starter === 'voxel-survival' ? ['survival'] : [starter];
}
export function starterLabel(starter: GameStarterId): string {
  return starter === 'blank' ? 'Blank canvas' : starter === 'fps' ? 'Tactical FPS starter' : starter === 'voxel-survival' ? 'Voxel survival starter' : `${tagLabel(starter)} starter`;
}
/** The starter a legacy `base: season` request means: the archetype's, else the first modifier's, else the canvas. */
export function starterForTags(tags: readonly GameTagId[]): GameTagId | 'blank' {
  const archetype = archetypeOf(tags);
  return archetype !== 'free' ? archetype : GAME_TAG_IDS.find(tag => tags.includes(tag) && !isArchetypeTag(tag)) ?? 'blank';
}
/** The legacy shape an archetype starter's stock content is registered under. */
export function starterShape(starter: ArchetypeTag): GameModeId {
  return SHAPE_OF_ARCHETYPE[starter];
}

/** The rules every host component reads, derived once from the tags. */
export interface GameRules {
  tags: readonly GameTagId[];
  archetype: ArchetypeTag | 'free';
  /** The legacy shape id for content compatibility (ctx.mode, supportedModes). */
  shape: GameModeId;
  /** The fewest players a round starts with: one for open sessions, two (one per team) for competitive rounds. */
  minPlayers: number;
  /** The engine limit (MAX_MATCH_PLAYERS); no tag caps a roster below it. */
  maxPlayers: number;
  /** The seats a lobby opens with; the host may change them within minPlayers..maxPlayers. */
  seats: number;
  /** 0 means no clock. */
  durationMs: number;
  /** Open to arrivals and departures while it runs; never rated. */
  openSession: boolean;
  /** Checked damage entities reduce health. */
  damage: boolean;
  /** Checked contact healing of living participants. Cooperative recovery is content-owned and separate. */
  healing: boolean;
  /** 0 for individual play, TEAM_COUNT for team play. */
  teams: number;
  /** A knocked-out player stays down until the round ends instead of ending it or respawning. */
  oneLife: boolean;
  /** Open worlds put a knocked-out player back after this long; 0 disables respawns. */
  respawnMs: number;
  /** Hunger: a full health bar drains over this many milliseconds; 0 disables it. */
  attritionMs: number;
  /** The host decides a winner or a draw when the round ends. */
  competitive: boolean;
  /** Content's cooperative contract (locked party, downed players, revives, party result) is honoured. */
  cooperative: boolean;
  /** Host text chat in the lobby and the running session. */
  chat: boolean;
  /** Private rounds record ratings; the queue only ever makes duels. */
  rated: boolean;
  /** Rounds are recorded and verifiable. */
  replay: boolean;
}

/** Deterministic and ordered: free play, then the archetype, then the modifiers in
 * vocabulary order. Later tags win where two touch the same field; the only overlaps
 * are the intended ones (team closes and sharpens any archetype, creative reopens and
 * disarms, survival turns healing on), and the conflicting pairs are rejected instead.
 * No tag caps the roster: `maxPlayers` is the engine limit, a tag sets only the minimum
 * a round needs and the seats a lobby opens with. A game's own roster declaration then
 * bounds those: its range becomes the limits, its count the seats, and its team count
 * the teams the team tag deals seats to (docs/game-tags.md). */
export function gameRules(tags: readonly GameTagId[] = [], roster?: RosterDeclaration | null): GameRules {
  const archetype = archetypeOf(tags);
  const rules: GameRules = {
    tags: [...tags], archetype, shape: shapeOf(tags),
    minPlayers: 1, maxPlayers: MAX_MATCH_PLAYERS, seats: MAX_MATCH_PLAYERS, durationMs: 0, openSession: true, damage: true, healing: false, teams: 0, oneLife: false,
    respawnMs: FREE_PLAY_RESPAWN_MS, attritionMs: 0, competitive: false, cooperative: false, chat: false, rated: false, replay: false,
  };
  // A duel of any size is one life each: the round ends when at most one player stands, else the clock decides.
  if (archetype === 'duel') Object.assign(rules, { minPlayers: 2, seats: 2, durationMs: 60_000, openSession: false, oneLife: true, respawnMs: 0, competitive: true, rated: true, replay: true });
  if (archetype === 'arena') Object.assign(rules, { minPlayers: 2, seats: MAX_MATCH_PLAYERS, durationMs: 300_000, openSession: false, healing: true, oneLife: true, respawnMs: 0, competitive: true, replay: true });
  if (archetype === 'rpg') Object.assign(rules, { minPlayers: 1, seats: 5, cooperative: true });
  if (archetype === 'social') Object.assign(rules, { damage: false, respawnMs: 0, chat: true });
  if (tags.includes('team')) {
    const teams = roster?.teams && roster.teams >= 2 ? Math.min(roster.teams, MAX_TEAMS) : TEAM_COUNT;
    Object.assign(rules, { teams, oneLife: true, competitive: true, openSession: false, respawnMs: 0, rated: false, replay: true, minPlayers: Math.max(rules.minPlayers, teams) });
    if (archetype === 'duel') rules.seats = 2 * teams;
    rules.seats = Math.max(rules.seats, teams);
  }
  if (tags.includes('creative')) {
    Object.assign(rules, { damage: false, healing: false, durationMs: 0, openSession: true, minPlayers: 1, oneLife: false, competitive: false, attritionMs: 0, cooperative: false, respawnMs: 0, rated: false, replay: false });
  }
  if (tags.includes('survival')) { rules.attritionMs = SURVIVAL_STARVATION_MS; rules.healing = rules.damage; }
  // The game's declared players bound the rules: the engine limit becomes the declared maximum,
  // the minimum rises to the declared one, and the lobby opens with the declared count.
  if (roster?.players) {
    rules.maxPlayers = Math.min(MAX_MATCH_PLAYERS, roster.players[1]);
    rules.minPlayers = Math.min(rules.maxPlayers, Math.max(rules.minPlayers, roster.players[0]));
    rules.seats = rules.maxPlayers;
  }
  rules.seats = Math.min(rules.maxPlayers, Math.max(rules.seats, rules.minPlayers));
  return rules;
}

/** Conflicts between a game's roster declaration and its tags, reported rather than resolved. */
export function rosterWarnings(tags: readonly GameTagId[], roster: RosterDeclaration | null | undefined): string[] {
  const warnings: string[] = [];
  if (!roster) return warnings;
  if (roster.teams !== undefined && roster.teams >= 2 && !tags.includes('team'))
    warnings.push(`The game declares ${roster.teams} teams but has no team tag: team rules are off and the lobby seats one group. Add the team tag or declare teams: 0.`);
  if (roster.teams === 0 && tags.includes('team'))
    warnings.push('The team tag is set but the roster declares no teams: two teams by seat parity apply. Declare the teams or remove the tag.');
  return warnings;
}

/** A roster declaration from synced state or stored JSON; anything malformed reads as none. */
export function readRoster(value: unknown): RosterDeclaration | undefined {
  let raw: unknown = value;
  if (typeof value === 'string') { if (!value) return undefined; try { raw = JSON.parse(value); } catch { return undefined; } }
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>, integer = (item: unknown): item is number => typeof item === 'number' && Number.isInteger(item);
  const roster: { players?: [number, number]; teams?: number; teamSize?: number } = {};
  if (Array.isArray(record.players) && record.players.length === 2 && record.players.every(integer)) roster.players = [record.players[0] as number, record.players[1] as number];
  if (integer(record.teams)) roster.teams = record.teams;
  if (integer(record.teamSize)) roster.teamSize = record.teamSize;
  return roster;
}

/** The rules a loaded game runs under: its host-selected tags (else the shape its content declared), bounded by its roster declaration. */
export function rulesOf(info: { mode?: GameModeId; tags?: readonly GameTagId[]; roster?: RosterDeclaration }): GameRules {
  return gameRules(info.tags ?? tagsFromLegacy(info.mode ?? 'duel'), info.roster);
}
/** The rules of synced room state: its tags when present (else the mode of an older server) and the game's roster. */
export function rulesOfState(state: { mode?: string; tags?: string | null; roster?: string | null } | null | undefined): GameRules {
  if (!state) return gameRules(tagsFromLegacy('duel'));
  return gameRules(state.tags == null ? tagsFromLegacy(state.mode ?? 'duel') : readTags(state.tags), readRoster(state.roster));
}

/** Within the rules' minimum and the engine limit; the lobby's seat count is checked separately. */
export function validRosterCount(rules: GameRules, count: number): boolean {
  return Number.isInteger(count) && count >= rules.minPlayers && count <= rules.maxPlayers;
}
/** A requested seat count held within the rules: the default when absent or invalid. */
export function clampSeats(rules: GameRules, count: unknown): number {
  if (typeof count !== 'number' || !Number.isInteger(count)) return rules.seats;
  return Math.min(rules.maxPlayers, Math.max(rules.minPlayers, count));
}

/** The team a lobby seat belongs to: -1 for spectators and individual play. */
export function teamForSlot(slot: number, teams: number): number {
  return teams > 0 && Number.isInteger(slot) && slot >= 0 ? slot % teams : -1;
}
export function teamLabel(team: number): string {
  return TEAM_NAMES[team] ?? `Team ${team + 1}`;
}
export function teamColor(team: number): string {
  return TEAM_COLORS[team] ?? '#9aa4b2';
}
/** Team rounds also need every team represented among the seated players. */
export function teamsSeated(rules: GameRules, slots: readonly number[]): boolean {
  return teamsRepresented(rules, slots.map(slot => teamForSlot(slot, rules.teams)));
}
export function teamsRepresented(rules: GameRules, teams: readonly number[]): boolean {
  if (rules.teams <= 0) return true;
  return new Set(teams.filter(team => team >= 0)).size === rules.teams;
}
/** The team standing for a result: living members, then total health. */
export function teamStandings(rules: GameRules, players: readonly { team: number; hp: number }[]): { team: number; alive: number; hp: number }[] {
  return Array.from({ length: rules.teams }, (_, team) => {
    const members = players.filter(player => player.team === team);
    return { team, alive: members.filter(player => player.hp > 0).length, hp: members.reduce((sum, player) => sum + Math.max(0, player.hp), 0) };
  });
}
/** The winning team of a team round, or null for a draw: more living members, then more total health. */
export function decideTeamWinner(rules: GameRules, players: readonly { team: number; hp: number }[]): number | null {
  const standings = teamStandings(rules, players).sort((a, b) => b.alive - a.alive || b.hp - a.hp);
  if (standings.length < 2 || (standings[0].alive === standings[1].alive && standings[0].hp === standings[1].hp)) return null;
  return standings[0].team;
}

export interface TagOption { id: GameTagId; label: string; summary: string; kind: 'archetype' | 'modifier'; selected: boolean; problem?: string }
/** The picker model: every tag, with why a toggle is disabled. */
export function tagOptions(selected: readonly GameTagId[]): TagOption[] {
  return GAME_TAG_IDS.map(tag => {
    const on = selected.includes(tag), problem = on ? undefined : tagProblem(selected, tag);
    return { id: tag, label: TAGS[tag].label, summary: TAGS[tag].summary, kind: isArchetypeTag(tag) ? 'archetype' : 'modifier', selected: on, ...(problem ? { problem } : {}) };
  });
}
/** The selection after a toggle: a selected tag is removed; an archetype replaces the
 * current archetype; a modifier joins when the row allows it; otherwise unchanged. */
export function toggleTag(selected: readonly GameTagId[], tag: GameTagId): GameTagId[] {
  if (selected.includes(tag)) return GAME_TAG_IDS.filter(other => other !== tag && selected.includes(other));
  if (tagProblem(selected, tag)) return [...selected];
  const kept = isArchetypeTag(tag) ? selected.filter(other => !isArchetypeTag(other)) : selected;
  return GAME_TAG_IDS.filter(other => other === tag || kept.includes(other));
}
