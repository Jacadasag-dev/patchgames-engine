import type { PhysicsCollider, PhysicsScene, PhysicsVector } from './physics.ts';
import { physicsShapeBounds, physicsShapeVolume } from './physicsGeometry.ts';
import { validateAssetManifest, transformAssetColliders, type AssetManifest } from './assetFamilies.ts';
import { facingYaw, nearestSpatialRoute, nearScore, spatialAngle, spatialCoordinate, type Direction } from './spatial.ts';
import { terrainEnvironmentErrors, type TerrainAssetEnvironment, type TerrainRegionEnvironment, type TerrainEnvironment } from './terrainEnvironment.ts';
import { validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';
import { carveTerrainChannels, resolveTerrainChannels, sampleTerrainChannel, terrainChannelIssues, type TerrainChannel, type ResolvedTerrainChannel } from './terrainChannels.ts';
export type { TerrainChannel, ResolvedTerrainChannel } from './terrainChannels.ts';

/** Bounded authoring-time heightfield compiler. All coordinates use metres, Y-up. */
export const TERRAIN_VERSION = 'terrain-v1';
export interface TerrainPoint { x: number; z: number }
export interface TerrainRoutePoint extends TerrainPoint { /** Explicit grading target; omitted preserves original base height. */ y?: number }
export type TerrainFootprint = { kind: 'circle'; radius: number }
  | { kind: 'box'; width: number; depth: number };
export type TerrainMask = ({ center: TerrainPoint; yaw?: number } & TerrainFootprint);
/** Asset +Z faces the target. Along follows route point order. Explicit placement
 * yaw wins; offset is an additional angle in radians. */
export type TerrainFacing = ({ point: TerrainPoint } | { side: Direction } | { route: string; along?: boolean }) & { offset?: number };
export interface TerrainPreference {
  target: { point: TerrainPoint } | { route: string };
  mode: 'near' | 'away';
  range: number;
  weight: number;
}
export interface TerrainAsset {
  id: string;
  /** Update when the model or placement metadata changes. */
  version?: string;
  footprint: TerrainFootprint;
  /** Optional obstacle, centred above the sampled ground by offsetY. */
  collider?: { shape: PhysicsCollider['shape']; offsetY: number; friction?: number };
  /** Pre-resolved family geometry and its compound collision. Mutually exclusive
   * with collider; the declared footprint must contain the complete model. */
  model?: AssetManifest;
  /** Optional shared texture recipe/palette, used as the model's fallback material. */
  material?: SurfaceMaterialInput;
  /** Editable rendering hint; custom view code can supply any model. */
  appearance?: { kind?: string; color?: string; height?: number; [key: string]: unknown };
  /** Shared wind motion and editable sound response, inherited by every instance. */
  environment?: TerrainAssetEnvironment;
}
export interface TerrainScatterLayer {
  id: string;
  assets: string[];
  /** Candidate grid spacing in metres; density is acceptance probability [0,1]. */
  spacing: number;
  density: number;
  scale?: [number, number];
  maxSlope?: number;
  elevation?: [number, number];
  /** Deliberately rerolls only this layer. */
  seed?: number;
  facing?: TerrainFacing;
  /** Weighted acceptance bias after immutable spacing, not global best packing.
   * Near is 1 at the target and 0 at range; away is its inverse. Zero weights
   * are ignored. At most eight preferences, with weights from 0 to 100. */
  preferences?: TerrainPreference[];
}
export interface TerrainRegion {
  id: string;
  mask: TerrainMask;
  blend?: number;
  elevation?: number;
  color?: string;
  /** World-mapped material blended over the base within this region's mask. */
  material?: SurfaceMaterialInput;
  layers: TerrainScatterLayer[];
  /** Biome soundscape and wind exposure blend continuously across the edge. */
  environment?: TerrainRegionEnvironment;
}
export interface TerrainRoute {
  id: string;
  points: TerrainRoutePoint[];
  width: number;
  shoulder?: number;
  clearance?: number;
  color?: string;
  /** World-mapped material blended over regions across width and shoulder. */
  material?: SurfaceMaterialInput;
  /** Plazas/clearings may clear scatter while allowing deliberate buildings.
   * Defaults to false: actual travel routes reject crossing placements. */
  allowPlacements?: boolean;
  /** Grades between explicit point.y targets or original base-surface heights. */
  grade?: { strength?: number; maxCutFill?: number; maxSlope?: number };
}
export interface TerrainPlacement {
  id: string;
  asset: string;
  position: TerrainPoint & { y?: number };
  yaw?: number;
  facing?: TerrainFacing;
  scale?: number;
  clearance?: number;
  shoulder?: number;
  foundation?: { height?: number; blend?: number; maxCutFill?: number };
  /** Explicit shared owner for overlapping foundation tiles/landings. Does not
   * suppress route constraints or change native asset collision. */
  foundationGroup?: string;
  /** World-space access corridors, reserved just like routes. */
  entrances?: { id: string; points: TerrainPoint[]; width: number; clearance?: number }[];
}
/** Clears scatter only. Does not grade ground, block routes or create collision;
 * useful for compound props whose actual pillars leave a traversable opening. */
export interface TerrainScatterReservation {
  id: string;
  mask: TerrainMask;
  clearance?: number;
  shoulder?: number;
}
export interface TerrainRecipe {
  version: 1;
  seed: number;
  bounds: { width: number; depth: number; cells?: number };
  base?: { height?: number; noise?: { amplitude: number; wavelength: number; octaves?: number } };
  /** Optional ground texture; omitted preserves the original vertex-color view. */
  material?: SurfaceMaterialInput;
  assets: TerrainAsset[];
  regions: TerrainRegion[];
  routes?: TerrainRoute[];
  /** Ordered river/canal excavation; applied before road grading/foundations. */
  channels?: TerrainChannel[];
  placements?: TerrainPlacement[];
  reservations?: TerrainScatterReservation[];
  overrides?: { remove?: string[]; pin?: TerrainPlacement[] };
  budgets?: { instances?: number; candidates?: number; colliders?: number };
  /** Worlds wider/deeper than 128m stream by default. An explicit object also
   * enables chunks in smaller worlds. False preserves bounded eager generation. */
  streaming?: false | { chunkSize?: number; cells?: number };
  /** Presentation only: does not alter scatter, authored reservations or collision. */
  environment?: TerrainEnvironment;
}
/** Shared selection for preparation, sampling and world-site planning. */
export function terrainUsesStreaming(recipe: TerrainRecipe): boolean {
  return recipe.streaming !== false && (recipe.streaming !== undefined || Math.max(recipe.bounds.width, recipe.bounds.depth) > 128);
}
export interface TerrainInstance {
  id: string;
  asset: string;
  position: PhysicsVector;
  yaw: number;
  scale: number;
  source: { kind: 'scatter' | 'placement' | 'pin'; region?: string; layer?: string; candidate?: string };
  footprint: TerrainFootprint;
}
export interface TerrainIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  ids?: string[];
  position?: TerrainPoint;
}
export interface TerrainManifest {
  version: typeof TERRAIN_VERSION;
  revision: string;
  recipe: TerrainRecipe;
  bounds: { width: number; depth: number };
  /** Present for a streamed window; samples and instances remain in world coordinates. */
  origin?: TerrainPoint;
  rows: number;
  columns: number;
  /** Float32 values in Rapier column-major order: column * (rows + 1) + row. */
  heights: number[];
  /** Packed RGB colours, aligned with heights. These are presentation metadata. */
  colors: number[];
  instances: TerrainInstance[];
  colliders: PhysicsCollider[];
  /** Resolved global centerlines; identical in adjacent streamed chunks. */
  channels?: ResolvedTerrainChannel[];
  diagnostics: {
    valid: boolean;
    issues: TerrainIssue[];
    counts: { candidates: number; instances: number; colliders: number; excluded: number };
    excludedBy: Record<string, number>;
    sampling: { cellWidth: number; cellDepth: number; surface: 'heightfield-y-up'; navigation: 'unsupported' };
  };
  changes: { added: string[]; removed: string[]; updated: string[]; unchanged: number; surfaceChanged: boolean };
}
export interface TerrainInspection {
  version: typeof TERRAIN_VERSION;
  revision: string;
  valid: boolean;
  counts: TerrainManifest['diagnostics']['counts'];
  excludedBy: Record<string, number>;
  excludedReasonCount: number;
  truncated: boolean;
  sampling: TerrainManifest['diagnostics']['sampling'];
  issues: TerrainIssue[];
  issueCount: number;
  changes: { added: number; removed: number; updated: number; unchanged: number; surfaceChanged: boolean };
}

const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const pointOkay = (p: TerrainPoint | undefined) => !!p && finite(p.x) && finite(p.z);
function terrainFacingYaw(facing: TerrainFacing | undefined, point: TerrainPoint, routes: ReadonlyMap<string, TerrainRoute>): number | undefined {
  if (!facing) return;
  let yaw: number | undefined;
  if ('side' in facing) yaw = facingYaw(facing.side, point.x, point.z);
  else if ('point' in facing) yaw = facingYaw(facing.point, point.x, point.z);
  else {
    const near = nearestSpatialRoute(point, routes.get(facing.route)!.points);
    if (near) yaw = facing.along ? facingYaw(near.tangent, 0, 0) : facingYaw(near.point, point.x, point.z);
  }
  return yaw === undefined ? undefined : spatialAngle(yaw + (facing.offset ?? 0));
}

/** Maximum horizontal collision reach from the asset origin, before instance
 * scale. Includes compound part offsets so streaming loads their owning chunk. */
