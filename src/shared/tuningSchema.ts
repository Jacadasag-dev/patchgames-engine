export const TUNING_SCHEMA_FILE = 'src/game/tuning.schema.json';
export interface TuningField { minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; unit?: string; description?: string;
  /** The file may leave the field out (tuning files carry every schema field). */
  optional?: boolean;
  integer?: boolean;
  /** The field also accepts a [min, max] pair whose ends obey the limits (the roster's players). */
  pair?: boolean;
  /** What the editor inserts when it adds an absent optional field. */
  default?: number | [number, number] }
export interface TuningSchema { fields: Record<string, TuningField>; relations?: { field: string; atLeast: string; factor: number; message: string }[] }
/** A custom game's keys belong to that game, independent of the seasonal Duel. */
export function parseGameTuning(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 128
    || !Object.entries(raw).every(([key,value]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && typeof value === 'number' && Number.isFinite(value))
    || !('maxHp' in raw) || typeof raw.maxHp !== 'number' || raw.maxHp <= 0) throw new Error('Invalid game tuning');
  return Object.fromEntries(Object.entries(raw)) as Record<string, number>;
}
/** Declarative data only. Never evaluate creator-provided validation code on the host. */
export function readTuningSchema(source: string | undefined): TuningSchema | undefined {
  if (source === undefined) return undefined;
  const schema = JSON.parse(source) as TuningSchema;
  if (!schema || !schema.fields || typeof schema.fields !== 'object' || Array.isArray(schema.fields)
    || Object.keys(schema.fields).length > 128) throw new Error('Invalid settings schema.');
  for (const [key, field] of Object.entries(schema.fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !field || typeof field !== 'object' || Array.isArray(field)) throw new Error('Invalid settings field.');
    for (const name of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
      if (field[name] !== undefined && (typeof field[name] !== 'number' || !Number.isFinite(field[name]))) throw new Error('Invalid settings limit.');
    }
    if ((field.unit !== undefined && (typeof field.unit !== 'string' || field.unit.length > 30))
      || (field.description !== undefined && (typeof field.description !== 'string' || field.description.length > 500))) throw new Error('Invalid settings description.');
    for (const name of ['optional', 'integer', 'pair'] as const) {
      if (field[name] !== undefined && typeof field[name] !== 'boolean') throw new Error('Invalid settings flag.');
    }
    if (field.default !== undefined && !(finite(field.default) || (field.pair && Array.isArray(field.default) && field.default.length === 2 && field.default.every(finite))))
      throw new Error('Invalid settings default.');
  }
  if (schema.relations !== undefined && (!Array.isArray(schema.relations) || schema.relations.length > 128)) throw new Error('Invalid settings relationships.');
  for (const rule of schema.relations ?? []) {
    if (!rule || !Object.hasOwn(schema.fields, rule.field) || !Object.hasOwn(schema.fields, rule.atLeast)
      || typeof rule.factor !== 'number' || !Number.isFinite(rule.factor) || typeof rule.message !== 'string' || rule.message.length > 500) throw new Error('Invalid settings relationship.');
  }
  return schema;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function fieldError(n: unknown, field: TuningField | undefined): string | undefined {
  if (!finite(n)) return 'Enter a finite number.';
  if (!field) return undefined;
  if (field.integer && !Number.isInteger(n)) return 'Enter a whole number.';
  if (field.minimum !== undefined && n < field.minimum) return `Use ${field.minimum} or more.`;
  if (field.maximum !== undefined && n > field.maximum) return `Use ${field.maximum} or less.`;
  if (field.exclusiveMinimum !== undefined && n <= field.exclusiveMinimum) return `Use a value greater than ${field.exclusiveMinimum}.`;
  if (field.exclusiveMaximum !== undefined && n >= field.exclusiveMaximum) return `Use a value less than ${field.exclusiveMaximum}.`;
  return undefined;
}
/** Errors of a JSON settings file against its sibling schema, keyed by field ('' for the whole file):
 * every schema field is present unless optional, numbers obey its limits, a pair field may instead be
 * a [min, max] range whose ends obey them, and keys the schema does not know must still be finite
 * numbers. The editor shows these in its form; the contract's own rules come on top (rosterErrors). */
export function schemaErrors(source: string, schema?: TuningSchema): Record<string, string> {
  let value: Record<string, unknown>;
  try { value = JSON.parse(source); } catch { return { '': 'Enter valid JSON to update the preview.' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { '': 'Settings must be a JSON object.' };
  const errors: Record<string, string> = Object.create(null);
  for (const key of new Set([...Object.keys(value), ...Object.keys(schema?.fields ?? {})])) {
    const n = value[key], field = schema?.fields[key];
    if (n === undefined) { if (!field?.optional) errors[key] = 'Enter a finite number.'; continue; }
    if (field?.pair && Array.isArray(n)) {
      if (n.length !== 2) { errors[key] = 'Enter a count or a [min, max] pair.'; continue; }
      const message = fieldError(n[0], field) ?? fieldError(n[1], field);
      if (message) errors[key] = message;
      else if ((n[0] as number) > (n[1] as number)) errors[key] = 'The minimum must not exceed the maximum.';
      continue;
    }
    const message = fieldError(n, field);
    if (message) errors[key] = message;
  }
  for (const rule of schema?.relations ?? []) {
    if (typeof value[rule.field] === 'number' && typeof value[rule.atLeast] === 'number'
      && (value[rule.field] as number) < (value[rule.atLeast] as number) * rule.factor) errors[rule.field] = rule.message;
  }
  return errors;
}
/** Tuning files: the schema's rules plus the health floor live tuning needs. */
export function tuningErrors(source: string, schema?: TuningSchema): Record<string, string> {
  const errors = schemaErrors(source, schema);
  try {
    const value = JSON.parse(source) as Record<string, unknown>;
    if (value && typeof value === 'object' && finite(value.maxHp) && value.maxHp <= 0 && !errors.maxHp) errors.maxHp = 'Health must be greater than zero.';
  } catch { /* already reported */ }
  return errors;
}
