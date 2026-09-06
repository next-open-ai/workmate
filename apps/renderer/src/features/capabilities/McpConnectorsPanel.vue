<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../app/i18n';
import {
  formatEnvLines,
  mcpSummaryLine,
  mcpTestPassed,
  parseArgLines,
  parseEnvLines,
  resolveLocalCommand,
  toMcpServerJson,
  useMcpConfig,
  type McpConnection,
  type McpKind,
  type McpLocalRunner,
  type McpTransport,
} from '../../app/mcp-config';
import { BASELINE_MCPS } from '../../app/baseline-mcps';
import { useNotify } from '../../app/notify';
import { useAuth } from '../../app/auth';
import { testMcpConnection } from '../../services/api';

const { t } = useI18n();
const notify = useNotify();
const { isAdmin } = useAuth();
const { connections, load, upsert, remove, setEnabled, recordTestResult, toRuntime } = useMcpConfig();
const baselineIds = new Set(BASELINE_MCPS.map((item) => item.id));
function isBaseline(item: McpConnection) {
  return baselineIds.has(item.id);
}

const editingId = ref<string | null>(null);
const formOpen = ref(false);
const saving = ref(false);
const selectedId = ref<string | null>(null);
const testingId = ref<string | null>(null);
const query = ref('');
const kindFilter = ref<'all' | 'baseline' | 'local' | 'remote' | 'enabled'>('all');
const draft = ref({
  name: '',
  kind: 'remote' as McpKind,
  transport: 'sse' as McpTransport,
  url: '',
  apiKey: '',
  runner: 'npx' as McpLocalRunner,
  customCommand: '',
  argsText: '',
  envText: '',
  cwd: '',
  enabled: true,
  description: '',
});

const sorted = computed(() =>
  [...connections.value].sort((a, b) => {
    const aBase = isBaseline(a) ? 0 : 1;
    const bBase = isBaseline(b) ? 0 : 1;
    if (aBase !== bBase) return aBase - bBase;
    return b.updatedAt - a.updatedAt;
  }),
);

const mcpStats = computed(() => {
  const all = connections.value;
  return {
    total: all.length,
    enabled: all.filter((item) => item.enabled).length,
    passed: all.filter((item) => item.lastTestStatus === 'passed').length,
    baseline: all.filter((item) => isBaseline(item)).length,
  };
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return sorted.value.filter((item) => {
    if (kindFilter.value === 'baseline' && !isBaseline(item)) return false;
    if (kindFilter.value === 'local' && item.kind !== 'local') return false;
    if (kindFilter.value === 'remote' && item.kind !== 'remote') return false;
    if (kindFilter.value === 'enabled' && !item.enabled) return false;
    if (!q) return true;
    return `${item.name} ${item.description || ''} ${mcpSummaryLine(item)}`.toLowerCase().includes(q);
  });
});

const selected = computed(() =>
  filtered.value.find((item) => item.id === selectedId.value)
    ?? sorted.value.find((item) => item.id === selectedId.value)
    ?? null,
);

const draftJson = computed(() => {
  const kind = draft.value.kind;
  const command = kind === 'local' ? resolveLocalCommand(draft.value.runner, draft.value.customCommand) : undefined;
  return JSON.stringify(
    toMcpServerJson({
      name: draft.value.name || (kind === 'local' ? 'local-mcp' : 'remote-mcp'),
      kind,
      transport: kind === 'local' ? 'stdio' : draft.value.transport === 'http' ? 'http' : 'sse',
      url: draft.value.url,
      apiKey: draft.value.apiKey,
      command,
      args: parseArgLines(draft.value.argsText),
      env: parseEnvLines(draft.value.envText),
      cwd: draft.value.cwd,
    }),
    null,
    2,
  );
});

const selectedJson = computed(() => {
  if (!selected.value) return '';
  return JSON.stringify(toMcpServerJson(selected.value), null, 2);
});

onMounted(() => { void load(); });

watch(filtered, (rows) => {
  if (!rows.length) {
    if (!sorted.value.some((row) => row.id === selectedId.value)) selectedId.value = null;
    return;
  }
  if (!selectedId.value || !rows.some((row) => row.id === selectedId.value)) {
    selectedId.value = rows[0].id;
  }
});

