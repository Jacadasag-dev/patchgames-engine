import { z } from 'zod';
import { soundBehaviorSchema, soundLayerResponseSchema } from './soundBehavior.ts';

/** Bounded, serializable recipes: no URLs, scripts, or encoded audio in authored code. */
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), id: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('tone'), frequency: z.number().finite().min(20).max(12_000),
    waveform: z.enum(['sine', 'triangle', 'square', 'sawtooth']).default('sine') }).strict(),
  z.object({ kind: z.literal('noise'), color: z.enum(['white', 'pink', 'brown']).default('white'),
    seed: z.number().int().min(0).max(0xffffffff).default(1) }).strict(),
]);

export const soundRecipeSchema = z.object({
  kind: z.literal('sound'),
  version: z.literal(1),
  duration: z.number().finite().min(0.05).max(12),
  sampleRate: z.union([z.literal(22050), z.literal(24000), z.literal(48000)]).default(24000),
  channels: z.union([z.literal(1), z.literal(2)]).default(1),
  behavior: soundBehaviorSchema.optional(),
  layers: z.array(z.object({
    id: z.string().min(1).max(80),
    source: sourceSchema,
    offset: z.number().finite().min(0).max(12).default(0),
    duration: z.number().finite().min(0.01).max(12).optional(),
    trimStart: z.number().finite().min(0).max(12).default(0),
    trimEnd: z.number().finite().min(0).max(12).optional(),
    playbackRate: z.number().finite().min(0.25).max(4).default(1),
    // Independent pitch; playbackRate retains its existing speed-and-pitch behavior.
    pitchSemitones: z.number().finite().min(-12).max(12).default(0),
    gain: z.number().finite().min(0).max(4).default(1),
    pan: z.number().finite().min(-1).max(1).default(0),
    fadeIn: z.number().finite().min(0).max(4).default(0.005),
    fadeOut: z.number().finite().min(0).max(4).default(0.02),
    lowpass: z.number().finite().min(20).max(24_000).optional(),
    response: soundLayerResponseSchema.optional(),
  }).strict()).min(1).max(12),
  effects: z.object({
    gain: z.number().finite().min(0).max(4).default(1),
    lowpass: z.number().finite().min(20).max(24_000).optional(),
    echo: z.object({ delay: z.number().finite().min(0.01).max(2),
      feedback: z.number().finite().min(0).max(0.9).default(0.3), wet: z.number().finite().min(0).max(1).default(0.25) }).strict().optional(),
    reverb: z.object({ decay: z.number().finite().min(0.05).max(8),
      wet: z.number().finite().min(0).max(1).default(0.2), seed: z.number().int().min(0).max(0xffffffff).default(1) }).strict().optional(),
  }).strict().default({ gain: 1 }),
}).strict().superRefine((recipe, ctx) => {
  const ids = new Set<string>();
  recipe.layers.forEach((layer, index) => {
    if (ids.has(layer.id)) ctx.addIssue({ code: 'custom', path: ['layers', index, 'id'], message: 'Layer IDs must be unique so edits and inspection refer to one layer.' });
    ids.add(layer.id);
    if (layer.offset >= recipe.duration) ctx.addIssue({ code: 'custom', path: ['layers', index, 'offset'], message: 'Layer must start within recipe duration.' });
    if (layer.trimEnd !== undefined && layer.trimEnd <= layer.trimStart) ctx.addIssue({ code: 'custom', path: ['layers', index, 'trimEnd'], message: 'trimEnd must be after trimStart.' });
    if (layer.response && !recipe.behavior) ctx.addIssue({ code: 'custom', path: ['layers', index, 'response'], message: 'Layer responses require recipe.behavior so playback can evaluate listener-relative inputs.' });
  });
});

export type SoundRecipe = z.output<typeof soundRecipeSchema>;
export type SoundRecipeInput = z.input<typeof soundRecipeSchema>;

const positionSchema = z.tuple([z.number().finite().min(-1_000_000).max(1_000_000),
  z.number().finite().min(-1_000_000).max(1_000_000), z.number().finite().min(-1_000_000).max(1_000_000)]);
