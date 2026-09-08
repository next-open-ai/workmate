import path from 'node:path';
import { Agent, type AgentMessage } from '@mariozechner/pi-agent-core';
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@mariozechner/pi-ai';
import type { AgentEvent, AgentProfile, AgentSkillRuntime, ModelConfig, RunModelRef, TokenUsage } from '@workmate/contracts';
import { createSkillExecutionTools, harvestWorkspaceDeliverables, isBusinessDeliverablePath, promoteWorkspaceDeliverablesToProject } from './skill-runtime.js';
import { createWebSearchTools } from './search-runtime.js';
import { createKnowledgeTools } from './knowledge-runtime.js';
import { createExperienceTools, recallExperienceBlock } from './experience/index.js';
import { loadMcpToolset } from './mcp-runtime.js';
import {
  createChatCompletionsPayloadPatch,
  looksLikeDeepseek,
  supportsBuiltinEnableSearch,
  toPiModel,
} from './pi-model.js';
import { collectAgentTools, extractToolDetails } from './pi-tools.js';
import {
  discoverPiSkillsUnder,
  formatAuthorizedSkillsCatalog,
  mergeDiscoveredSkillDescriptions,
} from './pi-skills.js';
import { compactAgentContext, convertToLlm } from './context-compaction.js';

export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
/** Maximum silence for one provider turn, including the turn after a tool result. */
export const DEFAULT_MODEL_TURN_IDLE_MS = 75_000;

/**
 * pi-agent-core has a whole-run timeout, but a provider can stall between tool
 * turns while keeping that run alive for minutes. Wrap every provider stream so
 * a stalled continuation becomes a normal terminal model error.
 */
