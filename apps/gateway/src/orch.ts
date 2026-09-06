/**
 * Minimal orchestrator HTTP client for the gateway (/api/orch/**).
 * Only the surface the IM runtime needs: chat sessions, approvals, projects.
 */

export interface OrcEvent {
  type: string;
  runId?: string;
  sessionId?: string;
  text?: string;
  status?: string;
  error?: string;
  approval?: { id: string; skillId: string; capability: string; summary: string };
  artifact?: { path: string };
  taskId?: string;
}

export interface OrcSession {
  id: string;
  title: string;
  employeeId: string;
  messages: Array<{ id: string; role: string; content: string; superseded?: boolean }>;
  updatedAt: number;
}

export interface OrcRun {
  id: string;
  status: string;
  attemptNo: number;
  transcript: string;
  approvals: Array<{ id: string; skillId: string; capability: string; summary: string; status: string }>;
  error?: string;
}

export interface OrcProjectTask {
  id: string;
  title: string;
  status: string;
  error?: string;
  employeeId: string;
}

export interface OrcProject {
  id: string;
  name: string;
  goal: string;
  status: string;
  mode: string;
  tasks: OrcProjectTask[];
  summary?: string;
  activeRunId?: string;
}

export class OrchestratorClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string } & T;
    if (!response.ok) throw new Error(body?.message || `orchestrator ${response.status}`);
    return body;
  }

  /* sessions */
  async createSession(input: { title: string; employeeId: string }): Promise<OrcSession> {
    const result = await this.request<{ session: OrcSession }>('/sessions', { method: 'POST', body: JSON.stringify(input) });
    return result.session;
  }

  async getSession(id: string): Promise<OrcSession | null> {
    try {
      const result = await this.request<{ session: OrcSession }>(`/sessions/${encodeURIComponent(id)}`);
      return result.session;
    } catch {
      return null;
    }
  }

  /** Runs reachable from a session's messages (status/attempt/transcript). */
  async getSessionRuns(id: string): Promise<OrcRun[]> {
    const result = await this.request<{ runs: OrcRun[] }>(`/sessions/${encodeURIComponent(id)}/runs`);
    return result.runs;
  }

  /** Content only; the server assembles the run context (KV + keyring). */
  async sendMessage(sessionId: string, content: string): Promise<{ runId: string }> {
    return this.request<{ runId: string }>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  async cancelSessionRun(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', body: JSON.stringify({}) }).catch(() => undefined);
  }

  async pendingApprovals(sessionId: string): Promise<Array<{ runId: string; approvals: OrcRun['approvals'] }>> {
    const result = await this.request<{ pending: Array<{ id: string; approvals: OrcRun['approvals'] }> }>(
      `/sessions/${encodeURIComponent(sessionId)}/approvals`,
    );
    return result.pending.map((run) => ({ runId: run.id, approvals: run.approvals }));
  }

  async resolveApproval(sessionId: string, approvalId: string, allow: boolean): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ allow, scope: 'session' }),
    });
  }

  /* projects */
  async listProjects(): Promise<OrcProject[]> {
    const result = await this.request<{ projects: OrcProject[] }>('/projects');
    return result.projects;
  }

  async getProject(id: string): Promise<OrcProject | null> {
    try {
      const result = await this.request<{ project: OrcProject }>(`/projects/${encodeURIComponent(id)}`);
      return result.project;
    } catch {
      return null;
    }
  }

  async confirmProject(id: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: JSON.stringify({}) });
  }

  async cancelProject(id: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) }).catch(() => undefined);
  }

  /** Live session event stream (fetch-based SSE). Resolves to null on close. */
  async *openEventStream(sessionId: string, signal?: AbortSignal): AsyncGenerator<OrcEvent, void, undefined> {
    const controller = new AbortController();
    const abortOutside = () => controller.abort();
    signal?.addEventListener('abort', abortOutside, { once: true });
    try {
      const response = await fetch(`${this.baseUrl}/events?session=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          if (!chunk.startsWith('data: ')) continue;
          try {
            yield JSON.parse(chunk.slice(6)) as OrcEvent;
          } catch {
            /* heartbeat */
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', abortOutside);
      controller.abort();
    }
  }
}
