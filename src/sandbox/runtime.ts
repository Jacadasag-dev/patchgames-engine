import type { Buttons, ConfirmedElimination, DamageHit, PointerState, TuningValues } from '../shared/gameApi.ts';
import { describeError, parse, publish, randomFor, seedRandom, stringify, takeLogs } from './lockdown.ts';
import { inputDefaults, joinMatch, newMatch, stepMatch, restartRound, notifyEliminations, commitGameScene, type AnyGame, type MatchState } from './match.ts';
import {sceneGameplayActive,type GameSceneAction} from '../shared/gameScenes.ts';
import { healthAtSetup } from './health.ts';
import { conformGameUiEvents } from '../shared/gameUiEvents.ts';
import { terrainInterestsFor } from './terrainWorld.ts';
import { preparePhysics } from './physics.ts';
import { TerrainPreparationTransfer, terrainPreparationContext, type TerrainPreparationHeader, type TerrainPreparationPieceKind, type TerrainPreparationReuse } from './preparationTransfer.ts';

// Runs inside the QuickJS sandbox, after the game's logic module. These are
// the only calls the core can make into the game. Each takes and returns a
// JSON string: { ok: result, logs } or { error, logs }. The host checks
// every result against the game's declared shapes before using it.

type Entry = (arg: never) => unknown;

function wrap(entry: Entry): (json: string) => string {
  return (json) => {
    let result: { ok?: unknown; error?: string; logs?: string[] };
    try {
      result = { ok: entry(parse(json) as never) };
    } catch (error) {
      result = { error: describeError(error) };
    }
    result.logs = takeLogs();
    try {
      return stringify(result);
    } catch (error) {
      return stringify({ error: `The game returned something that isn't plain data: ${describeError(error)}`, logs: result.logs });
    }
  };
}

/** Health and the full state of every participant, and the world. The host keeps only the declared fields. */
function project(match: MatchState) {
  return {
    players: match.players.map((player) => ({ hp: player.hp, maxHp: player.maxHp, state: player.state })),
    world: match.world,
    objectiveComplete: match.objectiveComplete,
    teamObjective: match.teamObjective,
    pendingTeamObjective: match.pendingTeamObjective,
    voice: match.voice,
  };
}

