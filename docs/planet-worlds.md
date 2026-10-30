# Textured, populated planets

The planet example combines the engine's deterministic generation maps, material
generator, foliage generator, building compiler, water waves and sky density
field. These are public engine APIs. No MCP service or PatchGames account is
required to run them.

Run `npm run demo:planet`, then choose the rendering backend and a destination in
the lab. The full integration is in `examples/planet-lab.ts`. Keep the tab in the
foreground when measuring a flight. Exported frame reports distinguish RAF
intervals, CPU submission and, where available, native GPU queue completion;
none of these alone is physical display FPS.

## Rendering backends

`PlanetSkyView` captures and composites a WebGL scene. `PlanetSkyWebGPUView` is
the native WebGPU counterpart: its ray march, depth rejection, lighting and
composite use WGSL/Three node materials. Both consume the same worker-prepared
`PlanetSkyBake` and seeded 3D density volumes, with realistic and pixel styles.
The native path requires `await renderer.init()` and a successful WebGPU adapter.
It reports an unavailable adapter instead of silently changing renderers.

Terrain, generated foliage, buildings and planetary water use supported native
Three materials and geometry. The water view uses `MeshPhysicalMaterial`, not a
WebGL-only shader callback. The sky must use the view that matches the renderer.
Call its `render(renderer, scene, camera, frame)` after updating the world.

## Shared coordinates and precision

Keep authoritative recipe/query coordinates as absolute metre doubles. Supply
the same absolute camera position and render origin to terrain, population,
water and sky. The rendered camera can then remain close to local zero. Rebasing
changes presentation offsets; it must never change generation identity, noise
coordinates, population placement or water wave phase.

`PlanetView` retains six coarse roots while asynchronous children prepare. It
publishes a complete replacement quartet together, retains fallback ancestors,
and bounds worker requests, resident geometry and per-frame installation.
`planet.sample(direction)` remains the deterministic source surface.
`view.displayedSurface(direction)` queries the current visual mesh, which may
still be coarse. The lab uses both values for visual flight clearance.

## Climate, terrain and materials

`createPlanetBiomeRecipe` and `compilePlanetBiomes` build shared static climate
maps. A biome sample contains elevation, slope, temperature, moisture, a forest
family, tree density, building suitability and linear terrain tint. Terrain and
population compile the same recipe rather than inventing separate random biome
decisions.

The biome palette includes ocean, beach, grassland, temperate forest, taiga,
tropical forest, desert, tundra and alpine terrain. It is a game climate model,
not atmospheric circulation or an erosion simulation.

`planetSurfaceMaterialRecipes` supplies editable material-generator recipes.
`preparePlanetSurface` prepares their colour, normal and roughness textures and
mips in a worker. `preparePlanetSurfacePatch` assigns biome material groups and
metre-scale UVs while terrain patches prepare. All patches share the same 4 m
texture period, including across a floating-origin change.

UV projection follows each triangle's dominant normal, avoiding polar pinching
and severe cliff stretching. Projection-axis and biome changes can have visible
triangle boundaries; this implementation does not claim seamless triplanar or
multi-biome shader blending. Procedural textures are regenerated from recipes,
not downloaded texture packs.

When source terrain cells exceed 32 m, the worker keeps indexed geometry and
uses averaged biome tint with one material per patch. Metre-scale texture detail
is introduced only in finer cells, avoiding hundreds of orbital material draws.

## Forests and buildings

`preparePlanetPopulation` prepares a bounded reusable bank in a worker: oak,
maple, birch, evergreen, pine, jungle and palm foliage, plus validated cottage and
lodge building recipes and generated building materials.
`createPreparedPlanetPopulation` turns that bank into shared presentation
resources. `createPlanetPopulationPreparationSource` prepares placement cells.

Construct `PlanetPopulationView({planet, biomes}, library, source, options)` and
update it with `(absoluteCameraPosition, renderOrigin, timeSeconds)`. Its fixed
placement cells are independent of terrain LOD, so refining a terrain tile does
not reroll or duplicate its trees and buildings. Instances align their local up
axis with radial up. Terrain height, slope, climate, spacing and dry land decide
placement; generated building diagnostics remain authoritative for their parts.

