import http from 'node:http';
import https from 'node:https';

export class SpeechNetworkError extends Error {
  constructor(message: string, readonly method: string, readonly endpoint: string,
    readonly stage?: 'upload_policy' | 'upload', readonly attempts = 1) { super(message); }
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

/** Independent Node transport for idempotent reads only; never resubmit paid POST requests. */
function readWithNode(url: URL, init: RequestInit, signal: AbortSignal, redirects = 0): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method: 'GET', headers: Object.fromEntries(new Headers(init.headers)), signal }, (response) => {
      const status = response.statusCode || 500;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url);
        if (redirects >= 3 || !['http:', 'https:'].includes(next.protocol) || (url.protocol === 'https:' && next.protocol !== 'https:')) { reject(new Error('Unsafe speech redirect.')); return; }
        const headers = new Headers(init.headers);
        if (next.origin !== url.origin) { headers.delete('authorization'); headers.delete('cookie'); }
        resolve(readWithNode(next, { ...init, headers }, signal, redirects + 1)); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(new Error('Speech response exceeds 30 MB.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const result = new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers });
        Object.defineProperty(result, 'url', { value: url.href });
        resolve(result);
      });
    });
    request.on('error', reject); request.end();
  });
}

export async function speechFetch(value: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid speech HTTP protocol.');
  const method = (init.method || 'GET').toUpperCase();
  // Query strings can contain signed credentials. Never expose them in diagnostics.
  const endpoint = `${url.origin}${url.pathname}`;
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  try {
    const response = await globalThis.fetch(url, { ...init, signal });
    const body = await boundedBody(response);
    const result = new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
    Object.defineProperty(result, 'url', { value: response.url || url.href });
    return result;
  } catch (error) {
    if (signal.aborted) throw new SpeechNetworkError(`语音请求已取消或超时：${method} ${endpoint} [${causeCodes(error)}]`, method, endpoint);
    if (method === 'GET') {
      try { return await readWithNode(url, init, signal); }
      catch (fallback) { throw new SpeechNetworkError(`语音网络读取失败：GET ${endpoint} [fetch=${causeCodes(error)}; node=${causeCodes(fallback)}]。请检查此地址的 DNS、代理和 TLS 连接。`, method, endpoint); }
    }
    throw new SpeechNetworkError(`语音网络提交失败：${method} ${endpoint} [${causeCodes(error)}]。服务端是否收到请求未知，不要通过更换文本、文件路径或格式重复提交。`, method, endpoint);
  }
}