export function install(game: AnyGame): void {
  game.terrainWorld?.bindWorldShape?.(game.shapes.world);
  let match: MatchState | null = null;
  const preparationTransfer = new TerrainPreparationTransfer();
  let preparationActivation: { id: number; context: string; scene: import('./physics.ts').PhysicsScene; cache:import('./terrainWorld.ts').TerrainPreparedWorld;
    progress: import('./terrainStreaming.ts').TerrainPreparation } | undefined;

  const entries: Record<string, Entry> = {
    describe: () => ({
      mode: game.mode ?? 'duel',
      supportedModes: game.supportedModes,
      rounds: game.rounds,
      scenes: game.scenes,
      featureCapabilities: game.featureCapabilities,
      terrainConstraints: game.terrainWorld?.constraints,
      terrainPrefetch: !!game.terrainWorld?.prefetch,
      cooperative: game.cooperative,
      voice: game.voice,
      playerClasses: game.playerClasses,
      playerModels: game.playerModels,
      shapes: game.shapes,
      learning: game.learning,
      bindings: game.controls?.bindings ?? [],
      pointer: game.controls?.pointer,
      controlsHint: game.controls?.hint ?? '',
      inspectionControls: game.controls?.inspection,
      inspectionSetups: game.inspectionSetups?.map(({ stage, ...metadata }) => ({ ...metadata, canStage: typeof stage === 'function' })),
      smoothFields: game.smoothFields ?? [],
      // Absent means the engine's default (every continuous field); a declared list narrows it.
      predictionFields: game.prediction?.fields,
      predictionSnapFields: game.prediction?.snapFields,
      pointerLook: game.prediction?.pointerLook,
      // Which fields also ride datagrams to players on WebTransport (fastLane.ts).
      network: game.network,
      // A game with its own prediction step keeps it; the engine predicts the others from `step`.
      legacyPredictionStep: typeof game.prediction?.step === 'function',
    }),

    // Static games have no terrain protocol. Omitting these optional entries
    // lets both hosts skip readiness queries and unused preparation workers.
    ...(game.terrainWorld ? {
    /** Bounded terrain work runs outside the live simulation tick budget. The
     * host repeats this entry until the required collision neighborhood is ready.
     * No simulation clock, player state or gameplay random stream advances here. */
    prepare: ({ tuning, interests, world, includeInitial, health, dataOnly }: { tuning: TuningValues; interests?: import('./terrainStreaming.ts').TerrainInterest[]; world?: unknown; includeInitial?: boolean; health?: readonly { hp: number }[]; dataOnly?: boolean }) => {
      game.terrainWorld?.sync(tuning, world ?? match?.world);
      const current = interests ?? (match ? terrainInterestsFor(match.players.map((player, index) => ({ state: player.state, hp: health?.[index]?.hp ?? player.hp }))) : undefined);
      const progress = game.terrainWorld?.prepare(tuning, current, includeInitial) ?? { ready: true, pending: 0, revision: '', loadedRevision: '' };
      // The client's preparation worker only exports data. Installing a second
      // native world there duplicates the activation done by the prediction VM.
      if (progress.ready && game.terrainWorld && !dataOnly) preparePhysics(game.terrainWorld.read(tuning).scene);
      return progress;
    },
    prefetch:()=>game.terrainWorld?.prefetch?.(match!.tuning,terrainInterestsFor(match!.players))
      ??{ready:true,pending:0,revision:'',loadedRevision:''},
    terrainIdentity:({tuning,world}:{tuning:TuningValues;world?:unknown})=>game.terrainWorld?.editIdentity?.(tuning,world??match?.world)??null,

    /** The client can prepare recipe identity before its worker returns geometry.
     * This does not generate chunks, install physics or advance gameplay. */
    prepareTerrainMetadata: ({ tuning, world, incremental }: { tuning: TuningValues; world?: unknown; incremental?: boolean }) => {
      game.terrainWorld?.sync(tuning, world ?? match?.world);
      return game.terrainWorld?.prepareMetadata?.(tuning, incremental) !== false;
    },
    importCollisionChunk:({tuning,chunk,manifest}:{tuning:TuningValues;chunk:import('./terrainWorld.ts').TerrainCollisionChunk;manifest?:import('./terrain.ts').TerrainManifest})=>{
      if(!game.terrainWorld?.importCollisionChunk)throw new Error('This terrain has no local collision source cache.');
      return game.terrainWorld.importCollisionChunk(tuning,chunk,manifest)!==false;
    },
    prepareLocalEdits:({tuning,world,interests}:{tuning:TuningValues;world?:unknown;interests:import('./terrainStreaming.ts').TerrainInterest[]})=>{
      const host=game.terrainWorld,progress=host?.prepareLocalEdits?.(tuning,world??match?.world,interests);
      if(!progress?.ready||!host)return false;
      preparePhysics(host.read(tuning).scene);return true;
    },

    beginPreparation: ({ id, tuning, world, header }: { id: number; tuning: TuningValues; world?: unknown; header: TerrainPreparationHeader }) => {
      if (!game.terrainWorld) throw new Error('The game has no terrain preparation host.');
      const context = terrainPreparationContext(tuning, world ?? match?.world);
      game.terrainWorld.sync(tuning, world ?? match?.world);
      const result = preparationTransfer.begin(id, context, header);
      preparationActivation = undefined;
      return result;
    },
    reusePreparation:({id,tuning,world,header,reuse}:{id:number;tuning:TuningValues;world?:unknown;header:TerrainPreparationHeader;reuse:TerrainPreparationReuse})=>{
      if(!game.terrainWorld)throw new Error('The game has no terrain preparation host.');
      const context=terrainPreparationContext(tuning,world??match?.world);
      game.terrainWorld.sync(tuning,world??match?.world);
      const result=preparationTransfer.reuse(id,context,header,reuse);preparationActivation=undefined;return result;
    },
    appendPreparation: ({ id, kind, offset, values }: { id: number; kind: TerrainPreparationPieceKind; offset: number; values: unknown[] }) =>
      preparationTransfer.append(id, kind, offset, values),
    finishPreparation: ({ id, tuning, world }: { id: number; tuning: TuningValues; world?: unknown }) => {
      if (!game.terrainWorld) throw new Error('The game has no terrain preparation host.');
      const context = terrainPreparationContext(tuning, world ?? match?.world);
      const cache = preparationTransfer.finish(id, context);
      preparationActivation = undefined;
      game.terrainWorld.sync(tuning, world ?? match?.world);
      const progress = game.terrainWorld.adoptPrepared(tuning, cache, true);
      if (!progress.ready || progress.revision !== cache.revision || progress.loadedRevision !== cache.loadedRevision)
        throw new Error('Prepared terrain source, tuning or collision revision differs.');
      const accepted = game.terrainWorld.read(tuning);
      if (accepted.revision !== progress.revision || accepted.loadedRevision !== progress.loadedRevision)
        throw new Error('Prepared terrain changed before activation.');
      preparationActivation = { id, context, scene: accepted.scene, progress, cache };
      return progress;
    },
    activatePreparation: ({ id, tuning, world }: { id: number; tuning: TuningValues; world?: unknown }) => {
      const accepted = preparationActivation;
      if (!accepted || accepted.id !== id) throw new Error('Stale terrain preparation activation id.');
      if (accepted.context !== terrainPreparationContext(tuning, world ?? match?.world))
        throw new Error('Terrain preparation context changed before activation.');
      // Finish already synced/adopted for this exact captured context. Use its
      // accepted scene, so activation cannot regenerate after a new sync/read.
      preparePhysics(accepted.scene);
      preparationTransfer.activate(accepted.cache);
      preparationActivation = undefined;
      return accepted.progress;
    },

    /** Prepared caches cross only between trusted hosts running this same
     * bundle. Adoption validates recipe/revision and never advances gameplay. */
    exportPreparation: ({ tuning, world }: { tuning: TuningValues; world?: unknown }) => {
      game.terrainWorld?.sync(tuning, world ?? match?.world);
      return game.terrainWorld?.exportPrepared(tuning) ?? null;
    },
    adoptPreparation: ({ tuning, cache, world }: { tuning: TuningValues; cache: import('./terrainWorld.ts').TerrainPreparedWorld; world?: unknown }) => {
      game.terrainWorld?.sync(tuning, world ?? match?.world);
      // The trusted host validates the bounded plain cache and its geometry
      // checksum before entry. The world still checks this bundle's recipe and
      // tuning identity; the native bridge independently validates its scene.
      const progress = game.terrainWorld?.adoptPrepared(tuning, cache, true) ?? { ready: true, pending: 0, revision: '', loadedRevision: '' };
      if (progress.ready && game.terrainWorld) preparePhysics(game.terrainWorld.read(tuning).scene);
      return progress;
    },
    preparationReady: ({ tuning, interests, world, includeInitial, health }: { tuning: TuningValues; interests?: import('./terrainStreaming.ts').TerrainInterest[]; world?: unknown; includeInitial?: boolean; health?: readonly { hp: number }[] }) => {
      const host=game.terrainWorld,value=world??match?.world;
      // A readiness hint has four milliseconds. New hosts compare only sparse
      // edit identity here; collision projection belongs to the permitted prepare
      // entry. Keep the old path for archived hosts without this capability.
      if(host?.synchronized){if(!host.synchronized(tuning,value))return false;}
      else host?.sync(tuning,value);
      const current = interests ?? (match ? terrainInterestsFor(match.players.map((player, index) => ({ state: player.state, hp: health?.[index]?.hp ?? player.hp }))) : undefined);
      return game.terrainWorld?.prepared(tuning, current, includeInitial) ?? true;
    },
    } : {}),

    /** A new match (server: once per match, in a fresh sandbox). */
    setup: ({ tuning, seed, playerCount, mode, tags, teams, roster, team, joinPlayer, health, classIds, classId, inspectionSetup, roundReset }: { tuning: TuningValues; seed: number; playerCount?: number; mode?: import('../shared/gameModes.ts').GameModeId; tags?: import('../shared/gameTags.ts').GameTagId[]; roster?: import('../shared/shapes.ts').RosterDeclaration; teams?: number[]; team?: number; joinPlayer?: number; health?: { hp: number; maxHp: number }[]; classIds?: string[]; classId?: string; inspectionSetup?: string; roundReset?: import('../shared/roundSeries.ts').RoundState }) => {
      if(roundReset){if(!match)throw Error('round reset before setup');restartRound(game,match,roundReset);return project(match);}
      if (joinPlayer !== undefined) {
        if (!match) throw new Error('join before setup');
        if (!health || health.length !== match.players.length) throw new Error('Join health must match current participants');
        match.players.forEach((player, i) => Object.assign(player, health[i]));
        joinMatch(game, match, joinPlayer, classId, team);
        return project(match);
      }
      seedRandom(seed);
      match = newMatch(game, tuning, playerCount, mode, classIds, { tags, teams, roster });
      if (inspectionSetup !== undefined) stageInspection(game, match, inspectionSetup);
      return project(match);
    },

    /** One server tick. */
    step: ({ inputs, dtMs, elapsedMs, health, finishWindow, authoritativeDamage, hits, active, respawned, reviveProgress, roundState,sceneActions }: {
      inputs: unknown[]; dtMs: number; elapsedMs: number; health: { hp: number; maxHp: number }[]; finishWindow?: boolean;
      authoritativeDamage?: boolean; hits?: DamageHit[];
      active?: boolean[]; respawned?: number[]; reviveProgress?: number[]; roundState?: import('../shared/roundSeries.ts').RoundState;
      sceneActions?:GameSceneAction[];
    }) => {
      if (!match) throw new Error('step before setup');
      if (inputs.length !== match.players.length || health.length !== match.players.length) throw new Error('Step participants must match setup');
      if(game.rounds&&roundState){match.roundState={...roundState};(match.world as any)[game.rounds.stateField]={...roundState};}
      // The core's match clock and health are the ones that count.
      match.elapsedMs = match.sceneState?.gameplayMs??elapsedMs-dtMs;
      match.players.forEach((player, i) => {
        player.hp = health[i].hp;
        player.maxHp = health[i].maxHp;
      });
      // Only a host explicitly taking responsibility for damage may skip the
      // local pass. Older hosts/bundles keep their existing internal resolution.
      if (authoritativeDamage === true) match.hits = hits ?? [];
      const events = stepMatch(game, match, inputs, dtMs, finishWindow, authoritativeDamage !== true, active, authoritativeDamage === true ? respawned : undefined, reviveProgress,sceneActions);
      // The host checks these again and applies the damage itself (host/match.ts).
      return { ...project(match), events, entities: match.entities };
    },

    /** Current host health/outcomes decide whether a gameplay scene may interrupt. */
    sceneCommit:({dtMs,inputs,health,hits,allowTransition}:{dtMs:number;inputs:unknown[];health:{hp:number;maxHp:number}[];hits:DamageHit[];allowTransition:boolean})=>{
      if(!match||health.length!==match.players.length)throw Error('scene commit before setup or invalid roster');
      match.players.forEach((player,index)=>Object.assign(player,health[index]));
      match.hits=hits??[];
      commitGameScene(game,match,dtMs,inputs,allowTransition);
      return project(match);
    },

    /** One fixed step of the local player's input, from the buttons (browser). */
    writeInput: ({ held, taps, values, pointer, frame, ui }: { held: string[]; taps: string[]; values?: Record<string, number>; pointer: PointerState; frame: never; ui?: unknown }) => {
      const heldSet = new Set(held);
      const pending = new Set(taps);
      const consumed: string[] = [];
      let pendingUi = conformGameUiEvents(ui);
      const buttons: Buttons = {
        value: name => Number.isFinite(values?.[name]) ? Math.max(-1, Math.min(1, values![name])) : Number(heldSet.has(name)),
        held: (name) => heldSet.has(name),
        tapped: (name) => {
          if (!pending.delete(name)) return false;
          consumed.push(name);
          return true;
        },
        ui: name => {
          const selected = pendingUi.filter(event => event.name === name);
          pendingUi = pendingUi.filter(event => event.name !== name);
          return selected;
        },
        pointer: { x: pointer.x, y: pointer.y, deltaX: pointer.deltaX ?? 0, deltaY: pointer.deltaY ?? 0,
          locked: pointer.locked === true, captured: pointer.captured === true },
      };
      const input = inputDefaults(game.shapes.input);
      game.controls.writeInput(input, buttons, frame);
      return { input, consumed };
    },

    /** Legacy local prediction of one input through the game's own prediction step (browser). */
    predict: ({ state, input, dt, opponent, opponents, tuning, world, mode }: { state: Record<string, unknown>; input: unknown; dt: number; opponent: unknown; opponents?: readonly unknown[]; tuning: TuningValues; world: never; mode?: import('../shared/gameModes.ts').GameModeId }) => {
      if(!sceneGameplayActive(game.scenes,world))return state;
      if(game.rounds&&(world as any)?.[game.rounds.stateField]?.phase!==0)return state;
      game.prediction?.step?.(state, input, dt, { opponent: opponent ?? undefined,
        opponents: opponents ?? (opponent == null ? [] : [opponent]), tuning, world, mode });
      return state;
    },

    /** The game's real step for one local input (browser). Every seat is present in server order so
     * contacts and events carry the right indices; only the local fighter has an input, so the others
     * hold still. The world copy and the other fighters' changes are discarded by the host, and health
     * stays the core's. Returns the local fighter's state as the step left it, and the step's events. */
    predictStep: ({ players, local, input, dtMs, elapsedMs, tuning, world, mode, tags }: { players: { state: Record<string, unknown>; hp: number; maxHp: number; active?: boolean; classId?: string; team?: number }[]; local: number; input: unknown; dtMs: number; elapsedMs: number; tuning: TuningValues; world: never; mode?: import('../shared/gameModes.ts').GameModeId; tags?: import('../shared/gameTags.ts').GameTagId[] }) => {
      if (!Array.isArray(players) || !Number.isInteger(local) || !players[local]) throw new Error('predictStep needs the local participant');
      const participants = players.map((player, index) => ({ index, active: player.active !== false, classId: player.classId ?? '',
        ...(typeof player.team === 'number' ? { team: player.team } : {}), hp: player.hp, maxHp: player.maxHp, state: player.state }));
      const alive = participants.map(player => player.active && player.hp > 0);
      if(!sceneGameplayActive(game.scenes,world))return{state:participants[local].state,events:[]};
      if(game.rounds&&(world as any)?.[game.rounds.stateField]?.phase!==0)return{state:participants[local].state,events:[]};
      const events = game.step({ mode: mode ?? game.mode ?? 'duel', tags: tags ?? [], world, players: participants as never,
        inputs: participants.map((_, index) => index === local && alive[index] ? input : undefined) as never,
        tuning, dtMs, elapsedMs, random: randomFor, hits: [] }) ?? [];
      return { state: participants[local].state, events };
    },

    /** Text for the HUD's info slot (browser). */
    hudLines: (frame: never) => game.hudLines?.(frame) ?? [],
  };

  // Optional entry keeps archived bundles/hosts compatible and ordinary games
  // avoid a second VM call. Only the trusted host supplies confirmed contacts.
  if (game.onEliminations) entries.eliminations = ({ health, eliminations, dtMs, elapsedMs }: {
    health: { hp: number; maxHp: number }[]; eliminations: ConfirmedElimination[]; dtMs: number; elapsedMs: number;
  }) => {
    if (!match || health.length !== match.players.length) throw new Error('Elimination participants must match setup');
    match.elapsedMs = elapsedMs;
    match.players.forEach((player, index) => Object.assign(player, health[index]));
    notifyEliminations(game, match, eliminations, dtMs);
    return project(match);
  };
  publish(Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, wrap(entry)])));
}

