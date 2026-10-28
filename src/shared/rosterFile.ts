import { MAX_MATCH_PLAYERS, MAX_TEAMS } from './gameModes.ts';
import { ContractError, parseRoster, type RosterDeclaration } from './shapes.ts';
import { schemaErrors, type TuningSchema } from './tuningSchema.ts';

/** The roster a game declares lives in a JSON file beside its tuning (docs/game-tags.md), so the
 * editor's JSON form edits it and the connector's file tools treat it like any other file. Its
 * sibling schema carries the limits and descriptions the form shows. */
export const ROSTER_FILE = 'src/game/roster.json';
export const ROSTER_SCHEMA_FILE = 'src/game/roster.schema.json';
/** What the shipped roster.schema.json says, for a game whose copy is missing or broken. */
export const ROSTER_SCHEMA: TuningSchema = { fields: {
  players: { optional: true, integer: true, pair: true, minimum: 1, maximum: MAX_MATCH_PLAYERS, default: [2, 8] },
  teams: { optional: true, integer: true, minimum: 0, maximum: MAX_TEAMS, default: 2 },
  teamSize: { optional: true, integer: true, minimum: 1, maximum: MAX_MATCH_PLAYERS, default: 2 },
} };

/** The declaration in the file, validated exactly as the contract validates it: a build fails with a
 * ContractError naming the field. A missing file, or an empty object, declares nothing. */
export function readRosterFile(source: string | undefined): RosterDeclaration | undefined {
  if (source === undefined) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new ContractError(`${ROSTER_FILE}: expected a JSON object`); }
  const roster = parseRoster(raw);
  return Object.keys(roster).length ? roster : undefined;
}

/** What the editor's form shows for the file: the schema's limits plus the contract's own rules
 * (one team, a team size that does not fit, unknown fields), keyed by field like the schema errors. */
export function rosterErrors(source: string, schema: TuningSchema = ROSTER_SCHEMA): Record<string, string> {
  const errors = schemaErrors(source, schema);
  if (errors['']) return errors;
  try { readRosterFile(source); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const field = /^roster\.([A-Za-z]+): (.*)$/.exec(message);
    const key = field ? field[1] : '';
    if (!errors[key]) errors[key] = field ? field[2] : message.replace(/^roster: /, '');
  }
  return errors;
}
