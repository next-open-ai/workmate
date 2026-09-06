import type { ChatRunContext, KeyValueStore, ProjectTask } from '@workmate/orchestrator';
import { ensureModelSecrets } from './secrets.js';

/**
 * Server-side run-context assembly (M0).
 *
 * Lets a remote gateway confirm a project WITHOUT the desktop renderer's
 * per-employee runtime payloads: the orchestrator reads the same domain KV
 * (employee catalog, skill catalog + policies, runtime prefs, MCP/KB config)
 * the renderer writes, plus the keyring model/search secrets requested from
 * the Electron main process.
 *
 * This is a tolerant best-effort v1: missing pieces degrade gracefully
 * (empty tool sets / no model → task fails with a clear message) instead of
 * guessing. Rendering-layer mirrors of normalization live in the renderer
 * stores; when those move into a shared package this file shrinks.
 */

const EMPLOYEES_KEY = 'workspace.custom-employees';
const OVERRIDES_KEY = 'workspace.employee-overrides';
const SKILLS_KEY = 'capabilities.skills.v2';
const POLICIES_KEY = 'capabilities.employee-policies';
const PREFS_KEY = 'workspace.employee-runtime-prefs';
const MCP_KEY = 'capabilities.mcp';
const KB_BASES_KEY = 'capabilities.knowledge';
const KB_PROVIDERS_KEY = 'settings.knowledge-providers';

const PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'ollama', 'openai-compatible']);
const PRESET_EMPLOYEE_NAMES: Record<string, string> = {
  general: 'General Assistant',
  research: 'Research Assistant',
  code: 'Code Assistant',
  administrator: 'Administrator',
};
const PRESET_DEFAULT_INSTRUCTIONS: Record<string, string> = {
  code:
    '凡任务要求「按既定设计规范」但没有提供规范/品牌/页面清单：必须采用一份文档化的默认企业规范（主/辅色、字阶、12 列栅格、断点、页面清单写入 README.md），并直接产出核心可运行页面；不得因缺品牌/规范/文案而停下澄清。只输出文字、不写文件=失败；要么写文件，要么给出精确阻塞点+唯一需要的输入。',
};

const BASELINE_WORKSPACE_SKILL_ID = 'workmate-workspace';
const BASELINE_WORKSPACE_INSTRUCTIONS = `---
name: workmate-workspace
description: Workmate platform workspace harness for isolated read/write and script execution in the current run directory.
---

You are using the **Workmate workspace harness** (workmate-workspace). It is always authorized for this run. Use it for artifacts that belong in the run workspace, not on arbitrary host paths.

- write_workspace_file — create/replace/append text under the workspace (requires workspace-write). Keep each call small (≤6KB); split large HTML/CSS/JS into multiple files or mode "append".
- run_workspace_script — execute a .py/.sh/.js script you wrote into the workspace (requires script permission).
- install_python_dependency — install a PyPI package into .python-packages for workspace scripts only.
- read_workspace_file — read text artifacts already in the workspace.
Only claim a file was saved when the tool returned ok: true.`;

interface EmployeeRow { id?: string; name?: string; instructions?: string; description?: string }
interface SkillRow {
  id?: string; name?: string; description?: string; mode?: string; path?: string; instructions?: string;
  execution?: { allowWorkspaceWrite?: boolean; allowScriptExecution?: boolean; allowedNetworkHosts?: string[]; allowAllNonDestructive?: boolean };
}
interface PolicyRow { employeeId?: string; skillId?: string; mode?: string }
interface PrefsRow {
  defaultModelId?: string | null; searchMode?: string; maxSteps?: number;
  runTimeoutMs?: number; mcpToolTimeoutMs?: number; mcpIds?: string[];
  knowledgeProvider?: string; knowledgeBaseIds?: string[];
  engine?: string | null;
}
interface ModelSettings {
  providerInstances?: Array<{ id?: string; type?: string; name?: string; baseUrl?: string; apiKey?: string; disableThinking?: boolean }>;
  models?: Array<{ id?: string; providerInstanceId?: string; capability?: string; modelId?: string; label?: string }>;
  activeChatModelId?: string | null;
  activeEmbeddingModelId?: string | null;
  employeeDefaultModelIds?: Record<string, string>;
  activeProvider?: string;
  providers?: Array<{ provider?: string; baseUrl?: string; chatModel?: string; apiKey?: string; disableThinking?: boolean }>;
}
interface SearchSettings {
  defaultProvider?: string;
  providers?: Array<{ id?: string; label?: string; apiKey?: string; baseUrl?: string; enabled?: boolean }>;
}

