import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicVoiceInputSettings, readVoiceInputSettings, saveVoiceInputSettings } from './asr-settings.js';
import { publicRealtimeConversationSettings, readRealtimeConversationSettings, saveRealtimeConversationSettings } from './realtime-settings.js';
import { readVoicePreferences } from './voice-preferences.js';

test('VSM-R1/R2: legacy settings migrate into independent capability stores', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-voice-modules-'));
  const previous = process.env.WORKMATE_DATA_DIR; process.env.WORKMATE_DATA_DIR = root;
  try {
    fs.writeFileSync(path.join(root, 'voice-realtime-settings.json'), JSON.stringify({ enabled: true, apiKey: 'realtime-secret', voiceMode: 'input', asrEnabled: true, asrReuseKey: false, asrApiKey: 'asr-secret', asrResourceId: 'volc.bigasr.sauc.duration', model: 'legacy-model' }));
    assert.equal(readRealtimeConversationSettings().model, 'legacy-model');
    assert.equal(readVoiceInputSettings().resourceId, 'volc.bigasr.sauc.duration');
    assert.equal(readVoicePreferences().defaultMode, 'input');
    for (const name of ['voice-realtime-settings.v2.json', 'voice-input-settings.json', 'voice-preferences.json']) assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o600);

    saveVoiceInputSettings({ enabled: false, apiKey: 'new-asr-secret', reuseRealtimeKey: false });
    assert.equal(readRealtimeConversationSettings().enabled, true);
    assert.equal(publicRealtimeConversationSettings().apiKeyMasked, '••••••••cret');
    saveRealtimeConversationSettings({ enabled: false, apiKey: 'new-realtime-secret' });
    assert.equal(readVoiceInputSettings().enabled, false);
    assert.equal(publicVoiceInputSettings().apiKeyMasked, '••••••••cret');
  } finally {
    if (previous === undefined) delete process.env.WORKMATE_DATA_DIR; else process.env.WORKMATE_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
