<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { cancelOntologyAnalysis, commitOntologyCandidates, deleteOntologyCandidates, getOntologyAnalysisStatus, importOntologyCandidates, listKnowledgeDocuments, listOntologyVersions, mergeOntologyCandidates, previewOntologyChanges, publishOntologyDraft, repairOntologyDraft, queryOntology, readOntologyWorkflow, reviewOntologyCandidates, rollbackOntologyVersion, saveOntologyDraft, searchKnowledgeWithOntology, stageOntologyCandidates, startOntologyAnalysis, upsertOntologyCandidate, type KnowledgeBasePayload, type KnowledgeDocumentRow, type OntologyAnalysisJob, type OntologyHybridSearchPayload, type OntologyPreviewPayload, type OntologyQueryPlanPayload, type OntologyVersionPayload, type OntologyWorkflowPayload } from '../../services/api';
import { useNotify } from '../../app/notify';
import OntologyGraphView from './OntologyGraphView.vue';
import OntologyGovernancePanel from './OntologyGovernancePanel.vue';

type ModelPayload = { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
type Candidate = OntologyWorkflowPayload['candidates'][number];
const props = defineProps<{ knowledgeBase: KnowledgeBasePayload; model?: ModelPayload; isAdmin?: boolean }>();
const notify = useNotify();
const state = ref<OntologyWorkflowPayload | null>(null);
const documents = ref<KnowledgeDocumentRow[]>([]);
const selectedDocumentIds = ref<string[]>([]);
const instructions = ref('');
const draftText = ref('');
const candidateText = ref('[]');
const busy = ref(false);
const analysisBusy = ref(false);
const step = ref<1|2|3|4|5>(1);
const intensity = ref<'quick'|'standard'|'deep'>('standard');
const analysisJob = ref<OntologyAnalysisJob | null>(null);
const analysisJobId = ref('');
let analysisTimer: ReturnType<typeof setInterval> | undefined;
const candidateFilter = ref('pending');
const selectedCandidate = ref<Candidate | null>(null);
const candidatePropertiesText = ref('{}');
const bulkDecision = ref<'accepted'|'rejected'|null>(null);
const preview = ref<OntologyPreviewPayload | null>(null);
const versions = ref<OntologyVersionPayload[]>([]);
const publishNote = ref('');
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
const deferred = computed(() => state.value?.candidates.filter((item) => item.status === 'deferred') || []);
const rejected = computed(() => state.value?.candidates.filter((item) => item.status === 'rejected') || []);
const selectableDocuments = computed(() => documents.value.slice(0, 20));
const duplicateGroups = computed(() => { const groups=new Map<string,Candidate[]>(); for(const c of state.value?.candidates||[]){ if(c.kind!=='node')continue; const key=String(c.node?.name||'').replace(/\s+/g,'').toLowerCase(); if(!key)continue; const list=groups.get(key)||[]; list.push(c); groups.set(key,list); } return [...groups.values()].filter(g=>g.length>1); });
const allDocumentsSelected = computed(() => selectableDocuments.value.length > 0 && selectedDocumentIds.value.length === selectableDocuments.value.length);
const analysisPercent=computed(()=>{if(!analysisJob.value)return 0;if(analysisJob.value.status==='completed')return 100;const phase=analysisPhases.indexOf(analysisJob.value.phase);if(phase<0)return 5;if(phase===0)return 12;if(phase===1)return 22;if(phase===2)return Math.min(78,28+Math.round(50*(analysisJob.value.currentBatch/Math.max(1,analysisJob.value.totalBatches))));if(phase===3)return 88;return 96});
const analysisStatusLabel=computed(()=>analysisJob.value?.status==='completed'?'识别完成':analysisJob.value?.status==='failed'?'识别失败':analysisJob.value?.status==='cancelled'?'已取消':analysisJob.value?.status==='running'?'正在识别':'准备中');
const nodeOptions = computed(() => {
  const rows = [...(state.value?.draft.nodes || []), ...(state.value?.candidates.filter((item) => item.kind === 'node').map((item) => item.node) || [])] as Array<Record<string, unknown>>;
  return [...new Map(rows.filter(Boolean).map((node) => [String(node.id), node])).values()];
});
const bulkLowConfidence = computed(() => pending.value.filter((item) => item.confidence < .7).length);
function canOpenStep(target: number) {
  if (target === 1) return true;
  if (target === 2) return Boolean(analysisJob.value);
  if (target === 3) return analysisJob.value?.status === 'completed' || Boolean(state.value?.candidates.length);
  if (target === 4) return Boolean(preview.value);
  return Boolean(state.value?.published) || Boolean(preview.value && !preview.value.validation.blockers.length);
}
function openStep(target: 1|2|3|4|5) { if (canOpenStep(target)) step.value = target; }
function openCandidate(item: Candidate) { selectedCandidate.value = structuredClone(item); candidatePropertiesText.value = JSON.stringify((item.node || item.edge)?.properties || {}, null, 2); }
function setCandidateAliases(value: string) { if (selectedCandidate.value?.node) selectedCandidate.value.node.aliases = [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))]; }

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
const analysisPhases = ['读取文档','整理分析批次','AI 识别','证据核验与候选归并','候选归并完成'];
function phaseState(label:string){
  if(!analysisJob.value) return '等待中';
  const mapped:Record<string,string>={'证据核验':'证据核验与候选归并','候选归并':'候选归并完成'};
  const target=mapped[label]||label, current=analysisPhases.indexOf(analysisJob.value.phase), wanted=analysisPhases.indexOf(target);
  if(analysisJob.value.status==='completed') return '已完成';
  if(current>wanted || (label==='证据核验' && current>=3)) return '已完成';
  if(current===wanted || (label==='候选归并' && current===3)) return label==='AI 识别' ? `${analysisJob.value.currentBatch} / ${analysisJob.value.totalBatches} 批` : '进行中';
  return '等待中';
}
async function repairDraft(){ const result=await repairOntologyDraft(props.knowledgeBase); state.value=result.workflow; await refreshPreview(); notify.pushRaw('success','阻断关系已处理', result.removedEdgeIds.length ? `已移除 ${result.removedEdgeIds.length} 条端点缺失关系，相关候选已转为暂缓。` : '未发现需要自动处理的关系。'); }
async function pollAnalysis() {
  if (!analysisJobId.value) return;
  try { const response = await getOntologyAnalysisStatus(analysisJobId.value); analysisJob.value = response.job; analysisBusy.value = response.job.status === 'running'; if (response.job.status === 'completed' && response.job.result) { state.value = response.job.result.workflow; analysisResult.value = `已分析 ${response.job.result.analyzedChunks} 个切片，识别 ${response.job.result.nodes} 个实体和 ${response.job.result.edges} 条关系。`; localStorage.removeItem(`ontology-job:${props.knowledgeBase.id}`); step.value = 3; if (analysisTimer) clearInterval(analysisTimer); } else if (response.job.status === 'failed' || response.job.status === 'cancelled') { analysisError.value = response.job.error || '任务已取消'; if (analysisTimer) clearInterval(analysisTimer); } } catch (error) { analysisError.value = error instanceof Error ? error.message : String(error); if (analysisTimer) clearInterval(analysisTimer); }
}
async function analyzeDocuments() {
  if (!props.model) { analysisError.value = '请先在设置中配置并启用一个应用对话模型。'; return; }
  if (!selectedDocumentIds.value.length) { analysisError.value = '请至少选择一篇文档。'; return; }
  analysisBusy.value = true; analysisError.value = ''; analysisResult.value = ''; step.value = 2;
  try { const result = await startOntologyAnalysis({ knowledgeBase: props.knowledgeBase, documentIds: selectedDocumentIds.value, instructions: instructions.value.trim() || undefined, model: props.model, intensity: intensity.value }); analysisJobId.value = result.jobId; localStorage.setItem(`ontology-job:${props.knowledgeBase.id}`, result.jobId); await pollAnalysis(); analysisTimer = setInterval(pollAnalysis, 1200); }
  catch (error) { analysisBusy.value = false; analysisError.value = error instanceof Error ? error.message : String(error); }
}
async function cancelAnalysis(){ if(analysisJobId.value) await cancelOntologyAnalysis(analysisJobId.value); await pollAnalysis(); }
async function refreshPreview(){ preview.value = await previewOntologyChanges(props.knowledgeBase); }
async function proceedToReview(){ state.value=(await stageOntologyCandidates(props.knowledgeBase)).workflow; await refreshPreview(); step.value=4; }
async function loadVersions(){ versions.value=(await listOntologyVersions(props.knowledgeBase)).versions; }
async function publishVersion(){ if(!props.isAdmin){notify.pushRaw('warning','等待管理员发布','草稿与治理结果已保留，请联系管理员审批发布。');return} if(preview.value?.validation.blockers.length) return; state.value=(await publishOntologyDraft(props.knowledgeBase,publishNote.value)).workflow; await loadVersions(); step.value=5; notify.pushRaw('success','本体版本已发布',`当前版本 v${state.value.published?.version}`); }
async function rollbackVersion(version:number){ if(!props.isAdmin){notify.pushRaw('warning','需要管理员权限','只有管理员可以回滚正式版本。');return} state.value=(await rollbackOntologyVersion(props.knowledgeBase,version)).workflow; await loadVersions(); }
async function removeCandidate(id:string){ state.value=(await deleteOntologyCandidates(props.knowledgeBase,[id])).workflow; selectedCandidate.value=null; }
async function deferCandidate(id:string){ state.value=(await reviewOntologyCandidates(props.knowledgeBase,[id],'deferred')).workflow; }
async function addEntity(){ const now=Date.now(), id=`manual-${now}`; const candidate={id:`candidate-${id}`,kind:'node',node:{id,type:'Concept',name:'新实体',aliases:[],properties:{_origin:'人工新增',_editedBy:'管理员',_editedAt:new Date(now).toISOString()},status:'draft'},evidence:[{documentId:'manual',quote:'人工新增',source:'人工维护'}],confidence:1,status:'pending'}; state.value=(await upsertOntologyCandidate(props.knowledgeBase,candidate)).workflow; selectedCandidate.value=state.value.candidates.find(i=>i.id===candidate.id)||null; }
async function addRelation(){ const now=Date.now(), nodes=state.value?.candidates.filter(c=>c.kind==='node')||[]; if(nodes.length<2){ notify.pushRaw('error','无法新增关系','请先新增至少两个实体。'); return; } const subject=String(nodes[0]?.node?.id), object=String(nodes[1]?.node?.id); const id=`manual-edge-${now}`; const candidate={id:`candidate-${id}`,kind:'edge',edge:{id,subjectId:subject,predicate:'关联',objectId:object,properties:{_origin:'人工新增',_editedBy:'管理员',_editedAt:new Date(now).toISOString()},status:'draft'},evidence:[{documentId:'manual',quote:'人工新增',source:'人工维护'}],confidence:1,status:'pending'}; state.value=(await upsertOntologyCandidate(props.knowledgeBase,candidate)).workflow; selectedCandidate.value=state.value.candidates.find(i=>i.id===candidate.id)||null; }
async function saveCandidate(){
  if(!selectedCandidate.value)return;
  try {
    const properties = JSON.parse(candidatePropertiesText.value || '{}');
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new Error('属性必须是 JSON 对象。');
    if (selectedCandidate.value.kind === 'node' && !String(selectedCandidate.value.node?.name || '').trim()) throw new Error('实体名称不能为空。');
    if (selectedCandidate.value.kind === 'edge' && (!String(selectedCandidate.value.edge?.predicate || '').trim() || !selectedCandidate.value.edge?.subjectId || !selectedCandidate.value.edge?.objectId)) throw new Error('请完整填写关系名称和两端实体。');
    const body = selectedCandidate.value.kind === 'node' ? selectedCandidate.value.node : selectedCandidate.value.edge;
    if (body) body.properties = properties;
    state.value=(await upsertOntologyCandidate(props.knowledgeBase,selectedCandidate.value)).workflow;
    selectedCandidate.value=null;
  } catch (error) { notify.error(error, 'notify.saveFailed'); }
}
async function mergeDuplicate(ids:string[]){ const source=state.value?.candidates.filter(c=>ids.includes(c.id)&&c.kind==='node')||[]; if(source.length<2)return; const first=structuredClone(source[0]); first.node!.aliases=[...new Set(source.flatMap(c=>[String(c.node?.name||''),...((c.node?.aliases as string[])||[])]).filter(Boolean))]; state.value=(await mergeOntologyCandidates(props.knowledgeBase,ids,first)).workflow; }

