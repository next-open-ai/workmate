<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  archivedAssetContentUrl,
  createSqliteDataSource,
  createApiDataSource,
  createMobileDataUploadSession,
  createDataApp,
  customizeDataApp,
  deleteDataApp,
  deleteDataSource,
  getDataSource,
  getDataApp,
  getDataTableRows,
  importDataFile,
  listDataApps,
  listDataSources,
  optimizeDataApp,
  renameDataSource,
  syncDataSource,
  updateApiDataSource,
  updateDataTableSchema,
  type DataApp,
  type DataAppDetail,
  type DataSource,
  type DataTable,
} from '../../services/api';
import { qrDataUrl } from '../../app/qr-data-url.js';
import { openExternalBestEffort } from '../../app/platform-actions';
import DataAppOperator from './DataAppOperator.vue';

type AppType = '管理后台' | '数据看板' | '查询网站';
type CreateMode = 'template' | 'idea';
type SourceCategory = 'all' | 'files' | 'sqlite' | 'mysql' | 'other';

const emit = defineEmits<{ startChat: []; startCustomize: [prompt: string] }>();
const sources = ref<DataSource[]>([]);
const selected = ref<DataSource | null>(null);
const selectedTable = ref<DataTable | null>(null);
const preview = ref<{ columns: string[]; rows: string[][] }>({ columns: [], rows: [] });
const loading = ref(false);
const importing = ref(false);
const uploadStage = ref<'idle' | 'selecting' | 'reading' | 'sending' | 'processing' | 'done'>('idle');
const uploadProgress = ref(0);
const error = ref('');
const notice = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const activeApp = ref<DataAppDetail | null>(null);
const sourceApps = ref<DataApp[]>([]);
const deletingId = ref('');
const deletingSourceId = ref('');
const renameOpen = ref(false);
const renameBusy = ref(false);
const renameDraft = ref('');
const renameTarget = ref<DataSource | null>(null);
const optimizeApp = ref<DataApp | null>(null);
const optimizeIdea = ref('');
const optimizeBusy = ref(false);
const activeCategory = ref<SourceCategory>('all');
const importKind = ref<'files' | 'sqlite'>('files');
const createSqliteOpen = ref(false);
const sqliteName = ref('业务数据库');
const apiEditorOpen = ref(false);
const apiEditorBusy = ref(false);
const apiSyncBusy = ref(false);
const apiEditingId = ref('');
const apiForm = ref({
  name: 'API 数据源',
  baseUrl: 'https://',
  path: '/',
  method: 'GET' as 'GET' | 'POST',
  authType: 'none' as 'none' | 'bearer' | 'header',
  authHeaderName: 'Authorization',
  authToken: '',
  itemsPath: '',
  description: '',
  requestBody: '{\n  \n}',
  responseBody: '{\n  \n}',
  syncNow: true,
});
const schemaEditing = ref(false);
const schemaSaving = ref(false);
const schemaDraft = ref<DataTable | null>(null);
const mobileUploadOpen = ref(false);
const mobileUploadBusy = ref(false);
const mobileUploadUrl = ref('');
const mobileUploadQr = ref('');
const mobileUploadExpiresAt = ref(0);

const createOpen = ref(false);
const createMode = ref<CreateMode>('template');
const appType = ref<AppType>('管理后台');
const appName = ref('');
const customizeIdea = ref('');
const createBusy = ref(false);

const qrByApp = ref<Record<string, string>>({});
const navigator = window.navigator;

const hasSources = computed(() => sources.value.length > 0);
const summary = computed(() => selected.value ? `${selected.value.tableCount} 张表 · ${selected.value.rowCount.toLocaleString()} 条` : '');
function categoryOf(source: DataSource): Exclude<SourceCategory, 'all'> {
  if (source.fileType === 'Excel' || source.fileType === 'CSV') return 'files';
  if (source.fileType === 'SQLite') return 'sqlite';
  if (source.fileType === 'MySQL') return 'mysql';
  if (source.fileType === 'API') return 'other';
  return 'other';
}
function isSpreadsheetSource(source: DataSource | null | undefined) {
  return Boolean(source && (source.fileType === 'Excel' || source.fileType === 'CSV'));
}
function isApiSource(source: DataSource | null | undefined) {
  return Boolean(source && source.fileType === 'API');
}
function canDeleteSource(source: DataSource | null | undefined) {
  if (!source || source.isDefault) return false;
  return source.fileType === 'Excel' || source.fileType === 'CSV' || source.fileType === 'SQLite' || source.fileType === 'API';
}
function canEditSource(source: DataSource | null | undefined) {
  return isSpreadsheetSource(source) || isApiSource(source);
}
const filteredSources = computed(() => activeCategory.value === 'all' ? sources.value : sources.value.filter((source) => categoryOf(source) === activeCategory.value));
const categoryCount = (category: SourceCategory) => category === 'all' ? sources.value.length : sources.value.filter((source) => categoryOf(source) === category).length;
const acceptedFiles = computed(() => importKind.value === 'sqlite' ? '.sqlite,.sqlite3,.db' : '.xlsx,.csv');

function friendlyError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : '数据加载失败。';
  if (message.includes('Route GET:/api/data/sources not found')) {
    return '数据工作台服务尚未加载。请重启本地开发服务后再试。';
  }
  return message;
}
const uploadStatus = computed(() => ({
  idle: '',
  selecting: '正在等待你选择文件…',
  reading: '正在读取文件内容…',
  sending: '正在安全上传到本机…',
  processing: '正在识别工作表、字段和样例数据…',
  done: '数据已准备好。',
}[uploadStage.value] || ''));

async function refreshQrMap(apps: DataApp[]) {
  const next: Record<string, string> = {};
  await Promise.all(apps.map(async (app) => {
    const target = app.lanUrl || app.lanUrls?.[0] || app.publishUrl;
    if (!target) return;
    try { next[app.id] = await qrDataUrl(target, 112); } catch { /* ignore */ }
  }));
  qrByApp.value = next;
}

