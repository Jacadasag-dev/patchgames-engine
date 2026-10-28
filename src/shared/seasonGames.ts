import type { GameModeId } from './gameModes.ts';
import type { GameTagId } from './gameTags.ts';

/** The published game frozen at a season boundary, independent of its creator's later edits. */
export interface SeasonGameSelection {
  /** The shape the elected content runs as (ctx.mode). Older frozen selections without one are Duel selections. */
  mode?: GameModeId;
  /** The tag category this election is for (docs/game-tags.md); older selections are their mode's archetype. */
  category?: GameTagId;
  /** The elected game's tags, which its starter pre-fills; the category's tag alone when nobody qualified. */
  tags?: GameTagId[];
  sourceSeasonId: string;
  targetSeasonId: string;
  cutoffAt: string;
  gameId: string | null;
  revisionId: string | null;
  name: string | null;
  authorId: number | null;
  authorName: string | null;
  sourceTreeHash: string | null;
  packageHash: string | null;
  score: number;
  uniquePlayers: number;
  totalUses: number;
  firstPlayedAt: string | null;
  /** Used when no published game qualifies; frozen so retries cannot change the fallback. */
  fallbackBaseSha: string;
  status: 'pending' | 'promoted';
  promotedSha: string | null;
}
