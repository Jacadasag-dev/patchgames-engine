import { Bone, Group, Skeleton } from 'three';
import { ThreeAnimationRig, type AnimationRigBinding } from './animationView.ts';
import { validateCreatureRig, type CreatureRig } from './creatureRigs.ts';

/** Build a bank's authentic rest skeleton for procedural parts or a compatible
 * weighted mesh. Attach its root beneath your authoritative actor. This helper
 * does not retarget arbitrary meshes, move gameplay actors, or infer contacts. */
export function createCreatureSkeleton(bankOrRig: CreatureRig | { rig: CreatureRig }, options: { scale?: number } = {}): {
  root: Group; joints: Readonly<Record<string, Bone>>; skeleton: Skeleton; animationRig: ThreeAnimationRig;
} {
  const rig = validateCreatureRig('rig' in bankOrRig ? bankOrRig.rig : bankOrRig);
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 100) throw new Error('Creature skeleton scale must be in (0, 100].');
  const root = new Group(); root.name = rig.id;
  const joints: Record<string, Bone> = Object.create(null);
  const bindings: Record<string, AnimationRigBinding> = Object.create(null);
  for (const reference of rig.joints) {
    const bone = new Bone(); bone.name = reference.name;
    bone.position.set(reference.position.x * scale, reference.position.y * scale, reference.position.z * scale);
    bone.quaternion.set(reference.rotation.x, reference.rotation.y, reference.rotation.z, reference.rotation.w);
    bone.scale.set(reference.scale.x, reference.scale.y, reference.scale.z);
    (reference.parent === null ? root : joints[reference.parent]).add(bone);
    joints[reference.name] = bone;
    bindings[reference.name] = { node: bone, translationScale: scale };
  }
  root.updateMatrixWorld(true);
  return { root, joints: Object.freeze(joints), skeleton: new Skeleton(Object.values(joints)),
    animationRig: new ThreeAnimationRig(bindings, { strict: true }) };
}
