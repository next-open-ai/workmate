import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';
import { KnowledgeEvidenceStore } from '@workmate/storage';
import type { KnowledgeSourceSnapshot } from '@workmate/contracts';
import { identifyKnowledgeVersion } from '../knowledge-evidence.js';
import { fuseKnowledgeRanks } from '../knowledge-hybrid.js';
import { ingestKnowledge, searchKnowledgeBase, searchKnowledgeWithOntology, deleteLocalKnowledgeDocument } from '../knowledge-runtime.js';

test('KE-K03: RRF combines ranks rather than incomparable scores and deduplicates channels', () => {
  const row = (id: string) => ({ id, documentId: id, title: id, content: id });
  const fused = fuseKnowledgeRanks([{ ...row('word'), bm25: -500 }, { ...row('both'), bm25: -0.0001 }],
    [{ ...row('semantic'), score: 1 }, { ...row('both'), score: 0.5 }, { ...row('both'), score: 0.4 }]);
  assert.equal(fused[0].id, 'both');
  assert.equal(fused.length, 3);
  assert.deepEqual(fused[0].retrieval.channels, ['keyword', 'vector']);
  assert.ok(fused.every((hit) => hit.score > 0 && hit.score <= 1));
});

test('KE-K03: local ingest, keyword/vector recall, migration, degradation, version and deletion loop', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-hybrid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kb = { id: 'kb', name: 'Knowledge', provider: 'lancedb' as const, enabled: true, dataDir: root,
    embeddingBaseUrl: 'https://embedding.invalid/v1', embeddingApiKey: 'test', embeddingModel: 'test-model', ontologyEnabled: false };
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (fail) throw new Error('Embedding offline');
    const inputs = (JSON.parse(String(init.body)) as { input: string[] }).input;
    return new Response(JSON.stringify({ data: inputs.map((text, index) => ({ index,
      embedding: text.startsWith('编号') ? [0, 1, 0] : [1, 0, 0] })) }), { status: 200 });
  });
  const ingest = (documentId: string, content: string) => {
    const scope = { provider: 'lancedb', knowledgeBaseId: kb.id, documentId };
    const bytes = Buffer.from(content); const version = identifyKnowledgeVersion(scope, bytes);
    const snapshot: KnowledgeSourceSnapshot = { ...scope, documentVersionId: version.documentVersionId,
      file: { blobId: version.sourceHash, sha256: version.sourceHash, sizeBytes: bytes.length }, fileName: 'source.txt', origin: 'text', status: 'archived' };
    return ingestKnowledge({ kb, documentId, content, title: 'Manual', sourceSnapshot: snapshot });
  };
  // Existing unversioned data is indexed automatically, including JSON compatibility rows.
  const db = await connect(root);
  await db.createTable('chunks', [{ id: 'old', documentId: 'old-doc', title: 'Legacy', documentTitle: 'Legacy',
    content: '历史关键词 ARCHIVE42', source: '', vector: [0, 1, 0], createdAt: 1 },
    ...Array.from({ length: 1001 }, (_, i) => ({ id: `filler-${i}`, documentId: `filler-${i}`, title: 'Filler', documentTitle: 'Filler',
      content: i === 1000 ? 'PAGEDTAIL42' : 'irrelevant filler', source: '', vector: [0, 1, 0], createdAt: 1 }))]);
  fs.writeFileSync(path.join(root, 'chunks.json'), JSON.stringify([{ id: 'json', documentId: 'json-doc', title: 'JSON',
    content: 'JSON历史内容 FILE42', vector: [0, 1, 0], createdAt: 1 }]));
  await ingest('code', '编号 ERR-ABC123 报销流程');
  await ingest('semantic', '费用申请与审批说明');
  let hits = await searchKnowledgeBase(kb, 'ERR-ABC123', 10);
  assert.ok(hits.some((hit) => hit.content.includes('ABC123') && hit.retrieval?.channels.includes('keyword')));
  assert.ok(hits.some((hit) => hit.content.includes('费用') && hit.retrieval?.channels.includes('vector')));
  assert.equal(new Set(hits.map((hit) => hit.id)).size, hits.length);
  assert.equal((await searchKnowledgeWithOntology(kb, '报销流程', 5)).strategy, 'hybrid');
  fail = true;
  hits = await searchKnowledgeBase(kb, '报销流程', 10);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].retrieval, { channels: ['keyword'], ranking: 'rrf', degraded: true });
  assert.equal(hits[0].evidence?.verification, 'versioned');
  assert.equal((await searchKnowledgeBase(kb, 'ARCHIVE42', 10))[0].evidence?.verification, 'legacy-unverified');
  assert.equal((await searchKnowledgeBase(kb, 'FILE42', 10))[0].id, 'json');
  assert.equal((await searchKnowledgeBase(kb, 'PAGEDTAIL42', 10))[0].id, 'filler-1000');
  await assert.rejects(searchKnowledgeBase(kb, 'nomatchxyz', 10), /Embedding offline/);
  const noModel = { ...kb, embeddingModel: undefined, embeddingApiKey: undefined, embeddingBaseUrl: undefined };
  assert.equal((await searchKnowledgeBase(noModel, '报销流程', 10)).length, 1);
  assert.deepEqual(await searchKnowledgeBase(noModel, 'nomatchxyz', 10), []);
  assert.deepEqual(await searchKnowledgeBase(kb, '   ', 10), []);
  fail = false;
  await ingest('code', '编号 NEW-789 差旅制度');
  const store = new KnowledgeEvidenceStore(path.join(root, 'knowledge-evidence.sqlite'));
  try {
    assert.deepEqual(store.searchKeywords('ABC123', 10), []);
    assert.equal(store.searchKeywords('差旅制度', 10).length, 1);
  } finally { store.close(); }
  await deleteLocalKnowledgeDocument(kb, 'code');
  await deleteLocalKnowledgeDocument(kb, 'old-doc');
  assert.deepEqual(await searchKnowledgeBase(noModel, '差旅制度', 10), []);
  assert.deepEqual(await searchKnowledgeBase(noModel, 'ARCHIVE42', 10), []);
  assert.deepEqual(await searchKnowledgeBase({ ...noModel, dataDir: path.join(root, 'other-kb') }, 'FILE42', 10), []);
});
