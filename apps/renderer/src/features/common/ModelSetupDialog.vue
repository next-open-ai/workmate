<script setup lang="ts">
import { computed } from 'vue';
import type { ModelSetupGapId } from '../../app/model-config';

/**
 * 启动引导弹窗：检测到没有可用的对话模型时展示。
 * 按缺口列出“缺什么 / 怎么补”，并提供「去配置」与「以后再说」两个出口。
 * 视觉与交互风格对齐 EnvironmentIssueDialog（CSS 变量主题）。
 */
const props = defineProps<{ gaps: ModelSetupGapId[] }>();
const emit = defineEmits<{ close: []; go: [tab: 'providers' | 'models']; manual: [] }>();

const gapMeta: Record<ModelSetupGapId, { tab: 'providers' | 'models'; dot: string; title: string; guide: string }> = {
  'no-provider': {
    tab: 'providers',
    dot: 'bg-rose-500',
    title: '还没有配置任何服务商（Provider）',
    guide: '添加一个服务商并填入 API Key。可以选择 DeepSeek、OpenAI、通义千问、GLM 等云端服务，或使用本机 Ollama（无需 Key）。',
  },
  'provider-incomplete': {
    tab: 'providers',
    dot: 'bg-amber-500',
    title: '服务商配置不完整',
    guide: '已添加的服务商缺少 API Key 或 Base URL。请到 Provider 配置中补齐并保存，测试连通后再继续。',
  },
  'no-model': {
    tab: 'models',
    dot: 'bg-amber-500',
    title: '还没有添加可用的模型',
    guide: '为已就绪的服务商添加一个对话模型（如 deepseek-chat、gpt-4.1-mini、qwen-plus），并把它设为默认对话模型。',
  },
  'no-active-chat-model': {
    tab: 'models',
    dot: 'bg-sky-500',
    title: '还没有选择默认对话模型',
    guide: '在模型列表中指定一个默认对话模型，聊天功能即可直接开始使用。',
  },
};

const targetTab = computed(() => gapMeta[props.gaps[0] ?? 'no-provider'].tab);

function dismiss() {
  emit('close');
}

function goConfigure() {
  emit('go', targetTab.value);
}

function openManual() {
  emit('manual');
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="model-setup-title">
    <div class="w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
      <header class="flex items-start gap-4 border-b border-[var(--border)] px-6 py-5">
        <span class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500/20 to-sky-500/20 text-2xl" aria-hidden="true">🤖</span>
        <div class="min-w-0 pt-0.5">
          <h2 id="model-setup-title" class="text-lg font-bold leading-tight">AI 模型还没有准备好</h2>
          <p class="mt-1 text-sm leading-relaxed text-[var(--muted)]">
            完成 {{ gaps.length }} 项配置后就能开始对话。别担心，每项都给出了具体做法。
          </p>
        </div>
        <button class="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" aria-label="关闭" @click="dismiss">×</button>
      </header>

      <div class="max-h-[46vh] overflow-auto px-6 py-4">
        <ol class="grid gap-2">
          <li
            v-for="(gap, index) in gaps"
            :key="gap"
            class="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 p-3"
          >
            <span class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface)] text-xs font-bold text-[var(--muted)] ring-1 ring-[var(--border)]">{{ index + 1 }}</span>
            <div class="min-w-0 text-sm">
              <p class="flex items-center gap-2 font-semibold">
                <span :class="['h-2 w-2 shrink-0 rounded-full', gapMeta[gap].dot]" />
                {{ gapMeta[gap].title }}
              </p>
              <p class="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">{{ gapMeta[gap].guide }}</p>
            </div>
          </li>
        </ol>
        <p class="mt-3 rounded-lg bg-[var(--surface-muted)]/60 px-3 py-2 text-xs leading-relaxed text-[var(--muted)]">
          💡 提示：也可通过左侧「设置 → Provider / 模型」随时回来补全配置。
        </p>
        <button
          class="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent)] hover:opacity-85"
          type="button"
          @click="openManual"
        >
          📖 查看手册：模型配置
        </button>
      </div>

      <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
        <button class="rounded-lg px-4 py-2 text-sm font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" @click="dismiss">
          以后再说
        </button>
        <button class="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90" type="button" @click="goConfigure">
          去配置 →
        </button>
      </footer>
    </div>
  </div>
</template>
