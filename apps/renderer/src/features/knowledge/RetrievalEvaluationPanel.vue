<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import type { RetrievalEvaluation } from '@workmate/contracts';
import { evaluateRetrieval, evaluationHtml, metric, parseEvaluation, MAX_EVALUATION_BYTES, type EvaluationReport } from './retrieval-evaluation';

const props = defineProps<{ knowledgeBaseId: string; query: string; ready: boolean;
  hits: Array<{ id: string; title: string; wiki?: { pageId: string } }> }>();
const report = ref<EvaluationReport>(), dataset = ref<RetrievalEvaluation>();
const error = ref(''), busy = ref(false);
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function snapshot(example = false) {
  const data: RetrievalEvaluation = { version: 1, knowledgeBaseId: props.knowledgeBaseId,
    snapshot: '请填写资料版本与采集范围', topK: 6, cases: [{ id: 'q1',
      query: example ? '示例：报销需要什么资料？' : props.query,
      relevantGroups: example ? [['chunk:原文块ID', 'wiki:同证据页面ID']] : null,
      runs: [{ variant: '请填写本次检索配置（模型、Wiki、本体及关联开关）', hits: example
        ? [{ id: 'chunk:原文块ID', title: '示例报销制度' }]
        : props.hits.map(h => ({ id: h.wiki ? `wiki:${h.wiki.pageId}` : `chunk:${h.id}`, title: h.title })) }] }] };
  download(JSON.stringify(data, null, 2), example ? 'evaluation-example.json' : 'retrieval-snapshot.json', 'application/json');
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  if (!file || busy.value) return;
  error.value = ''; report.value = undefined; dataset.value = undefined; busy.value = true;
  try {
    if (file.size > MAX_EVALUATION_BYTES) throw new Error('评测文件不能超过 2 MB。');
    const raw = await file.text();
    if (disposed) return;
    const parsed = parseEvaluation(raw, props.knowledgeBaseId);
    dataset.value = parsed; report.value = evaluateRetrieval(parsed);
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '无法读取评测文件。'; }
  finally { if (!disposed) busy.value = false; input.value = ''; }
}
</script>

<template>
  <section aria-label="离线评测报告" class="evaluation-panel">
    <p>只读取手动导出的快照，不发起查询、不调用模型、不修改检索配置。报告仅在本页保留，可下载后随时查看。</p>
    <div class="actions">
      <button :disabled="!ready || busy" @click="snapshot(false)">导出当前召回快照</button>
      <button :disabled="busy" @click="snapshot(true)">下载格式示例</button>
      <label>选择标注文件并生成报告<input aria-label="选择标注文件并生成报告" type="file" accept=".json,application/json" :disabled="busy" @change="importFile" /></label>
    </div>
    <details class="instructions"><summary>如何准备标注文件？</summary>
      <p>导出快照后填写 snapshot（资料版本）和 variant（检索配置），将正确来源ID填写到 relevantGroups。一个组是一份独立证据，原文和同义 Wiki 可放同组；漏召回的正确ID也要填写。null 表示未标注，[] 表示确认库中无答案。</p>
      <p>多题合并到 cases；同题对比方案加入 runs，每题方案集合保持一致。最多100题、5种方案、每次20条结果、文件2 MB。比较时保持资料版本和 TopK 一致。文件含问题与标题，请妥善保存；不会上传服务器。</p>
    </details>
    <p v-if="busy" role="status">正在生成离线报告…</p><p v-if="error" role="alert">{{ error }}</p>
    <div v-if="report && dataset" class="report">
      <div class="actions"><h4>评测报告 · Top {{ report.topK }} · {{ dataset.cases.length }} 题</h4><button @click="download(evaluationHtml(dataset!, report!), 'retrieval-evaluation.html', 'text/html')">下载 HTML 报告</button></div>
      <p>快照：{{ dataset.snapshot }}</p><p>结果依据人工标注，不代表系统已核验内容与来源。无答案题单列，同组证据只计一次；不自动调整配置。</p>
      <div class="table-scroll"><table><thead><tr><th>方案</th><th>命中率</th><th>证据找全率</th><th>MRR</th><th>有效结果占比</th><th>nDCG</th><th>无答案空返回率</th></tr></thead><tbody><tr v-for="row in report.summaries" :key="row.variant"><td>{{ row.variant }}<small>有答案 {{ row.answerable }} / 无答案 {{ row.noAnswer }} 题</small></td><td>{{ metric(row.hit) }}</td><td>{{ metric(row.recall) }}</td><td>{{ row.mrr?.toFixed(3) ?? '未评测' }}</td><td>{{ metric(row.precision) }}</td><td>{{ row.ndcg?.toFixed(3) ?? '未评测' }}</td><td>{{ metric(row.emptyCorrect) }}</td></tr></tbody></table></div>
      <p v-for="row in report.summaries" :key="row.variant">{{ row.variant }}：{{ row.p95Ms === null ? '耗时未采集' : `P95 ${row.p95Ms} ms（${row.timingCount} 条记录，非性能基准）` }}</p>
      <details><summary>逐题明细</summary><ul><li v-for="row in report.rows" :key="`${row.id}:${row.variant}`">{{ row.query }} · {{ row.variant }} · 首个有效排名 {{ row.firstRank ?? '未命中' }} · 找全率 {{ metric(row.recall) }}</li></ul></details>
    </div>
  </section>
</template>

<style scoped>
.evaluation-panel{min-width:0;padding:16px;background:var(--surface-muted);border-radius:12px;font-size:12px;line-height:1.7}
p{color:var(--muted);margin:8px 0;overflow-wrap:anywhere}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}button,label{border:1px solid var(--border);border-radius:8px;padding:8px 12px;background:var(--surface)}input{display:block;max-width:100%;margin-top:4px}button:disabled{opacity:.5}summary{cursor:pointer;font-weight:600;padding:8px 0}button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.report{margin-top:20px}h4{font-weight:700;font-size:14px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;background:var(--surface)}td,th{padding:10px;border-bottom:1px solid var(--border);text-align:left;min-width:90px;max-width:240px;overflow-wrap:anywhere}small{display:block;color:var(--muted)}li{padding:6px 0;overflow-wrap:anywhere}[role=alert]{color:var(--text)}
</style>
