# Material generator

## Physical mapping and inspection

For a generated box, prefer `createGeneratedMaterialBox(recipe, [width, height, depth])`
from `sandbox/materialGenerator`. Add its `.mesh` to the scene and release it with
`.dispose()`. Dimensions are metres. Every face, including narrow edges, uses the
same physical tile scale across color, normals, roughness, metalness and AO.

For an existing `THREE.BoxGeometry`, pass `{geometry}` to `createGeneratedMaterial`
or `createGeneratedMaterialFromPixels`. This writes metre UVs idempotently. For
terrain/buildings already using metre UVs, pass `{uvSpace:'metres'}`. Use
`surfaceMeters` only for a single normalized UV plane. Bake nonuniform scale into
geometry dimensions before mapping; changing mesh scale afterward changes density.
These helpers do not repair arbitrary curved-asset UVs. The sphere preview exposes
the usual polar UV compression, which the diagnostic views deliberately reveal.

`inspectTextureDensity(geometry, [textureWidth, textureHeight], [repeatU, repeatV])`
reports the minimum/maximum texels per model metre and worst directional ratio
using the triangle UV Jacobian. A ratio of 1 means equal density along both axes;
different tile dimensions on a square source image can intentionally produce
different densities. Missing UVs throw; collapsed UVs report zero density and
infinite distortion. These are model-space measurements, not screen resolution.

The lab's **Surface inspection** menu provides a 0.25-metre checker grid and a
texture-density overlay. Red is below the editable target, green at target, blue
above, and magenta indicates greater than 2× directional distortion. Change the
preview width/height/depth to test long walls and narrow sides. Inspection changes
only the preview, never the exported recipe. `createMaterialMappingDebug` exposes
the WebGL debug overlay; own and dispose it independently of the PBR material.

Object surfaces bake rectangular images, with resolution capping the longest
model axis, to keep approximately equal density across all faces. Rounding uses
a one-pixel minimum. Local damage remains clamped to its selected face; never
repeat these baked face maps. Grass/slash inspection measures the model, regardless
of the lab's display-only fit scale. Source map dimensions and byte diagnostics
reflect the actual rectangular images.

## Recipe-only storage and live edits

The engine stores named material recipes rather than baked image assets. The
standard game document is `src/game/materials.json`:

```json
{"version":1,"materials":{"wall.stone":{"pattern":{"family":"masonry"},"color":"#c1aa86"}}}
```

Reference it from a texture layer with `{source:{kind:'asset',id:'wall.stone'}}`.
Here `asset` identifies a named recipe, not a file. Existing built-in `texture.*`
names resolve to generator recipes too; their appearances are now procedural.
There are no saved RGBA maps in the material bank or embedded starter pixels.

`buildView` validates and embeds this document for published games. A host can
call `GameViewHost.updateMaterialRecipes` to replace the named recipe set without
restarting simulation or resetting the camera. The renderer updates existing
material textures and cached surface copies in place. Invalid documents are
rejected atomically. Removing a referenced custom recipe produces a neutral
placeholder and an error diagnostic, rather than retaining stale pixels.

Use `replaceMaterialRecipes` from `shared/materialRegistry` in a standalone view.
The PatchGames editor streams saved AI changes to the owner via authenticated SSE;
local file edits also preview directly. Source-code/geometry changes still need
compilation. The recipe-only preview is not a substitute for final build checks.
Pixels exist temporarily in memory for rendering; they are not persisted to the
material library. PNG export in the lab remains an explicit user action.

## Interactive lab

Run Vite from a checkout and open `examples/material-lab.html`. The lab includes
50 named editable examples, live family controls, a rotatable sphere/cube/plane,
six map views, lighting choices, pixel/realistic output and PNG/JSON exports.
Custom presets save locally in the browser; exporting JSON makes them portable.
The browser generates everything in workers, without an account or image service.
The main preview cancels obsolete jobs while gallery thumbnails use a separate queue.

