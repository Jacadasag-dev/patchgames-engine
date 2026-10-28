/**
 * The contract between the Patch Engine and the moddable game module
 * (src/game). The Patch Engine owns everything that must never change through
 * feedback: mode-specific participant limits, timers and winner rules,
 * the health rules (src/sandbox/health.ts: validated damage, cooperative recovery,
 * and invulnerability in Just Chatting),
 * the tick rate, networking, all
 * HTML UI, and the release and feedback pipeline. The game module owns the
 * rules of play, the world, the visuals and the controls.
 *
 * Game code never runs with the Patch Engine's powers. It runs in two sandboxes and
 * exchanges only plain data with the Patch Engine, which validates every value:
 *
 * - Logic (src/game/logic.ts: rules, controls, prediction, HUD text)
 *   runs in QuickJS, a separate JavaScript engine compiled to WebAssembly, on
 *   the server, in the browser and in the game's
 *   tests. Only standard JavaScript exists there: no network, files, timers,
 *   process, page or DOM. A bounded JSON interface in src/sandbox/physics.ts
 *   supplies versioned Rapier physics; it exposes no host objects or callbacks.
 *   Every call has a time limit and memory is capped.
 * - The view (src/game/view.ts: the 3D world) runs in a Web Worker inside a
 *   sandboxed iframe, drawing to its own canvas under the locked HTML UI. It
 *   has no network, no storage and no access to the page.
 *
 * Only `import type` from this file: it declares types, not code.
 */

/** Gameplay numbers from src/game/tuning.json, applied live at each match start. */
export type TuningValues = Record<string, number>;
export type { GameModeId } from './gameModes.ts';
/** A dotted path to a number, boolean or string field of a state, such as 'x' or 'combat.guard'.
 * Lists and maps are not scalar, so no path reaches inside them. Any string for an untyped state. */
export type ScalarPath<S> = string extends keyof S ? string : ScalarPathIn<S, []>;
type ScalarPathIn<S, Depth extends unknown[]> = Depth['length'] extends 6 ? never : {
  [K in keyof S & string]: S[K] extends number | boolean | string ? K
    : S[K] extends readonly unknown[] ? never
    : S[K] extends object ? string extends keyof S[K] ? never : `${K}.${ScalarPathIn<S[K], [...Depth, 1]>}` : never
}[keyof S & string];

/** Sessions can start solo; the selected mode owns the minimum and maximum roster. */
export type PlayerList<T> = [T, ...T[]];

// ---------------------------------------------------------------------------
// State shapes: what the Patch Engine syncs to players. Game state is plain objects;
// the Patch Engine builds the network schema from these declarations and copies the
// declared fields out after every step. Fields a shape doesn't declare stay
// private to the game (server-side timers, for example) and are never sent.

export type NumberField = 'number' | 'float32' | 'float64' | 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32';

/**
 * A synced field: a number type, 'boolean', 'string', `[shape]` for a list,
 * `{ '*': shape }` for a map with string keys, or an object of named fields.
 * Limits (checked by the Patch Engine): 4 levels deep, 32 fields per object, 256
 * fields in total, 256 entries per list or map, 128 characters per string.
 * Field names are identifiers of up to 32 characters.
 */
export type FieldShape = NumberField | 'boolean' | 'string' | readonly [FieldShape] | { readonly '*': FieldShape } | ObjectShape;
export interface ObjectShape {
  readonly [field: string]: FieldShape;
}

/** A per-step input field: a button, or a number clamped to [min, max] by the server. */
export type InputField = 'boolean' | { readonly min: number; readonly max: number };
export interface InputShape {
  readonly [field: string]: InputField;
}

/** Optional semantic controls for repeatable AI inspections. Values are legal
 * partial game inputs over a neutral input. No control names are guessed. */
export type InspectionControls = Partial<Record<'forward' | 'right' | 'attack' | 'jump', Readonly<Record<string, number | boolean>>>>;

export interface GameShapes {
  /** Everything in the arena that isn't a fighter (mines, items, hazards...). */
  readonly world: ObjectShape;
  /** One fighter's synced state (position, stance...). Health is separate and owned by the Patch Engine. */
  readonly player: ObjectShape;
  /** What each player sends every fixed step. */
  readonly input: InputShape;
}

/** The plain-object type a shape describes. */
export type StateOf<S> = S extends NumberField
  ? number
  : S extends 'boolean'
    ? boolean
    : S extends 'string'
      ? string
      : S extends readonly [infer E]
        ? StateOf<E>[]
        : S extends { readonly '*': infer E }
          ? Record<string, StateOf<E>>
          : { -readonly [K in keyof S]: StateOf<S[K]> };

