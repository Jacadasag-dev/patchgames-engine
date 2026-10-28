/** Explicit, pure attachment of an asset to compiled building surfaces.
 * Positions and yaw are building-local, relative to recipe.origin. This helper
 * does not infer intent from an asset name or alter freely positioned props. */
import { assetPartBounds, validateAssetManifest, type AssetManifest } from './assetFamilies.ts';
import type { BuildingManifest, BuildingSurface } from './building.ts';
import type { PhysicsVector } from './physics.ts';
import { spatialCoordinate, transformSpatialPoint, type Point } from './spatial.ts';

export type WorldBuildingAttachment = { surface: 'roof'; gap?: number }
  | { surface: 'ceiling' | 'floor'; floorId: string; gap?: number };
export interface BuildingAttachmentRequest {
  attachment: WorldBuildingAttachment;
  /** Model origin in building-local X/Z; Y is resolved from actual geometry. */
  position: Point;
  /** Relative to the building, not world yaw. */
  yaw?: number;
}
export interface BuildingAttachmentResult {
  position?: PhysicsVector;
  diagnostics: { valid: boolean; issues: { code: string; message: string }[] };
  support?: { minY: number; maxY: number; surfaceIds: string[]; embedDepth: number };
}
export const BUILDING_ATTACHMENT_LIMITS = Object.freeze({ gap: 8, surfaces: 4096, patches: 512, operations: 262144 });
type Polygon = Point[];
type Patch = { polygon: Polygon; surface?: BuildingSurface };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const allowed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 192;
const fail = (code: string, message: string): BuildingAttachmentResult => ({ diagnostics: { valid: false, issues: [{ code, message }] } });
const height = (surface: BuildingSurface, point: Point) => surface.y + surface.slopeX * (point.x - surface.centerX) + surface.slopeZ * (point.z - surface.centerZ);

