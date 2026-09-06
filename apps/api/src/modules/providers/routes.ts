import type { FastifyPluginAsync } from 'fastify';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function providerInput(body: unknown) {
  const value = asRecord(body);
  return {
    type: String(value.type || '').trim(),
    baseUrl: String(value.baseUrl || '').trim(),
    apiKey: String(value.apiKey || '').trim(),
  };
}

async function testProviderConnection(value: { type: string; baseUrl: string; apiKey: string }) {
  const { type, baseUrl, apiKey } = value;
  if (type === 'ollama') {
    const root = (baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const payload = await response.json();
    const count = Array.isArray((payload as { models?: unknown[] }).models) ? (payload as { models?: unknown[] }).models!.length : 0;
    return { ok: true as const, message: `已连接 Ollama，发现 ${count} 个本地模型。` };
  }
  if (type === 'anthropic') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const response = await fetch(`${root}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Anthropic 返回 ${response.status}`);
    return { ok: true as const, message: 'Anthropic 连接成功。' };
  }
  if (type === 'google') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const response = await fetch(`${root}/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Google 返回 ${response.status}`);
    return { ok: true as const, message: 'Google 连接成功。' };
  }
  if (!baseUrl) throw new Error('请填写 API 地址');
  if (!apiKey) throw new Error('请填写 API Key');
  const root = baseUrl.replace(/\/$/, '');
  const response = await fetch(`${root}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`接口返回 ${response.status}`);
  const payload = await response.json();
  const count = Array.isArray((payload as { data?: unknown[] }).data) ? (payload as { data?: unknown[] }).data!.length : 0;
  return { ok: true as const, message: count ? `连接成功，接口返回 ${count} 个模型。` : '连接成功。' };
}

async function listProviderModels(value: { type: string; baseUrl: string; apiKey: string }) {
  const { type, baseUrl, apiKey } = value;
  if (type === 'ollama') {
    const root = (baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const payload = await response.json();
    return ((payload as { models?: Array<{ name?: unknown }> }).models ?? []).map((item) => String(item.name || '')).filter(Boolean);
  }
  if (type === 'anthropic') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const response = await fetch(`${root}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Anthropic 返回 ${response.status}`);
    const payload = await response.json();
    return ((payload as { data?: Array<{ id?: unknown }> }).data ?? []).map((item) => String(item.id || '')).filter(Boolean);
  }
  if (type === 'google') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const response = await fetch(`${root}/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Google 返回 ${response.status}`);
    const payload = await response.json();
    return ((payload as { models?: Array<{ name?: unknown }> }).models ?? [])
      .map((item) => String(item.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  if (!baseUrl) throw new Error('请填写 API 地址');
  const root = baseUrl.replace(/\/$/, '');
  const response = await fetch(`${root}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`接口返回 ${response.status}`);
  const payload = await response.json();
  return ((payload as { data?: Array<{ id?: unknown }> }).data ?? []).map((item) => String(item.id || '')).filter(Boolean);
}

async function pullOllamaModel(body: unknown) {
  const value = asRecord(body);
  const root = String(value.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
  const name = String(value.modelName || '').trim();
  if (!name) throw new Error('缺少模型名称');
  const response = await fetch(`${root}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, stream: false }),
    signal: AbortSignal.timeout(900_000),
  });
  if (!response.ok) throw new Error(`Ollama 拉取失败 ${response.status}`);
  const payload = await response.json();
  return { ok: true as const, status: String((payload as { status?: unknown }).status || 'success') };
}

export const providerRoutes: FastifyPluginAsync = async (app) => {
  app.post('/providers/test', async (request, reply) => {
    try {
      return await testProviderConnection(providerInput(request.body));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/providers/models', async (request, reply) => {
    try {
      return { models: await listProviderModels(providerInput(request.body)) };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/providers/ollama/pull', async (request, reply) => {
    try {
      return await pullOllamaModel(request.body);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
};
