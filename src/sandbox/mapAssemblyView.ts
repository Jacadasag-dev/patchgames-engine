/** Static exact-map presentation. Geometry comes only from the compiled manifest;
 * inspection observes this real subtree without running during ordinary frames. */
import { BufferGeometry, CanvasTexture, Float32BufferAttribute, FrontSide, Group, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, SRGBColorSpace, Vector3, type Material, type Object3D } from 'three';
import { MAP_ASSEMBLY_LIMITS, type MapAssemblyManifest, type MapPart, type MapSign, type MapVector } from './mapAssembly.ts';
import { SurfaceMaterialCache, type SurfaceMaterialHandle } from './surfaceMaterialView.ts';

export interface MapAssemblyViewOptions { materialCache?: SurfaceMaterialCache; allowInvalid?: boolean }
export interface MapRenderIssue { code: string; ids: string[]; message: string; severity: 'error' | 'incomplete'; measured?: number; expected?: number; omittedIds?: number }
export interface MapAssemblyRenderInspection {
  revision: string; status: 'passed' | 'failed' | 'incomplete';
  parts: number; batches: number; signs: number; checkedParts: number;
  textApproaches: { checked: number; minimumPixelHeight: number | null };
  issueCount: number; omittedIssues: number; issues: MapRenderIssue[];
  scope: 'compiled-static-map-subtree';
  limitations: string[];
}
interface Span { id: string; start: number; end: number }
interface Batch { key: string; parts: MapPart[] }
interface ObservedMesh {
  mesh: Mesh; geometry: BufferGeometry; material: Material;
  positions: Float32Array; normals: Float32Array; uvs: Float32Array; spans: Span[];
  color: number; beforeCompile: Material['onBeforeCompile']; programKey: Material['customProgramCacheKey'];
  renderOrder: number; texture?: CanvasTexture<OffscreenCanvas | HTMLCanvasElement>; textureVersion?: number;
}
const identity = new Matrix4();
const toWorld = (part: MapPart, point: MapVector): Vector3 => new Vector3(
  point.x * Math.cos(part.yaw) + point.z * Math.sin(part.yaw) + part.position.x, point.y + part.position.y,
  -point.x * Math.sin(part.yaw) + point.z * Math.cos(part.yaw) + part.position.z);
const changed = (source: ArrayLike<number> | undefined, expected: Float32Array, first: number, last: number) => {
  if (!source || source.length !== expected.length) return true;
  for (let i = first; i < last; i++) if (source[i] !== expected[i]) return true;
  return false;
};
function geometry(positions: number[], normals: number[], uvs: number[]): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute('position', new Float32BufferAttribute(positions, 3));
  result.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  result.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  result.computeBoundingSphere(); result.computeBoundingBox(); return result;
}
function appendPart(part: MapPart, positions: number[], normals: number[], uvs: number[]): Span {
  const start = positions.length / 3;
  if (!part.indices.length || part.indices.length % 3 || part.indices.some(index => !Number.isInteger(index) || index < 0 || index >= part.vertices.length)
    || ![part.position.x, part.position.y, part.position.z, part.yaw, ...part.vertices.flatMap(p => [p.x, p.y, p.z])].every(Number.isFinite))
    throw new Error(`Map part ${part.id} has invalid compiled geometry.`);
  for (let i = 0; i < part.indices.length; i += 3) {
    const local = part.indices.slice(i, i + 3).map(index => part.vertices[index]);
    const triangle = local.map(vertex => toWorld(part, vertex));
    const normal = new Vector3().subVectors(triangle[1], triangle[0]).cross(new Vector3().subVectors(triangle[2], triangle[0]));
    if (normal.lengthSq() < 1e-16) throw new Error(`Map part ${part.id} contains a degenerate rendered triangle.`);
    normal.normalize();
    const localNormal = new Vector3().subVectors(new Vector3().copy(local[1]), local[0])
      .cross(new Vector3().subVectors(new Vector3().copy(local[2]), local[0])).normalize();
    const x = Math.abs(localNormal.x), y = Math.abs(localNormal.y), z = Math.abs(localNormal.z);
    for (let vertex = 0; vertex < 3; vertex++) {
      positions.push(triangle[vertex].x, triangle[vertex].y, triangle[vertex].z);
      normals.push(normal.x, normal.y, normal.z);
      const point = local[vertex];
      // Ownership partitioning must not restart the same floor texture at every
      // tile edge. Horizontal walking surfaces share map-space metre UVs.
      if ((part.role === 'floor' || part.role === 'terrain') && y > .999999) uvs.push(triangle[vertex].x, triangle[vertex].z);
      else uvs.push(...(x >= y && x >= z ? [point.z, point.y] : y >= z ? [point.x, point.z] : [point.x, point.y]));
    }
  }
  return { id: part.id, start, end: positions.length / 3 };
}
function signCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | undefined {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; }
  return undefined;
}

