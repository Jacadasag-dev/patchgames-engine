import { playSound, setSoundEpoch } from '../../sandbox/audio.ts';
import type { SoundRecipeInput } from '../../shared/soundRecipes.ts';
import type { FighterState } from '../shapes.ts';

const impact = (frequency: number, bright: boolean): SoundRecipeInput => ({ kind: 'sound', version: 1, duration: .55,
  layers: [ { id: 'metal-ring', source: { kind: 'tone', frequency, waveform: 'triangle' }, gain: bright ? .24 : .12, fadeOut: .45 },
    { id: 'inharmonic-overtone', source: { kind: 'tone', frequency: frequency * 1.43 }, gain: bright ? .12 : .04, duration: .32, fadeOut: .28 },
    { id: 'transient', source: { kind: 'noise', color: 'white', seed: 17 }, duration: .065, gain: .34, lowpass: bright ? 7000 : 1300, fadeOut: .06 } ],
  effects: { gain: .72, reverb: { decay: .65, wet: .16 } } });
const swish: SoundRecipeInput = { kind: 'sound', version: 1, duration: .27, layers: [{ id: 'blade-air', source: { kind: 'noise', color: 'pink', seed: 44 }, gain: .40, lowpass: 3500, fadeIn: .04, fadeOut: .19 }] };
export const DUEL_SOUNDS: Record<string, SoundRecipeInput> = {
  light: swish, heavy: { ...swish, duration: .40, effects: { gain: 1.25 }, layers: [{ ...swish.layers[0], duration: .4, lowpass: 2400, fadeOut: .29 }] },
  charging: { kind: 'sound', version: 1, duration: .28, layers: [{ id: 'leather-tension', source: { kind: 'noise', color: 'brown', seed: 9 }, gain: .3, lowpass: 1100, fadeIn: .03, fadeOut: .18 }] },
  bash: impact(135, false), block: impact(620, true), parry: impact(1240, true), hiltCounter: impact(480, true), hiltHit: impact(140, false), hit: impact(95, false),
  dodge: { ...swish, layers: [{ ...swish.layers[0], lowpass: 1400, gain: .20 }] },
};

/** Stable replicated sequence IDs prevent render-frame duplication. */
export class DuelAudio {
  private observed = new Map<string, { attack: number; feedback: number }>();
  private previousElapsed = 0;
  private round = 0;
  update(elapsed: number, players: readonly { id: string; state: FighterState }[]): void {
    if (elapsed < this.previousElapsed) { this.round++; this.observed.clear(); }
    this.previousElapsed = elapsed; setSoundEpoch('medieval-duel-' + this.round);
    for (const { id, state: s } of players) {
      const old = this.observed.get(id), position: [number, number, number] = [s.x, s.y + 1.2, s.z];
      if (old && old.attack !== s.combat.attackSeq && DUEL_SOUNDS[s.combat.attackState]) playSound(`${id}:action:${s.combat.attackSeq}`, DUEL_SOUNDS[s.combat.attackState], { position });
      if (old && old.feedback !== s.combat.feedbackSeq && DUEL_SOUNDS[s.combat.actionFeedback]) playSound(`${id}:feedback:${s.combat.feedbackSeq}`, DUEL_SOUNDS[s.combat.actionFeedback], { position });
      this.observed.set(id, { attack: s.combat.attackSeq, feedback: s.combat.feedbackSeq });
    }
  }
}
