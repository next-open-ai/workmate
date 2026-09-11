import path from 'node:path';
import os from 'node:os';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { getSharedAgentscopeRuntimeStats } from '@workmate/agent-core';
import { JsonFileStore, Orchestrator, createScriptedRunner, type AgentRunner, type OrcEvent } from '@workmate/orchestrator';
import type { ChatRunContext, ConfirmProjectInput, CreateProjectDraftInput, ProjectTask, ResolveProjectApprovalInput, UpdateProjectAccessInput } from '@workmate/orchestrator';
import { requireAuth } from '../auth/service.js';
import { canReadOwnedResource, canWriteOwnedResource, requireSystemAdmin } from '../auth/ownership.js';
import { resolveEmployeeMcpConnections, resolveTaskContext } from './context-assembler.js';
import { applyParentSecrets } from './secrets.js';

/**
 * Orchestration module (M0): hosts the headless orchestrator inside the API
 * process. Both the Vue renderer and future channel/relay gateways consume
 * these endpoints; the orchestrator owns the durable domain state machines
 * (chat sessions, resumable runs, project scheduling).
 *
 * Domain persistence is a single-writer JSON document under the data dir
 * (`WORKMATE_DATA_DIR`, defaults to `~/.workmate`). Secrets never reach this store.
 */

let instance: Orchestrator | null = null;

function dataDir(): string {
  return process.env.WORKMATE_DATA_DIR || path.join(os.homedir(), '.workmate');
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] || '');
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback;
}

/**
 * Headless smoke mode: `WORKMATE_ORCH_RUNNER=memory-echo|memory-approval` swaps
 * the real agent-core runner for a deterministic scripted one so end-to-end
 * HTTP acceptance tests need no model credentials or network. The production
 * default keeps agent-core as the only model boundary.
 */
function scriptedRunner(): AgentRunner | null {
  const mode = process.env.WORKMATE_ORCH_RUNNER;
  const delayMs = positiveIntFromEnv('WORKMATE_ORCH_RUNNER_DELAY_MS', 0);
  if (mode === 'memory-echo' || mode === 'memory-approval') {
    return createScriptedRunner(mode === 'memory-approval', delayMs > 0 ? { delayMs } : undefined);
  }
  return null;
}

export function getOrchestrator(): Orchestrator {
  if (!instance) {
    const runner = scriptedRunner();
    const store = new JsonFileStore(path.join(dataDir(), 'domain.json'));
    const contextResolver = async (task: ProjectTask): Promise<ChatRunContext | null> => {
      // Remote confirm without client context → assemble from domain KV + keyring.
      try {
        return await resolveTaskContext(store, task);
      } catch {
        return null;
      }
    };
    const chatContextResolver = async (
      employeeId: string,
      ownerUserId?: string | null,
    ): Promise<ChatRunContext | null> => {
      // Desktop/remote chat without client context → assemble for the employee
      // with all their authorized skills and the default permission tier.
      try {
        const task = {
          id: 'chat',
          title: 'chat',
          objective: '',
          employeeId,
          skillIds: [] as string[],
          permissionTier: 'default' as const,
        } as ProjectTask;
        return await resolveTaskContext(store, task, ownerUserId);
      } catch {
        return null;
      }
    };
    instance = new Orchestrator({
      store,
      ...(runner ? { runner } : {}),
      maxConcurrentRunsGlobal: positiveIntFromEnv('WORKMATE_MAX_CONCURRENT_RUNS_GLOBAL', 4),
      maxConcurrentRunsPerUser: positiveIntFromEnv('WORKMATE_MAX_CONCURRENT_RUNS_PER_USER', 2),
      maxQueueWaitMs: positiveIntFromEnv('WORKMATE_MAX_QUEUE_WAIT_MS', 120_000),
      contextResolver,
      chatContextResolver,
      chatMcpConnectionsResolver: async (employeeId, ownerUserId) => {
        try {
          return await resolveEmployeeMcpConnections(store, employeeId, ownerUserId);
        } catch {
          return [];
        }
      },
    });
    // Fire-and-forget: settle runs left `running` by a previous process exit.
    void instance.recoverOnBoot().catch((error) => {
      console.error('[orch] recoverOnBoot failed', error);
    });
  }
  return instance;
}

