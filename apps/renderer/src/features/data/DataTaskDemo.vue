<script setup lang="ts">
import { ref } from 'vue';
const emit = defineEmits<{ changed: [] }>();
const busy = ref(false), error = ref(''), search = ref(''), customer = ref(''), period = ref('2026-08');
const source = ref<{ sourceId: string; tableId: string }>();
const options = ref<Array<{ value: string; label: string }>>([]);
const output = ref<{ html: string; taskId: string; runId: string; resultSourceId: string; source: { rowCount: number }; result: { data: Record<string, unknown> } }>();
let requestId = '';
async function call(path: string, body?: unknown) {
  const base = window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
  const response = await fetch(`${base}/api/data/${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); if (!response.ok) throw new Error(data.message || '操作失败'); return data;
}
async function action(fn: () => Promise<void>) {
  if (busy.value) return; busy.value = true; error.value = '';
  try { await fn(); } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
async function loadOptions() {
  if (!source.value) return;
  const params = new URLSearchParams({ ...source.value, valueField: 'c_1', labelField: 'c_2', search: search.value });
  const response = await call(`gateway/options?${params}`);
  options.value = [...new Map<string, { value: string; label: string }>(response.items.map((item: { value: string; label: string }) => [item.value, item])).values()];
}
async function initialize() {
  await action(async () => { source.value = await call('demo/initialize', {}); await loadOptions(); customer.value = options.value[0]?.value ?? ''; requestId = ''; emit('changed'); });
}
async function run() {
  await action(async () => { requestId ||= crypto.randomUUID(); output.value = await call('demo/run', { ...source.value, customerId: customer.value, period: period.value, requestId }); requestId = ''; emit('changed'); });
}
</script>
<template>
  <section class="demo">
    <header><div><span class="badge">可直接体验 · 测试数据</span><h2>数据库取数 → 经营分析 → 结果回存</h2><p>在当前账号的默认工作库加入 4 条独立测试记录，不覆盖已有数据。无需配置模型。</p></div><button :disabled="busy" @click="initialize">{{ source ? '检查测试数据' : '准备测试数据并开始' }}</button></header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-if="source" class="content">
      <p class="success">① 测试数据已就绪 · 默认工作库 → 测试数据 · 客户经营明细</p><p class="gateway-note">数据访问：统一数据网关 · 当前用户权限 · options/query 操作 · 不向页面暴露数据库密码</p>
      <div class="form"><label>搜索客户<input v-model="search" placeholder="例如：华东" @keyup.enter="action(loadOptions)"></label><button :disabled="busy" @click="action(loadOptions)">查询可选客户</button><label>客户<select v-model="customer" @change="requestId = ''"><option value="" disabled>请选择客户</option><option v-for="item in options" :key="item.value" :value="item.value">{{ item.label }}</option></select></label><label>统计月份<input v-model="period" type="month" @change="requestId = ''"></label><button :disabled="busy || !customer" @click="run">{{ busy ? '处理中…' : '运行分析并保存结果' }}</button></div>
      <p>测试范围：2026-08 华东收入 150,000、成本 100,000、利润 50,000；华南利润 25,000。2026-09 华东利润 60,000。</p>
    </div>
    <div v-if="output" class="result">
      <p class="success">② 已从数据库读取 {{ output.source.rowCount }} 条记录 → ③ 已执行任务 → ④ 已保存报告和结果数据集</p>
      <p>结果已出现在数据工作台的数据源列表（名称以“测试结果”开头）。任务也可在“自动化与任务 → 模板任务”查询历史。</p>
      <details><summary>查看来源与保存回执</summary><pre>{{ JSON.stringify({ taskId: output.taskId, runId: output.runId, resultSourceId: output.resultSourceId, source: output.source }, null, 2) }}</pre></details>
      <iframe :srcdoc="output.html" sandbox="" title="数据库经营分析报告"></iframe>
    </div>
  </section>
</template>
<style scoped>
.demo{border:1px solid var(--border);border-radius:16px;background:var(--surface);padding:22px;margin-bottom:20px}header{display:flex;gap:20px;justify-content:space-between;align-items:center;flex-wrap:wrap}h2{font-size:18px;font-weight:700;margin:10px 0}p{font-size:13px;color:var(--muted);line-height:1.8;margin:8px 0}.badge{color:var(--accent);background:var(--accent-soft);border-radius:6px;padding:4px 8px;font-size:12px}button{background:var(--accent);color:white;padding:10px 14px;border-radius:8px;font-size:13px}button:disabled{opacity:.5}.form{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:16px 0}label{display:grid;gap:6px;font-size:13px}input,select{border:1px solid var(--border);background:var(--background);border-radius:8px;padding:9px;min-width:150px}.content{border-top:1px solid var(--border);margin-top:20px;padding-top:12px}.success{color:#178163}.gateway-note{color:#52606d;font-size:12px;background:#f5f7fa;padding:8px 10px;border-radius:8px}.error{color:#b42318}iframe{width:100%;height:650px;border:0;background:white;margin-top:16px;border-radius:12px}pre{font-size:12px;overflow:auto;padding:12px}summary{cursor:pointer;font-size:12px}
</style>
