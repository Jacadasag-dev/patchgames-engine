import { Box3, Camera, InstancedMesh, Material, Matrix4, Mesh, Object3D, PerspectiveCamera, Quaternion, Raycaster,
  Scene, SkinnedMesh, Vector2, Vector3, type WebGLRenderer } from 'three';
import type { InspectionFocus } from '../shared/gameApi.ts';
import { isInspectionCameraFrameActive, recordInspectionGameplayCamera } from './inspectionCamera.ts';
import { renderProfiledView } from './viewDiagnostics.ts';
import { recordSoundGameplayCamera } from './audioListener.ts';

/** Register rendered objects explicitly: no state-field, model-name or rig assumptions. */
export interface InspectionTarget {
  id: string;
  label?: string;
  object: Object3D;
  /** Index in the current ViewFrame.players array. */
  player?: number;
  /** World-space forward; omitted means the object's transformed local +Z. */
  forward?: { x: number; y: number; z: number };
  /** Current authored interaction or nearby context, never a collision verdict. */
  relatedTargets?: readonly string[];
  /** Explain context such as active-encounter-nearest; do not imply an exact target. */
  relationReason?: string;
}

type Angle = NonNullable<InspectionFocus['angle']>;
const YAW = { front: 0, 'three-quarter': Math.PI / 4, side: Math.PI / 2, rear: Math.PI };
const AUTO_ANGLES: readonly { angle: Exclude<Angle, 'auto'>; yaw: number }[] = [
  { angle: 'three-quarter', yaw: Math.PI / 4 }, { angle: 'side', yaw: Math.PI / 2 },
  { angle: 'front', yaw: 0 }, { angle: 'rear', yaw: Math.PI },
  { angle: 'three-quarter', yaw: -Math.PI / 4 }, { angle: 'side', yaw: -Math.PI / 2 },
  { angle: 'rear', yaw: Math.PI * .75 }, { angle: 'rear', yaw: -Math.PI * .75 },
];
const UP = new Vector3(0, 1, 0);
// Only the byte count is needed. Keep this helper usable in the QuickJS scene
// tests as well as workers without depending on a browser TextEncoder global.
function utf8Length(value: string): number {
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return length;
}
const finiteBox = (box: Box3): boolean => !box.isEmpty()
  && [...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite);
const rounded = (value: Vector3): number[] => value.toArray().map(n => Math.round(n * 10000) / 10000);
const corners = (box: Box3): Vector3[] => [0, 1, 2, 3, 4, 5, 6, 7].map(i =>
  new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));

function targetCatalog(targets: readonly InspectionTarget[], focus: InspectionFocus | null) {
  const selected = focus ? targets.find(target => focus.target !== undefined ? target.id === focus.target : target.player === (focus.player ?? 0)) : undefined;
  const ordered = selected ? [selected, ...targets.filter(target => target !== selected)] : targets;
  const result: { id: string; label?: string; player?: number; relatedTargets?: string[]; relationReason?: string }[] = [];
  let bytes = 2;
  for (const { id, label, player, relatedTargets, relationReason } of ordered) {
    const item = { id: id.slice(0, 128), ...(label ? { label: label.slice(0, 128) } : {}), ...(player === undefined ? {} : { player }),
      ...(relatedTargets?.length ? { relatedTargets: relatedTargets.slice(0, 4).map(id => id.slice(0, 128)) } : {}),
      ...(relationReason ? { relationReason: relationReason.slice(0, 128) } : {}) };
    const size = utf8Length(JSON.stringify(item)) + 1;
    if (result.length >= 64 || bytes + size > 8192) continue;
    result.push(item); bytes += size;
  }
  return result;
}

/** Visible render geometry only. Skinned/morphed vertices are evaluated in the
 * current pose, after world matrices are refreshed, rather than trusting a cached bind-pose box. */
