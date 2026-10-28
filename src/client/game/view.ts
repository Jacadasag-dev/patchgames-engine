/// <reference path="../../shared/env.d.ts" />
import bootstrapUrl from './viewFrame.js?url&no-inline';
import { conformViewInfo } from '../../shared/shapes.ts';
import type { ReviewCamera } from '../../shared/gameApi.ts';
import { PHYSICS_DEBUG } from './diagnostics.ts';
import { ViewFrameDeadline } from './viewDeadline.ts';
import { createGameAudio } from './audio.ts';
import { loadTextureAsset, loadSoundAsset } from './mediaAssets.ts';
import { VIEW_RENDERER_HEADER, readViewRendererBundle } from '../../shared/rendererBundle.ts';
import { RendererLoadingSelection, rendererDeviceIdentity, rendererSelectionCache, type RendererLoadingReport } from './rendererLoading.ts';
import { createSandboxRendererDriver, type RendererReplayFrame } from './rendererDriver.ts';
import { RendererReplayRecorder, rendererReplayQuality } from './rendererReplay.ts';
import { FrameProfile } from './frameProfile.ts';
import type { GameUiDocument } from '../../shared/gameUi.ts';
import { validateGameUi } from '../../shared/gameUiLayout.ts';
import {sceneEpoch} from './scenePresentation.ts';
import type {GameSceneSnapshot} from '../../shared/gameScenes.ts';

// The game's 3D view, sandboxed. It runs in a Web Worker created inside an
// iframe with `sandbox="allow-scripts"` (an opaque origin: no access to this
// page, its storage or cookies) and a content security policy with no
// network access at all. It draws to its own canvas, which the page shows
// under the locked HTML UI. The iframe ignores the mouse; the page reads
// input itself. Only one frame runs at a time. While it runs, the page keeps
// one replaceable latest frame to send on acknowledgment, so slow views never
// accumulate old work or wait an extra display interval before continuing.

const DEV_VIEW_URL = '/@game/view.js';
// Capture before editor/lobby routing updates the address during Play.
const FRAME_PROFILE_ENABLED=typeof location!=='undefined'&&new URLSearchParams(location.search).has('frameprofile');

function browserSupportsWebGPU(): boolean {
  return typeof navigator !== 'undefined' && typeof (navigator as Navigator & {
    gpu?: { requestAdapter?: unknown };
  }).gpu?.requestAdapter === 'function';
}

/** Host/worker acknowledgments, not GPU presentation. Compare snapshots over
 * a warmed interval for completion FPS; counters reset whenever the view reloads. */
export interface ViewTimingStats {
  readonly sampledAtMs: number;
  readonly pageFrames: number;
  readonly submittedFrames: number;
  readonly completedFrames: number;
  readonly coalescedFrames: number;
  readonly lastRoundTripMs: number | null;
  readonly pendingAgeMs: number | null;
}

function frameDocument(): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  // Embedded Rapier WASM needs compilation, but JavaScript eval and all network
  // access remain forbidden. The opaque iframe and worker still isolate visuals.
  const policy = `default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' blob:; worker-src blob: data:; style-src 'unsafe-inline'`;
  return [
    '<!doctype html>',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    // Same color scheme as the page, or the browser paints the frame white until the first frame is drawn.
    '<meta name="color-scheme" content="dark">',
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%}</style>',
    '<canvas></canvas>',
    // srcdoc inherits Discord's CSP, which forbids our inline script. Load the
    // locked bootstrap as a separate same-origin asset, retaining our nonce
    // restriction so the untrusted worker cannot import network scripts.
    `<script nonce="${nonce}" src="${bootstrapUrl}"></script>`,
  ].join('');
}

