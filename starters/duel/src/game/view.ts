import type { CreateView } from '../shared/gameApi.ts';
import type { FighterState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { DuelView } from './view/duelView.ts';

/**
 * The game's 3D view. It runs in a Web Worker inside a sandboxed iframe and
 * draws to its own canvas (three.js works there as usual); the page sends it
 * a frame to draw every animation frame.
 */
const createView: CreateView<WorldState, FighterState, GameTuning> = (canvas) => new DuelView(canvas);

export default createView;
