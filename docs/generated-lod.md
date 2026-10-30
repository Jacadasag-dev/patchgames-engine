# Generated level of detail

Generated views prepare lower-detail representations of the same accepted object.
The render boundary selects a representation from its projected size and declared
geometric error, with hysteresis to avoid flickering between levels. Collision,
gameplay, recipe seeds, named attachments and source geometry remain unchanged.

The engine enables this policy by default for supported generated views. Do not
regenerate recipes, grow trees, rebake textures or construct geometry in an update
callback to implement distance LOD. Prepare content during authoring/loading or
the existing bounded view-replacement stage, then select prepared data at render.

## Delivered generators

| Content | Prepared representation | Preserved contract |
| --- | --- | --- |
| Heightfield terrain | Up to five interior grid strides; every source perimeter vertex is retained. | Any neighboring chunk detail levels share exact edge positions. Physics uses the original accepted heightfield. |
| Editable voxel chunks | Exact coplanar unit faces coalesce into fewer prepared triangles, retaining every integer perimeter vertex. | Caves, block/material boundaries, repeated texture phase, mining/placement and collision remain unchanged. No coarse voxel downsampling. |
| Foliage | Four prepared wood/leaf tiers; lower tube complexity, simplified branch paths, stable nested leaf subsets and less leaf-card tessellation. | Same tree identities, trunk/branch attachments and full-detail authoritative trunk colliders. Crown coverage is approximated by stable spatial representatives and bounded leaf enlargement. |
| Terrain foliage/props with prepared banks | Per-instance tier buckets, rather than one tier for a whole forest chunk. | One visible representation per placement. Hidden source matrices retain stable wind identities. |
| Generated analytic model spheres/cylinders | Lower segment counts of the same analytic shape. | Same dimensions, centres, metric UVs, attachments and physics. Boxes already have minimal useful topology. |
| Generated materials | Mipmap chains with minification filters and bounded anisotropy. | Physical texture scale; alpha-test coverage for foliage cutouts; normalized filtered normals. |

Imported arbitrary meshes, skin weights, morph targets and authored shader
deformation are not automatically decimated. The existing render safety checks
retain unsupported content at source detail. Water, hair and
future specialized generators need explicit prepared representations where the
generic analytic path is insufficient; this is not a universal mesh-remeshing tool.

## Selection and transitions

`generatedLod.ts` defines the shared prepared-bank contract. Each level names an
already-created geometry and an error relative to the **source** bounding-sphere
radius. Source level zero has error zero. Banks contain two through five levels
with finite nondecreasing errors. Analytic model and terrain error bounds account
for their supported geometric construction; foliage density tiers additionally
approximate visual coverage and need scene inspection.

Selection uses the actual camera projection and viewport pixels, including zoom
and orthographic cameras. Relevant shadow projections can retain more detail.
Unsupported/stereo camera configurations stay conservative. The default screen
error thresholds are 1 pixel to enter a reduced tier and 1.5 pixels to leave it;
some object adapters also protect large near-field projections.

Transitions are error-guided switches with hysteresis. This release does not
activate geomorphing, dither cross-fades, billboards or impostor atlases. Terrain
contains prepared morph deltas for future transition work, but the renderer does
not apply those deltas. Inspect silhouettes and motion along the actual camera
route; filtering and hysteresis do not certify subjective visual quality.

Terrain's boundary fans retain the complete original perimeter at every tier.
This spends a small, predictable number of triangles on seams rather than
covering cracks with skirts. Internal grid reduction never changes authoritative
surface queries, road grading, placements, navigation or collision. LOD does not
extend the set of resident streamed chunks: configure world streaming/view range
separately and measure its memory and preparation cost.

Voxel coalescing is a zero-error reduction, useful at every distance. It runs in
the existing yielded chunk mesh job and publishes with the matching revision.
Only coplanar faces of the same material/normal are combined. Integer boundary
vertices avoid T-junctions between merged rectangles and neighboring chunks.
Opaque native materials without vertex colors or custom shaders are eligible;
mapped textures require RepeatWrapping, integer repeat factors, automatic UV
matrices and zero rotation to preserve each original block's texture phase.
Clamped, mirrored, fractional-repeat and translucent faces keep source topology.
An optimization working-set cap of 65,536 source faces retains more complex
chunks at their already valid source detail. This does not change voxel storage,
queries, network state or authoritative edit behavior.

