import type { GameModeId } from './gameModes.ts';
import type { GameStarterId, GameTagId } from './gameTags.ts';
/** Published game packages are immutable and independent of platform releases. */
export const GAME_PACKAGE_VERSION = 1;
/** A logic bundle holds at most 2 MiB of code, plus up to 6 MiB of world plans
 * the trusted build compiled ahead of time (see precompileWorldPlans). */
export const GAME_LOGIC_CODE_MAX_BYTES = 2 * 1024 * 1024;
export const GAME_WORLD_PLAN_MAX_BYTES = 6 * 1024 * 1024;
export const GAME_LOGIC_MAX_BYTES = GAME_LOGIC_CODE_MAX_BYTES + GAME_WORLD_PLAN_MAX_BYTES;
export type SourceTree = Record<string, string>;
export type SourceOverlay = Record<string, string | null>;
export interface BaseGameVersion { id: string; name?:string; createdAt: string; current: boolean; recommended: boolean; season?: string; seasonNumber?: number; /** The content's shape. */ mode?: GameModeId; /** The starter category a season registered this base for. */ category?: GameTagId; blank?: boolean; /** An engine version: the canvas a release registered (docs/game-tags.md). */ engine?: boolean; /** The release that registered an engine version. */ buildSha?: string }
/** How players see an engine version: the day it was registered and the release that built it. */
export function engineBaseName(createdAt: string, buildSha?: string | null): string {
  const day = createdAt.slice(0, 10);
  return 'Engine ' + day + (buildSha && buildSha !== 'dev' ? ' · ' + buildSha.slice(0, 7) : '');
}
/** A starter a new game or a lobby begins from (docs/game-tags.md): one per tag plus the blank canvas. */
export interface GameStarter {
  id: GameStarterId; label: string;
  /** The tags the starter pre-fills: its elected game's, or its one tag. */
  tags: GameTagId[];
  /** The registered content; absent while the category has no stock content and no season has elected a game. */
  baseId?: string;
  /** The elected game's name when a season elected one; stock content has none. */
  gameName?: string;
  season?: string; seasonNumber?: number;
  /** Every season's starter of this category, newest first, for the frozen-season choice. */
  seasons: { season: string; seasonNumber?: number; baseId: string; gameName?: string; tags: GameTagId[] }[];
}
/** What a new Game starts from: an empty canvas for its mode, or a season's elected base game. */
export const GAME_START_BASES = ['blank', 'season'] as const;
export type GameStartBase = typeof GAME_START_BASES[number];
/** `season` names one frozen season (YYYY-MM); omitted with base 'season', the mode's current base is used. */
export interface GameStart { base?: GameStartBase; /** The seeded content to begin from; `base` is its legacy alias (season: the tags' archetype starter). */ starter?: GameStarterId; season?: string }
export const SEASON_ID_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export interface PublicGame { thumbnailUrl?:string; favorite?:boolean; usedBy?:number; id:string; name:string; revisionId:string; author:string; authorId?:number; season:string|null; seasonNumber?:number; mode?:GameModeId; tags?:GameTagId[]; plays?:number; recentPlayers?:number }
/** "View controls" for a published revision: the controls it declared, grouped by platform. */
export interface PublishedControls { revisionId: string; name: string; mode: GameModeId; controls: import('./controlSheet.ts').ControlSheet }
/** Games and mods players have made and not deleted, drafts included. */
export interface CreationCounts { games: number; mods: number }
/** Community browsing by recorded play: every game, games with plays (most first), or recent players (most first). */
export const GAME_ACTIVITY_FILTERS = ['any', 'most-played', 'trending'] as const;
export type GameActivityFilter = typeof GAME_ACTIVITY_FILTERS[number];
/** Trending and the recent analytics window count this many days. */
export const TRENDING_DAYS = 7;
/** Daily plays shown for a published game, oldest day first. */
export const ANALYTICS_DAYS = 14;
/** Plays are distinct verified matches or sessions; players are distinct accounts. */
export interface GameAnalytics {
  gameId: string; mode: GameModeId; plays: number; players: number; recentPlays: number; recentPlayers: number;
  monthPlays: number; uses: number; favorites: number; firstPlayedAt: string | null; lastPlayedAt: string | null;
  daily: { day: string; plays: number }[];
}
export interface BaseChangePreview { conflicts: string[]; changedFiles: number }
export interface CustomGameView {
  mode?: GameModeId;
  /** The game's tags (docs/game-tags.md); empty means free play. `mode` is the shape they select. */
  tags?: GameTagId[];
  mod?:{id:string;version:number;supportedModes?:GameModeId[]};
  thumbnailUrl?:string;
  usedBy?:number;
  favorite?:boolean;
  id: string;
  name: string;
  baseId: string;
  draftId: string;
  publishedId: string | null;
  archivedAt?: string | null;
  createdAt: string;
}
export interface CustomRevisionView {
  id: string;
  summary: string;
  createdAt: string;
  playable: boolean;
}
export interface CustomJobView {
  id: string;
  revisionId?: string;
  kind: 'patch' | 'build';
  status: 'queued' | 'running' | 'complete' | 'failed';
  message: string;
  prompt?: string;
  createdAt?: string;
}
export interface CustomCommitView {
  id: string;
  summary: string;
  createdAt: string;
  status: CustomJobView['status'] | 'workspace';
  type?: 'human' | 'ai';
  fileCount?: number;
  revisionCount?: number;
  closed?: boolean;
}
export interface ChangeSessionView {
  id:string; type:'human'|'ai'|null; name:string; createdAt:string; updatedAt:string;
  closed:boolean; fileCount:number; revisionCount:number; changes:CustomChangeView[];
}
export interface GameVersion { id: string; revisionId: string; name: string; createdAt: string; published: boolean; playable: boolean }
export interface CustomChangeView {
  revisionId: string;
  commitId: string;
  path: string;
  kind: 'edit' | 'patch' | 'restore' | 'undo';
  createdAt: string;
  operation: 'added' | 'deleted' | 'modified';
}
export interface CustomHistoryView {
  commits: CustomCommitView[];
  changes: CustomChangeView[];
  nextOffset: number | null;
  versions: GameVersion[];
}
