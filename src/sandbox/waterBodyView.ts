import {waterSurfaceTint} from './waterSurfaceOptics.ts';
import { BufferAttribute, BufferGeometry, DataTexture, DoubleSide, DynamicDrawUsage, FloatType, Group, Mesh, MeshPhysicalMaterial, NearestFilter, RGBAFormat, Color, Vector2, type Texture } from 'three';
import type { WaterBodyManifest, WaterBodyState } from './waterBody.ts';
import { waterBodyFilmOpacity } from './waterBodyPuddles.ts';
import { WATER_CURRENT_GLSL } from './waterCurrentShader.ts';
import {waterBodyContourFlags,WATER_BODY_CONTOUR_GLSL} from './waterBodyContour.ts';
import { validateBoundaryState } from './waterBoundary.ts';
import { buildWaterBoundarySurface, WaterBoundarySurfaceWorkspace, sampleWaterBoundarySurface, type WaterBoundarySurface, type WaterSurfaceConnections } from './waterBoundaryView.ts';

const VERTICES_PER_CELL = 48;
const PATCH_VALUES = 12;
const NORMAL_PATCH_VALUES = 16;
const FLOW_PATCH_VALUES = 20;
const FIELD_WIDTH = 128;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };
function bounded(v: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const value = v ?? fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`WaterBodyView ${name} must be between ${min} and ${max}.`);
  return value;
}
export interface WaterBodyStyle {
  color?: string; shallowColor?: string; foamColor?: string;
  /** Positive water depth over which the bottom becomes visible. Default .15m. */
  shallowDepth?: number;
  /** Opacity at zero depth. Default zero: the mesh meets the actual terrain. */
  edgeOpacity?: number;
  sides?: boolean;
  /** Regular-grid visual cache tolerance in metres, accumulated against the
   * last rendered depth. Boundary geometry rebuilds from exact region levels. */
  heightTolerance?: number;
  /** Regular-grid visual-only flow/foam cache tolerance, metres/second. Default .01. */
  flowTolerance?: number;
}
export interface WaterBodyViewOptions extends WaterBodyStyle {
  opacity?: number; interpolationSeconds?: number; opticalStrength?: number;
  /** Magnify reflection slopes from the accepted simulated surface, without
   * moving its geometry or adding motion to still water. Default 1, max 8. */
  waveNormalStrength?: number;
  /** Directional contrast of the final lit surface from displayed physical
   * wave normals. Keeps waves legible through reflections. 0..1; .35. */
  waveContrast?: number;
  /** Accepted local flow drives advected streaks/glints. 0 disables; default 1. */
  flowStrength?: number;
  /** Foam/ripple shading only at real sloping terrain contacts. Default 1. */
  shoreStrength?: number;
  /** Borrowed textures; disposed by their owner, never by the view. */
  map?: Texture; normalMap?: Texture; envMap?: Texture;
}
export interface WaterBodySurfaceStats {
  cells: number; wetCells: number; rebuiltCells: number; reusedCells: number;
  vertices: number; triangles: number; gridVolume: number; buildMs: number;
}
/** Every packet is independently recoverable. cellIds is an upload hint only:
 * a receiver that missed baseRevision uploads the complete arrays instead. */
export interface WaterBodySurfaceBuffers {
  waterRevision: string; revision: number; time: number; baseRevision: number;
  cellIds: Uint32Array; positions: Float32Array; normals: Float32Array;
  colors: Float32Array; uvs: Float32Array; stats: WaterBodySurfaceStats;
  /** Unclipped cell fan: center/corner heights, bed heights and wet occupancy.
   * Layout matches the three RGBA texels documented by WaterBodySurfaceField. */
  patches: Float32Array;
  /** Center XYZ, then four corner XYZ normals, then padding (16 values/cell).
   * Optional only for recordings produced before smooth surface normals. */
  normalPatches?: Float32Array;
  /** Per vertex: flow X/Z, terrain contact mask and physical water depth. */
  flowData?: Float32Array;
  /** Center and four corners, each matching the four flowData components. */
  flowPatches?: Float32Array;
  /** Actual clipped triangles for boundary cells. The coarse atlas is absent. */
  boundary?: WaterBoundarySurface;
}
/** Borrowed, view-owned field of the exact displayed triangle fans. Cell i uses
 * x=i%128 and y=floor(i/128)*3. The three RGBA texels contain:
 * [centerTop, corner0Top, corner1Top, corner2Top],
 * [corner3Top, centerBed, corner0Bed, corner1Bed],
 * [corner2Bed, corner3Bed, wetFlag, connectedEdges]. connectedEdges is 16 plus
 * bits for connected wet neighbors (-X,+Z,+X,-Z); legacy packets use zero.
 * Higher bits encode inward-rounded free corners/edges, preserving this layout.
 * Corners run (0,0),(0,1),(1,1),(1,0).
 * Mix previous/current with blend.value before testing top > bed. Never sample
 * across texels: retaining walls can give adjoining cells different corners. */
export interface WaterBodySurfaceField {
  /** Resolved pool palette, shared by local-water joins and contact effects. */
  readonly palette: {color:Color;shallowColor:Color;foamColor:Color;shallowDepth:number};
  readonly current: DataTexture; readonly previous: DataTexture;
  /** Four RGBA rows per 128 cells. Center XYZ at 0..2, corner XYZ at 3..14. */
  readonly normalCurrent: DataTexture; readonly normalPrevious: DataTexture;
  readonly blend: { value: number }; readonly water: WaterBodyManifest;
  readonly clock: { value: number }; readonly optical: { value: number };
  readonly waveNormalStrength: { value: number };
  readonly waveContrast: { value: number };
  readonly flowCurrent: DataTexture; readonly flowPrevious: DataTexture;
  readonly flowStrength: { value: number }; readonly shoreStrength: { value: number };
}
/** A retained, bounded per-grid cache. Transfer build results, not this storage. */
export class WaterBodySurfaceWorkspace {
  boundary?: WaterBoundarySurfaceWorkspace;
  signature = ''; revision = -1;
  source = new Float64Array(); triangles = new Uint8Array();
  solid = new Float64Array();
  terrain = new Float64Array(); barrierX: string[] = []; barrierZ: string[] = [];
  positions = new Float32Array(); normals = new Float32Array(); colors = new Float32Array(); uvs = new Float32Array(); patches = new Float32Array(); normalPatches = new Float32Array();
  flowData = new Float32Array(); flowPatches = new Float32Array(); cornerPoints = new Float64Array();
  clear(): void { this.boundary = undefined; this.signature = ''; this.revision = -1; this.source = new Float64Array(); this.solid = new Float64Array(); this.triangles = new Uint8Array(); this.terrain = new Float64Array(); this.barrierX = []; this.barrierZ = []; this.positions = new Float32Array(); this.normals = new Float32Array(); this.colors = new Float32Array(); this.uvs = new Float32Array(); this.patches = new Float32Array(); this.normalPatches = new Float32Array(); this.flowData=new Float32Array(); this.flowPatches=new Float32Array(); this.cornerPoints = new Float64Array(); }
}
const POINT = 9;
function normalizedInto(target: Float64Array, at: number, x: number, y: number, z: number): void {
  const length = Math.hypot(x, y, z);
  if (length) { target[at] = x / length; target[at + 1] = y / length; target[at + 2] = z / length; } else { target[at] = 0; target[at + 1] = 1; target[at + 2] = 0; }
}
/** Evaluate the same four triangle fans used by the GPU field and top mesh. */
const TOP_CORNERS = [1, 2, 3, 4], BED_CORNERS = [6, 7, 8, 9];
const CORNER_X = [0, 0, 1, 1], CORNER_Z = [0, 1, 1, 0], EDGE_X = [-1, 0, 1, 0], EDGE_Z = [0, 1, 0, -1];
const NORMAL_CORNERS = [[3, 6, 9, 12], [4, 7, 10, 13], [5, 8, 11, 14]];
// Blend toward the shown state. The settled ends skip the multiply: a
// finished blend copies what is shown, and an unstarted one keeps its values.
function rebase(target: Float32Array, shown: ArrayLike<number>, blend: number, stride = 1, offset = 0): void {
  if (blend === 0) return;
  const count = target.length;
  if (blend === 1) { for (let k = 0; k < count; k++) target[k] = shown[k * stride + offset]; return; }
  const keep = 1 - blend;
  for (let k = 0; k < count; k++) target[k] = target[k] * keep + shown[k * stride + offset] * blend;
}
function patchHeight(patch: ArrayLike<number>, center: number, corners: number[], x: number, z: number): number {
  const dx = x - .5, dz = z - .5;
  if (Math.abs(dx) >= Math.abs(dz)) return dx < 0
    ? patch[center] * 2 * x + patch[corners[0]] * (1 - x - z) + patch[corners[1]] * (z - x)
    : patch[center] * 2 * (1 - x) + patch[corners[2]] * (x + z - 1) + patch[corners[3]] * (x - z);
  return dz > 0
    ? patch[center] * 2 * (1 - z) + patch[corners[1]] * (z - x) + patch[corners[2]] * (x + z - 1)
    : patch[center] * 2 * z + patch[corners[3]] * (x - z) + patch[corners[0]] * (1 - x - z);
}
function validate(water: WaterBodyManifest, state: WaterBodyState): number {
  const n = water.columns * water.rows, bed = state.bed ?? water.bed, bedVertices = state.bedVertices ?? water.bedVertices;
  if (!Number.isInteger(water.columns) || !Number.isInteger(water.rows) || water.columns < 1 || water.rows < 1 || !Number.isInteger(n) || n < 1 || n > 16384
    || ![water.cellSizeX, water.cellSizeZ, water.cellArea].every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(water.wetDepth) || water.wetDepth < 0
    || !Number.isFinite(water.origin.x) || !Number.isFinite(water.origin.z) || water.bed.length !== n
    || water.bedVertices.length !== (water.columns + 1) * (water.rows + 1)) throw new Error('Invalid water body render grid.');
  if (state.waterRevision !== water.revision || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isFinite(state.time) || state.time < 0
    || bed.length !== n || bedVertices.length !== (water.columns + 1) * (water.rows + 1) || state.depth.length !== n || state.flowX.length !== n || state.flowZ.length !== n) throw new Error('Water body render state must match its manifest.');
  if (state.solidDepth !== undefined && (!Array.isArray(state.solidDepth) || state.solidDepth.length !== n
    || state.solidDepth.some(value => !Number.isFinite(value) || value < 0))) throw new Error('Water body solid displacement must match its render grid.');
  for (let i = 0; i < n; i++) if (!Number.isFinite(state.depth[i]) || state.depth[i] < 0 || !Number.isFinite(state.flowX[i]) || !Number.isFinite(state.flowZ[i]) || !Number.isFinite(bed[i])) throw new Error('Water body render values must be finite.');
  if (bedVertices.some(v => !Number.isFinite(v))) throw new Error('Water body terrain must be finite.');
  if (Math.abs(water.liquid.gravity.x) > 1e-9 || Math.abs(water.liquid.gravity.z) > 1e-9 || water.liquid.gravity.y >= 0) throw new Error('Water body rendering requires downward Y gravity.');
  return n;
}

