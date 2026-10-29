import {parseMaterialGeneratorData} from './materialGeneratorData.ts';
import {parseMaterialPattern} from './materialPatterns.ts';
/** Dependency-free material recipe data validation for authoritative game logic.
 * Keep this parser equivalent to mediaRecipes.ts; parity tests cover defaults,
 * limits and each nested field. The renderer/editor retain their Zod schemas. */
import type { ResolvedTextureRecipe } from './mediaRecipes.ts';

type Layer = ResolvedTextureRecipe['layers'][number];
type Source = Layer['source'];
type Mask = NonNullable<Layer['mask']>;
type Data = Record<string, unknown>;
function object(value: unknown, allowed: readonly string[], label: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`${label} must be plain data with only supported fields.`);
  }
  return value as Data;
}
function number(value: unknown, min: number, max: number, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`${label} is outside its numeric bounds.`);
  return value;
}
function text(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.length || value.length > 120 || pattern && !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}
function pair<T>(value: unknown, parse: (entry: unknown) => T, label: string): [T, T] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} requires exactly two values.`);
  return [parse(value[0]), parse(value[1])];
}
const color = (value: unknown) => text(value, 'Texture color', /^#[\da-f]{6}$/i);
const assetId = (value: unknown) => text(value, 'Texture asset ID', /^[a-z\d][a-z\d._:/-]*$/i);
const seed = (value: unknown) => number(value, -2147483648, 2147483647, 'Texture seed', true);
const unit = (value: unknown) => number(value, 0, 1, 'Texture unit value');
function optional<T>(input: Data, key: string, parse: (value: unknown) => T): Record<string, T | undefined> {
  return Object.hasOwn(input, key) ? { [key]: input[key] === undefined ? undefined : parse(input[key]) } : {};
}
function source(input: unknown): Source {
  const value = object(input, ['kind', 'id', 'color', 'colors', 'scale', 'seed', 'recipe'], 'Texture source');
  if (value.kind === 'generator') { object(value,['kind','recipe'],'Generator source');return {kind:'generator',recipe:parseMaterialGeneratorData(value.recipe)}; }
  if (value.kind === 'asset') { object(value, ['kind', 'id'], 'Asset source'); return { kind: 'asset', id: assetId(value.id) }; }
  if (value.kind === 'solid') { object(value, ['kind', 'color'], 'Solid source'); return { kind: 'solid', color: color(value.color) }; }
  if (value.kind !== 'noise') throw new Error('Texture source kind is invalid.');
  object(value, ['kind', 'colors', 'scale', 'seed'], 'Noise source');
  return { kind: 'noise', colors: pair(value.colors, color, 'Noise colors'), scale: number(value.scale === undefined ? 8 : value.scale, 1, 64, 'Noise scale', true), ...optional(value, 'seed', seed) };
}
function mask(input: unknown): Mask {
  if(input&&typeof input==='object'&&(input as Data).kind==='pattern'){
    const value=object(input,['kind','pattern','tileMeters'],'Pattern mask');return{kind:'pattern',pattern:parseMaterialPattern(value.pattern),tileMeters:pair(value.tileMeters===undefined?[1,1]:value.tileMeters,v=>number(v,.002,100,'Pattern tile metres'),'Pattern tile metres')};
  }
  const value = object(input, ['kind', 'field', 'min', 'max', 'softness', 'invert', 'scale', 'seed'], 'Texture mask');
  const min = unit(value.min === undefined ? .35 : value.min), max = unit(value.max === undefined ? 1 : value.max);
  if (min > max) throw new Error('Mask min must be at most max.');
  return { kind: choice(value.kind, ['noise', 'height', 'slope'], 'Mask kind'), field: choice(value.field === undefined ? 'material' : value.field, ['material', 'surface'], 'Mask field'),
    min, max, softness: unit(value.softness === undefined ? .1 : value.softness), invert: boolean(value.invert === undefined ? false : value.invert, 'Mask invert'),
    scale: number(value.scale === undefined ? 8 : value.scale, 1, 64, 'Mask scale', true), ...optional(value, 'seed', seed) };
}
export function parseTextureLayerData(input: unknown): Layer {
  const value = object(input, ['name', 'source', 'blend', 'opacity', 'tint', 'repeat', 'mask', 'roughness', 'metalness', 'heightStrength'], 'Texture layer');
  return { ...optional(value, 'name', entry => text(entry, 'Layer name')), source: source(value.source),
    blend: choice(value.blend === undefined ? 'normal' : value.blend, ['normal', 'multiply', 'add'], 'Layer blend'), opacity: unit(value.opacity === undefined ? 1 : value.opacity),
    tint: color(value.tint === undefined ? '#ffffff' : value.tint), repeat: pair(value.repeat === undefined ? [1, 1] : value.repeat, entry => number(entry, .01, 64, 'Layer repeat'), 'Layer repeat'),
    ...optional(value, 'mask', mask), ...optional(value, 'roughness', unit), ...optional(value, 'metalness', unit),
    heightStrength: number(value.heightStrength === undefined ? 1 : value.heightStrength, 0, 2, 'Layer height strength') };
}
export function parseTextureRecipeData(input: unknown): ResolvedTextureRecipe {
  const value = object(input, ['kind', 'version', 'id', 'name', 'resolution', 'seed', 'layers', 'wetness', 'reliefScale', 'normalStrength'], 'Texture recipe');
  if (value.kind !== 'texture' || value.version !== 1) throw new Error('Texture recipe kind/version is invalid.');
  if (!Array.isArray(value.layers) || value.layers.length < 1 || value.layers.length > 8) throw new Error('Texture recipes need one to eight layers.');
  return { kind: 'texture', version: 1, ...optional(value, 'id', assetId), name: text(value.name, 'Texture name'),
    resolution: number(value.resolution === undefined ? 128 : value.resolution, 16, 512, 'Texture resolution', true), seed: seed(value.seed === undefined ? 1 : value.seed),
    layers: Array.from(value.layers, parseTextureLayerData), wetness: unit(value.wetness === undefined ? 0 : value.wetness),
    reliefScale: unit(value.reliefScale === undefined ? .02 : value.reliefScale), normalStrength: number(value.normalStrength === undefined ? 1 : value.normalStrength, 0, 8, 'Texture normal strength') };
}
