# Shared multiplayer movement

Use the same engine path for shooters, survival games and editable voxel worlds.
Genre changes content, not transport, input cadence or reconciliation ownership.

- The engine predicts from game.step by default. Keep movement deterministic and
  state in declared shapes. If retaining prediction.step, share its movement
  helper with authority; never maintain two different collision solvers.
- Use shared character physics and the accepted terrain snapshot. Prepare new
  terrain outside ticks. createVoxelWorld supplies lookahead, cached native
  edits and bounded recovery automatically; import it instead of copying it.
- Declare smoothFields for remote visible motion. Only spatial position fields
  belong in prediction.snapFields. Timers, inventory, cooldowns and action
  counters must remain exact; they must not cause spatial teleports.
- For direct mouse look, share prediction.pointerLook with applyPointerLook.
  scaleTuning multiplies scale by a named tuning value. This keeps unsent display
  motion, sensitivity changes and fixed inputs consistent. Never multiply mouse
  deltas by dt or consume them again in the view.
- Leave transport, remote interpolation, input catch-up, correction smoothing,
  reconnects and host health/outcome rules to the engine. Avoid extra client
  timers, render loops, network layers or position easing in game code.
- Test local movement and remote actors together, including reversals, jumping,
  attacks/edits, respawn and reconnect. Use intended rosters and representative
  devices. Check 60/120/240 Hz presentation against fixed simulation, delayed
  acknowledgements and jitter. Offline replay alone does not prove live quality.
- In a live frameprofile sample, verify real actions changed state. Check frame
  intervals, server-patch age, terrain-blocked time and local-edit fallbacks.
  Host intervals are not physical display FPS. Report failures and scope rather
  than promising every game, device or network is stutter-free.

These are shared defaults, not genre rules. Preserve deliberately different
controls and movement when requested; measure through the same engine contracts.

## Team death cameras

An eliminated team player keeps their own camera for two seconds, then follows
a living teammate. The engine replaces a target who dies, leaves or changes
teams; if nobody survives, it keeps the eliminated player's view. Respawn and
new rounds restore the owner camera. Eliminated players cannot select enemies
or free fly; ordinary lobby spectators retain manual cameras. Non-gameplay scene
cameras continue to take priority.

Views follow `FramePlayer.isLocal` as their camera subject. During spectating
that flag identifies the watched player and never transfers input authority.
`ViewFrame.spectator` exposes `targetId` (omitted for an overview) and
`delayRemainingMs` for custom presentation. The target remains the eliminated
owner during the delay or when no living teammate is available. These values
do not advance gameplay clocks. The shared UI labels the spectator view and
blocks gameplay purchase intents; the audio listener treats a subject switch
as a camera cut even when the view reuses one Three camera.

## Defaults and verification

| Layer | Default owner | Regression coverage |
| --- | --- | --- |
| Local prediction and input replay | Shared client and deterministic game step | Real SDK cadence, delayed acknowledgements and reconnect checks |
| Remote interpolation and spatial correction | Shared client, declared motion fields | Local and remote poses in all four modes at 60/120/240 Hz |
| First-person look in newly created games | Blank starter's shared look declaration | Tuned simulation and display preview agree, including sensitivity changes |
| Editable block collision | Shared voxel helper and native physics | Mining, placement, undo, seams, stale results and bounded recovery |
| Author guidance | Universal creation brief, controls guide and multiplayer handbook | Discovery for Minecraft, team deathmatch FPS and forest survival requests |

These defaults apply to new builds using the shared APIs. Existing authored
movement and camera conventions are not silently rewritten. Custom game logic,
large rosters, device limits and adverse networks still require representative
live checks; correctness tests alone cannot promise a frame-time target.
