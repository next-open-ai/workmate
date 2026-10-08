<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { VoiceWorkNoticeSchema, VoiceWorkResultSchema, type VoiceWorkResult } from '@workmate/contracts';
import {
  closeRealtimeVoiceSession,
  commitRealtimeVoiceAudio,
  consumeRealtimeVoiceEvents,
  createRealtimeVoiceSession,
  realtimeVoiceCapabilities,
  REALTIME_AUDIO_BATCH_BYTES,
  REALTIME_AUDIO_PUMP_INTERVAL_MS,
  sendRealtimeVoiceAudio,
  setRealtimeVoiceAudioMuted,
  RealtimeVoiceUsageSchema,
  type RealtimeVoiceUsage,
  type RealtimeVoiceEvent,
} from '../../services/realtime-voice';
import VoiceControlBar from './VoiceControlBar.vue';
import { hasRealtimeVoiceActivity, mergeVoiceCaption, voiceEnvelope, type VoiceCaption } from './voice-presentation';
import { claimVoiceTaskNotice, VoiceNoticePlayer } from '../../services/voice-task-notices';

const emit = defineEmits<{ close: []; 'open-work': [conversationId: string, title: string]; 'work-updated': [result: VoiceWorkResult]; captions: [caption: VoiceCaption] }>();
const props = withDefaults(defineProps<{ title?: string; subtitle?: string; conversationId?: string; inline?: boolean; autoStart?: boolean; captionHistory?: VoiceCaption[] }>(), {
  title: '实时语音',
  subtitle: '端到端全双工 · 系统回声消除',
  inline: false, autoStart: false,
});
const state = ref<'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'>('idle');
const error = ref('');
const muted = ref(false);
const elapsed = ref(0);
const usage = ref<RealtimeVoiceUsage | null>(null);
const runtimeProvider = ref('');
const runtimeModel = ref('');
const question = ref('');
const answer = ref('');
const captionId = ref(crypto.randomUUID());
const localCaptions = ref<VoiceCaption[]>([]);
const inputLevels = ref<number[]>([]); const outputLevels = ref<number[]>([]);
const playingAudio = computed(() => outputLevels.value.some(level => level > 0.01));
const usageLabel = computed(() => {
  const value = usage.value;
  if (!value) return runtimeProvider.value ? `${runtimeProvider.value}${runtimeModel.value ? ` · ${runtimeModel.value}` : ''}` : '';
  if (value.source === 'upstream') {
    const tokens = value.totalTokens ?? (value.inputTokens || 0) + (value.outputTokens || 0);
    if (tokens) return `${runtimeProvider.value || value.provider} · ${tokens.toLocaleString()} Token`;
    if (value.characters) return `${runtimeProvider.value || value.provider} · ${value.characters.toLocaleString()} 字符`;
  }
  const audioSeconds = Math.round((value.inputAudioMs + value.outputAudioMs) / 1000);
  return `${runtimeProvider.value || value.provider} · 音频 ${audioSeconds} 秒${value.source === 'local' ? '（本地计时）' : ''}`;
});
const runtimeSubtitle = computed(() => runtimeProvider.value
  ? `${runtimeProvider.value}${runtimeModel.value ? ` · ${runtimeModel.value}` : ''}`
  : props.subtitle);
