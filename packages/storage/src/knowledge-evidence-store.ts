import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  KnowledgeDocumentScopeSchema, KnowledgeEvidenceBatchSchema, KnowledgeSearchChunkSchema,
  type KnowledgeSearchChunk, type KnowledgeKeywordHit, type KnowledgeParentContext,
  type KnowledgeDocumentScope, type KnowledgeEvidenceBatch, type KnowledgeEvidenceHead, type KnowledgeRetrievalVisibility, type KnowledgeEvidence,
} from '@workmate/contracts';
import { knowledgeTokens } from './knowledge-tokenizer.js';
import { KnowledgeWikiStore, migrateWiki, invalidateWikiSearch, type WikiSourceAuthorizer } from './knowledge-wiki-store.js';
import { WikiScopeSchema, WikiGenerationJobSchema, type WikiScope, type WikiGenerationJob } from '@workmate/contracts';
import { WikiGenerationCheckpointSchema, type WikiGenerationCheckpoint } from '@workmate/contracts';

export class KnowledgeEvidenceStoreError extends Error {
  constructor(public readonly code: 'CONFLICT' | 'NOT_FOUND' | 'INVALID_BATCH' | 'UNSUPPORTED_SCHEMA' | 'FULLTEXT_INDEX_FAILED', message: string) {
    super(message);
    this.name = 'KnowledgeEvidenceStoreError';
  }
}
const fail = (code: KnowledgeEvidenceStoreError['code'], message: string): never => {
  throw new KnowledgeEvidenceStoreError(code, message);
};
function scopeKey(scope: KnowledgeDocumentScope): string {
  const value = KnowledgeDocumentScopeSchema.parse(scope);
  return JSON.stringify([value.provider, value.knowledgeBaseId, value.documentId]);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const APPLICATION_ID = 0x57454b45;

/** API-owned, dedicated evidence database. Never point this at the legacy ontology database. */
export class KnowledgeEvidenceStore {
  private readonly db: DatabaseSync;

  constructor(path: string, options: { existingOnly?: boolean; readOnly?: boolean } = {}) {
    const { DatabaseSync: SQLite } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.db = new SQLite(path, { readOnly: options.readOnly ?? options.existingOnly ?? false });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
      if (options.existingOnly) {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        if (![4, 5, 6].includes(version) || this.db.prepare('PRAGMA application_id').get()!.application_id !== APPLICATION_ID) {
          fail('UNSUPPORTED_SCHEMA', 'Unsupported existing evidence database');
        }
        return;
      }
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
        const application = this.db.prepare('PRAGMA application_id').get()!.application_id;
        if (version === 0 && application === 0) {
          const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
          if (existing) fail('UNSUPPORTED_SCHEMA', 'Refusing to initialize a non-empty database');
          this.db.exec(`
            CREATE TABLE documents (scope TEXT PRIMARY KEY, revision TEXT, generation INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE versions (scope TEXT NOT NULL REFERENCES documents(scope), version TEXT NOT NULL,
              source_hash TEXT NOT NULL, PRIMARY KEY(scope, version));
            CREATE TABLE batches (scope TEXT NOT NULL, revision TEXT NOT NULL, version TEXT NOT NULL,
              payload TEXT NOT NULL, PRIMARY KEY(scope, revision),
              FOREIGN KEY(scope, version) REFERENCES versions(scope, version));
            PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          `);
        } else if (![1, 2, 3, 4, 5, 6].includes(Number(version)) || application !== APPLICATION_ID) {
          fail('UNSUPPORTED_SCHEMA', 'Unsupported evidence database schema');
        }
        if (Number(version) < 2) {
          this.db.exec(`CREATE TABLE membership (chunk_id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision TEXT NOT NULL,
            FOREIGN KEY(scope, revision) REFERENCES batches(scope, revision));
            CREATE INDEX membership_batch ON membership(scope, revision);
            CREATE TABLE suppressed_chunks (chunk_id TEXT PRIMARY KEY);
            PRAGMA user_version=2;`);
          for (const row of this.db.prepare('SELECT payload FROM batches').all()) {
            this.indexBatch(KnowledgeEvidenceBatchSchema.parse(JSON.parse(String(row.payload))));
          }
        }
        if (Number(version) < 3) {
          this.db.exec(`CREATE TABLE search_chunks (
            rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL,
            scope TEXT, title TEXT NOT NULL, source TEXT, content TEXT NOT NULL,
            title_terms TEXT NOT NULL, body_terms TEXT NOT NULL);
            CREATE INDEX search_chunks_scope ON search_chunks(scope);
            CREATE VIRTUAL TABLE chunk_fts USING fts5(title_terms, body_terms, content='search_chunks', content_rowid='rowid');
            CREATE TRIGGER search_chunks_ai AFTER INSERT ON search_chunks BEGIN
              INSERT INTO chunk_fts(rowid,title_terms,body_terms) VALUES(new.rowid,new.title_terms,new.body_terms); END;
            CREATE TRIGGER search_chunks_ad AFTER DELETE ON search_chunks BEGIN
              INSERT INTO chunk_fts(chunk_fts,rowid,title_terms,body_terms) VALUES('delete',old.rowid,old.title_terms,old.body_terms); END;
            PRAGMA user_version=3;`);
          for (const row of this.db.prepare(`SELECT b.payload FROM batches b JOIN documents d
            ON b.scope=d.scope AND b.revision=d.revision`).all()) {
            this.indexActiveBatch(KnowledgeEvidenceBatchSchema.parse(JSON.parse(String(row.payload))));
          }
        }
        // v4 protects the optional parentChunks payload from older strict readers.
        if (Number(version) < 4) this.db.exec('PRAGMA user_version=4');
      });
      this.db.exec('PRAGMA journal_mode=WAL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private insertSearchChunk(row: KnowledgeSearchChunk, scope: string | null): void {
    if (this.db.prepare('SELECT 1 FROM suppressed_chunks WHERE chunk_id=?').get(row.id)) return;
    const existing = this.db.prepare('SELECT * FROM search_chunks WHERE id=?').get(row.id);
    if (existing && existing.scope === scope && existing.document_id === row.documentId && existing.title === row.title
      && existing.content === row.content && existing.source === (row.source ?? null)) return;
    this.db.prepare('DELETE FROM search_chunks WHERE id=?').run(row.id);
    this.db.prepare(`INSERT INTO search_chunks(id,document_id,scope,title,source,content,title_terms,body_terms)
      VALUES (?,?,?,?,?,?,?,?)`).run(row.id, row.documentId, scope, row.title, row.source ?? null, row.content,
        knowledgeTokens(row.title).join(' '), knowledgeTokens(row.content).join(' '));
  }

  private indexActiveBatch(batch: KnowledgeEvidenceBatch): void {
    const key = scopeKey({ provider: batch.provider, knowledgeBaseId: batch.knowledgeBaseId, documentId: batch.documentId });
    this.db.prepare('DELETE FROM search_chunks WHERE scope=?').run(key);
    for (const chunk of batch.chunks) this.insertSearchChunk({ id: chunk.evidence.chunkId,
      documentId: batch.documentId, title: [batch.documentTitle || chunk.content.slice(0, 80),
        ...(chunk.evidence.verification === 'versioned' ? chunk.evidence.headingPath ?? [] : [])].join(' · '),
      content: chunk.content, source: batch.source }, key);
  }

  /** Compatibility projection only: never upgrades legacy rows to verified evidence. */
  indexLegacyChunks(rows: KnowledgeSearchChunk[]): void {
    this.transaction(() => {
      for (const input of rows) {
        const row = KnowledgeSearchChunkSchema.parse(input);
        if (row.id.startsWith('ch-') || this.db.prepare('SELECT 1 FROM membership WHERE chunk_id=?').get(row.id)) continue;
        if (this.db.prepare(`SELECT 1 FROM documents WHERE json_extract(scope,'$[2]')=?
          AND revision IS NULL AND generation>0`).get(row.documentId)) continue;
        this.insertSearchChunk(row, null);
      }
    });
  }

  searchKeywords(query: string, limit: number): KnowledgeKeywordHit[] {
    const tokens = knowledgeTokens(query.slice(0, 8000), true);
    if (!tokens.length) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Keyword limit must be 1..100');
    const rows = this.db.prepare(`SELECT c.id,c.document_id,c.title,c.content,c.source,bm25(chunk_fts,2.0,1.0) AS score
      FROM chunk_fts JOIN search_chunks c ON c.rowid=chunk_fts.rowid
      WHERE chunk_fts MATCH ? AND NOT EXISTS (SELECT 1 FROM suppressed_chunks s WHERE s.chunk_id=c.id)
      AND (c.scope IS NULL OR EXISTS (SELECT 1 FROM membership m JOIN documents d
        ON d.scope=m.scope AND d.revision=m.revision WHERE m.chunk_id=c.id))
      ORDER BY score ASC,c.id ASC LIMIT ?`).all(tokens.map((token) => `"${token}"`).join(' OR '), limit);
    return rows.map((row) => ({ id: String(row.id), documentId: String(row.document_id), title: String(row.title),
      content: String(row.content), source: row.source == null ? undefined : String(row.source), bm25: Number(row.score) }));
  }

  private indexBatch(batch: KnowledgeEvidenceBatch): void {
    const key = scopeKey({ provider: batch.provider, knowledgeBaseId: batch.knowledgeBaseId, documentId: batch.documentId });
    for (const chunk of batch.chunks) {
      const existing = this.db.prepare('SELECT scope, revision FROM membership WHERE chunk_id=?').get(chunk.evidence.chunkId);
      if (existing && (existing.scope !== key || existing.revision !== batch.processingRevisionId)) fail('CONFLICT', 'Chunk belongs to another batch');
      this.db.prepare('INSERT OR IGNORE INTO membership VALUES (?,?,?)').run(chunk.evidence.chunkId, key, batch.processingRevisionId);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  putBatch(input: KnowledgeEvidenceBatch): void {
    const parsed = KnowledgeEvidenceBatchSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_BATCH', 'Invalid evidence batch contract');
    const batch = parsed.data!;
    const scope = { provider: batch.provider, knowledgeBaseId: batch.knowledgeBaseId, documentId: batch.documentId };
    const key = scopeKey(scope);
    const parents = new Map<string, string | undefined>();
    for (const { evidence, content } of [...batch.chunks, ...(batch.parentChunks ?? [])]) {
      if (evidence.verification !== 'versioned') throw new KnowledgeEvidenceStoreError('INVALID_BATCH', 'Versioned evidence required');
      if (evidence.provider !== batch.provider || evidence.knowledgeBaseId !== batch.knowledgeBaseId
        || evidence.documentId !== batch.documentId || evidence.documentVersionId !== batch.documentVersionId
        || evidence.processingRevisionId !== batch.processingRevisionId
        || evidence.contentHash !== createHash('sha256').update(content).digest('hex')
        || parents.has(evidence.chunkId)) fail('INVALID_BATCH', 'Evidence identity or content mismatch');
      if (evidence.sourceLocation && evidence.sourceLocation.end - evidence.sourceLocation.start !== content.length) {
        fail('INVALID_BATCH', 'Evidence source range length mismatch');
      }
      parents.set(evidence.chunkId, evidence.parentChunkId);
    }
    for (const id of parents.keys()) {
      const visited = new Set<string>([id]);
      let parent = parents.get(id);
      while (parent !== undefined) {
        if (!parents.has(parent) || visited.has(parent)) fail('INVALID_BATCH', 'Invalid parent relationship');
        visited.add(parent);
        parent = parents.get(parent);
      }
    }
    const grouped = new Map<string, KnowledgeEvidenceBatch['chunks']>();
    for (const child of batch.chunks) {
      if (child.evidence.verification === 'versioned' && child.evidence.parentChunkId) {
        const key = child.evidence.parentChunkId, list = grouped.get(key) ?? [];
        list.push(child); grouped.set(key, list);
      }
    }
    for (const parent of batch.parentChunks ?? []) {
      const evidence = parent.evidence;
      if (evidence.verification !== 'versioned') throw new KnowledgeEvidenceStoreError('INVALID_BATCH', 'Versioned parent required');
      if (evidence.parentChunkId || !evidence.sourceLocation
        || parent.content.length > 3600) fail('INVALID_BATCH', 'Invalid parent context');
      const location = evidence.sourceLocation!;
      const children = (grouped.get(evidence.chunkId) ?? []).sort((a, b) =>
          (a.evidence.verification === 'versioned' ? a.evidence.sourceLocation?.start ?? -1 : -1)
          - (b.evidence.verification === 'versioned' ? b.evidence.sourceLocation?.start ?? -1 : -1));
      if (children.length < 2) fail('INVALID_BATCH', 'Parent requires multiple children');
      let cursor = location.start;
      for (const child of children) {
        const childLocation = child.evidence.verification === 'versioned' ? child.evidence.sourceLocation : undefined;
        if (!childLocation || childLocation.start < cursor || childLocation.end > location.end
          || parent.content.slice(childLocation.start - location.start, childLocation.end - location.start) !== child.content
          || parent.content.slice(cursor - location.start, childLocation.start - location.start).trim()) {
          fail('INVALID_BATCH', 'Child is not an exact, non-overlapping parent slice');
        }
        cursor = childLocation!.end;
      }
      if (parent.content.slice(cursor - location.start).trim()) fail('INVALID_BATCH', 'Parent contains untracked content');
    }
    const payload = canonical(batch);
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO documents(scope) VALUES (?)').run(key);
      const version = this.db.prepare('SELECT source_hash FROM versions WHERE scope=? AND version=?')
        .get(key, batch.documentVersionId);
      if (version && version.source_hash !== batch.sourceHash) fail('CONFLICT', 'Immutable source version conflict');
      this.db.prepare('INSERT OR IGNORE INTO versions VALUES (?,?,?)').run(key, batch.documentVersionId, batch.sourceHash);
      const existing = this.db.prepare('SELECT payload FROM batches WHERE scope=? AND revision=?').get(key, batch.processingRevisionId);
      if (existing && existing.payload !== payload) fail('CONFLICT', 'Immutable batch conflict');
      this.db.prepare('INSERT OR IGNORE INTO batches VALUES (?,?,?,?)')
        .run(key, batch.processingRevisionId, batch.documentVersionId, payload);
      this.indexBatch(batch);
    });
  }

  getVisibility(): KnowledgeRetrievalVisibility {
    const active = this.db.prepare(`SELECT m.chunk_id FROM membership m JOIN documents d ON d.scope=m.scope
      AND d.revision=m.revision WHERE NOT EXISTS (SELECT 1 FROM suppressed_chunks s WHERE s.chunk_id=m.chunk_id)`).all();
    return { activeChunkIds: active.map((row) => String(row.chunk_id)),
      inactiveChunkIds: this.db.prepare(`SELECT m.chunk_id FROM membership m JOIN documents d ON d.scope=m.scope
        WHERE d.revision IS NULL OR d.revision<>m.revision`).all().map((row) => String(row.chunk_id)),
      suppressedChunkIds: this.db.prepare('SELECT chunk_id FROM suppressed_chunks').all().map((row) => String(row.chunk_id)) };
  }

  getEvidence(chunkId: string): KnowledgeEvidence | undefined {
    const row = this.db.prepare(`SELECT b.payload FROM membership m JOIN batches b
      ON b.scope=m.scope AND b.revision=m.revision WHERE m.chunk_id=?`).get(chunkId);
    if (!row) return undefined;
    return KnowledgeEvidenceBatchSchema.parse(JSON.parse(String(row.payload))).chunks.find((chunk) => chunk.evidence.chunkId === chunkId)?.evidence;
  }

  /** Request-local batch decoding only; callers must still check current visibility. */
  getEvidenceMany(chunkIds: string[]): Map<string, KnowledgeEvidence> {
    const ids = [...new Set(chunkIds)];
    const result = new Map<string, KnowledgeEvidence>();
    for (let offset = 0; offset < ids.length; offset += 256) {
      const group = ids.slice(offset, offset + 256), wanted = new Set(group);
      const rows = this.db.prepare(`SELECT DISTINCT b.scope, b.revision, b.payload FROM membership m JOIN batches b
        ON b.scope=m.scope AND b.revision=m.revision WHERE m.chunk_id IN (${group.map(() => '?').join(',')})`).all(...group);
      for (const row of rows) {
        const batch = KnowledgeEvidenceBatchSchema.parse(JSON.parse(String(row.payload)));
        for (const chunk of batch.chunks) {
          if (wanted.has(chunk.evidence.chunkId)) result.set(chunk.evidence.chunkId, chunk.evidence);
        }
      }
    }
    return result;
  }

  /** Parents are context, never independent recall candidates. Any deleted sibling disables expansion. */
  getParentContext(chunkId: string): KnowledgeParentContext | undefined {
    const row = this.db.prepare(`SELECT b.payload FROM membership m JOIN documents d ON d.scope=m.scope AND d.revision=m.revision
      JOIN batches b ON b.scope=m.scope AND b.revision=m.revision WHERE m.chunk_id=?`).get(chunkId);
    if (!row) return undefined;
    const batch = KnowledgeEvidenceBatchSchema.parse(JSON.parse(String(row.payload)));
    const child = batch.chunks.find((chunk) => chunk.evidence.chunkId === chunkId);
    if (child?.evidence.verification !== 'versioned' || !child.evidence.parentChunkId) return undefined;
    const parent = batch.parentChunks?.find((chunk) => chunk.evidence.chunkId === child.evidence.parentChunkId);
    if (!parent || parent.evidence.verification !== 'versioned') return undefined;
    const siblings = batch.chunks.filter((chunk) => chunk.evidence.verification === 'versioned'
      && chunk.evidence.parentChunkId === parent.evidence.chunkId);
    if ([parent, ...siblings].some((chunk) => this.db.prepare('SELECT 1 FROM suppressed_chunks WHERE chunk_id=?').get(chunk.evidence.chunkId))) return undefined;
    if (createHash('sha256').update(parent.content).digest('hex') !== parent.evidence.contentHash) fail('INVALID_BATCH', 'Parent context content mismatch');
    return { ...parent, matchedChunkIds: [chunkId] };
  }

  suppressChunks(chunkIds: string[], document?: KnowledgeDocumentScope): void {
    this.transaction(() => {
      for (const id of chunkIds) {
        this.db.prepare('INSERT OR IGNORE INTO suppressed_chunks VALUES (?)').run(id);
        this.db.prepare('DELETE FROM search_chunks WHERE id=?').run(id);
      }
      if (document) {
        const key = scopeKey(document);
        this.db.prepare(`INSERT OR IGNORE INTO suppressed_chunks SELECT id FROM search_chunks
          WHERE scope IS NULL AND document_id=?`).run(document.documentId);
        this.db.prepare('DELETE FROM search_chunks WHERE scope IS NULL AND document_id=?').run(document.documentId);
        this.db.prepare('INSERT OR IGNORE INTO documents(scope) VALUES (?)').run(key);
        this.db.prepare('UPDATE documents SET revision=NULL, generation=generation+1 WHERE scope=?').run(key);
        this.db.prepare('DELETE FROM search_chunks WHERE scope=?').run(key);
      }
      invalidateWikiSearch(this.db);
    });
  }

  getBatch(scope: KnowledgeDocumentScope, revision: string): KnowledgeEvidenceBatch | undefined {
    const row = this.db.prepare('SELECT payload FROM batches WHERE scope=? AND revision=?').get(scopeKey(scope), revision);
    return row ? KnowledgeEvidenceBatchSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  getHead(scope: KnowledgeDocumentScope): KnowledgeEvidenceHead {
    const row = this.db.prepare('SELECT revision, generation FROM documents WHERE scope=?').get(scopeKey(scope));
    return { processingRevisionId: row?.revision == null ? null : String(row.revision), generation: Number(row?.generation ?? 0) };
  }

  /** Caller must complete index construction before publishing. CAS prevents stale completion. */
  activate(scope: KnowledgeDocumentScope, revision: string, expectedGeneration: number): KnowledgeEvidenceHead {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) fail('CONFLICT', 'Invalid generation');
    const key = scopeKey(scope);
    return this.transaction(() => {
      if (!this.getBatch(scope, revision)) fail('NOT_FOUND', 'Batch not found in document scope');
      const result = this.db.prepare('UPDATE documents SET revision=?, generation=generation+1 WHERE scope=? AND generation=?')
        .run(revision, key, expectedGeneration);
      if (result.changes !== 1) fail('CONFLICT', 'Document generation changed');
      try { this.indexActiveBatch(this.getBatch(scope, revision)!); invalidateWikiSearch(this.db); }
      catch (cause) {
        const error = new KnowledgeEvidenceStoreError('FULLTEXT_INDEX_FAILED', '全文索引写入失败，本次内容尚未发布，请重试。');
        error.cause = cause;
        throw error;
      }
      return this.getHead(scope);
    });
  }

  /** Explicit opt-in migration; ordinary evidence access keeps new databases at v4. */
  openExistingWiki(scope: WikiScope, authorizeSource: WikiSourceAuthorizer): KnowledgeWikiStore | undefined {
    WikiScopeSchema.parse(scope);
    if (typeof authorizeSource !== 'function') throw new TypeError('Wiki source authorizer required');
    return Number(this.db.prepare('PRAGMA user_version').get()!.user_version) >= 5
      ? new KnowledgeWikiStore(this.db, scope, authorizeSource) : undefined;
  }

  openWiki(scope: WikiScope, authorizeSource: WikiSourceAuthorizer): KnowledgeWikiStore {
    WikiScopeSchema.parse(scope);
    if (typeof authorizeSource !== 'function') throw new TypeError('Wiki source authorizer required');
    this.transaction(() => migrateWiki(this.db));
    return new KnowledgeWikiStore(this.db, scope, authorizeSource);
  }

  close(): void { this.db.close(); }

  /** Explicit generation opt-in; VACUUM INTO includes WAL contents, unlike copying the main file. */
  initializeWikiGeneration(backupPath: string): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version === 6) return;
    if (![4, 5].includes(version)) fail('UNSUPPORTED_SCHEMA', 'Unsupported Wiki migration');
    this.db.prepare('VACUUM INTO ?').run(backupPath);
    const { DatabaseSync: SQLite } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const backup = new SQLite(backupPath, { readOnly: true });
    try {
      if (backup.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok'
        || backup.prepare('PRAGMA user_version').get()!.user_version !== version
        || backup.prepare('PRAGMA application_id').get()!.application_id !== APPLICATION_ID
        || backup.prepare('SELECT count(*) AS n FROM batches').get()!.n !== this.db.prepare('SELECT count(*) AS n FROM batches').get()!.n) {
        fail('INVALID_BATCH', 'Backup validation failed');
      }
    } finally { backup.close(); }
    this.transaction(() => {
      migrateWiki(this.db);
      this.db.exec(`CREATE TABLE wiki_generation_jobs (
        job_id TEXT PRIMARY KEY, scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(scope,idempotency_key)); PRAGMA user_version=6;`);
    });
  }

  wikiJobs(scope: WikiScope): WikiGenerationJob[] {
    if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) < 6) return [];
    const key = JSON.stringify(WikiScopeSchema.parse(scope));
    return this.db.prepare(`SELECT json_remove(payload, '$._checkpoint') AS payload FROM wiki_generation_jobs WHERE scope=?
      ORDER BY CASE WHEN json_extract(payload, '$.state') IN ('queued','running') THEN 0 ELSE 1 END,
      json_extract(payload, '$.updatedAt') DESC, rowid DESC LIMIT 100`)
      .all(key).map((row) => WikiGenerationJobSchema.parse(JSON.parse(String(row.payload))));
  }

  wikiJob(scope: WikiScope, jobId: string, byKey = false): WikiGenerationJob | undefined {
    if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) < 6) return undefined;
    const row = this.db.prepare(`SELECT json_remove(payload, '$._checkpoint') AS payload FROM wiki_generation_jobs WHERE scope=? AND ${byKey ? 'idempotency_key' : 'job_id'}=?`)
      .get(JSON.stringify(WikiScopeSchema.parse(scope)), jobId);
    return row ? WikiGenerationJobSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  wikiCheckpoint(scope: WikiScope, jobId: string): WikiGenerationCheckpoint | undefined {
    if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) < 6) return;
    const row = this.db.prepare("SELECT json_extract(payload, '$._checkpoint') AS checkpoint FROM wiki_generation_jobs WHERE scope=? AND job_id=?")
      .get(JSON.stringify(WikiScopeSchema.parse(scope)), jobId);
    return row?.checkpoint ? WikiGenerationCheckpointSchema.parse(JSON.parse(String(row.checkpoint))) : undefined;
  }

  saveWikiJob(input: WikiGenerationJob, checkpoint?: WikiGenerationCheckpoint): void {
    const job = WikiGenerationJobSchema.parse(input);
    const existing = this.wikiJob(job.scope, job.jobId);
    if (existing && (existing.requestHash !== job.requestHash || existing.idempotencyKey !== job.idempotencyKey)) {
      fail('CONFLICT', 'Immutable job identity changed');
    }
    const saved = checkpoint ?? this.wikiCheckpoint(job.scope, job.jobId);
    const payload = saved ? { ...job, _checkpoint: WikiGenerationCheckpointSchema.parse(saved) } : job;
    this.db.prepare(`INSERT INTO wiki_generation_jobs(job_id,scope,idempotency_key,payload) VALUES(?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload WHERE wiki_generation_jobs.scope=excluded.scope`)
      .run(job.jobId, JSON.stringify(job.scope), job.idempotencyKey, JSON.stringify(payload));
  }
}