export type InputOf<S extends InputShape> = { -readonly [K in keyof S]: S[K] extends 'boolean' ? boolean : number };

// ---------------------------------------------------------------------------
// Logic (runs in QuickJS)

/**
 * One fighter as the game sees it. `hp` and `maxHp` are read by the Patch Engine
 * after every step: it compares health when the match ends and draws the
 * health bars. Non-finite values are ignored; maxHp must be above 0.
 * Set both in setupMatch/setupPlayer. During combat only validated damage
 * changes health, and maxHp stays fixed. A duel ends at the first knockout;
 * Arena continues until at most one survivor remains. Cooperative RPG keeps
 * players downed until a teammate revives them; legacy RPG games without that
 * contract restore health after 3 seconds. Just Chatting ignores all damage.
 * Knocked-out or inactive participants cannot move or deal damage.
 */
export interface GamePlayer<P> {
  readonly index: number;
  /** Host-selected character class, from playerClasses. Empty for games without classes. */
  readonly classId?: string;
  /** Host-assigned team index (0 or 1) in team games (docs/game-tags.md); omitted otherwise. */
  readonly team?: number;
  /** Locked cooperative revive progress, from 0 to 1. */
  readonly reviveProgress?: number;
  /** False for a departed session seat retained to keep participant indices stable. */
  readonly active?: boolean;
  hp: number;
  maxHp: number;
  state: P;
}

/**
 * Something that happened in a step. Types are the game's own.
 * Details are numbers, booleans or short strings.
 */
export interface GameEvent {
  type: string;
  player?: number;
  [detail: string]: unknown;
}

export interface MatchContext<W, P, T extends TuningValues> {
  /** Selected host rules; omitted only by legacy direct callers. Content stays the same. */
  mode?: import('./gameModes.ts').GameModeId;
  /** Host game tags (docs/game-tags.md); omitted or empty for free play. */
  tags?: readonly import('./gameTags.ts').GameTagId[];
  world: W;
  players: PlayerList<GamePlayer<P>>;
  tuning: T;
  /** Deterministic randomness. No argument uses the shared Math.random stream.
   * Prefer random('horse:' + stableEntityId) for independent creature behavior:
   * another entity's draws never shift this stream. Same match seed and ID reproduce
   * the sequence. Reuse IDs across steps; max 1024 streams, 1–128 characters each.
   * Do not use spawn order, timestamps or fresh IDs on every call as stream keys. */
  random(stream?: string): number;
}

export interface StepContext<W, P, I, T extends TuningValues> extends MatchContext<W, P, T> {
  /** Each player's input for this step, or undefined if they sent none. */
  inputs: PlayerList<I | undefined>;
  dtMs: number;
  /** Time since play started. A mode duration of zero means an open session. */
  elapsedMs: number;
  /** The damage the Patch Engine applied at the end of the previous step (react here: remove a shot, knock back...). */
  hits: readonly DamageHit[];
}

// ---------------------------------------------------------------------------
// Entities and damage (locked rules: src/sandbox/damage.ts)
//
// Damage entities are the ONLY way to hurt a fighter. After every step the
// Patch Engine asks the game for each fighter's body and every damage entity in play,
// finds where they touch, and applies the damage itself. Health the game
// changes on its own is ignored. Arena and cooperative RPG allow checked healing
// of living participants. Cooperative RPG also has locked teammate revives;
// legacy RPG uses respawns. Just Chatting ignores damage.

export interface EntityVector {
  x: number;
  y: number;
  z: number;
}

/**
 * A fighter's body for damage: a vertical capsule standing on `at` (the feet),
 * `height` tall and `radius` thick. `guard` is armor: the share of damage it takes,
 * 0 (none) to 1 (all, the default): blocking or armor.
 */
export interface PlayerBody {
  at: EntityVector;
  radius: number;
  height: number;
  guard?: number;
}

/**
 * Something that deals damage on contact with a fighter's body.
 * - kind 'strike' hits each fighter at most once (a punch, a bullet); 'zone'
 *   deals `damage` per second while touching (lava, fire).
 * - shape 'sphere' is a ball of `radius` at `at`; with `from`, it is swept
 *   from `from` to `at` this step (fast shots can't pass through a body).
 *   shape 'box' is an axis-aligned box centered on `at` with half-sizes `half`.
 * - `id` must stay the same for as long as the entity exists and be unique in
 *   the match (a strike remembers who it already hit by id).
 * - `owner` is the fighter it belongs to (null for hazards); it can only hit
 *   its owner when `hitsOwner` is true.
 */
