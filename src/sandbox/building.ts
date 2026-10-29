import type { PhysicsCollider, PhysicsRotation, PhysicsVector } from './physics.ts';
import { physicsShapeBounds, physicsConvexFaces } from './physicsGeometry.ts';
import { validateAssetManifest, transformAssetColliders, type AssetManifest } from './assetFamilies.ts';
import { resolveSurfaceMaterial, validateSurfaceMaterialInput, type SurfaceMaterialInput, type ResolvedSurfaceMaterial } from './surfaceMaterials.ts';
import { resolveBuildingFixtures, type BuildingFixtureRecipe, type ResolvedFixtureLight } from './buildingFixtures.ts';
import { compileDoorGeometry, validateBuildingDoorSelection, resolveBuildingDoorSelection, type BuildingDoorSelection, type BuildingDoorDesign } from './buildingDoors.ts';
export type { BuildingDoorSelection, BuildingDoorDesign } from './buildingDoors.ts';
export type { BuildingFixtureRecipe, ResolvedFixtureLight } from './buildingFixtures.ts';
import { compileBuildingFootprint, footprintContainsPoint, footprintContainsRectangle, footprintsOverlap,
  type BuildingRectangle, type BuildingFootprint } from './buildingFootprints.ts';
import { expandBuildingSlabs } from './buildingSlabs.ts';
export type { BuildingRectangle } from './buildingFootprints.ts';

/** Editable orthogonal building geometry. Metres, Y-up; north is local -Z.
 * Room x/z and staircase x/z are footprint centres. Floor y is its walking surface.
 * Stairs use the same solid treads/risers for appearance, collision and support
 * (at most 18cm tread rise). Explicit ramps retain a continuous sloped surface.
 * This module is pure data; consumers must reject an invalid manifest. */
export type BuildingSide = 'north' | 'south' | 'east' | 'west';
export type BuildingRoomAccess = 'public' | 'circulation' | 'private' | 'service';
export interface BuildingMaterials {
  wall?: SurfaceMaterialInput; floor?: SurfaceMaterialInput; ceiling?: SurfaceMaterialInput;
  roof?: SurfaceMaterialInput; stair?: SurfaceMaterialInput; furniture?: SurfaceMaterialInput;
}
/** Directions and points remain building-local, independent of building yaw. */
export interface BuildingRoomOrientation {
  front?: BuildingSide; focalPoint?: { x: number; z: number }; entry?: { x: number; z: number };
}
export interface BuildingRoomRecipe {
  id: string; x: number; z: number; width: number; depth: number; label?: string; purpose?: string;
  access?: BuildingRoomAccess; orientation?: BuildingRoomOrientation;
  /** Connected rectangle union in building-local coordinates; envelope stays x/z/width/depth. */
  footprint?: BuildingRectangle[];
  /** Walking surface relative to floor.y; the storey ceiling remains fixed. */
  elevation?: number;
  materials?: Pick<BuildingMaterials, 'wall' | 'floor' | 'ceiling'>;
  /** Entrance intent is explicit; room labels and access categories never infer doors. */
  doorPolicy?: BuildingDoorPolicy;
}
export interface BuildingDoorPolicy {
  mode: 'required' | 'none' | 'optional'; probability?: number; selection?: BuildingDoorSelection;
}
export interface BuildingOpeningRecipe {
  id: string; room: string; side: BuildingSide; offset?: number;
  /** Passage removes a complete shared wall span between equal-level rooms.
   * Its height must reach the clear ceiling; exterior passages are unsupported. */
  kind: 'door' | 'window' | 'passage'; width: number; height: number; bottom?: number;
  /** Index among union boundary edges matching side; offset then uses that edge's midpoint. */
  edge?: number;
  transition?: { kind: 'steps' | 'ramp'; run?: number };
  /** False explicitly keeps a bare opening, overriding room/default door rules. */
  door?: false | BuildingDoorSelection;
}
export interface BuildingFurnitureRecipe {
  id: string; room: string; asset?: string; x: number; z: number; y?: number;
  width: number; depth: number; height: number; yaw?: number; color?: string; collision?: boolean;
  /** Family geometry is authoritative; dimensions must match its size. Its
   * envelope reserves layout space while native physics uses compound parts. */
  model?: AssetManifest;
  material?: SurfaceMaterialInput;
}
export interface BuildingFloorRecipe {
  id: string; y: number; height: number; rooms: BuildingRoomRecipe[];
  openings?: BuildingOpeningRecipe[]; furniture?: BuildingFurnitureRecipe[];
  /** Surface-mounted fixtures retain attachment intent when room levels change. */
  fixtures?: BuildingFixtureRecipe[];
  materials?: BuildingMaterials;
  doors?: BuildingDoorSelection;
}
export interface BuildingStairRecipe {
  id: string; fromFloor: string; toFloor: string; x: number; z: number; width: number; run: number;
  direction: 'north' | 'south' | 'east' | 'west';
  material?: SurfaceMaterialInput;
}
export interface BuildingRecipe {
  version: 1; id: string; seed?: number; width: number; depth: number;
  /** Connected orthogonal union; width/depth remain its centred bounding envelope. */
  footprint?: BuildingRectangle[];
  origin?: PhysicsVector; yaw?: number; wallThickness?: number; floorThickness?: number;
  actor?: { radius: number; height: number; maxSlopeDegrees?: number };
  colors?: { wall?: string; floor?: string; roof?: string; stair?: string; furniture?: string };
  materials?: BuildingMaterials;
  doors?: BuildingDoorSelection;
  /** Ground-floor exterior door ID. Its room cannot be private/service; public
   * rooms must be reachable from it without crossing private/service rooms.
   * Other exterior doors may serve service rooms. Omit for legacy topology. */
  primaryEntrance?: string;
  floors: BuildingFloorRecipe[]; stairs?: BuildingStairRecipe[];
  /** Gable ridge follows local X. The ceiling and fitted perimeter enclosure
   * are generated together. enclosure:false deliberately leaves the attic open. */
  roof?: false | { color?: string; kind?: 'flat' | 'gable'; rise?: number; material?: SurfaceMaterialInput;
    enclosure?: boolean | { color?: string; material?: SurfaceMaterialInput } };
}
export type BuildingMaterialPatch = {
  /** Box face in part-local axes. U/V are X/Z on horizontal faces,
   * Z/Y on X-facing walls, and X/Y on Z-facing walls, in metres. */
  face: 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
  minU: number; maxU: number; minV: number; maxV: number;
  /** Add to face-local U/V to keep neighboring patches aligned. */
  offsetU: number; offsetV: number; roomId?: string;
} & ({ material: ResolvedSurfaceMaterial; color?: never } | { color: string; material?: never });
export interface BuildingPart {
  id: string; kind: 'wall' | 'floor' | 'roof' | 'stair' | 'furniture' | 'door';
  position: PhysicsVector; size: PhysicsVector; rotation: PhysicsRotation; color: string;
  collidable: boolean; visible: boolean; exterior: boolean; floorId?: string; roomId?: string; asset?: string; model?: AssetManifest;
  /** Identifies compiled fixture wrappers without relying on an ID prefix. */
  fixtureId?: string;
  doorId?: string;
  /** Compiler-owned convex solid, in centred part-local metres. The same
   * vertices supply collision and outward triangles supply rendering. */
  geometry?: { vertices: PhysicsVector[]; indices: number[] };
  /** Generated companion follows this part unless explicitly bound separately
   * for destruction. This attachment adds no inferred load-bearing bonds. */
  attachmentParentId?: string;
  material?: ResolvedSurfaceMaterial;
  /** Presentation only; patches never alter support surfaces or colliders. */
  materialPatches?: BuildingMaterialPatch[];
}
export interface BuildingRoom {
  id: string; floorId: string; center: PhysicsVector; size: PhysicsVector; yaw: number; label?: string; purpose?: string;
  access?: BuildingRoomAccess; /** Authored building-local orientation. */ orientation?: BuildingRoomOrientation;
  /** Rectangle coordinates relative to center.x/z before applying room yaw. */
  footprint?: BuildingRectangle[]; elevation?: number;
}
export interface BuildingPortal {
  id: string; kind: 'door' | 'window' | 'passage' | 'stair'; roomIds: string[]; position: PhysicsVector;
  width: number; height: number; exterior: boolean; endpoints: { roomId: string | null; position: PhysicsVector }[];
  doorId?: string; currentClearWidth?: number;
}
export interface BuildingDoor {
  id: string; portalId: string; openingId: string; floorId: string; roomIds: string[]; type: NonNullable<BuildingDoorDesign['type']>; open: number; variantId?: string;
  currentClearWidth: number; currentClearCenter: number; traversable: boolean; partIds: string[];
  /** Building-local bottom and leaf aperture height. */
  baseY: number; height: number;
  /** Full-motion pockets in building-local coordinates, useful to author furnishing. */
  reservations: { id: string; kind: 'swing' | 'slide'; x: number; z: number; width: number; depth: number }[];
}
export interface BuildingIssue { code: string; message: string; ids?: string[] }
export interface BuildingSurface {
  id: string; kind: 'floor' | 'roof' | 'stair'; floorId: string; roomId?: string;
  /** Building-local rectangle and plane, transformed by the retained recipe. */
  minX: number; maxX: number; minZ: number; maxZ: number; y: number;
  slopeX: number; slopeZ: number; centerX: number; centerZ: number;
}
export interface BuildingManifest {
  version: 1; id: string; revision: string; recipe: BuildingRecipe;
  parts: BuildingPart[]; colliders: PhysicsCollider[]; rooms: BuildingRoom[]; portals: BuildingPortal[];
  surfaces: BuildingSurface[]; bounds: { min: PhysicsVector; max: PhysicsVector };
  /** Resolved world-space emitters consumed automatically by BuildingWorldView. */
  lights?: ResolvedFixtureLight[];
  doors?: BuildingDoor[];
  diagnostics: { valid: boolean; issues: BuildingIssue[]; counts: { parts: number; colliders: number; rooms: number; portals: number };
    reachableRooms: string[]; unreachableRooms: string[]; coverage: string;
    publicAccess?: { entranceId: string; reachableRooms: string[]; unreachableRooms: string[] };
    /** Current authored pose only; closed doors do not invalidate structural connectivity. */
    traversal?: { reachableRooms: string[]; unreachableRooms: string[]; blockedPortalIds: string[] } };
}
export interface BuildingSupport {
  id: string; floorId: string; roomId?: string; kind: BuildingSurface['kind']; point: PhysicsVector; normal: PhysicsVector;
}
export const BUILDING_LIMITS = Object.freeze({ floors: 8, roomsPerFloor: 32, openingsPerFloor: 128,
  furniturePerFloor: 128, fixturesPerFloor: 64, stairs: 16, parts: 4096, colliders: 2048, dimension: 128 });

type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
type Wall = { axis: 'x' | 'z'; at: number; min: number; max: number };
type LocalOpening = Wall & { opening: BuildingOpeningRecipe; floor: BuildingFloorRecipe; bottom: number; rooms: string[]; door?: BuildingDoorSelection };
type Stair = BuildingStairRecipe & { from: BuildingFloorRecipe; to: BuildingFloorRecipe; ux: number; uz: number; rect: Rect; fromRoom: string; toRoom: string };
type Transition = { id: string; kind: 'steps' | 'ramp'; floor: BuildingFloorRecipe; lowRoom: string; highRoom: string;
  x: number; z: number; ux: number; uz: number; width: number; run: number; low: number; high: number;
  rect: Rect; landing: Rect; reserved: Rect; upperLanding: Rect };
