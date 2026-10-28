/** One presentation adapter for optional prepared building/asset destruction.
 * Original appearances are leased once; source boxes never remain visible over
 * fracture holes, and ordinary pieces use the same accepted debris poses. */
import { BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3, type Material, type Object3D } from 'three';
import { AssetFamilyViewCache, type AssetFamilyView } from './assetFamilyView.ts';
import { BuildingWorldView, createBuildingBoxAppearance, type BuildingWorldViewOptions, type BuildingCutaway } from './buildingView.ts';
import { SurfaceMaterialCache } from './surfaceMaterialView.ts';
import { FractureView } from './fractureView.ts';
import { DeformationView } from './deformationView.ts';
import { destructionTopologyKey } from './buildingDestruction.ts';
import { projectDestructibleAsset, projectDestructibleBuilding, type PreparedProceduralDestruction } from './proceduralDestruction.ts';
import type { PreparedStructuralFractures } from './structuralFracture.ts';
import type { DestructionState, DestructionCluster } from './destruction.ts';
import type { PhysicsVector } from './physics.ts';
import type { ResolvedSurfaceMaterial } from './surfaceMaterials.ts';

type FractureEntry = PreparedStructuralFractures['fractures'][number];
export interface PreparedFractureAppearance {
  /** Complete original exterior in physical, centred slab-local coordinates. */
  geometry: BufferGeometry;
  material: Material | Material[];
  readyMaterials?(): Promise<void>;
  /** Owns its geometry/material leases, called once after fracture views release. */
  dispose(): void;
}
export interface PreparedDestructionViewOptions extends BuildingWorldViewOptions {
  /** Inherited material for custom asset parts, matching AssetFamilyViewCache. */
  material?: ResolvedSurfaceMaterial;
  /** Caller-owned fresh cut material. Default is a rough shade of source colour. */
  interiorMaterial?: Material;
  /** Optional source-box appearance override. Geometry must match the source
   * box; this does not turn arbitrary imported meshes into fracturable solids. */
  fractureAppearanceFactory?: (entry: FractureEntry, bundle: PreparedProceduralDestruction,
    materials: SurfaceMaterialCache) => PreparedFractureAppearance;
}
interface FracturePresentation { entry: FractureEntry; view: FractureView }
interface BuildingDebris { group: Group; view: BuildingWorldView }
function validatePoses(state: DestructionState): void {
  for (const cluster of state.clusters) {
    if (![cluster.position.x, cluster.position.y, cluster.position.z, cluster.origin.x, cluster.origin.y, cluster.origin.z].every(Number.isFinite)
      || ![cluster.rotation.x, cluster.rotation.y, cluster.rotation.z, cluster.rotation.w].every(Number.isFinite)
      || Math.abs(Math.hypot(cluster.rotation.x, cluster.rotation.y, cluster.rotation.z, cluster.rotation.w) - 1) > .001)
      throw new Error('Prepared destruction view requires finite normalized debris poses.');
  }
}
function pose(group: Group, cluster: DestructionCluster): void { group.position.copy(cluster.position); group.quaternion.copy(cluster.rotation); }

export class PreparedDestructionView {
  readonly root = new Group();
  readonly group = this.root;
  private readonly bundle: PreparedProceduralDestruction;
  private readonly options: PreparedDestructionViewOptions;
  private readonly materials: SurfaceMaterialCache;
  private readonly ownsMaterials: boolean;
  private readonly appearances: PreparedFractureAppearance[] = [];
  private readonly interiorMaterials: Material[] = [];
  private readonly fractures: FracturePresentation[] = [];
  private readonly deformations: DeformationView[] = [];
  private readonly assetParts = new Map<string, Object3D>();
  private readonly replacedPartIds: Set<string>;
  private assetCache?: AssetFamilyViewCache;
  private assetView?: AssetFamilyView;
  private attachedBuilding?: BuildingWorldView;
  private debris = new Map<string, BuildingDebris>();
  private membership = '';
  private current?: DestructionState;
  private focus: PhysicsVector = { x: 0, y: 0, z: 0 };
  private cutaway: BuildingCutaway | null = null;
  private disposed = false;

