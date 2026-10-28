/** Serializable surface choices shared by buildings, terrain and asset families.
 * TextureRecipe remains the single blending language; no GPU work runs here. */
import type { ResolvedTextureRecipe, TextureLayer, TextureRecipe } from '../shared/mediaRecipes.ts';
import { parseTextureLayerData, parseTextureRecipeData } from '../shared/materialRecipeData.ts';

export interface SurfaceMaterial {
  texture: TextureRecipe;
  /** Physical metres per repetition, applied by the view to metre-based UVs. */
  tileSize?: [number, number];
  rotation?: number;
  tint?: string;
}
export interface SurfaceMaterialOverlay {
  id: string; layer: TextureLayer; probability?: number;
  /** Optional seeded opacity replaces layer.opacity. */
  opacity?: [number, number];
}
export type SurfaceMaterialInput = SurfaceMaterial | {
  palette: { id: string; weight?: number; material: SurfaceMaterial }[];
  /** Layer order is artistic intent and is preserved. Random choices use IDs. */
  overlays?: SurfaceMaterialOverlay[];
};
export interface ResolvedSurfaceMaterial {
  texture: ResolvedTextureRecipe; tileSize: [number, number]; rotation: number; tint: string; key: string;
}
export const SURFACE_MATERIAL_LIMITS = Object.freeze({ variants: 32, overlays: 8, layers: 8, keyLength: 512, tileSize: 1024 });
const trusted = new WeakSet<ResolvedSurfaceMaterial>();
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// Plain loops and the default code-unit key sort keep keys identical while
// avoiding per-entry callbacks in the sandbox interpreter. As with join(),
// an array element without JSON text contributes nothing.
function canonical(value: unknown): string {
  if (Array.isArray(value)) { let out = '['; for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + (canonical(value[i]) ?? ''); return out + ']'; }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>, names = Object.keys(record).sort(); let out = '{', first = true;
    for (let i = 0; i < names.length; i++) { const v = record[names[i]]; if (v === undefined) continue; out += (first ? '' : ',') + JSON.stringify(names[i]) + ':' + canonical(v); first = false; }
    return out + '}';
  }
  return JSON.stringify(value);
}
function hash(value: string, seed = 2166136261): number { let h = seed; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); return (h ^ h >>> 15) >>> 0; }
const materialKeys = new Map<string, string>();
/** hash(value, a) and hash(value, b) in one pass over the text. */
function hashPair(value: string, a: number, b: number): [number, number] {
  const imul = Math.imul, length = value.length;
  for (let i = 0; i < length; i++) { const c = value.charCodeAt(i); a = imul(a ^ c, 16777619); b = imul(b ^ c, 16777619); }
  const mix = (h: number) => { h ^= h >>> 16; h = imul(h, 0x7feb352d); return (h ^ h >>> 15) >>> 0; };
  return [mix(a), mix(b)];
}
const roll = (key: string) => hash(key) / 4294967296;
const snap = (value: number) => Math.round(value * 1e9) / 1e9 || 0;
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }
function material(input: SurfaceMaterial): Omit<ResolvedSurfaceMaterial, 'key'> {
  if (!plain(input) || !keys(input, ['texture', 'tileSize', 'rotation', 'tint'])) throw new Error('Surface material requires only texture, tileSize, rotation and tint.');
  const tile = input.tileSize ?? [1, 1], rotation = input.rotation ?? 0, tint = input.tint ?? '#ffffff';
  if (!Array.isArray(tile) || tile.length !== 2 || Array.from(tile).some(n => !finite(n) || n < .01 || n > 1024)) throw new Error('Surface tileSize requires two finite dimensions from .01 to 1024 metres.');
  if (!finite(rotation) || Math.abs(rotation) > Math.PI * 2) throw new Error('Surface rotation must be finite and within ±2π radians.');
  if (typeof tint !== 'string' || !/^#[0-9a-f]{6}$/i.test(tint)) throw new Error('Surface tint must be a six-digit hexadecimal color.');
  return { texture: parseTextureRecipeData(input.texture), tileSize: [snap(tile[0]), snap(tile[1])], rotation: snap(rotation), tint: tint.toLowerCase() };
}
/** Returns fresh editable data, retaining the palette and authored overlay order.
 * Recipes receive the existing renderer's validated defaults. Sparse, recursive,
 * unknown and unbounded fields are rejected rather than silently ignored. */
export function validateSurfaceMaterialInput(input: SurfaceMaterialInput): SurfaceMaterialInput {
  if (!plain(input)) throw new Error('Surface material input must be plain data.');
  if (!('palette' in input)) return material(input as SurfaceMaterial);
  if (!keys(input, ['palette', 'overlays']) || !Array.isArray(input.palette) || !input.palette.length || input.palette.length > 32) throw new Error('Surface palette requires 1–32 variants.');
  const ids = new Set<string>();
  const palette = Array.from(input.palette).map(entry => {
    if (!plain(entry) || !keys(entry, ['id', 'weight', 'material']) || !id(entry.id) || ids.has(entry.id)
      || entry.weight !== undefined && (!finite(entry.weight) || entry.weight <= 0 || entry.weight > 1e6)) throw new Error('Surface variants need unique stable IDs, positive bounded weights and materials.');
    ids.add(entry.id); return { id: entry.id, weight: entry.weight ?? 1, material: material(entry.material) };
  }).sort((a, b) => compare(a.id, b.id));
  if (input.overlays !== undefined && (!Array.isArray(input.overlays) || input.overlays.length > 8)) throw new Error('Surface materials support at most eight overlays.');
  const overlayIds = new Set<string>();
  const overlays = Array.from(input.overlays ?? []).map(overlay => {
    if (!plain(overlay) || !keys(overlay, ['id', 'layer', 'probability', 'opacity']) || !id(overlay.id) || overlayIds.has(overlay.id)
      || overlay.probability !== undefined && (!finite(overlay.probability) || overlay.probability < 0 || overlay.probability > 1)) throw new Error('Surface overlays need unique stable IDs and probabilities in [0,1].');
    if (overlay.opacity !== undefined && (!Array.isArray(overlay.opacity) || overlay.opacity.length !== 2
      || Array.from(overlay.opacity).some(n => !finite(n) || n < 0 || n > 1) || overlay.opacity[0] > overlay.opacity[1])) throw new Error('Overlay opacity requires an ordered [minimum,maximum] within [0,1].');
    overlayIds.add(overlay.id); return { id: overlay.id, layer: parseTextureLayerData(overlay.layer), probability: overlay.probability ?? 1,
      ...(overlay.opacity ? { opacity: [...overlay.opacity] as [number, number] } : {}) };
  });
  if (palette.some(entry => entry.material.texture.layers.length + overlays.length > 8)) throw new Error('Every possible base plus all authored overlays must fit the eight-layer texture budget.');
  return { palette, ...(input.overlays === undefined ? {} : { overlays }) };
}
function resolved(input: Omit<ResolvedSurfaceMaterial, 'key'>): ResolvedSurfaceMaterial {
  const value = canonical(input);
  // Buildings resolve the same few materials for every wall, floor and fixture.
  let key = materialKeys.get(value);
  if (key === undefined) {
    const [first, second] = hashPair(value, 2166136261, 0x6d2b79f5);
    key = `surface-v1-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
    if (materialKeys.size >= 512) materialKeys.delete(materialKeys.keys().next().value!);
    materialKeys.set(value, key);
  }
  const result = freeze({ ...input, key }); trusted.add(result); return result;
}
/** Independent, keyed weighted choice. Palette order does not matter. Overlay
 * order does matter, but adding another overlay never rerolls existing ones.
 * Authored texture seeds stay intact; implicit overlay noise seeds use their ID. */
export function resolveSurfaceMaterial(input: SurfaceMaterialInput, context: { seed: number; key: string }): ResolvedSurfaceMaterial {
  if (!plain(context) || !keys(context, ['seed', 'key']) || !Number.isInteger(context.seed) || context.seed < 0 || context.seed > 0xffffffff
    || typeof context.key !== 'string' || !context.key.length || context.key.length > 512) throw new Error('Surface resolution needs an unsigned seed and a stable key of 1–512 characters.');
  const checked = validateSurfaceMaterialInput(input);
  if (!('palette' in checked)) return resolved(material(checked));
  const randomKey = `${context.seed}:${context.key}`, total = checked.palette.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
  let value = roll(`${randomKey}:variant`) * total, selected = checked.palette.at(-1)!;
  for (const entry of checked.palette) { value -= entry.weight ?? 1; if (value < 0) { selected = entry; break; } }
  const output = material(selected.material);
  for (const overlay of checked.overlays ?? []) {
    if (roll(`${randomKey}:overlay:${overlay.id}:present`) >= (overlay.probability ?? 1)) continue;
    const layer = parseTextureLayerData(overlay.layer);
    if (overlay.opacity) layer.opacity = snap(overlay.opacity[0] + (overlay.opacity[1] - overlay.opacity[0]) * roll(`${randomKey}:overlay:${overlay.id}:opacity`));
    if (layer.source.kind === 'noise' && layer.source.seed === undefined) layer.source.seed = hash(`${randomKey}:overlay:${overlay.id}:source`) | 0;
    if (layer.mask?.kind === 'noise' && layer.mask.seed === undefined) layer.mask.seed = hash(`${randomKey}:overlay:${overlay.id}:mask`) | 0;
    output.texture.layers.push(layer);
  }
  return resolved(output);
}
/** Validate serialized resolved data before trusting its content key or sharing
 * GPU resources. Validator-owned frozen results take a constant-time fast path. */
export function validateResolvedSurfaceMaterial(input: ResolvedSurfaceMaterial): ResolvedSurfaceMaterial {
  if (trusted.has(input)) return input;
  if (!plain(input) || !keys(input, ['texture', 'tileSize', 'rotation', 'tint', 'key']) || typeof input.key !== 'string') throw new Error('Resolved surface material is malformed.');
  const result = resolved(material({ texture: input.texture, tileSize: input.tileSize, rotation: input.rotation, tint: input.tint }));
  if (result.key !== input.key) throw new Error('Resolved surface material content/key has been modified.');
  return result;
}
