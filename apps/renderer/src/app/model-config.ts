import { computed, ref } from 'vue';
import { getServerModelConfig, saveServerModelConfig } from '../services/api.js';

export const providerIds = ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'ollama', 'openai-compatible'] as const;
export type ProviderId = (typeof providerIds)[number];
export type ModelCapability = 'chat' | 'image' | 'embedding' | 'asr' | 'tts';

export const modelCapabilities: ModelCapability[] = ['chat', 'image', 'embedding', 'asr', 'tts'];

/** Connection instance — same provider type can appear multiple times. */
export interface ProviderInstance {
  id: string;
  type: ProviderId;
  name: string;
  baseUrl: string;
  apiKey: string;
  disableThinking: boolean;
}

/** User-registered model that appears in pickers across the app. */
export interface ConfiguredModel {
  id: string;
  providerInstanceId: string;
  capability: ModelCapability;
  modelId: string;
  label?: string;
  /**
   * Chat models that support provider-native web search (e.g. Bailian/Qwen `enable_search`).
   * Only meaningful for qwen / openai-compatible connections.
   */
  supportsBuiltinWebSearch?: boolean;
}

/**
 * Runtime payload for chat / agent calls.
 * `id` is the configured-model id used by pickers; connection fields come from the provider instance.
 */
export interface ProviderConfig {
  id: string;
  providerInstanceId: string;
  providerLabel: string;
  provider: ProviderId;
  baseUrl: string;
  chatModel: string;
  chatModels: string[];
  disableThinking: boolean;
  /** Capability flag from configured model registry. */
  supportsBuiltinWebSearch: boolean;
  imageModel: string;
  embeddingModel: string;
  asrModel: string;
  ttsModel: string;
  apiKey: string;
}

export interface ModelSettings {
  version: 2;
  providerInstances: ProviderInstance[];
  models: ConfiguredModel[];
  /** Default chat model for the main workspace selector. */
  activeChatModelId: string | null;
  /**
   * System-wide embedding / vector model for experience memory, local knowledge,
   * and other tools that need embeddings. Unset ⇒ vector features are not ready.
   */
  activeEmbeddingModelId: string | null;
  /** Per digital-employee default when acting as sub-agent / collaborator. */
  employeeDefaultModelIds: Record<string, string>;
}

export const providerSuggestedChatModels: Partial<Record<ProviderId, string[]>> = {
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'o3-mini', 'gpt-4o'],
  anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'],
  qwen: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen3.5:4b'],
  ollama: ['llama3.2', 'qwen2.5', 'deepseek-r1', 'mistral'],
  'openai-compatible': [],
};

export const providerSuggestedByCapability: Partial<Record<ProviderId, Partial<Record<ModelCapability, string[]>>>> = {
  openai: {
    chat: providerSuggestedChatModels.openai,
    image: ['gpt-image-1', 'dall-e-3'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    asr: ['gpt-4o-mini-transcribe', 'whisper-1'],
    tts: ['gpt-4o-mini-tts', 'tts-1'],
  },
  anthropic: { chat: providerSuggestedChatModels.anthropic },
  google: {
    chat: providerSuggestedChatModels.google,
    image: ['gemini-2.5-flash-image'],
    embedding: ['text-embedding-004'],
  },
  deepseek: { chat: providerSuggestedChatModels.deepseek },
  qwen: { chat: providerSuggestedChatModels.qwen },
  ollama: { chat: providerSuggestedChatModels.ollama },
  'openai-compatible': { chat: [] },
};

export const defaultBaseUrl: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  'openai-compatible': '',
};

