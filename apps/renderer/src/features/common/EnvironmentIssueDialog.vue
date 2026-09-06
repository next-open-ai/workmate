<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { environmentState, runEnvironmentCheck } from '../../services/environment.js';

/**
 * 启动环境检查结果弹窗（专业提示 + 新手可执行指引入口）。
 * 由 App 在「首次安装启动」或「开启启动检查且发现问题」时展示。
 */
const emit = defineEmits<{ close: []; go: [] }>();

const report = computed(() => environmentState.report.value);
const problems = computed(() => (report.value?.checks ?? []).filter((check) => check.status !== 'ok'));
const summary = computed(() => report.value?.summary);

function dismiss() {
  emit('close');
}

function openDetails() {
  emit('go');
}

onMounted(() => {
  // 弹窗打开时确保有最新结果（兜底：设置里手动检查后跳转详情不受影响）
  if (!environmentState.report.value) void runEnvironmentCheck();
});
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
    <div class="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
      <header class="flex items-center gap-3 border-b border-[var(--border)] px-6 py-4">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-xl">🛠</span>
        <div class="min-w-0">
          <h2 class="text-lg font-bold leading-tight">运行环境需要处理</h2>
          <p class="mt-0.5 text-sm text-[var(--muted)]">
            检测到 {{ summary?.error ?? 0 }} 项不满足、{{ summary?.warn ?? 0 }} 项建议。别担心，每项都给出了具体安装方法。
          </p>
        </div>
        <button class="ml-auto grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" aria-label="关闭" @click="dismiss">×</button>
      </header>

      <div class="max-h-[46vh] overflow-auto px-6 py-4">
        <ul class="grid gap-2">
          <li
            v-for="check in problems"
            :key="check.id"
            class="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 p-3"
          >
            <span :class="['mt-1 h-2.5 w-2.5 shrink-0 rounded-full', check.status === 'error' ? 'bg-rose-500' : 'bg-amber-500']" />
            <div class="min-w-0 text-sm">
              <p class="font-semibold">
                {{ check.name }}
                <span class="ml-1 font-normal text-[var(--muted)]">要求：{{ check.required }}，当前：{{ check.found }}</span>
              </p>
              <p class="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">{{ check.help }}</p>
            </div>
          </li>
        </ul>
        <p v-if="!problems.length" class="py-4 text-center text-sm text-emerald-600">环境已就绪 🎉</p>
      </div>

      <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
        <button class="rounded-lg px-4 py-2 text-sm font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" @click="dismiss">
          稍后处理
        </button>
        <button class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90" type="button" @click="openDetails">
          查看完整指引并修复 →
        </button>
      </footer>
    </div>
  </div>
</template>
