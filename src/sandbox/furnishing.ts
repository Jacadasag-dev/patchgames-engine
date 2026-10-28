import type { AssetManifest } from './assetFamilies.ts';
import { ASSET_GROUP_LIMITS, resolveAssetGroup, validateAssetGroupAttachments, type AssetGroupAttachment, type AssetGroupCatalog } from './assetGroups.ts';
import { assetDressingModel, resolveAssetDressing, validateAssetDressingArrangements, type AssetDressingArrangement } from './assetDressing.ts';
import type { BuildingFloorRecipe, BuildingFurnitureRecipe, BuildingOpeningRecipe, BuildingRecipe, BuildingRoomRecipe, BuildingSide } from './building.ts';
import { resolveBuildingDoorIntent, validateBuildingDoorPolicy } from './building.ts';
import { compileDoorGeometry, resolveDoorSelection, validateBuildingDoorSelection } from './buildingDoors.ts';
import { facingYaw, nearScore, spatialCoordinate as coordinate, spatialAngle as angle } from './spatial.ts';
import { compileBuildingFootprint, footprintContainsPoint, footprintContainsRectangle, type BuildingFootprint } from './buildingFootprints.ts';
import { validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';

export interface FurnishingCatalog extends AssetGroupCatalog {}
export interface FurnishingReservation { id: string; x: number; z: number; width: number; depth: number }
/** All points and directions are in building-local coordinates. Asset +Z is
 * forward; whole-building yaw is applied later by the building compiler. */
export type FurnishingFacing = 'room-front' | 'focal-point' | 'entrance' | { side: BuildingSide } | { point: { x: number; z: number } };
export interface FurnishingPreferences {
  /** Nonnegative weights from 0–100. Only feasible candidates are scored. */
  front?: number; back?: number; focalPoint?: number; entrance?: number;
}
export interface FurnishingRule {
  /** Stable within this room; changing another rule does not reroll its assets. */
  id: string; family: string; count: number; required?: number;
  placement: 'wall' | 'grid' | 'free' | 'center'; wall?: 'north' | 'south' | 'east' | 'west';
  parameters?: Record<string, string | number>; yaw?: number; columns?: number; gap?: number;
  /** Shared finish for the generated group; explicit model-part materials win. */
  material?: SurfaceMaterialInput;
  /** Opt-in facing; an explicit yaw always wins. Socket children retain their
   * parent-relative yaw. Missing referenced room context is a diagnostic. */
  facing?: FurnishingFacing;
  /** Rank bounded procedural candidates after room, aisle and overlap checks.
   * Absent/all-zero preferences keep legacy first-fit placement. */
  preferences?: FurnishingPreferences;
  zone?: { x: number; z: number; width: number; depth: number };
  /** Chairs are attached to the parent's ground-level sockets tagged "seat". */
  seating?: { family: string; count: number; parameters?: Record<string, string | number> };
  /** Generic root-socket attachments, using the shared asset-group resolver.
   * When seating is also supplied, its reserved attachment rule ID is seating. */
  attachments?: readonly AssetGroupAttachment[];
  /** Weighted arrangements on the host model's annotated support surfaces.
   * The dressed host is one compound model; seating/socket children keep their
   * original identities and the authored host floor anchor remains fixed. */
  dressing?: readonly AssetDressingArrangement[];
}
export interface FurnishingIssue { code: string; message: string; roomId: string; ruleId?: string }
type DressingResolution = ReturnType<typeof resolveAssetDressing>;
export interface FurnishingDressingInstance {
  roomId: string; ruleId: string; instanceId: string; hostPlaced: boolean;
  arrangements: DressingResolution['arrangements']; diagnostics: DressingResolution['diagnostics'];
}
export interface FurnishingDressingDiagnostics {
  hostsRequested: number; hostsPlaced: number; requested: number; placed: number;
  attempted: number; omittedOptional: number; emptyChoices: number;
  /** First 256 host decisions; aggregate counts include every requested host. */
  instances: FurnishingDressingInstance[]; omittedInstances: number;
}
export interface FurnishingResult {
  furniture: BuildingFurnitureRecipe[];
  diagnostics: { valid: boolean; issues: FurnishingIssue[]; requested: number; placed: number; attempted: number; omittedOptional: number;
    /** Item counts describe resolved dressing, with hostPlaced distinguishing
     * objects that also passed the room's placement constraints. */
    dressing?: FurnishingDressingDiagnostics };
}
export interface FurnishRoomOptions {
  seed: number; room: BuildingRoomRecipe; rules: FurnishingRule[];
  reservations?: FurnishingReservation[]; existing?: BuildingFurnitureRecipe[];
  wallInset?: number; clearance?: number; maxAttempts?: number;
}
export interface FurnishBuildingOptions {
  seed?: number; rooms: Record<string, { rules: FurnishingRule[]; reservations?: FurnishingReservation[]; circulation?: 'center' | 'doors-only' }>;
}
export interface FurnishedBuilding {
  recipe: BuildingRecipe; diagnostics: FurnishingResult['diagnostics']; rooms: Record<string, FurnishingResult['diagnostics']>;
}
type Box = { minX: number; maxX: number; minZ: number; maxZ: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const newDressingDiagnostics = (): FurnishingDressingDiagnostics => ({ hostsRequested: 0, hostsPlaced: 0, requested: 0, placed: 0,
  attempted: 0, omittedOptional: 0, emptyChoices: 0, instances: [], omittedInstances: 0 });
function mergeDressingDiagnostics(target: FurnishingDressingDiagnostics, source: FurnishingDressingDiagnostics): void {
  for (const key of ['hostsRequested', 'hostsPlaced', 'requested', 'placed', 'attempted', 'omittedOptional', 'emptyChoices'] as const) target[key] += source[key];
  const keep = Math.min(source.instances.length, 256 - target.instances.length);
  target.instances.push(...source.instances.slice(0, keep));
  target.omittedInstances += source.omittedInstances + source.instances.length - keep;
}
const box = (p: { x: number; z: number; width: number; depth: number }, yaw = 0): Box => {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw)), w = c * p.width + s * p.depth, d = s * p.width + c * p.depth;
  return { minX: p.x - w / 2, maxX: p.x + w / 2, minZ: p.z - d / 2, maxZ: p.z + d / 2 };
};
const overlap = (a: Box, b: Box, gap = 0) => Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > -gap + 1e-7 && Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > -gap + 1e-7;
function groupOverlap(a: BuildingFurnitureRecipe, b: BuildingFurnitureRecipe): boolean {
  if ((a.y ?? 0) + a.height <= (b.y ?? 0) + 1e-7 || (b.y ?? 0) + b.height <= (a.y ?? 0) + 1e-7) return false;
  const axes = (p: BuildingFurnitureRecipe) => [{ x: Math.cos(p.yaw ?? 0), z: -Math.sin(p.yaw ?? 0) }, { x: Math.sin(p.yaw ?? 0), z: Math.cos(p.yaw ?? 0) }];
  const aa = axes(a), bb = axes(b), dot = (v: { x: number; z: number }, w: { x: number; z: number }) => v.x * w.x + v.z * w.z;
  return [...aa, ...bb].every(axis => Math.abs((a.x - b.x) * axis.x + (a.z - b.z) * axis.z)
    < Math.abs(dot(aa[0], axis)) * a.width / 2 + Math.abs(dot(aa[1], axis)) * a.depth / 2
      + Math.abs(dot(bb[0], axis)) * b.width / 2 + Math.abs(dot(bb[1], axis)) * b.depth / 2 - 1e-7);
}
const inside = (a: Box, b: Box, inset = 0) => a.minX >= b.minX + inset - 1e-7 && a.maxX <= b.maxX - inset + 1e-7 && a.minZ >= b.minZ + inset - 1e-7 && a.maxZ <= b.maxZ - inset + 1e-7;
function random(seed: number, key: string): number {
  let h = seed >>> 0; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); return ((h ^ h >>> 16) >>> 0) / 4294967296;
}
function finiteBox(value: { x: number; z: number; width: number; depth: number } | null | undefined): boolean {
  return !!value && [value.x, value.z, value.width, value.depth].every(Number.isFinite) && value.width > 0 && value.depth > 0;
}
const stableId = (key: string) => key.length <= 96 ? key : `${key.slice(0,80)}:${Math.floor(random(0,key) * 4294967296).toString(16)}`;
const validId = (value: unknown, max = 96): value is string => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
const sides = ['north', 'south', 'east', 'west'] as const;
const pointValid = (point: { x: number; z: number } | null | undefined): boolean => !!point && [point.x, point.z].every(n => Number.isFinite(n) && Math.abs(n) <= 10000);
function facingValid(facing: FurnishingFacing | undefined): boolean {
  return facing === undefined || typeof facing === 'string' && ['room-front', 'focal-point', 'entrance'].includes(facing)
    || !!facing && typeof facing === 'object' && Object.keys(facing).length === 1
      && ('side' in facing ? sides.includes(facing.side) : 'point' in facing && pointValid(facing.point));
}
function preferencesValid(preferences: FurnishingPreferences | undefined): boolean {
  return preferences === undefined || !!preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    && Object.entries(preferences).every(([key, value]) => ['front', 'back', 'focalPoint', 'entrance'].includes(key) && Number.isFinite(value) && value >= 0 && value <= 100);
}
function directionFor(rule: FurnishingRule, room: BuildingRoomRecipe): BuildingSide | { x: number; z: number } | undefined {
  const facing = rule.facing;
  return facing === 'room-front' ? room.orientation?.front : facing === 'focal-point' ? room.orientation?.focalPoint : facing === 'entrance' ? room.orientation?.entry
    : facing && typeof facing === 'object' ? 'side' in facing ? facing.side : facing.point : undefined;
}
function candidateScore(p: { x: number; z: number }, room: BuildingRoomRecipe, weights: FurnishingPreferences): number {
  const orientation = room.orientation!, front = orientation.front;
  const along = front === 'east' ? (p.x - room.x) / room.width : front === 'west' ? (room.x - p.x) / room.width
    : front === 'north' ? (room.z - p.z) / room.depth : (p.z - room.z) / room.depth;
  const frontScore = Math.max(0, Math.min(1, .5 + along)), diagonal = coordinate(Math.hypot(room.width, room.depth));
  const near = (target: { x: number; z: number } | undefined) => target ? nearScore(p, target, diagonal) : 0;
  return Math.round(((weights.front ?? 0) * frontScore + (weights.back ?? 0) * (1 - frontScore)
    + (weights.focalPoint ?? 0) * near(orientation.focalPoint) + (weights.entrance ?? 0) * near(orientation.entry)) * 1e6);
}
function item(id: string, room: string, model: AssetManifest, x = 0, z = 0, yaw = 0, y = 0): BuildingFurnitureRecipe {
  return { id, room, asset: model.familyId, model, x, z, y, yaw, width: model.size.x, depth: model.size.z, height: model.size.y };
}
function attachmentRules(rule: FurnishingRule): readonly AssetGroupAttachment[] | undefined {
  if (!rule.seating) return rule.attachments;
  return [{ id: 'seating', socketTag: 'seat', ...rule.seating }, ...(rule.attachments ?? [])];
}

