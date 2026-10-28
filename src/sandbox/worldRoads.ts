/** Bounded deterministic road planning over the analytic terrain base. The
 * emitted route must still pass the final sampled terrain compiler: this does
 * not prove triangle-level traversal or generate NPC navigation. */
import { createTerrainBaseHeightSampler, type TerrainFootprint, type TerrainPoint, type TerrainRecipe, type TerrainRoute, type TerrainRoutePoint } from './terrain.ts';
import { validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';

export interface WorldRoadAvoid { id: string; position: TerrainPoint; footprint: TerrainFootprint; yaw?: number; clearance?: number }
export interface WorldRoadRequest {
  id: string; from: TerrainRoutePoint; to: TerrainRoutePoint;
  /** Present (including []) means an authored path: never silently rerouted. */
  via?: TerrainRoutePoint[];
  width: number; shoulder?: number; clearance?: number; color?: string;
  material?: SurfaceMaterialInput;
  grade?: { strength?: number; maxCutFill?: number; maxSlope?: number };
  search?: { spacing?: number; maxNodes?: number; padding?: number };
  avoid?: WorldRoadAvoid[];
}
export interface WorldRoadIssue { code: string; message: string; position?: TerrainPoint }
export interface WorldRoadResult {
  route?: TerrainRoute;
  diagnostics: { valid: boolean; issues: WorldRoadIssue[]; visited: number; nodes: number; length: number; maxSlope: number; maxCutFill: number; samples: number };
}
export const WORLD_ROAD_LIMITS = Object.freeze({ nodes: 16384, samples: 131072, avoids: 96, points: 64 });
type Point = { x: number; y: number; z: number };
type Edge = { ok: boolean; length: number; slope: number; cut: number; reason?: string };
/** g/f are integer distance units, so engine-specific hypot rounding cannot
 * decide otherwise tied search branches. Bounded worlds/nodes keep sums exact. */
type Node = { id: string; point: Point; g: number; f: number; previous?: string; closed?: boolean };
const DISTANCE_UNITS = 1e7;
const coordinate = (value: number) => { const rounded = Math.round(value * DISTANCE_UNITS) / DISTANCE_UNITS; return rounded === 0 ? 0 : rounded; };
const cost = (metres: number) => Math.round(metres * DISTANCE_UNITS);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const pointOkay = (p: TerrainRoutePoint | undefined) => !!p && finite(p.x) && finite(p.z) && (p.y === undefined || finite(p.y) && Math.abs(p.y) <= 10000);
const distance = (a: TerrainPoint, b: TerrainPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const nonnegative = (n: number | undefined) => n === undefined || finite(n) && n >= 0;
const pointKey = (p: Point) => `${p.x},${p.y},${p.z}`;
const compare = (a: Node, b: Node) => a.f - b.f || a.g - b.g || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function segmentDistance(p: TerrainPoint, a: TerrainPoint, b: TerrainPoint): number {
  const dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}
function blocked(a: TerrainPoint, b: TerrainPoint, obstacle: WorldRoadAvoid, margin: number): boolean {
  const extra = margin + (obstacle.clearance ?? 0), f = obstacle.footprint;
  if (f.kind === 'circle') return segmentDistance(obstacle.position, a, b) < f.radius + extra - 1e-7;
  const c = Math.cos(obstacle.yaw ?? 0), s = Math.sin(obstacle.yaw ?? 0);
  const local = (p: TerrainPoint) => ({ x: c * (p.x - obstacle.position.x) - s * (p.z - obstacle.position.z), z: s * (p.x - obstacle.position.x) + c * (p.z - obstacle.position.z) });
  const start = local(a), end = local(b); let enter = 0, leave = 1;
  for (const [axis, half] of [['x', f.width / 2 + extra], ['z', f.depth / 2 + extra]] as const) {
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < 1e-10) { if (Math.abs(start[axis]) >= half - 1e-7) return false; }
    else { const t0 = (-half - start[axis]) / delta, t1 = (half - start[axis]) / delta; enter = Math.max(enter, Math.min(t0, t1)); leave = Math.min(leave, Math.max(t0, t1)); }
    if (enter >= leave - 1e-9) return false;
  }
  return true;
}

/** Explicit x/z/y preserve author intent; inferred heights and generated grid
 * coordinates use 1e-7m precision, shared with world composition. Otherwise A*
 * finds the shortest feasible sampled-grid path in its bounded search window,
 * then removes only shortcuts that pass the same full-width checks. */
export function planWorldRoad(terrain: TerrainRecipe, request: WorldRoadRequest): WorldRoadResult {
  const diagnostics: WorldRoadResult['diagnostics'] = { valid: false, issues: [], visited: 0, nodes: 0, length: 0, maxSlope: 0, maxCutFill: 0, samples: 0 };
  const fail = (code: string, message: string, position?: TerrainPoint): WorldRoadResult => { diagnostics.issues.push({ code, message, ...(position ? { position } : {}) }); return { diagnostics }; };
  if (!request || typeof request !== 'object' || !terrain || typeof terrain !== 'object') return fail('input', 'Road planning requires a terrain recipe and road request.');
  let material: SurfaceMaterialInput | undefined;
  try { if (request.material !== undefined) material = validateSurfaceMaterialInput(request.material); }
  catch (error) { return fail('material', error instanceof Error ? error.message : 'Invalid road material.'); }
  const spacing = request.search?.spacing ?? 4, maxNodes = request.search?.maxNodes ?? 4096;
  const maxSlope = request.grade?.maxSlope ?? .35, maxCutFill = request.grade?.maxCutFill ?? 4;
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(request.id)
    || !pointOkay(request.from) || !pointOkay(request.to) || !finite(request.width) || request.width <= 0 || request.width > 128
    || !nonnegative(request.shoulder) || !nonnegative(request.clearance) || !finite(maxSlope) || maxSlope < 0 || maxSlope > 2
    || !finite(maxCutFill) || maxCutFill < 0 || maxCutFill > 10000 || (request.grade?.strength ?? 1) !== 1
    || !finite(spacing) || spacing < .5 || spacing > 64 || !Number.isInteger(maxNodes) || maxNodes < 4 || maxNodes > WORLD_ROAD_LIMITS.nodes
    || !nonnegative(request.search?.padding) || (request.search?.padding ?? 0) > 2000
    || request.via !== undefined && (!Array.isArray(request.via) || request.via.length > 62 || Array.from(request.via).some(p => !pointOkay(p)))
    || request.avoid !== undefined && (!Array.isArray(request.avoid) || request.avoid.length > WORLD_ROAD_LIMITS.avoids)
    || !finite(terrain.bounds?.width) || !finite(terrain.bounds?.depth) || terrain.bounds.width <= 0 || terrain.bounds.depth <= 0
    || terrain.bounds.width > 20000 || terrain.bounds.depth > 20000) return fail('input', 'Road requires bounded finite endpoints, dimensions and search settings; exact grading uses strength1.');
  const avoids = Array.from(request.avoid ?? []);
  if (avoids.some(a => !a || typeof a.id !== 'string' || !pointOkay(a.position) || !finite(a.yaw ?? 0) || !nonnegative(a.clearance) || !a.footprint
    || (a.footprint.kind === 'circle' ? !finite(a.footprint.radius) || a.footprint.radius <= 0 : a.footprint.kind !== 'box' || !finite(a.footprint.width) || !finite(a.footprint.depth) || a.footprint.width <= 0 || a.footprint.depth <= 0))) return fail('avoid', 'Road avoidance needs finite circle or oriented-box footprints.');
  let base: (x: number, z: number) => number;
  try { base = createTerrainBaseHeightSampler(terrain); } catch (error) { return fail('terrain', error instanceof Error ? error.message : 'Invalid terrain.'); }
  const heightCache = new Map<string, number>();
  const height = (x: number, z: number) => {
    const key = `${x},${z}`, old = heightCache.get(key); if (old !== undefined) return old;
    const value = base(x, z); if (heightCache.size < WORLD_ROAD_LIMITS.samples) heightCache.set(key, value); return value;
  };
  const resolve = (p: TerrainRoutePoint): Point => ({ x: p.x, z: p.z, y: p.y ?? coordinate(height(p.x, p.z)) });
  const margin = request.width / 2 + (request.clearance ?? 0), inBounds = (p: TerrainPoint) => Math.abs(p.x) + margin <= terrain.bounds.width / 2 + 1e-7 && Math.abs(p.z) + margin <= terrain.bounds.depth / 2 + 1e-7;
  const edges = new Map<string, Edge>(), stepSize = Math.min(2, spacing / 2, Math.max(.25, request.width / 2));
  let exhausted = false;
  const edge = (a: Point, b: Point): Edge => {
    const ak = pointKey(a), bk = pointKey(b), key = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`, cached = edges.get(key); if (cached) return cached;
    const length = distance(a, b), slope = length ? Math.abs(b.y - a.y) / length : Infinity;
    const result: Edge = { ok: false, length, slope, cut: 0 };
    if (length < 1e-7) result.reason = 'Consecutive road points must be distinct.';
    else if (!inBounds(a) || !inBounds(b)) result.reason = 'Road width or clearance leaves terrain bounds.';
    else if (slope > maxSlope + 1e-7) result.reason = 'Road exceeds its maximum rise/run slope.';
    else if (avoids.some(o => blocked(a, b, o, margin))) result.reason = 'Road crosses a reserved site footprint.';
    else {
      const steps = Math.max(1, Math.ceil(length / stepSize)), nx = -(b.z - a.z) / length, nz = (b.x - a.x) / length;
      if (diagnostics.samples + (steps + 1) * 3 > WORLD_ROAD_LIMITS.samples) { exhausted = true; result.reason = 'Road surface sampling budget exhausted.'; }
      else {
        result.ok = true;
        for (let i = 0; i <= steps; i++) for (const offset of [-request.width / 2, 0, request.width / 2]) {
          diagnostics.samples++; const t = i / steps, x = a.x + (b.x - a.x) * t + nx * offset, z = a.z + (b.z - a.z) * t + nz * offset;
          result.cut = Math.max(result.cut, Math.abs(a.y + (b.y - a.y) * t - height(x, z)));
        }
        if (result.cut > maxCutFill + 1e-7) { result.ok = false; result.reason = 'Road exceeds its full-width cut/fill budget.'; }
      }
    }
    if (edges.size < WORLD_ROAD_LIMITS.nodes * 8) edges.set(key, result); return result;
  };
  let points: Point[];
  try {
    const from = resolve(request.from), to = resolve(request.to);
    if (request.via !== undefined) points = [from, ...request.via.map(resolve), to];
    else if (edge(from, to).ok) points = [from, to];
    else {
      const padding = request.search?.padding ?? Math.max(32, Math.min(256, distance(from, to) * .35));
      const minX = Math.ceil(Math.max(-terrain.bounds.width / 2 + margin, Math.min(from.x, to.x) - padding) / spacing), maxX = Math.floor(Math.min(terrain.bounds.width / 2 - margin, Math.max(from.x, to.x) + padding) / spacing);
      const minZ = Math.ceil(Math.max(-terrain.bounds.depth / 2 + margin, Math.min(from.z, to.z) - padding) / spacing), maxZ = Math.floor(Math.min(terrain.bounds.depth / 2 - margin, Math.max(from.z, to.z) + padding) / spacing);
      const nodes = new Map<string, Node>(), heap: Node[] = [];
      const push = (node: Node) => { heap.push(node); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (compare(heap[p], node) <= 0) break; heap[i] = heap[p]; i = p; } heap[i] = node; };
      const pop = (): Node => { const top = heap[0], last = heap.pop()!; if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && compare(heap[c + 1], heap[c]) < 0) c++; if (compare(last, heap[c]) <= 0) break; heap[i] = heap[c]; i = c; } heap[i] = last; } return top; };
      const start: Node = { id: 'start', point: from, g: 0, f: cost(distance(from, to)) }; nodes.set(start.id, start); push(start);
      let goal: Node | undefined;
      while (heap.length && !exhausted) {
        const current = pop(); if (nodes.get(current.id) !== current || current.closed) continue;
        current.closed = true; diagnostics.visited++;
        if (current.id === 'goal') { goal = current; break; }
        const offer = (id: string, point: Point) => {
          const old = nodes.get(id); if (old?.closed) return;
          const connection = edge(current.point, point); if (!connection.ok) return;
          const g = current.g + cost(connection.length); if (old && g >= old.g) return;
          if (!old && nodes.size >= maxNodes) { exhausted = true; return; }
          const node = { id, point, g, f: g + cost(distance(point, to)), previous: current.id }; nodes.set(id, node); push(node);
        };
        if (distance(current.point, to) <= spacing * 1.6) offer('goal', to);
        const cx = Math.round(current.point.x / spacing), cz = Math.round(current.point.z / spacing);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz && current.id !== 'start') continue;
          const ix = cx + dx, iz = cz + dz; if (ix < minX || ix > maxX || iz < minZ || iz > maxZ) continue;
          offer(`${ix}:${iz}`, resolve({ x: coordinate(ix * spacing), z: coordinate(iz * spacing) }));
        }
      }
      diagnostics.nodes = nodes.size;
      if (!goal) return fail(exhausted ? 'search-budget' : 'no-path', exhausted ? 'Road search exhausted its node or sampling budget; revise spacing/window or author waypoints.' : 'No feasible road in the search window; revise slope/cut-fill limits or author waypoints.');
      const reverse: Point[] = []; let current: Node | undefined = goal;
      while (current) { reverse.push(current.point); current = current.previous ? nodes.get(current.previous) : undefined; }
      const full = reverse.reverse(); points = [full[0]];
      for (let at = 0; at < full.length - 1;) {
        let next = at + 1;
        // Bounded local smoothing preserves slopes and avoids. Farther authored
        // curves remain possible without unbounded quadratic shortcut work.
        for (let candidate = Math.min(full.length - 1, at + 16); candidate > at + 1; candidate--) if (edge(full[at], full[candidate]).ok) { next = candidate; break; }
        points.push(full[next]); at = next;
      }
    }
    if (points.length > WORLD_ROAD_LIMITS.points) return fail('point-budget', 'Road needs more than64 control points; increase spacing or author shorter connected roads.');
    for (let i = 1; i < points.length; i++) {
      const checked = edge(points[i - 1], points[i]);
      if (!checked.ok) return fail(exhausted ? 'sample-budget' : 'route-constraint', checked.reason ?? 'Invalid road segment.', points[i]);
      diagnostics.length += checked.length; diagnostics.maxSlope = Math.max(diagnostics.maxSlope, checked.slope); diagnostics.maxCutFill = Math.max(diagnostics.maxCutFill, checked.cut);
    }
  } catch (error) { return fail('terrain', error instanceof Error ? error.message : 'Terrain sampling failed.'); }
  diagnostics.valid = true;
  return { route: { id: request.id, points, width: request.width, ...(request.shoulder === undefined ? {} : { shoulder: request.shoulder }),
    ...(request.clearance === undefined ? {} : { clearance: request.clearance }), ...(request.color === undefined ? {} : { color: request.color }),
    ...(material === undefined ? {} : { material }),
    grade: { strength: 1, maxSlope, maxCutFill } }, diagnostics };
}
