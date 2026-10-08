import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { 'work-bridge.test': 'src/modules/voice/work-bridge.test.ts', 'context-assembler.test': 'src/modules/orchestration/context-assembler.test.ts', 'asr.test': 'src/modules/voice/asr.test.ts', 'settings-modularization.test': 'src/modules/voice/settings-modularization.test.ts', 'realtime-provider-adapters.test': 'src/modules/voice/realtime-provider-adapters.test.ts', 'mobile-voice.test': 'src/modules/chat-mobile/voice.test.ts', 'mobile-https-proxy.test': 'src/modules/chat-mobile/https-proxy.test.ts' }, format: ['esm'], platform: 'node', target: 'node22',
  outDir: 'test-dist', clean: true, noExternal: ['@workmate/contracts'], removeNodeProtocol: false,
});
