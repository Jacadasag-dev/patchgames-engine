# Planet atmospheres and volumetric clouds

The planet sky combines wavelength-dependent atmospheric scattering,
circulation-organized volumetric cloud layers, a rotating sun and an inertial
star field in the same orbit-to-surface scene. It is presentation data: it does
not change terrain, collision or gravity. The renderer also accepts mass snapshots
from the [persistent planet simulator](planet-simulation.md), which is now the
default lab mode. Run `npm run demo:planet` and add `?mode=art` to the lab URL
to edit the procedural sky controls described here.

Choose **Free flight** to keep the current position and viewing direction, then
click the view. WASD flies forward/backward and sideways, Q/E moves radially
down/up, dragging turns the camera, and Shift boosts speed. Speed scales with
altitude by default; disable that option to enter metres per second. The wheel
changes flight speed in this mode. Other modes retain their altitude wheel and
the measured round trip always uses the automatic route. Inputs stop when the
view loses focus, so editing controls does not move the camera.

Free flight is a bounded visual inspection camera, not gameplay collision: it
keeps 1.7 m clearance above source/displayed ground and sea, limits movement
after a stalled frame, and stays within six planet radii. It does not collide
with trees or buildings. Selecting a biome explicitly relocates the camera;
changing planet scale scales its clearance to the new radius.

## Prepare once, render continuously

```ts
import {createPlanetSkyRecipe} from '@patchgames/engine/shared/planetSky';
import {preparePlanetSky} from '@patchgames/engine/client/planetSkyPreparation';
import {PlanetSkyView} from '@patchgames/engine/sandbox/planetSkyView';
import {samplePlanetCelestial} from '@patchgames/engine/shared/planetCelestial';

const recipe={...createPlanetSkyRecipe(73,planet.radius),surface:planet.recipe};
const bake=await preparePlanetSky(recipe,planet.radius,abortController.signal);
const sky=new PlanetSkyView(bake);
await sky.prepare(renderer,scene,camera); // Nonblocking shader compilation before swap.

// Update the camera-relative terrain first. Absolute coordinates remain doubles.
planetView.update({position:absoluteCamera,origin:absoluteCamera,
  viewportHeight:canvas.height,fovDegrees:camera.fov});
const celestial=samplePlanetCelestial(recipe.celestial??{},simulationSeconds);
sky.render(renderer,scene,camera,{
  position:absoluteCamera,timeSeconds:simulationSeconds,
  sunDirection:celestial.sunDirection,starRotationRadians:celestial.rotationRadians,
  presentationTimeSeconds:realTimeSeconds,
});

// Dispose the sky before closing the renderer or replacing the planet.
sky.dispose();
```

The host preparation helper owns a module worker and transfers bounded volume
buffers. Pass an abort signal when replacing a pending recipe or closing a scene.
Keep the last valid sky visible while preparing a replacement. Do not call the
shared compiler's synchronous `bake()` from an animation callback.

`PlanetSkyView` requires **WebGL 2**, `EXT_color_buffer_float` and
`KHR_parallel_shader_compile`. `prepare(renderer,scene,camera)` deduplicates
preparation for that renderer. It first compiles the two sky programs, then the
scene's linear HDR capture variants, restoring the target, viewport and tone
mapping before each wait. Finish replacing generated scene materials before
calling it. Omitting the scene and camera prepares only the sky programs;
`render()` then prepares the scene capture asynchronously before drawing effects.
Keep the previous sky until it resolves; dispose stale candidates
when a request is superseded. If preparation fails, the promise rejects and
`inspection().preparation` reports the error. Calling `render()` directly starts
the same preparation and draws the raw scene until it is ready, so an expensive
driver compile does not freeze a gameplay frame. Failed preparation keeps that
fallback and does not retry every frame. The 60-second preparation timeout and
disposal reject pending callers. `fallbackFrames` distinguishes fallback draws
from completed sky passes. Preparation reports `phase` (`postprocess`,
`scene-capture`, `complete`) and `captureReady` so hosts can distinguish the two
compiler stages.

Capture preparation isolates temporary material copies from raw fallback draws
and retains their program-cache references until view replacement or disposal.
It covers the final scene materials present during preparation; it does not
precompile arbitrary new material or geometry variants added later by a game.

`PlanetSkyWebGPUView` shares the rendering and recipe API using native WGSL and
Three node materials; its renderer is initialized with `await renderer.init()`.
Both consume the same prepared recipe and volumes. Choose the view that matches
the actual renderer:

