import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import { VoiceSessionCreateSchema } from '@workmate/contracts';
import { getOrchestrator } from '../orchestration/routes.js';
import { completionNotice, VoiceWorkBridge, VOICE_WORK_INSTRUCTIONS, VOICE_WORK_TOOLS } from './work-bridge.js';
import {
  DEFAULT_REALTIME_VOICE_ID,
  DEFAULT_REALTIME_VOICE_INSTRUCTIONS,
  DEFAULT_REALTIME_VOICE_MODEL,
  readRealtimeConversationSettings,
  resolveRealtimeKey,
} from './realtime-settings.js';
import { publicVoiceInputSettings } from './asr-settings.js';
import { readVoicePreferences } from './voice-preferences.js';

type VoiceEvent = { type: string; ts: number; event?: Record<string, unknown>; message?: string; [key: string]: unknown };
type Owner = { orgId: string; userId: string };

const UPSTREAM_URL = process.env.WORKMATE_VOLCENGINE_REALTIME_URL?.trim()
  || 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const MAX_SESSIONS = 20;
const SESSION_TTL_MS = 30 * 60 * 1000;
const VOICE_CLONE_TRAIN_URL = 'https://openspeech.bytedance.com/api/v3/tts/voice_clone';
const VOICE_CLONE_STATUS_URL = 'https://openspeech.bytedance.com/api/v3/tts/voice_clone/status';

export class VoiceCapacityError extends Error { readonly code = 'VOICE_CAPACITY'; }

export class RealtimeVoiceSession {
  readonly id = randomUUID().replaceAll('-', '');
  readonly createdAt = Date.now();
  readonly listeners = new Set<(event: VoiceEvent) => void>();
  readonly backlog: VoiceEvent[] = [];
  private socket: WebSocket | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private closed = false;
  private workBridge: VoiceWorkBridge | null = null;
  private workTasks = new Set<string>();
  private workTimer: ReturnType<typeof setInterval> | undefined;
  private pollingWork = false;
  private workStates = new Map<string, string>();

  constructor(readonly owner: Owner, private config: Record<string, unknown>, apiKey: string) {
    if (this.config.workLinkEnabled) {
      this.workBridge = new VoiceWorkBridge(getOrchestrator(), owner, () => Boolean(this.config.workLinkEnabled) && readRealtimeConversationSettings().workLinkEnabled, this.config.conversationId as string | undefined);
      this.workTimer = setInterval(() => { void this.pollWork(); }, 2_000);
      this.workTimer.unref();
    }
    this.readyPromise = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.readyPromise.catch(() => undefined);
    this.connect(apiKey);
  }

  private emit(event: Omit<VoiceEvent, 'ts'>) {
    const value = { ts: Date.now(), ...event } as VoiceEvent;
    if (!this.listeners.size) {
      this.backlog.push(value);
      if (this.backlog.length > 256) this.backlog.shift();
    }
    for (const listener of this.listeners) listener(value);
  }

