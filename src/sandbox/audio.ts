import { soundMessageSchema } from '../shared/soundRecipes.ts';
import type { SoundMessage, SoundRecipeInput } from '../shared/soundRecipes.ts';

export interface SoundMotionOptions { velocity?: [number, number, number]; teleport?: boolean }
export interface SoundCueOptions extends SoundMotionOptions {
  position?: [number, number, number]; forward?: [number, number, number]; gain?: number; loop?: boolean;
}
let transport: ((message: SoundMessage) => void) | null = null;
let epoch = 'default';
let automaticListener = true, presentationTime: number | undefined;
let listenerPosition: [number, number, number] | undefined;
/** Read the delivered local listener, not an inspection/review camera. */
export function soundPresentationState(): { epoch: string; listener?: [number, number, number] } {
  return { epoch, ...(listenerPosition ? { listener: [...listenerPosition] } : {}) };
}
const presentationNow = () => presentationTime ?? performance.now();
const recentCues = new Set<string>();
const RECENT_CUE_LIMIT = 4096;
const emitterUpdates = new Map<string, { at: number; signature: string }>();
let lastListenerAt = -Infinity, lastListenerSignature = '', updateWindow = 0, updatesInWindow = 0;
function resetPresentationBudget(): void {
  emitterUpdates.clear(); lastListenerAt = -Infinity; lastListenerSignature = '';
  updateWindow = presentationNow(); updatesInWindow = 0;
}

/** Installed by the trusted view runtime, never an authored network or AudioContext capability. */
export function configureSoundTransport(send: ((message: SoundMessage) => void) | null): void {
  transport = send;
  epoch = 'default';
  automaticListener = true; presentationTime = undefined;
  listenerPosition = undefined;
  recentCues.clear();
  resetPresentationBudget();
}

function send(message: unknown): void { transport?.(soundMessageSchema.parse(message)); }

/** Use a stable ID from the authoritative gameplay event, not a random ID every render frame. */
export function playSound(id: string, recipe: SoundRecipeInput, options: SoundCueOptions = {}): void {
  if (!transport || recentCues.has(id)) return;
  const message = soundMessageSchema.parse({ type: 'audio', action: 'play', epoch, id, recipe, ...options });
  transport(message);
  recentCues.add(id);
  emitterUpdates.delete(id);
  if (recentCues.size > RECENT_CUE_LIMIT) recentCues.delete(recentCues.values().next().value!);
}

export function stopSound(id: string): void {
  emitterUpdates.delete(id);
  send({ type: 'audio', action: 'stop', epoch, id });
}

/** Follow a moving sound emitter without restarting the audio. */
export function updateSound(id: string, options: Omit<SoundCueOptions, 'loop'>): void {
  if (!transport) return;
  const message = soundMessageSchema.parse({ type: 'audio', action: 'update', epoch, id, ...options });
  const at = presentationNow(), previous = emitterUpdates.get(id);
  const signature = JSON.stringify(options);
  if (previous && (previous.signature === signature || !options.teleport && at - previous.at < 50)) return;
  if (at - updateWindow >= 1000) { updateWindow = at; updatesInWindow = 0; }
  if (updatesInWindow >= 320) return;
  updatesInWindow++;
  transport(message);
  emitterUpdates.set(id, { at, signature });
  if (emitterUpdates.size > 64) emitterUpdates.delete(emitterUpdates.keys().next().value!);
}

/** New round/replay identity clears old cues and lets that round reuse its event IDs. */
export function setSoundEpoch(value: string): void {
  if (value === epoch) return;
  const message = soundMessageSchema.parse({ type: 'audio', action: 'reset', epoch: value });
  epoch = value;
  listenerPosition = undefined;
  recentCues.clear();
  resetPresentationBudget();
  transport?.(message);
}

/** Supply the actual displayed camera pose for positional audio, including first-person views. */
export function setSoundListener(position: [number, number, number], forward?: [number, number, number], up?: [number, number, number], motion: SoundMotionOptions = {}): void {
  automaticListener = false;
  sendListener(position, forward, up, motion);
}

/** Restore the normal rendered gameplay-camera listener after an explicit custom override. */
export function useAutomaticSoundListener(): void {
  automaticListener = true; lastListenerAt = -Infinity; lastListenerSignature = '';
}

/** Trusted runtime clock: deterministic inspection frames may advance faster than wall time. */
export function setSoundPresentationTime(timeMs?: number): void {
  const next = timeMs !== undefined && Number.isFinite(timeMs) ? timeMs : undefined;
  const reset = (next === undefined) !== (presentationTime === undefined) || next !== undefined && presentationTime !== undefined && next < presentationTime;
  presentationTime = next;
  if (reset) resetPresentationBudget();
}

/** Trusted camera bridge. Explicit authored listeners retain priority until released. */
export function setAutomaticSoundListener(position: [number, number, number], forward: [number, number, number], up: [number, number, number], motion: SoundMotionOptions = {}): void {
  if (automaticListener) sendListener(position, forward, up, motion);
}

function sendListener(position: [number, number, number], forward?: [number, number, number], up?: [number, number, number], motion: SoundMotionOptions = {}): void {
  if (!transport) return;
  const message = soundMessageSchema.parse({ type: 'audio', action: 'listener', epoch, position, ...(forward ? { forward } : {}), ...(up ? { up } : {}), ...motion });
  const at = presentationNow(), signature = JSON.stringify([position, forward, up, motion]);
  if (signature === lastListenerSignature || !motion.teleport && at - lastListenerAt < 50) return;
  lastListenerAt = at; lastListenerSignature = signature;
  listenerPosition = [...position];
  transport(message);
}
