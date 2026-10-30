import * as THREE from 'three';
import { sampleTerrain, terrainInspection, type TerrainAsset, type TerrainInstance, type TerrainManifest, type TerrainMask } from './terrain.ts';
import type { TerrainWorldSnapshot } from './terrainWorld.ts';
import { TerrainWindView, type TerrainWindInterest, type TerrainWindPart } from './terrainWindView.ts';
import { registerTerrainEnvironment } from './environmentRuntime.ts';
import { AssetFamilyViewCache, type AssetFamilyView } from './assetFamilyView.ts';
import { resolveSurfaceMaterial } from './surfaceMaterials.ts';
import { SurfaceMaterialCache, type SurfaceMaterialCacheOptions, type SurfaceMaterialHandle } from './surfaceMaterialView.ts';
import { createTerrainMaterialAtlas, hasTerrainMaterials, type TerrainMaterialAtlas, type TerrainMaterialOptions } from './terrainMaterialView.ts';
import {createTerrainLodGeometry,type TerrainLodGeometry} from './terrainLod.ts';
import {TerrainInstanceLod,terrainInstanceLodLevels,type TerrainInstanceLodPart} from './terrainInstanceLod.ts';
import {registerGeneratedGeometryLod,registerGeneratedLodAdapter} from './generatedLod.ts';

/** Cooperative immutable geometry loans. Materials and instance buffers remain
 * view-owned; the lender retains geometry until the supplied release runs. */
export interface TerrainAssetFactoryContext {
  borrowGeometry(geometries:readonly THREE.BufferGeometry[],release:()=>void):void;
}
function releaseGeometryLoans(loans:(()=>void)[]):void{
  let failed=false,failure:unknown;for(const release of loans.splice(0))try{release();}catch(error){if(!failed){failed=true;failure=error;}}
  if(failed)throw failure;
}
export interface TerrainViewOptions {
  /** False when the base already renders the identical accepted ground mesh. */
  surface?: boolean;
  /** Draw authored route ribbons over an existing fixed floor. */
  routeSurfaces?: boolean;
  /** Return static mesh parts in metres, centred at ground level. Any asset ID is
   * supported. The view owns and disposes the returned geometry/materials.
   * Return null for an intentional reservation rendered by another system;
   * undefined retains the normal default model or missing-model marker. */
  assetFactory?: (asset: Readonly<TerrainAsset>,context?:TerrainAssetFactoryContext) => THREE.Object3D | null | undefined;
  debug?: TerrainDebugOptions;
  /** Internal chunk views share their parent world's environment registration. */
  registerEnvironment?: boolean;
  materialCache?: SurfaceMaterialCache;
  materialOptions?: SurfaceMaterialCacheOptions;
  terrainMaterials?: TerrainMaterialOptions;
  /** Prepared geometry and per-instance screen-error LOD are enabled by default.
   * Disabling affects presentation only; collision always keeps accepted detail. */
  lod?:boolean;
}
export interface TerrainDebugOptions { routes?: boolean; footprints?: boolean; changes?: boolean; regions?: boolean }

/** The same column-major vertices and b–c diagonal used by Rapier and sampleTerrain. */
export function terrainGeometry(manifest: TerrainManifest): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [], indices: number[] = [], uvs: number[] = [], color = new THREE.Color();
  for (let col = 0; col <= manifest.columns; col++) for (let row = 0; row <= manifest.rows; row++) {
    const index = col * (manifest.rows + 1) + row;
    positions.push((manifest.origin?.x ?? 0) + (col / manifest.columns - .5) * manifest.bounds.width, manifest.heights[index],
      (manifest.origin?.z ?? 0) + (row / manifest.rows - .5) * manifest.bounds.depth);
    uvs.push(positions[positions.length - 3], positions[positions.length - 1]);
    color.setHex(manifest.colors[index]); colors.push(color.r, color.g, color.b);
  }
  for (let col = 0; col < manifest.columns; col++) for (let row = 0; row < manifest.rows; row++) {
    const a = col * (manifest.rows + 1) + row, b = a + manifest.rows + 1, c = a + 1, d = b + 1;
    indices.push(a, c, b, d, b, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

const material = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color, roughness: .88, metalness: 0 });
function part(root: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = mesh.receiveShadow = true; root.add(mesh); return mesh;
}

/** Editable source defaults, not a closed asset catalogue. Supply assetFactory
 * for imported or entirely original static models. Unknown IDs stay visible as
 * footprint markers and are reported by inspection(). */
