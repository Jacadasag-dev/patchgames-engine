/// <reference path="../../shared/env.d.ts" />
import { loadQuickJS, LOGIC_ENTRIES, Sandbox, SandboxError } from '../../sandbox/host/quickjs.ts';
import { conform, conformEvents, conformInput, conformLines, parseGameInfo, type GameInfo } from '../../shared/shapes.ts';
import { stateSchemas } from '../../shared/schema.ts';
import type { GameEvent, PointerState } from '../../shared/gameApi.ts';
import type { GameTagId } from '../../shared/gameTags.ts';
import {statePathValue} from '../../shared/statePaths.ts';
import { TerrainPreparationClient } from './terrainPreparation.ts';
import type { MatchInterest } from '../../sandbox/host/match.ts';
import { validateTerrainPreparedWorld, type TerrainPreparedWorld } from '../../sandbox/terrainWorld.ts';
import type { TerrainPreparationHeader } from '../../sandbox/preparationTransfer.ts';
import {terrainPreparationReuse} from '../../sandbox/preparationTransfer.ts';

// The game's logic in the page: the same QuickJS sandbox the server uses,
// for the parts that must run locally (turning buttons into inputs,
// predicting the local fighter, the HUD's info text). Everything it answers
// is checked before the page uses it, and a failing call changes nothing.

const DEV_LOGIC_URL = '/@game/logic.js';
const INPUT_MS = 8;
const PREDICT_MS = 4;
// The first prediction initializes native bodies; legacy bundles also install
// their immutable scene here. Later predictions keep the four-ms allowance.
const FIRST_PREDICT_MS = 100;
const ADOPT_TERRAIN_MS = 20;
const TERRAIN_LOADING_MS = 30_000;
const HUD_MS = 8;
const MAX_INFO_LINES = 3;
const MAX_INFO_CHARS = 60;
const ERROR_QUIET_MS = 5000;

export interface ButtonState {
  ui?: import('../../shared/gameUi.ts').GameUiEvent[];
  values?: Record<string, number>;
  held: string[];
  taps: string[];
  pointer: PointerState;
}

/** One seat as the local prediction step sees it, in server index order. */
export interface PredictedParticipant {
  state: Record<string, unknown>;
  hp: number;
  maxHp: number;
  active: boolean;
  classId: string;
  team?: number;
}

/** What one local step of the game's real `step` produced for the local fighter. */
export interface PredictedStep {
  /** The engine-reconciled numeric fields. */
  predicted: Record<string, number>;
  /** Every other scalar field, as the step left it: shown as-is until the server's state replaces it. */
  overlay: Record<string, unknown>;
  /** The step's events involving the local fighter: provisional until the server's state confirms them. */
  events: GameEvent[];
}

export class ClientLogic {
  private firstPrediction = true;
  readonly info: GameInfo;
  readonly Input: ReturnType<typeof stateSchemas>['Input'];
  /** Whether this bundle's runtime can run the game's real step locally (older bundles predict through their own step). */
  readonly wholeStep: boolean;
  private readonly source: string;
  private sandbox: Sandbox;
  private readonly lastError = new Map<string, number>();
  private preparation: TerrainPreparationClient | undefined;
  private terrainKey = '';
  private adoptedTerrainKey = '';
  private metadataTerrainKey = '';
  private terrainTuning: unknown;
  private terrainWorld: unknown;
  private terrainInterests: readonly MatchInterest[] = [];
  private terrainGeneration = 0;
  private terrainTimer: ReturnType<typeof setTimeout> | undefined;
  private terrainJob: 'metadata' | 'adoption' | undefined;
  private terrainSwitchPending=false;
  private predictionAttempts=0;
  private terrainBlockedPredictions=0;
  private terrainBlockStarted:number|undefined;
  private terrainBlockedMs=0;
  private terrainLongestBlockMs=0;
  private terrainAdoptions=0;
  private terrainLocalEdits=0;
  private terrainLocalEditFallbacks=0;
  private failedLocalTerrainKey='';
  private pendingTerrainCache: { key: string; cache: TerrainPreparedWorld } | undefined;
  private activatedTerrainCache:TerrainPreparedWorld|undefined;
  private preparationFailed = false;
  private disposed = false;
  private readonly asyncTerrain: boolean;
  private readonly stagedTerrain: boolean;

