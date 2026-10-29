import * as THREE from 'three';
import { ActorAnimationController, type ActorAnimationContext, type ActorAnimationDiagnostics, type ActorLocomotionResult } from '../sandbox/actorAnimation.ts';
import { quaternionFromEuler, type AnimationJointTransform } from '../sandbox/animation.ts';
import { ThreeAnimationRig } from '../sandbox/animationView.ts';

export interface EnemyPose {
  time: number;
  delta: number;
  speed: number;
  facing: number;
  windupMs: number;
  strikeMs: number;
  hitMs: number;
  dead: boolean;
  attackId: number;
  /** Clear local gait/recovery when reusing an actor for a new spawn. */
  reset?: boolean;
}

type Limb = { upper: THREE.Group; lower: THREE.Group; hand: THREE.Group };
type Vec3 = [number, number, number];
const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value));
const ease = (value: number): number => { const t = clamp(value); return t * t * (3 - 2 * t); };

/** An articulated, asset-free creature rig. +Z is forward; the caller owns world position. */
export class EnemyVisual {
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private readonly boss: boolean;
  private readonly body = new THREE.Group();
  private readonly legsRoot = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly arms: Limb[] = [];
  private readonly legs: Limb[] = [];
  private readonly geometry = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly glow: THREE.MeshStandardMaterial;
  private readonly core: THREE.Mesh | null;
  private readonly hipHeight: number;
  private gait = 0;
  private moving = 0;
  private deathAge = 0;
  private attackAge = 10;
  private attackId = -1;
  private readonly animation: ActorAnimationController;
  private animationDiagnostics?: ActorAnimationDiagnostics;
  private disposed = false;

