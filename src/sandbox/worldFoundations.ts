/** Bounded terrain fitting used by worldPlan. Samples the original terrain;
 * generated native geometry is returned to the owning building manifest. */
import { BUILDING_LIMITS, type BuildingManifest, type BuildingPart, type BuildingRecipe, type BuildingSide } from './building.ts';
import { compileBuildingFootprint, footprintContainsPoint, type BuildingFootprint, type BuildingRectangle } from './buildingFootprints.ts';
import type { PhysicsCollider, PhysicsVector } from './physics.ts';
import { spatialCoordinate as snap, spatialAngle, transformSpatialPoint as transform } from './spatial.ts';
import type { WorldFoundationPolicy, WorldFoundationFit, WorldRoomLevelsPolicy } from './worldPlan.ts';
import { resolveSurfaceMaterial, validateSurfaceMaterialInput, type SurfaceMaterialInput } from './surfaceMaterials.ts';
export type { WorldFoundationPolicy, WorldFoundationFit, WorldRoomLevelsPolicy } from './worldPlan.ts';
export interface GroundEntrance { id: string; room: string; side: BuildingSide; position: { x: number; z: number }; width: number }
export function buildingFootprint(building: BuildingRecipe): BuildingFootprint {
  const envelope = { x: 0, z: 0, width: building.width, depth: building.depth };
  const result = compileBuildingFootprint(building.footprint ?? [envelope], envelope);
  if (!result.valid) throw new Error(result.issues.join(' ')); return result.footprint!;
}
/** Uses real union boundary edges, including concave notches. */
export function buildingGroundEntrances(building: BuildingRecipe): GroundEntrance[] {
  if (!Array.isArray(building.floors) || !building.floors.length || building.floors.some(floor => !floor || !Number.isFinite(floor.y))) return [];
  const shape = buildingFootprint(building), first = Math.min(...building.floors.map(floor => floor.y)), doors: GroundEntrance[] = [];
  for (const floor of building.floors.filter(floor => floor.y === first)) for (const opening of floor.openings ?? []) {
    if (opening.kind !== 'door' || (opening.bottom ?? 0) !== 0) continue;
    const room = floor.rooms.find(room => room.id === opening.room); if (!room) continue;
    const found = compileBuildingFootprint(room.footprint ?? [room], room); if (!found.valid) continue;
    const edges = found.footprint!.edges.filter(edge => edge.side === opening.side);
    const legacyAt = opening.side === 'north' ? room.z - room.depth / 2 : opening.side === 'south' ? room.z + room.depth / 2
      : opening.side === 'west' ? room.x - room.width / 2 : room.x + room.width / 2;
    const edge = opening.edge === undefined ? edges.find(edge => Math.abs(edge.at - legacyAt) < 1e-7) : edges[opening.edge];
    if (!edge) continue;
    const middle = opening.edge === undefined ? edge.axis === 'x' ? room.x : room.z : (edge.min + edge.max) / 2;
    const at = middle + (opening.offset ?? 0), low = at - opening.width / 2, high = at + opening.width / 2;
    if (!shape.edges.some(boundary => boundary.side === edge.side && Math.abs(boundary.at - edge.at) < 1e-7 && low >= boundary.min - 1e-7 && high <= boundary.max + 1e-7)) continue;
    doors.push({ id: opening.id, room: room.id, side: opening.side, position: edge.axis === 'x' ? { x: at, z: edge.at } : { x: edge.at, z: at }, width: opening.width });
  }
  return doors.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function fitWorldFoundation(building: BuildingRecipe, policy: WorldFoundationPolicy, roomPolicy: WorldRoomLevelsPolicy | undefined,
  position: { x: number; z: number }, yaw: number, sample: (x: number, z: number) => number, selectedEntrance?: string): { building: BuildingRecipe; footprint: BuildingFootprint; fit: WorldFoundationFit } {
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const requested = policy.mode ?? 'cut', maxCutFill = policy.maxCutFill ?? 4, clearance = policy.clearance ?? .45, maxClearance = policy.maxClearance ?? 6;
  if (!['cut', 'crawlspace', 'auto'].includes(requested) || policy.prefer !== undefined && !['cut', 'crawlspace'].includes(policy.prefer)
    || !finite(maxCutFill) || maxCutFill < 0 || maxCutFill > 128 || !finite(clearance) || clearance < 0 || clearance > 8
    || !finite(maxClearance) || maxClearance < clearance || maxClearance > 32 || policy.height !== undefined && (!finite(policy.height) || Math.abs(policy.height) > 9000)
    || policy.retainingColor !== undefined && (typeof policy.retainingColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(policy.retainingColor))) throw new Error('Foundation mode, clearance, cut/fill or color is invalid.');
  const footprint = buildingFootprint(building), floor = [...building.floors].sort((a, b) => a.y - b.y)[0];
  if (!floor) throw new Error('Terrain fitting requires a building floor.');
  const entrances = buildingGroundEntrances(building), selected = entrances.find(door => door.id === (selectedEntrance ?? building.primaryEntrance)) ?? entrances[0];
  const at = (point: { x: number; z: number }) => { const world = transform(point, position, yaw); return snap(sample(world.x, world.z)); };
  const referenceHeight = at(selected?.position ?? { x: 0, z: 0 }), locked = new Set(entrances.map(door => door.room));
  for (const stair of building.stairs ?? []) if (stair.fromFloor === floor.id || stair.toFloor === floor.id)
    for (const room of floor.rooms) if (footprintContainsPoint(compileBuildingFootprint(room.footprint ?? [room], room).footprint!, stair)) locked.add(room.id);
  let adapted = building;
  if (roomPolicy) {
    const step = roomPolicy.step, rise = roomPolicy.maxRise, drop = roomPolicy.maxDrop ?? 0;
    if (!finite(step) || step < .05 || step > 2 || !finite(rise) || rise < 0 || rise > 4 || !finite(drop) || drop < 0 || drop > 4
      || rise > floor.height - (building.actor?.height ?? 1.8) - (building.floorThickness ?? .16) - .1
      || roomPolicy.rooms !== undefined && (!Array.isArray(roomPolicy.rooms) || roomPolicy.rooms.length > 32 || new Set(roomPolicy.rooms).size !== roomPolicy.rooms.length || Array.from(roomPolicy.rooms).some(id => !floor.rooms.some(room => room.id === id))))
      throw new Error('Terrain room levels need step .05–2m, rise/drop0–4m, enough ceiling headroom and known unique ground-floor rooms.');
    const choose = new Set(roomPolicy.rooms ?? floor.rooms.map(room => room.id));
    adapted = { ...building, floors: building.floors.map(source => source !== floor ? source : { ...source, rooms: source.rooms.map(room => {
      if (!choose.has(room.id) || locked.has(room.id)) return locked.has(room.id) ? { ...room, elevation: 0 } : room;
      const shape = compileBuildingFootprint(room.footprint ?? [room], room).footprint!;
      const mean = shape.tiles.reduce((sum, tile) => sum + at(tile) * tile.width * tile.depth, 0) / shape.area;
      const elevation = snap(Math.max(-Math.floor(drop / step + 1e-9) * step, Math.min(Math.floor(rise / step + 1e-9) * step, Math.round((mean - referenceHeight) / step) * step)));
      return { ...room, elevation };
    }) }) };
  }
  const adaptedFloor = adapted.floors.find(candidate => candidate.id === floor.id)!, roomLevels = Object.fromEntries(adaptedFloor.rooms.map(room => [room.id, room.elevation ?? 0]));
  const lowest = Math.min(0, ...Object.values(roomLevels)), slab = building.floorThickness ?? .16;
  const probes = new Map<string, { x: number; z: number }>();
  const add = (point: { x: number; z: number }) => probes.set(`${snap(point.x)}:${snap(point.z)}`, point);
  for (const tile of footprint.tiles) {
    const nx = Math.max(1, Math.ceil(tile.width / 2)), nz = Math.max(1, Math.ceil(tile.depth / 2));
    if ((nx + 1) * (nz + 1) + probes.size > 4096) throw new Error('Foundation sampling exceeds4096 probes; reduce footprint complexity.');
    for (let x = 0; x <= nx; x++) for (let z = 0; z <= nz; z++) add({ x: tile.x + (x / nx - .5) * tile.width, z: tile.z + (z / nz - .5) * tile.depth });
  }
  const locations = [...probes.values()], heights = locations.map(at), terrainMin = Math.min(...heights), terrainMax = Math.max(...heights);
  const roomShapes = adaptedFloor.rooms.map(room => ({ elevation: Math.min(0, room.elevation ?? 0), shape: compileBuildingFootprint(room.footprint ?? [room], room).footprint! }));
  const candidate = (mode: 'cut' | 'crawlspace'): WorldFoundationFit => {
    const groundY = snap(policy.height ?? (mode === 'cut' ? referenceHeight : terrainMax + clearance + slab - .02 - lowest));
    const excavationY = snap(groundY + lowest);
    const clearances = locations.map((point, index) => {
      const owners = roomShapes.filter(room => footprintContainsPoint(room.shape, point));
      const elevation = owners.length ? Math.min(...owners.map(room => room.elevation)) : lowest;
      return groundY + .02 + elevation - slab - heights[index];
    });
    return { mode, requested, referenceHeight, terrainMin, terrainMax, groundY, excavationY,
      cut: snap(mode === 'cut' ? Math.max(0, terrainMax - excavationY) : 0), fill: snap(mode === 'cut' ? Math.max(0, excavationY - terrainMin) : 0),
      minClearance: snap(Math.min(...clearances)), maxClearance: snap(Math.max(...clearances)), sampleCount: probes.size, roomLevels };
  };
  const valid = (fit: WorldFoundationFit) => fit.mode === 'cut' ? Math.max(fit.cut, fit.fill) <= maxCutFill + 1e-6 : fit.minClearance >= clearance - 1e-6 && fit.maxClearance <= maxClearance + 1e-6;
  const preferred = requested === 'auto' ? policy.prefer ?? 'cut' : requested;
  let fit = candidate(preferred);
  if (!valid(fit) && requested === 'auto') fit = candidate(preferred === 'cut' ? 'crawlspace' : 'cut');
  if (!valid(fit)) throw new Error(`Foundation ${fit.mode} exceeds its ${fit.mode === 'cut' ? 'cut/fill' : 'crawlspace clearance'} budget (cut ${fit.cut}, fill ${fit.fill}, clearance ${fit.minClearance}–${fit.maxClearance}m).`);
  return { building: adapted, footprint, fit };
}

export function foundationBoxes(building: BuildingManifest, footprint: BuildingFootprint, fit: WorldFoundationFit,
  sample: (x: number, z: number) => number, color = '#807e73'): BuildingPart[] {
  const parts: BuildingPart[] = [], floor = [...building.recipe.floors].sort((a, b) => a.y - b.y)[0], yaw = building.recipe.yaw ?? 0, origin = building.recipe.origin!;
  const owners = [...floor.rooms].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(room => {
    const shape = compileBuildingFootprint(room.footprint ?? [room], room);
    if (!shape.valid) throw new Error(`Foundation room ${room.id}: ${shape.issues.join(' ')}`);
    // Positive elevations compile as solid pedestals down to the storey slab;
    // lowered rooms keep a thin slab at their own walking elevation.
    return { room, shape: shape.footprint!, top: origin.y + floor.y + Math.min(0, room.elevation ?? 0) - (building.recipe.floorThickness ?? .16) };
  });
  const add = (id: string, owner: typeof owners[number], p: { x: number; z: number }, width: number, depth: number, bottom: number) => {
    const top = owner.top, height = top - bottom;
    if (parts.length >= 256) throw new Error('Foundation support geometry exceeds256 boxes.');
    if (height < .04) return;
    parts.push({ id: `${building.id}:foundation:${id}`, kind: 'wall', position: { ...transform(p, origin, yaw), y: snap(top - height / 2) },
      size: { x: snap(width), y: snap(height), z: snap(depth) }, rotation: { x: 0, y: spatialAngle(Math.sin(yaw / 2)), z: 0, w: spatialAngle(Math.cos(yaw / 2)) },
      color, collidable: true, visible: true, exterior: true, floorId: floor.id, roomId: owner.room.id });
  };
  for (let index = 0; index < footprint.edges.length; index++) {
    const edge = footprint.edges[index];
    const breaks = [edge.min, edge.max, ...owners.flatMap(owner => owner.shape.edges.filter(e => e.axis === edge.axis && Math.abs(e.at - edge.at) < 1e-7)
      .flatMap(e => [Math.max(edge.min, Math.min(edge.max, e.min)), Math.max(edge.min, Math.min(edge.max, e.max))]))].sort((a, b) => a - b)
      .filter((value, i, values) => !i || value - values[i - 1] > 1e-7);
    for (let interval = 1; interval < breaks.length; interval++) {
      const low = breaks[interval - 1], high = breaks[interval], middle = (low + high) / 2;
      const inward = edge.side === 'north' || edge.side === 'west' ? .001 : -.001;
      const point = edge.axis === 'x' ? { x: middle, z: edge.at + inward } : { x: edge.at + inward, z: middle };
      const owner = owners.find(owner => footprintContainsPoint(owner.shape, point));
      if (!owner) throw new Error('A foundation boundary has no owning room.');
      const count = Math.max(1, Math.ceil((high - low) / 3));
      for (let segment = 0; segment < count; segment++) {
        const length = (high - low) / count, center = low + (segment + .5) * length, p = edge.axis === 'x' ? { x: center, z: edge.at } : { x: edge.at, z: center };
        const depths = [-.5, 0, .5].map(offset => { const point = transform(edge.axis === 'x' ? { x: center + offset * length, z: edge.at } : { x: edge.at, z: center + offset * length }, origin, yaw); return sample(point.x, point.z); });
        const bottom = fit.mode === 'cut' ? fit.excavationY - .4 : Math.min(...depths) - .2;
        add(`edge:${index}:${interval}:${segment}`, owner, p, edge.axis === 'x' ? length : .2, edge.axis === 'z' ? length : .2, bottom);
      }
    }
  }
  if (fit.mode === 'crawlspace') for (const owner of owners) for (const [index, tile] of owner.shape.tiles.entries()) {
    const width = Math.min(.35, tile.width), depth = Math.min(.35, tile.depth), heights: number[] = [];
    for (const dx of [-.5, 0, .5]) for (const dz of [-.5, 0, .5]) { const p = transform({ x: tile.x + dx * width, z: tile.z + dz * depth }, origin, yaw); heights.push(sample(p.x, p.z)); }
    add(`post:${owner.room.id}:${index}`, owner, tile, width, depth, Math.min(...heights) - .2);
  }
  return parts;
}
export function withFoundationParts(building: BuildingManifest, additions: BuildingPart[], revision: string, material?: SurfaceMaterialInput): BuildingManifest {
  if (!building.diagnostics.valid) throw new Error('Foundation geometry requires a valid compiled building.');
  if (material !== undefined) validateSurfaceMaterialInput(material);
  additions = additions.map(part => {
    const floor = building.recipe.floors.find(floor => floor.id === part.floorId);
    const role = part.kind === 'door' ? 'furniture' : part.kind;
    const source = material ?? floor?.materials?.[role] ?? building.recipe.materials?.[role];
    return part.material || source === undefined ? part : { ...part, material: resolveSurfaceMaterial(source,
      { seed: (building.recipe.seed ?? 0) >>> 0, key: `${building.id}:foundation:${part.floorId ?? ''}:${part.kind}` }) };
  });
  const count = building.parts.reduce((sum, part) => sum + (part.model?.parts.length ?? 1), 0) + additions.length;
  if (count > BUILDING_LIMITS.parts || building.colliders.length + additions.filter(part => part.collidable).length > BUILDING_LIMITS.colliders)
    throw new Error('Foundation geometry exceeds the per-building part or collider budget.');
  const ids = new Set(building.parts.map(part => part.id));
  for (const part of additions) {
    if (part.model || ids.has(part.id) || !Object.values(part.size).every(n => Number.isFinite(n) && n >= .04 && n <= 2000)
      || !Object.values(part.position).every(n => Number.isFinite(n) && Math.abs(n) <= 10000)
      || !Object.values(part.rotation).every(Number.isFinite) || Math.abs(Object.values(part.rotation).reduce((sum, n) => sum + n * n, 0) - 1) > .001)
      throw new Error('Foundation additions need unique primitive boxes with bounded dimensions and valid transforms.');
    ids.add(part.id);
  }
  const parts = [...building.parts, ...additions], colliders: PhysicsCollider[] = [...building.colliders, ...additions.filter(part => part.collidable).map(part => ({ shape: { kind: 'box' as const,
    halfExtents: { x: part.size.x / 2, y: part.size.y / 2, z: part.size.z / 2 } }, position: part.position, rotation: part.rotation, friction: .8 }))];
  const bounds = { min: { ...building.bounds.min }, max: { ...building.bounds.max } };
  for (const part of additions) {
    const q = part.rotation, norm = Math.hypot(q.x, q.y, q.z, q.w), x = q.x / norm, y = q.y / norm, z = q.z / norm, w = q.w / norm;
    const hx = part.size.x / 2, hy = part.size.y / 2, hz = part.size.z / 2;
    const reach = { x: Math.abs(1 - 2 * (y * y + z * z)) * hx + Math.abs(2 * (x * y - z * w)) * hy + Math.abs(2 * (x * z + y * w)) * hz,
      y: Math.abs(2 * (x * y + z * w)) * hx + Math.abs(1 - 2 * (x * x + z * z)) * hy + Math.abs(2 * (y * z - x * w)) * hz,
      z: Math.abs(2 * (x * z - y * w)) * hx + Math.abs(2 * (y * z + x * w)) * hy + Math.abs(1 - 2 * (x * x + y * y)) * hz };
    for (const axis of ['x', 'y', 'z'] as const) { bounds.min[axis] = Math.min(bounds.min[axis], part.position[axis] - reach[axis]); bounds.max[axis] = Math.max(bounds.max[axis], part.position[axis] + reach[axis]); }
  }
  if (Object.values(bounds.min).concat(Object.values(bounds.max)).some(n => Math.abs(n) > 10000)) throw new Error('Foundation geometry extends beyond the physics world bounds.');
  return { ...building, revision: `${building.revision}:${revision}`, parts, colliders, bounds,
    diagnostics: { ...building.diagnostics, counts: { ...building.diagnostics.counts, parts: count, colliders: colliders.length } } };
}
export function foundationRamp(id: string, from: PhysicsVector, to: PhysicsVector, width: number, floorId: string, color: string): BuildingPart {
  const dx = to.x - from.x, dz = to.z - from.z, run = Math.hypot(dx, dz), rise = to.y - from.y, yaw = Math.atan2(dx, dz), pitch = -Math.atan2(rise, run), thickness = .16;
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sx = Math.sin(pitch / 2), cx = Math.cos(pitch / 2);
  return { id, kind: 'stair', position: { x: snap((from.x + to.x) / 2), y: snap((from.y + to.y) / 2 - thickness / 2 / Math.cos(pitch)), z: snap((from.z + to.z) / 2) },
    size: { x: width, y: thickness, z: snap(Math.hypot(run, rise) + .04) }, rotation: { x: spatialAngle(cy * sx), y: spatialAngle(sy * cx), z: spatialAngle(-sy * sx), w: spatialAngle(cy * cx) },
    color, collidable: true, visible: true, exterior: true, floorId };
}
export function expandedFoundationTiles(footprint: BuildingFootprint, margin: number): BuildingRectangle[] {
  return footprint.tiles.map(tile => ({ ...tile, width: snap(tile.width + margin * 2), depth: snap(tile.depth + margin * 2) }));
}
