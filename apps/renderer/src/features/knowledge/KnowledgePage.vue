<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../app/i18n';
import {
  knowledgeProviderIds,
  knowledgeProviderMeta,
  useKnowledgeConfig,
  type KnowledgeBase,
  type KnowledgeProviderId,
} from '../../app/kb-config';
import { resolveActiveEmbeddingConfig, toModelPayload, useModelConfig } from '../../app/model-config';
import { useNotify } from '../../app/notify';
import {
  deleteKnowledgeChunk,
  deleteKnowledgeDocument,
  ingestKnowledgeDocument,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  createBailianKnowledge,
  listBailianIndices,
  listBailianPipelines,
  getKnowledgeJobStatus,
  searchKnowledge,
  type KnowledgeChunkRow,
  type KnowledgeDocumentRow,
  type KnowledgeBasePayload,
} from '../../services/api';

const emit = defineEmits<{ openSettings: [] }>();
const { t } = useI18n();
const notify = useNotify();
const { bases, load, upsert, remove, setEnabled, setDocumentCount, setIndexState, isReady, enabledProviders, isProviderEnabled, providerDefaults, resolveCredentials } = useKnowledgeConfig();
const { activeConfig, configured, settings: modelSettings, load: loadModels } = useModelConfig();

type DetailTab = 'documents' | 'chunks' | 'search' | 'settings';
type ProviderFilter = 'all' | KnowledgeProviderId;

const providerFilter = ref<ProviderFilter>('all');
const selectedId = ref<string | null>(null);
const detailTab = ref<DetailTab>('documents');
const formOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const loadingDocs = ref(false);
const loadingChunks = ref(false);
const ingestOpen = ref(false);
const ingestBusy = ref(false);
const ingestTitle = ref('');
const ingestContent = ref('');
const ingestSource = ref('');
const chunkQuery = ref('');
const chunkDocumentId = ref('');
const searchQuery = ref('');
const searching = ref(false);
const documents = ref<KnowledgeDocumentRow[]>([]);
const chunks = ref<KnowledgeChunkRow[]>([]);
const chunkTotal = ref(0);
const docStats = ref({ documentCount: 0, chunkCount: 0, backend: '' });
const searchHits = ref<Array<{ id: string; title: string; content: string; score: number; source?: string }>>([]);
const selectedChunk = ref<KnowledgeChunkRow | null>(null);

const draft = ref({
  name: '',
  provider: 'lancedb' as KnowledgeProviderId,
  enabled: true,
  description: '',
  baseUrl: '',
  apiKey: '',
  externalId: '',
  categoryId: '',
  workspaceId: '',
  accessKeyId: '',
  accessKeySecret: '',
  embeddingModel: '',
});
const bailianPipelines = ref<Array<{ id: string; name: string; workspaceId: string; docNum: number; categoryId?: string }>>([]);
const loadingPipelines = ref(false);
const creatingBailian = ref(false);

/** Local always; cloud providers appear once enabled in Settings. */
const visibleProviderFilters = computed(() => {
  return knowledgeProviderIds.filter((id) => isProviderEnabled(id));
});

const creatableProviders = computed(() => enabledProviders.value.map((item) => item.id));

const filteredBases = computed(() => {
  const rows = [...bases.value]
    .filter((item) => isProviderEnabled(item.provider))
    .sort((a, b) => {
      if (a.provider === 'lancedb' && b.provider !== 'lancedb') return -1;
      if (a.provider !== 'lancedb' && b.provider === 'lancedb') return 1;
      return b.updatedAt - a.updatedAt;
    });
  if (providerFilter.value === 'all') return rows;
  return rows.filter((item) => item.provider === providerFilter.value);
});

const selected = computed(() => bases.value.find((item) => item.id === selectedId.value) ?? null);
const isLocal = computed(() => selected.value?.provider === 'lancedb');
const systemEmbedding = computed(() => resolveActiveEmbeddingConfig(modelSettings.value));
/** Providers that support document/chunk CRUD + upload through the unified knowledge API. */
const supportsManage = computed(() => selected.value?.provider === 'lancedb' || selected.value?.provider === 'bailian');
const detailTabs = computed((): DetailTab[] => (
  supportsManage.value
    ? ['documents', 'chunks', 'search', 'settings']
    : ['search', 'settings']
));
const ingestFileBase64 = ref('');
const ingestFileName = ref('');
const lastJobId = ref('');
const lastJobStatus = ref('');

onMounted(async () => {
  await Promise.all([load(), loadModels()]);
});

watch(selectedId, async (id) => {
  if (!id) return;
  const item = bases.value.find((row) => row.id === id);
  detailTab.value = (item?.provider === 'lancedb' || item?.provider === 'bailian') ? 'documents' : 'search';
  chunkQuery.value = '';
  chunkDocumentId.value = '';
  searchQuery.value = '';
  searchHits.value = [];
  selectedChunk.value = null;
  lastJobId.value = '';
  lastJobStatus.value = '';
  await refreshDetail();
});

watch(detailTab, async (tab) => {
  if (!selected.value) return;
  if (tab === 'documents') await loadDocuments();
  if (tab === 'chunks') await loadChunks();
});

function meta(provider: KnowledgeProviderId) {
  return knowledgeProviderMeta[provider];
}

