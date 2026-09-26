<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Asset } from '../../app/assets';
import { loadArchivedAssetContentUrl } from '../../services/api';
import { openAssetBestEffort } from '../../app/platform-actions';
import { assetMediaKind } from './asset-media';

const props = defineProps<{ asset: Asset }>();
const failed = ref(false);
const kind = computed(() => assetMediaKind(props.asset));
const source = ref('');
let controller: AbortController | undefined;

function clearSource() {
  controller?.abort();
  controller = undefined;
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = '';
}

watch([() => props.asset.id, kind], async ([, nextKind]) => {
  clearSource();
  failed.value = false;
  if (!nextKind) return;
  const current = new AbortController();
  controller = current;
  try {
    const loaded = await loadArchivedAssetContentUrl(props.asset.id, current.signal);
    if (current.signal.aborted) URL.revokeObjectURL(loaded);
    else source.value = loaded;
  } catch {
    if (!current.signal.aborted) failed.value = true;
  }
}, { immediate: true });

onBeforeUnmount(clearSource);
</script>

<template>
  <div v-if="kind && source && !failed" class="relative border-b border-[var(--border)] bg-[var(--surface-muted)]/55">
    <button
      v-if="kind === 'image'"
      class="group relative block w-full overflow-hidden bg-[radial-gradient(circle_at_top,#ffffff_0%,var(--surface-muted)_75%)] text-left"
      type="button"
      :aria-label="`查看原图：${asset.name}`"
      @click="openAssetBestEffort(asset.id)"
    >
      <img
        :src="source"
        :alt="asset.name"
        class="h-72 w-full object-contain p-2 transition duration-300 group-hover:scale-[1.015]"
        loading="lazy"
        decoding="async"
        @error="failed = true"
      />
      <span class="pointer-events-none absolute bottom-3 right-3 rounded-full border border-white/60 bg-slate-950/65 px-2.5 py-1 text-[10px] font-semibold text-white opacity-0 shadow-lg backdrop-blur transition group-hover:opacity-100">查看原图 ↗</span>
    </button>
    <div v-else-if="kind === 'audio'" class="flex items-center gap-3 bg-[linear-gradient(135deg,var(--surface)_0%,var(--accent-soft)_140%)] px-4 py-4">
      <span class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--accent)] text-lg text-white shadow-sm" aria-hidden="true">♪</span>
      <div class="min-w-0 flex-1">
        <p class="mb-1.5 truncate text-[11px] font-semibold text-[var(--muted)]">音频预览</p>
        <audio
          class="h-9 w-full min-w-0"
          :src="source"
          controls
          preload="metadata"
          :aria-label="`播放音频：${asset.name}`"
          @error="failed = true"
        />
      </div>
    </div>
    <video
      v-else
      class="max-h-80 w-full bg-black object-contain"
      :src="source"
      controls
      preload="metadata"
      playsinline
      :aria-label="`播放视频：${asset.name}`"
      @error="failed = true"
    />
  </div>
</template>