export class MapAssemblyView {
  readonly root: Group = new Group();
  readonly manifest: MapAssemblyManifest;
  private readonly cache: SurfaceMaterialCache;
  private readonly ownCache: boolean;
  private readonly handles: SurfaceMaterialHandle[] = [];
  private readonly materials: MeshStandardMaterial[] = [];
  private readonly observed: ObservedMesh[] = [];
  private readonly persistentIssues: MapRenderIssue[] = [];
  private readonly ready: Promise<void>[] = [];
  private readonly signChecks: { sign: MapSign; center: Vector3; height: number }[] = [];
  private pending = 0;
  private disposed = false;
  private batches = 0;
  private renderedSigns = 0;
  constructor(manifest: MapAssemblyManifest, options: MapAssemblyViewOptions = {}) {
    if (!manifest?.diagnostics || !manifest.diagnostics.valid && !options.allowInvalid) throw new Error('MapAssemblyView requires a valid compiled map; allowInvalid is inspection-only.');
    if (!Array.isArray(manifest.parts) || manifest.parts.length > MAP_ASSEMBLY_LIMITS.parts || !Array.isArray(manifest.signs) || manifest.signs.length > MAP_ASSEMBLY_LIMITS.signs)
      throw new Error('MapAssemblyView requires bounded compiled parts and signs.');
    this.manifest = manifest; this.cache = options.materialCache ?? new SurfaceMaterialCache(); this.ownCache = !options.materialCache;
    this.root.name = `map:${manifest.id}`;
    this.root.userData.mapAssembly = { id: manifest.id, revision: manifest.revision };
    try {
      const batches = new Map<string, Batch>();
      for (const part of manifest.parts) {
        const key = part.material ? `material:${part.material.key}` : `color:${part.color}`;
        let batch = batches.get(key); if (!batch) { batch = { key, parts: [] }; batches.set(key, batch); } batch.parts.push(part);
      }
      for (const batch of batches.values()) this.addBatch(batch);
      const parts = new Map(manifest.parts.map(part => [part.id, part]));
      for (const sign of manifest.signs) this.addSign(sign, parts.get(sign.part));
    } catch (error) { this.dispose(); throw error; }
  }
  private observe(mesh: Mesh, spans: Span[], texture?: CanvasTexture<OffscreenCanvas | HTMLCanvasElement>): void {
    const material = mesh.material as MeshStandardMaterial | MeshBasicMaterial;
    this.observed.push({ mesh, geometry: mesh.geometry, material,
      positions: new Float32Array(mesh.geometry.getAttribute('position').array), normals: new Float32Array(mesh.geometry.getAttribute('normal').array),
      uvs: new Float32Array(mesh.geometry.getAttribute('uv').array), spans, color: material.color.getHex(),
      beforeCompile: material.onBeforeCompile, programKey: material.customProgramCacheKey, renderOrder: mesh.renderOrder, texture, textureVersion: texture?.version });
    this.root.add(mesh);
  }
  private addBatch(batch: Batch): void {
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
    const spans = batch.parts.map(part => appendPart(part, positions, normals, uvs));
    const first = batch.parts[0]; let material: MeshStandardMaterial;
    if (first.material) {
      const handle = this.cache.acquire(first.material, { side: FrontSide }); this.handles.push(handle); material = handle.material; this.pending++;
      const ready = handle.ready.then(() => { this.pending--; }, error => {
        this.pending--; this.persistentIssues.push({ code: 'map-material-failed', ids: batch.parts.map(part => part.id), severity: 'incomplete', message: error instanceof Error ? error.message : String(error) });
        throw error;
      });
      this.ready.push(ready); void ready.catch(() => undefined);
    } else { material = new MeshStandardMaterial({ color: first.color, roughness: .85, side: FrontSide }); this.materials.push(material); }
    const mesh = new Mesh(geometry(positions, normals, uvs), material);
    mesh.name = `map-batch:${this.batches++}`; mesh.userData.mapPartIds = spans.map(span => span.id);
    mesh.castShadow = mesh.receiveShadow = true; this.observe(mesh, spans);
  }
  private addSign(sign: MapSign, part?: MapPart): void {
    const face = part?.faces.find(item => item.id === 'front');
    if (!part || !face) { this.persistentIssues.push({ code: 'map-sign-face', ids: [sign.part], severity: 'error', message: 'Sign needs the compiled front face of its board.' }); return; }
    const projection = (axis: MapVector) => face.vertices.map(p => (p.x - face.center.x) * axis.x + (p.y - face.center.y) * axis.y + (p.z - face.center.z) * axis.z);
    const us = projection(face.u), vs = projection(face.v);
    // Exactly the compiler's protected text area: 80% width and 64% height.
    const width = (Math.max(...us) - Math.min(...us)) * .8, height = (Math.max(...vs) - Math.min(...vs)) * .64;
    if (width <= 0 || height <= 0) throw new Error(`Sign ${sign.part} has an empty text face.`);
    const canvasWidth = Math.max(128, Math.min(1024, Math.ceil(width / height * 256))), canvasHeight = 256;
    const canvas = signCanvas(canvasWidth, canvasHeight), context = canvas?.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null | undefined;
    if (!canvas || !context) { this.persistentIssues.push({ code: 'map-sign-canvas', ids: [sign.part], severity: 'incomplete', message: 'This environment cannot render sign text; inspect in the real browser renderer.' }); return; }
    context.fillStyle = sign.background ?? '#142d30'; context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.fillStyle = sign.color ?? '#fff4d8'; context.textAlign = 'center'; context.textBaseline = 'middle';
    let fontSize = Math.floor(canvasHeight * .82); context.font = `700 ${fontSize}px sans-serif`;
    const text = sign.text;
    fontSize = Math.max(8, Math.floor(fontSize * Math.min(1, canvasWidth * .86 / Math.max(1, context.measureText(text).width))));
    context.font = `700 ${fontSize}px sans-serif`;
    const metrics = context.measureText(text), glyphHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    if (metrics.width > canvasWidth * .86 + 1 || glyphHeight > canvasHeight * .9)
      this.persistentIssues.push({ code: 'map-sign-text-fit', ids: [sign.part], severity: 'error', message: 'Actual sign glyphs do not fit their protected text region.' });
    if (!Number.isFinite(glyphHeight) || glyphHeight <= 0)
      this.persistentIssues.push({ code: 'map-sign-text-metrics', ids: [sign.part], severity: 'incomplete', message: 'Actual glyph height is unavailable; text pixel readability cannot be established.' });
    else this.signChecks.push({ sign, center: toWorld(part, face.center), height: height * glyphHeight / canvasHeight });
    context.fillText(text, canvasWidth / 2, canvasHeight / 2);
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({ map: texture, side: FrontSide, toneMapped: false });
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const normal = new Vector3(face.normal.x * Math.cos(part.yaw) + face.normal.z * Math.sin(part.yaw), face.normal.y,
      -face.normal.x * Math.sin(part.yaw) + face.normal.z * Math.cos(part.yaw));
    const triangle = new Vector3().crossVectors(new Vector3().copy(face.u), new Vector3().copy(face.v)).dot(new Vector3().copy(face.normal)) > 0
      ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const index of triangle) {
      const [u, v] = corners[index], at = toWorld(part, { x: face.center.x + face.u.x * u * width / 2 + face.v.x * v * height / 2 + face.normal.x * .001,
        y: face.center.y + face.u.y * u * width / 2 + face.v.y * v * height / 2 + face.normal.y * .001,
        z: face.center.z + face.u.z * u * width / 2 + face.v.z * v * height / 2 + face.normal.z * .001 });
      positions.push(at.x, at.y, at.z); normals.push(normal.x, normal.y, normal.z); uvs.push((u + 1) / 2, (v + 1) / 2);
    }
    const mesh = new Mesh(geometry(positions, normals, uvs), material); mesh.name = `map-sign:${sign.part}`;
    mesh.userData.mapSign = { part: sign.part, text, fontSize, canvasWidth, canvasHeight, textWidth: context.measureText(text).width };
    this.observe(mesh, [{ id: sign.part, start: 0, end: 6 }], texture); this.renderedSigns++;
  }
  async readyMaterials(): Promise<void> { await Promise.all(this.ready); }
  /** Verifies the current render representation against its captured exact
   * revision. No camera, whole-scene occlusion or traversal guarantee is implied. */
  inspection(): MapAssemblyRenderInspection {
    const issues: MapRenderIssue[] = [], checkedParts = new Set<string>(); let issueCount = 0, hasError = false, hasIncomplete = false;
    let textApproaches = 0, minimumPixelHeight = Infinity;
    const add = (issue: MapRenderIssue) => { issueCount++; hasError ||= issue.severity === 'error'; hasIncomplete ||= issue.severity === 'incomplete';
      if (issues.length < MAP_ASSEMBLY_LIMITS.issues) issues.push({ ...issue, ids: issue.ids.slice(0, 24), ...(issue.ids.length > 24 ? { omittedIds: issue.ids.length - 24 } : {}) }); };
    if (this.disposed) add({ code: 'map-view-disposed', ids: [], severity: 'incomplete', message: 'The compiled map view has been disposed.' });
    this.root.updateWorldMatrix(true, true);
    if (!this.root.matrixWorld.equals(identity) || !this.root.visible) add({ code: 'map-root-transform', ids: [], severity: 'error', message: 'The map root is moved, scaled, rotated or hidden; rendered placement no longer matches authoritative geometry.' });
    const expected = new Set<Object3D>([this.root, ...this.observed.map(item => item.mesh)]);
    this.root.traverse(object => { if (!expected.has(object)) add({ code: 'map-unregistered-object', ids: [object.name || object.type], severity: 'incomplete', message: 'Additional map geometry has no compiled connection, surface or rendering coverage.' }); });
    for (const observed of this.observed) {
      const { mesh, material, spans } = observed, ids = spans.map(span => span.id);
      if (mesh.parent !== this.root || !mesh.visible) { add({ code: 'map-part-missing', ids, severity: 'error', message: 'Compiled map geometry has been removed, reparented or hidden.' }); continue; }
      if (!mesh.matrixWorld.equals(identity) || mesh.layers.mask !== 1) add({ code: 'map-part-transform', ids, severity: 'error', message: 'A rendered map batch has a transform or layer change absent from the compiled revision.' });
      if (mesh.geometry !== observed.geometry || mesh.geometry.index || mesh.geometry.drawRange.start !== 0 || mesh.geometry.drawRange.count !== Infinity)
        add({ code: 'map-geometry-replaced', ids, severity: 'error', message: 'Rendered geometry or its triangle range differs from the compiled revision.' });
      const attrs = mesh.geometry.attributes;
      for (const span of spans) {
        if (changed(attrs.position?.array, observed.positions, span.start * 3, span.end * 3)
          || changed(attrs.normal?.array, observed.normals, span.start * 3, span.end * 3)
          || changed(attrs.uv?.array, observed.uvs, span.start * 2, span.end * 2))
          add({ code: 'map-geometry-mutated', ids: [span.id], severity: 'error', message: 'Actual rendered vertices, normals or texture coordinates changed after compilation.' });
        checkedParts.add(span.id);
      }
      if (mesh.material !== material || material.side !== FrontSide || !material.visible || material.opacity !== 1 || !material.depthTest || !material.depthWrite
        || (material as MeshStandardMaterial).color.getHex() !== observed.color || mesh.renderOrder !== observed.renderOrder
        || material.onBeforeCompile !== observed.beforeCompile || material.customProgramCacheKey !== observed.programKey)
        add({ code: 'map-material-mutated', ids, severity: 'error', message: 'Rendering material, face culling, depth behavior or shader differs from the inspected map contract.' });
      if (observed.texture && ((material as MeshBasicMaterial).map !== observed.texture || observed.texture.version !== observed.textureVersion))
        add({ code: 'map-sign-texture', ids, severity: 'error', message: 'Rendered sign text has been replaced or updated since the readability contract was compiled.' });
    }
    for (const check of this.signChecks) for (const approach of check.sign.approaches) {
      const distance = check.center.distanceTo(new Vector3().copy(approach.position));
      const pixelHeight = check.height * (approach.viewportHeight ?? 1080) / (2 * Math.max(distance, .001) * Math.tan((approach.fov ?? 75) * Math.PI / 360));
      textApproaches++; minimumPixelHeight = Math.min(minimumPixelHeight, pixelHeight);
      if (pixelHeight < (approach.minPixelHeight ?? 12)) add({ code: 'map-sign-glyph-size', ids: [check.sign.part, approach.id], severity: 'error',
        message: 'Actual fitted glyph height is too small from the required approach.', measured: pixelHeight, expected: approach.minPixelHeight ?? 12 });
    }
    for (const issue of this.persistentIssues) add(issue);
    if (this.pending) add({ code: 'map-material-pending', ids: [], severity: 'incomplete', message: `${this.pending} map material batches are still preparing.` });
    if (!this.manifest.diagnostics.valid) add({ code: 'map-invalid-preview', ids: [], severity: 'error', message: 'This is an inspection-only preview of a map with compiler errors.' });
    return { revision: this.manifest.revision, status: hasError ? 'failed' : hasIncomplete ? 'incomplete' : 'passed',
      parts: this.manifest.parts.length, batches: this.batches, signs: this.renderedSigns, checkedParts: checkedParts.size,
      textApproaches: { checked: textApproaches, minimumPixelHeight: Number.isFinite(minimumPixelHeight) ? minimumPixelHeight : null },
      issueCount, omittedIssues: issueCount - issues.length, issues, scope: 'compiled-static-map-subtree',
      limitations: ['Rendering integrity covers this static map subtree and compiled revision only.', 'Inspect ordinary lit camera views and required approaches; this report does not prove photometric readability or gameplay traversal.'] };
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const item of this.observed) { item.geometry.dispose(); if (item.texture) { item.texture.dispose(); item.material.dispose(); } }
    for (const material of this.materials) material.dispose();
    for (const handle of this.handles) handle.dispose();
    if (this.ownCache) this.cache.dispose(); this.root.clear(); this.root.removeFromParent();
  }
}
