<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../app/i18n';
import {
  createProviderInstance,
  defaultBaseUrl,
  defaultProviderName,
  effectiveProviderBaseUrl,
  providerIds,
  providerInstanceReady,
  providerNeedsApiKey,
  summarizeProviderModelHealth,
  type ConfiguredModel,
  type ProviderId,
  type ProviderInstance,
} from '../../app/model-config';

import { useNotify } from '../../app/notify';
import { testProviderConnection } from '../../services/api.js';

const props = defineProps<{
  instances: ProviderInstance[];
  models: ConfiguredModel[];
}>();

const emit = defineEmits<{
  'update:instances': [value: ProviderInstance[]];
  dirty: [];
  'auto-configure': [instance: ProviderInstance];
  'review-models': [];
}>();

const { t } = useI18n();
const notify = useNotify();
const editingId = ref<string | null>(null);
const addType = ref<ProviderId>('openai');
const addOpen = ref(false);
const addDraft = ref<ProviderInstance | null>(null);
const addError = ref('');
const testingId = ref('');
const testMessage = ref<Record<string, { ok: boolean; text: string }>>({});
const autoSetup = ref(true);

const editing = computed(() => props.instances.find((item) => item.id === editingId.value) ?? null);
const visibleInstances = computed(() => props.instances.filter((item) =>
  providerInstanceReady(item) || item.id === editingId.value,
));

function providerHealth(instanceId: string) {
  return summarizeProviderModelHealth(props.models, instanceId);
}

watch(() => props.instances, (rows) => {
  if (editingId.value && !rows.some((item) => item.id === editingId.value)) editingId.value = null;
}, { immediate: true, deep: true });

function emitInstances(next: ProviderInstance[]) {
  emit('update:instances', next);
  emit('dirty');
}

function patch(id: string, patchValue: Partial<ProviderInstance>) {
  emitInstances(props.instances.map((item) => (item.id === id ? { ...item, ...patchValue } : item)));
}

function openAddDialog() {
  addDraft.value = createProviderInstance(addType.value, props.instances);
  addError.value = '';
  addOpen.value = true;
}

function closeAddDialog() {
  addOpen.value = false;
  addDraft.value = null;
  addError.value = '';
}

function changeAddType(event: Event) {
  const type = eventValue(event) as ProviderId;
  if (!providerIds.includes(type)) return;
  addType.value = type;
  addDraft.value = createProviderInstance(type, props.instances);
  addError.value = '';
}

function addInstance() {
  if (!addDraft.value) return;
  const next = { ...addDraft.value, name: addDraft.value.name.trim(), baseUrl: addDraft.value.baseUrl.trim() };
  if (!next.name) {
    addError.value = t('settings.providerNameRequired');
    return;
  }
  if (!providerInstanceReady(next)) {
    addError.value = t('settings.providerRequired');
    return;
  }
  emitInstances([...props.instances, next]);
  if (autoSetup.value) emit('auto-configure', next);
  editingId.value = autoSetup.value ? null : next.id;
  closeAddDialog();
}

function switchInstanceType(instance: ProviderInstance, nextType: ProviderId) {
  if (instance.type === nextType) return;
  const siblings = props.instances.filter((item) => item.id !== instance.id);
  const currentDefaultName = defaultProviderName(instance.type, siblings);
  const nextDefaultName = defaultProviderName(nextType, siblings);
  const currentBase = instance.baseUrl.trim();
  const inheritedBase = !currentBase || currentBase === defaultBaseUrl[instance.type]
    ? defaultBaseUrl[nextType]
    : currentBase;
  patch(instance.id, {
    type: nextType,
    name: !instance.name.trim() || instance.name === currentDefaultName ? nextDefaultName : instance.name,
    baseUrl: inheritedBase,
    apiKey: nextType === 'ollama' ? '' : instance.apiKey,
    workspaceId: nextType === 'qwen' ? instance.workspaceId : '',
    appId: nextType === 'volcengine' || nextType === 'iflytek' ? instance.appId : '',
    apiSecret: nextType === 'iflytek' ? instance.apiSecret : '',
  });
}

