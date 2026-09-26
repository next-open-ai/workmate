import assert from 'node:assert/strict';
import { createServer } from '../apps/renderer/node_modules/vite/dist/node/index.js';

const vite = await createServer({ root: 'apps/renderer', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { resolveAssistantTiming, shouldPollServerMirror } = await vite.ssrLoadModule('/src/app/chat-run-timing.ts');

  assert.deepEqual(
    resolveAssistantTiming({ startedAt: 100, elapsedMs: 80 }, { startedAt: 200, finishedAt: 500 }, 300),
    { startedAt: 100, elapsedMs: 80 },
    'existing local timing must survive hydration',
  );
  assert.deepEqual(
    resolveAssistantTiming(undefined, { startedAt: 1_000, finishedAt: 6_500 }, 2_000),
    { startedAt: 1_000, elapsedMs: 5_500 },
    'durable run timing must restore after remount',
  );
  assert.deepEqual(
    resolveAssistantTiming(undefined, undefined, 3_000),
    { startedAt: 3_000 },
    'server message creation is the final fallback, never component mount time',
  );
  assert.equal(shouldPollServerMirror('session-1', false), false);
  assert.equal(shouldPollServerMirror('session-1', true), true);
  assert.equal(shouldPollServerMirror(undefined, true), false);
  console.log('VIS-M2-T4 PASS: durable timing restoration and opt-in mobile mirror polling.');
} finally {
  await vite.close();
}
