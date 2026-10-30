# Procedural planets

The planet adapter streams a cube-sphere hierarchy from six coarse root patches
to local terrain. It reuses the shared generation-map format: continents, hills
and mountain fields sample planet-centred 3D metre coordinates. Changing patch
detail does not reroll the world or require a scene change.

Run the Planet Flight Lab for an Earth-scale orbit → surface → orbit route. Its
viewport stays active while detail arrives. The lab measures actual callback
intervals, CPU update/submission times, triangles and bounded streaming state;
these measurements are not physical display FPS or GPU completion timings.
The optional [atmosphere and cloud generator](planet-sky.md) adds bounded volume
rendering, stable weather recipes and realistic/pixel styles to that same scene.

## Host integration

```ts
import {compilePlanet,createPlanetRecipe}
  from '@patchgames/engine/shared/planet';
import {PlanetView} from '@patchgames/engine/sandbox/planetView';
import {createPlanetPreparationSource}
  from '@patchgames/engine/client/planetPreparation';

const recipe=createPlanetRecipe(412,6_371_000);
const planet=compilePlanet(recipe);
const view=new PlanetView(planet,createPlanetPreparationSource(recipe));
scene.add(view.root);

// Absolute camera coordinates stay in JavaScript doubles. Other scene content
// must use this same origin; the Three.js camera is at local [0,0,0].
view.update({position:absoluteCamera,origin:absoluteCamera,
  viewportHeight:canvas.height,fovDegrees:camera.fov});
```

The preparation source owns a dedicated module worker. The host bundler must
support the worker entry; do not move generation into a frame callback when a
worker is unavailable. Dispose the view when replacing a recipe or closing the
scene, including its worker and prepared resources. A custom asynchronous patch
source can provide the same preparation interface in another host.

Six roots provide initial globe coverage; refinement retains a parent until its
four children are prepared and installed. Rapid movement may temporarily show
coarser terrain while bounded work catches up. Uninterrupted coverage does not
promise the finest detail at arbitrary travel speeds. Patch, request, installation
and byte budgets remain active. Inspect streaming counters when a desired detail
target exceeds those budgets.

The default view allows 192 desired leaf patches, 768 resident patch records,
two outstanding preparation requests, and at most two installation attempts per
update. The module worker computes one patch at a time; cancellation does not
build a hidden backlog of obsolete jobs. The default 64 MiB resident byte limit
counts installed vertex/index buffer payloads. `preparedBytes` reports waiting
payloads separately; neither counter is a total CPU/GPU memory measurement.
`selectedPatches` counts the desired leaf frontier; `neededPatches` also includes
its fallback ancestors. A `budgetLimited` result keeps valid coarse coverage.

Recipes support radii from 1 km to 100 million metres, 4/8/16/32 grid segments
per patch, and up to 24 hierarchy levels. Declared height ranges and generation
sampling costs are bounded at compilation. `createPlanetRecipe(seed,radius)`
sets both identity and shared-field seeds; when editing an explicit graph,
`surface.maps.seed` controls its spatial randomness.

## Precision and seams

Keep planet coordinates and patch origins as doubles. GPU geometry uses small
Float32 positions relative to each patch, and every frame places patches relative
to the shared camera origin. The lab uses logarithmic depth buffering; merely
increasing a conventional camera far plane does not solve surface depth precision.

Equal-detail neighbors sample the same global field. Conservative inward radial
skirts cover visual gaps across different patch depths. Skirts are visual seam
coverage, not a watertight collision surface. Detail demand follows projected
terrain-cell footprint with a strict frontier budget; it is not a certified error
bound for every possible procedural height graph.

## Surface authority and scope

`planet.sample(direction)` returns deterministic surface height, absolute position,
normal and color. `view.displayedSurface(direction)` can inspect the currently
visible terrain triangles; their coarse interpolation can differ from the full
procedural field. The flight demo uses the higher surface for camera clearance
and reports the extra clearance separately. After an upload changes that surface,
`view.rebase(origin)` moves presentation without a second scheduling/upload pass.
These display queries are not authoritative physics. Terrain colors indicate
regions; they are not a water simulation.

Existing flat `TerrainWorld` physics, controllers and streaming interests assume
global +Y up. They cannot be reused by bending a rendered terrain mesh into a
sphere. Walking, radial gravity, multiplayer collision, buildings, foliage and
water need explicit local tangent-frame adapters and their own residency budgets.
The current adapter establishes continuous visual terrain streaming and radial
surface queries; it does not automatically populate a planet with gameplay.
