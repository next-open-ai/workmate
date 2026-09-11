import { randomUUID } from 'node:crypto';
import { cleanupConversationSessionWorkspaces } from '@workmate/agent-core';
import type { ChatRequest, ModelConfig } from '@workmate/contracts';
import type { EventHub, HubListener } from './hub.js';
import { deleteKey, listJsonIds, readJson, writeJson } from './repo.js';
import type { OrcEvent } from './run-engine.js';
import { RunEngine } from './run-engine.js';
import {
  buildSessionModelMessages,
  estimateSessionMemoryChars,
  rollSessionMemory,
  shouldRollSessionMemory,
  uncoveredMessages,
} from './session-memory.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import type { ChatMessage, ChatSession, GrantCapability, RunRecord } from './types.js';

export const SESSION_KEY_PREFIX = 'sessions:';
const SESSION_NS = 'sessions';
const RUN_NS = 'run';

/**
 * A full run request minus its message history. The caller (desktop UI or a
 * gateway) supplies resolved runtime context (employee profile, model, skill
 * runtime payloads, providers). Secrets never cross the persistence boundary.
 */
export type ChatRunContext = Omit<ChatRequest, 'messages'>;

export interface ChatSessionServiceOptions {
  store: KeyValueStore;
  hub: EventHub<OrcEvent>;
  engine: RunEngine;
  /**
   * Server-side run-context assembly fallback for chat messages / approval
   * resumes when the caller sends no `context` (remote gateway, desktop in
   * server-backed mode). Resolves for the session's employee; null → the
   * caller sees a clear "model not configured" style error.
   */
  contextResolver?: (
    employeeId: string,
    ownerUserId?: string | null,
  ) => ChatRunContext | null | Promise<ChatRunContext | null>;
  /**
   * MCP-only backfill when the client sends a context with empty
   * `mcpConnections` (common when model comes from the client but MCP prefs
   * were not loaded yet, or full contextResolver returns null without a model).
   */
  mcpConnectionsResolver?: (
    employeeId: string,
    ownerUserId?: string | null,
  ) => ChatRunContext['mcpConnections'] | Promise<ChatRunContext['mcpConnections']>;
}

export interface SendUserMessageInput {
  content: string;
  /** Resolved runtime context; when omitted the service uses its resolver. */
  context?: ChatRunContext;
  /** Override the session employee recorded with the message. */
  employeeId?: string;
}

export interface ResolveApprovalInput {
  sessionId: string;
  approvalId: string;
  allow: boolean;
  scope?: 'session' | 'always';
  /** Required to resume a waiting-approval run (fresh resolved runtime). */
  resumeContext?: ChatRunContext;
}

const FALLBACK_EMPTY_REPLY = '（本轮未返回文本。可重试，或检查模型 / MCP 是否正常。）';

function normalizeSessionOwnership(session: ChatSession): ChatSession {
  const ownerUserId = session.ownerUserId ?? session.userId;
  if (ownerUserId) {
    session.ownerUserId = ownerUserId;
    session.userId = session.userId ?? ownerUserId;
  }
  session.accessScope = session.accessScope ?? 'private';
  session.accessGrants = Array.isArray(session.accessGrants) ? session.accessGrants : [];
  return session;
}

export class ChatSessionService {
  private readonly store: KeyValueStore;
  private readonly hub: EventHub<OrcEvent>;
  private readonly engine: RunEngine;
  private readonly contextResolver?: ChatSessionServiceOptions['contextResolver'];
  private readonly mcpConnectionsResolver?: ChatSessionServiceOptions['mcpConnectionsResolver'];
  /** Active run aborts per session (one run at a time, mirroring the UI). */
  private readonly activeAborts = new Map<string, AbortController>();
  private readonly runAttempts = new Map<string, number>();

  constructor(options: ChatSessionServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.engine = options.engine;
    this.contextResolver = options.contextResolver;
    this.mcpConnectionsResolver = options.mcpConnectionsResolver;
  }

