<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { templateTasksApi as api, type TaskTemplate, type TemplateTask, type TemplateTaskDetail, type TaskResult, type TaskExportFormat } from '../../services/template-tasks';

const templates = ref<TaskTemplate[]>([]), tasks = ref<TemplateTask[]>([]);
const detail = ref<TemplateTaskDetail | null>(null), selectedTemplate = ref<TaskTemplate | null>(null);
const editingTask = ref<TemplateTask | undefined>(), editing = ref(false), name = ref('');
const inputHtml = ref(''), inputFrame = ref<HTMLIFrameElement | null>(null);
const result = ref<TaskResult | null>(null), report = ref(''), warning = ref(''), error = ref('');
const busy = ref(false), query = ref(''), resultTab = ref<'report' | 'data' | 'input'>('report');
let channel = '';
const exportFormats = computed<TaskExportFormat[]>(() => result.value?.delivery?.exports ?? ['json']);
const pendingRequests = new Map<string, string>();
const date = (time: number) => new Date(time).toLocaleString('zh-CN');
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await fn(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
async function reload() { tasks.value = (await api.list()).tasks; }
function clearResult() { result.value = null; report.value = ''; warning.value = ''; }
async function openTask(task: TemplateTask) {
  await action(async () => { editing.value = false; clearResult(); detail.value = await api.detail(task.id);
    const latest = detail.value.runs.find(run => run.status === 'completed' && run.result);
    if (latest) await loadResult(latest.id);
  });
}
async function edit(template: TaskTemplate, task?: TemplateTask) {
  await action(async () => {
    const view = await api.input(template);
    selectedTemplate.value = template; editingTask.value = task;
    name.value = task?.name ?? template.name; channel = crypto.randomUUID();
    inputHtml.value = view.html; editing.value = true;
  });
}
async function editCurrent() {
  if (!detail.value) return;
  const task = detail.value.task;
  try {
    const { template } = await api.template(task.templateId, task.templateVersion);
    await edit(template, task);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '任务模板读取失败'; }
}
function send(message: Record<string, unknown>) {
  // Parameters are JSON data; Vue reactive proxies cannot cross postMessage's clone boundary.
  const payload = JSON.parse(JSON.stringify({ ...message, channel }));
  inputFrame.value?.contentWindow?.postMessage(payload, '*');
}
async function receive(event: MessageEvent) {
  if (!editing.value || event.source !== inputFrame.value?.contentWindow) return;
  if (event.data?.type === 'workmate.task.ready') {
    send({ type: 'workmate.task.init', parameters: editingTask.value?.parameters ?? selectedTemplate.value?.defaults ?? {} }); return;
  }
  if (event.data?.type !== 'workmate.task.submit' || event.data.channel !== channel || !selectedTemplate.value) return;
  if (busy.value) { send({ type: 'workmate.task.saved', error: '正在处理，请稍后保存' }); return; }
  await action(async () => {
    try {
      const { task } = await api.save({ name: name.value, templateId: selectedTemplate.value!.id, templateVersion: selectedTemplate.value!.version, parameters: event.data.parameters }, editingTask.value);
      send({ type: 'workmate.task.saved' });
      editing.value = false; clearResult(); detail.value = await api.detail(task.id); await reload();
    } catch (cause) { send({ type: 'workmate.task.saved', error: cause instanceof Error ? cause.message : '保存失败' }); throw cause; }
  });
}
async function loadResult(runId: string) {
  if (!detail.value) return;
  clearResult();
  const response = await api.result(detail.value.task.id, runId);
  result.value = response.result; report.value = response.html ?? ''; warning.value = response.warning ?? '';
  resultTab.value = response.html && response.result.presentation?.defaultTab !== 'data' ? 'report' : 'data';
}
async function run() {
  if (!detail.value) return;
  await action(async () => {
    const id = detail.value!.task.id;
    // Keep the request ID on transport failure so retry cannot duplicate execution.
    const requestId = pendingRequests.get(id) ?? crypto.randomUUID(); pendingRequests.set(id, requestId);
    const response = await api.run(id, requestId); pendingRequests.delete(id);
    detail.value = await api.detail(id); await reload();
    if (response.run.result) await loadResult(response.run.id);
    if (response.run.status === 'failed') error.value = response.run.error ?? '执行失败';
  });
}
async function download(format: TaskExportFormat) {
  if (!result.value || !detail.value) return;
  await action(async () => { await api.download(detail.value!.task.id, result.value!.runId, format); });
}

onMounted(() => {
  window.addEventListener('message', receive);
  void action(async () => { const responses = await Promise.all([api.templates(), api.list()]); templates.value = responses[0].templates; tasks.value = responses[1].tasks; });
});
onBeforeUnmount(() => window.removeEventListener('message', receive));
</script>

<template>
  <div class="task-pilot">
    <p class="intro">从模板创建任务，保存参数后手动运行。结果和历史记录保存在当前账号的任务结果库。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status" class="intro">正在处理…</p>
    <section v-if="editing && selectedTemplate" class="panel">
      <div class="toolbar"><div><strong>{{ editingTask ? '修改任务' : '新建任务' }}</strong><p class="intro">{{ selectedTemplate.name }} · {{ selectedTemplate.version }}</p></div><button :disabled="busy" @click="editing = false">取消</button></div>
      <label class="name-field">任务名称<input v-model="name" maxlength="120" :disabled="busy" placeholder="为任务命名"></label>
      <iframe ref="inputFrame" :key="channel" :srcdoc="inputHtml" sandbox="allow-scripts" referrerpolicy="no-referrer" title="任务参数交互模板" class="input-frame"></iframe>
    </section>
    <template v-else>
      <section class="template-grid"><button v-for="template in templates" :key="template.id" class="template-card" :disabled="busy" @click="edit(template)"><span class="badge">Skill 模板 · {{ template.version }}</span><h2>{{ template.name }}</h2><p>{{ template.description }}</p><strong>＋ 使用模板创建</strong></button></section>
      <div class="toolbar"><h2>我的模板任务</h2><input v-model="query" placeholder="搜索任务名称" aria-label="搜索任务名称"><button :disabled="busy" @click="action(reload)">刷新</button></div>
      <p v-if="!tasks.length && !busy" class="empty">还没有模板任务。点击上方模板，填入示例数据即可体验完整流程。</p>
      <div class="task-list"><button v-for="task in tasks.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))" :key="task.id" :disabled="busy" :class="['task-row', { active: detail?.task.id === task.id }]" @click="openTask(task)"><strong>{{ task.name }}</strong><span>参数 v{{ task.revision }} · {{ date(task.updatedAt) }} · 查看任务 →</span></button></div>
      <section v-if="detail" class="panel">
        <div class="toolbar"><div><h2>{{ detail.task.name }}</h2><p class="intro">模板 {{ detail.task.templateVersion }} · 参数 v{{ detail.task.revision }} · 手动执行</p></div><button :disabled="busy" @click="editCurrent">修改参数</button><button class="primary" :disabled="busy" @click="run">立即运行</button></div>
        <div class="pipeline"><span>① 参数准备</span><span>② 计算汇总</span><span>③ 结果保存</span><span>④ 报告展示</span></div>
        <h3>运行记录</h3><p v-if="!detail.runs.length" class="intro">保存成功。点击“立即运行”生成第一份报告。</p>
        <div v-for="item in detail.runs" :key="item.id" class="run-row"><div><strong>{{ item.status === 'completed' ? '已完成' : item.status === 'failed' ? '失败' : '执行中 / 等待刷新' }}</strong><span> · {{ date(item.startedAt) }} · 参数 v{{ item.taskRevision }}</span><p v-if="item.error" class="error">{{ item.error }}</p></div><button v-if="item.result" :disabled="busy" @click="action(() => loadResult(item.id))">{{ result?.runId === item.id ? '正在查看' : '查看结果' }}</button></div>
        <template v-if="result">
          <div class="toolbar result-heading"><div><h3>运行结果</h3><p class="intro">{{ date(result.createdAt) }} · 报告版本 {{ result.schemaVersion }}</p></div><button v-for="format in exportFormats" :key="format" :disabled="busy" @click="download(format)">下载 {{ format.toUpperCase() }}</button></div>
          <p v-if="warning" class="error">{{ warning }}</p>
          <div class="tabs"><button :class="{ active: resultTab === 'report' }" :disabled="!report" @click="resultTab = 'report'">报告</button><button :class="{ active: resultTab === 'data' }" @click="resultTab = 'data'">结构化数据</button><button :class="{ active: resultTab === 'input' }" @click="resultTab = 'input'">本次输入</button></div>
          <iframe v-if="resultTab === 'report'" :srcdoc="report" sandbox="" title="经营数据汇总报告" referrerpolicy="no-referrer" class="report-frame"></iframe>
          <pre v-else>{{ JSON.stringify(resultTab === 'data' ? result.data : detail.runs.find(item => item.id === result?.runId)?.inputSnapshot, null, 2) }}</pre>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.task-pilot{font-size:14px}.intro{color:var(--muted);font-size:13px;line-height:1.7;margin:6px 0 16px}.panel{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;margin-top:20px}h2{font-size:18px;font-weight:700}h3{font-weight:700;margin:16px 0 10px}button,input{border:1px solid var(--border);border-radius:9px;padding:9px 13px}button{cursor:pointer;background:var(--surface)}button:hover{border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}input{background:var(--background);min-width:0}button.primary{background:var(--accent);color:white;border-color:var(--accent)}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0}.toolbar>:first-child{flex:1}.toolbar p{margin-bottom:0}.template-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:20px 0}.template-card{text-align:left;padding:24px;border-radius:16px;background:var(--surface)}.template-card h2{margin:12px 0 8px}.template-card p{color:var(--muted);line-height:1.7;margin-bottom:16px}.template-card>strong{color:var(--accent)}.badge{color:var(--accent);background:var(--accent-soft);font-size:11px;border-radius:6px;padding:4px 7px}.task-list{display:grid;gap:8px}.task-row{display:flex;justify-content:space-between;text-align:left;gap:12px;padding:16px}.task-row span,.run-row span{color:var(--muted);font-size:12px}.active{border-color:var(--accent);color:var(--accent)}.name-field{display:grid;gap:8px;margin:18px 0}.input-frame{width:100%;height:570px;border:1px solid var(--border);border-radius:12px;background:white}.report-frame{width:100%;height:680px;border:0;border-radius:12px;background:white}.pipeline{display:flex;flex-wrap:wrap;gap:12px;padding:14px;background:var(--accent-soft);border-radius:10px;color:var(--accent);font-size:12px}.run-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:12px 0}.result-heading{border-top:1px solid var(--border);padding-top:16px}.tabs{display:flex;gap:8px;margin:12px 0}.error{color:#c43d4f;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.empty{padding:24px;color:var(--muted);text-align:center}pre{background:var(--surface-muted);padding:18px;border-radius:10px;max-height:600px;overflow:auto;font-size:12px}
</style>