export interface DamageEntity {
  id: string;
  /** What it is, for hits, events and the code index: 'headbutt', 'fireball', 'lava'. */
  label: string;
  kind: 'strike' | 'zone';
  /** Strike: damage per hit. Zone: damage per second of contact. Before guard. */
  damage: number;
  owner: number | null;
  /** Optional participant to affect; contact geometry and all locked damage rules still apply. */
  target?: number;
  hitsOwner?: boolean;
  shape: 'sphere' | 'box';
  at: EntityVector;
  /** Sphere radius. */
  radius?: number;
  /** Sphere: where it was at the start of this step, for a swept contact. */
  from?: EntityVector;
  /** Box half-sizes along x, y and z. */
  half?: EntityVector;
}

/**
 * Something that blocks strikes: a shield, a wall, a force field. A strike
 * whose path reaches a blocker before a fighter's body is stopped there: no
 * damage, and it can't hit that fighter afterwards (ctx.hits reports it with
 * `blockedBy`). A blocker never stops its owner's own strikes, and zones
 * (lava, fire) pass through blockers.
 * - shape 'disc' is a flat circle of `radius` centered on `at`, facing `normal`
 *   (it blocks from either side); 'sphere' is a ball of `radius`; 'box' is an
 *   axis-aligned box with half-sizes `half`.
 */
export interface BlockerEntity {
  id: string;
  /** What it is, for hits and the code index: 'shield', 'wall'. */
  label: string;
  kind: 'blocker';
  owner: number | null;
  shape: 'disc' | 'sphere' | 'box';
  at: EntityVector;
  radius?: number;
  normal?: EntityVector;
  half?: EntityVector;
}

export interface GameEntities {
  bodies: PlayerList<PlayerBody>;
  damage: DamageEntity[];
  /** Things that stop strikes before they reach a body (shields). Optional. */
  blockers?: BlockerEntity[];
  /** Contact healing, enabled by Arena and cooperative RPG rules. Cannot revive. */
  healing?: HealingEntity[];
}

/** One pulse can heal each living target once; IDs must never be reused.
 * The Patch Engine validates the sphere, requires an active living owner and target after
 * damage resolves, and caps health at maxHp. Arena and cooperative RPG support
 * these pulses; other modes ignore them. Lethal damage cannot be healed away. */
export interface HealingEntity {
  id: string;
  label: string;
  owner: number;
  target?: number;
  amount: number;
  at: EntityVector;
  radius: number;
  /** Interrupt this pulse when its target takes positive checked damage on the
   * same tick (for channeled bandages). Omitted preserves ordinary healing. */
  interruptOnDamage?: boolean;
}

export interface PlayerClass {
  id: string;
  label: string;
  description: string;
}

export interface CooperativeRules {
  /** Declared boolean input held near a downed teammate for 3 seconds.
   * The Patch Engine owns the 3-unit range and restores half health after the channel. */
  reviveInput: string;
}

export type CooperativeOutcome = 'victory' | 'defeat';

export interface EntityContext<W, P, T extends TuningValues> {
  mode?: import('./gameModes.ts').GameModeId;
  tags?: readonly import('./gameTags.ts').GameTagId[];
  world: W;
  players: Readonly<PlayerList<GamePlayer<P>>>;
  tuning: T;
  dtMs: number;
  elapsedMs: number;
}

/** Damage the Patch Engine applied: which entity touched which fighter, for how much. */
export interface DamageHit {
  entity: string;
  label: string;
  kind: 'strike' | 'zone';
  owner: number | null;
  player: number;
  /** Health taken, after guard (0 when a blocker stopped it). */
  damage: number;
  /** The entity's damage before guard or blocking. */
  fullDamage: number;
  /** The id of the blocker that stopped this strike before it reached the body. */
  blockedBy?: string;
}

/** An alive-to-zero health transition confirmed by the engine's damage pass.
 * `hit` is the positive contact whose cumulative damage first exhausted health,
 * in the same stable entity order used by the damage resolver. Its entity id
 * lets content recover authored context such as the weapon or hit region. */
export interface ConfirmedElimination {
  player: number;
  hit: Readonly<DamageHit>;
}

/**
 * One player control, declared once and bound by the engine on every platform.
 * `held` is sampled every step; `tap` fires once per press; `axis` is analog in [-1, 1].
 * The engine assigns missing keys, renders the touch layout, lets players rebind in the
 * match menu and lists the declared controls under "View controls" in the Games browser.
 * Games never read raw browser input or draw their own control hints.
 */
