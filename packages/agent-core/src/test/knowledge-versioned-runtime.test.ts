import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';
import { KnowledgeEvidenceStore } from '@workmate/storage';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeSourceSnapshot } from '@workmate/contracts';
import { identifyKnowledgeVersion } from '../knowledge-evidence.js';
import { ingestKnowledge, listLocalKnowledgeDocuments, listKnowledgeChunks, searchKnowledgeBase,
  deleteLocalKnowledgeDocument, deleteLocalKnowledgeChunk, recallOntologyEvidence } from '../knowledge-runtime.js';
import { writeOntologyGraph, planOntologyQuery } from '../ontology-runtime.js';

test('KE-V03/V04: versioned pipeline publishes only ready vectors and keeps legacy data searchable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-versioned-'));
  const kb = { id: 'kb', name: 'Knowledge', provider: 'lancedb' as const, enabled: true, dataDir: root,
    embeddingBaseUrl: 'https://embedding.invalid/v1', embeddingApiKey: 'test', embeddingModel: 'test-model' };
  const scope = { provider: 'lancedb', knowledgeBaseId: kb.id, documentId: 'document' };
  const snapshot = (text: string): KnowledgeSourceSnapshot => {
    const bytes = Buffer.from(text); const version = identifyKnowledgeVersion(scope, bytes);
    return { ...scope, documentVersionId: version.documentVersionId,
      file: { blobId: version.sourceHash, sha256: version.sourceHash, sizeBytes: bytes.length },
      fileName: 'source.txt', origin: 'text', status: 'archived' };
  };
  let dimensions = 3; let failEmbedding = false;
  let pause: { entered: () => void; gate: Promise<void> } | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const held = pause; if (held) { pause = undefined; held.entered(); await held.gate; }
    if (failEmbedding) throw new Error('Embedding unavailable');
    const inputs = (JSON.parse(String(init.body)) as { input: string[] }).input;
    return new Response(JSON.stringify({ model: 'test-model', data: inputs.map((_, index) => ({ index,
      embedding: dimensions === 3 ? [1, 0, 0] : [1, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const ingest = (text: string) => ingestKnowledge({ kb, documentId: scope.documentId,
    sourceSnapshot: snapshot(text), title: 'Source', content: text });
  try {
    const first = await ingest('first version');
    assert.equal('backend' in first && first.backend, 'lancedb');
    let chunks = await listKnowledgeChunks({ kb, documentId: scope.documentId });
    assert.equal(chunks.chunks.length, 1);
    assert.equal(chunks.chunks[0].evidence?.verification, 'versioned');
    const firstId = chunks.chunks[0].id;
    await writeOntologyGraph(kb, { version: 1, nodes: [{ id: 'source-node', type: 'Document', name: 'Source', aliases: [],
      properties: { documentId: scope.documentId, chunkId: firstId }, status: 'published' }], edges: [] });
    const oldPlan = await planOntologyQuery(kb, 'Source', 1);
    assert.equal((await recallOntologyEvidence(kb, oldPlan))[0]?.id, firstId);
    const db = await connect(root); const table = await db.openTable('chunks');
    await ingest('first version');
    await table.checkoutLatest();
    assert.equal(await table.countRows(), 1, 'retry must not duplicate vectors');
    failEmbedding = true;
    await assert.rejects(ingest('failed embedding'), /Embedding unavailable/);
    failEmbedding = false;
    assert.equal((await searchKnowledgeBase(kb, 'question', 1))[0].content, 'first version');
    dimensions = 2;
    await assert.rejects(ingest('failed vector write'), { code: 'EMBEDDING_DIMENSION_MISMATCH' });
    dimensions = 3;
    assert.equal(fs.existsSync(path.join(root, 'chunks.json')), false, 'managed failure must not silently create fallback data');
    assert.equal((await listKnowledgeChunks({ kb })).chunks[0].id, firstId);
    await ingest('second version');
    await table.checkoutLatest();
    assert.equal(await table.countRows(), 2, 'old vector exists physically but must not be recalled');
    assert.equal((await searchKnowledgeBase(kb, 'question', 1))[0].content, 'second version');
    assert.deepEqual(await recallOntologyEvidence(kb, oldPlan), [], 'old exact graph evidence cannot resolve to the new version');
    await table.add([{ id: 'ch-orphan', documentId: scope.documentId, documentTitle: 'Source', title: 'Source',
      content: 'unregistered vector', source: '', vector: [1, 0, 0], createdAt: Date.now() }]);
    assert.equal((await searchKnowledgeBase(kb, 'question', 8)).some((hit) => hit.id === 'ch-orphan'), false);
    assert.equal((await listLocalKnowledgeDocuments(kb)).documentCount, 1);
    chunks = await listKnowledgeChunks({ kb });
    assert.equal(chunks.chunks.length, 1); assert.notEqual(chunks.chunks[0].id, firstId);
    const store = new KnowledgeEvidenceStore(path.join(root, 'knowledge-evidence.sqlite'));
    try { assert.equal(store.getEvidence(firstId)?.verification, 'versioned'); } finally { store.close(); }

    fs.writeFileSync(path.join(root, 'chunks.json'), JSON.stringify([{ id: 'legacy-chunk', documentId: 'legacy',
      documentTitle: 'Legacy', title: 'Legacy', content: 'legacy content', vector: [1, 0, 0], createdAt: 1 }]));
    assert.equal((await listLocalKnowledgeDocuments(kb)).documentCount, 2);
    assert.equal((await searchKnowledgeBase(kb, 'question', 8)).find((hit) => hit.id === 'legacy-chunk')?.evidence?.verification, 'legacy-unverified');
    await deleteLocalKnowledgeChunk(kb, 'legacy-chunk');
    assert.equal((await searchKnowledgeBase(kb, 'question', 8)).some((hit) => hit.id === 'legacy-chunk'), false);

    let release!: () => void; let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    pause = { entered, gate };
    const pending = ingest('late version');
    await enteredPromise;
    assert.equal((await listKnowledgeChunks({ kb })).chunks[0].content, 'second version');
    await deleteLocalKnowledgeDocument(kb, scope.documentId);
    release();
    await assert.rejects(pending, { code: 'CONFLICT' });
    assert.deepEqual((await searchKnowledgeBase(kb, 'question', 8)), []);
    assert.equal((await listLocalKnowledgeDocuments(kb)).documentCount, 0);
    assert.equal((await listKnowledgeChunks({ kb })).total, 0);
    const invalid = new DatabaseSync(path.join(root, 'knowledge-evidence.sqlite'));
    invalid.exec('PRAGMA user_version=99'); invalid.close();
    await assert.rejects(searchKnowledgeBase(kb, 'question', 8), { code: 'UNSUPPORTED_SCHEMA' });
    await assert.rejects(listKnowledgeChunks({ kb }), { code: 'UNSUPPORTED_SCHEMA' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
