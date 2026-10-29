# Foliage generator

Generate editable trees and bushes from recipe data. This is engine geometry,
not an AI image, downloaded model or saved texture bank. Bark, leaves and needles
are the existing material generator recipes; named slots resolve from the same
material registry. Shared pattern proposals provide density, clumping, group
size, placement regularity, size variation and concentration. Every leaf is
projected onto and anchored along a terminal twig rather than floated in space.

## Use in a game

```ts
import {createFoliage,FOLIAGE_PRESETS} from '@patchgames/engine/sandbox/foliageGenerator';
const plant = await createFoliage(FOLIAGE_PRESETS[0].recipe);
scene.add(plant.root);
// Run the await during loading, not at the top level of a synchronous GameView factory.
// On removal: scene.remove(plant.root); plant.dispose();
```

Bake during authoring/loading or in a worker with `generateFoliage(recipe)`.
Use `new FoliageView(bake)` and `view.update(nextBake)` for live authoring;
updates preserve the root, reuse geometry for material-only edits, and dispose replaced resources. Superseded
lab workers are terminated; stale responses never overwrite a newer edit. Keep
camera fitting outside the model. In a synchronous GameView factory, start the
prepare promise, attach its result when ready, and dispose a late result if the
view has already ended; do not make the factory return a promise. Recipes store real metres; preview fitting
does not change the authored dimensions. The Foliage Lab exports JSON and offers
individual branch inspection by hiding the leaves. Material Lab links to it.

`compileFoliage` and `parseFoliageRecipe` from `shared/foliageGenerator`
are renderer-free. Their data includes parented tapered woody segments, exact
leaf anchors and source branch/t values, crown proposals, bounds and diagnostics.
Precompile bounded assets, never grow/rebake them in a gameplay tick. Use `createFoliageTerrainPrototype(bake)` with `TerrainViewOptions.assetFactory`:
this creates a plain-mesh prototype that terrain can instance across placements.
A raw `FoliageView` contains leaf instances and is not a terrain prototype. Terrain
batches take ownership of each returned prototype's geometry/materials/maps. Existing terrain
primitive defaults are unchanged; choose this generator for authored foliage.

## One set of controls

`kind:'foliage', version:1` is required. Start with `FOLIAGE_PRESETS`:
oak, birch, longleaf pine, woodland bush, dry scrub, flowering magnolia, jungle canopy, winding woodland tree, coconut palm and fan palm. All are editable recipes,
not species restrictions. Custom branching and material choices are supported.

| Control | Meaning and bounds |
| --- | --- |
| type | tree (one trunk) or bush (five basal stems) |
| seed | signed 32-bit growth/distribution seed; materials retain their own seeds |
| heightMeters | woody height, .2–30; leaves can extend beyond it |
| crownRadiusMeters | maximum woody radial reach, .1–10; leaves add their own extent |
| trunkRadiusMeters | .005–1, constrained to fit height and crown |
| crownShape | round or conical |
| branchLevels / branches | 1–4 recursive levels, 2–12 child branches per level |
| branchAngle / taper | .15–1.5 radians of spread, .35–.85 branch end radius ratio; central stems taper to tips |
| density | same pattern units: 0–256 centres/m³ in the crown domain; zero makes bare wood |
| clumping / groupSizeMeters | shared parent/offspring groups; 0–1 strength, .02–20 m; large finite groups stay inside the crown |
| placementRegularity | 0 scattered, 1 ordered proposals, with mixed values between |
| concentration | the shared descriptor: strength, model space, axes, centre, radius and softness |
| irregularity / shapeVariation | 0–1 growth bending and fork-angle variation |
| sizeVariation / leafSizeMeters | 0–1 per-leaf scale variation; independent .02–1 m leaf length |
| quality | low/medium/high radial detail, texture resolution and leaf budget |

Concentration uses normalized crown model coordinates (-1 to +1): +strength
favours the interior and -strength the exterior. Axes/centre/radius/falloff have
the same semantics as material masks. It controls whole leaf proposals, never
opacity. Proposals are mapped onto twigs, so the final leaf positions follow the
plant's attached skeleton instead of literally preserving a free-space grid.
Clumping determines collections near the selected twigs; group size controls
their physical scale. Density changes amount without resizing leaves or wood.
Leaf size changes geometry without changing the seeded skeleton/proposals.

## Materials and rendering

`materials:{bark:generatorOrRef,leaf:generatorOrRef}` accepts inline generator
recipes or `{ref:'my.leaf'}`. Prefer leaf/needle generator families for alpha
silhouettes; other material families produce full cards and a diagnostic. The
leaf's actual silhouette base, not its transparent texture border, anchors to
the twig. Cards are gently curved, differently oriented and alpha-tested with
two-sided shading. Branch UVs measure circumference and length in metres.

