# Object surface recipes

Object surface recipes combine a repeating base, face assignments or coverage
fields, and localized surface effects. Version 2 supports boxes with
positive dimensions in model-local metres, declared horizontal front and +Y up.
It stores recipe data, not images. The Material Lab includes editable grass/dirt
and brick/slash examples alongside the existing fifty material swatches.

```ts
import {createObjectSurfaceView, OBJECT_SURFACE_EXAMPLES}
  from '@patchgames/engine/sandbox/objectSurface';

const object = await createObjectSurfaceView(OBJECT_SURFACE_EXAMPLES.grass);
scene.add(object.root);
// Removing it: scene.remove(object.root); object.dispose();
```

For interactive authoring, bake `generateObjectSurface(recipe)` in a worker, then
pass its result to `new ObjectSurfaceView(baked)` or `view.update(baked)`.
Updates keep the mesh identity and, when dimensions are unchanged, its geometry.
The view owns and disposes replaced GPU maps. Keep camera controls outside it.
The lab cancels superseded worker jobs and rejects stale results.

## Coordinates and orientation

Geometric surfaces are fixed axes: right +X, left −X, top +Y, bottom −Y, front +Z,
back −Z. `space:'geometry'` selects those faces. `space:'model'` uses semantic
front/right/back/left derived from `orientation.front`; top remains +Y. Thus a
model declaring −X as front has its semantic front on geometric left.

`boxSurfaceFrame` returns the matching position, normal, U/V basis and physical
span for each Three.js box material group. A slash path starts at the selected
surface's lower-left corner in those coordinates. It is confined to that face,
so it cannot project through the box onto its back.

Explicit scale/mirror/world-space fields are rejected. A display-only uniform
preview fit does not change recipe metre measurements. Arbitrary transformed
models, curved meshes, world-up deposition, and destructive holes are outside
this box contract. Extending it requires matching normals, tangent handedness,
surface identity and collision policies, not guessing UV directions.

## Unified coverage

Every layer uses one coverage object; there is no coverage-kind switch:

```ts
coverage: {
  selection: {space:'model', faces:['top','front']}, // optional; all faces by default
  band: {from:'top', depthMeters:.24, variation:.65, featherMeters:.015}, // optional
  boundary: {strength:1,space:'face',axes:'xy',radius:.85}, // optional
  pattern: {type:'clusters', density:32, sizeMeters:.18} // optional; solid by default
}
```

The final mask is **selected faces × edge band × boundary × pattern**, then source alpha and
layer opacity blend every PBR channel. All controls compose; for example add a
cluster pattern to a top band for patchy grass, or veins inside a wood end mask.
Omitting coverage (or using `{}`) fills all faces. A pattern is solid unless an
explicit feature pattern is supplied. The optional boundary clips/fades a region; pattern gates also compose.

- Grass: `coverage:{band:{from:'top',depthMeters:.24,variation:.65}}`.
- Wood ends: selected top/bottom, a model XZ boundary mask (no feature pattern needed).
- Gold/diamonds: a vein/cluster pattern, optionally with the same faces or band.

Bands work from any of the six directions, use declared semantic orientation
by default (or explicit geometry space), and share a continuous seeded field at
side corners. The anchor face is fully eligible, the opposite face excluded;
depth/variation/feather shape adjacent faces. Depth must fit the object's extent
along the selected direction. Every layer uses the same physical face UVs, so
band orientation never collapses texture density. Version 1 coverage variants
are rejected; update recipes to version 2. The lab's presets use version 2.

Base and layer materials can be inline generator recipes or named references
such as `{ref:'texture.dry-earth'}`.
Named references resolve from the shared material registry rather than a second
material store. `createObjectSurfaceView` follows those dependencies automatically;
await its `ready` after a registry change. Missing/invalid dependencies preserve
the last valid object and expose `root.userData.objectSurfaceError`.

## Localized damage

The slash effect accepts a selected face, a polyline in metres, width, shallow
depth, branching, chipping, exposed color and seed. Its mask affects color,
height-derived normals, roughness, metalness and cavity shading together.
The repeating base uses separate UVs: changing the brick repeat never repeats
the slash. Each instance may use a different recipe or effect path.

Paths outside the face, zero-length paths, duplicate layer/effect IDs and invalid
dimensions are rejected. Slash depth is **shading relief**, not removed geometry.
Collision remains the box; use destruction/geometry systems for real holes.

## Resource and preview contracts

At most four coverage layers and four slash effects (12 path points each), with
16–512 pixels per face. Six faces × six RGBA maps use 36 MiB at 512 before mipmaps
and transient buffers; choose lower resolutions for ordinary repeated props.
Rendering is deterministic for the versioned recipe and seed. Only explicit
user PNG export persists pixels.

The lab supports live controls, layer/effect removal and restoration, face map
selection, JSON editing/export and browser-local saved recipes. Hosted AI tools
can discover `surface.grass` and `surface.slash` and preview their six color faces.
Standalone isolated previews resolve inline and built-in named materials; inspect
the actual game for game-specific material bindings, lighting and integration.
