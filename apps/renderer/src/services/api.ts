import { getStoredSessionToken } from './auth';
import { DSH_ENV_FIX_ACTION_ID } from '../features/dsh/environment-ui';

export interface HealthStatus { status: 'ok'; service: 'workmate-api'; version: string; }
export interface EnvCheckItem {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  required: string;
  found: string;
  command?: string;
  help: string;
}

export interface EnvCheckReport {
  platform: string;
  checks: EnvCheckItem[];
  summary: { total: number; ok: number; warn: number; error: number };
  checkedAt: number;
}

export interface RuntimeDispatcherRunState {
  runId: string;
  orgId?: string;
  userId?: string;
  sessionId: string;
  kind: 'chat' | 'project-task';
  priority: 'high' | 'normal';
  state: 'queued' | 'running';
  waitReason?: 'session-lane' | 'user-capacity' | 'global-capacity';
  queuedAt: number;
  startedAt?: number;
}

export interface RuntimeDispatcherStatus {
  limits: { global: number; perUser: number; maxQueueWaitMs: number; highPriorityBurstLimit: number };
  counts: { queued: number; running: number; activeSessions: number; activeUsers: number; highPriorityQueued: number; normalPriorityQueued: number };
  runs: RuntimeDispatcherRunState[];
}

export interface RuntimeSidecarRunState {
  runId: string;
  sessionId?: string;
  userId?: string;
  state: 'queued' | 'running';
  waitReason?: 'capacity';
  queuedAt: number;
  startedAt?: number;
}

export interface RuntimeSidecarStatus {
  status: 'stopped' | 'running';
  limits: { poolSize: number; maxRuns: number; queueWaitMs: number; restartCooldownMs: number };
  counts: { queued: number; activeRuns: number; sidecars: number; unhealthySidecars: number; coolingSidecars: number };
  endpoints: Array<{ id: string; port: number; url: string; activeRuns: number; status: 'running' | 'cooldown' | 'unhealthy' | 'stopped'; lastError?: string; cooldownRemainingMs?: number }>;
  runs: RuntimeSidecarRunState[];
}

export interface RuntimeStatusResponse {
  dispatcher: RuntimeDispatcherStatus | null;
  sidecar: RuntimeSidecarStatus;
}

export async function getHealth(): Promise<HealthStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/health`);
  if (!response.ok) throw new Error(`API health check failed: ${response.status}`);
  return response.json() as Promise<HealthStatus>;
}

export async function getServerModelConfig() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/model`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Model settings failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerModelConfig(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/model`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save model settings failed: ${response.status}`);
  return body as unknown;
}

export async function getServerSearchConfig() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/search`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Search settings failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerSearchConfig(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/search`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save search settings failed: ${response.status}`);
  return body as unknown;
}

export async function getServerKnowledgeProviderConfig() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/knowledge/providers`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Knowledge provider settings failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerKnowledgeProviderConfig(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/knowledge/providers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save knowledge provider settings failed: ${response.status}`);
  return body as unknown;
}

export async function getServerKnowledgeBases() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/knowledge/bases`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Knowledge bases failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerKnowledgeBases(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/knowledge/bases`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? []),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save knowledge bases failed: ${response.status}`);
  return body as unknown;
}

export async function getServerMcpConnections() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/mcp/connections`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `MCP connections failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerMcpConnections(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/mcp/connections`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? []),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save MCP connections failed: ${response.status}`);
  return body as unknown;
}

export async function getServerCapabilitySkills() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/capabilities/skills`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Capability skills failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerCapabilitySkills(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/capabilities/skills`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? []),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save capability skills failed: ${response.status}`);
  return body as unknown;
}

export async function getServerCapabilityPolicies() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/capabilities/policies`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Capability policies failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerCapabilityPolicies(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/capabilities/policies`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? []),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save capability policies failed: ${response.status}`);
  return body as unknown;
}

export async function getServerRuntimeConfig() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/runtime`);
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Runtime settings failed: ${response.status}`);
  return body as unknown;
}

export async function saveServerRuntimeConfig(value: unknown) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/settings/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Save runtime settings failed: ${response.status}`);
  return body as unknown;
}

export async function getRuntimeStatus(): Promise<RuntimeStatusResponse> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/orch/runtime/status`);
  const body = await response.json().catch(() => ({})) as RuntimeStatusResponse & { message?: string };
  if (!response.ok) throw new Error(body.message || `Runtime status failed: ${response.status}`);
  return body;
}

