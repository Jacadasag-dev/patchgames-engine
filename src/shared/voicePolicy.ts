/** The shared voice system: who may talk to whom, decided by the trusted host from room state, and the
 * voice declaration a game makes once (plus the per-player state it may return each step).
 * Audio never enters game code; games only describe scope, channels and effects (docs/voice-chat.md). */

export const VOICE_SCOPES = ['off', 'everyone', 'team', 'proximity'] as const;
export type VoiceScope = typeof VOICE_SCOPES[number];
export const VOICE_EFFECTS = ['none', 'muffled', 'underwater', 'echo', 'radio'] as const;
export type VoiceEffect = typeof VOICE_EFFECTS[number];
export const VOICE_CHANNEL_LIMIT = 32;

/** What a game declares in logic.voice: the in-game scope and whether voices are placed in 3D space. */
export interface VoiceDeclaration {
  scope: VoiceScope;
  spatial: boolean;
}
/** The declaration as a game writes it: spatial may be left to the scope's default (proximity only). */
export interface VoiceDeclarationInput {
  scope: VoiceScope;
  spatial?: boolean;
}

/** Per-player voice state a game may return from voiceState(ctx), by participant index. */
export interface PlayerVoice {
  /** Only players sharing a channel hear one another; unset players use the scope's default grouping. */
  channel?: string;
  /** How this player's voice sounds to others. */
  effect?: VoiceEffect;
  /** How everything sounds to this player. */
  hearing?: VoiceEffect;
  /** Nobody hears this player while set (a dead, stunned or muted-by-rules player). */
  silent?: boolean;
}

/** The policy in force for a room right now. `lobby` policies cover every connected member; game policies cover active players. */
export interface VoicePolicy {
  scope: VoiceScope;
  spatial: boolean;
  lobby: boolean;
}

export const VOICE_OFF: VoiceDeclaration = { scope: 'off', spatial: false };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isScope = (value: unknown): value is VoiceScope => typeof value === 'string' && (VOICE_SCOPES as readonly string[]).includes(value);
const isEffect = (value: unknown): value is VoiceEffect => typeof value === 'string' && (VOICE_EFFECTS as readonly string[]).includes(value);

/** Validates logic.voice. Omitted means no in-game voice; proximity is spatial unless the game says otherwise. */
export function parseVoiceDeclaration(raw: unknown, fail: (message: string) => never): VoiceDeclaration {
  if (raw === undefined) return VOICE_OFF;
  if (!isRecord(raw) || !isScope(raw.scope)) fail(`voice: expected { scope: ${VOICE_SCOPES.join(' | ')}, spatial? }`);
  if (raw.spatial !== undefined && typeof raw.spatial !== 'boolean') fail('voice.spatial: expected true or false');
  const scope = raw.scope as VoiceScope;
  return { scope, spatial: raw.spatial === undefined ? scope === 'proximity' : raw.spatial as boolean };
}

/** Validates one voiceState(ctx) result: an array (or object keyed by index) of PlayerVoice, one per participant. */
export function parseVoiceStates(raw: unknown, participants: number, fail: (message: string) => never): (PlayerVoice | undefined)[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) && !isRecord(raw)) fail('voiceState: expected an array of { channel?, effect?, hearing?, silent? } by participant index');
  const states: (PlayerVoice | undefined)[] = [];
  for (let index = 0; index < participants; index++) {
    const entry = Array.isArray(raw) ? raw[index] : (raw as Record<string, unknown>)[String(index)];
    if (entry === undefined || entry === null) { states.push(undefined); continue; }
    if (!isRecord(entry)) fail(`voiceState[${index}]: expected { channel?, effect?, hearing?, silent? }`);
    const voice: PlayerVoice = {};
    if (entry.channel !== undefined) {
      if (typeof entry.channel !== 'string' || !entry.channel.length || entry.channel.length > VOICE_CHANNEL_LIMIT) fail(`voiceState[${index}].channel: expected 1–${VOICE_CHANNEL_LIMIT} characters`);
      voice.channel = entry.channel;
    }
    for (const key of ['effect', 'hearing'] as const) {
      if (entry[key] === undefined) continue;
      if (!isEffect(entry[key])) fail(`voiceState[${index}].${key}: expected ${VOICE_EFFECTS.join(', ')}`);
      if (entry[key] !== 'none') voice[key] = entry[key] as VoiceEffect;
    }
    if (entry.silent !== undefined) { if (typeof entry.silent !== 'boolean') fail(`voiceState[${index}].silent: expected true or false`); if (entry.silent) voice.silent = true; }
    states.push(Object.keys(voice).length ? voice : undefined);
  }
  return states;
}