export function terrainAssetColliderReach(asset: TerrainAsset): number {
  if (asset.model) return Math.max(0, ...validateAssetManifest(asset.model).colliders.map(collider => {
    const shape = collider.shape, extent = shape.kind === 'box' ? Math.hypot(shape.halfExtents.x, shape.halfExtents.z)
      : shape.kind === 'convex' ? Math.max(...shape.vertices.map(v => Math.hypot(v.x, v.z))) : shape.radius;
    return Math.ceil((Math.hypot(collider.position.x, collider.position.z) + extent) * 1e7) / 1e7;
  }));
  const shape = asset.collider?.shape;
  return !shape ? 0 : shape.kind === 'box' ? Math.hypot(shape.halfExtents.x, shape.halfExtents.z)
    : shape.kind === 'convex' ? Math.max(...shape.vertices.map(v => Math.hypot(v.x, v.z))) : shape.radius;
}
function validConvexShape(shape: PhysicsCollider['shape']): boolean {
  try { return shape.kind === 'convex' && physicsShapeVolume(shape) > 0; } catch { return false; }
}
function scaledShape(source: PhysicsCollider['shape'], scale: number, snap: (n: number) => number = n => n): PhysicsCollider['shape'] {
  if (source.kind === 'convex') return { kind: 'convex', vertices: source.vertices.map(v => ({ x: snap(v.x * scale), y: snap(v.y * scale), z: snap(v.z * scale) })) };
  if (source.kind === 'box') return { kind: 'box', halfExtents: { x: snap(source.halfExtents.x * scale), y: snap(source.halfExtents.y * scale), z: snap(source.halfExtents.z * scale) } };
  return source.kind === 'ball' ? { kind: 'ball', radius: snap(source.radius * scale) }
    : { kind: 'capsule', radius: snap(source.radius * scale), halfHeight: snap(source.halfHeight * scale) };
}
function validScaledShape(shape: PhysicsCollider['shape']): boolean {
  if (shape.kind === 'convex') return validConvexShape(shape);
  const dimensions = shape.kind === 'box' ? Object.values(shape.halfExtents) : [shape.radius];
  return dimensions.every(n => Number.isFinite(n) && n >= .02 && n <= 1000)
    && (shape.kind !== 'capsule' || Number.isFinite(shape.halfHeight) && shape.halfHeight >= 0 && shape.halfHeight <= 1000);
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
function terrainFingerprint(recipe: TerrainRecipe, strict = false): string {
  if (!Array.isArray(recipe.assets) || !recipe.assets.some(asset => asset?.model !== undefined)) return canonical(recipe);
  return canonical({ ...recipe, assets: recipe.assets.map(asset => {
    if (asset?.model === undefined) return asset;
    try { return { ...asset, model: { key: validateAssetManifest(asset.model).key } }; }
    catch (error) { if (strict) throw error; return { ...asset, model: { invalid: asset.model } }; }
  }) });
}
function hashState(value: string, n = 2166136261): number {
  for (let i = 0; i < value.length; i++) { n ^= value.charCodeAt(i); n = Math.imul(n, 16777619); }
  return n;
}
function hash(value: string, prefix = 2166136261): number {
  let n = hashState(value, prefix);
  n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); n ^= n >>> 15; n = Math.imul(n, 0x846ca68b);
  return (n ^ n >>> 16) >>> 0;
}
const random = (key: string, prefix?: number) => hash(key, prefix) / 0x100000000;
const keyPart = (value: string) => encodeURIComponent(value);
const instanceLabel = (value: string) => `${keyPart(value).slice(0, 24)}~${hash(value).toString(16).padStart(8, '0')}`;
function noise(seed: number, x: number, z: number, samples: Map<string, number>): number {
  const ix = Math.floor(x), iz = Math.floor(z), u = smooth(x - ix), v = smooth(z - iz);
  const at = (a: number, b: number) => {
    const key = `${seed}:noise:${a}:${b}`;
    let value = samples.get(key);
    if (value === undefined) {
      value = random(key) * 2 - 1;
      // Small wavelengths can visit many lattice cells. Stop retaining entries
      // at the bound; uncached samples still use exactly the same hash.
      if (samples.size < 4096) samples.set(key, value);
    }
    return value;
  };
  return (at(ix, iz) * (1 - u) + at(ix + 1, iz) * u) * (1 - v)
    + (at(ix, iz + 1) * (1 - u) + at(ix + 1, iz + 1) * u) * v;
}
interface FootprintRotation { c: number; s: number }
function footprintDistance(point: TerrainPoint, shape: TerrainFootprint, center: TerrainPoint, yaw = 0, rotation?: FootprintRotation): number {
  const dx = point.x - center.x, dz = point.z - center.z;
  const c = rotation ? rotation.c : Math.cos(yaw), s = rotation ? rotation.s : Math.sin(yaw);
  const localX = dx * c - dz * s, localZ = dx * s + dz * c;
  if (shape.kind === 'circle') return Math.hypot(localX, localZ) - shape.radius;
  const x = Math.abs(localX) - shape.width / 2, z = Math.abs(localZ) - shape.depth / 2;
  return Math.hypot(Math.max(0, x), Math.max(0, z)) + Math.min(0, Math.max(x, z));
}
function maskWeight(mask: TerrainMask, p: TerrainPoint, blend = 0, rotation?: FootprintRotation): number {
  const d = footprintDistance(p, mask, mask.center, mask.yaw, rotation);
  return d > 0 ? 0 : blend > 0 ? smooth(-d / blend) : 1;
}
function scaled(shape: TerrainFootprint, scale: number): TerrainFootprint {
  return shape.kind === 'circle' ? { kind: 'circle', radius: shape.radius * scale }
    : { kind: 'box', width: shape.width * scale, depth: shape.depth * scale };
}
const radius = (shape: TerrainFootprint) => shape.kind === 'circle' ? shape.radius : Math.hypot(shape.width, shape.depth) / 2;
function corners(shape: Extract<TerrainFootprint, { kind: 'box' }>, center: TerrainPoint, yaw: number): TerrainPoint[] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([x, z]) => ({
    x: center.x + x * shape.width / 2 * c + z * shape.depth / 2 * s,
    z: center.z - x * shape.width / 2 * s + z * shape.depth / 2 * c,
  }));
}
function segmentPoint(p: TerrainPoint, a: TerrainPoint, b: TerrainPoint): { distance: number; t: number } {
  const dx = b.x - a.x, dz = b.z - a.z, t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1));
  return { distance: Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz), t };
}
function segmentDistance(a: TerrainPoint, b: TerrainPoint, c: TerrainPoint, d: TerrainPoint): number {
  const cross = (p: TerrainPoint, q: TerrainPoint, r: TerrainPoint) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const abc = cross(a, b, c), abd = cross(a, b, d), cda = cross(c, d, a), cdb = cross(c, d, b);
  if (((abc > 0 && abd < 0) || (abc < 0 && abd > 0)) && ((cda > 0 && cdb < 0) || (cda < 0 && cdb > 0))) return 0;
  return Math.min(segmentPoint(a, c, d).distance, segmentPoint(b, c, d).distance,
    segmentPoint(c, a, b).distance, segmentPoint(d, a, b).distance);
}
interface Footed { footprint: TerrainFootprint; position: TerrainPoint; yaw: number }
function footprintGap(a: Footed, b: Footed): number {
  if (a.footprint.kind === 'circle') return footprintDistance(a.position, b.footprint, b.position, b.yaw) - a.footprint.radius;
  if (b.footprint.kind === 'circle') return footprintDistance(b.position, a.footprint, a.position, a.yaw) - b.footprint.radius;
  const av = corners(a.footprint, a.position, a.yaw), bv = corners(b.footprint, b.position, b.yaw);
  if (av.some(p => footprintDistance(p, b.footprint, b.position, b.yaw) <= 0)
    || bv.some(p => footprintDistance(p, a.footprint, a.position, a.yaw) <= 0)) return -0.000001;
  let gap = Infinity;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) gap = Math.min(gap, segmentDistance(av[i], av[(i + 1) % 4], bv[j], bv[(j + 1) % 4]));
  return gap;
}
function routeGap(object: Footed, points: TerrainPoint[]): number {
  let gap = Infinity;
  for (let i = 1; i < points.length; i++) {
    if (object.footprint.kind === 'circle') gap = Math.min(gap, segmentPoint(object.position, points[i - 1], points[i]).distance - object.footprint.radius);
    else {
      if (footprintDistance(points[i - 1], object.footprint, object.position, object.yaw) <= 0
        || footprintDistance(points[i], object.footprint, object.position, object.yaw) <= 0) return 0;
      const v = corners(object.footprint, object.position, object.yaw);
      for (let j = 0; j < 4; j++) gap = Math.min(gap, segmentDistance(points[i - 1], points[i], v[j], v[(j + 1) % 4]));
    }
  }
  return gap;
}
interface RouteSegment { x: number; z: number; dx: number; dz: number; denominator: number }
function nearestRoute(p: TerrainPoint, segments: RouteSegment[]) {
  let best = { distance: Infinity, t: 0, segment: 1 };
  for (let i = 0; i < segments.length; i++) {
    const { x, z, dx, dz, denominator } = segments[i];
    const t = clamp(((p.x - x) * dx + (p.z - z) * dz) / denominator);
    const distance = Math.hypot(p.x - x - t * dx, p.z - z - t * dz);
    if (distance < best.distance) best = { distance, t, segment: i + 1 };
  }
  return best;
}
function color(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const hex = value.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return parseInt(hex, 16);
  if (/^[0-9a-f]{3}$/i.test(hex)) return parseInt(hex.split('').map(x => x + x).join(''), 16);
  return fallback;
}
function mixColor(a: number, b: number, weight: number): number {
  if (weight === 0) return a;
  if (weight === 1) return b;
  return Math.round(((a >>> 16) & 255) * (1 - weight) + ((b >>> 16) & 255) * weight) << 16
    | Math.round(((a >>> 8) & 255) * (1 - weight) + ((b >>> 8) & 255) * weight) << 8
    | Math.round((a & 255) * (1 - weight) + (b & 255) * weight);
}
function baseHeight(recipe: TerrainRecipe, p: TerrainPoint, noiseSamples: Map<string, number>, rotations: FootprintRotation[], weights?: number[]): number {
  let result = recipe.base?.height ?? 0;
  const n = recipe.base?.noise;
  if (n) for (let octave = 0; octave < (n.octaves ?? 3); octave++) result += noise(recipe.seed + octave, p.x / n.wavelength * 2 ** octave, p.z / n.wavelength * 2 ** octave, noiseSamples) * n.amplitude / 2 ** octave;
  for (let i = 0; i < recipe.regions.length; i++) {
    const region = recipe.regions[i];
    result += (region.elevation ?? 0) * (weights ? weights[i] : maskWeight(region.mask, p, region.blend ?? 0, rotations[i]));
  }
  return result;
}