  private connect(apiKey: string) {
    const socket = new WebSocket(UPSTREAM_URL, {
      headers: { 'X-Api-Key': apiKey, 'X-Api-Connect-Id': this.id },
      handshakeTimeout: 15_000,
    });
    this.socket = socket;
    socket.once('open', () => {
      this.emit({ type: 'local.connected', session_id: this.id, upstream: UPSTREAM_URL });
      const create = this.sessionCreatePayload();
      this.emit({ type: 'local.session_create', event: create });
      socket.send(JSON.stringify(create));
      this.resolveReady();
    });
    socket.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        this.emit({ type: 'upstream.event', event });
        if (event.type === 'response.function_call_arguments.done') void this.handleWorkCalls(event);
        if (event.type === 'session.closed' || event.type === 'error') this.close(false);
      } catch {
        this.emit({ type: 'local.error', message: '火山实时语音返回了无法解析的事件。' });
      }
    });
    socket.once('unexpected-response', (_request, response) => {
      const status = `HTTP ${response.statusCode} ${response.statusMessage || ''}`.trim();
      const error = new Error(`火山实时语音握手失败：${status}`);
      this.rejectReady(error); this.emit({ type: 'local.error', message: error.message, status });
    });
    socket.once('error', (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.rejectReady(error); this.emit({ type: 'local.error', message: `火山实时语音连接失败：${error.message}` });
    });
    socket.once('close', () => {
      clearInterval(this.workTimer);
      this.closed = true; this.emit({ type: 'local.closed' });
    });
  }

  private sessionCreatePayload() {
    const session: Record<string, unknown> = {
      model: String(this.config.model || DEFAULT_REALTIME_VOICE_MODEL),
      instructions: String(this.config.instructions || DEFAULT_REALTIME_VOICE_INSTRUCTIONS) + (this.config.workLinkEnabled ? VOICE_WORK_INSTRUCTIONS : ''),
      audio: {
        input: { format: { type: 'pcm', sample_rate: 16000 } },
        output: {
          format: { type: 'pcm_s16le', sample_rate: 24000 },
          voice: String(this.config.voice || DEFAULT_REALTIME_VOICE_ID),
          speed: Math.max(-50, Math.min(100, Number(this.config.speed) || 0)),
          loudness: Math.max(-50, Math.min(100, Number(this.config.loudness) || 0)),
        },
      },
      tools: this.config.workLinkEnabled ? VOICE_WORK_TOOLS : [],
    };
    if (this.config.dialogId) session.id = String(this.config.dialogId);
    const voice = String(this.config.voice || '');
    const enableMusic = Boolean(this.config.enableMusic) && !/^S[_-]/i.test(voice) && voice !== 'saturn_zh_female_aojiaonvyou_tob';
    return {
      type: 'session.create',
      session,
      extension: { extra: { enable_proactive_speak: Boolean(this.config.enableProactiveSpeak) }, dialog: { extra: { enable_music: enableMusic } } },
    };
  }

  private async handleWorkCalls(event: Record<string, unknown>) {
    const raw = event.items;
    const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
    const results: Record<string, unknown>[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>; const callId = String(row.call_id || '');
      const spec = row.function && typeof row.function === 'object' ? row.function as Record<string, unknown> : {};
      const name = String(row.name || spec.name || '');
      let result: unknown;
      try {
        if (!this.workBridge) throw new Error('工作能力关联已关闭。');
        const rawArgs = row.arguments ?? spec.arguments ?? '{}';
        const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
        result = await this.workBridge.call(callId, name, args);
        const value = result as Record<string, unknown>;
        if (value.taskId) this.workTasks.add(String(value.taskId));
        this.emit({ type: 'local.work_result', name, result });
      } catch (cause) {
        result = { ok: false, status: 'failed', spokenSummary: cause instanceof Error ? cause.message.slice(0, 240) : '工作调用失败。' };
        this.emit({ type: 'local.work_result', name, result });
      }
      if (callId) results.push({ call_id: callId, role: 'tool', content: [{ type: 'input_text', text: JSON.stringify(result) }] });
    }
    if (results.length && !this.closed) {
      await this.send({ type: 'conversation.item.create', items: results }).catch(() => undefined);
    }
  }

  private async pollWork() {
    if (this.pollingWork || !this.workBridge || this.closed) return;
    this.pollingWork = true;
    try {
      for (const taskId of this.workTasks) {
        try {
          const result = await this.workBridge.status(taskId);
          if (this.workStates.get(taskId) !== result.status) {
            this.workStates.set(taskId, result.status);
            this.emit({ type: 'local.work_result', result });
            const notice = completionNotice(result);
            if (notice) this.emit({ type: 'local.work_notice', notice });
          }
          if (['completed', 'failed', 'cancelled'].includes(result.status)) this.workTasks.delete(taskId);
        } catch { this.workTasks.delete(taskId); }
      }
    } finally { this.pollingWork = false; }
  }

  private async send(value: Record<string, unknown>) {
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('火山实时语音连接超时。')), 15_000)),
    ]);
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('实时语音会话已关闭。');
    this.socket.send(JSON.stringify(value));
  }

  sendAudio(audio: string) { return this.send({ type: 'input_audio_buffer.append', event_id: randomUUID().replaceAll('-', ''), audio }); }
  commitAudio() { return this.send({ type: 'input_audio_buffer.commit', event_id: randomUUID().replaceAll('-', '') }); }
  setAudioMuted(muted: boolean) { return this.send({ type: muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit', event_id: randomUUID().replaceAll('-', '') }); }
  sendText(text: string) { return this.send({ type: 'speech_text_buffer.commit', event_id: randomUUID().replaceAll('-', ''), text }); }
  update(input: Record<string, unknown>) {
    this.config = { ...this.config, ...input };
    return this.send({
      type: 'session.update',
      session: {
        model: String(this.config.model || DEFAULT_REALTIME_VOICE_MODEL),
        instructions: String(this.config.instructions || '') + (this.config.workLinkEnabled ? VOICE_WORK_INSTRUCTIONS : ''),
        audio: { output: { format: { type: 'pcm_s16le', sample_rate: 24000 }, voice: String(this.config.voice || DEFAULT_REALTIME_VOICE_ID), speed: 0, loudness: 0 } },
        tools: this.config.workLinkEnabled ? VOICE_WORK_TOOLS : [],
      },
    });
  }

  subscribe(listener: (event: VoiceEvent) => void) {
    this.listeners.add(listener);
    for (const event of this.backlog.splice(0)) listener(event);
    return () => this.listeners.delete(listener);
  }

  close(notifyUpstream = true) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.workTimer);
    if (notifyUpstream && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'session.close' }));
    const timer = setTimeout(() => this.socket?.close(), notifyUpstream ? 800 : 0);
    timer.unref();
  }
}