function doorPoint(owner: BuildingRoomRecipe, opening: BuildingOpeningRecipe): { x: number; z: number; axis: 'x' | 'z' } | undefined {
  const axis = opening.side === 'north' || opening.side === 'south' ? 'x' : 'z';
  if (opening.edge !== undefined) {
    const edge = compileBuildingFootprint(owner.footprint ?? [owner], owner).footprint?.edges.filter(e => e.side === opening.side)[opening.edge];
    if (!edge) return;
    const along = (edge.min + edge.max) / 2 + (opening.offset ?? 0);
    return axis === 'x' ? { x: along, z: edge.at, axis } : { x: edge.at, z: along, axis };
  }
  return { axis,
    x: axis === 'x' ? owner.x + (opening.offset ?? 0) : owner.x + (opening.side === 'east' ? 1 : -1) * owner.width / 2,
    z: axis === 'z' ? owner.z + (opening.offset ?? 0) : owner.z + (opening.side === 'south' ? 1 : -1) * owner.depth / 2 };
}

/** Resolve each opening once per furnishing pass. Full-motion envelopes reserve
 * both an authored closed leaf and its eventual open pocket; room rules and
 * palette keys are exactly the ones used by the structural compiler. */
function floorDoorReservations(recipe: BuildingRecipe, floor: BuildingFloorRecipe): FurnishingReservation[] {
  // Validate declared defaults even when an opening overrides them, matching
  // the compiler instead of letting null coalescing hide malformed policies.
  if (recipe.doors !== undefined) validateBuildingDoorSelection(recipe.doors);
  if (floor.doors !== undefined) validateBuildingDoorSelection(floor.doors);
  for (const room of floor.rooms) if (room.doorPolicy !== undefined) validateBuildingDoorPolicy(room.doorPolicy);
  if (recipe.doors === undefined && floor.doors === undefined && floor.rooms.every(room => room.doorPolicy === undefined)
    && (floor.openings ?? []).every(opening => opening.door === undefined)) return [];
  const reservations: FurnishingReservation[] = [];
  const shapes = new Map(floor.rooms.map(room => [room.id, compileBuildingFootprint(room.footprint ?? [room], room).footprint]));
  for (const opening of floor.openings ?? []) {
    const owner = floor.rooms.find(room => room.id === opening.room); if (!owner) continue;
    const point = doorPoint(owner, opening); if (!point) continue;
    const roomIds = floor.rooms.filter(room => { const shape = shapes.get(room.id); return shape && footprintContainsPoint(shape, point); }).map(room => room.id);
    const intent = resolveBuildingDoorIntent(recipe, floor, opening, roomIds); if (opening.kind !== 'door' || !intent.selection) continue;
    const seed = (recipe.seed ?? 0) >>> 0, key = `${recipe.id}:${opening.id}`;
    const { design } = resolveDoorSelection(intent.selection, { seed, key });
    const geometry = compileDoorGeometry({ id: `${recipe.id}:door:${opening.id}`, width: opening.width, height: opening.height, wallThickness: recipe.wallThickness ?? .18, design, seed });
    const yaw = opening.side === 'north' ? 0 : opening.side === 'south' ? Math.PI : opening.side === 'east' ? -Math.PI / 2 : Math.PI / 2;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const reservation of geometry.reservations) reservations.push({ id: `door-space:${opening.id}:${reservation.id}`,
      x: coordinate(point.x + c * reservation.x + s * reservation.z), z: coordinate(point.z - s * reservation.x + c * reservation.z),
      width: coordinate(Math.abs(c) * reservation.width + Math.abs(s) * reservation.depth), depth: coordinate(Math.abs(s) * reservation.width + Math.abs(c) * reservation.depth) });
  }
  return reservations;
}