export class GameViewHost {
  private snapshot:((image:string|null)=>void)|undefined;
  private readonly container: HTMLElement;
  private code: Promise<string>;
  private readonly defaultCode: Promise<string>;
  private iframe: HTMLIFrameElement | null = null;
  private ready = false;
  private readonly frameDeadline = new ViewFrameDeadline();
  private lastDrawTime: number | undefined;
  private latestDraw: { frame: unknown; reviewCamera?: ReviewCamera | null } | undefined;
  private pageFrames = 0;
  private submittedFrames = 0;
  private completedFrames = 0;
  private coalescedFrames = 0;
  private submittedAt: number | undefined;
  private lastRoundTripMs: number | null = null;
  private capturingFrame = false;
  private renderWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  private latestInfo: Record<string, number> = {};
  private latestUi: GameUiDocument | null = null;
  private latestUiJson: string | null | undefined;
  private currentSceneEpoch = '';
  onUiChange: ((ui: GameUiDocument | null) => void) | undefined;
  private errorWindow = 0;
  private errorsInWindow = 0;
  private diagnosticLabel: HTMLElement | null = null;
  private diagnosticUpdatedAt = 0;
  private frameProfile:FrameProfile|undefined;
  private profilePanel:HTMLElement|undefined;
  private profileText:HTMLElement|undefined;
  private profileUpdated=0;
  private profileSize='';
  onFrameProfileStart:(()=>void)|undefined;
  private motionReading:Record<string,number>|undefined;
  get samplingFrames(){return this.frameProfile?.active===true;}
  recordMotion(stats:Record<string,number>|undefined){this.motionReading=stats;
    if(stats&&this.frameProfile?.active)this.frameProfile.value('serverPatchAgeMs',stats.serverPatchAgeMs);}
  private readonly messageListener = (event: MessageEvent) => this.onMessage(event);
  private audio = createGameAudio({ resolveSource: loadSoundAsset });
  private readonly unlockAudio = () => { void this.audio.resume(); };
  private mediaRequests = 0;
  private selectedCode: Promise<string> | undefined;
  private rendererSelection: RendererLoadingSelection<RendererReplayFrame>;
  private rendererReport: RendererLoadingReport = { backend: 'webgl', source: 'baseline', reason: 'Loading the existing renderer.', candidates: [], metrics: {}, metric: 'gpu-completed-frame-latency' };
  private rendererQuality = 'engine-bundle-settings';
  private rendererWorkload = 'no-replay';
  private rendererBundleHash: string | undefined;
  private rendererRecorder: RendererReplayRecorder | undefined;
  private rendererReplayPhase: unknown;
  private rendererGeneration = 0;
  private preparingRenderer = false;
  private rendererHasRendered = false;
  private calibrationAllowed: (() => boolean) | undefined;
  private loadingChanges: ((listener: () => void) => () => void) | undefined;

