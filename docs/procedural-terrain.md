# Procedural terrain authoring

The terrain toolset lets an AI describe a landscape, then change its paths,
buildings and props without manually rearranging every tree. A deterministic
compiler turns one editable recipe into a sampled surface, vegetation, placed
objects, colliders and diagnostics. Rendering and gameplay use that same manifest.

The APIs are mode-independent. Reuse the base game's shared terrain host so
authority, prediction, rendering and animation support query the same geometry.
A mode can retain authored walls or a fixed flat floor through its host options;
inspect `constraints` before changing its elevation. Preserve mode rules and
safe starts when replacing a base's landscape.

Water is optional per body: use `proceduralWater.ts` to choose animated lake,
ocean or river surfaces, or a bounded simulated water body. Surface animation
can sample the terrain's shared wind; the simulated body uses the current
terrain/structure physics scene and can apply fluid loads to destructible
structures. See
[water.md](water.md) for generation, rendering, state and cost choices.

## The AI's normal workflow

This uses the same editable TypeScript/JSON and engine diagnostics available to any host application. It does not require a separate generative service or external
game editor. The browser terrain lab makes the effects easier for a person to
explore; ordinary game revisions remain the AI's authoring and inspection unit.

## Shared recipe and manifest

`TerrainRecipe` is plain data with `version: 1`. Coordinates are metres, with Y
up and the rectangular map centred at the origin. It includes:

| Field | What the AI authors |
| --- | --- |
| `seed`, `bounds`, `base` | Stable layout seed, bounded sampling grid and optional height noise |
| `assets` | Unique IDs, circle/box footprints and either a resolved family model with compound collision or a legacy collider/appearance hint |
| `regions` | Circle/box biome masks, blended elevation/color and scatter layers |
| `regions[].layers` | Asset choices, spacing, density, scale range, slope/elevation filters, facing, weighted preferences and optional layer seed |
| `routes` | Polylines, widths, shoulders, clearance and optional grading constraints |
| `channels` | River/canal centerlines, varying bed widths/depths, downhill grades, bank falloff, shared textures and excavation budgets |
| `placements` | Explicit structures/props, transform, clearance, foundation and access corridors |
| `reservations` | Circle/box masks that clear scatter without grading, collision or travel-route obstruction |
| `overrides` | Removed instance IDs and pinned explicit placements |
| `budgets` | Explicit candidate, instance and collider limits |
| `streaming` | Optional chunk size/resolution, or `false` for an eager world |
| `environment` | Shared wind and optional world ambience; presentation metadata leaves generation/collision unchanged |
| `regions[].environment` | Blended biome ambience and wind exposure |
| `assets[].environment` | Size-sensitive wind motion and sound inherited by generated and placed instances |

Use stable IDs while refining. Scatter candidates are keyed independently by the
seed, region, layer and cell. Adding a route suppresses candidates in its reserved
area; removing it restores the original candidates. Editing one layer's seed
deliberately rerolls that layer. Footprint/spacing dependencies can affect nearby
objects, so compare the compiler's change report rather than assuming every
object outside a drawn line stays fixed.

`compileTerrain(recipe, previous?)` returns the manifest. `TerrainCompiler`
freezes and retains the last valid result for edit comparisons; an invalid draft
remains inspectable without replacing that baseline. Compile on recipe changes,
not every simulation tick or render frame. This lower-level function processes
the bounded recipe as a whole. Use `createTerrainWorld()` for automatic chunk
preparation and shared authority/view/prediction integration.

For example, this compares an untouched forest with the same seeded forest after
adding a trail and landmarks. Put the recipe/manifest in a shared world module
and use its result from both the game's logic and view:

```ts
import {compileTerrain, terrainPhysicsScene} from '../sandbox/terrain.ts';
import {forestMeadowTerrain} from '../sandbox/terrainPresets.ts';

const forest = compileTerrain(forestMeadowTerrain({
  seed: 41, path: false, cabin: false, statue: false,
}));
export const terrain = compileTerrain(forestMeadowTerrain({seed: 41}), forest);
if (!terrain.diagnostics.valid) {
  throw new Error(terrain.diagnostics.issues.map(issue => issue.message).join('; '));
}
export const physicsScene = terrainPhysicsScene(terrain);
```

