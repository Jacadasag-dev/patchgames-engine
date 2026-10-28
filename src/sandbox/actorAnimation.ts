/** Shared, renderer-neutral actor presentation pipeline. An actor supplies facts;
 * a replaceable driver chooses a pose, editable clips add layers/actions, and an
 * optional rig applies it before contact/IK hooks. No step moves game physics. */
import { AnimationPlayer, quaternionFromEuler, validateAnimationPose, type ActorPresentationSignals, type AnimationAction,
  type AnimationClip, type AnimationClipLayer, type AnimationDiagnostics, type AnimationPose } from './animation.ts';
import type { RigPose } from './rig.ts';
import { EquipmentMotionController, type EquipmentMotionDiagnostics, type EquipmentMotionLoad } from './equipmentMotion.ts';
import { isInspectionFrameActive, recordActorAnimationInspection } from './inspectionTelemetry.ts';

export const ACTOR_ANIMATION_VERSION = 'actor-animation-v1';
/** Preserve a legacy RigAnimator's authored/blended pose while sharing the new
 * pipeline. RigPose angles are XYZ degrees; AnimationPose rotations are local
 * quaternions. Rig joint rest positions remain owned by the bound rig. */
export function rigPoseToAnimationPose(pose: RigPose): AnimationPose {
  return validateAnimationPose(Object.fromEntries(Object.entries(pose).map(([joint, value]) => [joint, {
    ...(value.move ? { position: { ...value.move } } : {}),
    ...(value.rotate ? { rotation: quaternionFromEuler({ x: (value.rotate.x ?? 0) * Math.PI / 180,
      y: (value.rotate.y ?? 0) * Math.PI / 180, z: (value.rotate.z ?? 0) * Math.PI / 180 }) } : {}),
  }])));
}
export type ActorAnimationResetReason = 'initial' | 'explicit' | 'identity' | 'epoch' | 'rewind' | 'gap' | null;
export interface ActorAnimationContext {
  readonly signals: Readonly<ActorPresentationSignals>;
  /** Elapsed presentation milliseconds. Zero after any continuity reset. */
  readonly deltaMs: number;
  readonly reset: boolean;
  readonly resetReason: ActorAnimationResetReason;
  /** Last composed reference pose, before adaptPose maps it onto a custom body. */
  readonly previousPose: AnimationPose;
}
/** Small fixed-schema summaries stay safe to include in GameView.inspection(). */
export interface ActorLocomotionDiagnostics {
  source?: string | null;
  sourceTimeMs?: number | null;
  /** Explicit source facts enable automatic diagnostics without clip-name guesses. */
  sourceDurationMs?: number;
  loop?: boolean;
  idle?: boolean;
  holdsEnd?: boolean;
  phase?: number | null;
  playbackRate?: number;
  state?: string;
  score?: number | null;
  switched?: boolean;
  warnings?: readonly string[];
}
export interface ActorLocomotionResult {
  pose: AnimationPose;
  /** Animation-authored confidence, not evidence of physical ground contact. */
  contacts?: Readonly<Record<string, number>>;
  diagnostics?: ActorLocomotionDiagnostics;
}
export interface ActorLocomotionDriver {
  sample(context: Readonly<ActorAnimationContext>): ActorLocomotionResult;
  reset?(): void;
}
export interface ActorRigDiagnostics {
  mapped: number;
  /** At most eight names; the total remains visible when this list is truncated. */
  unmapped: string[];
  unmappedCount: number;
}
export interface ActorAnimationDiagnostics {
  version: typeof ACTOR_ANIMATION_VERSION;
  actorId: string;
  timeMs: number;
  reset: boolean;
  resetReason: ActorAnimationResetReason;
  animation: AnimationDiagnostics;
  layerCount: number;
  actionCount: number;
  locomotion?: ActorLocomotionDiagnostics;
  /** Observations about carry response, without classifying artistic intent. */
  equipmentMotion?: EquipmentMotionDiagnostics;
  /** Available when rig.apply returns a {mapped, unmapped} mapping report. */
  rig?: ActorRigDiagnostics;
  warnings: string[];
}
export interface ActorAnimationResult {
  /** Final body-adapted pose. afterApply may additionally constrain rig nodes. */
  pose: AnimationPose;
  contacts: Readonly<Record<string, number>>;
  diagnostics: ActorAnimationDiagnostics;
}
export interface ActorAnimationOptions {
  clips?: Readonly<Record<string, AnimationClip>>;
  locomotion?: ActorLocomotionDriver | ((context: Readonly<ActorAnimationContext>) => ActorLocomotionResult);
  /** ThreeAnimationRig implements this contract; no renderer is required.
   * A returned {mapped:number, unmapped:string[]} report appears in diagnostics. */
  rig?: { apply(pose: AnimationPose): unknown; capture?(): AnimationPose; equipmentLoads?(): readonly EquipmentMotionLoad[] };
  /** Automatically reads equipped rig items by default. False disables carry inertia. */
  equipmentMotion?: false;
  /** Override the rig's automatic arm mapping for custom bodies or behavior. */
  equipmentLoads?(context: Readonly<ActorAnimationContext>): readonly EquipmentMotionLoad[];
  layers?(context: Readonly<ActorAnimationContext>): readonly AnimationClipLayer[];
  adaptPose?(pose: AnimationPose, context: Readonly<ActorAnimationContext>): AnimationPose;
  /** Runs after rig.apply. Sample real supports here for feet, hands or seats. */
  afterApply?(result: Readonly<ActorAnimationResult>, context: Readonly<ActorAnimationContext>): void | { warnings?: readonly string[] };
  /** Clear feature-owned gait, IK locks, springs or legacy animator continuity. */
  onReset?(context: Readonly<ActorAnimationContext>): void;
  /** Defaults to 1000 ms. A late frame resets continuity instead of replaying it. */
  maxFrameGapMs?: number;
}
export interface ActorAnimationFrame {
  signals: Readonly<ActorPresentationSignals>;
  reset?: boolean;
  /** Optional interpolation delta; clock discontinuities still force zero. */
  deltaMs?: number;
  /** Explicit reference pose bypasses the locomotion driver for this frame. */
  base?: AnimationPose;
  /** Applied after configured layers and before timed actions. */
  layers?: readonly AnimationClipLayer[];
  /** Defaults to signals.actions. An empty list observes no new actions. */
  actions?: readonly AnimationAction[];
  phase?: number;
}