/** @deprecated kept for migration helpers */
export const providerDefaults: Record<ProviderId, Omit<ProviderConfig, 'apiKey' | 'id' | 'providerInstanceId' | 'providerLabel'>> = {
  openai: { provider: 'openai', baseUrl: defaultBaseUrl.openai, chatModel: 'gpt-4.1-mini', chatModels: ['gpt-4.1-mini'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: 'gpt-image-1', embeddingModel: 'text-embedding-3-small', asrModel: 'gpt-4o-mini-transcribe', ttsModel: 'gpt-4o-mini-tts' },
  anthropic: { provider: 'anthropic', baseUrl: '', chatModel: 'claude-sonnet-4-5', chatModels: ['claude-sonnet-4-5'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  google: { provider: 'google', baseUrl: '', chatModel: 'gemini-2.5-flash', chatModels: ['gemini-2.5-flash'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: 'gemini-2.5-flash-image', embeddingModel: 'text-embedding-004', asrModel: '', ttsModel: '' },
  deepseek: { provider: 'deepseek', baseUrl: defaultBaseUrl.deepseek, chatModel: 'deepseek-chat', chatModels: ['deepseek-chat'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  qwen: { provider: 'qwen', baseUrl: defaultBaseUrl.qwen, chatModel: 'qwen-plus', chatModels: ['qwen-plus'], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  ollama: { provider: 'ollama', baseUrl: defaultBaseUrl.ollama, chatModel: 'llama3.2', chatModels: [], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  'openai-compatible': { provider: 'openai-compatible', baseUrl: '', chatModel: '', chatModels: [], disableThinking: false, supportsBuiltinWebSearch: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
};

export const ollamaLibraryCatalog = [
  'llama3.2', 'llama3.1', 'qwen2.5', 'qwen2.5:7b', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'gemma2', 'phi3', 'codellama',
];

const settings = ref<ModelSettings>(emptySettings());
const loaded = ref(false);
export const ollamaLocalModelNames = ref<string[]>([]);

function newId() {
  return crypto.randomUUID();
}

function emptySettings(): ModelSettings {
  return { version: 2, providerInstances: [], models: [], activeChatModelId: null, activeEmbeddingModelId: null, employeeDefaultModelIds: {} };
}

export function providerCanBuiltinWebSearch(provider: ProviderId) {
  return provider === 'qwen' || provider === 'openai-compatible';
}

export function providerNeedsApiKey(provider: ProviderId) {
  return provider !== 'ollama';
}

export function providerSupportsOpenAiModelList(provider: ProviderId) {
  return provider === 'openai' || provider === 'deepseek' || provider === 'qwen' || provider === 'openai-compatible' || provider === 'ollama';
}

export function uniqueModels(values: string[]) {
  const seen = new Set<string>();
  return values.map((item) => item.trim()).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

export function ollamaModelIsLocal(name: string) {
  if (!ollamaLocalModelNames.value.length) return true;
  const base = name.split(':')[0].toLowerCase();
  return ollamaLocalModelNames.value.some((item) => item === name || item.split(':')[0].toLowerCase() === base);
}

export function defaultProviderName(type: ProviderId, existing: ProviderInstance[]) {
  const count = existing.filter((item) => item.type === type).length + 1;
  const labels: Record<ProviderId, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    deepseek: 'DeepSeek',
    qwen: '通义千问',
    ollama: 'Ollama',
    'openai-compatible': '兼容接口',
  };
  return count <= 1 ? labels[type] : `${labels[type]} #${count}`;
}

export function createProviderInstance(type: ProviderId, existing: ProviderInstance[] = []): ProviderInstance {
  return {
    id: newId(),
    type,
    name: defaultProviderName(type, existing),
    baseUrl: defaultBaseUrl[type],
    apiKey: '',
    disableThinking: false,
  };
}

export function providerInstanceReady(instance: ProviderInstance) {
  if (instance.type === 'openai-compatible' && !instance.baseUrl.trim()) return false;
  if (providerNeedsApiKey(instance.type) && !instance.apiKey.trim()) return false;
  if (instance.type === 'ollama' && !instance.baseUrl.trim()) return false;
  if (instance.baseUrl.trim()) {
    try { new URL(instance.baseUrl); } catch { return false; }
  }
  return true;
}

/** Drop models whose provider connection is incomplete (no valid key/URL). */
export function sanitizeModelSettings(value: ModelSettings): ModelSettings {
  const instances = value.providerInstances.filter((item) => item.id);
  const readyIds = new Set(instances.filter((item) => providerInstanceReady(item)).map((item) => item.id));
  const models = value.models.filter((item) => item.modelId.trim() && readyIds.has(item.providerInstanceId));
  let activeChatModelId = value.activeChatModelId;
  if (activeChatModelId && !models.some((item) => item.id === activeChatModelId && item.capability === 'chat')) {
    activeChatModelId = models.find((item) => item.capability === 'chat')?.id ?? null;
  }
  let activeEmbeddingModelId = value.activeEmbeddingModelId ?? null;
  if (activeEmbeddingModelId && !models.some((item) => item.id === activeEmbeddingModelId && item.capability === 'embedding')) {
    activeEmbeddingModelId = models.find((item) => item.capability === 'embedding')?.id ?? null;
  }
  const employeeDefaultModelIds: Record<string, string> = {};
  for (const [employeeId, modelId] of Object.entries(value.employeeDefaultModelIds ?? {})) {
    if (models.some((item) => item.id === modelId && item.capability === 'chat')) employeeDefaultModelIds[employeeId] = modelId;
  }
  return { version: 2, providerInstances: instances, models, activeChatModelId, activeEmbeddingModelId, employeeDefaultModelIds };
}

export function resolveConfiguredModel(model: ConfiguredModel, instances = settings.value.providerInstances): ProviderConfig | undefined {
  const instance = instances.find((item) => item.id === model.providerInstanceId);
  if (!instance || !providerInstanceReady(instance) || !model.modelId.trim()) return undefined;
  return {
    id: model.id,
    providerInstanceId: instance.id,
    providerLabel: instance.name,
    provider: instance.type,
    baseUrl: instance.baseUrl,
    chatModel: model.capability === 'chat' ? model.modelId : '',
    chatModels: model.capability === 'chat' ? [model.modelId] : [],
    disableThinking: instance.disableThinking,
    supportsBuiltinWebSearch: Boolean(model.supportsBuiltinWebSearch) && providerCanBuiltinWebSearch(instance.type),
    imageModel: model.capability === 'image' ? model.modelId : '',
    embeddingModel: model.capability === 'embedding' ? model.modelId : '',
    asrModel: model.capability === 'asr' ? model.modelId : '',
    ttsModel: model.capability === 'tts' ? model.modelId : '',
    apiKey: instance.apiKey,
  };
}

export function chatEndpointLabel(config: ProviderConfig) {
  return `${config.providerLabel} · ${config.chatModel}`;
}

function migrateFromV1(legacy: {
  activeProvider?: ProviderId;
  providers?: Array<{
    provider?: ProviderId;
    baseUrl?: string;
    apiKey?: string;
    chatModel?: string;
    chatModels?: string[];
    disableThinking?: boolean;
    imageModel?: string;
    embeddingModel?: string;
    asrModel?: string;
    ttsModel?: string;
  }>;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): ModelSettings {
  const next = emptySettings();
  const rows = Array.isArray(legacy.providers) ? legacy.providers : [];
  if (!rows.length && (legacy.apiKey || legacy.model)) {
    rows.push({ provider: 'openai', baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, chatModel: legacy.model, chatModels: legacy.model ? [legacy.model] : [] });
  }
  for (const row of rows) {
    const type = providerIds.includes(row.provider as ProviderId) ? (row.provider as ProviderId) : 'openai';
    // Never seed catalog defaults from incomplete connections — only migrate usable providers.
    const draft: ProviderInstance = {
      id: newId(),
      type,
      name: defaultProviderName(type, next.providerInstances),
      baseUrl: row.baseUrl?.trim() || defaultBaseUrl[type],
      apiKey: String(row.apiKey || ''),
      disableThinking: Boolean(row.disableThinking),
    };
    if (!providerInstanceReady(draft)) continue;

    next.providerInstances.push(draft);
    // Only carry over chat models the user actually used — not the full suggestion catalog / optional capability defaults.
    const preferred = row.chatModel?.trim() || '';
    const chatModels = uniqueModels(preferred ? [preferred] : []);
    for (const modelId of chatModels) {
      next.models.push({ id: newId(), providerInstanceId: draft.id, capability: 'chat', modelId });
    }
    if (preferred && !next.activeChatModelId) {
      next.activeChatModelId = next.models.find((item) => item.providerInstanceId === draft.id && item.capability === 'chat' && item.modelId === preferred)?.id ?? null;
    }
  }
  if (!next.activeChatModelId) {
    next.activeChatModelId = next.models.find((item) => item.capability === 'chat')?.id ?? null;
  }
  return sanitizeModelSettings(next);
}

function normalize(value: unknown): ModelSettings {
  const raw = (value ?? {}) as Partial<ModelSettings> & {
    activeProvider?: ProviderId;
    providers?: unknown[];
    version?: number;
  };
  if (raw.version === 2 && Array.isArray(raw.providerInstances) && Array.isArray(raw.models)) {
    const instances = raw.providerInstances
      .map((item) => ({
        id: String(item.id || newId()),
        type: providerIds.includes(item.type) ? item.type : ('openai-compatible' as ProviderId),
        name: String(item.name || '').trim() || defaultProviderName(item.type, []),
        baseUrl: String(item.baseUrl || ''),
        apiKey: String(item.apiKey || ''),
        disableThinking: Boolean(item.disableThinking),
      }))
      .filter((item) => item.id);
    const instanceIds = new Set(instances.map((item) => item.id));
    const models = raw.models
      .map((item) => {
        const instanceType = instances.find((row) => row.id === String(item.providerInstanceId || ''))?.type;
        const supportsBuiltinWebSearch = Boolean(item.supportsBuiltinWebSearch)
          && Boolean(instanceType && providerCanBuiltinWebSearch(instanceType));
        return {
          id: String(item.id || newId()),
          providerInstanceId: String(item.providerInstanceId || ''),
          capability: (modelCapabilities.includes(item.capability) ? item.capability : 'chat') as ModelCapability,
          modelId: String(item.modelId || '').trim(),
          label: item.label ? String(item.label) : undefined,
          supportsBuiltinWebSearch: supportsBuiltinWebSearch || undefined,
        };
      })
      .filter((item) => item.id && item.modelId && instanceIds.has(item.providerInstanceId));
    return sanitizeModelSettings({
      version: 2,
      providerInstances: instances,
      models,
      activeChatModelId: raw.activeChatModelId ? String(raw.activeChatModelId) : null,
      activeEmbeddingModelId: raw.activeEmbeddingModelId ? String(raw.activeEmbeddingModelId) : null,
      employeeDefaultModelIds: (raw.employeeDefaultModelIds ?? {}) as Record<string, string>,
    });
  }
  return migrateFromV1(raw as Parameters<typeof migrateFromV1>[0]);
}

async function load() {
  if (loaded.value) return;
  const stored = window.workmateDesktop ? await window.workmateDesktop.getModelConfig() : await getServerModelConfig();
  const before = JSON.stringify(stored ?? {});
  const next = normalize(stored);
  settings.value = next;
  loaded.value = true;
  const after = JSON.stringify(next);
  // Persist only when migration/pruning removed invalid catalog entries.
  if (before !== after) {
    if (window.workmateDesktop) {
      try { await window.workmateDesktop.saveModelConfig(next); } catch { /* ignore */ }
    } else {
      try { await saveServerModelConfig(next); } catch { /* ignore */ }
    }
  }
}

export function apiKeyForRequest(config: ProviderConfig) {
  if (config.provider === 'ollama') return config.apiKey.trim() || 'ollama';
  return config.apiKey;
}

/** Resolve the system-wide embedding / vector model from Settings. */
export function resolveActiveEmbeddingConfig(settingsValue = settings.value): {
  modelId: string;
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  configuredModelId: string;
} | null {
  const id = settingsValue.activeEmbeddingModelId;
  if (!id) return null;
  const model = settingsValue.models.find((item) => item.id === id && item.capability === 'embedding');
  if (!model) return null;
  const resolved = resolveConfiguredModel(model, settingsValue.providerInstances);
  if (!resolved?.embeddingModel.trim()) return null;
  return {
    modelId: resolved.embeddingModel,
    provider: resolved.provider,
    baseUrl: resolved.baseUrl,
    apiKey: apiKeyForRequest(resolved),
    configuredModelId: model.id,
  };
}

/** Whether system vector features (experience / local KB embed) are ready. */
export function isSystemEmbeddingReady(settingsValue = settings.value) {
  return Boolean(resolveActiveEmbeddingConfig(settingsValue));
}

export function toModelPayload(config: ProviderConfig, options?: { enableSearch?: boolean }) {
  const embed = resolveActiveEmbeddingConfig();
  return {
    provider: config.provider,
    chatModel: config.chatModel,
    apiKey: apiKeyForRequest(config),
    baseUrl: config.baseUrl || undefined,
    providerLabel: config.providerLabel || undefined,
    disableThinking: config.disableThinking || undefined,
    enableSearch: Boolean(options?.enableSearch) && config.supportsBuiltinWebSearch,
    imageModel: config.imageModel || undefined,
    embeddingModel: embed?.modelId || config.embeddingModel || undefined,
    ...(embed
      ? {
          embeddingBaseUrl: embed.baseUrl || undefined,
          embeddingApiKey: embed.apiKey || undefined,
        }
      : {}),
    asrModel: config.asrModel || undefined,
    ttsModel: config.ttsModel || undefined,
  };
}

/** @deprecated use resolveConfiguredModel */
export function chatModelList(config: ProviderConfig) {
  return uniqueModels([...(config.chatModels ?? []), config.chatModel]);
}

export function providerConfigured(config: ProviderConfig) {
  if (!config.chatModel.trim()) return false;
  if (!providerNeedsApiKey(config.provider)) return true;
  return Boolean(config.apiKey.trim());
}

export function useModelConfig() {
  const availableChatModels = computed(() =>
    settings.value.models
      .filter((item) => item.capability === 'chat')
      .map((item) => resolveConfiguredModel(item))
      .filter((item): item is ProviderConfig => Boolean(item)),
  );

  const emptyConfig = (): ProviderConfig => ({
    id: '',
    providerInstanceId: '',
    providerLabel: '',
    provider: 'openai',
    baseUrl: '',
    chatModel: '',
    chatModels: [],
    disableThinking: false,
    supportsBuiltinWebSearch: false,
    imageModel: '',
    embeddingModel: '',
    asrModel: '',
    ttsModel: '',
    apiKey: '',
  });

  const activeConfig = computed(() => {
    const byId = availableChatModels.value.find((item) => item.id === settings.value.activeChatModelId);
    return byId ?? availableChatModels.value[0] ?? emptyConfig();
  });

  const configured = computed(() => Boolean(activeConfig.value && providerConfigured(activeConfig.value)));

  const save = async (value: ModelSettings) => {
    const plainSettings = sanitizeModelSettings(JSON.parse(JSON.stringify(normalize(value))) as ModelSettings);
    settings.value = plainSettings;
    if (window.workmateDesktop) await window.workmateDesktop.saveModelConfig(plainSettings);
    else await saveServerModelConfig(plainSettings);
  };

  const selectChatEndpoint = async (token: string) => {
    const model = settings.value.models.find((item) => item.id === token && item.capability === 'chat');
    if (!model) {
      // legacy token provider::chatModel
      const [provider, chatModel] = token.split('::');
      const match = availableChatModels.value.find((item) => item.provider === provider && item.chatModel === chatModel);
      if (!match) return;
      settings.value.activeChatModelId = match.id;
      await save(settings.value);
      return;
    }
    settings.value.activeChatModelId = model.id;
    await save(settings.value);
  };

  const chatEndpointToken = computed(() => activeConfig.value?.id ?? '');

  const modelForProvider = (provider: ProviderId) => availableChatModels.value.find((item) => item.provider === provider);

  const modelById = (modelId: string | null | undefined) => {
    if (!modelId) return undefined;
    const configuredModel = settings.value.models.find((item) => item.id === modelId && item.capability === 'chat');
    return configuredModel ? resolveConfiguredModel(configuredModel) : undefined;
  };

  const modelForEmployee = (employeeId: string, fallback?: ProviderConfig | null) => {
    const preferred = settings.value.employeeDefaultModelIds[employeeId];
    return modelById(preferred) ?? fallback ?? (activeConfig.value.id ? activeConfig.value : undefined);
  };

  const setEmployeeDefaultModel = async (employeeId: string, modelId: string | null) => {
    if (!modelId) delete settings.value.employeeDefaultModelIds[employeeId];
    else settings.value.employeeDefaultModelIds[employeeId] = modelId;
    await save(settings.value);
  };

  return {
    settings,
    activeConfig,
    availableChatModels,
    configured,
    load,
    save,
    selectChatEndpoint,
    chatEndpointToken,
    providerConfigured,
    chatModelList,
    modelForProvider,
    modelById,
    modelForEmployee,
    setEmployeeDefaultModel,
    resolveConfiguredModel,
  };
}