watch(sorted, (rows) => {
  if (!rows.length) {
    selectedId.value = null;
    return;
  }
  if (!selectedId.value || !rows.some((row) => row.id === selectedId.value)) {
    selectedId.value = rows[0].id;
  }
});

function resetDraft() {
  draft.value = {
    name: '',
    kind: 'remote',
    transport: 'sse',
    url: '',
    apiKey: '',
    runner: 'npx',
    customCommand: '',
    argsText: '',
    envText: '',
    cwd: '',
    enabled: true,
    description: '',
  };
  editingId.value = null;
}

function openCreate() {
  resetDraft();
  formOpen.value = true;
}

function openEdit(item: McpConnection) {
  editingId.value = item.id;
  selectedId.value = item.id;
  draft.value = {
    name: item.name,
    kind: item.kind,
    transport: item.transport === 'http' ? 'http' : item.transport === 'sse' ? 'sse' : 'sse',
    url: item.url || '',
    apiKey: item.apiKey || '',
    runner: item.runner || (item.command === 'uvx' ? 'uvx' : item.command === 'npx' ? 'npx' : 'custom'),
    customCommand: item.runner === 'custom' || (item.command !== 'npx' && item.command !== 'uvx') ? (item.command || '') : '',
    argsText: (item.args || []).join('\n'),
    envText: formatEnvLines(item.env),
    cwd: item.cwd || '',
    enabled: item.enabled,
    description: item.description || '',
  };
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  resetDraft();
}

function setKind(kind: McpKind) {
  draft.value.kind = kind;
  if (kind === 'local') draft.value.transport = 'stdio';
  else if (draft.value.transport === 'stdio') draft.value.transport = 'sse';
}

