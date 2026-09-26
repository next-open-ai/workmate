import assert from 'node:assert/strict';
import { createServer } from '../apps/renderer/node_modules/vite/dist/node/index.js';

const vite = await createServer({ root: 'apps/renderer', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { applyRecommendedProviderSetup, classifyCapabilityFailure, providerSuggestedByCapability, sanitizeModelSettings, summarizeProviderModelHealth } = await vite.ssrLoadModule('/src/app/model-config.ts');
  const empty = () => ({ version: 3, providerInstances: [], models: [], activeChatModelId: null, activeEmbeddingModelId: null, employeeDefaultModelIds: {}, capabilityBindings: [], agentCapabilityAssignments: [] });
  const qwen = { id: 'qwen-1', type: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test', workspaceId: '', disableThinking: false };
  const first = applyRecommendedProviderSetup(empty(), qwen, ['general']);
  assert.equal(first.manualRequired, false);
  assert.equal(first.addedModels, 6);
  assert.equal(first.settings.models.find((item) => item.capability === 'image')?.modelId, 'wan2.2-t2i-flash');
  assert.equal(first.settings.models.find((item) => item.capability === 'image')?.imageProtocol, 'dashscope-image-async');
  assert.equal(first.settings.models.find((item) => item.capability === 'tts')?.voice, 'longanhuan_v3.1');
  assert.ok(first.settings.capabilityBindings.some((item) => item.capability === 'vision' && item.enabled));
  assert.ok(first.settings.agentCapabilityAssignments.some((item) => item.agentId === 'general' && item.capability === 'asr' && item.mode === 'auto'));
  for (const model of first.settings.models) {
    assert.ok(
      providerSuggestedByCapability.qwen[model.capability].includes(model.modelId),
      `automatic ${model.capability} choice must stay in the versioned common-recommendation catalog`,
    );
  }

  const repeated = applyRecommendedProviderSetup(first.settings, qwen, ['general']);
  assert.equal(repeated.addedModels, 0);
  assert.equal(repeated.settings.models.length, first.settings.models.length);
  assert.equal(repeated.settings.capabilityBindings.length, first.settings.capabilityBindings.length);
  assert.equal(repeated.settings.agentCapabilityAssignments.length, first.settings.agentCapabilityAssignments.length);

  const withWorkspace = applyRecommendedProviderSetup(empty(), { ...qwen, workspaceId: 'llm-test' }, ['general']);
  assert.equal(withWorkspace.settings.models.find((item) => item.capability === 'image')?.modelId, 'qwen-image-3.0');
  assert.equal(withWorkspace.settings.models.find((item) => item.capability === 'image')?.imageProtocol, 'openai-images');
  assert.ok(providerSuggestedByCapability.qwen.image.includes('qwen-image-3.0'));

  const existing = empty();
  existing.providerInstances.push({ id: 'custom', type: 'openai-compatible', name: '已有连接', baseUrl: 'https://example.test/v1', apiKey: 'x', disableThinking: false });
  existing.models.push({ id: 'manual-chat', providerInstanceId: 'custom', capability: 'chat', modelId: 'manual-chat' });
  existing.models.push({ id: 'manual-vision', providerInstanceId: 'custom', capability: 'vision', modelId: 'manual-vision' });
  existing.activeChatModelId = 'manual-chat';
  existing.capabilityBindings.push({ capability: 'vision', modelId: 'manual-vision', enabled: true, updatedAt: '2026-09-25T00:00:00.000Z' });
  const preserved = applyRecommendedProviderSetup(existing, qwen, ['general']);
  assert.equal(preserved.settings.activeChatModelId, 'manual-chat');
  assert.equal(preserved.settings.capabilityBindings.find((item) => item.capability === 'vision')?.modelId, 'manual-vision');
  assert.ok(preserved.preserved.includes('chat') && preserved.preserved.includes('vision'));

  const manual = applyRecommendedProviderSetup(empty(), { id: 'custom', type: 'openai-compatible', name: '私有服务', baseUrl: 'https://example.test/v1', apiKey: '', disableThinking: false }, ['general']);
  assert.equal(manual.manualRequired, true);
  assert.equal(manual.addedModels, 0);
  assert.equal(classifyCapabilityFailure('HTTP 403 forbidden'), 'permission_error');
  assert.equal(classifyCapabilityFailure('HTTP 404 model not found'), 'configuration_error');
  assert.equal(classifyCapabilityFailure('fetch failed ECONNRESET'), 'temporarily_unavailable');
  const withHealth = first.settings;
  withHealth.models[0].health = { status: 'available', checkedAt: '2026-09-25T00:00:00.000Z', summary: 'ok' };
  assert.deepEqual(sanitizeModelSettings(withHealth).models[0].health, withHealth.models[0].health);
  withHealth.models[1].health = { status: 'configuration_error', checkedAt: '2026-09-25T00:00:00.000Z', summary: '404' };
  withHealth.models[2].health = { status: 'available', checkedAt: '2026-07-01T00:00:00.000Z', summary: 'old ok' };
  assert.deepEqual(
    summarizeProviderModelHealth(withHealth.models, qwen.id, Date.parse('2026-09-25T12:00:00.000Z')),
    { total: 6, available: 1, issues: 1, stale: 1, unverified: 3 },
  );
  console.log('AMC-AUTO-CONFIG-001 PASS: recommendation, workspace branch, preservation, idempotency and manual fallback.');
} finally {
  await vite.close();
}
