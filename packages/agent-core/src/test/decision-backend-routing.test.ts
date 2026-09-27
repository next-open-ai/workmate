import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresDecisionGuardCompatibleBackend } from '../stream-reply.js';

const baseDecisionRuntime = {
  enabled: true,
  mode: 'enforce' as const,
  provider: 'jev',
  protocol: 'system-one-v1' as const,
  baseUrl: 'https://decision.example.test/v1',
  model: 'jev-latest',
  timeoutMs: 1500,
  failurePolicy: 'allow' as const,
  guardTools: true,
  agentTool: true,
  mcpEnabled: false,
};

test('only enforce mode with the tool guard requires complete backend coverage', () => {
  assert.equal(requiresDecisionGuardCompatibleBackend({ decisionRuntime: baseDecisionRuntime }), true);
  assert.equal(requiresDecisionGuardCompatibleBackend({
    decisionRuntime: { ...baseDecisionRuntime, enabled: false },
  }), false);
  assert.equal(requiresDecisionGuardCompatibleBackend({
    decisionRuntime: { ...baseDecisionRuntime, mode: 'observe' },
  }), false);
  assert.equal(requiresDecisionGuardCompatibleBackend({
    decisionRuntime: { ...baseDecisionRuntime, guardTools: false },
  }), false);
});
