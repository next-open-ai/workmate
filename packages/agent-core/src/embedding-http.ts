type EmbedConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

const TIMEOUT_MESSAGE = 'Embedding provider request timed out.';

function timeout<T>(promise: Promise<T>, ms = 20_000) {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), ms))]);
}

function joinUrl(baseUrl: string, suffix: string) {
  return `${baseUrl.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
}

function parseJsonSafe(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function normalizeVector(input: unknown) {
  if (!Array.isArray(input) || !input.length) throw new Error('Embedding vector missing.');
  const vector = input.map((value) => Number(value));
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding vector contains non-finite values.');
  }
  return vector;
}

export function buildEmbeddingSignature(input: {
  model: string;
  dimension?: number;
  normalize?: boolean;
  chunkPolicyVersion?: string;
}) {
  const model = String(input.model || '').trim() || 'unknown';
  const dim = Number(input.dimension) || 0;
  const normalize = input.normalize ? 1 : 0;
  const chunk = String(input.chunkPolicyVersion || 'v1').trim() || 'v1';
  return `model=${model};dim=${dim};norm=${normalize};chunk=${chunk}`;
}

export async function embedOpenAiCompatible(config: EmbedConfig, inputs: string[], timeoutMs = 20_000): Promise<{
  vectors: number[][];
  model: string;
  dimension: number;
}> {
  if (!config.baseUrl.trim() || !config.model.trim()) {
    throw new Error('Embedding provider is not configured.');
  }
  if (!inputs.length) return { vectors: [], model: config.model, dimension: 0 };
  const response = await timeout(fetch(joinUrl(config.baseUrl, '/embeddings'), {
    method: 'POST',
    headers: {
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: config.model, input: inputs }),
  }), timeoutMs);
  const raw = await response.text();
  const data = parseJsonSafe(raw) as { data?: Array<{ embedding?: unknown }>; model?: unknown; error?: { message?: unknown } } | null;
  if (!response.ok) {
    const detail = data?.error?.message ? String(data.error.message) : raw.slice(0, 160);
    throw new Error(`Embedding provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
  const rows = Array.isArray(data?.data) ? data.data : [];
  if (rows.length !== inputs.length) throw new Error('Embedding response size mismatch.');
  const vectors = rows.map((row) => normalizeVector(row?.embedding));
  const dimension = vectors[0]?.length || 0;
  if (!dimension) throw new Error('Embedding vector missing.');
  if (vectors.some((vector) => vector.length !== dimension)) {
    throw new Error('Embedding vector dimensions are inconsistent.');
  }
  return {
    vectors,
    model: typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : config.model,
    dimension,
  };
}
