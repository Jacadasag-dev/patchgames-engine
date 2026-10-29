import { materialGeneratorSchema } from './materialGenerator.ts';
import { z } from 'zod';
import {materialPatternSchema} from './materialPatternSchema.ts';

export const MATERIAL_RECIPE_VERSION = 1;
export const MAX_MATERIAL_RESOLUTION = 512;
const unit = z.number().finite().min(0).max(1);
const seed = z.number().int().min(-2147483648).max(2147483647);
const color = z.string().regex(/^#[\da-f]{6}$/i, 'Use a six-digit hexadecimal color, e.g. #708050.');
const assetId = z.string().min(1).max(120).regex(/^[a-z\d][a-z\d._:/-]*$/i);

export const textureSourceSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('generator'),recipe:materialGeneratorSchema}).strict(),
  z.object({ kind: z.literal('asset'), id: assetId }).strict(),
  z.object({ kind: z.literal('solid'), color }).strict(),
  z.object({ kind: z.literal('noise'), colors: z.tuple([color, color]),
    scale: z.number().int().min(1).max(64).default(8), seed: seed.optional() }).strict(),
]);
export const textureMaskSchema = z.union([z.object({
  kind: z.enum(['noise', 'height', 'slope']),
  /** Material masks read previously composed detail; slope is tilt / 90 degrees. Surface masks read supplied normalized terrain fields. */
  field: z.enum(['material', 'surface']).default('material'),
  min: unit.default(0.35), max: unit.default(1), softness: unit.default(0.1),
  invert: z.boolean().default(false),
  scale: z.number().int().min(1).max(64).default(8), seed: seed.optional(),
}).strict().refine(mask => mask.min <= mask.max, { message: 'Mask min must be at most max.', path: ['max'] }),
z.object({kind:z.literal('pattern'),pattern:materialPatternSchema,tileMeters:z.tuple([z.number().finite().min(.002).max(100),z.number().finite().min(.002).max(100)]).default([1,1])}).strict()]);
export const textureLayerSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  source: textureSourceSchema,
  blend: z.enum(['normal', 'multiply', 'add']).default('normal'),
  opacity: unit.default(1), tint: color.default('#ffffff'),
  repeat: z.tuple([z.number().finite().min(0.01).max(64), z.number().finite().min(0.01).max(64)]).default([1, 1]),
  mask: textureMaskSchema.optional(),
  roughness: unit.optional(), metalness: unit.optional(),
  /** Amount of source relief to retain. Color-only sources derive illustrative relief from luminance. */
  heightStrength: z.number().finite().min(0).max(2).default(1),
}).strict();
export const textureRecipeSchema = z.object({
  kind: z.literal('texture'), version: z.literal(MATERIAL_RECIPE_VERSION),
  id: assetId.optional(), name: z.string().min(1).max(120),
  resolution: z.number().int().min(16).max(MAX_MATERIAL_RESOLUTION).default(128),
  seed: seed.default(1), layers: z.array(textureLayerSchema).min(1).max(8),
  wetness: unit.default(0),
  /** Height range as a fraction of texture width: .02 means 2 cm of relief on a 1 m tile. Does not alter source height data. */
  reliefScale: unit.default(0.02),
  /** Artistic multiplier on reliefScale. Zero keeps the surface normals flat. */
  normalStrength: z.number().finite().min(0).max(8).default(1),
}).strict();

/** Validation bounds resource usage and data shape; it makes no judgments about artistic intent. */
export type TextureRecipe = z.input<typeof textureRecipeSchema>;
export type ResolvedTextureRecipe = z.output<typeof textureRecipeSchema>;
export type TextureLayer = z.input<typeof textureLayerSchema>;
export type TextureMask = z.input<typeof textureMaskSchema>;

export function materialRecipeAssetIds(recipe: TextureRecipe): string[] {
  return [...new Set(textureRecipeSchema.parse(recipe).layers.flatMap(layer => layer.source.kind === 'asset' ? [layer.source.id] : []))];
}
