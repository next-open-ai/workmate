import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
let vite;
let electron;
let stopping = false;
let restarting = false;
let restartTimer;

function run(command, args, options = {}) { return spawn(command, args, { cwd: repoRoot, stdio: 'inherit', ...options }); }
function startElectron() {
  electron = run(pnpm, ['exec', 'electron', '.'], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      WORKMATE_RENDERER_URL: 'http://127.0.0.1:5173',
      WORKMATE_API_PORT: process.env.WORKMATE_API_PORT || '4328',
    },
  });
  electron.on('exit', (code) => {
    if (restarting) { restarting = false; startElectron(); return; }
    if (!stopping) { vite?.kill('SIGTERM'); process.exit(code ?? 0); }
  });
}
function restartElectron() {
  if (!electron || restarting) return;
  restarting = true;
  electron.kill('SIGTERM');
}
function stop() { stopping = true; clearTimeout(restartTimer); electron?.kill('SIGTERM'); vite?.kill('SIGTERM'); }

const build = run(pnpm, ['--filter', '@workmate/contracts', 'build']);
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const channelBuild = run(pnpm, ['--filter', '@workmate/channel', 'build']);
  channelBuild.on('exit', (channelCode) => {
    if (channelCode !== 0) process.exit(channelCode ?? 1);
    const gatewayBuild = run(pnpm, ['--filter', '@workmate/gateway', 'build']);
    gatewayBuild.on('exit', (gatewayCode) => {
      if (gatewayCode !== 0) process.exit(gatewayCode ?? 1);
      const agentBuild = run(pnpm, ['--filter', '@workmate/agent-core', 'build']);
      agentBuild.on('exit', (agentCode) => {
        if (agentCode !== 0) process.exit(agentCode ?? 1);
        const orchestratorBuild = run(pnpm, ['--filter', '@workmate/orchestrator', 'build']);
        orchestratorBuild.on('exit', (orchestratorCode) => {
          if (orchestratorCode !== 0) process.exit(orchestratorCode ?? 1);
          const apiBuild = run(pnpm, ['--filter', '@workmate/api', 'build']);
          apiBuild.on('exit', (apiCode) => {
            if (apiCode !== 0) process.exit(apiCode ?? 1);
            vite = run(pnpm, ['--filter', '@workmate/renderer', 'dev']);
            startElectron();
            // Renderer changes are handled by Vite HMR. Restart Electron only for IPC/main changes.
            watch(path.join(desktopRoot, 'src'), { recursive: process.platform !== 'linux' }, (_event, filename) => {
              if (!filename || !/^(main|preload)[/\\]/.test(filename)) return;
              clearTimeout(restartTimer);
              restartTimer = setTimeout(restartElectron, 180);
            });
          });
        });
      });
    });
  });
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
