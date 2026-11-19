<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { WikiContentSchema, type WikiContent, type WikiPageView, type WikiSources } from '@workmate/contracts';
import { wikiApi, WikiRequestError } from '../../services/wiki';

const props = defineProps<{ knowledgeBaseId: string; view: WikiPageView }>();
const emit = defineEmits<{ close: []; saved: [pageId: string] }>();
// Capture the exact revision/generation once. Comparing newer content must never silently rebase edits.
const original: WikiPageView = JSON.parse(JSON.stringify(props.view));
const title = ref(original.revision.content.title), summary = ref(original.revision.content.summary);
const aliases = ref(original.revision.content.aliases.join('\n'));
const sections = ref(original.revision.content.sections.map((section) => ({ ...section,
  headingPath: [...section.headingPath], body: original.revision.content.bodyMarkdown.slice(section.start, section.end) })));
const dialog = ref<HTMLDialogElement>(), saving = ref(false), loading = ref(true), error = ref(''), conflict = ref(false);
const baseline = ref<WikiContent>(original.revision.content), baselineLabel = ref('打开编辑时的版本');
const sources = ref<WikiSources['items']>([]), comparing = ref(false);
const ready = ref(false);
let disposed = false, attemptBody = '', attemptKey = '';
const fields = () => JSON.stringify({ title: title.value, summary: summary.value, aliases: aliases.value, sections: sections.value });
const initialFields = fields();
const dirty = computed(() => fields() !== initialFields);
const candidate = computed(() => {
  let bodyMarkdown = '';
  const updatedSections = sections.value.map((section, index) => {
    if (index) bodyMarkdown += '\n\n';
    const start = bodyMarkdown.length;
    bodyMarkdown += section.body;
    return { sectionId: section.sectionId, headingPath: section.headingPath, start, end: bodyMarkdown.length };
  });
  return { ...original.revision.content, title: title.value, summary: summary.value,
    aliases: [...new Set(aliases.value.split('\n').map((s) => s.trim()).filter(Boolean))], bodyMarkdown, sections: updatedSections };
});
const validation = computed(() => WikiContentSchema.safeParse(candidate.value));
const valid = computed(() => validation.value.success && sections.value.every((section) => section.body.trim()));
const changes = computed(() => {
  const old = baseline.value, next = candidate.value;
  const rows = [{ name: '标题', before: old.title, after: next.title },
    { name: '别名', before: old.aliases.join('\n'), after: next.aliases.join('\n') },
    { name: '摘要', before: old.summary, after: next.summary }];
  for (const id of new Set([...old.sections, ...next.sections].map((s) => s.sectionId))) {
    const a = old.sections.find((s) => s.sectionId === id), b = next.sections.find((s) => s.sectionId === id);
    rows.push({ name: b?.headingPath.join(' / ') || a?.headingPath.join(' / ') || id,
      before: a ? a.headingPath.join(' / ') + '\n' + old.bodyMarkdown.slice(a.start, a.end) : '',
      after: b ? b.headingPath.join(' / ') + '\n' + next.bodyMarkdown.slice(b.start, b.end) : '' });
  }
  return rows.filter((row) => row.before !== row.after);
});
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重试。';
function close() {
  if (saving.value) return;
  if (dirty.value && !window.confirm('修改尚未保存，确定放弃本次编辑？')) return;
  emit('close');
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = ''; }
}
async function loadReview() {
  loading.value = true; error.value = ''; ready.value = false;
  try {
    const refs = await wikiApi.sources(props.knowledgeBaseId, original.page.pageId, original.revision.revisionId);
    if (disposed) return;
    sources.value = refs.items;
    if (original.page.publishedRevisionId) {
      const published = await wikiApi.revision(props.knowledgeBaseId, original.page.pageId, original.page.publishedRevisionId);
      if (disposed) return;
      baseline.value = published.revision.content; baselineLabel.value = '打开编辑时的已发布版本';
    }
    ready.value = true;
  } catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) loading.value = false; }
}
async function compareLatest() {
  loading.value = true; error.value = '';
  try {
    const published = await wikiApi.read(props.knowledgeBaseId, original.page.pageId, false).catch((cause) => {
      if (cause instanceof WikiRequestError && cause.code === 'NOT_FOUND') return undefined;
      throw cause;
    });
    const latest = published?.page.draftRevisionId || !published
      ? await wikiApi.read(props.knowledgeBaseId, original.page.pageId, true) : published;
    if (!disposed) { baseline.value = latest.revision.content; baselineLabel.value = '最新服务器版本（仅对照，不覆盖输入）'; comparing.value = true; }
  } catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) loading.value = false; }
}
async function save() {
  if (saving.value || loading.value || !ready.value || conflict.value || !dirty.value || !valid.value || !validation.value.success) return;
  const content = validation.value.data;
  const signature = JSON.stringify(content);
  if (signature !== attemptBody) { attemptBody = signature; attemptKey = crypto.randomUUID(); }
  saving.value = true; error.value = '';
  try {
    await wikiApi.edit(props.knowledgeBaseId, original, content, attemptKey);
    if (!disposed) emit('saved', original.page.pageId);
  } catch (cause) {
    if (!disposed) {
      conflict.value = cause instanceof WikiRequestError && cause.code === 'REVISION_CONFLICT';
      error.value = conflict.value ? '' : message(cause);
    }
  } finally { if (!disposed) saving.value = false; }
}
onMounted(() => { dialog.value?.showModal(); window.addEventListener('beforeunload', beforeUnload); void loadReview(); });
onBeforeUnmount(() => { disposed = true; window.removeEventListener('beforeunload', beforeUnload); dialog.value?.close(); });
</script>