function streamWithIdleTimeout<TApi extends string>(
  model: Model<TApi>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  idleMs: number,
) {
  const output = createAssistantMessageEventStream();
  const idleController = new AbortController();
  const signal = options?.signal
    ? AbortSignal.any([options.signal, idleController.signal])
    : idleController.signal;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      idleController.abort(new Error(`Model stream idle after ${Math.round(idleMs / 1000)}s`));
    }, idleMs);
  };
  arm();
  void (async () => {
    try {
      const source = streamSimple(model, context, { ...options, signal });
      for await (const event of source) {
        arm();
        output.push(event);
      }
    } catch (error) {
      const message = timedOut
        ? `Model stream idle after ${Math.round(idleMs / 1000)}s`
        : error instanceof Error ? error.message : String(error);
      output.push({
        type: 'error',
        reason: timedOut ? 'aborted' : 'error',
        error: {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: timedOut ? 'aborted' : 'error',
          errorMessage: message,
          timestamp: Date.now(),
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
      output.end();
    }
  })();
  return output;
}

function friendlyModelError(raw: string) {
  if (/reasoning_content/i.test(raw)) {
    return 'DeepSeek 思考模式在工具多轮调用中要求回传 reasoning_content，当前链路已自动关闭 thinking。请重试本轮以生成最终结论。';
  }
  if (/connection\s*error|failed to fetch|fetch failed|terminated|econnreset|econnrefused|enotfound|eai_again|broken pipe|network|ssl|tls|timed?\s*out|timeout|stream idle|remote end closed|temporarily unavailable|socket hang up|ECONNABORTED|UND_ERR/i.test(raw)) {
    return '网络连接超时或中断了，这次没能完成回答。请检查网络后重试；若正在使用 VPN，也可先切换网络再试。';
  }
  return raw;
}

function runtimeClockContext(now = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const local = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return [
    'Runtime clock (local machine time for this run; reference only — not a certified time source):',
    `- Local: ${local} (${timeZone})`,
    `- Calendar date (YYYY-MM-DD): ${ymd}`,
    `- UTC ISO: ${now.toISOString()}`,
    'Treat this as the host\'s current wall clock only. Prefer it over training-cutoff guesses for 今天/昨日/本周/最新交易日 and similar relative dates.',
    'For market data tools, set end dates from this calendar date (or the latest session on/before it); never invent a past year from memory. If a data source disagrees about the latest trading day, state that discrepancy.',
  ].join('\n');
}

function preloadedSkillInstructions(skills: AgentSkillRuntime[]) {
  return skills
    .filter((skill) => skill.instructions)
    .map((skill) => `<skill id="${skill.id}">\n${skill.instructions}\n</skill>`)
    .join('\n\n');
}

function skillFirstExecutionContract() {
  return [
    'Skill-first execution contract:',
    '1) If the user task matches an authorized Skill, follow that Skill on the first turn instead of doing generic environment exploration.',
    '2) Do not narrate internal rewrites, indecision, or self-corrections in the user-facing reply. Keep progress updates short and action-oriented.',
    '3) Prefer one minimal deterministic execution path: prepare content, write the generator once, install only clearly needed dependencies, run it, then register/publish the deliverable. If the final file is already under output/, registration is only an idempotent confirmation: never copy or rename it into a second deliverable.',
    '4) Avoid low-value probes (extra filesystem checks, repeated existence checks, duplicate rewrites) unless the previous tool result created a concrete blocker.',
    '5) Use MCP/search tools only when they are directly relevant to the user request or required by the matched Skill. Do not probe unrelated domains just because a tool is available.',
    '6) For document-generation tasks (PDF/Word/slides/spreadsheets/reports/itineraries), skip unrelated finance/market/stock/crypto tools unless the user explicitly asked for live market data.',
    '7) For artifact requests, aim to finish within a small number of tool steps; retry only with a specific fix derived from the last error.',
    '8) Assume the run workspace already supports output/ deliverables. Put final user-facing files under output/ directly.',
    '9) For Python PDF generation, prefer standard library plus already-available packages first. Do not call install_python_dependency unless a concrete script/import failure shows the missing module.',
    '10) For PDF tasks, avoid exploratory filesystem/MCP probes when the run workspace tools already cover writing and executing the generator.',
  ].join('\n');
}

function looksLikeDocumentArtifactTask(userText: string, skills: AgentSkillRuntime[]) {
  const text = `${userText}\n${skills.map((skill) => `${skill.name}\n${skill.description}\n${skill.instructions || ''}`).join('\n')}`.toLowerCase();
  return /(pdf|docx?|word|ppt|slides?|excel|spreadsheet|report|itinerary|travel|guide|brochure|行程|旅游|旅行|攻略|报告|手册|文档|海报)/i.test(text);
}

/** Deterministic first-turn routing for an explicitly requested PDF deliverable. */
function requiredPdfSkill(userText: string, skills: AgentSkillRuntime[]) {
  if (!/\bpdf\b|PDF|电子版|可打印|行程册|行程手册/i.test(userText)) return undefined;
  return skills.find((skill) => /pdf|报告生成|文档生成/i.test(`${skill.id}\n${skill.name}\n${skill.description}`));
}

function looksLikeFinanceTask(userText: string) {
  return /(stock|stocks|market|markets|finance|financial|fund|crypto|trading|证券|股票|基金|行情|金融|大盘|港股|美股|加密)/i.test(userText);
}

function sanitizeMcpPrefix(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

export function filterMcpToolsetForTask(
  mcp: Awaited<ReturnType<typeof loadMcpToolset>>,
  userText: string,
  skills: AgentSkillRuntime[],
) {
  if (!looksLikeDocumentArtifactTask(userText, skills) || looksLikeFinanceTask(userText)) return mcp;
  const blockedPrefixes = new Set(['akshare', 'tushare', 'sequential_thinking', 'sequentialthinking', 'filesystem']);
  const keepTools = mcp.tools.filter((tool) => {
    const lower = tool.name.toLowerCase();
    for (const prefix of blockedPrefixes) {
      if (lower.startsWith(`mcp_${prefix}_`)) return false;
    }
    return true;
  });
  const keepNames = new Set(keepTools.map((tool) => tool.name));
  const keepDescriptors = mcp.toolDescriptors.filter((tool) => keepNames.has(tool.name));
  const keepLabels = mcp.labels.filter((label) => !blockedPrefixes.has(sanitizeMcpPrefix(label)));
  const filtered = keepTools.length !== mcp.tools.length;
  return {
    ...mcp,
    tools: keepTools,
    toolDescriptors: keepDescriptors,
    labels: keepLabels,
    instructions: filtered ? '' : mcp.instructions,
  };
}

function toolInputSummary(toolName: string, input: unknown) {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (toolName === 'load_skill') return `正在加载 Skill：${String(value.skillId || '')}`;
  if (toolName === 'read_skill_file') return `正在读取 Skill 文件：${String(value.path || '')}`;
  if (toolName === 'read_workspace_file') return `正在读取运行工作区文件：${String(value.path || '')}`;
  if (toolName === 'write_workspace_file') {
    const mode = value.mode === 'append' ? '追加' : '写入';
    return `正在${mode}运行工作区文件：${String(value.path || '')}`;
  }
  if (toolName === 'publish_to_project') {
    const dest = value.destPath ? ` → ${String(value.destPath)}` : '';
    return `正在发布到项目空间：${String(value.path || '')}${dest}`;
  }
  if (toolName === 'register_deliverable') return `正在登记业务交付物：${String(value.path || '')}`;
  if (toolName === 'run_skill_script') return `正在执行脚本：${String(value.path || '')}`;
  if (toolName === 'run_workspace_script') return `正在执行生成脚本：${String(value.path || '')}`;
  if (toolName === 'install_python_dependency') return `正在安装 Python 依赖：${String(value.package || '')}`;
  if (toolName === 'fetch_skill_url') return `正在访问网络资源：${String(value.url || '')}`;
  if (toolName === 'web_search') return `正在联网搜索：${String(value.query || '')}`;
  if (toolName === 'kb_search') return `正在检索知识库：${String(value.query || '')}`;
  if (toolName === 'save_experience') return `正在保存智能体经验：${String(value.title || '')}`;
  if (toolName === 'load_experience') return `正在加载智能体经验：${String(value.query || '')}`;
  return `正在调用工具：${toolName}`;
}

function toolResultSummary(toolName: string, output: unknown) {
  const value = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const failText = () => String(value.message || value.error || `${toolName} 未完成。`);
  if (toolName === 'web_search' && value.ok === false) {
    return `联网搜索未完成：${String(value.provider || '')} · ${String(value.durationMs ?? 0)}ms · ${String(value.error || value.message || '请求失败')}`;
  }
  // Experience tools use `message` on soft failure — handle before the generic ok===false branch.
  if (toolName === 'save_experience') {
    return value.ok === false
      ? `经验保存失败：${failText()}`
      : `经验已保存${value.merged ? '（已合并近似条目）' : ''}：${String(value.title || value.id || '')}`;
  }
  if (toolName === 'load_experience') {
    if (value.ok === false) return `经验加载失败：${failText()}`;
    const count = Number(value.count) || 0;
    return count > 0 ? `已加载 ${count} 条高置信经验。` : '未命中高置信经验（已忽略）。';
  }
  if (value.ok === false) return failText();
  if (toolName === 'install_python_dependency') {
    const pkg = String(value.package || '');
    return value.alreadyAvailable
      ? `Python 依赖已可用：${pkg || '未命名依赖'}`
      : `Python 依赖安装完成：${pkg || '未命名依赖'}（退出码 ${String(value.exitCode ?? 0)}）。`;
  }
  if (toolName === 'run_skill_script') return `脚本执行完成（退出码 ${String(value.exitCode ?? 0)}）。`;
  if (toolName === 'run_workspace_script') {
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts.filter((item): item is string => typeof item === 'string') : [];
    return artifacts.length ? `生成脚本执行完成：${artifacts.join('、')}` : `生成脚本执行完成（退出码 ${String(value.exitCode ?? 0)}）。`;
  }
  if (toolName === 'write_workspace_file') {
    const mode = value.mode === 'append' ? '已追加' : '已写入';
    return `${mode} ${String(value.path || '运行工作区文件')}${typeof value.totalBytes === 'number' ? `（共 ${value.totalBytes} 字节）` : '。'}`;
  }
  if (toolName === 'publish_to_project') {
    return `已发布到项目空间：${String(value.projectPath || value.path || '')}${typeof value.bytes === 'number' ? `（${value.bytes} 字节）` : ''}`;
  }
  if (toolName === 'register_deliverable') {
    return `已登记业务交付物：${String(value.path || '')}${typeof value.bytes === 'number' ? `（${value.bytes} 字节）` : ''}`;
  }
  if (toolName === 'fetch_skill_url') return `已获取网络资源（${String(value.contentType || 'text')}）。`;
  if (toolName === 'web_search') {
    const count = Array.isArray(value.results) ? value.results.length : 0;
    const fallback = value.fallbackFrom ? `，已从 ${String(value.fallbackFrom)} 自动降级` : '';
    return `联网搜索完成：${String(value.provider || '')}${fallback}，${count} 条结果，${String(value.durationMs ?? 0)}ms，估算 ${String(value.estimatedCredits ?? 0)} credit。`;
  }
  if (toolName === 'load_skill') return `Skill 已加载：${String((value.skill as Record<string, unknown> | undefined)?.name || '')}`;
  if (toolName === 'read_skill_file') return `已读取 Skill 文件：${String(value.path || '')}`;
  if (toolName === 'read_workspace_file') return `已读取运行工作区文件：${String(value.path || '')}`;
  return '工具调用完成。';
}

/** Experience memory is optional — soft failures must not paint the whole run as「需要处理」. */
function isSoftFailTool(toolName: string) {
  return toolName === 'save_experience' || toolName === 'load_experience';
}

function isAbortLike(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name || '') : '';
  if (name === 'AbortError') return true;
  const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';
  return /abort|cancel|中止|超时/i.test(message);
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function asNonNegInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function tokenUsageFromPi(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}): TokenUsage | null {
  const inputTokens = asNonNegInt(usage.input);
  const outputTokens = asNonNegInt(usage.output);
  const cacheReadTokens = asNonNegInt(usage.cacheRead);
  const cacheWriteTokens = asNonNegInt(usage.cacheWrite);
  const totalTokens = asNonNegInt(usage.totalTokens) || inputTokens + outputTokens;
  if (inputTokens + outputTokens + totalTokens + cacheReadTokens + cacheWriteTokens <= 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
  };
}

function modelRefFromConfig(model: ModelConfig): RunModelRef {
  return {
    provider: model.provider,
    chatModel: model.chatModel,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.providerLabel ? { providerLabel: model.providerLabel } : {}),
  };
}

function toPiHistoryMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: ModelConfig,
): AgentMessage[] {
  const api = model.provider === 'anthropic' ? 'anthropic-messages' : model.provider === 'google' ? 'google-generative-ai' : 'openai-completions';
  return messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user' as const, content: message.content, timestamp: Date.now() };
    }
    return {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: message.content }],
      api,
      provider: model.provider,
      model: model.chatModel,
      usage: emptyUsage(),
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    } satisfies AssistantMessage;
  });
}

