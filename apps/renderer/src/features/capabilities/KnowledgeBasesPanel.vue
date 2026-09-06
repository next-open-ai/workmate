<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '../../app/i18n';
import {
  knowledgeProviderMeta,
  useKnowledgeConfig,
  type KnowledgeBase,
  type KnowledgeProviderId,
} from '../../app/kb-config';
import { toModelPayload, useModelConfig } from '../../app/model-config';
import { useNotify } from '../../app/notify';
import { ingestKnowledgeDocument } from '../../services/api';

const { t } = useI18n();
const notify = useNotify();
const { bases, load, upsert, remove, setEnabled, setDocumentCount, isReady } = useKnowledgeConfig();
const { activeConfig, configured, load: loadModels } = useModelConfig();

const editingId = ref<string | null>(null);
const formOpen = ref(false);
const saving = ref(false);
const ingestOpen = ref(false);
const ingestTarget = ref<KnowledgeBase | null>(null);
const ingestTitle = ref('');
const ingestContent = ref('');
const ingestBusy = ref(false);
const selectedId = ref<string | null>(null);

const draft = ref({
  name: '',
  provider: 'lancedb' as KnowledgeProviderId,
  enabled: true,
  description: '',
  baseUrl: '',
  apiKey: '',
  externalId: '',
  embeddingModel: '',
});

const sorted = computed(() => [...bases.value].sort((a, b) => b.updatedAt - a.updatedAt));
const selected = computed(() => sorted.value.find((item) => item.id === selectedId.value) ?? null);
const providerOptions = (Object.keys(knowledgeProviderMeta) as KnowledgeProviderId[]);

onMounted(async () => {
  await Promise.all([load(), loadModels()]);
});

function resetDraft() {
  draft.value = {
    name: '',
    provider: 'lancedb',
    enabled: true,
    description: '',
    baseUrl: '',
    apiKey: '',
    externalId: '',
    embeddingModel: '',
  };
  editingId.value = null;
}

function openCreate() {
  resetDraft();
  formOpen.value = true;
}

function openEdit(item: KnowledgeBase) {
  editingId.value = item.id;
  selectedId.value = item.id;
  draft.value = {
    name: item.name,
    provider: item.provider,
    enabled: item.enabled,
    description: item.description || '',
    baseUrl: item.baseUrl || '',
    apiKey: item.apiKey || '',
    externalId: item.externalId || '',
    embeddingModel: item.embeddingModel || '',
  };
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  resetDraft();
}

function meta(provider: KnowledgeProviderId) {
  return knowledgeProviderMeta[provider];
}

