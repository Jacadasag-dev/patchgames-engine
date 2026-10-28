/** Conservative terrain-v1 edit dependencies. Only local reservation/override
 * edits are eligible; an unrecognized dependency always regenerates geometry. */
import type { TerrainFootprint, TerrainPlacement, TerrainRecipe, TerrainRoute } from './terrain.ts';

export interface TerrainDependencyBounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface TerrainEditDependencies { fullRebuild: boolean; bounds: TerrainDependencyBounds[] }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const radius = (shape: TerrainFootprint) => shape.kind === 'circle' ? shape.radius : Math.hypot(shape.width, shape.depth) / 2;
const known = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const globalPart = ({ routes: _routes, placements: _placements, overrides: _overrides, reservations: _reservations, ...rest }: TerrainRecipe) => rest;

// This decoder accepts only this compiler version's stable candidate IDs.
// Encoded labels and their hashes must match an actual region/layer pair.
function label(value: string): string {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619);
  n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); n ^= n >>> 15; n = Math.imul(n, 0x846ca68b);
  return `${encodeURIComponent(value).slice(0, 24)}~${((n ^ n >>> 16) >>> 0).toString(16).padStart(8, '0')}`;
}

/** Called only after both recipes pass global metadata validation. Bounds cover
 * old AND new locations, scatter footprint reach, blends and sampled cell edges. */
