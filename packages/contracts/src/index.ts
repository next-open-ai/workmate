import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('workmate-api'),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const AgentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string(),
  toolIds: z.array(z.string()),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * A capability package made available to one agent run. Content is kept out
 * of the model prompt until the agent explicitly loads the skill (except for
 * deliberately configured default skills).
 */
export const AgentSkillResourceSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string().max(48_000),
});
export const SkillExecutionPolicySchema = z.object({
  /** A per-run workspace can be written only after this capability is granted. */
  allowWorkspaceWrite: z.boolean().default(false),
  /** Only executable files under this Skill's scripts/ directory may run. */
  allowScriptExecution: z.boolean().default(false),
  /** Exact HTTPS host names permitted for this Skill. Empty means no egress. */
  allowedNetworkHosts: z.array(z.string().min(1).max(253)).max(32).default([]),
  allowAllNonDestructive: z.boolean().default(false),
});
export type SkillExecutionPolicy = z.infer<typeof SkillExecutionPolicySchema>;
export const AgentSkillRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).max(2_000),
  mode: z.enum(['available', 'default']),
  /** Private runtime location; it is never included in model-visible tool output. */
  rootPath: z.string().min(1).optional(),
  instructions: z.string().max(24_000).optional(),
  resources: z.array(AgentSkillResourceSchema).max(40).default([]),
  execution: SkillExecutionPolicySchema.default({}),
});
export type AgentSkillRuntime = z.infer<typeof AgentSkillRuntimeSchema>;

/** Normalized token counters for one LLM call or one run aggregate. */
export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Non-secret model / channel identity attached to usage events. */
export const RunModelRefSchema = z.object({
  provider: z.string().min(1),
  chatModel: z.string().min(1),
  baseUrl: z.string().optional(),
  providerLabel: z.string().max(120).optional(),
});
export type RunModelRef = z.infer<typeof RunModelRefSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), runId: z.string() }),
  z.object({ type: z.literal('message.delta'), runId: z.string(), text: z.string() }),
  z.object({ type: z.literal('tool.started'), runId: z.string(), toolName: z.string(), summary: z.string() }),
  z.object({ type: z.literal('tool.completed'), runId: z.string(), toolName: z.string(), summary: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal('tool.failed'), runId: z.string(), toolName: z.string(), summary: z.string() }),
  z.object({ type: z.literal('artifact.created'), runId: z.string(), path: z.string().min(1).max(240) }),
  z.object({
    type: z.literal('project.file.published'),
    runId: z.string(),
    /** Relative path inside the run workspace (source). */
    path: z.string().min(1).max(240),
    /** Relative path written under the shared project workspace. */
    projectPath: z.string().min(1).max(240),
  }),
  z.object({ type: z.literal('search.sources'), runId: z.string(), provider: z.string(), sources: z.array(z.object({ title: z.string(), url: z.string().url(), source: z.string().optional() })).max(10) }),
  z.object({ type: z.literal('tool.approval_required'), runId: z.string(), skillId: z.string(), capability: z.enum(['workspace-write', 'script-execution', 'network-access']), summary: z.string() }),
  z.object({
    type: z.literal('run.usage'),
    runId: z.string(),
    usage: TokenUsageSchema,
    model: RunModelRefSchema.optional(),
    /** 0-based LLM step within the run when known. */
    stepIndex: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('run.completed'), runId: z.string() }),
  z.object({ type: z.literal('run.failed'), runId: z.string(), message: z.string() }),
  z.object({
    type: z.literal('run.cancelled'),
    runId: z.string(),
    reason: z.enum(['user', 'timeout']),
    message: z.string(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'ollama', 'openai-compatible']);
export const ModelConfigSchema = z.object({
  provider: ProviderIdSchema,
  baseUrl: z.string().url().optional(),
  chatModel: z.string().min(1),
  /** Human label of the provider connection / channel (never a secret). */
  providerLabel: z.string().max(120).optional(),
  disableThinking: z.boolean().optional(),
  /**
   * When true, DashScope-compatible chat requests inject `enable_search: true`
   * (Bailian / Qwen built-in web search). Not an external search provider tool.
   */
  enableSearch: z.boolean().optional(),
  imageModel: z.string().optional(),
  /**
   * Global / system embedding model id (from Settings → active embedding).
   * Used by experience memory, local knowledge, and other vector tools.
   */
  embeddingModel: z.string().optional(),
  /** Optional override when the embedding model lives on a different connection than chat. */
  embeddingBaseUrl: z.string().url().optional(),
  embeddingApiKey: z.string().optional(),
  asrModel: z.string().optional(),
  ttsModel: z.string().optional(),
  apiKey: z.string(),
}).refine((value) => value.provider === 'ollama' || value.apiKey.trim().length > 0, { message: 'API key is required for this provider.' });
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const SearchProviderIdSchema = z.enum(['bocha', 'tavily', 'brave', 'exa', 'zhipu', 'aliyun']);
export type SearchProviderId = z.infer<typeof SearchProviderIdSchema>;
export const SearchProviderRuntimeSchema = z.object({
  id: SearchProviderIdSchema,
  label: z.string().min(1).max(80),
  apiKey: z.string().min(1),
  /** Optional provider endpoint override; Aliyun requires its workspace service endpoint. */
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
  preferred: z.boolean().default(false),
});
export type SearchProviderRuntime = z.infer<typeof SearchProviderRuntimeSchema>;

const McpRemoteRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  transport: z.enum(['http', 'sse']).default('http'),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  description: z.string().max(500).optional(),
});

const McpStdioRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  transport: z.literal('stdio'),
  command: z.string().min(1).max(240),
  args: z.array(z.string().max(500)).max(64).default([]),
  env: z.record(z.string().max(2000)).optional(),
  cwd: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  description: z.string().max(500).optional(),
});

export const McpConnectionRuntimeSchema = z.union([McpRemoteRuntimeSchema, McpStdioRuntimeSchema]);
export type McpConnectionRuntime = z.infer<typeof McpConnectionRuntimeSchema>;

export const McpProbeRequestSchema = z.object({
  connection: McpConnectionRuntimeSchema,
  timeoutMs: z.number().int().min(3_000).max(60_000).optional(),
});
export type McpProbeRequest = z.infer<typeof McpProbeRequestSchema>;

/** Phase-1 knowledge base providers: local LanceDB + selected cloud engines. */
export const KnowledgeProviderIdSchema = z.enum(['lancedb', 'bailian', 'dify', 'qdrant', 'pinecone']);
export type KnowledgeProviderId = z.infer<typeof KnowledgeProviderIdSchema>;

export const KnowledgeBaseRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  provider: KnowledgeProviderIdSchema,
  enabled: z.boolean().default(true),
  description: z.string().max(500).optional(),
  /** Local LanceDB directory (absolute). */
  dataDir: z.string().max(1000).optional(),
  /** Cloud API base URL (Dify / Qdrant / custom Bailian endpoint). */
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  /** External dataset / index / collection / knowledge-base id. */
  externalId: z.string().max(240).optional(),
  /** Bailian datacenter category id (required for cloud upload). */
  categoryId: z.string().max(120).optional(),
  /** Bailian / Model Studio workspace id (e.g. llm-xxxx). */
  workspaceId: z.string().max(120).optional(),
  /** Optional Aliyun AccessKey for Bailian OpenAPI Retrieve (preferred for console knowledge bases). */
  accessKeyId: z.string().max(120).optional(),
  accessKeySecret: z.string().max(120).optional(),
  /** Optional OpenAI-compatible embedding endpoint override for vector providers. */
  embeddingBaseUrl: z.string().url().optional(),
  embeddingApiKey: z.string().optional(),
  embeddingModel: z.string().max(120).optional(),
});
export type KnowledgeBaseRuntime = z.infer<typeof KnowledgeBaseRuntimeSchema>;

export const KnowledgeIngestRequestSchema = z.object({
  knowledgeBase: KnowledgeBaseRuntimeSchema,
  title: z.string().min(1).max(240),
  /** Plain-text content (LanceDB). Optional when fileBase64 is provided for Bailian. */
  content: z.string().max(200_000).optional(),
  /** Base64-encoded file bytes for Bailian lease upload. */
  fileBase64: z.string().max(8_000_000).optional(),
  fileName: z.string().max(240).optional(),
  source: z.string().max(500).optional(),
  model: ModelConfigSchema.optional(),
}).refine((value) => Boolean(value.content?.trim() || value.fileBase64?.trim()), {
  message: 'Either content or fileBase64 is required.',
});
export type KnowledgeIngestRequest = z.infer<typeof KnowledgeIngestRequestSchema>;

