import type { BuildingFloorRecipe, BuildingMaterials, BuildingOpeningRecipe, BuildingRoomRecipe, BuildingSide } from './building.ts';
import { resolveBuildingDoorIntent, validateBuildingDoorPolicy } from './building.ts';
import { validateBuildingDoorSelection, type BuildingDoorSelection } from './buildingDoors.ts';
import { compileBuildingFootprint, footprintContainsPoint, type BuildingFootprintEdge } from './buildingFootprints.ts';
import { validateSurfaceMaterialInput } from './surfaceMaterials.ts';

/** A reusable authored partition topology. First occupies west (-X) or north
 * (-Z). Leaf weights set the default split; explicit ranges vary it by seed. */
export type BuildingLayoutNode = ({ kind: 'room'; weight?: number; minWidth?: number; minDepth?: number }
  & Omit<BuildingRoomRecipe, 'x' | 'z' | 'width' | 'depth' | 'footprint'>)
  | { kind: 'split'; id: string; axis: 'x' | 'z'; ratio?: number | [number, number]; first: BuildingLayoutNode; second: BuildingLayoutNode };
/** Ratio uses the usable shared wall after corner margins. Without ratio,
 * sample metres in [min,max]. The available span caps max, never min. */
export interface BuildingConnectionWidth { min: number; max: number; ratio?: number | [number, number] }
export type BuildingLayoutConnection = { id: string; rooms: [string, string]; door?: false | BuildingDoorSelection } & ({
  kind?: 'door'; width: number | BuildingConnectionWidth; height: number;
  /** Fraction along the usable shared wall, 0..1; defaults to its centre. */
  at?: number;
  transition?: BuildingOpeningRecipe['transition'];
} | {
  /** Open removes every shared wall span; closed leaves all shared walls intact.
   * Open rooms retain separate semantic IDs and must have equal elevations. */
  kind: 'open' | 'closed'; width?: never; height?: never; at?: never; transition?: never;
});
/** Combine adjacent partition leaves into an editable L/T-shaped room. Source
 * leaf IDs are replaced by id before connections/openings are resolved. */
export interface BuildingLayoutMerge extends Omit<BuildingRoomRecipe, 'x' | 'z' | 'width' | 'depth' | 'footprint'> { rooms: string[] }
export interface BuildingLayoutOpening extends Omit<BuildingOpeningRecipe, 'offset'> {
  /** Fraction along the usable exterior wall, 0..1; defaults to its centre. */
  at?: number;
}
export interface BuildingFloorLayout {
  seed: number; width: number; depth: number; floorId: string; y?: number; height?: number; wallThickness?: number; floorThickness?: number;
  layout: BuildingLayoutNode; merges?: BuildingLayoutMerge[]; connections?: BuildingLayoutConnection[]; openings?: BuildingLayoutOpening[];
  materials?: BuildingMaterials;
  doors?: BuildingDoorSelection;
}
export interface BuildingLayoutDoor {
  id: string; rooms: [string, string]; side: BuildingSide; offset: number; width: number;
  /** One entry per resolved span; open/closed entries name their authored connection. */
  kind?: 'door' | 'open' | 'closed'; connectionId?: string;
  /** Shared wall interval and centre, all building-local metres. */
  span: { min: number; max: number }; position: { x: number; z: number };
}
export interface BuildingLayoutResult {
  floor: BuildingFloorRecipe; connections: BuildingLayoutDoor[];
  diagnostics: { valid: boolean; attempts: number; issues: { code: string; message: string; ids: string[] }[] };
}
export const BUILDING_LAYOUT_LIMITS = Object.freeze({ rooms: 32, nodes: 63, depth: 12, openings: 128, attempts: 16 });
type Requirements = { width: number; depth: number; weight: number };
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const widthValid = (value: unknown): value is number | BuildingConnectionWidth => {
  if (finite(value)) return value > 0 && value <= 128;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const width = value as BuildingConnectionWidth;
  if (Object.keys(width).some(key => !['min', 'max', 'ratio'].includes(key)) || !finite(width.min) || !finite(width.max)
    || width.min <= 0 || width.max < width.min || width.max > 128) return false;
  const range = width.ratio === undefined ? undefined : Array.isArray(width.ratio) ? width.ratio : [width.ratio, width.ratio];
  return !range || range.length === 2 && [range[0], range[1]].every(n => finite(n) && n > 0 && n <= 1) && range[0] <= range[1];
};
const idOkay = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(id);
const sides: BuildingSide[] = ['north', 'south', 'east', 'west'];
function copyMaterials(input: BuildingMaterials, room = false): BuildingMaterials {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !(room ? ['wall', 'floor', 'ceiling'] : ['wall', 'floor', 'ceiling', 'roof', 'stair', 'furniture']).includes(key))) throw new Error('Unknown material surface role.');
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, validateSurfaceMaterialInput(value)]));
}
const validMaterials = (input: BuildingMaterials | undefined) => { try { if (input !== undefined) copyMaterials(input, true); return true; } catch { return false; } };
const validDoorPolicy = (input: BuildingRoomRecipe['doorPolicy']) => { try { if (input !== undefined) validateBuildingDoorPolicy(input); return true; } catch { return false; } };
const roomMetadataValid = (room: Pick<BuildingRoomRecipe, 'access' | 'elevation' | 'label' | 'purpose' | 'orientation' | 'materials' | 'doorPolicy'>): boolean =>
  (room.elevation === undefined || finite(room.elevation) && Math.abs(room.elevation) <= 4)
  && validDoorPolicy(room.doorPolicy)
  && validMaterials(room.materials)
  && (room.access === undefined || ['public', 'circulation', 'private', 'service'].includes(room.access))
  && [room.label, room.purpose].every(text => text === undefined || typeof text === 'string' && text.length <= 512)
  && (room.orientation === undefined || !!room.orientation && typeof room.orientation === 'object' && !Array.isArray(room.orientation)
    && (room.orientation.front === undefined || sides.includes(room.orientation.front))
    && [room.orientation.entry, room.orientation.focalPoint].every(point => point === undefined || !!point && finite(point.x) && finite(point.z) && Math.abs(point.x) <= 10000 && Math.abs(point.z) <= 10000));
