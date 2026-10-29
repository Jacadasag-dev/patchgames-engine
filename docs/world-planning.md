# Terrain-aware world planning

The world planner composes authored terrain, roads, building recipes and asset manifests into one editable spatial plan. It is a general authoring API: the AI chooses the world's purpose, composition, routes, elevations, materials, landmarks and individual structures. A demonstration town or hillside scene is not a required style or the only entrypoint.

- `src/sandbox/worldPlan.ts`: compile an authored plan, create its shared terrain host and inspect diagnostics.
- `src/sandbox/worldRoads.ts`: road planning over authored terrain and road-grade diagnostics.
- `src/sandbox/worldPlanView.ts`: render the compiled plan using the accepted terrain snapshot.
- `src/sandbox/terrain.ts`, `building.ts` and `assetFamilies.ts`: the underlying editable terrain, structural and prop contracts.

## Author the design

Choose site locations, structure recipes and routes as source data. Keep stable semantic IDs and explicit seeds so a local edit can preserve unrelated objects. Supply original building layouts and custom asset families when the design calls for them; [building recipes](procedural-buildings.md) and [parametric assets](parametric-assets.md) remain ordinary inputs. Preserve the source plan and overrides, rather than treating the compiled manifest as the only editable result.

Terrain height and road grade are physical design choices. Specify the intended relationship between a site, its foundation and its entrance, then review the planner's diagnostics. A road that connects two points can still be too steep, cut too deeply into a hill or meet a doorway at the wrong level. Fix the authored route or site constraints when validation reports a problem. Do not silently remove requested structures or reduce the task to a named preset.

Compile at source/configuration changes, not each tick or frame. Reuse the compiled plan for logic and rendering. Seeds support reproducibility; meaningful variety comes from authored purpose, layout, dimensions, construction, details and relationships.

Generated world coordinates are stored at `1e-7m` precision before geometry and revision calculation, keeping sandbox and browser results consistent. Automatic road search compares integer distance costs. Original recipe data remains available for editing.

For example, this shared game module authors a workshop and a garden on a sampled hill summit. It uses the same APIs as a larger or differently styled world:

```ts
import { createPlannedWorld, defineWorldPlan, type WorldPlanRecipe } from '../sandbox/worldPlan.ts';

export const recipe: WorldPlanRecipe = {
  version: 1, id: 'workshop-garden', seed: 41,
  terrain: {
    version: 1, seed: 41, bounds: { width: 64, depth: 64 }, assets: [],
    regions: [{ id: 'garden-hill',
      mask: { kind: 'circle', center: { x: 12, z: 0 }, radius: 9 },
      elevation: 1.5, blend: 12, layers: [] }],
  },
  sites: [
    { id: 'workshop', placement: { kind: 'position', x: -12, z: 0 },
      building: {
        version: 1, id: 'workshop-plan', width: 6, depth: 6,
        roof: { kind: 'gable', rise: 1.5 },
        floors: [{ id: 'ground', y: 0, height: 3,
          rooms: [{ id: 'ground-main', x: 0, z: 0, width: 6, depth: 6 }],
          openings: [{ id: 'entry', room: 'ground-main', side: 'east',
            kind: 'door', width: 1.6, height: 2.3 }] }],
      },
      entrance: { roadId: 'garden-path', portalId: 'entry' } },
    { id: 'garden', placement: { kind: 'summit', regionId: 'garden-hill', spacing: 1 },
      footprint: { kind: 'circle', radius: 3 },
      entrance: { roadId: 'garden-path', side: 'west' } },
  ],
  roads: [{ id: 'garden-path', from: { site: 'workshop' }, to: { site: 'garden' },
    width: 2, grade: { maxSlope: 0.3, maxCutFill: 2 } }],
};
export const plan = defineWorldPlan('workshop-garden', () => recipe);
if (!plan.diagnostics.valid) throw new Error(JSON.stringify(plan.diagnostics.issues));
export const terrainWorld = createPlannedWorld<Record<string, number>>(plan);
```

Declare module-level plans with `defineWorldPlan(id, build)`. The trusted game
build runs `build` and the compiler once and embeds the compiled manifest in the
logic bundle, so loading a match reads that data instead of generating the
recipe and compiling it inside the 1 s sandbox load budget. On a 2 GHz release
host, the example town in `tests/fixtures/world-plan-game` otherwise used more
than the whole budget. `build` must depend only on its own code, never on tuning
or match data, and `id` must equal the recipe's ID; each ID may be defined once.
Compiled plans may use up to 6 MiB of the bundle beside its 2 MiB of code.
Developer tools and views that load a bundle without that data compile it as
before. Use `compileWorldPlan(recipe, previous)` for plans built or edited at
runtime.

