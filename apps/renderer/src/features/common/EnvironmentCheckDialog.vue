<script setup lang="ts">
import { computed, ref } from 'vue';
import { runEnvironmentFix, type EnvFixActionId } from '../../services/api.js';
import { environmentState, runEnvironmentCheck, type EnvProgressRow } from '../../services/environment.js';
import { remediationForCheck } from '../../services/environment-remediation.js';
import DshInstallProgressPanel from '../dsh/DshInstallProgressPanel.vue';
import {
  DSH_ENV_FIX_ACTION_ID,
  installDshRuntimeWithProgress,
} from '../dsh';

/**
 * 环境检查弹窗：展示环境报告，完成后给出汇总与一键修复。
 */
const emit = defineEmits<{ close: []; go: [] }>();

const rows = computed(() => environmentState.progressRows.value as EnvProgressRow[]);
const report = computed(() => environmentState.report.value);
const errorMessage = computed(() => environmentState.errorMessage.value);
const checking = computed(() => environmentState.runStatus.value === 'checking');
const problems = computed(() => (report.value?.checks ?? []).filter((check) => check.status !== 'ok'));
const allOk = computed(() => Boolean(report.value && report.value.summary.error === 0 && report.value.summary.warn === 0));
const copiedKey = ref('');
const fixingId = ref('');
const fixError = ref('');

const stateBadge: Record<string, { text: string; cls: string; dot: string }> = {
  ok: { text: '正常', cls: 'bg-emerald-500/10 text-emerald-600', dot: 'bg-emerald-500' },
  warn: { text: '建议处理', cls: 'bg-amber-500/10 text-amber-600', dot: 'bg-amber-500' },
  error: { text: '需要处理', cls: 'bg-rose-500/10 text-rose-600', dot: 'bg-rose-500' },
};

function lineParts(help: string): string[] {
  return help.split('\n').filter((line) => line.trim());
}

function planFor(check: (typeof problems.value)[number]) {
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
}

async function applyFix(actionId: EnvFixActionId, uiKey: string) {
  fixingId.value = uiKey;
  fixError.value = '';
  try {
    if (actionId === DSH_ENV_FIX_ACTION_ID) {
      const { demoteDshEmployeesToPi } = await import('../dsh/engine-fallback');
      await demoteDshEmployeesToPi().catch(() => undefined);
      const result = await installDshRuntimeWithProgress({ reinstall: true, source: 'manual' });
      if (result.report) applyReport(result.report);
      else await runEnvironmentCheck();
      return;
    }
    const result = await runEnvironmentFix(actionId);
    if (result.report) applyReport(result.report);
    else await runEnvironmentCheck();
  } catch (cause) {
    fixError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    fixingId.value = '';
  }
}

function fixActionIdFor(check: (typeof problems.value)[number]): EnvFixActionId | null {
  const actionId = planFor(check)?.actionId;
  return actionId ?? null;
}

