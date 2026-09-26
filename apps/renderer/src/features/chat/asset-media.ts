import type { Asset } from '../../app/assets';

export type AssetMediaKind = 'image' | 'audio' | 'video' | null;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);

export function assetMediaKind(asset: Pick<Asset, 'kind' | 'mimeType' | 'name' | 'workspaceRelative'>): AssetMediaKind {
  if (asset.kind === 'bundle') return null;
  const mime = String(asset.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  const name = asset.workspaceRelative || asset.name;
  const extension = name.split('.').pop()?.toLowerCase() || '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}
