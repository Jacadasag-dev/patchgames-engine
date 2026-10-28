import type { CooperativeOutcome, DamageHit, GameEvent, PlayerList } from '../../shared/gameApi.ts';
import { gameTagsLabel, rulesOf, validRosterCount, type GameRules } from '../../shared/gameTags.ts';
import { conform, conformEvents, conformInput, conformWire, ContractError, type GameInfo } from '../../shared/shapes.ts';
import { parseVoiceStates, type PlayerVoice } from '../../shared/voicePolicy.ts';
import type { LoadedGame } from './game.ts';
import { confirmedEliminations, readEntities, resolveDamage, retireSessionStrikes } from '../damage.ts';
import { attrition, contactHealing, cooperativeOutcome, cooperativeRecovery, healthAfterDamage, matchFinished, newCooperativeState, sessionHealth, type Health } from '../health.ts';
import { completedReadinessBudgetFailure, LOGIC_ENTRIES, Sandbox } from './quickjs.ts';
import { createDamageCheckpoint } from './damageBudget.ts';
import {advanceRound,initialRound,type RoundState} from '../../shared/roundSeries.ts';
import {ExecutionBurstBudget} from './executionBudget.ts';
import {initialGameScene,readGameScene,sceneGameplayActive,type GameSceneAction} from '../../shared/gameScenes.ts';

// One match's game logic on the server: a fresh sandbox per match, called
// once at setup and once per tick, and every answer forced into the game's
// declared shapes before the room applies it.

const SETUP_MS = 250;
// A tick targets 33ms at 30Hz. Sustained 32-player volleys measured 22–24ms
// after optimization, so larger-roster modes get a bounded 30ms game allowance.
// Duel keeps 20ms. The separately guarded host pass has a 20ms sustained
// baseline, with at most one baseline of native CPU credit for isolated spikes.
const DUEL_STEP_MS = 20;
const ARENA_STEP_MS = 30;
const DAMAGE_MS = 20;
const PREPARE_MS = 2000;
const PREPARE_TOTAL_MS = 20_000;
const PREPARE_MAX_CALLS = 128;

export type { Health };
export interface MatchInterest { x: number; z: number; radius?: number; velocity?: { x: number; z: number } }
export interface MatchPreparation { ready: boolean; pending: number; revision: string; loadedRevision: string; logs: string[] }

/** Decoded inputs are schema instances; the sandbox gets their plain fields. */
function toPlain(input: unknown): unknown {
  const withJson = input as { toJSON?: () => unknown } | null;
  return typeof withJson?.toJSON === 'function' ? withJson.toJSON() : input;
}

export interface FighterUpdate {
  /** Undefined when the game's value wasn't a finite number (maxHp: above 0); the room keeps the old one. */
  hp: number | undefined;
  maxHp: number | undefined;
  state: Record<string, unknown>;
}

export interface MatchUpdate {
  players: PlayerList<FighterUpdate>;
  world: Record<string, unknown>;
  events: GameEvent[];
  /** Damage the core applied this step (a step only; empty at setup). */
  hits: DamageHit[];
  logs: string[];
  /** Locked cooperative RPG result. Never accepted from the game's own events. */
  outcome?: CooperativeOutcome;
  reviveProgress?: number[];
  /** Team games: the team whose content objective completed this step, validated. */
  teamObjective?: number;
  /** Validated per-player voice state from voiceState(ctx), by participant index; absent when the game returned none. */
  voice?: (PlayerVoice | undefined)[];
}

export class MatchSandbox {
  private roundState:RoundState|undefined;
  private readonly sandbox: Sandbox;
  private readonly info: GameInfo;
  /** The selected mode blended with its host rule flags (docs/game-rule-flags.md). */
  private readonly rules: GameRules;
  /** Host-assigned team per participant index in team games. */
  private teams: number[] | undefined;
  /** Chosen at setup from the roster: a two-player duel steps faster than a larger round. */
  private stepMs: number;
  private stepBurst: ExecutionBurstBudget | undefined;
  private readonly offlineMs: number | undefined;
  private readonly damageMs: number;
  /** Lifetime credit: setup, joins, preparation and round changes never refill it. */
  private readonly damageBurst: ExecutionBurstBudget | undefined;
  private readonly setupMs: number;
  private readonly threadCpuBudget: boolean;
  private readonly allowInspectionSetup: boolean;
  /** Strikes that already landed this match (damage.ts). */
  private readonly struck = new Set<string>();
  private playerCount = 2;
  private previous: MatchUpdate | null = null;
  private respawnAt: (number | null)[] = [];
  private cooperative = newCooperativeState();
  private preparationTuning: Record<string, number> = {};
  private explicitPreparationReady = false;
  private setupStarted = false;
  private readiness: { key: string; value: boolean } | undefined;
  private preparationRequired=false;

