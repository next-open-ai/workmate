import { computed, ref } from 'vue';
import { materializeWorkspaceAssets, streamChat, syncWorkspaceRun, type RuntimeSkill, type ToolActivity, type ToolApproval, type SearchSource } from '../services/api.js';
import * as orch from '../services/orchestration.js';
import type { ProviderConfig } from './model-config.js';
import { toModelPayload, useModelConfig } from './model-config.js';
import { useSearchConfig } from './search-config.js';
import { DEFAULT_MAX_STEPS, DEFAULT_MCP_TOOL_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS, useEmployeeRuntimePrefs } from './employee-prefs.js';
import { useMcpConfig } from './mcp-config.js';
import { useKnowledgeConfig } from './kb-config.js';
import { readStored, writeStored } from './storage.js';
import {
  BASELINE_WORKSPACE_SKILL_ID,
  mergeRuntimeSkills,
} from './baseline-skills.js';
import { useCapabilities, type ExecutionLevel } from './capabilities.js';
import { useAssets, type Asset } from './assets.js';
import type { Automation } from './automations.js';
import {
  useEmployeeCatalog,
  type Employee,
  type EmployeeDraft,
  type EmployeeId,
} from './employees.js';

export type { Employee, EmployeeDraft, EmployeeId } from './employees.js';
export type View = 'chat' | 'employees' | 'capabilities' | 'knowledge' | 'assets' | 'automations' | 'projects' | 'remote' | 'env' | 'settings';
export type CollaborationDelivery = 'synthesize' | 'direct';
export interface CollaborationRun { employeeId: EmployeeId; task: string; status: 'running' | 'completed' | 'failed'; summary: string; activities: ToolActivity[]; error?: string; }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; activities?: ToolActivity[]; approvals?: ToolApproval[]; assets?: Asset[]; sources?: Array<SearchSource & { provider: string }>; collaborations?: CollaborationRun[]; collaborationDelivery?: CollaborationDelivery; }
export interface Conversation { id: string; title: string; employeeId: EmployeeId; messages: Message[]; updatedAt: number; serverSessionId?: string; }
export interface ProjectTaskDraft { title: string; objective: string; employeeId: EmployeeId; skillIds: string[]; dependsOn?: number[]; contract?: { outputs?: string[]; acceptance?: string; timeoutMs?: number; maxAttempts?: number } };
export interface ProjectTaskTranscript {
  assistantContent: string;
  activities: ToolActivity[];
  approvals: ToolApproval[];
  assets: Array<{ id: string; name: string; sizeBytes: number; runId?: string }>;
  sources?: SearchSource[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens: number;
  };
  model?: { provider: string; chatModel: string; baseUrl?: string; providerLabel?: string };
  trace?: Array<{ type: string; toolName?: string; summary?: string; message?: string; reason?: 'user' | 'timeout' }>;
  runId?: string;
}

/** Keep in sync with agent-core deliverable contract: only output/ is archived. */
const NEVER_DELIVERABLE_EXT = new Set(['pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map']);
const PROCESS_ONLY_DIRS = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);

function isUserFacingDeliverablePath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] !== 'output' || parts.length < 2) return false;
  if (parts.some((part) => !part || part === '.' || part === '..' || PROCESS_ONLY_DIRS.has(part))) return false;
  const base = parts[parts.length - 1] || '';
  if (base.startsWith('.') && base !== '.gitkeep') return false;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return Boolean(ext) && !NEVER_DELIVERABLE_EXT.has(ext);
}

function alreadyHasAsset(assets: Asset[] | undefined, runId: string, relativePath: string) {
  const base = relativePath.split('/').pop() || relativePath;
  return Boolean(assets?.some((item) =>
    item.id && (
      (item.runId === runId && (item.workspaceRelative === relativePath || item.name === base))
      || item.workspaceRelative === relativePath
    )));
}

const view = ref<View>('chat');
const currentEmployeeId = ref<EmployeeId>('general');
const conversations = ref<Conversation[]>([]);
const activeConversationId = ref<string | null>(null);
const permissionTierByEmployee = ref<Record<string, ExecutionLevel>>({});
const sessionGrants = new Map<string, Set<ToolApproval['capability']>>();
/** Aborts the in-flight chat/MCP run (and closes server-side resources via disconnect). */
let activeRunAbort: AbortController | null = null;

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError');
}

function markActivitiesInterrupted(activities?: ToolActivity[]) {
  if (!activities?.length) return;
  for (const activity of activities) {
    if (activity.status === 'running') {
      activity.status = 'failed';
      activity.summary = activity.summary ? `${activity.summary}（已中止）` : '已中止';
    }
  }
}

const catalog = useEmployeeCatalog();
const employees = catalog.employees;

function labelEmployee(employee: Employee) {
  if (employee.name?.trim()) return employee.name.trim();
  if (employee.id === 'general') return '通用助理';
  if (employee.id === 'research') return '研究助理';
  if (employee.id === 'code') return '编程助理';
  if (employee.id === 'administrator') return '系统管理员';
  return employee.id;
}

function profileInstructions(employee: Employee, extra = '') {
  const role = employee.name?.trim()
    || (employee.id === 'general' ? 'General Assistant'
      : employee.id === 'research' ? 'Research Assistant'
        : employee.id === 'code' ? 'Coding Assistant'
          : employee.id === 'administrator' ? 'System Administrator'
            : employee.id);
  const focus = employee.instructions?.trim()
    || (employee.id === 'research' ? 'Focus on facts, evidence, sources, and uncertainty.'
      : employee.id === 'code' ? 'Focus on technical feasibility, implementation paths, and verification.'
        : employee.id === 'administrator' ? 'Focus on permissions, safety, runtime boundaries, and governance risk.'
          : employee.id === 'general' ? 'Focus on clear answers, writing quality, and practical next steps.'
            : 'Be helpful, accurate, and concise.');
  const roleBrief = employee.description?.trim() ? ` Role brief: ${employee.description.trim()}` : '';
  return `You are Workmate's digital employee "${role}" (${employee.id}).${roleBrief} ${focus} Reply in the user's language. ${extra}`.trim();
}

function collaboratorFocus(employee: Employee) {
  if (employee.instructions?.trim()) return employee.instructions.trim();
  if (employee.id === 'research') return '聚焦事实、证据、资料线索与不确定性；给出可核查的研究简报。';
  if (employee.id === 'code') return '聚焦技术可行性、实现路径、工程风险与验证建议；给出技术简报。';
  if (employee.id === 'administrator') return '聚焦权限、安全、运行边界和治理风险；给出审查简报。';
  if (employee.id === 'general') return '聚焦用户目标、执行方案、交付结构与表达方式；给出行动简报。';
  return `以「${labelEmployee(employee)}」的职责完成简报：${employee.description || '聚焦用户目标并给出可执行建议。'}`;
}

async function persist() { await writeStored('workspace.conversations', JSON.stringify(conversations.value)); }
/** Set inside useWorkspace() once server-backed chat helpers exist. */
let hydrateServerHook: (() => Promise<void>) | null = null;
async function load() {
  await catalog.load();
  try { conversations.value = JSON.parse((await readStored('workspace.conversations')) ?? '[]') as Conversation[]; } catch { conversations.value = []; }
  const employee = await readStored('workspace.default-employee');
  if (employee && employees.value.some((item) => item.id === employee)) currentEmployeeId.value = employee;
  else if (!employees.value.some((item) => item.id === currentEmployeeId.value)) currentEmployeeId.value = employees.value[0]?.id ?? 'general';
  activeConversationId.value = conversations.value[0]?.id ?? null;
  permissionTierByEmployee.value = parsePermissionTiers(await readStored('workspace.permission-tiers'));
  await hydrateServerHook?.();
}
function parsePermissionTiers(value: string | null): Record<string, ExecutionLevel> { try { const parsed = JSON.parse(value || '{}') as Record<string, unknown>; return Object.fromEntries(Object.entries(parsed).filter(([, tier]) => tier === 'read-only' || tier === 'default' || tier === 'full')) as Record<string, ExecutionLevel>; } catch { return {}; } }


