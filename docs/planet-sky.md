# Planet atmospheres and volumetric clouds

The planet sky generator adds a seeded three-dimensional cloud field and a
scattering atmosphere to the same orbit-to-surface scene. It is presentation
data: it does not change terrain, collision, gravity or authoritative weather.
Run `npm run demo:planet` to edit both generators live in the Planet Flight Lab.

## Prepare once, render continuously

```ts
import {createPlanetSkyRecipe} from '@patchgames/engine/shared/planetSky';
import {preparePlanetSky} from '@patchgames/engine/client/planetSkyPreparation';
import {PlanetSkyView} from '@patchgames/engine/sandbox/planetSkyView';

const recipe=createPlanetSkyRecipe(73,planet.radius);
const bake=await preparePlanetSky(recipe,planet.radius,abortController.signal);
const sky=new PlanetSkyView(bake);

// Update the camera-relative terrain first. Absolute coordinates remain doubles.
planetView.update({position:absoluteCamera,origin:absoluteCamera,
  viewportHeight:canvas.height,fovDegrees:camera.fov});
sky.render(renderer,scene,camera,{
  position:absoluteCamera,timeSeconds:simulationSeconds,sunDirection,
});

// Dispose the sky before closing the renderer or replacing the planet.
sky.dispose();
```

The host preparation helper owns a module worker and transfers bounded volume
buffers. Pass an abort signal when replacing a pending recipe or closing a scene.
Keep the last valid sky visible while preparing a replacement. Do not call the
shared compiler's synchronous `bake()` from an animation callback.

This renderer currently requires **WebGL 2**, `EXT_color_buffer_float`, a
perspective camera and an opaque scene clear/background. It composes into a
canvas viewport; nested render-target output and XR need their own adapters.
It is not
a WebGPU implementation; the WebGPU facade does not accept its GLSL postprocess
materials. Other hosts can use the shared serializable recipe and baked fields
when implementing another backend.

## Live controls and stable fields

`compilePlanetSky(recipe,radius)` validates and freezes the recipe. Defaults scale
with planet radius. Atmosphere controls include height, Rayleigh color/strength
and scale height, Mie haze/scale height/anisotropy, and sunlight intensity. Cloud
controls include bottom altitude, thickness, coverage, density, shape/detail
scale, erosion, and a world-space wind velocity in metres per second. Cloud top
must fit inside the declared atmosphere height; invalid edits are rejected.

The cloud weather input reuses the shared generation-map format. It must be a
static, normalized world-space field without object identities. The generator
bakes that broad field into a volume; independent seeded noise channels supply
local shape and erosion. Wind samples those fields at explicit simulation time.

`sky.setRecipe(nextRecipe)` updates lighting, shapes, style and quality without
rerolling or preparing the volumes. Compare `compilePlanetSky(...).bakeKey` before
an update: a different seed, radius or weather graph requires a new worker bake
and replacement view. The fixed field resolution is independent of visual style
and quality, so switching looks preserves the same underlying weather pattern.

## Realistic and pixelated presentation

`style:'realistic'` uses ray-footprint-filtered volume sampling and smooth compositing.
`style:'pixel'` retains the same cloud volume but applies a screen-pixel grid and
quantized output levels. `pixelSize` and `paletteSteps` control that presentation;
palette steps are channel levels, not a fixed named-color palette. The game HUD
remains normal HTML/CSS and stays sharp.

Clouds are raymarched through occupied spherical-shell intervals, including views
from inside a cloud layer. They are not a sky-dome cloud texture. Captured terrain
depth bounds the view ray, and depth-aware compositing protects terrain edges.
Atmospheric scattering and cloud illumination are bounded real-time
approximations, not an offline multiple-scattering renderer.

Atmospheric transport stops at the planet's opaque reference radius, while
captured raised terrain can occlude it sooner. This avoids treating coarse
spherical mesh chords as underground air. Below-reference terrain does not
define a different atmospheric body boundary. Cloud shadows on terrain and
temporal reprojection are not implemented; low sample budgets can retain fine
grain in distant clouds.

The lab's Sky inspection views expose captured scene, radiance, optical thickness
and depth acceptance. They help distinguish volume sampling from compositing
artifacts. `sky.setDiagnostic('composite')` returns to the normal output.

## Quality and measurement

Low, balanced and high presets bound render-target pixels and view/light sample
counts. `sky.inspection()` reports the selected resolution, sample budgets and
resource information; count the scene capture and composite as well as the
volume pass when measuring cost. Scene buffers, sky buffers and density volumes
have separate costs. Do not treat one counter as total process or GPU memory.

The lab's 40-second benchmark records the sky recipe, sunlight elevation and sky
counters alongside terrain residency and the frame trace. Controls remain fixed
during a run. Compare the same route with both layers disabled, then enabled, at
the same viewport and quality. Callback CPU includes live telemetry and sampling;
RAF intervals still are not physical display FPS or completed GPU timings.
