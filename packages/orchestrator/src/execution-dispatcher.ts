export interface DispatchEnvelope<T> {
  runId: string;
  orgId?: string;
  userId?: string;
  sessionId: string;
  kind: 'chat' | 'project-task';
  priority?: 'high' | 'normal';
  signal?: AbortSignal;
  execute: () => Promise<T>;
}

export interface ExecutionDispatcher {
  dispatch<T>(envelope: DispatchEnvelope<T>): Promise<T>;
}

export type DispatcherWaitReason = 'session-lane' | 'user-capacity' | 'global-capacity';

export interface DispatcherRunState {
  runId: string;
  orgId?: string;
  userId?: string;
  sessionId: string;
  kind: 'chat' | 'project-task';
  priority: 'high' | 'normal';
  state: 'queued' | 'running';
  waitReason?: DispatcherWaitReason;
  queuedAt: number;
  startedAt?: number;
}

export interface ExecutionDispatcherSnapshot {
  limits: {
    global: number;
    perUser: number;
    maxQueueWaitMs: number;
    highPriorityBurstLimit: number;
  };
  counts: {
    queued: number;
    running: number;
    activeSessions: number;
    activeUsers: number;
    highPriorityQueued: number;
    normalPriorityQueued: number;
  };
  runs: DispatcherRunState[];
}

export interface InMemoryExecutionDispatcherOptions {
  maxConcurrentRunsGlobal?: number;
  maxConcurrentRunsPerUser?: number;
  maxQueueWaitMs?: number;
  highPriorityBurstLimit?: number;
}

type CapacityWaiter = {
  runId: string;
  userId?: string;
  priority: 'high' | 'normal';
  queuedAt: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  cleanupAbort?: () => void;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason.message : typeof signal.reason === 'string' ? signal.reason : 'Run aborted before dispatch.';
  throw new Error(reason);
}

/**
 * Phase 1 dispatcher:
 * - chat runs are serialized by sessionId
 * - project-task runs remain eligible for parallel dispatch
 * - per-user and global concurrency are capped in-memory
 */
export class InMemoryExecutionDispatcher implements ExecutionDispatcher {
  private readonly maxConcurrentRunsGlobal: number;
  private readonly maxConcurrentRunsPerUser: number;
  private readonly maxQueueWaitMs: number;
  private readonly highPriorityBurstLimit: number;
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly sessionTailTokens = new Map<string, Promise<void>>();
  private readonly userRunning = new Map<string, number>();
  private runningGlobal = 0;
  private readonly runStates = new Map<string, DispatcherRunState>();
  private readonly capacityQueue: CapacityWaiter[] = [];
  private consecutiveHighPriorityGrants = 0;

  constructor(options: InMemoryExecutionDispatcherOptions = {}) {
    this.maxConcurrentRunsGlobal = Math.max(1, Math.round(options.maxConcurrentRunsGlobal ?? 4));
    this.maxConcurrentRunsPerUser = Math.max(1, Math.round(options.maxConcurrentRunsPerUser ?? 2));
    this.maxQueueWaitMs = Math.max(5_000, Math.round(options.maxQueueWaitMs ?? 120_000));
    this.highPriorityBurstLimit = Math.max(1, Math.round(options.highPriorityBurstLimit ?? 2));
  }

  async dispatch<T>(envelope: DispatchEnvelope<T>): Promise<T> {
    this.runStates.set(envelope.runId, {
      runId: envelope.runId,
      orgId: envelope.orgId,
      userId: envelope.userId,
      sessionId: envelope.sessionId,
      kind: envelope.kind,
      priority: envelope.priority ?? (envelope.kind === 'chat' ? 'high' : 'normal'),
      state: 'queued',
      queuedAt: Date.now(),
    });
    const releaseSession = await this.enterSessionLane(envelope);
    try {
      const releaseCapacity = await this.acquireCapacity(envelope);
      try {
        throwIfAborted(envelope.signal);
        return await envelope.execute();
      } finally {
        releaseCapacity();
      }
    } finally {
      releaseSession();
      this.runStates.delete(envelope.runId);
    }
  }

