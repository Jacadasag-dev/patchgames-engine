/** Engine-owned WebGPU compatibility facade for eligible classic Three views.
 * The host still qualifies appearance, stability and performance before use. */
import {
  ACESFilmicToneMapping, BackSide, BatchedMesh, Color, ColorManagement, Material, Matrix4, NoToneMapping, Object3D, PCFShadowMap, PCFSoftShadowMap,
  SRGBTransfer, WebGLCoordinateSystem, WebGPUCoordinateSystem, WebGPURenderer as NativeWebGPURenderer,
  type Camera, type DepthTexture, type LightShadow, type Node, type NodeBuilder, type NodeMaterial, type Scene, type Texture, type WebGPURendererParameters,
} from 'three/webgpu';
import { add, densityFogFactor, float, Fn, interleavedGradientNoise, lightShadowMatrix, mat3, mix, modelNormalMatrix, modelWorldMatrix,
  normalLocal, positionLocal, premultiplyAlpha, rangeFogFactor, reference, renderGroup, screenCoordinate, screenSize, texture,
  toneMapping, toneMappingExposure, vec2, vec3, vec4, vertexStage, vogelDiskSample, workingToColorSpace } from 'three/tsl';
import { retainRendererPipelines, type PipelineManager } from './rendererPipelineCache.ts';
import { stabilizeRendererBufferNames, type ShaderBuilderBackend } from './rendererShaderNames.ts';
import { reuseRendererBundles, type BundleBackend } from './rendererBundles.ts';
import { reuseRendererUniformUploads, type UniformUploadBackend } from './rendererUniformUploads.ts';

export * from 'three/webgpu';

type ParametersWithWebGLOptions = WebGPURendererParameters & {
  premultipliedAlpha?: boolean;
  preserveDrawingBuffer?: boolean;
  failIfMajorPerformanceCaveat?: boolean;
};
type InternalRenderer = {
  _getFallback: unknown;
  _samples: number;
  _initialized: boolean;
  _isDeviceLost: boolean;
  _animation: { stop(): void };
  _nodes: { nodeFrame: { frameId: number; update(): void } };
  _inspector: { isRunning: boolean; begin(): void; finish(): void };
  _background: { update(scene: Scene, renderList: unknown, renderContext: ClearContext): void };
  _pipelines: PipelineManager;
};
type ClearContext = { textures: unknown; clearColorValue: { r: number; g: number; b: number; a: number } };
type BackendDiagnostics = {
  isWebGPUBackend?: boolean;
  compatibilityMode?: boolean;
  device?: {
    adapterInfo?: { vendor?: string; architecture?: string; device?: string; description?: string; isFallbackAdapter?: boolean };
    features?: Set<string>;
  };
};
type GlobalShadowMap = NativeWebGPURenderer['shadowMap'] & { autoUpdate: boolean; needsUpdate: boolean };
const renderers = new Set<WebGLRenderer>();
const MAX_FAILURES = 16;
const MAX_FAILURE_LENGTH = 1024;
const webGLToWebGPUProjection = new Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, .5, .5, 0, 0, 0, 1);

// Match the classic GLSL implementation. Three r186's TSL RRT fit currently
// multiplies the linear denominator term by .983729 too, brightening colors.
const classicACES = Fn(([input, exposure]: [Node<'vec3'>, Node<'float'>]) => {
  const inputMatrix = mat3(.59719, .35458, .04823, .07600, .90834, .01566, .02840, .13383, .83777);
  const outputMatrix = mat3(1.60475, -.53108, -.07367, -.10208, 1.10813, -.00605, -.00327, -.07276, 1.07602);
  const color = inputMatrix.mul(vec3(input).mul(exposure.div(.6)));
  const numerator = color.mul(color.add(.0245786)).sub(.000090537);
  const denominator = color.mul(color.mul(.983729).add(.4329510)).add(.238081);
  return outputMatrix.mul(numerator.div(denominator)).clamp();
}).setLayout({ name: 'classicACESFilmToneMapping', type: 'vec3', inputs: [
  { name: 'input', type: 'vec3' }, { name: 'exposure', type: 'float' },
] });

