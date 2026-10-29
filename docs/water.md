# Water surfaces and simulated water

## Engine integration

```ts
import { compileTerrain, terrainPhysicsScene } from '../sandbox/terrain.ts';
import {
  compileWaterSystem,
} from '../sandbox/waterSystem.ts';
import {createWaterSystemWireState,stepWaterSystemWire} from '../sandbox/waterSystemWire.ts';

const terrain = compileTerrain({version:1,seed:42,
  bounds:{width:32,depth:32,cells:32},base:{height:4},
  assets:[],regions:[],channels:[{
    id:'river',kind:'river',width:4,depth:2,bankWidth:2,
    points:[{x:0,z:-16,bedY:2},{x:0,z:16,bedY:1}],
  }]});
const system = compileWaterSystem({id:'river-water',quality:'balanced',
  scene:terrainPhysicsScene(terrain),channels:terrain.channels,
  bounds:{min:{x:-16,y:-2,z:-16},max:{x:16,y:8,z:16}},
  river:{depth:.5,speed:.8,inflow:.15},boundary:'open'});
let state = createWaterSystemWireState(system);
// Authoritative fixed tick; pass current colliders and moving bodies when present.
state = stepWaterSystemWire({system,state,dt:1/30}).state;
```

`quality` is `economy`, `balanced` or `detailed`. It selects bounded grid cell
and underwater-circulation budgets for the requested extent, with minimum cell sizes that avoid oversolving small pools. Start with economy and profile before raising quality. Detailed scenes may require offline baking when they exceed the live tick budget. **Grid resolution is the size of
each horizontal simulated patch of water.** Smaller patches resolve narrower
channels, ripples and shorelines, at greater cost. Inspect
`system.diagnostics.cellSize`, cell count and warnings. A long river can use
bounded reaches, but transfers between independent reaches must be explicitly
implemented; terrain streaming alone does not transfer water.

`stepWaterSystemWire` uses the trusted host bridge and owns source emission, conservative flow, routed pipes, moving
solid pressure and post-flow buoyancy. Returned `bodies` already have water
momentum applied once; integrate their poses with native physics. Store its wire state directly with `waterSystemStateShape`; do not decode and
re-encode grid arrays inside each QuickJS tick. Pure host callers can use raw
`createWaterSystemState`/`stepWaterSystem`. Do not apply
the returned contacts to those bodies again. For destructible structures use
`createWaterSystemDestructionState` and `stepWaterSystemDestruction` from
`waterSystemDestruction.ts`; they also own native debris integration, grounded
sleep and floating rest. Pass current collider changes when opening a dam.
Structural damage remains optional with `damage:false`.

### Precise placement boundaries

Precise placement boundaries are enabled by default in `compileWaterSystem`
and `compileWaterBody`; set `boundaryCells:false` for the original placement
handling. Cells split around static grounded upright box placements, including
yaw rotation. A thin wall can hold two different water
levels inside one original grid cell; its actual footprint and crest determine
where water meets or overtops it. Other collider shapes retain the existing
volumetric coupling, and moving retaining sheets retain coarse face proxies.

Dynamic bodies never create precise cuts. Detached debris stays on the ordinary
collision/displacement path even after it comes to rest. Custom scene adapters
can mark such colliders `waterBoundary:false`; this only opts out of precise
cuts, leaving collision, buoyancy and displaced volume intact. Keep attached
load-bearing walls in the static scene, and pass floating objects as bodies.

Terrain always uses the original rectangular storage, sampled center beds and
flow resolution. Slopes, bowls, ridges and cliffs do not create partial hydraulic
cells. With no intersecting placement, enabling the option must preserve the
regular simulation and surface. Both modes retain currents, floating bodies,
hulls, pipes, mixing, cohesion, wind, swell and debris coupling.

This example puts both sample points in the same economy base cell, on opposite
sides of a four-centimetre wall:

```ts
import type {PhysicsScene} from '../sandbox/physics.ts';
import {compileWaterSystem} from '../sandbox/waterSystem.ts';
import {
  createWaterSystemWireState, decodeWaterSystemState, stepWaterSystemWire,
} from '../sandbox/waterSystemWire.ts';
import {sampleWaterBody} from '../sandbox/waterBody.ts';

const scene:PhysicsScene = {
  terrain:{columns:1,rows:1,width:2,depth:2,heights:[0,0,0,0]},
  colliders:[{id:'thin-dam',position:{x:-.2,y:.8,z:0},
    shape:{kind:'box',halfExtents:{x:.02,y:.8,z:1}}}],
};
const system = compileWaterSystem({
  id:'split-pool',scene,boundaryCells:true,quality:'economy',
  bounds:{min:{x:-1,y:-.2,z:-1},max:{x:1,y:3,z:1}},
  initial:[
    {min:{x:-1,z:-1},max:{x:-.22,z:1},level:1.2},
    {min:{x:-.18,z:-1},max:{x:1,z:1},level:.3},
  ],
});
let state = createWaterSystemWireState(system);
state = stepWaterSystemWire({system,state,dt:1/30}).state;
const accepted = decodeWaterSystemState(system,state);
const left = sampleWaterBody(system.water,accepted.water,{x:-.24,z:-.5});
const right = sampleWaterBody(system.water,accepted.water,{x:-.15,z:-.5});
// left.surface is 1.2; right.surface is .3. The wall's top is 1.6.

// A discrete static edit remaps the existing water before the next flow step.
state = stepWaterSystemWire({system,state,dt:1/30,
  scene:{...scene,colliders:[]}}).state;
```

Static placement edits remap water and horizontal momentum conservatively.
Removal opens the actual gap without copying a full cell's water into each new
region. Keep checkpoint scene geometry consistent. Use `sampleWaterBody` to
select the correct side; the legacy cell arrays are volume-weighted summaries.
Point sources respect connected sides. Existing wire/bake APIs retain region
state and topology; retain a bake's `finalState` when resuming physics.

The bulk surface keeps the regular grid's smooth fan and material. Only
placement boundaries need clipped polygons and distinct side heads. Terrain
appearance comes from cosmetic contact effects, not extra hydraulic storage or
reconstructing a fine terrain basin beneath each ordinary cell. Exact cuts and
their adjacent interfaces use bounded conservative flow; untouched meshes use
the original grid kernel and depth-current grid. Complexity and CFL limits still
apply. Each body is one Y-up shallow-water layer. Use `waterWorld.ts` below for
overlapping floors or terrain surfaces; it reuses these bodies rather than a
general 3D fluid grid.

