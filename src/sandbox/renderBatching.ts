import {
  BatchedMesh, BufferAttribute, BufferGeometry, DynamicDrawUsage, FloatType, Group, InstancedMesh, Material,
  Matrix4, Mesh, NoBlending, NormalBlending, Object3D, Scene, type Camera, type InterleavedBufferAttribute,
} from 'three';
import { hasDefaultRenderFrustum, type RenderSceneItems } from './renderVisibility.ts';
import { RenderMaterialIdentity } from './renderMaterialIdentity.ts';
import { RenderGeometryIdentity } from './renderGeometryIdentity.ts';
import { registerEngineRenderProxy } from './renderProxyIdentity.ts';

const CELL_SIZE = 24;
const MIN_GROUP = 3;
const MAX_MEMBERS = 256;
const MAX_GROUPS = 256;
const MAX_IDLE_FRAMES = 120;
const MAX_GEOMETRY_VERTICES = 32_768;
const MAX_BATCH_VERTICES = 131_072;
const MAX_RETAINED_VERTICES = 1_048_576;
const MATERIAL_TYPES = new Set(['MeshBasicMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshToonMaterial', 'MeshNormalMaterial']);
const IDENTITY = new Matrix4();
interface AttributeStamp { name: string; attribute: BufferAttribute | InterleavedBufferAttribute; version: number; count: number; itemSize: number; normalized: boolean; array: ArrayLike<number>; arrayConstructor: Function; gpuType: number }

function attributeArrayLayout(array: unknown): string | undefined {
  // Match WebGL's native scalar formats. BatchedMesh also constructs its private
  // arrays with array.constructor; authored subclasses/constructor overrides can
  // change that allocation or conversion, so they keep their ordinary draws.
  if (array instanceof Float32Array && array.constructor === Float32Array) return 'f32';
  if (array instanceof Int8Array && array.constructor === Int8Array) return 'i8';
  if (array instanceof Uint8Array && array.constructor === Uint8Array) return 'u8';
  if (array instanceof Uint8ClampedArray && array.constructor === Uint8ClampedArray) return 'u8c';
  if (array instanceof Int16Array && array.constructor === Int16Array) return 'i16';
  if (array instanceof Uint16Array && array.constructor === Uint16Array) return 'u16';
  if (array instanceof Int32Array && array.constructor === Int32Array) return 'i32';
  if (array instanceof Uint32Array && array.constructor === Uint32Array) return 'u32';
}

interface GeometryState {
  frame: number;
  revision: number;
  identity: number;
  attributes: AttributeStamp[];
  index: BufferAttribute | null;
  indexVersion: number;
  indexCount: number;
  indexArray: ArrayLike<number> | null;
  drawStart: number;
  drawCount: number;
  layout: number;
  vertices: number;
  indices: number;
  valid: boolean;
}
interface GeometryMembers { meshes: Mesh[]; frame: number; count: number; active: boolean }
interface BucketDraw { key: string; meshes: Mesh[]; start: number; count: number; instanced: boolean }
interface Bucket {
  meshes: Mesh[]; geometries: Map<number, GeometryMembers>; remaining: Mesh[]; draws: BucketDraw[];
  frame: number; count: number; dirty: boolean; active: boolean;
}
interface MeshKey {
  material: number; layout: number; x: number; y: number; z: number; layers: number; groupOrder: number; renderOrder: number; flags: number; key: string;
  bucket?: Bucket; members?: GeometryMembers; geometryIdentity: number;
  world: Float64Array; local: Matrix4; rootRevision: number; transformRevision: number; transformValid: boolean;
}
interface MaterialState { frame: number; id: number; valid: boolean }
interface GroupPlan {
  root: Group;
  proxy: InstancedMesh | BatchedMesh;
  sources: Mesh[];
  geometries: BufferGeometry[];
  revisions: number[];
  geometryIds: Map<BufferGeometry, number>;
  instanceGeometries: BufferGeometry[];
  instanceCount: number;
  capacity: number;
  vertices: number;
  used: boolean;
  needed: boolean;
  lastUsed: number;
  retainedSources: Mesh[];
  transforms: Float32Array;
  transformRevisions: number[];
  updateRange: { start: number; count: number };
}