export function createTerrainAsset(asset: Readonly<TerrainAsset>): THREE.Object3D | undefined {
  const root = new THREE.Group(), kind = asset.appearance?.kind ?? asset.id;
  const tint = typeof asset.appearance?.color === 'string' ? asset.appearance.color : undefined;
  const height = typeof asset.appearance?.height === 'number' ? asset.appearance.height : undefined;
  if (kind === 'pine' || kind === 'tree') {
    const h = height ?? 5.4, bark = material(0x61513b), leaves = material(tint ?? '#426f50');
    part(root, new THREE.CylinderGeometry(.13, .22, h * .62, 7), bark, 0, h * .31);
    for (let i = 0; i < 3; i++) {
      const y = h * (.42 + i * .19), radius = h * (.27 - i * .055);
      part(root, new THREE.ConeGeometry(radius, h * .45, 8), leaves, 0, y, 0, 0, i * .39);
    }
    return root;
  }
  if (kind === 'broadleaf') {
    const h = height ?? 4.3, bark = material(0x73604a), leaves = material(tint ?? '#709049');
    part(root, new THREE.CylinderGeometry(.13, .24, h * .7, 7), bark, 0, h * .35);
    const crown = part(root, new THREE.IcosahedronGeometry(h * .3, 1), leaves, 0, h * .75);
    crown.scale.set(1.14, .9, 1);
    part(root, new THREE.IcosahedronGeometry(h * .22, 1), leaves, h * .2, h * .6, -.1);
    return root;
  }
  if (kind === 'shrub') {
    const leaves = material(tint ?? '#668658'), h = height ?? .65;
    const bush = part(root, new THREE.IcosahedronGeometry(h * .6, 1), leaves, 0, h * .45);
    bush.scale.set(1.2, .8, 1);
    part(root, new THREE.IcosahedronGeometry(h * .4, 0), leaves, h * .36, h * .4, h * .1);
    return root;
  }
  if (kind === 'rock') {
    const stone = material(tint ?? '#8e9389'), h = height ?? .85;
    const rock = part(root, new THREE.DodecahedronGeometry(h * .7, 0), stone, 0, h * .35);
    rock.scale.set(1.3, .8, .92); rock.rotation.set(.12, .2, .13); return root;
  }
  if (kind === 'flowers') {
    const stem = material(0x54734d), petal = material(tint ?? '#e4cb86');
    for (let i = 0; i < 4; i++) {
      const x = Math.sin(i * 2.4) * .25, z = Math.cos(i * 2.4) * .25, y = .2 + i * .04;
      part(root, new THREE.CylinderGeometry(.015, .02, y * 2, 4), stem, x, y, z);
      part(root, new THREE.IcosahedronGeometry(.095, 0), petal, x, y * 2, z);
    }
    return root;
  }
  if (kind === 'cabin') {
    const wall = material(tint ?? '#bd9771'), timber = material(0x594a3a), roof = material(0x4e6269);
    const glass = new THREE.MeshStandardMaterial({ color: 0xf4d99b, roughness: .3, emissive: 0xffbe62, emissiveIntensity: .3 });
    part(root, new THREE.BoxGeometry(6.4, .26, 5.2), timber, 0, .13);
    // Front is +Z. The entrance is visually open and its approach is authored in the recipe.
    part(root, new THREE.BoxGeometry(6, 2.8, .22), wall, 0, 1.65, -2.3);
    part(root, new THREE.BoxGeometry(.22, 2.8, 4.6), wall, -2.9, 1.65);
    part(root, new THREE.BoxGeometry(.22, 2.8, 4.6), wall, 2.9, 1.65);
    part(root, new THREE.BoxGeometry(2.35, 2.8, .22), wall, -1.825, 1.65, 2.3);
    part(root, new THREE.BoxGeometry(2.35, 2.8, .22), wall, 1.825, 1.65, 2.3);
    part(root, new THREE.BoxGeometry(1.3, .6, .24), timber, 0, 2.75, 2.3);
    for (const x of [-1.85, 1.85]) {
      part(root, new THREE.BoxGeometry(1.15, 1.2, .12), timber, x, 1.85, 2.46);
      part(root, new THREE.BoxGeometry(.92, .96, .14), glass, x, 1.85, 2.48);
      part(root, new THREE.BoxGeometry(.07, .96, .16), timber, x, 1.85, 2.5);
      part(root, new THREE.BoxGeometry(.92, .07, .16), timber, x, 1.85, 2.5);
    }
    for (let y = .4; y < 3; y += .38) {
      part(root, new THREE.BoxGeometry(.25, .045, 4.6), timber, -2.91, y);
      part(root, new THREE.BoxGeometry(.25, .045, 4.6), timber, 2.91, y);
    }
    for (const side of [-1, 1]) part(root, new THREE.BoxGeometry(3.9, .2, 5.8), roof,
      side * 1.63, 3.6, 0, 0, 0, -side * .42);
    const gable = new THREE.Shape(); gable.moveTo(-3, 0); gable.lineTo(3, 0); gable.lineTo(0, 1.3); gable.closePath();
    part(root, new THREE.ExtrudeGeometry(gable, { depth: 4.6, bevelEnabled: false }), wall, 0, 3.05, -2.3);
    part(root, new THREE.BoxGeometry(.55, 1.7, .65), material(0x99958a), 1.9, 3.8, -1.2);
    part(root, new THREE.BoxGeometry(2.3, .16, 1), timber, 0, .08, 2.9);
    return root;
  }
  if (kind === 'statue') {
    const stone = material(tint ?? '#c7c9ad'), dark = material(0x7e8c7d);
    part(root, new THREE.CylinderGeometry(1.1, 1.25, .3, 8), dark, 0, .15);
    part(root, new THREE.BoxGeometry(1.45, .9, 1.45), stone, 0, .75);
    part(root, new THREE.CylinderGeometry(.65, .8, .25, 8), dark, 0, 1.32);
    part(root, new THREE.ConeGeometry(.62, 1.7, 7), stone, 0, 2.25);
    part(root, new THREE.IcosahedronGeometry(.39, 1), stone, 0, 3.2);
    part(root, new THREE.BoxGeometry(.16, 1.7, .16), dark, .7, 2.2, 0, 0, 0, -.2);
    part(root, new THREE.IcosahedronGeometry(.23, 0), material(0xd6b46e), .88, 3.1);
    return root;
  }
  return undefined;
}

