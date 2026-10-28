/// <reference path="../../shared/env.d.ts" />
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameInfo } from '../../shared/shapes.ts';
import { buildLogic, GAME_DIR, listFiles } from './build.ts';
import { LOGIC_ENTRIES, loadQuickJS } from './quickjs.ts';
import { describeGame } from './gameInfo.ts';

// The game's logic as the server loads it (Node).

export { LOGIC_ENTRIES };
export { describeGame, withGameMode, withGameRules } from './gameInfo.ts';

export interface LoadedGame {
  /** The logic bundle: evaluated in a fresh sandbox for every match. */
  source: string;
  /** What the game declared about itself, checked. */
  info: GameInfo;
  /** A custom package keeps its matching renderer with its logic. */
  view?: string;
}

// A production build embeds the logic bundle it was built with (see
// src/sandbox/host/vitePlugin.ts), so a release keeps running its own game
// even though the live checkout moves on.
const EMBEDDED = typeof __GAME_LOGIC__ === 'string' ? __GAME_LOGIC__ : null;

const cache = new Map<string, { signature: string; game: LoadedGame }>();

/**
 * The current game (built from `gameDir`, or the build's embedded bundle).
 * Rebuilt only when a file in the game module changed, so dev servers pick
 * up edits at the next match. Throws BoundaryError, SandboxError or
 * ContractError if the game module is broken.
 */
export function loadGame(root = process.cwd(), gameDir = GAME_DIR): LoadedGame {
  const key = resolve(root, gameDir);
  if (EMBEDDED !== null && gameDir === GAME_DIR) {
    const embedded = cache.get('embedded') ?? { signature: '', game: describeGame(EMBEDDED) };
    cache.set('embedded', embedded);
    return embedded.game;
  }
  const signature = listFiles(key, /\.(ts|json)$/)
    .map((file) => {
      const stat = statSync(file);
      return `${file}:${stat.size}:${stat.mtimeMs}`;
    })
    .join('|');
  const cached = cache.get(key);
  if (cached?.signature === signature) return cached.game;
  const game = describeGame(buildLogic(root, gameDir));
  cache.set(key, { signature, game });
  return game;
}

/** Loads QuickJS; call once before loadGame() or any Sandbox. */
export async function initSandbox(): Promise<void> {
  await loadQuickJS();
}