```ts
import {WebGPURenderer} from 'three/webgpu';
import {PlanetSkyWebGPUView} from
  '@patchgames/engine/sandbox/planetSkyWebGPU';

const renderer=new WebGPURenderer({canvas,logarithmicDepthBuffer:true});
await renderer.init();
const sky=new PlanetSkyWebGPUView(bake);
// render(), setRecipe(), setDiagnostic(), inspection() and dispose() match
// PlanetSkyView. Native rendering is synchronous after renderer.init().
```

Use Three's native `WebGPURenderer`, rather than the compatibility facade.
The native sky rejects uninitialized devices and WebGL fallback explicitly;
an unavailable WebGPU adapter must be reported by the host. Native perspective
projection and native near-relative logarithmic depth are decoded separately
from the WebGL depth curve. Do not copy a WebGL projection into this renderer.

Both paths require a perspective camera, finite positive clip planes,
conventional or logarithmic depth, and an opaque scene clear/background. They
compose into a canvas viewport; nested render-target output, reversed depth and
XR need their own adapters. One view owns resources for one renderer.

## Live controls and stable fields

`compilePlanetSky(recipe,radius)` validates and freezes the recipe. Defaults scale
with planet radius. Atmosphere controls include height, Rayleigh color/strength
and scale height, Mie haze/scale height/anisotropy, and sunlight intensity. Cloud
controls include coverage, density, shape/detail scale, erosion and wind velocity
in metres per second. Independent `clouds.layers.fog`, `cumulus` and `cirrus`
have enabled, bottom, thickness and density controls. Their defaults span
0–0.8 km, 1.2–7 km and 8.5–12 km respectively at Earth scale. These are ordered,
non-overlapping sea-level altitude shells; fog is not automatically attached to
the ground on a mountain. Cloud tops must fit inside the declared atmosphere;
invalid edits are rejected.

`clouds.circulation` uses [circulation-driven weather](planet-weather.md): an
irregular ITCZ, dry subtropics, frontal storm tracks, polar low cloud, coastal
decks, land afternoon convection and terrain lift/rain shadow. Seeded tropical
and frontal primitives move with the hemisphere's circulation. Three-dimensional
noise supplies cloud shape and erosion inside these regimes. Cumulus tops vary
with the field; cirrus uses stretched high-altitude structure. Passing
`surface:planet.recipe` makes coast and mountain effects use the actual terrain.

The additional `clouds.weather` generation-map input is a static, normalized
world field without object identities. It modulates the circulation rather than
replacing it. Its default is neutral. The weather bake reports an area-weighted
static coverage metric; this is distinct from rendered optical cloud coverage.

`sky.setRecipe(nextRecipe)` updates lighting, shapes, style and quality without
rerolling or preparing the volumes. Compare `compilePlanetSky(...).bakeKey` before
an update: a different seed, radius, circulation recipe, terrain source or
weather graph requires a new worker bake and replacement view. Field resolution
is independent of visual style and quality, so switching looks preserves the
same underlying weather pattern.

## Daylight, sun and stars

`celestial` controls physical day length, phase, axial tilt, season, solar angular
radius/glow, and star visibility/density/intensity/twinkle. The world remains in
body-fixed metre coordinates; only sunlight and the inertial sky rotate. This
preserves terrain identities, object placement and collision coordinates.
`samplePlanetCelestial()` supplies body-fixed solar direction and the rotation
used by the star field. A host may advance its explicit simulation clock faster
than real time; `presentationTimeSeconds` remains a separate real clock for
twinkle, so accelerating weather does not turn star flicker into a strobe.

The solar disc and stars are evaluated at output resolution, behind captured
geometry and cloud/air transmission. RGB Rayleigh extinction attenuates blue
light more strongly over long sunset paths. Stars fade in daylight and are
dimmed more near the horizon; horizon twinkle increases through more atmosphere
and fades outside it. This is a seeded star field, not an astronomical catalog.

The host must update the scene's actual directional light with the solar
direction. `samplePlanetSunlight()` supplies a local ground observer's direct
visibility and reddening for that light; the lab also lowers ambient fill at
night. Do not apply a local observer's below-horizon visibility to the entire
planet from orbit: the opposite hemisphere may still be sunlit.

## Realistic and pixelated presentation

`style:'realistic'` uses ray-footprint-filtered volume sampling and smooth compositing.
`style:'pixel'` retains the same cloud volume but applies a screen-pixel grid and
quantized output levels. `pixelSize` and `paletteSteps` control that presentation;
palette steps are channel levels, not a fixed named-color palette. The game HUD
remains normal HTML/CSS and stays sharp.

