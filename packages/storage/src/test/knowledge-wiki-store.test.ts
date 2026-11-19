import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WikiContentSchema, type WikiContent, type KnowledgeEvidenceBatch, type WikiPage } from '@workmate/contracts';
import { KnowledgeEvidenceStore } from '../knowledge-evidence-store.js';
import type { KnowledgeWikiStore } from '../knowledge-wiki-store.js';

const scope = { orgId: 'org', userId: 'user', knowledgeBaseId: 'kb' };
const source = { provider: 'lancedb', knowledgeBaseId: 'kb', documentId: 'document' };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
test('WK-M19-T: alias match previews append, preserves published/manual text and is idempotent', (t) => {
  const f = fixture(t), wiki = f.wiki();
  const original = publish(wiki, draft(wiki, 'target'));
  draft(wiki, 'target', content('差旅报销', '人工保留内容'), original.generation);
  draft(wiki, 'source', content('出差费用', '补充流程😀'));
  assert.deepEqual(wiki.mergeCandidates('source'), [{ pageId: 'target', title: '差旅报销' }]);
  const preview = wiki.previewMerge('source', 'target');
  assert.equal(preview.content.bodyMarkdown, '人工保留内容\n\n补充流程😀');
  assert.equal(preview.content.sections[1].end, preview.content.bodyMarkdown.length);
  assert.equal(preview.addedSections, 1); assert.equal(preview.content.evidenceRefs.length, 2);
  const { content: _content, targetBody: _body, addedSections: _added, skippedSections: _skipped, ...request } = preview;
  const input = { ...request, idempotencyKey: 'merge-once' };
  const saved = wiki.mergeDraft('source', input);
  assert.deepEqual(wiki.mergeDraft('source', input), saved);
  assert.equal(wiki.read('target')!.revision.content.bodyMarkdown, '住宿标准需要发票。');
  assert.equal(wiki.read('target', { draft: true })!.revision.content.bodyMarkdown, preview.content.bodyMarkdown);
  assert.ok(wiki.read('source', { draft: true }));
  assert.equal(wiki.previewMerge('source', 'target').addedSections, 0);
});
test('WK-M19-T: changed previews, unrelated topics, inaccessible sources and other scopes are rejected', (t) => {
  const f = fixture(t), wiki = f.wiki();
  publish(wiki, draft(wiki, 'target')); const src = draft(wiki, 'source', content('差旅报销', '新增内容'));
  const preview = wiki.previewMerge('source', 'target');
  const { content: _content, targetBody: _body, addedSections: _added, skippedSections: _skipped, ...request } = preview;
  draft(wiki, 'source', content('差旅报销', '修改后的新增内容'), src.generation);
  assert.throws(() => wiki.mergeDraft('source', { ...request, idempotencyKey: 'stale' }), { code: 'REVISION_CONFLICT' });
  draft(wiki, 'other', content('不同主题'));
  assert.deepEqual(wiki.mergeCandidates('other'), []);
  assert.throws(() => wiki.previewMerge('other', 'target'), { code: 'INVALID_INPUT' });
  assert.throws(() => f.evidence.openWiki({ ...scope, userId: 'other' }, () => true).previewMerge('source', 'target'), { code: 'NOT_FOUND' });
  f.deny(); assert.throws(() => wiki.previewMerge('source', 'target'), { code: 'NOT_FOUND' });
});
test('WK-M19-T: equal sections dedupe and oversized merged pages fail without writes', (t) => {
  const f = fixture(t), wiki = f.wiki();
  publish(wiki, draft(wiki, 'target'));
  draft(wiki, 'source');
  const preview = wiki.previewMerge('source', 'target');
  assert.equal(preview.addedSections, 0); assert.equal(preview.skippedSections, 1);
  const big = 'a'.repeat(150000);
  publish(wiki, draft(wiki, 'big-target', content('大主题', big)));
  draft(wiki, 'big-source', content('大主题', 'b'.repeat(150000)));
  assert.throws(() => wiki.previewMerge('big-source', 'big-target'), { code: 'MERGE_LIMIT_EXCEEDED' });
  assert.equal(wiki.read('big-target', { draft: true }), undefined);
});
function batch(revision = 'r1'): KnowledgeEvidenceBatch {
  const content = '住宿标准：报销需要发票。支付 ERROR-ABC123。';
  return { ...source, documentVersionId: `v-${revision}`, processingRevisionId: revision, sourceHash: hash(revision),
    documentTitle: '差旅制度', chunks: [{ content, evidence: { ...source, schemaVersion: 1, verification: 'versioned',
      documentVersionId: `v-${revision}`, processingRevisionId: revision, chunkId: `chunk-${revision}`, contentHash: hash(content),
      sourceLocation: { coordinateSystem: 'normalized-text-utf16', start: 0, end: content.length } } }] };
}
function content(title = '差旅报销', body = '住宿标准需要发票。', revision = 'r1'): WikiContent {
  const chunk = batch(revision).chunks[0];
  return { title, aliases: ['出差费用'], summary: '报销说明', categoryPath: ['财务'], bodyMarkdown: body,
    sections: [{ sectionId: 'section', headingPath: [title], start: 0, end: body.length }],
    evidenceRefs: [{ refId: 'ref', sectionId: 'section', sourceKind: 'local-evidence', evidence: chunk.evidence,
      excerptHash: hash(chunk.content) }], links: [] };
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'workmate-wiki-'));
  const path = join(dir, 'evidence.sqlite');
  const stores: KnowledgeEvidenceStore[] = [], dbs: DatabaseSync[] = [];
  t.after(() => { dbs.forEach((db) => db.close()); stores.forEach((store) => store.close()); rmSync(dir, { recursive: true, force: true }); });
  const open = () => { const store = new KnowledgeEvidenceStore(path); stores.push(store); return store; };
  const inspect = () => { const db = new DatabaseSync(path); dbs.push(db); return db; };
  const evidence = open(); evidence.putBatch(batch()); evidence.activate(source, 'r1', 0);
  let allowed = true;
  return { path, evidence, inspect, open, deny: () => { allowed = false; }, allow: () => { allowed = true; },
    wiki: () => evidence.openWiki(scope, () => allowed) };
}
function draft(wiki: KnowledgeWikiStore, pageId = 'page', c = content(), generation = 0, key = `save-${pageId}-${generation}`): WikiPage {
  return wiki.saveDraft({ pageId, slug: pageId, content: c, authorType: 'model', baseGeneration: generation, idempotencyKey: key });
}
function publish(wiki: KnowledgeWikiStore, page: WikiPage): WikiPage {
  const view = wiki.read(page.pageId, { draft: true })!;
  return wiki.publish({ pageId: page.pageId, baseGeneration: page.generation, draftRevisionId: view.revision.revisionId,
    contentHash: view.revision.contentHash, idempotencyKey: `publish-${page.pageId}-${page.generation}` });
}