All simulated water demos enable **Precise placement boundaries** by default.
Switching resets the scene and recordings; `?boundary=1` / `0` preserves the
choice. It changes placement handling only. Terrain flow and cosmetic shore,
fall and splash effects remain available in either mode. The purely animated
surface has no liquid solver to refine.

Use `node scripts/benchmark-water-boundaries.ts` for matched full-feature CPU
measurements and saved JSON, including failures. These timings cover simulation
and surface generation, not GPU cost or mobile FPS. Profile cosmetic events and
view updates separately. Run water-focused tests for changes to this subsystem.

### Dynamic shores, falling water and impact plumes

Unsupported discharge over a real ledge, elevated sources and drops between
world layers automatically enter bounded ballistic flight. The engine removes
accepted discharge from the donor, keeps its volume and momentum in
`state.water.flights`, and transfers it to receiving water only at swept contact.
Gravity determines travel time; native solids block the trajectory. Authors do
not configure waterfall paths, duplicate sources or delayed landing impulses.
`waterBodyFlights.ts` defines these physical records. They are finite packets,
not a general 3D free-surface solver. Old `falls`/`ledgeDrops` options remain
rejected; flight is derived from accepted flow and geometry in both modes.

`stats.volume` includes supported water **and airborne water**; `airVolume`
reports the latter separately. `totalVolume` additionally includes pipe storage.
Do not add `airVolume` to `volume` a second time. Keep flights in wire snapshots
and physical bake checkpoints so replay preserves mass and arrival timing.

`WaterSystemView` derives bounded shoreline bands from the accepted surface and
terrain. `waterFlightMesh.ts` builds a smooth rounded outlet envelope with
thickness from accepted discharge and ballistic speed. Neighboring spans can
join across different heads and speeds when a local wet source path connects
them and native geometry permits. Landing histories do not determine whether
the active lip is connected; older separated tails remain bounded. Cosmetic filtering blends internal
pulses up to75ms; longer source-off gaps remain separate, and neither exposed
front nor trailing end extends beyond accepted flight. Reversals split the
stream. The bounded mesh uses metre-scale motion and source-depth color.
Pours share the body's physical lighting, environment, roughness, IOR and
clearcoat. Shared source-depth tint and film opacity match the pool; shared current
noise uses continuously integrated flow distance to avoid speed-change phase jumps.
Optical normals affect both physical and clearcoat reflection. At an attached lip,
the displayed source border, normal and accepted-wave lighting factor continue
into the stream and blend to its airborne profile; vertical fall normals never
use the horizontal surface wave-tone reference.
Environment and surface textures are borrowed, not rendered again or disposed
by the detail view. Shore bands and soft plumes retain separate materials. Actual arrivals drive
soft turbulent spray plumes and churning foam through `waterImpactPlumes.ts`;
these are cosmetic, carry no extra water and exert no forces. Changing detail
quality never changes flight or landing physics.

Pass `detail:true` to the step and forward events since the previous presented
frame through `WaterSystemView.update(state, nowMs, scene, surface,
{detail:events})`; call `animate` with simulation time. Use
`detail:'off'|'low'|'high'` for cosmetic budgets. Lower-level views are
`WaterTerrainEffectsView` and `WaterDetailView`; supply the same accepted state
and current native scene so effects respect floors, walls and real holes.
Fast converging currents and energetic solid contacts use the same soft-plume
appearance, with waterborne bubbles and foam retained. Calm pools and uniform currents do not emit collision splashes.

`node scripts/benchmark-water-detail.ts` separately measures accepted event,
flight/plume and view CPU work. It excludes GPU rendering and is run without
competing CPU jobs. The Over the edge demo (`tests/visual/water-falls.html`)
uses the same shared implementation for two terrain-separated openings from
one finite pond: a wide fall and a narrower slit with a deeper landing. Its
shared sluice closes both; no source or authored fall route refills them.

### Wind, calm water and incoming swell

