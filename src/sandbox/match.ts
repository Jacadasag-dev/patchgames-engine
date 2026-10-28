import type { ConfirmedElimination, CooperativeOutcome, DamageHit, FieldShape, GameEvent, GameLogic, GamePlayer, InputShape, PlayerList, TuningValues } from '../shared/gameApi.ts';
import { gameModeLabel, isGameMode, type GameModeId } from '../shared/gameModes.ts';
import { gameRules, normalizeTags, tagsFromLegacy, validRosterCount, type GameTagId, type GameRules } from '../shared/gameTags.ts';
import {parseRoster,type RosterDeclaration} from '../shared/shapes.ts';
import { confirmedEliminations, readEntities, resolveDamage, retireSessionStrikes } from './damage.ts';
import { attrition, contactHealing, cooperativeOutcome, cooperativeRecovery, healthAfterDamage, healthAtSetup, matchFinished, newCooperativeState, sessionHealth, type CooperativeState } from './health.ts';
import { parse, randomFor, stringify } from './lockdown.ts';
import { terrainInterestsFor } from './terrainWorld.ts';
import {advanceRound,initialRound,type RoundState} from '../shared/roundSeries.ts';
import {advanceGameScene,applyGameSceneActions,initialGameScene,parseSceneRules,restoreGameScene,sceneDefinition,type GameSceneAction,type GameSceneRules,type GameSceneState} from '../shared/gameScenes.ts';

// Runs inside the sandbox. How a match's plain-object state starts out, the
// same way for the server and the game's own tests.

// The game's own types are unknown to the runtime.
export type AnyGame = GameLogic<any, any, any, any>;

/** Direct test/training callers use the same preparation contract as the host.
 * The live host has already prepared outside its tight step budget. */
function readyTerrain(game: AnyGame, tuning: TuningValues, players?: MatchState['players'], world?: unknown, includeInitial = false): void {
  if (!game.terrainWorld) return;
  game.terrainWorld.bindWorldShape?.(game.shapes.world);
  game.terrainWorld.sync(tuning, world);
  const interests = players ? terrainInterestsFor(players) : undefined;
  if (game.terrainWorld.prepared(tuning, interests, includeInitial)) return;
  for (let i = 0; i < 128; i++) if (game.terrainWorld.prepare(tuning, interests, includeInitial).ready) return;
  throw new Error('Terrain preparation exceeded the 128 chunk budget.');
}

/** The starting value of a declared field: 0, false, '', an empty list or map, or an object of defaults. */
export function defaults(shape: FieldShape): unknown {
  if (shape === 'boolean') return false;
  if (shape === 'string') return '';
  if (typeof shape === 'string') return 0;
  if (Array.isArray(shape)) return [];
  const names = Object.keys(shape);
  if (names.length === 1 && names[0] === '*') return {};
  const out: Record<string, unknown> = {};
  for (const name of names) out[name] = defaults((shape as Record<string, FieldShape>)[name]);
  return out;
}

export function inputDefaults(shape: InputShape): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const name of Object.keys(shape)) out[name] = shape[name] === 'boolean' ? false : 0;
  return out;
}

type CheckedEntities = ReturnType<typeof readEntities>;

export interface MatchState<W = Record<string, unknown>, P = Record<string, unknown>, T extends TuningValues = TuningValues> {
  sceneRules?:GameSceneRules;
  sceneState?:GameSceneState;
  roundState?:RoundState;
  pendingTeamObjective?:number;
  mode: GameModeId;
  world: W;
  players: PlayerList<GamePlayer<P>>;
  tuning: T;
  elapsedMs: number;
  /** Damage the core applied at the end of the last step; the game sees it as ctx.hits next step. */
  hits: DamageHit[];
  /** The entities the game described after the last step, as the core checked them. */
  entities: CheckedEntities;
  /** Strikes that already landed, by player and entity id (a strike hits each fighter once). */
  struck: Set<string>;
  respawnAt: (number | null)[];
  initialStates: string[];
  initialHealth: { hp: number; maxHp: number }[];
  cooperative: CooperativeState;
  objectiveComplete: boolean;
  /** What voiceState(ctx) returned this step, unvalidated; the host checks it (docs/voice-chat.md). */
  voice?: unknown;
  outcome?: CooperativeOutcome;
  reviveProgress?: number[];
  /** The selected mode blended with its host rule flags. */
  rules: GameRules;
  /** Host-assigned team per participant index in team games. */
  teams?: number[];
  /** Team games: the team whose content objective completed in the last step. */
  teamObjective?: number;
}

