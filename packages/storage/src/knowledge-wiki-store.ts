import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  KnowledgeEvidenceBatchSchema, WikiScopeSchema, WikiSaveDraftSchema, WikiPublishSchema,
  WikiMutationSchema, WikiSearchSchema, WikiPageSchema, WikiRevisionSchema,
  type WikiScope, type WikiEvidenceRef, type WikiContent, type WikiPage, type WikiRevision,
  type WikiSaveDraft, type WikiPublish, type WikiMutation, type WikiFreshness, type WikiPageView,
  type WikiSearchHit, type WikiRelatedPage,
  WikiMergeBodySchema, type WikiMergeBody, type WikiMergePreview,
} from '@workmate/contracts';
import { knowledgeTokens } from './knowledge-tokenizer.js';
import { appendWikiSections } from './wiki-merge.js';

export class KnowledgeWikiError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_EVIDENCE' | 'SOURCE_CHANGED'
    | 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'INDEX_UNAVAILABLE' | 'UNSUPPORTED_SCHEMA' | 'MERGE_LIMIT_EXCEEDED', message: string) {
    super(message); this.name = 'KnowledgeWikiError';
  }
}
const fail = (code: KnowledgeWikiError['code'], message: string): never => { throw new KnowledgeWikiError(code, message); };
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(v);
}
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const normalize = (v: string) => v.normalize('NFKC').trim().toLowerCase();

/** Called inside the evidence store's transaction, only on explicit Wiki initialization. */
export function migrateWiki(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version === 5 || version === 6) return;
  if (version !== 4) fail('UNSUPPORTED_SCHEMA', 'Wiki requires evidence schema v4 or v5');
  db.exec(`
    CREATE TABLE wiki_pages (
      page_id TEXT PRIMARY KEY, scope TEXT NOT NULL, slug TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0, published_revision_id TEXT, draft_revision_id TEXT,
      archived_at TEXT, UNIQUE(scope,slug));
    CREATE INDEX wiki_pages_scope ON wiki_pages(scope,page_id);
    CREATE TABLE wiki_revisions (
      revision_id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES wiki_pages(page_id),
      payload TEXT NOT NULL);
    CREATE INDEX wiki_revisions_page ON wiki_revisions(page_id,revision_id);
    CREATE TABLE wiki_sections (
      revision_id TEXT NOT NULL REFERENCES wiki_revisions(revision_id), section_id TEXT NOT NULL,
      start INTEGER NOT NULL, end INTEGER NOT NULL, PRIMARY KEY(revision_id,section_id));
    CREATE TABLE wiki_evidence_refs (
      revision_id TEXT NOT NULL REFERENCES wiki_revisions(revision_id), ref_id TEXT NOT NULL,
      section_id TEXT NOT NULL, source_scope TEXT NOT NULL, processing_revision_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL, PRIMARY KEY(revision_id,ref_id));
    CREATE INDEX wiki_refs_source ON wiki_evidence_refs(source_scope,processing_revision_id);
    CREATE INDEX wiki_refs_chunk ON wiki_evidence_refs(chunk_id);
    CREATE TABLE wiki_links (
      revision_id TEXT NOT NULL REFERENCES wiki_revisions(revision_id), target_page_id TEXT NOT NULL REFERENCES wiki_pages(page_id),
      section_id TEXT NOT NULL, PRIMARY KEY(revision_id,target_page_id,section_id));
    CREATE INDEX wiki_links_target ON wiki_links(target_page_id);
    CREATE TABLE wiki_search_pages (
      rowid INTEGER PRIMARY KEY, page_id TEXT NOT NULL UNIQUE REFERENCES wiki_pages(page_id),
      scope TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES wiki_revisions(revision_id),
      title_exact TEXT NOT NULL, aliases_exact TEXT NOT NULL,
      title_terms TEXT NOT NULL, alias_terms TEXT NOT NULL, summary_terms TEXT NOT NULL, body_terms TEXT NOT NULL);
    CREATE INDEX wiki_search_scope ON wiki_search_pages(scope,page_id);
    CREATE INDEX wiki_search_title ON wiki_search_pages(scope,title_exact);
    CREATE VIRTUAL TABLE wiki_fts USING fts5(title_terms,alias_terms,summary_terms,body_terms,
      content='wiki_search_pages',content_rowid='rowid');
    CREATE TRIGGER wiki_search_ai AFTER INSERT ON wiki_search_pages BEGIN
      INSERT INTO wiki_fts(rowid,title_terms,alias_terms,summary_terms,body_terms)
        VALUES(new.rowid,new.title_terms,new.alias_terms,new.summary_terms,new.body_terms); END;
    CREATE TRIGGER wiki_search_ad AFTER DELETE ON wiki_search_pages BEGIN
      INSERT INTO wiki_fts(wiki_fts,rowid,title_terms,alias_terms,summary_terms,body_terms)
        VALUES('delete',old.rowid,old.title_terms,old.alias_terms,old.summary_terms,old.body_terms); END;
    CREATE TABLE wiki_mutations (
      scope TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,operation,idempotency_key));
    CREATE TABLE wiki_audit (
      event_id TEXT PRIMARY KEY, scope TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL,
      page_id TEXT NOT NULL, generation INTEGER NOT NULL, created_at TEXT NOT NULL);
    PRAGMA user_version=5;
  `);
}

