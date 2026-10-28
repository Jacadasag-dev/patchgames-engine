import { ArrowHelper, Group, Mesh, MeshBasicMaterial, Object3D, SphereGeometry, Vector3 } from 'three';
import { getInspectionEquipmentRoots, getInspectionOwner, isInspectionObjectVisible } from './inspectionGeometry.ts';
import type { EquipmentWeight } from './equipmentMotion.ts';

/** Semantic landmarks describe the actual authored model, independently of its
 * mesh axes. Positions are local to root or an explicitly bound descendant.
 * Bind moving parts (nocks, hinges, arrows) to their actual animated nodes. */
export interface EquipmentOrientationVector { x: number; y: number; z: number }
export interface EquipmentOrientationPoint {
  id: string;
  tags: readonly string[];
  position: Readonly<EquipmentOrientationVector>;
  node?: Object3D;
}
export interface EquipmentOrientationDirection {
  id: string;
  tags: readonly string[];
  from: string;
  to: string;
  /** The point whose motion is compared with this direction; defaults to to.
   * For an edge/face facing direction, use a moving blade point such as tip. */
  motionPoint?: string;
}
export interface EquipmentOrientationDefinition {
  /** Stable and unique among one actor's items. Shared factory users carrying
   * multiple identical models must give each an explicit orientationId. */
  id: string;
  /** Authored carry response, independent of gameplay damage or movement speed. */
  weight: EquipmentWeight;
  /** Blend the shared carry response with authored animation; 0 bypasses it. */
  motionInfluence?: number;
  grip: string;
  points: readonly EquipmentOrientationPoint[];
  directions: readonly EquipmentOrientationDirection[];
  /** Optional actor coordinate frame. Otherwise the outermost ancestor carrying
   * userData.inspectionActorId supplies it. Never use a camera as the owner. */
  owner?: Object3D;
}
export interface EquipmentOrientationPointSample {
  id: string; tags: string[]; position: EquipmentOrientationVector; visible: boolean;
  /** World-axis scene units/second; absent on the first or reset sample. */
  velocity?: EquipmentOrientationVector;
  /** Removes grip translation, retaining rotation about the grip. */
  gripRelativeVelocity?: EquipmentOrientationVector;
  /** Derivative in the actor frame, expressed in current world axes. Removes
   * actor locomotion/turning but retains actual hand translation and rotation. */
  ownerRelativeVelocity?: EquipmentOrientationVector;
}
export interface EquipmentOrientationDirectionSample {
  id: string; tags: string[]; from: string; to: string;
  direction: EquipmentOrientationVector; motionPoint: string;
  /** Signed velocity/direction cosine. Undefined for stationary motion. These
   * readings describe geometry, not an inference that a cut/thrust was intended. */
  worldAlignment?: number; gripRelativeAlignment?: number; ownerRelativeAlignment?: number;
}
export interface EquipmentOrientationSample {
  itemId: string; actorId?: string; timeMs: number; grip: string;
  weight: EquipmentWeight; motionInfluence: number;
  points: EquipmentOrientationPointSample[]; directions: EquipmentOrientationDirectionSample[];
  coverage: 'supported' | 'partial'; warnings: string[];
}
export interface EquipmentOrientationCoverage {
  actorId?: string; check: 'equipment-orientation'; status: 'supported' | 'partial' | 'unsupported'; reason?: string;
}
export interface EquipmentOrientationResult {
  items: EquipmentOrientationSample[]; coverage: EquipmentOrientationCoverage[]; truncated: boolean;
}
interface Registration {
  definition: EquipmentOrientationDefinition;
  points: (EquipmentOrientationPoint & { node: Object3D })[];
}
type RootReference = { deref(): Object3D | undefined };
const registrations = new WeakMap<Object3D, Registration>();
const references = new Set<RootReference>();
const rootReferences = new WeakMap<Object3D, RootReference>();
const xyz = (value: EquipmentOrientationVector) => new Vector3(value.x, value.y, value.z);
const plain = (value: Vector3): EquipmentOrientationVector => ({ x: value.x, y: value.y, z: value.z });
const finite = (value: EquipmentOrientationVector) => [value.x, value.y, value.z].every(v => Number.isFinite(v) && Math.abs(v) <= 1e8);
const label = (value: unknown, maximum = 64): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
function under(node: Object3D, root: Object3D): boolean {
  for (let parent: Object3D | null = node; parent; parent = parent.parent) if (parent === root) return true;
  return false;
}
function tags(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 8 && value.every(tag => label(tag, 32)) && new Set(value).size === value.length;
}
function worldPoint(point: EquipmentOrientationPoint & { node: Object3D }): Vector3 {
  // Matrix-owned attachments need the complete changed ancestor chain refreshed.
  for (let node: Object3D | null = point.node; node; node = node.parent) node.matrixWorldNeedsUpdate = true;
  point.node.updateWorldMatrix(true, false);
  return xyz(point.position).applyMatrix4(point.node.matrixWorld);
}
function independent(directions: readonly Vector3[]): boolean {
  return directions.some((a, index) => directions.slice(index + 1).some(b => a.clone().cross(b).lengthSq() > 1e-8));
}
/** Define once while constructing each held item, before attachEquipment.
 * At least two independent directions are required: a single aim axis cannot
 * distinguish a sharp edge from a flat face. Tags remain open for custom items.
 * Registration itself has no gameplay-frame work. Returns explicit disposal. */
