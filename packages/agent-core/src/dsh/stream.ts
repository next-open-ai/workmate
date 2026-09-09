import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import type { AgentEvent, ChatRequest, McpConnectionRuntime } from '@workmate/contracts';
import { DshJsonRpcClient } from './jsonrpc-client.js';
import { resolveDshLaunch, resolveDshWorkspace } from './launch.js';
import { createDshEventMapContext, mapDshSessionEvent, unwrapAssembledDelta } from './map-events.js';
import { mapWorkmateModelToDshRoute } from './model-route.js';
import { writeWorkmateDshCordis } from './cordis-compose.js';
import { materializeWorkmateSkillsForDsh } from './skills-materialize.js';
import { warmMcpConnections, type McpWarmResult } from '../mcp-runtime.js';
import { openDshMcpBridges } from '../mcp-dsh-bridge.js';
import { harvestWorkspaceDeliverables } from '../skill-runtime.js';

type DshMcpCatalog = {
  labels: string[];
  toolLines: string[];
};

const DSH_INTERNAL_ENTRIES = new Set([
  '.agents',
  '.dsh-sessions',
  '.git',
  '.python-packages',
  'node_modules',
]);

async function snapshotProjectFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string, relative = '', depth = 0): Promise<void> => {
    if (depth > 12 || files.size >= 2_000) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (DSH_INTERNAL_ENTRIES.has(entry.name) || entry.name === '.workmate-dsh.cordis.yml') continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target, childRelative, depth + 1);
      } else if (entry.isFile() && childRelative.length <= 240) {
        const info = await stat(target).catch(() => null);
        if (info) files.set(childRelative, `${info.size}:${info.mtimeMs}`);
      }
      if (files.size >= 2_000) return;
    }
  };
  await visit(root);
  return files;
}

function cancellationEvent(runId: string, signal: AbortSignal): AgentEvent {
  const detail = signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : '';
  const timedOut = /timed?\s*out|timeout/i.test(detail);
  return {
    type: 'run.cancelled',
    runId,
    reason: timedOut ? 'timeout' : 'user',
    message: timedOut ? (detail || '执行超时，已中止当前任务。') : (detail || '已由用户中止当前执行。'),
  };
}

function buildPrompt(input: ChatRequest, mcpCatalog?: DshMcpCatalog): string {
  const lines: string[] = [];
  const profile = input.profile?.instructions?.trim();
  if (profile) {
    lines.push(`[Workmate agent profile]\n${profile.slice(0, 8_000)}`);
  }
  const skillNames = (input.skills ?? [])
    .filter((skill) => skill.mode === 'available' || skill.mode === 'default')
    .map((skill) => skill.name)
    .filter(Boolean)
    .slice(0, 24);
  if (skillNames.length) {
    lines.push(
      `[Authorized skills — use the skill tool first when the task matches]\n`
      + `${skillNames.map((name) => `- ${name}`).join('\n')}\n`
      + `For PDF / Word / slides / spreadsheet deliverables: load the matching document skill BEFORE ad-hoc bash exploration.`,
    );
  }
  lines.push(input.projectWorkspacePath?.trim()
    ? `[Project workspace contract]\n`
      + `The current working directory is the final shared project root. Create and edit the actual project structure directly here. `
      + `Use conventional root entry files when appropriate to the chosen stack. Do not wrap the project in output/. `
      + `Keep temporary process files out of the final project tree.`
    : `[Deliverables contract]\n`
      + `Finished user-facing files (PDF, DOCX, HTML, Markdown, CSV, images, …) MUST be written under output/ `
      + `(create the directory if needed). Prefer output/<clear-name>.pdf over workspace-root files. `
      + `Do not leave the only copy of a deliverable under scripts/ or /tmp.`);
  const mcpNames = mcpCatalog?.labels?.length
    ? mcpCatalog.labels
    : (input.mcpConnections ?? [])
      .filter((item) => item.enabled !== false)
      .map((item) => item.name)
      .slice(0, 12);
  if (mcpNames.length) {
    lines.push(
      `[MCP servers — prefer these tools over bash exploration]\n`
      + `Tools are already registered as mcp__<server>__<tool>. Connected: ${mcpNames.join(', ')}.\n`
      + `For market / index / stock / fund / macro data: call the matching mcp__ tool FIRST in one shot `
      + `(e.g. get_index_history / get_a_share_quotes). Do NOT use bash, curl, python, pip, or env probes `
      + `to rediscover APIs or scrape when an mcp__ tool can answer. Only fall back to bash if every `
      + `relevant mcp__ call failed with a concrete error.`,
    );
    if (mcpCatalog?.toolLines?.length) {
      lines.push(`[Discovered MCP tool names]\n${mcpCatalog.toolLines.join('\n')}`);
    }
  }
  const history = (input.messages ?? []).slice(-12);
  for (const message of history) {
    const role = message.role === 'assistant' ? 'Assistant' : 'User';
    const content = String(message.content || '').trim();
    if (!content) continue;
    lines.push(`${role}: ${content.slice(0, 12_000)}`);
  }
  if (!lines.length) lines.push('User: (empty)');
  return lines.join('\n\n');
}