export const KnowledgeSearchRequestSchema = z.object({
  knowledgeBase: KnowledgeBaseRuntimeSchema,
  query: z.string().min(2).max(800),
  topK: z.number().int().min(1).max(8).default(5),
  model: ModelConfigSchema.optional(),
});
export type KnowledgeSearchRequest = z.infer<typeof KnowledgeSearchRequestSchema>;

export const BailianCreateKnowledgeRequestSchema = z.object({
  accessKeyId: z.string().min(1).max(120),
  accessKeySecret: z.string().min(1).max(120),
  workspaceId: z.string().min(1).max(120),
  name: z.string().min(1).max(20),
  description: z.string().max(1000).optional(),
  embeddingModelName: z.string().max(120).optional(),
});
export type BailianCreateKnowledgeRequest = z.infer<typeof BailianCreateKnowledgeRequestSchema>;

export const BailianDeleteKnowledgeRequestSchema = z.object({
  accessKeyId: z.string().min(1).max(120),
  accessKeySecret: z.string().min(1).max(120),
  workspaceId: z.string().min(1).max(120),
  indexId: z.string().min(1).max(120),
});
export type BailianDeleteKnowledgeRequest = z.infer<typeof BailianDeleteKnowledgeRequestSchema>;

export const KnowledgeManageRequestSchema = z.object({
  knowledgeBase: KnowledgeBaseRuntimeSchema,
  model: ModelConfigSchema.optional(),
});
export type KnowledgeManageRequest = z.infer<typeof KnowledgeManageRequestSchema>;

export const KnowledgeChunksRequestSchema = KnowledgeManageRequestSchema.extend({
  documentId: z.string().min(1).max(240).optional(),
  query: z.string().max(400).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type KnowledgeChunksRequest = z.infer<typeof KnowledgeChunksRequestSchema>;

export const KnowledgeDeleteDocumentRequestSchema = KnowledgeManageRequestSchema.extend({
  documentId: z.string().min(1).max(240),
});
export type KnowledgeDeleteDocumentRequest = z.infer<typeof KnowledgeDeleteDocumentRequestSchema>;

export const KnowledgeDeleteChunkRequestSchema = KnowledgeManageRequestSchema.extend({
  chunkId: z.string().min(1).max(240),
});
export type KnowledgeDeleteChunkRequest = z.infer<typeof KnowledgeDeleteChunkRequestSchema>;

export const KnowledgeJobStatusRequestSchema = KnowledgeManageRequestSchema.extend({
  jobId: z.string().min(1).max(240),
});
export type KnowledgeJobStatusRequest = z.infer<typeof KnowledgeJobStatusRequestSchema>;
export const ChatRequestSchema = z.object({
  profile: AgentProfileSchema,
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) })).min(1),
  model: ModelConfigSchema,
  skills: z.array(AgentSkillRuntimeSchema).max(24).default([]),
  searchProviders: z.array(SearchProviderRuntimeSchema).max(6).default([]),
  mcpConnections: z.array(McpConnectionRuntimeSchema).max(12).default([]),
  knowledgeBases: z.array(KnowledgeBaseRuntimeSchema).max(12).default([]),
  /**
   * Stable run id shared by orchestrator records and the on-disk run workspace
   * (`~/.workmate/workspaces/<runId>`). When omitted, agent-core generates one.
   */
  runId: z.string().min(1).max(120).optional(),
  /**
   * Absolute shared project workspace root. When set, `publish_to_project` may
   * promote deliverables from the isolated run workspace into this directory.
   */
  projectWorkspacePath: z.string().min(1).max(500).optional(),
  /** Soft ceiling for tool/LLM steps in one run. */
  maxSteps: z.number().int().min(4).max(64).optional(),
  /** Wall-clock budget for the whole agent run (ms). */
  runTimeoutMs: z.number().int().min(15_000).max(1_800_000).optional(),
  /** Per MCP tool call budget (ms). */
  mcpToolTimeoutMs: z.number().int().min(3_000).max(300_000).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
