/** Scene presentation stays inside the view sandbox. The authoritative scene
 * state and transitions live in shared/gameScenes.ts; none of these helpers
 * change the world, move players, or decide when a scene is complete. */
import type { CreateView, GameView, InspectionFocus, ReviewCamera, TuningValues, ViewFrame } from '../shared/gameApi.ts';
import type { GameSceneActionKind, GameSceneKind, GameSceneSnapshot } from '../shared/gameScenes.ts';
import type { GameUiAction } from '../shared/gameUi.ts';

export type { GameSceneDefinition, GameSceneKind, GameSceneRules, GameSceneSnapshot, GameSceneState } from '../shared/gameScenes.ts';
export { parseSceneRules, readGameScene, sceneGameplayActive, sceneStateShape } from '../shared/gameScenes.ts';

type RoutedKind = Exclude<GameSceneKind, 'gameplay'>;
type FeatureHost = NonNullable<GameView<unknown, unknown, TuningValues>['featureHost']>;
type Vector = { x: number; y: number; z: number };
export interface SceneViewLifecycle<W, P, T extends TuningValues> {
  readonly scene: GameSceneSnapshot | undefined;
  readonly frame: ViewFrame<W, P, T>;
  readonly view: GameView<W, P, T>;
}
export interface SceneViewOptions<W, P, T extends TuningValues> {
  gameplay: CreateView<W, P, T>;
  /** Exact scene IDs take precedence over kind routes. Unmapped scenes use gameplay. */
  scenes?: Readonly<Record<string, CreateView<W, P, T>>>;
  kinds?: Partial<Readonly<Record<RoutedKind, CreateView<W, P, T>>>>;
  /** Supply the shared terrain adapter up front so the engine can prepare it
   * before the first lazy scene factory runs. Every terrain route must use it. */
  terrainWorld?: GameView<W, P, T>['terrainWorld'];
  onEnter?(context: SceneViewLifecycle<W, P, T>): void;
  onExit?(context: SceneViewLifecycle<W, P, T>): void;
}
function fail(message: string): never { throw new Error(`Game scenes: ${message}`); }

/** A single canvas, one live route, and one HTML UI source. Factories are lazy
 * and own the resources they return. Leaving an instance calls onExit, detaches
 * feature objects, then disposes that view exactly once. A repeated scene ID
 * with a new sequence is a new instance. Factories must clean up allocations
 * themselves if they throw before returning a view.
 *
 * Feature attachments follow the active route when it exposes featureHost;
 * otherwise they wait detached until a capable route is entered. Appearance
 * features can inspect frame.scene to hide/change their own meeting objects.
 * The wrapper never retains inactive scene views or reinitializes game logic. */