/** Keep source-head changes and derived index visibility in the SAME transaction. */
export function invalidateWikiSearch(db: DatabaseSync): void {
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) < 5) return;
  db.exec(`DELETE FROM wiki_search_pages WHERE EXISTS (
    SELECT 1 FROM wiki_evidence_refs r LEFT JOIN documents d ON d.scope=r.source_scope
    WHERE r.revision_id=wiki_search_pages.revision_id
      AND (d.revision IS NULL OR d.revision<>r.processing_revision_id
        OR EXISTS (SELECT 1 FROM suppressed_chunks s WHERE s.chunk_id=r.chunk_id)))`);
}

/** Host must check live source ownership/ACL on every call, not cache a one-time allow decision. */
export type WikiSourceAuthorizer = (ref: WikiEvidenceRef, scope: WikiScope) => boolean;

/** Connection lifetime belongs to KnowledgeEvidenceStore. No model calls or asynchronous I/O in transactions. */
export class KnowledgeWikiStore {
  private readonly scope: WikiScope;
  private readonly key: string;
  constructor(private readonly db: DatabaseSync, scope: WikiScope,
    private readonly authorizeSource: WikiSourceAuthorizer) {
    this.scope = WikiScopeSchema.parse(scope);
    this.key = JSON.stringify([this.scope.orgId, this.scope.userId, this.scope.knowledgeBaseId]);
    if (typeof authorizeSource !== 'function') fail('INVALID_INPUT', 'Live source authorizer required');
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private page(pageId: string): WikiPage | undefined {
    const row = this.db.prepare('SELECT * FROM wiki_pages WHERE scope=? AND page_id=?').get(this.key, pageId);
    if (!row) return undefined;
    return WikiPageSchema.parse({ schemaVersion: 1, pageId: row.page_id, knowledgeBaseId: this.scope.knowledgeBaseId,
      slug: row.slug, generation: row.generation, publishedRevisionId: row.published_revision_id,
      draftRevisionId: row.draft_revision_id, archivedAt: row.archived_at });
  }
  private revision(pageId: string, revisionId: string): WikiRevision {
    const row = this.db.prepare('SELECT payload FROM wiki_revisions WHERE page_id=? AND revision_id=?').get(pageId, revisionId);
    if (!row) return fail('NOT_FOUND', 'Wiki page unavailable');
    const revision = WikiRevisionSchema.parse(JSON.parse(String(row.payload)));
    if (revision.pageId !== pageId || revision.revisionId !== revisionId
      || hash(canonical(revision.content)) !== revision.contentHash) fail('INVALID_EVIDENCE', 'Wiki revision integrity check failed');
    return revision;
  }

  private evidenceState(ref: WikiEvidenceRef): WikiFreshness {
    const e = ref.evidence;
    if (e.verification !== 'versioned' || e.provider !== 'lancedb' || e.knowledgeBaseId !== this.scope.knowledgeBaseId) return 'blocked';
    try { if (this.authorizeSource(ref, this.scope) !== true) return 'blocked'; } catch { return 'blocked'; }
    const sourceScope = JSON.stringify([e.provider, e.knowledgeBaseId, e.documentId]);
    const row = this.db.prepare(`SELECT b.payload,d.revision FROM batches b JOIN documents d ON d.scope=b.scope
      WHERE b.scope=? AND b.revision=?`).get(sourceScope, e.processingRevisionId);
    if (!row || row.revision == null || this.db.prepare('SELECT 1 FROM suppressed_chunks WHERE chunk_id=?').get(e.chunkId)) return 'blocked';
    const batch = KnowledgeEvidenceBatchSchema.parse(JSON.parse(String(row.payload)));
    const chunk = batch.chunks.find((c) => c.evidence.chunkId === e.chunkId);
    if (!chunk || canonical(chunk.evidence) !== canonical(e) || hash(chunk.content) !== e.contentHash
      || ref.excerptHash !== e.contentHash) return 'blocked';
    return row.revision === e.processingRevisionId ? 'current' : 'stale';
  }
  private freshness(content: WikiContent): WikiFreshness {
    let state: WikiFreshness = 'current';
    for (const ref of content.evidenceRefs) {
      const next = this.evidenceState(ref);
      if (next === 'blocked') return next;
      if (next === 'stale') state = next;
    }
    return state;
  }
  private requireCurrent(content: WikiContent): void {
    const freshness = this.freshness(content);
    if (freshness === 'blocked') fail('INVALID_EVIDENCE', 'Wiki source unavailable or invalid');
    if (freshness === 'stale') fail('SOURCE_CHANGED', 'Wiki source has changed');
    for (const link of content.links) {
      const target = this.page(link.targetPageId);
      const revisionId = target?.draftRevisionId ?? target?.publishedRevisionId;
      if (!target || target.archivedAt || !revisionId
        || this.freshness(this.revision(target.pageId, revisionId).content) === 'blocked') {
        fail('INVALID_EVIDENCE', 'Wiki link target unavailable');
      }
    }
  }
  private mutate(operation: string, input: WikiMutation, request: unknown, fn: () => WikiPage): WikiPage {
    WikiMutationSchema.parse({ baseGeneration: input.baseGeneration, idempotencyKey: input.idempotencyKey });
    return this.transaction(() => {
      const requestHash = hash(canonical(request));
      const old = this.db.prepare('SELECT request_hash,result FROM wiki_mutations WHERE scope=? AND operation=? AND idempotency_key=?')
        .get(this.key, operation, input.idempotencyKey);
      if (old) {
        if (old.request_hash !== requestHash) return fail('IDEMPOTENCY_CONFLICT', 'Idempotency key already used for another request');
        return WikiPageSchema.parse(JSON.parse(String(old.result)));
      }
      const page = fn();
      this.db.prepare('INSERT INTO wiki_mutations VALUES (?,?,?,?,?)')
        .run(this.key, operation, input.idempotencyKey, requestHash, JSON.stringify(page));
      this.db.prepare('INSERT INTO wiki_audit VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), this.key, this.scope.userId, operation, page.pageId, page.generation, new Date().toISOString());
      return page;
    });
  }

  saveDraft(input: WikiSaveDraft): WikiPage {
    const value = WikiSaveDraftSchema.parse(input);
    // Authorize even an idempotent replay; receipt contains metadata, never stale plaintext.
    this.requireCurrent(value.content);
    return this.mutate('draft', value, value, () => this.writeDraft(value));
  }
  private writeDraft(value: WikiSaveDraft): WikiPage {
      this.requireCurrent(value.content);
      let page = this.page(value.pageId);
      if (!page) {
        if (value.baseGeneration !== 0) return fail('REVISION_CONFLICT', 'Wiki page generation changed');
        if (this.db.prepare('SELECT 1 FROM wiki_pages WHERE page_id=? OR (scope=? AND slug=?)')
          .get(value.pageId, this.key, normalize(value.slug))) return fail('REVISION_CONFLICT', 'Wiki identity already exists');
        this.db.prepare('INSERT INTO wiki_pages(page_id,scope,slug) VALUES (?,?,?)').run(value.pageId, this.key, normalize(value.slug));
        page = this.page(value.pageId)!;
      }
      if (page.archivedAt || page.generation !== value.baseGeneration) return fail('REVISION_CONFLICT', 'Wiki page generation changed');
      if (this.db.prepare('SELECT 1 FROM wiki_pages WHERE scope=? AND slug=? AND page_id<>?')
        .get(this.key, normalize(value.slug), page.pageId)) return fail('REVISION_CONFLICT', 'Wiki slug already exists');
      const revision: WikiRevision = { schemaVersion: 1, revisionId: randomUUID(), pageId: page.pageId,
        parentRevisionId: page.draftRevisionId ?? page.publishedRevisionId, content: value.content,
        contentHash: hash(canonical(value.content)), authorType: value.authorType,
        createdBy: this.scope.userId, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO wiki_revisions VALUES (?,?,?)').run(revision.revisionId, page.pageId, JSON.stringify(revision));
      for (const section of value.content.sections) this.db.prepare('INSERT INTO wiki_sections VALUES (?,?,?,?)')
        .run(revision.revisionId, section.sectionId, section.start, section.end);
      for (const ref of value.content.evidenceRefs) {
        const e = ref.evidence;
        if (e.verification !== 'versioned') return fail('INVALID_EVIDENCE', 'Versioned evidence required');
        this.db.prepare('INSERT INTO wiki_evidence_refs VALUES (?,?,?,?,?,?)').run(revision.revisionId, ref.refId, ref.sectionId,
          JSON.stringify([e.provider, e.knowledgeBaseId, e.documentId]), e.processingRevisionId, e.chunkId);
      }
      for (const link of value.content.links) this.db.prepare('INSERT INTO wiki_links VALUES (?,?,?)')
        .run(revision.revisionId, link.targetPageId, link.sourceSectionId);
      this.db.prepare('UPDATE wiki_pages SET slug=?,draft_revision_id=?,generation=generation+1 WHERE page_id=? AND scope=?')
        .run(normalize(value.slug), revision.revisionId, page.pageId, this.key);
      return this.page(page.pageId)!;
  }

  mergeCandidates(sourcePageId: string): { pageId: string; title: string }[] {
    const source = this.read(sourcePageId, { draft: true });
    if (!source || source.page.publishedRevisionId) return fail('NOT_FOUND', 'Unpublished draft required');
    this.requireCurrent(source.revision.content);
    return this.search(source.revision.content.title, 50)
      .filter((hit) => hit.pageId !== sourcePageId && hit.matchKinds.some((kind) => kind === 'title-exact' || kind === 'alias-exact'))
      .filter((hit) => {
        const target = this.mergeTarget(hit.pageId);
        return target?.freshness === 'current' && [target.revision.content.title, ...target.revision.content.aliases]
          .some((title) => normalize(title) === normalize(source.revision.content.title));
      }).slice(0, 5).map((hit) => ({ pageId: hit.pageId, title: hit.title }));
  }

  previewMerge(sourcePageId: string, targetPageId: string): WikiMergePreview {
    const source = this.read(sourcePageId, { draft: true });
    const target = this.mergeTarget(targetPageId);
    if (!source || source.page.publishedRevisionId || !target?.page.publishedRevisionId || sourcePageId === targetPageId) {
      return fail('NOT_FOUND', 'Merge pages unavailable');
    }
    this.requireCurrent(source.revision.content); this.requireCurrent(target.revision.content);
    if (![target.revision.content.title, ...target.revision.content.aliases].some((title) => normalize(title) === normalize(source.revision.content.title))) {
      return fail('INVALID_INPUT', 'No exact topic match');
    }
    let result: ReturnType<typeof appendWikiSections>;
    try { result = appendWikiSections(source, target); }
    catch { return fail('MERGE_LIMIT_EXCEEDED', 'Merged content exceeds page limits'); }
    return { ...result, targetPageId, sourceRevisionId: source.revision.revisionId, targetRevisionId: target.revision.revisionId,
      sourceGeneration: source.page.generation, baseGeneration: target.page.generation,
      targetBody: target.revision.content.bodyMarkdown, previewHash: hash(canonical(result.content)) };
  }

  mergeDraft(sourcePageId: string, input: WikiMergeBody): WikiPage {
    const value = WikiMergeBodySchema.parse(input);
    const source = this.read(sourcePageId, { draft: true });
    const target = this.mergeTarget(value.targetPageId);
    if (!source || !target) return fail('NOT_FOUND', 'Merge pages unavailable');
    this.requireCurrent(source.revision.content); this.requireCurrent(target.revision.content);
    return this.mutate('merge', value, { sourcePageId, ...value }, () => {
      const preview = this.previewMerge(sourcePageId, value.targetPageId);
      if (preview.sourceGeneration !== value.sourceGeneration || preview.baseGeneration !== value.baseGeneration
        || preview.sourceRevisionId !== value.sourceRevisionId || preview.targetRevisionId !== value.targetRevisionId
        || preview.previewHash !== value.previewHash) return fail('REVISION_CONFLICT', 'Merge preview changed');
      if (!preview.addedSections) return fail('INVALID_INPUT', 'No new sections');
      return this.writeDraft({ pageId: value.targetPageId, slug: target.page.slug, content: preview.content,
        authorType: 'human', baseGeneration: value.baseGeneration, idempotencyKey: value.idempotencyKey });
    });
  }

  private mergeTarget(pageId: string): WikiPageView | undefined {
    const page = this.page(pageId);
    return page ? this.read(pageId, { draft: !!page.draftRevisionId }) : undefined;
  }

  private index(page: WikiPage, revision: WikiRevision): void {
    const c = revision.content;
    this.db.prepare('DELETE FROM wiki_search_pages WHERE page_id=?').run(page.pageId);
    this.db.prepare(`INSERT INTO wiki_search_pages(page_id,scope,revision_id,title_exact,aliases_exact,
      title_terms,alias_terms,summary_terms,body_terms) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(page.pageId, this.key, revision.revisionId, normalize(c.title), JSON.stringify(c.aliases.map(normalize)),
        knowledgeTokens(c.title).join(' '), knowledgeTokens(c.aliases.join(' ')).join(' '),
        knowledgeTokens(c.summary).join(' '), knowledgeTokens(c.bodyMarkdown).join(' '));
  }
  publish(input: WikiPublish): WikiPage {
    const value = WikiPublishSchema.parse(input);
    const page = this.page(value.pageId);
    if (!page) return fail('NOT_FOUND', 'Wiki page unavailable');
    this.requireCurrent(this.revision(page.pageId, value.draftRevisionId).content);
    return this.mutate('publish', value, value, () => {
      const current = this.page(value.pageId)!;
      if (current.archivedAt || current.generation !== value.baseGeneration || current.draftRevisionId !== value.draftRevisionId) {
        return fail('REVISION_CONFLICT', 'Wiki draft changed; review again');
      }
      const revision = this.revision(current.pageId, value.draftRevisionId);
      if (revision.contentHash !== value.contentHash) return fail('REVISION_CONFLICT', 'Reviewed content changed');
      this.requireCurrent(revision.content);
      this.db.prepare('UPDATE wiki_pages SET published_revision_id=?,draft_revision_id=NULL,generation=generation+1 WHERE page_id=? AND scope=?')
        .run(revision.revisionId, current.pageId, this.key);
      try { this.index(current, revision); } catch (cause) {
        const error = new KnowledgeWikiError('INDEX_UNAVAILABLE', 'Wiki search publication failed'); error.cause = cause; throw error;
      }
      return this.page(current.pageId)!;
    });
  }
  read(pageId: string, options: { draft?: boolean; revisionId?: string; includeArchived?: boolean } = {}): WikiPageView | undefined {
    const page = this.page(pageId);
    if (!page || (page.archivedAt && !options.includeArchived)) return undefined;
    const revisionId = options.revisionId ?? (options.draft ? page.draftRevisionId : page.publishedRevisionId);
    if (!revisionId) return undefined;
    const revision = this.revision(pageId, revisionId), freshness = this.freshness(revision.content);
    return freshness === 'blocked' ? undefined : { page, revision, freshness };
  }
  archive(pageId: string, input: WikiMutation): WikiPage {
    return this.mutate('archive', input, { pageId, ...input }, () => {
      const page = this.page(pageId);
      if (!page) return fail('NOT_FOUND', 'Wiki page unavailable');
      if (page.generation !== input.baseGeneration) return fail('REVISION_CONFLICT', 'Wiki page generation changed');
      this.db.prepare('UPDATE wiki_pages SET archived_at=?,generation=generation+1 WHERE page_id=? AND scope=?')
        .run(new Date().toISOString(), pageId, this.key);
      this.db.prepare('DELETE FROM wiki_search_pages WHERE page_id=?').run(pageId);
      return this.page(pageId)!;
    });
  }
  list(options: { draft?: boolean; limit?: number; afterPageId?: string } = {}): WikiPageView[] {
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return fail('INVALID_INPUT', 'Wiki list limit must be 1..50');
    // Iterate in bounded batches so inaccessible rows neither leak nor consume the result quota.
    const results: WikiPageView[] = []; let after = options.afterPageId ?? '';
    while (results.length < limit) {
      const rows = this.db.prepare(`SELECT page_id FROM wiki_pages WHERE scope=? AND archived_at IS NULL AND page_id>?
        AND ${options.draft ? 'draft_revision_id' : 'published_revision_id'} IS NOT NULL ORDER BY page_id LIMIT 50`).all(this.key, after);
      if (!rows.length) break;
      for (const row of rows) {
        after = String(row.page_id); const view = this.read(after, { draft: options.draft });
        if (view) results.push(view);
        if (results.length === limit) break;
      }
    }
    return results;
  }
  search(query: string, limit = 20): WikiSearchHit[] {
    const value = WikiSearchSchema.parse({ query, limit });
    if (!value.query.trim()) return [];
    const tokens = knowledgeTokens(value.query, true);
    const exact = normalize(value.query);
    try {
      const rows = this.db.prepare(`WITH keyword AS (
          SELECT rowid,bm25(wiki_fts,5,4,2,1) AS score FROM wiki_fts WHERE wiki_fts MATCH ?
        ), candidates AS (
          SELECT s.page_id,s.revision_id,k.score,
          CASE WHEN s.title_exact=? THEN 0 WHEN EXISTS(SELECT 1 FROM json_each(s.aliases_exact) WHERE value=?) THEN 1 ELSE 2 END AS tier
          FROM wiki_search_pages s LEFT JOIN keyword k ON k.rowid=s.rowid
          JOIN wiki_pages p ON p.page_id=s.page_id AND p.published_revision_id=s.revision_id
          WHERE s.scope=? AND p.archived_at IS NULL AND (k.rowid IS NOT NULL OR s.title_exact=?
            OR EXISTS(SELECT 1 FROM json_each(s.aliases_exact) WHERE value=?))
        ) SELECT * FROM candidates ORDER BY tier,COALESCE(score,0),page_id`)
        .iterate(tokens.length ? tokens.map((token) => `"${token}"`).join(' OR ') : '"__wiki_no_token__"', exact, exact, this.key, exact, exact);
      const hits: WikiSearchHit[] = [];
      for (const row of rows) {
        const view = this.read(String(row.page_id));
        if (!view || view.freshness !== 'current') continue;
        const c = view.revision.content;
        const body = c.bodyMarkdown;
        const position = body.toLowerCase().indexOf(value.query.trim().toLowerCase());
        const start = Math.max(0, position - 60);
        hits.push({ pageId: view.page.pageId, revisionId: view.revision.revisionId, title: c.title,
          snippet: body.slice(start, start + 240), matchKinds: [
            ...(row.tier === 0 ? ['title-exact' as const] : row.tier === 1 ? ['alias-exact' as const] : []),
            ...(row.score == null ? [] : ['keyword' as const])],
          bm25: row.score == null ? null : Number(row.score), rank: hits.length + 1, freshness: 'current' });
        if (hits.length === limit) break;
      }
      return hits;
    } catch (cause) {
      if (cause instanceof KnowledgeWikiError) throw cause;
      const error = new KnowledgeWikiError('INDEX_UNAVAILABLE', 'Wiki search unavailable'); error.cause = cause; throw error;
    }
  }
  related(pageId: string, direction: 'in' | 'out' | 'both' = 'both', limit = 10): WikiRelatedPage[] {
    if (!['in', 'out', 'both'].includes(direction) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      return fail('INVALID_INPUT', 'Invalid Wiki expansion limits');
    }
    const seed = this.read(pageId);
    if (!seed || seed.freshness !== 'current') return [];
    const rows = this.db.prepare(`SELECT target_page_id AS page_id,'out' AS direction FROM wiki_links WHERE revision_id=?
      UNION ALL SELECT p.page_id,'in' AS direction FROM wiki_links l JOIN wiki_pages p ON p.published_revision_id=l.revision_id
      WHERE l.target_page_id=? AND p.scope=? ORDER BY page_id,direction`)
      .iterate(seed.revision.revisionId, pageId, this.key);
    const result: WikiRelatedPage[] = [], seen = new Set([pageId]);
    for (const row of rows) {
      if (direction !== 'both' && row.direction !== direction) continue;
      const id = String(row.page_id);
      if (seen.has(id)) continue;
      const view = this.read(id);
      if (!view || view.freshness !== 'current') continue;
      seen.add(id); result.push({ pageId: id, revisionId: view.revision.revisionId, title: view.revision.content.title,
        seedPageId: pageId, direction: row.direction as 'in' | 'out' });
      if (result.length === limit) break;
    }
    return result;
  }
  rebuildSearch(): void {
    try {
      this.transaction(() => {
        this.db.prepare('DELETE FROM wiki_search_pages WHERE scope=?').run(this.key);
        const rows = this.db.prepare('SELECT page_id FROM wiki_pages WHERE scope=? AND archived_at IS NULL AND published_revision_id IS NOT NULL').all(this.key);
        for (const row of rows) {
          const view = this.read(String(row.page_id));
          if (view?.freshness === 'current') this.index(view.page, view.revision);
        }
      });
    } catch (cause) {
      const error = new KnowledgeWikiError('INDEX_UNAVAILABLE', 'Wiki search rebuild failed'); error.cause = cause; throw error;
    }
  }
}