  private constructor(source: string) {
    this.source = source;
    this.sandbox = this.newSandbox();
    this.info = parseGameInfo(this.sandbox.call('describe', null, 250).value);
    this.Input = stateSchemas(this.info).Input;
    this.wholeStep = this.sandbox.hasEntry('predictStep') && !this.info.legacyPredictionStep;
    this.asyncTerrain = !!this.info.terrainConstraints && this.sandbox.hasEntry('exportPreparation')
      && this.sandbox.hasEntry('adoptPreparation') && this.sandbox.hasEntry('preparationReady');
    this.stagedTerrain = ['prepareTerrainMetadata', 'beginPreparation', 'appendPreparation', 'finishPreparation', 'activatePreparation']
      .every(entry => this.sandbox.hasEntry(entry));
    if (this.asyncTerrain) this.startPreparation();
  }

  static async load(customSource?: string): Promise<ClientLogic> {
    const [source] = await Promise.all([
      customSource ?? (typeof __GAME_LOGIC__ === 'string' ? __GAME_LOGIC__ : fetch(DEV_LOGIC_URL).then(async (response) => {
        if (!response.ok) throw new Error(`The game module did not build:\n${await response.text()}`);
        return response.text();
      })),
      loadQuickJS(),
    ]);
    return new ClientLogic(source);
  }
  dispose(): void { this.disposed = true; this.cancelTerrainJob(); this.preparation?.dispose(); this.sandbox.dispose(); }

  /** This fixed step's input from the buttons, and which taps the game used. */
  writeInput(buttons: ButtonState, frame: unknown): { input: Record<string, number | boolean>; consumed: string[] } {
    // Collision readiness gates prediction, never capture of the player's
    // controls. Keep sending real inputs while the background worker catches up.
    this.prepareFrame(frame);
    const result = this.call<{ input?: unknown; consumed?: unknown }>('writeInput', { ...buttons, frame }, INPUT_MS);
    const consumed = Array.isArray(result?.consumed) ? result.consumed.filter((name): name is string => buttons.taps.includes(name)) : [];
    return { input: conformInput(result?.input, this.info.input), consumed };
  }

  /** Predicted values of the prediction fields after one input, or null if the game failed. */
  predict(state: Record<string, unknown>, input: unknown, dt: number, opponent: unknown, tuning: unknown, world: unknown, opponents?: readonly unknown[], mode = this.info.mode): Record<string, number> | null {
    if (!this.predictionTerrain(tuning, world, this.interests([state]))) return null;
    const budget = this.firstPrediction ? FIRST_PREDICT_MS : PREDICT_MS;
    this.firstPrediction = false;
    const result = this.call<Record<string, unknown>>('predict', { state, input, dt, opponent, opponents, tuning, world, mode }, budget);
    if (!result || typeof result !== 'object') return null;
    const predicted: Record<string, number> = {};
    for (const field of this.info.predictionFields) {
      const value = statePathValue(result,field);
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      predicted[field] = value;
    }
    return predicted;
  }

