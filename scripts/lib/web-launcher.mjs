import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { ensureAgentscopeRuntime } from './agentscope-runtime.mjs';

export function apiEntry(projectRoot) {
  return path.join(projectRoot, 'apps', 'api', 'dist', 'main.cjs');
}

export function staticDir(projectRoot) {
  return path.join(projectRoot, 'apps', 'renderer', 'dist');
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)));
  });
}

export async function choosePort(basePort) {
  for (let offset = 0; offset < 20; offset += 1) {
    const port = basePort + offset;
    if (await canListen(port)) return port;
  }
  throw new Error(`No available port found near ${basePort}.`);
}

export async function startWebLauncher(projectRoot, options = {}) {
  const entry = apiEntry(projectRoot);
  const staticRoot = staticDir(projectRoot);
  const requestedPort = Number(options.port || process.env.WORKMATE_API_PORT || '4328');
  const host = options.host || process.env.WORKMATE_API_HOST || '127.0.0.1';
  if (!existsSync(entry)) throw new Error(`Missing API build: ${entry}. Run \`pnpm build\` first.`);
  if (!existsSync(path.join(staticRoot, 'index.html'))) throw new Error(`Missing renderer build: ${staticRoot}/index.html. Run \`pnpm --filter @workmate/renderer build\` first.`);

  const engine = options.engine || process.env.WORKMATE_AGENT_ENGINE || 'agentscope';
  const extraEnv = {};
  if (engine === 'agentscope') {
    const runtime = ensureAgentscopeRuntime(projectRoot, { dataDir: options.dataDir, reinstall: Boolean(options.reinstallRuntime) });
    Object.assign(extraEnv, {
      WORKMATE_AGENT_ENGINE: 'agentscope',
      WORKMATE_AGENTSCOPE_ENABLED: '1',
      WORKMATE_AGENTSCOPE_ROOT: runtime.runtimeRoot,
      WORKMATE_AGENTSCOPE_PYTHON: runtime.python,
      WORKMATE_DATA_DIR: runtime.dataDir,
    });
  } else if (options.dataDir || process.env.WORKMATE_DATA_DIR) {
    Object.assign(extraEnv, { WORKMATE_DATA_DIR: options.dataDir || process.env.WORKMATE_DATA_DIR });
  }

  const port = await choosePort(requestedPort);
  const child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
      WORKMATE_API_PORT: String(port),
      WORKMATE_API_HOST: host,
      WORKMATE_WEB_STATIC_DIR: staticRoot,
    },
  });
  child.once('spawn', () => {
    process.stdout.write(`Workmate Web is starting at http://${host}:${port}\n`);
  });
  child.once('exit', (code) => process.exit(code ?? 0));
  return { port, child };
}
