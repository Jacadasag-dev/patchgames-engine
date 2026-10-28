import { parseSceneRules, type GameSceneChoice, type GameSceneRules } from '../shared/gameScenes.ts';

export type GameScenePreset = 'selection' | 'meeting' | 'boss-reveal';
export const gameScenePresets: readonly { id: GameScenePreset; label: string; description: string }[] = [
  { id: 'selection', label: 'Pregame selection', description: 'Choose a character and ready together before gameplay begins.' },
  { id: 'meeting', label: 'Interrupting meeting', description: 'Pause gameplay for a meeting, then resume the interrupted scene.' },
  { id: 'boss-reveal', label: 'Cinematic reveal', description: 'Show a timed, collectively skippable reveal and return to gameplay.' },
];
export interface GameScenePresetOptions {
  stateField?: string;
  durationMs?: number;
  minimumMs?: number;
  choices?: readonly GameSceneChoice[];
  uniqueChoices?: 'none' | 'team' | 'all';
}
/** Editable declarations, not game rules or renderers. Include sceneStateShape
 * in world[stateField], implement legal triggers, and provide scene visuals. */
export function createScenePreset(preset: GameScenePreset, options: GameScenePresetOptions = {}): GameSceneRules {
  if (!gameScenePresets.some(item => item.id === preset)) throw new Error(`scenes: unknown preset ${String(preset)}`);
  const stateField = options.stateField ?? 'scene';
  const durationMs = options.durationMs ?? (preset === 'selection' ? 60000 : preset === 'meeting' ? 45000 : 5000);
  const definition = preset === 'selection'
    ? { id: 'selection', kind: 'selection' as const, label: 'Choose your character', next: 'play', durationMs,
      minimumMs: options.minimumMs ?? 0, uniqueChoices: options.uniqueChoices ?? 'none',
      choices: options.choices ?? [{ id: 'guardian', label: 'Guardian', description: 'Protect the party.' },
        { id: 'ranger', label: 'Ranger', description: 'Scout and strike at range.' }, { id: 'arcanist', label: 'Arcanist', description: 'Control the battlefield.' }] }
    : { id: preset, kind: preset === 'meeting' ? 'meeting' as const : 'cinematic' as const,
      label: preset === 'meeting' ? 'Emergency meeting' : 'The way opens', next: '$return', durationMs,
      minimumMs: options.minimumMs ?? (preset === 'meeting' ? 3000 : 500), skippable: true };
  return parseSceneRules({ stateField, initial: preset === 'selection' ? 'selection' : 'play', definitions: [
    { id: 'play', kind: 'gameplay', transitions: preset === 'selection' ? [] : [preset] }, definition,
  ] })!;
}