function toPayload(item: KnowledgeBase): KnowledgeBasePayload {
  const creds = resolveCredentials(item);
  return {
    id: item.id,
    name: item.name,
    provider: item.provider,
    enabled: item.enabled,
    description: item.description || undefined,
    dataDir: item.dataDir || undefined,
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    externalId: item.externalId || undefined,
    categoryId: item.categoryId || undefined,
    workspaceId: creds.workspaceId,
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    embeddingBaseUrl: item.embeddingBaseUrl || undefined,
    embeddingApiKey: item.embeddingApiKey || undefined,
    embeddingModel: item.embeddingModel || undefined,
    embeddingMeta: item.embeddingMeta,
    indexState: item.indexState,
  };
}

function indexStatusLabel(item: KnowledgeBase) {
  switch (item.indexState?.status) {
    case 'stale': return 'Stale';
    case 'rebuilding': return 'Rebuilding';
    case 'ready': return 'Ready';
    default: return '';
  }
}

function indexStatusClass(item: KnowledgeBase) {
  switch (item.indexState?.status) {
    case 'stale': return 'bg-amber-500/15 text-amber-700';
    case 'rebuilding': return 'bg-sky-500/15 text-sky-700';
    case 'ready': return 'bg-emerald-500/15 text-emerald-700';
    default: return 'bg-[var(--surface-muted)] text-[var(--muted)]';
  }
}

function formatTime(value: number) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function resetDraft() {
  draft.value = {
    name: '',
    provider: 'lancedb',
    enabled: true,
    description: '',
    baseUrl: '',
    apiKey: '',
    externalId: '',
    categoryId: '',
    workspaceId: '',
    accessKeyId: '',
    accessKeySecret: '',
    embeddingModel: '',
  };
  bailianPipelines.value = [];
  editingId.value = null;
}

function openCreate() {
  resetDraft();
  const preferred = providerFilter.value !== 'all' && isProviderEnabled(providerFilter.value)
    ? providerFilter.value
    : (creatableProviders.value[0] || 'lancedb');
  draft.value.provider = preferred;
  applyProviderDefaults(preferred);
  formOpen.value = true;
}

function applyProviderDefaults(provider: KnowledgeProviderId) {
  if (editingId.value) return;
  const defaults = providerDefaults(provider);
  draft.value.baseUrl = defaults.baseUrl;
  // Leave per-base secrets empty so shared Settings credentials are used.
  draft.value.apiKey = '';
  draft.value.workspaceId = '';
  draft.value.accessKeyId = '';
  draft.value.accessKeySecret = '';
  if ((provider === 'lancedb' || provider === 'qdrant' || provider === 'pinecone') && !draft.value.embeddingModel.trim()) {
    draft.value.embeddingModel = systemEmbedding.value?.modelId || '';
  }
}

function onDraftProviderChange() {
  applyProviderDefaults(draft.value.provider);
}

function openEdit(item: KnowledgeBase) {
  editingId.value = item.id;
  draft.value = {
    name: item.name,
    provider: item.provider,
    enabled: item.enabled,
    description: item.description || '',
    baseUrl: item.baseUrl || '',
    apiKey: item.apiKey || '',
    externalId: item.externalId || '',
    categoryId: item.categoryId || '',
    workspaceId: item.workspaceId || '',
    accessKeyId: item.accessKeyId || '',
    accessKeySecret: item.accessKeySecret || '',
    embeddingModel: item.embeddingModel || '',
  };
  bailianPipelines.value = [];
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  resetDraft();
}

