# Procedural buildings and city blocks

The shared APIs live in:

- `src/sandbox/building.ts`: building recipes, structural pieces, collision, support queries and diagnostics.
- `src/sandbox/buildingLayout.ts`: reusable weighted room partitions, size ranges and regenerated door connections.
- `src/sandbox/buildingDoors.ts`: weighted door designs, custom leaf models, poses, collision and swing/track reservations.
- `src/sandbox/city.ts`: editable city-block recipes and city compilation.
- `src/sandbox/buildingView.ts`: building rendering, interior selection and floor cutaways.
- `src/sandbox/furnishing.ts` and `src/sandbox/town.ts`: relational furnishing and editable mixed-use layouts.

For custom object generators and reusable furniture variants, see [parametric assets](parametric-assets.md). Resolved families can be attached to `BuildingFurnitureRecipe.model`; the compiler and view use the same selected manifest.

For authored sites, hills, foundations and connecting roads, compose these building recipes with [terrain-aware world planning](world-planning.md).

For optional breakage and collapse, use `compileDestructibleBuilding` or prepare the final placed building with `prepareBuildingDestruction`. The AI supplies support bindings, strength and fracture rules; omitting the configuration preserves ordinary generation. See [procedural destruction](structural-destruction.md#opt-into-destruction-during-procedural-generation) and the [enabled/disabled workshop](http://localhost:5177/tests/visual/procedural-destruction.html).

## Vary room sizes while preserving purpose

Room widths and depths are independent authored values. `partitionBuildingFloor` adds an optional family grammar: a tree of room leaves and X/Z splits. Leaves declare minimum dimensions and optional weights; splits may specify a fixed ratio or a seeded `[min,max]` range. First children occupy west (-X) or north (-Z). Without a ratio, summed leaf weights determine the split. The same topology can yield different room proportions for each seed.

Connections name room pairs, so doors are regenerated from their shared wall instead of retaining stale coordinates. Exterior openings name their room and side. The result is ordinary editable floor data, with stable IDs and bounded attempts. Invalid requested layouts report diagnostics without silently dropping a room or connection. Compile the completed building to check actor clearance and physical geometry, then furnish the resolved rooms.

For example, this bakery varies its kitchen and dining areas while preserving its public front:

```ts
import { partitionBuildingFloor } from '../sandbox/buildingLayout.ts';
import { compileBuilding } from '../sandbox/building.ts';

const layout = partitionBuildingFloor({ seed: 73, width: 12, depth: 16,
  floorId: 'ground', height: 3.4,
  layout: { kind: 'split', id: 'front-back', axis: 'z', ratio: [.3, .45],
    first: { kind: 'room', id: 'kitchen', minDepth: 4, access: 'service', purpose: 'baking and preparation' },
    second: { kind: 'room', id: 'dining', minDepth: 6, access: 'public', purpose: 'sales and eating area', orientation: { front: 'south' } } },
  connections: [{ id: 'kitchen-door', rooms: ['dining', 'kitchen'], width: 1.4, height: 2.4 }],
  openings: [{ id: 'front-door', room: 'dining', side: 'south', kind: 'door', width: 1.8, height: 2.4 },
    { id: 'deliveries', room: 'kitchen', side: 'north', kind: 'door', width: 1.4, height: 2.4 }],
});
if (!layout.diagnostics.valid) throw new Error(JSON.stringify(layout.diagnostics.issues));
const bakery = compileBuilding({ version: 1, id: 'bakery', width: 12, depth: 16,
  primaryEntrance: 'front-door', floors: [layout.floor] });
if (!bakery.diagnostics.valid) throw new Error(JSON.stringify(bakery.diagnostics.issues));
```

`primaryEntrance` names a ground-floor exterior door. Room `access` is `public`, `circulation`, `private` or `service`; purpose text remains descriptive. The compiler rejects a primary entrance into private/service space, and explicitly public rooms that require passing through those spaces. Separately authored delivery/service entrances remain valid. Existing recipes without these optional semantics keep their previous behavior. These graph checks do not model locked doors, NPC permissions or complete navigation.

Room `orientation` and weighted furnishing are described in [directional placement](parametric-assets.md#give-placement-directional-context). Building yaw rotates the complete interior and matching collision. A world's site orientation can point its primary entrance toward a road, plaza or authored point.

## Narrow doors, wide connections and open plans

Layout connections can respond to the actual shared wall after room sizes resolve:

```ts
import type { BuildingLayoutConnection } from '../sandbox/buildingLayout.ts';
// Use exactly one option for this room pair in layout.connections:
const choices: BuildingLayoutConnection[] = [
  { id: 'join', rooms: ['dining', 'kitchen'], width: .9, height: 2.3 },
  { id: 'join', rooms: ['dining', 'kitchen'],
    width: { min: 1.2, max: 3.2, ratio: [.3, .5] }, height: 2.3 },
  { id: 'join', rooms: ['dining', 'kitchen'], kind: 'open' },
  { id: 'join', rooms: ['dining', 'kitchen'], kind: 'closed' },
];
```

The default kind is `door`. A numeric width stays exact. A width policy applies its fixed or seeded ratio to the usable shared span after corner margins, then respects metre `min/max` bounds. Without `ratio`, it samples a width in metres between those bounds. Available space can reduce the maximum but never the minimum; an impossible connection returns diagnostics. Width must also accommodate the building's configured actor. Retain the connection ID and seed for repeatable variants.

`open` means no dividing wall: it removes every shared span to the ceiling while keeping both room IDs and their semantic metadata. The generated core opening kind is `passage`; additional compound spans receive `:span:N` ID suffixes. Open connections take no width, height, position fraction or transition; the rooms must have equal elevations. For different levels, use a door and its checked transition. Match the layout's optional `floorThickness` with the enclosing building so the passage reaches the actual clear ceiling.

`closed` means no connection: the wall stays, no portal is emitted, and the resolved connection metadata records `kind:'closed'` and width0. Another doorway, stair or exterior entrance must make the room reachable. Omitted connections likewise leave their walls; explicit closed declarations help preserve design intent. Conflicting open/closed declarations for the same room pair are rejected. A closed door leaf instead uses a door design with `open:0`.

For manual recipes, a `passage` must fill one complete interior shared span and reach `floor.height - floorThickness - room.elevation`. Declare separate passages for multiple spans. Partial openings with a lintel remain `door` openings.

## Door styles and room rules

Door openings can carry actual door leaves. Existing recipes keep their bare openings until a door design, default or room rule opts in. `BuildingRecipe.doors` and `BuildingFloorRecipe.doors` set defaults; room `doorPolicy` chooses required, optional or no leaves. The rule applies to the room's existing connections; it does not invent new openings or infer requirements from purpose text.

```ts
import type { BuildingDoorSelection } from '../sandbox/buildingDoors.ts';
const bedroomDoors: BuildingDoorSelection = { palette: [
  { id: 'oak-panels', weight: 3, door: { type: 'hinged', style: 'panel', color: '#946d45' } },
  { id: 'painted-flush', door: { type: 'hinged', style: 'flush', color: '#deddd2' } },
] };
// Apply before furnishing, so doors reserve their opening and motion space.
bedroom.doorPolicy = { mode: 'required', selection: bedroomDoors };
kitchen.doorPolicy = { mode: 'none' };
study.doorPolicy = { mode: 'optional', probability: .7, selection: bedroomDoors };
// An explicit connection/opening overrides room rules, including conflicts.
frontOpening.door = { type: 'double-hinged', style: 'panel', open: 1 };
kitchenOpening.door = false;
```

A required room uses its selection, then floor/building defaults, then a plain hinged door. Optional rules use a seeded probability (default `.5`). `none` leaves a bare opening. Conflicting rules on the two sides, such as required versus none, need an explicit connection override. `opening.door` or layout `connection.door` can be a direct design, weighted palette, or `false`. No rule changes `kind:'closed'` into an entrance. A required door cannot fit a full-wall passage; use a door opening or an explicit bare override.

Designs support `hinged`, `double-hinged`, `sliding` and `double-sliding`; built-in looks are `flush`, `panel` and `window`. Window style is a real aperture in the leaf, not transparent glazing. Choose `hinge:'left'|'right'` and `swing:'into-room'|'away-from-room'` relative to the opening's owning room looking out. `open` ranges from `0` to `1` and defaults to fully open. Frame trim stays outside the clear hole. Sliding panels move alongside the wall; furnishings and fixtures reserve their track space as well as hinged swing space.

Palette IDs and the building seed make choices repeatable and independent of palette order. Leaf and frame `material` accept the shared texture system, including weighted finishes and overlays. Custom `model:AssetManifest` leaves can use any authored asset family, retaining part materials and actual compound collision. Models must match each resolved leaf's dimensions; they are not silently stretched. Generate the model after layout dimensions resolve.

`manifest.doors` records resolved type, open fraction, clearance, part IDs and reservations. Meshes and collision use the same pose. Architectural connectivity stays separate from current traversal: an intentionally closed leaf can block a connected room. These are authored static states, not an automatic gameplay controller. Changing a door during play requires replacing the compiled view and physics scene together; mutating a cached collider array is insufficient. Interaction, animation, locks and permissions remain game behavior.

## Ceiling and wall fixtures

`furnishBuildingFixtures` adds deterministic fixture rules to an otherwise valid building. It uses the same extensible asset catalog as furniture, retains existing manually authored fixtures and returns an editable recipe. Choose the arrangement explicitly; room-purpose text does not choose lighting automatically.

```ts
import { furnishBuildingFixtures } from '../sandbox/buildingFixtures.ts';
import { createStandardAssetCatalog } from '../sandbox/assetFamilyPresets.ts';
import { compileBuilding } from '../sandbox/building.ts';

const catalog = createStandardAssetCatalog();
// source is an editable BuildingRecipe with a room named 'dining'.
const withFixtures = furnishBuildingFixtures(source, catalog, {
  seed: 73, rooms: { dining: { rules: [
    { id: 'center-fan', family: 'ceiling-fan-light',
      placement: 'ceiling-center', count: 1, required: 1,
      light: { socket: 'light', target: 'down', intensity: 14, range: 10 } },
  ] } },
});
if (!withFixtures.diagnostics.valid) throw new Error(JSON.stringify(withFixtures.diagnostics.issues));
const building = compileBuilding(withFixtures.recipe);
if (!building.diagnostics.valid) throw new Error(JSON.stringify(building.diagnostics.issues));
```

For four lights instead of the fan, replace the rule with:

```ts
{ id: 'quadrants', family: 'ceiling-light', placement: 'ceiling-quadrants',
  count: 4, required: 4, margin: .5,
  light: { socket: 'light', target: 'down', intensity: 6, range: 8 } }
```

Other placements are `ceiling-grid` with optional `columns`, and `wall-spaced` with `side`, optional boundary `edge`, and `height` measured from the room walking surface to the model base. Rules accept fixed `count`, a seeded integer range, or `density:{perSquareMetre,min,max}` based on actual union area; `count` and `density` are mutually exclusive. `required` defaults to the resolved requested count, including seeded ranges and density. Lower it explicitly to permit optional omissions. Read `requested`, `placed`, `attempted` and `omittedOptional`; failure to fit required fixtures makes diagnostics invalid. Regenerate from the original source and retain intended manual overrides once, rather than repeatedly appending generated results.

Manual `floor.fixtures` entries contain `{id,room,model,mount,light?}`. A ceiling mount is `{surface:'ceiling',position:{x,z},yaw?,gap?}` in building-local coordinates. A wall mount is `{surface:'wall',side,edge?,offset?,height,gap?}`; its back is asset -Z and +Z faces into the room. Actual boundary edges, door/window holes, ceiling surfaces, stair headroom, furniture and other fixtures constrain placement. A center/quadrant candidate outside a concave room is not silently relocated into an invalid spot. Decorative, noncolliding model parts still participate in fixture fit checks.

Custom `defineAssetFamily` generators can supply any compatible housing, fan or fixture. Add a named socket such as `{id:'light',tags:['light'],position:{x:0,y:-.02,z:0}}` outside a downward-facing housing, then refer to it in `light.socket`. The socket name is authored, not inferred from material brightness. `target` may be `'down'`, `'room'` or an explicit building-local `{x,y,z}` point. The compiler rejects an emitter or outgoing direction buried in its own housing. The supplied `ceiling-fan-light`, `ceiling-light` and `wall-light` are editable examples; a fan model does not imply animated blades.

Model parts may set `emissive:'#rrggbb'` and `emissiveIntensity` from0 to10 (default1 when emissive is present). This makes a lens visibly glow; it does not illuminate nearby objects. Actual illumination still comes from the fixture's socket-based light.

`compileBuilding` places model geometry and compound collision at the resolved surface and transforms both socket and target into `manifest.lights` world coordinates. `BuildingWorldView` renders these fixtures and consumes their emitters automatically. They share `maxLights` and `maxShadowLights` with explicit `lightSources`; `fixtureLights:false` disables automatic emitters. Use inspection counts to see omissions, and review ordinary lit views for attachment, direction, shadows and occlusion. Fit checks use conservative model-part bounds; a successful layout is not a photometric lighting guarantee.

## Compound rooms and split levels

`BuildingRecipe.footprint` and `BuildingRoomRecipe.footprint` accept up to16 connected rectangles `{x,z,width,depth}`, all in building-local coordinates. Existing width/depth and room x/z remain the exact bounding envelope. Rectangles within a union may overlap or share an edge. Internal seams disappear; disconnected islands, corner-only joins and enclosed holes are rejected. Different rooms may not overlap, and together must fill each storey footprint.

For a seeded family, `partitionBuildingFloor({...,merges:[{id:'living',rooms:['entry-wing','dining-wing'],access:'public'}]})` merges adjacent leaves before resolving doors. Connections and exterior openings then reference `living`. Split ranges still vary the component sizes. The result retains editable rectangles rather than flattening the room back to its bounding box. Furnishing checks full object bounds against the union, uses real boundary wall segments, and reserves turning circulation through connected space.

`compileBuildingFootprint` exposes normalized tiles, union area, containment helpers and boundary edges. For a doorway on an inset wall, `opening.edge` selects the zero-based edge **among edges matching its side**; `offset` is measured from that edge midpoint. Omit `edge` to retain the old bounding-wall convention. The layout helper resolves these edge selectors automatically.

Set `room.elevation` relative to its storey floor to raise or lower one room. Its ceiling remains at `floor.y + floor.height`; furniture y is relative to the room's walking surface. A door joining different levels creates physical steps and an actor-compatible support ramp; `transition:{kind:'ramp',run:1.4}` requests an exposed ramp. The compiler validates rise, run, slope, approach/landing space, furniture conflicts and headroom. Keep exterior-door rooms at elevation0. Upper-storey drops and interstorey stairs landing in raised rooms are rejected explicitly. Floor cutaways retain the different levels in the selected storey.

Terrain-driven levels and cut/crawl-space family policies are composed through [world planning](world-planning.md). They keep floors horizontal and validate the resulting prepared terrain and access, rather than tilting rooms with the hill.

## Start with an editable block

```ts
import { cityBlockRecipe, compileCity, createCityWorld } from '../sandbox/city.ts';

export const recipe = cityBlockRecipe({ seed: 41, columns: 2, rows: 2 });
// Edit recipe.buildings before compiling, retaining stable identities.
export const city = compileCity(recipe);
if (!city.diagnostics.valid) throw new Error(JSON.stringify(city.diagnostics.issues));
export const terrainWorld = createCityWorld<Record<string, number>>(city);
```

Keep the recipe in a shared layout module imported by logic and view. Compile only when its source or configuration changes. The regular block generator is a starting point: individual building recipes can be authored directly, and custom landmarks remain ordinary geometry with explicitly matching collision.

## Start with a mixed-use town

`townRecipe` supplies editable purpose-specific public buildings, homes and a park:

```ts
import { townRecipe } from '../sandbox/town.ts';
import { compileCity, createCityWorld } from '../sandbox/city.ts';

export const town = townRecipe({seed:73});
if (!town.diagnostics.valid) throw new Error(JSON.stringify(town.diagnostics.issues));
// Edit town.city.buildings before compiling; retain stable IDs.
export const city = compileCity(town.city);
if (!city.diagnostics.valid) throw new Error(JSON.stringify(city.diagnostics.issues));
export const terrainWorld = createCityWorld<Record<string, number>>(city);
```

This uses the same city/building compiler as hand-authored recipes. `townRecipe({seed,catalog})` also accepts a custom catalog; required furnishing that cannot fit throws instead of returning a sparse success. `town.city.props` enter compiled collision. Render their model manifests with `AssetFamilyViewCache` and retain the place/park metadata for facades and paths; the ordinary `tests/fixtures/town-game/` package demonstrates that integration. The supplied purposes and layout are editable examples, not a fixed list of building types. Custom uses, room plans, family catalogs and manual furniture remain supported within the compiler's explicit geometry and placement limits.

## Author one building

Coordinates use metres, Y up and local north along -Z. The building footprint is centred at local `(0,0)`. Room `x/z` values are footprint centres; each floor's `y` is its walking surface. Rooms must partition the actual building footprint without overlapping or leaving gaps. Successive floor surfaces align with the previous floor's `y + height`.

Floor slabs automatically extend to the exterior walls' outer faces. Their outward vertical edges inherit the floor/building wall finish, so interior flooring does not appear as a recessed band around the house. Room floor tops, ceilings, stair openings and internal level changes retain their own finishes. Color-only wall finishes use shared plain materials without allocating textures. The ground slab forms the same flush enclosure down to its underside; keep terrain within that plinth height or use the world planner's cut/crawlspace foundations for greater height differences. Walking elevations remain unchanged. This geometry is compiled into the ordinary disjoint slab boxes, including collision and fracture appearance, without separate cosmetic skirts or support members.

IDs for floors, rooms, openings, furniture and stairs must be unique throughout one building. Use names such as `floor-0-kitchen` and `floor-1-kitchen` when repeating room purposes across floors.

Roofs support `kind:'flat'` or `kind:'gable'`; gable `rise` is bounded to 0.2–8 metres. Roof appearance, physical collision and support use the same geometry. An optional footprint rectangle union clips the roof, slabs and walls to the actual building outline. These bounded orthogonal shapes do not support arbitrary curved/polygonal architecture or enclosed courtyard holes.

Gable roofs close the gap between the upper walls and roof underside automatically. The enclosure follows the actual perimeter, including inset edges of L-shaped footprints, without filling notches or internal seams. Its convex parts supply the same exact geometry to rendering and collision. Omit `roof.enclosure` or use `true` for the default closed shell; use `false` for an intentionally open roof. `enclosure:{color?,material?}` overrides the infill finish, which otherwise inherits the top floor/building wall finish. For example, `roof:{kind:'gable',rise:1.8,enclosure:{color:'#eadfca'}}` needs no manually placed triangular walls.

Generated enclosure parts carry `attachmentParentId`. When destruction bindings omit these parts, `compileBuildingStructure` includes them in their parent wall's rigid member; explicit ownership takes precedence. This preserves the authored mass and support graph. Automatic slab fracture still requires one exact box part per selected member: an inherited enclosure makes that wall a compound member, so bind the enclosure separately with an authored support bond if the wall needs box fracture.

```ts
import { compileBuilding, type BuildingRecipe } from '../sandbox/building.ts';

const bakery: BuildingRecipe = {
  version: 1, id: 'bakery', seed: 41, width: 10, depth: 12,
  floors: [
    {
      id: 'ground', y: 0, height: 3,
      rooms: [{ id: 'shop', x: 0, z: 0, width: 10, depth: 12, purpose: 'bakery' }],
      openings: [{ id: 'entry', room: 'shop', side: 'north', kind: 'door',
        offset: -2, width: 1.6, height: 2.3 }],
      furniture: [{ id: 'counter', room: 'shop', x: -3, z: 2,
        width: 1.2, depth: 0.8, height: 0.9 }],
    },
    {
      id: 'upper', y: 3, height: 3,
      rooms: [{ id: 'apartment', x: 0, z: 0, width: 10, depth: 12, purpose: 'home' }],
    },
  ],
  stairs: [{ id: 'stair', fromFloor: 'ground', toFloor: 'upper',
    x: 2, z: 0, width: 1.4, run: 6, direction: 'south' }],
};
const building = compileBuilding(bakery);
if (!building.diagnostics.valid) throw new Error(JSON.stringify(building.diagnostics.issues));
```

`origin` and `yaw` place the whole building. Openings refer to a room's cardinal wall and use an offset from its centre along that wall. Declare an opening on a shared wall once. Doors have no sill and must fit the configured `actor`; windows may have a `bottom` offset. Stairs require clear landings inside one room on each floor. Their visible treads and risers are the native solid geometry and expose matching horizontal support surfaces; they cut the upper floor slab. Riser height is at most 18cm and half the declared actor radius, with at least 4cm tread run. Explicit `transition.kind:'ramp'` retains a continuous visible and physical slope.

Furniture retains a named footprint, local yaw and collision setting. Attach a resolved `model` to use its compound geometry and collision automatically; its width/depth/height must match `model.size`. Without a model, `asset` selects simple table, chair, shelf, bed, counter, sofa or planter presentation over a box collider. `partFactory` can provide custom meshes, but a view override does not replace compiled collision. Keep custom dimensions consistent or author the physical geometry separately.

Invalid building drafts return diagnostics with no usable structural geometry. Check `diagnostics.valid` and address issues before integrating. `BUILDING_LIMITS` exposes the current finite compiler limits, including 8 floors, 32 rooms per floor, 4096 parts and 2048 colliders per building. City and physics limits can be tighter than those per-building ceilings.

## Integrate the world

Use the compiled structural geometry for rendering and authoritative collision. Expose the same `createCityWorld<Tuning>(city)` host as `GameLogic.terrainWorld` and `GameView.terrainWorld`; install its prepared `snapshot.scene` through the base's physics scene provider. The existing terrain preparation worker handles collision neighborhoods for players and prediction. Render exterior ground with `TerrainWorldView` and compiled structures with `BuildingWorldView`. Adding a view-only feature does not make a building physical. A single solid footprint collider blocks every interior even when the visible model has doorways.

`cityTerrainRecipe(city)` supplies a versioned terrain recipe with lot, street and entrance-access reservations for integration with other biomes. Preserve these reservations when adding scatter. `city.access` records the compiled building entrance-to-street paths; compilation checks the declared street connectivity and access geometry. These checks still require real traversal verification with the intended controller. `cityPhysicsScene(city)` is the bounded eager preview/native-physics test option; production games should use `createCityWorld` and its preparation lifecycle.

Reserve lots, foundations and entrance approaches in adjacent terrain. Do not let scatter occupy routes into a building. `sampleBuilding(manifest, point, maxDrop)` selects the nearest surface below the query elevation, including floors and stairs; `buildingClearance(manifest, point, radius, height)` checks a candidate body against compiled collision. Supply the actor's real elevation and an appropriate drop bound so an upper floor does not become the ground for an actor beneath it. Terrain heightfield samples only describe the outdoor ground. Movement, prediction, camera and animation should agree on the installed world geometry.

`sampleCity(city, point, maxDrop)` searches building surfaces across the block. It returns `undefined` outside building support; fall back to the terrain host's ground sample there. This query does not automatically rewrite a base's movement or animation controller.

Interior rendering and physical coverage are separate decisions. Culling an interior must not silently remove collision for a nearby player.

## Render and review interiors

```ts
import { BuildingWorldView } from '../sandbox/buildingView.ts';

const buildings = new BuildingWorldView(city.buildings, {
  maxActiveBuildings: 12, maxLights: 16, maxShadowLights: 4,
});
scene.add(buildings.root);
// In the existing frame update, use the camera/player's world-space position:
buildings.update(focus);
// During layout review, floorY is in the compiled manifest's coordinates:
buildings.setCutaway({ buildingId: city.buildings[0].id, floorY: 0 });
// Restore the ordinary view with buildings.setCutaway(null).
// During teardown, remove the root and call buildings.dispose().
```

Exterior shells stay present. Distance activation creates and releases interiors with hysteresis; connected rooms are conservatively retained through door, window and stair portals. From outside, exterior portals seed the room selection. This prevents nearby open doorways from revealing arbitrarily missing rooms, but it is not GPU occlusion or a complete visibility solver.

Compiled fixture emitters and optional `lightSources` use building and room IDs. One `BuildingWorldView` pools its active lights under shared `maxLights` and `maxShadowLights` limits. Independent views and other `LightingRig` instances still need scene-level coordination. `inspection()` reports bounded activity and omissions. `partFactory(part, building)` may return `{object, dispose}` to replace the default part geometry; its object is centred in the part's local space and its disposal owns custom GPU resources. The built-in view renders convex enclosure geometry with metre-scale UVs and hides whole convex parts crossing a cutaway instead of stretching them.

## Variation and local editing

Preserve building and room IDs when making local changes. Seeds make procedural choices repeatable. Meaningful variety comes from floor count, room purpose and arrangement, entrances, dimensions and furnishings alongside materials and colors. Keep those choices as editable source data so an AI can refine one shop or room without replacing the rest of the district.

Call `compileCity(editedRecipe, previousCity)` to get `changes.added/removed/updated/unchanged` by building identity. Use `cityInspection(city)` for compact counts, issues, revisions and changes; full geometry should remain outside diagnostic responses.

## Inspect and test

Read compiler diagnostics before integrating the result. Use floor cutaways for the layout and ordinary views for exterior appearance, real doorway openings and visual collision alignment. Replay the same seed, player dimensions and controller through street-to-door approaches, room transitions, furniture routes, stair ascent/descent and upper-floor movement. Compare a local edit against a previous manifest to verify unrelated building identities and geometry remain stable.

A room connectivity graph and clearance checks are bounded observations. They do not prove universal navigation for every actor or custom movement controller. A still image cannot prove traversal.

The complete authored example is `tests/fixtures/city-game/`: shared recipe/world, declared player/input shapes, ordinary movement and prediction, and a view built from the public helpers. It has six distinct buildings and fifty rooms. `tests/core/cityAuthoring.test.ts` builds its real logic/view packages and runs the inspection simulation from normal spawn, through a doorway, upstairs, downstairs and outside again using legal inputs. It verifies layer support, geometry revisions and deterministic replay without test-only staging. `tests/core/city.test.ts` checks local regeneration and declared city access; `cityPhysics.test.ts` exercises native physical traversal. `building.test.ts` and `buildingView.test.ts` cover the compiler, support queries, interior lifecycle, cutaways and view budgets.

## Current scope

The compiler supports bounded blocks with connected rectangle-union rooms and buildings, flat or clipped gable roofs, and bounded room elevations. Gables use one ridge across the building; independent wing ridges, arbitrary polygon architecture and courtyard holes require specialized geometry. The starter uses a regular street-and-lot layout. NPC navigation, shop/resident gameplay, GPU/wall occlusion, cross-view light management and infinite interior streaming remain separate systems. Measure geometry, collision and rendering limits before expanding the district.
