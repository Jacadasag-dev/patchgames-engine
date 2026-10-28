/** Bounded orthogonal rectangle unions in building-local X/Z metres. */
export interface BuildingRectangle { x: number; z: number; width: number; depth: number }
export interface BuildingFootprintEdge { side: 'north' | 'south' | 'east' | 'west'; axis: 'x' | 'z'; at: number; min: number; max: number }
export interface BuildingFootprint { rectangles: BuildingRectangle[]; tiles: BuildingRectangle[]; edges: BuildingFootprintEdge[]; area: number; bounds: BuildingRectangle }
export interface BuildingFootprintResult { valid: boolean; issues: string[]; footprint?: BuildingFootprint }
const EPS = 1e-7;
const rect = (r: BuildingRectangle) => ({ minX: r.x - r.width / 2, maxX: r.x + r.width / 2, minZ: r.z - r.depth / 2, maxZ: r.z + r.depth / 2 });
const inside = (r: ReturnType<typeof rect>, p: { x: number; z: number }) => p.x >= r.minX - EPS && p.x <= r.maxX + EPS && p.z >= r.minZ - EPS && p.z <= r.maxZ + EPS;

/** Overlapping rectangles and shared edges are merged. Corner-only contact,
 * disconnected islands and enclosed holes are rejected, never filled silently.
 * If supplied, envelope must be the union's exact bounding rectangle. */
