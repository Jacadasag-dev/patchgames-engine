# PatchGames Engine

A TypeScript game engine for sandboxed multiplayer simulation, browser rendering,
and reusable game-authoring APIs. Licensed under Apache-2.0.

The engine provides:

- Authoritative QuickJS game logic, validated state/input contracts, bounded
  execution, deterministic random streams, and Rapier physics bridges.
- Browser prediction, terrain preparation, render workers, WebGL/WebGPU helpers,
  and diagnostics.
- Composable terrain, voxel worlds, authored map assemblies, procedural buildings,
  water, destruction, firearms, character rigs, animation, and equipment helpers.
- HTML/CSS game UI with layout validation, moddable themes, inventory presets,
  scene transitions, and round lifecycle contracts.
- [Material generators](docs/material-generator.md) with eight editable families,
  repeatable PBR maps, physical scale and pixel-art through 2048-pixel output.
- [Shared generation maps](docs/generation-maps.md) for layered terrain, bounded
  foliage variants and directional material variation using Map → Combine → Apply.
- [Generated LOD](docs/generated-lod.md) for prepared terrain, foliage and analytic
  model detail levels, filtered material mipmaps and render diagnostics.

Run `npm run demo:materials` for the interactive Material Lab: 50 generated
presets, editable controls, 3D preview, texture maps and PNG/JSON exports.
It also includes [object surface recipes](docs/object-surfaces.md): a grass-topped
dirt block and a brick wall with one editable, non-repeating slash.

Run `npm run demo:generation` for the [Generation Lab](examples/generation-lab.html):
edit one shared graph and preview terrain, four varied trees and wall weathering.

Run `npm run demo:leaf-lod` for the [Leaf Coverage Lab](examples/leaf-lod-lab.html):
compare full and two-triangle leaf cards at fixed distances, inspect mip opacity,
and measure the rendered canopy with and without multisampling.

Run `npm run demo:planet` for the [Planet Flight Lab](examples/planet-lab.html):
fly from orbit to local terrain on an Earth-sized procedural sphere while bounded
worker jobs refine the visible surface. Read [planet integration and scope](docs/planet-generation.md)
before connecting spherical terrain to gameplay.

The same lab includes [atmosphere and volumetric cloud generators](docs/planet-sky.md)
with live realistic/pixel styles, shared weather fields and bounded quality.
It also supports native WebGPU, generated terrain materials, nine climate biomes,
seven forest species, compiled buildings and spherical engine water. Read
[populated planet integration](docs/planet-worlds.md) for worker setup and budgets.
The sky includes a rotating sun, day/night stars, fog, cumulus and cirrus,
cloud shadows and volumetric shafts. Its [circulation-driven weather](docs/planet-weather.md)
uses latitude regimes, cyclone tracks, coastlines and terrain instead of a uniform cloud noise shell.

## Complete starter games

Six editable games ship with the engine: Duel, Arena, RPG, Social Lounge,
Kestrel Tactical FPS and Blockwild Voxel Survival. See [starters](docs/starters.md)
for installation and reference systems. Blank is available only as an explicit
empty template.

## Quick start

Use Node.js 22.18 or newer and npm:

```sh
npm ci
npm run check
npm run demo
```

The demo compiles a small game, runs two players through 60 authoritative ticks,
and checks their final positions. It needs no PatchGames account, database,
cloud credentials, or running platform server. See [the example](examples/headless.ts).

## Use the source package

The package exports TypeScript source for Node's type-stripping runtime and
TypeScript-aware bundlers such as Vite. This initial version is not published to
npm; install it from a local checkout or a pinned Git revision.

```ts
import { compileMapAssembly } from '@patchgames/engine/sandbox/mapAssembly';
import { MatchSandbox } from '@patchgames/engine/host/match';
import { GameUiHost } from '@patchgames/engine/ui';
```

Import only the modules needed by each environment. Host/compiler modules use
Node APIs; view modules require a browser. Game logic runs inside the sandbox and
imports the approved helpers through the compiler's source boundary.

Start with [generation maps](docs/generation-maps.md), [custom maps](docs/custom-maps.md), [game scenes](docs/game-scenes.md),
[world planning](docs/world-planning.md), [voxel worlds](docs/voxel-worlds.md),
and [shared animation](docs/shared-actor-animation.md). These guides document
engine APIs and standalone integration. The hosted AI connector is maintained
privately; see [the repository boundary](docs/repository-boundary.md).

## Engine and hosted platform

This repository contains the runtime and reusable authoring systems. PatchGames'
account system, paid AI pipeline, tournament service, matchmaking service,
database, moderation, billing, production deployment, and customer games stay in
the platform repository. The headless runtime accepts input streams from your
own transport; a standalone hosted multiplayer service is not included yet.

The hosted platform consumes an immutable version of this package. The installer
generates its compatibility source paths; engine implementations are maintained
here. `extraction-manifest.json` retains the historical extraction audit.

## Assets and animation

Its default humanoid idle/walk/run bank is an original,
procedural starter. It does not provide the same motion-capture quality as the
hosted installation's authored animation bank.

To use a bank you have rights to distribute, call
`configureSharedHumanoidLocomotion(packedBank)` before building motion databases.
The importer, retargeting, and playback code are available independently.

Materials are stored as editable recipes and rendered into temporary GPU textures.
No texture image bank is bundled. Hosted audio binaries require an application resolver. See
[third-party notices](THIRD_PARTY_NOTICES.md).

Animation banks, rigs, clips and bodies use neutral identifiers such as
`creature-fox-01` and `creature-fox-02-v1`. See [asset naming](docs/asset-names.md)
for the naming contract and the breaking changes in 0.2.0.

## Contributing

Run `npm run check` and `npm run demo` before submitting a change. Keep runtime
logic independent of platform services. Add executable tests for new contracts,
invalid inputs, deterministic behavior, and resource limits where relevant.
Never add credentials, customer exports, deployment configuration, or assets
whose redistribution terms have not been verified.

Apache-2.0 permits commercial use and modification. Third-party components keep
their own licenses. The license does not grant permission to use PatchGames
trademarks to imply endorsement.

Procedural trees and bushes use the [foliage generator](docs/foliage-generator.md),
with shared bark/leaf materials, seeded clustering, attached twigs and a live Foliage Lab.
