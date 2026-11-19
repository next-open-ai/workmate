<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import type { WikiMergePreview } from '@workmate/contracts';
import { wikiApi } from '../../services/wiki';

const props = defineProps<{ kb: string; sourcePageId: string; disabled: boolean }>();
const emit = defineEmits<{ saved: [pageId: string] }>();
const candidates = ref<{ pageId: string; title: string }[]>([]);
const preview = ref<WikiMergePreview>();
const busy = ref(false), error = ref('');
let disposed = false, token = 0, requestKey = '';
onBeforeUnmount(() => { disposed = true; token++; });
const message = (cause: unknown) => cause instanceof Error ? cause.message : '合并操作未完成，请重试。';
async function load() {
  busy.value = true; error.value = '';
  try { const result = await wikiApi.mergeCandidates(props.kb, props.sourcePageId); if (!disposed) candidates.value = result.items; }
  catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
async function select(target: string) {
  if (busy.value || props.disabled) return;
  const current = ++token; busy.value = true; error.value = ''; preview.value = undefined; requestKey = '';
  try {
    const result = await wikiApi.mergePreview(props.kb, props.sourcePageId, target);
    if (!disposed && current === token) preview.value = result;
  } catch (cause) { if (!disposed && current === token) error.value = message(cause); }
  finally { if (!disposed && current === token) busy.value = false; }
}
async function save() {
  if (!preview.value || !preview.value.addedSections || busy.value || props.disabled) return;
  const { targetPageId, sourceRevisionId, targetRevisionId, sourceGeneration, baseGeneration, previewHash } = preview.value;
  busy.value = true; error.value = ''; requestKey ||= crypto.randomUUID();
  try {
    const result = await wikiApi.merge(props.kb, props.sourcePageId, { targetPageId, sourceRevisionId, targetRevisionId,
      sourceGeneration, baseGeneration, previewHash, idempotencyKey: requestKey });
    if (!disposed) emit('saved', result.pageId);
  } catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
onMounted(load);
</script>

<template>
  <section v-if="candidates.length || error" class="merge-panel" aria-label="已有主题合并">
    <div class="merge-heading"><span aria-hidden="true">↗</span><div><h3>可补充到已有主题</h3><p>标题或别名相同，不一定同义。请先预览再决定。</p></div></div>
    <div class="merge-targets"><button v-for="candidate in candidates" :key="candidate.pageId" :disabled="busy || disabled" :aria-pressed="preview?.targetPageId === candidate.pageId" @click="select(candidate.pageId)">预览合并：{{ candidate.title }}</button></div>
    <p v-if="busy" role="status">正在处理…</p>
    <p v-if="error" role="alert" class="merge-error">{{ error }} <button :disabled="busy || disabled" @click="preview ? select(preview.targetPageId) : load()">刷新预览</button></p>
    <div v-if="preview" class="merge-preview">
      <p>保留已有内容，新增 {{ preview.addedSections }} 节，跳过 {{ preview.skippedSections }} 节完全重复内容。</p>
      <details><summary>查看已有内容</summary><p class="merge-body">{{ preview.targetBody }}</p></details>
      <details v-if="preview.addedSections" open><summary>将新增的内容</summary><div class="merge-body"><div v-for="section in preview.content.sections.slice(-preview.addedSections)" :key="section.sectionId"><h4>{{ section.headingPath.join(' / ') }}</h4><p>{{ preview.content.bodyMarkdown.slice(section.start, section.end) }}</p></div></div></details>
      <details><summary>合并后的完整预览</summary><div class="merge-body"><div v-for="section in preview.content.sections" :key="section.sectionId"><h4>{{ section.headingPath.join(' / ') }}</h4><p>{{ preview.content.bodyMarkdown.slice(section.start, section.end) }}</p></div></div></details>
      <p>仅保存为更新草稿，核对来源后再发布。原生成草稿仍保留，不改变其他页面链接。</p>
      <div class="merge-targets"><button class="merge-save" :disabled="busy || disabled || !preview.addedSections" @click="save">保存为更新草稿</button><button :disabled="busy" @click="preview = undefined">取消合并</button></div>
    </div>
  </section>
</template>

<style scoped>
.merge-panel { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--accent-soft); font-size: 12px; }
.merge-heading { display: flex; gap: 10px; align-items: flex-start; }
.merge-heading > span { color: var(--accent); font-size: 20px; }
h3 { font-size: 14px; font-weight: 650; }
p { margin-top: 6px; line-height: 1.7; }
.merge-heading p,.merge-preview > p { color: var(--muted); }
.merge-targets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); text-align: left; overflow-wrap: anywhere; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible,summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.merge-save { background: var(--accent); color: white; }
.merge-preview { margin-top: 12px; }
details { background: var(--surface); border-radius: 8px; padding: 12px; margin-top: 10px; }
summary { cursor: pointer; font-weight: 600; }
.merge-body { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 10px; }
h4 { margin-top: 12px; font-weight: 600; }
.merge-error { color: var(--text); }
</style>
