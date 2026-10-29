import {installStarterMedia} from '../sandbox/starterMedia.ts';
installStarterMedia();
import * as THREE from 'three';
import type { CreateView, GameView, InspectionFocus, ReviewCamera, ViewFrame } from '../shared/gameApi.ts';
import { PlayerAppearanceHost } from '../sandbox/playerAppearance.ts';
import { InspectionFocusController, type InspectionTarget } from '../sandbox/inspectionFocus.ts';
import { isInspectionCameraFrameActive, recordInspectionGameplayCamera } from '../sandbox/inspectionCamera.ts';
import { configureShadowRenderer } from '../sandbox/lighting.ts';
import { TerrainWorldView } from '../sandbox/terrainView.ts';
import { arenaActorSignals } from './animations.ts';
import { createArenaActor, ARENA_ACTOR_HEIGHT } from './actor.ts';
import { createArenaTerrainAsset } from './environment.ts';
import { sharedTerrain } from './terrainWorld.ts';
import { prepareTerrainWorld, terrainInterestsFor } from '../sandbox/terrainWorld.ts';
import { registerInspectionTerrain } from '../sandbox/inspectionGeometry.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { aimDirection, aimedChest, eyePosition } from './combat.ts';
import { ArenaHud } from './hud.ts';
import { ObjectPool } from '../sandbox/objectPool.ts';

type Frame = ViewFrame<WorldState, PlayerState, GameTuning>;
type Actor = { root: THREE.Group; model: ReturnType<typeof createArenaActor>; marker: THREE.Mesh; strike: THREE.Mesh };
type Supply = { root: THREE.Group; lid: THREE.Group; beacon: THREE.Mesh };
const PLAYER_COLORS = [0x3b8b95, 0xbd6744, 0x7a76a0, 0xa38a42, 0x568064, 0xa65e72, 0x647caa, 0xa08970];

