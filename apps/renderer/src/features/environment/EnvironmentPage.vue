<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { runEnvironmentFix, type EnvFixActionId } from '../../services/api.js';
import { environmentState, runEnvironmentCheck } from '../../services/environment.js';
import {
  buildRemediationPack,
  detectPlatform,
  remediationForCheck,
} from '../../services/environment-remediation.js';

/**
 * 「环境检查」页面：启动时体检结果的可视化（Python/工具链/数据目录），
 * 缺项给出可执行的修复指引、一键修复与 Docker 片段。
 */

const report = computed(() => environmentState.report.value);
const runStatus = computed(() => environmentState.runStatus.value);
const errorMessage = computed(() => environmentState.errorMessage.value);
const pack = computed(() => buildRemediationPack(report.value));
const platformKind = computed(() => detectPlatform(report.value?.platform || ''));
const copiedKey = ref('');
const fixingId = ref('');
const fixMessage = ref('');
const fixError = ref('');

const stateMeta: Record<'ok' | 'warn' | 'error', { label: string; badge: string; dot: string }> = {
  ok: { label: '正常', badge: 'bg-emerald-500/10 text-emerald-600', dot: 'bg-emerald-500' },
  warn: { label: '建议处理', badge: 'bg-amber-500/10 text-amber-600', dot: 'bg-amber-500' },
  error: { label: '需要处理', badge: 'bg-rose-500/10 text-rose-600', dot: 'bg-rose-500' },
};

const statusText = {
  idle: '尚未检查',
  checking: '检查中…',
  ready: '已检查',
};

