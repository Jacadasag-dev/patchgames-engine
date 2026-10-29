import * as THREE from 'three';
import type { GameView, InspectionFocus, ReviewCamera, ViewFrame } from '../../shared/gameApi.ts';
import type { FighterState, WorldState } from '../shapes.ts';
import type { GameTuning } from '../tuning.ts';
import { MedievalArena } from './arena.ts';
import { FightCamera } from './camera.ts';
import { FighterView } from './fighter.ts';
import { DuelHud } from './hud.ts';
import { DuelAudio } from './audio.ts';
import { PlayerAppearanceHost } from '../../sandbox/playerAppearance.ts';
import { InspectionFocusController } from '../../sandbox/inspectionFocus.ts';
import { isInspectionCameraFrameActive, recordInspectionGameplayCamera } from '../../sandbox/inspectionCamera.ts';
import { configureShadowRenderer } from '../../sandbox/lighting.ts';
import type { ActorPresentationSignals } from '../../sandbox/animation.ts';
import { sharedTerrain } from '../terrainWorld.ts';
import { prepareTerrainWorld, terrainInterestsFor } from '../../sandbox/terrainWorld.ts';
import { registerInspectionTerrain } from '../../sandbox/inspectionGeometry.ts';
import { TerrainWorldView } from '../../sandbox/terrainView.ts';
import { ObjectPool } from '../../sandbox/objectPool.ts';

type Frame = ViewFrame<WorldState, FighterState, GameTuning>;
const ACTIONS = ['idle', 'light', 'heavy', 'charging', 'bash', 'recovery', 'stunned', 'dodge'];

