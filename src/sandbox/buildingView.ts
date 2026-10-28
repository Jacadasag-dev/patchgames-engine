import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Color, Group, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3, type SpotLight } from 'three';
import type { BuildingManifest, BuildingMaterialPatch, BuildingPart, BuildingRoom } from './building.ts';
import { LightingRig, type SpotLightOptions } from './lighting.ts';
import { AssetFamilyViewCache } from './assetFamilyView.ts';
import { SurfaceMaterialCache, type SurfaceMaterialCacheOptions } from './surfaceMaterialView.ts';
import type { ResolvedSurfaceMaterial } from './surfaceMaterials.ts';

export interface BuildingLightSource extends SpotLightOptions {
  buildingId: string;
  /** Omit for an exterior fixture. Coordinates share the manifest's world space. */
  roomId?: string;
}
export interface BuildingPartView {
  /** Centred in the part's local space; the host supplies position and rotation. */
  object: Object3D;
  /** Called once on room unload or view disposal. Own any custom GPU resources here. */
  dispose(): void;
  /** Standalone procedural furniture can wait for its material recipes. */
  readyMaterials?(): Promise<void>;
}
export interface BuildingWorldViewOptions {
  /** Near buildings may retain interiors. Exterior shells always remain present. */
  activationDistance?: number;
  /** Distance from a building's bounds at which its interiors are first created. */
  interiorDistance?: number;
  /** Additional distance before a resident building/interior is released. */
  hysteresis?: number;
  maxActiveBuildings?: number;
  /** One budget across this entire view, not a budget per building. Maximum 64. */
  maxLights?: number;
  maxShadowLights?: number;
  shadowMapSize?: 512 | 1024 | 2048;
  lightSources?: readonly BuildingLightSource[];
  /** Include compiled fixture emitters in the shared light pool; default true. */
  fixtureLights?: boolean;
  /** Share texture/material work across terrain, assets and buildings. */
  materialCache?: SurfaceMaterialCache;
  materialOptions?: SurfaceMaterialCacheOptions;
  /** Optional original/imported geometry. Undefined uses the compiler's exact part geometry. */
  partFactory?: (part: Readonly<BuildingPart>, building: Readonly<BuildingManifest>) => BuildingPartView | undefined;
}
export interface BuildingCutaway {
  /** A selected building receives activation priority, including from an overhead
   * camera. Omit for a distance-limited cutaway of every nearby building. */
  buildingId?: string;
  /** Manifest-space floor elevation. Defaults to the building's lowest room floor. */
  floorY?: number;
  /** Default walls are shortened to this height above floorY; defaults to 1.1m. */
  wallHeight?: number;
  /** Retain box-wall footprints this high above each lower storey's floor.
   * Defaults to 0 (hidden); convex/custom lower walls remain hidden. */
  lowerWallHeight?: number;
}

