import test from 'node:test';
import assert from 'node:assert/strict';
import type { WikiGenerationJob, WikiGeneratedPage, WikiGenerationCheckpoint } from '@workmate/contracts';
import { WikiGenerationService, type WikiJobRepository } from '../wiki-generation.js';
import { InMemoryExecutionDispatcher } from '../execution-dispatcher.js';
import { WikiGenerationJobSchema, WikiGenerationFailure, WikiGenerationFailureCodeSchema } from '@workmate/contracts';

const scope = { orgId: 'o', userId: 'u', knowledgeBaseId: 'kb' };
test('WK-R18-T: restart reuses validated batches, rejects changed input and replays explicit resume keys', async () => {
  const f = fixture(); const calls: number[] = []; const saved: string[] = [];
  let fail = true;
  const args = { ...f.base, batchChunks: [1, 1], checkpointHash: 'b'.repeat(64),
    generate: async (_signal: AbortSignal, index: number) => {
      calls.push(index); if (index === 1 && fail) throw new Error('temporary'); return [pages[index]];
    }, merge: (batches: WikiGeneratedPage[][]) => batches.flat(), savePage: (page: WikiGeneratedPage) => { saved.push(page.pageId); },
  };
  const first = await f.service.start(args); const failed = await finish(f, first.jobId);
  assert.equal(failed.processedChunks, 1); assert.equal(failed.resumable, true);
  assert.equal(f.repository.checkpoint!(first.jobId)!.batches.length, 1);
  await f.service.close();
  f.service = new WikiGenerationService(new InMemoryExecutionDispatcher());
  const resume = { ...args, resumeJobId: first.jobId, idempotencyKey: 'resume-one' };
  await assert.rejects(f.service.start({ ...resume, checkpointHash: 'c'.repeat(64) }), /SOURCE_CHANGED/);
  await assert.rejects(f.service.start({ ...resume, requestHash: 'c'.repeat(64) }), /MODEL_CHANGED/);
  fail = false;
  const next = await f.service.start(resume); assert.equal(next.jobId, first.jobId);
  const done = await finish(f, first.jobId);
  assert.equal(done.state, 'completed'); assert.deepEqual(calls, [0, 1, 1]); assert.deepEqual(saved, ['p1', 'p2']);
  assert.equal(done.resumable, false); assert.equal(f.repository.checkpoint!(first.jobId)!.batches.length, 0);
  await f.service.start(resume); assert.deepEqual(calls, [0, 1, 1]);
  await f.service.close();
});
test('WK-R18-T: save failure resumes stable pages without another model call; retry key is idempotent even after failure', async () => {
  const f = fixture(); let calls = 0; let fail = true;
  const args = { ...f.base, checkpointHash: 'b'.repeat(64), generate: async () => { calls++; return pages; },
    savePage: (page: WikiGeneratedPage) => { if (fail && page.pageId === 'p2') throw new Error('disk'); } };
  const first = await f.service.start(args); await finish(f, first.jobId);
  const retry = { ...args, resumeJobId: first.jobId, idempotencyKey: 'resume-1' };
  await f.service.start(retry); await finish(f, first.jobId);
  await f.service.start(retry); assert.equal(f.repository.get(first.jobId)!.state, 'partial');
  fail = false;
  await f.service.start({ ...retry, idempotencyKey: 'resume-2' });
  const done = await finish(f, first.jobId);
  assert.equal(done.state, 'completed'); assert.deepEqual(done.pageIds, ['p1', 'p2']); assert.equal(calls, 1);
  await f.service.close();
});
test('WK-R18-T: concurrent resume is bounded and persisted active job is recoverable without automatic calls', async () => {
  const f = fixture(); let fail = true; let release: (() => void) | undefined;
  const args = { ...f.base, checkpointHash: 'b'.repeat(64), generate: async () => {
    if (fail) throw new Error('temporary');
    await new Promise<void>((resolve) => { release = resolve; }); return pages;
  }, savePage: () => {} };
  const original = await f.service.start(args); await finish(f, original.jobId); fail = false;
  const resume = { ...args, resumeJobId: original.jobId, idempotencyKey: 'resume' };
  await f.service.start(resume);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await f.service.start(resume)).jobId, original.jobId);
  await assert.rejects(f.service.start({ ...resume, idempotencyKey: 'another-resume' }), /CAPACITY_EXCEEDED/);
  f.service.cancel(f.repository, original.jobId); release();
  const cancelled = await finish(f, original.jobId); assert.equal(cancelled.state, 'cancelled');
  assert.equal(f.repository.checkpoint!(original.jobId)!.batches.length, 0);
  await f.service.close();
  f.repository.save({ ...cancelled, state: 'running' });
  f.service = new WikiGenerationService(new InMemoryExecutionDispatcher());
  assert.equal(f.service.read(f.repository, original.jobId)!.state, 'interrupted');
  const checkpoint = f.repository.checkpoint!(original.jobId)!;
  checkpoint.resumeKeys = Array.from({ length: 20 }, (_, n) => `attempt-${n}`);
  f.repository.save(f.repository.get(original.jobId)!, checkpoint);
  await assert.rejects(f.service.start({ ...resume, idempotencyKey: 'over-limit' }), /RESUME_UNAVAILABLE/);
  await f.service.close();
});
test('WK-D17-T: linking failure retains phase without claiming overall completion', async () => {
  const f = fixture();
  const linked = structuredClone(pages);
  linked[0].content.links = [{ targetPageId: 'p2', sourceSectionId: 's', label: 'p2' }];
  const job = await f.service.start({ ...f.base, generate: async () => linked,
    savePage: (_page, _jobId, linkPhase) => {
      assert.equal(f.repository.list()[0].progress?.phase, linkPhase ? 'link' : 'save');
      if (linkPhase) throw new Error('private storage diagnostic');
    },
  });
  const done = await finish(f, job.jobId);
  assert.equal(done.state, 'partial'); assert.equal(done.processedChunks, done.totalChunks);
  assert.equal(done.progress?.phase, 'link'); assert.deepEqual(done.pageIds, ['p1', 'p2']);
  assert.equal(WikiGenerationJobSchema.safeParse({ ...done, progress: { phase: 'save', batchIndex: 2, batchCount: 1 } }).success, false);
  assert.equal(WikiGenerationJobSchema.safeParse({ ...done, progress: { phase: 'unknown', batchIndex: 1, batchCount: 1 } }).success, false);
  await f.service.close();
});
test('WK-G02c: typed failure whitelist survives, provider messages and forged codes do not', async () => {
  const failures: unknown[] = WikiGenerationFailureCodeSchema.options.map((code) => new WikiGenerationFailure(code));
  failures.push(new Error('api-key-secret'), { code: 'MODEL_TIMEOUT', message: 'private prompt' });
  for (const failure of failures) {
    const f = fixture();
    const job = await f.service.start({ ...f.base, generate: async () => { throw failure; }, savePage: () => assert.fail() });
    const done = await finish(f, job.jobId);
    assert.equal(done.state, 'failed');
    assert.equal(done.errorCode, failure instanceof WikiGenerationFailure ? failure.code : 'GENERATION_FAILED');
    assert.equal(JSON.stringify(done).includes('secret'), false); assert.equal(JSON.stringify(done).includes('private prompt'), false);
    await f.service.close();
  }
});
test('WK-G02c: explicit cancellation takes priority over a provider failure', async () => {
  const f = fixture();
  const job = await f.service.start({ ...f.base, generate: async () => {
    f.service.cancel(f.repository, f.repository.list()[0].jobId);
    throw new WikiGenerationFailure('MODEL_UNAVAILABLE');
  }, savePage: () => assert.fail() });
  const done = await finish(f, job.jobId);
  assert.equal(done.state, 'cancelled'); assert.equal(done.errorCode, 'CANCELLED'); await f.service.close();
});
function fixture() {
  const rows = new Map<string, WikiGenerationJob>();
  const checkpoints = new Map<string, WikiGenerationCheckpoint>();
  const repository: WikiJobRepository = {
    get: (id, byKey) => structuredClone(byKey ? [...rows.values()].find((j) => j.idempotencyKey === id) : rows.get(id)),
    list: () => structuredClone([...rows.values()]), save: (job, checkpoint) => {
      rows.set(job.jobId, structuredClone(job));
      if (checkpoint) checkpoints.set(job.jobId, structuredClone(checkpoint));
    },
    checkpoint: (id) => structuredClone(checkpoints.get(id)),
  };
  const service = new WikiGenerationService(new InMemoryExecutionDispatcher());
  const base = { scope, idempotencyKey: 'one', requestHash: 'a'.repeat(64), repository,
    sources: [{ documentId: 'd', documentVersionId: 'v', processingRevisionId: 'r' }], totalChunks: 2 };
  return { rows, repository, service, base };
}
const pages: WikiGeneratedPage[] = ['p1', 'p2'].map((pageId) => ({ pageId, slug: pageId, content: {
  title: pageId, summary: '', aliases: [], categoryPath: [], bodyMarkdown: 'body',
  sections: [{ sectionId: 's', headingPath: ['Title'], start: 0, end: 4 }], links: [],
  evidenceRefs: [{ refId: 'ref', sectionId: 's', sourceKind: 'local-evidence', excerptHash: 'a'.repeat(64),
    evidence: { schemaVersion: 1, verification: 'versioned', provider: 'lancedb', knowledgeBaseId: 'kb', documentId: 'd',
      documentVersionId: 'v', processingRevisionId: 'r', chunkId: 'c', contentHash: 'a'.repeat(64) } }],
} }));
async function finish(f: ReturnType<typeof fixture>, id: string) {
  for (let i = 0; i < 100; i++) {
    const result = f.service.read(f.repository, id)!;
    if (!['running', 'queued'].includes(result.state)) return result;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timeout');
}
test('WK-G02b: sequential batches checkpoint validated chunks before saving; replay never reruns', async () => {
  const f = fixture(); const indices: number[] = []; let merged = false;
  const args = { ...f.base, batchChunks: [1, 1],
    generate: async (_signal: AbortSignal, index: number) => {
      assert.equal(f.repository.list()[0].processedChunks, index);
      assert.deepEqual(f.repository.list()[0].progress, { phase: 'generate', batchIndex: index + 1, batchCount: 2 });
      indices.push(index); return [pages[index]];
    },
    merge: (batches: WikiGeneratedPage[][]) => { assert.equal(f.repository.list()[0].progress?.phase, 'merge'); merged = true; return batches.flat(); },
    savePage: () => { assert.equal(f.repository.list()[0].progress?.phase, 'save'); assert.equal(merged, true); assert.equal(f.repository.list()[0].processedChunks, 2); },
  };
  const job = await f.service.start(args); const done = await finish(f, job.jobId);
  assert.equal(done.state, 'completed'); assert.deepEqual(indices, [0, 1]);
  assert.equal(done.progress?.phase, 'done');
  assert.equal(WikiGenerationJobSchema.safeParse(done).success, true);
  assert.equal(WikiGenerationJobSchema.safeParse({ ...done, totalChunks: 400, processedChunks: 400,
    pageIds: Array.from({ length: 64 }, (_, n) => `p-${n}`) }).success, true);
  await f.service.start(args); assert.deepEqual(indices, [0, 1]); await f.service.close();
});
test('WK-G02b: second batch failure or cancellation stops later calls and does not save incomplete candidates', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); const indices: number[] = [];
    const job = await f.service.start({ ...f.base, totalChunks: 3, batchChunks: [1, 1, 1],
      generate: async (_signal, index) => {
        indices.push(index);
        if (index === 1) {
          if (cancel) f.service.cancel(f.repository, f.repository.list()[0].jobId);
          else throw new Error('failed batch');
        }
        return pages;
      }, merge: (batches) => batches.flat(), savePage: () => assert.fail('must not save incomplete candidates'),
    });
    const done = await finish(f, job.jobId);
    assert.equal(done.state, cancel ? 'cancelled' : 'failed'); assert.equal(done.processedChunks, 1);
    assert.deepEqual(done.progress, { phase: 'generate', batchIndex: 2, batchCount: 3 });
    assert.deepEqual(indices, [0, 1]); assert.deepEqual(done.pageIds, []); await f.service.close();
  }
});
test('WK-G02a: idempotency, partial commits retained, sanitized errors and no automatic retry', async () => {
  const f = fixture(); let calls = 0;
  const args = { ...f.base, generate: async () => { calls++; return pages; },
    savePage: (page: WikiGeneratedPage) => { if (page.pageId === 'p2') throw new Error('provider secret must not persist'); } };
  const first = await f.service.start(args);
  const result = await finish(f, first.jobId);
  assert.equal(result.state, 'partial'); assert.deepEqual(result.pageIds, ['p1']);
  assert.equal(result.progress?.phase, 'save');
  assert.equal(result.errorCode, 'GENERATION_FAILED'); assert.equal(JSON.stringify(result).includes('provider secret'), false);
  assert.equal((await f.service.start(args)).jobId, first.jobId); assert.equal(calls, 1);
  await assert.rejects(f.service.start({ ...args, requestHash: 'b'.repeat(64) }), /IDEMPOTENCY_CONFLICT/);
  await f.service.close();
});
test('WK-G02a: interrupted persisted jobs do not restart a model', async () => {
  const f = fixture();
  const now = new Date().toISOString();
  f.repository.save({ schemaVersion: 1, jobId: 'old', scope, state: 'running', idempotencyKey: 'old-key', requestHash: 'a'.repeat(64),
    sources: f.base.sources, totalChunks: 2, processedChunks: 2, pageIds: ['saved'], errorCode: null, createdAt: now, updatedAt: now });
  const restored = f.service.read(f.repository, 'old')!;
  assert.equal(restored.state, 'interrupted'); assert.deepEqual(restored.pageIds, ['saved']);
  assert.equal(WikiGenerationJobSchema.safeParse(restored).success, true);
  assert.equal(restored.progress, undefined);
  assert.equal(f.repository.get('old')!.errorCode, 'PROCESS_INTERRUPTED'); await f.service.close();
});
test('WK-G02a: active library rejects a second request, cancellation waits for generator acknowledgement', async () => {
  const f = fixture(); let release!: () => void;
  const result = await f.service.start({ ...f.base,
    generate: async () => { await new Promise<void>((resolve) => { release = resolve; }); return pages; },
    savePage: () => assert.fail('cancelled generation must not save'),
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(f.service.start({ ...f.base, idempotencyKey: 'two', generate: async () => pages, savePage: () => {} }), /CAPACITY_EXCEEDED/);
  assert.equal(f.service.cancel(f.repository, result.jobId)!.state, 'running');
  release(); assert.equal((await finish(f, result.jobId)).state, 'cancelled');
  await f.service.close();
});
