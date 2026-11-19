import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeEvidenceStore } from '@workmate/storage';
import { KnowledgeParentContextSchema, type KnowledgeBaseRuntime, type KnowledgeSourceSnapshot } from '@workmate/contracts';
import { identifyKnowledgeVersion, knowledgeContentHash } from '../knowledge-evidence.js';
import { chunkStructuredKnowledge } from '../knowledge-chunker.js';
import { ingestKnowledge, listKnowledgeChunks, searchKnowledgeBase, searchKnowledgeWithOntology,
  createKnowledgeTools, deleteLocalKnowledgeChunk, deleteLocalKnowledgeDocument, type KnowledgeHit, type KnowledgeChunkSummary } from '../knowledge-runtime.js';
import { writeOntologyGraph } from '../ontology-runtime.js';

test('KE-C03: structured evidence, child-only indexes, bounded context, deletion and reprocessing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kb: KnowledgeBaseRuntime = { id: 'context', name: 'Policy', provider: 'lancedb', enabled: true, dataDir: root,
    embeddingBaseUrl: 'https://embedding.invalid/v1', embeddingApiKey: 'test', embeddingModel: 'test-model', ontologyEnabled: false };
  let embedded = 0;
  let pause: { entered: () => void; gate: Promise<void> } | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const held = pause;
    if (held) { pause = undefined; held.entered(); await held.gate; }
    const inputs = (JSON.parse(String(init.body)) as { input: string[] }).input;
    embedded += inputs.length;
    return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 });
  });
  const ingest = (base: KnowledgeBaseRuntime, content: string, documentId = 'doc') => {
    const scope = { provider: 'lancedb', knowledgeBaseId: base.id, documentId };
    const bytes = Buffer.from(content), version = identifyKnowledgeVersion(scope, bytes);
    const sourceSnapshot: KnowledgeSourceSnapshot = { ...scope, documentVersionId: version.documentVersionId,
      file: { blobId: version.sourceHash, sha256: version.sourceHash, sizeBytes: bytes.length }, fileName: 'source.md', origin: 'text', status: 'archived' };
    return ingestKnowledge({ kb: base, documentId, sourceSnapshot, title: 'Policy', content });
  };
  const source = '# 报销制度\r\n\r\n' + Array.from({ length: 10 }, (_, i) => `第${i}条 报销凭证${'补充规则。'.repeat(150)}\r\n\r\n`).join('');
  const structure = chunkStructuredKnowledge(source, 'Policy');
  await ingest(kb, source);
  assert.equal(embedded, structure.chunks.length, 'parents must not incur embedding calls');
  const listed: KnowledgeChunkSummary[] = (await listKnowledgeChunks({ kb, limit: 100 })).chunks;
  assert.equal(listed.length, structure.chunks.length);
  const db = await connect(root), table = await db.openTable('chunks');
  assert.equal(await table.countRows(), listed.length);
  for (const chunk of listed) {
    assert.equal(chunk.evidence?.verification, 'versioned');
    if (chunk.evidence?.verification !== 'versioned') throw new Error('Missing evidence');
    const location = chunk.evidence.sourceLocation!;
    assert.equal(chunk.content, structure.normalizedText.slice(location.start, location.end));
    assert.equal(knowledgeContentHash(chunk.content), chunk.evidence.contentHash);
  }
  const hits = await searchKnowledgeBase(kb, '报销凭证', 10);
  const contexts = hits.flatMap((hit) => hit.context ? [KnowledgeParentContextSchema.parse(hit.context)] : []);
  assert.ok(contexts.length >= 1);
  assert.ok(contexts.reduce((sum, context) => sum + context.content.length, 0) <= 7200);
  assert.equal(new Set(contexts.map((context) => context.evidence.chunkId)).size, contexts.length);
  assert.ok(contexts.every((context) => context.matchedChunkIds.every((id) => hits.some((hit) => hit.id === id))));
  assert.ok(contexts.some((context) => context.matchedChunkIds.length > 1));
  assert.ok(hits.every((hit) => hit.content.length <= 1200));
  const first = listed.find((chunk) => chunk.evidence?.verification === 'versioned' && chunk.evidence.parentChunkId)!;
  if (first.evidence?.verification !== 'versioned') throw new Error('Expected parented evidence');
  const parentId = first.evidence.parentChunkId;
  const sibling = listed.find((chunk) => chunk.id !== first.id && chunk.evidence?.verification === 'versioned' && chunk.evidence.parentChunkId === parentId)!;
  await writeOntologyGraph(kb, { version: 1, nodes: [{ id: 'rule', type: 'Document', name: '报销制度', aliases: [],
    properties: { documentId: 'doc', chunkId: first.id }, status: 'published' }], edges: [] });
  assert.ok((await searchKnowledgeWithOntology(kb, '报销制度', 8)).results.some((hit) => hit.context));
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  pause = { entered, gate };
  const pendingSearch = searchKnowledgeWithOntology(kb, '报销制度', 10);
  await enteredPromise;
  try { await deleteLocalKnowledgeChunk(kb, sibling.id); } finally { release(); }
  const afterDelete = await pendingSearch;
  assert.ok(afterDelete.results.every((hit) => hit.id !== sibling.id));
  assert.ok(afterDelete.results.every((hit) => hit.context?.evidence.chunkId !== parentId));
  const store = new KnowledgeEvidenceStore(path.join(root, 'knowledge-evidence.sqlite'));
  try {
    assert.equal(store.getParentContext(first.id), undefined);
    assert.equal(store.getVisibility().activeChunkIds.length, listed.length - 1);
  } finally { store.close(); }

  const second: KnowledgeBaseRuntime = { ...kb, id: 'second', dataDir: path.join(root, 'second') };
  await ingest(second, source);
  const broken: KnowledgeBaseRuntime = { ...kb, id: 'broken', dataDir: path.join(root, 'broken') };
  fs.mkdirSync(broken.dataDir!);
  const invalidPath = path.join(broken.dataDir!, 'knowledge-evidence.sqlite');
  const invalidStore = new KnowledgeEvidenceStore(invalidPath); invalidStore.close();
  const invalid = new DatabaseSync(invalidPath); invalid.exec('PRAGMA user_version=99'); invalid.close();
  const tool = createKnowledgeTools({ knowledgeBases: [kb, second, broken] })[0];
  const reply = await tool.execute('context-test', { query: '报销凭证', topK: 8 });
  const details = reply.details as { ok: boolean; results: KnowledgeHit[]; errors?: string[] };
  assert.equal(details.ok, true);
  assert.equal(details.errors?.length, 1, 'a failed KB must not discard valid results from other KBs');
  assert.equal(new Set(details.results.map((hit) => hit.knowledgeBaseId)).size, 2);
  assert.ok(details.results.reduce((sum, hit) => sum + (hit.context?.content.length ?? 0), 0) <= 7200);
  assert.ok(details.results.every((hit) => !hit.context || hit.context.evidence.knowledgeBaseId === hit.knowledgeBaseId));
  assert.ok(details.results.every((hit) => hit.context?.evidence.chunkId !== parentId));
  await ingest(kb, '# 新制度\n\n全新规则');
  assert.ok((await searchKnowledgeBase(kb, '规则', 8)).every((hit) => hit.context === undefined && hit.content.includes('全新规则')));
  await deleteLocalKnowledgeDocument(kb, 'doc');
  assert.deepEqual(await searchKnowledgeBase(kb, '报销凭证', 8), []);
});
