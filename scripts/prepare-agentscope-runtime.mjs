import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(projectRoot, 'runtimes', 'agentscope-runtime');
const venvRoot = path.join(runtimeRoot, '.venv');
const isWin = process.platform === 'win32';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: runtimeRoot, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function venvPython() {
  return isWin
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python3');
}

function resolveBasePython() {
  if (process.env.WORKMATE_AGENTSCOPE_PYTHON?.trim()) return process.env.WORKMATE_AGENTSCOPE_PYTHON.trim();
  const candidates = isWin ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    const args = command === 'py' ? ['-3', '--version'] : ['--version'];
    const result = spawnSync(command, args, { cwd: runtimeRoot, encoding: 'utf8', env: process.env });
    if (result.status === 0) return command;
  }
  throw new Error('No usable Python 3 interpreter found for AgentScope runtime packaging.');
}

function createVenv(basePython) {
  const args = basePython === 'py' ? ['-3', '-m', 'venv', '--copies', venvRoot] : ['-m', 'venv', '--copies', venvRoot];
  run(basePython, args);
}

function installRequirements(python) {
  run(python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(python, ['-m', 'pip', 'install', '-r', path.join(runtimeRoot, 'requirements.txt')]);
}

function pruneRuntime(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    const stat = statSync(target);
    if (stat.isDirectory()) {
      if (entry === '__pycache__' || entry === '.pytest_cache' || entry === '.mypy_cache' || entry === 'tests' || entry === 'test') {
        rmSync(target, { recursive: true, force: true });
      } else {
        pruneRuntime(target);
      }
    } else if (entry.endsWith('.pyc') || entry.endsWith('.pyo')) {
      rmSync(target, { force: true });
    }
  }
}

const python = resolveBasePython();
const bundledPython = venvPython();
// Packaging must be reproducible. Reusing an older venv preserves packages
// removed from requirements and silently bloats later installers.
if (existsSync(venvRoot)) rmSync(venvRoot, { recursive: true, force: true });
console.log(`[agentscope-runtime] creating clean bundled venv with ${python}`);
createVenv(python);
console.log(`[agentscope-runtime] installing requirements into ${venvRoot}`);
installRequirements(bundledPython);
pruneRuntime(venvRoot);
console.log(`[agentscope-runtime] ready: ${bundledPython}`);
