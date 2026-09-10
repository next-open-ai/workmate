<script setup lang="ts">
import { useNotify } from '../../app/notify';
import { dshInstallCardCopy } from './index';
import DshInstallProgressPanel from './DshInstallProgressPanel.vue';
import { dshInstallState, installDshRuntimeWithProgress } from './install-progress';

const emit = defineEmits<{
  openEnvironment: [];
}>();

const notify = useNotify();
const copy = dshInstallCardCopy();

async function install(reinstall = true) {
  try {
    const { demoteDshEmployeesToPi } = await import('./engine-fallback');
    await demoteDshEmployeesToPi().catch(() => undefined);
    const result = await installDshRuntimeWithProgress({ reinstall, source: 'manual' });
    notify.success('notify.saved', result.message);
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}
</script>

<template>
  <div class="space-y-3 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">{{ copy.title }}</p>
        <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">
          {{ copy.body }}
          <code class="rounded bg-[var(--surface-muted)] px-1">{{ copy.runtimePathHint }}</code>
        </p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">
        <button
          class="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)]"
          type="button"
          :disabled="dshInstallState.busy.value"
          @click="emit('openEnvironment')"
        >
          {{ copy.openEnvLabel }}
        </button>
        <button
          class="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
          type="button"
          :disabled="dshInstallState.busy.value"
          @click="install(true)"
        >
          {{ dshInstallState.busy.value ? copy.installingLabel : copy.installLabel }}
        </button>
      </div>
    </div>
    <DshInstallProgressPanel compact />
  </div>
</template>
