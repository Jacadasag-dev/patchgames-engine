import { Object3D, Vector3 } from 'three';

/** Inspection-only narrow-phase geometry. These deliberately small, named
 * capsules approximate visible solids; they are NOT exact triangle collisions.
 * Registrations cost no per-frame work during gameplay. Collection is invoked
 * automatically by the inspector after animation, IK and visibility restoration. */
export interface InspectionPoint { x: number; y: number; z: number }
export interface InspectionCapsule {
  id: string; node: Object3D; a: InspectionPoint; b?: InspectionPoint; radius: number;
  /** Only these named body parts are intentional contacts, e.g. a handle/palm.
   * Do not exempt the blade merely because its handle is attached to a hand. */
  allowedBodyParts?: readonly string[];
}
interface ActorGeometry { parts: readonly InspectionCapsule[]; id?: string; reason?: string }
interface EquipmentGeometry { parts: readonly InspectionCapsule[]; reason?: string }
export interface InspectionGeometryOverlap {
  actorId: string; pair: string; kind: 'equipment-body' | 'equipment-ground'; timeMs: number;
  depth: number; position: InspectionPoint; approximation: 'capsule-proxy'; intent: 'unknown' | 'allowed';
}
export interface InspectionGeometryCoverage {
  actorId?: string; check: string; status: 'supported' | 'unsupported' | 'partial'; reason?: string;
}
export interface InspectionGeometryResult {
  overlaps: InspectionGeometryOverlap[]; coverage: InspectionGeometryCoverage[];
  stats: { actors: number; equipment: number; checkedPairs: number; groundSamples: number; truncated: boolean };
}
const actors = new WeakMap<Object3D, ActorGeometry>(), equipment = new WeakMap<Object3D, EquipmentGeometry>();
type RootReference = { deref(): Object3D | undefined };
const actorRoots = new Set<RootReference>(), equipmentRoots = new Set<RootReference>();
// Browser workers support WeakRef. Bounded, short-lived QuickJS view tests may
// omit it; those still need to construct ordinary shared rigs and equipment.
const reference = (root: Object3D): RootReference => typeof WeakRef === 'function' ? new WeakRef(root) : { deref: () => root };
const ground = new WeakMap<Object3D, (x: number, z: number) => number | undefined>();
const renderHidden = new WeakSet<Object3D>();
const point = (p: InspectionPoint) => new Vector3(p.x, p.y, p.z);
const plain = (p: Vector3): InspectionPoint => ({ x: p.x, y: p.y, z: p.z });
function validate(parts: readonly InspectionCapsule[]): void {
  if (parts.length > 64 || new Set(parts.map(part => part.id)).size !== parts.length) throw new Error('Inspection geometry needs at most 64 uniquely named proxies.');
  for (const part of parts) if (!(part.node instanceof Object3D) || !part.id || part.id.length > 96
    || !Number.isFinite(part.radius) || part.radius <= 0 || part.radius > 1000
    || ![part.a.x, part.a.y, part.a.z, ...(part.b ? [part.b.x, part.b.y, part.b.z] : [])].every(Number.isFinite))
    throw new Error('Inspection capsules require finite local points and positive radii.');
}
/** Public adapter for custom anatomy. An empty list explicitly reports missing
 * geometry instead of inventing a body shape or returning a misleading pass. */
export function registerInspectionActor(root: Object3D, parts: readonly InspectionCapsule[], options: { id?: string; reason?: string } = {}): void {
  validate(parts); if (!actors.has(root)) actorRoots.add(reference(root));
  actors.set(root, { parts: [...parts], ...options });
}
export function registerInspectionEquipment(root: Object3D, parts: readonly InspectionCapsule[], reason?: string): void {
  validate(parts); if (!equipment.has(root)) equipmentRoots.add(reference(root));
  equipment.set(root, { parts: [...parts], reason });
}
/** A custom attached object without authored proxies is explicitly unsupported. */
export function registerInspectionAttachment(root: Object3D): void {
  if (!equipment.has(root)) registerInspectionEquipment(root, [], 'Attached equipment has no authored inspection proxies.');
}
/** Bind only the accepted authoritative terrain query, never a guessed Y=0 plane.
 * Return undefined outside its domain or when support is unknown. */
export function registerInspectionGround(root: Object3D, sample: (x: number, z: number) => number | undefined): void { ground.set(root, sample); }
export function registerInspectionTerrain(root: Object3D, terrain: { sample(x: number, z: number): { height: number; inside: boolean } }): void {
  registerInspectionGround(root, (x, z) => { const sample = terrain.sample(x, z); return sample.inside ? sample.height : undefined; });
}
/** Legacy first-person views draw a camera-relative copy of the same held
 * object. Preserve inspection of its world-space original while render-masked;
 * genuinely unequipped/hidden objects must not use this exemption. */
