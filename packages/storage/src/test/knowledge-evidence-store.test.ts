import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeEvidenceBatch } from '@workmate/contracts';
import { KnowledgeEvidenceStore } from '../knowledge-evidence-store.js';
import { knowledgeTokens } from '../knowledge-tokenizer.js';

const scope = { provider: 'local', knowledgeBaseId: 'kb', documentId: 'doc' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function batch(revision = 'r1'): KnowledgeEvidenceBatch {
  return { ...scope, documentVersionId: 'v1', processingRevisionId: revision, sourceHash: hash('raw'),
    chunks: [{ content: 'text', evidence: { ...scope, schemaVersion: 1, verification: 'versioned',
      documentVersionId: 'v1', processingRevisionId: revision, chunkId: revision + '-chunk', contentHash: hash('text') } }] };
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'workmate-evidence-'));
  const path = join(dir, 'evidence.sqlite');
  const stores: KnowledgeEvidenceStore[] = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, open: () => { const store = new KnowledgeEvidenceStore(path); stores.push(store); return store; } };
}

test('KE-P02: bulk evidence equals individual reads across groups, scopes and repeated calls', (t) => {
  const store = fixture(t).open();
  const value = batch();
  value.chunks = Array.from({ length: 270 }, (_, index) => ({ content: `text ${index}`, evidence: {
    ...value.chunks[0].evidence, chunkId: `bulk-${index}`, contentHash: hash(`text ${index}`),
  } }));
  store.putBatch(value);
  store.putBatch(batch('r2'));
  const ids = [...value.chunks.map(chunk => chunk.evidence.chunkId), 'r2-chunk', 'missing', 'bulk-0'];
  const actual = store.getEvidenceMany(ids);
  assert.equal(actual.size, 271);
  for (const id of ids) assert.deepEqual(actual.get(id), store.getEvidence(id));
  assert.equal(store.getEvidenceMany([]).size, 0);
  actual.get('bulk-0')!.documentId = 'mutated-copy';
  assert.equal(store.getEvidenceMany(['bulk-0']).get('bulk-0')!.documentId, scope.documentId);
  store.putBatch(batch('r3'));
  assert.deepEqual(store.getEvidenceMany(['r3-chunk']).get('r3-chunk'), store.getEvidence('r3-chunk'));
  store.activate(scope, 'r1', 0);
  store.suppressChunks(['bulk-0']);
  assert.ok(store.getEvidenceMany(['bulk-0']).has('bulk-0'), 'historical evidence is not a visibility grant');
  assert.ok(store.getVisibility().suppressedChunkIds.includes('bulk-0'));
});

test('KE-S01: persists immutable, idempotent batches and history across connections', (t) => {
  const f = fixture(t); const store = f.open();
  store.putBatch(batch()); store.putBatch(batch());
  assert.deepEqual(store.getHead(scope), { generation: 0, processingRevisionId: null });
  store.activate(scope, 'r1', 0);
  store.putBatch(batch('r2')); store.activate(scope, 'r2', 1);
  const reopened = f.open();
  assert.deepEqual(reopened.getBatch(scope, 'r1'), batch());
  assert.deepEqual(reopened.getHead(scope), { generation: 2, processingRevisionId: 'r2' });
  assert.equal(reopened.getBatch({ ...scope, knowledgeBaseId: 'other' }, 'r1'), undefined);
  const changed = batch(); changed.sourceHash = hash('other');
  assert.throws(() => store.putBatch(changed), { code: 'CONFLICT' });
  assert.deepEqual(store.getBatch(scope, 'r1'), batch());
});

test('KE-S02: stale activation and missing batches preserve active revision; rollback is explicit CAS', (t) => {
  const f = fixture(t); const first = f.open(); const second = f.open();
  first.putBatch(batch()); first.putBatch(batch('r2'));
  first.activate(scope, 'r1', 0);
  assert.throws(() => second.activate(scope, 'r2', 0), { code: 'CONFLICT' });
  assert.throws(() => second.activate(scope, 'missing', 1), { code: 'NOT_FOUND' });
  assert.equal(first.getHead(scope).processingRevisionId, 'r1');
  second.activate(scope, 'r2', 1);
  assert.deepEqual(first.activate(scope, 'r1', 2), { generation: 3, processingRevisionId: 'r1' });
});

