/** Compatibility facade. New code should import the capability-specific settings module. */
import { publicVoiceInputSettings, readVoiceInputSettings, resolveAsrKey as resolveInputKey, saveVoiceInputSettings } from './asr-settings.js';
import { publicRealtimeConversationSettings, readRealtimeConversationSettings, saveRealtimeConversationSettings } from './realtime-settings.js';
import { readVoicePreferences, saveVoicePreferences } from './voice-preferences.js';

export { DEFAULT_REALTIME_VOICE_ID, DEFAULT_REALTIME_VOICE_INSTRUCTIONS, DEFAULT_REALTIME_VOICE_MODEL } from './realtime-settings.js';
export function resolveAsrKey(_value?: unknown) { return resolveInputKey(readVoiceInputSettings()); }

export function readRealtimeVoiceSettings() {
  const realtime = readRealtimeConversationSettings(); const asr = readVoiceInputSettings(); const preferences = readVoicePreferences();
  return { ...realtime, voiceMode: preferences.defaultMode, asrEnabled: asr.enabled, asrReuseKey: asr.reuseRealtimeKey, asrApiKey: asr.apiKey, asrResourceId: asr.resourceId, asrEnablePunc: asr.enablePunc, asrEnableItn: asr.enableItn };
}
export function publicRealtimeVoiceSettings(_value?: unknown) {
  const realtime = publicRealtimeConversationSettings(); const asr = publicVoiceInputSettings(); const preferences = readVoicePreferences();
  return { ...realtime, voiceMode: preferences.defaultMode, asrEnabled: asr.enabled, asrReuseKey: asr.reuseRealtimeKey, asrResourceId: asr.resourceId, asrEnablePunc: asr.enablePunc, asrEnableItn: asr.enableItn, asrConfigured: asr.configured, asrApiKeyMasked: asr.apiKeyMasked, asrKeySource: asr.keySource };
}
export function saveRealtimeVoiceSettings(input: Record<string, unknown>) {
  saveRealtimeConversationSettings(input);
  saveVoiceInputSettings({ enabled: input.asrEnabled, reuseRealtimeKey: input.asrReuseKey, apiKey: input.asrApiKey, clearApiKey: input.clearAsrApiKey, resourceId: input.asrResourceId, enablePunc: input.asrEnablePunc, enableItn: input.asrEnableItn });
  if (input.voiceMode !== undefined) saveVoicePreferences({ defaultMode: input.voiceMode });
  return readRealtimeVoiceSettings();
}