type ShadowFilterInputs = { depthTexture: DepthTexture; shadowCoord: Node<'vec3'>; shadow: LightShadow; depthLayer: Node<'float'> };
const classicPCF = ({ depthTexture, shadowCoord, shadow, depthLayer }: ShadowFilterInputs) => Fn(() => {
  // Match GLSL's bottom-origin pixel noise and its shadow-texture axes. The
  // native filter uses the same samples with top-origin coordinates, changing
  // the shadow edge pattern even though its radius and tap count are equal.
  const mapSize = reference('mapSize', 'vec2', shadow), shadowRadius = reference('radius', 'float', shadow);
  for (const node of [mapSize, shadowRadius])
    (node as unknown as { setGroup(group: typeof renderGroup): void }).setGroup(renderGroup);
  const radius = shadowRadius.div(mapSize.x);
  const phi = interleavedGradientNoise(vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y))).mul(Math.PI * 2);
  const sample = (index: number) => {
    const offset = vogelDiskSample(float(index), float(5), phi).mul(radius).mul(vec2(1, -1));
    let sampled = texture(depthTexture, shadowCoord.xy.add(offset));
    if ((depthTexture as DepthTexture & { isArrayTexture?: boolean }).isArrayTexture) sampled = sampled.depth(depthLayer);
    return sampled.compare(shadowCoord.z);
  };
  return add(sample(0), sample(1), sample(2), sample(3), sample(4)).mul(.2);
})();

/** Read the actual worker context. A secure parent page does not establish
 * WebGPU availability inside an opaque sandbox frame or its blob worker. */
export function prototypeWebGPUAvailability() {
  const environment = globalThis as unknown as {
    isSecureContext?: boolean;
    navigator?: { gpu?: { requestAdapter?: unknown } };
  };
  return {
    isSecureContext: environment.isSecureContext ?? null,
    navigatorGpu: environment.navigator?.gpu !== undefined,
    requestAdapter: typeof environment.navigator?.gpu?.requestAdapter === 'function',
  };
}

/** Retain the authored WebGL constructor surface while using a verified WebGPU
 * backend. Unsupported classic features fail closed to the host's WebGL path. */
export class WebGLRenderer extends NativeWebGPURenderer {
  private readonly requestedSamples: number;
  private readonly failures: string[] = [];
  private failureCount = 0;
  private readonly nativeDraw = NativeWebGPURenderer.prototype.render;
  private activeObject?: Parameters<NativeWebGPURenderer['renderObject']>;
  private projectionDepth = 0;
  private readonly projectionFrames: { projection: Matrix4; inverse: Matrix4; coordinateSystem: Camera['coordinateSystem'] }[] = [];
  private outputSignature = '';
  private outputBridgeInstalled = false;
  private readonly clearOutputColor = new Color();
  private readonly outputMaterials = new WeakSet<NodeMaterial>();
  private pipelineRetention?: ReturnType<typeof retainRendererPipelines>;
  private commandBundles?: ReturnType<typeof reuseRendererBundles>;
  private uniformUploads?: ReturnType<typeof reuseRendererUniformUploads>;

