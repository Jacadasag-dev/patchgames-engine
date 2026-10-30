# Persistent planet atmosphere

`createPlanetAtmosphere` runs a small, persistent, two-layer rotating atmosphere
in a preparation worker. Clouds are a result of transported water, cooling and
condensation. There is no requested cloud percentage, storm count, cyclone path
or time-indexed noise field in this solver. `sample()` reads the current state;
moving a camera or requesting more samples does not generate more weather.

This is a reduced model for interactive terrestrial worlds, including dry,
thin carbon-dioxide atmospheres and wetter, thicker alien atmospheres. It is
not a scientific climate forecast or a high-resolution hurricane model.

## Physical inputs

Use `compilePlanetGenerator()` to resolve a recipe into terrain, water extent,
render settings and `physics`. The solver accepts radius, gravity, sidereal
rotation period, orbital period and phase, axial tilt, incident stellar flux,
surface pressure, background-gas molar mass and heat capacity, albedo, gray
infrared optical depth, ocean mixed-layer depth, soil moisture, initial
relative humidity and available dust. Scale height must agree with
`R_universal * temperature / (molarMass * gravity)`.

```ts
import {compilePlanetGenerator, createPlanetGeneratorRecipe} from '@patchgames/engine/shared/planetGenerator';
import {createPlanetAtmosphere} from '@patchgames/engine/shared/planetAtmosphere';

const generator = compilePlanetGenerator(createPlanetGeneratorRecipe('earthlike'));
const atmosphere = createPlanetAtmosphere({
  kind: 'planet-atmosphere', version: 1, seed: generator.recipe.seed,
  resolution: 16, physics: generator.physics,
}, direction => ({
  heightMeters: sourceTerrainHeight(direction),
  waterFraction: sourceTerrainHeight(direction) < 0 ? 1 : 0,
}));

// Call in a worker. The return value reports achieved time and outstanding work.
const status = atmosphere.advanceTo(targetPhysicalSeconds, 32);
const column = atmosphere.sample(unitDirection);
const restart = atmosphere.checkpoint();
```

The surface callback runs during preparation, not on every solver tick. Its
height and water samples are included in the simulation revision. A restart
from different terrain is rejected. Generated oceans and the atmosphere must
use the same sea-level reference.

## What evolves

Each of the six cubed-sphere faces has C16, C32 or C64 cells per side: 1,536,
6,144 or 24,576 horizontal columns. There are two air layers per column.
The shared-edge spherical mesh has no longitude singularity or open pole.
Each layer retains background-air mass, tangent Cartesian momentum, potential
temperature, water vapor, cloud liquid, cloud ice, airborne dust and advected
material coordinates. Surface liquid, ice, dust and temperature also persist.

The numerical update uses shared conservative finite-volume fluxes. Air mass
uses a local Lax-Friedrichs flux with hydrostatic reconstruction; tracers use
that same air flux and donor mixing ratios. The reconstructed bottom follows
barometric pressure over terrain. Numerical velocity diffusion, spherical
projection and explicit lower/upper drag dissipate mechanical energy.
Total background-air mass and the inventories of water and dust are conserved
to floating-point accumulation error; exact total mechanical energy is **not**
claimed.

The pressure-force closure uses lower potential `g*(bottom+hLower+hUpper)`
and upper potential `g*(bottom+hLower+alpha*hUpper)`, with an upper thermal
expansion contribution from both layer temperatures. `h=mass/referenceDensity`
is a pressure pseudoheight, not a cloud's geometric altitude. These reduced
potentials are inspired by layered rotating shallow-atmosphere models.
They are not an implementation of the full moist primitive equations.

After horizontal transport, conservative pressure-coordinate remapping restores
the reference layer pressure fractions. Unequal layer convergence therefore
produces ascent or subsidence and carries donor air, moisture, heat, momentum
and material coordinates between layers. There is no unbalanced condensation
source permanently draining the lower atmosphere. Coriolis acceleration is
integrated as a local tangent-plane rotation with `f=2*Omega*sin(latitude)`.
Increasing rotation changes turning and characteristic spatial scales; it does
not directly multiply wind speed.