async function save() {
  if (!isAdmin.value) return;
  saving.value = true;
  try {
    const kind = draft.value.kind;
    const saved = await upsert(
      kind === 'local'
        ? {
            id: editingId.value || undefined,
            name: draft.value.name,
            kind: 'local',
            transport: 'stdio',
            runner: draft.value.runner,
            command: resolveLocalCommand(draft.value.runner, draft.value.customCommand),
            args: parseArgLines(draft.value.argsText),
            env: parseEnvLines(draft.value.envText),
            cwd: draft.value.cwd,
            enabled: draft.value.enabled,
            description: draft.value.description,
          }
        : {
            id: editingId.value || undefined,
            name: draft.value.name,
            kind: 'remote',
            transport: draft.value.transport === 'http' ? 'http' : 'sse',
            url: draft.value.url,
            apiKey: draft.value.apiKey,
            enabled: draft.value.enabled,
            description: draft.value.description,
          },
    );
    selectedId.value = saved.id;
    notify.success(editingId.value ? 'notify.mcpUpdated' : 'notify.mcpCreated');
    closeForm();
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function onToggle(item: McpConnection, event: Event) {
  if (!isAdmin.value) return;
  try {
    await setEnabled(item.id, (event.target as HTMLInputElement).checked);
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function onDelete(item: McpConnection) {
  if (!isAdmin.value) return;
  if (!window.confirm(t('capabilities.mcpDeleteConfirm', { name: item.name }))) return;
  try {
    await remove(item.id);
    if (editingId.value === item.id) closeForm();
    if (selectedId.value === item.id) selectedId.value = null;
    notify.success('notify.mcpDeleted');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function onTest(item: McpConnection) {
  if (testingId.value) return;
  testingId.value = item.id;
  selectedId.value = item.id;
  try {
    const result = await testMcpConnection(toRuntime({ ...item, enabled: true }));
    await recordTestResult(item.id, result);
    notify.success('notify.mcpTestPassed');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'MCP test failed.';
    await recordTestResult(item.id, { ok: false, error: message });
    notify.error(cause, 'notify.mcpTestFailed');
  } finally {
    testingId.value = null;
  }
}

async function copyJson(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('notify.mcpJsonCopied');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

function kindLabel(item: McpConnection) {
  return item.kind === 'local' ? t('capabilities.mcpKindLocal') : t('capabilities.mcpKindRemote');
}

function transportBadge(item: McpConnection) {
  if (item.kind === 'local') return item.runner === 'uvx' ? 'uvx' : item.runner === 'npx' ? 'npx' : 'stdio';
  return item.transport;
}

function testBadge(item: McpConnection) {
  if (item.lastTestStatus === 'passed') return t('capabilities.mcpTestPassed');
  if (item.lastTestStatus === 'failed') return t('capabilities.mcpTestFailed');
  return t('capabilities.mcpTestNever');
}

const filterChips = [
  { id: 'all' as const, label: 'capabilities.filterAll' },
  { id: 'baseline' as const, label: 'capabilities.mcpFilterBaseline' },
  { id: 'enabled' as const, label: 'capabilities.mcpFilterEnabled' },
  { id: 'local' as const, label: 'capabilities.mcpKindLocal' },
  { id: 'remote' as const, label: 'capabilities.mcpKindRemote' },
];

function formatTestTime(value?: number) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4">
    <div class="grid shrink-0 gap-3 sm:grid-cols-4">
      <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('capabilities.mcpStatTotal') }}</p>
        <p class="mt-1 text-2xl font-bold tabular-nums tracking-tight">{{ mcpStats.total }}</p>
      </div>
      <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('capabilities.mcpStatEnabled') }}</p>
        <p class="mt-1 text-2xl font-bold tabular-nums tracking-tight text-emerald-600">{{ mcpStats.enabled }}</p>
      </div>
      <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('capabilities.mcpStatPassed') }}</p>
        <p class="mt-1 text-2xl font-bold tabular-nums tracking-tight text-[var(--accent)]">{{ mcpStats.passed }}</p>
      </div>
      <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('capabilities.mcpStatBaseline') }}</p>
        <p class="mt-1 text-2xl font-bold tabular-nums tracking-tight">{{ mcpStats.baseline }}</p>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 gap-4 xl:grid-cols-[1.2fr_0.9fr]">
      <article class="flex min-h-0 flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div class="flex shrink-0 flex-col gap-3 border-b border-[var(--border)] p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="text-sm font-bold tracking-[-.01em]">{{ t('capabilities.mcpListTitle') }}</h2>
              <p class="mt-0.5 max-w-xl text-[11px] leading-relaxed text-[var(--muted)]">{{ t('capabilities.mcpListHelp') }}</p>
              <p class="mt-1 text-[11px] text-[var(--muted)]">{{ isAdmin ? '这是组织级 MCP 目录，管理员可维护，全员可见。' : '这是组织级 MCP 目录。你可以查看和测试连接，但只有管理员可以修改。' }}</p>
            </div>
            <button class="rounded-xl bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-white shadow-sm disabled:opacity-50" type="button" :disabled="!isAdmin" @click="openCreate">
              {{ t('capabilities.addMcp') }}
            </button>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input v-model="query" class="min-w-[180px] flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" :placeholder="t('capabilities.mcpSearch')" />
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="item in filterChips"
                :key="item.id"
                type="button"
                :class="['rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition', kindFilter === item.id ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--foreground)]']"
                @click="kindFilter = item.id"
              >
                {{ t(item.label) }}
              </button>
            </div>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          <p v-if="!filtered.length" class="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-muted)]/40 px-4 py-14 text-center text-sm text-[var(--muted)]">
            {{ t('capabilities.emptyMcp') }}
          </p>
          <div v-else class="grid gap-1.5">
            <button
              v-for="item in filtered"
              :key="item.id"
              type="button"
              :class="[
                'group flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
                selectedId === item.id
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]/35 shadow-sm ring-1 ring-[var(--accent)]/15'
                  : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-muted)]/70',
              ]"
              @click="selectedId = item.id"
            >
              <div
                class="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[10px] font-extrabold text-white shadow-sm"
                :style="{ background: item.kind === 'local' ? 'linear-gradient(135deg,#0f766e,#0d9488)' : 'linear-gradient(135deg,#3b5bdb,#526fe0)' }"
              >
                {{ item.kind === 'local' ? 'LOC' : 'NET' }}
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <h3 class="truncate text-[13px] font-bold tracking-[-.01em]">{{ item.name }}</h3>
                  <span
                    v-if="isBaseline(item)"
                    class="rounded-md bg-[var(--accent)]/12 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]"
                  >
                    {{ t('capabilities.mcpBaselineBadge') }}
                  </span>
                  <span
                    :class="[
                      'rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                      item.enabled ? 'bg-emerald-500/12 text-emerald-700' : 'bg-[var(--surface-muted)] text-[var(--muted)]',
                    ]"
                  >
                    {{ item.enabled ? t('capabilities.mcpEnabled') : t('capabilities.mcpDisabled') }}
                  </span>
                </div>
                <p class="mt-1 truncate font-mono text-[11px] text-[var(--muted)]">{{ mcpSummaryLine(item) }}</p>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <span class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">{{ kindLabel(item) }}</span>
                  <span class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--muted)]">{{ transportBadge(item) }}</span>
                  <span
                    :class="[
                      'rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                      item.lastTestStatus === 'passed'
                        ? 'bg-emerald-500/12 text-emerald-700'
                        : item.lastTestStatus === 'failed'
                          ? 'bg-rose-500/12 text-rose-700'
                          : 'bg-amber-500/12 text-amber-700',
                    ]"
                  >
                    {{ testBadge(item) }}
                  </span>
                  <span v-if="mcpTestPassed(item) && item.lastTestToolCount != null" class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
                    {{ t('capabilities.mcpToolCount', { n: item.lastTestToolCount }) }}
                  </span>
                </div>
                <p v-if="item.description" class="mt-1.5 line-clamp-1 text-[11px] text-[var(--muted)]">{{ item.description }}</p>
                <div class="mt-2.5 flex flex-wrap items-center gap-2" @click.stop>
                  <label class="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--muted)]">
                    <input :checked="item.enabled" :disabled="!isAdmin" type="checkbox" @change="onToggle(item, $event)" />
                    {{ t('capabilities.mcpEnable') }}
                  </label>
                  <button
                    class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1 text-[11px] font-semibold hover:border-[var(--accent)] disabled:opacity-50"
                    type="button"
                    :disabled="testingId === item.id"
                    @click="onTest(item)"
                  >
                    {{ testingId === item.id ? t('capabilities.mcpTesting') : t('capabilities.mcpTest') }}
                  </button>
                  <button class="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-semibold hover:border-[var(--accent)] disabled:opacity-50" type="button" :disabled="!isAdmin" @click="openEdit(item)">
                    {{ t('capabilities.edit') }}
                  </button>
                  <button class="rounded-lg px-2 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-50" type="button" :disabled="!isAdmin" @click="onDelete(item)">
                    {{ t('capabilities.delete') }}
                  </button>
                </div>
              </div>
            </button>
          </div>
        </div>
      </article>

      <aside class="space-y-4">
        <section v-if="formOpen" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div class="flex items-start justify-between gap-2">
            <div>
              <h2 class="font-bold">{{ editingId ? t('capabilities.editMcp') : t('capabilities.addMcp') }}</h2>
              <p class="mt-1 text-xs text-[var(--muted)]">{{ t('capabilities.mcpFormHelp') }}</p>
            </div>
            <button class="text-xl text-[var(--muted)]" type="button" @click="closeForm">×</button>
          </div>

          <div class="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-[var(--surface-muted)] p-1">
            <button
              type="button"
              :class="['rounded-lg px-3 py-2 text-xs font-semibold transition', draft.kind === 'remote' ? 'bg-[var(--surface)] text-[var(--foreground)] shadow-sm' : 'text-[var(--muted)]']"
              @click="setKind('remote')"
            >
              {{ t('capabilities.mcpKindRemote') }}
            </button>
            <button
              type="button"
              :class="['rounded-lg px-3 py-2 text-xs font-semibold transition', draft.kind === 'local' ? 'bg-[var(--surface)] text-[var(--foreground)] shadow-sm' : 'text-[var(--muted)]']"
              @click="setKind('local')"
            >
              {{ t('capabilities.mcpKindLocal') }}
            </button>
          </div>
          <p class="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
            {{ draft.kind === 'local' ? t('capabilities.mcpLocalHelp') : t('capabilities.mcpRemoteHelp') }}
          </p>

          <form class="mt-4 space-y-3" @submit.prevent="save">
            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('capabilities.name') }}</span>
              <input v-model.trim="draft.name" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" required />
            </label>

            <template v-if="draft.kind === 'remote'">
              <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
                <span>{{ t('capabilities.url') }}</span>
                <input v-model.trim="draft.url" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" placeholder="https://…" required />
              </label>
              <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
                <span>{{ t('capabilities.mcpTransport') }}</span>
                <select v-model="draft.transport" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal">
                  <option value="http">HTTP</option>
                  <option value="sse">SSE</option>
                </select>
              </label>
              <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
                <span>{{ t('capabilities.mcpApiKey') }}</span>
                <input v-model="draft.apiKey" type="password" autocomplete="off" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('capabilities.mcpApiKeyHint')" />
              </label>
            </template>

            <template v-else>
              <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
                <span>{{ t('capabilities.mcpLocalRunner') }}</span>
                <select v-model="draft.runner" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal">
                  <option value="npx">npx</option>
                  <option value="uvx">uvx</option>
                  <option value="custom">{{ t('capabilities.mcpLocalCustom') }}</option>
                </select>
              </label>
              <label v-if="draft.runner === 'custom'" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
                <span>{{ t('capabilities.mcpLocalCommand') }}</span>
                <input v-model.trim="draft.customCommand" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-sm font-normal" placeholder="node / path/to/server" required />
              </label>
              <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
                <span>{{ t('capabilities.mcpLocalArgs') }}</span>
                <textarea
                  v-model="draft.argsText"
                  rows="4"
                  class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-sm font-normal"
                  :placeholder="draft.runner === 'uvx' ? t('capabilities.mcpLocalArgsHintUvx') : t('capabilities.mcpLocalArgsHintNpx')"
                />
              </label>
              <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
                <span>{{ t('capabilities.mcpLocalEnv') }}</span>
                <textarea v-model="draft.envText" rows="3" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-sm font-normal" :placeholder="t('capabilities.mcpLocalEnvHint')" />
              </label>
              <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
                <span>{{ t('capabilities.mcpLocalCwd') }}</span>
                <input v-model.trim="draft.cwd" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-sm font-normal" :placeholder="t('capabilities.mcpLocalCwdHint')" />
              </label>
            </template>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('capabilities.mcpDescription') }}</span>
              <textarea v-model.trim="draft.description" rows="2" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" />
            </label>
            <label class="flex items-center gap-2 text-xs font-semibold">
              <input v-model="draft.enabled" type="checkbox" />
              {{ t('capabilities.mcpEnable') }}
            </label>

            <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
              <div class="mb-2 flex items-center justify-between gap-2">
                <p class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">{{ t('capabilities.mcpJsonPreview') }}</p>
                <button class="text-[11px] font-semibold text-[var(--accent)]" type="button" @click="copyJson(draftJson)">{{ t('capabilities.mcpCopyJson') }}</button>
              </div>
              <pre class="max-h-48 overflow-auto font-mono text-[11px] leading-relaxed text-[var(--foreground)] whitespace-pre">{{ draftJson }}</pre>
            </div>

            <button class="w-full rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50" type="submit" :disabled="saving || !isAdmin">
              {{ saving ? t('capabilities.saving') : t('capabilities.save') }}
            </button>
          </form>
        </section>

        <section v-else-if="selected" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div class="flex items-start justify-between gap-2">
            <div>
              <p class="text-[11px] font-extrabold tracking-[.12em] text-[var(--accent)]">MCP · CONFIG</p>
              <h2 class="mt-1 font-bold">{{ selected.name }}</h2>
              <p class="mt-1 text-xs text-[var(--muted)]">{{ t('capabilities.mcpJsonSavedHelp') }}</p>
            </div>
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50" type="button" :disabled="!isAdmin" @click="openEdit(selected)">
              {{ t('capabilities.edit') }}
            </button>
          </div>
          <div class="mt-4 grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/60 p-3 text-xs">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[var(--muted)]">{{ t('capabilities.mcpTestStatus') }}</span>
              <strong>{{ testBadge(selected) }}</strong>
            </div>
            <div v-if="selected.lastTestAt" class="flex items-center justify-between gap-2">
              <span class="text-[var(--muted)]">{{ t('capabilities.mcpLastTestAt') }}</span>
              <span>{{ formatTestTime(selected.lastTestAt) }}</span>
            </div>
            <p v-if="selected.lastTestMessage" class="leading-relaxed text-[var(--muted)]">{{ selected.lastTestMessage }}</p>
            <button
              class="mt-1 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              type="button"
              :disabled="testingId === selected.id"
              @click="onTest(selected)"
            >
              {{ testingId === selected.id ? t('capabilities.mcpTesting') : t('capabilities.mcpTest') }}
            </button>
          </div>

          <div
            v-if="mcpTestPassed(selected) && selected.lastTestTools?.length"
            class="mt-4 overflow-hidden rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04]"
          >
            <div class="flex items-center justify-between gap-2 border-b border-emerald-500/15 px-3 py-2.5">
              <div>
                <p class="text-[11px] font-bold uppercase tracking-wide text-emerald-800">{{ t('capabilities.mcpToolsTitle') }}</p>
                <p class="mt-0.5 text-[11px] text-[var(--muted)]">{{ t('capabilities.mcpToolsHelp', { n: selected.lastTestTools.length }) }}</p>
              </div>
              <button
                class="text-[11px] font-semibold text-[var(--accent)]"
                type="button"
                @click="copyJson((selected.lastTestTools || []).map((tool) => tool.name).join('\n'))"
              >
                {{ t('capabilities.mcpCopyTools') }}
              </button>
            </div>
            <ul class="max-h-72 divide-y divide-[var(--border)]/70 overflow-y-auto">
              <li
                v-for="tool in selected.lastTestTools"
                :key="tool.name"
                class="px-3 py-2.5"
              >
                <code class="block text-[12px] font-semibold text-[var(--foreground)]">{{ tool.name }}</code>
                <p v-if="tool.description" class="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{{ tool.description }}</p>
              </li>
            </ul>
          </div>
          <p
            v-else-if="mcpTestPassed(selected) && !selected.lastTestTools?.length"
            class="mt-4 rounded-xl border border-dashed border-[var(--border)] px-3 py-3 text-[11px] text-[var(--muted)]"
          >
            {{ t('capabilities.mcpToolsEmpty') }}
          </p>

          <div class="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div class="mb-2 flex items-center justify-between gap-2">
              <p class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">{{ t('capabilities.mcpJsonPreview') }}</p>
              <button class="text-[11px] font-semibold text-[var(--accent)]" type="button" @click="copyJson(selectedJson)">{{ t('capabilities.mcpCopyJson') }}</button>
            </div>
            <pre class="max-h-56 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre">{{ selectedJson }}</pre>
          </div>
          <ol class="mt-4 list-decimal space-y-2 pl-4 text-xs leading-relaxed text-[var(--muted)]">
            <li>{{ t('capabilities.mcpStepTest') }}</li>
            <li>{{ t('capabilities.mcpStep2') }}</li>
            <li>{{ t('capabilities.mcpStep3') }}</li>
          </ol>
        </section>

        <section v-else class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h2 class="font-bold">{{ t('capabilities.mcpSidebarTitle') }}</h2>
          <p class="mt-2 text-sm leading-relaxed text-[var(--muted)]">{{ t('capabilities.mcpSidebarHelp') }}</p>
          <div class="mt-4 grid gap-2">
            <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-3 text-xs leading-relaxed text-[var(--muted)]">
              <strong class="text-[var(--foreground)]">{{ t('capabilities.mcpKindRemote') }}</strong>
              <p class="mt-1">{{ t('capabilities.mcpRemoteHelp') }}</p>
            </div>
            <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-3 text-xs leading-relaxed text-[var(--muted)]">
              <strong class="text-[var(--foreground)]">{{ t('capabilities.mcpKindLocal') }}</strong>
              <p class="mt-1">{{ t('capabilities.mcpLocalHelp') }}</p>
            </div>
          </div>
          <ol class="mt-4 list-decimal space-y-2 pl-4 text-xs leading-relaxed text-[var(--muted)]">
            <li>{{ t('capabilities.mcpStep1') }}</li>
            <li>{{ t('capabilities.mcpStepTest') }}</li>
            <li>{{ t('capabilities.mcpStep2') }}</li>
            <li>{{ t('capabilities.mcpStep3') }}</li>
          </ol>
          <button class="mt-5 w-full rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm font-semibold hover:border-[var(--accent)] disabled:opacity-50" type="button" :disabled="!isAdmin" @click="openCreate">
            {{ t('capabilities.addMcp') }}
          </button>
        </section>
      </aside>
    </div>
  </div>
</template>
