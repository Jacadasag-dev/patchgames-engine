/** Terrain-aware composition. Sites, roads and assets remain authored data;
 * compilation reserves and validates their shared ground before gameplay. */
import { compileBuilding, type BuildingManifest, type BuildingRecipe, type BuildingSide, type BuildingSurface } from './building.ts';
import { resolveBuildingAttachment, type BuildingAttachmentResult, type WorldBuildingAttachment } from './buildingAttachments.ts';
export type { WorldBuildingAttachment } from './buildingAttachments.ts';
import { transformAssetColliders, validateAssetManifest, type AssetManifest } from './assetFamilies.ts';
import { createPreparedTerrainHeightSampler, createTerrainBaseHeightSampler, createTerrainHeightSampler, prepareTerrainRecipe, sampleTerrain, terrainUsesStreaming,
  type TerrainFootprint, type TerrainManifest, type TerrainPoint, type TerrainRecipe, type TerrainRoute } from './terrain.ts';
import { planWorldRoad, type WorldRoadRequest } from './worldRoads.ts';
import { createTerrainWorld, type TerrainWorldHost, type TerrainWorldOptions } from './terrainWorld.ts';
import type { PhysicsCollider, PhysicsVector } from './physics.ts';
import { colliderBlocksCorridor, spatialCoordinate as coordinate, transformSpatialPoint as transform } from './spatial.ts';
import { buildingGroundEntrances, expandedFoundationTiles, fitWorldFoundation, foundationBoxes, foundationRamp, withFoundationParts } from './worldFoundations.ts';
import type { BuildingRectangle } from './buildingFootprints.ts';
import { validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';

export interface WorldFoundationPolicy {
  height?: number; blend?: number; maxCutFill?: number;
  /** Cut into terrain, preserve the slope beneath a raised floor, or try the preferred feasible mode. */
  mode?: 'cut' | 'crawlspace' | 'auto'; prefer?: 'cut' | 'crawlspace';
  /** Free space below room slabs in crawlspace mode; metres, defaults .45 and 6. */
  clearance?: number; maxClearance?: number; retainingColor?: string;
  /** Optional finish for retaining supports and the entrance ramp. */
  material?: SurfaceMaterialInput;
}
export interface WorldRoomLevelsPolicy {
  /** Terrain-derived room offsets are multiples of step, bounded by maxRise/maxDrop. */
  step: number; maxRise: number; maxDrop?: number; rooms?: string[];
}
export interface WorldFoundationFit {
  mode: 'cut' | 'crawlspace'; requested: 'cut' | 'crawlspace' | 'auto';
  referenceHeight: number; terrainMin: number; terrainMax: number; groundY: number; excavationY: number;
  cut: number; fill: number; minClearance: number; maxClearance: number; sampleCount: number;
  roomLevels: Record<string, number>;
}

export type WorldSitePlacement = { kind: 'position'; x: number; z: number }
  | { kind: 'summit'; regionId: string; spacing?: number };
export interface WorldSiteOrientation {
  /** Face a point, another site's resolved centre, or the adjacent authored
   * waypoint/opposite endpoint of a road connected to this site. */
  face: TerrainPoint | { site: string } | { road: string };
  /** Radians relative to the facing direction, within ±2π. */
  offset?: number;
}
export interface WorldSite {
  id: string; placement: WorldSitePlacement; yaw?: number;
  /** Explicit site/building yaw wins. Otherwise rotate the primary ground-floor
   * entrance toward this target before testing the site's terrain footprint. */
  orientation?: WorldSiteOrientation;
  /** Site placement supplies the building origin/yaw; its floor plan is retained. */
  building?: BuildingRecipe;
  /** Required for an open site, such as a park or a custom gameplay area. */
  footprint?: TerrainFootprint;
  /** Height is the terrain pad elevation; the lowest building floor sits 2cm above it. */
  foundation?: WorldFoundationPolicy;
  /** Derive flat ground-floor room levels from pre-foundation terrain. Exterior
   * door and inter-storey stair rooms stay at0; transitions still need clearance. */
  roomLevels?: WorldRoomLevelsPolicy;
  entrance?: { roadId: string; portalId?: string; side?: BuildingSide; offset?: number };
}
export type WorldRoadEndpoint = { site: string } | (TerrainPoint & { y?: number });
export interface WorldRoad extends Omit<WorldRoadRequest, 'from' | 'to' | 'avoid'> { from: WorldRoadEndpoint; to: WorldRoadEndpoint }
export interface WorldProp {
  id: string; model: AssetManifest; position: TerrainPoint & { y?: number }; yaw?: number;
  /** Instance fallback; explicit materials on model parts take precedence. */
  material?: SurfaceMaterialInput;
  /** Position/yaw become local to this site's floor origin. Attached geometry
   * may overlap its own site, e.g. original towers, battlements or park equipment. */
  siteId?: string;
  /** Explicit building surface intent. Requires siteId, omits position.y, and
   * resolves against the entire rotated model footprint in building-local space. */
  attachment?: WorldBuildingAttachment;
}
export interface WorldPlanRecipe {
  version: 1; id: string; seed: number; terrain: TerrainRecipe;
  sites: WorldSite[]; roads: WorldRoad[]; props?: WorldProp[];
  budgets?: { sites?: number; roads?: number; props?: number; parts?: number; colliders?: number };
}
export interface WorldAccess { siteId: string; roadId: string; portalId?: string; width: number; points: PhysicsVector[]; kind?: 'ramp' }
export interface ResolvedWorldSite {
  id: string; position: PhysicsVector; groundY: number; floorY: number; yaw: number;
  footprint: TerrainFootprint; pad: TerrainFootprint; blend: number; buildingId?: string;
  bounds: { min: PhysicsVector; max: PhysicsVector }; access: WorldAccess[];
  foundation?: WorldFoundationFit;
  /** Actual building-local union used by advanced fitting and validation. */
  footprintTiles?: BuildingRectangle[];
}
export interface PlannedWorldProp extends Omit<WorldProp, 'position' | 'yaw'> {
  position: PhysicsVector; yaw: number; colliders: PhysicsCollider[]; bounds: { min: PhysicsVector; max: PhysicsVector };
  /** Ground-level instances require sampled support across their footprint;
   * explicitly elevated authored attachments are not grounded automatically. */
  grounded: boolean;
  /** Resolved building-local surface envelope; retained for inspection/reuse. */
  attachmentSupport?: NonNullable<BuildingAttachmentResult['support']>;
}
export interface WorldPlanIssue { severity: 'error' | 'warning'; code: string; message: string; ids: string[] }
export interface WorldPlanChanges { added: string[]; removed: string[]; updated: string[]; unchanged: number }
export interface WorldPlanManifest {
  version: 1; id: string; revision: string; recipe: WorldPlanRecipe; terrain: TerrainRecipe;
  buildings: BuildingManifest[]; sites: ResolvedWorldSite[]; props: PlannedWorldProp[]; roads: TerrainRoute[]; access: WorldAccess[];
  diagnostics: { valid: boolean; issues: WorldPlanIssue[]; validation: 'global-metadata-and-prepared-chunks'; counts: { sites: number; buildings: number; roads: number; props: number; parts: number; colliders: number } };
  /** Existing building-only changes, keyed by building/site ID. */
  changes: WorldPlanChanges;
  /** Additive resolved-entity changes, keyed by site:<id>, road:<id> and prop:<id>.
   * Roads include generated access links; geometry changes remain in changes. */
  entityChanges: WorldPlanChanges;
}
export const WORLD_PLAN_LIMITS = Object.freeze({ sites: 32, roads: 32, props: 128, parts: 16384, colliders: 8192, summitSamples: 4096 });
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// Normalize generated world coordinates before they become geometry inputs or
// revision-bearing terrain data. V8/QuickJS transcendental functions can differ
// by an ULP; 0.1 micrometre precision is far below native contact tolerances.
const resolvedPoint = <T extends TerrainPoint & { y?: number }>(point: T): T => ({ ...point, x: coordinate(point.x), z: coordinate(point.z),
  ...(point.y === undefined ? {} : { y: coordinate(point.y) }) });
const resolvedRoute = (route: TerrainRoute): TerrainRoute => ({ ...route, points: route.points.map(resolvedPoint) });
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const order = (a: { id: string } | null | undefined, b: { id: string } | null | undefined) => {
  const x = typeof a?.id === 'string' ? a.id : '', y = typeof b?.id === 'string' ? b.id : ''; return x < y ? -1 : x > y ? 1 : 0;
};
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(16); };
const localId = (s: string) => s.length <= 96 ? s : `${s.slice(0, 80)}:${hash(s)}`;
// Plain loops and the default code-unit key sort keep revisions identical
// while avoiding per-entry callbacks in the sandbox interpreter.
const canonical = (v: unknown, modelKeys = false): string => {
  if (modelKeys && v && typeof v === 'object' && modelCosts.has(v)) return `asset(${JSON.stringify((v as AssetManifest).key)})`;
  if (Array.isArray(v)) { let out = '['; for (let i = 0; i < v.length; i++) out += (i ? ',' : '') + canonical(v[i], modelKeys); return out + ']'; }
  if (v && typeof v === 'object') {
    const record = v as Record<string, unknown>, names = Object.keys(record).sort(); let out = '{', first = true;
    for (let i = 0; i < names.length; i++) { const x = record[names[i]]; if (x === undefined) continue; out += (first ? '' : ',') + JSON.stringify(names[i]) + ':' + canonical(x, modelKeys); first = false; }
    return out + '}';
  }
  return JSON.stringify(v) ?? 'null';
};
const modelCosts = new WeakMap<object, number>();
const compiledPlans = new WeakSet<WorldPlanManifest>();
// Build-time compiled plans, keyed by plan ID. The trusted game build evaluates
// each bundle once with a capture hook and embeds every defineWorldPlan result
// in that exact bundle (see precompileWorldPlans in host/build.ts). JSON keeps
// every value except the sign of zero, which no revision distinguishes.
type WorldPlanStore = Readonly<Record<string, string>>;
function worldPlanStore(): WorldPlanStore | undefined {
  const store = (globalThis as { __patchduelWorldPlans?: unknown }).__patchduelWorldPlans;
  return store && typeof store === 'object' ? store as WorldPlanStore : undefined;
}
function worldPlanCapture(): ((key: string, json: string) => void) | undefined {
  const capture = (globalThis as { __patchduelWorldPlanCapture?: unknown }).__patchduelWorldPlanCapture;
  return typeof capture === 'function' ? capture as (key: string, json: string) => void : undefined;
}
/** Declare a world plan once, at module level. The trusted game build runs
 * `build` and the compiler a single time and embeds the result in the bundle,
 * so a sandbox load returns that manifest without generating the recipe or
 * compiling in the interpreter (both used most of the 1 s load budget on a
 * 2 GHz release host). `build` must depend only on its own code, never on
 * tuning or match data. Without an embedded manifest (developer tools, views)
 * it compiles here as before. `id` must equal the recipe's ID. */
