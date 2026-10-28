import type { SeasonGameSelection } from './seasonGames.ts';

/** 'knockout': a KO or timeout decided the result; the game runs for KNOCKOUT_MS before the result screen/lobby. */
export type Phase = 'waiting' | 'countdown' | 'fighting' | 'knockout' | 'ended';

export const FEEDBACK_CATEGORIES = ['bug', 'balance', 'idea', 'other'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const ROOM_NAME = 'duel';

export interface JoinOptions {
  /** Host-selected match rules, independent of the selected game and mods. */
  mode?: import('./gameModes.ts').GameModeId;
  /** The game's tags (docs/game-tags.md). Omitted: the hosted game's recorded tags, else the content's default shape. */
  tags?: import('./gameTags.ts').GameTagId[];
  /** Legacy alias: modifier flags added to the mode's archetype tag. */
  flags?: string[];
  /** The seats a lobby opens with (1–32, never below the tags' minimum); omitted: the tags' default. */
  seats?: number;
  name?: string;
  /** Private practice against a server-controlled bot; never rated. */
  vsBot?: boolean;
  /** Private practice with an idle opponent; never rated. */
  training?: boolean;
  queueProof?: string;
  /** The client's build; the server rejects clients from a different build. */
  buildSha?: string;
  /** Requested room code when creating a room (used to move a match to a new version). */
  code?: string;
  /** Set by the matchmaking queue for the rated room it opens (clients can't make a room rated). */
  matchId?: string;
  /** Shared private match opened from the Discord Activity. */
  discordActivity?: boolean;
  /** Code-based friends lobby: two ready fighters and a shared audience. */
  friendsLobby?: boolean;
  /** Immutable published custom-game revision; omitted for the shared game. */
  customRevisionId?: string;
  /** Internal one-use capability minted by the authenticated preview endpoint. */
  previewTicket?: string;
  /** Opaque server-issued capabilities for an entire lobby changing its compiled rules. */
  lobbyTransfer?: string;
  lobbySeat?: string;
  /** Host-issued invitation to an available arena seat in a controlled lobby. */
  arenaInvite?: string;
}

/** The matchmaking queue room. */
export const QUEUE_ROOM = 'queue';

/** Sent every second to each searcher. */
export interface QueueStatus {
  /** How long they've been searching, by the server's clock. */
  waitedMs: number;
  /** How far from their rating an opponent may be right now. */
  range: number;
  rating: number;
}

/** A match was found: join it with this seat. */
export interface QueueMatched {
  reservation: { name: string; sessionId: string; roomId: string; publicAddress?: string; processId?: string; reconnectionToken?: string; devMode?: boolean };
  opponent: string;
}

/** Sent to both players when their finished match moves to a newer server version. */
export interface MigrateMessage {
  mode?: import('./gameModes.ts').GameModeId;
  tags?: import('./gameTags.ts').GameTagId[];
  code: string;
  hostSessionId: string;
  vsBot?: boolean;
  training?: boolean;
  customRevisionId?: string;
}

// No I or O, so codes can't be confused with 1 or 0 when read aloud.
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 8;

export interface ClientLogEntry {
  level: 'error' | 'warning';
  message: string;
  at: string;
}

/** Diagnostic context attached to every feedback report. */
export interface FeedbackContext {
  userAgent: string;
  viewport: { width: number; height: number };
  phase: string;
  roomCode: string | null;
  /** The room state during (or at the end of) the player's last match, if any. */
  roomSnapshot: Record<string, unknown> | null;
  clientLogs: ClientLogEntry[];
}

export interface FeedbackSubmission {
  category: FeedbackCategory;
  message: string;
  buildSha: string;
  context: FeedbackContext;
}

/** The requesting player, as /api/player and the leaderboard report them. */
export interface PlayerView {
  id: number;
  canChangeName: boolean;
  nameSeason: string;
  name: string;
  /** Rounded for display. */
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  ratedMatches: number;
  /** Place on the leaderboard, or null until enough rated matches. */
  rank: number | null;
  /** Rated matches still needed to appear on the leaderboard. */
  matchesToRank: number;
}

/** Display choices saved with the account, so they follow the player across devices. */
export interface PlayerPreferences {
  /** Draw the game behind the main menu; off shows a plain background. */
  menuScene: boolean;
}

export interface LeaderboardEntryView {
  rank: number;
  name: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  isYou: boolean;
}

export interface LeaderboardView {
  entries: LeaderboardEntryView[];
  you: PlayerView | null;
  season: SeasonView;
  /** How the season before this one ended, if there was one. */
  lastSeason: { number: number; standings: SeasonStanding[] } | null;
}

// --- Change tracking: a player's request on its way through the pipeline.

/** Where a request is. Balance tweaks go received > reviewing > tuning > published > live; code changes go through queued > building > checking instead of tuning. */
export const CHANGE_STAGES = ['received', 'reviewing', 'tuning', 'queued', 'building', 'checking', 'published', 'live'] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];
/** How a request can end without going live. */
export const CHANGE_ENDINGS = ['no_change', 'duplicate', 'failed', 'reverted'] as const;
export type ChangeEnding = (typeof CHANGE_ENDINGS)[number];
export type ChangeKind = 'tune' | 'code';
/** Before the pipeline: waiting for the player to pay, or closed without payment. */
export type PaymentStage = 'awaiting_payment' | 'not_paid';

