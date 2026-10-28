import type { TerrainRecipe, TerrainInstance, TerrainAsset } from './terrain.ts';
import { sampleTerrainEnvironment, sampleTerrainAssetEnvironment } from './terrainEnvironment.ts';
import type { EnvironmentSound } from './terrainEnvironment.ts';
import { SOUND_RECIPE_EXAMPLES, soundRecipeSchema } from '../shared/soundRecipes.ts';
import type { SoundRecipe } from '../shared/soundRecipes.ts';
import { playSound, updateSound, stopSound, soundPresentationState } from './audio.ts';

export interface EnvironmentListener { x: number; y?: number; z: number }
export interface TerrainEnvironmentHost {
  read(): { recipe: TerrainRecipe; instances: readonly TerrainInstance[]; revision: string; heights?: ReadonlyMap<string, number> };
  stepWind(timeSeconds: number, listener?: EnvironmentListener, budget?: number): number;
  windDistance(listener: EnvironmentListener): number;
}
type Plant = { item: TerrainInstance; asset: TerrainAsset; height: number };
type HostState = { id: number; host: TerrainEnvironmentHost; revision?: string; cells: Map<string, Plant[]>;
  radius: number; indexed: number; omitted: number; enabled: boolean };
type Target = { key: string; owner: number; recipe: SoundRecipe; signature: string; gain: number;
  position?: [number, number, number]; score: number; kind: 'ambience' | 'plant'; size?: number; wind?: number };
type Voice = Target & { cue: string; currentGain: number };
const hosts = new Map<TerrainEnvironmentHost, HostState>(), voices = new Map<string, Voice>();
const recipes = new Map<string, SoundRecipe | null>(), errors = new Set<string>();
const WIND_BUDGET = 512, VOICE_BUDGET = 8, TARGET_BUDGET = 5, CELL = 16, INDEX_BUDGET = 32768;
let serial = 0, occurrence = 0, epoch = '', previousTime: number | undefined, scanAt = -Infinity;
let desired: Target[] = [], listener: EnvironmentListener | undefined, animated = 0, scanned = 0, omittedCandidates = 0;
let observations: Record<string, unknown>[] = [];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number) => Math.round(value * 1000) / 1000;
const key = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
function problem(message: string): void { if (errors.size < 8) errors.add(message.slice(0, 220)); }
function resolveSound(sound: EnvironmentSound): { recipe: SoundRecipe; signature: string } | undefined {
  const input = typeof sound.recipe === 'string' ? SOUND_RECIPE_EXAMPLES[sound.recipe.replace(/^recipe\./, '')] : sound.recipe;
  const signature = typeof sound.recipe === 'string' ? sound.recipe : JSON.stringify(sound.recipe);
  if (!recipes.has(signature)) {
    const result = soundRecipeSchema.safeParse(input);
    if (recipes.size >= 64) recipes.delete(recipes.keys().next().value!);
    recipes.set(signature, result.success ? result.data : null);
  }
  const recipe = recipes.get(signature);
  if (!recipe) problem(`Environment sound ${typeof sound.recipe === 'string' ? sound.recipe : 'inline recipe'} is unavailable or invalid; inspect the sound recipe.`);
  return recipe ? { recipe, signature } : undefined;
}
function index(state: HostState, source: ReturnType<TerrainEnvironmentHost['read']>): void {
  if (state.revision === source.revision) return;
  state.revision = source.revision; state.cells.clear(); state.indexed = 0; state.omitted = 0; state.radius = 0;
  const assets = new Map(source.recipe.assets.map(asset => [asset.id, asset]));
  state.enabled = !!source.recipe.environment || source.recipe.regions.some(region => region.environment)
    || source.recipe.assets.some(asset => asset.environment);
  for (const item of source.instances) {
    const asset = assets.get(item.asset);
    if (!asset?.environment?.sound) continue;
    if (state.indexed >= INDEX_BUDGET) { state.omitted++; continue; }
    const height = (source.heights?.get(asset.id) ?? (typeof asset.appearance?.height === 'number' ? asset.appearance.height : asset.environment.wind?.referenceHeight ?? 4)) * item.scale;
    const plant = { item, asset, height }, cell = key(item.position.x, item.position.z);
    const bucket = state.cells.get(cell); if (bucket) bucket.push(plant); else state.cells.set(cell, [plant]);
    state.radius = Math.max(state.radius, Math.min(128, asset.environment.sound.radius ?? 28)); state.indexed++;
  }
  scanAt = -Infinity;
}

