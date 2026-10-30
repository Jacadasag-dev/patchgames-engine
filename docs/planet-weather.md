# Coupled planetary weather

`shared/planetWeather.ts` is a deterministic, physically inspired procedural
weather model. Pressure, moisture, temperature and wind produce a shared
condensation field for every cloud layer. It supplies coherent generated weather
for a renderer, rather than forecasts or a numerical atmosphere simulation.

```ts
import {compilePlanetWeather, createPlanetWeatherRecipe} from
  '@patchgames/engine/shared/planetWeather';

const weather = compilePlanetWeather(createPlanetWeatherRecipe(73), planet.radius, planet);
const frame = weather.frame(simulationTimeSeconds);
const sample = weather.sample(direction, simulationTimeSeconds, sunDirection);
const bake = weather.bake(); // Prepare on a worker, outside animation callbacks.
```

## Physical relationships

The static climate fields contain humidity, pressure anomaly, thermal contrast
and land convection intensity. Broad latitude regimes favor moist tropical
convergence, dry subtropical highs, midlatitude disturbances and polar low cloud.
Terrain contributes signed east/west and north/south height gradients, elevation
and coastal structure. The gradients dotted with the actual local wind determine
windward ascent and lee drying; no terrain ascent remains when wind is zero.

Wind balances the local pressure-gradient force against linear surface friction
and latitude-dependent Coriolis acceleration. The diagnostic balance uses air
density 1.2 kg/m³, a four-hour friction time, a 40 hPa anomaly scale, the planet's
physical radius and its rotation period. Wind is capped at 100 m/s. Low-pressure
flow turns counterclockwise in the north and clockwise in the south, while drag
allows inward flow. These relationships follow NOAA's description of
[pressure-gradient, Coriolis and friction forces](https://www.noaa.gov/jetstream/synoptic/origin-of-wind).
The coefficients and the pressure seeds are procedural choices.

A spherical backward characteristic carries humidity, thermal structure and the
renderer’s material coordinates along the same solved tangent wind. It uses
physical elapsed seconds plus a bounded parcel lookback. This is a frozen local
velocity approximation: the model does not integrate a persistent fluid grid or
conserve global water, momentum or energy. Its background pressure field is a
prescribed climate reservoir; moving low-pressure seeds evolve that pressure.
There is no additional independent zonal displacement of cloud material.

Warm and cold fronts come from the gradient of the transported thermal field
and the wind’s direction across it. Frontal ascent changes saturation and the
relative weights of convective, low layered and high cloud. Cold frontal ascent
favors cumulus; warm frontal ascent favors broader low/high layers. Humid air
must still reach the condensation threshold. This approximates the different
lifting geometries described by NOAA for
[air masses and fronts](https://www.noaa.gov/jetstream/synoptic/air-masses).

Afternoon land heating, terrain ascent, low-pressure convergence and frontal
ascent all feed the same saturation score. Temperature and positive pressure
anomalies modify the moisture required for condensation. NOAA explains that
[rising, cooling moist air reaching saturation forms clouds](https://www.noaa.gov/jetstream/clouds/how-clouds-form).
The exposed relative humidity and temperature are diagnostic proxies, not a
thermodynamic equation of state or resolved vertical soundings.

## Cyclones and cloud support

The bounded cyclone bank seeds pressure lows with smooth birth, maturation and
dissipation. Tropical genesis requires ocean, moist generated air, warm generated
air and a latitude at least seven degrees from the equator. Initial tracks move
west and poleward before recurving. Frontal lows move through midlatitudes.
Their pressure gradients enter the same wind balance and their ascent enters
the same condensation calculation as all other weather. Tropical eye subsidence
dries the central air; annular ascent favors an eyewall. The transported
moisture and volume texture deform in the resulting circulation. These are
seeded procedural systems, not dynamically predicted hurricane genesis.
NOAA describes the physical
[eyewall ascent and eye subsidence](https://www.noaa.gov/jetstream/tropical/tropical-cyclone-introduction/tropical-cyclone-structure).

A single horizontal `support` gates every cloud layer. It is exactly zero
outside condensation support, including when moisture is zero. The renderer
applies that gate before microstructure and every distance-dependent density
path. Fine noise can shape an existing cloud but cannot create an isolated cloud
in a clear column. Cloud growth, evaporation and deformation follow changing
transport, thermal/front lift, low lifecycles and sunlight. Orbit and near views
sample the same underlying volumes; sampling detail changes with distance.

## Calibration, controls and resources

The default occupied-column target is 0.67. Compilation ranks the final
condensation score at 512 fixed equal-area probes at time zero with sun direction
`[1,0,0]`. A bounded cache keyed by weather parameters and the actual terrain
revision reuses this calibration. Optical rendering edits do not change that
key. Moisture and pressure-strength controls share the reference threshold for
moisture=1 and pressureStrength=1, so those controls can change condensation
instead of being normalized away. Zero moisture removes every cloud while
pressure-driven winds remain; zero pressure strength removes that flow.

Each bake reports the actual area-weighted fraction of occupied columns after
terrain, sunlight, fronts, moisture and pressure forcing, using `support > 0`.
Normal reference seeds occupy 65–70 percent. This is a generative support metric;
rendered optical cloud fraction also depends on density and viewing geometry.
Dynamic weather can change the occupied fraction. NASA's observed approximately
67 percent [Earth cloud cover](https://www.nasa.gov/image-article/cloudy-earth/)
is the visual reference, rather than a claim of equivalent measurements.

Two RGBA8 atlases at 512 × 256 use 1 MiB combined; resolution 128 uses 64 KiB.
The first stores humidity / encoded pressure anomaly / thermal contrast /
land-convection intensity. The second stores elevation / encoded signed east
slope / encoded signed north slope / coast and wake structure. Pressure and
signed slopes encode exact neutrality as 128/255. Slope channels replace the
previous preselected windward and rain-shadow masks. Macro noise is band-limited
to the atlas, with rotated, weakly warped octave domains. Fine cloud detail stays
in the volume. Coastal cell detail uses a bounded nine-neighbor analytic field.
Longitude wraps and polar rows use a fixed eight-longitude quadrature.

`sample()` reads only its required quantized lattice cells with bounded caches;
it never prepares a whole atlas. Calibration happens during compilation, never
on individual queries. `frame()` updates at most 16 low-pressure records.
`bake()` prepares and measures the atlases once and returns independent copies.
Terrain graph cost and resolution are bounded before preparation. CPU sampling,
GLSL and WGSL share the same quantized-field equations, angular storm rejection,
pressure/rotation balance, material mapping and exact support gate. Texture reads
inside ray loops use explicit level zero.

`timeSeconds` is physical simulation time; `timeScale` scales weather motion.
`frame.timeDays` remains raw physical weather days. Physical displacement uses
`wind * seconds / radiusMeters`. `rotationPeriodSeconds` accepts 10 through
1e9 seconds, defaults to 86400, and supplies Coriolis strength. A compiled sky
always uses its celestial day length as the planet's rotation period. A standalone
weather caller supplies its own rotation period.

GPU calculations use float32. Extremely large accelerated clocks, particularly
on small planets, can lose angular and texture-coordinate precision. The local
frozen-velocity characteristic also stretches tracer patterns over long runs;
long-lived, conserved atmospheric dynamics require a persistent simulation.
