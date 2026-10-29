# Third-party licensing inventory

The engine's own code is Apache-2.0. That license does not replace the licenses
of dependencies or imported assets. This inventory covers engine 0.2.2's locked
packages, not the private PatchGames platform.

## Direct runtime and build dependencies

| Packages | Declared license | Purpose |
| --- | --- | --- |
| `three` | MIT | Rendering and animation |
| `@colyseus/sdk`, `@colyseus/schema` | MIT | Multiplayer client and state synchronization |
| `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync` | MIT | Sandboxed game logic |
| `cannon-es` | MIT | Physics |
| `simplex-noise`, `@tweenjs/tween.js` | MIT | Noise and interpolation |
| `zod` | MIT | Validation |
| `esbuild`, `@babel/parser`, `vite` | MIT | Building, parsing and development |
| `@dimforge/rapier3d-compat` | Apache-2.0 | Physics |

## Transitive and bundled code

The [machine-readable inventory](dependency-licenses.json) lists all 150 locked
package entries, including optional native binaries and development tools.
Their declared licenses are MIT, Apache-2.0, MPL-2.0, ISC, BSD-3-Clause and 0BSD.
Regenerate it with `node tools/audit-licenses.mjs` after dependency changes.

`lightningcss` and its optional platform binaries declare MPL-2.0. This is CSS
build tooling reached through Vite. MPL obligations apply to covered files when
redistributing that software; unrelated engine/game files do not become MPL.
Preserve the MPL notices and make the covered source available as required.

Vite also embeds dependencies with BSD-2-Clause, CC0-1.0, ISC and MIT notices in
its own `LICENSE.md`. Lockfile metadata alone does not enumerate those components.
Redistribution must retain the applicable parent-package bundled notices too.

MIT, ISC and BSD code generally requires retaining the specified copyright,
license and disclaimer notices. Apache-2.0 requires its license and applicable
notices, and identifies additional obligations for modified covered files.
0BSD has no attribution condition. These are redistribution obligations, not a
requirement to display credits on a game's HUD or title screen.

## Asset records

Voluntary asset credits and separate CC0 notice files are not distributed.
Machine-readable import records retain license identifiers, source locations and
hashes for verification and reproducible builds. They are not attribution notices.

## Can notices be removed?

- The authored humanoid motions need no UE attribution; incorrect UE metadata
  has been removed from the host bank and its current documentation.
- Voluntary creature credits and the optional project NOTICE file have been removed.
- Required code-dependency notices should stay while we distribute that code.
  Removing a dependency from distributions can remove its corresponding notice
  requirement; renaming it cannot.
- The engine's Apache-2.0 license is our chosen license, rather than an external
  dependency that needs replacing.

Primary references: [MIT](https://opensource.org/license/mit),
[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/),
[CC0](https://creativecommons.org/publicdomain/zero/1.0/).
For the exact terms of a distributed component, its included license text is
controlling. This inventory is not a substitute for a distribution-specific audit.
