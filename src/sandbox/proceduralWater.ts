import { compileWater, type WaterConditions, type WaterManifest, type WaterRecipe } from './water.ts';
import { compileWaterDomain, type WaterDomainRecipe } from './waterDomain.ts';
import { sampleTerrainEnvironment } from './terrainEnvironment.ts';
import {compileWaterBody,createWaterBodyState,type WaterBodyRecipe,type WaterBodyManifest,type WaterBodyState} from './waterBody.ts';
import type { TerrainPoint, TerrainRecipe } from './terrain.ts';

/** Choose per lake, river reach, tank or flood zone. Surface mode is
 * decorative and produces no forces; waterBody mode simulates a local water body. */
export type ProceduralWaterBodyRecipe=Omit<WaterBodyRecipe,'liquid'>&{liquid:WaterDomainRecipe};
export type ProceduralWaterConfiguration = { mode: 'surface'; recipe: WaterRecipe }
  | { mode: 'waterBody'; recipe: ProceduralWaterBodyRecipe };
export type PreparedProceduralWater = { mode: 'surface'; water: WaterManifest }
  | { mode: 'waterBody'; water:WaterBodyManifest; initialState:WaterBodyState };

/** Compile after terrain/obstacles have been placed. Step with the resulting
 * terrain PhysicsScene so destruction openings affect the flow. */
export function prepareProceduralWater(config?: ProceduralWaterConfiguration | false): PreparedProceduralWater | undefined {
  if (config === false || config === undefined) return undefined;
  if (!config || typeof config !== 'object' || Object.keys(config).some(key => key !== 'mode' && key !== 'recipe'))
    throw new Error('Procedural water requires a mode and recipe.');
  if (config.mode === 'surface') return { mode: 'surface', water: compileWater(config.recipe) };
  if ((config as { mode: string }).mode === 'liquid') throw new Error('Procedural 3D particle liquid was removed; use mode waterBody for a simulated water body.');
  if(config.mode==='waterBody'){const water=compileWaterBody({...config.recipe,liquid:compileWaterDomain(config.recipe.liquid)});return{mode:'waterBody',water,initialState:createWaterBodyState(water)};}
  throw new Error('Procedural water mode must be surface or waterBody.');
}

/** Terrain wind strength is artistic (0..4); choose its conversion to m/s.
 * Both vegetation and water then sample the same position, time and gusts. */
export function terrainWaterConditions(recipe: TerrainRecipe, point: TerrainPoint, timeSeconds: number,
  options: { metresPerSecondAtUnitStrength?: number; currentSpeed?: number; state?: string } = {}): WaterConditions {
  const scale = options.metresPerSecondAtUnitStrength ?? 8;
  if (!Number.isFinite(scale) || scale < 0 || scale > 37.5) throw new Error('Water wind conversion must be within 0..37.5 m/s.');
  const { wind } = sampleTerrainEnvironment(recipe, point, timeSeconds);
  return { windSpeed: wind.strength * scale, windDirection: Math.atan2(wind.direction[1], wind.direction[0]),
    ...(options.currentSpeed === undefined ? {} : { currentSpeed: options.currentSpeed }), ...(options.state === undefined ? {} : { state: options.state }) };
}
