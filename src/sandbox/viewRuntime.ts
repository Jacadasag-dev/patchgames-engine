import {replaceMaterialRecipes,readMaterialRecipes} from '../shared/materialRegistry.ts';
import type { CreateView, GameView, InspectionFocus, ReviewCamera, TuningValues, ViewFrame } from '../shared/gameApi.ts';
import { beginViewRenderProfile, captureViewDiagnostics, composeViewDiagnostics, endViewRenderProfile } from './viewDiagnostics.ts';
import { beginEnvironmentFrame, endEnvironmentFrame, environmentInspection, resetEnvironmentRuntime } from './environmentRuntime.ts';
import { beginInspectionFrame, endInspectionFrame, recordInspectionCoverage, recordInspectionOverlap, recordInspectionEquipment } from './inspectionTelemetry.ts';
import { collectInspectionGeometry } from './inspectionGeometry.ts';
import { createEquipmentOrientationSampler } from './equipmentOrientation.ts';
import { beginInspectionCameraFrame, endInspectionCameraFrame } from './inspectionCamera.ts';
import { terrainInterestsFor } from './terrainWorld.ts';
import { settleMediaSources, mediaSourceInfo } from './media.ts';
import { settleSurfaceMaterials, surfaceMaterialLoadingInfo } from './surfaceMaterialView.ts';
import { configureSoundTransport, setSoundPresentationTime } from './audio.ts';
import { beginSoundCameraFrame, endSoundCameraFrame, installSoundCameraTracking, registerSoundViewCamera, resetSoundCameraTracking } from './audioListener.ts';
import { installRenderPerformance } from './renderPerformance.ts';
import { beginRenderedFrame, completeRenderedFrame, hasRendererSubmission, applyRenderedFrameBackpressure } from './renderCompletion.ts';

// Runs in the game view's Web Worker, inside a sandboxed iframe with no
// network. Draws a frame whenever the page sends one and answers with the
// view's info() numbers. The page checks everything it gets back.

type AnyView = GameView<unknown, unknown, TuningValues>;

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

const MAX_ERRORS_PER_SECOND = 2;

