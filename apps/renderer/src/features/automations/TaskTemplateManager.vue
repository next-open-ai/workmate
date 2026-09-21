<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { templateTasksApi as api, type TaskTemplate, type TaskTemplateConfiguration, type TaskTemplateDefinition, type TaskSkillDescriptor, type TaskTemplateTrial } from '../../services/template-tasks';

const emit = defineEmits<{ changed: [] }>();
const definitions = ref<TaskTemplateDefinition[]>([]), templates = ref<TaskTemplate[]>([]), skills = ref<TaskSkillDescriptor[]>([]);
const configuration = ref<TaskTemplateConfiguration | null>(null), record = ref<TaskTemplateDefinition>();
const pendingParameters = ref(false);
const busy = ref(false), error = ref(''), notice = ref(''), step = ref(0), saved = ref('');
const trial = ref<TaskTemplateTrial | null>(null), frame = ref<HTMLIFrameElement | null>(null), html = ref(''), channel = ref('');
const steps = ['基本信息', '输入参数', '执行能力', '结果与展示', '试运行与发布'];
const dirty = computed(() => !!configuration.value && JSON.stringify(configuration.value) !== saved.value);
const verified = computed(() => !!record.value && record.value.verifiedRevision === record.value.revision && !dirty.value);
const published = computed(() => record.value?.published.some(item => item.version === record.value?.draft.version) && !dirty.value);
const date = (time: number) => new Date(time).toLocaleString('zh-CN');
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await fn(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
async function refresh() {
  const [defs, list, capabilities] = await Promise.all([api.definitions(), api.templates(), api.skills()]);
  definitions.value = defs.definitions; templates.value = list.templates; skills.value = capabilities.skills;
}
function configOf(template: TaskTemplate): TaskTemplateConfiguration {
  const { id: _id, version: _version, ...config } = clone(template);
  return { ...config, defaults: config.defaults ?? {},
    presentation: config.presentation ?? { title: '', accent: 'blue', showRows: true, showSummary: true, defaultTab: 'report' },
    delivery: config.delivery ?? { storage: 'task-results', exports: ['json', 'html', 'csv'] },
  };
}
function start(template: TaskTemplate, definition?: TaskTemplateDefinition) {
  configuration.value = configOf(template); record.value = definition;
  if (!definition) configuration.value.name += '（自定义）';
  saved.value = definition ? JSON.stringify(configuration.value) : '';
  pendingParameters.value = false; step.value = 0; trial.value = null; html.value = ''; error.value = ''; notice.value = '';
}
function close() {
  if ((dirty.value || pendingParameters.value) && !window.confirm('当前修改尚未保存，确定离开模板编辑？')) return;
  configuration.value = null;
}
function binding(stage: 'input' | 'execution' | 'output' | 'view', event: Event) {
  if (!configuration.value) return;
  const skill = skills.value.find(item => `${item.id}@${item.version}` === (event.target as HTMLSelectElement).value);
  if (!skill) return;
  configuration.value[stage] = { skillId: skill.id, version: skill.version, entry: skill.entries[stage] };
  if (stage === 'output') {
    configuration.value.resultType = skill.resultType; configuration.value.resultVersion = skill.resultVersion;
    configuration.value.delivery!.exports = configuration.value.delivery!.exports.filter(format => skill.exports.includes(format));
  }
  if (stage === 'input') { configuration.value.defaults = {}; void action(loadInput); }
  trial.value = null;
}
async function loadInput() {
  if (!configuration.value) return;
  const input = configuration.value.input;
  html.value = ''; channel.value = crypto.randomUUID();
  html.value = (await api.skillInput(input.skillId, input.version)).html;
}
async function go(index: number) {
  if (pendingParameters.value) { error.value = '请先在参数表单内点击“应用为默认参数”，再切换步骤。'; return; }
  await action(async () => { step.value = index; if (index === 1) await loadInput(); });
}
function send(message: Record<string, unknown>) {
  frame.value?.contentWindow?.postMessage(clone({ ...message, channel: channel.value }), '*');
}
function receive(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || !configuration.value) return;
  if (event.data?.type === 'workmate.task.dirty' && event.data.channel === channel.value) { pendingParameters.value = true; return; }
  if (event.data?.type === 'workmate.task.ready') {
    send({ type: 'workmate.task.init', parameters: configuration.value.defaults, submitLabel: '应用为默认参数' });
  } else if (event.data?.type === 'workmate.task.submit' && event.data.channel === channel.value) {
    if (busy.value) { send({ type: 'workmate.task.saved', error: '正在处理，请稍后应用参数' }); return; }
    configuration.value.defaults = clone(event.data.parameters); pendingParameters.value = false; trial.value = null;
    send({ type: 'workmate.task.saved', notice: '默认参数已应用，请保存草稿后试运行。' });
    notice.value = '默认参数已应用，保存草稿后会用于新建任务。';
  }
}
async function save() {
  if (pendingParameters.value) throw new Error('请先在参数表单内点击“应用为默认参数”，再保存草稿。');
  if (!configuration.value) return;
  if (record.value && !dirty.value) return;
  const response = await api.saveDefinition(clone(configuration.value), record.value);
  record.value = response.definition; configuration.value = configOf(response.definition.draft);
  saved.value = JSON.stringify(configuration.value); trial.value = null;
  await refresh(); notice.value = '草稿已保存。发布前需要试运行当前版本。';
}
async function runTrial() {
  await action(async () => {
    await save();
    if (!record.value) return;
    // A fresh attempt invalidates earlier validation, including failed attempts.
    record.value.verifiedRevision = undefined;
    trial.value = null;
    trial.value = await api.trial(record.value);
    record.value.verifiedRevision = record.value.revision;
    await refresh(); notice.value = '试运行通过，可以发布当前版本。';
  });
}
async function publish() {
  await action(async () => {
    if (!record.value || !verified.value) return;
    record.value = (await api.publish(record.value)).definition;
    await refresh(); emit('changed'); notice.value = `版本 ${record.value.draft.version} 已发布，可在“模板任务”中创建任务。`;
  });
}
async function archive(definition: TaskTemplateDefinition) {
  await action(async () => { await api.archive(definition, !definition.archived); await refresh(); emit('changed'); });
}
onMounted(() => { window.addEventListener('message', receive); void action(refresh); });
onBeforeUnmount(() => window.removeEventListener('message', receive));
</script>