test('WK-S01a: v5→v6 explicit generation upgrade backs up Wiki and source data; jobs persist by scope', (t) => {
  const f = fixture(t); const wiki = f.wiki(); draft(wiki);
  const backupPath = `${f.path}.before-v6`;
  f.evidence.initializeWikiGeneration(backupPath);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 5);
    assert.equal(backup.prepare('SELECT count(*) AS n FROM wiki_pages').get()!.n, 1);
  } finally { backup.close(); }
  assert.equal(f.inspect().prepare('PRAGMA user_version').get()!.user_version, 6);
  assert.equal(f.wiki().read('page', { draft: true })!.revision.content.title, '差旅报销');
  const now = new Date().toISOString();
  f.evidence.saveWikiJob({ schemaVersion: 1, jobId: 'job', scope, idempotencyKey: 'one', requestHash: 'a'.repeat(64), state: 'queued',
    sources: [{ documentId: 'document', documentVersionId: 'v-r1', processingRevisionId: 'r1' }], totalChunks: 1,
    processedChunks: 0, pageIds: [], errorCode: null, createdAt: now, updatedAt: now });
  const reopened = f.open();
  assert.equal(reopened.wikiJob(scope, 'one', true)!.jobId, 'job');
  assert.equal(reopened.wikiJob({ ...scope, userId: 'other' }, 'job'), undefined);
  assert.equal(reopened.searchKeywords('发票', 5).length, 1);
  // WK-R18-T: durable private candidates survive reopen and metadata-only writes.
  const job = reopened.wikiJob(scope, 'job')!;
  reopened.saveWikiJob(job, { schemaVersion: 1, inputHash: 'b'.repeat(64), batchChunks: [1],
    batches: [[{ pageId: 'candidate', slug: 'candidate', content: content('私有候选正文') }]], resumeKeys: [] });
  const another = f.open();
  assert.equal(another.wikiCheckpoint(scope, 'job')!.batches[0][0].content.title, '私有候选正文');
  assert.equal(another.wikiCheckpoint({ ...scope, userId: 'other' }, 'job'), undefined);
  assert.equal(JSON.stringify(another.wikiJobs(scope)).includes('私有候选正文'), false);
  assert.equal(JSON.stringify(another.wikiJob(scope, 'job')).includes('_checkpoint'), false);
  another.saveWikiJob({ ...job, state: 'interrupted' });
  assert.equal(another.wikiCheckpoint(scope, 'job')!.batches.length, 1);
  another.saveWikiJob({ ...job, jobId: 'newer', idempotencyKey: 'newer', state: 'completed' });
  another.saveWikiJob({ ...job, state: 'running' });
  assert.equal(another.wikiJobs(scope)[0].jobId, 'job', 'resumed older job remains visible after reload');
  // Calling initialization again must not touch or overwrite the verified backup.
  reopened.initializeWikiGeneration(backupPath);
});

