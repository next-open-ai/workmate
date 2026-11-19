import test, { type TestContext } from 'node:test';

import assert from 'node:assert/strict';

import fs from 'node:fs';

import os from 'node:os';

import path from 'node:path';

import { createHash } from 'node:crypto';

import { DatabaseSync } from 'node:sqlite';

import Fastify from 'fastify';

import { KnowledgeEvidenceStore, KnowledgeSourceStore, ImmutableFileStore } from '@workmate/storage';

import type { WikiContent, KnowledgeEvidenceBatch } from '@workmate/contracts';

import { WikiGenerationFailure } from '@workmate/contracts';

import { registerWikiRoutes } from './wiki-routes.js';

import { registerWikiGenerationRoutes } from './wiki-generation-routes.js';

import { InMemoryExecutionDispatcher } from '@workmate/orchestrator';

import { validateWikiGeneration, type generateWikiPages } from '@workmate/agent-core';

function fixture(t: TestContext, enable = true, generate?: typeof generateWikiPages, chunkCount = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-wiki-api-'));
  const directory = path.join(root, 'kb'); fs.mkdirSync(directory);
  const config = [{ id: 'kb', name: 'Knowledge', provider: 'lancedb', enabled: true, dataDir: directory,
    ownership: { schemaVersion: 1, orgId: 'org', ownerUserId: 'alice', assignedBy: 'admin', assignedAt: new Date().toISOString() } }];
  fs.writeFileSync(path.join(root, 'knowledge-bases.json'), JSON.stringify({ meta: config }));
  const owner = { orgId: 'org', userId: 'alice' };
  const source = { provider: 'lancedb', knowledgeBaseId: 'kb', documentId: 'doc' };
  const chunkText = '差旅报销需要发票';
  const bytes = Buffer.from(Array.from({ length: chunkCount }, () => chunkText).join('\n'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const sourceRoot = path.join(root, 'knowledge-sources');
  const files = new ImmutableFileStore(path.join(sourceRoot, 'objects'));
  const sources = new KnowledgeSourceStore(path.join(sourceRoot, 'sources.sqlite'), files);
  sources.put(owner, { ...source, documentVersionId: 'v1', file: files.put(owner, bytes), fileName: 'source.txt', origin: 'text', status: 'archived' });
  sources.close();
  const database = path.join(directory, 'knowledge-evidence.sqlite');
  const evidence = new KnowledgeEvidenceStore(database);
  const batch: KnowledgeEvidenceBatch = { ...source, documentVersionId: 'v1', processingRevisionId: 'r1', sourceHash: hash,
    chunks: Array.from({ length: chunkCount }, (_, n) => ({ content: chunkText, evidence: { ...source, schemaVersion: 1, verification: 'versioned',
      documentVersionId: 'v1', processingRevisionId: 'r1', chunkId: n ? `chunk-${n}` : 'chunk',
      contentHash: createHash('sha256').update(chunkText).digest('hex') } })) };
  evidence.putBatch(batch); evidence.activate(source, 'r1', 0);
  const content: WikiContent = { title: '差旅报销', aliases: ['出差费用'], summary: '发票说明', categoryPath: [],
    bodyMarkdown: '需要发票', sections: [{ sectionId: 's', headingPath: ['报销'], start: 0, end: 4 }],
    evidenceRefs: [{ refId: 'ref', sectionId: 's', sourceKind: 'local-evidence', evidence: batch.chunks[0].evidence, excerptHash: hash }], links: [] };
  if (enable) {
    const wiki = evidence.openWiki({ ...owner, knowledgeBaseId: 'kb' }, () => true);
    wiki.saveDraft({ pageId: 'page', slug: 'page', content, authorType: 'model', baseGeneration: 0, idempotencyKey: 'seed' });
  }
  evidence.close();
  const app = Fastify();
  // Test-only authentication adapter; production inherits the session authGuard.
  app.addHook('preHandler', async (request) => {
    const user = request.headers['x-user'];
    if (typeof user === 'string') request.auth = { userId: user, orgId: String(request.headers['x-org'] || 'org'),
      username: user, displayName: user, role: user === 'admin' ? 'admin' : 'member', sessionId: 'test' };
  });
  registerWikiRoutes(app, { dataRoot: () => root });
  let modelCalls = 0;
  registerWikiGenerationRoutes(app, { dataRoot: () => root, dispatcher: () => new InMemoryExecutionDispatcher(),
    generate: async (...args) => {
      modelCalls += 1;
      if (generate) return generate(...args);
      return validateWikiGeneration({ pages: [1, 2].map((n) => ({ key: `p${n}`, title: n === 1 ? '差旅报销' : '发票规则',
        aliases: n === 1 ? ['出差费用'] : [], summary: '需要发票', sections: [{ heading: '要求', body: '差旅报销需要发票',
          chunkIds: ['chunk'], relatedKeys: [`p${3 - n}`] }] })) }, args[0]);
    } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const get = (suffix: string, user = 'alice', org = 'org') => app.inject({ method: 'GET', url: '/knowledge/kb/wiki' + suffix,
    headers: { 'x-user': user, 'x-org': org } });
  const publish = async () => {
    const view = (await get('/pages/page?view=drafts')).json();
    const payload = { baseGeneration: view.page.generation, draftRevisionId: view.revision.revisionId,
      contentHash: view.revision.contentHash, idempotencyKey: 'publish' };
    const result = await app.inject({ method: 'POST', url: '/knowledge/kb/wiki/pages/page/publish', headers: { 'x-user': 'alice' }, payload });
    assert.equal(result.statusCode, 200, result.body);
    return { payload, result };
  };
  return { app, get, publish, root, database, sourceRoot, content, config, modelCalls: () => modelCalls };
}

const generationBody = { documentIds: ['doc'], idempotencyKey: 'generate-one',
  model: { provider: 'openai-compatible', chatModel: 'test-model', apiKey: 'never-persist-this-secret' } };

test('WK-M19-T: authorized merge preview and CAS save keep publication and source draft intact', async (t) => {
  const f = fixture(t); await f.publish();
  const store = new KnowledgeEvidenceStore(f.database);
  try {
    const content = structuredClone(f.content); content.title = '出差费用'; content.bodyMarkdown = '新增流程😀'; content.sections[0].end = content.bodyMarkdown.length;
    store.openExistingWiki({ orgId: 'org', userId: 'alice', knowledgeBaseId: 'kb' }, () => true)!.saveDraft({
      pageId: 'new-source', slug: 'new-source', content, authorType: 'model', baseGeneration: 0, idempotencyKey: 'new-source' });
  } finally { store.close(); }
  assert.equal((await f.get('/pages/new-source/merge-candidates', 'bob')).statusCode, 404);
  assert.deepEqual((await f.get('/pages/new-source/merge-candidates')).json().items, [{ pageId: 'page', title: '差旅报销' }]);
  const previewResponse = await f.get('/pages/new-source/merge-preview?targetPageId=page');
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const { content, targetBody, addedSections, skippedSections, ...request } = previewResponse.json();
  assert.equal(addedSections, 1); assert.equal(content.bodyMarkdown, '需要发票\n\n新增流程😀');
  const send = (payload: object) => f.app.inject({ method: 'POST', url: '/knowledge/kb/wiki/pages/new-source/merge', headers: { 'x-user': 'alice' }, payload });
  assert.equal((await send({ ...request, previewHash: '0'.repeat(64), idempotencyKey: 'wrong' })).statusCode, 409);
  assert.equal((await send({ ...request, content, idempotencyKey: 'inject' })).statusCode, 400);
  const first = await send({ ...request, idempotencyKey: 'merge' }); assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual((await send({ ...request, idempotencyKey: 'merge' })).json(), first.json());
  assert.equal((await f.get('/pages/page')).json().revision.content.bodyMarkdown, targetBody);
  assert.equal((await f.get('/pages/page?view=drafts')).json().revision.content.bodyMarkdown, content.bodyMarkdown);
  assert.equal((await f.get('/pages/new-source?view=drafts')).statusCode, 200);
  assert.equal((await send({ ...request, idempotencyKey: 'stale-preview' })).statusCode, 409);
  assert.equal(f.modelCalls(), 0);
});

test('WK-R18-T: real SQLite resume reuses first batch and exposes metadata only', async (t) => {
  let count = 0; const sizes: number[] = [];
  const f = fixture(t, false, async (input) => {
    const chunkIds = input.batches.flatMap((b) => b.chunks.map((c) => c.evidence.chunkId)); sizes.push(chunkIds.length);
    if (++count === 2) throw new WikiGenerationFailure('MODEL_TIMEOUT');
    return validateWikiGeneration({ pages: [{ key: 'p', title: '续跑主题', aliases: [], summary: '私有候选',
      sections: [{ heading: '要求', body: '核对发票', chunkIds, relatedKeys: [] }] }] }, input);
  }, 101);
  const send = (payload: object, user = 'alice') => f.app.inject({ method: 'POST', url: '/knowledge/kb/wiki/generation-jobs', headers: { 'x-user': user }, payload });
  const first = await send(generationBody); assert.equal(first.statusCode, 202, first.body);
  const failed = await terminal(f, first.json().jobId);
  assert.equal(failed.processedChunks, 100); assert.equal(failed.resumable, true);
  const list = await f.get('/generation-jobs');
  assert.equal(list.body.includes('私有候选'), false); assert.equal(list.body.includes('_checkpoint'), false);
  const resume = { ...generationBody, resumeJobId: failed.jobId, idempotencyKey: 'resume-1' };
  assert.equal((await send(resume, 'bob')).statusCode, 404);
  const changed = await send({ ...resume, model: { ...generationBody.model, chatModel: 'different' } });
  assert.equal(changed.statusCode, 409); assert.equal(changed.json().code, 'MODEL_CHANGED');
  const next = await send(resume); assert.equal(next.statusCode, 202, next.body);
  const done = await terminal(f, failed.jobId);
  assert.equal(done.state, 'completed'); assert.deepEqual(sizes, [100, 1, 1]); assert.equal(done.pageIds.length, 1);
  assert.equal((await send(resume)).json().jobId, done.jobId); assert.equal(count, 3);
  const store = new KnowledgeEvidenceStore(f.database);
  try { assert.equal(store.wikiCheckpoint({ orgId: 'org', userId: 'alice', knowledgeBaseId: 'kb' }, done.jobId)!.batches.length, 0); }
  finally { store.close(); }
});

test('WK-R18-T: source deletion prevents resume before another model call', async (t) => {
  const f = fixture(t, false, async () => { throw new WikiGenerationFailure('MODEL_TIMEOUT'); });
  const send = (payload: object) => f.app.inject({ method: 'POST', url: '/knowledge/kb/wiki/generation-jobs', headers: { 'x-user': 'alice' }, payload });
  const first = await send(generationBody); const failed = await terminal(f, first.json().jobId);
  const store = new KnowledgeEvidenceStore(f.database);
  try { store.suppressChunks(['chunk']); } finally { store.close(); }
  const resumed = await send({ ...generationBody, resumeJobId: failed.jobId, idempotencyKey: 'resume-deleted' });
  assert.equal(resumed.statusCode, 422); assert.equal(f.modelCalls(), 1);
});

test('WK-A07: failure reason persists without raw model content and replay never calls provider again', async (t) => {
  const f = fixture(t, false, async () => { throw new WikiGenerationFailure('MODEL_OUTPUT_TRUNCATED'); });
  const start = () => f.app.inject({ method: 'POST', url: '/knowledge/kb/wiki/generation-jobs', headers: { 'x-user': 'alice' }, payload: generationBody });
  const response = await start(); assert.equal(response.statusCode, 202);
  const job = await terminal(f, response.json().jobId);
  assert.equal(job.errorCode, 'MODEL_OUTPUT_TRUNCATED'); assert.equal(job.state, 'failed'); assert.deepEqual(job.pageIds, []);
  assert.equal((await start()).json().jobId, job.jobId); assert.equal(f.modelCalls(), 1);
});

async function terminal(f: ReturnType<typeof fixture>, id: string) {
  for (let i = 0; i < 100; i++) {
    const response = await f.get(`/generation-jobs/${id}`);
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json();
    if (!['queued', 'running'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Job did not finish');
}