  constructor(container: HTMLElement, archivedCode?: string) {
    this.container = container;
    this.rendererSelection = new RendererLoadingSelection({ cache: rendererSelectionCache(), identity: rendererDeviceIdentity,
      supportsBackend: backend => backend === 'webgl' || browserSupportsWebGPU(),
      environment: () => this.rendererEnvironment(),
      createDriver: (code, backend, signal) => createSandboxRendererDriver({ container: this.container, code, backend,
        documentSource: frameDocument(), conditions: this.rendererEnvironment() }, signal),
      subscribeEnvironmentChanges: listener => {
        document.addEventListener('visibilitychange', listener); window.addEventListener('resize', listener);
        const observer = new ResizeObserver(listener); observer.observe(this.container);
        const stopLoadingChanges = this.loadingChanges?.(listener);
        return () => { stopLoadingChanges?.(); observer.disconnect(); document.removeEventListener('visibilitychange', listener); window.removeEventListener('resize', listener); };
      } });
    if(FRAME_PROFILE_ENABLED){
      const profile=this.frameProfile=new FrameProfile(),panel=this.profilePanel=document.createElement('aside');
      panel.style.cssText='position:fixed;right:12px;top:120px;z-index:200;background:#111e;color:white;padding:10px;font:12px monospace;max-width:470px;max-height:65vh;overflow:auto';
      const start=document.createElement('button'),stop=document.createElement('button'),text=this.profileText=document.createElement('pre');
      start.textContent='Start frame sample';stop.textContent='Stop frame sample';
      start.onclick=()=>{this.onFrameProfileStart?.();profile.start(performance.now());this.profileSize=`${this.container.clientWidth}x${this.container.clientHeight}@${window.devicePixelRatio}`;};
      stop.onclick=()=>{profile.stop();this.showProfile();};panel.append(start,stop,text);document.body.append(panel);
      this.showProfile();
    }
    if (PHYSICS_DEBUG) {
      this.diagnosticLabel = document.createElement('aside');
      this.diagnosticLabel.dataset.testid = 'physics-diagnostics';
      this.diagnosticLabel.style.cssText = 'position:fixed;bottom:64px;left:16px;z-index:100;pointer-events:none;white-space:pre-line;background:var(--hud-bg);color:var(--hud-text);padding:10px 14px;border:1px solid var(--hud-border);border-radius:8px;font:12px/1.6 monospace;max-width:360px';
      document.body.append(this.diagnosticLabel);
    }
    const url = typeof __GAME_VIEW_URL__ === 'string' ? __GAME_VIEW_URL__ : DEV_VIEW_URL;
    this.code = archivedCode !== undefined ? Promise.resolve(archivedCode) : fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`The game view did not build:\n${await response.text()}`);
      return response.text();
    });
    this.code.catch((error) => console.error(`[game view] ${error instanceof Error ? error.message : error}`));
    this.defaultCode = this.code;
    window.addEventListener('pointerdown', this.unlockAudio);
    window.addEventListener('keydown', this.unlockAudio);
    window.addEventListener('message', this.messageListener);
    this.start();
  }

  /** The numbers the view last reported (its info()), for the game's controls. */
  get info(): Record<string, number> {
    return this.latestInfo;
  }
  /** Validated host-rendered UI from this renderer, independent of view info. */
  get ui(): GameUiDocument | null { return this.latestUi; }
  get timingStats(): ViewTimingStats {
    const now = performance.now();
    return { sampledAtMs: now, pageFrames: this.pageFrames, submittedFrames: this.submittedFrames,
      completedFrames: this.completedFrames, coalescedFrames: this.coalescedFrames,
      lastRoundTripMs: this.lastRoundTripMs, pendingAgeMs: this.submittedAt === undefined ? null : Math.max(0, now - this.submittedAt) };
  }
  /** Host diagnostics. Acknowledgement timings are never labelled displayed FPS. */
  get rendererStatus(): RendererLoadingReport { return this.rendererReport; }
  get rendererReplayStatus(): { status: string; reason: string | null } {
    return { status: this.rendererRecorder?.status ?? 'inactive', reason: this.rendererRecorder?.reason ?? null };
  }
  /** A completed replay may wait through provisional lobby roster changes. */
  canCalibrateRenderer(frame: unknown): boolean {
    const replay = this.rendererRecorder?.replay;
    if (this.preparingRenderer || !replay || !this.rendererBundleHash) return false;
    const environment = this.rendererEnvironment();
    return environment.visible && replay.conditions.qualityHash === rendererReplayQuality(frame)
      && replay.conditions.width === environment.width && replay.conditions.height === environment.height
      && replay.conditions.pixelRatio === environment.pixelRatio;
  }

  private rendererEnvironment() {
    const bounds = this.container.getBoundingClientRect?.();
    const inViewport = !bounds || bounds.top >= 0 && bounds.left >= 0
      && bounds.bottom <= window.innerHeight && bounds.right <= window.innerWidth;
    return { width: Math.max(1, this.container.clientWidth), height: Math.max(1, this.container.clientHeight),
      pixelRatio: window.devicePixelRatio || 1, qualityHash: this.rendererQuality,
      workloadHash: this.rendererWorkload, visible: inViewport && !document.hidden && this.container.clientWidth > 0
        && this.container.clientHeight > 0 && (this.calibrationAllowed?.() ?? true) };
  }

  private async selectRendererCode(code: string, compare = false): Promise<string> {
    // Archived/headerless views retain their existing startup path and protocol.
    if (!code.startsWith(VIEW_RENDERER_HEADER)) {
      this.rendererBundleHash = undefined; this.rendererRecorder = undefined;
      this.rendererReport = { backend: 'webgl', source: 'baseline', reason: 'Legacy bundle; keeping its existing renderer.', candidates: [], metrics: {}, metric: 'gpu-completed-frame-latency' };
      return code;
    }
    const generation = this.rendererGeneration;
    const recording = this.rendererRecorder?.replay;
    const environment = this.rendererEnvironment();
    const catalog = readViewRendererBundle(code)?.catalog;
    const bundleIdentity = catalog?.alternativeHashes.webgpu ? `${catalog.payloadHash}:${catalog.alternativeHashes.webgpu}` : catalog?.payloadHash;
    const usable = compare && recording && bundleIdentity === this.rendererBundleHash
      && recording.conditions.qualityHash === environment.qualityHash
      && recording.conditions.width === environment.width && recording.conditions.height === environment.height
      && recording.conditions.pixelRatio === environment.pixelRatio;
    this.rendererWorkload = usable ? recording.conditions.workloadHash : 'no-replay';
    const replay = usable ? { warmup: recording.frames.slice(0, recording.warmupFrames),
      samples: recording.frames.slice(recording.warmupFrames),
      checkpoints: [], checkpointSampleIndices: recording.checkpointIndices.map(index => index - recording.warmupFrames) } : undefined;
    const selected = await this.rendererSelection.prepare(code, replay);
    if (generation !== this.rendererGeneration) throw new Error('Renderer loading was replaced.');
    if (this.rendererBundleHash !== selected.bundle?.gameHash) this.rendererRecorder = undefined;
    this.rendererBundleHash = selected.bundle?.gameHash;
    this.rendererReport = selected.report;
    const needsRecording = selected.report.candidates.filter(candidate => candidate.eligible).length > 1
      && selected.report.source !== 'cache' && selected.report.source !== 'calibration';
    if (needsRecording) {
      if (compare && this.rendererRecorder?.status === 'abandoned') this.rendererRecorder = undefined;
      this.rendererRecorder ??= new RendererReplayRecorder();
    }
    else this.rendererRecorder = undefined;
    return selected.code;
  }

  /** Called by core launch/preview code before handing control to the player.
   * First visits without a representative recording retain the baseline. */
  async prepareRenderer(frame: unknown, allowCalibration: boolean | (() => boolean) = true,
    subscribeLoadingChanges?: (listener: () => void) => () => void): Promise<void> {
    this.rendererReplayPhase = undefined;
    const requestedGeneration = this.rendererGeneration;
    const code = await this.code;
    if (requestedGeneration !== this.rendererGeneration) throw new Error('Renderer loading was replaced.');
    const catalog = readViewRendererBundle(code)?.catalog;
    // There is no experiment to run when the engine ships only its baseline.
    // Leave the already-starting worker alone; no redundant canvas/shader rebuild.
    if (!browserSupportsWebGPU() || !catalog || catalog.candidates.filter(candidate => candidate.available && candidate.bundle !== null
      && candidate.evidence.compatibility === 'passed' && candidate.evidence.visualParity === 'passed'
      && candidate.evidence.stability === 'passed').length < 2) return;
    this.rendererGeneration++; this.rendererSelection.cancel();
    this.preparingRenderer = true;
    this.rendererHasRendered = false;
    this.calibrationAllowed = typeof allowCalibration === 'function' ? allowCalibration : undefined;
    this.loadingChanges = subscribeLoadingChanges;
    this.clearUi();
    const generation = this.rendererGeneration;
    this.rendererQuality = rendererReplayQuality(frame) ?? 'engine-bundle-settings';
    // Stop the previous view while measuring so two renderers never compete.
    this.iframe?.contentWindow?.postMessage({ type: 'dispose' }, '*');
    this.iframe?.remove(); this.iframe = null; this.ready = false;
    try {
      const selected = this.selectRendererCode(code, typeof allowCalibration === 'function' ? allowCalibration() : allowCalibration);
      this.selectedCode = selected;
      await selected;
      if (generation === this.rendererGeneration) this.start();
    } finally { if (generation === this.rendererGeneration) { this.preparingRenderer = false; this.calibrationAllowed = undefined; this.loadingChanges = undefined; } }
  }
  loadGame(code?: string): void {
    this.rendererGeneration++; this.rendererSelection.cancel(); this.selectedCode = undefined;
    this.rendererHasRendered = false;
    this.rendererReplayPhase = undefined;
    this.preparingRenderer = false; this.calibrationAllowed = undefined; this.loadingChanges = undefined;
    this.code = code === undefined ? this.defaultCode : Promise.resolve(code);
    this.latestInfo = {};
    this.start();
  }

  capture():Promise<string>{
    if(!this.ready||!this.iframe?.contentWindow)return Promise.reject(new Error('Wait for the preview to finish loading.'));
    this.snapshot?.(null);
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.snapshot=undefined;reject(new Error('Could not capture the preview. Try again.'));},3000);
      this.snapshot=image=>{clearTimeout(timeout);this.snapshot=undefined;image?resolve(image):reject(new Error('Could not capture the preview. Try again.'));};
      this.iframe!.contentWindow!.postMessage({type:'snapshot'},'*');
    });
  }
  /** Capture exactly this accepted simulation state after its render ack. */
  async captureFrame(frame: unknown, reviewCamera?: ReviewCamera | null): Promise<string> {
    if (this.capturingFrame) throw new Error('A preview photo is already being prepared.');
    if (!this.ready || !this.iframe?.contentWindow) throw new Error('Wait for the preview to finish loading.');
    const iframe = this.iframe;
    this.capturingFrame = true;
    this.latestDraw = undefined;
    try {
      await this.waitForRendered();
      if (this.iframe !== iframe || !this.sendFrame(frame, reviewCamera)) throw new Error('The preview changed before the photo was ready.');
      await this.waitForRendered();
      if (this.iframe !== iframe) throw new Error('The preview changed before the photo was ready.');
      return await this.capture();
    } finally { this.capturingFrame = false; }
  }
  private waitForRendered(): Promise<void> {
    if (!this.frameDeadline.pending) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearInterval(timer); this.renderWaiter = undefined;
        if (error) reject(error); else resolve();
      };
      const timer = setInterval(() => {
        if (this.frameDeadline.expired(performance.now())) finish(new Error('The preview frame exceeded its time limit.'));
      }, 50);
      this.renderWaiter = { resolve: () => finish(), reject: error => finish(error) };
    });
  }
  dispose(): void {
    this.clearUi();
    this.rendererGeneration++; this.rendererSelection.cancel(); this.rendererRecorder = undefined;
    this.latestDraw = undefined;
    this.submittedAt = undefined;
    this.frameDeadline.stop();
    this.renderWaiter?.reject(new Error('The preview was closed before the photo was ready.'));
    this.snapshot?.(null);
    window.removeEventListener('message', this.messageListener);
    window.removeEventListener('pointerdown', this.unlockAudio);
    window.removeEventListener('keydown', this.unlockAudio);
    this.audio.dispose();
    this.iframe?.contentWindow?.postMessage({ type: 'dispose' }, '*');
    this.iframe?.remove(); this.iframe = null; this.ready = false;
    this.diagnosticLabel?.remove();
    this.profilePanel?.remove();
  }

  /** Draw now or replace the one latest frame waiting behind an active draw. */
  draw(frame: unknown, reviewCamera?: ReviewCamera | null): void {
    this.observeScene(frame);
    if(this.frameProfile?.active){
      if(document.hidden||this.profileSize!==`${this.container.clientWidth}x${this.container.clientHeight}@${window.devicePixelRatio}`)this.frameProfile.stop('Interrupted: hidden or resized');
      else this.frameProfile.interval('pageFrameMs',performance.now());
    }
    this.pageFrames++;
    if (!this.capturingFrame) this.sendFrame(frame, reviewCamera, true);
  }
  private sendFrame(frame: unknown, reviewCamera?: ReviewCamera | null, useRenderDelta = false): boolean {
    this.observeScene(frame);
    // Keep networking and simulation alive in hidden tabs, but never enqueue
    // another GPU draw. Explicit renderer preparation and captures still run.
    if (useRenderDelta && document.hidden) {
      this.latestDraw = undefined;
      this.lastDrawTime = undefined;
      return false;
    }
    if (this.preparingRenderer || !this.iframe?.contentWindow) return false;
    if (!this.ready) {
      if (useRenderDelta) this.latestDraw = { frame, reviewCamera };
      return false;
    }
    const now = performance.now();
    if (this.frameDeadline.pending) {
      if (this.frameDeadline.expired(now)) {
        console.error('[game view] stopped responding; restarting it');
        if (this.rendererReport.backend !== 'webgl') this.rendererSelection.invalidate();
        if (!this.fallbackAtStartup()) this.start();
      } else if (useRenderDelta) {
        if (this.latestDraw) this.coalescedFrames++;
        this.latestDraw = { frame, reviewCamera };
      }
      return false;
    }
    const timing = frame as { now?: unknown; dt?: unknown } | null;
    const drawTime = useRenderDelta && typeof timing?.now === 'number' && Number.isFinite(timing.now)
      && typeof timing.dt === 'number' && Number.isFinite(timing.dt) && timing.dt > 0 ? timing.now : undefined;
    // A busy worker skips page frames. Cameras and animations must advance by
    // the time between accepted draws, not just the latest page-frame interval.
    // Frozen frames and exact captures retain their supplied delta and reset
    // this clock, as do callers that start a new presentation timeline.
    if (drawTime !== undefined && this.lastDrawTime !== undefined && drawTime >= this.lastDrawTime) {
      frame = { ...timing, dt: Math.min(0.1, (drawTime - this.lastDrawTime) / 1000) };
    }
    this.frameDeadline.start(now);
    try {
      this.iframe.contentWindow.postMessage({
        type: 'frame',
        frame,
        reviewCamera,
        width: Math.max(1, this.container.clientWidth),
        height: Math.max(1, this.container.clientHeight),
        pixelRatio: window.devicePixelRatio || 1,
        ...(this.frameProfile?.active?{frameProfile:true}:{}),
      }, '*');
    } catch (error) {
      this.frameDeadline.stop();
      throw error;
    }
    this.lastDrawTime = drawTime;
    this.submittedAt = now;
    this.submittedFrames++;
    if (useRenderDelta && this.rendererRecorder) {
      const phase = (frame as { phase?: unknown } | null)?.phase;
      if (phase === 'fighting' && this.rendererReplayPhase !== 'fighting'
        && (this.rendererRecorder.status === 'abandoned'
          || this.rendererRecorder.replay && this.rendererRecorder.qualityHash !== rendererReplayQuality(frame))) {
        this.rendererRecorder = new RendererReplayRecorder();
      }
      this.rendererReplayPhase = phase;
      this.rendererRecorder.observe({ frame, reviewCamera }, this.rendererEnvironment());
    }
    return true;
  }

  private start(): void {
    this.clearUi();
    this.audio.dispose(); this.audio = createGameAudio({ resolveSource: loadSoundAsset });
    this.mediaRequests = 0;
    this.renderWaiter?.reject(new Error('The preview was restarted before the photo was ready.'));
    this.snapshot?.(null);
    this.iframe?.contentWindow?.postMessage({ type: 'dispose' }, '*');
    this.iframe?.remove();
    this.ready = false;
    this.frameDeadline.stop();
    this.lastDrawTime = undefined;
    this.latestDraw = undefined;
    this.pageFrames = this.submittedFrames = this.completedFrames = this.coalescedFrames = 0;
    this.submittedAt = undefined;
    this.lastRoundTripMs = null;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.dataset.testid = 'game-view';
    iframe.srcdoc = frameDocument();
    this.iframe = iframe;
    this.container.append(iframe);
  }

  private onMessage(event: MessageEvent): void {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    const data = event.data as { type?: unknown; info?: unknown; message?: unknown; image?: unknown; ready?: unknown; gpuCompleted?: unknown };
    if (data?.type === 'audio') {
      const {sceneEpoch:receivedScene,...sound}=event.data as Record<string,unknown>;
      if(receivedScene===this.currentSceneEpoch||receivedScene===undefined&&this.currentSceneEpoch==='')this.audio.handle(sound);
      return;
    }
    if (data?.type === 'media-request') {
      const request = event.data as { requestId?: unknown; id?: unknown };
      if (!Number.isSafeInteger(request.requestId) || typeof request.id !== 'string' || request.id.length > 120) return;
      const target = this.iframe.contentWindow!, requestId = request.requestId;
      if (this.mediaRequests >= 16) { target.postMessage({ type: 'media-response', requestId, error: 'Too many pending media requests' }, '*'); return; }
      this.mediaRequests++;
      void loadTextureAsset(request.id).then(source => {
        if (this.iframe?.contentWindow === target) target.postMessage({ type: 'media-response', requestId, source }, '*');
      }, error => {
        if (this.iframe?.contentWindow === target) target.postMessage({ type: 'media-response', requestId, error: String(error instanceof Error ? error.message : error).slice(0, 300) }, '*');
      }).finally(() => { if (this.iframe?.contentWindow === target) this.mediaRequests--; });
      return;
    }
    if(data?.type==='snapshot'){this.snapshot?.(typeof data.image==='string'&&data.image.startsWith('data:image/png;base64,')&&data.image.length<4_000_000?data.image:null);return;}
    if (data?.type === 'ready') {
      const generation = this.rendererGeneration;
      this.selectedCode ??= this.code.then(code => {
        if (generation !== this.rendererGeneration) throw new Error('Renderer loading was replaced.');
        return this.selectRendererCode(code);
      });
      void this.selectedCode.then((code) => {
        if (event.source !== this.iframe?.contentWindow) return;
        this.iframe.contentWindow!.postMessage({ type: 'init', code, backend: this.rendererReport.backend }, '*');
        this.ready = true;
        const latest = this.latestDraw; this.latestDraw = undefined;
        if (latest) this.sendFrame(latest.frame, latest.reviewCamera, true);
      }).catch(error => { if (event.source === this.iframe?.contentWindow) this.reportError(String(error)); });
    } else if ((data?.type === 'terrain-preparing' || data?.type === 'media-preparing') && typeof data.ready === 'boolean') {
      this.frameDeadline.terrainReady(data.ready, performance.now());
    } else if (data?.type === 'rendered') {
      // Old-route acknowledgements release the frame slot, but never restore its UI or camera info.
      const receivedScene=(data as {sceneEpoch?:unknown}).sceneEpoch;
      const current=receivedScene===this.currentSceneEpoch||receivedScene===undefined&&this.currentSceneEpoch==='';
      if (current&&Object.prototype.hasOwnProperty.call(data, 'ui')) this.acceptUi((data as { ui?: unknown }).ui);
      if(this.frameProfile?.active){
        this.frameProfile.interval('completedFrameMs',performance.now());
        const profile=(data as {frameProfile?:{prepareMs?:number;updateMs?:number}}).frameProfile;
        if(profile){this.frameProfile.value('workerPrepareMs',profile.prepareMs!);this.frameProfile.value('workerUpdateMs',profile.updateMs!);}
        if(this.submittedAt!==undefined)this.frameProfile.value('workerRoundTripMs',performance.now()-this.submittedAt);
        if(performance.now()-this.profileUpdated>=1000)this.showProfile();
      }
      if (this.submittedAt !== undefined) {
        if (this.rendererReport.backend === 'webgl' || data.gpuCompleted === true) this.rendererHasRendered = true;
        this.lastRoundTripMs = Math.max(0, performance.now() - this.submittedAt);
        this.completedFrames++;
        this.submittedAt = undefined;
      }
      this.frameDeadline.stop();
      this.renderWaiter?.resolve();
      if(current)this.latestInfo = conformViewInfo(data.info);
      if (this.diagnosticLabel && performance.now() - this.diagnosticUpdatedAt > 250) {
        this.diagnosticUpdatedAt = performance.now();
        const info = this.latestInfo;
        this.diagnosticLabel.textContent = 'PHYSICS DEBUG · development\nCyan: rendered collider · Pink: latest server\nGreen: terrain normal\n'
          + `Arena builds: ${info.arenaBuilds ?? 0} · Bodies: ${info.debugBodies ?? 0}\n`
          + `Largest position gap: ${(info.debugGap ?? 0).toFixed(3)} units\nGap includes network delay and interpolation.`;
      }
      const latest = this.latestDraw;
      this.latestDraw = undefined;
      if (latest && !this.capturingFrame) this.sendFrame(latest.frame, latest.reviewCamera, true);
    } else if (data?.type === 'error') {
      this.renderWaiter?.reject(new Error(String(data.message).slice(0, 500)));
      this.reportError(String(data.message).slice(0, 500));
      if (this.rendererReport.backend !== 'webgl') {
        this.rendererSelection.invalidate();
        this.fallbackAtStartup();
      }
    }
  }
  private showProfile(){
    this.profileUpdated=performance.now();
    if(this.profileText&&this.frameProfile)this.profileText.textContent=JSON.stringify({backend:this.rendererReport.backend,
      viewport:`${this.container.clientWidth}x${this.container.clientHeight}`,pixelRatio:window.devicePixelRatio||1,
      ...(this.motionReading?{motion:this.motionReading}:{}),
      ...this.frameProfile.report(performance.now())},(_key,value)=>typeof value==='number'?Math.round(value*100)/100:value,2);
  }

  private fallbackAtStartup(): boolean {
    if (this.rendererReport.backend === 'webgl' || this.rendererHasRendered) return false;
    this.rendererSelection.invalidate();
    this.rendererReport = { ...this.rendererReport, backend: 'webgl', source: 'baseline', metrics: {},
      reason: 'The selected renderer failed before its first frame; loading the WebGL baseline.' };
    this.selectedCode = this.code.then(code => readViewRendererBundle(code)?.payload ?? code);
    this.start();
    return true;
  }

  private reportError(message: string): void {
    const now = Date.now();
    if (now - this.errorWindow > 5000) {
      this.errorWindow = now;
      this.errorsInWindow = 0;
    }
    if (++this.errorsInWindow <= 3) console.error(`[game view] ${message}`);
  }

  private clearUi(): void {
    this.latestUiJson = undefined;
    if (this.latestUi === null) return;
    this.latestUi = null;
    this.publishUi();
  }

  private observeScene(frame:unknown):void{
    const key=sceneEpoch((frame as {scene?:GameSceneSnapshot}|null)?.scene);
    if(key===this.currentSceneEpoch)return;
    this.currentSceneEpoch=key;this.latestInfo={};this.lastDrawTime=undefined;this.clearUi();this.audio.stopScene();
  }

  private acceptUi(value: unknown): void {
    if (value === this.latestUiJson) return;
    let document: GameUiDocument | null = null;
    try {
      if (value !== null) {
        if (typeof value !== 'string' || value.length > 131_072) throw new Error('Invalid UI transport payload');
        document = validateGameUi(JSON.parse(value));
      }
    } catch (error) { this.reportError(`Invalid game UI: ${error instanceof Error ? error.message : String(error)}`); }
    this.latestUiJson = typeof value === 'string' || value === null ? value : undefined;
    if (document === null && this.latestUi === null) return;
    this.latestUi = document;
    this.publishUi();
  }

  private publishUi(): void {
    try { this.onUiChange?.(this.latestUi); }
    catch (error) { this.reportError(`Host UI update failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
