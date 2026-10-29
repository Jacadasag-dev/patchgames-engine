import type { PlayerModelOption } from '../shared/gameApi.ts';
/** Stable host-owned choices; installed character mods extend the same catalog. */
export const BUILTIN_PLAYER_MODELS = [
  { id: 'builtin:male', label: 'Midnight', description: 'A relaxed jacket, tapered trousers and warm copper accents.' },
  { id: 'builtin:female', label: 'Sundown', description: 'A soft knit, flowing hair and cream trainers.' },
  { id: 'builtin:mint', label: 'Daybreak', description: 'A fresh mint overshirt with dark trousers.' },
  { id: 'builtin:rose', label: 'Rose', description: 'A rose jacket and deep plum accents.' },
] as const satisfies readonly PlayerModelOption[];
export const MODEL_PALETTES: Record<string, { shirt: number; pants: number; skin: number; hair: number; longHair: boolean }> = {
  'builtin:male': { shirt: 0x324657, pants: 0x262937, skin: 0xbc825e, hair: 0x271c1c, longHair: false },
  'builtin:female': { shirt: 0xd49272, pants: 0x4e3d51, skin: 0xdca983, hair: 0x513129, longHair: true },
  'builtin:mint': { shirt: 0x6cbaaa, pants: 0x30394c, skin: 0x80513a, hair: 0x201b23, longHair: false },
  'builtin:rose': { shirt: 0xbb7893, pants: 0x47344d, skin: 0xf0c8a1, hair: 0x9b6745, longHair: true },
};
