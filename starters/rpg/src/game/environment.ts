import * as THREE from 'three';
import { LightingRig } from '../sandbox/lighting.ts';
import { CAMPAIGN } from './campaign.ts';

type Point = readonly [number, number, number];
type Fixture = { position: Point; target: Point; color: number; intensity: number; range: number; fire?: boolean };
type Batch = { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[]; shadows: boolean };
export type CampaignEnvironmentFrame = { time: number; delta: number; focusX: number; focusZ: number; stage: number; complete: boolean };

// Keep the visual route on the campaign's flat physics floor. The editable
// scenery lives beside it; all variation is deterministic and view-only.
const COLOR = {
  sky: 0x182d3b, earth: 0x263732, moss: 0x405647, trailEdge: 0x56604a, trail: 0x91836a,
  pine: 0x254d46, pineTip: 0x3e6c59, pineShade: 0x1d3d3b, bark: 0x4e433b,
  wood: 0x806447, woodLight: 0x9d7c50, iron: 0x283937, brass: 0xc49a59,
  stone: 0x65756e, stoneLight: 0x839086, stoneDark: 0x455851, warm: 0xffcd87, magic: 0x84ead8,
} as const;
const variation = (seed: number) => { const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453123; return n - Math.floor(n); };

/** Editable twilight expedition scenery, with light emitted by visible fixtures.
 * Three pooled local lights keep shader and shadow cost independent of map size.
 * Intended for ACES tone mapping at about 1.1 exposure. */
export class CampaignEnvironment {
  private readonly root = new THREE.Group();
  private readonly lighting = new LightingRig(this.root, { maxShadowLights: 3, shadowMapSize: 1024 });
  private readonly moon = new THREE.DirectionalLight(0xbad7ea, 1.3);
  private readonly fill = new THREE.HemisphereLight(0xb0c7d8, 0x67705c, 1.15);
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly batches = new Map<string, Batch>();
  private readonly fixtures: Fixture[] = [];
  private readonly lightSlots: { light: THREE.SpotLight; fixture: number }[] = [];
  private readonly fire = new THREE.Group();
  private readonly flames: THREE.Mesh[] = [];
  private readonly embers: THREE.Points;
  private readonly waterLines: THREE.Group = new THREE.Group();
  private readonly portal = new THREE.Group();
  private readonly portalSurface: THREE.ShaderMaterial;
  private readonly portalRunes: THREE.MeshStandardMaterial;
  private readonly portalGlow: THREE.PointLight;
  private readonly objective = new THREE.Group();
  private readonly objectiveGem: THREE.Mesh;
  private readonly previousBackground: THREE.Scene['background'];
  private readonly previousFog: THREE.Scene['fog'];
  private readonly scene: THREE.Scene;
  private readonly background = new THREE.Color(COLOR.sky);
  private readonly fog = new THREE.Fog(COLOR.sky, 48, 135);
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.root.name = 'campaign-environment';
    this.objective.name = 'campaign-waypoint'; this.portal.name = 'campaign-gate';
    this.previousBackground = scene.background; this.previousFog = scene.fog;
    scene.background = this.background; scene.fog = this.fog;
    scene.add(this.root); this.root.add(this.fill, this.moon, this.moon.target, this.fire, this.portal, this.objective, this.waterLines);
    this.moon.name = 'twilight-moon';
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(1024, 1024);
    Object.assign(this.moon.shadow.camera, { left: -23, right: 23, top: 25, bottom: -25, near: 1, far: 90 });
    this.moon.shadow.camera.updateProjectionMatrix();
    this.moon.shadow.bias = -0.00015; this.moon.shadow.normalBias = 0.035;
    this.moon.shadow.radius = 2;
    this.buildGround(); this.buildWoods(); this.buildCamp(); this.buildCrossing();
    this.portalRunes = this.standard(COLOR.magic, { emissive: COLOR.magic, emissiveIntensity: 0.15 });
    this.portalSurface = this.makePortalSurface();
    this.portalGlow = new THREE.PointLight(COLOR.magic, 0, 12, 2);
    this.portalGlow.position.set(0, 2.1, CAMPAIGN.destination.z + 1.2);
    this.root.add(this.portalGlow);
    this.buildCourt();

