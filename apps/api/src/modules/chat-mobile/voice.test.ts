import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import Fastify from 'fastify';
import { mobilePublicOrigin, mobileVoiceEvent, registerMobileVoice, type MobileVoiceLink } from './voice.js';
import { mobileVoiceScript } from './voice-ui.js';

test('MV-R1: QR ownership, binding, input, duplicate, capacity and lifetime', async () => {
  const app = Fastify();
  const links = new Map<string, MobileVoiceLink>([['one', { sessionId: 'chat', orgId: 'org', ownerUserId: 'user', expiresAt: Date.now() + 60_000 }]]);
  links.set('two', { ...links.get('one')! });
  const closed: string[] = []; const uploads: string[] = []; const commits: string[] = []; let seq = 0; let allowed = true;
  const emits = new Map<string, (event: { type: string; [key: string]: unknown }) => void>();
  await registerMobileVoice(app, {
    resolve: async token => links.get(token) || null, authorized: async () => allowed,
    capabilities: () => ({ enabled: true, workEnabled: true }),
    create: async link => {
      assert.equal(link.sessionId, 'chat'); const id = String(++seq);
      return { id, sendAudio: async audio => { uploads.push(audio); }, commitAudio: async () => { commits.push(id); }, setAudioMuted: async muted => { commits.push(`${id}:${muted ? 'mute' : 'unmute'}`); }, subscribe: listener => { emits.set(id, listener); listener({ type: 'local.connected' }); return () => { emits.delete(id); }; } };
    }, release: id => { closed.push(id); },
  });
  const post = (token: string, operation: string, payload = {}) => app.inject({ method: 'POST', url: `/chat-mobile/${token}/voice/${operation}`, payload });
  try {
    assert.equal((await post('expired', 'session')).statusCode, 410);
    assert.equal((await post('one', 'session', { conversationId: 'other', apiKey: 'secret' })).statusCode, 400);
    const first = await post('one', 'session'); assert.equal(first.statusCode, 200); const id = first.json().session_id;
    assert.equal((await post('one', 'session')).statusCode, 429);
    assert.equal((await post('two', `${id}/audio`, { audio: 'AAA=' })).statusCode, 404);
    assert.equal((await post('two', `${id}/close`)).statusCode, 404);
    for (const audio of ['!!!!', 'AAAA', 'A', 'AAAA====', 'AA==', 'A'.repeat(12804)]) assert.equal((await post('one', `${id}/audio`, { audio })).statusCode, 400, audio.slice(0, 12));
    assert.equal((await post('one', `${id}/audio`, { audio: 'AAA=' })).statusCode, 200); assert.deepEqual(uploads, ['AAA=']);
    const batch = Buffer.alloc(9600).toString('base64');
    assert.equal((await post('one', `${id}/audio`, { audio: batch })).statusCode, 200);
    assert.equal((await post('one', `${id}/commit`)).statusCode, 200); assert.deepEqual(commits, [id]);
    assert.equal((await post('one', `${id}/mute`, { muted: true })).statusCode, 200);
    assert.equal((await post('one', `${id}/mute`, { muted: false })).statusCode, 200);
    assert.deepEqual(commits, [id, `${id}:mute`, `${id}:unmute`]);
    links.set('one', { ...links.get('one')!, sessionId: 'changed' });
    assert.equal((await post('one', `${id}/audio`, { audio: 'AAA=' })).statusCode, 404); assert.deepEqual(closed, [id]);
    links.set('one', { ...links.get('one')!, sessionId: 'chat' });
    const second = (await post('one', 'session')).json().session_id;
    allowed = false; assert.equal((await post('one', `${second}/audio`, { audio: 'AAA=' })).statusCode, 404); allowed = true;
    assert.ok(closed.includes(second));
    const third = (await post('one', 'session')).json().session_id;
    links.set('one', { ...links.get('one')!, expiresAt: Date.now() - 1 });
    assert.equal((await post('one', `${third}/audio`, { audio: 'AAA=' })).statusCode, 410); assert.ok(closed.includes(third));
    links.set('one', { ...links.get('two')! });
    const fourth = (await post('one', 'session')).json().session_id;
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${base}/chat-mobile/one/voice/${fourth}/events`, { signal: controller.signal });
    assert.match(response.headers.get('content-type')!, /event-stream/);
    const reader = response.body!.getReader(); let received = '';
    while (!received.includes('local.connected')) { const chunk = await reader.read(); received += new TextDecoder().decode(chunk.value); }
    emits.get(fourth)!({ type: 'local.session_create', event: { secret: 'private prompt' } });
    emits.get(fourth)!({ type: 'upstream.event', event: { type: 'response.output_text.delta', delta: 'hello', secret: 'hidden' } });
    while (!received.includes('hello')) { const chunk = await reader.read(); received += new TextDecoder().decode(chunk.value); }
    assert.ok(!received.includes('private prompt')); assert.ok(!received.includes('hidden'));
    controller.abort(); await new Promise(resolve => setTimeout(resolve, 30)); assert.ok(!closed.includes(fourth), 'transient SSE disconnect keeps upstream alive');
    const reconnected = await fetch(`${base}/chat-mobile/one/voice/${fourth}/events`);
    assert.match(reconnected.headers.get('content-type')!, /event-stream/);
    assert.equal((await post('one', `${fourth}/close`)).statusCode, 200);
    await reconnected.body?.cancel();
    assert.ok(closed.includes(fourth), 'explicit close releases upstream');
    assert.equal((await post('one', `${fourth}/audio`, { audio: 'AAA=' })).statusCode, 404);
    for (let i = 0; i < 20; i++) { links.set('cap' + i, { ...links.get('two')! }); assert.equal((await post('cap' + i, 'session')).statusCode, 200); }
    links.set('overflow', { ...links.get('two')! }); assert.equal((await post('overflow', 'session')).statusCode, 429);
  } finally { await app.close(); }
  assert.equal(closed.length, seq);
});

test('MV-R2: origin validation, event privacy and executable browser script', () => {
  assert.equal(mobilePublicOrigin(undefined), null);
  assert.equal(mobilePublicOrigin('https://mobile.example.com/'), 'https://mobile.example.com');
  for (const origin of ['http://example.com', 'https://u:p@example.com', 'https://example.com/api', 'https://example.com?token=a']) assert.throws(() => mobilePublicOrigin(origin));
  assert.equal(mobileVoiceEvent({ type: 'upstream.event', event: { type: 'response.function_call_arguments.done', arguments: 'secret' } }), null);
  assert.equal(mobileVoiceEvent({ type: 'local.session_create', event: { instructions: 'secret' } }), null);
  assert.equal(JSON.stringify(mobileVoiceEvent({ type: 'local.error', message: 'key=secret' })).includes('secret'), false);
  assert.match(mobileVoiceScript, /reconnectTimer/);
  assert.match(mobileVoiceScript, /audioFailures>=3/);
  assert.match(mobileVoiceScript, /const size=3200/);
  assert.match(mobileVoiceScript, /queueAudio\(pcm\)/);
  assert.match(mobileVoiceScript, /desiredUpstreamMuted/);
  assert.match(mobileVoiceScript, /now-silentSince>=5000/);
  assert.match(mobileVoiceScript, /\/'\+id\+'\/mute/);
  assert.doesNotMatch(mobileVoiceScript, /turnCommitPending/);
  assert.doesNotMatch(mobileVoiceScript, /\/commit/);
  new vm.Script(mobileVoiceScript);
});

test('MV-R1: abandoned session TTL and revoked/rebound link cleanup', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const app = Fastify(); let link: MobileVoiceLink | null = { sessionId: 'chat', orgId: 'org', ownerUserId: 'user', expiresAt: now + 3_600_000 };
  let closed = 0; let sequence = 0;
  await registerMobileVoice(app, {
    resolve: async () => link, authorized: async () => true, capabilities: () => ({ enabled: true, workEnabled: true }),
    create: async () => ({ id: String(++sequence), sendAudio: async () => {}, commitAudio: async () => {}, setAudioMuted: async () => {}, subscribe: () => () => {} }), release: () => { closed++; },
  });
  const create = () => app.inject({ method: 'POST', url: '/chat-mobile/token/voice/session', payload: {} });
  try {
    assert.equal((await create()).statusCode, 200);
    t.mock.timers.tick(31_000); await Promise.resolve(); assert.equal(closed, 1);
    assert.equal((await create()).statusCode, 200);
    link = { ...link!, sessionId: 'different' }; t.mock.timers.tick(5_000);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 2);
    assert.equal((await create()).statusCode, 200);
    link = null; t.mock.timers.tick(5_000);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 3);
  } finally { await app.close(); t.mock.timers.reset(); }
});
