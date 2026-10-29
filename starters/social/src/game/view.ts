import {installStarterMedia} from '../sandbox/starterMedia.ts';
installStarterMedia();
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import type { CreateView, GameView, InspectionFocus, ReviewCamera, ViewFrame } from '../shared/gameApi.ts';
import { PlayerAppearanceHost } from '../sandbox/playerAppearance.ts';
import { InspectionFocusController, type InspectionTarget } from '../sandbox/inspectionFocus.ts';
import { isInspectionCameraFrameActive, recordInspectionGameplayCamera } from '../sandbox/inspectionCamera.ts';
import { LightingRig, configureShadowRenderer } from '../sandbox/lighting.ts';
import { createRecipeMaterial, type RecipeMaterial } from '../sandbox/materialRecipes.ts';
import { prepareTerrainWorld, terrainInterestsFor, type TerrainWorldSnapshot } from '../sandbox/terrainWorld.ts';
import { registerInspectionTerrain } from '../sandbox/inspectionGeometry.ts';
import { TerrainWorldView } from '../sandbox/terrainView.ts';
import { createLoungeActor, loungeActorSignals } from './animations.ts';
import { DRESSING_AREA, LOUNGE, SEATING, TABLES, furniture, seats, type Furniture } from './layout.ts';
import { MODEL_PALETTES } from './models.ts';
import { CARD_COLORS, cardColor, cardValue } from './socialGames.ts';
import { LoungeOverlay } from './loungeOverlay.ts';
import type { PlayerState, WorldState, TableState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';

type Frame = ViewFrame<WorldState, PlayerState, GameTuning>;
type Guest = { root: THREE.Group; actor: ReturnType<typeof createLoungeActor>; avatar: THREE.Group; modelId: string;
  name: THREE.Sprite; canvas: OffscreenCanvas; texture: THREE.CanvasTexture<OffscreenCanvas>; text: string };
const COLORS = { wall: 0x606578, walnut: 0x634339, dark: 0x202333, brass: 0xbb9770,
  cream: 0xe1cdb1, warm: 0xffd2a0, lilac: 0xb29de7, mint: 0x91cfc0 };

/** Afterglow: an editable social room, built entirely through shared authoring APIs. */
export class LoungeView implements GameView<WorldState, PlayerState, GameTuning> {
  readonly terrainWorld = sharedTerrain;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly actors = new THREE.Group();
  private readonly shell = new THREE.Group();
  private readonly appearances = new PlayerAppearanceHost(this.actors);
  private readonly lighting = new LightingRig(this.scene, { maxShadowLights: 4, shadowMapSize: 1024 });
  private readonly focus = new InspectionFocusController();
  private readonly overlay = new LoungeOverlay();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, .04, 180);
  private readonly inspectionCamera = new THREE.PerspectiveCamera(55, 1, .05, 1000);
  private readonly guests = new Map<string, Guest>();
  private readonly furnitureTargets = new Map<string, THREE.Group>();
  private readonly tableDisplays = new Map<number, { canvas: OffscreenCanvas; texture: THREE.CanvasTexture<OffscreenCanvas>; key: string }>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly recipes: RecipeMaterial[] = [];
  private readonly plaster: THREE.Mesh[] = [];
  private terrainSnapshot?: TerrainWorldSnapshot;
  private terrainDetails?: TerrainWorldView;
  private mirror!: Reflector;
  private reflectedPlayerId: string | null = null;
  private modelSwitcherAvailable = false;
  private reviewCamera: ReviewCamera | null = null;
  private aspect = 1;
  private disposed = false;
  readonly featureHost = {
    add: (object: unknown) => { if (!(object instanceof THREE.Object3D)) throw new Error('Feature visuals require a Three.js object.'); this.actors.add(object); },
    remove: (object: unknown) => { if (object instanceof THREE.Object3D) object.removeFromParent(); },
    setPlayerAppearance: (id: string, object: unknown | null) => this.appearances.setPlayerAppearance(id, object),
    setInspectionTarget: (id: string, object: unknown | null, label?: string, relatedTargets?: readonly string[]) => this.focus.setTarget(id, object, label, relatedTargets),
  };
  private geometry(key: string, create: () => THREE.BufferGeometry) {
    if (!this.geometries.has(key)) this.geometries.set(key, create()); return this.geometries.get(key)!;
  }
  private material(color: number, glow = 0, metal = 0) {
    const key = `${color}:${glow}:${metal}`;
    if (!this.materials.has(key)) this.materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: metal ? .33 : .8,
      metalness: metal, emissive: glow ? color : 0, emissiveIntensity: glow }));
    return this.materials.get(key)!;
  }
  private mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, at: [number, number, number], color: number, glow = 0, metal = 0) {
    const mesh = new THREE.Mesh(geometry, this.material(color, glow, metal)); mesh.position.set(...at);
    mesh.castShadow = !glow; mesh.receiveShadow = !glow; parent.add(mesh); return mesh;
  }
  private box(parent: THREE.Object3D, size: [number, number, number], at: [number, number, number], color: number, glow = 0, metal = 0) {
    return this.mesh(parent, this.geometry(`b:${size}`, () => new THREE.BoxGeometry(...size)), at, color, glow, metal);
  }
  private cylinder(parent: THREE.Object3D, radius: number, height: number, at: [number, number, number], color: number, glow = 0, metal = 0) {
    return this.mesh(parent, this.geometry(`c:${radius}:${height}`, () => new THREE.CylinderGeometry(radius, radius, height, 24)), at, color, glow, metal);
  }
  private sphere(parent: THREE.Object3D, scale: [number, number, number], at: [number, number, number], color: number, glow = 0) {
    const mesh = this.mesh(parent, this.geometry('sphere', () => new THREE.SphereGeometry(1, 16, 10)), at, color, glow);
    mesh.scale.set(...scale); return mesh;
  }
  private ring(parent: THREE.Object3D, radius: number, tube: number, at: [number, number, number], color: number, glow = 0) {
    const mesh = this.mesh(parent, this.geometry(`ring:${radius}:${tube}`, () => new THREE.TorusGeometry(radius, tube, 8, 48)), at, color, glow, glow ? 0 : .6);
    mesh.rotation.x = Math.PI / 2; return mesh;
  }
  private sign(parent: THREE.Object3D, text: string, subtitle: string, width: number, at: [number, number, number], facing = 0) {
    const canvas = new OffscreenCanvas(1024, 256), c = canvas.getContext('2d')!;
    c.clearRect(0, 0, 1024, 256); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#f0d9b6'; c.font = '500 88px sans-serif'; c.fillText(text, 512, 96);
    c.fillStyle = '#b3d9d1'; c.font = '500 26px sans-serif'; c.fillText(subtitle, 512, 185);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }); this.materials.set(`sign:${text}:${at}`, material);
    const mesh = new THREE.Mesh(this.geometry(`sign:${width}`, () => new THREE.PlaneGeometry(width, width / 4)), material);
    mesh.position.set(...at); mesh.rotation.y = facing; parent.add(mesh); return mesh;
  }
  constructor(canvas: OffscreenCanvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); configureShadowRenderer(this.renderer);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15; this.scene.background = new THREE.Color(0x182135); this.scene.fog = new THREE.Fog(0x182135, 65, 130);
    // These soft fills approximate the warm floor/ceiling bounce that a real
    // room receives. Local fixture lights still supply the pools and shadows.
    this.scene.add(new THREE.HemisphereLight(0xd4ddf6, 0xb5a2a1, .9),
      new THREE.AmbientLight(0xffead6, .6), this.actors, this.shell);
    this.buildRoom(); furniture.forEach(item => this.buildFurniture(item)); this.buildMirror();
    // The recipe is local and deterministic; the shared compiler also powers media previews.
    void createRecipeMaterial({ kind: 'texture', version: 1, id: 'afterglow.linen', name: 'Afterglow soft plaster', resolution: 64,
      layers: [{ source: { kind: 'noise', colors: ['#5e6274', '#6b6f81'], scale: 32, seed: 81 }, roughness: .92, heightStrength: .12 }],
      reliefScale: .003, normalStrength: .35 }).then(recipe => {
      if (this.disposed) { recipe.dispose(); return; } this.recipes.push(recipe); for (const wall of this.plaster) wall.material = recipe.material;
    }).catch(() => { /* The authored flat plaster remains a complete fallback. */ });
  }
  private pendant(x: number, z: number, height: number, color = COLORS.warm) {
    this.cylinder(this.scene, .022, LOUNGE.wallHeight - height, [x, (LOUNGE.wallHeight + height) / 2, z], COLORS.dark);
    this.ring(this.scene, .7, .055, [x, height, z], COLORS.brass);
    this.sphere(this.scene, [.53, .15, .53], [x, height - .04, z], color, 1.5);
    this.lighting.addSpot({ id: `pendant:${x}:${z}`, position: [x, height - .22, z], target: [x, 0, z], color,
      intensity: 70, range: 14, angle: 1.05, penumbra: .8 });
  }
  private buildRoom() {
    const { halfWidth: w, halfDepth: d, wallHeight: h } = LOUNGE;
    this.box(this.scene, [w * 2, .4, d * 2], [0, -.23, 0], COLORS.dark);
    for (let row = 0; row < 32; row++) {
      const z = -d + .44 + row * .875, color = [0x6c4a3e, 0x765044, 0x805a48, 0x6f4c41][row % 4];
      this.box(this.scene, [w * 2, .045, .86], [0, -.018, z], color).castShadow = false;
      for (let x = -w + row % 3 * 2; x < w; x += 6) this.box(this.scene, [.012, .003, .86], [x, .007, z], 0x49372f).castShadow = false;
    }
    for (const side of [-1, 1]) {
      this.plaster.push(this.box(this.shell, [.35, h, d * 2], [side * (w + .17), h / 2, 0], COLORS.wall));
      this.box(this.shell, [.08, .15, d * 2], [side * (w - .04), 1, 0], COLORS.brass, 0, .5);
      this.box(this.shell, [.06, .045, d * 2], [side * (w - .06), h - .35, 0], COLORS.lilac, 1.2);
      for (let z = -d + .6; z < d; z += .72) this.box(this.shell, [.12, 1.02, .08], [side * (w - .06), .51, z], COLORS.walnut);
      for (const z of [-9, 0, 9]) {
        this.box(this.shell, [.08, 2.4, 2.5], [side * (w - .13), 2.9, z], 0x202a3a);
        this.box(this.shell, [.09, .04, 2.2], [side * (w - .2), 2.9, z], COLORS.brass);
        this.sphere(this.shell, [.06, .45, .45], [side * (w - .25), 3.12, z], z === 0 ? 0x638c8e : 0x957587);
      }
    }
    this.plaster.push(this.box(this.shell, [w * 2, h, .4], [0, h / 2, d + .2], COLORS.wall));
    this.box(this.shell, [w * 2, .2, d * 2], [0, h + .1, 0], 0x626275);
    for (const x of [-6.3, 6.3]) this.box(this.shell, [.12, .16, d * 2], [x, h - .08, 0], COLORS.brass, 0, .5);
    for (const x of [-6, 6]) this.box(this.shell, [.06, .04, d * 2 - 1], [x, h - .18, 0], COLORS.warm, 1);
    this.box(this.shell, [w * 2, .8, .25], [0, .4, -d], COLORS.dark);
    const glass = new THREE.MeshStandardMaterial({ color: 0x6a7b95, transparent: true, opacity: .12, roughness: .2, depthWrite: false });
    this.materials.set('glass', glass);
    for (let x = -w; x <= w; x += 6) this.box(this.scene, [.13, h, .22], [x, h / 2, -d], COLORS.dark);
    for (let x = -w + 3; x < w; x += 6) {
      const pane = new THREE.Mesh(this.geometry('window', () => new THREE.PlaneGeometry(5.85, h - .8)), glass);
      pane.position.set(x, (h + .8) / 2, -d + .01); this.scene.add(pane);
    }
    for (let n = 0; n < 25; n++) {
      const x = (n - 12) * 3, y = 4 + n * 7 % 8, z = -24 - n % 4 * 3;
      this.box(this.scene, [2.5, y, 2], [x, y / 2 - 2, z], n % 2 ? 0x26324c : 0x202c44);
      for (let level = 0; level < y - 1; level += 1.2) for (const dx of [-.65, .65])
        this.box(this.scene, [.22, .38, .025], [x + dx, level - .7, z + 1.02], n % 3 ? 0xf2c091 : 0x95bfdb, .5);
    }
    this.sign(this.scene, 'A F T E R G L O W', 'GOOD COMPANY. NO CLOCK.', 10.5, [0, 4.48, -13.6]);
    for (const table of TABLES) {
      const rug = this.cylinder(this.scene, 3.6, .022, [table.x, .018, table.z], table.kind === 'cards' ? 0x353342 : 0x30494a); rug.castShadow = false;
      this.ring(this.scene, 3.45, .018, [table.x, .037, table.z], COLORS.brass);
      this.pendant(table.x, table.z, 4.25, table.kind === 'cards' ? 0xf6d1bd : 0xffd4a3);
    }
    for (const z of [-7.5, 0, 7.5]) this.pendant(0, z, 4.8);
    this.ring(this.scene, 2.4, .035, [0, 5.5, 0], COLORS.lilac, .9);
    this.ring(this.scene, 1.5, .035, [0, 5.2, 0], COLORS.warm, .9);
    this.box(this.scene, [8.5, .018, 4.2], [0, .017, 10.8], 0x343c4b).castShadow = false;
    for (const x of [-4.1, 4.1]) this.box(this.scene, [.045, .007, 3.9], [x, .029, 10.8], COLORS.brass);
  }
  private buildMirror() {
    const { x, mirrorZ: z, mirrorWidth: w, mirrorHeight: h, mirrorY: y } = DRESSING_AREA;
    this.box(this.shell, [w + .5, h + .5, .18], [x, y, z + .14], COLORS.dark);
    for (const side of [-1, 1]) {
      this.box(this.shell, [.13, h + .4, .18], [x + side * (w / 2 + .14), y, z], COLORS.brass, 0, .65);
      this.box(this.shell, [w + .2, .13, .18], [x, y + side * (h / 2 + .14), z], COLORS.brass, 0, .65);
      this.box(this.shell, [.045, h - .15, .035], [x + side * (w / 2 + .04), y, z - .12], COLORS.warm, 1.6);
      this.lighting.addSpot({ id: `mirror:${side}`, position: [x + side * (w / 2 + .02), y + .7, z - .19],
        target: [x + side * 1.7, 1.15, z - 4.5], color: 0xffdfb4, intensity: 55, range: 13, angle: 1.05, penumbra: .85 });
    }
    this.sign(this.shell, 'FIND YOUR GLOW', 'B  /  CHANGE AVATAR     Q  /  EXPRESS YOURSELF', 7.2, [x, 5.27, z - .15], Math.PI);
    this.sign(this.shell, 'BE YOURSELF', 'THE AVATAR STUDIO', 4.9, [-11.6, 2.8, z - .15], Math.PI);
    this.sign(this.shell, 'STAY A WHILE', 'THERE IS A PLACE FOR EVERYONE', 4.9, [11.6, 2.8, z - .15], Math.PI);
    const mirror = this.mirror = new Reflector(this.geometry('mirror', () => new THREE.PlaneGeometry(w, h)), {
      color: 0xb6bcc2, textureWidth: 1024, textureHeight: 1024, clipBias: .003, multisample: 0 });
    mirror.position.set(x, y, z); mirror.rotation.y = Math.PI; mirror.name = 'avatar-mirror';
    const reflection = mirror.onBeforeRender;
    mirror.onBeforeRender = (...args) => {
      const id = this.reflectedPlayerId, guest = id ? this.guests.get(id) : undefined;
      if (!id || !guest) { reflection.apply(mirror, args); return; }
      const visible = guest.root.visible, name = guest.name.visible; guest.root.visible = true; guest.name.visible = false;
      try { this.appearances.withVisible(id, () => reflection.apply(mirror, args)); }
      finally { guest.root.visible = visible; guest.name.visible = name; }
    };
    this.shell.add(mirror); this.focus.setTarget('avatar-mirror', mirror, 'Live avatar mirror');
  }
  private buildFurniture(item: Furniture) {
    const root = new THREE.Group(); root.name = item.id; root.position.set(item.x, 0, item.z); root.rotation.y = item.facing;
    this.scene.add(root); this.furnitureTargets.set(item.id, root);
    const { width: w, depth: d, height: h } = item, color = item.color ?? COLORS.walnut;
    if (item.kind === 'sofa' || item.kind === 'armchair') {
      for (const x of [-w / 2 + .13, w / 2 - .13]) for (const z of [-d / 2 + .14, d / 2 - .14]) this.cylinder(root, .045, .22, [x, .11, z], COLORS.brass, 0, .6);
      this.box(root, [w, .25, d], [0, .33, 0], color);
      this.box(root, [w, h - .4, .23], [0, (h + .4) / 2, -d / 2 + .115], color);
      for (const side of [-1, 1]) this.box(root, [.15, .47, d], [side * (w / 2 - .075), .62, 0], color);
      const count = item.kind === 'sofa' ? 4 : 1;
      for (let n = 0; n < count; n++) {
        const x = (n - (count - 1) / 2) * (w - .34) / count;
        this.box(root, [(w - .34) / count - .025, .15, d - .25], [x, SEATING.cushionTop - .075, .075], color);
        const cushion = this.box(root, [(w - .34) / count - .03, .46, .14], [x, .87, -d / 2 + .28], color); cushion.rotation.x = -.08;
      }
      if (count > 1) {
        const cushion = this.box(root, [.4, .4, .15], [-w / 2 + .46, .78, -.15], COLORS.cream); cushion.rotation.z = -.18;
        this.box(root, [.6, .035, d - .25], [w / 2 - .6, .69, .1], 0x977a94);
      }
    } else if (item.kind === 'table') {
      this.cylinder(root, .65, .07, [0, .035, 0], COLORS.dark); this.cylinder(root, .12, h - .12, [0, (h - .12) / 2, 0], COLORS.brass, 0, .65);
      this.box(root, [w, .13, d], [0, h - .065, 0], COLORS.walnut);
      this.box(root, [w - .16, .016, d - .16], [0, h + .008, 0], color);
      const table = TABLES.find(t => `table-${t.id}` === item.id)!;
      const canvas = new OffscreenCanvas(512, 512), texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture);
      const material = new THREE.MeshBasicMaterial({ map: texture }); this.materials.set(`table-display:${table.id}`, material);
      const board = new THREE.Mesh(this.geometry('table-board', () => new THREE.PlaneGeometry(1.75, 1.55)), material);
      board.rotation.x = -Math.PI / 2; board.position.y = h + .023; root.add(board);
      this.tableDisplays.set(table.id, { canvas, texture, key: '' });
      // Readable from across the room without obscuring the guests' faces.
      const labelCanvas = new OffscreenCanvas(768, 128), c = labelCanvas.getContext('2d')!;
      c.fillStyle = '#182434e8'; c.beginPath(); c.roundRect(5, 5, 758, 118, 22); c.fill();
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '500 46px sans-serif'; c.fillStyle = '#eed0a6'; c.fillText(table.label, 384, 49);
      c.font = '500 23px sans-serif'; c.fillStyle = '#b7cec8'; c.fillText(table.kind === 'truth' ? 'TELL A STORY  ·  MAKE A MEMORY' : 'MATCH  ·  PLAY  ·  CLASH', 384, 94);
      const labelTexture = new THREE.CanvasTexture(labelCanvas); labelTexture.colorSpace = THREE.SRGBColorSpace; this.textures.add(labelTexture);
      const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture, depthWrite: false }); this.materials.set(`table-label:${table.id}`, labelMaterial);
      const label = new THREE.Sprite(labelMaterial); label.scale.set(2.8, .47, 1); label.position.set(0, 2.85, 0); root.add(label);
    } else if (item.kind === 'counter') {
      this.box(root, [w, h - .1, d], [0, (h - .1) / 2, 0], COLORS.dark);
      for (let x = -w / 2 + .15; x < w / 2; x += .22) this.box(root, [.075, h - .2, .04], [x, h / 2, d / 2 + .015], COLORS.walnut);
      this.box(root, [w + .15, .13, d + .12], [0, h - .065, 0], COLORS.cream);
      this.box(root, [w - .1, .04, .04], [0, h - .2, d / 2 + .08], COLORS.warm, 1.2);
      this.box(root, [1.4, .68, .72], [-3.8, h + .34, -.15], COLORS.dark);
      this.box(root, [1.45, .08, .76], [-3.8, h + .72, -.15], COLORS.brass, 0, .65);
      for (let n = 0; n < 6; n++) { this.cylinder(root, .13, .19, [-2.5 + n * .63, h + .1, .38], COLORS.cream); }
      for (const x of [3, 3.7, 4.4]) this.cylinder(root, .2, .45, [x, h + .23, 0], x === 3 ? 0xa27d5b : 0x596570);
    } else if (item.kind === 'planter') {
      this.cylinder(root, .53, h, [0, h / 2, 0], COLORS.cream); this.cylinder(root, .47, .03, [0, h + .005, 0], 0x44342e);
      for (let n = 0; n < 9; n++) {
        const a = n * 2.4, r = .25 + n % 3 * .11;
        const leaf = this.sphere(root, [.18, .6 + n % 3 * .15, .08], [Math.sin(a) * r, h + .65 + n % 2 * .3, Math.cos(a) * r], n % 2 ? 0x547f69 : 0x3d685b);
        leaf.rotation.set(Math.sin(a) * .5, a, Math.cos(a) * .4);
      }
    }
  }
  private updateTable(table: TableState | undefined, id: number) {
    const display = this.tableDisplays.get(id)!;
    const key = JSON.stringify([table?.topCard, table?.currentColor, table?.phase, table?.turn, table?.promptKind]);
    if (key === display.key) return; display.key = key;
    const c = display.canvas.getContext('2d')!, cards = TABLES[id].kind === 'cards';
    c.fillStyle = cards ? '#372d55' : '#1e5351'; c.fillRect(0, 0, 512, 512);
    c.strokeStyle = '#bc9a6b'; c.lineWidth = 4; c.strokeRect(16, 16, 480, 480);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#f0dbb8'; c.font = '500 31px sans-serif'; c.fillText(cards ? 'COLOR CLASH' : 'TRUTH OR DARE', 256, 68);
    if (cards && table && table.topCard >= 0) {
      const color = cardColor(table.topCard), value = cardValue(table.topCard);
      c.fillStyle = color < 0 ? '#80729b' : CARD_COLORS[color].hex; c.beginPath(); c.roundRect(169, 138, 174, 230, 16); c.fill();
      c.fillStyle = '#172335'; c.font = `600 ${value < 10 ? 100 : 36}px sans-serif`; c.fillText(value < 10 ? String(value) : ['SKIP', 'REVERSE', '+2', 'WILD'][value - 10], 256, 253);
      c.fillStyle = CARD_COLORS[table.currentColor].hex; c.beginPath(); c.arc(256, 421, 13, 0, Math.PI * 2); c.fill();
    } else {
      for (const side of [-1, 1]) {
        c.fillStyle = cards ? side < 0 ? '#df9a7b' : '#96c8b8' : side < 0 ? '#628c8c' : '#a1839b';
        c.beginPath(); c.roundRect(256 + side * 112 - 85, 155, 170, 205, 14); c.fill();
        c.fillStyle = '#f9eddb'; c.font = '500 32px sans-serif'; c.fillText(cards ? '✦' : side < 0 ? 'TRUTH' : 'DARE', 256 + side * 112, 256);
      }
    }
    c.fillStyle = '#dbc9ad'; c.font = '500 21px sans-serif'; c.fillText('TAKE A SEAT  ·  E', 256, 465); display.texture.needsUpdate = true;
  }
  private makeGuest(modelId: string): Guest {
    const root = new THREE.Group(), actor = createLoungeActor(modelId); root.add(actor.root); this.actors.add(root);
    const canvas = new OffscreenCanvas(384, 80), texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }), name = new THREE.Sprite(material);
    name.scale.set(1.35, .28, 1); root.add(name); return { root, actor, avatar: actor.root, modelId, name, canvas, texture, text: '' };
  }
  private removeGuest(id: string, guest: Guest) {
    this.appearances.remove(id); guest.actor.dispose(); guest.root.removeFromParent(); guest.texture.dispose(); guest.name.material.dispose(); this.guests.delete(id);
  }
  resize(width: number, height: number, pixelRatio: number) {
    this.aspect = Math.max(1, width) / Math.max(1, height); this.renderer.setPixelRatio(Math.min(2, pixelRatio)); this.renderer.setSize(width, height, false);
    for (const camera of [this.camera, this.inspectionCamera]) { camera.aspect = this.aspect; camera.updateProjectionMatrix(); }
    this.overlay.resize(width, height);
  }
  setReviewCamera(camera: ReviewCamera | null) { this.reviewCamera = camera; }
  setInspectionFocus(focus: InspectionFocus | null) { this.focus.setFocus(focus); }
  inspectionFocus() { return this.focus.inspection(); }
  actorSignals(frame: Frame) { return loungeActorSignals(frame); }
  inspection() {
    return { terrain: { ...this.terrainSnapshot?.inspection(), ...this.terrainDetails?.inspection(), constraints: { surface: 'fixed-flat', height: 0 } },
      animation: 'shared-humanoid-motion-matching', actors: [...this.guests].map(([id, guest]) => ({ id, ...guest.actor.inspection() })),
      lounge: { tables: 4, mirror: 'live-planar', avatarStudio: this.modelSwitcherAvailable, lighting: 'fixture-owned' } };
  }
  info() {
    const forward = this.camera.getWorldDirection(new THREE.Vector3()), length = Math.hypot(forward.x, forward.z) || 1;
    return { forwardX: forward.x / length, forwardZ: forward.z / length, modelSwitcherAvailable: this.modelSwitcherAvailable ? 1 : 0 };
  }
  update(frame: Frame) {
    if (this.disposed) return;
    prepareTerrainWorld(sharedTerrain, frame.tuning, terrainInterestsFor(frame.players));
    const terrain = this.terrainSnapshot = sharedTerrain.read(frame.tuning); registerInspectionTerrain(this.scene, terrain);
    if (frame.world) terrain.assertRevision(frame.world.terrainRevision);
    if (terrain.contributionCount) {
      if (!this.terrainDetails) { this.terrainDetails = new TerrainWorldView(terrain, { surface: false, routeSurfaces: true }); this.scene.add(this.terrainDetails.root); }
      else this.terrainDetails.update(terrain);
    } else if (this.terrainDetails) { this.terrainDetails.root.removeFromParent(); this.terrainDetails.dispose(); this.terrainDetails = undefined; }
    const signals = this.actorSignals(frame);
    for (const [id, guest] of this.guests) if (!frame.players.some(p => p.id === id && p.active !== false)) this.removeGuest(id, guest);
    frame.players.forEach(player => {
      if (player.active === false) return;
      const modelId = Object.hasOwn(MODEL_PALETTES, player.modelId ?? '') ? player.modelId! : 'builtin:male';
      let guest = this.guests.get(player.id);
      if (!guest) { guest = this.makeGuest(modelId); this.guests.set(player.id, guest); }
      else if (guest.modelId !== modelId) { guest.actor.dispose(); guest.actor = createLoungeActor(modelId); guest.avatar = guest.actor.root; guest.root.add(guest.avatar); guest.modelId = modelId; }
      const s = player.state, seated = s.seatIndex >= 0, facing = seated ? seats[s.seatIndex]?.facing ?? s.facing : s.facing;
      guest.root.visible = player.hp > 0; guest.root.position.set(s.x, s.y, s.z); guest.avatar.rotation.y = facing;
      guest.actor.update(signals[player.id]); guest.name.visible = !player.isLocal || !!this.reviewCamera; guest.name.position.y = seated ? 1.65 : 2.08;
      const label = player.name.length > 20 ? `${player.name.slice(0, 19)}…` : player.name;
      if (label !== guest.text) {
        const c = guest.canvas.getContext('2d')!; c.clearRect(0, 0, 384, 80); c.fillStyle = '#172332d9'; c.beginPath(); c.roundRect(8, 8, 368, 64, 24); c.fill();
        c.font = '500 30px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#f5e1c3'; c.fillText(label, 192, 40);
        guest.texture.needsUpdate = true; guest.text = label;
      }
      this.appearances.update(player.id, guest.avatar, { ...s, facing }, player.hp > 0, player.hp > 0);
    });
    for (const table of TABLES) this.updateTable(frame.world?.tables?.find(t => t.id === table.id), table.id);
    const local = frame.players.find(player => player.isLocal && player.active !== false), s = local?.state;
    this.reflectedPlayerId = local && local.hp > 0 ? local.id : null;
    this.modelSwitcherAvailable = !!s && local!.hp > 0 && s.seatIndex < 0 && Math.hypot(s.x - DRESSING_AREA.x, s.z - DRESSING_AREA.z) <= DRESSING_AREA.radius;
    const selfie = !!s && (!!s.emoteId || !!s.wheelOpen) && s.seatIndex < 0;
    if (s) {
      if (selfie) {
        this.camera.position.set(THREE.MathUtils.clamp(s.x - Math.sin(s.facing) * 3.5, -17.4, 17.4), s.y + 2.35,
          THREE.MathUtils.clamp(s.z - Math.cos(s.facing) * 3.5, -13.4, 13.4)); this.camera.lookAt(s.x, s.y + 1.05, s.z);
      } else { this.camera.position.set(s.x, s.y + frame.tuning.fighterHeight * (s.seatIndex >= 0 ? .48 : .9), s.z);
        this.camera.rotation.set(s.aimPitch ?? 0, s.facing + Math.PI, 0, 'YXZ'); }
      this.camera.fov = 70;
    } else {
      const distance = this.aspect < 1 ? 41 / this.aspect : 41;
      this.camera.position.set(0, distance * .58, distance * .76); this.camera.lookAt(0, .4, -1); this.camera.fov = 53;
    }
    this.camera.updateProjectionMatrix();
    if (this.reviewCamera) { const r = this.reviewCamera; this.inspectionCamera.position.set(r.x, r.y, r.z);
      this.inspectionCamera.rotation.set(r.pitch, r.yaw, 0, 'YXZ'); this.inspectionCamera.fov = r.fov; this.inspectionCamera.updateProjectionMatrix(); }
    const camera = this.reviewCamera ? this.inspectionCamera : this.camera;
    const targets: InspectionTarget[] = frame.players.flatMap((player, index) => {
      const object = player.active !== false && player.hp > 0 ? this.appearances.inspectionTarget(player.id) : undefined;
      const seat = seats[player.state.seatIndex], related = seat ? furniture.find(item => seat.id === item.id)
        ?? furniture.find(item => seat.id.startsWith(`${item.id}-`)) : undefined;
      return object ? [{ id: `player:${player.id}`, label: player.name, player: index, object, forward: signals[player.id]?.facing,
        ...(related ? { relatedTargets: [`furniture:${related.id}`, ...(seat?.tableId === undefined ? [] : [`furniture:table-${seat.tableId}`])], relationReason: 'occupied-seat' } : {}) }] : [];
    });
    for (const [id, object] of this.furnitureTargets) targets.push({ id: `furniture:${id}`, label: id, object });
    const prepareCamera = (actual: THREE.Camera) => {
      this.lighting.update(actual.position);
      this.shell.visible = Math.abs(actual.position.x) < LOUNGE.halfWidth && Math.abs(actual.position.z) < LOUNGE.halfDepth && actual.position.y < LOUNGE.wallHeight;
    };
    if (isInspectionCameraFrameActive()) {
      prepareCamera(this.camera); const measure = () => recordInspectionGameplayCamera(this.scene, this.camera, true, local?.id);
      if (local && !selfie) this.appearances.withHiddenFromCamera(local.id, this.camera, measure); else measure();
    }
    const render = () => this.focus.render(this.renderer, this.scene, camera, targets, prepareCamera);
    if (local && !selfie && !this.reviewCamera && !this.focus.active) this.appearances.withHiddenFromCamera(local.id, camera, render); else render();
    this.overlay.update(frame, this.modelSwitcherAvailable);
    if (!this.reviewCamera && !this.focus.active) this.overlay.render(this.renderer);
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const [id, guest] of this.guests) this.removeGuest(id, guest);
    this.appearances.dispose(); this.lighting.dispose(); this.terrainDetails?.dispose(); this.mirror.dispose(); this.overlay.dispose();
    this.geometries.forEach(g => g.dispose()); this.materials.forEach(m => m.dispose()); this.textures.forEach(t => t.dispose()); this.recipes.forEach(r => r.dispose());
    this.scene.clear(); this.renderer.dispose();
  }
}
const createView: CreateView<WorldState, PlayerState, GameTuning> = canvas => new LoungeView(canvas);
export default createView;
