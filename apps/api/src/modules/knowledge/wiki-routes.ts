import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  WikiHttpParamsSchema, WikiListQuerySchema, WikiReadQuerySchema, WikiHttpSearchSchema,
  WikiRelatedQuerySchema, WikiEditBodySchema, WikiPublishBodySchema, WikiMutationSchema,
  WikiMergeBodySchema, WikiMergeTargetSchema, WikiEmptyBodySchema,
} from '@workmate/contracts';
import { KnowledgeEvidenceStore, KnowledgeSourceStore, ImmutableFileStore, KnowledgeWikiError } from '@workmate/storage';
import { KnowledgeAccessError, KnowledgeCatalog } from './catalog.js';
import { sendKnowledgeAccessError } from './ownership-routes.js';

/** Personal Wiki only. Saved configuration is a locator, never an ownership grant. */
export function registerWikiRoutes(app: FastifyInstance, dependencies: { dataRoot: () => string }) {
  const prefix = '/knowledge/:knowledgeBaseId/wiki';
  const actions = [
    ['GET', '/pages', 'list'], ['GET', '/pages/:pageId', 'read'], ['GET', '/search', 'search'],
    ['GET', '/pages/:pageId/related', 'related'], ['PUT', '/pages/:pageId/draft', 'edit'],
    ['POST', '/pages/:pageId/publish', 'publish'], ['POST', '/pages/:pageId/archive', 'archive'],
    ['GET', '/pages/:pageId/sources', 'sources'],
    ['GET', '/pages/:pageId/merge-candidates', 'merge-candidates'],
    ['GET', '/pages/:pageId/merge-preview', 'merge-preview'], ['POST', '/pages/:pageId/merge', 'merge'],
  ] as const;
  for (const [method, suffix, action] of actions) app.route({
    method, url: prefix + suffix, bodyLimit: 1024 * 1024,
    handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!request.auth) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
      const params = WikiHttpParamsSchema.safeParse(request.params);
      const schema = action === 'merge-candidates' ? WikiEmptyBodySchema : action === 'merge-preview' ? WikiMergeTargetSchema
        : action === 'merge' ? WikiMergeBodySchema : action === 'list' ? WikiListQuerySchema : action === 'read' || action === 'sources' ? WikiReadQuerySchema
        : action === 'search' ? WikiHttpSearchSchema : action === 'related' ? WikiRelatedQuerySchema
        : action === 'edit' ? WikiEditBodySchema : action === 'publish' ? WikiPublishBodySchema : WikiMutationSchema;
      const parsed = schema.safeParse(method === 'GET' ? request.query : request.body);
      if (!params.success || !parsed.success || (method !== 'GET' && Object.keys(request.query as object).length)) {
        return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid Wiki request.' });
      }
      const { knowledgeBaseId, pageId } = params.data;
      const missing = () => reply.code(404).send({ code: 'NOT_FOUND', message: 'Wiki resource not found.' });
      const empty = () => action === 'list' ? { items: [], nextAfterPageId: null }
        : action === 'search' ? { items: [] } : missing();
      let evidence: KnowledgeEvidenceStore | undefined;
      let sources: KnowledgeSourceStore | undefined;
      try {
        const kb = new KnowledgeCatalog(dependencies.dataRoot()).resolve(request.auth, knowledgeBaseId);
        if (kb.provider !== 'lancedb') return missing();
        // IDs from older global configuration must not become path traversal segments.
        if (!/^[a-zA-Z0-9_-]+$/.test(knowledgeBaseId)) return missing();
        const directory = typeof kb.dataDir === 'string' && kb.dataDir.trim() ? path.resolve(kb.dataDir.trim())
          : path.join(process.env.WORKMATE_KNOWLEDGE_DIR?.trim() || path.resolve(process.cwd(), '.workmate-knowledge'), knowledgeBaseId);
        const dbPath = path.join(directory, 'knowledge-evidence.sqlite');
        const sourceRoot = path.join(dependencies.dataRoot(), 'knowledge-sources');
        const sourcePath = path.join(sourceRoot, 'sources.sqlite');
        if (!fs.existsSync(dbPath) || !fs.existsSync(sourcePath) || !fs.existsSync(path.join(sourceRoot, 'objects'))) return empty();
        if ([dbPath, sourcePath, directory, sourceRoot, path.join(sourceRoot, 'objects')].some((p) => fs.lstatSync(p).isSymbolicLink())) return missing();
        evidence = new KnowledgeEvidenceStore(dbPath, { existingOnly: true, readOnly: method === 'GET' });
        sources = new KnowledgeSourceStore(sourcePath, new ImmutableFileStore(path.join(sourceRoot, 'objects')), { readOnly: true });
        const owner = { orgId: request.auth.orgId, userId: request.auth.userId };
        const wiki = evidence.openExistingWiki({ ...owner, knowledgeBaseId }, (ref) => {
          if (ref.evidence.verification !== 'versioned') return false;
          const snapshot = sources!.get(owner, ref.evidence.documentVersionId);
          return snapshot?.provider === 'lancedb' && snapshot.knowledgeBaseId === knowledgeBaseId
            && snapshot.documentId === ref.evidence.documentId;
        });
        if (!wiki) return empty();
        if (action === 'merge-candidates') return { items: wiki.mergeCandidates(pageId!) };
        if (action === 'merge-preview') return wiki.previewMerge(pageId!, WikiMergeTargetSchema.parse(parsed.data).targetPageId);
        if (action === 'merge') {
          const body = WikiMergeBodySchema.parse(parsed.data);
          // Read the exact previewed revisions to verify original bytes without a write lock.
          const views = [wiki.read(pageId!, { revisionId: body.sourceRevisionId }), wiki.read(body.targetPageId, { revisionId: body.targetRevisionId })];
          if (views.some((view) => !view)) return missing();
          const versions = new Set(views.flatMap((view) => view!.revision.content.evidenceRefs.map((ref) => {
            if (ref.evidence.verification !== 'versioned') throw new Error('Invalid evidence');
            return ref.evidence.documentVersionId;
          })));
          for (const version of versions) if (!sources.read(owner, version)) return missing();
          return wiki.mergeDraft(pageId!, body);
        }
        if (action === 'list') {
          const query = WikiListQuerySchema.parse(parsed.data);
          const views = wiki.list({ draft: query.view === 'drafts', limit: query.limit, afterPageId: query.afterPageId });
          return { items: views.map(({ page, revision, freshness }) => ({ page, title: revision.content.title,
            summary: revision.content.summary, freshness })),
          nextAfterPageId: views.length === query.limit ? views.at(-1)!.page.pageId : null };
        }
        if (action === 'search') {
          const query = WikiHttpSearchSchema.parse(parsed.data);
          return { items: wiki.search(query.query, query.limit) };
        }
        if (action === 'read') {
          const query = WikiReadQuerySchema.parse(parsed.data);
          return wiki.read(pageId!, { draft: query.view === 'drafts', revisionId: query.revisionId }) ?? missing();
        }
        if (action === 'sources') {
          const query = WikiReadQuerySchema.parse(parsed.data);
          const view = wiki.read(pageId!, { draft: query.view === 'drafts', revisionId: query.revisionId });
          if (!view) return missing();
          return { items: view.revision.content.evidenceRefs.map((ref) => {
            const e = ref.evidence;
            if (e.verification !== 'versioned') throw new Error('Invalid evidence');
            const batch = evidence!.getBatch({ provider: e.provider, knowledgeBaseId: e.knowledgeBaseId, documentId: e.documentId }, e.processingRevisionId);
            const chunk = batch?.chunks.find((c) => c.evidence.chunkId === e.chunkId);
            const original = sources!.get(owner, e.documentVersionId);
            if (!chunk || !original) throw new Error('Missing source');
            return { refId: ref.refId, sectionId: ref.sectionId, evidence: e, text: chunk.content, fileName: original.fileName };
          }) };
        }
        if (action === 'related') {
          if (!wiki.read(pageId!)) return missing();
          const query = WikiRelatedQuerySchema.parse(parsed.data);
          return { items: wiki.related(pageId!, query.direction, query.limit) };
        }
        if (!wiki.read(pageId!, { draft: true, includeArchived: action === 'archive' })
          && !wiki.read(pageId!, { includeArchived: action === 'archive' })) return missing();
        // Verify immutable bytes outside the SQLite write transaction; the store rechecks live metadata inside it.
        if (action === 'edit' || action === 'publish') {
          const content = action === 'edit' ? WikiEditBodySchema.parse(parsed.data).content
            : wiki.read(pageId!, { revisionId: WikiPublishBodySchema.parse(parsed.data).draftRevisionId })?.revision.content;
          if (!content) return missing();
          const versions = new Set(content.evidenceRefs.flatMap((ref) => ref.evidence.verification === 'versioned' ? [ref.evidence.documentVersionId] : []));
          for (const version of versions) if (!sources.read(owner, version)) return missing();
        }
        if (action === 'edit') return wiki.saveDraft({ ...WikiEditBodySchema.parse(parsed.data), pageId: pageId!, authorType: 'human' });
        if (action === 'publish') return wiki.publish({ ...WikiPublishBodySchema.parse(parsed.data), pageId: pageId! });
        return wiki.archive(pageId!, WikiMutationSchema.parse(parsed.data));
      } catch (error) {
        if (error instanceof KnowledgeAccessError) return sendKnowledgeAccessError(reply, error);
        if (error instanceof KnowledgeWikiError) {
          const code = error.code;
          if (code === 'NOT_FOUND') return missing();
          const status = ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'SOURCE_CHANGED'].includes(code) ? 409
            : ['INVALID_INPUT', 'INVALID_EVIDENCE', 'MERGE_LIMIT_EXCEEDED'].includes(code) ? 400 : 503;
          return reply.code(status).send({ code, message: 'Wiki operation could not be completed.' });
        }
        return reply.code(503).send({ code: 'WIKI_UNAVAILABLE', message: 'Wiki is temporarily unavailable.' });
      } finally { sources?.close(); evidence?.close(); }
    },
  });
}