export function useWorkspace() {
  const { runtimeProviders, runtimeProvidersFor, load: loadSearchConfig } = useSearchConfig();
  void loadSearchConfig();
  const { get: getEmployeePrefs, load: loadEmployeePrefs } = useEmployeeRuntimePrefs();
  void loadEmployeePrefs();
  const { runtimePayload: mcpRuntimePayload, load: loadMcpConfig, connections: mcpConnectionsState } = useMcpConfig();
  void loadMcpConfig();
  const { runtimePayload: kbRuntimePayload, load: loadKnowledgeConfig } = useKnowledgeConfig();
  void loadKnowledgeConfig();
  const { allowedSkillsFor, policyFor, skills, setExecutionPolicy } = useCapabilities();
  const { archiveArtifact } = useAssets();
  const { modelForEmployee } = useModelConfig();

  const runOptionsFor = (employeeId: EmployeeId, onlineSearch = true) => {
    const prefs = getEmployeePrefs(employeeId);
    const timeouts = {
      runTimeoutMs: prefs.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS,
      mcpToolTimeoutMs: prefs.mcpToolTimeoutMs || DEFAULT_MCP_TOOL_TIMEOUT_MS,
    };
    if (!onlineSearch || prefs.searchMode === 'off') {
      return {
        searchProviders: [] as ReturnType<typeof runtimeProvidersFor>,
        enableBuiltinSearch: false,
        maxSteps: prefs.maxSteps || DEFAULT_MAX_STEPS,
        ...timeouts,
        mcpConnections: mcpRuntimePayload(prefs.mcpIds),
        knowledgeBases: kbRuntimePayload(prefs.knowledgeBaseIds, prefs.knowledgeProvider),
      };
    }
    const enableBuiltinSearch = prefs.searchMode === 'llm-builtin';
    return {
      searchProviders: enableBuiltinSearch ? [] : runtimeProvidersFor(prefs.searchMode),
      enableBuiltinSearch,
      maxSteps: prefs.maxSteps || DEFAULT_MAX_STEPS,
      ...timeouts,
      mcpConnections: mcpRuntimePayload(prefs.mcpIds),
      knowledgeBases: kbRuntimePayload(prefs.knowledgeBaseIds, prefs.knowledgeProvider),
    };
  };

  const abortActiveRun = () => {
    const serverRun = activeConversationId.value ? serverActiveRuns.get(activeConversationId.value) : undefined;
    if (serverRun) void orch.cancelChatRun(serverRun.sessionId).catch(() => undefined);
    if (activeRunAbort) {
      activeRunAbort.abort();
      return true;
    }
    return Boolean(serverRun);
  };

  /* ------------------------------------------------------------------ *
   * Server-backed chat sessions (M0)
   *
   * Desktop conversations may live on the orchestration server
   * (`/api/orch/sessions`); the server owns run/approval state machines and
   * the page mirrors it via SSE + polling. Enabled when the renderer runs
   * inside Electron (window.workmateDesktop present) and the caller does not
   * request legacy collaborator briefs.
   * ------------------------------------------------------------------ */

  const serverChatActive = () => Boolean(window.workmateDesktop);
  const serverActiveRuns = new Map<string, { sessionId: string; unsubscribe: () => void }>();
  const serverBump = () => {
    conversations.value = [...conversations.value];
  };

  async function ensureServerSession(conversation: Conversation, firstText: string): Promise<string> {
    if (conversation.serverSessionId) return conversation.serverSessionId;
    const session = await orch.createChatSession({ title: conversation.title || firstText.slice(0, 28), employeeId: conversation.employeeId });
    conversation.serverSessionId = session.id;
    await persist();
    return session.id;
  }

  /** Align a local conversation mirror with the server's canonical session. */
  async function alignServerConversation(conversation: Conversation, sessionId: string): Promise<void> {
    const session = await orch.getChatSession(sessionId);
    if (!session) return;
    const preserved = new Map<string, Message>(conversation.messages.map((message) => [message.id, message]));
    conversation.messages = session.messages
      .filter((message) => !message.superseded)
      .map((message) => {
        const old = preserved.get(message.id);
        const base: Message = {
          id: message.id,
          role: message.role,
          content: message.content,
        };
        if (message.role === 'assistant' && old) {
          base.activities = old.activities ?? [];
          base.approvals = old.approvals ?? [];
          base.assets = old.assets ?? [];
          base.sources = old.sources ?? [];
        }
        return base;
      });
    conversation.updatedAt = session.updatedAt;
    serverBump();
    await persist();
  }

  async function archiveServerArtifact(conversation: Conversation, assistantMessage: Message, runId: string, relativePath: string) {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!isUserFacingDeliverablePath(normalized) || alreadyHasAsset(assistantMessage.assets, runId, normalized)) return;
    try {
      const asset = await archiveArtifact({
        runId,
        relativePath: normalized,
        conversationId: conversation.id,
        employeeId: conversation.employeeId,
      });
      if (!assistantMessage.assets?.some((item) => item.id === asset.id)) assistantMessage.assets?.push(asset as Asset);
      serverBump();
    } catch (error) {
      const message = error instanceof Error ? error.message : '资产归档失败。';
      if (/Only business deliverables|Only user-facing deliverables|no longer available/i.test(message)) return;
      assistantMessage.activities?.push({ toolName: 'archive_asset', status: 'failed', summary: message });
    }
  }

  /**
   * Merge a settled server turn into the local mirror without discarding the
   * SSE-collected detail of this turn. The server owns durable message ids and
   * the final assistant text (it persists content only after the run settles),
   * so we adopt the server ids/content for THIS turn while keeping the local
   * activities/approvals/assets gathered live via SSE.
   */
  async function syncServerTurnToMirror(conversation: Conversation, userMessage: Message, assistantMessage: Message, sessionId: string, runId: string): Promise<void> {
    const session = await orch.getChatSession(sessionId);
    if (!session) return;
    const visible = session.messages.filter((message) => !message.superseded);
    const serverUser = [...visible].reverse().find((message) => message.role === 'user' && message.content === userMessage.content);
    const serverAssistant = visible.find((message) => message.role === 'assistant' && message.runId === runId);
    if (serverUser && userMessage.id !== serverUser.id) userMessage.id = serverUser.id;
    if (serverAssistant) {
      if (assistantMessage.id !== serverAssistant.id) assistantMessage.id = serverAssistant.id;
      // Adopt the durable final text. This is what makes the reply appear even
      // when deltas were missed (SSE gap) or the run outlived the subscription.
      if (serverAssistant.content && assistantMessage.content !== serverAssistant.content) assistantMessage.content = serverAssistant.content;
    }
    conversation.updatedAt = session.updatedAt;
    serverBump();
    await persist();
  }

  async function serverChatTurn(
    conversation: Conversation,
    userMessage: Message,
    assistantMessage: Message,
    text: string,
    model: ProviderConfig,
    skillIds?: string[],
  ) {
    const sessionId = await ensureServerSession(conversation, text);
    const previous = serverActiveRuns.get(conversation.id);
    if (previous) previous.unsubscribe();

    const abort = new AbortController();
    activeRunAbort = abort;
    // Subscribe BEFORE posting the message so no early run event (first delta,
    // approval/activity, artifact…) is lost between the POST and the subscribe.
    // Until sendChatMessage returns the runId, buffer events then replay — do not
    // drop early deltas (that looked like "wait for full answer then dump").
    let currentRunId: string | null = null;
    const pendingEvents: orch.OrcEvent[] = [];
    let sseLive = false;
    let sseResolved = false;
    let sseError: string | null = null;

    let settleRun: ((info: { status?: string; error?: string }) => void) | null = null;
    const settledViaSse = new Promise<{ status?: string; error?: string }>((resolve) => {
      settleRun = resolve;
    });

    const applyServerEvent = (event: orch.OrcEvent) => {
      if (event.runId && currentRunId && event.runId !== currentRunId) return;
      if (event.type === 'run.settled') {
        settleRun?.({ status: event.status, error: event.error });
        settleRun = null;
        return;
      }
      if (event.type === 'run.delta' && event.text) {
        assistantMessage.content += event.text;
        serverBump();
      } else if (event.type === 'run.activity' && event.activity) {
        const activity = event.activity;
        const existing = assistantMessage.activities?.find((item) => item.toolName === activity.toolName && item.status === 'running');
        if (existing && activity.status !== 'running') Object.assign(existing, activity);
        else assistantMessage.activities?.push({ toolName: activity.toolName, summary: activity.summary, status: activity.status });
        serverBump();
      } else if (event.type === 'run.approval' && event.approval) {
        const approval = event.approval;
        if (!assistantMessage.approvals?.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) {
          assistantMessage.approvals?.push({ id: approval.id, skillId: approval.skillId, capability: approval.capability, summary: approval.summary });
          serverBump();
        }
      } else if (event.type === 'run.artifact' && event.artifact && event.runId) {
        void archiveServerArtifact(conversation, assistantMessage, event.runId, event.artifact.path);
      } else if (event.type === 'run.sources' && event.sources) {
        assistantMessage.sources = event.sources.map((source) => ({ ...source, provider: String(event.provider ?? '') }));
        serverBump();
      }
    };

    const unsubscribe = orch.subscribeSessionEvents(
      sessionId,
      (event) => {
        if (!currentRunId) {
          pendingEvents.push(event);
          return;
        }
        applyServerEvent(event);
      },
      {
        signal: abort.signal,
        onStatus: (status, detail) => {
          sseResolved = true;
          if (status === 'open') {
            sseLive = true;
            sseError = null;
            return;
          }
          if (status === 'error') {
            sseLive = false;
            sseError = detail || 'SSE stream failed';
            console.warn(`[workmate] session SSE unavailable (${sseError}); falling back to run.transcript polling`);
          } else if (status === 'closed') {
            sseLive = false;
          }
        },
      },
    );
    serverActiveRuns.set(conversation.id, { sessionId, unsubscribe });
    try {
      // Prefer renderer-assembled context (includes employee MCP prefs). Server
      // KV fallback alone misses unsynced / never-saved runtime prefs.
      await loadMcpConfig({ force: mcpConnectionsState.value.length === 0 });
      const employee = employees.value.find((item) => item.id === conversation.employeeId) ?? currentEmployee.value;
      const onlineSearch = getEmployeePrefs(employee.id).searchMode !== 'off';
      const opts = runOptionsFor(employee.id, onlineSearch);
      const skills = await skillRuntimeFor(employee.id, skillIds);
      const runModel = modelForEmployee(employee.id, model) ?? model;
      const context = {
        profile: {
          id: employee.id,
          name: labelEmployee(employee),
          toolIds: skills.map((skill) => skill.id),
          instructions: profileInstructions(employee),
        },
        model: toModelPayload(runModel, { enableSearch: opts.enableBuiltinSearch }),
        skills,
        searchProviders: opts.searchProviders,
        mcpConnections: opts.mcpConnections,
        knowledgeBases: opts.knowledgeBases,
        maxSteps: opts.maxSteps,
        runTimeoutMs: opts.runTimeoutMs,
        mcpToolTimeoutMs: opts.mcpToolTimeoutMs,
      };
      if (!context.mcpConnections.length) {
        console.warn('[workmate] chat context has 0 MCP connectors; server may backfill from KV');
      } else {
        console.info(`[workmate] chat context MCP connectors: ${context.mcpConnections.map((item) => item.name).join(', ')}`);
      }
      const result = await orch.sendChatMessage(sessionId, {
        content: text,
        employeeId: conversation.employeeId,
        context,
      });
      const runId = result.runId;
      currentRunId = runId;
      for (const event of pendingEvents) applyServerEvent(event);
      pendingEvents.length = 0;
      await waitForServerSettled(sessionId, runId, abort, assistantMessage, () => ({ sseLive, sseResolved, sseError }), settledViaSse);
    } finally {
      unsubscribe();
      serverActiveRuns.delete(conversation.id);
      if (activeRunAbort === abort) activeRunAbort = null;
    }
    if (abort.signal.aborted || !currentRunId) {
      const reason = abort.signal.reason instanceof Error
        ? abort.signal.reason.message
        : typeof abort.signal.reason === 'string'
          ? abort.signal.reason
          : '已由用户中止当前执行。';
      throw Object.assign(new Error(reason || '已由用户中止当前执行。'), { name: 'AbortError' });
    }
    await syncServerTurnToMirror(conversation, userMessage, assistantMessage, sessionId, currentRunId);
    if (!assistantMessage.content.trim()) {
      const runs = await orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]);
      const run = runs.find((item) => item.id === currentRunId);
      if (run?.error) {
        const friendly = /terminated|econnreset|network|ssl|tls|stream idle|timeout/i.test(run.error)
          ? '模型流已中断（长时间无响应，常见于 VPN/网络切换）。已自动结束本轮，请重试。'
          : run.error;
        assistantMessage.content = `⚠ ${friendly}`;
        serverBump();
      }
    } else {
      const runs = await orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]);
      const run = runs.find((item) => item.id === currentRunId);
      if (run && (run.status === 'failed' || run.status === 'cancelled') && run.error) {
        const friendly = /terminated|econnreset|network|ssl|tls|stream idle|timeout/i.test(run.error)
          ? '模型流已中断（长时间无响应，常见于 VPN/网络切换）。已自动结束本轮，请重试。'
          : run.error;
        if (!assistantMessage.content.includes(friendly)) {
          assistantMessage.content = `${assistantMessage.content.trim()}\n\n⚠ ${friendly}`;
          serverBump();
        }
      }
    }
    return {
      conversationId: conversation.id,
      transcript: {
        prompt: userMessage.content,
        conversationId: conversation.id,
        assistantContent: assistantMessage.content,
        activities: [...(assistantMessage.activities ?? [])],
        approvals: [...(assistantMessage.approvals ?? [])],
        assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
        runId: currentRunId,
      },
    };
  }

  /**
   * Wait until a server run is truly settled and durable.
   *
   * Prefer SSE `run.settled` (already published by RunEngine). Aggressive 300ms
   * dual polling of session+runs was burning CPU and log noise during the whole
   * model-generation window. Sparse poll remains only as backup / transcript
   * hydration when SSE is down or silent.
   *
   * VPN / network flaps can leave the provider stream half-open: tools finish,
   * partial text is visible, but status stays `running`. If the polled run
   * fingerprint stops changing for STREAM_IDLE_MS, cancel the server run so the
   * UI can leave the spinning state.
   */
  async function waitForServerSettled(
    sessionId: string,
    runId: string,
    abort: AbortController,
    assistantMessage: Message,
    sseState?: () => { sseLive: boolean; sseResolved: boolean; sseError: string | null },
    settledViaSse?: Promise<{ status?: string; error?: string }>,
  ): Promise<void> {
    const deadline = Date.now() + 12 * 60_000;
    const STREAM_IDLE_MS = 120_000;
    const POLL_MS_SSE_LIVE = 2_500;
    const POLL_MS_FALLBACK = 800;
    let lastFingerprint = '';
    let lastProgressAt = Date.now();
    let warnedSseGap = false;
    let settled = false;

    const markSettled = () => { settled = true; };
    if (settledViaSse) {
      void settledViaSse.then(markSettled, () => undefined);
    }

    while (Date.now() < deadline) {
      if (abort.signal.aborted) return;
      if (settled) {
        // Session assistant text is written after run.settled; brief catch-up.
        for (let i = 0; i < 6; i += 1) {
          if (abort.signal.aborted) return;
          const [session, runs] = await Promise.all([
            orch.getChatSession(sessionId).catch(() => null),
            orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]),
          ]);
          const run = runs.find((item) => item.id === runId);
          const assistant = session?.messages.find(
            (message) => message.role === 'assistant' && message.runId === runId,
          );
          if (run?.transcript && run.transcript.length > assistantMessage.content.length) {
            const local = assistantMessage.content;
            const remote = run.transcript;
            if (remote.startsWith(local) || !local.trim()) {
              assistantMessage.content = remote;
              serverBump();
            }
          }
          const contentReady = Boolean(assistant?.content.trim()) || Boolean(run?.transcript?.trim()) || Boolean(assistantMessage.content.trim());
          const errored = run?.status === 'failed' || run?.status === 'cancelled';
          const parked = run?.status === 'waiting-approval';
          if (contentReady || errored || parked || !run || run.status !== 'running') return;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return;
      }

      const status = sseState?.();
      const sseOk = Boolean(status?.sseLive && !status.sseError);
      const needsPollHydration = Boolean(
        status?.sseResolved && (!status.sseLive || status.sseError || !assistantMessage.content.trim()),
      );

      if (needsPollHydration || !sseOk || Date.now() - lastProgressAt >= POLL_MS_SSE_LIVE) {
        const [session, runs] = await Promise.all([
          orch.getChatSession(sessionId).catch(() => null),
          orch.sessionRuns(sessionId).catch(() => [] as orch.ServerRunRecord[]),
        ]);
        const run = runs.find((item) => item.id === runId);
        const assistant = session?.messages.find(
          (message) => message.role === 'assistant' && message.runId === runId,
        );

        const preferTranscript = Boolean(status?.sseResolved && (!status.sseLive || status.sseError));
        const silentSseGap = Boolean(
          status?.sseLive
          && !assistantMessage.content.trim()
          && (run?.transcript?.length ?? 0) > 0
          && Date.now() - lastProgressAt >= 1_500,
        );
        if ((preferTranscript || silentSseGap) && run?.transcript) {
          const local = assistantMessage.content;
          const remote = run.transcript;
          if (remote.length > local.length && (remote.startsWith(local) || !local.trim())) {
            assistantMessage.content = remote;
            serverBump();
            if (!warnedSseGap) {
              warnedSseGap = true;
              console.warn('[workmate] adopted run.transcript via poll (SSE gap or offline)');
            }
          }
        }
        if (run?.activities?.length) {
          let activitiesChanged = false;
          for (const activity of run.activities) {
            const existing = assistantMessage.activities?.find(
              (item) => item.toolName === activity.toolName && item.summary === activity.summary,
            );
            if (existing) {
              if (existing.status !== activity.status) {
                existing.status = activity.status;
                activitiesChanged = true;
              }
            } else {
              assistantMessage.activities?.push({ toolName: activity.toolName, summary: activity.summary, status: activity.status });
              activitiesChanged = true;
            }
          }
          if (activitiesChanged) serverBump();
        }

        if (run && run.status !== 'running') {
          const contentReady = Boolean(assistant?.content.trim()) || Boolean(run.transcript?.trim()) || Boolean(assistantMessage.content.trim());
          const errored = run.status === 'failed' || run.status === 'cancelled';
          const parked = run.status === 'waiting-approval';
          if (contentReady || errored || parked) return;
        }

        const fingerprint = [
          run?.status ?? 'missing',
          run?.transcript?.length ?? 0,
          run?.activities?.length ?? 0,
          assistant?.content?.length ?? 0,
          run?.error ?? '',
        ].join('|');
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          lastProgressAt = Date.now();
        } else if (run?.status === 'running' && Date.now() - lastProgressAt >= STREAM_IDLE_MS) {
          await orch.cancelChatRun(sessionId).catch(() => undefined);
          abort.abort(new Error('模型流已中断（长时间无响应，常见于 VPN/网络切换）。已自动结束本轮，请重试。'));
          return;
        }
      } else if (assistantMessage.content.trim()) {
        lastProgressAt = Date.now();
      }

      const pollMs = sseOk && !needsPollHydration ? POLL_MS_SSE_LIVE : POLL_MS_FALLBACK;
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, pollMs)),
        settledViaSse?.then(() => undefined) ?? new Promise<void>(() => undefined),
      ]);
    }
    await orch.cancelChatRun(sessionId).catch(() => undefined);
    abort.abort(new Error('等待模型回合结束超时，已自动中止。'));
  }

  async function hydrateServerConversations(): Promise<void> {
    if (!serverChatActive()) return;
    const sessions = await orch.listChatSessions().catch(() => [] as orch.ServerChatSession[]);
    if (!sessions.length) return;
    const next = [...conversations.value];
    const byServerId = new Map(next.filter((c) => c.serverSessionId).map((c) => [c.serverSessionId!, c]));
    for (const session of sessions) {
      const existing = byServerId.get(session.id);
      if (existing) {
        await alignServerConversation(existing, session.id).catch(() => undefined);
      } else {
        const conversation: Conversation = {
          id: crypto.randomUUID(),
          title: session.title || '服务端会话',
          employeeId: session.employeeId,
          messages: [],
          updatedAt: session.updatedAt,
          serverSessionId: session.id,
        };
        next.unshift(conversation);
        await alignServerConversation(conversation, session.id).catch(() => undefined);
      }
    }
    conversations.value = next;
  }
  hydrateServerHook = hydrateServerConversations;

  const permissionTier = computed<ExecutionLevel>(() => permissionTierByEmployee.value[currentEmployeeId.value] ?? 'default');
  /** Avoid re-reading every Skill file on consecutive turns / double-load in addMessage. */
  const skillRuntimeCache = new Map<string, { at: number; skills: RuntimeSkill[] }>();
  const SKILL_RUNTIME_CACHE_TTL_MS = 45_000;
  const skillRuntimeFor = async (employeeId: EmployeeId, onlySkillIds?: string[], tierOverride?: ExecutionLevel): Promise<RuntimeSkill[]> => {
    const tier = tierOverride ?? permissionTierByEmployee.value[employeeId] ?? 'default';
    const grantKey = [...sessionGrants.entries()]
      .map(([id, caps]) => `${id}:${[...caps].sort().join('+')}`)
      .sort()
      .join(',');
    const filterKey = onlySkillIds?.length ? [...onlySkillIds].sort().join(',') : '*';
    const cacheKey = `${employeeId}|${tier}|${filterKey}|${grantKey}`;
    const cached = skillRuntimeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SKILL_RUNTIME_CACHE_TTL_MS) {
      return cached.skills.map((skill) => ({
        ...skill,
        resources: skill.resources ? [...skill.resources] : [],
        execution: { ...skill.execution },
      }));
    }
    const authorized = allowedSkillsFor(employeeId).filter((skill) => skill.id !== BASELINE_WORKSPACE_SKILL_ID && (!onlySkillIds?.length || onlySkillIds.includes(skill.id))).sort((left, right) => (policyFor(employeeId, right.id)?.mode === 'default' ? 1 : 0) - (policyFor(employeeId, left.id)?.mode === 'default' ? 1 : 0));
    const userSkills = await Promise.all(authorized.map(async (skill) => {
      const mode = policyFor(employeeId, skill.id)?.mode === 'default' ? 'default' as const : 'available' as const;
      let instructions: string | undefined;
      let resources: RuntimeSkill['resources'] = [];
      const rootPath = skill.path?.replace(/[\\/][^\\/]+$/, '');
      // Progressive disclosure: only hydrate full SKILL.md (+ resources) for
      // default-mode skills. Available skills stay metadata-only until load_skill.
      if (mode === 'default' && skill.path) {
        try {
          const api = await import('../services/api');
          instructions = (await api.readSkillFile(skill.path)).content.slice(0, 24_000);
          const files = await api.listSkillFiles(skill.path);
          const readable = files.filter((file) => file.type === 'file' && file.relative !== 'SKILL.md' && /\.(md|txt|json|ya?ml)$/i.test(file.relative)).slice(0, 20);
          resources = (await Promise.all(readable.map(async (file) => {
            try { const result = await api.readSkillFile(file.path); return result ? { path: file.relative, content: result.content.slice(0, 48_000) } : null; } catch { return null; }
          }))).filter((item): item is { path: string; content: string } => item !== null);
        } catch { /* Metadata-only Skills remain safely usable in the catalog. */ }
      } else if (mode === 'default' && skill.instructions) {
        instructions = skill.instructions.slice(0, 24_000);
      }
      return {
        id: skill.id, name: skill.name, description: skill.description, mode, ...(rootPath ? { rootPath } : {}), ...(instructions ? { instructions } : {}), resources,
        // Persisted per-Skill permissions are deny-by-default and are enforced
        // again by Agent Core; they are not model-controlled.
        execution: {
          ...skill.execution,
          allowWorkspaceWrite: tier !== 'read-only' && (skill.execution.allowWorkspaceWrite || sessionGrants.get(skill.id)?.has('workspace-write') === true),
          allowScriptExecution: tier !== 'read-only' && (skill.execution.allowScriptExecution || sessionGrants.get(skill.id)?.has('script-execution') === true),
          allowAllNonDestructive: tier === 'full',
        },
      };
    }));
    const merged = mergeRuntimeSkills(tier, userSkills).map((skill) => ({
      ...skill,
      execution: {
        ...skill.execution,
        allowWorkspaceWrite: skill.execution.allowWorkspaceWrite || sessionGrants.get(skill.id)?.has('workspace-write') === true,
        allowScriptExecution: skill.execution.allowScriptExecution || sessionGrants.get(skill.id)?.has('script-execution') === true,
      },
    }));
    skillRuntimeCache.set(cacheKey, { at: Date.now(), skills: merged });
    return merged;
  };
  const activeConversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value) ?? null);
  const currentEmployee = computed(() => employees.value.find((item) => item.id === currentEmployeeId.value) ?? employees.value[0]);
  const setView = (value: View) => { view.value = value; };
  const flushLeavingConversation = (leavingId: string | null) => {
    if (!leavingId) return;
    const leaving = conversations.value.find((item) => item.id === leavingId);
    const sessionId = leaving?.serverSessionId;
    if (!sessionId) return;
    void orch.flushChatSessionMemory(sessionId).catch(() => undefined);
  };
  const startChat = (employeeId: EmployeeId = currentEmployeeId.value) => {
    flushLeavingConversation(activeConversationId.value);
    currentEmployeeId.value = employeeId;
    activeConversationId.value = null;
    view.value = 'chat';
  };
  const selectConversation = (id: string) => {
    const conversation = conversations.value.find((item) => item.id === id);
    if (!conversation) return;
    if (activeConversationId.value && activeConversationId.value !== id) {
      flushLeavingConversation(activeConversationId.value);
    }
    activeConversationId.value = id;
    currentEmployeeId.value = conversation.employeeId;
    view.value = 'chat';
  };
  const clearConversation = async (id: string) => {
    const conversation = conversations.value.find((item) => item.id === id);
    if (!conversation) return;
    conversation.messages = [];
    conversation.updatedAt = Date.now();
    conversations.value = [...conversations.value];
    await persist();
  };
  const deleteConversation = async (id: string) => {
    const conversation = conversations.value.find((item) => item.id === id);
    const index = conversations.value.findIndex((item) => item.id === id);
    if (index < 0) return;
    const serverRun = serverActiveRuns.get(id);
    if (serverRun) serverRun.unsubscribe();
    if (conversation?.serverSessionId) {
      await orch.deleteChatSession(conversation.serverSessionId).catch(() => undefined);
    }
    conversations.value = conversations.value.filter((item) => item.id !== id);
    if (activeConversationId.value === id) activeConversationId.value = conversations.value[0]?.id ?? null;
    await persist();
  };
  const selectEmployee = (id: EmployeeId) => { currentEmployeeId.value = id; };
  const setDefaultEmployee = (id: EmployeeId) => { currentEmployeeId.value = id; void writeStored('workspace.default-employee', id); };
  const setPermissionTier = (tier: ExecutionLevel) => { permissionTierByEmployee.value = { ...permissionTierByEmployee.value, [currentEmployeeId.value]: tier }; void writeStored('workspace.permission-tiers', JSON.stringify(permissionTierByEmployee.value)); };
  const createEmployee = async (draft: EmployeeDraft) => catalog.create(draft);
  const updateEmployee = async (id: EmployeeId, draft: EmployeeDraft) => catalog.update(id, draft);
  const resetEmployee = async (id: EmployeeId) => catalog.resetPreset(id);
  const hasEmployeeOverride = (id: EmployeeId) => catalog.hasPresetOverride(id);
  const removeEmployee = async (id: EmployeeId) => {
    await catalog.remove(id);
    if (currentEmployeeId.value === id) {
      currentEmployeeId.value = employees.value[0]?.id ?? 'general';
      void writeStored('workspace.default-employee', currentEmployeeId.value);
    }
  };
  const addMessage = async (content: string, model: ProviderConfig, options: { employeeId?: EmployeeId; skillIds?: string[]; collaboratorIds?: EmployeeId[]; collaborationDelivery?: CollaborationDelivery; newConversation?: boolean; onlineSearch?: boolean } = {}) => {
    const text = content.trim(); if (!text) return undefined;
    if (options.employeeId) currentEmployeeId.value = options.employeeId;
    if (options.newConversation) activeConversationId.value = null;
    let conversation = activeConversation.value;
    if (!conversation) {
      conversation = { id: crypto.randomUUID(), title: text.slice(0, 28), employeeId: currentEmployeeId.value, messages: [], updatedAt: Date.now() };
      conversations.value.unshift(conversation); activeConversationId.value = conversation.id;
    }
    conversation.messages.push({ id: crypto.randomUUID(), role: 'user', content: text });
    const userMessage = conversation.messages[conversation.messages.length - 1];
    conversation.updatedAt = Date.now();
    conversations.value = [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt);
    void persist();
    const employee = currentEmployee.value;
    const assistantMessage: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', activities: [], approvals: [], assets: [], collaborations: [] };
    conversation.messages.push(assistantMessage);
    const plannedCollaborators = [...new Set(options.collaboratorIds ?? [])].filter((cid) => cid !== employee.id).slice(0, 3);
    if (serverChatActive() && !plannedCollaborators.length) {
      // M0 server-backed turn: the orchestration server owns the run/approval
      // state machine; UI only mirrors deltas and persists the local copy.
      // Skill hydration happens once inside serverChatTurn (avoid double IO here).
      const runAbortCtl = new AbortController();
      activeRunAbort = runAbortCtl;
      try {
        const outcome = await serverChatTurn(conversation, userMessage, assistantMessage, text, model, options.skillIds);
        return outcome;
      } catch (cause) {
        if (isAbortError(cause)) {
          const reason = cause instanceof Error ? cause.message : '已由用户中止当前执行。';
          assistantMessage.content = assistantMessage.content.trim()
            ? `${assistantMessage.content.trim()}\n\n⏹ ${reason}`
            : `⏹ ${reason}`;
          markActivitiesInterrupted(assistantMessage.activities);
        } else {
          assistantMessage.content = cause instanceof Error ? `⚠ ${cause.message}` : '⚠ Model request failed.';
        }
        void persist();
        return {
          conversationId: conversation.id,
          transcript: {
            prompt: userMessage.content,
            conversationId: conversation.id,
            assistantContent: assistantMessage.content,
            activities: assistantMessage.activities ?? [],
            approvals: assistantMessage.approvals ?? [],
            assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
          },
        };
      }
    }
    const onlineSearch = options.onlineSearch ?? (getEmployeePrefs(employee.id).searchMode !== 'off');
    /** Collaborators inherit the primary employee's search strategy for this turn. */
    const primarySearch = runOptionsFor(employee.id, onlineSearch);
    const skills = await skillRuntimeFor(employee.id, options.skillIds);
    activeRunAbort?.abort();
    const runAbort = new AbortController();
    activeRunAbort = runAbort;
    try {
      const collaboratorIds = [...new Set(options.collaboratorIds ?? [])].filter((id) => id !== employee.id).slice(0, 3);
      // A single selected specialist can own the answer directly. With multiple
      // reports, the primary employee must reconcile scope and possible conflicts.
      assistantMessage.collaborationDelivery = collaboratorIds.length === 1
        ? (options.collaborationDelivery ?? 'direct')
        : 'synthesize';
      if (collaboratorIds.length) {
        assistantMessage.collaborations = collaboratorIds.map((employeeId) => {
          const collaborator = employees.value.find((item) => item.id === employeeId);
          return {
            employeeId,
            task: collaborator ? collaboratorFocus(collaborator) : '聚焦用户目标并给出可执行建议。',
            status: 'running' as const,
            summary: '',
            activities: [],
          };
        });
        conversations.value = [...conversations.value];
        await Promise.all(collaboratorIds.map(async (collaboratorId) => {
          const collaborator = employees.value.find((item) => item.id === collaboratorId);
          const run = assistantMessage.collaborations?.find((item) => item.employeeId === collaboratorId);
          if (!collaborator || !run) return;
          try {
            const collaboratorSkills = await skillRuntimeFor(collaborator.id, undefined, 'read-only');
            const collabOpts = runOptionsFor(collaborator.id, onlineSearch);
            const collaboratorModel = modelForEmployee(collaborator.id, model) ?? model;
            await streamChat({
              profile: {
                id: collaborator.id,
                name: labelEmployee(collaborator),
                toolIds: collaboratorSkills.map((skill) => skill.id),
                instructions: `${profileInstructions(collaborator, `You are acting as a consultation collaborator. Your assigned focus is: ${run.task}`)} Analyze only the assigned user request. Do not delegate, do not write files, do not execute scripts, and return a concise evidence-based brief in the user's language for the primary employee.`,
              },
              messages: [{ role: 'user', content: `用户请求：${text}\n\n你的分工：${run.task}` }],
              model: toModelPayload(collaboratorModel, { enableSearch: primarySearch.enableBuiltinSearch }),
              skills: collaboratorSkills,
              searchProviders: primarySearch.searchProviders,
              mcpConnections: collabOpts.mcpConnections,
              knowledgeBases: collabOpts.knowledgeBases,
              maxSteps: collabOpts.maxSteps,
              runTimeoutMs: collabOpts.runTimeoutMs,
              mcpToolTimeoutMs: collabOpts.mcpToolTimeoutMs,
              signal: runAbort.signal,
            }, (delta) => { run.summary += delta; conversations.value = [...conversations.value]; }, (activity) => {
              const existing = run.activities.find((item) => item.toolName === activity.toolName && item.status === 'running');
              if (existing && activity.status !== 'running') Object.assign(existing, activity); else run.activities.push(activity);
              conversations.value = [...conversations.value];
            });
            run.status = 'completed';
          } catch (cause) {
            if (isAbortError(cause)) {
              run.status = 'failed';
              run.error = cause instanceof Error ? cause.message : '已中止';
              markActivitiesInterrupted(run.activities);
            } else {
              run.status = 'failed';
              run.error = cause instanceof Error ? cause.message : '协作者未能完成任务。';
            }
          }
          conversations.value = [...conversations.value];
        }));
        if (runAbort.signal.aborted) throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
      }
      const collaborationBrief = (assistantMessage.collaborations ?? []).filter((item) => item.status === 'completed' && item.summary.trim()).map((item) => {
        const name = labelEmployee(employees.value.find((row) => row.id === item.employeeId) ?? { id: item.employeeId, color: '#526fe0', initials: 'AI' });
        return `### ${name} 协作者报告\n${item.summary}`;
      }).join('\n\n');
      if (collaboratorIds.length === 1 && assistantMessage.collaborationDelivery === 'direct' && collaborationBrief) {
        assistantMessage.content = assistantMessage.collaborations?.[0]?.summary ?? '';
        conversations.value = [...conversations.value];
        void persist();
        return {
          conversationId: conversation.id,
          transcript: { prompt: userMessage.content, conversationId: conversation.id, assistantContent: assistantMessage.content, activities: [], approvals: [], assets: [] },
        };
      }
      await streamChat({
        profile: {
          id: employee.id,
          name: labelEmployee(employee),
          toolIds: skills.map((skill) => skill.id),
          instructions: profileInstructions(employee, collaborationBrief ? 'This turn includes reports from explicitly selected collaborators. Synthesize their useful findings, resolve conflicts, and do not claim they completed actions you cannot verify.' : ''),
        },
        messages: conversation.messages
          .filter((message) => message.id !== assistantMessage.id)
          .map(({ role, content }) => ({
            role,
            content: role === 'user' && content === text && collaborationBrief
              ? `${content}\n\n协作者报告（仅作参考）：\n${collaborationBrief}`
              : content,
          }))
          .filter((message) => message.content.trim().length > 0),
        model: toModelPayload(model, { enableSearch: primarySearch.enableBuiltinSearch }),
        skills,
        searchProviders: primarySearch.searchProviders,
        mcpConnections: primarySearch.mcpConnections,
        knowledgeBases: primarySearch.knowledgeBases,
        maxSteps: primarySearch.maxSteps,
        runTimeoutMs: primarySearch.runTimeoutMs,
        mcpToolTimeoutMs: primarySearch.mcpToolTimeoutMs,
        signal: runAbort.signal,
      }, (delta: string) => { assistantMessage.content += delta; conversations.value = [...conversations.value]; }, (activity) => {
        const existing = assistantMessage.activities?.find((item) => item.toolName === activity.toolName && item.status === 'running');
        if (existing && activity.status !== 'running') Object.assign(existing, activity);
        else assistantMessage.activities?.push(activity);
        conversations.value = [...conversations.value];
      }, (approval) => { if (!assistantMessage.approvals?.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) assistantMessage.approvals?.push(approval); conversations.value = [...conversations.value]; }, async (artifact) => {
        const normalized = artifact.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!isUserFacingDeliverablePath(normalized) || alreadyHasAsset(assistantMessage.assets, artifact.runId, normalized)) return;
        try {
          const asset = await archiveArtifact({ runId: artifact.runId, relativePath: normalized, conversationId: conversation.id, employeeId: employee.id });
          if (!assistantMessage.assets?.some((item) => item.id === asset.id)) assistantMessage.assets?.push(asset);
          conversations.value = [...conversations.value];
        } catch (error) {
          const message = error instanceof Error ? error.message : '资产归档失败。';
          if (/Only business deliverables|Only user-facing deliverables|no longer available/i.test(message)) return;
          assistantMessage.activities?.push({ toolName: 'archive_asset', status: 'failed', summary: message });
          conversations.value = [...conversations.value];
        }
      }, (search) => { const next = search.sources.map((source) => ({ ...source, provider: search.provider })); assistantMessage.sources = [...new Map([...(assistantMessage.sources ?? []), ...next].map((source) => [source.url, source])).values()]; conversations.value = [...conversations.value]; });
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = '（本轮未返回文本。可重试，或检查模型 / MCP 是否正常。）';
      }
      void persist();
      return {
        conversationId: conversation.id,
        transcript: {
          prompt: userMessage.content,
          conversationId: conversation.id,
          assistantContent: assistantMessage.content,
          activities: [...(assistantMessage.activities ?? [])],
          approvals: [...(assistantMessage.approvals ?? [])],
          assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
        },
      };
    } catch (error) {
      markActivitiesInterrupted(assistantMessage.activities);
      for (const run of assistantMessage.collaborations ?? []) markActivitiesInterrupted(run.activities);
      if (isAbortError(error)) {
        const message = error instanceof Error ? error.message : '已中止当前执行。';
        assistantMessage.content = assistantMessage.content.trim()
          ? `${assistantMessage.content.trim()}\n\n⏹ ${message}`
          : `⏹ ${message}`;
      } else {
        assistantMessage.content = error instanceof Error ? `⚠ ${error.message}` : '⚠ Model request failed.';
      }
      conversations.value = [...conversations.value];
      void persist();
      return {
        conversationId: conversation.id,
        transcript: {
          prompt: userMessage.content,
          conversationId: conversation.id,
          assistantContent: assistantMessage.content,
          activities: [...(assistantMessage.activities ?? [])],
          approvals: [...(assistantMessage.approvals ?? [])],
          assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
        },
      };
    } finally {
      if (activeRunAbort === runAbort) activeRunAbort = null;
    }
  };
  const runAutomation = async (automation: Automation, model: ProviderConfig) => {
    const previousConversation = activeConversationId.value; const previousEmployee = currentEmployeeId.value;
    try {
      const result = await addMessage(automation.prompt, model, { employeeId: automation.employeeId, skillIds: automation.skillIds, newConversation: true });
      return result?.transcript;
    } finally { activeConversationId.value = previousConversation; currentEmployeeId.value = previousEmployee; }
  };
  /**
   * Runs a project task without selecting or mutating the user's active chat.
   * This is the concurrency boundary used by the project orchestrator.
   */
  const runProjectTask = async (input: { projectId: string; taskId: string; prompt: string; employeeId: EmployeeId; skillIds: string[]; permissionTier?: ExecutionLevel; model: ProviderConfig; workspacePath?: string }, onActivity?: (activity: ToolActivity) => void, onDelta?: (delta: string) => void): Promise<ProjectTaskTranscript> => {
    const employee = employees.value.find((item) => item.id === input.employeeId) ?? employees.value[0];
    const skills = await skillRuntimeFor(employee.id, input.skillIds, input.permissionTier);
    const opts = runOptionsFor(employee.id, true);
    const model = modelForEmployee(employee.id, input.model) ?? input.model;
    const transcript: ProjectTaskTranscript = { assistantContent: '', activities: [], approvals: [], assets: [] };
    await streamChat({
      profile: {
        id: employee.id,
        name: labelEmployee(employee),
        toolIds: skills.map((skill) => skill.id),
        instructions: profileInstructions(employee, 'You are working on one assigned project task. Complete only this task, report concrete findings and deliverables in the user\'s language. Do not delegate further.'),
      },
      messages: [{ role: 'user', content: input.prompt }],
      model: toModelPayload(model, { enableSearch: opts.enableBuiltinSearch }),
      skills,
      searchProviders: opts.searchProviders,
      mcpConnections: opts.mcpConnections,
      knowledgeBases: opts.knowledgeBases,
      projectWorkspacePath: input.workspacePath,
      maxSteps: opts.maxSteps,
      runTimeoutMs: opts.runTimeoutMs,
      mcpToolTimeoutMs: opts.mcpToolTimeoutMs,
    }, (delta) => { transcript.assistantContent += delta; onDelta?.(delta); }, (activity) => {
      const existing = transcript.activities.find((item) => item.toolName === activity.toolName && item.status === 'running');
      if (existing && activity.status !== 'running') Object.assign(existing, activity); else transcript.activities.push(activity);
      onActivity?.(activity);
    }, (approval) => { if (!transcript.approvals.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) transcript.approvals.push(approval); }, async (artifact) => {
      transcript.runId = artifact.runId;
      const normalized = artifact.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!isUserFacingDeliverablePath(normalized)) return;
      if (transcript.assets.some((item) => item.runId === artifact.runId && item.name === (normalized.split('/').pop() || normalized))) return;
      try {
        const asset = await archiveArtifact({ runId: artifact.runId, relativePath: normalized, employeeId: employee.id, projectId: input.projectId });
        if (!transcript.assets.some((item) => item.id === asset.id)) transcript.assets.push({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes, runId: asset.runId });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/Only business deliverables|Only user-facing deliverables|no longer available/i.test(message)) return;
        throw error;
      }
    });
    return transcript;
  };
  const generateProjectDraft = async (
    goal: string,
    model: ProviderConfig,
    options?: { employeeIds?: EmployeeId[]; preferredMode?: import('./projects.js').ProjectMode },
  ): Promise<import('./project-planning.js').ProjectDraftResult> => {
    const { analyzeModeFit } = await import('./project-planning.js');
    type ProjectMode = import('./project-planning.js').PlanningMode;
    const preferredMode: ProjectMode = options?.preferredMode ?? 'parallel';
    const allowedList = (options?.employeeIds?.length
      ? options.employeeIds.filter((id) => employees.value.some((item) => item.id === id))
      : employees.value.map((item) => item.id));
    const roster = allowedList.join('|') || 'general|research|code|administrator';
    const allowed = new Set<EmployeeId>(allowedList.length ? allowedList : ['general', 'research', 'code', 'administrator']);

    const modeGuide: Record<ProjectMode, string> = {
      waterfall: 'Prefer a linear chain: each task depends on the previous index only.',
      parallel: 'Prefer independent tasks with empty dependsOn; no edges.',
      discussion: 'Prefer 2+ independent viewpoint tasks, then one integrator that depends on all of them.',
      dag: 'Prefer an explicit DAG with meaningful fan-in/fan-out dependsOn.',
    };

    // Phase 1 — structure only (roles + edges).
    let structureOut = '';
    const structurePrompt = `You are Workmate's project coordinator (phase 1: structure). Preferred collaboration mode: ${preferredMode}. ${modeGuide[preferredMode]} If the goal cannot honestly fit that mode, still propose the best graph and set suggestedMode accordingly. Return ONLY JSON: {"suggestedMode":"waterfall|parallel|discussion|dag","rationale":string,"tasks":[{"title":string,"employeeId": one of [${roster}],"dependsOn":number[]}]}. 2-5 tasks. dependsOn are 0-based indices of prior tasks. Goal: ${goal}`;
    await streamChat({
      profile: { id: 'project-coordinator-structure', name: 'Project coordinator', instructions: 'Output valid JSON only.', toolIds: [] },
      messages: [{ role: 'user', content: structurePrompt }],
      model: toModelPayload(model),
      skills: [],
      searchProviders: runtimeProviders(),
      maxSteps: DEFAULT_MAX_STEPS,
    }, (delta) => { structureOut += delta; });

    type StructureTask = { title: string; employeeId: EmployeeId; dependsOn: number[] };
    let structureTasks: StructureTask[] = [];
    let llmSuggested: ProjectMode | undefined;
    let llmRationale = '';
    try {
      const json = structureOut.match(/\{[\s\S]*\}/)?.[0] ?? structureOut;
      const parsed = JSON.parse(json) as {
        suggestedMode?: string;
        rationale?: string;
        tasks?: Array<Partial<StructureTask>>;
      };
      if (parsed.suggestedMode === 'waterfall' || parsed.suggestedMode === 'parallel' || parsed.suggestedMode === 'discussion' || parsed.suggestedMode === 'dag') {
        llmSuggested = parsed.suggestedMode;
      }
      llmRationale = String(parsed.rationale || '').slice(0, 400);
      structureTasks = (parsed.tasks ?? []).slice(0, 5).map((item, index) => ({
        title: String(item.title || `任务 ${index + 1}`).slice(0, 80),
        employeeId: allowed.has(item.employeeId as EmployeeId) ? item.employeeId as EmployeeId : (allowedList[0] ?? 'general'),
        dependsOn: Array.isArray(item.dependsOn)
          ? item.dependsOn.filter((value): value is number => typeof value === 'number' && value >= 0 && value < index)
          : [],
      }));
    } catch { /* fall through to template-ish structure */ }

    if (!structureTasks.length) {
      structureTasks = (allowedList.length ? allowedList : (['research', 'general', 'code'] as EmployeeId[])).slice(0, 3).map((employeeId, index) => ({
        title: index === 0 ? '任务分析' : index === 1 ? '方案与产出' : '质量检查',
        employeeId,
        dependsOn: preferredMode === 'parallel' ? [] : (index ? [index - 1] : []),
      }));
    }

    // Phase 2 — fill objectives + contracts for the fixed structure.
    let detailOut = '';
    const detailPrompt = `You are Workmate's project coordinator (phase 2: objectives). Fill objectives for this fixed task structure. Return ONLY a JSON array aligned 1:1 with the structure (same length/order). Each item: {"objective":string,"skillIds":string[],"contract"?:{"outputs"?:string[],"acceptance"?:string,"maxAttempts"?:number}}. Structure: ${JSON.stringify(structureTasks)}. Goal: ${goal}`;
    await streamChat({
      profile: { id: 'project-coordinator-detail', name: 'Project coordinator', instructions: 'Output valid JSON array only.', toolIds: [] },
      messages: [{ role: 'user', content: detailPrompt }],
      model: toModelPayload(model),
      skills: [],
      searchProviders: runtimeProviders(),
      maxSteps: DEFAULT_MAX_STEPS,
    }, (delta) => { detailOut += delta; });

    let details: Array<{ objective: string; skillIds: string[]; contract?: ProjectTaskDraft['contract'] }> = [];
    try {
      const json = detailOut.match(/\[[\s\S]*\]/)?.[0] ?? detailOut;
      const parsed = JSON.parse(json) as Array<Partial<ProjectTaskDraft>>;
      details = parsed.slice(0, structureTasks.length).map((item) => ({
        objective: String(item.objective || goal).slice(0, 2000),
        skillIds: Array.isArray(item.skillIds) ? item.skillIds.filter((id): id is string => typeof id === 'string').slice(0, 12) : [],
        contract: item.contract,
      }));
    } catch { /* defaults below */ }

    const tasks: ProjectTaskDraft[] = structureTasks.map((item, index) => ({
      title: item.title,
      objective: details[index]?.objective || `围绕目标推进「${item.title}」：${goal}`,
      employeeId: item.employeeId,
      skillIds: details[index]?.skillIds ?? [],
      dependsOn: item.dependsOn,
      contract: details[index]?.contract,
    }));

    const fit = analyzeModeFit(preferredMode, tasks);
    // Prefer structural inference; LLM suggestedMode is advisory when it disagrees with graph.
    const suggestedMode = fit.suggestedMode !== preferredMode ? fit.suggestedMode : (llmSuggested ?? fit.suggestedMode);
    const modeFitsPreferred = suggestedMode === preferredMode || preferredMode === 'dag';
    return {
      tasks,
      preferredMode,
      suggestedMode: modeFitsPreferred ? preferredMode : suggestedMode,
      modeFitsPreferred,
      modeRationale: modeFitsPreferred
        ? (llmRationale || fit.modeRationale)
        : (llmRationale || fit.modeRationale),
    };
  };
  const approveAndRetry = async (conversationId: string, approval: ToolApproval, scope: 'session' | 'always', model: ProviderConfig) => {
    const conversation = conversations.value.find((item) => item.id === conversationId);
    // Server-backed session: resolve on the server (it re-runs the same turn
    // automatically via its context resolver), then align the mirror.
    if (conversation?.serverSessionId) {
      const sessionId = conversation.serverSessionId;
      if (!approval.id) {
        // Legacy approvals without a server id cannot be resolved remotely.
        return;
      }
      const resolved = await orch
        .resolveChatApproval(sessionId, approval.id, { allow: true, scope })
        .catch(() => undefined);
      // The server auto-resumes the same turn as a new attempt; wait until that
      // resumed run is settled and its content persisted before re-aligning.
      if (resolved?.resumedRunId) {
        const resumeAbort = new AbortController();
        await waitForServerSettled(sessionId, resolved.resumedRunId, resumeAbort);
      }
      await waitForServerApprovalResume(sessionId, conversation);
      if (conversation) {
        for (const message of conversation.messages) {
          if (!message.approvals) continue;
          message.approvals = message.approvals.filter(
            (item) => !(item.skillId === approval.skillId && item.capability === approval.capability),
          );
        }
        void persist();
      }
      return;
    }
    if (scope === 'session') { const grants = sessionGrants.get(approval.skillId) ?? new Set<ToolApproval['capability']>(); grants.add(approval.capability); sessionGrants.set(approval.skillId, grants); }
    else {
      const skill = skills.value.find((item) => item.id === approval.skillId);
      if (skill) await setExecutionPolicy(skill.id, { ...skill.execution, allowWorkspaceWrite: approval.capability === 'workspace-write' ? true : skill.execution.allowWorkspaceWrite, allowScriptExecution: approval.capability === 'script-execution' ? true : skill.execution.allowScriptExecution });
    }
    const lastUser = [...(conversation?.messages ?? [])].reverse().find((message) => message.role === 'user');
    if (lastUser) { activeConversationId.value = conversationId; await addMessage(lastUser.content, model); }
  };
  /** Wait for a server-side approval resume (new attempt) to settle. */
  const waitForServerApprovalResume = async (sessionId: string, conversation: Conversation): Promise<void> => {
    const deadline = Date.now() + 3 * 60_000;
    const before = conversation.updatedAt;
    while (Date.now() < deadline) {
      const session = await orch.getChatSession(sessionId).catch(() => null);
      if (session && session.updatedAt > before) {
        const pending = await orch.chatPendingApprovals(sessionId).catch(() => []);
        if (pending.length === 0) {
          await alignServerConversation(conversation, sessionId).catch(() => undefined);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  };
  return { employees, view, currentEmployeeId, currentEmployee, conversations, activeConversation, permissionTier, load, setView, startChat, selectConversation, selectEmployee, setDefaultEmployee, setPermissionTier, clearConversation, deleteConversation, addMessage, abortActiveRun, runAutomation, runProjectTask, generateProjectDraft, approveAndRetry, createEmployee, updateEmployee, removeEmployee, resetEmployee, hasEmployeeOverride };
}
