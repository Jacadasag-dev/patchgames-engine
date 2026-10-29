import * as THREE from 'three';
import { ActorAnimationController } from '../../sandbox/actorAnimation.ts';
import { ActorHeading, HumanoidLocomotionDriver } from '../../sandbox/actorLocomotion.ts';
import { createHumanoidSkeleton } from '../../sandbox/animationView.ts';
import { defineAnimationClip, quaternionFromEuler, type ActorPresentationSignals, type AnimationPose } from '../../sandbox/animation.ts';
import { attachEquipment, HumanoidHandPlacement, socketWorld, type SocketFrame, type HandPlacementResult } from '../../sandbox/equipmentView.ts';
import { registerEquipmentOrientation } from '../../sandbox/equipmentOrientation.ts';
import { registerInspectionEquipment } from '../../sandbox/inspectionGeometry.ts';
import type { FighterState } from '../shapes.ts';

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };
const rotation = (x = 0, y = 0, z = 0) => ({ rotation: quaternionFromEuler({ x, y, z }) });
const PALM: SocketFrame = { position: { x: 0, y: -.06, z: .015 } };
const FORWARD = new THREE.Vector3(0, 0, 1);
const direction = (x: number, y: number, z: number, roll = 0) => new THREE.Quaternion().setFromUnitVectors(FORWARD,
  new THREE.Vector3(x, y, z).normalize()).multiply(new THREE.Quaternion().setFromAxisAngle(FORWARD, roll));
const combatBody = defineAnimationClip({ durationMs: 1000, loop: true, sample: ({ signals }): AnimationPose => {
  const p = signals?.parameters ?? {}, action = ['idle', 'light', 'heavy', 'charging', 'bash', 'recovery', 'stunned', 'dodge'][Number(p.actionCode ?? 0)] ?? 'idle';
  const phase = clamp(1 - Number(p.remaining ?? 0) / Math.max(1, Number(p.duration ?? 1)));
  if (signals?.posture === 'downed') return { hips: { position: { x: 0, y: -.74, z: 0 }, ...rotation(0, 0, -1.5) } };
  if (action === 'stunned') return { 'spine-2': rotation(-.18), chest: rotation(-.15, 0, Math.sin((signals?.timeMs ?? 0) * .025) * .045), head: rotation(.3) };
  if (action === 'dodge') return { hips: { position: { x: 0, y: -.16, z: 0 } }, 'spine-2': rotation(.24), 'left-knee': rotation(.55), 'right-knee': rotation(.55) };
  if (action === 'bash') return { 'spine-2': rotation(.18 * Math.sin(phase * Math.PI)), chest: rotation(0, -.12) };
  const side = Number(p.attackGuard ?? p.guard ?? 1) === 0 ? -1 : 1;
  if (action === 'light' || action === 'heavy') return { 'spine-2': rotation(.07, side * (.18 - .35 * smooth(phase))), chest: rotation(.05, side * (.12 - .24 * smooth(phase))) };
  return { 'spine-2': rotation(.035), head: rotation(-.02) };
} });

/** Both hands use real skeleton chains; equipment stays attached to the wrist. */
export class FighterView {
  readonly root = new THREE.Group();
  readonly body = createHumanoidSkeleton();
  readonly sword = new THREE.Group();
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly round = new THREE.CylinderGeometry(1, 1, 1, 8);
  private readonly steel = new THREE.MeshStandardMaterial({ color: 0xa4adb1, roughness: .38, metalness: .78 });
  private readonly dark = new THREE.MeshStandardMaterial({ color: 0x282c2b, roughness: .78, metalness: .25 });
  private readonly gold = new THREE.MeshStandardMaterial({ color: 0xb69551, roughness: .45, metalness: .65 });
  private readonly blade = new THREE.MeshStandardMaterial({ color: 0xe1e7e5, roughness: .23, metalness: .86 });
  private readonly cloth: THREE.MeshStandardMaterial;
  private readonly markerMaterial: THREE.MeshBasicMaterial;
  private readonly marker: THREE.Mesh;
  private readonly hands = new HumanoidHandPlacement(this.body);
  private readonly heading = new ActorHeading();
  private readonly animation: ActorAnimationController;
  private readonly attachment: ReturnType<typeof attachEquipment>;
  private readonly unregister: () => void;
  private readonly secondary: SocketFrame;
  private handReport: HandPlacementResult = { hands: [], warnings: [] };
  private latest?: ReturnType<ActorAnimationController['sample']>;
  private holdPosition = new THREE.Vector3();
  private holdRotation = new THREE.Quaternion();
  private ready = false;
  private state?: FighterState;
  private lastHp = 100;
  private flashUntil = 0;
  private reachAdjustment = 0;
  private chargeDuration = 1000;