async function rerun() {
  fixMessage.value = '';
  fixError.value = '';
  await runEnvironmentCheck();
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

async function applyFix(actionId: EnvFixActionId, uiKey: string) {
  fixingId.value = uiKey;
  fixMessage.value = '';
  fixError.value = '';
  try {
    const result = await runEnvironmentFix(actionId);
    if (result.report) {
      environmentState.report.value = result.report;
      environmentState.progressRows.value = result.report.checks.map((item) => ({
        id: item.id,
        name: item.name,
        required: item.required,
        state: 'done' as const,
        status: item.status,
        found: item.found,
      }));
    } else {
      await runEnvironmentCheck();
    }
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

onMounted(() => {
  void runEnvironmentCheck();
});
</script>

<template>
  <section class="mx-auto flex h-full max-w-4xl flex-col overflow-auto px-6 py-8 sm:px-10">
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="text-[11px] font-extrabold uppercase tracking-[.13em] text-[var(--accent)]">Workmate / ENVIRONMENT</p>
        <h1 class="mt-1 text-3xl font-bold tracking-[-.03em]">环境检查</h1>
        <p class="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          检查项会按桌面、Web、Docker 运行形态调整。缺项会给出详细说明、建议脚本；对可安全处理的项支持一键修复；Docker 另提供 Dockerfile / Compose 片段。
        </p>
      </div>
      <button
        class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        type="button"
        :disabled="runStatus === 'checking' || Boolean(fixingId)"
        @click="rerun"
      >
        重新检查
      </button>
    </header>

    <div v-if="runStatus === 'checking'" class="mb-4 text-sm text-[var(--muted)]">正在检查本地环境…</div>
    <div v-if="fixMessage" class="mb-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">{{ fixMessage }}</div>
    <div v-if="fixError" class="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-600">修复失败：{{ fixError }}</div>

    <!-- 汇总条 -->
    <div v-if="report" class="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
      <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-center">
        <p class="text-2xl font-bold">{{ report.summary.total }}</p>
        <p class="text-xs text-[var(--muted)]">检查项</p>
      </div>
      <div class="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-center">
        <p class="text-2xl font-bold text-emerald-600">{{ report.summary.ok }}</p>
        <p class="text-xs text-[var(--muted)]">正常</p>
      </div>
      <div class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-center">
        <p class="text-2xl font-bold text-amber-600">{{ report.summary.warn }}</p>
        <p class="text-xs text-[var(--muted)]">建议</p>
      </div>
      <div class="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-center">
        <p class="text-2xl font-bold text-rose-600">{{ report.summary.error }}</p>
        <p class="text-xs text-[var(--muted)]">需处理</p>
      </div>
      <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-center">
        <p class="text-sm font-semibold">{{ report.platform }}</p>
        <p class="text-xs text-[var(--muted)]">{{ statusText[runStatus] }}</p>
      </div>
    </div>

    <div v-if="errorMessage" class="mb-4 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-600">
      检查失败：{{ errorMessage }}
    </div>

    <div v-if="pack" class="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="font-semibold">修复工具包（{{ pack.problems }} 项）</h2>
          <p class="mt-1 text-xs text-[var(--muted)]">
            可复制主机脚本；Docker 场景请优先改镜像/Compose。白名单一键修复：数据目录、ensurepip、AgentScope init。dsh 编码引擎请单项安装（体积较大）。
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
            {{ copiedKey === 'pack-docker' ? '已复制' : '复制 Dockerfile 片段' }}
          </button>
          <button v-if="platformKind.docker" class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="copyScript('pack-compose', pack.composeSnippet)">
            {{ copiedKey === 'pack-compose' ? '已复制' : '复制 Compose 片段' }}
          </button>
        </div>
      </div>
      <details class="mt-3">
        <summary class="cursor-pointer text-xs font-semibold text-[var(--accent)]">预览主机脚本</summary>
        <pre class="mt-2 overflow-auto rounded-lg bg-[#0b1020] p-3 text-xs leading-relaxed text-slate-100"><code>{{ pack.hostScript }}</code></pre>
      </details>
      <details v-if="platformKind.docker || pack.dockerSnippet.includes('RUN ')" class="mt-2">
        <summary class="cursor-pointer text-xs font-semibold text-[var(--accent)]">预览 Dockerfile 片段</summary>
        <pre class="mt-2 overflow-auto rounded-lg bg-[#0b1020] p-3 text-xs leading-relaxed text-slate-100"><code>{{ pack.dockerSnippet }}</code></pre>
      </details>
      <details v-if="platformKind.docker" class="mt-2">
        <summary class="cursor-pointer text-xs font-semibold text-[var(--accent)]">预览 Compose 挂载示例</summary>
        <pre class="mt-2 overflow-auto rounded-lg bg-[#0b1020] p-3 text-xs leading-relaxed text-slate-100"><code>{{ pack.composeSnippet }}</code></pre>
      </details>
    </div>

    <div class="grid gap-3">
      <div
        v-for="check in report?.checks ?? []"
        :key="check.id"
        class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span :class="['h-2.5 w-2.5 shrink-0 rounded-full', stateMeta[check.status].dot]" />
              <h2 class="truncate font-semibold">{{ check.name }}</h2>
              <span :class="['shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', stateMeta[check.status].badge]">
                {{ stateMeta[check.status].label }}
              </span>
            </div>
            <p class="mt-1 text-sm text-[var(--muted)]">要求：{{ check.required }}</p>
            <p class="mt-0.5 text-sm">
              <template v-if="check.command">检测命令：<code class="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-xs">{{ check.command }}</code> · </template>
              当前：<span class="font-medium">{{ check.found }}</span>
            </p>
          </div>
          <button
            v-if="check.status !== 'ok' && remediation(check)?.canAutoFix && remediation(check)?.actionId"
            class="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
            type="button"
            :disabled="Boolean(fixingId)"
            @click="applyFix(remediation(check)!.actionId!, check.id)"
          >
            {{ fixingId === check.id ? '修复中…' : '一键修复' }}
          </button>
        </div>
        <details v-if="check.status !== 'ok'" class="mt-3 rounded-lg bg-[var(--surface-muted)]/60 px-3 py-2 text-sm" open>
          <summary class="cursor-pointer font-medium text-[var(--accent)]">如何修复（点击展开）</summary>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-[var(--muted)]">
            <li v-for="(line, index) in check.help.split('\n').filter((item) => item.trim())" :key="index">
              <code v-if="line.trim().startsWith('brew ') || line.trim().startsWith('winget ') || line.trim().startsWith('sudo ') || line.trim().startsWith('xcode-select ') || line.trim().startsWith('python ') || line.trim().startsWith('chmod ') || line.trim().startsWith('dnf ') || line.trim().startsWith('apt')" class="rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">{{ line.trim() }}</code>
              <template v-else>{{ line.trim() }}</template>
            </li>
          </ul>
          <div v-if="remediation(check)" class="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
            <p class="text-sm font-semibold">{{ remediation(check)?.summary }}</p>
            <ul class="mt-2 list-disc space-y-1 pl-5 text-[var(--muted)]">
              <li v-for="(line, index) in remediation(check)?.steps ?? []" :key="`step-${index}`">{{ line }}</li>
            </ul>
            <div v-if="remediation(check)?.logic?.length" class="mt-3">
              <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">处理逻辑</p>
              <ul class="mt-1 list-disc space-y-1 pl-5 text-[var(--muted)]">
                <li v-for="(line, index) in remediation(check)?.logic ?? []" :key="`logic-${index}`">{{ line }}</li>
              </ul>
            </div>
            <div v-if="remediation(check)?.script" class="mt-3">
              <div class="mb-1 flex items-center justify-between gap-2">
                <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">建议脚本</p>
                <button class="rounded border border-[var(--border)] px-2 py-1 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="copyScript(check.id, remediation(check)?.script)">
                  {{ copiedKey === check.id ? '已复制' : '复制脚本' }}
                </button>
              </div>
              <pre class="overflow-auto rounded-lg bg-[#0b1020] p-3 text-xs leading-relaxed text-slate-100"><code>{{ remediation(check)?.script }}</code></pre>
            </div>
            <div v-if="remediation(check)?.dockerSnippet" class="mt-3">
              <div class="mb-1 flex items-center justify-between gap-2">
                <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">Dockerfile 片段</p>
                <button class="rounded border border-[var(--border)] px-2 py-1 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="copyScript(`${check.id}-docker`, remediation(check)?.dockerSnippet)">
                  {{ copiedKey === `${check.id}-docker` ? '已复制' : '复制' }}
                </button>
              </div>
              <pre class="overflow-auto rounded-lg bg-[#0b1020] p-3 text-xs leading-relaxed text-slate-100"><code>{{ remediation(check)?.dockerSnippet }}</code></pre>
            </div>
            <div v-if="remediation(check)?.composeSnippet" class="mt-3">
              <div class="mb-1 flex items-center justify-between gap-2">
                <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">Compose 片段</p>
                <button class="rounded border border-[var(--border)] px-2 py-1 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="copyScript(`${check.id}-compose`, remediation(check)?.composeSnippet)">
                  {{ copiedKey === `${check.id}-compose` ? '已复制' : '复制' }}
                </button>
              </div>
              <pre class="overflow-auto rounded-lg bg-[#0b1020] p-3 text-xs leading-relaxed text-slate-100"><code>{{ remediation(check)?.composeSnippet }}</code></pre>
            </div>
          </div>
        </details>
        <p v-else class="mt-2 text-sm text-[var(--muted)]">{{ check.help }}</p>
      </div>
    </div>

    <p v-if="report?.checks.length === 0" class="py-6 text-center text-sm text-[var(--muted)]">暂无检查结果。</p>
  </section>
</template>
