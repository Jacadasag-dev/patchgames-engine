import { BatchedMesh, Camera, DirectionalLight, Group, LOD, Material, Mesh, Object3D, PointLight, Scene, SkinnedMesh, SpotLight, Vector4, WebGLRenderer } from 'three';
import { installSoundCameraTracking } from './audioListener.ts';
import { RenderBatching } from './renderBatching.ts';
import { RenderVisibility, type RenderSceneItems } from './renderVisibility.ts';
import { isEngineCameraMaskCallback } from './playerAppearance.ts';
import { forgetRendererCompletion, recordRendererSubmission } from './renderCompletion.ts';
import {GeneratedLodAdapters,hasGeneratedLodAdapter} from './generatedLod.ts';

// One renderer may draw a world, HUD, minimap and recursive reflection. Keep
// their buffers independent, but bound the number of retained scene contexts.
const MAX_CONTEXTS = 16;
interface Context {
  scene: Object3D;
  depth: number;
  used: number;
  batching: RenderBatching;
  visibility: RenderVisibility;
  items: RenderSceneItems;
  generatedLod:GeneratedLodAdapters;
  matrixUpdates?: boolean;
}
interface DrawScope { context: Context; camera: Camera; height: number; prepared: boolean; scanned: boolean;lodEnabled:boolean }
interface RendererState {
  contexts: Context[];
  stack: (DrawScope | null)[];
  viewport: Vector4;
  draws: number;
  disposed: boolean;
  lodEnabled:boolean;
  last?: Context;
}
const states = new WeakMap<WebGLRenderer, RendererState>();
let installed = false;

function hasMatrixCallbacks(object: Object3D): boolean {
  if (object.updateMatrix !== Object3D.prototype.updateMatrix) return true;
  if (object.updateMatrixWorld === Object3D.prototype.updateMatrixWorld && object.updateWorldMatrix === Object3D.prototype.updateWorldMatrix) return false;
  // These built-in methods update camera inverses / bind matrices without
  // changing the authored hierarchy gathered before the world matrix pass.
  const prototype = object instanceof Camera ? Camera.prototype : object instanceof SkinnedMesh ? SkinnedMesh.prototype : Object3D.prototype;
  return object.updateMatrixWorld !== prototype.updateMatrixWorld || object.updateWorldMatrix !== prototype.updateWorldMatrix;
}
function collectScene(object: Object3D, items: RenderSceneItems, checkCallbacks: boolean, cameraLayers: number, groupOrder = 0, visible = true): boolean {
  // Three updates even hidden branches' matrices. A custom override can add,
  // remove or reveal siblings after this scan, so preserve its original path.
  if (checkCallbacks && hasMatrixCallbacks(object)) return true;
  visible = visible && object.visible;
  if (visible) {
    if(hasGeneratedLodAdapter(object))items.generatedLodRoots?.push(object);
    // Three chooses authored LOD children during render-list construction,
    // after proxies would have captured the previous level's visibility.
    if (checkCallbacks && object instanceof LOD && object.autoUpdate) return true;
    const prototype = object instanceof BatchedMesh ? BatchedMesh.prototype : Object3D.prototype;
    if (checkCallbacks && (object.onBeforeRender !== prototype.onBeforeRender
      || object.onAfterRender !== prototype.onAfterRender && !isEngineCameraMaskCallback(object.onAfterRender)
      || object.onBeforeShadow !== prototype.onBeforeShadow || object.onAfterShadow !== prototype.onAfterShadow)) return true;
    if (object instanceof Group && (object.layers.mask & cameraLayers) !== 0) groupOrder = object.renderOrder;
    if (object instanceof Mesh) {
      if (checkCallbacks && Array.isArray(object.material)) {
        for (const material of object.material) if (material.onBeforeRender !== Material.prototype.onBeforeRender
          && !isEngineCameraMaskCallback(material.onBeforeRender)) return true;
      } else if (checkCallbacks && !Array.isArray(object.material) && object.material.onBeforeRender !== Material.prototype.onBeforeRender
        && !isEngineCameraMaskCallback(object.material.onBeforeRender)) return true;
      items.meshes.push(object); items.groupOrders.push(groupOrder);
    }
    if (object.castShadow && (object instanceof DirectionalLight || object instanceof PointLight || object instanceof SpotLight)) items.shadowLights.push(object);
  }
  for (const child of object.children) if (collectScene(child, items, checkCallbacks, cameraLayers, groupOrder, visible)) return true;
  return false;
}
function scan(context: Context, checkCallbacks: boolean, camera: Camera): boolean {
  const items = context.items; items.meshes.length = items.groupOrders.length = items.shadowLights.length = 0;
  if(items.generatedLodRoots)items.generatedLodRoots.length=0;
  return collectScene(context.scene, items, checkCallbacks, camera.layers.mask);
}