type Point = Readonly<{ x: number; y: number; z: number }>;
interface RenderedPart { part: BuildingPart; object: Group; mesh?: Mesh; release(): void }
interface Interior { root: Group; parts: RenderedPart[] }
interface BuildingState {
  manifest: BuildingManifest;
  root: Group;
  exterior: RenderedPart[];
  interiorParts: Map<string, BuildingPart[]>;
  interiors: Map<string, Interior>;
  active: boolean;
  resident: boolean;
  distance: number;
  rooms: Set<string>;
  cutawayRevision: number;
}
interface MaterialEntry { material: MeshStandardMaterial; references: number }
interface ActiveLight { source: BuildingLightSource; light: SpotLight }
type BoxFactory = (size: readonly [number, number, number], at: readonly [number, number, number], color: string) => Mesh;
const unassigned = '';
const byId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function finitePoint(point: Point): boolean { return [point.x, point.y, point.z].every(Number.isFinite); }
function distanceToBounds(point: Point, bounds: BuildingManifest['bounds']): number {
  return Math.hypot(Math.max(bounds.min.x - point.x, 0, point.x - bounds.max.x),
    Math.max(bounds.min.y - point.y, 0, point.y - bounds.max.y), Math.max(bounds.min.z - point.z, 0, point.z - bounds.max.z));
}
function contains(room: BuildingRoom, point: Point): boolean {
  const dx = point.x - room.center.x, dz = point.z - room.center.z, c = Math.cos(room.yaw), s = Math.sin(room.yaw);
  const x = dx * c - dz * s, z = dx * s + dz * c;
  return (room.footprint ?? [{ x: 0, z: 0, width: room.size.x, depth: room.size.z }]).some(rectangle => Math.abs(x - rectangle.x) <= rectangle.width / 2 + .02
    && Math.abs(z - rectangle.z) <= rectangle.depth / 2 + .02) && Math.abs(point.y - room.center.y) <= room.size.y / 2 + .05;
}
function numberOption(value: number | undefined, fallback: number, name: string, min: number, max: number, integer = false): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < min || result > max || integer && !Number.isInteger(result))
    throw new Error(`BuildingWorldView ${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  return result;
}

type FaceRect = { minU: number; maxU: number; minV: number; maxV: number };
/** Unit positions retain the existing cutaway transform; UVs measure the actual
 * face in metres. Face partitions replace base triangles, avoiding coplanar
 * overlays and never filling a doorway or a hole absent from the source box. */
function materialBoxGeometry(size: readonly [number, number, number], patches: readonly BuildingMaterialPatch[], materialIndex: (patch: BuildingMaterialPatch) => number): BufferGeometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [], geometry = new BufferGeometry();
  const [x, y, z] = size;
  const overlap = (a: FaceRect, b: FaceRect) => ({ minU: Math.max(a.minU, b.minU), maxU: Math.min(a.maxU, b.maxU), minV: Math.max(a.minV, b.minV), maxV: Math.min(a.maxV, b.maxV) });
  const usable = (r: FaceRect) => r.maxU - r.minU > 1e-8 && r.maxV - r.minV > 1e-8;
  for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const) {
    const axis = face[1], positive = face[0] === 'p', width = axis === 'x' ? z : x, height = axis === 'y' ? z : y;
    const full: FaceRect = { minU: -width / 2, maxU: width / 2, minV: -height / 2, maxV: height / 2 };
    const emit = (r: FaceRect, index: number, offsetU = 0, offsetV = 0) => {
      if (!usable(r)) return;
      const start = positions.length / 3, sign = positive ? 1 : -1;
      for (const [u, v] of [[r.minU, r.minV], [r.maxU, r.minV], [r.maxU, r.maxV], [r.minU, r.maxV]]) {
        positions.push(...(axis === 'x' ? [sign / 2, v / y, u / z] : axis === 'y' ? [u / x, sign / 2, v / z] : [u / x, v / y, sign / 2]));
        normals.push(...(axis === 'x' ? [sign, 0, 0] : axis === 'y' ? [0, sign, 0] : [0, 0, sign]));
        uvs.push(u + offsetU, v + offsetV);
      }
      const reverse = axis === 'z' ? !positive : positive, order = reverse ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      geometry.addGroup(indices.length, 6, index); indices.push(...order.map(i => start + i));
    };
    let remaining = [full];
    for (const patch of patches.filter(p => p.face === face)) {
      const cut = overlap(full, patch); if (!usable(cut)) continue;
      const next: FaceRect[] = [];
      for (const current of remaining) {
        const clipped = overlap(current, cut);
        if (!usable(clipped)) { next.push(current); continue; }
        emit(clipped, materialIndex(patch), patch.offsetU, patch.offsetV);
        next.push(...[
          { ...current, maxU: clipped.minU }, { ...current, minU: clipped.maxU },
          { minU: clipped.minU, maxU: clipped.maxU, minV: current.minV, maxV: clipped.minV },
          { minU: clipped.minU, maxU: clipped.maxU, minV: clipped.maxV, maxV: current.maxV },
        ].filter(usable));
      }
      remaining = next;
    }
    for (const rest of remaining) emit(rest, 0);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); return geometry;
}

/** Compiler-owned convex surfaces are already in physical part-local units.
 * Separate triangle vertices preserve sharp architectural edges; dominant-face
 * UV projection keeps their textures in the same metre units as box parts. */
function architecturalGeometry(source: NonNullable<BuildingPart['geometry']>): BufferGeometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), edge = new Vector3(), normal = new Vector3();
  for (let index = 0; index < source.indices.length; index += 3) {
    a.copy(source.vertices[source.indices[index]]); b.copy(source.vertices[source.indices[index + 1]]); c.copy(source.vertices[source.indices[index + 2]]);
    normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize();
    const x = Math.abs(normal.x), y = Math.abs(normal.y), z = Math.abs(normal.z);
    for (const vertex of [a, b, c]) {
      positions.push(vertex.x, vertex.y, vertex.z); normals.push(normal.x, normal.y, normal.z);
      uvs.push(...(x >= y && x >= z ? [vertex.z, vertex.y] : y >= z ? [vertex.x, vertex.z] : [vertex.x, vertex.y]));
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return geometry;
}

export interface BuildingBoxAppearance {
  /** Physical, centred part-local coordinates with the original UVs/groups. */
  geometry: BufferGeometry;
  materials: MeshStandardMaterial[];
  readyMaterials(): Promise<void>;
  dispose(): void;
}

/** Shared appearance preparation for fracture renderers. Only the compiler's
 * actual box surfaces are supported; models/furniture need their own geometry.
 * Material patches use exactly the same face partitioning as the intact view. */
export function createBuildingBoxAppearance(part: Readonly<BuildingPart>,
  options: Pick<BuildingWorldViewOptions, 'materialCache' | 'materialOptions'> = {}): BuildingBoxAppearance {
  if (part.model || part.geometry || part.kind === 'furniture') throw new Error('Fracture appearance requires a compiled box part, not convex geometry, a model or furniture wrapper.');
  const cache = options.materialCache ?? new SurfaceMaterialCache(options.materialOptions), ownsCache = !options.materialCache;
  const handles = new Map<string, ReturnType<SurfaceMaterialCache['acquire']>>();
  const fallback = new MeshStandardMaterial({ color: part.color, roughness: .85 });
  const colors = new Map<string, MeshStandardMaterial>([[part.color, fallback]]);
  let geometry: BufferGeometry | undefined, disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true; geometry?.dispose();
    for (const material of colors.values()) material.dispose();
    for (const handle of handles.values()) handle.dispose(); if (ownsCache) cache.dispose();
  };
  try {
    const acquire = (surface: ResolvedSurfaceMaterial) => {
      let handle = handles.get(surface.key); if (!handle) { handle = cache.acquire(surface); handles.set(surface.key, handle); }
      return handle.material;
    };
    const acquireColor = (color: string) => {
      let material = colors.get(color);
      if (!material) { material = new MeshStandardMaterial({ color, roughness: .85 }); colors.set(color, material); }
      return material;
    };
    const materials = [part.material ? acquire(part.material) : fallback];
    if (part.material || part.materialPatches?.length) {
      geometry = materialBoxGeometry([part.size.x, part.size.y, part.size.z], part.materialPatches ?? [], patch => {
        const material = patch.material ? acquire(patch.material) : acquireColor(patch.color), index = materials.indexOf(material);
        if (index >= 0) return index; materials.push(material); return materials.length - 1;
      });
      geometry.scale(part.size.x, part.size.y, part.size.z);
    } else { geometry = new BoxGeometry(part.size.x, part.size.y, part.size.z); geometry.clearGroups(); }
    return { geometry, materials, readyMaterials: () => cache.ready(), dispose };
  } catch (error) { dispose(); throw error; }
}

/** Small editable furniture examples. All pieces stay within the compiler's
 * authored box envelope; they add presentation detail, never new collision. */
function furnitureObject(part: Readonly<BuildingPart>, box: BoxFactory): Group | undefined {
  if (part.kind !== 'furniture' || !['table', 'chair', 'shelf', 'bed', 'counter', 'sofa', 'planter'].includes(part.asset ?? '')) return;
  const root = new Group(), { x: w, y: h, z: d } = part.size, color = part.color;
  const dark = `#${new Color(color).multiplyScalar(.55).getHexString()}`;
  const light = `#${new Color(color).lerp(new Color('#ffffff'), .22).getHexString()}`;
  const add = (size: readonly [number, number, number], at: readonly [number, number, number], tint = color) => root.add(box(size, at, tint));
  const legs = (top: number) => {
    const thickness = Math.min(w, d) * .13, height = top + h / 2;
    for (const x of [-1, 1]) for (const z of [-1, 1]) add([thickness, height, thickness],
      [x * (w / 2 - thickness / 2), -h / 2 + height / 2, z * (d / 2 - thickness / 2)], dark);
  };
  if (part.asset === 'table') {
    const thickness = h * .1; add([w, thickness, d], [0, h / 2 - thickness / 2, 0]); legs(h / 2 - thickness);
  } else if (part.asset === 'chair') {
    add([w, h * .1, d], [0, 0, 0]); legs(-h * .05);
    add([w, h * .45, d * .13], [0, h * .275, -d * .435], light);
  } else if (part.asset === 'shelf') {
    for (const side of [-1, 1]) add([w * .08, h, d], [side * w * .46, 0, 0], dark);
    add([w * .84, h, d * .08], [0, 0, -d * .46], dark);
    for (let level = 0; level <= 3; level++) add([w * .84, h * .06, d], [0, -h * .47 + level * h * .94 / 3, 0]);
    // One quiet book cluster makes shelf depth readable while preserving clearance.
    for (let index = 0; index < 3; index++) add([w * .1, h * .2, d * .55],
      [-w * .25 + index * w * .12, -h * .34, -d * .08], index % 2 ? light : color);
  } else if (part.asset === 'bed') {
    add([w, h * .24, d], [0, -h * .38, 0], dark);
    add([w * .94, h * .27, d * .93], [0, -h * .125, d * .015], light);
    add([w, h, d * .07], [0, 0, -d * .465], dark);
    add([w * .65, h * .1, d * .16], [0, h * .06, -d * .29], '#e8dfd1');
  } else if (part.asset === 'counter') {
    add([w * .94, h * .9, d * .94], [0, -h * .05, 0], dark);
    add([w, h * .1, d], [0, h * .45, 0], light);
  } else if (part.asset === 'sofa') {
    add([w, h * .3, d], [0, -h * .35, 0], dark);
    add([w, h * .7, d * .18], [0, h * .15, -d * .41]);
    for (const side of [-1, 1]) add([w * .12, h * .55, d], [side * w * .44, -h * .025, 0]);
    for (const side of [-1, 1]) add([w * .37, h * .15, d * .8], [side * w * .19, -h * .125, d * .08], light);
  } else {
    add([w * .7, h * .45, d * .7], [0, -h * .275, 0]);
    add([w * .78, h * .08, d * .78], [0, -h * .01, 0], dark);
    add([w * .23, h * .45, d * .25], [-w * .2, h * .275, 0], '#527452');
    add([w * .25, h * .35, d * .4], [w * .16, h * .225, d * .1], '#68865b');
  }
  return root;
}

