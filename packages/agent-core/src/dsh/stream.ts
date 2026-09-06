import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, ChatRequest } from '@workmate/contracts';
import { DshJsonRpcClient } from './jsonrpc-client.js';
import { resolveDshLaunch, resolveDshWorkspace } from './launch.js';
import { mapDshSessionEvent, unwrapAssembledDelta } from './map-events.js';
import { mapWorkmateModelToDshRoute } from './model-route.js';
import { writeWorkmateDshCordis } from './cordis-compose.js';

function buildPrompt(input: ChatRequest): string {
  const lines: string[] = [];
  const profile = input.profile?.instructions?.trim();
  if (profile) {
    lines.push(`[Workmate agent profile]\n${profile.slice(0, 8_000)}`);
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
  // Broad aliases so a custom cordis (WORKMATE_DSH_CORDIS) can still resolve keys.
  env.OPENAI_API_KEY = route.apiKey;
  env.DEEPSEEK_API_KEY = route.apiKey;
  if (route.api === 'anthropic-messages') env.ANTHROPIC_API_KEY = route.apiKey;
  env.OPENAI_BASE_URL = route.baseUrl;
  env.DEEPSEEK_BASE_URL = route.baseUrl;
  return env;
}

/**
 * Stream a ChatRequest through DeepSeek Harness JSON-RPC sidecar (coding engine).
 * Uses Workmate ModelConfig → generated llm-pi-ai cordis (unless WORKMATE_DSH_CORDIS is set).
 */
export async function* streamAgentReplyViaDsh(input: ChatRequest & {
  abortSignal?: AbortSignal;
  runId?: string;
}): AsyncGenerator<AgentEvent> {
  const runId = input.runId?.trim() || randomUUID();
  yield { type: 'run.started', runId };

  let client: DshJsonRpcClient | null = null;
  try {
    const cwd = resolveDshWorkspace({
      runId,
      projectWorkspacePath: input.projectWorkspacePath,
    });
    const route = mapWorkmateModelToDshRoute(input.model);
    const customCordis = process.env.WORKMATE_DSH_CORDIS?.trim();
    const cordisConfig = customCordis
      ? path.resolve(customCordis)
      : writeWorkmateDshCordis(cwd, route);
    const launch = resolveDshLaunch({ cordisConfig });

    const env: NodeJS.ProcessEnv = {
      ...credentialEnv(route),
      DSH_CORDIS_CONFIG: launch.cordisConfig,
      DSH_CWD: cwd,
      DSH_SESSION_ROOT: path.join(cwd, '.dsh-sessions'),
      DSH_SYSTEM_PROMPT: input.profile?.instructions?.slice(0, 4_000)
        || 'You are a careful coding agent working inside a Workmate workspace.',
    };

    client = new DshJsonRpcClient(launch.command, launch.args, env, launch.spawnCwd ?? cwd);
    await client.initialize({
      cwd,
      provider: route.provider,
      model: route.model,
    });

    const sessionId = `wm-${runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || randomUUID().replace(/-/g, '')}`;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let failed = false;
    let emittedText = false;
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
      const mapped = mapDshSessionEvent(runId, note.params.event);
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
      await client.prompt(sessionId, buildPrompt(input));

      while (!done || queue.length) {
        if (input.abortSignal?.aborted) {
          yield {
            type: 'run.cancelled',
            runId,
            reason: 'user',
            message: '已由用户中止当前执行。',
          };
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

      if (!failed) yield { type: 'run.completed', runId };
    } finally {
      off();
      input.abortSignal?.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    if (input.abortSignal?.aborted) {
      yield {
        type: 'run.cancelled',
        runId,
        reason: 'user',
        message: '已由用户中止当前执行。',
      };
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    yield { type: 'run.failed', runId, message };
  } finally {
    await client?.shutdown().catch(() => undefined);
  }
}
