import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractOntologyCandidateBatches,
  normalizeOntologyExtraction,
  partitionOntologyExtractionChunks,
} from '../ontology-extraction.js';

const chunks = [{ id: 'chunk-1', documentId: 'doc-1', documentTitle: '退款规则', source: 'refund.md', content: '退款未到账属于售后问题。' }];

test('ontology extraction normalizes fenced model JSON into evidence-bound candidates', () => {
  const result = normalizeOntologyExtraction(`说明如下：\n\`\`\`json
  {"nodes":[{"id":"refund_pending","type":"issue","name":"退款未到账","aliases":["退款没收到"],"properties":{},"confidence":0.91,"evidence":{"chunkId":"chunk-1","quote":"退款未到账属于售后问题"}},{"id":"after_sales","type":"service","name":"售后","aliases":[],"properties":{},"confidence":0.85,"evidence":{"chunkId":"chunk-1","quote":"属于售后问题"}}],"edges":[{"subjectId":"refund_pending","predicate":"属于","objectId":"after_sales","properties":{},"confidence":0.88,"evidence":{"chunkId":"chunk-1","quote":"退款未到账属于售后问题"}}]}
  \`\`\``, chunks);
  assert.equal(result.length, 3);
  assert.equal(result.every((item) => item.status === 'pending'), true);
  assert.equal(result.every((item) => item.evidence[0]?.documentId === 'doc-1'), true);
  assert.equal(result.find((item) => item.kind === 'edge')?.edge?.predicate, '属于');
});

test('ontology extraction rejects evidence outside the selected chunks', () => {
  assert.throws(() => normalizeOntologyExtraction(JSON.stringify({
    nodes: [{ id: 'x', type: 'concept', name: 'X', evidence: { chunkId: 'chunk-other', quote: 'unknown' } }],
    edges: [],
  }), chunks), /未授权的知识切片/);
});

test('ontology extraction rejects a quote that is not present in the authorized chunk', () => {
  assert.throws(() => normalizeOntologyExtraction(JSON.stringify({
    nodes: [{ id: 'x', type: 'concept', name: 'X', evidence: { chunkId: 'chunk-1', quote: '文档中不存在的结论' } }],
    edges: [],
  }), chunks), /无法在原文中核验的证据/);
});

test('batched ontology extraction discards unverifiable candidates but keeps verified candidates', async () => {
  const result = await extractOntologyCandidateBatches(chunks, async () => JSON.stringify({
    nodes: [
      { id: 'verified', type: 'concept', name: '退款未到账', evidence: { chunkId: 'chunk-1', quote: '退款未到账属于售后问题' } },
      { id: 'invented', type: 'concept', name: '编造结论', evidence: { chunkId: 'chunk-1', quote: '原文中没有这句话' } },
    ],
    edges: [{ subjectId: 'verified', predicate: '关联', objectId: 'invented', evidence: { chunkId: 'chunk-1', quote: '退款未到账属于售后问题' } }],
  }));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.node?.id, 'verified');
});

test('ontology extraction partitions documents without splitting chunk contents', () => {
  const manyChunks = Array.from({ length: 13 }, (_, index) => ({
    id: `chunk-${index + 1}`,
    documentId: 'doc-1',
    documentTitle: '材料',
    content: `内容-${index + 1}`,
  }));
  const batches = partitionOntologyExtractionChunks(manyChunks);
  assert.deepEqual(batches.map((batch) => batch.length), [4, 4, 4, 1]);
  assert.deepEqual(batches.flat().map((chunk) => chunk.id), manyChunks.map((chunk) => chunk.id));
});

test('ontology extraction runs top-level batches with bounded concurrency and preserves batch order', async () => {
  const manyChunks = Array.from({ length: 18 }, (_, index) => ({
    id: `chunk-${index + 1}`,
    documentId: 'doc-1',
    documentTitle: '材料',
    content: `实体${index + 1}属于分类。`,
  }));
  let active = 0;
  let maxActive = 0;
  const result = await extractOntologyCandidateBatches(manyChunks, async (batch) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const batchNumber = Number(batch[0]!.id.split('-')[1]);
    await new Promise((resolve) => setTimeout(resolve, batchNumber === 1 ? 25 : 5));
    active -= 1;
    const chunk = batch[0]!;
    return JSON.stringify({
      nodes: [{ id: `entity_${chunk.id}`, type: 'concept', name: `实体${batchNumber}`, evidence: { chunkId: chunk.id, quote: chunk.content } }],
      edges: [],
    });
  });
  assert.equal(maxActive, 2);
  assert.deepEqual(result.map((candidate) => candidate.node?.name), ['实体1', '实体5', '实体9', '实体13', '实体17']);
});

