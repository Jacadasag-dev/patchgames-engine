# Material generator

## Patterned blending and plant materials

Use a base material plus a patterned layer for ore, moss, paint, aggregate or veins.
`shared/materialPatterns` exports pure `parseMaterialPattern`,
`sampleMaterialPattern` and `MATERIAL_PATTERN_TYPES`. Patterns support `patches`,
`clusters`, `veins`, `cells`, `stripes`, and `speckles`. Parameters are
`sizeMeters`, `coverage`, `irregularity`, `edgeSoftnessMeters`, `angleRadians`,
`seed`, and `invert`. Coverage is an artistic threshold, not an exact area fraction.
Up to three non-recursive `gates:[{operation:'intersect'|'union'|'subtract',pattern}]`
combine patterns. For example, intersect clusters with veins. The same seed and
coordinates reproduce the same mask; object-wide masks do not change with source
texture repeats or image resolution.

`placementRegularity:0..1` is shared by every pattern and defaults to **0**:

- **0:** scattered positions, with zero to four proposals per spatial region.
- **0.5:** a mixture of scattered and ordered positions at similar mean density.
- **1:** one ordered proposal at each lattice centre, without positional jitter.

The scatter process draws a seeded bounded Poisson count and independent uniform
positions within implementation regions. It does not put one shaken point in
every cell. The mixed process uses ordered-point probability `regularity` and
scatter rate `1-regularity`; the four-scatter-proposal cap slightly truncates rare
tails. Small surfaces naturally vary in count. Clumping and concentration decide
which of these proposals generate; shape, size and source opacity remain separate.
`irregularity` can bend strands and loosen the ordered component at intermediate
regularity, but does not reintroduce a grid at the scattered endpoint.

Every pattern also accepts `shapeVariation` and `sizeVariation` (0–1). Shape
variation applies a finer irregular warp to boundaries; size variation applies a
seeded per-feature size multiplier. Thus clusters lose perfect
circular outlines, veins wander, stripes become uneven and patches/cells vary.
These controls are independent of `irregularity` (the original family-specific
placement/bend control), source texture repeats and output resolution. Both
default to zero; artistic coverage is still not an exact measured area fraction.

All patterns and gates can use a generation-time spatial distribution:

```ts
concentration: {
  strength: 1,       // +1 inward, 0 uniform, -1 outward; controls feature generation probability
  space: 'face',    // 'model' for object coordinates
  axes: 'xy',       // x/y/z, xy/xz/yz or xyz
  center: [0,0,0],  // normalized: centre 0, negative/positive boundary -1/+1
  radius: .85,      // fraction of each selected axis's half-span; .01–2
  softness: .2     // probability transition width as a fraction of radius; no opacity fading
}
```

Face XY biases feature centres on each face; model XZ biases a vertical
cross-section. Model XYZ uses an ellipsoidal volume. `center` offsets the bias;
`radius` is normalized to each selected half-span. Concentration changes the
binary seeded decision to generate each feature. A surviving feature keeps its
size, shape and interior opacity; only its geometric edge softness blends.
Features can extend past the preferred region because their centres, not every
pixel, follow the distribution. Inversion complements the generated mask; gates
combine generated masks rather than imposing a shared opacity fade.

`clumping:0..1` groups feature generation around a shared, smooth density field.
`groupSizeMeters` (.004–20, default .6) sets the physical grouping scale. Start
around 3–6 feature widths. Clumping correlates nearby feature presence, not their
color or opacity, and works with inward/outward bias. Feature counts/coverage
remain artistic rather than exact counts. All six pattern types share the seeded
proposal system: blobs, speckles and patches; finite stripe/vein strands; and
cell regions. Strands can join where they overlap. Distribution edits can add or
remove a whole strand/cell; they do not shorten it with an alpha gradient.

`materialPatternFeaturesAtCell(pattern,[cellX,cellY,cellZ],frame)` exposes the full
proposal set, including stable IDs, physical centres, generation probabilities,
accepted flags and size scales. The singular `materialPatternFeatureAtCell`
inspects only the ordered proposal, whose accepted flag is false when it is not
selected by regularity. Use the plural API for distribution statistics. Accepted
flags are deterministic. Changing concentration or clumping leaves the proposal
set and its individual sizes intact; placement regularity changes that set.

For a bake, prefer `createMaterialPatternSampler(recipe)`. It validates a snapshot
and caches up to 8192 regions per root/gate sampler across physical domains.
Recreate it after recipe edits and release the closure after use. Stateless
`sampleMaterialPattern` remains useful for individual probes. Object-surface,
texture-composition and lab-worker bakes use the cached sampler, with identical
pixels. The cache never stores a mutable external recipe.

