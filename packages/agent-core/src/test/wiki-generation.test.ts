import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WikiGenerationInputSchema, type WikiGenerationInput } from '@workmate/contracts';
import { validateWikiGeneration, decodeWikiGeneration, generateWikiPages } from '../wiki-generation.js';
import { WikiGenerationFailure } from '@workmate/contracts';
import { planWikiBatches, mergeWikiBatches } from '../wiki-batching.js';

function input(): WikiGenerationInput {
  return { batches: [1, 2].map((n) => {
    const content = `文档${n}：报销必须提供发票。`;
    const scope = { provider: 'lancedb', knowledgeBaseId: 'kb', documentId: `doc${n}` };
    return { ...scope, documentVersionId: `v${n}`, processingRevisionId: `r${n}`, sourceHash: 'a'.repeat(64),
      chunks: [{ content, evidence: { ...scope, schemaVersion: 1 as const, verification: 'versioned' as const,
        chunkId: `c${n}`, documentVersionId: `v${n}`, processingRevisionId: `r${n}`,
        contentHash: createHash('sha256').update(content).digest('hex') } }] };
  }) };
}
function output() {
  return { pages: [1, 2].map((n) => ({ key: `p${n}`, title: `主题${n}`, aliases: ['报销'], summary: '报销说明',
    sections: [{ heading: '发票要求', body: '😀报销需要发票', chunkIds: [`c${n}`], relatedKeys: [`p${3 - n}`] }] })) };
}
test('WK-R14-T: short references restore exact evidence; unknown and raw IDs fail closed', () => {
  const aliases = new Map([['source_1', 'c1'], ['source_2', 'c2']]);
  const result = output();
  result.pages.forEach((page, i) => { page.sections[0].chunkIds = [`source_${i + 1}`]; });
  const pages = decodeWikiGeneration(JSON.stringify(result), input(), aliases);
  assert.equal(pages[0].content.evidenceRefs[0].evidence.chunkId, 'c1');
  for (const invalid of ['source_9', 'c1']) {
    result.pages[0].sections[0].chunkIds = [invalid];
    assert.throws(() => decodeWikiGeneration(JSON.stringify(result), input(), aliases), /INVALID_MODEL_REFERENCE/);
  }
});
test('WK-G01c: accepts only complete JSON/plain-json fences, preserving evidence checks and safe errors', () => {
  const json = JSON.stringify(output());
  for (const text of [json, `\n\`\`\`json\n${json}\n\`\`\`\n`, `\`\`\`\r\n${json}\r\n\`\`\``]) {
    assert.equal(decodeWikiGeneration(text, input()).length, 2);
  }
  for (const text of ['', json.slice(0, -1), `说明\n${json}`, `\`\`\`json\n${json}\n\`\`\`\n尾注`, 'x'.repeat(128001), '{"secret":"private text"}']) {
    assert.throws(() => decodeWikiGeneration(text, input()), (error: unknown) =>
      error instanceof WikiGenerationFailure && error.code === 'INVALID_MODEL_OUTPUT' && !error.message.includes('private text'));
  }
  const invalid = output(); invalid.pages[0].sections[0].chunkIds = ['invented'];
  assert.throws(() => decodeWikiGeneration(`\`\`\`json\n${JSON.stringify(invalid)}\n\`\`\``, input()),
    (error: unknown) => error instanceof WikiGenerationFailure && error.code === 'INVALID_MODEL_REFERENCE');
});
test('WK-G01c: pre-cancelled generation never reaches provider', async () => {
  const signal = AbortSignal.abort(new Error('cancelled before transport'));
  await assert.rejects(generateWikiPages(input(), { provider: 'openai-compatible', chatModel: 'unused', apiKey: 'fixture-only' }, signal), /cancelled before transport/);
});
test('WK-G01c: expired per-call deadline is reported as timeout without exposing provider details', async (t) => {
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort());
  await assert.rejects(generateWikiPages(input(), { provider: 'openai-compatible', chatModel: 'fixture',
    apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1/v1' }, new AbortController().signal),
  (error: unknown) => error instanceof WikiGenerationFailure && error.code === 'MODEL_TIMEOUT');
});
test('WK-G01a: complete multi-document coverage, trusted evidence, Unicode ranges and real page links', () => {
  const pages = validateWikiGeneration(output(), input());
  assert.equal(pages.length, 2);
  assert.equal(pages[0].content.links[0].targetPageId, pages[1].pageId);
  assert.equal(pages[0].content.evidenceRefs[0].evidence.chunkId, 'c1');
  assert.equal(pages[0].content.sections[0].end, '😀报销需要发票'.length);
  assert.notEqual(pages[0].pageId, 'p1');
});
test('WK-G01a: invented references, missing coverage, unknown links, duplicate keys and tampered hashes fail closed', () => {
  const badRef = output(); badRef.pages[0].sections[0].chunkIds = ['unknown'];
  assert.throws(() => validateWikiGeneration(badRef, input()), /INVALID_MODEL_REFERENCE/);
  const missing = output(); missing.pages.pop(); missing.pages[0].sections[0].relatedKeys = [];
  assert.throws(() => validateWikiGeneration(missing, input()), /INCOMPLETE_COVERAGE/);
  const badLink = output(); badLink.pages[0].sections[0].relatedKeys = ['unknown'];
  assert.throws(() => validateWikiGeneration(badLink, input()), /INVALID_MODEL_LINK/);
  const duplicate = output(); duplicate.pages[1].key = 'p1';
  assert.throws(() => validateWikiGeneration(duplicate, input()), /INVALID_MODEL_OUTPUT/);
  const tampered = input(); tampered.batches[0].chunks[0].content = 'changed';
  assert.throws(() => validateWikiGeneration(output(), tampered), /INVALID_EVIDENCE/);
});
test('WK-G01a: input caps reject, never silently truncate', () => {
  const huge = input(); huge.batches[0].chunks[0].content = 'a'.repeat(192001);
  assert.equal(WikiGenerationInputSchema.safeParse(huge).success, false);
  const cross = input(); cross.batches[1].knowledgeBaseId = 'another';
  assert.equal(WikiGenerationInputSchema.safeParse(cross).success, false);
});

test('WK-G01b: deterministic bounded batches cover every child once and reject oversized single blocks/metadata', () => {
  const source = input(); source.batches = [source.batches[0]];
  const chunk = source.batches[0].chunks[0];
  source.batches[0].chunks = Array.from({ length: 205 }, (_, n) => ({ ...chunk, evidence: { ...chunk.evidence, chunkId: `c-${n}` } }));
  const batches = planWikiBatches(source);
  assert.deepEqual(batches.map((b) => b.batches[0].chunks.length), [100, 100, 5]);
  assert.deepEqual(batches.flatMap((b) => b.batches.flatMap((d) => d.chunks)), source.batches[0].chunks);
  const large = input(); large.batches[0].chunks[0].content = 'a'.repeat(48001);
  assert.throws(() => planWikiBatches(large), /LIMIT_EXCEEDED/);
  const metadata = input(); metadata.batches[0].documentTitle = 'a'.repeat(128001);
  assert.throws(() => planWikiBatches(metadata), /LIMIT_EXCEEDED/);
  const chars = input(); chars.batches.forEach((b) => { b.chunks[0].content = 'a'.repeat(30000); });
  assert.equal(planWikiBatches(chars).length, 2);
  assert.equal(planWikiBatches(input()).length, 1);
  const tooMany = input(); tooMany.batches = [tooMany.batches[0]];
  tooMany.batches[0].documentTitle = 't'.repeat(110000);
  tooMany.batches[0].chunks = Array.from({ length: 9 }, (_, n) => ({ ...chunk, content: 'x'.repeat(10000),
    evidence: { ...chunk.evidence, chunkId: `large-${n}` } }));
  assert.throws(() => planWikiBatches(tooMany), /LIMIT_EXCEEDED/);
});

test('WK-G01b: exact titles collect sections, preserve Unicode/evidence and remap links without mutating candidates', () => {
  const first = validateWikiGeneration(output(), input());
  const second = validateWikiGeneration(output(), input());
  const before = structuredClone([first, second]);
  const merged = mergeWikiBatches([first, second]);
  assert.equal(merged.length, 2);
  for (const page of merged) {
    assert.equal(page.content.sections.length, 2);
    for (const section of page.content.sections) {
      assert.equal(page.content.bodyMarkdown.slice(section.start, section.end), '😀报销需要发票');
      assert.equal(page.content.evidenceRefs.filter((r) => r.sectionId === section.sectionId).length, 1);
    }
    assert.equal(page.content.links.length, 2);
    assert.ok(page.content.links.every((l) => l.targetPageId === merged.find((p) => p.pageId !== page.pageId)!.pageId));
  }
  assert.deepEqual([first, second], before);
  second[0].content.summary = 'x'.repeat(2000);
  assert.equal(mergeWikiBatches([first, second]).length, 3, 'over-capacity group stays separate');
  second[0].content.title = second[1].content.title;
  assert.equal(mergeWikiBatches([first, second]).length, 4, 'ambiguous same-batch title stays separate');
});
