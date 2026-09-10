import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FastifyPluginAsync } from 'fastify';
import { HealthResponseSchema } from '@workmate/contracts';
import {
  DSH_ENV_FIX_TIMEOUT_MS,
  buildDshEnvironmentCheck,
  isDshEnvFixAction,
  runDshEnvironmentFix,
  runDshEnvironmentFixWithProgress,
  type DshInstallProgressEvent,
} from '@workmate/agent-core';

type EnvCheckItem = {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  required: string;
  found: string;
  command?: string;
  help: string;
};

type EnvCheckReport = {
  platform: string;
  checks: EnvCheckItem[];
  summary: { total: number; ok: number; warn: number; error: number };
  checkedAt: number;
};

function dataDir() {
  return process.env.WORKMATE_DATA_DIR || path.join(os.homedir(), '.workmate');
}

function runtimeSourceRoot(projectRoot: string) {
  return path.join(projectRoot, 'runtimes', 'agentscope-runtime');
}

function installedRuntimePython(runtimeRoot: string) {
  return process.platform === 'win32'
    ? path.join(runtimeRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(runtimeRoot, '.venv', 'bin', 'python3');
}

function semverFirstTwo(text: string) {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: match[3] ? Number(match[3]) : 0 } : null;
}

function execCapture(command: string, args: string[], timeoutMs = 8_000) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, env: process.env });
    return {
      code: result.status ?? 1,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
    };
  } catch {
    return null;
  }
}

function readPythonVersion(command: string) {
  const args = command === 'py'
    ? ['-3', '-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")']
    : ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")'];
  const result = execCapture(command, args, 8_000);
  if (!result || result.code !== 0) return null;
  const match = `${result.stdout}${result.stderr}`.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function isSupportedPython(version: { major: number; minor: number; patch: number } | null) {
  return Boolean(version && version.major === 3 && version.minor >= 10);
}

function resolveBundledAgentscopeRuntime(projectRoot: string) {
  const runtimeRoot = runtimeSourceRoot(projectRoot);
  const python = installedRuntimePython(runtimeRoot);
  const pythonVersion = fs.existsSync(python) ? readPythonVersion(python) : null;
  if (!fs.existsSync(python) || !isSupportedPython(pythonVersion)) return null;
  return { runtimeRoot, python, pythonVersion };
}

function platformLabel() {
  const base = process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'linux'
        ? 'Linux'
        : process.platform;
  const inDocker = fs.existsSync('/.dockerenv') || process.env.container === 'docker';
  return inDocker ? `${base} / Docker` : `${base} / Web`;
}

function detectPython() {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    const args = command === 'py' ? ['-3', '--version'] : ['--version'];
    const result = execCapture(command, args, 6_000);
    if (result && result.code === 0) {
      const version = semverFirstTwo(`${result.stdout} ${result.stderr}`);
      if (version) return { command, version };
    }
  }
  return null;
}

