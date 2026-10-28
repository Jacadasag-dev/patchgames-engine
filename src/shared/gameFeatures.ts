/** Composable features run inside the existing logic/view sandboxes. Import types only. */
import type {
  Binding, BlockerEntity, Buttons, DamageEntity, DamageHit, HealingEntity, GameEvent, GamePlayer,
  InputOf, InputShape, ObjectShape, PlayerBody, PlayerList, PlayerModelOption, ScalarPath, StateOf, TuningValues, ViewFrame,
} from './gameApi.ts';
import type { GameModeId } from './gameModes.ts';

export type FeatureConfigField =
  | { type: 'number'; default: number; min?: number; max?: number; integer?: boolean }
  | { type: 'boolean'; default: boolean }
  | { type: 'string'; default: string; values?: readonly string[]; maxLength?: number };
export type FeatureConfigShape = Record<string, FeatureConfigField>;
type ConfigValue<F> = F extends { type: 'number' } ? number : F extends { type: 'boolean' } ? boolean : string;
export type FeatureConfigOf<C extends FeatureConfigShape> = {
  readonly [K in keyof C]: ConfigValue<C[K]>;
};
export type FeatureConfig = Record<string, number | boolean | string>;
// Avoid infinitely expanding a dynamic ObjectShape at the runtime boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FeatureState<S extends ObjectShape> = 0 extends (1 & S) ? any : string extends keyof S ? Record<string, unknown> : StateOf<S>;

/** Explicit access to the season's public state, never another feature's private state. */
export interface FeatureGameState {
  readonly mode?: GameModeId;
  world: Record<string, unknown>;
  players: Readonly<PlayerList<Readonly<GamePlayer<Record<string, unknown>>>>>;
  tuning: Readonly<TuningValues>;
}
export interface FeaturePlayer<P> {
  readonly index: number;
  readonly classId?: string;
  readonly reviveProgress?: number;
  readonly active?: boolean;
  readonly hp: number;
  readonly maxHp: number;
  state: P;
}
export interface FeatureContext<W extends ObjectShape = ObjectShape, P extends ObjectShape = ObjectShape,
  I extends InputShape = InputShape, C extends FeatureConfigShape = FeatureConfigShape> {
  readonly featureId: string;
  readonly mode?: GameModeId;
  readonly config: FeatureConfigOf<C>;
  world: FeatureState<W>;
  players: PlayerList<FeaturePlayer<FeatureState<P>>>;
  readonly game: FeatureGameState;
  /** The accepted world used by physics and rendering. Available only on bases
   * providing world.terrain.v1; includes base obstacles in spawn/clearance checks. */
  readonly terrain?: import('../sandbox/terrainWorld.ts').TerrainWorldSnapshot;
  readonly inputs: Readonly<PlayerList<InputOf<I> | undefined>>;
  readonly dtMs: number;
  readonly elapsedMs: number;
  readonly hits: readonly DamageHit[];
  /** Stable private identifier; use for entities/resources, not changing spawn order. */
  id(local: string): string;
  eventType(local: string): string;
  /** Independent deterministic stream; available only during setup/step/event hooks. */
  random(stream?: string): number;
  /** Evaluate an explicit numeric extension point across all installed modifiers. */
  value(target: string, initial: number, player?: number): number;
  hasCapability(capability: string): boolean;
  /** Private event; dispatched to this feature and included in the game's event stream. */
  emit(type: string, details?: Omit<GameEvent, 'type'>): void;
  /** Public contract event; all features can observe it. */
  emitShared(type: string, details?: Omit<GameEvent, 'type'>): void;
}

export interface FeatureModifierContext<C extends FeatureConfigShape = FeatureConfigShape> {
  readonly config: FeatureConfigOf<C>;
  readonly player: number | undefined;
  readonly tuning: Readonly<TuningValues>;
}
export interface FeatureModifier<C extends FeatureConfigShape = FeatureConfigShape> {
  /** tuning.<key> automatically affects logic, controls, prediction and visuals. */
  target: string;
  operation: 'add' | 'multiply' | 'override' | 'min' | 'max';
  value: number | ((context: FeatureModifierContext<C>) => number);
}
export interface FeatureEntities {
  /** Local IDs are automatically namespaced, including blocker references in hits. */
  damage?: DamageEntity[];
  /** Host-checked recovery. Cannot revive downed players. */
  healing?: HealingEntity[];
  blockers?: BlockerEntity[];
  /** Explicit body override: highest-priority supplied body wins for each player. */
  bodies?: (PlayerBody | undefined)[];
}

