import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

type JsonRpcId = string | number;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type DshNotification = {
  method: string;
  params: Record<string, unknown>;
};

/**
 * Minimal newline-delimited JSON-RPC 2.0 client over a child process stdio.
 * Speaks the DeepSeek Harness SDK wire (initialize / session/prompt / shutdown
 * + session.* notifications) without depending on @deepseek-ai packages.
 */
export class DshJsonRpcClient {
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly notificationHandlers = new Set<(note: DshNotification) => void>();
  private closed = false;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stderrTail: string[] = [];

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const part of text.split(/\r?\n/)) {
        if (!part.trim()) continue;
        this.stderrTail.push(part.slice(0, 400));
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });
    this.child.on('exit', (code, signal) => {
      const err = new Error(
        `dsh runtime exited (code=${code ?? 'null'} signal=${signal ?? 'null'}).`
        + (this.stderrTail.length ? ` stderr: ${this.stderrTail.slice(-8).join(' | ')}` : ''),
      );
      this.failAll(err);
    });
  }

  onNotification(handler: (note: DshNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async initialize(params: {
    cwd: string;
    provider: string;
    model: string;
    maxTokens?: number;
  }): Promise<void> {
    await this.request('initialize', params);
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const result = await this.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    }) as { messageId?: string; accepted?: boolean };
    if (!result?.messageId) throw new Error('dsh session/prompt returned no messageId.');
    return result.messageId;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      await Promise.race([
        this.request('shutdown', {}),
        new Promise((resolve) => setTimeout(resolve, 1_500)),
      ]);
    } catch {
      /* ignore — process may already be dying */
    }
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      this.child.once('exit', done);
      setTimeout(() => {
        try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
          done();
        }, 2_000);
      }, 4_000);
    });
    this.failAll(new Error('dsh client closed.'));
  }

  private request(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('dsh client is closed.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.child.stdin.write(`${frame}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.pending.get(frame.id as JsonRpcId);
      if (!pending) return;
      this.pending.delete(frame.id as JsonRpcId);
      if (frame.error && typeof frame.error === 'object') {
        const err = frame.error as { code?: number; message?: string };
        pending.reject(new Error(err.message || `JSON-RPC error ${err.code ?? ''}`));
        return;
      }
      pending.resolve(frame.result);
      return;
    }
    if (typeof frame.method === 'string' && frame.id === undefined) {
      const note: DshNotification = {
        method: frame.method,
        params: (frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params))
          ? frame.params as Record<string, unknown>
          : {},
      };
      for (const handler of this.notificationHandlers) {
        try { handler(note); } catch { /* isolate subscriber faults */ }
      }
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
  }
}
