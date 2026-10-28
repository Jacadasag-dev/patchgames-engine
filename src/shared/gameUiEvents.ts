import type { GameUiEvent } from './gameUi.ts';

export const GAME_UI_MAX_EVENTS = 32;
const fields = new Set(['panel', 'name', 'value', 'item', 'source', 'target', 'index', 'sceneSequence', 'x', 'y', 'rotated']);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 96 && !/[\p{Cc}\p{Cf}]/u.test(value);

/** Copy bounded plain intents at both the browser and QuickJS boundaries. */
export function conformGameUiEvent(value: unknown): GameUiEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !fields.has(key)) || !identifier(raw.panel) || !identifier(raw.name)) return null;
  const event: GameUiEvent = { panel: raw.panel, name: raw.name };
  for (const key of ['item', 'source', 'target'] as const) {
    if (raw[key] === undefined) continue;
    if (!identifier(raw[key])) return null;
    event[key] = raw[key];
  }
  for (const key of ['value', 'index', 'x', 'y'] as const) {
    const number = raw[key];
    if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > 1_000_000
      || key === 'index' && (!Number.isInteger(number) || number < 0)) return null;
    event[key] = number;
  }
  if (raw.rotated !== undefined) {
    if (typeof raw.rotated !== 'boolean') return null;
    event.rotated = raw.rotated;
  }
  if(raw.sceneSequence!==undefined){
    if(typeof raw.sceneSequence!=='number'||!Number.isInteger(raw.sceneSequence)||raw.sceneSequence<1||raw.sceneSequence>4294967295)return null;
    event.sceneSequence=raw.sceneSequence;
  }
  return event;
}

export function conformGameUiEvents(value: unknown): GameUiEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, GAME_UI_MAX_EVENTS).flatMap(item => {
    const event = conformGameUiEvent(item);
    return event ? [event] : [];
  });
}
