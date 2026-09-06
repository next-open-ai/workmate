import { existsSync } from 'node:fs';
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

const python = resolveBasePython();
const bundledPython = venvPython();
if (!existsSync(bundledPython)) {
  console.log(`[agentscope-runtime] creating bundled venv with ${python}`);
  createVenv(python);
}
console.log(`[agentscope-runtime] installing requirements into ${venvRoot}`);
installRequirements(bundledPython);
console.log(`[agentscope-runtime] ready: ${bundledPython}`);
