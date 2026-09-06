<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../app/i18n';
import {
  modelCapabilities,
  providerCanBuiltinWebSearch,
  providerInstanceReady,
  providerSuggestedByCapability,
  providerSupportsOpenAiModelList,
  uniqueModels,
  type ConfiguredModel,
  type ModelCapability,
  type ProviderInstance,
} from '../../app/model-config';
import { listProviderModels } from '../../services/api.js';

const props = defineProps<{
  instances: ProviderInstance[];
  models: ConfiguredModel[];
  activeChatModelId: string | null;
  activeEmbeddingModelId: string | null;
}>();

const emit = defineEmits<{
  'update:models': [value: ConfiguredModel[]];
  'update:activeChatModelId': [value: string | null];
  'update:activeEmbeddingModelId': [value: string | null];
  dirty: [];
}>();

const { t } = useI18n();

const draftProviderId = ref('');
const draftCapability = ref<ModelCapability>('chat');
const draftModelId = ref('');
const pickerOpen = ref(false);
const remoteModels = ref<string[]>([]);
const remoteLoading = ref(false);
const remoteError = ref('');
const search = ref('');

const instanceById = computed(() => Object.fromEntries(props.instances.map((item) => [item.id, item])));
const readyInstances = computed(() => props.instances.filter((item) => providerInstanceReady(item)));
const visibleModels = computed(() =>
  props.models.filter((item) => {
    const instance = instanceById.value[item.providerInstanceId];
    return Boolean(instance && providerInstanceReady(instance));
  }),
);

const draftInstance = computed(() => readyInstances.value.find((item) => item.id === draftProviderId.value) ?? null);

const suggestions = computed(() => {
  const instance = draftInstance.value;
  if (!instance) return [] as string[];
  const catalog = providerSuggestedByCapability[instance.type]?.[draftCapability.value] ?? [];
  const remote = draftCapability.value === 'chat' ? remoteModels.value : [];
  const q = search.value.trim().toLowerCase();
  return uniqueModels([...remote, ...catalog]).filter((item) => !q || item.toLowerCase().includes(q));
});

watch(
  () => readyInstances.value.map((item) => item.id).join(','),
  () => {
    if (!draftProviderId.value || !readyInstances.value.some((item) => item.id === draftProviderId.value)) {
      draftProviderId.value = readyInstances.value[0]?.id ?? '';
    }
  },
  { immediate: true },
);

function emitModels(
  next: ConfiguredModel[],
  activeChatId = props.activeChatModelId,
  activeEmbeddingId = props.activeEmbeddingModelId,
) {
  emit('update:models', next);
  emit('update:activeChatModelId', activeChatId);
  emit('update:activeEmbeddingModelId', activeEmbeddingId);
  emit('dirty');
}

function capabilityLabel(capability: ModelCapability) {
  return t(`settings.capability.${capability}`);
}

function addModel(modelId: string, makeDefault = true) {
  const trimmed = modelId.trim();
  const instance = draftInstance.value;
  if (!trimmed || !instance) return;
  const exists = props.models.some(
    (item) => item.providerInstanceId === instance.id && item.capability === draftCapability.value && item.modelId === trimmed,
  );
  if (exists) {
    pickerOpen.value = false;
    return;
  }
  const entry: ConfiguredModel = {
    id: crypto.randomUUID(),
    providerInstanceId: instance.id,
    capability: draftCapability.value,
    modelId: trimmed,
    supportsBuiltinWebSearch: draftCapability.value === 'chat' && instance.type === 'qwen' ? true : undefined,
  };
  const next = [...props.models, entry];
  let activeChatId = props.activeChatModelId;
  let activeEmbeddingId = props.activeEmbeddingModelId;
  if (draftCapability.value === 'chat' && (makeDefault || !props.activeChatModelId)) activeChatId = entry.id;
  if (draftCapability.value === 'embedding' && (makeDefault || !props.activeEmbeddingModelId)) activeEmbeddingId = entry.id;
  emitModels(next, activeChatId, activeEmbeddingId);
  draftModelId.value = '';
  pickerOpen.value = false;
}