/** Terrain views register themselves. No per-tree audio/animation code is needed in an authored game. */
export function registerTerrainEnvironment(host: TerrainEnvironmentHost): () => void {
  if (hosts.has(host)) return () => {};
  if (hosts.size >= 64) { problem('Environment view budget reached (64).'); return () => {}; }
  const state: HostState = { id: ++serial, host, cells: new Map(), radius: 0, indexed: 0, omitted: 0, enabled: false };
  hosts.set(host, state); scanAt = -Infinity;
  return () => {
    hosts.delete(host); desired = desired.filter(target => target.owner !== state.id); scanAt = -Infinity;
    for (const [id, voice] of voices) if (voice.owner === state.id) { stopSound(voice.cue); voices.delete(id); }
  };
}

/** Shared view-frame clock. Visual motion is presentation only; collisions and gameplay stay authoritative. */
export function beginEnvironmentFrame(timeMs: number): void {
  if (!Number.isFinite(timeMs)) return;
  const pose = soundPresentationState().listener;
  if (pose) listener = { x: pose[0], y: pose[1], z: pose[2] };
  let remaining = WIND_BUDGET; animated = 0;
  const at = listener ?? { x: 0, y: 0, z: 0 };
  const ordered = [...hosts.values()].sort((a, b) => a.host.windDistance(at) - b.host.windDistance(at));
  for (const state of ordered) try {
    const count = state.host.stepWind(timeMs / 1000, at, remaining);
    remaining = Math.max(0, remaining - count); animated += count;
  } catch (error) { problem(`Wind response: ${String(error)}`); }
}