async function save() {
  saving.value = true;
  try {
    const existing = editingId.value
      ? bases.value.find((item) => item.id === editingId.value)
      : undefined;
    const inheritedEmbedding = (draft.value.provider === 'lancedb' || draft.value.provider === 'qdrant' || draft.value.provider === 'pinecone')
      ? systemEmbedding.value
      : null;
    const manualEmbeddingModel = draft.value.embeddingModel.trim();
    const resolvedEmbeddingModel = manualEmbeddingModel || inheritedEmbedding?.modelId || '';
    const keepExistingEmbedding = Boolean(existing && manualEmbeddingModel && existing.embeddingModel === manualEmbeddingModel);
    const saved = await upsert({
      id: editingId.value || undefined,
      name: draft.value.name,
      provider: draft.value.provider,
      enabled: draft.value.enabled,
      description: draft.value.description,
      baseUrl: draft.value.baseUrl,
      apiKey: draft.value.apiKey,
      externalId: draft.value.externalId,
      categoryId: draft.value.categoryId,
      workspaceId: draft.value.workspaceId,
      accessKeyId: draft.value.accessKeyId,
      accessKeySecret: draft.value.accessKeySecret,
      embeddingBaseUrl: keepExistingEmbedding
        ? (existing?.embeddingBaseUrl || '')
        : (!manualEmbeddingModel ? (inheritedEmbedding?.baseUrl || '') : ''),
      embeddingApiKey: keepExistingEmbedding
        ? (existing?.embeddingApiKey || '')
        : (!manualEmbeddingModel ? (inheritedEmbedding?.apiKey || '') : ''),
      embeddingModel: resolvedEmbeddingModel,
      embeddingMeta: keepExistingEmbedding
        ? existing?.embeddingMeta
        : (!manualEmbeddingModel ? inheritedEmbedding?.meta : undefined),
      documentCount: editingId.value
        ? bases.value.find((item) => item.id === editingId.value)?.documentCount
        : 0,
    });
    selectedId.value = saved.id;
    notify.success(editingId.value ? 'notify.kbUpdated' : 'notify.kbCreated');
    closeForm();
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function onToggle(item: KnowledgeBase, event: Event) {
  try {
    await setEnabled(item.id, (event.target as HTMLInputElement).checked);
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function onDeleteBase(item: KnowledgeBase) {
  if (!window.confirm(t('knowledge.deleteConfirm', { name: item.name }))) return;
  try {
    await remove(item.id);
    if (selectedId.value === item.id) selectedId.value = null;
    notify.success('notify.kbDeleted');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function refreshDetail() {
  if (!selected.value) return;
  if (supportsManage.value) {
    await Promise.all([loadDocuments(), detailTab.value === 'chunks' ? loadChunks() : Promise.resolve()]);
  } else {
    documents.value = [];
    chunks.value = [];
    docStats.value = { documentCount: 0, chunkCount: 0, backend: selected.value.provider };
  }
}

async function loadDocuments() {
  if (!selected.value || !supportsManage.value) return;
  loadingDocs.value = true;
  try {
    const result = await listKnowledgeDocuments({ knowledgeBase: toPayload(selected.value) });
    documents.value = result.documents;
    docStats.value = {
      documentCount: result.documentCount,
      chunkCount: result.chunkCount,
      backend: result.backend,
    };
    await setDocumentCount(selected.value.id, result.documentCount || result.chunkCount);
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    loadingDocs.value = false;
  }
}

async function loadChunks() {
  if (!selected.value || !supportsManage.value) return;
  loadingChunks.value = true;
  try {
    const result = await listKnowledgeChunks({
      knowledgeBase: toPayload(selected.value),
      documentId: chunkDocumentId.value || undefined,
      query: chunkQuery.value.trim() || undefined,
      offset: 0,
      limit: 60,
    });
    chunks.value = result.chunks;
    chunkTotal.value = result.total;
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    loadingChunks.value = false;
  }
}

function openIngest() {
  if (!selected.value || !supportsManage.value) return;
  ingestTitle.value = '';
  ingestContent.value = '';
  ingestSource.value = '';
  ingestFileBase64.value = '';
  ingestFileName.value = '';
  ingestOpen.value = true;
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

async function onPickFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const maxBytes = selected.value?.provider === 'bailian' ? 8_000_000 : 2_000_000;
  if (file.size > maxBytes) {
    notify.error(new Error(t('knowledge.fileTooLarge')), 'notify.saveFailed');
    return;
  }
  ingestTitle.value = ingestTitle.value.trim() || file.name.replace(/\.[^.]+$/, '');
  ingestSource.value = file.name;
  ingestFileName.value = file.name;
  if (selected.value?.provider === 'bailian' && !/\.(txt|md|markdown|csv|json)$/i.test(file.name)) {
    ingestFileBase64.value = await fileToBase64(file);
    ingestContent.value = '';
  } else {
    const textContent = await file.text();
    ingestContent.value = textContent;
    if (selected.value?.provider === 'bailian') {
      ingestFileBase64.value = await fileToBase64(file);
    } else {
      ingestFileBase64.value = '';
    }
  }
  (event.target as HTMLInputElement).value = '';
}

async function runIngest() {
  if (!selected.value) return;
  const isBailian = selected.value.provider === 'bailian';
  if (!isBailian && !configured.value) {
    notify.error(new Error(t('knowledge.embeddingRequired')), 'notify.saveFailed');
    return;
  }
  if (isBailian && !selected.value.categoryId?.trim()) {
    notify.error(new Error(t('knowledge.bailianNeedCategory')), 'notify.saveFailed');
    return;
  }
  if (!ingestContent.value.trim() && !ingestFileBase64.value.trim()) {
    notify.error(new Error(t('knowledge.contentRequired')), 'notify.saveFailed');
    return;
  }
  ingestBusy.value = true;
  try {
    const result = await ingestKnowledgeDocument({
      knowledgeBase: toPayload(selected.value),
      title: ingestTitle.value.trim() || 'document',
      content: ingestContent.value.trim() || undefined,
      fileBase64: ingestFileBase64.value.trim() || undefined,
      fileName: ingestFileName.value.trim() || undefined,
      source: ingestSource.value.trim() || undefined,
      model: configured.value ? toModelPayload(activeConfig.value) : undefined,
    });
    if (result.jobId) {
      lastJobId.value = result.jobId;
      lastJobStatus.value = result.status || 'PENDING';
      await pollBailianJob(result.jobId);
    }
    if (result.indexState) {
      await setIndexState(selected.value.id, result.indexState);
    }
    await setDocumentCount(selected.value.id, (selected.value.documentCount || 0) + Math.max(1, result.chunks || 0));
    notify.success(result.jobId ? 'notify.kbIngestQueued' : 'notify.kbIngested');
    ingestOpen.value = false;
    detailTab.value = 'documents';
    await refreshDetail();
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    ingestBusy.value = false;
  }
}

async function pollBailianJob(jobId: string) {
  if (!selected.value || selected.value.provider !== 'bailian') return;
  const terminal = new Set(['COMPLETED', 'FAILED', 'FINISH', 'SUCCESS']);
  for (let i = 0; i < 12; i += 1) {
    try {
      const status = await getKnowledgeJobStatus({
        knowledgeBase: toPayload(selected.value),
        jobId,
      });
      lastJobStatus.value = status.status || lastJobStatus.value;
      if (terminal.has(String(status.status || '').toUpperCase())) break;
      // Job may disappear quickly after success.
      if (/not exist|IndexJobNotExist/i.test(String(status.message || ''))) {
        lastJobStatus.value = 'COMPLETED';
        break;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/not exist|IndexJobNotExist/i.test(message)) {
        lastJobStatus.value = 'COMPLETED';
        break;
      }
      lastJobStatus.value = message.slice(0, 80);
      break;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
  }
}

async function removeDocument(doc: KnowledgeDocumentRow) {
  if (!selected.value) return;
  if (!window.confirm(t('knowledge.deleteDocConfirm', { name: doc.title }))) return;
  try {
    const result = await deleteKnowledgeDocument({
      knowledgeBase: toPayload(selected.value),
      documentId: doc.id,
    });
    await setDocumentCount(selected.value.id, result.remainingChunks);
    notify.success('notify.kbDocDeleted');
    await refreshDetail();
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function removeChunk(chunk: KnowledgeChunkRow) {
  if (!selected.value) return;
  if (!window.confirm(t('knowledge.deleteChunkConfirm'))) return;
  try {
    const result = await deleteKnowledgeChunk({
      knowledgeBase: toPayload(selected.value),
      chunkId: chunk.id,
    });
    await setDocumentCount(selected.value.id, result.remainingChunks);
    if (selectedChunk.value?.id === chunk.id) selectedChunk.value = null;
    notify.success('notify.kbChunkDeleted');
    await loadChunks();
    await loadDocuments();
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

function filterChunksByDoc(docId: string) {
  chunkDocumentId.value = docId;
  detailTab.value = 'chunks';
  void loadChunks();
}

async function fetchBailianPipelines() {
  const defaults = providerDefaults('bailian');
  const workspaceId = draft.value.workspaceId.trim() || defaults.workspaceId;
  const accessKeyId = draft.value.accessKeyId.trim() || defaults.accessKeyId;
  const accessKeySecret = draft.value.accessKeySecret.trim() || defaults.accessKeySecret;
  loadingPipelines.value = true;
  try {
    if (accessKeyId && accessKeySecret && workspaceId) {
      const result = await listBailianIndices({
        accessKeyId,
        accessKeySecret,
        workspaceId,
      });
      bailianPipelines.value = result.indices.map((item) => ({
        id: item.id,
        name: item.name,
        workspaceId,
        docNum: item.documentCount,
        categoryId: item.categoryId || undefined,
      }));
    } else {
      const apiKey = draft.value.apiKey.trim() || defaults.apiKey;
      if (!apiKey) {
        notify.error(new Error(t('knowledge.bailianNeedApiKey')), 'notify.saveFailed');
        return;
      }
      const result = await listBailianPipelines({
        apiKey,
        baseUrl: draft.value.baseUrl || defaults.baseUrl || undefined,
        workspaceId: workspaceId || undefined,
      });
      bailianPipelines.value = result.pipelines;
    }
    if (!bailianPipelines.value.length) notify.error(new Error(t('knowledge.bailianEmptyList')), 'notify.saveFailed');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    loadingPipelines.value = false;
  }
}

function applyBailianPipeline(item: { id: string; name: string; workspaceId: string; categoryId?: string }) {
  draft.value.externalId = item.id;
  if (item.categoryId) draft.value.categoryId = item.categoryId;
  if (!draft.value.name.trim()) draft.value.name = item.name;
}

async function createBailianRemote() {
  if (!draft.value.name.trim()) {
    notify.error(new Error(t('knowledge.bailianNeedName')), 'notify.saveFailed');
    return;
  }
  const defaults = providerDefaults('bailian');
  const workspaceId = draft.value.workspaceId.trim() || defaults.workspaceId;
  const accessKeyId = draft.value.accessKeyId.trim() || defaults.accessKeyId;
  const accessKeySecret = draft.value.accessKeySecret.trim() || defaults.accessKeySecret;
  if (!workspaceId) {
    notify.error(new Error(t('knowledge.bailianNeedWorkspace')), 'notify.saveFailed');
    return;
  }
  if (!accessKeyId || !accessKeySecret) {
    notify.error(new Error(t('knowledge.bailianNeedAccessKey')), 'notify.saveFailed');
    return;
  }
  creatingBailian.value = true;
  try {
    const created = await createBailianKnowledge({
      accessKeyId,
      accessKeySecret,
      workspaceId,
      name: draft.value.name.trim().slice(0, 20),
      description: draft.value.description.trim() || undefined,
    });
    draft.value.externalId = created.indexId;
    draft.value.categoryId = created.categoryId;
    notify.success('notify.kbCreated');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    creatingBailian.value = false;
  }
}

async function runSearch() {
  if (!selected.value || searchQuery.value.trim().length < 2) return;
  searching.value = true;
  try {
    const result = await searchKnowledge({
      knowledgeBase: toPayload(selected.value),
      query: searchQuery.value.trim(),
      topK: 6,
      model: configured.value ? toModelPayload(activeConfig.value) : undefined,
    });
    searchHits.value = result.results;
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    searching.value = false;
  }
}

function summaryLine(item: KnowledgeBase) {
  if (item.provider === 'lancedb') return t('knowledge.localSummary', { count: item.documentCount || 0 });
  return [item.baseUrl, item.externalId].filter(Boolean).join(' · ') || item.provider;
}

function embeddingSourceSummary(item: KnowledgeBase) {
  if (item.embeddingModel?.trim()) {
    if (item.embeddingBaseUrl?.trim()) return `${item.embeddingModel} · ${item.embeddingBaseUrl}`;
    return item.embeddingModel;
  }
  if (systemEmbedding.value?.modelId) {
    return `${systemEmbedding.value.modelId}（系统默认）`;
  }
  return '未配置';
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <header class="shrink-0 border-b border-[var(--border)] px-6 py-5 lg:px-8">
      <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">Workmate / KNOWLEDGE</p>
      <div class="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-3xl font-bold tracking-[-.04em] lg:text-4xl">{{ t('knowledge.title') }}</h1>
          <p class="mt-1 max-w-2xl text-sm text-[var(--muted)]">{{ t('knowledge.subtitle') }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            v-if="selected"
            type="button"
            class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold"
            @click="selectedId = null"
          >
            {{ t('knowledge.backToList') }}
          </button>
          <button type="button" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" @click="openCreate">
            {{ t('knowledge.add') }}
          </button>
        </div>
      </div>

      <div v-if="!selected" class="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          :class="['rounded-full px-3 py-1.5 text-xs font-semibold transition', providerFilter === 'all' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--text)]']"
          @click="providerFilter = 'all'"
        >
          {{ t('knowledge.filterAll') }}
        </button>
        <button
          v-for="id in visibleProviderFilters"
          :key="id"
          type="button"
          :class="['rounded-full px-3 py-1.5 text-xs font-semibold transition', providerFilter === id ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--text)]']"
          @click="providerFilter = id"
        >
          {{ meta(id).label }}
        </button>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-auto px-6 py-5 lg:px-8">
      <div v-if="!selected" class="mx-auto max-w-[1200px]">
        <p v-if="!filteredBases.length" class="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center text-sm text-[var(--muted)]">
          {{ t('knowledge.empty') }}
        </p>
        <div v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <article
            v-for="item in filteredBases"
            :key="item.id"
            class="group flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 transition hover:border-[var(--accent)]/35"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="truncate text-base font-bold">{{ item.name }}</h2>
                  <span :class="['rounded-full px-2 py-0.5 text-[10px] font-bold', isReady(item) ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--surface-muted)] text-[var(--muted)]']">
                    {{ isReady(item) ? t('knowledge.ready') : t('knowledge.notReady') }}
                  </span>
                  <span v-if="item.indexState?.status" :class="['rounded-full px-2 py-0.5 text-[10px] font-bold', indexStatusClass(item)]">
                    {{ indexStatusLabel(item) }}
                  </span>
                </div>
                <p class="mt-1 text-xs text-[var(--muted)]">{{ meta(item.provider).label }}</p>
              </div>
              <label class="shrink-0 text-[11px] text-[var(--muted)]">
                <input type="checkbox" class="align-middle" :checked="item.enabled" @change="onToggle(item, $event)" />
                {{ t('knowledge.enabled') }}
              </label>
            </div>
            <p class="mt-3 line-clamp-2 text-sm text-[var(--muted)]">{{ item.description || summaryLine(item) }}</p>
            <p class="mt-2 text-[11px] text-[var(--muted)]">{{ summaryLine(item) }}</p>
            <p v-if="item.provider === 'lancedb' || item.provider === 'qdrant' || item.provider === 'pinecone'" class="mt-1 text-[11px] text-[var(--muted)]">
              Embedding: {{ embeddingSourceSummary(item) }}
            </p>
            <div class="mt-5 flex flex-wrap gap-2">
              <button type="button" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" @click="selectedId = item.id">{{ t('knowledge.open') }}</button>
              <button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" @click="openEdit(item)">{{ t('knowledge.edit') }}</button>
              <button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--muted)]" @click="onDeleteBase(item)">{{ t('knowledge.delete') }}</button>
            </div>
          </article>
        </div>
      </div>

      <div v-else-if="selected" class="mx-auto grid max-w-[1200px] gap-5">
        <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p class="text-[11px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ meta(selected.provider).label }}</p>
              <h2 class="mt-1 text-2xl font-bold tracking-[-.03em]">{{ selected.name }}</h2>
              <p class="mt-1 text-sm text-[var(--muted)]">{{ selected.description || summaryLine(selected) }}</p>
              <p v-if="supportsManage" class="mt-2 text-xs text-[var(--muted)]">{{ t('knowledge.stats', { docs: docStats.documentCount, chunks: docStats.chunkCount, backend: docStats.backend || '—' }) }}</p>
              <p v-if="lastJobId" class="mt-1 text-[11px] text-[var(--muted)]">{{ t('knowledge.jobStatus', { id: lastJobId, status: lastJobStatus || '—' }) }}</p>
              <p v-if="selected.indexState?.status" class="mt-1 text-[11px] text-[var(--muted)]">
                Index status: {{ indexStatusLabel(selected) }}<span v-if="selected.indexState.signature"> · {{ selected.indexState.signature }}</span>
              </p>
              <p v-if="selected.provider === 'lancedb' || selected.provider === 'qdrant' || selected.provider === 'pinecone'" class="mt-1 text-[11px] text-[var(--muted)]">
                Embedding: {{ embeddingSourceSummary(selected) }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <button v-if="supportsManage" type="button" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" @click="openIngest">{{ t('knowledge.upload') }}</button>
              <button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" @click="openEdit(selected)">{{ t('knowledge.edit') }}</button>
            </div>
          </div>
          <div class="mt-5 flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
            <button
              v-for="tab in detailTabs"
              :key="tab"
              type="button"
              :class="['rounded-lg px-3 py-2 text-xs font-semibold transition', detailTab === tab ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)] hover:bg-[var(--surface-muted)]']"
              @click="detailTab = tab"
            >
              {{ t(`knowledge.tab.${tab}`) }}
            </button>
          </div>
        </article>

        <article v-if="detailTab === 'documents' && supportsManage" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div class="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 class="text-base font-bold">{{ t('knowledge.docsTitle') }}</h3>
              <p class="mt-1 text-xs text-[var(--muted)]">{{ t('knowledge.docsHelp') }}</p>
            </div>
            <button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" :disabled="loadingDocs" @click="loadDocuments">{{ loadingDocs ? t('knowledge.loading') : t('knowledge.refresh') }}</button>
          </div>
          <p v-if="!documents.length && !loadingDocs" class="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--muted)]">{{ t('knowledge.docsEmpty') }}</p>
          <ul v-else class="divide-y divide-[var(--border)]">
            <li v-for="doc in documents" :key="doc.id" class="flex flex-wrap items-start justify-between gap-3 py-4">
              <div class="min-w-0 flex-1">
                <p class="font-semibold">{{ doc.title }}</p>
                <p class="mt-1 text-xs text-[var(--muted)]">{{ t('knowledge.docMeta', { chunks: doc.chunkCount, time: formatTime(doc.createdAt) }) }}<span v-if="doc.source"> · {{ doc.source }}</span></p>
                <p class="mt-2 line-clamp-2 text-sm text-[var(--muted)]">{{ doc.preview }}</p>
              </div>
              <div class="flex gap-2">
                <button type="button" class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold" @click="filterChunksByDoc(doc.id)">{{ t('knowledge.viewChunks') }}</button>
                <button type="button" class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--muted)]" @click="removeDocument(doc)">{{ t('knowledge.removeDoc') }}</button>
              </div>
            </li>
          </ul>
        </article>

        <article v-if="detailTab === 'chunks' && supportsManage" class="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div class="mb-4 flex flex-wrap items-end gap-3">
              <label class="grid min-w-[180px] flex-1 gap-1 text-xs font-semibold text-[var(--muted)]">
                {{ t('knowledge.chunkQuery') }}
                <input v-model="chunkQuery" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-normal text-[var(--text)]" :placeholder="t('knowledge.chunkQueryHint')" @keydown.enter.prevent="loadChunks" />
              </label>
              <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">
                {{ t('knowledge.chunkDocFilter') }}
                <select v-model="chunkDocumentId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-normal">
                  <option value="">{{ t('knowledge.allDocs') }}</option>
                  <option v-for="doc in documents" :key="doc.id" :value="doc.id">{{ doc.title }}</option>
                </select>
              </label>
              <button type="button" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" :disabled="loadingChunks" @click="loadChunks">{{ t('knowledge.searchChunks') }}</button>
            </div>
            <p class="mb-3 text-xs text-[var(--muted)]">{{ t('knowledge.chunkTotal', { n: chunkTotal }) }}</p>
            <ul class="max-h-[520px] space-y-2 overflow-auto">
              <li
                v-for="chunk in chunks"
                :key="chunk.id"
                :class="['cursor-pointer rounded-xl border px-3 py-3 transition', selectedChunk?.id === chunk.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] hover:border-[var(--accent)]/40']"
                @click="selectedChunk = chunk"
              >
                <p class="text-sm font-semibold">{{ chunk.title }}</p>
                <p class="mt-1 line-clamp-2 text-xs text-[var(--muted)]">{{ chunk.content }}</p>
              </li>
            </ul>
          </div>
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <template v-if="selectedChunk">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="text-base font-bold">{{ selectedChunk.title }}</h3>
                  <p class="mt-1 text-xs text-[var(--muted)]">{{ selectedChunk.documentTitle }} · {{ formatTime(selectedChunk.createdAt) }}</p>
                </div>
                <button type="button" class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--muted)]" @click="removeChunk(selectedChunk)">{{ t('knowledge.removeChunk') }}</button>
              </div>
              <pre class="mt-4 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--surface-muted)] p-4 text-sm leading-relaxed">{{ selectedChunk.content }}</pre>
            </template>
            <p v-else class="py-16 text-center text-sm text-[var(--muted)]">{{ t('knowledge.pickChunk') }}</p>
          </div>
        </article>

        <article v-if="detailTab === 'search'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 class="text-base font-bold">{{ t('knowledge.searchTitle') }}</h3>
          <p class="mt-1 text-xs text-[var(--muted)]">{{ t('knowledge.searchHelp') }}</p>
          <div class="mt-4 flex flex-wrap gap-2">
            <input v-model="searchQuery" class="min-w-[240px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm" :placeholder="t('knowledge.searchPlaceholder')" @keydown.enter.prevent="runSearch" />
            <button type="button" class="rounded-lg bg-[var(--accent)] px-4 py-2.5 text-xs font-semibold text-white" :disabled="searching" @click="runSearch">{{ searching ? t('knowledge.searching') : t('knowledge.runSearch') }}</button>
          </div>
          <ul class="mt-5 space-y-3">
            <li v-for="hit in searchHits" :key="hit.id" class="rounded-xl border border-[var(--border)] px-4 py-3">
              <div class="flex items-center justify-between gap-3">
                <p class="font-semibold">{{ hit.title }}</p>
                <span class="text-[11px] text-[var(--muted)]">{{ (hit.score * 100).toFixed(1) }}%</span>
              </div>
              <p class="mt-2 text-sm leading-relaxed text-[var(--muted)]">{{ hit.content }}</p>
            </li>
          </ul>
          <p v-if="!searchHits.length && !searching" class="mt-8 text-center text-sm text-[var(--muted)]">{{ t('knowledge.searchEmpty') }}</p>
        </article>

        <article v-if="detailTab === 'settings'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 class="text-base font-bold">{{ t('knowledge.settingsTitle') }}</h3>
          <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div class="rounded-xl bg-[var(--surface-muted)] px-4 py-3">
              <dt class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">Provider</dt>
              <dd class="mt-1 font-semibold">{{ meta(selected.provider).label }}</dd>
            </div>
            <div class="rounded-xl bg-[var(--surface-muted)] px-4 py-3">
              <dt class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">ID</dt>
              <dd class="mt-1 break-all font-mono text-xs">{{ selected.id }}</dd>
            </div>
            <div v-if="selected.baseUrl" class="rounded-xl bg-[var(--surface-muted)] px-4 py-3 sm:col-span-2">
              <dt class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">URL</dt>
              <dd class="mt-1 break-all">{{ selected.baseUrl }}</dd>
            </div>
            <div v-if="selected.externalId" class="rounded-xl bg-[var(--surface-muted)] px-4 py-3 sm:col-span-2">
              <dt class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">External ID</dt>
              <dd class="mt-1 break-all font-mono text-xs">{{ selected.externalId }}</dd>
            </div>
            <div v-if="selected.categoryId" class="rounded-xl bg-[var(--surface-muted)] px-4 py-3 sm:col-span-2">
              <dt class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">Category ID</dt>
              <dd class="mt-1 break-all font-mono text-xs">{{ selected.categoryId }}</dd>
            </div>
            <div v-if="selected.indexState?.status" class="rounded-xl bg-[var(--surface-muted)] px-4 py-3 sm:col-span-2">
              <dt class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">Index State</dt>
              <dd class="mt-1">{{ indexStatusLabel(selected) }}</dd>
              <dd v-if="selected.indexState.signature" class="mt-1 break-all font-mono text-xs text-[var(--muted)]">{{ selected.indexState.signature }}</dd>
              <dd v-if="selected.indexState.lastBuildModel" class="mt-1 text-xs text-[var(--muted)]">last model: {{ selected.indexState.lastBuildModel }}</dd>
              <dd v-if="selected.indexState.lastBuildError" class="mt-1 text-xs text-rose-600">{{ selected.indexState.lastBuildError }}</dd>
            </div>
            <div v-if="selected.provider === 'lancedb' || selected.provider === 'qdrant' || selected.provider === 'pinecone'" class="rounded-xl bg-[var(--surface-muted)] px-4 py-3 sm:col-span-2">
              <dt class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">Embedding</dt>
              <dd class="mt-1">{{ embeddingSourceSummary(selected) }}</dd>
              <dd v-if="selected.embeddingMeta?.dimension" class="mt-1 text-xs text-[var(--muted)]">dimension: {{ selected.embeddingMeta.dimension }}</dd>
            </div>
          </dl>
          <p v-if="!supportsManage" class="mt-4 rounded-xl border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">{{ t('knowledge.cloudManageHint') }}</p>
          <p v-else-if="selected.provider === 'bailian' && !selected.categoryId" class="mt-4 rounded-xl border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">{{ t('knowledge.bailianNeedCategory') }}</p>
          <p v-if="isLocal && !configured" class="mt-4 text-sm text-[var(--muted)]">
            {{ t('knowledge.embeddingRequired') }}
            <button type="button" class="ml-2 font-semibold text-[var(--accent)]" @click="emit('openSettings')">{{ t('common.openSettings') }}</button>
          </p>
        </article>
      </div>
    </div>

    <div v-if="formOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/40 p-4" @click.self="closeForm">
      <form class="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl" @submit.prevent="save">
        <h3 class="text-lg font-bold">{{ editingId ? t('knowledge.edit') : t('knowledge.add') }}</h3>
        <p class="mt-1 text-xs text-[var(--muted)]">{{ t('knowledge.formHelp') }}</p>
        <div class="mt-4 grid gap-3">
          <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.name') }}<input v-model="draft.name" required class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal text-[var(--text)]" /></label>
          <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.provider') }}
            <select v-model="draft.provider" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :disabled="Boolean(editingId)" @change="onDraftProviderChange">
              <option v-for="id in creatableProviders" :key="id" :value="id">{{ meta(id).label }}</option>
            </select>
          </label>
          <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.description') }}<textarea v-model="draft.description" rows="2" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal text-[var(--text)]" /></label>
          <template v-if="draft.provider !== 'lancedb'">
            <label v-if="meta(draft.provider).needsBaseUrl" class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.baseUrl') }}<input v-model="draft.baseUrl" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" /></label>
            <label v-if="draft.provider !== 'bailian'" class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.apiKey') }}<input v-model="draft.apiKey" type="password" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" /></label>
            <template v-if="draft.provider === 'bailian'">
              <p class="text-[11px] font-normal leading-relaxed text-[var(--muted)]">{{ t('knowledge.bailianHelp') }}</p>
              <p class="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-[11px] font-normal text-[var(--muted)]">
                {{ t('knowledge.bailianSharedFromSettings') }}
                <button type="button" class="ml-1 font-semibold text-[var(--accent)]" @click="emit('openSettings')">{{ t('common.openSettings') }}</button>
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" :disabled="creatingBailian || Boolean(editingId)" @click="createBailianRemote">
                  {{ creatingBailian ? t('knowledge.bailianCreating') : t('knowledge.bailianCreate') }}
                </button>
                <span class="text-[11px] font-normal text-[var(--muted)]">{{ t('knowledge.bailianCreateHelp') }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" :disabled="loadingPipelines" @click="fetchBailianPipelines">{{ loadingPipelines ? t('knowledge.loading') : t('knowledge.bailianFetch') }}</button>
                <span class="text-[11px] font-normal text-[var(--muted)]">{{ t('knowledge.bailianFetchHelp') }}</span>
              </div>
              <div v-if="bailianPipelines.length" class="flex flex-wrap gap-2">
                <button
                  v-for="item in bailianPipelines"
                  :key="item.id"
                  type="button"
                  class="rounded-lg border px-2.5 py-1.5 text-left text-[11px] font-semibold"
                  :class="draft.externalId === item.id ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)] bg-[var(--surface-muted)]'"
                  @click="applyBailianPipeline(item)"
                >
                  <span class="block">{{ item.name }}</span>
                  <span class="mt-0.5 block font-mono text-[10px] opacity-70">{{ item.id }} · docs {{ item.docNum }}</span>
                </button>
              </div>
              <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.externalId') }}<input v-model="draft.externalId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('knowledge.bailianIndexHint')" /></label>
              <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.categoryId') }}<input v-model="draft.categoryId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('knowledge.categoryIdHint')" /></label>
            </template>
            <label v-else class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.externalId') }}<input v-model="draft.externalId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('knowledge.externalIdHint')" /></label>
          </template>
          <label v-if="draft.provider === 'lancedb' || draft.provider === 'qdrant' || draft.provider === 'pinecone'" class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.embeddingModel') }}<input v-model="draft.embeddingModel" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('knowledge.embeddingModelHint')" /></label>
          <p v-if="(draft.provider === 'lancedb' || draft.provider === 'qdrant' || draft.provider === 'pinecone') && !draft.embeddingModel.trim()" class="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-[11px] font-normal text-[var(--muted)]">
            {{ systemEmbedding?.modelId ? `当前将继承系统 Embedding：${systemEmbedding.modelId}${systemEmbedding.meta?.dimension ? ` · ${systemEmbedding.meta.dimension}d` : ''}` : '当前没有系统级 Embedding 默认项，建议先去设置页注册并设为默认。' }}
          </p>
          <label class="flex items-center gap-2 text-xs font-semibold"><input v-model="draft.enabled" type="checkbox" />{{ t('knowledge.enabled') }}</label>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" @click="closeForm">{{ t('common.close') }}</button>
          <button type="submit" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" :disabled="saving">{{ saving ? t('knowledge.saving') : t('knowledge.save') }}</button>
        </div>
      </form>
    </div>

    <div v-if="ingestOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/40 p-4" @click.self="ingestOpen = false">
      <form class="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl" @submit.prevent="runIngest">
        <h3 class="text-lg font-bold">{{ t('knowledge.upload') }}</h3>
        <p class="mt-1 text-xs text-[var(--muted)]">{{ t('knowledge.uploadHelp') }}</p>
        <div class="mt-4 grid gap-3">
          <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.docTitle') }}<input v-model="ingestTitle" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal text-[var(--text)]" /></label>
          <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.file') }}<input type="file" class="text-sm font-normal" @change="onPickFile" /></label>
          <p v-if="ingestFileName" class="text-[11px] text-[var(--muted)]">{{ ingestFileName }}</p>
          <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">{{ t('knowledge.docContent') }}<textarea v-model="ingestContent" rows="12" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal text-[var(--text)]" :placeholder="selected?.provider === 'bailian' ? t('knowledge.bailianContentHint') : ''" /></label>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" @click="ingestOpen = false">{{ t('common.close') }}</button>
          <button type="submit" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" :disabled="ingestBusy">{{ ingestBusy ? t('knowledge.indexing') : t('knowledge.index') }}</button>
        </div>
      </form>
    </div>
  </section>
</template>
