import { readRealtimeVoiceSettings as readLegacySettings } from './legacy-settings.js';
import { readSettingsFile, writeSettingsFile } from './settings-files.js';

export const DEFAULT_REALTIME_VOICE_MODEL = '1.2.6.1';
export const DEFAULT_REALTIME_VOICE_ID = 'zh_female_vv_jupiter_bigtts';
export const DEFAULT_REALTIME_VOICE_INSTRUCTIONS = '你是 Workmate 的实时语音助手。使用简洁自然的中文交流，不要声称执行了尚未执行的业务操作。';
export type RealtimeConversationSettings = {
  enabled: boolean; workLinkEnabled: boolean; audioGateEnabled: boolean; apiKey: string;
  model: string; voice: string; instructions: string; enableProactiveSpeak: boolean;
  dialogId: string; speed: number; loudness: number; enableMusic: boolean;
  clonedVoices: Array<{ id: string; status: number | null; statusName: string; updatedAt: number }>;
};
const FILE = 'voice-realtime-settings.v2.json';
function normalize(raw: Partial<RealtimeConversationSettings>): RealtimeConversationSettings {
  return {
    enabled: raw.enabled !== false, workLinkEnabled: raw.workLinkEnabled === true,
    audioGateEnabled: false, apiKey: String(raw.apiKey || '').trim(),
    model: String(raw.model || DEFAULT_REALTIME_VOICE_MODEL).trim(), voice: String(raw.voice || DEFAULT_REALTIME_VOICE_ID).trim(),
    instructions: String(raw.instructions || DEFAULT_REALTIME_VOICE_INSTRUCTIONS).slice(0, 8_000),
    enableProactiveSpeak: Boolean(raw.enableProactiveSpeak), dialogId: String(raw.dialogId || '').trim().slice(0, 200),
    speed: Math.max(-50, Math.min(100, Number(raw.speed) || 0)), loudness: Math.max(-50, Math.min(100, Number(raw.loudness) || 0)),
    enableMusic: raw.enableMusic !== false,
    clonedVoices: Array.isArray(raw.clonedVoices) ? raw.clonedVoices.map(item => ({ id: String(item?.id || '').trim(), status: item?.status == null ? null : Number(item.status), statusName: String(item?.statusName || ''), updatedAt: Number(item?.updatedAt) || Date.now() })).filter(item => item.id).slice(0, 50) : [],
  };
}
export function readRealtimeConversationSettings() {
  const saved = readSettingsFile<RealtimeConversationSettings>(FILE);
  if (saved) return normalize(saved);
  return writeSettingsFile(FILE, normalize(readLegacySettings()));
}
export function saveRealtimeConversationSettings(input: Record<string, unknown>) {
  const current = readRealtimeConversationSettings();
  return writeSettingsFile(FILE, normalize({ ...current, ...input, apiKey: input.clearApiKey ? '' : String(input.apiKey || '').trim() || current.apiKey, clonedVoices: Array.isArray(input.clonedVoices) ? input.clonedVoices as RealtimeConversationSettings['clonedVoices'] : current.clonedVoices }));
}
export function resolveRealtimeKey(value = readRealtimeConversationSettings()) { return process.env.WORKMATE_VOLCENGINE_REALTIME_API_KEY?.trim() || value.apiKey; }
export function publicRealtimeConversationSettings(value = readRealtimeConversationSettings()) {
  const key = resolveRealtimeKey(value);
  return { ...value, apiKey: undefined, configured: Boolean(key), apiKeyMasked: key ? `••••••••${key.slice(-4)}` : '', apiKeySource: process.env.WORKMATE_VOLCENGINE_REALTIME_API_KEY?.trim() ? 'environment' : 'settings', audioGateEnabled: false };
}
