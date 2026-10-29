import * as THREE from 'three';
import type { TerrainAsset } from '../sandbox/terrain.ts';
import { arenaBuildingParts } from './layout.ts';

/** Editable prototypes consumed by the shared TerrainView instancer. Generation,
 * collision, transforms, reservations and resource ownership stay in that API. */
export function createArenaTerrainAsset(asset: Readonly<TerrainAsset>): THREE.Object3D | undefined {
  const kind = asset.appearance?.kind;
  if (typeof kind !== 'string' || !kind.startsWith('arena-')) return undefined;
  const root = new THREE.Group();
  const mat = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color, roughness: .92, flatShading: true });
  const wood = mat('#5c4b36'), stone = mat('#969b88'), darkStone = mat('#686f61');
  const tint = typeof asset.appearance?.color === 'string' ? asset.appearance.color : '#527451';
  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true; root.add(mesh); return mesh;
  };
  const box = (width: number, height: number, depth: number, material: THREE.Material, x = 0, y = 0, z = 0) =>
    part(new THREE.BoxGeometry(width, height, depth), material, x, y, z);
  if (kind === 'arena-pine') {
    const h = Number(asset.appearance?.height ?? 10.5), leaves = mat(tint);
    part(new THREE.CylinderGeometry(.23, .38, h * .58, 7), wood, 0, h * .29);
    // Foliage begins overhead; the declared footprint/collider covers the trunk.
    for (let index = 0; index < 4; index++) {
      const canopy = part(new THREE.ConeGeometry(h * (.27 - index * .043), h * .35, 8), leaves,
        Math.sin(index * 1.7) * .13, h * (.48 + index * .14), Math.cos(index * 1.7) * .13);
      canopy.rotation.y = index * .4;
    }
  } else if (kind === 'arena-oak') {
    const h = Number(asset.appearance?.height ?? 9), leaves = mat(tint), light = mat('#879852');
    part(new THREE.CylinderGeometry(.3, .44, h * .62, 7), wood, 0, h * .31);
    for (const [x, y, z, size] of [[0, .8, 0, .33], [-.2, .67, .08, .25], [.22, .7, -.1, .26], [.04, .7, .24, .24]]) {
      const crown = part(new THREE.IcosahedronGeometry(h * size, 1), x > 0 ? light : leaves, x * h, y * h, z * h);
      crown.scale.set(1.1, .86, 1);
    }
  } else if (kind === 'arena-boulder') {
    const rock = part(new THREE.DodecahedronGeometry(1.7, 1), mat(tint), 0, 1.2, 0);
    rock.scale.set(1, .9, 1); rock.rotation.set(.1, .23, .12);
  } else if (['arena-camp', 'arena-lookout', 'arena-ruin', 'arena-shrine'].includes(kind)) {
    const timber = kind === 'arena-camp' || kind === 'arena-shrine';
    const wall = timber ? mat(kind === 'arena-camp' ? '#967c59' : '#9b8b6c') : stone;
    const roof = timber ? mat('#625b45') : darkStone;
    for (const piece of arenaBuildingParts()) {
      const mesh = box(piece.width, piece.height, piece.depth, piece.material === 'roof' ? roof : wall, piece.x, piece.y, piece.z);
      mesh.name = piece.id;
    }
    // The floor is the flattened heightfield, so entering needs no stair/jump.
    // Door frame and interior trim make the opening legible in first person.
    for (const side of [-1, 1]) box(.15, 3.3, .45, wood, side * 1.45, 1.65, 4);
    box(3.05, .18, .45, wood, 0, 3.28, 4);
    if (timber) {
      for (let y = .45; y < 3.3; y += .5) {
        box(8.02, .045, .035, wood, 0, y, -4.19);
        for (const side of [-1, 1]) box(2.6, .045, .035, wood, side * 2.7, y, 4.19);
      }
      // A pitched cap sits over the authoritative, blocking ceiling.
      for (const side of [-1, 1]) {
        const slope = box(4.6, .15, 8.8, roof, side * 2.1, 4.15); slope.rotation.z = -side * .25;
      }
    } else {
      for (const x of [-3.5, -1.75, 0, 1.75, 3.5]) for (const z of [-3.8, 3.8]) box(.8, .65, .7, stone, x, 4, z);
      for (const y of [.7, 1.4, 2.1, 2.8]) {
        box(8.36, .035, .035, darkStone, 0, y, -4.19);
        for (const side of [-1, 1]) {
          box(.035, .035, 8.36, darkStone, side * 4.19, y);
          box(2.6, .035, .035, darkStone, side * 2.7, y, 4.19);
        }
      }
    }
    // Shallow wall-mounted sconces do not occupy playable floor space.
    const lamp = new THREE.MeshStandardMaterial({ color: '#edcd80', emissive: '#d9ab55', emissiveIntensity: .65, roughness: .6 });
    for (const side of [-1, 1]) {
      box(.26, .55, .18, wood, side * 2.8, 2.15, 3.76);
      box(.18, .3, .2, lamp, side * 2.8, 2.45, 3.75);
    }
  } else {
    wood.dispose(); stone.dispose(); darkStone.dispose(); return undefined;
  }
  // Prototypes own only used resources; TerrainView disposes those after removal.
  const used = new Set<THREE.Material>(); root.traverse(object => {
    if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) used.add(material);
  });
  for (const material of [wood, stone, darkStone]) if (!used.has(material)) material.dispose();
  return root;
}
