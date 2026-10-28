import { parseGameInfo } from '../../shared/shapes.ts';
import { gameModeLabel, type GameModeId } from '../../shared/gameModes.ts';
import { normalizeTags, shapeOf, tagsFromLegacy, type GameTagId } from '../../shared/gameTags.ts';
import { LOGIC_ENTRIES, Sandbox } from './quickjs.ts';
import type { LoadedGame } from './game.ts';

const DESCRIBE_MS = 250;

/** Evaluate only inside QuickJS; this module has no filesystem/build side effects. */
export function describeGame(source: string): LoadedGame {
  const sandbox = new Sandbox(source, LOGIC_ENTRIES);
  try {
    return { source, info: parseGameInfo(sandbox.call('describe', null, DESCRIBE_MS).value) };
  } finally { sandbox.dispose(); }
}

/** Select the tags a loaded game runs under without rebuilding, changing content or mutating
 * the cached package (docs/game-tags.md). Content supports legacy shapes, never tags: the
 * tags' shape must be among its supportedModes. An invalid set throws GameTagError. */
export function withGameRules(game: LoadedGame, tags: readonly GameTagId[]): LoadedGame {
  const selected = normalizeTags(tags), mode = shapeOf(selected);
  if (!(game.info.supportedModes ?? [game.info.mode]).includes(mode))
    throw new Error(`This game needs a shared-player foundation upgrade before it supports ${gameModeLabel(mode)}.`);
  return { ...game, info: { ...game.info, mode, tags: selected } };
}

/** A legacy shape selection: the content runs as `mode` with the rules of its archetype tag
 * alone (rulesOf reads the shape), without recording tags on the described info. */
export function withGameMode(game: LoadedGame, mode: GameModeId): LoadedGame {
  const { info } = withGameRules(game, tagsFromLegacy(mode));
  const { tags: _tags, ...described } = info;
  return { ...game, info: described };
}
