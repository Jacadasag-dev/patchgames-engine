import {
  ArrayCamera, BatchedMesh, Box3, BoxGeometry, BufferAttribute, BufferGeometry, Camera, ConeGeometry, CylinderGeometry,Frustum,Matrix4,
  DirectionalLight, IcosahedronGeometry, InstancedBufferAttribute, InstancedBufferGeometry, InstancedInterleavedBuffer, InstancedMesh, Material, Mesh, MeshBasicMaterial,
  MeshDepthMaterial, MeshDistanceMaterial, MeshLambertMaterial, MeshMatcapMaterial, MeshNormalMaterial,
  MeshPhongMaterial, MeshStandardMaterial, MeshToonMaterial, Object3D, OrthographicCamera,
  PerspectiveCamera, PointLight, SkinnedMesh, Sphere, SphereGeometry, SpotLight, TorusGeometry, Vector3,
} from 'three';
import {readGeneratedMeshLod,readGeneratedExplicitMeshLod,selectGeneratedLodLevel,generatedLodMaterialSafe} from './generatedLod.ts';
import {isVoxelCoalescedGeometry,voxelMaterialCanMerge} from './voxelLod.ts';
import {isGeneratedAlphaShadowMaterial} from './generatedAlpha.ts';

type Primitive = SphereGeometry | CylinderGeometry | ConeGeometry | IcosahedronGeometry | TorusGeometry | BoxGeometry;
type ShadowLight = DirectionalLight | PointLight | SpotLight;
/** Reused by the render boundary so safety, LOD and batching share one walk of
 * the visible hierarchy, including the inherited Group rendering order. */
export interface RenderSceneItems {
  meshes: Mesh[];
  groupOrders: number[];
  shadowLights: ShadowLight[];
  generatedLodRoots?:Object3D[];
}
type AttributeStamp = { attribute: BufferAttribute; version: number; array: ArrayLike<number>; count: number; itemSize: number; normalized: boolean };
type GeometryStamp = { attributes: AttributeStamp[]; names: string[]; index: BufferAttribute | null; indexVersion: number };
type Variant = { geometry: BufferGeometry; error: number };
interface LodEntry {
  stamp: GeometryStamp;
  variants: Variant[];
  frame: number;
  release: () => void;
}
interface BoundsEntry {
  position: BufferAttribute; version: number; array: ArrayLike<number>; count: number; normalized: boolean;
  box: Box3; revision: number;
}
interface RejectedEntry { stamp: GeometryStamp; frame: number }
interface EligibilityEntry { frame: number; eligible: boolean; lodFrame: number; lod: boolean }
interface MeshEntry {
  mesh: Mesh;
  bounds: Box3;
  boundsFrame: number;
  localBounds: BoundsEntry | undefined;
  boundsRevision: number;
  world: Float64Array;
  intersects: Mesh['intersectsFrustum'];
  originalGeometry: BufferGeometry | undefined;
  level: number;
  previousSource: BufferGeometry | undefined;
  originalCount?:number;
}

const MAX_LOD_GEOMETRIES = 128;
const MAX_PRIMITIVE_VERTICES = 20_000;
const NEAR_DIAMETER_PIXELS = 96;
const ENTER_ERROR_PIXELS = .65;
const LEAVE_ERROR_PIXELS = 1;
const baseFrustumTest = Mesh.prototype.intersectsFrustum;
const automaticFrustumTests = new WeakSet<Mesh['intersectsFrustum']>();

/** Batching can replace engine-provided culling with its own per-instance bounds,
 * but must retain meshes with authored visibility callbacks in their own draws. */
export function hasDefaultRenderFrustum(mesh: Mesh): boolean {
  return mesh.intersectsFrustum === baseFrustumTest || automaticFrustumTests.has(mesh.intersectsFrustum);
}

/** Geometry changes and custom shaders can move vertices beyond their CPU bounds.
 * Such objects retain the authored rendering path, including authored culling. */
