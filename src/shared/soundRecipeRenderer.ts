import { soundRecipeSchema } from './soundRecipes.ts';
import type { SoundRecipeInput } from './soundRecipes.ts';
import { shiftSoundPitch } from './soundPitch.ts';

export interface SoundSamples { sampleRate: number; channels: Float32Array[] }
export interface SoundMeasurements { peak: number; rms: number; clippedSamples: number; sampleCount: number; duration: number }
export interface SoundLayerMeasurements extends SoundMeasurements { id: string; start: number; end: number; sourceId?: string }
export interface RenderedSound extends SoundSamples { metrics: SoundMeasurements; layers: SoundLayerMeasurements[] }
export interface SoundRenderOptions { resolveSource?: (id: string) => SoundSamples | undefined }

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

function validateSamples(samples: SoundSamples): void {
  if (!Number.isInteger(samples.sampleRate) || samples.sampleRate < 8000 || samples.sampleRate > 48000
    || samples.channels.length < 1 || samples.channels.length > 2 || samples.channels[0].length < 1
    || samples.channels[0].length > samples.sampleRate * 12
    || samples.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== samples.channels[0].length)) {
    throw new Error('Sound sources must contain 1–2 equal PCM channels, 8–48 kHz, at most 12 seconds.');
  }
  for (const channel of samples.channels) for (const value of channel) if (!Number.isFinite(value)) throw new Error('Sound source contains non-finite samples.');
}

export function measureSound(samples: SoundSamples): SoundMeasurements {
  let peak = 0, sumSquares = 0, clippedSamples = 0, sampleCount = 0;
  for (const channel of samples.channels) for (const value of channel) {
    const magnitude = Math.abs(value);
    peak = Math.max(peak, magnitude); sumSquares += value * value;
    if (magnitude > 1) clippedSamples++;
    sampleCount++;
  }
  return { peak, rms: sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0, clippedSamples, sampleCount,
    duration: samples.channels[0].length / samples.sampleRate };
}

function lowpass(samples: Float32Array, frequency: number, sampleRate: number): void {
  const alpha = 1 - Math.exp(-2 * Math.PI * Math.min(frequency, sampleRate * 0.49) / sampleRate);
  let previous = 0;
  for (let i = 0; i < samples.length; i++) { previous += alpha * (samples[i] - previous); samples[i] = previous; }
}