export interface Binding {
  /** Stable action id (an identifier). Keep it when the action's meaning is unchanged. */
  name: string;
  kind: 'held' | 'tap' | 'axis';
  /** Player-facing label (1–32 characters). Defaults to the action name. */
  label?: string;
  /** Player-facing sentence (up to 140 characters) shown with the control in the Games browser. */
  description?: string;
  /** Pair movement axes into a touch joystick; positive Y means forward/up. */
  role?: 'move-x' | 'move-y';
  /** Default KeyboardEvent.key values, lower case ('w', ' ', 'arrowup'). Axis keys are [negative, positive]. */
  keys?: string[];
  /** Mouse button: 0 left, 1 middle, 2 right. */
  mouse?: 0 | 1 | 2;
  /** Touch presentation, owned by the engine: a button (default; movement roles become the
   * joystick) or hidden when the action is only meaningful with a mouse or keyboard. */
  touch?: 'button' | 'hidden';
}

/** Browser cursor handling only; the game defines what pointer motion does. */
export interface PointerControls {
  /** free: ordinary motion; capture: drag beyond the scene; lock: click for unlimited motion. */
  mode: 'free' | 'capture' | 'lock';
  /** Mouse button that activates capture/lock, default 0. Escape always releases. */
  button?: 0 | 1 | 2;
  /** Cursor appearance during gameplay only. Defaults to hidden for lock mode, visible otherwise. Hiding does not depend on
   * browser lock permission; successful pointer lock always hides the cursor.
   * Host menus/results override this. Escape is reserved for the host match menu. */
  cursor?: 'visible' | 'hidden';
}

export interface PointerState {
  /** Scene-relative normalized position: x right, y up, -1..1. Frozen while locked. */
  x: number;
  y: number;
  /** Accumulated motion in CSS pixels: x right, y DOWN. Delivered once per fixed step.
   * Do not multiply by dt. No movement means zero, not a reset of your orientation. */
  deltaX: number;
  deltaY: number;
  locked: boolean;
  captured: boolean;
}

/** Optional direct pointer-to-look mapping shared by simulation and local
 * presentation. Only opt in when these inputs directly add to the named angles. */
export interface PointerLookAxis {
  /** Numeric predicted player-state path (nested fixed-object paths are supported). */
  field: string;
  /** Numeric wire input receiving this pointer axis; its declared bounds apply. */
  input: string;
  /** Angle units per CSS pixel. Pointer deltas must not be multiplied by dt. */
  scale: number;
  /** Optional tuning multiplier shared by simulation and display-rate preview. */
  scaleTuning?: string;
  min?: number;
  max?: number;
}
export interface PointerLook {
  x?: PointerLookAxis;
  y?: PointerLookAxis;
  /** A truthy declared scalar player-state path disables pointer look, e.g. an open menu. */
  disabledWhen?: readonly string[];
}

export interface Buttons {
  /** Analog action value in [-1, 1]. Axis keys are [negative, positive]; touch stays analog. */
  value(name: string): number;
  held(name: string): boolean;
  /** True once per press; reading it consumes the press. */
  tapped(name: string): boolean;
  /** Host-rendered UI intents for this action. Reading drains them once per step.
   * Map their fields to declared ordinary inputs; server validation still applies. */
  ui?(action: string): readonly import('./gameUi.ts').GameUiEvent[];
  pointer: PointerState;
}

/** A selectable cosmetic character model. IDs remain stable across mod reorderings. */
export interface PlayerModelOption { id: string; label: string; description?: string }

/** A fighter as the browser sees it. */
export interface FramePlayer<P> {
  id: string;
  name: string;
  /** False for a vacant session seat. Keep its index; omit its avatar and controls. */
  active?: boolean;
  readonly classId?: string;
  /** Host-owned cosmetic selection. Empty/omitted retains legacy appearance overrides. */
  readonly modelId?: string;
  readonly reviveProgress?: number;
  /** Host-assigned team index in team games; omitted otherwise. */
  readonly team?: number;
  hp: number;
  maxHp: number;
  /** The camera subject: the local fighter, or the player being spectated. This
   * flag never grants input authority over another player. */
  isLocal: boolean;
  /**
   * The synced state. Numeric fields listed in `smoothFields` (and the
   * prediction fields, for the local fighter) hold their smoothed or
   * predicted render values.
   */
  state: P;
}

