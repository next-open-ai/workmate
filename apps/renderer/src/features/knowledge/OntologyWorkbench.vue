<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { commitOntologyCandidates, importOntologyCandidates, publishOntologyDraft, readOntologyWorkflow, reviewOntologyCandidates, saveOntologyDraft, type KnowledgeBasePayload, type OntologyWorkflowPayload } from '../../services/api';
import { useNotify } from '../../app/notify';

const props = defineProps<{ knowledgeBase: KnowledgeBasePayload }>();
const notify = useNotify();
const state = ref<OntologyWorkflowPayload | null>(null);
const draftText = ref('');
const candidateText = ref('[]');
const busy = ref(false);
const pending = computed(() => state.value?.candidates.filter((item) => item.status === 'pending') || []);
const accepted = computed(() => state.value?.candidates.filter((item) => item.status === 'accepted') || []);

async function load() {
  busy.value = true;
  try {
    state.value = (await readOntologyWorkflow(props.knowledgeBase)).workflow;
    draftText.value = JSON.stringify(state.value.draft, null, 2);
  } catch (error) { notify.error(error, 'notify.saveFailed'); }
  finally { busy.value = false; }
}
async function saveDraft() {
  try { state.value = (await saveOntologyDraft(props.knowledgeBase, JSON.parse(draftText.value))).workflow; notify.pushRaw('success', '草稿已保存', '发布后才会成为正式本体。'); }
  catch (error) { notify.error(error, 'notify.saveFailed'); }
}
async function publishDraft() {
  try { state.value = (await publishOntologyDraft(props.knowledgeBase)).workflow; draftText.value = JSON.stringify(state.value.draft, null, 2); notify.pushRaw('success', '本体已发布', `当前版本 v${state.value.published?.version || 1}`); }
  catch (error) { notify.error(error, 'notify.saveFailed'); }
}
async function importCandidates() {
  try { state.value = (await importOntologyCandidates(props.knowledgeBase, JSON.parse(candidateText.value))).workflow; candidateText.value = '[]'; notify.pushRaw('success', '候选已导入', '请核对证据后审核。'); }
  catch (error) { notify.error(error, 'notify.saveFailed'); }
}
async function review(id: string, decision: 'accepted' | 'rejected') {
  try { state.value = (await reviewOntologyCandidates(props.knowledgeBase, [id], decision)).workflow; }
  catch (error) { notify.error(error, 'notify.saveFailed'); }
}
async function commit() {
  try { const result = await commitOntologyCandidates(props.knowledgeBase); state.value = result.workflow; draftText.value = JSON.stringify(state.value.draft, null, 2); notify.pushRaw('success', '正式图谱已更新', `已提交 ${result.workflow.committed || accepted.value.length} 条事实。`); }
  catch (error) { notify.error(error, 'notify.saveFailed'); }
}
watch(() => props.knowledgeBase.id, load);
onMounted(load);
</script>

<template>
  <div class="grid gap-4 xl:grid-cols-2">
    <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div class="mb-3 flex items-start justify-between gap-3"><div><h3 class="font-semibold">本体草稿</h3><p class="mt-1 text-xs text-[var(--muted)]">定义节点、别名和关系；保存草稿后发布为可检索版本。</p></div><span class="rounded-full bg-[var(--surface-muted)] px-2 py-1 text-xs">v{{ state?.published?.version || 0 }}</span></div>
      <textarea v-model="draftText" class="h-72 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 font-mono text-xs leading-5" spellcheck="false" />
      <div class="mt-3 flex justify-end gap-2"><button class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm" @click="saveDraft">保存草稿</button><button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white" @click="publishDraft">发布版本</button></div>
    </section>
    <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div class="mb-3"><h3 class="font-semibold">候选事实导入</h3><p class="mt-1 text-xs text-[var(--muted)]">导入包含文档、切片和原文引用的候选 JSON；候选不会直接进入正式图谱。</p></div>
      <textarea v-model="candidateText" class="h-72 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 font-mono text-xs leading-5" spellcheck="false" />
      <div class="mt-3 flex justify-end"><button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white" @click="importCandidates">导入候选</button></div>
    </section>
    <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 xl:col-span-2">
      <div class="mb-4 flex items-center justify-between"><div><h3 class="font-semibold">人工审核</h3><p class="mt-1 text-xs text-[var(--muted)]">仅接受且有证据的候选可以提交。</p></div><button :disabled="!accepted.length" class="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-40" @click="commit">提交 {{ accepted.length }} 条到正式图谱</button></div>
      <div v-if="busy" class="py-10 text-center text-sm text-[var(--muted)]">正在读取本体状态…</div>
      <div v-else-if="!pending.length" class="rounded-xl bg-[var(--surface-muted)] py-10 text-center text-sm text-[var(--muted)]">暂无待审核候选</div>
      <div v-else class="grid gap-3 md:grid-cols-2">
        <article v-for="item in pending" :key="item.id" class="rounded-xl border border-[var(--border)] p-4">
          <div class="flex items-center justify-between"><strong>{{ item.kind === 'node' ? item.node?.name : item.edge?.predicate }}</strong><span class="text-xs text-[var(--muted)]">置信度 {{ Math.round(item.confidence * 100) }}%</span></div>
          <pre class="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--surface-muted)] p-2 text-xs">{{ JSON.stringify(item.node || item.edge, null, 2) }}</pre>
          <blockquote class="mt-2 border-l-2 border-[var(--accent)] pl-3 text-xs text-[var(--muted)]">{{ item.evidence[0]?.quote }}<br>{{ item.evidence[0]?.source || item.evidence[0]?.documentId }}</blockquote>
          <div class="mt-3 flex justify-end gap-2"><button class="rounded-lg border border-rose-300 px-3 py-1.5 text-xs text-rose-600" @click="review(item.id, 'rejected')">拒绝</button><button class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white" @click="review(item.id, 'accepted')">接受</button></div>
        </article>
      </div>
    </section>
  </div>
</template>
