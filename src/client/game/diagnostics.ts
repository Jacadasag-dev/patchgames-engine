/** Opt-in local diagnostics; Vite removes this switch from production builds. */
export const PHYSICS_DEBUG = import.meta.env.DEV && typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('physicsdebug');
