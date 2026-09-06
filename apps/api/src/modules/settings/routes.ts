import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { authenticateRequest, requireAuth, requireAdmin, sendAuthError } from '../auth/service.js';

type SettingName =
  | 'model-settings'
  | 'search-settings'
  | 'knowledge-providers'
  | 'knowledge-bases'
  | 'mcp-connections'
  | 'capability-skills'
  | 'capability-policies'
  | 'runtime-settings';

type SettingsEnvelope = {
  meta: unknown;
  secrets?: unknown;
};

function dataDir(): string {
  return process.env.WORKMATE_DATA_DIR || path.join(os.homedir(), '.workmate');
}

function settingsFile(name: SettingName) {
  return path.join(dataDir(), `${name}.json`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map((item) => asRecord(item)) : [];
}

function readJson(name: SettingName) {
  try {
    const file = settingsFile(name);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(name: SettingName, value: unknown) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const file = settingsFile(name);
  fs.writeFileSync(file, JSON.stringify(value ?? {}, null, 2), { mode: 0o600 });
  return value;
}

function isEnvelope(value: unknown): value is SettingsEnvelope {
  const row = asRecord(value);
  return Object.prototype.hasOwnProperty.call(row, 'meta');
}

function splitModelSettings(value: unknown): SettingsEnvelope {
  const raw = asRecord(value);
  const providerInstances = arrayOfRecords(raw.providerInstances).map((provider) => ({
    id: String(provider.id || ''),
    type: String(provider.type || ''),
    name: String(provider.name || ''),
    baseUrl: String(provider.baseUrl || ''),
    disableThinking: Boolean(provider.disableThinking),
  }));
  const providerSecrets = Object.fromEntries(arrayOfRecords(raw.providerInstances)
    .map((provider) => [String(provider.id || ''), { apiKey: String(provider.apiKey || '') }])
    .filter(([id]) => Boolean(id)));
  if (providerInstances.length) {
    return {
      meta: {
        version: Number(raw.version) || 2,
        providerInstances,
        models: Array.isArray(raw.models) ? raw.models : [],
        activeChatModelId: raw.activeChatModelId ? String(raw.activeChatModelId) : null,
        activeEmbeddingModelId: raw.activeEmbeddingModelId ? String(raw.activeEmbeddingModelId) : null,
        employeeDefaultModelIds: asRecord(raw.employeeDefaultModelIds),
      },
      secrets: { providerInstances: providerSecrets },
    };
  }
  const providers = arrayOfRecords(raw.providers).map((provider) => ({
    provider: String(provider.provider || ''),
    baseUrl: String(provider.baseUrl || ''),
    chatModel: String(provider.chatModel || ''),
    chatModels: Array.isArray(provider.chatModels) ? provider.chatModels.map((item) => String(item)) : [],
    disableThinking: Boolean(provider.disableThinking),
    imageModel: String(provider.imageModel || ''),
    embeddingModel: String(provider.embeddingModel || ''),
    asrModel: String(provider.asrModel || ''),
    ttsModel: String(provider.ttsModel || ''),
  }));
  return {
    meta: {
      activeProvider: String(raw.activeProvider || 'openai'),
      providers,
      baseUrl: String(raw.baseUrl || ''),
      model: String(raw.model || ''),
    },
    secrets: {
      providers: Object.fromEntries(arrayOfRecords(raw.providers)
        .map((provider, index) => [String(index), { apiKey: String(provider.apiKey || '') }])),
      apiKey: String(raw.apiKey || ''),
    },
  };
}

function mergeModelSettings(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitModelSettings(value);
  const meta = asRecord(envelope.meta);
  const secrets = asRecord(envelope.secrets);
  if (Array.isArray(meta.providerInstances)) {
    const providerSecrets = asRecord(secrets.providerInstances);
    return {
      version: Number(meta.version) || 2,
      providerInstances: arrayOfRecords(meta.providerInstances).map((provider) => ({
        ...provider,
        apiKey: String(asRecord(providerSecrets[String(provider.id || '')]).apiKey || ''),
      })),
      models: Array.isArray(meta.models) ? meta.models : [],
      activeChatModelId: meta.activeChatModelId ? String(meta.activeChatModelId) : null,
      activeEmbeddingModelId: meta.activeEmbeddingModelId ? String(meta.activeEmbeddingModelId) : null,
      employeeDefaultModelIds: asRecord(meta.employeeDefaultModelIds),
    };
  }
  const providerSecrets = asRecord(secrets.providers);
  return {
    activeProvider: String(meta.activeProvider || 'openai'),
    providers: arrayOfRecords(meta.providers).map((provider, index) => ({
      ...provider,
      apiKey: String(asRecord(providerSecrets[String(index)]).apiKey || ''),
    })),
    baseUrl: String(meta.baseUrl || ''),
    model: String(meta.model || ''),
    apiKey: String(secrets.apiKey || ''),
  };
}

function splitSearchSettings(value: unknown): SettingsEnvelope {
  const raw = asRecord(value);
  const providers = arrayOfRecords(raw.providers);
  return {
    meta: {
      version: Number(raw.version) || 1,
      defaultProvider: String(raw.defaultProvider || 'auto'),
      providers: providers.map((provider) => ({
        id: String(provider.id || ''),
        label: String(provider.label || provider.id || ''),
        baseUrl: String(provider.baseUrl || ''),
        enabled: Boolean(provider.enabled),
      })),
    },
    secrets: {
      providers: Object.fromEntries(providers.map((provider) => [String(provider.id || ''), { apiKey: String(provider.apiKey || '') }])),
    },
  };
}

function mergeSearchSettings(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitSearchSettings(value);
  const meta = asRecord(envelope.meta);
  const secrets = asRecord(envelope.secrets);
  const providerSecrets = asRecord(secrets.providers);
  return {
    version: Number(meta.version) || 1,
    defaultProvider: String(meta.defaultProvider || 'auto'),
    providers: arrayOfRecords(meta.providers).map((provider) => ({
      ...provider,
      apiKey: String(asRecord(providerSecrets[String(provider.id || '')]).apiKey || ''),
    })),
  };
}

function splitKnowledgeProviders(value: unknown): SettingsEnvelope {
  const raw = asRecord(value);
  const providers = arrayOfRecords(raw.providers);
  return {
    meta: {
      version: Number(raw.version) || 1,
      providers: providers.map((provider) => ({
        id: String(provider.id || ''),
        enabled: Boolean(provider.enabled),
        defaultBaseUrl: String(provider.defaultBaseUrl || ''),
        defaultWorkspaceId: String(provider.defaultWorkspaceId || ''),
        defaultAccessKeyId: String(provider.defaultAccessKeyId || ''),
      })),
    },
    secrets: {
      providers: Object.fromEntries(providers.map((provider) => [String(provider.id || ''), {
        defaultApiKey: String(provider.defaultApiKey || ''),
        defaultAccessKeySecret: String(provider.defaultAccessKeySecret || ''),
      }])),
    },
  };
}

function mergeKnowledgeProviders(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitKnowledgeProviders(value);
  const meta = asRecord(envelope.meta);
  const secrets = asRecord(envelope.secrets);
  const providerSecrets = asRecord(secrets.providers);
  return {
    version: Number(meta.version) || 1,
    providers: arrayOfRecords(meta.providers).map((provider) => ({
      ...provider,
      defaultApiKey: String(asRecord(providerSecrets[String(provider.id || '')]).defaultApiKey || ''),
      defaultAccessKeySecret: String(asRecord(providerSecrets[String(provider.id || '')]).defaultAccessKeySecret || ''),
    })),
  };
}

function splitKnowledgeBases(value: unknown): SettingsEnvelope {
  const rows = arrayOfRecords(value);
  return {
    meta: rows.map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      provider: String(item.provider || ''),
      enabled: item.enabled !== false,
      description: String(item.description || ''),
      dataDir: String(item.dataDir || ''),
      baseUrl: String(item.baseUrl || ''),
      externalId: String(item.externalId || ''),
      categoryId: String(item.categoryId || ''),
      workspaceId: String(item.workspaceId || ''),
      accessKeyId: String(item.accessKeyId || ''),
      embeddingBaseUrl: String(item.embeddingBaseUrl || ''),
      embeddingModel: String(item.embeddingModel || ''),
      documentCount: Number(item.documentCount) || 0,
      updatedAt: Number(item.updatedAt) || Date.now(),
    })),
    secrets: {
      bases: Object.fromEntries(rows.map((item) => [String(item.id || ''), {
        apiKey: String(item.apiKey || ''),
        accessKeySecret: String(item.accessKeySecret || ''),
        embeddingApiKey: String(item.embeddingApiKey || ''),
      }])),
    },
  };
}