<template>
  <div class="manager">
    <div class="heading"><div><h2>任务模板配置</h2><p>配置输入、执行、结果与展示，试运行通过后发布为可复用模板。</p></div><button v-if="!configuration" :disabled="busy || !templates.length" class="primary" @click="start(templates[0])">＋ 新建模板</button></div>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p><p v-if="busy" class="muted" role="status">正在处理…</p>
    <template v-if="!configuration">
      <section class="card"><h3>内置起点</h3><p>从已接通的 Skill 模板复制配置。当前支持经营数据汇总，执行无需模型。</p><button :disabled="busy || !templates.length" @click="start(templates[0])">复制经营汇总模板</button></section>
      <h3 class="section-title">我的模板</h3><p v-if="!definitions.length" class="empty">尚无自定义模板。新建后可配置默认参数、导出格式和报告样式。</p>
      <article v-for="item in definitions" :key="item.id" class="definition card">
        <div><h3>{{ item.draft.name }} <span class="badge">{{ item.archived ? '已停用' : item.published.length ? '已发布' : '草稿' }}</span></h3><p>{{ item.draft.description || '尚未填写说明' }}</p><small>草稿 {{ item.draft.version }} · 已发布 {{ item.published.length }} 个版本 · {{ date(item.updatedAt) }}</small></div>
        <div class="buttons"><button :disabled="busy" @click="start(item.draft, item)">配置模板</button><button :disabled="busy" @click="start(item.draft)">复制</button><button :disabled="busy" @click="archive(item)">{{ item.archived ? '恢复' : '停用' }}</button></div>
      </article>
    </template>
    <section v-else class="card editor">
      <div class="heading"><div><h3>{{ configuration.name || '新模板' }}</h3><p>{{ record ? `草稿 ${record.draft.version}` : '新建草稿' }} · {{ dirty ? '有未保存修改' : '已保存' }}<span v-if="record?.archived"> · 已停用，请返回列表恢复后发布</span></p></div><button :disabled="busy" @click="close">返回模板列表</button></div>
      <nav class="steps" aria-label="模板配置步骤"><button v-for="(label, index) in steps" :key="label" :disabled="busy" :class="{ active: step === index }" @click="go(index)">{{ index + 1 }}. {{ label }}</button></nav>
      <fieldset :disabled="busy" class="stage">
        <div v-if="step === 0" class="fields">
          <label>模板名称<input v-model="configuration.name" maxlength="120" placeholder="例如：华东月度经营汇总"></label>
          <label>模板说明<textarea v-model="configuration.description" maxlength="1000" rows="3" placeholder="说明适用场景、需要的数据和交付内容"></textarea></label>
          <div class="hint">每次发布生成独立版本。修改草稿不会改变已发布版本、已有任务或历史结果。</div>
        </div>
        <div v-else-if="step === 1">
          <label>参数 Skill<select :value="`${configuration.input.skillId}@${configuration.input.version}`" @change="binding('input', $event)"><option v-for="skill in skills" :key="skill.id" :value="`${skill.id}@${skill.version}`">{{ skill.name }} · {{ skill.version }}</option></select></label>
          <p>设置新任务的默认参数。修改表单后请点击表单内“应用为默认参数”，再保存草稿。创建任务时仍可修改。</p>
          <iframe v-if="html" ref="frame" :key="channel" :srcdoc="html" sandbox="allow-scripts" referrerpolicy="no-referrer" title="模板默认参数" class="input-frame"></iframe>
          <details><summary>当前已应用的默认参数</summary><pre>{{ JSON.stringify(configuration.defaults, null, 2) }}</pre></details>
        </div>
        <div v-else-if="step === 2" class="fields">
          <label>执行 Skill<select :value="`${configuration.execution.skillId}@${configuration.execution.version}`" @change="binding('execution', $event)"><option v-for="skill in skills" :key="skill.id" :value="`${skill.id}@${skill.version}`">{{ skill.name }} · {{ skill.version }}</option></select></label>
          <div class="hint">当前执行方式：已注册的 Skill 入口。经营汇总按金额计算，无需模型，不调用外部业务接口。</div>
          <details open><summary>能力说明</summary><p v-for="skill in skills.filter(item => item.id === configuration?.execution.skillId)" :key="skill.id">{{ skill.description }}</p></details>
        </div>
        <div v-else-if="step === 3" class="fields">
          <div class="columns"><label>结果处理 Skill<select :value="`${configuration.output.skillId}@${configuration.output.version}`" @change="binding('output', $event)"><option v-for="skill in skills" :key="skill.id" :value="`${skill.id}@${skill.version}`">{{ skill.name }} · {{ skill.version }}</option></select></label><label>展示 Skill<select :value="`${configuration.view.skillId}@${configuration.view.version}`" @change="binding('view', $event)"><option v-for="skill in skills" :key="skill.id" :value="`${skill.id}@${skill.version}`">{{ skill.name }} · {{ skill.version }}</option></select></label></div>
          <div class="hint">结果保存到任务结果库，按账号隔离。每次运行独立保存，历史结果可查询。</div>
          <div><strong>允许导出</strong><div class="checks"><label v-for="format in skills.find(item => item.id === configuration?.output.skillId)?.exports ?? []" :key="format"><input v-model="configuration.delivery!.exports" type="checkbox" :value="format">{{ { json: 'JSON 数据', html: 'HTML 报告', csv: 'CSV 明细' }[format] }}</label></div></div>
          <label>报告标题<input v-model="configuration.presentation!.title" maxlength="100" placeholder="留空使用“经营数据汇总”"></label>
          <div class="columns"><label>主题色<select aria-label="主题色" v-model="configuration.presentation!.accent"><option value="blue">蓝色</option><option value="green">绿色</option><option value="violet">紫色</option></select></label><label>默认打开<select aria-label="默认打开" v-model="configuration.presentation!.defaultTab"><option value="report">报告</option><option value="data">结构化数据</option></select></label></div>
          <div class="checks"><label><input v-model="configuration.presentation!.showSummary" type="checkbox">显示结果摘要</label><label><input v-model="configuration.presentation!.showRows" type="checkbox">显示业务明细</label></div>
          <small class="muted">隐藏报告明细只改变展示；结构化数据仍可查询。</small>
          <details><summary>数据契约</summary><p>结果类型：{{ configuration.resultType }} · 结构版本 {{ configuration.resultVersion }}</p></details>
        </div>
        <div v-else>
          <div class="hint">使用当前默认参数完成输入校验、执行、格式化与展示预览。试运行不会创建正式任务或写入外部业务系统。</div>
          <div class="buttons trial-actions"><button class="primary" @click="runTrial">{{ dirty ? '保存并试运行' : '试运行模板' }}</button><button :disabled="!verified || !!record?.archived || !!published" class="primary" @click="publish">{{ published ? '当前版本已发布' : '发布模板' }}</button></div>
          <p v-if="verified" class="notice">当前草稿已通过试运行。</p><p v-else class="muted">发布前必须通过当前草稿的试运行；修改配置后需重新验证。</p>
          <ul v-if="trial && !dirty" class="checklist"><li v-for="check in trial.checks" :key="check">✓ {{ check }}</li></ul>
          <iframe v-if="trial && !dirty" :srcdoc="trial.html" sandbox="" referrerpolicy="no-referrer" title="模板报告预览" class="report-frame"></iframe>
          <details v-if="record?.published.length"><summary>已发布版本（不可覆盖）</summary><p v-for="version in record.published" :key="version.version">{{ version.version }} · {{ version.name }}</p></details>
        </div>
      </fieldset>
      <footer><span class="muted">{{ dirty ? '尚未保存' : '草稿已保存' }}</span><button :disabled="busy || step === 0" @click="go(step - 1)">上一步</button><button :disabled="busy" @click="action(save)">保存草稿</button><button v-if="step < 4" class="primary" :disabled="busy" @click="go(step + 1)">下一步</button></footer>
    </section>
  </div>
