/** Presentation consumes the same accepted destruction state as native physics.
 * It never computes damage, supports or falling-body motion. */
import { Group, Quaternion, Vector3, type Object3D } from 'three';
import type { BuildingManifest } from './building.ts';
import { BuildingWorldView, type BuildingWorldViewOptions, type BuildingCutaway } from './buildingView.ts';
import type { AssetManifest } from './assetFamilies.ts';
import { AssetFamilyViewCache, type AssetFamilyView, type AssetFamilyViewOptions, type AssetFamilyInstanceViewOptions } from './assetFamilyView.ts';
import { SurfaceMaterialCache } from './surfaceMaterialView.ts';
import { destructionTopologyKey, projectBuildingDestruction, projectAssetDestruction, type BuildingStructure, type AssetStructure } from './buildingDestruction.ts';
import type { DestructionState, DestructionCluster } from './destruction.ts';

function clustersKey(state: DestructionState): string {
  return JSON.stringify(state.clusters.map(cluster => [cluster.id, [...cluster.memberIds].sort(), cluster.origin]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1));
}
function validatePoses(state: DestructionState): void {
  const ids = new Set<string>();
  for (const cluster of state.clusters) {
    if (typeof cluster.id !== 'string' || !cluster.id || ids.has(cluster.id)) throw new Error('Destruction view requires unique cluster IDs.');
    ids.add(cluster.id);
    for (const point of [cluster.origin, cluster.position]) if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('Destruction view requires finite cluster poses.');
    const q = cluster.rotation;
    if (!q || ![q.x, q.y, q.z, q.w].every(Number.isFinite) || Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > .001) throw new Error('Destruction view requires normalized cluster rotations.');
  }
}
function pose(group: Group, cluster: DestructionCluster): void {
  group.position.copy(cluster.position); group.quaternion.set(cluster.rotation.x, cluster.rotation.y, cluster.rotation.z, cluster.rotation.w);
}
interface BuildingDebris { group: Group; view: BuildingWorldView }
export class BuildingDestructionView {
  readonly root = new Group();
  private readonly building: BuildingManifest;
  private readonly structure: BuildingStructure;
  private readonly options: BuildingWorldViewOptions;
  private readonly materials: SurfaceMaterialCache;
  private readonly ownsMaterials: boolean;
  private attachedView?: BuildingWorldView;
  private debris = new Map<string, BuildingDebris>();
  private topology = '';
  private clusters = '';
  private cutaway: BuildingCutaway | null = null;
  private disposed = false;
  private rebuilds = 0;
  constructor(building: BuildingManifest, structure: BuildingStructure, state: DestructionState, options: BuildingWorldViewOptions = {}) {
    this.building = building; this.structure = structure; this.options = { ...options };
    this.materials = options.materialCache ?? new SurfaceMaterialCache(options.materialOptions); this.ownsMaterials = !options.materialCache;
    this.root.name = `destruction:${structure.id}`;
    try { this.update(state, building.recipe.origin ?? { x: 0, y: 0, z: 0 }); } catch (error) { this.dispose(); throw error; }
  }
  update(state: DestructionState, focus: Readonly<{ x: number; y: number; z: number }>): void {
    if (this.disposed) throw new Error('BuildingDestructionView has been disposed.');
    const topology = destructionTopologyKey(this.structure, state), clusters = clustersKey(state); validatePoses(state);
    if (topology !== this.topology || clusters !== this.clusters) {
      let next: BuildingWorldView | undefined;
      const nextDebris = new Map<string, BuildingDebris>();
      try {
        if (topology !== this.topology) {
          next = new BuildingWorldView([projectBuildingDestruction(this.building, this.structure, state)], { ...this.options, materialCache: this.materials });
          next.setCutaway(this.cutaway); next.update(focus);
        }
        if (clusters !== this.clusters) for (const cluster of state.clusters) {
          const members = new Set(cluster.memberIds), ids = new Set(this.structure.ownership.filter(owner => members.has(owner.memberId)).flatMap(owner => [...owner.partIds]));
          const shell: BuildingManifest = { ...this.building, revision: `${this.building.revision}:debris:${cluster.id}`,
            parts: this.building.parts.filter(part => ids.has(part.id)).map(part => ({ ...part, exterior: true })), colliders: [], surfaces: [], lights: [], doors: [],
            diagnostics: { ...this.building.diagnostics, valid: true } };
          const view = new BuildingWorldView([shell], { ...this.options, materialCache: this.materials,
            activationDistance: 100000, interiorDistance: 100000, maxActiveBuildings: 1, fixtureLights: false, lightSources: [] });
          const group = new Group(); group.name = cluster.id; group.add(view.root);
          nextDebris.set(cluster.id, { group, view });
          view.root.position.set(-cluster.origin.x, -cluster.origin.y, -cluster.origin.z); view.update(cluster.origin);
          pose(group, cluster);
        }
      } catch (error) { next?.dispose(); for (const item of nextDebris.values()) item.view.dispose(); throw error; }
      const previousView = next ? this.attachedView : undefined, previousDebris = clusters !== this.clusters ? this.debris : undefined;
      if (next) { this.attachedView = next; this.root.add(next.root); this.rebuilds++; }
      if (clusters !== this.clusters) {
        this.debris = nextDebris; for (const item of this.debris.values()) this.root.add(item.group);
      }
      this.topology = topology; this.clusters = clusters;
      let failure: unknown;
      try { previousView?.dispose(); } catch (error) { failure = error; }
      for (const item of previousDebris?.values() ?? []) { try { item.view.dispose(); } catch (error) { failure ??= error; } finally { item.group.removeFromParent(); } }
      if (failure) throw failure;
    }
    for (const cluster of state.clusters) {
      const item = this.debris.get(cluster.id)!;
      item.view.root.position.set(-cluster.origin.x, -cluster.origin.y, -cluster.origin.z); pose(item.group, cluster);
    }
    this.attachedView!.update(focus);
  }
  setCutaway(cutaway: BuildingCutaway | null): void { this.attachedView!.setCutaway(cutaway); this.cutaway = cutaway; }
  async readyMaterials(): Promise<void> {
    await Promise.all([this.materials.ready(), this.attachedView?.readyMaterials(), ...[...this.debris.values()].map(item => item.view.readyMaterials())]);
  }
  inspection() { return { topologyRevision: this.topology, staticRebuilds: this.rebuilds, debrisClusters: this.debris.size,
    building: this.attachedView?.inspection(), surfaceMaterials: this.materials.inspection() }; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    let failure: unknown; const release = (action: () => void) => { try { action(); } catch (error) { failure ??= error; } };
    release(() => this.attachedView?.dispose()); for (const item of this.debris.values()) release(() => item.view.dispose()); this.debris.clear();
    this.root.removeFromParent(); this.root.clear(); if (this.ownsMaterials) release(() => this.materials.dispose()); if (failure) throw failure;
  }
}

