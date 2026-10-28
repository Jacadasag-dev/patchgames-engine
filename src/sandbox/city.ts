/** Editable, finite city blocks. Generation happens when a recipe changes, never
 * in a simulation tick. Buildings retain independent IDs and random streams. */
import { compileBuilding, sampleBuilding, type BuildingRecipe, type BuildingManifest } from './building.ts';
import { PHYSICS_SCENE_LIMITS, type PhysicsScene, type PhysicsVector } from './physics.ts';
import { prepareTerrainRecipe, type TerrainRecipe } from './terrain.ts';
import { createTerrainWorld, type TerrainWorldHost } from './terrainWorld.ts';
import { transformAssetColliders, validateAssetManifest, type AssetManifest } from './assetFamilies.ts';
import type { PhysicsCollider } from './physics.ts';
import { colliderBlocksCorridor, colliderBlocksRectangle } from './spatial.ts';
import { compileBuildingFootprint } from './buildingFootprints.ts';

export interface CityStreet { id: string; x: number; z: number; width: number; depth: number; sidewalk?: number }
export interface CityAccess { buildingId: string; portalId: string; streetId: string; width: number; points: PhysicsVector[] }
export interface CityProp { id: string; position: PhysicsVector; yaw?: number; model: AssetManifest }
export interface CompiledCityProp extends CityProp { bounds: { min: PhysicsVector; max: PhysicsVector }; colliders: PhysicsCollider[] }
export interface CityRecipe {
  version: 1;
  id: string;
  seed: number;
  streets: CityStreet[];
  buildings: BuildingRecipe[];
  /** Shared-model outdoor objects; their actual compound collision joins the host. */
  props?: CityProp[];
  /** Flat exterior ground; upper floors come from building geometry. */
  groundY?: number;
  budgets?: { buildings?: number; parts?: number; colliders?: number };
}
export interface CityIssue { severity: 'error' | 'warning'; code: string; message: string; ids: string[] }
export interface CityManifest {
  version: 1;
  id: string;
  revision: string;
  recipe: CityRecipe;
  streets: CityStreet[];
  buildings: BuildingManifest[];
  props: CompiledCityProp[];
  access: CityAccess[];
  bounds: { width: number; depth: number };
  diagnostics: { valid: boolean; issues: CityIssue[]; counts: { buildings: number; rooms: number; props: number; parts: number; colliders: number } };
  changes: { added: string[]; removed: string[]; updated: string[]; unchanged: number };
}
export interface CityBlockOptions {
  id?: string;
  seed?: number;
  columns?: number;
  rows?: number;
  lotWidth?: number;
  lotDepth?: number;
  streetWidth?: number;
  setback?: number;
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function random(seed: number, key: string): number {
  let value = hash(`${seed}:${key}`); value ^= value >>> 16; value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15; value = Math.imul(value, 0x846ca68b); return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
function bounded(value: number, name: string, min: number, max: number, integer = false): number {
  if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value))
    throw new Error(`City ${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return value;
}
const PALETTES = [
  { wall: '#d6ba91', floor: '#b88b60', roof: '#485e66', trim: '#4a7272' },
  { wall: '#b77660', floor: '#b49272', roof: '#414c61', trim: '#f0ddae' },
  { wall: '#dde0cc', floor: '#af9474', roof: '#59664f', trim: '#536c73' },
  { wall: '#c7d2d2', floor: '#b19880', roof: '#655b73', trim: '#936b57' },
  { wall: '#e0c6a2', floor: '#bca085', roof: '#66514b', trim: '#647e57' },
];
const USES = ['bakery', 'bookshop', 'workshop', 'cafe', 'home', 'gallery'];

/** One editable example grammar, not a fixed catalog of permitted buildings.
 * Replace any returned room, opening, part or entire BuildingRecipe. */
export function cityBlockRecipe(options: CityBlockOptions = {}): CityRecipe {
  const seed = bounded(options.seed ?? 41, 'seed', 0, 0xffffffff, true);
  const columns = bounded(options.columns ?? 3, 'columns', 1, 8, true), rows = bounded(options.rows ?? 2, 'rows', 1, 8, true);
  const lotWidth = bounded(options.lotWidth ?? 22, 'lotWidth', 18, 60), lotDepth = bounded(options.lotDepth ?? 24, 'lotDepth', 20, 60);
  const streetWidth = bounded(options.streetWidth ?? 8, 'streetWidth', 4, 20), setback = bounded(options.setback ?? 2, 'setback', 1, 5);
  if (lotWidth - setback * 2 < 10 || lotDepth - setback * 2 < 12)
    throw new Error('City lots after setbacks need at least 10m width and 12m depth for this editable room/stair example.');
  const id = options.id ?? 'city-block';
  const width = columns * lotWidth + (columns + 1) * streetWidth, depth = rows * lotDepth + (rows + 1) * streetWidth;
  const streets: CityStreet[] = [];
  for (let column = 0; column <= columns; column++) streets.push({ id: `avenue-${column}`,
    x: -width / 2 + streetWidth / 2 + column * (lotWidth + streetWidth), z: 0, width: streetWidth, depth, sidewalk: 1.5 });
  for (let row = 0; row <= rows; row++) streets.push({ id: `street-${row}`,
    x: 0, z: -depth / 2 + streetWidth / 2 + row * (lotDepth + streetWidth), width, depth: streetWidth, sidewalk: 1.5 });
  const buildings: BuildingRecipe[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const buildingId = `building-${row}-${column}`, buildingSeed = hash(`${seed}:${buildingId}`);
    const roll = (key: string) => random(buildingSeed, key);
    const w = Math.min(lotWidth - setback * 2, 12.5 + roll('width') * 3), d = Math.min(lotDepth - setback * 2, 14.5 + roll('depth') * 3);
    const x = -width / 2 + streetWidth + lotWidth / 2 + column * (lotWidth + streetWidth);
    const z = -depth / 2 + streetWidth + lotDepth / 2 + row * (lotDepth + streetWidth);
    const palette = PALETTES[Math.floor(roll('palette') * PALETTES.length)], use = USES[(column + row * columns) % USES.length];
    const stories = (column + row) % 3 === 1 ? 1 : 2, hallWidth = 4.2;
    const floors: BuildingRecipe['floors'] = [];
    for (let floor = 0; floor < stories; floor++) {
      const floorId = `floor-${floor}`, split = (roll(`${floorId}:split`) - .5) * 2.4;
      const sideWidth = (w - hallWidth) / 2;
      const rooms: BuildingRecipe['floors'][number]['rooms'] = [
        { id: `${floorId}-hall`, x: 0, z: 0, width: hallWidth, depth: d, purpose: floor ? 'landing' : 'entrance hall' },
      ];
      const openings: NonNullable<BuildingRecipe['floors'][number]['openings']> = [];
      const furniture: NonNullable<BuildingRecipe['floors'][number]['furniture']> = [];
      if (!floor) openings.push({ id: 'entrance', room: `${floorId}-hall`, side: 'south', width: 1.7, height: 2.5, kind: 'door' });
      for (const side of [-1, 1]) for (const front of [false, true]) {
        const roomId = `${floorId}-${side < 0 ? 'west' : 'east'}-${front ? 'front' : 'rear'}`;
        const low = front ? split : -d / 2, high = front ? d / 2 : split;
        const room = { id: roomId, x: side * (hallWidth / 2 + sideWidth / 2), z: (low + high) / 2,
          width: sideWidth, depth: high - low, purpose: floor ? (front ? 'bedroom' : 'study') : (front ? use : 'storeroom') };
        rooms.push(room);
        const doorwayZ = front ? d / 2 - 1.8 : -d / 2 + 1.8;
        openings.push({ id: `${roomId}-door`, room: roomId, side: side < 0 ? 'east' : 'west', offset: doorwayZ - room.z,
          width: 1.35, height: 2.45, kind: 'door' });
        openings.push({ id: `${roomId}-window`, room: roomId, side: side < 0 ? 'west' : 'east',
          width: 1.6, height: 1.3, bottom: .95, kind: 'window' });
        openings.push({ id: `${roomId}-frontage`, room: roomId, side: front ? 'south' : 'north',
          width: Math.min(2.1, sideWidth - .7), height: 1.4, bottom: .85, kind: 'window' });
        const asset = floor ? (front ? 'bed' : 'table') : front ? (use === 'bookshop' ? 'shelf' : use === 'home' ? 'sofa' : use === 'cafe' ? 'table' : 'counter') : 'shelf';
        const fw = asset === 'bed' ? 1.6 : asset === 'shelf' ? .55 : 1.35, fd = asset === 'bed' ? 2.1 : 2;
        const fh = asset === 'shelf' ? 1.85 : asset === 'bed' ? .58 : .85;
        const furnitureX = side * (w / 2 - fw / 2 - .35);
        furniture.push({ id: `${roomId}-main`, room: roomId, asset, x: furnitureX, z: room.z,
          width: fw, depth: fd, height: fh, color: palette.trim });
        furniture.push({ id: `${roomId}-plant`, room: roomId, asset: 'planter',
          x: side * (hallWidth / 2 + .75), z: front ? low + .75 : high - .75, width: .5, depth: .5, height: .8, color: '#607b52', collision: false });
      }
      floors.push({ id: floorId, y: floor * 3.2, height: 3.2, rooms, openings, furniture });
    }
    buildings.push({ version: 1, id: buildingId, seed: buildingSeed, width: w, depth: d,
      origin: { x, y: 0, z }, yaw: row % 2 ? Math.PI : 0, wallThickness: .18, floorThickness: .2,
      colors: palette, floors, actor: { radius: .28, height: 1.7, maxSlopeDegrees: 35 },
      stairs: stories > 1 ? [{ id: 'main-stair', fromFloor: 'floor-0', toFloor: 'floor-1', x: .85, z: 0,
        width: 1.6, run: 6.2, direction: 'north' }] : [], roof: { color: palette.roof } });
  }
  return { version: 1, id, seed, streets, buildings, groundY: 0 };
}

/** Compile independently identified buildings, preserving unchanged compiled
 * objects across edits. Invalid city drafts remain inspectable, never playable. */
export function compileCity(input: CityRecipe, previous?: CityManifest): CityManifest {
  if (!input || input.version !== 1 || typeof input.id !== 'string' || !input.id || input.id.length > 80)
    throw new Error('City requires version 1 and a short, nonempty id.');
  bounded(input.seed, 'seed', 0, 0xffffffff, true);
  if (!Array.isArray(input.buildings) || !input.buildings.length || input.buildings.length > 64 || !Array.isArray(input.streets) || !input.streets.length || input.streets.length > 64)
    throw new Error('City supports 1–64 buildings and 1–64 streets.');
  if (Array.from(input.buildings).some(building => !building || typeof building !== 'object') || Array.from(input.streets).some(street => !street || typeof street !== 'object'))
    throw new Error('City buildings and streets must be objects.');
  if (input.props !== undefined && (!Array.isArray(input.props) || input.props.length > 64 || Array.from(input.props).some(prop => !prop || typeof prop !== 'object')))
    throw new Error('City supports at most64 plain outdoor prop placements.');
  const locations = new WeakMap<object, string[]>(), retainedModels: { path: string[]; model: AssetManifest }[] = [];
  let serialized: string, root = true;
  try { serialized = JSON.stringify(input, function (key, value: unknown) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('nonfinite');
    if (value && typeof value === 'object') {
      // Bind reuse to the exact occurrence visited by the serializer, never a
      // caller-supplied key or a parse-reviver queue. Aliased objects receive the
      // current path again on each visit. Model subtrees need no path tracking.
      const parent = locations.get(this), path = root ? [] : parent ? [...parent, key] : undefined;
      if (path) {
        if (key === 'model') {
          // Frozen is only a fast prefilter. Only validator-owned immutable
          // graphs preserve identity; frozen serialized or forged input cannot.
          if (Object.isFrozen(value)) try {
            if (validateAssetManifest(value as AssetManifest) === value) retainedModels.push({ path, model: value as AssetManifest });
          } catch { /* Normal compilation reports invalid model diagnostics. */ }
        } else if (path.length <= 6) locations.set(value, path);
      }
    }
    root = false; return value;
  }); } catch { throw new Error('City recipes must be finite, acyclic JSON data.'); }
  if (serialized.length > 2_000_000) throw new Error('City recipe exceeds its 2MB source budget.');
  const recipe = JSON.parse(serialized) as CityRecipe, issues: CityIssue[] = [];
  // JSON still validates and charges the complete source before we retain any
  // references. Every mutable placement and recipe object remains a snapshot.
  for (const { path, model } of retainedModels) {
    let target = recipe as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[path.at(-1)!] = model;
  }
  const issue = (code: string, message: string, ids: string[]) => issues.push({ severity: 'error' as const, code, message, ids });
  const limits = { buildings: 64, parts: 16000, colliders: PHYSICS_SCENE_LIMITS.streamedColliders, ...recipe.budgets };
  for (const [key, value] of Object.entries(limits)) bounded(value, `${key} budget`, 1, key === 'buildings' ? 64 : key === 'colliders' ? PHYSICS_SCENE_LIMITS.streamedColliders : 16000, true);
  bounded(recipe.groundY ?? 0, 'groundY', -1000, 1000);
  const ids = new Set<string>(), old = new Map(previous?.buildings.map(building => [building.id, building]) ?? []);
  const buildings = recipe.buildings.map(definition => {
    if (ids.has(definition.id)) issue('duplicate-building', `Duplicate building ${definition.id}.`, [definition.id]);
    ids.add(definition.id);
    const prior = old.get(definition.id);
    return prior && canonical(prior.recipe) === canonical(definition) ? prior : compileBuilding(definition);
  });
  const props: CompiledCityProp[] = [];
  for (const definition of recipe.props ?? []) {
    if (typeof definition.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(definition.id) || ids.has(`prop:${definition.id}`)) {
      issue('prop-id', 'Outdoor props require unique stable IDs.', [String(definition.id)]); continue;
    }
    ids.add(`prop:${definition.id}`);
    if (!definition.position || ![definition.position.x, definition.position.y, definition.position.z, definition.yaw ?? 0].every(Number.isFinite)) {
      issue('prop-transform', 'Outdoor props require a finite position and yaw.', [definition.id]); continue;
    }
    try {
      const model = validateAssetManifest(definition.model), yaw = definition.yaw ?? 0, c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
      const width = c * model.size.x + s * model.size.z, depth = s * model.size.x + c * model.size.z, p = definition.position;
      const bounds = { min: { x: p.x - width / 2, y: p.y, z: p.z - depth / 2 }, max: { x: p.x + width / 2, y: p.y + model.size.y, z: p.z + depth / 2 } };
      if ([...Object.values(bounds.min), ...Object.values(bounds.max)].some(n => Math.abs(n) > 10000)) throw new Error('Outdoor prop exceeds world physics bounds.');
      props.push({ ...definition, model, bounds, colliders: transformAssetColliders(model, p, yaw) });
    } catch (error) { issue('prop-model', error instanceof Error ? error.message : 'Invalid outdoor asset model.', [definition.id]); }
  }
  const streetIds = new Set<string>();
  for (const street of recipe.streets) {
    if (typeof street.id !== 'string' || !street.id || street.id.length > 128 || streetIds.has(street.id)) issue('street-id', 'Streets require unique, nonempty string IDs of at most 128 characters.', [String(street.id)]);
    streetIds.add(street.id);
    for (const [key, value] of Object.entries({ x: street.x, z: street.z })) bounded(value, `street ${key}`, -2000, 2000);
    bounded(street.width, 'street width', 1, 1000); bounded(street.depth, 'street depth', 1, 1000);
    if (street.sidewalk !== undefined) bounded(street.sidewalk, 'sidewalk', 0, Math.min(street.width, street.depth) / 2);
  }
  for (const building of buildings) for (const problem of building.diagnostics.issues)
    issues.push({ severity: 'error', code: `building:${problem.code}`, message: `${building.id}: ${problem.message}`, ids: [building.id] });
  const overlap = (a: { min: PhysicsVector; max: PhysicsVector }, b: { min: PhysicsVector; max: PhysicsVector }) =>
    Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) > .01 && Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > .01;
  for (let i = 0; i < buildings.length; i++) {
    const building = buildings[i];
    for (const other of buildings.slice(i + 1)) if (overlap(building.bounds, other.bounds))
      issue('building-overlap', 'Building bounds overlap; revise the lot or footprint.', [building.id, other.id]);
    for (const street of recipe.streets) if (overlap(building.bounds, { min: { x: street.x - street.width / 2, y: 0, z: street.z - street.depth / 2 },
      max: { x: street.x + street.width / 2, y: 0, z: street.z + street.depth / 2 } }))
      issue('street-overlap', 'A building crosses a reserved street.', [building.id, street.id]);
  }
  for (const prop of props) {
    for (const building of buildings) if (overlap(prop.bounds, building.bounds)) issue('prop-building-overlap', 'Outdoor props cannot intersect a building footprint.', [prop.id, building.id]);
    for (const street of recipe.streets) if (prop.colliders.some(collider => colliderBlocksRectangle(collider, street,
      recipe.groundY ?? 0, Math.max(1.8, ...buildings.map(building => building.recipe.actor?.height ?? 1.8)))))
      issue('prop-street-overlap', 'Outdoor props cannot block reserved streets.', [prop.id, street.id]);
  }
  const streetConnected = new Set([recipe.streets[0].id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of recipe.streets) if (streetConnected.has(a.id)) for (const b of recipe.streets) {
      if (!streetConnected.has(b.id) && Math.abs(a.x - b.x) <= (a.width + b.width) / 2 && Math.abs(a.z - b.z) <= (a.depth + b.depth) / 2) {
        streetConnected.add(b.id); changed = true;
      }
    }
  }
  if (streetConnected.size !== recipe.streets.length) issue('street-disconnected', 'Every street needs a connection to the street network.', recipe.streets.filter(street => !streetConnected.has(street.id)).map(street => street.id));
  const access: CityAccess[] = [];
  const crosses = (worldStart: PhysicsVector, worldEnd: PhysicsVector, origin: PhysicsVector, yaw: number, width: number, depth: number, radius: number): boolean => {
    // Test the actual oriented footprint. A rotated building's world AABB can
    // contain its own outward doorway even when the actor has cleared the wall.
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const local = (p: PhysicsVector) => ({ x: c * (p.x - origin.x) - s * (p.z - origin.z), z: s * (p.x - origin.x) + c * (p.z - origin.z) });
    const start = local(worldStart), end = local(worldEnd), half = { x: width / 2, z: depth / 2 };
    let min = 0, max = 1;
    for (const axis of ['x', 'z'] as const) {
      const delta = end[axis] - start[axis], low = -half[axis] - radius, high = half[axis] + radius;
      if (Math.abs(delta) < 1e-8) { if (start[axis] < low || start[axis] > high) return false; }
      else { const a = (low - start[axis]) / delta, b = (high - start[axis]) / delta;
        min = Math.max(min, Math.min(a, b)); max = Math.min(max, Math.max(a, b)); if (min > max) return false; }
    }
    return max > 1e-6 && min < 1 - 1e-6;
  };
  for (const building of buildings) {
    if (!building.diagnostics.valid) continue;
    for (const portal of building.portals.filter(portal => portal.kind === 'door' && portal.exterior)) {
      const entrance = portal.endpoints.find(endpoint => endpoint.roomId === null)?.position;
      if (!entrance || Math.abs(entrance.y - (recipe.groundY ?? 0)) > .1) continue;
      const radius = building.recipe.actor?.radius ?? .3;
      const candidates = recipe.streets.map(street => ({ street, point: { x: Math.max(street.x - street.width / 2, Math.min(street.x + street.width / 2, entrance.x)),
        y: recipe.groundY ?? 0, z: Math.max(street.z - street.depth / 2, Math.min(street.z + street.depth / 2, entrance.z)) } }))
        .sort((a, b) => Math.hypot(a.point.x - entrance.x, a.point.z - entrance.z) - Math.hypot(b.point.x - entrance.x, b.point.z - entrance.z));
      const candidate = candidates.find(candidate => !buildings.some(other => {
        const origin = other.recipe.origin ?? { x: 0, y: 0, z: 0 }, yaw = other.recipe.yaw ?? 0, wall = other.recipe.wallThickness ?? .18;
        if (!other.recipe.footprint) return crosses(entrance, candidate.point, origin, yaw, other.recipe.width + wall, other.recipe.depth + wall, radius);
        const tiles = compileBuildingFootprint(other.recipe.footprint).footprint!.tiles, c = Math.cos(yaw), s = Math.sin(yaw);
        return tiles.some(tile => crosses(entrance, candidate.point, { x: origin.x + c * tile.x + s * tile.z, y: origin.y, z: origin.z - s * tile.x + c * tile.z },
          yaw, tile.width + wall, tile.depth + wall, radius));
      })
        && !props.some(prop => prop.colliders.some(collider => colliderBlocksCorridor(collider, entrance, candidate.point, radius, building.recipe.actor?.height ?? 1.8))));
      if (candidate) access.push({ buildingId: building.id, portalId: portal.id, streetId: candidate.street.id, width: portal.width,
        points: [{ ...entrance, x: portal.position.x, z: portal.position.z }, entrance, candidate.point]
          .filter((point, index, points) => !index || Math.hypot(point.x - points[index - 1].x, point.z - points[index - 1].z) >= .00001) });
    }
    const primary = building.recipe.primaryEntrance;
    if (!access.some(path => path.buildingId === building.id && (primary === undefined || path.portalId === primary)))
      issue('street-access', primary === undefined ? 'Building needs a ground-level doorway with a clear direct approach to a street.'
        : 'Building primary entrance needs a clear direct approach to a street; a service entrance cannot replace it.', [building.id, ...(primary === undefined ? [] : [primary])]);
    if (access.filter(path => path.buildingId === building.id).length > 8) issue('entrance-budget', 'Terrain reservations support at most eight street approaches per building.', [building.id]);
  }
  const counts = { buildings: buildings.length, rooms: buildings.reduce((n, value) => n + value.rooms.length, 0), props: props.length,
    parts: buildings.reduce((n, value) => n + value.diagnostics.counts.parts, 0) + props.reduce((n, p) => n + p.model.parts.length, 0),
    colliders: buildings.reduce((n, value) => n + value.colliders.length, 0) + props.reduce((n, p) => n + p.colliders.length, 0) };
  for (const key of ['buildings', 'parts', 'colliders'] as const) if (counts[key] > limits[key]) issue('budget', `City ${key} budget exceeded.`, []);
  const halfWidth = Math.max(64, ...buildings.map(value => Math.max(Math.abs(value.bounds.min.x), Math.abs(value.bounds.max.x))),
    ...props.map(value => Math.max(Math.abs(value.bounds.min.x), Math.abs(value.bounds.max.x))),
    ...recipe.streets.map(street => Math.abs(street.x) + street.width / 2));
  const halfDepth = Math.max(64, ...buildings.map(value => Math.max(Math.abs(value.bounds.min.z), Math.abs(value.bounds.max.z))),
    ...props.map(value => Math.max(Math.abs(value.bounds.min.z), Math.abs(value.bounds.max.z))),
    ...recipe.streets.map(street => Math.abs(street.z) + street.depth / 2));
  const bounds = { width: Math.ceil((halfWidth + 8) / 16) * 32, depth: Math.ceil((halfDepth + 8) / 16) * 32 };
  const changes = { added: buildings.filter(value => !old.has(value.id)).map(value => value.id),
    removed: [...old.keys()].filter(id => !ids.has(id)), updated: buildings.filter(value => old.has(value.id) && old.get(value.id)!.revision !== value.revision).map(value => value.id),
    unchanged: buildings.filter(value => old.get(value.id)?.revision === value.revision).length };
  // Building revisions and validated model keys already fingerprint their full
  // geometry. Hash those identities once instead of rewalking every nested mesh
  // and collider a second time during the bounded sandbox module load.
  const revisionSource = issues.length ? recipe : { version: recipe.version, id: recipe.id, seed: recipe.seed,
    groundY: recipe.groundY, budgets: recipe.budgets, streets: recipe.streets,
    buildings: buildings.map(building => ({ id: building.id, revision: building.revision })),
    props: props.map(prop => ({ id: prop.id, position: prop.position, yaw: prop.yaw, model: prop.model.key })) };
  const result: CityManifest = { version: 1, id: recipe.id, revision: `city-v1-${hash(canonical(revisionSource)).toString(16)}`, recipe, streets: recipe.streets, buildings, props, access, bounds,
    diagnostics: { valid: !issues.some(value => value.severity === 'error'), issues, counts }, changes };
  if (result.diagnostics.valid) {
    // A valid city must also fit the shared terrain host's metadata contract:
    // route caps, reservations, source budgets and global sampling bounds.
    for (const problem of prepareTerrainRecipe(cityTerrainRecipe(result)).diagnostics.issues)
      issues.push({ severity: problem.severity, code: `terrain:${problem.code}`, message: problem.message, ids: problem.ids ?? [] });
    result.diagnostics.valid = !issues.some(value => value.severity === 'error');
  }
  return result;
}

function requireValid(city: CityManifest): void {
  if (!city.diagnostics.valid) throw new Error(`Invalid city: ${city.diagnostics.issues.filter(issue => issue.severity === 'error').slice(0, 3).map(issue => issue.message).join(' ')}`);
}

/** Versioned building footprints tie terrain revisions to actual interior
 * geometry; foundations/reservations can coexist with normal biome scatter. */
export function cityTerrainRecipe(city: CityManifest): TerrainRecipe {
  requireValid(city);
  return { version: 1, seed: city.recipe.seed, bounds: { ...city.bounds, cells: 4 }, base: { height: city.recipe.groundY ?? 0 },
    streaming: { chunkSize: 32, cells: 4 }, regions: [],
    assets: [...city.buildings.map(building => ({ id: building.id, version: building.revision,
      footprint: { kind: 'box' as const, width: building.recipe.width, depth: building.recipe.depth } })),
      ...city.props.map(prop => ({ id: `prop:${prop.id}`, version: prop.model.key, footprint: { kind: 'box' as const, width: prop.model.size.x, depth: prop.model.size.z } }))],
    placements: city.buildings.map(building => ({ id: building.id, asset: building.id,
      position: building.recipe.origin ?? { x: 0, y: 0, z: 0 }, yaw: building.recipe.yaw ?? 0, clearance: .2,
      entrances: city.access.filter(access => access.buildingId === building.id).map(access => ({ id: access.portalId, width: access.width,
        clearance: building.recipe.actor?.radius ?? .3, points: access.points.map(point => ({ x: point.x, z: point.z })) })) })),
    reservations: city.props.map(prop => ({ id: `prop:${prop.id}`, mask: { kind: 'box', center: { x: prop.position.x, z: prop.position.z },
      yaw: prop.yaw ?? 0, width: prop.model.size.x, depth: prop.model.size.z } })),
    routes: city.streets.map(street => ({ id: street.id, points: street.width >= street.depth
      ? [{ x: street.x - street.width / 2, z: street.z }, { x: street.x + street.width / 2, z: street.z }]
      : [{ x: street.x, z: street.z - street.depth / 2 }, { x: street.x, z: street.z + street.depth / 2 }],
      width: Math.min(street.width, street.depth), color: '#747f83' })) };
}

/** Use this host on both GameLogic and GameView. The existing terrain preparation
 * worker owns active collision neighborhoods for all players and prediction. */
export function createCityWorld<T>(city: CityManifest): TerrainWorldHost<T> {
  const recipe = cityTerrainRecipe(city);
  return createTerrainWorld<T>(() => recipe, { initialInterests: () => city.access.slice(0, 1).map(access => access.points.at(-1)!), colliders: (_tuning, manifest) => {
    const origin = manifest.origin ?? { x: 0, z: 0 }, x = manifest.bounds.width / 2, z = manifest.bounds.depth / 2;
    return [...city.buildings, ...city.props].filter(building => building.bounds.max.x >= origin.x - x && building.bounds.min.x <= origin.x + x
      && building.bounds.max.z >= origin.z - z && building.bounds.min.z <= origin.z + z).flatMap(building => building.colliders);
  } });
}

/** Bounded eager scene for previews/native-physics checks. Production games use
 * createCityWorld so distant collision is prepared only for actual players. */
export function cityPhysicsScene(city: CityManifest): PhysicsScene {
  requireValid(city);
  const chunkSize = 32, columns = Math.ceil(city.bounds.width / chunkSize), rows = Math.ceil(city.bounds.depth / chunkSize);
  if (columns * rows > PHYSICS_SCENE_LIMITS.terrainChunks) throw new Error('City eager scene exceeds the chunk budget; use createCityWorld.');
  const terrainChunks = [];
  for (let z = 0; z < rows; z++) for (let x = 0; x < columns; x++) terrainChunks.push({
    id: `city-ground:${x}:${z}`, rows: 1, columns: 1, heights: [0, 0, 0, 0], width: chunkSize, depth: chunkSize,
    position: { x: -city.bounds.width / 2 + (x + .5) * chunkSize, y: city.recipe.groundY ?? 0, z: -city.bounds.depth / 2 + (z + .5) * chunkSize },
  });
  return { colliders: [...city.buildings, ...city.props].flatMap(building => building.colliders), terrainChunks };
}

/** Layer-aware support: the caller supplies its current foot height. Never use
 * exterior heightfield samples to snap an upstairs actor onto the street. */
export function sampleCity(city: CityManifest, point: PhysicsVector, maxDrop = 2): ReturnType<typeof sampleBuilding> {
  if (!city.diagnostics.valid) return undefined;
  let best: ReturnType<typeof sampleBuilding>;
  for (const building of city.buildings) {
    if (point.x < building.bounds.min.x || point.x > building.bounds.max.x || point.z < building.bounds.min.z || point.z > building.bounds.max.z) continue;
    const found = sampleBuilding(building, point, maxDrop);
    if (found && (!best || found.point.y > best.point.y)) best = found;
  }
  return best;
}

/** Compact evidence; full geometry remains outside AI diagnostic responses. */
export function cityInspection(city: CityManifest) {
  return { version: city.version, revision: city.revision, valid: city.diagnostics.valid, counts: city.diagnostics.counts,
    issues: city.diagnostics.issues.slice(0, 20), issueCount: city.diagnostics.issues.length, changes: city.changes,
    buildings: city.buildings.slice(0, 16).map(building => ({ id: building.id, revision: building.revision,
      rooms: building.rooms.length, parts: building.diagnostics.counts.parts, colliders: building.colliders.length, valid: building.diagnostics.valid })),
    coverage: 'Finite rectangular blocks; building connectivity and clearance checks are not NPC navigation or exhaustive traversal proof.' };
}