export function createSceneView<W, P, T extends TuningValues>(canvas: OffscreenCanvas, options: SceneViewOptions<W, P, T>): GameView<W, P, T> {
  if (!options || typeof options.gameplay !== 'function') fail('gameplay must be a view factory');
  const { gameplay, terrainWorld, onEnter, onExit } = options;
  const scenes = new Map<string, CreateView<W, P, T>>(), kinds = new Map<string, CreateView<W, P, T>>();
  for (const [id, factory] of Object.entries(options.scenes ?? {})) {
    if (!id || id.length > 128 || typeof factory !== 'function') fail('scene routes need a short ID and a view factory');
    scenes.set(id, factory);
  }
  for (const [kind, factory] of Object.entries(options.kinds ?? {})) {
    if (!['selection', 'meeting', 'cinematic'].includes(kind) || typeof factory !== 'function') fail('kind routes must name selection, meeting or cinematic');
    kinds.set(kind, factory);
  }
  if (scenes.size + kinds.size > 64) fail('at most 64 presentation routes');
  const objects = new Set<unknown>();
  const appearances = new Map<string, unknown>();
  const targets = new Map<string, { object: unknown; label?: string; related?: readonly string[] }>();
  const retired = new WeakSet<object>();
  let active: { key: string; view: GameView<W, P, T>; context: SceneViewLifecycle<W, P, T>; sceneUi: boolean } | undefined;
  let dimensions: [number, number, number] | undefined;
  let reviewCamera: ReviewCamera | null = null, inspectionFocus: InspectionFocus | null = null;
  let disposed = false, failed = false, transitioning = false, failure: unknown;

  const retire = (): void => {
    const previous = active; active = undefined;
    if (!previous) return;
    const errors: unknown[] = [];
    // onExit may remove an attachment from the proxy. Snapshot first so that
    // the previous renderer still receives its matching detach operation.
    const attachedObjects = [...objects], attachedAppearances = [...appearances.keys()], attachedTargets = [...targets.keys()];
    try { onExit?.(previous.context); } catch (value) { errors.push(value); }
    for (const object of attachedObjects) try { previous.view.featureHost?.remove(object); } catch (value) { errors.push(value); }
    for (const id of attachedAppearances) try { previous.view.featureHost?.setPlayerAppearance?.(id, null); } catch (value) { errors.push(value); }
    for (const id of attachedTargets) try { previous.view.featureHost?.setInspectionTarget?.(id, null); } catch (value) { errors.push(value); }
    retired.add(previous.view);
    try { previous.view.dispose?.(); } catch (value) { errors.push(value); }
    if (errors.length) throw errors[0];
  };
  const select = (frame: ViewFrame<W, P, T>): GameView<W, P, T> | undefined => {
    if (disposed) return;
    if (failed) throw failure;
    if (transitioning) fail('scene lifecycle callbacks cannot re-enter scene routing');
    const scene = frame.scene;
    const key = scene ? `${scene.sequence}:${scene.id}` : 'legacy';
    if (active?.key === key) { active.context = { scene, frame, view: active.view }; return active.view; }
    transitioning = true;
    try {
      retire();
      if (disposed) return;
      const sceneFactory = scene ? scenes.get(scene.id) ?? kinds.get(scene.kind) : undefined;
      const factory = sceneFactory ?? gameplay;
      const view = factory(canvas);
      if (!view || typeof view !== 'object') fail('a scene factory must return a GameView');
      if (retired.has(view)) fail('a scene factory reused a disposed view; return a new owned view per instance');
      active = { key, view, context: { scene, frame, view }, sceneUi: !!sceneFactory || !scene || scene.kind === 'gameplay' };
      if (typeof view.resize !== 'function' || typeof view.update !== 'function') fail('a scene view needs resize and update methods');
      if (view.terrainWorld && view.terrainWorld !== terrainWorld) fail('pass the same terrainWorld adapter to createSceneView and each terrain route');
      if (dimensions) view.resize(...dimensions);
      view.setReviewCamera?.(reviewCamera);
      view.setInspectionFocus?.(inspectionFocus);
      for (const object of objects) view.featureHost?.add(object);
      for (const [id, object] of appearances) view.featureHost?.setPlayerAppearance?.(id, object);
      for (const [id, target] of targets) view.featureHost?.setInspectionTarget?.(id, target.object, target.label, target.related);
      onEnter?.(active.context);
      return disposed ? undefined : view;
    } catch (error) {
      // A failed factory/entry leaves no live route. Do not recreate it on every
      // frame, or repeat an entry effect/resource allocation after the failure.
      failed = true; failure = error;
      try { retire(); } catch { /* Preserve the first construction/entry error. */ }
      throw error;
    } finally { transitioning = false; }
  };
  const featureHost: FeatureHost = {
    add(object) {
      if (disposed || objects.has(object)) return;
      if (objects.size >= 2048) fail('at most 2048 feature attachments per scene router');
      objects.add(object); active?.view.featureHost?.add(object);
    },
    remove(object) {
      if (!objects.delete(object)) return;
      active?.view.featureHost?.remove(object);
      for (const [id, target] of targets) if (target.object === object) {
        targets.delete(id); active?.view.featureHost?.setInspectionTarget?.(id, null);
      }
    },
    setPlayerAppearance(id, object) {
      if (disposed) return;
      if (object === null) appearances.delete(id);
      else { if (!appearances.has(id) && appearances.size >= 32) fail('at most 32 participant appearances'); appearances.set(id, object); }
      active?.view.featureHost?.setPlayerAppearance?.(id, object);
    },
    setInspectionTarget(id, object, label, related) {
      if (disposed) return;
      if (object === null) targets.delete(id);
      else { if (!targets.has(id) && targets.size >= 128) fail('at most 128 inspection targets'); targets.set(id, { object, label, related }); }
      active?.view.featureHost?.setInspectionTarget?.(id, object, label, related);
    },
  };
  return {
    ...(terrainWorld ? { terrainWorld } : {}), featureHost,
    resize(width, height, ratio) { if (disposed) return; dimensions = [width, height, ratio]; active?.view.resize(width, height, ratio); },
    actorSignals: frame => select(frame)?.actorSignals?.(frame) ?? {},
    update(frame) { select(frame)?.update(frame); },
    ui: frame => {
      const view = select(frame);
      // An unmapped blocked scene may use the gameplay background, but its HUD
      // must not be relabelled as meeting UI. The trusted default remains visible.
      if (!active?.sceneUi) return null;
      const document = view?.ui?.(frame) ?? null;
      return document && frame.scene?.kind !== 'gameplay' && frame.scene
        ? { ...document, scene: { id: frame.scene.id, sequence: frame.scene.sequence } } : document;
    },
    info: () => disposed ? {} : active?.view.info?.() ?? {},
    setReviewCamera(camera) { if (disposed) return; reviewCamera = camera; active?.view.setReviewCamera?.(camera); },
    setInspectionFocus(focus) { if (disposed) return; inspectionFocus = focus; active?.view.setInspectionFocus?.(focus); },
    inspectionFocus: () => disposed ? {} : active?.view.inspectionFocus?.() ?? {},
    inspection: () => disposed ? {} : active?.view.inspection?.() ?? {},
    dispose() {
      if (disposed) return; disposed = true;
      try { retire(); } finally { objects.clear(); appearances.clear(); targets.clear(); }
    },
  };
}