const directionSchema = positionSchema.refine(vector => Math.hypot(...vector) > 0.00001, 'Direction must be nonzero.');
const epochSchema = z.string().min(1).max(80), cueIdSchema = z.string().min(1).max(160);
export const soundMessageSchema = z.discriminatedUnion('action', [
  z.object({ type: z.literal('audio'), action: z.literal('play'), epoch: epochSchema, id: cueIdSchema,
    recipe: soundRecipeSchema, position: positionSchema.optional(), gain: z.number().finite().min(0).max(2).default(1),
    velocity: positionSchema.optional(), forward: directionSchema.optional(), teleport: z.boolean().optional(),
    loop: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('audio'), action: z.literal('stop'), epoch: epochSchema, id: cueIdSchema }).strict(),
  z.object({ type: z.literal('audio'), action: z.literal('update'), epoch: epochSchema, id: cueIdSchema,
    velocity: positionSchema.optional(), forward: directionSchema.optional(), teleport: z.boolean().optional(),
    position: positionSchema.optional(), gain: z.number().finite().min(0).max(2).optional() }).strict(),
  z.object({ type: z.literal('audio'), action: z.literal('reset'), epoch: epochSchema }).strict(),
  z.object({ type: z.literal('audio'), action: z.literal('listener'), epoch: epochSchema,
    velocity: positionSchema.optional(), teleport: z.boolean().optional(),
    position: positionSchema, forward: directionSchema.default([0, 0, -1]), up: directionSchema.default([0, 1, 0]) }).strict(),
]);
export type SoundMessage = z.output<typeof soundMessageSchema>;

export function soundRecipeAssetIds(recipe: SoundRecipeInput): string[] {
  return [...new Set(soundRecipeSchema.parse(recipe).layers.flatMap(layer => layer.source.kind === 'asset' ? [layer.source.id] : []))];
}

