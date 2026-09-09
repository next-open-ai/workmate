<script setup lang="ts">
import { ref } from 'vue';
import { runEnvironmentFix } from '../../services/api';
import { useNotify } from '../../app/notify';
import { DSH_ENV_FIX_ACTION_ID, dshInstallCardCopy } from './index';

const emit = defineEmits<{
  openEnvironment: [];
}>();

const notify = useNotify();
const copy = dshInstallCardCopy();
const busy = ref(false);
const message = ref('');
const error = ref('');

async function install() {
  busy.value = true;
  message.value = '';
  error.value = '';
  try {
    const result = await runEnvironmentFix(DSH_ENV_FIX_ACTION_ID);
    message.value = result.message || 'dsh 编码引擎已安装';
    notify.success('notify.saved', message.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    notify.error(cause, 'notify.saveFailed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">{{ copy.title }}</p>
        <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">
          {{ copy.body }}
          <code class="rounded bg-[var(--surface-muted)] px-1">{{ copy.runtimePathHint }}</code>
        </p>
        <p v-if="message" class="mt-2 text-xs text-emerald-600">{{ message }}</p>
        <p v-if="error" class="mt-2 text-xs text-rose-600">{{ error }}</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">
        <button
          class="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)]"
          type="button"
          :disabled="busy"
          @click="emit('openEnvironment')"
        >
          {{ copy.openEnvLabel }}
        </button>
        <button
          class="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
          type="button"
          :disabled="busy"
          @click="install"
        >
          {{ busy ? copy.installingLabel : copy.installLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