export function subscribeRuntimeStatus(handlers: {
  onMessage: (value: RuntimeStatusResponse) => void;
  onError?: () => void;
}): () => void {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const token = getStoredSessionToken();
  const params = new URLSearchParams();
  if (token) params.set('sessionToken', token);
  const source = new EventSource(`${apiBase}/api/orch/runtime/status/stream${params.size ? `?${params.toString()}` : ''}`);
  source.addEventListener('runtime-status', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      handlers.onMessage(JSON.parse(event.data) as RuntimeStatusResponse);
    } catch {
      handlers.onError?.();
    }
  });
  source.onerror = () => {
    handlers.onError?.();
  };
  return () => source.close();
}

export async function getEnvironmentReport(): Promise<EnvCheckReport> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/environment`);
  const body = await response.json().catch(() => ({})) as EnvCheckReport & { message?: string };
  if (!response.ok) throw new Error(body.message || `Environment check failed: ${response.status}`);
  return body;
}

export type EnvFixActionId = 'fix-storage' | 'fix-pip' | 'fix-agentscope' | typeof DSH_ENV_FIX_ACTION_ID;

export async function runEnvironmentFix(actionId: EnvFixActionId): Promise<{
  ok: boolean;
  message: string;
  detail?: string;
  actionId: EnvFixActionId;
  report?: EnvCheckReport;
}> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/environment/fix`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId }),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    message?: string;
    detail?: string;
    actionId?: EnvFixActionId;
    report?: EnvCheckReport;
  };
  if (!response.ok) throw new Error(body.message || `Environment fix failed: ${response.status}`);
  return {
    ok: Boolean(body.ok),
    message: body.message || '修复完成',
    detail: body.detail,
    actionId: body.actionId || actionId,
    report: body.report,
  };
}

export interface RuntimeSkill {
  id: string; name: string; description: string; mode: 'available' | 'default'; rootPath?: string; instructions?: string;
  resources: Array<{ path: string; content: string }>;
  execution: { allowWorkspaceWrite: boolean; allowScriptExecution: boolean; allowedNetworkHosts: string[]; allowAllNonDestructive: boolean };
}

export interface ToolActivity { toolName: string; summary: string; status: 'running' | 'completed' | 'failed'; }
export interface ToolApproval { skillId: string; capability: 'workspace-write' | 'script-execution' | 'network-access'; summary: string; /** Server-side approval id when originating from /api/orch sessions. */ id?: string; }
export interface GeneratedArtifact { runId: string; path: string; }
export interface SearchSource { title: string; url: string; source?: string; }
export type McpConnectionPayload =
  | { id: string; name: string; url: string; transport: 'http' | 'sse'; enabled: boolean; apiKey?: string; description?: string }
  | { id: string; name: string; transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled: boolean; description?: string };

export type KnowledgeBasePayload = {
  id: string;
  name: string;
  provider: 'lancedb' | 'bailian' | 'dify' | 'qdrant' | 'pinecone';
  enabled: boolean;
  description?: string;
  dataDir?: string;
  baseUrl?: string;
  apiKey?: string;
  externalId?: string;
  categoryId?: string;
  workspaceId?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingMeta?: {
    dimension?: number;
    normalize?: boolean;
    maxBatch?: number;
    maxInputChars?: number;
  };
  indexState?: {
    status: 'ready' | 'stale' | 'rebuilding';
    signature?: string;
    lastBuildAt?: number;
    lastBuildModel?: string;
    lastBuildError?: string;
  };
};

export type StreamChatInput = {
  profile: { id: string; name: string; instructions: string; toolIds: string[] };
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: { provider: string; baseUrl?: string; chatModel: string; imageModel?: string; embeddingModel?: string; apiKey: string; disableThinking?: boolean; enableSearch?: boolean };
  skills?: RuntimeSkill[];
  searchProviders?: Array<{ id: 'bocha' | 'tavily' | 'brave' | 'exa' | 'zhipu' | 'aliyun'; label: string; apiKey: string; baseUrl?: string; enabled: boolean; preferred: boolean }>;
  mcpConnections?: McpConnectionPayload[];
  knowledgeBases?: KnowledgeBasePayload[];
  runId?: string;
  projectWorkspacePath?: string;
  maxSteps?: number;
  runTimeoutMs?: number;
  mcpToolTimeoutMs?: number;
  signal?: AbortSignal;
};

