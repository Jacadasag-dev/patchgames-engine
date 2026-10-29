import values from './tuning.json' with { type: 'json' };

/** The game's gameplay numbers (src/game/tuning.json). The core applies changes at each match start. */
export type GameTuning = typeof values;
