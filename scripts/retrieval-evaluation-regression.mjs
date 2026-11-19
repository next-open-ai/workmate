import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvaluation, evaluateRetrieval, evaluationHtml, MAX_EVALUATION_BYTES } from '../apps/renderer/src/features/knowledge/retrieval-evaluation.ts';

const fixture = () => ({ version: 1, knowledgeBaseId: 'kb', snapshot: 'fixture-v1', topK: 3,
  cases: [{ id: 'q1', query: '问题', relevantGroups: [['chunk:a', 'wiki:a'], ['chunk:b']], runs: [
    { variant: '基线', hits: [{ id: 'chunk:x', title: '无关' }, { id: 'wiki:a', title: '同证据' }, { id: 'chunk:a', title: '重复证据' }], elapsedMs: 20 },
    { variant: 'Wiki', hits: [{ id: 'wiki:a', title: '同证据' }, { id: 'chunk:b', title: '新证据' }], elapsedMs: 40 },
  ] }] });
test('KEV-TEST-01: hand-calculated ranks, evidence groups and no double credit', () => {
  const data = parseEvaluation(JSON.stringify(fixture()), 'kb');
  const report = evaluateRetrieval(data), first = report.summaries[0];
  assert.equal(first.hit, 1); assert.equal(first.recall, .5); assert.equal(first.mrr, .5);
  assert.equal(first.precision, 1 / 3);
  assert.ok(Math.abs(first.ndcg - (1 / Math.log2(3)) / (1 + 1 / Math.log2(3))) < 1e-10);
  assert.equal(report.summaries[1].recall, 1); assert.equal(report.summaries[1].ndcg, 1);
  assert.equal(first.p95Ms, 20);
});
test('KEV-TEST-01: no-answer queries excluded from answerable denominator; missing timings not fabricated', () => {
  const data = fixture(); data.cases[0].relevantGroups = [];
  data.cases[0].runs[0].hits = []; delete data.cases[0].runs[0].elapsedMs;
  const report = evaluateRetrieval(parseEvaluation(JSON.stringify(data), 'kb'));
  assert.equal(report.summaries[0].recall, null); assert.equal(report.summaries[0].mrr, null);
  assert.equal(report.summaries[0].emptyCorrect, 1); assert.equal(report.summaries[1].emptyCorrect, 0);
  assert.equal(report.summaries[0].p95Ms, null); assert.equal(report.summaries[0].timingCount, 0);
});
test('KEV-TEST-01: unlabeled, malformed, wrong KB and oversized inputs rejected', () => {
  const data = fixture(); data.cases[0].relevantGroups = null;
  assert.throws(() => parseEvaluation(JSON.stringify(data), 'kb'), /未标注/);
  assert.throws(() => evaluateRetrieval(data), /完整标注/);
  assert.throws(() => parseEvaluation('{', 'kb'), /JSON/);
  assert.throws(() => parseEvaluation(JSON.stringify(fixture()), 'other'), /当前知识库/);
  assert.throws(() => parseEvaluation(' '.repeat(MAX_EVALUATION_BYTES + 1), 'kb'), /2 MB/);
});
test('KEV-TEST-01: duplicate samples/groups/variants and unmatched comparison coverage rejected', () => {
  for (const mutate of [d => d.cases.push(d.cases[0]), d => d.cases[0].relevantGroups.push(['chunk:a']),
    d => d.cases[0].runs.push(d.cases[0].runs[0]),
    d => d.cases.push({ ...d.cases[0], id: 'q2', runs: [d.cases[0].runs[0]] }),
    d => { d.topK = 21; }, d => { d.version = 2; }, d => { d.cases = []; }]) {
    const data = fixture(); mutate(data);
    assert.throws(() => parseEvaluation(JSON.stringify(data), 'kb'), /格式/);
  }
});
test('KEV-TEST-01: exported HTML escapes untrusted content and disables network/script', () => {
  const data = fixture(); data.snapshot = '<img src=x onerror=alert(1)>'; data.cases[0].query = '</td><script>alert(1)</script>';
  const html = evaluationHtml(data, evaluateRetrieval(data));
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes("default-src 'none'"));
});
test('KEV-TEST-01: only topK evaluated, duplicate IDs do not shift ranking', () => {
  const data = fixture(); data.topK = 1;
  assert.equal(evaluateRetrieval(data).summaries[0].recall, 0);
  data.topK = 3; data.cases[0].runs[0].hits = [{ id: 'chunk:x', title: '' }, { id: 'chunk:x', title: '' }, { id: 'chunk:b', title: '' }];
  assert.equal(evaluateRetrieval(data).summaries[0].mrr, 1 / 3);
});
