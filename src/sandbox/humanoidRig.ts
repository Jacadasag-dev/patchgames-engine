import { multiplyAnimationQuaternions, type AnimationJointTransform, type AnimationPose, type AnimationQuaternion, type AnimationVector } from './animation.ts';

/** Presentation skeleton, in meters: +Y up, +Z forward, identity local rest
 * rotations. Source names describe the UEFN sample's anatomical correspondence;
 * importing its files still requires axis/rest-pose retargeting. */
export const HUMANOID_RIG_ID = 'humanoid-v1';
export interface HumanoidJoint {
  readonly name: string;
  readonly parent: string | null;
  readonly position: Readonly<AnimationVector>;
  readonly source: string;
}
const joint = (name: string, parent: string | null, x: number, y: number, z: number, source: string): HumanoidJoint =>
  Object.freeze({ name, parent, position: Object.freeze({ x, y, z }), source });

/** Five spine segments, two neck segments, clavicles and toes retain the
 * source's main body chains. Fingers, twist/deformation and IK helper bones are
 * optional model extensions, not prerequisites for sharing body animations. */
export const HUMANOID_JOINTS: readonly HumanoidJoint[] = Object.freeze([
  joint('hips', null, 0, .95, 0, 'pelvis'),
  joint('spine-1', 'hips', 0, .07, 0, 'spine_01'),
  joint('spine-2', 'spine-1', 0, .10, 0, 'spine_02'),
  joint('spine-3', 'spine-2', 0, .10, 0, 'spine_03'),
  joint('spine-4', 'spine-3', 0, .10, 0, 'spine_04'),
  joint('chest', 'spine-4', 0, .10, 0, 'spine_05'),
  joint('neck-1', 'chest', 0, .22, 0, 'neck_01'),
  joint('neck-2', 'neck-1', 0, .08, 0, 'neck_02'),
  joint('head', 'neck-2', 0, .10, 0, 'head'),
  joint('left-clavicle', 'chest', -.12, .13, 0, 'clavicle_l'),
  joint('left-shoulder', 'left-clavicle', -.28, 0, 0, 'upperarm_l'),
  joint('left-elbow', 'left-shoulder', 0, -.31, 0, 'lowerarm_l'),
  joint('left-hand', 'left-elbow', 0, -.29, 0, 'hand_l'),
  joint('right-clavicle', 'chest', .12, .13, 0, 'clavicle_r'),
  joint('right-shoulder', 'right-clavicle', .28, 0, 0, 'upperarm_r'),
  joint('right-elbow', 'right-shoulder', 0, -.31, 0, 'lowerarm_r'),
  joint('right-hand', 'right-elbow', 0, -.29, 0, 'hand_r'),
  joint('left-hip', 'hips', -.175, 0, 0, 'thigh_l'),
  joint('left-knee', 'left-hip', 0, -.41, 0, 'calf_l'),
  joint('left-foot', 'left-knee', 0, -.40, 0, 'foot_l'),
  joint('left-toe', 'left-foot', 0, -.035, .13, 'ball_l'),
  joint('right-hip', 'hips', .175, 0, 0, 'thigh_r'),
  joint('right-knee', 'right-hip', 0, -.41, 0, 'calf_r'),
  joint('right-foot', 'right-knee', 0, -.40, 0, 'foot_r'),
  joint('right-toe', 'right-foot', 0, -.035, .13, 'ball_r'),
]);

const identity: AnimationQuaternion = { x: 0, y: 0, z: 0, w: 1 };
const byName = new Map(HUMANOID_JOINTS.map(value => [value.name, value]));

/** Fold missing intermediate bones into a simpler anatomical rig, preserving
 * each retained joint's world rotation. Target joints must follow the nearest
 * retained ancestor and use this profile's rest axes (or explicit binding bases).
 * This is rotational chain reduction, not automatic creature/mesh retargeting.
 * Non-hip translations/scales on omitted bones cannot be represented and fail. */
export function adaptHumanoidPose(pose: AnimationPose, targetJoints: readonly string[]): AnimationPose {
  const targets = new Set(targetJoints);
  if (!targets.size || targets.size !== targetJoints.length || [...targets].some(name => !byName.has(name)))
    throw new Error('Humanoid adaptation requires unique joints from the humanoid profile.');
  const result: Record<string, AnimationJointTransform> = {};
  for (const name of targets) {
    const retained = pose[name];
    let rotation = retained?.rotation ?? identity;
    let parent = byName.get(name)!.parent;
    while (parent !== null && !targets.has(parent)) {
      const omitted = pose[parent];
      if (omitted?.position && Math.hypot(omitted.position.x, omitted.position.y, omitted.position.z) > 1e-8
        || omitted?.scale && Math.max(Math.abs(omitted.scale.x - 1), Math.abs(omitted.scale.y - 1), Math.abs(omitted.scale.z - 1)) > 1e-8)
        throw new Error(`Cannot fold translated/scaled humanoid joint ${parent}; retain that joint.`);
      rotation = multiplyAnimationQuaternions(omitted?.rotation ?? identity, rotation);
      parent = byName.get(parent)!.parent;
    }
    result[name] = { ...retained, rotation };
  }
  return result;
}