export function registerEquipmentOrientation(root: Object3D, definition: EquipmentOrientationDefinition): () => void {
  if (!(root instanceof Object3D) || !definition || !label(definition.id, 128) || !label(definition.grip)
    || !Array.isArray(definition.points) || definition.points.length < 3 || definition.points.length > 16
    || !Array.isArray(definition.directions) || definition.directions.length < 2 || definition.directions.length > 16
    || definition.owner !== undefined && !(definition.owner instanceof Object3D))
    throw new Error('Equipment orientation requires an item ID, grip, 3..16 tagged points and 2..16 tagged directions.');
  if (!['medium', 'heavy', 'xheavy'].includes(definition.weight))
    throw new Error('Equipment orientation requires an explicit weight: medium, heavy or xheavy.');
  if (definition.motionInfluence !== undefined && (!Number.isFinite(definition.motionInfluence) || definition.motionInfluence < 0 || definition.motionInfluence > 1))
    throw new Error('Equipment motionInfluence must be within 0..1.');
  if (new Set(definition.points.map(point => point.id)).size !== definition.points.length
    || new Set(definition.directions.map(direction => direction.id)).size !== definition.directions.length)
    throw new Error('Equipment orientation point and direction IDs must be unique.');
  const points = definition.points.map(point => {
    const node = point.node ?? root;
    if (!label(point.id) || !tags(point.tags) || !point.position || !finite(point.position) || !(node instanceof Object3D) || !under(node, root))
      throw new Error('Equipment orientation points require bounded finite local positions, tags and a root/descendant node.');
    return { id: point.id, tags: [...point.tags], position: { ...point.position }, node };
  });
  const positions = new Map(points.map(point => [point.id, worldPoint(point)]));
  if (!positions.has(definition.grip)) throw new Error('Equipment orientation grip must reference an existing anchor point.');
  const directions = definition.directions.map(direction => {
    if (!label(direction.id) || !tags(direction.tags) || !positions.has(direction.from) || !positions.has(direction.to)
      || !positions.has(direction.motionPoint ?? direction.to)) throw new Error('Equipment orientation directions require tags and valid landmark references.');
    const delta = positions.get(direction.to)!.clone().sub(positions.get(direction.from)!);
    if (!finite(delta) || delta.lengthSq() < 1e-12) throw new Error('Equipment orientation direction points must be distinct and finite.');
    return { ...direction, tags: [...direction.tags], motionPoint: direction.motionPoint ?? direction.to };
  });
  const vectors = directions.map(direction => positions.get(direction.to)!.clone().sub(positions.get(direction.from)!).normalize());
  if (!independent(vectors)) throw new Error('Equipment orientation requires two non-collinear directions to describe its roll.');
  const registration: Registration = { definition: { ...definition, points, directions }, points };
  registrations.set(root, registration);
  if (!rootReferences.has(root)) {
    const reference = typeof WeakRef === 'function' ? new WeakRef(root) : { deref: () => root };
    rootReferences.set(root, reference); references.add(reference);
  }
  return () => {
    if (registrations.get(root) !== registration) return;
    registrations.delete(root);
    const reference = rootReferences.get(root); if (reference) references.delete(reference);
    rootReferences.delete(root);
  };
}
/** Runtime authoring contract used by attachEquipment; never silently guesses
 * orientation from a mesh bounding box or the root's arbitrary local axes. */