test('KE-S03: rejects invalid content, scope, duplicate chunks and cyclic/missing parents without writes', (t) => {
  const store = fixture(t).open();
  const invalid = [batch(), batch(), batch(), batch(), batch()];
  invalid[0].chunks[0].content = 'tampered';
  invalid[1].chunks[0].evidence.documentId = 'other';
  invalid[2].chunks.push(invalid[2].chunks[0]);
  for (const [index, parent] of [[3, 'missing'], [4, 'r1-chunk']] as const) {
    const evidence = invalid[index].chunks[0].evidence;
    if (evidence.verification === 'versioned') evidence.parentChunkId = parent;
  }
  for (const value of invalid) assert.throws(() => store.putBatch(value), { code: 'INVALID_BATCH' });
  assert.equal(store.getBatch(scope, 'r1'), undefined);
  store.putBatch(batch());
  const conflict = batch(); conflict.chunks[0].content = 'new';
  const evidence = conflict.chunks[0].evidence;
  if (evidence.verification === 'versioned') evidence.contentHash = hash('new');
  assert.throws(() => store.putBatch(conflict), { code: 'CONFLICT' });
  assert.deepEqual(store.getBatch(scope, 'r1'), batch());
});

test('KE-S04: refuses legacy and future databases without losing their contents', (t) => {
  const f = fixture(t);
  let db = new DatabaseSync(f.path);
  db.exec("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('keep')"); db.close();
  assert.throws(() => f.open(), { code: 'UNSUPPORTED_SCHEMA' });
  db = new DatabaseSync(f.path);
  assert.equal(db.prepare('SELECT value FROM legacy').get()!.value, 'keep');
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0);
  db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => f.open(), { code: 'UNSUPPORTED_SCHEMA' });
  db = new DatabaseSync(f.path);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 99);
  assert.equal(db.prepare('SELECT value FROM legacy').get()!.value, 'keep'); db.close();
});

test('KE-V01: migrates v1 batches transactionally without losing evidence', (t) => {
  const f = fixture(t); const db = new DatabaseSync(f.path);
  const key = JSON.stringify([scope.provider, scope.knowledgeBaseId, scope.documentId]);
  db.exec(`CREATE TABLE documents (scope TEXT PRIMARY KEY, revision TEXT, generation INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE versions (scope TEXT, version TEXT, source_hash TEXT, PRIMARY KEY(scope,version));
    CREATE TABLE batches (scope TEXT, revision TEXT, version TEXT, payload TEXT, PRIMARY KEY(scope,revision));
    PRAGMA application_id=1464159045; PRAGMA user_version=1;`);
  db.prepare('INSERT INTO documents VALUES (?,?,?)').run(key, 'r1', 1);
  db.prepare('INSERT INTO versions VALUES (?,?,?)').run(key, 'v1', batch().sourceHash);
  db.prepare('INSERT INTO batches VALUES (?,?,?,?)').run(key, 'r1', 'v1', JSON.stringify(batch())); db.close();
  const store = f.open();
  assert.deepEqual(store.getBatch(scope, 'r1'), batch());
  assert.deepEqual(store.getVisibility().activeChunkIds, ['r1-chunk']);
  assert.deepEqual(store.getEvidence('r1-chunk'), batch().chunks[0].evidence);
});

test('KE-V02: pending batches stay invisible, deletion blocks stale publication and chunk collisions roll back', (t) => {
  const store = fixture(t).open();
  store.putBatch(batch()); store.activate(scope, 'r1', 0);
  store.putBatch(batch('r2'));
  assert.deepEqual(store.getVisibility().activeChunkIds, ['r1-chunk']);
  const collision = batch('r3'); collision.chunks[0].evidence.chunkId = 'r1-chunk';
  assert.throws(() => store.putBatch(collision), { code: 'CONFLICT' });
  assert.equal(store.getBatch(scope, 'r3'), undefined);
  store.suppressChunks(['r1-chunk'], scope);
  assert.deepEqual(store.getVisibility().activeChunkIds, []);
  assert.throws(() => store.activate(scope, 'r2', 1), { code: 'CONFLICT' });
  assert.deepEqual(store.getHead(scope), { generation: 2, processingRevisionId: null });
  assert.deepEqual(store.getBatch(scope, 'r1'), batch());
});