/** Reserved host intents carry the instance separately from a choice's logical
 * index. The renderer may fill item/index for a choice without overwriting the
 * sequence; a delayed click from a retired scene is rejected by the host. */
export function sceneUiAction(scene: Pick<GameSceneSnapshot, 'sequence'>, action: GameSceneActionKind, value?: string): GameUiAction {
  const names: Record<GameSceneActionKind, string> = { choose: 'host:sceneChoose', ready: 'host:sceneReady', unready: 'host:sceneUnready', skip: 'host:sceneSkip', custom: 'host:sceneCustom' };
  if (!scene || !Number.isInteger(scene.sequence) || scene.sequence < 1 || scene.sequence > 0xffffffff) fail('scene UI action needs a valid uint32 instance sequence');
  if (!Object.prototype.hasOwnProperty.call(names, action)) fail('unknown scene UI action');
  if (value !== undefined && (typeof value !== 'string' || !value.length || value.length > 96 || /[\p{Cc}\p{Cf}]/u.test(value))) fail('scene UI value must be short nonempty text without control characters');
  return { name: names[action], sceneSequence: scene.sequence, ...(value === undefined ? {} : { item: value }) };
}

export interface SceneCameraKeyframe {
  atMs: number;
  position: Vector;
  lookAt: Vector;
  /** Degrees, 5..150. Omitted is 60. */
  fov?: number;
  /** Interpolation from this keyframe to the next. Default smoothstep. */
  ease?: 'linear' | 'smoothstep';
}
export interface SceneCameraSample {
  position: Vector;
  lookAt: Vector;
  fov: number;
  progress: number;
}
export interface SceneCameraTrack {
  readonly durationMs: number;
  /** Use frame.scene.elapsedMs. This is seekable, so reconnecting halfway
   * through a reveal does not replay it or depend on local entry time. Apply
   * this pose to the scene's actual camera and audio listener. Review cameras
   * remain reserved for authoring/inspection. */
  sample(elapsedMs: number): SceneCameraSample;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixVector = (a: Vector, b: Vector, t: number): Vector => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t) });