function restore(context: Context): void {
  try { context.batching.restore(); }
  finally {
    try { context.visibility.restore(); }
    finally {
      try{context.generatedLod.restore();}finally{
        if (context.matrixUpdates !== undefined) context.scene.matrixWorldAutoUpdate = context.matrixUpdates;
        context.matrixUpdates = undefined;
      }
    }
  }
}
function prepare(scope: DrawScope): void {
  if (scope.prepared) return;
  scope.prepared = true;
  // Nested draws can change the hierarchy. Recollect when resuming an outer
  // pass; the initial scan already performed the authored callback guard.
  if (!scope.scanned) { scan(scope.context, false, scope.camera); scope.scanned = true; }
  const enabled=scope.lodEnabled;
  scope.context.generatedLod.prepare(scope.context.scene,scope.camera,scope.height,enabled,scope.context.items.generatedLodRoots,scope.context.items.shadowLights);
  if(scope.context.generatedLod.count)scan(scope.context,false,scope.camera);
  scope.context.visibility.prepare(scope.context.scene, scope.camera, scope.height, scope.context.items,enabled,scope.context.generatedLod.count>0);
  // Visibility just performed the same scene update as Three. The batching
  // stage updates its own proxy roots; avoid traversing the authored tree twice.
  scope.context.matrixUpdates = scope.context.scene.matrixWorldAutoUpdate;
  scope.context.scene.matrixWorldAutoUpdate = false;
  scope.context.batching.prepare(scope.context.scene, scope.camera, scope.context.items);
}
function restoreScope(scope: DrawScope): void {
  if (!scope.prepared) return;
  try { restore(scope.context); } finally { scope.prepared = false; scope.scanned = false; }
}
function disposeContext(context: Context): void {
  try { context.batching.dispose(); } finally {try{context.visibility.dispose();}finally{context.generatedLod.dispose();}}
}
function contextFor(state: RendererState, scene: Object3D): Context {
  const depth = state.stack.length - 1;
  let context = state.contexts.find(item => item.scene === scene && item.depth === depth);
  if (!context) {
    if (state.contexts.length >= MAX_CONTEXTS) {
      let oldest: Context | undefined;
      for (const item of state.contexts) if (!state.stack.some(scope => scope?.context === item)
        && (!oldest || item.used < oldest.used)) oldest = item;
      if (oldest) {
        try { disposeContext(oldest); }
        finally { state.contexts.splice(state.contexts.indexOf(oldest), 1); }
      }
    }
    context = { scene, depth, used: state.draws, batching: new RenderBatching(), visibility: new RenderVisibility(),generatedLod:new GeneratedLodAdapters(), items: { meshes: [], groupOrders: [], shadowLights: [],generatedLodRoots:[] } };
    state.contexts.push(context);
  }
  context.used = state.draws;
  return context;
}

/** Always-on engine rendering policy. Unsupported authored draws retain their
 * original path; the optimizers decide compatibility, never a player setting. */
