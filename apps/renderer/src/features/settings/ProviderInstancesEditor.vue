<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../app/i18n';
import {
  createProviderInstance,
  defaultBaseUrl,
  defaultProviderName,
  providerIds,
  providerInstanceReady,
  providerNeedsApiKey,
  type ProviderId,
  type ProviderInstance,
} from '../../app/model-config';

import { useNotify } from '../../app/notify';
import { testProviderConnection } from '../../services/api.js';

const props = defineProps<{
  instances: ProviderInstance[];
}>();

const emit = defineEmits<{
  'update:instances': [value: ProviderInstance[]];
  dirty: [];
}>();

const { t } = useI18n();
const notify = useNotify();
const editingId = ref<string | null>(null);
const addType = ref<ProviderId>('openai');
const testingId = ref('');
const testMessage = ref<Record<string, { ok: boolean; text: string }>>({});

const editing = computed(() => props.instances.find((item) => item.id === editingId.value) ?? null);

watch(() => props.instances, (rows) => {
  if (!rows.length) {
    editingId.value = null;
    return;
  }
  if (!editingId.value || !rows.some((item) => item.id === editingId.value)) {
    editingId.value = rows[0].id;
  }
}, { immediate: true, deep: true });

function emitInstances(next: ProviderInstance[]) {
  emit('update:instances', next);
  emit('dirty');
}

function patch(id: string, patchValue: Partial<ProviderInstance>) {
  emitInstances(props.instances.map((item) => (item.id === id ? { ...item, ...patchValue } : item)));
}

function addInstance() {
  const next = createProviderInstance(addType.value, props.instances);
  emitInstances([...props.instances, next]);
  editingId.value = next.id;
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
  if (!window.confirm('删除该 Provider 连接？关联的已配置模型也会在保存时一并清理。')) return;
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
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="text-xs leading-relaxed text-[var(--muted)]">{{ t('settings.providersHelp') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[11px] font-semibold text-[var(--muted)]">新增供应商</span>
        <select v-model="addType" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2 text-xs">
          <option v-for="id in providerIds" :key="id" :value="id">{{ t(`provider.${id}`) }}</option>
        </select>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" type="button" @click="addInstance">
          {{ t('settings.providerAdd') }}
        </button>
      </div>
    </div>

    <p v-if="!instances.length" class="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-xs text-[var(--muted)]">
      {{ t('settings.providersEmpty') }}
    </p>

    <div v-else class="space-y-3">
      <article
        v-for="instance in instances"
        :key="instance.id"
        class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/25 p-4"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <button class="min-w-0 flex-1 text-left" type="button" @click="editingId = editingId === instance.id ? null : instance.id">
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
            <p class="mt-1 truncate font-mono text-[11px] text-[var(--muted)]">{{ instance.baseUrl || defaultBaseUrl[instance.type] || '—' }}</p>
          </button>
          <div class="flex shrink-0 flex-wrap gap-2">
            <button
              class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-50"
              type="button"
              :disabled="testingId === instance.id"
              @click="testInstance(instance)"
            >
              {{ testingId === instance.id ? t('settings.providerTesting') : t('settings.providerTest') }}
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
            <span>供应商类型</span>
            <select
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]"
              :value="instance.type"
              @change="handleInstanceTypeChange(instance, $event)"
            >
              <option v-for="id in providerIds" :key="id" :value="id">{{ t(`provider.${id}`) }}</option>
            </select>
            <span class="text-[11px] font-normal text-[var(--muted)]">切换供应商后，默认地址与必填项会自动联动；你手动改过的自定义地址会尽量保留。</span>
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
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.baseUrl') }}</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]"
              type="text"
              :placeholder="defaultBaseUrl[instance.type] || t('settings.baseUrlHint')"
              :value="instance.baseUrl"
              @input="patch(instance.id, { baseUrl: eventValue($event) })"
            />
          </label>
          <label v-if="providerNeedsApiKey(instance.type)" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
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
          <p v-else class="text-xs text-[var(--muted)]">{{ t('settings.ollamaKeyHint') }}</p>
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
  </div>
</template>