function rigidMaterial(material: Material): boolean {
  return (material instanceof MeshBasicMaterial || material instanceof MeshStandardMaterial
    || material instanceof MeshLambertMaterial || material instanceof MeshPhongMaterial
    || material instanceof MeshToonMaterial || material instanceof MeshMatcapMaterial
    || material instanceof MeshNormalMaterial || material instanceof MeshDepthMaterial
    || material instanceof MeshDistanceMaterial)
    && material.onBeforeRender === Material.prototype.onBeforeRender
    && material.onBeforeCompile === Material.prototype.onBeforeCompile
    && material.customProgramCacheKey === Material.prototype.customProgramCacheKey
    && !('displacementMap' in material && material.displacementMap);
}

function rigidGeometry(geometry: BufferGeometry): boolean {
  if (geometry instanceof InstancedBufferGeometry) return false;
  for (const key in geometry.morphAttributes) if (Object.hasOwn(geometry.morphAttributes, key)) return false;
  for (const key in geometry.attributes) {
    const attribute = geometry.attributes[key];
    if (attribute instanceof InstancedBufferAttribute || 'data' in attribute && attribute.data instanceof InstancedInterleavedBuffer) return false;
  }
  return true;
}

function rigidMesh(object: Object3D, materialEligible: (material: Material) => boolean,
  geometryEligible: (geometry: BufferGeometry) => boolean): object is Mesh {
  if (!(object instanceof Mesh) || object instanceof InstancedMesh || object instanceof SkinnedMesh || object instanceof BatchedMesh
    || !object.frustumCulled || object.intersectsFrustum !== baseFrustumTest
    || object.customDepthMaterial&&!isGeneratedAlphaShadowMaterial(object.customDepthMaterial) || object.customDistanceMaterial&&!isGeneratedAlphaShadowMaterial(object.customDistanceMaterial)
    || object.onBeforeRender !== Object3D.prototype.onBeforeRender
    || object.onAfterRender !== Object3D.prototype.onAfterRender
    || object.onBeforeShadow !== Object3D.prototype.onBeforeShadow
    || object.onAfterShadow !== Object3D.prototype.onAfterShadow || !geometryEligible(object.geometry)) return false;
  return Array.isArray(object.material) ? object.material.every(materialEligible) : materialEligible(object.material);
}

/** Prepared generator banks explicitly support their own topology. No arbitrary
 * skinned, shader-deformed or instanced asset is inferred from constructor data. */
function preparedMaterial(material:Material,voxel=false):boolean{
  return generatedLodMaterialSafe(material)&&(!voxel||voxelMaterialCanMerge(material));
}
function preparedMesh(object:Object3D):object is Mesh{
  if(!(object instanceof Mesh)||object instanceof SkinnedMesh||object instanceof BatchedMesh
    ||object instanceof InstancedMesh&&!readGeneratedExplicitMeshLod(object)
    ||!readGeneratedMeshLod(object)||!object.frustumCulled||object.intersectsFrustum!==baseFrustumTest
    ||object.customDepthMaterial&&!isGeneratedAlphaShadowMaterial(object.customDepthMaterial)||object.customDistanceMaterial&&!isGeneratedAlphaShadowMaterial(object.customDistanceMaterial)
    ||object.onBeforeRender!==Object3D.prototype.onBeforeRender||object.onAfterRender!==Object3D.prototype.onAfterRender
    ||object.onBeforeShadow!==Object3D.prototype.onBeforeShadow||object.onAfterShadow!==Object3D.prototype.onAfterShadow)return false;
  const voxel=isVoxelCoalescedGeometry(object.geometry);
  if(!Array.isArray(object.material))return preparedMaterial(object.material,voxel);
  const palette=object.material,groups=object.geometry.groups;
  return groups.length>0&&groups.every((group:{start:number;count:number;materialIndex?:number})=>group.count===0||Number.isInteger(group.materialIndex??0)&&(group.materialIndex??0)>=0&&(group.materialIndex??0)<palette.length&&preparedMaterial(palette[group.materialIndex??0],voxel));
}

/** Affine center/extents transform avoids transforming eight temporary corners.
 * It also handles negative scale and shear from nested nonuniform transforms. */