<template>
  <dialog ref="dialog" aria-labelledby="wiki-editor-title" class="wiki-editor" @cancel.prevent="close">
    <form class="space-y-4" @submit.prevent="save">
      <header class="flex items-center justify-between gap-3"><h2 id="wiki-editor-title" class="text-lg font-semibold">编辑 Wiki 草稿</h2><button type="button" :disabled="saving" @click="close">关闭编辑</button></header>
      <p class="text-sm text-[var(--muted)]">保存只生成新草稿，不改变已发布页面。来源与互链保持不变，请勿添加原文无法支持的结论。</p>
      <p v-if="loading" role="status" class="text-sm">正在加载来源与对照版本…</p>
      <div v-if="error" role="alert" class="rounded-lg border border-red-300 p-3 text-sm text-red-600">{{ error }}
        <button v-if="!ready" type="button" class="ml-2 underline" :disabled="loading" @click="loadReview">重试加载</button>
      </div>
      <div v-if="conflict" role="alert" class="rounded-lg border border-amber-300 p-3 text-sm">页面已被修改，本次输入已保留。请对照最新版本，复制需要保留的内容，关闭后重新打开编辑；不会自动覆盖。
        <button type="button" class="ml-2 underline" :disabled="loading" @click="compareLatest">对照最新版本</button>
      </div>
      <fieldset :disabled="saving" class="space-y-4">
        <label class="block text-sm">页面标题<input v-model="title" autofocus maxlength="200" required class="wiki-field"></label>
        <label class="block text-sm">别名（每行一个）<textarea v-model="aliases" rows="2" maxlength="10050" class="wiki-field" /></label>
        <label class="block text-sm">页面摘要<textarea v-model="summary" maxlength="2000" rows="3" class="wiki-field" /></label>
        <section v-for="(section, index) in sections" :key="section.sectionId" class="space-y-2 rounded-lg border border-[var(--border)] p-3">
          <label class="block text-sm">章节 {{ index + 1 }} 标题<input v-model="section.headingPath[section.headingPath.length - 1]" maxlength="200" required class="wiki-field"></label>
          <label class="block text-sm">章节 {{ index + 1 }} 正文<textarea v-model="section.body" rows="7" maxlength="262144" required class="wiki-field" /></label>
          <details class="text-sm"><summary class="cursor-pointer">本节来源（只读）</summary><div v-for="source in sources.filter((s) => s.sectionId === section.sectionId)" :key="source.refId" class="mt-2"><strong>{{ source.fileName }}</strong><p class="whitespace-pre-wrap break-words leading-6">{{ source.text }}</p></div></details>
        </section>
      </fieldset>
      <details :open="comparing" class="rounded-lg border border-[var(--border)] p-3" @toggle="comparing = ($event.target as HTMLDetailsElement).open">
        <summary class="cursor-pointer text-sm font-semibold">版本对照 · {{ changes.length }} 处文本变化</summary>
        <p class="mt-2 text-xs text-[var(--muted)]">{{ baselineLabel }} → 本次编辑。按字段/章节对照，非逐字差异；来源请在上方核对。</p>
        <p v-if="!changes.length" class="mt-3 text-sm">与对照版本文本相同。</p>
        <section v-for="(change, index) in changes" :key="index" class="mt-4"><h3 class="text-sm font-semibold">{{ change.name }}</h3><div class="mt-2 grid gap-3 md:grid-cols-2">
          <div class="min-w-0 rounded-lg bg-[var(--surface-muted)] p-3"><h4 class="text-xs text-[var(--muted)]">对照版本</h4><p class="mt-1 whitespace-pre-wrap break-words text-sm">{{ change.before || '（空）' }}</p></div>
          <div class="min-w-0 rounded-lg border border-[var(--accent)] p-3"><h4 class="text-xs text-[var(--accent)]">本次编辑</h4><p class="mt-1 whitespace-pre-wrap break-words text-sm">{{ change.after || '（空）' }}</p></div>
        </div></section>
      </details>
      <p v-if="!valid" role="alert" class="text-sm text-red-600">请检查标题、章节标题和正文不能为空；别名最多 50 个、每个 200 字，正文总计不超过 256 KiB。</p>
      <footer class="flex flex-wrap items-center gap-3"><button type="submit" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" :disabled="saving || loading || !ready || !dirty || !valid || conflict">{{ saving ? '保存中…' : '保存草稿' }}</button><button type="button" class="text-sm" :disabled="saving" @click="close">取消</button><span class="text-xs text-[var(--muted)]">保存后需要重新核对并显式发布。</span></footer>
    </form>
  </dialog>
</template>

<style scoped>
.wiki-editor { width: min(900px, calc(100vw - 24px)); max-height: calc(100dvh - 32px); margin: auto; padding: 24px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text); overflow: auto; }
.wiki-editor::backdrop { background: rgb(0 0 0 / .35); }
.wiki-field { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); font-size: 14px; line-height: 1.6; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 600px) { .wiki-editor { padding: 16px; } }
</style>