/** Standalone editable furniture factory for custom partFactory composition.
 * BuildingWorldView uses the same recipes with its shared resource cache. */
export function createBuildingFurniture(part: Readonly<BuildingPart>, options: Pick<BuildingWorldViewOptions, 'materialCache' | 'materialOptions'> = {}): BuildingPartView | undefined {
  // Architectural leaves/frames retain their compiler geometry, even when a
  // custom door model happens to use a furniture-family asset identifier.
  if (part.kind !== 'furniture') return;
  const cache = part.material ? options.materialCache ?? new SurfaceMaterialCache(options.materialOptions) : undefined;
  const handle = part.material ? cache!.acquire(part.material) : undefined, geometries: BufferGeometry[] = [];
  const geometry = new BoxGeometry(1, 1, 1), materials = new Map<string, MeshStandardMaterial>();
  const object = furnitureObject(part, (size, at, color) => {
    let material = materials.get(color);
    if (!material) { material = new MeshStandardMaterial({ color, roughness: .85 }); materials.set(color, material); }
    const shape = handle ? materialBoxGeometry(size, [], () => 0) : geometry;
    if (handle) geometries.push(shape);
    const mesh = new Mesh(shape, handle?.material ?? material); mesh.scale.set(...size); mesh.position.set(...at); mesh.castShadow = mesh.receiveShadow = true; return mesh;
  });
  if (!object) { geometry.dispose(); handle?.dispose(); if (!options.materialCache) cache?.dispose(); return; }
  let disposed = false;
  return { object, readyMaterials: async () => { await cache?.ready(); }, dispose: () => {
    if (disposed) return; disposed = true; geometry.dispose(); for (const material of materials.values()) material.dispose();
    for (const shape of geometries) shape.dispose(); handle?.dispose(); if (!options.materialCache) cache?.dispose();
  } };
}

