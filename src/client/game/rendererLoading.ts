import { readViewRendererBundle } from '../../shared/rendererBundle.ts';
import { calibrateRenderers, type RendererCalibrationDriver, type RendererCalibrationOptions, type RendererCalibrationResult } from './rendererCalibration.ts';
import { isRendererEligible, RendererSelectionCache, selectRenderer, type RendererBackend,
  type RendererCandidate, type RendererConditions, type RendererSelectionDecision } from './rendererSelection.ts';

export interface RendererBundleChoice extends RendererCandidate { readonly code: string | null; readonly reason: string }
export interface ResolvedRendererBundle {
  readonly gameHash: string;
  readonly engineVersion: string;
  readonly candidates: readonly RendererBundleChoice[];
}
export interface RendererLoadingReport {
  readonly backend: RendererBackend;
  readonly source: 'baseline' | 'compatibility' | 'cache' | 'calibration';
  readonly reason: string;
  readonly candidates: readonly { backend: RendererBackend; eligible: boolean; reason: string }[];
  readonly metrics: RendererSelectionDecision['metrics'];
  readonly metric: 'gpu-completed-frame-latency';
  readonly calibration?: Pick<RendererCalibrationResult, 'status' | 'rejected' | 'reason'>;
}

export async function resolveRendererBundle(code: string): Promise<ResolvedRendererBundle | null> {
  const bundle = readViewRendererBundle(code);
  if (!bundle) return null;
  // The header is data, never authority. Its digest is checked before cache use;
  // candidate eligibility comes only from the host's engine qualification table.
  const digest = async (payload: string) => {
    const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const [hash, gpuHash] = await Promise.all([digest(bundle.payload),
    bundle.alternatives.webgpu ? digest(bundle.alternatives.webgpu) : Promise.resolve(undefined)]);
  if (hash !== bundle.catalog.payloadHash) return null;
  if (gpuHash !== bundle.catalog.alternativeHashes.webgpu) return null;
  return { gameHash: gpuHash ? `${hash}:${gpuHash}` : hash, engineVersion: bundle.catalog.engineRevision,
    candidates: bundle.catalog.candidates.map(candidate => ({ ...candidate,
      code: candidate.bundle === 'self' ? bundle.payload : candidate.bundle === 'webgpu' ? bundle.alternatives.webgpu ?? null : null })) };
}

export interface RendererDeviceIdentity {
  device: string;
  browser: string;
  /** A redacted adapter family can identify this page's environment without
   * claiming a physical device identity suitable for persistent storage. */
  persistent?: boolean;
}
export interface RendererIdentityRequest { webgpu: boolean; signal?: AbortSignal }
const IDENTITY_TIMEOUT_MS = 1200;
interface IdentityAdapter {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string; isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
  features?: Iterable<string>;
  limits?: object;
}

function adapterIdentity(adapter: IdentityAdapter | null): { value: unknown; persistent: boolean } | null {
  const info = adapter?.info;
  // Some privacy modes expose only a vendor/architecture. That cannot identify
  // which physical adapter was chosen on a multi-GPU device, so do not persist.
  if (!adapter || !info
    || adapter.isFallbackAdapter || info.isFallbackAdapter
    || /swiftshader|llvmpipe|software/i.test(info.description ?? '') || !adapter.features || !adapter.limits) return null;
  const fields = [info.vendor ?? '', info.architecture ?? '', info.device ?? '', info.description ?? ''];
  if (fields.some(field => typeof field !== 'string' || field.length > 1024)) return null;
  const persistent = Boolean(fields[2].trim() || fields[3].trim());
  if (!persistent && !(fields[0].trim() && fields[1].trim())) return null;
  const features = [...adapter.features].sort();
  if (features.length > 256 || features.some(feature => typeof feature !== 'string' || feature.length > 128)) return null;
  const limits = adapter.limits as Record<string, unknown>;
  const names = new Set([...Object.keys(limits), ...Object.getOwnPropertyNames(Object.getPrototypeOf(limits) ?? {})]);
  const values = [...names].sort().filter(name => typeof limits[name] === 'number' && Number.isFinite(limits[name]))
    .map(name => [name, limits[name]]);
  if (!values.length || values.length > 128) return null;
  return { value: { info: fields, features, limits: values }, persistent };
}

function boundedIdentity(work: Promise<RendererDeviceIdentity | null>, signal?: AbortSignal): Promise<RendererDeviceIdentity | null> {
  return new Promise((resolve, reject) => {
    const finish = (value: RendererDeviceIdentity | null) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(value); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => finish(null), IDENTITY_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // Adapter requests cannot be cancelled by the browser API. Late results are
    // observed and discarded; they can never install a stale loading decision.
    work.then(finish, () => finish(null));
  });
}

/** Local only. No fingerprint or benchmark data is sent to a server. If the
 * browser hides either adapter identity, do not persist hardware-dependent wins.
 * Recheck at loading boundaries so a hybrid GPU/power switch changes the key. */
export async function rendererDeviceIdentity(request: RendererIdentityRequest = { webgpu: true }): Promise<RendererDeviceIdentity | null> {
  request.signal?.throwIfAborted();
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    if (!gl || !debug) return null;
    const renderer = String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
    const vendor = String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL));
    if (!renderer || /swiftshader|llvmpipe|software/i.test(renderer)) return null;
    const webgl = [vendor, renderer, gl.getParameter(gl.VERSION)];
    const browser = navigator.userAgent;
    if (!request.webgpu) return { device: JSON.stringify(webgl), browser };
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(options: {
      powerPreference: 'high-performance' | 'low-power' | undefined; featureLevel: string; xrCompatible: boolean;
    }): Promise<IdentityAdapter | null> } }).gpu;
    if (!gpu) return null;
    return await boundedIdentity((async () => {
      // Three's production backend uses compatibility mode with XR disabled.
      // The bundle may choose any standard power preference, so fingerprint all
      // three choices; the game hash distinguishes which preference it uses.
      const preferences = [undefined, 'high-performance', 'low-power'] as const;
      const adapters = await Promise.all(preferences.map(async powerPreference => adapterIdentity(await gpu.requestAdapter({
        powerPreference, featureLevel: 'compatibility', xrCompatible: false,
      }))));
      if (adapters.some(adapter => adapter === null)) return null;
      const bytes = new TextEncoder().encode(JSON.stringify({ webgl, webgpu: adapters.map(adapter => adapter!.value) }));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const device = 'renderer-device-2:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return { device, browser, ...(adapters.every(adapter => adapter!.persistent) ? {} : { persistent: false }) };
    })(), request.signal);
  } catch { /* Unsupported or privacy-restricted browser: use an uncached selection. */ }
  finally { gl?.getExtension('WEBGL_lose_context')?.loseContext(); }
  request.signal?.throwIfAborted();
  return null;
}

