import * as THREE from 'three';
import { createRecipeMaterial, type RecipeMaterial } from '../../sandbox/materialRecipes.ts';

/** Castle geometry sits outside the shared arena's playable collision ring. */
export class MedievalArena {
  readonly root = new THREE.Group();
  private readonly stone = new THREE.MeshStandardMaterial({ color: 0x9c957d, roughness: .93 });
  private readonly darkStone = new THREE.MeshStandardMaterial({ color: 0x555d57, roughness: .94 });
  private readonly trim = new THREE.MeshStandardMaterial({ color: 0xc5b797, roughness: .85 });
  private readonly wood = new THREE.MeshStandardMaterial({ color: 0x372d24, roughness: .94 });
  private readonly gold = new THREE.MeshStandardMaterial({ color: 0xa68d4b, metalness: .5, roughness: .53 });
  private readonly blue = new THREE.MeshStandardMaterial({ color: 0x264b62, roughness: 1, side: THREE.DoubleSide });
  private readonly red = new THREE.MeshStandardMaterial({ color: 0x7d3029, roughness: 1, side: THREE.DoubleSide });
  private readonly flame = new THREE.MeshBasicMaterial({ color: 0xffb34d });
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly banners: THREE.Group[] = [];
  private readonly fires: THREE.Mesh[] = [];
  private texture?: RecipeMaterial;
  private textureStatus = 'loading';
  private disposed = false;
  constructor(radius: number) {
    this.root.name = 'castle-courtyard';
    const box = (name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material = this.stone, parent: THREE.Object3D = this.root) => {
      const mesh = new THREE.Mesh(this.box, material); mesh.name = name; mesh.position.set(x, y, z); mesh.scale.set(w, h, d);
      mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
    };
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(radius + 2.6, radius + 2.6, .45, 64), this.darkStone);
    ground.position.y = -.24; ground.receiveShadow = true; this.root.add(ground);
    const places: [number, number][] = [];
    for (let x = -radius - 1; x <= radius + 1; x++) for (let z = -radius - 1; z <= radius + 1; z++) if (Math.hypot(x, z) < radius + 1.5) places.push([x, z]);
    const tiles = new THREE.InstancedMesh(this.box, this.stone, places.length), dummy = new THREE.Object3D();
    places.forEach(([x, z], i) => { dummy.position.set(x, -.05, z); dummy.scale.set(.973, .10, .973); dummy.updateMatrix(); tiles.setMatrixAt(i, dummy.matrix);
      tiles.setColorAt(i, new THREE.Color().setHSL(.12, .09, .72 + ((i * 17) % 9) * .017)); });
    tiles.receiveShadow = true; this.root.add(tiles);
    for (const r of [radius - .28, 3.4]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - .035, r + .035, 96), this.gold); ring.rotation.x = -Math.PI / 2; ring.position.y = .009; this.root.add(ring);
    }
    const compass = new THREE.Group(); compass.position.y = .013; this.root.add(compass);
    for (let i = 0; i < 8; i++) { const ray = box('courtyard-inlay', 0, 0, 0, .055, .008, 2.7, this.trim, compass); ray.rotation.y = i * Math.PI / 4; }
    const wallRadius = radius + 2.1, count = 24;
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * 2 / count, wall = new THREE.Group(); wall.position.set(Math.sin(angle) * wallRadius, 0, Math.cos(angle) * wallRadius); wall.rotation.y = angle; this.root.add(wall);
      const width = wallRadius * 2 * Math.sin(Math.PI / count) + .10;
      box('curtain-wall', 0, 2.3, 0, width, 4.6, .9, this.stone, wall);
      box('wall-plinth', 0, .24, -.08, width + .08, .48, 1.1, this.darkStone, wall);
      box('wall-cornice', 0, 4.5, 0, width + .13, .18, 1.07, this.trim, wall);
      for (const x of [-width * .32, width * .32]) box('crenellation', x, 4.95, 0, width * .29, .75, .96, this.stone, wall);
      box('stone-buttress', 0, 1.8, -.58, .38, 3.6, .6, this.trim, wall);
      if (i % 3 === 0) {
        const banner = new THREE.Group(); banner.position.set(.66, 3.65, -.58); wall.add(banner); this.banners.push(banner);
        box('banner-pole', 0, .06, 0, 1.0, .045, .045, this.gold, banner);
        box('house-banner', 0, -.80, 0, .72, 1.60, .025, i % 2 ? this.blue : this.red, banner);
        box('banner-cross-v', 0, -.66, -.02, .055, .77, .01, this.trim, banner);
        box('banner-cross-h', 0, -.48, -.025, .4, .055, .01, this.trim, banner);
      }
      if (i % 6 === 0) {
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.12, 1.35, 6.5, 12), this.stone); tower.position.set(0, 3.25, .8); tower.castShadow = true; wall.add(tower);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(1.28, 1.17, .25, 12), this.trim); top.position.set(0, 6.55, .8); wall.add(top);
        for (let n = 0; n < 8; n++) { const a = n * Math.PI / 4; box('tower-merlon', Math.sin(a) * 1.1, 7.0, .8 + Math.cos(a) * 1.1, .55, .7, .55, this.stone, wall); }
      }
    }
    // The closed portcullis is scenery beyond the playable wall.
    const gate = new THREE.Group(); gate.position.set(0, 0, -wallRadius + .7); this.root.add(gate);
    box('gate-shadow', 0, 1.75, 0, 2.2, 3.5, .15, this.wood, gate);
    for (let x = -.96; x <= 1; x += .32) box('portcullis-bar', x, 1.7, .14, .055, 3.4, .055, this.gold, gate);
    for (const y of [.7, 1.8, 2.9]) box('portcullis-crossbar', 0, y, .16, 2.15, .065, .055, this.gold, gate);
    for (const side of [-1, 1]) box('gate-column', side * 1.29, 1.9, .08, .4, 3.8, .5, this.trim, gate);
    box('gate-lintel', 0, 3.72, .08, 3.0, .42, .52, this.trim, gate);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2, x = Math.sin(a) * (radius + .9), z = Math.cos(a) * (radius + .9);
      box('brazier-plinth', x, .3, z, .55, .6, .55, this.darkStone);
      box('brazier-stem', x, .95, z, .12, 1.0, .12, this.gold);
      const bowl = new THREE.Mesh(new THREE.ConeGeometry(.34, .25, 8), this.wood); bowl.rotation.z = Math.PI; bowl.position.set(x, 1.42, z); this.root.add(bowl);
      const fire = new THREE.Mesh(new THREE.ConeGeometry(.17, .48, 7), this.flame); fire.position.set(x, 1.70, z); this.root.add(fire); this.fires.push(fire);
      const light = new THREE.PointLight(0xff9b42, 5, 5, 2); light.position.set(x, 1.9, z); this.root.add(light);
    }
    void createRecipeMaterial({ kind: 'texture', version: 1, name: 'Weathered limestone', id: 'duel.weathered-limestone', resolution: 128, seed: 713,
      layers: [
        { name: 'Limestone grain', source: { kind: 'noise', colors: ['#a09b87', '#b9b19a'], scale: 48 }, roughness: .94, metalness: 0, heightStrength: .14 },
        { name: 'Age and mineral flecks', source: { kind: 'noise', colors: ['#a19c87', '#c0b8a0'], scale: 12 }, opacity: .16, blend: 'multiply', heightStrength: .06 },
      ], reliefScale: .009, normalStrength: .35 }).then(texture => {
      if (this.disposed) { texture.dispose(); return; } this.texture = texture; this.textureStatus = 'ready';
      this.stone.color.setHex(0xffffff); this.stone.map = texture.maps.color; this.stone.normalMap = texture.maps.normal; this.stone.roughnessMap = texture.maps.roughness; this.stone.needsUpdate = true;
    }).catch(() => { this.textureStatus = 'fallback'; });
  }
  update(now: number): void {
    this.banners.forEach((banner, i) => { banner.rotation.x = Math.sin(now * .0018 + i) * .035; banner.rotation.z = Math.sin(now * .0011 + i) * .025; });
    this.fires.forEach((fire, i) => { fire.scale.set(1 + Math.sin(now * .013 + i) * .12, .85 + Math.sin(now * .019 + i) * .2, 1); fire.rotation.y = now * .0008 + i; });
  }
  inspection(): Record<string, unknown> { return { materialRecipe: 'duel.weathered-limestone', textureStatus: this.textureStatus, banners: this.banners.length, braziers: this.fires.length }; }
  dispose(): void { this.disposed = true; this.texture?.dispose(); disposeObject(this.root); }
}

export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
  geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); root.removeFromParent();
}