/** Rebuilds changed wet cells and their shared corners only. No isosurface,
 * triangle search, simulated waves, or projection into unsimulated dry cells. */
export function buildWaterBodySurface(water: WaterBodyManifest, state: WaterBodyState,
  options: WaterBodyStyle & { workspace?: WaterBodySurfaceWorkspace; copy?: boolean; connections?:WaterSurfaceConnections } = {}): WaterBodySurfaceBuffers {
  const bed = state.bed ?? water.bed, bedVertices = state.bedVertices ?? water.bedVertices;
  const start = performance.now(), n = validate(water, state), workspace = options.workspace ?? new WaterBodySurfaceWorkspace();
  if (water.boundaryCells || state.boundary) {
    validateBoundaryState(water, state);
    return buildWaterBoundarySurface(water, state, options, workspace.boundary ??= new WaterBoundarySurfaceWorkspace());
  }
  const shallow = bounded(options.shallowDepth, .15, .001, 20, 'shallowDepth'), edgeOpacity = bounded(options.edgeOpacity, 0, 0, 1, 'edgeOpacity');
  const heightTolerance = bounded(options.heightTolerance, .0005, 0, .002, 'heightTolerance'), flowTolerance = bounded(options.flowTolerance, .01, 0, .1, 'flowTolerance');
  if (options.sides !== undefined && typeof options.sides !== 'boolean') throw new Error('WaterBodyView sides must be boolean.');
  const color = new Color(options.color ?? '#258b9f'), shallowColor = new Color(options.shallowColor ?? '#65b9ba'), foamColor = new Color(options.foamColor ?? '#e5f7f3');
  const signature = JSON.stringify([water.revision, water.columns, water.rows, shallow, edgeOpacity, options.color, options.shallowColor, options.foamColor, options.sides, heightTolerance, flowTolerance]);
  const fresh = workspace.signature !== signature, baseRevision = fresh ? -1 : workspace.revision, dirty = new Uint8Array(n);
  if (fresh) {
    workspace.signature = signature; workspace.source = new Float64Array(n * 3).fill(NaN); workspace.solid = new Float64Array(n); workspace.triangles = new Uint8Array(n);
    workspace.positions = new Float32Array(n * VERTICES_PER_CELL * 3); workspace.normals = new Float32Array(n * VERTICES_PER_CELL * 3);
    workspace.colors = new Float32Array(n * VERTICES_PER_CELL * 4); workspace.uvs = new Float32Array(n * VERTICES_PER_CELL * 2);
    workspace.patches = new Float32Array(n * PATCH_VALUES);
    workspace.normalPatches = new Float32Array(n * NORMAL_PATCH_VALUES);
    workspace.flowData = new Float32Array(n * VERTICES_PER_CELL * 4); workspace.flowPatches = new Float32Array(n * FLOW_PATCH_VALUES);
  }
  // A cell's geometry reads terrain and barriers only inside its 3x3
  // neighborhood: corner averages, retaining faces and side drops. A moving
  // panel rewrites hundreds of barrier faces every step, so rebuild around
  // each changed bed, bed vertex or face rather than the whole grid.
  const mark = (x: number, z: number) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (x + dx >= 0 && x + dx < water.columns && z + dz >= 0 && z + dz < water.rows) dirty[(x + dx) * water.rows + z + dz] = 1;
  };
  const barrierX = state.barrierX ?? [], barrierZ = state.barrierZ ?? [];
  const terrainChanged = fresh || bed.length + bedVertices.length !== workspace.terrain.length
    || barrierX.length !== workspace.barrierX.length || barrierZ.length !== workspace.barrierZ.length;
  let terrainMoved = terrainChanged;
  if (!terrainChanged) {
    for (let k = 0; k < bed.length; k++) if (bed[k] !== workspace.terrain[k]) { mark(Math.floor(k / water.rows), k % water.rows); terrainMoved = true; }
    for (let k = 0; k < bedVertices.length; k++) if (bedVertices[k] !== workspace.terrain[bed.length + k]) {
      // Only the four cells sharing a vertex read its bed height.
      const x = Math.floor(k / (water.rows + 1)), z = k % (water.rows + 1); terrainMoved = true;
      for (let dx = -1; dx <= 0; dx++) for (let dz = -1; dz <= 0; dz++) if (x + dx >= 0 && x + dx < water.columns && z + dz >= 0 && z + dz < water.rows) dirty[(x + dx) * water.rows + z + dz] = 1;
    }
    for (let k = 0; k < barrierX.length; k++) if (barrierX[k] !== workspace.barrierX[k]) {
      const x = Math.floor(k / water.rows), z = k % water.rows; terrainMoved = true;
      if (x > 0) mark(x - 1, z); if (x < water.columns) mark(x, z);
    }
    for (let k = 0; k < barrierZ.length; k++) if (barrierZ[k] !== workspace.barrierZ[k]) {
      const x = Math.floor(k / (water.rows + 1)), z = k % (water.rows + 1); terrainMoved = true;
      if (z > 0) mark(x, z - 1); if (z < water.rows) mark(x, z);
    }
  }
  if (terrainChanged) dirty.fill(1);
  if (terrainMoved) {
    const terrain = new Float64Array(bed.length + bedVertices.length); terrain.set(bed); terrain.set(bedVertices, bed.length);
    workspace.terrain = terrain; workspace.barrierX = barrierX.slice(); workspace.barrierZ = barrierZ.slice();
  }
  let wetCells = 0, gridVolume = 0;
  for (let i = 0; i < n; i++) {
    gridVolume += state.depth[i] * water.cellArea; if (state.depth[i] > water.wetDepth) wetCells++;
    if (terrainChanged || !Number.isFinite(workspace.source[i * 3])
      || (workspace.source[i * 3] > water.wetDepth) !== (state.depth[i] > water.wetDepth)
      || Math.abs(workspace.source[i * 3] - state.depth[i]) > heightTolerance
      || Math.abs(workspace.solid[i] - (state.solidDepth?.[i] ?? 0)) > heightTolerance
      || Math.abs(workspace.source[i * 3 + 1] - state.flowX[i]) > flowTolerance
      || Math.abs(workspace.source[i * 3 + 2] - state.flowZ[i]) > flowTolerance) {
      mark(Math.floor(i / water.rows), i % water.rows);
      workspace.source[i * 3] = state.depth[i]; workspace.source[i * 3 + 1] = state.flowX[i]; workspace.source[i * 3 + 2] = state.flowZ[i];
      workspace.solid[i] = state.solidDepth?.[i] ?? 0;
    }
  }
  // Geometry reads one coherent cached field. Reading current neighbor values
  // only for rebuilt cells would create cracks against retained shared corners.
  const depthAt = (i: number) => workspace.source[i * 3];
  // Displacement is occupied solid volume, not additional water. It raises
  // the physical free surface but never marks an empty cell as wet or adds to
  // the water ledger. Shared corners and normals use this same exact head.
  const levelAt = (i: number) => bed[i] + depthAt(i) + workspace.solid[i];
  const barrierCrests = new Map<string, number>();
  const blocked = (ax: number, az: number, bx: number, bz: number) => {
    const barrier = ax !== bx ? state.barrierX?.[Math.max(ax, bx) * water.rows + az]
      : state.barrierZ?.[ax * (water.rows + 1) + Math.max(az, bz)];
    if (!barrier) return false;
    let crest = barrierCrests.get(barrier);
    if (crest === undefined) {
      // Runtime signatures are id|bottom|top. Identity-only legacy barriers
      // remain retaining walls; IDs may themselves contain a separator.
      const separator = barrier.lastIndexOf('|'), top = separator < 0 ? NaN : Number(barrier.slice(separator + 1));
      crest = Number.isFinite(top) ? top : Infinity; barrierCrests.set(barrier, crest);
    }
    const a = ax * water.rows + az, b = bx * water.rows + bz;
    // A submerged solid still affects flow below its crest, but water above
    // it has one free surface. Do not extrude its faces up through that water.
    return crest >= Math.min(levelAt(a), levelAt(b)) - 1e-8;
  };
  // At most four cells meet at a corner; scratch avoids per-corner lists.
  const cells = new Int32Array(4), reached = new Int32Array(5);
  // Points are rows of POINT numbers in flat scratch: x, z, height, bed,
  // normal xyz, flow xz. Small point objects box every number on the browser
  // heap, which made this loop several times slower there than in Node.
  // A corner depends only on its vertex and the sorted wet set reached from
  // the asking cell, so the up to four cells sharing it reuse one row.
  const cornerRows = new Map<number, number>();
  let shared = workspace.cornerPoints, sharedUsed = 0;
  const corner = (x: number, z: number, fallback: number, source: number): number => {
    let cellCount = 0;
    for (let dx = -1; dx <= 0; dx++) for (let dz = -1; dz <= 0; dz++) if (x + dx >= 0 && x + dx < water.columns && z + dz >= 0 && z + dz < water.rows) {
      const i = (x + dx) * water.rows + z + dz;
      if (depthAt(i) > water.wetDepth) cells[cellCount++] = i;
    }
    // Shared corners average only within the connected wet neighborhood.
    // Retaining walls and diagonal-only pools cannot equalize render heights.
    let count = 1; reached[0] = source;
    const has = (value: number) => { for (let k = 0; k < count; k++) if (reached[k] === value) return true; return false; };
    for (let at = 0; at < count; at++) for (let k = 0; k < cellCount; k++) { const next = cells[k]; if (!has(next)) {
      const ax = Math.floor(reached[at] / water.rows), az = reached[at] % water.rows, bx = Math.floor(next / water.rows), bz = next % water.rows;
      if (Math.abs(ax - bx) + Math.abs(az - bz) === 1 && !blocked(ax, az, bx, bz)) reached[count++] = next;
    } }
    let mask = 0;
    for (let k = 0; k < count; k++) {
      const dx = Math.floor(reached[k] / water.rows) - x, dz = reached[k] % water.rows - z;
      mask = dx >= -1 && dx <= 0 && dz >= -1 && dz <= 0 ? mask | 1 << ((dx + 1) * 2 + dz + 1) : -1;
      if (mask < 0) break;
    }
    const key = mask < 0 ? -1 : (x * (water.rows + 1) + z) * 16 + mask, known = key < 0 ? undefined : cornerRows.get(key);
    if (known !== undefined) return known;
    for (let k = 1; k < count; k++) { const value = reached[k]; let j = k - 1; while (j >= 0 && reached[j] > value) { reached[j + 1] = reached[j]; j--; } reached[j + 1] = value; }
    let sum = 0, flowX = 0, flowZ = 0; for (let k = 0; k < count; k++) sum = sum + levelAt(reached[k]);
    // Reconstruct a shared slope from the connected cell centers. Per-face
    // normals made each coarse grid cell reflect like four square pyramids.
    // This filter never reads through a retaining wall or an unsimulated cell.
    let left = 0, right = 0, near = 0, far = 0, leftN = 0, rightN = 0, nearN = 0, farN = 0;
    for (let k = 0; k < count; k++) {
      const i = reached[k], level = levelAt(i);
      if (Math.floor(i / water.rows) < x) { left += level; leftN++; } else { right += level; rightN++; }
      if (i % water.rows < z) { near += level; nearN++; } else { far += level; farN++; }
    }
    for (let k = 0; k < count; k++) flowX = flowX + workspace.source[reached[k] * 3 + 1];
    for (let k = 0; k < count; k++) flowZ = flowZ + workspace.source[reached[k] * 3 + 2];
    const slopeX = leftN && rightN ? (right / rightN - left / leftN) / water.cellSizeX : 0;
    const slopeZ = nearN && farN ? (far / farN - near / nearN) / water.cellSizeZ : 0;
    if (sharedUsed + POINT > shared.length) { const grown = new Float64Array(Math.max(shared.length * 2, POINT * 256)); grown.set(shared); shared = workspace.cornerPoints = grown; }
    const p = sharedUsed; sharedUsed += POINT;
    shared[p] = water.origin.x + x * water.cellSizeX; shared[p + 1] = water.origin.z + z * water.cellSizeZ;
    shared[p + 2] = count ? sum / count : fallback; shared[p + 3] = bedVertices[x * (water.rows + 1) + z];
    normalizedInto(shared, p + 4, -slopeX, 1, -slopeZ);
    shared[p + 7] = flowX / count; shared[p + 8] = flowZ / count;
    if (key >= 0) cornerRows.set(key, p);
    return p;
  };
  // Per-cell points: the center, its four corners, clipped crossings and
  // side copies. A cell needs at most 33 rows.
  const T = new Float64Array(48 * POINT); let used = 0;
  const copyPoint = (from: Float64Array, at: number) => { const p = used; used += POINT; for (let k = 0; k < POINT; k++) T[p + k] = from[at + k]; return p; };
  const crossing = (a: number, b: number) => {
    const da = T[a + 2] - T[a + 3], db = T[b + 2] - T[b + 3], t = da / (da - db), p = used; used += POINT;
    for (let k = 0; k < POINT; k++) T[p + k] = T[a + k] + (T[b + k] - T[a + k]) * t;
    return p;
  };
  const positions = workspace.positions, normals = workspace.normals, colors = workspace.colors, uvs = workspace.uvs, flowData = workspace.flowData;
  let write = 0, cell = 0, center = 0, terrainContact = 0;
  const emit = (a: number, b: number, c: number, side: boolean) => {
    const abx = T[b] - T[a], aby = T[b + 2] - T[a + 2], abz = T[b + 1] - T[a + 1], acx = T[c] - T[a], acy = T[c + 2] - T[a + 2], acz = T[c + 1] - T[a + 1];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz); if (length < 1e-12) return;
    nx /= length; ny /= length; nz /= length; workspace.triangles[cell]++;
    for (let corner = 0; corner < 3; corner++) {
      const point = corner === 0 ? a : corner === 1 ? b : c;
      const depth = Math.max(0, T[point + 2] - T[point + 3]), edge = 1 - smooth(depth / shallow);
      const filmOpacity = waterBodyFilmOpacity(depth);
      const foam = side ? 0 : terrainContact*(1 - smooth(depth / (shallow * .3))) * .04;
      const tint = waterSurfaceTint(depth,shallow,side);
      const p = write * 3, q = write * 4, u = write * 2;
      positions[p] = T[point]; positions[p + 1] = T[point + 2]; positions[p + 2] = T[point + 1];
      if (side) { normals[p] = nx; normals[p + 1] = ny; normals[p + 2] = nz; } else { normals[p] = T[point + 4]; normals[p + 1] = T[point + 5]; normals[p + 2] = T[point + 6]; }
      colors[q] = (color.r * (1 - tint) + shallowColor.r * tint) * (1 - foam) + foamColor.r * foam;
      colors[q + 1] = (color.g * (1 - tint) + shallowColor.g * tint) * (1 - foam) + foamColor.g * foam;
      colors[q + 2] = (color.b * (1 - tint) + shallowColor.b * tint) * (1 - foam) + foamColor.b * foam;
      colors[q + 3] = (side ? .65 : 1) * Math.max(1 - (1 - edgeOpacity) * edge, filmOpacity);
      uvs[u] = T[point]; uvs[u + 1] = T[point + 1];
      if (side) { flowData[q] = 0; flowData[q + 1] = 0; flowData[q + 2] = 0; }
      else { flowData[q] = T[point + 7]; flowData[q + 1] = T[point + 8]; flowData[q + 2] = terrainContact; }
      flowData[q + 3] = depth; write++;
    }
  };
  const corners = new Int32Array(4), polygon = new Int32Array(8);
  const cellIds: number[] = [];
  for (let i = 0; i < n; i++) if (dirty[i]) {
    cellIds.push(i); workspace.triangles[i] = 0; cell = i; used = 0;
    const x = Math.floor(i / water.rows), z = i % water.rows, level = levelAt(i);
    center = used; used += POINT;
    T[center] = water.origin.x + (x + .5) * water.cellSizeX; T[center + 1] = water.origin.z + (z + .5) * water.cellSizeZ;
    T[center + 2] = level; T[center + 3] = bed[i]; T[center + 7] = workspace.source[i * 3 + 1]; T[center + 8] = workspace.source[i * 3 + 2];
    const first = i * VERTICES_PER_CELL;
    // Unused slots are degenerate and transparent, including cells that dried.
    for (let v = first; v < first + VERTICES_PER_CELL; v++) {
      const p = v * 3, c = v * 4, u = v * 2;
      positions[p] = T[center]; positions[p + 1] = level; positions[p + 2] = T[center + 1]; normals[p] = 0; normals[p + 1] = 1; normals[p + 2] = 0;
      colors[c] = color.r; colors[c + 1] = color.g; colors[c + 2] = color.b; colors[c + 3] = 0; uvs[u] = T[center]; uvs[u + 1] = T[center + 1];
      flowData[c] = 0; flowData[c + 1] = 0; flowData[c + 2] = 0; flowData[c + 3] = 0;
    }
    // Copy each shared corner right after it is found: finding the next one
    // can grow the shared rows.
    for (let k = 0; k < 4; k++) { const row = corner(x + CORNER_X[k], z + CORNER_Z[k], level, i); corners[k] = copyPoint(shared, row); }
    // Terrain alone supplies bed heights. Solid displacement, coarse obstacle
    // barriers and the simulation rectangle must never manufacture shore rings.
    let touches = false, lowBed = Infinity, highBed = -Infinity;
    for (let k = 0; k < 4; k++) {
      const point = corners[k]; if (T[point + 3] >= T[point + 2] - water.wetDepth) touches = true;
      lowBed = Math.min(lowBed, T[point + 3]); highBed = Math.max(highBed, T[point + 3]);
    }
    terrainContact = depthAt(i) > water.wetDepth && touches && highBed - lowBed > 1e-5 ? 1 : 0;
    for (let k = 0, at = i * FLOW_PATCH_VALUES; k < 5; k++, at += 4) {
      const point = k ? corners[k - 1] : center;
      workspace.flowPatches[at] = T[point + 7]; workspace.flowPatches[at + 1] = T[point + 8];
      workspace.flowPatches[at + 2] = terrainContact; workspace.flowPatches[at + 3] = Math.max(0, T[point + 2] - T[point + 3]);
    }
    let sumX = 0, sumY = 0, sumZ = 0;
    for (let k = 0; k < 4; k++) { const point = corners[k]; sumX += T[point + 4]; sumY += T[point + 5]; sumZ += T[point + 6]; }
    normalizedInto(T, center + 4, sumX, sumY, sumZ);
    {
      const at = i * NORMAL_PATCH_VALUES, patch = workspace.normalPatches;
      for (let k = 0; k < 5; k++) { const point = k ? corners[k - 1] : center; patch[at + k * 3] = T[point + 4]; patch[at + 1 + k * 3] = T[point + 5]; patch[at + 2 + k * 3] = T[point + 6]; }
      patch[at + 15] = 0;
    }
    let connectedEdges = 16;
    if (depthAt(i) > water.wetDepth) for (let edge = 0; edge < 4; edge++) {
      const nx = x + EDGE_X[edge], nz = z + EDGE_Z[edge];
      if (nx >= 0 && nx < water.columns && nz >= 0 && nz < water.rows && depthAt(nx * water.rows + nz) > water.wetDepth && !blocked(x, z, nx, nz)) connectedEdges |= 1 << edge;
    }
    let freeEdges=0;
    // A sloping bed already supplies the actual water/land contour. Rounding
    // the cell rectangle again would intersect it with a second silhouette
    // and introduce periodic V-shaped notches along an otherwise smooth coast.
    if(depthAt(i)>water.wetDepth&&!terrainContact)for(let edge=0;edge<4;edge++){
      const nx=x+EDGE_X[edge],nz=z+EDGE_Z[edge];
      if(nx>=0&&nx<water.columns&&nz>=0&&nz<water.rows&&depthAt(nx*water.rows+nz)<=water.wetDepth&&!blocked(x,z,nx,nz))freeEdges|=1<<edge;
    }
    connectedEdges+=waterBodyContourFlags(freeEdges);
    {
      const at = i * PATCH_VALUES, patch = workspace.patches;
      patch[at] = T[center + 2]; for (let k = 0; k < 4; k++) patch[at + 1 + k] = T[corners[k] + 2];
      patch[at + 5] = T[center + 3]; for (let k = 0; k < 4; k++) patch[at + 6 + k] = T[corners[k] + 3];
      patch[at + 10] = depthAt(i) > water.wetDepth ? 1 : 0; patch[at + 11] = connectedEdges;
    }
    if (depthAt(i) <= water.wetDepth) continue;
    write = first;
    for (let edge = 0; edge < 4; edge++) {
      const a0 = center, a1 = corners[edge], a2 = corners[(edge + 1) % 4]; let size = 0;
      for (let p = 0; p < 3; p++) { const a = p === 0 ? a0 : p === 1 ? a1 : a2, b = p === 0 ? a1 : p === 1 ? a2 : a0, insideA = T[a + 2] > T[a + 3], insideB = T[b + 2] > T[b + 3];
        if (insideA) polygon[size++] = a; if (insideA !== insideB) polygon[size++] = crossing(a, b); }
      for (let p = 1; p + 1 < size; p++) emit(polygon[0], polygon[p], polygon[p + 1], false);
    }
    // Side slots begin at a stable offset regardless of top clipping topology.
    write = first + 24;
    if (options.sides !== false) for (let edge = 0; edge < 4; edge++) {
      if (connectedEdges & (1 << edge)) continue;
      let a = corners[edge], b = corners[(edge + 1) % 4];
      const nx = x + EDGE_X[edge], nz = z + EDGE_Z[edge];
      if (nx >= 0 && nx < water.columns && nz >= 0 && nz < water.rows) {
        const neighbor = nx * water.rows + nz;
        if (depthAt(neighbor) > water.wetDepth) {
          // A retaining face separates pressure/height samples, not two exposed
          // liquid/air interfaces. Extruding both wet cells down to the bed
          // made coincident translucent walls along the obstacle's coarse grid
          // footprint, especially visible beside thin rotated panels. Render
          // only a genuine drop above the adjoining water, once on its high
          // side. Basin edges and dry neighbors still expose their full depth.
          const neighborLevel = levelAt(neighbor), next = (edge + 1) % 4;
          // Read each row only after its lookup, which can grow the rows.
          const rowA = corner(x + CORNER_X[edge], z + CORNER_Z[edge], neighborLevel, neighbor), neighborA = shared[rowA + 2];
          const rowB = corner(x + CORNER_X[next], z + CORNER_Z[next], neighborLevel, neighbor), neighborB = shared[rowB + 2];
          const raisedA = copyPoint(T, a); T[raisedA + 3] = Math.max(T[a + 3], neighborA); a = raisedA;
          const raisedB = copyPoint(T, b); T[raisedB + 3] = Math.max(T[b + 3], neighborB); b = raisedB;
        }
      }
      if (T[a + 2] <= T[a + 3] && T[b + 2] <= T[b + 3]) continue;
      if (T[a + 2] <= T[a + 3]) a = crossing(a, b); else if (T[b + 2] <= T[b + 3]) b = crossing(a, b);
      const bottomA = copyPoint(T, a); T[bottomA + 2] = T[a + 3];
      const bottomB = copyPoint(T, b); T[bottomB + 2] = T[b + 3];
      emit(a, bottomA, b, true); emit(b, bottomA, bottomB, true);
    }
  }
  workspace.revision = state.revision;
  const copy = options.copy !== false;
  return { waterRevision: water.revision, revision: state.revision, time: state.time, baseRevision, cellIds: Uint32Array.from(cellIds),
    positions: copy ? workspace.positions.slice() : workspace.positions, normals: copy ? workspace.normals.slice() : workspace.normals,
    colors: copy ? workspace.colors.slice() : workspace.colors, uvs: copy ? workspace.uvs.slice() : workspace.uvs,
    patches: copy ? workspace.patches.slice() : workspace.patches,
    normalPatches: copy ? workspace.normalPatches.slice() : workspace.normalPatches,
    flowData: copy ? workspace.flowData.slice() : workspace.flowData,flowPatches:copy?workspace.flowPatches.slice():workspace.flowPatches,
    stats: { cells: n, wetCells, rebuiltCells: cellIds.length, reusedCells: n - cellIds.length, vertices: n * VERTICES_PER_CELL,
      triangles: workspace.triangles.reduce((sum, value) => sum + value, 0), gridVolume, buildMs: performance.now() - start } };
}

