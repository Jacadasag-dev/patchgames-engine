import { Bone, Group, Object3D, Quaternion, Skeleton, Vector3 } from 'three';
import { AnimationTransformBuffer, validateAnimationPose, type AnimationPose, type AnimationQuaternion, type AnimationJointTransform } from './animation.ts';
import { HUMANOID_JOINTS } from './humanoidRig.ts';
import { isInspectionObjectVisible, registerHumanoidInspection } from './inspectionGeometry.ts';
import { getEquipmentMotionDefinition } from './equipmentOrientation.ts';
import type { EquipmentMotionLoad } from './equipmentMotion.ts';

export interface AnimationRigBinding {
  node: Object3D;
  /** Clip translations are in reference-rig units. Scale for this rig explicitly. */
  translationScale?: number;
  /** Rotation from clip axes into this joint's rest-local axes. */
  basis?: AnimationQuaternion;
}
export interface AnimationRigReport { mapped: number; unmapped: string[] }
const markMatrixDirty = (node: Object3D) => { node.matrixWorldNeedsUpdate = true; };

/** Rest-relative animation for arbitrary Three.js nodes, including RigView joints.
 * Does not own geometry/materials or move an actor's authoritative world root.
 * Choose one pose owner per node; do not also call RigView.apply on these nodes. */
export class ThreeAnimationRig {
  private readonly options: { strict?: boolean };
  private readonly equipmentChains: { hand: Object3D; joints: string[] }[] = [];
  private readonly poseBuffer: AnimationTransformBuffer;
  private readonly positionScratch = new Vector3();
  private readonly rotationScratch = new Quaternion();
  private readonly scaleScratch = new Vector3();
  private readonly mappedNodes = new Set<Object3D>();
  private readonly bindings = new Map<string, {
    node: Object3D; position: Vector3; rotation: Quaternion; scale: Vector3;
    translationScale: number; basis: Quaternion; inverseBasis: Quaternion; inverseRest: Quaternion;
  }>();
  constructor(mapping: Readonly<Record<string, Object3D | AnimationRigBinding>>, options: { strict?: boolean } = {}) {
    this.options = options;
    validateAnimationPose(Object.fromEntries(Object.keys(mapping).map(name => [name, {}])));
    const nodes = new Set<Object3D>();
    for (const [name, value] of Object.entries(mapping)) {
      const binding = value instanceof Object3D ? { node: value } : value;
      if (!name || !binding || !(binding.node instanceof Object3D) || nodes.has(binding.node)) throw new Error('Animation rig requires unique named nodes.');
      const translationScale = binding.translationScale ?? 1;
      if (!Number.isFinite(translationScale) || translationScale <= 0 || translationScale > 1000) throw new Error('Invalid animation translation scale.');
      const basis = new Quaternion();
      if (binding.basis) {
        const q = validateAnimationPose({ basis: { rotation: binding.basis } }).basis.rotation!;
        basis.set(q.x, q.y, q.z, q.w);
      }
      const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
      if (binding.node.matrixAutoUpdate) {
        position.copy(binding.node.position); rotation.copy(binding.node.quaternion); scale.copy(binding.node.scale);
      } else binding.node.matrix.decompose(position, rotation, scale);
      if (![...position, ...rotation, ...scale].every(Number.isFinite) || rotation.lengthSq() < 1e-8 || Math.min(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) < 1e-8)
        throw new Error('Animation rig rest transform must be finite with nonzero scale.');
      rotation.normalize();
      this.bindings.set(name, { node: binding.node, position, rotation, scale, translationScale, basis,
        inverseBasis: basis.clone().invert(), inverseRest: rotation.clone().invert() });
      nodes.add(binding.node);
      this.mappedNodes.add(binding.node);
    }
    this.poseBuffer = new AnimationTransformBuffer([...this.bindings.keys()]);
    // Standard shared humanoids and legacy RigView bodies discover held loads
    // from the actual hand hierarchy. Other anatomy can supply equipmentLoads
    // on its ActorAnimationController without adopting humanoid joint names.
    for (const side of ['left', 'right']) for (const names of [
      [`${side}-clavicle`, `${side}-shoulder`, `${side}-elbow`, `${side}-hand`],
      [`${side}Shoulder`, `${side}Elbow`, `${side}Hand`],
    ]) {
      const hand = this.bindings.get(names.at(-1)!)?.node;
      if (!hand) continue;
      const ancestors = new Set<Object3D>();
      for (let node: Object3D | null = hand; node; node = node.parent) ancestors.add(node);
      const joints = names.filter(name => { const node = this.bindings.get(name)?.node; return node && ancestors.has(node); });
      this.equipmentChains.push({ hand, joints });
    }
    // Register metadata once. The normal inspection pass reads current posed
    // transforms automatically; gameplay does not run overlap checks.
    const mapped = Object.fromEntries([...this.bindings].map(([name, binding]) => [name, binding.node]));
    let common: Object3D | null = [...nodes][0] ?? null;
    while (common && ![...nodes].every(node => { for (let n: Object3D | null = node; n; n = n.parent) if (n === common) return true; return false; })) common = common.parent;
    if (common && nodes.has(common) && common.parent) common = common.parent;
    if (common) registerHumanoidInspection(common, mapped, this.bindings.get('hips')?.translationScale ?? 1);
  }
  /** Only equipped, currently attached items load their carrying arm. Semantic
   * parent groups count once, even when their geometry has several subparts.
   * First-person render masking does not unequip an item. Resting equipment on
   * a back/hip or armor on a torso is not a hand load. */
  equipmentLoads(): readonly EquipmentMotionLoad[] {
    const loads: EquipmentMotionLoad[] = [];
    for (const { hand, joints } of this.equipmentChains) {
      if (!isInspectionObjectVisible(hand, hand)) continue;
      const visit = (node: Object3D) => {
        if (!isInspectionObjectVisible(node, hand)) return;
        const item = getEquipmentMotionDefinition(node);
        if (item) { loads.push({ ...item, joints }); return; }
        for (const child of node.children) visit(child);
      };
      for (const child of hand.children) visit(child);
    }
    return loads;
  }
  apply(input: AnimationPose): AnimationRigReport {
    const report = this.poseBuffer.read(input), values = this.poseBuffer.values, channels = this.poseBuffer.channels;
    if (this.options.strict && report.unmapped.length) throw new Error(`Unmapped animation joints: ${report.unmapped.join(', ')}`);
    // Validate the complete pose before changing any scene nodes.
    let index = 0;
    for (const binding of this.bindings.values()) {
      const { node, position, rotation, scale, basis, inverseBasis, translationScale } = binding;
      const offset = index * 10, flags = channels[index++];
      node.position.copy(position); node.quaternion.copy(rotation); node.scale.copy(scale);
      if (flags & 1) node.position.add(this.positionScratch.set(values[offset], values[offset + 1], values[offset + 2]).applyQuaternion(basis).multiplyScalar(translationScale));
      if (flags & 2) node.quaternion.multiply(this.rotationScratch.set(values[offset + 3], values[offset + 4], values[offset + 5], values[offset + 6]).premultiply(basis).multiply(inverseBasis));
      if (flags & 4) { node.scale.x *= values[offset + 7]; node.scale.y *= values[offset + 8]; node.scale.z *= values[offset + 9]; }
      node.matrix.compose(node.position, node.quaternion, node.scale); node.matrixWorldNeedsUpdate = true;
    }
    // Mark matrix-driven sockets once per hierarchy instead of re-traversing
    // their entire subtree for each shoulder, elbow, hand and finger. Resolve
    // ancestry each time so reparented authored rigs retain correct behavior.
    for (const node of this.mappedNodes) {
      let parent = node.parent;
      while (parent && !this.mappedNodes.has(parent)) parent = parent.parent;
      if (!parent) node.traverse(markMatrixDirty);
    }
    return report;
  }
  /** Read reference-space deltas, useful for authoring a pose on a mapped rig. */
  capture(): AnimationPose {
    const pose: Record<string, AnimationJointTransform> = {};
    for (const [name, binding] of this.bindings) {
      const position = this.positionScratch, rotation = this.rotationScratch, scale = this.scaleScratch;
      if (binding.node.matrixAutoUpdate) {
        position.copy(binding.node.position); rotation.copy(binding.node.quaternion); scale.copy(binding.node.scale);
      } else binding.node.matrix.decompose(position, rotation, scale);
      position.sub(binding.position).multiplyScalar(1 / binding.translationScale).applyQuaternion(binding.inverseBasis);
      rotation.premultiply(binding.inverseRest).premultiply(binding.inverseBasis).multiply(binding.basis).normalize();
      scale.divide(binding.scale);
      pose[name] = { position: { x: position.x, y: position.y, z: position.z }, rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, scale: { x: scale.x, y: scale.y, z: scale.z } };
    }
    return pose;
  }
  reset(): void { this.apply({}); }
}

