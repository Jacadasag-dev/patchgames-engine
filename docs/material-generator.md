# Material generator

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
