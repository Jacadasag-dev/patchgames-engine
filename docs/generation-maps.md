# Shared generation maps

Generation maps provide one recipe format for spatial fields and stable variation.
Use **Map → Combine → Apply**: describe a field, combine named fields, then bind the
result to a supported generator parameter. Keep topology, placement constraints,
collision and attachments in the generator that understands them.

Run `npm run demo:generation` for the [Generation Lab](../examples/generation-lab.html).
Its editable recipe shares one graph between layered terrain, four varied trees
and a wall with directional weathering. JSON export stores recipes, not baked
textures or geometry. The [example data](../examples/generation-lab-data.ts) is a
small integration reference.

## Map and combine

```ts
import {compileGenerationMaps, type GenerationMapRecipe}
  from '@patchgames/engine/shared/generationMaps';

const graph: GenerationMapRecipe = {
  kind: 'generation-maps', version: 1, seed: 42,
  maps: {
    region: {type: 'noise', space: 'world', scaleMeters: 120},
    mountains: {type: 'remap', input: 'region', from: [.4, .7],
      to: [0, 1], unit: 'normalized'},
    ridges: {type: 'noise', space: 'world', scaleMeters: 24,
      octaves: 3, ridged: true},
    height: {type: 'remap', input: 'ridges', from: [0, 1],
      to: [-2, 18], unit: 'metres'},
    shapedHeight: {type: 'multiply', inputs: ['height', 'mountains']},
    treeShape: {type: 'random', scope: 'object', channel: 'shape'},
  },
};

const maps = compileGenerationMaps(graph); // Once during preparation.
const height = maps.sample('shapedHeight', {world: [-32, 0, 48]});
const explanation = maps.inspect('shapedHeight', {world: [-32, 0, 48]});
```

The compiler clones and freezes the recipe. It validates every node, including
unused nodes. `output(id)` reports unit, conservative range, required spaces and
identity scopes, dynamic status and sampling cost. `inspect` adds the input
context and dependency trace. Neither method renders a preview.

| Node | Purpose |
| --- | --- |
| `constant` | A fixed value; defaults to `scalar` units. |
| `noise` | Continuous 3D value noise in a named metre frame; optional octaves and ridges. |
| `gradient` | Clamped directional 0–1 progression between two coordinates. |
| `distance` | Radial falloff: 1 at the centre, 0 at/beyond a radius in metres. |
| `random` | Stable 0–1 variation for one object or part identity. |
| `add` | Weighted sum, with signed weights. |
| `mix` | Weighted average with nonnegative weights. All-zero weights require an explicit fallback. |
| `multiply` | Product, useful for masks; at most one physical-unit input. |
| `remap` | Convert a range and declare its output unit; clamps by default. |
| `clamp` | Explicitly bound an existing field. |
| `time` | A repeating 0–1 phase from explicit seconds; marks its dependencies dynamic. |

`add` and `mix` require compatible units. Metres and radians cannot be mixed, or
added to a dimensionless field. Remap normalized noise to metres before using it
as elevation. Use `multiply` to mask a physical field with a normalized field.
If a sum exceeds 0–1 it is scalar; explicitly remap it before a normalized binding.

## Coordinates, identities and stages

Coordinates are `[x,y,z]`, in metres. The engine uses +Y up. A map declares its
frame; a sampler must supply that frame rather than guessing it:

| Frame or scope | Contract |
| --- | --- |
| `world` | Absolute world coordinates, including negative positions; independent of chunk origin. |
| `object` | Metre coordinates local to the object, before its world transform. |
| `surface` | Metre coordinates in a surface adapter's declared face frame. |
| `scope:'object'` | Requires a stable `objectId`; changing coordinates alone does not reroll it. |
| `scope:'part'` | Requires both `objectId` and a stable `partId`. |
| `time` | Requires `timeSeconds`; no wall clock or implicit elapsed time. |

Spaces describe coordinates; scopes describe identity. A world-space field can
be combined with object randomness when the adapter provides both. Missing
frames or identities throw. Surface coordinates are physical distances, not
repeated source-texture UVs.

Compile maps and prepare geometry/materials outside gameplay frames. Generic
targets declare `stage:'prepare'|'runtime'` and
`effect:'geometry'|'material'|'presentation'`. Dynamic maps are accepted only for
runtime presentation targets. Terrain, foliage and surface bakes are static
preparation adapters. A runtime presentation binding is an extension contract;
it does not automatically connect these maps to wind, character motion or physics.

## Apply bounded parameters

`compileGenerationBindings(graph, bindings, targets)` connects normalized maps to
registered targets. Targets have explicit units, ranges, supported spaces/scopes,
stage and effect. There are no arbitrary property paths or callbacks.

```ts
import {compileGenerationBindings}
  from '@patchgames/engine/shared/generationBindings';

const prepared = compileGenerationBindings(graph, [
  {id: 'tree-height', target: 'example.height', map: 'treeShape', range: [3, 5]},
], [
  {id: 'example.height', unit: 'metres', range: [1, 10],
    effect: 'geometry', stage: 'prepare', spaces: [], scopes: ['object']},
]);
const values = prepared.sample({objectId: 'grove/tree-04'}, {'example.height': 4});
```