  /** Runs the game's real step for one local input: the reconciled numeric fields, the local fighter's
   * other scalar fields as the step left them, and the step's events involving the local fighter.
   * Null if the game failed or answered outside its declared shapes. */
  predictStep(players: readonly PredictedParticipant[], local: number, input: unknown, dtMs: number, elapsedMs: number,
    tuning: unknown, world: unknown, mode = this.info.mode, tags: readonly GameTagId[] = []): PredictedStep | null {
    const state = players[local]?.state;
    if (!state || !this.predictionTerrain(tuning, world, this.interests([state]))) return null;
    const budget = this.firstPrediction ? FIRST_PREDICT_MS : PREDICT_MS;
    this.firstPrediction = false;
    const result = this.call<{ state?: unknown; events?: unknown }>('predictStep', { players, local, input, dtMs, elapsedMs, tuning, world, mode, tags }, budget);
    if (!result || typeof result !== 'object') return null;
    let answer: Record<string, unknown>;
    try {
      answer = conform(result.state, this.info.player, 'predictStep.state') as Record<string, unknown>;
    } catch (error) {
      this.report('predictStep', `[game] prediction answered outside its shapes: ${error instanceof Error ? error.message : String(error)}`, true);
      return null;
    }
    const predicted: Record<string, number> = {};
    for (const field of this.info.predictionFields) {
      const value = statePathValue(answer, field);
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      predicted[field] = value;
    }
    const overlay: Record<string, unknown> = {};
    for (const field of this.info.predictionOverlayFields) overlay[field] = statePathValue(answer, field);
    const events = conformEvents(result.events, players.length).filter(event => event.player === local || event.target === local);
    return { predicted, overlay, events };
  }

  /** Plain text for the HUD's info slot. */
  hudLines(frame: unknown): string[] {
    this.prepareFrame(frame);
    if (this.preparationFailed) return ['Terrain could not load. Rejoin this match.'];
    return conformLines(this.call('hudLines', frame, HUD_MS), MAX_INFO_LINES, MAX_INFO_CHARS);
  }

  private call<T>(entry: string, arg: unknown, deadlineMs: number): T | undefined {
    try {
      const { value, logs } = this.sandbox.call<T>(entry, arg, deadlineMs);
      for (const line of logs.slice(0, 5)) this.report(`${entry}:log`, `[game] ${line}`, false);
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.report(entry, `[game] ${message.split('\n').slice(0, 3).join('\n')}`, true);
      // Out of memory leaves nothing worth keeping: start over with a fresh sandbox.
      if (error instanceof SandboxError && /out of memory/.test(message)) this.restart();
      return undefined;
    }
  }

  private restart(): void {
    this.cancelTerrainJob();
    this.terrainSwitchPending=false;
    this.firstPrediction = true;
    this.sandbox.dispose();
    this.sandbox = this.newSandbox();
    this.adoptedTerrainKey = '';
    this.activatedTerrainCache=undefined;
    this.metadataTerrainKey = '';
    this.preparation?.dispose();
    if (this.asyncTerrain) this.startPreparation();
  }

  private newSandbox(): Sandbox {
    return new Sandbox(this.source, LOGIC_ENTRIES, {}, undefined, ['predictStep', 'exportPreparation', 'adoptPreparation', 'preparationReady', 'terrainIdentity', 'prepareTerrainMetadata',
      'beginPreparation', 'reusePreparation', 'appendPreparation', 'finishPreparation', 'activatePreparation','importCollisionChunk','prepareLocalEdits']);
  }

  private startPreparation(): void {
    this.preparationFailed = false;
    try {
      this.preparation = new TerrainPreparationClient(this.source, (key, cache) => {
        if (this.disposed || key !== this.terrainKey) return;
        try {
          const validated = validateTerrainPreparedWorld(cache);
          const expected = (this.terrainWorld as { terrainRevision?: unknown } | null)?.terrainRevision;
          if (typeof expected === 'string' && expected && validated.revision !== expected)
            throw new Error('Prepared terrain differs from the authoritative world revision');
          if (this.stagedTerrain) {
            if(this.info.terrainPrefetch)this.preparation?.cancelQueued(key);
            if (this.metadataTerrainKey !== key) this.pendingTerrainCache = { key, cache: validated };
            else this.adoptTerrainInStages(key, validated);
            return;
          }
          const result = this.sandbox.call<{ ready: boolean; revision: string }>('adoptPreparation',
            { tuning: this.terrainTuning, world: this.terrainWorld, cache: validated }, ADOPT_TERRAIN_MS).value;
          if (!result?.ready || result.revision !== validated.revision) throw new Error('Prepared terrain adoption did not confirm its revision');
          this.adoptedTerrainKey = key;
          this.activatedTerrainCache=validated;
          this.firstPrediction = true;
        } catch (error) { this.failPreparation(error); }
      }, error => this.failPreparation(error));
    } catch (error) { this.failPreparation(error); }
  }