function area(polygon: Polygon): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) { const a = polygon[i], b = polygon[(i + 1) % polygon.length]; twice += a.x * b.z - b.x * a.z; }
  return Math.abs(twice) / 2;
}
/** Convex polygon clipped to ax*x + az*z + constant >= 0. */
function clip(polygon: Polygon, ax: number, az: number, constant: number): Polygon {
  const output: Polygon = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = ax * a.x + az * a.z + constant, db = ax * b.x + az * b.z + constant;
    if (da >= 0) output.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      output.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) });
    }
  }
  return output;
}
function rectangle(minX: number, maxX: number, minZ: number, maxZ: number): Polygon {
  return [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
}

/** Roofs may contain overlapping structural and pitched slabs. Partition each
 * footprint by surface rectangles and plane intersections, retaining the highest
 * support at every point. This avoids mistaking the flat attic slab for the roof
 * or sampling just a centre/corner and missing a ridge or an unsupported hole. */
function supportPatches(polygon: Polygon, surfaces: BuildingSurface[], budget: { operations: number }): Patch[] {
  let patches: Patch[] = [{ polygon }];
  for (const surface of surfaces) {
    const next: Patch[] = [];
    for (const patch of patches) {
      if (++budget.operations > BUILDING_ATTACHMENT_LIMITS.operations) throw new Error('Attachment surface work exceeds the bounded geometry budget.');
      let inside = patch.polygon;
      const boundaries = [[1, 0, -surface.minX], [-1, 0, surface.maxX], [0, 1, -surface.minZ], [0, -1, surface.maxZ]];
      for (const [ax, az, constant] of boundaries) {
        const outside = clip(inside, -ax, -az, -constant);
        if (area(outside) > 1e-10) next.push({ polygon: outside, surface: patch.surface });
        inside = clip(inside, ax, az, constant);
        if (area(inside) <= 1e-10) break;
      }
      if (area(inside) <= 1e-10) continue;
      if (!patch.surface) next.push({ polygon: inside, surface });
      else {
        const old = patch.surface, ax = surface.slopeX - old.slopeX, az = surface.slopeZ - old.slopeZ;
        const constant = height(surface, { x: 0, z: 0 }) - height(old, { x: 0, z: 0 });
        if (Math.abs(ax) + Math.abs(az) < 1e-12) next.push({ polygon: inside, surface: constant > 0 ? surface : old });
        else {
          const higher = clip(inside, ax, az, constant), lower = clip(inside, -ax, -az, -constant);
          if (area(higher) > 1e-10) next.push({ polygon: higher, surface });
          if (area(lower) > 1e-10) next.push({ polygon: lower, surface: old });
        }
      }
    }
    if (next.length > BUILDING_ATTACHMENT_LIMITS.patches) throw new Error('Attachment footprint exceeds the bounded surface partition budget.');
    patches = next;
  }
  return patches;
}

/** Roof: place the model base at the minimum exposed support height across its
 * entire transformed footprint. A pitched roof therefore intersects the model
 * instead of leaving floating downhill edges. A positive authored gap deliberately
 * lifts it. Floor: place the base above the highest support. Ceiling: place the
 * model top below the lowest slab underside. Bounds include every part, including
 * decorative parts and recentered asset groups; boxes retain their rotated shape,
 * cylinders/spheres use conservative bounds consistent with asset compilation.
 * This resolves support only, not collisions with unrelated props or walls. */
export function resolveBuildingAttachment(building: BuildingManifest, inputModel: AssetManifest, request: BuildingAttachmentRequest): BuildingAttachmentResult {
  if (!plain(request) || !allowed(request, ['attachment', 'position', 'yaw']) || !plain(request.position)
    || !allowed(request.position, ['x', 'z']) || !finite(request.position.x) || !finite(request.position.z)
    || Math.abs(request.position.x) > 10000 || Math.abs(request.position.z) > 10000
    || request.yaw !== undefined && (!finite(request.yaw) || Math.abs(request.yaw) > 1e6)) return fail('attachment-request', 'Attachment needs bounded building-local X/Z and yaw, without an explicit Y.');
  const intent = request.attachment;
  if (!plain(intent) || !['roof', 'ceiling', 'floor'].includes(intent.surface as string)
    || !allowed(intent, intent.surface === 'roof' ? ['surface', 'gap'] : ['surface', 'floorId', 'gap'])
    || intent.surface !== 'roof' && !identifier(intent.floorId)
    || intent.gap !== undefined && (!finite(intent.gap) || intent.gap < 0 || intent.gap > BUILDING_ATTACHMENT_LIMITS.gap)) return fail('attachment-intent', 'Choose roof, or ceiling/floor with a floorId, and an optional nonnegative gap up to 8 metres.');
  if (!building?.diagnostics?.valid || !building.recipe || !Array.isArray(building.recipe.floors) || building.recipe.floors.length < 1 || building.recipe.floors.length > 8
    || !Array.isArray(building.surfaces) || building.surfaces.length > BUILDING_ATTACHMENT_LIMITS.surfaces) return fail('attachment-building', 'Attachment requires a valid bounded compiled building.');
  const floors = [...building.recipe.floors];
  if (floors.some(floor => !floor || !identifier(floor.id) || !finite(floor.y) || !finite(floor.height) || Math.abs(floor.y) > 1000 || floor.height <= 0 || floor.height > 20)) return fail('attachment-building', 'Building floor metadata is invalid.');
  floors.sort((a, b) => a.y - b.y);
  const floorIndex = intent.surface === 'roof' ? floors.length - 1 : floors.findIndex(floor => floor.id === intent.floorId);
  if (floorIndex < 0) return fail('attachment-floor', 'Attachment floorId does not identify a building floor.');
  const originY = building.recipe.origin?.y ?? 0;
  if (!finite(originY) || Math.abs(originY) > 10000 || !Array.isArray(building.parts) || building.parts.length > 4096) return fail('attachment-building', 'Building part metadata is invalid.');
  const slabs = new Map(building.parts.filter(part => part && (part.kind === 'floor' || part.kind === 'roof')).map(part => [part.id, part]));
  const selectedFloor = floors[floorIndex], nextFloor = floors[floorIndex + 1];
  let surfaces: BuildingSurface[] = [];
  for (const surface of building.surfaces) {
    if (!surface || !identifier(surface.id) || !identifier(surface.floorId)
      || !['floor', 'roof', 'stair'].includes(surface.kind) || ![surface.minX, surface.maxX, surface.minZ, surface.maxZ, surface.y, surface.slopeX, surface.slopeZ, surface.centerX, surface.centerZ].every(value => finite(value) && Math.abs(value) <= 10000)
      || surface.minX >= surface.maxX || surface.minZ >= surface.maxZ) return fail('attachment-building', 'Compiled support surface metadata is invalid.');
    if (intent.surface === 'roof' && surface.kind === 'roof') surfaces.push(surface);
    else if (intent.surface === 'floor' && surface.kind === 'floor' && surface.floorId === selectedFloor.id) surfaces.push(surface);
    else if (intent.surface === 'ceiling') {
      if (nextFloor && surface.kind === 'floor' && surface.floorId === nextFloor.id
        || !nextFloor && surface.kind === 'roof' && surface.floorId === selectedFloor.id && surface.slopeX === 0 && surface.slopeZ === 0) {
        // Floor surface/slab IDs share a compiler tile suffix; structural roof
        // support and part IDs are identical. Raised rooms thicken their slab
        // downwards, so subtracting only recipe.floorThickness is incorrect.
        const partId = surface.kind === 'floor' ? surface.id.replace(/:surface:(\d+)$/, ':slab:$1') : surface.id;
        const slab = slabs.get(partId);
        if (!slab || slab.floorId !== surface.floorId || !finite(slab.position?.y) || !finite(slab.size?.y) || slab.size.y <= 0
          || !finite(slab.rotation?.x) || !finite(slab.rotation?.z) || Math.abs(slab.rotation.x) + Math.abs(slab.rotation.z) > 1e-7) return fail('attachment-building', 'Ceiling support must match an upright compiled slab.');
        surfaces.push({ ...surface, y: slab.position.y - slab.size.y / 2 - originY });
      }
    }
  }
  if (building.recipe.roof === false && (intent.surface === 'roof' || intent.surface === 'ceiling' && !nextFloor)) surfaces = [];
  if (!surfaces.length) return fail('attachment-surface', `The requested ${intent.surface} has no compiled support surface.`);
  let model: AssetManifest;
  try { model = validateAssetManifest(inputModel); } catch (error) { return fail('attachment-model', error instanceof Error ? error.message : 'Asset model is invalid.'); }
  const position = { x: spatialCoordinate(request.position.x), z: spatialCoordinate(request.position.z) }, yaw = request.yaw ?? 0;
  const budget = { operations: 0 }, surfaceIds = new Set<string>();
  let minimum = Infinity, maximum = -Infinity;
  try {
    for (const part of model.parts) {
      const center = transformSpatialPoint(part.position, position, yaw), rotation = (part.yaw ?? 0) + yaw;
      let polygon: Polygon;
      if (part.shape === 'box' || part.shape === 'cylinder' && part.collision !== false) polygon = rectangle(-part.size.x / 2, part.size.x / 2, -part.size.z / 2, part.size.z / 2).map(point => transformSpatialPoint(point, center, rotation));
      else {
        const bounds = assetPartBounds({ ...part, position: { ...center, y: part.position.y }, yaw: rotation });
        polygon = rectangle(spatialCoordinate(bounds.min.x), spatialCoordinate(bounds.max.x), spatialCoordinate(bounds.min.z), spatialCoordinate(bounds.max.z));
      }
      for (const patch of supportPatches(polygon, surfaces, budget)) {
        if (!patch.surface) return fail('attachment-coverage', `The full transformed footprint of asset part ${part.id} is not supported by the requested ${intent.surface}.`);
        surfaceIds.add(patch.surface.id);
        for (const point of patch.polygon) { const y = height(patch.surface, point); minimum = Math.min(minimum, y); maximum = Math.max(maximum, y); }
      }
    }
  } catch (error) { return fail('attachment-budget', error instanceof Error ? error.message : 'Attachment exceeds geometry limits.'); }
  if (!finite(minimum) || !finite(maximum)) return fail('attachment-coverage', 'The asset has no supported footprint.');
  const gap = intent.gap ?? 0;
  const y = intent.surface === 'ceiling' ? minimum - model.bounds.max.y - gap
    : (intent.surface === 'roof' ? minimum : maximum) - model.bounds.min.y + gap;
  if (!finite(y) || Math.abs(y) + model.size.y > 10000) return fail('attachment-bounds', 'Resolved attachment exceeds the vertical world bounds.');
  return { position: { ...position, y: spatialCoordinate(y) }, diagnostics: { valid: true, issues: [] },
    support: { minY: spatialCoordinate(minimum), maxY: spatialCoordinate(maximum), surfaceIds: [...surfaceIds].sort(),
      embedDepth: intent.surface === 'roof' ? spatialCoordinate(Math.max(0, maximum - minimum - gap)) : 0 } };
}
