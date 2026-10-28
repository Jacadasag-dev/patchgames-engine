/** Fracture presentation uses immutable prepared meshes and authoritative poses. */
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Quaternion, Vector3, type Material } from 'three';
import type { FractureSlab } from './fracture.ts';
import type { DestructionCluster, DestructionState } from './destruction.ts';

export interface FractureViewOptions {
  /** Optional original exterior skin in physical, slab-local coordinates.
   * Triangle UVs and material groups are clipped into the prepared cells.
   * The view borrows this input only during construction and owns its copies. */
  exteriorGeometry?: BufferGeometry;
}

interface SkinVertex { point: Vector3; normal: Vector3; u: number; v: number }
function clippedExterior(slab: FractureSlab, cell: FractureSlab['cells'][number], source: BufferGeometry,
  materialCount: number, useMaterialGroups: boolean): BufferGeometry {
  const positions = source.getAttribute('position'), normals = source.getAttribute('normal'), uvs = source.getAttribute('uv'), index = source.index;
  const vertexCount = index?.count ?? positions?.count ?? 0;
  if (!positions || positions.itemSize !== 3 || !normals || normals.itemSize !== 3 || !uvs || uvs.itemSize !== 2
    || normals.count !== positions.count || uvs.count !== positions.count || vertexCount % 3 !== 0 || vertexCount > 24576)
    throw new Error('Fracture exterior requires bounded triangle positions, normals and UVs.');
  const [axisU, axisV] = slab.axes, axisW = slab.thinAxis;
  const sourceRotation = new Quaternion().copy(slab.rotation), center = new Vector3().copy(cell.position).sub(slab.position).applyQuaternion(sourceRotation.invert());
  // Original Three geometry stores float32 coordinates. A boundary face can
  // therefore lie one float ULP beyond the double-precision prepared box.
  // Keep that face rather than clipping an entire exterior side away.
  const boundaryTolerance = Math.max(slab.size.x, slab.size.y, slab.size.z) * 1e-7;
  const planes: Array<(point: Vector3) => number> = cell.polygon.map((a, i) => {
    const b = cell.polygon[(i + 1) % cell.polygon.length], du = b.u - a.u, dv = b.v - a.v, length = Math.hypot(du, dv);
    return point => ((point[axisU] - a.u) * dv - (point[axisV] - a.v) * du) / length;
  });
  planes.push(point => point[axisW] - slab.size[axisW] / 2, point => -point[axisW] - slab.size[axisW] / 2);
  const vertices: number[] = [], directions: number[] = [], texture: number[] = [], groups: Array<{ start: number; count: number; materialIndex: number }> = [];
  const write = (vertex: SkinVertex) => {
    vertices.push(vertex.point.x - center.x, vertex.point.y - center.y, vertex.point.z - center.z);
    directions.push(vertex.normal.x, vertex.normal.y, vertex.normal.z); texture.push(vertex.u, vertex.v);
  };
  const appendGroup = (start: number, count: number, materialIndex: number) => {
    const previous = groups[groups.length - 1];
    if (previous?.materialIndex === materialIndex && previous.start + previous.count === start) previous.count += count;
    else groups.push({ start, count, materialIndex });
  };
  for (let triangle = 0; triangle < vertexCount; triangle += 3) {
    let polygon: SkinVertex[] = [0, 1, 2].map(offset => {
      const i = index ? index.getX(triangle + offset) : triangle + offset;
      return { point: new Vector3().fromBufferAttribute(positions, i), normal: new Vector3().fromBufferAttribute(normals, i), u: uvs.getX(i), v: uvs.getY(i) };
    });
    for (const distance of planes) {
      const next: SkinVertex[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length], da = distance(a.point), db = distance(b.point);
        if (da <= boundaryTolerance) next.push(a);
        if ((da <= boundaryTolerance) !== (db <= boundaryTolerance)) {
          const t = Math.max(0, Math.min(1, da / (da - db)));
          next.push({ point: a.point.clone().lerp(b.point, t), normal: a.normal.clone().lerp(b.normal, t).normalize(), u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
        }
      }
      polygon = next; if (polygon.length < 3) break;
    }
    if (polygon.length < 3) continue;
    const materialIndex = useMaterialGroups ? source.groups.find(group => triangle >= group.start && triangle + 2 < group.start + group.count)?.materialIndex ?? 0 : 0;
    if (!Number.isInteger(materialIndex) || materialIndex < 0 || materialIndex >= materialCount) throw new Error('Fracture exterior material group has no material.');
    const start = vertices.length / 3;
    for (let i = 1; i < polygon.length - 1; i++) {
      const a = polygon[0], b = polygon[i], c = polygon[i + 1];
      if (new Vector3().subVectors(b.point, a.point).cross(new Vector3().subVectors(c.point, a.point)).lengthSq() < 1e-20) continue;
      write(a); write(b); write(c);
    }
    const count = vertices.length / 3 - start; if (count) appendGroup(start, count, materialIndex);
  }
  const cutStart = vertices.length / 3;
  for (const group of cell.geometry.groups) if (group.materialIndex === 1) for (let i = group.start; i < group.start + group.count; i++) {
    vertices.push(...cell.geometry.positions.slice(i * 3, i * 3 + 3)); directions.push(...cell.geometry.normals.slice(i * 3, i * 3 + 3)); texture.push(...cell.geometry.uvs.slice(i * 2, i * 2 + 2));
  }
  const cutCount = vertices.length / 3 - cutStart; if (cutCount) appendGroup(cutStart, cutCount, materialCount);
  const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(directions, 3)); geometry.setAttribute('uv', new Float32BufferAttribute(texture, 2));
  for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

/** The intact skin uses one transform so float32 fragment transforms cannot
 * reveal hairline seams before damage. UVs match every prepared exterior face. */
function intactGeometry(slab: FractureSlab): BufferGeometry {
  type Point = [number, number, number];
  const [axisU, axisV] = slab.axes, axisW = slab.thinAxis;
  const u = slab.size[axisU] / 2, v = slab.size[axisV] / 2, w = slab.size[axisW] / 2;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const vector = (point: Point): Vector3 => { const value = new Vector3(); value[axisU] = point[0]; value[axisV] = point[1]; value[axisW] = point[2]; return value; };
  const quad = (points: Point[], normal: Point, uvAxes: [number, number], uvHalf: [number, number]) => {
    const n = vector(normal);
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const point = points[index], p = vector(point);
      positions.push(p.x, p.y, p.z); normals.push(n.x, n.y, n.z);
      uvs.push(point[uvAxes[0]] / (2 * uvHalf[0]) + .5, point[uvAxes[1]] / (2 * uvHalf[1]) + .5);
    }
  };
  quad([[-u, -v, w], [u, -v, w], [u, v, w], [-u, v, w]], [0, 0, 1], [0, 1], [u, v]);
  quad([[-u, v, -w], [u, v, -w], [u, -v, -w], [-u, -v, -w]], [0, 0, -1], [0, 1], [u, v]);
  quad([[-u, -v, -w], [u, -v, -w], [u, -v, w], [-u, -v, w]], [0, -1, 0], [0, 2], [u, w]);
  quad([[u, -v, -w], [u, v, -w], [u, v, w], [u, -v, w]], [1, 0, 0], [1, 2], [v, w]);
  quad([[u, v, -w], [-u, v, -w], [-u, v, w], [u, v, w]], [0, 1, 0], [0, 2], [u, w]);
  quad([[-u, v, -w], [-u, -v, -w], [-u, -v, w], [-u, v, w]], [-1, 0, 0], [1, 2], [v, w]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export class FractureView {
  readonly group = new Group();
  readonly root = this.group;
  private readonly slab: FractureSlab;
  private readonly meshes = new Map<string, Mesh>();
  private intact?: Mesh;
  private disposed = false;
  constructor(slab: FractureSlab, exteriorMaterial: Material | Material[], interiorMaterial: Material, options: FractureViewOptions = {}) {
    this.slab = slab; this.group.name = `fracture:${slab.id}`;
    const exteriorMaterials = Array.isArray(exteriorMaterial) ? exteriorMaterial : [exteriorMaterial];
    if (!exteriorMaterials.length) throw new Error('Fracture view requires an exterior material.');
    if (exteriorMaterials.length > 1 && !options.exteriorGeometry) throw new Error('Multiple fracture exterior materials require original exterior geometry.');
    try {
      this.intact = new Mesh(options.exteriorGeometry?.clone() ?? intactGeometry(slab), exteriorMaterial);
      if (Array.isArray(exteriorMaterial) && !this.intact.geometry.groups.length)
        this.intact.geometry.addGroup(0, this.intact.geometry.index?.count ?? this.intact.geometry.getAttribute('position').count, 0);
      this.intact.name = `${slab.id}:intact`; this.intact.castShadow = true; this.intact.receiveShadow = true;
      this.intact.position.copy(slab.position); this.intact.quaternion.copy(slab.rotation); this.group.add(this.intact);
      for (const cell of slab.cells) {
        let geometry: BufferGeometry;
        if (options.exteriorGeometry) geometry = clippedExterior(slab, cell, options.exteriorGeometry, exteriorMaterials.length, Array.isArray(exteriorMaterial));
        else {
          geometry = new BufferGeometry();
          geometry.setAttribute('position', new Float32BufferAttribute(cell.geometry.positions, 3));
          geometry.setAttribute('normal', new Float32BufferAttribute(cell.geometry.normals, 3));
          geometry.setAttribute('uv', new Float32BufferAttribute(cell.geometry.uvs, 2));
          for (const group of cell.geometry.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
          geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        }
        const mesh = new Mesh(geometry, [...exteriorMaterials, interiorMaterial]); mesh.name = cell.id; mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.position.copy(cell.position); mesh.quaternion.copy(slab.rotation); mesh.visible = false;
        this.meshes.set(cell.id, mesh); this.group.add(mesh);
      }
    } catch (error) { this.dispose(); throw error; }
  }
  update(state: DestructionState): void {
    if (this.disposed) throw new Error('FractureView has been disposed.');
    const owners = new Map<string, DestructionCluster>();
    for (const cluster of state.clusters) {
      if (![cluster.position.x, cluster.position.y, cluster.position.z, cluster.origin.x, cluster.origin.y, cluster.origin.z].every(Number.isFinite)
        || ![cluster.rotation.x, cluster.rotation.y, cluster.rotation.z, cluster.rotation.w].every(Number.isFinite)
        || Math.abs(Math.hypot(cluster.rotation.x, cluster.rotation.y, cluster.rotation.z, cluster.rotation.w) - 1) > .001) throw new Error('Fracture view requires finite normalized cluster poses.');
      for (const id of cluster.memberIds) { if (owners.has(id)) throw new Error('Fracture view requires unique cluster membership.'); owners.set(id, cluster); }
    }
    const fractured = this.slab.cells.some(cell => owners.has(cell.id));
    this.intact!.visible = !fractured;
    const rotation = new Quaternion(), offset = new Vector3();
    for (const cell of this.slab.cells) {
      const mesh = this.meshes.get(cell.id)!, cluster = owners.get(cell.id);
      mesh.visible = fractured;
      mesh.position.copy(cell.position); mesh.quaternion.copy(this.slab.rotation);
      if (cluster) {
        rotation.copy(cluster.rotation); offset.copy(cell.position).sub(cluster.origin).applyQuaternion(rotation).add(cluster.position);
        mesh.position.copy(offset); mesh.quaternion.premultiply(rotation);
      }
    }
  }
  /** Caller owns materials, which may be shared by many prepared slabs. */
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.intact?.geometry.dispose();
    for (const mesh of this.meshes.values()) mesh.geometry.dispose();
    this.meshes.clear(); this.group.clear(); this.group.removeFromParent();
  }
}