function yieldArtifactEvents(
  runId: string,
  toolName: string,
  output: unknown,
  emittedPaths: Set<string>,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (!output || typeof output !== 'object') return events;
  const value = output as Record<string, unknown>;
  const pushDeliverable = (rawPath: string) => {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    // Intent-based: only paths under output/ (business deliverables) become assets.
    if (!isBusinessDeliverablePath(normalized) || emittedPaths.has(normalized)) return;
    emittedPaths.add(normalized);
    events.push({ type: 'artifact.created', runId, path: normalized });
  };
  if (toolName === 'run_workspace_script' || toolName === 'run_skill_script') {
    const artifacts = value.artifacts;
    if (Array.isArray(artifacts)) {
      for (const artifact of artifacts) {
        if (typeof artifact === 'string') pushDeliverable(artifact);
      }
    }
  }
  if (toolName === 'write_workspace_file' || toolName === 'register_deliverable') {
    if (value.deliverable === true && typeof value.path === 'string') pushDeliverable(value.path);
  }
  if (toolName === 'publish_to_project') {
    if (typeof value.path === 'string' && typeof value.projectPath === 'string') {
      events.push({ type: 'project.file.published', runId, path: value.path, projectPath: value.projectPath });
      pushDeliverable(value.path);
    }
  }
  if (toolName === 'web_search') {
    const sources = Array.isArray(value.sources)
      ? value.sources
        .filter((item): item is { title: string; url: string; source?: string } =>
          Boolean(item && typeof item === 'object' && typeof (item as { title?: unknown }).title === 'string' && typeof (item as { url?: unknown }).url === 'string'))
        .slice(0, 10)
      : [];
    if (sources.length) events.push({ type: 'search.sources', runId, provider: String(value.provider || ''), sources });
  }
  return events;
}