export interface FeaturePredictionContext<W extends ObjectShape, P extends ObjectShape, I extends InputShape, C extends FeatureConfigShape> {
  readonly terrain?: import('../sandbox/terrainWorld.ts').TerrainWorldSnapshot;
  readonly mode?: GameModeId;
  readonly config: FeatureConfigOf<C>;
  state: FeatureState<P>;
  readonly opponent: FeatureState<P> | undefined;
  /** Private feature state for every other living participant, in match order. */
  readonly opponents?: readonly FeatureState<P>[];
  readonly world: FeatureState<W>;
  readonly input: InputOf<I>;
  /** Seconds, matching GameLogic.prediction.step and movement helpers. */
  readonly dt: number;
  /** Milliseconds, for sharing cooldown math with authoritative hooks. */
  readonly dtMs: number;
  readonly game: { mode?: GameModeId; state: Record<string, unknown>; opponent: Record<string, unknown> | undefined;
    opponents?: readonly Record<string, unknown>[]; world: Record<string, unknown>; tuning: Readonly<TuningValues> };
  value(target: string, initial: number): number;
}

export interface FeatureDefinition<W extends ObjectShape = ObjectShape, P extends ObjectShape = ObjectShape,
  I extends InputShape = InputShape, C extends FeatureConfigShape = FeatureConfigShape> {
  apiVersion: 1;
  /** Static world contribution, evaluated from validated configuration in both
   * sandboxes. Requires world.terrain.v1. Keep this deterministic and pure.
   * Local IDs/assets are namespaced; authored paths/placements reserve space
   * before scatter. Removing the mod rebuilds from the original base recipe. */
  terrain?(config: FeatureConfigOf<C>): import('../sandbox/terrainWorld.ts').TerrainContribution;
  /** Up to eight selectable cosmetics. Local IDs are namespaced automatically. */
  playerModels?: readonly PlayerModelOption[];
  config?: C;
  shapes?: { world?: W; player?: P; input?: I };
  /** Feature IDs. The package manifest is the canonical packaging dependency list. */
  dependencies?: readonly string[];
  /** Version capability names (e.g. example.dash.v1) whenever their contract changes. */
  provides?: readonly string[];
  requires?: readonly string[];
  /** Shared numeric extension points evaluated with ctx.value; tuning.* is implicit. */
  metrics?: readonly string[];
  modifiers?: readonly FeatureModifier<C>[];
  hooks?: {
    setup?(context: FeatureContext<W, P, I, C>): void;
    /** Initialize a late-arriving participant's private state only. */
    setupPlayer?(context: FeatureContext<W, P, I, C>, player: FeaturePlayer<FeatureState<P>>): void;
    beforeStep?(context: FeatureContext<W, P, I, C>): void;
    step?(context: FeatureContext<W, P, I, C>): void;
    onEvent?(context: FeatureContext<W, P, I, C>, event: Readonly<GameEvent>): void;
  };
  controls?: {
    /** Declared once; the engine binds keys and touch and lists them in the Games browser. */
    bindings: Binding[];
    /** @deprecated Ignored: the engine shows no control text during gameplay. */
    hint?: string;
    /** Names are local to this feature. The runtime isolates the shared input/action names. */
    writeInput?(input: InputOf<I>, buttons: Buttons, frame: FeatureFrame<W, P, C>): void;
  };
  entities?(context: FeatureContext<W, P, I, C>): FeatureEntities;
  hudLines?(frame: FeatureFrame<W, P, C>): string[];
  /** Predict only declared numeric state; share movement math with the authoritative hook. */
  prediction?: {
    fields?: (keyof P & string)[];
    /** Private spatial fields in world units. Timers/counters must not trigger teleport snapping. */
    snapFields?: (keyof P & string)[];
    /** Explicit numeric season fields this feature predicts (e.g. x or velocityY). */
    gameFields?: string[];
    /** Match hooks.beforeStep or hooks.step; defaults to after. */
    phase?: 'before' | 'after';
    step(context: FeaturePredictionContext<W, P, I, C>): void;
  };
  /** Private numeric player fields to interpolate for remote players. */
  smoothFields?: (keyof P & string)[];
  /**
   * Private player fields by how they travel; most features declare nothing. `smoothFields` are
   * already fast. `fast` adds scalar fields whose newest value matters more than every value
   * arriving (a charge level, a stance), sent as UDP datagrams to players on WebTransport;
   * `reliable` keeps a smooth field off that lane. Everything else, and lists, maps and
   * inventories always, travels reliably. See GameLogic.network.
   */
  network?: { fast?: ScalarPath<P>[]; reliable?: ScalarPath<P>[] };
}

