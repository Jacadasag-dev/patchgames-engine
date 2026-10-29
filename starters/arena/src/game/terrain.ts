import type { TerrainRecipe } from '../sandbox/terrain.ts';
import { arenaLayout, arenaBuildingPoint } from './layout.ts';
import type { GameTuning } from './tuning.ts';

/** Editable shared-system recipe: stable seeded biomes respond automatically to
 * paths, protected landmarks and loot clearings before any scatter is placed. */
export function arenaTerrain(tuning: GameTuning): TerrainRecipe {
  const layout = arenaLayout(tuning), s = layout.scale, r = tuning.arenaRadius;
  // Tiny combat/test arenas cannot fit life-size camps and forest circulation.
  // Preserve a usable clean surface there; the survival layout scales from 40m.
  if (r < 40) return { version: 1, seed: layout.seed, bounds: { width: r * 2, depth: r * 2, cells: 32 }, assets: [],
    regions: [{ id: 'arena', mask: { kind: 'circle', center: { x: 0, z: 0 }, radius: r }, color: '#788b58', layers: [] }] };
  const circle = (x: number, z: number, radius: number) => ({ kind: 'circle' as const, center: { x: x * s, z: z * s }, radius: radius * s });
  const clearing = (id: string, x: number, z: number, width: number) => ({ id, points: [{ x: x - .01 * s, z }, { x: x + .01 * s, z }],
    width, shoulder: 2 * s, clearance: .65 * s, color: '#b8a47a', allowPlacements: true });
  const trailPoints = (points: { x: number; z: number }[]) => {
    if (points[0].x || points[0].z) return points;
    const first = points.findIndex(point => Math.hypot(point.x, point.z) > layout.centerRadius);
    if (first < 0) return points;
    const endpoint = points[first], fraction = layout.centerRadius / Math.hypot(endpoint.x, endpoint.z);
    // Keep the plaza editable; protected travel corridors begin at its edge.
    // Quantized authored coordinates also avoid libm drift across JS engines.
    return [{ x: Math.round(endpoint.x * fraction * 1e6) / 1e6, z: Math.round(endpoint.z * fraction * 1e6) / 1e6 }, ...points.slice(first)];
  };
  const recipe: TerrainRecipe = {
    version: 1, seed: layout.seed, bounds: { width: r * 2, depth: r * 2, cells: 32 },
    environment: { wind: { direction: [1, .4], strength: .4, gustStrength: .3 },
      ambience: { recipe: 'recipe.meadow-ambience', gain: .5 } },
    base: { height: 3 * s, noise: { amplitude: 8 * s, wavelength: 80 * s, octaves: 1 } },
    budgets: { instances: 1200, candidates: 12000, colliders: 52 },
    assets: [
      { id: 'arena-pine', footprint: { kind: 'circle', radius: 1.4 },
        collider: { shape: { kind: 'capsule', radius: .38, halfHeight: 2.2 }, offsetY: 2.58 },
        appearance: { kind: 'arena-pine', color: '#355747', height: 10.5 } },
      { id: 'arena-fir', footprint: { kind: 'circle', radius: 1.2 },
        collider: { shape: { kind: 'capsule', radius: .32, halfHeight: 1.8 }, offsetY: 2.12 },
        appearance: { kind: 'arena-pine', color: '#567457', height: 8.4 } },
      { id: 'arena-oak', footprint: { kind: 'circle', radius: 1.6 },
        collider: { shape: { kind: 'capsule', radius: .44, halfHeight: 2 }, offsetY: 2.44 },
        appearance: { kind: 'arena-oak', color: '#708549', height: 9 } },
      { id: 'arena-boulder', footprint: { kind: 'circle', radius: 2.1 },
        collider: { shape: { kind: 'ball', radius: 1.6 }, offsetY: 1.2 }, appearance: { kind: 'arena-boulder', color: '#929387', height: 3 } },
      { id: 'arena-fern', footprint: { kind: 'circle', radius: .6 }, appearance: { kind: 'shrub', color: '#687f48', height: .75 } },
      { id: 'arena-rubble', footprint: { kind: 'circle', radius: .5 }, appearance: { kind: 'rock', color: '#a0a18d', height: .4 } },
      { id: 'arena-flowers', footprint: { kind: 'circle', radius: .4 }, appearance: { kind: 'flowers', color: '#e7cf8b' } },
      ...['camp', 'lookout', 'ruin', 'shrine'].map(kind => ({ id: `arena-${kind}`,
        footprint: { kind: 'box' as const, width: 12, depth: 12 }, appearance: { kind: `arena-${kind}` } })),
    ],
    regions: [
      { id: '00-ground', mask: circle(0, 0, 150), color: '#788b58', layers: [] },
      { id: '10-pinewood', mask: circle(-30, -35, 48), blend: 9 * s, elevation: 3 * s, color: '#596f48', layers: [
        { id: 'trees', assets: ['arena-pine', 'arena-fir'], spacing: 16 * s, density: .94, scale: [.85 * s, 1.25 * s], maxSlope: .6 },
        { id: 'ferns', assets: ['arena-fern'], spacing: 16 * s, density: .7, scale: [.8 * s, 1.6 * s], maxSlope: .8 },
      ] },
      { id: '20-east-woods', mask: circle(39, -28, 43), blend: 10 * s, elevation: 5 * s, color: '#68794d', layers: [
        { id: 'trees', assets: ['arena-pine', 'arena-oak'], spacing: 17 * s, density: .94, scale: [.85 * s, 1.2 * s], maxSlope: .6 },
        { id: 'ferns', assets: ['arena-fern', 'arena-rubble'], spacing: 16 * s, density: .7, scale: [.8 * s, 1.6 * s] },
      ] },
      { id: '30-ruin-woods', mask: circle(-43, 31, 39), blend: 8 * s, elevation: 1.5 * s, color: '#748454', layers: [
        { id: 'trees', assets: ['arena-oak', 'arena-fir'], spacing: 16.5 * s, density: .92, scale: [.85 * s, 1.2 * s], maxSlope: .6 },
        { id: 'floor', assets: ['arena-fern', 'arena-rubble'], spacing: 16 * s, density: .55, scale: [.8 * s, 1.4 * s] },
      ] },
      { id: '40-meadow', mask: circle(26, 43, 43), blend: 11 * s, color: '#a0a568', layers: [
        { id: 'oaks', assets: ['arena-oak'], spacing: 21 * s, density: .55, scale: [s, 1.2 * s], maxSlope: .6 },
        { id: 'flowers', assets: ['arena-flowers'], spacing: 14 * s, density: .72, scale: [.8 * s, 1.5 * s] },
      ] },
      { id: '50-rocky-ridge', mask: circle(61, 5, 26), blend: 12 * s, elevation: 8 * s, color: '#9b9d78', layers: [
        { id: 'boulders', assets: ['arena-boulder'], spacing: 16 * s, density: .7, scale: [.8 * s, 1.3 * s], maxSlope: .7 },
        { id: 'rubble', assets: ['arena-rubble'], spacing: 16 * s, density: .65, scale: [.8 * s, 1.6 * s] },
      ] },
    ],
    routes: [
      { ...clearing('cornucopia-clearing', 0, 0, layout.centerRadius * 2), shoulder: 16 * s, grade: { strength: 1, maxCutFill: 20 * s } },
      ...layout.trails.map(trail => ({ ...trail, points: trailPoints(trail.points), width: 6.5 * s, clearance: .65 * s, shoulder: 1.5 * s,
        color: '#b5a47c' })),
      // Outdoor chests use seeded points along these reserved corridors. Interior
      // chests inherit each protected room's flat, scatter-free foundation.
    ],
    placements: layout.landmarks.map(site => ({ id: site.id, asset: `arena-${site.kind}`, position: { x: site.x, z: site.z },
      scale: s, yaw: site.yaw, clearance: 1.3 * s, shoulder: 2 * s,
      foundation: { blend: 22 * s, maxCutFill: 20 * s }, entrances: [{ id: 'trail-approach',
        points: [arenaBuildingPoint(site, 0, 4, s), arenaBuildingPoint(site, 0, 8, s), site.approach], width: 3 * s, clearance: .65 * s }] })),
  };
  for (const asset of recipe.assets) {
    if (['arena-pine', 'arena-fir', 'arena-oak'].includes(asset.id)) asset.environment = {
      wind: { bendRadians: .025, swayHz: .25, referenceHeight: 9, sizeExponent: .6 },
      sound: { recipe: 'recipe.tree-rustle', gain: .6, referenceHeight: 9, sizeGainExponent: .6, radius: 32 },
    };
    else if (asset.id === 'arena-fern') asset.environment = {
      wind: { bendRadians: .1, swayHz: .6, referenceHeight: .75 },
      sound: { recipe: 'recipe.bush-rustle', gain: .4, referenceHeight: .75, radius: 12 },
    };
    else if (asset.id === 'arena-flowers') asset.environment = { wind: { bendRadians: .08, referenceHeight: .6 } };
  }
  for (const region of recipe.regions) if (['10-pinewood', '20-east-woods', '30-ruin-woods'].includes(region.id))
    region.environment = { ambience: { recipe: 'recipe.forest-ambience', gain: .6 } };
  return recipe;
}
