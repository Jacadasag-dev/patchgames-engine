# Object surface recipes

Object surface recipes combine a repeating base, face assignments or coverage
fields, and localized surface effects. This first version supports boxes with
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

## Grass coverage

The grass example has a dirt base and a `top-fringe` layer. Its top is fully
covered, its bottom is uncovered, and its sides use a seeded XZ coverage field
plus model-space height. The same point at a corner produces the same fringe
boundary on both sides. Controls include depth in metres, variation, feathering,
grass density, colors and seed. Removing the layer exposes dirt on all faces.

For explicit face assignments use a `faces` coverage with
`selection:{space:'model',faces:['top']}`. Base and layer materials can be inline
generator recipes or named references such as `{ref:'texture.dry-earth'}`.
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