/** What a request costs right now (every PRICE_STEP_EVERY paid requests in a season, it advances a tier). */
export interface ChangePrice {
  amountCents: number;
  currency: string;
  /** Paid requests left at this price before the next tier. Legacy wire name. */
  untilDoubling: number;
}

/** The payment behind a request, as its sender sees it. */
export interface PaymentView {
  amountCents: number;
  currency: string;
  status: 'awaiting' | 'paid' | 'not_paid';
  /** Stripe's checkout page, while it can still be paid. */
  checkoutUrl: string | null;
  /** This request uses the in-page Stripe form instead of a hosted URL. */
  embedded?: boolean;
  /** Why a request wasn't sent: not paid in time or cancelled, the price went up meanwhile, or the payment failed. */
  reason: 'not_paid' | 'price_changed' | 'failed' | 'unavailable' | null;
}

/** One change a request turned into ("health 1000 and attack 30" is two). */
export interface ChangeItemStatus {
  id: number;
  /** What this change does, in a line. */
  title: string;
  kind: ChangeKind | null;
  stage: ChangeStage | ChangeEnding;
  history: { stage: ChangeStage | ChangeEnding; at: number }[];
  /** What was changed, or why nothing was. */
  summary: string | null;
  queueAhead: number | null;
  elapsedMs: number;
  remainingMs: number | null;
  path: { stage: ChangeStage; typicalMs: number }[];
}

export interface ChangeStatus {
  patch?: { mode: 'ai' | 'own_ai' | 'mod'; state: 'unpaid' | 'waiting_ai' | 'queued' | 'retry' | 'approved' | 'finished'; reason: string; scopeCancelled?: boolean; retriesRemaining: number } | null;
  id: number;
  /** The latest stage, or how it ended. */
  stage: ChangeStage | ChangeEnding | PaymentStage;
  /** Every stage reached so far, with when (ms since epoch). */
  history: { stage: ChangeStage | ChangeEnding; at: number }[];
  /** Known once the request has been reviewed. */
  kind: ChangeKind | null;
  /** What was changed, or why nothing was. */
  summary: string | null;
  /** Code changes waiting ahead of this one. */
  queueAhead: number | null;
  elapsedMs: number;
  /** Time left, estimated from how long recent changes took; null once it has ended. */
  remainingMs: number | null;
  /** How many finished changes the estimate is based on (0 = a rough default). */
  estimateSamples: number;
  /** The stages this kind of change goes through, with how long each typically takes (ms). */
  path: { stage: ChangeStage; typicalMs: number }[];
  /** Whether the builders (the feedback pipeline) are running right now. */
  pipelineOnline: boolean;
  /**
   * The separate changes the request turned into, once reviewed. With one,
   * the fields above describe it; with several, they sum them up (the stage
   * of the one furthest behind, the longest time left).
   */
  items: ChangeItemStatus[];
  /** Null when requests are free. */
  payment: PaymentView | null;
}

export interface ChangeSummary {
  pipelineOnline: boolean;
  /** Median time from request to live for recent changes, by kind and overall (null without history). */
  typicalMs: { tune: number | null; code: number | null; all: number | null };
  samples: number;
  /** Mean time from request to live over those recent changes (null without history). */
  averageMs: number | null;
  liveToday: number;
  liveTotal: number;
  /** What a request costs now, or null when requests are free. */
  price: ChangePrice | null;
}

// --- Seasons and patch notes

export interface SeasonView {
  number: number;
  /** "2026-10" */
  id: string;
  startedAt: string;
  /** Midnight on the 1st: where the season's calendar starts (the first season may have begun later). */
  calendarStart: string;
  /** When rankings reset and the next main game is selected. */
  endsAt: string;
}

// --- Champions and the hall of fame

/** A historical patch nomination from the retired champion selection system. */
export interface Nomination {
  entryId: number;
  title: string;
  kind: PatchNoteKind;
  up: number;
  down: number;
}

/** A historical patch choice; retained for read-only season records. */
export interface PermanentPick extends Nomination {
  /** pending: being added to the base game; kept: it's in; failed: it couldn't be added. */
  result: 'pending' | 'kept' | 'failed';
  detail: string | null;
  /** While the builder adds it by hand: its task. */
  taskId?: number | null;
}