  /** Resolve a run context for an employee (caller payload first, else resolver). */
  private async resolveContextFor(
    employeeId: string,
    explicit?: ChatRunContext,
    ownerUserId?: string | null,
  ): Promise<ChatRunContext | null> {
    let resolved: ChatRunContext | null = explicit ?? null;
    if (!resolved && this.contextResolver) {
      try {
        resolved = (await this.contextResolver(employeeId, ownerUserId)) ?? null;
      } catch {
        resolved = null;
      }
    }
    if (!resolved) return null;
    if (!resolved.mcpConnections?.length) {
      let mcp: ChatRunContext['mcpConnections'] = [];
      if (this.mcpConnectionsResolver) {
        try {
          mcp = (await this.mcpConnectionsResolver(employeeId, ownerUserId)) ?? [];
        } catch {
          mcp = [];
        }
      }
      if (!mcp.length && this.contextResolver) {
        try {
          const fallback = (await this.contextResolver(employeeId, ownerUserId)) ?? null;
          mcp = fallback?.mcpConnections ?? [];
        } catch {
          mcp = [];
        }
      }
      if (mcp.length) resolved = { ...resolved, mcpConnections: mcp };
    }
    // Client may omit engine after a prefs load race; backfill from server resolver.
    if (!resolved.engine && this.contextResolver) {
      try {
        const fallback = (await this.contextResolver(employeeId, ownerUserId)) ?? null;
        if (fallback?.engine) resolved = { ...resolved, engine: fallback.engine };
      } catch {
        // ignore
      }
    }
    return resolved;
  }

  private sessionKey(id: string): string {
    return namespaceKey(SESSION_NS, id);
  }

  /* ------------------------------------------------------------------ *
   * Session CRUD
   * ------------------------------------------------------------------ */

