/** Engine-owned scene lifecycle. Games declare content; hosts own clocks and transitions. */
export type GameSceneKind = 'gameplay' | 'selection' | 'meeting' | 'cinematic';
export interface GameSceneChoice { id: string; label: string; description?: string }
export interface GameSceneDefinition {
  id: string; kind: GameSceneKind; label?: string; next?: string; transitions?: readonly string[];
  /** Blocked scenes always have a finite fallback and a next scene. */
  durationMs?: number; minimumMs?: number; choices?: readonly GameSceneChoice[];
  uniqueChoices?: 'none' | 'team' | 'all'; skippable?: boolean;
}
export interface GameSceneRules { stateField: string; initial: string; definitions: readonly GameSceneDefinition[] }
export interface GameSceneState { id: string; sequence: number; elapsedMs: number; returnTo: string; ready: boolean[]; choices: string[]; gameplayMs: number }
export interface GameSceneSnapshot extends GameSceneState { kind: GameSceneKind; label: string; definition: GameSceneDefinition }
export type GameSceneActionKind = 'choose' | 'ready' | 'unready' | 'skip' | 'custom';
export interface GameSceneClientAction { sequence: number; action: GameSceneActionKind; value?: string }
export interface GameSceneAction extends GameSceneClientAction { player: number }
export interface GameSceneParticipant { active?: boolean; team?: number }
export const sceneStateShape = { id: 'string', sequence: 'uint32', elapsedMs: 'number', returnTo: 'string', ready: ['boolean'], choices: ['string'], gameplayMs: 'number' } as const;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fail = (message: string): never => { throw new Error(`scenes: ${message}`); };
const cleanText=(value:string)=>!/[\u0000-\u001f\u007f]/u.test(value);
const jsonBytes=(value:unknown)=>{let bytes=0;for(const character of JSON.stringify(value)){const point=character.codePointAt(0)!;bytes+=point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;}return bytes;};

export function parseSceneRules(raw: unknown): GameSceneRules | undefined {
  if (raw === undefined) return;
  if (!record(raw) || Object.keys(raw).some(key => !['stateField', 'initial', 'definitions'].includes(key))
    || typeof raw.stateField !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(raw.stateField) || !identifier(raw.initial)
    || !Array.isArray(raw.definitions) || raw.definitions.length < 1 || raw.definitions.length > 32) fail('expected stateField, initial and 1–32 definitions');
  const rules = raw as unknown as GameSceneRules;
  if(['constructor','prototype','__proto__'].includes(rules.stateField))fail('stateField must be an ordinary world field');
  if(jsonBytes(rules)>65536)fail('declaration exceeds the 64 KiB metadata budget');
  const ids = new Set<string>();
  for (const definition of rules.definitions) {
    if (!record(definition) || Object.keys(definition).some(key => !['id', 'kind', 'label', 'next', 'transitions', 'durationMs', 'minimumMs', 'choices', 'uniqueChoices', 'skippable'].includes(key))
      || !identifier(definition.id) || ids.has(definition.id) || !['gameplay', 'selection', 'meeting', 'cinematic'].includes(definition.kind)) fail('definitions require unique IDs and valid kinds');
    ids.add(definition.id);
    if (definition.label !== undefined && (typeof definition.label !== 'string' || !definition.label.length || definition.label.length > 96 || !cleanText(definition.label))) fail(`${definition.id}: invalid label`);
    if (definition.durationMs !== undefined && (!Number.isFinite(definition.durationMs) || definition.durationMs < 100 || definition.durationMs > 300000)) fail(`${definition.id}: durationMs must be 100–300000`);
    if (definition.minimumMs !== undefined && (!Number.isFinite(definition.minimumMs) || definition.minimumMs < 0 || definition.minimumMs > (definition.durationMs ?? 300000))) fail(`${definition.id}: invalid minimumMs`);
    if (definition.kind !== 'gameplay' && (definition.durationMs === undefined || definition.next === undefined)) fail(`${definition.id}: blocked scenes require durationMs and next fallback`);
    if(definition.next!==undefined&&typeof definition.next!=='string')fail(`${definition.id}: next must name a scene or $return`);
    if (definition.skippable !== undefined && typeof definition.skippable !== 'boolean') fail(`${definition.id}: invalid skippable`);
    if (definition.uniqueChoices !== undefined && !['none', 'team', 'all'].includes(definition.uniqueChoices)) fail(`${definition.id}: invalid uniqueChoices`);
    if (definition.choices !== undefined) {
      if (definition.kind !== 'selection' || !Array.isArray(definition.choices) || !definition.choices.length || definition.choices.length > 128) fail(`${definition.id}: choices require a selection with 1–128 entries`);
      const choices = new Set<string>();
      for (const choice of definition.choices) {
        if (!record(choice) || Object.keys(choice).some(key => !['id', 'label', 'description'].includes(key)) || !identifier(choice.id) || choices.has(choice.id)
          || typeof choice.label !== 'string' || !choice.label.length || choice.label.length > 96 || !cleanText(choice.label) || choice.description !== undefined && (typeof choice.description !== 'string' || choice.description.length > 512 || !cleanText(choice.description))) fail(`${definition.id}: invalid or duplicate choice`);
        choices.add(choice.id);
      }
    }
    if (definition.uniqueChoices && definition.uniqueChoices !== 'none' && !definition.choices?.length) fail(`${definition.id}: unique choices require declared choices`);
    if (definition.transitions !== undefined && (!Array.isArray(definition.transitions) || definition.transitions.length > 32 || new Set(definition.transitions).size !== definition.transitions.length)) fail(`${definition.id}: invalid transitions`);
  }
  if (!ids.has(rules.initial) || !rules.definitions.some(definition => definition.kind === 'gameplay')) fail('initial must exist and at least one gameplay scene is required');
  for (const definition of rules.definitions) for (const target of [...definition.transitions ?? [], ...(definition.next!==undefined ? [definition.next] : [])]) {
    if (target !== '$return' && (!identifier(target) || !ids.has(target))) fail(`${definition.id}: unknown target ${String(target)}`);
    if(target==='$return'&&definition.kind==='gameplay')fail(`${definition.id}: gameplay scenes cannot return to themselves`);
    if (target === definition.id) fail(`${definition.id}: self transitions are not allowed`);
  }
  return copy(rules);
}