const sessions = new Map<string, RealtimeVoiceSession>();

function apiKey() {
  const value = resolveRealtimeKey();
  if (!value) throw new Error('尚未配置火山实时语音 API Key。请前往“设置 > 语音”完成配置。');
  return value;
}

function principal(request: FastifyRequest) {
  if (!request.auth) throw new Error('Authentication required.');
  return request.auth;
}

function ownedSession(request: FastifyRequest, sessionId: string) {
  const session = sessions.get(sessionId); const auth = principal(request);
  if (!session || session.owner.orgId !== auth.orgId || (session.owner.userId !== auth.userId && auth.role !== 'admin')) return null;
  return session;
}

function reapSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) { session.close(); sessions.delete(id); }
  }
}

/** Shared capacity/configuration; callers must authorize the conversation first. */
export async function createBoundRealtimeVoice(owner: Owner, conversationId: string): Promise<RealtimeVoiceSession> {
  const settings = readRealtimeConversationSettings();
  if (!settings.enabled) throw new Error('实时语音已在设置中关闭。');
  await new VoiceWorkBridge(getOrchestrator(), owner, () => settings.workLinkEnabled, conversationId).validateConversation();
  reapSessions();
  if (sessions.size >= MAX_SESSIONS) throw new VoiceCapacityError('实时语音会话已达到容量上限。');
  const session = new RealtimeVoiceSession(owner, {
    model: settings.model, voice: settings.voice, instructions: settings.instructions,
    enableProactiveSpeak: settings.enableProactiveSpeak, dialogId: '', speed: settings.speed,
    loudness: settings.loudness, enableMusic: settings.enableMusic, workLinkEnabled: settings.workLinkEnabled, conversationId,
  }, apiKey());
  sessions.set(session.id, session);
  return session;
}

export function releaseBoundRealtimeVoice(id: string): void {
  sessions.get(id)?.close();
  sessions.delete(id);
}