export function setInspectionRenderHidden(node: Object3D, hidden: boolean): void { if (hidden) renderHidden.add(node); else renderHidden.delete(node); }

/** Legacy camelCase and detailed humanoids share named anatomical coverage.
 * Local dimensions scale alongside reference-rig translations. Models with
 * different proportions can replace this registration using the public adapter. */
export function registerHumanoidInspection(root: Object3D, joints: Readonly<Record<string, Object3D>>, scale = 1): void {
  if (!joints.hips || !joints.head || !(joints['spine-2'] || joints.spine)
    || !(joints['left-shoulder'] || joints.leftShoulder) || !(joints['right-shoulder'] || joints.rightShoulder)) {
    registerInspectionActor(root, [], { reason: 'Custom anatomy has no authored body proxies.' }); return;
  }
  const parts: InspectionCapsule[] = [];
  const add = (id: string, names: string[], a: InspectionPoint, b: InspectionPoint | undefined, radius: number) => {
    const node = names.map(name => joints[name]).find(Boolean); if (!node) return;
    const scaled = (p: InspectionPoint) => ({ x: p.x * scale, y: p.y * scale, z: p.z * scale });
    parts.push({ id, node, a: scaled(a), b: b && scaled(b), radius: radius * scale });
  };
  const detailed = !!joints['spine-1'];
  add('head', ['head'], { x: 0, y: detailed ? .04 : .06, z: 0 }, undefined, detailed ? .175 : .23);
  add('torso', ['spine-2', 'spine'], { x: 0, y: detailed ? -.05 : -.08, z: 0 }, { x: 0, y: detailed ? .24 : .31, z: 0 }, detailed ? .145 : .30);
  add('pelvis', ['hips'], { x: -.10, y: 0, z: 0 }, { x: .10, y: 0, z: 0 }, .12);
  for (const side of ['left', 'right']) {
    add(`${side}-upper-arm`, [`${side}-shoulder`, `${side}Shoulder`], { x: 0, y: -.05, z: 0 }, { x: 0, y: -.25, z: 0 }, .07);
    add(`${side}-forearm`, [`${side}-elbow`, `${side}Elbow`], { x: 0, y: -.04, z: 0 }, { x: 0, y: -.24, z: 0 }, .055);
    add(`${side}-hand`, [`${side}-hand`, `${side}Hand`], { x: 0, y: -.04, z: 0 }, undefined, .065);
    add(`${side}-thigh`, [`${side}-hip`, `${side}Hip`], { x: 0, y: -.06, z: 0 }, { x: 0, y: -.32, z: 0 }, .08);
    add(`${side}-shin`, [`${side}-knee`, `${side}Knee`], { x: 0, y: -.05, z: 0 }, { x: 0, y: -.31, z: 0 }, .07);
  }
  registerInspectionActor(root, parts, { reason: parts.length ? 'Named humanoid solid proxies; clothing, hair and accessories are not exact mesh geometry.' : 'Custom anatomy has no authored body proxies.' });
}
function visible(node: Object3D, scope?: Object3D): boolean {
  let connected = false;
  for (let n: Object3D | null = node; n; n = n.parent) {
    if (!n.visible && !renderHidden.has(n)) return false;
    if (scope ? n === scope : n.type === 'Scene') connected = true;
  }
  return connected;
}
function owningActor(node: Object3D): Object3D | undefined { for (let n: Object3D | null = node; n; n = n.parent) if (actors.has(n)) return n; }
function actorId(root: Object3D): string {
  for (let n: Object3D | null = root; n; n = n.parent) if (typeof n.userData.inspectionActorId === 'string' && n.userData.inspectionActorId) return boundedLabel(n.userData.inspectionActorId);
  return boundedLabel(actors.get(root)?.id || `${root.name || 'actor'}:${root.id}`);
}
/** Shared inspection adapters use the same ownership and first-person masking
 * rules as overlap checks. Returned nodes are references, never serialized. */