  snapshot(): ExecutionDispatcherSnapshot {
    const runs = Array.from(this.runStates.values()).sort((left, right) => left.queuedAt - right.queuedAt);
    return {
      limits: {
        global: this.maxConcurrentRunsGlobal,
        perUser: this.maxConcurrentRunsPerUser,
        maxQueueWaitMs: this.maxQueueWaitMs,
        highPriorityBurstLimit: this.highPriorityBurstLimit,
      },
      counts: {
        queued: runs.filter((item) => item.state === 'queued').length,
        running: runs.filter((item) => item.state === 'running').length,
        activeSessions: this.sessionTails.size,
        activeUsers: this.userRunning.size,
        highPriorityQueued: runs.filter((item) => item.state === 'queued' && item.priority === 'high').length,
        normalPriorityQueued: runs.filter((item) => item.state === 'queued' && item.priority === 'normal').length,
      },
      runs,
    };
  }

  private async enterSessionLane(envelope: DispatchEnvelope<unknown>): Promise<() => void> {
    if (envelope.kind !== 'chat') return () => undefined;
    const key = envelope.sessionId;
    const hadPrevious = this.sessionTails.has(key);
    const previous = this.sessionTails.get(key) ?? Promise.resolve();
    const gate = deferred();
    const tail = previous.finally(() => gate.promise);
    this.sessionTails.set(key, tail);
    this.sessionTailTokens.set(key, tail);
    if (hadPrevious) {
      this.markQueued(envelope.runId, 'session-lane');
    }
    await this.waitFor(previous, envelope.signal);
    return () => {
      gate.resolve();
      if (this.sessionTailTokens.get(key) === tail) {
        this.sessionTails.delete(key);
        this.sessionTailTokens.delete(key);
      }
    };
  }

  private async acquireCapacity(envelope: DispatchEnvelope<unknown>): Promise<() => void> {
    throwIfAborted(envelope.signal);
    this.throwIfQueueTimedOut(envelope.runId);
    const priority = envelope.priority ?? (envelope.kind === 'chat' ? 'high' : 'normal');
    const immediate = this.tryAcquireNow(envelope.runId, envelope.userId, priority);
    if (immediate) return immediate;
    this.markQueued(envelope.runId, this.waitReasonFor(envelope.userId));
    return this.waitForCapacity(envelope.runId, envelope.userId, priority, envelope.signal);
  }

  private markQueued(runId: string, waitReason: DispatcherWaitReason) {
    const state = this.runStates.get(runId);
    if (!state) return;
    state.state = 'queued';
    state.waitReason = waitReason;
  }

  private markRunning(runId: string) {
    const state = this.runStates.get(runId);
    if (!state) return;
    state.state = 'running';
    state.waitReason = undefined;
    state.startedAt = state.startedAt ?? Date.now();
  }

  private tryAcquireNow(runId: string, userId: string | undefined, priority: 'high' | 'normal'): (() => void) | null {
    if (!this.canRunForUser(userId)) return null;
    this.consumeCapacity(userId, runId, priority);
    return () => this.releaseCapacity(userId);
  }

