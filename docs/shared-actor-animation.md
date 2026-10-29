# Shared actor animation

PatchGames now has one presentation pipeline for base characters and reusable
appearance mods. `ActorAnimationController` selects a locomotion pose, applies
held-item weight response, composes clips and actions, adapts the pose to a body,
applies its rig, then runs optional contact corrections. Movement, collision,
damage and cooldowns remain authoritative
gameplay state; the controller never moves the gameplay root.

## Current integration and design direction

All four base modes supply common actor signals and use the controller. RPG
adventurers retain their detailed humanoid bodies and motion matching; RPG raiders
and the Gatekeeper use custom procedural profiles. Arena now uses the detailed
shared humanoid starter. Duel and Just Chatting retain their existing bodies and
editable motion profiles for this migration.
The lounge preserves sitting clearance, first-person shadows and mirror behavior.

**Future rebuilt base-mode humanoids default to the detailed 25-joint skeleton
from `createHumanoidSkeleton()` and `HumanoidLocomotionDriver` motion matching.**
The temporary legacy Duel and lounge bodies are compatibility adapters,
not the final character architecture. Redesigning the base games follows the
animation and procedural-terrain upgrades, so those games can exercise the same
finished creation tools available to the AI.

This default does not prescribe visual style or anatomy. Attach simple or detailed
geometry, armor and equipment to the shared humanoid, or map compatible imported
meshes onto it. Birds, quadrupeds, machines and invented creatures can keep their
own skeletons, motion banks and procedural drivers. A bird does not need humanoid
bones. New body proportions still require suitable rigging and contact tuning.

## Inputs that travel between modes

`GameView.actorSignals(frame)` adapts the current frame into
`ActorPresentationSignals`. Feature views receive these as
`frame.players[].presentation`, alongside the existing player pose. Optional
fields include position, observed and intended velocity, facing/up, grounded
state, posture, parameters, actions, actual support samples and a future world
trajectory. `id`, `timeMs` and `epoch` identify the actor and its animation clock.
Old bases may omit presentation signals; a feature must choose a deliberate
fallback rather than reading another mode's private state.

Use one controller per actor and share immutable clips or motion databases.
Identity changes, epoch changes, clock rewinds, long gaps and explicit resets
clear continuity. Shared diagnostics report reset reasons, selected motion,
layer/action progress and bounded warnings through the normal inspection path.

Exact sample sharing runs automatically. Defined keyframe clips keep their
immutable identity across players; the engine also recognizes privately decoded
creature clips and humanoid motion sources. A bounded cache reuses interpolation
and source-feature calculations at the exact requested time. It does not
quantize playback, skip frames, or share mutable actor poses. Every returned pose
is detached. Authored procedural callbacks still run because they can depend on
live actor state; freezing a function does not make that state immutable.
There is no animation-cache setting to enable. `ThreeAnimationRig` also reuses
its validated pose/vector/quaternion buffers and updates each mapped hierarchy
once, including matrix-driven sockets and dynamically reparented joints.

Transient effects use `ObjectPool` from `src/sandbox/objectPool.ts`. The engine's
Arena arrows and Duel spark bursts reuse object hierarchies automatically.
Custom effects should acquire objects when they appear, release them when they
expire, and reset every per-effect transform/material reference in the pool's
reset callback. Retained storage is bounded; `dispose()` cleans both idle and
active objects. Dispose shared geometry/materials once with their owning view,
not when an individual pooled effect expires. A borrowed `AnimationPoseBuffer`
result is scratch storage valid only until that buffer's next read; keep separate
buffers for independent owners.

Body rotation also needs blending: motion matching blends joint poses, not the
host's world-facing transform. `ActorHeading` supplies a shortest-arc visual turn
and a child `offsetYaw` while gameplay facing responds immediately. Feed its
`forward` into the motion query and contact hooks so they match the rendered body.
The humanoid mod starter does this automatically, with RPG's 20/s response;
`turnResponse: 0` deliberately opts into instant turns. Its inspection report
includes actual and target headings. Rewinds, new actors/epochs and long frame
gaps reset the heading rather than interpolating across unrelated frames.

Timed actions need stable instance IDs and start times. A base adapter can keep
one `ActorActionTimeline` per actor when reconstructing starts from network
countdowns: the first observed start for an ID is retained, and repeated reads
of a frame are idempotent. It does not invent an attack or extend gameplay timing.
When a base only exposes an attack countdown, use that observation directly as
a layer parameter. A model maps semantic actions to its own clips or deliberately
filters unsupported actions; clip names are not a universal ability system.

## Customization and portable mods