The view constructs `new TerrainView(terrain)` from that shared definition and
attaches its root. The host's existing physics hook returns `physicsScene`.
For a custom design, edit the returned recipe's regions, layers, routes and
placements directly rather than adding new preset switches for each request.

## River and canal channels

Use `TerrainRecipe.channels` to excavate a reusable river or canal directly into
the generated ground. The terrain view, collision, planning sampler and streamed
chunks all use the same carve; no separate demo mesh or manual bank patch is
required. Channels also reserve their banks against procedural trees and props.

```ts
const terrainRecipe: TerrainRecipe = {
  version: 1, seed: 41,
  bounds: {width: 64, depth: 64, cells: 32},
  base: {height: 4}, assets: [], regions: [],
  channels: [{
    id: 'valley-river', kind: 'river',
    width: 6, depth: 2, bankWidth: 3, maxCut: 5,
    points: [
      {x: -24, z: -24, bedY: 2},
      {x: -8, z: 0, bedY: 1.5, width: 8},
      {x: 8, z: 16, bedY: 1, width: 10},
      {x: 24, z: 32, bedY: .5},
    ],
    color: '#81715a',
  }],
};
const ground = compileTerrain(terrainRecipe);
if (!ground.diagnostics.valid) throw new Error('Inspect terrain channel issues.');
const centerline = ground.channels![0];
```

Point order is upstream to downstream. `width` is the flat bed width, with an
additional `bankWidth` on each side. Width, depth and bank width can be overridden
per point and interpolate along the path. River banks have smooth falloff; canal
banks are straight slopes. Heightfields cannot represent vertical retaining
walls or overhangs; use ordinary colliders/models for those structures.

At bends, overlapping segment cross-sections blend their off-centerline bed
grades and flow directions continuously. This prevents an artificial step where
the closest route segment changes. Authored centerline elevations stay exact,
and bank coverage remains the union of the authored segment widths and banks.

When `bedY` is omitted, a river starts at base height minus depth, then cuts
through rises while following lower ground. A canal follows the inlet bed at
its `minimumSlope` (default zero). Explicit bed elevations must respect that
downstream grade. The compiler rejects impossible terrain filling and `maxCut`
violations instead of silently placing water uphill. Excavation is applied
before road grading and building foundations; do not put a flattening foundation
over a channel. Explicit elevated bridges can set `allowPlacements:true`.

`resolveTerrainChannels(channels, baseHeight)` and
`sampleTerrainChannel(channel, x, z)` in `terrainChannels.ts` expose the same
centerline used by carving. Resolved points include `bedY`, dimensions and distance
along the route; samples include tangent direction, interpolated dimensions,
bed elevation and a bank weight. The engine water authoring helpers can use these
to initialize flowing water, choose inlet/outlet locations and reuse the actual
terrain physics scene. Ground generation alone does not add water volume or
create a hidden flow source. See [water.md](water.md) for live and baked water.

Channels accept the shared `material` texture input as well as a color. Feature
contributions support `terrain.channels` with the normal owner ID namespaces.
Channel edits invalidate terrain geometry and streamed caches. Bounds are 16
channels, 64 points per channel, and 512 points total. A diagnostic warns if the
bed is narrower than two terrain cells: reduce the streamed chunk size, increase
its cells within the existing limit, or widen the channel. A fine water grid
cannot recover banks missing from a coarse terrain heightfield.

## Reuse indoor and outdoor families