  constructor(boss: boolean) {
    this.boss = boss;
    this.root.name = boss ? 'Gatekeeper' : 'Trail raider';
    this.hipHeight = boss ? 1.59 : 0.95;
    this.material = this.surface(boss ? 0x667b80 : 0x6e7f6e, { roughness: 0.91, flatShading: true });
    const dark = this.surface(boss ? 0x283a43 : 0x303b39);
    const armor = this.surface(boss ? 0x9bacaa : 0x685652, { metalness: boss ? 0.18 : 0.28, roughness: 0.7, flatShading: true });
    const trim = this.surface(boss ? 0xa98a57 : 0x8d7460, { metalness: 0.45, roughness: 0.55 });
    const cloth = this.surface(0x6a4344, { roughness: 1, flatShading: true });
    const ivory = this.surface(0xd4c7a4, { roughness: 0.72 });
    this.glow = this.surface(0xffcc7b, { emissive: 0xffa13a, emissiveIntensity: 1.9, roughness: 0.3, metalness: 0.15 });
    this.root.add(this.body, this.legsRoot);
    this.body.add(this.chest);
    this.chest.position.y = boss ? 0.84 : 0.48;
    this.chest.add(this.head);
    this.head.position.set(0, boss ? 0.77 : 0.39, boss ? 0.12 : 0.23);

    if (boss) {
      // Segmented masonry and an exposed rune furnace give the guardian its own silhouette.
      this.block(this.body, [0.95, 0.37, 0.65], [0, 0.04, 0], dark);
      this.stone(this.chest, [0.85, 0.78, 0.5], [0, 0, 0], this.material);
      for (const side of [-1, 1]) {
        const plate = this.block(this.chest, [0.55, 0.72, 0.23], [side * 0.49, 0.1, 0.42], armor);
        plate.rotation.z = side * -0.18;
        this.block(this.chest, [0.09, 0.55, 0.08], [side * 0.51, 0.14, 0.57], trim).rotation.z = side * -0.18;
        this.block(this.body, [0.42, 0.45, 0.2], [side * 0.36, -0.13, 0.41], armor).rotation.z = side * 0.16;
      }
      this.block(this.chest, [1.36, 0.22, 0.2], [0, 0.52, 0.3], armor);
      this.block(this.chest, [0.92, 0.18, 0.2], [0, -0.53, 0.36], trim);
      const bezel = this.mesh('ring', this.chest, [0.34, 0.34, 0.1], [0, 0.01, 0.57], trim);
      bezel.rotation.z = Math.PI / 4;
      this.core = this.mesh('crystal', this.chest, [0.24, 0.31, 0.14], [0, 0.01, 0.62], this.glow);
      for (const side of [-1, 1]) {
        this.block(this.chest, [0.18, 0.035, 0.035], [side * 0.28, -0.1, 0.6], this.glow).rotation.z = side * 0.5;
        this.block(this.chest, [0.035, 0.24, 0.035], [side * 0.35, -0.24, 0.58], this.glow);
      }
      this.stone(this.head, [0.45, 0.52, 0.38], [0, 0, 0], this.material);
      this.block(this.head, [0.69, 0.21, 0.24], [0, 0.13, 0.32], armor);
      this.block(this.head, [0.5, 0.08, 0.08], [0, 0.02, 0.42], dark);
      for (const side of [-1, 1]) this.block(this.head, [0.16, 0.055, 0.04], [side * 0.15, 0.025, 0.465], this.glow);
      this.block(this.head, [0.22, 0.29, 0.14], [0, -0.13, 0.36], armor);
      for (const side of [-1, 1]) {
        this.block(this.head, [0.16, 0.45, 0.23], [side * 0.36, 0.37, -0.02], armor).rotation.z = side * -0.13;
        this.block(this.head, [0.1, 0.13, 0.08], [side * 0.36, 0.54, 0.12], trim);
      }
    } else {
      // Raiders lean into a broad collar and long clawed hands, with a compact masked face.
      this.stone(this.chest, [0.4, 0.48, 0.3], [0, -0.04, 0], this.material);
      this.block(this.chest, [0.55, 0.36, 0.13], [0, 0.02, 0.28], armor).rotation.x = -0.08;
      this.block(this.chest, [0.09, 0.62, 0.1], [-0.03, -0.02, 0.37], trim).rotation.z = -0.55;
      this.block(this.body, [0.6, 0.16, 0.48], [0, 0.02, 0], dark);
      for (const side of [-1, 1]) {
        const skirt = this.mesh('cone', this.body, [0.23, 0.42, 0.12], [side * 0.21, -0.22, 0.2], cloth);
        skirt.rotation.z = Math.PI + side * 0.15;
      }
      this.stone(this.head, [0.27, 0.28, 0.28], [0, 0, 0], this.material);
      this.stone(this.head, [0.22, 0.14, 0.17], [0, -0.13, 0.24], dark);
      this.block(this.head, [0.49, 0.1, 0.18], [0, 0.08, 0.2], armor).rotation.x = -0.12;
      for (const side of [-1, 1]) {
        this.block(this.head, [0.095, 0.05, 0.035], [side * 0.125, 0.015, 0.273], this.glow).rotation.z = side * 0.16;
        const ear = this.mesh('cone', this.head, [0.115, 0.33, 0.12], [side * 0.3, 0.12, -0.02], this.material);
        ear.rotation.z = side * -1.04;
        const tooth = this.mesh('cone', this.head, [0.045, 0.14, 0.045], [side * 0.13, -0.14, 0.36], ivory);
        tooth.rotation.x = -0.25;
      }
      this.core = null;
    }

    for (const side of [-1, 1]) {
      const shoulder = boss ? 0.91 : 0.45;
      const arm = this.limb(this.chest, [side * shoulder, boss ? 0.36 : 0.2, 0], boss ? 0.66 : 0.39, boss ? 0.73 : 0.42);
      this.arms.push(arm);
      if (boss) {
        this.stone(arm.upper, [0.55, 0.4, 0.48], [side * 0.12, -0.06, 0], armor);
        this.block(arm.upper, [0.75, 0.13, 0.67], [side * 0.12, 0.19, 0], trim);
        this.stone(arm.upper, [0.29, 0.42, 0.29], [0, -0.38, 0], this.material);
        this.stone(arm.lower, [0.4, 0.5, 0.38], [0, -0.37, 0], this.material);
        this.block(arm.lower, [0.59, 0.49, 0.16], [0, -0.37, 0.33], armor);
        this.block(arm.lower, [0.06, 0.3, 0.05], [0, -0.35, 0.43], this.glow);
        this.block(arm.lower, [0.67, 0.16, 0.58], [0, -0.67, 0], trim);
        this.stone(arm.hand, [0.4, 0.35, 0.39], [0, -0.19, 0.1], armor);
        for (const x of [-0.19, 0, 0.19]) this.block(arm.hand, [0.14, 0.24, 0.22], [x, -0.3, 0.33], this.material);
      } else {
        this.stone(arm.upper, [0.23, 0.2, 0.25], [side * 0.04, -0.05, 0], armor);
        this.stone(arm.upper, [0.13, 0.25, 0.14], [0, -0.24, 0], this.material);
        this.stone(arm.lower, [0.145, 0.26, 0.16], [0, -0.24, 0], this.material);
        this.block(arm.lower, [0.26, 0.18, 0.28], [0, -0.29, 0], dark);
        this.stone(arm.hand, [0.17, 0.13, 0.22], [0, -0.08, 0.08], this.material);
        for (const x of [-0.1, 0.02, 0.13]) {
          const claw = this.mesh('cone', arm.hand, [0.045, 0.23, 0.045], [x, -0.15, 0.23], ivory);
          claw.rotation.x = -2.35;
        }
      }
      const leg = this.limb(this.legsRoot, [side * (boss ? 0.43 : 0.21), 0, 0], boss ? 0.68 : 0.41, boss ? 0.66 : 0.39);
      this.legs.push(leg);
      this.stone(leg.upper, boss ? [0.32, 0.43, 0.35] : [0.16, 0.25, 0.18], [0, boss ? -0.36 : -0.22, 0], boss ? this.material : dark);
      this.stone(leg.lower, boss ? [0.35, 0.43, 0.32] : [0.15, 0.24, 0.16], [0, boss ? -0.33 : -0.2, 0], boss ? armor : this.material);
      this.block(leg.lower, boss ? [0.43, 0.32, 0.14] : [0.2, 0.15, 0.1], [0, 0, boss ? 0.3 : 0.16], armor);
      this.block(leg.hand, boss ? [0.68, 0.3, 0.94] : [0.29, 0.2, 0.5], [0, boss ? -0.08 : -0.035, boss ? 0.2 : 0.1], boss ? dark : armor);
    }
    const nodes: Record<string, THREE.Object3D> = { body: this.body, legsRoot: this.legsRoot, chest: this.chest, head: this.head };
    for (let index = 0; index < 2; index++) {
      const side = index ? 'right' : 'left';
      nodes[`${side}Shoulder`] = this.arms[index].upper;
      nodes[`${side}Elbow`] = this.arms[index].lower;
      nodes[`${side}Hand`] = this.arms[index].hand;
      nodes[`${side}Hip`] = this.legs[index].upper;
      nodes[`${side}Knee`] = this.legs[index].lower;
      nodes[`${side}Foot`] = this.legs[index].hand;
    }
    if (this.core) nodes.core = this.core;
    for (const [name, node] of Object.entries(nodes)) node.name = name;
    this.animation = new ActorAnimationController({
      rig: new ThreeAnimationRig(nodes, { strict: true }),
      // Editable creature-specific motion keeps its original silhouette and
      // timing while sharing reset, composition, rig application and diagnostics.
      locomotion: context => this.sampleAnimation(context),
      onReset: () => { this.gait = 0; this.moving = 0; this.deathAge = 0; this.attackAge = 10; this.attackId = -1; },
    });
    this.update({ time: 0, delta: 0, speed: 0, facing: 0, windupMs: 0, strikeMs: 0, hitMs: 0, dead: false, attackId: 0 });
    // The constructor pose is not an observed network frame. A late join must not replay an old attack.
    this.animation.reset();
  }

