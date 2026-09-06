/**
 * Remote-relay wire envelope (M2 P3). JSON frames exchanged between relay
 * server, gateway device links and remote terminals:
 *
 *   request  { type:'request',  id, method, params }     (params may carry deviceId)
 *   response { type:'response', id, result? , error? }
 *   event    { type:'event',    event, payload? }        (future push)
 */

export interface RelayRequest {
  type: 'request';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RelayResponse {
  type: 'response';
  id: string;
  result?: unknown;
  error?: { message: string };
}

export interface RelayEvent {
  type: 'event';
  event: string;
  payload?: unknown;
}

export type RelayFrame = RelayRequest | RelayResponse | RelayEvent;

export function parseFrame(raw: string): RelayFrame | null {
  try {
    const value = JSON.parse(raw) as Partial<RelayFrame> & { type?: string };
    if (value && typeof value === 'object' && value.type) return value as RelayFrame;
    return null;
  } catch {
    return null;
  }
}

export function newId(prefix = 'r'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
