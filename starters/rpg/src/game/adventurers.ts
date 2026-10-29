import * as THREE from 'three';
import { classInfo } from './classes.ts';
import type { ActorPresentationSignals, AnimationAction, AnimationDiagnostics, AnimationPose } from '../sandbox/animation.ts';
import { ActorAnimationController, type ActorAnimationContext, type ActorLocomotionResult } from '../sandbox/actorAnimation.ts';
import { humanoidMotionTrajectory } from '../sandbox/actorLocomotion.ts';
import { MotionMatcher } from '../sandbox/motionMatching.ts';
import { ThreeAnimationRig } from '../sandbox/animationView.ts';
import { registerInspectionEquipment } from '../sandbox/inspectionGeometry.ts';
import { registerEquipmentOrientation } from '../sandbox/equipmentOrientation.ts';
import { HUMANOID_JOINTS } from '../sandbox/humanoidRig.ts';
import { attachEquipment, createBowModel, HumanoidHandPlacement, placeBowHands, socketWorld, type SocketFrame, type HandPlacementTarget, type HandPlacementResult } from '../sandbox/equipmentView.ts';
import { advanceGait, predictLocomotion, placeFoot, type LocomotionSupport, type LocomotionVector, type FootPlacement } from '../sandbox/locomotion.ts';
import { adventurerBowAction, adventurerClips, ADVENTURER_ATTACK_SECONDS, ADVENTURER_SKILL_SECONDS, ADVENTURER_STRIDE_LENGTH } from './adventurerMotions.ts';
import { adventurerMotion, adventurerMotionDatabase, adventurerMotionPhase, adventurerMotionSpeed, ADVENTURER_MOTION_RIG } from './adventurerMotionDatabase.ts';

export interface AdventurerPose {
  time: number;
  delta: number;
  speed: number;
  facing: number;
  downed: boolean;
  attackId: number;
  attackMs: number;
  skillId: number;
  skillMs: number;
  reviving: boolean;
  position?: LocomotionVector;
  velocity?: LocomotionVector;
  intendedVelocity?: LocomotionVector;
  support?: LocomotionSupport;
  reset?: boolean;
  /** The same identity/epoch and public signals exposed to appearance mods. */
  presentation?: ActorPresentationSignals;
}

type Limb = { joint: THREE.Group; bend: THREE.Group; end: THREE.Group };
const TAU = Math.PI * 2;
const X_AXIS = new THREE.Vector3(1, 0, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;
const PALM: SocketFrame = { position: { x: 0, y: -.025, z: 0 } };
// The themed blades/staves were authored along +Y; their declared grip forward
// makes that axis explicit rather than hiding a correction in model Euler angles.
const SHAFT_GRIP: SocketFrame = { rotation: new THREE.Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2) };

/** Reach a contact in 3D while keeping the animated knee's bend plane and ankle
 * orientation. This correction never replaces the mocap with a planar gait. */
