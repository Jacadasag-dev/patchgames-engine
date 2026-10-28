/** Locked match rules, selected independently of content and mods. Arena keeps the
 * stable `battle-royale` identifier so saved games, mods and replays remain compatible. */
export const GAME_MODE_IDS = ['duel', 'battle-royale', 'rpg', 'just-chatting'] as const;
export type GameModeId = typeof GAME_MODE_IDS[number];

export const MAX_MATCH_PLAYERS = 32;
/** The most teams a game may declare (docs/game-tags.md). */
export const MAX_TEAMS = 16;

export function isGameMode(value: unknown): value is GameModeId {
  return typeof value === 'string' && (GAME_MODE_IDS as readonly string[]).includes(value);
}

export function isSessionMode(mode: GameModeId | undefined): boolean {
  return mode === 'rpg' || mode === 'just-chatting';
}

export function gameModeLabel(mode: GameModeId): string {
  return { duel: 'Duel', 'battle-royale': 'Arena', rpg: 'RPG', 'just-chatting': 'Just Chatting' }[mode];
}

/** Keep the duel allowance; larger rosters need room for each participant's events. */
export function matchEventLimit(playerCount: number): number {
  return Math.max(32, Math.min(MAX_MATCH_PLAYERS, Math.max(2, playerCount)) * 8);
}

const RULES = Object.freeze({
  duel: Object.freeze({ minPlayers: 2, maxPlayers: 2, durationMs: 60_000 }),
  'battle-royale': Object.freeze({ minPlayers: 2, maxPlayers: MAX_MATCH_PLAYERS, durationMs: 300_000 }),
  rpg: Object.freeze({ minPlayers: 1, maxPlayers: 5, durationMs: 0 }),
  'just-chatting': Object.freeze({ minPlayers: 1, maxPlayers: MAX_MATCH_PLAYERS, durationMs: 0 }),
});

/** Older games and saved packages without a mode remain duels. */
export function modeRules(mode: GameModeId = 'duel') {
  return RULES[mode];
}

export function validPlayerCount(mode: GameModeId, count: number): boolean {
  const rules = modeRules(mode);
  return Number.isInteger(count) && count >= rules.minPlayers && count <= rules.maxPlayers;
}
