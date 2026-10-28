import type { SoundRecipeInput } from '../shared/soundRecipes.ts';
import type { TerrainPoint, TerrainRecipe, TerrainRegion } from './terrain.ts';

/** Presentation metadata, shared by generated and deliberately placed objects.
 * Inline recipes travel with mods; strings resolve through editable sound presets.
 * No audio, Three, physics or random-number state is needed to sample this data. */
export interface EnvironmentSound {
  recipe: string | SoundRecipeInput;
  gain?: number;
}
export interface EnvironmentWind {
  /** World-space X,Z direction; magnitude is ignored. Default [.8,.6]. */
  direction?: [number, number];
  strength?: number;
  gustStrength?: number;
  /** Seconds per large gust, and metres per wave across the world. */
  gustPeriod?: number;
  spatialScale?: number;
}
export interface TerrainEnvironment { wind?: EnvironmentWind; ambience?: EnvironmentSound }
export interface TerrainRegionEnvironment {
  ambience?: EnvironmentSound;
  windMultiplier?: number;
  /** Symmetric fade width on each side of a biome edge, in metres. */
  blend?: number;
}
export interface TerrainAssetEnvironment {
  wind?: {
    bendRadians?: number;
    swayHz?: number;
    flutter?: number;
    referenceHeight?: number;
    /** Positive values make larger objects slower and less angular. */
    sizeExponent?: number;
  };
  sound?: EnvironmentSound & {
    /** Gain at calm and unit-strength wind. Values interpolate, never select a clip. */
    windGain?: [number, number];
    sizeGainExponent?: number;
    referenceHeight?: number;
    /** Candidate listening radius in metres; voices remain host-budgeted. */
    radius?: number;
  };
}
export interface EnvironmentWindSample { direction: [number, number]; strength: number; gust: number }
export interface TerrainEnvironmentSample {
  wind: EnvironmentWindSample;
  biomes: { id: string; weight: number }[];
  baseWeight: number;
  ambience: { id: string; scope: 'world' | 'region'; recipe: EnvironmentSound['recipe']; gain: number; weight: number }[];
}
export interface TerrainAssetEnvironmentSample {
  height: number;
  sizeRatio: number;
  frequency: number;
  /** World-axis root rotations in radians, before authored instance yaw. */
  bend: { x: number; z: number };
  soundGain: number;
}

const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const record = (n: unknown): n is Record<string, unknown> => !!n && typeof n === 'object' && !Array.isArray(n);
function unitHash(text: string): number {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) { n ^= text.charCodeAt(i); n = Math.imul(n, 16777619); }
  n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); n ^= n >>> 15;
  return (n >>> 0) / 0x100000000;
}
function regionDistance(region: TerrainRegion, point: TerrainPoint): number {
  const mask = region.mask, dx = point.x - mask.center.x, dz = point.z - mask.center.z;
  if (mask.kind === 'circle') return Math.hypot(dx, dz) - mask.radius;
  const c = Math.cos(mask.yaw ?? 0), s = Math.sin(mask.yaw ?? 0);
  const x = Math.abs(dx * c - dz * s) - mask.width / 2, z = Math.abs(dx * s + dz * c) - mask.depth / 2;
  return Math.hypot(Math.max(0, x), Math.max(0, z)) + Math.min(0, Math.max(x, z));
}

/** Continuous spatial weights, independent of chunk boundaries, seed rerolls,
 * iteration order and frame rate. Regions without environmental metadata do not
 * mute an existing soundscape. Overlaps share a bounded total weight of one. */
