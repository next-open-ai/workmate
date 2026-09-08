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
    model: String(value.model || '').trim(),
  };
}

function classifyEmbeddingError(status: number, detail: string) {
  if (status === 401 || status === 403) return { code: 'EMBED_401_UNAUTHORIZED', status: 'unauthorized' as const };
  if (status === 404) return { code: 'EMBED_404_MODEL_NOT_FOUND', status: 'misconfigured' as const };
  if (status === 422 || status === 400) return { code: 'EMBED_422_BAD_INPUT', status: 'misconfigured' as const };
  if (status >= 500) return { code: 'EMBED_503_UNAVAILABLE', status: 'unreachable' as const };
  if (/timeout/i.test(detail)) return { code: 'EMBED_408_TIMEOUT', status: 'unreachable' as const };
  return { code: 'EMBED_424_PROVIDER_INVALID_RESPONSE', status: 'misconfigured' as const };
}

async function readJsonBody(response: Response) {
  const raw = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { raw, parsed };
}

function extractModelsCount(payload: Record<string, unknown> | null) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return rows.length;
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
  if (!apiKey && type !== 'openai-compatible') throw new Error('请填写 API Key');
  const root = baseUrl.replace(/\/$/, '');
  const response = await fetch(`${root}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
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

async function testEmbeddingConnection(value: { type: string; baseUrl: string; apiKey: string; model: string }) {
  const startedAt = Date.now();
  const baseUrl = value.baseUrl.replace(/\/$/, '');
  const apiKey = value.apiKey.trim();
  const model = value.model.trim();
  if (!baseUrl) throw new Error('请填写 embedding API 地址');
  if (!model) throw new Error('请填写 embedding 模型 ID');
  const detail: Record<string, number> = {};
  let healthOk = false;
  try {
    const health = await fetch(`${baseUrl}/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    detail.healthHttpStatus = health.status;
    healthOk = health.ok;
  } catch {
    // optional health endpoint
  }

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: ['health check'] }),
      signal: AbortSignal.timeout(12_000),
    });
    detail.embedHttpStatus = response.status;
    const { raw, parsed } = await readJsonBody(response);
    if (!response.ok) {
      const message = String((parsed?.error as { message?: unknown } | undefined)?.message || parsed?.message || raw.slice(0, 160) || `HTTP ${response.status}`);
      const classified = classifyEmbeddingError(response.status, message);
      return {
        ok: false as const,
        status: classified.status,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        modelReachable: false,
        message,
        code: classified.code,
        detail,
      };
    }
    const rows = Array.isArray(parsed?.data) ? parsed.data : [];
    if (rows.length !== 1) {
      return {
        ok: false as const,
        status: 'misconfigured' as const,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        modelReachable: false,
        message: 'Embedding 响应数量异常。',
        code: 'EMBED_424_PROVIDER_INVALID_RESPONSE',
        detail,
      };
    }
    const vector = Array.isArray((rows[0] as { embedding?: unknown }).embedding)
      ? ((rows[0] as { embedding?: unknown[] }).embedding ?? []).map((item) => Number(item))
      : [];
    if (!vector.length || vector.some((item) => !Number.isFinite(item))) {
      return {
        ok: false as const,
        status: 'misconfigured' as const,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        modelReachable: false,
        message: 'Embedding 向量格式非法。',
        code: 'EMBED_424_PROVIDER_INVALID_RESPONSE',
        detail,
      };
    }
    return {
      ok: true as const,
      status: healthOk ? 'healthy' as const : 'degraded' as const,
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      modelReachable: true,
      message: `Embedding 可用，返回 ${vector.length} 维向量。`,
      code: null,
      detail: { ...detail, dimension: vector.length },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyEmbeddingError(408, message);
    return {
      ok: false as const,
      status: classified.status,
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      modelReachable: false,
      message,
      code: /timed out/i.test(message) ? 'EMBED_408_TIMEOUT' : 'EMBED_503_UNAVAILABLE',
      detail,
    };
  }
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

  app.post('/providers/test-embedding', async (request, reply) => {
    try {
      const result = await testEmbeddingConnection(providerInput(request.body));
      return reply.code(result.ok ? 200 : 400).send(result);
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
