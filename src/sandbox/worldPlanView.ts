import { Group } from 'three';
import { TerrainWorldView, type TerrainViewOptions } from './terrainView.ts';
import type { TerrainWorldSnapshot } from './terrainWorld.ts';
import { BuildingWorldView, type BuildingWorldViewOptions, type BuildingCutaway } from './buildingView.ts';
import { AssetFamilyViewCache, type AssetFamilyView } from './assetFamilyView.ts';
import type { WorldPlanManifest } from './worldPlan.ts';
import { SurfaceMaterialCache, type SurfaceMaterialCacheOptions } from './surfaceMaterialView.ts';
import { resolveSurfaceMaterial } from './surfaceMaterials.ts';

export interface WorldPlanViewOptions {
  terrain?: TerrainViewOptions;
  buildings?: BuildingWorldViewOptions;
  /** Share compiled texture maps across terrain, buildings, fixtures and props. */
  materialCache?: SurfaceMaterialCache;
  materialOptions?: SurfaceMaterialCacheOptions;
}

/** Draw one compiled plan over its accepted terrain snapshot. Custom terrain
 * asset factories and building part factories stay available to authored games.
 * This adapter never generates geometry recipes or changes authoritative physics. */
export class WorldPlanView {
  readonly root = new Group();
  readonly buildings: BuildingWorldView;
  private readonly terrain: TerrainWorldView;
  private readonly cache: AssetFamilyViewCache;
  private readonly materials: SurfaceMaterialCache;
  private readonly ownsMaterials: boolean;
  private readonly props: AssetFamilyView[] = [];
  private disposed = false;
  readonly plan: WorldPlanManifest;
  constructor(plan: WorldPlanManifest, snapshot: TerrainWorldSnapshot, options: WorldPlanViewOptions = {}) {
    if (!plan.diagnostics.valid) throw new Error('Cannot render an invalid world plan.');
    this.plan = plan;
    this.materials = options.materialCache ?? new SurfaceMaterialCache(options.materialOptions);
    this.ownsMaterials = !options.materialCache;
    this.cache = new AssetFamilyViewCache({ materialCache: this.materials });
    this.root.name = `world-plan:${plan.id}`;
    const sourceAssets = new Set(plan.recipe.terrain.assets.map(asset => asset.id));
    const reservations = new Set(plan.terrain.assets.filter(asset => !sourceAssets.has(asset.id)).map(asset => asset.id));
    let terrain: TerrainWorldView | undefined;
    try {
      this.terrain = terrain = new TerrainWorldView(snapshot, { ...options.terrain,
        materialCache: options.terrain?.materialCache ?? this.materials,
        assetFactory: asset => reservations.has(asset.id) ? null : options.terrain?.assetFactory?.(asset) });
      this.buildings = new BuildingWorldView(plan.buildings, { ...options.buildings,
        materialCache: options.buildings?.materialCache ?? this.materials });
    } catch (error) { terrain?.dispose(); this.cache.dispose(); if (this.ownsMaterials) this.materials.dispose(); throw error; }
    try {
      this.root.add(this.terrain.root, this.buildings.root);
      for (const prop of plan.props) {
        const view = this.cache.create(prop.model, { ...(prop.material === undefined ? {} : { material: resolveSurfaceMaterial(prop.material,
          { seed: plan.recipe.seed >>> 0, key: `${plan.id}:prop:${prop.id}` }) }) });
        view.object.name = prop.id; view.object.position.copy(prop.position); view.object.rotation.y = prop.yaw ?? 0;
        this.props.push(view); this.root.add(view.object);
      }
    } catch (error) { this.dispose(); throw error; }
  }
  update(snapshot: TerrainWorldSnapshot, focus: Readonly<{ x: number; y: number; z: number }>): void {
    if (this.disposed) throw new Error('WorldPlanView has been disposed.');
    this.terrain.update(snapshot); this.buildings.update(focus);
  }
  setCutaway(cutaway: BuildingCutaway | null): void {
    this.buildings.setCutaway(cutaway);
    this.props.forEach((view, index) => {
      const prop = this.plan.props[index], site = this.plan.sites.find(site => site.id === prop.siteId);
      view.object.visible = !cutaway || !site?.buildingId || (cutaway.buildingId !== undefined && site.buildingId !== cutaway.buildingId)
        || prop.bounds.min.y < (cutaway.floorY ?? site?.floorY ?? 0) + (cutaway.wallHeight ?? 1.1);
    });
  }
  async readyMaterials(): Promise<void> {
    await Promise.all([this.materials.ready(), this.terrain.readyMaterials(), this.buildings.readyMaterials()]);
  }
  inspection(): Record<string, unknown> {
    const terrain = this.terrain.inspection();
    // Keep composition evidence within the shared inspector budget. The terrain
    // summary retains all issue counts; per-chunk detail exposes repair IDs.
    const chunks = terrain.chunks as Record<string, unknown>[];
    return { revision: this.plan.revision, terrain: { ...terrain,
      chunks: chunks.map(chunk => ({ id: chunk.id, revision: chunk.revision, valid: chunk.valid,
        counts: chunk.counts, issues: chunk.issues, issueCount: chunk.issueCount })) },
      buildings: this.buildings.inspection(), assets: this.cache.inspection(), surfaceMaterials: this.materials.inspection() };
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    let failed = false, failure: unknown;
    const release = (action: () => void) => { try { action(); } catch (error) { if (!failed) failure = error; failed = true; } };
    this.props.forEach(view => release(() => view.dispose())); this.props.length = 0;
    release(() => this.cache.dispose()); release(() => this.buildings.dispose()); release(() => this.terrain.dispose());
    this.root.removeFromParent(); this.root.clear();
    if (this.ownsMaterials) release(() => this.materials.dispose());
    if (failed) throw failure;
  }
}