const EPS = 1e-7;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const snap = (n: number) => Math.round(n * 1e7) / 1e7;
const idOkay = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
// Only entries returned by the asset validator enter this map. Their entire
// object graphs are frozen, so retaining references cannot expose input edits.
const retainedModelNodes = new WeakMap<object, number>();
function retainModel(model: AssetManifest): number {
  let nodes = retainedModelNodes.get(model);
  if (nodes === undefined) {
    const count = (value: unknown): number => 1 + (value && typeof value === 'object' ? Object.values(value).reduce<number>((sum, v) => sum + count(v), 0) : 0);
    nodes = count(model); retainedModelNodes.set(model, nodes);
  }
  return nodes;
}
const rectFor = (r: { x: number; z: number; width: number; depth: number }): Rect => ({ minX: r.x - r.width / 2, maxX: r.x + r.width / 2, minZ: r.z - r.depth / 2, maxZ: r.z + r.depth / 2 });
const intersects = (a: Rect, b: Rect) => Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > EPS && Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > EPS;
const contains = (r: Rect, p: { x: number; z: number }, margin = 0) => p.x >= r.minX + margin - EPS && p.x <= r.maxX - margin + EPS && p.z >= r.minZ + margin - EPS && p.z <= r.maxZ - margin + EPS;
const encloses = (a: Rect, b: Rect, margin = 0) => contains(a, { x: b.minX, z: b.minZ }, margin) && contains(a, { x: b.maxX, z: b.maxZ }, margin);
// Plain loops and the default code-unit key sort keep revisions identical
// while avoiding per-entry callbacks in the sandbox interpreter.
const canonical = (v: unknown): string => {
  if (v && typeof v === 'object' && retainedModelNodes.has(v)) return `{"assetManifestKey":${JSON.stringify((v as AssetManifest).key)}}`;
  if (Array.isArray(v)) { let out = '['; for (let i = 0; i < v.length; i++) out += (i ? ',' : '') + canonical(v[i]); return out + ']'; }
  if (v && typeof v === 'object') {
    const record = v as Record<string, unknown>, names = Object.keys(record).sort(); let out = '{', first = true;
    for (let i = 0; i < names.length; i++) { const value = record[names[i]]; if (value === undefined) continue; out += (first ? '' : ',') + JSON.stringify(names[i]) + ':' + canonical(value); first = false; }
    return out + '}';
  }
  return JSON.stringify(v) ?? 'null';
};
function fingerprint(value: string): string { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(8, '0'); }
function world(recipe: BuildingRecipe, p: PhysicsVector): PhysicsVector {
  const c = Math.cos(recipe.yaw ?? 0), s = Math.sin(recipe.yaw ?? 0), origin = recipe.origin ?? { x: 0, y: 0, z: 0 };
  return { x: origin.x + c * p.x + s * p.z, y: origin.y + p.y, z: origin.z - s * p.x + c * p.z };
}
function local(recipe: BuildingRecipe, p: PhysicsVector): PhysicsVector {
  const c = Math.cos(recipe.yaw ?? 0), s = Math.sin(recipe.yaw ?? 0), o = recipe.origin ?? { x: 0, y: 0, z: 0 }, x = p.x - o.x, z = p.z - o.z;
  return { x: c * x - s * z, y: p.y - o.y, z: s * x + c * z };
}
function rotation(yaw: number, pitch = 0): PhysicsRotation {
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sx = Math.sin(pitch / 2), cx = Math.cos(pitch / 2);
  return { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx };
}
function rotateByYaw(q: PhysicsRotation | undefined, yaw: number): PhysicsRotation {
  const value = q ?? { x: 0, y: 0, z: 0, w: 1 }, c = Math.cos(yaw / 2), s = Math.sin(yaw / 2);
  return { x: c * value.x + s * value.z, y: c * value.y + s * value.w,
    z: c * value.z - s * value.x, w: c * value.w - s * value.y };
}
type CollisionBox = { center: number[]; axes: number[][]; half: number[]; radius?: number; min: number[]; max: number[] };
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function collisionBox(collider: PhysicsCollider): CollisionBox {
  if (collider.shape.kind === 'convex') {
    const { min, max } = physicsShapeBounds(collider.shape, collider.rotation), p = collider.position;
    return { center: [p.x + (min.x + max.x) / 2, p.y + (min.y + max.y) / 2, p.z + (min.z + max.z) / 2],
      axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [(max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2],
      min: [p.x + min.x, p.y + min.y, p.z + min.z], max: [p.x + max.x, p.y + max.y, p.z + max.z] };
  }
  const q = collider.rotation ?? { x: 0, y: 0, z: 0, w: 1 }, { x, y, z, w } = q, shape = collider.shape;
  const axes = [[1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]];
  const half = shape.kind === 'box' ? [shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z]
    : [shape.radius, shape.radius + (shape.kind === 'capsule' ? shape.halfHeight : 0), shape.radius];
  const center = [collider.position.x, collider.position.y, collider.position.z], extent = center.map((_, i) => axes.reduce((sum, axis, j) => sum + Math.abs(axis[i]) * half[j], 0));
  return { center, axes, half, ...(shape.kind === 'ball' ? { radius: shape.radius } : {}), min: center.map((n, i) => n - extent[i]), max: center.map((n, i) => n + extent[i]) };
}
/** Exact box/ball overlap at the authored pose. Tangent contacts are allowed. */
function doorCollision(a: CollisionBox, b: CollisionBox): boolean {
  const tolerance = .001;
  if (a.min.some((minimum, i) => minimum >= b.max[i] - tolerance || a.max[i] <= b.min[i] + tolerance)) return false;
  const delta = a.center.map((n, i) => b.center[i] - n);
  if (a.radius !== undefined && b.radius !== undefined) return dot3(delta, delta) < (a.radius + b.radius - tolerance) ** 2;
  if (a.radius !== undefined || b.radius !== undefined) {
    const ball = a.radius !== undefined ? a : b, box = a.radius !== undefined ? b : a;
    const difference = ball.center.map((n, i) => n - box.center[i]);
    return box.axes.reduce((sum, axis, i) => sum + Math.max(0, Math.abs(dot3(difference, axis)) - box.half[i]) ** 2, 0) < (ball.radius! - tolerance) ** 2;
  }
  const separated = (axis: number[]) => {
    const length = Math.hypot(...axis); if (length < 1e-8) return false;
    return Math.abs(dot3(delta, axis)) >= a.axes.reduce((sum, vector, i) => sum + Math.abs(dot3(vector, axis)) * a.half[i], 0)
      + b.axes.reduce((sum, vector, i) => sum + Math.abs(dot3(vector, axis)) * b.half[i], 0) - tolerance * length;
  };
  if (a.axes.some(separated) || b.axes.some(separated)) return false;
  for (const u of a.axes) for (const v of b.axes) if (separated([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])) return false;
  return true;
}
function subtract(rect: Rect, cut: Rect): Rect[] {
  if (!intersects(rect, cut)) return [rect];
  const a = Math.max(rect.minX, cut.minX), b = Math.min(rect.maxX, cut.maxX), c = Math.max(rect.minZ, cut.minZ), d = Math.min(rect.maxZ, cut.maxZ);
  return [{ minX: rect.minX, maxX: a, minZ: rect.minZ, maxZ: rect.maxZ }, { minX: b, maxX: rect.maxX, minZ: rect.minZ, maxZ: rect.maxZ },
    { minX: a, maxX: b, minZ: rect.minZ, maxZ: c }, { minX: a, maxX: b, minZ: d, maxZ: rect.maxZ }].filter(r => r.maxX - r.minX > EPS && r.maxZ - r.minZ > EPS);
}
function furnitureRect(item: BuildingFurnitureRecipe): Rect {
  const c = Math.abs(Math.cos(item.yaw ?? 0)), s = Math.abs(Math.sin(item.yaw ?? 0));
  return rectFor({ ...item, width: c * item.width + s * item.depth, depth: c * item.depth + s * item.width });
}
function cloneData(value: unknown, budget = { nodes: 262144 }, depth = 0): unknown {
  if (--budget.nodes < 0 || depth > 16) throw new Error('Building data exceeds its plain-data budget.');
  if (value === undefined || value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && finite(value)) return value;
  if (typeof value === 'string' && value.length <= 512) return value;
  if (value && typeof value === 'object' && Object.isFrozen(value) && (value as AssetManifest).schemaVersion === 1
    && typeof (value as AssetManifest).familyId === 'string' && typeof (value as AssetManifest).key === 'string') {
    const model = validateAssetManifest(value as AssetManifest);
    budget.nodes -= retainModel(model) - 1;
    if (budget.nodes < 0 || depth + 5 > 16) throw new Error('Building data exceeds its plain-data budget.');
    return model;
  }
  if (Array.isArray(value)) return value.map(v => cloneData(v, budget, depth + 1));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, cloneData(v, budget, depth + 1)]));
  throw new Error('Building data must contain bounded plain objects, strings and finite numbers.');
}

/** Validate and snapshot an explicit room entrance rule. */
export function validateBuildingDoorPolicy(input: unknown): BuildingDoorPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Room door policy must be an object.');
  const policy = input as BuildingDoorPolicy;
  if (Object.keys(policy).some(key => !['mode', 'probability', 'selection'].includes(key))
    || !['required', 'none', 'optional'].includes(policy.mode)
    || policy.probability !== undefined && (policy.mode !== 'optional' || !finite(policy.probability) || policy.probability < 0 || policy.probability > 1)
    || policy.mode === 'none' && policy.selection !== undefined)
    throw new Error('Door policy needs required/none/optional mode; only optional accepts probability in 0..1.');
  return { mode: policy.mode, ...(policy.probability === undefined ? {} : { probability: policy.probability }),
    ...(policy.selection === undefined ? {} : { selection: snapshotDoorSelection(policy.selection) }) };
}
function snapshotDoorSelection(input: unknown): BuildingDoorSelection {
  const selection = validateBuildingDoorSelection(input);
  for (const design of 'palette' in selection ? selection.palette.map(entry => entry.door) : [selection]) if (design.model) retainModel(design.model);
  return selection;
}
export interface BuildingDoorIntent {
  selection?: BuildingDoorSelection; source: 'opening' | 'room' | 'floor' | 'building' | 'legacy'; required: boolean;
}
/** Shared-edge intent resolver used by the compiler and furnishing. Explicit
 * opening overrides win. Required vs none and differing required selections
 * need an explicit override. Optional choices use the opening's stable ID. */
export function resolveBuildingDoorIntent(recipe: BuildingRecipe, floor: BuildingFloorRecipe,
  opening: BuildingOpeningRecipe, roomIds: readonly string[]): BuildingDoorIntent {
  if (opening.kind === 'window') {
    if (opening.door !== undefined) throw new Error('Windows cannot carry door intent.');
    return { source: 'legacy', required: false };
  }
  if (opening.door === false) return { source: 'opening', required: false };
  if (opening.door !== undefined) {
    if (opening.kind !== 'door') throw new Error('A full-wall passage cannot carry a door leaf; use a door opening or explicit door:false.');
    return { selection: snapshotDoorSelection(opening.door), source: 'opening', required: false };
  }
  const policies = [...roomIds].sort(compare).map(id => floor.rooms.find(room => room.id === id)?.doorPolicy)
    .filter((policy): policy is BuildingDoorPolicy => policy !== undefined).map(validateBuildingDoorPolicy);
  const required = policies.filter(policy => policy.mode === 'required'), none = policies.some(policy => policy.mode === 'none');
  if (required.length && none) throw new Error('Adjacent required/none door policies conflict; set the opening door override explicitly.');
  if (opening.kind === 'passage') {
    if (required.length) throw new Error('A required door cannot be a full-wall passage; use a door opening or explicit door:false.');
    return { source: policies.length ? 'room' : 'legacy', required: false };
  }
  if (none) return { source: 'room', required: false };
  const defaultSelection = floor.doors ?? recipe.doors;
  if (required.length) {
    const selections = required.flatMap(policy => policy.selection === undefined ? [] : [policy.selection]);
    if (selections.some(selection => canonical(selection) !== canonical(selections[0])))
      throw new Error('Adjacent required door selections differ; set the opening door override explicitly.');
    return { selection: snapshotDoorSelection(selections[0] ?? defaultSelection ?? { type: 'hinged' }), source: 'room', required: true };
  }
  const optional = policies.filter(policy => policy.mode === 'optional');
  if (optional.length) {
    const probability = Math.max(...optional.map(policy => policy.probability ?? .5));
    const sample = parseInt(fingerprint(`${(recipe.seed ?? 0) >>> 0}:${recipe.id}:${floor.id}:${opening.id}:door`), 16) / 4294967296;
    if (sample >= probability) return { source: 'room', required: false };
    return { selection: snapshotDoorSelection(optional.find(policy => policy.selection !== undefined)?.selection ?? defaultSelection ?? { type: 'hinged' }), source: 'room', required: false };
  }
  return defaultSelection === undefined ? { source: 'legacy', required: false }
    : { selection: snapshotDoorSelection(defaultSelection), source: floor.doors !== undefined ? 'floor' : 'building', required: false };
}