test('ontology extraction splits and retries a batch when model JSON is incomplete', async () => {
  const retryChunks = Array.from({ length: 4 }, (_, index) => ({
    id: `chunk-${index + 1}`,
    documentId: 'doc-1',
    documentTitle: '材料',
    content: `实体${index + 1}属于分类。`,
  }));
  const calls: string[][] = [];
  const result = await extractOntologyCandidateBatches(retryChunks, async (batch) => {
    calls.push(batch.map((chunk) => chunk.id));
    if (batch.length > 2) return '{"nodes":[';
    const chunk = batch[0]!;
    return JSON.stringify({
      nodes: [{ id: `entity_${chunk.id}`, type: 'concept', name: `实体${chunk.id}`, evidence: { chunkId: chunk.id, quote: chunk.content } }],
      edges: [],
    });
  });
  assert.deepEqual(calls.map((call) => call.length), [4, 2, 2]);
  assert.equal(result.length, 2);
});

test('ontology extraction reports a readable error when one chunk repeatedly returns invalid JSON', async () => {
  const shortChunk = [{ ...chunks[0]!, content: '短内容。' }];
  await assert.rejects(
    () => extractOntologyCandidateBatches(shortChunk, async () => '{"nodes":['),
    /返回的结构化结果不完整，请重试或减少分析范围/,
  );
});

test('ontology extraction splits dense single-chunk text for retry without changing its evidence id', async () => {
  const denseChunk = {
    id: 'chunk-dense',
    documentId: 'doc-1',
    documentTitle: '密集材料',
    content: `${'甲产品属于材料分类。'.repeat(45)}\n${'乙产品属于材料分类。'.repeat(45)}`,
  };
  const calls: Array<{ id: string; chars: number }> = [];
  const result = await extractOntologyCandidateBatches([denseChunk], async (batch) => {
    const chunk = batch[0]!;
    calls.push({ id: chunk.id, chars: chunk.content.length });
    if (chunk.content.length > 700) return '{"nodes":[';
    const quote = chunk.content.slice(0, Math.min(12, chunk.content.length));
    return JSON.stringify({
      nodes: [{ id: `entity_${calls.length}`, type: 'concept', name: `实体${calls.length}`, evidence: { chunkId: chunk.id, quote } }],
      edges: [],
    });
  });
  assert.equal(calls.length > 1, true);
  assert.equal(calls.every((call) => call.id === denseChunk.id), true);
  assert.equal(result.length > 1, true);
  assert.equal(result.every((candidate) => candidate.evidence[0]?.chunkId === denseChunk.id), true);
});

test('AI governance normalizer safely completes missing merge command fields', async () => {
  const { normalizeAiGovernanceCommands } = await import('../ontology-extraction.js');
  const graph = { version: 1, nodes: [
    { id: 'a', type: 'Indicator', name: 'shoe_weight', aliases: [], properties: {}, status: 'draft' as const },
    { id: 'b', type: 'Indicator', name: 'indicator_shoe_weight', aliases: [], properties: {}, status: 'draft' as const },
  ], edges: [] };
  const issue = { id: 'duplicate:shoeweight', category: 'duplicate_node' as const, severity: 'warning' as const, title: '重复', description: '', nodeIds: ['a', 'b'], edgeIds: [], suggestedCommands: [] };
  assert.deepEqual(normalizeAiGovernanceCommands([{ type: 'merge_nodes', nodeIds: ['a', 'b'] }], issue, graph), [{ type: 'merge_nodes', nodeIds: ['a', 'b'], canonicalId: 'a', canonicalName: 'shoe_weight' }]);
  assert.deepEqual(normalizeAiGovernanceCommands([{ type: 'rename_node', nodeId: 'a' }], issue, graph), []);
});