export interface ViewFrame<W, P, T extends TuningValues> {
  /** Authoritative current scene; absent for games without a scene declaration. */
  scene?: import('./gameScenes.ts').GameSceneSnapshot;
  /** Local spectator presentation; absent while controlling your own fighter.
   * targetId is the camera subject (including your dead fighter during the death
   * delay or when no teammate survives), or omitted for a spectator overview.
   * delayRemainingMs is a local presentation countdown, never gameplay time. */
  spectator?: { targetId?: string; delayRemainingMs: number };
  mode?: import('./gameModes.ts').GameModeId;
  /** The game's tags (docs/game-tags.md); omitted or empty for free play. */
  tags?: readonly import('./gameTags.ts').GameTagId[];
  /** Validated base and installed-mod model choices, supplied by the host. */
  playerModels?: readonly PlayerModelOption[];
  /**
   * 'menu' when not in a room, else the match phase ('waiting', 'countdown', 'fighting', 'ended').
   * A knockout or timeout decides the result; the fight keeps running for 3 more seconds (no more damage, the
   * knocked-out fighter gets no input) and the view still gets 'fighting' until the result shows.
   */
  phase: string;
  /**
   * The server's latest world, as sent (updated about 30 times a second). It is out
   * of step with `players`: the local fighter is predicted ahead of it and the others
   * are drawn 100 ms behind it. So something spawned from a fighter (a shot, a thrown
   * item) drawn as sent appears away from that fighter as drawn, most visibly while
   * moving. Draw it leaving its owner as drawn and ease it onto the sent path with
   * SpawnSmoother (src/sandbox/spawnView.ts); what it hits stays the server's.
   */
  world: W | null;
  /** Every fighter as drawn: the local one predicted, the others smoothed. In game index order. */
  players: FramePlayer<P>[];
  /**
   * Events the local fighter's prediction produced since the last frame, when the engine runs
   * the game's `step` locally: what `step` returned for inputs the server has not answered yet,
   * filtered to events naming the local fighter as `player` or `target`. Provisional: play a
   * sound or a flash from them, never change what the match means. Absent when there are none.
   */
  events?: readonly GameEvent[];
  /** Optional local-development snapshots before render interpolation/prediction. */
  diagnostics?: { authoritativePlayers: { id: string; state: P }[] };
  tuning: T;
  /** Milliseconds, from the page's clock. */
  now: number;
  /** Seconds since the last frame. */
  dt: number;
}

export interface InputFrame<W, P, T extends TuningValues> extends ViewFrame<W, P, T> {
  /** The numbers the view last reported through `GameView.info()` (for example the camera direction). */
  view: Record<string, number>;
}

/** Optional numeric representation for learned specialists. No rewards or tactics.
 * Paths are dot-separated shape fields; * addresses every array/map entry.
 * Change these declarations when a patch changes units or control meaning.
 */
export interface LearningInterface {
  player?: Record<string, LearningValue>;
  world?: Record<string, LearningValue>;
  /** Components in a shared coordinate system, of any orientation (2–4 dimensions).
   * Supplies opponent-minus-self components and length, never an aiming command. */
  playerVectors?: { components: string[]; scale: number }[];
  /** Optional neutral and characteristic input magnitude. All legal endpoints
   * remain reachable. Omitted ranges map linearly; no name-based mouse heuristic. */
  inputs?: Record<string, { neutral: number; scale: number }>;
}
export type LearningValue =
  | { kind: 'scalar'; scale: number; center?: number }
  | { kind: 'angle'; period: number }
  | { kind: 'category'; values: string[] };

/** A named, reusable inspection fixture. Metadata is discoverable without
 * running stage. Recommendations are explicit scenario inputs, not hidden
 * changes to a replay. Staging never proves normal gameplay can reach a state. */
export interface InspectionSetupInfo {
  id: string;
  label: string;
  description: string;
  /** Optional authored relevance hints for bounded automatic review selection.
   * Paths are editable source files or directory prefixes ending in /. Feature
   * IDs and arbitrary tags match changed source text; hints are not dependency
   * proof or quality assertions. Explicit scenario selection always overrides. */
  relevance?: {
    sourcePaths?: string[];
    featureIds?: string[];
    tags?: string[];
  };
  recommendedScenario?: {
    recipe: 'locomotion' | 'attack' | 'jump' | 'character-quality';
    durationMs?: number;
    holdMs?: number;
  };
}
export interface InspectionSetup<W, P, T extends TuningValues> extends InspectionSetupInfo {
  /** Runs once after setupMatch, only in isolated inspection. Uses the same
   * seeded random streams, declared state shapes and bounded sandbox as setup.
   * May equip or position actors/world objects, but must preserve the roster,
   * classes, mode and tuning. Simulation then uses ordinary game inputs. */
  stage(ctx: MatchContext<W, P, T>): void;
}

