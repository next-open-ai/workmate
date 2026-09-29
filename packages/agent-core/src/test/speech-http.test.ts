import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { speechFetch } from '../speech-http.js';
import { createModelCapabilityTools } from '../model-capability-runtime.js';
import { uploadDashScopeAudio } from '../speech-provider-adapters.js';

test('speech reads recover from fetch failure; POST is never replayed and signed URLs are redacted', async () => {
  const nativeFetch = globalThis.fetch;
  let hits = 0;
  let fetchCalls = 0;
  const server = createServer((_req, res) => { hits++; res.end(JSON.stringify({ text: '转写成功' })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr === 'object');
  const base = `http://127.0.0.1:${addr.port}`;
  globalThis.fetch = (() => { fetchCalls++; return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })); }) as typeof fetch;
  try {
    assert.equal((await (await speechFetch(`${base}/result?signature=SECRET`)).json()).text, '转写成功');
    assert.equal(hits, 1);
    await assert.rejects(speechFetch(`${base}/submit?signa=SECRET`, { method: 'POST' }), (error: Error) => {
      assert.match(error.message, /POST.*submit.*ECONNRESET/);
      assert.doesNotMatch(error.message, /SECRET/); return true;
    });
    assert.equal(hits, 1);
    const [tool] = createModelCapabilityTools({ workspaceRoot: '/tmp/not-used', configs: [{ id: 'asr', provider: 'qwen', capability: 'asr', baseUrl: base, apiKey: '', modelId: 'paraformer-v2', mode: 'auto' }] });
    const first = (await tool.execute('a', { sourceUrl: 'https://example.com/audio.mp3' }, undefined)).details as any;
    assert.equal(first.retryable, false);
    assert.equal(first.retryScope, 'current_run');
    assert.equal(first.canRetryInNewRun, true);
    assert.equal(first.stage, 'task_submit');
    assert.match(first.error, /transcription/);
    const afterFailure = fetchCalls;
    const second = (await tool.execute('b', { sourceUrl: 'https://example.com/other.mp3', outputFormat: 'text' }, undefined)).details as any;
    assert.equal(second.error, first.error);
    assert.equal(fetchCalls, afterFailure);
    const [newRunTool] = createModelCapabilityTools({ workspaceRoot: '/tmp/not-used', configs: [{ id: 'asr', provider: 'qwen', capability: 'asr', baseUrl: base, apiKey: '', modelId: 'paraformer-v2', mode: 'auto' }] });
    await newRunTool.execute('c', { sourceUrl: 'https://example.com/audio.mp3' }, undefined);
    assert.equal(fetchCalls, afterFailure + 1, 'new execution must submit despite prior run failure');
    assert.equal(hits, 1);
  } finally {
    globalThis.fetch = nativeFetch;
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
  }
});

test('AMC-ASR-NET-002 upload recovery is bounded, uses fresh keys and never submits ASR', async () => {
  const original = globalThis.fetch;
  const config = { id: 'asr', provider: 'qwen' as const, capability: 'asr' as const, baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'SECRET', modelId: 'paraformer-v2', mode: 'auto' as const };
  let behavior = 'recover';
  let posts = 0;
  let compatPosts = 0;
  const keys: string[] = [];
  const progress: string[] = [];
  let controller = new AbortController();
  globalThis.fetch = (async (value, init) => {
    const url = String(value);
    if (url.includes('/api/v1/uploads?')) return new Response(JSON.stringify({ data: {
      upload_host: 'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/?signature=SECRET', upload_dir: 'test',
      oss_access_key_id: 'SECRET', signature: 'SECRET', policy: 'SECRET', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
    } }));
    assert.ok(url.includes('dashscope-file-mgr.oss-cn-beijing.aliyuncs.com'));
    assert.equal(init?.method, 'POST');
    posts++;
    keys.push(String((init?.body as FormData).get('key')));
    if (behavior === '403') return new Response('', { status: 403 });
    if (behavior === 'cancel') controller.abort();
    if (behavior !== 'recover' || posts === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return new Response('');
  }) as typeof fetch;
  const compatUpload = async (input: any) => {
    compatPosts++; posts++; keys.push(String(input.fields.key));
    if (behavior === 'compat-recover') return new Response('');
    const { SpeechNetworkError } = await import('../speech-http.js');
    throw new SpeechNetworkError('compat reset [ECONNRESET]', 'POST', 'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/', 'upload', 3);
  };
  const invoke = () => uploadDashScopeAudio({ config, bytes: new Uint8Array([1, 2]), extension: '.mp3', signal: controller.signal, report: (message) => progress.push(message), compatUpload });
  try {
    assert.match(await invoke(), /^oss:\/\/test\//);
    assert.equal(posts, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.ok(progress.some((text) => text.includes('使用新临时对象重试')));
    behavior = 'fail'; posts = 0;
    await assert.rejects(invoke(), (error: any) => {
      assert.equal(error.stage, 'upload'); assert.equal(error.attempts, 3);
      assert.match(error.message, /ECONNRESET/); assert.doesNotMatch(error.message, /SECRET/); return true;
    });
    assert.equal(posts, 3);
    behavior = 'compat-recover'; posts = 0; compatPosts = 0;
    assert.match(await invoke(), /^oss:\/\/test\//);
    assert.equal(posts, 3); assert.equal(compatPosts, 1);
    assert.ok(progress.some((text) => text.includes('兼容通道')));
    behavior = '403'; posts = 0;
    await assert.rejects(invoke(), /HTTP 403/);
    assert.equal(posts, 1);
    behavior = 'cancel'; posts = 0;
    await assert.rejects(invoke());
    assert.equal(posts, 1);
    controller = new AbortController(); controller.abort(); posts = 0;
    await assert.rejects(invoke());
    assert.equal(posts, 0);
  } finally { globalThis.fetch = original; }
});

test('AMC-ASR-NET-003 native compatibility upload sends valid multipart after fetch resets', async () => {
  const original = globalThis.fetch;
  let received = '';
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      const address = server.address(); assert.ok(address && typeof address === 'object');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: {
        upload_host: `http://127.0.0.1:${address.port}/upload`, upload_dir: 'native-test',
        oss_access_key_id: 'id', signature: 'signature', policy: 'policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
      } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = Buffer.concat(chunks).toString('latin1');
    response.writeHead(200); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let defaultUploads = 0;
  globalThis.fetch = (async (value, init) => {
    if ((init?.method || 'GET') === 'GET') return original(value, init);
    defaultUploads++;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  }) as typeof fetch;
  try {
    const result = await uploadDashScopeAudio({
      config: { id: 'asr', provider: 'qwen', capability: 'asr', baseUrl, apiKey: 'key', modelId: 'paraformer-v2', mode: 'auto' },
      bytes: new Uint8Array([0x41, 0x55, 0x44, 0x49, 0x4f]), extension: '.mp3', report: () => undefined,
    });
    assert.match(result, /^oss:\/\/native-test\//);
    assert.equal(defaultUploads, 2);
    assert.match(received, /name="key"/);
    assert.match(received, /name="file"; filename="[^"]+\.mp3"/);
    assert.match(received, /AUDIO/);
  } finally {
    globalThis.fetch = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