  constructor(parameters: ParametersWithWebGLOptions = {}) {
    if (parameters.forceWebGL) throw new Error('The WebGPU adapter cannot use a hidden WebGL fallback.');
    if (parameters.context !== undefined) throw new Error('The WebGPU adapter requires its own GPU canvas context.');
    if (parameters.preserveDrawingBuffer) throw new Error('preserveDrawingBuffer requires the WebGL renderer.');
    if (parameters.premultipliedAlpha === false) throw new Error('Non-premultiplied alpha requires the WebGL renderer.');
    if (parameters.failIfMajorPerformanceCaveat) throw new Error('WebGPU does not expose failIfMajorPerformanceCaveat.');
    // Match WebGL's opaque default. Fragment output conversion below retains
    // HDR lighting until tone mapping, just as the classic renderer does.
    super({ alpha: false, ...parameters });
    stabilizeRendererBufferNames(this.backend as unknown as ShaderBuilderBackend);
    this.requestedSamples = parameters.samples || (parameters.antialias ? 4 : 0);
    // WebGPURenderer replaces the supplied getFallback in its constructor.
    // Disable that installed fallback explicitly and verify again after init.
    (this as unknown as InternalRenderer)._getFallback = null;
    Object.assign(this.shadowMap, { autoUpdate: true, needsUpdate: false });
    this.installFailureCallbacks();
    // WebGLRenderer assigns render during construction. The engine's existing
    // audio/performance hooks intercept that assignment on this adapter.
    this.render = this.drawWithWebGLShadowGate.bind(this);
    this.library.toneMappingNodes.set(ACESFilmicToneMapping,
      (color, exposure) => classicACES(color as Node<'vec3'>, exposure as Node<'float'>));
    const getLightClass = this.library.getLightNodeClass.bind(this.library);
    type LightClass = NonNullable<ReturnType<typeof getLightClass>>;
    const lightClasses = new WeakMap<LightClass, LightClass>();
    this.library.getLightNodeClass = light => {
      const Base = getLightClass(light);
      if (!Base) return null;
      let adapted = lightClasses.get(Base);
      if (!adapted) {
        adapted = class extends Base {
          override setupShadowNode() {
            const node = super.setupShadowNode();
            const light = this.light;
            if (light && !(light as typeof light & { isPointLight?: boolean }).isPointLight) {
              const internal = node as typeof node & {
                getShadowFilterFn(type: number): unknown;
                setupShadowCoord(builder: NodeBuilder, position: Node<'vec4'>): Node;
              };
              const getFilter = internal.getShadowFilterFn.bind(internal);
              internal.getShadowFilterFn = type => type === PCFShadowMap ? classicPCF : getFilter(type);
              const getCoordinate = internal.setupShadowCoord.bind(internal);
              internal.setupShadowCoord = (builder, _position) => {
                // Classic shadows offset vertex positions by geometric vertex
                // normals, then interpolate. Native GPU uses the fragment's
                // shading normal, changing shadows on flat/smooth/normal-mapped
                // surfaces even with identical light and bias settings.
                const shadow = (light as typeof light & { shadow: LightShadow }).shadow;
                const normalBias = reference('normalBias', 'float', shadow);
                (normalBias as unknown as { setGroup(group: typeof renderGroup): void }).setGroup(renderGroup);
                let normal = modelNormalMatrix.mul(normalLocal).normalize();
                if (builder.material.side === BackSide) normal = normal.negate();
                const position = modelWorldMatrix.mul(vec4(positionLocal, 1)).add(vec4(normal.mul(normalBias), 0));
                return getCoordinate(builder, vertexStage(lightShadowMatrix(light).mul(position)));
              };
            }
            return node;
          }
        };
        lightClasses.set(Base, adapted);
      }
      return adapted;
    };
    const fromMaterial = this.library.fromMaterial.bind(this.library);
    this.library.fromMaterial = material => {
      const converted = fromMaterial(material);
      if (!converted) throw new Error(`WebGPU compatibility: unsupported ${material.type} requires WebGL.`);
      if (!this.outputMaterials.has(converted)) {
        this.outputMaterials.add(converted);
        const setupOutput = converted.setupOutput;
        converted.setupOutput = (builder, node) => this.getRenderTarget() === null
          ? this.convertMaterialOutput(node as Node<'vec4'>, builder, converted)
          : setupOutput.call(converted, builder, node);
      }
      return converted;
    };
    renderers.add(this);
  }

  private recordFailure(info: unknown, deviceLost: boolean): void {
    this.failureCount = Math.min(Number.MAX_SAFE_INTEGER, this.failureCount + 1);
    let message = 'Uncaptured renderer error';
    try {
      if (typeof info === 'string') message = info.slice(0, MAX_FAILURE_LENGTH);
      else if (info && typeof info === 'object') {
        const value = info as { api?: unknown; type?: unknown; message?: unknown; reason?: unknown };
        // Native payloads include originalEvent. Summarizing known text fields
        // avoids serializing circular events or retaining large shader sources.
        const parts = [value.api, value.type, value.message, value.reason]
          .filter((part): part is string => typeof part === 'string' && part.length > 0);
        if (parts.length) message = parts.map(part => part.slice(0, MAX_FAILURE_LENGTH)).join(': ');
      }
    } catch { /* A diagnostic getter must not prevent the authored callback. */ }
    if (deviceLost) message = `Device lost: ${message}`;
    if (this.failures.length === MAX_FAILURES) this.failures.shift();
    this.failures.push(message.slice(0, MAX_FAILURE_LENGTH));
  }

