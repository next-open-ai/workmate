import { randomUUID } from 'node:crypto';
import type { AgentEvent, ChatRequest } from '@workmate/contracts';
import type { OrcEvent } from './events.js';
import type { EventHub } from './hub.js';
import { readJson, writeJson } from './repo.js';
import type { ExecutionDispatcher } from './execution-dispatcher.js';
import type { AgentRunner } from './runner.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import type { AccessGrant, AccessScope, GrantCapability, RunActivity, RunApproval, RunRecord, RunStatus } from './types.js';
import { applyUsageEvent, modelInfoFromRequest } from './usage.js';

export type { OrcEvent };

export interface ExecuteAttemptOptions {
  runId?: string;
  sessionId: string;
  orgId?: string;
  ownerUserId?: string;
  userId?: string;
  accessScope?: AccessScope;
  accessGrants?: AccessGrant[];
  kind: 'chat' | 'project-task';
  taskId?: string;
  turnId?: string;
  attemptNo?: number;
  request: ChatRequest;
  /** Abort this attempt (user cancel / timeout). */
  signal?: AbortSignal;
  /** Extra hub topics to publish structural events onto (e.g. project:<id>). */
  extraTopics?: string[];
}

export const RUN_NS = 'run';

function isDeltaLike(event: AgentEvent): boolean {
  return event.type === 'message.delta';
}

/**
 * Executes one agent attempt and records a durable RunRecord.
 *
 * Resumable-run semantics (M0):
 * - A tool that needs approval yields `tool.approval_required`. The engine
 *   keeps collecting events until the model turn settles, then marks the run
 *   `waiting-approval` instead of `completed`.
 * - The caller resolves approvals and starts a *new attempt* of the same turn
 *   with the granted capabilities merged into the request (see chat-session /
 *   project service). Deltas are streamed live over the hub and only final
 *   state is persisted, so approvals/artifacts/activities survive restarts.
 */
export class RunEngine {
  constructor(
    readonly store: KeyValueStore,
    private readonly runner: AgentRunner,
    private readonly hub: EventHub<OrcEvent>,
    private readonly dispatcher: ExecutionDispatcher,
    private readonly runTimeoutMs = 600_000,
  ) {}

  private runKey(runId: string): string {
    return namespaceKey(RUN_NS, runId);
  }

  async load(runId: string): Promise<RunRecord | null> {
    return readJson<RunRecord>(this.store, this.runKey(runId));
  }

  async save(run: RunRecord): Promise<void> {
    await writeJson(this.store, this.runKey(run.id), run);
  }

  /** All persisted run records (for usage aggregation). */
  async listRuns(): Promise<RunRecord[]> {
    const keys = await this.store.keys(`${RUN_NS}:`);
    const runs: RunRecord[] = [];
    for (const key of keys) {
      const run = await readJson<RunRecord>(this.store, key);
      if (run) runs.push(run);
    }
    return runs;
  }

  /** Record an approval decision on a run (called by chat/project services). */
  async decideApproval(runId: string, approvalId: string, decision: { allow: boolean; scope?: 'session' | 'always' }): Promise<RunRecord | null> {
    const run = await this.load(runId);
    if (!run) return null;
    const approval = run.approvals.find((item) => item.id === approvalId);
    if (!approval || approval.status !== 'pending') return run;
    approval.status = decision.allow ? 'allowed' : 'denied';
    approval.scope = decision.allow ? decision.scope ?? 'session' : undefined;
    approval.resolvedAt = Date.now();
    await this.save(run);
    this.hub.publish(`run:${runId}`, { type: 'run.approval', runId, approval: { ...approval } });
    return run;
  }

