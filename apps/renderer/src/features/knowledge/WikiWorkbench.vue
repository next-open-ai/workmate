<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type { ModelConfig, WikiDirectory, WikiPageView, WikiSources, WikiGenerationJob, WikiRelatedPage } from '@workmate/contracts';
import { wikiApi, downloadWikiSource, wikiGenerationFailureMessage } from '../../services/wiki';
import { listKnowledgeDocuments, type KnowledgeBasePayload, type KnowledgeDocumentRow } from '../../services/api';
import WikiEditor from './WikiEditor.vue';
import WikiGenerationProgress from './WikiGenerationProgress.vue';
import WikiMergePanel from './WikiMergePanel.vue';

const props = defineProps<{ knowledgeBase: KnowledgeBasePayload; model?: ModelConfig; initialPageId?: string }>();
const kb = props.knowledgeBase.id;
const drafts = ref(false), query = ref(''), error = ref(''), busy = ref(false), loading = ref(false);
const items = ref<WikiDirectory['items']>([]), next = ref<string | null>(null);
const page = ref<WikiPageView>(), sources = ref<WikiSources['items']>([]), related = ref<WikiRelatedPage[]>([]);
const choosing = ref(false), documents = ref<KnowledgeDocumentRow[]>([]), chosen = ref<string[]>([]);
const job = ref<WikiGenerationJob>(), cancelled = ref(false), reviewed = ref(false);
const progressStalled = ref(false);
const editing = ref<WikiPageView>();
const reading = ref(false);
const mergeNotice = ref('');
async function merged(pageId: string) {
  mergeNotice.value = '已保存为已有主题的更新草稿，请核对来源后发布。原生成草稿仍保留。';
  await switchView(true); await open(pageId, true);
}
function returnToDirectory() {
  ++pageToken; page.value = undefined; sources.value = []; related.value = []; reviewed.value = false; reading.value = false;
}
const outlineOpen = ref(true), activeSection = ref('');
const selected = ref<WikiDirectory['items']>([]);
const batchStatus = ref(''), batchErrors = ref<string[]>([]);
function toggleSelected(id: string) {
  if (busy.value) return;
  const item = items.value.find(item => item.page.pageId === id);
  selected.value = selected.value.some(item => item.page.pageId === id)
    ? selected.value.filter(item => item.page.pageId !== id) : item ? [...selected.value, item] : selected.value;
}
async function collectDrafts() {
  const collected = new Map<string, WikiDirectory['items'][number]>();
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const result = await wikiApi.list(kb, true, after);
    if (disposed) throw new Error('已离开 Wiki。');
    for (const item of result.items) collected.set(item.page.pageId, item);
    after = result.nextAfterPageId ?? undefined;
    if (after && cursors.has(after)) throw new Error('目录分页异常，请刷新后重试。');
    if (after) cursors.add(after);
  } while (after);
  return [...collected.values()];
}
async function batchPublish(mode: 'select' | 'selected' | 'all') {
  if (busy.value || loading.value) return;
  busy.value = true; error.value = ''; batchStatus.value = ''; batchErrors.value = [];
  try {
    const targets = mode === 'selected' ? [...selected.value] : await collectDrafts();
    if (disposed) return;
    if (mode !== 'selected') { items.value = targets; next.value = null; selected.value = [...targets]; }
    if (mode === 'select') return;
    if (!targets.length) { batchStatus.value = '暂无待发布草稿。'; return; }
    if (!window.confirm(`发布 ${targets.length} 页草稿？请确认已核对正文和来源。发布后将进入搜索；未通过校验的页面保留草稿。`)) return;
    let succeeded = 0;
    for (const [index, target] of targets.entries()) {
      if (disposed) return;
      batchStatus.value = `正在发布 ${index + 1}/${targets.length} 页…`;
      try {
        const current = await wikiApi.read(kb, target.page.pageId, true);
        if (disposed) return;
        if (current.page.generation !== target.page.generation ||
          current.page.draftRevisionId !== target.page.draftRevisionId ||
          current.revision.revisionId !== target.page.draftRevisionId) {
          throw new Error('页面已变化，请刷新核对并重新勾选。');
        }
        if (current.freshness !== 'current') throw new Error('来源已更新，请重新生成并核对。');
        await wikiApi.publish(kb, current);
        if (disposed) return;
        succeeded++;
        selected.value = selected.value.filter(item => item.page.pageId !== target.page.pageId);
      } catch (cause) {
        if (disposed) return;
        batchErrors.value.push(`${target.title}：${message(cause)}`);
      }
    }
    batchStatus.value = `发布完成：成功 ${succeeded} 页，失败 ${batchErrors.value.length} 页。`;
    await refresh();
  } catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
const sectionAnchor = (id: string) => `wiki-section-${encodeURIComponent(JSON.stringify([kb, page.value?.page.pageId, id]))}`;
function jumpToSection(id: string) {
  const heading = document.getElementById(sectionAnchor(id));
  if (!heading) return;
  activeSection.value = id;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'start' });
}
function selectPage(id: string) {
  if (page.value?.page.pageId === id) outlineOpen.value = !outlineOpen.value;
  else void open(id);
}
const activeJob = computed(() => job.value && ['queued', 'running'].includes(job.value.state));
const jobLabel = computed(() => job.value ? ({ queued: '正在排队', running: '正在生成 Wiki', completed: '草稿已生成，请核对后发布',
  partial: '部分草稿已保留，请先查看', failed: '生成未完成',
  cancelled: '已取消，已保存的草稿仍保留', interrupted: '任务已中断，已保存草稿仍保留，不会自动继续计费' })[job.value.state] : '');
