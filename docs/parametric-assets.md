# Parametric assets and relational furnishing

The asset tools let AI authors define reusable generators for their own objects, then select reproducible variants with matching geometry and compound collision. The supplied furniture families are examples; they do not restrict the kinds of objects, purposes or styles an author can create.

- `src/sandbox/assetFamilies.ts`: family definitions, parameter validation, seeded resolution and bounded caching.
- `src/sandbox/variation.ts`: general keyed values, correlated choices and bounded recursive data generation.
- `src/sandbox/assetFamilyPresets.ts`: extensible example families.
- `src/sandbox/assetFamilyView.ts`: view-only rendering of resolved manifests.
- `src/sandbox/assetDressing.ts`: weighted arrangements on real support surfaces, including optional and empty states.
- `src/sandbox/furnishing.ts`: room-aware placement, relations and diagnostics.
- `src/sandbox/town.ts`: editable mixed-use layouts using the ordinary [building/city pipeline](procedural-buildings.md).

Families can optionally include destruction through `resolveDestructibleAsset`, or `prepareAssetDestruction` after resolving and placing an instance. A configuration factory receives the selected model, so supports and fracture rules can follow its generated dimensions and parts. See [procedural destruction](structural-destruction.md#opt-into-destruction-during-procedural-generation) for rendering, collision and shared simulation setup; destruction remains disabled when no configuration is supplied.

## Define an object for an authored purpose

Keep the definition and resolved manifest in a shared owned module imported by logic and view. This example makes a survey marker without using a built-in furniture name:

```ts
import { defineAssetFamily, createAssetCatalog } from '../sandbox/assetFamilies.ts';

export const markerFamily = defineAssetFamily({
  id: 'survey-marker', version: '1',
  parameters: {
    width: {kind:'number', min:0.4, max:1.2, step:0.2},
    height: {kind:'number', min:0.8, max:1.6, step:0.2},
    finish: {kind:'choice', values:[{value:'amber'}, {value:'teal',weight:2}]},
  },
  generate(p) {
    if (p.height < p.width) throw new Error('Marker must be at least as tall as it is wide');
    return {
      parts: [{id:'body', shape:'box', position:{x:0,y:p.height/2,z:0},
        size:{x:p.width,y:p.height,z:p.width},
        color:p.finish === 'amber' ? '#ad792e' : '#2e787b'}],
      sockets: [{id:'top', tags:['mount'], position:{x:0,y:p.height,z:0}}],
    };
  },
});
export const catalog = createAssetCatalog([markerFamily], {maxVariants:32});
export const marker = catalog.resolve('survey-marker', {
  seed:41, instanceId:'park-marker', parameters:{width:0.8,height:1.2},
});
```

Number parameters require a range and step; choice parameters accept positive weights. Explicit values override defaults. A default fixes that parameter; omit it to sample variation. Omitted values without defaults are sampled from the family version, seed, instance ID and parameter name. Invalid values throw. A generator can reject cross-parameter combinations, as above, but the catalog does not search for another valid combination: author compatible ranges or provide valid explicit values.

Generators receive `context.random(stableKey)` for deterministic variation. Use stable semantic keys, retain meaningful instance IDs and increment the family version when generator meaning changes. Seeds make generation reproducible; they do not ensure every placement looks different. Give important objects distinct authored dimensions, colors, contents or geometry.

## General variation for authored recipes

`createVariation({seed,id,version,instanceId})` creates a small deterministic context for any recipe data. It can vary wall dirt, book page thickness, branching geometry, room proportions, sound controls or a new property invented by the author. It does not require a starter family or a recognized item name. Ordinary code still determines what the values mean and how they become geometry, materials or gameplay.

The context exposes `scope(key)`, `unit(key)`, `number(key,{min,max,step?})`, `integer(key,min,max)`, `chance(key,probability)`, `choice(key,[{id,weight?,value}])` and `repeat(key,count,(childContext,index)=>value)`. Scope separates related namespaces; stable semantic keys make repeated queries independent of call order. Weighted choice uses authored stable option IDs. Keep keys while editing unrelated properties, and change version when the generator's meaning changes. `repeat` gives each index its own child context; use explicit stable IDs/scopes when list entries must retain identity through insertion or reordering.

Select a shared style once when properties should correlate, then derive their values in code. Independently sampling every property can produce combinations the author never intended. Explicit validated parameters remain the final authority:

```ts
import { createVariation } from '../sandbox/variation.ts';
import type { SurfaceMaterialInput } from '../sandbox/surfaceMaterials.ts';

const variation = createVariation({seed:41,id:'archive-detail',version:'1',instanceId:'west-room'});
const style = variation.choice('style', [
  {id:'maintained',weight:3,value:{dirt:.12,paper:.001,color:'#d9d0b9'}},
  {id:'weathered',weight:1,value:{dirt:.6,paper:.0015,color:'#ac9674'}},
]);
const overrides: {dirtiness?:number} = {dirtiness:.35};
const dirtiness = overrides.dirtiness ?? style.dirt;
export const wallMaterial: SurfaceMaterialInput = {texture:{
  kind:'texture',version:1,name:'Archive wall',layers:[
    {source:{kind:'solid',color:'#d8c5ab'}},
    {source:{kind:'noise',colors:['#30271d','#a58c62'],scale:5},
      blend:'multiply',opacity:dirtiness,roughness:.6 + dirtiness*.3},
  ],
}};
export const pages = variation.repeat('pages', variation.integer('page-count',32,48), (page,index) => ({
  id:`page-${index}`, color:style.color,
  thickness:style.paper * page.number('thickness',{min:.9,max:1.1,step:.01}),
}));
```

The material uses the existing `SurfaceMaterialInput` and texture validator; its layer order is meaningful and stays authored. Dirtiness can also drive mask controls or tint, subject to those existing field ranges. The page results above are plain design data. A custom book generator can use them for geometry or merge visually equivalent pages into fewer pieces to satisfy its part budget.

Asset-family and terrain-area generators both receive `context.variation`; the asset context's existing `context.random` remains unchanged. Asset variation is keyed by the family/version, seed and **resolved parameters**, matching catalog reuse. To give otherwise identical asset placements different shapes, declare a sampled `variant` or `detailSeed` parameter and let it become part of that cache identity. Do not add hidden instance-specific random geometry behind a shared cache key. Terrain areas use their family/version, seed and instance ID because they are separately authored contributions. Direct `createVariation` calls use the identity you supply.

For bounded recursive structures, call `expandVariation({context,roots:[{id,state}],limits:{maxDepth,maxNodes,maxChildren,maxDataBytes?}},visit)`. The visitor receives `{id,parentId?,depth,state,terminal}` plus a scoped context and returns `{value,children?:[{id,state}]}`. Child IDs are stable within their parent. Results contain `{nodes,diagnostics}`; each node records its ID, parent, depth and plain value. The visitor is called at the depth boundary with `terminal:true`; return no children there. Exceeding depth, node, child or serialized-data limits is an invalid diagnostic, not successful silent pruning. Reject invalid results before compiling or publishing them.

The maximum recursion limits are depth 16, 512 nodes and 64 children; choose smaller task-specific limits. Existing asset, terrain, texture, collision and runtime budgets still apply to the generated values. This helper generates data, not new mesh primitives: `AssetPart` rotations remain yaw-only. Richer 3D branch endpoints can feed ordinary custom mesh/physics APIs using one authoritative geometry definition. Keep models, collision and views aligned.

[The procedural variation fixture](../tests/fixtures/procedural-variation.ts) demonstrates dirt controls, custom book pages and arbitrary 3D branch segments without starter dependencies. Resolve and compile on source/configuration changes, cache the derived variants and reuse them during gameplay. Keep original rules and manual overrides as editable source.

## Shared geometry and collision

Parts are boxes, cylinders or spheres with full dimensions in metres. Local coordinates use Y up, +Z forward and yaw radians. The overall geometry must be centred on X/Z and rest on Y=0. Sphere diameters must be equal. Colors use six-digit hex strings. Each part collides by default; set `collision:false` for decoration. Collision pieces must satisfy the minimum thickness and global limits in `ASSET_FAMILY_LIMITS`.

The resulting `AssetManifest` includes the family/version, seed, resolved parameters, content key, parts, sockets, bounds, dimensions and derived colliders. Box and sphere collision matches those primitives. Cylinders use conservative enclosing boxes, reported by `collisionApproximation`; they do not have curved physical collision. `validateAssetManifest` re-derives and checks serialized manifests instead of trusting supplied collider arrays or bounds.

`BuildingFurnitureRecipe.model` carries the selected manifest into the building compiler and automatic `BuildingWorldView` rendering. Keep the recipe dimensions consistent with `model.size`. Changing only the rendered shape or scale breaks the shared physical contract. For a standalone prop, call `transformAssetColliders(manifest, floorOrigin, yaw)` from `assetFamilies.ts` and install its returned colliders in the authoritative scene. Use the same floor-origin position and yaw for the view; the transform origin is not the asset's centre.

Sockets are named local positions with tags and optional yaw. They may extend outside the geometry to represent adjoining placement space. They describe an authored relation; they do not prove that a path is walkable.

## Weighted contents on furniture

`FurnishingRule.dressing` chooses a weighted arrangement for each host, then places its items on a named support surface. An arrangement can be neat, rumpled, sparsely populated or intentionally empty. The names are authored IDs, not built-in categories. Custom item families use the same dimensions, style parameters, texture palettes and geometry as other assets.

For example, this bed has two pillows most of the time, displaced pillows less often, and occasionally no pillows:

```ts
import type { AssetDressingArrangement } from '../sandbox/assetDressing.ts';
const bedding: AssetDressingArrangement[] = [{ id: 'pillows', surface: 'mattress', variants: [
  { id: 'neat', weight: 80, items: [{ id: 'pair', count: 2,
    choices: [{ id: 'cream', family: 'pillow', parameters: { width: .5, depth: .3, color: 'cream' } }],
    anchors: [{ id: 'left', x: -.25, z: -.32 }, { id: 'right', x: .25, z: -.32 }],
    jitter: { x: .01, z: .01 }, yaw: [-.03, .03] }] },
  { id: 'rumpled', weight: 15, items: [{ id: 'pair', count: [1, 2],
    choices: [{ id: 'blue', family: 'pillow', parameters: { width: .5, depth: .3, color: 'blue', style: 'tufted' } }],
    anchors: [{ id: 'left', x: -.25, z: -.32 }, { id: 'right', x: .25, z: -.32 }],
    jitter: { x: .04, z: .06 }, yaw: [-.4, .4] }] },
  { id: 'no-pillows', weight: 5, items: [] },
] }];
const bedRule = { id: 'bed', family: 'bed', count: 1, placement: 'wall' as const,
  wall: 'north' as const, parameters: { pillows: 'none' }, dressing: bedding };
```

Weights are relative: `80/15/5` gives that probability distribution over seeds, not an exact quota in every town. The arrangement is selected once; an impossible fit reports a problem rather than rerolling into a more common arrangement. Stable arrangement, variant, item, choice and anchor IDs make ordering changes harmless. Each surface selected by `{tag:'shelf'}` chooses independently; a string selects one exact surface ID.

Items support weighted `choices` of families/parameters/materials, `count` or integer ranges, `probability`, and bounded `required` counts. Without `required`, all sampled items must fit. `required:0` permits omissions and records them. Empty variants, zero counts and probability-based absence are intentional outcomes. An item's choice is selected once; bounded placement attempts only adjust its pose.

Anchors, zones and jitter use normalized surface coordinates: `x/z` from `-.5` to `.5` span its width/depth. `zone:{x,z,width,depth}` limits placement to a rectangle; the entire rotated item must fit both the zone and support surface. `yaw` is radians relative to the surface and can be a range. No manual Y calculation is needed: items rest at the actual support height. Parent geometry, sibling overlap and available height are checked, including shelf ceilings and bed headboards. Static folded/rumpled blankets are modeled shapes; this does not add cloth simulation, falling objects or pickup behavior.

The starter table, desk, counter and nightstand expose `top`; shelves expose `shelf-0` through `shelf-3`; beds expose `mattress`. Use bed `pillows:'none'` and shelf `contents:'none'` to replace legacy baked-in decorations. Custom generators can expose upward surfaces:

```ts
// Included beside parts/sockets in AssetGeometry:
surfaces: [{ id: 'top', tags: ['display'], partId: 'tabletop',
  position: { x: 0, y: .75, z: 0 }, width: 1.2, depth: .6, clearHeight: 1 }]
```

The named box/cylinder part must have a real top face at that Y; the rotated support rectangle must fit inside it. Surface metadata is validated, frozen and included in the manifest key. `clearHeight` optionally limits contents above a shelf. Geometry and remaining surfaces transform together when assembled into groups.

`resolveAssetDressing(catalog,{model,seed,instanceId,arrangements})` also works outside rooms. It returns the host and selected item models, poses, arrangement records and diagnostics. Reject invalid diagnostics, then use `assetDressingModel(result,{id,version})` to get a normal compound model and `originOffset` for building, standalone or terrain rendering. Root sockets/surface IDs remain reusable. The same parts provide visible geometry and optional collision; small decorations default to noncolliding. Item finishes and colors remain independent of the host's finish (`inheritMaterial:false`), while explicit item/part textures take precedence.

Furnishing resolves the composition once before trying room placements, so its complete bounds participate in door, wall and headroom checks. Inspect `diagnostics.dressing` for chosen arrangements, intentional empty choices, requested/placed counts, optional omissions and whether each host itself was placed. Generation and flattening are bounded by the existing asset budgets; reuse compiled models instead of regenerating every frame.

## Reusable socket groups

`resolveAssetGroup(catalog, {family,seed,instanceId,parameters?,attachments?})`
resolves one parent and one level of attachments. Each rule is
`{id,socketTag,family,count,parameters?}`: matching root sockets are selected in
stable socket-ID order, and children retain the socket's local position/yaw.
Tags can describe decoration, equipment, seating or any authored relation.
Counts are exact; missing sockets, multiple claims and budget overflow throw.
There is no recursive attachment search. Models and resolved parameters remain
available in immutable `group.instances`.

```ts
import {createStandardAssetCatalog} from '../sandbox/assetFamilyPresets.ts';
import {resolveAssetGroup, assetGroupModel} from '../sandbox/assetGroups.ts';
import {terrainModelAsset} from '../sandbox/terrainAssets.ts';

const patio = resolveAssetGroup(createStandardAssetCatalog(), {
  family:'table', seed:41, instanceId:'patio',
  parameters:{shape:'rectangle',width:1.8,depth:1},
  attachments:[{id:'seating',socketTag:'seat',family:'chair',count:2}],
});
export const assembly = assetGroupModel(patio, {id:'patio-assembly',version:'1'});
export const outdoorAsset = terrainModelAsset('patio', assembly.model);
```

`assetGroupModel` flattens the same parts into a standard `AssetManifest` for
instancing, with compound collision derived by the normal compiler. It recenters
X/Z and moves the lowest point to Y=0. `originOffset` is the new model origin in
the original group's coordinates. To preserve an existing parent anchor, place
the combined model at `parentPosition + rotateY(originOffset,parentYaw)` and use
the parent's yaw. To position a new group by its footprint centre, use the model
origin directly. Remaining sockets transform with the parts; consumed root
sockets are omitted. Individual parameters stay in the original group, so keep
that source for later edits.

Groups allow at most eight attachment rules, 33 instances, 512 parts and 384
colliders. Flattening additionally applies ordinary asset limits of 128 parts,
96 colliders and 32 remaining sockets; a larger valid group may therefore need
separate model instances. Socket relations do not prove support or clearance.
The placement domain still checks room bounds, doors, terrain support and roads.

## Compile and reuse

Resolve at recipe/configuration changes, not in simulation ticks or render frames. Placements with the same family version, seed and resolved parameters reuse one catalog entry, even when their instance IDs differ. Catalog `inspection()` reports generation, cache hits and eviction. Eviction affects work and memory, not the deterministic result. Dispose view handles when removed.

Keep the original family, recipe, parameters and manual overrides as editable source. The manifest is derived data. Custom families are bounded primitive generators; arbitrary meshes, richer architecture and specialized gameplay can still be authored through the ordinary game APIs.

For an isolated prop view, use `createAssetView(manifest)` from `assetFamilyView.ts`. Repeated props should share one `AssetFamilyViewCache`; each `cache.create(manifest)` returns `{object,dispose}`. Add the object to the scene, dispose each instance on removal and dispose the cache at teardown. The cache shares primitive geometry and materials. None of these view helpers belong in authoritative logic.

`standardAssetFamilies()` returns ordinary family definitions to mix with authored families in `createAssetCatalog`. `createStandardAssetCatalog()` supplies them as a convenience. Inspect `catalog.families()` for actual parameter ranges and choices. The table family supports rectangular, round and oval tops with independent construction and material choices. Round tables normalize their diameter to the smaller requested width/depth: use the resolved `manifest.size` for placement and collision dimensions.

`terrainFamilyAssets` creates a bounded palette using this same catalog;
`terrainModelAsset` uses one selected or combined model outdoors. Terrain renders
the parts and uses their compound colliders. Landscape area families also reuse
`defineAssetParameters`/`resolveAssetParameters`, including ranges, steps, weighted
choices, defaults and explicit overrides, while generating terrain contributions
instead of object geometry. See [terrain authoring](procedural-terrain.md).

## Furnish a room

`furnishBuilding` automatically reserves door approaches and stair footprints before placing furniture. Rules express wall, grid, free or central placement; optional seating attaches chair variants to the parent asset's ground-level sockets tagged `seat`.

For other relations use `rule.attachments` with the generic socket-group rules
above. `seating` remains compatible and uses the reserved attachment rule ID
`seating`; do not reuse that ID or claim its sockets twice. Elevated decorations
may share a parent's X/Z footprint when their vertical volumes are separate,
but the whole group still needs conservative room and circulation clearance.

```ts
import { createStandardAssetCatalog } from '../sandbox/assetFamilyPresets.ts';
import { furnishBuilding } from '../sandbox/furnishing.ts';
import type { BuildingRecipe } from '../sandbox/building.ts';

export function furnishDiningRoom(source: BuildingRecipe, roomId: string) {
  const catalog = createStandardAssetCatalog();
  const result = furnishBuilding(source, catalog, {seed:41, rooms:{
    [roomId]: {rules:[{
      id:'dining', family:'table', count:1, placement:'free',
      parameters:{shape:'rectangle',base:'four-leg',width:1.8,depth:1,height:0.8},
      seating:{family:'chair',count:4},
    }]},
  }});
  if (!result.diagnostics.valid) throw new Error(JSON.stringify(result.diagnostics.issues));
  return result.recipe;
}
```

Every requested group is required unless its rule lowers `required` explicitly. Diagnostics distinguish required failures from `omittedOptional`, and count bounded attempts. A table with its chairs is accepted as a group. `furnishRoom` accepts explicit clearance reservations and existing furniture for lower-level control; `furnishBuilding` adds the building's door/stair reservations and optional central circulation. Placement uses conservative footprint bounds, not a full navigation solver.

## Give placement directional context

Room `orientation` can declare `front:'north'|'south'|'east'|'west'`, `focalPoint:{x,z}` and `entry:{x,z}`. These points use **building-local coordinates**, just like room centres. North is -Z; assets face +Z before yaw. Building rotation transforms the entire room and its furniture together.

Rules opt into `facing:'room-front'|'focal-point'|'entrance'`, or an explicit `{side:'north'}` / `{point:{x,z}}`. An explicit `yaw` overrides facing. For a church with its altar at the north end, set the nave's front to north and the pew rule's facing to room-front. Use focal-point when seats should angle toward a particular position. Check the actual model's front/back geometry, not just its rotation number; authored asset geometry must follow the +Z contract.

`preferences:{front:2, back:0, focalPoint:1, entrance:0}` ranks valid candidate placements using nonnegative weights up to100. These are soft location preferences, separate from facing. Stronger weights do not override walls, doors, stairs, room bounds or occupied space. With no preferences the existing first-fit placement is retained. Missing requested context reports a diagnostic. Explicit room entry wins; `furnishBuilding` can infer a primary or sole touching doorway, but does not guess between multiple other doors.

Socket seats keep the parent transform plus socket yaw, so rotating a table still turns all its chairs toward the table. Compile/furnish once per configuration change; bounded candidate scoring belongs outside gameplay ticks.

The returned building recipe retains existing furniture and appends generated items. For an edit, rerun from the unfurnished source with manual overrides included once. Repeating the same rules on the previous output is rejected with diagnostics because the generated identities already exist. Stable room/rule IDs preserve unrelated asset selections.

## Review placement in the game

Use furnishing diagnostics to check requested relations, room bounds, door space and rejected placements. Change dimensions or placement when an item does not fit. Review the actual selected variants in a cutaway, then use ordinary gameplay movement through entrances, furnished rooms and stairs. Re-run the same seed and route after edits, and inspect several variants before making broader claims.

Placement constraints, connectivity and collision checks are bounded evidence. They do not provide a universal player or NPC navigation guarantee, arbitrary polygon floor plans or an unconstrained city planner.