async function kvJson(store: KeyValueStore, key: string): Promise<unknown> {
  const raw = await store.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Build the agent profile for an employee (KV catalog + preset fallback). */
function profileFor(
  employeeId: string,
  employees: EmployeeRow[],
  overrides: Record<string, { description?: string; instructions?: string }>,
): ChatRunContext['profile'] {
  const found = employees.find((item) => item.id === employeeId);
  const override = overrides[employeeId];
  const name = found?.name?.trim() || PRESET_EMPLOYEE_NAMES[employeeId] || 'General Assistant';
  const description = found?.description?.trim() || override?.description?.trim() || '';
  const focus =
    override?.instructions?.trim() ||
    found?.instructions?.trim() ||
    PRESET_DEFAULT_INSTRUCTIONS[employeeId] ||
    '按要求完成任务，不虚构执行结果。';
  const roleBrief = description ? ` Role brief: ${description}` : '';
  const instructions = `${name}（Workmate 数字员工）。${roleBrief} ${focus}`.trim();
  return { id: employeeId, name, instructions, toolIds: [] };
}

/** Resolve a chat ModelConfig from the keyring model-settings snapshot. */
function modelFor(employeeId: string, prefs: PrefsRow, raw: unknown): ChatRunContext['model'] | null {
  const settings = (raw && typeof raw === 'object' ? raw : {}) as ModelSettings;
  const chatModels = Array.isArray(settings.models) ? settings.models.filter((model) => model.capability === 'chat') : [];
  const pick =
    chatModels.find((model) => model.id === prefs.defaultModelId) ??
    chatModels.find((model) => model.id === settings.employeeDefaultModelIds?.[employeeId]) ??
    chatModels.find((model) => model.id === settings.activeChatModelId) ??
    chatModels[0];
  const instances = Array.isArray(settings.providerInstances) ? settings.providerInstances : [];
  const instance = pick ? instances.find((item) => item.id === pick.providerInstanceId) : undefined;

  const embedPick = Array.isArray(settings.models)
    ? settings.models.find((model) => model.id === settings.activeEmbeddingModelId && model.capability === 'embedding')
    : undefined;
  const embedInstance = embedPick ? instances.find((item) => item.id === embedPick.providerInstanceId) : undefined;
  const embeddingFields = embedPick?.modelId?.trim() && embedInstance
    ? {
        embeddingModel: embedPick.modelId.trim(),
        ...(embedInstance.baseUrl?.trim() ? { embeddingBaseUrl: embedInstance.baseUrl.trim() } : {}),
        ...(embedInstance.apiKey?.trim() || embedInstance.type === 'ollama'
          ? { embeddingApiKey: embedInstance.apiKey?.trim() || 'ollama' }
          : {}),
      }
    : {};

  const provider = instance?.type?.trim();
  if (pick && provider && PROVIDER_IDS.has(provider)) {
    return {
      provider: provider as ChatRunContext['model']['provider'],
      ...(instance?.baseUrl?.trim() ? { baseUrl: instance.baseUrl.trim() } : {}),
      chatModel: pick.modelId || pick.id || '',
      ...(instance?.disableThinking ? { disableThinking: true } : {}),
      apiKey: instance?.apiKey ?? '',
      ...embeddingFields,
    };
  }

  // Legacy v1 settings shape.
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const legacy = providers.find((item) => item.provider === (settings.activeProvider || 'openai'));
  if (legacy?.chatModel) {
    const provider = legacy.provider || 'openai';
    if (PROVIDER_IDS.has(provider)) {
      return {
        provider: provider as ChatRunContext['model']['provider'],
        ...(legacy.baseUrl?.trim() ? { baseUrl: legacy.baseUrl.trim() } : {}),
        chatModel: legacy.chatModel,
        ...(legacy.disableThinking ? { disableThinking: true } : {}),
        apiKey: legacy.apiKey ?? '',
        ...(legacy.embeddingModel?.trim() ? { embeddingModel: legacy.embeddingModel.trim() } : {}),
        ...embeddingFields,
      };
    }
  }
  return null;
}

function searchProvidersFor(prefs: PrefsRow, raw: unknown): ChatRunContext['searchProviders'] {
  const mode = prefs.searchMode ?? 'inherit';
  if (mode === 'off' || mode === 'llm-builtin') return [];
  const settings = (raw && typeof raw === 'object' ? raw : {}) as SearchSettings;
  const configured = (settings.providers ?? []).filter((item) => item.enabled && item.apiKey?.trim());
  const selected =
    mode === 'auto' || mode === 'inherit'
      ? configured
      : configured.filter((item) => item.id === mode);
  const defaultId = settings.defaultProvider;
  return selected
    .filter((item) => item && typeof item === 'object' && item.id)
    .map((item) => ({
      id: item.id as ChatRunContext['searchProviders'][number]['id'],
      label: item.label ?? item.id ?? '',
      apiKey: item.apiKey ?? '',
      ...(item.baseUrl?.trim() ? { baseUrl: item.baseUrl.trim() } : {}),
      enabled: true,
      preferred: Boolean(item.id === defaultId),
    }));
}

async function skillRuntimeFor(store: KeyValueStore, task: ProjectTask, tier: string): Promise<ChatRunContext['skills']> {
  const skills = rows(await kvJson(store, SKILLS_KEY)) as SkillRow[];
  const policies = rows(await kvJson(store, POLICIES_KEY)) as PolicyRow[];
  const policiesFor = policies.filter((policy) => policy.employeeId === task.employeeId && policy.mode && policy.mode !== 'disabled');
  const selectedIds = new Set(task.skillIds ?? []);
  const runtime: ChatRunContext['skills'] = [];

  for (const policy of policiesFor) {
    if (selectedIds.size > 0 && !selectedIds.has(policy.skillId ?? '')) continue;
    const skill = skills.find((item) => item.id === policy.skillId);
    if (!skill?.id) continue;
    const execution = skill.execution ?? {};
    const readOnly = tier === 'read-only';
    runtime.push({
      id: skill.id,
      name: skill.name ?? skill.id,
      description: skill.description ?? '',
      mode: policy.mode === 'default' ? 'default' : 'available',
      ...(skill.path ? { rootPath: (skill.path as string).replace(/[\\/][^\\/]+$/, '') } : {}),
      ...(skill.instructions ? { instructions: String(skill.instructions).slice(0, 24_000) } : {}),
      resources: [],
      execution: {
        allowWorkspaceWrite: !readOnly && Boolean(execution.allowWorkspaceWrite),
        allowScriptExecution: !readOnly && Boolean(execution.allowScriptExecution),
        allowedNetworkHosts: execution.allowedNetworkHosts ?? [],
        allowAllNonDestructive: tier === 'full',
      },
    });
  }

  // Platform harness: always injected, gated by the task's permission tier.
  runtime.unshift({
    id: BASELINE_WORKSPACE_SKILL_ID,
    name: 'Workmate Workspace',
    description: 'Platform harness: read/write the isolated run workspace and run workspace scripts.',
    mode: 'default',
    instructions: BASELINE_WORKSPACE_INSTRUCTIONS,
    resources: [],
    execution: {
      allowWorkspaceWrite: tier !== 'read-only',
      allowScriptExecution: tier !== 'read-only',
      allowedNetworkHosts: [],
      allowAllNonDestructive: tier === 'full',
    },
  });
  return runtime;
}

async function mcpConnectionsFor(store: KeyValueStore, prefs: PrefsRow): Promise<ChatRunContext['mcpConnections']> {
  const all = rows(await kvJson(store, MCP_KEY)) as Array<Record<string, unknown>>;
  const wanted = new Set(prefs.mcpIds ?? []);
  const AUTO_SKIP = new Set(['mcp-baseline-playwright', 'mcp-baseline-chrome-devtools']);
  const out: ChatRunContext['mcpConnections'] = [];
  for (const raw of all) {
    const id = String(raw.id ?? '');
    if (!id || raw.enabled === false) continue;
    // Explicit association restricts; empty prefs → enabled connectors minus heavy browsers.
    if (wanted.size > 0) {
      if (!wanted.has(id)) continue;
    } else if (AUTO_SKIP.has(id)) {
      continue;
    }
    // Prefer connectors that passed a probe when metadata is present.
    if (raw.lastTestStatus === 'failed') continue;
    const transport = raw.transport === 'sse' || raw.transport === 'http' || raw.transport === 'stdio' ? raw.transport : 'http';
    const base = { id, name: String(raw.name ?? id), enabled: true, description: raw.description ? String(raw.description) : undefined };
    if (transport === 'stdio' && raw.command) {
      out.push({
        ...base,
        transport,
        command: String(raw.command),
        args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
        ...(raw.env && typeof raw.env === 'object' ? { env: raw.env as Record<string, string> } : {}),
        ...(raw.cwd ? { cwd: String(raw.cwd) } : {}),
      });
    } else if (raw.url) {
      out.push({ ...base, transport: transport === 'sse' ? 'sse' : 'http', url: String(raw.url), ...(raw.apiKey ? { apiKey: String(raw.apiKey) } : {}) });
    }
  }
  // Prefer market-data connectors first so they load even if later stdio servers are slow.
  const rank = (id: string) => {
    if (id.includes('stock') || id.includes('akshare')) return 0;
    if (id.includes('fetch') || id.includes('memory')) return 1;
    return 2;
  };
  out.sort((a, b) => rank(a.id) - rank(b.id));
  return out.slice(0, 12);
}

async function knowledgeBasesFor(store: KeyValueStore, prefs: PrefsRow): Promise<ChatRunContext['knowledgeBases']> {
  const provider = prefs.knowledgeProvider;
  if (!provider || provider === 'off') return [];
  const bases = rows(await kvJson(store, KB_BASES_KEY)) as Array<Record<string, unknown>>;
  const providersRaw = rows(await kvJson(store, KB_PROVIDERS_KEY)) as Array<Record<string, unknown>>;
  const wanted = new Set(prefs.knowledgeBaseIds ?? []);
  const out: ChatRunContext['knowledgeBases'] = [];
  for (const raw of bases) {
    const id = String(raw.id ?? '');
    if (!id || String(raw.provider ?? '') !== provider) continue;
    if (wanted.size > 0 && !wanted.has(id)) continue;
    const providerRow = providersRaw.find((item) => String(item.id ?? '') === provider || String(item.provider ?? '') === provider);
    const apiKey = raw.apiKey ? String(raw.apiKey) : providerRow?.apiKey ? String(providerRow.apiKey) : undefined;
    out.push({
      id,
      name: String(raw.name ?? id),
      provider: String(raw.provider ?? provider) as ChatRunContext['knowledgeBases'][number]['provider'],
      enabled: raw.enabled !== false,
      description: raw.description ? String(raw.description) : undefined,
      ...(raw.dataDir ? { dataDir: String(raw.dataDir) } : {}),
      ...(raw.baseUrl ? { baseUrl: String(raw.baseUrl) } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(raw.externalId ? { externalId: String(raw.externalId) } : {}),
    });
  }
  return out;
}

/**
 * MCP connectors for an employee (prefs association, or auto-default when empty).
 * Independent of model resolution so chat can backfill tools even when the
 * client already supplied the model.
 */
export async function resolveEmployeeMcpConnections(
  store: KeyValueStore,
  employeeId: string,
): Promise<ChatRunContext['mcpConnections']> {
  const prefsRaw = await kvJson(store, PREFS_KEY);
  const prefsAll = prefsRaw && typeof prefsRaw === 'object' ? (prefsRaw as Record<string, unknown>) : {};
  const prefs = (prefsAll[employeeId] ?? {}) as PrefsRow;
  return mcpConnectionsFor(store, prefs);
}

/**
 * Build a best-effort run context for a project task using domain KV + the
 * keyring secrets. Returns null when no chat model can be resolved.
 */
export async function resolveTaskContext(store: KeyValueStore, task: ProjectTask): Promise<ChatRunContext | null> {
  const employees = rows(await kvJson(store, EMPLOYEES_KEY)) as EmployeeRow[];
  const overridesRaw = await kvJson(store, OVERRIDES_KEY);
  const overrides = overridesRaw && typeof overridesRaw === 'object' ? (overridesRaw as Record<string, { description?: string; instructions?: string }>) : {};
  const prefsRaw = await kvJson(store, PREFS_KEY);
  const prefsAll = prefsRaw && typeof prefsRaw === 'object' ? (prefsRaw as Record<string, unknown>) : {};
  const prefs = (prefsAll[task.employeeId] ?? {}) as PrefsRow;
  // Refresh keyring when empty: model settings are often saved after API boot.
  const secrets = await ensureModelSecrets();

  const model = modelFor(task.employeeId, prefs, secrets.model);
  if (!model) return null;

  const tier = task.permissionTier ?? 'default';
  const searchMode = prefs.searchMode;
  const enableSearch = searchMode === 'llm-builtin' && (model.provider === 'qwen' || model.provider === 'openai-compatible');
  const maxSteps = prefs.maxSteps && prefs.maxSteps >= 4 ? prefs.maxSteps : 28;
  const runTimeoutMs = prefs.runTimeoutMs ?? 600_000;
  const mcpToolTimeoutMs = prefs.mcpToolTimeoutMs ?? 60_000;
  const engineRaw = String(prefs.engine || '').trim().toLowerCase();
  const engine =
    engineRaw === 'pi' || engineRaw === 'agentscope' || engineRaw === 'dsh'
      ? engineRaw
      : undefined;

  return {
    profile: profileFor(task.employeeId, employees, overrides),
    model: enableSearch ? { ...model, enableSearch: true } : model,
    skills: await skillRuntimeFor(store, task, tier),
    searchProviders: enableSearch ? [] : searchProvidersFor(prefs, secrets.search),
    mcpConnections: await mcpConnectionsFor(store, prefs),
    knowledgeBases: await knowledgeBasesFor(store, prefs),
    maxSteps,
    runTimeoutMs,
    mcpToolTimeoutMs,
    ...(engine ? { engine } : {}),
  };
}
