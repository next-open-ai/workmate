import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer as createTcpServer } from 'node:net';
import { isQwenPromptAudioModel, resolveProviderBaseUrl, suggestedSpeechVoices, type ModelCapabilityRuntime } from '@workmate/contracts';
import { createModelCapabilityTools, createModelCapabilityToolSession, MODEL_CAPABILITY_BY_TOOL } from '../model-capability-runtime.js';
import { synthesizeDashScope } from '../speech-provider-adapters.js';
import { speechFetch, SpeechNetworkError } from '../speech-http.js';

const config: ModelCapabilityRuntime = { id: 'audio-next', capability: 'tts', provider: 'qwen', baseUrl: 'https://space.cn-beijing.maas.aliyuncs.com/api/v1', apiKey: 'test-secret', modelId: 'qwen-audio-3.1-tts-next', mode: 'auto' };
const endpointPath = '/api/v1/services/audio/tts/SpeechSynthesizer';

async function fixture(handler: (request: IncomingMessage, response: ServerResponse, base: string) => void | Promise<void>) {
  let base = '';
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response, base)).catch((error) => response.destroy(error)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = 'http://127.0.0.1:' + address.port;
  return { base, config: { ...config, baseUrl: base + '/api/v1' }, close: async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections(); await closed;
  } };
}
async function body(request: IncomingMessage) {
  const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
  return JSON.parse(Buffer.concat(parts).toString());
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
async function workspace() { return mkdtemp(path.join(os.tmpdir(), 'workmate-prompt-audio-')); }

test('AMC-AUDIOGEN AT1: model identification and workspace regions', () => {
  assert.equal(isQwenPromptAudioModel('qwen', ' QWEN-AUDIO-3.1-TTS-NEXT '), true);
  assert.equal(isQwenPromptAudioModel('openai-compatible', config.modelId), false);
  assert.equal(isQwenPromptAudioModel('qwen', 'qwen-audio-3.1-tts-flash'), false);
  assert.deepEqual(suggestedSpeechVoices('qwen', config.modelId), []);
  assert.equal(resolveProviderBaseUrl({ provider: 'qwen', workspaceId: 'space', baseUrl: 'https://dashscope-intl.aliyuncs.com/api/v1' }), 'https://space.ap-southeast-1.maas.aliyuncs.com/api/v1');
});

test('AMC-AUDIOGEN AT9: Next is discoverable as AudioGen, with per-run freshness and existing TTS authorization', () => {
  const next = createModelCapabilityToolSession({ workspaceRoot: '/tmp/not-used', configs: [config] });
  assert.deepEqual(next.descriptors.map((tool) => tool.id), ['model_generate_audio']);
  assert.equal(next.descriptors[0].capability, 'tts');
  assert.equal(MODEL_CAPABILITY_BY_TOOL.model_generate_audio, 'tts');
  assert.match(next.descriptors[0].description, /not tested in this run/);
  assert.match(next.descriptors[0].description, /previous turn.*not a current-run result/);
  assert.match(next.descriptors[0].description, /not conventional text-only TTS/);
  assert.match(next.descriptors[0].description, /respect an explicit user request for offline/);
  assert.doesNotMatch(JSON.stringify(next.descriptors), /test-secret|space.cn-beijing/);
  const speech = createModelCapabilityToolSession({ workspaceRoot: '/tmp/not-used', configs: [{ ...config, modelId: 'qwen-audio-3.1-tts-flash' }] });
  assert.deepEqual(speech.descriptors.map((tool) => tool.id), ['model_synthesize_speech']);
  assert.doesNotMatch(speech.descriptors[0].description, /AudioGen|previous turn/);
  assert.deepEqual(createModelCapabilityToolSession({ workspaceRoot: '/tmp/not-used', configs: [{ ...config, mode: 'disabled' }] }).descriptors, []);
});

test('AMC-AUDIOGEN AT1/AT7: native single POST, creative prompt, original audio bytes and key-free download', async () => {
  const root = await workspace(); let submitted: unknown; let posts = 0;
  const timeouts: number[] = []; const originalTimeout = AbortSignal.timeout;
  const prompt = '空灵抒情女声，清晰演唱原创歌词：“晚风吹过街道，愿望慢慢发芽。”配木吉他，不要朗读或仅哼元音。';
  const server = await fixture(async (request, response, base) => {
    if (request.url === endpointPath) {
      posts++; submitted = await body(request);
      assert.equal(request.headers.authorization, 'Bearer test-secret');
      assert.equal(request.headers.connection, 'close');
      json(response, { request_id: 'song-1', output: { audio: { url: base + '/song.mp3' } } });
    } else {
      assert.equal(request.headers.authorization, undefined);
      response.writeHead(200, { 'content-type': 'audio/mpeg' }); response.end('ID3-original-song-no-transcoding');
    }
  });
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return originalTimeout(ms); };
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot: root, configs: [{ ...server.config, voice: 'old-voice' }] });
    assert.equal(tool.name, 'model_generate_audio');
    assert.match(tool.description, /SING.*lyrics/);
    assert.match(tool.description, /do not silently use Python/);
    const session = createModelCapabilityToolSession({ workspaceRoot: root, configs: [server.config] });
    const invocation = await session.invoke({ version: 1, invocationId: 'song', runId: 'new-run', toolId: 'model_generate_audio', input: { text: prompt } });
    assert.equal(invocation.status, 'succeeded');
    const result = invocation.output as any;
    assert.equal(result.ok, true);
    assert.deepEqual(submitted, { model: config.modelId, input: { text_prompt: prompt, sample_rate: 48000, channels: 2, format: 'mp3' } });
    assert.deepEqual(timeouts, [300000, 120000]); assert.equal(posts, 1);
    assert.equal(result.deliverable, true); assert.equal(result.modelId, config.modelId);
    assert.equal((await readFile(path.join(root, result.path))).toString(), 'ID3-original-song-no-transcoding');
  } finally { AbortSignal.timeout = originalTimeout; await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('AMC-AUDIOGEN AT2: invalid input/missing workspace rejected before any request', async () => {
  const input = { config, text: '生成声音', voice: '', format: 'mp3', report: () => undefined };
  await assert.rejects(synthesizeDashScope({ ...input, text: '歌'.repeat(3001) }), /3000/);
  await assert.rejects(synthesizeDashScope({ ...input, text: '  ' }), /3000/);
  await assert.rejects(synthesizeDashScope({ ...input, voice: 'alloy' }), /voice/);
  await assert.rejects(synthesizeDashScope({ ...input, format: 'opus' }), /mp3/);
  await assert.rejects(synthesizeDashScope({ ...input, speed: 3 }), /0.5/);
  await assert.rejects(synthesizeDashScope({ ...input, config: { ...config, baseUrl: 'https://dashscope.aliyuncs.com/api/v1' } }), /Workspace ID/);
});

test('AMC-AUDIOGEN AT2: permissions/malformed responses never create successful artifacts', async () => {
  const root = await workspace(); let failure = '403'; let posts = 0;
  const server = await fixture(async (request, response, base) => {
    if (request.url === endpointPath) {
      posts++; await body(request);
      json(response, failure === '403' ? { message: 'Access denied', request_id: 'req-1' } : failure === 'missing-url' ? {} : { output: { audio: { url: base + '/audio' } } }, failure === '403' ? 403 : 200);
    } else {
      response.writeHead(200, { 'content-type': failure === 'html' ? 'text/html' : 'audio/mpeg' });
      response.end(failure === 'empty' ? '' : '<html>not audio</html>');
    }
  });
  try {
    for (failure of ['403', 'missing-url', 'html', 'empty']) {
      const [tool] = createModelCapabilityTools({ workspaceRoot: root, configs: [server.config] });
      const result = (await tool.execute(failure, { text: '创作带歌词的民谣' }, undefined)).details as any;
      assert.equal(result.ok, false);
      if (failure === '403') {
        assert.equal(result.status, 403); assert.equal(result.requestId, 'req-1');
        await tool.execute('again', { text: '换一首' }, undefined); assert.equal(posts, 1);
      }
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('AMC-AUDIOGEN AT8: reset reports unknown generation, blocks this run only, forbids silent downgrade', async () => {
  const root = await workspace(); let posts = 0;
  const server = await fixture(async (request) => { await body(request); posts++; request.socket.destroy(); });
  try {
    const make = () => createModelCapabilityTools({ workspaceRoot: root, configs: [server.config] })[0];
    const tool = make();
    const first = (await tool.execute('first', { text: '清晰唱出歌词的女声歌曲' }, undefined)).details as any;
    assert.equal(first.ok, false); assert.equal(first.code, 'AUDIO_NETWORK_UNCONFIRMED');
    assert.equal(first.modelId, config.modelId); assert.equal(first.method, 'POST');
    assert.equal(first.submissionState, 'unknown'); assert.equal(first.retryable, false);
    assert.equal(first.canRetryInNewRun, true); assert.equal(first.fallbackAllowed, false);
    assert.match(first.error, /未经用户同意/);
    assert.match(first.error, /transport=node-http1/);
    assert.equal(first.connection.phase, 'request');
    assert.equal(first.connection.requestFinished, true);
    assert.equal(first.connection.responseStarted, false);
    assert.doesNotMatch(first.error, /test-secret/);
    const second = (await tool.execute('second', { text: '更换歌词重发' }, undefined)).details;
    assert.deepEqual(second, first); assert.equal(posts, 1);
    await make().execute('new-turn', { text: '用户明确重试' }, undefined);
    assert.equal(posts, 2);
    assert.deepEqual(await readdir(root), []);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('AMC-AUDIOGEN AT8: a returned URL followed by failed download is not generation success', async () => {
  const root = await workspace(); let posts = 0;
  const server = await fixture(async (request, response, base) => {
    if (request.method === 'POST') { posts++; await body(request); json(response, { output: { audio: { url: base + '/broken-audio?signature=PRIVATE' } } }); }
    else request.socket.destroy();
  });
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot: root, configs: [server.config] });
    const result = (await tool.execute('download', { text: '唱一段歌词' }, undefined)).details as any;
    assert.equal(result.submissionState, 'generated_download_failed'); assert.equal(result.method, 'GET');
    assert.doesNotMatch(result.endpoint, /PRIVATE/);
    assert.equal(result.ok, false); assert.equal(posts, 1);
    await tool.execute('again', { text: '重试' }, undefined); assert.equal(posts, 1);
    assert.deepEqual(await readdir(root), []);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('AMC-AUDIOGEN AT7: native cancellation, truncated body, timeout and POST redirect never replay', async () => {
  let posts = 0; let ready!: () => void;
  const received = new Promise<void>((resolve) => { ready = resolve; });
  const server = await fixture(async (request, response, base) => {
    posts++; await body(request);
    if (request.url === '/cancel') { ready(); return; }
    if (request.url === '/redirect') { response.writeHead(307, { location: base + '/unexpected' }); response.end(); return; }
    if (request.url === '/truncated') { response.writeHead(200, { 'content-length': '100' }); response.write('short'); setTimeout(() => response.destroy(), 5); return; }
    response.writeHead(200); response.write('waiting');
  });
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  try {
    const controller = new AbortController();
    const pending = speechFetch(server.base + '/cancel', { ...init, signal: controller.signal }, 1000, 'node');
    const rejected = assert.rejects(pending, /取消或超时/);
    await received; controller.abort(); await rejected;
    assert.equal((await speechFetch(server.base + '/redirect', init, 1000, 'node')).status, 307);
    await assert.rejects(speechFetch(server.base + '/truncated', init, 1000, 'node'), (error) => {
      assert.ok(error instanceof SpeechNetworkError);
      assert.equal(error.connection?.phase, 'response');
      assert.equal(error.connection?.responseStarted, true);
      return true;
    });
    await assert.rejects(speechFetch(server.base + '/slow-body', init, 200, 'node'), /取消或超时/);
    assert.equal(posts, 4);
  } finally { await server.close(); }
});

test('AMC-AUDIOGEN AT10: a reset during TLS handshake is distinguished without leaking the request body', async () => {
  let connections = 0;
  const server = createTcpServer((socket) => { connections++; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    await assert.rejects(speechFetch('https://127.0.0.1:' + address.port + '/submit?signature=PRIVATE', { method: 'POST', headers: { authorization: 'Bearer PRIVATE-KEY' }, body: 'PRIVATE-LYRICS' }, 1000, 'node'), (error) => {
      assert.ok(error instanceof SpeechNetworkError);
      assert.equal(error.connection?.phase, 'tls');
      assert.equal(error.connection?.requestFinished, false);
      assert.equal(error.connection?.responseStarted, false);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.equal(connections, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