export function inspectionBounds(root: Object3D): Box3 {
  root.updateWorldMatrix(true, true);
  const bounds = new Box3(), part = new Box3(), vertex = new Vector3();
  const visit = (object: Object3D, isRoot = false): void => {
    if (!isRoot && !object.visible) return;
    if (object instanceof Mesh) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(material => material.visible && (!material.transparent || material.opacity > 0))) {
        if (object instanceof SkinnedMesh || object.morphTargetInfluences?.length) {
          if (object instanceof SkinnedMesh) object.skeleton.update();
          part.makeEmpty();
          const positions = object.geometry.getAttribute('position');
          for (let i = 0; positions && i < positions.count; i++) {
            object.getVertexPosition(i, vertex); part.expandByPoint(vertex.applyMatrix4(object.matrixWorld));
          }
        } else if (object instanceof InstancedMesh) {
          object.computeBoundingBox(); part.copy(object.boundingBox!).applyMatrix4(object.matrixWorld);
        } else {
          if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
          if (object.geometry.boundingBox) part.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
          else part.makeEmpty();
        }
        if (finiteBox(part)) bounds.union(part);
      }
    }
    for (const child of object.children) visit(child);
  };
  visit(root, true);
  return bounds;
}

function descendants(root: Object3D): Set<Object3D> {
  const objects = new Set<Object3D>(); root.traverse(object => objects.add(object)); return objects;
}

type Blocker = { mesh: Mesh; bounds: Box3; triangles: number; score: number };
type OcclusionWork = { blockers: Blocker[]; testedInstances: number; omitted: number; triangleTests: number; rays: number; lastSamples: number; exhausted: boolean };
const OCCLUSION_LIMITS = { instances: 8192, blockers: 512, meshTriangles: 30000, triangleTests: 500000 };

/** Inspect only nearby pieces of large scenery batches. Calling an InstancedMesh's
 * raycast would otherwise retest every tree/stone in the entire map for every ray. */
function occluders(scene: Scene, target: Set<Object3D>, camera: Camera, region: Box3): OcclusionWork {
  const work: OcclusionWork = { blockers: [], testedInstances: 0, omitted: 0, triangleTests: 0, rays: 0, lastSamples: 0, exhausted: false };
  const instance = new Matrix4(), world = new Matrix4();
  const center = region.getCenter(new Vector3());
  const add = (mesh: Mesh, local: Box3, transform: Matrix4, triangles: number, proxy = false): void => {
    const bounds = local.clone().applyMatrix4(transform);
    if (!bounds.intersectsBox(region)) return;
    if (triangles > OCCLUSION_LIMITS.meshTriangles) { work.omitted++; return; }
    const score = bounds.distanceToPoint(center), heap = work.blockers;
    const full = heap.length >= OCCLUSION_LIMITS.blockers;
    // Keep the nearest pieces in a bounded max heap. Scenery is generally added
    // before actors; taking the first 512 pieces could omit every nearby actor.
    if (full) { work.omitted++; if (score >= heap[0].score) return; }
    let retained = mesh;
    if (proxy) {
      retained = new Mesh(mesh.geometry, mesh.material); retained.matrixWorld.copy(transform);
    }
    const item = { mesh: retained, bounds, triangles, score };
    if (!full) {
      heap.push(item);
      for (let child = heap.length - 1; child > 0;) {
        const parent = (child - 1) >> 1;
        if (heap[parent].score >= heap[child].score) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]]; child = parent;
      }
    } else {
      heap[0] = item;
      for (let parent = 0;;) {
        const left = parent * 2 + 1, right = left + 1;
        if (left >= heap.length) break;
        const child = right < heap.length && heap[right].score > heap[left].score ? right : left;
        if (heap[parent].score >= heap[child].score) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]]; parent = child;
      }
    }
  };
  scene.traverseVisible(object => {
    if (!(object instanceof Mesh) || target.has(object) || !object.layers.test(camera.layers)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (!materials.some(material => material.visible && material.colorWrite && (!material.transparent || material.opacity > .15))) return;
    const geometry = object.geometry, positions = geometry.getAttribute('position');
    if (!positions) return;
    const triangles = Math.ceil((geometry.index?.count ?? positions.count) / 3);
    if (triangles > OCCLUSION_LIMITS.meshTriangles) { work.omitted++; return; }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;
    if (object instanceof InstancedMesh) {
      for (let index = 0; index < object.count; index++) {
        if (work.testedInstances >= OCCLUSION_LIMITS.instances) { work.omitted += object.count - index; break; }
        work.testedInstances++;
        object.getMatrixAt(index, instance); world.multiplyMatrices(object.matrixWorld, instance);
        add(object, geometry.boundingBox, world, triangles, true);
      }
    } else if (object instanceof SkinnedMesh) {
      object.computeBoundingBox(); object.computeBoundingSphere();
      if (object.boundingBox) add(object, object.boundingBox, object.matrixWorld, triangles);
    } else add(object, geometry.boundingBox, object.matrixWorld, triangles);
  });
  work.blockers.sort((a, b) => a.score - b.score);
  return work;
}