const rect = (r: BuildingRoomRecipe): Rect => ({ minX: r.x - r.width / 2, maxX: r.x + r.width / 2, minZ: r.z - r.depth / 2, maxZ: r.z + r.depth / 2 });
const edges = (room: BuildingRoomRecipe): BuildingFootprintEdge[] => compileBuildingFootprint(room.footprint ?? [room], room).footprint?.edges ?? [];
const opposite: Record<BuildingSide, BuildingSide> = { north: 'south', south: 'north', east: 'west', west: 'east' };
const openingEdge = (room: BuildingRoomRecipe, opening: BuildingOpeningRecipe): BuildingFootprintEdge | undefined => {
  const candidates = edges(room).filter(edge => edge.side === opening.side);
  if (opening.edge !== undefined) return candidates[opening.edge];
  const r = rect(room), at = opening.side === 'north' ? r.minZ : opening.side === 'south' ? r.maxZ : opening.side === 'west' ? r.minX : r.maxX;
  const center = (opening.side === 'north' || opening.side === 'south' ? room.x : room.z) + (opening.offset ?? 0);
  return candidates.find(edge => Math.abs(edge.at - at) < 1e-7 && center - opening.width / 2 >= edge.min && center + opening.width / 2 <= edge.max);
};
const random = (seed: number, id: string, attempt: number) => {
  let hash = (2166136261 ^ seed) >>> 0;
  for (const character of `${id}:${attempt}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d); hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b); hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
};

/** Generate an editable floor, preserving requested room/door IDs and access
 * semantics. Subtree minima constrain each split. Up to16 deterministic samples
 * satisfy authored adjacencies/openings; no requested room or door is omitted.
 * Invalid results have no usable rooms. Compile the completed BuildingRecipe
 * for actor, entrance, furnishing, stairs and physical geometry validation. */
export function partitionBuildingFloor(input: BuildingFloorLayout): BuildingLayoutResult {
  const floor: BuildingFloorRecipe = { id: input?.floorId ?? 'invalid', y: input?.y ?? 0, height: input?.height ?? 3.2, rooms: [], openings: [] };
  const result: BuildingLayoutResult = { floor, connections: [], diagnostics: { valid: false, attempts: 0, issues: [] } };
  const issue = (code: string, message: string, ...ids: string[]) => {
    if (result.diagnostics.issues.length < 32) result.diagnostics.issues.push({ code, message, ids: ids.filter(id => typeof id === 'string') });
  };
  if (input?.materials !== undefined) try { floor.materials = copyMaterials(input.materials); }
  catch { issue('materials', 'Floor materials require valid named surface materials.'); }
  if (input?.doors !== undefined) try { floor.doors = validateBuildingDoorSelection(input.doors); }
  catch (error) { issue('door-selection', error instanceof Error ? error.message : String(error)); }
  const thick = input?.wallThickness ?? .18, slab = input?.floorThickness ?? .16;
  if (!input || !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff || !idOkay(input.floorId)
    || ![input.width, input.depth].every(n => finite(n) && n > 0 && n <= 128)
    || !finite(floor.y) || Math.abs(floor.y) > 1000 || !finite(floor.height) || floor.height <= 0 || floor.height > 20
    || !finite(thick) || thick < .04 || thick > 1 || !finite(slab) || slab < .04 || slab > 1
    || input.connections !== undefined && !Array.isArray(input.connections) || input.openings !== undefined && !Array.isArray(input.openings)
    || input.merges !== undefined && (!Array.isArray(input.merges) || input.merges.length > 16)
    || (input.connections?.length ?? 0) + (input.openings?.length ?? 0) > BUILDING_LAYOUT_LIMITS.openings) {
    issue('input', 'A layout needs bounded dimensions, a uint32 seed, floor identity and at most128 openings.'); return result;
  }
  const requirements = new Map<BuildingLayoutNode, Requirements>(), ids = new Set<string>([input.floorId]), leafIds = new Set<string>();
  const seen = new Set<object>(); let nodes = 0, leaves = 0;
  const inspect = (node: BuildingLayoutNode, depth: number): Requirements | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node) || ++nodes > BUILDING_LAYOUT_LIMITS.nodes || depth > BUILDING_LAYOUT_LIMITS.depth
      || !idOkay(node.id) || ids.has(node.id)) { issue('tree', 'Layout nodes need unique stable IDs and an acyclic bounded tree.', node?.id); return; }
    seen.add(node); ids.add(node.id);
    let value: Requirements;
    if (node.kind === 'room') {
      if (++leaves > BUILDING_LAYOUT_LIMITS.rooms || ![node.minWidth ?? 1.2, node.minDepth ?? 1.2].every(n => finite(n) && n >= .2 && n <= 128)
        || !finite(node.weight ?? 1) || (node.weight ?? 1) <= 0 || (node.weight ?? 1) > 1000
        || !roomMetadataValid(node)) {
        issue('room', 'Room minima, weight, elevation or orientation/access metadata are invalid.', node.id); return;
      }
      leafIds.add(node.id);
      value = { width: node.minWidth ?? 1.2, depth: node.minDepth ?? 1.2, weight: node.weight ?? 1 };
    } else if (node.kind === 'split') {
      const range = node.ratio === undefined ? undefined : Array.isArray(node.ratio) ? node.ratio : [node.ratio, node.ratio];
      if (!['x', 'z'].includes(node.axis) || range && (range.length !== 2 || ![range[0], range[1]].every(n => finite(n) && n > 0 && n < 1) || range[0] > range[1])) {
        issue('split', 'Split axis and ordered ratio range must be finite, strictly between0 and1.', node.id); return;
      }
      const a = inspect(node.first, depth + 1), b = inspect(node.second, depth + 1); if (!a || !b) return;
      value = { width: node.axis === 'x' ? a.width + b.width : Math.max(a.width, b.width),
        depth: node.axis === 'z' ? a.depth + b.depth : Math.max(a.depth, b.depth), weight: a.weight + b.weight };
    } else { issue('tree', 'Layout node kind must be room or split.', (node as BuildingLayoutNode).id); return; }
    requirements.set(node, value); return value;
  };
  inspect(input.layout, 0);
  const mergedSources = new Set<string>();
  for (const merge of input.merges ?? []) {
    if (!merge || !idOkay(merge.id) || ids.has(merge.id) || !Array.isArray(merge.rooms) || merge.rooms.length < 2 || merge.rooms.length > 16
      || Array.from(merge.rooms).some(id => !idOkay(id) || !leafIds.has(id) || mergedSources.has(id)) || new Set(merge.rooms).size !== merge.rooms.length
      || !roomMetadataValid(merge)) {
      issue('merge', 'Merges require a new ID and 2–16 distinct, unused room leaves with valid metadata.', merge?.id); continue;
    }
    ids.add(merge.id); merge.rooms.forEach(id => mergedSources.add(id));
  }
  for (const opening of [...input.connections ?? [], ...input.openings ?? []]) {
    const wallMode = opening?.kind === 'open' || opening?.kind === 'closed';
    if (!opening || !idOkay(opening.id) || ids.has(opening.id)
      || (wallMode ? opening.width !== undefined || opening.height !== undefined || opening.at !== undefined || opening.transition !== undefined
        : !widthValid(opening.width) || !finite(opening.height) || opening.height <= 0 || opening.height >= floor.height
          || !finite(opening.at ?? .5) || (opening.at ?? .5) < 0 || (opening.at ?? .5) > 1))
      issue('opening', 'Openings need unique IDs, usable dimensions and an at fraction from0 to1.', opening?.id);
    else ids.add(opening.id);
    if (opening?.transition !== undefined && (!opening.transition || typeof opening.transition !== 'object' || Array.isArray(opening.transition)
      || !['steps', 'ramp'].includes(opening.transition.kind) || opening.transition.run !== undefined && (!finite(opening.transition.run) || opening.transition.run <= 0 || opening.transition.run > 32)))
      issue('transition', 'Door transitions need steps/ramp kind and an optional positive run up to32 metres.', opening.id);
    if (opening?.door !== undefined) try {
      if (opening.kind === 'window' || opening.kind === 'closed' || opening.kind === 'open' && opening.door !== false)
        throw new Error('Door leaves require a door connection; open-plan passages accept only door:false and closed walls/windows accept no door intent.');
      if (opening.door !== false) validateBuildingDoorSelection(opening.door);
    } catch (error) { issue('door-selection', error instanceof Error ? error.message : String(error), opening.id); }
  }
  const connectionPairs = new Map<string, boolean>();
  for (const connection of input.connections ?? []) {
    if (!connection || !Array.isArray(connection.rooms) || connection.rooms.length !== 2 || !['door', 'open', 'closed'].includes(connection.kind ?? 'door')
      || connection.rooms[0] === connection.rooms[1] || [connection.rooms[0], connection.rooms[1]].some(id => !idOkay(id))) {
      issue('connection', 'Connections must name two different room IDs and door/open/closed kind.', connection?.id); continue;
    }
    const key = [...connection.rooms].sort().join('/');
    // Conflicting declarations must not silently turn an explicit closed wall
    // into a door, or cover an open-plan join with a second connection.
    const wallMode = connection.kind === 'open' || connection.kind === 'closed';
    if (connectionPairs.has(key) && (wallMode || connectionPairs.get(key)))
      issue('connection-conflict', 'Open/closed connections cannot share their room pair with another connection.', connection.id);
    connectionPairs.set(key, wallMode || connectionPairs.get(key) === true);
  }
  for (const opening of input.openings ?? []) if (!opening || !idOkay(opening.room) || !sides.includes(opening.side) || !['door', 'window'].includes(opening.kind)
    || opening.edge !== undefined && (!Number.isInteger(opening.edge) || opening.edge < 0)
    || !finite(opening.width) || !finite(opening.bottom ?? (opening.kind === 'window' ? .9 : 0)) || (opening.bottom ?? (opening.kind === 'window' ? .9 : 0)) < 0
    || (opening.bottom ?? (opening.kind === 'window' ? .9 : 0)) + opening.height >= floor.height
    || opening.kind === 'door' && (opening.bottom ?? 0) !== 0 || opening.transition !== undefined) issue('opening', 'Exterior openings need a room, cardinal side and usable vertical range; transitions belong to interior connections.', opening?.id);
  if (result.diagnostics.issues.length) return result;
  const margin = Math.max(thick / 2, .04) + .001;
  for (let attempt = 0; attempt < BUILDING_LAYOUT_LIMITS.attempts; attempt++) {
    result.diagnostics.attempts = attempt + 1; result.diagnostics.issues = []; floor.rooms = []; floor.openings = []; result.connections = [];
    const divide = (node: BuildingLayoutNode, box: Rect): void => {
      const width = box.maxX - box.minX, depth = box.maxZ - box.minZ, need = requirements.get(node)!;
      if (width < need.width - 1e-7 || depth < need.depth - 1e-7) { issue('minimum-size', 'The partition cannot fit its authored room minima.', node.id); return; }
      if (node.kind === 'room') {
        const room: BuildingRoomRecipe = { id: node.id, x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2, width, depth,
          ...(node.label === undefined ? {} : { label: node.label }), ...(node.purpose === undefined ? {} : { purpose: node.purpose }), ...(node.access ? { access: node.access } : {}) };
        if (node.elevation !== undefined) room.elevation = node.elevation;
        if (node.materials !== undefined) room.materials = copyMaterials(node.materials, true);
        if (node.doorPolicy !== undefined) room.doorPolicy = validateBuildingDoorPolicy(node.doorPolicy);
        if (node.orientation) {
          room.orientation = { ...(node.orientation.front ? { front: node.orientation.front } : {}),
            ...(node.orientation.entry ? { entry: { x: node.orientation.entry.x, z: node.orientation.entry.z } } : {}),
            ...(node.orientation.focalPoint ? { focalPoint: { x: node.orientation.focalPoint.x, z: node.orientation.focalPoint.z } } : {}) };
          for (const point of [room.orientation.entry, room.orientation.focalPoint]) if (point && (point.x < box.minX || point.x > box.maxX || point.z < box.minZ || point.z > box.maxZ))
            issue('orientation-fit', 'An authored orientation point leaves its sampled room.', node.id);
        }
        floor.rooms.push(room); return;
      }
      const a = requirements.get(node.first)!, b = requirements.get(node.second)!, extent = node.axis === 'x' ? width : depth;
      const range = node.ratio === undefined ? [0, 1] : Array.isArray(node.ratio) ? node.ratio : [node.ratio, node.ratio];
      const minimum = Math.max(range[0], (node.axis === 'x' ? a.width : a.depth) / extent), maximum = Math.min(range[1], 1 - (node.axis === 'x' ? b.width : b.depth) / extent);
      if (minimum > maximum + 1e-10) { issue('split-fit', 'No split ratio satisfies the authored range and subtree minima.', node.id); return; }
      const ratio = node.ratio === undefined ? Math.max(minimum, Math.min(maximum, a.weight / (a.weight + b.weight)))
        : minimum + (maximum - minimum) * random(input.seed, node.id, attempt);
      const coordinate = Math.round(((node.axis === 'x' ? box.minX : box.minZ) + extent * ratio) * 1e7) / 1e7;
      divide(node.first, { ...box, ...(node.axis === 'x' ? { maxX: coordinate } : { maxZ: coordinate }) });
      divide(node.second, { ...box, ...(node.axis === 'x' ? { minX: coordinate } : { minZ: coordinate }) });
    };
    divide(input.layout, { minX: -input.width / 2, maxX: input.width / 2, minZ: -input.depth / 2, maxZ: input.depth / 2 });
    for (const merge of input.merges ?? []) {
      const sources = merge.rooms.map(id => floor.rooms.find(room => room.id === id));
      if (sources.some(room => !room)) { issue('merge-room', 'A merge references a missing room leaf.', merge.id); continue; }
      const union = compileBuildingFootprint(sources.flatMap(room => room!.footprint ?? [room!]));
      if (!union.valid) { issue('merge-footprint', union.issues.join(' '), merge.id); continue; }
      const levels = new Set(sources.map(room => room!.elevation ?? 0));
      if (merge.elevation === undefined && levels.size > 1) { issue('merge-elevation', 'Merged leaves need a shared elevation or an explicit merged-room elevation.', merge.id); continue; }
      const sourceIds = merge.rooms;
      const merged: BuildingRoomRecipe = { id: merge.id, ...union.footprint!.bounds, footprint: union.footprint!.rectangles,
        ...(merge.label === undefined ? {} : { label: merge.label }), ...(merge.purpose === undefined ? {} : { purpose: merge.purpose }),
        ...(merge.access === undefined ? {} : { access: merge.access }),
        ...(merge.elevation !== undefined ? { elevation: merge.elevation } : sources[0]!.elevation === undefined ? {} : { elevation: sources[0]!.elevation }) };
      if (merge.materials !== undefined) merged.materials = copyMaterials(merge.materials, true);
      if (merge.doorPolicy !== undefined) merged.doorPolicy = validateBuildingDoorPolicy(merge.doorPolicy);
      if (merge.orientation) {
        merged.orientation = { ...(merge.orientation.front ? { front: merge.orientation.front } : {}),
          ...(merge.orientation.entry ? { entry: { x: merge.orientation.entry.x, z: merge.orientation.entry.z } } : {}),
          ...(merge.orientation.focalPoint ? { focalPoint: { x: merge.orientation.focalPoint.x, z: merge.orientation.focalPoint.z } } : {}) };
        for (const point of [merged.orientation.entry, merged.orientation.focalPoint]) if (point && !footprintContainsPoint(union.footprint!, point))
          issue('orientation-fit', 'An authored orientation point leaves its merged room footprint.', merge.id);
      }
      floor.rooms = floor.rooms.filter(room => !sourceIds.includes(room.id)); floor.rooms.push(merged);
    }
    const rooms = new Map(floor.rooms.map(room => [room.id, room])), resolvedIds = new Set(ids);
    for (const connection of input.connections ?? []) {
      const a = rooms.get(connection.rooms[0]), b = rooms.get(connection.rooms[1]);
      if (!a || !b) { issue('connection-room', 'A connection references a missing room.', connection.id); continue; }
      const aEdges = edges(a), bEdges = edges(b), shared = aEdges.flatMap(edge => bEdges.filter(other => other.side === opposite[edge.side] && Math.abs(other.at - edge.at) < 1e-7)
        .map(other => ({ edge, min: Math.max(edge.min, other.min), max: Math.min(edge.max, other.max) })))
        .filter(span => span.max - span.min > 1e-7).sort((x, y) => (y.max - y.min) - (x.max - x.min));
      if (!shared.length) { issue('connection-adjacency', 'Requested rooms do not share a wall in this layout.', connection.id, a.id, b.id); continue; }
      if (connection.kind === 'open' && Math.abs((a.elevation ?? 0) - (b.elevation ?? 0)) > 1e-7) {
        issue('connection-elevation', 'Open-plan rooms need equal elevations; use a door transition between different levels.', connection.id); continue;
      }
      const wallMode = connection.kind === 'open' || connection.kind === 'closed';
      const spans = wallMode ? shared.sort((a, b) => a.edge.axis.localeCompare(b.edge.axis) || a.edge.at - b.edge.at || a.min - b.min) : shared.slice(0, 1);
      for (const [index, { edge, min, max }] of spans.entries()) {
        const side = edge.side, available = max - min - margin * 2;
        let width = max - min;
        if (!wallMode) {
          const policy = connection.width!;
          if (typeof policy === 'number') width = policy;
          else {
            const t = random(input.seed, `connection:${connection.id}:width`, attempt), range = policy.ratio === undefined ? undefined
              : Array.isArray(policy.ratio) ? policy.ratio : [policy.ratio, policy.ratio];
            const target = range ? available * (range[0] + (range[1] - range[0]) * t) : policy.min + (policy.max - policy.min) * t;
            width = Math.min(available, Math.max(policy.min, Math.min(policy.max, target)));
            if (available < policy.min) { issue('connection-span', 'Shared wall cannot fit the requested minimum door width.', connection.id, a.id, b.id); continue; }
          }
          if (available < width) { issue('connection-span', 'Shared wall is too short for the requested door.', connection.id, a.id, b.id); continue; }
        }
        const center = wallMode ? (min + max) / 2 : min + margin + width / 2 + (available - width) * (connection.at ?? .5);
        const horizontal = side === 'north' || side === 'south', offset = center - (a.footprint ? (edge.min + edge.max) / 2 : horizontal ? a.x : a.z);
        const id = index ? `${connection.id}:span:${index}` : connection.id;
        if (index && (!idOkay(id) || resolvedIds.has(id))) { issue('connection-id', 'Expanded shared spans need unique bounded IDs; shorten the connection ID.', connection.id); continue; }
        resolvedIds.add(id);
        if (connection.kind !== 'closed') floor.openings!.push({ id, room: a.id, kind: connection.kind === 'open' ? 'passage' : 'door', side, offset, width,
          ...(connection.door === undefined ? {} : { door: connection.door === false ? false : validateBuildingDoorSelection(connection.door) }),
          height: connection.kind === 'open' ? floor.height - slab - (a.elevation ?? 0) : connection.height!,
          ...(a.footprint ? { edge: aEdges.filter(e => e.side === side).indexOf(edge) } : {}), ...(connection.transition ? { transition: { kind: connection.transition.kind,
            ...(connection.transition.run === undefined ? {} : { run: connection.transition.run }) } } : {}) });
        result.connections.push({ id, rooms: [...connection.rooms], side, offset, width: connection.kind === 'closed' ? 0 : width,
          ...(wallMode ? { kind: connection.kind, connectionId: connection.id } : {}), span: { min, max },
          position: horizontal ? { x: center, z: edge.at } : { x: edge.at, z: center } });
      }
    }
    for (const opening of input.openings ?? []) {
      const owner = rooms.get(opening.room);
      if (!owner) { issue('opening-room', 'An exterior opening references a missing room.', opening.id); continue; }
      if (owner.footprint || opening.edge !== undefined) {
        const candidates = edges(owner).filter(edge => edge.side === opening.side);
        const exteriorAt = opening.side === 'north' ? -input.depth / 2 : opening.side === 'south' ? input.depth / 2 : opening.side === 'west' ? -input.width / 2 : input.width / 2;
        const edge = opening.edge === undefined ? candidates.find(edge => Math.abs(edge.at - exteriorAt) < 1e-7 && edge.max - edge.min >= opening.width + margin * 2) : candidates[opening.edge];
        if (!edge || Math.abs(edge.at - exteriorAt) > 1e-7 || edge.max - edge.min < opening.width + margin * 2) { issue('opening-boundary', 'Requested exterior opening must fit an outside room wall.', opening.id); continue; }
        const { at: fraction, ...authored } = opening;
        floor.openings!.push({ ...authored, edge: candidates.indexOf(edge), offset: (edge.max - edge.min - margin * 2 - opening.width) * ((fraction ?? .5) - .5) });
        continue;
      }
      const r = rect(owner), horizontal = opening.side === 'north' || opening.side === 'south';
      const atBoundary = opening.side === 'north' ? r.minZ + input.depth / 2 : opening.side === 'south' ? r.maxZ - input.depth / 2
        : opening.side === 'west' ? r.minX + input.width / 2 : r.maxX - input.width / 2;
      const extent = horizontal ? owner.width : owner.depth;
      if (Math.abs(atBoundary) > 1e-7 || extent < opening.width + margin * 2) { issue('opening-boundary', 'Requested exterior opening must fit an outside room wall.', opening.id); continue; }
      floor.openings!.push({ id: opening.id, room: opening.room, side: opening.side, kind: opening.kind, width: opening.width, height: opening.height,
        ...(opening.door === undefined ? {} : { door: opening.door === false ? false : validateBuildingDoorSelection(opening.door) }),
        ...(opening.bottom === undefined ? {} : { bottom: opening.bottom }), offset: (extent - margin * 2 - opening.width) * ((opening.at ?? .5) - .5) });
    }
    if (floor.openings!.length > BUILDING_LAYOUT_LIMITS.openings) issue('opening-budget', 'Expanded shared spans exceed the opening budget.');
    for (const opening of floor.openings!) try {
      const connection = result.connections.find(candidate => candidate.id === opening.id);
      resolveBuildingDoorIntent({ version: 1, id: 'layout', seed: input.seed, width: input.width, depth: input.depth, floors: [floor] }, floor, opening,
        connection?.rooms ?? [opening.room]);
    } catch (error) { issue('door-policy', error instanceof Error ? error.message : String(error), opening.id); }
    // Multiple authored openings must not compete for the same wall rectangle.
    const openings = floor.openings!.map(opening => {
      const owner = rooms.get(opening.room)!, edge = openingEdge(owner, opening), horizontal = opening.side === 'north' || opening.side === 'south';
      const at = edge?.at ?? NaN;
      const center = (opening.edge === undefined ? horizontal ? owner.x : owner.z : edge ? (edge.min + edge.max) / 2 : NaN) + (opening.offset ?? 0), bottom = opening.bottom ?? (opening.kind === 'window' ? .9 : 0);
      return { opening, horizontal, at, min: center - opening.width / 2, max: center + opening.width / 2, bottom, top: bottom + opening.height };
    });
    for (let i = 0; i < openings.length; i++) for (let j = 0; j < i; j++) {
      const a = openings[i], b = openings[j];
      if (a.horizontal === b.horizontal && Math.abs(a.at - b.at) < 1e-7 && Math.min(a.max, b.max) - Math.max(a.min, b.min) > 1e-7 && Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) > 1e-7)
        issue('opening-overlap', 'Authored openings overlap on the same wall.', a.opening.id, b.opening.id);
    }
    if (!result.diagnostics.issues.length) { result.diagnostics.valid = true; return result; }
  }
  floor.rooms = []; floor.openings = []; result.connections = [];
  return result;
}