/** Follow the union's tile adjacency, so circulation turns around a concave
 * notch instead of reserving a fictitious path through the missing room area. */
function compoundAisles(footprint: BuildingFootprint, from: { x: number; z: number }, aisle: number): FurnishingReservation[] {
  const tiles = footprint.tiles, start = tiles.findIndex(tile => inside(box({ ...from, width: .001, depth: .001 }), box(tile), -.002));
  const goal = tiles.reduce((best, tile, i) => tile.width * tile.depth > tiles[best].width * tiles[best].depth ? i : best, 0);
  if (start < 0) return [];
  const parents = new Map<number, { previous: number; point: { x: number; z: number } }>(), queue = [start], seen = new Set([start]);
  for (let cursor = 0; cursor < queue.length && !seen.has(goal); cursor++) {
    const current = queue[cursor], a = box(tiles[current]);
    for (let next = 0; next < tiles.length; next++) {
      if (seen.has(next)) continue;
      const b = box(tiles[next]); let point: { x: number; z: number } | undefined;
      const loZ = Math.max(a.minZ, b.minZ), hiZ = Math.min(a.maxZ, b.maxZ), loX = Math.max(a.minX, b.minX), hiX = Math.min(a.maxX, b.maxX);
      if (hiZ - loZ >= aisle && (Math.abs(a.maxX - b.minX) < 1e-7 || Math.abs(a.minX - b.maxX) < 1e-7)) point = { x: Math.abs(a.maxX - b.minX) < 1e-7 ? a.maxX : a.minX, z: (loZ + hiZ) / 2 };
      else if (hiX - loX >= aisle && (Math.abs(a.maxZ - b.minZ) < 1e-7 || Math.abs(a.minZ - b.maxZ) < 1e-7)) point = { x: (loX + hiX) / 2, z: Math.abs(a.maxZ - b.minZ) < 1e-7 ? a.maxZ : a.minZ };
      if (point) { parents.set(next, { previous: current, point }); seen.add(next); queue.push(next); }
    }
  }
  if (!seen.has(goal)) return tiles.map((tile, i) => ({ id: `blocked:${i}`, ...tile }));
  const route: number[] = [goal]; while (route.at(-1) !== start) route.push(parents.get(route.at(-1)!)!.previous); route.reverse();
  const points: { x: number; z: number }[] = [from];
  route.forEach((tile, i) => { points.push(tiles[tile]); if (i + 1 < route.length) points.push(parents.get(route[i + 1])!.point); });
  const reservations: FurnishingReservation[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    reservations.push({ id: `${i}:x`, x: (a.x + b.x) / 2, z: a.z, width: Math.abs(a.x - b.x) + aisle, depth: aisle },
      { id: `${i}:z`, x: b.x, z: (a.z + b.z) / 2, width: aisle, depth: Math.abs(a.z - b.z) + aisle });
  }
  return reservations;
}

