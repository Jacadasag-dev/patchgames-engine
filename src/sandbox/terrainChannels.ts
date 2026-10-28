/** Deterministic channel planning shared by terrain carving and water authoring.
 * Coordinates are metres, Y-up; point order is upstream to downstream. */
import { nearestSpatialRoute, spatialCoordinate } from './spatial.ts';
import type { TerrainIssue, TerrainPoint } from './terrain.ts';
import { validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';

export interface TerrainChannelPoint extends TerrainPoint {
  /** Absolute channel-bed elevation. Omitted values are resolved from the base. */
  bedY?: number;
  width?: number;
  depth?: number;
  bankWidth?: number;
}
export interface TerrainChannel {
  id: string;
  kind?: 'river' | 'canal';
  points: TerrainChannelPoint[];
  /** Width of the flat bed, excluding the two banks. */
  width: number;
  /** Initial excavation depth below the original ground. */
  depth: number;
  /** Horizontal distance from each bed edge to untouched ground. */
  bankWidth?: number;
  /** Minimum downstream fall in metres/metre; default zero permits level canals. */
  minimumSlope?: number;
  /** Maximum excavation below the original surface, checked across the carved area. */
  maxCut?: number;
  clearance?: number;
  /** Explicit bridges may cross; their foundations must not refill the channel. */
  allowPlacements?: boolean;
  color?: string;
  material?: SurfaceMaterialInput;
}
export interface ResolvedTerrainChannelPoint extends TerrainPoint {
  bedY: number; width: number; depth: number; bankWidth: number; distance: number;
}
export interface ResolvedTerrainChannel {
  id: string;
  kind: 'river' | 'canal';
  points: ResolvedTerrainChannelPoint[];
  length: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  clearance: number;
  maxCut: number;
  allowPlacements: boolean;
  color?: string;
  material?: SurfaceMaterialInput;
}
export interface TerrainChannelSample {
  point: TerrainPoint;
  tangent: TerrainPoint;
  distance: number;
  distanceAlong: number;
  bedY: number;
  width: number;
  depth: number;
  bankWidth: number;
  /** One over the bed, falling to zero at the outer bank. */
  weight: number;
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const between = (n: unknown, min: number, max: number) => finite(n) && n >= min && n <= max;
const optional = (n: unknown, min: number, max: number) => n === undefined || between(n, min, max);
const smooth = (n: number) => n * n * (3 - 2 * n);

/** Complete bounded metadata validation, also used before streamed chunks exist. */
export function terrainChannelIssues(channels: unknown, bounds?: { width: number; depth: number }): TerrainIssue[] {
  const issues: TerrainIssue[] = [];
  const issue = (code: string, message: string, id?: string) => issues.push({ severity: 'error', code, message, ...(id ? { ids: [id] } : {}) });
  if (channels === undefined) return issues;
  if (!Array.isArray(channels) || channels.length > 16) {
    issue('channel-budget', 'Terrain channels must be an array of at most 16 entries.'); return issues;
  }
  const ids = new Set<string>(); let points = 0;
  for (const input of channels) {
    const c = input as TerrainChannel;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { issue('channel', 'Each terrain channel requires an object.'); continue; }
    if (typeof c.id !== 'string' || !c.id.length || c.id.length > 128 || ids.has(c.id)) issue('channel-id', 'Channel IDs must be nonempty, unique and at most 128 characters.');
    ids.add(c.id);
    if (c.kind !== undefined && c.kind !== 'river' && c.kind !== 'canal') issue('channel-kind', 'Channel kind must be river or canal.', c.id);
    if (!between(c.width, .02, 2000) || !between(c.depth, .001, 1000) || !optional(c.bankWidth, .02, 2000)
      || !optional(c.minimumSlope, 0, 10) || !optional(c.maxCut, .001, 10000) || !optional(c.clearance, 0, 2000)
      || c.allowPlacements !== undefined && typeof c.allowPlacements !== 'boolean') issue('channel-dimensions', 'Channels require bounded positive width/depth/bank width and nonnegative slope, clearance and excavation budgets.', c.id);
    if (c.color !== undefined && (typeof c.color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(c.color))) issue('channel-color', 'Channel color must be a three or six digit hex color.', c.id);
    if (c.material !== undefined) try { validateSurfaceMaterialInput(c.material); } catch (error) { issue('channel-material', String(error), c.id); }
    if (!Array.isArray(c.points) || c.points.length < 2 || c.points.length > 64) { issue('channel-points', 'A channel requires 2 to 64 ordered control points.', c.id); continue; }
    points += c.points.length;
    for (let i = 0; i < c.points.length; i++) {
      const p = c.points[i];
      if (!p || !between(p.x, -10000, 10000) || !between(p.z, -10000, 10000) || !optional(p.bedY, -10000, 10000)
        || !optional(p.width, .02, 2000) || !optional(p.depth, .001, 1000) || !optional(p.bankWidth, .02, 2000)) { issue('channel-point', 'Channel points require bounded coordinates and positive local dimensions.', c.id); continue; }
      if (bounds && (Math.abs(p.x) > bounds.width / 2 || Math.abs(p.z) > bounds.depth / 2)) issue('channel-bounds', 'Channel control points must lie inside the terrain bounds.', c.id);
      const previous = c.points[i - 1];
      if (previous && finite(previous.x) && finite(previous.z) && Math.hypot(p.x - previous.x, p.z - previous.z) < .00001) issue('channel-segment', 'Consecutive channel points must be distinct.', c.id);
    }
  }
  if (points > 512) issue('channel-budget', 'All terrain channels together support at most 512 control points.');
  return issues;
}

/** Resolve once against the pre-road/pre-foundation terrain base. River beds
 * follow downhill ground while cutting through rises. Canal beds follow their
 * inlet grade. Explicit elevations are never silently moved uphill or downhill. */
export function resolveTerrainChannels(channels: readonly TerrainChannel[] | undefined, baseHeight: (x: number, z: number) => number): ResolvedTerrainChannel[] {
  const issues = terrainChannelIssues(channels);
  if (issues.length) throw new Error(issues.map(issue => issue.message).join(' '));
  return [...channels ?? []].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(c => {
    const kind = c.kind ?? 'river', points: ResolvedTerrainChannelPoint[] = [];
    for (const p of c.points) {
      const previous = points.at(-1), depth = p.depth ?? c.depth, base = baseHeight(p.x, p.z);
      if (!finite(base)) throw new Error(`${c.id}: channel base samples must be finite.`);
      const length = previous ? Math.hypot(p.x - previous.x, p.z - previous.z) : 0;
      const ceiling = previous ? previous.bedY - (c.minimumSlope ?? 0) * length : Infinity;
      const target = kind === 'canal' && previous ? ceiling : Math.min(base - depth, ceiling);
      const bedY = spatialCoordinate(p.bedY ?? target);
      if (!between(bedY, -10000, 10000) || bedY > ceiling + 1e-6) throw new Error(`${c.id}: channel bed must descend in point order at its minimumSlope.`);
      if (bedY > base + 1e-6) throw new Error(`${c.id}: a channel cannot fill terrain below its bed; lower bedY or change the route.`);
      if (base - bedY > (c.maxCut ?? 10000) + 1e-6) throw new Error(`${c.id}: channel exceeds its maxCut excavation budget.`);
      points.push({ x: p.x, z: p.z, bedY, depth, width: p.width ?? c.width,
        bankWidth: p.bankWidth ?? c.bankWidth ?? (kind === 'canal' ? Math.max(.25, depth * .5) : Math.max(.02, depth * 2)),
        distance: spatialCoordinate((previous?.distance ?? 0) + length) });
    }
    const reach = Math.max(...points.map(p => p.width / 2 + p.bankWidth));
    return { id: c.id, kind, points, length: points.at(-1)!.distance,
      bounds: { minX: Math.min(...points.map(p => p.x)) - reach, maxX: Math.max(...points.map(p => p.x)) + reach,
        minZ: Math.min(...points.map(p => p.z)) - reach, maxZ: Math.max(...points.map(p => p.z)) + reach },
      maxCut: c.maxCut ?? 10000, clearance: c.clearance ?? 0, allowPlacements: c.allowPlacements ?? false,
      ...(c.color ? { color: c.color } : {}), ...(c.material ? { material: c.material } : {}) };
  });
}

/** Validate a transferred/public resolved centerline without trusting compiler
 * provenance. Performs no mutation and no terrain resampling. */
export function validateResolvedTerrainChannels(channels: unknown): asserts channels is ResolvedTerrainChannel[] {
  if (!Array.isArray(channels) || channels.length > 16) throw new Error('Resolved terrain channels require at most 16 entries.');
  const originals: TerrainChannel[] = [];
  for (const value of channels) {
    const channel = value as ResolvedTerrainChannel;
    if (!channel || typeof channel !== 'object' || !Array.isArray(channel.points) || channel.points.length < 2 || channel.points.length > 64
      || channel.kind !== 'river' && channel.kind !== 'canal' || !between(channel.length, .00001, 2000000)
      || !between(channel.maxCut, .001, 10000) || !between(channel.clearance, 0, 2000) || typeof channel.allowPlacements !== 'boolean')
      throw new Error('Invalid bounded resolved terrain channel metadata.');
    for (let i = 0; i < channel.points.length; i++) {
      const point = channel.points[i], previous = channel.points[i - 1];
      if (!point || !between(point.x, -10000, 10000) || !between(point.z, -10000, 10000) || !between(point.bedY, -10000, 10000)
        || !between(point.width, .02, 2000) || !between(point.depth, .001, 1000) || !between(point.bankWidth, .02, 2000) || !between(point.distance, 0, 2000000))
        throw new Error('Resolved terrain channel points require finite bounded dimensions, elevation and distance.');
      const length = previous ? Math.hypot(point.x - previous.x, point.z - previous.z) : 0;
      if (previous && (length < .00001 || point.bedY > previous.bedY + 1e-6)
        || Math.abs(point.distance - (previous?.distance ?? 0) - length) > 1e-6)
        throw new Error('Resolved terrain channels require distinct, downhill segments and consistent distances.');
    }
    if (Math.abs(channel.length - channel.points.at(-1)!.distance) > 1e-6) throw new Error('Resolved channel length does not match its centerline.');
    const b = channel.bounds, reach = Math.max(...channel.points.map(p => p.width / 2 + p.bankWidth));
    const expected = { minX: Math.min(...channel.points.map(p => p.x)) - reach, maxX: Math.max(...channel.points.map(p => p.x)) + reach,
      minZ: Math.min(...channel.points.map(p => p.z)) - reach, maxZ: Math.max(...channel.points.map(p => p.z)) + reach };
    if (!b || (['minX', 'maxX', 'minZ', 'maxZ'] as const).some(key => !finite(b[key]) || Math.abs(b[key] - expected[key]) > 1e-6))
      throw new Error('Resolved channel bounds do not match its bank extent.');
    originals.push({ ...channel, width: channel.points[0].width, depth: channel.points[0].depth });
  }
  const issues = terrainChannelIssues(originals);
  if (issues.length) throw new Error(issues.map(issue => issue.message).join(' '));
}

/** Uses the shared nearest-polyline projection. Off the centerline, overlapping
 * cross-sections blend their grades rather than switching abruptly at a bend's
 * bisector. Authored centerline elevations stay exact; banks keep their bounded
 * segment union. Returns zero weight outside the bank. */
export function sampleTerrainChannel(channel: ResolvedTerrainChannel, x: number, z: number): TerrainChannelSample {
  if (!finite(x) || !finite(z)) throw new Error('Channel sampling requires finite coordinates.');
  const near = nearestSpatialRoute({ x, z }, channel.points)!;
  const a = channel.points[near.index], b = channel.points[near.index + 1], lerp = (key: 'bedY' | 'width' | 'depth' | 'bankWidth' | 'distance') => a[key] + (b[key] - a[key]) * near.t;
  const bankWeight = (distance: number, width: number, bankWidth: number) => {
    const t = Math.max(0, Math.min(1, (distance - width / 2) / bankWidth));
    return 1 - (channel.kind === 'river' ? smooth(t) : t);
  };
  const sample: TerrainChannelSample = { point: near.point, tangent: near.tangent, distance: near.distance, distanceAlong: lerp('distance'),
    bedY: lerp('bedY'), width: lerp('width'), depth: lerp('depth'), bankWidth: lerp('bankWidth'), weight: 0 };
  sample.weight = bankWeight(near.distance, sample.width, sample.bankWidth);
  if (channel.points.length === 2 || near.distance < 1e-7) return sample;

  let total = 0, bedY = 0, width = 0, depth = 0, bankWidth = 0, distanceAlong = 0, tangentX = 0, tangentZ = 0;
  for (let index = 0; index + 1 < channel.points.length; index++) {
    const from = channel.points[index], to = channel.points[index + 1];
    const projected = index === near.index ? near : nearestSpatialRoute({ x, z }, [from, to])!;
    const at = (key: 'bedY' | 'width' | 'depth' | 'bankWidth' | 'distance') => from[key] + (to[key] - from[key]) * projected.t;
    const localWidth = at('width'), localBank = at('bankWidth'), coverage = bankWeight(projected.distance, localWidth, localBank);
    sample.weight = Math.max(sample.weight, coverage);
    // This compact kernel is symmetric across a nearest-segment switch. Using
    // every overlapping segment avoids introducing another seam at the edges
    // of an index-based "nearest segment plus neighbours" selection.
    const ratio = projected.distance / near.distance;
    if (!coverage || ratio >= 2) continue;
    const influence = smooth(Math.max(0, Math.min(1, 2 - ratio))) * coverage;
    // Extend the local grade plane across interior joins, rather than blending
    // in an endpoint's constant-height plateau. A straight graded channel then
    // stays identical when the author inserts extra collinear control points.
    const dx = to.x - from.x, dz = to.z - from.z;
    const rawT = ((x - from.x) * dx + (z - from.z) * dz) / (dx * dx + dz * dz);
    const gradeT = Math.max(index === 0 ? 0 : -Infinity, Math.min(index + 2 === channel.points.length ? 1 : Infinity, rawT));
    const localBed = Math.max(channel.points.at(-1)!.bedY, Math.min(channel.points[0].bedY, from.bedY + (to.bedY - from.bedY) * gradeT));
    const along = Math.max(0, Math.min(channel.length, from.distance + (to.distance - from.distance) * gradeT));
    total += influence; bedY += localBed * influence; width += localWidth * influence;
    depth += at('depth') * influence; bankWidth += localBank * influence; distanceAlong += along * influence;
    tangentX += projected.tangent.x * influence; tangentZ += projected.tangent.z * influence;
  }
  if (total > 0) {
    sample.bedY = bedY / total; sample.width = width / total; sample.depth = depth / total;
    sample.bankWidth = bankWidth / total; sample.distanceAlong = distanceAlong / total;
    const length = Math.hypot(tangentX, tangentZ);
    if (length > 1e-9) sample.tangent = { x: tangentX / length, z: tangentZ / length };
  }
  return sample;
}

/** Cut-only union: overlapping tributaries choose the lower cut, independent of
 * recipe order. Invalid cuts are reported rather than silently filling a valley. */
export function carveTerrainChannels(original: number, x: number, z: number, channels: readonly ResolvedTerrainChannel[], onIssue?: (id: string, message: string, point: TerrainPoint) => void): number {
  let height = original;
  for (const channel of channels) {
    const b = channel.bounds;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    const sample = sampleTerrainChannel(channel, x, z);
    if (!sample.weight) continue;
    if (sample.weight === 1 && sample.bedY > original + 1e-5) onIssue?.(channel.id, 'Channel bed would require filling existing lower terrain; lower bedY or change its route.', { x, z });
    const cut = Math.max(0, original - sample.bedY) * sample.weight;
    if (cut > channel.maxCut + 1e-6) onIssue?.(channel.id, 'Channel exceeds its maxCut excavation budget.', { x, z });
    height = Math.min(height, original - cut);
  }
  return height;
}
