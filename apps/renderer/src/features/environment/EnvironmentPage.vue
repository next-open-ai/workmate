<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { runEnvironmentFix, type EnvFixActionId } from '../../services/api.js';
import { environmentState, runEnvironmentCheck } from '../../services/environment.js';
import {
  buildRemediationPack,
  detectPlatform,
  remediationForCheck,
} from '../../services/environment-remediation.js';
import DshInstallProgressPanel from '../dsh/DshInstallProgressPanel.vue';
import {
  DSH_ENV_CHECK_ID,
  DSH_ENV_FIX_ACTION_ID,
  dshInstallState,
  installDshRuntimeWithProgress,
} from '../dsh';

/**
 * 「环境检查」页面：启动时体检结果的可视化，
 * 缺项给出可执行的修复指引、一键修复与 Docker 片段；支持返回上一层。
 */

const emit = defineEmits<{ close: []; back: [] }>();

const report = computed(() => environmentState.report.value);
const runStatus = computed(() => environmentState.runStatus.value);
const errorMessage = computed(() => environmentState.errorMessage.value);
const pack = computed(() => buildRemediationPack(report.value));
const platformKind = computed(() => detectPlatform(report.value?.platform || ''));
const copiedKey = ref('');
const fixingId = ref('');
const fixMessage = ref('');
const fixError = ref('');
const expandedIds = ref<Set<string>>(new Set());