function removeModel(id: string) {
  const next = props.models.filter((item) => item.id !== id);
  const activeChatId = props.activeChatModelId === id ? next.find((item) => item.capability === 'chat')?.id ?? null : props.activeChatModelId;
  const activeEmbeddingId = props.activeEmbeddingModelId === id
    ? next.find((item) => item.capability === 'embedding')?.id ?? null
    : props.activeEmbeddingModelId;
  emitModels(next, activeChatId, activeEmbeddingId);
}

function setDefaultChat(id: string) {
  emit('update:activeChatModelId', id);
  emit('dirty');
}

function setDefaultEmbedding(id: string) {
  emit('update:activeEmbeddingModelId', id);
  emit('dirty');
}

function toggleBuiltinWebSearch(model: ConfiguredModel, enabled: boolean) {
  const instance = instanceById.value[model.providerInstanceId];
  if (!instance || !providerCanBuiltinWebSearch(instance.type) || model.capability !== 'chat') return;
  emitModels(
    props.models.map((item) =>
      item.id === model.id
        ? { ...item, supportsBuiltinWebSearch: enabled || undefined }
        : item,
    ),
  );
}

function modelSupportsBuiltinToggle(model: ConfiguredModel) {
  const instance = instanceById.value[model.providerInstanceId];
  return model.capability === 'chat' && Boolean(instance && providerCanBuiltinWebSearch(instance.type));
}

function eventChecked(event: Event): boolean {
  return Boolean((event.target as HTMLInputElement | null)?.checked);
}

async function fetchRemoteModels() {
  const instance = draftInstance.value;
  if (!instance) return;
  remoteLoading.value = true;
  remoteError.value = '';
  try {
    remoteModels.value = await listProviderModels({
      type: instance.type,
      baseUrl: instance.baseUrl,
      apiKey: instance.apiKey,
    });
  } catch (cause) {
    remoteModels.value = [];
    remoteError.value = cause instanceof Error ? cause.message : '拉取失败';
  } finally {
    remoteLoading.value = false;
  }
}

async function openPicker() {
  pickerOpen.value = true;
  search.value = '';
  remoteError.value = '';
  remoteModels.value = [];
  if (draftInstance.value && providerSupportsOpenAiModelList(draftInstance.value.type)) {
    await fetchRemoteModels();
  }
}

