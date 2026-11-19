import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export interface SpeechConnectionDiagnostics {
  phase: 'dns' | 'connect' | 'tls' | 'request' | 'response';
  requestFinished: boolean;
  responseStarted: boolean;
  elapsedMs: number;
}

export class SpeechNetworkError extends Error {
  constructor(message: string, readonly method: string, readonly endpoint: string,
    readonly stage?: 'upload_policy' | 'upload', readonly attempts = 1,
    readonly connection?: SpeechConnectionDiagnostics) { super(message); }
}

function connectionDetails(error: unknown): SpeechConnectionDiagnostics | undefined {
  return error && typeof error === 'object' && 'speechConnection' in error
    ? (error as { speechConnection: SpeechConnectionDiagnostics }).speechConnection : undefined;
}

function causeCodes(error: unknown): string {
  if (!error || typeof error !== 'object') return 'NETWORK_ERROR';
  const item = error as { name?: string; code?: string; cause?: unknown; errors?: unknown[] };
  return [item.code || item.name, item.cause ? causeCodes(item.cause) : '', ...(item.errors || []).map(causeCodes)].filter(Boolean).join('/');
}

const MAX_BYTES = 30 * 1024 * 1024;
async function boundedBody(response: Response) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Speech response exceeds 30 MB.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Native transport selected before submitting; redirects/retries are GET-only. */
function requestWithNode(url: URL, init: RequestInit, signal: AbortSignal, redirects = 0): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body;
  if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) return Promise.reject(new Error('Native speech transport requires a buffered JSON body.'));
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const connection: SpeechConnectionDiagnostics = { phase: isIP(url.hostname) ? 'connect' : 'dns', requestFinished: false, responseStarted: false, elapsedMs: 0 };
    const fail = (error: Error) => {
      Object.assign(error, { speechConnection: { ...connection, elapsedMs: Date.now() - startedAt } });
      reject(error);
    };
    const transport = url.protocol === 'https:' ? https : http;
    const outgoingHeaders = new Headers(init.headers);
    if (body != null) outgoingHeaders.set('content-length', String(Buffer.byteLength(body)));
    const request = transport.request(url, { method, headers: Object.fromEntries(outgoingHeaders), signal, ...(method === 'POST' ? { agent: false } : {}) }, (response) => {
      connection.phase = 'response'; connection.responseStarted = true;
      const status = response.statusCode || 500;
      if (method === 'GET' && [301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url);
        if (redirects >= 3 || !['http:', 'https:'].includes(next.protocol) || (url.protocol === 'https:' && next.protocol !== 'https:')) { reject(new Error('Unsafe speech redirect.')); return; }
        const headers = new Headers(init.headers);
        if (next.origin !== url.origin) { headers.delete('authorization'); headers.delete('cookie'); }
        resolve(requestWithNode(next, { ...init, headers }, signal, redirects + 1)); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(new Error('Speech response exceeds 30 MB.')); return; }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const result = new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers });
        Object.defineProperty(result, 'url', { value: url.href });
        resolve(result);
      });
    });
    request.on('socket', (socket) => {
      if (!socket.connecting) connection.phase = 'request';
      socket.once('lookup', (error) => { if (!error) connection.phase = 'connect'; });
      socket.once('connect', () => { connection.phase = url.protocol === 'https:' ? 'tls' : 'request'; });
      socket.once('secureConnect', () => { connection.phase = 'request'; });
    });
    request.once('finish', () => { connection.requestFinished = true; });
    request.on('error', fail); request.end(body ?? undefined);
  });
}

export async function speechFetch(value: string | URL, init: RequestInit = {}, timeoutMs = 120_000, transport: 'fetch' | 'node' = 'fetch'): Promise<Response> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid speech HTTP protocol.');
  const method = (init.method || 'GET').toUpperCase();
  // Query strings can contain signed credentials. Never expose them in diagnostics.
  const endpoint = `${url.origin}${url.pathname}`;
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    if (transport === 'node') return await requestWithNode(url, init, signal);
    const response = await globalThis.fetch(url, { ...init, signal });
    const body = await boundedBody(response);
    const result = new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
    Object.defineProperty(result, 'url', { value: response.url || url.href });
    return result;
  } catch (error) {
    const connection = connectionDetails(error);
    const phase = connection ? `; phase=${connection.phase}; requestFinished=${connection.requestFinished}; responseStarted=${connection.responseStarted}` : '';
    if (signal.aborted) throw new SpeechNetworkError(`语音请求已取消或超时：${method} ${endpoint} [${causeCodes(error)}${phase}]`, method, endpoint, undefined, 1, connection);
    if (method === 'GET' && transport !== 'node') {
      try { return await requestWithNode(url, init, signal); }
      catch (fallback) { throw new SpeechNetworkError(`语音网络读取失败：GET ${endpoint} [fetch=${causeCodes(error)}; node=${causeCodes(fallback)}]。请检查此地址的 DNS、代理和 TLS 连接。`, method, endpoint); }
    }
    throw new SpeechNetworkError(`语音网络提交失败：${method} ${endpoint} [${causeCodes(error)}; transport=${transport === 'node' ? 'node-http1' : 'fetch'}${phase}]。服务端是否收到请求未知，不要通过更换文本、文件路径或格式重复提交。`, method, endpoint, undefined, 1, connection);
  }
}