/** Compile once when a recipe changes. Invalid drafts have diagnostics but no usable geometry. */
export function compileBuilding(input: BuildingRecipe): BuildingManifest {
  const issues: BuildingIssue[] = [], issue = (code: string, message: string, ...ids: string[]) => { if (issues.length < 128) issues.push({ code, message, ...(ids.length ? { ids } : {}) }); };
  // Bounded input shape checks precede traversal/cloning, including untyped host data.
  const validShape = !!input && typeof input === 'object' && Array.isArray(input.floors) && input.floors.length <= BUILDING_LIMITS.floors
    && Array.from(input.floors).every(f => f && Array.isArray(f.rooms) && f.rooms.length <= BUILDING_LIMITS.roomsPerFloor && Array.from(f.rooms).every(r => r && typeof r === 'object' && !Array.isArray(r))
      && (f.openings === undefined || Array.isArray(f.openings) && f.openings.length <= BUILDING_LIMITS.openingsPerFloor)
      && (f.furniture === undefined || Array.isArray(f.furniture) && f.furniture.length <= BUILDING_LIMITS.furniturePerFloor)
      && (f.fixtures === undefined || Array.isArray(f.fixtures) && f.fixtures.length <= BUILDING_LIMITS.fixturesPerFloor))
    && (input.stairs === undefined || Array.isArray(input.stairs) && input.stairs.length <= BUILDING_LIMITS.stairs);
  let recipe: BuildingRecipe = { version: 1, id: 'invalid', width: 1, depth: 1, floors: [] };
  if (validShape) try { recipe = cloneData(input) as BuildingRecipe; } catch { issue('input-data', 'Building requires bounded, acyclic, serializable plain data with finite numbers.'); }
  const parts: BuildingPart[] = [], rooms: BuildingRoom[] = [], portals: BuildingPortal[] = [], surfaces: BuildingSurface[] = [];
  const result: BuildingManifest = { version: 1, id: recipe.id, revision: '', recipe, parts, colliders: [], rooms, portals, surfaces,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    diagnostics: { valid: false, issues, counts: { parts: 0, colliders: 0, rooms: 0, portals: 0 }, reachableRooms: [], unreachableRooms: [],
      coverage: 'Rectangle-union partitions, door/stair connectivity and bounded actor clearance. No general navigation mesh or arbitrary imported-mesh validation.' } };
  const finish = () => {
    result.revision = `building-v4-${fingerprint(canonical(recipe))}`;
    result.diagnostics.valid = issues.length === 0;
    result.diagnostics.counts = { parts: parts.reduce((count, part) => count + (part.model?.parts.length ?? 1), 0), colliders: result.colliders.length, rooms: rooms.length, portals: portals.length };
    if (issues.length) { parts.length = 0; result.colliders.length = 0; surfaces.length = 0; if (result.lights) result.lights.length = 0; if (result.doors) result.doors.length = 0; }
    return result;
  };
  if (!validShape) { issue('input-budget', 'Building arrays are missing or exceed bounded compiler limits.'); return finish(); }
  if (issues.length) return finish();
  if (recipe.version !== 1 || !idOkay(recipe.id) || !positive(recipe.width) || recipe.width > 128 || !positive(recipe.depth) || recipe.depth > 128
    || !recipe.floors.length || recipe.seed !== undefined && (!Number.isSafeInteger(recipe.seed))
    || !finite(recipe.yaw ?? 0) || recipe.origin && ![recipe.origin.x, recipe.origin.y, recipe.origin.z].every(finite)) issue('recipe', 'Building requires version 1, stable ID, finite transform and dimensions in (0,128].');
  const thick = recipe.wallThickness ?? .18, slab = recipe.floorThickness ?? .16, actor = { radius: .3, height: 1.8, maxSlopeDegrees: 40, ...recipe.actor };
  const checkMaterial = (material: SurfaceMaterialInput | undefined, id: string) => {
    if (material !== undefined) try { validateSurfaceMaterialInput(material); }
    catch (error) { issue('material', error instanceof Error ? error.message : String(error), id); }
  };
  const checkMaterials = (materials: BuildingMaterials | undefined, id: string, room = false) => {
    if (materials === undefined) return;
    if (!materials || typeof materials !== 'object' || Array.isArray(materials)
      || Object.keys(materials).some(key => !(room ? ['wall', 'floor', 'ceiling'] : ['wall', 'floor', 'ceiling', 'roof', 'stair', 'furniture']).includes(key))) {
      issue('materials', 'Materials require named building surface roles; rooms support wall, floor and ceiling.', id); return;
    }
    for (const material of Object.values(materials)) checkMaterial(material, id);
  };
  checkMaterials(recipe.materials, recipe.id);
  const checkDoors = (selection: BuildingDoorSelection | undefined, id: string) => {
    if (selection !== undefined) try { return snapshotDoorSelection(selection); }
    catch (error) { issue('door-selection', error instanceof Error ? error.message : String(error), id); }
  };
  if (recipe.doors !== undefined) recipe.doors = checkDoors(recipe.doors, recipe.id);
  if (recipe.roof) checkMaterial(recipe.roof.material, 'roof');
  if (recipe.roof && recipe.roof.enclosure !== undefined) {
    const enclosure = recipe.roof.enclosure;
    if (typeof enclosure !== 'boolean' && (!enclosure || typeof enclosure !== 'object' || Array.isArray(enclosure)
      || Object.keys(enclosure).some(key => !['color', 'material'].includes(key))
      || enclosure.color !== undefined && (typeof enclosure.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(enclosure.color))))
      issue('roof-enclosure', 'Roof enclosure must be a boolean or an object with optional hex color and surface material.');
    else if (typeof enclosure === 'object') checkMaterial(enclosure.material, 'roof-enclosure');
  }
  if (recipe.roof && (recipe.roof.kind !== undefined && !['flat', 'gable'].includes(recipe.roof.kind)
    || recipe.roof.rise !== undefined && (!finite(recipe.roof.rise) || recipe.roof.rise < .2 || recipe.roof.rise > 8)))
    issue('roof', 'Roof kind must be flat or gable, with rise in .2–8m.');
  if (!finite(thick) || thick < .04 || thick > 1 || !finite(slab) || slab < .04 || slab > 1
    || !positive(actor.radius) || !finite(actor.height) || actor.height < actor.radius * 2 || !finite(actor.maxSlopeDegrees) || actor.maxSlopeDegrees <= 0 || actor.maxSlopeDegrees > 55)
    issue('dimensions', 'Wall/floor thickness must be .04–1m; actor dimensions and maximum slope must be valid.');
  const bounds = rectFor({ x: 0, z: 0, width: recipe.width, depth: recipe.depth }), ids = new Set<string>(), floorMap = new Map<string, BuildingFloorRecipe>(), roomMap = new Map<string, { room: BuildingRoomRecipe; floor: BuildingFloorRecipe }>();
  const buildingShape = compileBuildingFootprint(recipe.footprint ?? [{ x: 0, z: 0, width: recipe.width, depth: recipe.depth }], { x: 0, z: 0, width: recipe.width, depth: recipe.depth });
  if (!buildingShape.valid) { issue('building-footprint', buildingShape.issues.join(' ')); return finish(); }
  const footprint = buildingShape.footprint!, roomShapes = new Map<string, BuildingFootprint>();
  const asRectangle = (r: Rect): BuildingRectangle => ({ x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2, width: r.maxX - r.minX, depth: r.maxZ - r.minZ });
  const roomY = (room: BuildingRoomRecipe, floor: BuildingFloorRecipe) => floor.y + (room.elevation ?? 0);
  const unique = (id: string) => { if (!idOkay(id) || ids.has(id)) issue('id', 'IDs must be valid and unique throughout this building.', String(id)); ids.add(id); };
  for (const floor of recipe.floors) {
    unique(floor.id); floorMap.set(floor.id, floor);
    checkMaterials(floor.materials, floor.id);
    if (floor.doors !== undefined) floor.doors = checkDoors(floor.doors, floor.id);
    if (!finite(floor.y) || Math.abs(floor.y) > 1000 || !positive(floor.height) || floor.height < actor.height + slab || floor.height > 20 || !floor.rooms.length) issue('floor', 'Each floor needs rooms and sufficient finite vertical headroom.', floor.id);
    for (const room of floor.rooms) {
      if (!room || typeof room !== 'object') { issue('room', 'Room must be an object.', floor.id); continue; }
      unique(room.id); roomMap.set(room.id, { room, floor });
      checkMaterials(room.materials, room.id, true);
      if (room.doorPolicy !== undefined) try { room.doorPolicy = validateBuildingDoorPolicy(room.doorPolicy); }
      catch (error) { issue('door-policy', error instanceof Error ? error.message : String(error), room.id); }
      const shape = compileBuildingFootprint(room.footprint ?? [room], room);
      if (!shape.valid) issue('room-footprint', shape.issues.join(' '), room.id);
      else { roomShapes.set(room.id, shape.footprint!);
        if (!shape.footprint!.tiles.every(tile => footprintContainsRectangle(footprint, tile))) issue('room-footprint-bounds', 'Room union must be contained in the actual building footprint.', room.id); }
      if (!finite(room.elevation ?? 0) || Math.abs(room.elevation ?? 0) > 4 || floor.height - (room.elevation ?? 0) < actor.height + slab + ((room.elevation ?? 0) ? .1 : 0))
        issue('room-elevation', 'Room elevation must be within ±4m and preserve actor headroom below the fixed ceiling.', room.id);
      if (![room.x, room.z, room.width, room.depth].every(finite) || room.width <= thick + actor.radius * 2 + .04 || room.depth <= thick + actor.radius * 2 + .04 || !encloses(bounds, rectFor(room))) issue('room-bounds', 'Rooms must fit the building and be wide enough for the actor.', room.id);
      if (room.access !== undefined && !['public', 'circulation', 'private', 'service'].includes(room.access)) issue('room-access', 'Room access must be public, circulation, private or service.', room.id);
      if (room.orientation !== undefined) {
        const orientation = room.orientation;
        if (!orientation || typeof orientation !== 'object' || Array.isArray(orientation)
          || orientation.front !== undefined && !['north', 'south', 'east', 'west'].includes(orientation.front)
          || [orientation.focalPoint, orientation.entry].some(p => p !== undefined && (!p || !finite(p.x) || !finite(p.z) || !shape.footprint || !footprintContainsPoint(shape.footprint, p))))
          issue('room-orientation', 'Room orientation needs a cardinal front and finite building-local points inside or on its room boundary.', room.id);
      }
    }
    for (let a = 0; a < floor.rooms.length; a++) for (let b = a + 1; b < floor.rooms.length; b++)
      if (roomShapes.has(floor.rooms[a]?.id) && roomShapes.has(floor.rooms[b]?.id) && footprintsOverlap(roomShapes.get(floor.rooms[a].id)!, roomShapes.get(floor.rooms[b].id)!)) issue('room-overlap', 'Room unions cannot overlap.', floor.rooms[a].id, floor.rooms[b].id);
    const area = floor.rooms.reduce((sum, room) => sum + (roomShapes.get(room?.id)?.area ?? 0), 0);
    if (Math.abs(area - footprint.area) > .0001) issue('room-partition', 'Rooms must partition the whole building footprint without gaps.', floor.id);
    for (const item of floor.furniture ?? []) {
      if (!item || typeof item !== 'object') { issue('furniture', 'Furniture must be an object.', floor.id); continue; }
      unique(item.id); const owner = floor.rooms.find(room => room.id === item.room);
      checkMaterial(item.material, item.id);
      if (item.model !== undefined) {
        try {
          const model = validateAssetManifest(item.model);
          const matchesSize = [item.width, item.depth, item.height].every(finite) && Math.abs(item.width - model.size.x) <= 1e-6 && Math.abs(item.depth - model.size.z) <= 1e-6 && Math.abs(item.height - model.size.y) <= 1e-6;
          if (!matchesSize)
            issue('furniture-model-size', 'Furniture dimensions must match its model; resolve different family parameters to resize it.', item.id);
          item.model = model; retainModel(model);
          if (matchesSize) { item.width = model.size.x; item.depth = model.size.z; item.height = model.size.y; }
        } catch (error) { issue('furniture-model', `Invalid furniture model: ${error instanceof Error ? error.message : String(error)}`, item.id); }
      }
      if (!owner || ![item.x, item.z, item.y ?? 0, item.yaw ?? 0].every(finite) || ![item.width, item.depth, item.height].every(positive)
        || (item.y ?? 0) < 0 || (item.y ?? 0) + item.height > floor.height - (owner.elevation ?? 0) - slab || !roomShapes.has(owner.id)
        || !footprintContainsRectangle(roomShapes.get(owner.id)!, asRectangle(furnitureRect(item)), thick / 2)) issue('furniture-bounds', 'Furniture must fit its declared room union, clear of walls and ceiling.', item.id);
    }
  }
  const sortedFloors = [...recipe.floors].sort((a, b) => a.y - b.y || compare(a.id, b.id));
  for (let i = 1; i < sortedFloors.length; i++) if (Math.abs(sortedFloors[i].y - (sortedFloors[i - 1].y + sortedFloors[i - 1].height)) > EPS)
    issue('floor-stack', 'Successive floor surfaces must align with the preceding storey height.', sortedFloors[i].id);
  for (const floor of sortedFloors.slice(1)) for (const room of floor.rooms) if ((room.elevation ?? 0) < 0)
    issue('room-elevation-storey', 'Lowered rooms are supported only on the lowest storey; they cannot cut through the preceding ceiling.', room.id);
  if (issues.length) return finish();
  const localOpenings: LocalOpening[] = [], transitions: Transition[] = [];
  for (const floor of recipe.floors) for (const opening of floor.openings ?? []) {
    if (!opening || typeof opening !== 'object') { issue('opening', 'Opening must be an object.', floor.id); continue; }
    unique(opening.id); const room = floor.rooms.find(r => r.id === opening.room), sill = opening.bottom ?? (opening.kind === 'window' ? .9 : 0);
    const walkable = opening.kind === 'door' || opening.kind === 'passage';
    if (!room || !['north', 'south', 'east', 'west'].includes(opening.side) || !['door', 'window', 'passage'].includes(opening.kind)
      || !positive(opening.width) || !positive(opening.height) || !finite(opening.offset ?? 0) || !finite(sill) || sill < 0
      || opening.edge !== undefined && (!Number.isInteger(opening.edge) || opening.edge < 0)
      || opening.transition !== undefined && (!opening.transition || !['steps', 'ramp'].includes(opening.transition.kind) || opening.kind !== 'door'
        || opening.transition.run !== undefined && (!positive(opening.transition.run) || opening.transition.run > 32))
      || walkable && (sill !== 0 || opening.width < actor.radius * 2 + .1 || opening.height < actor.height + .1)) { issue('opening', 'Opening must fit a wall; walkable openings need actor width, height and no sill.', opening.id); continue; }
    const r = rectFor(room), axis = opening.side === 'north' || opening.side === 'south' ? 'x' : 'z';
    const edges = roomShapes.get(room.id)!.edges.filter(edge => edge.side === opening.side), edge = opening.edge === undefined ? undefined : edges[opening.edge];
    const at = edge?.at ?? (opening.side === 'north' ? r.minZ : opening.side === 'south' ? r.maxZ : opening.side === 'west' ? r.minX : r.maxX);
    const center = (edge ? (edge.min + edge.max) / 2 : axis === 'x' ? room.x : room.z) + (opening.offset ?? 0), min = center - opening.width / 2, max = center + opening.width / 2;
    const corner = opening.kind === 'passage' ? 0 : thick / 2;
    if (opening.edge !== undefined && !edge || !edges.some(e => Math.abs(e.at - at) < EPS && min >= e.min + corner - EPS && max <= e.max - corner + EPS)) { issue('opening-bounds', 'Opening must fit one actual boundary edge; doors/windows need wall material at its corners.', opening.id); continue; }
    const boundaries = [...new Set([min, max, ...floor.rooms.flatMap(other => roomShapes.get(other.id)!.edges
      .filter(e => e.axis === axis && Math.abs(e.at - at) < EPS).flatMap(e => [e.min, e.max]).filter(t => t > min + EPS && t < max - EPS))])].sort((a, b) => a - b);
    const samples = boundaries.slice(1).map((end, i) => (boundaries[i] + end) / 2), roomSides = samples.map(t => [-1, 1].map(sign => floor.rooms.find(other => footprintContainsPoint(roomShapes.get(other.id)!, axis === 'x' ? { x: t, z: at + sign * .001 } : { x: at + sign * .001, z: t }))?.id ?? null));
    if (roomSides.some(pair => pair[0] !== roomSides[0][0] || pair[1] !== roomSides[0][1])) { issue('opening-junction', 'An opening cannot cross a partition junction.', opening.id); continue; }
    const adjacent = roomSides[0].filter((id): id is string => id !== null);
    const levels = adjacent.map(id => roomMap.get(id)!.room.elevation ?? 0), bottom = sill + (walkable ? Math.max(...levels) : room.elevation ?? 0);
    if (opening.kind === 'passage') {
      const shared = adjacent.length === 2 ? roomShapes.get(adjacent[0])!.edges.flatMap(a => roomShapes.get(adjacent[1])!.edges
        .filter(b => b.axis === a.axis && b.side !== a.side && Math.abs(a.at - b.at) < EPS && a.axis === axis && Math.abs(a.at - at) < EPS)
        .map(b => ({ min: Math.max(a.min, b.min), max: Math.min(a.max, b.max) }))) : [];
      if (adjacent.length !== 2 || Math.abs(levels[0] - levels[1]) > EPS || !shared.some(span => Math.abs(span.min - min) < EPS && Math.abs(span.max - max) < EPS)
        || Math.abs(bottom + opening.height - (floor.height - slab)) > EPS) {
        issue('passage', 'An open-plan passage must remove a full shared wall span between equal-level rooms up to the clear ceiling.', opening.id); continue;
      }
    }
    if (bottom + opening.height > floor.height - slab + EPS) { issue('opening-headroom', 'Opening must fit below the fixed storey ceiling above the higher room surface.', opening.id); continue; }
    if (opening.kind === 'door' && adjacent.length === 1 && Math.abs(levels[0]) > EPS) { issue('elevated-exterior-door', 'Exterior doors require a grade-level room; connect raised/lowered rooms through an interior transition.', opening.id); continue; }
    const entry = { axis, at, min, max, opening, floor, bottom, rooms: adjacent } as LocalOpening;
    try {
      if (opening.door !== undefined && opening.door !== false) opening.door = snapshotDoorSelection(opening.door);
      entry.door = resolveBuildingDoorIntent(recipe, floor, opening, adjacent).selection;
    }
    catch (error) { issue('door-policy', error instanceof Error ? error.message : String(error), opening.id); }
    if (localOpenings.some(o => o.floor.id === floor.id && o.axis === axis && Math.abs(o.at - at) < EPS && Math.min(o.max, max) - Math.max(o.min, min) > EPS
      && Math.min(o.bottom + o.opening.height, bottom + opening.height) - Math.max(o.bottom, bottom) > EPS)) issue('opening-overlap', 'Declare a shared-wall opening once; openings cannot overlap.', opening.id);
    localOpenings.push(entry);
    const p = axis === 'x' ? { x: center, y: floor.y + bottom + opening.height / 2, z: at } : { x: at, y: floor.y + bottom + opening.height / 2, z: center };
    const endpoints = [-1, 1].map((sign, index) => { const id = roomSides[0][index]; return { roomId: id, position: world(recipe, { ...p,
      x: p.x + (axis === 'z' ? sign * (actor.radius + thick) : 0), y: floor.y + (id ? roomMap.get(id)!.room.elevation ?? 0 : 0), z: p.z + (axis === 'x' ? sign * (actor.radius + thick) : 0) }) }; });
    if (opening.kind === 'door' && adjacent.length === 2 && Math.abs(levels[0] - levels[1]) > EPS) {
      const lowIndex = levels[0] < levels[1] ? 0 : 1, lowRoom = adjacent[lowIndex], highRoom = adjacent[1 - lowIndex];
      const low = floor.y + levels[lowIndex], high = floor.y + levels[1 - lowIndex], rise = high - low, sign = lowIndex === 0 ? 1 : -1;
      const ux = axis === 'z' ? sign : 0, uz = axis === 'x' ? sign : 0, landing = actor.radius * 2 + .12;
      const run = opening.transition?.run ?? Math.max(1, rise / Math.tan(Math.min(actor.maxSlopeDegrees, 30) * Math.PI / 180), Math.ceil(rise / .18) * .22);
      const length = run + landing * 2, x = p.x - ux * (landing + run / 2), z = p.z - uz * (landing + run / 2);
      const reserved = rectFor({ x: p.x - ux * length / 2, z: p.z - uz * length / 2, width: ux ? length : opening.width + thick, depth: uz ? length : opening.width + thick });
      const upper = rectFor({ x: p.x + ux * landing / 2, z: p.z + uz * landing / 2, width: ux ? landing : opening.width + thick, depth: uz ? landing : opening.width + thick });
      const ramp = rectFor({ x, z, width: ux ? run : opening.width, depth: uz ? run : opening.width });
      const plateau = rectFor({ x: p.x - ux * landing / 2, z: p.z - uz * landing / 2, width: ux ? landing : opening.width, depth: uz ? landing : opening.width });
      if (Math.atan2(rise, run) * 180 / Math.PI > actor.maxSlopeDegrees + EPS || run > 32
        || !footprintContainsRectangle(roomShapes.get(lowRoom)!, asRectangle(reserved)) || !footprintContainsRectangle(roomShapes.get(highRoom)!, asRectangle(upper)))
        issue('transition-bounds', 'Door transition needs bounded slope and clear lower/upper landings inside its two rooms; increase run or room space.', opening.id);
      if ((floor.furniture ?? []).some(item => item.collision !== false && (intersects(reserved, furnitureRect(item)) || intersects(upper, furnitureRect(item))))) issue('blocked-transition', 'Furniture blocks a door transition or its landing.', opening.id);
      if (transitions.some(other => other.floor.id === floor.id && [other.reserved, other.upperLanding].some(a => [reserved, upper].some(b => intersects(a, b)))))
        issue('transition-overlap', 'Door transitions and their landings cannot overlap.', opening.id);
      transitions.push({ id: opening.id, kind: opening.transition?.kind ?? 'steps', floor, lowRoom, highRoom, x, z, ux, uz, width: opening.width, run, low, high, rect: ramp, landing: plateau, reserved, upperLanding: upper });
      endpoints[lowIndex].position = world(recipe, { x: p.x - ux * (run + landing * 1.5), y: low, z: p.z - uz * (run + landing * 1.5) });
      endpoints[1 - lowIndex].position = world(recipe, { x: p.x + ux * landing / 2, y: high, z: p.z + uz * landing / 2 });
    } else if (opening.transition) issue('transition-level', 'Explicit transitions require an interior door between different room elevations.', opening.id);
    portals.push({ id: opening.id, kind: opening.kind, roomIds: adjacent, position: world(recipe, p), width: opening.width, height: opening.height, exterior: adjacent.length === 1, endpoints });
    if (walkable) {
      const clearance: Rect = axis === 'x' ? { minX: min, maxX: max, minZ: at - actor.radius * 2 - thick, maxZ: at + actor.radius * 2 + thick }
        : { minX: at - actor.radius * 2 - thick, maxX: at + actor.radius * 2 + thick, minZ: min, maxZ: max };
      if ((floor.furniture ?? []).some(item => item.collision !== false && (item.y ?? 0) < actor.height && intersects(clearance, furnitureRect(item)))) issue('blocked-door', 'Furniture blocks a doorway or its approach.', opening.id);
    }
  }
  for (const transition of transitions) for (const opening of localOpenings) {
    if (opening.floor.id !== transition.floor.id || opening.opening.id === transition.id || opening.opening.kind === 'window') continue;
    const reach = actor.radius * 2 + thick;
    const approach: Rect = opening.axis === 'x' ? { minX: opening.min, maxX: opening.max, minZ: opening.at - reach, maxZ: opening.at + reach }
      : { minX: opening.at - reach, maxX: opening.at + reach, minZ: opening.min, maxZ: opening.max };
    if ([transition.reserved, transition.upperLanding].some(r => intersects(r, approach)))
      issue('transition-door-overlap', 'A transition or required landing intrudes into another doorway approach.', transition.id, opening.opening.id);
  }
  const stairs: Stair[] = [];
  for (const s of recipe.stairs ?? []) {
    if (!s || typeof s !== 'object') { issue('stair', 'Stair must be an object.'); continue; }
    unique(s.id); const from = floorMap.get(s.fromFloor), to = floorMap.get(s.toFloor);
    checkMaterial(s.material, s.id);
    if (!from || !to || sortedFloors.indexOf(to) !== sortedFloors.indexOf(from) + 1 || ![s.x, s.z].every(finite) || !positive(s.width) || !positive(s.run) || !['north', 'south', 'east', 'west'].includes(s.direction)
      || s.width < actor.radius * 2 + .1 || Math.atan2(to.y - from.y, s.run) * 180 / Math.PI > actor.maxSlopeDegrees) { issue('stair', 'Stairs must join adjacent storeys, fit the actor and respect its maximum slope.', s.id); continue; }
    const ux = s.direction === 'east' ? 1 : s.direction === 'west' ? -1 : 0, uz = s.direction === 'south' ? 1 : s.direction === 'north' ? -1 : 0;
    const rect = rectFor({ ...s, width: ux ? s.run : s.width, depth: uz ? s.run : s.width }), landing = actor.radius * 2 + .12;
    const landRect = { minX: rect.minX - Math.abs(ux) * landing, maxX: rect.maxX + Math.abs(ux) * landing, minZ: rect.minZ - Math.abs(uz) * landing, maxZ: rect.maxZ + Math.abs(uz) * landing };
    const fromRoom = from.rooms.find(r => footprintContainsRectangle(roomShapes.get(r.id)!, asRectangle(landRect), thick / 2)), toRoom = to.rooms.find(r => footprintContainsRectangle(roomShapes.get(r.id)!, asRectangle(landRect), thick / 2));
    if (!fromRoom || !toRoom) { issue('stair-bounds', 'Stairs and clear landings must fit one room on each storey without crossing walls.', s.id); continue; }
    if ((fromRoom.elevation ?? 0) !== 0 || (toRoom.elevation ?? 0) !== 0) { issue('stair-elevation', 'Inter-storey stairs currently require grade-level rooms at both ends; use an interior doorway transition to split-level rooms.', s.id); continue; }
    if (transitions.some(transition => [from.id, to.id].includes(transition.floor.id) && [transition.reserved, transition.upperLanding].some(r => intersects(r, landRect)))) issue('stair-transition-overlap', 'Inter-storey stairs cannot intersect a doorway transition or its landings.', s.id);
    if (stairs.some(other => (other.from.id === from.id || other.to.id === from.id || other.from.id === to.id || other.to.id === to.id) && intersects(other.rect, landRect))) issue('stair-overlap', 'Stair footprints and landings cannot overlap another staircase.', s.id);
    if ([from, to].some(floor => (floor.furniture ?? []).some(item => item.collision !== false && intersects(landRect, furnitureRect(item))))) issue('blocked-stair', 'Furniture blocks stairs or a landing.', s.id);
    stairs.push({ ...s, from, to, ux, uz, rect, fromRoom: fromRoom.id, toRoom: toRoom.id });
    portals.push({ id: s.id, kind: 'stair', roomIds: [fromRoom.id, toRoom.id], position: world(recipe, { x: s.x, y: (from.y + to.y) / 2, z: s.z }), width: s.width, height: actor.height, exterior: false,
      endpoints: [{ roomId: fromRoom.id, position: world(recipe, { x: s.x - ux * (s.run / 2 + landing / 2), y: from.y, z: s.z - uz * (s.run / 2 + landing / 2) }) },
        { roomId: toRoom.id, position: world(recipe, { x: s.x + ux * (s.run / 2 + landing / 2), y: to.y, z: s.z + uz * (s.run / 2 + landing / 2) }) }] });
  }
  if (issues.length) return finish();
  if (recipe.primaryEntrance !== undefined) {
    const entrance = portals.find(p => p.id === recipe.primaryEntrance), start = entrance?.roomIds[0];
    const owner = start ? roomMap.get(start) : undefined;
    if (!idOkay(recipe.primaryEntrance) || !entrance || entrance.kind !== 'door' || !entrance.exterior || !owner || owner.floor.id !== sortedFloors[0].id)
      issue('primary-entrance', 'Primary entrance must name an exterior door on the lowest floor.', String(recipe.primaryEntrance));
    else {
      const restricted = (id: string) => ['private', 'service'].includes(roomMap.get(id)?.room.access ?? '');
      if (restricted(start!)) issue('primary-entrance-access', 'Primary entrance must enter a public, circulation or unclassified room, not a private/service room.', entrance.id, start!);
      const reached = new Set<string>(restricted(start!) ? [] : [start!]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const portal of portals) if (!portal.exterior && portal.kind !== 'window' && portal.roomIds.every(id => !restricted(id)) && portal.roomIds.some(id => reached.has(id)))
          for (const id of portal.roomIds) if (!reached.has(id)) { reached.add(id); changed = true; }
      }
      const publicRooms = [...roomMap.values()].filter(item => item.room.access === 'public').map(item => item.room.id).sort();
      const unreachable = publicRooms.filter(id => !reached.has(id));
      result.diagnostics.publicAccess = { entranceId: entrance.id, reachableRooms: [...reached].sort(), unreachableRooms: unreachable };
      if (unreachable.length) issue('public-room-access', 'Public rooms need an internal door/stair route from the primary entrance without private/service rooms.', ...unreachable);
    }
    if (issues.length) return finish();
  }
  const colors = { wall: '#d2c6af', floor: '#85765f', roof: '#66574e', stair: '#88765e', furniture: '#87684b', door: '#87684b', ...recipe.colors };
  const resolvedMaterials = new Map<string, ResolvedSurfaceMaterial>();
  const resolveMaterial = (input: SurfaceMaterialInput, key: string) => {
    let material = resolvedMaterials.get(key);
    if (!material) { material = resolveSurfaceMaterial(input, { seed: (recipe.seed ?? 0) >>> 0, key: `${recipe.id}:${key}` }); resolvedMaterials.set(key, material); }
    return material;
  };
  const materialFor = (role: keyof BuildingMaterials, floor?: BuildingFloorRecipe, room?: BuildingRoomRecipe): ResolvedSurfaceMaterial | undefined => {
    const roomInput = room?.materials?.[role as 'wall' | 'floor' | 'ceiling'];
    if (roomInput) return resolveMaterial(roomInput, `room:${room!.id}:${role}`);
    if (role === 'roof' && recipe.roof && recipe.roof.material) return resolveMaterial(recipe.roof.material, 'roof');
    if (floor?.materials?.[role]) return resolveMaterial(floor.materials[role]!, `floor:${floor.id}:${role}`);
    return recipe.materials?.[role] ? resolveMaterial(recipe.materials[role]!, role) : undefined;
  };
  let materialPatchCount = 0;
  const patch = (part: BuildingPart, value: BuildingMaterialPatch) => {
    if (++materialPatchCount > 16384) { if (materialPatchCount === 16385) issue('material-budget', 'Building surface patches exceed the 16384-patch budget.'); return; }
    (part.materialPatches ??= []).push(value);
  };
  const horizontalMaterials = (part: BuildingPart, tile: Rect, face: 'py' | 'ny', floor: BuildingFloorRecipe | undefined,
    role: 'floor' | 'ceiling', roomId?: string) => {
    if (!floor) return;
    const x = (tile.minX + tile.maxX) / 2, z = (tile.minZ + tile.maxZ) / 2;
    for (const room of floor.rooms) {
      if (roomId && room.id !== roomId) continue;
      const material = materialFor(role, floor, room); if (!material) continue;
      for (const roomTile of roomShapes.get(room.id)!.tiles.map(rectFor)) {
        const minX = Math.max(tile.minX, roomTile.minX), maxX = Math.min(tile.maxX, roomTile.maxX);
        const minZ = Math.max(tile.minZ, roomTile.minZ), maxZ = Math.min(tile.maxZ, roomTile.maxZ);
        if (maxX - minX > EPS && maxZ - minZ > EPS) patch(part, { face, minU: minX - x, maxU: maxX - x,
          minV: minZ - z, maxV: maxZ - z, offsetU: x, offsetV: z, material, roomId: room.id });
      }
    }
  };
  const add = (id: string, kind: BuildingPart['kind'], p: PhysicsVector, size: PhysicsVector, floorId: string, exterior: boolean,
    extras: Partial<BuildingPart> = {}, yaw = 0, pitch = 0, exactSize = false) => {
    if(!exactSize)size = { x: snap(size.x), y: snap(size.y), z: snap(size.z) };
    const material = kind === 'door' ? undefined : materialFor(kind, floorMap.get(floorId));
    const part: BuildingPart = { id: `${recipe.id}:${id}`, kind, position: world(recipe, p), size, rotation: rotation((recipe.yaw ?? 0) + yaw, pitch), color: colors[kind], collidable: true, visible: true, exterior, floorId, ...(material ? { material } : {}), ...extras };
    parts.push(part);
    if (part.collidable) {
      if ([size.x, size.y, size.z].some(n => !finite(n) || n < (part.geometry ? EPS : .04) || n > 2000)
        || Object.values(part.position).some(n => !finite(n) || Math.abs(n) > 10000)) issue('collider-dimensions', 'Generated boxes require dimensions of at least .04m and positions within ±10000m; widen thin wall strips or furniture.', part.id);
      if (part.model) {
        try { result.colliders.push(...transformAssetColliders(part.model, { ...part.position, y: part.position.y - size.y / 2 }, (recipe.yaw ?? 0) + yaw)); }
        catch (error) { issue('furniture-model-placement', error instanceof Error ? error.message : String(error), part.id); }
      } else result.colliders.push({ shape: part.geometry ? { kind: 'convex', vertices: part.geometry.vertices }
        : { kind: 'box', halfExtents: { x: size.x / 2, y: size.y / 2, z: size.z / 2 } }, position: { ...part.position }, rotation: { ...part.rotation }, friction: .8 });
    }
    return part;
  };
  const addSteps = (id:string, s:{x:number;z:number;ux:number;uz:number;width:number;run:number}, low:number, high:number,
    floorId:string, roomId:string, exterior:boolean, extras:Partial<BuildingPart>={}) => {
    // A native rounded capsule cannot climb a riser near its full radius.
    // Bound rise by the declared actor as well as the 18cm architectural cap.
    const rise=high-low,steps=Math.ceil(rise/Math.min(.18,actor.radius*.5)),run=s.run/steps,riser=rise/steps,thickness=riser+.12,yaw=Math.atan2(s.ux,s.uz);
    if(!Number.isSafeInteger(steps)||steps>BUILDING_LIMITS.parts-parts.length||run<.04){
      issue('stair-budget','Solid stairs must fit the part budget and retain at least 4cm of tread run for the declared actor.',id);return;
    }
    for(let i=0;i<steps;i++){
      const from=s.run*(i/steps-.5),to=s.run*((i+1)/steps-.5),t=(from+to)/2,x=s.x+s.ux*t,z=s.z+s.uz*t,top=low+riser*(i+1),treadRun=to-from;
      // Adjacent solids overlap vertically by the structural 12cm underside;
      // there is no open riser or invisible sloping collider beneath the treads.
      // Keep shared tread endpoints exact. Independently rounding box size
      // would create microscopic overlaps absent from its support footprint.
      add(`${id}:tread:${i}`,'stair',{x,y:top-thickness/2,z},{x:s.width,y:thickness,z:treadRun},floorId,exterior,{roomId,...extras},yaw,0,true);
      surfaces.push({...rectFor({x,z,width:s.ux?treadRun:s.width,depth:s.uz?treadRun:s.width}),id:`${recipe.id}:${id}:tread:${i}`,
        kind:'stair',floorId,roomId,y:top,slopeX:0,slopeZ:0,centerX:x,centerZ:z});
    }
  };
  for (const floor of sortedFloors) {
    // Upper walking slabs occupy the last thickness of the storey below.
    // End lower walls at their underside so released pieces do not begin
    // embedded in the deck. The top roof cap sits above its storey instead.
    const wallTop = floor.height - (floor === sortedFloors.at(-1) ? 0 : slab);
    const cuts = stairs.filter(s => s.to.id === floor.id).map(s => s.rect);
    const splitLevel = floor.rooms.some(room => (room.elevation ?? 0) !== 0);
    const sources = splitLevel ? [...floor.rooms].sort((a, b) => compare(a.id, b.id)).map(room => ({ id: `${floor.id}:${room.id}`, roomId: room.id,
      y: roomY(room, floor), thickness: slab + Math.max(0, room.elevation ?? 0), tiles: roomShapes.get(room.id)!.tiles.map(rectFor) }))
      : [{ id: floor.id, roomId: undefined, y: floor.y, thickness: slab, tiles: recipe.footprint ? footprint.tiles.map(rectFor) : [bounds] }];
    // Slabs reach the outer wall face, closing the storey band and ground-floor
    // plinth with real geometry. Union the exterior extension before cutting
    // stairs; independently inflating rooms would overlap split-level slabs.
    let envelope: ReturnType<typeof expandBuildingSlabs>;
    try { envelope = expandBuildingSlabs(sources.map(source => ({ tiles: source.tiles.map(asRectangle) })), thick / 2); }
    catch (error) { issue('slab-envelope', error instanceof Error ? error.message : String(error), floor.id); return finish(); }
    const edgeMaterial = materialFor('wall', floor);
    for (const [sourceIndex, source] of sources.entries()) {
      let tiles = envelope.groups[sourceIndex].tiles.map(rectFor); for (const cut of cuts) tiles = tiles.flatMap(tile => subtract(tile, cut));
      for (const [i, tile] of tiles.entries()) {
        const part = add(`${source.id}:slab:${i}`, 'floor', { x: (tile.minX + tile.maxX) / 2, y: source.y - source.thickness / 2, z: (tile.minZ + tile.maxZ) / 2 }, { x: tile.maxX - tile.minX, y: source.thickness, z: tile.maxZ - tile.minZ }, floor.id, true, source.roomId ? { roomId: source.roomId } : {});
        horizontalMaterials(part, tile, 'py', floor, 'floor', source.roomId);
        horizontalMaterials(part, tile, 'ny', sortedFloors[sortedFloors.indexOf(floor) - 1], 'ceiling');
        // Only the exterior perimeter carries the wall finish. Stair openings,
        // interior step risers and freshly fractured faces retain slab material.
        for (const edge of envelope.edges) {
          const alongX = edge.axis === 'x', side = edge.side;
          const at = side === 'north' ? tile.minZ : side === 'south' ? tile.maxZ : side === 'west' ? tile.minX : tile.maxX;
          if (Math.abs(at - edge.at) > EPS) continue;
          const min = Math.max(edge.min, alongX ? tile.minX : tile.minZ), max = Math.min(edge.max, alongX ? tile.maxX : tile.maxZ);
          if (max - min <= EPS) continue;
          const center = alongX ? (tile.minX + tile.maxX) / 2 : (tile.minZ + tile.maxZ) / 2;
          patch(part, { face: side === 'north' ? 'nz' : side === 'south' ? 'pz' : side === 'west' ? 'nx' : 'px',
            minU: min - center, maxU: max - center, minV: -part.size.y / 2, maxV: part.size.y / 2,
            offsetU: center, offsetV: source.y - source.thickness / 2,
            ...(edgeMaterial ? { material: edgeMaterial } : { color: colors.wall }) });
        }
        surfaces.push({ ...tile, id: `${recipe.id}:${source.id}:surface:${i}`, kind: 'floor', floorId: floor.id, ...(source.roomId ? { roomId: source.roomId } : {}), y: source.y, slopeX: 0, slopeZ: 0, centerX: 0, centerZ: 0 });
      }
    }
    const walls = new Map<string, Wall[]>();
    for (const room of [...floor.rooms].sort((a, b) => compare(a.id, b.id))) {
      rooms.push({ id: room.id, floorId: floor.id, center: world(recipe, { x: room.x, y: floor.y + (floor.height + (room.elevation ?? 0)) / 2, z: room.z }), size: { x: room.width, y: floor.height - (room.elevation ?? 0), z: room.depth }, yaw: recipe.yaw ?? 0, ...(room.label ? { label: room.label } : {}), ...(room.purpose ? { purpose: room.purpose } : {}), ...(room.access ? { access: room.access } : {}), ...(room.orientation ? { orientation: room.orientation } : {}),
        ...(room.elevation === undefined ? {} : { elevation: room.elevation }), ...(room.footprint ? { footprint: roomShapes.get(room.id)!.tiles.map(tile => ({ ...tile, x: tile.x - room.x, z: tile.z - room.z })) } : {}) });
      for (const wall of roomShapes.get(room.id)!.edges.map(({ axis, at, min, max }) => ({ axis, at, min, max }))) {
        wall.at = snap(wall.at); wall.min = snap(wall.min); wall.max = snap(wall.max);
        const key = `${wall.axis}:${wall.at}`, list = walls.get(key) ?? []; list.push(wall); walls.set(key, list);
      }
    }
    const wallSolids: { id: string; axis: 'x' | 'z'; at: number; piece: Rect; exterior: boolean }[] = [];
    for (const [key, list] of [...walls].sort(([a], [b]) => compare(a, b))) {
      const { axis, at } = list[0], ends = [...new Set(list.flatMap(w => [w.min, w.max]))].sort((a, b) => a - b);
      for (let i = 1; i < ends.length; i++) {
        const min = ends[i - 1], max = ends[i], mid = (min + max) / 2;
        if (!list.some(w => mid > w.min && mid < w.max)) continue;
        const beside = floor.rooms.filter(room => [-.001, .001].some(delta => footprintContainsPoint(roomShapes.get(room.id)!, axis === 'x' ? { x: mid, z: at + delta } : { x: at + delta, z: mid })));
        const exterior = footprint.edges.some(edge => edge.axis === axis && Math.abs(edge.at - at) < EPS && mid > edge.min && mid < edge.max);
        // Exterior raised-room fill now reaches the complete wall footprint;
        // start its wall on that walking slab rather than embedding it in fill.
        const levels = beside.map(room => room.elevation ?? 0);
        const wallBottom = exterior ? Math.min(...levels) : Math.min(0, ...levels);
        let pieces: Rect[] = [{ minX: min, maxX: max, minZ: wallBottom, maxZ: wallTop }];
        for (const o of localOpenings.filter(o => o.floor.id === floor.id && o.axis === axis && Math.abs(o.at - at) < EPS)) pieces = pieces.flatMap(p => subtract(p,
          { minX: o.min, maxX: o.max, minZ: o.opening.kind === 'passage' ? wallBottom : o.bottom, maxZ: o.opening.kind === 'passage' ? wallTop : o.bottom + o.opening.height }));
        for (const [j, piece] of pieces.entries()) wallSolids.push({ id: `${floor.id}:wall:${key}:${i}:${j}`, axis, at, piece, exterior });
      }
    }
    // Deterministic butt joints: Z runs retain the junction, while X runs
    // finish at their faces. Resolve actual solid rectangles after apertures,
    // so an opening never gains an invisible support or loses its clear width.
    const xSolids = wallSolids.filter(wall => wall.axis === 'x'), zSolids = wallSolids.filter(wall => wall.axis === 'z');
    const joinedZ = zSolids.flatMap(wall => {
      const { piece, at } = wall;
      const crossing = xSolids.filter(other => (Math.abs(other.at - piece.minX) < EPS || Math.abs(other.at - piece.maxX) < EPS)
        && other.piece.minX < at + thick / 2 - EPS && other.piece.maxX > at - thick / 2 + EPS
        && other.piece.minZ < piece.maxZ - EPS && other.piece.maxZ > piece.minZ + EPS);
      if (!crossing.length) return [wall];
      const neighbors = zSolids.filter(other => other !== wall && Math.abs(other.at - at) < EPS
        && (Math.abs(other.piece.maxX - piece.minX) < EPS || Math.abs(other.piece.minX - piece.maxX) < EPS)
        && other.piece.minZ < piece.maxZ - EPS && other.piece.maxZ > piece.minZ + EPS);
      const levels = [...new Set([piece.minZ, piece.maxZ, ...[...crossing, ...neighbors].flatMap(other =>
        [Math.max(piece.minZ, other.piece.minZ), Math.min(piece.maxZ, other.piece.maxZ)])])].sort((a, b) => a - b);
      const bands: Rect[] = [];
      for (let i = 1; i < levels.length; i++) {
        const minZ = levels[i - 1], maxZ = levels[i], middle = (minZ + maxZ) / 2;
        const active = (other: typeof wall) => middle > other.piece.minZ - EPS && middle < other.piece.maxZ + EPS;
        const extend = (end: number, minimum: boolean) => crossing.some(other => active(other) && Math.abs(other.at - end) < EPS)
          && !neighbors.some(other => active(other) && Math.abs((minimum ? other.piece.maxX : other.piece.minX) - end) < EPS);
        const next = { minX: piece.minX - (extend(piece.minX, true) ? thick / 2 : 0), maxX: piece.maxX + (extend(piece.maxX, false) ? thick / 2 : 0), minZ, maxZ };
        const previous = bands.at(-1);
        if (previous && Math.abs(previous.minX - next.minX) < EPS && Math.abs(previous.maxX - next.maxX) < EPS) previous.maxZ = maxZ;
        else bands.push(next);
      }
      return bands.map((piece, index) => ({ ...wall, piece, id: bands.length === 1 ? wall.id : `${wall.id}:join:${index}` }));
    });
    const joined = wallSolids.flatMap(wall => {
      if (wall.axis === 'z') return joinedZ.filter(other => other.id === wall.id || other.id.startsWith(`${wall.id}:join:`));
      let pieces = [wall.piece];
      for (const other of joinedZ) if (other.piece.minX < wall.at + thick / 2 - EPS && other.piece.maxX > wall.at - thick / 2 + EPS)
        pieces = pieces.flatMap(piece => subtract(piece, { minX: other.at - thick / 2, maxX: other.at + thick / 2, minZ: other.piece.minZ, maxZ: other.piece.maxZ }));
      return pieces.map((piece, index) => ({ ...wall, piece, id: pieces.length === 1 ? wall.id : `${wall.id}:join:${index}` }));
    });
    for (const { id, axis, at, piece, exterior } of joined) {
          const t = (piece.minX + piece.maxX) / 2, y = floor.y + (piece.minZ + piece.maxZ) / 2;
          const part = add(id, 'wall', axis === 'x' ? { x: t, y, z: at } : { x: at, y, z: t },
            axis === 'x' ? { x: piece.maxX - piece.minX, y: piece.maxZ - piece.minZ, z: thick } : { x: thick, y: piece.maxZ - piece.minZ, z: piece.maxX - piece.minX }, floor.id, exterior);
          for (const sign of [-1, 1]) {
            const owner = floor.rooms.find(room => footprintContainsPoint(roomShapes.get(room.id)!, axis === 'x' ? { x: t, z: at + sign * .001 } : { x: at + sign * .001, z: t }));
            const material = materialFor('wall', floor, owner); if (!material) continue;
            patch(part, { face: axis === 'x' ? sign < 0 ? 'nz' : 'pz' : sign < 0 ? 'nx' : 'px',
              minU: -(piece.maxX - piece.minX) / 2, maxU: (piece.maxX - piece.minX) / 2,
              minV: -part.size.y / 2, maxV: part.size.y / 2, offsetU: t, offsetV: y, material, ...(owner ? { roomId: owner.id } : {}) });
          }
    }
    for (const item of [...(floor.furniture ?? [])].sort((a, b) => compare(a.id, b.id))) add(`furniture:${item.id}`, 'furniture', { x: item.x, y: roomY(roomMap.get(item.room)!.room, floor) + (item.y ?? 0) + item.height / 2, z: item.z },
      { x: item.width, y: item.height, z: item.depth }, floor.id, false, { roomId: item.room, ...(item.asset ? { asset: item.asset } : {}), ...(item.model ? { model: item.model } : {}), ...(item.color ? { color: item.color } : {}), ...(item.material ? { material: resolveMaterial(item.material, `furniture:${item.id}`) } : {}), collidable: item.collision !== false }, item.yaw ?? 0);
  }
  for (const s of stairs) {
    const material = s.material ? { material: resolveMaterial(s.material, `stair:${s.id}`) } : {};
    addSteps(`stair:${s.id}`,s,s.from.y,s.to.y,s.from.id,s.fromRoom,true,material);
  }
  for (const transition of transitions) {
    const s = transition, rise = s.high - s.low, angle = Math.atan2(rise, s.run), yaw = Math.atan2(s.ux, s.uz);
    if(s.kind==='steps')addSteps(`transition:${s.id}`,s,s.low,s.high,s.floor.id,s.lowRoom,false);
    else{
      add(`transition:${s.id}:ramp`, 'stair', { x: s.x, y: (s.low + s.high) / 2 - .06 / Math.cos(angle), z: s.z },
        { x: s.width, y: .12, z: Math.hypot(s.run, rise) }, s.floor.id, false, { roomId: s.lowRoom }, yaw, -angle);
      surfaces.push({ ...s.rect, id: `${recipe.id}:transition:${s.id}`, kind:'stair',floorId:s.floor.id,roomId:s.lowRoom,
        y:(s.low+s.high)/2,slopeX:s.ux*rise/s.run,slopeZ:s.uz*rise/s.run,centerX:s.x,centerZ:s.z });
    }
    const landing = asRectangle(s.landing);
    add(`transition:${s.id}:landing`, 'stair', { x: landing.x, y: (s.low + s.high - slab) / 2, z: landing.z },
      { x: landing.width, y: rise + slab, z: landing.depth }, s.floor.id, false, { roomId: s.lowRoom });
    surfaces.push({ ...s.landing, id: `${recipe.id}:transition:${s.id}:landing`, kind: 'stair', floorId: s.floor.id, roomId: s.lowRoom,
      y: s.high, slopeX: 0, slopeZ: 0, centerX: landing.x, centerZ: landing.z });
  }
  const top = sortedFloors.at(-1)!;
  if (recipe.roof !== false) {
    const roofTiles = recipe.footprint ? footprint.tiles : [{ x: 0, z: 0, width: recipe.width + thick, depth: recipe.depth + thick }];
    for (const [i, tile] of roofTiles.entries()) {
      const id = recipe.footprint ? `roof:${i}` : 'roof';
      const part = add(id, 'roof', { x: tile.x, y: top.y + top.height + slab / 2, z: tile.z }, { x: tile.width, y: slab, z: tile.depth }, top.id, true, recipe.roof?.color ? { color: recipe.roof.color } : {});
      horizontalMaterials(part, rectFor(tile), 'ny', top, 'ceiling');
      surfaces.push({ ...(recipe.footprint ? rectFor(tile) : bounds), id: `${recipe.id}:${id}`, kind: 'roof', floorId: top.id, y: top.y + top.height + slab, slopeX: 0, slopeZ: 0, centerX: 0, centerZ: 0 });
    }
    if (recipe.roof?.kind === 'gable') {
      const half = (recipe.depth + thick) / 2, rise = recipe.roof.rise ?? 2, angle = Math.atan2(rise, half);
      const eave = top.y + top.height + slab, peak = eave + rise;
      for (const side of [-1, 1]) {
        if (recipe.footprint) {
          for (const [i, tile] of footprint.tiles.entries()) {
            const r = rectFor(tile), low = side < 0 ? r.minZ : Math.max(0, r.minZ), high = side < 0 ? Math.min(0, r.maxZ) : r.maxZ;
            if (high - low <= EPS) continue;
            const z = (low + high) / 2, y = peak - side * z * rise / half;
            // Anchor the complete upper face to the support rectangle. Moving
            // only vertically leaves a thickness-sized gap beside the ridge.
            add(`roof:gable:${side}:${i}`, 'roof', { x: tile.x, y: y - slab * Math.cos(angle) / 2, z: z - side * slab * Math.sin(angle) / 2 },
              { x: tile.width, y: slab, z: (high - low) / Math.cos(angle) }, top.id, true,
              recipe.roof.color ? { color: recipe.roof.color } : {}, 0, side * angle);
            surfaces.push({ minX: r.minX, maxX: r.maxX, minZ: low, maxZ: high, id: `${recipe.id}:roof:gable:${side}:${i}`,
              kind: 'roof', floorId: top.id, y: peak, slopeX: 0, slopeZ: -side * rise / half, centerX: 0, centerZ: 0 });
          }
          continue;
        }
        // Offset along the roof normal so both the upper plane and its entire
        // footprint agree with the authored support, including the ridge seam.
        add(`roof:gable:${side}`, 'roof', { x: 0, y: eave + rise / 2 - slab * Math.cos(angle) / 2,
          z: side * half / 2 - side * slab * Math.sin(angle) / 2 },
          { x: recipe.width + thick, y: slab, z: Math.hypot(half, rise) }, top.id, true,
          recipe.roof.color ? { color: recipe.roof.color } : {}, 0, side * angle);
        surfaces.push({ minX: -recipe.width / 2, maxX: recipe.width / 2, minZ: side < 0 ? -recipe.depth / 2 : 0,
          maxZ: side < 0 ? 0 : recipe.depth / 2, id: `${recipe.id}:roof:gable:${side}`, kind: 'roof', floorId: top.id,
          y: peak, slopeX: 0, slopeZ: -side * rise / half, centerX: 0, centerZ: 0 });
      }
      if (recipe.roof.enclosure !== false) {
        const enclosure = typeof recipe.roof.enclosure === 'object' ? recipe.roof.enclosure : undefined;
        const slope = rise / half, undersidePeak = peak - slab / Math.cos(angle), reach = (undersidePeak - eave) / slope;
        // Clip wall strips to actual roof coverage. On a compound footprint this
        // includes concave boundaries without filling a notch or an interior seam.
        const coverage = recipe.footprint ? footprint.tiles.map(rectFor)
          : [rectFor({ x: 0, z: 0, width: recipe.width + thick, depth: recipe.depth + thick })];
        const supportingWalls = parts.filter(part => part.kind === 'wall' && part.exterior && part.floorId === top.id)
          .map(part => ({ part, p: local(recipe, part.position) }));
        // Match the wall butt joints below: Z-facing runs own the complete
        // corner and X runs finish against them. Clip this disjoint partition
        // to the real roof afterwards, including concave footprint corners.
        const edgeStrips = footprint.edges.map((edge, edgeIndex) => ({ edge, edgeIndex, strip: edge.axis === 'z'
          ? { minX: edge.at - thick / 2, maxX: edge.at + thick / 2, minZ: edge.min - thick / 2, maxZ: edge.max + thick / 2 }
          : { minX: edge.min, maxX: edge.max, minZ: edge.at - thick / 2, maxZ: edge.at + thick / 2 } }));
        const joinedStrips = edgeStrips.flatMap(entry => {
          let strips = [entry.strip];
          if (entry.edge.axis === 'x') for (const other of edgeStrips) if (other.edge.axis === 'z')
            strips = strips.flatMap(strip => subtract(strip, other.strip));
          return strips.map((strip, stripIndex) => ({ ...entry, strip, stripIndex, split: strips.length > 1 }));
        });
        for (const { edge, edgeIndex, strip, stripIndex, split } of joinedStrips) {
          for (const [tileIndex, tile] of coverage.entries()) {
            const minX = Math.max(strip.minX, tile.minX), maxX = Math.min(strip.maxX, tile.maxX);
            const minZ = Math.max(strip.minZ, tile.minZ, -reach), maxZ = Math.min(strip.maxZ, tile.maxZ, reach);
            if (maxX - minX <= EPS || maxZ - minZ <= EPS) continue;
            const zs = minZ < 0 && maxZ > 0 ? [minZ, 0, maxZ] : [minZ, maxZ];
            const upper = Math.max(...zs.map(z => undersidePeak - Math.abs(z) * slope));
            if (upper - eave <= 1e-6) continue; // The roof already meets its ceiling here.
            const p = { x: (minX + maxX) / 2, y: (eave + upper) / 2, z: (minZ + maxZ) / 2 };
            const size = { x: maxX - minX, y: upper - eave, z: maxZ - minZ };
            // Keep small valid convex tips: unlike boxes, their height need not
            // reach the 4cm primitive minimum. The roof bounds their real solid.
            const vertices: PhysicsVector[] = [];
            for (const x of [minX, maxX]) for (const z of zs) for (const y of [eave, Math.max(eave, undersidePeak - Math.abs(z) * slope)]) {
              const vertex = { x: snap(x - p.x), y: snap(y - p.y), z: snap(z - p.z) };
              if (!vertices.some(v => v.x === vertex.x && v.y === vertex.y && v.z === vertex.z)) vertices.push(vertex);
            }
            const candidates = supportingWalls.filter(({ p: at }) => Math.abs((edge.axis === 'x' ? at.z : at.x) - edge.at) < 1e-5);
            candidates.sort((a, b) => {
              const distance = ({ part, p: at }: typeof a) => Math.max(0, Math.abs(at.x - p.x) - part.size.x / 2)
                + Math.max(0, Math.abs(at.z - p.z) - part.size.z / 2) + Math.abs(top.y + top.height - at.y - part.size.y / 2);
              return distance(a) - distance(b) || compare(a.part.id, b.part.id);
            });
            if (!candidates.length) { issue('roof-enclosure-support', 'Roof enclosure has no exterior wall attachment.', `${edge.side}:${edgeIndex}`); continue; }
            const geometry = { vertices, indices: physicsConvexFaces({ kind: 'convex', vertices }).flat() };
            add(`roof:enclosure:${edge.side}:${edgeIndex}:${tileIndex}${split ? `:join:${stripIndex}` : ''}`, 'wall', p, size, top.id, true,
              { geometry, attachmentParentId: candidates[0].part.id,
                ...(enclosure?.color ? { color: enclosure.color } : {}),
                ...(enclosure?.material ? { material: resolveMaterial(enclosure.material, 'roof-enclosure') } : {}) });
          }
        }
      }
    }
  }
  const doorColliders: { door: BuildingDoor; colliders: PhysicsCollider[] }[] = [];
  const staticColliders = result.colliders.slice();
  const beforeDoorIssues = issues.length;
  for (const entry of localOpenings) {
    if (!entry.door) continue;
    const { opening, floor } = entry;
    try {
      const selected = resolveBuildingDoorSelection(entry.door, { seed: (recipe.seed ?? 0) >>> 0, key: `${recipe.id}:${opening.id}` });
      const geometry = compileDoorGeometry({ id: `${recipe.id}:door:${opening.id}`, width: opening.width, height: opening.height,
        wallThickness: thick, design: selected.design, seed: (recipe.seed ?? 0) >>> 0 });
      const yaw = opening.side === 'north' ? 0 : opening.side === 'south' ? Math.PI : opening.side === 'east' ? -Math.PI / 2 : Math.PI / 2;
      const center = (entry.min + entry.max) / 2, baseY = floor.y + entry.bottom;
      const origin = entry.axis === 'x' ? { x: center, y: baseY, z: entry.at } : { x: entry.at, y: baseY, z: center };
      const localPoint = (p: PhysicsVector): PhysicsVector => ({ x: snap(origin.x + Math.cos(yaw) * p.x + Math.sin(yaw) * p.z),
        y: snap(baseY + p.y), z: snap(origin.z - Math.sin(yaw) * p.x + Math.cos(yaw) * p.z) });
      const transformed = geometry.colliders.map(collider => ({ ...collider, position: world(recipe, localPoint(collider.position)),
        rotation: rotateByYaw(collider.rotation, yaw + (recipe.yaw ?? 0)) }));
      const door: BuildingDoor = { id: opening.id, portalId: opening.id, openingId: opening.id, floorId: floor.id, roomIds: [...entry.rooms],
        type: geometry.type, open: geometry.open, ...(selected.variantId === undefined ? {} : { variantId: selected.variantId }),
        currentClearWidth: geometry.currentClearWidth, currentClearCenter: geometry.currentClearCenter,
        traversable: geometry.currentClearWidth >= actor.radius * 2 + .1 - EPS,
        partIds: geometry.parts.map(part => part.id), baseY, height: opening.height,
        reservations: geometry.reservations.map(reservation => { const p = localPoint({ x: reservation.x, y: 0, z: reservation.z }); return {
          ...reservation, x: p.x, z: p.z, width: snap(Math.abs(Math.cos(yaw)) * reservation.width + Math.abs(Math.sin(yaw)) * reservation.depth),
          depth: snap(Math.abs(Math.sin(yaw)) * reservation.width + Math.abs(Math.cos(yaw)) * reservation.depth) }; }) };
      if (door.open === 1 && !door.traversable) issue('door-clearance', 'A fully open door must preserve the actor clearance width; widen the opening or choose a thinner leaf.', opening.id);
      for (const part of geometry.parts) parts.push({ id: part.id, kind: 'door', doorId: opening.id, floorId: floor.id, roomId: opening.room,
        position: world(recipe, localPoint(part.position)), size: { ...part.size }, rotation: rotation((recipe.yaw ?? 0) + yaw + part.yaw),
        color: part.color, collidable: part.collidable, visible: true, exterior: entry.rooms.length === 1,
        ...(part.model ? { model: part.model } : {}), ...(part.material ? { material: part.material } : {}) });
      (result.doors ??= []).push(door); result.colliders.push(...transformed); doorColliders.push({ door, colliders: transformed });
      const portal = portals.find(portal => portal.id === opening.id)!;
      portal.doorId = door.id; portal.currentClearWidth = door.currentClearWidth;
    } catch (error) { issue('door-geometry', error instanceof Error ? error.message : String(error), opening.id); }
  }
  if (issues.length > beforeDoorIssues) return finish();
  if (recipe.floors.some(floor => floor.fixtures?.length)) {
    for (const floor of recipe.floors) for (const fixture of floor.fixtures ?? []) unique(fixture?.id);
    if (issues.length) return finish();
    const resolved = resolveBuildingFixtures({ ...result, diagnostics: { ...result.diagnostics, valid: true } });
    for (const problem of resolved.issues) issue(problem.code, problem.message, ...(problem.ids ?? []));
    for (const part of resolved.parts) if (!part.material) {
      const material = materialFor('furniture', part.floorId ? floorMap.get(part.floorId) : undefined);
      if (material) part.material = material;
    }
    parts.push(...resolved.parts); result.colliders.push(...resolved.colliders); staticColliders.push(...resolved.colliders); result.lights = resolved.lights;
    if (issues.length) return finish();
  }
  if (doorColliders.length) {
    const occupied = staticColliders.map(collisionBox);
    for (const item of doorColliders) {
      const posed = item.colliders.map(collisionBox);
      if (posed.some(leaf => occupied.some(other => doorCollision(leaf, other))))
        issue('door-pose-collision', 'A door in its authored pose intersects a wall, furniture, fixture, stair or another door; change its hinge, swing, pose or placement.', item.door.id);
      occupied.push(...posed);
    }
    if (issues.length) return finish();
  }
  // Door/stair topology plus actual doorway approaches. Furniture connectivity is
  // checked below on a bounded actor-sized grid rather than inferred from room labels.
  const baseRooms = new Set(sortedFloors[0].rooms.map(r => r.id));
  const reached = new Set<string>(portals.filter(p => p.kind === 'door' && p.exterior && p.roomIds.some(id => baseRooms.has(id))).flatMap(p => p.roomIds));
  let changed = true; while (changed) { changed = false; for (const p of portals.filter(p => p.kind !== 'window')) if (p.roomIds.some(id => reached.has(id))) for (const id of p.roomIds) if (!reached.has(id)) { reached.add(id); changed = true; } }
  result.diagnostics.reachableRooms = [...reached].sort(); result.diagnostics.unreachableRooms = rooms.map(r => r.id).filter(id => !reached.has(id)).sort();
  if (result.diagnostics.unreachableRooms.length) issue('disconnected-room', 'Every room needs a door/stair route to an exterior entrance.', ...result.diagnostics.unreachableRooms);
  if (result.doors?.length) {
    const blocked = new Set(result.doors.filter(door => !door.traversable).map(door => door.portalId));
    const current = new Set<string>(portals.filter(portal => portal.kind === 'door' && portal.exterior && !blocked.has(portal.id)
      && portal.roomIds.some(id => baseRooms.has(id))).flatMap(portal => portal.roomIds));
    let changed = true;
    while (changed) { changed = false; for (const portal of portals) if (portal.kind !== 'window' && !blocked.has(portal.id)
      && portal.roomIds.some(id => current.has(id))) for (const id of portal.roomIds) if (!current.has(id)) { current.add(id); changed = true; } }
    result.diagnostics.traversal = { reachableRooms: [...current].sort(), unreachableRooms: rooms.map(room => room.id).filter(id => !current.has(id)).sort(), blockedPortalIds: [...blocked].sort() };
  }
  for (const floor of sortedFloors) for (const room of floor.rooms) {
    const endpoints = portals.filter(p => p.kind !== 'window').flatMap(portal => {
      const door = result.doors?.find(door => door.portalId === portal.id), opening = door ? localOpenings.find(entry => entry.opening.id === portal.id)!.opening : undefined;
      const yaw = opening?.side === 'north' ? 0 : opening?.side === 'south' ? Math.PI : opening?.side === 'east' ? -Math.PI / 2 : Math.PI / 2;
      return portal.endpoints.filter(endpoint => endpoint.roomId === room.id).map(endpoint => {
        const point = local(recipe, endpoint.position);
        return door?.traversable ? { ...point, x: point.x + Math.cos(yaw) * door.currentClearCenter, z: point.z - Math.sin(yaw) * door.currentClearCenter } : point;
      });
    });
    const obstacles = (floor.furniture ?? []).filter(item => item.room === room.id && item.collision !== false && (item.y ?? 0) < actor.height);
    const roomStairs = stairs.filter(s => s.fromRoom === room.id || s.toRoom === room.id), roomTransitions = transitions.filter(s => s.lowRoom === room.id);
    const roomDoors = doorColliders.filter(item => item.door.traversable && item.door.floorId === floor.id && item.door.roomIds.includes(room.id));
    if (endpoints.length && (obstacles.length || roomStairs.length || room.footprint || roomTransitions.length || roomDoors.length)) {
      // Check only this room's furniture and stair ramps. Its rectangular walls
      // are already enforced by the inset grid, ceilings by storey headroom,
      // and slab holes by the shared support surfaces. Avoid scanning the whole
      // building's render/collision parts at every grid cell in a sandbox.
      const stairPrefixes=[...roomStairs.map(s=>`${recipe.id}:stair:${s.id}:`),...roomTransitions.map(s=>`${recipe.id}:transition:${s.id}:`)];
      const cy = Math.cos((recipe.yaw ?? 0) / 2), sy = Math.sin((recipe.yaw ?? 0) / 2);
      // Authoring reserves each furniture envelope even when a model has open
      // legs/shelves. Prepare local geometry once, not at every flood-fill cell.
      const obstaclesForClearance = parts.filter(p => p.collidable && (p.kind === 'furniture' && p.roomId === room.id || stairPrefixes.some(prefix=>p.id.startsWith(prefix))))
        .map(p => prepareClearanceCollider({ shape: { kind: 'box', halfExtents: { x: p.size.x / 2, y: p.size.y / 2, z: p.size.z / 2 } },
          position: local(recipe, p.position), rotation: { x: cy * p.rotation.x - sy * p.rotation.z, y: cy * p.rotation.y - sy * p.rotation.w,
            z: cy * p.rotation.z + sy * p.rotation.x, w: cy * p.rotation.w + sy * p.rotation.y } }));
      obstaclesForClearance.push(...roomDoors.flatMap(item => item.colliders.map(collider => prepareClearanceCollider({ ...collider,
        position: local(recipe, collider.position), rotation: rotateByYaw(collider.rotation, -(recipe.yaw ?? 0)) }))));
      const supporting = surfaces.filter(s => s.kind === 'floor' && s.floorId === floor.id || s.kind === 'stair' && (roomStairs.some(r => s.id.startsWith(`${recipe.id}:stair:${r.id}:`))
        || roomTransitions.some(r => s.id === `${recipe.id}:transition:${r.id}` || s.id.startsWith(`${recipe.id}:transition:${r.id}:`))));
      const baseY = roomY(room, floor), maxY = Math.max(baseY, ...roomTransitions.map(s => s.high));
      const safe = (p: { x: number; z: number }) => {
        if (room.footprint && !footprintContainsPoint(roomShapes.get(room.id)!, p, actor.radius + thick / 2 + .01)) return false;
        let supportY = -Infinity, normalLength = 1;
        for (const surface of supporting) if (contains(surface, p)) {
          const y = surface.y + surface.slopeX * (p.x - surface.centerX) + surface.slopeZ * (p.z - surface.centerZ);
          if (y <= maxY + .05 && baseY + .025 - y <= .08 && y > supportY) {
            supportY = y; normalLength = Math.hypot(surface.slopeX, 1, surface.slopeZ);
          }
        }
        if (supportY === -Infinity || supportY + actor.height > floor.y + floor.height - slab + EPS) return false;
        return capsuleClearance(obstaclesForClearance, p.x, supportY + actor.radius * (normalLength - 1), p.z, actor.radius, actor.height);
      };
      const approachesSafe = endpoints.every(p => safe(p));
      if (!approachesSafe) issue('unsupported-approach', 'A doorway or stair approach lacks floor support or usable headroom.', room.id);
      if (endpoints.length < 2) continue;
      const r = rectFor(room), margin = actor.radius + thick / 2 + .02, step = Math.max(.2, actor.radius, room.width / 64, room.depth / 64);
      // Furnishing reserves endpoint -> centre-X -> room-centre corridors.
      // Prove that explicit connection first; checking a few short paths avoids
      // flooding an entire room whose circulation has already been laid out.
      // Failure (including a blocked centre) keeps the original grid fallback.
      const centre = { x: room.x, z: room.z }, spacing = Math.min(.2, actor.radius);
      let directSamples = 0;
      const segmentSafe = (from: { x: number; z: number }, to: { x: number; z: number }) => {
        const samples = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / spacing);
        // Tiny actors or many portals must not make this optional shortcut
        // more expensive than the bounded fallback it is meant to avoid.
        if (!Number.isFinite(samples) || directSamples + samples > 4096) return false;
        directSamples += samples;
        for (let i = 1; i <= samples; i++) {
          const t = i / samples;
          if (!safe({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t })) return false;
        }
        return true;
      };
      if (approachesSafe && safe(centre) && endpoints.every(endpoint => {
        if (!contains(r, endpoint, margin)) return false;
        const corner = { x: centre.x, z: endpoint.z };
        return segmentSafe(endpoint, corner) && segmentSafe(corner, centre);
      })) continue;
      const nx = Math.max(1, Math.floor((room.width - margin * 2) / step)), nz = Math.max(1, Math.floor((room.depth - margin * 2) / step));
      const point = (x: number, z: number) => ({ x: r.minX + margin + (room.width - margin * 2) * x / nx, z: r.minZ + margin + (room.depth - margin * 2) * z / nz });
      const stride = nx + 1, seen = new Uint8Array(stride * (nz + 1));
      // A valid doorway approach can round into the inset of a concave wall.
      // Attach it to a nearby safe grid node through a checked local corridor,
      // instead of treating that one rounded cell as the only possible target.
      directSamples = 0;
      const node = (p: { x: number; z: number }): number | undefined => {
        const cx = Math.max(0, Math.min(nx, Math.round((p.x - r.minX - margin) / (room.width - margin * 2) * nx)));
        const cz = Math.max(0, Math.min(nz, Math.round((p.z - r.minZ - margin) / (room.depth - margin * 2) * nz)));
        const nearby: { key: number; point: { x: number; z: number }; distance: number }[] = [];
        for (let z = Math.max(0, cz - 1); z <= Math.min(nz, cz + 1); z++) for (let x = Math.max(0, cx - 1); x <= Math.min(nx, cx + 1); x++) {
          const target = point(x, z); nearby.push({ key: z * stride + x, point: target, distance: (target.x - p.x) ** 2 + (target.z - p.z) ** 2 });
        }
        for (const candidate of nearby.sort((a, b) => a.distance - b.distance || a.key - b.key)) {
          const target = candidate.point;
          if (!safe(target) || room.footprint && !footprintContainsRectangle(roomShapes.get(room.id)!, {
            x: (p.x + target.x) / 2, z: (p.z + target.z) / 2,
            width: Math.abs(p.x - target.x) + margin * 2, depth: Math.abs(p.z - target.z) + margin * 2 })) continue;
          if (segmentSafe(p, target)) return candidate.key;
        }
      };
      const endpointNodes = endpoints.map(node);
      if (endpointNodes.some(key => key === undefined)) {
        issue('blocked-room-route', 'A doorway/stair approach cannot reach the actor clearance grid.', room.id); continue;
      }
      const queue = [endpointNodes[0]!], targets = new Set(endpointNodes as number[]);
      seen[queue[0]] = 1;
      const enqueue = (index: number, from: number) => {
        if (seen[index]) return;
        if (room.footprint) {
          const a = point(from % stride, Math.floor(from / stride)), b = point(index % stride, Math.floor(index / stride));
          // Coarse grids in very large rooms must not jump an exterior notch.
          // The swept actor corridor must belong to the union, including between nodes.
          if (!footprintContainsRectangle(roomShapes.get(room.id)!, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2,
            width: Math.abs(a.x - b.x) + margin * 2, depth: Math.abs(a.z - b.z) + margin * 2 })) return;
        }
        seen[index] = 1; queue.push(index);
      };
      for (let q = 0; q < queue.length && targets.size; q++) {
        const key = queue[q], x = key % stride, z = Math.floor(key / stride);
        if (!safe(point(x, z))) continue;
        seen[key] = 2; targets.delete(key);
        if (x > 0) enqueue(key - 1, key); if (x < nx) enqueue(key + 1, key);
        if (z > 0) enqueue(key - stride, key); if (z < nz) enqueue(key + stride, key);
      }
      if (targets.size) issue('blocked-room-route', 'Furniture, stairwell holes or insufficient headroom separate required doorway/stair approaches.', room.id);
    }
  }
  const expandedParts = parts.reduce((count, part) => count + (part.model?.parts.length ?? 1), 0);
  if (expandedParts > BUILDING_LIMITS.parts || result.colliders.length > BUILDING_LIMITS.colliders) issue('geometry-budget', 'Compiled geometry, including expanded family model parts, exceeds building limits.');
  const roofRise = recipe.roof && recipe.roof.kind === 'gable' ? recipe.roof.rise ?? 2 : 0;
  const bottomY = Math.min(...sortedFloors[0].rooms.map(room => roomY(room, sortedFloors[0]))) - slab;
  const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(z => [bottomY, top.y + top.height + slab + roofRise].map(y => world(recipe, { x: x * (recipe.width + thick) / 2, y, z: z * (recipe.depth + thick + (roofRise ? slab : 0)) / 2 }))));
  for (const part of parts.filter(part => part.kind === 'door')) {
    const box = collisionBox({ position: part.position, rotation: part.rotation, shape: { kind: 'box', halfExtents: { x: part.size.x / 2, y: part.size.y / 2, z: part.size.z / 2 } } });
    corners.push({ x: box.min[0], y: box.min[1], z: box.min[2] }, { x: box.max[0], y: box.max[1], z: box.max[2] });
  }
  if (corners.some(p => [p.x, p.y, p.z].some(n => Math.abs(n) > 10000))) issue('world-bounds', 'Building geometry must stay within the physics ±10000m coordinate budget.');
  result.bounds = { min: { x: Math.min(...corners.map(p => p.x)), y: Math.min(...corners.map(p => p.y)), z: Math.min(...corners.map(p => p.z)) }, max: { x: Math.max(...corners.map(p => p.x)), y: Math.max(...corners.map(p => p.y)), z: Math.max(...corners.map(p => p.z)) } };
  return finish();
}