watch([question, answer], () => {
  if (props.inline && (question.value || answer.value)) {
    const caption = { id: captionId.value, question: question.value, answer: answer.value };
    localCaptions.value = mergeVoiceCaption(localCaptions.value, caption);
    emit('captions', caption);
  }
});
const sessionId = ref('');
const workResults = ref<VoiceWorkResult[]>([]);
const workError = ref('');
const workNoticePlayer = new VoiceNoticePlayer(() => { workError.value = '工作已完成，请查看关联对话。'; });
async function openWork(result: VoiceWorkResult) {
  if (!result.conversationId) return;
  await cleanup(); emit('open-work', result.conversationId, result.title || '语音工作'); emit('close');
}
let startedAt = 0;
let clock: number | undefined;
let audioTimer: number | undefined;
let eventController: AbortController | undefined;
let stream: MediaStream | undefined;
let captureContext: AudioContext | undefined;
let captureSource: MediaStreamAudioSourceNode | undefined;
let captureNode: ScriptProcessorNode | undefined;
let chunks: Uint8Array[] = [];
let bufferedBytes = 0;
let sendingAudio = false;
let playbackContext: AudioContext | undefined;
let nextPlayTime = 0;
let generation = 0;
let outputAnalyser: AnalyserNode | undefined;
let outputFrame: number | undefined;
let upstreamMuted = false;
let desiredUpstreamMuted = false;
let silentSince = 0;
let upstreamTurnOpen = false;
let turnCommitPending = false;
let turnCommitSent = false;
function sampleOutput() {
  if (!outputAnalyser || !playbackContext || playbackContext.state === 'closed') return;
  const samples = new Float32Array(outputAnalyser.fftSize);
  outputAnalyser.getFloatTimeDomainData(samples); outputLevels.value = voiceEnvelope(samples);
  outputFrame = requestAnimationFrame(sampleOutput);
}
function stopOutputMeter() { if (outputFrame !== undefined) cancelAnimationFrame(outputFrame); outputFrame = undefined; outputAnalyser = undefined; outputLevels.value = []; }

function label() {
  return ({ idle: '准备通话', connecting: '正在连接', listening: muted.value ? '麦克风已关闭' : '正在听', thinking: '正在思考', speaking: '正在回复', error: '连接失败' } as const)[state.value];
}

