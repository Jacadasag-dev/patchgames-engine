import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { BoundaryError, buildLogic, buildView, GAME_DIR, listFiles } from './build.ts';
import { loadQuickJS } from './quickjs.ts';

// Serves the game module's bundles to the page, built by build.ts. Vite
// itself never processes game code: the page loads the logic bundle into
// its QuickJS sandbox and the view bundle into the sandboxed worker.
//
// - Dev: /@game/logic.js and /@game/view.js, rebuilt when a game
//   file changes (the page reloads).
// - Build: the logic bundle is embedded (__GAME_LOGIC__) in the client
//   and in the server, so a release always runs the game it was built with;
//   the view bundle is emitted as game/view.<hash>.js (__GAME_VIEW_URL__).

export const DEV_LOGIC_URL = '/@game/logic.js';
export const DEV_VIEW_URL = '/@game/view.js';

// Exported under its original name: renaming it would change vite.config.ts,
// which release planning treats as runtime configuration needing a reviewed mapping.
export function duelGame(): Plugin {
  const root = process.cwd();
  let view: { fileName: string; code: string } | null = null;
  const cache = new Map<string, { signature: string; code: string }>();

  const signature = () => listFiles(resolve(root, GAME_DIR), /./)
    .map((file) => `${file}:${statSync(file).mtimeMs}`)
    .join('|');
  const cached = (key: string, build: () => string) => {
    const current = signature();
    const hit = cache.get(key);
    if (hit?.signature === current) return hit.code;
    const code = build();
    cache.set(key, { signature: current, code });
    return code;
  };

  return {
    name: 'game-bundles',

    async config(_config, env) {
      if (env.command !== 'build') return;
      await loadQuickJS();
      const logic = buildLogic(root);
      const viewCode = buildView(root);
      view = { fileName: `game/view.${createHash('sha256').update(viewCode).digest('hex').slice(0, 10)}.js`, code: viewCode };
      return {
        define: {
          __GAME_LOGIC__: JSON.stringify(logic),
          __GAME_VIEW_CODE__: JSON.stringify(viewCode),
          __GAME_VIEW_URL__: JSON.stringify(`/${view.fileName}`),
        },
      };
    },

    generateBundle() {
      if (view && this.environment.name === 'client') {
        this.emitFile({ type: 'asset', fileName: view.fileName, source: view.code });
      }
    },

    async configureServer(server) {
      await loadQuickJS();
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split('?')[0];
        if (url !== DEV_LOGIC_URL && url !== DEV_VIEW_URL) return next();
        try {
          const code = url === DEV_LOGIC_URL ? cached('logic', () => buildLogic(root)) : cached('view', () => buildView(root));
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(code);
        } catch (error) {
          response.statusCode = 500;
          response.end(error instanceof BoundaryError ? error.message : String(error));
        }
      });
      // Game files aren't in Vite's module graph; reload the page when one changes.
      server.watcher.on('change', (file) => {
        if (resolve(file).startsWith(resolve(root, GAME_DIR))) server.ws.send({ type: 'full-reload' });
      });
    },
  };
}