test('WK-C01: rejects unversioned evidence, missing/overlapping sections, duplicate refs and oversized UTF-8 body', () => {
  const variants = [content(), content(), content(), content(), content(), content()];
  variants[0].evidenceRefs[0].evidence = { ...source, schemaVersion: 1, chunkId: 'legacy', verification: 'legacy-unverified' };
  variants[1].sections[0].end += 1;
  variants[2].sections.push(variants[2].sections[0]);
  variants[3].evidenceRefs = [];
  variants[4].evidenceRefs.push(variants[4].evidenceRefs[0]);
  variants[5].bodyMarkdown = '中'.repeat(100_000); variants[5].sections[0].end = 100_000;
  variants.forEach((value) => assert.equal(WikiContentSchema.safeParse(value).success, false));
  assert.equal(WikiContentSchema.safeParse(content()).success, true);
});

test('WK-S01a: failed job-table migration rolls back Wiki creation and preserves v4', (t) => {
  const f = fixture(t), db = f.inspect();
  db.exec('CREATE TABLE wiki_generation_jobs (existing TEXT)');
  assert.throws(() => f.evidence.initializeWikiGeneration(`${f.path}.backup`));
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='wiki_pages'").get(), undefined);
  assert.equal(f.evidence.searchKeywords('发票', 5).length, 1);
  assert.throws(() => f.evidence.initializeWikiGeneration(`${f.path}.backup`), /exists/);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
});

test('WK-S01: explicit v4→v5 migration preserves old evidence/FTS and ordinary readers accept v5', (t) => {
  const f = fixture(t), db = f.inspect();
  const before = db.prepare('SELECT payload FROM batches').get()!.payload;
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
  f.wiki();
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 5);
  assert.equal(db.prepare('SELECT payload FROM batches').get()!.payload, before);
  assert.deepEqual(f.open().getBatch(source, 'r1'), batch());
  assert.equal(f.open().searchKeywords('发票', 5).length, 1);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH 'test'").all();
  assert.ok(plan.some((r) => String(r.detail).includes('VIRTUAL TABLE INDEX')));
});

