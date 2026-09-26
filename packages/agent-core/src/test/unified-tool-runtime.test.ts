import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Type, defineAgentTool } from '../pi-tools.js';
import { createUnifiedToolSession, registrationsFromTools } from '../unified-tool-runtime.js';
import { openUnifiedToolMcpBridge } from '../unified-tool-mcp-bridge.js';
import { prepareAgentscopeHostTools } from '../agentscope/host-tools.js';

function echoTool() {
  return defineAgentTool({
    name: 'test_echo',
    description: 'Echo normalized input.',
    parameters: Type.Object({ value: Type.String() }),
    execute: async ({ value }) => ({ ok: true, value }),
  });
}

test('unified tool session exposes one descriptor and normalized result', async () => {
  const session = createUnifiedToolSession(registrationsFromTools([echoTool()]));
  assert.equal(session.descriptors.length, 1);
  assert.equal(session.nativeTools[0]?.name, 'test_echo');
  const result = await session.invoke({ version: 1, invocationId: 'call-1', runId: 'run-1', toolId: 'test_echo', input: { value: 'ok' } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { ok: true, value: 'ok' });
});

test('unified tool session rejects duplicate ids and expired deadlines', async () => {
  assert.throws(() => createUnifiedToolSession(registrationsFromTools([echoTool(), echoTool()])), /Duplicate unified tool id/);
  const session = createUnifiedToolSession(registrationsFromTools([echoTool()]));
  const result = await session.invoke({
    version: 1,
    invocationId: 'call-expired',
    runId: 'run-1',
    toolId: 'test_echo',
    input: { value: 'late' },
    deadlineAt: new Date(Date.now() - 1_000).toISOString(),
  });
  assert.equal(result.status, 'timed-out');
  assert.equal(result.error?.code, 'DEADLINE_EXCEEDED');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await session.invoke({
    version: 1, invocationId: 'call-cancelled', runId: 'run-1', toolId: 'test_echo', input: { value: 'cancelled' },
  }, controller.signal);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error?.code, 'CANCELLED');
});

test('dsh-style MCP transport consumes the same unified session', async () => {
  const session = createUnifiedToolSession(registrationsFromTools([echoTool()]));
  const bridge = await openUnifiedToolMcpBridge({ runId: 'run-dsh', session, name: 'test-tools' });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  assert.notEqual(bridge.connection.transport, 'stdio');
  const transport = new StreamableHTTPClientTransport(new URL((bridge.connection as { url: string }).url));
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((item) => item.name), ['test_echo']);
    const result = await client.callTool({ name: 'test_echo', arguments: { value: 'through-mcp' } }) as { content: Array<{ type: string; text?: string }> };
    const text = result.content.find((item: { type: string }) => item.type === 'text');
    assert.equal(text?.type, 'text');
    assert.deepEqual(JSON.parse(text?.type === 'text' ? String(text.text) : '{}'), { ok: true, value: 'through-mcp' });
  } finally {
    await client.close().catch(() => undefined);
    await bridge.close();
  }
});

test('AgentScope host transport consumes the same application-model backend', async () => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'print("bell")' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  const tools = await prepareAgentscopeHostTools({
    runId: 'run-agentscope',
    mcpConnections: [],
    workspaceAccess: 'write',
    modelCapabilities: [{
      id: 'quantum-model',
      capability: 'quantum-code',
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: '',
      modelId: 'esight',
      mode: 'auto',
    }],
  });
  try {
    assert.equal(tools.runtimePatch.mcpTools?.some((item) => item.name === 'quantum_code_generate'), true);
    const [result] = await tools.executeHostToolCalls('run-agentscope', [{ id: 'call-as', name: 'quantum_code_generate', input: { task: 'Bell state' } }]);
    assert.equal(result?.state, 'success');
    assert.match(result?.output ?? '', /print/);
  } finally {
    await tools.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