Water saturation follows a Clausius-Clapeyron approximation using temperature,
pressure and gas composition. Finite-rate saturation adjustment simultaneously
condenses vapor and releases latent heat, or evaporates condensate and cools
air. Cloud freezing and melting exchange fusion heat. All liquid and ice
sediment at finite gravitational settling speeds using the particle sizes from
the optical model. Upper condensate falls into lower air where it can evaporate
or sublimate; lower condensate reaches the surface. Excess cloud mass additionally
converts into faster precipitation. Trace ice therefore has a finite lifetime
even below the autoconversion threshold. No sedimentation step deletes water.
Bulk aerodynamic surface evaporation consumes reservoir water and surface
energy. Background vertical mixing is suppressed by stable stratification
using a bulk Richardson number; convective adjustment strengthens when the
potential-temperature profile becomes unstable. Stable air does not receive a
constant upward humidity leak simply because time has passed.

Radiation uses conservative hemispheric two-stream solar transport and two-layer
gray infrared exchange, with the same body-fixed stellar direction as rendering.
Clouds and dust reflect and absorb solar energy. Adding each layer to the layer
below it and the reflective surface sums repeated reflections instead of sending
all incident sunlight to the ground. Atmospheric absorption heats that layer and
reduces energy available elsewhere. Thermal emissivity includes the actual
liquid/ice/dust inventory as well as the background gas. Clouds can therefore
heat or cool air, alter evaporation and influence their own subsequent evolution.
Ocean and land have different thermal capacities. The radiation diagnostics
record absorbed stellar, reflected stellar and escaping infrared energy; they
are not a claim that the entire numerical dynamical system conserves energy exactly.
The background gas changes density, heat capacity, scale height and water
saturation. Infrared opacity remains an author-supplied gray approximation,
not a computed molecular absorption spectrum.

The explicit gray particle coefficients are:

| Particle | Solar extinction m²/kg | Solar single-scattering albedo | Solar asymmetry | Thermal absorption m²/kg |
| --- | ---: | ---: | ---: | ---: |
| Liquid, effective radius 10 μm | 150 | 0.99 | 0.85 | 90.361 |
| Ice, effective radius 25 μm | 65.43 | 0.99 | 0.75 | 32.715 |
| Dust, effective radius 1 μm | 600 | 0.8 | 0.6 | 30 |

Liquid thermal absorption and the thermal diffusivity factor 1.66 follow the
published NCAR CCM3/CAM gray cloud-emissivity treatment: 0.090361 m²/g is
90.361 m²/kg. Ice absorption uses the geometric approximation
`3*Qabs/(4*density*radius)` with `Qabs=1` and ice density 917 kg/m³. Dust uses
the same expression with explicitly assumed `Qabs=0.1` and density 2500 kg/m³.
The solar coefficients and dust/ice thermal efficiencies are declared broadband
engineering approximations, not spectral optical measurements or coefficients
fitted to a desired global cloud percentage. Solar extinction agrees with the
renderer; gray thermal emissivity is `1-exp(-(gasTau+1.66*sum(kappa*mass)))`.

`planetAtmosphereTwoStreamLayer()` exposes the analytic slab calculation. With
`a=1-omega*(1+g)/2`, `b=omega*(1-g)/2` and
`k=sqrt((1-omega)*(1-omega*g))`, the homogeneous hemispheric solution returns
reflection, transmission and absorption summing to one. Solar optical depth uses
a hemispheric diffusivity factor of 2. The conservative-scattering and pure
forward-scattering limits are handled analytically; thin-layer absorption uses
a positive expression without cancellation or a negative-flux clamp.
`planetAtmosphereRadiativeColumn()` exposes the complete two-layer/surface
budget. For every column, the sum of surface/lower/upper net heating plus
escaping infrared and reflected sunlight equals incident sunlight. Tests cover
clear air, darkness, opaque clouds, absorbing dust and a perfectly reflective
surface. This closure does not resolve a solar spectrum, direct/diffuse beam
angular structure, or individual cloud shadows within a coarse column.

Dry ground can supply dust when resolved wind stress exceeds a density-dependent
entrainment threshold. Dust is a separate conserved tracer, settles into the
surface reservoir and has different rendering optics from water cloud.
Water vapor alone must not create a Martian dust haze.

## Initialization and time

