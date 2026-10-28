import { Bone, Quaternion, Vector3, type Object3D } from 'three';
import { placeFoot, type FootPlacement, type LocomotionVector, type MovementFrame, type SupportStatus } from './locomotion.ts';
import type { CreatureRig } from './creatureRigs.ts';
import type { createCreatureSkeleton } from './creatureAnimationView.ts';

/** Explicit two-segment anatomy. `foot` may descend from `end`; its animated
 * offset/orientation is preserved. Detached source IK feet require an opt-in. */
export interface CreatureLeg {
  readonly id: string; readonly upper: string; readonly lower: string; readonly end: string;
  readonly foot?: string; readonly detachedEnd?: boolean;
  /** Contact point in the foot bone's local coordinates (for a paw sole/toe). */
  readonly contactOffset?: Readonly<LocomotionVector>;
}
export interface CreatureFootProfile {
  readonly rigId: string; readonly legs: readonly CreatureLeg[];
  readonly contactSource: 'authored-required'; readonly warnings: readonly string[];
}
export interface CreatureFootSupport {
  point: LocomotionVector; normal: LocomotionVector; observedAtMs: number; id?: string; grounded?: boolean;
}
export interface CreatureFootPlacementInput {
  timeMs: number; epoch?: string | number; frame: MovementFrame;
  supports: Readonly<Record<string, CreatureFootSupport | undefined>>;
  /** Authored stance weights, e.g. from a verified contact curve. Missing means 0.
   * These banks do not contain measured contact labels. Never lock every running foot. */
  contacts: Readonly<Record<string, number | undefined>>;
  grounded?: boolean; maxAdjustment?: number; maxAgeMs?: number; reset?: boolean;
}
export interface CreatureLegPlacement {
  id: string; target: LocomotionVector; position: LocomotionVector; error: number;
  support: SupportStatus; reachable: boolean; planted: boolean; warnings: string[];
}
export interface CreatureFootPlacementResult { legs: CreatureLegPlacement[]; reset: boolean; warnings: string[] }
type SkeletonView = ReturnType<typeof createCreatureSkeleton>;
type BoundLeg = { spec: CreatureLeg; upper: Bone; lower: Bone; end: Bone; foot: Bone };
const v = (p: LocomotionVector) => new Vector3(p.x, p.y, p.z);
const plain = (p: Vector3): LocomotionVector => ({ x: p.x, y: p.y, z: p.z });
const finite = (x: number, name: string, min = -1e12, max = 1e12) => {
  if (!Number.isFinite(x) || x < min || x > max) throw new Error(`Creature foot ${name} is out of bounds.`);
  return x;
};
function ancestor(parent: Object3D, node: Object3D): boolean {
  for (let p: Object3D | null = node; p; p = p.parent) if (p === parent) return true;
  return false;
}
function position(leg: BoundLeg): Vector3 {
  return v(leg.spec.contactOffset ?? { x: 0, y: 0, z: 0 }).applyMatrix4(leg.foot.matrixWorld);
}
function refreshWorldPath(node: Object3D): void {
  if (node.parent) refreshWorldPath(node.parent);
  // A matrix-driven socket still inherits a moved parent even when its local
  // matrix is clean. Force only this path, matching a full-tree propagated update.
  node.updateWorldMatrix(false, false, true);
}
const decomposedPosition = new Vector3(), decomposedScale = new Vector3(), decomposedRotation = new Quaternion();
function worldRotation(node: Object3D, rotation: Quaternion): Quaternion {
  node.matrixWorld.decompose(decomposedPosition, rotation, decomposedScale);
  return rotation;
}
function setWorldRotation(node: Bone, rotation: Quaternion): void {
  const parentRotation = node.parent ? worldRotation(node.parent, new Quaternion()) : new Quaternion();
  node.quaternion.copy(parentRotation.invert().multiply(rotation)).normalize();
  node.updateWorldMatrix(false, true);
}
function rotateWorldDirection(node: Bone, from: Vector3, to: Vector3): void {
  const delta = new Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
  setWorldRotation(node, delta.multiply(worldRotation(node, new Quaternion())));
}
function uniformScale(node: Object3D): boolean {
  node.matrixWorld.decompose(decomposedPosition, decomposedRotation, decomposedScale);
  const scale = decomposedScale;
  const size = Math.max(scale.x, scale.y, scale.z);
  return size > 1e-8 && Math.min(scale.x, scale.y, scale.z) > 0 &&
    // Exporters retain a few ulps of anisotropy (e.g. 1.000026 on M2M).
    // Tolerate that import noise, while rejecting intentional stretch/shear.
    Math.max(Math.abs(scale.x - scale.y), Math.abs(scale.x - scale.z)) <= size * 1e-4;
}

