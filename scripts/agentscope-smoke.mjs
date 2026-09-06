#!/usr/bin/env node
/**
 * Protocol smoke: spawn Python Sidecar → hello/health → stub echo run → collect AgentEvents.
 * Usage: node scripts/agentscope-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, 'runtimes/agentscope-runtime');
const srcPath = path.join(runtimeRoot, 'src');
const token = randomBytes(12).toString('hex');

function bundledPython() {
  return process.platform === 'win32'
    ? path.join(runtimeRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(runtimeRoot, '.venv', 'bin', 'python3');
}

function ensureRuntimePrepared() {
  const python = bundledPython();
  if (fs.existsSync(python)) return python;
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'prepare-agentscope-runtime.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0 || !fs.existsSync(python)) {
    throw new Error('Failed to prepare AgentScope runtime for smoke test.');
  }
  return python;
}

function resolvePython() {
  const venvPy = ensureRuntimePrepared();
  if (fs.existsSync(venvPy)) return venvPy;
  if (process.env.WORKMATE_AGENTSCOPE_PYTHON) return process.env.WORKMATE_AGENTSCOPE_PYTHON;
  return 'python3';
}

const python = resolvePython();

function rpc(ws, method, params) {
  const id = `${method}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 10_000);
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
  });
}

async function main() {
  const child = spawn(python, ['-m', 'workmate_agentscope_runtime', '--host', '127.0.0.1', '--port', '0', '--token', token], {
    cwd: runtimeRoot,
    env: { ...process.env, PYTHONPATH: srcPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no port')), 12_000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      const m = line.trim().match(/^WORKMATE_AGENTSCOPE_PORT=(\d+)$/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on('data', (buf) => process.stderr.write(buf));
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`exit ${code}`)); });
  });

  const url = `ws://127.0.0.1:${port}/v1/agent?token=${token}`;
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const hello = await rpc(ws, 'runtime.hello', { clientVersion: 'smoke', protocolVersion: '1' });
  const health = await rpc(ws, 'runtime.health', {});
  console.log('hello', hello);
  console.log('health', health);

  const events = [];
  let finished = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.method === 'agent.event') events.push(msg.params.event);
    if (msg.method === 'agent.run.finished') finished = msg.params;
  });

  const started = await rpc(ws, 'agent.run.start', {
    runId: 'smoke-run-1',
    messages: [{ role: 'user', content: '你好，Workmate' }],
    profile: { id: 'general', name: 'General', instructions: 'hi', toolIds: [] },
    model: { provider: 'openai', chatModel: 'gpt-test', apiKey: 'x' },
  });
  console.log('start', started);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('run timeout')), 10_000);
    const tick = setInterval(() => {
      if (finished) { clearInterval(tick); clearTimeout(timer); resolve(); }
    }, 50);
  });

  const deltas = events.filter((e) => e.type === 'message.delta').map((e) => e.text).join('');
  console.log('events', events.map((e) => e.type).join(' → '));
  console.log('text', deltas);
  console.log('finished', finished);

  if (!deltas.includes('Workmate')) throw new Error('unexpected stub text');
  if (finished?.status !== 'completed') throw new Error('run not completed');

  ws.close();
  child.kill('SIGTERM');
  console.log('agentscope smoke OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