/** Stabilize page-clock action starts reconstructed from repeated network
 * countdowns. Keep one timeline per actor in a base's presentation adapter.
 * Only supplied action instances are returned; this never infers an attack or
 * extends gameplay duration. The first observed start wins for a stable ID.
 * Calling twice for the same render frame is idempotent. */
export class ActorActionTimeline {
  private starts = new Map<string, number>();
  private id: string | undefined;
  private epoch: string | number | undefined;
  private timeMs: number | undefined;
  reset(): void { this.starts.clear(); this.id = undefined; this.epoch = undefined; this.timeMs = undefined; }
  sample(signals: Pick<ActorPresentationSignals, 'id' | 'epoch' | 'timeMs' | 'actions'>): AnimationAction[] {
    if (!Number.isFinite(signals.timeMs)) throw new Error('Actor action timeline: timeMs must be finite.');
    if ((signals.actions?.length ?? 0) > 32) throw new Error('Actor action timeline: at most 32 current actions.');
    if (signals.id !== this.id || signals.epoch !== this.epoch || this.timeMs !== undefined && signals.timeMs < this.timeMs) this.reset();
    this.id = signals.id; this.epoch = signals.epoch; this.timeMs = signals.timeMs;
    return (signals.actions ?? []).map(action => {
      if (!Number.isFinite(action.startedAtMs)) throw new Error('Actor action timeline: startedAtMs must be finite.');
      const key = JSON.stringify([action.channel ?? 'action', action.id]);
      let startedAtMs = this.starts.get(key);
      if (startedAtMs === undefined) {
        startedAtMs = action.startedAtMs;
        if (this.starts.size >= 256) this.starts.delete(this.starts.keys().next().value!);
        this.starts.set(key, startedAtMs);
      }
      return { ...action, startedAtMs };
    });
  }
}