function worldBounds(local: Box3, world: Box3, mesh: Mesh): Box3 {
  const e = mesh.matrixWorld.elements;
  if (e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1) return world.copy(local).applyMatrix4(mesh.matrixWorld);
  const x = (local.min.x + local.max.x) * .5, y = (local.min.y + local.max.y) * .5, z = (local.min.z + local.max.z) * .5;
  const hx = (local.max.x - local.min.x) * .5, hy = (local.max.y - local.min.y) * .5, hz = (local.max.z - local.min.z) * .5;
  const cx = e[0] * x + e[4] * y + e[8] * z + e[12], cy = e[1] * x + e[5] * y + e[9] * z + e[13], cz = e[2] * x + e[6] * y + e[10] * z + e[14];
  const dx = Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
  const dy = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
  const dz = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;
  world.min.set(cx - dx, cy - dy, cz - dz); world.max.set(cx + dx, cy + dy, cz + dz); return world;
}

function stampGeometry(geometry: BufferGeometry): GeometryStamp | undefined {
  const names = Object.keys(geometry.attributes), attributes: AttributeStamp[] = [];
  for (const name of names) {
    const attribute = geometry.getAttribute(name);
    if (!(attribute instanceof BufferAttribute)) return;
    attributes.push({ attribute, version: attribute.version, array: attribute.array, count: attribute.count, itemSize: attribute.itemSize, normalized: attribute.normalized });
  }
  return { names, attributes, index: geometry.index, indexVersion: geometry.index?.version ?? -1 };
}

function unchanged(geometry: BufferGeometry, stamp: GeometryStamp): boolean {
  if (geometry.index !== stamp.index || (geometry.index?.version ?? -1) !== stamp.indexVersion
    || Object.keys(geometry.attributes).length !== stamp.names.length) return false;
  for (let index = 0; index < stamp.names.length; index++) {
    const attribute = geometry.getAttribute(stamp.names[index]), previous = stamp.attributes[index];
    if (attribute !== previous.attribute || attribute.version !== previous.version || attribute.array !== previous.array
      || attribute.count !== previous.count || attribute.itemSize !== previous.itemSize || attribute.normalized !== previous.normalized) return false;
  }
  return true;
}

function sameAttribute(a: BufferAttribute | null, b: BufferAttribute | null): boolean {
  if (!a || !b) return a === b;
  if (a.itemSize !== b.itemSize || a.normalized !== b.normalized || a.array.length !== b.array.length) return false;
  for (let index = 0; index < a.array.length; index++) if (a.array[index] !== b.array[index]) return false;
  return true;
}

/** Constructor parameters alone are insufficient: authored primitive geometries
 * are often translated, rotated or edited after construction. Verify all vertex
 * attributes and indices against a fresh primitive before generating any LOD. */
function pristine(geometry: BufferGeometry, original: BufferGeometry): boolean {
  const names = Object.keys(geometry.attributes);
  if (names.length !== Object.keys(original.attributes).length || !sameAttribute(geometry.index, original.index)) return false;
  for (const name of names) {
    const a = geometry.getAttribute(name), b = original.getAttribute(name);
    if (!(a instanceof BufferAttribute) || !(b instanceof BufferAttribute) || !sameAttribute(a, b)) return false;
  }
  return true;
}