function handleInstanceTypeChange(instance: ProviderInstance, event: Event) {
  const nextType = eventValue(event) as ProviderId;
  if (!providerIds.includes(nextType)) return;
  switchInstanceType(instance, nextType);
}

function eventValue(event: Event): string {
  return (event.target as HTMLInputElement | null)?.value ?? '';
}

function eventChecked(event: Event): boolean {
  return Boolean((event.target as HTMLInputElement | null)?.checked);
}

function removeInstance(id: string) {
  if (!window.confirm(t('settings.providerRemoveConfirm'))) return;
  emitInstances(props.instances.filter((item) => item.id !== id));
  if (editingId.value === id) editingId.value = null;
}

async function testInstance(instance: ProviderInstance) {
  testingId.value = instance.id;
  testMessage.value = { ...testMessage.value, [instance.id]: { ok: false, text: t('settings.providerTesting') } };
  try {
    const result = await testProviderConnection({
      type: instance.type,
      baseUrl: instance.baseUrl,
      workspaceId: instance.workspaceId,
      apiKey: instance.apiKey,
    });
    testMessage.value = { ...testMessage.value, [instance.id]: { ok: true, text: result.message } };
    notify.success('notify.providerTestOk', result.message);
  } catch (cause) {
    const text = notify.errorMessage(cause);
    testMessage.value = { ...testMessage.value, [instance.id]: { ok: false, text } };
    notify.error(cause, 'notify.providerTestFailed');
  } finally {
    testingId.value = '';
  }
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-end gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" type="button" @click="openAddDialog">
          <span class="mr-1">＋</span>
          {{ t('settings.providerAdd') }}
        </button>
      </div>
    </div>

    <p v-if="!visibleInstances.length" class="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-xs text-[var(--muted)]">
      {{ t('settings.providersEmpty') }}
    </p>

    <div v-else class="space-y-3">
      <article
        v-for="instance in visibleInstances"
        :key="instance.id"
        class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/25 p-4"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <strong class="text-sm">{{ instance.name }}</strong>
              <span class="rounded-full bg-[var(--surface)] px-2 py-0.5 text-[10px] font-bold text-[var(--muted)]">{{ t(`provider.${instance.type}`) }}</span>
              <span
                :class="[
                  'rounded-full px-2 py-0.5 text-[10px] font-bold',
                  providerInstanceReady(instance) ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700',
                ]"
              >
                {{ providerInstanceReady(instance) ? t('settings.providerReady') : t('settings.providerIncomplete') }}
              </span>
            </div>
            <p class="mt-1 truncate font-mono text-[11px] text-[var(--muted)]">{{ effectiveProviderBaseUrl(instance) || defaultBaseUrl[instance.type] || '—' }}</p>
            <button
              v-if="providerHealth(instance.id).total"
              class="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-semibold"
              type="button"
              @click="emit('review-models')"
            >
              <span class="text-[var(--muted)]">{{ t('settings.providerModelHealth') }}</span>
              <span v-if="providerHealth(instance.id).available" class="rounded-full bg-emerald-500/12 px-2 py-0.5 text-emerald-700">{{ t('settings.providerHealthAvailable', { count: providerHealth(instance.id).available }) }}</span>
              <span v-if="providerHealth(instance.id).issues" class="rounded-full bg-rose-500/12 px-2 py-0.5 text-rose-700">{{ t('settings.providerHealthIssues', { count: providerHealth(instance.id).issues }) }}</span>
              <span v-if="providerHealth(instance.id).stale" class="rounded-full bg-amber-500/12 px-2 py-0.5 text-amber-700">{{ t('settings.providerHealthStale', { count: providerHealth(instance.id).stale }) }}</span>
              <span v-if="providerHealth(instance.id).unverified" class="rounded-full bg-slate-500/10 px-2 py-0.5 text-[var(--muted)]">{{ t('settings.providerHealthUnverified', { count: providerHealth(instance.id).unverified }) }}</span>
              <span class="text-[var(--accent)]">{{ t('settings.providerHealthReview') }}</span>
            </button>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            <button
              class="rounded-lg border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-2.5 py-1.5 text-xs font-semibold text-[var(--accent)] hover:border-[var(--accent)]"
              type="button"
              @click="emit('auto-configure', instance)"
            >{{ t('settings.providerAutoConfigure') }}</button>
            <button
              class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-50"
              type="button"
              :disabled="testingId === instance.id"
              @click="testInstance(instance)"
            >
              {{ testingId === instance.id ? t('settings.providerTesting') : t('settings.providerTest') }}
            </button>
            <button
              class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)]"
              type="button"
              @click="editingId = editingId === instance.id ? null : instance.id"
            >
              {{ editingId === instance.id ? t('settings.providerCollapse') : t('settings.providerEdit') }}
            </button>
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-rose-600" type="button" @click="removeInstance(instance.id)">
              {{ t('settings.providerRemove') }}
            </button>
          </div>
        </div>

        <p
          v-if="testMessage[instance.id]"
          :class="['mt-2 text-xs', testMessage[instance.id].ok ? 'text-emerald-600' : 'text-rose-600']"
        >
          {{ testMessage[instance.id].text }}
        </p>

        <div v-if="editing?.id === instance.id" class="mt-4 grid gap-3 border-t border-[var(--border)] pt-4">
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.providerType') }}</span>
            <select
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]"
              :value="instance.type"
              @change="handleInstanceTypeChange(instance, $event)"
            >
              <option v-for="id in providerIds" :key="id" :value="id">{{ t(`provider.${id}`) }}</option>
            </select>
            <span class="text-[11px] font-normal text-[var(--muted)]">{{ t('settings.providerTypeHelp') }}</span>
          </label>
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.providerName') }}</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]"
              type="text"
              :value="instance.name"
              @input="patch(instance.id, { name: eventValue($event) })"
            />
          </label>
          <label v-if="instance.type === 'qwen'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.workspaceId') }}</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]"
              type="text"
              :value="instance.workspaceId || ''"
              :placeholder="t('settings.workspaceIdHint')"
              @input="patch(instance.id, { workspaceId: eventValue($event).trim() })"
            />
            <span class="text-[11px] font-normal leading-relaxed text-[var(--muted)]">{{ t('settings.workspaceIdHelp') }}</span>
          </label>
          <details :open="instance.type !== 'qwen'" class="grid gap-1.5 text-xs text-[var(--muted)]">
            <summary v-if="instance.type === 'qwen'" class="cursor-pointer font-semibold">{{ t('settings.advancedConnection') }}</summary>
            <label class="mt-2 grid gap-1.5 font-semibold">
            <span>{{ t('settings.baseUrl') }}</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]"
              type="text"
              :placeholder="defaultBaseUrl[instance.type] || t('settings.baseUrlHint')"
              :value="instance.baseUrl"
              @input="patch(instance.id, { baseUrl: eventValue($event) })"
            />
            <span v-if="instance.type === 'qwen'" class="text-[11px] font-normal leading-relaxed">{{ t('settings.qwenBaseUrlHelp') }}</span>
            </label>
          </details>
          <label v-if="instance.type !== 'ollama'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.apiKey') }}</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]"
              type="password"
              autocomplete="off"
              placeholder="sk-…"
              :value="instance.apiKey"
              @input="patch(instance.id, { apiKey: eventValue($event) })"
            />
          </label>
          <label v-if="instance.type === 'volcengine' || instance.type === 'iflytek'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.appId') }}</span>
            <input class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal" :value="instance.appId || ''" @input="patch(instance.id, { appId: eventValue($event).trim() })" />
          </label>
          <label v-if="instance.type === 'iflytek'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.apiSecret') }}</span>
            <input class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal" type="password" autocomplete="off" :value="instance.apiSecret || ''" @input="patch(instance.id, { apiSecret: eventValue($event) })" />
            <span class="text-[11px] font-normal leading-relaxed">{{ t('settings.speechCredentialHelp') }}</span>
          </label>
          <p v-if="instance.type === 'ollama'" class="text-xs text-[var(--muted)]">{{ t('settings.ollamaKeyHint') }}</p>
          <label class="flex cursor-pointer items-start gap-3 text-xs">
            <input
              class="mt-0.5"
              type="checkbox"
              :checked="instance.disableThinking"
              @change="patch(instance.id, { disableThinking: eventChecked($event) })"
            />
            <span>
              <strong class="font-semibold text-[var(--text)]">{{ t('settings.disableThinking') }}</strong>
              <span class="mt-1 block leading-relaxed text-[var(--muted)]">{{ t('settings.disableThinkingHelp') }}</span>
            </span>
          </label>
        </div>
      </article>
    </div>

    <Teleport to="body">
      <div v-if="addOpen && addDraft" class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-4" @mousedown.self="closeAddDialog">
        <form class="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl" @submit.prevent="addInstance">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-lg font-bold">{{ t('settings.providerAddTitle') }}</h3>
              <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">{{ t('settings.providerAddHelp') }}</p>
            </div>
            <button class="rounded-lg px-2 py-1 text-lg text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" aria-label="Close" @click="closeAddDialog">×</button>
          </div>

          <div class="mt-5 grid gap-4">
            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('settings.providerType') }}</span>
              <select class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :value="addDraft.type" @change="changeAddType">
                <option v-for="id in providerIds" :key="id" :value="id">{{ t(`provider.${id}`) }}</option>
              </select>
            </label>
            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('settings.providerName') }}</span>
              <input v-model="addDraft.name" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" required />
            </label>
            <label v-if="addDraft.type === 'qwen'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('settings.workspaceId') }}</span>
              <input v-model.trim="addDraft.workspaceId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('settings.workspaceIdHint')" />
              <span class="text-[11px] font-normal leading-relaxed">{{ t('settings.workspaceIdHelp') }}</span>
            </label>
            <details :open="addDraft.type !== 'qwen'" class="grid gap-1.5 text-xs text-[var(--muted)]">
              <summary v-if="addDraft.type === 'qwen'" class="cursor-pointer font-semibold">{{ t('settings.advancedConnection') }}</summary>
              <label class="mt-2 grid gap-1.5 font-semibold">
              <span>{{ t('settings.baseUrl') }}</span>
              <input v-model="addDraft.baseUrl" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-sm font-normal" :placeholder="defaultBaseUrl[addDraft.type] || 'https://api.example.com/v1'" required />
              <span v-if="addDraft.type === 'qwen'" class="text-[11px] font-normal leading-relaxed">{{ t('settings.qwenBaseUrlHelp') }}</span>
              </label>
            </details>
            <label v-if="addDraft.type !== 'ollama'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('settings.apiKey') }}<small v-if="!providerNeedsApiKey(addDraft.type)" class="ml-1 font-normal">({{ t('settings.optional') }})</small></span>
              <input v-model="addDraft.apiKey" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" type="password" autocomplete="off" placeholder="sk-…" :required="providerNeedsApiKey(addDraft.type)" />
            </label>
            <label v-if="addDraft.type === 'volcengine' || addDraft.type === 'iflytek'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('settings.appId') }}</span>
              <input v-model.trim="addDraft.appId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" required />
            </label>
            <label v-if="addDraft.type === 'iflytek'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('settings.apiSecret') }}</span>
              <input v-model="addDraft.apiSecret" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" type="password" autocomplete="off" required />
              <span class="text-[11px] font-normal leading-relaxed">{{ t('settings.speechCredentialHelp') }}</span>
            </label>
            <p v-if="addDraft.type === 'ollama'" class="text-xs text-[var(--muted)]">{{ t('settings.ollamaKeyHint') }}</p>
            <label class="flex items-start gap-3 rounded-xl border border-[var(--accent)]/20 bg-[var(--accent-soft)]/50 p-3 text-xs">
              <input v-model="autoSetup" class="mt-0.5" type="checkbox" />
              <span>
                <strong class="block text-[var(--text)]">{{ t('settings.providerAutoSetupTitle') }}</strong>
                <span class="mt-1 block leading-relaxed text-[var(--muted)]">{{ t('settings.providerAutoSetupHelp') }}</span>
              </span>
            </label>
          </div>

          <p v-if="addError" class="mt-4 text-xs font-semibold text-rose-600">{{ addError }}</p>
          <div class="mt-6 flex justify-end gap-2">
            <button class="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm font-semibold" type="button" @click="closeAddDialog">{{ t('common.cancel') }}</button>
            <button class="rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white" type="submit">{{ t('settings.providerAddConfirm') }}</button>
          </div>
        </form>
      </div>
    </Teleport>
  </div>
</template>
