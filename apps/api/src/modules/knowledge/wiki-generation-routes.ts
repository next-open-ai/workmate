import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WikiGenerationRequestSchema, WikiGenerationInputSchema, WikiJobParamsSchema, WikiEmptyBodySchema, WikiGenerationFailure,
  type WikiScope, type WikiGenerationInput, type WikiEvidenceRef } from '@workmate/contracts';
import { KnowledgeEvidenceStore, KnowledgeSourceStore, ImmutableFileStore, KnowledgeWikiError } from '@workmate/storage';
import { generateWikiPages, planWikiBatches, mergeWikiBatches } from '@workmate/agent-core';
import { WikiGenerationService, WikiGenerationError, type ExecutionDispatcher, type WikiJobRepository } from '@workmate/orchestrator';
import { KnowledgeCatalog, KnowledgeAccessError } from './catalog.js';
import { sendKnowledgeAccessError } from './ownership-routes.js';

type Principal = Parameters<KnowledgeCatalog['resolve']>[0];
class GenerationInputError extends Error {
  constructor(public readonly code: string, public readonly status = 422) { super(code); }
}

/** Every operation reopens the current catalog/database; no DB locks survive a model call. */
function withStore<T>(root: string, principal: Principal, scope: WikiScope,
  operation: (store: KnowledgeEvidenceStore, sources: KnowledgeSourceStore, dbPath: string, authorize: (ref: WikiEvidenceRef) => boolean) => T): T {
  const kb = new KnowledgeCatalog(root).resolve(principal, scope.knowledgeBaseId);
  if (kb.provider !== 'lancedb' || !/^[a-zA-Z0-9_-]+$/.test(scope.knowledgeBaseId)) throw new GenerationInputError('NOT_FOUND', 404);
  const directory = kb.dataDir?.trim() ? path.resolve(kb.dataDir.trim())
    : path.join(process.env.WORKMATE_KNOWLEDGE_DIR?.trim() || path.resolve(process.cwd(), '.workmate-knowledge'), scope.knowledgeBaseId);
  const dbPath = path.join(directory, 'knowledge-evidence.sqlite');
  const sourceRoot = path.join(root, 'knowledge-sources');
  const sourcePath = path.join(sourceRoot, 'sources.sqlite');
  const objects = path.join(sourceRoot, 'objects');
  if ([directory, dbPath, sourceRoot, sourcePath, objects].some((p) => !fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink())) {
    throw new GenerationInputError('VERSIONED_SOURCES_REQUIRED');
  }
  const store = new KnowledgeEvidenceStore(dbPath, { existingOnly: true, readOnly: false });
  let sources: KnowledgeSourceStore | undefined;
  try {
    sources = new KnowledgeSourceStore(sourcePath, new ImmutableFileStore(objects), { readOnly: true });
    const owner = { orgId: scope.orgId, userId: scope.userId };
    const authorize = (ref: WikiEvidenceRef) => {
      if (ref.evidence.verification !== 'versioned') return false;
      const source = sources!.get(owner, ref.evidence.documentVersionId);
      return source?.knowledgeBaseId === scope.knowledgeBaseId && source.provider === 'lancedb'
        && source.documentId === ref.evidence.documentId;
    };
    return operation(store, sources, dbPath, authorize);
  } finally { sources?.close(); store.close(); }
}

function snapshot(store: KnowledgeEvidenceStore, sources: KnowledgeSourceStore, scope: WikiScope, ids: string[]): WikiGenerationInput {
  const active = new Set(store.getVisibility().activeChunkIds);
  const owner = { orgId: scope.orgId, userId: scope.userId };
  const batches = ids.map((documentId) => {
    const document = { provider: 'lancedb', knowledgeBaseId: scope.knowledgeBaseId, documentId };
    const head = store.getHead(document);
    const batch = head.processingRevisionId ? store.getBatch(document, head.processingRevisionId) : undefined;
    if (!batch || batch.chunks.some((chunk) => !active.has(chunk.evidence.chunkId))) throw new GenerationInputError('VERSIONED_SOURCES_REQUIRED');
    const archived = sources.read(owner, batch.documentVersionId);
    if (!archived || archived.snapshot.documentId !== documentId || archived.snapshot.provider !== 'lancedb'
      || archived.snapshot.knowledgeBaseId !== scope.knowledgeBaseId || archived.snapshot.file.sha256 !== batch.sourceHash) {
      throw new GenerationInputError('INVALID_EVIDENCE');
    }
    // Parents duplicate child text; headings + complete ordered child blocks are the bounded input.
    return { ...batch, parentChunks: undefined };
  });
  const parsed = WikiGenerationInputSchema.safeParse({ batches });
  if (!parsed.success) throw new GenerationInputError('LIMIT_EXCEEDED', 413);
  return parsed.data;
}

