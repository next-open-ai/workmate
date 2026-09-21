#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { choosePort } from './lib/web-launcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workmate-task-http-'));
const port = await choosePort(4459), base = `http://127.0.0.1:${port}/api`;
let logs = '';
const child = spawn(process.execPath, ['apps/api/dist/main.cjs'], { cwd: root, env: {
  ...process.env, WORKMATE_API_PORT: String(port), WORKMATE_DATA_DIR: dataDir,
  WORKMATE_AGENT_ENGINE: 'pi', WORKMATE_AGENTSCOPE_ENABLED: '0',
}, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', value => { logs = (logs + value).slice(-5000); });
child.stderr.on('data', value => { logs = (logs + value).slice(-5000); });
async function request(url, { token, body, method = 'GET', status = 200 } = {}) {
  const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-workmate-session': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch {}
    if (ready || child.exitCode !== null) break;
    await sleep(100);
  }
  assert.ok(ready, logs);
  await request('/template-tasks', { status: 401 });
  const password = randomUUID();
  const { token } = await request('/auth/bootstrap', { method: 'POST', body: { username: 'task-admin', displayName: '任务测试', password } });
  await request('/auth/users', { token, method: 'POST', body: { username: 'task-other', displayName: '其他用户', password, role: 'member' } });
  const other = await request('/auth/login', { method: 'POST', body: { username: 'task-other', password } });
  const csvData = Buffer.from('客户编号,客户名称,区域\nC001,华东示例公司,华东\nC002,华南示例公司,华南').toString('base64');
  const imported = await request('/data/import', { token, method: 'POST', body: { name: 'customers.csv', contentBase64: csvData }, status: 200 });
  const customerTable = imported.tables[0];
  const units = await request('/data/gateway/units', { token });
  assert.ok(units.units.some((unit) => unit.tableId === customerTable.id));
  const annotated = await request(`/data/sources/${imported.id}/tables/${customerTable.id}/schema`, { token, method: 'PATCH', body: { ...customerTable, columns: customerTable.columns.map((column, i) => ({ ...column, description: i === 0 ? '客户唯一编号，不可作为金额汇总' : '业务字段' })) } });
  assert.equal(annotated.tables[0].columns[0].description, '客户唯一编号，不可作为金额汇总');
  const customApp = await request('/data/apps/customize', { token, method: 'POST', body: { sourceId: imported.id, tableId: customerTable.id, idea: '按客户区域提供查询与统计', name: '客户数据应用' } });
  assert.match(customApp.prompt, /客户唯一编号，不可作为金额汇总/);
  assert.equal(customApp.app.table.columns[0].description, '客户唯一编号，不可作为金额汇总');
  const appTest = await request(`/data/apps/${customApp.app.id}`, { token });
  assert.equal(appTest.records.length, 2);
  await request(`/data/apps/${customApp.app.id}`, { token: other.token, status: 404 });
  console.log('PASS: edited Schema annotations reach AI app brief, generated app reads real data, owner isolation');
  const optionFields = customerTable.columns;
  const options = await request(`/data/gateway/options?sourceId=${imported.id}&tableId=${customerTable.id}&valueField=${encodeURIComponent(optionFields[0].id)}&labelField=${encodeURIComponent(optionFields[1].id)}&search=${encodeURIComponent('华东')}`, { token });
  assert.deepEqual(options.items.map((item) => item.label), ['华东示例公司']);
  const queried = await request(`/data/gateway/query?sourceId=${imported.id}&tableId=${customerTable.id}&fields=${optionFields[0].id},${optionFields[1].id}`, { token });
  assert.equal(queried.rows.length, 2);
  const { templates } = await request('/task-templates', { token });
  assert.equal(templates[0].input.skillId, 'business-summary');
  const view = await request('/task-templates/business-summary/input?version=1.0.0', { token });
  assert.match(view.html, /workmate.task.submit/);
  const input = { name: 'HTTP 闭环', templateId: 'business-summary', templateVersion: '1.0.0', parameters: { period: '2026-08', rows: [{ name: '华东', revenue: 120000, cost: 80000 }] } };
  await request('/template-tasks', { token, method: 'POST', body: { ...input, parameters: {} }, status: 400 });
  const { task } = await request('/template-tasks', { token, method: 'POST', body: input, status: 201 });
  const requestId = randomUUID();
  const first = await request(`/template-tasks/${task.id}/runs`, { token, method: 'POST', body: { requestId } });
  const retry = await request(`/template-tasks/${task.id}/runs`, { token, method: 'POST', body: { requestId } });
  assert.equal(first.run.result.id, retry.run.result.id);
  const result = await request(`/template-tasks/${task.id}/runs/${requestId}/result`, { token });
  assert.equal(result.result.data.profit, 40000); assert.match(result.html, /40,000.00/);
  const stranger = { token: other.token };
  assert.deepEqual((await request('/template-tasks', stranger)).tasks, []);
  await request(`/template-tasks/${task.id}`, { ...stranger, status: 404 });
  await request(`/template-tasks/${task.id}/runs/${requestId}/result`, { ...stranger, status: 404 });
  await request(`/template-tasks/${task.id}`, { token, method: 'PUT', body: { revision: 1, input: { ...input, name: '修改后的任务' } } });
  await request(`/template-tasks/${task.id}`, { token, method: 'PUT', body: { revision: 1, input }, status: 409 });
  assert.equal((await request(`/template-tasks/${task.id}`, { token })).runs.length, 1);
  const { id: builtinId, version: builtinVersion, ...configuration } = templates[0];
  configuration.name = '配置闭环'; configuration.defaults = input.parameters;
  configuration.presentation = { title: 'HTTP 自定义报告', accent: 'violet', showSummary: true, showRows: true, defaultTab: 'report' };
  configuration.delivery = { storage: 'task-results', exports: ['json', 'html', 'csv'] };
  const created = await request('/task-template-definitions', { token, method: 'POST', body: configuration, status: 201 });
  const definition = created.definition, endpoint = `/task-template-definitions/${definition.id}`;
  await request(`${endpoint}/publish`, { token, method: 'POST', body: { revision: 1 }, status: 400 });
  await request(endpoint, { ...stranger, status: 404 });
  await request(`${endpoint}/input`, { ...stranger, status: 404 });
  const preview = await request(`${endpoint}/trial`, { token, method: 'POST', body: { revision: 1 } });
  assert.match(preview.html, /HTTP 自定义报告/);
  await request(`${endpoint}/publish`, { token, method: 'POST', body: { revision: 1 } });
  assert.equal((await request('/task-templates', { token })).templates.length, 2);
  assert.equal((await request('/task-templates', stranger)).templates.length, 1);
  const custom = await request('/template-tasks', { token, method: 'POST', body: { ...input, templateId: definition.id, parameters: {} }, status: 201 });
  const customRun = await request(`/template-tasks/${custom.task.id}/runs`, { token, method: 'POST', body: { requestId: randomUUID() } });
  const csv = await fetch(`${base}/template-tasks/${custom.task.id}/runs/${customRun.run.id}/export?format=csv`, { headers: { 'x-workmate-session': token } });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition'), /attachment/); assert.match(await csv.text(), /华东/);
  await request(`${endpoint}/archive`, { token, method: 'POST', body: { revision: 1, archived: true } });
  assert.equal((await request('/task-templates', { token })).templates.length, 1);
  const demo = await request('/data/demo/initialize', { token, method: 'POST', body: {} });
  const again = await request('/data/demo/initialize', { token, method: 'POST', body: {} });
  assert.equal(demo.tableId, again.tableId);
  const demoBody = { ...demo, customerId: 'C001', period: '2026-08', requestId: randomUUID() };
  const [demoRun, duplicate] = await Promise.all([1,2].map(() => request('/data/demo/run', { token, method: 'POST', body: demoBody })));
  assert.equal(demoRun.result.data.profit, 50000);
  assert.equal(demoRun.source.rowCount, 2);
  assert.equal(demoRun.resultSourceId, duplicate.resultSourceId);
  const resultUnits = await request('/data/gateway/units', { token });
  const savedUnit = resultUnits.units.find(unit => unit.sourceId === demoRun.resultSourceId);
  assert.ok(savedUnit);
  const saved = await request(`/data/gateway/query?sourceId=${savedUnit.sourceId}&tableId=${savedUnit.tableId}`, { token });
  assert.match(JSON.stringify(saved.rows), /50000/);
  await request('/data/demo/run', { ...stranger, method: 'POST', body: demoBody, status: 404 });
  await request(`/data/gateway/query?sourceId=${demo.sourceId}&tableId=${demo.tableId}`, { ...stranger, status: 404 });
  await request('/data/demo/run', { token, method: 'POST', body: { ...demoBody, period: '2026-10', requestId: randomUUID() }, status: 400 });
  const september = await request('/data/demo/run', { token, method: 'POST', body: { ...demoBody, period: '2026-09', requestId: randomUUID() } });
  assert.equal(september.result.data.profit, 60000);
  console.log('PASS: database seed, concurrent retry, actual query/calculation/result persistence, month filtering and owner isolation');
  console.log('PASS: HTTP template draft/trial/publish/archive, task defaults/run/export, validation and owner isolation');
} finally {
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await rm(dataDir, { recursive: true, force: true });
}
