/** Pure, explicit architectural fixtures. Asset +Z faces into the room; -Z is
 * the wall-mount back. Ceiling mounts retain their authored asset orientation.
 * Fit checks conservatively use upright part boxes, including decorative parts. */
import { BUILDING_LIMITS, compileBuilding, type BuildingFloorRecipe, type BuildingIssue, type BuildingManifest, type BuildingPart,
  type BuildingRecipe, type BuildingRoomRecipe, type BuildingSide } from './building.ts';
import { transformAssetColliders, validateAssetManifest, type AssetCatalog, type AssetManifest,
  type AssetParameterValue } from './assetFamilies.ts';
import { resolveBuildingAttachment } from './buildingAttachments.ts';
import { compileBuildingFootprint, footprintContainsRectangle, type BuildingFootprint, type BuildingFootprintEdge } from './buildingFootprints.ts';
import { directionYaw, spatialAngle, spatialCoordinate as snap, transformSpatialPoint } from './spatial.ts';
import type { PhysicsCollider, PhysicsVector } from './physics.ts';
import { resolveSurfaceMaterial, validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';

export interface BuildingFixtureLight {
  /** An authored model socket outside the housing, aimed into unobstructed space. */
  socket: string;
  /** Explicit points are building-local. Defaults to down on ceilings, room on walls. */
  target?: 'down' | 'room' | PhysicsVector;
  color?: string; intensity?: number; range?: number; angle?: number; penumbra?: number; castShadow?: boolean;
}
export type BuildingFixtureMount = { surface: 'ceiling'; position: { x: number; z: number }; yaw?: number; gap?: number }
  | { surface: 'wall'; side: BuildingSide; edge?: number; offset?: number;
    /** Model base above this room's walking floor, including its elevation. */
    height: number; gap?: number };
export interface BuildingFixtureRecipe { id: string; room: string; model: AssetManifest; mount: BuildingFixtureMount; light?: BuildingFixtureLight; material?: SurfaceMaterialInput }
export interface ResolvedFixtureLight {
  id: string; buildingId: string; roomId: string;
  position: [number, number, number]; target: [number, number, number];
  color?: string; intensity?: number; range?: number; angle?: number; penumbra?: number; castShadow?: boolean;
}
export interface BuildingFixtureResolution { parts: BuildingPart[]; colliders: PhysicsCollider[]; lights: ResolvedFixtureLight[]; issues: BuildingIssue[] }
export interface BuildingFixtureRule {
  id: string; family: string; parameters?: Record<string, AssetParameterValue>;
  placement: 'ceiling-center' | 'ceiling-grid' | 'ceiling-quadrants' | 'wall-spaced';
  count?: number | [number, number];
  /** Counts per square metre of actual room area, rounded with a keyed seed. */
  density?: { perSquareMetre: number; min: number; max: number };
  /** Defaults to the resolved requested count. Lower explicitly for optional slots. */
  required?: number; columns?: number; margin?: number; gap?: number; yaw?: number;
  side?: BuildingSide; edge?: number; height?: number; light?: BuildingFixtureLight;
  /** Fills model parts without an authored per-part texture. */
  material?: SurfaceMaterialInput;
}
export interface FurnishBuildingFixturesOptions { seed?: number; rooms: Record<string, { rules: BuildingFixtureRule[] }> }
export interface FurnishedBuildingFixtures {
  recipe: BuildingRecipe;
  diagnostics: { valid: boolean; issues: BuildingIssue[]; requested: number; placed: number; attempted: number; omittedOptional: number };
}
export const BUILDING_FIXTURE_LIMITS = Object.freeze({ perRoom: 32, perFloor: 64, rulesPerRoom: 16, candidates: 512, issues: 128 });
const EPS = 1e-6;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const keys = (v: object, names: string[]) => Object.keys(v).every(key => names.includes(key));
const sides = ['north', 'south', 'east', 'west'] as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const bounded = (n: unknown, min: number, max: number) => finite(n) && n >= min && n <= max;
const countValid = (n: unknown) => Number.isInteger(n) && bounded(n, 0, BUILDING_FIXTURE_LIMITS.perRoom);
const issue = (code: string, message: string, ...ids: string[]): BuildingIssue => ({ code, message, ...(ids.length ? { ids } : {}) });
const copyLight = (light: BuildingFixtureLight): BuildingFixtureLight => ({ ...light,
  ...(light.target && typeof light.target === 'object' ? { target: { ...light.target } } : {}) });
function copyFixture(fixture: BuildingFixtureRecipe): BuildingFixtureRecipe {
  return { ...fixture, model: validateAssetManifest(fixture.model), mount: fixture.mount.surface === 'ceiling'
    ? { ...fixture.mount, position: { ...fixture.mount.position } } : { ...fixture.mount }, ...(fixture.light ? { light: copyLight(fixture.light) } : {}),
    ...(fixture.material ? { material: validateSurfaceMaterialInput(fixture.material) } : {}) };
}
function random(seed: number, key: string): number {
  let h = seed >>> 0; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); return ((h ^ h >>> 16) >>> 0) / 4294967296;
}
function stableId(key: string): string { return key.length <= 96 ? key : `${key.slice(0, 72)}:${[0, 0x6d2b79f5].map(seed => Math.floor(random(seed, key) * 4294967296).toString(16).padStart(8, '0')).join('')}`; }
function structuralIds(recipe: BuildingRecipe): Set<string> {
  return new Set([...recipe.floors.flatMap(floor => [floor.id, ...floor.rooms.map(room => room.id), ...(floor.openings ?? []).map(opening => opening.id),
    ...(floor.furniture ?? []).map(furniture => furniture.id)]), ...(recipe.stairs ?? []).map(stair => stair.id)]);
}
function shape(room: BuildingRoomRecipe): BuildingFootprint {
  const result = compileBuildingFootprint(room.footprint ?? [{ x: room.x, z: room.z, width: room.width, depth: room.depth }]);
  if (!result.footprint) throw new Error('Fixture room has no valid footprint.');
  return result.footprint;
}
type Body = { x: number; z: number; minY: number; maxY: number; width: number; depth: number; yaw: number };
const isFixturePart = (part: BuildingPart) => typeof part.fixtureId === 'string' && part.kind === 'furniture' && part.model !== undefined;
function bodies(model: AssetManifest, position: PhysicsVector, yaw: number): Body[] {
  return model.parts.map(part => ({ ...transformSpatialPoint(part.position, position, yaw), minY: snap(position.y + part.position.y - part.size.y / 2),
    maxY: snap(position.y + part.position.y + part.size.y / 2), width: part.size.x, depth: part.size.z, yaw: spatialAngle(yaw + (part.yaw ?? 0)) }));
}
function envelope(body: Body) {
  const c = Math.abs(Math.cos(body.yaw)), s = Math.abs(Math.sin(body.yaw));
  return { x: body.x, z: body.z, width: snap(c * body.width + s * body.depth), depth: snap(s * body.width + c * body.depth) };
}
function overlaps(a: Body, b: Body): boolean {
  if (Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) <= EPS) return false;
  const axes = (yaw: number) => [{ x: Math.cos(yaw), z: -Math.sin(yaw) }, { x: Math.sin(yaw), z: Math.cos(yaw) }];
  const aa = axes(a.yaw), bb = axes(b.yaw), dot = (u: { x: number; z: number }, v: { x: number; z: number }) => u.x * v.x + u.z * v.z;
  return [...aa, ...bb].every(axis => Math.abs((a.x - b.x) * axis.x + (a.z - b.z) * axis.z)
    < Math.abs(dot(aa[0], axis)) * a.width / 2 + Math.abs(dot(aa[1], axis)) * a.depth / 2
      + Math.abs(dot(bb[0], axis)) * b.width / 2 + Math.abs(dot(bb[1], axis)) * b.depth / 2 - EPS);
}
function localPoint(building: BuildingManifest, position: PhysicsVector): PhysicsVector {
  const origin = building.recipe.origin ?? { x: 0, y: 0, z: 0 };
  return { ...transformSpatialPoint({ x: position.x - origin.x, z: position.z - origin.z }, { x: 0, z: 0 }, -(building.recipe.yaw ?? 0)), y: snap(position.y - origin.y) };
}
function worldPoint(building: BuildingManifest, position: PhysicsVector): PhysicsVector {
  const origin = building.recipe.origin ?? { x: 0, y: 0, z: 0 };
  return { ...transformSpatialPoint(position, origin, building.recipe.yaw ?? 0), y: snap(position.y + origin.y) };
}
function wallCovered(building: BuildingManifest, floor: BuildingFloorRecipe, edge: BuildingFootprintEdge, low: number, high: number, bottom: number, top: number): boolean {
  // Subtract the actual wall rectangles. Door/window openings and concave edges
  // remain holes; the room's bounding rectangle is never treated as a wall.
  let remaining = [{ x0: low, x1: high, y0: bottom, y1: top }];
  for (const part of building.parts) {
    if (part.kind !== 'wall' || part.floorId !== floor.id) continue;
    const p = localPoint(building, part.position), at = edge.axis === 'x' ? p.z : p.x;
    if (Math.abs(at - edge.at) > EPS) continue;
    const center = edge.axis === 'x' ? p.x : p.z, size = edge.axis === 'x' ? part.size.x : part.size.z;
    const cut = { x0: center - size / 2, x1: center + size / 2, y0: p.y - part.size.y / 2, y1: p.y + part.size.y / 2 };
    remaining = remaining.flatMap(rect => {
      const x0 = Math.max(rect.x0, cut.x0), x1 = Math.min(rect.x1, cut.x1), y0 = Math.max(rect.y0, cut.y0), y1 = Math.min(rect.y1, cut.y1);
      if (x1 - x0 <= EPS || y1 - y0 <= EPS) return [rect];
      return [{ x0: rect.x0, x1: x0, y0: rect.y0, y1: rect.y1 }, { x0: x1, x1: rect.x1, y0: rect.y0, y1: rect.y1 },
        { x0, x1, y0: rect.y0, y1: y0 }, { x0, x1, y0: y1, y1: rect.y1 }].filter(r => r.x1 - r.x0 > EPS && r.y1 - r.y0 > EPS);
    });
    if (!remaining.length) return true;
    if (remaining.length > 512) return false;
  }
  return !remaining.length;
}
function lightValid(light: BuildingFixtureLight | undefined): boolean {
  if (light === undefined) return true;
  if (!plain(light) || !keys(light, ['socket', 'target', 'color', 'intensity', 'range', 'angle', 'penumbra', 'castShadow']) || !id(light.socket)) return false;
  const target = light.target;
  return (target === undefined || target === 'down' || target === 'room' || plain(target) && keys(target, ['x', 'y', 'z']) && [target.x, target.y, target.z].every(v => bounded(v, -10000, 10000)))
    && (light.color === undefined || typeof light.color === 'string' && /^#[0-9a-f]{6}$/i.test(light.color))
    && (light.intensity === undefined || bounded(light.intensity, 0, 100000)) && (light.range === undefined || finite(light.range) && light.range > .1 && light.range <= 1000)
    && (light.angle === undefined || finite(light.angle) && light.angle > 0 && light.angle <= Math.PI / 2)
    && (light.penumbra === undefined || bounded(light.penumbra, 0, 1)) && (light.castShadow === undefined || typeof light.castShadow === 'boolean');
}
function rayHitsHousing(model: AssetManifest, from: PhysicsVector, to: PhysicsVector): boolean {
  for (const part of model.parts) {
    const a = transformSpatialPoint({ x: from.x - part.position.x, z: from.z - part.position.z }, { x: 0, z: 0 }, -(part.yaw ?? 0));
    const b = transformSpatialPoint({ x: to.x - part.position.x, z: to.z - part.position.z }, { x: 0, z: 0 }, -(part.yaw ?? 0));
    const start = [a.x, from.y - part.position.y, a.z], delta = [b.x - a.x, to.y - from.y, b.z - a.z], extent = [part.size.x / 2, part.size.y / 2, part.size.z / 2];
    let low = 0, high = 1;
    for (let axis = 0; axis < 3 && high >= low; axis++) {
      const radius = extent[axis] - EPS;
      if (Math.abs(delta[axis]) < EPS) { if (Math.abs(start[axis]) >= radius) high = -1; }
      else { const first = (-radius - start[axis]) / delta[axis], last = (radius - start[axis]) / delta[axis]; low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last)); }
    }
    if (high >= low && high >= 0 && low <= 1) return true;
  }
  return false;
}
interface ResolvedOne { part: BuildingPart; colliders: PhysicsCollider[]; light?: ResolvedFixtureLight; bodies: Body[] }
function resolveOne(building: BuildingManifest, floor: BuildingFloorRecipe, fixture: BuildingFixtureRecipe, occupied: Body[]): ResolvedOne {
  if (!plain(fixture) || !keys(fixture, ['id', 'room', 'model', 'mount', 'light', 'material']) || !id(fixture.id) || !id(fixture.room) || !plain(fixture.mount) || !lightValid(fixture.light)) throw new Error('Fixture requires a stable ID, room, model, mount and valid authored light options.');
  const room = floor.rooms.find(room => room.id === fixture.room);
  if (!room) throw new Error('Fixture room must belong to its floor.');
  const model = validateAssetManifest(fixture.model), mount = fixture.mount, footprint = shape(room), wall = (building.recipe.wallThickness ?? .18) / 2;
  if (mount.gap !== undefined && !bounded(mount.gap, 0, 8)) throw new Error('Fixture gap must be between 0 and 8 metres.');
  const roomY = floor.y + (room.elevation ?? 0);
  let position: PhysicsVector, yaw = 0;
  if (mount.surface === 'ceiling') {
    if (!keys(mount, ['surface', 'position', 'yaw', 'gap']) || mount.yaw !== undefined && !bounded(mount.yaw, -1e6, 1e6)) throw new Error('Ceiling fixture requires local X/Z and an optional finite yaw.');
    const attachment = resolveBuildingAttachment(building, model, { attachment: { surface: 'ceiling', floorId: floor.id, ...(mount.gap === undefined ? {} : { gap: mount.gap }) }, position: mount.position, ...(mount.yaw === undefined ? {} : { yaw: mount.yaw }) });
    if (!attachment.position) throw new Error(attachment.diagnostics.issues.map(i => i.message).join(' '));
    position = attachment.position; yaw = spatialAngle(mount.yaw ?? 0);
  } else if (mount.surface === 'wall') {
    if (!keys(mount, ['surface', 'side', 'edge', 'offset', 'height', 'gap']) || !sides.includes(mount.side)
      || mount.edge !== undefined && (!Number.isInteger(mount.edge) || !bounded(mount.edge, 0, 127))
      || !bounded(mount.height, 0, 20) || mount.offset !== undefined && !bounded(mount.offset, -128, 128)) throw new Error('Wall fixture needs a side, bounded edge/offset and model-base height above the room floor.');
    const edges = footprint.edges.filter(e => e.side === mount.side), edge = edges[mount.edge ?? 0];
    if (!edge) throw new Error('Wall fixture edge does not exist on the actual room footprint.');
    yaw = spatialAngle(directionYaw(mount.side) + Math.PI);
    const t = (edge.min + edge.max) / 2 + (mount.offset ?? 0), inset = wall + (mount.gap ?? 0) - model.bounds.min.z;
    const inward = { x: Math.sin(yaw), z: Math.cos(yaw) };
    position = { x: snap((edge.axis === 'x' ? t : edge.at) + inward.x * inset), y: snap(roomY + mount.height - model.bounds.min.y), z: snap((edge.axis === 'x' ? edge.at : t) + inward.z * inset) };
    if (!wallCovered(building, floor, edge, t + model.bounds.min.x, t + model.bounds.max.x, position.y + model.bounds.min.y, position.y + model.bounds.max.y)) throw new Error('The whole fixture back must fit an existing solid wall, clear of doors, windows and missing boundary segments.');
  } else throw new Error('Fixture mount must explicitly choose ceiling or wall.');
  const boxes = bodies(model, position, yaw), actorHeight = building.recipe.actor?.height ?? 1.8;
  const slabs: Body[] = mount.surface === 'wall' ? building.parts.filter(part => (part.kind === 'floor' || part.kind === 'roof')
    && Math.abs(part.rotation.x) + Math.abs(part.rotation.z) < EPS).map(part => {
    const p = localPoint(building, part.position);
    return { x: p.x, z: p.z, minY: p.y - part.size.y / 2, maxY: p.y + part.size.y / 2, width: part.size.x, depth: part.size.z, yaw: 0 };
  }) : [];
  for (const box of boxes) {
    const rect = envelope(box);
    if (!footprintContainsRectangle(footprint, rect, Math.max(0, wall - EPS))) throw new Error('Fixture footprint crosses its room walls or a concave boundary.');
    if (box.minY < roomY + actorHeight - EPS || box.maxY > floor.y + floor.height + EPS) throw new Error('Fixture body must leave actor headroom and remain below the room ceiling.');
    // A higher floor's slab can extend below the declared storey ceiling,
    // especially beneath raised rooms. Wall contact does not exempt its body
    // from those real volumes; an open roof intentionally contributes none.
    if (slabs.some(slab => overlaps(box, slab))) throw new Error('Fixture body intersects a compiled floor or ceiling slab.');
    for (const surface of building.surfaces) if (surface.kind === 'stair') {
      const x0 = Math.max(rect.x - rect.width / 2, surface.minX), x1 = Math.min(rect.x + rect.width / 2, surface.maxX), z0 = Math.max(rect.z - rect.depth / 2, surface.minZ), z1 = Math.min(rect.z + rect.depth / 2, surface.maxZ);
      if (x1 - x0 > EPS && z1 - z0 > EPS) {
        const high = surface.y + surface.slopeX * ((surface.slopeX >= 0 ? x1 : x0) - surface.centerX) + surface.slopeZ * ((surface.slopeZ >= 0 ? z1 : z0) - surface.centerZ);
        const low = surface.y + surface.slopeX * ((surface.slopeX >= 0 ? x0 : x1) - surface.centerX) + surface.slopeZ * ((surface.slopeZ >= 0 ? z0 : z1) - surface.centerZ);
        if (low < box.maxY && box.minY < high + actorHeight - EPS) throw new Error('Fixture body obstructs stair or transition headroom.');
      }
    }
    if (occupied.some(other => overlaps(box, other))) throw new Error('Fixture body overlaps furniture, a door motion envelope, or another fixture.');
  }
  const world = worldPoint(building, position), worldYaw = spatialAngle((building.recipe.yaw ?? 0) + yaw), key = `${building.id}:fixture:${fixture.id}`;
  if (building.parts.some(part => !isFixturePart(part) && part.id === key)) throw new Error('Generated fixture part ID collides with a structural part ID.');
  const part: BuildingPart = { id: key, kind: 'furniture', position: { ...world, y: snap(world.y + model.size.y / 2) }, size: { ...model.size },
    rotation: { x: 0, y: snap(Math.sin(worldYaw / 2)), z: 0, w: snap(Math.cos(worldYaw / 2)) }, color: model.parts[0].color,
    collidable: model.colliders.length > 0, visible: true, exterior: false, floorId: floor.id, roomId: room.id, fixtureId: fixture.id, model,
    ...(fixture.material === undefined ? {} : { material: resolveSurfaceMaterial(fixture.material, { seed: (building.recipe.seed ?? 0) >>> 0, key }) }) };
  let light: ResolvedFixtureLight | undefined;
  if (fixture.light) {
    const options = fixture.light, socket = model.sockets.find(socket => socket.id === options.socket);
    if (!socket) throw new Error(`Fixture emitter socket ${options.socket} is missing from its model.`);
    const emitter = { ...transformSpatialPoint(socket.position, position, yaw), y: snap(position.y + socket.position.y) };
    const targetMode = options.target ?? (mount.surface === 'ceiling' ? 'down' : 'room');
    const target = typeof targetMode === 'object' ? { x: snap(targetMode.x), y: snap(targetMode.y), z: snap(targetMode.z) }
      : targetMode === 'down' ? { ...emitter, y: snap(emitter.y - 1) } : { x: room.x, y: snap(roomY + Math.min(1, actorHeight / 2)), z: room.z };
    if (Math.hypot(target.x - emitter.x, target.y - emitter.y, target.z - emitter.z) <= EPS) throw new Error('Fixture light target must differ from its emitter.');
    const targetLocal = { ...transformSpatialPoint({ x: target.x - position.x, z: target.z - position.z }, { x: 0, z: 0 }, -yaw), y: target.y - position.y };
    if (rayHitsHousing(model, socket.position, targetLocal)) throw new Error('Fixture emitter socket or outgoing light direction intersects its housing.');
    const p = worldPoint(building, emitter), t = worldPoint(building, target);
    light = { id: stableId(key), buildingId: building.id, roomId: room.id, position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
    for (const name of ['color', 'intensity', 'range', 'angle', 'penumbra', 'castShadow'] as const) if (options[name] !== undefined) Object.assign(light, { [name]: options[name] });
  }
  return { part, colliders: transformAssetColliders(model, world, worldYaw), ...(light ? { light } : {}), bodies: boxes };
}
function furnitureBodies(building: BuildingManifest): Body[] {
  const result: Body[] = [];
  for (const floor of building.recipe.floors) for (const item of floor.furniture ?? []) {
    const room = floor.rooms.find(room => room.id === item.room);
    if (!room) continue;
    const y = floor.y + (room.elevation ?? 0) + (item.y ?? 0);
    if (item.model) result.push(...bodies(item.model, { x: item.x, y, z: item.z }, item.yaw ?? 0));
    else result.push({ x: item.x, z: item.z, minY: y, maxY: y + item.height, width: item.width, depth: item.depth, yaw: item.yaw ?? 0 });
  }
  // Door frames/current leaves are real authored geometry, and their complete
  // motion envelopes must also stay clear even when the stored pose is closed.
  // Using compiler metadata avoids a second policy/geometry selection here.
  for (const part of building.parts) if (part.kind === 'door') {
    const position = localPoint(building, part.position), yaw = spatialAngle(2 * Math.atan2(part.rotation.y, part.rotation.w) - (building.recipe.yaw ?? 0));
    if (part.model) result.push(...bodies(part.model, { ...position, y: position.y - part.size.y / 2 }, yaw));
    else result.push({ x: position.x, z: position.z, minY: position.y - part.size.y / 2, maxY: position.y + part.size.y / 2, width: part.size.x, depth: part.size.z, yaw });
  }
  for (const door of building.doors ?? []) for (const reservation of door.reservations)
    result.push({ ...reservation, minY: door.baseY, maxY: door.baseY + door.height, yaw: 0 });
  return result;
}
/** Called after structural geometry exists. Inputs must be structurally valid;
 * returned parts/colliders/lights are additions, never mutations of the manifest.
 * Resolve again safely: existing fixture wrappers are not collision obstacles. */
export function resolveBuildingFixtures(building: BuildingManifest): BuildingFixtureResolution {
  const result: BuildingFixtureResolution = { parts: [], colliders: [], lights: [], issues: [] };
  if (!building?.diagnostics?.valid || !Array.isArray(building.recipe?.floors) || building.recipe.floors.length > 8
    || !Array.isArray(building.parts) || building.parts.length > 4096 || !Array.isArray(building.surfaces) || building.surfaces.length > 4096
    || Array.from(building.recipe.floors).some(floor => !floor || !Array.isArray(floor.rooms) || floor.rooms.length > 32 || Array.from(floor.rooms).some(room => !room)
      || floor.furniture !== undefined && (!Array.isArray(floor.furniture) || floor.furniture.length > 128 || Array.from(floor.furniture).some(item => !item)))) {
    result.issues.push(issue('fixture-building', 'Fixtures require a structurally valid compiled building.')); return result;
  }
  const occupied = furnitureBodies(building), ids = structuralIds(building.recipe), roomCounts = new Map<string, number>();
  let partCount = building.parts.filter(part => !isFixturePart(part)).reduce((sum, part) => sum + (part.model?.parts.length ?? 1), 0);
  // Existing fixture collider IDs are not retained by physics, so derive the
  // structural count from retained parts when this is a standalone re-resolution.
  let colliderCount = building.parts.filter(part => !isFixturePart(part) && part.collidable).reduce((sum, part) => sum + (part.model?.colliders.length ?? 1), 0);
  for (const floor of building.recipe.floors) {
    const fixtures = floor.fixtures ?? [];
    if (!Array.isArray(fixtures) || fixtures.length > BUILDING_FIXTURE_LIMITS.perFloor || Array.from(fixtures).some(item => !plain(item))) {
      result.issues.push(issue('fixture-budget', 'Each floor supports at most 64 plain fixture recipes; sparse arrays are invalid.', floor.id)); continue;
    }
    for (const fixture of [...fixtures].sort((a, b) => compare(String(a.id), String(b.id)))) {
      try {
        if (!id(fixture.id) || ids.has(fixture.id)) throw new Error('Fixture IDs must be stable and unique throughout the building.');
        ids.add(fixture.id); const count = (roomCounts.get(fixture.room) ?? 0) + 1; roomCounts.set(fixture.room, count);
        if (count > BUILDING_FIXTURE_LIMITS.perRoom) throw new Error('A room supports at most 32 fixtures.');
        const resolved = resolveOne(building, floor, fixture, occupied);
        if (partCount + fixture.model.parts.length > BUILDING_LIMITS.parts || colliderCount + resolved.colliders.length > BUILDING_LIMITS.colliders) throw new Error('Fixtures exceed the building part/collider budget.');
        partCount += fixture.model.parts.length; colliderCount += resolved.colliders.length;
        result.parts.push(resolved.part); result.colliders.push(...resolved.colliders); if (resolved.light) result.lights.push(resolved.light); occupied.push(...resolved.bodies);
      } catch (error) { if (result.issues.length < BUILDING_FIXTURE_LIMITS.issues) result.issues.push(issue('fixture-fit', error instanceof Error ? error.message : 'Fixture cannot fit.', String(fixture.id))); }
    }
  }
  return result;
}

function validateRule(rule: BuildingFixtureRule): void {
  if (!plain(rule) || !keys(rule, ['id', 'family', 'parameters', 'placement', 'count', 'density', 'required', 'columns', 'margin', 'gap', 'yaw', 'side', 'edge', 'height', 'light', 'material'])
    || !id(rule.id) || !id(rule.family) || !['ceiling-center', 'ceiling-grid', 'ceiling-quadrants', 'wall-spaced'].includes(rule.placement)
    || rule.parameters !== undefined && (!plain(rule.parameters) || Object.keys(rule.parameters).length > 24 || Object.values(rule.parameters).some(v => typeof v !== 'string' && !finite(v)))
    || !lightValid(rule.light)) throw new Error('Fixture rule has invalid IDs, placement, parameters or light options.');
  if (rule.material !== undefined) validateSurfaceMaterialInput(rule.material);
  if (rule.count !== undefined && !(countValid(rule.count) || Array.isArray(rule.count) && rule.count.length === 2 && Array.from(rule.count).every(countValid) && rule.count[0] <= rule.count[1])) throw new Error('Fixture count must be 0–32 or a [minimum,maximum] integer pair.');
  if (rule.density !== undefined && (!plain(rule.density) || !keys(rule.density, ['perSquareMetre', 'min', 'max']) || rule.count !== undefined
    || !bounded(rule.density.perSquareMetre, 0, 32) || !countValid(rule.density.min) || !countValid(rule.density.max) || rule.density.min > rule.density.max)) throw new Error('Fixture density requires a bounded rate and min/max counts; omit count.');
  if (rule.required !== undefined && !countValid(rule.required) || rule.columns !== undefined && (!Number.isInteger(rule.columns) || !bounded(rule.columns, 1, 32))
    || rule.margin !== undefined && !bounded(rule.margin, 0, 16) || rule.gap !== undefined && !bounded(rule.gap, 0, 8)
    || rule.yaw !== undefined && !bounded(rule.yaw, -1e6, 1e6)) throw new Error('Fixture rule counts, spacing and yaw must be finite and bounded.');
  if (rule.placement === 'wall-spaced') {
    if (!sides.includes(rule.side!) || !bounded(rule.height, 0, 20) || rule.yaw !== undefined || rule.edge !== undefined && (!Number.isInteger(rule.edge) || !bounded(rule.edge, 0, 127))) throw new Error('Wall-spaced fixtures require side and model-base height; wall direction determines yaw.');
  } else if (rule.side !== undefined || rule.edge !== undefined || rule.height !== undefined) throw new Error('Wall side/edge/height are only valid for wall-spaced placement.');
}
function requestedCount(rule: BuildingFixtureRule, area: number, roll: number): number {
  if (rule.density) { const raw = area * rule.density.perSquareMetre; return Math.max(rule.density.min, Math.min(rule.density.max, Math.floor(raw) + (roll < raw % 1 ? 1 : 0))); }
  if (Array.isArray(rule.count)) return rule.count[0] + Math.floor(roll * (rule.count[1] - rule.count[0] + 1));
  return rule.count ?? (rule.placement === 'ceiling-quadrants' ? 4 : 1);
}
function candidates(rule: BuildingFixtureRule, room: BuildingRoomRecipe, count: number): BuildingFixtureMount[] {
  const gap = rule.gap === undefined ? {} : { gap: rule.gap }, yaw = rule.yaw === undefined ? {} : { yaw: spatialAngle(rule.yaw) }, margin = rule.margin ?? .3;
  if (rule.placement === 'wall-spaced') {
    const edge = shape(room).edges.filter(e => e.side === rule.side)[rule.edge ?? 0];
    if (!edge) return [];
    const length = edge.max - edge.min - margin * 2, n = Math.min(64, Math.max(count, count * 3));
    if (length <= 0) return [];
    const offsets = [...new Set([count, n].flatMap(length => Array.from({ length }, (_, index) => snap(((index + .5) / length - .5) * (edge.max - edge.min - margin * 2)))))];
    return offsets.map(offset => ({ surface: 'wall', side: rule.side!, ...(rule.edge === undefined ? {} : { edge: rule.edge }), offset, height: rule.height!, ...gap }));
  }
  const ceiling = (x: number, z: number): BuildingFixtureMount => ({ surface: 'ceiling', position: { x: snap(x), z: snap(z) }, ...yaw, ...gap });
  if (rule.placement === 'ceiling-center') {
    const tiles = [...shape(room).tiles].sort((a, b) => b.width * b.depth - a.width * a.depth || a.x - b.x || a.z - b.z);
    return [ceiling(room.x, room.z), ...tiles.filter(tile => Math.abs(tile.x - room.x) + Math.abs(tile.z - room.z) > EPS).map(tile => ceiling(tile.x, tile.z))];
  }
  const width = room.width - margin * 2, depth = room.depth - margin * 2;
  if (width <= 0 || depth <= 0) return [];
  if (rule.placement === 'ceiling-quadrants') return [-1, 1].flatMap(z => [-1, 1].map(x => ceiling(room.x + x * width / 4, room.z + z * depth / 4)));
  const cols = rule.columns ?? Math.max(1, Math.ceil(Math.sqrt(count * width / depth))), rows = Math.ceil(count / cols);
  return Array.from({ length: Math.min(64, cols * rows) }, (_, i) => ceiling(room.x + ((i % cols + .5) / cols - .5) * width, room.z + ((Math.floor(i / cols) + .5) / rows - .5) * depth));
}
/** Deterministic authoring, not a runtime loop. Existing fixtures are retained.
 * The returned recipe is editable; models retain their validated immutable data.
 * Optional omissions are counted; unmet required counts are explicit diagnostics. */
export function furnishBuildingFixtures(input: BuildingRecipe, catalog: Pick<AssetCatalog, 'resolve'>, options: FurnishBuildingFixturesOptions): FurnishedBuildingFixtures {
  const diagnostics: FurnishedBuildingFixtures['diagnostics'] = { valid: true, issues: [], requested: 0, placed: 0, attempted: 0, omittedOptional: 0 };
  const result = { recipe: input, diagnostics }, fail = (code: string, message: string, ...ids: string[]) => { if (diagnostics.issues.length < 128) diagnostics.issues.push(issue(code, message, ...ids)); diagnostics.valid = false; };
  if (!plain(options) || !keys(options, ['seed', 'rooms']) || !plain(options.rooms) || Object.keys(options.rooms).length > 256 || options.seed !== undefined && !Number.isSafeInteger(options.seed)) { fail('fixture-options', 'Fixture options require a bounded rooms map and integer seed.'); return result; }
  const structural = compileBuilding({ ...input, floors: Array.isArray(input?.floors) ? input.floors.map(floor => ({ ...floor, fixtures: undefined })) : [] });
  if (!structural.diagnostics.valid) { fail('fixture-building', 'Fixture authoring requires a valid structural building.'); return result; }
  if (input.floors.some(floor => floor.fixtures !== undefined && (!Array.isArray(floor.fixtures) || floor.fixtures.length > 64 || Array.from(floor.fixtures).some(fixture => !plain(fixture))))) {
    fail('fixture-budget', 'Existing fixtures require bounded non-sparse arrays.'); return result;
  }
  const recipe: BuildingRecipe = { ...structural.recipe, floors: structural.recipe.floors.map((floor, index) => ({ ...floor, fixtures: [...(input.floors[index].fixtures ?? [])] })) };
  result.recipe = recipe;
  const existing = resolveBuildingFixtures({ ...structural, recipe });
  if (existing.issues.length) { diagnostics.issues.push(...existing.issues); diagnostics.valid = false; return result; }
  for (const floor of recipe.floors) floor.fixtures = floor.fixtures!.map(copyFixture);
  const occupied = furnitureBodies(structural);
  for (const part of existing.parts) { const p = localPoint(structural, part.position), yaw = spatialAngle(2 * Math.atan2(part.rotation.y, part.rotation.w) - (recipe.yaw ?? 0)); occupied.push(...bodies(part.model!, { ...p, y: p.y - part.size.y / 2 }, yaw)); }
  // Both explicit and inherited seeds were checked as safe integers above.
  const ids = structuralIds(recipe), seed = (options.seed ?? input.seed ?? 0) >>> 0;
  for (const floor of recipe.floors) for (const fixture of floor.fixtures ?? []) ids.add(fixture.id);
  let partCount = structural.diagnostics.counts.parts + existing.parts.reduce((sum, part) => sum + part.model!.parts.length, 0), colliderCount = structural.colliders.length + existing.colliders.length;
  for (const roomId of Object.keys(options.rooms).sort(compare)) {
    const floor = recipe.floors.find(f => f.rooms.some(r => r.id === roomId)), room = floor?.rooms.find(r => r.id === roomId), entry = options.rooms[roomId];
    if (!floor || !room || !plain(entry) || !keys(entry, ['rules']) || !Array.isArray(entry.rules) || entry.rules.length > 16 || Array.from(entry.rules).some(rule => !plain(rule))) { fail('fixture-room', 'Fixture room must exist and have at most 16 plain rules.', roomId); continue; }
    const ruleIds = new Set<string>();
    for (const rule of [...entry.rules].sort((a, b) => compare(String(a.id), String(b.id)))) {
      try { validateRule(rule); if (ruleIds.has(rule.id)) throw new Error('Fixture rule IDs must be unique within a room.'); ruleIds.add(rule.id); }
      catch (error) { fail('fixture-rule', error instanceof Error ? error.message : 'Invalid fixture rule.', roomId, String(rule.id)); continue; }
      const key = `${input.id}:${roomId}:${rule.id}`, count = requestedCount(rule, shape(room).area, random(seed, `${key}:count`)), required = rule.required ?? count;
      if (required > count) { fail('fixture-required', 'Required fixture count exceeds the resolved requested count.', roomId, rule.id); continue; }
      diagnostics.requested += count; if (!count) continue;
      const mounts = candidates(rule, room, count); let placed = 0, lastReason = 'No supported candidate fits the requested layout.';
      // A keyed rotation changes which equally spaced fallback is tried first,
      // without perturbing the candidate coordinates or another rule's assets.
      const start = rule.placement === 'wall-spaced' || rule.placement === 'ceiling-center' ? 0 : Math.floor(random(seed, `${key}:start`) * mounts.length);
      for (let i = 0; i < mounts.length && placed < (rule.placement === 'ceiling-center' ? Math.min(1, count) : count); i++) {
        if (diagnostics.attempted >= BUILDING_FIXTURE_LIMITS.candidates) { lastReason = 'Fixture candidate budget exhausted.'; break; }
        if (floor.fixtures!.length >= BUILDING_FIXTURE_LIMITS.perFloor || floor.fixtures!.filter(f => f.room === roomId).length >= BUILDING_FIXTURE_LIMITS.perRoom) { lastReason = 'Fixture room/floor budget exhausted.'; break; }
        diagnostics.attempted++; const fixtureId = stableId(`${roomId}:${rule.id}:${placed}`);
        try {
          if (ids.has(fixtureId)) throw new Error('Generated fixture ID collides with an existing authored fixture.');
          const model = catalog.resolve(rule.family, { seed, instanceId: stableId(`${key}:${placed}`), ...(rule.parameters ? { parameters: rule.parameters } : {}) });
          const fixture: BuildingFixtureRecipe = { id: fixtureId, room: roomId, model, mount: mounts[(start + i) % mounts.length], ...(rule.light ? { light: copyLight(rule.light) } : {}),
            ...(rule.material === undefined ? {} : { material: validateSurfaceMaterialInput(rule.material) }) };
          const resolved = resolveOne(structural, floor, fixture, occupied);
          if (partCount + model.parts.length > BUILDING_LIMITS.parts || colliderCount + resolved.colliders.length > BUILDING_LIMITS.colliders) throw new Error('Fixtures exceed the building part/collider budget.');
          partCount += model.parts.length; colliderCount += resolved.colliders.length;
          floor.fixtures!.push(fixture); occupied.push(...resolved.bodies); ids.add(fixtureId); placed++; diagnostics.placed++;
        } catch (error) { lastReason = error instanceof Error ? error.message : 'Fixture cannot fit.'; }
      }
      diagnostics.omittedOptional += Math.max(0, count - Math.max(placed, required));
      if (placed < required) fail('fixture-required', `Placed ${placed}/${required} required fixtures: ${lastReason}`, roomId, rule.id);
    }
  }
  return result;
}
