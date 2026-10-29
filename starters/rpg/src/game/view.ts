import {installStarterMedia} from '../sandbox/starterMedia.ts';
installStarterMedia();
import * as THREE from 'three';
import type { CreateView, GameView, InspectionFocus, ReviewCamera, ViewFrame } from '../shared/gameApi.ts';
import { PlayerAppearanceHost } from '../sandbox/playerAppearance.ts';
import { InspectionFocusController, type InspectionTarget } from '../sandbox/inspectionFocus.ts';
import { configureShadowRenderer } from '../sandbox/lighting.ts';
import type { ActorPresentationSignals, AnimationAction, AnimationDiagnostics } from '../sandbox/animation.ts';
import { ActorActionTimeline, type ActorAnimationDiagnostics } from '../sandbox/actorAnimation.ts';
import type { MotionMatcherDiagnostics } from '../sandbox/motionMatching.ts';
import type { FootPlacement, LocomotionPrediction } from '../sandbox/locomotion.ts';
import { ADVENTURER_SKILL_SECONDS } from './adventurerMotions.ts';
import { CAMPAIGN } from './campaign.ts';
import { classInfo } from './classes.ts';
import { AdventurerVisual } from './adventurers.ts';
import { EnemyVisual } from './enemyVisuals.ts';
import { CampaignEnvironment } from './environment.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';
import { prepareTerrainWorld, terrainInterestsFor, type TerrainWorldSnapshot } from '../sandbox/terrainWorld.ts';
import { registerInspectionTerrain } from '../sandbox/inspectionGeometry.ts';
import { TerrainWorldView } from '../sandbox/terrainView.ts';

type Frame = ViewFrame<WorldState, PlayerState, GameTuning>;
type Overlay = { root: THREE.Group; health: THREE.Mesh; healthFrame: THREE.Group };
type Actor = Overlay & {
  visual: AdventurerVisual; ring: THREE.Mesh; aura: THREE.Mesh; slash: THREE.Mesh; shot: THREE.Group;
  classId: number; label: THREE.Sprite; labelContext: OffscreenCanvasRenderingContext2D;
  labelTexture: THREE.CanvasTexture<OffscreenCanvas>; labelText: string;
  lastX: number; lastZ: number; speed: number; hp: number; hitAt: number; attackId: number; attackAt: number;
  from: THREE.Vector3; to: THREE.Vector3;
};
type Monster = Overlay & { visual: EnemyVisual; ring: THREE.Mesh; lastX: number; lastZ: number; speed: number; deadAt: number };

/** Editable visual modules share the same campaign state and appearance-mod contract. */
export class CampaignView implements GameView<WorldState, PlayerState, GameTuning> {
  readonly terrainWorld = sharedTerrain;
  private terrainDetails: TerrainWorldView | undefined;
  private terrainSnapshot: TerrainWorldSnapshot | undefined;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly actors = new THREE.Group();
  private readonly appearances = new PlayerAppearanceHost(this.actors);
  private readonly focus = new InspectionFocusController();
  private readonly camera = new THREE.OrthographicCamera(-18, 18, 10, -10, 0.1, 180);
  private readonly inspectionCamera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  private readonly environment: CampaignEnvironment;
  private reviewCamera: ReviewCamera | null = null;
  private readonly fighters = new Map<string, Actor>();
  private readonly actionTimelines = new Map<string, ActorActionTimeline>();
  private readonly monsters: Monster[] = [];
  private aspect = 1;
  private disposed = false;
  private focused = false;
  private focusX = 0;
  private focusZ: number = CAMPAIGN.start.z;
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  readonly featureHost = {
    add: (object: unknown) => {
      if (!(object instanceof THREE.Object3D)) throw new Error('Feature visuals must be Three.js objects.');
      this.actors.add(object);
    },
    remove: (object: unknown) => { if (object instanceof THREE.Object3D) this.actors.remove(object); },
    setPlayerAppearance: (id: string, object: unknown | null) => this.appearances.setPlayerAppearance(id, object),
    setInspectionTarget: (id: string, object: unknown | null, label?: string, relatedTargets?: readonly string[]) => this.focus.setTarget(id, object, label, relatedTargets),
  };

