# Six complete engine starters

The engine includes six editable reference games: Duel, Arena, Cooperative RPG,
Social Lounge, Kestrel Tactical FPS and Blockwild Voxel Survival. Blank is an
explicit utility template, not the default recommendation.

Use `listEngineStarters()`, `readEngineStarter(id)` and `installEngineStarter(id,
projectDirectory)` from `@patchgames/engine/starters`. Installation refuses to
overwrite project files unless requested. Each template supplies `src/game`
source, tuning and rendering; applicable authored checks live in `tests/game`.
Install the engine into the destination project and run its materializer before
building. The host compiler uses the same sandbox boundaries as other games.

| ID | Reference systems |
| --- | --- |
| duel | Guards, melee damage, parries, dodging and rounds |
| arena | Multiplayer elimination, loot and a shrinking zone |
| rpg | Classes, enemies, cooperative encounters and campaign progression |
| social | Seating, interactions and social minigames |
| fps | 5v5, five operators/two abilities each, weapon/armor economy, planting/defusal, three-site map |
| voxel-survival | Seeded block terrain, mining, placement, crafting, inventory and a managed HUD |

The FPS and voxel games are derived from Kestrel Protocol and Blockwild Survival.
Their source remains ordinary editable content. Their generic genre names and
original content do not imply affiliation with other games.

The platform materializer supplies trusted mode copies for existing host code.
Edit the templates in this repository, never the generated host copies. A
running platform's active season game is separate from these canonical starters.

Starter selection, AI prompts, provider calls and protocol endpoints stay in the
private integration. Public templates contain gameplay and reference material.

Starter views install local texture pixels through `installStarterMedia()`.
They do not require the hosted texture service. The FPS gun sounds use editable
procedural recipes; no account or external sound download is required.