  private installFailureCallbacks(): void {
    type Callback = (this: unknown, ...args: unknown[]) => void;
    const callbacks = this as unknown as Record<'onError' | 'onDeviceLost', Callback>, owner = this;
    for (const name of ['onError', 'onDeviceLost'] as const) {
      const active = new Set<unknown>();
      const wrap = (handler: Callback): Callback => function(...args) {
        const info = args[0], first = !active.has(info);
        if (first) {
          active.add(info); owner.recordFailure(info, name === 'onDeviceLost');
        }
        // r186 sets this only in its default callback. Replacing the callback
        // must not let a lost device silently acknowledge no-op renders.
        if (name === 'onDeviceLost') (owner as unknown as InternalRenderer)._isDeviceLost = true;
        try { handler.apply(this, args); }
        finally { if (first) active.delete(info); }
      };
      let current = wrap(callbacks[name]);
      Object.defineProperty(this, name, { configurable: true, enumerable: true,
        get: () => current, set: (handler: Callback) => { current = wrap(handler); } });
    }
  }

  private assertHealthy(): void {
    if (this.failureCount || (this as unknown as InternalRenderer)._isDeviceLost)
      throw new Error(`WebGPU renderer failed: ${this.failures.at(-1) ?? 'Device lost'}`);
  }

  // Classic WebGL converts each material before alpha blending. Native WebGPU
  // instead tone maps an intermediate image, which also changes untone-mapped
  // HUDs and color backgrounds. Draw to the same output format as WebGL and
  // perform that conversion in each material; this also avoids a redundant
  // full-screen output pass after every world/HUD render call.
  override get needsFrameBufferTarget(): boolean { return false; }

  private convertMaterialOutput(node: Node<'vec4'>, builder: NodeBuilder, material: NodeMaterial): Node {
    // Diagnostic normals are data colors in the classic shader, without any
    // tone mapping, output transfer, fog or alpha premultiplication chunks.
    if ((material as NodeMaterial & { isMeshNormalMaterial?: boolean }).isMeshNormalMaterial) return node;
    let mapped = material.toneMapped ? this.toneMapping : NoToneMapping;
    // WebGL does not tone map sRGB texture backgrounds, only HDR backgrounds.
    if ((builder.material as Material & { isNodeMaterial?: boolean }).isNodeMaterial && material.name === 'Background.material') {
      const background = (builder as NodeBuilder & { scene?: Scene }).scene?.background as Texture | null;
      if (background?.isTexture && ColorManagement.getTransfer(background.colorSpace) === SRGBTransfer) mapped = NoToneMapping;
    }
    let result: Node = node;
    if (mapped !== NoToneMapping) result = toneMapping(mapped, toneMappingExposure, result);
    result = workingToColorSpace(result, this.outputColorSpace);
    // Classic shader chunks apply fog after tone mapping and color conversion.
    // Mixing linear fog into HDR lighting before the output pass changes the
    // entire distant scene, even when sky/HUD colors are otherwise correct.
    const fog = (builder as NodeBuilder & { scene?: Scene }).scene?.fog;
    if (material.fog && fog) {
      const color = workingToColorSpace(vec4(reference('color', 'color', fog), 1), this.outputColorSpace);
      const factor = 'density' in fog
        ? densityFogFactor(reference('density', 'float', fog))
        : rangeFogFactor(reference('near', 'float', fog), reference('far', 'float', fog));
      const rgba = vec4(result as Node<'vec4'>);
      result = vec4(mix(rgba.rgb, vec4(color as unknown as Node<'vec4'>).rgb, factor), rgba.a);
    }
    return material.premultipliedAlpha ? premultiplyAlpha(vec4(result as Node<'vec4'>)) : result;
  }

  private prepareOutputConversion(): void {
    // Native render-context IDs already distinguish the canvas from texture
    // attachments in each render object's cache key. Bumping a global version
    // on target switches rebuilds both shader graphs every frame in multipass
    // games, even though neither pass's output conversion changed.
    const signature = `${this.toneMapping}:${this.outputColorSpace}`;
    if (signature === this.outputSignature) return;
    this.outputSignature = signature;
    this.contextNode.needsUpdate = true;
  }

