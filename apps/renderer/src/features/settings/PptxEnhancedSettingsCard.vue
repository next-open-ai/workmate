<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getPptxEnhancedComponentStatus, installPptxEnhancedComponent, removePptxEnhancedComponent, type PptxEnhancedComponentStatus } from '../../services/api';
import { useNotify } from '../../app/notify';

defineProps<{ isAdmin?: boolean }>();
const notify = useNotify();
const status = ref<PptxEnhancedComponentStatus | null>(null);
const busy = ref(false);
const error = ref('');
const stateLabel = computed(() => status.value?.state === 'ready' ? '已启用' : status.value?.state === 'broken' ? '需要修复' : '未安装');
const stateClass = computed(() => status.value?.state === 'ready'
  ? 'bg-emerald-500/10 text-emerald-700'
  : status.value?.state === 'broken' ? 'bg-amber-500/10 text-amber-700' : 'bg-[var(--surface-muted)] text-[var(--muted)]');

async function refresh() {
  error.value = '';
  try { status.value = await getPptxEnhancedComponentStatus(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

async function install() {
  busy.value = true; error.value = '';
  try {
    status.value = await installPptxEnhancedComponent();
    notify.success('PPTX 增强解析组件已安装');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    notify.error(cause);
  } finally { busy.value = false; }
}

async function remove() {
  busy.value = true; error.value = '';
  try {
    status.value = await removePptxEnhancedComponent();
    notify.success('PPTX 增强解析组件已移除');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    notify.error(cause);
  } finally { busy.value = false; }
}

onMounted(() => { void refresh(); });
</script>

<template>
  <div class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="max-w-2xl">
        <div class="flex items-center gap-2">
          <h3 class="text-[16px] font-bold">PPTX 增强解析</h3>
          <span :class="['rounded-full px-2 py-1 text-[10px] font-bold', stateClass]">{{ stateLabel }}</span>
        </div>
        <p class="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">
          默认轻量解析已支持幻灯片正文和演讲者备注。安装增强组件后，上传 PPTX/PPSX 时会自动使用 MarkItDown 解析复杂表格、图表文字和图片说明；增强解析失败会自动回退，不影响对话。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button v-if="status?.state !== 'ready'" class="rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50" type="button" :disabled="busy || !isAdmin" @click="install">
          {{ busy ? '安装中…' : status?.state === 'broken' ? '修复组件' : '安装增强组件' }}
        </button>
        <button v-else class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold disabled:opacity-50" type="button" :disabled="busy || !isAdmin" @click="remove">
          {{ busy ? '处理中…' : '移除组件' }}
        </button>
      </div>
    </div>
    <div class="mt-4 grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs sm:grid-cols-2">
      <div><span class="text-[var(--muted)]">使用方式</span><strong class="ml-2">上传时自动选择，无需手动切换</strong></div>
      <div><span class="text-[var(--muted)]">组件版本</span><strong class="ml-2">{{ status?.version || '—' }}</strong></div>
      <div class="sm:col-span-2"><span class="text-[var(--muted)]">存储位置</span><code class="ml-2 break-all">{{ status?.location || '检测中…' }}</code></div>
    </div>
    <p v-if="!isAdmin" class="mt-3 text-xs text-amber-700">只有管理员可以安装或移除组件。</p>
    <p v-if="error" class="mt-3 rounded-xl bg-red-500/10 p-3 text-xs text-red-700">{{ error }}</p>
    <p class="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">安装时需要联网下载 python-pptx 及其依赖，仅写入用户数据目录，不修改系统 Python，也不会扩大基础安装包。</p>
  </div>
</template>
