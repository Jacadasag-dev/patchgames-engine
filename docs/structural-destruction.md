# Structural destruction

The destruction helpers turn an authored support graph into persistent damage and moving compound debris. The same pieces supply structural properties, collision and rendering. They support buildings, bridges, props and custom structures; they do not infer a safe building from its appearance or fracture arbitrary triangle meshes. This integration is opt-in: existing buildings remain unchanged until their bindings, state, physics and view are wired.

AI authors can discover the API with `get_creation_catalog({query:'destruction'})`, read `get_authoring_guide({topic:'destruction'})`, and retrieve these references:

- `src/sandbox/destruction.ts`: compile the graph, create/update damage state, prepare collision and step debris.
- `src/sandbox/buildingDestruction.ts`: bind compiled building or asset parts to authored structural members.
- `src/sandbox/destructionView.ts`: render intact pieces and detached groups from the same state.
- `src/sandbox/fracture.ts`: prepare seeded solid slabs, convex cells, mass and cohesive bonds.
- `src/sandbox/fractureView.ts`: seamless textured exteriors and fresh fracture faces.
- `src/sandbox/structuralFracture.ts`: replace selected members and expand their authored bearings.
- `src/sandbox/proceduralDestruction.ts`: optional generation, collision/query replacement and shared stepping.
- `src/sandbox/proceduralDestructionView.ts`: render prepared building/asset fragments with their source materials.
- `src/sandbox/physics.ts`: compound bodies, shared actor/debris simulation and impact evidence.
- `src/sandbox/variation.ts`: deterministic, correlated design choices.
- `src/sandbox/terrainWorld.ts`: durable collision-only replacements over cached terrain.
- `src/sandbox/characters.ts`: submit existing characters to the shared compound batch.

## Opt into destruction during procedural generation

Use `compileDestructibleBuilding(recipe, configurationOrFactory)` or `resolveDestructibleAsset(catalog, familyId, resolveOptions, configurationOrFactory, pose?)`. The result contains the original `building` or `model` and an optional `destruction` bundle. Omit the configuration or pass `false` to preserve ordinary generation and source identities. A factory receives the final generated manifest and returns `{bindings, fractures, runtime}` or `false`, so the AI can select parts based on actual generated geometry, parameter choices and authored construction roles.

For existing city/world output, call `prepareBuildingDestruction(building, configuration)` or `prepareAssetDestruction(model, configuration, pose)` **after** final world placement, room elevations, foundations and entrance ramps are resolved. Give each independently damageable instance a unique bindings ID. A cached asset variant is reusable geometry, not a shared damage state. These helpers do not automatically enable destruction on every world/terrain instance.

`bindings` uses the existing exhaustive ownership contract below. Each optional `fractures` rule supplies `{memberId, seed, cells, cohesionCapacity, cohesionDurability?, maxSupportDistance?, bearingDistance?}`. Strength and durability determine resistance; `cells` determines fracture detail independently. For example:

```ts
const generated = compileDestructibleBuilding(recipe, building => ({
  bindings: authorSupportsFor(building), // The generator's construction policy.
  fractures: [{memberId:'roof-panel', seed:recipe.seed ?? 0, cells:8,
    cohesionCapacity:80000, cohesionDurability:120, maxSupportDistance:4}],
  runtime: {impactResponse:'coupled', contactLoads:true,
    impactDamage:{minimumImpulse:20, damagePerImpulse:.025, minimumSpeed:1}}
}));
const bundle = generated.destruction!;
const initial = createDestructionState(bundle.prepared.structure);
// Persist initial via destructionStateShape / encodeDestructionState.
```

`authorSupportsFor` in this sketch is game-authored code, not a built-in inference function. A complete runnable construction policy is in `tests/fixtures/procedural-destruction.ts`. The compiler never infers that a decorative panel carries a roof from its appearance or material name.

