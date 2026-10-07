// Build-time utility only. Static WAVs work on all platforms without OS TTS.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'darwin') throw new Error('Regeneration requires macOS Tingting; use the bundled WAV files on other platforms.');
const target = 'apps/renderer/public/voice-notices';
fs.mkdirSync(target, { recursive: true });
const clips = {
  'started-1': '好，我开始处理这项工作。', 'started-2': '收到，已经开始干活了。',
  'completed-1': '工作已经完成了，请在关联对话查看结果。', 'completed-2': '干完了，结果已经放在关联对话里。',
  failed: '这次执行失败了，请在关联对话查看原因。', approval: '这一步需要你审批，请在关联对话确认。', cancelled: '这项工作已经停止了。',
};
for (const [name, text] of Object.entries(clips)) execFileSync('say', ['-v', 'Tingting', '-r', '190', '-o', `${target}/${name}.wav`, '--data-format=LEI16@22050', text]);
console.log('Generated 7 static Chinese voice notifications (22.05 kHz PCM WAV).');