/**
 * Agent loop powered by @mariozechner/pi-agent-core + pi-ai.
 * Emits the same Workmate AgentEvent stream as the previous AI SDK path.
 */
export async function* streamAgentReply(input: {
  profile: AgentProfile;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: ModelConfig;
  skills?: AgentSkillRuntime[];
  searchProviders?: import('@workmate/contracts').SearchProviderRuntime[];
  mcpConnections?: import('@workmate/contracts').McpConnectionRuntime[];
  knowledgeBases?: import('@workmate/contracts').KnowledgeBaseRuntime[];
  runId?: string;
  projectWorkspacePath?: string;
  workspaceAccess?: 'read' | 'write' | 'full';
  maxSteps?: number;
  runTimeoutMs?: number;
  mcpToolTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const runId = input.runId?.trim() || crypto.randomUUID();
  const projectRoot = input.projectWorkspacePath?.trim() || '';
  yield { type: 'run.started', runId };

  const knowledgeTools = createKnowledgeTools({ knowledgeBases: input.knowledgeBases, model: input.model });
  const experienceTools = createExperienceTools({ agentId: input.profile.id, model: input.model });
  const lastUserText = [...input.messages].reverse().find((item) => item.role === 'user')?.content || '';
  // Overlap MCP connect with experience recall — both were serial TTFT taxes.
  const mcpPromise = loadMcpToolset(input.mcpConnections, { toolTimeoutMs: input.mcpToolTimeoutMs });
  const experiencePromise = lastUserText.trim().length >= 4 && experienceTools.length
    ? recallExperienceBlock({
      agentId: input.profile.id,
      query: lastUserText.slice(0, 500),
      model: input.model,
    })
    : Promise.resolve('');
  const [mcpLoaded, experienceBlock] = await Promise.all([mcpPromise, experiencePromise]);
  const runTimeoutMs = Math.min(1_800_000, Math.max(15_000, Math.round(Number(input.runTimeoutMs) || DEFAULT_RUN_TIMEOUT_MS)));
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(
    () => timeoutController.abort(new Error(`Run timed out after ${Math.round(runTimeoutMs / 1000)}s`)),
    runTimeoutMs,
  );
  const abortSignal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, timeoutController.signal])
    : timeoutController.signal;

  const queue: AgentEvent[] = [];
  let settle: (() => void) | undefined;
  const wake = () => settle?.();
  const enqueue = (event: AgentEvent) => {
    queue.push(event);
    wake();
  };

  try {
    if (abortSignal.aborted) {
      const timedOut = timeoutController.signal.aborted && !input.abortSignal?.aborted;
      yield {
        type: 'run.cancelled',
        runId,
        reason: timedOut ? 'timeout' : 'user',
        message: timedOut ? `执行超时（${Math.round(runTimeoutMs / 1000)}s），已自动中止。` : '已由用户中止当前执行。',
      };
      return;
    }

    const skillsRaw = input.skills ?? [];
    const libraryDir = process.env.WORKMATE_SKILLS_DIR?.trim();
    const discovered = libraryDir ? discoverPiSkillsUnder(libraryDir) : [];
    const skills = mergeDiscoveredSkillDescriptions(skillsRaw, discovered);
    const requiredPdf = requiredPdfSkill(lastUserText, skills);
    const mcp = filterMcpToolsetForTask(mcpLoaded, lastUserText, skills);
    const preloadedSkills = preloadedSkillInstructions(skills);
    const kbLabels = (input.knowledgeBases ?? []).filter((item) => item.enabled).map((item) => item.name);
    const searchTools = createWebSearchTools(input.searchProviders ?? []);
    const builtinSearchOn = Boolean(input.model.enableSearch) && supportsBuiltinEnableSearch(input.model.provider);

    const runtimeInstructions = [
      input.profile.instructions,
      runtimeClockContext(),
      'Authorized Agent Skills (associated skills are preloaded before the first model turn when instructions are available):\n' + formatAuthorizedSkillsCatalog(skills),
      preloadedSkills ? `Preloaded Skill instructions (available on first turn; follow only when relevant):\n${preloadedSkills}` : '',
      mcp.labels.length
        ? `Authorized MCP connectors for this run: ${mcp.labels.join(', ')}.`
        : '',
      mcp.instructions || '',
      kbLabels.length ? `Authorized knowledge bases for this run: ${kbLabels.join(', ')}. Use kb_search for internal/private knowledge before guessing.` : '',
      builtinSearchOn
        ? 'Built-in model web search is enabled for this run (provider enable_search). Prefer it for public realtime facts; do not invent sources. Use kb_search for private corpora.'
        : '',
      experienceBlock || '',
      experienceTools.length
        ? 'Agent experience memory is available for this employee only. After a meaningful multi-step success (or a hard-won pitfall), call save_experience with a short structured card (situation/action/pitfall/whenNot). Use load_experience when pivoting to a task that may match prior work. Low-similarity loads return empty—do not invent memories.'
        : '',
      requiredPdf
        ? `Required Skill for this turn: ${requiredPdf.name} (${requiredPdf.id}). The user explicitly requested a PDF, so follow this Skill first. Use its own template, renderer, packaged script, or Tool adapter. Do not invent a generic runtime PDF workflow; stop immediately after the Skill has verified and registered the output PDF.`
        : '',
      skillFirstExecutionContract(),
      projectRoot
        ? 'This run is bound to a shared project workspace. Keep generators under the run workspace (prefer scripts/). Put finished business products under output/ (or write_workspace_file with deliverable=true / register_deliverable). Prefer publish_to_project for each finished output/ file so it appears in the project tree mid-run; end-of-run auto-promotes remaining output/ files.'
        : '',
      'Associated Skill instructions are preloaded before the first model turn whenever available, so prefer those specialized procedures immediately instead of exploring generic alternatives. Preloading is for reasoning only: if you need packaged Skill files or bundled Skill scripts, call load_skill for that relevant user Skill first. Workspace and artifact operations are platform Tools, not a Skill: follow each Tool schema and result exactly. Skill files are read-only. Finished business deliverables MUST be under output/, while inputs and temporary files MUST stay outside output/. Never claim an operation ran unless its Tool returned a successful result. For artifact requests, do not stop at a plan: produce and verify the file, then register it. Once a verified deliverable exists, stop calling tools and return the result. In the user-facing answer, refer to the delivered asset by its filename, not its internal output/ path. Use reasonable defaults for non-critical details; if a required permission, script, dependency, or output path is unavailable, state the exact blocker and the one next user action.',
      'Agent runtime: Workmate pi-agent-core + pi-coding-agent skills catalog.',
    ].filter(Boolean).join('\n\n');

    // Keep the configured task budget. Do not impose a document-specific global
    // cap: aborting an Agent after it has already queued work produces the false
    // "file succeeded, run failed" state.
    const requestedMaxSteps = Math.min(64, Math.max(4, Math.round(Number(input.maxSteps) || 28)));
    const maxSteps = requestedMaxSteps;
    const piModel = toPiModel(input.model);
    const onPayload = createChatCompletionsPayloadPatch(input.model);
    const agentTools = collectAgentTools(
      createSkillExecutionTools({ skills, runId, projectRoot: projectRoot || undefined, workspaceAccess: input.workspaceAccess }),
      searchTools,
      knowledgeTools,
      experienceTools,
      mcp.tools,
    );

    let emittedText = false;
    let lastToolSucceeded: boolean | undefined;
    let toolTurns = 0;
    let runFailed = false;
    let usageSteps = 0;
    const modelRef = modelRefFromConfig(input.model);
    const emittedArtifactPaths = new Set<string>();

    const agent = new Agent({
      initialState: {
        systemPrompt: runtimeInstructions,
        model: piModel,
        thinkingLevel: 'off',
        tools: agentTools,
        messages: [],
      },
      convertToLlm,
      transformContext: async (messages, signal) =>
        compactAgentContext({
          messages,
          model: input.model,
          piModel,
          signal,
        }),
      getApiKey: () => input.model.apiKey || (input.model.provider === 'ollama' ? 'ollama' : undefined),
      streamFn: (model, context, options) =>
        streamWithIdleTimeout(model, context, {
          ...options,
          apiKey: options?.apiKey ?? (input.model.apiKey || (input.model.provider === 'ollama' ? 'ollama' : undefined)),
          reasoning: (looksLikeDeepseek(input.model) || input.model.disableThinking) ? undefined : options?.reasoning,
          onPayload: (payload) => {
            onPayload?.(payload);
            options?.onPayload?.(payload);
          },
          signal: abortSignal,
        }, Math.min(DEFAULT_MODEL_TURN_IDLE_MS, Math.max(30_000, Math.floor(runTimeoutMs / 4)))),
    });

    const onAbort = () => agent.abort();
    abortSignal.addEventListener('abort', onAbort, { once: true });

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_update') {
        const evt = event.assistantMessageEvent;
        if (evt.type === 'text_delta' && evt.delta) {
          emittedText = true;
          enqueue({ type: 'message.delta', runId, text: evt.delta });
        } else if (evt.type === 'error') {
          runFailed = true;
          const raw = evt.error.errorMessage || 'Model request failed.';
          enqueue({ type: 'run.failed', runId, message: friendlyModelError(raw) });
        }
        return;
      }

      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const assistant = event.message as AssistantMessage;
        if (assistant.errorMessage) {
          runFailed = true;
          enqueue({ type: 'run.failed', runId, message: friendlyModelError(assistant.errorMessage) });
        } else {
          const mapped = tokenUsageFromPi(assistant.usage || emptyUsage());
          if (mapped) {
            enqueue({
              type: 'run.usage',
              runId,
              usage: mapped,
              model: modelRef,
              stepIndex: usageSteps,
            });
            usageSteps += 1;
          }
        }
        return;
      }

      if (event.type === 'tool_execution_start') {
        toolTurns += 1;
        if (toolTurns > maxSteps) {
          agent.abort();
          enqueue({
            type: 'run.failed',
            runId,
            message: `工具调用步数超过上限（${maxSteps}），已中止。`,
          });
          runFailed = true;
          return;
        }
        enqueue({
          type: 'tool.started',
          runId,
          toolName: event.toolName,
          summary: toolInputSummary(event.toolName, event.args),
        });
        return;
      }

      if (event.type === 'tool_execution_end') {
        const output = extractToolDetails(event.result);
        const approvalRequest = output && typeof output === 'object' ? (output as Record<string, unknown>).approval : undefined;
        if (approvalRequest && typeof approvalRequest === 'object') {
          const approval = approvalRequest as Record<string, unknown>;
          const capability = approval.capability;
          if (typeof approval.skillId === 'string' && (capability === 'workspace-write' || capability === 'script-execution' || capability === 'network-access')) {
            enqueue({
              type: 'tool.approval_required',
              runId,
              skillId: approval.skillId,
              capability,
              summary: toolResultSummary(event.toolName, output),
            });
          }
        }

        if (event.isError) {
          lastToolSucceeded = false;
          const raw = typeof output === 'string'
            ? output
            : output && typeof output === 'object' && 'error' in (output as object)
              ? String((output as { error?: unknown }).error || 'tool failed')
              : 'tool failed';
          const hint = /JSON|parse|Invalid input|Unterminated string/i.test(raw)
            ? ' 写入内容过大或转义失败：请改用更小的 content，或分多次 mode=append / chunks 写入。'
            : '';
          enqueue({ type: 'tool.failed', runId, toolName: event.toolName, summary: `${raw}${hint}` });
          return;
        }

        const logicalOk = !(output && typeof output === 'object' && (output as Record<string, unknown>).ok === false);
        // Soft-fail tools still return ok:false to the model, but the activity strip
        // should not escalate the whole turn to「需要处理」.
        const ok = logicalOk || isSoftFailTool(event.toolName);
        lastToolSucceeded = logicalOk;
        enqueue({
          type: 'tool.completed',
          runId,
          toolName: event.toolName,
          summary: toolResultSummary(event.toolName, output),
          ok,
        });
        for (const artifactEvent of yieldArtifactEvents(runId, event.toolName, output, emittedArtifactPaths)) {
          enqueue(artifactEvent);
        }
      }
    });

    const history = input.messages;
    const prior = history.length > 1 ? history.slice(0, -1) : [];
    const last = history[history.length - 1];
    if (prior.length) agent.replaceMessages(toPiHistoryMessages(prior, input.model));

    const runPromise = (async () => {
      try {
        if (!last || last.role !== 'user') {
          enqueue({ type: 'run.failed', runId, message: 'Missing user message for agent run.' });
          return;
        }
        await agent.prompt(last.content);
        if (abortSignal.aborted) {
          const timedOut = timeoutController.signal.aborted && !input.abortSignal?.aborted;
          enqueue({
            type: 'run.cancelled',
            runId,
            reason: timedOut ? 'timeout' : 'user',
            message: timedOut ? `执行超时（${Math.round(runTimeoutMs / 1000)}s），已自动中止。` : '已由用户中止当前执行。',
          });
          return;
        }
        if (runFailed) return;
        if (!emittedText && lastToolSucceeded !== undefined) {
          enqueue({
            type: 'message.delta',
            runId,
            text: lastToolSucceeded
              ? '工具调用已完成。请查看上方执行记录和运行工作区产物。'
              : '工具未能完成请求；请查看上方执行记录中的权限或输入原因。',
          });
        }
        if (projectRoot) {
          const workspaceRoot = path.join(
            process.env.WORKMATE_WORKSPACES_DIR || path.join(process.cwd(), '.workmate-workspaces'),
            runId,
          );
          const published = await promoteWorkspaceDeliverablesToProject(workspaceRoot, projectRoot);
          for (const item of published) {
            enqueue({ type: 'project.file.published', runId, path: item.path, projectPath: item.projectPath });
            const normalized = item.path.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!isBusinessDeliverablePath(normalized) || emittedArtifactPaths.has(normalized)) continue;
            emittedArtifactPaths.add(normalized);
            enqueue({ type: 'artifact.created', runId, path: normalized });
          }
        } else {
          // Non-project runs: still stage root PDFs into output/ and emit asset cards.
          const workspaceRoot = path.join(
            process.env.WORKMATE_WORKSPACES_DIR || path.join(process.cwd(), '.workmate-workspaces'),
            runId,
          );
          const harvested = await harvestWorkspaceDeliverables(workspaceRoot).catch(() => []);
          for (const relative of harvested) {
            const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!isBusinessDeliverablePath(normalized) || emittedArtifactPaths.has(normalized)) continue;
            emittedArtifactPaths.add(normalized);
            enqueue({ type: 'artifact.created', runId, path: normalized });
          }
        }
        enqueue({ type: 'run.completed', runId });
      } catch (error) {
        if (isAbortLike(error, abortSignal)) {
          const timedOut = timeoutController.signal.aborted && !input.abortSignal?.aborted;
          enqueue({
            type: 'run.cancelled',
            runId,
            reason: timedOut ? 'timeout' : 'user',
            message: timedOut ? `执行超时（${Math.round(runTimeoutMs / 1000)}s），已自动中止。` : '已由用户中止当前执行。',
          });
        } else {
          const raw = error instanceof Error ? error.message : 'Model request failed.';
          enqueue({ type: 'run.failed', runId, message: friendlyModelError(raw) });
        }
      } finally {
        unsubscribe();
        abortSignal.removeEventListener('abort', onAbort);
        wake();
      }
    })();

    let finished = false;
    void runPromise.finally(() => {
      finished = true;
      wake();
    });

    while (!finished || queue.length) {
      if (!queue.length) {
        await new Promise<void>((resolve) => {
          settle = resolve;
          if (queue.length || finished) resolve();
        });
        settle = undefined;
      }
      while (queue.length) yield queue.shift()!;
    }
    await runPromise;
  } finally {
    clearTimeout(timeoutId);
    await mcpLoaded.close();
  }
}