  private convertClearColor(value: ClearContext['clearColorValue']): void {
    const alpha = value.a, factor = this.alpha ? alpha : 1;
    if (factor === 0) return;
    this.clearOutputColor.setRGB(value.r / factor, value.g / factor, value.b / factor);
    this.clearOutputColor.getRGB(this.clearOutputColor, this.outputColorSpace);
    value.r = this.clearOutputColor.r * factor; value.g = this.clearOutputColor.g * factor; value.b = this.clearOutputColor.b * factor;
  }

  private installOutputBridge(): void {
    if (this.outputBridgeInstalled) return;
    this.outputBridgeInstalled = true;
    const background = (this as unknown as InternalRenderer)._background, update = background.update.bind(background);
    background.update = (scene, renderList, renderContext) => {
      update(scene, renderList, renderContext);
      if (renderContext.textures === null) this.convertClearColor(renderContext.clearColorValue);
    };
    const backend = this.backend as unknown as { getClearColor(): ClearContext['clearColorValue'] };
    const getClearColor = backend.getClearColor.bind(backend);
    backend.getClearColor = () => {
      const value = getClearColor();
      if (this.getRenderTarget() === null) this.convertClearColor(value);
      return value;
    };
  }

  override async init(): Promise<this> {
    const availability = prototypeWebGPUAvailability();
    if (availability.isSecureContext !== true || !availability.requestAdapter) {
      throw new Error(`WebGPU is unavailable in this renderer context: isSecureContext=${availability.isSecureContext}, `
        + `navigator.gpu=${availability.navigatorGpu}, requestAdapter=${availability.requestAdapter}. `
        + 'The adapter requires WebGPU in its isolated worker context; the host owns renderer fallback.');
    }
    await super.init();
    this.installOutputBridge();
    this.pipelineRetention ??= retainRendererPipelines((this as unknown as InternalRenderer)._pipelines);
    this.commandBundles ??= reuseRendererBundles(this.backend as unknown as BundleBackend);
    this.uniformUploads ??= reuseRendererUniformUploads(this.backend as unknown as UniformUploadBackend);
    // Engine workers are driven by incoming frames. Do not let a second rAF
    // clock reset metrics or reuse shadow caches across two engine updates.
    (this as unknown as InternalRenderer)._animation.stop();
    const backend = this.backend as unknown as BackendDiagnostics;
    if (backend.isWebGPUBackend !== true) throw new Error('The WebGPU adapter initialized a non-WebGPU backend.');
    if ((this as unknown as InternalRenderer)._samples !== this.requestedSamples)
      throw new Error('WebGPU initialization changed the requested antialiasing sample count.');
    return this;
  }

  beginPrototypeFrame(): void {
    const internal = this as unknown as InternalRenderer;
    if (!internal._initialized) throw new Error('Initialize the WebGPU renderer before beginning a frame.');
    // The worker already reports update exceptions to the host. Surface a
    // captured asynchronous GPU failure even if an authored callback is quiet.
    this.assertHealthy();
    if (internal._inspector.isRunning) internal._inspector.finish();
    if (this.info.autoReset) this.info.reset();
    internal._nodes.nodeFrame.update();
    this.commandBundles?.beginFrame();
    (this.info as unknown as { frame: number }).frame = internal._nodes.nodeFrame.frameId;
    internal._inspector.begin();
  }

  private drawWithWebGLShadowGate(scene: Parameters<NativeWebGPURenderer['render']>[0],
    camera: Parameters<NativeWebGPURenderer['render']>[1]): void {
    if (this.shadowMap.enabled && this.shadowMap.type === PCFSoftShadowMap)
      throw new Error('WebGPU compatibility: PCFSoftShadowMap is unsupported; retain WebGL to preserve shadow quality.');
    this.prepareOutputConversion();
    const shadowMap = this.shadowMap as GlobalShadowMap;
    if (shadowMap.autoUpdate || shadowMap.needsUpdate || !shadowMap.enabled) {
      this.drawNativePass(scene, camera);
      shadowMap.needsUpdate = false;
      return;
    }
    // Inspection overlays freeze global WebGL shadow updates. WebGPU reads
    // per-light flags instead; retain the same freeze without changing lights.
    const previous: [LightShadow, boolean, boolean][] = [];
    scene.traverse((object: Object3D & { shadow?: LightShadow }) => {
      if (!object.castShadow || !object.shadow) return;
      const shadow = object.shadow;
      previous.push([shadow, shadow.autoUpdate, shadow.needsUpdate]);
      shadow.autoUpdate = shadow.needsUpdate = false;
    });
    try { this.drawNativePass(scene, camera); }
    finally { for (const [shadow, autoUpdate, needsUpdate] of previous) Object.assign(shadow, { autoUpdate, needsUpdate }); }
  }

