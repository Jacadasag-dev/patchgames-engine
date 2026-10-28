import type { BuildingFootprintEdge, BuildingRectangle } from './buildingFootprints.ts';

/** Compiler-owned slab sources. Group order resolves equal-distance ownership
 * outside the authored outline; the original occupied area never changes owner. */
export interface BuildingSlabGroup { tiles: readonly BuildingRectangle[] }
export interface ExpandedBuildingSlabs {
  groups: { tiles: BuildingRectangle[] }[];
  /** Only exposed edges of the complete union, including any remaining void. */
  edges: BuildingFootprintEdge[];
}

const EPS = 1e-9;
const snap = (value: number) => Math.round(value * 1e9) / 1e9 || 0;
const MAX_RECTANGLES = 1024, MAX_CELLS = 262144, MAX_VISITS = 16777216;
type Rectangle = { group: number; minX: number; maxX: number; minZ: number; maxZ: number };

/** Extend the physical slab union to the outer wall faces. Unlike authored
 * footprint validation, this internal operation permits holes created when a
 * narrow exterior notch closes, and dimensions beyond the authored envelope.
 * Rectangular inputs remain one box; compound and split-level inputs remain
 * disjoint boxes so the normal collision/fracture path can consume them. */
export function expandBuildingSlabs(groups: readonly BuildingSlabGroup[], margin: number): ExpandedBuildingSlabs {
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Slab envelope margin must be finite and nonnegative.');
  const result: ExpandedBuildingSlabs = { groups: groups.map(() => ({ tiles: [] })), edges: [] };
  const rectangles: Rectangle[] = [];
  for (const [group, source] of groups.entries()) for (const tile of source.tiles) {
    if (rectangles.length >= MAX_RECTANGLES) throw new Error(`Slab envelope exceeds the ${MAX_RECTANGLES}-rectangle budget.`);
    if (![tile.x, tile.z, tile.width, tile.depth].every(Number.isFinite) || tile.width <= EPS || tile.depth <= EPS)
      throw new Error('Slab envelope sources require finite rectangles with positive dimensions.');
    const rectangle = { group, minX: snap(tile.x - tile.width / 2), maxX: snap(tile.x + tile.width / 2),
      minZ: snap(tile.z - tile.depth / 2), maxZ: snap(tile.z + tile.depth / 2) };
    if (!(rectangle.maxX > rectangle.minX && rectangle.maxZ > rectangle.minZ))
      throw new Error('Slab envelope sources must retain positive dimensions at compiler precision.');
    rectangles.push(rectangle);
  }
  if (!rectangles.length) return result;
  const expanded = rectangles.map(r => ({ ...r, minX: snap(r.minX - margin), maxX: snap(r.maxX + margin),
    minZ: snap(r.minZ - margin), maxZ: snap(r.maxZ + margin) }));
  if (expanded.some(r => ![r.minX, r.maxX, r.minZ, r.maxZ].every(Number.isFinite)))
    throw new Error('Slab envelope dimensions must remain finite.');
  const all = [...rectangles, ...expanded];
  const xs = [...new Set(all.flatMap(r => [r.minX, r.maxX]))].sort((a, b) => a - b);
  const zs = [...new Set(all.flatMap(r => [r.minZ, r.maxZ]))].sort((a, b) => a - b);
  const nx = xs.length - 1, nz = zs.length - 1, count = nx * nz;
  if (count > MAX_CELLS) throw new Error(`Slab envelope exceeds the ${MAX_CELLS}-cell geometry budget.`);
  const xIndex = new Map(xs.map((value, index) => [value, index])), zIndex = new Map(zs.map((value, index) => [value, index]));
  const ranges = all.map(r => ({ x0: xIndex.get(r.minX)!, x1: xIndex.get(r.maxX)!, z0: zIndex.get(r.minZ)!, z1: zIndex.get(r.maxZ)! }));
  if (ranges.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.z1 - r.z0), 0) > MAX_VISITS)
    throw new Error(`Slab envelope exceeds the ${MAX_VISITS}-visit geometry budget.`);
  const originals = new Int32Array(count).fill(-1), owners = new Int32Array(count).fill(-1);
  const distances = new Float64Array(count).fill(Infinity);
  for (let index = 0; index < rectangles.length; index++) {
    const source = rectangles[index], range = ranges[index];
    for (let z = range.z0; z < range.z1; z++) for (let x = range.x0; x < range.x1; x++) {
      const key = z * nx + x;
      if (originals[key] >= 0 && originals[key] !== source.group) throw new Error('Slab envelope source groups must not overlap.');
      originals[key] = owners[key] = source.group;
    }
  }
  for (let index = 0; index < rectangles.length; index++) {
    const source = rectangles[index], range = ranges[index + rectangles.length];
    for (let z = range.z0; z < range.z1; z++) for (let x = range.x0; x < range.x1; x++) {
      const key = z * nx + x; if (originals[key] >= 0) continue;
      const px = (xs[x] + xs[x + 1]) / 2, pz = (zs[z] + zs[z + 1]) / 2;
      const dx = Math.max(source.minX - px, 0, px - source.maxX), dz = Math.max(source.minZ - pz, 0, pz - source.maxZ);
      const distance = dx * dx + dz * dz;
      if (distance < distances[key] - 1e-12 || Math.abs(distance - distances[key]) <= 1e-12 && source.group < owners[key]) {
        owners[key] = source.group; distances[key] = distance;
      }
    }
  }
  // A valid wide slab can otherwise receive a narrow collar solely because
  // runs were merged in one direction. Compare both exact partitions per
  // owner; changing the partition never changes occupied cells or ownership.
  const partition = (horizontal: boolean): BuildingRectangle[][] => {
    const output: BuildingRectangle[][] = groups.map(() => []);
    const columns = horizontal ? xs : zs, rows = horizontal ? zs : xs;
    const ownerAt = (column: number, row: number) => owners[horizontal ? row * nx + column : column * nx + row];
    let active = new Map<string, BuildingRectangle>();
    for (let row = 0; row + 1 < rows.length; row++) {
      const next = new Map<string, BuildingRectangle>();
      for (let column = 0; column + 1 < columns.length; column++) {
        const owner = ownerAt(column, row); if (owner < 0) continue;
        const first = column;
        while (column + 2 < columns.length && ownerAt(column + 1, row) === owner) column++;
        const key = `${owner}:${first}:${column}`, old = active.get(key);
        const u = snap((columns[first] + columns[column + 1]) / 2), v = snap((rows[row] + rows[row + 1]) / 2);
        const width = snap(columns[column + 1] - columns[first]), depth = snap(rows[row + 1] - rows[row]);
        const tile = old ?? (horizontal ? { x: u, z: v, width, depth } : { x: v, z: u, width: depth, depth: width });
        if (old) {
          const low = snap(horizontal ? old.z - old.depth / 2 : old.x - old.width / 2);
          const length = snap(rows[row + 1] - low), center = snap((low + rows[row + 1]) / 2);
          if (horizontal) { old.depth = length; old.z = center; }
          else { old.width = length; old.x = center; }
        } else output[owner].push(tile);
        next.set(key, tile);
      }
      active = next;
    }
    return output;
  };
  const horizontal = partition(true), vertical = partition(false);
  const thin = (tiles: BuildingRectangle[]) => tiles.filter(tile => Math.min(tile.width, tile.depth) < .04 - EPS).length;
  for (let group = 0; group < groups.length; group++) {
    const a = horizontal[group], b = vertical[group], thinA = thin(a), thinB = thin(b);
    result.groups[group].tiles = thinB < thinA || thinB === thinA && b.length < a.length ? b : a;
  }
  const tails = new Map<string, BuildingFootprintEdge>();
  const edge = (side: BuildingFootprintEdge['side'], axis: 'x' | 'z', at: number, min: number, max: number) => {
    const key = `${side}:${at}`, old = tails.get(key);
    if (old && Math.abs(old.max - min) <= EPS) old.max = max;
    else { const next = { side, axis, at, min, max }; tails.set(key, next); result.edges.push(next); }
  };
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) if (owners[z * nx + x] >= 0) {
    if (!z || owners[(z - 1) * nx + x] < 0) edge('north', 'x', zs[z], xs[x], xs[x + 1]);
    if (z === nz - 1 || owners[(z + 1) * nx + x] < 0) edge('south', 'x', zs[z + 1], xs[x], xs[x + 1]);
    if (!x || owners[z * nx + x - 1] < 0) edge('west', 'z', xs[x], zs[z], zs[z + 1]);
    if (x === nx - 1 || owners[z * nx + x + 1] < 0) edge('east', 'z', xs[x + 1], zs[z], zs[z + 1]);
  }
  result.edges.sort((a, b) => a.side < b.side ? -1 : a.side > b.side ? 1 : a.at - b.at || a.min - b.min);
  return result;
}
