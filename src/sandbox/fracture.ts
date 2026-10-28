/** Bounded, deterministic preparation of a solid slab into seamless convex cells.
 * Preparation is immutable authoring data. Damage and physics poses belong to
 * destruction.ts; no random state or native geometry is retained here. */
import type { PhysicsCollider, PhysicsRotation, PhysicsVector } from './physics.ts';
import type { StructuralBond, StructuralMember } from './destruction.ts';

export interface FractureSlabRecipe {
  id: string;
  seed: number | string;
  position: PhysicsVector;
  size: PhysicsVector;
  rotation?: PhysicsRotation;
  /** 2..48 cells, generated in the two broad dimensions of the slab. */
  cells: number;
  density?: number;
  strength?: number;
  durability?: number;
}
export interface FracturePoint { u: number; v: number }
export interface FractureGeometry {
  /** Unindexed triangles, local to cell centroid and before source rotation. */
  positions: number[];
  normals: number[];
  uvs: number[];
  groups: { start: number; count: number; materialIndex: 0 | 1 }[];
}
export interface FractureCell {
  id: string;
  index: number;
  position: PhysicsVector;
  volume: number;
  mass: number;
  strength: number;
  durability: number;
  /** World pose with convex vertices local to the centroid. */
  collider: PhysicsCollider;
  /** Counterclockwise source-local coordinates on slab.axes[0], slab.axes[1]. */
  polygon: FracturePoint[];
  geometry: FractureGeometry;
}
export interface FractureAdjacency {
  id: string;
  from: string;
  to: string;
  area: number;
  position: PhysicsVector;
  /** World normal pointing from the first cell toward its neighbor. */
  normal: PhysicsVector;
}
export interface FractureSlab {
  id: string;
  seed: number | string;
  position: PhysicsVector;
  size: PhysicsVector;
  rotation: PhysicsRotation;
  thinAxis: 'x' | 'y' | 'z';
  axes: ['x' | 'y' | 'z', 'x' | 'y' | 'z'];
  volume: number;
  cells: FractureCell[];
  adjacency: FractureAdjacency[];
}

/** Prepared cells start unanchored. Connect boundary cells to real support
 * members in the same structure; anchoring every cell prevents collapse. */
export function fractureMembers(slab: FractureSlab, options: { maxSupportDistance?: number } = {}): StructuralMember[] {
  return slab.cells.map(cell => ({ id: cell.id, mass: cell.mass, strength: cell.strength, durability: cell.durability,
    position: { ...cell.position }, colliders: [cell.collider],
    ...(options.maxSupportDistance === undefined ? {} : { maxSupportDistance: options.maxSupportDistance }) }));
}

/** One undirected cohesive bond for each shared fracture face. Capacity is
 * newtons per connection; authors can use adjacency.area to refine materials. */
export function fractureBonds(slab: FractureSlab, options: { capacity: number; durability?: number }): StructuralBond[] {
  finite(options.capacity, 'bond capacity', .001, 1e12);
  if (options.durability !== undefined) finite(options.durability, 'bond durability', .001, 1e12);
  return slab.adjacency.map(join => ({ id: join.id, from: join.from, to: join.to, kind: 'cohesive', capacity: options.capacity,
    ...(options.durability === undefined ? {} : { durability: options.durability }) }));
}

