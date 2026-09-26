import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenUsageFromCapability } from '../pi-runtime.js';

test('AMC-UX-USAGE-001 normalizes Pi and OpenAI-compatible capability usage', () => {
  assert.deepEqual(tokenUsageFromCapability({ input: 11, output: 7, cacheRead: 3, totalTokens: 18 }), {
    inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, totalTokens: 18,
  });
  assert.deepEqual(tokenUsageFromCapability({ prompt_tokens: 20, completion_tokens: 6, total_tokens: 26, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } }), {
    inputTokens: 20, outputTokens: 6, cacheReadTokens: 4, reasoningTokens: 2, totalTokens: 26,
  });
  assert.equal(tokenUsageFromCapability(null), null);
  assert.equal(tokenUsageFromCapability({ prompt_tokens: 0, completion_tokens: 0 }), null);
});
