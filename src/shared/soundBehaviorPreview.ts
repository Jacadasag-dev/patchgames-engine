import { soundAuditionSchema, type SoundAudition, type SoundAuditionInput } from './soundAudition.ts';
export type { SoundAudition, SoundAuditionInput } from './soundAudition.ts';
import { soundRecipeSchema, type SoundRecipeInput } from './soundRecipes.ts';
import { evaluateSoundBehavior, soundBehaviorSchema, type SoundVector3 } from './soundBehavior.ts';
import { measureSound, renderSoundRecipe, type RenderedSound, type SoundRenderOptions } from './soundRecipeRenderer.ts';

export interface SoundAuditionSample {
  time: number; position: SoundVector3; distance: number; radialSpeed: number; approach: number;
  sourceFacing: number; listenerFacing: number; speed: number;
  pitchSemitones: number; pan: number; distanceGain: number;
  layers: { id: string; gain: number; lowpass?: number }[];
}
export interface SoundAuditionReport {
  config: SoundAudition; sampleRate: 24000; listener: { position: SoundVector3; forward: SoundVector3; up: SoundVector3 };
  samples: SoundAuditionSample[]; scope: string;
}
export interface RenderedSoundPreview extends RenderedSound { audition?: SoundAuditionReport }

const normalize = (vector: SoundVector3): SoundVector3 => {
  const length = Math.hypot(...vector) || 1; return vector.map(value => value / length) as SoundVector3;
};
const dot = (a: SoundVector3, b: SoundVector3) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const subtract = (a: SoundVector3, b: SoundVector3): SoundVector3 => a.map((value, index) => value - b[index]) as SoundVector3;
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Fixed world-space paths; changing listener perspective does not rewrite the source trajectory. */
export function soundAuditionPose(input: SoundAuditionInput, time: number) {
  const config = soundAuditionSchema.parse(input), travel = config.speed * config.duration, distance = config.closestDistance;
  let position: SoundVector3, velocity: SoundVector3;
  if (config.trajectory === 'orbit') {
    const angle = time * config.speed / distance;
    position = [Math.sin(angle) * distance, 0, Math.cos(angle) * distance];
    velocity = [Math.cos(angle) * config.speed, 0, -Math.sin(angle) * config.speed];
  } else {
    const start = config.trajectory === 'approach' ? -travel : config.trajectory === 'recede' ? 0 : -travel / 2;
    position = [start + config.speed * time, 0, 0]; velocity = [config.speed, 0, 0];
  }
  const listener = config.listener ?? (config.perspective === 'ahead'
    ? { position: [travel / 2 + distance, 0, 0] as SoundVector3, forward: [-1, 0, 0] as SoundVector3, up: [0, 1, 0] as SoundVector3 }
    : config.perspective === 'behind'
      ? { position: [-travel / 2 - distance, 0, 0] as SoundVector3, forward: [1, 0, 0] as SoundVector3, up: [0, 1, 0] as SoundVector3 }
      : { position: [0, 0, config.trajectory === 'orbit' ? 0 : distance] as SoundVector3, forward: [0, 0, -1] as SoundVector3, up: [0, 1, 0] as SoundVector3 });
  return { emitter: { position, velocity, forward: normalize(velocity) }, listener };
}

