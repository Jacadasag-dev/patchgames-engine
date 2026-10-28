/** Static, authored door states. Local +Z points into the owning room, +X is
 * right when looking out from that room; aperture centre/bottom is (0,0,0).
 * One immutable leaf model drives both its posed meshes and native colliders. */
import { createAssetCatalog, defineAssetFamily, transformAssetColliders, validateAssetManifest, type AssetManifest, type AssetPart } from './assetFamilies.ts';
import type { PhysicsCollider, PhysicsVector } from './physics.ts';
import { physicsShapeBounds } from './physicsGeometry.ts';
import { spatialAngle, spatialCoordinate as snap, transformSpatialPoint } from './spatial.ts';
import { resolveSurfaceMaterial, validateSurfaceMaterialInput, type ResolvedSurfaceMaterial, type SurfaceMaterialInput } from './surfaceMaterials.ts';

export interface BuildingDoorDesign {
  type?: 'hinged' | 'double-hinged' | 'sliding' | 'double-sliding';
  style?: 'flush' | 'panel' | 'window';
  /** Authored static pose; omitted means fully open. */
  open?: number;
  hinge?: 'left' | 'right';
  swing?: 'into-room' | 'away-from-room';
  thickness?: number;
  color?: string;
  material?: SurfaceMaterialInput;
  /** Exact per-leaf width/height; never scaled. Optional hinge-left/right sockets
   * override the derived hinge axis. Custom geometry is independent of style. */
  model?: AssetManifest;
  /** Decorative trim outside the clear aperture, over existing structural walls. */
  frame?: false | { width?: number; depth?: number; color?: string; material?: SurfaceMaterialInput };
}
export type BuildingDoorSelection = BuildingDoorDesign | { palette: { id: string; weight?: number; door: BuildingDoorDesign }[] };
export interface DoorGeometryPart {
  id: string; role: 'leaf' | 'frame'; position: PhysicsVector; size: PhysicsVector; yaw: number;
  color: string; model?: AssetManifest; material?: ResolvedSurfaceMaterial; collidable: boolean;
}
export interface DoorReservation { id: string; kind: 'swing' | 'slide'; x: number; z: number; width: number; depth: number }
export interface DoorGeometry {
  parts: DoorGeometryPart[]; colliders: PhysicsCollider[]; reservations: DoorReservation[];
  /** Largest unobstructed X interval under a conservative full-depth projection.
   * This is not a capsule sweep or a promise about room furniture/approach space. */
  currentClearWidth: number;
  /** Door-local X midpoint of that same conservative unobstructed interval. */
  currentClearCenter: number;
  type: NonNullable<BuildingDoorDesign['type']>; open: number;
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
const bounded = (v: unknown, low: number, high: number) => finite(v) && v >= low && v <= high;
const hex = (v: unknown): v is string => typeof v === 'string' && /^#[a-f\d]{6}$/i.test(v);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function hash(text: string): number { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); return (h ^ h >>> 15) >>> 0; }
function context(seed: number, key: string): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || typeof key !== 'string' || !key.length || key.length > 512) throw new Error('Door selection requires an unsigned seed and bounded stable key.');
}
function design(input: unknown): BuildingDoorDesign {
  if (!plain(input) || !keys(input, ['type', 'style', 'open', 'hinge', 'swing', 'thickness', 'color', 'material', 'model', 'frame']) || Object.values(input).some(value => value === null)) throw new Error('Door design requires supported plain fields.');
  const type = input.type ?? 'hinged', style = input.style ?? 'flush', open = input.open ?? 1, hinge = input.hinge ?? 'left', swing = input.swing ?? 'into-room', thickness = input.thickness ?? .06, color = input.color ?? '#856544';
  if (!['hinged', 'double-hinged', 'sliding', 'double-sliding'].includes(type as string) || !['flush', 'panel', 'window'].includes(style as string)
    || !bounded(open, 0, 1) || !['left', 'right'].includes(hinge as string) || !['into-room', 'away-from-room'].includes(swing as string)
    || !bounded(thickness, .04, .5) || !hex(color)) throw new Error('Door type, style, pose, thickness or color is invalid.');
  let frame: BuildingDoorDesign['frame'];
  if (input.frame === false) frame = false;
  else {
    const value = input.frame ?? {};
    if (!plain(value) || !keys(value, ['width', 'depth', 'color', 'material']) || Object.values(value).some(entry => entry === null) || !bounded(value.width ?? .07, .02, .5)
      || value.depth !== undefined && !bounded(value.depth, .04, 2) || value.color !== undefined && !hex(value.color)) throw new Error('Door frame needs bounded width/depth and a hexadecimal color.');
    frame = { width: value.width as number | undefined ?? .07, ...(value.depth === undefined ? {} : { depth: value.depth as number }), color: (value.color as string | undefined ?? color).toLowerCase(),
      ...(value.material === undefined ? {} : { material: validateSurfaceMaterialInput(value.material as SurfaceMaterialInput) }) };
  }
  return { type: type as BuildingDoorDesign['type'], style: style as BuildingDoorDesign['style'], open: open as number, hinge: hinge as BuildingDoorDesign['hinge'], swing: swing as BuildingDoorDesign['swing'], thickness: thickness as number,
    color: color.toLowerCase(), frame, ...(input.model === undefined ? {} : { model: validateAssetManifest(input.model as AssetManifest) }),
    ...(input.material === undefined ? {} : { material: validateSurfaceMaterialInput(input.material as SurfaceMaterialInput) }) };
}
/** Fresh editable policy data; immutable custom models retain validator identity. */
export function validateBuildingDoorSelection(input: unknown): BuildingDoorSelection {
  if (!plain(input)) throw new Error('Door selection requires plain data.');
  if (!('palette' in input)) return design(input);
  if (!keys(input, ['palette']) || !Array.isArray(input.palette) || !input.palette.length || input.palette.length > 32) throw new Error('Door palette requires one to 32 choices.');
  const ids = new Set<string>();
  return { palette: Array.from(input.palette, entry => {
    if (!plain(entry) || !keys(entry, ['id', 'weight', 'door']) || !id(entry.id) || ids.has(entry.id) || entry.weight === null || !bounded(entry.weight ?? 1, Number.MIN_VALUE, 1e6)) throw new Error('Door palette choices need unique IDs and positive bounded weights.');
    ids.add(entry.id); return { id: entry.id, weight: entry.weight as number | undefined ?? 1, door: design(entry.door) };
  }).sort((a, b) => compare(a.id, b.id)) };
}
export function resolveDoorSelection(input: BuildingDoorSelection, options: { seed: number; key: string }): { design: BuildingDoorDesign; variantId?: string } {
  context(options?.seed, options?.key);
  const selected = validateBuildingDoorSelection(input);
  if (!('palette' in selected)) return { design: selected };
  let roll = hash(`${options.seed}:${options.key}:door`) / 4294967296 * selected.palette.reduce((sum, item) => sum + item.weight!, 0);
  for (const item of selected.palette) { roll -= item.weight!; if (roll < 0) return { design: item.door, variantId: item.id }; }
  const last = selected.palette.at(-1)!; return { design: last.door, variantId: last.id };
}
/** Verbose alias for building policy adapters. */
export const resolveBuildingDoorSelection = resolveDoorSelection;
// A leaf depends only on these inputs, and compiling one building (often more
// than once while it is furnished and placed) regenerates the same leaves.
// Manifests are frozen, so reuse returns the same validated model.
const leaves = new Map<string, AssetManifest>();
function builtInLeaf(width: number, height: number, leaf: BuildingDoorDesign, hinge: 'left' | 'right', seed: number): AssetManifest {
  const key = `${width}|${height}|${leaf.style}|${leaf.thickness}|${leaf.color}|${hinge}|${seed}`, known = leaves.get(key);
  if (known) return known;
  const model = generateLeaf(width, height, leaf, hinge, seed);
  if (leaves.size >= 256) leaves.delete(leaves.keys().next().value!);
  leaves.set(key, model); return model;
}
function generateLeaf(width: number, height: number, leaf: BuildingDoorDesign, hinge: 'left' | 'right', seed: number): AssetManifest {
  const thickness = leaf.thickness!, color = leaf.color!, parts: AssetPart[] = [];
  const box = (id: string, x: number, y: number, z: number, w: number, h: number, d: number, collision = true, finish = color) => parts.push({ id, shape: 'box', position: { x: snap(x), y: snap(y), z: snap(z) }, size: { x: snap(w), y: snap(h), z: snap(d) }, color: finish, collision });
  if (leaf.style === 'window') {
    const side = Math.max(.04, width * .14), bottom = height * .45, top = height * .12, middle = height - bottom - top;
    box('lower', 0, bottom / 2, 0, width, bottom, thickness);
    box('upper', 0, height - top / 2, 0, width, top, thickness);
    for (const sign of [-1, 1]) box(`stile-${sign}`, sign * (width - side) / 2, bottom + middle / 2, 0, side, middle, thickness);
  } else box('leaf', 0, height / 2, 0, width, height, thickness);
  if (leaf.style === 'panel') for (const face of [-1, 1]) for (const row of [0, 1]) box(`panel-${face}-${row}`, 0, height * (.25 + row * .5), face * (thickness / 2 + .007), width * .72, height * .32, .014, false);
  for (const face of [-1, 1]) box(`handle-${face}`, (hinge === 'left' ? 1 : -1) * (width / 2 - .09), Math.min(1, height * .3), face * (thickness / 2 + .025), .07, .07, .05, false, '#a8a399');
  const family = defineAssetFamily({ id: 'building-door-leaf', version: '1', parameters: {}, generate: () => ({ parts }) });
  return createAssetCatalog([family], { maxVariants: 1 }).resolve(family.id, { seed, instanceId: 'leaf' });
}
function boundsAt(model: AssetManifest, x: number, z: number, yaw: number) {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  const w = c * model.size.x + s * model.size.z, d = s * model.size.x + c * model.size.z;
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
}
function clearance(width: number, colliders: PhysicsCollider[]): { currentClearWidth: number; currentClearCenter: number } {
  const spans = colliders.map(collider => {
    if (collider.shape.kind === 'convex' || collider.shape.kind === 'capsule') {
      const { min, max } = physicsShapeBounds(collider.shape, collider.rotation);
      return { low: Math.max(-width / 2, collider.position.x + min.x), high: Math.min(width / 2, collider.position.x + max.x) };
    }
    const q = collider.rotation ?? { x: 0, y: 0, z: 0, w: 1 }, c = 1 - 2 * q.y * q.y, s = 2 * q.y * q.w;
    const extent = collider.shape.kind === 'ball' ? collider.shape.radius : collider.shape.kind === 'box' ? Math.abs(c) * collider.shape.halfExtents.x + Math.abs(s) * collider.shape.halfExtents.z : 0;
    return { low: Math.max(-width / 2, collider.position.x - extent), high: Math.min(width / 2, collider.position.x + extent) };
  }).filter(span => span.high > span.low).sort((a, b) => a.low - b.low);
  let left = -width / 2, best = 0, center = 0;
  for (const span of spans) {
    if (span.low - left > best) { best = span.low - left; center = (span.low + left) / 2; }
    left = Math.max(left, span.high);
  }
  if (width / 2 - left > best) { best = width / 2 - left; center = (width / 2 + left) / 2; }
  return { currentClearWidth: snap(best), currentClearCenter: snap(center) };
}
export function compileDoorGeometry(input: { id: string; width: number; height: number; wallThickness: number; design: BuildingDoorDesign; seed?: number }): DoorGeometry {
  if (!plain(input) || !keys(input, ['id', 'width', 'height', 'wallThickness', 'design', 'seed']) || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(input.id) || input.seed === null
    || !bounded(input.width, .4, 32) || !bounded(input.height, .5, 32) || !bounded(input.wallThickness, .04, 2)) throw new Error('Door geometry requires bounded aperture dimensions, wall thickness and a stable ID.');
  const seed = input.seed ?? 0; context(seed, input.id);
  const selected = design(input.design), type = selected.type!, open = selected.open!, count = type.startsWith('double-') ? 2 : 1, width = input.width / count;
  if (width < .2 || selected.thickness! > width) throw new Error('Door leaves must be wider than their thickness.');
  const sliding = type.includes('sliding'), direction = selected.swing === 'into-room' ? 1 : -1;
  const parts: DoorGeometryPart[] = [], colliders: PhysicsCollider[] = [], reservations: DoorReservation[] = [];
  const surface = selected.material ? resolveSurfaceMaterial(selected.material, { seed, key: `${input.id}:leaf` }) : undefined;
  for (let index = 0; index < count; index++) {
    const hinge = count === 2 ? index === 0 ? 'left' : 'right' : selected.hinge!;
    const side = hinge === 'left' ? -1 : 1, center = count === 2 ? side * width / 2 : 0;
    const model = selected.model ?? builtInLeaf(width, input.height, selected, hinge, seed);
    if (Math.abs(model.size.x - width) > 1e-6 || Math.abs(model.size.y - input.height) > 1e-6 || model.size.z > 2 || !model.colliders.length) throw new Error('Door model must exactly match each leaf width/height, fit depth <=2m and provide physical collision.');
    const leafId = `${input.id}:leaf:${index}`;
    let at: { x: number; z: number }, yaw = 0, reservation: Omit<DoorReservation, 'id' | 'kind'>;
    if (sliding) {
      const z = direction * (input.wallThickness / 2 + model.size.z / 2 + .01), travel = width + .02;
      at = { x: snap(center + side * travel * open), z: snap(z) };
      reservation = { x: snap(center + side * travel / 2), z: snap(z), width: snap(model.size.x + travel), depth: snap(model.size.z) };
    } else {
      const socket = selected.model?.sockets.find(socket => socket.id === `hinge-${hinge}`);
      const pivot = socket?.position ?? { x: side * width / 2, y: 0, z: direction * (selected.model ? model.size.z : selected.thickness!) / 2 };
      if (Math.abs(pivot.x - side * width / 2) > .001 || Math.abs(pivot.z) > model.size.z / 2 + .001 || pivot.y < 0 || pivot.y > input.height) throw new Error('Custom hinge socket must lie on the corresponding leaf edge within its depth/height.');
      const turn = side * direction * Math.PI / 2, pose = (fraction: number) => {
        const angle = fraction * turn, rotated = transformSpatialPoint({ x: -pivot.x, z: -pivot.z }, { x: center + pivot.x, z: pivot.z }, angle);
        return { ...rotated, yaw: spatialAngle(angle) };
      };
      const current = pose(open); at = current; yaw = current.yaw;
      // Enclose each swept corner analytically, including its interior extrema;
      // a few sampled poses would under-reserve the middle of the swing arc.
      const min = { x: Infinity, z: Infinity }, max = { x: -Infinity, z: -Infinity };
      for (const x of [-model.size.x / 2, model.size.x / 2]) for (const z of [-model.size.z / 2, model.size.z / 2]) {
        const dx = x - pivot.x, dz = z - pivot.z, angles = [0, turn];
        for (const base of [Math.atan2(dz, dx), Math.atan2(-dx, dz)]) for (let k = -2; k <= 2; k++) {
          const angle = base + k * Math.PI; if (angle >= Math.min(0, turn) && angle <= Math.max(0, turn)) angles.push(angle);
        }
        for (const angle of angles) {
          const point = transformSpatialPoint({ x: dx, z: dz }, { x: center + pivot.x, z: pivot.z }, angle);
          min.x = Math.min(min.x, point.x); max.x = Math.max(max.x, point.x); min.z = Math.min(min.z, point.z); max.z = Math.max(max.z, point.z);
        }
      }
      reservation = { x: snap((min.x + max.x) / 2), z: snap((min.z + max.z) / 2), width: snap(max.x - min.x), depth: snap(max.z - min.z) };
    }
    // Final pose metadata and compound collision share the same snapped anchor.
    const origin = { x: at.x, y: 0, z: at.z };
    parts.push({ id: leafId, role: 'leaf', position: { ...origin, y: snap(input.height / 2) }, size: { ...model.size }, yaw, color: selected.color!, model, collidable: true, ...(surface ? { material: surface } : {}) });
    colliders.push(...transformAssetColliders(model, origin, yaw).map(collider => ({ ...collider,
      position: { x: snap(collider.position.x), y: snap(collider.position.y), z: snap(collider.position.z) },
      rotation: { x: spatialAngle(collider.rotation!.x), y: spatialAngle(collider.rotation!.y), z: spatialAngle(collider.rotation!.z), w: spatialAngle(collider.rotation!.w) } })));
    reservations.push({ id: `${input.id}:${index}`, kind: sliding ? 'slide' : 'swing', ...reservation });
    const final = boundsAt(model, at.x, at.z, yaw);
    if ([final.minX, final.maxX, final.minZ, final.maxZ].some(value => Math.abs(value) > 64)) throw new Error('Door pose exceeds its local geometry budget.');
  }
  if (selected.frame !== false) {
    const frame = selected.frame!, w = frame.width!, depth = frame.depth ?? input.wallThickness + .04;
    const material = frame.material ? resolveSurfaceMaterial(frame.material, { seed, key: `${input.id}:frame` }) : undefined;
    for (const [name, x, y, width, height] of [['left', -(input.width + w) / 2, input.height / 2, w, input.height],
      ['right', (input.width + w) / 2, input.height / 2, w, input.height], ['top', 0, input.height + w / 2, input.width + w * 2, w]] as const) {
      parts.push({ id: `${input.id}:frame:${name}`, role: 'frame', position: { x: snap(x), y: snap(y), z: 0 }, size: { x: snap(width), y: snap(height), z: snap(depth) }, yaw: 0, color: frame.color!, collidable: false, ...(material ? { material } : {}) });
    }
  }
  return { parts, colliders, reservations, ...clearance(input.width, colliders), type, open };
}