/** Persistent depth-grid surface. Call update only for accepted simulation
 * states and animate every display frame. */
export class WaterBodyView {
  readonly root = new Group(); readonly geometry = new BufferGeometry(); readonly material: MeshPhysicalMaterial; readonly mesh: Mesh;
  private readonly regularField: WaterBodySurfaceField;
  private boundarySurface?: WaterBodySurfaceBuffers;
  private latestSurface?:WaterBodySurfaceBuffers;
  /** Borrowed accepted geometry for cosmetic terrain contacts. */
  get acceptedSurface():WaterBodySurfaceBuffers|undefined{return this.latestSurface;}
  private boundaryInterpolating=false;
  /** The rectangular atlas cannot describe independent heads inside a cell. */
  get surfaceField(): WaterBodySurfaceField {
    if (this.water.boundaryCells) throw new Error('Boundary water has no rectangular surface field; use sampleBoundarySurface.');
    return this.regularField;
  }
  /** Sample the accepted displayed triangles, rather than the coarse summary. */
  sampleBoundarySurface(point: { x: number; z: number }) {
    if (!this.water.boundaryCells) throw new Error('Expected boundary water.');
    return this.boundarySurface ? sampleWaterBoundarySurface(this.boundarySurface, point) : undefined;
  }
  private readonly water: WaterBodyManifest; private readonly options: WaterBodyViewOptions;
  private readonly workspace = new WaterBodySurfaceWorkspace();
  private readonly blend = { value: 1 }; private readonly clock = { value: 0 }; private readonly optical = { value: 1 };
  private readonly waveNormalStrength = { value: 1 };
  private readonly waveContrast = { value: .35 };
  private readonly flowStrength = {value:1};private readonly shoreStrength={value:1};
  private readonly duration: number; private began = 0; private revision = -1; private disposed = false;
  private stats?: WaterBodySurfaceStats;
  constructor(water: WaterBodyManifest, options: WaterBodyViewOptions = {}) {
    this.water = water; this.options = options;
    this.duration = bounded(options.interpolationSeconds, .1, 0, 1, 'interpolationSeconds') * 1000;
    this.optical.value = bounded(options.opticalStrength, 1, 0, 2, 'opticalStrength');
    this.waveNormalStrength.value = bounded(options.waveNormalStrength, 1, 1, 8, 'waveNormalStrength');
    this.waveContrast.value = bounded(options.waveContrast, .35, 0, 1, 'waveContrast');
    this.flowStrength.value=bounded(options.flowStrength,water.currents===false?0:1,0,2,'flowStrength');this.shoreStrength.value=bounded(options.shoreStrength,1,0,2,'shoreStrength');
    this.material = new MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, side: DoubleSide, transparent: true,
      opacity: bounded(options.opacity, .9, .01, 1, 'opacity'), roughness: .12, metalness: 0, ior: 1.333, clearcoat: .65, clearcoatRoughness: .08,
      map: options.map ?? null, normalMap: options.normalMap ?? null, envMap: options.envMap ?? null });
    const capacity = water.columns * water.rows * VERTICES_PER_CELL;
    if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 16384 * VERTICES_PER_CELL) throw new Error('Invalid water body render grid.');
    const count = water.boundaryCells ? 0 : capacity;
    const fieldTexture = (rows: number) => {
      const fieldHeight = Math.ceil(water.columns * water.rows / FIELD_WIDTH) * rows;
      const texture = new DataTexture(new Float32Array(FIELD_WIDTH * fieldHeight * 4), FIELD_WIDTH, fieldHeight, RGBAFormat, FloatType);
      texture.minFilter = texture.magFilter = NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
      return texture;
    };
    this.regularField = { palette:{color:new Color(options.color??'#258b9f'),shallowColor:new Color(options.shallowColor??'#65b9ba'),foamColor:new Color(options.foamColor??'#e5f7f3'),shallowDepth:bounded(options.shallowDepth,.15,.001,20,'shallowDepth')},current: fieldTexture(3), previous: fieldTexture(3), normalCurrent: fieldTexture(4), normalPrevious: fieldTexture(4),flowCurrent:fieldTexture(5),flowPrevious:fieldTexture(5), blend: this.blend, water, clock: this.clock, optical: this.optical, waveNormalStrength: this.waveNormalStrength, waveContrast: this.waveContrast,flowStrength:this.flowStrength,shoreStrength:this.shoreStrength };
    for (const [name, size] of [['position', 3], ['normal', 3], ['color', 4], ['uv', 2], ['waterBodyFromHeight', 1], ['waterBodyFromNormal', 3], ['waterBodyFilmDepth', 1],['waterBodyFlow',4],['waterBodyFromFlow',4],['waterBodyContour',3]] as const) this.geometry.setAttribute(name, new BufferAttribute(new Float32Array(count * size), size).setUsage(DynamicDrawUsage));
    this.geometry.setDrawRange(0, count);
    this.material.onBeforeCompile = shader => {
      shader.uniforms.waterBodyBlend = this.blend; shader.uniforms.waterBodyClock = this.clock; shader.uniforms.waterBodyOptical = this.optical;
      shader.uniforms.waterBodyWaveNormalStrength = this.waveNormalStrength;
      shader.uniforms.waterBodyWaveContrast = this.waveContrast;
      shader.uniforms.waterBodyContourSize={value:new Vector2(water.cellSizeX,water.cellSizeZ)};
      shader.uniforms.waterBodyFlowStrength=this.flowStrength;shader.uniforms.waterBodyShoreStrength=this.shoreStrength;
      shader.uniforms.waterBodyShallowDepth={value:options.shallowDepth??.15};shader.uniforms.waterBodyEdgeOpacity={value:options.edgeOpacity??0};
      shader.vertexShader = 'uniform float waterBodyBlend;\nuniform float waterBodyWaveNormalStrength;\nattribute float waterBodyFromHeight;\nattribute vec3 waterBodyFromNormal;\nattribute float waterBodyFilmDepth;\nattribute vec4 waterBodyFlow;\nattribute vec4 waterBodyFromFlow;\nattribute vec3 waterBodyContour;\nvarying vec3 waterBodyContourCell;\nvarying vec4 waterBodyCurrent;\nvarying float waterBodyDepth;\nvarying vec2 waterBodyUv;\nvarying float waterBodyTop;\nvarying vec3 waterBodyU;\nvarying vec3 waterBodyV;\nvarying vec3 waterBodyWaveNormal;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = mix(waterBodyFromNormal, objectNormal, waterBodyBlend);\nobjectNormal.xz *= waterBodyWaveNormalStrength;');
      // Normalize after raster interpolation, so clipped shoreline vertices
      // and the shared GPU normal atlas evaluate the identical smooth field.
      shader.vertexShader = shader.vertexShader.replace('#include <normal_vertex>', '#include <normal_vertex>\n#ifndef FLAT_SHADED\nvNormal = transformedNormal;\n#endif');
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y = mix(waterBodyFromHeight, transformed.y, waterBodyBlend);\nwaterBodyDepth = max(0.0, waterBodyFilmDepth+transformed.y-position.y);\nwaterBodyCurrent=mix(waterBodyFromFlow,waterBodyFlow,waterBodyBlend);\nwaterBodyUv = uv;\nwaterBodyContourCell=waterBodyContour;\nwaterBodyTop = max(0.0, objectNormal.y);\nwaterBodyWaveNormal = objectNormal;\nwaterBodyU = normalize((modelViewMatrix * vec4(1.0,0.0,0.0,0.0)).xyz);\nwaterBodyV = normalize((modelViewMatrix * vec4(0.0,0.0,1.0,0.0)).xyz);');
      shader.fragmentShader = WATER_BODY_CONTOUR_GLSL + WATER_CURRENT_GLSL + 'uniform vec2 waterBodyContourSize;\nvarying vec3 waterBodyContourCell;\nuniform float waterBodyFlowStrength;\nuniform float waterBodyShoreStrength;\nuniform float waterBodyShallowDepth;\nuniform float waterBodyEdgeOpacity;\nvarying vec4 waterBodyCurrent;\nuniform float waterBodyClock;\nuniform float waterBodyOptical;\nuniform float waterBodyWaveContrast;\nvarying float waterBodyDepth;\nvarying vec2 waterBodyUv;\nvarying float waterBodyTop;\nvarying vec3 waterBodyU;\nvarying vec3 waterBodyV;\nvarying vec3 waterBodyWaveNormal;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
