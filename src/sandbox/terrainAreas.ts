import { defineAssetParameters, resolveAssetParameters, type AssetParameter, type AssetParameters, type AssetResolveOptions } from './assetFamilies.ts';
import { snapshotTerrainContribution, type TerrainContribution } from './terrainWorld.ts';
import { createVariation, type VariationContext } from './variation.ts';

export interface TerrainAreaGenerationContext {
  seed: number; instanceId: string; variation: VariationContext;
}

/** Parameterized landscape composition, using the same ranges, weighted choices
 * and keyed variation as object families. Geometry remains terrain-specific. */
export interface TerrainAreaFamily {
  id: string; version: string; parameters: Readonly<Record<string, AssetParameter>>;
  generate(parameters: AssetParameters, context: TerrainAreaGenerationContext): TerrainContribution;
}
type Values<P extends Record<string, AssetParameter>> = { readonly [K in keyof P]: P[K] extends { kind: 'number' } ? number : string };

export function defineTerrainAreaFamily<const P extends Record<string, AssetParameter>>(definition: {
  id: string; version: string; parameters: P;
  generate(parameters: Values<P>, context: TerrainAreaGenerationContext): TerrainContribution;
}): TerrainAreaFamily {
  if (typeof definition?.generate !== 'function') throw new Error('Terrain area families need an authored generator.');
  const parameters = defineAssetParameters(definition);
  return Object.freeze({ ...parameters, generate: definition.generate as TerrainAreaFamily['generate'] });
}

/** Resolve once at authoring/configuration time. The returned contribution is
 * independently editable; compose it with the world before terrain validation.
 * Keep IDs local and stable; composeTerrainRecipe namespaces references. */
export function resolveTerrainArea(family: TerrainAreaFamily, options: AssetResolveOptions): {
  familyId: string; version: string; parameters: AssetParameters; terrain: TerrainContribution;
} {
  if (typeof family?.generate !== 'function') throw new Error('Terrain area family is missing its generator.');
  const parameters = resolveAssetParameters(family, options);
  const terrain = snapshotTerrainContribution(family.generate(parameters, Object.freeze({ seed: options.seed, instanceId: options.instanceId,
    variation: createVariation({ seed: options.seed, id: family.id, version: family.version, instanceId: options.instanceId }) })));
  return { familyId: family.id, version: family.version, parameters, terrain };
}
