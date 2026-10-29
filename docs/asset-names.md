# Asset and animation names

Built-in creature banks and bodies use `creature-<animal>-<variant>` identifiers.
Variant numbers are two digits and distinguish separate bodies of the same
animal. Rigs append `-v1`; clip IDs append their semantic action name.
For example, `creature-fox-01`, `creature-fox-02`, and
`creature-fox-02-idle` identify bodies and a clip without naming their suppliers.
Discovery returns readable labels such as **Fox (Variant 1)**.

Use `sharedCreatureCatalog()` to select a bank, then pass its exact ID to
`sharedCreatureAnimations()`, `sharedCreatureMotion()`, or `createCreatureModel()`.
The bank, rig, body, foot-placement profile and clips share the same identity.
Custom assets may use their own identifiers.

The default humanoid clips are `starter-idle`, `starter-walk`, and `starter-run`.
Hosts that install a separate licensed bank export `HOST_LOCOMOTION_DATA` from
`src/engineAssets/humanoidLocomotion.ts`. The installer supplies the neutral
`defaultLocomotionData.ts` adapter. It does not generate legacy adapters.

Version 0.2.0 removes the old supplier-prefixed identifiers and host exports.
There are no aliases or automatic translations. Update authored games and
saved asset selections to IDs returned by the current catalog before rebuilding.

Names are presentation and API identifiers, not authorship claims. Original
source names, hashes, URLs and licenses remain in asset provenance and
`THIRD_PARTY_NOTICES.md`; renaming an asset does not change its origin or license.
