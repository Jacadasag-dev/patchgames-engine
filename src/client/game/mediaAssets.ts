import { mediaAsset, mediaFileUrl, type MediaFile, type TextureAsset } from '../../shared/mediaAssets.ts';
import type { MaterialSourcePixels, TexturePixels } from '../../shared/materialRecipeRenderer.ts';
import { decodeSoundWav } from '../../shared/soundRecipeRenderer.ts';

const bytes = new Map<string, Promise<Uint8Array>>();
/** Trusted page fetches only catalogued immutable files; authored code never chooses a URL. */
async function loadFile(file: MediaFile): Promise<Uint8Array> {
  let result = bytes.get(file.sha256);
  if (!result) {
    result = (async () => {
      const response = await fetch(mediaFileUrl(file), { credentials: 'omit', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Media source could not be loaded');
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length !== file.bytes) throw new Error('Media source size mismatch');
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== file.sha256) throw new Error('Media source integrity mismatch');
      return data;
    })();
    bytes.set(file.sha256, result);
    // The fixed starter bank is small. Bound future expansion without retaining every source forever.
    while (bytes.size > 48) bytes.delete(bytes.keys().next().value!);
    void result.catch(() => bytes.delete(file.sha256));
  }
  return result;
}
export async function loadTextureAsset(id: string): Promise<MaterialSourcePixels> {
  const asset = mediaAsset(id, 'texture') as TextureAsset;
  const entries = await Promise.all(Object.entries(asset.maps).map(async ([name, file]) => {
    const data = await loadFile(file);
    if (data.length !== asset.width * asset.height * 4) throw new Error('Invalid texture dimensions');
    return [name, { width: asset.width, height: asset.height, data: data.slice() } satisfies TexturePixels] as const;
  }));
  return Object.fromEntries(entries) as unknown as MaterialSourcePixels;
}
export async function loadSoundAsset(id: string) {
  const asset = mediaAsset(id, 'sound');
  if (asset.kind !== 'sound') throw new Error('Expected sound asset');
  return decodeSoundWav(await loadFile(asset));
}
