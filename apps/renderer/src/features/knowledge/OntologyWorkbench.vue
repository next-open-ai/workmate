<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { commitOntologyCandidates, extractOntologyCandidates, importOntologyCandidates, listKnowledgeDocuments, publishOntologyDraft, queryOntology, readOntologyWorkflow, reviewOntologyCandidates, saveOntologyDraft, searchKnowledgeWithOntology, type KnowledgeBasePayload, type KnowledgeDocumentRow, type OntologyHybridSearchPayload, type OntologyQueryPlanPayload, type OntologyWorkflowPayload } from '../../services/api';
import { useNotify } from '../../app/notify';
import OntologyGraphView from './OntologyGraphView.vue';

type ModelPayload = { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
type Candidate = OntologyWorkflowPayload['candidates'][number];
const props = defineProps<{ knowledgeBase: KnowledgeBasePayload; model?: ModelPayload }>();
const notify = useNotify();
const state = ref<OntologyWorkflowPayload | null>(null);
const documents = ref<KnowledgeDocumentRow[]>([]);
const selectedDocumentIds = ref<string[]>([]);
const instructions = ref('');
const draftText = ref('');
const candidateText = ref('[]');
const busy = ref(false);
const analysisBusy = ref(false);
const analysisError = ref('');
const analysisResult = ref('');
const advancedOpen = ref(false);
const verificationQuery = ref('');
const verificationBusy = ref(false);
const verificationError = ref('');
const verificationPlan = ref<OntologyQueryPlanPayload | null>(null);
const verificationResult = ref<OntologyHybridSearchPayload | null>(null);
const pending = computed(() => state.value?.candidates.filter((item) => item.status === 'pending') || []);
const accepted = computed(() => state.value?.candidates.filter((item) => item.status === 'accepted') || []);
const rejected = computed(() => state.value?.candidates.filter((item) => item.status === 'rejected') || []);
const selectableDocuments = computed(() => documents.value.slice(0, 20));
const allDocumentsSelected = computed(() => selectableDocuments.value.length > 0 && selectedDocumentIds.value.length === selectableDocuments.value.length);

async function load() {
  busy.value = true;
  verificationQuery.value = ''; verificationError.value = ''; verificationPlan.value = null; verificationResult.value = null;
  try {
    const [workflow, docs] = await Promise.all([readOntologyWorkflow(props.knowledgeBase), listKnowledgeDocuments({ knowledgeBase: props.knowledgeBase })]);
    state.value = workflow.workflow;
    draftText.value = JSON.stringify(state.value.draft, null, 2);
    documents.value = docs.documents;
    selectedDocumentIds.value = docs.documents.slice(0, 20).map((item) => item.id);
  } catch (error) { notify.error(error, 'notify.saveFailed'); }
  finally { busy.value = false; }
}
async function analyzeDocuments() {
  if (!props.model) { analysisError.value = '请先在设置中配置并启用一个应用对话模型。'; return; }
  if (!selectedDocumentIds.value.length) { analysisError.value = '请至少选择一篇文档。'; return; }
  analysisBusy.value = true; analysisError.value = ''; analysisResult.value = '';
  try {
    const result = await extractOntologyCandidates({ knowledgeBase: props.knowledgeBase, documentIds: selectedDocumentIds.value, instructions: instructions.value.trim() || undefined, model: props.model });
    state.value = result.workflow;
    analysisResult.value = `已分析 ${result.analyzedChunks} 个知识切片，识别 ${result.nodes} 个实体和 ${result.edges} 条关系。请在下方审核。`;
  } catch (error) { analysisError.value = error instanceof Error ? error.message : String(error); }
  finally { analysisBusy.value = false; }
}
function toggleAllDocuments() { selectedDocumentIds.value = allDocumentsSelected.value ? [] : selectableDocuments.value.map((item) => item.id); }
async function saveDraft() { try { state.value = (await saveOntologyDraft(props.knowledgeBase, JSON.parse(draftText.value))).workflow; notify.pushRaw('success', '草稿已保存', '发布后才会成为正式本体。'); } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function publishDraft() { try { state.value = (await publishOntologyDraft(props.knowledgeBase)).workflow; draftText.value = JSON.stringify(state.value.draft, null, 2); notify.pushRaw('success', '本体已发布', `当前版本 v${state.value.published?.version || 1}`); } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function importCandidates() { try { state.value = (await importOntologyCandidates(props.knowledgeBase, JSON.parse(candidateText.value))).workflow; candidateText.value = '[]'; } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function review(id: string, decision: 'accepted' | 'rejected') { try { state.value = (await reviewOntologyCandidates(props.knowledgeBase, [id], decision)).workflow; } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function reviewAll(decision: 'accepted' | 'rejected') { if (!pending.value.length) return; try { state.value = (await reviewOntologyCandidates(props.knowledgeBase, pending.value.map((item) => item.id), decision)).workflow; } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function commit() { try { const result = await commitOntologyCandidates(props.knowledgeBase); state.value = result.workflow; draftText.value = JSON.stringify(state.value.draft, null, 2); verificationPlan.value = null; verificationResult.value = null; verificationError.value = ''; notify.pushRaw('success', '正式图谱已更新', `已提交 ${result.workflow.committed || accepted.value.length} 条事实。请重新验证召回结果。`); } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function verifyRetrieval() {
  const query = verificationQuery.value.trim();
  if (query.length < 2) { verificationError.value = '请输入至少 2 个字符的验证问题。'; return; }
  verificationBusy.value = true; verificationError.value = ''; verificationPlan.value = null; verificationResult.value = null;
  try {
    verificationPlan.value = (await queryOntology(props.knowledgeBase, query, 1)).plan;
    verificationResult.value = await searchKnowledgeWithOntology({ knowledgeBase: props.knowledgeBase, query, topK: 6, model: props.model });
  } catch (error) {
    verificationError.value = error instanceof Error ? error.message : String(error);
  } finally { verificationBusy.value = false; }
}
function nodeName(id: string) {
  const plan = verificationPlan.value;
  return [...(plan?.matchedNodes || []), ...(plan?.relatedNodes || [])].find((node) => node.id === id)?.name || id;
}
function candidateTitle(item: Candidate) { return item.kind === 'node' ? String(item.node?.name || item.node?.id || '未命名实体') : String(item.edge?.predicate || '未命名关系'); }
function candidateMeta(item: Candidate) { return item.kind === 'node' ? `实体 · ${String(item.node?.type || '概念')}` : `${String(item.edge?.subjectId || '?')} → ${String(item.edge?.objectId || '?')}`; }
watch(() => props.knowledgeBase.id, load);
onMounted(load);
</script>

<template>
  <div class="grid gap-4">
    <section class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div class="border-b border-[var(--border)] bg-gradient-to-r from-[var(--accent)]/10 via-[var(--surface)] to-[var(--surface)] px-5 py-5">
        <div class="flex flex-wrap items-start justify-between gap-3"><div class="flex items-start gap-3"><span class="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--accent)] font-bold text-white">AI</span><div><h3 class="font-semibold">从文档智能构建本体</h3><p class="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">应用模型从知识库文档中识别实体、关系和原文证据。分析结果只进入待审核区，不会自动修改正式图谱。</p></div></div><span class="rounded-full bg-[var(--surface-muted)] px-3 py-1.5 text-xs">正式版本 v{{ state?.published?.version || 0 }}</span></div>
      </div>
      <div class="grid gap-5 p-5 lg:grid-cols-[1.35fr_1fr]">
        <div><div class="mb-2 flex justify-between"><label class="text-xs font-semibold">选择分析文档</label><button type="button" class="text-xs font-semibold text-[var(--accent)]" @click="toggleAllDocuments">{{ allDocumentsSelected ? '取消全选' : '全选' }}</button></div>
          <div v-if="busy" class="rounded-xl border border-dashed border-[var(--border)] py-8 text-center text-xs text-[var(--muted)]">正在读取知识库文档…</div>
          <div v-else-if="!documents.length" class="rounded-xl border border-dashed border-[var(--border)] py-8 text-center text-xs text-[var(--muted)]">知识库中还没有文档，请先上传并写入索引。</div>
          <div v-else class="max-h-52 space-y-2 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/35 p-2"><label v-for="document in documents" :key="document.id" class="flex cursor-pointer gap-3 rounded-lg bg-[var(--surface)] px-3 py-2.5"><input v-model="selectedDocumentIds" :value="document.id" type="checkbox" class="mt-1" :disabled="selectedDocumentIds.length >= 20 && !selectedDocumentIds.includes(document.id)" /><span class="min-w-0 flex-1"><strong class="block truncate text-xs">{{ document.title }}</strong><span class="mt-1 block text-[11px] text-[var(--muted)]">{{ document.chunkCount }} 个切片<span v-if="document.source"> · {{ document.source }}</span></span></span></label></div>
          <p class="mt-2 text-[11px] text-[var(--muted)]">已选择 {{ selectedDocumentIds.length }} / {{ documents.length }} 篇；单次最多分析 20 篇、60 个切片。</p>
        </div>
        <div class="flex flex-col"><label class="text-xs font-semibold">分析重点 <span class="font-normal text-[var(--muted)]">（可选）</span></label><textarea v-model="instructions" rows="5" class="mt-2 min-h-32 flex-1 resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-3 text-sm" placeholder="例如：重点识别产品、客户、服务流程及它们之间的关系。" /><button type="button" class="mt-3 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-45" :disabled="analysisBusy || !documents.length || !selectedDocumentIds.length || !model" @click="analyzeDocuments">{{ analysisBusy ? '正在读取文档并分析…' : '开始 AI 识别' }}</button><p v-if="!model" class="mt-2 text-xs text-amber-700">尚未配置可用的应用对话模型。</p></div>
      </div>
      <div v-if="analysisBusy" class="mx-5 mb-5 flex gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-800"><span class="mt-0.5 h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" /><div><p class="text-sm font-semibold">正在生成本体候选</p><p class="mt-1 text-xs">正在读取切片、调用模型并核验证据引用，请保持页面开启。</p></div></div>
      <div v-else-if="analysisResult" class="mx-5 mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">✓ {{ analysisResult }}</div>
      <div v-else-if="analysisError" class="mx-5 mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{{ analysisError }}</div>
    </section>

    <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-semibold">候选审核</h3><p class="mt-1 text-xs text-[var(--muted)]">核对识别结果和原文证据，批准后再统一写入正式图谱。</p></div><div class="flex gap-2 text-xs"><span class="rounded-full bg-amber-100 px-2.5 py-1 text-amber-700">待审核 {{ pending.length }}</span><span class="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">已接受 {{ accepted.length }}</span><span class="rounded-full bg-slate-100 px-2.5 py-1">已拒绝 {{ rejected.length }}</span></div></div>
      <div v-if="pending.length" class="mb-4 flex flex-wrap justify-end gap-2"><button class="rounded-lg border border-rose-200 px-3 py-2 text-xs text-rose-600" @click="reviewAll('rejected')">全部拒绝</button><button class="rounded-lg border border-emerald-300 px-3 py-2 text-xs text-emerald-700" @click="reviewAll('accepted')">全部接受</button><button :disabled="!accepted.length" class="rounded-lg bg-emerald-600 px-3 py-2 text-xs text-white disabled:opacity-40" @click="commit">批准并写入 {{ accepted.length }} 条</button></div>
      <div v-if="busy" class="py-10 text-center text-sm text-[var(--muted)]">正在读取本体状态…</div>
      <div v-else-if="!pending.length" class="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-muted)]/35 py-12 text-center"><p class="text-sm font-semibold">暂无待审核候选</p><p class="mt-1 text-xs text-[var(--muted)]">从上方选择文档并开始 AI 识别。</p><button v-if="accepted.length" class="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white" @click="commit">批准并写入 {{ accepted.length }} 条</button></div>
      <div v-else class="grid gap-3 md:grid-cols-2"><article v-for="item in pending" :key="item.id" class="rounded-xl border border-[var(--border)] p-4"><div class="flex items-start justify-between gap-3"><div><span class="rounded-md bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] text-[var(--accent)]">{{ item.kind === 'node' ? '实体' : '关系' }}</span><strong class="mt-1 block text-sm">{{ candidateTitle(item) }}</strong><p class="mt-1 text-xs text-[var(--muted)]">{{ candidateMeta(item) }}</p></div><span class="shrink-0 rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[11px]">{{ Math.round(item.confidence * 100) }}%</span></div><blockquote class="mt-3 rounded-lg border-l-2 border-[var(--accent)] bg-[var(--surface-muted)]/55 px-3 py-2 text-xs text-[var(--muted)]"><span class="line-clamp-4">{{ item.evidence[0]?.quote }}</span><footer class="mt-2 truncate text-[10px] opacity-70">{{ item.evidence[0]?.source || item.evidence[0]?.documentId }} · {{ item.evidence[0]?.chunkId }}</footer></blockquote><div class="mt-3 flex justify-end gap-2"><button class="rounded-lg border border-rose-300 px-3 py-1.5 text-xs text-rose-600" @click="review(item.id, 'rejected')">拒绝</button><button class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white" @click="review(item.id, 'accepted')">接受</button></div></article></div>
    </section>

    <OntologyGraphView :graph="state?.published" />

    <section class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div class="border-b border-[var(--border)] bg-gradient-to-r from-emerald-500/10 via-[var(--surface)] to-[var(--surface)] px-5 py-5">
        <div class="flex flex-wrap items-start justify-between gap-3"><div><div class="flex items-center gap-2"><span class="grid h-8 w-8 place-items-center rounded-xl bg-emerald-600 text-sm font-bold text-white">⌕</span><h3 class="font-semibold">本体检索验证</h3></div><p class="mt-2 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">输入真实业务问题，检查正式本体是否命中实体、扩展一跳关系并增强知识片段召回。此操作只读，不会修改本体或知识库。</p></div><span :class="['rounded-full px-3 py-1.5 text-xs font-semibold', state?.published ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700']">{{ state?.published ? `正式版本 v${state.published.version}` : '尚未发布本体' }}</span></div>
      </div>
      <div class="p-5">
        <form class="flex flex-col gap-3 sm:flex-row" @submit.prevent="verifyRetrieval"><label class="min-w-0 flex-1"><span class="sr-only">验证问题</span><input v-model="verificationQuery" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/10" placeholder="例如：A 公司负责哪个项目？退款没有到账应该走什么流程？" /></label><button type="submit" class="rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-45" :disabled="verificationBusy || verificationQuery.trim().length < 2">{{ verificationBusy ? '正在规划并召回…' : '开始验证' }}</button></form>
        <div v-if="verificationBusy" class="mt-4 flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-800"><span class="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" /><div><p class="text-sm font-semibold">正在执行双路召回</p><p class="mt-1 text-xs">先解析实体和一跳关系，同时保留原始向量检索作为召回保底。</p></div></div>
        <div v-else-if="verificationError" class="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><strong>验证未完成</strong><p class="mt-1 break-words text-xs leading-relaxed">{{ verificationError }}</p><p v-if="verificationPlan" class="mt-2 text-xs">本体查询规划已成功，失败发生在知识片段召回阶段。</p></div>
        <div v-if="verificationPlan && !verificationBusy" class="mt-5 grid gap-4">
          <div class="grid gap-3 sm:grid-cols-3"><div class="rounded-xl bg-[var(--surface-muted)] px-4 py-3"><p class="text-[11px] font-semibold text-[var(--muted)]">检索策略</p><p :class="['mt-1 text-sm font-bold', verificationResult?.strategy === 'ontology-enhanced' ? 'text-emerald-700' : 'text-slate-700']">{{ !verificationResult ? '仅完成本体规划' : verificationResult.strategy === 'ontology-enhanced' ? '本体增强召回' : '普通向量召回' }}</p></div><div class="rounded-xl bg-[var(--surface-muted)] px-4 py-3"><p class="text-[11px] font-semibold text-[var(--muted)]">实体与关系</p><p class="mt-1 text-sm font-bold">{{ verificationPlan.matchedNodes.length }} 个命中 · {{ verificationPlan.relatedNodes.length }} 个关联 · {{ verificationPlan.edges.length }} 条关系</p></div><div class="rounded-xl bg-[var(--surface-muted)] px-4 py-3"><p class="text-[11px] font-semibold text-[var(--muted)]">召回结果</p><p class="mt-1 text-sm font-bold">{{ verificationResult ? `${verificationResult.results.length} 个知识片段` : '尚未完成' }}</p></div></div>
          <div v-if="!verificationPlan.matchedNodes.length" class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"><strong>本次未命中正式本体</strong><p class="mt-1 text-xs">系统已自动退化为原始向量检索。请检查实体是否已审核提交、别名是否覆盖当前问法。</p></div>
          <div v-else class="grid gap-4 lg:grid-cols-2"><div class="rounded-xl border border-[var(--border)] p-4"><h4 class="text-sm font-semibold">命中与扩展</h4><div class="mt-3 flex flex-wrap gap-2"><span v-for="node in verificationPlan.matchedNodes" :key="node.id" class="rounded-lg bg-emerald-100 px-2.5 py-1.5 text-xs text-emerald-800"><strong>{{ node.name }}</strong><span class="ml-1 opacity-70">{{ Math.round(node.score * 100) }}%</span></span><span v-for="node in verificationPlan.relatedNodes" :key="node.id" class="rounded-lg bg-blue-100 px-2.5 py-1.5 text-xs text-blue-800">关联：{{ node.name }}</span></div><div v-if="verificationPlan.expandedTerms.length" class="mt-4"><p class="text-[11px] font-semibold text-[var(--muted)]">查询扩展词</p><div class="mt-2 flex flex-wrap gap-1.5"><code v-for="term in verificationPlan.expandedTerms" :key="term" class="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[11px]">{{ term }}</code></div></div></div><div class="rounded-xl border border-[var(--border)] p-4"><h4 class="text-sm font-semibold">关系与过滤信号</h4><ul v-if="verificationPlan.edges.length" class="mt-3 space-y-2"><li v-for="edge in verificationPlan.edges" :key="edge.id" class="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs"><strong>{{ nodeName(edge.subjectId) }}</strong><span class="mx-2 text-[var(--accent)]">{{ edge.predicate }}</span><strong>{{ nodeName(edge.objectId) }}</strong></li></ul><p v-else class="mt-3 text-xs text-[var(--muted)]">没有匹配到一跳关系。</p><dl v-if="Object.keys(verificationPlan.filters).length" class="mt-3 grid gap-1.5 border-t border-[var(--border)] pt-3 text-xs"><div v-for="(value, key) in verificationPlan.filters" :key="key" class="flex justify-between gap-3"><dt class="text-[var(--muted)]">{{ key }}</dt><dd class="break-all text-right font-medium">{{ value }}</dd></div></dl></div></div>
          <div v-if="verificationResult" class="rounded-xl border border-[var(--border)]"><div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3"><h4 class="text-sm font-semibold">最终召回片段</h4><span class="text-[11px] text-[var(--muted)]">已融合原始与本体增强路径</span></div><div v-if="verificationResult.results.length" class="divide-y divide-[var(--border)]"><article v-for="hit in verificationResult.results" :key="hit.id" class="px-4 py-3"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><strong class="block truncate text-sm">{{ hit.title }}</strong><p v-if="hit.source" class="mt-0.5 truncate text-[10px] text-[var(--muted)]">{{ hit.source }}</p></div><span class="shrink-0 rounded-full bg-[var(--accent)]/10 px-2 py-1 text-[11px] font-semibold text-[var(--accent)]">{{ (hit.score * 100).toFixed(1) }}%</span></div><p class="mt-2 line-clamp-4 text-xs leading-relaxed text-[var(--muted)]">{{ hit.content }}</p></article></div><div v-else class="px-4 py-10 text-center text-sm text-[var(--muted)]">没有召回知识片段。请确认文档已经完成向量索引。</div></div>
        </div>
      </div>
    </section>

    <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface)]"><button type="button" class="flex w-full items-center justify-between px-5 py-4 text-left" @click="advancedOpen = !advancedOpen"><span><strong class="text-sm">高级编辑</strong><span class="ml-2 text-xs font-normal text-[var(--muted)]">供熟悉本体结构的管理员使用</span></span><span>{{ advancedOpen ? '收起' : '展开' }}</span></button><div v-if="advancedOpen" class="grid gap-4 border-t border-[var(--border)] p-5 xl:grid-cols-2"><div><h3 class="mb-2 font-semibold">本体草稿 JSON</h3><textarea v-model="draftText" class="h-72 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 font-mono text-xs" /><div class="mt-3 flex justify-end gap-2"><button class="rounded-lg border px-3 py-2 text-sm" @click="saveDraft">保存草稿</button><button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white" @click="publishDraft">发布版本</button></div></div><div><h3 class="mb-2 font-semibold">候选 JSON 导入</h3><textarea v-model="candidateText" class="h-72 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 font-mono text-xs" /><div class="mt-3 flex justify-end"><button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white" @click="importCandidates">导入候选</button></div></div></div></section>
  </div>
</template>
