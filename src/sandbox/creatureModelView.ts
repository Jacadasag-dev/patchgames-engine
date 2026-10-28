import { BufferAttribute, BufferGeometry, DoubleSide, Float32BufferAttribute, FrontSide, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh } from 'three';
import { sharedCreatureAnimations, type SharedCreatureBank } from './creatureAnimationLibrary.ts';
import { createCreatureSkeleton } from './creatureAnimationView.ts';
import { CREATURE_MODEL_DATA } from './creatureModelData.ts';

export interface PackedCreatureModel {
  readonly version: 'packed-creature-model-v1'; readonly id: string; readonly rigId: string;
  readonly source: { readonly library: string; readonly url: string; readonly license: 'CC0-1.0'; readonly sourceSha256: string };
  readonly skins: readonly string[];
  readonly primitives: readonly {
    readonly name: string; readonly vertices: number; readonly min: readonly number[]; readonly span: readonly number[];
    readonly data: string; readonly indices: string; readonly doubleSided: boolean; readonly metalness: number; readonly roughness: number;
    readonly skin?: number;
  }[];
}

/** Portable bounded decoder: previews run without DOM atob or Node Buffer. */
function bytes(value: string, maximum: number): Uint8Array {
  if (value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid packed creature mesh.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', count = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (count > maximum) throw new Error('Creature mesh exceeds its budget.');
  const result = new Uint8Array(count);
  let output = 0;
  for (let i = 0; i < value.length; i += 4) {
    const packed = alphabet.indexOf(value[i]) << 18 | alphabet.indexOf(value[i + 1]) << 12 | Math.max(0, alphabet.indexOf(value[i + 2])) << 6 | Math.max(0, alphabet.indexOf(value[i + 3]));
    for (const shift of [16, 8, 0]) if (output < count) result[output++] = packed >> shift & 255;
  }
  return result;
}
const linear = (n: number) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;

export type CreatureModelView = ReturnType<typeof createCreatureSkeleton> & {
  readonly meshes: readonly SkinnedMesh<BufferGeometry, MeshStandardMaterial>[];
  readonly provenance: PackedCreatureModel['source'];
  dispose(): void;
};

/** Create a complete CC0 source body bound to the same authentic creature rig
 * used by shared clips, motion matching, and terrain feet. Apply poses through
 * animationRig; parent root under an authoritative gameplay actor. Atlas colors
 * are baked into vertices offline; no URLs, loaders, or separate mixers run here.
 * Call dispose() when removing this actor. Custom models may still use
 * createCreatureSkeleton() directly with their own compatible weighted geometry. */
export function createCreatureModel(bankOrId: string | SharedCreatureBank, options: { scale?: number } = {}): CreatureModelView {
  const bank = typeof bankOrId === 'string' ? sharedCreatureAnimations(bankOrId) : bankOrId;
  const model = CREATURE_MODEL_DATA.find(entry => entry.id === bank.id);
  if (!model || model.rigId !== bank.rigId || model.version !== 'packed-creature-model-v1') throw new Error(`No matching shared creature body: ${bank.id}`);
  const actor = createCreatureSkeleton(bank, options), scale = options.scale ?? 1, meshes: SkinnedMesh<BufferGeometry, MeshStandardMaterial>[] = [];
  const skins = model.skins.map(value => {
    const source = bytes(value, actor.skeleton.bones.length * 64);
    if (source.length !== actor.skeleton.bones.length * 64) throw new Error('Truncated creature inverse bind matrices.');
    const view = new DataView(source.buffer), inverses = actor.skeleton.bones.map((_, i) => {
      const matrix = new Matrix4().fromArray(Array.from({ length: 16 }, (_, c) => view.getFloat32(i * 64 + c * 4, true)));
      if (matrix.elements.some(n => !Number.isFinite(n))) throw new Error('Invalid creature inverse bind matrix.');
      matrix.elements[12] *= scale; matrix.elements[13] *= scale; matrix.elements[14] *= scale; return matrix;
    });
    return new Skeleton(actor.skeleton.bones, inverses);
  });
  for (const primitive of model.primitives) {
    const count = primitive.vertices;
    if (!Number.isInteger(count) || count < 1 || count > 65535 || primitive.min.length !== 3 || primitive.span.length !== 3
      || [...primitive.min, ...primitive.span].some(n => !Number.isFinite(n)) || primitive.span.some(n => n < 0)) throw new Error('Invalid creature mesh dimensions.');
    const source = bytes(primitive.data, count * 20), triangles = bytes(primitive.indices, 65535 * 6);
    if (source.length !== count * 20 || triangles.length % 6) throw new Error('Truncated creature geometry.');
    const data = new DataView(source.buffer), triangleView = new DataView(triangles.buffer);
    const positions = new Float32Array(count * 3), normals = new Int8Array(count * 3), colors = new Float32Array(count * 3);
    const joints = new Uint8Array(count * 4), weights = new Uint8Array(count * 4), indices = new Uint16Array(triangles.length / 2);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        positions[i * 3 + c] = (primitive.min[c] + data.getUint16(i * 20 + c * 2, true) / 65535 * primitive.span[c]) * scale;
        normals[i * 3 + c] = data.getInt8(i * 20 + 6 + c);
        colors[i * 3 + c] = linear(data.getUint8(i * 20 + 9 + c) / 255);
      }
      for (let c = 0; c < 4; c++) {
        joints[i * 4 + c] = data.getUint8(i * 20 + 12 + c); weights[i * 4 + c] = data.getUint8(i * 20 + 16 + c); sum += weights[i * 4 + c];
        if (joints[i * 4 + c] >= actor.skeleton.bones.length) throw new Error('Creature mesh references a missing joint.');
      }
      if (sum !== 255) throw new Error('Creature skin weights must sum to one.');
    }
    for (let i = 0; i < indices.length; i++) { indices[i] = triangleView.getUint16(i * 2, true); if (indices[i] >= count) throw new Error('Invalid creature triangle.'); }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3, true));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setAttribute('skinIndex', new BufferAttribute(joints, 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4, true));
    geometry.setIndex(new BufferAttribute(indices, 1)); geometry.computeBoundingSphere();
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: primitive.roughness, metalness: primitive.metalness,
      side: primitive.doubleSided ? DoubleSide : FrontSide });
    const mesh = new SkinnedMesh(geometry, material); mesh.name = primitive.name; mesh.castShadow = true; mesh.receiveShadow = true;
    // Bind vertices and inverse bones in canonical rest coordinates. Attached
    // bind mode removes the mesh parent's current world transform exactly once.
    const skeleton = primitive.skin === undefined ? actor.skeleton : skins[primitive.skin];
    if (!skeleton) throw new Error('Missing creature bind matrices.');
    mesh.bind(skeleton, new Matrix4()); mesh.frustumCulled = false; actor.root.add(mesh); meshes.push(mesh);
  }
  actor.root.updateMatrixWorld(true); actor.skeleton.update();
  let disposed = false;
  return { ...actor, meshes: Object.freeze(meshes), provenance: Object.freeze({ ...model.source }), dispose() {
    if (disposed) return; disposed = true;
    for (const mesh of meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); }
    for (const skeleton of skins) skeleton.dispose(); actor.skeleton.dispose(); actor.root.removeFromParent();
  } };
}
