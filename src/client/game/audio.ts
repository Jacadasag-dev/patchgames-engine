import { soundMessageSchema, soundRecipeAssetIds } from '../../shared/soundRecipes.ts';
import type { SoundMessage, SoundRecipe } from '../../shared/soundRecipes.ts';
import { createSoundMotionTracker, evaluateSoundBehavior } from '../../shared/soundBehavior.ts';
import type { SoundMotionState } from '../../shared/soundBehavior.ts';
import type { RenderedSound, SoundSamples } from '../../shared/soundRecipeRenderer.ts';
import { SoundRecipeRendering } from './soundRecipeRendering.ts';
import type { SoundRenderer } from './soundRecipeRendering.ts';

type PlayMessage = Extract<SoundMessage, { action: 'play' }>;
type ListenerMessage = Extract<SoundMessage, { action: 'listener' }>;
type MotionTracker = ReturnType<typeof createSoundMotionTracker>;
interface Stem { id: string; source: AudioBufferSourceNode; gain: GainNode; filter?: BiquadFilterNode; bytes: number; ended: boolean }
interface Voice { stems: Stem[]; gain: GainNode; panner?: PannerNode; recipe: SoundRecipe; motion: MotionTracker }
interface PreparedSound { stems: { id: string; sound: RenderedSound }[]; bytes: number }
interface Pending { message: PlayMessage; generation: number; cancelled: boolean; scheduled: boolean; createdAt: number; motion: MotionTracker }
export interface GameAudioOptions {
  resolveSource?: (id: string) => Promise<SoundSamples | undefined> | SoundSamples | undefined;
  createContext?: () => AudioContext;
  createRenderer?: () => SoundRenderer;
  now?: () => number;
}
const EMITTER_LIMIT = 16, STEM_LIMIT = 48, MEMORY_LIMIT = 64 * 1024 * 1024;
const defaultListener: SoundMotionState = { position: [0, 0, 0], velocity: [0, 0, 0], forward: [0, 0, -1] };
const sampleBytes = (sound: RenderedSound) => sound.channels.reduce((total, channel) => total + channel.byteLength, 0);

