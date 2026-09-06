<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Employee, EmployeeId, Conversation } from '../../app/workspace';
import type { ProviderConfig, ProviderId } from '../../app/model-config';
import { chatEndpointLabel } from '../../app/model-config';
import type { AutomationRunTranscript } from '../../app/automations';
import { useCapabilities } from '../../app/capabilities';
import { useAutomations, type Automation, type AutomationRun, type AutomationSchedule } from '../../app/automations';
import { employeeDisplayName } from '../../app/employees';
import { useI18n } from '../../app/i18n';
import AutomationRunDetail from './AutomationRunDetail.vue';

const props = defineProps<{
  employees: Employee[];
  models: ProviderConfig[];
  conversations: Conversation[];
  runAutomation: (item: Automation) => Promise<AutomationRunTranscript | undefined>;
  openConversation: (id: string) => void;
}>();

const { t } = useI18n();
const { load: loadSkills, allowedSkillsFor } = useCapabilities();
const { automations, runs, load, loadRuns, save, update, remove, beginRun, finishRun } = useAutomations();
const creating = ref(false);
const createStep = ref<'pick' | 'configure'>('pick');
const running = ref('');
const error = ref('');
const tab = ref<'tasks' | 'runs'>('tasks');
const selectedRun = ref<AutomationRun | null>(null);
const form = ref({ name: '', prompt: '', employeeId: 'general' as EmployeeId, modelId: '', skillIds: [] as string[], kind: 'once' as 'once' | 'recurring', at: '', frequency: 'daily' as 'daily' | 'weekly' | 'monthly', time: '09:00', weekdays: [1] as number[], dayOfMonth: 1 });
const availableSkills = computed(() => allowedSkillsFor(form.value.employeeId).filter((skill) => skill.status === 'ready'));
const hasTasks = computed(() => automations.value.length > 0);
const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const templates = [
  { name: '每日工作简报', prompt: '总结今天的重要工作进展、风险和下一步建议，生成一份清晰的 Markdown 简报。', employeeId: 'general' as EmployeeId, frequency: 'daily' as const, time: '18:00' },
  { name: '每周项目复盘', prompt: '汇总本周项目进展、阻塞事项、风险与下周重点，输出结构化周报。', employeeId: 'research' as EmployeeId, frequency: 'weekly' as const, time: '09:30', weekdays: [1] },
  { name: '每月运营回顾', prompt: '整理本月关键成果、待解决问题和下月目标，形成管理层可读的月度回顾。', employeeId: 'general' as EmployeeId, frequency: 'monthly' as const, time: '09:00', dayOfMonth: 1 },
  { name: '每日灵感与学习', prompt: '给我一条与 AI、效率或专业成长相关的精选学习建议，并说明为什么值得关注。', employeeId: 'research' as EmployeeId, frequency: 'daily' as const, time: '08:30' },
];

function templateScheduleHint(template: (typeof templates)[number]) {
  if (template.frequency === 'daily') return `每天 ${template.time}`;
  if (template.frequency === 'weekly') return `每周${(template.weekdays ?? []).map((day) => weekdayLabels[day]).join('、')} ${template.time}`;
  return `每月 ${template.dayOfMonth ?? 1} 日 ${template.time}`;
}

function resetForm() {
  form.value = { name: '', prompt: '', employeeId: 'general', modelId: props.models[0]?.id ?? '', skillIds: [], kind: 'recurring', at: '', frequency: 'daily', time: '09:00', weekdays: [1], dayOfMonth: 1 };
}

function startCreate(blank = false) {
  error.value = '';
  creating.value = true;
  if (blank) {
    resetForm();
    createStep.value = 'configure';
  } else {
    createStep.value = 'pick';
  }
}

function cancelCreate() {
  creating.value = false;
  createStep.value = 'pick';
  error.value = '';
}

function applyTemplate(template: (typeof templates)[number]) {
  form.value = { ...form.value, name: template.name, prompt: template.prompt, employeeId: template.employeeId, kind: 'recurring', frequency: template.frequency, time: template.time, weekdays: template.weekdays ? [...template.weekdays] : [1], dayOfMonth: template.dayOfMonth ?? 1, modelId: form.value.modelId || props.models[0]?.id || '' };
  createStep.value = 'configure';
  creating.value = true;
}

function formatDate(value?: number) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value) : '尚未执行';
}

