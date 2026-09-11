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
import { createSkillExecutionTools, isBusinessDeliverablePath } from './skill-runtime.js';
import { withLenientJsonParse } from './json-repair.js';
import { sanitizeToolPayloadsInMessages } from './context-sanitize.js';
import {
  resolveAgentWorkspaceRoot,
  resolveWorkspaceMode,
  snapshotWorkspaceFiles,
  workspaceModeContract,
} from './workspace-mode.js';
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
import { createPiCapabilityTools } from './pi-capability-adapter.js';
import { createPreviewServerTools } from './preview-server.js';
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
      // openai-completions finishes tool calls with bare JSON.parse; models often
      // emit literal newlines inside write_workspace_file content. Patch parse for
      // this stream so tool args survive (see json-repair.ts).
      await withLenientJsonParse(async () => {
        const source = streamSimple(model, context, { ...options, signal });
        for await (const event of source) {
          arm();
          output.push(event);
        }
      });
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
  if (/Bad control character|Unterminated string|Bad escaped character|in string literal in JSON|Expected ',' or '}' after property value|Expected ',' or '\]'|JSON at position|Unexpected non-whitespace/i.test(raw)) {
    return '工具参数 JSON 解析失败（常见原因：单次写入过大被截断，或字符串内未转义引号）。请缩短本次写入，或先写基础文件后用 edit 补充。';
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
    // Only explicit default Skills are preloaded. Available Skills stay as a
    // compact catalog entry until the agent selects and loads one, which is the
    // progressive-disclosure contract used by pi-coding-agent.
    .filter((skill) => skill.mode === 'default' && skill.instructions)
    .map((skill) => `<skill id="${skill.id}">\n${skill.instructions}\n</skill>`)
    .join('\n\n');
}

function skillFirstExecutionContract(projectBound = false) {
  return [
    'Skill-first execution contract:',
    '1) If the user task matches an authorized Skill, follow that Skill on the first turn instead of doing generic environment exploration.',
    '2) Do not narrate internal rewrites, indecision, or self-corrections in the user-facing reply. Keep progress updates short and action-oriented.',
    projectBound
      ? '3) Prefer one minimal deterministic execution path: write the real project files at the project root, verify them, then stop. Do not wrap the product in output/.'
      : '3) Prefer one minimal deterministic execution path: prepare content, write the generator once, install only clearly needed dependencies, run it, then register/publish the deliverable. If the final file is already under output/, registration is only an idempotent confirmation: never copy or rename it into a second deliverable.',
    '4) Avoid low-value probes (extra filesystem checks, repeated existence checks, duplicate rewrites) unless the previous tool result created a concrete blocker.',
    '5) Use MCP/search tools only when they are directly relevant to the user request or required by the matched Skill. Do not probe unrelated domains just because a tool is available.',
    '6) For document-generation tasks (PDF/Word/slides/spreadsheets/reports/itineraries), skip unrelated finance/market/stock/crypto tools unless the user explicitly asked for live market data.',
    '7) For artifact requests, aim to finish within a small number of tool steps; retry only with a specific fix derived from the last error.',
    projectBound
      ? '8) This is a project-bound run. Write the real project tree at the workspace root (index.html, src/, assets/, …). Do not wrap the product in output/.'
      : '8) Assume the run workspace already supports output/ deliverables. Put final user-facing files under output/ directly.',
    '9) For Python PDF generation, prefer standard library plus already-available packages first. Do not call install_python_dependency unless a concrete script/import failure shows the missing module.',
    '10) For PDF / document / brief / website tasks, do NOT use filesystem MCP or finance/market MCP. For code and websites, use the standard read/write/edit/bash tools in the authorized workspace. Write a clean initial file, then use edit for focused follow-up changes. Once a final user-facing file is verified, call commit_artifact exactly once; only committed artifacts enter the asset library. To open a local preview of a static site, call preview_server_start (not bash http.server).',
    '11) If local project context is sparse, stop probing after 1-2 checks, state the assumption once, and proceed to the deliverable instead of repeatedly re-checking the workspace.',
    '12) For research /素材整理 /设计方案 /简报 tasks, do not spend tool steps narrating your plan. Search or inspect only what directly changes the deliverable, then write the result once.',
    '13) Never emit process narration such as "Let me think", "Let me check", "I will first", "我先看一下" as the final answer body. Use tools or write the file directly; keep visible text for conclusions and deliverables only.',
    '14) For project-task runs with explicit output filenames, prefer writing those files immediately after the minimum necessary inspection. If a public site blocks crawling or a fetch tool errors once, do not spiral into retries; proceed with the best grounded draft and clearly note any evidence limits inside the file.',
    '15) Do not rewrite the same deliverable repeatedly to fix tiny typos unless acceptance requires it. Prefer one clean write, then stop.',
    '16) After a successful write or edit, do NOT read the whole file back. Trust the tool result and file path; never re-call write with only a path. Prefer CSS gradients / inline SVG over image-generator scripts.',
    '17) Never paste prior CSS/JS source into your reasoning. Continue with the next unfinished page file.',
    '18) Command/script outputs appear as [command-result] envelopes (head/tail). Treat them as truncated logs; do not ask to re-dump full stdout.',
    '19) After the deliverable set exists (docs/CSV/HTML written and one basic check passes), STOP. Do not run multi-round render/DOM/CSV re-validation spirals, taxonomy crosswalk rewrites, or unrelated MCP calls (market/stock/trading-day). One short verification pass is enough.',
    '20) If the user asks to preview/open/view a site, call preview_server_start with access=local. If they ask for 本地部署 / LAN deploy / let other devices open it, call preview_server_start with access=lan and return url/lanUrls (same LAN, multi-device). If they ask to 关闭本地部署 / 关闭预览 / 关闭本地网站 / stop the local site, call preview_server_stop (status first if needed). Do NOT rebuild or use bash http.server/kill. Conversation maps the session SITE asset bundle; project maps the project workspace root.',
  ].join('\n');
}