    // Lamps are scenery, while just three reusable spots illuminate the nearby
    // area. Light positions stay exactly attached to the selected fixtures.
    for (let i = 0; i < 3; i++) this.lightSlots.push({ fixture: -1, light: this.lighting.addSpot({
      id: `expedition-local-${i}`, position: [0, 2, 0], target: [0, 0, 0],
      intensity: 0, range: 16, angle: 1.15, penumbra: 0.9,
    }) });

    const markerMaterial = this.standard(0xe3cb88, { emissive: 0xc1a654, emissiveIntensity: 0.35, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false });
    const ring = this.mesh(this.objective, this.geometry('objective-ring', () => new THREE.RingGeometry(0.9, 1.03, 48)), markerMaterial, [0, 0.065, 0], false);
    ring.rotation.x = -Math.PI / 2;
    this.objectiveGem = this.mesh(this.objective, this.geometry('objective-gem', () => new THREE.OctahedronGeometry(0.21)), markerMaterial, [0, 2.7, 0], false);
    this.objectiveGem.scale.y = 1.7;

    const emberGeometry = this.geometry('embers', () => {
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18 * 3), 3)); return geometry;
    });
    const emberMaterial = new THREE.PointsMaterial({ color: 0xffd69b, size: 0.055, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
    this.materials.set('embers', emberMaterial);
    this.embers = new THREE.Points(emberGeometry, emberMaterial); this.embers.frustumCulled = false; this.fire.add(this.embers);
    this.flushBatches();
    this.update({ time: 0, delta: 0, focusX: 0, focusZ: CAMPAIGN.start.z, stage: 0, complete: false });
  }

  private geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geometry = this.geometries.get(key);
    if (!geometry) { geometry = create(); this.geometries.set(key, geometry); }
    return geometry;
  }
  private standard(color: number, parameters: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const key = `${color}:${JSON.stringify(parameters)}`;
    let material = this.materials.get(key) as THREE.MeshStandardMaterial | undefined;
    if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...parameters }); this.materials.set(key, material); }
    return material;
  }
  private mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, position: Point, shadows = true): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...position); mesh.castShadow = shadows; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  private box(parent: THREE.Object3D, size: Point, position: Point, color: number, shadows = true): THREE.Mesh {
    const mesh = this.mesh(parent, this.geometry('box', () => new THREE.BoxGeometry(1, 1, 1)), this.standard(color), position, shadows); mesh.scale.set(...size); return mesh;
  }
  private instance(geometry: THREE.BufferGeometry, material: THREE.Material, position: Point, scale: Point, rotation: Point = [0, 0, 0], shadows = true): void {
    const key = `${geometry.uuid}:${material.uuid}:${shadows}`;
    let batch = this.batches.get(key);
    if (!batch) { batch = { geometry, material, matrices: [], shadows }; this.batches.set(key, batch); }
    batch.matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale)));
  }
  private block(size: Point, position: Point, color: number, rotation: Point = [0, 0, 0], shadows = true): void {
    this.instance(this.geometry('box', () => new THREE.BoxGeometry(1, 1, 1)), this.standard(color), position, size, rotation, shadows);
  }
  private flushBatches(): void {
    for (const batch of this.batches.values()) {
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
      batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.castShadow = batch.shadows; mesh.receiveShadow = true;
      mesh.computeBoundingSphere(); this.root.add(mesh);
    }
    this.batches.clear();
  }

  private buildGround(): void {
    this.block([38, 1.6, 118], [0, -0.85, -31], COLOR.earth);
    this.block([32, 0.1, 112], [0, -0.05, -31], COLOR.moss, [0, 0, 0], false);
    const trail = (width: number, height: number, color: number) => {
      const positions: number[] = [], indices: number[] = [];
      for (let i = 0; i <= 56; i++) {
        const z = 25 - i * 2, center = Math.sin(z * 0.095) * 1.15;
        const edge = width / 2 + Math.sin(i * 1.7) * 0.19;
        positions.push(center - edge, height, z, center + edge, height, z);
        if (i < 56) { const n = i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
      }
      const geometry = this.geometry(`trail-${width}`, () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(indices); g.computeVertexNormals(); return g; });
      this.mesh(this.root, geometry, this.standard(color), [0, 0, 0], false);
    };
    trail(10.2, 0.008, COLOR.trailEdge); trail(8, 0.014, COLOR.trail);
    const patch = this.geometry('ground-patch', () => new THREE.CircleGeometry(1, 7));
    for (let i = 0; i < 160; i++) {
      const z = 24 - variation(i + 11) * 110, side = i % 2 ? 1 : -1;
      const x = side * (5.3 + variation(i + 30) * 10);
      if (z < -25 && z > -33 || z < -57) continue;
      this.instance(patch, this.standard(i % 3 === 0 ? 0x536349 : 0x354b40), [x, 0.018, z], [1 + variation(i) * 2.2, 0.6 + variation(i + 41) * 1.4, 1], [-Math.PI / 2, 0, i], false);
    }
    // A few half-buried paving stones lead the eye without hiding the flat floor.
    for (let i = 0; i < 70; i++) {
      const z = 23 - i * 1.56;
      if (z < -25 && z > -33 || z < -57) continue;
      const x = (variation(i + 280) - 0.5) * 6.3;
      this.block([0.3 + variation(i + 281) * 0.55, 0.012, 0.3 + variation(i + 282) * 0.5], [x, 0.021, z], i % 2 ? 0xa3987e : 0x7c7f68, [0, variation(i + 283) * 2, 0], false);
    }
  }

  private buildWoods(): void {
    const trunk = this.geometry('tree-trunk', () => new THREE.CylinderGeometry(0.13, 0.25, 1, 7));
    const crown = this.geometry('pine-canopy', () => new THREE.ConeGeometry(1, 1, 7));
    const boulder = this.geometry('boulder', () => new THREE.IcosahedronGeometry(1, 0));
    const grass = this.geometry('grass', () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-0.13, 0, 0, 0, 0.52, 0.04, 0.12, 0, 0, 0, 0, -0.12, 0.04, 0.4, 0, 0, 0, 0.12], 3)); g.computeVertexNormals(); return g;
    });
    for (let i = 0; i < 58; i++) {
      const side = i % 2 ? 1 : -1, z = 23 - Math.floor(i / 2) * 3;
      if (z < -24 && z > -34 || z < -58) continue;
      const x = side * (10.2 + variation(i + 7) * 6.7), height = 4.2 + variation(i + 8) * 3.1;
      this.instance(trunk, this.standard(COLOR.bark), [x, height * 0.3, z], [1.2, height * 0.6, 1.2], [0, i, 0]);
      for (let tier = 0; tier < 3; tier++) {
        const width = (2.1 - tier * 0.43) * (0.8 + height * 0.035), length = height * 0.43;
        this.instance(crown, this.standard(tier === 2 ? COLOR.pineTip : tier === 1 ? COLOR.pine : COLOR.pineShade), [x, height * (0.48 + tier * 0.18), z], [width, length, width], [0, i + tier * 0.3, 0]);
      }
      if (i % 3 === 0) this.instance(boulder, this.standard(COLOR.stoneDark), [side * (7.5 + variation(i + 120) * 4), 0.4, z + 1.5], [0.8 + variation(i + 121), 0.55, 0.7], [0.2, i, 0.1]);
    }
    for (let i = 0; i < 170; i++) {
      const z = 24 - variation(i + 400) * 80, x = (i % 2 ? 1 : -1) * (5.2 + variation(i + 401) * 10.4);
      if (z < -25 && z > -33) continue;
      const scale = 0.6 + variation(i + 402) * 1.2;
      this.instance(grass, this.standard(i % 3 ? 0x66815c : 0x899064, { side: THREE.DoubleSide }), [x, 0.025, z], [scale, scale, scale], [0, i, 0], false);
      if (i % 12 === 0) for (let leaf = 0; leaf < 4; leaf++) {
        const angle = leaf * Math.PI / 2 + i;
        this.instance(crown, this.standard(0x598274), [x + Math.sin(angle) * 0.2, 0.25, z + Math.cos(angle) * 0.2], [0.18, 0.75, 0.22], [Math.cos(angle) * 0.8, angle, Math.sin(angle) * 0.8], false);
      }
    }
    for (const [x, z] of [[-5.9, 4], [5.9, -10], [-5.9, -20], [5.9, -43], [-5.9, -53]]) this.lantern(x, z);
    this.waypost('WHISPERING', 'TRAIL', -6.4, 3.2);
    this.waypost('OLD', 'CROSSING', 6.3, -23.5);
  }

  private lantern(x: number, z: number, height = 3.3): void {
    const direction = x < 0 ? 1 : -1, lampX = x + direction * 0.58;
    this.block([0.21, height + 0.3, 0.21], [x, (height + 0.3) / 2, z], COLOR.wood);
    this.block([0.9, 0.14, 0.15], [x + direction * 0.35, height + 0.1, z], COLOR.woodLight);
    this.block([0.055, 0.32, 0.055], [lampX, height - 0.03, z], COLOR.iron);
    const y = height - 0.45;
    const lamp = this.mesh(this.root, this.geometry('lantern-glass', () => new THREE.BoxGeometry(0.33, 0.5, 0.33)), this.standard(COLOR.warm, { emissive: 0xffae52, emissiveIntensity: 2.2, roughness: 0.35 }), [lampX, y, z], false);
    lamp.name = 'warm-lantern-glass';
    this.block([0.49, 0.09, 0.49], [lampX, y + 0.3, z], COLOR.iron);
    // An open bottom rim and a visible bulb below it give the light a real
    // aperture. A solid cap below an interior light self-shadows the entire path.
    for (const side of [-1, 1]) {
      this.block([0.49, 0.06, 0.045], [lampX, y - 0.3, z + side * 0.22], COLOR.iron);
      this.block([0.045, 0.06, 0.4], [lampX + side * 0.22, y - 0.3, z], COLOR.iron);
    }
    this.mesh(this.root, this.geometry('lantern-bulb', () => new THREE.SphereGeometry(0.13, 8, 6)), this.standard(COLOR.warm, { emissive: 0xffae52, emissiveIntensity: 2.2, roughness: 0.35 }), [lampX, y - 0.29, z], false);
    for (const dx of [-0.2, 0.2]) for (const dz of [-0.2, 0.2]) this.block([0.035, 0.53, 0.035], [lampX + dx, y, z + dz], COLOR.iron);
    this.fixtures.push({ position: [lampX, y - 0.37, z], target: [lampX + direction * 1.4, 0, z], color: COLOR.warm, intensity: 55, range: 15 });
  }

  private buildCamp(): void {
    const roof = this.geometry('tent', () => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-2, 0, -2, 0, 2.8, -2, -2, 0, 2, 0, 2.8, -2, 0, 2.8, 2, -2, 0, 2, 0, 2.8, -2, 2, 0, -2, 0, 2.8, 2, 2, 0, -2, 2, 0, 2, 0, 2.8, 2], 3)); geometry.computeVertexNormals(); return geometry;
    });
    for (const side of [-1, 1]) {
      const tent = new THREE.Group(); tent.position.set(side * 8.4, 0, 17.8); tent.rotation.y = side * -0.24; this.root.add(tent);
      this.mesh(tent, roof, this.standard(side < 0 ? 0x8d6954 : 0x677d77, { side: THREE.DoubleSide }), [0, 0, 0]);
      this.box(tent, [0.1, 2.8, 0.1], [0, 1.4, -2.1], COLOR.woodLight);
      this.box(tent, [0.1, 2.8, 0.1], [0, 1.4, 2.1], COLOR.woodLight);
      this.box(tent, [0.11, 0.11, 4.5], [0, 2.8, 0], COLOR.woodLight);
      this.box(tent, [2.9, 0.07, 3.6], [0, 0.035, 0], COLOR.earth, false);
      this.block([1.1, 0.72, 0.85], [side * 6.8, 0.36, 20.8], COLOR.wood);
      this.block([1.18, 0.08, 0.92], [side * 6.8, 0.75, 20.8], COLOR.woodLight);
    }
    this.fire.position.set(0, 0, 20);
    const rock = this.geometry('fire-stone', () => new THREE.IcosahedronGeometry(1, 0));
    for (let i = 0; i < 9; i++) this.mesh(this.fire, rock, this.standard(COLOR.stoneDark), [Math.sin(i * Math.PI * 2 / 9) * 0.97, 0.16, Math.cos(i * Math.PI * 2 / 9) * 0.97]).scale.set(0.32, 0.23, 0.29);
    for (let i = 0; i < 3; i++) {
      const log = this.box(this.fire, [1.3, 0.18, 0.24], [0, 0.17 + i * 0.07, 0], COLOR.bark); log.rotation.y = i * 1.08;
      const flame = this.mesh(this.fire, this.geometry('flame', () => new THREE.ConeGeometry(0.38, 1.1, 5)), this.standard(i === 0 ? 0xffe0a0 : 0xff9b45, { emissive: i === 0 ? 0xffd485 : 0xff6d29, emissiveIntensity: i === 0 ? 3 : 1.9, transparent: true, opacity: 0.92 }), [Math.sin(i * 2) * 0.2, 0.75, Math.cos(i * 2) * 0.17], false);
      this.flames.push(flame);
    }
    // The broad cone originates inside the visible flames, so nearby feet,
    // logs and camp equipment cast short, believable fire shadows.
    this.fixtures.push({ position: [0, 1.2, 20], target: [0, 0, 20], color: 0xffad60, intensity: 46, range: 12, fire: true });
    for (const x of [-2.5, 2.5]) {
      const log = this.geometry('camp-seat', () => new THREE.CylinderGeometry(0.28, 0.3, 2.4, 8));
      this.instance(log, this.standard(COLOR.bark), [x, 0.3, 19.1], [1, 1, 1], [Math.PI / 2, 0, 0]);
    }
    this.lantern(-5.6, 13.7); this.lantern(5.6, 13.7);
    this.waypost('TRAILHEAD', 'CAMP', -5.9, 22.5);
  }

  private buildCrossing(): void {
    // The stream is deliberately shallow; its bed shares the traversable floor.
    this.block([32, 0.024, 7.4], [0, -0.02, -29], 0x294b56, [0, 0, 0], false);
    const waterMaterial = this.standard(0x478b91, { roughness: 0.25, metalness: 0.32, transparent: true, opacity: 0.7 });
    this.mesh(this.root, this.geometry('water', () => new THREE.PlaneGeometry(32, 7.1)), waterMaterial, [0, 0.018, -29], false).rotation.x = -Math.PI / 2;
    const glint = this.standard(0x8fc2b9, { emissive: 0x567f80, emissiveIntensity: 0.2, transparent: true, opacity: 0.38, depthWrite: false });
    for (let i = 0; i < 24; i++) {
      const x = (i % 2 ? 1 : -1) * (5.2 + variation(i + 600) * 10);
      this.mesh(this.waterLines, this.geometry('ripple', () => new THREE.BoxGeometry(1, 0.002, 0.035)), glint, [x, 0.023, -32 + variation(i + 601) * 5.8], false).scale.x = 0.8 + variation(i + 602) * 1.8;
    }
    for (let i = 0; i < 13; i++) {
      const z = -32.65 + i * 0.61;
      this.block([8.25, 0.08, 0.56], [0, -0.012, z], i % 3 ? COLOR.wood : COLOR.woodLight);
      for (const x of [-3.75, 3.75]) this.block([0.05, 0.002, 0.05], [x, 0.029, z], COLOR.iron, [0, 0, 0], false);
    }
    for (const x of [-4.25, 4.25]) {
      this.block([0.15, 0.13, 8.3], [x, 1.16, -29], COLOR.woodLight);
      this.block([0.1, 0.09, 8.3], [x, 0.68, -29], COLOR.wood);
      for (const z of [-33, -29, -25]) this.block([0.24, 1.4, 0.24], [x, 0.7, z], COLOR.wood);
    }
    this.lantern(-4.8, -25.6, 3.5); this.lantern(4.8, -32.3, 3.5);
    const rock = this.geometry('boulder', () => new THREE.IcosahedronGeometry(1, 0));
    for (let i = 0; i < 26; i++) {
      const x = (i % 2 ? 1 : -1) * (5.2 + variation(i + 700) * 10.4), z = i % 4 < 2 ? -33 : -25;
      this.instance(rock, this.standard(i % 2 ? COLOR.stoneDark : COLOR.stone), [x, 0.2, z + variation(i + 701) * 0.5], [0.45 + variation(i + 702) * 0.8, 0.34, 0.55], [0, i, 0]);
    }
  }

  private buildCourt(): void {
    this.block([24, 0.02, 27], [0, 0.01, -70.5], COLOR.stoneDark, [0, 0, 0], false);
    for (let row = 0; row < 11; row++) for (let col = 0; col < 9; col++) {
      const x = (col - 4) * 2.55, z = -57.8 - row * 2.5;
      this.block([2.5, 0.006, 2.44], [x, 0.024, z], [COLOR.stone, 0x6b7970, 0x738074][Math.floor(variation(row * 9 + col + 800) * 3)], [0, 0, 0], false);
    }
    for (const x of [-11.7, 11.7]) for (let i = 0; i < 4; i++) {
      const z = -58.6 - i * 7.5, h = 2.6 + variation(i + x) * 1.8;
      this.block([1.9, 0.4, 1.9], [x, 0.2, z], COLOR.stoneLight);
      this.block([1.25, h, 1.25], [x, 0.5 + h / 2, z], COLOR.stoneDark);
      this.block([1.65, 0.35, 1.65], [x, h + 0.55, z], COLOR.stone);
      this.block([1.4, 0.12, 1.4], [x, h + 0.78, z], 0x426254);
      if (i < 3) this.block([0.72, 0.72, 5.4], [x, 0.38, z - 3.7], COLOR.stoneDark);
    }
    const inlay = this.standard(COLOR.brass, { roughness: 0.65 });
    const circle = this.mesh(this.root, this.geometry('court-circle', () => new THREE.RingGeometry(5.5, 5.57, 64)), inlay, [0, 0.029, -65], false);
    circle.rotation.x = -Math.PI / 2;
    for (let i = 0; i < 8; i++) this.block([0.1, 0.002, 0.7], [Math.sin(i * Math.PI / 4) * 5.1, 0.029, -65 + Math.cos(i * Math.PI / 4) * 5.1], COLOR.brass, [0, i * Math.PI / 4, 0], false);
    this.lantern(-8.4, -59, 3.8); this.lantern(8.4, -69, 3.8);
    this.lantern(-7.8, -79, 3.8); this.lantern(7.8, -79, 3.8);
    this.portal.position.set(CAMPAIGN.destination.x, 0, CAMPAIGN.destination.z);
    for (const x of [-3.15, 3.15]) {
      this.box(this.portal, [1.8, 0.45, 2.2], [x, 0.225, 0], COLOR.stoneLight);
      for (let i = 0; i < 5; i++) this.box(this.portal, [1.15, 1.03, 1.35], [x, 1 + i * 1.04, 0], i % 2 ? COLOR.stone : COLOR.stoneDark);
      this.box(this.portal, [1.6, 0.45, 1.75], [x, 5.75, 0], COLOR.stoneLight);
      for (let i = 0; i < 4; i++) this.mesh(this.portal, this.geometry('rune', () => new THREE.BoxGeometry(0.08, 0.27, 0.035)), this.portalRunes, [x, 1.4 + i * 0.9, 0.7], false).rotation.z = i % 2 ? Math.PI / 4 : -Math.PI / 4;
    }
    this.box(this.portal, [7.8, 0.8, 1.65], [0, 6.05, 0], COLOR.stone);
    this.box(this.portal, [8.25, 0.16, 1.85], [0, 6.54, 0], COLOR.stoneLight);
    this.mesh(this.portal, this.geometry('portal-crystal', () => new THREE.OctahedronGeometry(0.36)), this.portalRunes, [0, 6.1, 0.9], false);
    this.mesh(this.portal, this.geometry('portal-surface', () => new THREE.PlaneGeometry(5.15, 5.2)), this.portalSurface, [0, 2.9, 0.18], false);
    this.waypost('THE', 'GATEKEEPER', -7.4, -56.5);
  }

  private waypost(top: string, bottom: string, x: number, z: number): void {
    const sign = new THREE.Group(); sign.position.set(x, 0, z); sign.rotation.x = -0.14; this.root.add(sign);
    this.box(sign, [0.14, 1.9, 0.14], [0, 0.95, 0], COLOR.wood);
    this.box(sign, [2.3, 0.94, 0.14], [0, 1.85, 0], COLOR.wood);
    // Small physical trail signs replace the previous floating location banners.
    const canvas = new OffscreenCanvas(512, 192), context = canvas.getContext('2d')!;
    context.clearRect(0, 0, 512, 192); context.fillStyle = '#f4dcb3'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.font = '500 30px sans-serif'; context.fillText(top, 256, 59);
    context.font = '600 37px sans-serif'; context.fillText(bottom, 256, 115);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture);
    const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 1, depthWrite: false }); this.materials.set(`sign-${top}-${bottom}`, material);
    this.mesh(sign, this.geometry('sign-face', () => new THREE.PlaneGeometry(2.2, 0.825)), material, [0, 1.85, 0.076], false);
  }

  private makePortalSurface(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, charge: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 portalUv; void main() { portalUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec2 portalUv; uniform float time; uniform float charge;
        void main() {
          vec2 p = (portalUv - 0.5) * vec2(1.0, 1.13);
          float edge = 1.0 - smoothstep(0.34, 0.52, length(p));
          float waves = 0.5 + 0.5 * sin(length(p) * 32.0 - time * 2.0 + sin(p.y * 12.0 + time) * 1.5);
          float threads = pow(0.5 + 0.5 * sin(p.x * 23.0 + sin(p.y * 9.0 + time) * 2.0), 12.0);
          vec3 color = mix(vec3(0.07, 0.2, 0.2), vec3(0.35, 0.94, 0.79), waves * 0.5 + threads * 0.5);
          gl_FragColor = vec4(color * (0.5 + charge), edge * (0.04 + charge * (0.45 + waves * 0.2)));
        }`,
    });
    this.materials.set('portal-surface', material); return material;
  }

  update(frame: CampaignEnvironmentFrame): void {
    if (this.disposed) return;
    const { time, focusX, focusZ, stage, complete } = frame;
    // The moon is a modest outdoor key. Its shadow camera follows the view,
    // keeping useful detail around the party instead of spanning the entire map.
    this.moon.position.set(focusX - 14, 30, focusZ + 8);
    this.moon.target.position.set(focusX, 0, focusZ - 4);
    const ranked = this.fixtures.map((fixture, index) => ({ index, distance: (fixture.position[0] - focusX) ** 2 + (fixture.position[2] - focusZ) ** 2 }))
      .sort((a, b) => a.distance - b.distance);
    const nearest = new Set(ranked.slice(0, 3).map(item => item.index));
    const remaining = [...nearest].filter(index => !this.lightSlots.some(slot => slot.fixture === index));
    for (const slot of this.lightSlots) {
      if (!nearest.has(slot.fixture)) slot.fixture = remaining.shift() ?? -1;
      const fixture = this.fixtures[slot.fixture];
      if (!fixture) { slot.light.intensity = 0; continue; }
      slot.light.position.set(...fixture.position); slot.light.target.position.set(...fixture.target);
      slot.light.color.setHex(fixture.color); slot.light.distance = fixture.range;
      slot.light.angle = fixture.fire ? 1.45 : 1.15;
      const distance = Math.hypot(fixture.position[0] - focusX, fixture.position[2] - focusZ);
      // Keep the same three shadow shader slots even when a distant fixture's
      // contribution is negligible at a map edge.
      const fade = THREE.MathUtils.clamp((23 - distance) / 7, 0.0001, 1);
      slot.light.intensity = fixture.intensity * fade * (fixture.fire ? 1 + Math.sin(time * 9.3) * 0.07 + Math.sin(time * 17.7) * 0.035 : 1);
      slot.light.shadow.camera.far = fixture.range;
    }
    this.lighting.update({ x: focusX, y: 1, z: focusZ });
    this.flames.forEach((flame, i) => {
      flame.scale.set(1 + Math.sin(time * 7 + i) * 0.1, 0.85 + Math.sin(time * 10 + i * 2) * 0.13, 1);
      flame.rotation.z = Math.sin(time * 4 + i) * 0.07;
    });
    const emberPositions = this.embers.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < emberPositions.count; i++) {
      const life = (time * (0.19 + variation(i + 900) * 0.1) + i / emberPositions.count) % 1;
      emberPositions.setXYZ(i, Math.sin(time + i * 2) * (0.12 + life * 0.32), 0.5 + life * 2.1, Math.cos(time * 0.8 + i) * (0.1 + life * 0.25));
    }
    emberPositions.needsUpdate = true;
    this.waterLines.children.forEach((line, i) => { line.position.x += Math.sin(time * 0.7 + i) * Math.min(frame.delta, 0.1) * 0.09; });
    const charge = stage >= 4 || complete ? 1 : 0;
    const current = this.portalSurface.uniforms.charge.value as number;
    this.portalSurface.uniforms.charge.value = THREE.MathUtils.lerp(current, charge, 1 - Math.exp(-Math.max(0, frame.delta) * 3));
    this.portalSurface.uniforms.time.value = time;
    this.portalRunes.emissiveIntensity = 0.14 + current * (1.8 + Math.sin(time * 2) * 0.12);
    this.portalGlow.intensity = current * 35;
    this.objective.visible = stage >= 0 && !complete;
    this.objective.position.set(0, 0, stage >= 4 ? CAMPAIGN.destination.z : stage <= 0 ? 6 : CAMPAIGN.encounters[Math.min(stage - 1, 2)].z);
    this.objectiveGem.position.y = 2.8 + Math.sin(time * 2.4) * 0.13;
    this.objectiveGem.rotation.y = time * 0.7;
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.lighting.dispose(); this.moon.shadow.dispose(); this.moon.dispose(); this.fill.dispose(); this.portalGlow.dispose();
    this.root.traverse(object => { if (object instanceof THREE.InstancedMesh) object.dispose(); });
    this.root.removeFromParent(); this.root.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.geometries.clear(); this.materials.clear(); this.textures.clear();
    if (this.scene.background === this.background) this.scene.background = this.previousBackground;
    if (this.scene.fog === this.fog) this.scene.fog = this.previousFog;
  }
}