function buildEnvironmentReport(): EnvCheckReport {
  const isWin = process.platform === 'win32';
  const items: EnvCheckItem[] = [];

  const nodeVersion = semverFirstTwo(process.versions.node);
  const nodeOk = Boolean(nodeVersion && nodeVersion.major >= 22);
  items.push({
    id: 'node',
    name: 'Node.js（运行时）',
    status: nodeOk ? 'ok' : 'error',
    required: '>= 22',
    found: `v${process.versions.node}`,
    help: nodeOk
      ? 'Web/API 运行形态依赖 Node 22+ 运行时。'
      : `当前 Node 为 v${process.versions.node}。请安装 Node.js 22+ 后重启服务。`,
  });

  items.push({
    id: 'launcher',
    name: 'Web / API 启动形态',
    status: 'ok',
    required: '可通过 HTTP 提供页面与 API',
    found: process.env.WORKMATE_WEB_STATIC_DIR?.trim() ? '静态页面 + API 已启用' : 'API 模式',
    help: process.env.WORKMATE_WEB_STATIC_DIR?.trim()
      ? '当前进程同时托管前端静态页与 API，适用于 npm Web Launcher 与 Docker。'
      : '当前进程仅提供 API；若需完整 Web 界面，请同时提供前端静态构建目录。',
  });

  const python = detectPython();
  const pythonOk = Boolean(python && python.version.major === 3 && python.version.minor >= 9);
  items.push({
    id: 'python',
    name: 'Python 3（脚本/依赖安装）',
    status: pythonOk ? 'ok' : 'error',
    required: '3.9+（python3/python/py）',
    found: python ? `${python.command} v${python.version.major}.${python.version.minor}.${python.version.patch}` : '未检测到可用的 Python 3',
    command: python ? `${python.command} --version` : undefined,
    help: pythonOk
      ? `服务端可使用 ${python?.command || 'python3'} 执行脚本，并为运行时准备 Python 依赖。`
      : isWin
        ? '未找到 Python 3。请安装 Python 3.10+ 并加入 PATH，安装后重启服务。'
        : process.platform === 'darwin'
          ? '未找到 Python 3。推荐安装：\n  brew install python@3.12\n安装后重启服务。'
          : '未找到 Python 3。推荐安装：\n  sudo apt update && sudo apt install -y python3 python3-pip（Debian/Ubuntu）\n  或 dnf install python3 python3-pip（Fedora）\n安装后重启服务。',
  });

  let pipOk = false;
  let pipFound = '未检测到 pip';
  if (python) {
    const args = python.command === 'py' ? ['-3', '-m', 'pip', '--version'] : ['-m', 'pip', '--version'];
    const pip = execCapture(python.command, args, 8_000);
    pipOk = Boolean(pip && pip.code === 0);
    pipFound = pipOk ? `${python.command} -m pip` : '未检测到 pip（python -m pip 失败）';
  }
  items.push({
    id: 'pip',
    name: 'pip（Python 包安装）',
    status: pipOk ? 'ok' : 'error',
    required: '可用（python -m pip）',
    found: pipFound,
    help: pipOk
      ? '用于安装 AgentScope 或脚本运行所需的 Python 依赖。'
      : pythonOk
        ? '检测到 Python 但 pip 不可用。请补装 python3-pip，或执行 python -m ensurepip。'
        : '需先安装 Python 3（一般会自带 pip）。',
  });

  const bundled = resolveBundledAgentscopeRuntime(process.cwd());
  const agentscopeVersion = bundled?.pythonVersion ?? python?.version ?? null;
  const agentscopePython = bundled ? { command: bundled.python, version: bundled.pythonVersion } : python;
  const agentscopeOk = Boolean(agentscopeVersion && agentscopeVersion.major === 3 && agentscopeVersion.minor >= 10);
  items.push({
    id: 'agentscope-python',
    name: 'AgentScope Python Runtime',
    status: agentscopeOk ? 'ok' : 'error',
    required: '>= 3.10（优先使用内置 Runtime）',
    found: bundled
      ? `内置 ${bundled.python}${bundled.pythonVersion ? ` v${bundled.pythonVersion.major}.${bundled.pythonVersion.minor}.${bundled.pythonVersion.patch}` : ''}`
      : agentscopePython && agentscopePython.version
        ? `${agentscopePython.command} v${agentscopePython.version.major}.${agentscopePython.version.minor}.${agentscopePython.version.patch}`
        : `未检测到 AgentScope 可用 Python（查找目录 ${runtimeSourceRoot(process.cwd())}）`,
    command: bundled?.python || (agentscopePython ? `${agentscopePython.command} --version` : undefined),
    help: bundled
      ? `当前优先使用项目内置 AgentScope runtime：${bundled.runtimeRoot}`
      : agentscopeOk
        ? '未发现内置 runtime，将回退到系统 Python 3.10+。'
        : 'AgentScope 运行时需要 Python 3.10+；Docker 镜像建议预装，npm Web 启动可使用系统 Python。',
  });

  const git = execCapture('git', ['--version'], 5_000);
  const gitOk = Boolean(git && git.code === 0);
  items.push({
    id: 'git',
    name: 'Git（Skills 仓库导入/克隆）',
    status: gitOk ? 'ok' : 'error',
    required: '可用（git --version）',
    found: gitOk ? (git?.stdout || git?.stderr || 'git') : '未检测到 git',
    help: gitOk
      ? '用于拉取或导入 Skills 仓库。'
      : process.platform === 'darwin'
        ? '未检测到 git。可执行 xcode-select --install，或 brew install git。'
        : isWin
          ? '未检测到 git。请安装 Git for Windows 并加入 PATH。'
          : '未检测到 git。Debian/Ubuntu: sudo apt install -y git；Fedora: sudo dnf install git。',
  });

  const npx = execCapture(isWin ? 'npx.cmd' : 'npx', ['--version'], 8_000);
  const npxOk = Boolean(npx && npx.code === 0);
  items.push({
    id: 'npx',
    name: 'npx（Skills 生态安装器）',
    status: npxOk ? 'ok' : 'warn',
    required: '可用（随 Node 提供）',
    found: npxOk ? `v${npx?.stdout || npx?.stderr || ''}`.trim() || 'npx' : '未检测到 npx',
    help: npxOk ? '用于安装公开 Skill 包。' : '未检测到 npx。通常随 Node.js 一起提供，可通过重装 Node 修复。',
  });

  let storageOk = true;
  let storageFound = dataDir();
  try {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const probe = path.join(dataDir(), '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (error) {
    storageOk = false;
    storageFound = error instanceof Error ? error.message : String(error);
  }
  items.push({
    id: 'storage',
    name: '本地数据目录',
    status: storageOk ? 'ok' : 'error',
    required: '可读写',
    found: storageOk ? dataDir() : storageFound,
    help: storageOk
      ? '会话、项目、资产、通道配置与运行时数据都保存在该目录。'
      : `无法写入 ${dataDir()}。请检查卷挂载、磁盘空间或目录权限。`,
  });

  items.push(buildDshEnvironmentCheck());

  const summary = {
    total: items.length,
    ok: items.filter((item) => item.status === 'ok').length,
    warn: items.filter((item) => item.status === 'warn').length,
    error: items.filter((item) => item.status === 'error').length,
  };
  return { platform: platformLabel(), checks: items, summary, checkedAt: Date.now() };
}

type EnvFixActionId = 'fix-storage' | 'fix-pip' | 'fix-agentscope' | 'fix-dsh';

function runFixStorage() {
  const root = dataDir();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    /* Windows may ignore chmod */
  }
  const probe = path.join(root, '.write-probe');
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
  return { ok: true as const, message: `数据目录已就绪：${root}`, detail: root };
}