export interface RenderBatchingStats {
  eligibleMeshes: number;
  instancedMeshes: number;
  batchedMeshes: number;
  instanceGroups: number;
  batchGroups: number;
  retainedGroups: number;
  /** Lifetime counters let diagnostics distinguish reuse from resource churn. */
  createdGroups: number;
  disposedGroups: number;
}

/** Render-only proxies keep authored objects, animation transforms, raycast IDs,
 * and inspection geometry intact. Equivalent material values and render state
 * delimit groups; spatial cells keep one distant object from retaining a world.
 * No author opt-in is required. Unsupported semantics keep their ordinary draw.
 * The owner must restore in finally, and dispose with its renderer. */
export class RenderBatching {
  readonly stats: RenderBatchingStats = {
    eligibleMeshes: 0, instancedMeshes: 0, batchedMeshes: 0,
    instanceGroups: 0, batchGroups: 0, retainedGroups: 0, createdGroups: 0, disposedGroups: 0,
  };
  private readonly buckets = new Map<string, Bucket>();
  private readonly plans = new Map<string, GroupPlan>();
  private readonly geometryStates = new WeakMap<BufferGeometry, GeometryState>();
  private readonly layouts = new Map<string, number>();
  private readonly meshKeys = new WeakMap<Mesh, MeshKey>();
  private readonly materials = new WeakMap<Material, MaterialState>();
  private readonly materialIdentities = new RenderMaterialIdentity();
  private readonly geometryIdentities = new RenderGeometryIdentity();
  private readonly inverse = new Matrix4();
  private readonly sceneWorld = new Matrix4();
  private readonly root = new Group();
  private readonly applied: GroupPlan[] = [];
  private frame = 0;
  private retainedVertices = 0;
  private identityRoot = true;
  private rootRevision = 0;
  private disposed = false;

  constructor() {
    this.root.name = 'engine.render-proxy'; this.root.matrixAutoUpdate = false; this.root.layers.enableAll();
  }

  prepare(scene: Object3D, camera: Camera, items?: RenderSceneItems): void {
    if (this.disposed) return;
    this.restore();
    this.frame++;
    Object.assign(this.stats, { eligibleMeshes: 0, instancedMeshes: 0, batchedMeshes: 0, instanceGroups: 0, batchGroups: 0 });
    for (const plan of this.plans.values()) { plan.used = false; plan.needed = false; }
    // A scene callback can change geometry, visibility or transforms after this
    // preparation. Render it normally rather than freezing its earlier state.
    if (scene.onBeforeRender !== Object3D.prototype.onBeforeRender
      || scene.onAfterRender !== Object3D.prototype.onAfterRender
      || scene instanceof Scene && scene.overrideMaterial) { this.sweep(scene); return; }
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (scene.matrixWorld.determinant() <= 0) { this.sweep(scene); return; }
    if (!this.rootRevision || !this.sceneWorld.equals(scene.matrixWorld)) {
      this.sceneWorld.copy(scene.matrixWorld); this.inverse.copy(scene.matrixWorld).invert();
      this.identityRoot = scene.matrixWorld.equals(IDENTITY); this.rootRevision++;
    }
    if (items) {
      for (let index = 0; index < items.meshes.length; index++) this.collectMesh(items.meshes[index], items.groupOrders[index]);
    } else this.collect(scene, 0, camera.layers.mask);
    for (const [key, bucket] of this.buckets) {
      if (bucket.frame !== this.frame) continue;
      if (bucket.meshes.length !== bucket.count) { bucket.meshes.length = bucket.count; bucket.dirty = true; }
      for (const [identity, members] of bucket.geometries) {
        if (members.frame !== this.frame) {
          members.active = false; members.meshes.length = 0; bucket.geometries.delete(identity); bucket.dirty = true;
        } else if (members.meshes.length !== members.count) { members.meshes.length = members.count; bucket.dirty = true; }
      }
      if (bucket.dirty) this.partition(key, bucket);
      for (const draw of bucket.draws) {
        const plan = this.plans.get(draw.key);
        if (plan) plan.needed = true;
      }
    }
    // Protect every scheduled plan before a new group can evict dormant ones.
    for (const bucket of this.buckets.values()) if (bucket.frame === this.frame) {
      for (const draw of bucket.draws) this.apply(draw.key, draw.meshes, draw.start, draw.count, draw.instanced, scene);
    }
    this.sweep(scene);
    // All retained groups share one private parent. Reparent the container once,
    // rather than splicing the authored scene's children for every batch.
    if (this.applied.length) { scene.add(this.root); this.root.updateWorldMatrix(false, true, true); }
  }