/** Presentation for the compiler's accepted parts. No second floor-plan or
 * collider solver lives here. Call update once per frame with the gameplay
 * camera/player; no timers, per-object loops or simulation authority are added.
 *
 * Interior visibility is deliberately conservative: all rooms connected by
 * door/window/stair portals remain resident. From outside, every exterior portal
 * seeds the search, so looking through a nearby window does not erase its room.
 * This is distance activation and portal connectivity, not GPU/wall occlusion.
 * Distances/cutaway heights are in manifest units even under a transformed root.
 */
export class BuildingWorldView {
  readonly root = new Group();
  private readonly geometry: BoxGeometry;
  private readonly materials = new Map<string, MaterialEntry>();
  private readonly assetViews: AssetFamilyViewCache;
  private readonly materialCache: SurfaceMaterialCache;
  private readonly ownsMaterialCache: boolean;
  private readonly buildings: BuildingState[] = [];
  private readonly buildingById = new Map<string, BuildingState>();
  private readonly options: BuildingWorldViewOptions;
  private readonly activationDistance: number;
  private readonly interiorDistance: number;
  private readonly hysteresis: number;
  private readonly maxActiveBuildings: number;
  private readonly maxLights: number;
  private readonly lighting: LightingRig;
  private readonly lights = new Map<string, ActiveLight>();
  private readonly lightSources: readonly BuildingLightSource[];
  private readonly localFocus = new Vector3();
  private readonly worldFocus = new Vector3();
  private cutaway: BuildingCutaway | null = null;
  private cutawayRevision = 0;
  private disposed = false;
  private createdInteriors = 0;
  private releasedInteriors = 0;
  private eligibleLights = 0;
  private omittedBuildings = 0;
  private hasFocus = false;

