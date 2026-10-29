/**
 * Medieval Duel base authoring guide.
 *
 * rules.ts owns the deterministic three-lane sword state machine. The host owns
 * health, match duration and outcomes; entities.ts submits checked melee sweeps.
 * Both actors advance before contacts resolve, so simultaneous attacks trade.
 * Guard is passive in idle; a fresh directional input near contact enables a
 * parry. Hilt strikes bypass sword guard and are countered by another hilt action.
 * Space is classified by authoritative held duration: short release dodges,
 * holding sprints, and releasing after sprint never triggers a dodge.
 *
 * shapes.ts declares motion and visual state plus a numeric motion rollback
 * snapshot. Authority records input edges, cooldowns and action timers after
 * contacts resolve. Prediction replays the same local progression and movement;
 * damage, parries, hilt counters and their stun outcomes remain authoritative.
 * Rendered action labels stay authoritative. Never derive damage from Three.js
 * meshes or the client camera.
 *
 * terrainWorld.ts provides the same flat circular court to rendering, spawn
 * queries and physics. physics.ts delegates all collision/gravity to the shared
 * Rapier bridge; movement.ts applies coordinated inputs before one body batch.
 * Prediction uses that same batch while extrapolating remote velocity.
 *
 * view/ contains the knight rig, two-hand sword animation, courtyard, close
 * third-person camera, overlay, material recipes and spatial audio. Shared
 * equipment orientation declares the real blade/grip geometry. Authored hand
 * constraints, motion matching and action poses remain presentation only.
 *
 * The duel-melee inspection fixture stages both players in weapon range only
 * for rendering; ordinary matches start apart and require movement to engage.
 * Test combat through the QuickJS testkit in tests/game/request. Inspect normal
 * setup plus moving guard/attack/charge/bash/dodge sequences and gameplay camera.
 * Static checks do not prove visual quality, multiplayer latency or audio quality.
 *
 * Tuning comes from each frame/context, never runtime imports of tuning.json.
 * Preserve source recipes and standard position/appearance/terrain capabilities
 * so native feature mods can compose with this base across supported modes.
 */
export {};