function primitive(geometry: BufferGeometry, level: number): Variant | undefined {
  const divisor = 2 ** level, segments = (value: number, minimum: number) => Math.max(minimum, Math.floor(value / divisor));
  if (geometry instanceof SphereGeometry) {
    const p = geometry.parameters, width = segments(p.widthSegments, 8), height = segments(p.heightSegments, 6);
    return { geometry: new SphereGeometry(p.radius, level ? width : p.widthSegments, level ? height : p.heightSegments,
      p.phiStart, p.phiLength, p.thetaStart, p.thetaLength), error: (1 - Math.cos(Math.PI / width)) + (1 - Math.cos(Math.PI / (2 * height))) };
  }
  if (geometry instanceof ConeGeometry) {
    const p = geometry.parameters, radial = segments(p.radialSegments, 6);
    return { geometry: new ConeGeometry(p.radius, p.height, level ? radial : p.radialSegments,
      level ? 1 : p.heightSegments, p.openEnded, p.thetaStart, p.thetaLength), error: 1 - Math.cos(Math.PI / radial) };
  }
  if (geometry instanceof CylinderGeometry) {
    const p = geometry.parameters, radial = segments(p.radialSegments, 6);
    return { geometry: new CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, level ? radial : p.radialSegments,
      level ? 1 : p.heightSegments, p.openEnded, p.thetaStart, p.thetaLength), error: 1 - Math.cos(Math.PI / radial) };
  }
  if (geometry instanceof IcosahedronGeometry) {
    const p = geometry.parameters, detail = Math.max(0, p.detail - level);
    // The bound is deliberately above the icosahedron face sagitta and remains
    // conservative for Three's normalized, uniformly subdivided face grid.
    return { geometry: new IcosahedronGeometry(p.radius, detail), error: .3 / (detail + 1) ** 2 };
  }
  if (geometry instanceof TorusGeometry) {
    const p = geometry.parameters, radial = segments(p.radialSegments, 6), tubular = segments(p.tubularSegments, 12);
    return { geometry: new TorusGeometry(p.radius, p.tube, level ? radial : p.radialSegments, level ? tubular : p.tubularSegments,
      p.arc, p.thetaStart, p.thetaLength), error: (1 - Math.cos(Math.PI / radial)) + (1 - Math.cos(Math.PI / tubular)) };
  }
  if (geometry instanceof BoxGeometry) {
    const p = geometry.parameters;
    return { geometry: new BoxGeometry(p.width, p.height, p.depth, level ? 1 : p.widthSegments,
      level ? 1 : p.heightSegments, level ? 1 : p.depthSegments), error: 0 };
  }
}

function isPrimitive(geometry: BufferGeometry): geometry is Primitive {
  return geometry instanceof SphereGeometry || geometry instanceof CylinderGeometry || geometry instanceof ConeGeometry
    || geometry instanceof IcosahedronGeometry || geometry instanceof TorusGeometry || geometry instanceof BoxGeometry;
}

function canReduce(geometry: Primitive): boolean {
  if (geometry instanceof BoxGeometry) {
    const p = geometry.parameters; return p.widthSegments > 1 || p.heightSegments > 1 || p.depthSegments > 1;
  }
  if (geometry instanceof SphereGeometry) return geometry.parameters.widthSegments > 8 || geometry.parameters.heightSegments > 6;
  if (geometry instanceof CylinderGeometry || geometry instanceof ConeGeometry) return geometry.parameters.radialSegments > 6 || geometry.parameters.heightSegments > 1;
  if (geometry instanceof IcosahedronGeometry) return geometry.parameters.detail > 0;
  return geometry.parameters.radialSegments > 6 || geometry.parameters.tubularSegments > 12;
}

function primitiveCandidate(geometry: BufferGeometry): geometry is Primitive {
  if (!isPrimitive(geometry) || !canReduce(geometry)) return false;
  const values = Object.values(geometry.parameters);
  return values.every(value => typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))
    && values.every(value => typeof value !== 'number' || Math.abs(value) <= 10_000)
    && geometry.getAttribute('position')?.count <= MAX_PRIMITIVE_VERTICES
    && (!('detail' in geometry.parameters) || geometry.parameters.detail <= 12)
    && geometry.drawRange.start === 0 && geometry.drawRange.count === Infinity;
}

function indexCount(geometry: BufferGeometry): number { return geometry.index?.count ?? geometry.getAttribute('position').count; }

/** Automatic, conservative visibility and primitive LOD, installed by the worker
 * render boundary. The scene is restored after every render so authored updates,
 * inspection and raycasts always see the original full-detail geometry.
 *
 * Culling uses each renderer-supplied main/shadow frustum. It never hides an
 * offscreen object globally, which would incorrectly remove its visible shadow.
 * LOD is bounded by projected error, includes shadow-map pixel size, and never
 * rewrites arbitrary imported, morphed or shader-deformed meshes. */
