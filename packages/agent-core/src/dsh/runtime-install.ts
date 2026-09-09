import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** Pinned npm dist-tag/version for on-demand desktop installs. Override with WORKMATE_DSH_NPM_VERSION. */
export const DSH_RUNTIME_NPM_VERSION = process.env.WORKMATE_DSH_NPM_VERSION?.trim() || '0.1.1-rc.2';

const READY_MARKER = '.workmate-dsh-ready.json';

/** Packages required by Workmate-generated cordis + JSON-RPC bin. */
export const DSH_RUNTIME_PACKAGES = [
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-compaction-basic',
] as const;

export type DshRuntimeStatus = {
  ok: boolean;
  root: string;
  bin: string | null;
  version: string | null;
  source: 'user-runtime' | 'env-bin' | 'node_modules' | 'sibling' | 'missing';
  detail: string;
};

function workmateDataDir(): string {
  return process.env.WORKMATE_DATA_DIR?.trim()
    || path.join(os.homedir(), '.workmate');
}

export function dshRuntimeRoot(dataDir = workmateDataDir()): string {
  return path.join(dataDir, 'dsh-runtime');
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export function resolveDshJsonrpcBin(runtimeRoot: string): string | null {
  const candidates = [
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js'),
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'packaged-bin.js'),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  const shim = process.platform === 'win32'
    ? path.join(runtimeRoot, 'node_modules', '.bin', 'dsh-jsonrpc-agent.cmd')
    : path.join(runtimeRoot, 'node_modules', '.bin', 'dsh-jsonrpc-agent');
  if (exists(shim)) return shim;
  return null;
}

function readReadyMarker(runtimeRoot: string): { version: string; installedAt: string } | null {
  const file = path.join(runtimeRoot, READY_MARKER);
  if (!exists(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string; installedAt?: string };
    if (!raw.version) return null;
    return { version: String(raw.version), installedAt: String(raw.installedAt || '') };
  } catch {
    return null;
  }
}

function writeReadyMarker(runtimeRoot: string, version: string) {
  fs.writeFileSync(
    path.join(runtimeRoot, READY_MARKER),
    `${JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

function isHarnessRoot(dir: string): boolean {
  return exists(path.join(dir, 'pnpm-workspace.yaml'))
    && (
      exists(path.join(dir, 'packages/examples/jsonrpc-demo'))
      || exists(path.join(dir, 'examples/jsonrpc-agent'))
    );
}

function findSiblingHarness(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    const sibling = path.resolve(dir, '../deepseek-harness');
    if (isHarnessRoot(sibling)) return sibling;
    const nested = path.join(dir, 'deepseek-harness');
    if (isHarnessRoot(nested)) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Probe whether a usable dsh JSON-RPC runtime is available for Workmate.
 * Prefers on-demand user install under ~/.workmate/dsh-runtime.
 */
export function probeDshRuntime(options?: { moduleDir?: string }): DshRuntimeStatus {
  const root = dshRuntimeRoot();
  const binEnv = process.env.WORKMATE_DSH_BIN?.trim();
  if (binEnv) {
    return {
      ok: true,
      root,
      bin: binEnv,
      version: DSH_RUNTIME_NPM_VERSION,
      source: 'env-bin',
      detail: `WORKMATE_DSH_BIN=${binEnv}`,
    };
  }

  const userBin = resolveDshJsonrpcBin(root);
  const marker = readReadyMarker(root);
  if (userBin && (marker || exists(path.join(root, 'node_modules', '@deepseek-ai')))) {
    return {
      ok: true,
      root,
      bin: userBin,
      version: marker?.version || DSH_RUNTIME_NPM_VERSION,
      source: 'user-runtime',
      detail: `已安装到 ${root}${marker?.version ? `（${marker.version}）` : ''}`,
    };
  }

  try {
    const require = createRequire(options?.moduleDir || import.meta.url);
    const resolved = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin');
    if (resolved) {
      return {
        ok: true,
        root: path.dirname(path.dirname(resolved)),
        bin: resolved,
        version: DSH_RUNTIME_NPM_VERSION,
        source: 'node_modules',
        detail: `node_modules: ${resolved}`,
      };
    }
  } catch {
    /* not in workmate deps */
  }

  const fromEnvRoot = process.env.WORKMATE_DSH_ROOT?.trim();
  if (fromEnvRoot && isHarnessRoot(fromEnvRoot)) {
    const built = path.join(fromEnvRoot, 'packages/examples/jsonrpc-demo/lib/bin.js');
    const src = path.join(fromEnvRoot, 'packages/examples/jsonrpc-demo/src/bin.ts');
    if (exists(built) || exists(src)) {
      return {
        ok: true,
        root: fromEnvRoot,
        bin: exists(built) ? built : src,
        version: null,
        source: 'sibling',
        detail: `WORKMATE_DSH_ROOT=${fromEnvRoot}`,
      };
    }
  }

  const sibling = findSiblingHarness(options?.moduleDir || process.cwd());
  if (sibling) {
    const built = path.join(sibling, 'packages/examples/jsonrpc-demo/lib/bin.js');
    const src = path.join(sibling, 'packages/examples/jsonrpc-demo/src/bin.ts');
    return {
      ok: true,
      root: sibling,
      bin: exists(built) ? built : src,
      version: null,
      source: 'sibling',
      detail: `开发 sibling：${sibling}`,
    };
  }

  return {
    ok: false,
    root,
    bin: null,
    version: null,
    source: 'missing',
    detail: `未安装。可在环境检查中一键安装到 ${root}（需联网，约 200MB）。`,
  };
}

function resolveNpmCommand(): { command: string; argsPrefix: string[]; label: string } {
  const fromEnv = process.env.WORKMATE_NPM?.trim();
  if (fromEnv) return { command: fromEnv, argsPrefix: [], label: fromEnv };

  const isWin = process.platform === 'win32';
  const candidates = isWin ? ['npm.cmd', 'npm'] : ['npm'];
  for (const command of candidates) {
    const probe = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 8_000,
      env: process.env,
      shell: isWin,
    });
    if ((probe.status ?? 1) === 0) {
      return { command, argsPrefix: [], label: `${command} ${String(probe.stdout || '').trim()}` };
    }
  }

  // Electron-as-Node: try npm next to a real node if present on PATH via `node`.
  const nodeProbe = spawnSync(isWin ? 'node.exe' : 'node', ['-e', "process.stdout.write(process.execPath)"], {
    encoding: 'utf8',
    timeout: 5_000,
    env: process.env,
    shell: isWin,
  });
  if ((nodeProbe.status ?? 1) === 0 && nodeProbe.stdout?.trim()) {
    const nodeDir = path.dirname(nodeProbe.stdout.trim());
    const npmCli = path.join(nodeDir, isWin ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
    const alt = path.join(nodeDir, 'npm');
    if (exists(npmCli)) {
      return { command: process.env.npm_node_execpath || nodeProbe.stdout.trim(), argsPrefix: [npmCli], label: npmCli };
    }
    if (exists(alt)) {
      return { command: alt, argsPrefix: [], label: alt };
    }
  }

  throw new Error(
    '未找到 npm，无法按需安装 dsh。请先安装 Node.js（含 npm），或设置 WORKMATE_NPM 指向 npm 可执行文件后重试。',
  );
}

function rmrf(target: string) {
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Install Workmate's dsh JSON-RPC runtime into ~/.workmate/dsh-runtime (or WORKMATE_DATA_DIR).
 * Atomic: installs into a temp directory then renames into place.
 */
export function ensureDshRuntimeInstalled(options?: {
  reinstall?: boolean;
  version?: string;
}): { ok: true; root: string; bin: string; version: string; detail: string } {
  const version = options?.version?.trim() || DSH_RUNTIME_NPM_VERSION;
  const finalRoot = dshRuntimeRoot();
  const existing = probeDshRuntime();
  if (!options?.reinstall && existing.source === 'user-runtime' && existing.bin && existing.version === version) {
    return {
      ok: true,
      root: existing.root,
      bin: existing.bin,
      version,
      detail: `已存在：${existing.detail}`,
    };
  }

  const npm = resolveNpmCommand();
  const staging = `${finalRoot}.installing-${process.pid}`;
  rmrf(staging);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });

  const packageJson = {
    name: 'workmate-dsh-runtime',
    private: true,
    version: '0.0.0',
    description: 'On-demand DeepSeek Harness JSON-RPC runtime for Workmate',
  };
  fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const specs = DSH_RUNTIME_PACKAGES.map((name) => `${name}@${version}`);
  const args = [
    ...npm.argsPrefix,
    'install',
    ...specs,
    '--omit=dev',
    '--no-fund',
    '--no-audit',
    '--no-package-lock',
  ];

  const result = spawnSync(npm.command, args, {
    cwd: staging,
    encoding: 'utf8',
    timeout: 15 * 60_000,
    env: {
      ...process.env,
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      // Prefer Electron's node when the API was forked as ELECTRON_RUN_AS_NODE.
      ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    shell: process.platform === 'win32',
  });

  if ((result.status ?? 1) !== 0) {
    const errText = String(result.stderr || result.stdout || 'unknown error').slice(-2000);
    rmrf(staging);
    throw new Error(`dsh runtime 安装失败（${npm.label}）：${errText}`);
  }

  const bin = resolveDshJsonrpcBin(staging);
  if (!bin) {
    rmrf(staging);
    throw new Error('dsh runtime 安装完成但未找到 dsh-jsonrpc-agent（@deepseek-ai/dsh-sdk-jsonrpc-demo）。');
  }

  writeReadyMarker(staging, version);

  const backup = `${finalRoot}.bak-${Date.now()}`;
  if (exists(finalRoot)) {
    try {
      fs.renameSync(finalRoot, backup);
    } catch {
      rmrf(finalRoot);
    }
  }
  try {
    fs.renameSync(staging, finalRoot);
  } catch (error) {
    // Windows may block rename across volumes; fall back to copy-ish via rename failure recovery.
    rmrf(staging);
    if (exists(backup)) {
      try { fs.renameSync(backup, finalRoot); } catch { /* ignore */ }
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
  rmrf(backup);

  const finalBin = resolveDshJsonrpcBin(finalRoot);
  if (!finalBin) {
    throw new Error(`安装后校验失败：${finalRoot} 中找不到 dsh-jsonrpc-agent`);
  }

  return {
    ok: true,
    root: finalRoot,
    bin: finalBin,
    version,
    detail: `已安装到 ${finalRoot}（${version}，${npm.label}）`,
  };
}