  restore(): void {
    let failed = false, failure: unknown;
    for (const plan of this.applied) {
      for (const source of plan.sources) source.visible = true;
    }
    try { this.root.removeFromParent(); }
    catch (error) { failed = true; failure = error; }
    this.applied.length = 0;
    if (failed) throw failure;
  }

  dispose(): void {
    this.disposed = true;
    let failed = false, failure: unknown;
    try { this.restore(); }
    catch (error) { failed = true; failure = error; }
    // A user listener or a driver cleanup failure must not strand unrelated
    // private buffers. Release every plan, clear ownership, then report the first
    // failure; the separate flag also preserves a literal `throw undefined`.
    for (const [key, plan] of this.plans) {
      try { this.releasePlan(key, plan); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
    this.plans.clear();
    for (const bucket of this.buckets.values()) this.releaseBucket(bucket);
    this.buckets.clear(); this.layouts.clear(); this.retainedVertices = 0;
    this.materialIdentities.dispose(); this.geometryIdentities.dispose();
    Object.assign(this.stats, { eligibleMeshes: 0, instancedMeshes: 0, batchedMeshes: 0, instanceGroups: 0, batchGroups: 0, retainedGroups: 0 });
    if (failed) throw failure;
  }

  private collect(object: Object3D, groupOrder: number, cameraLayers: number): void {
    if (!object.visible) return;
    if (object instanceof Group && (object.layers.mask & cameraLayers) !== 0) groupOrder = object.renderOrder;
    if (object instanceof Mesh) this.collectMesh(object, groupOrder);
    for (const child of object.children) this.collect(child, groupOrder, cameraLayers);
  }

  private collectMesh(object: Mesh, groupOrder: number): void {
    if (this.eligible(object)) {
      const geometry = this.geometryState(object.geometry);
      if (geometry.valid) {
        const key = this.bucketKey(object, geometry.layout, groupOrder);
        const record = this.meshKeys.get(object)!;
        let bucket = record.bucket;
        if (!bucket?.active) bucket = this.buckets.get(key);
        if (!bucket && this.buckets.size < MAX_GROUPS * 4) {
          bucket = { meshes: [], geometries: new Map(), remaining: [], draws: [], frame: this.frame, count: 0, dirty: true, active: true };
          this.buckets.set(key, bucket);
        }
        if (!bucket) return;
        if (bucket.frame !== this.frame) { bucket.frame = this.frame; bucket.count = 0; }
        if (bucket.count < MAX_MEMBERS * 4) {
          if (bucket.meshes[bucket.count] !== object) { bucket.meshes[bucket.count] = object; bucket.dirty = true; }
          bucket.count++;
          let members = record.bucket === bucket && record.geometryIdentity === geometry.identity ? record.members : undefined;
          if (!members?.active) members = bucket.geometries.get(geometry.identity);
          if (!members) {
            members = { meshes: [], frame: this.frame, count: 0, active: true };
            bucket.geometries.set(geometry.identity, members); bucket.dirty = true;
          }
          if (members.frame !== this.frame) { members.frame = this.frame; members.count = 0; }
          if (members.meshes[members.count] !== object) { members.meshes[members.count] = object; bucket.dirty = true; }
          members.count++;
          record.bucket = bucket; record.members = members; record.geometryIdentity = geometry.identity;
          this.stats.eligibleMeshes++;
        }
      }
    }
  }

  private eligible(mesh: Mesh): boolean {
    const material = mesh.material;
    if (mesh.constructor !== Mesh || mesh.children.length || !hasDefaultRenderFrustum(mesh) || Array.isArray(material)
      || !this.materialState(material).valid
      || mesh.onBeforeRender !== Object3D.prototype.onBeforeRender || mesh.onAfterRender !== Object3D.prototype.onAfterRender
      || mesh.onBeforeShadow !== Object3D.prototype.onBeforeShadow || mesh.onAfterShadow !== Object3D.prototype.onAfterShadow
      || mesh.customDepthMaterial || mesh.customDistanceMaterial || mesh.morphTargetInfluences?.length) return false;
    // InstancedMesh does not support negative scale. Zero/nonfinite matrices can
    // also poison bounds for otherwise healthy neighbours.
    let record = this.meshKeys.get(mesh);
    if (!record) {
      record = { material: 0, layout: 0, x: 0, y: 0, z: 0, layers: 0, groupOrder: 0, renderOrder: 0, flags: 0, key: '', geometryIdentity: 0,
        world: new Float64Array(16), local: new Matrix4(), rootRevision: -1, transformRevision: 0, transformValid: false };
      this.meshKeys.set(mesh, record);
    }
    const world = mesh.matrixWorld.elements;
    let changed = record.rootRevision !== this.rootRevision;
    for (let i = 0; i < 16 && !changed; i++) if (record.world[i] !== world[i]) changed = true;
    if (!changed) return record.transformValid;
    record.world.set(world); record.rootRevision = this.rootRevision; record.transformRevision++;
    record.transformValid = false;
    if (!this.identityRoot) record.local.multiplyMatrices(this.inverse, mesh.matrixWorld);
    const m = this.identityRoot ? world : record.local.elements;
    if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) return false;
    for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false;
    const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (!Number.isFinite(determinant) || determinant <= 0) return false;
    const xx = m[0] ** 2 + m[1] ** 2 + m[2] ** 2, yy = m[4] ** 2 + m[5] ** 2 + m[6] ** 2, zz = m[8] ** 2 + m[9] ** 2 + m[10] ** 2;
    // The built-in instance normal transform assumes perpendicular basis axes.
    // Preserve original normal matrices for shear instead of changing lighting.
    return record.transformValid = (m[0] * m[4] + m[1] * m[5] + m[2] * m[6]) ** 2 <= 1e-12 * xx * yy
      && (m[0] * m[8] + m[1] * m[9] + m[2] * m[10]) ** 2 <= 1e-12 * xx * zz
      && (m[4] * m[8] + m[5] * m[9] + m[6] * m[10]) ** 2 <= 1e-12 * yy * zz;
  }

  private materialState(material: Material): MaterialState {
    let state = this.materials.get(material);
    if (!state) { state = { frame: -1, id: 0, valid: false }; this.materials.set(material, state); }
    if (state.frame === this.frame) return state;
    state.frame = this.frame;
    state.id = this.materialIdentities.key(material, this.frame) ?? 0;
    state.valid = state.id !== 0 && material.visible && !material.transparent && material.depthWrite && material.depthTest && !material.stencilWrite
      && (material.blending === NormalBlending || material.blending === NoBlending) && !material.alphaHash
      && !('transmission' in material && Number(material.transmission) > 0) && MATERIAL_TYPES.has(material.type)
      && !('displacementMap' in material && material.displacementMap)
      && material.onBeforeCompile === Material.prototype.onBeforeCompile && material.onBeforeRender === Material.prototype.onBeforeRender
      && material.customProgramCacheKey === Material.prototype.customProgramCacheKey;
    return state;
  }

  private bucketKey(mesh: Mesh, layout: number, groupOrder: number): string {
    const matrix = mesh.matrixWorld.elements, material = this.materialState(mesh.material as Material).id;
    // Centre a cell at the usual world origin, rather than splitting an idle
    // actor's limbs across cell boundaries whenever they cross its local axes.
    const x = Math.floor(matrix[12] / CELL_SIZE + .5), y = Math.floor(matrix[13] / CELL_SIZE + .5), z = Math.floor(matrix[14] / CELL_SIZE + .5);
    const layers = mesh.layers.mask, renderOrder = mesh.renderOrder, flags = +mesh.castShadow + 2 * +mesh.receiveShadow + 4 * +mesh.frustumCulled;
    const cached = this.meshKeys.get(mesh)!;
    if (cached.material === material && cached.layout === layout && cached.x === x && cached.y === y && cached.z === z
      && cached.layers === layers && cached.groupOrder === groupOrder && cached.renderOrder === renderOrder && cached.flags === flags) return cached.key;
    cached.material = material; cached.layout = layout; cached.x = x; cached.y = y; cached.z = z;
    cached.layers = layers; cached.groupOrder = groupOrder; cached.renderOrder = renderOrder; cached.flags = flags;
    cached.bucket = undefined; cached.members = undefined;
    cached.key = `${material}:${layout}:${layers}:${groupOrder}:${renderOrder}:${flags}:${x},${y},${z}`;
    return cached.key;
  }

  private partition(key: string, bucket: Bucket): void {
    // Membership and traversal order are checked live, but stable groups keep
    // their partition, arrays and draw keys across frames. A changed geometry,
    // layer, inherited render order or spatial cell rebuilds only its buckets.
    bucket.draws.length = 0; bucket.remaining.length = 0; bucket.dirty = false;
    const append = (meshes: Mesh[], suffix: string, instanced: boolean) => {
      for (let start = 0; start < meshes.length; start += MAX_MEMBERS) {
        const count = Math.min(MAX_MEMBERS, meshes.length - start);
        if (count >= MIN_GROUP) bucket.draws.push({ key: `${key}:${suffix}:${start}`, meshes, start, count, instanced });
      }
    };
    for (const [identity, members] of bucket.geometries) if (members.meshes.length >= MIN_GROUP) append(members.meshes, `i${identity}`, true);
    for (const mesh of bucket.meshes) if (this.meshKeys.get(mesh)!.members!.meshes.length < MIN_GROUP) bucket.remaining.push(mesh);
    append(bucket.remaining, 'b', false);
  }

  private geometryState(geometry: BufferGeometry): GeometryState {
    let state = this.geometryStates.get(geometry);
    if (!state) {
      state = { frame: -1, revision: 0, identity: geometry.id, attributes: [], index: null, indexVersion: -1, indexCount: -1, indexArray: null, drawStart: -1, drawCount: -1, layout: 0, vertices: 0, indices: 0, valid: false };
      this.geometryStates.set(geometry, state);
    }
    if (state.frame === this.frame) return state;
    state.frame = this.frame;
    const position = geometry.getAttribute('position'), index = geometry.getIndex();
    let attributeCount = 0;
    for (const name in geometry.attributes) if (Object.hasOwn(geometry.attributes, name)) attributeCount++;
    let unchanged = attributeCount === state.attributes.length && index === state.index && (index?.version ?? -1) === state.indexVersion
      && (index?.count ?? 0) === state.indexCount && (index?.array ?? null) === state.indexArray
      && geometry.drawRange.start === state.drawStart && geometry.drawRange.count === state.drawCount;
    for (const stamp of state.attributes) {
      const attribute = geometry.getAttribute(stamp.name);
      if (attribute !== stamp.attribute || attribute.count !== stamp.count || attribute.itemSize !== stamp.itemSize || attribute.normalized !== stamp.normalized
        || attribute.array !== stamp.array || attribute.array.constructor !== stamp.arrayConstructor || (attribute instanceof BufferAttribute ? attribute.version : -1) !== stamp.version
        || (attribute instanceof BufferAttribute ? attribute.gpuType : -1) !== stamp.gpuType) { unchanged = false; break; }
    }
    // Morph dictionaries and instancing change shader semantics even if ordinary
    // position/normal buffer versions do not change.
    let morphed = false;
    for (const name in geometry.morphAttributes) if (Object.hasOwn(geometry.morphAttributes, name)) { morphed = true; break; }
    let customUpload = index && index.onUploadCallback !== BufferAttribute.prototype.onUploadCallback;
    for (const name in geometry.attributes) {
      const attribute = geometry.attributes[name];
      if (attribute instanceof BufferAttribute && attribute.onUploadCallback !== BufferAttribute.prototype.onUploadCallback) customUpload = true;
    }
    if (morphed || customUpload || 'isInstancedBufferGeometry' in geometry) { state.valid = false; state.drawStart = -1; return state; }
    if (unchanged) {
      if (state.valid) {
        const identity = this.geometryIdentities.key(geometry, state.revision, this.frame);
        // Bounds and other render metadata may change without a buffer upload.
        // Mixed batches copy those values, so their compatibility revision must
        // advance alongside the content identity even when attributes match.
        if (identity !== state.identity) state.revision++;
        state.identity = identity;
      }
      return state;
    }
    let valid = position instanceof BufferAttribute && position.itemSize === 3 && position.count > 0 && position.count <= MAX_GEOMETRY_VERTICES
      && geometry.drawRange.start === 0 && geometry.drawRange.count >= (index?.count ?? position.count);
    let layout = index ? 'indexed' : 'vertices'; state.attributes.length = 0;
    for (const name of Object.keys(geometry.attributes).sort()) {
      const attribute = geometry.getAttribute(name);
      const arrayLayout = attributeArrayLayout(attribute.array);
      if (!(attribute instanceof BufferAttribute) || attribute.count !== position?.count || attribute.gpuType !== undefined && attribute.gpuType !== FloatType
        || 'isInstancedBufferAttribute' in attribute || 'isFloat16BufferAttribute' in attribute || arrayLayout === undefined) valid = false;
      const version = attribute instanceof BufferAttribute ? attribute.version : -1;
      state.attributes.push({ name, attribute, version, count: attribute.count, itemSize: attribute.itemSize, normalized: attribute.normalized,
        array: attribute.array, arrayConstructor: attribute.array.constructor, gpuType: attribute instanceof BufferAttribute ? attribute.gpuType : -1 });
      layout += `:${name}:${attribute.itemSize}:${+attribute.normalized}:${arrayLayout ?? 'unsupported'}`;
    }
    state.index = index; state.indexVersion = index?.version ?? -1; state.indexCount = index?.count ?? 0; state.indexArray = index?.array ?? null;
    state.drawStart = geometry.drawRange.start; state.drawCount = geometry.drawRange.count; state.revision++;
    let layoutId = this.layouts.get(layout);
    if (layoutId === undefined) { layoutId = this.layouts.size + 1; this.layouts.set(layout, layoutId); }
    state.layout = layoutId; state.valid = valid; state.vertices = position?.count ?? 0; state.indices = index?.count ?? 0;
    if (valid) state.identity = this.geometryIdentities.key(geometry, state.revision, this.frame);
    return state;
  }

  private apply(key: string, meshes: Mesh[], start: number, count: number, instanced: boolean, scene: Object3D): void {
    const source = meshes[start];
    let plan = this.plans.get(key);
    if (plan && !this.compatible(plan, meshes, start, count, instanced, scene)) {
      this.releasePlan(key, plan); plan = undefined;
    }
    if (!plan) {
      plan = this.createPlan(meshes, start, count, instanced);
      if (!plan) return;
      this.plans.set(key, plan); this.retainedVertices += plan.vertices;
    }
    plan.used = true; plan.lastUsed = this.frame;
    if (plan.root.parent !== this.root) this.root.add(plan.root);
    const proxy = plan.proxy;
    // The former representative may have been edited, disposed or removed. Use
    // a current source without replacing any authored object's material/geometry.
    proxy.material = source.material;
    let changed = plan.instanceCount !== count;
    let firstMatrix = Infinity, lastMatrix = -1;
    if (proxy instanceof InstancedMesh && proxy.geometry !== source.geometry) {
      proxy.geometry = source.geometry; plan.geometries[0] = source.geometry;
      plan.revisions[0] = this.geometryState(source.geometry).revision; changed = true;
    }
    if (proxy instanceof BatchedMesh) {
      // Keep native instance slots and matrix textures across traversal changes.
      // Replacing the proxy changes its shader identity even for identical data.
      for (let i = 0; i < count; i++) {
        const geometry = meshes[start + i].geometry;
        if (plan.instanceGeometries[i] !== geometry) {
          proxy.setGeometryIdAt(i, plan.geometryIds.get(geometry)!);
          plan.instanceGeometries[i] = geometry; changed = true;
        }
        if (i >= plan.instanceCount) { proxy.setVisibleAt(i, true); changed = true; }
      }
      for (let i = count; i < plan.instanceCount; i++) { proxy.setVisibleAt(i, false); changed = true; }
    }
    for (let i = 0; i < count; i++) {
      const mesh = meshes[start + i], record = this.meshKeys.get(mesh)!;
      if (plan.sources[i] === mesh && plan.transformRevisions[i] === record.transformRevision) continue;
      plan.sources[i] = mesh; plan.transformRevisions[i] = record.transformRevision;
      const local = this.identityRoot ? mesh.matrixWorld : record.local;
      const matrix = local.elements, values = proxy instanceof InstancedMesh ? proxy.instanceMatrix.array : plan.transforms;
      let different = false;
      for (let j = 0; j < 16 && !different; j++) if (values[i * 16 + j] !== Math.fround(matrix[j])) different = true;
      if (proxy instanceof InstancedMesh) {
        if (different) {
          proxy.setMatrixAt(i, local); changed = true;
          firstMatrix = Math.min(firstMatrix, i); lastMatrix = i;
        }
      } else if (different) {
        proxy.setMatrixAt(i, local); plan.transforms.set(matrix, i * 16); changed = true;
      }
    }
    plan.sources.length = plan.transformRevisions.length = count;
    if (proxy instanceof InstancedMesh) {
      proxy.count = count;
      if (lastMatrix >= 0) {
        // Preserve pending writes when a previous pass culled the entire group.
        // One reused range bounds API overhead while avoiding full-buffer writes.
        const attribute = proxy.instanceMatrix, range = plan.updateRange;
        let start = firstMatrix * 16, end = (lastMatrix + 1) * 16;
        for (const pending of attribute.updateRanges) {
          start = Math.min(start, pending.start); end = Math.max(end, pending.start + pending.count);
        }
        range.start = start; range.count = end - start;
        attribute.updateRanges.length = 0; attribute.updateRanges.push(range);
        attribute.needsUpdate = true;
      }
    }
    if (changed || !proxy.boundingSphere) proxy.computeBoundingSphere();
    plan.instanceCount = count;
    // Only visible leaf meshes were collected. No descendant or authored hidden
    // part can accidentally disappear, and source raycasting stays unchanged.
    this.applied.push(plan);
    for (const mesh of plan.sources) mesh.visible = false;
    plan.root.renderOrder = this.meshKeys.get(source)!.groupOrder;
    if (instanced) { this.stats.instancedMeshes += count; this.stats.instanceGroups++; }
    else { this.stats.batchedMeshes += count; this.stats.batchGroups++; }
  }

  private compatible(plan: GroupPlan, meshes: Mesh[], start: number, count: number, instanced: boolean, scene: Object3D): boolean {
    if (instanced) return plan.proxy instanceof InstancedMesh && count <= plan.capacity
      && (plan.geometries[0] !== meshes[start].geometry || this.geometryState(plan.geometries[0]).revision === plan.revisions[0]);
    if (!(plan.proxy instanceof BatchedMesh) || count > plan.capacity) return false;
    for (let i = 0; i < count; i++) if (!plan.geometryIds.has(meshes[start + i].geometry)) return false;
    for (const source of plan.retainedSources) if (!this.belongsTo(source, scene)) return false;
    for (let i = 0; i < plan.geometries.length; i++) if (this.geometryState(plan.geometries[i]).revision !== plan.revisions[i]) return false;
    return true;
  }

  private createPlan(meshes: Mesh[], start: number, count: number, instanced: boolean): GroupPlan | undefined {
    const source = meshes[start], geometries: BufferGeometry[] = [], revisions: number[] = [], geometryIds = new Map<BufferGeometry, number>();
    const instanceGeometries: BufferGeometry[] = [];
    let vertices = 0, indices = 0;
    if (instanced) {
      // Instancing borrows only the current representative geometry. Retaining
      // every equivalent source here would keep removed members' buffers alive
      // even while this reusable plan is serving entirely new source objects.
      geometries.push(source.geometry); revisions.push(this.geometryState(source.geometry).revision);
    } else for (let i = 0; i < count; i++) {
      const geometry = meshes[start + i].geometry; instanceGeometries.push(geometry);
      if (geometryIds.has(geometry)) continue;
      const state = this.geometryState(geometry);
      geometryIds.set(geometry, geometries.length); geometries.push(geometry); revisions.push(state.revision);
      vertices += state.vertices; indices += state.indices;
    }
    if (!instanced && vertices > MAX_BATCH_VERTICES || !this.reservePlan(vertices)) return;
    const capacity = instanced ? 2 ** Math.ceil(Math.log2(count)) : count;
    let proxy: InstancedMesh | BatchedMesh;
    if (instanced) {
      proxy = new InstancedMesh(source.geometry, source.material, capacity);
      this.stats.createdGroups++;
      proxy.instanceMatrix.setUsage(DynamicDrawUsage);
    } else {
      const batch = new BatchedMesh(capacity, vertices, indices, source.material as Material);
      this.stats.createdGroups++;
      try {
        for (const geometry of geometries) geometryIds.set(geometry, batch.addGeometry(geometry));
        for (const geometry of instanceGeometries) batch.addInstance(geometryIds.get(geometry)!);
      } catch { this.stats.disposedGroups++; batch.dispose(); return; }
      batch.perObjectFrustumCulled = source.frustumCulled;
      batch.sortObjects = true; proxy = batch;
    }
    proxy.name = instanced ? 'engine.instances' : 'engine.batch';
    registerEngineRenderProxy(proxy);
    proxy.castShadow = source.castShadow; proxy.receiveShadow = source.receiveShadow;
    proxy.layers.mask = source.layers.mask; proxy.renderOrder = source.renderOrder; proxy.frustumCulled = source.frustumCulled;
    proxy.matrixAutoUpdate = false;
    // Proxies never create duplicate picks while temporarily attached.
    proxy.raycast = () => {};
    const root = new Group(); root.name = 'engine.render-group'; root.matrixAutoUpdate = false; root.layers.enableAll(); root.add(proxy);
    return { root, proxy, sources: [], geometries, revisions, geometryIds, instanceGeometries, instanceCount: -1,
      capacity, vertices: instanced ? 0 : vertices, used: true, needed: true, lastUsed: this.frame,
      retainedSources: instanced ? [] : meshes.slice(start, start + count),
      transforms: instanced ? new Float32Array(0) : new Float32Array(capacity * 16), transformRevisions: [], updateRange: { start: 0, count: 0 } };
  }

  private releaseBucket(bucket: Bucket): void {
    bucket.active = false; bucket.meshes.length = bucket.remaining.length = bucket.draws.length = 0;
    for (const members of bucket.geometries.values()) { members.active = false; members.meshes.length = 0; }
    bucket.geometries.clear();
  }

  private belongsTo(source: Object3D, scene: Object3D): boolean {
    for (let object: Object3D | null = source; object; object = object.parent) if (object === scene) return true;
    return false;
  }

  private releasePlan(key: string, plan: GroupPlan): void {
    // Clear ownership before listeners run, including listeners that throw.
    this.plans.delete(key); this.retainedVertices -= plan.vertices; this.stats.disposedGroups++;
    let failed = false, failure: unknown;
    try { plan.root.removeFromParent(); }
    catch (error) { failed = true; failure = error; }
    try { plan.proxy.dispose(); }
    catch (error) { if (!failed) { failed = true; failure = error; } }
    if (failed) throw failure;
  }

  private reservePlan(vertices: number): boolean {
    while (this.plans.size >= MAX_GROUPS || this.retainedVertices + vertices > MAX_RETAINED_VERTICES) {
      let oldest: GroupPlan | undefined, oldestKey = '';
      for (const [key, plan] of this.plans) if (!plan.used && !plan.needed && (!oldest || plan.lastUsed < oldest.lastUsed)) {
        oldest = plan; oldestKey = key;
      }
      if (!oldest) return false;
      this.releasePlan(oldestKey, oldest);
    }
    return true;
  }

  private sweep(scene: Object3D): void {
    for (const [key, plan] of this.plans) if (!plan.used) {
      // A brief visibility, LOD or cell change must not discard native shader,
      // buffer and texture identities. Dormant proxies never stay in the scene.
      plan.root.removeFromParent();
      let expired = this.frame - plan.lastUsed > MAX_IDLE_FRAMES;
      for (const source of plan.sources) if (!this.belongsTo(source, scene)) { expired = true; break; }
      for (const source of plan.retainedSources) if (!this.belongsTo(source, scene)) { expired = true; break; }
      if (expired) this.releasePlan(key, plan);
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.frame !== this.frame) { this.releaseBucket(bucket); this.buckets.delete(key); }
    }
    this.stats.retainedGroups = this.plans.size;
  }
}