export function start(createView: CreateView<unknown, unknown, TuningValues>, initialize?: () => Promise<void>): void {
  const scope = globalThis as unknown as WorkerScope;
  let sceneEpoch='';
  configureSoundTransport(message => scope.postMessage({...message,...(sceneEpoch?{sceneEpoch}:{})}));
  resetEnvironmentRuntime();
  resetSoundCameraTracking(); installSoundCameraTracking();
  installRenderPerformance();
  let view: AnyView | null = null;
  let size = '';
  let errorWindow = 0;
  let errorsInWindow = 0;
  let completionFrames = 0;
  let terrainReadyOnce=false;
  let uiAt = -Infinity;
  let uiJson: string | null | undefined;
  const equipmentOrientation = createEquipmentOrientationSampler();
  const ready = () => scope.postMessage({ type: 'ready', focusCamera: !!(view?.setInspectionFocus && view?.inspectionFocus) });

  const report = (what: string, error: unknown) => {
    const now = Date.now();
    if (now - errorWindow > 1000) {
      errorWindow = now;
      errorsInWindow = 0;
    }
    if (++errorsInWindow > MAX_ERRORS_PER_SECOND) return;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    scope.postMessage({ type: 'error', message: `${what}: ${message}`.slice(0, 500) });
  };

  // Errors and warnings the view logs itself (three.js reports shader
  // compile failures this way) reach the page, and so the players' feedback
  // reports, like everything else the page logs.
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      report(`console.${level}`, args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
      original(...args);
    };
  }

  scope.onmessage = async (event) => {
    const message = event.data as
      | {type:'material-recipes';materials:Record<string,unknown>}
      | { type: 'init'; canvas: OffscreenCanvas }
      | { type: 'frame'; frame: ViewFrame<unknown, unknown, TuningValues>; width: number; height: number; pixelRatio: number; reviewCamera?: ReviewCamera | null; inspectionFocus?: InspectionFocus | null; inspection?: boolean; inspectionAtMs?: number; inspectionDetails?: boolean; inspectionProfile?: boolean; gpuCompletion?: boolean; gpuStartup?: boolean; gpuWarmup?: boolean };
    if(message.type==='material-recipes'){try{replaceMaterialRecipes(readMaterialRecipes(JSON.stringify({version:1,materials:message.materials})));}catch(error){report('Material update failed',error);}return;}
    if (message.type === 'init') {
      if (initialize) {
        void initialize().then(() => { view = createView(message.canvas); registerSoundViewCamera(view); ready(); }).catch(error => report('createView', error));
        return;
      }
      try {
        view = createView(message.canvas);
        registerSoundViewCamera(view);
        ready();
      } catch (error) {
        report('createView failed', error);
      }
      return;
    }
    if (message.type !== 'frame') return;
    const nextSceneEpoch=message.frame.scene?`${message.frame.scene.id}:${message.frame.scene.sequence}`:'';
    if(nextSceneEpoch!==sceneEpoch){sceneEpoch=nextSceneEpoch;uiAt=-Infinity;uiJson=undefined;}
    beginRenderedFrame();
    let mediaPreparing = mediaSourceInfo().mediaPending + surfaceMaterialLoadingInfo().pending > 0;
    const finishMediaPreparation = () => {
      if (mediaPreparing) { scope.postMessage({ type: 'media-preparing', ready: true }); mediaPreparing = false; }
    };
    if (mediaPreparing) {
      scope.postMessage({ type: 'media-preparing', ready: false });
      await Promise.all([settleMediaSources(), settleSurfaceMaterials()]);
    }
    let info: unknown = null;
    let ui: string | null | undefined;
    const inspecting = message.inspection === true;
    const liveProfiling='frameProfile' in message&&message.frameProfile===true;
    const profiling = inspecting && message.inspectionProfile === true;
    const liveStart=liveProfiling?performance.now():0;let preparationMs=0;
    beginViewRenderProfile(profiling);
    const started = profiling ? performance.now() : 0;
    let updated = started, geometryCollected = started, equipmentCollected = started;
    const inspectionTime = message.inspectionAtMs ?? message.frame.now;
    setSoundPresentationTime(inspecting ? inspectionTime : undefined);
    beginSoundCameraFrame(!!message.reviewCamera, message.frame.spectator?.targetId ?? message.frame.players?.find(player => player.isLocal)?.id);
    beginEnvironmentFrame(inspectionTime);
    if (inspecting) {
      beginInspectionFrame(inspectionTime, message.frame.phase === 'ended');
      beginInspectionCameraFrame(inspectionTime, message.frame.players?.find(player => player.isLocal)?.id, !!message.reviewCamera);
    }
    if (view) {
      try {
        const nextSize = `${message.width}x${message.height}@${message.pixelRatio}`;
        if (nextSize !== size) {
          size = nextSize;
          view.resize(message.width, message.height, message.pixelRatio);
        }
        view.setReviewCamera?.(message.reviewCamera ?? null);
        if (message.inspectionFocus && !view.setInspectionFocus) throw new Error('This view does not support automatic inspection focus.');
        view.setInspectionFocus?.(message.inspectionFocus ?? null);
        if (view.terrainWorld) {
          const terrainStarted=liveProfiling?performance.now():0;
          view.terrainWorld.sync(message.frame.tuning, message.frame.world);
          const interests = terrainInterestsFor(message.frame.players), preparationStart = performance.now();
          if (!view.terrainWorld.prepared(message.frame.tuning, interests)) {
            const background=view.terrainWorld.backgroundPreparation&&terrainReadyOnce&&!inspecting;
            // Asset loading and terrain share one bounded preparation allowance.
            if (!background&&!mediaPreparing) scope.postMessage({ type: 'terrain-preparing', ready: false });
            try {
              let prepared = false;
              for (let chunk = 0; chunk < (background?1:128) && performance.now() - preparationStart < 20_000; chunk++) {
                  const progress=background&&view.terrainWorld.prepareFrame
                    ?view.terrainWorld.prepareFrame(message.frame.tuning,interests)
                    :view.terrainWorld.prepare(message.frame.tuning, interests);
                  if (progress.ready) { prepared = true; break; }
              }
              if (!prepared&&!background) throw new Error('Terrain view preparation exceeded its bounded chunk/time budget; this frame has incomplete coverage.');
              if(prepared)terrainReadyOnce=true;
            } finally { if (!background&&!mediaPreparing) scope.postMessage({ type: 'terrain-preparing', ready: true }); }
          }else terrainReadyOnce=true;
          if(liveProfiling)preparationMs=performance.now()-terrainStarted;
        }
        finishMediaPreparation();
        view.update(message.frame);
        info = view.info?.() ?? null;
      } catch (error) {
        report('view update failed', error);
      }
    }
    const uiTime = inspecting ? inspectionTime : performance.now();
    if (view?.ui && uiTime - uiAt >= 100) {
      uiAt = uiTime;
      let next: string | null = null;
      try {
        const document = view.ui(message.frame);
        if (document != null) {
          const encoded = JSON.stringify(document);
          if (typeof encoded !== 'string' || encoded.length > 131_072 || new TextEncoder().encode(encoded).byteLength > 131_072)
            throw new Error('UI document exceeds its 128 KiB transport limit');
          next = encoded;
        }
      } catch (error) { report('view UI failed', error); }
      if (next !== uiJson) { uiJson = next; ui = next; }
    }
    finishMediaPreparation();
    endSoundCameraFrame();
    try { endEnvironmentFrame(inspectionTime); } catch (error) { report('environment update failed', error); }
    // Always answer, so the page knows the worker is alive and sends the next frame.
    if (profiling) updated = performance.now();
    const liveUpdateMs=liveProfiling?performance.now()-liveStart:0;
    const renderTiming = endViewRenderProfile();
    let inspection, focusInspection, telemetry, gameplayCamera;
    if (inspecting) {
      try {
        const geometry = collectInspectionGeometry({ timeMs: inspectionTime });
        for (const overlap of geometry.overlaps) recordInspectionOverlap(overlap);
        for (const coverage of geometry.coverage) recordInspectionCoverage(coverage);
      } catch {
        recordInspectionCoverage({ check: 'geometry', status: 'unsupported', reason: 'Automatic geometry collection failed.' });
      }
      if (profiling) geometryCollected = performance.now();
      try {
        // Sample the final displayed pose after animation and hand placement.
        // This runs for every inspection frame, never in ordinary gameplay.
        const orientation = equipmentOrientation.sample({ timeMs: inspectionTime });
        for (const item of orientation.items) recordInspectionEquipment(item);
        for (const coverage of orientation.coverage) recordInspectionCoverage(coverage);
      } catch {
        recordInspectionCoverage({ check: 'equipment-orientation', status: 'unsupported', reason: 'Automatic equipment orientation collection failed.' });
      }
      if (profiling) equipmentCollected = performance.now();
      telemetry = endInspectionFrame();
      gameplayCamera = endInspectionCameraFrame();
    }
    if (inspecting && message.inspectionDetails !== false && view) {
      try {
        const environment = environmentInspection();
        const read = view.inspection?.bind(view);
        inspection = environment.profilesActive ? captureViewDiagnostics(() => composeViewDiagnostics(read,
          [{ id: 'shared.environment', read: () => environment }])) : captureViewDiagnostics(read);
      }
      catch (error) { inspection = captureViewDiagnostics(() => { throw error; }); }
      try { focusInspection = captureViewDiagnostics(view.inspectionFocus?.bind(view)); }
      catch (error) { focusInspection = captureViewDiagnostics(() => { throw error; }); }
    }
    // Materials first encountered during update request another frame. The next
    // frame waits for their maps before rendering, including terrain atlases.
    const sources = mediaSourceInfo(), surfaces = surfaceMaterialLoadingInfo();
    const mediaInfo = { ...sources, mediaPending: sources.mediaPending + surfaces.pending,
      mediaErrors: sources.mediaErrors + surfaces.errors, surfaceMaterialPending: surfaces.pending, surfaceMaterialErrors: surfaces.errors };
    let gpuCompleted = false;
    const completeGpu = message.gpuCompletion === true || message.gpuStartup === true && hasRendererSubmission();
    if (completeGpu) {
      // Cold pipeline compilation can outlast a steady-state frame timeout.
      // Loading warmup may discover more pipelines as cameras/actors move.
      // Timed samples stay tightly bounded; steady gameplay never drains the
      // queue or changes interpolation.
      try { gpuCompleted = await completeRenderedFrame({ timeoutMs: completionFrames++ === 0 || message.gpuWarmup === true ? 12000 : 3000 }); }
      catch (error) { report('GPU frame completion failed', error); }
    } else {
      // Keep at most two GPU submissions pending so a fast CPU cannot build
      // input latency in the GPU queue. WebGL retains its synchronous fast path;
      // WebGPU still overlaps CPU work with the preceding GPU frame.
      try { const pendingGpu = applyRenderedFrameBackpressure(); if (pendingGpu) await pendingGpu; }
      catch (error) { report('GPU frame scheduling failed', error); }
    }
    scope.postMessage({ type: 'rendered', ...(sceneEpoch?{sceneEpoch}:{}), ...(ui !== undefined ? { ui } : {}), ...(liveProfiling?{frameProfile:{prepareMs:preparationMs,updateMs:liveUpdateMs}}:{}), ...(completeGpu ? { gpuCompleted } : {}), info: Object.values(mediaInfo).some(Boolean) ? { ...(info && typeof info === 'object' ? info : {}), ...mediaInfo } : info, ...(inspection ? {inspection} : {}), ...(focusInspection ? {focusInspection} : {}), ...(telemetry ? {telemetry} : {}), ...(gameplayCamera ? {gameplayCamera} : {}),
      ...(profiling ? { inspectionProfile: { ...renderTiming, updateMs: updated - started, geometryMs: geometryCollected - updated,
        equipmentMs: equipmentCollected - geometryCollected, diagnosticsMs: performance.now() - equipmentCollected } } : {}) });
  };
}