export function sceneDefinition(rules: GameSceneRules, id: string): GameSceneDefinition {
  return rules.definitions.find(definition => definition.id === id) ?? fail(`unknown scene ${id}`);
}
export function readGameScene(rules: GameSceneRules | undefined, world: unknown): GameSceneSnapshot | undefined {
  if (!rules || !record(world)) return;
  const state = world[rules.stateField] as GameSceneState | undefined;
  if (!state || !identifier(state.id) || !Number.isSafeInteger(state.sequence) || state.sequence < 1 || state.sequence>0xffffffff || !Number.isFinite(state.elapsedMs) || state.elapsedMs < 0 || state.elapsedMs>Number.MAX_SAFE_INTEGER
    || !Number.isFinite(state.gameplayMs) || state.gameplayMs < 0 || state.gameplayMs>Number.MAX_SAFE_INTEGER || !identifier(state.returnTo)
    || !Array.isArray(state.ready) || state.ready.length>32 || state.ready.some(value=>typeof value!=='boolean')
    || !Array.isArray(state.choices) || state.choices.length>32 || state.choices.length!==state.ready.length || state.choices.some(value=>value!==''&&!identifier(value))) return;
  const definition = rules.definitions.find(item => item.id === state.id); if (!definition) return;
  if(!rules.definitions.some(item=>item.id===state.returnTo&&item.kind==='gameplay'))return;
  if(state.choices.some(value=>value!==''&&!definition.choices?.some(choice=>choice.id===value)))return;
  return { ...copy(state), kind: definition.kind, label: definition.label ?? definition.id, definition: copy(definition) };
}
export function sceneGameplayActive(rules: GameSceneRules | undefined, world: unknown): boolean { return !rules || readGameScene(rules, world)?.kind === 'gameplay'; }
export function conformSceneClientAction(raw: unknown): GameSceneClientAction | undefined {
  if (!record(raw) || Object.keys(raw).some(key => !['sequence', 'action', 'value'].includes(key)) || !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1 || (raw.sequence as number)>0xffffffff
    || !['choose', 'ready', 'unready', 'skip', 'custom'].includes(raw.action as string)
    || raw.value !== undefined && (typeof raw.value !== 'string' || raw.value.length > 96 || /[\u0000-\u001f]/u.test(raw.value))) return;
  return { sequence: raw.sequence as number, action: raw.action as GameSceneActionKind, ...(raw.value === undefined ? {} : { value: raw.value as string }) };
}
export function initialGameScene(rules: GameSceneRules, participants: readonly GameSceneParticipant[]): GameSceneState {
  for (const definition of rules.definitions) if (definition.uniqueChoices && definition.uniqueChoices !== 'none') {
    const groups = new Map<number, number>();
    for (const participant of participants) if (participant.active !== false) {
      const key = definition.uniqueChoices === 'team' ? participant.team ?? -1 : -1; groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    if ([...groups.values()].some(count => count > (definition.choices?.length ?? 0))) fail(`${definition.id}: not enough unique choices for the roster`);
  }
  return { id: rules.initial, sequence: 1, elapsedMs: 0, returnTo: rules.definitions.find(definition => definition.kind === 'gameplay')!.id,
    ready: participants.map(() => false), choices: participants.map(() => ''), gameplayMs: 0 };
}
export function restoreGameScene(rules: GameSceneRules, world: unknown, state: GameSceneState): void {
  if (!record(world)) fail('world must be an object'); (world as Record<string,unknown>)[rules.stateField] = copy(state);
}
function choiceAvailable(definition: GameSceneDefinition, state: GameSceneState, participants: readonly GameSceneParticipant[], player: number, choice: string): boolean {
  if (!definition.choices?.some(item => item.id === choice)) return false;
  if (!definition.uniqueChoices || definition.uniqueChoices === 'none') return true;
  return !participants.some((participant, index) => index !== player && participant.active !== false && state.choices[index] === choice
    && (definition.uniqueChoices === 'all' || participant.team === participants[player].team));
}
/** Applies only current-instance, active-seat actions; invalid/stale actions are harmless. */
export function applyGameSceneActions(rules: GameSceneRules, state: GameSceneState, participants: readonly GameSceneParticipant[], raw: readonly GameSceneAction[] = []): GameSceneAction[] {
  const definition = sceneDefinition(rules, state.id), accepted: GameSceneAction[] = [];
  state.ready = participants.map((_, index) => state.ready[index] === true); state.choices = participants.map((_, index) => state.choices[index] ?? '');
  if (definition.kind === 'gameplay') return accepted;
  for (const candidate of raw.slice(0, 64)) {
    const action = conformSceneClientAction({ sequence: candidate.sequence, action: candidate.action, ...(candidate.value === undefined ? {} : { value: candidate.value }) });
    const player = candidate.player;
    if (!action || action.sequence !== state.sequence || !Number.isInteger(player) || !participants[player] || participants[player].active === false) continue;
    if (action.action === 'choose') {
      if (definition.kind !== 'selection' || !action.value || state.ready[player] || !choiceAvailable(definition, state, participants, player, action.value)) continue;
      state.choices[player] = action.value;
    } else if (action.action === 'ready') {
      if (definition.choices?.length && !choiceAvailable(definition, state, participants, player, state.choices[player])) continue;
      state.ready[player] = true;
    } else if (action.action === 'unready') state.ready[player] = false;
    else if (action.action === 'skip') { if (!definition.skippable || state.elapsedMs < (definition.minimumMs ?? 0)) continue; state.ready[player] = true; }
    accepted.push({ player, ...action });
  }
  return accepted;
}
/** One transition maximum per host tick. Timeout fills unique selections deterministically. */
export function advanceGameScene(rules: GameSceneRules, state: GameSceneState, participants: readonly GameSceneParticipant[], dtMs: number, request?: string): { previous: GameSceneState; current: GameSceneState } | undefined {
  if (!Number.isFinite(dtMs) || dtMs < 0 || dtMs > 1000) fail('tick duration must be 0–1000ms');
  const definition = sceneDefinition(rules, state.id);
  state.elapsedMs += dtMs; if (definition.kind === 'gameplay') state.gameplayMs += dtMs;
  const active = participants.map((participant, index) => ({ participant, index })).filter(({ participant }) => participant.active !== false);
  const timedOut = definition.durationMs !== undefined && state.elapsedMs >= definition.durationMs;
  const allReady = active.length > 0 && active.every(({ index }) => state.ready[index]);
  const completed = definition.kind !== 'gameplay' && state.elapsedMs >= (definition.minimumMs ?? 0) && allReady && (definition.kind === 'selection' || definition.skippable === true);
  let target = request;
  if (target !== undefined && (typeof target !== 'string' || ![...definition.transitions ?? [], ...(definition.next ? [definition.next] : [])].includes(target))) fail(`${definition.id}: transition to ${String(target)} was not declared`);
  if (timedOut || completed) target = definition.next;
  if (!target) return;
  if (timedOut && definition.kind === 'selection' && definition.choices?.length) {
    for (const { index } of active) if (!choiceAvailable(definition, state, participants, index, state.choices[index])) {
      const choice = definition.choices.find(item => choiceAvailable(definition, state, participants, index, item.id));
      if (!choice) fail(`${definition.id}: timeout could not assign unique choices`); state.choices[index] = choice!.id;
    }
  }
  const previous = copy(state), id = target === '$return' ? state.returnTo : target;
  const next = sceneDefinition(rules, id);
  if (id === state.id) fail(`${definition.id}: return target must differ`);
  if(state.sequence>=0xffffffff)fail('scene sequence exhausted; start a fresh match');
  state.id = id; state.sequence++; state.elapsedMs = 0;
  state.returnTo = definition.kind === 'gameplay' ? definition.id : state.returnTo;
  state.ready = participants.map(() => false); state.choices = participants.map(() => '');
  // A gameplay scene is the new restoration point for future interrupts.
  if (next.kind === 'gameplay') state.returnTo = next.id;
  return { previous, current: copy(state) };
}