  /**
   * Start an attempt and drive it to completion. Resolves once the run
   * settles. Persisted status transitions happen here; message deltas are
   * only streamed.
   */
  async execute(options: ExecuteAttemptOptions): Promise<RunRecord> {
    const runId = options.runId ?? randomUUID();
    const attemptNo = options.attemptNo ?? 1;
    const now = Date.now();
    const run: RunRecord = {
      id: runId,
      orgId: options.orgId,
      ownerUserId: options.ownerUserId ?? options.userId,
      userId: options.userId ?? options.ownerUserId,
      accessScope: options.accessScope ?? 'private',
      accessGrants: [...(options.accessGrants ?? [])],
      sessionId: options.sessionId,
      kind: options.kind,
      taskId: options.taskId,
      turnId: options.turnId,
      attemptNo,
      status: 'running',
      startedAt: now,
      transcript: '',
      activities: [],
      approvals: [],
      artifacts: [],
      sources: [],
      eventLog: [],
      model: modelInfoFromRequest(options.request.model),
    };

    const topic = `run:${runId}`;
    const sessionTopic = `session:${options.sessionId}`;
    const topics = [...new Set([topic, sessionTopic, ...(options.extraTopics ?? [])])];
    const publish = (event: OrcEvent) => {
      for (const item of topics) this.hub.publish(item, event);
    };

    // Persist a 'running' record BEFORE the attempt starts. Consumers
    // (RunEngine.load / runStatusOf / waitRunningSettle / isParked and the
    // renderer's settle waiters) treat a missing run record as "settled", so
    // without this the scheduler would see the run as finished while it is
    // still executing and never advance to the next task.
    await this.save(run);
    publish({ type: 'run.started', runId, sessionId: options.sessionId, kind: options.kind, taskId: options.taskId, attemptNo });

    const emit = (event: AgentEvent) => {
      if (event.type === 'message.delta' && event.text) {
        run.transcript += event.text;
        publish({ type: 'run.delta', runId, sessionId: options.sessionId, text: event.text });
        scheduleCheckpoint();
        return;
      }
      run.eventLog.push(event);
      if (run.eventLog.length > 500) run.eventLog.splice(0, run.eventLog.length - 500);
      switch (event.type) {
        case 'run.started': {
          if (event.engine) {
            run.engine = event.engine;
            publish({
              type: 'run.engine',
              runId,
              sessionId: options.sessionId,
              engine: event.engine,
            });
          }
          scheduleCheckpoint();
          break;
        }
        case 'tool.started': {
          const activity: RunActivity = { toolName: event.toolName, summary: event.summary, status: 'running', at: Date.now() };
          run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity });
          scheduleCheckpoint();
          break;
        }
        case 'tool.completed': {
          const existing = [...run.activities].reverse().find(
            (item) => item.toolName === event.toolName && item.status === 'running',
          );
          // Keep the started summary (often includes args); only flip status.
          const activity: RunActivity = existing
            ? Object.assign(existing, {
                status: event.ok ? 'completed' : 'failed',
                at: Date.now(),
              })
            : {
                toolName: event.toolName,
                summary: event.summary,
                status: event.ok ? 'completed' : 'failed',
                at: Date.now(),
              };
          if (!existing) run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity: { ...activity } });
          scheduleCheckpoint();
          break;
        }
        case 'tool.failed': {
          const existing = [...run.activities].reverse().find(
            (item) => item.toolName === event.toolName && item.status === 'running',
          );
          const activity: RunActivity = existing
            ? Object.assign(existing, {
                status: 'failed',
                summary: event.summary && !existing.summary.includes(event.summary)
                  ? `${existing.summary} — ${event.summary}`
                  : (existing.summary || event.summary),
                at: Date.now(),
              })
            : {
                toolName: event.toolName,
                summary: event.summary,
                status: 'failed',
                at: Date.now(),
              };
          if (!existing) run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity: { ...activity } });
          scheduleCheckpoint();
          break;
        }
        case 'tool.approval_required': {
          const approval: RunApproval = {
            id: randomUUID(),
            skillId: event.skillId,
            capability: event.capability as GrantCapability,
            summary: event.summary,
            status: 'pending',
            at: Date.now(),
          };
          run.approvals.push(approval);
          publish({ type: 'run.approval', runId, approval });
          // Approvals must survive a process restart so the UI can resume.
          void this.save(run);
          break;
        }
        case 'artifact.created': {
          const artifact = { path: event.path };
          if (run.artifacts.some((item) => item.path === artifact.path)) {
            scheduleCheckpoint();
            break;
          }
          run.artifacts.push(artifact);
          publish({ type: 'run.artifact', runId, artifact });
          scheduleCheckpoint();
          break;
        }
        case 'project.file.published': {
          const artifact = { path: event.projectPath };
          const isNewArtifact = !run.artifacts.some((item) => item.path === artifact.path);
          if (isNewArtifact) run.artifacts.push(artifact);
          publish({
            type: 'project.file.published',
            runId,
            path: event.path,
            projectPath: event.projectPath,
            projectId: options.kind === 'project-task' ? options.sessionId : undefined,
          });
          // Do not re-broadcast run.artifact when the same path was already archived mid-run.
          if (isNewArtifact) publish({ type: 'run.artifact', runId, artifact });
          scheduleCheckpoint();
          break;
        }
        case 'search.sources': {
          run.sources = event.sources.map((source) => ({ ...source }));
          publish({ type: 'run.sources', runId, sources: run.sources });
          scheduleCheckpoint();
          break;
        }
        case 'run.usage': {
          applyUsageEvent(run, event.usage, event.model);
          publish({
            type: 'run.usage',
            runId,
            sessionId: options.sessionId,
            usage: run.usage!,
            model: run.model,
          });
          scheduleCheckpoint();
          break;
        }
        default:
          scheduleCheckpoint();
          break;
      }
    };

    // Persist mid-run progress so a desktop/API restart does not leave an empty
    // "running" record with no activities (workspace files may already exist).
    let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
    let checkpointDirty = false;
    const flushCheckpoint = () => {
      checkpointTimer = undefined;
      if (!checkpointDirty || run.status !== 'running') return;
      checkpointDirty = false;
      void this.save(run);
    };
    const scheduleCheckpoint = () => {
      checkpointDirty = true;
      if (checkpointTimer) return;
      checkpointTimer = setTimeout(flushCheckpoint, 1_500);
    };

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutId = setTimeout(() => abortController.abort(new Error(`Run timed out after ${Math.round(this.runTimeoutMs / 1000)}s`)), this.runTimeoutMs);

    try {
      await this.dispatcher.dispatch({
        runId,
        orgId: options.orgId,
        userId: options.ownerUserId ?? options.userId,
        sessionId: options.sessionId,
        kind: options.kind,
        priority: options.kind === 'chat' ? 'high' : 'normal',
        signal: abortController.signal,
        execute: () => this.runner.start(options.request, emit, { abortSignal: abortController.signal }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model request failed.';
      const friendly = /connection\s*error|failed to fetch|fetch failed|terminated|econnreset|econnrefused|enotfound|eai_again|broken pipe|network|ssl|tls|timed?\s*out|timeout|stream idle|remote end closed|temporarily unavailable|socket hang up|ECONNABORTED|UND_ERR/i.test(message)
        ? '网络连接超时或中断了，这次没能完成回答。请检查网络后重试；若正在使用 VPN，也可先切换网络再试。'
        : message;
      if (!abortController.signal.aborted) {
        run.status = 'failed';
        run.error = friendly;
      }
    } finally {
      clearTimeout(timeoutId);
      if (checkpointTimer) clearTimeout(checkpointTimer);
      checkpointDirty = false;
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    // Agent-core already emits run.completed / run.failed / run.cancelled as
    // events; map terminal state from the event log when needed.
    const lastTerminal = [...run.eventLog].reverse().find((event) => event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled');
    if (lastTerminal) {
      switch (lastTerminal.type) {
        case 'run.failed':
          run.status = 'failed';
          run.error = lastTerminal.message;
          break;
        case 'run.cancelled':
          run.status = 'cancelled';
          run.error = lastTerminal.message;
          run.cancelReason = lastTerminal.reason;
          break;
        case 'run.completed':
          run.status = 'completed';
          break;
      }
    } else if (run.status === 'running') {
      run.status = abortController.signal.aborted ? 'cancelled' : 'failed';
      if (!run.error) {
        const reason = abortController.signal.reason instanceof Error
          ? abortController.signal.reason.message
          : typeof abortController.signal.reason === 'string'
            ? abortController.signal.reason
            : '';
        run.error = abortController.signal.aborted
          ? (reason || '已中止当前执行。')
          : 'Model request failed.';
      }
    }

    const pending = run.approvals.filter((approval) => approval.status === 'pending');
    if (run.status === 'completed' && pending.length > 0) {
      run.status = 'waiting-approval';
    }
    // Close any activity rows that never received tool.completed (lost events / parallel same-name).
    for (const activity of run.activities) {
      if (activity.status !== 'running') continue;
      if (run.status === 'completed' || run.status === 'waiting-approval') {
        activity.status = 'completed';
        activity.summary = activity.summary.includes('完成') ? activity.summary : `${activity.summary}（已完成）`;
      } else {
        activity.status = 'failed';
        activity.summary = activity.summary.includes('中止') ? activity.summary : `${activity.summary}（已中止）`;
      }
      activity.at = Date.now();
      publish({ type: 'run.activity', runId, activity: { ...activity } });
    }
    run.finishedAt = Date.now();
    await this.save(run);
    publish({ type: 'run.settled', runId, sessionId: options.sessionId, status: run.status, error: run.error });
    if (run.usage) {
      // Dynamic import avoids a circular init with usage.ts; compaction is best-effort.
      void import('./usage.js')
        .then((mod) => mod.maybeCompactUsage({ store: this.store, engine: this }))
        .catch(() => undefined);
    }
    return run;
  }

  /**
   * Mark chat runs left in `running` after a process restart as cancelled.
   * Project-task orphans are handled by ProjectService.recoverOrphanedExecution.
   */
  async recoverOrphanedRuns(): Promise<number> {
    const keys = await this.store.keys(`${RUN_NS}:`);
    let count = 0;
    for (const key of keys) {
      const run = await readJson<RunRecord>(this.store, key);
      if (!run || run.status !== 'running') continue;
      if (run.kind === 'project-task') continue;
      run.status = 'cancelled';
      run.error = '执行进程已中断，对话回合未正常结束。';
      run.cancelReason = 'user';
      run.finishedAt = Date.now();
      await this.save(run);
      this.hub.publish(`run:${run.id}`, {
        type: 'run.settled',
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        error: run.error,
      });
      this.hub.publish(`session:${run.sessionId}`, {
        type: 'run.settled',
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        error: run.error,
      });
      count += 1;
    }
    return count;
  }
}

export type { GrantCapability };