/** Snapshot the bounded elevation inputs for repeated planning queries. This is
 * the analytic base before road grading/foundations, not a rendered triangle or
 * collision query. Source edits require a new sampler. */
export function createTerrainBaseHeightSampler(input: TerrainRecipe): (x: number, z: number) => number {
  const n = input.base?.noise;
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff || !Array.isArray(input.regions) || input.regions.length > 32
    || !finite(input.base?.height ?? 0) || Math.abs(input.base?.height ?? 0) > 10000
    || n && (!finite(n.amplitude) || n.amplitude < 0 || n.amplitude > 10000 || !finite(n.wavelength) || n.wavelength < .001
      || !Number.isInteger(n.octaves ?? 3) || (n.octaves ?? 3) < 1 || (n.octaves ?? 3) > 6)) throw new Error('Invalid bounded terrain elevation inputs.');
  const regions = Array.from(input.regions, region => {
    const m = region?.mask;
    if (!region || typeof region.id !== 'string' || !m || !pointOkay(m.center) || !finite(m.yaw ?? 0)
      || !finite(region.blend ?? 0) || (region.blend ?? 0) < 0 || !finite(region.elevation ?? 0)
      || (m.kind === 'circle' ? !positive(m.radius) : m.kind !== 'box' || !positive(m.width) || !positive(m.depth))) throw new Error('Invalid terrain elevation region.');
    return { id: region.id, mask: { ...m, center: { ...m.center } }, blend: region.blend, elevation: region.elevation, layers: [] };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const recipe: TerrainRecipe = { version: 1, seed: input.seed, bounds: { ...input.bounds }, base: { height: input.base?.height, ...(n ? { noise: { ...n } } : {}) }, assets: [], regions };
  const samples = new Map<string, number>(), rotations = regions.map(region => ({ c: Math.cos(region.mask.yaw ?? 0), s: Math.sin(region.mask.yaw ?? 0) }));
  return (x, z) => {
    if (!finite(x) || !finite(z)) throw new Error('Terrain base sample requires finite coordinates.');
    const height = baseHeight(recipe, { x, z }, samples, rotations);
    if (!finite(height) || Math.abs(height) > 10000) throw new Error('Terrain base height exceeds world limits.');
    return height;
  };
}

/** Cheap analytic elevation query; use the sampler factory for repeated work. */
export function sampleTerrainBaseHeight(recipe: TerrainRecipe, x: number, z: number): number {
  return createTerrainBaseHeightSampler(recipe)(x, z);
}

type GradedRouteSurface = { route: TerrainRoute; heights: number[]; blend: number };
type GradedFoundation = { placement: TerrainPlacement & { footprint: TerrainFootprint; yaw: number }; target: number; blend: number };
function gradedHeight(original: number, p: TerrainPoint, routes: GradedRouteSurface[], nearby: (ReturnType<typeof nearestRoute> | undefined)[], foundations: GradedFoundation[],
  gradeError: (id: string, message: string, p: TerrainPoint) => void): number {
  let h = original;
  for (let index = 0; index < routes.length; index++) {
    const { route, heights, blend } = routes[index], near = nearby[index];
    if (!route.grade || !near) continue;
    const distance = near.distance - route.width / 2;
    const weight = (distance <= 0 ? 1 : blend ? 1 - smooth(distance / blend) : 0) * (route.grade.strength ?? 1);
    if (weight > 0) {
      const target = heights[near.segment - 1] * (1 - near.t) + heights[near.segment] * near.t;
      const adjusted = h + (target - h) * weight;
      if (Math.abs(adjusted - original) > (route.grade.maxCutFill ?? Infinity) + 1e-6) gradeError(route.id, 'Path grading exceeds its permitted cut/fill budget', p);
      h = adjusted;
    }
  }
  for (const { placement, target, blend } of foundations) {
    const distance = footprintDistance(p, placement.footprint, placement.position, placement.yaw);
    const weight = distance <= 0 ? 1 : blend ? 1 - smooth(distance / blend) : 0;
    if (weight > 0) {
      const adjusted = h + (target - h) * weight;
      if (Math.abs(adjusted - original) > (placement.foundation!.maxCutFill ?? Infinity) + 1e-6) gradeError(placement.id, 'Foundation exceeds its permitted cut/fill budget', p);
      h = adjusted;
    }
  }
  return Math.fround(h);
}

/** Snapshot final ideal ground after ordered road grading and foundations.
 * Uses the mesh compiler's arithmetic, including cut/fill rejection. This is
 * still not sampled triangle support: actual chunks must validate before play.
 * Resolution selects default blend widths; omitted uses nominal host settings. */
export function createTerrainHeightSampler(input: TerrainRecipe, options: { resolution?: number } = {}): (x: number, z: number) => number {
  return createPreparedTerrainHeightSampler(prepareTerrainRecipe(input), options);
}
/** The same sampler from a prepareTerrainRecipe result, for callers that
 * already prepared this exact recipe for its diagnostics. */
export function createPreparedTerrainHeightSampler(checked: Pick<TerrainManifest, 'recipe' | 'diagnostics'>, options: { resolution?: number } = {}): (x: number, z: number) => number {
  if (!checked.diagnostics.valid) throw new Error(`Invalid terrain for height sampling: ${checked.diagnostics.issues.filter(i => i.severity === 'error').map(i => i.code).join(', ')}`);
  const recipe = checked.recipe, stream = terrainUsesStreaming(recipe);
  const config = recipe.streaming || {}, resolution = options.resolution ?? (stream ? (config.chunkSize ?? 128) / (config.cells ?? 16)
    : Math.max(recipe.bounds.width, recipe.bounds.depth) / (recipe.bounds.cells ?? 32));
  if (!positive(resolution)) throw new Error('Terrain height sampler needs a positive finite resolution.');
  const base = createTerrainBaseHeightSampler(recipe), compare = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const channels = resolveTerrainChannels(recipe.channels, base);
  const routes = [...recipe.routes ?? []].sort(compare).map(route => ({ route, blend: route.shoulder ?? resolution,
    heights: route.grade ? route.points.map(p => p.y ?? base(p.x, p.z)) : [], segments: route.points.slice(1).map((p, index) => {
      const a = route.points[index], dx = p.x - a.x, dz = p.z - a.z; return { x: a.x, z: a.z, dx, dz, denominator: dx * dx + dz * dz || 1 };
    }) }));
  const assets = new Map(recipe.assets.map(a => [a.id, a]));
  const foundations = [...recipe.placements ?? [], ...recipe.overrides?.pin ?? []].sort(compare).filter(p => p.foundation).map(p => ({
    placement: { ...p, footprint: scaled(assets.get(p.asset)!.footprint, p.scale ?? 1), yaw: p.yaw ?? terrainFacingYaw(p.facing, p.position, new Map((recipe.routes ?? []).map(r => [r.id, r]))) ?? 0 },
    target: p.foundation!.height ?? base(p.position.x, p.position.z), blend: p.foundation!.blend ?? p.shoulder ?? resolution,
  }));
  return (x, z) => {
    const fail = (id: string, message: string) => { throw new Error(`${id}: ${message}`); };
    const p = { x, z }, h = gradedHeight(carveTerrainChannels(base(x, z), x, z, channels, fail), p, routes, routes.map(r => nearestRoute(p, r.segments)), foundations,
      (id, message) => { throw new Error(`${id}: ${message}`); });
    if (!finite(h) || Math.abs(h) > 10000) throw new Error('Terrain height exceeds world limits.'); return h;
  };
}

/** Exact piecewise-planar Rapier surface, including its b–c diagonal and Float32 samples.
 * Outside queries clamp to the boundary and report inside:false; callers must not treat
 * that extension as collision support. */
export function sampleTerrain(manifest: TerrainManifest, x: number, z: number): { height: number; normal: PhysicsVector; inside: boolean } {
  if (!finite(x) || !finite(z)) throw new Error('Terrain sample coordinates must be finite');
  const { width, depth } = manifest.bounds, rows = manifest.rows, columns = manifest.columns;
  const localX = x - (manifest.origin?.x ?? 0), localZ = z - (manifest.origin?.z ?? 0);
  const inside = Math.abs(localX) <= width / 2 && Math.abs(localZ) <= depth / 2;
  const gx = clamp(localX / width + 0.5) * columns, gz = clamp(localZ / depth + 0.5) * rows;
  const col = Math.min(columns - 1, Math.floor(gx)), row = Math.min(rows - 1, Math.floor(gz)), u = gx - col, v = gz - row;
  const at = (c: number, r: number) => Math.fround(manifest.heights[c * (rows + 1) + r] ?? 0);
  const a = at(col, row), b = at(col + 1, row), c = at(col, row + 1), d = at(col + 1, row + 1);
  const first = u + v <= 1, dx = (first ? b - a : d - c) / (width / columns), dz = (first ? c - a : d - b) / (depth / rows);
  const length = Math.hypot(dx, 1, dz);
  return { height: first ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v),
    normal: { x: -dx / length, y: 1 / length, z: -dz / length }, inside };
}