  constructor(game: LoadedGame, mode: 'live' | 'live-worker' | 'offline' | 'training' | 'inspection' = 'live') {
    this.info = game.info;
    this.rules = rulesOf(game.info);
    // Offline replay verification runs ticks back-to-back and may be CPU-quota
    // throttled. Its correctness budget must not be confused with live latency.
    // Local training runs dozens of simulators at once, so the OS can pause one
    // mid-tick; its wall-clock budget is looser but still stops runaway game code.
    const offlineMs = mode === 'training' ? 1000 : mode === 'offline' || mode === 'inspection' ? 100 : undefined;
    this.offlineMs = offlineMs;
    this.stepMs = offlineMs ?? DUEL_STEP_MS;
    this.damageMs = offlineMs ?? DAMAGE_MS;
    this.threadCpuBudget = mode === 'live' || mode === 'live-worker';
    this.damageBurst = this.threadCpuBudget ? new ExecutionBurstBudget(this.damageMs) : undefined;
    this.allowInspectionSetup = mode === 'inspection';
    // Worker setup cannot block other matches or the room event loop. Its
    // bounded construction allowance is separate from unchanged live ticks.
    // Isolated inspection and offline replay must accept the same bounded
    // construction as live workers; direct live hosts retain their old limit.
    this.setupMs = mode === 'live-worker' || mode === 'inspection' || mode === 'offline' ? 2000 : mode === 'training' ? 1000 : SETUP_MS;
    this.sandbox = new Sandbox(game.source, LOGIC_ENTRIES, {}, undefined, ['prepare', 'preparationReady','prefetch', 'eliminations','sceneCommit']);
  }

  /** Content's cooperative contract is honoured only by rules that say so (rpg without creative). */
  private get cooperativeRules() { return this.rules.cooperative ? this.info.cooperative : undefined; }
  /** Speculative work never runs in a gameplay tick or changes its clock. */
  prefetch():MatchPreparation{
    if(!this.previous||!this.info.terrainPrefetch||!this.sandbox.hasEntry('prefetch'))return{ready:true,pending:0,revision:'',loadedRevision:'',logs:[]};
    const {value,logs}=this.sandbox.call<MatchPreparation>('prefetch',{},PREPARE_MS);
    if(!value||typeof value.ready!=='boolean'||!Number.isSafeInteger(value.pending)||value.pending<0||value.pending>128||(value.ready&&value.pending!==0)
      ||typeof value.revision!=='string'||value.revision.length>256||typeof value.loadedRevision!=='string'||value.loadedRevision.length>256)throw new ContractError('Invalid terrain prefetch result');
    return{...value,logs};
  }

  /** Cheap readiness query for the worker scheduler; never generates chunks. */
  prepared(includeInitial = false, health?: readonly Health[]): boolean {
    if (!this.sandbox.hasEntry('prepare')) return true;
    if (!this.sandbox.hasEntry('preparationReady')) return false;
    // Key the exact JSON the VM receives, not mutable host object identities.
    // The readiness contract is pure; retain only its most recent context.
    const key = JSON.stringify({ tuning: this.preparationTuning, includeInitial, health });
    if (this.readiness?.key === key) return this.readiness.value;
    this.readiness = undefined;
    // Offline/inspection VMs already use a bounded correctness allowance for
    // steps: a CPU-quota scheduling pause is not live frame latency. Apply that
    // same allowance to their pure readiness query. Live hints retain 4ms CPU.
    const value = this.sandbox.call('preparationReady', JSON.parse(key), this.offlineMs??4, undefined, { threadCpu: this.threadCpuBudget }).value;
    if (typeof value !== 'boolean') throw new ContractError('Invalid terrain preparation readiness');
    this.readiness = { key, value };
    return value;
  }