  constructor(manifests: readonly BuildingManifest[], options: BuildingWorldViewOptions = {}) {
    this.options = { ...options };
    if (manifests.length > 256) throw new Error('BuildingWorldView supports at most 256 buildings.');
    this.activationDistance = numberOption(options.activationDistance, 96, 'activationDistance', 0, 100_000);
    this.interiorDistance = numberOption(options.interiorDistance, Math.min(32, this.activationDistance), 'interiorDistance', 0, this.activationDistance);
    this.hysteresis = numberOption(options.hysteresis, 8, 'hysteresis', 0, 10_000);
    this.maxActiveBuildings = numberOption(options.maxActiveBuildings, 12, 'maxActiveBuildings', 0, 256, true);
    this.maxLights = numberOption(options.maxLights, 16, 'maxLights', 0, 64, true);
    this.ownsMaterialCache = !options.materialCache;
    this.materialCache = options.materialCache ?? new SurfaceMaterialCache(options.materialOptions);
    this.assetViews = new AssetFamilyViewCache({ materialCache: this.materialCache });
    this.root.name = 'building-world';
    this.lighting = new LightingRig(this.root, { maxShadowLights: options.maxShadowLights ?? 4, shadowMapSize: options.shadowMapSize });
    this.geometry = new BoxGeometry(1, 1, 1);
    this.lightSources = [];
    try {
      const sources = [...(options.fixtureLights === false ? [] : manifests.flatMap(manifest => manifest.lights ?? [])), ...(options.lightSources ?? [])];
      if (sources.length > 4096) throw new Error('BuildingWorldView supports at most 4096 light sources.');
      this.lightSources = sources.map(source => ({ ...source, position: [...source.position], target: [...source.target],
        color: source.color instanceof Color ? source.color.clone() : source.color }));
      const ids = new Set<string>();
      for (const manifest of manifests) {
        if (!manifest.diagnostics.valid) throw new Error(`BuildingWorldView requires a valid manifest: ${manifest.id}`);
        if (ids.has(manifest.id)) throw new Error(`Duplicate building ID: ${manifest.id}`);
        ids.add(manifest.id);
        const root = new Group(); root.name = `building:${manifest.id}`; this.root.add(root);
        const state: BuildingState = { manifest, root, exterior: [], interiorParts: new Map(), interiors: new Map(),
          active: false, resident: false, distance: Infinity, rooms: new Set(), cutawayRevision: -1 };
        this.buildings.push(state); this.buildingById.set(manifest.id, state);
        for (const part of manifest.parts) {
          if (!part.visible) continue;
          if (part.exterior) { const rendered = this.createPart(part, state); root.add(rendered.object); state.exterior.push(rendered); }
          else {
            const key = part.roomId ?? unassigned;
            const parts = state.interiorParts.get(key) ?? []; parts.push(part); state.interiorParts.set(key, parts);
          }
        }
      }
      this.buildings.sort((a, b) => byId(a.manifest.id, b.manifest.id));
      const lightIds = new Set<string>();
      // Validate every source with the existing light contract, including sources
      // that will first become active much later. Temporary fixtures are released.
      for (const source of this.lightSources) {
        if (!ids.has(source.buildingId)) throw new Error(`Unknown light building: ${source.buildingId}`);
        const building = this.buildingById.get(source.buildingId)!;
        if (source.roomId && !building.manifest.rooms.some(room => room.id === source.roomId)) throw new Error(`Unknown light room: ${source.roomId}`);
        const key = this.lightKey(source);
        if (lightIds.has(key)) throw new Error(`Duplicate building light: ${key}`);
        lightIds.add(key); this.lighting.addSpot(source); this.lighting.remove(source.id);
      }
    } catch (error) { this.dispose(); throw error; }
  }

  private lightKey(source: BuildingLightSource): string { return JSON.stringify([source.buildingId, source.id]); }
  private lightRigId(source: BuildingLightSource): string { return `building-light-${this.lightSources.indexOf(source)}`; }

  private createPart(part: BuildingPart, state: BuildingState): RenderedPart {
    const object = new Group(); object.name = part.id; object.position.copy(part.position);
    if (part.kind === 'door' && part.doorId) object.userData.buildingDoor = part.doorId;
    object.quaternion.copy(new Quaternion(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w));
    const custom = this.options.partFactory?.(part, state.manifest);
    if (custom) {
      if (!(custom.object instanceof Object3D) || typeof custom.dispose !== 'function') throw new Error('Building partFactory requires an Object3D and dispose().');
      object.add(custom.object);
      let released = false;
      return { part, object, release: () => { if (released) return; released = true; object.removeFromParent(); custom.dispose(); } };
    }
    if (part.model) {
      const view = this.assetViews.create(part.model, { material: part.material });
      view.object.position.y = -part.size.y / 2; object.add(view.object);
      let released = false;
      return { part, object, release: () => { if (released) return; released = true; object.removeFromParent(); view.dispose(); } };
    }
    const borrowed = new Map<string, MaterialEntry>();
    const surfaceHandles = new Map<string, ReturnType<SurfaceMaterialCache['acquire']>>(), geometries: BufferGeometry[] = [];
    const acquireSurface = (material: ResolvedSurfaceMaterial) => {
      let handle = surfaceHandles.get(material.key);
      if (!handle) { handle = this.materialCache.acquire(material); surfaceHandles.set(material.key, handle); }
      return handle.material;
    };
    const acquireColor = (color: string) => {
      let entry = this.materials.get(color);
      if (!entry) { entry = { material: new MeshStandardMaterial({ color, roughness: .85 }), references: 0 }; this.materials.set(color, entry); }
      if (!borrowed.has(color)) { entry.references++; borrowed.set(color, entry); }
      return entry.material;
    };
    const box: BoxFactory = (size, at, color) => {
      let geometry: BufferGeometry = this.geometry;
      let material: MeshStandardMaterial | MeshStandardMaterial[] = acquireColor(color);
      if (part.material || part.materialPatches?.length) {
        const materials = [part.material ? acquireSurface(part.material) : material];
        geometry = materialBoxGeometry(size, part.materialPatches ?? [], patch => {
          const found = patch.material ? acquireSurface(patch.material) : acquireColor(patch.color), index = materials.indexOf(found);
          if (index >= 0) return index; materials.push(found); return materials.length - 1;
        }); geometries.push(geometry); material = materials;
      }
      const mesh = new Mesh(geometry, material); mesh.scale.set(...size); mesh.position.set(...at);
      mesh.castShadow = mesh.receiveShadow = true; return mesh;
    };
    const releaseResources = () => {
      for (const [key, entry] of borrowed) if (--entry.references === 0) { entry.material.dispose(); this.materials.delete(key); }
      for (const geometry of geometries) geometry.dispose(); for (const handle of surfaceHandles.values()) handle.dispose();
    };
    let furniture: Group | undefined, mesh: Mesh | undefined;
    try {
      if (part.geometry) {
        const geometry = architecturalGeometry(part.geometry); geometries.push(geometry);
        mesh = new Mesh(geometry, part.material ? acquireSurface(part.material) : acquireColor(part.color));
        mesh.castShadow = mesh.receiveShadow = true;
      } else {
        furniture = part.kind === 'furniture' ? furnitureObject(part, box) : undefined;
        mesh = furniture ? undefined : box([part.size.x, part.size.y, part.size.z], [0, 0, 0], part.color);
      }
    }
    catch (error) { releaseResources(); throw error; }
    object.add(furniture ?? mesh!);
    let released = false;
    return { part, object, mesh, release: () => {
      if (released) return; released = true; object.removeFromParent();
      releaseResources();
    } };
  }

