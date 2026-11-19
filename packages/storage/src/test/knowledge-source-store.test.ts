import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImmutableFileStore, fileOwnerKey } from '../immutable-file-store.js';
import { KnowledgeSourceStore } from '../knowledge-source-store.js';

const owner = { userId: 'user', orgId: 'org' };
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new ImmutableFileStore(path.join(root, 'objects'));
  return { root, files, database: path.join(root, 'sources.sqlite') };
}
test('KE-F01: immutable bytes, deduplication within owner, no cross-owner sharing', (t) => {
  const { root, files } = fixture(t);
  const original = Buffer.from('原文\r\n\0');
  const file = files.put(owner, original);
  assert.deepEqual(files.put(owner, original), file);
  original.fill(0);
  assert.equal(files.read(owner, file).toString(), '原文\r\n\0');
  const other = { ...owner, userId: '../other' };
  assert.throws(() => files.read(other, file));
  files.put(other, Buffer.from('原文\r\n\0'));
  assert.equal(fs.readdirSync(path.join(root, 'objects')).length, 2);
  assert.equal(fs.readdirSync(path.join(root, 'objects', fileOwnerKey(owner))).length, 1);
});
test('KE-F02: rejects traversal, symlinks and corrupted blobs without overwriting', (t) => {
  const { root, files } = fixture(t);
  const file = files.put(owner, Buffer.from('original'));
  assert.throws(() => files.read(owner, { ...file, blobId: '../../outside' }));
  const target = path.join(root, 'objects', fileOwnerKey(owner), file.blobId);
  fs.writeFileSync(target, 'tampered');
  assert.throws(() => files.read(owner, file), { code: 'CORRUPT_FILE' });
  assert.throws(() => files.put(owner, Buffer.from('original')), { code: 'CORRUPT_FILE' });
  fs.unlinkSync(target);
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'original'); fs.symlinkSync(outside, target);
  assert.throws(() => files.read(owner, file), { code: 'UNSAFE_PATH' });
  const other = { ...owner, userId: 'linked' };
  fs.symlinkSync(root, path.join(root, 'objects', fileOwnerKey(other)), 'dir');
  assert.throws(() => files.put(other, Buffer.from('new')), { code: 'UNSAFE_PATH' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
});
test('KE-F03: source references persist, enforce owner isolation and reject version conflicts', (t) => {
  const f = fixture(t);
  const file = f.files.put(owner, Buffer.from('source'));
  const snapshot = { provider: 'lancedb', knowledgeBaseId: 'kb', documentId: 'doc', documentVersionId: 'version',
    file, fileName: 'source.txt', origin: 'upload' as const, status: 'archived' as const };
  let store = new KnowledgeSourceStore(f.database, f.files);
  try {
    assert.deepEqual(store.put(owner, snapshot), snapshot); store.put(owner, snapshot);
    assert.throws(() => store.put(owner, { ...snapshot, documentId: 'other' }), /SOURCE_VERSION_CONFLICT/);
    assert.equal(store.get({ ...owner, userId: 'other' }, 'version'), undefined);
  } finally { store.close(); }
  store = new KnowledgeSourceStore(f.database, f.files);
  try { assert.equal(store.read(owner, 'version')?.bytes.toString(), 'source'); } finally { store.close(); }
  const db = new DatabaseSync(f.database); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new KnowledgeSourceStore(f.database, f.files), /UNSUPPORTED_SOURCE_SCHEMA/);
  const check = new DatabaseSync(f.database);
  try { assert.equal(check.prepare('SELECT count(*) AS n FROM sources').get()!.n, 1); } finally { check.close(); }
});