function scan(timeMs: number, at: EnvironmentListener): void {
  const ambient: Target[] = [], plants: Target[] = []; observations = []; scanned = 0; omittedCandidates = 0; errors.clear();
  for (const state of [...hosts.values()].sort((a, b) => a.host.windDistance(at) - b.host.windDistance(at))) {
    const source = state.host.read(); index(state, source); if (!state.enabled) continue;
    const field = sampleTerrainEnvironment(source.recipe, at, timeMs / 1000);
    if (observations.length < 4) observations.push({ world: state.id, wind: { ...field.wind, strength: round(field.wind.strength) },
      biomes: field.biomes.slice(0, 4).map(biome => ({ id: biome.id, weight: round(biome.weight) })), baseWeight: round(field.baseWeight) });
    for (const entry of field.ambience) {
      const resolved = resolveSound(entry); if (!resolved || entry.gain <= .001) continue;
      const gain = clamp(entry.gain, 0, 2);
      ambient.push({ ...resolved, key: `${state.id}:biome:${entry.scope}:${entry.id}`, owner: state.id, gain, score: gain, kind: 'ambience',
        // Behavior recipes require a position; ambience without behavior remains a nonpositional bed.
        ...(resolved.recipe.behavior ? { position: [at.x, at.y ?? 0, at.z] as [number, number, number] } : {}) });
    }
    const lowX = Math.floor((at.x - state.radius) / CELL), highX = Math.floor((at.x + state.radius) / CELL);
    const lowZ = Math.floor((at.z - state.radius) / CELL), highZ = Math.floor((at.z + state.radius) / CELL);
    scanCells: for (let x = lowX; x <= highX; x++) for (let z = lowZ; z <= highZ; z++) for (const plant of state.cells.get(`${x},${z}`) ?? []) {
      if (scanned >= 2048) { omittedCandidates++; break scanCells; } scanned++;
      const sound = plant.asset.environment!.sound!, position = plant.item.position;
      const distance = Math.hypot(position.x - at.x, position.z - at.z), radius = Math.min(128, sound.radius ?? 28);
      if (distance > radius) continue;
      const local = sampleTerrainEnvironment(source.recipe, position, timeMs / 1000);
      const response = sampleTerrainAssetEnvironment(plant.asset.environment!, { id: plant.item.id, height: plant.height,
        position, timeSeconds: timeMs / 1000, wind: local.wind });
      const gain = clamp(response.soundGain, 0, 2) * clamp((radius - distance) / Math.max(1, radius * .25), 0, 1);
      if (gain < .002) continue;
      const resolved = resolveSound(sound); if (!resolved) continue;
      const id = `${state.id}:plant:${plant.item.id}`;
      plants.push({ ...resolved, key: id, owner: state.id, gain, position: [position.x, position.y + plant.height * .65, position.z],
        score: gain / (1 + distance / 4) * (voices.has(id) ? 1.15 : 1), kind: 'plant', size: plant.height, wind: local.wind.strength });
    }
  }
  // Ambient beds cover distant vegetation; reserve most game voices for authored action cues.
  const beds = new Map<string, Target>();
  for (const target of ambient) {
    const key = `${target.owner}:${target.signature}`, existing = beds.get(key);
    if (existing) { existing.gain = clamp(existing.gain + target.gain, 0, 2); existing.score = existing.gain; }
    else beds.set(key, { ...target });
  }
  desired = [...beds.values()].sort((a,b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0,2).concat(
    plants.sort((a,b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0,3)).slice(0,TARGET_BUDGET);
  scanAt = timeMs;
}

/** Uses the actual gameplay listener captured by the shared camera bridge. Direct preview labs may supply one. */
export function endEnvironmentFrame(timeMs: number, suppliedListener?: EnvironmentListener): void {
  if (!Number.isFinite(timeMs)) return;
  const presentation = soundPresentationState(), pose = presentation.listener;
  const at = suppliedListener ?? (pose ? { x: pose[0], y: pose[1], z: pose[2] } : undefined);
  if (!at || ![at.x, at.y ?? 0, at.z].every(Number.isFinite)) return;
  listener = at;
  if (epoch !== presentation.epoch || previousTime !== undefined && timeMs < previousTime) {
    for (const voice of voices.values()) stopSound(voice.cue);
    voices.clear(); desired = []; scanAt = -Infinity; previousTime = undefined; epoch = presentation.epoch;
  }
  // Revisions are cheap and trigger immediate reconciliation on removal/mod/stream edits.
  for (const state of hosts.values()) index(state, state.host.read());
  if (timeMs - scanAt >= 100) scan(timeMs, at);
  const dt = previousTime === undefined ? 1 / 30 : clamp((timeMs - previousTime) / 1000, 0, .25);
  const blend = 1 - Math.exp(-dt / .3); previousTime = timeMs;
  const wanted = new Map(desired.map(target => [target.key, target]));
  for (const [id, voice] of voices) {
    const target = wanted.get(id), gain = target?.signature === voice.signature ? target.gain : 0;
    voice.currentGain += (gain - voice.currentGain) * blend;
    if (!gain && voice.currentGain < .001) { stopSound(voice.cue); voices.delete(id); continue; }
    if (target && target.signature === voice.signature) Object.assign(voice, target);
    else voice.gain = 0;
    updateSound(voice.cue, { gain: voice.currentGain, ...(voice.position ? { position: voice.position } : {}) });
  }
  for (const target of desired) {
    if (voices.has(target.key) || voices.size >= VOICE_BUDGET) continue;
    const cue = `environment:${target.owner}:${++occurrence}`;
    playSound(cue, target.recipe, { loop: true, gain: 0, ...(target.position ? { position: target.position } : {}) });
    voices.set(target.key, { ...target, cue, currentGain: 0 });
  }
}

/** Compact control observations, not a claim that audio was heard or that artistic choices are correct. */
export function environmentInspection(): Record<string, unknown> {
  return { worlds: hosts.size, profilesActive: [...hosts.values()].filter(state => state.enabled).length,
    animatedInstances: animated, animationBudget: WIND_BUDGET, activeVoices: voices.size, voiceBudget: VOICE_BUDGET,
    desiredVoices: desired.length, scannedCandidates: scanned, omittedCandidates, candidateScanTruncated: omittedCandidates > 0,
    indexedPlants: [...hosts.values()].reduce((sum, state) => sum + state.indexed, 0),
    omittedIndexedPlants: [...hosts.values()].reduce((sum, state) => sum + state.omitted, 0),
    fields: observations,
    sounds: [...voices.values()].map(voice => ({ kind: voice.kind, id: voice.key, gain: round(voice.currentGain), targetGain: round(voice.gain),
      ...(voice.size === undefined ? {} : { height: round(voice.size), wind: round(voice.wind ?? 0) }) })),
    errors: [...errors], coverage: 'Presentation wind and sound control targets. Nearby vegetation uses bounded voices; biome beds cover distance. No acoustic occlusion or audible-quality verdict. Static collision is unchanged.' };
}

/** Trusted worker/lab teardown; terrain disposal normally removes its own voices automatically. */
export function resetEnvironmentRuntime(): void {
  for (const voice of voices.values()) stopSound(voice.cue);
  voices.clear(); hosts.clear(); recipes.clear(); errors.clear(); desired = []; observations = [];
  previousTime = undefined; scanAt = -Infinity; listener = undefined; epoch = ''; animated = scanned = omittedCandidates = 0;
}