Terrain-area generators also receive `context.variation` for keyed numbers,
weighted shared styles and bounded repetition. Use `createVariation` or
`expandVariation` for custom recipe values or recursive plain-data plans; see
[general variation](parametric-assets.md#general-variation-for-authored-recipes).
Existing terrain/asset budgets and physical validation still apply. Resolve on
recipe changes and preserve stable identities and explicit parameter overrides.

`terrainAssets.ts` connects the same `AssetCatalog` and `AssetManifest` used by
building furniture to ordinary terrain layers and placements. Resolve a bounded
palette before preparing chunks:

```ts
import {createStandardAssetCatalog} from '../sandbox/assetFamilyPresets.ts';
import {terrainFamilyAssets, terrainModelAsset} from '../sandbox/terrainAssets.ts';

const catalog = createStandardAssetCatalog(); // Custom authored families work too.
export const benches = terrainFamilyAssets(catalog, {
  id:'park-bench', family:'bench', seed:41, variants:4,
  parameters:{width:1.8, depth:0.6, height:0.8},
});
export const sculpture = terrainModelAsset('park-sculpture',
  catalog.resolve('planter', {seed:41, instanceId:'courtyard-planter'}));
```

Add the returned assets to `recipe.assets` and use their IDs in layers,
placements or pins. Model bounds supply the footprint; all compound colliders
come from the model's parts. Do not also supply the legacy single `collider`.
`TerrainView` automatically instances the model's mesh parts and shares primitive
resources. Custom `assetFactory` remains available; it must preserve the physical
contract when replacing visuals.

Palette size is bounded, not a promise of distinct models: defaults and explicit
parameters can resolve to the same key. Select meaningful parameter ranges in
your own family and inspect the actual variants. The same collider, asset and
instance budgets still apply; several colliders per model use that budget faster.
Decorative parts can explicitly disable collision.

`resolveAssetGroup` and `assetGroupModel` from `assetGroups.ts` assemble arbitrary
tagged sockets before terrain placement, such as a table with chairs or equipment
around a stand. The flattened model retains compound collision and is recentered
at floor Y=0. Its `originOffset` identifies the new origin relative to the original
parent; rotate and add that offset if an existing parent anchor must stay fixed.
See [parametric assets](parametric-assets.md) for the exact group contract.

## Contextual placement and area families

Layers and authored placements accept `facing:{side:'north'}`, `{point:{x,z}}` or
`{route:'walk',along:true}`; a route without `along` faces its nearest point.
An optional `offset` adds radians, and explicit placement `yaw` wins. Asset +Z
is forward and north is -Z. An explicit placement coinciding with its target
needs an authored yaw; scatter retains its seeded yaw when no direction exists.

For a layer, use `preferences:[{target:{route:'walk'},mode:'near',range:12,weight:3}]`
or a point target. `near` falls from one at the target to zero at `range`; `away`
is its inverse. The weighted average biases a deterministic acceptance roll
**after stable spacing**. This is local density control, unlike furnishing's
ranking of bounded room candidates. It does not guarantee a count or globally
best packing, and never relaxes slope, elevation, reservation or boundary checks.
Zero-weight preferences preserve the existing distribution. Use explicit
placements when a particular object must be present.

`recipe.reservations` accepts `{id,mask,clearance?,shoulder?}`. It removes scatter
without changing the ground or creating a solid obstacle, useful below a clear
arch or around an arranged group. Actual compound collision must still preserve
walking space. These are different from the host's protected-area
`TerrainWorldOptions.reservations`, which also restrict deliberate placements.

Area families generate editable terrain contributions with the same bounded
numeric/weighted-choice parameter grammar as object families:

```ts
import {defineTerrainAreaFamily, resolveTerrainArea} from '../sandbox/terrainAreas.ts';
import {composeTerrainRecipe} from '../sandbox/terrainWorld.ts';

const hill = defineTerrainAreaFamily({id:'garden-hill', version:'1', parameters:{
  radius:{kind:'number', min:6, max:14, step:2},
  height:{kind:'number', min:1, max:3, step:0.5},
}, generate(p) { return {regions:[{id:'hill',
  mask:{kind:'circle', center:{x:0,z:0}, radius:p.radius},
  elevation:p.height, blend:8, layers:[],
}]}; }});
const area = resolveTerrainArea(hill, {seed:41, instanceId:'garden'});
export const landscape = composeTerrainRecipe({version:1, seed:41,
  bounds:{width:64,depth:64}, assets:[], regions:[]},
  [{id:'garden', priority:0, terrain:area.terrain}]);
```

`defineAssetParameters`/`resolveAssetParameters` are the shared parameter
authority. The area generator receives resolved parameters plus seed/instanceId;
it does not receive an object-family `context.random` callback. Keep generators
deterministic and bump their version after meaning changes. Contributions remain
editable and namespaced when composed, including local route targets in facing
and preferences. Resolve at configuration changes, then validate the complete
composed terrain; an area family is not an automatic geometry or layout solver.

## Connected scenery, wind and sound

Consider the material, movement and sound together when adding a biome, tree or
bush. `forestMeadowTerrain()` supplies editable environment profiles. The AI can
change a few profile values rather than write animation and audio loops for
every generated object. For example, after creating an editable recipe:

```ts
recipe.environment = {
  wind: {direction: [0.8, 0.6], strength: 0.45, gustStrength: 0.35},
};
recipe.regions[0].environment = {
  ambience: {recipe: 'forest-ambience', gain: 0.35},
  windMultiplier: 0.7, blend: 8,
};
recipe.assets[0].environment = {
  wind: {bendRadians: 0.06, swayHz: 0.7, referenceHeight: 4, sizeExponent: 0.5},
  sound: {recipe: 'tree-rustle', gain: 0.3, windGain: [0, 1],
    referenceHeight: 4, sizeGainExponent: 0.6, radius: 28},
};
```

Choose the actual region/asset IDs; these indices only illustrate the fields.
`EnvironmentSound.recipe` accepts a built-in recipe ID or a complete editable
`SoundRecipeInput`. Inline recipes travel inside a portable feature's terrain
contribution without a separate registry. Use the installed media catalog for ingredients
and audition the chosen recipe through the host application. Forest, meadow, tree
and bush presets are starting points, not mandatory sounds.

`TerrainView` and `TerrainWorldView` automatically connect profiles to the shared
view clock and gameplay listener, select nearby sources, smooth gain changes and
stop owned sounds when content unloads or the view is disposed. Do not add a
sound loop per tree or call the environment frame driver from an ordinary game.
The same deterministic world-space wind drives motion and sound, including
across streamed chunk boundaries. Asset response uses measured model height
times generated scale. With the example exponents, a larger tree sways more
slowly, rotates through a smaller angle and has a stronger sound response.
Change or disable any response to fit the intended design.

Biome sound weights blend across mask edges. Overlaps share a bounded weight;
outside configured biomes, world ambience is the fallback. A region containing
only a wind multiplier inherits that ambience. An explicit zero-gain ambience
can fade a region to silence. Existing recipes without profiles remain static
and silent. An asset that opts into wind gets a default breeze even on an older
base; explicit world `strength: 0, gustStrength: 0` is calm.

The default visual response rotates the whole model around its ground anchor,
preserving connected parts and shadows. It does not deform branches or leaves,
run skeletal motion matching on trees, or move authoritative colliders. A custom
model or animation can reuse the pure `sampleTerrainEnvironment` and
`sampleTerrainAssetEnvironment` helpers and apply its own deformation.

The shared runtime bounds active work across views: 512 nearby animated
instances, eight environment audio voices including fades, and five selected
sound targets. Object sound selection caps its radius at 128 metres. It does
not load an entire world or play every tree at once. Normal game inspection adds
`shared.environment` observations for wind, biome weights, size/gain, selected
sources, omitted work and invalid sound recipes. Review these with the same
seed and route, cross a biome edge, inspect multiple generated sizes, and audition
recipes separately. Numbers and screenshots do not prove audible quality;
silence, static scenery and unusual combinations remain artistic choices.

## Default streaming and durable edits

Declare a terrain host in a shared game module and expose it as `terrainWorld`
on both `GameLogic` and the game view. Worlds wider or deeper than 128 metres
stream by default. The default chunk is 128 metres with 16 cells per side
(289 height samples); explicit `streaming: {chunkSize, cells}` can select a
supported chunk size and up to 32 cells. Smaller worlds stay eager when this
option is omitted; an explicit streaming object enables chunks even in a small
world. This is useful for river banks: a centered 24 m square with
`streaming: { chunkSize: 32, cells: 32 }` prepares four clipped 12 m square
chunks, each with 0.375 m cells. `createTerrainWorld()` owns their placement,
collision and queries, and `TerrainWorldView` draws those same prepared chunks.
Terrain resolution and water simulation resolution are separate: refining only
water cannot recover shoreline detail missing from a coarse terrain mesh.
`streaming: false` also selects eager generation, subject to its existing limits.

The runtime derives interests from each active player's position and velocity,
including separated groups. The default radius is one quarter of a chunk,
expanded by one terrain cell and the largest generated collider's horizontal
reach. A half-second motion sweep prepares the next neighborhood. Author
`initialInterests` for off-origin setup, join destinations and respawn locations.
An explicit host-driven `MatchSandbox.prepare` or `MatchWorkerClient.prepare`
loads destination coverage and retains it for the next transition. Calling
`terrainWorld.prepare` from authored gameplay does not guarantee that destination
survives automatic preparation; arbitrary authored teleport scheduling is not
implemented.

Preparation generates at most one chunk per call outside the tight gameplay
tick. A match waits until every required chunk is ready, then installs the
complete collision scene atomically. Old geometry outside the new interest set
is evicted and deterministically regenerated on return. This pauses that
match's simulation during preparation; it does not guarantee hitch-free loading
for arbitrary density or speed. A request beyond the active chunk budget fails
explicitly instead of dropping a player's collision.

Keep lasting changes in declared serializable world state. Supply one projection
from that state to recipe overrides so every sandbox applies the same edits:

```ts
import {createTerrainWorld} from '../sandbox/terrainWorld.ts';
import {recipeFor} from './terrainRecipe.ts';

type Tuning = {seed: number};
type World = {removedTreeId: string; terrainRevision: string};

export const terrainWorld = createTerrainWorld<Tuning, World>(recipeFor, {
  initialInterests: () => [{x: 0, z: 0}],
  edits: world => world?.removedTreeId ? {remove: [world.removedTreeId]} : {},
});
```

The runtime, view and prediction preparation path call `sync(tuning, world)`
before preparing geometry. An undefined world denotes initial state. Changing
`world.removedTreeId` therefore removes the same tree from collision and rendering
and survives chunk eviction. Extend the projection with pinned placements or
other supported overrides for the game's own mechanics. Do not rely on a
one-off `setEdits()` call in just one sandbox as a durable gameplay change.

The core automatically binds the final composed world shape to the terrain host.
An `edits` callback receives a copy conformed to the values clients receive,
including the declared numeric precision. Authored `sync()` calls use that same
projection, and inspection snapshots use the same wire values. The game's private
world remains untouched. Use `float64` for a field that needs full precision;
`float32` fields remain rounded consistently without manual author-side rounding.

Read the accepted snapshot with `terrainWorld.read(tuning)`. Use its `.scene`,
`.sample()`, `.available()`, `.spawns()` and support helpers. Attach
`new TerrainWorldView(snapshot)` and update it with accepted snapshots; it
reuses unchanged chunks and disposes retired ones. Keep the snapshot's
`revision` in authoritative state and use `assertRevision()` in the view.
`revision` changes with recipe/edits; `loadedRevision` also changes as resident
chunks move. Reusing an immutable scene object avoids serializing its geometry
on every tick. The standard runtime prepares native physics before simulation.

Local route, placement, pin/removal and scatter-reservation edits may reuse
previously prepared CPU chunk geometry outside conservative dependency bounds.
Those bounds include old and new locations, foundation/shoulder blends, footprint
reach and sampled cell edges. Global changes such as seed, base, regions or asset
definitions rebuild; unknown dependencies and edits to routes observed by facing
or preferences also rebuild. This is conservative reuse, not arbitrary incremental
compilation. Inspect `streaming.reused` and compare against a fresh compilation.
Reused chunks receive the new recipe/revision. During preparation, the new world
is still pending; gameplay installs its complete required collision atomically
when ready. Reuse does not bypass validation or make unprepared regions available.

`TerrainView` and `TerrainWorldView` also retain existing GPU meshes when the
immutable generated height, color and instance buffers keep the same references
and all rendering/wind dependencies still match. They adopt the accepted new
recipe and diagnostics without rebuilding those meshes. Custom asset factories,
active debug overlays, changed dependencies or mutable/new generated buffers
take the conservative rebuild path. CPU chunk reuse alone is not a promise that
every view edit keeps GPU resources.

Streaming diagnostics validate global metadata and loaded chunks. Check
`streaming.ready`, `pending`, `loaded`, `missing` and `validation`, plus the
accepted revision. Counts and samples describe resident geometry, not unseen
parts of the map. An overview capture of loaded chunks cannot prove a distant
route is playable. Inspect important destinations and traverse routes with real
inputs; `.available(x, z, radius)` must succeed before trusting collision there.

### Geometry and resource limits

The shared native bridge accepts translated `PhysicsScene.terrainChunks`, each
with a stable ID, dimensions, heights and world-space centre. Authority and
browser prediction use the same validator and Rapier construction order.
Unchanged chunk descriptors and height buffers are reused; replacing the active
set rebuilds its canonical native snapshot so replay results do not depend on
which chunks happened to load first.

| Limit | Eager scene | Streamed scene |
| --- | --- | --- |
| Active heightfields | 1 | 128 chunks |
| Cells per heightfield edge | 32 | 32; default generation uses 16 |
| Total height samples | 1,089 | 139,392 |
| Static colliders | 96 | 12,288 total; 96 generated per chunk |
| Serialized scene request | 131,072 JSON characters | 8,388,608 JSON characters |

These are hard ceilings, not generation targets. All 32 players' required
neighborhoods share the 128-chunk budget; large collider reach, high speed,
authored interest radii or extra spawn destinations may require more chunks and
must be redesigned or prepared in a bounded sequence. Other native operations
retain the smaller request limit. Declared extra colliders count toward the
scene total. QuickJS still has its 32 MiB heap limit, and preparation and live
tick deadlines still apply.

The default 16-cell resolution leaves more heap headroom for gameplay. A local
32-player, 128-chunk diagnostic with about 7,800 generated obstacles peaked at
21.13 MB of QuickJS memory during replacement/revisit; explicit 32-cell sampling
peaked at 28.41 MB. These are measurements of that recipe, not capacity promises
for arbitrary scripts or the production host. See
[inspection performance](inspection-performance.md) for worker scheduling and
the exact-runtime verification boundary.

## Paths, buildings and objects

The compiler evaluates structural reservations before scatter. A path therefore
clears vegetation automatically, and a building's footprint and entrances do not
depend on whether trees happened to be generated first. Grading alters the shared
heightfield; it is not only a visual surface placed above the old floor.

The AI must supply meaningful metadata. An arbitrary imported house mesh does
not automatically reveal its footprint, doors or collision geometry. Footprints
describe occupied ground space and scale with instances; collision shapes can
be narrower than foliage. Decorative flowers may have no collider. A solid box
collider cannot represent a walkable building interior even if its mesh shows a
door: author appropriate collision geometry when the experience needs one.

Pins and hand-authored placements are deliberate edits, not permission to
silently overlap incompatible reservations. Read reported conflicts and repair
the route, placement or metadata. Keep failed output out of gameplay rather
than publishing a partially generated world.

## Physics, rendering and feedback

`terrainPhysicsScene(manifest, extraColliders?)` supplies the shared ground and
declared obstacles. `sampleTerrain(manifest, x, z)` samples that heightfield and
returns height, normal and whether the query is inside the bounded surface.
Use it for spawn placement, surface checks and animation support, checking
`inside` before trusting a sample. Animation helpers still need their own
current-frame support and contact inputs.

Use `terrainActorSupports` in the host's `actorSignals` adapter to avoid manually
translating terrain samples into the shared animation contract:

```ts
import {terrainActorSupports, terrainFootSupports} from '../sandbox/terrainQueries.ts';

// Include alongside the actor's actual position, velocity and grounded state.
const supports = terrainActorSupports(terrain, {ground: actorPosition}, frame.now);

// In an actor's afterApply hook, AFTER its fresh pose and world transform:
const footSupports = terrainFootSupports(terrain, feet.positions(), frame.now);
feet.apply({timeMs: frame.now, epoch: terrain.revision, frame: movementFrame,
  supports: footSupports, contacts: authoredContacts, grounded: actorGrounded});
```

Both adapters sample the same triangles used by physics, omit out-of-bounds
points and stamp observations with the supplied frame time. Foot supports carry
the surface revision so an edit releases old anchors. Query each actor's current
points each frame; share the compiled world and immutable animation banks, while
keeping controllers and foot locks per actor. These helpers sample the generated
ground only: a bridge, roof or moving platform needs its own actual support query.
Neither a ground sample nor a motion clip proves the actor is grounded. Preserve
authoritative grounded state and authored or measured contact weights; do not lock
every running foot. The two adapters are pure data helpers and accept custom rigs.

`terrainQueries.ts` adds `terrainSpawns(manifest, options)` for a roster of
1–32 upright actors. Supply the actual capsule radius/height, desired spacing,
optional preferred points and a maximum slope in degrees. It checks five
surface samples and actual obstacle clearance, throwing when it cannot find
enough positions within its bounded search. `terrainClearance` is the lower-level
obstacle/boundary query. These checks do not establish route connectivity,
competitive fairness or safe movement through the entire map; keep mode-specific
spawn choices and playtests.

`new TerrainView(manifest, {assetFactory, debug})` creates a view with a `.root`
to attach to the scene. `.update(manifest)` replaces a compiled revision;
`.dispose()` releases its owned rendering resources. `assetFactory(asset)` can
return original or imported static mesh parts. It is not restricted to the
placeholder trees, shrubs, rocks, cabin or statue. Match the visual dimensions
to the authored footprint and collider metadata. Dynamic/skinned actors remain
independent actors with their own animation and gameplay.

Expose `terrainInspection(manifest)` or `TerrainView.inspection()` through the
existing view inspection hook. Reports include validity, issue summaries,
instance/collider/candidate counts, exclusions, sampling and edit changes. Do
not return raw height arrays or every instance: game diagnostics have a 16 KiB
budget. View diagnostics are authored evidence, separate from the rendered
images and simulation state. Issue IDs and positions identify which reservation
to edit. Asset and missing-model totals remain visible when their lists are
truncated. Check both the terrain summary's `truncated` flag and the overall
inspection's complete/truncated/error status.

`setDebug({routes: true, footprints: true, changes: true, regions: true})`
shows the reservations and edits in the actual rendered world. Disable overlays
for a second capture that judges the final composition and natural transitions.
Review clearing width, foundation transitions and access from player height as
well as from an overview camera.

## Workshop and verification

Open the [terrain workshop](http://127.0.0.1:5173/tests/visual/procedural-terrain.html)
with the development server running. It exposes the seed, density, construction
stages, path position, debug overlays and a comparison with the untouched forest.

Verified on 2026-10-15:

- 92 focused compiler, rendering, physics, spawn, boundary and AI authoring tests
  passed, alongside typecheck and the production build.
- 90 native Rapier ray queries matched the shared terrain height and normal
  queries across hills, a graded path and a foundation.
- Six isolated inspections covered forest, trail and settlement revisions, RPG
  and Duel movement, and a 32-player Arena roster: 156 rendered frames and 12
  captures, with complete diagnostics and no runtime errors.
- Browser checks covered all construction stages, path removal and relocation,
  seed/density changes and debug overlays, with no warnings or errors.

Run `npm run verify:terrain` in the configured isolated inspection environment
to reproduce the playable checks. The roster check validates spawn capacity and
rendering; it is not a multiplayer network or large-world performance benchmark.

The streaming runtime regression in `tests/core/terrainStreamingRuntime.test.ts`
prepares 128 chunks for 32 dispersed participants through the real game runtime,
then compares 100 live-worker and offline replay ticks exactly while travelling
150 metres out and back. It checks complete native ground support, chunk
eviction/revisits and bounded revisions. `tests/core/physicsChunks.test.ts`
separately covers translated slopes, seams, descriptor reuse/removal, authority
and client parity, rejected scenes and the maximum native geometry envelope.
Run these alongside the focused terrain tests after changing streaming or
physics; exact release checks still need the intended isolated host.

## Current boundary and next steps

This is bounded Y-up heightfield terrain with seeded scatter, structural
constraints and streamed partitions. Declared instance removals and pinned
placements can persist through regeneration; arbitrary mesh destruction,
caves, overhangs, arbitrary-gravity surfaces, automatic navigation and infinite
worlds remain separate work. A diagnostic that reports navigation as unsupported
is intentional.

Additional generators can produce the public recipe format. Continue measuring
rendering, native simulation and memory with the game's actual roster, density,
weapons and movement. New surface backends and automatic mesh metadata
extraction are separate extensions; reusable mod contributions and all base
redesigns should use the shared host and the same inspection workflow.
