# Model assembly for Game builders

## Neutral body plans

Starters describe a body plan, not an animal species. The quadruped has only a
body, four legs, a head and a tail in neutral gray. The same starter can become a
cat, lion, dog, wolf, elephant, bear, horse or lizard. Its dimensions and sample
walk are placeholders, not design constraints. Leg attachments follow body size.

Choose anatomy for the requested creature: replace a head or tail with any
supported primitive or a multi-part assembly; add a neck, trunk, ears or other
features as needed. Nothing locks a tail to one shape or length. Parts can be
added, split, removed or reparented. When names change, update their attachment
references, grounding list and animation tracks. Adapt the gait and inspect the
result after structural changes. Geometry checks do not judge resemblance to an
animal or guarantee a natural gait. Current primitives are boxes and spheres
(equal diameters); assemble several parts for more complex silhouettes.

## Shared animations and joints

`attach.mode: 'joint'` permits rotation and overlap at an attachment pivot. It
still rejects detached parts and translated pivots. Fixed surface attachments
remain the default. Parents are automatically ordered; missing parents and cycles
are errors. No special file ordering is required.

`animations` contains named clips with `durationMs`, `loop`, and increasing
`keyframes: [{atMs, pose}]` from zero through duration. Loops must close without a
pose jump. `sampleModelAnimation` is used by `ModelView.animate`, previews and build
checks. Inspection covers every keyframe plus uniform time samples. This is sampled
validation, not a proof for every possible instant.

Use `view.play(clip, simulationTimeMs)` to start a clip on selection and track its
elapsed time automatically. Use `view.animate(clip, elapsedMs)` when authoritative
state already supplies the elapsed time (for replayable attacks, jumps, etc.).

`grounding: {parts: ['frontLeft', ...]}` translates all roots together to keep the
lowest selected support on y=0. It recalculates when proportions/poses change.
This is a simple flat-floor gait; it does not solve knees, terrain contacts, or
foot sliding. Set a clip's `grounding: false` for airborne animation.

### Layered actor animation

The shared actor runtime is available to ordinary game files and native features:

- `sandbox/animation.ts`: quaternion poses, keyframed or procedural clips,
  weighted layers, joint masks, and timed actions with interruption policies.
- `sandbox/animationView.ts`: `ThreeAnimationRig` maps semantic joint names to
  existing Three.js nodes and applies motion relative to their rest transforms.
- `sandbox/locomotion.ts`: motion prediction, distance-based gait phase, authored
  locomotion blend selection, foot placement and two-bone limb math.
- `sandbox/motionMatching.ts`: a sampled pose/trajectory database, indexed
  nearest-frame search, and continuity-aware playback transitions.
- `sandbox/animationImport.ts`: conversion of compatible sampled transform data
  into shared clips using explicit joint, rest-pose and unit mappings.
- `sandbox/creatureAnimationLibrary.ts`: discover the built-in creature
  banks, load a compatible source rig and blend its available semantic actions.
- `sandbox/creatureAnimationView.ts`: build a bank's actual Bone hierarchy and
  animation adapter for custom geometry; `creatureRigs.ts` describes its rest data.
- `sandbox/creatureModelView.ts`: create the original CC0 skinned body using the
  same bones and animation adapter; `dispose()` releases owned render resources.

The [creature animation guide](creature-animation-import.md) includes a complete
portable feature example using catalog discovery, cached banks and a controller.
Creature families keep source-specific skeletons and explicit coverage; their
clips do not automatically supply measured foot contacts or predictive paths.

`MotionMatcher` reserves enough remaining time when entering a one-shot for its
prediction horizon and transition, avoiding repeated jumps into exhausted clips.
It still plays selected clips through their end. `playbackRate: 0` explicitly
pauses animation: releasing movement should change the predicted path while the
stop animation continues playing. With replicated state, use the reported
velocity for playback speed; repeated position snapshots between simulation
updates do not mean the actor has stopped. Inspect playback rate, selected clip
time and blend progress together when diagnosing a stalled transition.

For example, a view can animate a body group without assuming humanoid anatomy:

