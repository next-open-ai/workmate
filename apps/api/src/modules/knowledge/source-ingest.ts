import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { MAX_LOCAL_KNOWLEDGE_FILE_BYTES, MAX_BAILIAN_KNOWLEDGE_FILE_BYTES } from '@workmate/contracts';
import { KnowledgeIngestRequestSchema, type KnowledgeDocumentScope, type KnowledgeSourceSnapshot } from '@workmate/contracts';
import { ImmutableFileStore, KnowledgeSourceStore } from '@workmate/storage';
import { requireAuth } from '../auth/service.js';
import { KnowledgeCatalog, KnowledgeAccessError } from './catalog.js';
import { sendKnowledgeAccessError } from './ownership-routes.js';

type Ingest = (input: {
  kb: import('@workmate/contracts').KnowledgeBaseRuntime;
  documentId?: string; title: string; content?: string; fileBase64?: string; fileName?: string; source?: string;
  sourceSnapshot?: KnowledgeSourceSnapshot;
  model?: import('@workmate/contracts').ModelConfig;
}) => Promise<object>;

export function registerSourceIngest(app: FastifyInstance, dependencies: {
  dataRoot: () => string;
  ingest: Ingest;
  identifyVersion: (scope: KnowledgeDocumentScope, bytes: Uint8Array) => { documentVersionId: string; sourceHash: string };
}) {
  function stores() {
    const root = path.join(dependencies.dataRoot(), 'knowledge-sources');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const files = new ImmutableFileStore(path.join(root, 'objects'));
    return { files, sources: new KnowledgeSourceStore(path.join(root, 'sources.sqlite'), files) };
  }

  app.post('/knowledge/ingest', { bodyLimit: 30_000_000 }, async (request, reply) => {
    if (!request.auth) return reply.code(401).send({ message: 'Authentication required.' });
    const principal = requireAuth(request);
    const owner = { orgId: principal.orgId, userId: principal.userId };
    const parsed = KnowledgeIngestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      if (parsed.error.issues.some((issue) => issue.path[0] === 'fileBase64' && issue.code === 'too_big')) {
        return reply.code(413).send({ message: '文件过大，本地知识库和百炼单文件最大 8 MB。' });
      }
      return reply.code(400).send({ message: 'Invalid ingest request.', issues: parsed.error.issues });
    }
    const input = parsed.data;
    let snapshot: KnowledgeSourceSnapshot | undefined;
    try {
      input.knowledgeBase = new KnowledgeCatalog(dependencies.dataRoot()).resolve(principal, input.knowledgeBase.id);
      const maxBytes = input.knowledgeBase.provider === 'bailian' ? MAX_BAILIAN_KNOWLEDGE_FILE_BYTES : MAX_LOCAL_KNOWLEDGE_FILE_BYTES;
      const tooLarge = () => reply.code(413).send({ message: `文件过大，当前知识库单文件最大 ${maxBytes / 1_000_000} MB。` });
      if (input.fileBase64 && Buffer.byteLength(input.fileBase64, 'base64') > maxBytes) return tooLarge();
      let content = input.content;
      let fileBase64 = input.fileBase64;
      let fileName = input.fileName;
      let documentId: string | undefined;
      if (input.knowledgeBase.provider === 'lancedb') {
        let bytes: Buffer;
        let origin: KnowledgeSourceSnapshot['origin'];
        if (content?.trim()) {
          bytes = Buffer.from(content, 'utf8'); origin = 'text'; fileName = `${input.title}.txt`;
          // Match the established parser's text-first rule; never archive an unused attachment as evidence.
          fileBase64 = undefined;
        } else {
          if (!fileName?.trim()) throw new Error('A source filename is required.');
          bytes = Buffer.from(fileBase64!.trim(), 'base64'); origin = 'upload';
        }
        if (bytes.length > maxBytes) return tooLarge();
        documentId = randomUUID();
        const scope = { provider: 'lancedb', knowledgeBaseId: input.knowledgeBase.id, documentId };
        const { documentVersionId } = dependencies.identifyVersion(scope, bytes);
        const { files, sources } = stores();
        try {
          snapshot = sources.put(owner, { ...scope, documentVersionId, file: files.put(owner, bytes),
            fileName: path.basename(fileName!.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 240) || 'source',
            origin, status: 'archived' });
        } finally { sources.close(); }
      }
      const result = await dependencies.ingest({ kb: input.knowledgeBase, documentId, title: input.title,
        content, fileBase64, fileName, source: input.source, model: input.model, sourceSnapshot: snapshot });
      return { ...result, ...(snapshot ? { sourceSnapshot: snapshot } : {}) };
    } catch (error) {
      if (error instanceof KnowledgeAccessError) return sendKnowledgeAccessError(reply, error);
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      const message = code === 'CONFLICT'
        ? '文档在处理期间已发生变化，本次结果未发布。请刷新后重试。'
        : error instanceof Error ? error.message : 'Ingest failed.';
      return reply.code(400).send({ message, ...(code ? { code } : {}),
        ...(snapshot ? { sourceSnapshot: snapshot } : {}) });
    }
  });

  app.get<{ Params: { version: string } }>('/knowledge/sources/:version', async (request, reply) => {
    if (!request.auth) return reply.code(401).send({ message: 'Authentication required.' });
    const principal = requireAuth(request);
    if (!/^dv-[a-f0-9]{64}$/.test(request.params.version)) return reply.code(404).send({ message: 'Source not found.' });
    const { sources } = stores();
    try {
      const owner = { orgId: principal.orgId, userId: principal.userId };
      const snapshot = sources.get(owner, request.params.version);
      if (!snapshot) return reply.code(404).send({ message: 'Source not found.' });
      new KnowledgeCatalog(dependencies.dataRoot()).resolve(principal, snapshot.knowledgeBaseId);
      const result = sources.read(owner, request.params.version);
      if (!result) return reply.code(404).send({ message: 'Source not found.' });
      return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.snapshot.fileName)}`)
        .type('application/octet-stream').send(result.bytes);
    } catch (error) {
      if (error instanceof KnowledgeAccessError) return sendKnowledgeAccessError(reply, error);
      return reply.code(503).send({ message: 'Source unavailable.' });
    } finally { sources.close(); }
  });
}
