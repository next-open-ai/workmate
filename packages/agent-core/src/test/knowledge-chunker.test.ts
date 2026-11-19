import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkStructuredKnowledge, normalizeKnowledgeText } from '../knowledge-chunker.js';

function verify(input: string) {
  const result = chunkStructuredKnowledge(input, 'Document');
  assert.deepEqual(result, chunkStructuredKnowledge(input, 'Document'));
  assert.equal(result.normalizedText, normalizeKnowledgeText(input));
  let cursor = 0;
  for (const chunk of result.chunks) {
    assert.ok(chunk.end > chunk.start && chunk.content.length <= 1200);
    assert.equal(chunk.content, result.normalizedText.slice(chunk.start, chunk.end));
    assert.ok(chunk.start >= cursor);
    assert.equal(result.normalizedText.slice(cursor, chunk.start).trim(), '');
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk.content));
    cursor = chunk.end;
    if (chunk.parentIndex !== undefined) {
      const parent = result.parents[chunk.parentIndex];
      assert.ok(parent.start <= chunk.start && chunk.end <= parent.end);
      assert.equal(parent.content.slice(chunk.start - parent.start, chunk.end - parent.start), chunk.content);
    }
  }
  assert.equal(result.normalizedText.slice(cursor).trim(), '');
  for (const parent of result.parents) {
    assert.ok(parent.content.length <= 3600);
    assert.equal(parent.content, result.normalizedText.slice(parent.start, parent.end));
  }
  return result;
}

test('KE-C01: preserves bounded headings, paragraphs, lists, tables and fenced code with exact offsets', () => {
  const table = '| 项目 | 金额 |\n| --- | --- |\n| 交通 | 100 |';
  const code = '```md\n# Not a heading\n\nvalue = 1\n```';
  const source = `# 制度\r\n\r\n${'说明。'.repeat(240)}\r\n\r\n## 报销\r\n\r\n- 提交发票\r\n- 审批通过\r\n\r\n${table}\n\n${code}\n\n结尾`;
  const result = verify(source);
  assert.ok(result.chunks.some((chunk) => chunk.content.includes(table)));
  assert.ok(result.chunks.some((chunk) => chunk.content.includes(code)));
  assert.ok(result.chunks.some((chunk) => chunk.content.includes('- 提交发票\n- 审批通过')));
  assert.deepEqual(result.chunks.at(-1)!.headingPath, ['制度', '报销']);
  assert.ok(result.chunks.every((chunk) => !chunk.headingPath.includes('Not a heading')));
  assert.deepEqual(verify(code + '\n\n# After\n\n正文').chunks.at(-1)!.headingPath, ['After']);
  assert.equal(verify('短文').parents.length, 0);
  assert.deepEqual(verify('  \r\n ').chunks, []);
});

test('KE-C01: long structures, repeats, emoji and oversized lines remain bounded and lossless', () => {
  const sources = [
    '😀'.repeat(2500),
    '# Long\n\n' + ('a'.repeat(1198) + '😀').repeat(5),
    '# List\n\n' + '- repeated item 内容\n'.repeat(300),
    '| A | B |\n| --- | --- |\n' + '| repeated | value |\n'.repeat(300),
    '~~~text\n' + 'data\n'.repeat(1000) + '~~~',
    '```text\n' + '\n'.repeat(5000) + 'value\n```',
    'Heading\n=======\n\n' + ('重复段落。'.repeat(90) + '\n\n').repeat(20),
    '# A\n\nfirst\n\n## B\n\nsecond\n\n# C\n\nthird',
  ];
  for (const source of sources) verify(source);
  const result = verify(sources[6]);
  assert.ok(result.parents.length > 1);
  assert.deepEqual(result.chunks[0].headingPath, ['Heading']);
  assert.ok(new Set(result.chunks.map((chunk) => chunk.start)).size === result.chunks.length);
});