A latitude-band energy-balance calculation initializes surface temperature
from daily mean seasonal insolation, albedo, gray outgoing radiation and
diffusive meridional heat transport. The heat-transport mixing length is
bounded by radius and a rotation-dependent deformation scale. This is a
physical approximate initial condition, rather than a pre-populated cloud or
storm map. Tiny seeded thermal perturbations break exact numerical symmetry.
The initial air is unsaturated when initial relative humidity is below one.
Circulation and condensate require physical spin-up; the initial state is
not an equilibrated Earth climate.
Reference Earthlike C16 runs retain an excessive widespread upper-cirrus bias.
Physical mode is experimental: neither global cloud coverage nor resolved storm
structure has been validated against Earth's climatology. This known bias is
reported rather than hidden by a target coverage mask.

`samplePlanetAtmosphereCelestial(physics, timeSeconds)` is the shared clock for
heating and visible sunlight. Rotation moves the star west in body coordinates;
orbital phase and axial tilt determine seasonal declination.

Ticks use preparation-time acoustic/geometry and radiative-timescale bounds,
at most 30 physical
seconds. Runtime CFL is checked before applying a transport step. Each
`advanceTo(target, maxSubsteps)` executes only whole fixed ticks and at most
the requested bounded work (0–512 steps). It reports actual `timeSeconds`,
`fixedTickSeconds` and `pendingSeconds`. Hosts request the remainder later;
they must not take a giant catch-up step. Very thin atmospheres can require much
shorter thermal ticks and accumulate an honest worker backlog. Repeating the same physical ticks
with different host frame rates gives identical state. Backward time requires
an explicit checkpoint restore. Sampling and rendering have no effect on time.

`checkpoint()` and `snapshot()` return independent Float64 state copies.
`restore()` validates identity, array lengths, finite values, positive layer
mass, thermal bounds, tangent momentum, conservative material-label bounds,
physical clock and nonnegative radiation counters before replacing live state.
The conservation baseline must match this generated planet, and checkpoint
air/water/dust inventories must match it within floating-point tolerances.
A checkpoint is verified persistence rather than an unrestricted state-editing
interface. Invalid physical inputs,
unsupported resolutions, collapsed layers, excessive CFL and nonfinite states
raise errors instead of silently replacing them with zeros or wind clamps.
After a failed update the host can restore its last valid checkpoint.

## Renderer boundary

### Local cloud heights

Physical clouds use locally diagnosed heights rather than authored altitude
bands or global scale-height fractions. `diagnosePlanetCloudColumn()` in
`src/shared/planetCloudColumn.ts` reads the current temperature, pressure,
vapor, condensate, background-gas properties, gravity and terrain altitude.
It is also exposed through `atmosphere.sample(direction)`:

- `surfaceHeightMetersAsl` is the effective terrain/ocean surface above the
  reference sea sphere. Submerged terrain uses the ocean surface at zero.
- `lowerBaseMetersAsl`, `lowerTopMetersAsl`, `upperBaseMetersAsl` and
  `upperTopMetersAsl` are radial altitudes above that same reference sphere.
  Subtract the local surface altitude when reporting clearance above ground.
- `lclHeightMetersAgl` is a lower-parcel condensation/deposition-level diagnostic
  above the local surface. Use it only when `lclWithinAtmosphere` is true.
  Otherwise its finite value is the available atmosphere-depth sentinel, not
  a predicted cloud base. Dry air does not acquire a cloud from this value.
- `lowerCloudOrigin` / `upperCloudOrigin` distinguish `clear`, `surface-parcel`,
  `in-situ` and transient `advected` condensate. `geometryClipped` reports a
  finite-domain or numerical vertical-geometry exception.

The parcel retains its effective specific humidity while its unsaturated temperature
follows `T(p)=Tlaunch*(p/plaunch)^(Rparcel/cpParcel)`. Its first saturation
intersection is solved against the shared Clausius-Clapeyron primitive. Actual
gas molar mass and heat capacity are used; the implementation does not apply
an Earth-specific 125-metres-per-degree cloud-base rule. Water vapor's gas
constant and a constant 1850 J/(kg K) vapor heat capacity enter the dilute
parcel-mixture approximation. Diagnosis consistently uses the unchanged core's
effective `q=vapor/airMass` convention: `Rparcel=Rdry+q*(Rv-Rdry)`,
`cpParcel=cpDry+q*(cpVapor-cpDry)` and `Tv/T=1+q*(Rv/Rdry-1)`.
It does not mix a specific-humidity saturation function with mixing-ratio
virtual-temperature equations. Surface skin temperature is an explicit proxy
for unresolved near-surface air temperature, and lower-layer vapor supplies
its moisture. This two-layer limitation is not a measured surface sounding.
The exported diagnosis rejects vapor `q>0.2` before evaluating gas-mixture
properties (apart from a `2e-9` absolute roundoff tolerance). It does not silently
clamp an unsupported steam-rich parcel. This limit applies to vapor alone:
separate nonnegative liquid/ice column inventories remain valid, including
advected or sedimenting hydrometeors whose total-water ratio exceeds 0.2.
Their mass is retained; dense condensate loading does not acquire resolved
buoyancy or a more complete moist equation of state from this geometry API.