function applyCheckFix(check: (typeof problems.value)[number]) {
  const actionId = fixActionIdFor(check);
  if (!actionId) return;
  void applyFix(actionId, check.id);
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
    <div class="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
      <header class="flex items-center gap-3 border-b border-[var(--border)] px-6 py-4">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/15 text-xl">🛠</span>
        <div class="min-w-0 flex-1">
          <h2 class="text-lg font-bold leading-tight">运行环境检查</h2>
          <p v-if="checking" class="mt-0.5 text-sm text-[var(--muted)]">正在检查环境…</p>
          <p v-else-if="allOk" class="mt-0.5 text-sm text-emerald-600">环境已就绪（{{ report?.summary.ok }}/{{ report?.summary.total }}）🎉</p>
          <p v-else class="mt-0.5 text-sm text-[var(--muted)]">
            检测到 {{ report?.summary.error ?? 0 }} 项不满足、{{ report?.summary.warn ?? 0 }} 项建议；可复制脚本或对白名单项一键修复。
          </p>
        </div>
        <button class="ml-auto grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" aria-label="关闭" :disabled="checking" @click="emit('close')">×</button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto px-6 py-4">
        <div
          v-if="!checking && report?.pythonDecision"
          class="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 px-3 py-2.5 text-xs"
        >
          <p class="font-semibold">
            Agent 脚本 Python：
            <span class="text-[var(--accent)]">
              {{
                report.pythonDecision.source === 'system' ? '系统'
                  : report.pythonDecision.source === 'bundled' ? '预装 Runtime'
                    : report.pythonDecision.source === 'override' ? '覆盖'
                      : '不可用'
              }}
            </span>
            · {{ report.pythonDecision.command || '—' }} {{ report.pythonDecision.version || '' }}
          </p>
          <p class="mt-1 text-[var(--muted)]">{{ report.pythonDecision.reason }}</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              v-if="report.pythonDecision.source !== 'system'"
              class="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
              type="button"
              :disabled="Boolean(fixingId) || checking"
              @click="applyFix('install-python', 'install-python')"
            >
              {{ fixingId === 'install-python' ? '安装中…' : '尝试安装 Python 3.12' }}
            </button>
            <button
              v-if="(report.workspaceScrap?.totalBytes ?? 0) > 0"
              class="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] font-semibold disabled:opacity-60"
              type="button"
              :disabled="Boolean(fixingId) || checking"
              @click="applyFix('clean-workspace-scrap', 'clean-workspace-scrap')"
            >
              {{ fixingId === 'clean-workspace-scrap' ? '清理中…' : `清理临时物（${report.workspaceScrap?.totalBytesLabel}）` }}
            </button>
          </div>
        </div>
        <ul class="grid gap-2">
          <li v-for="row in rows" :key="row.id" class="flex items-start gap-3 rounded-xl border border-[var(--border)] p-3">
            <template v-if="row.state === 'checking'">
              <span class="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              <div class="min-w-0 text-sm">
                <p class="font-semibold">{{ row.name }}</p>
                <p class="mt-0.5 text-xs text-[var(--muted)]">要求：{{ row.required }} · 检测中…</p>
              </div>
            </template>
            <template v-else>
              <span :class="['mt-1 h-2.5 w-2.5 shrink-0 rounded-full', stateBadge[row.status ?? 'ok'].dot]" />
              <div class="min-w-0 flex-1 text-sm">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <p class="font-semibold">{{ row.name }}</p>
                  <span :class="['rounded-full px-2 py-0.5 text-[11px] font-semibold', stateBadge[row.status ?? 'ok'].cls]">
                    {{ stateBadge[row.status ?? 'ok'].text }}
                  </span>
                  <span class="text-xs text-[var(--muted)]">当前：{{ row.found || '—' }}</span>
                </div>
              </div>
            </template>
          </li>
        </ul>
        <p v-if="errorMessage" class="mt-3 text-sm text-rose-600">检查失败：{{ errorMessage }}</p>
        <p v-if="fixError" class="mt-3 text-sm text-rose-600">修复失败：{{ fixError }}</p>
        <div class="mt-3">
          <DshInstallProgressPanel compact />
        </div>

        <div v-if="!checking && problems.length" class="mt-4 grid gap-3">
          <p class="text-sm font-semibold text-rose-600">需要处理的项目与解决方案</p>
          <details v-for="check in problems" :key="check.id" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 px-4 py-3">
            <summary class="cursor-pointer text-sm font-semibold">
              {{ check.name }}
              <span class="ml-2 text-xs font-normal text-[var(--muted)]">要求 {{ check.required }}，当前 {{ check.found }}</span>
            </summary>
            <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
              <li v-for="(line, index) in lineParts(check.help)" :key="index">
                <code v-if="/^(brew |winget |sudo |xcode-select |python |chmod |dnf |apt)/.test(line.trim())" class="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-xs">{{ line.trim() }}</code>
                <template v-else>{{ line.trim() }}</template>
              </li>
            </ul>
            <div v-if="planFor(check)" class="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <p class="text-sm font-semibold">{{ planFor(check)?.summary }}</p>
                <button
                  v-if="planFor(check)?.canAutoFix && planFor(check)?.actionId"
                  class="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                  type="button"
                  :disabled="Boolean(fixingId)"
                  @click="applyCheckFix(check)"
                >
                  {{ fixingId === check.id ? '修复中…' : '一键修复' }}
                </button>
              </div>
              <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
                <li v-for="(line, index) in planFor(check)?.steps ?? []" :key="`step-${index}`">{{ line }}</li>
              </ul>
              <div v-if="planFor(check)?.script" class="mt-3">
                <div class="mb-1 flex items-center justify-between gap-2">
                  <p class="text-xs font-semibold uppercase tracking-[.08em] text-[var(--muted)]">建议脚本</p>
                  <button class="rounded border border-[var(--border)] px-2 py-1 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="copyScript(check.id, planFor(check)?.script)">
                    {{ copiedKey === check.id ? '已复制' : '复制脚本' }}
                  </button>
                </div>
                <pre class="overflow-auto rounded-lg bg-[#0b1020] p-3 text-xs leading-relaxed text-slate-100"><code>{{ planFor(check)?.script }}</code></pre>
              </div>
            </div>
          </details>
        </div>
      </div>

      <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
        <button class="rounded-lg px-4 py-2 text-sm font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" :disabled="checking" @click="emit('close')">
          {{ allOk ? '完成' : '关闭' }}
        </button>
        <button v-if="!allOk && !checking" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90" type="button" @click="emit('go')">
          查看完整详情与修复 →
        </button>
      </footer>
    </div>
  </div>
</template>
