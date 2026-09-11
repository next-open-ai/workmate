<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  clearDataAppCustomSite,
  createDataAppRecord,
  deleteDataAppRecord,
  getDataApp,
  getDataAppCustomSite,
  getDataAppPublish,
  listDataAppRevisions,
  publishDataApp,
  restoreDataAppRevision,
  updateDataAppRecord,
  type DataApp,
  type DataAppDetail,
  type DataRecord,
  type DataAppRevision,
} from '../../services/api';
import { openExternalBestEffort } from '../../app/platform-actions';
import { qrDataUrl } from '../../app/qr-data-url.js';

const props = defineProps<{ app: DataApp | DataAppDetail }>();
const emit = defineEmits<{ close: [] }>();
const detail = ref<DataAppDetail | null>('table' in props.app && 'records' in props.app ? props.app as DataAppDetail : null);
const search = ref('');
const loading = ref(false);
const saving = ref(false);
const deletingId = ref('');
const error = ref('');
const formOpen = ref(false);
const editing = ref<DataRecord | null>(null);
const form = ref<Record<string, string>>({});
const publishUrl = ref('');
const localUrl = ref('');
const lanUrls = ref<string[]>([]);
const qrSrc = ref('');
const publishing = ref(false);
const customSite = ref<{ bound: boolean; updatedAt: number | null; note: string; bytes: number }>({ bound: false, updatedAt: null, note: '', bytes: 0 });
const clearingCustom = ref(false);
const refreshingPublish = ref(false);
const revisions = ref<DataAppRevision[]>([]);
const revisionsOpen = ref(false);
const restoringId = ref('');
let publishPoll: number | undefined;

const columns = computed(() => detail.value?.table.columns || []);
const records = computed(() => detail.value?.records || []);
const title = computed(() => detail.value?.name || props.app.name);
const primaryUrl = computed(() => lanUrls.value[0] || publishUrl.value || localUrl.value);
const desktopUrl = computed(() => localUrl.value || publishUrl.value || lanUrls.value[0] || '');

async function refreshQr() {
  const target = primaryUrl.value;
  if (!target) { qrSrc.value = ''; return; }
  try { qrSrc.value = await qrDataUrl(target, 128); }
  catch { qrSrc.value = ''; }
}