export function requireEquipmentOrientation(root: Object3D): void {
  if (!registrations.has(root)) throw new Error(`Held item ${root.name || 'model'} requires registerEquipmentOrientation() with a weight, anchor, tagged landmarks and directions before attachEquipment().`);
}
/** Read authored carry metadata without exposing mutable registration state.
 * Attachment/rig adapters decide which limb carries the item; no mesh inference. */
export function getEquipmentMotionDefinition(root: Object3D): Readonly<{ id: string; weight: EquipmentWeight; influence: number }> | undefined {
  const definition = registrations.get(root)?.definition;
  return definition && Object.freeze({ id: definition.id, weight: definition.weight, influence: definition.motionInfluence ?? 1 });
}
/** Inspection camera consumes the same authored landmarks as orientation
 * telemetry, including moving subparts. No guessed mesh axes or item roles. */
export function inspectionEquipmentSemanticRoot(root: Object3D): Object3D | undefined {
  let semantic: Object3D | undefined;
  for (let node: Object3D | null = root; node; node = node.parent) if (registrations.has(node)) semantic = node;
  return semantic;
}
export function inspectionEquipmentLandmarks(root: Object3D): { itemId: string; points: { position: Vector3; visible: boolean }[] } | undefined {
  const registration = registrations.get(root);
  if (!registration) return;
  return { itemId: registration.definition.id, points: registration.points.map(point => ({
    position: worldPoint(point), visible: under(point.node, root) && isInspectionObjectVisible(point.node, root),
  })) };
}
/** Optional debug display: green grip, yellow tip, red sharp edges, blue flat
 * faces, orange aim, cyan custom tags. The returned group uses root coordinates;
 * add it directly to the model (or an identity debug child), update after moving
 * authored subparts, and dispose with the model. No text/canvas dependencies. */