`sampleMaterialPattern(pattern, physicalPoint, frame)` accepts `MaterialPatternFrame`
with normalized `face`/`model` points and `faceMeters:[width,height]` or
`modelMeters:[width,height,depth]`. Generation domains are centred on zero.
Nonzero concentration requires the corresponding physical dimensions; missing
ones throw. Object surfaces provide both frames. Planar TextureRecipe masks
provide the face frame with UV .5 at its centre. Model-space generation requires
an object adapter. Face generation is two dimensional; model generation is three
dimensional and shares feature coordinates across faces.

For an explicit fade/crop, use `boundary:{strength,space,axes,center,radius,softness}`.
This independent optional mask multiplies the finished pattern after gate
composition/inversion. It does change partial blend opacity near its boundary;
this is intentionally separate from distribution. The wood-core example uses a
model XZ boundary to demonstrate a continuous cut section. No anatomy, geometry
or collision is generated by these surface operations.

For boxes use `OBJECT_SURFACE_EXAMPLES.iron`, `.diamond`, `.gold`, or
`['moss-bark']` from `shared/objectSurface`. They are editable recipes:

```ts
const layer = {
  id:'ore',
  material:{pattern:{family:'metal'},color:'#d5ac40',secondaryColor:'#76551b'},
  coverage:{kind:'pattern',pattern:{type:'clusters',sizeMeters:.17,coverage:.36,seed:19}},
  opacity:1,
  heightOffsetMeters:-.006
};
```

Model-space masks share continuous 3D coordinates at face corners. Face-space
masks generate separately on each face. An optional coverage `selection:{space:'model',faces:['front']}` restricts
application. Each source material still uses its own physical face UVs. Pattern
coverage, source alpha and layer opacity jointly blend color, height, roughness,
metalness and cavity shading; normals derive from the final height. Positive
height offsets raise the layer, negative offsets recess it. This is shallow
shading relief, not a mesh cut. Source texture seams can remain even where mask
coverage is continuous. This generator revision changes seeded layouts from the
old fade-based implementation; rebake recipes when updating the engine.

Ordinary `TextureRecipe` layers use the same masks:
`mask:{kind:'pattern',tileMeters:[1,1],pattern:{type:'veins',sizeMeters:.12}}`.
Here tileMeters converts the composition's UV frame to metres; it does not use
the layer's source repeats. This is a two-dimensional face generation domain. Finite patterned
tiles are not guaranteed seamless when subsequently repeated; use model-wide
object surfaces or inspect the tile boundaries. Existing noise/height/slope masks
remain available. Authoritative data parsers validate the same bounded recipes.

Four additional generator families provide editable plant surfaces:

| Family | Controls |
| --- | --- |
| bark | ridge metres, fissures, peeling, knots, vertical/horizontal direction |
| leaf | length/width metres, vein spacing/strength, pointed/oval/lobed outline, edge serration, damage |
| needle | length/width metres, taper, vein strength, damage |
| exposed-wood | growth-ring metres, grain, knots, end/lengthwise cut |

Use the family presets for suitable colors and physical tiles. Leaves/needles are
individual silhouettes centred in the tile; leave space around their length and
width. Generated color alpha contains real cutouts. Generated material handles
use alpha testing and two-sided rendering. Recipe compositions and surface-cache
clones retain cutout state; partially transparent compositions use blending.
These generators do not produce a tree mesh, branching, wind, refraction, or
subsurface light transmission. Bark and leaf detail are procedural approximations;
resolution alone does not establish photorealism.

The lab has 54 material swatches plus seven object recipes. Choose an ore/moss
example to edit the pattern, source colors/repeats, opacity and recess/raise depth,
add/remove layers, or restrict a pattern to veins. **Blend mask** shows combined
coverage/opacity before source cutouts; **Opacity** shows final color alpha.
All pattern types expose placement regularity, shape/size variation and concentration strength, space,
axes, centre, radius and density falloff, plus clumping and group size. Ore presets demonstrate face distribution;
**Wood core cross-section** demonstrates an explicit model XZ boundary mask on end faces.
Filter the library by bark, leaf, needle or exposed-wood to edit those generators.
Leaves/needles select a physical-size card preview. Changes rebake in a cancellable
worker without resetting the camera. Save/export stores recipe data, not pixels.

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
54 named editable examples, live family controls, a rotatable sphere/cube/plane,
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
