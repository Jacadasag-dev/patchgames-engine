/** Seeded Arena destinations shared by generation, loot, rendering and physics. */
export interface ArenaLayoutTuning { arenaRadius: number; spawnRadius: number; supplyRadius: number; terrainSeed?: number }
export interface ArenaBuildingPart { id: string; x: number; y: number; z: number; width: number; height: number; depth: number; material: 'wall' | 'roof' }
/** A room is five wall segments around a 2.8m opening, plus a roof. The same
 * editable pieces are rendered and converted to colliders; no solid room box. */
export function arenaBuildingParts(): ArenaBuildingPart[] {
  return [
    { id: 'west-wall', x: -4, y: 1.7, z: 0, width: .35, height: 3.4, depth: 8.35, material: 'wall' },
    { id: 'east-wall', x: 4, y: 1.7, z: 0, width: .35, height: 3.4, depth: 8.35, material: 'wall' },
    { id: 'back-wall', x: 0, y: 1.7, z: -4, width: 8, height: 3.4, depth: .35, material: 'wall' },
    { id: 'front-left', x: -2.7, y: 1.7, z: 4, width: 2.6, height: 3.4, depth: .35, material: 'wall' },
    { id: 'front-right', x: 2.7, y: 1.7, z: 4, width: 2.6, height: 3.4, depth: .35, material: 'wall' },
    { id: 'roof', x: 0, y: 3.55, z: 0, width: 8.6, height: .3, depth: 8.6, material: 'roof' },
  ];
}
const precision = (n: number) => Math.round(n * 1e6) / 1e6;
export function arenaBuildingPoint(site: { x: number; z: number; yaw: number }, x: number, z: number, scale = 1) {
  return { x: precision(site.x + (Math.cos(site.yaw) * x + Math.sin(site.yaw) * z) * scale),
    z: precision(site.z + (-Math.sin(site.yaw) * x + Math.cos(site.yaw) * z) * scale) };
}
function seeded(seed: number, key: string) {
  let value = seed | 0;
  for (let i = 0; i < key.length; i++) value = Math.imul(value ^ key.charCodeAt(i), 16777619);
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}
function nearest(point: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) {
  const dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz)));
  const result = { x: precision(a.x + dx * t), z: precision(a.z + dz * t) };
  return { ...result, distance: Math.hypot(point.x - result.x, point.z - result.z) };
}
export function arenaLayout(tuning: ArenaLayoutTuning) {
  const scale = tuning.arenaRadius / 96, seed = Math.floor(tuning.terrainSeed ?? 73);
  const point = (x: number, z: number) => ({ x: precision(x * scale), z: precision(z * scale) });
  const trails = [
    { id: 'pine-trail', points: [[0, 0], [-14, -14], [-19, -28], [-21, -48], [-35, -66]] },
    { id: 'ridge-trail', points: [[0, 0], [17, -10], [34, -16], [48, -20], [61, -43]] },
    { id: 'ruins-trail', points: [[0, 0], [-16, 12], [-28, 21], [-46, 26], [-62, 42]] },
    { id: 'meadow-trail', points: [[0, 0], [13, 19], [16, 36], [24, 53], [43, 67]] },
    { id: 'north-loop', points: [[-35, -66], [-3, -64], [29, -58], [61, -43]] },
    { id: 'south-loop', points: [[-62, 42], [-22, 63], [14, 69], [43, 67]] },
  ].map(trail => ({ id: trail.id, points: trail.points.map(([x, z]) => point(x, z)) }));
  const landmarks = [
    { id: 'ranger-camp', label: 'Ranger cabin', kind: 'camp', x: -36, z: -42 },
    { id: 'stone-lookout', label: 'Stone watchpost', kind: 'lookout', x: 60, z: -12 },
    { id: 'old-ruins', label: 'Ruined lodge', kind: 'ruin', x: -60, z: 18 },
    { id: 'meadow-shrine', label: 'Meadow lodge', kind: 'shrine', x: 36, z: 48 },
  ].map(site => {
    // Grid-aligned foundations keep every room on the accepted flat heightfield.
    // The seed picks among safe sites, without moving neighbouring trail objects.
    const candidates = [-1, 0, 1].flatMap(ix => [-1, 0, 1].map(iz => ({ ...point(site.x + ix * 6, site.z + iz * 6),
      priority: seeded(seed, `${site.id}:${ix}:${iz}`) }))).sort((a, b) => a.priority - b.priority);
    const accesses = (candidate: { x: number; z: number }) => trails.flatMap(trail => trail.points.slice(1).map((b, i) => nearest(candidate, trail.points[i], b)))
      .sort((a, b) => a.distance - b.distance);
    const candidate = candidates.find(candidate => accesses(candidate)[0].distance >= 12 * scale) ?? point(site.x, site.z);
    const approach = accesses(candidate)[0], yaw = precision(Math.round(Math.atan2(approach.x - candidate.x, approach.z - candidate.z) / (Math.PI / 2)) * Math.PI / 2);
    return { ...site, x: candidate.x, z: candidate.z, yaw, approach: { x: approach.x, z: approach.z } };
  });
  const lootSites = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `center-${index}`, kind: 'center' as const,
      x: precision(Math.sin(index * Math.PI / 4) * tuning.supplyRadius), z: precision(Math.cos(index * Math.PI / 4) * tuning.supplyRadius) })),
    ...landmarks.flatMap(site => [-1, 1].map((side, index) => ({ id: `${site.id}-chest-${index}`, kind: 'cache' as const, buildingId: site.id,
      ...arenaBuildingPoint(site, side * (1.5 + seeded(seed, `${site.id}:chest:${index}:x`) * .7), -1.2 - seeded(seed, `${site.id}:chest:${index}:z`) * 1.1, scale) }))),
    ...trails.flatMap((trail, index) => [0, 1].map(slot => {
      const segment = index < 4 ? slot + 2 : slot + 1, a = trail.points[segment - 1], b = trail.points[segment];
      const t = .25 + seeded(seed, `${trail.id}:chest:${slot}`) * .5;
      // Reserve by the same path: no tree, rock or later building can occupy a chest.
      return { id: `${trail.id}-cache-${slot}`, kind: 'cache' as const, x: precision(a.x + (b.x - a.x) * t), z: precision(a.z + (b.z - a.z) * t) };
    })),
  ];
  return { seed, scale, centerRadius: Math.min(tuning.arenaRadius * .35, Math.max(22 * scale, tuning.spawnRadius + 8 * scale)), trails, landmarks, lootSites };
}