Clouds are raymarched through occupied spherical-shell intervals, including views
from inside a cloud layer. They are not a sky-dome cloud texture. Captured terrain
depth bounds the view ray, and depth-aware compositing protects terrain edges.
The reconstruction filter measures conservative continuous depth slopes over
the full-resolution source footprint. This allows smooth grazing-angle ground
to accept nearby volume samples without introducing untreated horizontal rows.
Sky/geometry classification and discontinuity rejection remain separate. The
slope test uses the smaller same-side slope at a depth step and does not widen
tolerance when a thin foreground object has background on both sides.
If every bilateral sample is rejected at a horizon, a local 3x3 fallback uses
only transport ending in front of an opaque pixel, never a sky or longer path
behind it. Empty sky pixels prefer complete sky samples. Identity remains the
fallback when no conservative sample exists. The depth-rejection diagnostic
continues to expose the original rejected footprint, including repaired pixels.
Atmospheric scattering and cloud illumination are bounded real-time
approximations, not an offline multiple-scattering renderer.

Atmospheric transport stops at the planet's opaque reference radius, while
captured raised terrain can occlude it sooner. This avoids treating coarse
spherical mesh chords as underground air. Below-reference terrain does not
define a different atmospheric body boundary. Low sample budgets can retain
fine grain in distant clouds. Temporal reprojection and full multiple scattering
are not implemented.

## Cloud light, shadows and shafts

Cloud sunlight uses bounded samples through the occupied layers, with forward
scattering for bright lit edges, self-extinction and a daylight ambient fill.
The same cloud attenuation modulates air scattering along view rays;
`clouds.godRayStrength` controls the resulting volumetric sun shafts. It does not
draw an unrelated radial-blur overlay.

`clouds.shadowStrength` controls cloud attenuation projected onto captured scene
geometry. This implementation multiplies the captured lighting color by an
estimated direct-light fraction. It is a full-capture lighting approximation,
not per-light material shading: emissive and indirect components within that
capture cannot be separated and may also be dimmed. HTML/CSS HUD elements are
outside the capture and remain unaffected. There is no separate terrain-only
shadow overlay or second overlapping water surface.

The lab's Sky inspection views expose captured scene, radiance, optical thickness
and depth acceptance. They help distinguish volume sampling from compositing
artifacts. `sky.setDiagnostic('composite')` returns to the normal output.

## Quality and measurement

Cloud density uses one pressure/humidity condensation support from the ground
to orbit. A clear atmospheric column stays exactly empty at every noise mip.
Continuous 3D noise erodes occupied banks; its coordinates follow the common
weather flow and a bounded, physical-time deformation. Cumulus top height is
coherent through each column, rather than changing with sample altitude.

View and cloud-light rays use feature-scaled logarithmic intervals: nearby
volume receives finer samples, while distant intervals grow and filter the 3D
noise over their footprint. A stationary world-space phase decorrelates samples
without animated screen noise. Prefix allocation shares each quality preset's
primary cloud and clear-air budgets across all crossed layers; it does not grant
each layer another full budget. `inspection().transport` reports these limits.
There is one extinction law and no separate far-distance occupancy mixture.
Unresolved distant cloud structure remains a filtered-volume approximation;
bounded rays do not resolve every small puff along a long grazing sightline.

Low, balanced and high presets bound render-target pixels and view/light sample
counts. `sky.inspection()` reports the selected resolution, sample budgets and
resource information; count the scene capture and composite as well as the
volume pass when measuring cost. Scene buffers, sky buffers and density volumes
have separate costs. Do not treat one counter as total process or GPU memory.
Both backends retain RGB transmission independently from radiance. The native
path uploads a bounded six-level 3D noise mip chain through public texture-copy
APIs; it does not rely on Three's 2D automatic mip generator for 3D textures.
Native inspection reports the filtered noise payload separately from the
original transferred bake bytes. Scene draw and triangle counters exclude the
sky's fullscreen passes and account for native cumulative renderer statistics.

The lab's 40-second benchmark records the sky recipe, sunlight elevation and sky
counters alongside terrain residency and the frame trace. Controls remain fixed
during a run. Compare the same route with both layers disabled, then enabled, at
the same viewport and quality. Callback CPU includes live telemetry and sampling;
RAF intervals still are not physical display FPS or completed GPU timings.
Native reports also collect asynchronous GPU queue completion latency and
uncaptured GPU errors. Queue completion includes scheduling and already queued
work; it is not a GPU timestamp measurement. Shader errors must invalidate a
run even when callback counters continue to advance.