  constructor(bundle: PreparedProceduralDestruction, state: DestructionState, options: PreparedDestructionViewOptions = {}) {
    this.bundle = bundle; this.options = { ...options }; this.root.name = `prepared-destruction:${bundle.prepared.structure.id}`;
    this.materials = options.materialCache ?? new SurfaceMaterialCache(options.materialOptions); this.ownsMaterials = !options.materialCache;
    this.replacedPartIds = new Set([...bundle.prepared.fractures.flatMap(entry => entry.sourcePartIds),...bundle.prepared.structure.members.filter(m=>m.deformation).flatMap(m=>m.partIds??[])]);
    try {
      destructionTopologyKey(bundle.prepared.structure, state); validatePoses(state);
      if (bundle.kind === 'asset') {
        projectDestructibleAsset(bundle, state);
        this.assetCache = new AssetFamilyViewCache({ materialCache: this.materials });
        this.assetView = this.assetCache.create(bundle.model, { material: options.material }); this.root.add(this.assetView.object);
        this.assetView.object.position.copy(bundle.baseStructure.source.position); this.assetView.object.rotation.y = bundle.baseStructure.source.yaw;
        for (const object of this.assetView.object.children) this.assetParts.set(object.name, object);
        this.focus = { ...bundle.baseStructure.source.position };
      } else this.focus = { ...(bundle.building.recipe.origin ?? { x: 0, y: 0, z: 0 }) };
      for (const entry of bundle.prepared.fractures) {
        if (entry.sourcePartIds.length !== 1) throw new Error('Prepared fracture rendering requires exactly one source box part.');
        const part = (bundle.kind === 'asset' ? bundle.model.parts : bundle.building.parts).find(part => part.id === entry.sourcePartIds[0]);
        if (!part || ('shape' in part ? part.shape !== 'box' : part.model || part.kind === 'furniture'))
          throw new Error('Prepared fracture rendering supports original box parts, not model or furniture envelopes.');
        let appearance = options.fractureAppearanceFactory?.(entry, bundle, this.materials);
        if (!appearance && bundle.kind === 'building') {
          if (options.partFactory) throw new Error('Custom building partFactory requires an explicit fractureAppearanceFactory for replaced boxes.');
          const sourcePart = bundle.building.parts.find(part => part.id === entry.sourcePartIds[0])!;
          const prepared = createBuildingBoxAppearance(sourcePart, { materialCache: this.materials });
          appearance = { geometry: prepared.geometry, material: prepared.materials, readyMaterials: prepared.readyMaterials, dispose: prepared.dispose };
        } else if (!appearance) {
          const source = this.assetParts.get(entry.sourcePartIds[0]);
          if (!(source instanceof Mesh)) throw new Error('Prepared asset fracture requires an original box mesh.');
          const geometry = source.geometry.clone(); geometry.scale(source.scale.x, source.scale.y, source.scale.z);
          if (!Array.isArray(source.material)) geometry.clearGroups();
          appearance = { geometry, material: source.material, dispose: () => geometry.dispose() };
        }
        this.appearances.push(appearance);
        let interior = options.interiorMaterial;
        if (!interior) { interior = new MeshStandardMaterial({ color: new Color(part.color).multiplyScalar(.78), roughness: 1 }); this.interiorMaterials.push(interior); }
        const view = new FractureView(entry.slab, appearance.material, interior, { exteriorGeometry: appearance.geometry });
        this.fractures.push({ entry, view }); this.root.add(view.root);
      }
      for(const member of bundle.prepared.structure.members.filter(m=>m.deformation)){
        const partId=member.partIds![0];let appearance:PreparedFractureAppearance;
        if(bundle.kind==='building'){
          if(options.partFactory)throw new Error('Ductile building panels require the standard box appearance');
          const source=bundle.building.parts.find(p=>p.id===partId)!;
          const prepared=createBuildingBoxAppearance(source,{materialCache:this.materials});
          appearance={geometry:prepared.geometry,material:prepared.materials,readyMaterials:prepared.readyMaterials,dispose:prepared.dispose};
        }else{
          const source=this.assetParts.get(partId);if(!(source instanceof Mesh))throw new Error('Ductile asset panel requires an original box mesh');
          const geometry=source.geometry.clone();geometry.scale(source.scale.x,source.scale.y,source.scale.z);
          appearance={geometry,material:source.material,dispose:()=>geometry.dispose()};
        }
        this.appearances.push(appearance);const view=new DeformationView(member,appearance.material,{geometry:appearance.geometry});
        this.deformations.push(view);this.root.add(view.root);
      }
      this.update(state, this.focus);
    } catch (error) { this.dispose(); throw error; }
  }