function modelRowLabel(model: ConfiguredModel) {
  const instance = instanceById.value[model.providerInstanceId];
  return `${instance?.name ?? '未知连接'} · ${model.modelId}`;
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-xs leading-relaxed text-[var(--muted)]">{{ t('settings.configuredModelsHelp') }}</p>
      </div>
      <button
        class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-40"
        type="button"
        :disabled="!readyInstances.length"
        @click="openPicker"
      >
        {{ t('settings.modelAdd') }}
      </button>
    </div>

    <p v-if="!readyInstances.length" class="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--muted)]">
      {{ t('settings.modelsNeedProvider') }}
    </p>

    <div v-else-if="visibleModels.length" class="overflow-hidden rounded-xl border border-[var(--border)]">
      <div class="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 bg-[var(--surface-muted)]/50 px-3 py-2 text-[10px] font-bold uppercase tracking-[.06em] text-[var(--muted)]">
        <span>{{ t('settings.modelColumn') }}</span>
        <span>{{ t('settings.modelTypeColumn') }}</span>
        <span>{{ t('settings.builtinSearchColumn') }}</span>
        <span>{{ t('settings.systemDefaultColumn') }}</span>
        <span></span>
      </div>
      <div
        v-for="model in visibleModels"
        :key="model.id"
        class="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2 border-t border-[var(--border)] px-3 py-2.5"
      >
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">{{ modelRowLabel(model) }}</p>
          <p class="truncate text-[11px] text-[var(--muted)]">{{ instanceById[model.providerInstanceId]?.type }}</p>
        </div>
        <span class="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-bold text-[var(--muted)]">{{ capabilityLabel(model.capability) }}</span>
        <label v-if="modelSupportsBuiltinToggle(model)" class="flex cursor-pointer items-center gap-1.5 text-xs" :title="t('settings.builtinSearchHelp')">
          <input
            :checked="Boolean(model.supportsBuiltinWebSearch)"
            type="checkbox"
            @change="toggleBuiltinWebSearch(model, eventChecked($event))"
          />
          <span class="text-[var(--muted)]">{{ t('settings.builtinSearch') }}</span>
        </label>
        <span v-else class="text-[11px] text-[var(--muted)]">—</span>
        <label v-if="model.capability === 'chat'" class="flex cursor-pointer items-center gap-1.5 text-xs">
          <input :checked="activeChatModelId === model.id" name="default-chat-model" type="radio" @change="setDefaultChat(model.id)" />
          <span class="text-[var(--muted)]">{{ t('settings.activeChatModel') }}</span>
        </label>
        <label v-else-if="model.capability === 'embedding'" class="flex cursor-pointer items-center gap-1.5 text-xs">
          <input :checked="activeEmbeddingModelId === model.id" name="default-embedding-model" type="radio" @change="setDefaultEmbedding(model.id)" />
          <span class="text-[var(--muted)]">{{ t('settings.activeEmbeddingModel') }}</span>
        </label>
        <span v-else class="text-[11px] text-[var(--muted)]">—</span>
        <button class="rounded-md px-2 py-1 text-lg leading-none text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-rose-600" type="button" @click="removeModel(model.id)">×</button>
      </div>
    </div>
    <p v-if="visibleModels.length && !activeEmbeddingModelId" class="mt-2 text-[11px] text-[var(--muted)]">
      {{ t('settings.activeEmbeddingModelHint') }}
    </p>
    <p v-else class="text-xs text-[var(--muted)]">{{ t('settings.configuredModelsEmpty') }}</p>

    <div v-if="pickerOpen" class="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" @click.self="pickerOpen = false">
      <article class="flex max-h-[min(85vh,680px)] w-full max-w-lg flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h3 class="text-lg font-bold">{{ t('settings.modelAddTitle') }}</h3>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('settings.modelAddHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="pickerOpen = false">×</button>
        </header>

        <div class="space-y-3 border-b border-[var(--border)] px-5 py-4">
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.pickProvider') }}</span>
            <select v-model="draftProviderId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-normal">
              <option v-for="instance in readyInstances" :key="instance.id" :value="instance.id">
                {{ instance.name }} · {{ t(`provider.${instance.type}`) }}
              </option>
            </select>
          </label>
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.pickCapability') }}</span>
            <select v-model="draftCapability" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-normal">
              <option v-for="capability in modelCapabilities" :key="capability" :value="capability">{{ capabilityLabel(capability) }}</option>
            </select>
          </label>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="search"
              class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              type="search"
              :placeholder="t('settings.chatModelSearch')"
            />
            <button
              v-if="draftInstance && providerSupportsOpenAiModelList(draftInstance.type)"
              class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-50"
              type="button"
              :disabled="remoteLoading"
              @click="fetchRemoteModels"
            >
              {{ remoteLoading ? t('settings.modelListLoading') : t('settings.modelListFetch') }}
            </button>
          </div>
          <p v-if="remoteError" class="text-xs text-rose-600">{{ remoteError }}</p>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <ul v-if="suggestions.length" class="space-y-1">
            <li v-for="name in suggestions" :key="name">
              <button
                class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--surface-muted)]"
                type="button"
                @click="addModel(name, draftCapability === 'chat')"
              >
                <span class="truncate font-medium">{{ name }}</span>
                <span class="shrink-0 text-[11px] text-[var(--accent)]">{{ t('settings.chatModelAdd') }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="py-6 text-center text-xs text-[var(--muted)]">{{ t('settings.chatModelSearchEmpty') }}</p>
        </div>

        <footer class="border-t border-[var(--border)] px-5 py-4">
          <p class="mb-2 text-xs font-semibold text-[var(--muted)]">{{ t('settings.chatModelManual') }}</p>
          <div class="flex gap-2">
            <input
              v-model="draftModelId"
              class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              type="text"
              :placeholder="t('settings.chatModelCustomPlaceholder')"
              @keydown.enter.prevent="addModel(draftModelId, draftCapability === 'chat')"
            />
            <button class="shrink-0 rounded-lg bg-[var(--text)] px-3 py-2 text-xs font-semibold text-[var(--surface)]" type="button" @click="addModel(draftModelId, draftCapability === 'chat')">
              {{ t('settings.chatModelAdd') }}
            </button>
          </div>
        </footer>
      </article>
    </div>
  </div>
</template>