The controller exposes replaceable `locomotion`, editable `clips` and `layers`,
`adaptPose`, `afterApply` for IK/contact constraints, and `onReset` for local
continuity. `equipmentMotion: false` opts out of the default carry response;
`equipmentLoads(context)` supplies explicit loads for a custom rig.
`ThreeAnimationRig` binds local deltas to arbitrary Three.js nodes.
Custom samplers and geometry remain ordinary editable feature code.

## Shortest working integration

In a view module under `src/game/`, create the skeleton and controller **once per
actor**. Attach your geometry to its joints and put `body.root` under the game's
authoritative actor root. The skeleton contains bones, not a visible character:

```ts
import { createHumanoidSkeleton } from '../sandbox/animationView.ts';
import { ActorAnimationController } from '../sandbox/actorAnimation.ts';
import { ActorHeading, HumanoidLocomotionDriver } from '../sandbox/actorLocomotion.ts';

const body = createHumanoidSkeleton();
const heading = new ActorHeading();
const animation = new ActorAnimationController({
  rig: body.animationRig,
  locomotion: new HumanoidLocomotionDriver(),
});
// Each frame, after gameplay positions/orients the actor:
const direction = heading.sample(player.presentation);
body.root.rotation.y = direction.offsetYaw;
const result = animation.sample({ signals: {...player.presentation, facing: direction.forward} });
// Retain the latest result.diagnostics for the view's inspection() hook.
```

The host supplies `player.presentation` through `actorSignals`. On an older host
that omits it, supply a deliberate idle fallback with the actor's ID and current
frame time. Add only the action clips your character implements; filter or map
unsupported semantic actions explicitly. Do not recreate controllers or the
motion database in `update()`. Share clip definitions, keep controller state per
actor, and dispose owned skeletons, geometry and materials when actors leave.

The humanoid driver aligns its motion query to the current presentation time.
If writing a custom driver around `MotionMatcher`, use
`matcher.continuation({timeMs, epoch, reset, playbackRate})` for the query's pose
and centered velocity samples before calling `sample()` with the same frame.
It previews uninterrupted playback, including an active blend, without changing
matcher state. Supply your own trajectory and contacts; before initial playback
or after a discontinuity, supply your initial pose. Reusing the previous render
frame's pose can favor backward seeks and unrelated turning clips, particularly
at lower frame rates. The shared driver handles this automatically.

For generated terrain, use the same accepted manifest for `TerrainView`,
`terrainPhysicsScene` and `terrainActorSupports` from `terrainQueries.ts`. In the
base's `actorSignals(frame)` adapter, the support field is:

```ts
supports: terrainActorSupports(manifest, { ground: actorPosition }, frame.now)
```

Set `position`, `velocity`, `facing` and `grounded` from gameplay; provide
`intendedVelocity` only when actual input/controller intent is known. The helper
omits outside-map points and does not infer whether an actor is standing on the
terrain. Query other colliders separately for bridges, platforms or indoor floors.
Fresh support improves trajectory prediction, but does not automatically perform
humanoid foot IK. Apply optional contact work through `afterApply` using real
limb supports. Terrain replacement and teleports must reset presentation continuity
using `epoch` or `reset`; ordinary repeated frames must not.

The [Wayfarer fixture](../tests/fixtures/shared-actor-mod/view.ts) demonstrates a
single appearance feature with the detailed humanoid skeleton, shared motion
matching, custom geometry and attack/posture clips. Its logic registers a model
choice; its view consumes common presentation signals and uses
`host.setPlayerAppearance`. It contains no mode-specific game-state reads.

Package models, clips and mappings in owned feature directories with declared
dependencies. Published mod versions are immutable: install the same version in
another mode, or publish a new version for changes. Updating a base or helper does
not silently rewrite previously built games or published mod packages. Compatible
signals, mappings and action handling enable reuse; they do not guarantee that
every custom mechanic has meaning in every game.

## Held equipment and arm contacts

Use `equipmentView.ts` for carried weapons or tools. A `SocketFrame` declares a
position and quaternion in model-local space; its +Z axis is the explicit forward
direction. `attachEquipment(hand, model, modelGrip, handSocket)` aligns those
frames and preserves authored model scale. The grip must sit on actual handle
geometry, not an arbitrary group origin. Declare an aim socket separately when
the model's blade or projectile direction differs from its authored axes.

`createSwordModel()` and `createBowModel()` provide editable reference geometry,
named grip/aim markers, and default weights of `heavy` and `medium` respectively.
Custom geometry and themed models can declare the
same socket frames. A bow's `setDraw(amount, arrowVisible)` moves its string,
nock/secondary-grip socket and arrow together; the arrow points along +Z. It does
not fire a projectile or decide combat timing.