export function terrainEditDependencies(previous: TerrainRecipe, next: TerrainRecipe, cellSize: number): TerrainEditDependencies {
  const full = (): TerrainEditDependencies => ({ fullRebuild: true, bounds: [] });
  if (!Number.isFinite(cellSize) || cellSize <= 0 || canonical(globalPart(previous)) !== canonical(globalPart(next))) return full();
  if (![previous.overrides ?? {}, next.overrides ?? {}].every(value => known(value, ['remove', 'pin']))) return full();
  const assets = new Map(next.assets.map(asset => [asset.id, asset]));
  const scatterReach = Math.max(0, ...next.regions.flatMap(region => region.layers.flatMap(layer =>
    layer.assets.map(id => radius(assets.get(id)!.footprint) * (layer.scale?.[1] ?? 1)))));
  const guard = scatterReach + cellSize * 2, bounds: TerrainDependencyBounds[] = [];
  const circle = (x: number, z: number, reach: number) => bounds.push({ minX: x - reach, maxX: x + reach, minZ: z - reach, maxZ: z + reach });
  const routeBounds = (route: Pick<TerrainRoute, 'points' | 'width' | 'clearance' | 'shoulder'>) => {
    const reach = route.width / 2 + (route.clearance ?? 0) + Math.max(route.shoulder ?? cellSize, cellSize) + guard;
    bounds.push({ minX: Math.min(...route.points.map(p => p.x)) - reach, maxX: Math.max(...route.points.map(p => p.x)) + reach,
      minZ: Math.min(...route.points.map(p => p.z)) - reach, maxZ: Math.max(...route.points.map(p => p.z)) + reach });
  };
  const changed = <T extends { id: string }>(before: readonly T[], after: readonly T[]): T[] => {
    const a = new Map(before.map(item => [item.id, item])), b = new Map(after.map(item => [item.id, item]));
    const ids = new Set([...a.keys(), ...b.keys()]);
    return [...ids].flatMap(id => canonical(a.get(id)) === canonical(b.get(id)) ? [] : [a.get(id), b.get(id)].filter((v): v is T => !!v));
  };
  const routes = changed(previous.routes ?? [], next.routes ?? []), routeIds = new Set(routes.map(route => route.id));
  if (routes.some(route => !known(route, ['id', 'points', 'width', 'shoulder', 'clearance', 'color', 'material', 'allowPlacements', 'grade']) || route.width < cellSize)) return full();
  // Facing and preference queries can observe a moved route from any distance.
  for (const recipe of [previous, next]) {
    for (const layer of recipe.regions.flatMap(region => region.layers)) if (layer.facing && 'route' in layer.facing && routeIds.has(layer.facing.route)
      || layer.preferences?.some(preference => 'route' in preference.target && routeIds.has(preference.target.route))) return full();
    for (const placement of [...recipe.placements ?? [], ...recipe.overrides?.pin ?? []])
      if (placement.facing && 'route' in placement.facing && routeIds.has(placement.facing.route)) return full();
  }
  routes.forEach(routeBounds);
  const candidates = new Map<string, { spacing: number }[]>();
  for (const region of next.regions) for (const layer of region.layers) {
    const prefix = `scatter:${label(region.id)}:${label(layer.id)}`;
    candidates.set(prefix, [...candidates.get(prefix) ?? [], layer]);
  }
  const candidateBounds = (id: string): boolean => {
    const match = /^(scatter:[^:]+:[^:]+):(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(id);
    if (!match) return false;
    const layers = candidates.get(match[1]), col = Number(match[2]), row = Number(match[3]);
    if (layers?.length !== 1 || !Number.isSafeInteger(col) || !Number.isSafeInteger(row)) return false;
    const spacing = layers[0].spacing;
    if (col >= Math.ceil(next.bounds.width / spacing) || row >= Math.ceil(next.bounds.depth / spacing)) return false;
    const x = -next.bounds.width / 2 + col * spacing, z = -next.bounds.depth / 2 + row * spacing;
    bounds.push({ minX: x - guard, maxX: x + spacing + guard, minZ: z - guard, maxZ: z + spacing + guard }); return true;
  };
  const placements: TerrainPlacement[] = [
    ...changed(previous.placements ?? [], next.placements ?? []), ...changed(previous.overrides?.pin ?? [], next.overrides?.pin ?? []),
  ];
  for (const placement of placements) {
    if (!known(placement, ['id', 'asset', 'position', 'yaw', 'facing', 'scale', 'clearance', 'shoulder', 'foundation', 'foundationGroup', 'entrances'])) return full();
    const reach = radius(assets.get(placement.asset)!.footprint) * (placement.scale ?? 1);
    circle(placement.position.x, placement.position.z, reach + Math.max((placement.clearance ?? 0) + (placement.shoulder ?? 0),
      placement.foundation ? placement.foundation.blend ?? placement.shoulder ?? cellSize : 0) + guard);
    for (const entrance of placement.entrances ?? []) routeBounds({ ...entrance, shoulder: placement.shoulder });
    if (placement.id.startsWith('scatter:') && !candidateBounds(placement.id)) return full();
  }
  for (const reservation of changed(previous.reservations ?? [], next.reservations ?? [])) {
    if (!known(reservation, ['id', 'mask', 'clearance', 'shoulder'])) return full();
    circle(reservation.mask.center.x, reservation.mask.center.z,
      radius(reservation.mask) + (reservation.clearance ?? 0) + (reservation.shoulder ?? 0) + guard);
  }
  const before = new Set(previous.overrides?.remove ?? []), after = new Set(next.overrides?.remove ?? []);
  const removals = [...before].filter(id => !after.has(id)).concat([...after].filter(id => !before.has(id)));
  if (removals.length > 2048 || removals.some(id => !candidateBounds(id))) return full();
  // Foundation diagnostics are reported by the chunk owning the foundation's
  // centre. Include that owner when an edit can touch its footprint/probes,
  // even if a large foundation reaches far beyond its owning chunk.
  const editedBounds = [...bounds];
  for (const placement of [...previous.placements ?? [], ...previous.overrides?.pin ?? [], ...next.placements ?? [], ...next.overrides?.pin ?? []]) {
    if (!placement.foundation) continue;
    const reach = radius(assets.get(placement.asset)!.footprint) * (placement.scale ?? 1)
      + (placement.foundation.blend ?? placement.shoulder ?? cellSize) + cellSize * 2;
    const x = placement.position.x, z = placement.position.z;
    if (editedBounds.some(bound => terrainDependencyTouches(bound, { minX: x - reach, maxX: x + reach, minZ: z - reach, maxZ: z + reach }))) circle(x, z, cellSize * 2);
  }
  return { fullRebuild: false, bounds };
}

export function terrainDependencyTouches(bounds: TerrainDependencyBounds, window: TerrainDependencyBounds): boolean {
  return bounds.minX <= window.maxX && bounds.maxX >= window.minX && bounds.minZ <= window.maxZ && bounds.maxZ >= window.minZ;
}