/** Refuse a failed revision atomically. Gameplay and the view must consume the same manifest. */
export function terrainPhysicsScene(manifest: TerrainManifest, extraColliders: PhysicsCollider[] = []): PhysicsScene {
  if (!manifest.diagnostics.valid) throw new Error(`Terrain revision ${manifest.revision} is invalid: ${manifest.diagnostics.issues.filter(i => i.severity === 'error').map(i => i.code).join(', ')}`);
  if (manifest.colliders.length + extraColliders.length > 96) throw new Error('Terrain and base colliders exceed the 96-collider physics budget');
  return { colliders: JSON.parse(JSON.stringify([...manifest.colliders, ...extraColliders])) as PhysicsCollider[], terrain: { rows: manifest.rows, columns: manifest.columns,
    heights: [...manifest.heights], width: manifest.bounds.width, depth: manifest.bounds.depth } };
}

/** Bounded terrain diagnostics for host inspection; never returns thousands of transforms. */
export function terrainInspection(manifest: TerrainManifest): TerrainInspection {
  const reasons = Object.entries(manifest.diagnostics.excludedBy).sort(([a], [b]) => a < b ? -1 : 1);
  const issues = manifest.diagnostics.issues.slice(0, 12);
  return { version: manifest.version, revision: manifest.revision, valid: manifest.diagnostics.valid,
    counts: manifest.diagnostics.counts, excludedBy: Object.fromEntries(reasons.slice(0, 16).map(([key, value]) => [key.slice(0, 160), value])),
    excludedReasonCount: reasons.length, truncated: reasons.length > 16 || reasons.some(([key]) => key.length > 160)
      || manifest.diagnostics.issues.length > 12 || issues.some(issue => issue.message.length > 240
        || (issue.ids?.length ?? 0) > 3 || issue.ids?.some(id => id.length > 128)),
    sampling: manifest.diagnostics.sampling, issues: issues.map(issue => ({ ...issue, message: issue.message.slice(0, 240), ids: issue.ids?.slice(0, 3).map(id => id.slice(0, 128)) })),
    issueCount: manifest.diagnostics.issues.length,
    changes: { added: manifest.changes.added.length, removed: manifest.changes.removed.length,
      updated: manifest.changes.updated.length, unchanged: manifest.changes.unchanged, surfaceChanged: manifest.changes.surfaceChanged } };
}

/** Compile a serializable recipe. Full bounded evaluation is cheap and deterministic;
 * unchanged candidates retain identity even when a nearby reservation is edited. */
interface TerrainCompileWindow { id: string; minX: number; maxX: number; minZ: number; maxZ: number; cells: number }
export interface TerrainChunkRequest { x: number; z: number; size: number; cells?: number }

export function terrainRecipeRevision(input: TerrainRecipe): string {
  const value = terrainFingerprint(input, true);
  // All four existing revision lanes consume the same recipe. Read its UTF-16
  // characters once, preserving each raw FNV state and final avalanche exactly.
  let a = hashState('0:'), b = hashState('1:'), c = hashState('2:'), d = hashState('3:');
  for (let i = 0; i < value.length; i++) {
    const character = value.charCodeAt(i);
    a = Math.imul(a ^ character, 16777619); b = Math.imul(b ^ character, 16777619);
    c = Math.imul(c ^ character, 16777619); d = Math.imul(d ^ character, 16777619);
  }
  return `terrain-stream-v1:${[a, b, c, d].map(state => hash('', state).toString(16).padStart(8, '0')).join('')}`;
}

/** Generate one spatial window, including only its bounded candidate neighbourhood.
 * Large worlds use local priority spacing so a neighbour cannot depend on a
 * transitive chain of candidates in an unloaded part of the world. */
export function compileTerrainChunk(input: TerrainRecipe, chunk: TerrainChunkRequest, previous?: TerrainManifest): TerrainManifest {
  return compileTerrainInternal(input, previous, terrainChunkWindow(input, chunk));
}

/** Exact chunk identity without regenerating geometry. The caller validates the
 * recipe before using this for dependency-aware reuse of an accepted chunk. */
export function terrainChunkRevision(input: TerrainRecipe, chunk: TerrainChunkRequest): string {
  const value = `${terrainFingerprint(input, true)}:chunk:${canonical(terrainChunkWindow(input, chunk))}`;
  return `${TERRAIN_VERSION}:${[0, 1, 2, 3].map(n => hash(`${n}:${value}`).toString(16).padStart(8, '0')).join('')}`;
}

function terrainChunkWindow(input: TerrainRecipe, chunk: TerrainChunkRequest): TerrainCompileWindow {
  const cells = chunk.cells ?? 32;
  if (!Number.isSafeInteger(chunk.x) || !Number.isSafeInteger(chunk.z) || ![32, 64, 128, 256, 512].includes(chunk.size)
    || !Number.isInteger(cells) || cells < 1 || cells > 32) throw new Error('Terrain chunks require integer coordinates, a power-of-two size from 32 to 512, and 1..32 cells.');
  const minX = Math.max(chunk.x * chunk.size, -input.bounds.width / 2), maxX = Math.min((chunk.x + 1) * chunk.size, input.bounds.width / 2);
  const minZ = Math.max(chunk.z * chunk.size, -input.bounds.depth / 2), maxZ = Math.min((chunk.z + 1) * chunk.size, input.bounds.depth / 2);
  if (![minX, maxX, minZ, maxZ].every(finite) || maxX - minX < .02 || maxZ - minZ < .02) throw new Error('Terrain chunk does not intersect the world bounds.');
  return { id: `${chunk.x}:${chunk.z}`, minX, maxX, minZ, maxZ, cells };
}

/** Validate global metadata and authored conflicts without generating a surface
 * or scatter. Sampled grade/collider checks still run when their chunk loads. */
export function inspectTerrainRecipe(input: TerrainRecipe): TerrainManifest['diagnostics'] {
  return prepareTerrainRecipe(input).diagnostics;
}

/** Share the validated private recipe copy with a stream without cloning and
 * sorting the same global metadata again. No chunk geometry is generated. */
export function prepareTerrainRecipe(input: TerrainRecipe): Pick<TerrainManifest, 'recipe' | 'diagnostics'> {
  const { recipe, diagnostics } = compileTerrainInternal(input, undefined, undefined, true);
  return { recipe, diagnostics };
}

export function compileTerrain(input: TerrainRecipe, previous?: TerrainManifest): TerrainManifest {
  return compileTerrainInternal(input, previous);
}