export const SOUND_RECIPE_EXAMPLES: Record<string, SoundRecipeInput> = {
  'forest-ambience': {
    kind: 'sound', version: 1, duration: 8,
    layers: [
      { id: 'garden-birds', source: { kind: 'asset', id: 'sound.birds-garden' }, gain: .24, lowpass: 6500, fadeIn: .1, fadeOut: .1 },
      { id: 'canopy-air', source: { kind: 'noise', color: 'pink', seed: 411 }, gain: .11, lowpass: 2400, fadeIn: .1, fadeOut: .1 },
    ],
  },
  'meadow-ambience': {
    kind: 'sound', version: 1, duration: 8,
    layers: [
      { id: 'open-air', source: { kind: 'noise', color: 'pink', seed: 701 }, gain: .045, lowpass: 4200, fadeIn: .1, fadeOut: .1 },
      { id: 'distant-birds', source: { kind: 'asset', id: 'sound.birds-garden' }, gain: .12, lowpass: 8000, fadeIn: .1, fadeOut: .1 },
    ],
  },
  'tree-rustle': {
    kind: 'sound', version: 1, duration: 8,
    layers: [
      { id: 'designed-foliage', source: { kind: 'noise', color: 'pink', seed: 144 }, gain: .24, lowpass: 5000, fadeIn: .1, fadeOut: .1 },
      { id: 'wood-flex-ingredient', source: { kind: 'asset', id: 'sound.wood-plank-creak' }, gain: .065, lowpass: 2600, offset: 2.5, fadeIn: .1, fadeOut: .15 },
    ],
  },
  'bush-rustle': {
    kind: 'sound', version: 1, duration: 8,
    layers: [{ id: 'designed-small-leaves', source: { kind: 'noise', color: 'pink', seed: 775 }, gain: .2, lowpass: 7200, fadeIn: .1, fadeOut: .1 }],
  },
  'cannonball-flyby': {
    kind: 'sound', version: 1, duration: 2,
    behavior: { refDistance: 8, maxDistance: 160, rolloffFactor: 0.7, approachSpeed: 35, smoothingMs: 80,
      doppler: { strength: 0.8, maxSemitones: 5 } },
    layers: [
      { id: 'approaching-whistle', source: { kind: 'tone', frequency: 1100 }, gain: 0.035, fadeIn: 0.03, fadeOut: 0.04,
        response: { input: 'approach', gain: [[-1, 0], [0, 0.5], [1, 1]] } },
      { id: 'passing-air', source: { kind: 'noise', color: 'pink', seed: 81 }, gain: 0.28, lowpass: 4200, fadeIn: 0.03, fadeOut: 0.04,
        response: { input: 'approach', gain: [[-1, 0.25], [0, 1], [1, 0.25]] } },
      { id: 'departing-rumble', source: { kind: 'noise', color: 'brown', seed: 29 }, gain: 0.18, lowpass: 1600, fadeIn: 0.03, fadeOut: 0.04,
        response: { input: 'approach', gain: [[-1, 1], [0, 0.5], [1, 0.05]] } },
    ],
  },
  // Separate action cues follow actual game events. The combined example below
  // is only an audition timeline; cancelling a draw must never play a release.
  'bow-draw': {
    kind: 'sound', version: 1, duration: 1.2,
    layers: [
      { id: 'wood-flex', source: { kind: 'asset', id: 'sound.wood-plank-creak' }, gain: 0.4, lowpass: 4200, duration: 1.1, fadeIn: 0.04, fadeOut: 0.15 },
      { id: 'hand-and-grip', source: { kind: 'asset', id: 'sound.cloth' }, offset: 0.05, gain: 0.2, lowpass: 3200 },
    ],
  },
  'bow-release': {
    kind: 'sound', version: 1, duration: 0.6,
    layers: [
      { id: 'string-release', source: { kind: 'asset', id: 'sound.bow-string-release' }, gain: 0.8 },
      { id: 'limb-movement', source: { kind: 'asset', id: 'sound.cloth' }, playbackRate: 1.5, gain: 0.12, duration: 0.18 },
    ],
  },
  'arrow-flight': {
    kind: 'sound', version: 1, duration: 1.2,
    layers: [
      { id: 'air-pass', source: { kind: 'asset', id: 'sound.arrow-whistle' }, duration: 0.75, pitchSemitones: -7, gain: 0.25, fadeIn: 0.08, fadeOut: 0.18 },
      { id: 'air-texture', source: { kind: 'asset', id: 'sound.arrow-flight' }, duration: 0.75, pitchSemitones: 2, gain: 0.28, lowpass: 4200, fadeIn: 0.08, fadeOut: 0.18 },
    ],
  },
  'arrow-impact': {
    kind: 'sound', version: 1, duration: 0.7,
    layers: [
      { id: 'wood-hit', source: { kind: 'asset', id: 'sound.impact-wood' }, playbackRate: 1.25, gain: 0.55 },
      { id: 'shaft-rattle', source: { kind: 'asset', id: 'sound.bow-string-release' }, offset: 0.02, playbackRate: 0.65, gain: 0.13, lowpass: 1400 },
    ],
  },
  'bow-shot-preview': {
    kind: 'sound', version: 1, duration: 3,
    layers: [
      { id: 'draw-wood-flex', source: { kind: 'asset', id: 'sound.wood-plank-creak' }, gain: 0.4, lowpass: 4200, duration: 0.9, fadeIn: 0.04, fadeOut: 0.12 },
      { id: 'draw-grip', source: { kind: 'asset', id: 'sound.cloth' }, offset: 0.05, gain: 0.2 },
      { id: 'release-string', source: { kind: 'asset', id: 'sound.bow-string-release' }, offset: 1, gain: 0.8 },
      { id: 'flight-air', source: { kind: 'asset', id: 'sound.arrow-whistle' }, offset: 1.05, duration: 0.75, pitchSemitones: -7, gain: 0.25, fadeIn: 0.08, fadeOut: 0.18 },
      { id: 'flight-breath', source: { kind: 'asset', id: 'sound.arrow-flight' }, offset: 1.05, duration: 0.75, pitchSemitones: 2, gain: 0.28, lowpass: 4200, fadeIn: 0.08, fadeOut: 0.18 },
      { id: 'impact-wood', source: { kind: 'asset', id: 'sound.impact-wood' }, offset: 1.8, playbackRate: 1.25, gain: 0.55 },
    ],
  },
  // Retained so creators can compare the new sources and independent pitch with
  // the original audition, or keep its character when it suits their game.
  'bow-shot-original': {
    kind: 'sound', version: 1, duration: 3,
    layers: [
      { id: 'draw-wood-flex', source: { kind: 'asset', id: 'sound.rpg-creak-1' }, playbackRate: 0.75, gain: 0.45, lowpass: 2400, duration: 0.9, fadeOut: 0.12 },
      { id: 'draw-grip', source: { kind: 'asset', id: 'sound.cloth' }, offset: 0.05, gain: 0.2 },
      { id: 'release-string', source: { kind: 'asset', id: 'sound.bow-string-release' }, offset: 1, gain: 0.8 },
      { id: 'flight-air', source: { kind: 'asset', id: 'sound.arrow-flight' }, offset: 1.05, duration: 0.75, gain: 0.55, fadeOut: 0.15 },
      { id: 'impact-wood', source: { kind: 'asset', id: 'sound.impact-wood' }, offset: 1.8, playbackRate: 1.25, gain: 0.55 },
    ],
  },
  'underwater-door': {
    kind: 'sound', version: 1, duration: 3,
    layers: [
      { id: 'door', source: { kind: 'asset', id: 'sound.door-open' }, playbackRate: 0.75, gain: 0.65, lowpass: 900 },
      { id: 'water', source: { kind: 'asset', id: 'sound.water-splash' }, offset: 0.15, gain: 0.4 },
      { id: 'bubbles', source: { kind: 'asset', id: 'sound.water-bubbles' }, offset: 0.4, gain: 0.25 },
    ],
    effects: { gain: 0.8, lowpass: 2200, reverb: { decay: 1.3, wet: 0.22 } },
  },
  'wood-flex': {
    kind: 'sound', version: 1, duration: 1.8,
    layers: [{ id: 'plank-flex', source: { kind: 'asset', id: 'sound.wood-plank-creak' }, gain: 0.65 }],
  },
  'stick-crunch': {
    kind: 'sound', version: 1, duration: 0.8,
    layers: [{ id: 'twig-snap', source: { kind: 'asset', id: 'sound.stick-crunch' }, gain: 0.7 }],
  },
  'campfire': {
    kind: 'sound', version: 1, duration: 2.8,
    layers: [
      { id: 'nearby-crackle', source: { kind: 'asset', id: 'sound.campfire-crackle' }, gain: 0.6, fadeIn: 0.15, fadeOut: 0.2 },
      { id: 'warm-fire-bed', source: { kind: 'asset', id: 'sound.fire-chimney-roar' }, gain: 0.16, lowpass: 2600, fadeIn: 0.15, fadeOut: 0.2 },
    ],
  },
  'torch-fire': {
    kind: 'sound', version: 1, duration: 5.8,
    layers: [{ id: 'small-flame', source: { kind: 'asset', id: 'sound.torch-fire' }, gain: 0.45, fadeIn: 0.1, fadeOut: 0.2 }],
  },
  'house-fire': {
    kind: 'sound', version: 1, duration: 6,
    layers: [
      { id: 'large-blaze', source: { kind: 'asset', id: 'sound.house-fire-roar' }, gain: 0.55, fadeIn: 0.2, fadeOut: 0.3 },
      { id: 'burning-timber', source: { kind: 'asset', id: 'sound.fire-chimney-roar' }, gain: 0.22, fadeIn: 0.2, fadeOut: 0.3 },
      { id: 'wood-groan', source: { kind: 'asset', id: 'sound.wood-plank-creak' }, offset: 2.2, gain: 0.2, pitchSemitones: -4, lowpass: 1800 },
    ],
  },
  'soft-confirm': {
    kind: 'sound', version: 1, duration: 0.3,
    layers: [
      { id: 'first-tone', source: { kind: 'tone', frequency: 660 }, duration: 0.15, gain: 0.2, fadeOut: 0.1 },
      { id: 'second-tone', source: { kind: 'tone', frequency: 880 }, offset: 0.1, duration: 0.2, gain: 0.2, fadeOut: 0.15 },
    ],
  },
};