export interface MatchOptions { tags?: readonly GameTagId[]; teams?: readonly number[]; /** Accepts the roster file's count shorthand as well as normalized ranges. */ roster?: RosterDeclaration | {players?:number;teams?:number;teamSize?:number} }

/** Fresh world and fighters from the declared shapes, then the game's own setupMatch(). */
export function newMatch<W, P, I, T extends TuningValues>(game: GameLogic<W, P, I, T>, tuning: T, playerCount = 2, mode: GameModeId = game.mode ?? 'duel', classIds?: readonly string[], options: MatchOptions = {}): MatchState<W, P, T> {
  // Tags decide the rules; a legacy mode is its archetype tag. Content must support the tags' shape.
  const rules = gameRules(normalizeTags(options.tags ?? tagsFromLegacy(mode)), options.roster?parseRoster(options.roster):undefined);
  mode = rules.shape;
  if (!(game.supportedModes ?? [game.mode ?? 'duel']).includes(mode)) throw new Error(`Unsupported game mode ${isGameMode(mode) ? gameModeLabel(mode) : mode}`);
  if (!validRosterCount(rules, playerCount)) throw new Error(`Invalid player count ${playerCount} for ${gameModeLabel(mode)}`);
  const teams = rules.teams ? Array.from({ length: playerCount }, (_, index) => options.teams?.[index] ?? index % rules.teams) : undefined;
  if(game.rounds&&rules.teams!==2)throw Error('rounds: requires exactly two host teams');
  if (teams?.some(team => !Number.isInteger(team) || team < 0 || team >= rules.teams)) throw new Error('Invalid team assignment');
  const player = (index: number) => ({ index, active: true,
    classId: classIds?.[index] ?? game.playerClasses?.[index % game.playerClasses.length]?.id ?? '',
    ...(teams ? { team: teams[index] } : {}),
    hp: 1, maxHp: 1, state: defaults(game.shapes.player) as P });
  const match: MatchState<W, P, T> = { mode, rules, ...(teams ? { teams } : {}), world: defaults(game.shapes.world ?? {}) as W, players: Array.from({ length: playerCount }, (_, index) => player(index)) as PlayerList<GamePlayer<P>>, tuning, elapsedMs: 0,
    hits: [], entities: null, struck: new Set(), respawnAt: Array(playerCount).fill(null), initialStates: [], initialHealth: [],
    cooperative: newCooperativeState(), objectiveComplete: false,
    ...(cooperativeRules(game, rules) ? { reviveProgress: Array(playerCount).fill(0) } : {}) };
  readyTerrain(game, tuning, undefined, match.world, true);
  if(game.rounds){match.roundState=initialRound();(match.world as any)[game.rounds.stateField]={...match.roundState};}
  game.setupMatch({ mode, tags: rules.tags, world: match.world, players: match.players, tuning, random:randomFor });
  match.sceneRules=parseSceneRules(game.scenes);
  if(match.sceneRules){match.sceneState=initialGameScene(match.sceneRules,match.players);enterGameScene(game,match);}
  if(game.rounds)(match.world as any)[game.rounds.stateField]={...match.roundState};
  for (const fighter of match.players) Object.assign(fighter, healthAtSetup(fighter.hp, fighter.maxHp, { hp: 1, maxHp: 1 }));
  if (!rules.damage) for (const fighter of match.players) fighter.hp = fighter.maxHp;
  match.initialStates = match.players.map(player => stringify(player.state));
  match.initialHealth = match.players.map(({ hp, maxHp }) => ({ hp, maxHp }));
  return match;
}

