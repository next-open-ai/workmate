import { WebSocketServer, WebSocket } from 'ws';
import { newId, parseFrame, type RelayFrame, type RelayRequest } from './protocol.js';

/**
 * Minimal self-hosted relay (M2 P3). Pure forwarder:
 *  - device links register with `hello` {deviceId, token};
 *  - terminal requests carry `params.deviceId` → forwarded to that device;
 *  - the device's response is routed back to the original requester;
 *  - `device.ping` answers directly (device heartbeat).
 */
const OPEN = 1;

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private readonly devices = new Map<string, WebSocket>();
  private readonly pending = new Map<string, WebSocket>();

  constructor(private readonly serverToken = '') {}

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port }, () => resolve());
      this.wss.on('error', reject);
      this.wss.on('connection', (socket) => this.attach(socket));
    });
  }

  private send(socket: WebSocket, frame: RelayFrame) {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(frame));
  }

  private attach(socket: WebSocket): void {
    socket.on('message', (raw: Buffer) => {
      try {
        const frame = parseFrame(raw.toString());
        if (!frame) return;
        if (frame.type === 'response') {
          const origin = this.pending.get(frame.id);
          if (origin && origin.readyState === OPEN) {
            origin.send(raw.toString());
            this.pending.delete(frame.id);
          }
          return;
        }
        if (frame.type !== 'request') return;
        const request = frame as RelayRequest;
        if (request.method === 'hello') {
          const deviceId = String(request.params?.deviceId ?? '');
          const token = String(request.params?.token ?? '');
          if (!deviceId) {
            this.send(socket, { type: 'response', id: request.id, error: { message: 'deviceId required' } });
            return;
          }
          if (token !== this.serverToken) {
            this.send(socket, { type: 'response', id: request.id, error: { message: 'device token rejected' } });
            return;
          }
          this.devices.set(deviceId, socket);
          this.send(socket, { type: 'response', id: request.id, result: { ok: true, deviceId } });
          return;
        }
        if (request.method === 'device.ping') {
          this.send(socket, { type: 'response', id: request.id, result: { ok: true } });
          return;
        }
        const deviceId = String(request.params?.deviceId ?? '');
        if (!deviceId) {
          this.send(socket, { type: 'response', id: request.id, error: { message: 'deviceId required in params' } });
          return;
        }
        const device = this.devices.get(deviceId);
        if (!device || device.readyState !== OPEN) {
          this.send(socket, { type: 'response', id: request.id, error: { message: `device ${deviceId} offline` } });
          return;
        }
        this.pending.set(request.id, socket);
        device.send(JSON.stringify(request));
      } catch {
        /* ignore malformed frames */
      }
    });

    socket.on('close', () => {
      for (const [deviceId, entry] of this.devices) {
        if (entry === socket) this.devices.delete(deviceId);
      }
      for (const [id, origin] of [...this.pending]) {
        if (origin === socket) this.pending.delete(id);
      }
    });
  }

  /** Random device route for smoke tests. */
  async close(): Promise<void> {
    for (const socket of this.devices.values()) socket.close();
    this.devices.clear();
    this.pending.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }
}

/** Convenience id generator reused by device links. */
export { newId };