function compileTerrainInternal(input: TerrainRecipe, previous?: TerrainManifest, window?: TerrainCompileWindow, metadataOnly = false): TerrainManifest {
  const recipe = JSON.parse(JSON.stringify(input)) as TerrainRecipe;
  // Preserve only validator-owned immutable models at their exact occurrence.
  // A forged object sharing a trusted key must still undergo full validation.
  if (Array.isArray(input.assets) && Array.isArray(recipe.assets)) for (let i = 0; i < input.assets.length; i++) {
    const model = input.assets[i]?.model;
    if (model) try { if (validateAssetManifest(model) === model) recipe.assets[i].model = model; } catch { /* Report against the private snapshot below. */ }
  }
  const issues: TerrainIssue[] = [];
  const issue = (code: string, message: string, ids?: string[], position?: TerrainPoint, severity: TerrainIssue['severity'] = 'error') => {
    if (issues.length < 256) issues.push({ severity, code, message, ...(ids ? { ids } : {}), ...(position ? { position } : {}) });
    else if (issues.length === 256) issues.push({ severity: 'error', code: 'issue-budget', message: 'Further terrain issues exceed the diagnostic budget; fix the reported recipe errors first.' });
  };
  const width = positive(recipe.bounds?.width) ? recipe.bounds.width : 1;
  const depth = positive(recipe.bounds?.depth) ? recipe.bounds.depth : 1;
  const requestedCells = recipe.bounds?.cells ?? 32;
  const recipeCells = Number.isInteger(requestedCells) && requestedCells >= 1 && requestedCells <= 32 ? requestedCells : 32;
  const cells = window?.cells ?? recipeCells;
  const surfaceWidth = window ? window.maxX - window.minX : width, surfaceDepth = window ? window.maxZ - window.minZ : depth;
  // Global metadata validation returns diagnostics only. Neither a generated
  // surface nor its revision exists yet, so avoid computing discarded hashes
  // and sample buffers while retaining the same complete validation sequence.
  const recipeFingerprint = metadataOnly ? '' : terrainFingerprint(recipe);
  const surfaceFingerprint = window ? `${recipeFingerprint}:chunk:${canonical(window)}` : recipeFingerprint;
  const manifest: TerrainManifest = {
    version: TERRAIN_VERSION, revision: metadataOnly ? '' : `${TERRAIN_VERSION}:${[0, 1, 2, 3].map(n => hash(`${n}:${surfaceFingerprint}`).toString(16).padStart(8, '0')).join('')}`,
    recipe, bounds: { width: surfaceWidth, depth: surfaceDepth }, ...(window ? { origin: { x: (window.minX + window.maxX) / 2, z: (window.minZ + window.maxZ) / 2 } } : {}), rows: cells, columns: cells,
    heights: metadataOnly ? [] : Array((cells + 1) ** 2).fill(0), colors: metadataOnly ? [] : Array((cells + 1) ** 2).fill(0x697c48), instances: [], colliders: [],
    diagnostics: { valid: true, issues, counts: { candidates: 0, instances: 0, colliders: 0, excluded: 0 }, excludedBy: {},
      sampling: { cellWidth: surfaceWidth / cells, cellDepth: surfaceDepth / cells, surface: 'heightfield-y-up', navigation: 'unsupported' } },
    changes: { added: [], removed: [], updated: [], unchanged: 0, surfaceChanged: true },
  };
  function finish(): TerrainManifest {
    manifest.diagnostics.valid = !issues.some(i => i.severity === 'error');
    manifest.diagnostics.counts.instances = manifest.instances.length;
    manifest.diagnostics.counts.colliders = manifest.colliders.length;
    const before = new Map(previous?.instances.map(i => [i.id, i]) ?? []);
    for (const instance of manifest.instances) {
      const old = before.get(instance.id);
      if (!old) manifest.changes.added.push(instance.id);
      else if (canonical(old) === canonical(instance)) manifest.changes.unchanged++;
      else manifest.changes.updated.push(instance.id);
      before.delete(instance.id);
    }
    manifest.changes.removed = [...before.keys()].sort();
    manifest.changes.surfaceChanged = !previous || canonical([manifest.bounds, manifest.rows, manifest.heights]) !== canonical([previous.bounds, previous.rows, previous.heights]);
    return manifest;
  }
  if (recipe.version !== 1) issue('recipe-version', 'Expected terrain recipe version 1');
  if (!Number.isInteger(recipe.seed) || recipe.seed < 0 || recipe.seed > 0xffffffff) issue('seed', 'Seed must be an unsigned 32-bit integer');
  const worldLimit = window || metadataOnly ? 20000 : 1000;
  if (!positive(recipe.bounds?.width) || !positive(recipe.bounds?.depth) || width < 0.02 || depth < 0.02 || width > worldLimit || depth > worldLimit) issue('bounds', `Terrain width and depth must be from 0.02 to ${worldLimit} metres`);
  if (recipeCells !== requestedCells) issue('heightfield-budget', 'Heightfield cells must be an integer from 1 to 32');
  if (!Array.isArray(recipe.assets) || !Array.isArray(recipe.regions)) { issue('recipe-shape', 'Terrain assets and regions must be arrays'); return finish(); }
  for (const error of terrainChannelIssues(recipe.channels, { width, depth })) issue(error.code, error.message, error.ids);
  if (recipe.reservations !== undefined && (!Array.isArray(recipe.reservations) || recipe.reservations.length > 128)) {
    issue('reservation-budget', 'Scatter reservations must be an array of at most 128 entries'); return finish();
  }
  if (recipe.assets.length > 64 || recipe.regions.length > 32 || (recipe.routes?.length ?? 0) > 64
    || (recipe.placements?.length ?? 0) + (recipe.overrides?.pin?.length ?? 0) > 96) { issue('recipe-budget', 'Maximum 64 assets, 32 regions, 64 routes, and 96 placements/pins'); return finish(); }
  const unique = (values: { id: string }[], group: string) => {
    const used = new Set<string>();
    for (const item of values) {
      if (typeof item.id !== 'string' || !item.id.length || item.id.length > 128 || used.has(item.id)) issue('identifier', `${group} IDs must be nonempty, unique, and at most 128 characters`, [String(item.id)]);
      used.add(item.id);
    }
  };
  const nonnegative = (n: unknown) => n === undefined || finite(n) && n >= 0;
  const footprintOkay = (f: TerrainFootprint | undefined) => !!f && (f.kind === 'circle' ? positive(f.radius) : f.kind === 'box' && positive(f.width) && positive(f.depth));
  unique(recipe.assets, 'Asset'); unique(recipe.regions, 'Region'); unique(recipe.routes ?? [], 'Route');
  unique([...(recipe.placements ?? []), ...(recipe.overrides?.pin ?? [])], 'Placement/pin');
  const assets = new Map(recipe.assets.map(asset => [asset.id, asset]));
  const routeMap = new Map((recipe.routes ?? []).map(route => [route.id, route]));
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const boundedPoint = (p: unknown) => record(p) && Object.keys(p).every(key => key === 'x' || key === 'z')
    && finite(p.x) && finite(p.z) && Math.abs(p.x) <= 10000 && Math.abs(p.z) <= 10000;
  const targetOkay = (value: unknown, facing: boolean): boolean => {
    if (!record(value)) return false;
    const kinds = ['point', 'route', ...(facing ? ['side'] : [])].filter(key => Object.hasOwn(value, key));
    if (kinds.length !== 1 || Object.keys(value).some(key => ![...kinds, ...(facing ? ['along', 'offset'] : [])].includes(key))) return false;
    if (value.point !== undefined && !boundedPoint(value.point) || value.route !== undefined && (typeof value.route !== 'string' || !routeMap.has(value.route))
      || value.side !== undefined && !['north', 'south', 'east', 'west'].includes(value.side as string)
      || value.along !== undefined && (kinds[0] !== 'route' || typeof value.along !== 'boolean')
      || value.offset !== undefined && (!finite(value.offset) || Math.abs(value.offset) > Math.PI * 2)) return false;
    return value[kinds[0]] !== null && value[kinds[0]] !== undefined;
  };
  const validateFacing = (value: TerrainFacing | undefined, ids: string[]) => {
    if (value !== undefined && !targetOkay(value, true)) issue('facing', 'Facing requires one bounded point, cardinal side, or known route, optional along boolean for routes, and an offset within ±2π', ids);
  };
  if (recipe.reservations?.some(reservation => !record(reservation))) issue('reservation', 'Each scatter reservation requires a valid object');
  else {
    unique(recipe.reservations ?? [], 'Scatter reservation');
    for (const reservation of recipe.reservations ?? []) {
      const mask = reservation.mask;
      if (!footprintOkay(mask) || !boundedPoint(mask?.center)
        || mask.kind === 'circle' && mask.radius > 10000 || mask.kind === 'box' && (mask.width > 20000 || mask.depth > 20000)
        || mask.yaw !== undefined && (!finite(mask.yaw) || Math.abs(mask.yaw) > Math.PI * 2)
        || !nonnegative(reservation.clearance) || (reservation.clearance ?? 0) > 20000
        || !nonnegative(reservation.shoulder) || (reservation.shoulder ?? 0) > 20000)
        issue('reservation', 'Scatter reservations need a bounded mask, finite yaw within ±2π, and clearance/shoulder from 0 to 20000m', [reservation.id]);
    }
  }
  for (const message of terrainEnvironmentErrors(recipe.environment, 'world')) issue('environment', message);
  const validateMaterial = (value: SurfaceMaterialInput | undefined, ids?: string[]) => {
    if (value !== undefined) try { validateSurfaceMaterialInput(value); }
    catch (error) { issue('surface-material', error instanceof Error ? error.message : 'Invalid surface material', ids); }
  };
  validateMaterial(recipe.material);
  for (const asset of recipe.assets) {
    validateMaterial(asset.material, [asset.id]);
    for (const message of terrainEnvironmentErrors(asset.environment, 'asset')) issue('asset-environment', message, [asset.id]);
    if (!footprintOkay(asset.footprint)) issue('asset-footprint', 'Asset requires a positive circle or box footprint', [asset.id]);
    if (asset.model !== undefined) {
      if (asset.collider !== undefined) issue('asset-model', 'A model supplies compound collision and cannot also declare a legacy collider', [asset.id]);
      try { asset.model = validateAssetManifest(asset.model); }
      catch (error) { issue('asset-model', error instanceof Error ? error.message : 'Invalid asset model', [asset.id]); }
    }
    const collider = asset.collider;
    if (collider) {
      const s = collider.shape;
      if (!finite(collider.offsetY) || !s || (s.kind === 'box' ? !positive(s.halfExtents?.x) || !positive(s.halfExtents?.y) || !positive(s.halfExtents?.z)
        : s.kind === 'ball' ? !positive(s.radius) : s.kind === 'capsule' ? !positive(s.radius) || !finite(s.halfHeight) || s.halfHeight < 0 : !validConvexShape(s))
        || collider.friction !== undefined && (!finite(collider.friction) || collider.friction < 0 || collider.friction > 2)) issue('asset-collider', 'Collider dimensions and offset must be finite and valid', [asset.id]);
    }
  }
  if (recipe.base?.height !== undefined && (!finite(recipe.base.height) || Math.abs(recipe.base.height) > 10000)) issue('height', 'Base height must be finite and within ±10000m');
  const n = recipe.base?.noise;
  if (n && (!nonnegative(n.amplitude) || n.amplitude > 10000 || !positive(n.wavelength) || n.wavelength < 0.001
    || !Number.isInteger(n.octaves ?? 3) || (n.octaves ?? 3) < 1 || (n.octaves ?? 3) > 6)) issue('noise', 'Noise requires amplitude from 0–10000m, wavelength at least 0.001m, and 1–6 octaves');
  for (const region of recipe.regions) {
    validateMaterial(region.material, [region.id]);
    for (const message of terrainEnvironmentErrors(region.environment, 'region')) issue('region-environment', message, [region.id]);
    if (!footprintOkay(region.mask) || !pointOkay(region.mask?.center) || !nonnegative(region.blend)
      || region.mask.yaw !== undefined && !finite(region.mask.yaw) || region.elevation !== undefined && !finite(region.elevation)) issue('region', 'Region requires a valid mask, finite elevation/yaw, and nonnegative blend', [region.id]);
    if (!Array.isArray(region.layers) || region.layers.length > 16) { issue('layer-budget', 'Each region supports at most 16 scatter layers', [region.id]); continue; }
    unique(region.layers, `Layer in ${region.id}`);
    for (const layer of region.layers) {
      validateFacing(layer.facing, [region.id, layer.id]);
      if (layer.preferences !== undefined && (!Array.isArray(layer.preferences) || layer.preferences.length > 8
        || layer.preferences.some(preference => !record(preference) || Object.keys(preference).some(key => !['target', 'mode', 'range', 'weight'].includes(key))
          || !targetOkay(preference.target, false) || !['near', 'away'].includes(preference.mode as string)
          || !positive(preference.range) || preference.range > 20000 || !finite(preference.weight) || preference.weight < 0 || preference.weight > 100)))
        issue('placement-preferences', 'Use at most eight near/away preferences with bounded point/known route targets, ranges in (0,20000], and weights from 0 to 100', [region.id, layer.id]);
      if (!positive(layer.spacing) || !finite(layer.density) || layer.density < 0 || layer.density > 1 || !Array.isArray(layer.assets)
        || !layer.assets.length || layer.assets.some(id => !assets.has(id)) || layer.scale && (!positive(layer.scale[0]) || !positive(layer.scale[1]) || layer.scale[1] < layer.scale[0])
        || layer.seed !== undefined && (!Number.isInteger(layer.seed) || layer.seed < 0 || layer.seed > 0xffffffff)
        || !nonnegative(layer.maxSlope) || layer.elevation && (!finite(layer.elevation[0]) || !finite(layer.elevation[1]) || layer.elevation[1] < layer.elevation[0])) issue('scatter-layer', 'Scatter layer requires valid assets, spacing, density, scale, slope and elevation range', [region.id, layer.id]);
    }
  }
  const validatePath = (route: { id: string; points: TerrainPoint[]; width: number; clearance?: number; shoulder?: number }) => {
    if (!Array.isArray(route.points) || route.points.length < 2 || route.points.length > 64 || !Array.from(route.points).every(pointOkay)
      || !positive(route.width) || !nonnegative(route.clearance) || !nonnegative(route.shoulder)) issue('route', 'Route requires 2–64 finite points, positive width, and nonnegative clearance/shoulder', [route.id]);
    else {
      for (const p of route.points) if (Math.abs(p.x) > width / 2 || Math.abs(p.z) > depth / 2) issue('route-bounds', 'Route control points must lie inside the heightfield', [route.id], p);
      for (let i = 1; i < route.points.length; i++) if (Math.hypot(route.points[i].x - route.points[i - 1].x, route.points[i].z - route.points[i - 1].z) < 0.00001) issue('route-segment', 'Consecutive route points must be distinct', [route.id], route.points[i]);
    }
  };
  for (const route of recipe.routes ?? []) {
    validateMaterial(route.material, [route.id]);
    validatePath(route);
    if (Array.isArray(route.points) && route.points.some(p => p && p.y !== undefined && (!finite(p.y) || Math.abs(p.y) > 10000))) issue('route-height', 'Explicit route grading heights must be finite and within ±10000m.', [route.id]);
    if (route.allowPlacements !== undefined && typeof route.allowPlacements !== 'boolean') issue('route-placement-policy', 'Route allowPlacements must be a boolean', [route.id]);
    if (route.grade && (!nonnegative(route.grade.maxCutFill) || !nonnegative(route.grade.maxSlope) || !finite(route.grade.strength ?? 1) || (route.grade.strength ?? 1) < 0 || (route.grade.strength ?? 1) > 1)) issue('route-grade', 'Grade strength must be 0–1 and budgets nonnegative', [route.id]);
  }
  const authored = [...(recipe.placements ?? []).map(p => ({ ...p, kind: 'placement' as const })), ...(recipe.overrides?.pin ?? []).map(p => ({ ...p, kind: 'pin' as const }))];
  for (const p of authored) {
    validateFacing(p.facing, [p.id]);
    if (p.foundationGroup !== undefined && (typeof p.foundationGroup !== 'string' || !p.foundationGroup.length || p.foundationGroup.length > 128))
      issue('foundation-group', 'Foundation group must be a nonempty string of at most128 characters', [p.id]);
    if (!assets.has(p.asset) || !pointOkay(p.position) || p.position.y !== undefined && !finite(p.position.y)
      || p.yaw !== undefined && !finite(p.yaw) || !positive(p.scale ?? 1) || !nonnegative(p.clearance) || !nonnegative(p.shoulder)
      || p.foundation && (!nonnegative(p.foundation.blend) || !nonnegative(p.foundation.maxCutFill) || p.foundation.height !== undefined && !finite(p.foundation.height))) issue('placement', 'Placement requires an existing asset, finite transform, and nonnegative clearance/foundation budgets', [p.id]);
    if ((p.entrances?.length ?? 0) > 8) issue('entrance-budget', 'At most 8 entrances per placement', [p.id]);
    for (const entrance of p.entrances ?? []) validatePath(entrance);
  }
  const limits = { instances: recipe.budgets?.instances ?? 2048, candidates: recipe.budgets?.candidates ?? 12000, colliders: recipe.budgets?.colliders ?? 96 };
  for (const [key, max] of [['instances', 4096], ['candidates', 24000], ['colliders', 96]] as const) if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max) issue('budget', `${key} budget must be an integer from 1 to ${max}`);
  if (issues.some(i => i.severity === 'error')) return finish();
  for (const asset of recipe.assets) if (asset.model) {
    const bounds = asset.model.bounds, halfX = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)), halfZ = Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z));
    const contained = asset.footprint.kind === 'circle' ? Math.hypot(halfX, halfZ) <= asset.footprint.radius + 1e-8
      : halfX <= asset.footprint.width / 2 + 1e-8 && halfZ <= asset.footprint.depth / 2 + 1e-8;
    if (!contained) issue('model-footprint', 'The complete model bounds must fit its conservative placement footprint', [asset.id]);
  }
  for (const asset of recipe.assets) if (asset.collider) {
    const shape = asset.collider.shape;
    const bounds = physicsShapeBounds(shape);
    const halfX = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x));
    const halfZ = Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z));
    const contained = asset.footprint.kind === 'circle'
      ? (shape.kind === 'box' || shape.kind === 'convex' ? Math.hypot(halfX, halfZ) : shape.radius) <= asset.footprint.radius + 1e-8
      : halfX <= asset.footprint.width / 2 + 1e-8 && halfZ <= asset.footprint.depth / 2 + 1e-8;
    if (!contained) issue('collider-footprint', 'Blocking collider extends outside its declared placement footprint; enlarge the footprint so routes reserve the full obstacle', [asset.id]);
  }
  if (issues.some(i => i.severity === 'error')) return finish();
  // Canonical ordering resolves blends and equal-distance decisions independently of authoring array order.
  const compare = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  recipe.regions.sort(compare);
  try { if (recipe.channels?.length) manifest.channels = resolveTerrainChannels(recipe.channels, createTerrainBaseHeightSampler(recipe)); }
  catch (error) { issue('channel-grade', String(error)); return finish(); }
  const channels = manifest.channels ?? [];
  const routes = [...(recipe.routes ?? [])].sort(compare), placements = authored.sort(compare);
  const reservations = [...recipe.reservations ?? []].sort(compare).map(reservation => ({ ...reservation,
    footprint: reservation.mask, position: reservation.mask.center, yaw: reservation.mask.yaw ?? 0 }));
  const placementShapes = placements.map(p => {
    const facing = p.yaw === undefined ? terrainFacingYaw(p.facing, p.position, routeMap) : undefined;
    if (p.facing && p.yaw === undefined && facing === undefined) issue('facing-direction', 'The placement coincides with its facing target; provide an explicit yaw or a different target', [p.id], p.position);
    return { ...p, footprint: scaled(assets.get(p.asset)!.footprint, p.scale ?? 1), yaw: p.yaw ?? facing ?? 0 };
  });
  const insideFootprint = (p: Footed) => p.footprint.kind === 'circle'
    ? Math.abs(p.position.x) + p.footprint.radius <= width / 2 && Math.abs(p.position.z) + p.footprint.radius <= depth / 2
    : corners(p.footprint, p.position, p.yaw).every(v => Math.abs(v.x) <= width / 2 && Math.abs(v.z) <= depth / 2);
  for (let i = 0; i < placementShapes.length; i++) {
    const a = placementShapes[i];
    if (!insideFootprint(a)) issue('placement-bounds', 'Protected placement footprint extends outside the heightfield', [a.id], a.position);
    for (let j = i + 1; j < placementShapes.length; j++) if (!(a.foundationGroup && a.foundationGroup === placementShapes[j].foundationGroup)
      && footprintGap(a, placementShapes[j]) <= 0) issue('protected-overlap', 'Protected placement footprints overlap; neither has been moved or deleted', [a.id, placementShapes[j].id], a.position);
    for (const route of routes) if (!route.allowPlacements && routeGap(a, route.points) < route.width / 2) issue('placement-route-overlap', 'A route crosses a protected placement footprint', [a.id, route.id], a.position);
    for (const channel of channels) if (!channel.allowPlacements && channel.points.slice(1).some((p, index) => {
      const before = channel.points[index], reach = Math.max(p.width / 2 + p.bankWidth, before.width / 2 + before.bankWidth) + channel.clearance;
      return routeGap(a, [before, p]) < reach;
    })) issue('placement-channel-overlap', 'A channel crosses a protected placement footprint; move it or explicitly authorize an elevated bridge.', [a.id, channel.id], a.position);
  }
  if (metadataOnly) return finish();
  const reportedGrades = new Set<string>();
  const gradeError = (id: string, message: string, p: TerrainPoint) => { if (!reportedGrades.has(id)) { reportedGrades.add(id); issue('grade-budget', message, [id], p); } };
  const resolution = Math.max(surfaceWidth / cells, surfaceDepth / cells);
  const noiseSamples = new Map<string, number>();
  const regionRotations = recipe.regions.map(region => ({ c: Math.cos(region.mask.yaw ?? 0), s: Math.sin(region.mask.yaw ?? 0) }));
  // These recipe values are invariant across every heightfield sample. Keep the
  // original arithmetic and route order, including equal-distance tie breaking.
  const routeSurfaces = routes.map(route => {
    const margin = route.width / 2 + (route.shoulder || resolution) + 1e-9;
    return { route, tint: color(route.color, 0x9c8560), blend: route.shoulder ?? resolution,
      minX: Math.min(...route.points.map(p => p.x)) - margin, maxX: Math.max(...route.points.map(p => p.x)) + margin,
      minZ: Math.min(...route.points.map(p => p.z)) - margin, maxZ: Math.max(...route.points.map(p => p.z)) + margin,
      heights: route.grade ? route.points.map(p => p.y ?? baseHeight(recipe, p, noiseSamples, regionRotations)) : [],
      segments: route.points.slice(1).map((p, index) => {
        const a = route.points[index], dx = p.x - a.x, dz = p.z - a.z;
        return { x: a.x, z: a.z, dx, dz, denominator: dx * dx + dz * dz || 1 };
      }) };
  });
  const foundations = placementShapes.filter(placement => placement.foundation).map(placement => ({ placement,
    target: placement.foundation!.height ?? baseHeight(recipe, placement.position, noiseSamples, regionRotations),
    blend: placement.foundation!.blend ?? placement.shoulder ?? resolution }));
  const regionColors = recipe.regions.map(region => color(region.color, -1));
  const finalHeight = (p: TerrainPoint, nearby: (ReturnType<typeof nearestRoute> | undefined)[], weights: number[]): number => {
    const original = baseHeight(recipe, p, noiseSamples, regionRotations, weights);
    return gradedHeight(carveTerrainChannels(original, p.x, p.z, channels, gradeError), p, routeSurfaces, nearby, foundations, gradeError);
  };
  for (let col = 0; col <= cells; col++) for (let row = 0; row <= cells; row++) {
    const p = window ? { x: window.minX + col / cells * surfaceWidth, z: window.minZ + row / cells * surfaceDepth }
      : { x: (col / cells - 0.5) * width, z: (row / cells - 0.5) * depth }, index = col * (cells + 1) + row;
    // A conservative bound skips only routes whose blend is exactly zero.
    const nearby = routeSurfaces.map(route => p.x < route.minX || p.x > route.maxX || p.z < route.minZ || p.z > route.maxZ
      ? undefined : nearestRoute(p, route.segments));
    // Height and tint use the same region weights at this exact grid point.
    // Still perform every elevation multiply/add, including zero elevations.
    const weights = recipe.regions.map((region, i) => maskWeight(region.mask, p, region.blend ?? 0, regionRotations[i]));
    manifest.heights[index] = finalHeight(p, nearby, weights);
    if (!finite(manifest.heights[index]) || Math.abs(manifest.heights[index]) > 10000) gradeError('surface', 'Terrain height exceeds the finite ±10000m physics coordinate budget', p);
    let tint = 0x697c48;
    for (let i = 0; i < recipe.regions.length; i++) {
      tint = mixColor(tint, regionColors[i] < 0 ? tint : regionColors[i], weights[i]);
    }
    for (const channel of channels) {
      const b = channel.bounds;
      if (p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ)
        tint = mixColor(tint, color(channel.color, channel.kind === 'river' ? 0x81715a : 0x777777), sampleTerrainChannel(channel, p.x, p.z).weight);
    }
    for (let i = 0; i < routeSurfaces.length; i++) {
      const near = nearby[i];
      if (!near) continue;
      const { route, tint: routeTint } = routeSurfaces[i], distance = near.distance - route.width / 2;
      tint = mixColor(tint, routeTint, distance <= 0 ? 1 : 1 - smooth(distance / (route.shoulder || resolution)));
    }
    manifest.colors[index] = tint;
  }
  // Validate actual sampled geometry, not only the ideal procedural function.
  for (const channel of channels) if (Math.min(...channel.points.map(p => p.width)) < resolution * 2)
    issue('channel-resolution', `Channel bed is narrower than two ${resolution.toFixed(2)}m terrain cells; reduce chunk size or widen the channel for reliable banks.`, [channel.id], channel.points[0], 'warning');
  for (const route of routes) {
    const resolution = Math.max(surfaceWidth / cells, surfaceDepth / cells);
    if (route.width < resolution) issue('route-resolution', `Route width ${route.width.toFixed(2)}m is narrower than the ${resolution.toFixed(2)}m heightfield cell; increase width or reduce world bounds`, [route.id], route.points[0], 'warning');
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i], length = Math.hypot(b.x - a.x, b.z - a.z);
      let enter = 0, leave = 1;
      if (window) for (const [start, delta, min, max] of [[a.x, b.x - a.x, window.minX, window.maxX], [a.z, b.z - a.z, window.minZ, window.maxZ]]) {
        if (!delta) { if (start < min || start > max) leave = -1; continue; }
        const first = (min - start) / delta, last = (max - start) / delta;
        enter = Math.max(enter, Math.min(first, last)); leave = Math.min(leave, Math.max(first, last));
      }
      if (enter > leave) continue;
      const steps = Math.max(1, Math.ceil(length * (leave - enter) / Math.min(surfaceWidth / cells, surfaceDepth / cells) * 4));
      if (steps > 1024) { issue('route-sample-budget', 'Route validation requires too many samples for this heightfield aspect ratio', [route.id], a); break; }
      for (let step = 0; step <= steps; step++) {
        const t = window ? enter + (leave - enter) * step / steps : step / steps;
        const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, sample = sampleTerrain(manifest, p.x, p.z);
        if (!sample.inside) { if (window) continue; issue('route-bounds', 'Route leaves the sampled heightfield', [route.id], p); break; }
        if (route.grade?.maxSlope !== undefined && Math.hypot(sample.normal.x, sample.normal.z) / sample.normal.y > route.grade.maxSlope + 1e-6) { gradeError(route.id, 'The sampled route surface exceeds its permitted rise/run slope', p); break; }
      }
    }
  }
  for (const p of placementShapes) if (p.foundation) {
    if (window && !sampleTerrain(manifest, p.position.x, p.position.z).inside) continue;
    const target = p.foundation.height ?? baseHeight(recipe, p.position, noiseSamples, regionRotations);
    const shape = p.footprint;
    const probes = shape.kind === 'box' ? corners(shape, p.position, p.yaw) : [0, 1, 2, 3].map(i => ({ x: p.position.x + Math.cos(i * Math.PI / 2) * shape.radius, z: p.position.z + Math.sin(i * Math.PI / 2) * shape.radius }));
    const worst = [p.position, ...probes].reduce((n, probe) => {
      const sample = sampleTerrain(manifest, probe.x, probe.z);
      return window && !sample.inside ? n : Math.max(n, Math.abs(sample.height - target));
    }, 0);
    if (worst > 0.12) issue('foundation-resolution', `Sampled foundation differs from its requested level by ${worst.toFixed(2)}m; widen its blend or increase heightfield resolution`, [p.id], p.position, 'warning');
  }
  const excluded = (id: string) => { manifest.diagnostics.counts.excluded++; manifest.diagnostics.excludedBy[id] = (manifest.diagnostics.excludedBy[id] ?? 0) + 1; };
  const candidates: (TerrainInstance & { priority: number; layer: TerrainScatterLayer; randomKey: string })[] = [];
  const halo = window ? recipe.regions.reduce((max, region) => region.layers.reduce((max, layer) => Math.max(max,
    ...layer.assets.map(id => radius(assets.get(id)!.footprint) * (layer.scale?.[1] ?? 1) * 2)), max), 0) : 0;
  if (!finite(halo) || window && halo > 1000) { issue('chunk-halo-budget', 'Scatter footprint neighbourhood exceeds the 1000m chunk generation bound'); return finish(); }
  for (let regionIndex = 0; regionIndex < recipe.regions.length; regionIndex++) for (const layer of [...recipe.regions[regionIndex].layers].sort(compare)) {
    const region = recipe.regions[regionIndex], rotation = regionRotations[regionIndex];
    const gridColumns = Math.ceil(width / layer.spacing), gridRows = Math.ceil(depth / layer.spacing);
    const minCol = window ? Math.max(0, Math.floor((window.minX - halo + width / 2) / layer.spacing)) : 0;
    const maxCol = window ? Math.min(gridColumns, Math.ceil((window.maxX + halo + width / 2) / layer.spacing)) : gridColumns;
    const minRow = window ? Math.max(0, Math.floor((window.minZ - halo + depth / 2) / layer.spacing)) : 0;
    const maxRow = window ? Math.min(gridRows, Math.ceil((window.maxZ + halo + depth / 2) / layer.spacing)) : gridRows;
    if (manifest.diagnostics.counts.candidates + (maxCol - minCol) * (maxRow - minRow) > limits.candidates) { issue('candidate-budget', `Scatter candidates exceed the ${limits.candidates} budget; increase spacing or narrow the generated bounds`, [region.id, layer.id]); return finish(); }
    const keyPrefix = `${recipe.seed}:${keyPart(region.id)}:${keyPart(layer.id)}:${layer.seed ?? 0}:`;
    // Retain the raw signed FNV state, before the final avalanche. Each suffix
    // continues the exact same character stream as hashing the complete key.
    const layerHash = hashState(keyPrefix);
    const idPrefix = `scatter:${instanceLabel(region.id)}:${instanceLabel(layer.id)}:`, scaleRange = layer.scale ?? [1, 1];
    for (let col = minCol; col < maxCol; col++) for (let row = minRow; row < maxRow; row++) {
      manifest.diagnostics.counts.candidates++;
      const candidate = `${col}:${row}`, key = keyPrefix + candidate;
      const candidateHash = hashState(candidate, layerHash);
      const p = { x: -width / 2 + (col + 0.1 + random(':x', candidateHash) * 0.8) * layer.spacing, z: -depth / 2 + (row + 0.1 + random(':z', candidateHash) * 0.8) * layer.spacing };
      if (random(':density', candidateHash) >= layer.density * maskWeight(region.mask, p, region.blend ?? 0, rotation)) continue;
      const asset = assets.get(layer.assets[Math.floor(random(':asset', candidateHash) * layer.assets.length)])!;
      const scale = scaleRange[0] + random(':scale', candidateHash) * (scaleRange[1] - scaleRange[0]);
      const instance = { id: idPrefix + candidate, asset: asset.id, position: { ...p, y: 0 }, yaw: terrainFacingYaw(layer.facing, p, routeMap) ?? random(':yaw', candidateHash) * Math.PI * 2,
        scale, footprint: scaled(asset.footprint, scale), source: { kind: 'scatter' as const, region: region.id, layer: layer.id, candidate }, priority: hash(':priority', candidateHash), layer, randomKey: key };
      if (insideFootprint(instance)) candidates.push(instance);
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || compare(a, b));
  // Space immutable candidates BEFORE applying editable reservations. Clearing a path
  // cannot reshuffle neighbouring trees through a chain of greedy replacements.
  const spacing: TerrainInstance[] = [], buckets = new Map<string, TerrainInstance[]>();
  const spacingArea = window ? (surfaceWidth + halo * 2) * (surfaceDepth + halo * 2) : width * depth;
  const cellSize = candidates.reduce((size, candidate) => Math.max(size, radius(candidate.footprint) * 2), Math.max(0.000001, Math.sqrt(spacingArea / Math.max(1, candidates.length))));
  const bucketKeys = (p: Footed) => {
    const r = radius(p.footprint), keys: string[] = [];
    for (let x = Math.floor((p.position.x - r) / cellSize); x <= Math.floor((p.position.x + r) / cellSize); x++)
      for (let z = Math.floor((p.position.z - r) / cellSize); z <= Math.floor((p.position.z + r) / cellSize); z++) keys.push(`${x}:${z}`);
    return keys;
  };
  for (const candidate of candidates) {
    const keys = bucketKeys(candidate), neighbours = new Set(keys.flatMap(key => buckets.get(key) ?? []));
    const overlaps = [...neighbours].some(other => footprintGap(candidate, other) <= 0);
    if (!overlaps) spacing.push(candidate);
    // Streaming spacing compares all earlier priorities, even ones suppressed
    // by another neighbour. Its finite dependency radius is independent of load order.
    if (overlaps && !window) continue;
    for (const key of keys) { const bucket = buckets.get(key) ?? []; bucket.push(candidate); buckets.set(key, bucket); }
  }
  const removals = new Set(recipe.overrides?.remove ?? []), pinnedIds = new Set((recipe.overrides?.pin ?? []).map(p => p.id));
  const corridors = [...routes.map(route => ({ ...route, reservationId: `route:${route.id}` })), ...placements.flatMap(p => (p.entrances ?? []).map(e => ({ ...e, shoulder: p.shoulder, reservationId: `entrance:${p.id}:${e.id}` })))];
  for (const generic of spacing) {
    const candidate = generic as typeof candidates[number];
    if (window && (candidate.position.x < window.minX || candidate.position.x >= window.maxX
      || candidate.position.z < window.minZ || candidate.position.z >= window.maxZ)) continue;
    if (removals.has(candidate.id) || pinnedIds.has(candidate.id)) { excluded('override'); continue; }
    const preferences = candidate.layer.preferences;
    if (preferences?.length) {
      let score = 0, total = 0;
      for (const preference of preferences) {
        if (!preference.weight) continue;
        const near = 'point' in preference.target ? nearScore(candidate.position, preference.target.point, preference.range)
          : 1 - Math.min(1, nearestSpatialRoute(candidate.position, routeMap.get(preference.target.route)!.points)!.distance / preference.range);
        score += preference.weight * (preference.mode === 'near' ? near : 1 - near); total += preference.weight;
      }
      if (total && random(`${candidate.randomKey}:preferences`) >= spatialCoordinate(score / total)) {
        excluded(`preferences:${candidate.source.region}:${candidate.source.layer}`); continue;
      }
    }
    let blocked = false;
    for (const reservation of reservations) {
      const d = footprintGap(candidate, reservation) - (reservation.clearance ?? 0);
      const weight = d <= 0 ? 0 : reservation.shoulder ? smooth(d / reservation.shoulder) : 1;
      if (weight === 0 || weight < 1 && random(`${candidate.randomKey}:scatter-reservation:${reservation.id}`) >= weight) {
        excluded(`reservation:${reservation.id}`); blocked = true; break;
      }
    }
    if (blocked) continue;
    for (const channel of channels) {
      // Conservative full-footprint reservation: a tree cannot lean across a
      // narrow bank merely because its centre lies outside the wet bed.
      if (channel.points.slice(1).some((p, index) => {
        const before = channel.points[index], reach = Math.max(p.width / 2 + p.bankWidth, before.width / 2 + before.bankWidth) + channel.clearance;
        return routeGap(candidate, [before, p]) < reach;
      })) { excluded(`channel:${channel.id}`); blocked = true; break; }
    }
    if (blocked) continue;
    for (const route of corridors) {
      const d = routeGap(candidate, route.points) - route.width / 2 - (route.clearance ?? 0);
      const weight = d <= 0 ? 0 : route.shoulder ? smooth(d / route.shoulder) : 1;
      if (weight === 0 || weight < 1 && random(`${candidate.randomKey}:reservation:${route.reservationId}`) >= weight) { excluded(route.reservationId); blocked = true; break; }
    }
    if (blocked) continue;
    for (const p of placementShapes) {
      const d = footprintGap(candidate, p) - (p.clearance ?? 0);
      const weight = d <= 0 ? 0 : p.shoulder ? smooth(d / p.shoulder) : 1;
      if (weight === 0 || weight < 1 && random(`${candidate.randomKey}:placement:${p.id}`) >= weight) { excluded(`placement:${p.id}`); blocked = true; break; }
    }
    if (blocked) continue;
    const sampled = sampleTerrain(manifest, candidate.position.x, candidate.position.z);
    if (candidate.layer.maxSlope !== undefined && Math.hypot(sampled.normal.x, sampled.normal.z) / sampled.normal.y > candidate.layer.maxSlope
      || candidate.layer.elevation && (sampled.height < candidate.layer.elevation[0] || sampled.height > candidate.layer.elevation[1])) { excluded(`filter:${candidate.source.region}:${candidate.source.layer}`); continue; }
    const { priority: _priority, layer: _layer, randomKey: _randomKey, ...instance } = candidate;
    instance.position.y = sampled.height;
    manifest.instances.push(instance);
  }
  for (const p of placementShapes) {
    if (window && (p.position.x < window.minX || p.position.x >= window.maxX || p.position.z < window.minZ || p.position.z >= window.maxZ)) continue;
    manifest.instances.push({ id: p.id, asset: p.asset,
    position: { x: p.position.x, y: p.position.y ?? sampleTerrain(manifest, p.position.x, p.position.z).height, z: p.position.z },
    yaw: p.yaw, scale: p.scale ?? 1, source: { kind: p.kind }, footprint: p.footprint });
  }
  manifest.instances.sort(compare);
  unique(manifest.instances, 'Instance');
  if (manifest.instances.length > limits.instances) issue('instance-budget', `Generated ${manifest.instances.length} instances, exceeding the ${limits.instances} budget; reduce density or reserve a smaller region`);
  if (recipe.assets.some(asset => asset.model)) {
    const count = manifest.instances.reduce((total, instance) => { const asset = assets.get(instance.asset)!; return total + (asset.model?.colliders.length ?? (asset.collider ? 1 : 0)); }, 0);
    // Bound expansion before allocating compound geometry. Invalid drafts never
    // install a partially generated obstacle set in the shared physics host.
    if (count > limits.colliders) { issue('collider-budget', `Requested ${count} blocking colliders, exceeding the ${limits.colliders} budget; compound collision was not expanded`); return finish(); }
  }
  for (const instance of manifest.instances) {
    const asset = assets.get(instance.asset)!;
    if (asset.model) {
      for (const collider of transformAssetColliders(asset.model, { x: 0, y: 0, z: 0 }, instance.yaw)) {
        const source = collider.shape, scale = instance.scale;
        const shape = scaledShape(source, scale, spatialCoordinate);
        const position = { x: spatialCoordinate(instance.position.x + collider.position.x * scale), y: spatialCoordinate(instance.position.y + collider.position.y * scale), z: spatialCoordinate(instance.position.z + collider.position.z * scale) };
        if (!validScaledShape(shape) || Object.values(position).some(n => !finite(n) || Math.abs(n) > 10000))
          issue('collider-dimensions', 'Scaled model collider exceeds physics dimensions or coordinate bounds', [instance.id], instance.position);
        const rotation = collider.rotation!;
        manifest.colliders.push({ shape, position, rotation: { x: spatialAngle(rotation.x), y: spatialAngle(rotation.y), z: spatialAngle(rotation.z), w: spatialAngle(rotation.w) }, friction: collider.friction });
      }
      continue;
    }
    const collider = asset.collider;
    if (!collider) continue;
    const s = collider.shape, scale = instance.scale;
    const shape = scaledShape(s, scale);
    if (!validScaledShape(shape)
      || !finite(instance.position.y + collider.offsetY * scale) || Math.abs(instance.position.y + collider.offsetY * scale) > 10000) issue('collider-dimensions', 'Scaled collider exceeds physics dimensions or coordinate bounds', [instance.id], instance.position);
    manifest.colliders.push({ shape, position: { ...instance.position, y: instance.position.y + collider.offsetY * scale },
      rotation: { x: 0, y: Math.sin(instance.yaw / 2), z: 0, w: Math.cos(instance.yaw / 2) }, ...(collider.friction === undefined ? {} : { friction: collider.friction }) });
  }
  if (manifest.colliders.length > limits.colliders) issue('collider-budget', `Generated ${manifest.colliders.length} blocking colliders, exceeding the ${limits.colliders} budget; no obstacles were silently dropped`);
  return finish();
}

/** One-entry complete-recipe cache. Successful manifests are frozen. Failed drafts
 * are inspectable but never replace the last valid revision or its comparison baseline. */
export class TerrainCompiler {
  private fingerprint?: string;
  private manifest?: TerrainManifest;
  compile(recipe: TerrainRecipe): TerrainManifest {
    const fingerprint = terrainFingerprint(recipe);
    if (this.manifest && fingerprint === this.fingerprint) return this.manifest;
    const manifest = compileTerrain(recipe, this.manifest);
    if (manifest.diagnostics.valid) {
      const freeze = (value: unknown): void => {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      };
      freeze(manifest);
      this.fingerprint = fingerprint; this.manifest = manifest;
    }
    return manifest;
  }
  reset(): void { this.fingerprint = undefined; this.manifest = undefined; }
}