Applications can import `mountMaterialLab` from `@patchgames/engine/material-lab`
and call it with a container and optional close callback. It returns cleanup.
Bundle it with Vite (including its CSS and module worker). Avoid loading this demo
in gameplay bundles unless requested; a dynamic import works well.
`MATERIAL_LAB_PRESETS` in `shared/materialLabPresets` exposes the fifty recipes.

Generate original tileable materials from small versioned recipes. No image service,
network connection, source asset, or private connector is needed. Eight families
cover masonry (brick and cut stone), rock, wood, dirt, gravel, grass, metal and plaster.
Compose these as layers for moss, dust, stains or biome transitions.

```ts
import {createGeneratedMaterial} from '@patchgames/engine/sandbox/materialGenerator';

// Once during loading, not inside update/render. Share this material between meshes.
const surface = await createGeneratedMaterial({
  name: 'Weathered sandstone', seed: 1842, tileMeters: [2, 2],
  color: '#c1aa86', secondaryColor: '#625a4c',
  pattern: {family: 'masonry', shape: 'rectangle', blockMeters: [0.4, 0.2],
    bond: 'staggered', mortarMeters: 0.012, irregularity: 0.2, chipping: 0.3},
  output: {resolution: 1024, style: 'realistic'},
}, {surfaceMeters: [10, 4]});
mesh.material = surface.material;
// A 10 x 4 m wall with UVs 0..1 gets five horizontal and two vertical repeats.
// After all users release it:
surface.dispose();
```

`generateMaterial` in `shared/materialGenerator` produces transferable RGBA8
arrays: sRGB color plus linear normal, height, roughness, metalness and ambient
occlusion. Bake in an application-owned worker for large jobs, then upload using
`createGeneratedMaterialFromPixels`. The convenience helper cooperatively yields
during loading; generation is not a per-frame effect. Height affects shading,
not silhouettes or collision. Normal maps use the Three.js tangent-space convention.

## Choosing controls

| Family | Controls |
| --- | --- |
| masonry | rectangle/square/triangle cuts, block metres, stack/staggered bond, mortar metres, irregularity, chipping |
| rock | grain metres, fractures, layering |
| wood | plank metres, grain, knots, gap metres, vertical/horizontal direction |
| dirt | grain metres, clumping, moisture, embedded stones |
| gravel | stone metres, roundness, size variation |
| grass | blade metres, density, dryness, bare patches |
| metal | brushing, oxidation, metalness |
| plaster | grain metres, cracks |

Common controls: seed, two colors, variation, roughness, weathering, tile metres,
and relief metres. Normal strength follows physical tile size rather than image
resolution. Whole feature counts are rounded for periodic tiles (and bounded to
256 per axis); choose a larger tile for larger features. Grass is a surface texture,
not geometric blades. Wood grain/knots and corrosion are stylized approximations.

`MATERIAL_GENERATOR_PRESETS` provides editable examples for every family.
Resolution choices are 32–2048; pixel style uses a limited palette and nearest
filtering; stylized uses a limited palette with smooth filtering. Realistic keeps
continuous tones. Higher resolution preserves detail but does not automatically
make a surface photorealistic. Inspect in the target lighting and at player distance.
At 2048, six RGBA maps consume 96 MiB before mipmaps and transient CPU buffers.
Use 128–512 for most repeated surfaces; reserve larger maps for justified close-ups.

## Layer composition

Existing `createRecipeMaterial` accepts generators as sources:

```ts
const recipe = {
  kind: 'texture', version: 1, name: 'Mossy stone', resolution: 256,
  layers: [
    {source: {kind: 'generator', recipe: {pattern: {family: 'masonry'}}}},
    {source: {kind: 'noise', colors: ['#254022', '#627b35']}, opacity: 0.3,
      mask: {kind: 'height', min: 0, max: 0.4}},
  ],
};
```

Layered compositions retain their existing 512-pixel budget and derive normals
using the outer recipe's `reliefScale`. Direct generator bakes support 2048 and
their own physical `reliefMeters`. Preview at modest resolution before baking.
Save the recipe with the game; it is deterministic for this generator version.
Re-use baked output and dispose GPU resources when no longer needed.