export class RenderVisibility {
  private readonly lod = new Map<BufferGeometry, LodEntry>();
  private rejected = new WeakMap<BufferGeometry, RejectedEntry>();
  private bounds = new WeakMap<BufferGeometry, BoundsEntry>();
  private materialEligibility = new WeakMap<Material, EligibilityEntry>();
  private geometryEligibility = new WeakMap<BufferGeometry, EligibilityEntry>();
  private meshes = new WeakMap<Mesh, MeshEntry>();
  private readonly changed: MeshEntry[] = [];
  private readonly candidates: Mesh[] = [];
  private readonly lights: ShadowLight[] = [];
  private readonly sphere = new Sphere();
  private readonly center = new Vector3();
  private readonly shadowMatrix=new Matrix4();
  private readonly shadowVolumes=new WeakMap<DirectionalLight,Frustum>();
  private frame = 0;
  private lodMeshes = 0;
  private preparedLodMeshes=0;
  private estimatedTrianglesSaved=0;
  private culledTests = 0;
  private testedMeshes = 0;
  private disposed = false;
  // Eligibility is re-read every prepare: material callbacks, displacement maps
  // and geometry attributes are mutable. Sharing the result within this one
  // synchronous scene walk avoids repeating it for every reused actor material.
  private readonly materialEligible = (material: Material): boolean => {
    let entry = this.materialEligibility.get(material);
    if (!entry) { entry = { frame: -1, eligible: false, lodFrame: -1, lod: false }; this.materialEligibility.set(material, entry); }
    if (entry.frame !== this.frame) { entry.frame = this.frame; entry.eligible = rigidMaterial(material); }
    return entry.eligible;
  };
  private readonly geometryEligible = (geometry: BufferGeometry): boolean => {
    let entry = this.geometryEligibility.get(geometry);
    if (!entry) { entry = { frame: -1, eligible: false, lodFrame: -1, lod: false }; this.geometryEligibility.set(geometry, entry); }
    if (entry.frame !== this.frame) { entry.frame = this.frame; entry.eligible = rigidGeometry(geometry); }
    return entry.eligible;
  };

  private geometryCanReduce(geometry: BufferGeometry): boolean {
    const entry = this.geometryEligibility.get(geometry)!;
    if (entry.lodFrame !== this.frame) {
      entry.lodFrame = this.frame;
      entry.lod = isPrimitive(geometry) && canReduce(geometry) && geometry.drawRange.start === 0 && geometry.drawRange.count === Infinity;
    }
    return entry.lod;
  }

  private materialCanReduce(material: Material): boolean {
    const entry = this.materialEligibility.get(material)!;
    if (entry.lodFrame !== this.frame) {
      entry.lodFrame = this.frame;
      // A getter can return a different value for each draw. Only native data
      // properties may be shared across candidates; authored accessors keep
      // their full geometry and are never evaluated by this classification.
      const transparent = Object.getOwnPropertyDescriptor(material, 'transparent');
      const wireframe = Object.getOwnPropertyDescriptor(material, 'wireframe');
      entry.lod = !!transparent && 'value' in transparent && !transparent.value
        && (wireframe ? 'value' in wireframe && !wireframe.value : !('wireframe' in material));
    }
    return entry.lod;
  }

  get stats(): Readonly<{ lodMeshes: number; preparedLodMeshes:number;estimatedTrianglesSaved:number;frustumMeshes: number; rejectedFrustumTests: number; cachedGeometries: number }> {
    return { lodMeshes: this.lodMeshes,preparedLodMeshes:this.preparedLodMeshes,estimatedTrianglesSaved:this.estimatedTrianglesSaved, frustumMeshes: this.testedMeshes, rejectedFrustumTests: this.culledTests, cachedGeometries: this.lod.size };
  }

  private localBounds(geometry: BufferGeometry): BoundsEntry | undefined {
    const position = geometry.getAttribute('position');
    if (!(position instanceof BufferAttribute) || position.itemSize !== 3) return;
    let entry = this.bounds.get(geometry);
    if (!entry || entry.position !== position || entry.version !== position.version || entry.array !== position.array
      || entry.count !== position.count || entry.normalized !== position.normalized) {
      const box = entry?.box ?? new Box3(); box.setFromBufferAttribute(position);
      entry = { position, version: position.version, array: position.array, count: position.count, normalized: position.normalized,
        box, revision: (entry?.revision ?? 0) + 1 }; this.bounds.set(geometry, entry);
    }
    return entry;
  }