function isAbortError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name || '') : '';
  return name === 'AbortError';
}

export async function streamChat(
  input: StreamChatInput,
  onDelta: (text: string) => void,
  onToolActivity?: (activity: ToolActivity) => void,
  onApproval?: (approval: ToolApproval) => void,
  onArtifact?: (artifact: GeneratedArtifact) => void | Promise<void>,
  onSearchSources?: (value: { provider: string; sources: SearchSource[] }) => void,
): Promise<void> {
  const { signal, ...body } = input;
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
    }
    throw error;
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    let message = `Chat request failed: ${response.status}`;
    try {
      const parsed = JSON.parse(detail) as { message?: string; issues?: Array<{ path?: unknown[]; message?: string }> };
      if (parsed.message) message = parsed.message;
      const first = parsed.issues?.[0];
      if (first?.message) message = `${message}: ${first.message}`;
    } catch { /* keep status message */ }
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (isAbortError(error, signal)) {
          throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
        }
        throw error;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const item of events) {
        if (!item.startsWith('data: ')) continue;
        const event = JSON.parse(item.slice(6)) as {
          type: string;
          text?: string;
          message?: string;
          toolName?: string;
          summary?: string;
          ok?: boolean;
          skillId?: string;
          capability?: ToolApproval['capability'];
          runId?: string;
          path?: string;
          provider?: string;
          sources?: SearchSource[];
          reason?: 'user' | 'timeout';
        };
        if (event.type === 'message.delta' && event.text) onDelta(event.text);
        if (event.type === 'tool.started' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: 'running' });
        if (event.type === 'tool.completed' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: event.ok ? 'completed' : 'failed' });
        if (event.type === 'tool.failed' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: 'failed' });
        if (event.type === 'tool.approval_required' && event.skillId && event.capability && event.summary) onApproval?.({ skillId: event.skillId, capability: event.capability, summary: event.summary });
        if (event.type === 'artifact.created' && event.runId && event.path) await onArtifact?.({ runId: event.runId, path: event.path });
        if (event.type === 'search.sources' && event.provider && event.sources) onSearchSources?.({ provider: event.provider, sources: event.sources });
        if (event.type === 'run.cancelled') {
          throw Object.assign(new Error(event.message || '已中止当前执行。'), {
            name: 'AbortError',
            reason: event.reason || 'user',
          });
        }
        if (event.type === 'run.failed') throw new Error(event.message || 'Model request failed.');
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader);
  }
}