export function getInspectionOwner(node: Object3D): { root: Object3D; actorId: string } | undefined {
  const root = owningActor(node); return root ? { root, actorId: actorId(root) } : undefined;
}
export function isInspectionObjectVisible(node: Object3D, scope?: Object3D): boolean { return visible(node, scope); }
export function getInspectionEquipmentRoots(options: { root?: Object3D } = {}): { roots: Object3D[]; truncated: boolean } {
  const roots: Object3D[] = [];
  for (const reference of equipmentRoots) {
    const root = reference.deref(); if (!root) { equipmentRoots.delete(reference); continue; }
    if (!visible(root, options.root)) continue;
    if (roots.length >= 128) return { roots, truncated: true };
    roots.push(root);
  }
  return { roots, truncated: false };
}
function groundFor(root: Object3D): ((x: number, z: number) => number | undefined) | undefined {
  for (let n: Object3D | null = root; n; n = n.parent) { const sample = ground.get(n); if (sample) return sample; }
}
interface WorldCapsule { id: string; a: Vector3; b: Vector3; radius: number; partial: boolean; allowed?: readonly string[] }
function world(part: InspectionCapsule): WorldCapsule | undefined {
  // Matrix-owned equipment can have stale descendants until its whole ancestor
  // chain is refreshed; update every chain before reading the current pose.
  for (let n: Object3D | null = part.node; n; n = n.parent) n.matrixWorldNeedsUpdate = true;
  part.node.updateWorldMatrix(true, false);
  const m = part.node.matrixWorld, e = m.elements;
  const sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
  const maximum = Math.max(sx, sy, sz), minimum = Math.min(sx, sy, sz);
  if (!Number.isFinite(maximum) || minimum < 1e-8) return;
  const a = point(part.a).applyMatrix4(m), b = point(part.b ?? part.a).applyMatrix4(m);
  if (![...a, ...b].every(Number.isFinite)) return;
  // Max axis is conservative under anisotropic scale. Such checks remain
  // explicitly partial rather than pretending these are exact round capsules.
  const shear = Math.max(Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]), Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]),
    Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10])) > maximum * maximum * 1e-4;
  return { id: part.id, a, b, radius: part.radius * (shear ? Math.hypot(sx, sy, sz) : maximum), partial: shear || maximum - minimum > maximum * 1e-4,
    allowed: part.allowedBodyParts };
}
/** Closest points of finite 3D line segments, including zero-length spheres. */
function closest(a: WorldCapsule, b: WorldCapsule): [Vector3, Vector3] {
  const u = a.b.clone().sub(a.a), v = b.b.clone().sub(b.a), w = a.a.clone().sub(b.a);
  const aa = u.dot(u), bb = u.dot(v), cc = v.dot(v), dd = u.dot(w), ee = v.dot(w);
  let s = 0, t = 0;
  if (aa <= 1e-12 && cc <= 1e-12) return [a.a.clone(), b.a.clone()];
  if (aa <= 1e-12) t = Math.max(0, Math.min(1, ee / cc));
  else if (cc <= 1e-12) s = Math.max(0, Math.min(1, -dd / aa));
  else {
    const denominator = aa * cc - bb * bb;
    s = denominator > 1e-12 ? Math.max(0, Math.min(1, (bb * ee - cc * dd) / denominator)) : 0;
    t = (bb * s + ee) / cc;
    if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -dd / aa)); }
    else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (bb - dd) / aa)); }
  }
  return [a.a.clone().addScaledVector(u, s), b.a.clone().addScaledVector(v, t)];
}
/** Run once after each inspected view update. No gameplay code invokes this.
 * Work/output budgets are fixed; budget exhaustion is explicit partial coverage.
 * Contacts under 5mm are ignored so touching/support does not become an alarm. */