let disposed = false, listToken = 0, pageToken = 0, pollToken = 0, timer: ReturnType<typeof setTimeout> | undefined;
let requestKey = '';
watch(() => [props.model?.provider, props.model?.baseUrl, props.model?.chatModel], () => { requestKey = ''; });
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重试。';

async function refresh(append = false) {
  const token = ++listToken;
  if (!append) { ++pageToken; page.value = undefined; sources.value = []; related.value = []; reviewed.value = false; reading.value = false; }
  loading.value = true; error.value = '';
  if (!append) { items.value = []; next.value = null; }
  try {
    if (query.value.trim()) {
      drafts.value = false;
      const result = await wikiApi.search(kb, query.value.trim());
      if (disposed || token !== listToken) return;
      // Search always targets published pages; it never leaks drafts into normal results.
      searchHits.value = result.items.map((hit) => ({ pageId: hit.pageId, title: hit.title, summary: hit.snippet }));
    } else {
      const result = await wikiApi.list(kb, drafts.value, append ? next.value ?? undefined : undefined);
      if (disposed || token !== listToken) return;
      searchHits.value = []; items.value = append ? [...items.value, ...result.items] : result.items; next.value = result.nextAfterPageId;
    }
  } catch (cause) { if (!disposed && token === listToken) error.value = message(cause); }
  finally { if (!disposed && token === listToken) loading.value = false; }
}
const searchHits = ref<{ pageId: string; title: string; summary: string }[]>([]);
const rows = computed(() => query.value.trim() ? searchHits.value : items.value.map((item) => ({
  pageId: item.page.pageId, title: item.title, summary: item.summary,
})));
async function open(id: string, draft = drafts.value && !query.value.trim()) {
  reading.value = true;
  outlineOpen.value = true; activeSection.value = '';
  const token = ++pageToken; error.value = ''; page.value = undefined; sources.value = []; related.value = []; reviewed.value = false;
  try {
    const result = await wikiApi.read(kb, id, draft);
    if (disposed || token !== pageToken) return;
    page.value = result;
    const evidence = await wikiApi.sources(kb, id, result.revision.revisionId);
    if (disposed || token !== pageToken) return;
    sources.value = evidence.items;
    if (!draft) {
      const links = await wikiApi.related(kb, id);
      if (!disposed && token === pageToken) related.value = links.items;
    }
  } catch (cause) { if (!disposed && token === pageToken) error.value = message(cause); }
  finally { if (!disposed && token === pageToken) reading.value = false; }
}
async function switchView(value: boolean) { selected.value = []; drafts.value = value; query.value = ''; searchHits.value = []; await refresh(); }
function invalidateSearch() {
  reading.value = false;
  ++listToken; ++pageToken; page.value = undefined; searchHits.value = []; loading.value = false; error.value = '';
  if (!query.value.trim()) void refresh();
}
const retryNotice = ref('');
async function selectSources(retry = false) {
  if (busy.value || activeJob.value) return;
  const previousIds = retry ? job.value?.sources.map((source) => source.documentId) ?? [] : chosen.value;
  retryNotice.value = ''; documents.value = []; chosen.value = []; requestKey = '';
  choosing.value = true; error.value = ''; busy.value = true;
  try {
    const result = await listKnowledgeDocuments({ knowledgeBase: props.knowledgeBase });
    if (disposed) return;
    documents.value = result.documents;
    chosen.value = previousIds.filter((id) => result.documents.some((document) => document.id === id));
    if (retry) retryNotice.value = `${chosen.value.length < previousIds.length ? '部分原资料已不可用，请重新选择。' : '已选中上次资料，可调整后再开始。'}将使用当前模型和最新资料从头生成，可能产生模型费用；已有草稿保留，不是断点续跑。`;
  }
  catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
async function poll() {
  if (!job.value || disposed) return;
  const token = ++pollToken;
  if (timer) clearTimeout(timer);
  try {
    const result = await wikiApi.job(kb, job.value.jobId);
    if (disposed || token !== pollToken) return;
    job.value = result;
    progressStalled.value = false;
    if (activeJob.value) timer = setTimeout(() => void poll(), 1500);
    else { cancelled.value = false; if (!editing.value && !busy.value) await switchView(true); }
  } catch (cause) { if (!disposed && token === pollToken) { progressStalled.value = true; error.value = message(cause); } }
}
async function generate() {
  if (busy.value || activeJob.value || !props.model || !chosen.value.length || chosen.value.length > 5) return;
  busy.value = true; error.value = ''; requestKey ||= crypto.randomUUID();
  try {
    const result = await wikiApi.start(kb, { documentIds: chosen.value, model: props.model, idempotencyKey: requestKey });
    if (disposed) return;
    job.value = result; choosing.value = false; requestKey = ''; cancelled.value = false; void poll();
  } catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
async function cancel() {
  if (!job.value || cancelled.value) return; cancelled.value = true;
  try { await wikiApi.cancel(kb, job.value.jobId); }
  catch (cause) { if (!disposed) { error.value = message(cause); cancelled.value = false; } }
}
let resumeKey = '';
async function resumeGeneration() {
  if (busy.value || activeJob.value || !job.value?.resumable || !props.model) return;
  if (!window.confirm('继续未完成的生成？已校验批次会复用，未完成批次可能产生模型费用。原资料或模型改变时将拒绝继续。')) return;
  busy.value = true; error.value = ''; resumeKey ||= crypto.randomUUID();
  try {
    const result = await wikiApi.start(kb, { documentIds: job.value.sources.map((source) => source.documentId),
      model: props.model, idempotencyKey: resumeKey, resumeJobId: job.value.jobId });
    if (disposed) return;
    job.value = result; resumeKey = ''; cancelled.value = false; choosing.value = false; void poll();
  } catch (cause) { if (!disposed) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
async function publish() {
  if (!page.value || busy.value || !reviewed.value) return;
  const current = page.value, token = pageToken; busy.value = true; error.value = '';
  try {
    await wikiApi.publish(kb, current);
    if (disposed || token !== pageToken) return;
    await switchView(false); await open(current.page.pageId, false);
  } catch (cause) { if (!disposed && token === pageToken) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
async function edit() {
  if (!page.value || busy.value || page.value.freshness !== 'current') return;
  const current = page.value, token = pageToken; busy.value = true; error.value = '';
  try {
    let latest = await wikiApi.read(kb, current.page.pageId, Boolean(current.page.draftRevisionId));
    if (latest.page.draftRevisionId && latest.page.draftRevisionId !== latest.revision.revisionId) {
      latest = await wikiApi.read(kb, current.page.pageId, true);
    }
    if (!disposed && token === pageToken) {
      if (latest.freshness !== 'current') throw new Error('来源已更新，请重新生成后核对。');
      editing.value = latest;
    }
  } catch (cause) { if (!disposed && token === pageToken) error.value = message(cause); }
  finally { if (!disposed) busy.value = false; }
}
async function saved(pageId: string) {
  editing.value = undefined; reviewed.value = false;
  await switchView(true); if (!disposed) await open(pageId, true);
}
async function download(item: WikiSources['items'][number]) {
  if (item.evidence.verification !== 'versioned') return;
  const token = pageToken;
  try { await downloadWikiSource(item.evidence.documentVersionId, item.fileName); }
  catch (cause) { if (!disposed && token === pageToken) error.value = message(cause); }
}
onMounted(async () => {
  await refresh();
  if (!disposed && props.initialPageId) await open(props.initialPageId, false);
  try {
    const result = await wikiApi.jobs(kb); if (disposed) return;
    job.value = result.items[0]; if (activeJob.value) void poll();
  } catch (cause) { if (!disposed) error.value = message(cause); }
});
onBeforeUnmount(() => { disposed = true; ++listToken; ++pageToken; ++pollToken; if (timer) clearTimeout(timer); });
</script>

<template>
  <section class="wiki-workbench rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Wiki 知识库">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div><h2 class="text-base font-semibold">Wiki</h2><p class="mt-1 text-xs text-[var(--muted)]">从原始资料整理主题，核对来源后发布。</p></div>
      <div class="flex flex-wrap gap-2">
        
        
        <button class="wiki-button" :disabled="busy" @click="returnToDirectory(); switchView(false)">Wiki 首页</button>
        <button class="wiki-primary" :disabled="busy || !!activeJob" @click="selectSources()">生成 Wiki</button>
      </div>
    </header>
    <p v-if="mergeNotice" role="status" class="mt-3 rounded-lg bg-[var(--accent-soft)] p-3 text-sm">{{ mergeNotice }}</p>
    <p v-if="error" role="alert" class="mt-3 rounded-lg border border-red-300 p-3 text-sm text-red-600">{{ error }} <button class="underline" :disabled="busy" @click="refresh(); activeJob && poll()">刷新重试</button></p>
    <WikiGenerationProgress v-if="job" :job="job" :label="jobLabel" :cancelling="cancelled" :stalled="progressStalled">
      <button v-if="activeJob" class="ml-3 underline" :disabled="cancelled" @click="cancel">{{ cancelled ? '正在取消…' : '取消生成' }}</button>
      <button v-else-if="job.pageIds.length" class="ml-3 underline" :disabled="busy" @click="switchView(true)">查看草稿</button>
      <button v-if="!activeJob && job.state !== 'completed' && job.resumable" class="wiki-primary" :disabled="busy || !model" @click="resumeGeneration">继续生成</button>
      <button v-if="!activeJob && job.state !== 'completed'" class="wiki-button" :disabled="busy" @click="selectSources(true)">重新生成</button>
      <p v-if="job.state === 'failed' || job.state === 'partial'" class="mt-2">{{ wikiGenerationFailureMessage(job.errorCode) }}</p>
    </WikiGenerationProgress>
    <div v-if="choosing" class="mt-4 space-y-3 rounded-lg border border-[var(--border)] p-4">
      <h3 class="font-semibold">选择资料（最多 5 份）</h3>
      <p v-if="retryNotice" role="status" class="rounded-lg bg-[var(--accent-soft)] p-3 text-xs leading-relaxed">{{ retryNotice }}</p>
      <p class="text-xs text-[var(--muted)]">长资料自动分批处理，最多 400 块、192,000 字符。同名主题汇集后仍需核对；不同标题不会自动合并。</p>
      <p class="text-xs text-[var(--muted)]">完整文本将发送给 {{ model?.chatModel || '尚未配置的对话模型' }}。点击开始后调用模型，生成后仍需核对。重新生成会创建新草稿，不覆盖旧页面。</p>
      <p v-if="!model" class="text-sm">请先在设置中配置对话模型。浏览和搜索不受影响。</p>
      <p v-if="!documents.length && !busy" class="text-sm">暂无资料，请先到“文档”上传并完成入库。</p>
      <div class="max-h-52 space-y-2 overflow-auto"><label v-for="document in documents" :key="document.id" class="flex items-start gap-2 text-sm">
        <input v-model="chosen" type="checkbox" :value="document.id" :disabled="busy || (chosen.length >= 5 && !chosen.includes(document.id))" @change="requestKey = ''">{{ document.title }}
      </label></div>
      <div class="flex gap-3"><button class="wiki-primary" :disabled="busy || !model || !chosen.length" @click="generate">{{ busy ? '处理中…' : `开始生成（${chosen.length} 份）` }}</button><button class="wiki-button" :disabled="busy" @click="choosing = false">收起</button></div>
    </div>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <button class="wiki-button" :disabled="busy" :aria-pressed="!drafts" @click="switchView(false)">已发布</button><button class="wiki-button" :disabled="busy" :aria-pressed="drafts" @click="switchView(true)">待发布草稿</button>
      <form class="flex min-w-0 flex-1 gap-2" @submit.prevent="!busy && refresh()"><input v-model="query" :disabled="busy" aria-label="搜索 Wiki" placeholder="搜索已发布页面：标题、别名或关键词" maxlength="256" class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm" @input="invalidateSearch"><button class="wiki-button" :disabled="busy" type="submit">搜索</button></form>
    </div>
    <div v-if="batchStatus || batchErrors.length" class="mt-3 space-y-2 rounded-lg bg-[var(--surface-muted)] p-3 text-sm">
      <p role="status">{{ batchStatus }}</p>
      <ul v-if="batchErrors.length" aria-label="发布失败页面" class="space-y-1"><li v-for="failure in batchErrors" :key="failure">{{ failure }}</li></ul>
    </div>
    <div class="mt-4 grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
      <nav aria-label="Wiki 页面目录" class="space-y-2">
        <h3 class="text-sm font-semibold">{{ query.trim() ? '搜索结果' : '页面树' }}</h3>
        <p class="text-xs text-[var(--muted)]">点击页面展开章节，点击章节定位正文。</p>
        <div v-if="drafts && !query.trim()" class="space-y-2 rounded-lg border border-[var(--border)] p-2">
          <div class="flex flex-wrap gap-2">
            <button class="wiki-button" :disabled="busy || loading || !rows.length" @click="batchPublish('select')">全选全部草稿</button>
            <button class="wiki-button" :disabled="busy || !selected.length" @click="selected = []">取消全选</button>
          </div>
          <div class="flex flex-wrap gap-2">
            <button class="wiki-primary" :disabled="busy || loading || !selected.length" @click="batchPublish('selected')">发布所选（{{ selected.length }} 页）</button>
            <button class="wiki-button" :disabled="busy || loading || !rows.length" @click="batchPublish('all')">全部发布</button>
          </div>
          <p class="text-xs text-[var(--muted)]">全选和全部发布包含未加载的草稿。点击页面可预览；发布前请核对正文和来源。离开将停止后续发布，已提交的页面可能完成。</p>
        </div>
        <p v-if="loading" role="status" class="text-sm">正在加载…</p>
        <p v-else-if="!rows.length" class="text-sm text-[var(--muted)]">{{ query.trim() ? '未找到已发布页面，请换关键词或查看原始资料。' : drafts ? '暂无草稿，选择资料生成 Wiki。' : '暂无已发布页面。先生成草稿，核对后发布。' }}</p>
        <ul class="space-y-2">
          <li v-for="item in rows" :key="item.pageId" class="min-w-0">
            <label v-if="drafts && !query.trim()" class="mb-1 flex items-center gap-2 text-xs">
              <input type="checkbox" :aria-label="`选择 ${item.title}`" :checked="selected.some(entry => entry.page.pageId === item.pageId)" :disabled="busy" @change="toggleSelected(item.pageId)">选择发布
            </label>
            <button class="block w-full rounded-lg border border-[var(--border)] p-3 text-left hover:bg-[var(--surface-muted)]" :aria-current="page?.page.pageId === item.pageId ? 'page' : undefined" :aria-expanded="page?.page.pageId === item.pageId && outlineOpen" @click="selectPage(item.pageId)">
              <strong class="block break-words text-sm"><span aria-hidden="true">{{ page?.page.pageId === item.pageId && outlineOpen ? '▾' : '▸' }}</span> {{ item.title }}</strong><span class="mt-1 block line-clamp-2 break-words text-xs text-[var(--muted)]">{{ item.summary }}</span>
            </button>
            <ul v-if="page?.page.pageId === item.pageId && outlineOpen" :aria-label="`${item.title}的章节`" class="ml-3 mt-2 space-y-1 border-l border-[var(--border)] pl-3">
              <li v-for="section in page.revision.content.sections" :key="section.sectionId">
                <button class="w-full rounded px-2 py-1.5 text-left text-xs break-words hover:bg-[var(--surface-muted)]" :aria-current="activeSection === section.sectionId ? 'location' : undefined" @click="jumpToSection(section.sectionId)">{{ section.headingPath.join(' / ') }}</button>
              </li>
            </ul>
          </li>
        </ul>
        <button v-if="next && !query.trim()" class="wiki-button" :disabled="loading || busy" @click="refresh(true)">更多页面</button>
      </nav>
      <article v-if="page" class="min-w-0 space-y-4">
        <button class="wiki-button" @click="returnToDirectory">← 返回{{ drafts ? '草稿目录' : query.trim() ? '搜索结果' : 'Wiki 首页' }}</button>
        <button class="wiki-button" :disabled="busy || page.freshness !== 'current'" @click="edit">{{ page.page.draftRevisionId ? '编辑草稿 / 对照版本' : '编辑为新草稿' }}</button>
        <h2 class="text-xl font-semibold">{{ page.revision.content.title }}</h2>
        <p class="text-sm text-[var(--muted)]">{{ page.revision.content.summary }}</p>
        <WikiMergePanel v-if="!page.page.publishedRevisionId && page.page.draftRevisionId === page.revision.revisionId && page.freshness === 'current'" :key="page.revision.revisionId" :kb="kb" :source-page-id="page.page.pageId" :disabled="busy || !!activeJob" @saved="merged" />
        <p v-if="page.freshness === 'stale'" role="status" class="text-sm text-amber-700">来源已更新，本文待核对；请重新生成，旧引用仍可查看。</p>
        <div v-for="section in page.revision.content.sections" :key="section.sectionId" class="space-y-2">
          <h3 :id="sectionAnchor(section.sectionId)" tabindex="-1" class="scroll-mt-6 rounded font-semibold focus:outline-2 focus:outline-[var(--accent)]">{{ section.headingPath.join(' / ') }}</h3>
          <p class="whitespace-pre-wrap break-words text-sm leading-7">{{ page.revision.content.bodyMarkdown.slice(section.start, section.end) }}</p>
          <details class="rounded-lg bg-[var(--surface-muted)] p-3 text-sm"><summary class="cursor-pointer">查看本节来源</summary>
            <div v-for="item in sources.filter(s => s.sectionId === section.sectionId)" :key="item.refId" class="mt-3 border-t border-[var(--border)] pt-3">
              <strong>{{ item.fileName }}</strong><p class="mt-1 whitespace-pre-wrap break-words text-xs leading-6">{{ item.text }}</p>
              <p v-if="item.evidence.verification === 'versioned' && item.evidence.sourceLocation" class="text-xs text-[var(--muted)]">规范化文本位置 {{ item.evidence.sourceLocation.start }}–{{ item.evidence.sourceLocation.end }}（非文件页码）</p>
              <button class="mt-2 underline" @click="download(item)">下载原文件</button>
            </div>
          </details>
          <div class="flex flex-wrap gap-2"><button v-for="link in page.revision.content.links.filter(l => l.sourceSectionId === section.sectionId)" :key="link.targetPageId" class="text-sm text-[var(--accent)] underline" @click="open(link.targetPageId, page.page.draftRevisionId === page.revision.revisionId)">{{ link.label }}</button></div>
        </div>
        <div v-if="related.length" class="border-t border-[var(--border)] pt-3"><h3 class="text-sm font-semibold">相关页面</h3><button v-for="link in related" :key="link.pageId + link.direction" class="mr-3 mt-2 text-sm text-[var(--accent)] underline" @click="open(link.pageId, false)">{{ link.title }}{{ link.direction === 'in' ? '（引用此页）' : '' }}</button></div>
        <div v-if="page.page.draftRevisionId === page.revision.revisionId" class="space-y-3 border-t border-[var(--border)] pt-4">
          <label class="flex items-start gap-2 text-sm"><input v-model="reviewed" type="checkbox" :disabled="busy || !sources.length">我已核对正文和来源。引用完整不代表内容必然正确。</label>
          <button class="wiki-primary" :disabled="busy || !reviewed || page.freshness !== 'current'" @click="publish">{{ busy ? '发布中…' : '发布此页' }}</button>
        </div>
      </article>
      <section v-else class="wiki-home min-w-0" :aria-label="drafts ? 'Wiki 草稿目录' : query.trim() ? 'Wiki 搜索目录' : 'Wiki 首页目录'">
        <div class="rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] p-5">
          <p class="text-xs font-semibold tracking-widest text-[var(--accent)]">{{ drafts ? 'WIKI · 草稿预览' : query.trim() ? 'WIKI · 搜索结果' : 'WIKI · 知识导航' }}</p>
          <h2 class="mt-2 break-words text-xl font-semibold">{{ knowledgeBase.name }}{{ drafts ? ' · 待发布草稿' : ' · Wiki' }}</h2>
          <p class="mt-2 text-sm leading-6 text-[var(--muted)]">{{ drafts ? '这些页面尚未发布。点击预览正文与来源，核对后再发布。' : '从一个主题开始阅读，通过页面中的关联链接探索更多知识。' }}</p>
        </div>
        <p v-if="loading || reading" role="status" class="py-6 text-sm text-[var(--muted)]">{{ reading ? '正在打开页面…' : '正在加载目录…' }}</p>
        <template v-else>
          <div class="my-4 flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-semibold">{{ query.trim() ? '匹配主题' : '主题导航' }}</h3><span class="text-xs text-[var(--muted)]">当前显示 {{ rows.length }} 页{{ next && !query.trim() ? ' · 可继续加载' : '' }}</span></div>
          <p v-if="!rows.length" class="rounded-xl border border-dashed border-[var(--border)] p-6 text-sm leading-6 text-[var(--muted)]">{{ query.trim() ? '没有匹配主题，试试其他关键词。' : drafts ? '还没有草稿，点击“生成 Wiki”开始整理资料。' : '首页暂无可阅读内容。已有生成结果可在“待发布草稿”中预览，核对发布后会出现在这里。' }}</p>
          <div class="grid gap-3 xl:grid-cols-2">
            <button v-for="item in rows" :key="item.pageId" class="wiki-topic" :aria-label="`${drafts ? '预览草稿' : '阅读主题'}：${item.title}`" @click="open(item.pageId)">
              <span class="text-xs text-[var(--accent)]">{{ drafts ? '待发布 · 预览' : '主题页面' }}</span>
              <strong class="mt-2 block break-words text-base">{{ item.title }}</strong>
              <span class="mt-2 block line-clamp-3 break-words text-sm leading-6 text-[var(--muted)]">{{ item.summary || '打开页面查看正文与引用来源。' }}</span>
              <span class="mt-4 block text-xs font-semibold text-[var(--accent)]">{{ drafts ? '预览草稿' : '开始阅读' }} →</span>
            </button>
          </div>
          <button v-if="next && !query.trim()" class="wiki-button mt-4" :disabled="busy" @click="refresh(true)">加载更多主题</button>
        </template>
      </section>
    </div>
  </section>
  <WikiEditor v-if="editing" :view="editing" :knowledge-base-id="kb" @close="editing = undefined" @saved="saved" />
</template>

<style scoped>
.wiki-topic { min-width: 0; border: 1px solid var(--border); border-radius: 12px; padding: 18px; text-align: left; background: var(--surface); transition: border-color .15s, background .15s; }
.wiki-topic:hover { border-color: var(--accent); background: var(--surface-muted); }
.wiki-button { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 13px; }
.wiki-button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
.wiki-primary { background: var(--accent); color: white; border-radius: 8px; padding: 9px 14px; font-size: 13px; font-weight: 600; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>
