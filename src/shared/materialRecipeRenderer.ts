import { textureRecipeSchema, type ResolvedTextureRecipe, type TextureRecipe } from './mediaRecipes.ts';

/** Color images use sRGB RGBA8. Height/roughness/metalness use linear grayscale RGBA8. */
export interface TexturePixels { width: number; height: number; data: Uint8Array }
export interface MaterialSourcePixels {
  color: TexturePixels;
  height?: TexturePixels;
  roughness?: TexturePixels;
  metalness?: TexturePixels;
}
export type MaterialSourceResolver = (id: string) => Promise<TexturePixels | MaterialSourcePixels> | TexturePixels | MaterialSourcePixels;
export interface MaterialSurfaceFields {
  width: number; height: number;
  /** Normalized [0,1] fields. Array order is row-major, matching the output image. */
  elevation?: ArrayLike<number>; slope?: ArrayLike<number>;
}
export interface MaterialRecipeOptions {
  resolveSource?: MaterialSourceResolver;
  surface?: MaterialSurfaceFields;
  /** Bounded preview override; does not edit the persisted recipe. */
  resolution?: number;
  /** Texture-space affine map of output UVs. Surface fields remain in output
   * UVs, so world elevation masks do not repeat with the material tile. */
  coordinates?: {
    origin: [number, number]; uAxis: [number, number]; vAxis: [number, number];
    /** Physical output span; reliefScale is metres when this is provided. */
    metres?: [number, number];
  };
}
export interface MaterialRecipePixels {
  recipe: ResolvedTextureRecipe;
  color: TexturePixels; normal: TexturePixels; roughness: TexturePixels; metalness: TexturePixels; height: TexturePixels;
  diagnostics: {
    resolution: number; layerCount: number; sourceIds: string[];
    derivedHeightSourceIds: string[]; heightRange: [number, number]; roughnessRange: [number, number];
    metalnessRange: [number, number]; warnings: string[];
  };
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (x: number, span: number) => ((x % span) + span) % span;
const linear = (s: number) => s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
const srgb = (s: number) => s <= 0.0031308 ? 12.92 * s : 1.055 * s ** (1 / 2.4) - 0.055;
function rgb(hex: string): number[] { return [1, 3, 5].map(index => linear(Number.parseInt(hex.slice(index, index + 2), 16) / 255)); }
function hash(x: number, y: number, seed: number): number {
  let v = Math.imul(x ^ seed, 374761393) ^ Math.imul(y + seed, 668265263);
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
}
/** Periodic value noise avoids a random discontinuity where a repeated material wraps. */
function noise(u: number, v: number, scale: number, seed: number): number {
  const x = wrap(u, 1) * scale, y = wrap(v, 1) * scale;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return mix(mix(hash(ix, iy, seed), hash((ix + 1) % scale, iy, seed), sx),
    mix(hash(ix, (iy + 1) % scale, seed), hash((ix + 1) % scale, (iy + 1) % scale, seed), sx), sy);
}
function validatePixels(pixels: TexturePixels, label: string): void {
  if (!Number.isInteger(pixels.width) || !Number.isInteger(pixels.height) || pixels.width < 1 || pixels.height < 1
    || pixels.width > 2048 || pixels.height > 2048 || !(pixels.data instanceof Uint8Array)
    || pixels.data.length !== pixels.width * pixels.height * 4) throw new Error(`${label}: expected RGBA8 pixels with dimensions 1..2048.`);
}
function sample(pixels: TexturePixels, u: number, v: number, channel: number): number {
  const x = wrap(u, 1) * pixels.width - 0.5, y = wrap(v, 1) * pixels.height - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const at = (dx: number, dy: number) => pixels.data[(wrap(iy + dy, pixels.height) * pixels.width + wrap(ix + dx, pixels.width)) * 4 + channel] / 255;
  return mix(mix(at(0, 0), at(1, 0), fx), mix(at(0, 1), at(1, 1), fx), fy);
}
function fieldAt(field: ArrayLike<number>, width: number, height: number, u: number, v: number): number {
  const x = Math.min(width - 1, Math.floor(u * width)), y = Math.min(height - 1, Math.floor(v * height));
  return field[y * width + x];
}
function maskWeight(value: number, min: number, max: number, softness: number): number {
  if (softness === 0) return value >= min && value <= max ? 1 : 0;
  const smooth = (t: number) => { const c = clamp(t); return c * c * (3 - 2 * c); };
  return (min === 0 ? 1 : smooth((value - min + softness) / softness))
    * (max === 1 ? 1 : smooth((max + softness - value) / softness));
}
function image(size: number): TexturePixels { return { width: size, height: size, data: new Uint8Array(size * size * 4) }; }
function range(values: Float32Array): [number, number] {
  let min = 1, max = 0;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  return [Number(min.toFixed(4)), Number(max.toFixed(4))];
}

/** Pure, deterministic material composition shared by host previews and runtime. No DOM or network. */
export async function renderMaterialRecipe(input: TextureRecipe, options: MaterialRecipeOptions = {}): Promise<MaterialRecipePixels> {
  const recipe = textureRecipeSchema.parse(input);
  const size = options.resolution ?? recipe.resolution;
  if (!Number.isInteger(size) || size < 16 || size > 512) throw new Error('Material resolution must be an integer from 16 to 512.');
  const coordinates = options.coordinates;
  if (coordinates && (![coordinates.origin, coordinates.uAxis, coordinates.vAxis].every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6))
    || Math.abs(coordinates.uAxis[0] * coordinates.vAxis[1] - coordinates.uAxis[1] * coordinates.vAxis[0]) < 1e-12
    || coordinates.metres && (!Array.isArray(coordinates.metres) || coordinates.metres.length !== 2 || !coordinates.metres.every(value => Number.isFinite(value) && value > 0 && value <= 20002))))
    throw new Error('Material coordinates require a finite nondegenerate affine map and positive bounded physical spans.');
  const sources = new Map<string, MaterialSourcePixels>();
  const derivedHeightSourceIds: string[] = [];
  const sourceIds = [...new Set(recipe.layers.flatMap(layer => layer.source.kind === 'asset' ? [layer.source.id] : []))];
  const loadedSources = await Promise.all(sourceIds.map(async id => {
    if (!options.resolveSource) throw new Error(`Material source ${id} needs a source resolver.`);
    const result = await options.resolveSource(id);
    if (!result || typeof result !== 'object') throw new Error(`Material source ${id} is missing its pixel data.`);
    const maps = 'data' in result ? { color: result } : result;
    for (const [mapName, pixels] of Object.entries(maps)) if (pixels) validatePixels(pixels, `${id}.${mapName}`);
    if (!maps.color) throw new Error(`Material source ${id} is missing its color map.`);
    return maps;
  }));
  for (let i = 0; i < sourceIds.length; i++) {
    sources.set(sourceIds[i], loadedSources[i]);
    if (!loadedSources[i].height) derivedHeightSourceIds.push(sourceIds[i]);
  }
  const surface = options.surface;
  if (surface) {
    if (!Number.isInteger(surface.width) || !Number.isInteger(surface.height) || surface.width < 1 || surface.height < 1
      || surface.width > 2048 || surface.height > 2048) throw new Error('Surface field dimensions must be integers from 1 to 2048.');
    for (const field of [surface.elevation, surface.slope]) if (field) {
      if (field.length !== surface.width * surface.height) throw new Error('Surface field length does not match its dimensions.');
      for (let i = 0; i < field.length; i++) if (!Number.isFinite(field[i]) || field[i] < 0 || field[i] > 1) {
        throw new Error('Surface elevation and slope fields must contain normalized finite values in [0,1].');
      }
    }
  }
  const count = size * size, colors = new Float32Array(count * 3), heights = new Float32Array(count).fill(0.5);
  const roughness = new Float32Array(count).fill(0.85), metalness = new Float32Array(count), alpha = new Float32Array(count);
  // Central differences span two texels. A height map is normalized data, not a
  // declaration that the surface is one whole tile deep. Keep physical relief
  // separate so resolution changes retain the same apparent depth.
  const normalDerivativeScale = 0.5 * size * recipe.reliefScale * recipe.normalStrength;
  const derivativeX = normalDerivativeScale / (coordinates ? coordinates.metres?.[0] ?? Math.hypot(...coordinates.uAxis) : 1);
  const derivativeY = normalDerivativeScale / (coordinates ? coordinates.metres?.[1] ?? Math.hypot(...coordinates.vAxis) : 1);
  const textureUV = (u: number, v: number): [number, number] => coordinates
    ? [coordinates.origin[0] + coordinates.uAxis[0] * u + coordinates.vAxis[0] * v,
      coordinates.origin[1] + coordinates.uAxis[1] * u + coordinates.vAxis[1] * v] : [u, v];
  // World-atlas edges are padded, not periodic with their opposite edge. The
  // outermost normal is never sampled by terrain; clamp avoids a false seam.
  const neighbour = (n: number) => coordinates ? Math.max(0, Math.min(size - 1, n)) : wrap(n, size);
  for (let layerIndex = 0; layerIndex < recipe.layers.length; layerIndex++) {
    const layer = recipe.layers[layerIndex], source = layer.source, tint = rgb(layer.tint);
    const maps = source.kind === 'asset' ? sources.get(source.id)! : undefined;
    const solid = source.kind === 'solid' ? rgb(source.color) : undefined;
    const low = source.kind === 'noise' ? rgb(source.colors[0]) : undefined;
    const high = source.kind === 'noise' ? rgb(source.colors[1]) : undefined;
    const mask = layer.mask;
    const previousHeights = mask?.kind === 'slope' && mask.field === 'material' ? heights.slice() : heights;
    let surfaceField: ArrayLike<number> | undefined;
    if (mask?.field === 'surface' && mask.kind !== 'noise') {
      surfaceField = mask.kind === 'height' ? surface?.elevation : surface?.slope;
      if (!surface || !surfaceField) throw new Error(`Layer ${layer.name ?? layerIndex + 1}: ${mask.kind} surface mask needs a normalized ${mask.kind === 'height' ? 'elevation' : 'slope'} field.`);
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x, u = (x + 0.5) / size, v = (y + 0.5) / size;
      const [tu, tv] = textureUV(u, v), su = tu * layer.repeat[0], sv = tv * layer.repeat[1];
      const n = source.kind === 'noise' ? noise(su, sv, source.scale, source.seed ?? recipe.seed + layerIndex) : 0;
      const r = maps ? linear(sample(maps.color, su, sv, 0)) : solid?.[0] ?? mix(low![0], high![0], n);
      const g = maps ? linear(sample(maps.color, su, sv, 1)) : solid?.[1] ?? mix(low![1], high![1], n);
      const b = maps ? linear(sample(maps.color, su, sv, 2)) : solid?.[2] ?? mix(low![2], high![2], n);
      let weight = layer.opacity * (maps ? sample(maps.color, su, sv, 3) : 1);
      if (mask) {
        let value: number;
        if (mask.kind === 'noise') value = noise(tu, tv, mask.scale, mask.seed ?? recipe.seed + layerIndex + 101);
        else if (surfaceField && surface) value = fieldAt(surfaceField, surface.width, surface.height, u, v);
        else if (mask.kind === 'height') value = previousHeights[i];
        else {
          const dx = previousHeights[y * size + neighbour(x + 1)] - previousHeights[y * size + neighbour(x - 1)];
          const dy = previousHeights[neighbour(y + 1) * size + x] - previousHeights[neighbour(y - 1) * size + x];
          value = Math.atan(coordinates ? Math.hypot(dx * derivativeX, dy * derivativeY) : Math.hypot(dx, dy) * normalDerivativeScale) / (Math.PI / 2);
        }
        const coverage = maskWeight(value, mask.min, mask.max, mask.softness);
        weight *= mask.invert ? 1 - coverage : coverage;
      }
      if (weight === 0) continue;
      const incoming = [r * tint[0], g * tint[1], b * tint[2]];
      const outAlpha = alpha[i] + weight * (1 - alpha[i]);
      for (let c = 0; c < 3; c++) {
        const old = colors[i * 3 + c], next = incoming[c];
        const blend = layer.blend === 'multiply' ? old * next : layer.blend === 'add' ? clamp(old + next) : next;
        // Source-over composition keeps partially transparent base layers from becoming dark fringes.
        colors[i * 3 + c] = (old * alpha[i] * (1 - weight) + (next * (1 - alpha[i]) + blend * alpha[i]) * weight) / outAlpha;
      }
      alpha[i] = outAlpha;
      const h = maps?.height ? sample(maps.height, su, sv, 0) : source.kind === 'noise' ? n : source.kind === 'solid' ? 0.5 : r * 0.2126 + g * 0.7152 + b * 0.0722;
      heights[i] = mix(heights[i], clamp(0.5 + (h - 0.5) * layer.heightStrength), weight);
      roughness[i] = mix(roughness[i], layer.roughness ?? (maps?.roughness ? sample(maps.roughness, su, sv, 0) : 0.85), weight);
      metalness[i] = mix(metalness[i], layer.metalness ?? (maps?.metalness ? sample(maps.metalness, su, sv, 0) : 0), weight);
    }
  }
  const color = image(size), normal = image(size), roughnessMap = image(size), metalnessMap = image(size), height = image(size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, p = i * 4;
    for (let c = 0; c < 3; c++) color.data[p + c] = Math.round(clamp(srgb(colors[i * 3 + c] * (1 - recipe.wetness * 0.25))) * 255);
    color.data[p + 3] = Math.round(alpha[i] * 255);
    roughness[i] = mix(roughness[i], 0.12, recipe.wetness);
    for (const [map, value] of [[roughnessMap, roughness[i]], [metalnessMap, metalness[i]], [height, heights[i]]] as const) {
      map.data[p] = map.data[p + 1] = map.data[p + 2] = Math.round(value * 255); map.data[p + 3] = 255;
    }
    const dx = (heights[y * size + neighbour(x + 1)] - heights[y * size + neighbour(x - 1)]) * derivativeX;
    const dy = (heights[neighbour(y + 1) * size + x] - heights[neighbour(y - 1) * size + x]) * derivativeY;
    const length = Math.hypot(dx, dy, 1);
    normal.data[p] = Math.round((-dx / length * 0.5 + 0.5) * 255);
    // DataTexture flipY=false: increasing row index increases UV-v, so the
    // tangent-space normal tilts toward decreasing height on both axes.
    normal.data[p + 1] = Math.round((-dy / length * 0.5 + 0.5) * 255);
    normal.data[p + 2] = Math.round((1 / length * 0.5 + 0.5) * 255); normal.data[p + 3] = 255;
  }
  return { recipe, color, normal, roughness: roughnessMap, metalness: metalnessMap, height,
    diagnostics: { resolution: size, layerCount: recipe.layers.length, sourceIds: [...sources.keys()], derivedHeightSourceIds,
      heightRange: range(heights), roughnessRange: range(roughness), metalnessRange: range(metalness),
      warnings: derivedHeightSourceIds.length ? ['Color-only source relief is derived from luminance, not measured PBR height. Set heightStrength:0 for flat color, or supply source height maps.'] : [] } };
}
