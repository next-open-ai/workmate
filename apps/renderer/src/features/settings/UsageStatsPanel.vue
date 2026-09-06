<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../app/i18n';
import { fetchUsageStats, type ServerUsageStats } from '../../services/orchestration';

const { t, locale } = useI18n();
const loading = ref(false);
const error = ref('');
const stats = ref<ServerUsageStats | null>(null);
type UsageSection = 'model' | 'project' | 'chat' | 'day' | 'week' | 'month' | 'recent';
const section = ref<UsageSection>('model');

const numberFmt = computed(() => new Intl.NumberFormat(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US'));

function formatTokens(value: number | undefined) {
  return numberFmt.value.format(Math.max(0, Math.round(value || 0)));
}

function formatTime(ts: number) {
  return new Intl.DateTimeFormat(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

function formatPeriod(period: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    const [y, m, d] = period.split('-').map(Number);
    return new Intl.DateTimeFormat(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(y!, (m || 1) - 1, d || 1));
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-').map(Number);
    return new Intl.DateTimeFormat(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'long',
    }).format(new Date(y!, (m || 1) - 1, 1));
  }
  if (/^\d{4}-W\d{2}$/.test(period)) {
    const [y, w] = period.split('-W');
    return t('settings.usageWeekLabel', { year: y || '', week: String(Number(w || 0)) });
  }
  return period;
}

function periodRows() {
  if (!stats.value) return [];
  if (section.value === 'day') return stats.value.byDay ?? [];
  if (section.value === 'week') return stats.value.byWeek ?? [];
  if (section.value === 'month') return stats.value.byMonth ?? [];
  return [];
}

function channelLabel(row: { provider?: string; providerLabel?: string; baseUrl?: string; chatModel?: string }) {
  const channel = row.providerLabel || row.provider || '—';
  const model = row.chatModel || '—';
  return row.baseUrl ? `${channel} · ${model} · ${row.baseUrl}` : `${channel} · ${model}`;
}

async function reload() {
  loading.value = true;
  error.value = '';
  try {
    stats.value = await fetchUsageStats();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void reload();
});

watch(section, () => {
  /* keep current stats; no refetch */
});
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-[17px] font-bold">{{ t('settings.tabUsage') }}</h2>
        <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.usageHelp') }}</p>
      </div>
      <button
        class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold"
        type="button"
        :disabled="loading"
        @click="reload"
      >
        {{ loading ? t('settings.usageLoading') : t('settings.usageRefresh') }}
      </button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-500">{{ error }}</p>

    <template v-else-if="stats">
      <p
        v-if="stats.rollup"
        class="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--muted)]"
      >
        {{ t('settings.usageRollupNote', {
          count: stats.rollup.mergedRunCount,
          from: formatTime(stats.rollup.periodStart),
          to: formatTime(stats.rollup.periodEnd),
        }) }}
      </p>
      <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <article class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{{ t('settings.usageTotal') }}</p>
          <p class="mt-2 text-2xl font-bold tabular-nums">{{ formatTokens(stats.totals.totalTokens) }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">{{ t('settings.usageRuns', { count: stats.totals.runCount }) }}</p>
        </article>
        <article class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{{ t('settings.usageInput') }}</p>
          <p class="mt-2 text-2xl font-bold tabular-nums">{{ formatTokens(stats.totals.inputTokens) }}</p>
        </article>
        <article class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{{ t('settings.usageOutput') }}</p>
          <p class="mt-2 text-2xl font-bold tabular-nums">{{ formatTokens(stats.totals.outputTokens) }}</p>
        </article>
        <article class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{{ t('settings.usageCache') }}</p>
          <p class="mt-2 text-2xl font-bold tabular-nums">{{ formatTokens(stats.totals.cacheReadTokens + stats.totals.cacheWriteTokens) }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">
            {{ t('settings.usageCacheDetail', {
              read: formatTokens(stats.totals.cacheReadTokens),
              write: formatTokens(stats.totals.cacheWriteTokens),
            }) }}
          </p>
        </article>
      </div>

      <div class="mt-6 flex flex-wrap gap-2">
        <button
          v-for="item in ([
            { id: 'model', label: t('settings.usageByModel') },
            { id: 'project', label: t('settings.usageByProject') },
            { id: 'chat', label: t('settings.usageByChat') },
            { id: 'day', label: t('settings.usageByDay') },
            { id: 'week', label: t('settings.usageByWeek') },
            { id: 'month', label: t('settings.usageByMonth') },
            { id: 'recent', label: t('settings.usageRecent') },
          ] as Array<{ id: UsageSection; label: string }>)"
          :key="item.id"
          type="button"
          :class="[
            'rounded-lg px-3 py-2 text-xs font-semibold transition',
            section === item.id ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--text)]',
          ]"
          @click="section = item.id"
        >
          {{ item.label }}
        </button>
      </div>

      <div class="mt-4 overflow-x-auto rounded-xl border border-[var(--border)]">
        <table v-if="section === 'model'" class="min-w-full text-left text-sm">
          <thead class="bg-[var(--surface-muted)] text-xs text-[var(--muted)]">
            <tr>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColChannel') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageInput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageOutput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageTotal') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColRuns') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in stats.byModel" :key="row.key" class="border-t border-[var(--border)]">
              <td class="px-3 py-2">
                <div class="font-medium">{{ row.providerLabel || row.provider }} · {{ row.chatModel }}</div>
                <div v-if="row.baseUrl" class="mt-0.5 text-xs text-[var(--muted)]">{{ row.baseUrl }}</div>
              </td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.inputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.outputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums font-semibold">{{ formatTokens(row.totalTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ row.runCount }}</td>
            </tr>
            <tr v-if="!stats.byModel.length">
              <td class="px-3 py-6 text-[var(--muted)]" colspan="5">{{ t('settings.usageEmpty') }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else-if="section === 'project'" class="min-w-full text-left text-sm">
          <thead class="bg-[var(--surface-muted)] text-xs text-[var(--muted)]">
            <tr>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColProject') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageInput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageOutput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageTotal') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColRuns') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in stats.byProject" :key="row.projectId" class="border-t border-[var(--border)]">
              <td class="px-3 py-2">
                <div class="font-medium">{{ row.name }}</div>
                <div class="mt-0.5 text-xs text-[var(--muted)]">{{ row.projectId }}</div>
              </td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.inputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.outputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums font-semibold">{{ formatTokens(row.totalTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ row.runCount }}</td>
            </tr>
            <tr v-if="!stats.byProject.length">
              <td class="px-3 py-6 text-[var(--muted)]" colspan="5">{{ t('settings.usageEmpty') }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else-if="section === 'chat'" class="min-w-full text-left text-sm">
          <thead class="bg-[var(--surface-muted)] text-xs text-[var(--muted)]">
            <tr>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColChat') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageInput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageOutput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageTotal') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColRuns') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in stats.byChat" :key="row.sessionId" class="border-t border-[var(--border)]">
              <td class="px-3 py-2">
                <div class="font-medium">{{ row.title }}</div>
                <div class="mt-0.5 text-xs text-[var(--muted)]">{{ row.sessionId }}</div>
              </td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.inputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.outputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums font-semibold">{{ formatTokens(row.totalTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ row.runCount }}</td>
            </tr>
            <tr v-if="!stats.byChat.length">
              <td class="px-3 py-6 text-[var(--muted)]" colspan="5">{{ t('settings.usageEmpty') }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else-if="section === 'day' || section === 'week' || section === 'month'" class="min-w-full text-left text-sm">
          <thead class="bg-[var(--surface-muted)] text-xs text-[var(--muted)]">
            <tr>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColPeriod') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageInput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageOutput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageTotal') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColRuns') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in periodRows()" :key="row.period" class="border-t border-[var(--border)]">
              <td class="px-3 py-2">
                <div class="font-medium">{{ formatPeriod(row.period) }}</div>
                <div class="mt-0.5 text-xs text-[var(--muted)]">{{ row.period }}</div>
              </td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.inputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.outputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums font-semibold">{{ formatTokens(row.totalTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ row.runCount }}</td>
            </tr>
            <tr v-if="!periodRows().length">
              <td class="px-3 py-6 text-[var(--muted)]" colspan="5">{{ t('settings.usageEmpty') }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else class="min-w-full text-left text-sm">
          <thead class="bg-[var(--surface-muted)] text-xs text-[var(--muted)]">
            <tr>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColTime') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColKind') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageColChannel') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageInput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageOutput') }}</th>
              <th class="px-3 py-2 font-semibold">{{ t('settings.usageTotal') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in stats.recent" :key="row.runId" class="border-t border-[var(--border)]">
              <td class="px-3 py-2 whitespace-nowrap text-xs">{{ formatTime(row.startedAt) }}</td>
              <td class="px-3 py-2 text-xs">
                {{ row.kind === 'project-task' ? t('settings.usageKindProject') : t('settings.usageKindChat') }}
              </td>
              <td class="max-w-xs px-3 py-2 text-xs leading-relaxed">{{ channelLabel(row) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.inputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ formatTokens(row.outputTokens) }}</td>
              <td class="px-3 py-2 tabular-nums font-semibold">{{ formatTokens(row.totalTokens) }}</td>
            </tr>
            <tr v-if="!stats.recent.length">
              <td class="px-3 py-6 text-[var(--muted)]" colspan="6">{{ t('settings.usageEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <p v-else-if="!loading" class="mt-6 text-sm text-[var(--muted)]">{{ t('settings.usageEmpty') }}</p>
  </div>
</template>