export function compileBuildingFootprint(input: readonly BuildingRectangle[], envelope?: BuildingRectangle): BuildingFootprintResult {
  const invalid = (message: string): BuildingFootprintResult => ({ valid: false, issues: [message] });
  if (!Array.isArray(input) || input.length < 1 || input.length > 16 || Array.from(input).some(r => !r
    || ![r.x, r.z, r.width, r.depth].every(Number.isFinite) || r.width < .04 || r.depth < .04 || r.width > 128 || r.depth > 128
    || Math.abs(r.x) > 10000 || Math.abs(r.z) > 10000)) return invalid('Footprints require 1–16 finite rectangles with dimensions .04–128m.');
  const rectangles = input.map(r => ({ x: r.x, z: r.z, width: r.width, depth: r.depth })), source = rectangles.map(rect);
  const xs = [...new Set(source.flatMap(r => [r.minX, r.maxX]))].sort((a, b) => a - b), zs = [...new Set(source.flatMap(r => [r.minZ, r.maxZ]))].sort((a, b) => a - b);
  const nx = xs.length - 1, nz = zs.length - 1, cells = new Uint8Array(nx * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) if (source.some(r => inside(r, { x: (xs[x] + xs[x + 1]) / 2, z: (zs[z] + zs[z + 1]) / 2 }))) cells[z * nx + x] = 1;
  const flood = (start: number, target: number, seen: Set<number>) => {
    const queue = [start]; seen.add(start);
    for (let i = 0; i < queue.length; i++) { const key = queue[i], x = key % nx, z = Math.floor(key / nx);
      for (const next of [x > 0 ? key - 1 : -1, x + 1 < nx ? key + 1 : -1, z > 0 ? key - nx : -1, z + 1 < nz ? key + nx : -1])
        if (next >= 0 && cells[next] === target && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  };
  const occupied = new Set<number>(); flood(cells.indexOf(1), 1, occupied);
  if (occupied.size !== cells.reduce((sum, value) => sum + value, 0)) return invalid('Footprint rectangles must connect through area or a shared edge; islands and corner-only contact are unsupported.');
  const outside = new Set<number>();
  for (let key = 0; key < cells.length; key++) if (!cells[key] && (key % nx === 0 || key % nx === nx - 1 || key < nx || key >= nx * (nz - 1)) && !outside.has(key)) flood(key, 0, outside);
  if (outside.size + occupied.size !== cells.length) return invalid('Enclosed footprint holes are unsupported; author connected rooms around an exterior notch instead.');
  const bounds = { x: (xs[0] + xs.at(-1)!) / 2, z: (zs[0] + zs.at(-1)!) / 2, width: xs.at(-1)! - xs[0], depth: zs.at(-1)! - zs[0] };
  if (envelope && ['x', 'z', 'width', 'depth'].some(key => !Number.isFinite(envelope[key as keyof BuildingRectangle]) || Math.abs(bounds[key as keyof BuildingRectangle] - envelope[key as keyof BuildingRectangle]) > EPS))
    return invalid('Footprint bounding rectangle must match its declared x/z/width/depth envelope.');
  const tiles: BuildingRectangle[] = [], active = new Map<string, BuildingRectangle>();
  for (let z = 0; z < nz; z++) {
    const next = new Map<string, BuildingRectangle>();
    for (let x = 0; x < nx; x++) {
      if (!cells[z * nx + x]) continue;
      const first = x; while (x + 1 < nx && cells[z * nx + x + 1]) x++;
      const key = `${first}:${x}`, old = active.get(key), minX = xs[first], maxX = xs[x + 1];
      const tile = old ?? { x: (minX + maxX) / 2, z: (zs[z] + zs[z + 1]) / 2, width: maxX - minX, depth: zs[z + 1] - zs[z] };
      if (old) { const low = old.z - old.depth / 2; old.depth = zs[z + 1] - low; old.z = (low + zs[z + 1]) / 2; }
      else tiles.push(tile);
      next.set(key, tile);
    }
    active.clear(); for (const [key, tile] of next) active.set(key, tile);
  }
  const segments: BuildingFootprintEdge[] = [];
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) if (cells[z * nx + x]) {
    if (!z || !cells[(z - 1) * nx + x]) segments.push({ side: 'north', axis: 'x', at: zs[z], min: xs[x], max: xs[x + 1] });
    if (z === nz - 1 || !cells[(z + 1) * nx + x]) segments.push({ side: 'south', axis: 'x', at: zs[z + 1], min: xs[x], max: xs[x + 1] });
    if (!x || !cells[z * nx + x - 1]) segments.push({ side: 'west', axis: 'z', at: xs[x], min: zs[z], max: zs[z + 1] });
    if (x === nx - 1 || !cells[z * nx + x + 1]) segments.push({ side: 'east', axis: 'z', at: xs[x + 1], min: zs[z], max: zs[z + 1] });
  }
  segments.sort((a, b) => a.side < b.side ? -1 : a.side > b.side ? 1 : a.at - b.at || a.min - b.min);
  const edges: BuildingFootprintEdge[] = [];
  for (const edge of segments) { const old = edges.at(-1); if (old && old.side === edge.side && old.at === edge.at && Math.abs(old.max - edge.min) < EPS) old.max = edge.max; else edges.push({ ...edge }); }
  return { valid: true, issues: [], footprint: { rectangles, tiles, edges, bounds, area: tiles.reduce((sum, tile) => sum + tile.width * tile.depth, 0) } };
}

export function footprintContainsRectangle(footprint: BuildingFootprint, rectangle: BuildingRectangle, margin = 0): boolean {
  const target = rect({ ...rectangle, width: rectangle.width + margin * 2, depth: rectangle.depth + margin * 2 });
  const area = (target.maxX - target.minX) * (target.maxZ - target.minZ);
  if (area <= 0) return false;
  const covered = footprint.tiles.reduce((sum, tile) => { const r = rect(tile); return sum
    + Math.max(0, Math.min(r.maxX, target.maxX) - Math.max(r.minX, target.minX)) * Math.max(0, Math.min(r.maxZ, target.maxZ) - Math.max(r.minZ, target.minZ)); }, 0);
  return Math.abs(covered - area) <= Math.max(EPS, area * 1e-9);
}
export function footprintContainsPoint(footprint: BuildingFootprint, point: { x: number; z: number }, margin = 0): boolean {
  return margin > 0 ? footprintContainsRectangle(footprint, { ...point, width: margin * 2, depth: margin * 2 }) : footprint.tiles.some(tile => inside(rect(tile), point));
}
export function footprintsOverlap(a: BuildingFootprint, b: BuildingFootprint): boolean {
  return a.tiles.some(x => b.tiles.some(y => { const r = rect(x), s = rect(y); return Math.min(r.maxX, s.maxX) - Math.max(r.minX, s.minX) > EPS && Math.min(r.maxZ, s.maxZ) - Math.max(r.minZ, s.minZ) > EPS; }));
}
