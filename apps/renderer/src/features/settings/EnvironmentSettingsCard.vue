<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { readStored, writeStored } from '../../app/storage.js';
import { environmentIssueCount, environmentState, environmentSummaryText } from '../../services/environment.js';

/**
 * 设置 → 环境页签：手动“立即检查”（打开带逐项进度的弹窗）、启动检查偏好、最近结果摘要。
 */
const emit = defineEmits<{ openCheck: []; openEnvironment: [] }>();

const startupCheckEnabled = ref(true);
const issueCount = environmentIssueCount;
const checking = computed(() => environmentState.runStatus.value === 'checking');
const summary = computed(() => environmentState.report.value?.summary ?? null);
const lastCheckedText = computed(() => {
  const at = environmentState.report.value?.checkedAt;
  return at ? new Date(at).toLocaleString() : '—';
});
const platform = computed(() => environmentState.report.value?.platform ?? '');

onMounted(async () => {
  startupCheckEnabled.value = (await readStored('env.check-on-startup')) !== '0';
});

async function toggleStartupCheck() {
  await writeStored('env.check-on-startup', startupCheckEnabled.value ? '1' : '0');
}
</script>

<template>
  <div class="grid gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-4">
      <div>
        <p class="text-sm font-semibold">运行环境检测</p>
        <p class="mt-1 max-w-xl text-xs leading-relaxed text-[var(--muted)]">
          检测 Python 3 与版本、pip、Git、npx 与本地数据目录。点击「立即检查」会打开实时进度窗口，缺项会给出各平台的安装指引。
        </p>
      </div>
      <button
        class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        type="button"
        :disabled="checking"
        @click="emit('openCheck')"
      >
        {{ checking ? '检查中…' : '立即检查' }}
      </button>
    </div>

    <div v-if="summary" class="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[var(--border)] p-4 text-sm">
      <span :class="['inline-flex items-center gap-2 font-semibold', summary.error > 0 ? 'text-rose-600' : summary.warn > 0 ? 'text-amber-600' : 'text-emerald-600']">
        <span :class="['h-2.5 w-2.5 rounded-full', summary.error > 0 ? 'bg-rose-500' : summary.warn > 0 ? 'bg-amber-500' : 'bg-emerald-500']" />
        {{ environmentSummaryText() }}
      </span>
      <span class="text-xs text-[var(--muted)]">平台：{{ platform || '—' }}</span>
      <span class="text-xs text-[var(--muted)]">上次检查：{{ lastCheckedText }}</span>
      <button v-if="issueCount > 0" class="ml-auto text-xs font-semibold text-[var(--accent)] hover:underline" type="button" @click="emit('openEnvironment')">
        查看详情与修复 →
      </button>
    </div>
    <p v-else class="text-sm text-[var(--muted)]">尚未在本应用内执行过检查（安装后的首次启动会自动检查一次）。</p>

    <label class="flex items-start gap-3 rounded-xl border border-[var(--border)] p-4">
      <input v-model="startupCheckEnabled" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--accent)]" @change="toggleStartupCheck" />
      <span>
        <strong class="block text-sm">每次启动时自动检查</strong>
        <span class="mt-0.5 block text-xs leading-relaxed text-[var(--muted)]">
          默认开启。安装后的首次启动无论开关如何都会检查一次；关闭后，仅在设置中手动执行检查。
        </span>
      </span>
    </label>
  </div>
</template>