// Optical slopes only: positions, depth, and the wet boundary never move.
vec2 waterBodySlope = normalize(vec2(5.2, 1.8)) * 0.065 * cos(dot(waterBodyUv, vec2(5.2, 1.8)) - waterBodyClock * 1.15)
  + normalize(vec2(-3.0, 8.0)) * 0.045 * cos(dot(waterBodyUv, vec2(-3.0, 8.0)) - waterBodyClock * 1.65)
  + normalize(vec2(16.0, -10.0)) * 0.025 * cos(dot(waterBodyUv, vec2(16.0, -10.0)) + waterBodyClock * 2.1);
// Thin puddles reflect as a flat film; pool detail emerges continuously with
// physical depth, without raising the surface or flooding dry neighbours.
float waterBodyActivity=max(smoothstep(0.025,0.7,length(waterBodyCurrent.xy)),clamp(length(waterBodyWaveNormal.xz)*4.0,0.0,1.0));
waterBodySlope=waterBodySlope*waterBodyOptical*waterBodyActivity+waterBodyCurrentDetail.xy*waterBodyFlowStrength;
vec3 waterBodyNormalDetail = waterBodyTop * smoothstep(0.002,0.04,waterBodyDepth) * (waterBodyU * waterBodySlope.x + waterBodyV * waterBodySlope.y);
normal = normalize(normal + waterBodyNormalDetail);`);
      // Physical water's clearcoat must see the same ripples; leaving this
      // layer flat hides the animated normal in its strongest reflections.
      shader.fragmentShader = shader.fragmentShader.replace('#include <clearcoat_normal_fragment_maps>', `#include <clearcoat_normal_fragment_maps>