/** The game's logic: src/game/logic.ts default-exports one of these. */
export interface GameLogic<W, P, I, T extends TuningValues> {
  /** Shared selection, gameplay, meeting and cinematic lifecycle. Declare sceneStateShape in world. */
  scenes?: import('./gameScenes.ts').GameSceneRules;
  /** Non-gameplay scenes run this hook instead of step. Ordinary inputs are neutral and health is held. */
  sceneStep?(ctx: StepContext<W, P, I, T> & {scene: Readonly<import('./gameScenes.ts').GameSceneState>; sceneActions: readonly import('./gameScenes.ts').GameSceneAction[]}): GameEvent[] | void;
  /** Request one declared transition after the current step; requests are never predicted locally. */
  sceneRequest?(ctx: StepContext<W, P, I, T> & {scene: Readonly<import('./gameScenes.ts').GameSceneState>}): string | undefined;
  /** Runs once per authoritative entry. Apply previousScene.choices to content state here; classId stays host-owned. */
  onSceneEnter?(ctx: MatchContext<W, P, T> & {scene: Readonly<import('./gameScenes.ts').GameSceneState>; previousScene?: Readonly<import('./gameScenes.ts').GameSceneState>}): void;
  /** Opt-in engine-owned round series for two-team games. See shared/roundSeries.ts. */
  rounds?: import('./roundSeries.ts').RoundRules;
  /** A live objective owned by this team survives that team's elimination (for example a planted bomb). */
  pendingTeamObjective?(ctx: EntityContext<W, P, T>): number | null | undefined;
  /** Omitted for legacy duels. Arena is competitive; RPG supports cooperative
   * campaigns or legacy open sessions, and Just Chatting is an open session. */
  mode?: import('./gameModes.ts').GameModeId;
  /** Modes this content supports. Legacy content defaults to its declared mode only. */
  supportedModes?: readonly import('./gameModes.ts').GameModeId[];
  /** Editable classes offered by the host before a match starts. */
  playerClasses?: readonly PlayerClass[];
  /** Built-in cosmetic models; installed appearance features extend this catalog. */
  playerModels?: readonly PlayerModelOption[];
  /** Opts RPG into downed/revive party rules. Other modes retain their rules.
   * Omitted for legacy RPG games, which keep their automatic respawn behavior. */
  cooperative?: CooperativeRules;
  /** Campaign objective only. The Patch Engine also requires every active
   * participant to be alive to win; an all-downed party loses first. */
  objectiveComplete?(ctx: EntityContext<W, P, T>): boolean;
  /** Team games only: the index of the team that completed a content objective (a capture, a
   * payload), or null/undefined while play continues. The host validates the index and ends the
   * round for that team. With rounds, only the series winner ends the host match.
   * Ignored outside team games. */
  teamObjective?(ctx: EntityContext<W, P, T>): number | null | undefined;
  /** In-game voice chat (docs/voice-chat.md). Omitted means none once play starts: the lobby's voice stops.
   * `scope` is who hears whom: everyone, team (players sharing a team), or proximity (voices fade with
   * distance from player.position.v1 poses, placed in 3D unless `spatial: false`). The engine owns
   * microphones, connections and UI; a game never adds voice controls. */
  voice?: import('./voicePolicy.ts').VoiceDeclarationInput;
  /** Optional per-step voice state by participant index: a `channel` (only players sharing one hear each
   * other, overriding the scope's grouping), an `effect` on how this player sounds to others and a
   * `hearing` effect on everything they hear (muffled, underwater, echo, radio), or `silent`. Return the
   * same values while nothing changes; the host validates and syncs only changes. */
  voiceState?(ctx: EntityContext<W, P, T>): readonly (import('./voicePolicy.ts').PlayerVoice | null | undefined)[] | null | undefined;
  shapes: GameShapes;
  /** Versioned public contracts available to reusable features. */
  featureCapabilities?: readonly string[];
  /** Shared terrain adapter used by this base's physics, spawns and prediction.
   * Pair with the same view adapter and a terrainRevision world string field. */
  terrainWorld?: import('../sandbox/terrainWorld.ts').TerrainWorldHost<T>;
  learning?: LearningInterface;
  /** Resets the world and every participant for a new match (positions, health, items...). */
  setupMatch(ctx: MatchContext<W, P, T>): void;
  /** Up to 16 named, test-only setups, exposed by describe_game. Not called by
   * live matches, replay verification, prediction, training or normal tests.
   * Prefer setups over editing setupMatch merely to inspect equipment/state. */
  inspectionSetups?: readonly InspectionSetup<W, P, T>[];
  /** Initialize one arrival in an open session, including replacement of a
   * departed seat. Other participants, the world and the clock are preserved.
   * The Patch Engine supplies an initial-state template when this hook is omitted. */
  setupPlayer?(ctx: MatchContext<W, P, T>, player: GamePlayer<P>): void;
  /** Optional RPG respawn placement. Called by the Patch Engine after a 3-second
   * knockout pause. Reset this participant's movement/position while preserving
   * progression and the shared world. Health is restored by the Patch Engine, not this hook.
   * Without a hook the participant's initial state is restored. */
  respawnPlayer?(ctx: MatchContext<W, P, T>, player: GamePlayer<P>): void;
  /** Advances the fight by one fixed step. Runs on the server every tick. */
  step(ctx: StepContext<W, P, I, T>): GameEvent[] | void;
  /** Called once for each damage-caused alive-to-zero transition, in the same
   * tick and before round intermission. All participants have resolved health.
   * Use declared world/player state for confirmed feedback and rewards; health
   * and maxHp remain engine-owned. Never called by prediction or held-health
   * finish windows. Respawned participants may be eliminated again. */
  onEliminations?(ctx: EntityContext<W, P, T>, eliminations: readonly ConfirmedElimination[]): void;
  /**
   * Called by the Patch Engine after every step: each fighter's body and the damage
   * entities in play. The only way to deal damage; without it nothing is ever
   * hurt. Describe what the state already holds; don't change state here.
   */
  entities?(ctx: EntityContext<W, P, T>): GameEntities;
  /** A short line describing a fighter for diagnostics (stance, items; not raw positions). */
  describePlayer(player: GamePlayer<P>): string;
  controls: {
    bindings: Binding[];
    inspection?: InspectionControls;
    /** Optional cursor policy. Omitted means free cursor. The host prepares lock from
     * start/join gestures and retains it through countdown, without enabling actions early.
     * A recovery scene click consumes that click; unsupported/denied lock is reported without changing the chosen
     * mode. Mouse actions remain usable. Resume explicitly retries lock. */
    pointer?: PointerControls;
    /** @deprecated Ignored. The engine no longer shows control text during gameplay: players
     * read the declared bindings (labels, descriptions, keys and touch layout) from the game's
     * page in the Games browser and rebind them in the match menu. Validation rejects a
     * non-empty hint. */
    hint?: string;
    /** Fills this step's input from the buttons. Called once per fixed step during a fight. */
    writeInput(input: I, buttons: Buttons, frame: InputFrame<W, P, T>): void;
  };
  /**
   * Optional. The Patch Engine predicts the local fighter by running `step` itself, every fixed
   * step, from the latest server state: every numeric field is reconciled (x/y/z snap on large
   * corrections) and every other field, such as feedback the step writes, shows at once. Declare
   * this only to narrow prediction to listed fields, or for `pointerLook`. The `step` here is the
   * older per-fighter prediction step; bundles built before engine prediction still run it.
   */
  prediction?: {
    /** Narrows prediction to these numeric fields. Omitted: every continuous (float) field. */
    fields?: (keyof P & string)[];
    /** Spatial prediction fields measured in world units. Only these trigger teleport snapping. */
    snapFields?: (keyof P & string)[];
    /** Opt-in display-rate local look. Share this declaration with the simulation's
     * applyPointerLook helper; remote interpolation and input cadence are unchanged. */
    pointerLook?: PointerLook;
    /** The older per-fighter prediction step. Declaring it keeps the engine from running `step`
     * locally for this game, so a step that keeps working values outside its declared state still
     * predicts the way it did; omit it to let the engine predict from `step`. */
    step?(state: P, input: I, dt: number, ctx: {
      mode?: import('./gameModes.ts').GameModeId;
      /** Legacy duel opponent. Use opponents for multi-player collision/target queries. */
      opponent: P | undefined;
      /** Every other living participant, in stable match order; omitted by older callers. */
      opponents?: readonly P[];
      tuning: T; world: W;
    }): void;
  };
  /** Numeric state paths to interpolate between server updates, including nested
   * fields such as recoil.pitch. The runtime validates each numeric leaf. */
  smoothFields: ScalarPath<P>[];
  /**
   * Which player fields are time-sensitive. The engine already picks a good split, so most
   * games declare nothing here. Players whose browser supports WebTransport receive the fast
   * fields every tick as UDP datagrams: a lost packet costs one stale sample and never delays
   * anything behind it. Every field, these included, also travels in the reliable (TCP-like)
   * state, so a WebSocket player and a dropped datagram both fall back to it.
   *
   * - Fast by default: every `smoothFields` entry (positions, aim, velocity).
   * - `fast`: also send these, e.g. a stance, a charge level or a stun flag whose newest
   *   value matters more than every value arriving.
   * - `reliable`: never send these on the fast lane, e.g. a smooth field that only changes
   *   on rare events. Inventories, lists and maps are always reliable: only scalar fields
   *   (numbers, booleans, strings) can be fast.
   *
   * Fast fields are latest-value-wins: a value that lasts a single tick can be skipped when
   * its datagram is lost, so announce one-tick moments (a hit, a pickup) with `events`. Keep
   * fields the view reads together on one lane, such as a stance and the counter that tells
   * a new stance from the last one. Inputs need no declaration; the engine sends them over
   * UDP with redundancy whenever it can.
   */
  network?: { fast?: ScalarPath<P>[]; reliable?: ScalarPath<P>[] };
  /** Up to 3 short text lines for the HUD's game info slot (e.g. "Mines: 2"). Plain text only. */
  hudLines(frame: ViewFrame<W, P, T>): string[];
}