</template>

<style scoped>
.manager{font-size:14px}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.heading>div{flex:1}h2{font-size:22px;font-weight:700}h3{font-size:16px;font-weight:700}p{color:var(--muted);line-height:1.7;margin:8px 0}.card{border:1px solid var(--border);border-radius:16px;background:var(--surface);padding:24px;margin-bottom:16px}button,input,textarea,select{font:inherit;border:1px solid var(--border);border-radius:9px;padding:9px 12px;background:var(--surface);color:var(--text)}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button:hover:not(:disabled){border-color:var(--accent)}button.primary{background:var(--accent);color:white;border-color:var(--accent)}.definition{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}.buttons,.checks{display:flex;gap:12px;flex-wrap:wrap}.badge{font-size:11px;background:var(--accent-soft);color:var(--accent);padding:3px 7px;border-radius:5px}.section-title{margin:24px 0 12px}.empty{padding:24px;text-align:center;color:var(--muted)}small,.muted{color:var(--muted);font-size:12px}.steps{display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px}.steps .active{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}.stage{border:0;padding:24px 0;min-width:0}.fields{display:grid;gap:20px}label{display:grid;gap:8px;font-weight:500}.columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.checks{margin-top:12px}.checks label{display:flex;align-items:center}.hint{background:var(--surface-muted);border-radius:10px;padding:16px;color:var(--muted);line-height:1.7}.error{color:#be3347;white-space:pre-wrap;overflow-wrap:anywhere}.notice{color:#178163}.input-frame{width:100%;height:570px;border:1px solid var(--border);border-radius:12px;background:white}.report-frame{width:100%;height:680px;border:0;background:white;margin:16px 0}.trial-actions{margin:20px 0}.checklist{display:flex;gap:10px;flex-wrap:wrap;color:#178163;font-size:12px}details{margin-top:16px}summary{cursor:pointer;color:var(--muted)}pre{max-height:220px;overflow:auto;padding:14px;background:var(--surface-muted);border-radius:10px;font-size:12px}footer{display:flex;justify-content:flex-end;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:18px}footer>span{margin-right:auto}@media(max-width:700px){.columns{grid-template-columns:1fr}.heading{flex-wrap:wrap}.card{padding:16px}}
</style>
