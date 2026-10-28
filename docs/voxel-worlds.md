# Editable block worlds

For a Minecraft-style game, use `VoxelField`, `createVoxelWorld` and
`VoxelWorldView`. A heightfield alone cannot describe mined tunnels or block
overhangs. These helpers use the existing terrain preparation/transfer host and
native Rapier boxes; do not introduce a second player collision solver.

Import these shared modules directly instead of vendoring their implementation.
`createVoxelWorld` supplies cheap `synchronized` readiness and speculative
`prefetch`. The live match worker requests one idle preparation unit through its
existing admission gate; this warms future chunks without changing accepted
collision, advancing game time, or accumulating a generation queue. Required
collision remains a hard movement boundary, including teleports and cold starts.

The voxel view host opts into background preparation after initial readiness.
Ordinary frames advance one collision preparation unit while continuing to draw.
`VoxelWorldView` keeps the old mesh until its replacement is complete and current,
reuses unchanged column surfaces, limits generation to 128 fresh column steps,
targets 3ms of generation work per update, and
discards stale work on edits, eviction and disposal. This is a bounded-work
target, not a guarantee that an arbitrary authored sampler finishes in 3ms.
Initial construction and fixed-time inspection drain the same mesh work before
display; inspection rendering is not evidence of device frame rate.

Controls and HUD do not depend on prediction collision readiness. The client
keeps delivering inputs while prediction waits for matching collision geometry.
The host's sparse `editIdentity` also distinguishes consecutive edits while an
authoritative revision is pending, so old worker geometry cannot adopt against
a newer edit context. Unrelated world-clock changes do not restart that work.
Voxel collision planning runs during preparation, including the first edit after
adopting a transferred scene. Metadata synchronization only records sparse state;
the main client never regenerates base columns to validate that scene. Custom
streamed hosts can use `collisionIdentity` for the same deferred plan contract.
Avoid game-specific loading overlays or timer workarounds. Engine regression
coverage includes actual live match workers, repeated edits and continued input;
offline inspection/replay uses a larger correctness budget and cannot establish
live responsiveness.

Mesh grouping and typed-buffer assembly also yield within that shared frame
budget. Ordinary frames install at most one finished mesh, retain typed storage
without another attribute copy, and use known chunk bounds instead of scanning
vertices during first render. Render-side collision preparation has a smaller
16-unit slice. The default column cache fits a 3x3 chunk horizon plus seams.
Finite voxel worlds install native perimeter walls in the shared collision
scene so walking or jumping cannot create out-of-world preparation interests.

For live measurements, open the application with `?frameprofile=1`, start Play,
then choose **Start frame sample** after initial loading. Explore new chunks,
mine, and stop the sample. The local panel records p50/p95/p99/max and counts
above 33.34/50ms for page intervals, completed-view intervals, worker round trips,
preparation and update CPU. It stops on hidden/resized pages and bounds retained
samples. It does not force GPU completion or claim physical display timestamps.
Retain the viewport, pixel ratio, backend, route and full spike counts; report
remaining hitches rather than inferring smoothness from an average or a build.
Live readiness keeps its 4ms thread-CPU limit. Offline builds and inspection use
their existing bounded correctness allowance for readiness as well as steps;
container scheduling delays are not evidence of live frame latency.

Prediction uses a 24m lookahead radius for the opt-in 32-cell voxel host. It
requests the next collision neighborhood while its current neighborhood is
still valid. Transfer pieces do not suspend prediction; the final guest/native
collision switch happens in one task. Required missing coverage still blocks
prediction until its exact geometry is installed.
Queued obsolete lookahead positions cannot keep cancelling an active transfer.
The frame profiler also reports prediction attempts, terrain-blocked attempts,
blocked duration, collision adoptions, local edit installations, and a server-patch-age distribution.
Rendering cadence alone cannot establish smooth movement or server progress.