function mergeKnowledgeBases(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitKnowledgeBases(value);
  const meta = Array.isArray(asRecord({ meta: envelope.meta }).meta) ? envelope.meta : [];
  const secrets = asRecord(envelope.secrets);
  const baseSecrets = asRecord(secrets.bases);
  return arrayOfRecords(meta).map((item) => ({
    ...item,
    apiKey: String(asRecord(baseSecrets[String(item.id || '')]).apiKey || ''),
    accessKeySecret: String(asRecord(baseSecrets[String(item.id || '')]).accessKeySecret || ''),
    embeddingApiKey: String(asRecord(baseSecrets[String(item.id || '')]).embeddingApiKey || ''),
  }));
}

function splitMcpConnections(value: unknown): SettingsEnvelope {
  const rows = arrayOfRecords(value);
  return {
    meta: rows.map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      kind: String(item.kind || ''),
      transport: String(item.transport || ''),
      url: String(item.url || ''),
      command: String(item.command || ''),
      args: Array.isArray(item.args) ? item.args.map((arg) => String(arg)) : [],
      cwd: String(item.cwd || ''),
      runner: String(item.runner || ''),
      enabled: item.enabled !== false,
      description: String(item.description || ''),
      lastTestStatus: item.lastTestStatus ? String(item.lastTestStatus) : undefined,
      lastTestAt: Number(item.lastTestAt) || undefined,
      lastTestMessage: item.lastTestMessage ? String(item.lastTestMessage) : undefined,
      lastTestToolCount: Number(item.lastTestToolCount) || undefined,
      lastTestTools: Array.isArray(item.lastTestTools) ? item.lastTestTools : undefined,
      updatedAt: Number(item.updatedAt) || Date.now(),
    })),
    secrets: {
      connections: Object.fromEntries(rows.map((item) => [String(item.id || ''), {
        apiKey: String(item.apiKey || ''),
        env: asRecord(item.env),
      }])),
    },
  };
}

