import { CustomBlending } from 'three/webgpu';
import { isEngineRenderProxy } from './renderProxyIdentity.ts';

interface ProxyObject {
  isInstancedMesh?: boolean;
  isBatchedMesh?: boolean;
  occlusionTest?: boolean;
  _multiDrawCount?: number;
  _multiDrawStarts?: ArrayLike<number>;
  _multiDrawCounts?: ArrayLike<number>;
  _multiDrawBytesPerElement?: number;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}
interface DrawObject {
  object: ProxyObject;
  material: { blending?: number; stencilWrite?: boolean };
  context: object;
  camera?: { isArrayCamera?: boolean };
  getIndex(): { array: ArrayLike<number> } | null;
  getIndirect(): object | null;
}
interface DrawParameters { vertexCount: number; firstVertex: number; instanceCount: number; firstInstance: number }
interface DrawInfo { update(object: ProxyObject, count: number, instances: number): void }
interface Encoder { executeBundles?(bundles: unknown[]): void; finish?(): unknown }
interface EncoderState { attributes: Record<number, unknown>; bindingGroups: unknown[]; pipeline: unknown; index: unknown }
interface ContextData { occlusionQuerySet?: unknown }
type Draw = (renderObject: DrawObject, info: DrawInfo, contextData: ContextData, pipeline: unknown,
  bindings: object[], vertexBuffers: object[], parameters: DrawParameters, encoder: Encoder,
  state: EncoderState, cameraIndexSlot?: number) => void;

export interface BundleBackend {
  _draw: Draw;
  get(resource: object): { buffer?: unknown; group?: unknown };
  pipelineUtils: { createBundleEncoder(context: object): Encoder };
  utils: {
    getCurrentColorFormats(context: object): string[];
    getCurrentDepthStencilFormat(context: object): string | undefined;
    getSampleCountRenderContext(context: object): number;
  };
}
interface Owner { keys: Set<DrawObject>; dispose: () => void }
interface Entry {
  owner: ProxyObject;
  bundle: unknown[];
  pipeline: unknown;
  context: object;
  groups: unknown[];
  vertices: unknown[];
  indexBuffer: unknown;
  shortIndex: boolean;
  colors: string[];
  depth: string | undefined;
  samples: number;
  parameters: number[];
  ranges: number[];
  drawCount: number;
  indexBytes: number;
  lastFrame: number;
}

/** Reuse multi-draw batch commands without bypassing Three's live render path.
 * Culling, callbacks, interpolation, shadows, uploads and pipeline selection
 * still run normally. Only _draw's final encoder commands are retained, after
 * every captured GPU resource and draw argument has been compared. Bundles run
 * inline in the original draw order; unlike BundleGroup, no scene is reordered
 * and no authored update/callback is skipped. Single draws retain native state
 * reuse: bundling one draw cannot reduce draw commands, and resets state that
 * adjacent draws could otherwise share. */