type ViewResource = THREE.BufferGeometry | THREE.Material | THREE.Texture;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const immutableObjects = new WeakSet<object>();
function immutableData(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  if (immutableObjects.has(value)) return true;
  if (!Object.isFrozen(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (!Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor && immutableData(descriptor.value))) return false;
  immutableObjects.add(value); return true;
}
/** Includes every input read by default art and TerrainWindView. Only metadata
 * changes invoke this comparison; ordinary frames use the revision fast path. */
function contentDependencies(manifest: TerrainManifest, options: TerrainViewOptions): string {
  const used = new Set(manifest.instances.map(instance => instance.asset)), recipe = manifest.recipe;
  return canonical({ bounds: manifest.bounds, origin: manifest.origin, rows: manifest.rows, columns: manifest.columns, surface: options.surface,
    assets: recipe.assets.filter(asset => used.has(asset.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    seed: recipe.seed, environment: recipe.environment, defaultWind: recipe.assets.some(asset => !!asset.environment?.wind),
    regions: recipe.regions.filter(region => region.environment).map(({ id, mask, blend, environment }) => ({ id, mask, blend, environment })),
    routes: options.routeSurfaces || hasTerrainMaterials(recipe) ? recipe.routes : undefined, routeSurfaces: options.routeSurfaces,
    channels: hasTerrainMaterials(recipe) ? recipe.channels : undefined,
    material: recipe.material, materialRegions: recipe.regions.filter(region => region.material || hasTerrainMaterials(recipe) && region.color).map(({ id, mask, blend, material, color }) => ({ id, mask, blend, material, color })),
    // Surface masks depend on analytic grading, elevation and foundations.
    materialHeight: hasTerrainMaterials(recipe) ? { bounds: recipe.bounds, streaming: recipe.streaming, base: recipe.base, regions: recipe.regions.map(({ id, mask, blend, elevation }) => ({ id, mask, blend, elevation })), placements: recipe.placements, overrides: recipe.overrides } : undefined,
    terrainMaterials: options.terrainMaterials });
}
function disposeObjects(root: THREE.Object3D, retain?: THREE.Object3D, borrowed: ReadonlySet<ViewResource> = new Set()): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  const retained = new Set<ViewResource>(borrowed);
  retain?.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) retained.add(mesh.geometry);
    for (const mat of mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []) {
      retained.add(mat);
      for (const value of Object.values(mat)) if (value instanceof THREE.Texture) retained.add(value);
    }
  });
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const mat of mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []) materials.add(mat);
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  for (const geometry of geometries) if (!retained.has(geometry)) geometry.dispose();
  for (const mat of materials) {
    if (!borrowed.has(mat)) for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value);
    if (!retained.has(mat)) mat.dispose();
  }
  for (const texture of textures) if (!retained.has(texture)) texture.dispose();
  root.clear();
}

/** A reusable, mode-independent view of an authoritative terrain manifest.
 * update() replaces a complete compiled revision; it never generates new randomness. */
export class TerrainView {
  readonly root = new THREE.Group();
  private readonly content = new THREE.Group();
  private readonly overlays = new THREE.Group();
  private readonly options: TerrainViewOptions;
  private manifest: TerrainManifest;
  private debug: TerrainDebugOptions;
  private missing: string[] = [];
  private removed: TerrainInstance[] = [];
  private batches = 0;
  private renderedRevision: string | undefined;
  private overlaySegments = 0;
  private overlayTruncated = false;
  private disposed = false;
  private wind: TerrainWindView | undefined;
  private heights: ReadonlyMap<string, number> = new Map();
  private unregisterEnvironment: (() => void) | undefined;
  private readonly familyCache: AssetFamilyViewCache;
  private readonly materialCache: SurfaceMaterialCache;
  private readonly ownsMaterialCache: boolean;
  private materialHandles: SurfaceMaterialHandle[] = [];
  private materialAtlases: TerrainMaterialAtlas[] = [];
  private familyViews: AssetFamilyView[] = [];
  private familyResources = new Set<ViewResource>();
  private contentSignature: string | undefined;
  private immutableGenerated = false;
  private terrainLod:TerrainLodGeometry|undefined;
  private instanceLod:TerrainInstanceLod[]=[];
  private ownedLodGeometries=new Set<THREE.BufferGeometry>();
  private geometryLoans:(()=>void)[]=[];
  private releaseLod:()=>void;

  constructor(manifest: TerrainManifest, options: TerrainViewOptions = {}) {
    this.materialCache = options.materialCache ?? new SurfaceMaterialCache(options.materialOptions); this.ownsMaterialCache = !options.materialCache;
    this.familyCache = new AssetFamilyViewCache({ materialCache: this.materialCache });
    this.options = options; this.manifest = manifest; this.debug = options.debug ?? {};
    this.root.name = 'procedural-terrain'; this.root.add(this.content, this.overlays);
    this.releaseLod=registerGeneratedLodAdapter(this.root,{prepare:frame=>{for(const group of this.instanceLod)group.prepare(frame,this.root.matrixWorld);},restore:()=>{for(const group of this.instanceLod)group.restore();}});
    try { this.update(manifest); } catch (error) { try{this.dispose();}catch{/* Preserve the original construction error after releasing owned resources. */}throw error; }
    if (options.registerEnvironment !== false) this.unregisterEnvironment = registerTerrainEnvironment({
      read: () => ({ recipe: this.manifest.recipe, instances: this.manifest.instances, revision: this.manifest.revision, heights: this.heights }),
      stepWind: (now, listener, budget) => this.stepWind(now, listener, budget),
      windDistance: listener => this.windDistance(listener),
    });
  }

  update(manifest: TerrainManifest): void {
    if (this.disposed) throw new Error('TerrainView has been disposed.');
    if (!manifest.diagnostics.valid) throw new Error(`Terrain revision ${manifest.revision} is invalid: ${manifest.diagnostics.issues.filter(issue => issue.severity === 'error').slice(0, 8).map(issue => issue.code).join(', ')}`);
    if (manifest.revision === this.renderedRevision) return;
    if (this.canRetainContent(manifest)) {
      this.manifest = manifest; this.renderedRevision = manifest.revision; this.removed = [];
      return;
    }
    // Custom art can fail during an edit. Construct off-scene first so a failed
    // factory leaves the last valid visual/physical revision intact.
    const next = this.buildContent(manifest);
    const removed = new Set(manifest.changes.removed);
    this.removed = this.manifest.instances.filter(item => removed.has(item.id));
    disposeObjects(this.content, next.group, this.familyResources);
    this.terrainLod?.dispose();for(const group of this.instanceLod)group.dispose();
    for(const geometry of this.ownedLodGeometries)if(!next.ownedLodGeometries.has(geometry)&&!next.familyResources.has(geometry))geometry.dispose();
    this.ownedLodGeometries=next.ownedLodGeometries;
    this.terrainLod=next.terrainLod;this.instanceLod=next.instanceLod;
    this.materialHandles.forEach(handle => handle.dispose()); this.materialAtlases.forEach(atlas => atlas.dispose());
    this.materialHandles = next.materialHandles; this.materialAtlases = next.materialAtlases;
    for (const view of this.familyViews) view.dispose();
    const previousGeometryLoans=this.geometryLoans;this.geometryLoans=next.geometryLoans;
    this.familyViews = next.familyViews; this.familyResources = next.familyResources;
    // Bases may retain their authored floor and have no scattered objects yet.
    // Three's add() treats a zero-argument call as an invalid undefined object.
    if (next.group.children.length) this.content.add(...next.group.children);
    this.manifest = manifest; this.renderedRevision = manifest.revision; this.missing = next.missing; this.batches = next.batches;
    this.wind = next.wind; this.heights = next.heights;
    this.immutableGenerated = immutableData(manifest.heights) && immutableData(manifest.colors) && immutableData(manifest.instances) && immutableData(manifest.recipe);
    this.contentSignature = this.options.assetFactory ? undefined : contentDependencies(manifest, this.options);
    try{this.drawDebug();}finally{releaseGeometryLoans(previousGeometryLoans);}
  }