function mergeMcpConnections(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitMcpConnections(value);
  const meta = Array.isArray(asRecord({ meta: envelope.meta }).meta) ? envelope.meta : [];
  const secrets = asRecord(envelope.secrets);
  const connectionSecrets = asRecord(secrets.connections);
  return arrayOfRecords(meta).map((item) => ({
    ...item,
    apiKey: String(asRecord(connectionSecrets[String(item.id || '')]).apiKey || ''),
    env: asRecord(asRecord(connectionSecrets[String(item.id || '')]).env),
  }));
}

function splitRuntimeSettings(value: unknown): SettingsEnvelope {
  const raw = asRecord(value);
  return {
    meta: {
      sidecarPoolSize: Math.max(1, Number(raw.sidecarPoolSize) || 1),
      sidecarSharedMaxRuns: Math.max(1, Number(raw.sidecarSharedMaxRuns) || 8),
    },
  };
}

function mergeRuntimeSettings(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitRuntimeSettings(value);
  const meta = asRecord(envelope.meta);
  return {
    sidecarPoolSize: Math.max(1, Number(meta.sidecarPoolSize) || 1),
    sidecarSharedMaxRuns: Math.max(1, Number(meta.sidecarSharedMaxRuns) || 8),
  };
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const ensureAuth = (request: Parameters<typeof requireAuth>[0]) => {
    request.auth = authenticateRequest(request);
  };

  app.get('/settings/model', async () => mergeModelSettings(readJson('model-settings')));
  app.put('/settings/model', async (request) => mergeModelSettings(writeJson('model-settings', splitModelSettings(request.body ?? {}))));

  app.get('/settings/search', async () => mergeSearchSettings(readJson('search-settings')));
  app.put('/settings/search', async (request) => mergeSearchSettings(writeJson('search-settings', splitSearchSettings(request.body ?? {}))));

  app.get('/settings/knowledge/providers', async () => mergeKnowledgeProviders(readJson('knowledge-providers')));
  app.put('/settings/knowledge/providers', async (request) => mergeKnowledgeProviders(writeJson('knowledge-providers', splitKnowledgeProviders(request.body ?? {}))));

  app.get('/settings/knowledge/bases', async () => mergeKnowledgeBases(readJson('knowledge-bases')));
  app.put('/settings/knowledge/bases', async (request) => mergeKnowledgeBases(writeJson('knowledge-bases', splitKnowledgeBases(request.body ?? []))));

  app.get('/settings/mcp/connections', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      return mergeMcpConnections(readJson('mcp-connections'));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.put('/settings/mcp/connections', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      return mergeMcpConnections(writeJson('mcp-connections', splitMcpConnections(request.body ?? [])));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/settings/capabilities/skills', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      return readJson('capability-skills');
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.put('/settings/capabilities/skills', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      return writeJson('capability-skills', request.body ?? []);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/settings/capabilities/policies', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      return readJson('capability-policies');
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.put('/settings/capabilities/policies', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      return writeJson('capability-policies', request.body ?? []);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/settings/runtime', async () => mergeRuntimeSettings(readJson('runtime-settings')));
  app.put('/settings/runtime', async (request) => mergeRuntimeSettings(writeJson('runtime-settings', splitRuntimeSettings(request.body ?? {}))));
};