async function load() {
  loading.value = true; error.value = '';
  try { detail.value = await getDataApp(props.app.id, search.value); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '应用数据读取失败。'; }
  finally { loading.value = false; }
}
async function loadPublish() {
  try {
    const status = await getDataAppPublish(props.app.id);
    publishUrl.value = status.url || '';
    localUrl.value = status.localUrl || status.url || '';
    lanUrls.value = status.lanUrls || [];
    await refreshQr();
  } catch {
    publishUrl.value = '';
    localUrl.value = '';
    lanUrls.value = [];
    qrSrc.value = '';
  }
  try {
    customSite.value = await getDataAppCustomSite(props.app.id);
  } catch {
    customSite.value = { bound: false, updatedAt: null, note: '', bytes: 0 };
  }
  try { revisions.value = await listDataAppRevisions(props.app.id); } catch { revisions.value = []; }
}
async function restoreRevision(revision: DataAppRevision) {
  if (!window.confirm('回退到这个版本？当前版本也会保留在历史记录中。')) return;
  restoringId.value = revision.id; error.value = '';
  try { await restoreDataAppRevision(props.app.id, revision.id); await loadPublish(); revisionsOpen.value = false; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '版本回退失败。'; }
  finally { restoringId.value = ''; }
}
async function refreshPublishStatus() {
  refreshingPublish.value = true;
  try { await loadPublish(); }
  finally { refreshingPublish.value = false; }
}
async function clearCustomSite() {
  if (!customSite.value.bound) return;
  if (!window.confirm('恢复默认 CRUD 发布页？自定义站点会被清除。')) return;
  clearingCustom.value = true;
  error.value = '';
  try {
    await clearDataAppCustomSite(props.app.id);
    customSite.value = { bound: false, updatedAt: null, note: '', bytes: 0 };
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '清除自定义站点失败。';
  } finally {
    clearingCustom.value = false;
  }
}
function openCreate() {
  editing.value = null;
  form.value = Object.fromEntries(columns.value.map((column) => [column.id, '']));
  formOpen.value = true;
}
function openEdit(record: DataRecord) {
  editing.value = record;
  form.value = Object.fromEntries(columns.value.map((column) => [column.id, record.values[column.id] || '']));
  formOpen.value = true;
}
async function save() {
  saving.value = true; error.value = '';
  try {
    detail.value = editing.value
      ? await updateDataAppRecord(props.app.id, editing.value.id, form.value)
      : await createDataAppRecord(props.app.id, form.value);
    formOpen.value = false;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败。'; }
  finally { saving.value = false; }
}
async function remove(record: DataRecord) {
  if (!window.confirm('确认删除这条记录？删除后不可恢复。')) return;
  deletingId.value = record.id;
  error.value = '';
  try {
    detail.value = await deleteDataAppRecord(props.app.id, record.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除失败。';
  } finally {
    deletingId.value = '';
  }
}
async function publish() {
  publishing.value = true; error.value = '';
  try {
    const result = await publishDataApp(props.app.id);
    publishUrl.value = result.url;
    localUrl.value = result.localUrl;
    lanUrls.value = result.lanUrls;
    await refreshQr();
    await openExternalBestEffort(result.localUrl || result.url);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '本机发布失败。'; }
  finally { publishing.value = false; }
}
async function openPublishUrl(url = desktopUrl.value) {
  if (!url) return;
  await openExternalBestEffort(url);
}
async function copyPublishUrl(url = primaryUrl.value) {
  if (!url) return;
  await navigator.clipboard?.writeText(url).catch(() => undefined);
}
let searchTimer: number | undefined;
watch(search, () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(load, 260); });
onMounted(() => {
  void load();
  void loadPublish();
  publishPoll = window.setInterval(() => {
    if ((publishUrl.value || localUrl.value) && !customSite.value.bound) void loadPublish();
  }, 4_000);
});
onBeforeUnmount(() => { if (publishPoll) window.clearInterval(publishPoll); });
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto p-7">
    <div class="mx-auto max-w-6xl">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <button class="text-sm font-semibold text-[var(--accent)] hover:underline" type="button" @click="emit('close')">← 返回数据工作台</button>
          <div class="mt-4 flex items-center gap-2">
            <span class="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-extrabold text-emerald-700">本机部署</span>
            <span class="text-xs text-[var(--muted)]">局域网可扫码访问</span>
          </div>
          <h2 class="mt-3 text-3xl font-bold tracking-[-.04em]">{{ title }}</h2>
          <p class="mt-2 text-sm text-[var(--muted)]">{{ detail?.table.name || '数据表' }} · {{ detail?.table.rowCount ?? 0 }} 条记录</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--surface-muted)]" type="button" :disabled="publishing" @click="publish">{{ publishing ? '发布中…' : (primaryUrl ? '重新发布' : '本机部署') }}</button>
          <button class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90" type="button" @click="openCreate">新增记录</button>
        </div>
      </div>

      <div v-if="error" class="mt-5 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">{{ error }}</div>

      <div v-if="primaryUrl" class="mt-5 rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
        <div class="flex flex-wrap items-start gap-4">
          <img v-if="qrSrc" :src="qrSrc" alt="局域网访问二维码" class="h-28 w-28 rounded-xl bg-white p-2 shadow-sm" />
          <div class="min-w-0 flex-1">
            <b>本机已部署 · 局域网可见</b>
            <p class="mt-2 text-xs leading-5">
              {{ customSite.bound ? `当前为定制站点（${customSite.note || 'agent'}）` : '使用模板站；定制站绑定后会自动刷新。' }}
            </p>
            <p v-if="lanUrls[0]" class="mt-2 break-all text-xs font-semibold">局域网：{{ lanUrls[0] }}</p>
            <p v-if="localUrl" class="mt-1 break-all text-xs opacity-80">本机：{{ localUrl }}</p>
            <p v-if="!lanUrls.length" class="mt-2 text-xs text-amber-800">未检测到局域网 IP。请确认 API 已绑定 0.0.0.0，且电脑连上 Wi‑Fi。</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button class="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold" type="button" @click="openPublishUrl()">打开网站</button>
              <button class="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold" type="button" @click="copyPublishUrl()">复制链接</button>
              <button class="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold disabled:opacity-50" type="button" :disabled="refreshingPublish" @click="refreshPublishStatus">{{ refreshingPublish ? '刷新中…' : '刷新' }}</button>
              <button class="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold" type="button" @click="revisionsOpen = !revisionsOpen">版本历史 · {{ revisions.length }}</button>
              <button
                v-if="customSite.bound"
                class="rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50"
                type="button"
                :disabled="clearingCustom"
                @click="clearCustomSite"
              >
                {{ clearingCustom ? '恢复中…' : '恢复默认页' }}
              </button>
            </div>
          </div>
        </div>
        <div v-if="revisionsOpen" class="mt-4 border-t border-emerald-200 pt-3"><div v-if="!revisions.length" class="text-xs opacity-75">下一次绑定定制页面后会生成首个版本。</div><div v-for="revision in revisions" :key="revision.id" class="flex items-center justify-between gap-3 border-b border-emerald-200 py-2 last:border-0"><div><b class="text-xs">{{ revision.note || '站点版本' }}</b><p class="mt-1 text-[10px] opacity-70">{{ new Date(revision.createdAt).toLocaleString() }} · {{ Math.ceil(revision.bytes / 1024) }} KB</p></div><button class="rounded-lg border border-emerald-300 bg-white px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50" type="button" :disabled="restoringId === revision.id" @click="restoreRevision(revision)">{{ restoringId === revision.id ? '回退中…' : '回退' }}</button></div></div>
      </div>

      <section class="mt-7 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4">
          <div>
            <h3 class="font-bold">{{ detail?.table.name || '数据记录' }}</h3>
            <p class="mt-1 text-xs text-[var(--muted)]">右侧固定操作列：编辑 / 删除。</p>
          </div>
          <input v-model="search" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] sm:w-64" placeholder="搜索所有字段…" />
        </div>
        <div class="overflow-auto">
          <table class="min-w-full text-left text-sm">
            <thead class="bg-[var(--surface-muted)] text-xs text-[var(--muted)]">
              <tr>
                <th v-for="column in columns" :key="column.id" class="whitespace-nowrap px-4 py-3 font-semibold">{{ column.name }}</th>
                <th class="sticky right-0 z-[1] w-[120px] bg-[var(--surface-muted)] px-4 py-3 text-right font-semibold shadow-[-8px_0_12px_rgba(0,0,0,.04)]">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading"><td :colspan="columns.length + 1" class="px-4 py-10 text-center text-sm text-[var(--muted)]">正在读取数据…</td></tr>
              <tr v-else-if="!records.length"><td :colspan="columns.length + 1" class="px-4 py-10 text-center text-sm text-[var(--muted)]">没有匹配记录。你可以新增第一条数据。</td></tr>
              <tr v-for="record in records" v-else :key="record.id" class="border-t border-[var(--border)] hover:bg-[var(--surface-muted)]">
                <td v-for="column in columns" :key="column.id" class="max-w-[240px] truncate px-4 py-3" :title="record.values[column.id] || ''">{{ record.values[column.id] || '—' }}</td>
                <td class="sticky right-0 bg-[var(--surface)] px-4 py-3 text-right shadow-[-8px_0_12px_rgba(0,0,0,.04)]">
                  <div class="inline-flex items-center gap-2">
                    <button class="text-xs font-semibold text-[var(--accent)] hover:underline" type="button" @click="openEdit(record)">编辑</button>
                    <button class="text-xs font-semibold text-rose-600 hover:underline disabled:opacity-50" type="button" :disabled="deletingId === record.id" @click="remove(record)">
                      {{ deletingId === record.id ? '删除中…' : '删除' }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <div v-if="formOpen" class="fixed inset-0 z-20 grid place-items-center bg-slate-950/30 p-5 backdrop-blur-[1px]">
      <form class="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl" @submit.prevent="save">
        <button class="float-right text-lg text-[var(--muted)]" type="button" @click="formOpen = false">×</button>
        <h3 class="text-xl font-bold">{{ editing ? '编辑记录' : '新增记录' }}</h3>
        <div class="mt-5 space-y-3">
          <label v-for="column in columns" :key="column.id" class="block">
            <span class="mb-1.5 block text-xs font-semibold">{{ column.name }}</span>
            <input v-model="form[column.id]" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" />
          </label>
        </div>
        <div class="mt-6 flex justify-end gap-2">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="formOpen = false">取消</button>
          <button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>
