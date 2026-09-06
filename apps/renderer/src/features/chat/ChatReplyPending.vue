<script setup lang="ts">
import { useI18n } from '../../app/i18n';

defineProps<{ accent?: string }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="thinking-bubble relative mt-1 overflow-hidden rounded-[4px_14px_14px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4 shadow-sm"
    role="status"
    :aria-label="t('chat.generating')"
  >
    <div class="thinking-glow pointer-events-none absolute inset-0 opacity-70" :style="{ '--think-accent': accent || 'var(--accent)' }" />
    <div class="relative flex items-center gap-4">
      <div class="thinking-orbit grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--surface-muted)]" :style="{ color: accent || 'var(--accent)' }">
        <span class="thinking-core" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold tracking-tight text-[var(--text)]">{{ t('chat.generating') }}</p>
        <div class="mt-2 flex items-center gap-1.5">
          <span v-for="i in 4" :key="i" class="thinking-bar" :style="{ animationDelay: `${(i - 1) * 0.14}s`, background: accent || 'var(--accent)' }" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thinking-glow {
  background:
    radial-gradient(ellipse 80% 60% at 20% 50%, color-mix(in srgb, var(--think-accent) 22%, transparent), transparent 70%),
    radial-gradient(ellipse 60% 80% at 90% 30%, color-mix(in srgb, var(--think-accent) 14%, transparent), transparent 65%);
  animation: think-pulse 2.4s ease-in-out infinite;
}

.thinking-orbit {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent);
}

.thinking-core {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: currentColor;
  box-shadow:
    0 0 0 4px color-mix(in srgb, currentColor 18%, transparent),
    0 0 18px color-mix(in srgb, currentColor 45%, transparent);
  animation: think-core 1.1s ease-in-out infinite;
}

.thinking-bar {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  opacity: 0.35;
  animation: think-bar 1.05s ease-in-out infinite;
}

@keyframes think-pulse {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.02);
  }
}

@keyframes think-core {
  0%,
  100% {
    transform: scale(0.92);
    opacity: 0.85;
  }
  50% {
    transform: scale(1.08);
    opacity: 1;
  }
}

@keyframes think-bar {
  0%,
  100% {
    transform: translateY(0) scale(1);
    opacity: 0.35;
  }
  50% {
    transform: translateY(-5px) scale(1.15);
    opacity: 1;
  }
}
</style>