  private drawNativePass(scene: Parameters<NativeWebGPURenderer['render']>[0],
    camera: Parameters<NativeWebGPURenderer['render']>[1]): void {
    const draw = this.render;
    let projection: typeof this.projectionFrames[number] | undefined;
    // Base Camera is used for clip-space HUDs and has no projection builder.
    // Convert its authored WebGL clip-depth range for this draw, then restore
    // it, rather than asking native WebGPU to call a nonexistent method.
    if (typeof (camera as Camera & { updateProjectionMatrix?: unknown }).updateProjectionMatrix !== 'function'
      && camera.coordinateSystem !== this.coordinateSystem) {
      if (camera.coordinateSystem !== WebGLCoordinateSystem || this.coordinateSystem !== WebGPUCoordinateSystem || this.reversedDepthBuffer)
        throw new Error('The WebGPU adapter cannot preserve this custom camera projection.');
      projection = this.projectionFrames[this.projectionDepth] ??= { projection: new Matrix4(), inverse: new Matrix4(), coordinateSystem: camera.coordinateSystem };
      this.projectionDepth++;
      projection.projection.copy(camera.projectionMatrix); projection.inverse.copy(camera.projectionMatrixInverse);
      projection.coordinateSystem = camera.coordinateSystem;
      camera.coordinateSystem = WebGPUCoordinateSystem;
      camera.projectionMatrix.premultiply(webGLToWebGPUProjection);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    // WebGPU shadows recurse through renderer.render after its main render list
    // captures the engine's proxies. Let that internal pass use those same
    // proxies; suspending/rebuilding them invalidates the captured render list.
    const dispatch: typeof this.render = (nestedScene, nestedCamera) => {
      if (!('overrideMaterial' in nestedScene)
        || !(nestedScene.overrideMaterial as Material & { isShadowPassMaterial?: boolean } | null)?.isShadowPassMaterial)
        return draw.call(this, nestedScene, nestedCamera);
      const interrupted = this.activeObject;
      try { this.nativeDraw.call(this, nestedScene, nestedCamera); }
      finally {
        // A shadow draw rewrites BatchedMesh's camera-dependent indirect data.
        // Restore the interrupted main batch before its actual GPU submission.
        if (interrupted?.[0] instanceof BatchedMesh) {
          const [object, outerScene, outerCamera, geometry, material] = interrupted;
          Reflect.apply(BatchedMesh.prototype.onBeforeRender, object, [this, outerScene, outerCamera, geometry, material]);
        }
      }
    };
    this.render = dispatch;
    try { this.nativeDraw.call(this, scene, camera); }
    finally {
      if (this.render === dispatch) this.render = draw;
      if (projection) {
        camera.projectionMatrix.copy(projection.projection); camera.projectionMatrixInverse.copy(projection.inverse);
        camera.coordinateSystem = projection.coordinateSystem; this.projectionDepth--;
      }
    }
  }

  override renderObject(...args: Parameters<NativeWebGPURenderer['renderObject']>): void {
    const previous = this.activeObject;
    this.activeObject = args;
    try { this.renderObjectWithCallbacks(...args); }
    finally { this.activeObject = previous; }
  }

  private renderObjectWithCallbacks(...args: Parameters<NativeWebGPURenderer['renderObject']>): void {
    const [object, scene, camera, geometry, material, group] = args;
    if (!(material as Material & { isShadowPassMaterial?: boolean }).isShadowPassMaterial) {
      if ((material as Material & { isShaderMaterial?: boolean }).isShaderMaterial || material.onBeforeCompile !== Material.prototype.onBeforeCompile)
        throw new Error('WebGPU compatibility: custom GLSL shaders require WebGL.');
      if (material.dithering || (object as Object3D & { isPoints?: boolean }).isPoints)
        throw new Error('WebGPU compatibility: material dithering and authored point primitives require WebGL.');
      const mesh = object as Object3D & { customDepthMaterial?: Material; customDistanceMaterial?: Material };
      const shadowPrototype = object instanceof BatchedMesh ? BatchedMesh.prototype : Object3D.prototype;
      if (mesh.customDepthMaterial || mesh.customDistanceMaterial
        || object.onBeforeShadow !== shadowPrototype.onBeforeShadow || object.onAfterShadow !== shadowPrototype.onAfterShadow)
        throw new Error('WebGPU compatibility: custom WebGL shadow passes require WebGL.');
    }
    if (material.onBeforeRender === Material.prototype.onBeforeRender
      || (scene.overrideMaterial as Material & { isShadowPassMaterial?: boolean } | null)?.isShadowPassMaterial) {
      super.renderObject(...args);
      return;
    }
    // Native WebGPU does not call material.onBeforeRender. The engine uses it
    // to hide the local head for the eye camera while retaining full shadows.
    // Invoke it after the authored object callback, matching WebGL ordering.
    const before = object.onBeforeRender;
    const bridge: typeof before = function(this: Object3D, ...objectArgs) {
      before.apply(this, objectArgs);
      Reflect.apply(material.onBeforeRender, material, [objectArgs[0], scene, camera, geometry, object, group]);
    };
    object.onBeforeRender = bridge;
    try { super.renderObject(...args); }
    finally { if (object.onBeforeRender === bridge) object.onBeforeRender = before; }
  }

  prototypeDiagnostics() {
    const backend = this.backend as unknown as BackendDiagnostics;
    const info = backend.device?.adapterInfo;
    return {
      availability: prototypeWebGPUAvailability(),
      initialized: (this as unknown as InternalRenderer)._initialized,
      webgpu: backend.isWebGPUBackend === true,
      compatibilityMode: backend.compatibilityMode ?? null,
      requestedSamples: this.requestedSamples,
      actualSamples: (this as unknown as InternalRenderer)._samples,
      alpha: this.alpha,
      outputColorSpace: this.outputColorSpace,
      outputBufferType: this.getOutputBufferType(),
      toneMapping: this.toneMapping,
      toneMappingExposure: this.toneMappingExposure,
      shadowEnabled: this.shadowMap.enabled,
      shadowType: this.shadowMap.type,
      frameId: (this as unknown as InternalRenderer)._nodes?.nodeFrame.frameId ?? null,
      materialCallbackBridge: true,
      classicMaterialOutput: true,
      outputPostPass: false,
      pipelineCache: this.pipelineRetention?.stats() ?? null,
      commandBundles: this.commandBundles?.stats() ?? null,
      uniformUploads: this.uniformUploads ? { ...this.uniformUploads.stats } : null,
      adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device,
        description: info.description, isFallbackAdapter: info.isFallbackAdapter } : null,
      features: backend.device?.features ? [...backend.device.features] : [],
      errors: [...this.failures],
      errorCount: this.failureCount,
      deviceLost: (this as unknown as InternalRenderer)._isDeviceLost === true,
    };
  }

  override async dispose(): Promise<void> {
    renderers.delete(this); this.commandBundles?.dispose(); this.uniformUploads?.dispose(); this.pipelineRetention?.dispose();
    await super.dispose();
  }
}

/** The worker awaits this after synchronous createView and before its first
 * update, so normal game views do not need asynchronous constructor changes. */
export async function initializeRenderers(): Promise<void> {
  await Promise.all([...renderers].map(renderer => renderer.init()));
}

/** Call once per engine update, before its world, shadow and HUD draws. */
export function beginRendererFrame(): void {
  for (const renderer of renderers) renderer.beginPrototypeFrame();
}

export function rendererDiagnostics() {
  return [...renderers].map(renderer => renderer.prototypeDiagnostics());
}

export { initializeRenderers as initializePrototypeRenderers, beginRendererFrame as beginPrototypeFrame, rendererDiagnostics as prototypeRendererDiagnostics };
