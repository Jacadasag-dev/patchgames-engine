import type {SourceTree} from './customGames.ts';
import {sourcePath} from './gameSourcePath.ts';

export const FEATURE_DIRECTORY = 'src/game/features/';
export const FEATURE_ORDER_PATH = 'src/game/feature-order.json';
export const FEATURE_API_VERSION = 1;
export const MAX_FEATURES = 64;
export interface FeatureManifest {
  api: 1;
  id: string;
  name: string;
  requires?: string[];
  config?: Record<string, number | boolean | string>;
}
export interface SourceFeature {
  manifest: FeatureManifest;
  directory: string;
  /** Complete source paths; no live imports or evaluated code. */
  files: SourceTree;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validFeatureId = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);
export const featurePath = (path: string) => path.startsWith(FEATURE_DIRECTORY) || path === FEATURE_ORDER_PATH;
export function featureIdForPath(path: string): string | undefined {
  if (!path.startsWith(FEATURE_DIRECTORY)) return;
  const id = path.slice(FEATURE_DIRECTORY.length).split('/')[0];
  if (!validFeatureId(id) || !sourcePath(path)) throw new Error(`Invalid feature source path: ${path}`);
  return id;
}
export function parseFeatureManifest(value: unknown, expectedId?: string): FeatureManifest {
  if (!record(value) || value.api !== FEATURE_API_VERSION) throw new Error('Feature manifest must declare api: 1.');
  if (!validFeatureId(value.id) || expectedId !== undefined && value.id !== expectedId) throw new Error('Feature id must match its folder and use a lowercase slug of 1–64 characters.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(value.name)) throw new Error(`Feature ${value.id} needs a name of 1–100 visible characters.`);
  const allowed = new Set(['api', 'id', 'name', 'requires', 'config']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Feature ${value.id} contains an unsupported manifest field.`);
  if (value.requires !== undefined && (!Array.isArray(value.requires) || value.requires.length > MAX_FEATURES || value.requires.some(id => !validFeatureId(id) || id === value.id) || new Set(value.requires).size !== value.requires.length)) throw new Error(`Feature ${value.id} requires must contain distinct feature ids, excluding itself.`);
  if (value.config !== undefined && (!record(value.config) || Object.keys(value.config).length > 32 || Object.entries(value.config).some(([key, item]) => !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) || !['number', 'boolean', 'string'].includes(typeof item) || typeof item === 'number' && !Number.isFinite(item) || typeof item === 'string' && item.length > 128))) throw new Error(`Feature ${value.id} config must contain up to 32 named finite numbers, booleans, or short strings.`);
  return {api: 1, id: value.id, name: value.name.trim(), ...(value.requires === undefined ? {} : {requires: [...value.requires as string[]]}), ...(value.config === undefined ? {} : {config: {...value.config as FeatureManifest['config']}})};
}
export function readFeatureOrder(files: SourceTree): string[] {
  if (!Object.hasOwn(files, FEATURE_ORDER_PATH)) return [];
  let value: unknown;
  try {value = JSON.parse(files[FEATURE_ORDER_PATH]);} catch {throw new Error('Feature order must contain valid JSON.');}
  if (!record(value) || value.api !== 1 || !Array.isArray(value.order) || value.order.length > MAX_FEATURES || value.order.some(id => !validFeatureId(id)) || new Set(value.order).size !== value.order.length || Object.keys(value).some(key => key !== 'api' && key !== 'order')) throw new Error('Feature order must contain api: 1 and up to 64 distinct feature ids.');
  return value.order as string[];
}
/** Structural validation shared by the editor, pack assembly, and isolated build. */
export function scanFeatures(files: SourceTree): SourceFeature[] {
  const groups = new Map<string, SourceTree>();
  for (const [path, source] of Object.entries(files)) {
    const id = featureIdForPath(path); if (!id) continue;
    if (typeof source !== 'string') throw new Error(`Invalid source for feature ${id}.`);
    const group = groups.get(id) ?? Object.create(null) as SourceTree;
    group[path] = source; groups.set(id, group);
  }
  if (groups.size > MAX_FEATURES) throw new Error(`A game supports up to ${MAX_FEATURES} features.`);
  const byId = new Map<string, SourceFeature>();
  for (const [id, group] of groups) {
    const directory = FEATURE_DIRECTORY + id + '/', manifestPath = directory + 'feature.json';
    if (!Object.hasOwn(group, manifestPath)) throw new Error(`Feature ${id} is missing feature.json.`);
    let value: unknown;
    try {value = JSON.parse(group[manifestPath]);} catch {throw new Error(`Feature ${id} has invalid manifest JSON.`);}
    const manifest = parseFeatureManifest(value, id);
    if (!Object.hasOwn(group, directory + 'logic.ts')) throw new Error(`Feature ${id} is missing logic.ts.`);
    byId.set(id, {manifest, directory, files: group});
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string, chain: string[]) => {
    if (visiting.has(id)) throw new Error(`Feature dependency cycle: ${[...chain, id].join(' → ')}.`);
    if (visited.has(id)) return;
    const feature = byId.get(id);
    if (!feature) throw new Error(`Feature ${chain.at(-1)} requires missing feature ${id}. Include its dependency when packaging or installing this feature.`);
    visiting.add(id);
    for (const required of feature.manifest.requires ?? []) visit(required, [...chain, id]);
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id, []);
  const order = readFeatureOrder(files).filter(id => byId.has(id));
  order.push(...[...byId.keys()].filter(id => !order.includes(id)).sort());
  return order.map(id => byId.get(id)!);
}
