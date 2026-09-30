<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getDoclingEnhancedComponentStatus, installDoclingEnhancedComponent, removeDoclingEnhancedComponent, type DoclingEnhancedComponentStatus } from '../../services/api';
import { useNotify } from '../../app/notify';

defineProps<{ isAdmin?: boolean }>();
const notify = useNotify();
const status = ref<DoclingEnhancedComponentStatus | null>(null);
const busy = ref(false);
const error = ref('');
const stateLabel = computed(() => status.value?.state === 'ready' ? '已启用' : status.value?.state === 'broken' ? '需要修复' : '未安装');
const stateClass = computed(() => status.value?.state === 'ready' ? 'bg-emerald-500/10 text-emerald-700' : status.value?.state === 'broken' ? 'bg-amber-500/10 text-amber-700' : 'bg-[var(--surface-muted)] text-[var(--muted)]');
async function refresh() { try { status.value = await getDoclingEnhancedComponentStatus(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
async function install() { busy.value = true; error.value = ''; try { status.value = await installDoclingEnhancedComponent(); notify.success('Docling 文档增强解析已安装'); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); notify.error(cause); } finally { busy.value = false; } }
async function remove() { busy.value = true; error.value = ''; try { status.value = await removeDoclingEnhancedComponent(); notify.success('Docling 文档增强解析已移除'); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); notify.error(cause); } finally { busy.value = false; } }
onMounted(() => { void refresh(); });
</script>

<template>
  <div class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
    <div class="flex flex-wrap items-start justify-between gap-4"><div class="max-w-2xl"><div class="flex items-center gap-2"><h3 class="text-[16px] font-bold">PDF / Word 增强解析</h3><span :class="['rounded-full px-2 py-1 text-[10px] font-bold', stateClass]">{{ stateLabel }}</span></div><p class="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">基础安装已通过轻量解析支持常用 PDF 和 Word 文档。安装后将启用 MarkItDown 与 Docling，在基础结果为空或质量较低时自动增强复杂版式、表格和阅读顺序；解析失败仍会回退到基础结果。</p></div><div class="flex gap-2"><button v-if="status?.state !== 'ready'" type="button" class="rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50" :disabled="busy || !isAdmin" @click="install">{{ busy ? '安装中…' : status?.state === 'broken' ? '修复组件' : '安装增强组件' }}</button><button v-else type="button" class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold disabled:opacity-50" :disabled="busy || !isAdmin" @click="remove">{{ busy ? '处理中…' : '移除组件' }}</button></div></div>
    <div class="mt-4 grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs sm:grid-cols-2"><div><span class="text-[var(--muted)]">使用方式</span><strong class="ml-2">需要时自动回退增强</strong></div><div><span class="text-[var(--muted)]">组件版本</span><strong class="ml-2">{{ status?.version || '—' }}</strong></div><div class="sm:col-span-2"><span class="text-[var(--muted)]">存储位置</span><code class="ml-2 break-all">{{ status?.location || '检测中…' }}</code></div></div>
    <p v-if="!isAdmin" class="mt-3 text-xs text-amber-700">只有管理员可以安装或移除组件。</p><p v-if="error" class="mt-3 rounded-xl bg-red-500/10 p-3 text-xs text-red-700">{{ error }}</p><p class="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">组件按需联网下载到用户数据目录，不进入基础安装包。由于包含原生文档解析依赖，下载和安装可能需要数分钟。</p>
  </div>
</template>