/** Highest real floor/tread/ramp beneath a world-space feet query, within maxDrop metres.
 * Unlike XZ terrain sampling, Y selects the storey. Does not infer actual grounded state. */
export function sampleBuilding(manifest: BuildingManifest, point: PhysicsVector, maxDrop = .5): BuildingSupport | undefined {
  if (!manifest.diagnostics.valid || !Object.values(point).every(finite) || !finite(maxDrop) || maxDrop < 0) return undefined;
  const p = local(manifest.recipe, point); let selected: BuildingSurface | undefined, height = -Infinity;
  for (const surface of manifest.surfaces) if (contains(surface, p)) {
    const y = surface.y + surface.slopeX * (p.x - surface.centerX) + surface.slopeZ * (p.z - surface.centerZ);
    if (y <= p.y + .025 && p.y - y <= maxDrop && y > height) { selected = surface; height = y; }
  }
  if (!selected) return undefined;
  const length = Math.hypot(selected.slopeX, 1, selected.slopeZ), n = { x: -selected.slopeX / length, y: 1 / length, z: -selected.slopeZ / length }, c = Math.cos(manifest.recipe.yaw ?? 0), s = Math.sin(manifest.recipe.yaw ?? 0);
  const roomId = selected.roomId ?? manifest.recipe.floors.find(f => f.id === selected!.floorId)?.rooms.find(r => r.footprint
    ? r.footprint.some(tile => contains(rectFor(tile), p)) : contains(rectFor(r), p))?.id;
  return { id: selected.id, kind: selected.kind, floorId: selected.floorId, ...(roomId ? { roomId } : {}), point: world(manifest.recipe, { x: p.x, y: height, z: p.z }), normal: { x: c * n.x + s * n.z, y: n.y, z: -s * n.x + c * n.z } };
}