/** Ordinary recipes are unchanged. Behavior recipes get a default listener-relative flyby. */
export function renderSoundPreview(input: SoundRecipeInput, options: SoundRenderOptions = {}, audition?: SoundAuditionInput): RenderedSoundPreview {
  const recipe = soundRecipeSchema.parse(input);
  if (!recipe.behavior && !audition) return renderSoundRecipe(recipe, options);
  const config = soundAuditionSchema.parse(audition ?? {}), behavior = soundBehaviorSchema.parse(recipe.behavior ?? {});
  const sampleRate = 24_000 as const, count = Math.ceil(config.duration * sampleRate), channels = [new Float32Array(count), new Float32Array(count)];
  const stems = recipe.layers.map(layer => {
    const { response: _response, ...plain } = layer;
    const { behavior: _behavior, ...base } = recipe;
    const sound = renderSoundRecipe({ ...base, sampleRate, channels: 1, layers: [plain] }, options);
    return { id: layer.id, sound, phase: 0, filtered: 0, gain: 1, lowpass: sampleRate * 0.49 };
  });
  const block = 240, samples: SoundAuditionSample[] = [], smooth = behavior.smoothingMs === 0 ? 1 : 1 - Math.exp(-1 / (sampleRate * behavior.smoothingMs / 1000));
  let pitchRate = 1, distanceGain = 1, pan = 0;
  const evaluate = (time: number) => {
    const pose = soundAuditionPose(config, time), values = evaluateSoundBehavior(behavior, recipe.layers, pose.emitter, pose.listener);
    const forward = normalize(pose.listener.forward), up = normalize(pose.listener.up);
    const right = normalize([forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2], forward[0] * up[1] - forward[1] * up[0]]);
    const targetPan = Math.max(-1, Math.min(1, dot(normalize(subtract(pose.emitter.position, pose.listener.position)), right)));
    return { pose, values, targetPan, targetDistanceGain: values.distanceGain };
  };
  let target = evaluate(0);
  // Include endpoints and the exact midpoint/closest pass; fixed-stride sampling
  // can miss a fast flyby's most useful instant and overstate minimum distance.
  for (let index = 0; index <= 12; index++) {
    const time = config.duration * index / 12, frame = evaluate(time);
    samples.push({ time: Math.round(time * 1_000_000) / 1_000_000, position: frame.pose.emitter.position.map(round) as SoundVector3,
      distance: round(frame.values.distance), radialSpeed: round(frame.values.radialSpeed), approach: round(frame.values.approach),
      sourceFacing: round(frame.values.sourceFacing), listenerFacing: round(frame.values.listenerFacing), speed: round(frame.values.speed),
      pitchSemitones: round(frame.values.pitchSemitones), pan: round(frame.targetPan), distanceGain: round(frame.targetDistanceGain),
      layers: frame.values.layers.map(layer => ({ id: layer.id, gain: round(layer.gain), ...(layer.lowpass === undefined ? {} : { lowpass: round(layer.lowpass) }) })) });
  }
  pitchRate = target.values.pitchRate; distanceGain = target.targetDistanceGain; pan = target.targetPan;
  for (let index = 0; index < stems.length; index++) {
    stems[index].gain = target.values.layers[index].gain; stems[index].lowpass = target.values.layers[index].lowpass ?? sampleRate * 0.49;
  }
  for (let i = 0; i < count; i++) {
    if (i % block === 0) target = evaluate(i / sampleRate);
    pitchRate += smooth * (target.values.pitchRate - pitchRate); distanceGain += smooth * (target.targetDistanceGain - distanceGain); pan += smooth * (target.targetPan - pan);
    let mixed = 0;
    for (let index = 0; index < stems.length; index++) {
      const stem = stems[index], source = stem.sound.channels[0], response = target.values.layers[index];
      stem.gain += smooth * (response.gain - stem.gain); stem.lowpass += smooth * ((response.lowpass ?? sampleRate * 0.49) - stem.lowpass);
      const phase = config.loop ? stem.phase % source.length : stem.phase, left = Math.floor(phase), fraction = phase - left;
      const next = config.loop ? (left + 1) % source.length : left + 1;
      const value = (source[left] ?? 0) * (1 - fraction) + (source[next] ?? 0) * fraction;
      stem.filtered += (1 - Math.exp(-2 * Math.PI * Math.min(stem.lowpass, sampleRate * 0.49) / sampleRate)) * (value - stem.filtered);
      mixed += stem.filtered * stem.gain; stem.phase += pitchRate;
    }
    // An equal-power stereo approximation. Runtime uses the browser's spatial panner.
    const boundaryFade = Math.min(1, i / (sampleRate * 0.01), (count - 1 - i) / (sampleRate * 0.02));
    mixed *= distanceGain * boundaryFade;
    channels[0][i] = mixed * Math.cos((pan + 1) * Math.PI / 4); channels[1][i] = mixed * Math.sin((pan + 1) * Math.PI / 4);
  }
  return { sampleRate, channels, metrics: measureSound({ sampleRate, channels }), layers: stems.flatMap(stem => stem.sound.layers),
    audition: { config, sampleRate, listener: soundAuditionPose(config, 0).listener, samples,
      scope: 'Synthetic listener-relative trajectory preview using shared behavior curves and Doppler math. Stereo panning, inverse-distance attenuation and one-pole filtering approximate playback; not full HRTF, occlusion, propagation delay or a gameplay recording. Samples show target responses; audio uses configured smoothing. Loop repeats each rendered recipe stem.' } };
}