export const STEP_BUDGET_EXCEEDED_MESSAGE = (maxSteps: number) =>
  `工具调用步数超过上限（${maxSteps}），已自动中止。请减少重复探查，或在员工详情提高“轮次 / 步骤上限”后重试。`;

function looksLikeDocumentArtifactTask(userText: string, skills: AgentSkillRuntime[]) {
  const text = `${userText}\n${skills.map((skill) => `${skill.name}\n${skill.description}\n${skill.instructions || ''}`).join('\n')}`.toLowerCase();
  return /(pdf|docx?|word|ppt|slides?|excel|spreadsheet|report|itinerary|travel|guide|brochure|brief|readme|markdown|\.md|\.html|html|css|网站|页面|落地页|简报|验收|行程|旅游|旅行|攻略|报告|手册|文档|海报)/i.test(text);
}

/** Live market / quote pulls — not brand tone words like 金融质感 / 证券从业背景. */
function looksLikeLiveMarketTask(userText: string) {
  return /(实时行情|今日行情|股价|报价|指数走势|k线|大盘走势|涨跌幅|get_.*quote|stock\s*sdk|akshare|拉取.*证券数据|证券数据|fund net value|crypto\s*price)/i.test(userText);
}

function looksLikeWorkspaceWritingTask(userText: string) {
  return /(write_workspace_file|交付文件|写入.*\.md|产出.*页面|项目根|workspace root|output\/|html|css|简报|验收清单|readme)/i.test(userText);
}

/** Finance / market MCP ids & tool names that burn steps on non-market tasks. */
export function isFinanceLikeMcpName(name: string): boolean {
  const lower = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return /(^|_)(akshare|tushare|stock_sdk|stock|finance|crypto|eastmoney|jqdata|joinquant|market_data)(_|$)/.test(lower)
    || lower.includes('trading_day')
    || lower.includes('a_share')
    || lower.includes('get_index_history')
    || lower.includes('is_trading_day');
}

function prefersNativeCodingTools(userText: string) {
  return /(网站|网页|页面|html|css|javascript|typescript|react|vue|前端|landing page|website|web app|代码|code)/i.test(userText);
}

