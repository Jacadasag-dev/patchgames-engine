# Shared game scenes

Game scenes are an opt-in lifecycle inside a match. They do not replace the host's waiting, countdown, fighting, knockout or ended phases. All participants receive the current scene ID, sequence, choices, readiness and elapsed time from authoritative state.

The engine provides gameplay, selection, meeting and cinematic kinds. A blocked scene pauses ordinary game steps, trusted damage, hunger, recovery, round clocks and the host match duration. Its scene clock continues. Every blocked scene declares a finite timeout and next scene; `$return` restores the gameplay scene it interrupted. Content requests only declared transitions, with at most one committed transition per tick. A committed outcome or round intermission takes precedence over an interrupt.

## Declare the flow

```ts
import {sceneStateShape} from '../shared/gameScenes.ts';
import {createScenePreset} from '../sandbox/scenePresets.ts';

const scenes = createScenePreset('selection', {
  choices: [
    {id:'guardian', label:'Guardian'},
    {id:'ranger', label:'Ranger'},
  ],
  durationMs: 60000,
});
// Add `scenes` to GameLogic, and `scene:sceneStateShape` to shapes.world.
```

The other presets are `meeting` and `boss-reveal`. Each returns an independent editable declaration. For a flow combining all three, use:

```ts
import type {GameSceneRules} from '../shared/gameScenes.ts';
const scenes = {
  stateField: 'scene', initial: 'select', definitions: [
    {id:'select', kind:'selection', label:'Choose your role', durationMs:60000,
      next:'play', choices:[{id:'guardian',label:'Guardian'},{id:'ranger',label:'Ranger'}]},
    {id:'play', kind:'gameplay', transitions:['meeting','door']},
    {id:'meeting', kind:'meeting', label:'Emergency meeting', durationMs:45000,
      minimumMs:3000, skippable:true, next:'$return'},
    {id:'door', kind:'cinematic', label:'The way opens', durationMs:5000,
      minimumMs:500, skippable:true, next:'$return'},
  ],
} satisfies GameSceneRules;
```

Use `uniqueChoices:'team'` or `'all'` when picks must be unique. The engine rejects insufficient choice capacity, prevents duplicate picks and assigns valid deterministic defaults on timeout. Inactive seats do not block readiness. Initial selection runs after `setupMatch`, before ordinary gameplay. In `onSceneEnter`, use `previousScene.choices` to apply roles, equipment or game state when entering play. These choices are separate from the host lobby's readonly `GamePlayer.classId`.

`sceneRequest(ctx)` returns a declared target after a legal game condition. For example, a checked emergency-button input can request `meeting`; a confirmed boss defeat can request `door`. Clear an authored trigger in `onSceneEnter` so it cannot immediately retrigger on return. `sceneStep(ctx)` handles blocked-scene rules and receives neutral gameplay inputs plus authenticated `sceneActions`. The game still validates vote choices, permissions and results. Commit a persistent door state once in logic; presentation never awards progression or decides whether a door exists.

## Render a scene

`frame.scene` is distinct from `frame.phase`. `createSceneView(canvas,{gameplay,scenes,kinds})` lazily selects a complete `GameView` factory by exact ID, then kind, then gameplay fallback. It forwards resizing, UI and diagnostics and disposes the previous view once. Each factory must own and clean up its allocations; an unsuccessful factory cleans up anything allocated before it throws. Shared feature attachments follow a compatible active route. If terrain must prepare before a route exists, provide the router's shared `terrainWorld` explicitly.

For a cinematic, create a separate camera track:

```ts
import {createSceneCameraTrack} from '../sandbox/gameScenes.ts';
const track = createSceneCameraTrack([
  {atMs:0, position:{x:8,y:4,z:10}, lookAt:{x:0,y:2,z:0}},
  {atMs:5000, position:{x:2,y:3,z:5}, lookAt:{x:0,y:2,z:0}, ease:'smoothstep'},
]);
// During the cinematic view update:
const pose = track.sample(frame.scene.elapsedMs);
camera.position.set(pose.position.x, pose.position.y, pose.position.z);
camera.lookAt(pose.lookAt.x, pose.lookAt.y, pose.lookAt.z);
```

Use `sceneProgress` for animation values. Sampling authoritative elapsed time lets reconnecting or late-joining clients seek the current point instead of restarting the reveal. The client may smooth presentation time between patches; only the server changes the scene. Apply the pose to the cinematic view's own camera so spatial audio follows the actual render camera. Do not use inspection-camera APIs for gameplay cinematics.

## UI and input

The host supplies basic choice, readiness, countdown and optional skip UI. Custom UI remains managed HTML/CSS: scope the document with `scene:{id,sequence}` and use `sceneUiAction(scene,action,value?)`. Explicit `createSceneView` scene routes stamp their returned UI automatically. Reserved actions are `host:sceneChoose`, `host:sceneReady`, `host:sceneUnready`, `host:sceneSkip` and `host:sceneCustom`; their `sceneSequence` is separate from grid/choice indices.

The host authenticates the participant, bounds requests and rejects stale sequences and spectator actions. On transitions it clears queued controls, predicted movement, old UI and scene audio. Ordinary gameplay controls stay neutral while blocked; trusted Menu access remains available. Old unscoped HUD/shop documents do not appear over a meeting, and crosshairs stay suppressed in blocked scenes.

## Verify the integration

Test actual selection completion, timeout and departure; legal meeting triggers and return; collectively skipped and timed cinematics; frozen gameplay positions, damage and clocks; stale requests; outcome precedence; reconnect seeking; repeated scene IDs with new sequences; view disposal and UI cleanup. Use two live clients as well as authored tests. A staged inspection proves only the captured state, and a successful build does not prove transitions or multiplayer behavior.

Authored tests can call `stepMatch(game,match,inputs,dtMs,false,sceneActions)` from `testkit.ts`. Actions carry `player`, `sequence`, `action` and optional `value`. For inspection, `scenario.sceneActions` adds ordered `{atMs,player,action,value?,sequence?}` requests. Omit sequence to use the current authoritative instance at delivery, or supply it to check stale rejection. Inspection frames and captures retain separate scene and gameplay timing. Version 9 changes scene-aware evidence semantics and retains earlier reports for reading.

Discover the guide with `get_authoring_guide({topic:'scenes'})`, or inspect exact `scene:selection`, `scene:meeting` and `scene:boss-reveal` catalog entries with `details:true`. Existing connector sessions with cached tool schemas can still use catalog IDs and read-only API references.