const MAX_WARNINGS = 12;
function warnings(...groups: (readonly string[] | undefined)[]): string[] {
  const result: string[] = [];
  for (const group of groups) for (const text of group ?? []) {
    const warning = String(text).slice(0, 200);
    if (!result.includes(warning)) result.push(warning);
    if (result.length >= MAX_WARNINGS) return result;
  }
  return result;
}
function summary(value: ActorLocomotionDiagnostics | undefined): ActorLocomotionDiagnostics | undefined {
  if (!value) return undefined;
  const result: ActorLocomotionDiagnostics = {};
  if (value.source !== undefined) result.source = value.source === null ? null : String(value.source).slice(0, 128);
  if (value.state !== undefined) result.state = String(value.state).slice(0, 96);
  for (const key of ['sourceTimeMs', 'sourceDurationMs', 'phase', 'playbackRate', 'score'] as const) {
    const number = value[key];
    if (number !== undefined && (number === null || Number.isFinite(number))) Object.assign(result, { [key]: number });
  }
  if (value.switched !== undefined) result.switched = !!value.switched;
  for (const key of ['loop', 'idle', 'holdsEnd'] as const) if (value[key] !== undefined) result[key] = !!value[key];
  if (value.warnings?.length) result.warnings = warnings(value.warnings);
  return result;
}
function contacts(values: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> {
  const result: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(values ?? {}).slice(0, 32)) {
    if (key.length <= 96 && Number.isFinite(value)) result[key] = Math.max(0, Math.min(1, value));
  }
  return result;
}
function rigSummary(value: unknown): ActorRigDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const report = value as { mapped?: unknown; unmapped?: unknown };
  if (typeof report.mapped !== 'number' || !Number.isSafeInteger(report.mapped) || report.mapped < 0
    || !Array.isArray(report.unmapped)) return undefined;
  // Custom rig return values are optional; bound both retained data and work.
  const names = report.unmapped.slice(0, 8);
  if (names.some(name => typeof name !== 'string')) return undefined;
  return { mapped: report.mapped, unmapped: names.map(name => name.slice(0, 96)), unmappedCount: report.unmapped.length };
}

/** One controller per actor; share immutable clips/databases between actors.
 * reset() clears local continuity. Stable action IDs and simulation timestamps
 * preserve one-shot progress across repeated network snapshots. */
export class ActorAnimationController {
  private readonly options: ActorAnimationOptions;
  private readonly player: AnimationPlayer;
  private readonly equipment = new EquipmentMotionController();
  private readonly maxFrameGapMs: number;
  private lastTime: number | undefined;
  private lastId: string | undefined;
  private lastEpoch: string | number | undefined;
  private previousPose: AnimationPose = {};
  private pendingReset = false;