  constructor(color: number) {
    this.root.name = 'medieval-knight'; this.root.add(this.body.root);
    this.cloth = new THREE.MeshStandardMaterial({ color, roughness: .94 });
    const add = (joint: string, name: string, size: [number, number, number], at: [number, number, number], material = this.steel, geometry: THREE.BufferGeometry = this.box) => {
      const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.scale.set(...size); mesh.position.set(...at);
      mesh.castShadow = mesh.receiveShadow = true; this.body.joints[joint].add(mesh); return mesh;
    };
    add('hips', 'chainmail-skirt', [.45, .28, .3], [0, -.015, 0], this.dark);
    add('hips', 'belt', [.47, .065, .32], [0, .10, 0], this.gold);
    for (const [i, joint] of ['spine-1', 'spine-2', 'spine-3', 'spine-4', 'chest'].entries()) {
      add(joint, 'articulated-cuirass-' + i, [.43 + i * .025, .125, .30], [0, .04, 0]);
      add(joint, 'surcoat-' + i, [.23, .126, .025], [0, .04, .165], this.cloth);
      add(joint, 'back-surcoat-' + i, [.26, .126, .025], [0, .04, -.165], this.cloth);
    }
    add('chest', 'heraldic-cross-vertical', [.035, .19, .025], [0, .025, .185], this.gold);
    add('chest', 'heraldic-cross-arms', [.14, .035, .025], [0, .06, .187], this.gold);
    add('neck-1', 'mail-coif', [.145, .13, .145], [0, .035, 0], this.dark, this.round);
    add('neck-2', 'gorget', [.16, .105, .16], [0, .01, 0], this.steel, this.round);
    add('head', 'great-helm', [.19, .34, .19], [0, .035, 0], this.steel, this.round);
    add('head', 'visor-shadow', [.28, .039, .025], [0, .09, .185], this.dark);
    add('head', 'visor-nasal', [.026, .22, .037], [0, .015, .205], this.gold);
    for (const x of [-.11, -.07, .07, .11]) add('head', 'breathing-slit', [.013, .055, .018], [x, -.065, .19], this.dark);
    add('head', 'helmet-crest', [.045, .065, .30], [0, .225, -.005], this.gold);
    for (const side of ['left', 'right']) {
      add(side + '-shoulder', side + '-pauldron', [.29, .19, .34], [0, -.035, 0]);
      add(side + '-shoulder', side + '-upper-arm', [.115, .28, .12], [0, -.16, 0], this.dark, this.round);
      add(side + '-elbow', side + '-elbow-plate', [.21, .12, .22], [0, -.015, 0]);
      add(side + '-elbow', side + '-vambrace', [.095, .24, .10], [0, -.16, 0], this.steel, this.round);
      add(side + '-hand', side + '-gauntlet', [.13, .14, .095], [0, -.055, -.025]);
      for (const x of [-.045, -.015, .015, .045]) add(side + '-hand', 'curled-finger', [.026, .06, .055], [x, -.07, .027], this.dark);
      add(side + '-hip', side + '-cuisses', [.125, .36, .135], [0, -.19, 0], this.steel, this.round);
      add(side + '-hip', side + '-split-tabard', [.18, .28, .035], [0, -.08, .15], this.cloth);
      add(side + '-knee', side + '-poleyn', [.24, .14, .10], [0, -.02, .13], this.gold);
      add(side + '-knee', side + '-greave', [.105, .33, .115], [0, -.21, 0], this.steel, this.round);
      add(side + '-foot', side + '-sabatons', [.22, .14, .34], [0, -.065, .07], this.dark);
      add(side + '-toe', side + '-steel-toe', [.22, .085, .16], [0, -.035, .06]);
    }
    const part = (name: string, size: [number, number, number], at: [number, number, number], material: THREE.Material) => {
      const mesh = new THREE.Mesh(this.box, material); mesh.name = name; mesh.scale.set(...size); mesh.position.set(...at); mesh.castShadow = true; this.sword.add(mesh);
    };
    this.sword.name = 'two-handed-longsword';
    part('leather-hilt', [.065, .34, .065], [0, -.07, 0], this.dark);
    for (let i = 0; i < 9; i++) part('hilt-wrap', [.07, .012, .07], [0, -.22 + i * .036, 0], this.gold);
    part('pommel', [.12, .09, .09], [0, -.285, 0], this.gold); part('quillons', [.42, .045, .075], [0, .13, 0], this.gold);
    part('blade', [.08, .99, .025], [0, .66, 0], this.blade); part('fuller', [.017, .83, .027], [0, .61, 0], this.steel);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(.044, .16, 4), this.blade); tip.position.y = 1.23; tip.rotation.y = Math.PI / 4; tip.castShadow = true; this.sword.add(tip);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const primary: SocketFrame = { position: { x: 0, y: .015, z: 0 }, rotation: q };
    this.secondary = { position: { x: 0, y: -.165, z: 0 }, rotation: q };
    this.unregister = registerEquipmentOrientation(this.sword, { id: 'duel-longsword', grip: 'primary-grip', weight: 'heavy',
      points: [
        { id: 'primary-grip', tags: ['grip'], position: { x: 0, y: .015, z: 0 } },
        { id: 'secondary-grip', tags: ['grip', 'two-handed'], position: { x: 0, y: -.165, z: 0 } },
        { id: 'tip', tags: ['blade', 'tip'], position: { x: 0, y: 1.31, z: 0 } },
        { id: 'center', tags: ['blade'], position: { x: 0, y: .66, z: 0 } },
        { id: 'left-edge', tags: ['sharp-edge'], position: { x: -.04, y: .66, z: 0 } },
        { id: 'right-edge', tags: ['sharp-edge'], position: { x: .04, y: .66, z: 0 } },
        { id: 'face', tags: ['flat-face'], position: { x: 0, y: .66, z: .0125 } },
        { id: 'pommel', tags: ['hilt', 'blunt'], position: { x: 0, y: -.33, z: 0 } },
      ], directions: [
        { id: 'length', tags: ['blade'], from: 'primary-grip', to: 'tip', motionPoint: 'tip' },
        { id: 'cut-left', tags: ['sharp-edge'], from: 'center', to: 'left-edge', motionPoint: 'tip' },
        { id: 'cut-right', tags: ['sharp-edge'], from: 'center', to: 'right-edge', motionPoint: 'tip' },
        { id: 'flat', tags: ['flat-face'], from: 'center', to: 'face', motionPoint: 'tip' },
        { id: 'hilt-strike', tags: ['blunt'], from: 'primary-grip', to: 'pommel', motionPoint: 'pommel' },
      ] });
    registerInspectionEquipment(this.sword, [
      { id: 'hilt', node: this.sword, a: { x: 0, y: -.24, z: 0 }, b: { x: 0, y: .10, z: 0 }, radius: .033, allowedBodyParts: ['left-hand', 'right-hand'] },
      { id: 'blade', node: this.sword, a: { x: 0, y: .17, z: 0 }, b: { x: 0, y: 1.29, z: 0 }, radius: .025 },
      { id: 'guard', node: this.sword, a: { x: -.21, y: .13, z: 0 }, b: { x: .21, y: .13, z: 0 }, radius: .023 },
    ]);
    this.attachment = attachEquipment(this.body.joints['right-hand'], this.sword, primary, PALM);
    this.markerMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .65, side: THREE.DoubleSide, depthWrite: false });
    this.marker = new THREE.Mesh(new THREE.RingGeometry(.47, .50, 48), this.markerMaterial);
    this.marker.rotation.x = -Math.PI / 2; this.marker.position.y = .025; this.root.add(this.marker);
    this.animation = new ActorAnimationController({ rig: this.body.animationRig, locomotion: new HumanoidLocomotionDriver(),
      clips: { combat: combatBody }, layers: () => [{ clip: 'combat' }],
      // Armor uses a human shoulder span while retaining all shared joints.
      // This body adaptation leaves the arm lengths and gameplay root intact.
      adaptPose: pose => ({ ...pose,
        'left-clavicle': { ...pose['left-clavicle'], position: { x: .10, y: 0, z: 0 } },
        'right-clavicle': { ...pose['right-clavicle'], position: { x: -.10, y: 0, z: 0 } },
      }),
      equipmentLoads: () => [{ id: 'two-handed-longsword', weight: 'heavy', joints: ['left-shoulder', 'left-elbow', 'left-hand', 'right-shoulder', 'right-elbow', 'right-hand'] }],
      afterApply: (_result, context) => this.placeHands(context.deltaMs, context.reset),
      onReset: () => { this.ready = false; this.hands.reset(); },
    });
  }

  private placeHands(deltaMs: number, reset: boolean): void {
    const s = this.state; if (!s || this.lastHp <= 0) return;
    const action = s.combat.attackState, attacking = action === 'light' || action === 'heavy';
    const guard = attacking || action === 'charging' || action === 'recovery' ? s.combat.attackGuard : s.combat.guard, side = guard === 0 ? -1 : 1;
    const p = guard === 1 ? new THREE.Vector3(.10, -.10, .39) : new THREE.Vector3(side * .025, -.16, .36);
    let q = guard === 1 ? direction(-.8, .45, .36, -Math.PI / 2) : direction(side * .40, .86, .25, side * .7);
    const phase = clamp(1 - s.combat.actionMs / Math.max(1, s.combat.actionDurationMs));
    if (attacking || action === 'recovery') {
      const t = attacking ? smooth(Math.max(0, phase - .33) / .67) : 1 - smooth(phase);
      p.lerp(guard === 1 ? new THREE.Vector3(.10, -.20, .47) : new THREE.Vector3(-side * .035, -.15, .46), t);
      q.slerp(guard === 1 ? direction(0, -.22, 1, -Math.PI / 2) : direction(-side * .35, -.20, 1), t);
    } else if (action === 'charging') { p.y += .04 * clamp(s.combat.chargeMs / this.chargeDuration); p.z -= .04 * clamp(s.combat.chargeMs / this.chargeDuration); }
    else if (action === 'bash') { p.set(.02, -.12, .33 + .21 * smooth(phase)); q = direction(.80, .30, -.75, -.8); }
    else if (action === 'dodge' || s.combat.sprint) { p.set(.10, -.16, .44); q = direction(.5, .7, .4, -.5); }
    else if (action === 'stunned') { p.set(.10, -.12, .49); q = direction(.7, .3, .65); }
    const blend = reset || !this.ready ? 1 : 1 - Math.exp(-deltaMs / (attacking ? 24 : 65));
    this.holdPosition.lerp(p, blend); this.holdRotation.slerp(q, blend); this.ready = true;
    this.body.root.updateWorldMatrix(true, true);
    const j = this.body.joints, heading = this.body.root.getWorldQuaternion(new THREE.Quaternion());
    const center = j['left-shoulder'].getWorldPosition(new THREE.Vector3()).add(j['right-shoulder'].getWorldPosition(new THREE.Vector3())).multiplyScalar(.5);
    const scale = this.body.root.getWorldScale(new THREE.Vector3()).x;
    const point = (v: THREE.Vector3) => v.clone().multiplyScalar(scale).applyQuaternion(heading).add(center);
    const orientation = heading.clone().multiply(this.holdRotation), desired = point(this.holdPosition), grip = desired.clone();
    // A two-hand pose must lie in both arm reach spheres. Project the authored
    // grip into their intersection before solving, retaining the shared blade
    // orientation and actual handle spacing. This never stretches either arm.
    const palmOffset = new THREE.Vector3(0, -.06, .015).multiplyScalar(scale).applyQuaternion(orientation);
    const rightCenter = j['right-shoulder'].getWorldPosition(new THREE.Vector3()).add(palmOffset);
    const leftCenter = j['left-shoulder'].getWorldPosition(new THREE.Vector3()).add(palmOffset)
      .add(new THREE.Vector3(0, 0, .18 * scale).applyQuaternion(orientation));
    const reach = .585 * scale;
    const head = j.head.localToWorld(new THREE.Vector3(0, .04, 0));
    const clearance = .235 * scale;
    // The locomotion torso/head can lean independently of the sword stance.
    // Keep the actual crossguard and blade outside the posed helmet, then
    // re-project onto both arm reaches. These constraints use current joints,
    // including the imported gait's forward lean, rather than a fixed head box.
    const headCenters = [[-.21, .115], [0, .115], [.21, .115], [0, .34], [0, .60], [0, .88], [0, 1.22]].map(([x, z]) =>
      head.clone().sub(new THREE.Vector3(x * scale, 0, z * scale).applyQuaternion(orientation)));
    for (let i = 0; i < 32; i++) {
      for (const center of headCenters) {
        const delta = grip.clone().sub(center), distance = delta.length();
        if (distance < clearance) grip.copy(center).add(delta.lengthSq() > 1e-8 ? delta.setLength(clearance) : new THREE.Vector3(0, -clearance, 0));
      }
      for (const shoulder of [rightCenter, leftCenter]) {
        const delta = grip.clone().sub(shoulder); if (delta.length() > reach) grip.copy(shoulder).add(delta.setLength(reach));
      }
    }
    this.reachAdjustment = desired.distanceTo(grip);
    const primary = this.hands.apply({ right: { position: grip, rotation: orientation, pole: point(new THREE.Vector3(.80, -.40, -.06)), socket: PALM } });
    const actual = socketWorld(this.sword, this.secondary);
    const secondary = this.hands.apply({ left: { position: actual.position, rotation: actual.rotation, pole: point(new THREE.Vector3(-.80, -.40, -.06)), socket: PALM } });
    this.handReport = { hands: [...primary.hands, ...secondary.hands], warnings: [...primary.warnings, ...secondary.warnings] };
  }
  update(state: FighterState, hp: number, height: number, signals: ActorPresentationSignals, chargeDuration = 1000): void {
    this.chargeDuration = Math.max(1, chargeDuration);
    this.root.userData.inspectionActorId = signals.id;
    this.state = state; if (hp < this.lastHp) this.flashUntil = signals.timeMs + 180; this.lastHp = hp;
    this.root.position.set(state.x, state.y, state.z); this.root.rotation.y = state.facing; this.body.root.scale.setScalar(height / 2.17);
    const heading = this.heading.sample(signals); this.body.root.rotation.y = heading.offsetYaw;
    this.latest = this.animation.sample({ signals: { ...signals, facing: heading.forward }, actions: [] });
    this.blade.emissive.setHex(0xb88125); this.blade.emissiveIntensity = state.combat.attackState === 'charging' ? clamp(state.combat.chargeMs / this.chargeDuration) * .8 : 0;
    this.steel.emissive.setHex(0xa62416); this.steel.emissiveIntensity = signals.timeMs < this.flashUntil ? .65 : 0;
    this.marker.visible = hp > 0; this.markerMaterial.opacity = state.combat.feedbackMs > 0 && state.combat.actionFeedback === 'parry' ? 1 : .55;
  }
  inspection(): Record<string, unknown> { return { animation: this.latest?.diagnostics ?? null, hands: this.handReport, grip: this.attachment.inspection(), reachAdjustment: this.reachAdjustment, guard: this.state?.combat.guard ?? 1, action: this.state?.combat.attackState ?? 'idle',
    systems: ['shared-humanoid-25', 'motion-matching', 'actor-heading', 'authored-combat-layer', 'two-hand-IK', 'equipment-orientation'] }; }
  dispose(): void {
    this.animation.reset(); this.unregister(); this.body.skeleton.dispose(); this.root.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>(); this.root.traverse(object => { if (object instanceof THREE.Mesh) geometries.add(object.geometry); });
    geometries.forEach(geometry => geometry.dispose()); [this.steel, this.dark, this.gold, this.blade, this.cloth, this.markerMaterial].forEach(material => material.dispose());
  }
}