export async function closeOrchestrator(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

function fail(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(400).send({ message });
}

function topicFilter(query: Record<string, unknown>): string[] {
  const topics: string[] = [];
  const push = (key: string) => {
    const value = query[key];
    if (typeof value === 'string' && value.trim()) topics.push(`${key}:${value.trim()}`);
  };
  push('session');
  push('project');
  push('run');
  return topics;
}

function sseHeaders(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
}

function runtimeStatusSnapshot(orch: Orchestrator) {
  return {
    dispatcher: orch.dispatcherSnapshot(),
    sidecar: getSharedAgentscopeRuntimeStats(),
    ts: Date.now(),
  };
}

export const orchestrationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onClose', async () => {
    await closeOrchestrator();
  });
  const orch = getOrchestrator();

  /* ------------------------------------------------------------------ *
   * Legacy KV proxy — the Electron main process will re-point its
   * `storageGet/storageSet` IPC handlers here so the renderer's existing
   * stores and the orchestrator share one durable domain store.
   * ------------------------------------------------------------------ */

  app.get('/kv', async (request, reply) => {
    const auth = requireAuth(request);
    try {
      requireSystemAdmin(auth);
    } catch (error) {
      return reply.code(403).send({ message: error instanceof Error ? error.message : String(error) });
    }
    const key = request.query && typeof request.query === 'object' ? String((request.query as Record<string, unknown>).key ?? '') : '';
    const prefix = request.query && typeof request.query === 'object' ? String((request.query as Record<string, unknown>).prefix ?? '') : '';
    if (key) return { key, value: await orch.store.get(key) };
    const keys = await orch.store.keys(prefix);
    return { keys, prefix };
  });

  app.put('/kv', async (request, reply) => {
    const auth = requireAuth(request);
    try {
      requireSystemAdmin(auth);
    } catch (error) {
      return reply.code(403).send({ message: error instanceof Error ? error.message : String(error) });
    }
    const body = (request.body ?? {}) as { key?: unknown; value?: unknown };
    const key = String(body.key ?? '');
    if (!key) return fail(reply, new Error('key is required.'));
    const value = body.value == null ? '' : String(body.value);
    await orch.store.set(key, value);
    return { ok: true, key };
  });

  app.delete('/kv', async (request, reply) => {
    const auth = requireAuth(request);
    try {
      requireSystemAdmin(auth);
    } catch (error) {
      return reply.code(403).send({ message: error instanceof Error ? error.message : String(error) });
    }
    const body = (request.body ?? {}) as { key?: unknown };
    const key = String(body.key ?? '');
    if (!key) return fail(reply, new Error('key is required.'));
    await orch.store.delete(key);
    return { ok: true, key };
  });

  /* Desktop keyring push when API is started outside the Electron fork (dev.mjs). */
  app.put('/secrets', async (request, reply) => {
    const auth = requireAuth(request);
    try {
      requireSystemAdmin(auth);
    } catch (error) {
      return reply.code(403).send({ message: error instanceof Error ? error.message : String(error) });
    }
    const body = (request.body ?? {}) as { model?: unknown; search?: unknown };
    applyParentSecrets({ model: body.model, search: body.search });
    return { ok: true };
  });

  /* ------------------------------------------------------------------ *
   * Chat sessions
   * ------------------------------------------------------------------ */

  app.post('/sessions', async (request, reply) => {
    const auth = requireAuth(request);
    const body = (request.body ?? {}) as { title?: string; employeeId?: string; channelBinding?: { channelId: string; threadId: string } | null };
    const session = await orch.chat.createChatSession({
      title: body.title,
      employeeId: body.employeeId,
      channelBinding: body.channelBinding,
      orgId: auth.orgId,
      ownerUserId: auth.userId,
    });
    return { session };
  });

  app.get('/sessions', async (request) => {
    const auth = requireAuth(request);
    const sessions = await orch.chat.listChatSessions();
    return { sessions: sessions.filter((item) => canReadOwnedResource(item, auth, { allowLegacyUnowned: true })) };
  });

  app.get('/sessions/:sessionId', async (request, reply) => {
    const auth = requireAuth(request);
    const session = await orch.chat.getChatSession(String((request.params as Record<string, string>).sessionId));
    if (!session || !canReadOwnedResource(session, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    return { session };
  });

  app.delete('/sessions/:sessionId', async (request, reply) => {
    const auth = requireAuth(request);
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const session = await orch.chat.getChatSession(sessionId);
    if (!session || !canWriteOwnedResource(session, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    await orch.chat.deleteChatSession(sessionId);
    return { ok: true };
  });

  app.post('/sessions/:sessionId/messages', async (request, reply) => {
    const auth = requireAuth(request);
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const session = await orch.chat.getChatSession(sessionId);
    if (!session || !canWriteOwnedResource(session, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    const body = (request.body ?? {}) as { content?: string; employeeId?: string; context?: ChatRunContext };
    if (!body.content) return fail(reply, new Error('content is required.'));
    const result = await orch.chat.sendUserMessage(sessionId, {
      content: body.content,
      employeeId: body.employeeId,
      context: body.context,
    });
    return result;
  });

  app.post('/sessions/:sessionId/cancel', async (request, reply) => {
    const auth = requireAuth(request);
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const session = await orch.chat.getChatSession(sessionId);
    if (!session || !canWriteOwnedResource(session, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    const aborted = await orch.chat.abortActiveRun(sessionId);
    return { aborted };
  });

  /** Flush session rolling memory (switch/idle/close). */
  app.post('/sessions/:sessionId/memory/flush', async (request, reply) => {
    const auth = requireAuth(request);
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const existing = await orch.chat.getChatSession(sessionId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    const session = await orch.chat.flushSessionMemory(sessionId);
    if (!session) return fail(reply, new Error('Chat session not found.'));
    return { session };
  });

  app.get('/sessions/:sessionId/runs', async (request, reply) => {
    const auth = requireAuth(request);
    const session = await orch.chat.getChatSession(String((request.params as Record<string, string>).sessionId));
    if (!session || !canReadOwnedResource(session, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    const runs = [];
    for (const message of session.messages) {
      if (!message.runId) continue;
      const run = await orch.chat.getRun(message.runId);
      if (run) runs.push(run);
    }
    return { runs };
  });

  app.get('/sessions/:sessionId/approvals', async (request, reply) => {
    const auth = requireAuth(request);
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const session = await orch.chat.getChatSession(sessionId);
    if (!session || !canReadOwnedResource(session, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    const pending = await orch.chat.pendingApprovals(sessionId);
    return { pending };
  });

  app.post('/sessions/:sessionId/approvals/:approvalId/resolve', async (request, reply) => {
    const auth = requireAuth(request);
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const session = await orch.chat.getChatSession(sessionId);
    if (!session || !canWriteOwnedResource(session, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    const approvalId = String((request.params as Record<string, string>).approvalId);
    const body = (request.body ?? {}) as { allow?: boolean; scope?: 'session' | 'always'; resumeContext?: ChatRunContext };
    const result = await orch.chat.resolveApproval({
      sessionId,
      approvalId,
      allow: Boolean(body.allow),
      scope: body.scope,
      resumeContext: body.resumeContext,
    });
    return result;
  });

  app.get('/runs/:runId', async (request, reply) => {
    const auth = requireAuth(request);
    const run = await orch.chat.getRun(String((request.params as Record<string, string>).runId));
    if (!run || !canReadOwnedResource(run, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Run not found.'));
    return { run };
  });

  app.get('/usage', async (request) => {
    requireAuth(request);
    const stats = await orch.usageStats();
    return { stats };
  });

  app.get('/runtime/status', async (request) => {
    requireAuth(request);
    return runtimeStatusSnapshot(orch);
  });

  app.get('/runtime/status/stream', async (request, reply) => {
    requireAuth(request);
    reply.hijack();
    sseHeaders(reply);
    const sendSnapshot = () => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`event: runtime-status\n`);
      reply.raw.write(`data: ${JSON.stringify(runtimeStatusSnapshot(orch))}\n\n`);
    };
    sendSnapshot();
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(': ping\n\n');
    }, 15_000);
    const interval = setInterval(sendSnapshot, 3_000);
    const cleanup = () => {
      clearInterval(interval);
      clearInterval(heartbeat);
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    };
    reply.raw.on('close', cleanup);
  });

  /* ------------------------------------------------------------------ *
   * Projects
   * ------------------------------------------------------------------ */

  app.post('/projects', async (request, reply) => {
    const auth = requireAuth(request);
    const input = (request.body ?? {}) as CreateProjectDraftInput;
    if (!input.goal || !Array.isArray(input.tasks)) return fail(reply, new Error('goal and tasks are required.'));
    const project = await orch.projects.createDraft({ ...input, orgId: auth.orgId, ownerUserId: auth.userId });
    return { project };
  });

  app.get('/projects', async (request) => {
    const auth = requireAuth(request);
    const projects = await orch.projects.listProjects();
    return { projects: projects.filter((item) => canReadOwnedResource(item, auth, { allowLegacyUnowned: true })) };
  });

  app.get('/projects/:projectId', async (request, reply) => {
    const auth = requireAuth(request);
    const project = await orch.projects.getProject(String((request.params as Record<string, string>).projectId));
    if (!project || !canReadOwnedResource(project, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    return { project };
  });

  app.patch('/projects/:projectId', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const body = (request.body ?? {}) as Record<string, unknown>;
    const project = await orch.projects.updateDraft(projectId, {
      name: body.name as string | undefined,
      goal: body.goal as string | undefined,
      mode: body.mode as CreateProjectDraftInput['mode'] | undefined,
      workspacePath: body.workspacePath as string | undefined,
      tasks: body.tasks as CreateProjectDraftInput['tasks'] | undefined,
    });
    if (!project) return fail(reply, new Error('Project not found.'));
    return { project };
  });

  app.patch('/projects/:projectId/access', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const body = (request.body ?? {}) as Record<string, unknown>;
    const scope = body.accessScope;
    const rawGrants = Array.isArray(body.accessGrants) ? body.accessGrants : [];
    const project = await orch.projects.updateAccess(projectId, {
      accessScope: scope === 'private' || scope === 'org-shared' || scope === 'delegated' ? scope : undefined,
      accessGrants: rawGrants.map((grant) => ({
        subjectType: grant && typeof grant === 'object' && (grant as { subjectType?: unknown }).subjectType === 'user' ? 'user' : 'user',
        subjectId: String((grant as { subjectId?: unknown })?.subjectId || ''),
        permissions: Array.isArray((grant as { permissions?: unknown[] })?.permissions)
          ? (grant as { permissions: unknown[] }).permissions.filter((item): item is 'read' | 'write' => item === 'read' || item === 'write')
          : [],
        createdAt: Number((grant as { createdAt?: unknown })?.createdAt || Date.now()),
        expiresAt: (grant as { expiresAt?: unknown })?.expiresAt ? Number((grant as { expiresAt?: unknown }).expiresAt) : undefined,
      })),
    } satisfies UpdateProjectAccessInput);
    if (!project) return fail(reply, new Error('Project not found.'));
    return { project };
  });

  app.delete('/projects/:projectId', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    await orch.projects.removeProject(projectId);
    return { ok: true };
  });

  app.post('/projects/:projectId/confirm', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const body = (request.body ?? {}) as ConfirmProjectInput;
    const result = await orch.projects.confirmProject(projectId, {
      runContextByTask: body.runContextByTask,
      defaultContext: body.defaultContext,
      summaryContext: body.summaryContext,
    });
    if (!result) return fail(reply, new Error('Project not found.'));
    return result;
  });

  /** Coordinator replan after roster changes (add/remove members). */
  app.post('/projects/:projectId/replan', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const body = (request.body ?? {}) as { tasks?: CreateProjectDraftInput['tasks']; note?: string };
    if (!Array.isArray(body.tasks) || !body.tasks.length) {
      return fail(reply, new Error('tasks are required.'));
    }
    try {
      const project = await orch.projects.replanProject(projectId, {
        tasks: body.tasks,
        note: body.note,
      });
      if (!project) return fail(reply, new Error('Project not found.'));
      return { project };
    } catch (error) {
      return fail(reply, error instanceof Error ? error : new Error('Replan failed.'));
    }
  });

  /** Follow-up instruction → scheduler (target task + downstream deps). */
  app.post('/projects/:projectId/instructions', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const body = (request.body ?? {}) as {
      employeeId?: string;
      content?: string;
      employeeLabel?: string;
    } & ConfirmProjectInput;
    if (!body.employeeId || !body.content?.trim()) {
      return fail(reply, new Error('employeeId and content are required.'));
    }
    try {
      const result = await orch.projects.dispatchInstruction(
        projectId,
        {
          employeeId: body.employeeId,
          content: body.content,
          employeeLabel: body.employeeLabel,
        },
        {
          runContextByTask: body.runContextByTask,
          defaultContext: body.defaultContext,
          summaryContext: body.summaryContext,
        },
      );
      if (!result) return fail(reply, new Error('Project not found.'));
      return result;
    } catch (error) {
      return fail(reply, error instanceof Error ? error : new Error('Dispatch failed.'));
    }
  });

  app.post('/projects/:projectId/cancel', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const cancelled = await orch.projects.cancelActiveRun(projectId);
    return { cancelled };
  });

  app.post('/projects/:projectId/tasks/:taskId/retry', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const taskId = String((request.params as Record<string, string>).taskId);
    const body = (request.body ?? {}) as { context?: ChatRunContext };
    if (!body.context) return fail(reply, new Error('context is required.'));
    const started = await orch.projects.retryTask(projectId, taskId, body.context);
    return { started };
  });

  app.get('/projects/:projectId/tasks/:taskId/transcript', async (request, reply) => {
    const auth = requireAuth(request);
    const project = await orch.projects.getProject(String((request.params as Record<string, string>).projectId));
    if (!project || !canReadOwnedResource(project, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const task = project.tasks.find((item) => item.id === String((request.params as Record<string, string>).taskId));
    if (!task) return fail(reply, new Error('Task not found.'));
    const transcript = await orch.projects.taskTranscript(task);
    return { transcript };
  });

  app.post('/projects/:projectId/tasks/:taskId/approvals/:approvalId/resolve', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const existing = await orch.projects.getProject(projectId);
    if (!existing || !canWriteOwnedResource(existing, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const taskId = String((request.params as Record<string, string>).taskId);
    const approvalId = String((request.params as Record<string, string>).approvalId);
    const body = (request.body ?? {}) as Pick<ResolveProjectApprovalInput, 'allow' | 'scope' | 'resumeContext'>;
    const result = await orch.projects.resolveProjectApproval({
      projectId,
      taskId,
      approvalId,
      allow: Boolean(body.allow),
      scope: body.scope,
      resumeContext: body.resumeContext,
    });
    return result;
  });

  app.get('/projects/:projectId/runs', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = String((request.params as Record<string, string>).projectId);
    const project = await orch.projects.getProject(projectId);
    if (!project || !canReadOwnedResource(project, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    const runs = await orch.projects.listProjectRuns(projectId);
    return { runs };
  });

  /* ------------------------------------------------------------------ *
   * Event stream (SSE) — subscribe by ?session=&project=&run=
   * ------------------------------------------------------------------ */

  app.get('/events', async (request, reply) => {
    const auth = requireAuth(request);
    const topics = topicFilter(request.query as Record<string, unknown>);
    if (topics.length === 0) {
      return fail(reply, new Error('Provide at least one of ?session=, ?project= or ?run=.'));
    }
    if (topics.some((topic) => topic.startsWith('session:'))) {
      const sessionId = topics.find((topic) => topic.startsWith('session:'))?.slice('session:'.length) || '';
      const session = sessionId ? await orch.chat.getChatSession(sessionId) : null;
      if (!session || !canReadOwnedResource(session, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Chat session not found.'));
    }
    if (topics.some((topic) => topic.startsWith('project:'))) {
      const projectId = topics.find((topic) => topic.startsWith('project:'))?.slice('project:'.length) || '';
      const project = projectId ? await orch.projects.getProject(projectId) : null;
      if (!project || !canReadOwnedResource(project, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Project not found.'));
    }
    if (topics.some((topic) => topic.startsWith('run:'))) {
      const runId = topics.find((topic) => topic.startsWith('run:'))?.slice('run:'.length) || '';
      const run = runId ? await orch.chat.getRun(runId) : null;
      if (!run || !canReadOwnedResource(run, auth, { allowLegacyUnowned: true })) return fail(reply, new Error('Run not found.'));
    }
    reply.hijack();
    sseHeaders(reply);
    const unsubscribers: Array<() => void> = [];
    const send = (event: OrcEvent) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify({ ...event, ts: Date.now() })}\n\n`);
    };
    for (const topic of topics) {
      unsubscribers.push(orch.subscribe(topic, send));
    }
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(': ping\n\n');
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    };
    reply.raw.on('close', cleanup);
  });
};