  constructor(options: ActorAnimationOptions = {}) {
    this.options = options;
    this.player = new AnimationPlayer(options.clips ?? {});
    this.maxFrameGapMs = options.maxFrameGapMs ?? 1000;
    if (!Number.isFinite(this.maxFrameGapMs) || this.maxFrameGapMs < 1 || this.maxFrameGapMs > 60_000)
      throw new Error('Actor animation: maxFrameGapMs must be within 1..60000.');
  }
  reset(): void {
    this.player.reset();
    this.equipment.reset();
    if (typeof this.options.locomotion === 'object') this.options.locomotion.reset?.();
    this.previousPose = {}; this.lastTime = undefined; this.pendingReset = true;
  }
  sample(frame: ActorAnimationFrame): ActorAnimationResult {
    const signals = frame.signals;
    if (!signals || typeof signals.id !== 'string' || !signals.id.length || signals.id.length > 128)
      throw new Error('Actor animation: signals need an actor ID of 1..128 characters.');
    if (!Number.isFinite(signals.timeMs) || Math.abs(signals.timeMs) > Number.MAX_SAFE_INTEGER)
      throw new Error('Actor animation: timeMs must be finite.');
    if (signals.epoch !== undefined && (typeof signals.epoch !== 'string' && typeof signals.epoch !== 'number'
      || typeof signals.epoch === 'number' && !Number.isFinite(signals.epoch)
      || typeof signals.epoch === 'string' && signals.epoch.length > 128)) throw new Error('Actor animation: invalid epoch.');
    if (frame.deltaMs !== undefined && (!Number.isFinite(frame.deltaMs) || frame.deltaMs < 0 || frame.deltaMs > 60_000))
      throw new Error('Actor animation: deltaMs must be within 0..60000.');
    const reason: ActorAnimationResetReason = frame.reset || this.pendingReset ? 'explicit'
      : this.lastTime === undefined ? 'initial' : this.lastId !== signals.id ? 'identity'
      : this.lastEpoch !== signals.epoch ? 'epoch' : signals.timeMs < this.lastTime ? 'rewind'
      : signals.timeMs - this.lastTime > this.maxFrameGapMs ? 'gap' : null;
    const context: ActorAnimationContext = { signals, reset: reason !== null, resetReason: reason,
      deltaMs: reason ? 0 : frame.deltaMs ?? signals.timeMs - this.lastTime!, previousPose: reason ? {} : this.previousPose };
    if (reason) {
      this.player.reset();
      this.equipment.reset();
      // An explicit reset() already cleared the driver; frame.reset has not.
      if (!this.pendingReset && typeof this.options.locomotion === 'object') this.options.locomotion.reset?.();
      this.options.onReset?.(context);
    }
    this.pendingReset = false;
    const driver = this.options.locomotion;
    const locomotion = frame.base !== undefined ? { pose: frame.base } : typeof driver === 'function' ? driver(context)
      : driver?.sample(context) ?? { pose: {} };
    const equipment = this.options.equipmentMotion === false ? undefined : this.equipment.sampleForComposition(locomotion.pose, {
      loads: this.options.equipmentLoads?.(context) ?? this.options.rig?.equipmentLoads?.() ?? [],
      deltaMs: signals.timeMs === this.lastTime ? 0 : context.deltaMs, reset: context.reset,
    });
    const weighted = equipment?.modified;
    const result = this.player.sample({ timeMs: signals.timeMs, epoch: signals.epoch, signals,
      parameters: signals.parameters, base: weighted ? equipment.pose : locomotion.pose,
      ...(weighted ? { referenceBase: locomotion.pose } : {}), phase: frame.phase,
      layers: [...this.options.layers?.(context) ?? [], ...frame.layers ?? []], actions: frame.actions ?? signals.actions });
    const referencePose = result.referencePose ?? result.pose;
    const pose = this.options.adaptPose ? validateAnimationPose(this.options.adaptPose(result.pose, context)) : result.pose;
    const motionSummary = summary(locomotion.diagnostics);
    const diagnostics: ActorAnimationDiagnostics = { version: ACTOR_ANIMATION_VERSION, actorId: signals.id,
      timeMs: signals.timeMs, reset: reason !== null, resetReason: reason,
      layerCount: result.diagnostics.layers.length, actionCount: result.diagnostics.actions.length,
      animation: { ...result.diagnostics, reset: reason !== null || result.diagnostics.reset,
        layers: result.diagnostics.layers.slice(0, 8), actions: result.diagnostics.actions.slice(0, 8),
        warnings: warnings(result.diagnostics.warnings) },
      ...(motionSummary ? { locomotion: motionSummary } : {}),
      ...(equipment && (equipment.diagnostics.loadCount || equipment.diagnostics.jointCount) ? { equipmentMotion: equipment.diagnostics } : {}),
      warnings: warnings(motionSummary?.warnings, result.diagnostics.warnings) };
    const output: ActorAnimationResult = { pose, contacts: contacts(locomotion.contacts), diagnostics };
    const rig = rigSummary(this.options.rig?.apply(pose));
    if (rig) {
      diagnostics.rig = rig;
      if (rig.unmappedCount) diagnostics.warnings = warnings(['unmapped-rig-joints'], diagnostics.warnings);
    }
    const constrained = this.options.afterApply?.(output, context);
    diagnostics.warnings = warnings(diagnostics.warnings, constrained?.warnings);
    if (isInspectionFrameActive()) recordActorAnimationInspection(signals, output, this.options.rig);
    this.previousPose = referencePose; this.lastTime = signals.timeMs; this.lastId = signals.id; this.lastEpoch = signals.epoch;
    return output;
  }
}