  private failPreparation(error: unknown): void {
    this.cancelTerrainJob();
    this.preparationFailed = true;
    this.preparation?.dispose();
    this.report('preparation', `[game] ${error instanceof Error ? error.message : String(error)}`, true);
  }

  private cancelTerrainJob(): void {
    this.terrainGeneration++;
    clearTimeout(this.terrainTimer);
    this.terrainTimer = undefined;
    this.terrainJob = undefined;
    this.pendingTerrainCache = undefined;
  }

  /** One bounded sandbox call per browser task. Revision changes, disposal and
   * replacement worker replies invalidate every remaining callback. */
  private runTerrainJob(key: string, kind: 'metadata' | 'adoption', step: () => boolean, complete: () => void, maxCalls=512): void {
    this.cancelTerrainJob();
    const generation = this.terrainGeneration, deadline = Date.now() + TERRAIN_LOADING_MS;
    let calls = 0;
    this.terrainJob = kind;
    const advance = () => {
      if (this.disposed || this.preparationFailed || generation !== this.terrainGeneration || key !== this.terrainKey) return;
      this.terrainTimer = undefined;
      try {
        if (++calls > maxCalls || Date.now() >= deadline) throw new Error('Terrain loading stages exceeded their time or work limit');
        const done = step();
        if (Date.now() >= deadline) throw new Error('Terrain loading stages exceeded their time limit');
        if (done) { this.terrainJob = undefined; complete(); }
        else this.terrainTimer = setTimeout(advance, 0);
      } catch (error) { this.failPreparation(error); }
    };
    this.terrainTimer = setTimeout(advance, 0);
  }

