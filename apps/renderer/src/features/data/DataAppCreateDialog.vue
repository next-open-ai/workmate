<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { DataSource } from '../../services/api';

export type DataAppCreateDraft = { mode: 'idea' | 'template'; tableId: string; appType: '管理后台' | '数据看板' | '查询网站'; name: string; idea: string };
const props = defineProps<{ source: DataSource; tableId: string; busy: boolean; error: string }>();
const emit = defineEmits<{ close: []; submit: [draft: DataAppCreateDraft] }>();
const draft = ref<DataAppCreateDraft>({ mode: 'idea', tableId: props.tableId, appType: '管理后台', name: '', idea: '' });
const table = computed(() => props.source.tables?.find(item => item.id === draft.value.tableId));
const input = ref<HTMLInputElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const canSubmit = computed(() => !props.busy && Boolean(table.value) && (draft.value.mode === 'template' || Boolean(draft.value.idea.trim())));
const example = computed(() => draft.value.appType === '数据看板' ? '展示关键数据概览，支持筛选和图表分析；不要猜测未说明的统计口径。' : draft.value.appType === '查询网站' ? '提供关键词查询、字段筛选和分页，清楚展示查询结果，适配手机。' : '用列表展示数据，支持搜索、筛选和分页，布局简洁，字段含义清晰。');
const previousFocus = document.activeElement as HTMLElement | null;
function close() { if (!props.busy) emit('close'); }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key === 'Tab') {
    const controls = Array.from(form.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary') || []).filter(element => element.getClientRects().length);
    const first = controls[0]; const last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); form.value?.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === form.value)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}
onMounted(async () => { document.addEventListener('keydown', keydown); await nextTick(); input.value?.focus(); });
onUnmounted(() => { document.removeEventListener('keydown', keydown); previousFocus?.focus(); });
function submit() {
  if (!canSubmit.value) return;
  emit('submit', { ...draft.value, name: draft.value.name.trim() || `${table.value!.name}应用`, idea: draft.value.idea.trim() });
}
</script>

<template>
  <div class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[1px]">
    <form ref="form" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="data-app-create-title" :aria-busy="busy" class="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl" @submit.prevent="submit">
      <div class="flex shrink-0 items-start justify-between gap-3"><div><h2 id="data-app-create-title" class="text-xl font-bold">创建数据应用</h2><p class="mt-2 text-sm text-[var(--muted)]">选择数据和创建方式，说明你想解决的问题。</p></div><button type="button" :disabled="busy" aria-label="关闭创建应用" class="rounded px-2 py-1 text-[var(--muted)] disabled:opacity-50" @click="close">×</button></div>
      <div class="mt-5 min-h-0 overflow-y-auto"><fieldset :disabled="busy" class="min-w-0 space-y-4 disabled:opacity-70">
        <div class="rounded-xl bg-[var(--surface-muted)] p-3"><p class="break-words text-xs text-[var(--muted)]">数据对象：{{ source.name }}</p><label class="mt-2 block"><span class="mb-1.5 block text-xs font-semibold">使用的数据表</span><select v-model="draft.tableId" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"><option v-for="item in source.tables" :key="item.id" :value="item.id">{{ item.name }} · {{ item.rowCount }} 条</option></select></label><p class="mt-2 text-xs leading-5 text-[var(--muted)]">使用已保存的最新字段说明。本期每个应用基于一张表。</p></div>
        <div class="grid gap-2 sm:grid-cols-2" role="group" aria-label="创建方式">
          <label v-for="mode in [{ id: 'idea', title: 'AI 定制', note: '描述需求，进入对话生成页面' }, { id: 'template', title: '现成模板', note: '无需模型，创建后立即可用' }]" :key="mode.id" class="cursor-pointer rounded-xl border p-3" :class="draft.mode === mode.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'"><span class="flex items-center gap-2 text-sm font-semibold"><input v-model="draft.mode" type="radio" name="creation-mode" :value="mode.id" />{{ mode.title }}</span><span class="mt-1.5 block text-xs text-[var(--muted)]">{{ mode.note }}</span></label>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">应用类型</span><select v-model="draft.appType" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"><option v-for="type in ['管理后台', '数据看板', '查询网站']" :key="type">{{ type }}</option></select></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">应用名称 <span class="font-normal text-[var(--muted)]">可选</span></span><input ref="input" v-model="draft.name" maxlength="120" :placeholder="`${table?.name || '数据'}应用`" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" /></label>
        </div>
        <label v-if="draft.mode === 'idea'" class="block"><span class="mb-1.5 block text-xs font-semibold">希望应用做什么？</span><textarea v-model="draft.idea" required maxlength="4000" rows="3" :placeholder="example" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" /><button type="button" class="mt-1 text-xs font-semibold text-[var(--accent)]" @click="draft.idea = example">填入示例后修改</button></label>
        <details v-if="table" class="rounded-lg border border-[var(--border)] p-3"><summary class="cursor-pointer text-xs font-semibold">查看 {{ table.columns.length }} 个字段</summary><ul class="mt-2 max-h-36 space-y-2 overflow-auto text-xs"><li v-for="column in table.columns" :key="column.id" class="break-words"><b>{{ column.name }}</b><span class="ml-2 text-[var(--muted)]">{{ column.description || '未填写说明' }}</span></li></ul></details>
      </fieldset></div>
      <p v-if="error" role="alert" class="mt-4 shrink-0 break-words rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{{ error }}</p>
      <p class="mt-4 shrink-0 text-xs leading-5 text-[var(--muted)]">{{ draft.mode === 'idea' ? '下一步进入对话执行；页面交付后，在数据工作台的「应用」中打开。' : '下一步打开模板应用，随后可在「应用」中管理或继续优化。' }}</p>
      <div class="mt-5 flex shrink-0 justify-end gap-2"><button type="button" :disabled="busy" class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50" @click="close">取消</button><button type="submit" :disabled="!canSubmit" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{{ busy ? '准备中…' : draft.mode === 'idea' ? '创建并开始对话' : '创建模板应用' }}</button></div>
    </form>
  </div>
</template>
