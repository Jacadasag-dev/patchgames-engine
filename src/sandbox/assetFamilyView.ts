import { BoxGeometry, CylinderGeometry, SphereGeometry, Group, Mesh, MeshStandardMaterial, type BufferGeometry } from 'three';
import { validateAssetManifest, type AssetManifest, type AssetPart } from './assetFamilies.ts';
import { resolveSurfaceMaterial, type ResolvedSurfaceMaterial } from './surfaceMaterials.ts';
import { SurfaceMaterialCache, type SurfaceMaterialCacheOptions } from './surfaceMaterialView.ts';

export interface AssetFamilyView { object: Group; dispose(): void }
export interface AssetFamilyViewOptions { materialCache?: SurfaceMaterialCache; materialOptions?: SurfaceMaterialCacheOptions }
export interface AssetFamilyInstanceViewOptions { material?: ResolvedSurfaceMaterial }
interface MaterialEntry { material: MeshStandardMaterial; references: number }
function parameterKey(parameters: AssetManifest['parameters']): string {
  const value = JSON.stringify(Object.entries(parameters).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  let a = 2166136261, b = 0x6d2b79f5;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 0x85ebca6b); }
  return `${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

/** UVs stay in physical metres while the shared texture handle owns tile scale.
 * Box faces use their own axes; round side faces retain continuous angular UVs. */
function metricUVs(geometry: BufferGeometry, part: AssetPart): void {
  const uv = geometry.getAttribute('uv'), p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), s = part.size;
  for (let i = 0; i < uv.count; i++) {
    let u: number, v: number;
    if (part.shape === 'sphere') { u = uv.getX(i) * Math.PI * s.x; v = uv.getY(i) * Math.PI * s.y / 2; }
    else if (part.shape === 'cylinder' && Math.abs(n.getY(i)) < .5) {
      const a = s.x / 2, b = s.z / 2, circumference = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
      u = uv.getX(i) * circumference; v = uv.getY(i) * s.y;
    } else if (Math.abs(n.getY(i)) > .5) { u = p.getX(i) * s.x; v = -Math.sign(n.getY(i)) * p.getZ(i) * s.z; }
    else if (Math.abs(n.getX(i)) > .5) { u = -Math.sign(n.getX(i)) * p.getZ(i) * s.z; v = p.getY(i) * s.y; }
    else { u = Math.sign(n.getZ(i)) * p.getX(i) * s.x; v = p.getY(i) * s.y; }
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
}

/** Geometry/material sharing for any user-defined family, with no logic callback
 * or render loop. Each returned object starts at the asset's floor origin Y=0.
 * Dispose instances when removed; dispose the cache when its owner is destroyed.
 * Rigid meshes remain eligible for the engine's existing batching pass. */
export class AssetFamilyViewCache {
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly metricReferences = new Map<string, number>();
  private readonly materials = new Map<string, MaterialEntry>();
  private readonly variants = new Map<string, number>();
  private readonly instances = new Set<AssetFamilyView>();
  private disposed = false;
  private readonly surfaceMaterials: SurfaceMaterialCache;
  private readonly ownsSurfaceMaterials: boolean;

  constructor(options: AssetFamilyViewOptions = {}) {
    this.surfaceMaterials = options.materialCache ?? new SurfaceMaterialCache(options.materialOptions);
    this.ownsSurfaceMaterials = !options.materialCache;
  }

  create(input: AssetManifest, options: AssetFamilyInstanceViewOptions = {}): AssetFamilyView {
    if (this.disposed) throw new Error('AssetFamilyViewCache has been disposed.');
    if (this.instances.size >= 4096) throw new Error('AssetFamilyViewCache supports at most 4096 live instances.');
    const manifest = validateAssetManifest(input), object = new Group();
    object.name = `${manifest.familyId}:${manifest.key}`;
    const borrowed = new Map<string, MaterialEntry>();
    const textured = new Map<string, ReturnType<SurfaceMaterialCache['acquire']>>(), metric = new Set<string>();
    const releaseBorrowed = () => {
      for (const [key, entry] of borrowed) if (--entry.references === 0) { entry.material.dispose(); this.materials.delete(key); }
      for (const handle of textured.values()) handle.dispose();
      for (const key of metric) {
        const references = (this.metricReferences.get(key) ?? 1) - 1;
        if (references > 0) this.metricReferences.set(key, references);
        else { this.metricReferences.delete(key); this.geometries.get(key)?.dispose(); this.geometries.delete(key); }
      }
    };
    try {
    for (const part of manifest.parts) {
      const surface = part.material ? resolveSurfaceMaterial(part.material, { seed: manifest.seed, key: `${manifest.familyId}:${manifest.version}:${part.id}:${parameterKey(manifest.parameters)}` })
        : part.inheritMaterial === false ? undefined : options.material;
      const geometryKey = surface ? JSON.stringify([part.shape, part.size]) : part.shape;
      let geometry = this.geometries.get(geometryKey);
      if (!geometry) {
        if (this.geometries.size >= 1024) throw new Error('Asset views exceed the shared geometry budget.');
        geometry = part.shape === 'box' ? new BoxGeometry(1, 1, 1)
          : part.shape === 'cylinder' ? new CylinderGeometry(.5, .5, 1, 20) : new SphereGeometry(.5, 16, 12);
        if (surface) metricUVs(geometry, part);
        this.geometries.set(geometryKey, geometry);
      }
      if (surface && !metric.has(geometryKey)) { metric.add(geometryKey); this.metricReferences.set(geometryKey, (this.metricReferences.get(geometryKey) ?? 0) + 1); }
      let material: MeshStandardMaterial;
      if (surface) {
        const key = JSON.stringify([surface.key, part.emissive, part.emissiveIntensity]);
        let handle = textured.get(key);
        if (!handle) { handle = this.surfaceMaterials.acquire(surface, { emissive: part.emissive, emissiveIntensity: part.emissiveIntensity }); textured.set(key, handle); }
        material = handle.material;
      } else {
      const materialKey = JSON.stringify([part.color, part.emissive ?? null, part.emissiveIntensity ?? 1]);
      let entry = this.materials.get(materialKey);
      if (!entry) { entry = { material: new MeshStandardMaterial({ color: part.color, roughness: .8,
        ...(part.emissive === undefined ? {} : { emissive: part.emissive, emissiveIntensity: part.emissiveIntensity ?? 1 }) }), references: 0 }; this.materials.set(materialKey, entry); }
      if (!borrowed.has(materialKey)) { entry.references++; borrowed.set(materialKey, entry); }
      material = entry.material;
      }
      const mesh = new Mesh(geometry, material); mesh.name = part.id;
      mesh.position.copy(part.position); mesh.scale.copy(part.size); mesh.rotation.y = part.yaw ?? 0;
      mesh.castShadow = mesh.receiveShadow = true; object.add(mesh);
    }
    } catch (error) { releaseBorrowed(); object.clear(); throw error; }
    this.variants.set(manifest.key, (this.variants.get(manifest.key) ?? 0) + 1);
    let released = false;
    const view: AssetFamilyView = { object, dispose: () => {
      if (released) return; released = true; object.removeFromParent(); object.clear(); this.instances.delete(view);
      const count = this.variants.get(manifest.key) ?? 0;
      if (count <= 1) this.variants.delete(manifest.key); else this.variants.set(manifest.key, count - 1);
      releaseBorrowed();
    } };
    this.instances.add(view); return view;
  }

  readyMaterials(): Promise<void> { return this.surfaceMaterials.ready(); }

  inspection() {
    return { instances: this.instances.size, variants: this.variants.size, geometries: this.geometries.size, materials: this.materials.size, disposed: this.disposed,
      surfaceMaterials: this.surfaceMaterials.inspection() };
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const instance of this.instances) instance.dispose();
    for (const geometry of this.geometries.values()) geometry.dispose(); this.geometries.clear();
    for (const entry of this.materials.values()) entry.material.dispose(); this.materials.clear(); this.variants.clear();
    this.metricReferences.clear(); if (this.ownsSurfaceMaterials) this.surfaceMaterials.dispose();
  }
}

/** Convenience for one isolated asset; use a shared cache for repeated props. */
export function createAssetView(manifest: AssetManifest, options: AssetFamilyViewOptions & AssetFamilyInstanceViewOptions = {}): AssetFamilyView {
  const cache = new AssetFamilyViewCache(options);
  try { const view = cache.create(manifest, options); return { object: view.object, dispose: () => cache.dispose() }; }
  catch (error) { cache.dispose(); throw error; }
}
