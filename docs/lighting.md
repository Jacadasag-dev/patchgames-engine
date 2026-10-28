# Room lighting and shadows

Use `src/sandbox/lighting.ts` from any mode's view or a native feature view.
`LightingRig` adds real spotlights at fixtures, keeps their targets in the scene,
selects nearby shadows within a budget, and disposes their GPU resources.
The base view enables shadows on its existing renderer:

```ts
import { LightingRig, configureShadowRenderer } from '../sandbox/lighting.ts';

configureShadowRenderer(renderer);
const lights = new LightingRig(scene, {
  maxShadowLights: 4,
  shadowMapSize: 1024,
});
const pendant = lights.addSpot({
  id: 'conversation-pendant',
  position: [0, 4.5, 0],
  target: [0, 0, 0],
  color: 0xffe3bc,
  intensity: 25,
  range: 12,
  angle: Math.PI / 3,
  penumbra: 0.65,
});

// Before each main render. Use getWorldPosition if the camera is parented.
lights.update(camera.position);
// When disposing this view:
lights.dispose();
```

The positions and target are in the parent object's local coordinates. The
`update` focus is in world coordinates. For a feature, attach a `Group` through
`host.add`, create the rig under that group, and update using the local player's
shared `pose` (or another participant when spectating). Feature views use the
base renderer and have no direct camera access. Call `host.remove` for the group
and `lights.dispose()` on teardown; dispose fixture geometry/materials separately.

A glowing material does not light nearby objects. Pair visible bulbs, strips or
panels with real lights at their openings, outside any opaque housing that would
block them. Keep ambient or hemisphere fill modest so the room stays readable
without erasing the local shadows. Use lit materials on receiving surfaces,
`castShadow = true` on bodies/furniture, and `receiveShadow = true` on floors and
walls. The helper does not alter these mesh choices.

`castShadow` in `addSpot` means eligible for a shadow map; the rig manages the
returned light's actual `castShadow` flag. Other properties, including
`light.shadow.normalBias`, can be tuned on the returned spotlight. Fit range and
cone to the room before increasing map resolution. Excessive bias detaches a
shadow from its object; too little can cause speckled self-shadowing. `penumbra`
softens the cone edge, not the physical shadow source size. The helper uses
filtered `PCFShadowMap`; the installed Three.js has removed `PCFSoftShadowMap`.

The defaults are four shadow lights with 1024-pixel maps. A rig permits 0–8
shadow lights, 512/1024/2048 maps and at most 64 fixtures. A small distance
hysteresis keeps shadows from repeatedly switching between adjacent fixtures.
Lights outside the shadow budget still illuminate. Budgets belong to each rig,
so coordinate them across installed lighting mods; there is no shared global
shadow cap. A point-light shadow needs six views, while an aimed spotlight needs
one. Mirrors also render the scene again. Inspect walking characters, modded
models and furniture from the player camera and mirror, and check performance
with the intended participant count.

The filesystem AI receives a lighting handbook for relevant requests or existing
lighting code, the helper's current source, and `findCode` entries. Connected AIs
receive `get_game.lightingAuthoring` guidance and can read the helper's public API
through `read_files`. The view sandbox permits this helper in base and feature
views; simulation logic cannot import it. Independent lighting additions can be
packaged as ordinary native feature mods without depending on a particular mode.
