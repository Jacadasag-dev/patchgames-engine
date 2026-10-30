# Circulation-driven planet weather

`shared/planetWeather.ts` is a deterministic art-direction system for planetary
cloud organization. It is not numerical weather prediction, a fluid solver,
or a model of ocean temperatures and currents. The sun and rotation system
supplies local solar direction; weather uses the same absolute planet frame.

```ts
import {compilePlanetWeather, createPlanetWeatherRecipe} from
  '@patchgames/engine/shared/planetWeather';

const weather = compilePlanetWeather(createPlanetWeatherRecipe(73), planet.radius, planet);
const bake = weather.bake(); // Trusted preparation worker, never an animation callback.
const frame = weather.frame(simulationTimeSeconds); // Bounded storm bank; no atlas work.
const sample = weather.sample(direction, simulationTimeSeconds, sunDirection);
```

The optional compiled terrain supplies elevation and coastlines. Its static
generation maps are sampled directly during preparation, avoiding the normal
and mesh work of terrain surface queries. Without terrain, the weather uses an
ocean planet. Supplying terrain also prevents tropical cyclone genesis over
land. Recipe and terrain revisions participate in the bake fingerprint.

## Organization and motion

The model uses an irregular, cellular ITCZ belt; suppressed subtropical cloud;
eastward midlatitude storm tracks; jet-aligned cirrus; and patchy polar low
cloud. NASA describes these global patterns as consequences of Hadley-cell
circulation and jet-stream meanders, rather than a uniform random cloud layer.
[NASA GISS: atmospheric circulation and clouds](https://www.giss.nasa.gov/research/briefs/2017_tselioudis_02/)

Tropical primitives start at least 7 degrees from the equator, initially move
west and poleward, then recurve east. Frontal primitives move east and supply
comma heads and trailing bands. Their local tangent frames make positive
rotation counterclockwise in the northern hemisphere and clockwise in the
southern hemisphere. A smooth lifetime envelope hides track resets. NOAA
describes the weak near-equatorial Coriolis force and the common westward and
recurving tropical tracks. The generated tracks are illustrative, not forecasts.
[NOAA: tropical cyclone climatology](https://www.nhc.noaa.gov/climo/),
[NOAA: mariner's guide](https://www.nhc.noaa.gov/marinersguide.pdf)

Land convection increases during local afternoon. Terrain gradients place lift
on windward slopes and suppression on the lee side. Coastal masks favor low
cellular decks west of subtropical land; small isolated land features seed
alternating curled wake masks downwind. These are coarse terrain-informed
patterns, not resolved ocean currents, island aerodynamics, or storm dynamics.
NOAA describes the open- and closed-cell forms of low marine stratocumulus.
[NOAA: marine stratocumulus](https://www.nesdis.noaa.gov/our-environment/clouds/marine-stratocumulus-clouds)

## Coverage and resources

The default target is 0.67. The fixed field response is calibrated for Earth-like
regimes; it does not run a hidden whole-globe calibration when a point is queried.
Each bake reports its actual area-weighted static occupancy under the explicit
test `max(low, cumulus, cirrus) > 0.5`. Standard seed checks fall between 65 and
70 percent. NASA reports approximately 67 percent typical Earth cloud cover,
but that observed optical quantity is not identical to this artistic mask metric.
[NASA: cloudy Earth](https://www.nasa.gov/image-article/cloudy-earth/)

Two RGBA atlases are prepared at 512 by 256 by default: 1 MiB total. The
256 by 128 option uses 256 KiB. Macro noise is band-limited to the atlas Nyquist
limit including its highest octave, and mask transitions retain a broad soft
shoulder. Fine puffs remain in the three-dimensional volume. Coastal open/closed
cell detail uses a bounded analytic nine-neighbor cellular field in both shaders
and the CPU reference; it is not point-baked into an undersampled atlas.
Longitude wraps; polar rows use the same bounded
quadrature in CPU queries and preparation. Coverage stores low/cumulus/cirrus/land;
environment stores elevation/windward/rain-shadow/coastal-wake fields. Texture
filters use linear sampling and explicit LOD zero inside volume loops.

`sample()` reads only the required quantized lattice cells, with bounded caches;
it never bakes an atlas. `frame()` updates at most 16 cyclone primitives. Both
shader backends use the exported matching field helpers, with an early angular
rejection for distant cyclones. Cloud microstructure, altitude profiles, lighting,
shadows and optical integration belong to the sky renderer.

`timeSeconds` is physical simulation time. A host may accelerate its clock;
`timeScale` can further scale weather motion. Native and WebGL renderers pack the
same two-vector cyclone records. Their weather advection uniform uses
`frame.timeDays * 6371000 / radiusMeters` so physical wind speed remains consistent
on small planets; storm centers and phases already come from the physical frame.