function finite(value: number, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Fracture ${name} must be finite in ${min}..${max}.`);
  return value;
}
function vector(value: PhysicsVector, name: string, min: number, max: number): PhysicsVector {
  if (!value || typeof value !== 'object') throw new Error(`Fracture ${name} must be a vector.`);
  return { x: finite(value.x, name, min, max), y: finite(value.y, name, min, max), z: finite(value.z, name, min, max) };
}
function freeze<T>(value: T): T {
  // V8 and QuickJS can differ in the last bits of hypot. Geometry is an
  // immutable, replicated recipe: canonicalize those insignificant bits before
  // hashing or serializing. Significant digits also preserve very small slabs.
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'number' && key !== 'seed') {
        const rounded = Number(child.toPrecision(12));
        (value as Record<string, unknown>)[key] = rounded === 0 ? 0 : rounded;
      } else freeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
function random(seed: number | string): () => number {
  let state = 2166136261;
  const input = `${typeof seed}:${seed}`;
  for (let i = 0; i < input.length; i++) state = Math.imul(state ^ input.charCodeAt(i), 16777619);
  return () => { state = (state + 0x6d2b79f5) | 0; let n = Math.imul(state ^ state >>> 15, 1 | state); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
function rotate(p: PhysicsVector, q: PhysicsRotation): PhysicsVector {
  const tx = 2 * (q.y * p.z - q.z * p.y), ty = 2 * (q.z * p.x - q.x * p.z), tz = 2 * (q.x * p.y - q.y * p.x);
  return { x: p.x + q.w * tx + q.y * tz - q.z * ty, y: p.y + q.w * ty + q.z * tx - q.x * tz, z: p.z + q.w * tz + q.x * ty - q.y * tx };
}
function clip(polygon: FracturePoint[], nx: number, ny: number, distance: number): FracturePoint[] {
  const result: FracturePoint[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = a.u * nx + a.v * ny - distance, db = b.u * nx + b.v * ny - distance;
    if (da <= 0) result.push(a);
    if ((da <= 0) !== (db <= 0)) { const t = da / (da - db); result.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t }); }
  }
  return result;
}
function centroid(polygon: FracturePoint[]): { center: FracturePoint; area: number } {
  let twiceArea = 0, u = 0, v = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], cross = a.u * b.v - b.u * a.v;
    twiceArea += cross; u += (a.u + b.u) * cross; v += (a.v + b.v) * cross;
  }
  if (twiceArea <= 1e-12) throw new Error('Fracture generated a degenerate cell.');
  return { center: { u: u / (3 * twiceArea), v: v / (3 * twiceArea) }, area: twiceArea / 2 };
}

/** The thinnest dimension is extruded. Its faces retain continuous source UVs;
 * fresh interior faces use material 1, all original box faces use material 0.
 * This prepares box/slab solids, not arbitrary imported watertight meshes. */
export function compileFractureSlab(recipe: FractureSlabRecipe): FractureSlab {
  if (!recipe || typeof recipe.id !== 'string' || !recipe.id || recipe.id.length > 96) throw new Error('Fracture id must contain 1..96 characters.');
  if ((typeof recipe.seed !== 'number' || !Number.isFinite(recipe.seed)) && (typeof recipe.seed !== 'string' || recipe.seed.length > 256)) throw new Error('Fracture seed must be a finite number or short string.');
  const count = finite(recipe.cells, 'cells', 2, 48); if (!Number.isInteger(count)) throw new Error('Fracture cells must be an integer.');
  const position = vector(recipe.position, 'position', -1e6, 1e6), size = vector(recipe.size, 'size', .001, 1000);
  const density = finite(recipe.density ?? 650, 'density', .001, 1e6), strength = finite(recipe.strength ?? 120000, 'strength', .001, 1e12), durability = finite(recipe.durability ?? 100, 'durability', .001, 1e12);
  const r = recipe.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  const rotation = { ...vector(r, 'rotation', -1, 1), w: finite(r.w, 'rotation', -1, 1) };
  if (Math.abs(Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) - 1) > 1e-6) throw new Error('Fracture rotation must be normalized.');
  const allAxes = ['x', 'y', 'z'] as const;
  let thin = 0; for (let i = 1; i < 3; i++) if (size[allAxes[i]] < size[allAxes[thin]]) thin = i;
  const thinAxis = allAxes[thin], axes: FractureSlab['axes'] = [allAxes[(thin + 1) % 3], allAxes[(thin + 2) % 3]];
  const width = size[axes[0]], height = size[axes[1]], thickness = size[thinAxis];
  const local = (u: number, v: number, w: number): PhysicsVector => { const p = { x: 0, y: 0, z: 0 }; p[axes[0]] = u; p[axes[1]] = v; p[thinAxis] = w; return p; };
  const world = (u: number, v: number, w: number): PhysicsVector => { const p = rotate(local(u, v, w), rotation); return { x: p.x + position.x, y: p.y + position.y, z: p.z + position.z }; };
  const rng = random(recipe.seed), columns = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * width / height)))), rows = Math.ceil(count / columns);
  const sites: FracturePoint[] = [];
  // Each row fills the full width, including the short final row. Jitter stays
  // inside its stratum so every seed has distinct, well-conditioned sites.
  for (let row = 0; row < rows; row++) {
    const rowCount = Math.min(columns, count - row * columns);
    for (let col = 0; col < rowCount; col++) sites.push({ u: ((col + .18 + rng() * .64) / rowCount - .5) * width, v: ((row + .18 + rng() * .64) / rows - .5) * height });
  }
  const cells: FractureCell[] = [], adjacency: FractureAdjacency[] = [];
  const epsilon = Math.max(width, height) * 1e-8;
  for (let index = 0; index < count; index++) {
    const site = sites[index];
    let polygon: FracturePoint[] = [{ u: -width / 2, v: -height / 2 }, { u: width / 2, v: -height / 2 }, { u: width / 2, v: height / 2 }, { u: -width / 2, v: height / 2 }];
    for (let other = 0; other < count; other++) if (other !== index) {
      const p = sites[other], nx = p.u - site.u, ny = p.v - site.v;
      polygon = clip(polygon, nx, ny, (p.u * p.u + p.v * p.v - site.u * site.u - site.v * site.v) / 2);
    }
    polygon = polygon.filter((p, i) => { const next = polygon[(i + 1) % polygon.length]; return Math.hypot(p.u - next.u, p.v - next.v) > epsilon; });
    if (polygon.length > 32) throw new Error('Fracture cell exceeds the 64-vertex convex hull budget. Choose another seed or fewer cells.');
    const { center, area } = centroid(polygon), cellId = `${recipe.id}:cell:${index}`, vertices: PhysicsVector[] = [];
    for (const w of [-thickness / 2, thickness / 2]) for (const p of polygon) vertices.push(local(p.u - center.u, p.v - center.v, w));
    const geometry: FractureGeometry = { positions: [], normals: [], uvs: [], groups: [] };
    const triangles: { points: [number, number, number][]; normal: PhysicsVector; material: 0 | 1; uv: FracturePoint[] }[] = [];
    const addTriangle = (a: [number, number, number], b: [number, number, number], c: [number, number, number], normal: PhysicsVector, material: 0 | 1, uv?: FracturePoint[]) => {
      triangles.push({ points: [a, b, c], normal, material, uv: uv ?? [a, b, c].map(p => ({ u: p[0] / width + .5, v: p[1] / height + .5 })) });
    };
    for (let i = 1; i < polygon.length - 1; i++) {
      const a = polygon[0], b = polygon[i], c = polygon[i + 1];
      addTriangle([a.u, a.v, thickness / 2], [b.u, b.v, thickness / 2], [c.u, c.v, thickness / 2], local(0, 0, 1), 0);
      addTriangle([c.u, c.v, -thickness / 2], [b.u, b.v, -thickness / 2], [a.u, a.v, -thickness / 2], local(0, 0, -1), 0);
    }
    for (let edge = 0; edge < polygon.length; edge++) {
      const a = polygon[edge], b = polygon[(edge + 1) % polygon.length], du = b.u - a.u, dv = b.v - a.v, length = Math.hypot(du, dv);
      const middle = { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 };
      const exterior = Math.abs(Math.abs(middle.u) - width / 2) <= epsilon || Math.abs(Math.abs(middle.v) - height / 2) <= epsilon;
      const normal = local(dv / length, -du / length, 0), material = exterior ? 0 : 1;
      const lowA: [number, number, number] = [a.u, a.v, -thickness / 2], lowB: [number, number, number] = [b.u, b.v, -thickness / 2], highA: [number, number, number] = [a.u, a.v, thickness / 2], highB: [number, number, number] = [b.u, b.v, thickness / 2];
      // Side UVs are measured in the source box, never restarted per cell.
      const sideU = Math.abs(du) >= Math.abs(dv) ? (p: FracturePoint) => p.u / width + .5 : (p: FracturePoint) => p.v / height + .5;
      addTriangle(lowA, lowB, highB, normal, material, [{ u: sideU(a), v: 0 }, { u: sideU(b), v: 0 }, { u: sideU(b), v: 1 }]);
      addTriangle(lowA, highB, highA, normal, material, [{ u: sideU(a), v: 0 }, { u: sideU(b), v: 1 }, { u: sideU(a), v: 1 }]);
      if (!exterior) {
        let neighbor = -1, best = Infinity;
        for (let other = 0; other < count; other++) if (other !== index) {
          const p = sites[other], nx = p.u - site.u, ny = p.v - site.v;
          const error = Math.abs(middle.u * nx + middle.v * ny - (p.u * p.u + p.v * p.v - site.u * site.u - site.v * site.v) / 2) / Math.hypot(nx, ny);
          if (error < best) { best = error; neighbor = other; }
        }
        if (neighbor < 0 || best > epsilon * 8) throw new Error('Fracture could not resolve a shared face.');
        if (neighbor > index) adjacency.push({ id: `${recipe.id}:join:${index}:${neighbor}`, from: cellId, to: `${recipe.id}:cell:${neighbor}`, area: length * thickness, position: world(middle.u, middle.v, 0), normal: rotate(normal, rotation) });
      }
    }
    // Two contiguous draw groups, regardless of polygon topology.
    for (const materialIndex of [0, 1] as const) {
      const start = geometry.positions.length / 3;
      for (const triangle of triangles) if (triangle.material === materialIndex) for (let i = 0; i < 3; i++) {
        const raw = triangle.points[i], p = local(raw[0] - center.u, raw[1] - center.v, raw[2]);
        geometry.positions.push(p.x, p.y, p.z); geometry.normals.push(triangle.normal.x, triangle.normal.y, triangle.normal.z); geometry.uvs.push(triangle.uv[i].u, triangle.uv[i].v);
      }
      const count = geometry.positions.length / 3 - start; if (count) geometry.groups.push({ start, count, materialIndex });
    }
    const cellPosition = world(center.u, center.v, 0), volume = area * thickness;
    cells.push({ id: cellId, index, position: cellPosition, volume, mass: volume * density, strength, durability, polygon, geometry,
      collider: { id: cellId, shape: { kind: 'convex', vertices }, position: { ...cellPosition }, rotation: { ...rotation }, friction: .7, restitution: .05 } });
  }
  return freeze({ id: recipe.id, seed: recipe.seed === 0 ? 0 : recipe.seed, position, size, rotation, thinAxis, axes, volume: size.x * size.y * size.z, cells, adjacency });
}