export function registerWikiGenerationRoutes(app: FastifyInstance, dependencies: {
  dataRoot: () => string; dispatcher: () => ExecutionDispatcher; generate?: typeof generateWikiPages;
}) {
  let service: WikiGenerationService | undefined;
  const getService = () => service ??= new WikiGenerationService(dependencies.dispatcher());
  app.addHook('onClose', async () => { await service?.close(); });
  for (const action of ['start', 'list', 'read', 'cancel'] as const) app.route({
    method: action === 'read' || action === 'list' ? 'GET' : 'POST',
    url: '/knowledge/:knowledgeBaseId/wiki/generation-jobs' + (action === 'start' || action === 'list' ? '' : '/:jobId') + (action === 'cancel' ? '/cancel' : ''),
    bodyLimit: 32768,
    handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!request.auth) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
      const params = WikiJobParamsSchema.safeParse(request.params);
      const parsed = action === 'start' ? WikiGenerationRequestSchema.safeParse(request.body)
        : WikiEmptyBodySchema.safeParse(action === 'read' || action === 'list' ? request.query : request.body);
      if (!params.success || !parsed.success || Object.keys(request.query as object).length) {
        return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid generation request.' });
      }
      const principal = request.auth;
      const scope: WikiScope = { orgId: principal.orgId, userId: principal.userId, knowledgeBaseId: params.data.knowledgeBaseId };
      const root = dependencies.dataRoot();
      const access = <T>(fn: Parameters<typeof withStore<T>>[3]) => withStore(root, principal, scope, fn);
      const repository: WikiJobRepository = {
        get: (id, byKey) => access((store) => store.wikiJob(scope, id, byKey)),
        list: () => access((store) => store.wikiJobs(scope)),
        save: (job, checkpoint) => access((store) => store.saveWikiJob(job, checkpoint)),
        checkpoint: (id) => access((store) => store.wikiCheckpoint(scope, id)),
      };
      try {
        if (action === 'list') return { items: repository.list().slice(0, 5).map((job) => getService().read(repository, job.jobId)) };
        if (action !== 'start') {
          const job = action === 'read' ? getService().read(repository, params.data.jobId!) : getService().cancel(repository, params.data.jobId!);
          return job ?? reply.code(404).send({ code: 'NOT_FOUND', message: 'Generation job not found.' });
        }
        const body = WikiGenerationRequestSchema.parse(parsed.data);
        if (body.resumeJobId) {
          const previous = getService().read(repository, body.resumeJobId);
          if (!previous) throw new GenerationInputError('NOT_FOUND', 404);
          if (previous.state === 'completed' || repository.checkpoint!(previous.jobId)?.resumeKeys.includes(body.idempotencyKey)) {
            return reply.code(202).send(previous);
          }
        }
        const requestHash = createHash('sha256').update(JSON.stringify({ documentIds: [...body.documentIds].sort(),
          model: { provider: body.model.provider, baseUrl: body.model.baseUrl, chatModel: body.model.chatModel } })).digest('hex');
        // Replays never invoke the model, even when source heads have since changed.
        const prior = !body.resumeJobId && repository.get(body.idempotencyKey, true);
        if (prior) {
          if (prior.requestHash !== requestHash) throw new WikiGenerationError('IDEMPOTENCY_CONFLICT');
          return reply.code(202).send(getService().read(repository, prior.jobId));
        }
        const input = access((store, sources, dbPath) => {
          const value = snapshot(store, sources, scope, body.documentIds);
          try { planWikiBatches(value); } catch { throw new GenerationInputError('LIMIT_EXCEEDED', 413); }
          store.initializeWikiGeneration(`${dbPath}.pre-wiki-v6-${randomUUID()}.bak`);
          return value;
        });
        const batches = planWikiBatches(input);
        const verifySnapshot = (store: KnowledgeEvidenceStore, sources: KnowledgeSourceStore) => {
          try {
            if (JSON.stringify(snapshot(store, sources, scope, body.documentIds)) !== JSON.stringify(input)) {
              throw new WikiGenerationFailure('SOURCE_CHANGED');
            }
          } catch (error) {
            if (error instanceof GenerationInputError) throw new WikiGenerationFailure('SOURCE_CHANGED');
            throw error;
          }
        };
        const job = await getService().start({ scope, idempotencyKey: body.idempotencyKey, requestHash,
          resumeJobId: body.resumeJobId,
          checkpointHash: createHash('sha256').update(JSON.stringify({ recipe: 'wiki-batches-v1', input })).digest('hex'),
          sources: input.batches.map(({ documentId, documentVersionId, processingRevisionId }) => ({ documentId, documentVersionId, processingRevisionId })),
          totalChunks: input.batches.reduce((n, batch) => n + batch.chunks.length, 0), repository,
          batchChunks: batches.map((batch) => batch.batches.reduce((n, b) => n + b.chunks.length, 0)),
          merge: mergeWikiBatches,
          generate: async (signal, batchIndex) => {
            access(verifySnapshot);
            return (dependencies.generate ?? generateWikiPages)(batches[batchIndex], body.model, signal);
          },
          savePage: (page, jobId, linkPhase) => access((store, sources, _dbPath, authorize) => {
            verifySnapshot(store, sources);
            const wiki = store.openExistingWiki(scope, authorize)!;
            // Link pass never overwrites a concurrently edited/published first draft.
            wiki.saveDraft({ ...page, authorType: 'model', baseGeneration: linkPhase ? 1 : 0,
              idempotencyKey: `${jobId}:${page.pageId}:${linkPhase ? 'links' : 'draft'}` });
          }),
        });
        return reply.code(202).send(job);
      } catch (error) {
        if (error instanceof KnowledgeAccessError) return sendKnowledgeAccessError(reply, error);
        if (error instanceof GenerationInputError) {
          if (action === 'list' && error.code === 'VERSIONED_SOURCES_REQUIRED') return { items: [] };
          return reply.code(error.status).send({ code: error.code, message: 'Please check the selected source documents or use a smaller batch.' });
        }
        if (error instanceof WikiGenerationError) return reply.code(error.code === 'CAPACITY_EXCEEDED' ? 429 : 409).send({ code: error.code, message: 'A generation is already running or this request key was reused.' });
        if (error instanceof KnowledgeWikiError) return reply.code(409).send({ code: error.code, message: 'Wiki source or revision changed.' });
        return reply.code(503).send({ code: 'WIKI_UNAVAILABLE', message: 'Wiki generation is temporarily unavailable.' });
      }
    },
  });
}
