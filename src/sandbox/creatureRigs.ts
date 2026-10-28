import { validateAnimationPose, type AnimationQuaternion, type AnimationVector } from './animation.ts';

/** Source-specific rest skeleton. A family describes anatomy, not an assertion
 * that different animals share joint names, bind axes, or proportions. */
export interface CreatureJoint {
  readonly name: string;
  readonly parent: string | null;
  readonly position: Readonly<AnimationVector>;
  readonly rotation: Readonly<AnimationQuaternion>;
  readonly scale: Readonly<AnimationVector>;
}
export interface CreatureRig { readonly id: string; readonly joints: readonly CreatureJoint[] }

/** Validate and detach a parent-first hierarchy before binding any scene nodes.
 * Rest transforms retain source axes and proportions; imported tracks are local
 * deltas against these exact transforms. Custom rigs remain fully supported. */
export function validateCreatureRig(input: CreatureRig): CreatureRig {
  if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,95}$/.test(input.id))
    throw new Error('Creature rig requires a valid ID.');
  if (!Array.isArray(input.joints) || input.joints.length < 1 || input.joints.length > 128)
    throw new Error('Creature rig requires 1..128 joints.');
  const names = new Set<string>();
  const joints = input.joints.map(joint => {
    if (!joint || names.has(joint.name) || (joint.parent !== null && !names.has(joint.parent)))
      throw new Error('Creature rig requires unique joints in parent-first order.');
    if (!joint.position || !joint.rotation || !joint.scale)
      throw new Error('Creature rig requires complete rest transforms.');
    const transform = validateAnimationPose({ [joint.name]: { position: joint.position, rotation: joint.rotation, scale: joint.scale } })[joint.name];
    if (Math.min(Math.abs(transform.scale!.x), Math.abs(transform.scale!.y), Math.abs(transform.scale!.z)) < 1e-8)
      throw new Error('Creature rig rest scale must be nonzero.');
    names.add(joint.name);
    return Object.freeze({ name: joint.name, parent: joint.parent, position: Object.freeze(transform.position!),
      rotation: Object.freeze(transform.rotation!), scale: Object.freeze(transform.scale!) });
  });
  return Object.freeze({ id: input.id, joints: Object.freeze(joints) });
}
