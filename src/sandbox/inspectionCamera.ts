import { Box3, Camera, InstancedMesh, Material, Matrix4, Mesh, Object3D, Raycaster, Scene, SkinnedMesh, Vector2, Vector3 } from 'three';
import type { InspectionGameplayCameraSample } from '../shared/inspectionCamera.ts';
import { getInspectionEquipmentRoots, getInspectionOwner } from './inspectionGeometry.ts';
import { inspectionEquipmentLandmarks, inspectionEquipmentSemanticRoot } from './equipmentOrientation.ts';
import { recordSoundGameplayCamera } from './audioListener.ts';

const LIMIT = { objects: 8192, meshes: 512, instances: 4096, triangles: 120000, meshTriangles: 30000 };
const NEAR = .75;
const masks = new WeakMap<Camera, Set<Object3D>>();
let frame: { timeMs: number; actorId?: string; review: boolean; sample?: InspectionGameplayCameraSample } | undefined;
export function beginInspectionCameraFrame(timeMs: number, actorId?: string, review = false): void { frame = { timeMs, actorId, review }; }
export function endInspectionCameraFrame(): InspectionGameplayCameraSample | undefined { const sample = frame?.sample; frame = undefined; return sample; }
export function isInspectionCameraFrameActive(): boolean { return !!frame; }
/** Shared first-person masks are camera-specific and do not change visibility,
 * shadows, or reflection draws. Nested scopes restore the previous mask. */
export function withInspectionCameraMask<T>(camera: Camera, objects: Iterable<Object3D>, action: () => T): T {
  if (!frame) return action();
  const previous = masks.get(camera), hidden = new Set(previous);
  for (const object of objects) hidden.add(object);
  masks.set(camera, hidden);
  try { return action(); } finally { if (previous) masks.set(camera, previous); else masks.delete(camera); }
}

type Blocker = { mesh: Mesh; original: Mesh; box: Box3; triangles: number };
const drawable = (material: Material | undefined) => !!material?.visible && material.colorWrite
  && (!material.transparent || material.opacity > .15);
function collect(scene: Scene, camera: Camera, hidden: Set<Object3D>, region: Box3) {
  const blockers: Blocker[] = [];
  let visited = 0, instances = 0, omitted = 0, masked = 0, boundsVertices = 0;
  const world = new Matrix4(), local = new Matrix4();
  const add = (mesh: Mesh, box: Box3, transform: Matrix4, triangles: number, instance: boolean) => {
    const bounds = box.clone().applyMatrix4(transform);
    if (!bounds.intersectsBox(region)) return;
    if (blockers.length >= LIMIT.meshes || triangles > LIMIT.meshTriangles) { omitted++; return; }
    if (instance) { const proxy = new Mesh(mesh.geometry, mesh.material); proxy.matrixWorld.copy(transform); blockers.push({ mesh: proxy, original: mesh, box: bounds, triangles }); }
    else blockers.push({ mesh, original: mesh, box: bounds, triangles });
  };
  const visit = (object: Object3D) => {
    if (++visited > LIMIT.objects) { omitted++; return; }
    if (!object.visible) return;
    if (object instanceof Mesh) {
      if (hidden.has(object)) masked++;
      else if (object.layers.test(camera.layers) && (Array.isArray(object.material) ? object.material : [object.material]).some(drawable)) {
        const geometry = object.geometry, positions = geometry.getAttribute('position');
        const triangles = Math.ceil((geometry.index?.count ?? positions?.count ?? 0) / 3);
        if (positions) {
          // Animated bounds walk every skinned vertex. Apply the geometry budget
          // before that work, including sparse indexed meshes with many vertices.
          const boundsCost = object instanceof SkinnedMesh || !geometry.boundingBox ? positions.count : 0;
          if (triangles > LIMIT.meshTriangles || positions.count > LIMIT.meshTriangles * 3
            || boundsVertices + boundsCost > LIMIT.triangles * 3) omitted++;
          else {
            boundsVertices += boundsCost;
            if (!geometry.boundingBox) geometry.computeBoundingBox();
            if (object instanceof SkinnedMesh) { object.skeleton.update(); object.computeBoundingBox(); object.computeBoundingSphere(); }
            const bounds = object instanceof SkinnedMesh ? object.boundingBox : geometry.boundingBox;
            if (bounds && object instanceof InstancedMesh) {
              for (let i = 0; i < object.count; i++) {
                if (++instances > LIMIT.instances) { omitted += object.count - i; break; }
                object.getMatrixAt(i, local); world.multiplyMatrices(object.matrixWorld, local); add(object, bounds, world, triangles, true);
              }
            } else if (bounds) add(object, bounds, object.matrixWorld, triangles, false);
          }
        }
      }
    }
    for (const child of object.children) { if (visited >= LIMIT.objects) { omitted++; break; } visit(child); }
  };
  visit(scene); return { blockers, omitted, masked };
}