export function rendererSelectionCache(): RendererSelectionCache {
  try { return new RendererSelectionCache(window.localStorage); }
  catch { return new RendererSelectionCache(null); }
}

// Shared only by hosts in this page. Reuse the bounded/expiring/evidence-checked
// cache policy, but never write partial physical identities to localStorage or
// sessionStorage. A navigation ends this cache. Current adapters are still
// probed before every lookup, so changed families/capabilities get a new key.
let sessionRecord: { key: string; value: string } | undefined;
const sessionSelectionCache = new RendererSelectionCache({
  getItem: key => sessionRecord?.key === key ? sessionRecord.value : null,
  setItem: (key, value) => { sessionRecord = value.length <= 512_000 ? { key, value } : undefined; },
  removeItem: key => { if (sessionRecord?.key === key) sessionRecord = undefined; },
});

export interface RendererLoadingOptions<Frame> {
  cache: RendererSelectionCache;
  identity(request: RendererIdentityRequest): RendererDeviceIdentity | null | Promise<RendererDeviceIdentity | null>;
  /** A definite browser API absence can reject a candidate before recording or
   * calibration. The isolated worker remains authoritative about actual support. */
  supportsBackend?(backend: RendererBackend): boolean;
  environment(): RendererConditions & { visible: boolean };
  createDriver(code: string, backend: RendererBackend, signal: AbortSignal): Promise<RendererCalibrationDriver<Frame>>;
  subscribeEnvironmentChanges?: RendererCalibrationOptions<Frame>['subscribeEnvironmentChanges'];
  /** Dependency injection belongs to host tests, never authored game metadata. */
  resolveBundle?: (code: string) => Promise<ResolvedRendererBundle | null>;
}

/** Invoked at an engine loading boundary. The returned code stays pinned until
 * the next boundary; the frame loop and watchdog never call this selector. */