Edit transfers can reference the last activated cache by checksum, reusing
unchanged chunk manifests, heightfields and colliders. Only changed pieces cross
the VM boundary; each reference and count is checked, and large or incompatible
changes retain the sliced full-transfer fallback. A finished but unactivated
cache cannot become a reuse base. Test walking and continuously mining together,
including floor removal and placement; stale collision must never be used to
hide a pause. Legacy compiled games need rebuilding to gain this transfer API.

For edits inside loaded voxel coverage, the prediction VM retains the original
immutable solid boxes. It applies the same sparse cut/placement algorithm as
authority and installs the resulting native collision before the next prediction.
This avoids a worker round trip for mining and placing; it does not invent a
second movement solver or predict against stale solids. Source descriptors are
primed in bounded slices during chunk loading. Missing coverage, changed tuning
and hosts without this capability retain the worker preparation path. Authors
using `createVoxelWorld` receive this automatically after rebuilding their game.
Validate continuous walking with both mining and placing: local edit counts
should increase without terrain-blocked time for edits in loaded coverage, and
the resulting collision must match independent worker preparation exactly.
Native scene edits retain validated unchanged boxes and heightfields, send only
changed collider descriptors plus the complete collider order, and check the
accepted scene generation. The native snapshot keeps full-scene insertion order
and independent solver state. A bounded local-edit timeout falls back once to
worker preparation instead of permanently disabling prediction; the profiler
reports `terrainLocalEditFallbacks` so this is visible rather than hidden.

Export-only preparation skips native physics installation; the consuming VM
installs the exact scene at activation. Versioned tree checksums reuse only
deeply immutable pieces, while accepting legacy whole-document checksums.
This bounds repeated edit work by the changed geometry rather than re-hashing
all resident terrain. Mutable inputs are always checked again.
Unchanged cut pieces and deeply immutable collision descriptors also retain
their validated copies; adding an edit does not revalidate every prior cut.

Author a pure integer-coordinate material sampler, seeded noise, biomes, trees,
ores and caves. Zero is air. Choose which materials are solid (water can be
visible but nonsolid). Supply centered finite XZ bounds, a bounded vertical
range, and a numeric tuning seed. The helpers impose no species, terrain style,
crafting rules, inventory or survival design.

`createVoxelWorld({field,seed,edits})` returns `terrainWorld` and `field(tuning)`.
Expose the host on logic and view. Use its accepted `.scene` for shared
`moveCharacters`, prediction and native ray queries. Its heightfield is actual
unmineable bedrock at `minY`, with solid column runs above it. Resolve spawns
from the voxel field, not the bedrock heightfield. Base terrain support queries
still describe bedrock; use real physics for support on voxel surfaces.

Put sparse `{x,y,z,material}` edits in declared authoritative world state and
project that complete list through `edits`. The sampler is the baseline, never
mutable match storage. Edits replace affected native solids with exact cut pieces and
survive chunk unloading. Check collision readiness before interactions near a
streaming boundary. Use exact `field.raycast` for block/face selection; use the
same camera eye/direction on authority and in the view.

`VoxelWorldView` emits exposed faces, checks neighbors across seams and batches
by material. The caller supplies materials, lighting, camera and a bounded
chunk horizon, and disposes caller-owned materials separately. Do not create
one mesh/draw call per block or per exposed face. Check construction of new
chunks over several frames if the selected horizon is expensive.

Bounds are explicit: at most 256 sparse cell edits in this initial helper,
512 removed/512 replacement native collision runs, 32-cell XZ collision chunks,
128 resident terrain chunks and the existing native scene/memory budgets.
Edits can span fewer cells when cave columns have many separated solid runs.
Reject over-budget edits before committing state; never truncate geometry.
This is a reusable finite-world foundation, not infinite terrain, saved account
worlds, fluid simulation, networking correctness or a complete Minecraft game.

Validate different seeds, ordinary traversal/jumping/landing, mining a tunnel,
placing a block and landing on it, native side/ceiling contact, negative chunk
seams, multiple players, edit budget failure and unload/revisit. Compare visible
geometry with actual collision. Retain rendered evidence from the connector;
a compile or a block count alone cannot establish quality.
