# PatchGames Engine

A TypeScript game engine for sandboxed multiplayer simulation, browser rendering,
and AI-assisted game authoring. Licensed under Apache-2.0.

The engine provides:

- Authoritative QuickJS game logic, validated state/input contracts, bounded
  execution, deterministic random streams, and Rapier physics bridges.
- Browser prediction, terrain preparation, render workers, WebGL/WebGPU helpers,
  and diagnostics.
- Composable terrain, voxel worlds, authored map assemblies, procedural buildings,
  water, destruction, firearms, character rigs, animation, and equipment helpers.
- HTML/CSS game UI with layout validation, moddable themes, inventory presets,
  scene transitions, and round lifecycle contracts.

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

Start with [custom maps](docs/custom-maps.md), [game scenes](docs/game-scenes.md),
[world planning](docs/world-planning.md), [voxel worlds](docs/voxel-worlds.md),
and [shared animation](docs/shared-actor-animation.md). The
[map authoring handbook](docs/handbooks/custom-maps.md) is suitable for AI tools.
Some inherited guides describe the hosted product's connector/editor workflow;
those hosted services are separate from this repository.

## Engine and hosted platform

This repository contains the runtime and reusable authoring systems. PatchGames'
account system, paid AI pipeline, tournament service, matchmaking service,
database, moderation, billing, production deployment, and customer games stay in
the platform repository. The headless runtime accepts input streams from your
own transport; a standalone hosted multiplayer service is not included yet.

The initial extraction retains source paths to make the separation reviewable.
The production platform still uses its existing source tree until it is migrated
to a pinned version of this package. `extraction-manifest.json` records the source
commit and copied-file hashes; the repositories are not automatically synchronized.

## Assets and animation

This repository excludes Unreal Game Animation Sample source files and their
baked motion data. Its default humanoid idle/walk/run bank is an original,
procedural starter. It does not provide the same motion-capture quality as the
hosted installation's separately licensed animation bank.

To use a bank you have rights to distribute, call
`configureSharedHumanoidLocomotion(packedBank)` before building motion databases.
The importer, retargeting, and playback code are available independently.

Included Mesh2Motion creature data uses CC0-1.0. Media catalog entries retain
source metadata; hosted texture/audio binaries are not bundled. Applications
must supply their own media resolver and assets. See
[third-party notices](THIRD_PARTY_NOTICES.md).

## Contributing

Run `npm run check` and `npm run demo` before submitting a change. Keep runtime
logic independent of platform services. Add executable tests for new contracts,
invalid inputs, deterministic behavior, and resource limits where relevant.
Never add credentials, customer exports, deployment configuration, or assets
whose redistribution terms have not been verified.

Apache-2.0 permits commercial use and modification. Third-party components keep
their own licenses. The license does not grant permission to use PatchGames
trademarks to imply endorsement.
