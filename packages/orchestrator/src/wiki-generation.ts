import { randomUUID } from 'node:crypto';
import type { WikiGenerationJob, WikiScope, WikiGeneratedPage, WikiGenerationCheckpoint } from '@workmate/contracts';
import { wikiGenerationFailureCode } from '@workmate/contracts';
import type { ExecutionDispatcher } from './execution-dispatcher.js';
import { withKeyLock } from './lock.js';

export interface WikiJobRepository {
  get(id: string, byKey?: boolean): WikiGenerationJob | undefined;
  list(): WikiGenerationJob[];
  save(job: WikiGenerationJob, checkpoint?: WikiGenerationCheckpoint): void;
  checkpoint?(id: string): WikiGenerationCheckpoint | undefined;
}
export class WikiGenerationError extends Error {
  constructor(public readonly code: 'CAPACITY_EXCEEDED' | 'IDEMPOTENCY_CONFLICT' | 'RESUME_UNAVAILABLE' | 'SOURCE_CHANGED' | 'MODEL_CHANGED') { super(code); }
}
const active = (job: WikiGenerationJob) => job.state === 'queued' || job.state === 'running';

/** State transitions belong here; the API supplies SQLite/source/model adapters. */
export class WikiGenerationService {
  private readonly running = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly dispatcher: ExecutionDispatcher) {}

  read(repository: WikiJobRepository, id: string): WikiGenerationJob | undefined {
    const job = repository.get(id);
    if (job && active(job) && !this.running.has(job.jobId)) {
      job.state = 'interrupted'; job.errorCode = 'PROCESS_INTERRUPTED'; job.updatedAt = new Date().toISOString();
      repository.save(job);
    }
    return job;
  }

  async start(input: {
    scope: WikiScope; idempotencyKey: string; requestHash: string;
    sources: WikiGenerationJob['sources']; totalChunks: number; repository: WikiJobRepository;
    batchChunks?: number[];
    checkpointHash?: string; resumeJobId?: string;
    generate: (signal: AbortSignal, batchIndex: number) => Promise<WikiGeneratedPage[]>;
    merge?: (batches: WikiGeneratedPage[][]) => WikiGeneratedPage[];
    savePage: (page: WikiGeneratedPage, jobId: string, linkPhase: boolean) => void;
  }): Promise<WikiGenerationJob> {
    const batchChunks = input.batchChunks ?? [input.totalChunks];
    if (!batchChunks.length || batchChunks.length > 8 || batchChunks.some((n) => !Number.isInteger(n) || n < 1 || n > 100)
      || batchChunks.reduce((a, b) => a + b, 0) !== input.totalChunks || (batchChunks.length > 1 && !input.merge)) {
      throw new Error('INVALID_BATCH_PLAN');
    }
    return withKeyLock(`wiki:${JSON.stringify(input.scope)}`, () => {
      const prior = !input.resumeJobId && input.repository.get(input.idempotencyKey, true);
      if (prior) {
        if (prior.requestHash !== input.requestHash) throw new WikiGenerationError('IDEMPOTENCY_CONFLICT');
        return this.read(input.repository, prior.jobId)!;
      }
      let restored: WikiGenerationJob | undefined;
      let durable: WikiGenerationCheckpoint | undefined;
      if (input.resumeJobId) {
        restored = this.read(input.repository, input.resumeJobId);
        if (!restored || JSON.stringify(restored.scope) !== JSON.stringify(input.scope)) throw new WikiGenerationError('RESUME_UNAVAILABLE');
        durable = input.repository.checkpoint?.(restored.jobId);
        if (restored.state === 'completed' || durable?.resumeKeys.includes(input.idempotencyKey)) return restored;
        if (active(restored) || this.running.has(restored.jobId)) throw new WikiGenerationError('CAPACITY_EXCEEDED');
        if (!durable || !restored.resumable || durable.resumeKeys.length >= 20) throw new WikiGenerationError('RESUME_UNAVAILABLE');
        if (restored.requestHash !== input.requestHash) throw new WikiGenerationError('MODEL_CHANGED');
        if (durable.inputHash !== input.checkpointHash || JSON.stringify(durable.batchChunks) !== JSON.stringify(batchChunks)) throw new WikiGenerationError('SOURCE_CHANGED');
        durable.resumeKeys.push(input.idempotencyKey);
      }
      for (const stored of input.repository.list()) {
        const job = this.read(input.repository, stored.jobId)!;
        if (active(job)) throw new WikiGenerationError('CAPACITY_EXCEEDED');
      }
      const now = new Date().toISOString();
      const job: WikiGenerationJob = restored ?? { schemaVersion: 1, jobId: `wj-${randomUUID()}`, scope: input.scope,
        idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, state: 'queued',
        sources: input.sources, totalChunks: input.totalChunks, processedChunks: 0, pageIds: [], errorCode: null,
        progress: { phase: 'queued', batchIndex: 0, batchCount: batchChunks.length },
        createdAt: now, updatedAt: now };
      if (!durable && input.checkpointHash && input.repository.checkpoint) durable = {
        schemaVersion: 1, inputHash: input.checkpointHash, batchChunks, batches: [], resumeKeys: [],
      };
      job.state = 'queued'; job.errorCode = null; job.updatedAt = now;
      job.attemptStartedAt = now;
      job.progress = { phase: 'queued', batchIndex: durable?.batches.length ?? 0, batchCount: batchChunks.length };
      job.resumable = !!durable && durable.resumeKeys.length < 20;
      if (durable) job.processedChunks = batchChunks.slice(0, durable.batches.length).reduce((a, b) => a + b, 0);
      input.repository.save(job, durable);
      const controller = new AbortController(); this.running.set(job.jobId, controller);
      const checkpoint = () => { job.updatedAt = new Date().toISOString(); input.repository.save(job, durable); };
      const work = this.dispatcher.dispatch({ runId: job.jobId, orgId: job.scope.orgId, userId: job.scope.userId,
        sessionId: `wiki:${job.scope.knowledgeBaseId}`, kind: 'project-task', priority: 'normal', signal: controller.signal,
        execute: async () => {
          controller.signal.throwIfAborted(); job.state = 'running'; checkpoint();
          const batches: WikiGeneratedPage[][] = durable?.batches ?? [];
          for (let index = batches.length; index < batchChunks.length; index++) {
            controller.signal.throwIfAborted();
            job.progress = { phase: 'generate', batchIndex: index + 1, batchCount: batchChunks.length }; checkpoint();
            const generated = await input.generate(controller.signal, index);
            controller.signal.throwIfAborted();
            batches.push(generated);
            job.processedChunks += batchChunks[index]; checkpoint();
          }
          job.progress!.phase = 'merge'; checkpoint();
          const pages = durable?.merged ?? (input.merge ? input.merge(batches) : batches[0]);
          if (durable) { durable.merged = pages; checkpoint(); }
          controller.signal.throwIfAborted();
          job.processedChunks = job.totalChunks;
          job.progress!.phase = 'save'; checkpoint();
          for (const page of pages) {
            controller.signal.throwIfAborted();
            input.savePage({ ...page, content: { ...page.content, links: [] } }, job.jobId, false);
            if (!job.pageIds.includes(page.pageId)) job.pageIds.push(page.pageId);
            checkpoint();
          }
          job.progress!.phase = 'link'; checkpoint();
          for (const page of pages.filter((p) => p.content.links.length)) {
            controller.signal.throwIfAborted(); input.savePage(page, job.jobId, true); checkpoint();
          }
          job.state = 'completed'; job.progress!.phase = 'done'; job.resumable = false;
          if (durable) { durable.batches = []; delete durable.merged; }
          checkpoint();
        },
      }).catch((error: unknown) => {
        job.state = controller.signal.aborted ? 'cancelled' : job.pageIds.length ? 'partial' : 'failed';
        job.errorCode = controller.signal.aborted ? 'CANCELLED' : wikiGenerationFailureCode(error) ?? 'GENERATION_FAILED'; checkpoint();
      }).finally(() => { this.running.delete(job.jobId); });
      // Persisting a failure can itself fail. Never create an unhandled rejection or falsely report success.
      const settled = work.catch(() => undefined).finally(() => { this.pending.delete(settled); });
      this.pending.add(settled);
      return structuredClone(job);
    });
  }

  cancel(repository: WikiJobRepository, id: string): WikiGenerationJob | undefined {
    const job = this.read(repository, id);
    if (job && active(job)) this.running.get(id)?.abort();
    return job; // State changes only after the in-flight work actually stops.
  }

  async close(): Promise<void> {
    for (const controller of this.running.values()) controller.abort();
    await Promise.all(this.pending);
  }
}