Defaults bound active cells, tree/building instances, cell uploads and nearby
wind animation. Generated foliage geometry LODs are selected from the prepared
bank. Tree positions and variants are seeded; this milestone reuses species
prototypes with placement variation rather than generating a new branch mesh
for every tree. Forest geometry is local detail; orbital forest appearance
comes from biome terrain tint. There is no global city/road planner here.

Dispose views when changing planets. The prepared population library supports
resource loans and releases its immutable prototypes after its last view is
disposed. Do not dispose borrowed prototype geometry or materials individually.

## Engine water on a sphere

`PlanetWaterView` places an actual ocean at
`planet.radius + planet.recipe.seaLevelMeters`. It uses `compileWater`, engine
weather profiles and the shared prepared water wave spectrum. It does not make
the ocean by colouring terrain below sea level.

```ts
import {PlanetWaterView, samplePlanetWater} from
  '@patchgames/engine/sandbox/planetWaterView';

const ocean = new PlanetWaterView(planet, {
  conditions: {windSpeed: 8, windDirection: .7},
  // Optional borrowed scene environment for physical reflections:
  envMap,
});
scene.add(ocean.root);

// In the frame update, before rendering:
ocean.update({position: absoluteCamera, origin: renderOrigin, timeSeconds});

// Same accepted displayed weather and wave phase:
const displayedWater = ocean.sample(direction);
// Independent deterministic query, useful for a custom gameplay adapter:
const sourceWater = samplePlanetWater(planet, direction, timeSeconds, {
  water: ocean.water,
});
```

The independent query uses the supplied conditions at the requested time. Pass
the same conditions to it when overriding the manifest's weather; `ocean.sample`
also includes the view's accepted smooth weather/phase clock. Samples report
`wet`, `depthMeters`, `heightMeters`, absolute `position`, radial surface
`normal`, `foam`, `roughness` and linear `color`.

Three smoothly weighted global projection charts share engine water waves, so
crossing cube faces, longitude seams or poles does not reset their phase. The
spherical surface normal includes the chart-weight derivatives. Cached source
terrain depth attenuates waves at shorelines and drives the engine's shallow
water/foam appearance. The foam edge distance is a depth-based approximation;
this is not a full coastal-distance field or breaking-wave simulation.

At close range, one closed spherical sheet has dense near rings and logarithmic
far rings sharing their boundaries. Waves fade outside the detailed region.
There are no overlapping near/far sheets. Two fixed geometry banks amortize
recentring and cache terrain queries, with a per-update vertex and time budget.
The initial/orbital sea-level proxy is replaced by the prepared near sheet
atomically. Sub-metre near geometry is stored relative to its own radial anchor
before the render origin is subtracted.

Defaults use 80 azimuth segments, 16 dense rings over 24 m, a 4× wave fade,
30 Hz wave updates, at most 512 prepared vertices and a 1.5 ms preparation
budget per update. Small planets clamp the default detail radius. Wave detail
is skipped when the camera is more than 1 km above sea level (or a larger
amplitude-scaled threshold); the distant sea remains a physical sea-level
proxy. Fast travel can outrun a preparing near bank; existing water coverage
remains, with reduced local wave detail until the bank is ready.

`inspection()` reports detail readiness/visibility, preparation budget and CPU
time, fixed topology counts, swaps, accepted wave updates and sea level.
`dispose()` releases owned geometry/materials once. An `envMap` is borrowed and
remains the caller's responsibility.

## Gameplay boundary

These modules provide deterministic sources and bounded visual streaming. They
do not automatically provide spherical character movement, gravity, networked
collision, navmeshes, building interiors/colliders or a planet-scale fluid
solver. `WaterWorld` and `WaterBody` remain local, gravity-aligned solvers for
interactive volumes and forces. A gameplay adapter must choose appropriate
local physics regions and synchronize them with its authoritative game state.

Far terrain and sea are geometric proxies. Their triangles approximate curved
surfaces and do not resolve metre-scale waves or terrain. Texture resolution,
material count, population budgets and sky sample quality still need to fit the
target device. Use the lab's retained reports and each view's inspection values
to assess a particular recipe and backend.