export function readVoiceDeclaration(json: string | undefined | null): VoiceDeclaration {
  if (!json) return VOICE_OFF;
  try { const value = JSON.parse(json) as Record<string, unknown>; return isScope(value.scope) ? { scope: value.scope, spatial: value.spatial === true } : VOICE_OFF; }
  catch { return VOICE_OFF; }
}

export function readPlayerVoice(json: string | undefined | null): PlayerVoice {
  if (!json) return {};
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return { ...(typeof value.channel === 'string' ? { channel: value.channel } : {}), ...(isEffect(value.effect) && value.effect !== 'none' ? { effect: value.effect } : {}),
      ...(isEffect(value.hearing) && value.hearing !== 'none' ? { hearing: value.hearing } : {}), ...(value.silent === true ? { silent: true } : {}) };
  } catch { return {}; }
}

/** The fields of room state the policy depends on; the host and every client derive the same answer. */
export interface VoiceRoomView {
  friendsLobby: boolean;
  discordActivity: boolean;
  phase: string;
  preparing: boolean;
  lobbyCountdown: boolean;
  lobbyVoice: boolean;
  gameVoice: string;
}

/** Lobby voice while a private lobby waits (and through its cancellable countdown and preparation); the game's
 * declaration once play starts. Discord parties keep Discord's own voice; the engine stays silent there. */
export function voicePolicyFor(state: VoiceRoomView): VoicePolicy {
  const playing = !state.preparing && (state.phase === 'fighting' || state.phase === 'knockout' || state.phase === 'countdown' && !state.lobbyCountdown);
  if (playing) { const { scope, spatial } = readVoiceDeclaration(state.gameVoice); return { scope, spatial, lobby: false }; }
  if (state.friendsLobby && !state.discordActivity && ['waiting', 'ended', 'countdown'].includes(state.phase)) {
    return state.lobbyVoice ? { scope: 'everyone', spatial: false, lobby: true } : { scope: 'off', spatial: false, lobby: true };
  }
  return { scope: 'off', spatial: false, lobby: false };
}

export interface VoiceParty { team: number; voice: PlayerVoice }

/** Whether a listener hears a speaker under a policy, before distance and personal mutes. A channel set on either side
 * must match on both; otherwise team scope groups by team and the other scopes let everyone through. */
export function canHear(policy: VoicePolicy, listener: VoiceParty, speaker: VoiceParty): boolean {
  if (policy.scope === 'off' || speaker.voice.silent) return false;
  if (listener.voice.channel !== undefined || speaker.voice.channel !== undefined) return listener.voice.channel === speaker.voice.channel;
  if (policy.scope === 'team') return listener.team >= 0 && listener.team === speaker.team;
  return true;
}

/** A player-facing reason when voice is unavailable under the current policy. */
export function voiceUnavailableReason(policy: VoicePolicy, state: Pick<VoiceRoomView, 'gameVoice' | 'discordActivity'>): string {
  if (policy.scope !== 'off') return '';
  if (policy.lobby) return 'The host turned voice chat off for this lobby.';
  if (readVoiceDeclaration(state.gameVoice).scope !== 'off') return 'Voice is available during gameplay.';
  return state.discordActivity ? 'Discord provides voice for this party.' : 'This game has no voice chat.';
}
