import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSessionModelMessages,
  estimateSessionMemoryChars,
  rollSessionMemory,
  shouldRollSessionMemory,
  uncoveredMessages,
} from '../session-memory.js';
import type { ChatSession } from '../types.js';
import { runContext } from './fake.js';

function sessionWith(messages: ChatSession['messages'], memory?: ChatSession['memory']): ChatSession {
  const now = Date.now();
  return {
    id: 's1',
    kind: 'chat',
    title: 't',
    employeeId: 'general',
    messages,
    memory,
    grantsSession: {},
    grantsAlways: {},
    createdAt: now,
    updatedAt: now,
  };
}

test('uncoveredMessages slices after watermark', () => {
  const messages = [
    { id: 'm1', role: 'user' as const, content: 'a', createdAt: 1 },
    { id: 'm2', role: 'assistant' as const, content: 'b', createdAt: 2 },
    { id: 'm3', role: 'user' as const, content: 'c', createdAt: 3 },
  ];
  assert.deepEqual(uncoveredMessages(messages, 'm1').map((m) => m.id), ['m2', 'm3']);
  assert.deepEqual(uncoveredMessages(messages, 'missing').map((m) => m.id), ['m1', 'm2', 'm3']);
});

test('buildSessionModelMessages injects summary pair + uncovered only', () => {
  const session = sessionWith(
    [
      { id: 'm1', role: 'user', content: 'old user', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'old assistant', createdAt: 2 },
      { id: 'm3', role: 'user', content: 'new user', createdAt: 3 },
      { id: 'm4', role: 'assistant', content: 'new assistant', createdAt: 4 },
    ],
    {
      summary: 'Prior goals: ship memory',
      coveredUntilId: 'm2',
      updatedAt: 1,
      dirty: false,
    },
  );
  const modelMessages = buildSessionModelMessages(session);
  assert.equal(modelMessages[0]?.role, 'user');
  assert.match(modelMessages[0]?.content || '', /Workmate context summary/);
  assert.match(modelMessages[0]?.content || '', /Prior goals/);
  assert.equal(modelMessages[1]?.role, 'assistant');
  assert.deepEqual(
    modelMessages.slice(2).map((m) => m.content),
    ['new user', 'new assistant'],
  );
});

test('shouldRollSessionMemory respects budget and force window', () => {
  const short = [{ id: 'a', role: 'user' as const, content: 'hi', createdAt: 1 }];
  assert.equal(shouldRollSessionMemory({ summary: '', uncovered: short }), false);
  const bulky = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'x'.repeat(2_000),
    createdAt: i,
  }));
  assert.equal(shouldRollSessionMemory({ summary: '', uncovered: bulky }), true);
  assert.equal(shouldRollSessionMemory({ summary: '', uncovered: bulky.slice(0, 10), force: true }), true);
  assert.equal(estimateSessionMemoryChars('', bulky) > 24_000, true);
});

test('rollSessionMemory advances watermark with injected summarizer', async () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn-${i} ${'body '.repeat(40)}`,
    createdAt: i,
  }));
  const session = sessionWith(messages);
  const { memory, rolled } = await rollSessionMemory({
    session,
    model: runContext().model,
    force: true,
    summarize: async () => 'Rolled brief about prior turns.',
  });
  assert.equal(rolled, true);
  assert.equal(memory.summary, 'Rolled brief about prior turns.');
  assert.ok(memory.coveredUntilId);
  const remaining = uncoveredMessages(messages, memory.coveredUntilId);
  assert.ok(remaining.length <= 8);
  assert.ok(remaining.length > 0);
});