/** Asset geometry is compiled once. Parts retain original model coordinates
 * while attached, or original world coordinates relative to the debris pivot. */
export class AssetDestructionView {
  readonly root = new Group();
  private readonly model: AssetManifest;
  private readonly structure: AssetStructure;
  private readonly cache: AssetFamilyViewCache;
  private readonly view: AssetFamilyView;
  private readonly parts = new Map<string, Object3D>();
  private readonly clusters = new Map<string, Group>();
  private membership = '';
  private disposed = false;
  constructor(model: AssetManifest, structure: AssetStructure, state: DestructionState,
    options: AssetFamilyViewOptions & AssetFamilyInstanceViewOptions = {}) {
    projectAssetDestruction(model, structure, state);
    this.model = model; this.structure = structure; this.cache = new AssetFamilyViewCache(options);
    try { this.view = this.cache.create(model, options); } catch (error) { this.cache.dispose(); throw error; }
    this.root.name = `destruction:${structure.id}`; this.root.add(this.view.object);
    for (const object of this.view.object.children) this.parts.set(object.name, object);
    this.view.object.position.copy(structure.source.position); this.view.object.rotation.y = structure.source.yaw;
    try { this.update(state); } catch (error) { this.dispose(); throw error; }
  }
  update(state: DestructionState): void {
    if (this.disposed) throw new Error('AssetDestructionView has been disposed.');
    destructionTopologyKey(this.structure, state); validatePoses(state); const membership = clustersKey(state);
    if (membership !== this.membership) {
      for (const group of this.clusters.values()) group.removeFromParent(); this.clusters.clear();
      const owner = new Map<string, DestructionCluster>();
      for (const cluster of state.clusters) {
        const group = new Group(); group.name = cluster.id; this.clusters.set(cluster.id, group); this.root.add(group);
        const members = new Set(cluster.memberIds);
        for (const binding of this.structure.ownership) if (members.has(binding.memberId)) for (const id of binding.partIds) owner.set(id, cluster);
      }
      const yaw = this.structure.source.yaw, q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
      for (const part of this.model.parts) {
        const object = this.parts.get(part.id)!, cluster = owner.get(part.id);
        if (cluster) {
          this.clusters.get(cluster.id)!.add(object);
          object.position.copy(part.position).applyQuaternion(q).add(this.structure.source.position).sub(cluster.origin);
          object.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), yaw + (part.yaw ?? 0));
        } else { this.view.object.add(object); object.position.copy(part.position); object.rotation.set(0, part.yaw ?? 0, 0); }
      }
      this.membership = membership;
    }
    for (const cluster of state.clusters) pose(this.clusters.get(cluster.id)!, cluster);
  }
  readyMaterials(): Promise<void> { return this.cache.readyMaterials(); }
  inspection() { return { debrisClusters: this.clusters.size, parts: this.parts.size, assets: this.cache.inspection() }; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    try { this.view.dispose(); } finally { try { this.cache.dispose(); } finally { this.parts.clear(); this.clusters.clear(); this.root.removeFromParent(); this.root.clear(); } }
  }
}
