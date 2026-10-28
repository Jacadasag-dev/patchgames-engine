import { validateAssetManifest, type AssetCatalog, type AssetManifest, type AssetParameterValue } from './assetFamilies.ts';
import type { TerrainAsset } from './terrain.ts';
import type { TerrainAssetEnvironment } from './terrainEnvironment.ts';
import { validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';

export interface TerrainFamilyOptions {
  id: string; family: string; seed: number;
  /** A bounded palette is resolved once, before worker/chunk preparation. */
  variants?: number;
  parameters?: Readonly<Record<string, AssetParameterValue>>;
  environment?: TerrainAssetEnvironment;
  /** Fallback finish; explicit materials authored on individual model parts win. */
  material?: SurfaceMaterialInput;
}
const validId = (id: unknown, max = 96): id is string => typeof id === 'string' && id.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id);

/** The same validated family geometry drives terrain bounds, collision and
 * rendering. No model callback travels in a terrain recipe or runs per frame. */
export function terrainModelAsset(id: string, input: AssetManifest, options: { environment?: TerrainAssetEnvironment; material?: SurfaceMaterialInput } = {}): TerrainAsset {
  if (!validId(id)) throw new Error('Terrain model assets need a stable ID of at most 96 characters.');
  const model = validateAssetManifest(input);
  return { id, version: model.key, model, footprint: { kind: 'box', width: model.size.x, depth: model.size.z },
    ...(options.environment === undefined ? {} : { environment: JSON.parse(JSON.stringify(options.environment)) as TerrainAssetEnvironment }),
    ...(options.material === undefined ? {} : { material: validateSurfaceMaterialInput(options.material) }) };
}

/** Reuse these returned asset IDs in ordinary scatter layers, placements or
 * pins. Stable variant IDs keep unrelated family edits from rerolling models.
 * The full terrain recipe still enforces its 64-asset and collider budgets. */
export function terrainFamilyAssets(catalog: Pick<AssetCatalog, 'resolve'>, options: TerrainFamilyOptions): TerrainAsset[] {
  const count = options.variants ?? 8;
  if (!validId(options.id, 80) || !Number.isInteger(count) || count < 1 || count > 32) throw new Error('Terrain families need a stable ID of at most 80 characters and 1..32 variants.');
  return Array.from({ length: count }, (_, index) => {
    const id = `${options.id}:${index}`;
    return terrainModelAsset(id, catalog.resolve(options.family, { seed: options.seed, instanceId: id, parameters: options.parameters }), { environment: options.environment, material: options.material });
  });
}
