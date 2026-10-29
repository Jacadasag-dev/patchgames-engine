import * as THREE from 'three';
import type { CreateView, GameView, InspectionFocus, ReviewCamera, ViewFrame } from '../shared/gameApi.ts';
import { PlayerAppearanceHost } from '../sandbox/playerAppearance.ts';
import { InspectionFocusController, type InspectionTarget } from '../sandbox/inspectionFocus.ts';
import { isInspectionCameraFrameActive, recordInspectionGameplayCamera } from '../sandbox/inspectionCamera.ts';
import { configureShadowRenderer } from '../sandbox/lighting.ts';
import { GROUND } from './ground.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';

type Frame = ViewFrame<WorldState, PlayerState, GameTuning>;
interface Avatar { root: THREE.Group; body: THREE.Mesh; nose: THREE.Mesh; geometryKey: string }
const PLAYER_COLORS = [0x3b8b95, 0xbd6744, 0x7a76a0, 0xa38a42, 0x568064, 0xa65e72, 0x647caa, 0xa08970];
const FOLLOW_DISTANCE = 4.5;

/** A blank canvas: daylight, a flat floor with a grid, and one capsule per
 * participant. Installed appearance features replace the capsules; everything
 * else is yours to add through the shared Three.js scene. */
export class BlankView implements GameView<WorldState, PlayerState, GameTuning> {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly actors = new THREE.Group();
  private readonly appearances = new PlayerAppearanceHost(this.actors);
  private readonly focus = new InspectionFocusController();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, .05, 400);
  private readonly inspectionCamera = new THREE.PerspectiveCamera(55, 1, .05, 1000);
  private readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  private readonly target = new THREE.Vector3();
  private readonly avatars = new Map<string, Avatar>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  private reviewCamera: ReviewCamera | null = null;
  private facing = 0;
  private width = 960;
  private height = 540;
  private disposed = false;

  readonly featureHost = {
    add: (object: unknown) => {
      if (!(object instanceof THREE.Object3D)) throw new Error('Feature visuals must be Three.js objects.');
      this.actors.add(object);
    },
    remove: (object: unknown) => { if (object instanceof THREE.Object3D) object.removeFromParent(); },
    setPlayerAppearance: (id: string, object: unknown | null) => this.appearances.setPlayerAppearance(id, object),
    setInspectionTarget: (id: string, object: unknown | null, label?: string, relatedTargets?: readonly string[]) => this.focus.setTarget(id, object, label, relatedTargets),
  };

  constructor(canvas: OffscreenCanvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    configureShadowRenderer(this.renderer);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color(0xcfdcea);
    this.scene.fog = new THREE.Fog(0xcfdcea, 60, 160);
    this.scene.add(new THREE.HemisphereLight(0xe3ecfa, 0x8c8477, 1.4));
    this.sun.position.set(18, 30, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 90;
    const span = GROUND.halfExtent + 4;
    this.sun.shadow.camera.left = -span; this.sun.shadow.camera.right = span;
    this.sun.shadow.camera.top = span; this.sun.shadow.camera.bottom = -span;
    this.sun.shadow.bias = -.0002; this.sun.shadow.normalBias = .03;
    const size = GROUND.halfExtent * 2;
    this.ground = new THREE.Mesh(new THREE.BoxGeometry(size, GROUND.thickness, size),
      new THREE.MeshStandardMaterial({ color: 0x9aa39c, roughness: .95 }));
    this.ground.position.y = -GROUND.thickness / 2;
    this.ground.receiveShadow = true;
    this.grid = new THREE.GridHelper(size, size / 2, 0x6d7a72, 0x8f9a93);
    this.grid.position.y = .01;
    this.scene.add(this.sun, this.sun.target, this.ground, this.grid, this.actors);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(pixelRatio, 2));
    this.renderer.setSize(width, height, false);
    for (const camera of [this.camera, this.inspectionCamera]) { camera.aspect = this.width / this.height; camera.updateProjectionMatrix(); }
  }
  setReviewCamera(camera: ReviewCamera | null): void { this.reviewCamera = camera; }
  setInspectionFocus(focus: InspectionFocus | null): void { this.focus.setFocus(focus); }
  inspectionFocus(): Record<string, unknown> { return this.focus.inspection(); }
  info(): Record<string, number> { return { forwardX: Math.sin(this.facing), forwardZ: Math.cos(this.facing), width: this.width, height: this.height }; }
  inspection(): Record<string, unknown> {
    return { content: 'blank-canvas', ground: { halfExtent: GROUND.halfExtent }, actors: this.avatars.size,
      camera: { type: 'third-person', fov: this.camera.fov, position: this.camera.position.toArray() } };
  }

  private geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geometry = this.geometries.get(key);
    if (!geometry) { geometry = create(); this.geometries.set(key, geometry); }
    return geometry;
  }
  private material(color: number): THREE.MeshStandardMaterial {
    let material = this.materials.get(color);
    if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: .6 }); this.materials.set(color, material); }
    return material;
  }
  /** Capsule bodies follow live tuning so radius and height edits show immediately. */
  private shapeAvatar(avatar: Avatar, tuning: GameTuning): void {
    const key = `${tuning.fighterRadius}:${tuning.fighterHeight}`;
    if (avatar.geometryKey === key) return;
    const radius = Math.max(.05, tuning.fighterRadius), height = Math.max(radius * 2.01, tuning.fighterHeight);
    avatar.body.geometry = this.geometry(`capsule:${key}`, () => new THREE.CapsuleGeometry(radius, height - radius * 2, 4, 16));
    avatar.body.position.y = height / 2;
    avatar.nose.position.set(0, height * .82, radius);
    avatar.geometryKey = key;
  }
  private makeAvatar(index: number): Avatar {
    const root = new THREE.Group(), color = PLAYER_COLORS[index % PLAYER_COLORS.length];
    const body = new THREE.Mesh(undefined, this.material(color));
    const nose = new THREE.Mesh(this.geometry('nose', () => new THREE.BoxGeometry(.12, .12, .16)), this.material(0x2a2d33));
    body.castShadow = body.receiveShadow = true; nose.castShadow = true;
    root.add(body, nose); this.actors.add(root);
    return { root, body, nose, geometryKey: '' };
  }
  private removeAvatar(id: string, avatar: Avatar): void {
    avatar.root.removeFromParent();
    this.appearances.setPlayerAppearance(id, null);
    this.avatars.delete(id);
  }

  update(frame: Frame): void {
    if (this.disposed) return;
    for (const [id, avatar] of this.avatars) if (!frame.players.some(player => player.id === id && player.active !== false)) this.removeAvatar(id, avatar);
    frame.players.forEach((player, index) => {
      if (player.active === false) return;
      let avatar = this.avatars.get(player.id);
      if (!avatar) { avatar = this.makeAvatar(index); this.avatars.set(player.id, avatar); }
      this.shapeAvatar(avatar, frame.tuning);
      const state = player.state, alive = player.hp > 0;
      avatar.root.position.set(state.x, state.y, state.z);
      avatar.root.rotation.y = state.facing;
      this.appearances.update(player.id, avatar.body, state, alive, alive);
      avatar.nose.visible = alive;
    });
    const local = frame.players.find(player => player.isLocal && player.active !== false), state = local?.state;
    if (state) {
      this.facing = state.facing;
      const eye = frame.tuning.fighterHeight * .9;
      this.target.set(state.x, state.y + eye, state.z);
      const forwardX = Math.sin(state.facing), forwardZ = Math.cos(state.facing), pitch = state.aimPitch;
      const back = Math.cos(pitch) * FOLLOW_DISTANCE, rise = -Math.sin(pitch) * FOLLOW_DISTANCE;
      this.camera.position.set(this.target.x - forwardX * back, Math.max(.3, this.target.y + rise), this.target.z - forwardZ * back);
      this.camera.lookAt(this.target);
    } else {
      const distance = this.width < this.height ? 30 * this.height / this.width : 30;
      this.camera.position.set(0, distance * .7, distance * .8); this.camera.lookAt(0, 0, 0);
    }
    if (this.reviewCamera) {
      const review = this.reviewCamera;
      this.inspectionCamera.position.set(review.x, review.y, review.z);
      this.inspectionCamera.rotation.set(review.pitch, review.yaw, 0, 'YXZ');
      this.inspectionCamera.fov = review.fov; this.inspectionCamera.updateProjectionMatrix();
    }
    const camera = this.reviewCamera ? this.inspectionCamera : this.camera;
    const targets: InspectionTarget[] = frame.players.flatMap((player, index) => {
      const object = player.active !== false && player.hp > 0 ? this.appearances.inspectionTarget(player.id) : undefined;
      return object ? [{ id: `player:${player.id}`, label: player.name, player: index, object }] : [];
    });
    if (isInspectionCameraFrameActive()) recordInspectionGameplayCamera(this.scene, this.camera, true, local?.id);
    this.focus.render(this.renderer, this.scene, camera, targets);
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const [id, avatar] of this.avatars) this.removeAvatar(id, avatar);
    this.appearances.dispose();
    this.geometries.forEach(geometry => geometry.dispose()); this.materials.forEach(material => material.dispose());
    this.ground.geometry.dispose(); (this.ground.material as THREE.Material).dispose(); this.grid.dispose();
    this.scene.clear(); this.renderer.dispose();
  }
}
const createView: CreateView<WorldState, PlayerState, GameTuning> = canvas => new BlankView(canvas);
export default createView;