  /** Preview locked respawn deadlines without advancing them. The scheduler
   * must acquire a preparation permit before a respawn reloads its spawn area. */
  preparedForStep(_inputs: readonly unknown[], dtMs: number, elapsedMs: number, health: readonly Health[], _finishWindow = false, active?: readonly boolean[],_sceneActions?:readonly GameSceneAction[]): boolean {
    if(this.previous&&this.info.scenes&&!sceneGameplayActive(this.info.scenes,this.previous.world)&&!_finishWindow)return true;
    if(this.preparationRequired)return false;
    const session = sessionHealth(this.info.mode, health, [...this.respawnAt], elapsedMs, dtMs, active, !!this.cooperativeRules, this.rules);
    try { return this.prepared(session.respawned.length > 0, session.health); }
    catch (error) {
      // A completed but late hint is unusable: require the scheduler's permit
      // and authoritative bounded preparation instead. Interrupted/failed VM
      // work stays fatal. Explicit teleport supersets cannot be replaced by
      // ordinary preparation, so their deadline failures also stay fatal.
      if (this.explicitPreparationReady || completedReadinessBudgetFailure(error)?.limitMs !== 4) throw error;
      this.readiness = undefined;
      this.preparationRequired=true;
      return false;
    }
  }

  /** One bounded terrain preparation unit, separate from gameplay tick CPU.
   * Archived bundles without this optional capability remain compatible. */
  prepare(tuning: Record<string, number>, interests?: readonly MatchInterest[], includeInitial = false): MatchPreparation {
    const result = this.prepareUnit(tuning, interests, PREPARE_MS, includeInitial);
    this.explicitPreparationReady = result.ready;
    return result;
  }

  private prepareUnit(tuning: Record<string, number>, interests: readonly MatchInterest[] | undefined, budgetMs: number, includeInitial = false, health?: readonly Health[]): MatchPreparation {
    this.readiness = undefined;
    if (!this.sandbox.hasEntry('prepare')) return { ready: true, pending: 0, revision: '', loadedRevision: '', logs: [] };
    const serialized = JSON.stringify({ tuning, interests, includeInitial, health });
    const { value, logs } = this.sandbox.call<Partial<MatchPreparation>>('prepare', JSON.parse(serialized), budgetMs);
    if (!value || typeof value.ready !== 'boolean' || !Number.isSafeInteger(value.pending) || value.pending! < 0
      || typeof value.revision !== 'string' || value.revision.length > 256
      || typeof value.loadedRevision !== 'string' || value.loadedRevision.length > 256
      || (value.ready && value.pending !== 0)) throw new ContractError('Invalid terrain preparation readiness');
    this.preparationRequired=false;
    // Before setup, omitted interests/health mean the same initial spawn plan
    // in both entries. After setup, explicit interests, or different tuning,
    // preparation's result cannot answer a scheduler query for another plan.
    if (!this.setupStarted && interests === undefined && health === undefined
      && serialized === JSON.stringify({ tuning: this.preparationTuning, includeInitial })) {
      this.readiness = { key: serialized, value: value.ready };
    }
    return { ready: value.ready, pending: value.pending!, revision: value.revision, loadedRevision: value.loadedRevision, logs };
  }

