import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractContextAnchors,
  formatAnchorsBlock,
  formatCommandResultEnvelope,
  sanitizeToolPayloadsInMessages,
  stubWriteArgs,
} from '../context-sanitize.js';

function assistantWith(content: unknown[]) {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'x',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as any;
}

test('sanitize strips thinking blocks from assistant messages', () => {
  const messages = [assistantWith([
    { type: 'thinking', thinking: 'long private chain of thought…' },
    { type: 'text', text: 'visible' },
    {
      type: 'toolCall',
      id: '1',
      name: 'write_workspace_file',
      arguments: { path: 'output/a.html', content: 'x'.repeat(500) },
    },
  ])];

  const out = sanitizeToolPayloadsInMessages(messages);
  const content = (out[0] as any).content as Array<{ type: string }>;
  assert.equal(content.some((b) => b.type === 'thinking'), false);
  assert.equal(content.some((b) => b.type === 'text'), true);
});

test('sanitize stubs write bodies to path-only without _omittedBody', () => {
  const big = 'a'.repeat(2_000);
  const messages = [assistantWith([{
    type: 'toolCall',
    id: '1',
    name: 'write_workspace_file',
    arguments: { path: 'output/assets/css/style.css', content: big, mode: 'append' },
  }])];

  const out = sanitizeToolPayloadsInMessages(messages);
  const args = (out[0] as any).content[0].arguments;
  assert.equal(args.path, 'output/assets/css/style.css');
  assert.equal(args.status, 'written');
  assert.equal(args.contextPolicy, 'path-only');
  assert.equal(args.content, undefined);
  assert.equal(args._omittedBody, undefined);
  assert.match(String(args.hint), /do NOT treat as a failed write/i);
  assert.ok(Number(args.bytes) >= 2_000);
});

test('stubWriteArgs always path-only', () => {
  const stub = stubWriteArgs({ path: 'output/x.md', content: 'hi', mode: 'replace', deliverable: true });
  assert.equal(stub.path, 'output/x.md');
  assert.equal(stub.content, undefined);
  assert.equal(stub.chunks, undefined);
});

test('sanitize wraps script tool results as command-result envelopes', () => {
  const payload = JSON.stringify({
    ok: true,
    exitCode: 0,
    stdout: 'hello\n'.repeat(400),
    stderr: 'warn\n'.repeat(50),
    artifacts: ['output/report.pdf'],
  });
  const messages = [{
    role: 'toolResult',
    toolCallId: '1',
    toolName: 'run_workspace_script',
    content: [{ type: 'text', text: payload }],
    isError: false,
    timestamp: Date.now(),
  }] as any;

  const out = sanitizeToolPayloadsInMessages(messages);
  const text = (out[0] as any).content[0].text as string;
  assert.match(text, /\[command-result\]/);
  assert.match(text, /tool: run_workspace_script/);
  assert.match(text, /artifacts: output\/report\.pdf/);
  assert.match(text, /\[\/command-result\]/);
  assert.ok(text.length < payload.length);
});

test('sanitize truncates large read_workspace_file results', () => {
  const messages = [{
    role: 'toolResult',
    toolCallId: '1',
    toolName: 'read_workspace_file',
    content: [{ type: 'text', text: 'x'.repeat(8_000) }],
    isError: false,
    timestamp: Date.now(),
  }] as any;

  const out = sanitizeToolPayloadsInMessages(messages);
  const text = (out[0] as any).content[0].text as string;
  assert.ok(text.length < 8_000);
  assert.match(text, /truncated/);
});

test('extractContextAnchors captures goal paths and errors', () => {
  const messages = [
    { role: 'user', content: '做一个小野鸭射击游戏，交付 index.html', timestamp: Date.now() },
    assistantWith([{
      type: 'toolCall',
      id: '1',
      name: 'write_workspace_file',
      arguments: { path: 'output/index.html', status: 'written', contextPolicy: 'path-only', bytes: 100 },
    }]),
    {
      role: 'toolResult',
      toolCallId: '1',
      toolName: 'run_workspace_script',
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'ModuleNotFoundError: foo' }) }],
      isError: false,
      timestamp: Date.now(),
    },
  ] as any;

  const anchors = extractContextAnchors(messages);
  assert.match(anchors.goal, /小野鸭/);
  assert.ok(anchors.writtenPaths.includes('output/index.html'));
  assert.ok(anchors.errors.some((e) => /ModuleNotFoundError/.test(e)));
  assert.match(formatAnchorsBlock(anchors), /\[context-anchors\]/);
});

test('formatCommandResultEnvelope labels truncated stdout', () => {
  const text = formatCommandResultEnvelope('run_skill_script', JSON.stringify({
    ok: true,
    exitCode: 0,
    stdout: 'A'.repeat(5_000),
    stderr: '',
  }));
  assert.match(text, /\[command-result\]/);
  assert.match(text, /chars omitted/);
  assert.ok(text.length < 5_000);
});
