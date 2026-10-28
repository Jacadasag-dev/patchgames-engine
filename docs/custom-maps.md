# Custom maps and static architecture

`mapAssembly.ts` compiles exact, editable map components. `mapAssemblyView.ts` renders the same geometry. It complements the existing building, fixture, world-planning and terrain-volume tools; procedural variation is optional.

Discover this workflow with `get_creation_catalog({query:'custom map'})` and `get_authoring_guide({topic:'custom-maps'})`. A connector with an older cached topic enum can use the `buildings` guide, then read the named map-assembly API references directly.

## Supported geometry and ownership

Version 1 covers static boxes and gables with stable IDs, geometric face connections, scoped support checks, owned floor regions and required sign approaches. Box geometry is centred. Gables have their bottom at local Y=0, a ridge along local Z, and an authored rise/thickness. Coordinates use metres, Y up, +Z front and yaw in radians. There is no scale transform; edit dimensions and recompile.

Compose posts and beams for gateways. Existing `compileBuilding` supplies enterable orthogonal buildings, fitted roof enclosures, doors and stairs. `compileTerrainVolumes` supplies exact piecewise-planar solid terrain, including holes and undersides. Neither compiler is a general CAD system. Declare external/imported geometry explicitly when it is outside assembly coverage; an unchecked mesh cannot inherit surrounding components' passing status.

Keep the recipe in one shared layout module. `defineMapAssembly(id,()=>recipe)` lets the build precompile it. `compileMapAssembly(recipe)` is the explicit editor/test path. Compile on source/configuration changes, never each tick or frame. Install the resulting `scene` through the base's physics provider and give that same manifest to `MapAssemblyView`. Creating a visual object alone does not install collision.

## Connections represent real surfaces

Each part chooses either absolute `position`/`yaw` or a `mount`. A mount identifies the parent part and face, its own mating face, and optional face-local offsets. Parent-relative placement derives from actual geometry; it has no arbitrary gap parameter.

Box faces are `top`, `bottom`, `front`, `back`, `left` and `right`. Gables expose `bottom`, `front`, `back`, `slope-left` and `slope-right`. The compiler resolves placement order and rejects missing/cyclic references and incompatible joins. A wall edit therefore recomputes its mounted fixture instead of leaving stale world coordinates.

Explicit `connections` link two face references, with `kind:'mate'|'bearing'`. An optional face-local region selects the actual bearing patch. `minCoverage` describes the required overlap of that patch. Diagnostics report separation, penetration, alignment and coverage, with component IDs and recipe paths.

A roof design should declare its bearing regions on intended walls, beams or posts. Parts accept `bearingRegions:[{face,region}]`; roof parts (including flat boxes) and gable shapes default to two distributed underside strips. An accidental corner intersection is insufficient design intent. A suspended lantern needs a real bracket or chain whose endpoints connect. Choose a `floor` or `terrain` foundation to terminate the support graph. A `support:'decorative'` exemption is explicit and remains inspectable; it does not exempt winding or surface conflicts. These rules verify geometric support, not engineering loads or structural safety.

## A small connected example

```ts
import {defineMapAssembly} from '../sandbox/mapAssembly.ts';

export const map = defineMapAssembly('entry-court', () => ({
  version: 1,
  id: 'entry-court',
  parts: [
    {
      id: 'court', role: 'floor', support: 'foundation',
      shape: {kind:'box', size:{x:8,y:.4,z:8}},
      position: {x:0,y:-.2,z:0}, color: '#b9ac8b',
    },
    {
      id: 'entry-wall', role: 'wall',
      shape: {kind:'box', size:{x:4,y:3,z:.3}},
      mount: {part:'court',face:'top',ownFace:'bottom'},
      color: '#d6bf93',
    },
    {
      id: 'site-sign', role: 'sign',
      shape: {kind:'box',size:{x:1.2,y:.6,z:.05}},
      mount: {part:'entry-wall',face:'front',ownFace:'back'},
      color: '#173d3b',
    },
  ],
  signs: [{
    part:'site-sign', text:'A',
    approaches:[{id:'entry',position:{x:0,y:1.6,z:3},minPixelHeight:40}],
  }],
  views:[{
    id:'entry-view',kind:'sign',
    position:{x:0,y:1.6,z:3},target:{x:0,y:1.5,z:0},
  }],
}));

if (!map.diagnostics.valid) throw new Error(JSON.stringify(map.diagnostics.issues));
```