/** Resolve editable family variants and place bounded relational groups. Required
 * items that cannot fit produce an error; callers must reject invalid results. */
export function furnishRoom(options: FurnishRoomOptions, catalog: FurnishingCatalog): FurnishingResult {
  const furniture: BuildingFurnitureRecipe[] = [], issues: FurnishingIssue[] = [], room = options.room;
  const diagnostics: FurnishingResult['diagnostics'] = { valid: false, issues, requested: 0, placed: 0, attempted: 0, omittedOptional: 0 };
  const fail = (code: string, message: string, ruleId?: string) => issues.push({ code, message, roomId: room?.id ?? 'unknown', ...(ruleId ? { ruleId } : {}) });
  if (!room || !validId(room.id) || !finiteBox(room) || !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff
    || !Array.isArray(options.rules) || options.rules.length > 24
    || options.reservations !== undefined && (!Array.isArray(options.reservations) || options.reservations.length > 256 || Array.from(options.reservations).some(r => !finiteBox(r)))
    || options.existing !== undefined && (!Array.isArray(options.existing) || options.existing.length > 128 || Array.from(options.existing).some(p => !finiteBox(p) || !validId(p.id) || !Number.isFinite(p.yaw ?? 0)))) {
    fail('input', 'Furnishing needs a finite room, unsigned seed and bounded rule/reservation arrays.'); return { furniture, diagnostics };
  }
  const inset = options.wallInset ?? .16, clearance = options.clearance ?? .18, attempts = options.maxAttempts ?? 64;
  if (![inset, clearance].every(n => Number.isFinite(n) && n >= 0 && n <= 5) || !Number.isInteger(attempts) || attempts < 1 || attempts > 128) {
    fail('limits', 'Insets/clearance must be 0–5m and attempts an integer from 1–128.'); return { furniture, diagnostics };
  }
  const footprintResult = compileBuildingFootprint(room.footprint ?? [room], room);
  if (!footprintResult.valid) { fail('footprint', footprintResult.issues.join(' ')); return { furniture, diagnostics }; }
  const footprint = footprintResult.footprint!;
  const boundary = box(room), reserved = (options.reservations ?? []).map(r => box(r));
  const orientation = room.orientation;
  if (orientation && (typeof orientation !== 'object' || Array.isArray(orientation)
    || orientation.front !== undefined && !sides.includes(orientation.front)
    || [orientation.focalPoint, orientation.entry].some(p => p !== undefined && (!pointValid(p) || !footprintContainsPoint(footprint, p))))) {
    fail('orientation', 'Room orientation needs a valid front and finite focal/entry points inside its footprint.'); return { furniture, diagnostics };
  }
  const occupied = (options.existing ?? []).map(p => box(p, p.yaw));
  const instanceIds = new Set((options.existing ?? []).map(p => p.id));
  if (instanceIds.size !== (options.existing?.length ?? 0)) fail('instance-id', 'Existing furniture IDs must be unique.');
  const ids = new Set<string>();
  for (const rule of options.rules) {
    if (!rule || !validId(rule.id, 32) || ids.has(rule.id) || !validId(rule.family)
      || !Number.isInteger(rule.count) || rule.count < 0 || rule.count > 32 || !Number.isInteger(rule.required ?? rule.count) || (rule.required ?? rule.count) < 0 || (rule.required ?? rule.count) > rule.count
      || !['wall', 'grid', 'free', 'center'].includes(rule.placement) || rule.zone && (!finiteBox(rule.zone) || !footprintContainsRectangle(footprint, rule.zone))
      || rule.wall !== undefined && !['north', 'south', 'east', 'west'].includes(rule.wall)
      || rule.yaw !== undefined && !Number.isFinite(rule.yaw) || rule.columns !== undefined && (!Number.isInteger(rule.columns) || rule.columns < 1 || rule.columns > 16)
      || rule.gap !== undefined && (!Number.isFinite(rule.gap) || rule.gap < 0 || rule.gap > 5)
      || !facingValid(rule.facing) || !preferencesValid(rule.preferences)
      || rule.seating && (!validId(rule.seating.family) || !Number.isInteger(rule.seating.count) || rule.seating.count < 1 || rule.seating.count > 8)) { fail('rule', 'Rule IDs, counts, placement and zone must be valid and bounded.', rule?.id); continue; }
    try { validateAssetGroupAttachments(rule.attachments); validateAssetGroupAttachments(attachmentRules(rule));
      if (rule.material !== undefined) validateSurfaceMaterialInput(rule.material);
      if (rule.dressing !== undefined) { validateAssetDressingArrangements(rule.dressing);
        (diagnostics.dressing ??= newDressingDiagnostics()).hostsRequested += rule.count; } }
    catch (error) { fail('rule', error instanceof Error ? error.message : 'Invalid asset attachments.', rule.id); continue; }
    ids.add(rule.id); diagnostics.requested += rule.count;
    if (rule.yaw === undefined && rule.facing !== undefined && directionFor(rule, room) === undefined
      || ((rule.preferences?.front ?? 0) > 0 || (rule.preferences?.back ?? 0) > 0) && !orientation?.front
      || (rule.preferences?.focalPoint ?? 0) > 0 && !orientation?.focalPoint || (rule.preferences?.entrance ?? 0) > 0 && !orientation?.entry)
      fail('orientation-context', 'Facing/preferences reference missing room orientation; supply front, focalPoint or entry as requested.', rule.id);
  }
  if (diagnostics.requested > 64) fail('item-budget', 'A room supports at most 64 requested groups.');
  if (issues.length) return { furniture, diagnostics };
  for (const rule of [...options.rules].sort((a, b) => compare(a.id, b.id))) {
    const area = rule.zone ?? room, areaBounds = box(area), columns = rule.columns ?? Math.max(1, Math.ceil(Math.sqrt(rule.count * area.width / area.depth))), rows = Math.max(1, Math.ceil(rule.count / columns));
    const scoring = Object.values(rule.preferences ?? {}).some(weight => weight > 0), directed = rule.facing !== undefined || scoring;
    const target = rule.yaw === undefined ? directionFor(rule, room) : undefined;
    let placed = 0;
    for (let index = 0; index < rule.count; index++) {
      const id = stableId(`${room.id}:${rule.id}:${index}`); let prototype: BuildingFurnitureRecipe[], dressingRecord: FurnishingDressingInstance | undefined;
      try {
        if (instanceIds.has(id)) throw new Error(`Furniture instance ${id} already exists; regenerate from an unfurnished source or use a new rule ID.`);
        const group = resolveAssetGroup(catalog, { family: rule.family, seed: options.seed, instanceId: id, parameters: rule.parameters, attachments: attachmentRules(rule) });
        let dressed: ReturnType<typeof assetDressingModel> | undefined;
        if (rule.dressing !== undefined) {
          const result = resolveAssetDressing(catalog, { model: group.instances[0].model, seed: options.seed, instanceId: id, arrangements: rule.dressing });
          dressingRecord = { roomId: room.id, ruleId: rule.id, instanceId: id, hostPlaced: false,
            arrangements: result.arrangements, diagnostics: result.diagnostics };
          const report = diagnostics.dressing!;
          report.instances.push(dressingRecord);
          for (const key of ['requested', 'placed', 'attempted', 'omittedOptional'] as const) report[key] += result.diagnostics[key];
          report.emptyChoices += result.arrangements.filter(selected => rule.dressing!.find(arrangement => arrangement.id === selected.id)
            ?.variants.find(variant => variant.id === selected.variantId)?.items.length === 0).length;
          if (!result.diagnostics.valid) {
            for (const issue of result.diagnostics.issues) fail('dressing', issue.message, rule.id);
            continue;
          }
          dressed = assetDressingModel(result, { id: group.instances[0].model.familyId, version: group.instances[0].model.version });
          if (group.instances.slice(1).reduce((count, instance) => count + instance.model.parts.length, dressed.model.parts.length) > ASSET_GROUP_LIMITS.parts
            || group.instances.slice(1).reduce((count, instance) => count + instance.model.colliders.length, dressed.model.colliders.length) > ASSET_GROUP_LIMITS.colliders)
            throw new Error('Dressed furniture and its socket attachments exceed the shared group geometry budget.');
        }
        prototype = group.instances.map((instance, index) => {
          if (instanceIds.has(instance.id)) throw new Error(`Furniture instance ${instance.id} already exists.`);
          const model = index === 0 && dressed ? dressed.model : instance.model, offset = index === 0 && dressed ? dressed.originOffset : { x: 0, y: 0, z: 0 };
          return { ...item(instance.id, room.id, model,
            instance.position.x + Math.cos(instance.yaw) * offset.x + Math.sin(instance.yaw) * offset.z,
            instance.position.z - Math.sin(instance.yaw) * offset.x + Math.cos(instance.yaw) * offset.z, instance.yaw, instance.position.y + offset.y),
            asset: instance.model.familyId,
            ...(rule.material === undefined ? {} : { material: validateSurfaceMaterialInput(rule.material) }) };
        });
      } catch (error) { fail('asset-resolution', error instanceof Error ? error.message : 'Asset family resolution failed.', rule.id); continue; }
      if (prototype.some((p, i) => prototype.some((other, j) => i < j && groupOverlap(p, other)))) {
        fail('group-overlap', 'Related asset sockets cause overlapping furniture footprints.', rule.id); continue;
      }
      let accepted: BuildingFurnitureRecipe[] | undefined, bestScore = -Infinity, bestTie = -Infinity;
      for (let attempt = 0; attempt < attempts && diagnostics.attempted < 4096; attempt++) {
        diagnostics.attempted++;
        let x = area.x, z = area.z, yaw = rule.yaw ?? 0;
        if (rule.placement === 'wall') {
          const sides = ['north', 'east', 'south', 'west'] as const, side = rule.wall ?? sides[(index + Math.floor(attempt / 8)) % 4];
          yaw = rule.yaw ?? (side === 'north' ? 0 : side === 'east' ? -Math.PI / 2 : side === 'south' ? Math.PI : Math.PI / 2);
          if (typeof target === 'string') yaw = facingYaw(target, x, z)!;
          const t = attempt === 0 ? (index + .5) / Math.max(1, rule.count) : .05 + .9 * random(options.seed, `${id}:wall:${attempt}`);
          const boxes = prototype.map(p => box({ x: Math.cos(yaw) * p.x + Math.sin(yaw) * p.z, z: -Math.sin(yaw) * p.x + Math.cos(yaw) * p.z, width: p.width, depth: p.depth }, yaw + (p.yaw ?? 0)));
          // Point-facing changes yaw with candidate position. Reserve the
          // group's circumradius at a wall so its exact final facing fits
          // without an iterative orientation/flush-position dependency.
          const radius = target && typeof target === 'object' ? Math.max(...boxes.flatMap(b => [Math.hypot(b.minX, b.minZ), Math.hypot(b.minX, b.maxZ), Math.hypot(b.maxX, b.minZ), Math.hypot(b.maxX, b.maxZ)])) : undefined;
          const extents = radius === undefined ? { minX: Math.min(...boxes.map(b => b.minX)), maxX: Math.max(...boxes.map(b => b.maxX)), minZ: Math.min(...boxes.map(b => b.minZ)), maxZ: Math.max(...boxes.map(b => b.maxZ)) }
            : { minX: -radius, maxX: radius, minZ: -radius, maxZ: radius };
          x = side === 'west' ? areaBounds.minX + inset - extents.minX : side === 'east' ? areaBounds.maxX - inset - extents.maxX : areaBounds.minX + inset - extents.minX + t * (area.width - inset * 2 - extents.maxX + extents.minX);
          z = side === 'north' ? areaBounds.minZ + inset - extents.minZ : side === 'south' ? areaBounds.maxZ - inset - extents.maxZ : areaBounds.minZ + inset - extents.minZ + t * (area.depth - inset * 2 - extents.maxZ + extents.minZ);
          if (room.footprint && !rule.zone) {
            const edges = footprint.edges.filter(edge => edge.side === side);
            const edge = edges[Math.floor(attempt / 4) % edges.length];
            if (!edge) continue;
            if (edge.axis === 'x') {
              x = edge.min + inset - extents.minX + t * (edge.max - edge.min - inset * 2 - extents.maxX + extents.minX);
              z = side === 'north' ? edge.at + inset - extents.minZ : edge.at - inset - extents.maxZ;
            } else {
              z = edge.min + inset - extents.minZ + t * (edge.max - edge.min - inset * 2 - extents.maxZ + extents.minZ);
              x = side === 'west' ? edge.at + inset - extents.minX : edge.at - inset - extents.maxX;
            }
          }
        } else if (rule.placement === 'grid' && attempt < columns * rows) {
          const cell = (index + attempt) % (columns * rows);
          x = areaBounds.minX + (cell % columns + .5) * area.width / columns;
          z = areaBounds.minZ + (Math.floor(cell / columns) + .5) * area.depth / rows;
        } else if (rule.placement !== 'center' || attempt > 0) {
          x = areaBounds.minX + inset + random(options.seed, `${id}:x:${attempt}`) * (area.width - inset * 2);
          z = areaBounds.minZ + inset + random(options.seed, `${id}:z:${attempt}`) * (area.depth - inset * 2);
        }
        if (directed) { x = coordinate(x); z = coordinate(z); }
        if (target !== undefined) { const facing = facingYaw(target, x, z); if (facing === undefined) continue; yaw = facing; }
        const c = Math.cos(yaw), s = Math.sin(yaw), candidates = prototype.map(p => ({ ...p,
          x: directed ? coordinate(x + c * p.x + s * p.z) : x + c * p.x + s * p.z,
          z: directed ? coordinate(z - s * p.x + c * p.z) : z - s * p.x + c * p.z,
          yaw: directed && p !== prototype[0] ? angle(yaw + (p.yaw ?? 0)) : yaw + (p.yaw ?? 0) }));
        const candidateBoxes = candidates.map(p => box(p, p.yaw));
        if (candidateBoxes.some(b => !inside(b, areaBounds, inset) || !inside(b, boundary, inset)
          || !footprintContainsRectangle(footprint, { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, width: b.maxX - b.minX, depth: b.maxZ - b.minZ }, inset)
          || reserved.some(r => overlap(b, r)) || occupied.some(o => overlap(b, o, rule.gap ?? clearance)))) continue;
        if (!scoring) { accepted = candidates; break; }
        const score = candidateScore({ x, z }, room, rule.preferences!), tie = Math.floor(random(options.seed, `${id}:rank:${attempt}`) * 4294967296);
        if (score > bestScore || score === bestScore && tie > bestTie) { accepted = candidates; bestScore = score; bestTie = tie; }
      }
      if (accepted && furniture.length + accepted.length <= 128) {
        furniture.push(...accepted); occupied.push(...accepted.map(p => box(p,p.yaw))); accepted.forEach(p => instanceIds.add(p.id)); placed++; diagnostics.placed++;
        if (dressingRecord) { dressingRecord.hostPlaced = true; diagnostics.dressing!.hostsPlaced++; }
      }
      else if (accepted) fail('item-budget', 'A room supports at most 128 generated furniture instances.', rule.id);
    }
    if (placed < (rule.required ?? rule.count)) fail('required-placement', `Required ${rule.required ?? rule.count} ${rule.family} groups; only ${placed} fit the room and clearances.`, rule.id);
    diagnostics.omittedOptional += Math.max(0, rule.count - placed - Math.max(0, (rule.required ?? rule.count) - placed));
  }
  diagnostics.valid = issues.length === 0;
  return { furniture, diagnostics };
}