  private adoptTerrainInStages(key: string, cache: TerrainPreparedWorld): void {
    const reuse=this.sandbox.hasEntry('reusePreparation')?terrainPreparationReuse(this.activatedTerrainCache,cache):undefined;
    const importCollisionChunks=this.sandbox.hasEntry('importCollisionChunk');
    const background=this.info.terrainPrefetch&&(this.adoptedTerrainKey===key||!!reuse);
    const id = this.terrainGeneration + 1;
    const context = structuredClone({ tuning: this.terrainTuning, world: this.terrainWorld });
    const chunks = cache.streamed?.chunks ?? [];
    const fields = [...cache.scene.terrain ? [cache.scene.terrain] : [], ...cache.scene.terrainChunks ?? []];
    const colliders = cache.scene.colliders;
    const header: TerrainPreparationHeader = { version: 1, revision: cache.revision, loadedRevision: cache.loadedRevision, checksum: cache.checksum,
      streamedRevision: cache.streamed?.revision, collisionRevision: cache.collisionRevision,
      sceneKind: cache.scene.terrainChunks ? cache.scene.terrain ? 'both' : 'chunks' : cache.scene.terrain ? 'terrain' : 'none',
      counts: { chunks: chunks.length, heightfieldChunks: fields.length, staticColliders: colliders.length, eager: Number(!!cache.eager) } };
    // The host validated the complete cache and checksum before staging. The
    // guest still verifies its own source/tuning identity before adoption, and
    // the native bridge validates the assembled collision scene at activation.
    function* phases(): Generator<{ entry: string; arg: unknown; final?: boolean }> {
      if(reuse)yield{entry:'reusePreparation',arg:{id,...context,header,reuse}};
      else {
      yield { entry: 'beginPreparation', arg: { id, ...context, header } };
      for (let offset = 0; offset < chunks.length; offset++) {
        const { recipe: _recipe, ...manifest } = chunks[offset].manifest;
        yield { entry: 'appendPreparation', arg: { id, kind: 'chunks', offset, values: [{ ...chunks[offset], manifest }] } };
      }
      for (let offset = 0; offset < fields.length; offset++)
        yield { entry: 'appendPreparation', arg: { id, kind: 'heightfieldChunks', offset, values: [fields[offset]] } };
      for (let offset = 0; offset < colliders.length; offset += 64)
        yield { entry: 'appendPreparation', arg: { id, kind: 'staticColliders', offset, values: colliders.slice(offset, offset + 64) } };
      if (cache.eager) yield { entry: 'appendPreparation', arg: { id, kind: 'eager', offset: 0, values: [cache.eager] } };
      }
      if(cache.collisionChunks&&importCollisionChunks)for(const chunk of cache.collisionChunks)
        yield{entry:'importCollisionChunk',arg:{tuning:context.tuning,chunk,manifest:chunks.find(c=>c.x===chunk.x&&c.z===chunk.z)?.manifest}};
      yield { entry: 'finishPreparation', arg: { id, ...context } };
      yield { entry: 'activatePreparation', arg: { id, ...context }, final: true };
    }
    // Each imported source primes at most 32 descriptors per task. Account for
    // those bounded slices without consuming the ordinary transfer allowance.
    const sourceCalls=cache.collisionChunks?.reduce((n,c)=>n+1+Math.ceil((c.colliders.length+4)/32),0)??0;
    const work = phases();
    let repeated:ReturnType<typeof work.next>|undefined;
    this.runTerrainJob(key, 'adoption', () => {
      const phase = repeated??work.next();repeated=undefined;
      if (phase.done) throw new Error('Terrain loading ended before collision activation');
      const { entry, arg, final } = phase.value;
      if(entry==='finishPreparation')this.terrainSwitchPending=true;
      const result = this.sandbox.call<{ ready: boolean; revision: string; loadedRevision: string } | boolean>(entry, arg, ADOPT_TERRAIN_MS).value;
      if(entry==='importCollisionChunk'&&result===false){repeated=phase;return false;}
      if (entry === 'beginPreparation' || entry === 'appendPreparation' || entry==='reusePreparation'||entry==='importCollisionChunk') {
        if (result !== true) throw new Error('Terrain loading did not accept its staged data');
      } else if (!result || typeof result !== 'object' || result.ready !== true || result.revision !== cache.revision || result.loadedRevision !== cache.loadedRevision)
        throw new Error('Prepared terrain adoption did not confirm its revision');
      if(background&&entry==='finishPreparation'){
        // The old scene stays usable during all transfer pieces. Finish changes
        // the guest's accepted scene, so activate it in this same task: never
        // expose a frame with new metadata and the old native collision scene.
        const activation=work.next();
        if(activation.done||activation.value.entry!=='activatePreparation')throw new Error('Terrain activation phase is missing');
        const active=this.sandbox.call<{ready:boolean;revision:string;loadedRevision:string}>(activation.value.entry,activation.value.arg,ADOPT_TERRAIN_MS).value;
        if(!active?.ready||active.revision!==cache.revision||active.loadedRevision!==cache.loadedRevision)throw new Error('Terrain activation did not confirm its revision');
        return true;
      }
      return final === true;
    }, () => {
      this.terrainSwitchPending=false;this.terrainAdoptions++;
      this.activatedTerrainCache=cache;
      this.adoptedTerrainKey = key;
      this.firstPrediction = true;
    },512+sourceCalls);
  }