test('KE-K01: Chinese, mixed identifiers and punctuation use safe deterministic tokens and real BM25', (t) => {
  const store = fixture(t).open();
  const rows = [
    { id: 'a', documentId: 'a', title: 'Guide', content: '报销流程 ERROR-ＡＢＣ123 支付API失败' },
    { id: 'b', documentId: 'b', title: 'Guide', content: '报销流程 ' + '无关内容 '.repeat(100) },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, documentId: `f${i}`, title: 'Other', content: 'unrelated material' })),
  ];
  store.indexLegacyChunks(rows); store.indexLegacyChunks(rows);
  assert.deepEqual(store.searchKeywords('报销流程', 10).map((hit) => hit.id), ['a', 'b']);
  assert.ok(store.searchKeywords('报销流程', 10)[0].bm25 < store.searchKeywords('报销流程', 10)[1].bm25);
  assert.deepEqual(store.searchKeywords('ABC123', 10).map((hit) => hit.id), ['a']);
  assert.deepEqual(store.searchKeywords('API失败', 10).map((hit) => hit.id), ['a']);
  assert.equal(store.searchKeywords('销', 10).length, 2);
  assert.deepEqual(store.searchKeywords('" * : () ---', 10), []);
  assert.doesNotThrow(() => store.searchKeywords('" OR NOT NEAR(error) : *', 10));
  assert.deepEqual(knowledgeTokens('ABC中文', true), knowledgeTokens('ａｂｃ中文', true));
  assert.ok(knowledgeTokens('词语 '.repeat(1000), true).length <= 64);
  assert.throws(() => store.searchKeywords('text', 101), RangeError);
});

test('KE-K02: keyword publication and deletion are transactional, stale jobs cannot resurrect hits', (t) => {
  const f = fixture(t); const store = f.open();
  store.putBatch(batch());
  assert.deepEqual(store.searchKeywords('text', 10), []);
  store.activate(scope, 'r1', 0);
  assert.equal(store.searchKeywords('text', 10)[0].id, 'r1-chunk');
  store.putBatch(batch('r2'));
  const db = new DatabaseSync(f.path);
  db.exec(`CREATE TRIGGER reject_fts BEFORE INSERT ON search_chunks BEGIN SELECT RAISE(ABORT,'test index failure'); END;`);
  assert.throws(() => store.activate(scope, 'r2', 1), { code: 'FULLTEXT_INDEX_FAILED' });
  assert.equal(store.getHead(scope).processingRevisionId, 'r1');
  assert.equal(store.searchKeywords('text', 10)[0].id, 'r1-chunk');
  db.exec('DROP TRIGGER reject_fts'); db.close();
  store.activate(scope, 'r2', 1);
  assert.deepEqual(store.searchKeywords('text', 10).map((hit) => hit.id), ['r2-chunk']);
  store.suppressChunks(['r2-chunk'], scope);
  assert.deepEqual(store.searchKeywords('text', 10), []);
  assert.throws(() => store.activate(scope, 'r1', 2), { code: 'CONFLICT' });
  store.indexLegacyChunks([{ id: 'late-legacy', documentId: scope.documentId, title: 'text', content: 'text' }]);
  assert.deepEqual(store.searchKeywords('text', 10), []);
});

test('KE-K02: v2 migration backfills only active unsuppressed chunks and keeps history', (t) => {
  const f = fixture(t); const original = new KnowledgeEvidenceStore(f.path);
  original.putBatch(batch()); original.activate(scope, 'r1', 0);
  original.putBatch(batch('r2')); original.close();
  const old = new DatabaseSync(f.path);
  old.exec(`DROP TRIGGER search_chunks_ai; DROP TRIGGER search_chunks_ad;
    DROP TABLE chunk_fts; DROP TABLE search_chunks; PRAGMA user_version=2;`); old.close();
  const migrated = f.open();
  assert.deepEqual(migrated.searchKeywords('text', 10).map((hit) => hit.id), ['r1-chunk']);
  assert.deepEqual(f.open().searchKeywords('text', 10).map((hit) => hit.id), ['r1-chunk']);
  assert.deepEqual(migrated.getBatch(scope, 'r2'), batch('r2'));
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH 'text'").all();
  assert.ok(plan.some((row) => String(row.detail).includes('VIRTUAL TABLE INDEX')));
  db.close();
});

test('KE-K02: failed full-text migration rolls back schema and preserves v2 payload', (t) => {
  const f = fixture(t); const store = new KnowledgeEvidenceStore(f.path);
  store.putBatch(batch()); store.activate(scope, 'r1', 0); store.close();
  const db = new DatabaseSync(f.path);
  db.exec(`DROP TRIGGER search_chunks_ai; DROP TRIGGER search_chunks_ad;
    DROP TABLE chunk_fts; DROP TABLE search_chunks; PRAGMA user_version=2;
    UPDATE batches SET payload='invalid-json';`); db.close();
  assert.throws(() => f.open());
  const after = new DatabaseSync(f.path);
  assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 2);
  assert.equal(after.prepare('SELECT payload FROM batches').get()!.payload, 'invalid-json');
  assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name='search_chunks'").get(), undefined);
  after.close();
});