  /** Direct replay/inspection hosts and live workers advance the same readiness
   * path. Preparation never consumes gameplay time or its tight tick budget. */
  private prepareUntilReady(deadline = performance.now() + PREPARE_TOTAL_MS, includeInitial = false, health?: readonly Health[], preservePrepared = false): string[] {
    if (!this.sandbox.hasEntry('prepare')) return [];
    const logs: string[] = [];
    try {
      // An explicit preparation may include an imminent teleport destination.
      // Keep that installed superset for its next tick. Missing coverage still
      // drains the ordinary bounded plan and evicts old chunks.
      // Setup/join always run preparation to install their final native scene.
      if (preservePrepared && this.prepared(includeInitial, health)) return logs;
      for (let count = 0; count < PREPARE_MAX_CALLS; count++) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new ContractError('Terrain preparation exceeded its total time limit');
        const result = this.prepareUnit(this.preparationTuning, undefined, Math.min(PREPARE_MS, remaining), includeInitial, health);
        logs.push(...result.logs.slice(0, 50 - logs.length));
        if (result.ready) return logs;
      }
      throw new ContractError('Terrain preparation did not become ready within 128 calls');
    } catch (error) { this.dispose(); throw error; }
  }

  /** `teams` assigns each participant index a team in team games; omitted, seats alternate by index. */
  setup(tuning: Record<string, number>, seed: number, playerCount = 2, classIds?: readonly string[], teams?: readonly number[]): MatchUpdate {
    return this.initialize(tuning, seed, playerCount, classIds, undefined, teams);
  }

  /** Separate capability: ordinary match/replay/training hosts cannot stage a
   * fixture, even if a caller accidentally forwards an inspection request. */
  setupInspection(id: string, tuning: Record<string, number>, seed: number, playerCount = 2, classIds?: readonly string[]): MatchUpdate {
    if (!this.allowInspectionSetup) throw new ContractError('Test-only setups require an inspection sandbox');
    if (!this.info.inspectionSetups?.some(setup => setup.id === id)) throw new ContractError(`Unknown inspection setup: ${id}`);
    return this.initialize(tuning, seed, playerCount, classIds, id);
  }

  private initialize(tuning: Record<string, number>, seed: number, playerCount: number, classIds?: readonly string[], inspectionSetup?: string, teams?: readonly number[]): MatchUpdate {
    if(this.info.rounds&&this.rules.teams!==2)throw new ContractError('rounds: requires exactly two host teams');
    this.roundState=this.info.rounds?initialRound():undefined;
    this.readiness = undefined;
    this.setupStarted = true;
    if (!validRosterCount(this.rules, playerCount)) throw new ContractError(`players: invalid participant count ${playerCount} for ${gameTagsLabel(this.rules.tags)}`);
    this.playerCount = playerCount;
    // A two-seat closed round keeps the duel budget; rules that open with more seats, larger rosters
    // and open sessions (which can grow) get the arena budget.
    this.stepMs = this.offlineMs ?? (playerCount > 2 || this.rules.seats > 2 || this.rules.openSession ? ARENA_STEP_MS : DUEL_STEP_MS);
    this.stepBurst = this.threadCpuBudget ? new ExecutionBurstBudget(this.stepMs) : undefined;
    this.struck.clear();
    this.respawnAt = Array(playerCount).fill(null);
    this.cooperative = newCooperativeState();
    if (classIds && (classIds.length !== playerCount || classIds.some(id => !this.validClass(id)))) throw new ContractError('playerClasses: invalid selected classes');
    this.teams = this.rules.teams ? Array.from({ length: playerCount }, (_, index) => teams?.[index] ?? index % this.rules.teams) : undefined;
    if (this.teams && ((teams !== undefined && teams.length !== playerCount) || this.teams.some(team => !Number.isInteger(team) || team < 0 || team >= this.rules.teams)))
      throw new ContractError('teams: expected a team index for every participant');
    this.preparationTuning = { ...tuning };
    this.explicitPreparationReady = false;
    const preparationDeadline = performance.now() + PREPARE_TOTAL_MS;
    const preparationLogs = this.prepareUntilReady(preparationDeadline, true);
    this.readiness = undefined;
    const { value, logs } = this.sandbox.call('setup', { tuning, seed, playerCount, mode: this.info.mode, tags: this.rules.tags, roster: this.info.roster, teams: this.teams, classIds,
      ...(inspectionSetup !== undefined ? { inspectionSetup } : {}) }, this.setupMs);
    const update = readUpdate(value, this.info, logs, playerCount);
    // Nobody starts above full health or below 0 (health.ts).
    for (const fighter of update.players) {
      if (fighter.hp !== undefined) fighter.hp = Math.max(0, fighter.maxHp === undefined ? fighter.hp : Math.min(fighter.maxHp, fighter.hp));
      if (!this.rules.damage && fighter.maxHp !== undefined) fighter.hp = fighter.maxHp;
    }
    if (this.cooperativeRules) update.reviveProgress = Array(playerCount).fill(0);
    this.previous = update;
    update.logs = [...preparationLogs, ...logs, ...this.prepareUntilReady(preparationDeadline)].slice(0, 50);
    return update;
  }

  /** Append or replace a departed seat. Existing indices and progression stay intact. */
  joinPlayer(index = this.playerCount, classId?: string, team?: number): MatchUpdate {
    this.readiness = undefined;
    if (this.cooperativeRules) throw new ContractError('Campaign roster is fixed until the next run');
    const count = Math.max(this.playerCount, index + 1);
    if (!this.previous || !this.rules.openSession || !Number.isInteger(index) || index < 0
      || index > this.playerCount || !validRosterCount(this.rules, count)) throw new ContractError('players: invalid session participant slot');
    if (classId !== undefined && !this.validClass(classId)) throw new ContractError('playerClasses: invalid selected class');
    const seat = this.rules.teams ? team ?? index % this.rules.teams : undefined;
    if (seat !== undefined && (!Number.isInteger(seat) || seat < 0 || seat >= this.rules.teams)) throw new ContractError('teams: expected a team index');
    if(this.info.scenes)initialGameScene(this.info.scenes,Array.from({length:count},(_,player)=>({team:player===index?seat:this.teams?.[player]})));
    try {
      const preparationDeadline = performance.now() + PREPARE_TOTAL_MS;
      this.explicitPreparationReady = false;
      const preparationLogs = this.prepareUntilReady(preparationDeadline, true);
      this.readiness = undefined;
      const { value, logs } = this.sandbox.call('setup', { joinPlayer: index, classId, team: seat,
        health: this.previous.players.map(({ hp, maxHp }) => ({ hp, maxHp })) }, this.setupMs);
      const update = readUpdate(value, this.info, logs, count);
      const nextWorld={...update.world},oldWorld={...this.previous.world};
      if(this.info.scenes){
        const before=readGameScene(this.info.scenes,oldWorld)!,after=readGameScene(this.info.scenes,nextWorld)!;
        if(before.id!==after.id||before.sequence!==after.sequence||before.elapsedMs!==after.elapsedMs||before.returnTo!==after.returnTo||before.gameplayMs!==after.gameplayMs||after.ready.length!==count||after.ready[index]!==false||after.choices[index]!==''
          ||before.ready.some((value,seat)=>seat!==index&&value!==after.ready[seat])||before.choices.some((value,seat)=>seat!==index&&value!==after.choices[seat]))throw new ContractError('scenes: joining changed the current scene or another participant selection');
        delete nextWorld[this.info.scenes.stateField];delete oldWorld[this.info.scenes.stateField];
      }
      if (JSON.stringify(nextWorld) !== JSON.stringify(oldWorld)
        || this.previous.players.some((player, i) => i !== index && JSON.stringify(player) !== JSON.stringify(update.players[i])))
        throw new ContractError('players: joining must preserve the world and existing participants');
      const player = update.players[index];
      if (player.hp === undefined || player.maxHp === undefined) throw new ContractError('players: joining requires valid health');
      player.hp = !this.rules.damage ? player.maxHp : Math.max(0, Math.min(player.hp, player.maxHp));
      // Joining must not consume the hit feedback needed for projectile/feature cleanup.
      update.hits = this.previous.hits;
      this.playerCount = count;
      if (this.teams && seat !== undefined) this.teams[index] = seat;
      this.respawnAt[index] = null;
      this.cooperative.reviveMs[index] = 0;
      this.cooperative.revivers[index] = -1;
      for (const key of this.cooperative.healed) if (key.startsWith(`${index}|`)) this.cooperative.healed.delete(key);
      if (this.cooperativeRules) {
        update.reviveProgress = Array.from({ length: count }, (_, i) => i === index ? 0 : this.previous!.reviveProgress?.[i] ?? 0);
        update.outcome = this.previous.outcome;
      }
      for (const key of this.struck) if (key.startsWith(`${index}|`)) this.struck.delete(key);
      this.previous = update;
      update.logs = [...preparationLogs, ...logs, ...this.prepareUntilReady(preparationDeadline)].slice(0, 50);
      return update;
    } catch (error) { this.dispose(); throw error; }
  }

  /**
   * `inputs` are the raw decoded inputs (undefined when a player sent none
   * this tick); `health` is each fighter's current health, owned by the core.
   * Health in the answer is decided here, outside the game's reach (damage.ts,
   * health.ts): the health the game reports is ignored; each fighter loses what
   * the damage entities touching their body deal. Arena and cooperative RPG
   * then permit checked contact healing of surviving participants only.
   * The host's finish window advances the scene while preserving that health.
   */
  step(inputs: readonly unknown[], dtMs: number, elapsedMs: number, health: readonly Health[], finishWindow = false, active?: readonly boolean[],sceneActions:readonly GameSceneAction[]=[]): MatchUpdate {
    if (inputs.length !== this.playerCount || health.length !== this.playerCount) throw new ContractError('players: step participants must match setup');
    if (active && (active.length !== this.playerCount || active.some(value => typeof value !== 'boolean'))) throw new ContractError('players: active participants must match setup');
    if (this.previous?.outcome) return { ...this.previous, events: [], hits: [], logs: [] };
    if(this.previous&&this.info.scenes&&!sceneGameplayActive(this.info.scenes,this.previous.world)&&!finishWindow){
      const started=performance.now(),limit=this.stepBurst?.limitMs??this.stepMs;
      try{
        const result=this.sandbox.call('step',{inputs:inputs.map(()=>null),dtMs,elapsedMs:readGameScene(this.info.scenes,this.previous.world)!.gameplayMs,health,active,authoritativeDamage:true,sceneActions,roundState:this.roundState},limit,undefined,{threadCpu:this.threadCpuBudget});
        const update=readUpdate(result.value,this.info,result.logs,this.playerCount);
        update.players.forEach((player,index)=>Object.assign(player,health[index]));update.hits=[];
        if(this.roundState)update.world[this.info.rounds!.stateField]={...this.roundState};
        const voice=parseVoiceStates((result.value as {voice?:unknown}|null)?.voice,update.players.length,message=>{throw new ContractError(message);});if(voice)update.voice=voice;
        this.previous=update;return update;
      }catch(error){this.dispose();throw error;}finally{this.stepBurst?.charge(performance.now()-started);}
    }
    if(this.info.rounds&&this.roundState&&this.previous&&this.roundState.phase!==0){
      let sceneWorld:Record<string,unknown>|undefined;
      if(this.info.scenes){const committed=this.sandbox.call('sceneCommit',{dtMs,inputs:[],health,hits:[],allowTransition:false},this.stepMs,undefined,{threadCpu:this.threadCpuBudget});sceneWorld=readUpdate(committed.value,this.info,committed.logs,this.playerCount).world;}
      const reset=advanceRound(this.roundState,this.info.rounds,dtMs,health,this.teams!);
      let update:MatchUpdate;
      if(reset){
        const result=this.sandbox.call('setup',{roundReset:this.roundState},this.setupMs);
        update=readUpdate(result.value,this.info,result.logs,this.playerCount);this.struck.clear();this.respawnAt=Array(this.playerCount).fill(null);
      }else update={...this.previous,world:{...this.previous.world},events:[],hits:[],logs:[]};
      if(sceneWorld&&!reset)update.world[this.info.scenes!.stateField]=sceneWorld[this.info.scenes!.stateField];
      update.world[this.info.rounds.stateField]={...this.roundState};
      if(this.roundState.phase===2&&this.roundState.winner>=0)update.teamObjective=this.roundState.winner;
      this.previous=update;return update;
    }
    // Preserve the guest's original pre-setup failure (and partial-setup error)
    // instead of trying to prepare terrain with absent setup tuning.
    const cooperative = this.cooperativeRules;
    // Legacy hosts expose generation/eviction counters as replay state. Keep
    // their exact preparation cadence; only new prefetch-capable hosts opt in
    // to retaining an already safe collision superset between ordinary ticks.
    const preservePrepared = this.explicitPreparationReady||!!this.info.terrainPrefetch&&!!this.previous&&this.preparedForStep(inputs,dtMs,elapsedMs,health,finishWindow,active);
    const session = sessionHealth(this.info.mode, health, this.respawnAt, elapsedMs, dtMs, active, !!cooperative, this.rules);
    this.explicitPreparationReady = false;
    const preparationLogs = this.previous ? this.prepareUntilReady(undefined, session.respawned.length > 0, session.health, preservePrepared) : [];
    // Survival hunger drains before content damage; the finish window holds health as it is.
    const before = finishWindow ? session.health : attrition(session.health, this.rules, dtMs, active);
    const alive = before.map(player => player.hp > 0);
    const clean = inputs.map((input, index) => (!alive[index] || input === undefined ? null : conformInput(toPlain(input), this.info.input)));
    this.readiness = undefined;
    const stepStarted=performance.now();
    const stepLimit = this.stepBurst?.limitMs ?? this.stepMs;
    const { value, logs } = this.sandbox.call('step', {
      inputs: clean, dtMs, elapsedMs, health: before, finishWindow, active, respawned: session.respawned,
      authoritativeDamage: true, hits: this.previous?.hits ?? [],
      reviveProgress: this.previous?.reviveProgress,
      roundState:this.roundState,
      sceneActions,
    }, stepLimit, undefined, { threadCpu: this.threadCpuBudget });
    let guestMs = performance.now() - stepStarted;
    const damageStarted = performance.now();
    try {
      const checkpoint = createDamageCheckpoint(this.damageMs, this.threadCpuBudget, undefined,
        this.damageBurst ? this.damageBurst.limitMs - this.damageMs : 0);
      checkpoint();
      const update = readUpdate(value, this.info, logs, this.playerCount);
      update.logs = [...preparationLogs, ...logs].slice(0, 50);
      const entities = readEntities((value as { entities?: unknown } | null)?.entities, this.playerCount);
      checkpoint();
      const { damage, hits } = resolveDamage(this.rules.damage ? entities : null, this.struck, dtMs, alive, checkpoint, this.teams);
      update.players.forEach((fighter, i) => {
        Object.assign(fighter, finishWindow ? before[i] : healthAfterDamage(before[i], damage[i]));
        if (((this.rules.oneLife || this.rules.openSession) && !alive[i] || active?.[i] === false) && this.previous) fighter.state = this.previous.players[i].state;
      });
      update.hits = hits;
      if (this.rules.healing && !cooperative && !finishWindow) {
        const recovered = contactHealing(update.players as Health[], entities, this.cooperative.healed, active, damage, this.teams);
        update.players.forEach((player, i) => Object.assign(player, recovered[i]));
      }
      if (cooperative && !finishWindow) {
        const recovery = cooperativeRecovery(update.players as Health[], entities, clean, cooperative.reviveInput, dtMs, this.cooperative, active, damage);
        update.players.forEach((player, i) => Object.assign(player, recovery.health[i]));
        update.reviveProgress = recovery.reviveProgress;
        update.outcome = cooperativeOutcome(recovery.health, (value as { objectiveComplete?: unknown } | null)?.objectiveComplete === true, active);
      }
      if (!finishWindow && this.sandbox.hasEntry('eliminations')) {
        const eliminations = confirmedEliminations(before, update.players as Health[], hits);
        if (eliminations.length) {
          checkpoint();
          const feedbackStarted = performance.now();
          const feedback = this.sandbox.call('eliminations', {
            health: update.players.map(({ hp, maxHp }) => ({ hp, maxHp })), eliminations, dtMs, elapsedMs,
          }, Math.max(0, stepLimit - guestMs), undefined, { threadCpu: this.threadCpuBudget });
          guestMs += performance.now() - feedbackStarted;
          const recorded = readUpdate(feedback.value, this.info, feedback.logs, this.playerCount);
          // The callback receives final health for observation only. Keep the
          // host's values even if a guest tries to heal or alter maxHp here.
          update.world = recorded.world;
          update.players.forEach((player, index) => { player.state = recorded.players[index].state; });
          update.logs = [...update.logs, ...feedback.logs].slice(0, 50);
        }
      }
      if (this.rules.teams && !finishWindow) {
        const objective = (value as { teamObjective?: unknown } | null)?.teamObjective;
        if (objective !== undefined && objective !== null) {
          if (!Number.isInteger(objective) || (objective as number) < 0 || (objective as number) >= this.rules.teams) throw new ContractError('teamObjective: expected a team index');
          update.teamObjective = objective as number;
        }
      }
      if(this.info.rounds&&this.roundState&&!finishWindow){
        const pending=(value as {pendingTeamObjective?:unknown}|null)?.pendingTeamObjective;
        if(pending!==undefined&&(!Number.isInteger(pending)||(pending as number)<0||(pending as number)>1))throw new ContractError('pendingTeamObjective: expected a team index');
        advanceRound(this.roundState,this.info.rounds,dtMs,update.players as Health[],this.teams!,update.teamObjective,pending as number|undefined);
        update.teamObjective=this.roundState.phase===2&&this.roundState.winner>=0?this.roundState.winner:undefined;
        update.world[this.info.rounds.stateField]={...this.roundState};
      }
      const voice = parseVoiceStates((value as { voice?: unknown } | null)?.voice, update.players.length, message => { throw new ContractError(message); });
      if (voice) update.voice = voice;
      if (this.rules.openSession) retireSessionStrikes(entities, this.struck);
      if(this.info.scenes){
        if(!this.sandbox.hasEntry('sceneCommit'))throw new ContractError('scenes: missing engine transition entry');
        const allowTransition=!finishWindow&&!update.outcome&&update.teamObjective===undefined&&(!this.roundState||this.roundState.phase===0)&&!matchFinished(update.players as Health[],this.info.mode,this.rules,this.teams);
        const sceneStarted=performance.now();
        const committed=this.sandbox.call('sceneCommit',{dtMs,inputs:clean,health:update.players.map(({hp,maxHp})=>({hp,maxHp})),hits:update.hits,allowTransition},Math.max(0,stepLimit-guestMs),undefined,{threadCpu:this.threadCpuBudget});
        guestMs+=performance.now()-sceneStarted;
        const recorded=readUpdate(committed.value,this.info,committed.logs,this.playerCount);
        update.world=recorded.world;update.players.forEach((player,index)=>player.state=recorded.players[index].state);update.logs=[...update.logs,...committed.logs].slice(0,50);
        if(this.roundState)update.world[this.info.rounds!.stateField]={...this.roundState};
      }
      checkpoint();
      this.previous = update;
      return update;
    } catch (error) {
      // The guest/physics state already advanced. Never retry a rejected host
      // pass using partially committed state or strike bookkeeping.
      this.dispose();
      throw error;
    } finally {
      // Charge the entire pass once, including GC, scheduling and any nested
      // guest callbacks. CPU credit never extends the 100ms wall backstop.
      this.damageBurst?.charge(performance.now() - damageStarted);
      this.stepBurst?.charge(guestMs);
    }
  }

  dispose(): void {
    this.readiness = undefined;
    this.sandbox.dispose();
  }

  private validClass(id: unknown): boolean {
    return typeof id === 'string' && (id === '' || !!this.info.playerClasses?.some(choice => choice.id === id));
  }
}

const health = (value: unknown, positive: boolean) =>
  typeof value === 'number' && Number.isFinite(value) && (!positive || value > 0) ? value : undefined;

/** Forces the sandbox's answer into the declared shapes. Throws ContractError naming the bad field. */
export function readUpdate(raw: unknown, info: GameInfo, logs: string[] = [], playerCount = 2): MatchUpdate {
  const update = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(update.players) || update.players.length !== playerCount) throw new ContractError(playerCount === 2 ? 'players: expected both fighters' : `players: expected all ${playerCount} participants`);
  const players = update.players.map((player, i) => {
    const fighter = (typeof player === 'object' && player !== null ? player : {}) as Record<string, unknown>;
    return {
      hp: health(fighter.hp, false),
      maxHp: health(fighter.maxHp, true),
      state: conform(fighter.state, info.player, `players[${i}].state`) as Record<string, unknown>,
    };
  }) as PlayerList<FighterUpdate>;
  const world=conformWire(update.world??{},info.world,'world') as Record<string,unknown>;
  if(info.scenes&&!readGameScene(info.scenes,world))throw new ContractError('scenes: invalid authoritative scene state');
  return {
    players,
    world,
    events: conformEvents(update.events, playerCount),
    hits: [],
    logs,
  };
}