  update(state: DestructionState, focus: Readonly<PhysicsVector> = this.focus): void {
    if (this.disposed) throw new Error('PreparedDestructionView has been disposed.');
    destructionTopologyKey(this.bundle.prepared.structure, state); validatePoses(state);
    if (![focus.x, focus.y, focus.z].every(Number.isFinite)) throw new Error('Prepared destruction focus must be finite.');
    this.focus = { ...focus };
    if (this.bundle.kind === 'asset') this.updateAsset(state);
    else this.updateBuilding(state);
    for (const fracture of this.fractures) fracture.view.update(state);
    for (const deformation of this.deformations) deformation.update(state);
    this.current = state; this.updateFractureVisibility(state);
  }

  private updateAsset(state: DestructionState): void {
    const bundle = this.bundle; if (bundle.kind !== 'asset') return;
    projectDestructibleAsset(bundle, state);
    const members = new Map(bundle.prepared.structure.members.map(member => [member.id, member]));
    const owners = new Map<string, DestructionCluster>();
    for (const cluster of state.clusters) for (const id of cluster.memberIds) for (const part of members.get(id)!.partIds ?? []) owners.set(part, cluster);
    const source = bundle.baseStructure.source, sourceRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), source.yaw), rotation = new Quaternion();
    for (const part of bundle.model.parts) {
      const object = this.assetParts.get(part.id)!, cluster = owners.get(part.id); object.visible = !this.replacedPartIds.has(part.id);
      if (cluster) {
        this.root.add(object); rotation.copy(cluster.rotation);
        object.position.copy(part.position).applyQuaternion(sourceRotation).add(source.position).sub(cluster.origin).applyQuaternion(rotation).add(cluster.position);
        object.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), source.yaw + (part.yaw ?? 0)).premultiply(rotation);
      } else { this.assetView!.object.add(object); object.position.copy(part.position); object.rotation.set(0, part.yaw ?? 0, 0); }
    }
  }

  private updateBuilding(state: DestructionState): void {
    const bundle = this.bundle; if (bundle.kind !== 'building') return;
    const membership = JSON.stringify(state.clusters.map(cluster => [cluster.id, cluster.memberIds, cluster.origin]));
    if (membership !== this.membership) {
      let attached: BuildingWorldView | undefined; const debris = new Map<string, BuildingDebris>();
      try {
        attached = new BuildingWorldView([projectDestructibleBuilding(bundle, state)], { ...this.options, materialCache: this.materials });
        attached.setCutaway(this.cutaway); attached.update(this.focus);
        const members = new Map(bundle.prepared.structure.members.map(member => [member.id, member]));
        for (const cluster of state.clusters) {
          const ids = new Set(cluster.memberIds.flatMap(id => members.get(id)!.partIds ?? [])); if (!ids.size) continue;
          const shell = { ...bundle.building, revision: `${bundle.building.revision}:debris:${cluster.id}`,
            parts: bundle.building.parts.filter(part => ids.has(part.id)&&!this.replacedPartIds.has(part.id)).map(part => ({ ...part, exterior: true })), colliders: [], surfaces: [], lights: [], doors: [],
            diagnostics: { ...bundle.building.diagnostics, valid: true } };
          const view = new BuildingWorldView([shell], { ...this.options, materialCache: this.materials,
            // Every debris part is an exterior mesh and stays resident. It has
            // no interior/light activation region to keep artificially large.
            activationDistance: 0, interiorDistance: 0, hysteresis: 0, maxActiveBuildings: 1, fixtureLights: false, lightSources: [] });
          const group = new Group(); group.name = cluster.id; group.add(view.root); view.root.position.set(-cluster.origin.x, -cluster.origin.y, -cluster.origin.z);
          pose(group, cluster); debris.set(cluster.id, { group, view });
        }
      } catch (error) { attached?.dispose(); for (const item of debris.values()) item.view.dispose(); throw error; }
      this.attachedBuilding?.dispose(); for (const item of this.debris.values()) { item.view.dispose(); item.group.removeFromParent(); }
      this.attachedBuilding = attached; this.debris = debris; this.membership = membership;
      this.root.add(attached.root); for (const item of debris.values()) this.root.add(item.group);
    }
    this.attachedBuilding!.update(this.focus);
    for (const cluster of state.clusters) {
      const debris = this.debris.get(cluster.id);
      if (debris) { pose(debris.group, cluster); debris.view.update(this.focus); }
    }
  }

  private updateFractureVisibility(state: DestructionState): void {
    const bundle = this.bundle; if (bundle.kind !== 'building') return;
    const detached = new Set(state.clusters.flatMap(cluster => cluster.memberIds));
    const inspection = this.attachedBuilding!.inspection() as { items?: Array<{ interiorResident: boolean; rooms: string[]; roomsTruncated: boolean }> };
    const building = inspection.items?.[0];
    const applied = this.cutaway && (!this.cutaway.buildingId || this.cutaway.buildingId === bundle.building.id);
    const originY = bundle.building.recipe.origin?.y ?? 0, floors = [...bundle.building.recipe.floors].sort((a, b) => a.y - b.y);
    const selectedY = this.cutaway?.floorY;
    const storey = selectedY === undefined ? floors[0] : floors.find(floor => selectedY >= originY + floor.y - .05 && selectedY < originY + floor.y + floor.height - .05)
      ?? floors.reduce((nearest, floor) => Math.abs(originY + floor.y - selectedY) < Math.abs(originY + nearest.y - selectedY) ? floor : nearest, floors[0]);
    const floorY = selectedY ?? originY + (storey?.y ?? 0);
    const highestFloor = originY + (storey?.y ?? 0) + Math.max(0, ...(storey?.rooms.map(room => room.elevation ?? 0) ?? []));
    const top = Math.max(floorY, highestFloor) + (this.cutaway?.wallHeight ?? 1.1);
    for (const fracture of this.fractures) {
      const part = bundle.building.parts.find(part => part.id === fracture.entry.sourcePartIds[0])!;
      const falling = fracture.entry.slab.cells.some(cell => detached.has(cell.id));
      let visible = falling || part.exterior || !!building?.interiorResident && (!part.roomId || building.roomsTruncated || building.rooms.includes(part.roomId));
      fracture.view.root.scale.set(1, 1, 1); fracture.view.root.position.set(0, 0, 0);
      if (applied && !falling) {
        const bottom = part.position.y - part.size.y / 2;
        if (part.kind === 'roof' || bottom >= top || part.kind === 'wall' && part.position.y + part.size.y / 2 <= floorY + 1e-6
          || part.kind === 'floor' && part.floorId !== storey?.id && part.position.y > floorY + .1) visible = false;
        else if (part.kind === 'wall' && part.position.y + part.size.y / 2 > top) {
          // Match ordinary upright building boxes: shorten presentation from
          // the bottom only. Authoritative slab geometry and poses stay intact.
          const scale = Math.max(0, top - bottom) / part.size.y;
          fracture.view.root.scale.y = scale; fracture.view.root.position.y = bottom * (1 - scale);
        }
      }
      fracture.view.root.visible = visible;
    }
    for(const view of this.deformations){
      const part=bundle.building.parts.find(p=>p.id===view.member.partIds![0])!,falling=detached.has(view.member.id);
      let visible=falling||part.exterior||!!building?.interiorResident&&(!part.roomId||building.roomsTruncated||building.rooms.includes(part.roomId));
      if(applied&&!falling&&(part.kind==='roof'||part.position.y-part.size.y/2>=top||part.kind==='floor'&&part.floorId!==storey?.id&&part.position.y>floorY+.1))visible=false;
      view.root.visible=visible;
    }
  }

  setCutaway(value: BuildingCutaway | null): void {
    if (this.disposed) throw new Error('PreparedDestructionView has been disposed.');
    if (this.bundle.kind !== 'building' && value) throw new Error('Building cutaway requires a prepared building.');
    this.attachedBuilding?.setCutaway(value); this.cutaway = value ? { ...value } : null;
    if (this.current) this.updateFractureVisibility(this.current);
  }
  async readyMaterials(): Promise<void> { await Promise.all([this.materials.ready(), ...this.appearances.map(appearance => appearance.readyMaterials?.())]); }
  inspection() { return { kind: this.bundle.kind, fractures: this.fractures.length, deformations:this.deformations.length, replacedParts: [...this.replacedPartIds],
    building: this.attachedBuilding?.inspection(), assets: this.assetCache?.inspection(), surfaceMaterials: this.materials.inspection(), disposed: this.disposed }; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const fracture of this.fractures) fracture.view.dispose(); this.fractures.length = 0;
    for (const deformation of this.deformations) deformation.dispose();this.deformations.length=0;
    for (const appearance of this.appearances) appearance.dispose(); this.appearances.length = 0;
    for (const material of this.interiorMaterials) material.dispose(); this.interiorMaterials.length = 0;
    this.attachedBuilding?.dispose(); for (const item of this.debris.values()) item.view.dispose(); this.debris.clear();
    this.assetView?.dispose(); this.assetCache?.dispose(); this.assetParts.clear();
    if (this.ownsMaterials) this.materials.dispose(); this.root.removeFromParent(); this.root.clear();
  }
}