/** Trusted round transition, shared by offline tests and the live host. */
export function restartRound(game:AnyGame,match:MatchState<any,any,any>,round:RoundState):void {
  if(!game.rounds)throw Error('rounds: game has no round series');
  const retain=(value:any,fields:readonly string[]=[])=>Object.fromEntries(fields.map(k=>[k,parse(stringify(value[k]))]));
  const world=retain(match.world,game.rounds.carryWorldFields),players=match.players.map(p=>retain(p.state,game.rounds!.carryPlayerFields));
  match.world={...(defaults(game.shapes.world)as object),...world,[game.rounds.stateField]:{...round}};
  for(const p of match.players){p.state={...(defaults(game.shapes.player)as object),...players[p.index]};p.hp=p.maxHp=match.initialHealth[p.index].maxHp;}
  game.setupMatch({mode:match.mode,tags:match.rules.tags,world:match.world,players:match.players,tuning:match.tuning,random:randomFor});
  if(match.sceneRules&&match.sceneState){const previous=parse(stringify(match.sceneState)) as GameSceneState;match.sceneState={...match.sceneState,id:match.sceneState.returnTo,sequence:match.sceneState.sequence+1,elapsedMs:0,ready:match.players.map(()=>false),choices:match.players.map(()=>'')};enterGameScene(game,match,previous);}
  match.roundState={...round};(match.world as any)[game.rounds.stateField]={...round};
  for(const p of match.players)Object.assign(p,healthAtSetup(p.hp,p.maxHp,match.initialHealth[p.index]));
  match.hits=[];match.entities=null;match.struck.clear();match.teamObjective=undefined;match.pendingTeamObjective=undefined;
  match.initialStates=match.players.map(p=>stringify(p.state));match.respawnAt=match.players.map(()=>null);
}

/** Content's cooperative contract is honoured only by rules that say so (rpg without creative). */
function cooperativeRules(game: AnyGame, rules: GameRules) { return rules.cooperative ? game.cooperative : undefined; }

/** Shared by local resolution and the authoritative host's post-damage entry.
 * Callbacks can record rewards/feedback but cannot change resolved health. */
export function notifyEliminations(game: AnyGame, match: MatchState<any, any, any>, eliminations: readonly ConfirmedElimination[], dtMs: number): void {
  if (!game.onEliminations || !eliminations.length) return;
  const health = match.players.map(({ hp, maxHp }) => ({ hp, maxHp }));
  try {
    game.onEliminations({ mode: match.mode, tags: match.rules.tags, world: match.world, players: match.players,
      tuning: match.tuning, dtMs, elapsedMs: match.elapsedMs }, eliminations);
  } finally {
    match.players.forEach((player, index) => Object.assign(player, health[index]));
  }
}

/** Append or reuse one stable session seat without restarting the shared world. */
export function joinMatch<W, P, I, T extends TuningValues>(game: GameLogic<W, P, I, T>, match: MatchState<W, P, T>, index = match.players.length, classId?: string, team?: number): void {
  if (cooperativeRules(game, match.rules)) throw new Error('Campaign roster is fixed until the next run');
  if (!match.rules.openSession || !Number.isInteger(index) || index < 0 || index > match.players.length
    || !validRosterCount(match.rules, Math.max(match.players.length, index + 1))) throw new Error('Invalid session participant slot');
  const seat = match.rules.teams ? team ?? index % match.rules.teams : undefined;
  if (seat !== undefined && (!Number.isInteger(seat) || seat < 0 || seat >= match.rules.teams)) throw new Error('Invalid team assignment');
  readyTerrain(game, match.tuning, match.players as MatchState['players'], match.world, true);
  const beforeWorld = stringify(match.world);
  const beforePlayers = match.players.map(player => stringify(player));
  const baseline = match.initialHealth[index] ?? match.initialHealth[0];
  const player = { index, active: true, classId: classId ?? game.playerClasses?.[index % game.playerClasses.length]?.id ?? '', ...(seat === undefined ? {} : { team: seat }), hp: baseline.maxHp, maxHp: baseline.maxHp,
    state: parse(match.initialStates[index] ?? match.initialStates[0]) as P };
  if(match.sceneRules){const roster=[...match.players];roster[index]=player;initialGameScene(match.sceneRules,roster);}
  match.players[index] = player;
  if (match.teams && seat !== undefined) match.teams[index] = seat;
  const ctx = { mode: match.mode, tags: match.rules.tags, world: match.world, players: match.players, tuning: match.tuning, random: randomFor };
  if (game.setupPlayer) game.setupPlayer(ctx, player);
  else game.respawnPlayer?.(ctx, player);
  if (stringify(match.world) !== beforeWorld || match.players.length !== Math.max(beforePlayers.length, index + 1)
    || beforePlayers.some((before, i) => i !== index && stringify(match.players[i]) !== before))
    throw new Error('setupPlayer must preserve the world and other participants');
  Object.assign(player, healthAtSetup(player.hp, player.maxHp, baseline));
  if (!match.rules.damage) player.hp = player.maxHp;
  match.initialStates[index] = stringify(player.state);
  match.initialHealth[index] = { hp: player.hp, maxHp: player.maxHp };
  match.respawnAt[index] = null;
  match.cooperative.reviveMs[index] = 0;
  match.cooperative.revivers[index] = -1;
  for (const key of match.cooperative.healed) if (key.startsWith(`${index}|`)) match.cooperative.healed.delete(key);
  // A new occupant must not inherit the departed occupant's consumed strikes.
  for (const key of match.struck) if (key.startsWith(`${index}|`)) match.struck.delete(key);
  match.entities = null;
  if(match.sceneRules&&match.sceneState){match.sceneState.ready[index]=false;match.sceneState.choices[index]='';restoreGameScene(match.sceneRules,match.world,match.sceneState);}
}