export function createEquipmentOrientationMarkers(root: Object3D): { root: Group; update(): void; dispose(): void } {
  requireEquipmentOrientation(root);
  const markers = new Group(); markers.name = 'equipment-orientation-markers';
  const geometry = new SphereGeometry(.018, 6, 4), paints = new Map<number, MeshBasicMaterial>();
  const dots = new Map<string, Mesh>(), arrows = new Map<string, ArrowHelper>();
  const color = (tags: readonly string[]) => tags.includes('grip') ? 0x5cf28c : tags.includes('sharp-edge') ? 0xff596c
    : tags.includes('flat-face') ? 0x579aff : tags.includes('aim') || tags.includes('projectile') ? 0xffa33e
      : tags.includes('tip') ? 0xffe164 : 0x55e9dd;
  const paint = (value: number) => {
    let material = paints.get(value);
    if (!material) { material = new MeshBasicMaterial({ color: value, depthTest: false, depthWrite: false }); paints.set(value, material); }
    return material;
  };
  let disposed = false;
  const update = () => {
    if (disposed) return;
    const registration = registrations.get(root); if (!registration) { markers.visible = false; return; }
    root.updateWorldMatrix(true, false);
    if (Math.abs(root.matrixWorld.determinant()) < 1e-12) { markers.visible = false; return; }
    markers.visible = true;
    const positions = new Map<string, Vector3>();
    for (const point of registration.points) {
      const location = worldPoint(point); root.updateWorldMatrix(true, false);
      const local = root.worldToLocal(location);
      if (!under(point.node, root) || !finite(local)) continue;
      positions.set(point.id, local);
      let dot = dots.get(point.id);
      if (!dot) {
        dot = new Mesh(geometry, paint(color(point.tags))); dot.name = `orientation-point:${point.id}`;
        dot.userData.orientationTags = [...point.tags]; dot.renderOrder = 1000; markers.add(dot); dots.set(point.id, dot);
      }
      dot.material = paint(color(point.tags)); dot.userData.orientationTags = [...point.tags];
      dot.position.copy(local); dot.visible = isInspectionObjectVisible(point.node, root);
    }
    for (const [id, dot] of dots) if (!positions.has(id)) dot.visible = false;
    const currentDirections = new Set(registration.definition.directions.map(direction => direction.id));
    for (const [id, arrow] of arrows) if (!currentDirections.has(id)) arrow.visible = false;
    for (const direction of registration.definition.directions) {
      const from = positions.get(direction.from), to = positions.get(direction.to);
      if (!from || !to) { if (arrows.has(direction.id)) arrows.get(direction.id)!.visible = false; continue; }
      const delta = to.clone().sub(from); if (delta.lengthSq() < 1e-12) { if (arrows.has(direction.id)) arrows.get(direction.id)!.visible = false; continue; }
      let arrow = arrows.get(direction.id);
      if (!arrow) {
        arrow = new ArrowHelper(delta.clone().normalize(), from, .18, color(direction.tags), .045, .025);
        // ArrowHelper shares its base geometries; own these before disposal.
        arrow.line.geometry = arrow.line.geometry.clone(); arrow.cone.geometry = arrow.cone.geometry.clone();
        arrow.name = `orientation-direction:${direction.id}`; arrow.userData.orientationTags = [...direction.tags];
        for (const drawable of [arrow.line, arrow.cone]) {
          drawable.renderOrder = 1000;
          for (const material of Array.isArray(drawable.material) ? drawable.material : [drawable.material]) { material.depthTest = false; material.depthWrite = false; }
        }
        markers.add(arrow); arrows.set(direction.id, arrow);
      }
      arrow.setColor(color(direction.tags)); arrow.userData.orientationTags = [...direction.tags];
      arrow.position.copy(from); arrow.setDirection(delta.normalize()); arrow.visible = !!dots.get(direction.from)?.visible && !!dots.get(direction.to)?.visible;
    }
  };
  update();
  return { root: markers, update, dispose: () => {
    if (disposed) return; disposed = true; markers.removeFromParent(); geometry.dispose(); paints.forEach(material => material.dispose());
    for (const arrow of arrows.values()) for (const drawable of [arrow.line, arrow.cone]) {
      drawable.geometry.dispose(); for (const material of Array.isArray(drawable.material) ? drawable.material : [drawable.material]) material.dispose();
    }
  } };
}
function ownerOf(root: Object3D, explicit?: Object3D): { owner?: Object3D; actorId?: string } {
  const registered = getInspectionOwner(root);
  let owner = explicit ?? registered?.root, actorId = registered?.actorId;
  for (let parent: Object3D | null = explicit ?? root; parent; parent = parent.parent) {
    const id = parent.userData.inspectionActorId;
    if (label(id, 160)) { actorId = id; if (!explicit && !registered) owner = parent; }
  }
  return { owner, actorId };
}
function alignment(velocity: EquipmentOrientationVector | undefined, direction: Vector3): number | undefined {
  if (!velocity) return undefined;
  const vector = xyz(velocity), length = vector.length();
  return length > 1e-4 ? Math.max(-1, Math.min(1, vector.dot(direction) / length)) : undefined;
}
interface History {
  registration: Registration; timeMs: number; serial: number; owner?: Object3D;
  positions: Map<string, Vector3>; relative: Map<string, Vector3>; local: Map<string, Vector3>;
  visiblePoints: Set<string>;
}
/** One sampler per inspection/replay. Histories cannot leak between inspections
 * or draw velocity across hidden intervals, time resets, or replaced assets. */
