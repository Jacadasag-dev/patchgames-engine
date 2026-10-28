/**
 * Duration-preserving, stereo-linked pitch shifting for bounded offline sound recipes.
 * Original phase-vocoder implementation: peak-region phase locking keeps neighboring
 * bins together; spectral onsets reset phase to limit transient smearing. This is an
 * effect, not formant-preserving voice conversion; large shifts can introduce artifacts.
 * Algorithm background: https://dafx.de/paper-archive/2008/papers/dafx08_19.pdf
 * and https://www.dafx.de/paper-archive/2003/pdfs/dafx32.pdf
 */
const TAU = Math.PI * 2;

interface FftPlan { size: number; reverse: Uint16Array; cosine: Float64Array; sine: Float64Array; window: Float64Array }
const plans = new Map<number, FftPlan>();

function fftPlan(size: number): FftPlan {
  const cached = plans.get(size);
  if (cached) return cached;
  const reverse = new Uint16Array(size), cosine = new Float64Array(size / 2), sine = new Float64Array(size / 2);
  const window = new Float64Array(size), bits = Math.log2(size);
  for (let i = 0; i < size; i++) {
    let value = i, reversed = 0;
    for (let bit = 0; bit < bits; bit++) { reversed = (reversed << 1) | (value & 1); value >>>= 1; }
    reverse[i] = reversed;
    window[i] = 0.5 - 0.5 * Math.cos(TAU * i / size);
    if (i < size / 2) { cosine[i] = Math.cos(TAU * i / size); sine[i] = Math.sin(TAU * i / size); }
  }
  const plan = { size, reverse, cosine, sine, window }; plans.set(size, plan); return plan;
}

function fft(real: Float64Array, imaginary: Float64Array, plan: FftPlan, inverse: boolean): void {
  const { size, reverse, cosine, sine } = plan;
  for (let i = 0; i < size; i++) {
    const j = reverse[i];
    if (j > i) {
      const r = real[i], m = imaginary[i]; real[i] = real[j]; imaginary[i] = imaginary[j]; real[j] = r; imaginary[j] = m;
    }
  }
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2, stride = size / width;
    for (let start = 0; start < size; start += width) for (let j = 0; j < half; j++) {
      const even = start + j, odd = even + half, twiddle = j * stride;
      const s = inverse ? sine[twiddle] : -sine[twiddle], c = cosine[twiddle];
      const r = real[odd] * c - imaginary[odd] * s, m = real[odd] * s + imaginary[odd] * c;
      real[odd] = real[even] - r; imaginary[odd] = imaginary[even] - m; real[even] += r; imaginary[even] += m;
    }
  }
  if (inverse) for (let i = 0; i < size; i++) { real[i] /= size; imaginary[i] /= size; }
}

function principalPhase(value: number): number { return value - TAU * Math.round(value / TAU); }

/** Returns equally sized new channels. Zero shift deliberately returns the original PCM. */
export function shiftSoundPitch(channels: Float32Array[], sampleRate: number, semitones: number): Float32Array[] {
  if (!Number.isFinite(semitones) || Math.abs(semitones) > 12) throw new Error('Pitch shift must be between -12 and 12 semitones.');
  if (semitones === 0 || !channels[0]?.length) return channels;
  const length = channels[0].length, size = sampleRate >= 40000 ? 2048 : 1024, half = size / 2, hop = size / 4;
  const plan = fftPlan(size), ratio = 2 ** (semitones / 12), bins = half + 1;
  const result = channels.map(() => new Float32Array(length)), weights = new Float64Array(length);
  const real = channels.map(() => new Float64Array(size)), imaginary = channels.map(() => new Float64Array(size));
  const phase = channels.map(() => new Float64Array(bins)), previous = channels.map(() => new Float64Array(bins));
  const magnitude = channels.map(() => new Float64Array(bins));
  const amplitude = new Float64Array(bins), previousAmplitude = new Float64Array(bins);
  const phaseShift = new Float64Array(bins), frequencies = new Float64Array(bins), peaks = new Int32Array(bins);
  let previousEnergy = 0, first = true;
  for (let center = -half + hop; center < length + half; center += hop) {
    let energy = 0, flux = 0;
    for (let c = 0; c < channels.length; c++) {
      imaginary[c].fill(0);
      for (let j = 0; j < size; j++) {
        const position = center + j - half;
        // Circularly centered frames keep the local attack at time zero when bins move.
        real[c][(j + half) % size] = (position >= 0 && position < length ? channels[c][position] : 0) * plan.window[j];
      }
      fft(real[c], imaginary[c], plan, false);
      for (let k = 0; k < bins; k++) {
        magnitude[c][k] = Math.hypot(real[c][k], imaginary[c][k]);
        phase[c][k] = Math.atan2(imaginary[c][k], real[c][k]);
      }
    }
    for (let k = 0; k < bins; k++) {
      const ref = channels.length === 2 && magnitude[1][k] > magnitude[0][k] ? 1 : 0;
      amplitude[k] = magnitude[ref][k];
      energy += amplitude[k]; flux += Math.max(0, amplitude[k] - previousAmplitude[k]);
      const expected = TAU * k * hop / size;
      frequencies[k] = TAU * k / size + principalPhase(phase[ref][k] - previous[ref][k] - expected) / hop;
    }
    const onset = first || (energy > previousEnergy * 1.4 && flux > energy * 0.55);
    for (let k = 0; k < bins; k++) {
      phaseShift[k] = onset ? 0 : principalPhase(phaseShift[k] + (ratio - 1) * frequencies[k] * hop);
      previousAmplitude[k] = amplitude[k];
      for (let c = 0; c < channels.length; c++) previous[c][k] = phase[c][k];
    }
    first = false; previousEnergy = energy;
    let peakCount = 0;
    for (let k = 1; k < half; k++) if (amplitude[k] > amplitude[k - 1] && amplitude[k] >= amplitude[k + 1]) peaks[peakCount++] = k;
    if (peakCount === 0) peaks[peakCount++] = 0;
    for (let c = 0; c < channels.length; c++) { real[c].fill(0); imaginary[c].fill(0); }
    let region = 0;
    for (let k = 1; k < half; k++) {
      while (region + 1 < peakCount && k > (peaks[region] + peaks[region + 1]) / 2) region++;
      const peak = peaks[region];
      const shift = Math.round((ratio - 1) * frequencies[peak] * size / TAU), target = k + shift;
      // Frequencies shifted beyond Nyquist are discarded, never folded back as aliases.
      if (target <= 0 || target >= half) continue;
      for (let c = 0; c < channels.length; c++) {
        const angle = phase[c][k] + phaseShift[peak], m = magnitude[c][k];
        real[c][target] += m * Math.cos(angle); imaginary[c][target] += m * Math.sin(angle);
      }
    }
    for (let c = 0; c < channels.length; c++) {
      // DC is not a pitched component. Maintain it for biased recorded sources.
      real[c][0] = magnitude[c][0] * Math.cos(phase[c][0]);
      for (let k = 1; k < half; k++) { real[c][size - k] = real[c][k]; imaginary[c][size - k] = -imaginary[c][k]; }
      fft(real[c], imaginary[c], plan, true);
      for (let j = 0; j < size; j++) {
        const position = center + j - half;
        if (position < 0 || position >= length) continue;
        const window = plan.window[j]; result[c][position] += real[c][(j + half) % size] * window;
        if (c === 0) weights[position] += window * window;
      }
    }
  }
  for (const channel of result) for (let i = 0; i < length; i++) channel[i] = weights[i] > 1e-9 ? channel[i] / weights[i] : 0;
  return result;
}