export async function ingestKnowledgeDocument(input: {
  knowledgeBase: KnowledgeBasePayload;
  title: string;
  content?: string;
  fileBase64?: string;
  fileName?: string;
  source?: string;
  model?: { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/knowledge/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    message?: string;
    chunks?: number;
    backend?: string;
    documentId?: string;
    jobId?: string;
    status?: string;
    indexState?: KnowledgeBasePayload['indexState'];
  };
  if (!response.ok) throw new Error(body.message || `Knowledge ingest failed: ${response.status}`);
  return body as {
    ok: true;
    chunks: number;
    backend: string;
    dataDir?: string;
    documentId?: string;
    jobId?: string;
    status?: string;
    indexState?: KnowledgeBasePayload['indexState'];
  };
}

function knowledgeApiBase() {
  return window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
}

async function postKnowledge<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${knowledgeApiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error((payload as { message?: string }).message || `Knowledge request failed: ${response.status}`);
  return payload;
}

export type KnowledgeDocumentRow = {
  id: string;
  title: string;
  source?: string;
  chunkCount: number;
  createdAt: number;
  preview: string;
};

export type KnowledgeChunkRow = {
  id: string;
  documentId: string;
  documentTitle: string;
  title: string;
  content: string;
  source?: string;
  createdAt: number;
};

export async function listKnowledgeDocuments(input: {
  knowledgeBase: KnowledgeBasePayload;
}) {
  return postKnowledge<{
    ok: true;
    backend: string;
    dataDir: string;
    documentCount: number;
    chunkCount: number;
    documents: KnowledgeDocumentRow[];
  }>('/api/knowledge/documents', input);
}

export async function listKnowledgeChunks(input: {
  knowledgeBase: KnowledgeBasePayload;
  documentId?: string;
  query?: string;
  offset?: number;
  limit?: number;
}) {
  return postKnowledge<{
    ok: true;
    backend: string;
    total: number;
    offset: number;
    limit: number;
    chunks: KnowledgeChunkRow[];
  }>('/api/knowledge/chunks', input);
}

export async function deleteKnowledgeDocument(input: {
  knowledgeBase: KnowledgeBasePayload;
  documentId: string;
}) {
  return postKnowledge<{ ok: true; removedChunks: number; remainingChunks: number; documentCount: number }>(
    '/api/knowledge/documents/delete',
    input,
  );
}

export async function deleteKnowledgeChunk(input: {
  knowledgeBase: KnowledgeBasePayload;
  chunkId: string;
}) {
  return postKnowledge<{ ok: true; remainingChunks: number; documentCount: number }>(
    '/api/knowledge/chunks/delete',
    input,
  );
}

export async function searchKnowledge(input: {
  knowledgeBase: KnowledgeBasePayload;
  query: string;
  topK?: number;
  model?: { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
}) {
  return postKnowledge<{
    ok: true;
    results: Array<{ id: string; title: string; content: string; score: number; source?: string; url?: string }>;
  }>('/api/knowledge/search', input);
}

export async function listBailianPipelines(input: {
  apiKey: string;
  baseUrl?: string;
  workspaceId?: string;
}) {
  return postKnowledge<{
    ok: true;
    pipelines: Array<{ id: string; name: string; workspaceId: string; docNum: number }>;
  }>('/api/knowledge/bailian/pipelines', input);
}

export async function createBailianKnowledge(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  name: string;
  description?: string;
  embeddingModelName?: string;
}) {
  return postKnowledge<{
    ok: true;
    indexId: string;
    categoryId: string;
    workspaceId: string;
    name: string;
  }>('/api/knowledge/bailian/create', input);
}

export async function deleteBailianKnowledge(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  indexId: string;
}) {
  return postKnowledge<{ ok: true }>('/api/knowledge/bailian/delete', input);
}

export async function listBailianIndices(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  pageNumber?: number;
  pageSize?: number;
  indexName?: string;
}) {
  return postKnowledge<{
    ok: true;
    indices: Array<{ id: string; name: string; description: string; documentCount: number; categoryId?: string }>;
  }>('/api/knowledge/bailian/list', input);
}

export async function getKnowledgeJobStatus(input: {
  knowledgeBase: KnowledgeBasePayload;
  jobId: string;
}) {
  return postKnowledge<{
    ok: true;
    jobId: string;
    status: string;
    message?: string;
  }>('/api/knowledge/job-status', input);
}

export async function deleteRemoteKnowledgeBase(input: {
  knowledgeBase: KnowledgeBasePayload;
}) {
  return postKnowledge<{ ok: true }>('/api/knowledge/delete-remote', input);
}

export async function testMcpConnection(connection: McpConnectionPayload, timeoutMs = 25_000) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/mcp/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connection, timeoutMs }),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    toolCount?: number;
    toolNames?: string[];
    tools?: Array<{ name?: string; description?: string }>;
    durationMs?: number;
    error?: string;
    message?: string;
  };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || body.message || `MCP test failed: ${response.status}`);
  }
  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((item) => {
          const name = String(item?.name || '').trim();
          if (!name) return null;
          const description = item?.description ? String(item.description).slice(0, 400) : undefined;
          return { name, ...(description ? { description } : {}) };
        })
        .filter((item): item is { name: string; description?: string } => Boolean(item))
    : (Array.isArray(body.toolNames) ? body.toolNames.map((name) => ({ name: String(name) })) : []);
  return {
    ok: true as const,
    toolCount: Number(body.toolCount) || tools.length,
    toolNames: tools.map((item) => item.name),
    tools,
    durationMs: Number(body.durationMs) || 0,
  };
}

export async function testProviderConnection(input: {
  type: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/providers/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string };
  if (!response.ok || body.ok === false) throw new Error(body.message || `Provider test failed: ${response.status}`);
  return { ok: true as const, message: body.message || '连接成功。' };
}