Pressure interfaces come from the actual layer air columns. Geometric heights
integrate `dz=Rdry*Tv/g*d(log(psurface/p))`, with vapor virtual-temperature
correction. Temperature is reconstructed through surface, lower and upper
states in log-pressure coordinates; the unresolved region above the upper
center is isothermal. The upper cloud is diagnosed from its own pressure,
temperature and available water, independently of the surface parcel LCL.
Connected saturated intervals around each resolved layer center determine
cloud bounds, limited by its pressure layer and the reconstructed stable or
inverted profile. The lower LCL can constrain the base when it belongs to that
saturated interval. This does not calculate resolved updrafts, CAPE or a fully
observed cloud-top sounding.

Existing condensate is never created, removed or hidden by this diagnosis.
Advected droplets can temporarily survive in subsaturated air during finite-rate
evaporation. With no locally saturated interval, the diagnostic uses the central
half of that layer's finite-volume **pressure** bin and marks it `advected`;
it does not spread the cloud to the top of the unresolved atmosphere or assign
a global scale-height band. The geometry remains a coarse reconstruction.
All bounds stay inside the finite rendered atmosphere at 9.21 scale heights.
A clipped or numerically degenerate occupied interval alone receives a bounded
one-metre minimum bin and `geometryClipped=true`, retaining its water mass.

Diagnostics are cached once per sampled cell and simulation-state epoch;
stepping and checkpoint restoration invalidate them. Repeated view sampling
does not repeatedly solve the same column. `inspection().cloudColumnDiagnosisCount`
reports the actual computations. Lower and upper base/top interpolation is
weighted separately by each layer's liquid-plus-ice inventory. Clear neighbors
therefore cannot pull an occupied profile toward their zero-height moment.
At a coarse lowland-cloud/clear-hill boundary this weighted cloud base can lie
below the separately interpolated terrain height. The renderer clips density
inside that terrain; it does not lift the lowland cloud or redistribute its
opacity because a clear hill contributes no cloud mass. Subgrid terrain
occlusion is distinct from diagnosed source-column AGL clearance.

The renderer wire format is separately defined in
`src/shared/planetAtmosphereSnapshot.ts`. A worker samples the persistent
cubed-sphere state into bounded latitude/longitude Float32 atlases containing
liquid/ice/dust column kg/m², advected material labels and cloud altitude moments.
Version 2 uses four RGBA32F planes: condensate, lower material/ice, upper
material/surface altitude, and lower/upper base/top multiplied by their occupied
condensate mass. Spatial and time interpolation operate on mass and altitude
moments **before** division. The renderer obtains extinction from particle cross
sections and retains the same vertical inventory from orbit to the ground.
Labels move with transported air; changing wind does not recompute coordinates
as `currentWind * elapsedTime`.