function toggleAllDocuments() { selectedDocumentIds.value = allDocumentsSelected.value ? [] : selectableDocuments.value.map((item) => item.id); }
async function saveDraft() { try { state.value = (await saveOntologyDraft(props.knowledgeBase, JSON.parse(draftText.value))).workflow; notify.pushRaw('success', '草稿已保存', '发布后才会成为正式本体。'); } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function publishDraft() { try { state.value = (await publishOntologyDraft(props.knowledgeBase)).workflow; draftText.value = JSON.stringify(state.value.draft, null, 2); notify.pushRaw('success', '本体已发布', `当前版本 v${state.value.published?.version || 1}`); } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function importCandidates() { try { state.value = (await importOntologyCandidates(props.knowledgeBase, JSON.parse(candidateText.value))).workflow; candidateText.value = '[]'; } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function review(id: string, decision: 'accepted' | 'rejected' | 'deferred') { try { state.value = (await reviewOntologyCandidates(props.knowledgeBase, [id], decision)).workflow; } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function reviewAll(decision: 'accepted' | 'rejected') { if (!pending.value.length) return; try { state.value = (await reviewOntologyCandidates(props.knowledgeBase, pending.value.map((item) => item.id), decision)).workflow; } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function confirmBulkReview(){ const decision=bulkDecision.value;if(!decision)return;bulkDecision.value=null;await reviewAll(decision); }
async function commit() { try { const result = await commitOntologyCandidates(props.knowledgeBase); state.value = result.workflow; draftText.value = JSON.stringify(state.value.draft, null, 2); verificationPlan.value = null; verificationResult.value = null; verificationError.value = ''; notify.pushRaw('success', '正式图谱已更新', `已提交 ${result.workflow.committed || accepted.value.length} 条事实。请重新验证召回结果。`); } catch (error) { notify.error(error, 'notify.saveFailed'); } }
async function verifyRetrieval() {
  const query = verificationQuery.value.trim();
  if (query.length < 2) { verificationError.value = '请输入至少 2 个字符的验证问题。'; return; }
  verificationBusy.value = true; verificationError.value = ''; verificationPlan.value = null; verificationResult.value = null;
  try {
    verificationPlan.value = (await queryOntology(props.knowledgeBase, query, 2)).plan;
    verificationResult.value = await searchKnowledgeWithOntology({ knowledgeBase: props.knowledgeBase, query, topK: 6, model: props.model });
  } catch (error) {
    verificationError.value = error instanceof Error ? error.message : String(error);
  } finally { verificationBusy.value = false; }
}
function nodeName(id: string) {
  const plan = verificationPlan.value;
  return [...(plan?.matchedNodes || []), ...(plan?.relatedNodes || [])].find((node) => node.id === id)?.name || id;
}
function pathLabel(path: OntologyQueryPlanPayload['paths'][number]) { return path.nodeIds.map(nodeName).join(' → '); }
function retrievalRouteLabel(route: 'raw-vector' | 'ontology-vector' | 'ontology-evidence') { return route === 'ontology-evidence' ? '图谱证据' : route === 'ontology-vector' ? '本体扩展' : '原始向量'; }
function candidateTitle(item: Candidate) { return item.kind === 'node' ? String(item.node?.name || item.node?.id || '未命名实体') : String(item.edge?.predicate || '未命名关系'); }
function candidateMeta(item: Candidate) { return item.kind === 'node' ? `实体 · ${String(item.node?.type || '概念')}` : `${String(item.edge?.subjectId || '?')} → ${String(item.edge?.objectId || '?')}`; }
watch(() => props.knowledgeBase.id, load);
onMounted(async()=>{ await load(); const saved=localStorage.getItem(`ontology-job:${props.knowledgeBase.id}`); if(saved){ analysisJobId.value=saved; step.value=2; await pollAnalysis(); if(analysisJob.value?.status==='running') analysisTimer=setInterval(pollAnalysis,1200); } });
onUnmounted(()=>{if(analysisTimer)clearInterval(analysisTimer)});
</script>

<template>
  <div class="grid gap-4">
    <nav class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3" aria-label="本体构建步骤">
      <ol class="grid grid-cols-5 gap-2"><li v-for="item in [{n:1,t:'选择资料'},{n:2,t:'AI 识别'},{n:3,t:'整理候选'},{n:4,t:'图谱审核'},{n:5,t:'发布版本'}]" :key="item.n"><button class="w-full rounded-xl px-2 py-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45" :disabled="!canOpenStep(item.n)" :title="canOpenStep(item.n)?undefined:'请先完成前一步'" :class="step===item.n?'bg-[var(--accent)] text-white':step>item.n?'bg-emerald-50 text-emerald-700':'bg-[var(--surface-muted)] text-[var(--muted)]'" @click="openStep(item.n as 1|2|3|4|5)"><span class="mr-1">{{ item.n }}</span>{{ item.t }}</button></li></ol>
    </nav>
    <section v-if="step === 1" class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div class="border-b border-[var(--border)] bg-gradient-to-r from-[var(--accent)]/10 via-[var(--surface)] to-[var(--surface)] px-5 py-5">
        <div class="flex flex-wrap items-start justify-between gap-3"><div class="flex items-start gap-3"><span class="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--accent)] font-bold text-white">AI</span><div><h3 class="font-semibold">从文档智能构建本体</h3><p class="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">应用模型从知识库文档中识别实体、关系和原文证据。分析结果只进入待审核区，不会自动修改正式图谱。</p></div></div><span class="rounded-full bg-[var(--surface-muted)] px-3 py-1.5 text-xs">正式版本 v{{ state?.published?.version || 0 }}</span></div>
      </div>
      <div class="grid gap-5 p-5 lg:grid-cols-[1.35fr_1fr]">
        <div><div class="mb-2 flex justify-between"><label class="text-xs font-semibold">选择分析文档</label><button type="button" class="text-xs font-semibold text-[var(--accent)]" @click="toggleAllDocuments">{{ allDocumentsSelected ? '取消全选' : '全选' }}</button></div>
          <div v-if="busy" class="rounded-xl border border-dashed border-[var(--border)] py-8 text-center text-xs text-[var(--muted)]">正在读取知识库文档…</div>
          <div v-else-if="!documents.length" class="rounded-xl border border-dashed border-[var(--border)] py-8 text-center text-xs text-[var(--muted)]">知识库中还没有文档，请先上传并写入索引。</div>
          <div v-else class="max-h-52 space-y-2 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/35 p-2"><label v-for="document in documents" :key="document.id" class="flex cursor-pointer gap-3 rounded-lg bg-[var(--surface)] px-3 py-2.5"><input v-model="selectedDocumentIds" :value="document.id" type="checkbox" class="mt-1" :disabled="selectedDocumentIds.length >= 20 && !selectedDocumentIds.includes(document.id)" /><span class="min-w-0 flex-1"><strong class="block truncate text-xs">{{ document.title }}</strong><span class="mt-1 block text-[11px] text-[var(--muted)]">{{ document.chunkCount }} 个切片 · {{ document.source?.split('.').pop()?.toUpperCase() || '文本' }} · {{ new Date(document.createdAt).toLocaleDateString() }} · 已索引<span v-if="document.source"> · {{ document.source }}</span></span></span></label></div>
          <p class="mt-2 text-[11px] text-[var(--muted)]">已选择 {{ selectedDocumentIds.length }} / {{ documents.length }} 篇；单次最多分析 20 篇、60 个切片。</p>
        </div>
        <div class="flex flex-col"><label class="text-xs font-semibold">分析重点 <span class="font-normal text-[var(--muted)]">（可选）</span></label><textarea v-model="instructions" rows="5" class="mt-2 min-h-32 flex-1 resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-3 text-sm" placeholder="例如：重点识别产品、客户、服务流程及它们之间的关系。" /><div class="mt-3 grid grid-cols-2 gap-2"><label class="text-xs font-semibold">分析强度<select v-model="intensity" class="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2"><option value="quick">快速</option><option value="standard">标准（推荐）</option><option value="deep">深入</option></select></label><div class="rounded-lg bg-[var(--surface-muted)] p-2 text-xs"><strong>抽取模型</strong><p class="mt-1 truncate text-[var(--muted)]">{{ model?.provider }} · {{ model?.chatModel }}</p><p class="mt-1 text-[var(--muted)]">预计约 {{ Math.max(1, Math.ceil(selectedDocumentIds.length * 3 / (intensity==='deep'?3:4))) }} 批</p></div></div><button type="button" class="mt-3 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-45" :disabled="analysisBusy || !documents.length || !selectedDocumentIds.length || !model" @click="analyzeDocuments">{{ analysisBusy ? '正在读取文档并分析…' : '开始 AI 识别' }}</button><p v-if="!model" class="mt-2 text-xs text-amber-700">尚未配置可用的应用对话模型。</p></div>
      </div>
      <div v-if="analysisBusy" class="mx-5 mb-5 flex gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-800"><span class="mt-0.5 h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" /><div><p class="text-sm font-semibold">正在生成本体候选</p><p class="mt-1 text-xs">正在读取切片、调用模型并核验证据引用，请保持页面开启。</p></div></div>
      <div v-else-if="analysisResult" class="mx-5 mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">✓ {{ analysisResult }}</div>
      <div v-else-if="analysisError" class="mx-5 mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{{ analysisError }}</div>
    </section>

    <section v-if="step === 2" class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div class="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border)] bg-gradient-to-r from-indigo-50 via-[var(--surface)] to-[var(--surface)] px-6 py-5"><div class="flex gap-3"><span :class="['grid h-11 w-11 place-items-center rounded-2xl text-lg',analysisJob?.status==='completed'?'bg-emerald-100 text-emerald-700':'bg-indigo-100 text-indigo-700']">{{ analysisJob?.status==='completed'?'✓':'AI' }}</span><div><h3 class="font-semibold">AI 本体识别</h3><p class="mt-1 text-xs text-[var(--muted)]">后台任务可持续运行，离开当前页面不会中断分析。</p></div></div><span :class="['rounded-full px-3 py-1.5 text-xs font-semibold',analysisJob?.status==='completed'?'bg-emerald-100 text-emerald-700':analysisJob?.status==='failed'?'bg-rose-100 text-rose-700':'bg-blue-100 text-blue-700']">{{ analysisStatusLabel }}</span></div>
      <div class="p-6"><div class="flex items-end justify-between gap-3"><div><p class="text-xs text-[var(--muted)]">总体进度</p><strong class="mt-1 block text-2xl">{{ analysisPercent }}%</strong></div><p class="text-right text-xs text-[var(--muted)]">{{ analysisJob?.status==='completed'?'所有批次和证据已经处理完成':`当前：${analysisJob?.phase||'准备任务'}` }}</p></div><div class="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100"><div class="h-full rounded-full bg-gradient-to-r from-indigo-500 to-blue-500 transition-all duration-500" :style="{width:`${analysisPercent}%`}" /></div>
        <div class="mt-6 grid gap-2 md:grid-cols-5"><div v-for="(label,index) in ['读取文档','整理分析批次','AI 识别','证据核验','候选归并']" :key="label" :class="['relative rounded-xl border p-3',phaseState(label)==='已完成'?'border-emerald-200 bg-emerald-50':phaseState(label)==='等待中'?'border-[var(--border)] bg-[var(--surface-muted)]/40':'border-blue-300 bg-blue-50']"><div class="flex items-center gap-2"><span :class="['grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold',phaseState(label)==='已完成'?'bg-emerald-600 text-white':phaseState(label)==='等待中'?'bg-slate-200 text-slate-500':'bg-blue-600 text-white']">{{ phaseState(label)==='已完成'?'✓':index+1 }}</span><strong class="text-xs">{{ label }}</strong></div><p class="mt-2 pl-8 text-[10px] text-[var(--muted)]">{{ phaseState(label) }}</p></div></div>
        <div class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/25 p-4"><span class="text-[11px] text-[var(--muted)]">处理耗时</span><strong class="mt-1 block text-lg">{{ analysisJob ? Math.round(((analysisJob.completedAt||Date.now())-analysisJob.startedAt)/1000) : 0 }} 秒</strong></div><div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/25 p-4"><span class="text-[11px] text-[var(--muted)]">抽取模型</span><strong class="mt-1 block truncate text-sm">{{ model?.chatModel }}</strong></div><div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/25 p-4"><span class="text-[11px] text-[var(--muted)]">分析批次</span><strong class="mt-1 block text-lg">{{ analysisJob?.currentBatch||0 }} / {{ analysisJob?.totalBatches||0 }}</strong></div><div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/25 p-4"><span class="text-[11px] text-[var(--muted)]">发现候选</span><strong class="mt-1 block text-lg">{{ analysisJob?.discovered||analysisJob?.result?.generated||0 }}</strong></div></div>
        <div v-if="analysisJob?.status==='completed'" class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div><strong class="text-sm text-emerald-800">识别与证据核验已完成</strong><p class="mt-1 text-xs text-emerald-700">{{ analysisResult || `共生成 ${analysisJob.result?.generated||0} 条候选，下一步请进行人工审核。` }}</p></div><button class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white" @click="step=3">查看并整理候选</button></div>
        <p v-if="analysisError" class="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{{ analysisError }}</p><div v-if="analysisJob?.status!=='completed'" class="mt-5 flex justify-end gap-2"><button class="rounded-lg border px-4 py-2 text-sm" @click="step=1">后台运行</button><button v-if="analysisBusy" class="rounded-lg border border-rose-300 px-4 py-2 text-sm text-rose-600" @click="cancelAnalysis">取消任务</button></div>
      </div>
    </section>

    <section v-if="step === 3" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-semibold">候选审核</h3><p class="mt-1 text-xs text-[var(--muted)]">核对识别结果和原文证据，批准后再统一写入正式图谱。</p></div><div class="flex gap-2 text-xs"><span class="rounded-full bg-amber-100 px-2.5 py-1 text-amber-700">待审核 {{ pending.length }}</span><span class="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">已接受 {{ accepted.length }}</span><span class="rounded-full bg-slate-100 px-2.5 py-1">已拒绝 {{ rejected.length }}</span></div></div>
      <div v-if="pending.length" class="mb-4 flex flex-wrap items-center justify-end gap-2"><span class="mr-auto text-[11px] text-[var(--muted)]">批量操作会影响当前 {{ pending.length }} 条待审核候选</span><button class="rounded-lg border border-rose-200 px-3 py-2 text-xs text-rose-600" @click="bulkDecision='rejected'">批量拒绝</button><button class="rounded-lg border border-emerald-300 px-3 py-2 text-xs text-emerald-700" @click="bulkDecision='accepted'">批量接受</button></div>
      <div v-if="busy" class="py-10 text-center text-sm text-[var(--muted)]">正在读取本体状态…</div>
      <div v-else-if="!pending.length" class="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-muted)]/35 py-12 text-center"><p class="text-sm font-semibold">暂无待审核候选</p><p class="mt-1 text-xs text-[var(--muted)]">从上方选择文档并开始 AI 识别。</p></div>
      <div v-else class="grid gap-3 md:grid-cols-2"><article v-for="item in pending" :key="item.id" class="rounded-xl border border-[var(--border)] p-4"><div class="flex items-start justify-between gap-3"><div><span class="rounded-md bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] text-[var(--accent)]">{{ item.kind === 'node' ? '实体' : '关系' }}</span><strong class="mt-1 block text-sm">{{ candidateTitle(item) }}</strong><p class="mt-1 text-xs text-[var(--muted)]">{{ candidateMeta(item) }}</p></div><span :class="['shrink-0 rounded-full px-2 py-1 text-[11px]',item.confidence<.7?'bg-amber-100 text-amber-700':'bg-[var(--surface-muted)]']">{{ Math.round(item.confidence * 100) }}%</span></div><blockquote class="mt-3 rounded-lg border-l-2 border-[var(--accent)] bg-[var(--surface-muted)]/55 px-3 py-2 text-xs text-[var(--muted)]"><span class="line-clamp-4">{{ item.evidence[0]?.quote }}</span><footer class="mt-2 truncate text-[10px] opacity-70">{{ item.evidence[0]?.source || item.evidence[0]?.documentId }} · {{ item.evidence[0]?.chunkId }}</footer></blockquote><div class="mt-3 flex justify-end gap-2"><button class="rounded-lg border px-3 py-1.5 text-xs" @click="openCandidate(item)">编辑</button><button class="rounded-lg border px-3 py-1.5 text-xs" @click="deferCandidate(item.id)">暂缓</button><button class="rounded-lg border border-rose-300 px-3 py-1.5 text-xs text-rose-600" @click="review(item.id, 'rejected')">拒绝</button><button class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white" @click="review(item.id, 'accepted')">接受</button></div></article></div>
      <div v-if="step===3" class="mt-4 flex items-center justify-between"><button class="rounded-lg border px-3 py-2 text-xs" @click="addEntity">＋ 新增实体</button><button class="rounded-lg border px-3 py-2 text-xs" @click="addRelation">＋ 新增关系</button><span v-if="duplicateGroups.length" class="text-xs text-amber-700">发现 {{ duplicateGroups.length }} 组疑似重复</span><button class="rounded-xl bg-[var(--accent)] px-5 py-3 text-sm text-white" @click="proceedToReview">保存草稿并进入图谱审核</button></div>
    </section>

    <OntologyGovernancePanel v-if="step === 4" :knowledge-base="knowledgeBase" :model="model" @updated="state=$event;draftText=JSON.stringify($event.draft,null,2);refreshPreview()" @back="step=3" @proceed="step=5;loadVersions()" />

    <section v-if="step === 5" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="font-semibold">发布正式版本</h3><p class="mt-1 text-xs text-[var(--muted)]">发布会影响数字员工的默认知识检索，仅管理员可以执行；发布人由当前登录身份自动记录。</p></div><span :class="['rounded-full px-3 py-1.5 text-xs font-semibold',isAdmin?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700']">{{ isAdmin?'管理员审批':'等待管理员' }}</span></div>
      <label class="mt-4 block text-xs font-semibold">版本说明<textarea v-model="publishNote" class="mt-1 h-24 w-full rounded-xl border p-3 font-normal" placeholder="说明本次本体变更、影响范围和验证结果" /></label>
      <div class="mt-4 flex items-center justify-between gap-3"><p class="text-xs text-[var(--muted)]">{{ isAdmin?'发布后可从历史版本反向回滚。':'你仍可整理草稿和完成治理，管理员登录后即可审批发布。' }}</p><button class="rounded-xl bg-[var(--accent)] px-5 py-3 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45" :disabled="!isAdmin" @click="publishVersion">校验并发布版本</button></div>
      <div class="mt-6 border-t pt-4"><h4 class="text-sm font-semibold">历史版本</h4><div class="mt-2 space-y-2"><div v-for="version in versions" :key="version.version" class="flex items-center justify-between rounded-xl bg-[var(--surface-muted)] p-3 text-xs"><div><strong>v{{ version.version }}</strong><span class="ml-2 text-[var(--muted)]">{{ version.note||'无版本说明' }} · {{ version.publisher||'历史发布人' }} · {{ new Date(version.publishedAt).toLocaleString() }}</span></div><button class="rounded-lg border px-3 py-1.5 disabled:opacity-40" :disabled="!isAdmin" @click="rollbackVersion(version.version)">回滚为新版本</button></div></div></div>
    </section>

    <div v-if="selectedCandidate" class="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"><div class="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[var(--surface)] p-5 shadow-2xl"><div class="flex items-start justify-between"><div><h3 class="font-semibold">编辑{{ selectedCandidate.kind==='node'?'实体':'关系' }}候选</h3><p class="mt-1 text-xs text-[var(--muted)]">修改结构化信息，原始证据保持只读并随候选保存。</p></div><button class="text-sm text-[var(--muted)]" @click="selectedCandidate=null">关闭</button></div><div v-if="selectedCandidate.kind==='node'" class="mt-4 grid gap-3 sm:grid-cols-2"><label class="text-xs font-semibold">实体名称<input v-model="selectedCandidate.node!.name" class="mt-1 w-full rounded-lg border p-2 font-normal" /></label><label class="text-xs font-semibold">实体类型<input v-model="selectedCandidate.node!.type" class="mt-1 w-full rounded-lg border p-2 font-normal" placeholder="如：产品、组织、流程" /></label><label class="text-xs font-semibold sm:col-span-2">别名（逗号或换行分隔）<textarea class="mt-1 h-20 w-full rounded-lg border p-2 font-normal" :value="selectedCandidate.node!.aliases?.join('，')" @input="setCandidateAliases(($event.target as HTMLTextAreaElement).value)" /></label></div><div v-else class="mt-4 grid gap-3 sm:grid-cols-2"><label class="text-xs font-semibold sm:col-span-2">关系名称<input v-model="selectedCandidate.edge!.predicate" class="mt-1 w-full rounded-lg border p-2 font-normal" /></label><label class="text-xs font-semibold">主体实体<select v-model="selectedCandidate.edge!.subjectId" class="mt-1 w-full rounded-lg border p-2 font-normal"><option v-for="node in nodeOptions" :key="String(node.id)" :value="String(node.id)">{{ node.name }} · {{ node.type }}</option></select></label><label class="text-xs font-semibold">客体实体<select v-model="selectedCandidate.edge!.objectId" class="mt-1 w-full rounded-lg border p-2 font-normal"><option v-for="node in nodeOptions" :key="String(node.id)" :value="String(node.id)">{{ node.name }} · {{ node.type }}</option></select></label></div><label class="mt-3 block text-xs font-semibold">扩展属性（JSON 对象）<textarea v-model="candidatePropertiesText" class="mt-1 h-28 w-full rounded-lg border p-2 font-mono text-[11px] font-normal" /></label><div class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3"><strong class="text-xs">原始证据</strong><blockquote class="mt-2 text-xs leading-5 text-[var(--muted)]">{{ selectedCandidate.evidence[0]?.quote }}</blockquote><p class="mt-2 text-[10px] text-[var(--muted)]">{{ selectedCandidate.evidence[0]?.source || selectedCandidate.evidence[0]?.documentId }} · {{ selectedCandidate.evidence[0]?.chunkId || '文档级证据' }}</p></div><label class="mt-3 block text-xs font-semibold">审核备注<textarea v-model="selectedCandidate.reviewNote" class="mt-1 h-16 w-full rounded-lg border p-2 font-normal" /></label><div class="mt-4 flex justify-between"><button class="text-sm text-rose-600" @click="removeCandidate(selectedCandidate.id)">删除候选</button><div class="flex gap-2"><button class="rounded-lg border px-3 py-2 text-sm" @click="selectedCandidate=null">取消</button><button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white" @click="saveCandidate">保存修改</button></div></div></div></div>

    <div v-if="bulkDecision" class="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"><div class="w-full max-w-md rounded-2xl bg-[var(--surface)] p-5 shadow-2xl"><div :class="['grid h-10 w-10 place-items-center rounded-xl text-lg',bulkDecision==='accepted'?'bg-emerald-100 text-emerald-700':'bg-rose-100 text-rose-700']">{{ bulkDecision==='accepted'?'✓':'×' }}</div><h3 class="mt-3 font-semibold">确认{{ bulkDecision==='accepted'?'批量接受':'批量拒绝' }} {{ pending.length }} 条候选？</h3><p class="mt-2 text-xs leading-5 text-[var(--muted)]">{{ bulkDecision==='accepted'?'接受后候选会进入图谱审核，但发布前仍会执行阻断校验。':'拒绝后候选不会进入本次草稿，可在状态记录中保留审核结果。' }}</p><p v-if="bulkDecision==='accepted'&&bulkLowConfidence" class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">其中 {{ bulkLowConfidence }} 条置信度低于 70%，建议先逐条核对证据。</p><div class="mt-5 flex justify-end gap-2"><button class="rounded-lg border px-4 py-2 text-sm" @click="bulkDecision=null">取消</button><button :class="['rounded-lg px-4 py-2 text-sm font-semibold text-white',bulkDecision==='accepted'?'bg-emerald-600':'bg-rose-600']" @click="confirmBulkReview">确认执行</button></div></div></div>

    <section v-if="step === 5 && state?.published" class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
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
          <div v-else class="grid gap-4 lg:grid-cols-2"><div class="rounded-xl border border-[var(--border)] p-4"><h4 class="text-sm font-semibold">命中与扩展</h4><div class="mt-3 flex flex-wrap gap-2"><span v-for="node in verificationPlan.matchedNodes" :key="node.id" class="rounded-lg bg-emerald-100 px-2.5 py-1.5 text-xs text-emerald-800"><strong>{{ node.name }}</strong><span class="ml-1 opacity-70">{{ Math.round(node.score * 100) }}%</span></span><span v-for="node in verificationPlan.relatedNodes" :key="node.id" class="rounded-lg bg-blue-100 px-2.5 py-1.5 text-xs text-blue-800">关联：{{ node.name }}</span></div><div v-if="verificationPlan.expandedTerms.length" class="mt-4"><p class="text-[11px] font-semibold text-[var(--muted)]">查询扩展词</p><div class="mt-2 flex flex-wrap gap-1.5"><code v-for="term in verificationPlan.expandedTerms" :key="term" class="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[11px]">{{ term }}</code></div></div><div v-if="verificationPlan.paths.length" class="mt-4 border-t border-[var(--border)] pt-3"><p class="text-[11px] font-semibold text-[var(--muted)]">逻辑查询路径（最多两跳）</p><div class="mt-2 space-y-1.5"><div v-for="(path, index) in verificationPlan.paths" :key="`${path.edgeIds.join('-')}-${index}`" class="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800"><span class="mr-2 rounded bg-white/80 px-1.5 py-0.5 text-[10px]">{{ path.depth }} 跳</span>{{ pathLabel(path) }}</div></div></div></div><div class="rounded-xl border border-[var(--border)] p-4"><h4 class="text-sm font-semibold">关系与过滤信号</h4><ul v-if="verificationPlan.edges.length" class="mt-3 space-y-2"><li v-for="edge in verificationPlan.edges" :key="edge.id" class="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs"><strong>{{ nodeName(edge.subjectId) }}</strong><span class="mx-2 text-[var(--accent)]">{{ edge.predicate }}</span><strong>{{ nodeName(edge.objectId) }}</strong></li></ul><p v-else class="mt-3 text-xs text-[var(--muted)]">没有匹配到一至二跳关系。</p><div v-if="verificationPlan.evidenceRefs.length" class="mt-3 border-t border-[var(--border)] pt-3 text-xs"><p class="text-[11px] font-semibold text-[var(--muted)]">图谱证据定位</p><p class="mt-1">{{ verificationPlan.evidenceRefs.length }} 条实体/关系证据将参与定向召回</p></div><dl v-if="Object.keys(verificationPlan.filters).length" class="mt-3 grid gap-1.5 border-t border-[var(--border)] pt-3 text-xs"><div v-for="(value, key) in verificationPlan.filters" :key="key" class="flex justify-between gap-3"><dt class="text-[var(--muted)]">{{ key }}</dt><dd class="break-all text-right font-medium">{{ value }}</dd></div></dl></div></div>
          <div v-if="verificationResult" class="rounded-xl border border-[var(--border)]"><div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3"><h4 class="text-sm font-semibold">最终召回片段</h4><span class="text-[11px] text-[var(--muted)]">已融合原始向量、本体扩展与图谱证据</span></div><div v-if="verificationResult.results.length" class="divide-y divide-[var(--border)]"><article v-for="hit in verificationResult.results" :key="hit.id" class="px-4 py-3"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><strong class="block truncate text-sm">{{ hit.title }}</strong><p v-if="hit.source" class="mt-0.5 truncate text-[10px] text-[var(--muted)]">{{ hit.source }}</p><div v-if="hit.retrievalRoutes?.length" class="mt-1.5 flex flex-wrap gap-1"><span v-for="route in hit.retrievalRoutes" :key="route" :class="['rounded px-1.5 py-0.5 text-[10px] font-medium', route === 'ontology-evidence' ? 'bg-emerald-100 text-emerald-700' : route === 'ontology-vector' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600']">{{ retrievalRouteLabel(route) }}</span></div></div><span class="shrink-0 rounded-full bg-[var(--accent)]/10 px-2 py-1 text-[11px] font-semibold text-[var(--accent)]">{{ (hit.score * 100).toFixed(1) }}%</span></div><p class="mt-2 line-clamp-4 text-xs leading-relaxed text-[var(--muted)]">{{ hit.content }}</p></article></div><div v-else class="px-4 py-10 text-center text-sm text-[var(--muted)]">没有召回知识片段。请确认文档已经完成向量索引。</div></div>
        </div>
      </div>
    </section>

    <section v-if="step === 3" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)]"><button type="button" class="flex w-full items-center justify-between px-5 py-4 text-left" @click="advancedOpen = !advancedOpen"><span><strong class="text-sm">高级本体编排</strong><span class="ml-2 text-xs font-normal text-[var(--muted)]">候选整理阶段的结构化 JSON 导入与草稿维护</span></span><span>{{ advancedOpen ? '收起' : '展开' }}</span></button><div v-if="advancedOpen" class="grid gap-4 border-t border-[var(--border)] p-5 xl:grid-cols-2"><div><h3 class="mb-2 font-semibold">本体草稿 JSON</h3><textarea v-model="draftText" class="h-72 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 font-mono text-xs" /><div class="mt-3 flex justify-end gap-2"><button class="rounded-lg border px-3 py-2 text-sm" @click="saveDraft">保存草稿</button></div></div><div><h3 class="mb-2 font-semibold">候选 JSON 导入</h3><textarea v-model="candidateText" class="h-72 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 font-mono text-xs" /><div class="mt-3 flex justify-end"><button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white" @click="importCandidates">导入候选</button></div></div></div></section>
  </div>
</template>