Terrain placement buckets reuse prepared geometry and material resources. The
same source index always receives wind animation; rendering copies its current
matrix into the selected tier slot. Compaction does not rewrite source IDs.
The allocation limit is 32,768 tier-instance slots per `TerrainView`; content
over that budget retains the original instanced representation. `lod:false` in
`TerrainViewOptions` disables its prepared ground and placement LOD.

Prepared foliage libraries share immutable source geometry and every LOD tier
across chunks through the optional `TerrainAssetFactoryContext`. `TerrainView`
supplies this context and retains the geometry loan until replacement, failed
construction cleanup or disposal; materials, textures and instance buffers remain
view-owned. A wrapping factory must forward it:
`assetFactory:(asset,context)=>forest.assetFactory(asset,context)`.
Calling the library factory without a context instead returns independently owned
geometry copies. `forest.dispose()` immediately rejects new requests but defers
template disposal until every existing view has released its loan, so closing a
library cannot invalidate resident chunks. No global geometry cache is involved.

## Materials and memory

`createGeneratedMaterialFromPixels` selects mipmap-capable minification filters.
Generated color cutouts use alpha-weighted linear-light filtering with coverage
preservation; normal mipmaps are renormalized. Other maps use normal GPU mipmap
generation. Pixel-art output uses nearest mip selection; other styles use
trilinear selection. Linear-filtered output requests anisotropy 4 by default,
bounded to 1–16 and limited by renderer/device capability. Nearest-filtered
pixel-art output uses anisotropy 1 for backend compatibility.

Mipmaps improve distant filtering and sampling behavior. They do **not** unload
the full-resolution base texture or implement texture residency streaming. A
complete square mip chain adds approximately one third to base pixel storage;
count all PBR maps, CPU caches and GPU allocations when setting a budget. High
resolution still needs deliberate material sharing and preparation limits.

## Custom generator integration

Prepare the lower-detail geometries once, then register their borrowed bank:

```ts
import {registerGeneratedGeometryLod}
  from '@patchgames/engine/sandbox/generatedLod';

const unregister = registerGeneratedGeometryLod(sourceGeometry, [
  {geometry: sourceGeometry, error: 0},
  {geometry: mediumGeometry, error: mediumErrorMeters / sourceRadius},
  {geometry: farGeometry, error: farErrorMeters / sourceRadius},
]);
```

The registering generator owns all geometries and must dispose each exactly once
after its last view releases them. Registration does not transfer ownership.
Unregister before releasing a bank; disposing the source also removes its entry.
Do not mutate registered geometry underneath an active view. A replacement
recipe creates a replacement prepared bank and preserves the last valid view if
preparation fails.

`registerGeneratedMeshLod` supports a mesh-specific prepared bank, including a
bounded `InstancedMesh` prefix count. `registerGeneratedLodAdapter` is for custom
render-only compaction: its `prepare(frame)` may select/copy prepared data;
`restore()` must restore authored full-detail state. It must not run a generator,
allocate a new mesh/texture bank, change authority or reroll random identities.
The engine restores generated selection after rendering, so external inspection,
raycasts and ordinary authored updates see source geometry and instance counts.

## Validate with the same route

`configureRenderPerformance(renderer)` installs the normal render policy for a
standalone engine renderer. Engine worker views install it through their normal
renderer lifecycle. `setGeneratedLodEnabled(renderer, false)` is a diagnostic A/B
switch; return it to `true` for default behavior. Compare the same camera path,
viewport, shadows, content and material resolution, after preparation is ready.

Collect `renderer.info.render` triangles/calls and `renderPerformanceStats`, then
record frame intervals and p50/p95/p99 separately from preparation timings.
`TerrainView.inspection().lod` lists prepared terrain tiers and per-instance
selected counts/triangles. Lower triangle counts alone are not proof of smoother
frames: overdraw, shadows, draw calls, texture bandwidth and chunk preparation can
still dominate. Test mixed chunk boundaries, close-up silhouettes, wind, repeat
traversal, disposal and supported camera types. CPU frame intervals are not a
physical-display FPS measurement.