const stateMeta: Record<'ok' | 'warn' | 'error', { label: string; badge: string; rail: string; soft: string }> = {
  ok: { label: '正常', badge: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400', rail: 'bg-emerald-500', soft: 'border-emerald-500/20' },
  warn: { label: '建议处理', badge: 'bg-amber-500/12 text-amber-700 dark:text-amber-400', rail: 'bg-amber-500', soft: 'border-amber-500/25' },
  error: { label: '需要处理', badge: 'bg-rose-500/12 text-rose-700 dark:text-rose-400', rail: 'bg-rose-500', soft: 'border-rose-500/25' },
};

const overall = computed(() => {
  const summary = report.value?.summary;
  if (!summary) return { label: '尚未检查', tone: 'text-[var(--muted)]', bar: 'bg-[var(--border)]' };
  if (summary.error > 0) return { label: '有待处理项', tone: 'text-rose-600', bar: 'bg-rose-500' };
  if (summary.warn > 0) return { label: '建议优化', tone: 'text-amber-600', bar: 'bg-amber-500' };
  return { label: '环境就绪', tone: 'text-emerald-600', bar: 'bg-emerald-500' };
});

const okRatio = computed(() => {
  const total = report.value?.summary.total ?? 0;
  if (!total) return 0;
  return Math.round(((report.value?.summary.ok ?? 0) / total) * 100);
});

const installingDsh = computed(() => dshInstallState.busy.value || (
  dshInstallState.phase.value !== 'idle'
  && dshInstallState.source.value === 'manual'
));

function isExpanded(id: string) {
  if (fixingId.value === id) return true;
  if (id === DSH_ENV_CHECK_ID && installingDsh.value) return true;
  return expandedIds.value.has(id);
}

function toggleExpanded(id: string) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

async function rerun() {
  fixMessage.value = '';
  fixError.value = '';
  await runEnvironmentCheck();
  seedExpanded();
}

function seedExpanded() {
  const ids = (report.value?.checks ?? [])
    .filter((check) => check.status !== 'ok')
    .map((check) => check.id);
  expandedIds.value = new Set(ids.slice(0, 1));
}

function remediation(check: NonNullable<typeof report.value>['checks'][number]) {
  return remediationForCheck(check, report.value);
}

async function copyScript(id: string, script?: string) {
  if (!script) return;
  try {
    await navigator.clipboard.writeText(script);
    copiedKey.value = id;
    window.setTimeout(() => { if (copiedKey.value === id) copiedKey.value = ''; }, 1600);
  } catch {
    copiedKey.value = '';
  }
}

function applyReport(next: NonNullable<typeof report.value>) {
  environmentState.report.value = next;
  environmentState.progressRows.value = next.checks.map((item) => ({
    id: item.id,
    name: item.name,
    required: item.required,
    state: 'done' as const,
    status: item.status,
    found: item.found,
  }));
  seedExpanded();
}

async function applyFix(actionId: EnvFixActionId, uiKey: string) {
  fixingId.value = uiKey;
  fixMessage.value = '';
  fixError.value = '';
  try {
    if (actionId === DSH_ENV_FIX_ACTION_ID) {
      const { demoteDshEmployeesToPi } = await import('../dsh/engine-fallback');
      await demoteDshEmployeesToPi().catch(() => undefined);
      const result = await installDshRuntimeWithProgress({ reinstall: true, source: 'manual' });
      if (result.report) applyReport(result.report);
      else await runEnvironmentCheck();
      fixMessage.value = result.message;
      return;
    }
    const result = await runEnvironmentFix(actionId);
    if (result.report) applyReport(result.report);
    else await runEnvironmentCheck();
    fixMessage.value = result.message;
  } catch (cause) {
    fixError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    fixingId.value = '';
  }
}

async function applyAllAutoFixes() {
  const ids = pack.value?.autoFixIds ?? [];
  for (const id of ids) {
    await applyFix(id, `all:${id}`);
    if (fixError.value) break;
  }
}

function goBack() {
  emit('back');
  emit('close');
}

onMounted(async () => {
  await runEnvironmentCheck();
  seedExpanded();
});
</script>

<template>
  <section class="relative flex h-full flex-col overflow-hidden">
    <div
      class="pointer-events-none absolute inset-0 opacity-80"
      aria-hidden="true"
      style="background:
        radial-gradient(ellipse 70% 45% at 12% -10%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 55%),
        radial-gradient(ellipse 50% 40% at 90% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 50%),
        linear-gradient(180deg, color-mix(in srgb, var(--surface-muted) 55%, transparent), transparent 42%);"
    />

    <header class="relative z-10 shrink-0 border-b border-[var(--border)]/80 bg-[var(--surface)]/80 px-5 py-3 backdrop-blur-md sm:px-8">
      <div class="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <button
            class="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--muted)] transition hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
            type="button"
            @click="goBack"
          >
            <span aria-hidden="true">←</span>
            返回
          </button>
          <div class="min-w-0">
            <p class="text-[10px] font-bold tracking-[0.16em] text-[var(--accent)]">ENVIRONMENT</p>
            <h1 class="truncate text-lg font-semibold tracking-tight sm:text-xl">环境检查</h1>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)] disabled:opacity-60"
            type="button"
            :disabled="runStatus === 'checking' || Boolean(fixingId)"
            @click="rerun"
          >
            {{ runStatus === 'checking' ? '检查中…' : '重新检查' }}
          </button>
          <button
            class="grid h-9 w-9 place-items-center rounded-lg text-lg text-[var(--muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
            type="button"
            aria-label="关闭"
            title="关闭"
            @click="goBack"
          >
            ×
          </button>
        </div>
      </div>
    </header>

    <div class="relative z-10 min-h-0 flex-1 overflow-auto px-5 py-6 sm:px-8">
      <div class="mx-auto flex max-w-4xl flex-col gap-5">
        <!-- 总体状态 -->
        <div
          v-if="report"
          class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]/90 shadow-[0_12px_40px_-28px_rgba(15,23,42,0.45)]"
        >
          <div class="flex flex-wrap items-end justify-between gap-4 px-5 py-4 sm:px-6">
            <div>
              <p :class="['text-sm font-semibold', overall.tone]">{{ overall.label }}</p>
              <p class="mt-1 text-xs text-[var(--muted)]">
                {{ report.platform }} · {{ report.summary.ok }}/{{ report.summary.total }} 项正常
                <span v-if="report.checkedAt"> · {{ new Date(report.checkedAt).toLocaleString() }}</span>
              </p>
            </div>
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="rounded-full bg-emerald-500/10 px-2.5 py-1 font-semibold text-emerald-700 dark:text-emerald-400">正常 {{ report.summary.ok }}</span>
              <span class="rounded-full bg-amber-500/10 px-2.5 py-1 font-semibold text-amber-700 dark:text-amber-400">建议 {{ report.summary.warn }}</span>
              <span class="rounded-full bg-rose-500/10 px-2.5 py-1 font-semibold text-rose-700 dark:text-rose-400">需处理 {{ report.summary.error }}</span>
            </div>
          </div>
          <div class="h-1.5 bg-[var(--surface-muted)]">
            <div
              class="h-full rounded-r-full transition-all duration-500"
              :class="overall.bar"
              :style="{ width: `${Math.max(okRatio, report.summary.total ? 4 : 0)}%` }"
            />
          </div>
        </div>

        <!-- Agent 脚本 Python 决策 -->
        <div
          v-if="report?.pythonDecision"
          class="rounded-2xl border border-[var(--border)] bg-[var(--surface)]/90 px-5 py-4 shadow-sm sm:px-6"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-[10px] font-bold tracking-[.12em] text-[var(--accent)]">AGENT 脚本环境</p>
              <h2 class="mt-1 text-sm font-semibold">当前选用的 Python</h2>
              <p class="mt-1 text-xs text-[var(--muted)]">
                策略：系统 ≥ 3.9 优先；否则回退预装 agentscope-runtime。脚本依赖与引擎环境隔离。
              </p>
            </div>
            <span
              :class="[
                'rounded-full px-2.5 py-1 text-[10px] font-bold',
                report.pythonDecision.source === 'system' || report.pythonDecision.source === 'override'
                  ? 'bg-emerald-500/12 text-emerald-700'
                  : report.pythonDecision.source === 'bundled'
                    ? 'bg-amber-500/12 text-amber-700'
                    : 'bg-rose-500/12 text-rose-700',
              ]"
            >
              {{
                report.pythonDecision.source === 'system' ? '系统 Python'
                  : report.pythonDecision.source === 'bundled' ? '预装 Runtime'
                    : report.pythonDecision.source === 'override' ? '环境变量覆盖'
                      : '不可用'
              }}
            </span>
          </div>
          <dl class="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt class="text-[var(--muted)]">选用解释器</dt>
              <dd class="mt-0.5 break-all font-medium">{{ report.pythonDecision.command || '—' }} {{ report.pythonDecision.version || '' }}</dd>
            </div>
            <div>
              <dt class="text-[var(--muted)]">系统探测</dt>
              <dd class="mt-0.5 break-all font-medium">{{ report.pythonDecision.systemFound || '未检测到' }}</dd>
            </div>
            <div>
              <dt class="text-[var(--muted)]">预装 Runtime</dt>
              <dd class="mt-0.5 break-all font-medium">{{ report.pythonDecision.bundledFound || '未检测到' }}</dd>
            </div>
            <div>
              <dt class="text-[var(--muted)]">依赖隔离</dt>
              <dd class="mt-0.5 font-medium">工作区 .python-packages（不写 agentscope-runtime）</dd>
            </div>
          </dl>
          <p class="mt-3 rounded-xl bg-[var(--surface-muted)] px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
            {{ report.pythonDecision.reason }}
          </p>
          <p class="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
            {{ report.pythonDecision.isolationNote }}
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-if="!platformKind.docker && report.pythonDecision.source !== 'system'"
              class="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
              type="button"
              :disabled="Boolean(fixingId)"
              @click="applyFix('install-python', 'install-python')"
            >
              {{ fixingId === 'install-python' ? '正在安装…' : '尝试安装系统 Python 3.12' }}
            </button>
            <button
              v-if="(report.workspaceScrap?.totalBytes ?? 0) > 0"
              class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)] disabled:opacity-60"
              type="button"
              :disabled="Boolean(fixingId)"
              @click="applyFix('clean-workspace-scrap', 'clean-workspace-scrap')"
            >
              {{ fixingId === 'clean-workspace-scrap' ? '清理中…' : `清理临时脚本/依赖（${report.workspaceScrap?.totalBytesLabel || ''}）` }}
            </button>
            <button
              v-if="report.workspaceScrap?.manualHelp"
              class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]"
              type="button"
              @click="copyScript('scrap-manual', report.workspaceScrap.manualHelp)"
            >
              {{ copiedKey === 'scrap-manual' ? '已复制' : '复制手动清理说明' }}
            </button>
          </div>
        </div>

        <div v-if="runStatus === 'checking' && !report" class="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/80 px-5 py-4 text-sm text-[var(--muted)]">
          <span class="h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
          正在检查本地环境…
        </div>

        <div v-if="fixMessage" class="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
          {{ fixMessage }}
        </div>
        <div v-if="fixError" class="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-400">
          {{ fixError }}
        </div>
        <div v-if="errorMessage" class="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-400">
          检查失败：{{ errorMessage }}
        </div>

        <!-- 安装进度置顶（安装中吸顶，完成后仍可回看） -->
        <div
          v-if="dshInstallState.busy.value || dshInstallState.phase.value !== 'idle'"
          :class="dshInstallState.busy.value ? 'sticky top-0 z-20' : ''"
        >
          <DshInstallProgressPanel />
        </div>

        <!-- 修复工具包 -->
        <div v-if="pack && pack.problems > 0" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)]/90 px-5 py-4 sm:px-6">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold">修复工具包 · {{ pack.problems }} 项</h2>
              <p class="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">
                可复制主机 / Docker 脚本。白名单可自动修复（数据目录、ensurepip、AgentScope、安装 Python、清理临时脚本）。dsh 体积约 200MB，请单项安装并查看进度。
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                v-if="pack.autoFixIds.length"
                class="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                type="button"
                :disabled="Boolean(fixingId)"
                @click="applyAllAutoFixes"
              >
                {{ fixingId.startsWith('all:') ? '修复中…' : `一键修复可自动项（${pack.autoFixIds.length}）` }}
              </button>
              <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="copyScript('pack-host', pack.hostScript)">
                {{ copiedKey === 'pack-host' ? '已复制' : '复制主机脚本' }}
              </button>
              <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="copyScript('pack-docker', pack.dockerSnippet)">
                {{ copiedKey === 'pack-docker' ? '已复制' : 'Dockerfile' }}
              </button>
              <button
                v-if="platformKind.docker"
                class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]"
                type="button"
                @click="copyScript('pack-compose', pack.composeSnippet)"
              >
                {{ copiedKey === 'pack-compose' ? '已复制' : 'Compose' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 检查项列表 -->
        <div class="grid gap-3">
          <article
            v-for="check in report?.checks ?? []"
            :key="check.id"
            :class="[
              'overflow-hidden rounded-2xl border bg-[var(--surface)]/95 transition-shadow',
              stateMeta[check.status].soft,
              check.status === 'ok' ? 'border-[var(--border)]' : 'shadow-[0_10px_30px_-24px_rgba(15,23,42,0.55)]',
            ]"
          >
            <div class="flex">
              <div :class="['w-1 shrink-0 self-stretch', stateMeta[check.status].rail]" />
              <div class="min-w-0 flex-1 p-4 sm:p-5">
                <div class="flex items-start justify-between gap-3">
                  <button
                    class="min-w-0 flex-1 text-left"
                    type="button"
                    @click="check.status !== 'ok' ? toggleExpanded(check.id) : undefined"
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <h2 class="text-[15px] font-semibold tracking-tight">{{ check.name }}</h2>
                      <span :class="['rounded-full px-2 py-0.5 text-[11px] font-semibold', stateMeta[check.status].badge]">
                        {{ stateMeta[check.status].label }}
                      </span>
                    </div>
                    <p class="mt-1.5 text-xs leading-5 text-[var(--muted)]">
                      要求 {{ check.required }}
                      <span class="mx-1.5 text-[var(--border)]">·</span>
                      当前 <span class="font-medium text-[var(--text)]">{{ check.found }}</span>
                    </p>
                  </button>
                  <div class="flex shrink-0 items-center gap-2">
                    <button
                      v-if="check.status !== 'ok' && remediation(check)?.canAutoFix && remediation(check)?.actionId"
                      class="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-60"
                      type="button"
                      :disabled="Boolean(fixingId) || dshInstallState.busy.value"
                      @click="applyFix(remediation(check)!.actionId!, check.id)"
                    >
                      {{
                        fixingId === check.id || (check.id === DSH_ENV_CHECK_ID && dshInstallState.busy.value)
                          ? (check.id === DSH_ENV_CHECK_ID ? '安装中…' : '修复中…')
                          : '一键修复'
                      }}
                    </button>
                    <button
                      v-if="check.status !== 'ok'"
                      class="grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-muted)]"
                      type="button"
                      :aria-expanded="isExpanded(check.id)"
                      :aria-label="isExpanded(check.id) ? '收起说明' : '展开说明'"
                      @click="toggleExpanded(check.id)"
                    >
                      <span class="text-xs font-bold transition-transform" :class="isExpanded(check.id) ? 'rotate-180' : ''">▾</span>
                    </button>
                  </div>
                </div>

                <p v-if="check.status === 'ok'" class="mt-2 text-xs leading-5 text-[var(--muted)]">
                  {{ check.help }}
                </p>

                <div v-else-if="isExpanded(check.id)" class="mt-4 space-y-3 border-t border-[var(--border)]/70 pt-4">
                  <ul class="space-y-1.5 text-sm leading-6 text-[var(--muted)]">
                    <li v-for="(line, index) in check.help.split('\n').filter((item) => item.trim())" :key="index" class="flex gap-2">
                      <span class="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]/70" />
                      <code
                        v-if="/^(brew |winget |sudo |xcode-select |python |chmod |dnf |apt |mkdir |cd |npm )/.test(line.trim())"
                        class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--text)]"
                      >{{ line.trim() }}</code>
                      <span v-else>{{ line.trim() }}</span>
                    </li>
                  </ul>

                  <div v-if="remediation(check)" class="rounded-xl bg-[var(--surface-muted)]/55 px-4 py-3">
                    <p class="text-sm font-semibold">{{ remediation(check)?.summary }}</p>
                    <ul class="mt-2 space-y-1 text-xs leading-5 text-[var(--muted)]">
                      <li v-for="(line, index) in remediation(check)?.steps ?? []" :key="`step-${index}`">{{ line }}</li>
                    </ul>
                    <ul v-if="remediation(check)?.logic?.length" class="mt-2 space-y-1 border-t border-[var(--border)]/60 pt-2 text-xs leading-5 text-[var(--muted)]">
                      <li v-for="(line, index) in remediation(check)?.logic ?? []" :key="`logic-${index}`">{{ line }}</li>
                    </ul>

                    <div v-if="remediation(check)?.script" class="mt-3">
                      <div class="mb-1.5 flex items-center justify-between gap-2">
                        <p class="text-[11px] font-semibold tracking-wide text-[var(--muted)]">建议脚本</p>
                        <button
                          class="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--surface)]"
                          type="button"
                          @click="copyScript(check.id, remediation(check)?.script)"
                        >
                          {{ copiedKey === check.id ? '已复制' : '复制' }}
                        </button>
                      </div>
                      <pre class="overflow-auto rounded-xl bg-[#0f172a] p-3 text-[11px] leading-relaxed text-slate-100"><code>{{ remediation(check)?.script }}</code></pre>
                    </div>

                    <div v-if="remediation(check)?.dockerSnippet" class="mt-3">
                      <div class="mb-1.5 flex items-center justify-between gap-2">
                        <p class="text-[11px] font-semibold tracking-wide text-[var(--muted)]">Dockerfile</p>
                        <button
                          class="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--surface)]"
                          type="button"
                          @click="copyScript(`${check.id}-docker`, remediation(check)?.dockerSnippet)"
                        >
                          {{ copiedKey === `${check.id}-docker` ? '已复制' : '复制' }}
                        </button>
                      </div>
                      <pre class="overflow-auto rounded-xl bg-[#0f172a] p-3 text-[11px] leading-relaxed text-slate-100"><code>{{ remediation(check)?.dockerSnippet }}</code></pre>
                    </div>

                    <div v-if="remediation(check)?.composeSnippet" class="mt-3">
                      <div class="mb-1.5 flex items-center justify-between gap-2">
                        <p class="text-[11px] font-semibold tracking-wide text-[var(--muted)]">Compose</p>
                        <button
                          class="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--surface)]"
                          type="button"
                          @click="copyScript(`${check.id}-compose`, remediation(check)?.composeSnippet)"
                        >
                          {{ copiedKey === `${check.id}-compose` ? '已复制' : '复制' }}
                        </button>
                      </div>
                      <pre class="overflow-auto rounded-xl bg-[#0f172a] p-3 text-[11px] leading-relaxed text-slate-100"><code>{{ remediation(check)?.composeSnippet }}</code></pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </div>

        <p v-if="report?.checks.length === 0" class="py-10 text-center text-sm text-[var(--muted)]">暂无检查结果。</p>
      </div>
    </div>
  </section>
</template>