Supply a valid base value for every bound target. `replace` maps 0–1 into the
binding range. `multiply` maps it into a factor in 0–4 and multiplies the base.
An optional normalized `mask` blends the result back toward the base. Resolved
out-of-range values throw; they are not silently clamped. Integer targets round
the resolved value. One binding may write each target: combine fields first.

## Delivered adapters

### Terrain elevation and exact placement counts

Set `TerrainRecipe.base.maps = {graph, layers}`:

```ts
const base = {
  height: 0,
  maps: {graph, layers: [
    {id: 'mountain-elevation', map: 'height', weight: 1, mask: 'mountains'},
  ]},
};
```

Layers require static **metre** outputs; masks require static normalized outputs.
Only world-space fields without identity scopes are supported. Weights default
to 1 and accept -10 through 10. Terrain samples at `world:[x,0,z]`, so elevation
does not feed back into itself. Maps add to legacy base height/noise before
regional elevation, channels and road/foundation grading. Analytic queries,
eager compilation, streamed chunks and world planning use the same sampler.

Scatter layers may request `count:4` for exactly four accepted placements. This
is an eager-world quota, not a new packing solver: existing density, spacing,
reservations, slopes and clearances still apply. Use sufficient candidates
(usually `density:1`). An underfilled request returns an invalid draft with
`exact-count-underfill`; never install it as a successful four-object result.
`count:0` is valid. Quotas are rejected for streamed/windowed compilation because
a chunk cannot determine a global count. Explicitly use `streaming:false` or
prepare a separate finite placement plan.

### Foliage variants

`compileFoliageGeneration({recipe,graph,bindings,instances})` in
[`generationFoliage.ts`](../src/shared/generationFoliage.ts) plans a bounded joint
variant bank. Instances have stable `id` and optional world coordinates. Bind
`foliage.heightMeters`, `crownRadiusMeters`, `branchAngle`,
`branchPitchVariation`, `leafSizeMeters`, `density`, `bark.roughness` or
`bark.variation` using the exported `FOLIAGE_GENERATION_TARGETS` IDs (foliage
targets have the `foliage.` prefix). The adapter supplies object origin and
object identity; it supports world/object fields and object randomness.

The result contains editable variant recipes plus separate `geometryKey` and
`materialKey` invalidation metadata. Bark-only edits preserve the geometry key;
changing leaf physical dimensions can change it. This planner allocates no meshes
or textures and does not implement a bake cache. Use `prepareFoliageGeneration`
from the sandbox [foliage generator](foliage-generator.md) once during loading to
prepare the terrain library; calling it again may rebake. `FoliageView` separately
reuses geometry on material-only updates. The planner accepts at most 16 joint variants,
not a Cartesian product of independent geometry and material banks. Inline bark
recipes are required for bark bindings; named references cannot be mutated.

### Object-surface materials

[Object-surface recipes](object-surfaces.md) accept
`generation:{graph,bindings}`. Supported targets are `base.roughness`,
`base.weathering`, `base.variation` and `layer:<stable-layer-id>.opacity`, all in
0–1. The bake supplies continuous object and face-surface metre coordinates.
World fields, object randomness and dynamic maps are rejected because a portable
surface recipe has no world/entity identity. `inspectObjectSurfaceGeneration`
explains a face sample. This changes material appearance, not wall geometry or
collision. Existing coverage bands, patterned inclusions and fracture generators
remain responsible for their specialized shapes.

## Stability, caches and limits

Keep map IDs, instance IDs and random channels stable. A random value depends on
the seed and these identities, not array order or a cache revision. Adding a
separate bark map does not reroll tree geometry. `graph.seed` controls map fields;
`TerrainRecipe.seed` and a foliage recipe's seed remain their own generator
seeds. Link seeds deliberately when a UI exposes one master seed.

Revisions identify recipe content and algorithm versions for caches and stale
result rejection. They must never be fed back as random seeds. Persist the full
editable graph. Terrain dependency fingerprints include only fields reachable
from elevation layers/masks, so editing an unused appearance field does not
rebuild terrain or change its placements. The full edited recipe is still
validated and retained. Foliage separates material/geometry keys. Editors must
discard superseded worker results and retain the last valid preview after invalid
edits; the pure evaluator does not own editor transactions.

| Budget | Limit |
| --- | --- |
| Map graph | 64 maps, dependency depth 16, 16 inputs per combine node |
| One output's sampling cost | 4096 weighted operations; noise charges per octave |
| Generic bindings | 16, total sampling cost 4096 |
| Terrain | 8 elevation layers, total sampling cost 4096, bounded contribution 10,000m |
| Exact eager scatter quota | 0–256 per layer |
| Foliage | 1–16 prepared joint variants, plus existing foliage/material budgets |
| Surface bake | 16 million pixel × binding-cost operations, plus existing texture budgets |

Invalid data, cycles, missing references, unsupported frames, unsafe units and
budget overflow fail with diagnostics. Sampling is CPU deterministic in the
supported runtime; no cross-GPU bit-for-bit guarantee is implied. Bakes, GPU
memory, collision and live frame times require their own measurements.

Dedicated building/interior, hair/character and wind adapters are future work.
Use existing generators for those systems; the field evaluator does not create
valid rooms, branch topology, attached hair or structural support by itself.
The recipe APIs, evaluator, adapters and examples are public engine code.
PatchGames' hosted AI orchestration and MCP integration remain private.
