<script setup lang="ts">
import { useNotify } from '../../app/notify';

const { list, dismiss } = useNotify();

function kindClass(kind: string) {
  if (kind === 'success') return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-800';
  if (kind === 'error') return 'border-rose-500/35 bg-rose-500/10 text-rose-800';
  if (kind === 'warning') return 'border-amber-500/35 bg-amber-500/10 text-amber-900';
  return 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]';
}
</script>

<template>
  <div class="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(100vw-2rem,380px)] flex-col gap-2">
    <article
      v-for="item in list"
      :key="item.id"
      :class="['pointer-events-auto rounded-xl border px-3.5 py-3 shadow-lg backdrop-blur', kindClass(item.kind)]"
      role="status"
    >
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ item.title }}</p>
          <p v-if="item.detail" class="mt-1 text-xs leading-relaxed opacity-90">{{ item.detail }}</p>
        </div>
        <button class="shrink-0 text-lg leading-none opacity-60 hover:opacity-100" type="button" aria-label="Dismiss" @click="dismiss(item.id)">×</button>
      </div>
    </article>
  </div>
</template>
