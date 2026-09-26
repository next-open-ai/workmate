import assert from 'node:assert/strict';
import {
  AgentEventSchema,
  AgentCapabilityAssignmentSchema,
  CapabilityBindingSchema,
  ChatRequestSchema,
  ModelCapabilitySchema,
  QuantumExecutionModeSchema,
  QuantumIsolationLevelSchema,
  UnifiedToolDescriptorSchema,
  UnifiedToolInvocationSchema,
  UnifiedToolResultSchema,
} from '../packages/contracts/dist/index.js';

assert.equal(ModelCapabilitySchema.parse('quantum-code'), 'quantum-code');
assert.equal(AgentCapabilityAssignmentSchema.parse({
  agentId: 'code',
  capability: 'quantum-code',
  updatedAt: '2026-09-23T00:00:00.000Z',
}).mode, 'disabled');
assert.deepEqual(CapabilityBindingSchema.parse({
  capability: 'quantum-code',
  modelId: 'esight-model',
  updatedAt: '2026-09-23T00:00:00.000Z',
}), {
  capability: 'quantum-code',
  modelId: 'esight-model',
  enabled: true,
  updatedAt: '2026-09-23T00:00:00.000Z',
});
assert.equal(QuantumExecutionModeSchema.safeParse('host-process').success, false);
assert.equal(QuantumExecutionModeSchema.parse('workspace-isolation'), 'workspace-isolation');
assert.equal(QuantumIsolationLevelSchema.parse('workspace-only'), 'workspace-only');
assert.equal(ChatRequestSchema.safeParse({
  profile: { id: 'agent-1', name: 'Agent', instructions: '', toolIds: [] },
  messages: [{ role: 'user', content: 'generate an image' }],
  model: { provider: 'openai-compatible', chatModel: 'controller-model', apiKey: 'test-key' },
  modelCapabilities: [{
    id: 'image-default',
    capability: 'image',
    provider: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1',
    apiKey: 'test-key',
    modelId: 'image-model',
    mode: 'auto',
  }],
}).success, true);
for (const event of [
  { type: 'capability.started', runId: 'run-1', capability: 'image', modelId: 'image-model', summary: 'Generating image' },
  { type: 'capability.completed', runId: 'run-1', capability: 'image', modelId: 'image-model', summary: 'Image generated', ok: true },
  { type: 'capability.failed', runId: 'run-1', capability: 'image', modelId: 'image-model', summary: 'Generation failed' },
]) {
  assert.equal(AgentEventSchema.safeParse(event).success, true);
}
assert.equal(UnifiedToolDescriptorSchema.safeParse({
  id: 'model_generate_image', name: 'model_generate_image', description: 'Generate image',
  inputSchema: { type: 'object' }, category: 'model-capability', capability: 'image',
}).success, true);
assert.equal(UnifiedToolInvocationSchema.safeParse({
  version: 1, invocationId: 'call-1', runId: 'run-1', toolId: 'model_generate_image', input: { prompt: 'test' },
}).success, true);
assert.equal(UnifiedToolResultSchema.safeParse({
  version: 1, invocationId: 'call-1', toolId: 'model_generate_image', status: 'succeeded', output: { path: 'output/test.png' },
  startedAt: '2026-09-24T00:00:00.000Z', completedAt: '2026-09-24T00:00:01.000Z',
}).success, true);

console.log('eSight capability contract regression checks passed');