Place this module under `src/game` for the import path shown. An open site's `footprint` reserves its pad; a building site derives its footprint from its building. Site placement supplies the building ID, origin and yaw, preserving its authored floor plan. `foundation.height` is the pad elevation, and the lowest building floor sits 2cm above it. Read resolved positions from the manifest. Summit placement is a bounded sampled search for a fitting location, not an exact global maximum.

Site `orientation:{face:{road:'main-road'}}` aligns the building's primary entrance with the adjacent authored road waypoint. Targets may also be `{site:'plaza'}` or `{x:12,z:8}`, with an optional radian `offset`. Explicit site or building `yaw` overrides this policy. Declare `building.primaryEntrance` to identify the public front door; a site `entrance.portalId` can deliberately select another door. The entire footprint, rooms, geometry and collision rotate before foundations and road approaches are generated. Missing targets or unresolved dependencies are diagnostics rather than silent zero rotations.

Public entry semantics continue through the adapters: `compileCity` requires a
clear street approach to a declared `primaryEntrance`; a clear service door is
not a substitute. A world site uses its explicit `entrance.portalId`, then the
building's `primaryEntrance`. Keep that choice aligned with public/circulation
rooms and the intended visitor route, and inspect actual doorway traversal.

The planner preserves authored room geometry. Use `partitionBuildingFloor` from `buildingLayout.ts` for variable room sizes within a reusable family, then furnish that resolved floor. Room access and directional furnishing rules are described in [building layouts](procedural-buildings.md) and [parametric assets](parametric-assets.md).

Optional `props` accept custom `AssetManifest` models. A `siteId` makes the prop's position and yaw local to that site's floor origin; otherwise they are world coordinates and omitted Y samples ground. For a building site, declare `attachment: {surface:'roof'}` or `{surface:'ceiling',floorId:'ground',gap:.02}` and omit position Y; `floor` is also supported with a floor ID. The resolver checks the whole rotated model footprint against compiled surfaces, rejects missing coverage, and aligns the real model base or top. Roof attachment uses the lowest exposed roof height so pitched roofs intersect the base without floating downhill edges; ceiling attachment uses the actual slab underside, including stair holes. Nonnegative `gap` deliberately separates surfaces. Curved-part footprints are conservative, and attachment does not prove clearance from unrelated objects. Free placements keep their authored Y. Keep selected model geometry and compound collision together. `assetGroupModel` can supply arranged props from arbitrary tagged sockets; preserve its `originOffset` when keeping an authored parent anchor. The same family manifests also work in terrain through `terrainModelAsset`/`terrainFamilyAssets`.

`compileWorldPlan(recipe, previous)` retains unchanged building manifests.
`changes` keeps its building-only meaning. The additional `entityChanges` reports
resolved sites, roads and props under `site:<id>`, `road:<id>` and `prop:<id>` keys;
roads include generated access links. `worldPlanInspection` includes both reports.
An interior geometry edit can change a building without changing the resolved
site footprint, so read both. Neither report is a complete terrain-cell diff.

Ground-level props must have actual terrain support within 12cm of their floor origin at the footprint centre and corners. Compilation can succeed before preparation detects unsupported sloped ground; reserve a level site for such props. Explicit elevated placements preserve their authored height and skip automatic grounding. Attaching a prop to its own site still requires its compound collision to leave reserved roads and doorway approaches clear.

Freestanding ground props reserve scatter space through `terrain.reservations`
without replacing compound collision with a solid footprint. These masks do not
grade ground or block travel routes. A clear arch can span a road; an obstructing
part is rejected by the separate compound-clearance checks. Scatter reservations
are excluded from `plan.roads` and are not proof of traversability.

## Plan and preserve roads

`planWorldRoad(terrain, request)` accepts an ID, `from`/`to` points, width, optional shoulder/clearance, grade limits, search settings and reserved circle or oriented-box footprints. Points have X/Z and optional Y. `grade.maxSlope` is rise divided by horizontal run; `grade.maxCutFill` limits the difference from the analytic base across the full road width. Exact grading requires strength 1.

Omit `via` to allow a bounded grid search around the direct route. Supply `via`, including `[]`, to preserve your authored route: an invalid route returns diagnostics instead of silently rerouting it. Check `result.diagnostics.valid` and the optional `result.route` before adding the route to terrain. Search failure or exhaustion means revise the constraints/window or author waypoints; it is not proof that no possible road exists.

`sampleTerrainBaseHeight(terrain, x, z)` returns the analytic base elevation before road grading and foundations. For many planning samples, create one `createTerrainBaseHeightSampler(terrain)` and call it repeatedly; recreate it after source edits. Neither helper reads the final collision triangles. Final terrain diagnostics and ordinary traversal remain necessary.

## Integrate the compiled world