```ts
import { AnimationPlayer, defineAnimationClip } from '../sandbox/animation.ts';
import { ThreeAnimationRig } from '../sandbox/animationView.ts';

const idle = defineAnimationClip({
  durationMs: 2400, loop: true,
  sample: ({ phase }) => ({
    body: { scale: { x: 1, y: 1 + 0.02 * Math.sin(phase * Math.PI) ** 2, z: 1 } },
  }),
});
// Construct once while bodyGroup is at rest. The actor root still owns world movement.
const rig = new ThreeAnimationRig({ body: bodyGroup });
const animation = new AnimationPlayer({ idle });
// Each frame, using the simulation timestamp:
const result = animation.sample({ timeMs: frame.now, layers: [{ clip: 'idle' }] });
const mapping = rig.apply(result.pose);
// Surface result.diagnostics and mapping.unmapped during authoring.
```

For attacks, supply a stable action ID and authoritative `startedAtMs`; restarting
an action every frame prevents it from progressing. Use `epoch` when a session
restarts. Clip/action times are milliseconds; locomotion time and delta are
seconds. `quaternionFromEuler` takes XYZ radians. `AnimationPose` contains
rest-relative translations, quaternion rotations and scale, while the older
`RigPose` still uses degree angles. Existing `mixPoses`, `addPoses`, `RigAnimator`
and `ModelAnimation` behavior is unchanged; they are not interchangeable formats.

`ThreeAnimationRig` supports explicit rest-axis and translation-scale mappings.
Use compatible semantic joints to reuse clips; different anatomy needs an
appropriate mapping or different motion. It can own poses on `RigView.joint()`
nodes after construction, but do not also call `RigView.apply` over those nodes
in the same frame. `ModelView` still owns its assembled part transforms and its
existing clips; mapping a whole model root is supported, but its internal parts
are not automatically converted into a new skeletal hierarchy.

Locomotion prediction guides animation and does not move the authoritative
character. Contact helpers require explicit physical support and limb geometry;
they do not discover terrain or stairs automatically. `selectLocomotionBlend`
uses authored speed/direction samples; `MotionDatabase` / `MotionMatcher` provide
the separate indexed motion-search path described below.

A base view can optionally expose `inspection(): Record<string, unknown>` with
current animation layers, phases, action IDs, contact status and fallback reasons.
The inspector calls it only on capture frames, after `update`, and stores the
result in `capture.viewDiagnostics`. These are **authored self-reports**, separate
from the authoritative simulation state and rendered images. Return plain finite
JSON under 16 KiB; oversized, malformed or failed hooks produce explicit
`truncated` / `error` evidence without failing ordinary rendering. Normal
`info()` remains the numeric gameplay input channel. Composed feature views retain
the base inspection hook; feature-specific diagnostics need an explicit base
adapter rather than a second inspection registry.

### Searching motion frames

Create one `MotionDatabase` for a compatible collection of clips. Its schema
declares sampled joint features and future trajectory times; sources provide
each clip and its reference trajectory. The database samples individual frames,
normalizes and weights their features, then builds a nearest-neighbor index.
This chooses a position within a clip, rather than merely mixing a few named
walk/run animations by speed.

Use `MotionMatcher` for an actor's playback. Supply the current pose and a desired
trajectory in the **same coordinate space and time offsets** as the database,
with compatible rig and tag filters. Author trajectory metadata to match the
actual source motion, including turns, starts and stops. A library of straight
running loops cannot supply a convincing stop animation that was never authored.
Current velocity and requested movement intent are distinct signals: physics
may block a character that still wants to move. Keep both explicit and leave
collision authority in gameplay.

The matcher searches at bounded intervals, favors useful continuity, and uses
inertial transitions by default; `transition: 'crossfade'` is also available.
Position velocity and quaternion angular velocity have separate schema weights;
provide `previousPose` and `poseDeltaMs` when using either. Non-looping sources
default to `endBehavior: 'select'`, selecting another frame at completion. Use
`endBehavior: 'hold'` only for intentional terminal poses. Foot contact and other
post-processing weights must also transition smoothly with the selected pose.
Expose its selected clip/time, score, candidate count,
visited frames, transition weight and warnings through `GameView.inspection()`.
Compare turns and start/stop scenarios with the same inspection inputs. The
indexed and brute-force search paths can be compared for the same query when
checking a new schema; search correctness alone does not establish visual quality.

Build the database once per clip collection, not on every rendered frame.
Package clips, source trajectories and schema together in the feature. Rig/tag
filters improve compatibility; they do not infer anatomical meaning or perform
automatic skeleton retargeting.

### Importing compatible animation assets