/** Host-owned audio: bounded validated cues cross the iframe, never URLs or arbitrary nodes. */
export function createGameAudio(options: GameAudioOptions = {}) {
  let context: AudioContext | null = null, disposed = false, epoch = 'default', generation = 0;
  let listener: ListenerMessage | undefined, renderer: SoundRenderer | undefined;
  const listenerMotion = createSoundMotionTracker();
  const active = new Map<string, Voice>(), pending = new Map<string, Pending>(), seen = new Map<string, number>();
  const cache = new Map<string, PreparedSound>(), jobs = new Set<Promise<void>>();
  const preparing = new Map<string, Promise<PreparedSound>>();
  const errors: string[] = [];
  const now = options.now ?? (() => performance.now());
  let windowStart = now(), inWindow = 0, played = 0, duplicates = 0, rejected = 0, blocked = 0, stale = 0;
  let activeStems = 0, activeBytes = 0, cachedBytes = 0, preparingBytes = 0;
  let behaviorTimer: ReturnType<typeof setInterval> | undefined;
  const parameterTargets = new WeakMap<AudioParam, number>();
  const report = (error: unknown) => { errors.push((error instanceof Error ? error.message : String(error)).slice(0, 240)); if (errors.length > 5) errors.shift(); };
  const ready = () => context?.state === 'running';

  function parameter(param: AudioParam, value: number, smooth: boolean, smoothingMs = 80): void {
    const previous = parameterTargets.get(param);
    const interpolate = smooth && context && smoothingMs > 0;
    if (previous !== undefined && Math.abs(previous - value) < 0.000001
      && (interpolate || Math.abs(param.value - value) < 0.000001)) return;
    parameterTargets.set(param, value);
    if (interpolate && context) {
      // Hold the current interpolated value while replacing the old target.
      // No accumulating automation history from the behavior heartbeat.
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(context.currentTime);
      else {
        const current = param.value;
        param.cancelScheduledValues(context.currentTime); param.setValueAtTime(current, context.currentTime);
      }
      param.setTargetAtTime(value, context.currentTime, smoothingMs / 1000);
    } else if (context && previous !== undefined) {
      param.cancelScheduledValues(context.currentTime); param.setValueAtTime(value, context.currentTime);
    } else param.value = value;
  }
  function updateBehavior(voice: Voice, smooth = true): void {
    const behavior = voice.recipe.behavior;
    if (!behavior || !context) return;
    const at = now(), emitter = voice.motion.sample(at);
    if (!emitter) return;
    const result = evaluateSoundBehavior(behavior, voice.recipe.layers, emitter, listenerMotion.sample(at) ?? defaultListener);
    for (const stem of voice.stems) {
      if (stem.ended) continue;
      const layer = result.layers.find(value => value.id === stem.id);
      parameter(stem.gain.gain, layer?.gain ?? 1, smooth, behavior.smoothingMs);
      parameter(stem.source.playbackRate, result.pitchRate, smooth, behavior.smoothingMs);
      if (stem.filter) parameter(stem.filter.frequency, Math.min(layer?.lowpass ?? 24_000, context.sampleRate * 0.49), smooth, behavior.smoothingMs);
    }
  }
  function maintainBehaviorTimer(): void {
    const needed = !disposed && [...active.values()].some(voice => voice.recipe.behavior);
    if (needed && behaviorTimer === undefined) {
      // Parameter-only refresh lets stale velocity settle without rendering PCM again.
      behaviorTimer = setInterval(() => { for (const voice of active.values()) updateBehavior(voice); }, 50);
    } else if (!needed && behaviorTimer !== undefined) {
      clearInterval(behaviorTimer); behaviorTimer = undefined;
    }
  }
  function endStem(id: string, voice: Voice, stem: Stem): void {
    if (stem.ended) return;
    stem.ended = true; activeStems--; activeBytes -= stem.bytes;
    stem.source.onended = null; stem.source.disconnect(); stem.gain.disconnect(); stem.filter?.disconnect();
    if (voice.stems.every(value => value.ended)) {
      if (active.get(id) === voice) active.delete(id);
      voice.gain.disconnect(); voice.panner?.disconnect(); maintainBehaviorTimer();
    }
  }
  function stop(id: string): void {
    const item = pending.get(id);
    if (item) { item.cancelled = true; pending.delete(id); item.motion.reset(); }
    const voice = active.get(id);
    if (!voice) return;
    active.delete(id); voice.motion.reset();
    for (const stem of voice.stems) {
      if (stem.ended) continue;
      stem.source.onended = null;
      try { stem.source.stop(); } catch { /* The source may already have ended. */ }
      endStem(id, voice, stem);
    }
    voice.gain.disconnect(); voice.panner?.disconnect(); maintainBehaviorTimer();
  }
  function reset(nextEpoch: string): void {
    generation++; epoch = nextEpoch;
    for (const id of [...pending.keys(), ...active.keys()]) stop(id);
    seen.clear(); listener = undefined; listenerMotion.reset();
    applyListener({ type: 'audio', action: 'listener', epoch, position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] });
  }
  function applyListener(message: ListenerMessage): void {
    if (!context) return;
    const destination = context.listener;
    const position = message.position, length = Math.hypot(...message.forward), upLength = Math.hypot(...message.up);
    const forward = message.forward.map(value => value / length), up = message.up.map(value => value / upLength);
    const values = [position[0], position[1], position[2], forward[0], forward[1], forward[2], up[0], up[1], up[2]];
    const params = [destination.positionX, destination.positionY, destination.positionZ, destination.forwardX,
      destination.forwardY, destination.forwardZ, destination.upX, destination.upY, destination.upZ];
    if (params.every(Boolean)) params.forEach((param, index) => { param.value = values[index]; });
    else { destination.setPosition(...position); destination.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]); }
  }
  function applyPosition(panner: PannerNode, position: [number, number, number], smoothingMs?: number): void {
    [panner.positionX, panner.positionY, panner.positionZ].forEach((param, index) => parameter(param, position[index], smoothingMs !== undefined, smoothingMs));
  }
  function cachePrepared(key: string, result: PreparedSound): void {
    if (disposed || result.bytes > MEMORY_LIMIT) return;
    while (cache.size >= 8 || cachedBytes + result.bytes > MEMORY_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cachedBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
    }
    cache.set(key, result); cachedBytes += result.bytes;
  }
  function preparationBytes(message: PlayMessage): number {
    const count = message.recipe.behavior ? message.recipe.layers.length : 1;
    return count * Math.ceil(message.recipe.duration * message.recipe.sampleRate) * message.recipe.channels * 4;
  }
  async function prepare(message: PlayMessage): Promise<PreparedSound> {
    const key = JSON.stringify(message.recipe), cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    const current = preparing.get(key);
    if (current) return current;
    const reservation = preparationBytes(message);
    if (preparing.size >= 4 || preparingBytes + reservation > MEMORY_LIMIT) throw new Error('Sound preparation queue or memory budget is full.');
    preparingBytes += reservation;
    const needed = () => !disposed && [...pending.values()].some(item => !item.cancelled && JSON.stringify(item.message.recipe) === key);
    const task = (async () => {
      const sources = new Map<string, SoundSamples>();
      await Promise.all(soundRecipeAssetIds(message.recipe).map(async id => {
        const value = await options.resolveSource?.(id);
        if (!value) throw new Error(`Sound asset ${id} is unavailable.`);
        sources.set(id, value);
      }));
      const result: PreparedSound = { stems: [], bytes: 0 };
      const recipes: { id: string; recipe: SoundRecipe; sources: Map<string, SoundSamples> }[] = [];
      if (message.recipe.behavior) {
        for (const layer of message.recipe.layers) {
          const stem = { ...message.recipe, layers: [{ ...layer }] };
          delete stem.behavior; delete stem.layers[0].response;
          recipes.push({ id: layer.id, recipe: stem, sources: layer.source.kind === 'asset'
            ? new Map([[layer.source.id, sources.get(layer.source.id)!]]) : new Map() });
        }
      } else recipes.push({ id: 'mix', recipe: message.recipe, sources });
      // One outstanding render per preparation keeps four multi-layer recipes
      // within the shared worker's four-job queue.
      for (const stem of recipes) {
        if (!needed()) throw new Error('Sound preparation was cancelled.');
        renderer ??= options.createRenderer?.() ?? new SoundRecipeRendering();
        let sound: RenderedSound;
        try { sound = await renderer.render(stem.recipe, stem.sources); }
        catch (error) { renderer?.dispose(); renderer = undefined; throw error; }
        result.stems.push({ id: stem.id, sound }); result.bytes += sampleBytes(sound);
      }
      if (needed()) cachePrepared(key, result);
      return result;
    })();
    preparing.set(key, task);
    const finish = () => { preparing.delete(key); preparingBytes -= reservation; drainPending(); };
    void task.then(finish, finish);
    return task;
  }
  async function start(item: Pending): Promise<void> {
    try {
      const message = item.message, prepared = await prepare(message);
      if (item.cancelled || disposed || item.generation !== generation || !context || !ready()) return;
      if (!message.loop && now() - item.createdAt > 1000) { stale++; return; }
      if (active.size >= EMITTER_LIMIT || activeStems + prepared.stems.length > STEM_LIMIT || activeBytes + prepared.bytes > MEMORY_LIMIT) {
        rejected++; report('Audio budget reached (16 emitters, 48 stems or 64 MiB).'); return;
      }
      const gain = context.createGain(); gain.gain.value = message.gain;
      let panner: PannerNode | undefined;
      if (message.position || message.recipe.behavior) {
        panner = context.createPanner(); panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
        panner.refDistance = message.recipe.behavior?.refDistance ?? 2;
        panner.maxDistance = message.recipe.behavior?.maxDistance ?? 1000;
        panner.rolloffFactor = message.recipe.behavior?.rolloffFactor ?? 1;
        // Loading may span several scene updates. Start at the latest tracked
        // pose immediately; smoothing applies only to subsequent movement.
        applyPosition(panner, item.motion.sample(now())?.position ?? message.position ?? [0, 0, 0]);
        gain.connect(panner); panner.connect(context.destination);
      } else gain.connect(context.destination);
      const voice: Voice = { stems: [], gain, recipe: message.recipe, motion: item.motion, ...(panner ? { panner } : {}) };
      active.set(message.id, voice);
      const loopEnd = Math.min(...prepared.stems.map(part => part.sound.channels[0].length / part.sound.sampleRate));
      const loopRate = prepared.stems[0].sound.sampleRate;
      const loopStart = message.loop ? Math.floor(Math.min(.05, loopEnd / 4) * loopRate) / loopRate : 0;
      for (const part of prepared.stems) {
        const samples = part.sound;
        const buffer = context.createBuffer(samples.channels.length, samples.channels[0].length, samples.sampleRate);
        // Overlap the tail with the intro once, in the voice-owned copy only.
        // Subsequent passes start after that intro, preserving the join and all
        // stem phases without re-rendering or mutating cached PCM. This reduces
        // waveform discontinuities; it cannot turn every recording into a
        // semantically seamless ambience loop.
        const fadeSamples = Math.round(loopStart * samples.sampleRate), loopEndSample = Math.round(loopEnd * samples.sampleRate);
        for (let c = 0; c < samples.channels.length; c++) {
          const channel = buffer.getChannelData(c); channel.set(samples.channels[c]);
          if (fadeSamples > 1) for (let i = 0; i < fadeSamples; i++) {
            const weight = i / (fadeSamples - 1), tail = loopEndSample - fadeSamples + i;
            channel[tail] = samples.channels[c][tail] * (1 - weight) + samples.channels[c][i] * weight;
          }
        }
        const source = context.createBufferSource(), stemGain = context.createGain();
        source.buffer = buffer; source.loop = message.loop; stemGain.gain.value = 1;
        if (message.loop) { source.loopStart = fadeSamples > 1 ? loopStart : 0; source.loopEnd = loopEnd; }
        const hasFilter = message.recipe.behavior && message.recipe.layers.find(layer => layer.id === part.id)?.response?.lowpass;
        const filter = hasFilter ? context.createBiquadFilter() : undefined;
        const stem: Stem = { id: part.id, source, gain: stemGain, bytes: sampleBytes(samples), ended: false, ...(filter ? { filter } : {}) };
        voice.stems.push(stem); activeStems++; activeBytes += stem.bytes;
        source.connect(stemGain);
        if (filter) { filter.type = 'lowpass'; filter.Q.value = 0; stemGain.connect(filter); filter.connect(gain); }
        else stemGain.connect(gain);
        source.onended = () => endStem(message.id, voice, stem);
      }
      updateBehavior(voice, false);
      const startsAt = context.currentTime;
      for (const stem of voice.stems) stem.source.start(startsAt);
      played++; maintainBehaviorTimer();
    } catch (error) {
      if (!item.cancelled && !disposed && item.generation === generation) { stop(item.message.id); report(error); }
    } finally { if (pending.get(item.message.id) === item) pending.delete(item.message.id); drainPending(); }
  }
  function schedule(item: Pending): void {
    if (item.scheduled || item.cancelled || disposed || !ready()) return;
    const key = JSON.stringify(item.message.recipe), reservation = preparationBytes(item.message);
    if (!cache.has(key) && !preparing.has(key)) {
      if (reservation > MEMORY_LIMIT) {
        item.cancelled = true; pending.delete(item.message.id); rejected++; report('Sound preparation exceeds the 64 MiB memory budget.'); return;
      }
      // Pending emitters already occupy a slot in the 16-emitter budget. Wait
      // for a worker/memory slot instead of silently losing a fifth ambience.
      if (preparing.size >= 4 || preparingBytes + reservation > MEMORY_LIMIT) return;
    }
    item.scheduled = true;
    const job = start(item); jobs.add(job); void job.finally(() => jobs.delete(job));
  }
  function drainPending(): void {
    if (disposed || !ready()) return;
    for (const item of pending.values()) schedule(item);
  }
  function handle(raw: unknown): boolean {
    if (disposed) return false;
    try {
      if (JSON.stringify(raw).length > 24_000) { rejected++; return false; }
    } catch { rejected++; return false; }
    const parsed = soundMessageSchema.safeParse(raw);
    if (!parsed.success) { rejected++; return false; }
    const message = parsed.data;
    if (message.action === 'reset') { reset(message.epoch); return true; }
    if (message.epoch !== epoch) { rejected++; return false; }
    if (message.action === 'listener') {
      listener = message; listenerMotion.update(message, now()); applyListener(message);
      for (const voice of active.values()) updateBehavior(voice);
      return true;
    }
    if (message.action === 'stop') { stop(message.id); return true; }
    if (message.action === 'update') {
      const voice = active.get(message.id), queued = pending.get(message.id);
      if (message.gain !== undefined) {
        if (voice) parameter(voice.gain.gain, message.gain, !!voice.recipe.behavior, voice.recipe.behavior?.smoothingMs);
        if (queued) queued.message.gain = message.gain;
      }
      if (message.position || message.velocity || message.forward || message.teleport) {
        const motion = voice?.motion ?? queued?.motion;
        const previous = motion?.sample(now());
        const position = message.position ?? previous?.position ?? [0, 0, 0];
        const velocity = message.velocity ?? (!message.position ? previous?.velocity : undefined);
        motion?.update({ position, ...(velocity ? { velocity } : {}),
          ...(message.forward ? { forward: message.forward } : {}), ...(message.teleport ? { teleport: true } : {}) }, now());
        if (voice?.panner && message.position) applyPosition(voice.panner, message.position, message.teleport ? 0 : voice.recipe.behavior?.smoothingMs);
        if (queued) {
          if (message.position) queued.message.position = message.position;
          if (message.velocity) queued.message.velocity = message.velocity;
          if (message.forward) queued.message.forward = message.forward;
        }
        if (voice) updateBehavior(voice);
      }
      return true;
    }
    const time = now();
    if (message.recipe.behavior && !message.position) {
      rejected++; report('Listener-relative sound behavior requires an emitter position.'); return false;
    }
    if (seen.has(message.id)) { duplicates++; return true; }
    if (time - windowStart >= 1000) { windowStart = time; inWindow = 0; }
    if (++inWindow > EMITTER_LIMIT || pending.size + active.size >= EMITTER_LIMIT) { rejected++; return false; }
    for (const [id, at] of seen) { if (time - at <= 120_000 && seen.size < 4096) break; seen.delete(id); }
    seen.set(message.id, time);
    const motion = createSoundMotionTracker(); motion.update({ ...message, position: message.position ?? [0, 0, 0] }, time);
    const item: Pending = { message, generation, cancelled: false, scheduled: false, createdAt: time, motion };
    if (!ready()) {
      blocked++;
      if (message.loop) pending.set(message.id, item);
      return true;
    }
    pending.set(message.id, item); schedule(item); return true;
  }
  async function resume(): Promise<boolean> {
    if (disposed) return false;
    try {
      if (!context) context = options.createContext ? options.createContext() : new AudioContext();
      if (context.state === 'suspended') await context.resume();
      if (!ready()) return false;
      if (listener) applyListener(listener);
      drainPending();
      return true;
    } catch (error) { report(error); return false; }
  }
  function dispose(): void {
    if (disposed) return;
    reset(epoch); disposed = true; cache.clear(); cachedBytes = 0; renderer?.dispose(); renderer = undefined;
    maintainBehaviorTimer();
    const previous = context; context = null;
    if (previous && previous.state !== 'closed') void previous.close().catch(report);
  }
  return { handle, resume, dispose, stopScene:()=>reset(epoch),
    info: () => ({ state: disposed ? 'disposed' : ready() ? 'running' : 'locked', epoch, active: active.size, stems: activeStems,
      activeBytes, pending: pending.size, cached: cache.size, cachedBytes, played, duplicates, rejected, blocked, stale, errors: [...errors] }),
    settled: async () => { while (jobs.size) await Promise.all([...jobs]); },
  };
}