interface ClearanceCollider {
  position: PhysicsVector; rotation: PhysicsRotation; half: number[];
  ballRadius: number; upright: boolean; cosine: number; sine: number;
}
function prepareClearanceCollider(collider: PhysicsCollider): ClearanceCollider {
  if (collider.shape.kind === 'convex') {
    const { min, max } = physicsShapeBounds(collider.shape, collider.rotation), p = collider.position;
    return { position: { x: p.x + (min.x + max.x) / 2, y: p.y + (min.y + max.y) / 2, z: p.z + (min.z + max.z) / 2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 }, half: [(max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2],
      ballRadius: 0, upright: true, cosine: 1, sine: 0 };
  }
  const q = collider.rotation ?? { x: 0, y: 0, z: 0, w: 1 }, shape = collider.shape;
  const half = shape.kind === 'box' ? [shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z] : [0, 0, 0];
  return { position: collider.position, rotation: q, half, ballRadius: shape.kind === 'ball' ? shape.radius : 0,
    upright: Math.abs(q.x) < 1e-12 && Math.abs(q.z) < 1e-12, cosine: 1 - 2 * q.y * q.y, sine: 2 * q.w * q.y };
}
function capsuleClearance(colliders: ClearanceCollider[], px: number, py: number, pz: number, radius: number, height: number): boolean {
  const lowY = py + radius, highY = py + height - radius, threshold = Math.max(0, radius - .02) ** 2;
  for (const collider of colliders) {
    const x = px - collider.position.x, z = pz - collider.position.z;
    if (collider.ballRadius) {
      const dy = Math.max(lowY - collider.position.y, collider.position.y - highY, 0);
      if (x * x + dy * dy + z * z < Math.max(0, radius + collider.ballRadius - .02) ** 2) return false;
      continue;
    }
    const half = collider.half;
    if (collider.upright) {
      // A vertical capsule segment stays vertical under yaw: distance to the
      // local box is just the sum of independent interval distances. This is
      // the common case for walls, furniture and floors, with no per-box arrays.
      const dy = Math.max(lowY - collider.position.y - half[1], collider.position.y - highY - half[1], 0);
      if (dy * dy >= threshold) continue;
      const dx = Math.max(0, Math.abs(collider.cosine * x - collider.sine * z) - half[0]);
      const dz = Math.max(0, Math.abs(collider.sine * x + collider.cosine * z) - half[2]);
      if (dx * dx + dy * dy + dz * dz < threshold) return false;
      continue;
    }
    const inverse = (worldY: number): number[] => {
      const q = collider.rotation, y = worldY - collider.position.y;
      const tx = -2 * (q.y * z - q.z * y), ty = -2 * (q.z * x - q.x * z), tz = -2 * (q.x * y - q.y * x);
      return [x + q.w * tx - q.y * tz + q.z * ty, y + q.w * ty - q.z * tx + q.x * tz, z + q.w * tz - q.x * ty + q.y * tx];
    };
    const a = inverse(lowY), b = inverse(highY), delta = b.map((v, i) => v - a[i]), breaks = [0, 1];
    for (let i = 0; i < 3; i++) if (Math.abs(delta[i]) > EPS) for (const edge of [-half[i], half[i]]) { const t = (edge - a[i]) / delta[i]; if (t > 0 && t < 1) breaks.push(t); }
    breaks.sort((x, y) => x - y); let distanceSq = Infinity;
    const distance = (t: number) => a.reduce((sum, v, i) => sum + Math.max(0, Math.abs(v + delta[i] * t) - half[i]) ** 2, 0);
    for (let j = 1; j < breaks.length; j++) {
      const low = breaks[j - 1], high = breaks[j], middle = (low + high) / 2; let numerator = 0, denominator = 0;
      for (let i = 0; i < 3; i++) { const v = a[i] + delta[i] * middle; if (Math.abs(v) > half[i]) { numerator += delta[i] * (a[i] - Math.sign(v) * half[i]); denominator += delta[i] ** 2; } }
      const t = denominator ? Math.max(low, Math.min(high, -numerator / denominator)) : middle;
      distanceSq = Math.min(distanceSq, distance(t), distance(low), distance(high));
    }
    if (distanceSq < threshold) return false;
  }
  return true;
}

/** Capsule clearance against the same compound boxes/balls sent to physics,
 * with 2cm contact tolerance. Cylinders use the manifest's conservative boxes.
 * Compiler route validation separately reserves whole furniture envelopes.
 * On slopes, capsule feet sit slightly above the sampled support plane. */
export function buildingClearance(manifest: BuildingManifest, point: PhysicsVector, radius: number, height: number): boolean {
  if (!manifest.diagnostics.valid || !Object.values(point).every(finite) || !positive(radius) || !finite(height) || height < radius * 2) return false;
  return capsuleClearance(manifest.colliders.map(prepareClearanceCollider), point.x, point.y, point.z, radius, height);
}