export async function testEmbeddingConnection(input: {
  type: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/providers/test-embedding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    status?: 'healthy' | 'degraded' | 'unreachable' | 'unauthorized' | 'misconfigured';
    checkedAt?: number;
    latencyMs?: number;
    modelReachable?: boolean;
    message?: string;
    code?: string | null;
    detail?: Record<string, number>;
  };
  if (!response.ok || body.ok === false) {
    const error = new Error(body.message || `Embedding provider test failed: ${response.status}`) as Error & {
      status?: string;
      code?: string | null;
      detail?: Record<string, number>;
    };
    error.status = body.status;
    error.code = body.code;
    error.detail = body.detail;
    throw error;
  }
  return {
    ok: true as const,
    status: body.status || 'healthy',
    checkedAt: Number(body.checkedAt) || Date.now(),
    latencyMs: Number(body.latencyMs) || 0,
    modelReachable: Boolean(body.modelReachable),
    message: body.message || 'Embedding 连接成功。',
    code: body.code || null,
    detail: body.detail || {},
  };
}

export async function listProviderModels(input: {
  type: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/providers/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { models?: unknown[]; message?: string };
  if (!response.ok) throw new Error(body.message || `List provider models failed: ${response.status}`);
  return Array.isArray(body.models) ? body.models.map((item) => String(item || '')).filter(Boolean) : [];
}

export async function pullOllamaModel(input: {
  baseUrl?: string;
  modelName: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/providers/ollama/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; status?: string; message?: string };
  if (!response.ok || body.ok === false) throw new Error(body.message || `Ollama pull failed: ${response.status}`);
  return body.status || 'success';
}

export async function discoverSkills(query: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills/discover?${new URLSearchParams({ q: query })}`);
  const body = await response.json().catch(() => ({})) as {
    items?: Array<{ reference?: string; source?: string; slug?: string; name?: string; description?: string; installs?: string; url?: string }>;
    hasMore?: boolean;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill discovery failed: ${response.status}`);
  return {
    items: Array.isArray(body.items) ? body.items.map((item) => ({
      reference: String(item.reference || ''),
      source: String(item.source || ''),
      slug: String(item.slug || ''),
      name: String(item.name || ''),
      description: String(item.description || ''),
      installs: String(item.installs || ''),
      url: String(item.url || ''),
    })) : [],
    hasMore: Boolean(body.hasMore),
  };
}

export async function installSkillPackage(reference: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reference }),
  });
  const body = await response.json().catch(() => ({})) as {
    manifest?: { path?: string; content?: string } | null;
    output?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill install failed: ${response.status}`);
  return {
    output: String(body.output || ''),
    manifest: body.manifest && typeof body.manifest === 'object'
      ? {
        path: String(body.manifest.path || ''),
        content: String(body.manifest.content || ''),
      }
      : null,
  };
}

export async function importGitSkill(url: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills/import-git`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await response.json().catch(() => ({})) as {
    manifests?: Array<{ path?: string; content?: string }>;
    skipped?: string[];
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill git import failed: ${response.status}`);
  return {
    manifests: Array.isArray(body.manifests)
      ? body.manifests.map((item) => ({
        path: String(item.path || ''),
        content: String(item.content || ''),
      }))
      : [],
    skipped: Array.isArray(body.skipped) ? body.skipped.map((item) => String(item || '')) : [],
  };
}

export async function importSkillZip(input: { filename: string; base64: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills/import-zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    manifest?: { path?: string; content?: string } | null;
    importedFiles?: number;
    source?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill zip import failed: ${response.status}`);
  return {
    manifest: body.manifest && typeof body.manifest === 'object'
      ? { path: String(body.manifest.path || ''), content: String(body.manifest.content || '') }
      : null,
    importedFiles: Number(body.importedFiles || 0),
    source: String(body.source || input.filename),
  };
}

export async function listSkillFiles(root: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills/files?${new URLSearchParams({ root })}`);
  const body = await response.json().catch(() => ({})) as {
    items?: Array<{ path?: string; relative?: string; type?: 'directory' | 'file' }>;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Skill file list failed: ${response.status}`);
  return Array.isArray(body.items)
    ? body.items.map((item) => ({
      path: String(item?.path || ''),
      relative: String(item?.relative || ''),
      type: item?.type === 'directory' ? 'directory' as const : 'file' as const,
    }))
    : [];
}