`compileAnimationImport` accepts decoded local transforms: source rest pose,
timestamped frames in seconds, semantic joint mappings and an explicit unit
scale. Each mapping names its source joint and can specify reference transforms
and rotation/translation bases. The result contains ordinary shared keyframes,
reference pose, diagnostics and optional root-motion metadata. Root travel is
kept separate from the in-place pose and is **not authoritative movement**.

Validate a saved artifact before registering it. When it contains extracted
root motion, the same metadata can describe its motion-search trajectory:

```ts
import data from './walk.animation.json' with { type: 'json' };
import { validateImportedAnimation, importedRootTrajectory } from '../sandbox/animationImport.ts';

const walk = validateImportedAnimation(data);
if (!walk.rootMotion) throw new Error('This library needs explicit reference travel.');
const root = walk.rootMotion;
export const walkSource = {
  id: 'walk', rig: 'my-compatible-rig', clip: walk.clip,
  trajectory: (timeMs: number, afterMs: number) =>
    importedRootTrajectory(root, timeMs, afterMs, !!walk.clip.loop),
};
// Include walkSource in MotionDatabase.sources; query with the same rig/schema.
```

For a native feature directory, use `../../../sandbox/animationImport.ts`.
`importedRootTrajectory` returns displacement and direction in the root's current
local frame. It accumulates extracted travel/rotation across loop boundaries and
clamps non-looping clips; root samples retain their initial orientation in the
declared root-parent space.
An in-place source without extracted travel needs an authored trajectory;
do not label a stationary root as measured walking displacement.

Normal AI tools can create or modify this TS/JSON data inside the feature and
use the resulting clips in `AnimationPlayer` or a motion database. Read the
`animationImport.ts` API reference for the exact data shape. Source and target
joint names, rest axes, units and sampling coverage must agree; missing mappings
and unsupported data should be corrected before claiming a successful import.

For already-owned local GLTF/GLB/FBX files, `scripts/import-animation.ts` is an
offline preparation step. It lists available clips and converts the selected
clip with a supplied mapping into portable JSON. This CLI is separate from the
restricted connected-AI and built-in AI tool surfaces, which currently edit
TS/JSON rather than upload or decode raw binary assets. Conversion does not
download assets or supply permission to distribute them. Keep source/license
provenance with the feature and use assets whose terms permit the intended game
and reusable-mod distribution. No Epic animation asset library is bundled.

```sh
npm run import:animation -- --input ./walk.glb --list
npm run import:animation -- --input ./walk.glb --mapping ./rig-map.json --output ./walk.animation.json --clip Walk --start 0 --end 2 --fps 30 --loop
```

The mapping supplies `unitScale`, semantic `joints` with source names or canonical
paths from `--list`, and optional separate `rootMotion`. Output contains 2–128
frames; trim long clips or lower the sampling rate rather than silently dropping
samples. Existing output files are never overwritten.

## Custom definitions

Put a default-exported model in a `.model.ts` file under `src/game`. Custom builds
discover these files automatically. Import the same definition into your view and,
if needed, logic. Existing manually created meshes keep working; they are not
automatically converted or geometrically inspected.

Parts default to boxes. For a sphere, set `shape: 'sphere'` and give `size`
equal X/Y/Z diameters, e.g. `{x: .44, y: .44, z: .44}` for radius .22.
Unequal diameters (ellipsoids) are rejected. Sphere-to-sphere attachments solve
the curved contact surface even with a tangential offset. On a sphere, attachment
faces name hemispheres. Sphere/box contact uses the box's actual rotated surface,
not overlapping world bounding boxes. Mixed-shape placement uses face support
extents; large sideways offsets may need adjustment if the contact check fails.

```ts
// src/game/critter.model.ts
import { defineModel, repeatModelPart } from '../sandbox/model.ts';

export default defineModel({
  name: 'critter', root: 'body', ground: 'required',
  parts: [
    { name: 'body', size: { x: .7, y: .6, z: 1.2 },
      position: { x: 0, y: .75, z: 0 }, color: 0xffffff, collision: true },
    { name: 'head', size: { x: .4, y: .4, z: .45 },
      attach: { part: 'body', face: 'front', sink: .025 },
      position: { x: 0, y: .25, z: 0 }, color: 0xffffff },
    ...repeatModelPart({
      size: { x: .15, y: .45, z: .15 },
      attach: { part: 'body', face: 'bottom' }, color: 0xffffff,
    }, [
      { name: 'frontLeft', offset: { x: -.22, y: 0, z: .42 } },
      { name: 'frontRight', offset: { x: .22, y: 0, z: .42 } },
      { name: 'backLeft', offset: { x: -.22, y: 0, z: -.42 } },
      { name: 'backRight', offset: { x: .22, y: 0, z: -.42 } },
    ]),
  ],
  poses: [{ name: 'hop', ground: 'above',
    pose: { body: { move: { x: 0, y: .08, z: 0 } } } }],
  samples: 3,
});
```

