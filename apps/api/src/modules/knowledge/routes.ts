import type { FastifyPluginAsync } from 'fastify';
import {
  BailianCreateKnowledgeRequestSchema,
  BailianDeleteKnowledgeRequestSchema,
  KnowledgeChunksRequestSchema,
  KnowledgeDeleteChunkRequestSchema,
  KnowledgeDeleteDocumentRequestSchema,
  KnowledgeIngestRequestSchema,
  KnowledgeJobStatusRequestSchema,
  KnowledgeManageRequestSchema,
  KnowledgeSearchRequestSchema,
} from '@workmate/contracts';
import {
  createBailianKnowledgeBase,
  deleteBailianKnowledgeBase,
  deleteKnowledgeChunk,
  deleteKnowledgeDocument,
  deleteKnowledgeBaseRemote,
  getKnowledgeJobStatus,
  ingestKnowledge,
  listBailianKnowledgeBases,
  listBailianPipelines,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  searchKnowledgeBase,
  updateBailianKnowledgeBase,
  updateKnowledgeBaseMeta,
} from '@workmate/agent-core';

export const knowledgeRoutes: FastifyPluginAsync = async (app) => {
  app.post('/knowledge/ingest', async (request, reply) => {
    const parsed = KnowledgeIngestRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid ingest request.', issues: parsed.error.issues });
    try {
      return await ingestKnowledge({
        kb: parsed.data.knowledgeBase,
        title: parsed.data.title,
        content: parsed.data.content,
        fileBase64: parsed.data.fileBase64,
        fileName: parsed.data.fileName,
        source: parsed.data.source,
        model: parsed.data.model,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Ingest failed.' });
    }
  });

  app.post('/knowledge/search', async (request, reply) => {
    const parsed = KnowledgeSearchRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid search request.', issues: parsed.error.issues });
    try {
      const results = await searchKnowledgeBase(
        parsed.data.knowledgeBase,
        parsed.data.query,
        parsed.data.topK,
        parsed.data.model,
      );
      return { ok: true, results };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Search failed.' });
    }
  });

  app.post('/knowledge/bailian/pipelines', async (request, reply) => {
    const body = (request.body || {}) as { apiKey?: string; baseUrl?: string; workspaceId?: string };
    if (!body.apiKey?.trim()) return reply.code(400).send({ message: 'apiKey is required.' });
    try {
      const pipelines = await listBailianPipelines({
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        workspaceId: body.workspaceId,
      });
      return { ok: true, pipelines };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'List Bailian pipelines failed.' });
    }
  });

  app.post('/knowledge/bailian/create', async (request, reply) => {
    const parsed = BailianCreateKnowledgeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid Bailian create request.', issues: parsed.error.issues });
    try {
      const created = await createBailianKnowledgeBase(parsed.data);
      return { ok: true, ...created };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Create Bailian knowledge base failed.' });
    }
  });

  app.post('/knowledge/bailian/update', async (request, reply) => {
    const body = (request.body || {}) as {
      accessKeyId?: string;
      accessKeySecret?: string;
      workspaceId?: string;
      indexId?: string;
      name?: string;
      description?: string;
    };
    if (!body.accessKeyId?.trim() || !body.accessKeySecret?.trim() || !body.workspaceId?.trim() || !body.indexId?.trim()) {
      return reply.code(400).send({ message: 'accessKeyId, accessKeySecret, workspaceId and indexId are required.' });
    }
    try {
      await updateBailianKnowledgeBase({
        accessKeyId: body.accessKeyId,
        accessKeySecret: body.accessKeySecret,
        workspaceId: body.workspaceId,
        indexId: body.indexId,
        name: body.name,
        description: body.description,
      });
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Update Bailian knowledge base failed.' });
    }
  });

  app.post('/knowledge/bailian/delete', async (request, reply) => {
    const parsed = BailianDeleteKnowledgeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid Bailian delete request.', issues: parsed.error.issues });
    try {
      await deleteBailianKnowledgeBase(parsed.data);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Delete Bailian knowledge base failed.' });
    }
  });

  app.post('/knowledge/bailian/list', async (request, reply) => {
    const body = (request.body || {}) as {
      accessKeyId?: string;
      accessKeySecret?: string;
      workspaceId?: string;
      pageNumber?: number;
      pageSize?: number;
      indexName?: string;
    };
    if (!body.accessKeyId?.trim() || !body.accessKeySecret?.trim() || !body.workspaceId?.trim()) {
      return reply.code(400).send({ message: 'accessKeyId, accessKeySecret and workspaceId are required.' });
    }
    try {
      const indices = await listBailianKnowledgeBases({
        accessKeyId: body.accessKeyId,
        accessKeySecret: body.accessKeySecret,
        workspaceId: body.workspaceId,
        pageNumber: body.pageNumber,
        pageSize: body.pageSize,
        indexName: body.indexName,
      });
      return { ok: true, indices };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'List Bailian knowledge bases failed.' });
    }
  });

  app.post('/knowledge/documents', async (request, reply) => {
    const parsed = KnowledgeManageRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid documents request.', issues: parsed.error.issues });
    try {
      return await listKnowledgeDocuments(parsed.data.knowledgeBase);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'List documents failed.' });
    }
  });

  app.post('/knowledge/chunks', async (request, reply) => {
    const parsed = KnowledgeChunksRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid chunks request.', issues: parsed.error.issues });
    try {
      return await listKnowledgeChunks({
        kb: parsed.data.knowledgeBase,
        documentId: parsed.data.documentId,
        query: parsed.data.query,
        offset: parsed.data.offset,
        limit: parsed.data.limit,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'List chunks failed.' });
    }
  });

  app.post('/knowledge/documents/delete', async (request, reply) => {
    const parsed = KnowledgeDeleteDocumentRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid delete document request.', issues: parsed.error.issues });
    try {
      return await deleteKnowledgeDocument(parsed.data.knowledgeBase, parsed.data.documentId);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Delete document failed.' });
    }
  });

  app.post('/knowledge/chunks/delete', async (request, reply) => {
    const parsed = KnowledgeDeleteChunkRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid delete chunk request.', issues: parsed.error.issues });
    try {
      return await deleteKnowledgeChunk(parsed.data.knowledgeBase, parsed.data.chunkId);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Delete chunk failed.' });
    }
  });

  app.post('/knowledge/job-status', async (request, reply) => {
    const parsed = KnowledgeJobStatusRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid job status request.', issues: parsed.error.issues });
    try {
      const status = await getKnowledgeJobStatus(parsed.data.knowledgeBase, parsed.data.jobId);
      return { ok: true, ...status };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Job status failed.' });
    }
  });

  app.post('/knowledge/update', async (request, reply) => {
    const body = (request.body || {}) as {
      knowledgeBase?: unknown;
      name?: string;
      description?: string;
    };
    const parsed = KnowledgeManageRequestSchema.safeParse({ knowledgeBase: body.knowledgeBase });
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid update request.', issues: parsed.error.issues });
    try {
      return await updateKnowledgeBaseMeta(parsed.data.knowledgeBase, {
        name: body.name,
        description: body.description,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Update knowledge base failed.' });
    }
  });

  app.post('/knowledge/delete-remote', async (request, reply) => {
    const parsed = KnowledgeManageRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid delete request.', issues: parsed.error.issues });
    try {
      return await deleteKnowledgeBaseRemote(parsed.data.knowledgeBase);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : 'Delete remote knowledge base failed.' });
    }
  });
};