  /** Self-validating preview for transactional world updates. No caller-supplied
   * trust flag can bypass the immutable geometry or rendering dependency checks.
   * Custom factories and active debug overlays deliberately rebuild as before. */
  canRetainContent(manifest: TerrainManifest): boolean {
    return !this.disposed && !!this.renderedRevision && manifest.diagnostics.valid && !this.options.assetFactory
      && !Object.values(this.debug).some(Boolean) && this.immutableGenerated
      && manifest.heights === this.manifest.heights && manifest.colors === this.manifest.colors && manifest.instances === this.manifest.instances
      && immutableData(manifest.recipe)
      && this.contentSignature === contentDependencies(manifest, this.options);
  }

  private buildContent(manifest: TerrainManifest): { group: THREE.Group; missing: string[]; batches: number; wind: TerrainWindView; heights: ReadonlyMap<string, number>; familyViews: AssetFamilyView[]; familyResources: Set<ViewResource>; materialHandles: SurfaceMaterialHandle[]; materialAtlases: TerrainMaterialAtlas[];terrainLod:TerrainLodGeometry|undefined;instanceLod:TerrainInstanceLod[];ownedLodGeometries:Set<THREE.BufferGeometry>;geometryLoans:(()=>void)[] } {
    const group = new THREE.Group(), missing: string[] = [];
    const wind = new TerrainWindView(manifest.recipe);
    const heights = new Map<string, number>();
    const familyViews: AssetFamilyView[] = [], familyResources = new Set<ViewResource>();
    const geometryLoans:(()=>void)[]=[],borrowedGeometries=new Set<THREE.BufferGeometry>();
    let acceptingLoans=true;
    const factoryContext:TerrainAssetFactoryContext={borrowGeometry(geometries,release){
      if(!acceptingLoans)throw Error('Terrain geometry loans must be registered synchronously inside assetFactory.');
      if(!Array.isArray(geometries)||Object.keys(geometries).length!==geometries.length||geometries.length>4096||geometryLoans.length>=256||typeof release!=='function'||geometries.some(g=>!(g instanceof THREE.BufferGeometry))||new Set([...borrowedGeometries,...geometries]).size>4096)throw Error('Terrain geometry loans require bounded prepared geometry and a release callback.');
      for(const geometry of geometries){borrowedGeometries.add(geometry);familyResources.add(geometry);}let released=false;geometryLoans.push(()=>{if(released)return;released=true;release();});
    }};
    const materialHandles: SurfaceMaterialHandle[] = [], materialAtlases: TerrainMaterialAtlas[] = [];
    let terrainLod:TerrainLodGeometry|undefined;const instanceLod:TerrainInstanceLod[]=[];let allocatedSlots=0;const ownedLodGeometries=new Set<THREE.BufferGeometry>();
    let batches = 0;
    try {
    if (this.options.surface !== false) {
      let groundMaterial: THREE.MeshStandardMaterial;
      if (hasTerrainMaterials(manifest.recipe)) {
        const atlas = createTerrainMaterialAtlas(manifest, this.materialCache, this.options.terrainMaterials); materialAtlases.push(atlas); groundMaterial = atlas.material; familyResources.add(groundMaterial);
      } else groundMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .98 });
      terrainLod=this.options.lod===false?undefined:createTerrainLodGeometry(manifest);
      const source=terrainLod?.levels[0].geometry??terrainGeometry(manifest);
      if(terrainLod){const radius=source.boundingSphere?.radius??1;for(const level of terrainLod.levels)familyResources.add(level.geometry);if(terrainLod.levels.length>1)registerGeneratedGeometryLod(source,terrainLod.levels.map(level=>({geometry:level.geometry,error:level.errorMeters/Math.max(.0001,radius)})));}
      const ground = new THREE.Mesh(source, groundMaterial);
      ground.name = 'terrain-surface'; ground.receiveShadow = true; group.add(ground);
    }
    if (this.options.routeSurfaces) for (const route of manifest.recipe.routes ?? []) {
      if (route.id.startsWith('base-reservation-')) continue;
      const positions: number[] = [];
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1], b = route.points[i], length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < .0001) continue;
        const dx = -(b.z - a.z) / length * route.width / 2, dz = (b.x - a.x) / length * route.width / 2;
        const corners = [[a.x - dx, a.z - dz], [a.x + dx, a.z + dz], [b.x - dx, b.z - dz], [b.x + dx, b.z + dz]];
        if (manifest.origin) {
          let polygon = [corners[0], corners[2], corners[3], corners[1]];
          for (const [axis, edge, sign] of [[0, manifest.origin.x - manifest.bounds.width / 2, 1], [0, manifest.origin.x + manifest.bounds.width / 2, -1],
            [1, manifest.origin.z - manifest.bounds.depth / 2, 1], [1, manifest.origin.z + manifest.bounds.depth / 2, -1]]) {
            const clipped: number[][] = [];
            for (let j = 0; j < polygon.length; j++) {
              const start = polygon[j], end = polygon[(j + 1) % polygon.length];
              const from = (start[axis] - edge) * sign, to = (end[axis] - edge) * sign;
              if (from >= 0) clipped.push(start);
              if ((from >= 0) !== (to >= 0)) { const t = from / (from - to); clipped.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]); }
            }
            polygon = clipped;
          }
          for (let j = 1; j + 1 < polygon.length; j++) for (const [x, z] of [polygon[0], polygon[j], polygon[j + 1]])
            positions.push(x, sampleTerrain(manifest, x, z).height + .035, z);
          continue;
        }
        for (const index of [0, 2, 1, 1, 2, 3]) {
          const [x, z] = corners[index]; positions.push(x, sampleTerrain(manifest, x, z).height + .035, z);
        }
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(positions.flatMap((_, i) => i % 3 === 0 ? [positions[i], positions[i + 2]] : []), 2));
      let routeMaterial: THREE.MeshStandardMaterial;
      if (route.material) {
        const resolved = resolveSurfaceMaterial(route.material, { seed: manifest.recipe.seed, key: `terrain:route:${route.id}` });
        if (resolved.texture.layers.some(layer => layer.mask && layer.mask.kind !== 'pattern' && layer.mask.field === 'surface' && layer.mask.kind !== 'noise')) {
          const atlas = createTerrainMaterialAtlas(manifest, this.materialCache, this.options.terrainMaterials, route); materialAtlases.push(atlas); routeMaterial = atlas.material; routeMaterial.side = THREE.DoubleSide;
          familyResources.add(routeMaterial);
        } else {
          const handle = this.materialCache.acquire(resolved, { side: THREE.DoubleSide });
          materialHandles.push(handle); familyResources.add(handle.material); routeMaterial = handle.material;
        }
      } else routeMaterial = new THREE.MeshStandardMaterial({ color: route.color ?? '#ad9878', roughness: .95, side: THREE.DoubleSide });
      const ribbon = new THREE.Mesh(geometry, routeMaterial);
      ribbon.name = `route:${route.id}`; ribbon.receiveShadow = true; group.add(ribbon);
    }
    const assets = new Map(manifest.recipe.assets.map(asset => [asset.id, asset]));
    const groups = new Map<string, TerrainInstance[]>();
    for (const instance of manifest.instances) {
      const existing = groups.get(instance.asset); if (existing) existing.push(instance); else groups.set(instance.asset, [instance]);
    }
    for (const [id, instances] of groups) {
      const asset = assets.get(id)!;
      const custom = this.options.assetFactory?.(asset,factoryContext);
      if (custom === null) continue;
      let prototype = custom ?? undefined;
      if (!prototype && asset.model) {
        const view = this.familyCache.create(asset.model, asset.material ? { material: resolveSurfaceMaterial(asset.material, { seed: manifest.recipe.seed, key: `terrain:asset:${asset.id}` }) } : {}); familyViews.push(view); prototype = view.object;
        prototype.traverse(object => { if (object instanceof THREE.Mesh) {
          familyResources.add(object.geometry);
          for (const mat of Array.isArray(object.material) ? object.material : [object.material]) familyResources.add(mat);
        } });
      }
      prototype ??= createTerrainAsset(asset);
      if (!custom && !asset.model && prototype && asset.material) {
        const handle = this.materialCache.acquire(resolveSurfaceMaterial(asset.material, { seed: manifest.recipe.seed, key: `terrain:asset:${asset.id}` }));
        materialHandles.push(handle); familyResources.add(handle.material);
        const replaced = new Set<THREE.Material>();
        prototype.traverse(object => { if (object instanceof THREE.Mesh) {
          for (const old of Array.isArray(object.material) ? object.material : [object.material]) replaced.add(old);
          object.material = handle.material;
          const uv = object.geometry.getAttribute('uv'), p = object.geometry.getAttribute('position'), n = object.geometry.getAttribute('normal');
          if (uv && p && n) for (let i = 0; i < uv.count; i++) {
            const x = p.getX(i) * object.scale.x, y = p.getY(i) * object.scale.y, z = p.getZ(i) * object.scale.z;
            uv.setXY(i, Math.abs(n.getY(i)) > .5 ? x : Math.abs(n.getX(i)) > .5 ? z : x, Math.abs(n.getY(i)) > .5 ? z : y);
          }
        } });
        replaced.forEach(mat => mat.dispose());
      }
      let meshes = 0, unsupported = false;
      prototype?.traverse(object => {
        if (object instanceof THREE.Mesh) meshes++;
        if (object instanceof THREE.SkinnedMesh || object instanceof THREE.InstancedMesh) unsupported = true;
      });
      if (prototype && (!meshes || unsupported)) { disposeObjects(prototype, this.content,familyResources); prototype = undefined; }
      if (!prototype) {
        missing.push(id); prototype = new THREE.Group();
        const radius = asset.footprint.kind === 'circle' ? asset.footprint.radius : Math.max(asset.footprint.width, asset.footprint.depth) / 2;
        part(prototype, new THREE.ConeGeometry(radius, .8, 4), material(0xd76be5), 0, .4);
      }
      prototype.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(prototype), windParts: TerrainWindPart[] = [];
      const height = Math.max(.01, bounds.max.y - Math.min(0, bounds.min.y));
      if (!missing.includes(id)) heights.set(id, height);
      const radius = Math.hypot(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
        Math.max(Math.abs(bounds.min.y), Math.abs(bounds.max.y)), Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)));
      const transform = new THREE.Matrix4(), orientation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0), local = new THREE.Matrix4();
      const prototypeMeshes:THREE.Mesh[]=[];prototype.traverse(object=>{if(object instanceof THREE.Mesh)prototypeMeshes.push(object);});
      for(const mesh of prototypeMeshes){const levels=terrainInstanceLodLevels(mesh.geometry);if(levels.length>1)for(const level of levels){familyResources.add(level.geometry);if(custom&&!borrowedGeometries.has(level.geometry))ownedLodGeometries.add(level.geometry);}}
      const tierCount=Math.max(1,...prototypeMeshes.map(mesh=>terrainInstanceLodLevels(mesh.geometry).length)),slots=tierCount*instances.length*prototypeMeshes.length;
      const useLod=this.options.lod!==false&&tierCount>1&&allocatedSlots+slots<=32768,instanceParts:TerrainInstanceLodPart[]=[];
      if(useLod)allocatedSlots+=slots;
      prototype.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const batch = new THREE.InstancedMesh(object.geometry, object.material, instances.length);
        batch.name = `terrain:${id}:${batches++}`; batch.castShadow = object.castShadow; batch.receiveShadow = object.receiveShadow;
        for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
          if (!ancestor.visible) batch.visible = false;
          if (ancestor === prototype) break;
        }
        batch.renderOrder = object.renderOrder; batch.layers.mask = object.layers.mask;
        local.copy(object.matrixWorld);
        for (let i = 0; i < instances.length; i++) {
          const item = instances[i]; position.set(item.position.x, item.position.y, item.position.z);
          orientation.setFromAxisAngle(up, item.yaw); scale.setScalar(item.scale);
          transform.compose(position, orientation, scale).multiply(local); batch.setMatrixAt(i, transform);
        }
        batch.instanceMatrix.needsUpdate = true; batch.computeBoundingSphere();
        if(useLod){const levels=terrainInstanceLodLevels(object.geometry),tierBatches:THREE.InstancedMesh[]=[];
          for(let level=0;level<tierCount;level++){
            const geometry=levels[Math.min(level,levels.length-1)].geometry,tier=new THREE.InstancedMesh(geometry,object.material,instances.length);
            tier.name=batch.name+':lod'+level;tier.castShadow=batch.castShadow;tier.receiveShadow=batch.receiveShadow;tier.visible=batch.visible;tier.renderOrder=batch.renderOrder;tier.layers.mask=batch.layers.mask;
            tier.instanceMatrix.setUsage(THREE.DynamicDrawUsage);tier.instanceMatrix.array.set(batch.instanceMatrix.array);tier.instanceMatrix.needsUpdate=true;tier.count=level===0?instances.length:0;tier.boundingSphere=batch.boundingSphere?.clone()??null;
            group.add(tier);tierBatches.push(tier);
          }
          instanceParts.push({source:batch,batches:tierBatches,levels,scale:local.getMaxScaleOnAxis()});
        }else group.add(batch);
        windParts.push({ mesh: batch, local: local.clone() });
      });
      if (asset.environment?.wind && !missing.includes(id)) wind.add({ asset: id, profile: asset.environment,
        height, radius, instances, parts: windParts });
      if(useLod){
        // Wind expands the hidden source bounds for every possible root rotation.
        // Tier batches use the same conservative placement bounds, not the subset
        // visible during one frame, so culling remains safe as buckets change.
        for(const part of instanceParts)for(const batch of part.batches)batch.boundingSphere=part.source.boundingSphere?.clone()??null;
        instanceLod.push(new TerrainInstanceLod(instances,instanceParts,radius));
      }
      // The batches now own the prototype's shared resources. Do not dispose them here.
      prototype.clear();
    }
    acceptingLoans=false;borrowedGeometries.clear();return { group, missing, batches, wind, heights, familyViews, familyResources, materialHandles, materialAtlases,terrainLod,instanceLod,ownedLodGeometries,geometryLoans };
    } catch (error) { acceptingLoans=false;borrowedGeometries.clear();try{disposeObjects(group, this.content, familyResources);terrainLod?.dispose();for(const lod of instanceLod)lod.dispose();for(const geometry of ownedLodGeometries)if(!this.ownedLodGeometries.has(geometry))geometry.dispose(); for (const view of familyViews) view.dispose(); materialHandles.forEach(handle => handle.dispose()); materialAtlases.forEach(atlas => atlas.dispose());}finally{releaseGeometryLoans(geometryLoans);}throw error; }
  }

  setDebug(debug: TerrainDebugOptions): void {
    if (this.disposed) return;
    this.debug = { ...debug }; this.drawDebug();
  }

  /** Normal game views are advanced by the shared environment frame lifecycle. */
  stepWind(nowSeconds: number, listener?: TerrainWindInterest, budget = 512): number {
    if(this.disposed)return 0;const count=this.wind?.step(nowSeconds,listener,budget)??0;
    for(const group of this.instanceLod)group.syncSource();return count;
  }

  windDistance(listener?: TerrainWindInterest): number { return this.wind?.interestDistance(listener) ?? Infinity; }
  /** Measured prototype heights keep size-sensitive audio and visual motion aligned. */
  environmentHeights(): ReadonlyMap<string, number> { return this.heights; }
  async readyMaterials(): Promise<void> { await Promise.all([this.materialCache.ready(), ...this.materialAtlases.map(atlas => atlas.ready)]); }

  private line(points: { x: number; z: number }[], color: number, loop = false, offset = .11): void {
    const vertices: THREE.Vector3[] = [], spacing = Math.min(this.manifest.bounds.width / this.manifest.columns, this.manifest.bounds.depth / this.manifest.rows) / 2;
    for (let i = 0; i < points.length - (loop ? 0 : 1); i++) {
      const a = points[i], b = points[(i + 1) % points.length], dx = b.x - a.x, dz = b.z - a.z;
      if (![a.x, a.z, b.x, b.z, dx, dz].every(Number.isFinite)) { this.overlayTruncated = true; continue; }
      // Region masks can extend far beyond the world. Clip before subdividing;
      // a huge mask or thin world cannot allocate an unbounded debug mesh.
      let enter = 0, leave = 1, outside = false;
      for (const [value, delta, half] of [[a.x - (this.manifest.origin?.x ?? 0), dx, this.manifest.bounds.width / 2], [a.z - (this.manifest.origin?.z ?? 0), dz, this.manifest.bounds.depth / 2]]) {
        if (!delta) { if (Math.abs(value) > half) outside = true; continue; }
        const t0 = (-half - value) / delta, t1 = (half - value) / delta;
        enter = Math.max(enter, Math.min(t0, t1)); leave = Math.min(leave, Math.max(t0, t1));
      }
      if (outside || enter >= leave) continue;
      const requested = Math.max(1, Math.ceil(Math.hypot(dx, dz) * (leave - enter) / spacing));
      const steps = Math.min(requested, 128, 8192 - this.overlaySegments);
      if (steps < requested) this.overlayTruncated = true;
      if (!steps) break;
      for (let j = 0; j < steps; j++) for (const endpoint of [j, j + 1]) {
        const t = enter + (leave - enter) * endpoint / steps, x = a.x + dx * t, z = a.z + dz * t;
        vertices.push(new THREE.Vector3(x, sampleTerrain(this.manifest, x, z).height + offset, z));
      }
      this.overlaySegments += steps;
    }
    if (!vertices.length) return;
    const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: .85 });
    const line = new THREE.LineSegments(geometry, mat); line.renderOrder = 10;
    this.overlays.add(line);
  }

  private outline(mask: TerrainMask, color: number, scale = 1): void {
    const points: { x: number; z: number }[] = [], yaw = mask.yaw ?? 0, c = Math.cos(yaw), s = Math.sin(yaw);
    const local = mask.kind === 'circle'
      ? Array.from({ length: 32 }, (_, i) => ({ x: Math.cos(i / 32 * Math.PI * 2) * mask.radius, z: Math.sin(i / 32 * Math.PI * 2) * mask.radius }))
      : [{ x: -mask.width / 2, z: -mask.depth / 2 }, { x: mask.width / 2, z: -mask.depth / 2 },
        { x: mask.width / 2, z: mask.depth / 2 }, { x: -mask.width / 2, z: mask.depth / 2 }];
    for (const p of local) points.push({ x: mask.center.x + (p.x * c + p.z * s) * scale, z: mask.center.z + (-p.x * s + p.z * c) * scale });
    this.line(points, color, true);
  }

  private drawDebug(): void {
    disposeObjects(this.overlays); this.overlaySegments = 0; this.overlayTruncated = false;
    const { recipe, changes } = this.manifest;
    if (this.debug.regions) for (const region of recipe.regions) this.outline(region.mask, 0x91d5b3);
    if (this.debug.routes) {
      for (const route of recipe.routes ?? []) this.line(route.points, 0xf5d177);
      for (const placement of [...recipe.placements ?? [], ...recipe.overrides?.pin ?? []]) {
        for (const entry of placement.entrances ?? []) this.line(entry.points, 0x75d8ff);
      }
    }
    const changed = new Set([...changes.added, ...changes.updated]);
    for (const item of this.manifest.instances) {
      if (this.debug.footprints && item.source.kind !== 'scatter') this.outline({ ...item.footprint, center: item.position, yaw: item.yaw }, 0x81d6f5);
      if (this.debug.changes && changed.has(item.id)) this.outline({ ...item.footprint, center: item.position, yaw: item.yaw }, 0xf8c873);
    }
    if (this.debug.changes) for (const item of this.removed) {
      this.outline({ ...item.footprint, center: item.position, yaw: item.yaw }, 0xf5887b);
    }
  }

  /** Small enough to include next to gameplay diagnostics in an inspection. */
  inspection(): Record<string, unknown> {
    const m = this.manifest, byAsset: Record<string, number> = {};
    for (const item of m.instances) byAsset[item.asset] = (byAsset[item.asset] ?? 0) + 1;
    const summary = terrainInspection(m), assetCounts = Object.entries(byAsset);
    return { ...summary,
      instances: m.instances.length, drawBatches: this.batches, triangles: m.rows * m.columns * 2,
      overlays: { segments: this.overlaySegments, truncated: this.overlayTruncated },
      environment: { wind: this.wind?.inspection() ?? null },
      lod:{enabled:this.options.lod!==false,terrain:this.terrainLod?.levels.map(level=>({stride:level.stride,triangles:level.triangles,errorMeters:level.errorMeters}))??[],instanceGroups:this.instanceLod.map(group=>group.inspection()),maxTierInstanceSlots:32768},
      materials: { cache: this.materialCache.inspection(), atlases: this.materialAtlases.map(atlas => atlas.inspection()) },
      assets: Object.fromEntries(assetCounts.slice(0, 16)), assetCount: assetCounts.length,
      missingAssets: this.missing.slice(0, 8), missingAssetCount: this.missing.length,
      truncated: summary.truncated || summary.issues.length > 8 || assetCounts.length > 16 || this.missing.length > 8,
      // Keep reservation IDs and world positions: the AI needs these to repair
      // the responsible route/foundation rather than guessing from a screenshot.
      issues: summary.issues.slice(0, 8) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed=true;
    try{
    this.unregisterEnvironment?.(); this.unregisterEnvironment = undefined;
    this.releaseLod();for(const group of this.instanceLod)group.dispose();this.instanceLod=[];
    disposeObjects(this.content, undefined, this.familyResources); disposeObjects(this.overlays);
    this.terrainLod?.dispose();this.terrainLod=undefined;
    for(const geometry of this.ownedLodGeometries)geometry.dispose();this.ownedLodGeometries.clear();
    this.materialHandles.forEach(handle => handle.dispose()); this.materialAtlases.forEach(atlas => atlas.dispose()); this.materialHandles = []; this.materialAtlases = [];
    for (const view of this.familyViews) view.dispose(); this.familyViews = []; this.familyResources.clear(); this.familyCache.dispose();
    if (this.ownsMaterialCache) this.materialCache.dispose();
    this.root.removeFromParent(); this.root.clear();
    }finally{releaseGeometryLoans(this.geometryLoans);}
  }
}