/** Reserve door approaches, optional central circulation and complete stair
 * footprints/landings before furnishing any room. Coordinates remain editable. */
export function roomFurnishingReservations(recipe: BuildingRecipe, floor: BuildingFloorRecipe, room: BuildingRoomRecipe, circulation: 'center' | 'doors-only' = 'center'): FurnishingReservation[] {
  return roomReservations(recipe, floor, room, circulation, floorDoorReservations(recipe, floor));
}
function roomReservations(recipe: BuildingRecipe, floor: BuildingFloorRecipe, room: BuildingRoomRecipe, circulation: 'center' | 'doors-only', doorSpaces: FurnishingReservation[]): FurnishingReservation[] {
  const result: FurnishingReservation[] = [], r = box(room), radius = recipe.actor?.radius ?? .3, wall = recipe.wallThickness ?? .18, aisle = radius * 2 + .55;
  const footprint = compileBuildingFootprint(room.footprint ?? [room], room).footprint;
  if (!footprint) return result;
  for (const reservation of doorSpaces) if (footprint.tiles.some(tile => overlap(box(reservation), box(tile)))) result.push({ ...reservation });
  const add = (id: string, x: number, z: number, width: number, depth: number) => result.push({ id, x, z, width, depth });
  for (const opening of floor.openings ?? []) {
    if (opening.kind !== 'door' && opening.kind !== 'passage') continue;
    const owner = floor.rooms.find(candidate => candidate.id === opening.room); if (!owner) continue;
    const point = doorPoint(owner, opening); if (!point) continue;
    const { x, z, axis } = point;
    if (!footprintContainsPoint(footprint, point)) continue;
    add(`door:${opening.id}`, x, z, axis === 'x' ? opening.width + radius * 2 : aisle * 2, axis === 'z' ? opening.width + radius * 2 : aisle * 2);
    const touching = floor.rooms.filter(candidate => { const shape = compileBuildingFootprint(candidate.footprint ?? [candidate], candidate).footprint; return shape && footprintContainsPoint(shape, point); });
    const rise = Math.max(...touching.map(candidate => candidate.elevation ?? 0)) - (room.elevation ?? 0);
    if (rise > .001) {
      const run = opening.transition?.run ?? Math.max(1, rise / Math.tan(Math.min(recipe.actor?.maxSlopeDegrees ?? 35, 30) * Math.PI / 180), Math.ceil(rise / .18) * .22);
      // Reserve the full possible approach on both sides of this doorway.
      const approach = run + 2 * (radius * 2 + .12);
      add(`transition:${opening.id}`, x, z, axis === 'x' ? opening.width + wall + radius * 2 : approach * 2,
        axis === 'z' ? opening.width + wall + radius * 2 : approach * 2);
    }
    if (circulation === 'center') {
      if (room.footprint) for (const path of compoundAisles(footprint, point, aisle)) result.push({ ...path, id: `aisle:${opening.id}:${path.id}` });
      else {
        add(`aisle:${opening.id}:x`, (x + room.x) / 2, z, Math.abs(x - room.x) + aisle, aisle);
        add(`aisle:${opening.id}:z`, room.x, (z + room.z) / 2, aisle, Math.abs(z - room.z) + aisle);
      }
    }
  }
  for (const stair of recipe.stairs ?? []) if (stair.fromFloor === floor.id || stair.toFloor === floor.id) {
    const alongX = stair.direction === 'east' || stair.direction === 'west', width = (alongX ? stair.run + radius * 4 + .3 : stair.width) + wall,
      depth = (alongX ? stair.width : stair.run + radius * 4 + .3) + wall;
    if (overlap(box({ x: stair.x, z: stair.z, width, depth }), r)) add(`stair:${stair.id}`, stair.x, stair.z, width, depth);
  }
  return result;
}