function correctLegContact(leg: Limb, target: THREE.Vector3, forward: THREE.Vector3): void {
  const hip = leg.joint.getWorldPosition(new THREE.Vector3()), knee = leg.bend.getWorldPosition(new THREE.Vector3());
  const foot = leg.end.getWorldPosition(new THREE.Vector3()), footRotation = leg.end.getWorldQuaternion(new THREE.Quaternion());
  const upper = hip.distanceTo(knee), lower = knee.distanceTo(foot);
  const direction = target.clone().sub(hip), distance = clamp(direction.length(), Math.abs(upper - lower) + 1e-6, upper + lower - 1e-6);
  if (direction.lengthSq() < 1e-10) return;
  direction.normalize(); target = hip.clone().addScaledVector(direction, distance);
  const bend = knee.clone().sub(hip); bend.addScaledVector(direction, -bend.dot(direction));
  if (bend.lengthSq() < 1e-8) { bend.copy(forward); bend.addScaledVector(direction, -bend.dot(direction)); }
  if (bend.lengthSq() < 1e-8) { bend.set(1, 0, 0); bend.addScaledVector(direction, -bend.dot(direction)); }
  bend.normalize();
  const along = (upper * upper + distance * distance - lower * lower) / (2 * distance);
  const kneeTarget = hip.clone().addScaledVector(direction, along).addScaledVector(bend, Math.sqrt(Math.max(0, upper * upper - along * along)));
  const rotateWorld = (joint: THREE.Group, from: THREE.Vector3, to: THREE.Vector3) => {
    const correction = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    const world = joint.getWorldQuaternion(new THREE.Quaternion()).premultiply(correction);
    joint.quaternion.copy(joint.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
    joint.updateWorldMatrix(false, true);
  };
  rotateWorld(leg.joint, knee.clone().sub(hip), kneeTarget.clone().sub(hip));
  const correctedKnee = leg.bend.getWorldPosition(new THREE.Vector3());
  rotateWorld(leg.bend, leg.end.getWorldPosition(new THREE.Vector3()).sub(correctedKnee), target.clone().sub(correctedKnee));
  leg.end.quaternion.copy(leg.end.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(footRotation));
  leg.end.updateWorldMatrix(false, true);
}

/** Editable class geometry on the shared humanoid skeleton. Recorded body motion
 * is reusable across modes; equipment and campaign actions remain local layers. */
export class AdventurerVisual {
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private readonly classId: number;
  private readonly pelvis = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly joints = new Map<string, THREE.Group>();
  private readonly cape = new THREE.Group();
  private readonly leftArm: Limb;
  private readonly rightArm: Limb;
  private readonly leftLeg: Limb;
  private readonly rightLeg: Limb;
  private readonly leftWeapon = new THREE.Group();
  private readonly rightWeapon = new THREE.Group();
  private readonly gemMaterial: THREE.MeshStandardMaterial;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private bowModel: ReturnType<typeof createBowModel> | null = null;
  private readonly attachments: ReturnType<typeof attachEquipment>[] = [];
  private readonly handPlacement: HumanoidHandPlacement;
  private handDebug: HandPlacementResult = { hands: [], warnings: [] };
  private gait = { phase: 0, distance: 0 };
  private readonly animationRig: ThreeAnimationRig;
  private readonly animation: ActorAnimationController;
  private readonly matcher: MotionMatcher;
  private motionFrame: { input: AdventurerPose; time: number; delta: number; reset: boolean;
    movementFrame: { up: LocomotionVector; forward: LocomotionVector } } | null = null;
  private actorAnimationDebug: ReturnType<ActorAnimationController['sample']>['diagnostics'] | null = null;
  private presentationId: string | undefined;
  private presentationEpoch: string | number | undefined;
  private motionPose: AnimationPose = {};
  private motionDebug: ReturnType<MotionMatcher['sample']>['diagnostics'] | null = null;
  private matchedGaitPhase = 0;
  private motionPlaybackRate = 1;
  private motionContext = { time: 0, movement: 0, attackCount: 0 };
  private readonly feet: (FootPlacement | undefined)[] = [];
  private readonly contactWeights: number[] = [];
  private previousPosition: LocomotionVector | undefined;
  private footErrors: number[] = [];
  private animationDebug: AnimationDiagnostics | null = null;
  private locomotionDebug: ReturnType<typeof predictLocomotion> | null = null;
  private suppressed = false;
  private movement = 0;
  private collapse = 0;
  private kneeling = 0;
  private lastTime = -1;
  private lastAttackId = 0;
  private lastSkillId = 0;
  private attackStarted = -Infinity;
  private skillStarted = -Infinity;
  private attackCount = 0;
  private facing = Number.NaN;
  private disposed = false;

  constructor(classId: number) {
    this.classId = Number.isFinite(classId) ? clamp(Math.floor(classId), 0, 4) : 0;
    const role = classInfo(this.classId);
    this.root.name = `adventurer-${role.id}`;
    this.material = this.paint(role.color, { roughness: 0.76 });
    const steel = this.paint(0xa5bcc3, { metalness: 0.64, roughness: 0.36 });
    const darkSteel = this.paint(0x354a55, { metalness: 0.55, roughness: 0.43 });
    const gold = this.paint(0xdbb66d, { metalness: 0.6, roughness: 0.36 });
    const leather = this.paint([0x4f3f32, 0x594a37, 0x3b344d, 0x655346, 0x382e3c][this.classId]);
    const cloth = this.paint([0x3c5263, 0x294c3d, 0x49416c, 0xe0dbbf, 0x3e344c][this.classId]);
    const skin = this.paint([0xc58d68, 0xd7ad83, 0xb78166, 0x9c6950, 0xd9b69b][this.classId]);
    const hair = this.paint([0x4c3429, 0x462a24, 0xe1ddd2, 0x382c2d, 0x332535][this.classId]);
    const eye = this.paint(0x202b32), linen = this.paint(0xe9e4d2);
    this.gemMaterial = this.paint(role.color, { emissive: role.color, emissiveIntensity: 0.65, roughness: 0.22, metalness: 0.22 });

    for (const reference of HUMANOID_JOINTS) {
      const node = reference.name === 'hips' ? this.pelvis : reference.name === 'chest' ? this.chest
        : reference.name === 'head' ? this.head : new THREE.Group();
      node.name = reference.name; node.position.copy(reference.position);
      (reference.parent ? this.joints.get(reference.parent)! : this.root).add(node);
      this.joints.set(reference.name, node);
    }
    this.chest.add(this.torso); this.torso.position.y = -0.4; this.torso.name = 'torso-accessories';
    this.mesh(this.pelvis, new THREE.CylinderGeometry(0.29, 0.31, 0.22, 8), cloth, [0, 0.04, 0], [1, 1, 0.7]);
    // Separate overlapping torso sections follow the shared spine chain.
    for (const [name, height, width, y] of [['spine-1', .19, .30, .10], ['spine-2', .23, .34, .12], ['spine-4', .28, .39, .14]] as const) {
      const segment = this.joints.get(name)!;
      this.mesh(segment, new THREE.CylinderGeometry(width, width - .035, height, 6), this.classId === 0 ? darkSteel : cloth, [0, y, 0], [1, 1, .69]);
      this.box(segment, [.36, height, .045], [0, y, .225], this.material);
    }
    // The visible class color runs through the tabard, sleeves and cloak trim.
    this.mesh(this.torso, new THREE.CylinderGeometry(0.29, 0.3, 0.1, 8), leather, [0, 0.04, 0], [1.04, 1, 0.74]);
    this.box(this.torso, [0.15, 0.13, 0.055], [0, 0.04, 0.245], gold);
    this.box(this.torso, [0.075, 0.065, 0.065], [0, 0.04, 0.28], leather);
    this.box(this.pelvis, [0.14, 0.19, 0.16], [0.31, 0.02, 0], leather).rotation.z = -0.14;
    this.mesh(this.torso, new THREE.CylinderGeometry(0.14, 0.17, 0.12, 8), skin, [0, 0.64, 0]);
    this.mesh(this.head, new THREE.SphereGeometry(0.235, 10, 8), skin, [0, 0, 0], [0.9, 1.1, 0.93]);
    this.mesh(this.head, new THREE.SphereGeometry(0.052, 6, 4), skin, [-0.213, -0.015, 0]);
    this.mesh(this.head, new THREE.SphereGeometry(0.052, 6, 4), skin, [0.213, -0.015, 0]);
    this.mesh(this.head, new THREE.ConeGeometry(0.04, 0.085, 4), skin, [0, -0.015, 0.225]).rotation.x = Math.PI / 2;
    for (const side of [-1, 1]) {
      this.box(this.head, [0.065, 0.035, 0.024], [side * 0.09, 0.025, 0.198], linen);
      this.box(this.head, [0.027, 0.035, 0.028], [side * 0.082, 0.025, 0.212], eye);
      this.box(this.head, [0.08, 0.025, 0.025], [side * 0.092, 0.078, 0.195], hair).rotation.z = -side * 0.1;
    }
    this.box(this.head, [0.072, 0.018, 0.021], [0, -0.106, 0.203], leather);
    this.mesh(this.head, new THREE.SphereGeometry(0.246, 10, 5, 0, TAU, 0, Math.PI * 0.51), hair, [0, 0.028, -0.015], [0.95, 1, 1]);
    for (const side of [-1, 1]) this.box(this.head, [0.06, 0.16, 0.11], [side * 0.185, 0.04, 0.06], hair);

    this.leftLeg = this.leg(-1, cloth, leather, steel);
    this.rightLeg = this.leg(1, cloth, leather, steel);
    this.leftArm = this.arm(-1, skin, leather, steel);
    this.rightArm = this.arm(1, skin, leather, steel);
    this.leftArm.end.add(this.leftWeapon); this.leftWeapon.name = 'left-weapon';
    this.rightArm.end.add(this.rightWeapon); this.rightWeapon.name = 'right-weapon';
    this.chest.add(this.cape); this.cape.name = 'cloak'; this.cape.position.set(0, 0.18, -0.17);
    this.cloak(this.classId === 4 ? 0.55 : 0.78, this.classId === 3 ? linen : cloth, gold);

    if (this.classId === 0) {
      // Broad pauldrons, an open-faced helmet and a kite shield identify the frontline.
      for (const [side, arm] of [[-1, this.leftArm], [1, this.rightArm]] as const) {
        this.mesh(arm.joint, new THREE.SphereGeometry(0.225, 6, 4, 0, TAU, 0, Math.PI * 0.65), steel, [side * 0.03, -0.025, 0], [1.1, 0.8, 1]);
        this.box(arm.joint, [0.29, 0.06, 0.32], [side * 0.04, -0.03, 0], gold);
      }
      this.mesh(this.head, new THREE.SphereGeometry(0.274, 8, 5, 0, TAU, 0, Math.PI * 0.5), steel, [0, 0.045, -0.02], [0.93, 1, 1]);
      this.box(this.head, [0.075, 0.18, 0.045], [0, 0.08, 0.249], gold);
      for (const side of [-1, 1]) this.box(this.head, [0.07, 0.21, 0.16], [side * 0.217, -0.055, 0.06], steel);
      this.box(this.head, [0.08, 0.2, 0.34], [0, 0.29, -0.025], this.material);
      this.sword(this.rightWeapon, 0.8, steel, gold, leather);
      const shield = this.shield(steel, gold, darkSteel); this.leftWeapon.add(shield);
      registerEquipmentOrientation(this.leftWeapon, {
        id: 'guardian-shield', owner: this.root, grip: 'grip', weight: 'heavy',
        points: [
          { id: 'grip', tags: ['grip'], position: { x: 0, y: -.16, z: -.04 } },
          { id: 'center', tags: ['shield', 'center'], node: shield, position: { x: 0, y: 0, z: .03 } },
          { id: 'front', tags: ['blocking-face'], node: shield, position: { x: 0, y: 0, z: .1 } },
          { id: 'top', tags: ['top', 'rim'], node: shield, position: { x: 0, y: .44, z: .03 } },
        ],
        directions: [
          { id: 'blocking-face', tags: ['blocking-face'], from: 'center', to: 'front' },
          { id: 'up', tags: ['up'], from: 'center', to: 'top' },
        ],
      });
    } else if (this.classId === 1) {
      this.hood(cloth);
      this.box(this.torso, [0.09, 0.7, 0.055], [0.05, 0.29, 0.265], leather).rotation.z = -0.52;
      this.mesh(this.torso, new THREE.CylinderGeometry(0.11, 0.09, 0.65, 8, 1, true), leather, [0.23, 0.32, -0.31]).rotation.z = -0.25;
      for (let index = 0; index < 3; index++) {
        this.box(this.torso, [0.024, 0.36, 0.024], [0.24 + index * 0.045, 0.7 + (index % 2) * 0.045, -0.32], gold);
        this.box(this.torso, [0.08, 0.1, 0.018], [0.24 + index * 0.045, 0.86 + (index % 2) * 0.045, -0.32], linen);
      }
      this.bowModel = createBowModel({ color: 0x594a37, metalColor: 0xdbb66d });
      this.leftWeapon.add(this.bowModel.root);
    } else if (this.classId === 2) {
      this.mesh(this.head, new THREE.CylinderGeometry(0.37, 0.38, 0.045, 10), cloth, [0, 0.18, 0]);
      const hat = this.mesh(this.head, new THREE.ConeGeometry(0.28, 0.53, 8), this.material, [0, 0.45, -0.045]); hat.rotation.z = -0.15;
      this.mesh(this.head, new THREE.CylinderGeometry(0.23, 0.26, 0.075, 8), gold, [0.017, 0.25, -0.02]);
      this.box(this.torso, [0.12, 0.36, 0.065], [0, 0.39, 0.27], gold);
      this.mesh(this.torso, new THREE.OctahedronGeometry(0.09), this.gemMaterial, [0, 0.49, 0.31]);
      this.robe(cloth, gold);
      this.staff(this.rightWeapon, leather, gold, false);
    } else if (this.classId === 3) {
      this.mesh(this.head, new THREE.CylinderGeometry(0.234, 0.238, 0.055, 10, 1, true), gold, [0, 0.1, 0]);
      this.mesh(this.head, new THREE.OctahedronGeometry(0.072), this.gemMaterial, [0, 0.11, 0.242]);
      for (const side of [-1, 1]) this.box(this.torso, [0.12, 0.55, 0.06], [side * 0.15, 0.32, 0.265], gold);
      this.mesh(this.torso, new THREE.TorusGeometry(0.1, 0.026, 4, 10), gold, [0, 0.45, 0.27]);
      this.robe(linen, this.material);
      this.staff(this.rightWeapon, linen, gold, true);
      this.box(this.pelvis, [0.18, 0.25, 0.09], [-0.32, -0.02, 0.12], gold).rotation.z = -0.13;
      this.box(this.pelvis, [0.14, 0.21, 0.1], [-0.32, -0.02, 0.135], leather).rotation.z = -0.13;
    } else {
      this.hood(cloth);
      this.box(this.head, [0.31, 0.12, 0.045], [0, -0.09, 0.2], cloth);
      for (const side of [-1, 1]) this.box(this.torso, [0.085, 0.67, 0.055], [0, 0.29, 0.265], leather).rotation.z = side * 0.5;
      this.sword(this.leftWeapon, 0.4, steel, gold, leather);
      this.sword(this.rightWeapon, 0.4, steel, gold, leather);
    }
    if (this.classId !== 1) this.attachments.push(attachEquipment(this.rightArm.end, this.rightWeapon, SHAFT_GRIP, PALM));
    if (this.classId === 4) this.attachments.push(attachEquipment(this.leftArm.end, this.leftWeapon, SHAFT_GRIP, PALM));
    if (this.classId === 0) this.attachments.push(attachEquipment(this.leftArm.end, this.leftWeapon,
      { position: { x: 0, y: -.16, z: -.04 } }, PALM));
    if (this.bowModel) this.attachments.push(attachEquipment(this.leftArm.end, this.bowModel.root, this.bowModel.sockets.primaryGrip, PALM));
    this.handPlacement = new HumanoidHandPlacement({ root: this.root, joints: Object.fromEntries(this.joints) });
    this.animationRig = new ThreeAnimationRig({ ...Object.fromEntries(this.joints), cloak: this.cape }, { strict: true });
    this.matcher = new MotionMatcher(adventurerMotionDatabase(this.classId), { blendMs: 140, searchIntervalMs: 80, switchCooldownMs: 180, continuityBias: 0.04 });
    this.animation = new ActorAnimationController({
      clips: adventurerClips(this.classId, () => this.motionContext), rig: this.animationRig,
      locomotion: context => this.sampleMotion(context),
      afterApply: result => { this.placeFeet(); this.placeEquipment(result.diagnostics.animation); },
      onReset: () => {
        this.matcher.reset(); this.motionPose = {}; this.motionDebug = null;
        this.motionPlaybackRate = 1; this.matchedGaitPhase = 0;
        this.feet.length = 0; this.contactWeights.length = 0;
        this.handPlacement.reset(); this.handDebug = { hands: [], warnings: [] };
      },
    });
    this.update({ time: 0, delta: 0, speed: 0, facing: 0, downed: false, attackId: 0, attackMs: 0, skillId: 0, skillMs: 0, reviving: false });
  }

  private paint(color: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const value = new THREE.MeshStandardMaterial({ color, roughness: 0.86, flatShading: true, ...extra });
    this.materials.add(value); return value;
  }
  private mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number] = [0, 0, 0], scale?: [number, number, number]): THREE.Mesh {
    this.geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...position);
    if (scale) mesh.scale.set(...scale);
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  private box(parent: THREE.Object3D, dimensions: [number, number, number], position: [number, number, number], material: THREE.Material): THREE.Mesh {
    return this.mesh(parent, new THREE.BoxGeometry(...dimensions), material, position);
  }
  private arm(side: number, skin: THREE.Material, leather: THREE.Material, steel: THREE.Material): Limb {
    const name = side < 0 ? 'left' : 'right';
    const joint = this.joints.get(`${name}-shoulder`)!;
    this.mesh(joint, new THREE.CylinderGeometry(0.125, 0.095, 0.31, 7), this.material, [0, -0.15, 0]);
    const bend = this.joints.get(`${name}-elbow`)!;
    this.mesh(bend, new THREE.SphereGeometry(0.095, 7, 5), skin);
    this.mesh(bend, new THREE.CylinderGeometry(0.095, 0.078, 0.26, 7), this.classId === 0 ? steel : leather, [0, -0.13, 0]);
    const end = this.joints.get(`${name}-hand`)!;
    this.box(end, [0.13, 0.14, 0.14], [0, -0.025, 0], this.classId === 0 || this.classId === 4 ? leather : skin);
    return { joint, bend, end };
  }
  private leg(side: number, cloth: THREE.Material, leather: THREE.Material, steel: THREE.Material): Limb {
    const name = side < 0 ? 'left' : 'right';
    const joint = this.joints.get(`${name}-hip`)!;
    this.mesh(joint, new THREE.CylinderGeometry(0.135, 0.105, 0.41, 7), cloth, [0, -0.205, 0]);
    const bend = this.joints.get(`${name}-knee`)!;
    this.mesh(bend, new THREE.SphereGeometry(0.108, 7, 5), this.classId === 0 ? steel : leather);
    this.mesh(bend, new THREE.CylinderGeometry(0.105, 0.085, 0.3, 7), leather, [0, -0.15, 0]);
    const end = this.joints.get(`${name}-foot`)!;
    this.box(end, [0.21, 0.21, 0.20], [0, -0.035, 0], leather);
    this.box(end, [0.218, 0.045, 0.20], [0, -0.12, 0], this.classId === 0 ? steel : leather);
    const toe = this.joints.get(`${name}-toe`)!;
    this.box(toe, [0.21, 0.21, 0.145], [0, 0, 0.04], leather);
    this.box(toe, [0.218, 0.045, 0.15], [0, -0.085, 0.04], this.classId === 0 ? steel : leather);
    this.box(bend, [0.215, 0.055, 0.21], [0, -0.09, 0], this.material);
    return { joint, bend, end };
  }
  private cloak(length: number, cloth: THREE.Material, trim: THREE.Material): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.28, 0, 0, 0, 0.03, -0.08, 0.28, 0, 0,
      -0.36, -length * 0.5, -0.08, 0, -length * 0.5, -0.2, 0.36, -length * 0.5, -0.08,
      -0.4, -length, -0.16, 0, -length * 1.03, -0.26, 0.4, -length, -0.16,
    ], 3));
    geometry.setIndex([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5, 3, 6, 4, 4, 6, 7, 4, 7, 5, 5, 7, 8]);
    geometry.computeVertexNormals();
    const material = cloth.clone(); material.side = THREE.DoubleSide; this.materials.add(material);
    this.mesh(this.cape, geometry, material);
    for (const side of [-1, 1]) this.mesh(this.torso, new THREE.SphereGeometry(0.055, 6, 4), trim, [side * 0.26, 0.57, 0.18]);
  }
  private hood(cloth: THREE.Material): void {
    this.mesh(this.head, new THREE.SphereGeometry(0.29, 10, 8, Math.PI, Math.PI), cloth, [0, 0.015, 0], [1, 1.1, 1]);
    this.mesh(this.head, new THREE.TorusGeometry(0.245, 0.065, 5, 10), this.material, [0, 0.01, 0.045], [1, 1.12, 1]);
  }
  private robe(cloth: THREE.Material, trim: THREE.Material): void {
    // Split panels leave both knees visible and move with the thighs.
    for (const [side, limb] of [[-1, this.leftLeg], [1, this.rightLeg]] as const) {
      this.box(limb.joint, [0.285, 0.46, 0.035], [side * 0.012, -0.17, 0.135], cloth);
      this.box(limb.joint, [0.045, 0.46, 0.045], [side * 0.13, -0.17, 0.15], trim);
    }
  }
  private sword(parent: THREE.Group, length: number, steel: THREE.Material, gold: THREE.Material, leather: THREE.Material): void {
    registerEquipmentOrientation(parent, {
      id: `${parent.name}-${length > .5 ? 'sword' : 'dagger'}`, owner: this.root, grip: 'grip', weight: length > .5 ? 'heavy' : 'medium',
      points: [
        { id: 'grip', tags: ['grip'], position: { x: 0, y: 0, z: 0 } },
        { id: 'tip', tags: ['tip', 'piercing'], position: { x: 0, y: length + .23, z: 0 } },
        { id: 'blade-center', tags: ['blade'], position: { x: 0, y: .17, z: 0 } },
        { id: 'edge-left', tags: ['sharp-edge'], position: { x: -.075, y: .17, z: 0 } },
        { id: 'edge-right', tags: ['sharp-edge'], position: { x: .075, y: .17, z: 0 } },
        { id: 'face-front', tags: ['flat-face'], position: { x: 0, y: .17, z: .038 } },
        { id: 'face-back', tags: ['flat-face'], position: { x: 0, y: .17, z: -.038 } },
      ],
      directions: [
        { id: 'tip', tags: ['tip', 'piercing'], from: 'grip', to: 'tip' },
        ...['edge-left', 'edge-right'].map(id => ({ id, tags: ['sharp-edge'], from: 'blade-center', to: id, motionPoint: 'tip' })),
        ...['face-front', 'face-back'].map(id => ({ id, tags: ['flat-face'], from: 'blade-center', to: id, motionPoint: 'tip' })),
      ],
    });
    registerInspectionEquipment(parent, [
      { id: 'grip', node: parent, a: { x: 0, y: -.1, z: 0 }, b: { x: 0, y: .1, z: 0 }, radius: .04, allowedBodyParts: ['left-hand', 'right-hand'] },
      { id: 'blade', node: parent, a: { x: 0, y: .19, z: 0 }, b: { x: 0, y: length + .20, z: 0 }, radius: .03 },
      { id: 'guard', node: parent, a: { x: length > .5 ? -.14 : -.09, y: .13, z: 0 }, b: { x: length > .5 ? .14 : .09, y: .13, z: 0 }, radius: .03 },
    ]);
    this.mesh(parent, new THREE.CylinderGeometry(0.04, 0.04, 0.22, 6), leather);
    this.mesh(parent, new THREE.SphereGeometry(0.065, 6, 4), gold, [0, -0.14, 0]);
    this.box(parent, [length > 0.5 ? 0.34 : 0.24, 0.065, 0.095], [0, 0.13, 0], gold);
    const blade = new THREE.BufferGeometry();
    blade.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.075, 0.17, 0, 0, 0.17, 0.038, 0.075, 0.17, 0, 0, 0.17, -0.038,
      -0.055, length + 0.05, 0, 0, length + 0.05, 0.03, 0.055, length + 0.05, 0, 0, length + 0.05, -0.03,
      0, length + 0.23, 0,
    ], 3));
    blade.setIndex([0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3, 3, 6, 7, 3, 7, 0, 0, 7, 4, 4, 8, 5, 5, 8, 6, 6, 8, 7, 7, 8, 4]);
    blade.computeVertexNormals(); this.mesh(parent, blade, steel);
  }
  private shield(steel: THREE.Material, gold: THREE.Material, backing: THREE.Material): THREE.Group {
    const root = new THREE.Group(), shape = new THREE.Shape();
    registerInspectionEquipment(root, [
      { id: 'center', node: root, a: { x: 0, y: -.40, z: .03 }, b: { x: 0, y: .40, z: .03 }, radius: .03, allowedBodyParts: ['left-hand', 'left-forearm'] },
      { id: 'left', node: root, a: { x: -.20, y: -.1, z: .03 }, b: { x: -.20, y: .32, z: .03 }, radius: .03 },
      { id: 'right', node: root, a: { x: .20, y: -.1, z: .03 }, b: { x: .20, y: .32, z: .03 }, radius: .03 },
    ]);
    shape.moveTo(-0.29, 0.35); shape.lineTo(0, 0.44); shape.lineTo(0.29, 0.35); shape.lineTo(0.26, -0.12); shape.lineTo(0, -0.43); shape.lineTo(-0.26, -0.12); shape.closePath();
    this.mesh(root, new THREE.ExtrudeGeometry(shape, { depth: 0.065, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.025, bevelThickness: 0.025 }), backing);
    this.box(root, [0.045, 0.66, 0.065], [0, 0.02, 0.085], gold);
    this.box(root, [0.46, 0.045, 0.065], [0, 0.17, 0.085], gold);
    this.mesh(root, new THREE.SphereGeometry(0.11, 8, 5), steel, [0, 0.07, 0.1], [1, 1, 0.4]);
    return root;
  }
  private staff(parent: THREE.Group, wood: THREE.Material, gold: THREE.Material, cleric: boolean): void {
    registerEquipmentOrientation(parent, {
      id: cleric ? 'cleric-staff' : 'mage-staff', owner: this.root, grip: 'grip', weight: 'heavy',
      points: [
        { id: 'grip', tags: ['grip'], position: { x: 0, y: 0, z: 0 } },
        { id: 'crown', tags: ['tip', 'magic-emitter'], position: { x: 0, y: 1.05, z: 0 } },
        { id: 'front', tags: ['front'], position: { x: 0, y: 1.05, z: .055 } },
        { id: 'base', tags: ['butt'], position: { x: 0, y: -.605, z: 0 } },
      ],
      directions: [
        { id: 'shaft', tags: ['shaft', 'magic-emitter'], from: 'grip', to: 'crown' },
        { id: 'front', tags: ['front'], from: 'crown', to: 'front' },
      ],
    });
    registerInspectionEquipment(parent, [
      { id: 'grip', node: parent, a: { x: 0, y: -.10, z: 0 }, b: { x: 0, y: .10, z: 0 }, radius: .04, allowedBodyParts: ['left-hand', 'right-hand'] },
      { id: 'shaft-lower', node: parent, a: { x: 0, y: -.59, z: 0 }, b: { x: 0, y: -.13, z: 0 }, radius: .04 },
      { id: 'shaft-upper', node: parent, a: { x: 0, y: .13, z: 0 }, b: { x: 0, y: .99, z: 0 }, radius: .04 },
      { id: 'crown', node: parent, a: { x: 0, y: .99, z: 0 }, b: { x: 0, y: 1.15, z: 0 }, radius: .09 },
    ]);
    this.mesh(parent, new THREE.CylinderGeometry(0.038, 0.045, 1.65, 7), wood, [0, 0.22, 0]);
    for (const y of [-0.55, 0.64, 0.82]) this.mesh(parent, new THREE.CylinderGeometry(0.065, 0.065, 0.09, 7), gold, [0, y, 0]);
    if (cleric) {
      this.mesh(parent, new THREE.TorusGeometry(0.19, 0.035, 5, 12), gold, [0, 1.04, 0]);
      this.box(parent, [0.07, 0.53, 0.06], [0, 1.04, 0], gold);
      this.box(parent, [0.46, 0.07, 0.06], [0, 1.04, 0], gold);
      this.mesh(parent, new THREE.OctahedronGeometry(0.11), this.gemMaterial, [0, 1.04, 0.055]);
    } else {
      this.mesh(parent, new THREE.OctahedronGeometry(0.19), this.gemMaterial, [0, 1.05, 0], [0.8, 1.4, 0.8]);
      for (const side of [-1, 1]) this.box(parent, [0.055, 0.3, 0.08], [side * 0.14, 0.96, 0], gold).rotation.z = side * 0.28;
    }
  }

  update(pose: AdventurerPose): void {
    if (this.disposed) return;
    if (pose.presentation?.id) this.root.userData.inspectionActorId = pose.presentation.id;
    const time = Math.max(0, Number.isFinite(pose.time) ? pose.time : this.lastTime);
    const delta = Number.isFinite(pose.delta) ? clamp(pose.delta, 0, 0.1) : 0;
    const attackId = Number.isFinite(pose.attackId) ? pose.attackId : 0;
    const skillId = Number.isFinite(pose.skillId) ? pose.skillId : 0;
    const suppressed = pose.downed || pose.reviving;
    const presentationChanged = this.presentationId !== undefined &&
      (pose.presentation?.id !== this.presentationId || pose.presentation?.epoch !== this.presentationEpoch);
    const reset = !!pose.reset || presentationChanged || time < this.lastTime || attackId < this.lastAttackId || skillId < this.lastSkillId;
    this.presentationId = pose.presentation?.id; this.presentationEpoch = pose.presentation?.epoch;
    if (reset || suppressed && !this.suppressed) {
      this.animation.reset(); this.attackStarted = this.skillStarted = -Infinity; this.feet.length = 0;
      this.contactWeights.length = 0;
      this.motionPose = {}; this.motionDebug = null;
      this.motionPlaybackRate = 1;
      if (reset) { this.attackCount = 0; this.gait = { phase: 0, distance: 0 }; }
    }
    if (!reset && !suppressed && attackId > this.lastAttackId && pose.attackMs > 0) {
      this.attackStarted = time - Math.max(0, (180 - pose.attackMs) / 1000); this.attackCount++;
    }
    if (!reset && !suppressed && skillId > this.lastSkillId && pose.skillMs > 0)
      this.skillStarted = time - Math.max(0, ADVENTURER_SKILL_SECONDS[this.classId] - pose.skillMs / 1000);
    this.lastTime = time; this.lastAttackId = attackId; this.lastSkillId = skillId; this.suppressed = suppressed;
    const speed = Number.isFinite(pose.speed) ? clamp(pose.speed, 0, 16) : 0;
    this.movement = mix(this.movement, suppressed ? 0 : clamp(speed / 4.6), 1 - Math.exp(-delta * 12));
    this.collapse = mix(this.collapse, pose.downed ? 1 : 0, 1 - Math.exp(-delta * 10));
    this.kneeling = mix(this.kneeling, pose.reviving && !pose.downed ? 1 : 0, 1 - Math.exp(-delta * 12));
    const traveled = pose.position && this.previousPosition ? Math.hypot(pose.position.x - this.previousPosition.x, pose.position.z - this.previousPosition.z) : undefined;
    this.previousPosition = pose.position ? { ...pose.position } : undefined;
    this.gait = advanceGait(this.gait, { distance: suppressed || reset ? 0 : traveled ?? speed * delta,
      strideLength: Math.max(0.4, ADVENTURER_STRIDE_LENGTH * this.movement) });
    const facing = Number.isFinite(pose.facing) ? pose.facing : 0;
    if (!Number.isFinite(this.facing) || reset || delta === 0) this.facing = facing;
    else this.facing += Math.atan2(Math.sin(facing - this.facing), Math.cos(facing - this.facing)) * (1 - Math.exp(-delta * 20));
    this.root.rotation.set(0, this.facing, 0); this.root.position.set(0, 0, 0);
    this.motionContext = { time, movement: this.movement, attackCount: this.attackCount };
    const movementFrame = { up: { x: 0, y: 1, z: 0 }, forward: { x: Math.sin(this.facing), y: 0, z: Math.cos(this.facing) } };
    // Simulation snapshots can repeat between render frames. Their velocity is
    // still moving: deriving playback from each position difference would pause
    // every other frame at 60Hz (or three in four at 120Hz) with 30Hz simulation.
    const observedSpeed = suppressed || reset ? 0 : pose.velocity ? clamp(Math.hypot(pose.velocity.x, pose.velocity.z), 0, 16)
      : traveled !== undefined && delta > 0 ? clamp(traveled / delta, 0, 16) : speed;
    const origin = pose.position ?? { x: 0, y: 0, z: 0 };
    this.locomotionDebug = predictLocomotion({ time, position: origin,
      velocity: suppressed ? { x: 0, y: 0, z: 0 } : pose.velocity ?? { x: Math.sin(facing) * observedSpeed, y: 0, z: Math.cos(facing) * observedSpeed }, frame: movementFrame,
      intent: pose.intendedVelocity ? { velocity: suppressed ? { x: 0, y: 0, z: 0 } : pose.intendedVelocity, observedAt: time } : undefined,
      support: pose.support, samples: 3, horizon: 0.6 });
    const actions: AnimationAction[] = [];
    if (!suppressed && Number.isFinite(this.attackStarted)) actions.push({ id: `attack:${attackId}`, clip: 'attack',
      startedAtMs: this.attackStarted * 1000, channel: 'upper-body', priority: 10, fadeInMs: 45, fadeOutMs: 90 });
    if (!suppressed && Number.isFinite(this.skillStarted)) actions.push({ id: `skill:${skillId}`, clip: 'skill',
      startedAtMs: this.skillStarted * 1000, channel: 'upper-body', priority: 20, fadeInMs: 90, fadeOutMs: 250 });
    this.motionFrame = { input: pose, time, delta, reset, movementFrame };
    const signals: ActorPresentationSignals = {
      ...pose.presentation, id: pose.presentation?.id ?? `adventurer-${this.classId}`, timeMs: time * 1000, position: origin,
      velocity: suppressed ? { x: 0, y: 0, z: 0 } : pose.velocity ?? { x: Math.sin(facing) * observedSpeed, y: 0, z: Math.cos(facing) * observedSpeed },
      intendedVelocity: suppressed ? { x: 0, y: 0, z: 0 } : pose.intendedVelocity,
      facing: movementFrame.forward, up: movementFrame.up, grounded: pose.support?.grounded,
      posture: pose.downed ? 'downed' : pose.reviving ? 'reviving' : observedSpeed > .1 ? 'moving' : 'idle',
      parameters: { ...pose.presentation?.parameters, movement: this.movement, attackCount: this.attackCount, observedSpeed },
      actions,
      supports: pose.support ? { ground: { position: pose.support.point, normal: pose.support.normal,
        observedAtMs: pose.support.observedAt * 1000 } } : undefined,
      trajectory: this.locomotionDebug.samples.map(sample => {
        const length = Math.hypot(sample.velocity.x, sample.velocity.z);
        const direction = length > 0.05 ? { x: sample.velocity.x / length, y: 0, z: sample.velocity.z / length } : movementFrame.forward;
        return { afterMs: Math.round(sample.time * 1000), position: sample.position, facing: direction };
      }),
    };
    const result = this.animation.sample({ signals, deltaMs: delta * 1000, reset, layers: [
      { id: 'equipment', clip: 'equipment', mode: 'additive' },
      { id: 'breath', clip: 'breathing', mode: 'additive' },
      { id: 'reviving', clip: 'revive', weight: this.kneeling },
      { id: 'downed', clip: 'downed', weight: this.collapse },
    ] });
    this.actorAnimationDebug = result.diagnostics; this.animationDebug = result.diagnostics.animation;

    const attack = (time - this.attackStarted) / ADVENTURER_ATTACK_SECONDS[this.classId];
    const activeAttack = !suppressed && this.animationDebug.actions.some(action => action.clip === 'attack' && action.status === 'active');
    const activeSkill = !suppressed && this.animationDebug.actions.find(action => action.clip === 'skill' && action.status === 'active');
    this.gemMaterial.emissiveIntensity = 0.55 + (Math.sin(time * 3) + 1) * 0.1
      + (activeAttack && this.classId > 1 ? Math.sin(clamp(attack) * Math.PI) * 1.3 : 0) + (activeSkill ? activeSkill.weight * 1.4 : 0);

  }

  /** The shared controller owns sampling and composition; this driver keeps the
   * campaign's recorded gait selection and contact tuning replaceable. */
  private sampleMotion(context: Readonly<ActorAnimationContext>): ActorLocomotionResult {
    const { signals } = context;
    const { time, delta, reset, input } = this.motionFrame!;
    const suppressed = input.downed || input.reviving;
    const observedSpeed = Number(signals.parameters?.observedSpeed ?? 0);
    const sourceSpeed = this.motionDebug?.selectedClip ? adventurerMotionSpeed(this.motionDebug.selectedClip, this.motionDebug.selectedTimeMs ?? 0) : 0;
    const currentMotion = this.motionDebug?.selectedClip ? adventurerMotion(this.motionDebug.selectedClip) : undefined;
    const transient = currentMotion && !currentMotion.clip.loop;
    // Releasing movement changes the requested trajectory, not the animation
    // clock. Keep the outgoing gait alive while the matcher finds a stop, and
    // ease speed changes rather than freezing its pose before the blend starts.
    const requestedRate = transient || sourceSpeed < 0.1 ? 1 : clamp(observedSpeed / sourceSpeed, 0.65, 3);
    this.motionPlaybackRate = delta > 0 ? mix(this.motionPlaybackRate, requestedRate, 1 - Math.exp(-delta * 16)) : requestedRate;
    const resetMotion = reset || suppressed || context.reset;
    // Query the continued rendered pose at this frame's clock. A previous
    // render pose trails playback and can make the search repeatedly seek back
    // to an earlier phase, especially at 30Hz. The shared helper also samples
    // centered derivatives through active transitions without advancing state.
    const continuation = this.matcher.continuation({ timeMs: time * 1000, reset: resetMotion, playbackRate: this.motionPlaybackRate });
    const matched = this.matcher.sample({ timeMs: time * 1000, reset: resetMotion,
      playbackRate: this.motionPlaybackRate,
      query: { rig: ADVENTURER_MOTION_RIG, requiredTags: ['grounded'], pose: this.motionPose, ...continuation,
        contacts: { 'left-foot': this.contactWeights[0] ?? 1, 'right-foot': this.contactWeights[1] ?? 1 },
        trajectory: humanoidMotionTrajectory(signals) } });
    this.motionPose = matched.pose; this.motionDebug = matched.diagnostics;
    this.matchedGaitPhase = matched.diagnostics.selectedClip ? adventurerMotionPhase(matched.diagnostics.selectedClip, matched.diagnostics.selectedTimeMs ?? 0) : 0;
    const selectedMotion = matched.diagnostics.selectedClip ? adventurerMotion(matched.diagnostics.selectedClip) : undefined;
    const sourceContacts = selectedMotion?.contacts(matched.diagnostics.selectedTimeMs ?? 0);
    for (const [index, name] of ['left-foot', 'right-foot'].entries()) {
      const requested = sourceContacts?.[name] ?? 0, previous = this.contactWeights[index] ?? requested;
      // Contact timing belongs to the animation even when a support sample is
      // unavailable. Smooth it with the same transition as the displayed pose.
      this.contactWeights[index] = mix(previous, requested, (1 - Math.exp(-delta * 18)) * matched.diagnostics.transitionWeight);
    }
    return { pose: matched.pose,
      contacts: { 'left-foot': this.contactWeights[0], 'right-foot': this.contactWeights[1] },
      diagnostics: { source: matched.diagnostics.selectedClip, sourceTimeMs: matched.diagnostics.selectedTimeMs,
        ...(selectedMotion ? { sourceDurationMs: selectedMotion.clip.durationMs, loop: !!selectedMotion.clip.loop,
          idle: selectedMotion.tags.includes('idle'), holdsEnd: selectedMotion.endBehavior === 'hold' } : {}),
        phase: this.matchedGaitPhase, playbackRate: this.motionPlaybackRate, state: signals.posture,
        switched: matched.diagnostics.switched, warnings: matched.diagnostics.warnings } };
  }

  /** Constrain actual wrist/arm bones after the composed pose. Equipment itself
   * keeps its declared grip transform throughout locomotion, attacks and resets. */
  private placeEquipment(animation: AnimationDiagnostics): void {
    const { time, input } = this.motionFrame!;
    this.root.updateWorldMatrix(true, true);
    const orientation = this.root.getWorldQuaternion(new THREE.Quaternion());
    const worldPoint = (x: number, y: number, z: number) => this.root.localToWorld(new THREE.Vector3(x, y, z));
    const turned = (axis: THREE.Vector3, angle: number) => orientation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    const target = (hand: Limb, rotation: THREE.Quaternion, position?: THREE.Vector3, weight = 1): HandPlacementTarget => ({
      position: position ?? socketWorld(hand.end, PALM).position, rotation, socket: PALM, weight,
      pole: hand.bend.getWorldPosition(new THREE.Vector3()),
    });
    const attack = animation.actions.find(action => action.clip === 'attack' && action.status === 'active');
    const skill = animation.actions.find(action => action.clip === 'skill' && action.status === 'active');
    const progress = (time - this.attackStarted) / ADVENTURER_ATTACK_SECONDS[this.classId];
    const suppressed = input.downed || input.reviving;
    const targets: Record<string, HandPlacementTarget | undefined> = {};
    if (this.classId === 0) {
      // Shield face follows the actual palm; downing lays it flat beside the arm.
      targets.left = target(this.leftArm, turned(X_AXIS, mix(skill ? -.1 : .15, Math.PI / 2, this.collapse)));
      if (attack && !suppressed) {
        const wind = clamp(progress / .25), cut = clamp((progress - .25) / .24), recovery = clamp((progress - .52) / .48);
        const lift = wind * (1 - cut), strength = attack.weight * (1 - recovery);
        targets.right = { ...target(this.rightArm, turned(X_AXIS, -.95 * lift + .55 * cut),
          worldPoint(.25, 1.3 + .5 * lift, .16 + .26 * cut), strength), pole: worldPoint(.8, 1.3, .05) };
      } else if (this.collapse > .01) targets.right = target(this.rightArm, orientation, undefined, this.collapse);
    } else if (this.classId === 2 || this.classId === 3) {
      const cast = attack && !suppressed ? Math.sin(clamp(progress / .75) * Math.PI) * .35 : 0;
      // Shaft +Y is expressed in the grip frame. Rotating the wrist moves the
      // real staff and hand together, including its horizontal downed carry.
      targets.right = target(this.rightArm, turned(X_AXIS, -Math.PI / 2 + mix(-cast, Math.PI / 2, this.collapse)));
    } else if (this.classId === 4 && attack && !suppressed) {
      const side = this.attackCount % 2 ? 1 : -1, hand = side > 0 ? this.rightArm : this.leftArm;
      const cut = clamp((progress - .25) / .24), recovery = clamp((progress - .52) / .48);
      targets[side > 0 ? 'right' : 'left'] = { ...target(hand, orientation,
        worldPoint(side * .28, 1.34, .15 + cut * .36), attack.weight * (1 - recovery)), pole: worldPoint(side * .75, 1.25, -.1) };
    } else if (this.classId === 4 && this.collapse > .01) {
      targets.left = target(this.leftArm, orientation, undefined, this.collapse);
      targets.right = target(this.rightArm, orientation, undefined, this.collapse);
    }
    if (!this.bowModel) { this.handDebug = this.handPlacement.apply(targets); return; }
    const bow = this.bowModel;
    const bowPhase = adventurerBowAction(!suppressed && (skill || attack)
      ? skill ? (time - this.skillStarted) / (ADVENTURER_SKILL_SECONDS[1] + .25) : progress : Infinity);
    const raised = bowPhase.raised * (skill?.weight ?? attack?.weight ?? 0);
    const release = bowPhase.released ? 1 - bowPhase.draw : 0;
    const carry = socketWorld(this.leftArm.end, PALM).position;
    // Keep the same authored hold relative to the moving shoulder center. A
    // fixed model-space height loses reach when a different valid idle/stride
    // translates the torso; neither chest nor gameplay root needs pinning.
    const shoulders = this.leftArm.joint.getWorldPosition(new THREE.Vector3())
      .add(this.rightArm.joint.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5);
    const hold = new THREE.Vector3(0, -.02, .53).multiplyScalar(this.root.getWorldScale(new THREE.Vector3()).x)
      .applyQuaternion(orientation).add(shoulders);
    const grip = carry.clone().lerp(hold, raised);
    const placed = placeBowHands(this.handPlacement, bow, { draw: bowPhase.draw * .6, arrowVisible: bowPhase.nocked,
      primary: { ...target(this.leftArm, turned(Z_AXIS, this.collapse * Math.PI / 2), grip),
        pole: raised > .01 ? worldPoint(-.7, 1.3, .05) : this.leftArm.bend.getWorldPosition(new THREE.Vector3()) },
      // Counter the .228m string return and add .1m of free-hand follow-through.
      secondary: { rotation: orientation, socket: PALM, pole: worldPoint(.7, 1.4, -.2), weight: raised,
        offset: { x: .18 * release, y: -.05 * release, z: -.328 * release } },
    });
    // The right palm follows the exact moving nock, not a separately guessed
    // pose. Once released it recoils while the string snaps back to its rest.
    this.handDebug = { hands: placed.hands.filter(hand => hand.id === 'left' || raised > .001), warnings: placed.warnings };
  }

  /** Actual support is applied only after the full locomotion/action pose. */
  private placeFeet(): void {
    const { input: pose, time, reset, movementFrame } = this.motionFrame!;
    // The current campaign has a flat authoritative floor. Support is supplied by
    // its view adapter; absence is explicit and never inferred from decoration.
    this.footErrors = [];
    if (pose.support && this.collapse < 0.01 && this.kneeling < 0.01) {
      this.root.updateWorldMatrix(true, true);
      for (const [index, leg] of [this.leftLeg, this.rightLeg].entries()) {
        const stance = this.contactWeights[index];
        const hip = leg.joint.getWorldPosition(new THREE.Vector3()), desired = leg.end.getWorldPosition(new THREE.Vector3());
        const normal = new THREE.Vector3().copy(pose.support.normal).normalize();
        const toe = this.joints.get(index === 0 ? 'left-toe' : 'right-toe')!;
        let clearance = 0;
        for (const [node, low, back, front] of [[leg.end, -.1425, -.1, .1], [toe, -.1075, -.035, .115]] as const)
          for (const x of [-.109, .109]) for (const z of [back, front]) {
            const offset = node.localToWorld(new THREE.Vector3(x, low, z)).sub(desired);
            clearance = Math.max(clearance, -offset.dot(normal));
          }
        const point = new THREE.Vector3().copy(pose.support.point).addScaledVector(normal, clearance + .003);
        const support = { ...pose.support, point };
        const placed = placeFoot({ time, hip, desired, frame: movementFrame, support, contactWeight: stance,
          previous: this.feet[index], maxReach: 0.809, maxAdjustment: 0.22, reset });
        // Support is authoritative. Prevent the articulated heel/toes crossing
        // it even during swing, while preserving their recorded orientation.
        const target = new THREE.Vector3().copy(placed.target);
        if (placed.support === 'current') target.addScaledVector(normal, Math.max(0, point.clone().sub(target).dot(normal)));
        placed.target = { x: target.x, y: target.y, z: target.z };
        this.feet[index] = placed;
        if (placed.support === 'current' && target.distanceToSquared(desired) > 1e-10)
          correctLegContact(leg, target, new THREE.Vector3().copy(movementFrame.forward));
        this.footErrors.push(leg.end.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(placed.target.x, placed.target.y, placed.target.z)));
      }
    } else this.feet.length = 0;

  }


  inspection(): Record<string, unknown> {
    return { actorAnimation: this.actorAnimationDebug, animation: this.animationDebug, gaitPhase: this.gait.phase, motionMatching: this.motionDebug, matchedGaitPhase: this.matchedGaitPhase, prediction: this.locomotionDebug,
      feet: this.feet.map(foot => foot ?? null), footContactWeights: this.contactWeights, footTargetErrors: this.footErrors,
      footSolver: 'spatial-two-bone-preserve-bend', rig: ADVENTURER_MOTION_RIG, jointCount: this.joints.size,
      motionSource: this.motionDebug?.selectedClip ? adventurerMotion(this.motionDebug.selectedClip)?.provenance : undefined,
      equipment: { hands: this.handDebug, attachments: this.attachments.map(item => item.inspection()), bow: this.bowModel?.inspection() }, role: this.classId };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.animation.reset(); this.motionFrame = null;
    this.root.removeFromParent(); this.bowModel?.dispose();
    this.root.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear(); this.materials.clear();
  }
}
