/** One editable mixed-use town grammar. Building plans and furnishing rules are
 * ordinary source data; these examples are not a fixed menu of architecture. */
import { createStandardAssetCatalog } from './assetFamilyPresets.ts';
import type { AssetCatalog } from './assetFamilies.ts';
import type { BuildingFloorRecipe, BuildingOpeningRecipe, BuildingRecipe, BuildingRoomRecipe } from './building.ts';
import type { CityRecipe, CityProp } from './city.ts';
import { furnishBuilding, type FurnishBuildingOptions, type FurnishingRule } from './furnishing.ts';
import type { PhysicsVector } from './physics.ts';

export type TownPlaceKind = 'fire-station' | 'police-station' | 'office' | 'convenience-store' | 'restaurant' | 'cottage' | 'townhouse' | 'bungalow' | 'park';
export interface TownPlace {
  id: string; label: string; kind: TownPlaceKind; buildingId?: string; position: PhysicsVector; width: number; depth: number;
  roof: 'flat' | 'gable'; accent: string; entranceId?: string;
  facade?: { kind: 'station' | 'civic' | 'shopfront' | 'home'; sign: string; canopy?: boolean };
  porch?: { width: number; depth: number };
}
export interface TownPark { id: string; position: PhysicsVector; width: number; depth: number; paths: { from: PhysicsVector; to: PhysicsVector; width: number }[]; propIds: string[] }
export interface TownRecipeResult {
  city: CityRecipe; places: TownPlace[]; parks: TownPark[]; spawn: PhysicsVector;
  diagnostics: { valid: boolean; issues: string[]; furniture: number; families: string[]; attempts: number };
}
export interface TownOptions { seed?: number; id?: string; catalog?: AssetCatalog }
type Plan = { recipe: BuildingRecipe; furnishing: FurnishBuildingOptions['rooms']; entranceId: string };
const room = (id: string, x: number, z: number, width: number, depth: number, purpose: string): BuildingRoomRecipe => ({ id, x, z, width, depth, purpose });
const door = (id: string, owner: string, side: BuildingOpeningRecipe['side'], offset = 0, width = 1.3, height = 2.3): BuildingOpeningRecipe => ({ id, room: owner, side, offset, width, height, kind: 'door' });
const windows = (floor: BuildingFloorRecipe, width: number, depth: number) => {
  for (const r of floor.rooms) {
    const sides: BuildingOpeningRecipe['side'][] = [];
    if (Math.abs(r.x - r.width / 2 + width / 2) < 1e-6) sides.push('west');
    if (Math.abs(r.x + r.width / 2 - width / 2) < 1e-6) sides.push('east');
    if (Math.abs(r.z - r.depth / 2 + depth / 2) < 1e-6) sides.push('north');
    for (const side of sides) floor.openings!.push({ id: `${r.id}-${side}-window`, room: r.id, side, kind: 'window', width: 1.6, height: 1.2, bottom: 1 });
  }
};
const rule = (id: string, family: string, count: number, placement: FurnishingRule['placement'], rest: Partial<FurnishingRule> = {}): FurnishingRule => ({ id, family, count, placement, ...rest });
const seating = (count: number) => ({ family: 'chair', count, parameters: { material: 'walnut' } });
function seedFor(seed: number, id: string): number { let h = seed >>> 0; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return h >>> 0; }
function base(id: string, seed: number, width: number, depth: number, wall: string, roof = '#59636b'): BuildingRecipe {
  return { version: 1, id, seed, width, depth, actor: { radius: .28, height: 1.7, maxSlopeDegrees: 35 }, wallThickness: .2, floorThickness: .18,
    colors: { wall, floor: '#af9a7a', roof, stair: '#8d806c' }, floors: [], roof: { kind: 'flat', color: roof } };
}
function fireStation(seed: number): Plan {
  const recipe = base('fire-station', seed, 24, 24, '#b96d53', '#525862');
  recipe.floors = [{ id: 'g', y: 0, height: 4.2, rooms: [room('bays', -4.5, 0, 15, 24, 'two apparatus bays'), room('dispatch', 7.5, 8, 9, 8, 'public entrance and dispatch'), room('crew', 7.5, -4, 9, 16, 'crew kitchen and equipment')],
    openings: [door('bay-west', 'bays', 'south', -3.5, 4.4, 3.5), door('bay-east', 'bays', 'south', 3.5, 4.4, 3.5), door('personnel', 'dispatch', 'south', 0, 1.5),
      door('crew-access', 'dispatch', 'north'), door('bay-crew', 'bays', 'east', -5)], furniture: [] }];
  windows(recipe.floors[0], 24, 24);
  return { recipe, entranceId: 'personnel', furnishing: {
    bays: { circulation: 'doors-only', rules: [rule('engines', 'vehicle', 2, 'grid', { parameters: { kind: 'fire-engine', width: 2.6, depth: 6.6, height: 2.8 }, columns: 2, zone: { x: -4.5, z: -2, width: 14, depth: 12 } })] },
    dispatch: { rules: [rule('desk', 'desk', 1, 'wall', { wall: 'east' }), rule('visitor-chairs', 'chair', 2, 'wall', { wall: 'west' })] },
    crew: { rules: [rule('meal-table', 'table', 1, 'grid', { seating: seating(4), zone: { x: 7.5, z: -7, width: 8, depth: 8 } }), rule('gear', 'locker', 3, 'wall', { wall: 'east' }), rule('kitchen', 'appliance', 1, 'wall', { wall: 'north' })] },
  } };
}
function policeStation(seed: number): Plan {
  const recipe = base('police-station', seed, 22, 24, '#c1cbd3', '#4d657c');
  recipe.floors = [{ id: 'g', y: 0, height: 3.6, rooms: [room('corridor', 0, 0, 4, 24, 'public and secure corridor'), room('reception', -6.5, 8.5, 9, 7, 'reception'),
    room('detectives', -6.5, -3.5, 9, 17, 'detective office'), room('interview', 6.5, 8.5, 9, 7, 'interview and reporting'), room('holding', 6.5, 1, 9, 8, 'holding and interview'), room('equipment', 6.5, -7.5, 9, 9, 'equipment and records')],
    openings: [door('public', 'corridor', 'south', 0, 1.7), door('reception-door', 'reception', 'east'), door('detectives-door', 'detectives', 'east'),
      door('interview-door', 'interview', 'west'), door('holding-door', 'holding', 'west'), door('equipment-door', 'equipment', 'west')], furniture: [] }];
  windows(recipe.floors[0], 22, 24);
  return { recipe, entranceId: 'public', furnishing: {
    reception: { rules: [rule('service', 'counter', 1, 'wall', { wall: 'west' }), rule('waiting', 'chair', 3, 'wall', { wall: 'south' })] },
    detectives: { rules: [rule('workstations', 'desk', 4, 'grid', { columns: 2 }), rule('records', 'shelf', 2, 'wall', { wall: 'north' })] },
    interview: { rules: [rule('interview-table', 'table', 1, 'grid', { seating: seating(2), zone: { x: 7.5, z: 8.5, width: 6, depth: 6 } })] },
    holding: { rules: [rule('bench', 'bench', 2, 'wall', { wall: 'east' })] },
    equipment: { rules: [rule('lockers', 'locker', 4, 'wall', { wall: 'east' }), rule('records', 'shelf', 2, 'wall', { wall: 'north' })] },
  } };
}
function offices(seed: number): Plan {
  const recipe = base('offices', seed, 24, 24, '#d3d8cc', '#536273');
  recipe.floors = [{ id: 'g', y: 0, height: 3.4, rooms: [room('lobby', 0, 9, 24, 6, 'double-width reception lobby'), room('g-core', 0, -3, 4.4, 18, 'stair core'), room('g-open', -7.1, -3, 9.8, 18, 'open office'), room('g-meeting', 7.1, -3, 9.8, 18, 'meeting suite')],
    openings: [door('main', 'lobby', 'south', 0, 2.4), door('core-door', 'lobby', 'north', 0, 2.2), door('open-door', 'g-open', 'east', 6), door('meeting-door', 'g-meeting', 'west', 6)], furniture: [] },
  { id: 'u', y: 3.4, height: 3.4, rooms: [room('u-core', 0, 0, 4.4, 24, 'upper landing'), room('u-open', -7.1, 0, 9.8, 24, 'upstairs open office'), room('executive', 7.1, 7, 9.8, 10, 'executive suite'), room('archive', 7.1, -5, 9.8, 14, 'archive and project room')],
    openings: [door('u-open-door', 'u-open', 'east', 8.5), door('executive-door', 'executive', 'west'), door('archive-door', 'archive', 'west', -3)], furniture: [] }];
  recipe.stairs = [{ id: 'main-stair', fromFloor: 'g', toFloor: 'u', x: .8, z: -3, width: 1.5, run: 6.4, direction: 'north' }];
  recipe.floors.forEach(f => windows(f, 24, 24));
  return { recipe, entranceId: 'main', furnishing: {
    lobby: { rules: [rule('reception', 'counter', 1, 'wall', { wall: 'east' }), rule('lobby-sofa', 'sofa', 1, 'wall', { wall: 'west' })] },
    'g-open': { rules: [rule('workstations', 'desk', 4, 'grid', { columns: 2 }), rule('filing', 'shelf', 2, 'wall', { wall: 'north' })] },
    'g-meeting': { rules: [rule('meeting-tables', 'table', 2, 'grid', { columns: 1, seating: seating(4) })] },
    'u-open': { rules: [rule('workstations', 'desk', 5, 'grid', { columns: 2 }), rule('filing', 'shelf', 2, 'wall', { wall: 'north' })] },
    executive: { rules: [rule('executive-desk', 'desk', 1, 'wall', { wall: 'east' }), rule('guest-table', 'table', 1, 'grid', { seating: seating(2), zone: { x: 7.1, z: 8, width: 8, depth: 7 } })] },
    archive: { rules: [rule('archive-shelves', 'shelf', 4, 'wall', { wall: 'east' })] },
  } };
}
function shop(seed: number): Plan {
  const recipe = base('corner-market', seed, 24, 20, '#d8ca92', '#637d6b');
  recipe.floors = [{ id: 'g', y: 0, height: 3.4, rooms: [room('sales', 0, 3, 24, 14, 'sales aisles and checkout'), room('stock', -4, -7, 16, 6, 'stock room'), room('staff', 8, -7, 8, 6, 'staff room')],
    openings: [door('shop-entry', 'sales', 'south', 0, 2.8), door('stock-door', 'sales', 'north', -4), door('staff-door', 'stock', 'east')], furniture: [] }];
  windows(recipe.floors[0], 24, 20);
  return { recipe, entranceId: 'shop-entry', furnishing: {
    sales: { rules: [rule('west-aisles', 'shelf', 3, 'grid', { columns: 1, zone: { x: -6, z: 2, width: 7, depth: 10 } }),
      rule('east-aisles', 'shelf', 3, 'grid', { columns: 1, zone: { x: 6, z: 2, width: 7, depth: 10 } }), rule('checkout', 'counter', 1, 'wall', { wall: 'south', zone: { x: -8, z: 8, width: 6, depth: 3.5 } })] },
    stock: { rules: [rule('stock-shelves', 'shelf', 3, 'wall', { wall: 'north' })] },
    staff: { rules: [rule('break-table', 'table', 1, 'grid', { seating: seating(2), zone: { x: 8.5, z: -7.5, width: 6, depth: 4 } })] },
  } };
}
function restaurant(seed: number): Plan {
  const recipe = base('restaurant', seed, 24, 22, '#ca967c', '#685a4b');
  recipe.floors = [{ id: 'g', y: 0, height: 3.6, rooms: [room('dining', 0, 3.5, 24, 15, 'dining room'), room('kitchen', -4, -7.5, 16, 7, 'commercial kitchen'), room('service', 8, -7.5, 8, 7, 'service and storage')],
    openings: [door('restaurant-entry', 'dining', 'south', 0, 2.1), door('kitchen-door', 'dining', 'north', -4, 1.5), door('service-door', 'kitchen', 'east')], furniture: [] }];
  windows(recipe.floors[0], 24, 22);
  return { recipe, entranceId: 'restaurant-entry', furnishing: {
    dining: { rules: [rule('dining-tables', 'table', 6, 'grid', { columns: 3, seating: seating(4), zone: { x: 0, z: 3.5, width: 22, depth: 13 } })] },
    kitchen: { rules: [rule('appliances', 'appliance', 3, 'wall', { wall: 'north' }), rule('prep-counters', 'counter', 2, 'wall', { wall: 'west' })] },
    service: { rules: [rule('service-storage', 'shelf', 3, 'wall', { wall: 'east' })] },
  } };
}
function cottage(seed: number): Plan {
  const recipe = base('cottage', seed, 14, 16, '#d9c6a8', '#776558'); recipe.roof = { kind: 'gable', rise: 1.8, color: '#776558' };
  recipe.floors = [{ id: 'g', y: 0, height: 3.1, rooms: [room('living', 0, 4, 14, 8, 'cottage sitting room'), room('bedroom', -3, -4, 8, 8, 'bedroom'), room('kitchen', 4, -4, 6, 8, 'cottage kitchen')],
    openings: [door('front', 'living', 'south', 0, 1.4), door('bedroom-door', 'living', 'north', -3), door('kitchen-door', 'living', 'north', 4)], furniture: [] }];
  windows(recipe.floors[0], 14, 16);
  return { recipe, entranceId: 'front', furnishing: {
    living: { rules: [rule('sofa', 'sofa', 1, 'wall', { wall: 'west' }), rule('tea-table', 'table', 1, 'grid', { seating: seating(2), zone: { x: 4, z: 5, width: 5, depth: 5 } })] },
    bedroom: { rules: [rule('bed', 'bed', 1, 'wall', { wall: 'north' }), rule('wardrobe', 'locker', 1, 'wall', { wall: 'east' })] },
    kitchen: { rules: [rule('counter', 'counter', 1, 'wall', { wall: 'north' }), rule('appliance', 'appliance', 1, 'wall', { wall: 'east' })] },
  } };
}
function townhouse(seed: number): Plan {
  const recipe = base('townhouse', seed, 12, 20, '#bbc6cc', '#5b6b7b'); recipe.roof = { kind: 'gable', rise: 2.2, color: '#5b6b7b' };
  recipe.floors = [{ id: 'g', y: 0, height: 3.2, rooms: [room('g-hall', -4.1, 0, 3.8, 20, 'stair hall'), room('living', 1.9, 5, 8.2, 10, 'townhouse living room'), room('kitchen', 1.9, -5, 8.2, 10, 'family kitchen')],
    openings: [door('front', 'g-hall', 'south', 0, 1.4), door('living-door', 'living', 'west', 1), door('kitchen-door', 'kitchen', 'west', -2.5)], furniture: [] },
  { id: 'u', y: 3.2, height: 3.2, rooms: [room('u-hall', -4.1, 0, 3.8, 20, 'upper stair hall'), room('bedroom', 1.9, 4, 8.2, 12, 'upstairs bedroom'), room('bath-study', 1.9, -6, 8.2, 8, 'study and utility room')],
    openings: [door('bedroom-door', 'bedroom', 'west', 3), door('study-door', 'bath-study', 'west', -1.5)], furniture: [] }];
  recipe.stairs = [{ id: 'stairs', fromFloor: 'g', toFloor: 'u', x: -4.1, z: -1, width: 1.4, run: 6.2, direction: 'north' }];
  recipe.floors.forEach(f => windows(f, 12, 20));
  return { recipe, entranceId: 'front', furnishing: {
    living: { rules: [rule('sofa', 'sofa', 1, 'wall', { wall: 'east' }), rule('reading-table', 'table', 1, 'grid', { seating: seating(2), zone: { x: 1.9, z: 7, width: 6.5, depth: 5 } })] },
    kitchen: { rules: [rule('dining-table', 'table', 1, 'grid', { seating: seating(4), zone: { x: 1.9, z: -2.8, width: 7, depth: 4.5 } }), rule('counters', 'counter', 2, 'wall', { wall: 'north' })] },
    bedroom: { rules: [rule('bed', 'bed', 1, 'wall', { wall: 'north' }), rule('wardrobes', 'locker', 2, 'wall', { wall: 'east' })] },
    'bath-study': { rules: [rule('desk', 'desk', 1, 'wall', { wall: 'east' }), rule('linen', 'shelf', 1, 'wall', { wall: 'north' })] },
  } };
}
function bungalow(seed: number): Plan {
  const recipe = base('bungalow', seed, 24, 14, '#c6caaa', '#746d59'); recipe.roof = { kind: 'gable', rise: 1.6, color: '#746d59' };
  recipe.floors = [{ id: 'g', y: 0, height: 3.1, rooms: [room('great-room', -5, 0, 14, 14, 'open-plan great room'), room('bedroom', 7, 3.5, 10, 7, 'garden bedroom'), room('kitchen', 7, -3.5, 10, 7, 'garden kitchen')],
    openings: [door('front', 'great-room', 'south', 0, 1.7), door('bedroom-door', 'bedroom', 'west'), door('kitchen-door', 'kitchen', 'west')], furniture: [] }];
  windows(recipe.floors[0], 24, 14);
  return { recipe, entranceId: 'front', furnishing: {
    'great-room': { rules: [rule('sofa', 'sofa', 1, 'wall', { wall: 'north' }), rule('dining', 'table', 1, 'grid', { seating: seating(4), zone: { x: -9, z: 1, width: 5, depth: 8 } })] },
    bedroom: { rules: [rule('bed', 'bed', 1, 'wall', { wall: 'east' }), rule('wardrobe', 'locker', 1, 'wall', { wall: 'south' })] },
    kitchen: { rules: [rule('counters', 'counter', 2, 'wall', { wall: 'north' }), rule('appliance', 'appliance', 1, 'wall', { wall: 'east' })] },
  } };
}