async function load() {
  loading.value = true; error.value = '';
  try {
    sources.value = await listDataSources();
    if (selected.value) await chooseSource(selected.value.id);
  } catch (cause) { error.value = friendlyError(cause); }
  finally { loading.value = false; }
}
async function chooseSource(id: string) {
  error.value = ''; preview.value = { columns: [], rows: [] };
  try {
    selected.value = await getDataSource(id);
    sourceApps.value = await listDataApps(id);
    selectedTable.value = selected.value.tables?.[0] || null;
    if (selectedTable.value) await chooseTable(selectedTable.value);
    await refreshQrMap(sourceApps.value);
  } catch (cause) { error.value = friendlyError(cause); }
}
async function openExistingApp(app: DataApp) {
  error.value = '';
  try { activeApp.value = await getDataApp(app.id); }
  catch (cause) { error.value = friendlyError(cause); }
}
async function openPublishedApp(app: DataApp) {
  // Desktop opens the loopback URL; LAN URLs are for QR/share targets.
  const url = app.publishUrl || app.lanUrl;
  if (url) await openExternalBestEffort(url);
}
async function chooseTable(table: DataTable) {
  if (!selected.value) return;
  selectedTable.value = table;
  try { preview.value = await getDataTableRows(selected.value.id, table.id); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '无法读取样例数据。'; }
}
function editSchema() {
  if (!selectedTable.value) return;
  schemaDraft.value = JSON.parse(JSON.stringify(selectedTable.value)) as DataTable;
  schemaEditing.value = true;
}
async function saveSchema() {
  if (!selected.value || !schemaDraft.value) return;
  schemaSaving.value = true; error.value = '';
  try {
    selected.value = await updateDataTableSchema(selected.value.id, schemaDraft.value);
    selectedTable.value = selected.value.tables?.find((table) => table.id === schemaDraft.value?.id) || null;
    if (selectedTable.value) await chooseTable(selectedTable.value);
    schemaEditing.value = false; notice.value = 'Schema 已更新，字段标识和底层数据保持不变。';
  } catch (cause) { error.value = friendlyError(cause); }
  finally { schemaSaving.value = false; }
}
async function createSqlite() {
  if (!sqliteName.value.trim()) return;
  importing.value = true; error.value = '';
  try {
    const source = await createSqliteDataSource(sqliteName.value.trim());
    createSqliteOpen.value = false; await load(); await chooseSource(source.id);
    notice.value = `已创建「${source.name}」，可以编辑 Schema 后开始录入数据。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { importing.value = false; }
}
async function openMobileUpload() {
  mobileUploadBusy.value = true; error.value = '';
  try {
    const session = await createMobileDataUploadSession();
    mobileUploadUrl.value = session.lanUrls[0] || session.url;
    mobileUploadExpiresAt.value = session.expiresAt;
    mobileUploadQr.value = await qrDataUrl(mobileUploadUrl.value, 220);
    mobileUploadOpen.value = true;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { mobileUploadBusy.value = false; }
}
function openPicker(kind: 'files' | 'sqlite' = 'files') {
  importKind.value = kind;
  uploadStage.value = 'selecting'; uploadProgress.value = 4;
  fileInput.value?.click();
  window.addEventListener('focus', () => window.setTimeout(() => {
    if (uploadStage.value === 'selecting') { uploadStage.value = 'idle'; uploadProgress.value = 0; }
  }, 260), { once: true });
}
function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败。'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  error.value = ''; notice.value = '';
  const valid = importKind.value === 'sqlite' ? /\.(sqlite|sqlite3|db)$/i.test(file.name) : /\.(xlsx|csv)$/i.test(file.name);
  if (!valid) { error.value = importKind.value === 'sqlite' ? '请选择 SQLite (.sqlite/.sqlite3/.db) 数据库。' : '请选择 Excel (.xlsx) 或 CSV 文件。'; uploadStage.value = 'idle'; return; }
  if (file.size > 8 * 1024 * 1024) { error.value = '首期仅支持 8 MB 以内的数据文件。'; uploadStage.value = 'idle'; return; }
  importing.value = true;
  try {
    uploadStage.value = 'reading'; uploadProgress.value = 22;
    const contentBase64 = await fileToBase64(file);
    uploadStage.value = 'sending'; uploadProgress.value = 52;
    uploadStage.value = 'processing'; uploadProgress.value = 78;
    const source = await importDataFile({ name: file.name, contentBase64 });
    uploadStage.value = 'done'; uploadProgress.value = 100;
    await load(); await chooseSource(source.id);
    notice.value = `已读懂「${source.name}」，发现 ${source.tableCount} 张数据表。`;
    window.setTimeout(() => { if (uploadStage.value === 'done') { uploadStage.value = 'idle'; uploadProgress.value = 0; } }, 1400);
  } catch (cause) { error.value = friendlyError(cause); uploadStage.value = 'idle'; uploadProgress.value = 0; }
  finally { importing.value = false; (event.target as HTMLInputElement).value = ''; }
}
function openAsset() { if (selected.value?.assetId) window.open(archivedAssetContentUrl(selected.value.assetId), '_blank', 'noopener'); }
function openCreateApi() {
  apiEditingId.value = '';
  apiForm.value = {
    name: 'API 数据源',
    baseUrl: 'https://',
    path: '/',
    method: 'GET',
    authType: 'none',
    authHeaderName: 'Authorization',
    authToken: '',
    itemsPath: '',
    description: '',
    requestBody: '{\n  \n}',
    responseBody: '{\n  \n}',
    syncNow: true,
  };
  apiEditorOpen.value = true;
  error.value = '';
}
function openEditApi(source: DataSource, event?: Event) {
  event?.stopPropagation();
  if (!isApiSource(source)) return;
  apiEditingId.value = source.id;
  apiForm.value = {
    name: source.name,
    baseUrl: source.api?.baseUrl || 'https://',
    path: source.api?.path || '/',
    method: source.api?.method === 'POST' ? 'POST' : 'GET',
    authType: source.api?.authType || 'none',
    authHeaderName: source.api?.authHeaderName || 'Authorization',
    authToken: '',
    itemsPath: source.api?.itemsPath || '',
    description: source.api?.description || '',
    requestBody: source.api?.requestBody || '{\n  \n}',
    responseBody: source.api?.responseBody || '{\n  \n}',
    syncNow: false,
  };
  apiEditorOpen.value = true;
  error.value = '';
}
async function saveApiSource() {
  if (!apiForm.value.name.trim() || !apiForm.value.baseUrl.trim()) return;
  apiEditorBusy.value = true; error.value = '';
  try {
    const payload = {
      name: apiForm.value.name.trim(),
      baseUrl: apiForm.value.baseUrl.trim(),
      path: apiForm.value.path.trim() || '/',
      method: apiForm.value.method,
      authType: apiForm.value.authType,
      authHeaderName: apiForm.value.authHeaderName.trim() || undefined,
      ...(apiForm.value.authToken.trim() || !apiEditingId.value ? { authToken: apiForm.value.authToken.trim() } : {}),
      itemsPath: apiForm.value.itemsPath.trim(),
      description: apiForm.value.description.trim(),
      requestBody: apiForm.value.requestBody.trim() === '{\n  \n}' ? '' : apiForm.value.requestBody.trim(),
      responseBody: apiForm.value.responseBody.trim() === '{\n  \n}' ? '' : apiForm.value.responseBody.trim(),
      syncNow: apiForm.value.syncNow,
    };
    const source = apiEditingId.value
      ? await updateApiDataSource(apiEditingId.value, payload)
      : await createApiDataSource(payload);
    apiEditorOpen.value = false;
    await load();
    await chooseSource(source.id);
    notice.value = source.syncError
      ? `已保存「${source.name}」，但同步失败：${source.syncError}`
      : `已${apiEditingId.value ? '更新' : '创建'}「${source.name}」。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { apiEditorBusy.value = false; }
}
async function syncSelectedApi() {
  if (!selected.value || !isApiSource(selected.value)) return;
  apiSyncBusy.value = true; error.value = '';
  try {
    selected.value = await syncDataSource(selected.value.id);
    sources.value = sources.value.map((item) => item.id === selected.value?.id ? { ...item, ...selected.value, tables: undefined } : item);
    selectedTable.value = selected.value.tables?.[0] || null;
    if (selectedTable.value) await chooseTable(selectedTable.value);
    notice.value = `已同步「${selected.value.name}」· ${selected.value.rowCount.toLocaleString()} 条。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { apiSyncBusy.value = false; }
}
function openEditSource(source: DataSource, event?: Event) {
  if (isApiSource(source)) openEditApi(source, event);
  else openRenameSource(source, event);
}
function showCatalog(category: SourceCategory = 'all') { activeCategory.value = category; selected.value = null; selectedTable.value = null; sourceApps.value = []; }

function openCreateWebsite() {
  if (!selectedTable.value) return;
  createMode.value = 'template';
  appType.value = '管理后台';
  appName.value = `${selectedTable.value.name}网站`;
  customizeIdea.value = '';
  createOpen.value = true;
}

watch(createMode, (mode) => {
  if (!selectedTable.value) return;
  if (mode === 'template' && !appName.value) appName.value = `${selectedTable.value.name}网站`;
  if (mode === 'idea' && !appName.value) appName.value = `${selectedTable.value.name}定制站`;
});

async function submitCreate() {
  if (!selected.value || !selectedTable.value) return;
  createBusy.value = true; error.value = '';
  try {
    if (createMode.value === 'template') {
      activeApp.value = await createDataApp({
        sourceId: selected.value.id,
        tableId: selectedTable.value.id,
        appType: appType.value,
        name: appName.value,
      });
      // Creation already provisions an idempotent publish token. Refresh the
      // source list to obtain local/LAN URLs without rotating that token.
      sourceApps.value = await listDataApps(selected.value.id);
      await refreshQrMap(sourceApps.value);
      createOpen.value = false;
      notice.value = `已创建「${activeApp.value.name}」，本机站点已就绪。`;
    } else {
      const idea = customizeIdea.value.trim();
      if (!idea) { error.value = '请先描述你想要的网站想法。'; return; }
      const result = await customizeDataApp({
        sourceId: selected.value.id,
        tableId: selectedTable.value.id,
        idea,
        name: appName.value || undefined,
        appType: appType.value,
      });
      activeApp.value = result.app;
      sourceApps.value = await listDataApps(selected.value.id);
      await refreshQrMap(sourceApps.value);
      createOpen.value = false;
      notice.value = `已创建「${result.app.name}」。正在打开对话，让 Agent 按想法编程…`;
      emit('startCustomize', result.prompt);
    }
  } catch (cause) { error.value = friendlyError(cause); }
  finally { createBusy.value = false; }
}

async function removeApp(app: DataApp) {
  if (!window.confirm(`确定删除应用「${app.name}」？站点链接将失效，底层数据表仍保留。`)) return;
  deletingId.value = app.id; error.value = '';
  try {
    await deleteDataApp(app.id);
    if (activeApp.value?.id === app.id) activeApp.value = null;
    if (selected.value) {
      sourceApps.value = await listDataApps(selected.value.id);
      await refreshQrMap(sourceApps.value);
    }
    notice.value = `已删除「${app.name}」。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { deletingId.value = ''; }
}
function openRenameSource(source: DataSource, event?: Event) {
  event?.stopPropagation();
  if (!isSpreadsheetSource(source)) return;
  renameTarget.value = source;
  renameDraft.value = source.name.replace(/\.(xlsx|csv)$/i, '');
  renameOpen.value = true;
  error.value = '';
}
async function saveRenameSource() {
  if (!renameTarget.value || !renameDraft.value.trim()) return;
  renameBusy.value = true; error.value = '';
  try {
    const updated = await renameDataSource(renameTarget.value.id, renameDraft.value.trim());
    sources.value = sources.value.map((item) => item.id === updated.id ? { ...item, name: updated.name } : item);
    if (selected.value?.id === updated.id) selected.value = { ...selected.value, name: updated.name };
    renameOpen.value = false;
    renameTarget.value = null;
    notice.value = `已重命名为「${updated.name}」。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { renameBusy.value = false; }
}
async function removeSource(source: DataSource, event?: Event) {
  event?.stopPropagation();
  if (!canDeleteSource(source)) return;
  if (!window.confirm(`确定删除「${source.name}」？关联的网站应用会一并删除，资产库中的原文件仍保留。`)) return;
  deletingSourceId.value = source.id; error.value = '';
  try {
    await deleteDataSource(source.id);
    sources.value = sources.value.filter((item) => item.id !== source.id);
    if (selected.value?.id === source.id) {
      selected.value = null;
      selectedTable.value = null;
      sourceApps.value = [];
      preview.value = { columns: [], rows: [] };
      activeApp.value = null;
    }
    notice.value = `已删除「${source.name}」。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { deletingSourceId.value = ''; }
}
async function submitOptimize() {
  if (!optimizeApp.value || !optimizeIdea.value.trim()) return;
  optimizeBusy.value = true; error.value = '';
  try {
    const result = await optimizeDataApp(optimizeApp.value.id, optimizeIdea.value.trim());
    optimizeApp.value = null; optimizeIdea.value = '';
    emit('startCustomize', result.prompt);
  } catch (cause) { error.value = friendlyError(cause); }
  finally { optimizeBusy.value = false; }
}

onMounted(load);
</script>

<template>
  <section class="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)]">
    <header class="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border)] px-8 py-6">
      <div>
        <p class="text-xs font-bold tracking-[.14em] text-[var(--accent)]">WORKMATE / DATA</p>
        <h1 class="mt-2 text-3xl font-bold tracking-[-.045em]">数据工作台</h1>
        <p class="mt-2 text-sm text-[var(--muted)]">统一管理文件与本地数据库，再用真实数据创建网站和工作台。</p>
      </div>
      <div class="flex items-center gap-2">
        <button class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
        <input ref="fileInput" class="hidden" type="file" :accept="acceptedFiles" @change="upload" />
      </div>
    </header>

    <div v-if="error || notice" class="mx-8 mt-4 rounded-xl border px-4 py-3 text-sm" :class="error ? 'border-rose-300 bg-rose-50 text-rose-700' : 'border-emerald-300 bg-emerald-50 text-emerald-700'">
      {{ error || notice }}
    </div>

    <div v-if="uploadStage !== 'idle'" class="mx-8 mt-4 rounded-2xl border border-[var(--accent)]/25 bg-[var(--surface)] p-4 shadow-sm" aria-live="polite">
      <div class="flex items-center justify-between gap-4">
        <p class="text-sm font-bold">{{ uploadStatus }}</p>
        <span class="text-xs font-semibold text-[var(--accent)]">{{ uploadProgress }}%</span>
      </div>
      <div class="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div class="h-full rounded-full bg-[var(--accent)] transition-all duration-500" :style="{ width: `${uploadProgress}%` }" />
      </div>
    </div>

    <div v-if="!activeApp && !selected" class="px-8 pt-5">
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <button v-for="item in [{ id: 'all', icon: '◫', title: '全部数据', note: '统一数据目录' }, { id: 'files', icon: 'X', title: 'Excel / CSV', note: '表格与清单' }, { id: 'sqlite', icon: '▤', title: '本地 SQLite', note: '数据库文件' }, { id: 'mysql', icon: '◎', title: 'MySQL', note: '连接器规划中' }, { id: 'other', icon: '⌁', title: 'API 数据源', note: 'REST JSON 连接器' }]" :key="item.id" class="rounded-2xl border bg-[var(--surface)] p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md" :class="activeCategory === item.id ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/10' : 'border-[var(--border)]'" type="button" @click="activeCategory = item.id as SourceCategory">
          <div class="flex items-start justify-between gap-3"><span class="grid h-9 w-9 place-items-center rounded-xl bg-[var(--accent-soft)] text-sm font-black text-[var(--accent)]">{{ item.icon }}</span><span v-if="item.id === 'mysql'" class="rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[9px] font-bold text-[var(--muted)]">即将支持</span><b v-else class="text-xl">{{ categoryCount(item.id as SourceCategory) }}</b></div>
          <p class="mt-3 text-sm font-bold">{{ item.title }}</p><p class="mt-1 text-xs text-[var(--muted)]">{{ item.note }}</p>
        </button>
      </div>
    </div>

    <DataAppOperator v-if="activeApp" :app="activeApp" @close="activeApp = null" />

    <div v-else-if="loading && !hasSources" class="grid flex-1 place-items-center p-8 text-sm text-[var(--muted)]">正在连接数据工作台…</div>
    <div v-else-if="!hasSources" class="grid flex-1 place-items-center p-8">
      <div class="max-w-xl text-center">
        <h2 class="text-2xl font-bold">建立你的数据目录</h2>
        <p class="mx-auto mt-3 text-sm leading-6 text-[var(--muted)]">导入 Excel / CSV，或添加本地 SQLite 数据库。原文件保留在资产库，业务表安全复制到独立的数据工作台。</p>
        <div class="mt-7 flex justify-center gap-2"><button class="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white" type="button" @click="openPicker('files')">上传 Excel / CSV</button><button class="rounded-xl border border-[var(--border)] px-5 py-2.5 text-sm font-semibold" type="button" @click="openPicker('sqlite')">打开 SQLite</button></div>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-hidden">

      <div v-if="selected" class="h-full min-h-0 overflow-y-auto p-7">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <button class="mb-2 text-xs font-bold text-[var(--accent)]" type="button" @click="showCatalog(activeCategory)">← 返回数据源目录</button>
            <h2 class="text-2xl font-bold tracking-[-.035em]">{{ selected.name }}</h2>
            <p class="mt-1 text-sm text-[var(--muted)]"><span class="mr-2 rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[10px] font-bold">{{ selected.fileType }}</span><span v-if="selected.isDefault" class="mr-2 rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-bold text-[var(--accent)]">默认</span>{{ summary }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="selected.assetId"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]"
              type="button"
              @click="openAsset"
            >
              原文件
            </button>
            <button
              v-if="isApiSource(selected)"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)] disabled:opacity-50"
              type="button"
              :disabled="apiSyncBusy"
              @click="syncSelectedApi"
            >
              {{ apiSyncBusy ? '同步中…' : '同步 API' }}
            </button>
            <button
              v-if="isSpreadsheetSource(selected)"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]"
              type="button"
              @click="openRenameSource(selected)"
            >
              编辑名称
            </button>
            <button
              v-if="isApiSource(selected)"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]"
              type="button"
              @click="openEditApi(selected)"
            >
              编辑连接
            </button>
            <button
              v-if="canDeleteSource(selected)"
              class="rounded-xl border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              type="button"
              :disabled="deletingSourceId === selected.id"
              @click="removeSource(selected)"
            >
              {{ deletingSourceId === selected.id ? '删除中…' : '删除' }}
            </button>
            <button
              class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              type="button"
              :disabled="!selectedTable"
              @click="openCreateWebsite"
            >
              创建网站应用
            </button>
          </div>
        </div>

        <section v-if="isApiSource(selected) && selected.api" class="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="font-bold">API 连接</h3>
              <p class="mt-1 text-xs text-[var(--muted)]">{{ selected.api.method }} · {{ selected.api.baseUrl }}{{ selected.api.path.startsWith('/') ? '' : '/' }}{{ selected.api.path }}</p>
            </div>
            <span
              class="rounded-full px-2 py-1 text-[10px] font-bold"
              :class="selected.api.lastStatus === 'ok' ? 'bg-emerald-100 text-emerald-700' : selected.api.lastStatus === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'"
            >
              {{ selected.api.lastStatus === 'ok' ? '同步成功' : selected.api.lastStatus === 'error' ? '同步失败' : '未同步' }}
            </span>
          </div>
          <p v-if="selected.api.description" class="mt-3 text-sm leading-6 text-[var(--muted)]">{{ selected.api.description }}</p>
          <p v-if="selected.api.itemsPath" class="mt-2 text-xs text-[var(--muted)]">itemsPath：{{ selected.api.itemsPath }}</p>
          <p v-if="selected.api.lastError" class="mt-2 text-xs text-rose-700">{{ selected.api.lastError }}</p>
          <p v-if="selected.api.lastSyncedAt" class="mt-2 text-xs text-[var(--muted)]">上次同步：{{ new Date(selected.api.lastSyncedAt).toLocaleString() }}</p>
          <div v-if="selected.api.requestBody || selected.api.responseBody" class="mt-4 grid gap-3 lg:grid-cols-2">
            <div v-if="selected.api.requestBody">
              <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">请求体</p>
              <pre class="mt-1 max-h-40 overflow-auto rounded-xl bg-[var(--surface-muted)] p-3 text-[11px] leading-4">{{ selected.api.requestBody }}</pre>
            </div>
            <div v-if="selected.api.responseBody">
              <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">返回体</p>
              <pre class="mt-1 max-h-40 overflow-auto rounded-xl bg-[var(--surface-muted)] p-3 text-[11px] leading-4">{{ selected.api.responseBody }}</pre>
            </div>
          </div>
        </section>

        <section class="mt-6">
          <div class="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 class="text-lg font-bold">网站应用</h3>
              <p class="mt-1 text-xs text-[var(--muted)]">本机部署，局域网可扫码打开。</p>
            </div>
            <span class="text-xs text-[var(--muted)]">{{ sourceApps.length }} 个</span>
          </div>

          <div v-if="!sourceApps.length" class="rounded-2xl border border-dashed border-[var(--border)] px-5 py-10 text-center">
            <p class="text-sm text-[var(--muted)]">还没有应用。点击「创建网站应用」，选择模板或按想法定制。</p>
          </div>

          <div v-else class="grid gap-4 lg:grid-cols-2">
            <article v-for="app in sourceApps" :key="app.id" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-bold">{{ app.name }}</p>
                  <p class="mt-1 text-xs text-[var(--muted)]">{{ app.appType }}</p>
                </div>
                <span
                  class="shrink-0 rounded-full px-2 py-1 text-[10px] font-bold"
                  :class="app.customSite?.bound ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'"
                >
                  {{ app.customSite?.bound ? '定制站' : '模板站' }}
                </span>
              </div>

              <div v-if="app.publishUrl || app.lanUrl" class="mt-4 flex items-start gap-3 rounded-xl bg-[var(--surface-muted)] p-3">
                <img v-if="qrByApp[app.id]" :src="qrByApp[app.id]" alt="站点二维码" class="h-20 w-20 rounded-lg bg-white p-1" />
                <div class="min-w-0 flex-1">
                  <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">局域网扫码</p>
                  <p class="mt-1 break-all text-[11px] leading-4 text-[var(--muted)]">{{ app.lanUrl || app.publishUrl }}</p>
                  <p v-if="!app.lanUrl" class="mt-1 text-[10px] text-amber-700">未检测到局域网 IP，可先用本机链接。</p>
                </div>
              </div>

              <div class="mt-4 flex flex-wrap gap-2">
                <button class="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white" type="button" @click="openPublishedApp(app)">打开站点</button>
                <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="openExistingApp(app)">管理数据</button>
                <button class="rounded-lg border border-teal-200 px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-50" type="button" @click="optimizeApp = app; optimizeIdea = ''">对话优化</button>
                <button
                  class="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                  type="button"
                  :disabled="deletingId === app.id"
                  @click="removeApp(app)"
                >
                  {{ deletingId === app.id ? '删除中…' : '删除' }}
                </button>
              </div>
            </article>
          </div>
        </section>

        <section v-if="selected.tables?.length" class="mt-8">
          <div class="flex items-center justify-between gap-3"><div><h3 class="font-bold">Schema 与数据表</h3><p class="mt-1 text-xs text-[var(--muted)]">字段 ID 用于网站与 API，保持稳定；显示名称和类型可以编辑。</p></div><button v-if="selectedTable" class="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="editSchema">编辑 Schema</button></div>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-for="table in selected.tables"
              :key="table.id"
              class="rounded-xl border px-3 py-2 text-sm font-semibold"
              :class="selectedTable?.id === table.id ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)] hover:bg-[var(--surface-muted)]'"
              type="button"
              @click="chooseTable(table)"
            >
              {{ table.name }} <span class="ml-1 text-xs opacity-70">{{ table.rowCount }}</span>
            </button>
          </div>
          <div v-if="selectedTable" class="mt-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <div class="grid grid-cols-[100px_minmax(160px,1fr)_120px_80px_minmax(120px,1fr)] gap-3 border-b border-[var(--border)] bg-[var(--surface-muted)] px-4 py-2 text-[10px] font-bold tracking-wide text-[var(--muted)]"><span>字段 ID</span><span>字段名称</span><span>类型</span><span>可空</span><span>样例</span></div>
            <div v-for="column in selectedTable.columns" :key="column.id" class="grid grid-cols-[100px_minmax(160px,1fr)_120px_80px_minmax(120px,1fr)] gap-3 border-b border-[var(--border)] px-4 py-2.5 text-xs last:border-0"><code class="text-[var(--accent)]">{{ column.id }}</code><b>{{ column.name }}</b><span>{{ column.type }}</span><span>{{ column.nullable ? '是' : '否' }}</span><span class="truncate text-[var(--muted)]">{{ column.sample }}</span></div>
          </div>
          <div v-if="selectedTable && preview.columns.length" class="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
            <div class="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)]">{{ selectedTable.name }} · 前 20 行</div>
            <div class="overflow-auto">
              <table class="min-w-full text-left text-xs">
                <thead class="bg-[var(--surface-muted)] text-[var(--muted)]">
                  <tr><th v-for="column in preview.columns" :key="column" class="whitespace-nowrap px-3 py-2 font-semibold">{{ column }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(row, index) in preview.rows" :key="index" class="border-t border-[var(--border)]">
                    <td v-for="(value, cell) in row" :key="cell" class="max-w-[200px] truncate px-3 py-2">{{ value }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
      <main v-else class="h-full min-h-0 overflow-y-auto px-8 py-7">
        <div class="flex flex-wrap items-end justify-between gap-4"><div><p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">DATA CATALOG</p><h2 class="mt-2 text-2xl font-bold">{{ activeCategory === 'all' ? '全部数据源' : activeCategory === 'files' ? 'Excel / CSV' : activeCategory === 'sqlite' ? '本地 SQLite' : activeCategory === 'mysql' ? 'MySQL' : 'API 数据源' }}</h2><p class="mt-2 text-sm text-[var(--muted)]">选择一份数据查看 Schema、预览记录并创建网站应用。</p></div><div class="flex gap-2"><template v-if="activeCategory === 'files'"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" :disabled="mobileUploadBusy" @click="openMobileUpload">{{ mobileUploadBusy ? '生成中…' : '手机上传' }}</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" type="button" @click="openPicker('files')">上传 Excel / CSV</button></template><template v-else-if="activeCategory === 'sqlite'"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="openPicker('sqlite')">打开数据库</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" type="button" @click="createSqliteOpen = true">新建数据库</button></template><template v-else-if="activeCategory === 'other'"><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" type="button" @click="openCreateApi">新建 API</button></template><button v-else-if="activeCategory === 'mysql'" class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white opacity-60" type="button" @click="notice = 'MySQL 安全连接器正在建设中，暂不保存数据库凭据。'">导入数据</button></div></div>
        <div v-if="filteredSources.length" class="mt-6 grid gap-3 xl:grid-cols-2">
          <article
            v-for="source in filteredSources"
            :key="source.id"
            class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition hover:border-[var(--accent)] hover:shadow-md"
          >
            <button class="w-full text-left" type="button" @click="chooseSource(source.id)">
              <div class="flex items-start justify-between gap-3">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-bold text-[var(--accent)]">{{ source.fileType }}</span>
                  <span v-if="source.isDefault" class="rounded-lg bg-[var(--surface-muted)] px-2 py-1 text-[10px] font-bold text-[var(--muted)]">默认</span>
                </div>
                <span class="text-xs text-[var(--muted)]">{{ new Date(source.createdAt).toLocaleDateString() }}</span>
              </div>
              <b class="mt-4 block truncate">{{ source.name }}</b>
              <p class="mt-2 text-xs text-[var(--muted)]">{{ source.tableCount }} 张表 · {{ source.rowCount.toLocaleString() }} 条记录</p>
              <p class="mt-3 line-clamp-2 text-xs leading-5 text-[var(--muted)]">{{ source.summary }}</p>
            </button>
            <div v-if="canEditSource(source) || canDeleteSource(source)" class="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
              <button
                v-if="canEditSource(source)"
                class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]"
                type="button"
                @click="openEditSource(source, $event)"
              >
                编辑
              </button>
              <button
                v-if="canDeleteSource(source)"
                class="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                type="button"
                :disabled="deletingSourceId === source.id"
                @click="removeSource(source, $event)"
              >
                {{ deletingSourceId === source.id ? '删除中…' : '删除' }}
              </button>
            </div>
          </article>
        </div>
        <div v-else class="mt-6 rounded-3xl border border-dashed border-[var(--border)] px-6 py-16 text-center"><p class="font-bold">此分类还没有数据源</p><p class="mt-2 text-sm text-[var(--muted)]">{{ activeCategory === 'mysql' ? '连接器正在规划中，当前可先使用 Excel / CSV、本地 SQLite 或 API。' : activeCategory === 'other' ? '点击右上方「新建 API」，接入返回 JSON 的 REST 接口。' : '点击右上方按钮添加第一份数据。' }}</p></div>
      </main>
    </div>

    <div v-if="mobileUploadOpen" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]"><section class="w-full max-w-lg rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-2xl"><button class="float-right text-lg text-[var(--muted)]" type="button" @click="mobileUploadOpen = false">×</button><p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">MOBILE UPLOAD</p><h2 class="mt-2 text-2xl font-bold">用手机上传 Excel / CSV</h2><p class="mt-2 text-sm leading-6 text-[var(--muted)]">手机和电脑连接同一局域网，扫码后选择文件。链接 30 分钟内有效。</p><img v-if="mobileUploadQr" :src="mobileUploadQr" alt="手机上传二维码" class="mx-auto mt-5 h-56 w-56 rounded-2xl border border-[var(--border)] bg-white p-3"><p class="mt-4 break-all rounded-xl bg-[var(--surface-muted)] p-3 text-left text-xs text-[var(--muted)]">{{ mobileUploadUrl }}</p><p class="mt-3 text-xs text-[var(--muted)]">有效期至 {{ new Date(mobileUploadExpiresAt).toLocaleTimeString() }}</p><div class="mt-5 flex justify-center gap-2"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="navigator.clipboard?.writeText(mobileUploadUrl)">复制链接</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" type="button" @click="mobileUploadOpen = false; load()">完成并刷新</button></div></section></div>

    <div v-if="optimizeApp" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]"><section class="w-full max-w-xl rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"><button class="float-right text-lg text-[var(--muted)]" type="button" @click="optimizeApp = null">×</button><p class="text-xs font-bold tracking-[.12em] text-teal-700">CONVERSATIONAL ITERATION</p><h2 class="mt-2 text-2xl font-bold">继续优化「{{ optimizeApp.name }}」</h2><p class="mt-2 text-sm leading-6 text-[var(--muted)]">Agent 会读取当前页面，在原应用上修改并生成新版本，不会创建重复站点。</p><textarea v-model="optimizeIdea" rows="5" class="mt-5 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-teal-600" placeholder="例如：增加按项目阶段筛选；金额用柱状图展示；移动端卡片更紧凑。" /><div class="mt-6 flex justify-end gap-2"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="optimizeApp = null">取消</button><button class="rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="optimizeBusy || !optimizeIdea.trim()" @click="submitOptimize">{{ optimizeBusy ? '准备中…' : '开始对话优化' }}</button></div></section></div>

    <div v-if="createSqliteOpen" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="w-full max-w-md rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"><button class="float-right text-lg text-[var(--muted)]" type="button" @click="createSqliteOpen = false">×</button><p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">NEW SQLITE</p><h2 class="mt-2 text-2xl font-bold">新建本地数据库</h2><p class="mt-2 text-sm leading-6 text-[var(--muted)]">创建独立数据库副本和默认 data 表，随后可以编辑 Schema 并通过网站应用录入数据。</p><label class="mt-5 block"><span class="mb-1.5 block text-xs font-semibold">数据库名称</span><input v-model="sqliteName" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" @keyup.enter="createSqlite" /></label><div class="mt-6 flex justify-end gap-2"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="createSqliteOpen = false">取消</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="importing || !sqliteName.trim()" @click="createSqlite">{{ importing ? '创建中…' : '创建数据库' }}</button></div></section>
    </div>

    <div v-if="apiEditorOpen" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <button class="float-right text-lg text-[var(--muted)]" type="button" @click="apiEditorOpen = false">×</button>
        <p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">API SOURCE</p>
        <h2 class="mt-2 text-2xl font-bold">{{ apiEditingId ? '编辑 API 数据源' : '新建 API 数据源' }}</h2>
        <p class="mt-2 text-sm leading-6 text-[var(--muted)]">接入返回 JSON 的 REST 接口，同步后可在工作台预览并创建网站应用。</p>
        <div class="mt-5 space-y-3">
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">名称</span><input v-model="apiForm.name" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" /></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">自然语言描述</span><textarea v-model="apiForm.description" rows="3" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" placeholder="例如：拉取订单列表，按创建时间倒序返回；用于生成订单看板。" /><span class="mt-1 block text-[11px] text-[var(--muted)]">用自然语言说明这个 API 做什么、适合哪些业务场景。</span></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">Base URL</span><input v-model="apiForm.baseUrl" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" placeholder="https://api.example.com" /></label>
          <div class="grid gap-3 sm:grid-cols-[110px_1fr]">
            <label class="block"><span class="mb-1.5 block text-xs font-semibold">方法</span><select v-model="apiForm.method" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm"><option value="GET">GET</option><option value="POST">POST</option></select></label>
            <label class="block"><span class="mb-1.5 block text-xs font-semibold">Path</span><input v-model="apiForm.path" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" placeholder="/v1/items" /></label>
          </div>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">itemsPath（可选）</span><input v-model="apiForm.itemsPath" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" placeholder="data.items" /><span class="mt-1 block text-[11px] text-[var(--muted)]">响应是数组可留空；对象内数组用点路径，如 data.list</span></label>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block"><span class="mb-1.5 block text-xs font-semibold">鉴权</span><select v-model="apiForm.authType" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm"><option value="none">无</option><option value="bearer">Bearer Token</option><option value="header">自定义 Header</option></select></label>
            <label class="block"><span class="mb-1.5 block text-xs font-semibold">Header 名</span><input v-model="apiForm.authHeaderName" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" :disabled="apiForm.authType === 'none'" /></label>
          </div>
          <label v-if="apiForm.authType !== 'none'" class="block"><span class="mb-1.5 block text-xs font-semibold">Token / Key{{ apiEditingId ? '（留空表示不修改）' : '' }}</span><input v-model="apiForm.authToken" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" type="password" autocomplete="off" /></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">请求体 JSON{{ apiForm.method === 'GET' ? '（文档用，GET 同步不发送）' : '' }}</span><textarea v-model="apiForm.requestBody" rows="6" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-xs outline-none focus:border-[var(--accent)]" placeholder='{"page":1,"size":20}' /><span class="mt-1 block text-[11px] text-[var(--muted)]">POST 同步时会按此请求体发送；也可用作 Agent 理解入参的样例。</span></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">返回体 JSON（样例 / 结构）</span><textarea v-model="apiForm.responseBody" rows="6" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-xs outline-none focus:border-[var(--accent)]" placeholder='{"data":{"items":[{"id":1,"name":"示例"}]}}' /><span class="mt-1 block text-[11px] text-[var(--muted)]">可手填期望返回结构；若为空，首次同步成功后会自动保存一份样例。</span></label>
          <label class="flex items-center gap-2 text-sm"><input v-model="apiForm.syncNow" type="checkbox" /><span>保存后立即同步</span></label>
        </div>
        <div class="mt-6 flex justify-end gap-2">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="apiEditorOpen = false">取消</button>
          <button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="apiEditorBusy || !apiForm.name.trim() || !apiForm.baseUrl.trim()" @click="saveApiSource">{{ apiEditorBusy ? '保存中…' : (apiEditingId ? '保存' : '创建') }}</button>
        </div>
      </section>
    </div>

    <div v-if="renameOpen && renameTarget" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="w-full max-w-md rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <button class="float-right text-lg text-[var(--muted)]" type="button" @click="renameOpen = false">×</button>
        <p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">EDIT SOURCE</p>
        <h2 class="mt-2 text-2xl font-bold">编辑数据源名称</h2>
        <p class="mt-2 text-sm leading-6 text-[var(--muted)]">仅修改数据工作台中的显示名称，不会改动资产库原文件。</p>
        <label class="mt-5 block">
          <span class="mb-1.5 block text-xs font-semibold">名称</span>
          <input
            v-model="renameDraft"
            class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
            @keyup.enter="saveRenameSource"
          />
        </label>
        <p class="mt-2 text-xs text-[var(--muted)]">保存后会保留 .{{ renameTarget.fileType === 'CSV' ? 'csv' : 'xlsx' }} 后缀。</p>
        <div class="mt-6 flex justify-end gap-2">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="renameOpen = false">取消</button>
          <button
            class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            type="button"
            :disabled="renameBusy || !renameDraft.trim()"
            @click="saveRenameSource"
          >
            {{ renameBusy ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="schemaEditing && schemaDraft" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"><button class="float-right text-lg text-[var(--muted)]" type="button" @click="schemaEditing = false">×</button><p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">SCHEMA EDITOR</p><h2 class="mt-2 text-2xl font-bold">编辑数据结构</h2><p class="mt-2 text-sm text-[var(--muted)]">仅调整工作台元数据；字段 ID 与原始归档文件不会改变。</p><label class="mt-5 block"><span class="mb-1.5 block text-xs font-semibold">数据表名称</span><input v-model="schemaDraft.name" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm" /></label><div class="mt-5 space-y-2"><div v-for="column in schemaDraft.columns" :key="column.id" class="grid grid-cols-[80px_minmax(150px,1fr)_130px_80px] items-center gap-2 rounded-xl border border-[var(--border)] p-3"><code class="text-xs text-[var(--accent)]">{{ column.id }}</code><input v-model="column.name" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-2 text-sm" /><select v-model="column.type" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-2 text-sm"><option v-for="type in ['文本', '整数', '小数', '日期', '布尔值']" :key="type">{{ type }}</option></select><label class="flex items-center gap-2 text-xs"><input v-model="column.nullable" type="checkbox" />可空</label></div></div><div class="mt-6 flex justify-end gap-2"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="schemaEditing = false">取消</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="schemaSaving" @click="saveSchema">{{ schemaSaving ? '保存中…' : '保存 Schema' }}</button></div></section>
    </div>

    <div v-if="createOpen && selected && selectedTable" class="absolute inset-0 z-20 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[1px]">
      <section class="w-full max-w-xl rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <button class="float-right text-lg text-[var(--muted)]" type="button" @click="createOpen = false">×</button>
        <p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">创建网站应用</p>
        <h2 class="mt-2 text-2xl font-bold">基于「{{ selectedTable.name }}」</h2>
        <p class="mt-2 text-sm text-[var(--muted)]">选择模板快速生成，或描述想法交给 Agent 定制。</p>

        <div class="mt-5 grid grid-cols-2 gap-2">
          <button
            class="rounded-xl border p-3 text-left"
            :class="createMode === 'template' ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'"
            type="button"
            @click="createMode = 'template'"
          >
            <b class="text-sm">快速模板</b>
            <p class="mt-1 text-xs text-[var(--muted)]">管理后台 / 看板 / 查询站</p>
          </button>
          <button
            class="rounded-xl border p-3 text-left"
            :class="createMode === 'idea' ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/40' : 'border-[var(--border)]'"
            type="button"
            @click="createMode = 'idea'"
          >
            <b class="text-sm">按想法定制</b>
            <p class="mt-1 text-xs text-[var(--muted)]">Agent 即时编程单页站</p>
          </button>
        </div>

        <div class="mt-4 grid gap-2 sm:grid-cols-3">
          <button
            v-for="type in ['管理后台', '数据看板', '查询网站'] as const"
            :key="type"
            class="rounded-xl border p-2.5 text-sm font-semibold"
            :class="appType === type ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)]'"
            type="button"
            @click="appType = type"
          >
            {{ type }}
          </button>
        </div>

        <label class="mt-4 block">
          <span class="mb-1.5 block text-xs font-semibold">应用名称</span>
          <input v-model="appName" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" />
        </label>

        <label v-if="createMode === 'idea'" class="mt-4 block">
          <span class="mb-1.5 block text-xs font-semibold">你的想法</span>
          <textarea
            v-model="customizeIdea"
            rows="4"
            class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-teal-600"
            placeholder="例如：报价里程碑看板，按阶段筛选，支持编辑删除，视觉干净专业。"
          />
        </label>

        <div class="mt-6 flex justify-end gap-2">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="createOpen = false">取消</button>
          <button
            class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            type="button"
            :disabled="createBusy || (createMode === 'idea' && !customizeIdea.trim())"
            @click="submitCreate"
          >
            {{ createBusy ? '处理中…' : createMode === 'idea' ? '开始定制' : '生成应用' }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