In `src/game/view/critter.ts`:

```ts
import model from '../critter.model.ts';
import { createModelView } from '../../sandbox/modelView.ts';
const view = createModelView(model);
// actors.add(view.root), or an existing RigView.attach('socket', view.root).
view.apply({ body: { move: { x: 0, y: .08, z: 0 } } });
// Call view.dispose() when removing the model.
```

`position` is a root's centre, or an additive offset in its parent's frame for
attachments. `align: {x: -1, y: 1}` aligns the low X and high Y edges; only axes
tangential to the chosen face apply. `sink` is permitted overlap depth; `gap`
leaves empty space. Use `mirrorModelPart` for a reflected pair, and
`repeatModelPart` for arbitrary named offsets. Parents are sorted automatically.
Attached children inherit parent motion and rotate about their face pivot.
Pose rotations are relative to the part's rest rotation, in XYZ degrees.

Use `collision: true` to select parts for `modelBounds(model, pose, true)` or
`modelCollider(model, pose)`. The latter returns an enclosing vertical cylinder
with its centre and height. No selection returns null. These are helpers for
authoring collision shapes; they do not change damage or physics automatically.
Keep conservative visual-derived bounds separate from intentionally designed
gameplay hitboxes when appropriate.

Each custom build returns `validation.models` with file/model/part/pose names,
bounds, collision bounds, diagnostics and counts. Disconnected parts, broken
declared attachments and ground violations block the build. Completely buried
parts produce warnings. An attachment must still meet its declared face within
the permitted sink depth; touching an unrelated neighbour does not satisfy it.

Intentional floating or internal geometry needs an `allowFloating` or
`allowBuried` reason on that part. Floating parts can anchor their own connected
assemblies. Ground checks are independent: `required` checks contact and excludes
below-floor geometry; `above` permits airborne poses; `ignore` skips the floor
check. Rest defaults to required, listed poses and transition samples to above.
Transitions use the destination pose's ground policy. This handles a bobbing
critter without falsely calling its whole body detached from the ground.

Sphere contact uses centre distance; sphere/box contact uses the closest point
on the oriented box. Rotated box contact uses the separating-axis test, including edge-cross axes.
Reported gaps are separating-axis clearances, not exact Euclidean distances;
the nearest connected candidate is ranked by this clearance. The direction
points toward that candidate. This supports useful repairs without claiming an
exact nearest-surface solver.

Animation checks sample rest, named poses, and intermediate linear moves/XYZ
angles. They do not prove continuous contact, cover external rig motion, or
follow arbitrary easing curves. Include extra key poses where motion bends or
reverses. Rendered inspection is still necessary for appearance. Meshes other than boxes/spheres,
external scaling/shear, post-render mutations and shader displacement are outside
these checks. `visualInspection` remains `not_run`.

Limits: 32 model files per build, 48 parts per model, 12 named poses, 6 animation
clips (2–16 keyframes and 2–16 uniform sampling intervals each), up to 8
intermediate samples per transition, 200 displayed diagnostics per model. Total
error/warning counts survive truncation. Authored model modules run in QuickJS
with time, memory and output limits; the build host never executes them directly.
Ellipsoids and other unsupported shapes require their own geometry tests.

Preview workers are capped at two active and eight locally queued jobs per
process, with a four-second deadline for JSON and eight seconds for source previews,
and a 128 MB V8 heap limit. Source compilation uses only an in-memory allowlisted
file map. QuickJS evaluation including serialization has a one-second deadline
and 32 MB limit. Game sources are capped at 2 MB, expanded model JSON at 100 KB.
Production evaluation/inspection/rasterization stays off the match host. Account
limits are shared across instances. These free previews do not replace full
build/typecheck/gameplay tests.
