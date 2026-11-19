import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeEvidenceStore, ImmutableFileStore, KnowledgeSourceStore } from '@workmate/storage';
import type { WikiContent } from '@workmate/contracts';
import { identifyKnowledgeVersion } from '../knowledge-evidence.js';
import { ingestKnowledge, listKnowledgeChunks, deleteLocalKnowledgeDocument, searchKnowledgeBase, searchKnowledgeWithOntology, createKnowledgeTools } from '../knowledge-runtime.js';
import { recallWiki, currentWikiRevisions } from '../wiki-retrieval.js';

test('WK-R04: disabled retrieval never opens Wiki; missing database stays absent and corruption is not an empty success', () => {
  const root = mkdtempSync(join(tmpdir(), 'workmate-wiki-recall-'));
  const kb = { id: 'kb', name: 'KB', enabled: true, provider: 'lancedb' as const,
    wikiRetrievalEnabled: true, wikiAccess: { orgId: 'org', userId: 'user', sourceRoot: root } };
  try {
    assert.deepEqual(recallWiki(kb, root, 'test', 5), []);
    assert.equal(existsSync(join(root, 'knowledge-evidence.sqlite')), false);
    writeFileSync(join(root, 'knowledge-evidence.sqlite'), 'not a database');
    assert.deepEqual(recallWiki({ ...kb, wikiRetrievalEnabled: false }, root, 'test', 5), []);
    assert.throws(() => recallWiki(kb, root, 'test', 5));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('WK-E01 foundation: real archived source → ingest → Wiki draft/publish → FTS → source update/delete, without Wiki vectors', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workmate-wiki-lifecycle-'));
  const owner = { orgId: 'org', userId: 'user' };
  const kb = { id: 'kb', name: 'Knowledge', provider: 'lancedb' as const, enabled: true, dataDir: root,
    embeddingBaseUrl: 'https://embedding.invalid/v1', embeddingApiKey: 'test', embeddingModel: 'test-model' };
  const source = { provider: 'lancedb', knowledgeBaseId: kb.id, documentId: 'document' };
  const files = new ImmutableFileStore(join(root, 'objects'));
  const sources = new KnowledgeSourceStore(join(root, 'sources.sqlite'), files);
  let store: KnowledgeEvidenceStore | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const inputs = (JSON.parse(String(init.body)) as { input: string[] }).input;
    return new Response(JSON.stringify({ model: 'test-model', data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const ingest = async (content: string) => {
    const bytes = Buffer.from(content), version = identifyKnowledgeVersion(source, bytes);
    const snapshot = sources.put(owner, { ...source, documentVersionId: version.documentVersionId,
      file: files.put(owner, bytes), fileName: '制度.txt', origin: 'text', status: 'archived' });
    await ingestKnowledge({ kb, documentId: source.documentId, sourceSnapshot: snapshot, title: '差旅制度', content });
    return snapshot;
  };
  try {
    const original = await ingest('住宿报销必须提交发票。');
    const chunk = (await listKnowledgeChunks({ kb, documentId: source.documentId })).chunks[0];
    assert.equal(chunk.evidence?.verification, 'versioned');
    if (chunk.evidence?.verification !== 'versioned') throw new Error('Expected versioned input');
    store = new KnowledgeEvidenceStore(join(root, 'knowledge-evidence.sqlite'));
    const wiki = store.openWiki({ ...owner, knowledgeBaseId: kb.id }, (ref, principal) => {
      if (ref.evidence.verification !== 'versioned') return false;
      const archived = sources.get({ orgId: principal.orgId, userId: principal.userId }, ref.evidence.documentVersionId);
      return archived?.documentId === ref.evidence.documentId
        && archived.knowledgeBaseId === principal.knowledgeBaseId;
    });
    const content: WikiContent = { title: '住宿报销', aliases: ['住宿费用', 'WIKI-ONLY-Z904'], summary: '材料要求', categoryPath: ['财务'],
      bodyMarkdown: chunk.content, sections: [{ sectionId: 'materials', headingPath: ['材料'], start: 0, end: chunk.content.length }],
      evidenceRefs: [{ refId: 'source', sourceKind: 'local-evidence', sectionId: 'materials', evidence: chunk.evidence,
        excerptHash: chunk.evidence.contentHash }], links: [] };
    const draft = wiki.saveDraft({ pageId: 'wiki-page', slug: 'travel', content, authorType: 'human', baseGeneration: 0, idempotencyKey: 'draft' });
    const recallKb = { ...kb, embeddingModel: '', ontologyEnabled: false, wikiRetrievalEnabled: true,
      wikiAccess: { ...owner, sourceRoot: root } };
    assert.deepEqual(await searchKnowledgeBase(recallKb, 'WIKI-ONLY-Z904', 5), [], 'drafts must not enter fused recall');
    assert.deepEqual(wiki.search('住宿报销'), []);
    const view = wiki.read(draft.pageId, { draft: true })!;
    wiki.publish({ pageId: draft.pageId, baseGeneration: draft.generation, draftRevisionId: view.revision.revisionId,
      contentHash: view.revision.contentHash, idempotencyKey: 'publish' });
    assert.equal(wiki.search('住宿费用')[0].pageId, draft.pageId);
    // WK-R04: only the page alias matches; no fabricated chunk evidence or extra embedding call.
    const recalled = await searchKnowledgeBase(recallKb, 'WIKI-ONLY-Z904', 5);
    assert.equal(recalled.length, 1); assert.equal(recalled[0].wiki?.pageId, draft.pageId);
    assert.equal(recalled[0].wiki?.revisionId, view.revision.revisionId);
    assert.equal(recalled[0].wiki?.evidenceRefs[0].evidence.chunkId, chunk.id);
    assert.equal(recalled[0].evidence, undefined); assert.equal(recalled[0].context, undefined);
    assert.deepEqual(await searchKnowledgeBase({ ...recallKb, wikiRetrievalEnabled: false, wikiAccess: undefined }, 'WIKI-ONLY-Z904', 5), []);
    assert.deepEqual(recallWiki({ ...recallKb, wikiRetrievalEnabled: false, wikiAccess: undefined }, '/never-open-this', 'test', 5), []);
    await assert.rejects(searchKnowledgeBase({ ...recallKb, wikiAccess: undefined }, 'WIKI-ONLY-Z904', 5), /授权上下文/);
    assert.deepEqual(await searchKnowledgeBase({ ...recallKb, wikiAccess: { ...recallKb.wikiAccess, userId: 'other' } }, 'WIKI-ONLY-Z904', 5), []);
    const fused = await searchKnowledgeBase(recallKb, '发票', 5);
    assert.ok(fused.some(hit => hit.wiki)); assert.ok(fused.some(hit => hit.evidence));
    assert.equal(fused[0].wiki, undefined, 'raw first on equal outer rank');
    assert.deepEqual(await searchKnowledgeBase(recallKb, '发票', 5), fused);
    const enhanced = await searchKnowledgeWithOntology({ ...recallKb, ontologyEnabled: true }, 'WIKI-ONLY-Z904', 5);
    assert.equal(enhanced.results[0].wiki?.pageId, draft.pageId);
    const ontologyOff = await searchKnowledgeWithOntology(recallKb, 'WIKI-ONLY-Z904', 5);
    assert.deepEqual(ontologyOff.plan.matchedNodes, []); assert.equal(ontologyOff.results[0].wiki?.pageId, draft.pageId);
    const tool = createKnowledgeTools({ knowledgeBases: [recallKb] })[0];
    const toolResult = await tool.execute('wiki-recall', { query: 'WIKI-ONLY-Z904', topK: 5 });
    assert.match(JSON.stringify(toolResult), /wiki-page/);
    const oldRef = recalled[0].wiki!;
    assert.equal(currentWikiRevisions(recallKb, root, [oldRef]).size, 1);
    const beforeEdit = wiki.read(draft.pageId)!;
    wiki.saveDraft({ pageId: draft.pageId, slug: 'travel', content: { ...content, summary: '修订后材料要求' },
      authorType: 'human', baseGeneration: beforeEdit.page.generation, idempotencyKey: 'recall-edit' });
    assert.equal(currentWikiRevisions(recallKb, root, [oldRef]).size, 1, 'new draft does not replace published evidence');
    const nextDraft = wiki.read(draft.pageId, { draft: true })!;
    wiki.publish({ pageId: draft.pageId, baseGeneration: nextDraft.page.generation, draftRevisionId: nextDraft.revision.revisionId,
      contentHash: nextDraft.revision.contentHash, idempotencyKey: 'recall-republish' });
    assert.equal(currentWikiRevisions(recallKb, root, [oldRef]).size, 0, 'old published revision cannot survive final validation');
    assert.equal((await searchKnowledgeBase(recallKb, 'WIKI-ONLY-Z904', 5))[0].wiki?.revisionId, nextDraft.revision.revisionId);
    assert.equal(sources.read(owner, original.documentVersionId)!.bytes.toString(), chunk.content);
    assert.equal((await searchKnowledgeBase({ ...kb, embeddingModel: '' }, '发票', 5))[0].evidence?.chunkId, chunk.id);
    await ingest('住宿报销必须提交发票和审批单。');
    assert.deepEqual(recallWiki(recallKb, root, 'WIKI-ONLY-Z904', 20), [], 'stale seeds and linked pages excluded');
    assert.equal(wiki.read(draft.pageId)!.freshness, 'stale');
    assert.deepEqual(wiki.search('住宿报销'), []);
    assert.deepEqual(await searchKnowledgeBase(recallKb, 'WIKI-ONLY-Z904', 5), [], 'stale published page excluded');
    await deleteLocalKnowledgeDocument(kb, source.documentId);
    assert.equal(wiki.read(draft.pageId), undefined);
    assert.deepEqual(wiki.list(), []);
    assert.deepEqual(await searchKnowledgeBase(recallKb, 'WIKI-ONLY-Z904', 5), [], 'deleted source excluded');
    assert.ok(sources.read(owner, original.documentVersionId), 'deletion must not remove archived original');
  } finally { store?.close(); sources.close(); rmSync(root, { recursive: true, force: true }); }
});