/** Reviewed anatomy mappings, not an automatic guess based on clip names.
 * Unsupported rigs return an empty profile; callers can supply their own legs. */
export function creatureFootProfile(bankOrRig: CreatureRig | { rig: CreatureRig }): CreatureFootProfile {
  const rig = 'rig' in bankOrRig ? bankOrRig.rig : bankOrRig;
  const legs: CreatureLeg[] = [];
  const id = rig.id.replace(/-v1$/, '');
  if (id === 'mesh2motion-fox' || id === 'mesh2motion-kaiju') {
    for (const part of id === 'mesh2motion-kaiju' ? ['Back'] : ['Front', 'Back']) for (const side of ['L', 'R']) {
      legs.push({ id: `${part.toLowerCase()}-${side.toLowerCase()}`, upper: `${part}_Leg_Upper_${side}`,
        lower: `${part}_Leg_Lower_${side}`, end: `${part}_Leg_Ankle_${side}`, foot: `${part}_Leg_Foot_${side}` });
    }
  } else if (id === 'mesh2motion-horse') {
    for (const part of ['front', 'back']) for (const side of ['l', 'r']) legs.push({ id: `${part}-${side}`,
      upper: `${part}_leg_upper_${side}`, lower: `${part}_leg_lower_${side}`, end: `${part}_leg_ankle_${side}`, foot: `${part}_leg_foot_${side}` });
  } else if (id === 'mesh2motion-bird') {
    for (const side of ['L', 'R']) legs.push({ id: `back-${side.toLowerCase()}`, upper: `UpperLeg_${side}`,
      lower: `LowerLeg_${side}`, end: `AnkleLeg_${side}`, foot: `Foot_${side}` });
  } else if (id === 'mesh2motion-dragon') {
    for (const part of ['front', 'back']) for (const side of ['l', 'r']) legs.push({ id: `${part}-${side}`,
      upper: `${part}_leg_${part === 'front' ? 'collar' : 'hip'}_${side}`, lower: `${part}_leg_${side}`,
      end: `${part}_ankle_${side}`, foot: `${part}_foot_${side}` });
  } else if (id === 'mesh2motion-spider') {
    for (const side of ['l', 'r']) for (const leg of ['a', 'b', 'c', 'd']) legs.push({ id: `${leg}-${side}`,
      upper: `leg_${leg}_1_${side}`, lower: `leg_${leg}_2_${side}`, end: `leg_${leg}_3_${side}`, foot: `leg_${leg}_tip_${side}` });
  } else if (/^quaternius-(alpaca|bull|cow|deer|donkey|fox|horse-white|horse|husky|shibainu|stag|wolf)$/.test(id)) {
    for (const part of ['Front', 'Back']) for (const side of ['L', 'R']) legs.push({ id: `${part.toLowerCase()}-${side.toLowerCase()}`,
      upper: `${part}UpperLeg${side}`, lower: `${part}LowerLeg${side}`, end: `FF${part === 'Back' ? 'B' : ''}${side}`, detachedEnd: true });
  }
  const byName = new Map(rig.joints.map(j => [j.name, j]));
  const valid = legs.filter(leg => byName.has(leg.upper) && byName.get(leg.lower)?.parent === leg.upper &&
    byName.has(leg.end) && (leg.detachedEnd || byName.get(leg.end)?.parent === leg.lower) && (!leg.foot || byName.has(leg.foot)));
  const warnings = valid.length === legs.length && valid.length ? [] : ['no-validated-foot-profile'];
  return Object.freeze({ rigId: rig.id, legs: Object.freeze(valid.map(leg => Object.freeze(leg))),
    contactSource: 'authored-required', warnings: Object.freeze(warnings) });
}

/** Terrain adaptation for source-authentic creature skeletons. Apply a fresh
 * animation pose FIRST each frame, query real world support at positions(), then
 * apply(). It rotates visual joints only, never the actor/gameplay root. Roots
 * may translate/rotate/uniformly scale; sheared/nonuniform limbs are skipped. */