  private updateBounds(entry: MeshEntry): boolean {
    if (entry.boundsFrame === this.frame) return true;
    const bounds = this.localBounds(entry.mesh.geometry);
    if (!bounds || bounds.box.isEmpty()) return false;
    const world = entry.mesh.matrixWorld.elements;
    let changed = entry.localBounds !== bounds || entry.boundsRevision !== bounds.revision;
    for (let index = 0; index < 16 && !changed; index++) if (entry.world[index] !== world[index]) changed = true;
    if (changed) {
      worldBounds(bounds.box, entry.bounds, entry.mesh); entry.world.set(world);
      entry.localBounds = bounds; entry.boundsRevision = bounds.revision;
    }
    entry.boundsFrame = this.frame; return true;
  }

  private variants(geometry: BufferGeometry): LodEntry | undefined {
    const cached = this.lod.get(geometry);
    if (cached && (cached.frame === this.frame || unchanged(geometry, cached.stamp))) { cached.frame = this.frame; return cached; }
    if (cached) cached.release();
    const rejected = this.rejected.get(geometry);
    if (rejected && (rejected.frame === this.frame || unchanged(geometry, rejected.stamp))) { rejected.frame = this.frame; return; }
    const stamp = stampGeometry(geometry);
    if (!stamp || !primitiveCandidate(geometry)) return;
    // Reject suspicious parameter edits before reconstructing a large primitive.
    const p = geometry.parameters;
    const segments = Object.entries(p).filter(([key]) => key.endsWith('Segments')).map(([, value]) => Math.max(1, Number(value)));
    if (segments.reduce((a, b) => a * b, 1) > MAX_PRIMITIVE_VERTICES) { this.rejected.set(geometry, { stamp, frame: this.frame }); return; }
    const original = primitive(geometry, 0)!;
    const valid = pristine(geometry, original.geometry); original.geometry.dispose();
    if (!valid) { this.rejected.set(geometry, { stamp, frame: this.frame }); return; }
    if (this.lod.size >= MAX_LOD_GEOMETRIES) {
      let oldest: LodEntry | undefined;
      for (const entry of this.lod.values()) if (entry.frame !== this.frame && (!oldest || entry.frame < oldest.frame)) oldest = entry;
      if (!oldest) return;
      oldest.release();
    }
    const variants: Variant[] = [];
    let previousCount = indexCount(geometry);
    for (const level of [1, 2]) {
      const variant = primitive(geometry, level)!;
      const count = indexCount(variant.geometry);
      if (count >= previousCount) { variant.geometry.dispose(); continue; }
      previousCount = count; variants.push(variant);
    }
    if (!variants.length) { this.rejected.set(geometry, { stamp, frame: this.frame }); return; }
    let released = false;
    const entry: LodEntry = { stamp, variants, frame: this.frame, release: () => {
      if (released) return;
      released = true;
      geometry.removeEventListener('dispose', entry.release);
      this.lod.delete(geometry);
      let failed = false, failure: unknown;
      for (const variant of variants) {
        try { variant.geometry.dispose(); }
        catch (error) { if (!failed) { failed = true; failure = error; } }
      }
      if (failed) throw failure;
    } };
    geometry.addEventListener('dispose', entry.release); this.lod.set(geometry, entry); return entry;
  }

  private diameter(camera: Camera, pixels: number, sphere: Sphere): number {
    // One eye/subcamera can be much closer than the array camera's own transform.
    // Its renderer-provided FrustumArray still receives the tighter box culling.
    if (camera instanceof ArrayCamera) return Infinity;
    if (camera instanceof OrthographicCamera) return 2 * sphere.radius * Math.abs(camera.projectionMatrix.elements[5]) * pixels / 2;
    if (!(camera instanceof PerspectiveCamera)) return Infinity;
    this.center.copy(sphere.center).applyMatrix4(camera.matrixWorldInverse);
    const depth = -this.center.z - sphere.radius;
    return depth > camera.near ? sphere.radius * Math.abs(camera.projectionMatrix.elements[5]) * pixels / depth : Infinity;
  }