/** Count blocked sight lines to the center and inset box corners. These are
 * diagnostic samples, not an exact pixel-visibility claim. */
function blockedSamples(position: Vector3, box: Box3, work: OcclusionWork): number {
  const center = box.getCenter(new Vector3()), ray = new Raycaster(), direction = new Vector3();
  const hitPoint = new Vector3();
  work.lastSamples = 0;
  let blocked = 0;
  for (const point of [center, ...corners(box).map(point => point.lerp(center, .2))]) {
    direction.subVectors(point, position); ray.far = Math.max(0, direction.length() - .01);
    ray.set(position, direction.normalize());
    work.rays++;
    for (const blocker of work.blockers) {
      if (!ray.ray.intersectBox(blocker.bounds, hitPoint) || hitPoint.distanceToSquared(position) > ray.far * ray.far) continue;
      if (work.triangleTests + blocker.triangles > OCCLUSION_LIMITS.triangleTests) { work.exhausted = true; break; }
      work.triangleTests += blocker.triangles;
      const hits: Parameters<Mesh['raycast']>[1] = [];
      // Layers were filtered when constructing blockers; direct raycast also
      // supports explicitly registered models on non-default render layers.
      blocker.mesh.raycast(ray, hits);
      if (hits.some(hit => {
        const mesh = hit.object as Mesh;
        const material = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
        return material instanceof Material && material.visible && material.colorWrite && (!material.transparent || material.opacity > .15);
      })) { blocked++; break; }
    }
    if (work.exhausted) break;
    work.lastSamples++;
  }
  return blocked;
}

function blockedGroupSamples(position: Vector3, boxes: readonly Box3[], work: OcclusionWork): number {
  let blocked = 0, samples = 0;
  for (const box of boxes) {
    blocked += blockedSamples(position, box, work); samples += work.lastSamples;
    if (work.exhausted) break;
  }
  work.lastSamples = samples;
  return blocked;
}

/** An opt-in authoring camera. Never changes the game camera or gameplay state.
 * Add setInspectionFocus/inspectionFocus hooks to the GameView and replace its
 * final renderer.render with this controller's render call. */
export class InspectionFocusController {
  readonly camera = new PerspectiveCamera(45, 1, .01, 1000);
  private request: InspectionFocus | null = null;
  private key = '';
  private target: Object3D | null = null;
  private groupKey = '';
  private frame = 0;
  private angleChanges = 0;
  private anchorOffset = new Vector3();
  private direction = new Vector3();
  private distance = 0;
  private chosenAngle: Exclude<Angle, 'auto'> = 'three-quarter';
  private chosenYaw = Math.PI / 4;
  private report: Record<string, unknown> = { status: 'inactive' };
  private readonly registered = new Map<string, InspectionTarget>();

  get active(): boolean { return this.request !== null; }

