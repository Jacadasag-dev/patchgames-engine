/// <reference types="vite/client" />

declare const __BUILD_SHA__: string;
/** Production builds only: the game's logic bundle and the URL of its view bundle (src/sandbox/host/vitePlugin.ts). */
declare const __GAME_LOGIC__: string | undefined;
declare const __GAME_VIEW_URL__: string | undefined;
declare const __GAME_VIEW_CODE__: string | undefined;

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
}