  private waitForCapacity(runId: string, userId: string | undefined, priority: 'high' | 'normal', signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const waiter: CapacityWaiter = {
        runId,
        userId,
        priority,
        queuedAt: Date.now(),
        resolve: (release) => {
          waiter.cleanupAbort?.();
          resolve(release);
        },
        reject: (error) => {
          waiter.cleanupAbort?.();
          reject(error);
        },
      };
      if (signal) {
        const onAbort = () => {
          this.removeWaiter(runId);
          reject(signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Run aborted before dispatch.'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }
      this.capacityQueue.push(waiter);
      this.scheduleCapacityQueue();
    });
  }

  private async waitFor(wait: Promise<void>, signal?: AbortSignal) {
    if (!signal) {
      await wait;
      return;
    }
    await Promise.race([
      wait,
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Run aborted before dispatch.'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' ? signal.reason : 'Run aborted before dispatch.'));
        }, { once: true });
      }),
    ]);
  }

  private throwIfQueueTimedOut(runId: string) {
    const state = this.runStates.get(runId);
    if (!state || state.state !== 'queued') return;
    if (Date.now() - state.queuedAt < this.maxQueueWaitMs) return;
    this.removeWaiter(runId);
    throw new Error(`Run queued too long in dispatcher (${this.maxQueueWaitMs}ms).`);
  }

  private scheduleCapacityQueue() {
    this.rejectTimedOutWaiters();
    for (;;) {
      const nextIndex = this.selectNextWaiterIndex();
      if (nextIndex < 0) return;
      const [waiter] = this.capacityQueue.splice(nextIndex, 1);
      this.consumeCapacity(waiter.userId, waiter.runId, waiter.priority);
      waiter.resolve(() => this.releaseCapacity(waiter.userId));
    }
  }

  private rejectTimedOutWaiters() {
    const now = Date.now();
    for (let index = this.capacityQueue.length - 1; index >= 0; index -= 1) {
      const waiter = this.capacityQueue[index];
      const state = this.runStates.get(waiter.runId);
      const queuedAt = state?.queuedAt ?? waiter.queuedAt;
      if (now - queuedAt < this.maxQueueWaitMs) continue;
      this.capacityQueue.splice(index, 1);
      waiter.reject(new Error(`Run queued too long in dispatcher (${this.maxQueueWaitMs}ms).`));
    }
  }

  private selectNextWaiterIndex(): number {
    if (this.runningGlobal >= this.maxConcurrentRunsGlobal) return -1;
    const eligibleHigh = this.findEligibleWaiterIndex('high');
    const eligibleNormal = this.findEligibleWaiterIndex('normal');
    if (eligibleHigh >= 0 && (eligibleNormal < 0 || this.consecutiveHighPriorityGrants < this.highPriorityBurstLimit)) {
      return eligibleHigh;
    }
    if (eligibleNormal >= 0) return eligibleNormal;
    return eligibleHigh;
  }

  private findEligibleWaiterIndex(priority: 'high' | 'normal'): number {
    for (let index = 0; index < this.capacityQueue.length; index += 1) {
      const waiter = this.capacityQueue[index];
      if (waiter.priority !== priority) continue;
      if (!this.canRunForUser(waiter.userId)) continue;
      return index;
    }
    return -1;
  }

  private canRunForUser(userId?: string): boolean {
    if (this.runningGlobal >= this.maxConcurrentRunsGlobal) return false;
    const key = userId?.trim() || '';
    if (!key) return true;
    return (this.userRunning.get(key) ?? 0) < this.maxConcurrentRunsPerUser;
  }

  private consumeCapacity(userId: string | undefined, runId: string, priority: 'high' | 'normal') {
    this.runningGlobal += 1;
    const key = userId?.trim() || '';
    if (key) this.userRunning.set(key, (this.userRunning.get(key) ?? 0) + 1);
    this.markRunning(runId);
    this.consecutiveHighPriorityGrants = priority === 'high' ? this.consecutiveHighPriorityGrants + 1 : 0;
  }

  private releaseCapacity(userId?: string) {
    this.runningGlobal = Math.max(0, this.runningGlobal - 1);
    const key = userId?.trim() || '';
    if (key) {
      const next = Math.max(0, (this.userRunning.get(key) ?? 1) - 1);
      if (next > 0) this.userRunning.set(key, next);
      else this.userRunning.delete(key);
    }
    this.scheduleCapacityQueue();
  }

  private waitReasonFor(userId?: string): DispatcherWaitReason {
    const key = userId?.trim() || '';
    if (this.runningGlobal >= this.maxConcurrentRunsGlobal) return 'global-capacity';
    if (key && (this.userRunning.get(key) ?? 0) >= this.maxConcurrentRunsPerUser) return 'user-capacity';
    return 'global-capacity';
  }

  private removeWaiter(runId: string) {
    const index = this.capacityQueue.findIndex((waiter) => waiter.runId === runId);
    if (index < 0) return;
    const [waiter] = this.capacityQueue.splice(index, 1);
    waiter.cleanupAbort?.();
  }
}