  private visibleRooms(state: BuildingState, focus: Point): Set<string> {
    const { rooms, portals } = state.manifest;
    const result = new Set(rooms.filter(room => contains(room, focus)).map(room => room.id));
    // Seed exterior openings even from inside: a window can look across a court
    // into another room's window, so room membership alone cannot safely cull it.
    for (const portal of portals) if (portal.exterior) for (const id of portal.roomIds) result.add(id);
    // Missing portal metadata must not make a custom room silently disappear.
    if (!result.size || this.appliesCutaway(state)) for (const room of rooms) result.add(room.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const portal of portals) if (portal.roomIds.some(id => result.has(id))) {
        for (const id of portal.roomIds) if (!result.has(id)) { result.add(id); changed = true; }
      }
    }
    result.add(unassigned);
    return result;
  }

  private loadInterior(state: BuildingState, key: string): void {
    if (state.interiors.has(key)) return;
    const parts = state.interiorParts.get(key); if (!parts?.length) return;
    const root = new Group(); root.name = `interior:${key || 'shared'}`;
    const loaded: RenderedPart[] = [];
    try { for (const part of parts) { const rendered = this.createPart(part, state); loaded.push(rendered); root.add(rendered.object); } }
    catch (error) { for (const part of loaded) part.release(); throw error; }
    state.root.add(root); state.interiors.set(key, { root, parts: loaded }); state.cutawayRevision = -1; this.createdInteriors++;
  }
  private unloadInterior(state: BuildingState, key: string): void {
    const interior = state.interiors.get(key); if (!interior) return;
    let failed = false, failure: unknown;
    for (const part of interior.parts) { try { part.release(); } catch (error) { if (!failed) failure = error; failed = true; } }
    interior.root.removeFromParent(); interior.root.clear(); state.interiors.delete(key); this.releasedInteriors++;
    if (failed) throw failure;
  }

  update(focus: Point): void {
    if (this.disposed) throw new Error('BuildingWorldView has been disposed.');
    if (!finitePoint(focus)) throw new Error('BuildingWorldView focus must contain finite world coordinates.');
    this.hasFocus = true; this.worldFocus.copy(focus); this.root.updateWorldMatrix(true, false);
    this.localFocus.copy(focus); this.root.worldToLocal(this.localFocus);
    for (const state of this.buildings) state.distance = distanceToBounds(this.localFocus, state.manifest.bounds);
    const inspected = (state: BuildingState) => this.cutaway?.buildingId === state.manifest.id;
    const candidates = this.buildings.filter(state => inspected(state) || state.distance <= this.activationDistance + (state.active ? this.hysteresis : 0))
      .sort((a, b) => Number(inspected(b)) - Number(inspected(a))
        || a.distance * (a.active ? .9 : 1) - b.distance * (b.active ? .9 : 1) || byId(a.manifest.id, b.manifest.id));
    const active = new Set(candidates.slice(0, this.maxActiveBuildings));
    this.omittedBuildings = Math.max(0, candidates.length - active.size);
    for (const state of this.buildings) {
      state.active = active.has(state);
      state.resident = state.active && (inspected(state) || state.distance <= this.interiorDistance + (state.resident ? this.hysteresis : 0));
      state.rooms = state.resident ? this.visibleRooms(state, this.localFocus) : new Set();
      for (const key of state.interiors.keys()) if (!state.rooms.has(key)) this.unloadInterior(state, key);
      for (const key of state.rooms) this.loadInterior(state, key);
      this.applyCutaway(state);
    }
    this.updateLights();
  }

  private updateLights(): void {
    const candidates = this.lightSources.filter(source => {
      const state = this.buildingById.get(source.buildingId)!;
      if (!state.active || source.roomId && !state.rooms.has(source.roomId)) return false;
      if (source.roomId && this.appliesCutaway(state)) {
        const room = state.manifest.rooms.find(room => room.id === source.roomId)!;
        if (room.floorId !== this.cutawayStorey(state)?.id) return false;
      }
      return true;
    }).map(source => ({ source, key: this.lightKey(source), distance: Math.hypot(source.position[0] - this.localFocus.x,
      source.position[1] - this.localFocus.y, source.position[2] - this.localFocus.z) }))
      .sort((a, b) => a.distance * (this.lights.has(a.key) ? .9 : 1) - b.distance * (this.lights.has(b.key) ? .9 : 1) || byId(a.key, b.key));
    this.eligibleLights = candidates.length;
    const selected = new Set(candidates.slice(0, this.maxLights).map(item => item.key));
    for (const [key, active] of this.lights) if (!selected.has(key)) { this.lighting.remove(this.lightRigId(active.source)); this.lights.delete(key); }
    for (const { source, key } of candidates.slice(0, this.maxLights)) if (!this.lights.has(key))
      this.lights.set(key, { source, light: this.lighting.addSpot({ ...source, id: this.lightRigId(source) }) });
    this.lighting.update(this.worldFocus);
  }

  setCutaway(value: BuildingCutaway | null): void {
    if (this.disposed) throw new Error('BuildingWorldView has been disposed.');
    if (value?.buildingId && !this.buildings.some(state => state.manifest.id === value.buildingId)) throw new Error(`Unknown cutaway building: ${value.buildingId}`);
    if (value?.floorY !== undefined && !Number.isFinite(value.floorY)) throw new Error('Cutaway floorY must be finite.');
    if (value?.wallHeight !== undefined) numberOption(value.wallHeight, 1.1, 'cutaway wallHeight', 0, 1000);
    if (value?.lowerWallHeight !== undefined) numberOption(value.lowerWallHeight, 0, 'cutaway lowerWallHeight', 0, 1000);
    this.cutaway = value ? { ...value } : null; this.cutawayRevision++;
    if (this.hasFocus) this.update(this.worldFocus);
    else for (const state of this.buildings) this.applyCutaway(state);
  }
  private appliesCutaway(state: BuildingState): boolean { return !!this.cutaway && (!this.cutaway.buildingId || this.cutaway.buildingId === state.manifest.id); }
  private cutawayStorey(state: BuildingState): BuildingManifest['recipe']['floors'][number] | undefined {
    const originY = state.manifest.recipe.origin?.y ?? 0, selected = this.cutaway?.floorY;
    const floors = [...state.manifest.recipe.floors].sort((a, b) => a.y - b.y);
    return selected === undefined ? floors[0] : floors.find(floor => selected >= originY + floor.y - .05 && selected < originY + floor.y + floor.height - .05)
      ?? floors.reduce((nearest, floor) => Math.abs(originY + floor.y - selected) < Math.abs(originY + nearest.y - selected) ? floor : nearest, floors[0]);
  }
  private cutawayFloor(state: BuildingState): number { return this.cutaway?.floorY ?? (state.manifest.recipe.origin?.y ?? 0) + (this.cutawayStorey(state)?.y ?? 0); }
  private applyCutaway(state: BuildingState): void {
    if (state.cutawayRevision === this.cutawayRevision) return;
    state.cutawayRevision = this.cutawayRevision;
    const applied = this.appliesCutaway(state);
    const floor = this.cutawayFloor(state);
    const selectedStorey = this.cutawayStorey(state);
    const highestRoom = Math.max(0, ...(selectedStorey?.rooms.map(room => room.elevation ?? 0) ?? []));
    const highestFloor = (state.manifest.recipe.origin?.y ?? 0) + (selectedStorey?.y ?? 0) + highestRoom;
    const top = Math.max(floor, highestFloor) + (this.cutaway?.wallHeight ?? 1.1);
    const storeyTop = selectedStorey ? (state.manifest.recipe.origin?.y ?? 0) + selectedStorey.y + selectedStorey.height : top;
    const visit = ({ part, object, mesh }: RenderedPart) => {
      object.visible = true;
      if (mesh) { if (part.geometry) mesh.scale.set(1, 1, 1); else mesh.scale.copy(part.size); mesh.position.set(0, 0, 0); }
      if (!applied) return;
      const bottom = part.position.y - part.size.y / 2;
      // Lower-storey caps coincide with the selected floor surface. Keeping
      // them in a floor plan can produce z-fighting and stray cap shadows.
      // Stairs and slabs remain visible so the opening still reads correctly.
      if (part.kind === 'wall' && part.position.y + part.size.y / 2 <= floor + 1e-6) {
        const lowerHeight = this.cutaway?.lowerWallHeight ?? 0;
        if (!lowerHeight || !mesh || part.geometry) { object.visible = false; return; }
        const storey = state.manifest.recipe.floors.find(candidate => candidate.id === part.floorId);
        const base = storey ? (state.manifest.recipe.origin?.y ?? 0) + storey.y : bottom;
        const height = Math.min(part.size.y, Math.max(0, base + lowerHeight - bottom));
        object.visible = height > 0;
        mesh.scale.y = height; mesh.position.y = (height - part.size.y) / 2;
        return;
      }
      // Stair treads remain real geometry throughout the selected storey's
      // height. The wall-height cut must not leave water floating above hidden
      // steps, or reveal the first overlapping tread of the storey above.
      const stairStorey = part.kind === 'stair' ? state.manifest.recipe.floors.find(candidate => candidate.id === part.floorId) : undefined;
      if (part.kind === 'roof' || bottom >= (part.kind === 'stair' ? storeyTop : top)
        || stairStorey && selectedStorey && stairStorey.y > selectedStorey.y
        || part.kind === 'floor' && part.floorId !== selectedStorey?.id && part.position.y > floor + .1) { object.visible = false; return; }
      // Exact architectural surfaces cannot be shortened with box scaling: hide
      // a crossing convex part whole, preserving its source shape and collision.
      if (mesh && part.kind === 'wall' && part.position.y + part.size.y / 2 > top) {
        if (part.geometry) { object.visible = false; return; }
        const height = Math.max(0, top - bottom); mesh.scale.y = height; mesh.position.y = (height - part.size.y) / 2;
      }
    };
    for (const part of state.exterior) visit(part);
    for (const interior of state.interiors.values()) for (const part of interior.parts) visit(part);
  }

  async readyMaterials(): Promise<void> { await this.materialCache.ready(); }

  inspection(): Record<string, unknown> {
    const doors = this.buildings.flatMap(state => state.manifest.doors ?? []);
    const states = this.buildings.map(state => ({ id: state.manifest.id, revision: state.manifest.revision,
      bounds: state.manifest.bounds, active: state.active, interiorResident: state.resident,
      distance: Number.isFinite(state.distance) ? Math.round(state.distance * 100) / 100 : null,
      rooms: [...state.rooms].filter(Boolean).sort(byId).slice(0, 16), roomCount: [...state.rooms].filter(Boolean).length,
      roomsTruncated: state.rooms.size - Number(state.rooms.has(unassigned)) > 16, interiorGroups: state.interiors.size,
      renderedParts: state.exterior.length + [...state.interiors.values()].reduce((count, interior) => count + interior.parts.length, 0) }));
    return { policy: 'Distance activation; conservative portal connectivity, not wall occlusion. Exterior shells stay resident.',
      buildings: this.buildings.length, activeBuildings: this.buildings.filter(state => state.active).length,
      residentInteriors: this.buildings.filter(state => state.resident).length, omittedBuildings: this.omittedBuildings,
      activeLights: this.lights.size, eligibleLights: this.eligibleLights, omittedLights: this.eligibleLights - this.lights.size,
      shadowLights: [...this.lights.values()].filter(value => value.light.castShadow).length,
      sharedMaterials: this.materials.size, sharedGeometries: this.disposed ? 0 : 1,
      assetFamilies: this.assetViews.inspection(),
      surfaceMaterials: this.materialCache.inspection(),
      doors: { state: 'authored-static', count: doors.length, traversable: doors.filter(door => door.traversable).length,
        blocked: doors.filter(door => !door.traversable).length },
      createdInteriors: this.createdInteriors, releasedInteriors: this.releasedInteriors, cutaway: this.cutaway,
      items: states.slice(0, 16), truncated: states.length > 16 || states.some(state => state.roomsTruncated), disposed: this.disposed };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lighting.dispose(); this.lights.clear();
    let failed = false, failure: unknown;
    for (const state of this.buildings) {
      for (const interior of state.interiors.values()) for (const part of interior.parts) {
        try { part.release(); } catch (error) { if (!failed) failure = error; failed = true; }
      }
      for (const part of state.exterior) { try { part.release(); } catch (error) { if (!failed) failure = error; failed = true; } }
      state.interiors.clear(); state.root.clear(); state.active = state.resident = false; state.rooms.clear();
    }
    for (const entry of this.materials.values()) entry.material.dispose();
    this.materials.clear(); this.assetViews.dispose(); this.geometry.dispose(); this.root.removeFromParent(); this.root.clear();
    if (this.ownsMaterialCache) this.materialCache.dispose();
    if (failed) throw failure;
  }
}