export async function readSkillFile(path: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills/file?${new URLSearchParams({ path })}`);
  const body = await response.json().catch(() => ({})) as { path?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Skill read failed: ${response.status}`);
  return { path: String(body.path || path), content: String(body.content || '') };
}

export async function writeSkillFile(input: { path: string; content: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { path?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Skill write failed: ${response.status}`);
  return { path: String(body.path || input.path), content: String(body.content || input.content) };
}

export async function writeSkillDraft(input: { name: string; content: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { path?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Skill draft save failed: ${response.status}`);
  return { path: String(body.path || ''), content: String(body.content || '') };
}

export async function deleteManagedSkill(path: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/skills?${new URLSearchParams({ path })}`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string };
  if (!response.ok) throw new Error(body.message || `Skill delete failed: ${response.status}`);
  return Boolean(body.ok);
}

export async function createManagedWorkspace(name: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await response.json().catch(() => ({})) as { root?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Workspace create failed: ${response.status}`);
  return String(body.root || '');
}

export async function listWorkspaceFiles(root: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/files?${new URLSearchParams({ root })}`);
  const body = await response.json().catch(() => ([])) as Array<{ relative?: string; type?: 'directory' | 'file' }> | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Workspace files failed: ${response.status}`);
  return body.map((item): { relative: string; type: 'directory' | 'file' } => ({
    relative: String(item.relative || ''),
    type: item.type === 'directory' ? 'directory' : 'file',
  }));
}

export async function readWorkspaceFile(root: string, relative: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/file?${new URLSearchParams({ root, relative })}`);
  const body = await response.json().catch(() => ({})) as { relative?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Workspace file read failed: ${response.status}`);
  return { relative: String(body.relative || relative), content: String(body.content || '') };
}

export async function writeWorkspaceFile(root: string, relative: string, content: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, relative, content }),
  });
  const body = await response.json().catch(() => ({})) as { relative?: string; content?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Workspace file write failed: ${response.status}`);
  return { relative: String(body.relative || relative), content: String(body.content || '') };
}

export async function syncWorkspaceRun(root: string, runId: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/sync-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, runId }),
  });
  const body = await response.json().catch(() => ([])) as Array<{ relative?: string; type?: 'directory' | 'file' }> | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Workspace sync failed: ${response.status}`);
  return body.map((item): { relative: string; type: 'directory' | 'file' } => ({
    relative: String(item.relative || ''),
    type: item.type === 'directory' ? 'directory' : 'file',
  }));
}

export async function materializeWorkspaceAssets(root: string, items: Array<{ assetId?: string; relativePath?: string; name?: string }>) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/materialize-assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, items }),
  });
  const body = await response.json().catch(() => ([])) as Array<{ relative?: string; type?: 'directory' | 'file' }> | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Workspace materialize failed: ${response.status}`);
  return body.map((item): { relative: string; type: 'directory' | 'file' } => ({
    relative: String(item.relative || ''),
    type: item.type === 'directory' ? 'directory' : 'file',
  }));
}

export async function importWorkspaceZip(input: { root: string; filename: string; base64: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/import-zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    source?: string;
    importedFiles?: number;
    files?: Array<{ relative?: string; type?: 'directory' | 'file' }>;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Workspace zip import failed: ${response.status}`);
  return {
    ok: Boolean(body.ok),
    source: String(body.source || input.filename),
    importedFiles: Number(body.importedFiles || 0),
    files: Array.isArray(body.files) ? body.files.map((item) => ({
      relative: String(item.relative || ''),
      type: item.type === 'directory' ? 'directory' as const : 'file' as const,
    })) : [],
  };
}

export async function exportWorkspaceZip(root: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/export-zip?${new URLSearchParams({ root })}`);
  const body = await response.json().catch(() => ({})) as { ok?: boolean; filename?: string; base64?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Workspace zip export failed: ${response.status}`);
  return {
    ok: Boolean(body.ok),
    filename: String(body.filename || 'workspace.zip'),
    base64: String(body.base64 || ''),
  };
}