export class RendererLoadingSelection<Frame> {
  private readonly options: RendererLoadingOptions<Frame>;
  private controller: AbortController | undefined;
  constructor(options: RendererLoadingOptions<Frame>) { this.options = options; }
  cancel(): void { this.controller?.abort(); }
  invalidate(): void { this.options.cache.invalidate(); sessionSelectionCache.invalidate(); }

  async prepare(code: string, replay?: RendererCalibrationOptions<Frame>['replay']): Promise<{
    code: string; report: RendererLoadingReport; bundle: ResolvedRendererBundle | null;
  }> {
    this.cancel();
    const controller = new AbortController(); this.controller = controller;
    let bundle: ResolvedRendererBundle | null = null;
    try { bundle = await (this.options.resolveBundle ?? resolveRendererBundle)(code); }
    catch { /* Digest/privacy failures retain the existing executable baseline. */ }
    controller.signal.throwIfAborted();
    const baseline: RendererLoadingReport = { backend: 'webgl', source: 'baseline', reason: 'Legacy or unverified bundle; keeping its existing renderer.',
      candidates: [], metrics: {}, metric: 'gpu-completed-frame-latency' };
    if (!bundle) return { code, report: baseline, bundle };
    let candidates = bundle.candidates.map(candidate => {
      const supported = this.options.supportsBackend?.(candidate.backend) !== false;
      return { ...candidate, available: candidate.available && candidate.code !== null && supported,
        reason: supported ? candidate.reason : 'This browser does not expose the required renderer API.' };
    });
    let identity: RendererDeviceIdentity | null = null;
    try { identity = await this.options.identity({ webgpu: candidates.some(candidate => candidate.backend === 'webgpu' && isRendererEligible(candidate)),
      signal: controller.signal }); }
    catch { /* Identity is advisory; privacy restrictions must not prevent loading. */ }
    controller.signal.throwIfAborted();
    // Adapter lookup can span resize, display or game-quality changes. Read the
    // current conditions only after it settles, before consulting cached wins.
    const environment = this.options.environment();
    const key = identity ? { ...identity, gameBundleHash: bundle.gameHash, engineVersion: bundle.engineVersion,
      width: environment.width, height: environment.height, pixelRatio: environment.pixelRatio, qualityHash: environment.qualityHash } : null;
    const cache = identity?.persistent === false ? sessionSelectionCache : this.options.cache;
    let decision = key ? cache.get(key, candidates) : null;
    let source: RendererLoadingReport['source'] = decision ? 'cache' : 'compatibility';
    let calibration: RendererLoadingReport['calibration'];
    if (!decision && candidates.filter(isRendererEligible).length > 1 && replay) {
      const result = await calibrateRenderers({ replay, signal: controller.signal,
        environment: this.options.environment, subscribeEnvironmentChanges: this.options.subscribeEnvironmentChanges,
        candidates: candidates.filter(isRendererEligible).map(candidate => ({ backend: candidate.backend,
          create: signal => this.options.createDriver(candidate.code!, candidate.backend, signal) })) });
      controller.signal.throwIfAborted();
      calibration = { status: result.status, rejected: result.rejected, ...(result.reason ? { reason: result.reason } : {}) };
      if (result.status === 'complete' && result.measurements.length === candidates.filter(isRendererEligible).length) {
        candidates = candidates.map(candidate => ({ ...candidate,
          measurement: result.measurements.find(measurement => measurement.backend === candidate.backend) }));
        decision = selectRenderer(candidates);
        source = 'calibration';
      }
      // Invalid/partial comparisons are never cached. A hidden tab, failed
      // readback, resize or timeout gets another opportunity at the next load.
    }
    decision ??= selectRenderer(candidates);
    const chosen = candidates.find(candidate => candidate.backend === decision!.backend && isRendererEligible(candidate));
    if (!chosen?.code) return { code, report: { ...baseline, reason: 'No qualified replacement; retaining the existing baseline.' }, bundle };
    if (key && source !== 'cache') cache.set(key, decision, candidates);
    return { code: chosen.code, bundle, report: { backend: chosen.backend, source,
      reason: decision.reason, metrics: decision.metrics, metric: 'gpu-completed-frame-latency',
      ...(calibration ? { calibration } : {}),
      candidates: candidates.map(candidate => ({ backend: candidate.backend, eligible: isRendererEligible(candidate), reason: candidate.reason })) } };
  }
}