/** Editable survival arena using the shared terrain, rig, animation and inspection APIs. */
export class ArenaView implements GameView<WorldState, PlayerState, GameTuning> {
  readonly terrainWorld = sharedTerrain;
  private terrainDetails: TerrainWorldView | undefined;
  private terrainRevision = '';
  private zoneRevision = '';
  private zoneRadius = -1;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly actors = new THREE.Group();
  private readonly appearances = new PlayerAppearanceHost(this.actors);
  private readonly focus = new InspectionFocusController();
  private readonly camera = new THREE.PerspectiveCamera(75, 1, .05, 600);
  private readonly hud = new ArenaHud();
  private readonly inspectionCamera = new THREE.PerspectiveCamera(55, 1, .05, 2000);
  private readonly sun = new THREE.DirectionalLight(0xffe2ae, 3.1);
  private readonly cameraTarget = new THREE.Vector3();
  private inspectionActive = false;
  private width = 960;
  private height = 540;
  private facing = 0;
  private reviewCamera: ReviewCamera | null = null;
  private aspect = 1;
  private disposed = false;
  private localPlayer = '';
  private readonly fighters = new Map<string, Actor>();
  private readonly supplies: Supply[] = [];
  private readonly arrows = new Map<string, THREE.Group>();
  private readonly playerIds = new Set<string>();
  private readonly arrowIds = new Set<string>();
  private readonly arrowDirection = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly arrowPool = new ObjectPool<THREE.Group>({
    maxRetained: 128,
    create: () => {
      const root = new THREE.Group();
      const shaft = new THREE.Mesh(this.arrowGeometry, this.arrowMaterial);
      const tip = new THREE.Mesh(this.arrowTipGeometry, this.bandMaterial);
      tip.position.y = .4; root.add(shaft, tip);
      return root;
    },
    reset: root => { root.removeFromParent(); root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.setScalar(1); },
    // Geometry and materials belong to this view and are shared by all arrows.
    dispose: root => { root.removeFromParent(); root.clear(); },
  });
  private readonly arrowGeometry = new THREE.CylinderGeometry(.018, .018, .68, 5);
  private readonly arrowTipGeometry = new THREE.ConeGeometry(.055, .14, 4);
  private readonly arrowMaterial = new THREE.MeshStandardMaterial({ color: 0xc8b992, roughness: .8 });
  private readonly chestGeometry = new THREE.BoxGeometry(1.05, .55, .7);
  private readonly lidGeometry = new THREE.BoxGeometry(1.12, .2, .76);
  private readonly bandGeometry = new THREE.BoxGeometry(.1, .58, .73);
  private readonly beaconGeometry = new THREE.OctahedronGeometry(.14, 0);
  private readonly strikeGeometry = new THREE.RingGeometry(.72, 1, 24, 1, -Math.PI / 2 - .8, 1.6);
  private readonly ringGeometry = new THREE.RingGeometry(.987, 1.013, 256);
  private readonly ringCoordinates = Array.from(this.ringGeometry.getAttribute('position').array);
  private readonly markerGeometry = new THREE.RingGeometry(.55, .65, 32);
  private readonly chestMaterial = new THREE.MeshStandardMaterial({ color: 0x885537, roughness: .88 });
  private readonly lidMaterial = new THREE.MeshStandardMaterial({ color: 0xb97d43, roughness: .82 });
  private readonly bandMaterial = new THREE.MeshStandardMaterial({ color: 0x3c4548, roughness: .6, metalness: .4 });
  private readonly beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xffd28b });
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ color: 0xe6a85b, side: THREE.DoubleSide, transparent: true, opacity: .75, depthWrite: false });
  private readonly markerMaterial = new THREE.MeshBasicMaterial({ color: 0xfaf0bd, transparent: true, opacity: .9, depthWrite: false, depthTest: false });
  private readonly strikeMaterial = new THREE.MeshBasicMaterial({ color: 0xffdea0, side: THREE.DoubleSide, transparent: true, opacity: .6, depthWrite: false });
  private readonly zone = new THREE.Mesh(this.ringGeometry, this.ringMaterial);

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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color(0xbac9bc);
    this.scene.fog = new THREE.Fog(0xbac9bc, 95, 270);
    this.scene.add(new THREE.HemisphereLight(0xdceafb, 0x596343, 1.7));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 300;
    this.sun.shadow.bias = -.00015; this.sun.shadow.normalBias = .035;
    this.scene.add(this.sun, this.sun.target, this.zone, this.actors);
    this.zone.rotation.x = -Math.PI / 2;
    this.zone.position.y = .03;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.hud.resize(this.width, this.height);
    this.aspect = Math.max(1, width) / Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(pixelRatio, 2));
    this.renderer.setSize(width, height, false);
    for (const camera of [this.camera, this.inspectionCamera]) { camera.aspect = this.aspect; camera.updateProjectionMatrix(); }
  }
  setReviewCamera(camera: ReviewCamera | null): void {
    this.reviewCamera = camera;
    // A map-wide inspection sits well above the ordinary follow camera.
    // Keep atmospheric depth without hiding the terrain being reviewed.
    const fog = this.scene.fog as THREE.Fog;
    fog.near = camera ? 260 : 95; fog.far = camera ? 650 : 270;
  }
  setInspectionFocus(focus: InspectionFocus | null): void { this.inspectionActive = !!focus; this.focus.setFocus(focus); }
  inspectionFocus(): Record<string, unknown> { return this.focus.inspection(); }
  info(): Record<string, number> { return { forwardX: Math.sin(this.facing), forwardZ: Math.cos(this.facing), width: this.width, height: this.height }; }
  actorSignals(frame: Frame) { return arenaActorSignals(frame); }
  inspection(): Record<string, unknown> {
    const ordered = [...this.fighters].sort(([a], [b]) => Number(b === this.localPlayer) - Number(a === this.localPlayer));
    return { terrain: this.terrainDetails?.inspection() ?? null, animation: 'humanoid-v1-motion-matching',
      camera: { type: 'first-person', fov: this.camera.fov, near: this.camera.near, position: this.camera.position.toArray() },
      actors: ordered.slice(0, 2).map(([id, actor]) => ({ id, ...actor.model.inspection() })),
      omittedActors: Math.max(0, ordered.length - 2) };
  }

  private createSupply(): Supply {
    const root = new THREE.Group(), lid = new THREE.Group();
    const body = new THREE.Mesh(this.chestGeometry, this.chestMaterial), top = new THREE.Mesh(this.lidGeometry, this.lidMaterial);
    body.position.y = .29; top.position.set(0, .08, .34); lid.position.set(0, .58, -.34);
    root.add(body, lid); lid.add(top);
    for (const x of [-.35, .35]) { const band = new THREE.Mesh(this.bandGeometry, this.bandMaterial); band.position.set(x, .3, 0); root.add(band); }
    const beacon = new THREE.Mesh(this.beaconGeometry, this.beaconMaterial); beacon.position.y = 1.12; root.add(beacon);
    root.traverse(object => { if (object instanceof THREE.Mesh) object.castShadow = object.receiveShadow = true; });
    this.actors.add(root); return { root, lid, beacon };
  }

  update(frame: Frame): void {
    if (this.disposed) return;
    prepareTerrainWorld(sharedTerrain, frame.tuning, terrainInterestsFor(frame.players));
    const { tuning, world } = frame, terrain = sharedTerrain.read(tuning);
    registerInspectionTerrain(this.scene, terrain);
    if (world) terrain.assertRevision(world.terrainRevision);
    if (this.terrainRevision !== terrain.loadedRevision) {
      if (this.terrainDetails) this.terrainDetails.update(terrain);
      else { this.terrainDetails = new TerrainWorldView(terrain, { assetFactory: createArenaTerrainAsset }); this.scene.add(this.terrainDetails.root); }
      this.terrainRevision = terrain.loadedRevision;
    }
    const signals = this.actorSignals(frame), zoneRadius = Math.max(.001, world?.zoneRadius ?? tuning.arenaRadius);
    if (this.zoneRevision !== terrain.loadedRevision || this.zoneRadius !== zoneRadius) {
      const positions = this.ringGeometry.getAttribute('position');
      for (let index = 0; index < positions.count; index++) {
        const x = this.ringCoordinates[index * 3] * zoneRadius, y = this.ringCoordinates[index * 3 + 1] * zoneRadius;
        // Distant, ungenerated sections are only a zone indicator, not a
        // fabricated terrain sample. Resident sections follow the real surface.
        positions.setXYZ(index, x, y, terrain.available(x, -y) ? terrain.sample(x, -y).height : 0);
      }
      positions.needsUpdate = true; this.ringGeometry.computeBoundingSphere();
      this.zoneRevision = terrain.loadedRevision; this.zoneRadius = zoneRadius;
    }
    this.zone.visible = frame.mode === 'battle-royale' && !world?.zoneClosed;
    this.actors.visible = world !== null;
    this.localPlayer = frame.players.find(player => player.isLocal)?.id ?? '';
    this.playerIds.clear();
    for (const player of frame.players) this.playerIds.add(player.id);
    for (const [id, actor] of this.fighters) if (!this.playerIds.has(id)) {
      this.appearances.remove(id); actor.root.removeFromParent(); actor.model.dispose(); this.fighters.delete(id);
    }
    frame.players.forEach((player, index) => {
      let actor = this.fighters.get(player.id);
      if (!actor) {
        const root = new THREE.Group(), model = createArenaActor(PLAYER_COLORS[index % PLAYER_COLORS.length]);
        const marker = new THREE.Mesh(this.markerGeometry, this.markerMaterial), strike = new THREE.Mesh(this.strikeGeometry, this.strikeMaterial);
        marker.rotation.x = strike.rotation.x = -Math.PI / 2;
        marker.renderOrder = 50; marker.position.y = .06;
        root.add(model.root, marker, strike); this.actors.add(root);
        actor = { root, model, marker, strike }; this.fighters.set(player.id, actor);
      }
      const state = player.state, alive = player.active !== false && player.hp > 0;
      actor.root.visible = alive; actor.root.position.set(state.x, state.y, state.z); actor.root.rotation.y = state.facing;
      actor.model.root.scale.setScalar(tuning.fighterHeight / ARENA_ACTOR_HEIGHT);
      if (alive) actor.model.update(signals[player.id], { weapon: state.weapon, equipped: state.equipped,
        armorFace: state.armorFace, armorChest: state.armorChest, armorLegs: state.armorLegs, armorArms: state.armorArms,
        local: player.isLocal, terrain });
      actor.marker.visible = player.isLocal && (this.inspectionActive || !!this.reviewCamera);
      const reach = state.equipped === 1 ? tuning.weaponReach : tuning.attackReach;
      const strikePhase = 1 - state.attackMs / tuning.attackDurationMs;
      actor.strike.visible = alive && state.attackMs > 0 && state.attackWeapon !== 2 && strikePhase >= .25 && strikePhase < .65
        && (!player.isLocal || this.inspectionActive || !!this.reviewCamera);
      actor.strike.position.set(0, .1, reach * .55); actor.strike.scale.setScalar(reach * .45);
      this.appearances.update(player.id, actor.model.root, state, alive);
    });
    const supplies = world?.supplies ?? [];
    while (this.supplies.length < supplies.length) this.supplies.push(this.createSupply());
    this.supplies.forEach(({ root, lid, beacon }, index) => {
      const supply = supplies[index]; root.visible = !!supply && terrain.available(supply.x, supply.z);
      if (!supply) return;
      root.position.set(supply.x, supply.y, supply.z);
      root.rotation.y = Math.atan2(-supply.x, -supply.z);
      lid.rotation.x = supply.claimedBy >= 0 ? -1.15 : 0;
      beacon.visible = supply.claimedBy < 0;
      beacon.rotation.y = frame.now / 900;
      beacon.position.y = 1.12 + Math.sin(frame.now / 450 + index) * .08;
    });
    this.arrowIds.clear();
    for (const arrow of world?.arrows ?? []) this.arrowIds.add(arrow.id);
    for (const [id, arrow] of this.arrows) if (!this.arrowIds.has(id)) { this.arrowPool.release(arrow); this.arrows.delete(id); }
    for (const arrow of world?.arrows ?? []) {
      let object = this.arrows.get(arrow.id);
      if (!object) {
        object = this.arrowPool.acquire();
        this.actors.add(object); this.arrows.set(arrow.id, object);
      }
      object.position.set(arrow.x, arrow.y, arrow.z);
      object.quaternion.setFromUnitVectors(this.up, this.arrowDirection.set(arrow.vx, arrow.vy, arrow.vz).normalize());
    }
    const local = frame.players.find(player => player.isLocal && player.active !== false && player.hp > 0);
    const followed = local ?? frame.players.find(player => player.active !== false && player.hp > 0);
    // Position comes from the already-predicted/smoothed frame. Extra follow lag
    // here would slide the eye through nearby walls and make mouse look sluggish.
    if (followed) {
      const eye = eyePosition(followed.state, tuning), direction = aimDirection(followed.state);
      this.facing = followed.state.facing;
      this.camera.position.set(eye.x, eye.y, eye.z);
      this.cameraTarget.copy(this.camera.position);
      this.camera.lookAt(eye.x + direction.x, eye.y + direction.y, eye.z + direction.z);
    } else {
      this.cameraTarget.set(0, terrain.sample(0, 0).height, 0);
      this.camera.position.set(this.cameraTarget.x, this.cameraTarget.y + 22, this.cameraTarget.z + 25); this.camera.lookAt(this.cameraTarget);
    }
    const extent = this.reviewCamera ? tuning.arenaRadius * 1.2 : 36;
    const shadowX = Math.round(this.cameraTarget.x * 16) / 16, shadowZ = Math.round(this.cameraTarget.z * 16) / 16;
    this.sun.target.position.set(shadowX, this.cameraTarget.y, shadowZ);
    this.sun.position.set(shadowX - 60, this.cameraTarget.y + 115, shadowZ + 45);
    Object.assign(this.sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent });
    this.sun.shadow.camera.updateProjectionMatrix();
    if (this.reviewCamera) {
      const review = this.reviewCamera;
      this.inspectionCamera.position.set(review.x, review.y, review.z);
      this.inspectionCamera.rotation.set(review.pitch, review.yaw, 0, 'YXZ');
      this.inspectionCamera.fov = review.fov; this.inspectionCamera.updateProjectionMatrix();
    }
    const targets: InspectionTarget[] = [];
    for (let index = 0; index < frame.players.length; index++) {
      const player = frame.players[index];
      const object = world && player.active !== false && player.hp > 0 ? this.appearances.inspectionTarget(player.id) : undefined;
      if (!object) continue;
      const chest = world ? aimedChest(world, player.state, tuning) : undefined;
      // Preserve the first nearest match on ties without allocating and sorting
      // all player pairs every render. A targeted chest already wins this context.
      let nearby: Frame['players'][number] | undefined, nearest = Infinity;
      if (!chest) {
        const sin = Math.sin(player.state.facing), cos = Math.cos(player.state.facing);
        for (const other of frame.players) {
          if (other.id === player.id || other.active === false || !(other.hp > 0)) continue;
          const dx = other.state.x - player.state.x, dz = other.state.z - player.state.z, distance = Math.hypot(dx, dz);
          if (distance > .01 && distance <= 12 && distance < nearest && (dx * sin + dz * cos) / distance > .65) {
            nearby = other; nearest = distance;
          }
        }
      }
      targets.push({ id: `player:${player.id}`, label: player.name, player: index, object, forward: signals[player.id]?.facing,
        ...(chest && world ? { relatedTargets: [`supply:${world.supplies.indexOf(chest)}`], relationReason: 'aimed-chest-context' }
          : nearby ? { relatedTargets: [`player:${nearby.id}`], relationReason: 'nearby-player-in-aim-cone-context' } : {}) });
    }
    this.supplies.forEach(({ root }, index) => {
      if (world && world.supplies[index]) targets.push({ id: `supply:${index}`, label: `Supply chest ${index + 1}`, object: root });
    });
    const inspecting = this.inspectionActive || !!this.reviewCamera;
    if (isInspectionCameraFrameActive()) {
      const measure = () => recordInspectionGameplayCamera(this.scene, this.camera, true, followed?.id);
      if (followed) this.appearances.withFirstPersonBody(followed.id, this.camera, measure);
      else measure();
    }
    const renderWorld = () => this.focus.render(this.renderer, this.scene, this.reviewCamera ? this.inspectionCamera : this.camera, targets);
    if (followed && !inspecting) this.appearances.withFirstPersonBody(followed.id, this.camera, renderWorld);
    else renderWorld();
    if (!inspecting) {
      const me = frame.players.find(player => player.isLocal);
      const alive = frame.players.filter(player => player.active !== false && player.hp > 0).length;
      const chest = local && world ? aimedChest(world, local.state, tuning) : undefined;
      const lines = [frame.mode === 'battle-royale' ? `${alive} survivors${me?.hp === 0 ? ' · Spectating' : ''}`
          : frame.mode === 'duel' ? 'Duel · Defeat your opponent' : frame.mode === 'rpg' ? 'RPG · Explore together' : 'Just Chatting',
        frame.phase === 'ended' ? 'Round complete' : !world || frame.mode !== 'battle-royale' ? '' : world.zoneClosed ? 'No safe ground remains' : world.elapsedMs < tuning.zoneDelayMs
          ? `Zone shrinks in ${Math.ceil((tuning.zoneDelayMs - world.elapsedMs) / 1000)}s` : `Safe zone ${Math.ceil(world.zoneRadius)}m`,
        chest ? chest.loot ? 'Chest ahead · Open it for loot' : 'Empty chest' : ''];
      this.hud.update(world ? me?.state : undefined, world, me?.hp ?? 0, me?.maxHp ?? tuning.maxHp, lines, tuning.bandageDurationMs); this.hud.render(this.renderer);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.terrainDetails?.dispose(); this.appearances.dispose();
    for (const actor of this.fighters.values()) actor.model.dispose();
    this.fighters.clear(); this.arrowPool.dispose(); this.actors.clear(); this.supplies.length = 0; this.arrows.clear(); this.hud.dispose();
    this.playerIds.clear(); this.arrowIds.clear();
    for (const geometry of [this.chestGeometry, this.lidGeometry, this.bandGeometry, this.beaconGeometry, this.strikeGeometry, this.ringGeometry, this.markerGeometry, this.arrowGeometry, this.arrowTipGeometry]) geometry.dispose();
    for (const material of [this.chestMaterial, this.lidMaterial, this.bandMaterial, this.beaconMaterial, this.ringMaterial, this.markerMaterial, this.strikeMaterial, this.arrowMaterial]) material.dispose();
    this.sun.shadow.dispose(); this.sun.dispose(); this.scene.clear(); this.renderer.dispose();
  }
}
const createView: CreateView<WorldState, PlayerState, GameTuning> = canvas => new ArenaView(canvas);
export default createView;