export function sampleTerrainEnvironment(recipe: TerrainRecipe, point: TerrainPoint, timeSeconds: number): TerrainEnvironmentSample {
  if (!finite(point.x) || !finite(point.z) || !finite(timeSeconds)) throw new Error('Environment samples require finite coordinates and time.');
  const raw = recipe.regions.filter(region => region.environment).map(region => {
    const fade = region.environment?.blend ?? region.blend ?? 8, distance = regionDistance(region, point);
    return { region, weight: fade > 0 ? smooth(.5 - distance / (fade * 2)) : distance <= 0 ? 1 : 0 };
  }).filter(item => item.weight > 0).sort((a, b) => a.region.id < b.region.id ? -1 : a.region.id > b.region.id ? 1 : 0);
  const total = raw.reduce((sum, item) => sum + item.weight, 0), divisor = Math.max(1, total), baseWeight = 1 - Math.min(1, total);
  const biomes = raw.map(({ region, weight }) => ({ id: region.id, weight: weight / divisor }));
  const ambience: TerrainEnvironmentSample['ambience'] = [];
  let baseAmbienceWeight = baseWeight;
  let windMultiplier = baseWeight;
  for (let i = 0; i < raw.length; i++) {
    const environment = raw[i].region.environment!, weight = biomes[i].weight;
    windMultiplier += weight * (environment.windMultiplier ?? 1);
    if (environment.ambience) ambience.push({ id: biomes[i].id, scope: 'region', recipe: environment.ambience.recipe,
      gain: weight * (environment.ambience.gain ?? 1), weight });
    else baseAmbienceWeight += weight;
  }
  // A wind-exposure-only region inherits the world soundscape. An authored
  // gain:0 ambience deliberately fades it to silence instead.
  if (baseAmbienceWeight > 0 && recipe.environment?.ambience) ambience.unshift({ id: '$base', scope: 'world', recipe: recipe.environment.ambience.recipe,
    gain: baseAmbienceWeight * (recipe.environment.ambience.gain ?? 1), weight: baseAmbienceWeight });
  // Opted-in tree/bush mods work on older bases too. Unprofiled terrain remains
  // still; an explicitly calm wind always takes precedence over this breeze.
  const wind = recipe.environment?.wind ?? (recipe.assets.some(asset => asset.environment?.wind) ? {} : undefined);
  const authored = wind?.direction ?? [.8, .6], magnitude = Math.hypot(...authored) || 1;
  const direction: [number, number] = [authored[0] / magnitude, authored[1] / magnitude];
  const phase = unitHash(`${recipe.seed}:environment-wind`) * Math.PI * 2;
  const travel = (point.x * direction[0] + point.z * direction[1]) / (wind?.spatialScale ?? 40);
  const wave = timeSeconds / (wind?.gustPeriod ?? 7) - travel;
  const gust = clamp(.5 + .35 * Math.sin(wave * Math.PI * 2 + phase) + .15 * Math.sin(wave * Math.PI * 3.14 + phase * .7));
  const strength = wind ? clamp(((wind.strength ?? .45) + (wind.gustStrength ?? .35) * gust) * windMultiplier, 0, 4) : 0;
  return { wind: { direction, strength, gust }, biomes, baseWeight, ambience };
}

/** Size-sensitive procedural presentation. One world wind sample drives motion
 * and sound together. Larger objects are slower, less angular and optionally
 * louder; all coefficients are editable, including zero/negative sound scaling. */
export function sampleTerrainAssetEnvironment(profile: TerrainAssetEnvironment | undefined, options: {
  id: string; height: number; position: TerrainPoint; timeSeconds: number; wind: EnvironmentWindSample;
}): TerrainAssetEnvironmentSample {
  const { id, position, timeSeconds, wind } = options;
  if (!finite(options.height) || options.height <= 0 || !finite(position.x) || !finite(position.z) || !finite(timeSeconds))
    throw new Error('Asset environment samples require positive finite height and finite coordinates/time.');
  const motion = profile?.wind, height = options.height;
  const sizeRatio = clamp(height / (motion?.referenceHeight ?? profile?.sound?.referenceHeight ?? 4), .05, 100);
  const inertia = sizeRatio ** (motion?.sizeExponent ?? .5), frequency = motion ? clamp((motion.swayHz ?? .7) / inertia, 0, 8) : 0;
  const phase = unitHash(id) * Math.PI * 2, time = timeSeconds * frequency * Math.PI * 2;
  const sway = .65 + .3 * Math.sin(time + phase) + (motion?.flutter ?? .15) * .2 * Math.sin(time * 3.7 + phase * 1.3);
  const angle = motion ? clamp((motion.bendRadians ?? .06) * wind.strength / inertia * sway, -1.2, 1.2) : 0;
  const sound = profile?.sound, windGain = sound?.windGain ?? [0, 1];
  const sizeGain = (clamp(height / (sound?.referenceHeight ?? motion?.referenceHeight ?? 4), .05, 100)) ** (sound?.sizeGainExponent ?? .6);
  const soundGain = sound ? clamp((sound.gain ?? 1) * sizeGain * (windGain[0] + (windGain[1] - windGain[0]) * clamp(wind.strength)), 0, 2) : 0;
  return { height, sizeRatio, frequency, bend: { x: wind.direction[1] * angle, z: -wind.direction[0] * angle }, soundGain };
}