Physical transport integrates a local cloud's optical volume inside each ray
bin rather than testing only the bin midpoint. It intersects the diagnosed
base/top and effective terrain surface first, splits at radial tangency and
the compact profile's two spline knees, and uses four scalar Gauss nodes per
smooth piece. A 280 m cloud therefore contributes its inventory even inside a
much wider global acceleration envelope, without increasing its thickness.
Horizontal physical-column acquisition uses coherent bin midpoints; the
analytic vertical integral does not need random sampling offsets. Procedural
art clouds retain their world-phase sampling. This avoids turning fine
advected top relief into randomly jittered solar self-shadows.
Filtered microstructure uses the occupied profile's mass-weighted center.
The bin is divided at local layer entries/exits so lower cloud, upper cloud
and intervening air composite in view order. Direct cloud lighting uses a
separate effective optical source point: the analytic Beer-Lambert average
of exponential self-shadow at the local view/sun angle. A bounded scalar
profile-integral inverse locates that source inside the actual cloud. For an
opaque cloud illuminated and viewed from the same direction, its effective
source lies at optical depth `ln(2)`, rather than a dark mass midpoint. This
constant-angle closure preserves radiance under optical bin subdivision;
spatially varying illumination remains an approximation. Solar cloud shadows
use the same bin integral. Horizontal geometry is frozen at each
bounded bin's sampled column, so distant weather is still a coarse optical
approximation rather than fully resolved individual cloud turbulence.
Cloud indirect light uses the [bounded sky scattering response](planet-sky.md#cloud-light-shadows-and-shafts),
with whole-column optical mass controlling diffuse escape and the same
optical source average used for direct light. It does not add an unshadowed
ambient floor or change the diagnosed cloud heights, profile or inventory.
The renderer can vary the effective profile top inside that diagnosed envelope
using [column-coherent subgrid relief](planet-sky.md#cloud-light-shadows-and-shafts).
Its base remains fixed and its profile is normalized by the reduced thickness.
The diagnosed `lowerTopMetersAsl`/`upperTopMetersAsl` remain unchanged;
`sampleWeather()` additionally reports `lowerProfileTopMetersAsl` and
`upperProfileTopMetersAsl` so inspection cameras use the same rendered support.

Lower cloud, upper cloud and ice use their own height profiles and the same
column inventory when seen from space or from the ground. Clear source columns
remain clear when approached. No renderer may normalize the snapshot back to
a target percentage or add unrelated near-camera clouds. The diagnostic cloudy
fraction is measured above 0.0001 kg/m² condensed water; it is an output, and
is different from rendered optical cloud coverage.

## Host worker and renderer integration

For a browser host, use the persistent worker session instead of running the
core in a render callback:

```ts
import {createPlanetAtmosphereSession} from '@patchgames/engine/client/planetAtmospherePreparation';
import type {PlanetAtmosphereUpdate} from '@patchgames/engine/client/planetAtmospherePreparation';

let previous: PlanetAtmosphereUpdate | undefined;
const session = await createPlanetAtmosphereSession(recipe, {
  epoch: 1,
  signal: abortController.signal,
  resolution: 16,
  onUpdate(update) {
    sky.setWeatherSnapshots(previous?.snapshot ?? update.snapshot, update.snapshot);
    previous = update;
  },
  onError(error) { showSimulationError(error.message); },
});
previous = session.initial;
sky.enableSimulation();
sky.setWeatherSnapshots(session.initial.snapshot, session.initial.snapshot);
```

`session.generator` contains the prepared source planet and physical parameters;
`session.initial` contains the first complete snapshot and diagnostics.
`session.advanceTo(seconds, probeDirection?)` requests monotone physical time.
The worker executes bounded chunks, retains one latest target and paces
publication; it acknowledges achieved time rather than pretending it has
finished the requested interval. `session.probe(direction)` reads a column,
`session.latest()` returns the latest complete update, and `session.dispose()`
terminates the worker. Abort and worker errors retain the last complete render
state. Checkpoint persistence is currently an API on the core simulator;
the browser worker session does not expose checkpoint transport yet.

At the start of a render frame, call `sky.stageWeather(renderer)` **before**
selecting the shared simulation/sun clock. Atlas upload is staged and a complete
four-plane version-2 state is committed atomically. Read
`sky.inspection().simulation.fromTime` and `.toTime`, and keep render time
inside that available interval. Compute sunlight with
`samplePlanetAtmosphereCelestial(session.generator.physics, renderTime)` and
pass the same `renderTime` to the volume renderer. Set
`frame.weatherPrepared = true` when calling `sky.render()` so it does not
auto-stage another upload after the host has selected its clock. This prevents
a paused frame from acquiring half a new state or a sun beyond its cloud data.
While paused, retain both the selected clock and committed atlas interval.

`examples/planet-lab.html` uses this path by default. Append `?mode=art` to
use the separate art-directed weather controls. The public sandbox entry point
exports the simulation recipe type as `PlanetAtmosphereSimulationRecipe` to
distinguish it from the existing visual atmosphere-scattering recipe.

## Bounds and limitations

C16 is intended for interactive labs and coarse weather; C64 resolves finer
synoptic structure at a larger worker cost. At Earth radius even C64 cells
are roughly 100–200 km across. Small hurricane eyes, tornadoes, individual
cumulus dynamics, vertical turbulence and detailed mountain microclimates
are unresolved. No such features should be described as physically simulated
by this grid. A local high-resolution model would need a conservative nesting
boundary, additional vertical levels and its own CFL budget.

Water is a dilute tracer in a noncondensing background gas; saturation is
bounded at a mixing ratio of 0.2. Steam atmospheres, atmospheric escape,
gas-giant interiors, interactive ocean currents, spectral radiation/chemistry
and seasonal carbon-dioxide frost mass exchange are outside
this version. Dry carbon-dioxide and trace water/ice/dust are supported;
the composition option alone does not simulate all of Mars's climate physics.
Spherical gravity also excludes rotation approaching breakup and atmospheres
whose scale heights are a large fraction of planetary radius.
The reference upper pseudoheight is limited by the thinnest terrain column so
both initial layer pressure potentials can balance. An extreme high mountain
therefore changes the reference upper mass fraction globally. Terrain above
eight scale heights is rejected, and an initial profile outside the supported
thermal range is rejected. This coarse vertical-coordinate limitation is not
a model of detailed mountain atmospheres or a local adaptive vertical grid.

The tests verify closed sphere topology, inventory conservation, dry clear
states, stable-stratification behavior, pressure-wave response, Coriolis signs,
sunlight parity, pure view sampling, deterministic physical ticks, restarts,
surface identity and invalid-state rejection. Multi-day audits should report
actual inventories, layer minima, temperatures, winds, cloud mass and worker
cost before changes are presented as improvements in climate realism.

## Scientific references

- [NOAA GFDL idealized moist atmospheric model](https://www.gfdl.noaa.gov/idealized-moist-spectral-atmospheric-model-quickstart/): an example of separating resolved circulation from gray radiation, water saturation and surface closures. The browser solver is much smaller than this primitive-equation model.
- [Bouchut, Lambaerts, Lapeyre and Zeitlin, 2009](https://www.lmd.ens.fr/glapeyre/papers/fbjlglvz2009.pdf), *Fronts and nonlinear waves in a simplified model of the atmosphere with moisture and convection*: rotating moist shallow-atmosphere dynamics and explicit reduced-model assumptions.
- [Lambaerts et al., 2012](https://journals.ametsoc.org/view/journals/atsc/69/4/jas-d-11-0205.1.xml), *Moist versus Dry Baroclinic Instability in a Simplified Two-Layer Atmospheric Model with Condensation and Latent Heat Release*: layered dynamics and moisture coupling. The pressure-coordinate remapping here is a documented engineering reduction, not that paper's exact isentropic model.
- [Kaspi and Showman, 2015](https://arxiv.org/abs/1407.6349), *Atmospheric Dynamics of Terrestrial Exoplanets over a Wide Range of Orbital and Atmospheric Parameters*: why rotation, gravity, atmospheric mass and thermal forcing change circulation in different ways.
- [NASA ROCKE-3D model description](https://gmd.copernicus.org/articles/18/5825/2025/gmd-18-5825-2025.html): the wider physical scope required for a scientific planetary general circulation model.
- [NCAR CCM3 description, 1998](https://doi.org/10.1175/1520-0442%281998%29011%3C1131%3ATNCFAR%3E2.0.CO%3B2) and the [NCAR CAM4 technical description](https://www.cesm.ucar.edu/models/ccsm4.0/cam/docs/description/cam4_desc.pdf), section 4.9.5: the published liquid-cloud thermal absorption coefficient and diffusivity factor. The gray solar coefficients here are explicitly separate engineering assumptions.
- [NOAA parcel saturation and LCL](https://www.noaa.gov/jetstream/upperair/severe-weather) and [NOAA cloud formation](https://www.noaa.gov/jetstream/clouds/how-clouds-form): why lifting, moisture and thermodynamic stability matter. The Earth lapse rates in these introductory references are not hard-coded planetary constants in this implementation.
- [Federal Meteorological Handbook 3, Appendix D](https://www.icams-portal.gov/resources/ofcm/fmh/FMH3/00-entire-FMH3.pdf): hypsometric integration using layer virtual temperatures. The implementation substitutes each planet's gas constant and gravity for Earth's reference constants.