export function reuseRendererBundles(backend: BundleBackend, limits: { entries?: number; draws?: number; idleFrames?: number } = {}) {
  const original = backend._draw;
  const entries = new Map<DrawObject, Entry>(), owners = new Map<ProxyObject, Owner>();
  const maxEntries = limits.entries ?? 512, maxDraws = limits.draws ?? 16_384, idleFrames = limits.idleFrames ?? 120;
  let frame = 0, retainedDraws = 0, disposed = false;
  const counters = { enabled: typeof original === 'function' && typeof backend.pipelineUtils?.createBundleEncoder === 'function',
    recordedBundles: 0, reusedBundles: 0, bundledDraws: 0, uncachedDraws: 0, invalidations: 0, evictions: 0 };

  function remove(key: DrawObject): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key); retainedDraws -= entry.drawCount;
    const owner = owners.get(entry.owner)!;
    owner.keys.delete(key);
    if (!owner.keys.size) {
      entry.owner.removeEventListener?.('dispose', owner.dispose);
      owners.delete(entry.owner);
    }
  }

  function remember(key: DrawObject, entry: Entry): void {
    while (entries.size >= maxEntries || retainedDraws + entry.drawCount > maxDraws) {
      const oldest = entries.keys().next().value;
      if (!oldest) break;
      remove(oldest); counters.evictions++;
    }
    entries.set(key, entry); retainedDraws += entry.drawCount;
    let owner = owners.get(entry.owner);
    if (!owner) {
      const object = entry.owner;
      owner = { keys: new Set(), dispose: () => {
        const current = owners.get(object);
        if (current) for (const owned of [...current.keys]) remove(owned);
      } };
      owners.set(object, owner); object.addEventListener?.('dispose', owner.dispose);
    }
    owner.keys.add(key);
  }

  const wrapped: Draw = function(renderObject, info, contextData, pipeline, bindings, vertexBuffers, parameters, encoder, state, cameraIndexSlot = -1) {
    const object = renderObject.object;
    // Array-camera bindings, pass-level query/stencil/blend state, authored
    // objects and nested native bundles keep their complete native encoding.
    if (disposed || !isEngineRenderProxy(object) || !object.isBatchedMesh || !(object._multiDrawCount! >= 2)
      || !encoder.executeBundles || cameraIndexSlot >= 0 || renderObject.camera?.isArrayCamera
      || contextData.occlusionQuerySet !== undefined || object.occlusionTest
      || renderObject.material.stencilWrite || renderObject.material.blending === CustomBlending
      || renderObject.getIndirect() !== null) {
      counters.uncachedDraws++;
      original.call(backend, renderObject, info, contextData, pipeline, bindings, vertexBuffers, parameters, encoder, state, cameraIndexSlot);
      return;
    }
    const drawCount = object.isBatchedMesh ? object._multiDrawCount! : 1;
    if (drawCount <= 0 || drawCount > maxDraws || maxEntries <= 0) {
      counters.uncachedDraws++;
      original.call(backend, renderObject, info, contextData, pipeline, bindings, vertexBuffers, parameters, encoder, state, cameraIndexSlot);
      return;
    }
    const index = renderObject.getIndex(), indexBuffer = index ? backend.get(index).buffer : null;
    const shortIndex = index?.array instanceof Uint16Array;
    const context = renderObject.context;
    const colors = backend.utils.getCurrentColorFormats(context);
    const depth = backend.utils.getCurrentDepthStencilFormat(context);
    const samples = backend.utils.getSampleCountRenderContext(context);
    const indexBytes = object.isBatchedMesh ? object._multiDrawBytesPerElement! : 0;
    let entry = entries.get(renderObject);
    let matches = entry !== undefined && entry.owner === object && entry.pipeline === pipeline && entry.context === context
      && entry.indexBuffer === indexBuffer && entry.shortIndex === shortIndex && entry.depth === depth && entry.samples === samples
      && entry.groups.length === bindings.length && entry.vertices.length === vertexBuffers.length && entry.colors.length === colors.length
      && entry.drawCount === drawCount && entry.indexBytes === indexBytes
      && entry.parameters[0] === parameters.vertexCount && entry.parameters[1] === parameters.firstVertex
      && entry.parameters[2] === parameters.instanceCount && entry.parameters[3] === parameters.firstInstance;
    if (matches) {
      const cached = entry!;
      for (let i = 0; i < colors.length && matches; i++) matches = cached.colors[i] === colors[i];
      for (let i = 0; i < bindings.length && matches; i++) matches = cached.groups[i] === backend.get(bindings[i]).group;
      for (let i = 0; i < vertexBuffers.length && matches; i++) matches = cached.vertices[i] === backend.get(vertexBuffers[i]).buffer;
      if (object.isBatchedMesh) for (let i = 0; i < drawCount && matches; i++) {
        matches = cached.ranges[i * 2] === object._multiDrawStarts![i] && cached.ranges[i * 2 + 1] === object._multiDrawCounts![i];
      }
    }
    if (matches) {
      // Map insertion order provides a bounded LRU without sorting each frame.
      entries.delete(renderObject); entries.set(renderObject, entry!); entry!.lastFrame = frame;
      counters.reusedBundles++;
      if (object.isBatchedMesh) {
        for (let i = 0; i < drawCount; i++) info.update(object, object._multiDrawCounts![i], 1);
      } else info.update(object, parameters.vertexCount, parameters.instanceCount);
    } else {
      if (entry) { remove(renderObject); counters.invalidations++; }
      const bundleEncoder = backend.pipelineUtils.createBundleEncoder(context);
      const freshState: EncoderState = { attributes: {}, bindingGroups: [], pipeline: null, index: null };
      // Only the command encoder changes. Native updates have already supplied
      // current buffer contents and completed all world/HUD/shadow callbacks.
      original.call(backend, renderObject, info, contextData, pipeline, bindings, vertexBuffers, parameters, bundleEncoder, freshState, cameraIndexSlot);
      const bundle = bundleEncoder.finish!();
      const ranges: number[] = [];
      if (object.isBatchedMesh) for (let i = 0; i < drawCount; i++) ranges.push(object._multiDrawStarts![i], object._multiDrawCounts![i]);
      entry = { owner: object, bundle: [bundle], pipeline, context, groups: bindings.map(binding => backend.get(binding).group),
        vertices: vertexBuffers.map(buffer => backend.get(buffer).buffer), indexBuffer, shortIndex, colors: [...colors], depth, samples,
        parameters: [parameters.vertexCount, parameters.firstVertex, parameters.instanceCount, parameters.firstInstance], ranges,
        drawCount, indexBytes, lastFrame: frame };
      remember(renderObject, entry); counters.recordedBundles++;
    }
    encoder.executeBundles(entry!.bundle); counters.bundledDraws += drawCount;
    // executeBundles clears render-pass pipeline/vertex/index/bind-group state.
    // Three's software cache must reflect that before the next ordinary draw.
    state.pipeline = null; state.index = null; state.attributes = {}; state.bindingGroups.length = 0;
  };
  if (counters.enabled) backend._draw = wrapped;
  return {
    beginFrame() {
      frame++;
      if (frame % 30 === 0) for (const [key, entry] of entries) {
        if (frame - entry.lastFrame > idleFrames) { remove(key); counters.evictions++; }
      }
    },
    stats() { return { ...counters, retainedBundles: entries.size, retainedDraws }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (backend._draw === wrapped) backend._draw = original;
      for (const key of entries.keys()) remove(key);
    },
  };
}