/** This capability is only supplied by the isolated inspection host. Normal
 * setup, replay verification, client prediction and training never request it. */
function stageInspection(game: AnyGame, match: MatchState, id: string): void {
  const setup = game.inspectionSetups?.find(setup => setup.id === id);
  if (!setup || typeof setup.stage !== 'function') throw new Error(`Unknown inspection setup: ${id}`);
  const before = stringify({ mode: match.mode, tuning: match.tuning,
    players: match.players.map(({ index, active, classId }) => ({ index, active, classId })) });
  const result = setup.stage({ mode: match.mode, tags: match.rules.tags, world: match.world, players: match.players, tuning: match.tuning, random: randomFor }) as unknown;
  if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Inspection setup staging must complete synchronously');
  if (before !== stringify({ mode: match.mode, tuning: match.tuning,
    players: match.players.map(({ index, active, classId }) => ({ index, active, classId })) }))
    throw new Error('Inspection setups must preserve the roster, classes, mode and tuning');
  for (const [index, player] of match.players.entries()) {
    const fallback = match.initialHealth[index];
    Object.assign(player, healthAtSetup(player.hp, player.maxHp, fallback));
    if (!match.rules.damage) player.hp = player.maxHp;
  }
  match.initialStates = match.players.map(player => stringify(player.state));
  match.initialHealth = match.players.map(({ hp, maxHp }) => ({ hp, maxHp }));
}