function body(request: FastifyRequest) {
  return (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
}

function failure(reply: FastifyReply, cause: unknown, status = 400) {
  return reply.code(status).send({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
}

async function postVolcengine(url: string, key: string, payload: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api-Key': key, 'X-Api-Request-Id': randomUUID().replaceAll('-', '') },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || Number(result.code || 0) !== 0) throw new Error(String(result.message || result.error || `声音复刻请求失败：HTTP ${response.status}`));
  return result;
}

function cloneStatusName(status: unknown) {
  return ({ 0: '未找到', 1: '训练中', 2: '可用', 3: '失败', 4: '已激活' } as Record<number, string>)[Number(status)] || '未知';
}

export async function registerRealtimeVoiceRoutes(app: FastifyInstance) {
  app.get('/voice/realtime/capabilities', async (_request, reply) => {
    const settings = readRealtimeConversationSettings();
    const configured = Boolean(process.env.WORKMATE_VOLCENGINE_REALTIME_API_KEY?.trim() || settings.apiKey);
    const enabled = configured && settings.enabled;
    const asr = publicVoiceInputSettings();
    // SeedDuplex expects a continuous real-time audio clock. The previous
    // client VAD sent bursty 100 ms frames and could double-commit a turn
    // already closed by server VAD, producing upstream errors and long waits.
    // Keep the persisted setting compatible with older installations, but do
    // not advertise the retired gate in the stable transport.
    const audioGateEnabled = false;
    return reply.send({ voiceMode: readVoicePreferences().defaultMode, realtime: { enabled, configured, audioGateEnabled, providers: enabled ? ['volcengine'] : [] }, asr: { enabled: asr.enabled && asr.configured, configured: asr.configured } });
  });

  app.post('/voice/realtime/session', async (request, reply) => {
    try {
      reapSessions();
      if (sessions.size >= MAX_SESSIONS) return failure(reply, new Error('实时语音会话已达到容量上限。'), 429);
      const auth = principal(request); const settings = readRealtimeConversationSettings();
      const input = VoiceSessionCreateSchema.parse(body(request));
      if (input.conversationId) await new VoiceWorkBridge(getOrchestrator(), { orgId: auth.orgId, userId: auth.userId }, () => settings.workLinkEnabled, input.conversationId).validateConversation();
      if (!settings.enabled) return failure(reply, new Error('实时语音已在设置中关闭。'));
      // Conversation validation awaits I/O; recheck shared capacity afterwards.
      reapSessions();
      if (sessions.size >= MAX_SESSIONS) return failure(reply, new Error('实时语音会话已达到容量上限。'), 429);
      const session = new RealtimeVoiceSession(
        { orgId: auth.orgId, userId: auth.userId },
        { model: settings.model, voice: settings.voice, instructions: settings.instructions, enableProactiveSpeak: settings.enableProactiveSpeak, dialogId: settings.dialogId, speed: settings.speed, loudness: settings.loudness, enableMusic: settings.enableMusic, workLinkEnabled: settings.workLinkEnabled, conversationId: input.conversationId },
        apiKey(),
      );
      sessions.set(session.id, session);
      return reply.send({ ok: true, session_id: session.id });
    } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/clone/train', async (request, reply) => {
    try {
      if (principal(request).role !== 'admin') return failure(reply, new Error('仅管理员可以训练复刻音色。'), 403);
      const input = body(request); const voiceId = String(input.voiceId || '').trim();
      if (!voiceId || /\s/.test(voiceId)) throw new Error('请填写有效的预付费音色槽位 ID。');
      const audio = input.audio && typeof input.audio === 'object' ? input.audio as Record<string, unknown> : {};
      const data = String(audio.data || '').replace(/\s/g, ''); const format = String(audio.format || '').toLowerCase();
      if (!['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'].includes(format) || !data) throw new Error('请选择 WAV、MP3、OGG、M4A、AAC 或 PCM 训练音频。');
      if (Buffer.byteLength(data, 'base64') > 10 * 1024 * 1024) throw new Error('训练音频不能超过 10 MB。');
      const extra: Record<string, unknown> = { enable_audio_denoise: Boolean(input.enableAudioDenoise), disable_volume_normalization: Boolean(input.keepOriginalVolume) };
      if (String(input.demoText || '').trim()) extra.demo_text = String(input.demoText).trim().slice(0, 300);
      const payload: Record<string, unknown> = { speaker_id: voiceId, audio: { data, format }, language: 0, extra_params: extra };
      if (String(input.text || '').trim()) payload.text = String(input.text).trim();
      const result = await postVolcengine(VOICE_CLONE_TRAIN_URL, apiKey(), payload);
      const response = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
      return reply.send({ ok: true, voice: { id: voiceId, status: response.status ?? null, statusName: cloneStatusName(response.status), updatedAt: Date.now() } });
    } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/clone/status', async (request, reply) => {
    try {
      if (principal(request).role !== 'admin') return failure(reply, new Error('仅管理员可以查询复刻音色。'), 403);
      const voiceId = String(body(request).voiceId || '').trim(); if (!voiceId || /\s/.test(voiceId)) throw new Error('请填写有效的音色 ID。');
      const result = await postVolcengine(VOICE_CLONE_STATUS_URL, apiKey(), { speaker_id: voiceId });
      const response = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
      return reply.send({ ok: true, voice: { id: voiceId, status: response.status ?? null, statusName: cloneStatusName(response.status), updatedAt: Date.now() } });
    } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/audio', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    const audio = String(input.audio || '');
    if (!audio || audio.length > 256_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return failure(reply, new Error('Invalid realtime audio chunk.'));
    try { await session.sendAudio(audio); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/audio_commit', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    try { await session.commitAudio(); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/audio_mute', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    if (typeof input.muted !== 'boolean') return failure(reply, new Error('muted must be boolean.'));
    try { await session.setAudioMuted(input.muted); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/text', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    const text = String(input.text || '').trim(); if (!text) return failure(reply, new Error('text is required.'));
    try { await session.sendText(text); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/session_update', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    try { await session.update({ voice: input.voice, instructions: input.instructions }); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/close', async (request, reply) => {
    const input = body(request); const id = String(input.session_id || ''); const session = ownedSession(request, id);
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    session.close(); sessions.delete(id); return reply.send({ ok: true });
  });

  app.get('/voice/realtime/events', async (request, reply) => {
    const id = String((request.query as { session_id?: string }).session_id || ''); const session = ownedSession(request, id);
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (event: VoiceEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = session.subscribe(write);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    // The SSE transport is only an event subscription. Browsers may close and
    // recreate it while the microphone upload is still active, so its lifetime
    // must not own the upstream voice session. Sessions are closed explicitly
    // through /close or by the TTL reaper.
    reply.raw.once('close', () => {
      clearInterval(heartbeat); unsubscribe();
    });
  });
}