/** Build the shared humanoid's complete body hierarchy. Attach procedural parts
 * to joints, or bind a compatible weighted mesh to skeleton. The returned root
 * belongs under the game's authoritative actor; animations never move it.
 * Scale changes reference dimensions and animation translations together. */
export function createHumanoidSkeleton(options: { scale?: number } = {}): {
  root: Group; joints: Readonly<Record<string, Bone>>; skeleton: Skeleton; animationRig: ThreeAnimationRig;
} {
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 100) throw new Error('Humanoid skeleton scale must be in (0, 100].');
  const root = new Group(); root.name = 'humanoid';
  const joints: Record<string, Bone> = Object.create(null);
  const bindings: Record<string, AnimationRigBinding> = Object.create(null);
  for (const reference of HUMANOID_JOINTS) {
    const bone = new Bone(); bone.name = reference.name;
    bone.position.set(reference.position.x * scale, reference.position.y * scale, reference.position.z * scale);
    (reference.parent ? joints[reference.parent] : root).add(bone);
    joints[reference.name] = bone;
    bindings[reference.name] = { node: bone, translationScale: scale };
  }
  root.updateMatrixWorld(true);
  return { root, joints: Object.freeze(joints), skeleton: new Skeleton(Object.values(joints)), animationRig: new ThreeAnimationRig(bindings, { strict: true }) };
}