Live water defaults to no wind. Set `wind:{velocity:{x:8,z:2}}` in the recipe
to apply horizontal air velocity in m/s. The optional `gustiness` (`0..1`,
default `.35`) varies resolved surface stress; `dragCoefficient` (`0..0.01`,
default `.0013`) sets bulk air/water momentum transfer. The solver adds momentum
from this external energy source, then transports existing water conservatively.
It does not add water or impose an animated surface height. This uses a bounded
bulk-stress approximation, not an atmospheric or spectral ocean model; the
relative-wind stress formulation is described by [Zhai and Greatbatch](https://doi.org/10.1029/2006gl028907).

Every live facade accepts a per-step `wind` override. Omit it to retain compiled
wind; pass `false` or zero velocity to stop new wind input. Existing waves and
currents decay through physical/numerical dissipation. Zero wind, no moving
objects and no existing flow leave a flat pool still. `friction:0` deliberately
removes baseline damping. Moving objects displace water and exchange momentum;
opposing currents raise the free surface. Both generate waves in the same
finite-depth pressure solve, affecting floating bodies without extra wake forces.
Persist runtime wind choices with the game's weather/input state for rollback;
the fluid checkpoint records the resulting water, not future weather controls.

A small lake does not immediately develop large ocean swell from a light breeze.
For waves that acquired wind energy outside the simulated reach, seed a finite
incoming packet once during preparation:

```ts
import {seedWaterSystemWireSwell} from '../sandbox/waterSystemWire.ts';
state = seedWaterSystemWireSwell({system,state,swell:{
  center:{x:0,z:-8},direction:{x:0,z:1},
  height:.6,wavelength:5,width:12,length:15,
}});
state = stepWaterSystemWire({system,state,dt:1/30,wind:false}).state;
```

Use an already filled ocean/lake domain for this example. `height` is the
requested crest-to-trough distance, reduced if water depth or vertical bounds
cannot support it. Wavelength must span at least eight cells. `width` defaults
to the domain diagonal; `length` defaults to three wavelengths. The packet
redistributes existing water separately within connected wet regions, preserves
the mass ledger and supplies matching travelling-wave momentum. It never crosses
a dry gap or closed barrier during preparation. `seedWaterSystemSwell` is the
raw-state equivalent. After seeding, ordinary simulation determines travel,
reflection, interaction and decay; repeatedly calling the helper adds repeated
external energy. Keep it outside the live tick. Warm-start and bake use compiled
wind, and either can begin from the seeded checkpoint.

`WaterSystemView(system, options)` owns the body surface, thin puddles and
cosmetic spray detail. Attach `root`, call `update(state)` on accepted
snapshots decoded with `decodeWaterSystemState(system,wire)`, `animate(seconds)` on presentation frames and `dispose()` at teardown.
Texture and lighting options remain editable. `waterSystemStateShape` and
`encodeWaterSystemState`/`decodeWaterSystemState` persist supported, airborne and pipe inventory;
coupled scenes also persist their destruction and floating state.

Currents are enabled by default in both `compileWaterSystem` and
`compileWaterBody`. Set `currents:false` in the recipe to disable optional
body-driven horizontal current feedback, shear mixing and default current
surface detail. Gravity-driven drainage, volume transport, displacement waves,
buoyancy and object drag remain active. This setting does not freeze water.

Moving submerged colliders transfer
momentum to nearby water; gravity accelerates water down a free-surface slope.
Momentum travels with the flow, mixes locally with adjacent wet water, and
decays with friction. Supply the actual collider poses and velocities each tick;
do not draw a separate wake or apply another force to nearby floats. Local
entrainment does not pull an entire lake toward a boat. `currentMixing` controls
horizontal mixing in m²/s (default `.05`, range `0..2`); `friction` sets the
baseline dissipation in 1/s and scales bed resistance. Thin water feels stronger
bed resistance than deep pools, so a landing sheet collects near a drop before
spreading across the receiving floor. Defaults work without tuning.

Floating objects receive drag relative to the local water velocity. Floating
rest is a performance mode, not an anchor: coherent translating or rotating
flow above `.015 m/s` reactivates motion, with a lower `.0075 m/s` threshold for
entering rest. Opposing flows from quiet bobbing cancel in this probe. Grounded bodies retain native
contact/friction support and do not follow the water surface merely because
part of the body is wet.

Underwater circulation uses a bounded three-dimensional velocity field alongside
the existing conservative water-depth grid. It retains vertical momentum from
source jets, body impacts and pipe outlets, so a downward jet can turn along
the bed and produce return circulation. The depth grid remains the owner of water
volume and the free surface; the circulation field does not add another copy of
the water. It is a coarse game simulation, not a replacement for a resolved 3D
free-surface solver or a guarantee of turbulent detail below its cell size.

`depthCurrents` is enabled with currents and allocates its field only when driven.
Set `depthCurrents:false` to retain horizontal currents without depth circulation;
`currents:false` also disables depth circulation. Optional controls are `layers`,
`maxCells`, `iterations`, `damping`, `sleepSpeed`, `sleepAfter` and `maxSpeed`.
`maxCells` (default 1,024) caps the circulation field: larger bodies group water
columns into coarser current cells. Raise it when wakes or downwelling must be
resolved finer than that, at roughly proportional cost in scenes with
submerged objects. Start with defaults and profile before increasing resolution.
Quiet fields sleep.
Use `sampleWaterBody(water,state,{x,y,z})` to query current velocity at a world
height; omitting `y` samples the surface. Rigid-body drag samples submerged points,
while native floor contact continues to support grounded objects.

Source `point.y` selects an underwater injection height; omit it for surface
inflow. Source `velocity.y` supplies downward or upward momentum. Quality presets
use 4/6/8 circulation layers for economy/balanced/detailed; an explicit `layers`
overrides this.

`waterSystemStateShape` and the existing encode/decode helpers preserve depth
circulation, including staggered velocities, its wet mask and sleep state.
Legacy checkpoints without the optional field remain readable. Packing retains
float64 values without reducing precision or silently dropping currents. The
existing 688,128-byte water body payload limit still applies: larger grids with
depth circulation may require lower budgets or local-only state. A saved physical
`finalState` from baking includes circulation; cosmetic surface playback does not
apply underwater forces.

The shared view automatically shows flow-aligned surface motion and shallow
shore effects from the accepted water state. The visible current follows the
same velocities used by buoyancy and drag. Foam follows actual terrain contact;
the renderer does not extend water across dry banks. Terrain and water resolution
still limit shoreline detail. Optional `flowStrength` and `shoreStrength` are
presentation controls and do not change physical forces.

For visible current traces, attach `new WaterCurrentLinesView(system.water).root`
from `waterCurrentLinesView.ts`, call `update(state.water)` for accepted snapshots
and `animate(state.water.time)` each display frame, then `dispose()` on teardown.
These bounded diagnostic paths follow the measured velocity and stop at dry
ground and blocking faces. They do not change physics. Hide them with
`root.visible=false`; simulation time keeps them still when paused.
`minLength` keeps slow-current directions legible; the moving dashes retain the
actual water speed, so line length is not a travel distance.

For an already flowing river, seed the channel using `river` settings and call
`warmStartWaterSystem` during bounded preparation, then save that state. For
cheap scenery, host-only `bakeWaterSystem({system,state,duration})` simulates once
and returns `{clip,finalState}`. `BakedWaterSystemView(clip).update(seconds)` plays
the recorded surfaces without a fluid solver. A cosmetic clip exerts no forces
and stops at its end; it is not automatically a seamless loop. A dam break or
interactive river should use live state. Baking is preparation work, never a
whole bake inside a gameplay tick.

Puddles are shallow cells of the same conservative water system. They spread,
merge into pools as depth increases, and drain downhill or over ledges. Their
appearance transitions with depth without filling dry ground visually.
A flat floor can drain: losing water at an exposed edge creates a slope in the
water surface, which draws connected water toward the edge. This does not pull
water uphill out of isolated depressions or guarantee that every residual film
vanishes.
Puddle cohesion represents local surface tension and ground wetting at game
resolution. It acts on neighboring shallow water, never through a wall or
across an empty gap toward a global centre of mass. A shallow mound and rounded
edge are possible; large bodies still level under gravity. The visible strength
is an artistic approximation, not a measured surface-tension coefficient.
Set `puddleCohesion` on `compileWaterSystem` or `compileWaterBody`: default
`.5`, range `0..1`; `0` disables the capillary term. This setting is independent
of optional body-driven `currents` and fades out as water deepens into a pool.
Water landing from a source jet transfers a bounded part of its impact energy
into outward flow on the receiving floor. Bed resistance and cohesion then govern how that water
collects and spreads.
`inspectWaterBodyPuddles(system.water,decodeWaterSystemState(system,state).water)` reports shallow/deep water
volumes and wet domain coverage. This coverage does not imply an entire
connected terrain basin has filled. Thin films remain limited by the chosen
grid and work budgets.

`compileWaterSystem` rejects the removed `streamCohesion` and `wetting`
options. `puddleCohesion` controls local shallow cohesion and ground wetting;
unsupported ledge discharge uses automatic finite flight, as described above.
Moving bodies and breached dams also create waves and underwater currents in
the existing water body. Cosmetic spray and foam add no physical liquid.

## Common water recipes

For a level canal, set channel `kind:'canal'` and an explicit level bed at its
control points. Use `river:{depth:.5,speed:0,inflow:0}` and `boundary:'closed'`
when it is a finite reservoir. Add a source and outlet only if it should flow.
For an open river, the facade defaults to an open water domain and estimates
inlet supply from inlet width × water depth × speed. Set `inflow:0` explicitly
when the existing water should run out. Always inspect the carved terrain,
compiled resolution/freeboard warnings and measured source/outflow balance. The compiler warns when initial river water can overtop sampled banks; it does not silently remove water to hide an invalid channel.

For a river entering a lake, carve a descending channel into a basin and include
both in one water domain. Fill the basin using an `initial` region up to its lake
level; terrain above that level remains dry. Set the channel's initial speed to
zero to demonstrate gravity-generated flow, with explicit `inflow` to maintain
the river. The flow continues into the lake and spreads and slows there. A
closed domain retains the lake's inventory; sustained supply raises its level
unless an actual outlet or drain removes water. Do not impose river velocity
over the lake every frame.

Prepare a river once, then choose either an authoritative flowing start or a
cheap recorded presentation:

```ts
import { warmStartWaterSystem } from '../sandbox/waterSystem.ts';
import { bakeWaterSystem, BakedWaterSystemView } from '../sandbox/waterSystemBake.ts';

const flowingStart = warmStartWaterSystem({system,seconds:4});
// Save flowingStart for a live game; warm-up does not certify steady flow.
const {clip} = bakeWaterSystem({system,state:flowingStart,duration:3,sampleRate:8});
const scenery = new BakedWaterSystemView(clip);
// scene.add(scenery.root); scenery.update(elapsedSeconds); scenery.dispose();
```

For a shallow puddle on a flat floor at `y=0`, use a low initial level and an
optional source. The same state becomes a deeper pool as volume accumulates:

```ts
const puddle = compileWaterSystem({id:'puddle',quality:'balanced',
  scene:{colliders:[],terrain:{rows:1,columns:1,width:8,depth:8,heights:[0,0,0,0]}},
  bounds:{min:{x:-4,y:-2,z:-4},max:{x:4,y:3,z:4}},
  initial:[{min:{x:-1,z:-1},max:{x:1,z:1},level:.01}],
  sources:[{id:'tap',point:{x:0,z:0},radius:.5,rate:.05}]});
let puddleState = createWaterSystemWireState(puddle);
puddleState = stepWaterSystemWire({system:puddle,state:puddleState,dt:1/30}).state;
// Stop supply with disabledSources:['tap']; existing water remains physical.
```

Use actual lower terrain beyond a ledge and bounds extending below it to see
falling water collect on a lower surface. An open domain edge instead removes
escaped water from this domain and accounts for it; it does not invent a lower
receiving basin. Water trapped below the outlet level stays behind.

A scripted dam opening uses an upstream `initial` region and a real collider
with stable ID `'dam'`. When gameplay opens the dam, remove that collider from
the current scene and continue the existing state:

```ts
const openScene = {...system.scene,
  colliders:system.scene.colliders.filter(collider => collider.id !== 'dam')};
state = stepWaterSystemWire({system,state,scene:openScene,dt:1/30}).state;
```

For a destructible dam, author a normal `StructuralManifest` and call
`createWaterSystemDestructionState(system,structure)` once. Each tick call
`stepWaterSystemDestruction({system,structure,state:coupledState,dt:1/30})`.
It uses current intact members/debris as obstacles, applies water loads, advances
native bodies and updates floating rest. Gameplay can also apply
`damageStructure` to `coupledState.destruction` before that step. Avoid duplicating
the same dam in the base scene and structural collision. A flood is a finite
volume event unless an explicit source keeps supplying it.

The terrain/water demo at `/tests/visual/water-world.html` includes a winding
downhill river entering a lake and a dam breach above a procedural destructible
house. The house uses the normal building generator with destruction enabled;
water pressure and momentum damage its members through the shared coupled step.
Its damage is not a timed collapse animation.

## Lower-level choices

Choose the level of simulation explicitly. Large lakes, oceans and rivers can use
`water.ts` with `WaterView` and incur **no fluid solver, colliders or
destruction cost**. Use `compileWaterSystem` (above) for a bounded body that must
flow, pool, carry objects and transmit loads; `waterBody.ts` is its
lower-level solver, described under [Water body terrain flow](#water-body-terrain-flow).

`prepareProceduralWater({mode:'surface',recipe})` or
`prepareProceduralWater({mode:'waterBody',recipe})` selects the implementation during
generation. Omitted/false disables water; any other mode throws.
`generateProceduralWater(source,factory)` lets the factory use final terrain
elevations or building bounds. Surface mode allocates no simulation state.

`mode:'waterBody'` is the explicitly chosen simulated cost model. Its recipe contains
`liquid:WaterDomainRecipe` (compiled for you with `compileWaterDomain`), the final
`scene:PhysicsScene`, and optional grid/sleep settings. It returns
`water:WaterBodyManifest` and an empty `initialState`; add water with
`pourWaterBody` or domain sources, then persist and advance that state explicitly.

`terrainWaterConditions(terrainRecipe,{x,z},timeSeconds)` samples the same gust
field as foliage and converts its artistic wind strength to metres/second.
Pass the result into `WaterView.update`. For simulated water, pass the current
terrain and building `PhysicsScene` into `stepWaterSystem` or `stepWaterBody`,
including collision changes after destruction. Choosing a visual mode does not
automatically fill a simulation domain or transfer mass between domains.

Interactive examples: `/tests/visual/water-workshop.html` compares surface modes
with eight selectable simulated experiments: the original destructive channel
flood, a sinking cube, a floating cube, a center-bottom drain, a hose filling a
room, a still puddle, a puddle flowing over a ledge into a lower basin, and two
identical planks dropped in different orientations.
Open `?test=sink` (or `float`, `drain`, `hose`, `puddle`, `edge`,
`channel`, `orientation`) to select an experiment. Each has start, pause, and reset controls.
The pool cubes share the same volume; their configurable masses determine
buoyancy. The orientation test starts one 58 kg plank nearly upright and the
other flat; changing each to 200 kg makes both heavier than their 144 kg maximum
displaced water mass. The drain and hose report actual removed/added volume. On
the ledge, water flows over the lip under gravity and is retained in the lower
basin, without a drain or artificial suction.
`/tests/visual/crumpling-workshop.html` demonstrates ductile panels versus brittle
fragments.

## Animated surface water

```ts
import { compileWater, sampleWater } from '../sandbox/water.ts';
import { WaterView } from '../sandbox/waterView.ts';

const lake = compileWater({
  id: 'north-lake', kind: 'lake', seed: 37,
  center: { x: 20, z: -15 }, size: { width: 70, depth: 45 },
  level: 2, depth: 5, windSpeed: 2,
});
const view = new WaterView(lake, {
  segments: 48, updateHz: 20, transitionSeconds: .6,
  // Optional: sampleGround: (x, z) => sample your terrain height here.
});
scene.add(view.root);
// Per render update; wind direction is radians, speeds are metres/second.
view.update(elapsedSeconds, { windSpeed: weather.windSpeed, windDirection: weather.windDirection });
// Pure deterministic query; useful for decorative buoys or audio positioning.
const surface = sampleWater(lake, { x: 20, z: -15 }, elapsedSeconds);
// On unload: view.dispose();
```

Lakes have elliptical boundaries. Oceans use a bounded rectangular patch; use
large dimensions for a distant ocean, with detail chosen for the camera's range.
Rivers use a world-space centreline with interpolated elevation and width:

```ts
const river = compileWater({
  id: 'river', kind: 'river', currentSpeed: 1.5,
  path: [
    { x: 0, z: 0, y: 8, width: 4 },
    { x: 12, z: 18, y: 7, width: 7 },
    { x: 28, z: 26, y: 4, width: 5 },
  ],
});
```

The river mesh clips a shared grid to the variable-width path, avoiding overlapping
geometry at inner bends. It is a visual surface, not a hydraulic solver; avoid
crossing a path over itself at different elevations. `locateWater` returns containment, interpolated level, distance from
shore, approximate depth and the local flow direction. `sampleWater` adds wave
height, surface normal, foam, linear RGB color and roughness.
The river grid automatically refines to roughly three samples across its narrowest
width, up to 128 segments. `inspection().resolutionLimited` flags paths too long
and narrow for that budget: split those into shorter water patches, otherwise
small bends or very thin channels can disappear between samples.

`WaterView` allows 8–128 segments and 1–60 updates/second; its default is 48
segments and 20 updates/second. It uses no custom shader hooks or global
loaders, preserving the engine's ordinary Three/WebGPU compatibility path.

## Weather and authored animation states

The default profiles are `calm`, `choppy` and `storm`. AI-authored recipes can
replace them with 1–16 uniquely named profiles in increasing `minWindSpeed` order.
Each profile specifies:

| Field | Meaning |
| --- | --- |
| `id`, `minWindSpeed` | State identity and wind threshold in metres/second |
| `amplitude`, `wavelength`, `speed` | Wave height, wavelength and phase speed |
| `roughness` | 0–1 surface lighting roughness |
| `foam`, `shoreFoam` | 0–1 crest and shoreline foam amounts |
| `color` | `#rrggbb` water tint |

Wind continuously blends neighbouring profiles. A gameplay condition can choose
an exact animation profile with `view.update(time, { state: 'enchanted' })`.
The view eases parameter changes over `transitionSeconds` and integrates wave
phase, so changing weather does not restart the animation. Shore foam advances
and recedes with waves; its timing and strength respond to the weather. Optional
`sampleGround` supplies terrain depth and suppresses dry cells; it runs during
construction rather than querying every vertex every frame. Recreate the view
when the terrain itself changes.

`sampleWater` is a stateless target-state query. During eased transitions its
height can differ slightly from the view, which retains prior weather and phase.
Do not use it as a conservation-of-volume or collision simulation.

## Lighting and textures

Both views use ordinary `MeshPhysicalMaterial`: changing geometry normals and
roughness changes direct-light highlights and environment reflections. The water
IOR is 1.333, with dielectric Fresnel behavior and a clear surface layer. Supply
`scene.environment` or a borrowed `envMap` for reflected surroundings. This is
not a screen-space ray tracer: it does not automatically reflect every moving
object, model caustics, or simulate optical absorption/refraction through depth.

`map`, `normalMap` and `envMap` accept textures produced by the existing texture
system, authored images or caller-managed material recipes. UVs are world-aligned.
Textures remain owned by the caller, so views never dispose shared maps. Own
geometry/material resources are released idempotently by `dispose()`.

## Water body terrain flow

```ts
import { compileWaterDomain } from '../sandbox/waterDomain.ts';
import { compileWaterBody, createWaterBodyState, pourWaterBody,
  stepWaterBody } from '../sandbox/waterBody.ts';

const water = compileWaterBody({scene: currentTerrainScene, cellSize: .2,
  liquid: compileWaterDomain({id:'flood', bounds:domainBounds, boundary:'closed',
    sources:[{id:'hose', min:{x:-3,y:2,z:0}, max:{x:-2.8,y:2.2,z:.2},
      rate:.02, velocity:{x:2,y:0,z:0}}]}),
});
let state = pourWaterBody(water, createWaterBodyState(water),
  {point:{x:0,y:0,z:0}, radius:2, volume:1.5});
const flow = stepWaterBody({water,state,
  scene:currentTerrainScene,bodies:movingBodies,dt:1/30});
state = flow.state;
// Apply flow.contacts to the existing liquidCoupling helpers once.
```

`compileWaterBody` takes a domain from `compileWaterDomain` (bounds, rest
density, downward gravity, `maxSpeed`, `closed`/`open` boundary, up to 8 sources
and 16 drains) plus the scene. A source is a steady jet in m³/s: water leaves
its box with `velocity`, falls ballistically and enters the grid where it lands,
carrying its horizontal momentum and driving underwater circulation below the
landing. Drains remove the water standing inside them and account for it.
`compileWaterBody` rejects the removed `maxActivationsPerStep`,
`particleResidence` and `particleSettleSpeed` options; `createWaterBodyState`
starts empty.
The depth/current solver uses hydrostatic reconstruction, tracks actual wet/dry
cells, and retains volume while spreading and pooling. Calm cells can sleep;
neighboring flow, changed barriers, and disturbances wake affected regions.
Each body has one support elevation per hydraulic region. For overlapping
floors, bridges or a lake above a cave lake, use `compileWaterWorld`,
`createWaterWorldState` and `stepWaterWorld` from `waterWorld.ts`. Supply actual
solid colliders and any additional upward support triangles. The compiler
extracts real upward faces from fixed box/convex placements and derives free
vertical intervals, regular water layers, ceilings and local connections at
real openings. Authors supply sources and initial water points with world Y;
they do not assign water to storeys or write stair-transfer loops. Each loose
body receives water coupling once in its current free interval. Integrate the
returned bodies with native physics once, and retain the entire world state.

Render accepted layers with `buildWaterWorldSurfaces(world, state, {workspace})`
and `WaterWorldSurfaceWorkspace` from `waterWorldSurface.ts`. It shares border
heights, normals and flow across submerged openings, including places where
one physical basin changes storage rank. Walls, dry crests and separate floors
remain independent. Pass each returned surface packet to its `WaterSystemView`.

`compileBuildingToWaterGeometry(building)` in `buildingWaterGeometry.ts`
derives supports from generated floors, stairs and roof surfaces. Asset basin
floors can expose a real surface tagged `water-support`. The same native
colliders block the water; this is not a separate proxy house.

For terrain that is not a single heightfield, `compileTerrainVolumes` from
`terrainVolumes.ts` accepts finite-thickness sampled slabs: top and bottom
vertex elevations plus optional missing cells (`holes`). Several slabs may
overlap in XZ. `createTerrainVolumeWorld(baseScene, terrain)` supplies matching
native collision and water supports; `TerrainVolumesView` draws those same
triangles, including undersides and hole walls. Pass its `scene` and `supports`
to `compileWaterWorld`. Ordinary `TerrainRecipe` remains the fast single-surface
option. Hiding a slab in the view never removes its collision or water ceiling.

Static topology is compiled once, bounded to eight layers and 16,384 total
water cells. Terrain volumes allow up to 96 native solid pieces; complex
geometry exceeding a budget throws instead of dropping collision. These are
free-surface pools: a roof prevents leakage, but pressure-filled cavities are
not supported and reaching a ceiling throws. In a closed world, falling water
must have a supported receiving floor; missing support throws an actionable
error rather than losing liquid. Open worlds account for water leaving bounds. The API requires declared support
geometry or native box/convex solids; it does not discover arbitrary mesh interiors. Terrain
and support topology changes require recompilation and deliberate state
remapping. Floating objects never trigger layer reconstruction.
With precise placement boundaries enabled, native floor and stair footprints
split only the affected cells. Each region keeps its actual support height and
overhead clearance. Open sides connect to neighbouring supported regions even
when the opening and a wall share one grid cell. Sources and bodies use their
actual world position to select a supported interval. With precision disabled,
an overhang conservatively limits a whole cell to its lowest overlapping
ceiling; unrepresentable openings are rejected rather than routed through floors.
In authored games, topology compilation runs through the trusted water host
and returns compact immutable geometry within the existing sandbox limits.

Internally, `exchangeWaterBodyConnection` in `waterBodyConnections.ts` joins
adjacent cells at a real opening, preserving volume/momentum and both ledgers.
It rejects remote endpoints and oversized openings. Prefer the world compiler
for geometry-derived connections; the helper alone cannot discover obstacles.
`waterBodyPipes.ts` separately models routed, stored pipe flow within one body.
Existing grid
water requires explicit remapping
before changing the bed elevation; unsupported edits are rejected rather than
moving all the water instantly. Solid barrier changes remain supported.

`disturbWaterBody(water,state,{point,radius,impulse,bodies},scene)`
applies an external impulse in N·s to nearby water: horizontal momentum enters
the flow and vertical momentum drives underwater circulation. `activate:true`
was removed and throws. Supply current dynamic `bodies` with the scene so the
circulation respects moving solids. `pourWaterBody` explicitly adds new volume.
`sampleWaterBody` returns local depth, surface level, current and sleep state.
Validate saved snapshots with `validateWaterBodyState`. Supported grid volume
plus `waterBodyFlightsVolume(state.flights)` must equal initial volume plus
external additions minus external removals (floating-point tolerance). Routed
pipe storage is counted separately in the system total.

The demo browser includes **Dam flood & cottage** (`water-world.html?test=dam`)
and **Upstairs sink · House flood** (`water-house-overflow.html`). The latter uses
`compileBuilding` and an asset family for the sink/books, with water support
derived from the generated floors, solid stair treads and sink basin. The engine finds
the layers and openings, including untagged solid basin rims; native rigid-body
physics carries the loose books. Accepted transfers drive shared fall sheets
and impact spray through the same detail events as other water scenes.
The tap is accelerated for observation. **A lake above a lake**
(`water-cave-lakes.html`) demonstrates two separate pools at the same XZ under
an intact solid roof, with a spring feeding only the upper lake. Its open-shaft
option removes actual roof geometry and lets the engine discover the connection.
**Release the
reservoir** includes a native wooden plank. These are editable test fixtures,
not alternate water solvers.

`waterBodyWire.ts` provides `waterBodyStateShape`, `encodeWaterBodyState`
and `decodeWaterBodyState` for shared world schemas and checkpoint persistence.
The lossless Float64 payload fits existing schema limits beside destruction
state. Wire snapshots support at most 4,096 grid cells and 256 barrier IDs of
at most 128 characters, within a 688,128-byte payload. Decode validates the
manifest, checksum, finite values and ledger, and refuses old checkpoints that
carried 3D particle water. This is not a cheap per-frame replication strategy.

The default regular grid uses conservative grounded-obstacle bounds and approximate pressure
loads. Pressure is divided by each obstacle's actual covered face width,
including faces shared by adjacent panels; overlapping boxes do not double
the load. Flow still closes a coarse face conservatively, so gaps narrower
than a cell may be blocked. Use the default static boundary mode above when its
supported geometry must retain subcell gaps and separate levels. In either mode,
moving objects displace water and face pressure launches waves and currents, with no artificial
upward kick. Moving obstacle edges are distinguished from broken static
retaining walls, so small movements do not register as dam breaches.
This is not an exact fluid/rigid-body coupling or an engineering load model.

`applyWaterBodyBuoyancy({water,state,bodies,dt})` in
`waterBodyBuoyancy.ts` adds buoyancy and current drag for the grid water.
Retain its returned state and combine its contacts with the flow step's
contacts before applying coupling once. Evaluate buoyancy using temporary
post-flow bodies from `applyLiquidImpulses(bodies, flow.contacts)`. Apply the
combined flow and buoyancy contacts once to the original bodies before native
integration; applying them again to those temporary bodies doubles the impulse.
It measures submerged collider volume,
including rotations, rather than the enclosing bounding box. Lift acts through
each submerged portion's volume centroid. Its moment about the body's actual
center of mass becomes an `angularImpulse`, so an unstable plank can tip before
settling. Diagnostics include `centerOfMass`, `centerOfBuoyancy`,
`buoyancyTorque` and `dragTorqueImpulse`; the buoyancy centroid is absent when
no grid water is displaced. Shared `physicsMassProperties.ts` computes the
volume-weighted compound center and world inertia tensor, including rotated
colliders and off-center convex shapes. It assumes uniform solid density across
the compound, matching the native body; individual material density maps are
not part of this helper.

A solid floats when it can displace water heavier than itself. Orientation
changes how deep it must sit and whether its balance is stable, but the same
fully submerged sealed solid has the same maximum lift in every orientation.
A broad plank can float shallowly when flat and sit much deeper when upright;
do not switch its density or buoyancy off just because it is on edge. A supported
upright pose can remain upright if the support supplies the missing torque.
Open/slatted collider proxies
can reduce `displacementScale` (0–1) to represent actual solid volume; a sealed
hollow shell can displace its full enclosed volume. Flooding an open container
or changing trapped air needs a separate authored state/model, not an
orientation-based float/sink rule.

Default vertical and roll/pitch damping remain 4 per second. Horizontal
gliding uses `horizontalDrag` (default .35), and yaw uses `yawDrag` (default .25).
All accept per-body overrides through `bodyOptions`. Explicit legacy `drag`
and `angularDrag` settings apply to all their axes unless the corresponding
new horizontal/yaw override is supplied.
Horizontal drag uses velocity at each immersed point, including the body's
rotation. Portions are evaluated together to avoid directional bias from cell
iteration order. A shared bound keeps combined body and grid kinetic energy
from increasing and respects the grid's maximum flow speed; horizontal momentum
is exchanged equally and oppositely with the affected cells. Vertical damping
uses an aggregate center-of-mass force, so splitting a collider across more
grid cells does not change its damping rate. Angular drag then damps the
remaining immersed spin without forcing a preferred pose. Its lost spin goes
to unresolved turbulence, rather than resolved grid circulation. The grid
stores submerged solid volume separately in `solidDepth`: its surface is `bed + depth + solidDepth`,
while `depth` continues to count only water. Entering and moving bodies displace
that water and launch height waves through the same conservative grid solver.
Moving submerged faces also exchange normal pressure with the surrounding grid,
using point velocity including rotation. The corresponding body reaction is
returned in the ordinary flow contacts. This works for authored moving actors
and free props using their current collision shapes; no boat, shark or stirrer
identifier is special to the solver. Displacement, pressure and viscous drag
have separate roles and each reaction is applied once.

Floating hulls are solved together with the water (`waterBodyHulls.ts`). Where
a free, afloat body crosses the water level in a column, `stepWaterBody` treats
the grid step as a predictor and then solves one pressure correction: the head
offset in each such lid column, the water flowing under it and the body's
heave, roll and pitch, so that the liquid fits the hull's pose after the native
step. The body receives that pressure as one vertical support contact with its
moment. Handing displacement over one step late instead let a light, broad
board pump itself on the large mass of water it pushes aside: the channel's
fallen breakwater panels bounced at about 0.3 s forever. With the water's added
mass in the solve, such a board heaves slowly and settles. The system is
symmetric positive definite (column compliance, grid pressure faces and rigid
body response) and is solved with a fixed-tolerance conjugate gradient in a
fixed column order, so it adds no saved solver state. It predicts the native
step's motion with `physicsGravityDisplacement(dt)`, which matches the host's
fixed substeps. Partly covered columns act as soft springs and fully covered
ones as constraints. Columns where the water would pull a hull down, or where
the predicted displacement exceeds the actual solid volume in that column,
return to explicit buoyancy. This bounds the floating-lid approximation during
entry and submersion: impact pressure cannot become an impossible solid volume
that raises a water spike over a sinking object. A body touching the bed
anywhere under it, or one that is `fixed`,
keeps the explicit displacement and buoyancy, since native contact holds it.
`state.hulls` lists each body's lid columns for that tick:
`applyWaterBodyBuoyancy` then skips their vertical buoyancy (the solve supplied
it) but still applies drag, against the motion the solve predicted for the
step. Probes ignore it and measure plain hydrostatics. The coupled step is
implicit, so it is stable at any rate but also damps fast heave and roll more
than the physical radiation damping at coarse `dt`; moving hulls feel some
wave-making resistance as they enter and leave columns.

Wet surface waves use bounded finite-depth dispersion and limited surface
reconstruction, so shorter ripples can travel at different speeds without
being immediately smoothed away. Straight motion can form a trailing wake;
turns, stirring and entry produce curved fronts. Wave shape depends on speed,
immersion, depth and physical grid resolution. Waves reflect from retaining
boundaries, interact with other bodies through the same water surface/current,
and lose energy through configured `friction` and numerical dissipation.
The dispersion correction adds no water and requires no extra saved state.
Dry fronts and steep discontinuities retain the conservative flow treatment.
Vertical support remains an approximation: the surface grid owns water depth,
while the optional circulation field resolves bounded vertical momentum below
it. This combination does not resolve overturning waves or air entrainment.
Keep the returned `solidDepth` in checkpoints; the water body wire codec preserves
it and still accepts older snapshots without it. `hulls` is same-tick
information for buoyancy; the next step replaces it and the wire omits it.

Pass active bodies each step. Sleeping bottom debris can be checked at a lower
rate for both flow pressure and buoyancy (the workshop checks twice a second),
while ordinary impacts can wake it immediately. On a probe tick, include those
bodies in the water step and omit their duplicate static colliders from its
scene; apply the measured contacts to the original sleeping destruction state.
`applyLiquidDestruction` keeps grounded debris asleep
when gravity, buoyancy and ground friction can balance the load. It preserves
active settling timers and wakes only affected pieces for sufficient lift,
current or impact. `debrisSleep` options tune gravity, support friction and
impact thresholds; use `false` with a custom support model for steep/complex
contacts. Settled debris remains a collider but is excluded from native body
integration. The shared destruction solver also recognizes small inward contact
velocity residuals when the actual supported pose stays nearly stationary for
the full settling window; sliding or bouncing debris remains active.
The workshop's panel-mass control compares 75 kg floating solid
panels with 1200 kg sinking panels at the same geometry and water volume.

`waterBodyFloating.ts` optionally puts calm floating debris into a separate
low-cost rest state. Create it with `createWaterBodyFloatingState(water,
structure)` and persist it alongside the water and destruction checkpoint.
After the ordinary water, buoyancy, coupling and native destruction step, call:

```ts
const rest = stepWaterBodyFloating({
  water, state: waterBodyState, structure, destruction: native.state, floating, dt,
  scene: baseScene, contacts: flow.contacts, impacts: native.impacts,
  groundedBodyIds: native.groundedDebrisIds,
});
destruction = rest.destruction;
floating = rest.floating;
```

Only quiet, partially immersed bodies with adequate measured buoyancy and a
stable rotational equilibrium qualify. Entry checks reject an appreciable
buoyancy torque and probe small tilts in both horizontal axes. A mathematically
balanced but unstable upright pose receives a tiny deterministic angular
perturbation and remains in full physics; subsequent motion comes from the
ordinary forces, without choosing a final orientation. These bounded checks run
only when entering rest, not every rendered frame.
`floating.resting` identifies their body IDs. Exclude these IDs from the periodic
grounded-debris pressure/buoyancy probes; active bodies still receive ordinary buoyancy.
A resting floater remains a solid collider but skips native integration and
submerged-volume clipping. A small set of local surface probes runs four times
per second, with a smooth vertical response
to gentle measured wakes. Moving colliders reuse cached terrain samples while
their obstacle bounds and barriers still update; terrain content edits invalidate
that cache. Still water permits still objects; it does not add
an endless decorative bob. Larger waves, currents, lost support, changing water
levels and impacts restore full physics. Call `wakeWaterBodyFloating` before
stirring or applying forces. When releasing a dragged or rotated body, call
`releaseWaterBodyFloating({floating,destruction,bodyId,velocity,angularVelocity})`
before the fluid/native step. Pass measured world-space release motion in m/s
and rad/s; omitted velocities retain the existing values. Transform-only edits
do not infer throw speed. This wakes only that body, preserves its pose and
lets water drag gradually dissipate its momentum. Floating rest requires
horizontal speed below .015 m/s and yaw below .02 rad/s for the quiet interval;
it also detects newly assigned nonzero velocities on a resting body.
Validate restored records with
`validateWaterBodyFloatingState`; do not reuse them after changing manifests.
The workshop enables it by default and reports **resting afloat** separately
from **on bottom**. Its checkbox permits comparison after Reset.

`WaterBodyView(water).update(state,nowMs)` reuses a fixed grid mesh and uploads
changed patches. `animate(displaySeconds,nowMs)` animates optical ripples without
running physics. The view clips against the real terrain and actual wet cells;
it does not extend a decorative skirt across dry ground. The water body view uses
the Three WebGL material path. Its `map`, `normalMap` and `envMap` remain owned
by the caller. Dispose the view when removing the body of water.
Connected wet cells share smooth vertex normals and synchronized boundary
interpolation, avoiding square lighting facets and cracks during topology
changes. Retaining walls and disconnected pools keep separate surfaces.
`waveNormalStrength` (1–8, default 1) can strengthen reflections from actual
simulated surface slopes when small wakes are hard to read. It changes neither
water heights nor physics. Lower `opticalStrength` when cosmetic ripples compete with the simulated waves.
`waveContrast` (0–1, default .35) shades opposing faces of those measured waves
for visibility under diffuse lighting. It becomes neutral when the simulated
surface is flat.
Wet neighbors separated by a solid obstacle render only their exposed height
difference. Equal-level neighbors do not create overlapping underwater walls
along the obstacle's grid footprint.

For an interactive host, a worker can run `buildWaterBodySurface(water,state)`
and transfer the resulting `WaterBodySurfaceBuffers`; pass them as the fourth
argument of `WaterSystemView.update(state,nowMs,scene,surface)`. The buffers must
match the accepted state's revision and time. Allow at most one outstanding job
per worker and reject results from an old generation after reset.

### Recorded effects and live handoff

`waterPlayback.ts` is an optional host-side animation facility. Create a
`createWaterEffectRecorder` with `mode:'interactive'` or `'cosmetic'`, explicit
environment/configuration signatures and storage limits. Record accepted
surface buffers with increasing times, then `finish()` to obtain a reusable
clip. Interactive frames also require a same-time physical checkpoint, which
may include water body state and coupled destruction state. Cosmetic clips
contain no physical state and cannot exert forces or add water.

`createWaterEffectPlayback(clip).sample(time,{signature,interaction})` selects
a recorded frame and optional safe vertex correspondence. A changed signature,
new interaction or the clip's end produces a one-shot live handoff for
interactive clips. Restore the checkpoint exactly once, preserve the new
external change, and continue from the returned physical time. Never apply
previous collision impulses again. A checkpoint is the last accepted physical
frame, not an invented interpolation between frames.

Signatures must identify the terrain/obstacles, source setup, physics settings
and initial world state. Only replay compatible scenarios. Geometry, recording
memory and upload costs remain even when the solver is stopped. Keep frame,
duration and byte limits; do not record every water body by default.

In the workshop, enable **Record next run for playback** before Reset, run a flood, then choose
**Replay captured run**. **Stir pool** invalidates playback and resumes live
water from its matching checkpoint before applying the new impulse.

### Moving actors and pipe-transfer experiments

The workshop includes a tall sinking rock, a stirring stick with a free plank
and rock, a swimming/diving/breaching shark, and a boat following straight runs
and turns among free planks. Actor motion is powered: its pose and velocity are
sampled each tick and its finite-mass collision shapes participate in grid
pressure, buoyancy/drag, and native rigid-body contacts. The plank and rock poses are
always physical. Dense grounded objects use bottom contact and friction, remain
eligible for native sleep, and never enter the resting-float animation.

Use `waterBodyPipes.ts` for hydraulic connections between grid regions. A
connector with a `path` stores water in finite pipe segments, so filling,
gravity-driven drainage, and downstream backwater take time. Retain its
`WaterBodyPipesState` alongside the grid state and include
`waterBodyPipesVolume(pipeState)` in the total water inventory. The pipe's
grid-entry and grid-exit counters distinguish internal transfers from water
added to or removed from the combined system. Connections without a path keep
the cheaper primed, instantaneous-transfer behavior.

The workshop's elevated source tank drains through its floor outlet into a
lower tank. Its clear pipe shows each segment's stored volume. The exposed
section drains after the source empties, while the submerged lower section
retains water at the receiving tank's level. Pressure head and losses limit
flow. This bounded hydraulic model does not simulate air pockets or two-phase
flow inside the pipe.