// ---------------------------------------------------------------------------
// View (runs in a sandboxed Web Worker)

/** Operator-only camera pose. It never enters recorded frames or gameplay input. */
export interface ReviewCamera {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  fov: number;
}

/** Inspection-only framing; never gameplay input. Omit both selectors for player 0.
 * Normal visibility preserves occlusion; xray explicitly draws the target through obstacles. */
export interface InspectionFocus {
  player?: number;
  target?: string;
  /** Subject close-up or the subject plus its declared nearby interaction.
   * Explicit older focus requests keep subject framing. */
  framing?: 'subject' | 'interaction';
  /** Exact additional registered targets, up to four; overrides automatic relations. */
  includeTargets?: string[];
  angle?: 'auto' | 'front' | 'side' | 'rear' | 'three-quarter';
  visibility?: 'normal' | 'xray';
  /** Extra space around actual rendered bounds, 1.05–2.5; default 1.2. */
  padding?: number;
}

/** The game's 3D world. It owns its canvas and renderer; the HTML UI is drawn over it by the Patch Engine. */
export interface GameView<W, P, T extends TuningValues> {
  /** Same deterministic world recipe used by logic; never a view-only map. */
  terrainWorld?: import('../sandbox/terrainWorld.ts').TerrainWorldHost<T>;
  /** Idempotent current-frame presentation adapter. Shared character mods consume these
   * signals before rendering; they never need this base's private state fields.
   * Omit unsupported signals instead of inferring unobserved actions/support. */
  actorSignals?(frame: ViewFrame<W, P, T>): Readonly<Record<string, import('../sandbox/animation.ts').ActorPresentationSignals>>;
  /** Shared scene attachment point for feature-owned visuals. Objects stay inside
   * the view sandbox; the host page never receives them. Each feature owns and
   * removes its own objects rather than replacing the season renderer. */
  featureHost?: {
    add(object: unknown): void;
    remove(object: unknown): void;
    /** Replace one participant's avatar, anchored at their feet and facing +Z.
     * A null object restores the stock avatar. Features retain resource ownership. */
    setPlayerAppearance?(playerId: string, object: unknown | null): void;
    /** Inspection-only named object registration. Null releases it; the author
     * retains ownership and disposal of geometry and materials. */
    setInspectionTarget?(id: string, object: unknown | null, label?: string, relatedTargets?: readonly string[]): void;
  };
  /** Release feature attachments and renderer resources when the view ends. */
  dispose?(): void;
  /** Optional inspection camera; null restores the original game camera. */
  setReviewCamera?(camera: ReviewCamera | null): void;
  /** Optional automatic inspection framing/following; null restores gameplay rendering. */
  setInspectionFocus?(focus: InspectionFocus | null): void;
  /** Bounded target catalog and last framing result, read only for inspection captures. */
  inspectionFocus?(): Record<string, unknown>;
  /** Size of the canvas in CSS pixels, and the device pixel ratio. */
  resize(width: number, height: number, pixelRatio: number): void;
  /** Draws one frame. */
  update(frame: ViewFrame<W, P, T>): void;
  /** Optional declarative HTML/CSS UI, sampled by the engine at most ten times a
   * second. Null clears the UI. Game code never receives host DOM access. */
  ui?(frame: ViewFrame<W, P, T>): import('./gameUi.ts').GameUiDocument | null;
  /** Up to 16 numbers passed to `controls.writeInput` as `frame.view` (e.g. the camera direction). */
  info?(): Record<string, number>;
  /** Optional authoring-only diagnostics, read after update only when an inspection
   * capture requests them. Return plain finite JSON data, up to 16 KiB. Values
   * are self-reported view evidence (layers/phases/fallbacks), not gameplay state.
   * Failures/oversized data are reported without failing rendering. */
  inspection?(): Record<string, unknown>;
}

/** src/game/view.ts default-exports one of these. */
export type CreateView<W, P, T extends TuningValues> = (canvas: OffscreenCanvas) => GameView<W, P, T>;