export interface HallOfFameRow {
  number: number;
  id: string;
  /** The season's #1, or null when nobody qualified. */
  champion: { name: string; rating: number } | null;
  /** Historical patch-selection status. New champions have no patch selection. */
  status: 'picking' | 'building' | 'done' | 'none';
  pickDeadline: string | null;
  pickedBy: 'champion' | 'auto' | null;
  picks: PermanentPick[];
  youAreChampion: boolean;
  /** Retired; new responses return null. */
  nominations: Nomination[] | null;
  /** Independently selected published game for the following season; absent in legacy responses. */
  selectedGame?: SeasonGameSelection | null;
  /** Every mode's independent next-season base; selectedGame remains the legacy Duel entry. */
  selectedGames?: SeasonGameSelection[];
  /** The charity the season's vote chose, and what it gets. */
  charity: { name: string; amountCents: number } | null;
  /** The viewer won a prize this season that they haven't been paid yet. */
  youHavePrize: boolean;
}

export interface HallOfFameView {
  /** The season being played: its standings so far (its champion is decided when it ends). */
  current: {
    number: number;
    id: string;
    endsAt: string;
    standings: SeasonStanding[];
    /** The prize pool so far (null while prizes are off). */
    poolCents: number | null;
  };
  /** Every finished season, newest first. */
  seasons: HallOfFameRow[];
}

export interface HallOfFameSeason {
  row: HallOfFameRow;
  /** The season's final top 100. */
  standings: SeasonStanding[];
  /** Where its prize pool went (null when there were no prizes). */
  prizes: PrizeAward[] | null;
  /** The viewer's own prize, with what they need to claim it. */
  yourPrize: YourPrize | null;
}

// --- Charities and prizes

export interface CharityView {
  id: string;
  name: string;
  url: string;
  about: string;
  details?: string;
  votes: number;
}

/** A season's prize pool and how it splits (all in cents). */
export interface PrizePool {
  cents: number;
  charityCents: number;
  /** For places 1 to 5. */
  placeCents: number[];
}

export interface CharitiesView {
  /** Off until the owner turns prizes on. */
  enabled: boolean;
  season: SeasonView;
  pool: PrizePool;
  charities: CharityView[];
  /** The charity winning the vote (null before any votes: then the first in the list gets it). */
  leadingId: string | null;
  yourVote: string | null;
  /** Why the viewer can't vote, or null if they can. */
  cantVote: string | null;
}

export interface PrizeAward {
  /** 0 for the charity, 1 to 5 for players. */
  place: number;
  name: string;
  amountCents: number;
  status: 'owed' | 'paid' | 'forfeited';
}

export interface YourPrize {
  seasonId: string;
  number: number;
  place: number;
  amountCents: number;
  status: 'owed' | 'paid' | 'forfeited';
  claimCode: string;
  claimBy: string;
  /** Who to send the claim code to (the owner's address), if set. */
  contact: string | null;
}

export interface SeasonStanding {
  rank: number;
  name: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

export type PatchNoteKind = 'balance' | 'feature' | 'fix' | 'undo' | 'season' | 'permanent';

export interface PatchNote {
  id: number;
  at: string;
  kind: PatchNoteKind;
  title: string;
  /** For balance changes: which numbers changed. */
  tuning: { key: string; from: number; to: number }[];
  /** The players whose requests this answered (names they chose). */
  requestedBy: string[];
  /** Rolled back afterwards. */
  undone: boolean;
  /** The vote to undo it: this season's balance changes, features and fixes only. */
  vote: RevertVote | null;
  /** Community feedback on a patch; null when it cannot be voted on. */
  rating: ChangeRating | null;
}

export interface ChangeRating {
  up: number;
  down: number;
  /** The viewer's own vote. */
  yours: -1 | 0 | 1;
  /** Why the viewer can't vote, or null if they can. */
  cantVote: string | null;
}

/**
 * Players vote to undo a change. It's undone once votes from players online
 * right now reach REVERT_SHARE of the players online (at least REVERT_MIN_VOTES).
 */
export interface RevertVote {
  source?: 'vote' | 'draw_safety';
  /** Votes from players online right now. */
  votes: number;
  needed: number;
  /** Players online right now who've played a match this season (the ones who can vote). */
  online: number;
  youVoted: boolean;
  /** Why the viewer can't vote, or null if they can. */
  cantVote: string | null;
  /** open: collecting votes; undoing: the vote passed and it's being undone; undone; failed: it couldn't be undone. */
  status: 'open' | 'undoing' | 'undone' | 'failed';
  /** For undone and failed: what happened. */
  detail: string | null;
}

export interface PatchNotesView {
  season: SeasonView;
  seasons: { number: number; id: string; notes: PatchNote[] }[];
}
