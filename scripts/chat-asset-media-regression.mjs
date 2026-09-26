import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from '../apps/renderer/node_modules/vite/dist/node/index.js';

const vite = await createServer({ root: 'apps/renderer', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { assetMediaKind } = await vite.ssrLoadModule('/src/features/chat/asset-media.ts');
  const asset = (name, mimeType = '', kind = 'file') => ({ kind, name, mimeType, workspaceRelative: name });
  for (const name of ['a.png', 'a.JPEG', 'a.webp', 'a.gif', 'a.avif', 'a.svg']) assert.equal(assetMediaKind(asset(name)), 'image');
  for (const name of ['a.mp3', 'a.wav', 'a.m4a', 'a.aac', 'a.flac', 'a.ogg', 'a.opus']) assert.equal(assetMediaKind(asset(name)), 'audio');
  for (const name of ['a.mp4', 'a.webm', 'a.mov', 'a.m4v']) assert.equal(assetMediaKind(asset(name)), 'video');
  assert.equal(assetMediaKind(asset('opaque.bin', 'image/png')), 'image');
  assert.equal(assetMediaKind(asset('opaque.bin', 'audio/mpeg')), 'audio');
  assert.equal(assetMediaKind(asset('opaque.bin', 'video/mp4')), 'video');
  assert.equal(assetMediaKind(asset('report.pdf', 'application/pdf')), null);
  assert.equal(assetMediaKind(asset('cover.png', 'image/png', 'bundle')), null);
  const previewSource = await readFile('apps/renderer/src/features/chat/ChatAssetMediaPreview.vue', 'utf8');
  assert.match(previewSource, /loading="lazy"/);
  assert.match(previewSource, /preload="metadata"/);
  assert.doesNotMatch(previewSource, /autoplay/);
  assert.match(previewSource, /loadArchivedAssetContentUrl/);
  assert.match(previewSource, /URL\.revokeObjectURL/);
  assert.doesNotMatch(previewSource, /import \{ archivedAssetContentUrl \}/);
  const rendererApiSource = await readFile('apps/renderer/src/services/api.ts', 'utf8');
  assert.match(rendererApiSource, /fetch\(archivedAssetContentUrl\(assetId\)/);
  assert.match(rendererApiSource, /URL\.createObjectURL\(await response\.blob\(\)\)/);
  const apiSource = await readFile('apps/api/src/modules/assets/routes.ts', 'utf8');
  assert.match(apiSource, /accept-ranges/);
  assert.match(apiSource, /content-range/);
  for (const mime of ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'video/mp4', 'video/webm']) assert.match(apiSource, new RegExp(mime));
  console.log('ASSET-T1 PASS: chat asset MIME/extension media classification.');
  console.log('ASSET-T2 PASS: lazy image preview, metadata-only playback, and byte-range delivery.');
} finally {
  await vite.close();
}