Every new or changed held item must declare its orientation on the item root with
`registerEquipmentOrientation` from `equipmentOrientation.ts` before calling
`attachEquipment`. Built-in sword and bow models already register defaults.
Custom geometry, tags and attachment methods remain supported; custom attachments
still register the item's semantics so normal inspections can measure it.

The definition contains an item `id`, a named `grip` point, a `weight` of
`medium`, `heavy` or `xheavy`, at least three tagged local `points`, and at least
two independent point-pair `directions`. For a sword,
place points on its grip, tip, blade center, both sharp edges and both flat faces.
An edge direction runs from blade center outward toward that edge; a face direction
runs outward toward the flat face. A direction along the blade is useful as the
tip/length direction, but does not describe which side leads a cutting swing.
The definition's `grip` field references an anchor point ID; neither that point's
name nor any tag is reserved. Describe the authored item freely: an axe might use
`cutting-edge` and `blunt-back`, while its handle point is named `handle-center`
and tagged `wrapped-handle`. An instrument has different meaningful parts. Bind a point to a
descendant `node` for animated parts such as a bowstring. Positions must describe
the actual geometry and are transformed through its current hierarchy and scale.

The weight is an animation response class, not a mass measurement or a movement
penalty. `ThreeAnimationRig` discovers registered equipped items under the standard
humanoid or legacy Duel hands. Stowed items are excluded; first-person render
masking preserves their equipped state. The controller automatically makes the loaded
limb's locomotion swing less responsive as weight increases; the other arm and
the character's running speed stay unchanged. Static authored poses are preserved.
The item remains attached to its actual hand, so its grip cannot drift because
of the carry response. Built-in model factories supply a weight; choose another
class when creating a differently weighted variation.

For a custom axe whose grip is at the model origin, register the dimensions of
its actual geometry and attach it once during actor construction:

```ts
import { registerEquipmentOrientation } from '../sandbox/equipmentOrientation.ts';
import { attachEquipment } from '../sandbox/equipmentView.ts';

const unregister = registerEquipmentOrientation(axe, {
  id: 'left-axe', grip: 'handle', weight: 'heavy',
  points: [
    { id: 'handle', tags: ['wrapped-handle'], position: { x: 0, y: 0, z: 0 } },
    { id: 'head', tags: ['head-center'], position: { x: 0, y: .7, z: 0 } },
    { id: 'edge', tags: ['cutting-edge'], position: { x: .2, y: .7, z: 0 } },
  ],
  directions: [
    { id: 'shaft', tags: ['shaft'], from: 'handle', to: 'head' },
    { id: 'cutting-side', tags: ['cutting-edge'], from: 'head', to: 'edge' },
  ],
});
const attachment = attachEquipment(body.joints['left-hand'], axe, {});
// Keep unregister/attachment for disposal. No per-frame weight setup is needed.
// Expose result.diagnostics.equipmentMotion in inspection().
```

An optional `motionInfluence` from `0` to `1` scales this response: `0` can describe
a very light prop, magical support or deliberately unmodified motion while
retaining the item's weight metadata. Custom anatomy can supply
`equipmentLoads(context)` rather than pretending to have humanoid hand names.
Set `equipmentMotion: false` when an actor's authored locomotion already provides
its desired carrying behavior. Generated humanoid and creature starters forward
these options and include `equipmentMotion` in their inspection reports.

For a custom arm or an explicit two-handed load, supply joint names from that
rig's locomotion pose. Return an empty list when the item is no longer held:

```ts
const animation = new ActorAnimationController({
  rig: customRig,
  locomotion: customLocomotion,
  equipmentLoads: ({ signals }) => signals.parameters?.carryingCrate ? [{
    id: 'crate', weight: 'xheavy', influence: .8,
    joints: ['leftUpperArm', 'leftForearm', 'leftWrist',
      'rightUpperArm', 'rightForearm', 'rightWrist'],
  }] : [],
});
```

This callback explicitly owns its selected loads and chains. Worn armor or a
torso accessory is not automatically inferred to be a hand load.

Weight response runs on locomotion **before** authored carry/action layers and
hand constraints. It does not slow attack clips, retime hits, or overwrite an
intentional bow hold, injection, block or other contact. Such actions may need
their own authored sense of weight. Strong IK or a layer that replaces the
whole arm can deliberately override the locomotion response. Inspect the final
result rather than assuming a metadata tag proves the desired effect. Weight,
constraint overrides and equipment contact are observations, not automatic
animation failures; the AI decides what fits the requested action.

`tests/visual/equipment-weight.html` compares the same shared motion-matched gait
unloaded and at all three weights. Switch the holding hand, slow playback, or
stop running to inspect settling and grip error. It is a presentation comparison;
use the game's inspection recipes for actual terrain, combat and overlap evidence.

