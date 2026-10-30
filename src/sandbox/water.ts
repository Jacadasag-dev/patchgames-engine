/** Decorative, deterministic water. This module never creates physics bodies or
 * simulated water: use waterSystem.ts when volume, gravity and forces are required. */
export type WaterKind = 'lake' | 'ocean' | 'river';
export interface WaterPoint { x: number; z: number }
export interface WaterPathPoint extends WaterPoint { y?: number; width?: number }
export interface WaterProfile {
  id: string; minWindSpeed: number;
  /** Vertical wave amplitude and wavelength in metres; phase speed in m/s. */
  amplitude: number; wavelength: number; speed: number;
  roughness: number; foam: number; shoreFoam: number; color: string;
}
export interface WaterRecipe {
  id: string; kind: WaterKind; seed?: number; center?: WaterPoint;
  size?: { width: number; depth: number }; level?: number; depth?: number;
  /** River centreline; widths interpolate between points. Coordinates are world-space. */
  path?: readonly WaterPathPoint[]; width?: number;
  /** Ordered, unique wind thresholds. Conditions blend neighbouring profiles. */
  profiles?: readonly WaterProfile[];
  windSpeed?: number; windDirection?: number; currentSpeed?: number;
}
export interface WaterManifest {
  id: string; revision: string; kind: WaterKind; seed: number; center: WaterPoint;
  size: { width: number; depth: number }; level: number; depth: number;
  path: { x: number; y: number; z: number; width: number }[];
  profiles: WaterProfile[]; windSpeed: number; windDirection: number; currentSpeed: number;
}
export interface WaterConditions { windSpeed?: number; windDirection?: number; currentSpeed?: number; state?: string }
export interface WaterAppearance extends Omit<WaterProfile, 'id' | 'minWindSpeed' | 'color'> {
  color: [number, number, number]; from: string; to: string; blend: number;
  windSpeed: number; windDirection: number; currentSpeed: number;
}
export interface WaterLocation { inside: boolean; level: number; edgeDistance: number; depth: number; flow: WaterPoint }
export interface WaterSample extends WaterLocation {
  height: number; normal: { x: number; y: number; z: number }; foam: number; roughness: number; color: [number, number, number];
}
export interface WaterWavePhase { temporal: number[]; currentX: number[]; currentZ: number[] }
export interface PreparedWaterWaves {
  readonly time:number;readonly appearance:WaterAppearance;
  readonly components:readonly {directionX:number;directionZ:number;k:number;amplitude:number;temporal:number;currentX:number;currentZ:number;seedPhase:number}[];
}
export interface WaterWaveSurface {height:number;slopeX:number;slopeZ:number;foam:number}
const defaults: readonly WaterProfile[] = [
  { id: 'calm', minWindSpeed: 0, amplitude: .045, wavelength: 5, speed: .65, roughness: .12, foam: .015, shoreFoam: .35, color: '#287f91' },
  { id: 'choppy', minWindSpeed: 8, amplitude: .3, wavelength: 3.2, speed: 1.8, roughness: .25, foam: .2, shoreFoam: .65, color: '#347d8d' },
  { id: 'storm', minWindSpeed: 20, amplitude: .8, wavelength: 6.5, speed: 3.4, roughness: .42, foam: .62, shoreFoam: .95, color: '#527c83' },
];
const clamp = (n: number, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function number(n: number | undefined, fallback: number, label: string, min: number, max: number): number {
  const value = n ?? fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Water ${label} must be between ${min} and ${max}.`);
  return value;
}
function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => { const srgb = parseInt(hex.slice(i, i + 2), 16) / 255; return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4; }) as [number, number, number];
}
export function compileWater(recipe: WaterRecipe): WaterManifest {
  if (!recipe || !recipe.id || typeof recipe.id !== 'string' || recipe.id.length > 128 || !['lake', 'ocean', 'river'].includes(recipe.kind)) throw new Error('Water requires an id and a lake, ocean or river kind.');
  if (recipe.path !== undefined && (!Array.isArray(recipe.path) || recipe.path.length > 128)) throw new Error('Water path budget is 128 points.');
  if (recipe.profiles !== undefined && (!Array.isArray(recipe.profiles) || !recipe.profiles.length || recipe.profiles.length > 16)) throw new Error('Water needs 1–16 profiles.');
  const level = number(recipe.level, 0, 'level', -1e5, 1e5), width = number(recipe.width, 6, 'river width', .1, 1e4);
  const path = (recipe.path ?? []).map(p => ({ x: number(p.x, 0, 'path x', -1e5, 1e5), z: number(p.z, 0, 'path z', -1e5, 1e5),
    y: number(p.y, level, 'path y', -1e5, 1e5), width: number(p.width, width, 'path width', .1, 1e4) }));
  if (path.length > 128 || recipe.kind === 'river' && path.length < 2) throw new Error('River water requires 2–128 centreline points.');
  for (let i = 1; i < path.length; i++) if (Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z) < .01) throw new Error('River centreline points must be distinct.');
  const profiles = (recipe.profiles ?? defaults).map(p => {
    if (!p.id || typeof p.id !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.color)) throw new Error('Water profiles require an id and a #rrggbb color.');
    return { id: p.id, color: p.color, minWindSpeed: number(p.minWindSpeed, 0, 'wind threshold', 0, 150),
      amplitude: number(p.amplitude, .1, 'amplitude', 0, 20), wavelength: number(p.wavelength, 5, 'wavelength', .1, 1e4),
      speed: number(p.speed, 1, 'wave speed', 0, 100), roughness: number(p.roughness, .2, 'roughness', 0, 1),
      foam: number(p.foam, 0, 'foam', 0, 1), shoreFoam: number(p.shoreFoam, .5, 'shore foam', 0, 1) };
  });
  if (!profiles.length || profiles.length > 16 || new Set(profiles.map(p => p.id)).size !== profiles.length
    || profiles.some((p, i) => i > 0 && p.minWindSpeed <= profiles[i - 1].minWindSpeed)) throw new Error('Water needs 1–16 unique profiles with increasing wind thresholds.');
  const result = { id: recipe.id, kind: recipe.kind, seed: number(recipe.seed, 1, 'seed', 0, 0xffffffff),
    center: { x: number(recipe.center?.x, 0, 'center x', -1e5, 1e5), z: number(recipe.center?.z, 0, 'center z', -1e5, 1e5) },
    size: { width: number(recipe.size?.width, 30, 'width', .1, 1e5), depth: number(recipe.size?.depth, 30, 'depth', .1, 1e5) },
    level, depth: number(recipe.depth, 3, 'depth', .01, 1e4), path, profiles,
    windSpeed: number(recipe.windSpeed, 2, 'wind speed', 0, 150), windDirection: number(recipe.windDirection, .4, 'wind direction', -1e6, 1e6),
    currentSpeed: number(recipe.currentSpeed, recipe.kind === 'river' ? 1 : 0, 'current speed', -100, 100) };
  let hash = 2166136261; for (const char of JSON.stringify(result)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return { ...result, revision: `water-v1-${(hash >>> 0).toString(16)}` };
}
/** Linear interpolation is intentional: thresholds never switch meshes or reset phase. */
export function waterAppearance(water: WaterManifest, conditions: WaterConditions = {}): WaterAppearance {
  const windSpeed = number(conditions.windSpeed, water.windSpeed, 'wind speed', 0, 150);
  const windDirection = number(conditions.windDirection, water.windDirection, 'wind direction', -1e6, 1e6);
  const currentSpeed = number(conditions.currentSpeed, water.currentSpeed, 'current speed', -100, 100);
  let from = water.profiles[0], to = from, blend = 0;
  if (conditions.state !== undefined) {
    const selected = water.profiles.find(p => p.id === conditions.state);
    if (!selected) throw new Error(`Unknown water state: ${conditions.state}`); from = to = selected;
  } else {
    for (let i = 0; i < water.profiles.length; i++) {
      if (water.profiles[i].minWindSpeed <= windSpeed) { from = water.profiles[i]; to = water.profiles[Math.min(i + 1, water.profiles.length - 1)]; }
    }
    if (from !== to) blend = clamp((windSpeed - from.minWindSpeed) / (to.minWindSpeed - from.minWindSpeed));
  }
  const a = rgb(from.color), b = rgb(to.color);
  return { from: from.id, to: to.id, blend, windSpeed, windDirection, currentSpeed, color: a.map((v, i) => mix(v, b[i], blend)) as [number, number, number],
    amplitude: mix(from.amplitude, to.amplitude, blend), wavelength: mix(from.wavelength, to.wavelength, blend), speed: mix(from.speed, to.speed, blend),
    roughness: mix(from.roughness, to.roughness, blend), foam: mix(from.foam, to.foam, blend), shoreFoam: mix(from.shoreFoam, to.shoreFoam, blend) };
}
export function locateWater(water: WaterManifest, point: WaterPoint): WaterLocation {
  if (![point.x, point.z].every(v => Number.isFinite(v) && Math.abs(v) <= 1e6)) throw new Error('Water sample coordinates must be finite and within ±1000000m.');
  let edgeDistance: number, level = water.level, flow = { x: Math.cos(water.windDirection), z: Math.sin(water.windDirection) };
  if (water.kind === 'river') {
    let nearest = Infinity; edgeDistance = -Infinity;
    for (let i = 1; i < water.path.length; i++) {
      const a = water.path[i - 1], b = water.path[i], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      const t = clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / (length * length));
      const distance = Math.hypot(point.x - mix(a.x, b.x, t), point.z - mix(a.z, b.z, t));
      const edge = mix(a.width, b.width, t) / 2 - distance;
      if (edge > edgeDistance) edgeDistance = edge;
      if (distance < nearest) { nearest = distance; level = mix(a.y, b.y, t); flow = { x: dx / length, z: dz / length }; }
    }
  } else {
    const x = (point.x - water.center.x) / (water.size.width / 2), z = (point.z - water.center.z) / (water.size.depth / 2);
    edgeDistance = water.kind === 'lake' ? (1 - Math.hypot(x, z)) * Math.min(water.size.width, water.size.depth) / 2
      : Math.min((1 - Math.abs(x)) * water.size.width / 2, (1 - Math.abs(z)) * water.size.depth / 2);
  }
  return { inside: edgeDistance >= -1e-8, level, edgeDistance, depth: water.depth * (water.kind === 'ocean' ? 1 : clamp(edgeDistance / Math.min(2, water.depth))), flow };
}
/** Resolve one accepted weather/phase snapshot once for an entire surface.
 * Direction, frequency and temporal work is independent of its vertices. */
export function prepareWaterWaves(water:WaterManifest,time:number,appearance:WaterAppearance,phases?:WaterWavePhase):PreparedWaterWaves {
  if (!Number.isFinite(time) || Math.abs(time) > 1e9) throw new Error('Water time must be finite and within ±1000000000s.');
  const components:PreparedWaterWaves['components'][number][]=[];
  for(let i=0;i<3;i++){
    const direction=appearance.windDirection+i*1.13,dx=Math.cos(direction),dz=Math.sin(direction),k=Math.PI*2/(appearance.wavelength/(1+i*.8));
    components.push({directionX:dx,directionZ:dz,k,amplitude:appearance.amplitude/(1+i*2.5),
      temporal:phases?phases.temporal[i]:-k*time*appearance.speed/(1+i*.3),
      currentX:phases?phases.currentX[i]:k*time*appearance.currentSpeed*dx,currentZ:phases?phases.currentZ[i]:k*time*appearance.currentSpeed*dz,
      seedPhase:water.seed*.123+i*2.17});
  }
  return{time,appearance:{...appearance,color:[...appearance.color]},components};
}
/** Lower-level sampler lets views cache shoreline queries and wave preparation.
 * This is the same source used by planar and planetary water surfaces. */
export function samplePreparedWaterWaveSurface(prepared:PreparedWaterWaves,point:WaterPoint,location:WaterLocation):WaterWaveSurface {
  const {appearance,time}=prepared;
  let displacement = 0, slopeX = 0, slopeZ = 0;
  const attenuation = clamp(location.depth / Math.max(.3, appearance.amplitude * 2));
  for(const component of prepared.components){
    const {directionX:dx,directionZ:dz,k}=component,amplitude=component.amplitude*attenuation;
    const phase=k*(point.x*dx+point.z*dz)+component.temporal-component.currentX*location.flow.x-component.currentZ*location.flow.z+component.seedPhase;
    const slope=amplitude*k*Math.cos(phase);
    displacement+=amplitude*Math.sin(phase);slopeX+=slope*dx;slopeZ+=slope*dz;
  }
  const crest = clamp(displacement / Math.max(.001, appearance.amplitude) - .2);
  const shore = clamp(1 - location.depth / 1.2) * (.5 + .5 * Math.sin(time * (1 + appearance.windSpeed * .05) - location.edgeDistance * 4 + point.x * .13));
  return{height:location.level+displacement,slopeX,slopeZ,foam:location.inside?clamp(crest*appearance.foam+shore*appearance.shoreFoam):0};
}
export function samplePreparedWaterWave(prepared:PreparedWaterWaves,point:WaterPoint,location:WaterLocation):WaterSample {
  const surface=samplePreparedWaterWaveSurface(prepared,point,location),magnitude=Math.hypot(surface.slopeX,1,surface.slopeZ);
  return{...location,height:surface.height,normal:{x:-surface.slopeX/magnitude,y:1/magnitude,z:-surface.slopeZ/magnitude},foam:surface.foam,
    roughness:prepared.appearance.roughness,color:prepared.appearance.color};
}
/** Single-query convenience wrapper; surfaces should prepare their spectrum once. */
export function sampleWaterWave(water:WaterManifest,point:WaterPoint,time:number,appearance:WaterAppearance,location:WaterLocation,phases?:WaterWavePhase):WaterSample {
  return samplePreparedWaterWave(prepareWaterWaves(water,time,appearance,phases),point,location);
}