Adjust imports to the game file location. `new MapAssemblyView(map)` exposes `root`, `readyMaterials()`, `inspection()` and `dispose()`. Add the root to the existing scene, expose inspection results through the game view, and dispose resources on teardown. Use the shared materials guide for texture recipes. Keep regular front-face rendering when judging roofs; making a solid double-sided is not a repair for reversed triangles.

## Floors and signs

Use `mapFloorRegions({id,regions,y?,thickness?,foundation?})` for overlapping authored XZ regions. `y` is the walking-surface elevation and defaults to0; thickness defaults to0.12m. A region supplies `id,x0,x1,z0,z1,priority` and optional `color`/`material`. The helper partitions coverage into disjoint tiles. Higher priority owns overlapping finish; conflicting equal-priority owners fail. Keep different storeys distinct and use explicit material regions instead of layering duplicate floor geometry. Map validation also checks near-coplanar exposed surfaces across components. Tiny Y offsets do not resolve ownership.

Signs reference box parts and display text on the front face. Declare required approach points at actual eye heights and optional minimum visible fraction, pixel height, viewport height and field of view. These checks are scoped to those approaches. Review actual glyph rendering and normal player views as well as geometric results. A temporary player obstruction is different from a permanently obscuring crate or trim beam.

## Evidence and repairs

Read `diagnostics.valid` and the separate coverage entries for `geometry`, `connections`, `support`, `surfaces`, `readability`, `rendering` and `traversal`. Each entry is `passed`, `failed`, `incomplete` or `notApplicable`. `defineMapAssembly` rejects failed/incomplete compiler checks; use `compileMapAssembly` to inspect a broken draft. Passing compiler checks do not establish rendered appearance, navigation or live performance.

Use `mapAssemblyInspection(manifest,{offset?,limit?})` to page diagnostic details. Retain total and omitted issue counts; exhausted work budgets or unsupported components are not clean results. Fix the named source relationship or geometry. Do not silently delete requested components, move gameplay cover, increase every tolerance or mark structural pieces decorative merely to obtain a pass.

Evidence belongs to the compiled revision and exact saved game source. After resizing a wall, rotating an assembly, changing a roof or placing cover near a sign, rerun affected checks and views. An arbitrary renderer override or runtime geometry mutation requires new evidence; earlier passing geometry does not validate the replacement.

The `views` array is an authored inspection inventory, not proof that inspection ran. Cover all required roof exteriors, fixture connections, sign approaches, surface boundaries, doorways and vertical routes. Execute bounded `inspect_game` batches against the pinned revision. Ordinary `review_change` executes at most three scenarios, so show any remaining inventory. Keep normal materials/culling enabled for appearance; diagnostic overlays are supplementary.

Exercise traversal separately through legal controls with the actual actor dimensions. Staged inspection cameras do not prove that players can reach a location. Measure real client frame intervals, including entering new areas and interacting with the map. Compiler timing and offline rendering are not production FPS.

Camera clearance is authored separately: installing a map does not add an automatic gameplay obstacle solver. Find the selected game's actual camera policy; the blank starter's chase camera does not avoid newly added scenery. `InspectionFocusController` only adjusts inspection framing, and `PlayerAppearanceHost.withHiddenFromCamera` only masks a body for one camera while preserving shadows. Test normal gameplay routes, doorway and corner turns, near-plane edges and recovery from starting inside geometry. A center ray alone does not establish camera-volume clearance. Review ordinary gameplay images and obstruction measurements without automatic focus; these measurements identify nearby geometry, not a universal clipping verdict.

## Acceptance cases

Keep both failing and valid counterparts: detached roof/supported pavilion, floating lantern/connected suspension, duplicate floor/material region, and obscured sign/readable required approach. Mutate a passing assembly by moving, resizing or removing its parent and ensure current diagnostics reflect the new revision. Check exterior roof faces, matching physics contacts, missing assets, unknown external geometry and exhausted budgets. A fresh customer-connector trial should discover the guide, author a small assembly and correct an intentional defect without repository-only tools or hidden handholding.

The local engine workshop is `tests/visual/custom-map.html`, served by the existing `tests/visual/city-workshop.config.ts` development configuration. It uses `tests/fixtures/custom-map/recipe.ts` and offers a valid courtyard plus detached roof/lamp, blocked sign, duplicate floor and reversed-renderer cases. Review ordinary exterior cameras and the compiler/renderer reports, then replay the native-controller route through the gate and up/down the stairs. Manual WASD/drag-look inspection supplements that route. Running the workshop or passing its tests alone does not establish that its screenshots have been visually reviewed.