#ifdef USE_CLEARCOAT
clearcoatNormal = normalize(clearcoatNormal + waterBodyNormalDetail);
#endif`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
float waterBodyContourMask=waterContourCoverage(waterBodyUv-waterBodyContourCell.xy,waterBodyContourSize,waterBodyContourCell.z);
if(waterBodyContourMask<=0.0)discard;
diffuseColor.a*=waterBodyContourMask;
// Only accepted physical slopes contribute: still water stays unchanged,
// and this light/dark response travels and decays with the simulated wave.
vec3 waterBodyWaveLight = normalize(vec3(-1.0,1.2,-1.0));
float waterBodyWaveShade = clamp(4.0*(dot(normalize(waterBodyWaveNormal),waterBodyWaveLight)-waterBodyWaveLight.y),-0.7,0.7);
float waterBodyWaveTone = 1.0+waterBodyWaveContrast*waterBodyWaveShade*smoothstep(0.25,0.75,waterBodyTop);
vec4 waterBodyCurrentDetail=waterCurrentDetail(waterBodyUv,waterBodyCurrent.xy,waterBodyDepth,waterBodyCurrent.z,waterBodyClock);
float waterBodyFoam=waterBodyCurrentDetail.w*waterBodyShoreStrength*waterBodyTop;
diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.85,0.96,0.94),clamp(waterBodyFlowStrength*waterBodyCurrentDetail.z*0.26+waterBodyFoam,0.0,0.8));
// Reconstruct contact opacity per pixel, rather than interpolating opaque
// cell centers to transparent corners as visible square/triangular patches.
#ifdef USE_COLOR_ALPHA
if(waterBodyTop>0.5){float shoreAlpha=max(mix(waterBodyEdgeOpacity,1.0,smoothstep(0.0,waterBodyShallowDepth,waterBodyDepth)),0.2*smoothstep(0.0,0.002,waterBodyDepth));diffuseColor.a*=shoreAlpha/max(vColor.a,0.0001);}
#endif`);
      // Apply after the physical specular and clearcoat layers: tinting only
      // diffuseColor left accepted slopes invisible under a bright sky map.
      // Tone mapping still bounds highlights, and a flat surface is unchanged.
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight *= waterBodyWaveTone;\n#include <opaque_fragment>');
    };
    this.material.customProgramCacheKey = () => 'water-body-depth-grid-v9-rounded' ;
    this.mesh = new Mesh(this.geometry, this.material); this.mesh.name = `${water.liquid.id}:waterBody-${water.boundaryCells ? 'boundary' : 'grid'}`; this.mesh.frustumCulled = false; this.mesh.receiveShadow = true;
    this.root.add(this.mesh);
  }
  update(state: WaterBodyState, nowMs = performance.now()): void {
    if (this.disposed) return;
    // Trusted replay/checkpoint state can rewind its clock and revision.
    // A stale-packet guard in applySurface must not suppress that reset.
    if(this.latestSurface&&state.time<this.latestSurface.time){this.workspace.clear();this.revision=-1;this.boundarySurface=undefined;this.latestSurface=undefined;this.boundaryInterpolating=false;}
    if(state.revision===this.revision){
      if(this.latestSurface&&this.latestSurface.time!==state.time){this.latestSurface={...this.latestSurface,time:state.time};if(this.boundarySurface)this.boundarySurface={...this.boundarySurface,time:state.time};}
      return;
    }
    this.apply(buildWaterBodySurface(this.water, state, { ...this.options, workspace: this.workspace, copy: false }), nowMs, true);
  }
  applySurface(surface: WaterBodySurfaceBuffers, nowMs = performance.now()): void {
    this.apply(surface, nowMs, false);
  }
  private applyBoundary(surface: WaterBodySurfaceBuffers, nowMs: number, trusted: boolean): void {
    const boundary = surface.boundary, vertices = surface.positions?.length / 3, cells = this.water.columns * this.water.rows;
    if (!this.water.boundaryCells || !boundary || typeof boundary.meshRevision !== 'string' || !boundary.meshRevision.length
      || !Number.isSafeInteger(boundary.regionCount) || boundary.regionCount < 1 || boundary.regionCount > 32768
      || surface.waterRevision !== this.water.revision || !Number.isSafeInteger(surface.revision) || surface.revision < 0
      || !Number.isFinite(surface.time) || surface.time < 0 || !Number.isFinite(nowMs)
      || !Number.isInteger(vertices) || vertices < 0 || vertices > 600000 || vertices % 3 !== 0
      || !(surface.cellIds instanceof Uint32Array) || surface.cellIds.some(i => i >= cells)
      || !(surface.positions instanceof Float32Array) || !(surface.normals instanceof Float32Array) || surface.normals.length !== vertices * 3
      || !(surface.colors instanceof Float32Array) || surface.colors.length !== vertices * 4 || !(surface.uvs instanceof Float32Array) || surface.uvs.length !== vertices * 2
      || !(surface.flowData instanceof Float32Array) || surface.flowData.length !== vertices * 4
      || !(surface.patches instanceof Float32Array) || surface.patches.length !== 0 || surface.normalPatches !== undefined || surface.flowPatches !== undefined
      || !(boundary.triangleRegions instanceof Uint32Array) || boundary.triangleRegions.length !== vertices / 3 || boundary.triangleRegions.some(i => i >= boundary.regionCount)
      || !(boundary.vertexKeys instanceof Float64Array) || boundary.vertexKeys.length !== vertices || boundary.vertexKeys.some(i => !Number.isSafeInteger(i)||i < -1)
      || surface.stats?.cells !== cells || surface.stats.vertices !== vertices || surface.stats.triangles !== vertices / 3
      || !Number.isFinite(surface.stats.gridVolume) || surface.stats.gridVolume < 0)
      throw new Error('Invalid boundary water surface buffers.');
    if (surface.revision < this.revision) return;
    if (!trusted) for (const values of [surface.positions, surface.normals, surface.colors, surface.uvs, surface.flowData])
      if (values.some(value => !Number.isFinite(value))) throw new Error('Boundary water surface buffers must be finite.');
    // Only unchanged connected interior vertices receive stable keys. Clipped
    // shorelines, walls and dry transitions snap to the accepted geometry.
    const unchanged = trusted && surface.baseRevision === this.revision && !surface.cellIds.length && this.boundarySurface;
    if(unchanged){
      this.clock.value=surface.time;this.revision=surface.revision;this.stats={...surface.stats};
      // The geometry remains borrowed and unchanged, but consumers need the
      // current accepted frame even when no vertex requires an upload.
      this.boundarySurface={...this.boundarySurface!,revision:surface.revision,time:surface.time,baseRevision:surface.baseRevision,cellIds:surface.cellIds,stats:this.stats};return;
    }
    let interpolated=false;
    if (!unchanged) {
      const previous=this.boundarySurface,fromHeights=new Float32Array(vertices),fromNormals=surface.normals.slice(),fromFlows=surface.flowData.slice();
      const oldKeys=new Map<number,number>(),sameMesh=previous?.boundary?.meshRevision===boundary.meshRevision;
      if(sameMesh)for(let i=0;i<previous!.boundary!.vertexKeys.length;i++){const key=previous!.boundary!.vertexKeys[i];if(key>=0&&!oldKeys.has(key))oldKeys.set(key,i);}
      const alpha=this.duration?clamp((nowMs-this.began)/this.duration):1;
      const oldHeights=this.geometry.getAttribute('waterBodyFromHeight').array,oldNormals=this.geometry.getAttribute('waterBodyFromNormal').array,oldFlows=this.geometry.getAttribute('waterBodyFromFlow').array;
      for(let i=0;i<vertices;i++){
        const p=i*3,q=i*4,old=oldKeys.get(boundary.vertexKeys[i]);fromHeights[i]=surface.positions[p+1];
        if(old===undefined||!previous||!this.duration)continue;
        const op=old*3,oq=old*4,bed=surface.positions[p+1]-surface.flowData[q+3],height=oldHeights[old]*(1-alpha)+previous.positions[op+1]*alpha;
        // Even a mutable/untrusted packet with a reused revision cannot drag
        // a vertex horizontally or interpolate water beneath a raised bed.
        if(previous.positions[op]!==surface.positions[p]||previous.positions[op+2]!==surface.positions[p+2]||height<=bed+this.water.wetDepth)continue;
        fromHeights[i]=height;for(let axis=0;axis<3;axis++)fromNormals[p+axis]=oldNormals[op+axis]*(1-alpha)+previous.normals[op+axis]*alpha;
        for(let axis=0;axis<4;axis++)fromFlows[q+axis]=oldFlows[oq+axis]*(1-alpha)+previous.flowData![oq+axis]*alpha;interpolated=true;
      }
      if (this.geometry.getAttribute('position').count !== vertices) this.geometry.dispose();
      const upload = (name: string, values: Float32Array, size: number) => {
        let attribute = this.geometry.getAttribute(name) as BufferAttribute;
        if (attribute.array.length !== values.length) {
          attribute = new BufferAttribute(new Float32Array(values.length), size).setUsage(DynamicDrawUsage);
          this.geometry.setAttribute(name, attribute);
        }
        (attribute.array as Float32Array).set(values); attribute.clearUpdateRanges(); attribute.addUpdateRange(0, values.length); attribute.needsUpdate = true;
        return attribute.array as Float32Array;
      };
      const depth = new Float32Array(vertices);
      for (let i = 0; i < vertices; i++)depth[i] = surface.flowData[i * 4 + 3];
      const positions = upload('position', surface.positions, 3), normals = upload('normal', surface.normals, 3);
      const colors = upload('color', surface.colors, 4), uvs = upload('uv', surface.uvs, 2), flowData = upload('waterBodyFlow', surface.flowData, 4);
      upload('waterBodyFromHeight', fromHeights, 1); upload('waterBodyFromNormal', fromNormals, 3);
      upload('waterBodyFilmDepth', depth, 1); upload('waterBodyFromFlow', fromFlows, 4);
      // Zero contour flags retain full coverage; the actual triangles already
      // meet the true shoreline and collider footprint without shader clipping.
      upload('waterBodyContour', new Float32Array(vertices * 3), 3);
      this.geometry.setDrawRange(0, vertices);
      this.boundarySurface = { ...surface, positions, normals, colors, uvs, flowData,
        boundary: { ...boundary, triangleRegions: boundary.triangleRegions.slice(), vertexKeys: boundary.vertexKeys.slice() } };
    }
    this.mesh.visible = vertices > 0;this.boundaryInterpolating=interpolated; this.blend.value = interpolated?0:1; this.clock.value = surface.time;
    this.began = nowMs; this.revision = surface.revision; this.stats = { ...surface.stats };
  }
  private apply(surface: WaterBodySurfaceBuffers, nowMs: number, trusted: boolean): void {
    if (this.disposed) return;
    if (surface.boundary || this.water.boundaryCells) { this.applyBoundary(surface, nowMs, trusted); this.latestSurface=this.boundarySurface;return; }
    const n = this.water.columns * this.water.rows, vertices = n * VERTICES_PER_CELL;
    if (surface.waterRevision !== this.water.revision || !Number.isInteger(surface.revision) || surface.revision < 0 || !Number.isFinite(nowMs)
      || !Number.isFinite(surface.time) || !(surface.cellIds instanceof Uint32Array) || surface.cellIds.some(i => i >= n)
      || !(surface.positions instanceof Float32Array) || surface.positions.length !== vertices * 3 || !(surface.normals instanceof Float32Array) || surface.normals.length !== vertices * 3
      || !(surface.colors instanceof Float32Array) || surface.colors.length !== vertices * 4 || !(surface.uvs instanceof Float32Array) || surface.uvs.length !== vertices * 2
      || !(surface.patches instanceof Float32Array) || surface.patches.length !== n * PATCH_VALUES
      || (surface.normalPatches !== undefined && (!(surface.normalPatches instanceof Float32Array) || surface.normalPatches.length !== n * NORMAL_PATCH_VALUES))
      || (surface.flowData!==undefined&&(!(surface.flowData instanceof Float32Array)||surface.flowData.length!==vertices*4))
      || (surface.flowPatches!==undefined&&(!(surface.flowPatches instanceof Float32Array)||surface.flowPatches.length!==n*FLOW_PATCH_VALUES)))
      throw new Error('Invalid water body surface buffers.');
    if (surface.revision < this.revision) return;
    if (!trusted) for (const values of [surface.positions, surface.normals, surface.colors, surface.uvs, surface.patches, surface.normalPatches,surface.flowData,surface.flowPatches]) if (values?.some(v => !Number.isFinite(v))) throw new Error('Water body surface buffers must be finite.');
    const all = this.revision < 0 || surface.baseRevision !== this.revision, cells = all ? Uint32Array.from({ length: n }, (_, i) => i) : surface.cellIds;
    const position = this.geometry.getAttribute('position') as BufferAttribute, old = position.array as Float32Array;
    const from = this.geometry.getAttribute('waterBodyFromHeight') as BufferAttribute;
    const fromNormal = this.geometry.getAttribute('waterBodyFromNormal') as BufferAttribute, normal = this.geometry.getAttribute('normal') as BufferAttribute;
    const fromFlow=this.geometry.getAttribute('waterBodyFromFlow') as BufferAttribute,flow=this.geometry.getAttribute('waterBodyFlow') as BufferAttribute;
    if (!cells.length) {
      this.revision = surface.revision; this.stats = { ...surface.stats };
      this.latestSurface={...this.latestSurface!,revision:surface.revision,time:surface.time,baseRevision:surface.baseRevision,cellIds:surface.cellIds,stats:this.stats};return;
    }
    from.clearUpdateRanges();
    // Rebase every cell, including unchanged cells after a completed blend.
    // Otherwise restarting the shared clock can replay their stale transition.
    const blend = this.blend.value, fromHeights = from.array as Float32Array, fromNormals = fromNormal.array as Float32Array, fromFlows = fromFlow.array as Float32Array;
    const normals = normal.array as Float32Array, flows = flow.array as Float32Array;
    rebase(fromHeights, old, blend, 3, 1);
    from.addUpdateRange(0, vertices);
    rebase(fromNormals, normals, blend);
    fromNormal.clearUpdateRanges(); fromNormal.addUpdateRange(0, vertices * 3);
    rebase(fromFlows, flows, blend);
    fromFlow.clearUpdateRanges();fromFlow.addUpdateRange(0,vertices*4);
    const current = this.surfaceField.current.image.data as Float32Array, previous = this.surfaceField.previous.image.data as Float32Array;
    rebase(previous, current, blend);
    const normalCurrent = this.surfaceField.normalCurrent.image.data as Float32Array, normalPrevious = this.surfaceField.normalPrevious.image.data as Float32Array;
    rebase(normalPrevious, normalCurrent, blend);
    const flowCurrent=this.surfaceField.flowCurrent.image.data as Float32Array,flowPrevious=this.surfaceField.flowPrevious.image.data as Float32Array;
    rebase(flowPrevious, flowCurrent, blend);
    const topCorners = TOP_CORNERS, bedCorners = BED_CORNERS, rows = this.water.rows;
    const fieldOffset = (cell: number, component: number) => (Math.floor(cell / FIELD_WIDTH) * 3 * FIELD_WIDTH + cell % FIELD_WIDTH + Math.floor(component / 4) * FIELD_WIDTH) * 4 + component % 4;
    const normalOffset = (cell: number, component: number) => (Math.floor(cell / FIELD_WIDTH) * 4 * FIELD_WIDTH + cell % FIELD_WIDTH + Math.floor(component / 4) * FIELD_WIDTH) * 4 + component % 4;
    const cornerId = (cell: number, corner: number) => (Math.floor(cell / rows) + CORNER_X[corner]) * (rows + 1) + cell % rows + CORNER_Z[corner];
    const snapped = new Set<number>();
    const joins = new Map<number, { source: number; beforeTop: number; beforeBed: number; top: number; bed: number }[]>();
    const connectedAtCorner = (source: number, target: number, vertex: number) => {
      const gx = Math.floor(vertex / (rows + 1)), gz = vertex % (rows + 1), reached = [source];
      for (let at = 0; at < reached.length; at++) {
        const cell = reached[at]; if (cell === target) return true;
        const flags = current[fieldOffset(cell, 11)], x = Math.floor(cell / rows), z = cell % rows;
        if (flags < 16) continue;
        for (let edge = 0; edge < 4; edge++) if (flags & (1 << edge)) {
          const nx = x + EDGE_X[edge], nz = z + EDGE_Z[edge], next = nx * rows + nz;
          if (nx >= gx - 1 && nx <= gx && nz >= gz - 1 && nz <= gz && !reached.includes(next)) reached.push(next);
        }
      }
      return false;
    };
    const contour = this.geometry.getAttribute('waterBodyContour') as BufferAttribute, contours = contour.array as Float32Array;
    const positions = surface.positions, flowData = surface.flowData, flowPatches = surface.flowPatches, normalPatches = surface.normalPatches;
    const reach = Math.max(this.water.cellSizeX, this.water.cellSizeZ);
    for (const cell of cells) {
      // A clipped shore changing topology or a newly wet cell snaps together.
      // Only an unchanged horizontal footprint can interpolate its heights.
      let interpolate = this.revision >= 0;
      for (let v = cell * VERTICES_PER_CELL; v < (cell + 1) * VERTICES_PER_CELL; v++) {
        const k = v * 3;
        if (old[k] !== positions[k] || old[k + 2] !== positions[k + 2] || Math.abs(fromHeights[v] - positions[k + 1]) > reach) { interpolate = false; break; }
      }
      const texel = (Math.floor(cell / FIELD_WIDTH) * 3 * FIELD_WIDTH + cell % FIELD_WIDTH) * 4;
      if (current[texel + FIELD_WIDTH * 8 + 2] !== surface.patches[cell * PATCH_VALUES + 10] || current[texel + FIELD_WIDTH * 8 + 3] !== surface.patches[cell * PATCH_VALUES + 11]) interpolate = false;
      const cx=this.water.origin.x+Math.floor(cell/rows)*this.water.cellSizeX,cz=this.water.origin.z+cell%rows*this.water.cellSizeZ,edges=surface.patches[cell*PATCH_VALUES+11];
      for(let v=cell*VERTICES_PER_CELL;v<(cell+1)*VERTICES_PER_CELL;v++){contours[v*3]=cx;contours[v*3+1]=cz;contours[v*3+2]=edges;}
      contour.needsUpdate=true;
      if (!interpolate) {
        snapped.add(cell);
        for (let corner = 0; corner < 4; corner++) {
          const id = cornerId(cell, corner), entries = joins.get(id) ?? [];
          entries.push({ source: cell, beforeTop: previous[fieldOffset(cell, topCorners[corner])], beforeBed: previous[fieldOffset(cell, bedCorners[corner])],
            top: surface.patches[cell * PATCH_VALUES + topCorners[corner]], bed: surface.patches[cell * PATCH_VALUES + bedCorners[corner]] });
          joins.set(id, entries);
        }
      }
      for (let row = 0; row < 3; row++) for (let component = 0; component < 4; component++) {
        const at = texel + row * FIELD_WIDTH * 4 + component, value = surface.patches[cell * PATCH_VALUES + row * 4 + component];
        current[at] = value;
        if (!interpolate) previous[at] = value;
      }
      const first = cell * VERTICES_PER_CELL, last = first + VERTICES_PER_CELL;
      if (!interpolate) for (let v = first; v < last; v++) {
        fromHeights[v] = positions[v * 3 + 1];
        fromNormals[v * 3] = surface.normals[v * 3]; fromNormals[v * 3 + 1] = surface.normals[v * 3 + 1]; fromNormals[v * 3 + 2] = surface.normals[v * 3 + 2];
      }
      if (flowData) flows.set(flowData.subarray(first * 4, last * 4), first * 4); else flows.fill(0, first * 4, last * 4);
      if (!interpolate) fromFlows.set(flows.subarray(first * 4, last * 4), first * 4);
      for(let component=0;component<FLOW_PATCH_VALUES;component++){
        const at=(Math.floor(cell/FIELD_WIDTH)*5*FIELD_WIDTH+cell%FIELD_WIDTH+Math.floor(component/4)*FIELD_WIDTH)*4+component%4;
        flowCurrent[at]=flowPatches?.[cell*FLOW_PATCH_VALUES+component]??0;if(!interpolate)flowPrevious[at]=flowCurrent[at];
      }
      for (let component = 0; component < NORMAL_PATCH_VALUES; component++) {
        const at = normalOffset(cell, component);
        // Old replay packets have no normal atlas. Approximate their join with
        // a representative recorded top normal at each control point.
        const point = Math.floor(component / 3), axis = component % 3;
        const value = normalPatches?.[cell * NORMAL_PATCH_VALUES + component]
          ?? (component === 15 ? 0 : surface.normals[(cell * VERTICES_PER_CELL + (point ? 1 + (point - 1) * 3 : 0)) * 3 + axis]);
        normalCurrent[at] = value; if (!interpolate) normalPrevious[at] = value;
      }
    }
    // A shoreline or obstacle can change one cell's clipping topology while
    // its neighbor retains a stable footprint. Snapping only that cell leaves
    // their shared edge at two different heights until interpolation finishes.
    // Snap the shared control points together, retaining each neighbor's center
    // transition. Current wet connectivity also handles a newly wet neighbor;
    // height coincidence alone must never join separated pools across a wall.
    for (let cell = 0; cell < n && joins.size; cell++) {
      if (snapped.has(cell)) continue;
      let changed = false;
      for (let corner = 0; corner < 4; corner++) {
        const top = fieldOffset(cell, topCorners[corner]), bed = fieldOffset(cell, bedCorners[corner]);
        const vertex = cornerId(cell, corner);
        const joined = joins.get(vertex)?.find(join => join.top === current[top] && join.bed === current[bed]
          && (current[fieldOffset(cell, 11)] >= 16 ? connectedAtCorner(join.source, cell, vertex)
            : join.beforeTop === previous[top] && join.beforeBed === previous[bed]));
        if (joined && (previous[top] !== current[top] || previous[bed] !== current[bed])) {
          previous[top] = current[top]; previous[bed] = current[bed]; changed = true;
        }
        if (joined) for (let axis = 0; axis < 3; axis++) {
          const at = normalOffset(cell, (corner + 1) * 3 + axis);
          if (normalPrevious[at] !== normalCurrent[at]) { normalPrevious[at] = normalCurrent[at]; changed = true; }
        }
      }
      if (!changed) continue;
      const before = Array.from({ length: PATCH_VALUES }, (_, component) => previous[fieldOffset(cell, component)]);
      const after = Array.from({ length: PATCH_VALUES }, (_, component) => current[fieldOffset(cell, component)]);
      const normalBefore = Array.from({ length: NORMAL_PATCH_VALUES }, (_, component) => normalPrevious[normalOffset(cell, component)]);
      const ox = this.water.origin.x + Math.floor(cell / this.water.rows) * this.water.cellSizeX, oz = this.water.origin.z + cell % this.water.rows * this.water.cellSizeZ;
      for (let v = cell * VERTICES_PER_CELL; v < (cell + 1) * VERTICES_PER_CELL; v++) {
        // Unchanged cells still live in the retained attribute; changed cells
        // have not been uploaded yet. Their current packet is always complete.
        const k = v * 3, x = (surface.positions[k] - ox) / this.water.cellSizeX, z = (surface.positions[k + 2] - oz) / this.water.cellSizeZ;
        const top = patchHeight(after, 0, topCorners, x, z), bed = patchHeight(after, 5, bedCorners, x, z);
        // An interior drop can end at adjoining water between this cell's
        // own bed and top. Its previous displayed height was already rebased;
        // a topology snap on this side must not stretch that lower edge down
        // to terrain (or pull it up to the higher surface).
        if (v % VERTICES_PER_CELL >= 24 && Math.abs(surface.positions[k + 1] - bed) > 1e-6
          && Math.abs(surface.positions[k + 1] - top) > 1e-6) continue;
        const bottom = v % VERTICES_PER_CELL >= 24 && Math.abs(surface.positions[k + 1] - bed) < Math.abs(surface.positions[k + 1] - top);
        fromHeights[v] = bottom ? patchHeight(before, 5, bedCorners, x, z) : patchHeight(before, 0, topCorners, x, z);
        if (v % VERTICES_PER_CELL < 24) for (let axis = 0; axis < 3; axis++) fromNormals[k + axis] = patchHeight(normalBefore, axis, NORMAL_CORNERS[axis], x, z);
      }
    }
    this.surfaceField.previous.needsUpdate = this.surfaceField.current.needsUpdate = true;
    this.surfaceField.normalPrevious.needsUpdate = this.surfaceField.normalCurrent.needsUpdate = true;
    this.surfaceField.flowPrevious.needsUpdate=this.surfaceField.flowCurrent.needsUpdate=true;
    flow.clearUpdateRanges();for(const cell of cells)flow.addUpdateRange(cell*VERTICES_PER_CELL*4,VERTICES_PER_CELL*4);
    flow.needsUpdate=fromFlow.needsUpdate=true;
    const filmDepth = this.geometry.getAttribute('waterBodyFilmDepth') as BufferAttribute, films = filmDepth.array as Float32Array;filmDepth.clearUpdateRanges();
    for (const cell of cells) {
      const patch = surface.patches.subarray(cell * PATCH_VALUES, (cell + 1) * PATCH_VALUES);
      const ox = this.water.origin.x + Math.floor(cell / rows) * this.water.cellSizeX, oz = this.water.origin.z + cell % rows * this.water.cellSizeZ;
      for (let v = cell * VERTICES_PER_CELL; v < (cell + 1) * VERTICES_PER_CELL; v++) {
        const x = (positions[v * 3] - ox) / this.water.cellSizeX, z = (positions[v * 3 + 2] - oz) / this.water.cellSizeZ;
        films[v] = Math.max(0, positions[v * 3 + 1] - patchHeight(patch, 5, bedCorners, x, z));
      }
      filmDepth.addUpdateRange(cell * VERTICES_PER_CELL, VERTICES_PER_CELL);
    }
    filmDepth.needsUpdate = cells.length > 0;
    from.needsUpdate = cells.length > 0;
    fromNormal.needsUpdate = cells.length > 0;
    for (const [name, source, size] of [['position', surface.positions, 3], ['normal', surface.normals, 3], ['color', surface.colors, 4], ['uv', surface.uvs, 2]] as const) {
      const attribute = this.geometry.getAttribute(name) as BufferAttribute; attribute.clearUpdateRanges();
      for (const cell of cells) { const start = cell * VERTICES_PER_CELL * size, count = VERTICES_PER_CELL * size; attribute.array.set(source.subarray(start, start + count), start); attribute.addUpdateRange(start, count); }
      attribute.needsUpdate = cells.length > 0;
    }
    this.began = nowMs; this.blend.value = this.revision >= 0 && this.duration > 0 && cells.length > 0 ? 0 : 1;
    this.revision = surface.revision; this.stats = { ...surface.stats }; this.mesh.visible = surface.stats.wetCells > 0;
    this.latestSurface=surface;
  }
  animate(displaySeconds: number, nowMs = performance.now()): void {
    if (!Number.isFinite(displaySeconds) || !Number.isFinite(nowMs)) throw new Error('Water body animation times must be finite.');
    if (this.disposed) return;
    this.clock.value = displaySeconds; this.blend.value = this.water.boundaryCells&&!this.boundaryInterpolating?1:this.duration ? clamp((nowMs - this.began) / this.duration) : 1;
  }
  inspection(): WaterBodySurfaceStats & { revision: number; alpha: number; disposed: boolean } {
    return { ...(this.stats ?? { cells: this.water.columns * this.water.rows, wetCells: 0, rebuiltCells: 0, reusedCells: 0, vertices: 0, triangles: 0, gridVolume: 0, buildMs: 0 }), revision: this.revision, alpha: this.blend.value, disposed: this.disposed };
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.workspace.clear(); this.boundarySurface = undefined; this.geometry.dispose(); this.material.dispose(); this.regularField.current.dispose(); this.regularField.previous.dispose(); this.regularField.normalCurrent.dispose(); this.regularField.normalPrevious.dispose();this.regularField.flowCurrent.dispose();this.regularField.flowPrevious.dispose(); this.root.clear(); this.root.removeFromParent(); }
}