function formatTime() {
  const seconds = Math.max(0, Math.floor(elapsed.value / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function downsample(input: Float32Array, inputRate: number) {
  const ratio = inputRate / 16000;
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const start = Math.floor(i * ratio); const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(output.buffer);
}

function append(bytes: Uint8Array) { chunks.push(bytes.slice()); bufferedBytes += bytes.length; }
function takeFrame(frameBytes: number) {
  if (bufferedBytes < frameBytes) return null;
  const frame = new Uint8Array(frameBytes); let offset = 0;
  while (offset < frameBytes && chunks.length) {
    const chunk = chunks[0]; const take = Math.min(frameBytes - offset, chunk.length);
    frame.set(chunk.subarray(0, take), offset); offset += take; bufferedBytes -= take;
    if (take === chunk.length) chunks.shift(); else chunks[0] = chunk.subarray(take);
  }
  return frame;
}

function pump() {
  if (!sessionId.value || sendingAudio) return;
  const activeSessionId = sessionId.value;
  if (turnCommitPending) {
    turnCommitPending = false;
    sendingAudio = true;
    void commitRealtimeVoiceAudio(activeSessionId)
      .then(() => {
        if (sessionId.value !== activeSessionId) return;
        turnCommitSent = true;
        desiredUpstreamMuted = true;
      })
      .catch((cause) => { if (sessionId.value === activeSessionId) void fail(cause); })
      .finally(() => { sendingAudio = false; });
    return;
  }
  if (upstreamMuted !== desiredUpstreamMuted) {
    const target = desiredUpstreamMuted;
    sendingAudio = true;
    void setRealtimeVoiceAudioMuted(activeSessionId, target)
      .then(() => { if (sessionId.value === activeSessionId) upstreamMuted = target; })
      .catch((cause) => { if (sessionId.value === activeSessionId) void fail(cause); })
      .finally(() => { sendingAudio = false; });
    return;
  }
  if (upstreamMuted) return;
  const frame = takeFrame(REALTIME_AUDIO_BATCH_BYTES);
  if (!frame) return;
  sendingAudio = true;
  void sendRealtimeVoiceAudio(activeSessionId, frame)
    .catch((cause) => { if (sessionId.value === activeSessionId) void fail(cause); })
    .finally(() => { sendingAudio = false; });
}

async function playPcm(base64: string) {
  const raw = atob(base64); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  if (!playbackContext || playbackContext.state === 'closed') {
    stopOutputMeter(); playbackContext = new AudioContext({ sampleRate: 24000 });
    outputAnalyser = playbackContext.createAnalyser(); outputAnalyser.fftSize = 1024; outputAnalyser.connect(playbackContext.destination); sampleOutput();
  }
  if (playbackContext.state === 'suspended') await playbackContext.resume();
  const samples = Math.floor(bytes.length / 2); const buffer = playbackContext.createBuffer(1, samples, 24000);
  const channel = buffer.getChannelData(0); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;
  const source = playbackContext.createBufferSource(); source.buffer = buffer; source.connect(outputAnalyser!);
  const at = Math.max(nextPlayTime, playbackContext.currentTime + 0.01); source.start(at); nextPlayTime = at + buffer.duration;
}

function text(event: Record<string, unknown>) { return String(event.text || event.delta || event.transcript || event.content || ''); }
function upstreamError(event: Record<string, unknown>) {
  const nested = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : {};
  const detail = String(nested.message || event.message || nested.code || event.code || '').trim();
  const provider = runtimeProvider.value || '实时语音服务';
  return detail ? `${provider}返回错误：${detail.slice(0, 300)}` : `${provider}返回错误。`;
}
function handleEvent(message: RealtimeVoiceEvent) {
  if (message.type === 'local.usage') {
    const parsed = RealtimeVoiceUsageSchema.safeParse(message.usage);
    if (parsed.success) usage.value = parsed.data;
    return;
  }
  if (message.type === 'local.work_notice') {
    const parsed = VoiceWorkNoticeSchema.safeParse(message.notice);
    if (parsed.success && claimVoiceTaskNotice(parsed.data.taskId, parsed.data.type) && parsed.data.delivery !== 'provider') {
      workNoticePlayer.enqueue('completed');
    }
    return;
  }
  if (message.type === 'local.work_result') {
    const parsed = VoiceWorkResultSchema.safeParse(message.result);
    if (parsed.success && !parsed.data.ok) workError.value = parsed.data.spokenSummary;
    else if (parsed.success) workError.value = '';
    if (parsed.success && parsed.data.taskId) {
      workResults.value = [parsed.data, ...workResults.value.filter((item) => item.taskId !== parsed.data.taskId)].slice(0, 10);
      if (parsed.data.conversationId) emit('work-updated', parsed.data);
    }
    return;
  }
  if (message.type === 'local.connected') state.value = 'listening';
  if (message.type === 'local.error') void fail(message.message || '实时语音服务连接失败。');
  if (message.type !== 'upstream.event') return;
  const event = message.event || {}; const type = String(event.type || '');
  if (type === 'conversation.item.input_audio_transcription.started') {
    captionId.value = crypto.randomUUID(); question.value = ''; answer.value = ''; state.value = 'listening';
    upstreamTurnOpen = true; turnCommitPending = false; turnCommitSent = false;
  }
  if (type === 'conversation.item.input_audio_transcription.delta' || type === 'conversation.item.input_audio_transcription.completed') question.value = text(event);
  if (type === 'conversation.item.input_audio_transcription.completed') {
    upstreamTurnOpen = false; turnCommitPending = false; state.value = 'thinking';
  }
  if (type === 'response.output_text.delta' || type === 'response.text.delta' || type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') {
    answer.value += text(event); state.value = 'speaking';
  }
  if ((type === 'response.output_text.done' || type === 'response.text.done' || type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') && text(event)) answer.value = text(event);
  if (type === 'response.output_audio.started' || type === 'response.audio.started') { stopOutputMeter(); void playbackContext?.close(); playbackContext = undefined; nextPlayTime = 0; state.value = 'speaking'; }
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') void playPcm(String(event.audio || event.delta || '')).catch(fail);
  if (type === 'response.output_audio.done' || type === 'response.audio.done' || type === 'response.done') state.value = 'listening';
  if (type === 'error') void fail(upstreamError(event));
}

async function startCapture(token: number) {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (token !== generation) { mic.getTracks().forEach(track => track.stop()); return; }
  stream = mic;
  captureContext = new AudioContext(); captureSource = captureContext.createMediaStreamSource(stream);
  captureNode = captureContext.createScriptProcessor(2048, 1, 1);
  captureNode.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0); inputLevels.value = voiceEnvelope(samples);
    const pcm = downsample(samples, captureContext!.sampleRate);
    if (muted.value) { desiredUpstreamMuted = true; chunks = []; bufferedBytes = 0; return; }
    let power = 0; for (const sample of samples) power += sample * sample;
    const level = Math.sqrt(power / Math.max(1, samples.length));
    const now = performance.now();
    if (hasRealtimeVoiceActivity(level)) {
      silentSince = 0; desiredUpstreamMuted = false; turnCommitPending = false; turnCommitSent = false; append(pcm);
      // Bound the short pre-roll collected while the unmute event is in flight.
      if (bufferedBytes > 32_000) { chunks = chunks.slice(-8); bufferedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0); }
      return;
    }
    if (!silentSince) silentSince = now;
    if (now - silentSince >= 5000) {
      if (upstreamTurnOpen && !turnCommitSent && !turnCommitPending) turnCommitPending = true;
      else if (!upstreamTurnOpen || turnCommitSent) desiredUpstreamMuted = true;
      chunks = []; bufferedBytes = 0; return;
    }
    append(pcm);
  };
  captureSource.connect(captureNode); captureNode.connect(captureContext.destination);
  audioTimer = window.setInterval(pump, REALTIME_AUDIO_PUMP_INTERVAL_MS);
}

async function start() {
  if (state.value !== 'idle' && state.value !== 'error') return;
  const token = ++generation; workNoticePlayer.unlock();
  state.value = 'connecting'; error.value = ''; workError.value = '';
  try {
    const capabilities = await realtimeVoiceCapabilities();
    if (token !== generation) return;
    if (!capabilities.realtime?.enabled) throw new Error('实时语音服务尚未启用。');
    const created = await createRealtimeVoiceSession({ conversationId: props.conversationId });
    if (token !== generation) { if (created.sessionId) await closeRealtimeVoiceSession(created.sessionId); return; }
    if (!created.sessionId) throw new Error('实时语音服务未返回会话 ID。');
    captionId.value = crypto.randomUUID(); question.value = ''; answer.value = ''; muted.value = false; elapsed.value = 0; usage.value = null;
    runtimeProvider.value = created.providerName || created.provider; runtimeModel.value = created.model;
    sessionId.value = created.sessionId; eventController = new AbortController(); const activeController = eventController;
    void consumeRealtimeVoiceEvents(sessionId.value, activeController.signal, event => {
      if (!activeController.signal.aborted && token === generation) handleEvent(event);
    }).catch((cause) => { if (!activeController.signal.aborted && token === generation) void fail(cause); });
    await startCapture(token); if (token !== generation) return;
    startedAt = Date.now(); clock = window.setInterval(() => { elapsed.value = Date.now() - startedAt; }, 1000);
  } catch (cause) { if (token === generation) await fail(cause); }
}

async function cleanup(closeRemote = true) {
  generation++; stopOutputMeter(); inputLevels.value = []; workNoticePlayer.stop();
  window.clearInterval(audioTimer); window.clearInterval(clock); audioTimer = undefined; clock = undefined;
  captureNode?.disconnect(); captureSource?.disconnect(); stream?.getTracks().forEach((track) => track.stop());
  await captureContext?.close().catch(() => undefined); await playbackContext?.close().catch(() => undefined);
  captureNode = undefined; captureSource = undefined; captureContext = undefined; playbackContext = undefined; stream = undefined;
  eventController?.abort(); eventController = undefined; chunks = []; bufferedBytes = 0; upstreamMuted = false; desiredUpstreamMuted = false; silentSince = 0;
  upstreamTurnOpen = false; turnCommitPending = false; turnCommitSent = false;
  sendingAudio = false;
  const closing = sessionId.value; sessionId.value = '';
  if (closeRemote && closing) await closeRealtimeVoiceSession(closing).catch(() => undefined);
}

async function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : String(cause); state.value = 'error'; await cleanup(); }
async function finish() {
  localCaptions.value = []; question.value = ''; answer.value = '';
  await cleanup(); emit('close');
}
function toggleMute() {
  muted.value = !muted.value; desiredUpstreamMuted = muted.value; silentSince = 0; chunks = []; bufferedBytes = 0; inputLevels.value = [];
  stream?.getAudioTracks().forEach(track => { track.enabled = !muted.value; });
}

onBeforeUnmount(() => { void cleanup(); });
onMounted(() => { if (props.autoStart) void start(); });
</script>

<template>
  <div v-if="inline" class="voice-inline-root">
    <VoiceControlBar mode="realtime" :captions="captionHistory ?? localCaptions" :status="playingAudio ? '正在回复' : label()" :seconds="Math.floor(elapsed / 1000)" :levels="playingAudio ? outputLevels : inputLevels" :usage="usageLabel" :active="playingAudio || (!muted && state === 'listening')" :paused="muted" :can-start="state === 'idle' || state === 'error'" :can-pause="!!sessionId" :can-finish="!!sessionId" :error="error || workError" @start="start" @pause="toggleMute" @finish="finish" @close="finish" />
    <div v-if="workResults.length" class="mt-2 flex flex-wrap items-center gap-2 px-2 text-[11px] text-[var(--muted)]"><span>关联工作 · {{ workResults[0].spokenSummary }}</span><button type="button" class="shrink-0 text-[var(--accent)]" @click="openWork(workResults[0])">查看当前对话成果 ↗</button></div>
  </div>
  <div v-else class="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4 sm:items-center" @click.self="finish">
    <section class="w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-[var(--surface)] shadow-2xl">
      <header class="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <div><h2 class="text-base font-bold">{{ title }}</h2><p class="text-xs text-[var(--muted)]">{{ runtimeSubtitle }}</p></div>
        <button class="rounded-lg px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" @click="finish">关闭</button>
      </header>
      <div class="bg-[radial-gradient(circle_at_top,var(--accent-soft),transparent_58%)] px-6 py-8 text-center">
        <div :class="['mx-auto grid h-24 w-24 place-items-center rounded-full border-4 text-3xl transition', state === 'speaking' ? 'animate-pulse border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-[var(--surface)]']">◉</div>
        <p class="mt-4 text-lg font-bold">{{ label() }}</p><p class="mt-1 font-mono text-xs text-[var(--muted)]">{{ formatTime() }}</p>
        <p v-if="usageLabel" class="mt-2 text-[11px] text-[var(--muted)]">{{ usageLabel }}</p>
        <p v-if="error" class="mx-auto mt-4 max-w-md rounded-xl bg-rose-500/10 px-3 py-2 text-left text-xs leading-5 text-rose-700">{{ error }}</p>
        <p v-if="workError" role="alert" class="mt-4 rounded-xl bg-amber-500/10 px-3 py-2 text-left text-xs">工作调用未成功：{{ workError }}（通话可继续）</p>
        <div v-if="workResults.length" class="mt-4 max-h-48 space-y-2 overflow-y-auto text-left">
          <article v-for="work in workResults" :key="work.taskId" class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
            <strong class="block">{{ work.title }}</strong><p class="mt-1 text-[var(--muted)]">{{ work.spokenSummary }}</p>
            <button type="button" class="mt-2 text-[var(--accent)]" @click="openWork(work)">结束通话并查看工作</button>
          </article>
        </div>
        <div v-if="question || answer" class="mt-6 space-y-3 text-left">
          <div v-if="question" class="rounded-2xl bg-[var(--surface-muted)] px-4 py-3 text-sm"><small class="text-[var(--muted)]">你</small><p class="mt-1">{{ question }}</p></div>
          <div v-if="answer" class="rounded-2xl bg-[var(--accent-soft)] px-4 py-3 text-sm"><small class="text-[var(--accent)]">Workmate</small><p class="mt-1 whitespace-pre-wrap">{{ answer }}</p></div>
        </div>
      </div>
      <footer class="flex justify-center gap-3 border-t border-[var(--border)] px-6 py-5">
        <button v-if="state === 'idle' || state === 'error'" class="rounded-xl bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-white" type="button" @click="start">开始通话</button>
        <template v-else>
          <button class="rounded-xl border border-[var(--border)] px-5 py-2.5 text-sm font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="toggleMute">{{ muted ? '打开麦克风' : '关闭麦克风' }}</button>
          <button class="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-bold text-white" type="button" @click="finish">结束通话</button>
        </template>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.voice-inline-root{box-sizing:border-box;width:100%;max-width:100%;min-width:0;overflow:hidden}
</style>
