<script setup lang="ts">
import { dshInstallPhaseLabel, dshInstallState } from './install-progress';

defineProps<{
  compact?: boolean;
}>();

const phaseSteps = [
  { id: 'prepare', label: '目录' },
  { id: 'resolve-npm', label: 'npm' },
  { id: 'npm-install', label: '依赖' },
  { id: 'verify', label: '校验' },
  { id: 'activate', label: '激活' },
] as const;

function stepState(id: string): 'done' | 'active' | 'pending' {
  const phase = dshInstallState.phase.value;
  if (phase === 'done' || phase === 'skipped') return 'done';
  const order = ['prepare', 'resolve-npm', 'npm-install', 'verify', 'activate'];
  const current = order.indexOf(phase === 'error' ? 'npm-install' : phase);
  const idx = order.indexOf(id);
  if (current < 0) return 'pending';
  if (idx < current) return 'done';
  if (idx === current) return 'active';
  return 'pending';
}
</script>

<template>
  <div
    v-if="dshInstallState.busy.value || dshInstallState.phase.value !== 'idle'"
    :class="[
      'overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]/95 shadow-[0_12px_36px_-28px_rgba(15,23,42,0.5)]',
      compact ? 'p-3.5' : 'p-4 sm:p-5',
    ]"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold tracking-tight">dsh 编码引擎安装进度</p>
        <p class="mt-1 text-xs text-[var(--muted)]">
          正在：<span class="font-semibold text-[var(--text)]">{{ dshInstallPhaseLabel }}</span>
          <span v-if="dshInstallState.source.value === 'startup'"> · 启动自动安装</span>
          <span v-else-if="dshInstallState.source.value === 'manual'"> · 手动一键修复</span>
        </p>
      </div>
      <span
        :class="[
          'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums',
          dshInstallState.phase.value === 'error'
            ? 'bg-rose-500/12 text-rose-600'
            : dshInstallState.phase.value === 'done' || dshInstallState.phase.value === 'skipped'
              ? 'bg-emerald-500/12 text-emerald-600'
              : 'bg-[var(--accent-soft)] text-[var(--accent)]',
        ]"
      >
        {{ dshInstallState.percent.value }}%
      </span>
    </div>

    <ol v-if="!compact" class="mt-3 flex flex-wrap gap-1.5">
      <li
        v-for="step in phaseSteps"
        :key="step.id"
        :class="[
          'rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide',
          stepState(step.id) === 'done' && 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
          stepState(step.id) === 'active' && 'bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[var(--accent)]/30',
          stepState(step.id) === 'pending' && 'bg-[var(--surface-muted)] text-[var(--muted)]',
        ]"
      >
        {{ step.label }}
      </li>
    </ol>

    <div class="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]">
      <div
        class="h-full rounded-full transition-all duration-300"
        :class="dshInstallState.phase.value === 'error'
          ? 'bg-rose-500'
          : 'bg-[linear-gradient(90deg,#0ea5e9,#14b8a6,#10b981)]'"
        :style="{ width: `${Math.max(4, dshInstallState.percent.value)}%` }"
      />
    </div>

    <p class="mt-2.5 text-xs leading-5 text-[var(--text)]">{{ dshInstallState.message.value || '…' }}</p>
    <p v-if="dshInstallState.error.value" class="mt-1.5 rounded-lg bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-600">
      {{ dshInstallState.error.value }}
    </p>

    <details v-if="dshInstallState.logs.value.length" class="mt-3" :open="dshInstallState.busy.value">
      <summary class="cursor-pointer text-[11px] font-semibold text-[var(--accent)]">
        实时日志（{{ dshInstallState.logs.value.length }}）
      </summary>
      <pre class="mt-2 max-h-40 overflow-auto rounded-xl bg-[#0f172a] p-2.5 text-[11px] leading-relaxed text-slate-100"><code>{{ dshInstallState.logs.value.join('\n') }}</code></pre>
    </details>
  </div>
</template>