/** Render only accepted resident chunks. Unloading disposes their GPU resources;
 * revisits regenerate the same world-space transforms and instance identities. */
export class TerrainWorldView {
  readonly root = new THREE.Group();
  private readonly views = new Map<string, TerrainView>();
  private readonly revisions = new Map<string, string>();
  private snapshot: TerrainWorldSnapshot;
  private loadedRevision = '';
  private disposed = false;
  private readonly options: TerrainViewOptions;
  private readonly materialCache: SurfaceMaterialCache;
  private readonly ownsMaterialCache: boolean;
  private unregisterEnvironment: (() => void) | undefined;
  private heights: ReadonlyMap<string, number> = new Map();
  constructor(snapshot: TerrainWorldSnapshot, options: TerrainViewOptions = {}) {
    this.materialCache = options.materialCache ?? new SurfaceMaterialCache(options.materialOptions); this.ownsMaterialCache = !options.materialCache;
    this.options = { ...options, materialCache: this.materialCache }; this.snapshot = snapshot; this.root.name = 'procedural-terrain-world';
    try { this.update(snapshot); } catch (error) { if (this.ownsMaterialCache) this.materialCache.dispose(); throw error; }
    if (options.registerEnvironment !== false) this.unregisterEnvironment = registerTerrainEnvironment({
      read: () => ({ recipe: this.snapshot.recipe, instances: this.snapshot.instances, revision: this.snapshot.loadedRevision, heights: this.heights }),
      stepWind: (now, listener, budget) => this.stepWind(now, listener, budget),
      windDistance: listener => this.windDistance(listener),
    });
  }
  update(snapshot: TerrainWorldSnapshot): void {
    if (this.disposed) throw new Error('TerrainWorldView has been disposed.');
    if (snapshot.loadedRevision === this.loadedRevision) { this.snapshot = snapshot; return; }
    const replacements = new Map<string, TerrainView>(), retained = new Map<string, TerrainManifest>();
    try {
      for (const chunk of snapshot.chunks) if (this.revisions.get(chunk.id) !== chunk.manifest.revision) {
        if (this.views.get(chunk.id)?.canRetainContent(chunk.manifest)) retained.set(chunk.id, chunk.manifest);
        else replacements.set(chunk.id, new TerrainView(chunk.manifest, { ...this.options, registerEnvironment: false }));
      }
    } catch (error) { for (const view of replacements.values()) view.dispose(); throw error; }
    // All potentially failing custom construction has succeeded. Retained views
    // now adopt accepted diagnostics/recipe identity without replacing GPU data.
    for (const [id, manifest] of retained) { this.views.get(id)!.update(manifest); this.revisions.set(id, manifest.revision); }
    const wanted = new Set(snapshot.chunks.map(chunk => chunk.id));
    for (const [id, view] of this.views) if (!wanted.has(id) || replacements.has(id)) { view.dispose(); this.views.delete(id); this.revisions.delete(id); }
    for (const chunk of snapshot.chunks) {
      const view = replacements.get(chunk.id);
      if (view) { this.root.add(view.root); this.views.set(chunk.id, view); this.revisions.set(chunk.id, chunk.manifest.revision); }
    }
    const heights = new Map<string, number>();
    for (const view of this.views.values()) for (const [id, height] of view.environmentHeights()) heights.set(id, height);
    this.heights = heights; this.snapshot = snapshot; this.loadedRevision = snapshot.loadedRevision;
  }
  setDebug(debug: TerrainDebugOptions): void { for (const view of this.views.values()) view.setDebug(debug); }
  async readyMaterials(): Promise<void> { await Promise.all([...this.views.values()].map(view => view.readyMaterials())); }
  stepWind(nowSeconds: number, listener?: TerrainWindInterest, budget = 512): number {
    if (this.disposed) return 0;
    let remaining = Math.max(0, Math.min(512, Number.isFinite(budget) ? Math.floor(budget) : 512)), animated = 0;
    const views = [...this.views.values()].sort((a, b) => a.windDistance(listener) - b.windDistance(listener));
    for (const view of views) { const count = view.stepWind(nowSeconds, listener, remaining); animated += count; remaining -= count; }
    return animated;
  }
  windDistance(listener?: TerrainWindInterest): number {
    let distance = Infinity;
    for (const view of this.views.values()) distance = Math.min(distance, view.windDistance(listener));
    return distance;
  }
  inspection(): Record<string, unknown> {
    const chunks = [...this.views.entries()].map(([id, view]) => ({ id, ...view.inspection() }));
    const missing = [...new Set(chunks.flatMap(chunk => (chunk as Record<string, unknown>).missingAssets as string[] ?? []))];
    const atlases = chunks.flatMap(chunk => ((chunk as Record<string, unknown>).materials as { atlases?: ReturnType<TerrainMaterialAtlas['inspection']>[] } | undefined)?.atlases ?? []);
    const errors = atlases.flatMap(atlas => atlas.error ? [atlas.error] : []), densities = atlases.map(atlas => atlas.texelsPerMetre), resolutions = atlases.map(atlas => atlas.resolution);
    return { ...this.snapshot.inspection(), streaming: this.snapshot.streaming, renderedChunks: this.views.size,
      drawBatches: chunks.reduce((count, chunk) => count + Number((chunk as Record<string, unknown>).drawBatches ?? 0), 0),
      triangles: this.snapshot.chunks.reduce((count, chunk) => count + chunk.manifest.rows * chunk.manifest.columns * 2, 0),
      missingAssets: missing.slice(0, 8), missingAssetCount: missing.length,
      materials: { cache: this.materialCache.inspection(), atlasCount: atlases.length,
        pendingAtlases: atlases.filter(atlas => atlas.status === 'loading').length, readyAtlases: atlases.filter(atlas => atlas.status === 'ready').length,
        failedAtlases: atlases.filter(atlas => atlas.status === 'error').length, densityReducedAtlases: atlases.filter(atlas => atlas.densityReduced).length,
        texelsPerMetre: densities.length ? { min: Math.min(...densities), max: Math.max(...densities) } : null,
        resolution: resolutions.length ? { min: Math.min(...resolutions), max: Math.max(...resolutions) } : null,
        errorCount: errors.length, errors: [...new Set(errors)].slice(0, 8) },
      chunks: chunks.slice(0, 16), chunksTruncated: this.views.size > 16 };
  }
  dispose(): void {
    if (this.disposed) return;
    this.unregisterEnvironment?.(); this.unregisterEnvironment = undefined;
    for (const view of this.views.values()) view.dispose();
    if (this.ownsMaterialCache) this.materialCache.dispose();
    this.views.clear(); this.revisions.clear(); this.root.removeFromParent(); this.root.clear(); this.disposed = true;
  }
}