  private interests(states: readonly unknown[]): MatchInterest[] {
    return states.slice(0, 32).flatMap(value => {
      const state = value as Record<string, unknown> | null;
      return state && Number.isFinite(state.x) && Number.isFinite(state.z) ? [{ x: state.x as number, z: state.z as number,
        velocity: { x: Number.isFinite(state.velocityX) ? state.velocityX as number : Number.isFinite(state.vx) ? state.vx as number : 0,
          z: Number.isFinite(state.velocityZ) ? state.velocityZ as number : Number.isFinite(state.vz) ? state.vz as number : 0 } }] : [];
    });
  }

  private prepareFrame(value: unknown): boolean {
    if (!this.asyncTerrain) return true;
    const frame = value as { tuning?: unknown; world?: unknown; players?: { hp?: number; active?: boolean; isLocal?: boolean; state?: unknown }[] } | null;
    if (!frame?.world) return false;
    const alive = frame.players?.filter(player => player.active !== false && (player.hp ?? 1) > 0) ?? [];
    const local = alive.find(player => player.isLocal);
    return this.ensureTerrain(frame.tuning, frame.world, this.interests(local ? [local.state] : alive.map(player => player.state)));
  }

  private ensureTerrain(tuning: unknown, world: unknown, interests: readonly MatchInterest[]): boolean {
    if (!this.asyncTerrain) return true;
    if (this.disposed || this.preparationFailed) return false;
    // Source and feature composition are fixed by this ClientLogic instance.
    const revision=(world as {terrainRevision?:unknown}|null)?.terrainRevision;
    // Several edits may arrive while the authoritative revision is pending.
    // Empty acknowledgements must not alias different sparse worlds or adopt
    // a completed worker's geometry against a newer edit context.
    const pendingIdentity=this.sandbox.hasEntry('terrainIdentity')
      ?this.call<unknown>('terrainIdentity',{tuning,world},PREDICT_MS):undefined;
    if(typeof pendingIdentity==='string'&&pendingIdentity.length>65536){this.failPreparation(new Error('Terrain edit identity exceeds its bound'));return false;}
    const key = JSON.stringify([tuning,typeof pendingIdentity==='string'?pendingIdentity:revision]);
    if (key !== this.terrainKey) {
      this.cancelTerrainJob();
      // Even an unfinished metadata stage may have synchronized new edits.
      // Returning to a former key must validate it again before cache adoption.
      this.metadataTerrainKey = '';
    }
    this.terrainKey = key;
    this.terrainTuning = tuning;
    this.terrainWorld = world;
    this.terrainInterests = interests;
    if(this.info.terrainPrefetch&&this.adoptedTerrainKey&&this.adoptedTerrainKey!==key&&this.failedLocalTerrainKey!==key&&this.sandbox.hasEntry('prepareLocalEdits')){
      try{
        const prepared=this.sandbox.call<boolean>('prepareLocalEdits',{tuning,world,interests},ADOPT_TERRAIN_MS).value;
        if(prepared){
          this.cancelTerrainJob();this.adoptedTerrainKey=key;this.metadataTerrainKey=key;
          this.terrainSwitchPending=false;this.terrainLocalEdits++;this.firstPrediction=true;
        }
      }catch(error){
        // A bounded fast-path miss must fall back to exact worker preparation,
        // never permanently disable prediction. No old collision is used while
        // the new key waits for its atomic worker adoption.
        if(!(error instanceof Error)||!error.message.startsWith('prepareLocalEdits took longer than')){this.failPreparation(error);return false;}
        this.terrainSwitchPending=true;this.metadataTerrainKey='';this.failedLocalTerrainKey=key;this.terrainLocalEditFallbacks++;
      }
    }
    const ready=!this.terrainSwitchPending&&this.adoptedTerrainKey===key
      &&this.call('preparationReady',{tuning,interests,world},PREDICT_MS)===true;
    const ahead=this.info.terrainPrefetch?interests.map(point=>({...point,radius:24})):interests;
    if(ready){
      if(this.info.terrainPrefetch&&!this.terrainJob
        &&this.call('preparationReady',{tuning,interests:ahead,world},PREDICT_MS)!==true)
        this.preparation?.request(key,tuning,ahead,world);
      return true;
    }
    if (this.terrainJob === 'adoption') return false;
    if (this.metadataTerrainKey !== key && this.sandbox.hasEntry('prepareTerrainMetadata')) {
      if (this.stagedTerrain) {
        if (!this.terrainJob) this.runTerrainJob(key, 'metadata', () => {
          const ready = this.sandbox.call('prepareTerrainMetadata', { tuning: this.terrainTuning, world: this.terrainWorld, incremental: true }, ADOPT_TERRAIN_MS).value;
          if (typeof ready !== 'boolean') throw new Error('Terrain metadata preparation returned an invalid status');
          return ready;
        }, () => {
          this.metadataTerrainKey = key;
          const pending = this.pendingTerrainCache;
          this.pendingTerrainCache = undefined;
          if (pending?.key === key) this.adoptTerrainInStages(key, pending.cache);
          else this.preparation?.request(key, this.terrainTuning, this.info.terrainPrefetch?this.terrainInterests.map(point=>({...point,radius:24})):this.terrainInterests, this.terrainWorld);
        });
        return false;
      }
      try {
        // Recipe validation and geometry adoption are separate bounded phases.
        // The worker response arrives in a later task, leaving the page free
        // between them. Neither phase generates terrain on the main thread.
        if (this.sandbox.call('prepareTerrainMetadata', { tuning, world }, ADOPT_TERRAIN_MS).value !== true)
          throw new Error('Terrain metadata preparation did not confirm completion');
        this.metadataTerrainKey = key;
      } catch (error) { this.failPreparation(error); return false; }
    }
    this.preparation?.request(key, tuning, ahead, world);
    return false;
  }