test('WK-S01: failed migration rolls back additions and keeps v4 evidence', (t) => {
  const f = fixture(t), db = f.inspect();
  db.exec('CREATE TABLE wiki_links(existing TEXT)');
  assert.throws(() => f.wiki());
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='wiki_pages'").get(), undefined);
  assert.deepEqual(f.evidence.getBatch(source, 'r1'), batch());
  assert.equal(f.evidence.searchKeywords('发票', 5).length, 1);
});

test('WK-S02: drafts invisible, publication atomic/idempotent, editing preserves published immutable revision', (t) => {
  const f = fixture(t), wiki = f.wiki();
  const first = draft(wiki);
  assert.deepEqual(draft(wiki), first);
  assert.equal(wiki.read('page'), undefined);
  assert.deepEqual(wiki.search('报销'), []);
  assert.equal(wiki.list({ draft: true }).length, 1);
  const revision = wiki.read('page', { draft: true })!.revision;
  const input = { pageId: 'page', baseGeneration: first.generation, draftRevisionId: revision.revisionId,
    contentHash: revision.contentHash, idempotencyKey: 'publish-once' };
  const published = wiki.publish(input);
  assert.deepEqual(wiki.publish(input), published);
  assert.equal(wiki.search('报销')[0].pageId, 'page');
  const newer = draft(wiki, 'page', content('差旅新版'), published.generation);
  // A resumed generation replays the original draft receipt, never the human's newer revision.
  assert.deepEqual(draft(wiki), first);
  assert.equal(wiki.read('page')!.revision.content.title, '差旅报销');
  assert.equal(wiki.read('page', { draft: true })!.revision.content.title, '差旅新版');
  assert.deepEqual(wiki.read('page', { revisionId: revision.revisionId })!.revision, revision);
  assert.throws(() => draft(wiki, 'page', content('冲突'), published.generation, 'new-conflict'), { code: 'REVISION_CONFLICT' });
  assert.throws(() => draft(wiki, 'other', content(), 0, 'save-page-0'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.open().openWiki(scope, () => true).read('page', { draft: true })!.page.generation, newer.generation);
});

test('WK-S02: injected FTS failure rolls back publication pointer and audit receipt', (t) => {
  const f = fixture(t), wiki = f.wiki(), page = draft(wiki), db = f.inspect();
  db.exec("CREATE TRIGGER reject_wiki_index BEFORE INSERT ON wiki_search_pages BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(() => publish(wiki, page), { code: 'INDEX_UNAVAILABLE' });
  assert.equal(wiki.read('page'), undefined);
  assert.equal(wiki.read('page', { draft: true })!.page.generation, page.generation);
  assert.equal(db.prepare("SELECT count(*) AS n FROM wiki_audit WHERE operation='publish'").get()!.n, 0);
  db.exec('DROP TRIGGER reject_wiki_index');
  publish(wiki, page); assert.equal(wiki.search('报销').length, 1);
});

test('WK-S03: source update marks stale and transactionally removes FTS; delete hides even historical content', (t) => {
  const f = fixture(t), wiki = f.wiki(), published = publish(wiki, draft(wiki));
  f.evidence.putBatch(batch('r2')); f.evidence.activate(source, 'r2', 1);
  assert.equal(wiki.read('page')!.freshness, 'stale');
  assert.deepEqual(wiki.search('报销'), []);
  assert.equal(f.inspect().prepare('SELECT count(*) AS n FROM wiki_search_pages').get()!.n, 0);
  assert.throws(() => draft(wiki, 'page', content(), published.generation), { code: 'SOURCE_CHANGED' });
  wiki.rebuildSearch(); assert.deepEqual(wiki.search('报销'), []);
  f.evidence.suppressChunks([], source);
  assert.equal(wiki.read('page'), undefined);
  assert.equal(wiki.read('page', { revisionId: published.publishedRevisionId! }), undefined);
  assert.deepEqual(wiki.list(), []);
  assert.deepEqual(f.evidence.getBatch(source, 'r1'), batch());
});

test('WK-A01: live source authorizer and owner/KB scoping protect read/search/links and idempotent replays', (t) => {
  const f = fixture(t), wiki = f.wiki(); publish(wiki, draft(wiki));
  for (const other of [{ ...scope, userId: 'other' }, { ...scope, orgId: 'other' }, { ...scope, knowledgeBaseId: 'other' }]) {
    const isolated = f.evidence.openWiki(other, () => true);
    assert.equal(isolated.read('page'), undefined);
    assert.deepEqual(isolated.search('报销'), []);
    assert.deepEqual(isolated.list(), []);
  }
  f.deny();
  assert.equal(wiki.read('page'), undefined); assert.deepEqual(wiki.search('报销'), []);
  assert.deepEqual(wiki.related('page'), []); assert.deepEqual(wiki.list(), []);
  assert.throws(() => draft(wiki), { code: 'INVALID_EVIDENCE' });
  f.allow(); assert.equal(wiki.search('报销').length, 1);
  const failClosed = f.evidence.openWiki(scope, () => { throw new Error('ACL unavailable'); });
  assert.equal(failClosed.read('page'), undefined);
});

test('WK-C01: tampered source hash/location, cross-KB sources and unknown links cannot create drafts', (t) => {
  const f = fixture(t), wiki = f.wiki();
  const variants = [content(), content(), content(), content()];
  variants[0].evidenceRefs[0].excerptHash = hash('wrong');
  const e = variants[1].evidenceRefs[0].evidence;
  if (e.verification === 'versioned') e.sourceLocation = { coordinateSystem: 'normalized-text-utf16', start: 1, end: 2 };
  variants[2].evidenceRefs[0].evidence.knowledgeBaseId = 'foreign';
  variants[3].links.push({ targetPageId: 'missing', sourceSectionId: 'section', label: 'Missing' });
  variants.forEach((c, i) => assert.throws(() => draft(wiki, `bad-${i}`, c), { code: 'INVALID_EVIDENCE' }));
  assert.deepEqual(wiki.list({ draft: true }), []);
});

test('WK-R01/R03: real Chinese FTS, exact title/alias precedence, deduplication and rebuild without vectors', (t) => {
  const f = fixture(t), wiki = f.wiki();
  publish(wiki, draft(wiki, 'a', content('差旅报销', '申请需要发票 ERROR-ＡＢＣ123')));
  const alias = content('财务指引', '操作说明'); alias.aliases = ['差旅报销'];
  publish(wiki, draft(wiki, 'b', alias));
  const body = content('其他', '差旅报销 ' + '无关 '.repeat(50)); body.aliases = [];
  publish(wiki, draft(wiki, 'c', body));
  assert.deepEqual(wiki.search('差旅报销').map((r) => r.pageId), ['a', 'b', 'c']);
  assert.ok(wiki.search('差旅报销')[0].matchKinds.includes('title-exact'));
  assert.ok(wiki.search('差旅报销')[1].matchKinds.includes('alias-exact'));
  assert.deepEqual(wiki.search('abc123').map((r) => r.pageId), ['a']);
  assert.deepEqual(wiki.search('票').map((r) => r.pageId), ['a']);
  assert.deepEqual(wiki.search('" * : () ---'), []);
  const before = wiki.search('报销'); wiki.rebuildSearch(); assert.deepEqual(wiki.search('报销'), before);
  const reopened = f.open().openWiki(scope, () => true); assert.deepEqual(reopened.search('报销'), before);
  assert.throws(() => wiki.search('x'.repeat(257)));
  assert.throws(() => wiki.search('报销', 51));
});

test('WK-R02: links are one hop, deduplicated, scoped and exclude unpublished/archived pages', (t) => {
  const f = fixture(t), wiki = f.wiki();
  let a = draft(wiki, 'a'), b = draft(wiki, 'b'), c = draft(wiki, 'c');
  const ac = content(); ac.links = [{ targetPageId: 'b', sourceSectionId: 'section', label: 'B' }];
  a = publish(wiki, draft(wiki, 'a', ac, a.generation));
  assert.deepEqual(wiki.related('a'), []);
  const bc = content(); bc.links = [{ targetPageId: 'c', sourceSectionId: 'section', label: 'C' }];
  b = publish(wiki, draft(wiki, 'b', bc, b.generation)); c = publish(wiki, c);
  assert.deepEqual(wiki.related('a', 'out').map((r) => r.pageId), ['b']);
  assert.deepEqual(wiki.related('b', 'both').map((r) => r.pageId), ['a', 'c']);
  assert.deepEqual(wiki.related('c', 'out'), []);
  wiki.archive('b', { baseGeneration: b.generation, idempotencyKey: 'archive-b' });
  assert.deepEqual(wiki.related('a'), []); assert.equal(wiki.read('b'), undefined);
  assert.ok(wiki.read('b', { includeArchived: true }));
  assert.throws(() => wiki.related('a', 'out', 11), { code: 'INVALID_INPUT' });
});

test('WK-S03: suppressed evidence blocks current and historical derived content immediately', (t) => {
  const f = fixture(t), wiki = f.wiki(); publish(wiki, draft(wiki));
  f.evidence.suppressChunks(['chunk-r1']);
  assert.equal(wiki.read('page'), undefined); assert.deepEqual(wiki.search('报销'), []);
  assert.equal(f.inspect().prepare('SELECT count(*) AS n FROM wiki_search_pages').get()!.n, 0);
});

test('WK-R03: FTS corruption is an explicit error, never a successful empty result', (t) => {
  const f = fixture(t), wiki = f.wiki(); publish(wiki, draft(wiki));
  f.inspect().exec('DROP TABLE wiki_fts');
  assert.throws(() => wiki.search('报销'), { code: 'INDEX_UNAVAILABLE' });
  assert.ok(wiki.read('page'));
});

test('WK-S02: two writers cannot publish an obsolete draft and failed rebuild preserves the old projection', (t) => {
  const f = fixture(t), first = f.wiki(), second = f.open().openWiki(scope, () => true);
  const original = draft(first), view = first.read('page', { draft: true })!;
  const newer = draft(second, 'page', content('新标题'), original.generation);
  assert.throws(() => first.publish({ pageId: 'page', baseGeneration: original.generation,
    draftRevisionId: view.revision.revisionId, contentHash: view.revision.contentHash, idempotencyKey: 'obsolete' }), { code: 'REVISION_CONFLICT' });
  publish(second, newer);
  const before = first.search('新标题'), db = f.inspect();
  db.exec("CREATE TRIGGER reject_wiki_rebuild BEFORE INSERT ON wiki_search_pages BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(() => first.rebuildSearch(), { code: 'INDEX_UNAVAILABLE' });
  assert.deepEqual(first.search('新标题'), before);
});

test('WK-S03: failure invalidating Wiki rolls back source activation and suppression, not only Wiki writes', (t) => {
  const f = fixture(t), wiki = f.wiki(); publish(wiki, draft(wiki));
  f.evidence.putBatch(batch('r2'));
  const db = f.inspect();
  db.exec("CREATE TRIGGER reject_wiki_invalidate BEFORE DELETE ON wiki_search_pages BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(() => f.evidence.activate(source, 'r2', 1), { code: 'FULLTEXT_INDEX_FAILED' });
  assert.equal(f.evidence.getHead(source).processingRevisionId, 'r1');
  assert.equal(wiki.read('page')!.freshness, 'current');
  assert.throws(() => f.evidence.suppressChunks(['chunk-r1']));
  assert.deepEqual(f.evidence.getVisibility().suppressedChunkIds, []);
  assert.equal(wiki.search('报销').length, 1);
});