/** Entrance context is inferred only when requested: an authored entry wins,
 * otherwise use the touching primary entrance or the room's sole doorway.
 * Ambiguous rooms require an explicit orientation.entry. */
export function furnishBuilding(input: BuildingRecipe, catalog: FurnishingCatalog, options: FurnishBuildingOptions): FurnishedBuilding {
  const recipe: BuildingRecipe = { ...input, ...(input.footprint ? { footprint: input.footprint.map(rectangle => ({ ...rectangle })) } : {}),
    ...(input.materials ? { materials: JSON.parse(JSON.stringify(input.materials)) } : {}), ...(input.doors ? { doors: JSON.parse(JSON.stringify(input.doors)) } : {}),
    floors: input.floors.map(floor => ({ ...floor, ...(floor.materials ? { materials: JSON.parse(JSON.stringify(floor.materials)) } : {}), ...(floor.doors ? { doors: JSON.parse(JSON.stringify(floor.doors)) } : {}),
      ...(floor.openings ? { openings: floor.openings.map(opening => ({ ...opening, ...(opening.door ? { door: JSON.parse(JSON.stringify(opening.door)) } : {}) })) } : {}), rooms: floor.rooms.map(room => ({ ...room,
      ...(room.materials ? { materials: JSON.parse(JSON.stringify(room.materials)) } : {}),
      ...(room.doorPolicy ? { doorPolicy: JSON.parse(JSON.stringify(room.doorPolicy)) } : {}),
      ...(room.footprint ? { footprint: room.footprint.map(rectangle => ({ ...rectangle })) } : {}),
      ...(room.orientation ? { orientation: { ...room.orientation,
        ...(room.orientation.entry ? { entry: { ...room.orientation.entry } } : {}),
        ...(room.orientation.focalPoint ? { focalPoint: { ...room.orientation.focalPoint } } : {}) } } : {}) })), furniture: [...(floor.furniture ?? [])] })) };
  const diagnostics: FurnishingResult['diagnostics'] = { valid: true, issues: [], requested: 0, placed: 0, attempted: 0, omittedOptional: 0 }, rooms: FurnishedBuilding['rooms'] = Object.create(null);
  if (!options.rooms || typeof options.rooms !== 'object' || Array.isArray(options.rooms) || Object.keys(options.rooms).length > 256) {
    diagnostics.valid = false; diagnostics.issues.push({ code: 'room-requests', message: 'Building furnishing needs a bounded dictionary of at most256 room requests.', roomId: 'unknown' });
    return { recipe, diagnostics, rooms };
  }
  const knownRooms = new Set(recipe.floors.flatMap(floor => floor.rooms.map(room => room.id)));
  const doorSpaces = new Map<BuildingFloorRecipe, FurnishingReservation[]>();
  // Check declared door rules on every floor, even if no furnishing is requested
  // there. Cache each resolved motion envelope once for all adjoining rooms.
  for (const floor of recipe.floors) try { doorSpaces.set(floor, floorDoorReservations(recipe, floor)); }
  catch (error) {
    diagnostics.valid = false; diagnostics.issues.push({ code: 'door-reservation',
      message: error instanceof Error ? error.message : 'Door intent or motion space is invalid.', roomId: floor.rooms[0]?.id ?? 'unknown' });
  }
  if (!diagnostics.valid) return { recipe, diagnostics, rooms };
  for (const floor of recipe.floors) for (const room of floor.rooms) {
    const request = Object.hasOwn(options.rooms, room.id) ? options.rooms[room.id] : undefined; if (!request) continue;
    if (request.circulation !== undefined && !['center', 'doors-only'].includes(request.circulation)) {
      const issue = { code: 'circulation', message: 'Circulation must be center or doors-only.', roomId: room.id };
      diagnostics.valid = false; diagnostics.issues.push(issue); rooms[room.id] = { valid: false, issues: [issue], requested: 0, placed: 0, attempted: 0, omittedOptional: 0 }; continue;
    }
    let circulation: FurnishingReservation[];
    try {
      circulation = roomReservations(recipe, floor, room, request.circulation ?? 'center', doorSpaces.get(floor)!);
    } catch (error) {
      const issue = { code: 'door-reservation', message: error instanceof Error ? error.message : 'Door intent or motion space is invalid.', roomId: room.id };
      diagnostics.valid = false; diagnostics.issues.push(issue); rooms[room.id] = { valid: false, issues: [issue], requested: 0, placed: 0, attempted: 0, omittedOptional: 0 }; continue;
    }
    const needsEntry = Array.isArray(request.rules) && request.rules.some(rule => rule && (rule.yaw === undefined && rule.facing === 'entrance' || (rule.preferences?.entrance ?? 0) > 0));
    if (needsEntry && !room.orientation?.entry) {
      const doors = circulation.filter(r => r.id.startsWith('door:'));
      const entry = doors.find(r => r.id === `door:${recipe.primaryEntrance}`) ?? (doors.length === 1 ? doors[0] : undefined);
      if (entry) room.orientation = { ...room.orientation, entry: { x: entry.x, z: entry.z } };
    }
    // Buildings accept signed safe-integer seeds; asset families use uint32.
    // Preserve invalid values so furnishRoom still reports them instead of coercing.
    const inheritedSeed = recipe.seed ?? 0;
    const result = furnishRoom({ seed: options.seed ?? (Number.isSafeInteger(inheritedSeed) ? inheritedSeed >>> 0 : inheritedSeed), room, rules: request.rules,
      reservations: [...circulation, ...(request.reservations ?? [])],
      existing: floor.furniture?.filter(p => p.room === room.id), wallInset: (recipe.wallThickness ?? .18) / 2 + .12 }, catalog);
    floor.furniture!.push(...result.furniture); rooms[room.id] = result.diagnostics;
    diagnostics.issues.push(...result.diagnostics.issues); diagnostics.valid &&= result.diagnostics.valid;
    for (const key of ['requested', 'placed', 'attempted', 'omittedOptional'] as const) diagnostics[key] += result.diagnostics[key];
    if (result.diagnostics.dressing) mergeDressingDiagnostics(diagnostics.dressing ??= newDressingDiagnostics(), result.diagnostics.dressing);
  }
  for (const roomId of Object.keys(options.rooms)) if (!knownRooms.has(roomId)) {
    diagnostics.valid = false; diagnostics.issues.push({ code: 'unknown-room', message: `Unknown furnishing room ${roomId}.`, roomId });
  }
  return { recipe, diagnostics, rooms };
}
