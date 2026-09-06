import { newId, parseFrame, type RelayFrame, type RelayRequest, type RelayResponse } from './protocol.js';

/** Minimal WebSocket surface used by the device client (Node ≥22 global). */
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

const OPEN = 1;

export interface RelayDeviceOptions {
  url: string;
  deviceId: string;
  /** Empty token allowed when the relay requires none (local smoke). */
  token?: string;
  heartbeatMs?: number;
  /** Called for requests the relay forwards to this device. */
  onRequest: (request: RelayRequest) => Promise<unknown>;
}

/**
 * Gateway-side device link (M2 P3): actively connects to the relay, registers
 * with `hello`, answers forwarded requests (reusing the gateway runtime via a
 * caller-supplied handler), heartbeats, and reconnects with exponential backoff.
 */
export class RelayDeviceClient {
  private socket: WsLike | null = null;
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly options: RelayDeviceOptions) {}

  /** Connect, register with hello, start heartbeats. Resolves when registered. */
  async start(): Promise<void> {
    const socket = await this.openAndHandshake();
    this.socket = socket;
    this.startHeartbeat();
  }

  private openAndHandshake(): Promise<WsLike> {
    return new Promise((resolve, reject) => {
      const socket = this.createSocket();
      let failTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        reject(new Error('relay connect timeout'));
      }, 10_000);
      const clearFail = () => {
        if (failTimer) clearTimeout(failTimer);
        failTimer = null;
      };
      socket.addEventListener('message', (event) => this.onMessage(socket, event));
      socket.addEventListener('close', () => {
        this.socket = null;
        if (!this.stopped) this.scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        clearFail();
        reject(new Error('relay connect error'));
      });
      socket.addEventListener('open', () => {
        void this.requestFrame(socket, 'hello', { deviceId: this.options.deviceId, token: this.options.token ?? '' }, 6_000)
          .then(() => {
            clearFail();
            resolve(socket);
          })
          .catch((error) => {
            clearFail();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    });
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    setTimeout(() => {
      if (this.stopped) return;
      void this.openAndHandshake()
        .then((socket) => {
          this.socket = socket;
          this.startHeartbeat();
        })
        .catch(() => this.scheduleReconnect());
    }, 1000);
  }

  private createSocket(): WsLike {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
    if (!Ctor) throw new Error('WebSocket is unavailable in this runtime');
    const socket = new Ctor(this.options.url);
    return socket;
  }

  private onMessage(socket: WsLike, event: { data?: unknown }): void {
    const frame = parseFrame(typeof event.data === 'string' ? event.data : '');
    if (!frame) return;
    void this.handleFrame(socket, frame);
  }

  private async handleFrame(socket: WsLike, frame: RelayFrame): Promise<void> {
    if (frame.type === 'response') {
      const entry = this.pending.get(frame.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        if (frame.error) entry.reject(new Error(frame.error.message));
        else entry.resolve(frame.result);
      }
      return;
    }
    if (frame.type !== 'request') return;
    const request = frame as RelayRequest;
    try {
      const result = await this.options.onRequest(request);
      this.sendFrame(socket, { type: 'response', id: request.id, result });
    } catch (error) {
      this.sendFrame(socket, { type: 'response', id: request.id, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  /** Issue a request on an explicit socket (used for the initial hello). */
  private requestFrame(socket: WsLike, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = newId('req');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`relay request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendFrame(socket, { type: 'request', id, method, params });
    });
  }

  /** Device-originated request (heartbeat). */
  private sendFrame(socket: WsLike, frame: RelayFrame): void {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(frame));
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (socket) void this.requestFrame(socket, 'device.ping', {}, 6_000).catch(() => undefined);
    }, this.options.heartbeatMs ?? 20_000);
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('relay closed'));
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}