/** The same deterministic CPU mix is used for host previews and game playback. */
export function renderSoundRecipe(input: SoundRecipeInput, options: SoundRenderOptions = {}): RenderedSound {
  const recipe = soundRecipeSchema.parse(input), sampleRate = recipe.sampleRate;
  const count = Math.ceil(recipe.duration * sampleRate);
  const channels = Array.from({ length: recipe.channels }, () => new Float32Array(count));
  const layers: SoundLayerMeasurements[] = [];
  const sourceCache = new Map<string, SoundSamples>();
  for (const layer of recipe.layers) {
    let source: SoundSamples | undefined;
    if (layer.source.kind === 'asset') {
      source = sourceCache.get(layer.source.id);
      if (!source) {
        source = options.resolveSource?.(layer.source.id);
        if (!source) throw new Error(`Sound asset ${layer.source.id} is unavailable.`);
        validateSamples(source); sourceCache.set(layer.source.id, source);
      }
    }
    const sourceDuration = source ? source.channels[0].length / source.sampleRate : 12;
    const sourceEnd = Math.min(sourceDuration, layer.trimEnd ?? sourceDuration);
    const available = Math.max(0, (sourceEnd - layer.trimStart) / layer.playbackRate);
    const duration = Math.min(layer.duration ?? available, available, recipe.duration - layer.offset);
    const start = Math.round(layer.offset * sampleRate), layerCount = Math.max(0, Math.min(count - start, Math.ceil(duration * sampleRate)));
    let mixed: Float32Array[] = Array.from({ length: recipe.channels }, () => new Float32Array(layerCount));
    const nextRandom = random(layer.source.kind === 'noise' ? layer.source.seed : 1);
    let brown = 0, pink = 0;
    for (let i = 0; i < layerCount; i++) {
      const time = i / sampleRate, sourceTime = layer.trimStart + time * layer.playbackRate;
      let generated = 0;
      if (layer.source.kind === 'tone') {
        const phase = (sourceTime * layer.source.frequency) % 1;
        switch (layer.source.waveform) {
          case 'sine': generated = Math.sin(phase * Math.PI * 2); break;
          case 'triangle': generated = 1 - 4 * Math.abs(phase - 0.5); break;
          case 'square': generated = phase < 0.5 ? 1 : -1; break;
          case 'sawtooth': generated = phase * 2 - 1; break;
        }
      } else if (layer.source.kind === 'noise') {
        const white = nextRandom() * 2 - 1;
        brown = (brown + white * 0.02) / 1.02;
        pink = pink * 0.94 + white * 0.06;
        generated = layer.source.color === 'brown' ? brown * 3.5 : layer.source.color === 'pink' ? pink * 3 : white;
      }
      const fade = Math.min(1, layer.fadeIn > 0 ? time / layer.fadeIn : 1,
        layer.fadeOut > 0 ? Math.max(0, (duration - time - 1 / sampleRate) / layer.fadeOut) : 1);
      for (let c = 0; c < channels.length; c++) {
        let value = generated;
        if (source) {
          const position = sourceTime * source.sampleRate, left = Math.floor(position), blend = position - left;
          const read = (channel: Float32Array) => (channel[left] ?? 0) * (1 - blend) + (channel[left + 1] ?? 0) * blend;
          value = channels.length === 1 && source.channels.length === 2
            ? (read(source.channels[0]) + read(source.channels[1])) / 2 : read(source.channels[c % source.channels.length]);
        }
        // Balance attenuates the opposite channel; center does not unexpectedly boost a mix.
        const pan = channels.length === 1 ? 1 : c === 0 ? Math.min(1, 1 - layer.pan) : Math.min(1, 1 + layer.pan);
        mixed[c][i] = layer.pitchSemitones === 0 ? value * layer.gain * fade * pan : value;
      }
    }
    if (layer.pitchSemitones !== 0) {
      mixed = shiftSoundPitch(mixed, sampleRate, layer.pitchSemitones);
      // Envelopes and stereo balance are applied after the shift so authored cue
      // timing stays exact and the transform cannot smear audio outside a fade.
      for (let c = 0; c < channels.length; c++) for (let i = 0; i < layerCount; i++) {
        const time = i / sampleRate;
        const fade = Math.min(1, layer.fadeIn > 0 ? time / layer.fadeIn : 1,
          layer.fadeOut > 0 ? Math.max(0, (duration - time - 1 / sampleRate) / layer.fadeOut) : 1);
        const pan = channels.length === 1 ? 1 : c === 0 ? Math.min(1, 1 - layer.pan) : Math.min(1, 1 + layer.pan);
        mixed[c][i] *= layer.gain * fade * pan;
      }
    }
    if (layer.lowpass) for (const channel of mixed) lowpass(channel, layer.lowpass, sampleRate);
    const metrics = measureSound({ sampleRate, channels: mixed });
    layers.push({ id: layer.id, ...metrics, start: start / sampleRate, end: (start + layerCount) / sampleRate,
      ...(layer.source.kind === 'asset' ? { sourceId: layer.source.id } : {}) });
    for (let c = 0; c < channels.length; c++) for (let i = 0; i < layerCount; i++) channels[c][start + i] += mixed[c][i];
  }
  for (const channel of channels) {
    if (recipe.effects.echo) {
      const { delay, feedback, wet } = recipe.effects.echo, offset = Math.max(1, Math.round(delay * sampleRate));
      const echo = new Float32Array(channel.length);
      for (let i = offset; i < channel.length; i++) { echo[i] = channel[i - offset] + echo[i - offset] * feedback; }
      for (let i = 0; i < channel.length; i++) channel[i] += echo[i] * wet;
    }
    if (recipe.effects.reverb) {
      const { decay, wet, seed } = recipe.effects.reverb, dry = channel.slice(), rand = random(seed);
      // Bounded diffuse taps: intentionally an editable inexpensive ambience effect, not room simulation.
      for (let tap = 0; tap < 12; tap++) {
        const fraction = (tap + 0.5 + rand() * 0.5) / 12;
        const offset = Math.max(1, Math.round((0.007 + decay * fraction) * sampleRate));
        const gain = wet * Math.exp(-fraction * 4) * 0.5;
        for (let i = offset; i < channel.length; i++) channel[i] += dry[i - offset] * gain;
      }
    }
    if (recipe.effects.lowpass) lowpass(channel, recipe.effects.lowpass, sampleRate);
    for (let i = 0; i < channel.length; i++) channel[i] *= recipe.effects.gain;
  }
  return { sampleRate, channels, metrics: measureSound({ sampleRate, channels }), layers };
}

/** PCM16 WAV. Measurements retain pre-encoding peaks; encoding clips to the format's range. */
export function encodeSoundWav(samples: SoundSamples): Uint8Array {
  validateSamples(samples);
  const channelCount = samples.channels.length, frames = samples.channels[0].length;
  const bytes = new Uint8Array(44 + frames * channelCount * 2), view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channelCount, true);
  view.setUint32(24, samples.sampleRate, true); view.setUint32(28, samples.sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * channelCount * 2, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channelCount; c++) {
    const value = Math.max(-1, Math.min(1, samples.channels[c][i]));
    view.setInt16(44 + (i * channelCount + c) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

/** Strict decoder for the curated library's bounded PCM16 little-endian WAV files. */
export function decodeSoundWav(bytes: Uint8Array): SoundSamples {
  if (bytes.length < 44 || bytes.length > 2_400_000) throw new Error('WAV exceeds supported source size or is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || view.getUint32(4, true) + 8 > bytes.length) throw new Error('Expected RIFF WAVE.');
  let sampleRate = 0, channelCount = 0, bits = 0, format = 0, data: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + length > bytes.length) throw new Error('Truncated WAV chunk.');
    const kind = text(offset, 4);
    if (kind === 'fmt ') {
      if (length < 16) throw new Error('Invalid WAV format chunk.');
      format = view.getUint16(start, true); channelCount = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true); bits = view.getUint16(start + 14, true);
    } else if (kind === 'data') data = bytes.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (format !== 1 || bits !== 16 || ![1, 2].includes(channelCount) || sampleRate < 8000 || sampleRate > 48000 || !data?.length
    || data.length % (channelCount * 2) !== 0 || data.length / (channelCount * 2) > sampleRate * 12) throw new Error('Expected 1–2 channel PCM16 WAV, 8–48 kHz, at most 12 seconds.');
  const frames = data.length / (channelCount * 2), pcm = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channelCount; c++) {
    const value = pcm.getInt16((i * channelCount + c) * 2, true); channels[c][i] = value / (value < 0 ? 32768 : 32767);
  }
  return { sampleRate, channels };
}