export function createEquipmentOrientationSampler(): {
  sample(options: { timeMs: number; root?: Object3D }): EquipmentOrientationResult;
  reset(): void;
} {
  let history = new WeakMap<Object3D, History>(), serial = 0;
  return {
    reset: () => { history = new WeakMap(); serial = 0; },
    sample: ({ timeMs, root: scope }) => {
      const result: EquipmentOrientationResult = { items: [], coverage: [], truncated: false }; serial++;
      if (!Number.isFinite(timeMs)) {
        result.coverage.push({ check: 'equipment-orientation', status: 'unsupported', reason: 'Inspection time is not finite.' });
        result.truncated = true; history = new WeakMap(); return result;
      }
      let examined = 0;
      for (const reference of references) {
        const root = reference.deref();
        if (!root) { references.delete(reference); continue; }
        const registration = registrations.get(root);
        if (!registration || !isInspectionObjectVisible(root, scope)) continue;
        // An annotated wrapper owns the semantic item. Reference factories can
        // be nested inside custom authored items without reporting them twice.
        let wrapped = false;
        for (let parent = root.parent; parent; parent = parent.parent) if (registrations.has(parent)) { wrapped = true; break; }
        if (wrapped) continue;
        if (examined++ >= 64) { result.truncated = true; break; }
        const { definition } = registration, { owner, actorId } = ownerOf(root, definition.owner), warnings: string[] = [];
        const positions = new Map<string, Vector3>(), relative = new Map<string, Vector3>(), local = new Map<string, Vector3>();
        for (const point of registration.points) {
          if (!under(point.node, root)) { warnings.push(`Landmark ${point.id} is no longer attached to the item.`); continue; }
          const position = worldPoint(point);
          if (!finite(position)) { warnings.push(`Landmark ${point.id} has a nonfinite world transform.`); continue; }
          positions.set(point.id, position);
        }
        const grip = positions.get(definition.grip);
        if (!grip) {
          result.coverage.push({ actorId, check: 'equipment-orientation', status: 'unsupported', reason: `Item ${definition.id} has no valid world grip landmark.`.slice(0, 240) });
          history.delete(root); continue;
        }
        let ownerInverse: import('three').Matrix4 | undefined;
        if (owner) {
          for (let node: Object3D | null = owner; node; node = node.parent) node.matrixWorldNeedsUpdate = true;
          owner.updateWorldMatrix(true, false);
          if (owner.matrixWorld.elements.every(Number.isFinite) && Math.abs(owner.matrixWorld.determinant()) > 1e-12) ownerInverse = owner.matrixWorld.clone().invert();
          else warnings.push('Owner frame is nonfinite or degenerate; owner-relative motion is unavailable.');
        } else warnings.push('No owning actor frame; owner-relative motion is unavailable.');
        for (const [id, position] of positions) {
          relative.set(id, position.clone().sub(grip));
          if (ownerInverse) local.set(id, position.clone().applyMatrix4(ownerInverse));
        }
        const old = history.get(root), dt = old ? (timeMs - old.timeMs) / 1000 : 0;
        const continuous = !!old && old.registration === registration && old.serial === serial - 1 && dt > 0 && dt <= .25 && old.owner === owner;
        const points: EquipmentOrientationPointSample[] = [], visiblePoints = new Set<string>();
        for (const point of registration.points) {
          const position = positions.get(point.id); if (!position) continue;
          const sample: EquipmentOrientationPointSample = { id: point.id, tags: [...point.tags], position: plain(position), visible: isInspectionObjectVisible(point.node, scope) };
          if (sample.visible) visiblePoints.add(point.id);
          if (sample.visible && continuous && old.visiblePoints.has(point.id) && old.positions.has(point.id) && old.relative.has(point.id)) {
            sample.velocity = plain(position.clone().sub(old.positions.get(point.id)!).divideScalar(dt));
            sample.gripRelativeVelocity = plain(relative.get(point.id)!.clone().sub(old.relative.get(point.id)!).divideScalar(dt));
            if (owner && local.has(point.id) && old.local.has(point.id)) {
              const previousInCurrentWorld = old.local.get(point.id)!.clone().applyMatrix4(owner.matrixWorld);
              sample.ownerRelativeVelocity = plain(position.clone().sub(previousInCurrentWorld).divideScalar(dt));
            }
            if ([sample.velocity, sample.gripRelativeVelocity, sample.ownerRelativeVelocity].some(value => value && !finite(value))) {
              delete sample.velocity; delete sample.gripRelativeVelocity; delete sample.ownerRelativeVelocity;
              warnings.push(`Landmark ${point.id} motion is nonfinite or exceeds the measurement bound.`);
            }
          }
          points.push(sample);
        }
        const directions: EquipmentOrientationDirectionSample[] = [];
        for (const authored of definition.directions) {
          const from = positions.get(authored.from), to = positions.get(authored.to), motionPoint = authored.motionPoint ?? authored.to;
          if (!from || !to) { warnings.push(`Direction ${authored.id} has unavailable landmarks.`); continue; }
          const direction = to.clone().sub(from);
          if (direction.lengthSq() < 1e-12) { warnings.push(`Direction ${authored.id} collapsed to zero length.`); continue; }
          direction.normalize();
          const moving = points.find(point => point.id === motionPoint);
          directions.push({ id: authored.id, tags: [...authored.tags], from: authored.from, to: authored.to, direction: plain(direction), motionPoint,
            worldAlignment: alignment(moving?.velocity, direction), gripRelativeAlignment: alignment(moving?.gripRelativeVelocity, direction),
            ownerRelativeAlignment: alignment(moving?.ownerRelativeVelocity, direction) });
        }
        if (!independent(directions.map(direction => xyz(direction.direction)))) warnings.push('World orientation directions are collinear or unavailable.');
        const coverage = warnings.length ? 'partial' : 'supported';
        result.items.push({ itemId: definition.id, actorId, timeMs, grip: definition.grip, weight: definition.weight,
          motionInfluence: definition.motionInfluence ?? 1, points, directions, coverage, warnings: warnings.slice(0, 16).map(warning => warning.slice(0, 160)) });
        result.coverage.push({ actorId, check: 'equipment-orientation', status: coverage,
          reason: coverage === 'partial' ? `Item ${definition.id}: ${warnings[0]}`.slice(0, 240) : undefined });
        history.set(root, { registration, timeMs, serial, owner, positions, relative, local, visiblePoints });
      }
      const groups = new Map<string, EquipmentOrientationSample[]>(), used = new Set<string>();
      const identity = (actorId: string | undefined, itemId: string) => JSON.stringify([actorId ?? null, itemId]);
      for (const item of result.items) {
        const key = identity(item.actorId, item.itemId); used.add(key);
        const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
      }
      for (const group of groups.values()) if (group.length > 1) {
        const authoredId = group[0].itemId;
        group.forEach((item, index) => {
          item.coverage = 'partial';
          item.warnings.unshift(`Duplicate item ID ${authoredId}; give each held item a unique orientationId.`.slice(0, 160));
          item.warnings.length = Math.min(16, item.warnings.length);
          // Preserve every observation through downstream maps. Suffixes are
          // explicitly diagnostic identities, never a replacement authoring ID.
          if (index > 0) {
            let suffix = index + 1, candidate: string;
            do { candidate = `${authoredId.slice(0, 104)}#duplicate-${suffix++}`; } while (used.has(identity(item.actorId, candidate)));
            item.itemId = candidate; used.add(identity(item.actorId, candidate));
          }
        });
        if (result.coverage.length < 127) result.coverage.push({ actorId: group[0].actorId, check: 'equipment-orientation', status: 'partial',
          reason: `Duplicate item ID ${authoredId}; diagnostic suffixes preserve each item, but unique authored orientationId values are required.`.slice(0, 240) });
        else result.truncated = true;
      }
      const known = getInspectionEquipmentRoots({ root: scope }); result.truncated ||= known.truncated;
      for (const root of known.roots) {
        let annotated = false;
        for (let parent: Object3D | null = root; parent; parent = parent.parent) if (registrations.has(parent)) { annotated = true; break; }
        if (annotated) continue;
        if (result.coverage.length >= 127) { result.truncated = true; break; }
        result.coverage.push({ actorId: ownerOf(root).actorId, check: 'equipment-orientation', status: 'unsupported',
          reason: `Held item ${root.name || 'equipment'} has no semantic orientation landmarks; registerEquipmentOrientation is required.`.slice(0, 240) });
      }
      if (result.truncated) result.coverage.push({ check: 'equipment-orientation', status: 'partial', reason: 'Equipment orientation exceeded the 64-item inspection budget.' });
      return result;
    },
  };
}