function sanitizeMcpPrefix(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

/**
 * Drop MCP tools that burn steps without helping the task.
 * - filesystem always conflicts with write_workspace_file / project cwd
 * - finance MCPs stay only for live market pulls (not “金融质感” brand copy)
 */
export function filterMcpToolsetForTask(
  mcp: Awaited<ReturnType<typeof loadMcpToolset>>,
  userText: string,
  skills: AgentSkillRuntime[],
  opts?: { projectBound?: boolean },
) {
  const writing = looksLikeDocumentArtifactTask(userText, skills)
    || looksLikeWorkspaceWritingTask(userText)
    || Boolean(opts?.projectBound);
  const liveMarket = looksLikeLiveMarketTask(userText);
  const needsFetch = /(竞品|调研|抓取|crawl|scrape|官网内容|网页正文)/i.test(userText);
  /** Local data-app instant programming — never burn steps on MCP fetch. */
  const dataAppBuild = /(data-apps\/|本机数据 API|custom-site|bind_data_app_custom_site|即时编程|按想法定制|单文件 HTML|output\/index\.html)/i.test(userText);

  const blockedPrefixes = new Set<string>();
  if (writing || opts?.projectBound || dataAppBuild) {
    blockedPrefixes.add('filesystem');
    blockedPrefixes.add('sequential_thinking');
    blockedPrefixes.add('sequentialthinking');
  }
  if ((writing && !liveMarket) || dataAppBuild) {
    blockedPrefixes.add('akshare');
    blockedPrefixes.add('tushare');
    blockedPrefixes.add('stock');
    blockedPrefixes.add('stock_sdk');
    blockedPrefixes.add('finance');
    if (!needsFetch || dataAppBuild) blockedPrefixes.add('fetch');
  }
  if (!blockedPrefixes.size) return mcp;

  const keepTools = mcp.tools.filter((tool) => {
    const lower = tool.name.toLowerCase();
    if (dataAppBuild && /fetch/i.test(lower)) return false;
    if (writing && !liveMarket && isFinanceLikeMcpName(tool.name)) return false;
    for (const prefix of blockedPrefixes) {
      if (lower.startsWith(`mcp_${prefix}_`)) return false;
      // Also drop tools whose sanitized connection label embeds the blocked name mid-string.
      if (lower.includes(`_${prefix}_`) || lower.endsWith(`_${prefix}`)) return false;
    }
    return true;
  });
  const keepNames = new Set(keepTools.map((tool) => tool.name));
  const keepDescriptors = mcp.toolDescriptors.filter((tool) => keepNames.has(tool.name));
  const keepLabels = mcp.labels.filter((label) => {
    const sanitized = sanitizeMcpPrefix(label);
    if (blockedPrefixes.has(sanitized)) return false;
    if (writing && !liveMarket && isFinanceLikeMcpName(label)) return false;
    return true;
  });
  const filtered = keepTools.length !== mcp.tools.length;
  return {
    ...mcp,
    tools: keepTools,
    toolDescriptors: keepDescriptors,
    labels: keepLabels,
    instructions: filtered ? '' : mcp.instructions,
  };
}

/** Filter MCP connector configs before dsh warm/bridge (same policy as tool filtering). */
export function filterMcpConnectionsForTask<T extends { id?: string; name?: string; enabled?: boolean }>(
  connections: T[] | undefined,
  userText: string,
  opts?: { projectBound?: boolean },
): T[] {
  const list = Array.isArray(connections) ? connections : [];
  const writing = looksLikeDocumentArtifactTask(userText, [])
    || looksLikeWorkspaceWritingTask(userText)
    || Boolean(opts?.projectBound);
  const liveMarket = looksLikeLiveMarketTask(userText);
  const dataAppBuild = /(data-apps\/|本机数据 API|custom-site|bind_data_app_custom_site|即时编程|按想法定制|单文件 HTML|output\/index\.html)/i.test(userText);
  if ((!writing && !dataAppBuild) || liveMarket) return list;
  return list.filter((item) => {
    const key = `${item.id || ''} ${item.name || ''}`;
    if (isFinanceLikeMcpName(key)) return false;
    if (dataAppBuild && /fetch/i.test(key)) return false;
    return true;
  });
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
  if (toolName === 'write') return `正在写入工作区文件：${String(value.path || '')}`;
  if (toolName === 'edit') return `正在更新工作区文件：${String(value.path || '')}`;
  if (toolName === 'read') return `正在读取工作区文件：${String(value.path || '')}`;
  if (toolName === 'bash') return '正在执行受控工作区命令。';
  if (toolName === 'commit_artifact') return `正在提交业务交付物：${String(value.path || '')}`;
  if (toolName === 'preview_server_start') {
    return `正在启动本地网站${value.access === 'lan' ? '局域网部署' : '预览'}${value.root ? `：${String(value.root)}` : '（自动映射 SITE/项目目录）'}`;
  }
  if (toolName === 'preview_server_stop') return `正在停止本地网站服务：${String(value.id || value.port || '')}`;
  if (toolName === 'preview_server_status') return '正在查询本地网站预览/部署状态。';
  if (toolName === 'start_workspace_write') return `正在开始分阶段写入：${String(value.path || '')}`;
  if (toolName === 'append_workspace_write') {
    const seq = typeof value.seq === 'number' ? ` seq=${value.seq}` : '';
    return `正在追加分阶段写入片段：${String(value.writeId || '').slice(0, 8)}…${seq}`;
  }
  if (toolName === 'finish_workspace_write') return `正在提交分阶段写入：${String(value.writeId || '').slice(0, 8)}…`;
  if (toolName === 'start_artifact_source_write') return `正在开始大型交付物写入：${String(value.path || '')}`;
  if (toolName === 'append_artifact_source_write') return `正在追加大型交付物片段：${String(value.writeId || '').slice(0, 8)}… seq=${String(value.seq || '')}`;
  if (toolName === 'finish_artifact_source_write') return `正在原子提交大型交付物：${String(value.writeId || '').slice(0, 8)}…`;
  if (toolName === 'publish_to_project') {
    const dest = value.destPath ? ` → ${String(value.destPath)}` : '';
    return `正在发布到项目空间：${String(value.path || '')}${dest}`;
  }
  if (toolName === 'register_deliverable') return `正在登记业务交付物：${String(value.path || '')}`;
  if (toolName === 'render_pdf_report') return `正在由 PDF Skill 生成文档：${String(value.filename || '')}`;
  if (toolName === 'run_skill_script') return `正在执行脚本：${String(value.path || '')}`;
  if (toolName === 'run_workspace_script') return `正在执行生成脚本：${String(value.path || '')}`;
  if (toolName === 'install_python_dependency') return `正在安装 Python 依赖：${String(value.package || '')}`;
  if (toolName === 'fetch_skill_url') return `正在访问网络资源：${String(value.url || '')}`;
  if (toolName === 'bind_data_app_custom_site') return `正在绑定数据应用定制站：${String(value.appId || '')}`;
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
  if (toolName === 'render_pdf_report') return `PDF Skill 已完成：${String(value.path || 'PDF 文件')}。`;
  if (toolName === 'run_workspace_script') {
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts.filter((item): item is string => typeof item === 'string') : [];
    return artifacts.length ? `生成脚本执行完成：${artifacts.join('、')}` : `生成脚本执行完成（退出码 ${String(value.exitCode ?? 0)}）。`;
  }
  if (toolName === 'write_workspace_file') {
    const mode = value.mode === 'append' ? '已追加' : '已写入';
    return `${mode} ${String(value.path || '运行工作区文件')}${typeof value.totalBytes === 'number' ? `（共 ${value.totalBytes} 字节）` : '。'}`;
  }
  if (toolName === 'write') return '已写入工作区文件。';
  if (toolName === 'edit') return '已更新工作区文件。';
  if (toolName === 'read') return '已读取工作区文件。';
  if (toolName === 'bash') return '工作区命令已执行。';
  if (toolName === 'commit_artifact') {
    return `交付物已提交：${String(value.path || '')}${typeof value.bytes === 'number' ? `（${value.bytes} 字节）` : ''}`;
  }
  if (toolName === 'preview_server_start') {
    const access = value.access === 'lan' ? '局域网部署' : '本地预览';
    return value.reused
      ? `已复用${access}：${String(value.url || '')}`
      : `${access}已启动：${String(value.url || '')}`;
  }
  if (toolName === 'preview_server_stop') {
    return `已停止 ${String(value.stopped ?? 0)} 个本地网站服务。`;
  }
  if (toolName === 'preview_server_status') {
    const servers = Array.isArray(value.servers) ? value.servers : [];
    return servers.length
      ? `当前服务：${servers.map((item) => (item && typeof item === 'object' ? String((item as { url?: string }).url || '') : '')).filter(Boolean).join('、')}`
      : '当前没有运行中的本地预览/部署。';
  }
  if (toolName === 'start_workspace_write') {
    return `已开始分阶段写入：${String(value.path || '')}（writeId ${String(value.writeId || '').slice(0, 8)}…）`;
  }
  if (toolName === 'append_workspace_write') {
    const seq = typeof value.seq === 'number' ? `seq=${value.seq} ` : '';
    return `已追加 ${seq}${String(value.appended ?? 0)} 字节（累计 ${String(value.totalBytes ?? 0)}，${String(value.parts ?? 0)} 片）`;
  }
  if (toolName === 'finish_workspace_write') {
    const mode = value.mode === 'append' ? '已追加提交' : '已提交写入';
    return `${mode} ${String(value.path || '运行工作区文件')}${typeof value.totalBytes === 'number' ? `（共 ${value.totalBytes} 字节）` : '。'}`;
  }
  if (toolName === 'start_artifact_source_write') return `已开始大型交付物写入：${String(value.path || '')}`;
  if (toolName === 'append_artifact_source_write') return `已接收大型交付物片段：${String(value.receivedParts || 0)} 段。`;
  if (toolName === 'finish_artifact_source_write') return `大型交付物已原子写入：${String(value.path || '')}${typeof value.bytes === 'number' ? `（${value.bytes} 字节）` : ''}`;
  if (toolName === 'publish_to_project') {
    return `已发布到项目空间：${String(value.projectPath || value.path || '')}${typeof value.bytes === 'number' ? `（${value.bytes} 字节）` : ''}`;
  }
  if (toolName === 'register_deliverable') {
    return `已登记业务交付物：${String(value.path || '')}${typeof value.bytes === 'number' ? `（${value.bytes} 字节）` : ''}`;
  }
  if (toolName === 'fetch_skill_url') return `已获取网络资源（${String(value.contentType || 'text')}）。`;
  if (toolName === 'bind_data_app_custom_site') {
    return value.ok === false
      ? `定制站绑定失败：${failText()}`
      : `已绑定数据应用定制站：${String(value.url || value.appId || '')}`;
  }
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
  if (toolName === 'run_workspace_script' || toolName === 'run_skill_script' || toolName === 'render_pdf_report') {
    const artifacts = value.artifacts;
    if (Array.isArray(artifacts)) {
      for (const artifact of artifacts) {
        if (typeof artifact === 'string') pushDeliverable(artifact);
      }
    }
  }
  if (toolName === 'write_workspace_file' || toolName === 'finish_workspace_write' || toolName === 'register_deliverable' || toolName === 'commit_artifact') {
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
  conversationId?: string;
  projectWorkspacePath?: string;
  workspaceAccess?: 'read' | 'write' | 'full';
  maxSteps?: number;
  runTimeoutMs?: number;
  mcpToolTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const runId = input.runId?.trim() || crypto.randomUUID();
  const conversationId = input.conversationId?.trim() || '';
  const projectRoot = input.projectWorkspacePath?.trim() || '';
  const workspaceMode = resolveWorkspaceMode(projectRoot);
  const projectBound = workspaceMode === 'project';
  yield { type: 'run.started', runId };

  const knowledgeTools = createKnowledgeTools({ knowledgeBases: input.knowledgeBases, model: input.model });
  const experienceTools = createExperienceTools({ agentId: input.profile.id, model: input.model });
  const lastUserText = [...input.messages].reverse().find((item) => item.role === 'user')?.content || '';
  const eligibleMcpConnections = filterMcpConnectionsForTask(input.mcpConnections, lastUserText, { projectBound });
  // Overlap MCP connect with experience recall — both were serial TTFT taxes.
  const mcpPromise = loadMcpToolset(eligibleMcpConnections, { toolTimeoutMs: input.mcpToolTimeoutMs });
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
    const mcp = filterMcpToolsetForTask(mcpLoaded, lastUserText, skills, { projectBound });
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
      skillFirstExecutionContract(projectBound),
      workspaceModeContract(workspaceMode),
      'Associated Skill instructions are preloaded before the first model turn whenever available, so prefer those specialized procedures immediately instead of exploring generic alternatives. Preloading is for reasoning only: if you need packaged Skill files or bundled Skill scripts, call load_skill for that relevant user Skill first. Workspace and artifact operations are platform Tools, not a Skill: follow each Tool schema and result exactly. Skill files are read-only. Never claim an operation ran unless its Tool returned a successful result. For artifact requests, do not stop at a plan: produce and verify the file, then commit it with commit_artifact. Once a verified deliverable exists, stop calling tools and return the result. In the user-facing answer, refer to the delivered asset by its filename, not its internal workspace path. Use reasonable defaults for non-critical details; if a required permission, script, dependency, or output path is unavailable, state the exact blocker and the one next user action.',
      'Agent runtime: Workmate pi-agent-core + pi-coding-agent skills catalog.',
    ].filter(Boolean).join('\n\n');

    // Keep the configured task budget. Do not impose a document-specific global
    // cap: aborting an Agent after it has already queued work produces the false
    // "file succeeded, run failed" state.
    const requestedMaxSteps = Math.min(64, Math.max(50, Math.round(Number(input.maxSteps) || 50)));
    const maxSteps = requestedMaxSteps;
    const piModel = toPiModel(input.model);
    const onPayload = createChatCompletionsPayloadPatch(input.model);
    const workspaceRoot = resolveAgentWorkspaceRoot({
      runId,
      projectWorkspacePath: projectRoot || undefined,
    });
    const platformTools = createSkillExecutionTools({ skills, runId, projectRoot: projectRoot || undefined, workspaceAccess: input.workspaceAccess });
    // Websites and code use Pi's native tools. Keep legacy workspace tools only
    // for non-coding Skills during the migration window.
    const skillTools = prefersNativeCodingTools(lastUserText)
      ? platformTools.filter((tool) => !new Set([
        'write_workspace_file', 'start_workspace_write', 'append_workspace_write',
        'finish_workspace_write', 'register_deliverable',
      ]).has(tool.name))
      : platformTools;
    const agentTools = collectAgentTools(
      createPiCapabilityTools({
        runId,
        workspaceRoot,
        workspaceAccess: input.workspaceAccess ?? 'write',
        workspaceMode,
      }),
      createPreviewServerTools({
        workspaceRoot,
        workspaceAccess: input.workspaceAccess ?? 'write',
        projectId: projectBound ? projectRoot : undefined,
        conversationId: conversationId || undefined,
        workspaceMode,
      }),
      skillTools,
      searchTools,
      knowledgeTools,
      experienceTools,
      mcp.tools,
    );

    let emittedText = false;
    let lastToolSucceeded: boolean | undefined;
    let toolTurns = 0;
    let runFailed = false;
    let stepBudgetExceeded = false;
    let usageSteps = 0;
    const modelRef = modelRefFromConfig(input.model);
    const emittedArtifactPaths = new Set<string>();
    const projectFilesBefore = projectBound
      ? await snapshotWorkspaceFiles(projectRoot).catch(() => new Map<string, string>())
      : null;

    const publishProjectDiff = async () => {
      if (!projectBound || !projectFilesBefore) return;
      const after = await snapshotWorkspaceFiles(projectRoot).catch(() => new Map<string, string>());
      for (const [relative, fingerprint] of after) {
        if (projectFilesBefore.get(relative) === fingerprint) continue;
        enqueue({ type: 'project.file.published', runId, path: relative, projectPath: relative });
      }
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: runtimeInstructions,
        model: piModel,
        thinkingLevel: 'off',
        tools: agentTools,
        messages: [],
      },
      convertToLlm,
      // Per-turn hygiene then optional summary (docs/design/context-hygiene.md):
      // strip thinking → path-only writes → wrap/truncate command results → compact.
      transformContext: async (messages, signal) => {
        const sanitized = sanitizeToolPayloadsInMessages(messages);
        return compactAgentContext({
          messages: sanitized,
          model: input.model,
          piModel,
          signal,
        });
      },
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
        } else if (evt.type === 'thinking_delta' && evt.delta) {
          enqueue({ type: 'reasoning.delta', runId, text: evt.delta });
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
          stepBudgetExceeded = true;
          runFailed = true;
          agent.abort();
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
        if (runFailed) {
          // Step-budget aborts often happen after files are already on disk —
          // publish them so the orchestrator can soft-complete the DAG node.
          if (stepBudgetExceeded) {
            await publishProjectDiff();
            enqueue({ type: 'run.failed', runId, message: STEP_BUDGET_EXCEEDED_MESSAGE(maxSteps) });
          }
          return;
        }
        if (!emittedText && lastToolSucceeded !== undefined) {
          enqueue({
            type: 'message.delta',
            runId,
            text: lastToolSucceeded
              ? '工具调用已完成。请查看上方执行记录和运行工作区产物。'
              : '工具未能完成请求；请查看上方执行记录中的权限或输入原因。',
          });
        }
        if (projectBound && projectFilesBefore) {
          // Project mode: cwd is project root — publish changed files (aligned with dsh).
          await publishProjectDiff();
        }
        enqueue({ type: 'run.completed', runId });
      } catch (error) {
        if (stepBudgetExceeded) {
          await publishProjectDiff();
          enqueue({ type: 'run.failed', runId, message: STEP_BUDGET_EXCEEDED_MESSAGE(maxSteps) });
        } else if (isAbortLike(error, abortSignal)) {
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