  async createChatSession(
    input: {
      title?: string;
      employeeId?: string;
      channelBinding?: ChatSession['channelBinding'];
      orgId?: string;
      ownerUserId?: string;
      userId?: string;
      accessScope?: ChatSession['accessScope'];
      accessGrants?: ChatSession['accessGrants'];
    } = {},
  ): Promise<ChatSession> {
    const now = Date.now();
    const ownerUserId = input.ownerUserId ?? input.userId;
    const session: ChatSession = {
      id: randomUUID(),
      kind: 'chat',
      orgId: input.orgId,
      ownerUserId,
      userId: ownerUserId,
      accessScope: input.accessScope ?? 'private',
      accessGrants: [...(input.accessGrants ?? [])],
      title: input.title?.trim() ? input.title.trim().slice(0, 80) : '新对话',
      employeeId: input.employeeId ?? 'general',
      messages: [],
      grantsSession: {},
      grantsAlways: {},
      channelBinding: input.channelBinding ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveSession(session);
    return session;
  }

  async getChatSession(id: string): Promise<ChatSession | null> {
    const session = await readJson<ChatSession>(this.store, this.sessionKey(id));
    return session ? normalizeSessionOwnership(session) : null;
  }

  async listChatSessions(): Promise<ChatSession[]> {
    const ids = await listJsonIds(this.store, SESSION_KEY_PREFIX);
    const sessions: ChatSession[] = [];
    for (const id of ids) {
      const session = await this.getChatSession(id);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteChatSession(id: string): Promise<void> {
    const session = await this.getChatSession(id);
    if (!session) return;
    const runIds = [
      ...new Set(
        session.messages
          .map((message) => String(message.runId || '').trim())
          .filter(Boolean),
      ),
    ];
    await deleteKey(this.store, this.sessionKey(id));
    for (const message of session.messages) {
      if (message.runId) await deleteKey(this.store, namespaceKey(RUN_NS, message.runId));
    }
    // Best-effort: remove conversation staging (Agent temp scripts / .python-packages).
    await cleanupConversationSessionWorkspaces(runIds).catch(() => undefined);
    this.hub.publish(`session:${id}`, { type: 'session.deleted', sessionId: id });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.engine.load(runId);
  }

  /** Canonical conversation view (superseded attempts of a turn are hidden). */
  messagesOf(session: ChatSession): ChatMessage[] {
    return session.messages.filter((message) => !message.superseded);
  }

  /* ------------------------------------------------------------------ *
   * Messaging / runs
   * ------------------------------------------------------------------ */

  /**
   * Append a user message and execute a run for it. Any active run in the
   * same session is aborted first (same semantics as the desktop chat).
   */
  async sendUserMessage(sessionId: string, input: SendUserMessageInput): Promise<{ runId: string; turnId: string; attemptNo: number }> {
    const session = await this.getChatSession(sessionId);
    if (!session) throw new Error('Chat session not found.');

    const text = input.content.trim();
    if (!text) throw new Error('Message content is empty.');

    const previous = this.activeAborts.get(sessionId);
    if (previous && !previous.signal.aborted) previous.abort();
    const abort = new AbortController();
    this.activeAborts.set(sessionId, abort);

    const turnId = randomUUID();
    const runId = randomUUID();
    const now = Date.now();
    const userMessage: ChatMessage = { id: randomUUID(), role: 'user', content: text, createdAt: now, turnId };
    const assistantMessage: ChatMessage = { id: randomUUID(), role: 'assistant', content: '', createdAt: now, turnId, runId };
    const attemptNo = 1;

    session.employeeId = input.employeeId ?? session.employeeId;
    const employeeId = input.employeeId ?? session.employeeId;
    const ownerUserId = session.ownerUserId ?? session.userId ?? null;
    const runContext = await this.resolveContextFor(employeeId, input.context, ownerUserId);
    if (!runContext) {
      throw new Error('缺少运行上下文（模型/Skill 配置）。请先在桌面端配置模型。');
    }
    session.messages.push(userMessage, assistantMessage);
    if (session.title === '新对话') session.title = text.slice(0, 28);
    await this.saveSession(session);

    const request = this.requestForTurn(session, runContext, turnId);
    void this.settleRun(session.id, runId, turnId, attemptNo, { ...request, runId }, assistantMessage.id, abort.signal);
    return { runId, turnId, attemptNo };
  }

  async abortActiveRun(sessionId: string): Promise<boolean> {
    const abort = this.activeAborts.get(sessionId);
    if (!abort || abort.signal.aborted) return false;
    abort.abort();
    return true;
  }

  /**
   * Build a ChatRequest for a turn: context + session rolling memory + recent
   * uncovered history (or full history when no summary exists yet).
   */
  private requestForTurn(session: ChatSession, context: ChatRunContext, turnId: string): ChatRequest {
    const history = buildSessionModelMessages(session, { turnId });
    return { ...context, conversationId: session.id, messages: history };
  }

  private async settleRun(sessionId: string, runId: string, turnId: string, attemptNo: number, request: ChatRequest, assistantMessageId: string, signal: AbortSignal) {
    const ownerSession = await this.getChatSession(sessionId);
    try {
      const run = await this.engine.execute({
        runId,
        sessionId,
        kind: 'chat',
        turnId,
        attemptNo,
        request,
        signal,
        orgId: ownerSession?.orgId,
        ownerUserId: ownerSession?.ownerUserId ?? ownerSession?.userId,
        accessScope: ownerSession?.accessScope,
        accessGrants: ownerSession?.accessGrants,
      });
      const session = await this.getChatSession(sessionId);
      if (!session) return;
      const message = session.messages.find((item) => item.id === assistantMessageId);
      if (message) {
        // Supersede older assistant attempts of the same turn.
        for (const other of session.messages) {
          if (other.role === 'assistant' && other.turnId === turnId && other.id !== message.id && !other.superseded) other.superseded = true;
        }
        const text = run.transcript.trim();
        if (text) message.content = text;
        else if (run.status === 'cancelled') message.content = `⏹ ${run.error ?? '已中止当前执行。'}`;
        else if (run.status === 'failed') message.content = `⚠ ${run.error ?? 'Model request failed.'}`;
        else if (run.status !== 'waiting-approval') message.content = FALLBACK_EMPTY_REPLY;
        message.runId = run.id;
      }
      session.updatedAt = Date.now();
      if (run.status !== 'waiting-approval') {
        await this.refreshSessionMemory(session, request.model, { force: false });
      } else if (session.memory) {
        session.memory = { ...session.memory, dirty: true };
      } else {
        session.memory = { summary: '', coveredUntilId: '', updatedAt: Date.now(), dirty: true };
      }
      await this.saveSession(session);
    } finally {
      if (this.activeAborts.get(sessionId)?.signal === signal) this.activeAborts.delete(sessionId);
    }
  }

  /**
   * Roll session memory when over budget (or forced on flush). Marks dirty
   * when uncovered turns remain. Never truncates the transcript.
   */
  private async refreshSessionMemory(session: ChatSession, model: ModelConfig, options: { force: boolean }) {
    try {
      const { memory } = await rollSessionMemory({ session, model, force: options.force });
      session.memory = memory;
      if (!options.force) session.memory.dirty = true;
    } catch {
      if (session.memory) session.memory = { ...session.memory, dirty: true };
      else session.memory = { summary: '', coveredUntilId: '', updatedAt: Date.now(), dirty: true };
    }
  }

  /**
   * Flush rolling memory for a session (switch/idle/close). Rolls when over
   * budget or when force-folding excess beyond the recent window; clears dirty
   * when maintenance completes (or when there is nothing to fold).
   */
  async flushSessionMemory(sessionId: string, model?: ModelConfig): Promise<ChatSession | null> {
    const session = await this.getChatSession(sessionId);
    if (!session) return null;
    const summary = session.memory?.summary || '';
    const uncovered = uncoveredMessages(session.messages, session.memory?.coveredUntilId);
    const needsWork = Boolean(session.memory?.dirty)
      || shouldRollSessionMemory({ summary, uncovered, force: true })
      || estimateSessionMemoryChars(summary, uncovered) >= 24_000;
    if (!needsWork) return session;

    const runContext = await this.resolveContextFor(
      session.employeeId,
      undefined,
      session.ownerUserId ?? session.userId ?? null,
    );
    const resolvedModel = model ?? runContext?.model;
    if (!resolvedModel) {
      await this.saveSession(session);
      return session;
    }
    await this.refreshSessionMemory(session, resolvedModel, { force: true });
    if (session.memory) session.memory.dirty = false;
    await this.saveSession(session);
    return session;
  }

  /* ------------------------------------------------------------------ *
   * Approvals (resumable-run semantics)
   * ------------------------------------------------------------------ */

  /** Runs of this session that are parked waiting for approval. */
  async pendingApprovals(sessionId: string): Promise<RunRecord[]> {
    const session = await this.getChatSession(sessionId);
    if (!session) return [];
    const runs: RunRecord[] = [];
    for (const message of session.messages) {
      if (!message.runId) continue;
      const run = await this.engine.load(message.runId);
      if (run && run.status === 'waiting-approval' && run.approvals.some((approval) => approval.status === 'pending') && !runs.some((item) => item.id === run.id)) {
        runs.push(run);
      }
    }
    return runs;
  }

  /**
   * Decide a pending approval. When allowed with `resumeContext`, the same
   * turn is re-run as a fresh attempt with the grant applied — the durable
   * equivalent of the desktop UI's approve-and-retry.
   */
  async resolveApproval(input: ResolveApprovalInput): Promise<{ run: RunRecord | null; resumedRunId?: string; turnId?: string }> {
    const session = await this.getChatSession(input.sessionId);
    if (!session) throw new Error('Chat session not found.');

    const waiting = await this.findWaitingRun(session, input.approvalId);
    if (!waiting) throw new Error('Approval is not pending.');

    const approval = waiting.approvals.find((item) => item.id === input.approvalId);
    await this.engine.decideApproval(waiting.id, input.approvalId, { allow: input.allow, scope: input.scope });
    if (input.allow && approval) this.applyGrant(session, approval.skillId, approval.capability, input.scope ?? 'session');

    // Allowed but no explicit resume payload: fall back to the server-side
    // context resolver so a remote/desktop client can approve with no secrets.
    const resumeContext = input.resumeContext ?? (await this.resolveContextFor(
      session.employeeId,
      undefined,
      session.ownerUserId ?? session.userId ?? null,
    ));
    if (!input.allow || !resumeContext) {
      await this.saveSession(session);
      return { run: waiting };
    }

    const turnId = waiting.turnId;
    if (!turnId) {
      await this.saveSession(session);
      return { run: waiting };
    }
    const userMessage = this.messagesOf(session)
      .filter((message) => message.role === 'user' && message.turnId === turnId)
      .at(-1);
    if (!userMessage) {
      await this.saveSession(session);
      return { run: waiting };
    }

    const previous = this.activeAborts.get(session.id);
    if (previous && !previous.signal.aborted) previous.abort();
    const abort = new AbortController();
    this.activeAborts.set(session.id, abort);

    const attemptNo = waiting.attemptNo + 1;
    const resumedRunId = randomUUID();
    const assistantId = this.assistantForTurn(session, turnId, resumedRunId);
    const request = this.requestForTurn(session, resumeContext, turnId);
    void this.settleRun(session.id, resumedRunId, turnId, attemptNo, { ...request, runId: resumedRunId }, assistantId, abort.signal);
    await this.saveSession(session);
    return { run: waiting, resumedRunId, turnId };
  }

  /** Record a grant on the session (session-scoped or always-scoped). */
  private applyGrant(session: ChatSession, skillId: string, capability: GrantCapability, scope: 'session' | 'always') {
    const target = scope === 'always' ? session.grantsAlways : session.grantsSession;
    const list = target[skillId] ?? [];
    if (!list.includes(capability)) list.push(capability);
    target[skillId] = list;
  }

  private async findWaitingRun(session: ChatSession, approvalId: string): Promise<RunRecord | null> {
    for (const message of session.messages) {
      if (!message.runId) continue;
      const run = await this.engine.load(message.runId);
      if (run && run.approvals.some((approval) => approval.id === approvalId && approval.status === 'pending')) return run;
    }
    return null;
  }

  /** Reuse the turn's assistant placeholder for the resumed attempt. */
  private assistantForTurn(session: ChatSession, turnId: string, runId: string): string {
    const existing = session.messages.find((message) => message.role === 'assistant' && message.turnId === turnId && !message.superseded);
    if (existing) {
      existing.runId = runId;
      existing.content = '';
      return existing.id;
    }
    const id = randomUUID();
    session.messages.push({ id, role: 'assistant', content: '', createdAt: Date.now(), turnId, runId });
    return id;
  }

  private async saveSession(session: ChatSession): Promise<void> {
    normalizeSessionOwnership(session);
    session.updatedAt = Date.now();
    await writeJson(this.store, this.sessionKey(session.id), session);
    this.hub.publish(`session:${session.id}`, { type: 'session.updated', sessionId: session.id });
  }

  /** Watch every orchestration event published on a session's topic. */
  subscribe(sessionId: string, listener: HubListener<OrcEvent>): () => void {
    return this.hub.subscribe(`session:${sessionId}`, listener);
  }
}

/** Run records kept reachable from the session for engine bookkeeping. */
export { RUN_NS };