  private shadowDiameter(sphere: Sphere): number {
    let diameter = 0;
    for (const light of this.lights) {
      const camera = light.shadow.camera, pixels = Math.max(light.shadow.mapSize.x, light.shadow.mapSize.y);
      if(light instanceof DirectionalLight&&!this.shadowVolumes.get(light)?.intersectsSphere(sphere))continue;
      if (camera instanceof OrthographicCamera) {
        diameter = Math.max(diameter, sphere.radius * Math.max(Math.abs(camera.projectionMatrix.elements[0]), Math.abs(camera.projectionMatrix.elements[5])) * pixels);
      } else {
        this.center.setFromMatrixPosition(light.matrixWorld);
        const distance = this.center.distanceTo(sphere.center) - sphere.radius;
        // A point cube face can meet the sphere at up to sqrt(3) times its axial
        // distance; use that conservative factor rather than a stale face camera.
        const focal = light instanceof SpotLight ? 1 / Math.tan(light.angle * light.shadow.focus) : Math.sqrt(3);
        diameter = Math.max(diameter, distance > 0 ? sphere.radius * focal * pixels / distance : Infinity);
      }
    }
    return diameter;
  }

  prepare(scene: Object3D, camera: Camera, viewportHeightPixels: number, items?: RenderSceneItems,lodEnabled=true,matricesReady=false): void {
    if (this.disposed) return;
    this.restore(); this.frame++; this.lodMeshes = this.culledTests = this.testedMeshes =this.preparedLodMeshes=this.estimatedTrianglesSaved= 0;
    if (scene.onBeforeRender !== Object3D.prototype.onBeforeRender || !Number.isFinite(viewportHeightPixels) || viewportHeightPixels <= 0) return;
    if (!matricesReady&&scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (!matricesReady&&!camera.parent && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
    this.candidates.length = 0;
    if (items) {
      for (const light of items.shadowLights) this.lights.push(light);
    } else scene.traverseVisible(object => {
      if (object.castShadow && (object instanceof DirectionalLight || object instanceof PointLight || object instanceof SpotLight)) this.lights.push(object);
      if (preparedMesh(object)||rigidMesh(object, this.materialEligible, this.geometryEligible)) this.candidates.push(object);
    });
    for(const light of this.lights)if(light instanceof DirectionalLight){let volume=this.shadowVolumes.get(light);if(!volume){volume=new Frustum();this.shadowVolumes.set(light,volume);}light.shadow.updateMatrices(light);this.shadowMatrix.multiplyMatrices(light.shadow.camera.projectionMatrix,light.shadow.camera.matrixWorldInverse);volume.setFromProjectionMatrix(this.shadowMatrix);}
    // Traverse the bone/socket hierarchy once. The second pass only processes
    // eligible meshes, using the complete set of shadow lights found above.
    for (const object of items?.meshes ?? this.candidates) {
      const prepared=preparedMesh(object);
      if (items && !prepared&&!rigidMesh(object, this.materialEligible, this.geometryEligible)) continue;
      const source = object.geometry;
      let mesh = this.meshes.get(object);
      if (!mesh) {
        const bounds = new Box3();
        const entry: MeshEntry = { mesh: object, bounds, boundsFrame: -1, localBounds: undefined, boundsRevision: -1, world: new Float64Array(16), originalGeometry: undefined, previousSource: undefined, level: -1,
          intersects: frustum => {
            // Batched source objects are never rendered, so their box transforms
            // are never computed. Remaining meshes only pay for a tighter box
            // after the ordinary broad sphere test accepts them.
            const visible = baseFrustumTest.call(object, frustum)
              && (!this.updateBounds(entry) || frustum.intersectsBox(bounds));
            if (!visible) this.culledTests++;
            return visible;
          } };
        mesh = entry;
        this.meshes.set(object, mesh);
        automaticFrustumTests.add(mesh.intersects);
      }
      if (mesh.previousSource !== source) mesh.level = -1;
      mesh.previousSource = source;
      const bank=prepared&&lodEnabled?readGeneratedMeshLod(object):undefined;
      if(bank){
        // Instanced leaves use their actual combined bounds, not one card at
        // object origin. The prepared bounds include the complete near canopy.
        if(object instanceof InstancedMesh){if(!object.boundingSphere)object.computeBoundingSphere();this.sphere.copy(object.boundingSphere!).applyMatrix4(object.matrixWorld);}
        else{if(!this.updateBounds(mesh))continue;mesh.bounds.getBoundingSphere(this.sphere);}
        let diameter=this.diameter(camera,viewportHeightPixels,this.sphere);
        if(object.castShadow)diameter=Math.max(diameter,this.shadowDiameter(this.sphere));
        const level=selectGeneratedLodLevel(bank,diameter,Math.max(0,mesh.level),object instanceof InstancedMesh?96:0),selected=bank[level];
        mesh.level=level;
        if(level>0){const sourceCount=object instanceof InstancedMesh?object.count:1;mesh.originalGeometry=source;object.geometry=selected.geometry;if(object instanceof InstancedMesh&&selected.instanceCount!==undefined){mesh.originalCount=object.count;object.count=selected.instanceCount;}mesh.boundsFrame=-1;this.lodMeshes++;this.preparedLodMeshes++;this.estimatedTrianglesSaved+=Math.max(0,(indexCount(source)*sourceCount-indexCount(selected.geometry)*(object instanceof InstancedMesh?object.count:1))/3);}
        // InstancedMesh provides aggregate culling; do not replace it with the
        // per-geometry tight box used for ordinary rigid meshes.
        if(!(object instanceof InstancedMesh)){object.intersectsFrustum=mesh.intersects;this.testedMeshes++;}
        this.changed.push(mesh);continue;
      }
      // Most rigid primitives already have their minimum topology. Test that
      // once per geometry before touching material state, then share material
      // suitability across all its LOD candidates in this synchronous pass.
      if (lodEnabled&&!(object instanceof InstancedMesh)&&this.geometryCanReduce(source) && !Array.isArray(object.material) && this.materialCanReduce(object.material)) {
        if (!this.updateBounds(mesh)) continue;
        mesh.bounds.getBoundingSphere(this.sphere);
        let diameter = this.diameter(camera, viewportHeightPixels, this.sphere);
        if (object.castShadow || object.receiveShadow) diameter = Math.max(diameter, this.shadowDiameter(this.sphere));
        let level = -1;
        if (diameter < NEAR_DIAMETER_PIXELS) {
          const variants = this.variants(source)?.variants;
          if (variants) for (let index = 0; index < variants.length; index++) {
            const allowance = mesh.level === index ? LEAVE_ERROR_PIXELS : ENTER_ERROR_PIXELS;
            if (diameter * .5 * variants[index].error <= allowance) level = index;
          }
          if (variants && level >= 0) {
            mesh.originalGeometry = source; object.geometry = variants[level].geometry;
            // Culling will compute the selected geometry's exact bounds lazily;
            // new extrema may differ from the original primitive's sample grid.
            mesh.boundsFrame = -1;
            this.lodMeshes++;
          }
        }
        mesh.level = level;
      }
      if(object instanceof InstancedMesh)continue;
      object.intersectsFrustum = mesh.intersects;
      this.changed.push(mesh); this.testedMeshes++;
    }
  }

  restore(): void {
    for (let index = this.changed.length - 1; index >= 0; index--) {
      const entry = this.changed[index];
      if (entry.originalGeometry) { entry.mesh.geometry = entry.originalGeometry; entry.originalGeometry = undefined; }
      if(entry.originalCount!==undefined&&entry.mesh instanceof InstancedMesh){entry.mesh.count=entry.originalCount;entry.originalCount=undefined;}
      if (entry.mesh.intersectsFrustum === entry.intersects) entry.mesh.intersectsFrustum = baseFrustumTest;
    }
    this.changed.length = 0; this.lights.length = 0; this.candidates.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    let failed = false, failure: unknown;
    try { this.restore(); }
    catch (error) { failed = true; failure = error; }
    for (const entry of this.lod.values()) {
      try { entry.release(); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
    this.lod.clear(); this.changed.length = this.lights.length = this.candidates.length = 0;
    this.rejected = new WeakMap(); this.bounds = new WeakMap(); this.materialEligibility = new WeakMap();
    this.geometryEligibility = new WeakMap(); this.meshes = new WeakMap();
    this.lodMeshes = this.culledTests = this.testedMeshes =this.preparedLodMeshes=this.estimatedTrianglesSaved= 0;
    if (failed) throw failure;
  }
}