/** Envelope validation only. Full inline audio schema/asset validation belongs
 * to the view/audio host. Authority compilation never imports an audio engine
 * or a schema package just to scatter a forest. These are data errors, not
 * judgments about which sounds or motions a biome should have. */
export function terrainEnvironmentErrors(value: unknown, kind: 'world' | 'region' | 'asset'): string[] {
  if (value === undefined) return [];
  const errors: string[] = [];
  if (!record(value)) return ['Environment metadata must be an object.'];
  const number = (object: Record<string, unknown>, key: string, low: number, high: number) => {
    const n = object[key];
    if (n !== undefined && (!finite(n) || n < low || n > high)) errors.push(`${key} must be finite within ${low}..${high}.`);
  };
  const keys = (object: Record<string, unknown>, allowed: string[]) => {
    for (const key of Object.keys(object)) if (!allowed.includes(key)) errors.push(`Unknown environment field ${key}.`);
  };
  const envelope = (recipe: unknown): boolean => {
    let remaining = 2048;
    const visit = (node: unknown, depth: number): boolean => {
      if (--remaining < 0 || depth > 12) return false;
      if (node === null || typeof node === 'boolean' || finite(node)) return true;
      if (typeof node === 'string') return node.length <= 256;
      if (Array.isArray(node)) return node.length <= 64 && node.every(item => visit(item, depth + 1));
      return record(node) && Object.keys(node).length <= 32 && Object.entries(node).every(([key, item]) => key.length <= 80 && visit(item, depth + 1));
    };
    return record(recipe) && recipe.kind === 'sound' && recipe.version === 1 && Array.isArray(recipe.layers)
      && recipe.layers.length >= 1 && recipe.layers.length <= 12 && visit(recipe, 0);
  };
  const sound = (input: unknown, asset: boolean) => {
    if (input === undefined) return;
    if (!record(input)) { errors.push('Environment sound must be an object.'); return; }
    keys(input, ['recipe', 'gain', ...(asset ? ['windGain', 'sizeGainExponent', 'referenceHeight', 'radius'] : [])]);
    if (typeof input.recipe === 'string' ? !input.recipe.length || input.recipe.length > 120 : !envelope(input.recipe))
      errors.push('Environment sound requires a 1..120-character preset ID or bounded inline sound recipe.');
    number(input, 'gain', 0, 2);
    if (asset) {
      number(input, 'sizeGainExponent', -2, 2); number(input, 'referenceHeight', .01, 1000); number(input, 'radius', .1, 1000);
      if (input.windGain !== undefined && (!Array.isArray(input.windGain) || input.windGain.length !== 2 || input.windGain.some(n => !finite(n) || n < 0 || n > 2)))
        errors.push('windGain must contain calm and windy gains within 0..2.');
    }
  };
  if (kind === 'world') {
    keys(value, ['wind', 'ambience']); sound(value.ambience, false);
    if (value.wind !== undefined) {
      if (!record(value.wind)) errors.push('World wind must be an object.');
      else {
        const wind = value.wind;
        keys(wind, ['direction', 'strength', 'gustStrength', 'gustPeriod', 'spatialScale']);
        number(wind, 'strength', 0, 4); number(wind, 'gustStrength', 0, 4); number(wind, 'gustPeriod', .1, 3600); number(wind, 'spatialScale', .1, 10000);
        if (wind.direction !== undefined && (!Array.isArray(wind.direction) || wind.direction.length !== 2
          || wind.direction.some(n => !finite(n) || Math.abs(n) > 1e6) || Math.hypot(...wind.direction as number[]) < .000001))
          errors.push('Wind direction requires two finite nonzero X,Z components.');
      }
    }
  } else if (kind === 'region') {
    keys(value, ['ambience', 'windMultiplier', 'blend']); sound(value.ambience, false);
    number(value, 'windMultiplier', 0, 4); number(value, 'blend', 0, 10000);
  } else {
    keys(value, ['wind', 'sound']); sound(value.sound, true);
    if (value.wind !== undefined) {
      if (!record(value.wind)) errors.push('Asset wind must be an object.');
      else {
        keys(value.wind, ['bendRadians', 'swayHz', 'flutter', 'referenceHeight', 'sizeExponent']);
        number(value.wind, 'bendRadians', 0, 1.2); number(value.wind, 'swayHz', 0, 8); number(value.wind, 'flutter', 0, 2);
        number(value.wind, 'referenceHeight', .01, 1000); number(value.wind, 'sizeExponent', -2, 2);
      }
    }
  }
  return errors.slice(0, 12);
}