  setFocus(focus: InspectionFocus | null): void {
    if (focus?.target !== undefined && focus.player !== undefined) throw new Error('Inspection focus accepts player or target, not both.');
    const next: InspectionFocus | null = focus ? {
      ...(focus.target === undefined ? { player: focus.player ?? 0 } : { target: focus.target }),
      framing: focus.framing ?? 'subject',
      ...(focus.includeTargets ? { includeTargets: [...new Set(focus.includeTargets)].slice(0, 4) } : {}),
      angle: focus.angle ?? 'auto', visibility: focus.visibility ?? 'normal', padding: focus.padding ?? 1.2,
    } : null;
    const key = JSON.stringify(next);
    if (key === this.key) return;
    this.key = key; this.request = next; this.target = null; this.groupKey = ''; this.distance = 0; this.frame = 0; this.angleChanges = 0;
    this.report = { status: focus ? 'pending' : 'inactive' };
  }

  inspection(): Record<string, unknown> { return this.report; }

  /** Reusable features can register an authored creature or prop without knowing
   * the base game's private scene. Registration owns no geometry or resources. */
  setTarget(id: string, object: unknown | null, label?: string, relatedTargets?: readonly string[]): void {
    if (typeof id !== 'string' || !id.trim() || id.length > 128 || /[\u0000-\u001f]/.test(id)) throw new Error('Inspection target ID must be 1–128 printable characters.');
    if (label !== undefined && (typeof label !== 'string' || label.length > 128)) throw new Error('Inspection target label must be at most 128 characters.');
    if (relatedTargets && (relatedTargets.length > 4 || relatedTargets.some(value => typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f]/.test(value))))
      throw new Error('Inspection relations accept at most four printable target IDs of 1–128 characters.');
    if (object === null) { this.registered.delete(id); return; }
    if (!(object instanceof Object3D)) throw new Error('Inspection targets must be Three.js objects.');
    if (!this.registered.has(id) && this.registered.size >= 64) throw new Error('At most 64 feature inspection targets may be registered.');
    this.registered.set(id, { id, object, ...(label === undefined ? {} : { label }), ...(relatedTargets ? { relatedTargets: [...relatedTargets] } : {}) });
  }

  private fitDistance(box: Box3, center: Vector3, direction: Vector3, padding: number): number {
    const right = new Vector3().crossVectors(UP, direction).normalize();
    const up = new Vector3().crossVectors(direction, right).normalize();
    const tanV = Math.tan(this.camera.fov * Math.PI / 360), tanH = tanV * this.camera.aspect;
    let distance = 1e-6;
    for (const point of corners(box)) {
      point.sub(center);
      distance = Math.max(distance, point.dot(direction) + Math.max(Math.abs(point.dot(right)) * padding / tanH,
        Math.abs(point.dot(up)) * padding / tanV));
    }
    return distance + Math.max(1e-6, box.getSize(new Vector3()).length() * .001);
  }

  render(renderer: WebGLRenderer, scene: Scene, gameplayCamera: Camera, targets: readonly InspectionTarget[], beforeRender?: (camera: Camera) => void): void {
    recordSoundGameplayCamera(gameplayCamera);
    // Sample the game view before focus/xray modifies the camera or materials.
    // First-person hosts supply their camera-specific masks in their own scope.
    if (this.request && isInspectionCameraFrameActive()) {
      beforeRender?.(gameplayCamera);
      recordInspectionGameplayCamera(scene, gameplayCamera);
    }
    targets = [...targets, ...this.registered.values()];
    const listed = targetCatalog(targets, this.request);
    if (!this.request) {
      this.report = { status: 'inactive', targets: listed, omittedTargets: Math.max(0, targets.length - listed.length) };
      beforeRender?.(gameplayCamera);
      recordInspectionGameplayCamera(scene, gameplayCamera);
      renderProfiledView(renderer, scene, gameplayCamera); return;
    }
    const focus = this.request;
    const selected = targets.filter(target => focus.target !== undefined ? target.id === focus.target : target.player === (focus.player ?? 0));
    const unresolved = (reason: string): never => {
      this.report = { status: 'unavailable', reason, targets: listed, omittedTargets: Math.max(0, targets.length - listed.length) };
      throw new Error(`Inspection focus: ${reason} Registered targets: ${listed.slice(0, 16).map(target => target.id).join(', ') || 'none'}.`);
    };
    if (selected.length !== 1) { unresolved(selected.length ? 'Target selector matched multiple objects.' : 'Target is not registered in this frame.'); return; }
    const target = selected[0];
    if (!(target.object instanceof Object3D)) { unresolved('Registered target has no Three.js object.'); return; }
    let parent: Object3D | null = target.object;
    while (parent && parent !== scene) parent = parent.parent;
    if (!parent) { unresolved('Target is not attached to the rendered scene.'); return; }
    const relatedIds = [...new Set(focus.includeTargets ?? (focus.framing === 'interaction' ? target.relatedTargets ?? [] : []))].filter(id => id !== target.id).slice(0, 4);
    const members = [target], omittedRelations: { id: string; reason: string }[] = [];
    const subjectOrigin = target.object.getWorldPosition(new Vector3());
    for (const id of relatedIds) {
      const matches = targets.filter(candidate => candidate.id === id);
      const candidate = matches[0];
      if (matches.length !== 1 || !(candidate?.object instanceof Object3D)) { omittedRelations.push({ id, reason: matches.length > 1 ? 'ambiguous' : 'not-registered' }); continue; }
      let attached: Object3D | null = candidate.object;
      while (attached && attached !== scene) attached = attached.parent;
      if (!attached) { omittedRelations.push({ id, reason: 'not-attached' }); continue; }
      // Automatic context must not shrink a subject to a dot for a distant actor.
      // An explicit includeTargets request preserves the author's exact coverage.
      if (focus.includeTargets === undefined && candidate.object.getWorldPosition(new Vector3()).distanceTo(subjectOrigin) > 30) {
        omittedRelations.push({ id, reason: 'outside-automatic-context-range' }); continue;
      }
      members.push(candidate);
    }
    const visibility = new Map<Object3D, boolean>();
    const culling = new Map<Object3D, boolean>();
    // A first-person view may hide the whole body or an ancestor. Intentionally
    // hidden children stay hidden; the host disables its first-person part mask.
    for (const member of members) for (let object: Object3D | null = member.object; object; object = object.parent)
      if (!object.visible) { visibility.set(object, false); object.visible = true; }
    try {
      scene.updateMatrixWorld(true);
      const box = inspectionBounds(target.object);
      if (!finiteBox(box)) { unresolved('Target has no finite visible mesh bounds.'); return; }
      const memberBounds = [{ id: target.id, box: box.clone() }];
      for (let i = members.length - 1; i > 0; i--) {
        const bounds = inspectionBounds(members[i].object);
        if (!finiteBox(bounds)) { omittedRelations.push({ id: members[i].id, reason: 'no-visible-bounds' }); members.splice(i, 1); continue; }
        box.union(bounds); memberBounds.push({ id: members[i].id, box: bounds });
      }
      const size = renderer.getSize(new Vector2());
      this.camera.aspect = Number.isFinite(size.x / size.y) && size.x > 0 && size.y > 0 ? size.x / size.y : 1;
      this.camera.layers.mask = gameplayCamera.layers.mask;
      const targetObjects = descendants(target.object);
      for (const member of members.slice(1)) for (const object of descendants(member.object)) targetObjects.add(object);
      for (const object of targetObjects) {
        this.camera.layers.mask |= object.layers.mask;
        // Imported animated meshes may still carry a bind-pose boundingSphere.
        // The measured current bounds are authoritative for this inspection;
        // stale renderer bounds must not cull the subject we just framed.
        culling.set(object, object.frustumCulled); object.frustumCulled = false;
      }
      const padding = Math.min(2.5, Math.max(1.05, Number.isFinite(focus.padding) ? focus.padding! : 1.2));
      const worldOrigin = members.reduce((sum, member) => sum.add(member.object.getWorldPosition(new Vector3())), new Vector3()).multiplyScalar(1 / members.length);
      // This sphere conservatively encloses every candidate camera and every
      // target sight line, including the retained distance of an earlier pose.
      const range = Math.max(this.distance, box.getSize(new Vector3()).length() * padding
        / (Math.tan(this.camera.fov * Math.PI / 360) * Math.min(1, this.camera.aspect))) + 1;
      const region = box.clone().expandByScalar(range);
      let work = occluders(scene, targetObjects, this.camera, region);
      const groupKey = members.map(member => member.id).join('\0');
      const newSubject = this.target !== target.object, newGroup = this.groupKey !== groupKey;
      if (newSubject || newGroup) {
        if (newSubject) this.distance = 0;
        this.target = target.object; this.groupKey = groupKey;
        // A stable translated center preserves animated bob, jumps and turns in
        // the picture; recomputing the animated box center would cancel them.
        this.anchorOffset.copy(box.getCenter(new Vector3())).sub(worldOrigin);
      }
      const center = worldOrigin.add(this.anchorOffset);
      this.frame++;
      const currentDistance = this.fitDistance(box, center, this.direction, padding);
      const boxes = memberBounds.map(member => member.box);
      const recheckBlocked = !newSubject && !newGroup && focus.angle === 'auto' && this.frame % 15 === 0
        ? blockedGroupSamples(center.clone().addScaledVector(this.direction, Math.max(this.distance, currentDistance)), boxes, work) : 0;
      const recheck = recheckBlocked >= 3;
      if (newSubject || newGroup || recheck) {
        const forward = target.forward ? new Vector3(target.forward.x, target.forward.y, target.forward.z)
          : new Vector3(0, 0, 1).applyQuaternion(target.object.getWorldQuaternion(new Quaternion()));
        forward.y = 0;
        if (!forward.toArray().every(Number.isFinite) || forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
        forward.normalize();
        const span = members.length > 1 ? members[1].object.getWorldPosition(new Vector3()).sub(subjectOrigin) : undefined;
        // See both sides of an interaction at comparable depth. A character's
        // forward three-quarter angle can otherwise put the boss in front of
        // the player and make the player much smaller, despite fitting bounds.
        const interactionYaw = span && span.x ** 2 + span.z ** 2 > .01
          ? Math.atan2(span.x, span.z) - Math.atan2(forward.x, forward.z) + Math.PI / 2 : undefined;
        const automaticChoices = interactionYaw === undefined ? AUTO_ANGLES : [
          { angle: 'side' as const, yaw: interactionYaw }, { angle: 'side' as const, yaw: interactionYaw + Math.PI }, ...AUTO_ANGLES.slice(0, 6)];
        const choices = focus.angle && focus.angle !== 'auto' ? [{ angle: focus.angle, yaw: YAW[focus.angle] }] : automaticChoices;
        let best = recheck ? recheckBlocked - 1 : Infinity;
        const original = this.direction.clone();
        for (const { angle, yaw } of choices) {
          const direction = forward.clone().applyAxisAngle(UP, yaw); direction.y = .22; direction.normalize();
          const distance = this.fitDistance(box, center, direction, padding);
          const blocked = choices.length === 1 ? 0 : blockedGroupSamples(center.clone().addScaledVector(direction, distance), boxes, work);
          if (blocked < best) { best = blocked; this.direction.copy(direction); this.chosenAngle = angle; this.chosenYaw = yaw; }
          if (blocked === 0 || work.exhausted) break;
        }
        if (recheck && this.direction.distanceToSquared(original) > .0001) this.angleChanges++;
      }
      // Never zoom in/out with each stride. Expand only if a new pose needs room.
      // Interaction context can later leave; a slow contraction avoids retaining
      // a tiny subject forever after its partner departs. Subject closeups retain
      // their established zoom exactly as before.
      this.distance = Math.max(this.distance * (focus.framing === 'interaction' || focus.includeTargets?.length ? .985 : 1), this.fitDistance(box, center, this.direction, padding));
      this.camera.position.copy(center).addScaledVector(this.direction, this.distance);
      this.camera.up.copy(UP); this.camera.lookAt(center);
      const depth = corners(box).map(point => this.camera.position.clone().sub(point).dot(this.direction));
      this.camera.near = Math.max(1e-6, Math.min(.05, Math.min(...depth) / 4));
      this.camera.far = Math.max(100, this.distance + box.getSize(new Vector3()).length() * 4, gameplayCamera instanceof PerspectiveCamera ? gameplayCamera.far : 0);
      this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
      beforeRender?.(this.camera);
      // A camera callback may change room cutaways or billboard geometry.
      // Rebuild only when that callback is present; static hosts reuse work.
      if (beforeRender) work = occluders(scene, targetObjects, this.camera, region);
      const blocked = blockedGroupSamples(this.camera.position, boxes, work);
      const xray = focus.visibility === 'xray';
      const incomplete = work.omitted > 0 || work.exhausted;
      this.report = { status: 'focused', target: { id: target.id.slice(0, 128), ...(target.label ? { label: target.label.slice(0, 128) } : {}),
        ...(target.player === undefined ? {} : { player: target.player }) }, targets: listed,
        framing: members.length > 1 ? 'interaction' : 'subject', requestedFraming: focus.framing,
        interaction: { selection: focus.includeTargets !== undefined ? 'explicit' : 'declared',
          ...(target.relationReason && focus.framing === 'interaction' && focus.includeTargets === undefined ? { reason: target.relationReason.slice(0, 128) } : {}),
          includedTargets: members.map(member => member.id), omittedTargets: omittedRelations, automaticContextRange: 30 },
        omittedTargets: Math.max(0, targets.length - listed.length), angle: this.chosenAngle, initialYawDegrees: Math.round(this.chosenYaw * 180 / Math.PI),
        visibility: xray ? 'xray' : 'normal', visibilityAltered: xray, blockedSamples: blocked, visibilitySamples: work.lastSamples,
        occlusion: { status: incomplete ? 'partial' : 'complete', angleChanges: this.angleChanges, reevaluateEveryFrames: 15, nearbyPieces: work.blockers.length,
          testedInstances: work.testedInstances, omittedPieces: work.omitted, triangleTests: work.triangleTests, rays: work.rays },
        bounds: { min: rounded(box.min), max: rounded(box.max) },
        memberBounds: memberBounds.map(member => ({ id: member.id, min: rounded(member.box.min), max: rounded(member.box.max) })),
        camera: { position: rounded(this.camera.position), target: rounded(center), distance: Math.round(this.distance * 10000) / 10000,
          fov: this.camera.fov, aspect: this.camera.aspect },
        warnings: [...(blocked && !xray ? ['Target may be occluded. Set visibility:"xray" for an inspection-only overlay.'] : []),
          ...(incomplete ? ['Occlusion sampling reached its work budget; visibility and automatic angle are approximate.'] : [])] };
      renderProfiledView(renderer, scene, this.camera);
      if (xray) this.renderOverlay(renderer, scene, targetObjects);
    } finally {
      for (const [object, visible] of visibility) object.visible = visible;
      for (const [object, frustumCulled] of culling) object.frustumCulled = frustumCulled;
    }
  }

  private renderOverlay(renderer: WebGLRenderer, scene: Scene, target: Set<Object3D>): void {
    const layers = new Map<Object3D, number>();
    const background = scene.background, autoClear = renderer.autoClear;
    const autoShadow = renderer.shadowMap.autoUpdate, shadowNeedsUpdate = renderer.shadowMap.needsUpdate;
    try {
      // Layers suppress just a drawable, unlike visible=false which would also
      // suppress selected descendants. Lights and their existing shadows remain.
      scene.traverse(object => {
        if (('geometry' in object || 'isSprite' in object) && !target.has(object)) {
          layers.set(object, object.layers.mask); object.layers.mask = 0;
        }
      });
      scene.background = null; renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
      renderer.clearDepth(); renderProfiledView(renderer, scene, this.camera);
    } finally {
      for (const [object, mask] of layers) object.layers.mask = mask;
      scene.background = background; renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = autoShadow; renderer.shadowMap.needsUpdate = shadowNeedsUpdate;
    }
  }
}