  private surface(color: number, parameters: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...parameters });
    this.materials.add(material);
    return material;
  }

  private mesh(shape: string, parent: THREE.Object3D, scale: Vec3, position: Vec3, material: THREE.Material): THREE.Mesh {
    let geometry = this.geometry.get(shape);
    if (!geometry) {
      geometry = shape === 'stone' ? new THREE.IcosahedronGeometry(1, 0)
        : shape === 'cone' ? new THREE.ConeGeometry(1, 1, 5)
          : shape === 'crystal' ? new THREE.OctahedronGeometry(1)
            : shape === 'ring' ? new THREE.TorusGeometry(1, 0.2, 4, 8)
              : new THREE.BoxGeometry(1, 1, 1);
      this.geometry.set(shape, geometry);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(...scale);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private block(parent: THREE.Object3D, size: Vec3, position: Vec3, material: THREE.Material): THREE.Mesh {
    return this.mesh('box', parent, size, position, material);
  }

  private stone(parent: THREE.Object3D, radius: Vec3, position: Vec3, material: THREE.Material): THREE.Mesh {
    return this.mesh('stone', parent, radius, position, material);
  }

  private limb(parent: THREE.Object3D, position: Vec3, upperLength: number, lowerLength: number): Limb {
    const upper = new THREE.Group(), lower = new THREE.Group(), hand = new THREE.Group();
    upper.position.set(...position);
    lower.position.y = -upperLength;
    hand.position.y = -lowerLength;
    parent.add(upper); upper.add(lower); lower.add(hand);
    return { upper, lower, hand };
  }

  update(pose: EnemyPose): void {
    if (this.disposed) return;
    this.root.rotation.y = pose.facing;
    this.animationDiagnostics = this.animation.sample({
      reset: pose.reset || this.attackId >= 0 && pose.attackId < this.attackId,
      deltaMs: clamp(Number.isFinite(pose.delta) ? pose.delta : 0, 0, 0.1) * 1000,
      signals: { id: typeof this.root.userData.inspectionActorId === 'string' ? this.root.userData.inspectionActorId
        : this.boss ? 'rpg-gatekeeper' : 'rpg-raider', timeMs: pose.time * 1000,
        velocity: { x: Math.sin(pose.facing) * pose.speed, y: 0, z: Math.cos(pose.facing) * pose.speed },
        facing: { x: Math.sin(pose.facing), y: 0, z: Math.cos(pose.facing) },
        grounded: true, posture: pose.dead ? 'dead' : 'standing',
        parameters: { speed: pose.speed, windupMs: pose.windupMs, strikeMs: pose.strikeMs, hitMs: pose.hitMs, attackId: pose.attackId },
      },
    }).diagnostics;
    const fallen = ease(this.deathAge / (this.boss ? 0.9 : 0.65));
    const windup = pose.dead ? 0 : pose.windupMs > 0 ? ease(1 - pose.windupMs / (this.boss ? 1100 : 650)) : 0;
    this.glow.emissiveIntensity = pose.dead ? Math.max(0.08, 1.9 * (1 - fallen)) : 1.6 + windup * 2 + Math.sin(pose.time * 3) * 0.18;
    this.material.emissive.setHex(pose.hitMs > 0 && !pose.dead ? 0x793d26 : 0x000000);
    this.material.emissiveIntensity = pose.hitMs > 0 && !pose.dead ? clamp(pose.hitMs / 170) * 0.75 : 0;
  }

  inspection(): Record<string, unknown> {
    return { kind: this.boss ? 'gatekeeper' : 'raider', actorAnimation: this.animationDiagnostics ?? null };
  }

  private sampleAnimation({ signals, deltaMs }: Readonly<ActorAnimationContext>): ActorLocomotionResult {
    const dt = deltaMs / 1000, values = signals.parameters;
    const pose = { time: signals.timeMs / 1000, speed: Number(values?.speed ?? 0), dead: signals.posture === 'dead',
      windupMs: Number(values?.windupMs ?? 0), strikeMs: Number(values?.strikeMs ?? 0),
      hitMs: Number(values?.hitMs ?? 0), attackId: Number(values?.attackId ?? 0) };
    const speed = pose.dead || pose.windupMs > 0 || pose.strikeMs > 0 ? 0 : clamp(pose.speed / (this.boss ? 2.7 : 4.2));
    this.moving += (speed - this.moving) * (1 - Math.exp(-dt * 12));
    this.gait += dt * Math.max(0, pose.speed) * (this.boss ? 3.1 : 5.3);
    this.deathAge = pose.dead ? this.deathAge + dt : 0;
    const fallen = ease(this.deathAge / (this.boss ? 0.9 : 0.65));
    if (pose.attackId !== this.attackId) {
      const newStrike = pose.strikeMs > 0 || this.attackId >= 0 && pose.attackId > this.attackId;
      this.attackAge = newStrike ? Math.max(0, 0.16 - pose.strikeMs / 1000) : 10;
      this.attackId = pose.attackId;
    } else this.attackAge += dt;
    // The server windup is authoritative; the extra recovery gives the strike visible weight.
    const windup = pose.dead ? 0 : pose.windupMs > 0 ? ease(1 - pose.windupMs / (this.boss ? 1100 : 650)) : 0;
    const strike = pose.dead || pose.windupMs > 0 ? 0 : 1 - ease(this.attackAge / (this.boss ? 0.62 : 0.42));
    const hit = pose.dead ? 0 : Math.sin(clamp(pose.hitMs / 170) * Math.PI) * 0.14;
    const breath = Math.sin(pose.time * (this.boss ? 1.6 : 2.6)) * (this.boss ? 0.018 : 0.014) * (1 - fallen);
    const bob = Math.abs(Math.sin(this.gait)) * this.moving * (this.boss ? 0.055 : 0.045);
    const height = this.hipHeight + bob + breath - fallen * (this.boss ? 0.51 : 0.31);
    const bodyX = (this.boss ? 0.04 : 0.14) + fallen * 1.3 + strike * (this.boss ? 0.3 : 0.14) - windup * 0.14 - hit;
    const bodyY = this.boss ? 0 : -windup * 0.48 + strike * 0.45;
    const animation: Record<string, AnimationJointTransform> = {
      body: { position: { x: 0, y: height - strike * (this.boss ? 0.18 : 0.06), z: fallen * 0.15 },
        rotation: quaternionFromEuler({ x: bodyX, y: bodyY, z: Math.sin(this.gait) * this.moving * (this.boss ? 0.025 : 0.035) }) },
      legsRoot: { position: { x: 0, y: height, z: fallen * 0.15 } },
      chest: { rotation: quaternionFromEuler({ x: -windup * 0.12, y: Math.sin(this.gait) * this.moving * 0.055 }) },
      head: { rotation: quaternionFromEuler({ x: -bodyX * 0.45 + fallen * 0.3, y: -bodyY * 0.45, z: hit * 0.45 }) },
    };
    for (let index = 0; index < 2; index++) {
      const side = index ? 1 : -1, phase = this.gait + index * Math.PI;
      const walk = Math.sin(phase) * this.moving;
      const name = index ? 'right' : 'left';
      const raised = this.boss ? windup * 2.65 : windup * (index ? 2.05 : 0.7);
      const impact = this.boss ? strike * 1.0 : strike * (index ? 1.55 : 0.25);
      animation[`${name}Shoulder`] = { rotation: quaternionFromEuler({ x: walk * (this.boss ? 0.28 : 0.48) - raised - impact + fallen * 0.1,
        y: this.boss ? 0 : side * (windup * 0.35 - strike * 0.5), z: side * (0.13 + windup * (this.boss ? 0.2 : 0.35)) }) };
      animation[`${name}Elbow`] = { rotation: quaternionFromEuler({ x: -0.12 - windup * (this.boss ? 0.48 : 0.8) + strike * 0.12 - fallen * 0.7 }) };
      animation[`${name}Hand`] = { rotation: quaternionFromEuler({ x: strike * 0.24 }) };
      const hip = -walk * (this.boss ? 0.36 : 0.53) - fallen * 0.95 + windup * 0.1;
      const knee = Math.max(0, walk) * (this.boss ? 0.45 : 0.7) + fallen * 1.9 + strike * 0.15;
      animation[`${name}Hip`] = { rotation: quaternionFromEuler({ x: hip, z: side * 0.025 }) };
      animation[`${name}Knee`] = { rotation: quaternionFromEuler({ x: knee }) };
      // Counter-rotate the ankle so a planted foot stays level as the knee bends.
      animation[`${name}Foot`] = { rotation: quaternionFromEuler({ x: -hip - knee + Math.max(0, walk) * 0.12 }) };
    }
    if (this.core) animation.core = { rotation: quaternionFromEuler({ y: pose.time * 0.3 }) };
    return { pose: animation, diagnostics: { source: this.boss ? 'rpg:gatekeeper' : 'rpg:raider',
      sourceTimeMs: signals.timeMs, phase: this.gait % (Math.PI * 2) / (Math.PI * 2),
      state: pose.dead ? 'dead' : pose.windupMs > 0 ? 'windup' : strike > 0 ? 'strike' : speed > 0 ? 'moving' : 'idle' } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.geometry.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.geometry.clear();
    this.materials.clear();
  }
}