function scheduleLabel(item: Automation) {
  if (item.schedule.kind === 'once') return `单次 · ${formatDate(item.schedule.at)}`;
  if (item.schedule.kind === 'interval') return `周期 · 每 ${item.schedule.everyMinutes} 分钟`;
  return item.schedule.frequency === 'daily'
    ? `每天 ${item.schedule.time}`
    : item.schedule.frequency === 'weekly'
      ? `每周${(item.schedule.weekdays ?? []).map((day) => weekdayLabels[day]).join('、')} ${item.schedule.time}`
      : `每月 ${item.schedule.dayOfMonth} 日 ${item.schedule.time}`;
}

function runDuration(run: AutomationRun) {
  const end = run.finishedAt ?? Date.now();
  const seconds = Math.max(1, Math.round((end - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function runStatusClass(run: AutomationRun) {
  if (run.status === 'success') return 'bg-emerald-500/10 text-emerald-600';
  if (run.status === 'failed') return 'bg-rose-500/10 text-rose-600';
  return 'bg-[var(--accent-soft)] text-[var(--accent)]';
}

function runStatusText(run: AutomationRun) {
  if (run.status === 'success') return '已完成';
  if (run.status === 'failed') return '失败';
  return '执行中';
}

async function create() {
  const at = new Date(form.value.at).getTime();
  error.value = '';
  const selected = props.models.find((item) => item.id === form.value.modelId);
  if (!form.value.name.trim() || !form.value.prompt.trim() || !selected || (form.value.kind === 'once' && !Number.isFinite(at)) || (form.value.kind === 'recurring' && form.value.frequency === 'weekly' && !form.value.weekdays.length)) {
    error.value = '请填写名称、任务指令、模型和有效的执行时间；每周任务至少选择一天。';
    return;
  }
  const schedule: AutomationSchedule =
    form.value.kind === 'once'
      ? { kind: 'once', at }
      : { kind: 'recurring', frequency: form.value.frequency, time: form.value.time, ...(form.value.frequency === 'weekly' ? { weekdays: form.value.weekdays } : {}), ...(form.value.frequency === 'monthly' ? { dayOfMonth: form.value.dayOfMonth } : {}) };
  await save({ name: form.value.name.trim(), prompt: form.value.prompt.trim(), employeeId: form.value.employeeId, provider: selected.provider as ProviderId, modelId: selected.id, skillIds: [...form.value.skillIds], schedule, enabled: true });
  cancelCreate();
}

function toggleCreateHeader() {
  if (creating.value) cancelCreate();
  else startCreate(false);
}

async function run(item: Automation) {
  running.value = item.id;
  const record = await beginRun(item, 'manual');
  try {
    const transcript = await props.runAutomation(item);
    item.lastRunAt = Date.now();
    item.lastStatus = 'success';
    item.lastError = undefined;
    await Promise.all([update(item), finishRun(record, 'success', undefined, transcript)]);
  } catch (cause) {
    item.lastStatus = 'failed';
    item.lastError = cause instanceof Error ? cause.message : '运行失败';
    await Promise.all([update(item), finishRun(record, 'failed', item.lastError)]);
  } finally {
    running.value = '';
  }
}

function openRun(run: AutomationRun) {
  selectedRun.value = run;
}

function onOpenConversation(id: string) {
  selectedRun.value = null;
  props.openConversation(id);
}

onMounted(async () => {
  await Promise.all([load(), loadRuns(), loadSkills()]);
  form.value.modelId = props.models[0]?.id ?? '';
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col px-6 py-10 sm:px-12 sm:py-12">
      <header class="shrink-0">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">Workmate / AUTOMATION</p>
            <h1 class="mt-2 text-4xl font-bold tracking-[-.045em]">自动化</h1>
            <p class="mt-3 text-[var(--muted)]">在 Workmate 保持运行时，让数字员工按单次或日历周期完成任务。</p>
          </div>
          <button v-if="tab === 'tasks'" class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white" type="button" @click="toggleCreateHeader">{{ creating ? '取消' : '＋ 新增自动化' }}</button>
        </div>
        <div class="mt-6 inline-flex rounded-xl bg-[var(--surface-muted)] p-1">
          <button :class="['rounded-lg px-4 py-2 text-sm font-semibold', tab === 'tasks' ? 'bg-[var(--surface)] shadow-sm' : 'text-[var(--muted)]']" type="button" @click="tab = 'tasks'">定时任务</button>
          <button :class="['rounded-lg px-4 py-2 text-sm font-semibold', tab === 'runs' ? 'bg-[var(--surface)] shadow-sm' : 'text-[var(--muted)]']" type="button" @click="tab = 'runs'">
            运行记录
            <span class="ml-1 rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-xs font-bold">{{ runs.length }}</span>
          </button>
        </div>
      </header>

      <div class="mt-6 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        <template v-if="tab === 'tasks'">
          <!-- 无任务：全屏引导 + 全量模板 -->
          <section v-if="!hasTasks && !creating" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm sm:p-10">
            <div class="mx-auto max-w-2xl text-center">
              <span class="grid mx-auto h-14 w-14 place-items-center rounded-2xl bg-[var(--accent-soft)] text-2xl">⏰</span>
              <h2 class="mt-5 text-2xl font-bold tracking-tight">创建第一个自动化任务</h2>
              <p class="mt-2 text-sm leading-relaxed text-[var(--muted)]">可先空白创建，或从推荐模板快速开始。应用保持运行时，本地调度器会按时触发数字员工。</p>
            </div>
            <button
              class="mx-auto mt-8 flex w-full max-w-2xl items-center gap-4 rounded-2xl border-2 border-dashed border-[var(--accent)]/40 bg-[var(--accent-soft)]/30 p-4 text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/50 sm:p-5"
              type="button"
              @click="startCreate(true)"
            >
              <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[var(--accent)] text-2xl font-light text-white">+</span>
              <span class="min-w-0 flex-1">
                <strong class="text-base font-bold">空白任务</strong>
                <p class="mt-0.5 text-sm text-[var(--muted)]">自行填写名称、任务指令与调度计划</p>
              </span>
              <span class="hidden shrink-0 text-sm font-semibold text-[var(--accent)] sm:inline">开始创建 →</span>
            </button>
            <div class="mt-10 border-t border-[var(--border)] pt-8">
              <div class="mb-4 flex items-end justify-between gap-3">
                <h3 class="text-sm font-bold">推荐模板</h3>
                <span class="text-xs text-[var(--muted)]">{{ templates.length }} 个可选</span>
              </div>
              <div class="grid max-h-[min(52vh,520px)] gap-3 overflow-y-auto overscroll-contain pr-1 md:grid-cols-2">
              <button v-for="template in templates" :key="template.name" class="group rounded-2xl border border-[var(--border)] bg-[var(--background)] p-5 text-left transition hover:border-[var(--accent)] hover:shadow-md" type="button" @click="applyTemplate(template)">
                <div class="flex items-start justify-between gap-2">
                  <strong class="text-base font-bold group-hover:text-[var(--accent)]">{{ template.name }}</strong>
                  <span class="shrink-0 rounded-lg bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">{{ templateScheduleHint(template) }}</span>
                </div>
                <p class="mt-2 line-clamp-3 text-sm leading-relaxed text-[var(--muted)]">{{ template.prompt }}</p>
                <span class="mt-4 inline-flex items-center text-xs font-semibold text-[var(--accent)]">使用此模板 →</span>
              </button>
              </div>
            </div>
          </section>

          <!-- 新建：Step 1 选模板（已有任务时） -->
          <section v-else-if="creating && createStep === 'pick'" class="mb-6 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
            <div class="border-b border-[var(--border)] bg-[var(--surface-muted)]/40 px-6 py-4">
              <p class="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--accent)]">步骤 1 / 2</p>
              <h2 class="mt-1 text-lg font-bold">选择创建方式</h2>
              <p class="mt-1 text-sm text-[var(--muted)]">建议先创建空白任务；也可从下方模板预填指令与周期。</p>
            </div>
            <div class="space-y-5 p-6">
              <button
                class="flex w-full items-center gap-4 rounded-xl border-2 border-dashed border-[var(--accent)]/40 bg-[var(--accent-soft)]/25 p-4 text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/45"
                type="button"
                @click="startCreate(true)"
              >
                <span class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--accent)] text-xl font-light text-white">+</span>
                <span class="min-w-0 flex-1">
                  <strong class="text-sm font-bold">空白任务</strong>
                  <p class="mt-0.5 text-xs text-[var(--muted)]">自行填写名称、指令与调度</p>
                </span>
                <span class="shrink-0 text-xs font-semibold text-[var(--accent)]">开始 →</span>
              </button>
              <div>
                <div class="mb-3 flex items-center justify-between gap-2">
                  <p class="text-xs font-bold uppercase tracking-[.1em] text-[var(--muted)]">模板库</p>
                  <span class="text-[11px] text-[var(--muted)]">{{ templates.length }} 个</span>
                </div>
                <div class="grid max-h-[min(48vh,440px)] gap-3 overflow-y-auto overscroll-contain pr-1 sm:grid-cols-2">
              <button v-for="template in templates" :key="template.name" class="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4 text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/30" type="button" @click="applyTemplate(template)">
                <strong class="text-sm font-bold">{{ template.name }}</strong>
                <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--muted)]">{{ template.prompt }}</p>
                <span class="mt-2 block text-[11px] font-semibold text-[var(--accent)]">{{ templateScheduleHint(template) }}</span>
              </button>
                </div>
              </div>
            </div>
          </section>

          <!-- 新建：Step 2 配置 -->
          <section v-else-if="creating && createStep === 'configure'" class="mb-6 overflow-hidden rounded-2xl border border-[var(--accent)]/30 bg-[var(--surface)] shadow-sm">
            <div class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-muted)]/40 px-6 py-4">
              <div>
                <p class="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--accent)]">{{ hasTasks ? '步骤 2 / 2' : '新建任务' }} · 配置</p>
                <h2 class="mt-1 text-lg font-bold">添加自动化任务</h2>
                <p class="mt-1 text-sm text-[var(--muted)]">确认指令、员工、模型与执行计划后保存。</p>
              </div>
              <div class="flex flex-wrap gap-2">
                <button v-if="hasTasks" class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface)]" type="button" @click="createStep = 'pick'">← 换模板</button>
                <span class="rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-xs font-bold text-[var(--accent)]">本地调度</span>
              </div>
            </div>
            <div class="p-6">
              <details v-if="hasTasks" class="mb-5 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-3">
                <summary class="cursor-pointer text-xs font-semibold text-[var(--muted)]">从其他模板快速替换</summary>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button v-for="template in templates" :key="`chip-${template.name}`" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[11px] font-medium transition hover:border-[var(--accent)]" type="button" @click="applyTemplate(template)">{{ template.name }}</button>
                </div>
              </details>
            <div class="grid gap-4 md:grid-cols-2">
              <label class="grid gap-1.5 text-sm font-semibold">名称<input v-model="form.name" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal outline-none focus:border-[var(--accent)]" placeholder="例如：每日行业简报"></label>
              <label class="grid gap-1.5 text-sm font-semibold">数字员工<select v-model="form.employeeId" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal"><option v-for="employee in employees" :key="employee.id" :value="employee.id">{{ employeeDisplayName(employee, t) }}</option></select></label>
              <label class="grid gap-1.5 text-sm font-semibold md:col-span-2">任务指令<textarea v-model="form.prompt" rows="4" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal outline-none focus:border-[var(--accent)]" placeholder="例如：汇总今天的项目风险，并生成一份 Markdown 简报。"></textarea></label>
              <label class="grid gap-1.5 text-sm font-semibold">对话模型<select v-model="form.modelId" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal"><option disabled value="">选择已配置模型</option><option v-for="model in models" :key="model.id" :value="model.id">{{ chatEndpointLabel(model) }}</option></select></label>
              <div class="grid gap-1.5 text-sm font-semibold"><span>调度方式</span><div class="flex gap-2"><button :class="['rounded-lg px-3 py-2 text-sm', form.kind === 'once' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)]']" type="button" @click="form.kind = 'once'">单次</button><button :class="['rounded-lg px-3 py-2 text-sm', form.kind === 'recurring' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)]']" type="button" @click="form.kind = 'recurring'">周期</button></div></div>
              <label v-if="form.kind === 'once'" class="grid gap-1.5 text-sm font-semibold"><span>执行时间</span><input v-model="form.at" type="datetime-local" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal"></label>
              <template v-else>
                <label class="grid gap-1.5 text-sm font-semibold"><span>周期</span><select v-model="form.frequency" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal"><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
                <label class="grid gap-1.5 text-sm font-semibold"><span>执行时间</span><input v-model="form.time" type="time" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal"></label>
                <fieldset v-if="form.frequency === 'weekly'" class="md:col-span-2"><legend class="text-sm font-semibold">执行日期</legend><div class="mt-2 flex flex-wrap gap-2"><label v-for="(label, day) in weekdayLabels" :key="day" :class="['cursor-pointer rounded-lg border px-3 py-2 text-xs', form.weekdays.includes(day) ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)]']"><input v-model="form.weekdays" class="sr-only" type="checkbox" :value="day">{{ label }}</label></div></fieldset>
                <label v-if="form.frequency === 'monthly'" class="grid gap-1.5 text-sm font-semibold"><span>每月日期</span><select v-model.number="form.dayOfMonth" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal"><option v-for="day in 28" :key="day" :value="day">每月 {{ day }} 日</option></select></label>
              </template>
              <fieldset class="md:col-span-2"><legend class="text-sm font-semibold">附加技能 <span class="font-normal text-[var(--muted)]">（仅显示该员工已授权能力）</span></legend><div class="mt-2 flex flex-wrap gap-2"><label v-for="skill in availableSkills" :key="skill.id" :class="['cursor-pointer rounded-lg border px-3 py-2 text-xs', form.skillIds.includes(skill.id) ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)]']"><input v-model="form.skillIds" class="sr-only" type="checkbox" :value="skill.id">{{ skill.name }}</label></div></fieldset>
            </div>
            <p v-if="error" class="mt-4 text-sm text-rose-600">{{ error }}</p>
            <div class="mt-6 flex justify-end gap-3"><button class="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold" type="button" @click="cancelCreate">取消</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white" type="button" @click="create">保存自动化</button></div>
            </div>
          </section>

          <!-- 已有任务：任务列表为主 -->
          <section v-if="hasTasks && !creating" class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
              <div>
                <h2 class="text-sm font-bold">我的定时任务</h2>
                <p class="text-xs text-[var(--muted)]">共 {{ automations.length }} 项 · 开关控制是否参与本地调度</p>
              </div>
            </div>
            <article v-for="item in automations" :key="item.id" class="flex flex-wrap items-center gap-4 border-b border-[var(--border)] p-5 last:border-0">
              <button :class="['h-5 w-9 rounded-full p-0.5 transition-colors', item.enabled ? 'bg-emerald-500' : 'bg-slate-300']" type="button" @click="item.enabled = !item.enabled; update(item)"><span :class="['block h-4 w-4 rounded-full bg-white transition-transform', item.enabled ? 'translate-x-4' : 'translate-x-0']"></span></button>
              <div class="min-w-[220px] flex-1"><h2 class="font-bold">{{ item.name }}</h2><p class="mt-1 truncate text-sm text-[var(--muted)]">{{ item.prompt }}</p><p class="mt-2 text-xs text-[var(--muted)]">{{ scheduleLabel(item) }} · 下次 {{ item.enabled ? formatDate(item.nextRunAt) : '已暂停' }} · {{ item.skillIds.length }} 个技能</p></div>
              <span :class="item.lastStatus === 'failed' ? 'text-rose-600' : 'text-xs text-[var(--muted)]'">{{ item.lastStatus === 'failed' ? '上次失败' : '上次执行' }}：{{ formatDate(item.lastRunAt) }}</span>
              <div class="flex gap-2"><button class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold disabled:opacity-50" type="button" :disabled="running === item.id" @click="run(item)">{{ running === item.id ? '执行中…' : '立即运行' }}</button><button class="rounded-lg px-2 py-2 text-xs text-rose-600 hover:bg-rose-500/10" type="button" @click="remove(item.id)">删除</button></div>
            </article>
          </section>
        </template>

        <section v-else class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div v-if="!runs.length" class="px-6 py-20 text-center">
            <span class="grid mx-auto h-14 w-14 place-items-center rounded-2xl bg-[var(--surface-muted)] text-2xl">⏱</span>
            <p class="mt-4 text-sm font-medium">尚无运行记录</p>
            <p class="mt-1 text-xs text-[var(--muted)]">手动或定时执行后会保留在这里，点击可查看对话与执行日志。</p>
          </div>
          <ul v-else class="divide-y divide-[var(--border)]">
            <li v-for="run in runs" :key="run.id">
              <button class="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-[var(--surface-muted)]" type="button" @click="openRun(run)">
                <span :class="['grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold', runStatusClass(run)]">{{ run.status === 'success' ? '✓' : run.status === 'failed' ? '!' : '…' }}</span>
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-center gap-2">
                    <strong class="text-sm">{{ run.automationName }}</strong>
                    <span :class="['rounded-md px-2 py-0.5 text-[10px] font-semibold', runStatusClass(run)]">{{ runStatusText(run) }}</span>
                  </span>
                  <span class="mt-1 block text-xs text-[var(--muted)]">{{ run.trigger === 'manual' ? '手动运行' : '计划触发' }} · {{ run.employeeId }} · {{ run.provider }} · {{ formatDate(run.startedAt) }} · {{ runDuration(run) }}</span>
                  <span v-if="run.transcript?.activities.length" class="mt-1 block text-xs text-[var(--accent)]">{{ run.transcript.activities.length }} 步工具执行 · 点击查看详情</span>
                  <span v-else-if="run.error" class="mt-1 block text-xs text-rose-600">{{ run.error }}</span>
                </span>
                <span class="shrink-0 text-lg text-[var(--muted)]" aria-hidden="true">›</span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <AutomationRunDetail
      v-if="selectedRun"
      :run="selectedRun"
      :employees="employees"
      :conversations="conversations"
      :automations="automations"
      @close="selectedRun = null"
      @open-conversation="onOpenConversation"
    />
  </section>
</template>