/** Central 5x5 viewport samples and tagged item landmarks, on the actual game
 * camera. This is bounded ray evidence, not pixel coverage or aesthetic intent. */
export function sampleInspectionGameplayCamera(scene: Scene, camera: Camera, timeMs: number, actorId?: string): InspectionGameplayCameraSample {
  scene.updateMatrixWorld(true); camera.updateWorldMatrix(true, false);
  const origin = camera.getWorldPosition(new Vector3()), hidden = masks.get(camera) ?? new Set<Object3D>();
  const registered = getInspectionEquipmentRoots({ root: scene });
  const owned = registered.roots.filter(root => actorId && getInspectionOwner(root)?.actorId === actorId);
  // An authored wrapper owns a nested stock item's semantics, just as in the
  // orientation sampler. Its own child geometry must not occlude itself.
  const semanticRoots = new Set<Object3D>(); let missingSemantics = 0;
  for (const root of owned) {
    const semantic = inspectionEquipmentSemanticRoot(root);
    if (semantic) semanticRoots.add(semantic); else missingSemantics++;
  }
  const roots = [...semanticRoots];
  const items = roots.slice(0, 8).flatMap(root => { const value = inspectionEquipmentLandmarks(root); return value ? [{ root, ...value }] : []; });
  // Orthographic rays start at different points on the camera plane. Their
  // near segments, and the item sightlines, must participate in broadphase.
  const points = [new Vector2(0, 0), ...[-.4, -.2, 0, .2, .4].flatMap(y => [-.4, -.2, 0, .2, .4].filter(x => x !== 0 || y !== 0).map(x => new Vector2(x, y)))];
  const ray = new Raycaster(), hitPoint = new Vector3();
  const region = new Box3().setFromCenterAndSize(origin, new Vector3(NEAR * 2, NEAR * 2, NEAR * 2));
  for (const point of points) { ray.setFromCamera(point, camera); region.expandByPoint(ray.ray.origin); region.expandByPoint(ray.ray.at(NEAR, hitPoint)); }
  const onScreen = (projected: Vector3) => [projected.x, projected.y, projected.z].every(Number.isFinite)
    && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1;
  for (const item of items) for (const point of item.points) {
    const projected = point.position.clone().project(camera);
    if (!point.visible || !onScreen(projected)) continue;
    ray.setFromCamera(new Vector2(projected.x, projected.y), camera);
    region.expandByPoint(ray.ray.origin); region.expandByPoint(point.position);
  }
  const work = collect(scene, camera, hidden, region);
  let triangles = 0, exhausted = false;
  const nearest = (far: number): { object: Mesh; distance: number } | undefined => {
    ray.far = far;
    let closest: { object: Mesh; distance: number } | undefined;
    for (const blocker of work.blockers) {
      if (!blocker.box.containsPoint(ray.ray.origin)
        && (!ray.ray.intersectBox(blocker.box, hitPoint) || hitPoint.distanceToSquared(ray.ray.origin) > far * far)) continue;
      if (triangles + blocker.triangles > LIMIT.triangles) { exhausted = true; break; }
      triangles += blocker.triangles;
      const hits: Parameters<Mesh['raycast']>[1] = []; blocker.mesh.raycast(ray, hits);
      for (const hit of hits) {
        const material = Array.isArray(blocker.mesh.material) ? blocker.mesh.material[hit.face?.materialIndex ?? 0] : blocker.mesh.material;
        if (drawable(material) && hit.distance >= ray.near && hit.distance <= far && (!closest || hit.distance < closest.distance)) closest = { object: blocker.original, distance: hit.distance };
      }
    }
    return closest;
  };
  const sample: InspectionGameplayCameraSample = { timeMs, ...(actorId ? { actorId } : {}), status: 'supported',
    nearDistance: NEAR, rayCount: 0, blockedRays: 0, centerBlocked: false, maskedMeshes: work.masked,
    omitted: work.omitted + missingSemantics + Math.max(0, roots.length - items.length) + Number(registered.truncated), blockers: [], items: [],
    limitation: '25 central viewport rays within 0.75 scene units; item visibility samples tagged landmarks. Approximate alpha/material and mesh ray tests, not pixel coverage or an intent verdict.' };
  const labels = new Map<Mesh, InspectionGameplayCameraSample['blockers'][number]>();
  const itemOf = (object: Object3D) => items.find(item => { for (let parent: Object3D | null = object; parent; parent = parent.parent) if (parent === item.root) return true; return false; });
  // Center first so a bounded query still retains the most useful sightline.
  for (const point of points) {
    ray.setFromCamera(point, camera); ray.near = 'near' in camera ? Number(camera.near) : 0;
    const hit = nearest(NEAR); if (exhausted) break;
    sample.rayCount++;
    if (!hit) continue;
    sample.blockedRays++; if (!point.x && !point.y) sample.centerBlocked = true;
    sample.nearestDistance = Math.min(sample.nearestDistance ?? Infinity, hit.distance);
    let blocker = labels.get(hit.object);
    if (!blocker) {
      const owner = getInspectionOwner(hit.object), item = itemOf(hit.object);
      blocker = { id: (hit.object.name || `${hit.object.type}:${hit.object.id}`).slice(0, 160), ...(owner ? { actorId: owner.actorId } : {}),
        ...(item ? { itemId: item.itemId } : {}), rays: 0, minDistance: hit.distance }; labels.set(hit.object, blocker);
    }
    blocker.rays++; blocker.minDistance = Math.min(blocker.minDistance, hit.distance);
  }
  sample.blockers = [...labels.values()].sort((a, b) => b.rays - a.rays).slice(0, 8);
  sample.omitted += Math.max(0, labels.size - sample.blockers.length);
  for (const item of items) {
    const value = { itemId: item.itemId, ...(actorId ? { actorId } : {}), landmarks: item.points.length, onScreen: 0, visible: 0, occluded: 0 };
    let itemDrawn = false;
    item.root.traverseVisible(object => { if (object instanceof Mesh && !hidden.has(object) && object.layers.test(camera.layers)
      && (Array.isArray(object.material) ? object.material : [object.material]).some(drawable)) itemDrawn = true; });
    for (const point of item.points) {
      const projected = point.position.clone().project(camera);
      if (!itemDrawn || !point.visible || !onScreen(projected)) continue;
      value.onScreen++;
      // Projection defines the sightline for both perspective and orthographic
      // cameras; converging from camera.position would be incorrect for RPG.
      ray.setFromCamera(new Vector2(projected.x, projected.y), camera);
      const distance = point.position.distanceTo(ray.ray.origin);
      ray.near = 'near' in camera ? Number(camera.near) : 0;
      const hit = nearest(Math.max(0, distance - .01));
      if (exhausted) break;
      if (!hit || itemOf(hit.object) === item) value.visible++; else value.occluded++;
    }
    sample.items.push(value);
    if (exhausted) break;
  }
  if (exhausted) sample.omitted++;
  if (sample.omitted) sample.status = 'partial';
  return sample;
}

export function recordInspectionGameplayCamera(scene: Scene, camera: Camera, actualGameplay = false, actorId = frame?.actorId): void {
  recordSoundGameplayCamera(camera, actualGameplay);
  if (!frame || frame.sample || frame.review && !actualGameplay) return;
  try { frame.sample = sampleInspectionGameplayCamera(scene, camera, frame.timeMs, actorId); }
  catch { frame.sample = { timeMs: frame.timeMs, status: 'unsupported', nearDistance: NEAR, rayCount: 0, blockedRays: 0,
    centerBlocked: false, maskedMeshes: 0, omitted: 0, blockers: [], items: [], limitation: 'Gameplay camera sampling failed; no visibility conclusion is available.' }; }
}