export async function readWorkspacePreview(root: string, relative: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/workspace/preview?${new URLSearchParams({ root, relative })}`);
  const body = await response.json().catch(() => ({})) as {
    kind?: 'text' | 'binary';
    name?: string;
    relative?: string;
    content?: string;
    base64?: string;
    bytes?: number;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Workspace preview failed: ${response.status}`);
  return {
    kind: (body.kind === 'binary' ? 'binary' : 'text') as 'text' | 'binary',
    name: String(body.name || ''),
    relative: body.relative ? String(body.relative) : undefined,
    content: typeof body.content === 'string' ? body.content : undefined,
    base64: typeof body.base64 === 'string' ? body.base64 : undefined,
    bytes: Number(body.bytes || 0),
  };
}

export interface AssetPayload {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  orgId?: string | null;
  ownerUserId?: string | null;
  userId?: string | null;
  accessScope?: 'private' | 'org-shared' | 'delegated';
  accessGrants?: Array<{
    subjectType: 'user';
    subjectId: string;
    permissions: Array<'read' | 'write'>;
    createdAt: number;
    expiresAt?: number;
  }>;
  conversationId: string | null;
  employeeId: string | null;
  runId: string;
  sha256: string;
  projectId: string | null;
  workspaceRelative: string | null;
  kind?: 'file' | 'bundle';
  entryPath?: string | null;
  manifest?: {
    version: number;
    entryPath: string;
    files: Array<{ path: string; bytes: number; sha256: string; mimeType: string }>;
  } | null;
}

function normalizeAsset(item: Partial<AssetPayload>): AssetPayload {
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    relativePath: String(item.relativePath || ''),
    mimeType: String(item.mimeType || ''),
    sizeBytes: Number(item.sizeBytes || 0),
    createdAt: Number(item.createdAt || 0),
    orgId: item.orgId ? String(item.orgId) : null,
    ownerUserId: item.ownerUserId ? String(item.ownerUserId) : (item.userId ? String(item.userId) : null),
    userId: item.userId ? String(item.userId) : (item.ownerUserId ? String(item.ownerUserId) : null),
    accessScope: item.accessScope === 'org-shared' || item.accessScope === 'delegated' ? item.accessScope : 'private',
    accessGrants: Array.isArray(item.accessGrants) ? item.accessGrants : [],
    conversationId: item.conversationId ? String(item.conversationId) : null,
    employeeId: item.employeeId ? String(item.employeeId) : null,
    runId: String(item.runId || ''),
    sha256: String(item.sha256 || ''),
    projectId: item.projectId ? String(item.projectId) : null,
    workspaceRelative: item.workspaceRelative ? String(item.workspaceRelative) : null,
    kind: item.kind === 'bundle' ? 'bundle' : 'file',
    entryPath: item.entryPath ? String(item.entryPath) : null,
    manifest: item.manifest && typeof item.manifest === 'object' ? item.manifest : null,
  };
}

export async function listArchivedAssets() {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/assets`);
  const body = await response.json().catch(() => ([])) as Array<Partial<AssetPayload>> | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error((body as { message?: string }).message || `Assets list failed: ${response.status}`);
  return body.map((item) => normalizeAsset(item));
}

export async function archiveWorkspaceArtifact(input: {
  runId: string;
  relativePath: string;
  conversationId?: string;
  employeeId?: string;
  projectId?: string;
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/assets/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as Partial<AssetPayload> & { message?: string };
  if (!response.ok) throw new Error(body.message || `Asset archive failed: ${response.status}`);
  return normalizeAsset(body);
}

export async function archiveWorkspaceBundle(input: { runId: string; conversationId?: string; employeeId?: string; projectId?: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/assets/archive-bundle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({})) as Partial<AssetPayload> & { message?: string };
  if (!response.ok) throw new Error(body.message || `Bundle archive failed: ${response.status}`);
  return normalizeAsset(body);
}

export function archivedBundleContentUrl(assetId: string, relativePath = '') {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  return `${apiBase}/api/assets/bundle/${encodeURIComponent(assetId)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export async function linkArchivedAssets(input: { projectId: string; assetIds: string[]; workspacePath?: string }) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/assets/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { updated?: number; copied?: number; projectId?: string; message?: string };
  if (!response.ok) throw new Error(body.message || `Asset link failed: ${response.status}`);
  return {
    updated: Number(body.updated || 0),
    copied: Number(body.copied || 0),
    projectId: String(body.projectId || input.projectId),
  };
}

export async function unlinkArchivedAssets(assetIds: string[]) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/assets/unlink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetIds }),
  });
  const body = await response.json().catch(() => ({})) as { updated?: number; message?: string };
  if (!response.ok) throw new Error(body.message || `Asset unlink failed: ${response.status}`);
  return { updated: Number(body.updated || 0) };
}

