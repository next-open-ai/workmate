import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('../apps/renderer/src/features/chat/ChatWorkspace.vue', import.meta.url), 'utf8');
const appWorkspace = await readFile(new URL('../apps/renderer/src/app/workspace.ts', import.meta.url), 'utf8');
const employeePrefs = await readFile(new URL('../apps/renderer/src/app/employee-prefs.ts', import.meta.url), 'utf8');
const chat = await readFile(new URL('../packages/orchestrator/src/chat-session.ts', import.meta.url), 'utf8');
const task = await readFile(new URL('../packages/orchestrator/src/durable-task.ts', import.meta.url), 'utf8');

assert.match(workspace, /async function continueDurableTask\(\)/);
assert.match(workspace, /await props\.sendMessage\(/);
assert.match(workspace, /从最近检查点恢复/);
assert.match(workspace, /props\.abortMessage\?\.\(\)/);
assert.match(workspace, /aria-label="查看 Bash 命令与输出"/);
assert.doesNotMatch(workspace, />查看 Bash 命令与输出</);
assert.doesNotMatch(appWorkspace, /STREAM_IDLE_MS/);
assert.doesNotMatch(appWorkspace, /Date\.now\(\) \+ 12 \* 60_000/);
assert.match(appWorkspace, /Math\.max\(DEFAULT_RUN_TIMEOUT_MS, requestedRunTimeoutMs\) \+ 120_000/);
assert.match(appWorkspace, /server-side configured run timeout is authoritative/);
assert.match(employeePrefs, /DEFAULT_RUN_TIMEOUT_MS = 1_800_000/);
assert.match(employeePrefs, /LEGACY_DEFAULT_RUN_TIMEOUT_MS = 600_000/);
assert.doesNotMatch(workspace, /@click="changeDurableTaskStatus\('running'\)"/);
assert.match(chat, /durableTaskSourceResolver/);
assert.match(chat, /Math\.max\(request\.runTimeoutMs \?\? 0, 1_800_000\)/);
assert.match(chat, /timeoutMs,/);
assert.match(task, /async addSourceFile\(/);
assert.match(task, /role: 'source'/);
assert.match(task, /walk\(path\.join\(runRoot, '\.task'\)\)/);

console.log('[durable-task] source promotion, checkpoint write-back, one-click continuation, real pause and Bash disclosure wiring: PASS');