function vector(raw: Vector, label: string): Vector {
  if (!raw || ![raw.x, raw.y, raw.z].every(value => finite(value) && Math.abs(value) <= 1e7)) fail(`${label} must contain finite x/y/z coordinates within ±10000000`);
  return { x: raw.x, y: raw.y, z: raw.z };
}
/** Bounded and copied once. Sampling allocates only the returned plain pose and
 * never mutates authored keyframes or keeps a browser-clock accumulator. */
export function createSceneCameraTrack(keyframes: readonly SceneCameraKeyframe[]): SceneCameraTrack {
  if (!Array.isArray(keyframes) || keyframes.length < 1 || keyframes.length > 64) fail('a camera track needs 1..64 keyframes');
  const frames = keyframes.map((frame, index) => {
    if (!frame || !finite(frame.atMs) || frame.atMs < 0 || frame.atMs > 600000 || index === 0 && frame.atMs !== 0
      || index > 0 && frame.atMs <= keyframes[index - 1].atMs) fail('camera keyframe times must start at zero and increase within 0..600000ms');
    if (frame.ease !== undefined && frame.ease !== 'linear' && frame.ease !== 'smoothstep') fail('camera easing must be linear or smoothstep');
    const fov = frame.fov ?? 60;
    if (!finite(fov) || fov < 5 || fov > 150) fail('camera fov must be 5..150 degrees');
    return { atMs: frame.atMs, position: vector(frame.position, 'camera position'), lookAt: vector(frame.lookAt, 'camera lookAt'), fov, ease: frame.ease ?? 'smoothstep' };
  });
  // A zero viewing direction is undefined. Reject both coincident endpoints
  // and a segment whose interpolated position passes through its look target.
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index], next = frames[index + 1] ?? frame;
    const a = { x: frame.lookAt.x - frame.position.x, y: frame.lookAt.y - frame.position.y, z: frame.lookAt.z - frame.position.z };
    const b = { x: next.lookAt.x - next.position.x - a.x, y: next.lookAt.y - next.position.y - a.y, z: next.lookAt.z - next.position.z - a.z };
    const denominator = b.x * b.x + b.y * b.y + b.z * b.z;
    const t = denominator ? Math.max(0, Math.min(1, -(a.x * b.x + a.y * b.y + a.z * b.z) / denominator)) : 0;
    if ((a.x + b.x * t) ** 2 + (a.y + b.y * t) ** 2 + (a.z + b.z * t) ** 2 < 1e-12) fail('camera position must stay distinct from lookAt throughout each segment');
  }
  const durationMs = frames[frames.length - 1].atMs;
  return Object.freeze({ durationMs, sample(elapsedMs: number): SceneCameraSample {
    if (!finite(elapsedMs)) fail('camera elapsedMs must be finite');
    const time = Math.max(0, Math.min(durationMs, elapsedMs));
    let index = 0;
    while (index + 1 < frames.length && frames[index + 1].atMs <= time) index++;
    const from = frames[index], to = frames[index + 1] ?? from;
    const linear = to.atMs > from.atMs ? (time - from.atMs) / (to.atMs - from.atMs) : 0;
    const t = from.ease === 'smoothstep' ? linear * linear * (3 - 2 * linear) : linear;
    return { position: mixVector(from.position, to.position, t), lookAt: mixVector(from.lookAt, to.lookAt, t), fov: mix(from.fov, to.fov, t), progress: sceneProgress(time, durationMs) };
  } });
}

/** Presentation progress only; completion is still an authoritative transition. */
export function sceneProgress(sceneOrElapsedMs: Pick<GameSceneSnapshot, 'elapsedMs' | 'definition'> | number, durationMs?: number): number {
  const elapsedMs = typeof sceneOrElapsedMs === 'number' ? sceneOrElapsedMs : sceneOrElapsedMs.elapsedMs;
  const duration = durationMs ?? (typeof sceneOrElapsedMs === 'number' ? undefined : sceneOrElapsedMs.definition.durationMs);
  if (!finite(elapsedMs) || !finite(duration) || duration < 0) fail('sceneProgress needs finite elapsedMs and a nonnegative durationMs');
  return duration === 0 ? 1 : Math.max(0, Math.min(1, elapsedMs / duration));
}