  private predictionTerrain(tuning:unknown,world:unknown,interests:readonly MatchInterest[]):boolean{
    this.predictionAttempts++;
    const ready=this.ensureTerrain(tuning,world,interests),now=performance.now();
    if(!ready){this.terrainBlockedPredictions++;this.terrainBlockStarted??=now;}
    else if(this.terrainBlockStarted!==undefined){const elapsed=now-this.terrainBlockStarted;this.terrainBlockedMs+=elapsed;this.terrainLongestBlockMs=Math.max(this.terrainLongestBlockMs,elapsed);this.terrainBlockStarted=undefined;}
    return ready;
  }
  get motionStats(){const pending=this.terrainBlockStarted===undefined?0:performance.now()-this.terrainBlockStarted;
    return{predictionAttempts:this.predictionAttempts,terrainBlockedPredictions:this.terrainBlockedPredictions,
      terrainBlockedMs:this.terrainBlockedMs+pending,longestTerrainBlockMs:Math.max(this.terrainLongestBlockMs,pending),terrainAdoptions:this.terrainAdoptions,terrainLocalEdits:this.terrainLocalEdits,terrainLocalEditFallbacks:this.terrainLocalEditFallbacks};}
  resetMotionStats(){this.predictionAttempts=this.terrainBlockedPredictions=this.terrainBlockedMs=this.terrainLongestBlockMs=this.terrainAdoptions=0;
    this.terrainLocalEdits=this.terrainLocalEditFallbacks=0;
    if(this.terrainBlockStarted!==undefined)this.terrainBlockStarted=performance.now();}

  /** At most one message per kind every few seconds: a broken game mustn't flood the console. */
  private report(key: string, text: string, isError: boolean): void {
    const now = Date.now();
    if (now - (this.lastError.get(key) ?? -Infinity) < ERROR_QUIET_MS) return;
    this.lastError.set(key, now);
    (isError ? console.error : console.log)(text.slice(0, 1000));
  }
}