function sceneCopy(state:GameSceneState):GameSceneState{return parse(stringify(state)) as GameSceneState;}
function enterGameScene(game:AnyGame,match:MatchState<any,any,any>,previousScene?:GameSceneState):void{
  if(!match.sceneRules||!match.sceneState)return;
  restoreGameScene(match.sceneRules,match.world,match.sceneState);
  const health=match.players.map(({hp,maxHp})=>({hp,maxHp}));
  try{game.onSceneEnter?.({mode:match.mode,tags:match.rules.tags,world:match.world,players:match.players,tuning:match.tuning,random:randomFor,scene:sceneCopy(match.sceneState),...(previousScene?{previousScene:sceneCopy(previousScene)}:{})});}
  finally{match.players.forEach((player,index)=>Object.assign(player,health[index]));restoreGameScene(match.sceneRules,match.world,match.sceneState);}
}
/** Trusted post-damage entry and direct authored tests share the same transition code. */
export function commitGameScene(game:AnyGame,match:MatchState<any,any,any>,dtMs:number,inputs:readonly unknown[],allowTransition=true):void{
  const rules=match.sceneRules,state=match.sceneState;if(!rules||!state)return;
  restoreGameScene(rules,match.world,state);
  const health=match.players.map(({hp,maxHp})=>({hp,maxHp}));
  try{
  const ctx={mode:match.mode,tags:match.rules.tags,world:match.world,players:match.players,tuning:match.tuning,random:randomFor,inputs:inputs as never,dtMs,elapsedMs:match.elapsedMs,hits:match.hits,scene:sceneCopy(state)};
  const request=allowTransition?game.sceneRequest?.(ctx):undefined;
  // Results/round resets win over a scene interrupt, including automatic targets.
  const transition=advanceGameScene(rules,state,match.players,dtMs,request);
  if(transition&&allowTransition)enterGameScene(game,match,transition.previous);
  else if(transition){Object.assign(state,transition.previous);state.elapsedMs=transition.previous.elapsedMs;}
  }finally{match.players.forEach((player,index)=>Object.assign(player,health[index]));restoreGameScene(rules,match.world,state);}
}

/**
 * One fixed step, exactly as the server runs it. Returns the game's events.
 * The locked rules apply: health changes only by checked damage and permitted
 * contact recovery (health.ts), and once the mode's elimination
 * condition is met further steps change nothing unless the host explicitly
 * continues the finish window. That window advances the scene with health held.
 */