async function save() {
  saving.value = true;
  try {
    const saved = await upsert({
      id: editingId.value || undefined,
      name: draft.value.name,
      provider: draft.value.provider,
      enabled: draft.value.enabled,
      description: draft.value.description,
      baseUrl: draft.value.baseUrl,
      apiKey: draft.value.apiKey,
      externalId: draft.value.externalId,
      embeddingModel: draft.value.embeddingModel,
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

async function onDelete(item: KnowledgeBase) {
  if (!window.confirm(t('capabilities.kbDeleteConfirm', { name: item.name }))) return;
  try {
    await remove(item.id);
    if (selectedId.value === item.id) selectedId.value = null;
    if (editingId.value === item.id) closeForm();
    notify.success('notify.kbDeleted');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

function openIngest(item: KnowledgeBase) {
  if (item.provider !== 'lancedb') return;
  ingestTarget.value = item;
  ingestTitle.value = '';
  ingestContent.value = '';
  ingestOpen.value = true;
}

async function runIngest() {
  if (!ingestTarget.value) return;
  if (!configured.value) {
    notify.error(new Error(t('capabilities.kbEmbeddingRequired')), 'notify.saveFailed');
    return;
  }
  ingestBusy.value = true;
  try {
    const result = await ingestKnowledgeDocument({
      knowledgeBase: {
        id: ingestTarget.value.id,
        name: ingestTarget.value.name,
        provider: 'lancedb',
        enabled: true,
        dataDir: ingestTarget.value.dataDir || undefined,
        embeddingModel: ingestTarget.value.embeddingModel || undefined,
      },
      title: ingestTitle.value.trim() || 'document',
      content: ingestContent.value,
      model: toModelPayload(activeConfig.value),
    });
    await setDocumentCount(ingestTarget.value.id, (ingestTarget.value.documentCount || 0) + (result.chunks || 0));
    notify.success('notify.kbIngested');
    ingestOpen.value = false;
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    ingestBusy.value = false;
  }
}

function summaryLine(item: KnowledgeBase) {
  if (item.provider === 'lancedb') return t('capabilities.kbLocalSummary', { count: item.documentCount || 0 });
  return [item.baseUrl, item.externalId].filter(Boolean).join(' · ') || item.provider;
}
</script>

<template>
  <div class="grid min-h-0 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
    <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-bold">{{ t('capabilities.kbListTitle') }}</h2>
          <p class="mt-1 text-xs text-[var(--muted)]">{{ t('capabilities.kbListHelp') }}</p>
        </div>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" type="button" @click="openCreate">
          {{ t('capabilities.addKb') }}
        </button>
      </div>

      <p v-if="!sorted.length" class="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--muted)]">
        {{ t('capabilities.emptyKb') }}
      </p>

      <ul v-else class="divide-y divide-[var(--border)]">
        <li
          v-for="item in sorted"
          :key="item.id"
          :class="['cursor-pointer rounded-xl px-3 py-3.5 transition', selectedId === item.id ? 'bg-[var(--accent-soft)]/60 ring-1 ring-[var(--accent)]/25' : 'hover:bg-[var(--surface-muted)]']"
          @click="selectedId = item.id"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <strong class="text-sm">{{ item.name }}</strong>
                <span class="rounded-md bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--muted)]">{{ meta(item.provider).label }}</span>
                <span :class="['rounded-md px-2 py-0.5 text-[10px] font-bold', isReady(item) ? 'bg-emerald-500/15 text-emerald-700' : 'bg-[var(--surface-muted)] text-[var(--muted)]']">
                  {{ isReady(item) ? t('capabilities.kbReady') : t('capabilities.kbDisabled') }}
                </span>
              </div>
              <p class="mt-1 truncate font-mono text-[11px] text-[var(--muted)]">{{ summaryLine(item) }}</p>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2" @click.stop>
              <label class="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <input :checked="item.enabled" type="checkbox" @change="onToggle(item, $event)" />
                {{ t('capabilities.mcpEnable') }}
              </label>
              <button v-if="item.provider === 'lancedb'" class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold" type="button" @click="openIngest(item)">
                {{ t('capabilities.kbIngest') }}
              </button>
              <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold" type="button" @click="openEdit(item)">{{ t('capabilities.edit') }}</button>
              <button class="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-500/10" type="button" @click="onDelete(item)">{{ t('capabilities.delete') }}</button>
            </div>
          </div>
        </li>
      </ul>
    </article>

    <aside class="space-y-4">
      <section v-if="formOpen" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h2 class="font-bold">{{ editingId ? t('capabilities.editKb') : t('capabilities.addKb') }}</h2>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('capabilities.kbFormHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="closeForm">×</button>
        </div>
        <form class="mt-4 space-y-3" @submit.prevent="save">
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.name') }}</span>
            <input v-model.trim="draft.name" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" required />
          </label>
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.kbProvider') }}</span>
            <select v-model="draft.provider" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal">
              <option v-for="id in providerOptions" :key="id" :value="id">{{ meta(id).label }}</option>
            </select>
          </label>
          <label v-if="meta(draft.provider).needsBaseUrl" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.kbBaseUrl') }}</span>
            <input v-model.trim="draft.baseUrl" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="draft.provider === 'dify' ? 'https://api.dify.ai/v1' : 'https://…'" required />
          </label>
          <label v-if="meta(draft.provider).needsApiKey" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.kbApiKey') }}</span>
            <input v-model="draft.apiKey" type="password" autocomplete="off" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" required />
          </label>
          <label v-if="meta(draft.provider).needsExternalId" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.kbExternalId') }}</span>
            <input v-model.trim="draft.externalId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('capabilities.kbExternalIdHint')" required />
          </label>
          <label v-if="draft.provider === 'lancedb' || draft.provider === 'qdrant' || draft.provider === 'pinecone'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.kbEmbeddingModel') }}</span>
            <input v-model.trim="draft.embeddingModel" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('capabilities.kbEmbeddingModelHint')" />
          </label>
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.mcpDescription') }}</span>
            <textarea v-model.trim="draft.description" rows="2" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" />
          </label>
          <label class="flex items-center gap-2 text-xs font-semibold">
            <input v-model="draft.enabled" type="checkbox" />
            {{ t('capabilities.mcpEnable') }}
          </label>
          <button class="w-full rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50" type="submit" :disabled="saving">
            {{ saving ? t('capabilities.saving') : t('capabilities.save') }}
          </button>
        </form>
      </section>

      <section v-else class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 class="font-bold">{{ selected ? selected.name : t('capabilities.kbSidebarTitle') }}</h2>
        <p class="mt-2 text-sm leading-relaxed text-[var(--muted)]">
          {{ selected ? t('capabilities.kbSelectedHelp') : t('capabilities.kbSidebarHelp') }}
        </p>
        <ol class="mt-4 list-decimal space-y-2 pl-4 text-xs leading-relaxed text-[var(--muted)]">
          <li>{{ t('capabilities.kbStep1') }}</li>
          <li>{{ t('capabilities.kbStep2') }}</li>
          <li>{{ t('capabilities.kbStep3') }}</li>
        </ol>
        <button class="mt-5 w-full rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm font-semibold hover:border-[var(--accent)]" type="button" @click="openCreate">
          {{ t('capabilities.addKb') }}
        </button>
      </section>
    </aside>

    <div v-if="ingestOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/40 p-5" @click.self="ingestOpen = false">
      <article class="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h2 class="text-lg font-bold">{{ t('capabilities.kbIngest') }}</h2>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('capabilities.kbIngestHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="ingestOpen = false">×</button>
        </div>
        <form class="mt-4 space-y-3" @submit.prevent="runIngest">
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.kbDocTitle') }}</span>
            <input v-model.trim="ingestTitle" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" />
          </label>
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('capabilities.kbDocContent') }}</span>
            <textarea v-model="ingestContent" rows="10" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" required />
          </label>
          <button class="w-full rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50" type="submit" :disabled="ingestBusy || !ingestContent.trim()">
            {{ ingestBusy ? t('capabilities.kbIngesting') : t('capabilities.kbIngest') }}
          </button>
        </form>
      </article>
    </div>
  </div>
</template>