export class DuelView implements GameView<WorldState, FighterState, GameTuning> {
  readonly terrainWorld = sharedTerrain;
  private terrainDetails?: TerrainWorldView;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly actors = new THREE.Group();
  private readonly appearances = new PlayerAppearanceHost(this.actors);
  private readonly focus = new InspectionFocusController();
  private readonly fightCamera = new FightCamera();
  private readonly hud = new DuelHud();
  private readonly audio = new DuelAudio();
  private readonly fighters = new Map<string, FighterView>();
  private arena?: MedievalArena;
  private arenaRadius = 0;
  private readonly inspectionCamera = new THREE.PerspectiveCamera(55, 1, .05, 2000);
  private readonly sparks = new THREE.Group();
  private readonly sparkGeometry = new THREE.OctahedronGeometry(.04, 0);
  private readonly sparkMaterials = [0xffce6e, 0xa5e9ff, 0xde6e43].map(color => new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
  private readonly feedback = new Map<string, number>();
  private readonly bursts: { root: THREE.Group; started: number; color: number }[] = [];
  private readonly burstPool = new ObjectPool<THREE.Group>({
    maxRetained: 32,
    create: () => {
      const root = new THREE.Group();
      for (let i = 0; i < 10; i++) root.add(new THREE.Mesh(this.sparkGeometry, this.sparkMaterials[0]));
      return root;
    },
    reset: root => { root.removeFromParent(); root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.setScalar(1); },
    dispose: root => { root.removeFromParent(); root.clear(); },
  });
  private reviewCamera: ReviewCamera | null = null;
  readonly featureHost = {
    add: (object: unknown) => { if (!(object instanceof THREE.Object3D)) throw new Error('Feature visuals must be Three.js objects.'); this.actors.add(object); },
    remove: (object: unknown) => { if (object instanceof THREE.Object3D) this.actors.remove(object); },
    setPlayerAppearance: (id: string, object: unknown | null) => this.appearances.setPlayerAppearance(id, object),
    setInspectionTarget: (id: string, object: unknown | null, label?: string, relatedTargets?: readonly string[]) => this.focus.setTarget(id, object, label, relatedTargets),
  };
  constructor(canvas: OffscreenCanvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); configureShadowRenderer(this.renderer);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.1;
    this.scene.background = new THREE.Color(0x9faeae); this.scene.fog = new THREE.Fog(0x9faeae, 30, 85);
    this.scene.add(new THREE.HemisphereLight(0xdce8eb, 0x665d43, 2.15));
    const sun = new THREE.DirectionalLight(0xffe0aa, 3.15); sun.position.set(-9, 16, 7); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = sun.shadow.camera.bottom = -19; sun.shadow.camera.right = sun.shadow.camera.top = 19;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 60; sun.shadow.bias = -.0002; sun.shadow.normalBias = .025;
    this.scene.add(sun, sun.target, this.actors, this.sparks);
  }
  setReviewCamera(camera: ReviewCamera | null): void { this.reviewCamera = camera; }
  setInspectionFocus(focus: InspectionFocus | null): void { this.focus.setFocus(focus); }
  inspectionFocus(): Record<string, unknown> { return this.focus.inspection(); }
  resize(width: number, height: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(Math.min(pixelRatio, 2)); this.renderer.setSize(width, height, false); this.hud.resize(width, height); this.fightCamera.resize(width, height);
    this.inspectionCamera.aspect = width / Math.max(1, height); this.inspectionCamera.updateProjectionMatrix();
  }
  info(): Record<string, number> { const forward = this.fightCamera.forward(); return { forwardX: forward.x, forwardZ: forward.z }; }
  actorSignals(frame: Frame): Record<string, ActorPresentationSignals> {
    return Object.fromEntries(frame.players.map(player => {
      const s = player.state, down = player.hp <= 0 || player.active === false;
      const position = { x: s.x, y: s.y, z: s.z };
      const terrain = sharedTerrain.read(frame.tuning), ground = terrain.sample(s.x, s.z);
      return [player.id, { id: player.id, timeMs: frame.now, epoch: `duel:${frame.phase}:${frame.world?.terrainRevision ?? ''}`,
        position, facing: { x: Math.sin(s.facing), y: 0, z: Math.cos(s.facing) }, up: { x: 0, y: 1, z: 0 },
        velocity: down ? { x: 0, y: 0, z: 0 } : { x: s.velocityX, y: s.velocityY, z: s.velocityZ }, grounded: s.grounded > 0,
        intendedVelocity: down ? { x: 0, y: 0, z: 0 } : { x: s.intentX, y: 0, z: s.intentZ },
        supports: s.grounded > 0 && ground ? { ground: { position: { x: s.x, y: ground.height, z: s.z }, normal: ground.normal, observedAtMs: frame.now } } : undefined,
        posture: down ? 'downed' : s.combat.isBlocking ? 'blocking' : 'standing',
        parameters: { guard: s.combat.guard, attackGuard: s.combat.attackGuard, actionCode: ACTIONS.indexOf(s.combat.attackState),
          remaining: s.combat.actionMs, duration: s.combat.actionDurationMs, attacking: ['light', 'heavy', 'bash'].includes(s.combat.attackState),
          blocking: s.combat.isBlocking, attackDurationMs: s.combat.actionDurationMs, attackRemainingMs: s.combat.actionMs, attackId: s.combat.attackSeq,
          charge: s.combat.chargeMs / frame.tuning.heavyChargeMs, sprint: s.combat.sprint, active: !down },
      } satisfies ActorPresentationSignals];
    }));
  }
  inspection(): Record<string, unknown> { return { arena: this.arena?.inspection() ?? null, terrain: this.terrainDetails?.inspection() ?? null,
    camera: { type: 'close-third-person', position: this.fightCamera.camera.position.toArray() },
    actors: [...this.fighters].slice(0, 4).map(([id, actor]) => ({ id, ...actor.inspection() })),
    audio: { recipes: ['light', 'heavy', 'charging', 'bash', 'block', 'parry', 'hiltCounter', 'hit', 'dodge'], source: 'procedural-sound-recipes' } }; }
  update(frame: Frame): void {
    prepareTerrainWorld(sharedTerrain, frame.tuning, terrainInterestsFor(frame.players));
    const terrain = sharedTerrain.read(frame.tuning); registerInspectionTerrain(this.scene, terrain);
    if (frame.world) terrain.assertRevision(frame.world.terrainRevision);
    if (!this.arena || this.arenaRadius !== frame.tuning.arenaRadius) {
      this.arena?.dispose(); this.arena = new MedievalArena(frame.tuning.arenaRadius); this.arenaRadius = frame.tuning.arenaRadius; this.scene.add(this.arena.root);
      this.terrainDetails?.dispose(); this.terrainDetails = new TerrainWorldView(terrain, { surface: false }); this.scene.add(this.terrainDetails.root);
    }
    this.arena.update(frame.now); this.terrainDetails?.update(terrain); this.actors.visible = frame.world !== null;
    const shown = frame.world ? frame.players.filter(p => p.active !== false) : [];
    const signals = this.actorSignals(frame);
    for (const [id, fighter] of this.fighters) if (!shown.some(p => p.id === id)) { this.appearances.remove(id); fighter.dispose(); this.fighters.delete(id); this.feedback.delete(id); }
    for (const player of shown) {
      let fighter = this.fighters.get(player.id);
      if (!fighter) { fighter = new FighterView(player.isLocal ? 0x285b75 : 0x8c352c); this.fighters.set(player.id, fighter); this.actors.add(fighter.root); }
      fighter.update(player.state, player.hp, frame.tuning.fighterHeight, signals[player.id], frame.tuning.heavyChargeMs);
      this.appearances.update(player.id, fighter.root, { x: player.state.x, y: player.state.y, z: player.state.z, facing: player.state.facing }, true, true);
      const s = player.state, prior = this.feedback.get(player.id);
      if (prior !== undefined && prior !== s.combat.feedbackSeq && s.combat.feedbackMs > 0) {
        const root = this.burstPool.acquire(), color = s.combat.actionFeedback === 'parry' ? 1 : s.combat.actionFeedback === 'hit' ? 2 : 0;
        root.position.set(s.x + Math.sin(s.facing) * .5, s.y + 1.25, s.z + Math.cos(s.facing) * .5);
        for (const spark of root.children) (spark as THREE.Mesh).material = this.sparkMaterials[color];
        this.sparks.add(root); this.bursts.push({ root, started: frame.now, color });
      }
      this.feedback.set(player.id, s.combat.feedbackSeq);
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i], age = (frame.now - burst.started) / 1000;
      if (age > .4 || age < 0) { this.burstPool.release(burst.root); this.bursts.splice(i, 1); continue; }
      burst.root.children.forEach((spark, n) => { const a = n * Math.PI * .7639; spark.position.set(Math.cos(a) * age * 2.2, Math.sin(a) * age * 2 - age * age * 4, Math.sin(n * 2.1) * age * 1.5); spark.scale.setScalar(1 - age / .4); });
    }
    if (frame.world) this.audio.update(frame.world.elapsedMs, shown);
    this.fightCamera.update(frame);
    const gameplay = this.fightCamera.camera, followed = shown.find(p => p.isLocal) ?? shown[0];
    if (isInspectionCameraFrameActive()) recordInspectionGameplayCamera(this.scene, gameplay, false, followed?.id);
    let camera = gameplay;
    if (this.reviewCamera) { const p = this.reviewCamera; camera = this.inspectionCamera; camera.position.set(p.x, p.y, p.z); camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ'); camera.fov = p.fov; camera.updateProjectionMatrix(); }
    this.focus.render(this.renderer, this.scene, camera, shown.flatMap((player, index) => {
      const object = this.appearances.inspectionTarget(player.id), fighter = this.fighters.get(player.id);
      return object ? [{ id: `player:${player.id}`, label: player.name, player: index, object: object === fighter?.root ? fighter.body.root : object,
        forward: signals[player.id]?.facing, relatedTargets: shown.filter(p => p.id !== player.id).slice(0, 1).map(p => `player:${p.id}`), relationReason: 'duel-participant' }] : [];
    }));
    if (!this.reviewCamera && !this.focus.active && frame.world && ['fighting', 'countdown'].includes(frame.phase)) {
      this.hud.update(followed?.state, shown.find(p => p.id !== followed?.id)?.state, frame.tuning.heavyChargeMs); this.hud.render(this.renderer);
    }
  }
  dispose(): void {
    this.burstPool.dispose(); this.bursts.length = 0;
    this.terrainDetails?.dispose(); this.appearances.dispose(); for (const fighter of this.fighters.values()) fighter.dispose();
    this.arena?.dispose(); this.hud.dispose(); this.sparkGeometry.dispose(); this.sparkMaterials.forEach(material => material.dispose()); this.renderer.dispose();
  }
}