The [procedural house workshop](http://localhost:5177/tests/visual/procedural-destruction.html) uses `tests/fixtures/procedural-impact-house.ts`: a furnished two-storey recipe with rooms, stairs, textured finishes and a pitched roof. Inspect the ground floor or upstairs, then launch the original giant boulder with configurable mass/speed. Generation seed, material resistance, roof cell count and the destruction toggle rebuild the house. The detailed fixture limits roof cells to 2–4 per roof solid to stay inside the shared structural budget.

`prepareStructuralFractures` preserves source mass, strength and durability totals using cell-volume shares. It generates internal cohesive bonds and maps existing authored support bonds to actual boundary cells. Original bond capacity/durability is distributed across the new connections; `cohesionCapacity` is force **per generated adjacency**, not material pressure. `bearingDistance` defaults to .05m; remote connections require an explicit authored tolerance. An unstable expanded graph fails validation rather than receiving invented reinforcement.

Automatic replacement currently requires one visible, collidable, exact box part per selected member. Anchors, compound/model wrappers, custom furniture shapes, cylinders and spheres cannot be requested as slab fractures. Keep them as authored rigid members, or author supported box sections. Unsupported explicit requests fail with an actionable error. The final graph must fit the shared limits; roofs are never silently skipped to fit a budget. Prepared counts and source-to-member mappings support AI inspection.

Use `PreparedDestructionView(bundle,state)` for presentation. It hides selected original skins, preserves source exterior UVs/material patches, and draws prepared cells and cut surfaces from accepted physics poses. Keep the old source renderer/terrain instance out of the scene. `projectDestructibleBuilding` and `projectDestructibleAsset` remove replaced skins and invalidate affected original support surfaces/lights when any replacement cell detaches. Original rectangular navigation surfaces cannot describe irregular holes; use updated native collision and revalidate routes.

Call `stepDestructibleWorld({entries:[{destruction:bundle,state}],scene,dt,bodies})` once per tick, apply returned actor poses and persist returned states. It removes exact original source colliders, inserts current structural collision and uses coupled contact damage by default. `prepareDestructibleScene` provides the collision-only preparation separately. Mixed instance runtime policies require an explicit shared override; do not advance the same actor separately for each building. Disable impact damage with `damagePerImpulse:0` when gameplay uses only explicit hits/contact loads.

For terrain hosts, `preparedDestructionTerrainEdits(bundle,state)` removes both original source geometry and prepared static geometry before adding the current attached/settled colliders. Removal recognizes ordinary asset transforms and terrain's exact coordinate/rotation normalization. Feed those edits into the existing accepted terrain lifecycle. Collision edits do not suppress instanced terrain visuals; the matching original instance must be hidden/replaced by its destruction view. Terrain-instance scale must be baked into source geometry before preparing bindings; the asset pose helper accepts position/yaw.

## Author support explicitly

`compileStructure({id,version,members,bonds,gravity?})` accepts stable member IDs, world-space member positions/colliders, mass in kilograms, strength in newtons and optional durability in hit points. Durability defaults to strength numerically; override it when damage should follow a different gameplay scale. An anchored member connects to the fixed world.

A bond `{id,from,to,capacity,durability?,weight?}` points **from the supported member to its support**. Capacity is in newtons; weight expresses its relative share of distributed load. Directed support graphs must be acyclic. Add `kind:'cohesive'` for undirected material connections; these can form loops, but directed support loops through a cohesive island are rejected. Compilation rejects invalid references, geometry, budgets and structures that are unstable before any damage. Merely putting two boxes next to one another does not create a structural bond.

Select a weighted material or construction style once, then derive related geometry, mass, member strength and bond capacities in ordinary code. For example, an authored beam's section and material density can determine mass while the same style sets its intended strength. `createVariation` keeps those choices stable; explicit parameters remain authoritative. These are design controls, not certified engineering material properties. Preserve the editable recipe and compile on configuration changes.

## Keep damage as world state

`createDestructionState(structure)` creates the initial state. Declare `shapes.world.destruction = destructionStateShape`, save `encodeDestructionState(structure,state)` to `world.destruction`, and use `decodeDestructionState(structure,world.destruction)` for logic and view. The raw nested state does not fit the network depth/map-key limits. The supplied flat wire representation separates cluster poses from member links and uses float64 to preserve replay precision; no global state-shape limits are relaxed.

`damageStructure(structure,state,hits)` accepts hits with `memberId` or `bondId` and `amount`, applies the damage and resolves resulting support failures. Encode its returned state, and the state returned by each physical step, back into the declared world field. Never recreate initial state in each frame.

The JSON state retains `structureRevision`, `revision`, member/bond damage, broken member/bond IDs and detached clusters. Clusters retain poses, velocities and settled state. Persist the `wake` flag through the supplied wire helpers: damage can request a shared-batch recheck of settled rubble after its support changes. Do not clear it in game code before stepping. A saved state belongs to the exact compiled structure revision. Do not reuse it against changed source geometry without an explicit migration. Give gameplay hits stable event identity; repeatedly seeing the same event in a render or replay is not a new hit. Structural damage does not change the host's rules for player HP.

Damage weakens the affected structure, load redistributes through its remaining supports, and overloaded or unsupported pieces detach as connected compound groups. An alternate support can keep a beam standing. Removing its last viable support can cause a cascade. Prepare the fracture granularity once from the source asset; damage reveals and releases the prepared cells.

A failed member retains its geometry as a rigid fragment. Generate slab cells automatically as below, or author custom wall, column and trunk sections with breakable bonds. Grouping every wall of a house into one member produces a rigid ring that can still catch falling debris. Choose the fracture layout alongside the appearance and load paths.

## Automatically fracture a solid slab

`compileFractureSlab({id,seed,position,size,rotation?,cells,density?,strength?,durability?})` clips seeded Voronoi polygons in the two broad dimensions and extrudes them through the thinnest dimension. It supports wall, floor and roof slabs with an optional quaternion. The 2..48 cells fill the source box, have stable IDs, volume-derived mass, actual convex collision, continuous exterior UVs and separate cut-face triangles. Use `fractureMembers(slab,{maxSupportDistance?})` and `fractureBonds(slab,{capacity,durability?})` to construct the structural recipe. Capacity is force per neighbor connection; `slab.adjacency[].area` also lets a material model derive capacity from contact area.

Generated members are **unanchored**. Attach boundary cells to real posts, walls or foundations with directional support bonds. `maxSupportDistance` limits a cell's shortest surviving path through cohesive neighbors to a live bearing surface, measured in metres. The final directional leg measures from the member center to the target collider. The distance restarts on the next supported assembly, so this limits a slab span rather than total building height. Select bounds from actual construction; too small makes the untouched structure invalid, while an unlimited path can hold a corner across the entire floor. Cohesive loads route toward available bearings, and lost connections or exceeded spans can cascade into upper assemblies.

```ts
import {compileFractureSlab, fractureMembers, fractureBonds} from './fracture.ts';
const slab = compileFractureSlab({id:'upstairs',seed:417,cells:20,
  position:{x:0,y:3,z:0},size:{x:8,y:.26,z:8},density:650});
const cells = fractureMembers(slab,{maxSupportDistance:4.5});
const joins = fractureBonds(slab,{capacity:120000,durability:240});
// Combine cells and joins with actual support members and boundary bearing bonds.
```

Render `new FractureView(slab,exteriorMaterial,interiorMaterial).root`, call `update(state)` after each accepted state, and `dispose()` on teardown. It owns its geometry; the caller owns the shared materials. Ordinary Three materials, including recipe-generated textures, are supported. When wiring slabs manually, remove the source slab's old mesh and collider; otherwise an invisible solid will block the hole. The optional procedural preparation helpers and `PreparedDestructionView` above perform that replacement for prepared building/asset bundles.

`damageStructureAt(structure,state,{position,radius,amount,falloff?})` damages by closest distance to actual collider geometry. `falloff` is an exponent (default1 for linear,0 for uniform). Hits inside material receive full damage; geometry outside the radius stays untouched. Already-detached pieces use their current world poses, so subsequent hits can split surviving bonds in moving rubble. The geometry and IDs stay fixed; released cells do not recursively fracture into smaller cells. This is bounded prepared fracture, not arbitrary runtime mesh cutting.

## Use one physical step

### Ductile panels: dent and crumple before detaching

Add `deformation` to a `StructuralBinding` (or direct `StructuralMember`) for a thin sheet such as a garage door. It is opt-in and works in the same `prepareBuildingDestruction` / `prepareAssetDestruction` pipeline. Bind exactly one visible colliding box to that member. A member cannot also have a prefracture rule. The thinnest local box axis is its deformation normal; the other two axes form a 2, 3 or 4 segment grid. This is a bounded normal-displacement elastic/plastic panel model, not arbitrary 3D soft-body or automotive crash simulation.

```ts
{ id: 'garage-door', partIds: ['garage-door'], mass: 100, strength: 100000,
  durability: 200, deformation: {
    segments: 4, stiffness: 18000, damping: 80,
    yieldDisplacement: .035, plasticity: .9, maxDeflection: 1.2,
    ruptureImpulse: 6000, pinnedEdges: ['left', 'right', 'top', 'bottom'],
  } }
// Author a support bond to the real door frame, as for any structural member.
```

`stiffness` is N/m per node, `damping` is Ns/m, and displacement values are metres. Below yield the panel recovers; above yield it retains a permanent set. `plasticity:0` is elastic. The pin names refer to the panel's local grid, not screen directions. `ruptureImpulse` is a separate normal impulse threshold (N·s) for one accepted tick. Reaching it releases the deformed panel as rigid debris; it does not tear holes or subdivide it further. Losing the supporting frame can also detach it. Explicit `damageStructure` remains available for gameplay destruction.

Native contact impulses and gravity advance a surviving panel after the accepted rigid collision step. If an impact crosses the rupture threshold, the solver prepares its final dent and releases it during the collision prediction, so the existing `impactResponse:'coupled'` retry can transfer native momentum into the detached sheet. Speculative retries do not apply dents multiple times. The updated triangular-prism collision of a surviving panel replaces its old shape for subsequent ticks. This staggered approximation does not provide a fully coupled momentum-conserving flexible contact solver. Use small fixed ticks (1/60s), and tune the material against expected actor masses/speeds. Tangential impacts do not produce fictitious normal dents. Existing brittle materials keep their prior impact-damage path; ductile panels bypass that path and use their separate rupture threshold.

`PreparedDestructionView` replaces the original box automatically. It clips the original appearance against the panel grid, preserving UV coordinates and material groups, then updates normals from the accepted deformed shape. Both attached sheets and detached deformed debris retain the source material, including generated textures. Standalone `DeformationView(member, material, {geometry?})` accepts an optional original box appearance in physical collider-local coordinates; it owns only its generated geometry, not the caller's material/source geometry. When wiring standalone bindings, replace the intact box yourself with this view; the older rigid `BuildingDestructionView` / `AssetDestructionView` are not ductile renderers. The prepared projections invalidate query surfaces owned by a bent panel; recheck navigation rather than treating a dented floor as its old plane.

Persistent `DestructionState.deformations` records node offsets, velocities, plastic offsets and rupture state. Use the updated `destructionStateShape` / wire helpers, which flatten the nodes for network state. The solver allows at most 8 panels per structure and 25 nodes per panel. Each grid cell uses two actual convex triangular prisms: 4-segment panels consume all 32 colliders of one debris body. These count against existing scene and body limits. Lower grid detail or stream smaller regions when needed.

External liquid/pressure integration may pass `deformationContacts:[{structureId,memberId,point,impulse,radius?}]` to the destruction step; impulses are world vectors in N·s and are applied once alongside accepted native contacts. `deformStructure(structure,state,{dt,gravity?,contacts:[{memberId,point,impulse,radius?}]})` is the standalone equivalent; do not advance it again if the shared step already did so. `loadStructure(structure,state,[{memberId,force}])` applies temporary support loads in newtons through the authored graph without inventing hit-point damage. Reapply sustained loads each tick.

Call `stepDestruction({structure,state,scene,dt,bodies?,gravity?,contactLoads?,impactDamage?,impactResponse?,settleSeconds?})` from game logic. Its result contains updated `state`, `scene`, dynamic `bodies`, `impacts` and `impactsTruncated`. For interacting structures, call `stepDestructionWorld({structures:[{structure,state}],scene,dt,...})` once; its `states` array follows the supplied structure order. Include actors that must collide with debris in `bodies` and apply their returned poses to the corresponding stable actor IDs. `characterCompoundBody(state,tuning,mass=80)` builds the existing character's submitted body; `applyCharacterPhysicsResult(state,submittedBody,result,tuning)` accepts its result. Do not advance the same actors again in a separate physics step.

`contactLoads` defaults to `true`: the component of native contact force directed along gravity adds bearing load to attached members, so heavy bodies can overload weak supports without an explicit hit. Upward and sideways contacts do not become fictitious downward weight. Contacts without a normal, or worlds with zero gravity, retain the scalar force fallback. `impactDamage:{minimumImpulse,damagePerImpulse,minimumSpeed?,radius?}` separately enables material damage from impacts in any direction; its default minimum relative speed is 0.5m/s, and supported weight is subtracted before damage. Set `radius` to apply local geometry-based damage around the native world contact `point`; optional `normal` is the outward normal of the other collider. The strongest contact substep supplies these coordinates. Without `impactDamage`, explicit hits and contact loads still apply. Inspect truncation and capacity diagnostics; a bounded list of contacts is not a complete physics history. Settling retains rubble collision instead of deleting it.

Set `impactResponse:'coupled'` to let impact-induced failures participate in the same physical step. The solver predicts contact damage and support loss, rebuilds newly released sections as dynamic bodies, then replays that same timestep from its original poses and velocities. The accepted native contacts transfer linear and angular momentum into the debris: a heavy projectile can drive a breached wall inward, while surviving supports still resist it. No scripted velocity refund or fragment kick is added. Damage is counted once per stable collider pair and target, using the strongest prediction across retries. Only the accepted run supplies returned motion and impact records.

Coupling adds work only when contact changes the collision topology or wakes settled rubble. Newly released sections start at the beginning of the retried step, so use small fixed ticks such as 1/60s to limit this approximation. It allows at most three corrections (four native runs), and reports `impactResponse:{mode:'coupled',correctionPasses,limited}`. If `limited` is true, the last run's motion and damage are retained, but any newly released pieces from that final run receive their physical response on subsequent steps. Monitor this when tuning dense cascades. Omit the option or use `'deferred'` to retain the original one-run behavior. Both modes advance simulation time by exactly `dt`; the option does not change the saved state format.

`prepareDestructionScene(structure,state,baseScene)` replaces structural statics and adds settled rubble. Structural collider ownership uses `structuralColliderId(structure,memberId,index)`; bindings provide consistent ownership for their compiled geometry. Remove the original untagged building/asset colliders from `baseScene` first: the helper cannot recognize those duplicates from appearance. It retains unrelated static geometry and terrain. Keep scene inputs immutable so unchanged preparation can reuse its cache, and integrate changed collision in the existing preparation/streaming lifecycle. Do not keep a second copy of the intact building collider beneath visible debris.

For terrain hosts, supply `createTerrainWorld(recipeFor,{collisionEdits:(world,tuning)=>destructionTerrainEdits(structure,decodedState)})`. Decode the callback's supplied `world` with `decodeDestructionState`; use initial state only when that world field is absent. The callback receives the same wire-equivalent state as ordinary terrain edits. Its `{remove,add}` arrays contain full collider descriptors: removals match the original descriptor, including optional IDs, at the shared physics precision. `destructionTerrainEdits` returns those source removals and current attached/settled colliders. For multiple structures, concatenate each helper result's removal and addition arrays.

The collision overlay allows at most 512 removals and 512 additions; accepted scenes must still fit existing native budgets. Changes revise physics, clearance, spawn queries and prepared-transfer identity without regenerating terrain heights, colors or instances. Streamed additions are clipped to loaded chunks; persisted removal descriptors reapply when chunks return. Save the destruction state, not a disposable chunk-local removal. Reprepare through the existing host lifecycle after changes; stale-damage transfers are rejected. Collision-only edits do not alter visual instances: use the matching destruction view and remove its original intact renderer, or author a corresponding instance edit. Moving debris remains in the shared physics batch.

The view must remove detached pieces from the intact representation and draw each cluster with its current transform. Use `destructionView` with its matching binding, or integrate a custom renderer against those same member IDs and poses. Material recipes remain ordinary authored finishes. Collision and view updates are one state transition; hiding a wall is not destruction if its static collider remains.

## Bind existing buildings or families

`compileBuildingStructure(building,bindings)` accepts a valid `BuildingManifest`. `compileAssetStructure(model,bindings,pose?)` accepts a validated family model and optional world position/yaw. Both use `StructuralBindings`: `{id,version,gravity?,members,bonds}`. A member names `partIds`, optional `surfaceIds`/`lightIds`, mass, strength, optional durability/anchor and optional world-space center of mass. When position is omitted, the adapter derives it from owned geometry. Every compiled part, walkable/support surface and fixture light must be owned exactly once, including decoration and each solid stair tread and its support surface. Split long stair flights across members when their colliders would exceed a member's existing budget. Support bonds remain authored; walls touching floors do not infer them.

Compiler-generated building parts with `attachmentParentId`, such as gable enclosure infill, inherit their parent's member when omitted from explicit bindings. Explicit ownership takes precedence; inheritance adds matching render/collision geometry while preserving authored mass, center of mass and support bonds. An inherited child makes its member compound. To fracture the parent as a box slab, bind the child separately and author its support bond; convex enclosure geometry itself remains a rigid part.

`projectBuildingDestruction(building,structure,state)` and `projectAssetDestruction(model,structure,state)` retain the original coordinates while removing detached components from their static projection. Their remaining colliders carry structural ownership IDs. Building projection removes corresponding support surfaces and lights and reports `navigation:'not-revalidated'`; it does not certify new routes or preserve the original navigation claims after a wall or floor falls. Feed the projection to support queries and recheck affected movement.

`new BuildingDestructionView(building,structure,state,options?)` exposes `root`, `update(state,focus)`, cutaway support, `readyMaterials()`, `inspection()` and `dispose()`. `new AssetDestructionView(model,structure,state,options?)` exposes the same lifecycle with `update(state)` and no building cutaway. Attach `root` once, update from accepted authoritative state, and remove the old intact view. Building views reuse the shared material cache and rebuild attached geometry when membership changes; pose-only movement updates group transforms. The views do not compute damage or physics.

## Budgets and checks

The structure supports at most 64 members, 256 bonds, 256 colliders overall and 32 colliders per member. The compound physics step supports at most 64 bodies, 256 colliders overall and 32 per body, counting actors and debris together. Unstreamed physics scenes retain a separate 96-static-collider limit; streamed terrain scenes use `PHYSICS_SCENE_LIMITS`. The existing runtime budgets still apply; the older 32-body API retains its own contract. Choose coarser authored or generated cells when the intended detail does not fit. Box slabs are currently supported; arbitrary watertight mesh fracture and recursive fragment subdivision are not implemented. Never silently omit a physical piece to pass a budget.

Test an untouched structure, an alternate support, loss of the final support, overload cascades, state serialization, actor/debris contact and settled rubble. Check that old static collision and intact meshes are removed once and that resources are disposed. Inspect before/after states using ordinary gameplay inputs and a repeatable seed; graph connectivity alone cannot establish collision, movement or traversability.

This is a simplified game model. It does not provide engineering fidelity, continuous material stress analysis, arbitrary mesh fracture, or automatic multiplayer hit deduplication. Authored graphs, custom geometry and custom game rules remain the source of creative intent.
