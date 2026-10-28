import type { TerrainRecipe } from './terrain.ts';

export interface ForestMeadowOptions {
  seed?: number;
  /** Multiplies candidate acceptance, not the seed. Range 0–1.5 is useful for editing. */
  density?: number;
  path?: boolean;
  cabin?: boolean;
  statue?: boolean;
  /** Move the main trail sideways; landmarks keep stable positions and IDs. */
  pathOffset?: number;
}

/** A fully editable recipe, not an engine-defined biome. Keep IDs stable while
 * editing to preserve unrelated trees. Cosmetic shrubs/flowers/rocks deliberately
 * omit colliders; trees, cabin and statue are physical obstacles. */
export function forestMeadowTerrain(options: ForestMeadowOptions = {}): TerrainRecipe {
  const density = Math.max(0, Math.min(1.5, options.density ?? 1)), offset = options.pathOffset ?? 0;
  const path = options.path ?? true, cabin = options.cabin ?? true, statue = options.statue ?? true;
  const recipe: TerrainRecipe = {
    version: 1, seed: options.seed ?? 41,
    environment: { wind: { direction: [1, .35], strength: .45, gustStrength: .3, gustPeriod: 7, spatialScale: 45 },
      ambience: { recipe: 'recipe.meadow-ambience', gain: .7 } },
    bounds: { width: 64, depth: 56, cells: 32 },
    base: { height: .25, noise: { amplitude: 2.4, wavelength: 34, octaves: 3 } },
    budgets: { instances: 1200, candidates: 10000, colliders: 96 },
    assets: [
      { id: 'pine', footprint: { kind: 'circle', radius: 1.5 },
        collider: { shape: { kind: 'capsule', radius: .22, halfHeight: 1.3 }, offsetY: 1.52 },
        appearance: { kind: 'pine', color: '#416e53', height: 5.3 } },
      { id: 'golden-pine', footprint: { kind: 'circle', radius: 1.3 },
        collider: { shape: { kind: 'capsule', radius: .2, halfHeight: 1.25 }, offsetY: 1.45 },
        appearance: { kind: 'pine', color: '#769160', height: 4.6 } },
      { id: 'birch', footprint: { kind: 'circle', radius: 1.5 },
        collider: { shape: { kind: 'capsule', radius: .22, halfHeight: 1.3 }, offsetY: 1.52 },
        appearance: { kind: 'broadleaf', color: '#8eaa64', height: 4.2 } },
      { id: 'fern', footprint: { kind: 'circle', radius: .5 }, appearance: { kind: 'shrub', color: '#66835d', height: .65 } },
      { id: 'granite', footprint: { kind: 'circle', radius: .65 }, appearance: { kind: 'rock', color: '#9d9e90', height: .8 } },
      { id: 'wildflowers', footprint: { kind: 'circle', radius: .35 }, appearance: { kind: 'flowers', color: '#e6ce8f' } },
      { id: 'cabin', footprint: { kind: 'box', width: 6.5, depth: 5.3 },
        collider: { shape: { kind: 'box', halfExtents: { x: 3, y: 1.6, z: 2.4 } }, offsetY: 1.6 },
        appearance: { kind: 'cabin' } },
      { id: 'wayfinder', footprint: { kind: 'circle', radius: 1.3 },
        collider: { shape: { kind: 'box', halfExtents: { x: .75, y: 1.5, z: .75 } }, offsetY: 1.5 },
        appearance: { kind: 'statue', color: '#c3c9ad' } },
    ],
    regions: [
      { id: 'forest-west', mask: { kind: 'circle', center: { x: -15, z: -7 }, radius: 25 }, blend: 6,
        elevation: 1.3, color: '#567452', layers: [
          { id: 'canopy', assets: ['pine', 'golden-pine', 'birch'], spacing: 5.3, density: Math.min(1, .88 * density), scale: [.8, 1.22], maxSlope: .7 },
          { id: 'undergrowth', assets: ['fern'], spacing: 3.2, density: Math.min(1, .7 * density), scale: [.7, 1.4], maxSlope: .9 },
          { id: 'stones', assets: ['granite'], spacing: 6.5, density: Math.min(1, .4 * density), scale: [.7, 1.3] },
        ] },
      { id: 'forest-east', mask: { kind: 'circle', center: { x: 20, z: -10 }, radius: 23 }, blend: 6,
        elevation: .7, color: '#678255', layers: [
          { id: 'canopy', assets: ['pine', 'birch'], spacing: 5.7, density: Math.min(1, .82 * density), scale: [.85, 1.15], maxSlope: .7 },
          { id: 'undergrowth', assets: ['fern', 'granite'], spacing: 3.8, density: Math.min(1, .5 * density), scale: [.65, 1.25] },
        ] },
      { id: 'meadow', mask: { kind: 'circle', center: { x: 2, z: 15 }, radius: 24 }, blend: 10,
        color: '#a7af6d', layers: [
          { id: 'flowers', assets: ['wildflowers'], spacing: 2.8, density: Math.min(1, .6 * density), scale: [.7, 1.3] },
          { id: 'meadow-stones', assets: ['granite'], spacing: 9, density: Math.min(1, .25 * density), scale: [.5, .9] },
        ] },
    ],
    routes: path ? [{ id: 'main-trail', points: [
      { x: -25 + offset, z: 24 }, { x: -25 + offset, z: 10 }, { x: -18 + offset, z: 11 }, { x: -12 + offset, z: 11 },
      { x: -5 + offset, z: 8 }, { x: 2 + offset, z: 4 }, { x: 8 + offset, z: 2 },
      { x: 16 + offset, z: -7 }, { x: 21 + offset, z: -15 }, { x: 25 + offset, z: -22 },
    ], width: 2.6, shoulder: 1.2, clearance: .8, color: '#c5b18b', grade: { strength: .8, maxCutFill: 2, maxSlope: .55 } }] : [],
    placements: [
      ...(cabin ? [{ id: 'trail-cabin', asset: 'cabin', position: { x: 4, z: -8 }, clearance: 1.2, shoulder: 2.5,
        foundation: { blend: 6, maxCutFill: 3 }, entrances: [{ id: 'front-approach', points: [{ x: 4, z: -4.7 }, { x: 5, z: -1 }, { x: 8 + offset, z: 2 }], width: 2.2, clearance: .7 }] }] : []),
      ...(statue ? [{ id: 'wayfinder-plaza', asset: 'wayfinder', position: { x: -6, z: 2 }, clearance: 1.8, shoulder: 2,
        foundation: { blend: 2, maxCutFill: 2 }, entrances: [{ id: 'plaza-approach', points: [{ x: -6, z: 3.5 }, { x: -5 + offset, z: 8 }], width: 2, clearance: .5 }] }] : []),
    ],
  };
  for (const asset of recipe.assets) {
    if (['pine', 'broadleaf'].includes(String(asset.appearance?.kind))) asset.environment = {
      wind: { bendRadians: .035, swayHz: .3, referenceHeight: 5, sizeExponent: .6 },
      sound: { recipe: 'recipe.tree-rustle', gain: .65, referenceHeight: 5, sizeGainExponent: .6, windGain: [0, 1], radius: 30 },
    };
    else if (asset.id === 'fern') asset.environment = {
      wind: { bendRadians: .12, swayHz: .65, referenceHeight: .7, sizeExponent: .35 },
      sound: { recipe: 'recipe.bush-rustle', gain: .45, referenceHeight: .7, sizeGainExponent: .35, windGain: [0, 1], radius: 12 },
    };
    else if (asset.id === 'wildflowers') asset.environment = { wind: { bendRadians: .09, swayHz: .8, referenceHeight: .6 } };
  }
  for (const region of recipe.regions) region.environment = { ambience: {
    recipe: region.id === 'meadow' ? 'recipe.meadow-ambience' : 'recipe.forest-ambience', gain: .7,
  } };
  return recipe;
}
