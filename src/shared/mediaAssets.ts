import { mediaAssetData } from './mediaAssetData.ts';

export interface MediaFile { file: string; sha256: string; bytes: number }
interface SourceMetadata {
  id: string; kind: 'texture' | 'sound'; name: string; tags: readonly string[];
  license: string; creator: string; sourceUrl: string; licenseUrl: string; processing: string; sourceSha256?: string;
}
export interface TextureAsset extends SourceMetadata {
  kind: 'texture'; width: number; height: number;
  maps: { color: MediaFile; height?: MediaFile; roughness?: MediaFile; metalness?: MediaFile };
}
export interface SoundAsset extends SourceMetadata, MediaFile {
  kind: 'sound'; sampleRate: number; channels: number; duration: number;
}
export type MediaAsset = TextureAsset | SoundAsset;
/** Published v1 IDs are immutable. Changes add a new ID/file, preserving saved recipes. */
export const MEDIA_ASSETS: readonly MediaAsset[] = mediaAssetData;
const assetsById = new Map(MEDIA_ASSETS.map(asset => [asset.id, asset]));
export function mediaAsset(id: string, kind?: MediaAsset['kind']): MediaAsset {
  const asset = assetsById.get(id);
  if (!asset || kind && asset.kind !== kind) throw new Error(`Unknown ${kind ?? 'media'} asset: ${String(id).slice(0, 120)}. Use get_media_catalog to discover source IDs.`);
  return asset;
}
export function mediaAssetFiles(asset: MediaAsset): MediaFile[] {
  return asset.kind === 'texture' ? Object.values(asset.maps) : [asset];
}
export function mediaFileUrl(file: MediaFile): string { return `/media/v1/${file.file}`; }