function parentBatch(): KnowledgeEvidenceBatch {
  const contents = ['alpha first\n', 'beta second'];
  const entry = (id: string, content: string, start: number, parentChunkId?: string) => ({ content,
    evidence: { ...scope, schemaVersion: 1 as const, verification: 'versioned' as const,
      documentVersionId: 'v1', processingRevisionId: 'r-parent', chunkId: id, contentHash: hash(content),
      sourceLocation: { coordinateSystem: 'normalized-text-utf16' as const, start, end: start + content.length },
      ...(parentChunkId ? { parentChunkId } : {}) } });
  return { ...scope, documentVersionId: 'v1', processingRevisionId: 'r-parent', sourceHash: hash('raw'),
    chunks: [entry('child-1', contents[0], 0, 'parent'), entry('child-2', contents[1], contents[0].length, 'parent')],
    parentChunks: [entry('parent', contents.join(''), 0)] };
}

test('KE-C02: parents are context only; inactive, deleted children and deleted siblings cannot expand', (t) => {
  const store = fixture(t).open(); const value = parentBatch();
  store.putBatch(value); store.putBatch(value);
  assert.equal(store.getParentContext('child-1'), undefined);
  store.activate(scope, 'r-parent', 0);
  assert.deepEqual(store.getVisibility().activeChunkIds.sort(), ['child-1', 'child-2']);
  assert.equal(store.getEvidence('parent'), undefined);
  assert.deepEqual(store.searchKeywords('alpha beta', 10).map((row) => row.id).sort(), ['child-1', 'child-2']);
  assert.equal(store.getParentContext('child-1')?.content, 'alpha first\nbeta second');
  assert.deepEqual(store.getParentContext('child-1')?.matchedChunkIds, ['child-1']);
  store.suppressChunks(['child-2']);
  assert.equal(store.getParentContext('child-1'), undefined);
  assert.equal(store.getParentContext('child-2'), undefined);
  assert.equal(store.searchKeywords('alpha', 10).length, 1);
  store.putBatch(batch()); store.activate(scope, 'r1', 1);
  assert.equal(store.getParentContext('child-1'), undefined);
  assert.deepEqual(store.getBatch(scope, 'r-parent'), value);
});

test('KE-C02: rejects corrupt, cross-scope, nested, overlapping and untracked parent content', (t) => {
  const store = fixture(t).open();
  const variants = Array.from({ length: 6 }, () => parentBatch());
  variants[0].parentChunks![0].evidence.documentId = 'foreign';
  variants[1].parentChunks![0].content = 'tampered';
  const nested = variants[2].parentChunks![0].evidence;
  if (nested.verification === 'versioned') nested.parentChunkId = 'child-1';
  const misplaced = variants[3].chunks[1].evidence;
  if (misplaced.verification === 'versioned') misplaced.sourceLocation = { coordinateSystem: 'normalized-text-utf16', start: 0, end: 11 };
  variants[4].chunks[1].content = 'beta change';
  const wrong = variants[4].chunks[1].evidence;
  if (wrong.verification === 'versioned') wrong.contentHash = hash('beta change');
  variants[5].chunks.pop();
  for (const value of variants) assert.throws(() => store.putBatch(value), { code: 'INVALID_BATCH' });
  assert.equal(store.getBatch(scope, 'r-parent'), undefined);
});

test('KE-C02: v3 to v4 preserves old payload, search, and absent parent metadata', (t) => {
  const f = fixture(t); const old = new KnowledgeEvidenceStore(f.path);
  old.putBatch(batch()); old.activate(scope, 'r1', 0); old.close();
  const db = new DatabaseSync(f.path); db.exec('PRAGMA user_version=3');
  const payload = db.prepare('SELECT payload FROM batches').get()!.payload; db.close();
  const store = f.open();
  assert.equal(store.getParentContext('r1-chunk'), undefined);
  assert.deepEqual(store.getBatch(scope, 'r1'), batch());
  assert.equal(store.searchKeywords('text', 1).length, 1);
  const after = new DatabaseSync(f.path);
  assert.equal(after.prepare('SELECT payload FROM batches').get()!.payload, payload);
  assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 4); after.close();
});