function credentialEnv(route: ReturnType<typeof mapWorkmateModelToDshRoute>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...route.env };
  env.OPENAI_API_KEY = route.apiKey;
  env.DEEPSEEK_API_KEY = route.apiKey;
  if (route.api === 'anthropic-messages') env.ANTHROPIC_API_KEY = route.apiKey;
  env.OPENAI_BASE_URL = route.baseUrl;
  env.DEEPSEEK_BASE_URL = route.baseUrl;
  return env;
}

function enabledMcpConnections(connections: McpConnectionRuntime[] | undefined): McpConnectionRuntime[] {
  return (connections ?? []).filter((item) => item.enabled !== false);
}

/**
 * Stream a ChatRequest through DeepSeek Harness JSON-RPC sidecar (coding engine).
 * Injects Workmate ModelConfig, MCP connections, and authorized skills into cordis.
 *
 * MCP strategy:
 * 1. Warm/pin connectors in the Workmate process pool (first call cold, later hits fast).
 * 2. Bridge warmed stdio MCPs over localhost HTTP so dsh reuses the live process
 *    (no second npx cold start) and we can gate the first prompt on tools/list.
 * 3. Release bridge + warm pin after the run so idle TTL can reap unused servers.
 */
export async function* streamAgentReplyViaDsh(input: ChatRequest & {
  abortSignal?: AbortSignal;
  runId?: string;
}): AsyncGenerator<AgentEvent> {
  const runId = input.runId?.trim() || randomUUID();
  yield { type: 'run.started', runId };

  // DSH works directly in its cwd and does not proxy filesystem operations
  // through the TypeScript host. Until it has an OS-level read-only sandbox,
  // accepting a read-only run here would silently bypass the platform contract.
  if (input.workspaceAccess === 'read') {
    yield {
      type: 'run.failed',
      runId,
      message: 'DSH 当前不支持只读工作区任务；请改用 PI 或 AgentScope，或将任务权限调整为可写。',
    };
    return;
  }

  let client: DshJsonRpcClient | null = null;
  let warm: McpWarmResult | null = null;
  let bridges: Awaited<ReturnType<typeof openDshMcpBridges>> | null = null;
  const runStartedAtMs = Date.now();
  try {
    const cwd = resolveDshWorkspace({
      runId,
      projectWorkspacePath: input.projectWorkspacePath,
    });
    const projectBound = Boolean(input.projectWorkspacePath?.trim());
    const projectFilesBefore = projectBound ? await snapshotProjectFiles(cwd) : null;
    const route = mapWorkmateModelToDshRoute(input.model);
    const mcpEnabled = enabledMcpConnections(input.mcpConnections);

    if (mcpEnabled.length) {
      yield {
        type: 'tool.started',
        runId,
        toolName: 'mcp.warm',
        summary: `预热 MCP（${mcpEnabled.map((item) => item.name).join('、')}）…`,
      };
      warm = await warmMcpConnections(mcpEnabled, { toolTimeoutMs: input.mcpToolTimeoutMs });
      const okCount = warm.items.filter((item) => item.ok).length;
      const hitCount = warm.items.filter((item) => item.ok && item.cacheHit).length;
      const failCount = warm.items.filter((item) => !item.ok).length;
      const summary = failCount
        ? `MCP 预热：${okCount}/${mcpEnabled.length} 可用（缓存命中 ${hitCount}），${failCount} 失败`
        : warm.hadColdStart
          ? `MCP 预热完成（冷启动 ${okCount} 个；下次同连接将复用进程）`
          : `MCP 预热命中缓存（${hitCount} 个，即时可用）`;
      yield {
        type: 'tool.completed',
        runId,
        toolName: 'mcp.warm',
        summary,
        ok: okCount > 0 || mcpEnabled.length === 0,
      };
      if (okCount === 0) {
        yield {
          type: 'run.failed',
          runId,
          message: `MCP 预热全部失败，已中止本轮以免退回 bash 探测：${warm.items.map((item) => `${item.name}: ${item.error || 'unknown'}`).join('; ')}`,
        };
        return;
      }
    }

    const mcpCatalog: DshMcpCatalog = {
      labels: warm?.labels?.length
        ? warm.labels
        : mcpEnabled.map((item) => item.name).slice(0, 12),
      toolLines: warm?.toolLines ?? [],
    };

    const warmedOk = mcpEnabled.filter((conn) => {
      if (!warm) return true;
      const item = warm.items.find((row) => row.name === conn.name);
      return !item || item.ok;
    });
    if (warmedOk.length) {
      bridges = await openDshMcpBridges(warmedOk);
    }
    const mcpForCordis = bridges?.cordisConnections ?? warmedOk;

    const skillsRoot = materializeWorkmateSkillsForDsh(cwd, input.skills);
    const customCordis = process.env.WORKMATE_DSH_CORDIS?.trim();
    const cordisConfig = customCordis
      ? path.resolve(customCordis)
      : writeWorkmateDshCordis(cwd, {
          route,
          // Bridged http URLs when possible; never pass connectors that failed warm
          // (failOnStartupError:true would otherwise block the whole dsh boot).
          mcpConnections: mcpForCordis,
          skillsEnabled: Boolean(skillsRoot),
          customSkillDirs: skillsRoot ? [skillsRoot] : [],
          mcpToolTimeoutMs: input.mcpToolTimeoutMs,
        });
    const launch = resolveDshLaunch({ cordisConfig });

    const env: NodeJS.ProcessEnv = {
      ...credentialEnv(route),
      DSH_CORDIS_CONFIG: launch.cordisConfig,
      DSH_CWD: cwd,
      DSH_SESSION_ROOT: path.join(cwd, '.dsh-sessions'),
      DSH_SYSTEM_PROMPT: (() => {
        const base = input.profile?.instructions?.slice(0, 4_000)
          || 'You are a careful coding agent working inside a Workmate workspace.';
        const mcpNames = mcpCatalog.labels;
        const deliverable = projectBound
          ? '\n\nThis cwd is the final shared project root. Write the real project structure directly here; do not create an output/ wrapper.'
          : '\n\nFinished PDF/DOCX/HTML/Markdown must be saved under output/. Prefer loading document skills via the skill tool before ad-hoc PDF tooling.';
        if (!mcpNames.length) return `${base}${deliverable}`;
        const discovered = mcpCatalog.toolLines.length
          ? `\nAvailable MCP tools:\n${mcpCatalog.toolLines.join('\n')}`
          : '';
        return `${base}${deliverable}\n\nConnected MCP servers (use mcp__* tools first for market/index/stock data; avoid bash/curl/pip discovery): ${mcpNames.join(', ')}.${discovered}`;
      })(),
    };

    if (mcpCatalog.labels.length) {
      yield {
        type: 'tool.started',
        runId,
        toolName: 'mcp.dsh-boot',
        summary: bridges?.bridges.length
          ? `启动编码引擎并挂载 MCP（经本地桥接复用预热进程）…`
          : warm?.hadColdStart
            ? '启动编码引擎并挂载 MCP（已预热包缓存，仍需短暂拉起 sidecar）…'
            : '启动编码引擎并挂载 MCP（复用预热缓存）…',
      };
    }

    client = new DshJsonRpcClient(launch.command, launch.args, env, launch.spawnCwd ?? cwd);
    await client.initialize({
      cwd,
      provider: route.provider,
      model: route.model,
    });

    if (bridges?.bridges.length) {
      const listed = await Promise.all(
        bridges.bridges.map((bridge) => bridge.waitUntilListed(90_000)),
      );
      const missing = bridges.bridges
        .filter((_, index) => !listed[index])
        .map((bridge) => bridge.name);
      if (missing.length) {
        yield {
          type: 'run.failed',
          runId,
          message: `编码引擎已启动，但 MCP 工具未在时限内挂载（${missing.join('、')}）。已中止以免退回 bash 探测；请重试或检查连接器。`,
        };
        return;
      }
    }

    if (mcpCatalog.labels.length) {
      yield {
        type: 'tool.completed',
        runId,
        toolName: 'mcp.dsh-boot',
        summary: bridges?.bridges.length
          ? `编码引擎已就绪，MCP 经桥接挂载：${mcpCatalog.labels.join('、')}`
          : `编码引擎已就绪，MCP 工具已注册：${mcpCatalog.labels.join('、')}`,
        ok: true,
      };
    }

    const sessionId = `wm-${runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || randomUUID().replace(/-/g, '')}`;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let failed = false;
    let emittedText = false;
    const eventMapCtx = createDshEventMapContext();
    const bump = () => { wake?.(); wake = null; };

    const off = client.onNotification((note) => {
      if (note.method === 'session.status') {
        if (note.params.sessionId === sessionId && note.params.status === 'idle') {
          done = true;
          bump();
        }
        return;
      }
      if (note.method !== 'session.event') return;
      if (note.params.sessionId !== sessionId) return;
      const mapped = mapDshSessionEvent(runId, note.params.event, eventMapCtx);
      for (const event of mapped) {
        if (event.type === 'message.delta') {
          const { assembled, text } = unwrapAssembledDelta(event.text);
          if (assembled) {
            if (emittedText || !text) continue;
            queue.push({ type: 'message.delta', runId, text });
            emittedText = true;
          } else {
            queue.push({ type: 'message.delta', runId, text });
            emittedText = true;
          }
          bump();
          continue;
        }
        if (event.type === 'run.failed') failed = true;
        queue.push(event);
        bump();
      }
    });

    const onAbort = () => {
      done = true;
      bump();
      void client?.shutdown();
    };
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      await client.prompt(sessionId, buildPrompt(input, mcpCatalog));

      while (!done || queue.length) {
        if (input.abortSignal?.aborted) {
          yield cancellationEvent(runId, input.abortSignal);
          return;
        }
        while (queue.length) {
          const event = queue.shift()!;
          yield event;
          if (event.type === 'run.failed') return;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length || done) resolve();
        });
        wake = null;
      }

      // onAbort also flips `done`; re-check after the loop so a timeout can
      // never be converted into a successful completion.
      if (input.abortSignal?.aborted) {
        yield cancellationEvent(runId, input.abortSignal);
        return;
      }

      if (!failed) {
        if (projectFilesBefore) {
          const after = await snapshotProjectFiles(cwd);
          for (const [relative, fingerprint] of after) {
            if (projectFilesBefore.get(relative) === fingerprint) continue;
            yield { type: 'project.file.published', runId, path: relative, projectPath: relative };
          }
        } else {
          // Standalone chat runs retain the output/ asset contract.
          const harvested = await harvestWorkspaceDeliverables(cwd, { startedAtMs: runStartedAtMs }).catch(() => []);
          for (const relative of harvested) {
            yield { type: 'artifact.created', runId, path: relative };
          }
        }
        yield { type: 'run.completed', runId };
      }
    } finally {
      off();
      input.abortSignal?.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    if (input.abortSignal?.aborted) {
      yield cancellationEvent(runId, input.abortSignal);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const mcpHint = /mcp-client|initial connection|tool synchronization/i.test(message)
      ? '（MCP 启动失败：请在「技能与连接」中重新测试对应连接器，或稍后再试；首次 npx 冷启动可能较慢。）'
      : '';
    yield { type: 'run.failed', runId, message: `${message}${mcpHint}` };
  } finally {
    await client?.shutdown().catch(() => undefined);
    await bridges?.close().catch(() => undefined);
    warm?.release();
  }
}