function detectPythonCommand() {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    const args = command === 'py' ? ['-3', '--version'] : ['--version'];
    const result = execCapture(command, args, 6_000);
    if (result && result.code === 0) return command;
  }
  return null;
}

function runFixPip() {
  const command = detectPythonCommand();
  if (!command) throw new Error('未找到 Python，无法执行 ensurepip。请先安装 Python 3.10+。');
  const args = command === 'py' ? ['-3', '-m', 'ensurepip', '--upgrade'] : ['-m', 'ensurepip', '--upgrade'];
  const result = execCapture(command, args, 60_000);
  if (!result || result.code !== 0) {
    throw new Error(`ensurepip 失败：${result?.stderr || result?.stdout || 'unknown error'}`);
  }
  return {
    ok: true as const,
    message: `已执行 ${command} -m ensurepip --upgrade`,
    detail: result.stdout || result.stderr || '',
  };
}

function runFixAgentscope() {
  const entry = path.join(process.cwd(), 'bin', 'workmate.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error(`找不到 Workmate CLI：${entry}。请在项目根目录启动服务后再试。`);
  }
  const result = spawnSync(process.execPath, [entry, 'init'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10 * 60_000,
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`AgentScope runtime 初始化失败：${String(result.stderr || result.stdout || 'unknown error').slice(-1200)}`);
  }
  return {
    ok: true as const,
    message: 'AgentScope runtime 已初始化（workmate init）',
    detail: String(result.stdout || '').trim().slice(0, 1200),
  };
}

function runEnvironmentFix(actionId: string) {
  if (actionId === 'fix-storage') return runFixStorage();
  if (actionId === 'fix-pip') return runFixPip();
  if (actionId === 'fix-agentscope') return runFixAgentscope();
  if (isDshEnvFixAction(actionId)) return runDshEnvironmentFix({ reinstall: true });
  throw new Error(`不支持的修复动作：${actionId}（仅允许 fix-storage / fix-pip / fix-agentscope / fix-dsh）`);
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => HealthResponseSchema.parse({
    status: 'ok',
    service: 'workmate-api',
    version: process.env.npm_package_version ?? '0.1.0',
  }));
  app.get('/environment', async () => buildEnvironmentReport());
  app.post('/environment/fix', async (request, reply) => {
    const body = (request.body ?? {}) as { actionId?: string };
    const actionId = String(body.actionId || '').trim() as EnvFixActionId | '';
    if (!actionId) return reply.code(400).send({ message: '缺少 actionId' });
    try {
      // Prefer streaming endpoint for dsh; keep sync fallback for simple clients.
      if (isDshEnvFixAction(actionId)) {
        request.raw.setTimeout(DSH_ENV_FIX_TIMEOUT_MS);
        reply.raw.setTimeout(DSH_ENV_FIX_TIMEOUT_MS);
      }
      const result = runEnvironmentFix(actionId);
      return { ...result, actionId, report: buildEnvironmentReport() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ message, actionId });
    }
  });
  app.post('/environment/dsh/install', async (request, reply) => {
    const body = (request.body ?? {}) as { reinstall?: boolean };
    const reinstall = Boolean(body.reinstall);
    request.raw.setTimeout(DSH_ENV_FIX_TIMEOUT_MS);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (payload: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const onProgress = (event: DshInstallProgressEvent) => {
      send(event);
    };

    try {
      const result = await runDshEnvironmentFixWithProgress({ reinstall, onProgress });
      send({
        type: 'complete',
        ok: true,
        message: result.message,
        detail: result.detail,
        skipped: result.skipped,
        actionId: 'fix-dsh',
        report: buildEnvironmentReport(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: 'error', ok: false, message, actionId: 'fix-dsh' });
    } finally {
      reply.raw.end();
    }
  });
};
