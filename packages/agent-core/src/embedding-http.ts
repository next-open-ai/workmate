type EmbedConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxBatch?: number;
  maxInputChars?: number;
};

const TIMEOUT_MESSAGE = 'Embedding provider request timed out.';
const learnedBatchLimits = new Map<string, number>();

async function timeout<T>(promise: Promise<T>, ms = 20_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

type EmbeddingResult = {
  vectors: number[][];
  model: string;
  dimension: number;
};

function batchLimitFromError(error: unknown, currentSize: number): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/(batch\s*size|too many inputs|input(?:s|\.contents).*(?:limit|larger|maximum|max))/i.test(message)) return null;
  if (currentSize <= 1) return null;
  const explicit = message.match(/(?:not\s+be|no)\s+larger\s+than\s+(\d+)/i)
    || message.match(/(?:maximum|max(?:imum)?\s+batch(?:\s+size)?|batch(?:\s+size)?\s+limit)\D{0,20}(\d+)/i);
  if (explicit?.[1]) return Math.max(1, Math.min(currentSize - 1, Number(explicit[1])));
  return currentSize > 1 ? Math.max(1, Math.floor(currentSize / 2)) : null;
}

async function embedBatch(config: EmbedConfig, inputs: string[], timeoutMs: number): Promise<EmbeddingResult> {
  if (!config.baseUrl.trim() || !config.model.trim()) {
    throw new Error('Embedding provider is not configured.');
  }
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

export async function embedOpenAiCompatible(config: EmbedConfig, inputs: string[], timeoutMs = 20_000): Promise<EmbeddingResult> {
  if (!config.baseUrl.trim() || !config.model.trim()) throw new Error('Embedding provider is not configured.');
  if (!inputs.length) return { vectors: [], model: config.model, dimension: 0 };
  const maxInputChars = Math.max(1, Math.min(1_000_000, Number(config.maxInputChars) || 1_000_000));
  const prepared = inputs.map((input) => String(input).slice(0, maxInputChars));
  const providerKey = `${config.baseUrl.replace(/\/$/, '')}\n${config.model}`;
  const configuredBatch = Math.max(1, Math.min(256, Math.floor(Number(config.maxBatch) || prepared.length)));
  let batchSize = Math.min(configuredBatch, learnedBatchLimits.get(providerKey) || configuredBatch);
  const vectors: number[][] = [];
  let resolvedModel = config.model;
  let dimension = 0;
  for (let offset = 0; offset < prepared.length;) {
    const current = prepared.slice(offset, offset + batchSize);
    try {
      const result = await embedBatch(config, current, timeoutMs);
      resolvedModel = result.model;
      if (dimension && result.dimension !== dimension) throw new Error('Embedding vector dimensions changed between batches.');
      dimension = result.dimension;
      vectors.push(...result.vectors);
      offset += current.length;
    } catch (error) {
      const reduced = batchLimitFromError(error, current.length);
      if (!reduced) throw error;
      batchSize = reduced;
      learnedBatchLimits.set(providerKey, reduced);
    }
  }
  return { vectors, model: resolvedModel, dimension };
}