For an optional visual aid, `createEquipmentOrientationMarkers(itemRoot)` returns
an overlay root plus `update()` and `dispose()`. Add its root under the item and
update after animated subparts move. Built-in sword/bow `{markers:true}` options
include this automatically; ordinary models allocate no markers. Tags are labels
for geometry, not hardcoded rules about which side is correct.

Use `HumanoidHandPlacement` in the animation controller's `afterApply` hook after
the full locomotion/action pose. Targets are world-space palm positions and
orientations, with an explicit elbow pole; `target.socket` describes the palm
offset from the wrist. It rotates the actual upper arm, forearm and hand without
stretching bones or moving the authoritative actor root. Unsupported stretched
rigs and unreachable targets report warnings instead of silently inventing reach.
Keep ordinary one-handed carrying attached to the animated wrist; use a small
additive grip/carry pose if needed. A persistent world-space hand target cancels
natural arm swing and makes the arm compensate around a floating weapon. Blend
hand constraints in for an actual strike, aiming, or two-handed contact, then
blend back to the current locomotion pose. Inspect running with the weapon as
well as attacking; contact error alone cannot detect an unnaturally fixed carry.
`placeBowHands` solves the holding hand first and derives the drawing hand from
the bow's actual secondary-grip socket; provide the desired primary hold frame
and edit the default poles/palm sockets as needed. `secondary.offset` adds a
release follow-through in the actual nock's local frame, so the hand can recoil
while the string returns. Share one action phase across arm targets, draw and arrow
visibility. The RPG Ranger releases within its existing attack window and uses
the rest of the clip for recovery; presentation does not change damage timing.

Shared `HumanoidHandPlacement` automatically reports continuous reach, requested
and solved target errors, orientation error, blend weight and action context
during normal inspection. A requested-target error during partial blending can
be intentional; it differs from failure to reach the actual solved target.
Custom attachment/constraint solvers can expose their additional measurements
through `inspection()`. Inspect both first-person and
third-person views at windup, full draw/contact, release and recovery, including
walking, turning, cancellation and reset. A correct third-person silhouette does
not prove that the near-camera weapon is aligned. Show socket markers when
diagnosing a grip mismatch and inspect actual rendered frames alongside numeric
contact evidence. Do not rotate the weapon independently after attachment to
hide an incorrect pose; change the declared socket or animate the actual hand.

For first-person humanoids, keep the same body and equipment in the world scene
and use `PlayerAppearanceHost.withFirstPersonBody` for the eye-camera render.
It masks the shared `head`/`neck-1`/`neck-2` branches while retaining their shadows
and showing the real arms. Custom avatars may tag separable branches with
`userData.firstPersonHidden = true`; unknown indivisible meshes fall back to
hiding the selected body. Inspection and other cameras retain the complete
model. Do not build a disconnected pair of overlay arms for a normal humanoid.

## Verification and remaining work

The [Arena animation lab](arena-animation-lab.md) replays the real terrain and
physics through this shared driver, with source clocks, switches, and frame
stepping. `npm run verify:arena-animation` checks terrain/action scenarios at
30/60/120 Hz and retains timelines for repeated one-shots or stalled playback.

`scripts/verify-shared-actors.ts` installs the same Wayfarer source package into
Duel, Arena, RPG and Just Chatting, compiles each snapshot in isolation, and drives
legal movement/action inputs through the production inspector. It records source
hashes, selected motion, diagnostics and images under
`tests/.tmp/shared-actor-portability/<mode>/`. Run it with the configured inspection
image and runtime; `--mode rpg` selects one mode:

```sh
node --disable-warning=ExperimentalWarning scripts/verify-shared-actors.ts
```

The 2026-10-15 verification passed against all four actual bases using identical
Wayfarer package source: two Duel players, four Arena players, five RPG players
and four lounge players. It rendered 388 frames and saved 24 captures, with
complete diagnostics and no console errors. The captured images were also
reviewed. Package fingerprints and per-mode source fingerprints are recorded in
each `source-proof.json`. Typecheck, production build and 124 focused tests passed.
These short scenarios exercise reuse and animation; they do not measure networked
multiplayer or player-device performance.

The default humanoid motion bank currently covers grounded locomotion. Airborne
movement reports a fallback; jumping, climbing and swimming need suitable clips
and drivers. Automatic custom-body rigging/retargeting, advanced full-body contacts,
terrain-aware stride/hand adaptation, broader movement coverage and measured crowd
quality scaling remain follow-up work. Existing support/IK helpers provide the
foundation; predicted trajectories do not supply collision evidence. Procedural
terrain now supplies a shared render/physics surface and support adapters; the
terrain fixture exercises that connection with motion matching in every mode.
It does not yet supply navigation or automatic humanoid stride/foot adaptation.