export async function deleteArchivedAssets(assetIds: string[]) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/assets/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetIds }),
  });
  const body = await response.json().catch(() => ({})) as { deleted?: number; message?: string };
  if (!response.ok) throw new Error(body.message || `Asset delete failed: ${response.status}`);
  return { deleted: Number(body.deleted || 0) };
}

export async function readArchivedAssetPreview(assetId: string) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${apiBase}/api/assets/preview?${new URLSearchParams({ assetId })}`);
  const body = await response.json().catch(() => ({})) as {
    kind?: 'text' | 'binary';
    name?: string;
    content?: string;
    base64?: string;
    bytes?: number;
    mimeType?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Asset preview failed: ${response.status}`);
  return {
    kind: (body.kind === 'binary' ? 'binary' : 'text') as 'text' | 'binary',
    name: String(body.name || ''),
    content: typeof body.content === 'string' ? body.content : undefined,
    base64: typeof body.base64 === 'string' ? body.base64 : undefined,
    bytes: Number(body.bytes || 0),
    mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
  };
}

export function workspaceContentUrl(root: string, relative: string, options: { download?: boolean } = {}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const params = new URLSearchParams({ root, relative, ...(options.download ? { download: '1' } : {}) });
  return `${apiBase}/api/workspace/content?${params.toString()}`;
}

export function archivedAssetContentUrl(assetId: string, options: { download?: boolean } = {}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const params = new URLSearchParams({ assetId, ...(options.download ? { download: '1' } : {}) });
  return `${apiBase}/api/assets/content?${params.toString()}`;
}

export type RemoteChannelSecrets = {
  telegram?: { botToken?: string };
  feishu?: { appSecret?: string };
  relay?: { token?: string };
};

export type RemoteChannelMeta = {
  version?: number;
  defaultEmployeeId?: string;
  allowlist?: string[];
  channels?: {
    telegram?: { enabled?: boolean };
    feishu?: { enabled?: boolean; appId?: string };
    relay?: { enabled?: boolean; baseUrl?: string; deviceId?: string };
  };
};

function remoteApiBase() {
  return window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
}

export async function getRemoteSettings() {
  const response = await fetch(`${remoteApiBase()}/api/remote/settings`);
  const body = await response.json().catch(() => ({})) as {
    meta?: RemoteChannelMeta;
    secrets?: RemoteChannelSecrets;
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Remote settings failed: ${response.status}`);
  return {
    meta: (body.meta && typeof body.meta === 'object' ? body.meta : {}) as RemoteChannelMeta,
    secrets: (body.secrets && typeof body.secrets === 'object' ? body.secrets : {}) as RemoteChannelSecrets,
  };
}

export async function saveRemoteSettings(payload: { meta: RemoteChannelMeta; secrets: RemoteChannelSecrets }) {
  const response = await fetch(`${remoteApiBase()}/api/remote/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; meta?: RemoteChannelMeta; message?: string };
  if (!response.ok) throw new Error(body.message || `Remote settings save failed: ${response.status}`);
  return { ok: Boolean(body.ok), meta: (body.meta && typeof body.meta === 'object' ? body.meta : {}) as RemoteChannelMeta };
}

export async function getRemoteGatewayStatus() {
  const response = await fetch(`${remoteApiBase()}/api/remote/gateway/status`);
  const body = await response.json().catch(() => ({})) as { running?: boolean; pid?: number | null; message?: string };
  if (!response.ok) throw new Error(body.message || `Remote gateway status failed: ${response.status}`);
  return { running: Boolean(body.running), pid: body.pid ?? null };
}

export async function restartRemoteGateway() {
  const response = await fetch(`${remoteApiBase()}/api/remote/gateway/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await response.json().catch(() => ({})) as { running?: boolean; pid?: number | null; message?: string };
  if (!response.ok) throw new Error(body.message || `Remote gateway restart failed: ${response.status}`);
  return { running: Boolean(body.running), pid: body.pid ?? null };
}
