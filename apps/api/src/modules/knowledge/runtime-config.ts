import fs from 'node:fs';
import path from 'node:path';
import { getSecrets } from '../orchestration/secrets.js';

const rec = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown) => Array.isArray(value) ? value.map(rec) : [];
function read(file: string) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }

/** Resolve only trusted server defaults; request-supplied locations/credentials are never merged. */
export function hydrateKnowledgeRuntime(root: string, userId: string, input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  const providers = read(path.join(root, 'knowledge-providers.json'));
  let provider = rows(rec(providers.meta ?? providers).providers).find((row) => row.id === input.provider) ?? {};
  provider = { ...provider, ...rec(rec(rec(providers.secrets).providers)[String(input.provider)]) };
  if (!Object.keys(provider).length) {
    const kv = rec(read(path.join(root, 'domain.json')).kv);
    const raw = kv[`user:${userId}:settings.knowledge-providers`] ?? kv['settings.knowledge-providers'];
    const settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
    provider = rows(rec(settings).providers).find((row) => row.id === input.provider) ?? {};
  }
  for (const [key, fallback] of Object.entries({ baseUrl: 'defaultBaseUrl', apiKey: 'defaultApiKey', workspaceId: 'defaultWorkspaceId',
    accessKeyId: 'defaultAccessKeyId', accessKeySecret: 'defaultAccessKeySecret' })) {
    if (!result[key] && provider[fallback]) result[key] = provider[fallback];
  }
  if (input.embeddingMode === 'system' || input.embeddingMode === 'model') {
    const disk = read(path.join(root, 'model-settings.json'));
    const model = rec(getSecrets().model ?? disk.meta ?? disk);
    const id = input.embeddingMode === 'model' ? input.embeddingModelConfigId : model.activeEmbeddingModelId;
    const selected = rows(model.models).find((row) => row.id === id && row.capability === 'embedding');
    const instance = rows(model.providerInstances).find((row) => row.id === selected?.providerInstanceId);
    if (selected && instance) {
      result.embeddingBaseUrl = instance.baseUrl || input.embeddingBaseUrl;
      result.embeddingApiKey = instance.apiKey || rec(rec(rec(disk.secrets).providerInstances)[String(instance.id)]).apiKey
        || (instance.type === 'ollama' ? 'ollama' : input.embeddingApiKey);
      result.embeddingModel = selected.modelId;
      result.embeddingMeta = selected.meta ?? input.embeddingMeta;
    }
  }
  return result;
}