Use `createPlannedWorld(plan, options?)` for the shared terrain host exposed by logic and view. Optional `TerrainWorldOptions` configure preparation interests and host integration. Compilation checks metadata and sparse ideal-ground samples; worker preparation checks actual pad, doorway and road triangles before accepting each neighborhood. Unprepared chunks remain unvalidated. The base must install its accepted snapshot's physics scene and keep prediction on the same world revision. Rendering alone does not install collision or grant a feature access to a base integration point.

Create `new WorldPlanView(plan, snapshot, options)`, add its `root` to the scene, then call `update(snapshot, focus)` with the accepted terrain snapshot and the current world-space focus. The view composes terrain, buildings and the plan's model props. `setCutaway` delegates to the building view for floor review. Call `inspection()` for view observations and `dispose()` at teardown. The optional `terrain` and `buildings` settings retain custom terrain asset factories and building part factories.

Keep physical coverage separate from visual interior selection. A culled room must still have collision when a player occupies it. Custom visual overrides must retain matching physical geometry.

The terrain host may retain unaffected prepared CPU chunks after conservative
local edits. Old/new edit bounds, footprint reach and terrain blends constrain
reuse; global or unrecognized dependencies rebuild. A new recipe remains pending
until its required chunks are ready, and physics installation remains atomic.
Inspect `streaming.reused` alongside readiness and revision checks rather than
assuming all edits avoid regeneration. See [terrain authoring](procedural-terrain.md)
for family placement, scatter-only reservations and exact reuse limits.

## Fit a building family to a hillside

Existing rectangular plans without `foundation.mode` or terrain-driven room levels retain their level-pad behavior. Compound footprints and lowered rooms receive matching cut pads. Explicit policies express a family's preferred construction:

```ts
foundation: { mode: 'auto', prefer: 'crawlspace', clearance: .6,
  maxClearance: 4, maxCutFill: 3, blend: 6 }
```

`cut` fits a horizontal excavated base into the slope. `crawlspace` raises the building above the sampled terrain and generates visible supports with matching collision while retaining the grade underneath. `auto` chooses a feasible policy, trying the declared preference first. `height` remains an explicit override; clearance and cut/fill limits constrain the fit. Roof, walls and floor remain upright and level. Resolved foundation diagnostics expose the chosen mode and sampled terrain fit; impossible limits fail instead of burying rooms or leaving an unsupported shell.

Compound footprints use their occupied union for foundation geometry. Cut foundations grade the ground; crawl-space entrances use visible ramps with native collision, joining roads at the natural ground height. `createPlannedWorld` validates actual prepared triangles, so a mathematically valid plan can still need a wider blend or a longer approach at the chosen terrain resolution.

Optionally set `roomLevels:{step:.18,maxRise:.54,maxDrop:.36,rooms:['dining','pantry']}` on a site. Selected rooms on the ground storey sample terrain before foundation edits, then receive bounded, quantized elevations. Exterior-door rooms remain at the reference level. The building compiler generates internal steps/ramps, keeps ceilings consistent, and checks headroom and landings. Furniture height follows its room; furniture that obstructs a newly generated transition still fails validation. Reserve the possible transition run when furnishing a family before terrain fitting, or author the levels before furnishing.

Keep the source family parameters and policy editable. A reusable house generator can return its building recipe together with `foundation:{mode:'auto',prefer:'crawlspace',...}`; each site resolves that family preference against its own terrain. These bounded orthogonal foundations do not add arbitrary basement caves, tunnels or retaining-wall engineering.

## Inspect the actual game

Read `worldPlanInspection` and compiler diagnostics, then inspect the actual authored game. Compare an exterior overview with floor cutaways and player-height views. Exercise ordinary inputs uphill and downhill, through road joins, across foundation transitions and into buildings using the intended actor dimensions and controller. Replay the same seed, route and settings after edits.

Planning diagnostics describe bounded checks; they do not prove universal player or NPC navigation. Heightfield terrain does not express arbitrary caves or overhangs, and a road plan does not automatically provide bridges or tunnels. Specialized structures and gameplay remain authored work using matching geometry and collision.

## Run the example

Run `npm run dev:world-plan` to open the workshop on port 5177 at `/tests/visual/world-plan-workshop.html`. Choose a place to inspect its exterior or floor plan, then use **Walk inside** for ordinary movement. The two-hill world is an editable example in `tests/fixtures/world-plan-game/recipe.ts`; its castle, church, manor, houses and park do not define a fixed vocabulary for the planner.

Run `npm run verify:world-plan` to build the fixture's normal sandbox logic/view and render the inspection cases. `scripts/verify-world-plan.ts` covers overviews, selected building exteriors, floor cutaways and ordinary entrance/exit walks. Reports and images are saved under `tests/.tmp/world-plan-inspection`. A focused case can be run with `npm run verify:world-plan -- --case castle-walk`. These bounded cases do not establish every route, controller or possible world design.
