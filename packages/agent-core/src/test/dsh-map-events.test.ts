import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDshEventMapContext, mapDshSessionEvent } from '../dsh/map-events.js';

test('mapDshSessionEvent correlates tool/result name via callId', () => {
  const ctx = createDshEventMapContext();
  const started = mapDshSessionEvent('run-1', {
    type: 'tool/call',
    data: {
      callId: 'call_abc',
      name: 'mcp__mcp-baseline-akshare__get_index_history',
      arguments: '{"symbol":"000001"}',
    },
  }, ctx);
  assert.equal(started[0]?.type, 'tool.started');
  assert.equal(started[0] && 'toolName' in started[0] ? started[0].toolName : '', 'mcp__mcp-baseline-akshare__get_index_history');

  const completed = mapDshSessionEvent('run-1', {
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId: 'call_abc' },
        content: [{ type: 'tool-result', toolCallId: 'call_abc', isError: false, content: [{ type: 'text', text: 'ok' }] }],
        role: 'user',
      },
    },
  }, ctx);

  assert.equal(completed[0]?.type, 'tool.completed');
  assert.equal(completed[0] && 'toolName' in completed[0] ? completed[0].toolName : '', 'mcp__mcp-baseline-akshare__get_index_history');
  assert.equal(ctx.toolNamesByCallId.size, 0);
});

test('mapDshSessionEvent marks isError tool results as failed', () => {
  const ctx = createDshEventMapContext();
  mapDshSessionEvent('run-1', {
    type: 'tool/call',
    data: { callId: 'c1', name: 'bash', arguments: '{}' },
  }, ctx);
  const failed = mapDshSessionEvent('run-1', {
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }] }],
      },
    },
  }, ctx);
  assert.equal(failed[0]?.type, 'tool.failed');
  assert.equal(failed[0] && 'toolName' in failed[0] ? failed[0].toolName : '', 'bash');
});