export function collectInspectionGeometry(options: { timeMs?: number; root?: Object3D } = {}): InspectionGeometryResult {
  const result: InspectionGeometryResult = { overlaps: [], coverage: [], stats: { actors: 0, equipment: 0, checkedPairs: 0, groundSamples: 0, truncated: false } };
  const roots: Object3D[] = [];
  for (const ref of actorRoots) { const root = ref.deref(); if (!root) { actorRoots.delete(ref); continue; } if (visible(root, options.root)) roots.push(root); }
  const equipped = new Map<Object3D, Object3D[]>();
  for (const ref of equipmentRoots) {
    const root = ref.deref(); if (!root) { equipmentRoots.delete(ref); continue; } if (!visible(root, options.root)) continue;
    const owner = owningActor(root);
    if (owner) { const list = equipped.get(owner) ?? []; list.push(root); equipped.set(owner, list); }
    else result.coverage.push({ check: 'equipment-body', status: 'unsupported', reason: `Equipment ${root.name || root.id} has no registered owning actor.` });
  }
  actorLoop: for (const root of roots.slice(0, 64)) {
    result.stats.actors++;
    const id = actorId(root), actor = actors.get(root)!, models = equipped.get(root) ?? [], sampleGround = groundFor(root);
    const body = actor.parts.filter(p => visible(p.node, options.root)).map(world).filter((p): p is WorldCapsule => !!p);
    let partialBody = body.length !== actor.parts.length || body.some(p => p.partial), partialGround = false;
    let missingEquipment = false, hasEquipment = false;
    for (const model of models.slice(0, 16)) {
      const label = equipmentLabel(model, root);
      const geometry = equipment.get(model)!;
      // An outer attachment wrapper can contain already registered models.
      if (!geometry.parts.length && models.some(other => other !== model && isDescendant(other, model) && equipment.get(other)!.parts.length)) continue;
      result.stats.equipment++; hasEquipment = true;
      if (!geometry.parts.length) { missingEquipment = true; continue; }
      for (const part of geometry.parts) {
        if (!visible(part.node, options.root)) continue;
        const solid = world(part); if (!solid) { partialBody = partialGround = true; continue; }
        if (solid.partial) partialBody = partialGround = true;
        for (const target of body) {
          if (result.stats.checkedPairs >= 32768) { result.stats.truncated = true; break actorLoop; }
          result.stats.checkedPairs++;
          const [a, b] = closest(solid, target), depth = solid.radius + target.radius - a.distanceTo(b);
          if (depth > .005) push({ actorId: id, pair: boundedLabel(`${label}:${solid.id}/${target.id}`), kind: 'equipment-body', timeMs: options.timeMs ?? 0,
            depth, position: plain(a.add(b).multiplyScalar(.5)), approximation: 'capsule-proxy',
            intent: solid.allowed?.includes(target.id) ? 'allowed' : 'unknown' });
        }
        if (sampleGround) {
          // Sample along each solid with <=5cm spacing (bounded at 32). This
          // includes both ends and catches a blade crossing a terrain ridge.
          const steps = Math.min(32, Math.max(1, Math.ceil(solid.a.distanceTo(solid.b) / .05)));
          let maximum = .005, at: Vector3 | undefined;
          for (let i = 0; i <= steps; i++) {
            if (result.stats.groundSamples >= 32768) { result.stats.truncated = true; break actorLoop; }
            const p = solid.a.clone().lerp(solid.b, i / steps); result.stats.groundSamples++;
            let y: number | undefined; try { y = sampleGround(p.x, p.z); } catch { partialGround = true; continue; }
            if (y === undefined || !Number.isFinite(y)) { partialGround = true; continue; }
            const depth = y - (p.y - solid.radius); if (depth > maximum) { maximum = depth; at = p; }
          }
          if (at) push({ actorId: id, pair: boundedLabel(`${label}:${solid.id}/ground`), kind: 'equipment-ground', timeMs: options.timeMs ?? 0,
            depth: maximum, position: plain(at), approximation: 'capsule-proxy', intent: 'unknown' });
        }
      }
    }
    if (models.length > 16) { result.stats.truncated = true; partialBody = partialGround = true; }
    const reason = !hasEquipment ? 'No visible equipped geometry.' : missingEquipment ? 'Attached equipment is missing authored solid proxies.' : undefined;
    result.coverage.push({ actorId: id, check: 'equipment-body', status: !body.length ? 'unsupported' : missingEquipment || partialBody ? 'partial' : 'supported',
      reason: !body.length ? actor.reason ?? 'No authored body geometry.' : reason ?? (partialBody ? 'Some body/weapon proxies are hidden, degenerate or nonuniformly scaled.' : actor.reason) });
    result.coverage.push({ actorId: id, check: 'equipment-ground', status: !hasEquipment ? 'supported' : !sampleGround ? 'unsupported' : partialGround || missingEquipment ? 'partial' : 'supported',
      reason: reason ?? (!sampleGround ? 'No accepted terrain query is registered.' : partialGround ? 'Some ground samples or transforms are unsupported.' : 'Accepted terrain sampled against authored solid proxies.') });
  }
  if (!result.stats.actors) result.coverage.push({ check: 'geometry', status: 'unsupported', reason: 'No visible registered actor geometry; custom views need an inspection adapter.' });
  if (roots.length > 64 || result.stats.truncated) result.coverage.push({ check: 'geometry-budget', status: 'partial', reason: 'Inspection geometry work/output budget reached.' });
  return result;
  function push(overlap: InspectionGeometryOverlap): void {
    if (result.overlaps.length < 128) { result.overlaps.push(overlap); return; }
    result.stats.truncated = true;
    // Keep unclassified contacts discoverable when routine authored grip
    // contacts fill the frame budget. This ranks evidence, not design intent;
    // omitted allowed measurements still make coverage explicitly partial.
    if (overlap.intent !== 'allowed') {
      const allowed = result.overlaps.findIndex(value => value.intent === 'allowed');
      if (allowed >= 0) result.overlaps[allowed] = overlap;
    }
  }
}
function isDescendant(node: Object3D, root: Object3D): boolean { for (let n: Object3D | null = node.parent; n; n = n.parent) if (n === root) return true; return false; }
function equipmentLabel(model: Object3D, actor: Object3D): string {
  const names: string[] = [];
  for (let n: Object3D | null = model; n && n !== actor && names.length < 4; n = n.parent) if (n.name) names.unshift(n.name);
  return names.join('/') || 'equipment';
}
function boundedLabel(value: string): string {
  if (value.length <= 160) return value;
  let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `${value.slice(0, 150)}~${(hash >>> 0).toString(16)}`;
}