export function configureRenderPerformance(renderer: WebGLRenderer): void {
  // Three assigns some methods after render in its constructor. The wrapper
  // must be installed immediately but only uses those methods when drawn.
  if (states.has(renderer) || typeof renderer.render !== 'function') return;
  const draw = renderer.render, dispose = renderer.dispose;
  const state: RendererState = { contexts: [], stack: [], viewport: new Vector4(), draws: 0, disposed: false,lodEnabled:true };
  states.set(renderer, state);
  renderer.render = function(scene, camera) {
    state.draws++;
    recordRendererSubmission(renderer);
    // Scene callbacks run inside Three after its matrix update and can mutate
    // arbitrary draw state. Keep those scenes on their authored render path.
    const compatible = !state.disposed && scene instanceof Object3D && state.stack.length < MAX_CONTEXTS
      && !(renderer.xr?.enabled && renderer.xr.isPresenting)
      && typeof renderer.getViewport === 'function' && typeof renderer.getRenderTarget === 'function'
      && typeof renderer.getPixelRatio === 'function'
      && (!(scene instanceof Scene) || !scene.overrideMaterial && scene.onBeforeRender === Scene.prototype.onBeforeRender
        && scene.onAfterRender === Scene.prototype.onAfterRender);
    const suspended = state.stack.at(-1);
    if (suspended) restoreScope(suspended);
    // An inert marker also isolates callbacks in unsupported nested passes.
    state.stack.push(null);
    let scope: DrawScope | undefined;
    try {
      // A callback on one object can move its siblings after proxies are built.
      // Preserve such authored scenes as a unit, including mirror callbacks.
      if (!compatible) { state.last = undefined; return draw.call(this, scene, camera); }
      const context = contextFor(state, scene);
      if (scan(context, true, camera)) { state.last = undefined; return draw.call(this, scene, camera); }
      let height: number;
      if (typeof renderer.getCurrentViewport === 'function') {
        renderer.getCurrentViewport(state.viewport); height = state.viewport.w;
      } else {
        renderer.getViewport(state.viewport);
        height = state.viewport.w * (renderer.getRenderTarget() ? 1 : renderer.getPixelRatio());
      }
      scope = { context, camera, height: Math.max(1, height), prepared: false, scanned: true,lodEnabled:state.lodEnabled };
      state.stack[state.stack.length - 1] = scope;
      prepare(scope);
      return draw.call(this, scene, camera);
    } finally {
      try { if (scope) restoreScope(scope); }
      finally {
        state.stack.pop(); if (scope) state.last = scope.context;
        if (suspended) prepare(suspended);
      }
    }
  };
  if (typeof dispose === 'function') renderer.dispose = function() {
    let failure: unknown, failed = false;
    try {
      if (!state.disposed) {
        state.disposed = true;
        forgetRendererCompletion(renderer);
        for (const context of state.contexts) {
          try { disposeContext(context); } catch (error) { if (!failed) { failure = error; failed = true; } }
        }
      }
    } finally {
      state.contexts.length = 0; state.last = undefined;
      dispose.call(this);
    }
    if (failed) throw failure;
  };
}

/** Cheap counters for diagnostics; no GPU readbacks or timers in the hot path. */
export function renderPerformanceStats(renderer: WebGLRenderer) {
  const state = states.get(renderer);
  return { draws: state?.draws ?? 0, retainedScenes: state?.contexts.length ?? 0,
    visibility: state?.last?.visibility.stats ?? null, batching: state?.last?.batching.stats ?? null,
    generatedLod:{enabled:state?.lodEnabled??true,adapters:state?.last?.generatedLod.count??0} };
}
/** Diagnostic A/B switch; ordinary engine games retain automatic LOD by default. */
export function setGeneratedLodEnabled(renderer:WebGLRenderer,enabled:boolean){if(typeof enabled!=='boolean')throw Error('LOD diagnostic switch requires a boolean.');configureRenderPerformance(renderer);const state=states.get(renderer);if(state)state.lodEnabled=enabled;}

/** Three assigns render during construction. Compose with the existing audio
 * hook so every authored sandbox renderer receives the policy automatically. */
export function installRenderPerformance(): void {
  if (installed) return;
  installSoundCameraTracking();
  const prototype = WebGLRenderer.prototype;
  const previous = Object.getOwnPropertyDescriptor(prototype, 'render');
  if (previous && !previous.configurable) throw new Error('The engine renderer hook must be configurable.');
  Object.defineProperty(prototype, 'render', { configurable: true,
    set(this: WebGLRenderer, draw: WebGLRenderer['render']) {
      if (previous?.set) previous.set.call(this, draw);
      else Object.defineProperty(this, 'render', { value: draw, configurable: true, writable: true });
      configureRenderPerformance(this);
    },
  });
  installed = true;
}