  constructor(canvas: OffscreenCanvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    configureShadowRenderer(this.renderer);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.environment = new CampaignEnvironment(this.scene);
    this.scene.add(this.actors);
  }

  private ink(color: number, opacity = 1): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  }
  private ring(inner: number, outer: number, color: number, opacity: number, arc = Math.PI * 2): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 48, 1, 0, arc), this.ink(color, opacity));
    mesh.rotation.x = -Math.PI / 2; return mesh;
  }
  private overlay(height: number, width: number, color: number): Overlay {
    const root = new THREE.Group(), healthFrame = new THREE.Group();
    const track = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.08, 0.14), this.ink(0x10232a, 0.85));
    const health = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.065), this.ink(color));
    // Both layers use the transparent pass so the backing cannot paint over the fill.
    (health.material as THREE.MeshBasicMaterial).transparent = true;
    track.renderOrder = 10; health.renderOrder = 11;
    health.position.z = 0.01; healthFrame.add(track, health); healthFrame.position.y = height;
    root.add(healthFrame); this.actors.add(root); return { root, health, healthFrame };
  }
  private makeActor(classId: number): Actor {
    const overlay = this.overlay(2.55, 1.2, 0xa8dab7), visual = new AdventurerVisual(classId), color = classInfo(classId).color;
    const ring = this.ring(0.59, 0.64, 0xb6e8d6, 0.6); ring.position.y = 0.025;
    const aura = this.ring(0.84, 1, color, 0.25); aura.position.y = 0.045;
    const slash = this.ring(0.9, 1.22, color, 0.6, Math.PI * 0.7); slash.visible = false;
    const shot = new THREE.Group(); shot.visible = false;
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(classId === 1 ? 0.055 : 0.14), this.ink(classId === 2 ? 0xffbe75 : color));
    const trail = new THREE.Mesh(new THREE.CylinderGeometry(0.01, classId === 1 ? 0.018 : 0.06, classId === 1 ? 0.8 : 0.6, 6), this.ink(color, 0.5));
    trail.position.y = -0.3; shot.add(core, trail); this.actors.add(shot);
    const labelCanvas = new OffscreenCanvas(384, 64), labelContext = labelCanvas.getContext('2d')!;
    const labelTexture = new THREE.CanvasTexture(labelCanvas); labelTexture.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    label.scale.set(2.8, 0.47, 1); label.position.y = 2.9;
    overlay.root.add(visual.root, ring, aura, slash, label);
    return { ...overlay, visual, ring, aura, slash, shot, classId, label, labelContext, labelTexture, labelText: '',
      lastX: NaN, lastZ: NaN, speed: 0, hp: 100, hitAt: -Infinity, attackId: 0, attackAt: -Infinity,
      from: new THREE.Vector3(), to: new THREE.Vector3() };
  }
  private makeMonster(boss: boolean): Monster {
    const overlay = this.overlay(boss ? 4.55 : 2.5, boss ? 2.9 : 1.15, boss ? 0xf5bd79 : 0xd89983), visual = new EnemyVisual(boss);
    const ring = this.ring(0.04, 1, 0xf47b5d, 0.2); ring.position.y = 0.04;
    overlay.root.add(visual.root); this.actors.add(ring);
    return { ...overlay, visual, ring, lastX: NaN, lastZ: NaN, speed: 0, deadAt: -Infinity };
  }
  private disposeOverlay(root: THREE.Object3D): void {
    root.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      } else if (object instanceof THREE.Sprite) object.material.dispose();
    });
    root.removeFromParent();
  }
  private removeActor(actor: Actor): void {
    actor.visual.root.removeFromParent(); actor.visual.dispose(); actor.labelTexture.dispose();
    this.disposeOverlay(actor.root); this.disposeOverlay(actor.shot);
  }
  private removeMonster(actor: Monster): void {
    actor.visual.root.removeFromParent(); actor.visual.dispose(); this.disposeOverlay(actor.root); this.disposeOverlay(actor.ring);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.aspect = Math.max(1, width) / Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(1.75, pixelRatio)); this.renderer.setSize(width, height, false);
    this.inspectionCamera.aspect = this.aspect; this.inspectionCamera.updateProjectionMatrix();
  }
  setReviewCamera(camera: ReviewCamera | null): void { this.reviewCamera = camera; }
  setInspectionFocus(focus: InspectionFocus | null): void { this.focus.setFocus(focus); }
  inspectionFocus(): Record<string, unknown> { return this.focus.inspection(); }
  info(): Record<string, number> { return { forwardX: 0, forwardZ: -1 }; }
  actorSignals(frame: Frame): Record<string, ActorPresentationSignals> {
    const present = new Set(frame.players.map(player => player.id));
    for (const id of this.actionTimelines.keys()) if (!present.has(id)) this.actionTimelines.delete(id);
    return Object.fromEntries(frame.players.map(player => {
      const state = player.state, downed = player.hp <= 0, suppressed = downed || state.reviving || player.active === false;
      const epoch = `${frame.mode ?? 'rpg'}:${frame.phase}:${state.physicsId}:${state.classId}`;
      const actions: AnimationAction[] = [];
      if (!suppressed && state.attackMs > 0) actions.push({ id: `attack-${state.attackId}`, clip: 'attack',
        startedAtMs: frame.now - Math.max(0, 180 - state.attackMs), channel: 'attack', fadeInMs: 60, fadeOutMs: 100 });
      if (!suppressed && state.skillMs > 0) actions.push({ id: `skill-${state.skillId}`, clip: 'skill',
        startedAtMs: frame.now - Math.max(0, (ADVENTURER_SKILL_SECONDS[state.classId] ?? 0.6) * 1000 - state.skillMs), channel: 'skill', fadeInMs: 60, fadeOutMs: 100 });
      let timeline = this.actionTimelines.get(player.id);
      if (!timeline) { timeline = new ActorActionTimeline(); this.actionTimelines.set(player.id, timeline); }
      const observedActions = timeline.sample({ id: player.id, epoch, timeMs: frame.now, actions });
      return [player.id, { id: player.id, timeMs: frame.now, epoch,
        position: { x: state.x, y: state.y, z: state.z }, up: { x: 0, y: 1, z: 0 },
        facing: { x: Math.sin(state.facing), y: 0, z: Math.cos(state.facing) },
        velocity: suppressed ? { x: 0, y: 0, z: 0 } : { x: state.velocityX, y: state.velocityY, z: state.velocityZ },
        intendedVelocity: suppressed ? { x: 0, y: 0, z: 0 } : { x: state.intentX ?? 0, y: 0, z: state.intentZ ?? 0 },
        grounded: state.grounded > 0, posture: downed ? 'downed' : state.reviving ? 'reviving' : state.grounded > 0 ? 'standing' : 'airborne',
        parameters: { attacking: !suppressed && state.attackMs > 0, active: player.active !== false, classId: state.classId }, actions: observedActions,
        supports: state.grounded > 0 ? sharedTerrain.read(frame.tuning).actorSupports({ ground: state }, frame.now) : undefined,
      } satisfies ActorPresentationSignals];
    }));
  }
  inspection(): Record<string, unknown> {
    const visible = [...this.fighters.entries()].filter(([, actor]) => actor.root.visible);
    return { terrain: { ...this.terrainSnapshot?.inspection(), ...this.terrainDetails?.inspection(), constraints: { surface: 'fixed-flat', height: 0 } }, actorCount: visible.length, actors: visible.slice(0, 5).map(([id, actor]) => {
      // Keep the complete report on AdventurerVisual for focused authoring/tests.
      // A party capture shares its 16 KiB/2048-node budget with installed mods:
      // report selection, action timing and foot health without repeated poses,
      // world prediction samples or full foot-anchor coordinates for every actor.
      const detail = actor.visual.inspection();
      const controller = detail.actorAnimation as ActorAnimationDiagnostics | null;
      const animation = detail.animation as AnimationDiagnostics | null;
      const motion = detail.motionMatching as MotionMatcherDiagnostics | null;
      const prediction = detail.prediction as LocomotionPrediction | null;
      const feet = detail.feet as (FootPlacement | null)[];
      const footErrors = detail.footTargetErrors as number[];
      return { id, role: actor.classId, rig: detail.rig, jointCount: detail.jointCount,
        gaitPhase: detail.gaitPhase, matchedGaitPhase: detail.matchedGaitPhase,
        actorAnimation: controller ? { version: controller.version, reset: controller.reset, resetReason: controller.resetReason } : null,
        animation: animation ? {
          layerCount: controller?.layerCount ?? animation.layers.length, actionCount: controller?.actionCount ?? animation.actions.length,
          layers: animation.layers.slice(0, 4).map(layer => ({ id: layer.id, clip: layer.clip, phase: layer.phase, weight: layer.weight })),
          actions: animation.actions.slice(0, 4).map(action => ({ id: action.id, clip: action.clip, status: action.status, phase: action.phase, weight: action.weight })),
          warnings: animation.warnings.slice(0, 3),
        } : null,
        motionMatching: motion ? { selectedClip: motion.selectedClip, selectedTimeMs: motion.selectedTimeMs, selectedPhase: motion.selectedPhase,
          playbackRate: motion.playbackRate, score: motion.score, coverageScore: motion.coverageScore,
          frameCount: motion.frameCount, visited: motion.visited, searched: motion.searched, switched: motion.switched,
          reset: motion.reset, transition: motion.transition, transitionWeight: motion.transitionWeight, warnings: motion.warnings.slice(0, 4) } : null,
        motionSource: detail.motionSource ?? null,
        prediction: prediction ? { mode: prediction.mode, support: prediction.support, warnings: prediction.warnings.slice(0, 3) } : null,
        feet: feet.slice(0, 2).map(foot => foot ? { support: foot.support, reachable: foot.reachable,
          contactWeight: foot.contactWeight, anchored: !!foot.anchor, warnings: foot.warnings.slice(0, 2) } : null),
        footTargetErrors: footErrors.slice(0, 2),
      };
    }) };
  }

  update(frame: Frame): void {
    if (this.disposed) return;
    prepareTerrainWorld(sharedTerrain, frame.tuning, terrainInterestsFor(frame.players));
    const terrain = this.terrainSnapshot = sharedTerrain.read(frame.tuning);
    registerInspectionTerrain(this.scene, terrain);
    if (frame.world) terrain.assertRevision(frame.world.terrainRevision);
    if (terrain.contributionCount) {
      if (!this.terrainDetails) { this.terrainDetails = new TerrainWorldView(terrain, { surface: false, routeSurfaces: true }); this.scene.add(this.terrainDetails.root); }
      else this.terrainDetails.update(terrain);
    } else if (this.terrainDetails) { this.terrainDetails.root.removeFromParent(); this.terrainDetails.dispose(); this.terrainDetails = undefined; }
    const signals = this.actorSignals(frame);
    const time = frame.now / 1000, dt = Math.min(0.1, Math.max(0, frame.dt));
    const me = frame.players.find(player => player.isLocal && player.active !== false) ?? frame.players.find(player => player.active !== false);
    const targetX = me?.state.x ?? 0, targetZ = (me?.state.z ?? CAMPAIGN.start.z) - 3.5;
    const snap = !this.focused || Math.hypot(targetX - this.focusX, targetZ - this.focusZ) > 24;
    const blend = snap ? 1 : 1 - Math.exp(-dt * 7);
    this.focusX += (targetX - this.focusX) * blend; this.focusZ += (targetZ - this.focusZ) * blend; this.focused = true;
    const half = this.aspect < 0.8 ? 13 : 10;
    this.camera.left = -half * this.aspect; this.camera.right = half * this.aspect; this.camera.top = half; this.camera.bottom = -half;
    this.camera.updateProjectionMatrix(); this.camera.position.set(this.focusX, 22, this.focusZ + 21); this.camera.lookAt(this.focusX, 0, this.focusZ);
    if (this.reviewCamera) {
      const review = this.reviewCamera; this.inspectionCamera.position.set(review.x, review.y, review.z);
      this.inspectionCamera.rotation.set(review.pitch, review.yaw, 0, 'YXZ'); this.inspectionCamera.fov = review.fov; this.inspectionCamera.updateProjectionMatrix();
    }
    const camera = this.reviewCamera ? this.inspectionCamera : this.camera;
    this.environment.update({ time, delta: dt, focusX: this.focusX, focusZ: this.focusZ,
      stage: frame.mode === 'rpg' ? frame.world?.stage ?? 0 : -1,
      complete: frame.mode === 'rpg' && frame.world?.stage === 4 && frame.phase === 'ended' });

    for (const [id, actor] of this.fighters) if (!frame.players.some(player => player.id === id)) {
      this.appearances.remove(id); this.removeActor(actor); this.fighters.delete(id);
    }
    for (const player of frame.players) {
      const state = player.state;
      let actor = this.fighters.get(player.id);
      if (actor && actor.classId !== state.classId) {
        this.removeActor(actor); this.fighters.delete(player.id); actor = undefined;
      }
      if (!actor) { actor = this.makeActor(state.classId); this.fighters.set(player.id, actor); }
      const visible = player.active !== false, downed = player.hp <= 0;
      const distance = Math.hypot(state.x - actor.lastX, state.z - actor.lastZ);
      const moving = Number.isFinite(distance) && distance < 2 && dt > 0 ? Math.min(12, distance / dt) : 0;
      actor.speed += ((visible && !downed ? moving : 0) - actor.speed) * (1 - Math.exp(-dt * 14));
      actor.lastX = state.x; actor.lastZ = state.z;
      actor.root.visible = visible; actor.root.position.set(state.x, Math.max(0, state.y), state.z);
      actor.visual.update({ time, delta: dt, speed: actor.speed, facing: state.facing, downed, presentation: signals[player.id],
        attackId: state.attackId ?? 0, attackMs: state.attackMs, skillId: state.skillId ?? 0, skillMs: state.skillMs, reviving: state.reviving ?? false,
        position: { x: state.x, y: state.y, z: state.z }, velocity: { x: state.velocityX, y: state.velocityY, z: state.velocityZ },
        intendedVelocity: Number.isFinite(state.intentX) && Number.isFinite(state.intentZ) ? { x: state.intentX, y: 0, z: state.intentZ } : undefined,
        reset: Number.isFinite(distance) && distance >= 2,
        // Campaign movement uses the flat ground collider at y=0; decorative
        // hills must not be treated as physical support. Future terrain supplies
        // the same sampled heights/normals to both physics and presentation.
        support: { point: { x: state.x, y: 0, z: state.z }, normal: { x: 0, y: 1, z: 0 }, observedAt: time, grounded: state.grounded > 0, id: 'campaign-floor' } });
      if (player.hp < actor.hp) actor.hitAt = time;
      actor.hp = player.hp;
      actor.visual.material.emissive.setHex(0xff8060); actor.visual.material.emissiveIntensity = Math.max(0, 1 - (time - actor.hitAt) / 0.18) * 0.55;
      const name = player.name.length > 16 ? `${player.name.slice(0, 15)}…` : player.name;
      const labelText = downed ? `${name} · ${player.reviveProgress ? `Reviving ${Math.round(player.reviveProgress * 100)}%` : 'DOWNED'}` : name;
      if (labelText !== actor.labelText) {
        const context = actor.labelContext;
        context.clearRect(0, 0, 384, 64); context.font = '600 28px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
        context.lineWidth = 7; context.strokeStyle = '#101b29e6'; context.strokeText(labelText, 192, 32);
        context.fillStyle = downed ? '#ffdba1' : '#f5ead7'; context.fillText(labelText, 192, 32);
        actor.labelTexture.needsUpdate = true; actor.labelText = labelText;
      }
      actor.label.position.y = downed ? 1.1 : 2.9;
      actor.healthFrame.visible = !downed; actor.healthFrame.quaternion.copy(camera.quaternion);
      actor.health.scale.x = Math.max(0.001, player.hp / Math.max(1, player.maxHp));
      (actor.health.material as THREE.MeshBasicMaterial).color.setHex(player.hp / player.maxHp < 0.35 ? 0xef9b78 : 0xa8dab7);
      actor.ring.visible = player.isLocal || downed;
      (actor.ring.material as THREE.MeshBasicMaterial).color.setHex(downed ? 0xffc779 : 0xb6e8d6);
      actor.aura.visible = state.skillMs > 0 || downed;
      actor.aura.scale.setScalar(downed ? 0.8 + Math.sin(time * 4) * 0.04 : state.classId === 3 ? frame.tuning.healRadius : state.classId === 2 ? 5.5 : state.classId === 1 ? 3 : 1.05);
      (actor.aura.material as THREE.MeshBasicMaterial).opacity = downed ? 0.18 : 0.12 + Math.sin(time * 8) * 0.04;
      if (state.attackId !== actor.attackId) {
        if (state.attackId > actor.attackId && state.attackMs > 0) {
          actor.attackAt = time; actor.from.set(state.x, state.y + 1.25, state.z); actor.to.set(state.targetX, 1.1, state.targetZ);
          this.direction.copy(actor.to).sub(actor.from).clampLength(0, classInfo(state.classId).range);
          actor.to.copy(actor.from).add(this.direction);
        } else actor.attackAt = -Infinity;
        actor.attackId = state.attackId ?? 0;
      }
      const attackAge = time - actor.attackAt;
      actor.slash.visible = visible && !downed && (state.classId === 0 || state.classId === 4) && attackAge < 0.24;
      if (actor.slash.visible) {
        actor.slash.position.set(Math.sin(state.facing) * 0.5, 0.75, Math.cos(state.facing) * 0.5);
        actor.slash.rotation.set(-Math.PI / 2 + 0.15, 0, Math.PI / 2 - state.facing - attackAge * 8);
        actor.slash.scale.setScalar(state.classId === 0 ? 1.1 : 0.75);
        (actor.slash.material as THREE.MeshBasicMaterial).opacity = Math.sin(Math.PI * attackAge / 0.24) * 0.5;
      }
      actor.shot.visible = visible && !downed && state.classId > 0 && state.classId < 4 && attackAge >= 0.04 && attackAge < 0.28;
      if (actor.shot.visible) {
        actor.shot.position.lerpVectors(actor.from, actor.to, Math.min(1, (attackAge - 0.04) / 0.24));
        this.direction.copy(actor.to).sub(actor.from).normalize(); actor.shot.quaternion.setFromUnitVectors(this.up, this.direction);
      }
      this.appearances.update(player.id, actor.visual.root, state, visible);
    }
    const enemies = frame.world?.enemies ?? [];
    while (this.monsters.length > enemies.length) this.removeMonster(this.monsters.pop()!);
    while (this.monsters.length < enemies.length) this.monsters.push(this.makeMonster(enemies[this.monsters.length].kind === 1));
    this.monsters.forEach((actor, index) => {
      const enemy = enemies[index], dead = enemy.hp <= 0;
      if (dead && actor.deadAt === -Infinity) actor.deadAt = time;
      if (!dead) actor.deadAt = -Infinity;
      actor.root.visible = !dead || time - actor.deadAt < 1.2;
      const distance = Math.hypot(enemy.x - actor.lastX, enemy.z - actor.lastZ);
      const speed = Number.isFinite(distance) && distance < 2 && dt > 0 ? Math.min(6, distance / dt) : 0;
      actor.speed += (speed - actor.speed) * (1 - Math.exp(-dt * 12)); actor.lastX = enemy.x; actor.lastZ = enemy.z;
      actor.root.position.set(enemy.x, 0, enemy.z);
      actor.visual.root.userData.inspectionActorId = `enemy:${index}`;
      actor.visual.update({ time, delta: dt, speed: actor.speed, facing: enemy.facing, windupMs: enemy.windupMs,
        strikeMs: enemy.strikeMs, hitMs: enemy.hitMs, dead, attackId: enemy.attackId });
      actor.healthFrame.visible = !dead; actor.healthFrame.quaternion.copy(camera.quaternion);
      actor.health.scale.x = Math.max(0.001, enemy.hp / Math.max(1, enemy.maxHp));
      actor.ring.visible = !dead && (enemy.windupMs > 0 || enemy.strikeMs > 0);
      actor.ring.position.set(enemy.aimX, 0.05, enemy.aimZ); actor.ring.scale.setScalar(enemy.kind ? 3.5 : 1.7);
      (actor.ring.material as THREE.MeshBasicMaterial).opacity = enemy.strikeMs > 0 ? 0.5 : 0.08 + 0.21 * (1 - enemy.windupMs / (enemy.kind ? 1100 : 650));
    });
    const targets: InspectionTarget[] = frame.players.flatMap((player, index) => {
      const object = player.active !== false ? this.appearances.inspectionTarget(player.id) : undefined;
      // Nearby current-encounter context is not an asserted attack target. This
      // also frames a boss during its windup while the player is still idle.
      const nearby = enemies.map((enemy, enemyIndex) => ({ enemy, enemyIndex,
        distance: Math.hypot(enemy.x - player.state.x, enemy.z - player.state.z) }))
        .filter(({ enemy, distance }) => enemy.hp > 0 && enemy.group <= (frame.world?.stage ?? 0) && distance <= (enemy.kind ? 18 : 13))
        .sort((a, b) => a.distance - b.distance || a.enemyIndex - b.enemyIndex)[0];
      return object ? [{ id: `player:${player.id}`, label: player.name, player: index, object, forward: signals[player.id]?.facing,
        ...(nearby ? { relatedTargets: [`enemy:${nearby.enemyIndex}`], relationReason: 'nearest-active-encounter-context' } : {}) }] : [];
    });
    this.monsters.forEach((actor, index) => {
      const nearest = frame.players.filter(player => player.active !== false && player.hp > 0)
        .sort((a, b) => Math.hypot(a.state.x - enemies[index].x, a.state.z - enemies[index].z)
          - Math.hypot(b.state.x - enemies[index].x, b.state.z - enemies[index].z))[0];
      if (actor.root.visible) targets.push({ id: `enemy:${index}`, label: enemies[index].kind ? 'Campaign boss' : `Enemy ${index + 1}`,
        object: actor.visual.root, forward: { x: Math.sin(enemies[index].facing), y: 0, z: Math.cos(enemies[index].facing) },
        ...(nearest ? { relatedTargets: [`player:${nearest.id}`], relationReason: 'nearest-living-player-context' } : {}) });
    });
    this.focus.render(this.renderer, this.scene, camera, targets, actualCamera => {
      for (const actor of this.fighters.values()) actor.healthFrame.quaternion.copy(actualCamera.quaternion);
      for (const actor of this.monsters) actor.healthFrame.quaternion.copy(actualCamera.quaternion);
    });
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.appearances.dispose();
    this.terrainDetails?.dispose();
    this.actionTimelines.clear();
    for (const actor of this.fighters.values()) this.removeActor(actor);
    for (const actor of this.monsters) this.removeMonster(actor);
    this.fighters.clear(); this.monsters.length = 0; this.environment.dispose();
    this.scene.clear(); this.renderer.dispose();
  }
}

const createView: CreateView<WorldState, PlayerState, GameTuning> = canvas => new CampaignView(canvas);
export default createView;