`createFoliage` follows named material registry edits and exposes `ready`.
Material-only changes use `bakeFoliageModel(compiledModel)` and preserve existing
geometry/instance buffers. This avoids regrowing branches for a color edit.
Missing references reject the new bake and retain the last valid view with
`root.userData.foliageError`. Raw `FoliageView` accepts bakes directly and
does not subscribe to registries by itself. Changed reference bindings require
recreating the managed handle. GPU maps and materials use shared engine helpers.

Woody geometry uses overlapping capped tapered segments at junctions; it is
realtime game geometry, not a watertight boolean CAD solid. Leaves are instanced
in one mesh and wood merged in another. Shadow/refraction passes add their normal
rendering costs. This version supplies static plants: no automatic wind, growing
simulation, severed limbs or distance LOD switching. The terrain adapter supports
existing per-asset placement batching and terrain environment wind profiles.
Hook those behaviours into the engine's environment/game systems as needed.

## Budgets, collisions and checks

Branches stop at 8192 segments. Crown density may propose up to 20000 features;
region enumeration stops at 32768 per distribution pass and reports actionable
errors. Leaf budgets are 1800/6500/16000 for low/medium/high. Quality thinning
uses a deterministic subset, keeps branch geometry unchanged, and is explicit
in diagnostics. Low/medium/high use 5/8/12 radial sides and 64/128/256 pixel
material bakes by default. Reduce density/crown size or increase group size when
an authoring budget is exceeded; do not silently hide a failed bake.

`foliageColliders(model,{maxLevel:0,maxColliders:64})` emits coarse trunk
capsules aligned to the compiled segments. It excludes leaves; wire the capsules
into the authoritative physics scene and its existing streaming budgets. Collider
positions are model-local and must match the rendered object's placement. This
helper does not automatically install physics or update it on a visual edit.

Tests cover deterministic seeds, branch and leaf attachment, bounds, independent
amount/size controls, large groups, quality subsets, renderer winding, cutouts,
GPU disposal, named material updates and real sandbox compiler imports. Use the
lab for appearance and inspect actual games for lighting, scale, collision and
scene performance. A valid graph is not proof of photorealism or frame rate.

## Architecture and flowers

All presets use the same compiler, not species-specific mesh builders. Mix crownStart (.05–.98), trunkTaper (.04–1 end/start radius), trunkLean and rootFlare (0–1), branchRadiusRatio (.1–.75), branchSegments (4–16), winding, branchDroop and leafDroop (0–1). Higher segment counts resolve smooth winding and drooping limbs; large recursive recipes still enforce the 8192 woody-segment budget. Crown start controls the first trunk fork as a fraction of trunk length.

leafArrangement is scattered, pinnate (paired leaflets along each terminal rachis), or fan (radiating blades anchored near terminal tips). Density still controls the number of leaf proposals; frond arrangement then positions them along their connected path. Palms use one branching level, a high crown start, a persistent trunk radius and drooping terminal paths.

flowers has independent density (0–32 centres/m³), sizeMeters (.03–.6) and petals (3–12). Zero leaf density can produce a flowering bare tree. Optional materials.flower uses the same material generator or named registry reference; the default is a pale petal cutout. Blooms attach to twigs and add one draw batch. Quality limits bloom centres to 48/128/256 and reports thinning. Petals and leaves support merged terrain prototypes and live material updates. These are species-inspired procedural forms, not botanical simulations.

Woody paths render as welded swept tubes: bend rings share positions and smooth normals, cross sections transport along the path without abrupt frame flips, and only path endpoints are capped. Bark uses continuous path distance. This avoids stacked-cylinder seams without changing growth recipes, anchors or colliders.

trunkCurve (0–1) bends the central stem progressively toward the seeded lean direction, independently of its initial trunkLean. Combine with rootFlare and trunkTaper for a curved coconut or a stout upright fan palm. Palm presets use the existing horizontal bark direction for leaf scars, not deep vertical woodland fissures.

Crown width is measured relative to the stem axis, so lean does not consume frond spread. Crown proposal height follows crownStart, and its centre follows the stem axis; high-crowned plants retain foliage on both sides of a bent trunk.

## Willow, evergreen and maple

The willow, evergreen and maple presets share the same recipe compiler. terminalDroop (0–1) adds bending only to terminal twig paths, while terminalLength (.25–3) scales their length independently of supporting limbs. Willow combines long hanging twigs with narrow pointed leaves. Evergreen spruce combines conical reach, low crown start, layered limbs and needle materials. Maple uses the material generator leaf outline palmate: a broad serrated lobed silhouette, also available in Material Lab. Change leaf colors for seasonal variants. Foliage Lab exposes both terminal controls; all presets remain discoverable in FOLIAGE_PRESETS.

branchWhorls (integer 1–4) places multiple radial limbs at each trunk tier, useful for layered evergreens. It multiplies trunk child count and remains subject to the shared branch budget.