// Each package carries its own inferred shapes; type erasure happens only at composition.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFeatureDefinition = FeatureDefinition<any, any, any, any>;
export interface InstalledFeature {
  id: string;
  /** Display name from the package manifest. */
  name?: string;
  /** Larger values execute later / win competing overrides. Equal priority sorts by ID. */
  priority: number;
  feature: AnyFeatureDefinition;
  config?: FeatureConfig;
  /** Manifest dependency IDs, validated in addition to code declarations. */
  requires?: readonly string[];
}

export interface FeatureFrame<W extends ObjectShape = ObjectShape, P extends ObjectShape = ObjectShape,
  C extends FeatureConfigShape = FeatureConfigShape> {
  readonly featureId: string;
  readonly mode?: GameModeId;
  readonly config: FeatureConfigOf<C>;
  readonly terrain?: import('../sandbox/terrainWorld.ts').TerrainWorldSnapshot;
  readonly world: FeatureState<W> | null;
  readonly players: { id: string; name: string; index: number; hp: number; maxHp: number; isLocal: boolean; active?: boolean; classId?: string; modelId?: string; reviveProgress?: number; state: FeatureState<P>;
    /** Immutable feet position and yaw, independent of the base avatar's rig.
     * Available on games providing player.position.v1. */
    readonly pose?: Readonly<FeaturePlayerPose>;
    /** Current-frame shared animation inputs, supplied by the base's actorSignals
     * adapter. Absent on older bases; a model may fall back to its idle pose.
     * Snapshot is immutable and independent of other features and gameplay. */
    readonly presentation?: Readonly<import('../sandbox/animation.ts').ActorPresentationSignals>;
  }[];
  /** Original season fields only; private feature state is exposed above. */
  readonly game: ViewFrame<Record<string, unknown>, Record<string, unknown>, TuningValues>;
  readonly now: number;
  readonly dt: number;
  readonly phase: string;
  readonly scene?:import('./gameScenes.ts').GameSceneSnapshot;
}
/** World units; yaw is radians, with +Z forward at zero. */
export interface FeaturePlayerPose { x: number; y: number; z: number; facing: number }
/** The base view owns rendering; addons attach objects without creating competing canvases. */
export interface FeatureViewHost {
  add(object: unknown): void;
  remove(object: unknown): void;
  /** Supply a Three.js Object3D in feet-origin, +Z-forward coordinates. The host
   * follows the participant's pose. An explicit player model choice takes
   * precedence over feature priority. Without a choice, the highest priority wins.
   * localModelId selects a declared playerModels entry (omit for a single model).
   * Null releases that model; the feature still owns its resources.
   * The feature still owns disposal of its geometry/material resources. */
  setPlayerAppearance(playerId: string, object: unknown | null, localModelId?: string): void;
  /** Register an attached creature or prop for automatic inspection framing.
   * localId is namespaced like ctx.id(localId); null unregisters it. This does
   * not attach or dispose the object. Optional relatedTargets are full registered
   * IDs (ctx.id(localId) or player:<id>), for inspection-only interaction framing.
   * Absent on bases without focus support. */
  setInspectionTarget?(localId: string, object: unknown | null, label?: string, relatedTargets?: readonly string[]): void;
}
export interface FeatureViewContext<C extends FeatureConfigShape = FeatureConfigShape> {
  readonly featureId: string;
  readonly config: FeatureConfigOf<C>;
  readonly host: FeatureViewHost;
  id(local: string): string;
  eventType(local: string): string;
}
export interface FeatureView<W extends ObjectShape = ObjectShape, P extends ObjectShape = ObjectShape,
  C extends FeatureConfigShape = FeatureConfigShape> {
  update(frame: FeatureFrame<W, P, C>): void;
  /** Local panel/action IDs are namespaced automatically. replaces names an
   * explicit base or fully namespaced panel; theme tokens merge by priority. */
  ui?(frame: FeatureFrame<W, P, C>): import('./gameUi.ts').GameUiDocument | null;
  resize?(width: number, height: number, pixelRatio: number): void;
  dispose?(): void;
  /** Optional bounded visual evidence, captured alongside the base's diagnostics. */
  inspection?(): Record<string, unknown>;
}
export type CreateFeatureView<W extends ObjectShape = ObjectShape, P extends ObjectShape = ObjectShape,
  C extends FeatureConfigShape = FeatureConfigShape> = (context: FeatureViewContext<C>) => FeatureView<W, P, C>;
export interface InstalledFeatureView {
  id: string;
  name?: string;
  priority: number;
  definition: AnyFeatureDefinition;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feature?: CreateFeatureView<any, any, any>;
  config?: FeatureConfig;
  requires?: readonly string[];
}