/** Returns recipes, wayfinding/appearance metadata and explicit furnishing
 * diagnostics. An impossible required preset is an error, never a sparse success. */
export function townRecipe(options: TownOptions = {}): TownRecipeResult {
  const seed = options.seed ?? 41;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Town seed must be an unsigned32-bit integer.');
  const catalog = options.catalog ?? createStandardAssetCatalog(), plans: { kind: TownPlaceKind; label: string; x: number; z: number; create: (seed: number) => Plan; accent: string }[] = [
    { kind: 'fire-station', label: 'Engine House 7', x: -40, z: -40, create: fireStation, accent: '#b84534' },
    { kind: 'police-station', label: 'Northside Police', x: 0, z: -40, create: policeStation, accent: '#3c5b82' },
    { kind: 'office', label: 'Maple Works Offices', x: 40, z: -40, create: offices, accent: '#4f6d74' },
    { kind: 'convenience-store', label: 'Corner Market', x: -40, z: 0, create: shop, accent: '#65805b' },
    { kind: 'restaurant', label: 'The Copper Table', x: 0, z: 0, create: restaurant, accent: '#a9613f' },
    { kind: 'cottage', label: 'Willow Cottage', x: -40, z: 40, create: cottage, accent: '#8a765a' },
    { kind: 'townhouse', label: 'Bluebird House', x: 0, z: 40, create: townhouse, accent: '#627d8f' },
    { kind: 'bungalow', label: 'Garden Bungalow', x: 40, z: 40, create: bungalow, accent: '#77835f' },
  ];
  const buildings: BuildingRecipe[] = [], places: TownPlace[] = [], families = new Set<string>(); let furniture = 0, attempts = 0;
  for (const entry of plans) {
    const plan = entry.create(seedFor(seed, entry.kind)); plan.recipe.origin = { x: entry.x, y: 0, z: entry.z };
    const furnished = furnishBuilding(plan.recipe, catalog, { rooms: plan.furnishing });
    if (!furnished.diagnostics.valid) throw new Error(`Town furnishing ${entry.kind}: ${furnished.diagnostics.issues.map(i => `${i.roomId}/${i.ruleId ?? ''}: ${i.message}`).join(' ')}`);
    buildings.push(furnished.recipe); attempts += furnished.diagnostics.attempted;
    for (const floor of furnished.recipe.floors) for (const item of floor.furniture ?? []) { furniture++; if (item.model) families.add(item.model.familyId); }
    const home = ['cottage', 'townhouse', 'bungalow'].includes(entry.kind);
    places.push({ id: entry.kind, label: entry.label, kind: entry.kind, buildingId: furnished.recipe.id, position: { x: entry.x, y: 0, z: entry.z }, width: furnished.recipe.width, depth: furnished.recipe.depth,
      roof: home ? 'gable' : 'flat', accent: entry.accent, entranceId: plan.entranceId,
      facade: { kind: home ? 'home' : entry.kind === 'fire-station' ? 'station' : ['restaurant', 'convenience-store'].includes(entry.kind) ? 'shopfront' : 'civic', sign: entry.label, canopy: ['restaurant', 'convenience-store'].includes(entry.kind) },
      ...(home ? { porch: { width: entry.kind === 'bungalow' ? 6 : 3, depth: 1.5 } } : {}) });
  }
  const props: CityProp[] = [], parkPosition = { x: 40, y: 0, z: 0 };
  const prop = (id: string, family: string, x: number, z: number, yaw = 0, parameters?: Record<string, string | number>) => {
    const model = catalog.resolve(family, { seed, instanceId: `park:${id}`, parameters }); families.add(family);
    props.push({ id: `park-${id}`, position: { x: parkPosition.x + x, y: 0, z: z }, yaw, model });
  };
  prop('fountain', 'fountain', 0, 0);
  for (const [i, [x, z]] of [[-11, -11], [-11, 11], [11, 11], [11, -11]].entries()) prop(`tree-${i}`, 'tree', x, z);
  for (const [i, [x, z, yaw]] of [[-5, 3, Math.PI / 2], [5, 3, -Math.PI / 2], [-3, -5, 0], [3, -5, 0]].entries()) prop(`bench-${i}`, 'bench', x, z, yaw);
  prop('playground', 'playset', 8, -6); prop('planter-west', 'planter', -7, -6); prop('planter-south', 'planter', 5, 8);
  const paths: TownPark['paths'] = [
    { from: { x: 40, y: .01, z: -16 }, to: { x: 40, y: .01, z: -2.6 }, width: 2 },
    { from: { x: 40, y: .01, z: 2.6 }, to: { x: 40, y: .01, z: 16 }, width: 2 },
    { from: { x: 24, y: .01, z: 0 }, to: { x: 37.4, y: .01, z: 0 }, width: 2 },
    { from: { x: 42.6, y: .01, z: 0 }, to: { x: 56, y: .01, z: 0 }, width: 2 },
  ];
  const parks = [{ id: 'maple-park', position: parkPosition, width: 32, depth: 32, paths, propIds: props.map(p => p.id) }];
  places.push({ id: 'park', label: 'Maple Park', kind: 'park', position: parkPosition, width: 32, depth: 32, roof: 'flat', accent: '#6b925f' });
  const streets: CityRecipe['streets'] = [];
  for (let index = 0; index < 4; index++) {
    streets.push({ id: `avenue-${index}`, x: -60 + index * 40, z: 0, width: 8, depth: 128, sidewalk: 1.2 });
    streets.push({ id: `street-${index}`, x: 0, z: -60 + index * 40, width: 128, depth: 8, sidewalk: 1.2 });
  }
  return { city: { version: 1, id: options.id ?? 'maple-town', seed, streets, buildings, props, groundY: 0 }, places, parks,
    spawn: { x: -32.5, y: 0, z: -25.5 }, diagnostics: { valid: true, issues: [], furniture, families: [...families].sort(), attempts } };
}