export function stepMatch<W, P, I, T extends TuningValues>(game: GameLogic<W, P, I, T>, match: MatchState<W, P, T>, inputs: readonly (I | undefined)[], dtMs: number, finishWindow = false, resolveInternalDamage = true, active?: readonly boolean[], authoritativeRespawns?: readonly number[], authoritativeReviveProgress?: readonly number[],sceneActions:readonly GameSceneAction[]=[]): GameEvent[] {
  if (inputs.length !== match.players.length) throw new Error('Inputs must match the participant count');
  if (active && active.length !== match.players.length) throw new Error('Active participants must match setup');
  if(match.sceneState&&match.sceneRules){
    match.players.forEach((player,index)=>Object.assign(player,{active:active?.[index]!==false}));
    restoreGameScene(match.sceneRules,match.world,match.sceneState);
    if(sceneDefinition(match.sceneRules,match.sceneState.id).kind!=='gameplay'&&!finishWindow){
      const health=match.players.map(({hp,maxHp})=>({hp,maxHp}));
      const accepted=applyGameSceneActions(match.sceneRules,match.sceneState,match.players,sceneActions);
      match.elapsedMs=match.sceneState.gameplayMs;match.hits=[];match.entities=null;match.teamObjective=undefined;match.pendingTeamObjective=undefined;
      const neutral=match.players.map(()=>undefined) as PlayerList<I|undefined>;
      let events:GameEvent[]|void;
      try{events=game.sceneStep?.({mode:match.mode,tags:match.rules.tags,world:match.world,players:match.players,tuning:match.tuning,random:randomFor,inputs:neutral,dtMs,elapsedMs:match.elapsedMs,hits:[],scene:sceneCopy(match.sceneState),sceneActions:accepted});
        match.voice=game.voiceState?.({mode:match.mode,tags:match.rules.tags,world:match.world,players:match.players,tuning:match.tuning,dtMs,elapsedMs:match.elapsedMs})??undefined;
        commitGameScene(game,match,dtMs,neutral);}
      finally{match.players.forEach((player,index)=>Object.assign(player,health[index]));restoreGameScene(match.sceneRules,match.world,match.sceneState);}
      return Array.isArray(events)?events:[];
    }
  }
  if(game.rounds&&match.roundState&&resolveInternalDamage&&match.roundState.phase!==0){
    match.elapsedMs+=dtMs;
    if(match.sceneState&&match.sceneRules){match.sceneState.elapsedMs+=dtMs;match.sceneState.gameplayMs+=dtMs;restoreGameScene(match.sceneRules,match.world,match.sceneState);}
    if(advanceRound(match.roundState,game.rounds,dtMs,match.players,match.teams!))restartRound(game,match,match.roundState);
    (match.world as any)[game.rounds.stateField]={...match.roundState};return [];
  }
  if (match.outcome || (!game.rounds&&matchFinished(match.players, match.mode, match.rules, match.teams) && !finishWindow)) {
    match.entities = null;
    match.hits = [];
    return [];
  }
  match.elapsedMs += dtMs;
  const cooperative = cooperativeRules(game, match.rules);
  const currentHealth = match.players.map(({ hp, maxHp }) => ({ hp, maxHp }));
  const session = resolveInternalDamage ? sessionHealth(match.mode, currentHealth, match.respawnAt, match.elapsedMs, dtMs, active, !!cooperative, match.rules)
    : { health: currentHealth, respawned: authoritativeRespawns ?? [] };
  // The authoritative host applies survival hunger itself before supplying health.
  const before = resolveInternalDamage && !finishWindow ? attrition(session.health, match.rules, dtMs, active) : session.health;
  match.players.forEach((fighter, i) => Object.assign(fighter, before[i], { active: active?.[i] !== false,
    ...(cooperative ? { reviveProgress: authoritativeReviveProgress?.[i] ?? match.reviveProgress?.[i] ?? 0 } : {}) }));
  readyTerrain(game, match.tuning, match.players as MatchState['players'], match.world, session.respawned.length > 0);
  for (const index of session.respawned) {
    const fighter = match.players[index];
    if (!match.rules.respawnMs || !fighter || active?.[index] === false) continue;
    if (game.respawnPlayer) game.respawnPlayer({ mode: match.mode, tags: match.rules.tags, world: match.world, players: match.players, tuning: match.tuning, random: randomFor }, fighter);
    else fighter.state = parse(match.initialStates[index]);
  }
  // A respawn callback can place a participant; it cannot alter locked health.
  match.players.forEach((fighter, i) => Object.assign(fighter, before[i]));
  const alive = before.map(player => player.hp > 0);
  // Eliminated competitors cannot keep moving through inertia or feature hooks.
  const eliminated = match.players.map((player, index) => (!alive[index] && (match.rules.oneLife || match.rules.openSession)) || active?.[index] === false ? stringify(player.state) : undefined);
  const events = game.step({
    mode: match.mode,
    tags: match.rules.tags,
    world: match.world,
    players: match.players,
    inputs: inputs.map((input, index) => alive[index] ? input ?? undefined : undefined) as PlayerList<I | undefined>,
    tuning: match.tuning,
    dtMs,
    elapsedMs: match.elapsedMs,
    random:randomFor,
    hits: match.hits,
  });
  if(game.rounds&&match.roundState)(match.world as any)[game.rounds.stateField]={...match.roundState};
  // Health the game changed itself doesn't count: only damage entities hurt.
  match.players.forEach((fighter, i) => {
    Object.assign(fighter, before[i]);
    if (eliminated[i] !== undefined) fighter.state = parse(eliminated[i]);
  });
  const entityContext = { mode: match.mode, tags: match.rules.tags, world: match.world, players: match.players, tuning: match.tuning, dtMs, elapsedMs: match.elapsedMs };
  match.entities = readEntities(game.entities?.(entityContext), match.players.length);
  match.objectiveComplete = !!cooperative && game.objectiveComplete?.(entityContext) === true;
  // Team objectives are content's call; the host validates the index and ends the round.
  const objective = match.rules.teams && !finishWindow ? game.teamObjective?.(entityContext) : undefined;
  match.teamObjective = Number.isInteger(objective) && (objective as number) >= 0 && (objective as number) < match.rules.teams ? objective as number : undefined;
  const pending=game.pendingTeamObjective?.(entityContext);
  match.pendingTeamObjective=Number.isInteger(pending)&&(pending as number)>=0&&(pending as number)<match.rules.teams?pending as number:undefined;
  // Per-player voice state (channels, effects, silence) is plain data the host validates and syncs.
  match.voice = game.voiceState ? game.voiceState(entityContext) ?? undefined : undefined;
  // Standalone tests/training resolve here. The authoritative server supplies
  // its previous hits and resolves these checked entities outside the VM once.
  if (resolveInternalDamage) {
    const { damage, hits } = resolveDamage(match.rules.damage ? match.entities : null, match.struck, dtMs, alive, undefined, match.teams);
    match.players.forEach((fighter, i) => Object.assign(fighter, finishWindow ? before[i] : healthAfterDamage(before[i], damage[i])));
    match.hits = hits;
    if (match.rules.healing && !cooperative && !finishWindow) {
      const recovered = contactHealing(match.players, match.entities, match.cooperative.healed, active, damage, match.teams);
      match.players.forEach((fighter, i) => Object.assign(fighter, recovered[i]));
    }
    if (cooperative && !finishWindow) {
      const recovery = cooperativeRecovery(match.players, match.entities, inputs, cooperative.reviveInput, dtMs, match.cooperative, active, damage);
      match.players.forEach((fighter, i) => Object.assign(fighter, recovery.health[i], { reviveProgress: recovery.reviveProgress[i] }));
      match.reviveProgress = recovery.reviveProgress;
      match.outcome = cooperativeOutcome(recovery.health, match.objectiveComplete, active);
    }
    if (!finishWindow && game.onEliminations) notifyEliminations(game, match, confirmedEliminations(before, match.players, hits), dtMs);
    if (match.rules.openSession) retireSessionStrikes(match.entities, match.struck);
    if(game.rounds&&match.roundState&&!finishWindow){
      advanceRound(match.roundState,game.rounds,dtMs,match.players,match.teams!,match.teamObjective,match.pendingTeamObjective);
      match.teamObjective=match.roundState.phase===2&&match.roundState.winner>=0?match.roundState.winner:undefined;
      (match.world as any)[game.rounds.stateField]={...match.roundState};
    }
  } else {
    match.hits = [];
  }
  if(match.sceneRules&&match.sceneState&&resolveInternalDamage)commitGameScene(game,match,dtMs,inputs,!finishWindow&&!match.outcome&&match.teamObjective===undefined&&(!match.roundState||match.roundState.phase===0)&&!matchFinished(match.players,match.mode,match.rules,match.teams));
  if(match.sceneRules&&match.sceneState)restoreGameScene(match.sceneRules,match.world,match.sceneState);
  return Array.isArray(events) ? events : [];
}