export function defineWorldPlan(id: string, build: () => WorldPlanRecipe): WorldPlanManifest {
  if (!validId(id)) throw new Error('World plan IDs need 1-96 letters, digits or _.:- characters.');
  const stored = worldPlanStore()?.[id];
  if (typeof stored === 'string') return freeze(JSON.parse(stored) as WorldPlanManifest);
  const plan = compileWorldPlan(build());
  if (plan.id !== id) throw new Error(`defineWorldPlan("${id}") built a recipe with ID "${plan.id}".`);
  worldPlanCapture()?.(id, JSON.stringify(plan));
  return plan;
}
const buildingInputs = new WeakMap<BuildingManifest, string>();
function entityKeys(plan: WorldPlanManifest): Map<string, string> {
  return new Map([
    ...plan.sites.map(site => [`site:${site.id}`, canonical(site)] as const),
    ...plan.roads.map(road => [`road:${road.id}`, canonical(road)] as const),
    ...plan.props.map(prop => [`prop:${prop.id}`, canonical({ id: prop.id, siteId: prop.siteId,
      model: prop.model.key, material: prop.material, position: prop.position, yaw: prop.yaw, grounded: prop.grounded,
      attachment: prop.attachment, attachmentSupport: prop.attachmentSupport })] as const),
  ].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function compareKeys(entries: Map<string, string>, previous: Map<string, string>): WorldPlanChanges {
  return { added: [...entries.keys()].filter(id => !previous.has(id)), removed: [...previous.keys()].filter(id => !entries.has(id)),
    updated: [...entries.keys()].filter(id => previous.has(id) && previous.get(id) !== entries.get(id)),
    unchanged: [...entries.keys()].filter(id => previous.get(id) === entries.get(id)).length };
}
function snapshot<T>(value: T, budget = { nodes: 350000 }, depth = 0, key = ''): T {
  if (--budget.nodes < 0 || depth > 22) throw new Error('World plan exceeds its plain-data budget.');
  if (value === undefined || value === null || typeof value === 'boolean' || finite(value)) return value;
  if (typeof value === 'string' && value.length <= 512) return value;
  if (key === 'model' && value && typeof value === 'object') {
    const model = validateAssetManifest(value as unknown as AssetManifest);
    let cost = modelCosts.get(model);
    if (cost === undefined) { const count = (v: unknown): number => 1 + (v && typeof v === 'object' ? Object.values(v).reduce<number>((n, x) => n + count(x), 0) : 0); cost = count(model); modelCosts.set(model, cost); }
    budget.nodes -= cost - 1; if (budget.nodes < 0) throw new Error('World plan exceeds its plain-data budget.');
    return model as T;
  }
  if (Array.isArray(value)) return Array.from(value).map(v => snapshot(v, budget, depth + 1)) as T;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v, budget, depth + 1, k)])) as T;
  throw new Error('World plan requires finite, acyclic plain data.');
}
function freeze<T>(v: T): T { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function footprintValid(f: TerrainFootprint | undefined): f is TerrainFootprint {
  return !!f && (f.kind === 'circle' ? finite(f.radius) && f.radius >= .1 && f.radius <= 128
    : f.kind === 'box' && [f.width, f.depth].every(n => finite(n) && n >= .2 && n <= 256));
}
const sideAngle = { south: 0, east: Math.PI / 2, north: Math.PI, west: -Math.PI / 2 };
/** Match road entry selection without compiling a second temporary building. */
function frontSide(site: WorldSite): BuildingSide | undefined {
  const building = site.building;
  if (!building) return site.entrance?.side ?? 'south';
  try { const doors = buildingGroundEntrances(building), selected = site.entrance?.portalId ?? building.primaryEntrance;
    return (selected === undefined ? doors[0] : doors.find(door => door.id === selected))?.side;
  } catch { return; }
}
function corners(f: TerrainFootprint): TerrainPoint[] {
  return f.kind === 'box' ? [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([x, z]) => ({ x: x * f.width / 2, z: z * f.depth / 2 }))
    : Array.from({ length: 8 }, (_, i) => ({ x: Math.cos(i * Math.PI / 4) * f.radius, z: Math.sin(i * Math.PI / 4) * f.radius }));
}
function insideFootprint(p: TerrainPoint, f: TerrainFootprint, origin: TerrainPoint, yaw: number, margin = 0): boolean {
  const c = Math.cos(yaw), s = Math.sin(yaw), dx = p.x - origin.x, dz = p.z - origin.z, x = dx * c - dz * s, z = dx * s + dz * c;
  return f.kind === 'circle' ? Math.hypot(x, z) <= f.radius - margin + 1e-7 : Math.abs(x) <= f.width / 2 - margin + 1e-7 && Math.abs(z) <= f.depth / 2 - margin + 1e-7;
}
function insideSite(p: TerrainPoint, site: ResolvedWorldSite, margin = 0): boolean {
  return site.footprintTiles ? site.footprintTiles.some(tile => insideFootprint(p, { kind: 'box', width: tile.width, depth: tile.depth }, transform(tile, site.position, site.yaw), site.yaw, margin))
    : insideFootprint(p, site.footprint, site.position, site.yaw, margin);
}
function bounds(f: TerrainFootprint, p: PhysicsVector, yaw: number, height: number) {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  const w = f.kind === 'circle' ? f.radius * 2 : c * f.width + s * f.depth, d = f.kind === 'circle' ? f.radius * 2 : s * f.width + c * f.depth;
  return { min: resolvedPoint({ x: p.x - w / 2, y: p.y, z: p.z - d / 2 }), max: resolvedPoint({ x: p.x + w / 2, y: p.y + height, z: p.z + d / 2 }) };
}
function overlaps(a: ResolvedWorldSite['bounds'], b: ResolvedWorldSite['bounds']): boolean {
  return a.min.x < b.max.x - 1e-6 && a.max.x > b.min.x + 1e-6 && a.min.z < b.max.z - 1e-6 && a.max.z > b.min.z + 1e-6 && a.min.y < b.max.y - 1e-6 && a.max.y > b.min.y + 1e-6;
}
/** Compile outside gameplay ticks. A rejected plan keeps diagnostics but cannot
 * create a host. Original buildings/families remain editable and independently reusable. */
export function compileWorldPlan(input: WorldPlanRecipe, previous?: WorldPlanManifest): WorldPlanManifest {
  const issues: WorldPlanIssue[] = [];
  const issue = (code: string, message: string, ids: string[] = [], severity: 'error' | 'warning' = 'error') => {
    if (issues.length < 128) issues.push({ code, message, ids: ids.filter(id => typeof id === 'string'), severity });
  };
  let recipe: WorldPlanRecipe = { version: 1, id: 'invalid', seed: 0, terrain: { version: 1, seed: 0, bounds: { width: 64, depth: 64 }, assets: [], regions: [] }, sites: [], roads: [] };
  try { const draft = snapshot(input); if (!draft || typeof draft !== 'object' || !draft.terrain || typeof draft.terrain !== 'object') throw new Error('World plan requires a terrain recipe.'); recipe = draft; }
  catch (error) { issue('input-data', error instanceof Error ? error.message : 'Invalid world data.'); }
  const terrain = snapshot(recipe.terrain), buildings: BuildingManifest[] = [], sites: ResolvedWorldSite[] = [], props: PlannedWorldProp[] = [], access: WorldAccess[] = [];
  const result: WorldPlanManifest = { version: 1, id: recipe.id, revision: '', recipe, terrain, buildings, sites, props, roads: [], access,
    diagnostics: { valid: false, issues, validation: 'global-metadata-and-prepared-chunks', counts: { sites: 0, buildings: 0, roads: 0, props: 0, parts: 0, colliders: 0 } },
    changes: { added: [], removed: [], updated: [], unchanged: 0 }, entityChanges: { added: [], removed: [], updated: [], unchanged: 0 } };
  const finish = () => {
    result.diagnostics.valid = !issues.some(i => i.severity === 'error');
    result.diagnostics.counts = { ...result.diagnostics.counts, sites: sites.length, buildings: buildings.length, roads: result.roads.length, props: props.length,
      parts: buildings.reduce((n, b) => n + b.diagnostics.counts.parts, 0) + props.reduce((n, p) => n + p.model.parts.length, 0),
      colliders: buildings.reduce((n, b) => n + b.colliders.length, 0) + props.reduce((n, p) => n + p.colliders.length, 0) };
    const entries = new Map(buildings.map(b => [b.id, b.revision])), old = new Map(previous?.buildings.map(b => [b.id, b.revision]));
    result.changes = compareKeys(entries, old);
    result.entityChanges = compareKeys(entityKeys(result), previous ? entityKeys(previous) : new Map());
    result.revision = `world-plan-v1-${hash(canonical({ id: recipe.id, seed: recipe.seed, terrain, buildings: [...entries],
      props: props.map(p => ({ id: p.id, model: p.model.key, material: p.material, position: p.position, yaw: p.yaw,
        attachment: p.attachment, attachmentSupport: p.attachmentSupport })), sites: sites.map(s => ({ id: s.id, position: s.position, yaw: s.yaw })), issues }))}`;
    freeze(result); compiledPlans.add(result); return result;
  };
  if (issues.length) return finish();
  const limits = { ...WORLD_PLAN_LIMITS, ...recipe.budgets };
  if (recipe.version !== 1 || !validId(recipe.id) || !Number.isInteger(recipe.seed) || recipe.seed < 0 || recipe.seed > 0xffffffff
    || !Array.isArray(recipe.sites) || !Array.isArray(recipe.roads) || recipe.props !== undefined && !Array.isArray(recipe.props)
    || Object.entries(recipe.budgets ?? {}).some(([key, value]) => !['sites', 'roads', 'props', 'parts', 'colliders'].includes(key) || !Number.isInteger(value) || value! < 0 || value! > WORLD_PLAN_LIMITS[key as keyof typeof WORLD_PLAN_LIMITS])) {
    issue('recipe', 'Plan identity, arrays or budgets are invalid.'); return finish();
  }
  if (recipe.sites.length > limits.sites || recipe.roads.length > limits.roads || (recipe.props?.length ?? 0) > limits.props) { issue('budget', 'World site/road/prop count exceeds its budget.'); return finish(); }
  try {
    const checked = prepareTerrainRecipe(terrain);
    for (const p of checked.diagnostics.issues) issue(`terrain:${p.code}`, p.message, p.ids, p.severity);
  } catch (error) { issue('terrain', error instanceof Error ? error.message : 'Invalid terrain recipe.'); }
  if (issues.some(i => i.severity === 'error')) return finish();
  // Match the shared host. Preserve automatic eager generation for small worlds;
  // do not accidentally turn the planner's defaults into an explicit request.
  const streaming = terrainUsesStreaming(terrain);
  if (streaming) terrain.streaming ??= { chunkSize: 32, cells: 32 };
  const config = terrain.streaming || {}, chunkSize = streaming ? config.chunkSize ?? 32 : Math.max(terrain.bounds.width, terrain.bounds.depth);
  const cells = streaming ? config.cells ?? 32 : terrain.bounds.cells ?? 32;
  const resolution = streaming ? chunkSize / cells : Math.max(terrain.bounds.width, terrain.bounds.depth) / cells;
  const padding = coordinate(Math.SQRT2 * resolution + .04), sampleBase = createTerrainBaseHeightSampler(terrain);
  const baseHeight = (x: number, z: number) => coordinate(sampleBase(x, z)), siteIds = new Set<string>();
  const siteSources = new Map<string, WorldSite>(), siteMap = new Map<string, ResolvedWorldSite>(), buildingMap = new Map<string, BuildingManifest>();
  // Reuse only this compiler's immutable snapshots. A serialized/edited prior
  // manifest may retain stale revision strings, so regenerate its geometry.
  const oldBuildings = new Map(previous && compiledPlans.has(previous) ? previous.buildings.map(b => [b.id, b]) : []);
  const sources = [...recipe.sites].sort(order);
  for (const source of sources) {
    if (!source || !validId(source.id) || siteIds.has(source.id) || !finite(source.yaw ?? source.building?.yaw ?? 0)
      || !source.placement || !['position', 'summit'].includes(source.placement.kind)) { issue('site', 'Sites need unique IDs and a valid placement/yaw.', [source?.id]); continue; }
    siteIds.add(source.id); siteSources.set(source.id, source);
  }
  if (issues.some(i => i.severity === 'error')) return finish();
  type SitePose = { position: TerrainPoint; yaw: number; footprint: TerrainFootprint; pad: TerrainFootprint };
  const poses = new Map<string, SitePose>(), resolving = new Set<string>(), failed = new Set<string>();
  // Fixed target positions are known independently of orientation. A summit
  // target is resolved once, recursively; cycles fail within the site budget.
  const targetPoint = (value: TerrainPoint | { site: string }, owner: string): TerrainPoint | undefined => {
    if ('site' in value) {
      const target = siteSources.get(value.site);
      if (!target) { issue('orientation-target', 'Orientation references an unknown site.', [owner, value.site]); return; }
      if (target.placement.kind === 'position') return finite(target.placement.x) && finite(target.placement.z)
        ? resolvedPoint({ x: target.placement.x, z: target.placement.z }) : undefined;
      return resolvePose(target.id)?.position;
    }
    return finite(value.x) && finite(value.z) && Math.abs(value.x) <= 10000 && Math.abs(value.z) <= 10000 ? resolvedPoint(value) : undefined;
  };
  const resolvePose = (id: string): SitePose | undefined => {
    const cached = poses.get(id); if (cached) return cached;
    if (failed.has(id)) return;
    if (resolving.has(id)) { issue('orientation-cycle', 'Summit orientation targets form a cycle; author a fixed target or explicit yaw.', [...resolving, id]); failed.add(id); return; }
    const source = siteSources.get(id)!; resolving.add(id);
    const reject = () => { resolving.delete(id); failed.add(id); return undefined; };
    const footprint: TerrainFootprint | undefined = source.building ? { kind: 'box', width: coordinate(source.building.width + (source.building.wallThickness ?? .18)), depth: coordinate(source.building.depth + (source.building.wallThickness ?? .18)) } : source.footprint;
    if (!footprintValid(footprint)) { issue('site-footprint', 'A site needs a valid building or explicit open footprint.', [source.id]); return reject(); }
    const pad: TerrainFootprint = footprint.kind === 'circle' ? { kind: 'circle', radius: coordinate(footprint.radius + padding) }
      : { kind: 'box', width: coordinate(footprint.width + padding * 2), depth: coordinate(footprint.depth + padding * 2) };
    const explicitYaw = source.yaw ?? source.building?.yaw;
    let target: TerrainPoint | undefined, front: BuildingSide | undefined;
    const policy = explicitYaw === undefined ? source.orientation : undefined;
    if (policy !== undefined) {
      const face = policy?.face;
      if (!policy || typeof policy !== 'object' || !face || typeof face !== 'object' || !finite(policy.offset ?? 0) || Math.abs(policy.offset ?? 0) > Math.PI * 2
        || ('site' in face ? !validId(face.site) || 'road' in face || 'x' in face || 'z' in face
          : 'road' in face ? !validId(face.road) || 'x' in face || 'z' in face : !finite(face.x) || !finite(face.z))) {
        issue('orientation', 'Orientation needs one finite target point/site/road and an offset within ±2π radians.', [id]); return reject();
      }
      let aim: TerrainPoint | { site: string } | undefined;
      if ('road' in face) {
        const roads = recipe.roads.filter(road => road?.id === face.road), road = roads[0];
        const from = road?.from && typeof road.from === 'object' && 'site' in road.from && road.from.site === id;
        const to = road?.to && typeof road.to === 'object' && 'site' in road.to && road.to.site === id;
        if (roads.length !== 1 || !from && !to) { issue('orientation-road', 'Orientation road must uniquely reference this site as an endpoint.', [id, face.road]); return reject(); }
        aim = from ? (Array.isArray(road.via) && road.via.length ? road.via[0] : road.to)
          : (Array.isArray(road.via) && road.via.length ? road.via.at(-1) : road.from);
      } else aim = face;
      if (!aim || typeof aim !== 'object' || !(target = targetPoint(aim, id))) {
        issue('orientation-target', 'Orientation target position could not be resolved.', [id]); return reject();
      }
      front = frontSide(source);
      if (!front || !Object.hasOwn(sideAngle, front)) { issue('orientation-entry', 'Orientation needs a ground-floor exterior entrance, or a valid open-site entrance side.', [id]); return reject(); }
    }
    const yawAt = (point: TerrainPoint): number | undefined => {
      if (!policy) return explicitYaw ?? 0;
      const dx = target!.x - point.x, dz = target!.z - point.z;
      if (dx * dx + dz * dz < 1e-14) return;
      const angle = Math.atan2(dx, dz) - sideAngle[front!] + (policy.offset ?? 0);
      return coordinate(((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI) || 0;
    };
    let yaw: number | undefined, position: TerrainPoint | undefined;
    const padCorners = corners(pad), padProbes = [{ x: 0, z: 0 }, ...padCorners,
      ...padCorners.map((p, i) => ({ x: (p.x + padCorners[(i + 1) % padCorners.length].x) / 2, z: (p.z + padCorners[(i + 1) % padCorners.length].z) / 2 }))];
    if (source.placement.kind === 'position') {
      if (finite(source.placement.x) && finite(source.placement.z)) {
        position = resolvedPoint({ x: source.placement.x, z: source.placement.z }); yaw = yawAt(position);
        if (yaw === undefined) { issue('orientation-target', 'Facing target must differ from the site position.', [id]); return reject(); }
      }
    } else {
      const regionId = source.placement.regionId, region = terrain.regions.find(r => r.id === regionId), spacing = source.placement.spacing ?? Math.max(1, resolution);
      if (!region || !finite(spacing) || spacing < .25 || spacing > 128) { issue('summit', 'Summit search needs a known region and .25–128m spacing.', [source.id]); return reject(); }
      const extent = region.mask.kind === 'circle' ? region.mask.radius : coordinate(Math.hypot(region.mask.width, region.mask.depth) / 2);
      const n = Math.ceil(extent * 2 / spacing); if ((n + 1) ** 2 > WORLD_PLAN_LIMITS.summitSamples) { issue('summit-budget', 'Summit search exceeds 4096 candidates; increase spacing.', [source.id]); return reject(); }
      let best = -Infinity, distance = Infinity;
      for (let ix = 0; ix <= n; ix++) for (let iz = 0; iz <= n; iz++) {
        const p = resolvedPoint({ x: region.mask.center.x - extent + ix * extent * 2 / n, z: region.mask.center.z - extent + iz * extent * 2 / n });
        const candidateYaw = yawAt(p);
        if (candidateYaw === undefined || !padCorners.every(corner => insideFootprint(transform(corner, p, candidateYaw), region.mask, region.mask.center, region.mask.yaw ?? 0))) continue;
        const h = baseHeight(p.x, p.z), d = coordinate(Math.hypot(p.x - region.mask.center.x, p.z - region.mask.center.z));
        if (h > best + 1e-9 || Math.abs(h - best) <= 1e-9 && d < distance - 1e-9) {
          const target = source.foundation?.height ?? h, cutFill = source.foundation?.maxCutFill ?? 4;
          if (source.building && (source.foundation?.mode || source.roomLevels)) {
            try { fitWorldFoundation(source.building, source.foundation ?? {}, source.roomLevels, p, candidateYaw, baseHeight, source.entrance?.portalId); } catch { continue; }
          } else if (!padProbes.every(probe => { const v = transform(probe, p, candidateYaw); return Math.abs(baseHeight(v.x, v.z) - target) <= cutFill + 1e-6; })) continue;
          position = p; yaw = candidateYaw; best = h; distance = d;
        }
      }
    }
    if (!position || yaw === undefined || !padCorners.every(p => { const v = transform(p, position!, yaw!); return Math.abs(v.x) <= terrain.bounds.width / 2 && Math.abs(v.z) <= terrain.bounds.depth / 2; })) {
      issue('site-position', 'Site pad does not fit its placement region or world bounds.', [source.id]); return reject();
    }
    const pose = { position, yaw, footprint, pad }; poses.set(id, pose); resolving.delete(id); return pose;
  };
  for (const source of sources) {
    const pose = resolvePose(source.id); if (!pose) continue;
    const { position, yaw, footprint, pad } = pose;
    let groundY = coordinate(source.foundation?.height ?? baseHeight(position.x, position.z));
    const blend = source.foundation?.blend ?? Math.max(3, resolution * 2);
    if (!finite(groundY) || Math.abs(groundY) > 9000 || !finite(blend) || blend < 0 || blend > 128 || !finite(source.foundation?.maxCutFill ?? 4) || (source.foundation?.maxCutFill ?? 4) < 0) {
      issue('foundation', 'Foundation height, blend and cut/fill limits must be finite and bounded.', [source.id]); continue;
    }
    let fitted: ReturnType<typeof fitWorldFoundation> | undefined;
    const advanced = !!(source.foundation?.mode !== undefined || source.roomLevels !== undefined || source.building?.footprint || Array.isArray(source.building?.floors)
      && source.building.floors.some(f => Array.isArray(f?.rooms) && f.rooms.some(r => r && (r.elevation ?? 0) < 0)));
    if (advanced) {
      if (!source.building) { issue('foundation', 'Terrain fitting modes and room levels require a building.', [source.id]); continue; }
      try { fitted = fitWorldFoundation(source.building, source.foundation ?? {}, source.roomLevels, position, yaw, baseHeight, source.entrance?.portalId); groundY = fitted.fit.groundY; }
      catch (error) { issue('foundation-fit', error instanceof Error ? error.message : 'Terrain fit failed.', [source.id]); continue; }
    }
    const floorY = coordinate(groundY + (source.building ? .02 : 0)), point = { ...position, y: groundY };
    const site: ResolvedWorldSite = { id: source.id, position: point, groundY, floorY, yaw, footprint, pad, blend, bounds: bounds(footprint, point, yaw, .02), access: [] };
    if (fitted) { site.foundation = fitted.fit; site.footprintTiles = fitted.footprint.tiles; }
    if (source.building) {
      const floorLevels = source.building.floors;
      const firstY = Array.isArray(floorLevels) && floorLevels.length && floorLevels.every(f => f && finite(f.y)) ? Math.min(...floorLevels.map(f => f.y)) : 0;
      const authored = { ...(fitted?.building ?? source.building), id: source.id, origin: { ...position, y: coordinate(floorY - firstY) }, yaw };
      // Trusted immutable model keys avoid walking compound geometry again.
      // Pose/floor changes remain part of the key and recompile only their owner.
      const prior = oldBuildings.get(source.id), inputKey = canonical(authored, true);
      let building = !fitted && prior && buildingInputs.get(prior) === inputKey ? prior : compileBuilding(authored);
      for (const p of building.diagnostics.issues) issue(`building:${p.code}`, p.message, [source.id, ...(p.ids ?? [])]);
      if (!building.diagnostics.valid) continue;
      if (fitted) {
        try { const supports = foundationBoxes(building, fitted.footprint, fitted.fit, baseHeight, source.foundation?.retainingColor);
          building = withFoundationParts(building, supports, hash(canonical({ fit: fitted.fit, supports, material: source.foundation?.material })), source.foundation?.material); }
        catch (error) { issue('foundation-geometry', error instanceof Error ? error.message : 'Foundation geometry failed.', [source.id]); continue; }
      } else buildingInputs.set(building, inputKey);
      buildings.push(building); buildingMap.set(source.id, building); site.buildingId = building.id; site.bounds = building.bounds;
    }
    sites.push(site); siteMap.set(site.id, site);
    terrain.assets.push({ id: localId(`site:${source.id}`), version: site.buildingId ? buildingMap.get(site.id)!.revision : `pad:${hash(canonical([pad, groundY]))}`, footprint: pad });
    (terrain.placements ??= []).push({ id: localId(`site:${source.id}`), asset: localId(`site:${source.id}`), position: point, yaw,
      ...(fitted ? { foundationGroup: localId(`site:${source.id}`) } : { foundation: { height: groundY, blend, maxCutFill: source.foundation?.maxCutFill ?? 4 } }), clearance: .2 });
    if (fitted?.fit.mode === 'cut') for (const [index, tile] of expandedFoundationTiles(fitted.footprint, padding + (source.building!.wallThickness ?? .18) / 2).entries()) {
      const id = localId(`site:${source.id}:foundation:${index}`), location = transform(tile, point, yaw);
      terrain.assets.push({ id, footprint: { kind: 'box', width: tile.width, depth: tile.depth } });
      terrain.placements.push({ id, asset: id, position: location, yaw, foundationGroup: localId(`site:${source.id}`),
        foundation: { height: fitted.fit.excavationY, blend, maxCutFill: source.foundation?.maxCutFill ?? 4 } });
    }
  }
  if (issues.some(i => i.severity === 'error')) return finish();

  const roadIds = new Set<string>();
  for (const road of [...recipe.roads].sort(order)) {
    if (!road || !validId(road.id) || roadIds.has(road.id)) { issue('road-id', 'Road IDs must be unique valid identifiers.', [road?.id]); continue; } roadIds.add(road.id);
    const endpoint = (value: WorldRoadEndpoint, toward: WorldRoadEndpoint | undefined): PhysicsVector | undefined => {
      if (!value || typeof value !== 'object') return;
      if (!('site' in value)) return finite(value.x) && finite(value.z) && (value.y === undefined || finite(value.y))
        ? resolvedPoint({ x: value.x, y: value.y ?? baseHeight(value.x, value.z), z: value.z }) : undefined;
      const site = siteMap.get(value.site), source = siteSources.get(value.site); if (!site || !source) return;
      const building = buildingMap.get(site.id);
      let start: PhysicsVector, normal: TerrainPoint, portalId: string | undefined, width = Math.min(road.width, 2);
      if (building) {
        const selectedPortal = source.entrance?.portalId ?? building.recipe.primaryEntrance;
        const portal = building.portals.filter(p => p.kind === 'door' && p.exterior && p.endpoints.some(e => e.roomId === null && Math.abs(e.position.y - site.floorY) < .05))
          .sort(order).find(p => selectedPortal === undefined || selectedPortal === p.id);
        if (!portal) { issue('entrance-door', 'Site road needs a ground-floor exterior doorway.', [site.id, road.id]); return; }
        const outside = portal.endpoints.find(e => e.roomId === null)!.position, dx = outside.x - portal.position.x, dz = outside.z - portal.position.z, length = Math.hypot(dx, dz);
        normal = { x: dx / length, z: dz / length }; start = resolvedPoint({ x: portal.position.x, y: site.groundY, z: portal.position.z }); portalId = portal.id; width = portal.width;
      } else {
        const target = toward && ('site' in toward ? siteMap.get(toward.site)?.position : toward);
        const dx = (target?.x ?? site.position.x) - site.position.x, dz = (target?.z ?? site.position.z + 1) - site.position.z;
        const tx = dx * Math.cos(site.yaw) - dz * Math.sin(site.yaw), tz = dx * Math.sin(site.yaw) + dz * Math.cos(site.yaw);
        const side = source.entrance?.side ?? (source.orientation ? 'south' : Math.abs(tx) > Math.abs(tz) ? tx < 0 ? 'west' : 'east' : tz < 0 ? 'north' : 'south'), offset = source.entrance?.offset ?? 0;
        if (!finite(offset) || !['north', 'south', 'east', 'west'].includes(side)) { issue('entrance', 'Open-site entrance side/offset is invalid.', [site.id]); return; }
        const localNormal = side === 'north' ? { x: 0, z: -1 } : side === 'south' ? { x: 0, z: 1 } : side === 'east' ? { x: 1, z: 0 } : { x: -1, z: 0 };
        normal = transform(localNormal, { x: 0, z: 0 }, site.yaw);
        const span = site.footprint.kind === 'circle' ? site.footprint.radius : localNormal.x ? site.footprint.depth / 2 : site.footprint.width / 2;
        if (Math.abs(offset) + width / 2 > span) { issue('entrance', 'Open-site entrance width/offset must fit its footprint.', [site.id]); return; }
        const edge = site.footprint.kind === 'circle' ? Math.sqrt(site.footprint.radius ** 2 - offset ** 2) : localNormal.x ? site.footprint.width / 2 : site.footprint.depth / 2;
        const localPoint = { x: localNormal.x * edge + (localNormal.x ? 0 : offset), z: localNormal.z * edge + (localNormal.z ? 0 : offset) };
        start = { ...transform(localPoint, site.position, site.yaw), y: site.groundY };
      }
      let reach = padding + (road.width / 2) + (road.clearance ?? 0) + .3;
      const raisedAccess = !!building && !!site.foundation && (site.foundation.mode === 'crawlspace' || site.foundation.excavationY < site.groundY - .001);
      let end = resolvedPoint({ x: start.x + normal.x * reach, y: site.groundY, z: start.z + normal.z * reach });
      if (raisedAccess) {
        start = { ...start, y: site.floorY };
        const approachHeight = site.foundation!.mode === 'cut' ? createTerrainHeightSampler(terrain, { resolution }) : baseHeight;
        const slope = Math.min(road.grade?.maxSlope ?? .35, Math.tan((building!.recipe.actor?.maxSlopeDegrees ?? 40) * Math.PI / 180) * .8);
        let found = false;
        for (let attempt = 0; attempt < 64; attempt++, reach += .5) {
          const x = coordinate(start.x + normal.x * reach), z = coordinate(start.z + normal.z * reach);
          const y = coordinate(approachHeight(x, z)), drop = start.y - y;
          if (drop < -.02 || Math.abs(drop) / reach > slope + 1e-7) continue;
          const count = Math.ceil(reach / .5);
          if (!Array.from({ length: count + 1 }, (_, i) => i / count).every(t => {
            const p = { x: start.x + (x - start.x) * t, z: start.z + (z - start.z) * t };
            return [-.5, -.25, 0, .25, .5].every(offset => approachHeight(p.x - normal.z * width * offset, p.z + normal.x * width * offset)
              <= start.y + (y - start.y) * t + .025);
          })) continue;
          end = { x, z, y }; found = true; break;
        }
        if (!found) { issue('access-ramp', 'No outward ramp within32m meets terrain clearance and the authored road slope.', [site.id, road.id]); return; }
      }
      const link = planWorldRoad(terrain, { id: localId(`access:${site.id}:${road.id}`), from: start, to: end, via: [], width,
        shoulder: Math.max(resolution, road.shoulder ?? 2), color: road.color, material: road.material, grade: raisedAccess
          ? { ...road.grade, maxCutFill: Math.max(road.grade?.maxCutFill ?? 4, source.foundation?.maxClearance ?? 6) } : road.grade,
        avoid: sites.filter(other => other.id !== site.id).map(other => ({ id: other.id, position: other.position, footprint: other.pad, yaw: other.yaw })) });
      for (const p of link.diagnostics.issues) issue(`access:${p.code}`, p.message, [site.id, road.id]);
      if (!link.route) return;
      const route = resolvedRoute(link.route); if (raisedAccess) delete route.grade;
      (terrain.routes ??= []).push({ ...route, allowPlacements: true });
      const item: WorldAccess = { siteId: site.id, roadId: road.id, ...(portalId ? { portalId } : {}), width, points: [start, end], ...(raisedAccess ? { kind: 'ramp' as const } : {}) };
      if (raisedAccess) {
        try {
          const groundFloor = building!.recipe.floors.reduce((lowest, floor) => floor.y < lowest.y ? floor : lowest);
          const ramp = foundationRamp(`${site.id}:foundation:access:${road.id}`, start, end, width, groundFloor.id, source.foundation?.retainingColor ?? '#807e73');
          let adapted = withFoundationParts(building!, [ramp], hash(canonical(item)), source.foundation?.material);
          const local = (p: PhysicsVector) => { const dx = p.x - site.position.x, dz = p.z - site.position.z, c = Math.cos(site.yaw), s = Math.sin(site.yaw); return { x: coordinate(dx * c - dz * s), z: coordinate(dx * s + dz * c) }; };
          const a = local(start), b = local(end), dx = b.x - a.x, dz = b.z - a.z, run2 = dx * dx + dz * dz;
          const surface: BuildingSurface = { id: ramp.id, kind: 'stair', floorId: ramp.floorId!, minX: Math.min(a.x, b.x) - (Math.abs(dz) > Math.abs(dx) ? width / 2 : 0),
            maxX: Math.max(a.x, b.x) + (Math.abs(dz) > Math.abs(dx) ? width / 2 : 0), minZ: Math.min(a.z, b.z) - (Math.abs(dx) > Math.abs(dz) ? width / 2 : 0),
            maxZ: Math.max(a.z, b.z) + (Math.abs(dx) > Math.abs(dz) ? width / 2 : 0), y: coordinate((start.y + end.y) / 2 - adapted.recipe.origin!.y),
            slopeX: coordinate((end.y - start.y) * dx / run2), slopeZ: coordinate((end.y - start.y) * dz / run2), centerX: (a.x + b.x) / 2, centerZ: (a.z + b.z) / 2 };
          adapted = { ...adapted, surfaces: [...adapted.surfaces, surface] };
          buildings[buildings.findIndex(b => b.id === site.id)] = adapted; buildingMap.set(site.id, adapted);
          terrain.assets.find(asset => asset.id === localId(`site:${site.id}`))!.version = adapted.revision;
        } catch (error) { issue('access-ramp', error instanceof Error ? error.message : 'Access geometry failed.', [site.id, road.id]); return; }
      }
      access.push(item); site.access.push(item);
      const placement = terrain.placements!.find(p => p.id === localId(`site:${site.id}`))!;
      (placement.entrances ??= []).push({ id: localId(`entrance:${road.id}`), points: [start, end], width, clearance: building?.recipe.actor?.radius ?? .3 });
      return end;
    };
    const from = endpoint(road.from, road.via?.[0] ?? road.to), to = endpoint(road.to, road.via?.at(-1) ?? road.from);
    if (!from || !to) { issue('road-endpoint', 'Road endpoints must name valid sites or finite points.', [road.id]); continue; }
    const via = Array.isArray(road.via) ? road.via.map(point => point && finite(point.x) && finite(point.z)
      ? resolvedPoint({ ...point, y: point.y ?? baseHeight(point.x, point.z) }) : point) : road.via;
    const planned = planWorldRoad(terrain, { ...road, ...(via === undefined ? {} : { via }), from, to,
      avoid: sites.map(site => ({ id: site.id, position: site.position, footprint: site.pad, yaw: site.yaw })) });
    for (const p of planned.diagnostics.issues) issue(`road:${p.code}`, p.message, [road.id]);
    if (planned.route) (terrain.routes ??= []).push(resolvedRoute(planned.route));
  }
  // Scatter-only prop reservations added below are not traversable roads.
  result.roads = [...terrain.routes ?? []];
  for (const site of sites) {
    const required = siteSources.get(site.id)!.entrance;
    if (required && !site.access.some(a => a.roadId === required.roadId)) issue('entrance-link', 'Site entrance must link to a road endpoint referencing the site.', [site.id, required.roadId]);
  }
  if (issues.some(i => i.severity === 'error')) return finish();
  // Advanced supports and access links depend on terrain as well as the recipe.
  // Only reuse after their complete, geometry-sensitive revision is established.
  for (let index = 0; index < buildings.length; index++) {
    const building = buildings[index], prior = oldBuildings.get(building.id);
    if (prior && prior.revision === building.revision && canonical(prior.recipe, true) === canonical(building.recipe, true)) {
      buildings[index] = prior; buildingMap.set(building.id, prior);
    }
  }

  try {
    const meta = prepareTerrainRecipe(terrain); for (const p of meta.diagnostics.issues) issue(`terrain:${p.code}`, p.message, p.ids, p.severity);
    if (issues.some(i => i.severity === 'error')) return finish();
    // Preparation is a pure function of the terrain, which is unchanged here.
    const finalHeight = createPreparedTerrainHeightSampler(meta, { resolution });
    let reserved = false;
    // Cheap authored-ground check. Actual triangle heights/normals are checked
    // by the host's prepare callback before any loaded chunk enters physics.
    for (const site of sites) {
      const f = site.footprint, w = f.kind === 'circle' ? f.radius * 2 : f.width, d = f.kind === 'circle' ? f.radius * 2 : f.depth;
      for (let ix = 0; ix <= 2; ix++) for (let iz = 0; iz <= 2; iz++) {
        const local = { x: (ix / 2 - .5) * w, z: (iz / 2 - .5) * d };
        const p = transform(local, site.position, site.yaw);
        if (!insideSite(p, site)) continue;
        const height = finalHeight(p.x, p.z), expected = site.foundation?.excavationY ?? site.groundY;
        const invalid = site.foundation?.mode === 'crawlspace' ? Math.abs(height - baseHeight(p.x, p.z)) > .012 : Math.abs(height - expected) > .012;
        if (invalid) { issue('pad-surface', 'Authored terrain conflicts with the selected foundation surface.', [site.id]); ix = 3; break; }
      }
    }
    const propIds = new Set<string>();
    for (const source of [...(recipe.props ?? [])].sort(order)) {
      if (!source || !validId(source.id) || propIds.has(source.id) || !source.position || ![source.position.x, source.position.z, source.yaw ?? 0].every(finite)
        || source.position.y !== undefined && !finite(source.position.y)) { issue('prop', 'Props need unique IDs and finite placements.', [source?.id]); continue; }
      propIds.add(source.id); const model = validateAssetManifest(source.model), site = source.siteId ? siteMap.get(source.siteId) : undefined;
      if (source.siteId && !site) { issue('prop-site', 'Attached prop references an unknown site.', [source.id, source.siteId]); continue; }
      let localPosition = source.position, attachmentY: number | undefined, attachmentSupport: PlannedWorldProp['attachmentSupport'];
      if (source.attachment !== undefined) {
        const building = site ? buildingMap.get(site.id) : undefined;
        if (!building) { issue('prop-attachment-site', 'Surface attachments require a siteId with a compiled building.', [source.id, ...(source.siteId ? [source.siteId] : [])]); continue; }
        if (source.position.y !== undefined) { issue('prop-attachment-y', 'Surface attachment owns the vertical position; omit position.y and use attachment.gap.', [source.id]); continue; }
        const resolved = resolveBuildingAttachment(building, model, { attachment: source.attachment,
          position: { x: source.position.x, z: source.position.z }, ...(source.yaw === undefined ? {} : { yaw: source.yaw }) });
        if (!resolved.diagnostics.valid || !resolved.position) {
          for (const problem of resolved.diagnostics.issues) issue(`prop-attachment:${problem.code}`, problem.message, [source.id, site!.id]);
          continue;
        }
        localPosition = resolved.position;
        attachmentY = (building.recipe.origin?.y ?? 0) + resolved.position.y;
        attachmentSupport = resolved.support;
      }
      const xz = site ? transform(localPosition, site.position, site.yaw) : localPosition;
      const ground = { height: finalHeight(xz.x, xz.z), inside: Math.abs(xz.x) <= terrain.bounds.width / 2 && Math.abs(xz.z) <= terrain.bounds.depth / 2 };
      const position = resolvedPoint({ x: xz.x, z: xz.z, y: attachmentY ?? (site ? site.floorY + (source.position.y ?? 0) : source.position.y ?? ground.height) });
      const yaw = (site?.yaw ?? 0) + (source.yaw ?? 0), shape: TerrainFootprint = { kind: 'box', width: model.size.x, depth: model.size.z }, box = bounds(shape, position, yaw, model.size.y);
      if (!ground.inside || position.y < ground.height - .02 || Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) > terrain.bounds.width / 2
        || Math.max(Math.abs(box.min.z), Math.abs(box.max.z)) > terrain.bounds.depth / 2 || Math.max(Math.abs(box.min.y), Math.abs(box.max.y)) > 10000) {
        issue('prop-bounds', 'Prop geometry must stay above ground and inside the world bounds.', [source.id]); continue;
      }
      if (sites.some(other => other.id !== site?.id && overlaps(box, other.bounds))) { issue('prop-site-overlap', 'Prop intersects a different site; attach it explicitly to its owner or move it.', [source.id]); continue; }
      if (site && source.attachment === undefined && position.y <= site.floorY + .05 && !corners(shape).every(p => insideFootprint(transform(p, position, yaw), site.pad, site.position, site.yaw))) {
        issue('prop-footprint', 'Ground-level attached props must stay inside their reserved site pad.', [source.id]); continue;
      }
      const prop: PlannedWorldProp = { ...source, model, position, yaw, bounds: box, colliders: transformAssetColliders(model, position, yaw),
        ...(source.material === undefined ? {} : { material: validateSurfaceMaterialInput(source.material) }),
        grounded: source.attachment === undefined && Math.abs(position.y - (site?.floorY ?? ground.height)) < .05,
        ...(attachmentSupport === undefined ? {} : { attachmentSupport }) };
      const headroom = Math.max(1.8, ...buildings.map(b => b.recipe.actor?.height ?? 1.8));
      const blocked = result.roads.find(road => road.points.some((point, i) => {
        if (!i) return false; const previous = road.points[i - 1];
        const a = { ...previous, y: previous.y ?? finalHeight(previous.x, previous.z) }, b = { ...point, y: point.y ?? finalHeight(point.x, point.z) };
        return prop.colliders.some(collider => colliderBlocksCorridor(collider, a, b, road.width / 2, headroom));
      }));
      if (blocked) { issue('prop-access', 'Prop compound collision blocks a reserved road or doorway approach.', [source.id, blocked.id]); continue; }
      props.push(prop);
      if (!site && Math.abs(position.y - ground.height) < .05) {
        // Clear scatter independently from traversal. Actual compound parts
        // above own collision, so open arches remain open to walkers.
        (terrain.reservations ??= []).push({ id: localId(`prop:${source.id}`),
          mask: { ...shape, center: { x: position.x, z: position.z }, yaw } });
        reserved = true;
      }
    }
    // Without a new reservation the terrain is unchanged: report the same diagnostics again.
    const checked = reserved ? prepareTerrainRecipe(terrain) : meta; for (const p of checked.diagnostics.issues) issue(`terrain:${p.code}`, p.message, p.ids, p.severity);
  } catch (error) { issue('sample-validation', error instanceof Error ? error.message : 'World sampled validation failed.'); }
  const parts = buildings.reduce((n, b) => n + b.diagnostics.counts.parts, 0) + props.reduce((n, p) => n + p.model.parts.length, 0);
  const colliders = buildings.reduce((n, b) => n + b.colliders.length, 0) + props.reduce((n, p) => n + p.colliders.length, 0);
  if (parts > limits.parts || colliders > limits.colliders) issue('geometry-budget', 'Expanded world geometry exceeds its parts/colliders budget.');
  return finish();
}

/** Shared terrain host installs each site's original native collision only for
 * loaded neighborhoods. Use the same accepted manifest in logic and rendering. */
export function createPlannedWorld<T>(plan: WorldPlanManifest, options: TerrainWorldOptions<T> = {}): TerrainWorldHost<T> {
  if (!plan.diagnostics.valid) throw new Error(`Invalid world plan: ${plan.diagnostics.issues.filter(i => i.severity === 'error').slice(0, 3).map(i => i.message).join(' ')}`);
  const checked = new WeakSet<TerrainManifest>();
  return createTerrainWorld<T>(() => plan.terrain, { ...options,
    initialInterests: options.initialInterests ?? (() => plan.access.length ? [plan.access[0].points.at(-1)!] : plan.sites.slice(0, 1).map(s => s.position)),
    colliders: (tuning, terrain) => {
      if (!checked.has(terrain)) { validatePreparedSurface(plan, terrain); checked.add(terrain); }
      const o = terrain.origin ?? { x: 0, z: 0 }, w = terrain.bounds.width / 2, d = terrain.bounds.depth / 2;
      return [...[...plan.buildings, ...plan.props].filter(item => item.bounds.min.x <= o.x + w && item.bounds.max.x >= o.x - w
        && item.bounds.min.z <= o.z + d && item.bounds.max.z >= o.z - d).flatMap(item => item.colliders), ...(options.colliders?.(tuning, terrain) ?? [])];
    } });
}
function validatePreparedSurface(plan: WorldPlanManifest, terrain: TerrainManifest): void {
  if (!terrain.diagnostics.valid) throw new Error(`World plan terrain chunk is invalid: ${terrain.diagnostics.issues.filter(i => i.severity === 'error').slice(0, 2).map(i => i.message).join(' ')}`);
  const origin = terrain.origin ?? { x: 0, z: 0 }, minX = origin.x - terrain.bounds.width / 2, maxX = origin.x + terrain.bounds.width / 2;
  const minZ = origin.z - terrain.bounds.depth / 2, maxZ = origin.z + terrain.bounds.depth / 2;
  const cellX = terrain.bounds.width / terrain.columns, cellZ = terrain.bounds.depth / terrain.rows, guard = Math.hypot(cellX, cellZ);
  for (const site of plan.sites) {
    const footprintBounds = bounds(site.pad, site.position, site.yaw, 0);
    if (footprintBounds.max.x < minX || footprintBounds.min.x > maxX || footprintBounds.max.z < minZ || footprintBounds.min.z > maxZ) continue;
    const source = plan.recipe.sites.find(source => source.id === site.id)!, building = plan.buildings.find(b => b.id === site.buildingId);
    const floor = building && [...building.recipe.floors].sort((a, b) => a.y - b.y)[0];
    // Every vertex whose triangle can touch the actual floor must be flat.
    // This is stronger than checking only the building centre/corners and also
    // catches other terrain contributions that intrude into a protected pad.
    for (let col = 0; col <= terrain.columns; col++) for (let row = 0; row <= terrain.rows; row++) {
      const p = { x: minX + col * cellX, z: minZ + row * cellZ };
      if (!insideSite(p, site, -guard)) continue;
      const height = terrain.heights[col * (terrain.rows + 1) + row];
      if (site.foundation?.mode === 'crawlspace') {
        const owners = floor!.rooms.filter(room => (room.footprint ?? [room]).some(tile => insideFootprint(p,
          { kind: 'box', width: tile.width, depth: tile.depth }, transform(tile, site.position, site.yaw), site.yaw)));
        const lowest = Math.min(0, ...(owners.length ? owners.map(room => room.elevation ?? 0) : Object.values(site.foundation.roomLevels)));
        const slabBottom = site.floorY + lowest - (building!.recipe.floorThickness ?? .16), clearance = slabBottom - height;
        const inside = insideSite(p, site);
        if (clearance < (inside ? source.foundation?.clearance ?? .45 : 0) - .02 || inside && clearance > (source.foundation?.maxClearance ?? 6) + .02)
          throw new Error(`World site ${site.id}: sampled terrain violates crawlspace slab clearance; adjust fit or resolution.`);
      } else if (Math.abs(height - (site.foundation?.excavationY ?? site.groundY)) > .012)
        throw new Error(`World site ${site.id}: sampled terrain penetrates or fails to support its floor pad; adjust foundations or terrain resolution.`);
    }
  }
  // The difference between a terrain triangle and the ramp plane is affine.
  // Clip each overlapping triangle to the full ramp rectangle: checking the
  // resulting vertices catches peaks between probes and across chunk edges.
  type RampVertex = { along: number; across: number; height: number };
  const clipRamp = (polygon: RampVertex[], axis: 'along' | 'across', boundary: number, sign: number): RampVertex[] => {
    const result: RampVertex[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const da = (a[axis] - boundary) * sign, db = (b[axis] - boundary) * sign;
      if (da >= 0) result.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        result.push({ along: a.along + (b.along - a.along) * t, across: a.across + (b.across - a.across) * t,
          height: a.height + (b.height - a.height) * t });
      }
    }
    return result;
  };
  let rampTriangles = 0;
  for (const access of plan.access) {
    if (access.kind !== 'ramp') continue;
    for (let i = 1; i < access.points.length; i++) {
      const a = access.points[i - 1], b = access.points[i], dx = b.x - a.x, dz = b.z - a.z, run = Math.hypot(dx, dz);
      if (run <= 0) throw new Error(`World access ${access.siteId}/${access.roadId}: physical ramp has no horizontal run.`);
      const ux = dx / run, uz = dz / run, half = access.width / 2;
      const lowX = Math.min(a.x, b.x) - Math.abs(uz) * half, highX = Math.max(a.x, b.x) + Math.abs(uz) * half;
      const lowZ = Math.min(a.z, b.z) - Math.abs(ux) * half, highZ = Math.max(a.z, b.z) + Math.abs(ux) * half;
      if (highX < minX || lowX > maxX || highZ < minZ || lowZ > maxZ) continue;
      const firstCol = Math.max(0, Math.floor((lowX - minX) / cellX)), lastCol = Math.min(terrain.columns - 1, Math.floor((highX - minX) / cellX));
      const firstRow = Math.max(0, Math.floor((lowZ - minZ) / cellZ)), lastRow = Math.min(terrain.rows - 1, Math.floor((highZ - minZ) / cellZ));
      rampTriangles += (lastCol - firstCol + 1) * (lastRow - firstRow + 1) * 2;
      if (rampTriangles > 131072) throw new Error('World access ramps exceed the prepared terrain triangle validation budget.');
      const vertex = (col: number, row: number): RampVertex => {
        const x = minX + col * cellX - a.x, z = minZ + row * cellZ - a.z;
        return { along: x * ux + z * uz, across: -x * uz + z * ux, height: Math.fround(terrain.heights[col * (terrain.rows + 1) + row]) };
      };
      for (let col = firstCol; col <= lastCol; col++) for (let row = firstRow; row <= lastRow; row++) {
        const va = vertex(col, row), vb = vertex(col + 1, row), vc = vertex(col, row + 1), vd = vertex(col + 1, row + 1);
        for (const triangle of [[va, vb, vc], [vb, vd, vc]]) {
          let polygon = clipRamp(triangle, 'along', 0, 1);
          polygon = clipRamp(polygon, 'along', run, -1);
          polygon = clipRamp(polygon, 'across', -half, 1);
          polygon = clipRamp(polygon, 'across', half, -1);
          if (polygon.some(p => p.height > a.y + (b.y - a.y) * p.along / run + .025))
            throw new Error(`World access ${access.siteId}/${access.roadId}: sampled terrain penetrates the physical access ramp width.`);
        }
      }
    }
  }
  for (const road of plan.roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1], b = road.points[i], dx = b.x - a.x, dz = b.z - a.z; let low = 0, high = 1;
    for (const [start, delta, min, max] of [[a.x, dx, minX, maxX], [a.z, dz, minZ, maxZ]]) {
      if (!delta) { if (start < min || start > max) high = -1; continue; }
      const t1 = (min - start) / delta, t2 = (max - start) / delta; low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2));
    }
    if (low > high) continue;
    const samples = Math.max(1, Math.ceil(Math.hypot(dx, dz) * (high - low) / Math.min(.5, cellX, cellZ)));
    if (samples > 2048) throw new Error(`World road ${road.id}: prepared route validation exceeds its sample budget.`);
    for (let j = 0; j <= samples; j++) {
      const t = low + (high - low) * j / samples, point = { x: a.x + dx * t, z: a.z + dz * t }, sample = sampleTerrain(terrain, point.x, point.z);
      if (!sample.inside || road.grade && Math.hypot(sample.normal.x, sample.normal.z) / sample.normal.y > (road.grade.maxSlope ?? .35) + 1e-5)
        throw new Error(`World road ${road.id}: actual sampled slope exceeds its authored limit.`);
      if (road.grade && a.y !== undefined && b.y !== undefined && Math.abs(sample.height - (a.y + (b.y - a.y) * t)) > .18)
        throw new Error(`World road ${road.id}: intersecting grading or coarse terrain displaced its planned height by more than 18cm.`);
    }
  }
  for (const prop of plan.props) {
    if (!prop.grounded || prop.bounds.max.x < minX || prop.bounds.min.x > maxX || prop.bounds.max.z < minZ || prop.bounds.min.z > maxZ) continue;
    const footprint: TerrainFootprint = { kind: 'box', width: prop.model.size.x, depth: prop.model.size.z };
    for (const local of [{ x: 0, z: 0 }, ...corners(footprint)]) {
      const point = transform(local, prop.position, prop.yaw);
      if (point.x < minX || point.x > maxX || point.z < minZ || point.z > maxZ) continue;
      if (Math.abs(sampleTerrain(terrain, point.x, point.z).height - prop.position.y) > .12)
        throw new Error(`World prop ${prop.id}: actual terrain does not support its upright footprint within 12cm; reserve a level site or author an explicit elevated placement.`);
    }
  }
}
export function worldPlanInspection(plan: WorldPlanManifest) {
  return { version: plan.version, id: plan.id, revision: plan.revision, valid: plan.diagnostics.valid, counts: plan.diagnostics.counts,
    issues: plan.diagnostics.issues.slice(0, 16), issueCount: plan.diagnostics.issues.length, changes: plan.changes, entityChanges: plan.entityChanges,
    sites: plan.sites.slice(0, 16).map(s => ({ id: s.id, position: s.position, groundY: s.groundY, floorY: s.floorY,
      ...(s.buildingId === undefined ? {} : { buildingId: s.buildingId }), ...(s.foundation ? { foundation: s.foundation } : {}), access: s.access.map(a => a.roadId) })),
    truncated: plan.sites.length > 16 || plan.diagnostics.issues.length > 16,
    validation: plan.diagnostics.validation,
    coverage: 'Compilation checks metadata and authored ground. Worker preparation checks actual loaded heightfields before physics. No general navigation mesh or exhaustive world traversal proof.' };
}