export class CreatureFootPlacement {
  private readonly legs: BoundLeg[] = [];
  private readonly warnings: string[] = [];
  private readonly previous = new Map<string, FootPlacement>();
  private readonly previousOffsets = new Map<string, Vector3>();
  private previousTime?: number;
  private epoch?: string | number;
  constructor(skeleton: SkeletonView, profile: CreatureFootProfile) {
    if (profile.rigId !== skeleton.root.name) throw new Error('Creature foot profile rig does not match skeleton.');
    if (profile.legs.length > 8 || (profile.legs.length !== 0 && profile.legs.length < 2)) throw new Error('Creature foot profile needs 2..8 legs.');
    this.warnings.push(...profile.warnings);
    const ids = new Set<string>(), used = new Set<string>();
    for (const spec of profile.legs) {
      if (!/^[\w-]{1,64}$/.test(spec.id) || ids.has(spec.id)) throw new Error('Creature foot leg IDs must be unique and bounded.');
      ids.add(spec.id);
      if (spec.contactOffset) for (const axis of ['x', 'y', 'z'] as const) finite(spec.contactOffset[axis], 'contactOffset', -1e4, 1e4);
      const upper = skeleton.joints[spec.upper], lower = skeleton.joints[spec.lower], end = skeleton.joints[spec.end], foot = skeleton.joints[spec.foot ?? spec.end];
      if (!upper || !lower || !end || !foot || lower.parent !== upper ||
        (spec.detachedEnd ? ancestor(upper, end) || ancestor(end, upper) : end.parent !== lower) || !ancestor(end, foot) ||
        [spec.upper, spec.lower, spec.end].some(name => used.has(name))) {
        this.warnings.push(`unsupported-leg-chain:${spec.id}`); continue;
      }
      [spec.upper, spec.lower, spec.end].forEach(name => used.add(name));
      this.legs.push({ spec: { ...spec, ...(spec.contactOffset ? { contactOffset: { ...spec.contactOffset } } : {}) }, upper, lower, end, foot });
    }
  }
  reset(): void { this.previous.clear(); this.previousOffsets.clear(); this.previousTime = undefined; this.epoch = undefined; }
  positions(): Readonly<Record<string, LocomotionVector>> {
    // Query only the ancestor path for each contact. Updating the complete body
    // here also recomposed every face, weapon and armor mesh for each foot query.
    return Object.fromEntries(this.legs.map(leg => {
      refreshWorldPath(leg.foot);
      return [leg.spec.id, plain(position(leg))];
    }));
  }
  apply(input: CreatureFootPlacementInput): CreatureFootPlacementResult {
    finite(input.timeMs, 'timeMs');
    const maxAge = finite(input.maxAgeMs ?? 250, 'maxAgeMs', 0, 10000) / 1000;
    const maxAdjustment = finite(input.maxAdjustment ?? .35, 'maxAdjustment', 0, 1e4);
    if (input.epoch !== undefined && !((typeof input.epoch === 'string' && input.epoch.length <= 128) || (typeof input.epoch === 'number' && Number.isFinite(input.epoch))))
      throw new Error('Creature foot epoch must be a bounded string or finite number.');
    const reset = Boolean(input.reset || (this.previousTime !== undefined && (input.timeMs < this.previousTime || this.epoch !== input.epoch)));
    if (reset) { this.previous.clear(); this.previousOffsets.clear(); }
    this.previousTime = input.timeMs; this.epoch = input.epoch;
    const result: CreatureFootPlacementResult = { legs: [], reset, warnings: [...this.warnings] };
    for (const leg of this.legs) {
      // Refresh again: callers may change pose/root between positions() and
      // apply(). Detached source IK ends have a separate upper/lower branch.
      if (leg.spec.detachedEnd) refreshWorldPath(leg.lower);
      refreshWorldPath(leg.foot);
      const id = leg.spec.id, desired = position(leg), a = new Vector3().setFromMatrixPosition(leg.upper.matrixWorld);
      const b = new Vector3().setFromMatrixPosition(leg.lower.matrixWorld), c = new Vector3().setFromMatrixPosition(leg.end.matrixWorld);
      const upperLength = a.distanceTo(b), lowerLength = b.distanceTo(c);
      const source = input.supports[id], weight = finite(input.contacts[id] ?? 0, `contact ${id}`, 0, 1);
      const warnings: string[] = [];
      if (input.contacts[id] === undefined) warnings.push('missing-authored-contact');
      const worldOffset = desired.clone().sub(c);
      // placeFoot operates on the ankle's reach sphere; shift the support plane
      // by the animated paw offset so the actual sole reaches the real surface.
      const support = source ? { point: plain(v(source.point).sub(worldOffset)), normal: source.normal,
        observedAt: source.observedAtMs / 1000, id: source.id, grounded: input.grounded === false ? false : source.grounded } : undefined;
      if (upperLength < .001 || lowerLength < .001 || ![leg.upper, leg.lower, leg.end].every(uniformScale)) {
        this.previous.delete(id); this.previousOffsets.delete(id);
        result.legs.push({ id, position: plain(desired), target: plain(desired), error: 0, support: 'missing', reachable: false, planted: false,
          warnings: [...warnings, 'unsupported-limb-transform'] });
        continue;
      }
      const previous = this.previous.get(id), previousOffset = this.previousOffsets.get(id);
      // Keep the paw's contact point fixed when the animated ankle-to-paw
      // offset changes; a saved ankle anchor alone would visibly slide toes.
      const adjustedPrevious = previous?.anchor && previousOffset ? { ...previous, anchor: { ...previous.anchor,
        point: plain(v(previous.anchor.point).add(previousOffset).sub(worldOffset)) } } : previous;
      const placed = placeFoot({ time: input.timeMs / 1000, hip: plain(a), desired: plain(c), frame: input.frame,
        support, contactWeight: input.grounded === false ? 0 : weight, previous: adjustedPrevious,
        maxReach: upperLength + lowerLength, maxAdjustment, maxAge, reset });
      warnings.push(...placed.warnings);
      const target = v(placed.target), requestedDistance = a.distanceTo(target), minReach = Math.abs(upperLength - lowerLength) + 1e-7;
      const maxReach = upperLength + lowerLength - 1e-7;
      const canSolve = placed.support === 'current' && placed.reachable && weight > 0 && input.grounded !== false &&
        requestedDistance >= minReach && requestedDistance <= maxReach + 1e-6;
      if (canSolve && target.distanceToSquared(c) > 1e-16) {
        const endRotation = worldRotation(leg.end, new Quaternion());
        const direction = target.clone().sub(a).normalize();
        const oldDirection = c.clone().sub(a).normalize();
        const transport = new Quaternion().setFromUnitVectors(oldDirection, direction);
        let pole = b.clone().sub(a).addScaledVector(oldDirection, -b.clone().sub(a).dot(oldDirection)).applyQuaternion(transport);
        if (pole.lengthSq() < 1e-12) {
          pole = v(input.frame.forward).addScaledVector(direction, -v(input.frame.forward).dot(direction));
          if (pole.lengthSq() < 1e-12) pole = new Vector3(1, 0, 0).cross(direction);
          if (pole.lengthSq() < 1e-12) pole = new Vector3(0, 0, 1).cross(direction);
        }
        pole.normalize();
        const distance = Math.max(minReach, Math.min(maxReach, requestedDistance));
        const along = (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance);
        const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
        const knee = a.clone().addScaledVector(direction, along).addScaledVector(pole, height);
        rotateWorldDirection(leg.upper, b.clone().sub(a), knee.clone().sub(a));
        const movedKnee = new Vector3().setFromMatrixPosition(leg.lower.matrixWorld);
        // A detached IK end does not inherit upper rotations; rotate its virtual
        // lower segment by the upper's world delta before solving the knee.
        const lowerDirection = leg.spec.detachedEnd ? c.clone().sub(b).applyQuaternion(new Quaternion().setFromUnitVectors(b.clone().sub(a).normalize(), knee.clone().sub(a).normalize())) :
          new Vector3().setFromMatrixPosition(leg.end.matrixWorld).sub(movedKnee);
        rotateWorldDirection(leg.lower, lowerDirection, target.clone().sub(movedKnee));
        if (leg.spec.detachedEnd) {
          leg.end.position.copy(leg.end.parent ? leg.end.parent.worldToLocal(target.clone()) : target);
          leg.end.updateWorldMatrix(false, true);
        }
        setWorldRotation(leg.end, endRotation);
      }
      if (!canSolve) {
        delete placed.anchor;
        if (requestedDistance < minReach) warnings.push('support-inside-minimum-reach');
      }
      const actual = position(leg), footTarget = target.add(worldOffset);
      const error = actual.distanceTo(footTarget);
      const reached = canSolve && error < 1e-4;
      if (!reached) delete placed.anchor;
      this.previous.set(id, placed);
      this.previousOffsets.set(id, worldOffset);
      result.legs.push({ id, position: plain(actual), target: plain(footTarget), error, support: placed.support,
        reachable: reached, planted: Boolean(placed.anchor), warnings });
    }
    return result;
  }
}
