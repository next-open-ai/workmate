<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import * as orch from "../../services/orchestration.js";
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import type { Employee, EmployeeId } from "../../app/workspace.js";
import {
  deliverableEntries,
  type ProjectFileEntry,
} from "../../app/project-files.js";
import type { Project } from "../../app/projects.js";
import type { AuthUser } from "../../services/auth.js";
import { employeeDisplayName } from "../../app/employees";
import { isDesktopShell } from "../../app/platform.js";
import { downloadAssetBestEffort } from "../../app/platform-actions.js";
import { readStored, writeStored } from "../../app/storage.js";
import { useTheme } from "../../app/theme.js";
import { exportWorkspaceZip, importWorkspaceZip, listWorkspaceFiles, materializeWorkspaceAssets, readWorkspaceFile, syncWorkspaceRun, writeWorkspaceFile } from "../../services/api.js";

const { resolvedTheme } = useTheme();
function monacoTheme() {
  return resolvedTheme.value === "light" ? "vs" : "vs-dark";
}

const props = defineProps<{
  project: Project;
  employees: Employee[];
  users: AuthUser[];
  currentUserId?: string;
  templateName: string;
  running: boolean;
  /** Incremented when a deliverable is published into the project workspace. */
  fileTreeEpoch?: number;
}>();
const emit = defineEmits<{
  back: [];
  start: [];
  cancel: [];
  remove: [];
  dispatch: [input: { employeeId: EmployeeId; content: string }];
  "add-member": [employeeId: EmployeeId];
  "remove-member": [employeeId: EmployeeId];
  approve: [input: { taskId: string; approvalId: string; allow: boolean; scope: "session" | "always" }];
}>();

const draft = ref("");
const desktopShell = isDesktopShell();
const pickerOpen = ref(false);
const mentionMenuOpen = ref(false);
const mentionActiveIndex = ref(0);
const selectedEmployeeId = ref<EmployeeId | null>(null);
const detailEmployeeId = ref<EmployeeId | null>(null);
const membersDockOpen = ref(false);
const addMemberOpen = ref(false);
const sending = ref(false);
const refreshing = ref(false);
const filesError = ref("");
type FileEntry = ProjectFileEntry;
const files = ref<FileEntry[]>([]);
const selectedFile = ref('');
const fileContent = ref('');
const workspaceZipInput = ref<HTMLInputElement>();
const importingZip = ref(false);
const exportingZip = ref(false);
const savingShare = ref(false);
const shareScope = ref<"private" | "org-shared" | "delegated">("private");
const sharePermissions = ref<Record<string, "read" | "write">>({});
const editorHost = ref<HTMLElement>();
const collapsedDirectories = ref(new Set<string>());
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const members = computed(() => {
  const ids = [...new Set(props.project.tasks.map((task) => task.employeeId))];
  return ids
    .map((id) => props.employees.find((employee) => employee.id === id))
    .filter(Boolean) as Employee[];
});
const candidateMembers = computed(() =>
  props.employees.filter((employee) => !members.value.some((item) => item.id === employee.id)),
);
const mentionQuery = computed(() => {
  const match = draft.value.match(/@([^\s]*)$/);
  return (match?.[1] ?? "").toLowerCase();
});
const availableMentionEmployees = computed(() => {
  const query = mentionQuery.value;
  return members.value.filter((employee) => {
    if (!query) return true;
    const name = employeeName(employee.id).toLowerCase();
    return name.includes(query) || employee.id.toLowerCase().includes(query);
  });
});
const selectedEmployee = computed(
  () =>
    members.value.find(
      (employee) => employee.id === selectedEmployeeId.value,
    ) ?? null,
);
const detailEmployee = computed(
  () =>
    members.value.find((employee) => employee.id === detailEmployeeId.value) ??
    null,
);
const hasPendingApproval = computed(
  () =>
    props.project.messages.some((message) => message.approvals?.length) ||
    props.project.tasks.some(
      (task) => task.status === "running" && /审批|approval/i.test(task.error ?? ""),
    ),
);
const detailTasks = computed(() =>
  props.project.tasks
    .filter((task) => task.employeeId === detailEmployeeId.value)
    .sort(
      (a, b) =>
        (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0),
    ),
);
const statusFor = (employeeId: EmployeeId) => {
  const tasks = props.project.tasks.filter(
    (task) => task.employeeId === employeeId && task.status !== "superseded",
  );
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "stale" || task.status === "queued" || task.status === "draft"))
    return tasks.some((task) => task.status === "stale") ? "stale" : "queued";
  if (tasks.length && tasks.every((task) => task.status === "completed"))
    return "completed";
  return "queued";
};
const statusText = (status: string) =>
  ({
    queued: "等待调度",
    running: "执行中",
    completed: "已完成",
    failed: "需要处理",
    cancelled: "已取消",
    stale: "待重跑",
    superseded: "已替代",
    draft: "草案",
  })[status] ?? status;
const statusClass = (status: string) =>
  ({
    queued: "bg-slate-500/10 text-slate-600",
    running: "workmate-running-pill",
    completed: "bg-emerald-500/10 text-emerald-600",
    failed: "bg-rose-500/10 text-rose-600",
    cancelled: "bg-amber-500/10 text-amber-700",
    stale: "bg-amber-500/10 text-amber-700",
    superseded: "bg-slate-500/10 text-slate-500",
    draft: "bg-slate-500/10 text-slate-600",
  })[status] ?? "bg-slate-500/10 text-slate-600";
const statusDotClass = (status: string) =>
  ({
    queued: "bg-slate-400",
    running: "animate-pulse bg-blue-500 ring-4 ring-blue-500/20",
    completed: "bg-emerald-500",
    failed: "bg-rose-500 ring-4 ring-rose-500/15",
    cancelled: "bg-amber-500",
    stale: "bg-amber-500",
    superseded: "bg-slate-300",
    draft: "bg-slate-400",
  })[status] ?? "bg-slate-400";
const employeeName = (id?: EmployeeId) => {
  const employee = props.employees.find((item) => item.id === id);
  return employeeDisplayName(employee, (key) => ({
    'employee.general.name': '通用助理',
    'employee.research.name': '研究助理',
    'employee.code.name': '编程助理',
    'employee.administrator.name': '系统管理员',
  } as Record<string, string>)[key] || key) || id || '';
};
const approvalLabel: Record<string, string> = {
  "workspace-write": "写入运行工作区",
  "script-execution": "执行本地脚本",
  "network-access": "访问网络资源",
};
function approve(input: { approvalId?: string; allow: boolean; scope: "session" | "always" }, taskId?: string) {
  if (!taskId || !input.approvalId) return;
  emit("approve", { taskId, approvalId: input.approvalId, allow: input.allow, scope: input.scope });
}
const date = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
const formatNumber = (value?: number) => new Intl.NumberFormat("zh-CN").format(Math.max(0, Number(value || 0)));
const totalAssets = computed(() =>
  props.project.messages.flatMap((message) => message.assets ?? []),
);
const shareableUsers = computed(() =>
  props.users.filter((user) => user.id !== (props.project.ownerUserId ?? props.currentUserId ?? "")),
);
const hasDelegatedUsers = computed(() => Object.keys(sharePermissions.value).length > 0);
const shareSummary = computed(() => {
  if (shareScope.value === "org-shared") return "同组织成员可读，owner/admin 可写";
  if (shareScope.value === "delegated") return hasDelegatedUsers.value
    ? `已委托 ${Object.keys(sharePermissions.value).length} 位用户`
    : "请选择至少一位委托用户";
  return "仅 owner 可读写";
});
const TREE_WIDTH_KEY = "workmate.project.tree-width";
const TREE_COLLAPSED_KEY = "workmate.project.tree-collapsed";
const treeWidth = ref(260);
const treeCollapsed = ref(false);
const resizingTree = ref(false);
const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 560;
const COLLAPSED_TREE_WIDTH = 44;

const deliverableFiles = computed(() => deliverableEntries(files.value));
const fileCount = computed(() => deliverableFiles.value.filter((entry) => entry.type === "file").length);
const visibleFiles = computed(() =>
  deliverableFiles.value.filter((entry) =>
    entry.relative
      .split("/")
      .slice(0, -1)
      .every((_, index, parts) => !collapsedDirectories.value.has(parts.slice(0, index + 1).join("/"))),
  ),
);
const editing = computed(() => Boolean(selectedFile.value));
const effectiveTreeWidth = computed(() => (treeCollapsed.value ? COLLAPSED_TREE_WIDTH : treeWidth.value));

function setTreeCollapsed(value: boolean) {
  treeCollapsed.value = value;
  void writeStored(TREE_COLLAPSED_KEY, value ? "1" : "0");
}

function startTreeResize(event: PointerEvent) {
  if (treeCollapsed.value) return;
  event.preventDefault();
  resizingTree.value = true;
  const originX = event.clientX;
  const originWidth = treeWidth.value;
  const onMove = (moveEvent: PointerEvent) => {
    treeWidth.value = Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, originWidth + (moveEvent.clientX - originX)));
  };
  const onUp = () => {
    resizingTree.value = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    void writeStored(TREE_WIDTH_KEY, String(treeWidth.value));
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function language(file: string) { if (/\.json$/i.test(file)) return 'json'; if (/\.(ts|tsx|js|jsx)$/i.test(file)) return 'typescript'; if (/\.py$/i.test(file)) return 'python'; if (/\.css$/i.test(file)) return 'css'; if (/\.html$/i.test(file)) return 'html'; if (/\.(ya?ml)$/i.test(file)) return 'yaml'; return 'markdown'; }
function fileDepth(entry: FileEntry) { return Math.max(0, entry.relative.split('/').length - 1); }
function fileName(entry: FileEntry) { return entry.relative.split('/').pop() ?? entry.relative; }
function toggleDirectory(entry: FileEntry) { const next = new Set(collapsedDirectories.value); if (next.has(entry.relative)) next.delete(entry.relative); else next.add(entry.relative); collapsedDirectories.value = next; }

/** Last segment of the project workspace path — shown instead of the raw absolute path. */
const workspaceFolderName = computed(() => {
  const raw = props.project.workspacePath?.trim() || '';
  if (!raw) return '';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || raw;
});

/** Short parent hint, e.g. ~/.workmate/projects */
const workspaceLocationHint = computed(() => {
  const raw = props.project.workspacePath?.trim() || '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const projectsMarker = '/.workmate/projects/';
  if (normalized.includes(projectsMarker)) return '~/.workmate/projects';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  const parent = parts.slice(0, -1).join('/');
  return parent.length > 36 ? `…/${parts.slice(-3, -1).join('/')}` : `/${parent}`;
});

const pathCopied = ref(false);
let pathCopiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copyWorkspacePath() {
  const path = props.project.workspacePath?.trim();
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    pathCopied.value = true;
    clearTimeout(pathCopiedTimer);
    pathCopiedTimer = setTimeout(() => { pathCopied.value = false; }, 1600);
  } catch { /* clipboard may be unavailable */ }
}

async function openWorkspaceFolder() {
  if (!props.project.workspacePath) return;
  try {
    if (!window.workmateDesktop) throw new Error('desktop unavailable');
    await window.workmateDesktop.revealProjectFile(props.project.workspacePath, '');
  } catch {
    await copyWorkspacePath();
  }
}

async function handleWorkspaceZipPicked(event: Event) {
  const input = event.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file || !props.project.workspacePath) return;
  importingZip.value = true;
  filesError.value = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    await importWorkspaceZip({ root: props.project.workspacePath, filename: file.name, base64: btoa(binary) });
    await loadFiles({ recover: false });
  } catch (error) {
    filesError.value = error instanceof Error ? error.message : '导入项目 zip 失败。';
  } finally {
    importingZip.value = false;
    if (input) input.value = '';
  }
}

async function downloadWorkspaceZip() {
  if (!props.project.workspacePath) return;
  exportingZip.value = true;
  filesError.value = '';
  try {
    const result = await exportWorkspaceZip(props.project.workspacePath);
    const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    filesError.value = error instanceof Error ? error.message : '导出项目 zip 失败。';
  } finally {
    exportingZip.value = false;
  }
}

function fileGlyph(entry: FileEntry): { label: string; className: string } {
  if (entry.type === 'directory') {
    return {
      label: collapsedDirectories.value.has(entry.relative) ? '▸' : '▾',
      className: 'text-[var(--muted)]',
    };
  }
  const name = fileName(entry);
  if (/\.html?$/i.test(name)) return { label: 'H', className: 'bg-orange-500/15 text-orange-700' };
  if (/\.css$/i.test(name)) return { label: 'C', className: 'bg-sky-500/15 text-sky-700' };
  if (/\.(js|mjs|cjs)$/i.test(name)) return { label: 'J', className: 'bg-amber-500/15 text-amber-700' };
  if (/\.(ts|tsx)$/i.test(name)) return { label: 'T', className: 'bg-blue-500/15 text-blue-700' };
  if (/\.(md|markdown)$/i.test(name)) return { label: 'M', className: 'bg-slate-500/15 text-slate-600' };
  if (/\.json$/i.test(name)) return { label: '{ }', className: 'bg-emerald-500/15 text-emerald-700' };
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(name)) return { label: '◇', className: 'bg-violet-500/15 text-violet-700' };
  if (/\.pdf$/i.test(name)) return { label: 'P', className: 'bg-rose-500/15 text-rose-700' };
  return { label: '·', className: 'bg-[var(--surface-muted)] text-[var(--muted)]' };
}

async function recoverProjectFiles() {
  if (!props.project.workspacePath) return;
  const assetIds = [...new Set(totalAssets.value.map((asset) => asset.id))];
  const runIds = new Set<string>();
  for (const task of props.project.tasks) {
    if (task.runId) runIds.add(task.runId);
  }
  for (const asset of totalAssets.value) {
    if ('runId' in asset && typeof (asset as { runId?: string }).runId === 'string') {
      runIds.add((asset as { runId: string }).runId);
    }
  }
  try {
  } catch { /* Keep run recovery best-effort even without desktop-only asset catalog. */ }
  for (const runId of runIds) {
    try { await syncWorkspaceRun(props.project.workspacePath, runId); } catch { /* Continue other run workspaces. */ }
  }
  if (assetIds.length) {
    try {
      await materializeWorkspaceAssets(props.project.workspacePath, totalAssets.value
        .filter((asset) => assetIds.includes(asset.id))
        .map((asset) => ({
          assetId: asset.id,
          relativePath: asset.name,
          name: asset.name,
        })));
    } catch { /* Keep listing whatever already synced. */ }
  }
}

async function loadFiles(options: { recover?: boolean } = {}) {
  filesError.value = '';
  if (!props.project.workspacePath) {
    files.value = [];
    filesError.value = '旧项目尚未配置项目空间。';
    return;
  }
  refreshing.value = true;
  try {
    // 先把本项目各任务的运行工作区(生成的文件)同步到项目目录，再读取文件树。
    await syncRunWorkspacesIntoProject();
    files.value = await listWorkspaceFiles(props.project.workspacePath);
    const hasTaskRuns = props.project.tasks.some((task) => Boolean(task.runId));
    const needsRecover = options.recover !== false && !files.value.some((entry) => entry.type === 'file') && (totalAssets.value.length > 0 || hasTaskRuns);
    if (needsRecover) {
      await recoverProjectFiles();
      files.value = await listWorkspaceFiles(props.project.workspacePath);
    }
  } catch (error) {
    filesError.value = error instanceof Error ? error.message : '无法读取项目空间。';
  } finally {
    refreshing.value = false;
  }
}

/** 复制所有已运行任务的生成文件到项目目录，使左侧文件树能看到运行工作区的产物。 */
async function syncRunWorkspacesIntoProject() {
  if (!props.project.workspacePath) return;
  const runIds = [...new Set(props.project.tasks.map((task) => task.runId).filter((runId): runId is string => Boolean(runId)))];
  for (const runId of runIds) {
    try { await syncWorkspaceRun(props.project.workspacePath, runId); } catch { /* 单个运行失败不影响其它 */ }
  }
}

async function selectFile(entry: FileEntry) {
  if (entry.type === 'directory') { toggleDirectory(entry); return; }
  if (!props.project.workspacePath) return;
  const file = await readWorkspaceFile(props.project.workspacePath, entry.relative);
  if (!file) return;
  selectedFile.value = entry.relative; fileContent.value = file.content;
  membersDockOpen.value = false;
  await nextTick();
  if (!editorHost.value) return;
  if (!editor) editor = monaco.editor.create(editorHost.value, { value: file.content, language: language(entry.relative), theme: monacoTheme(), automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', scrollBeyondLastLine: false, padding: { top: 16 } });
  else { monaco.editor.setModelLanguage(editor.getModel()!, language(entry.relative)); editor.setValue(file.content); monaco.editor.setTheme(monacoTheme()); }
}
function closeEditor() {
  selectedFile.value = '';
  editor?.dispose();
  editor = undefined;
  membersDockOpen.value = false;
}
async function saveFile() { if (!props.project.workspacePath || !selectedFile.value || !editor) return; const result = await writeWorkspaceFile(props.project.workspacePath, selectedFile.value, editor.getValue()); if (result) fileContent.value = result.content; }

async function dispatch() {
  if (
    !draft.value.trim() ||
    !selectedEmployeeId.value ||
    sending.value ||
    props.running
  )
    return;
  const content = draft.value
    .replace(new RegExp(`@${employeeName(selectedEmployeeId.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "g"), "")
    .trim();
  if (!content) return;
  sending.value = true;
  try {
    emit("dispatch", {
      employeeId: selectedEmployeeId.value,
      content,
    });
    draft.value = "";
    selectedEmployeeId.value = null;
    pickerOpen.value = false;
    mentionMenuOpen.value = false;
  } finally {
    sending.value = false;
  }
}
function handleDraftInput() {
  const opened = /@[^\s]*$/.test(draft.value);
  if (opened && !mentionMenuOpen.value) mentionActiveIndex.value = 0;
  mentionMenuOpen.value = opened;
  if (opened) pickerOpen.value = false;
}
function chooseMention(id: EmployeeId) {
  selectedEmployeeId.value = id;
  draft.value = draft.value.replace(/@[^\s]*$/, `@${employeeName(id)} `);
  mentionMenuOpen.value = false;
}
function handleDraftKeydown(event: KeyboardEvent) {
  if (mentionMenuOpen.value && availableMentionEmployees.value.length) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      mentionActiveIndex.value =
        (mentionActiveIndex.value + 1) % availableMentionEmployees.value.length;
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      mentionActiveIndex.value =
        (mentionActiveIndex.value - 1 + availableMentionEmployees.value.length) %
        availableMentionEmployees.value.length;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected =
        availableMentionEmployees.value[mentionActiveIndex.value] ??
        availableMentionEmployees.value[0];
      chooseMention(selected.id);
      return;
    }
  }
  if (event.key === "Escape" && mentionMenuOpen.value) {
    event.preventDefault();
    mentionMenuOpen.value = false;
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void dispatch();
  }
}
async function download(assetId: string) {
  await downloadAssetBestEffort(assetId);
}
function openMember(employeeId: EmployeeId) {
  detailEmployeeId.value = employeeId;
  membersDockOpen.value = false;
}
function toggleDelegatedUser(userId: string, checked: boolean) {
  if (checked) sharePermissions.value = { ...sharePermissions.value, [userId]: sharePermissions.value[userId] ?? "write" };
  else {
    const next = { ...sharePermissions.value };
    delete next[userId];
    sharePermissions.value = next;
  }
}
function handleShareUserToggle(userId: string, event: Event) {
  toggleDelegatedUser(userId, (event.target as HTMLInputElement | null)?.checked === true);
}
function setSharePermission(userId: string, permission: "read" | "write") {
  sharePermissions.value = { ...sharePermissions.value, [userId]: permission };
}
function handleSharePermissionChange(userId: string, event: Event) {
  const value = (event.target as HTMLSelectElement | null)?.value;
  setSharePermission(userId, value === "read" ? "read" : "write");
}
async function saveProjectSharing() {
  if (!props.project.managedServer || savingShare.value) return;
  if (shareScope.value === "delegated" && !hasDelegatedUsers.value) return;
  savingShare.value = true;
  try {
    const updated = await orch.updateProjectAccess(props.project.id, {
      accessScope: shareScope.value,
      accessGrants: shareScope.value === "delegated"
        ? Object.entries(sharePermissions.value).map(([userId, permission]) => ({
          subjectType: "user" as const,
          subjectId: userId,
          permissions: permission === "write" ? (["read", "write"] as Array<"read" | "write">) : (["read"] as Array<"read" | "write">),
          createdAt: Date.now(),
        }))
        : [],
    });
    props.project.accessScope = updated.accessScope ?? "private";
    props.project.accessGrants = updated.accessGrants ?? [];
  } finally {
    savingShare.value = false;
  }
}
function requestAddMember(employeeId: EmployeeId) {
  if (props.running) return;
  addMemberOpen.value = false;
  emit("add-member", employeeId);
}
function requestRemoveMember(employeeId: EmployeeId, event?: Event) {
  event?.stopPropagation();
  if (props.running) return;
  if (members.value.length <= 1) return;
  if (selectedEmployeeId.value === employeeId) selectedEmployeeId.value = null;
  if (detailEmployeeId.value === employeeId) detailEmployeeId.value = null;
  emit("remove-member", employeeId);
}

onMounted(() => {
  void (async () => {
    const savedWidth = Number(await readStored(TREE_WIDTH_KEY));
    if (Number.isFinite(savedWidth) && savedWidth >= MIN_TREE_WIDTH && savedWidth <= MAX_TREE_WIDTH) treeWidth.value = savedWidth;
    treeCollapsed.value = (await readStored(TREE_COLLAPSED_KEY)) === "1";
    await loadFiles({ recover: true });
  })();
});
// 运行期间自动刷新文件树：编程员工写入的工作区文件会随同步落到项目目录，
// 无需手工点「刷新」即可看到产物。
let fileRefreshTimer: ReturnType<typeof setInterval> | undefined;
function ensureFileRefresh() {
  if (props.project.status === "running" && !fileRefreshTimer) {
    fileRefreshTimer = setInterval(() => { void loadFiles({ recover: true }); }, 5000);
  } else if (props.project.status !== "running" && fileRefreshTimer) {
    clearInterval(fileRefreshTimer);
    fileRefreshTimer = undefined;
  }
}
ensureFileRefresh();
watch(
  () => [props.project.status, props.project.messages.length, totalAssets.value.length, props.project.workspacePath, props.fileTreeEpoch ?? 0] as const,
  () => {
    ensureFileRefresh();
    void loadFiles({ recover: true });
  },
);
watch(
  () => [props.project.id, props.project.accessScope, JSON.stringify(props.project.accessGrants ?? [])] as const,
  () => {
    shareScope.value = props.project.accessScope ?? "private";
    sharePermissions.value = Object.fromEntries(
      (props.project.accessGrants ?? [])
        .filter((grant) => grant.subjectType === "user" && grant.subjectId)
        .map((grant) => [
          grant.subjectId,
          grant.permissions.includes("write") ? "write" : "read",
        ]),
    );
  },
  { immediate: true },
);
watch(resolvedTheme, () => {
  if (editor) monaco.editor.setTheme(monacoTheme());
});
onBeforeUnmount(() => {
  if (fileRefreshTimer) clearInterval(fileRefreshTimer);
  clearTimeout(pathCopiedTimer);
  editor?.dispose();
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <header
      class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4"
    >
      <div class="flex min-w-0 items-center gap-3">
        <button
          class="rounded-lg px-2 py-1 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
          @click="emit('back')"
        >
          ← 项目列表
        </button>
        <span class="hidden h-5 w-px bg-[var(--border)] sm:block" />
        <div class="min-w-0">
          <p class="text-[10px] font-bold tracking-[.14em] text-[var(--accent)]">
            PROJECT WORKSPACE · {{ templateName }}
          </p>
          <h1 class="truncate text-lg font-bold">{{ project.name }}</h1>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="project.plan?.version"
          class="rounded-full bg-[var(--surface-muted)] px-2.5 py-1 text-[11px] font-semibold text-[var(--muted)]"
          :title="project.plan.note || '当前执行计划版本'"
        >Plan v{{ project.plan.version }}</span>
        <span :class="['rounded-full px-2.5 py-1 text-xs font-bold', statusClass(project.status)]">{{ statusText(project.status) }}</span>
        <button
          v-if="project.status === 'running'"
          class="rounded-lg border border-amber-500/40 px-3 py-2 text-xs font-semibold text-amber-700"
          @click="emit('cancel')"
        >取消</button>
        <button
          v-else
          class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white"
          @click="emit('start')"
        >{{ project.status === "draft" ? "启动首轮" : "再次调度" }}</button>
        <button
          class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-rose-600"
          @click="emit('remove')"
        >删除</button>
      </div>
    </header>

    <div
      class="grid min-h-0 flex-1 grid-cols-1 [grid-template-rows:minmax(0,1fr)]"
      :class="[
        resizingTree ? 'select-none' : '',
        editing
          ? 'xl:[grid-template-columns:var(--tree-width)_minmax(0,1.2fr)_minmax(340px,0.9fr)]'
          : 'xl:[grid-template-columns:var(--tree-width)_minmax(0,1fr)_300px]',
      ]"
      :style="{ '--tree-width': `${effectiveTreeWidth}px` }"
    >
      <!-- 项目文件：默认展开；可向左收起，拖右边线调宽 -->
      <aside
        :class="[
          'relative min-h-0 border-r border-[var(--border)] bg-[var(--surface)]',
          treeCollapsed ? 'overflow-hidden' : 'overflow-y-auto p-3',
        ]"
      >
        <template v-if="treeCollapsed">
          <div class="flex h-full flex-col items-center gap-3 py-3">
            <button
              class="grid h-8 w-8 place-items-center rounded-lg border border-[var(--border)] text-sm font-bold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              type="button"
              title="展开项目文件"
              @click="setTreeCollapsed(false)"
            >›</button>
            <span
              class="mt-2 text-[10px] font-bold tracking-[.18em] text-[var(--muted)]"
              style="writing-mode: vertical-rl"
            >项目文件</span>
            <span v-if="fileCount" class="text-[10px] text-[var(--muted)]">{{ fileCount }}</span>
          </div>
        </template>
        <template v-else>
          <div class="mb-3 flex items-center justify-between gap-2 px-1">
            <div class="min-w-0">
              <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">FILES</p>
              <strong class="block text-sm tracking-tight">项目文件</strong>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
              <button
                class="rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-wait disabled:opacity-50"
                type="button"
                :disabled="refreshing || !project.workspacePath"
                @click="loadFiles({ recover: true })"
              >{{ refreshing ? '同步中' : '刷新' }}</button>
              <button
                class="rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--accent)]"
                type="button"
                title="向左收起，扩大右侧空间"
                @click="setTreeCollapsed(true)"
              >‹</button>
            </div>
          </div>

          <div
            v-if="project.workspacePath"
            class="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/70 px-2.5 py-2"
          >
            <input ref="workspaceZipInput" class="hidden" type="file" accept=".zip,application/zip" @change="handleWorkspaceZipPicked" />
            <div class="flex items-start gap-2">
              <span
                class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent)]"
                aria-hidden="true"
              >⌂</span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-semibold leading-5 text-[var(--text)]" :title="project.workspacePath">
                  {{ workspaceFolderName }}
                </p>
                <p v-if="workspaceLocationHint" class="truncate text-[10px] leading-4 text-[var(--muted)]" :title="project.workspacePath">
                  {{ workspaceLocationHint }}
                </p>
              </div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                class="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)]"
                type="button"
                :title="desktopShell ? '在访达中打开项目目录' : 'Web / Docker 下复制服务端项目空间路径'"
                @click="openWorkspaceFolder"
              >{{ desktopShell ? '打开位置' : (pathCopied ? '已复制路径' : '复制路径') }}</button>
              <button
                class="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-50"
                type="button"
                :disabled="importingZip"
                @click="workspaceZipInput?.click()"
              >{{ importingZip ? '导入中…' : '导入 zip' }}</button>
              <button
                class="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-50"
                type="button"
                :disabled="exportingZip"
                @click="downloadWorkspaceZip"
              >{{ exportingZip ? '导出中…' : '导出 zip' }}</button>
              <button
                class="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)]"
                type="button"
                :title="project.workspacePath"
                @click="copyWorkspacePath"
              >{{ pathCopied ? '已复制' : '复制路径' }}</button>
              <span v-if="fileCount" class="ml-auto text-[10px] tabular-nums text-[var(--muted)]">{{ fileCount }} 项</span>
            </div>
            <p v-if="!desktopShell" class="mt-2 text-[10px] leading-4 text-[var(--muted)]">
              浏览器环境下建议通过“导入 zip / 导出 zip”在本地与服务端项目空间之间同步文件；“打开位置”会退化为复制服务端路径。
            </p>
          </div>
          <p v-else class="mb-3 px-1 text-[11px] leading-4 text-[var(--muted)]">旧项目尚未配置项目空间。</p>

          <div class="space-y-0.5">
            <button
              v-for="entry in visibleFiles"
              :key="entry.relative"
              type="button"
              :style="{ paddingLeft: `${6 + fileDepth(entry) * 12}px` }"
              :class="[
                'group flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] transition',
                entry.type === 'directory'
                  ? 'font-medium text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]'
                  : selectedFile === entry.relative
                    ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                    : 'text-[var(--text)]/90 hover:bg-[var(--surface-muted)]',
              ]"
              :title="entry.relative"
              @click="selectFile(entry)"
            >
              <span
                v-if="entry.type === 'directory'"
                :class="['w-4 shrink-0 text-center text-[10px]', fileGlyph(entry).className]"
              >{{ fileGlyph(entry).label }}</span>
              <span
                v-else
                :class="[
                  'grid h-5 w-5 shrink-0 place-items-center rounded-md text-[9px] font-bold leading-none',
                  fileGlyph(entry).className,
                ]"
              >{{ fileGlyph(entry).label }}</span>
              <span class="min-w-0 flex-1 truncate">{{ fileName(entry) }}</span>
            </button>
          </div>
          <p v-if="filesError" class="mt-4 px-1 text-xs leading-5 text-rose-600">{{ filesError }}</p>
          <p v-else-if="!deliverableFiles.length" class="mt-5 px-1 text-xs leading-5 text-[var(--muted)]">
            暂无交付文件。过程脚本留在员工运行空间；最终产物会自动或经 publish_to_project 进入此处。
          </p>
          <div
            class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-[var(--accent)]/25 active:bg-[var(--accent)]/40"
            title="拖动调整目录树宽度"
            @pointerdown="startTreeResize"
          />
        </template>
      </aside>

      <!-- 未选文件：对话居中；选中文件：编辑器居中 -->
      <main v-if="editing" class="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
        <header class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div class="min-w-0">
            <p class="text-[10px] font-bold tracking-[.12em] text-[var(--accent)]">PROJECT FILE EDITOR</p>
            <strong class="block truncate text-sm">{{ selectedFile }}</strong>
          </div>
          <div class="flex gap-2">
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs" type="button" @click="closeEditor">关闭编辑器</button>
            <button class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-white" type="button" @click="saveFile">保存</button>
          </div>
        </header>
        <div ref="editorHost" class="min-h-0 flex-1" />
      </main>

      <div
        :class="[
          'relative flex min-h-0 flex-col bg-[var(--background)]',
          editing ? 'border-l border-[var(--border)]' : '',
        ]"
      >
        <div class="border-b border-[var(--border)] px-6 py-4">
          <div class="mx-auto flex max-w-3xl items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-semibold">{{ project.goal }}</p>
              <p class="mt-1 text-xs text-[var(--muted)]">
                {{ editing ? '正在编辑项目文件；对话移至右侧，成员可从右下角小窗展开。' : '项目对话居中；成员与资产在右侧。点击左侧文件可打开编辑器。' }}
              </p>
            </div>
            <button
              v-if="editing"
              class="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left shadow-sm hover:border-[var(--accent)]"
              type="button"
              @click="membersDockOpen = !membersDockOpen"
            >
              <span class="block text-[10px] font-bold tracking-wide text-[var(--muted)]">成员</span>
              <span class="mt-1 flex items-center gap-1">
                <i
                  v-for="employee in members.slice(0, 4)"
                  :key="employee.id"
                  class="relative grid h-6 w-6 place-items-center rounded-md text-[9px] font-bold text-white"
                  :style="{ background: employee.color }"
                  :title="`${employeeName(employee.id)} · ${statusText(statusFor(employee.id))}`"
                >
                  {{ employee.initials }}
                  <span :class="['absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-white', statusDotClass(statusFor(employee.id))]" />
                </i>
              </span>
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div :class="['mx-auto flex flex-col gap-5', editing ? 'max-w-none' : 'max-w-3xl']">
            <article
              v-for="message in project.messages"
              :key="message.id"
              :class="['flex gap-2.5', message.role === 'user' ? 'self-end' : '']"
            >
              <span
                v-if="message.role === 'assistant'"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--accent)] text-[10px] font-bold text-white"
              >{{ props.employees.find((item) => item.id === message.employeeId)?.initials ?? "AI" }}</span>
              <div :class="message.role === 'user' ? 'max-w-[88%]' : 'min-w-0 max-w-[94%] flex-1'">
                <div class="mb-1 flex gap-2 text-[11px] text-[var(--muted)]">
                  <span>{{ message.role === "user" ? "你" : message.role === "system" ? "调度器" : employeeName(message.employeeId) }}</span>
                  <span>{{ date(message.createdAt) }}</span>
                </div>
                <p
                  :class="[
                    'whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 text-[var(--text)]',
                    message.role === 'user'
                      ? 'rounded-tr-md bg-[var(--accent-soft)]'
                      : message.role === 'system'
                        ? 'border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)]'
                        : 'rounded-tl-md border border-[var(--border)] bg-[var(--surface)] shadow-sm',
                  ]"
                >{{ message.content || "正在生成项目任务结果…" }}</p>
                <details
                  v-if="message.activities?.length"
                  class="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-xs"
                >
                  <summary class="cursor-pointer px-3 py-2 text-[var(--muted)]">执行过程 · {{ message.activities.length }} 步</summary>
                  <div class="space-y-1 border-t border-[var(--border)] p-2">
                    <p
                      v-for="(activity, index) in message.activities"
                      :key="`${activity.toolName}-${index}`"
                      class="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5"
                    ><strong>{{ activity.toolName }}</strong> · {{ activity.summary }}</p>
                  </div>
                </details>
                <section
                  v-if="message.role === 'assistant' && message.approvals?.length"
                  class="mt-2 space-y-2"
                >
                  <article
                    v-for="item in message.approvals"
                    :key="item.id"
                    class="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs"
                  >
                    <p class="font-bold text-amber-700">
                      需要你的批准 · {{ approvalLabel[item.capability] ?? item.capability }}
                    </p>
                    <p class="mt-1 text-[var(--muted)]">{{ item.summary }}</p>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <button
                        class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 font-semibold text-white"
                        type="button"
                        @click="approve({ approvalId: item.id, allow: true, scope: 'session' }, message.taskId)"
                      >允许本次</button>
                      <button
                        class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 font-semibold"
                        type="button"
                        @click="approve({ approvalId: item.id, allow: true, scope: 'always' }, message.taskId)"
                      >始终允许</button>
                      <button
                        class="rounded-lg border border-rose-500/40 px-2.5 py-1.5 font-semibold text-rose-600"
                        type="button"
                        @click="approve({ approvalId: item.id, allow: false, scope: 'session' }, message.taskId)"
                      >拒绝</button>
                    </div>
                  </article>
                </section>
                <div v-if="message.assets?.length" class="mt-2 flex flex-wrap gap-2">
                  <button
                    v-for="asset in message.assets"
                    :key="asset.id"
                    class="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-2 text-left text-xs"
                    type="button"
                    @click="download(asset.id)"
                  >📦 <strong>{{ asset.name }}</strong><span class="ml-2 text-[var(--muted)]">下载</span></button>
                </div>
              </div>
            </article>
            <article v-if="project.summary" class="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <p class="text-xs font-bold text-emerald-700">协调员汇总</p>
              <p class="mt-2 whitespace-pre-wrap text-sm leading-6">{{ project.summary }}</p>
            </article>
          </div>
        </div>

        <div v-if="hasPendingApproval" class="shrink-0 border-t border-amber-500/20 bg-amber-500/10 px-6 py-2">
          <div class="mx-auto flex max-w-3xl items-center gap-2 text-xs text-amber-700">
            <span class="shrink-0">⏳</span>
            <span>有任务正在等待你的批准；点击上方消息里的「允许本次 / 始终允许 / 拒绝」后继续执行。</span>
          </div>
        </div>

        <div class="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-4">
          <div :class="['relative mx-auto rounded-2xl border border-[var(--border)] bg-[var(--background)] p-3 shadow-sm', editing ? 'max-w-none' : 'max-w-3xl']">
            <textarea
              v-model="draft"
              rows="3"
              class="w-full resize-none bg-transparent px-1 text-sm outline-none"
              :disabled="running"
              placeholder="输入 @ 选择项目员工，再下达补充指令；调度器会按依赖触发下游任务…"
              @input="handleDraftInput"
              @keydown="handleDraftKeydown"
            />
            <div
              v-if="mentionMenuOpen"
              class="absolute bottom-[108px] left-3 z-30 w-[280px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
            >
              <div class="border-b border-[var(--border)] px-3 py-2">
                <p class="text-xs font-bold">@ 选择项目员工</p>
                <p class="mt-1 text-[11px] text-[var(--muted)]">仅显示当前项目成员；指令仍经调度器执行</p>
              </div>
              <div class="max-h-52 overflow-y-auto p-2">
                <button
                  v-for="employee in availableMentionEmployees"
                  :key="employee.id"
                  :class="[
                    'flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]',
                    availableMentionEmployees[mentionActiveIndex]?.id === employee.id
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : '',
                  ]"
                  type="button"
                  @click="chooseMention(employee.id)"
                >
                  <span class="relative grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">
                    {{ employee.initials }}
                    <span :class="['absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <strong class="block">{{ employeeName(employee.id) }}</strong>
                    <small class="text-[11px] text-[var(--muted)]">{{ statusText(statusFor(employee.id)) }}</small>
                  </span>
                </button>
                <p v-if="!availableMentionEmployees.length" class="px-2 py-3 text-xs text-[var(--muted)]">
                  没有可选择的项目成员。请先在右侧新增员工。
                </p>
              </div>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <div class="relative">
                <button
                  class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold"
                  type="button"
                  :disabled="running"
                  @click="pickerOpen = !pickerOpen; mentionMenuOpen = false"
                >@ {{ selectedEmployee ? employeeName(selectedEmployee.id) : "选择项目员工" }}</button>
                <div
                  v-if="pickerOpen"
                  class="absolute bottom-10 left-0 z-20 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
                >
                  <p class="border-b border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted)]">仅显示本项目已分配的员工</p>
                  <button
                    v-for="employee in members"
                    :key="employee.id"
                    class="flex w-full items-center gap-2 p-3 text-left text-sm hover:bg-[var(--surface-muted)]"
                    type="button"
                    @click="selectedEmployeeId = employee.id; pickerOpen = false"
                  >
                    <span class="relative grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">
                      {{ employee.initials }}
                      <span :class="['absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
                    </span>
                    <span>
                      <strong class="block">{{ employeeName(employee.id) }}</strong>
                      <small :class="['text-[11px] font-semibold', statusClass(statusFor(employee.id)), 'rounded px-1 py-0.5']">{{ statusText(statusFor(employee.id)) }}</small>
                    </span>
                  </button>
                </div>
              </div>
              <span v-if="selectedEmployee" class="text-xs text-[var(--muted)]">将由调度器评估 {{ employeeName(selectedEmployee.id) }} 及下游依赖。</span>
              <button
                class="ml-auto rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                type="button"
                :disabled="!draft.trim() || !selectedEmployee || running"
                @click="dispatch"
              >发送指令</button>
            </div>
          </div>
        </div>

        <!-- 编辑模式下的成员小窗 -->
        <div
          v-if="editing && membersDockOpen"
          class="absolute bottom-28 right-6 z-30 w-72 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        >
          <div class="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <strong class="text-xs">项目成员 · {{ members.length }}</strong>
            <button class="text-xs text-[var(--muted)]" type="button" @click="membersDockOpen = false">收起</button>
          </div>
          <div class="max-h-72 overflow-y-auto p-2">
            <div
              v-for="employee in members"
              :key="employee.id"
              class="mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-xl border border-[var(--border)] p-2.5 text-left hover:border-[var(--accent)]"
              role="button"
              tabindex="0"
              @click="openMember(employee.id)"
              @keydown.enter.prevent="openMember(employee.id)"
              @keydown.space.prevent="openMember(employee.id)"
            >
              <span class="relative grid h-8 w-8 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">
                {{ employee.initials }}
                <span :class="['absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
              </span>
              <span class="min-w-0 flex-1">
                <strong class="block text-xs">{{ employeeName(employee.id) }}</strong>
                <span :class="['mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold', statusClass(statusFor(employee.id))]">{{ statusText(statusFor(employee.id)) }}</span>
              </span>
              <button
                class="rounded-md px-1.5 py-1 text-[10px] font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
                type="button"
                :disabled="running || members.length <= 1"
                title="移除成员并重新规划"
                @click="requestRemoveMember(employee.id, $event)"
              >移除</button>
            </div>
            <div class="relative mt-2">
              <button
                class="w-full rounded-xl border border-dashed border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-40"
                type="button"
                :disabled="running || !candidateMembers.length"
                @click="addMemberOpen = !addMemberOpen"
              >＋ 新增成员</button>
              <div
                v-if="addMemberOpen"
                class="absolute bottom-10 left-0 z-20 w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
              >
                <button
                  v-for="employee in candidateMembers"
                  :key="employee.id"
                  class="flex w-full items-center gap-2 p-2.5 text-left text-xs hover:bg-[var(--surface-muted)]"
                  type="button"
                  @click="requestAddMember(employee.id)"
                >
                  <span class="grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">{{ employee.initials }}</span>
                  <strong>{{ employeeName(employee.id) }}</strong>
                </button>
              </div>
            </div>
            <div v-if="totalAssets.length" class="mt-2 border-t border-[var(--border)] pt-2">
              <p class="px-1 text-[10px] font-bold text-[var(--muted)]">资产 · {{ totalAssets.length }}</p>
              <button
                v-for="asset in totalAssets.slice(0, 5)"
                :key="asset.id"
                class="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-[var(--surface-muted)]"
                type="button"
                @click="download(asset.id)"
              >📦 <span class="truncate">{{ asset.name }}</span></button>
            </div>
          </div>
        </div>
      </div>

      <!-- 未选文件：成员与资产固定最右侧 -->
      <aside
        v-if="!editing"
        class="min-h-0 border-l border-[var(--border)] bg-[var(--surface)]"
      >
        <div
          v-if="project.managedServer"
          class="border-b border-[var(--border)] px-4 py-4"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-sm font-bold">共享设置</h2>
              <p class="mt-1 text-xs text-[var(--muted)]">{{ shareSummary }}</p>
            </div>
            <span class="rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">{{ shareScope }}</span>
          </div>
          <div class="mt-3 space-y-2">
            <label class="flex items-start gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs">
              <input v-model="shareScope" type="radio" value="private" />
              <span><strong class="block text-sm text-[var(--text)]">仅自己</strong><span class="text-[var(--muted)]">只有 owner 可读写，适合个人草稿与私有项目。</span></span>
            </label>
            <label class="flex items-start gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs">
              <input v-model="shareScope" type="radio" value="org-shared" />
              <span><strong class="block text-sm text-[var(--text)]">组织共享</strong><span class="text-[var(--muted)]">同组织成员可读，owner/admin 可写。</span></span>
            </label>
            <label class="flex items-start gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs">
              <input v-model="shareScope" type="radio" value="delegated" />
              <span><strong class="block text-sm text-[var(--text)]">指定用户</strong><span class="text-[var(--muted)]">仅选中的本地用户可读写该项目。</span></span>
            </label>
          </div>
          <div v-if="shareScope === 'delegated'" class="mt-3 space-y-2">
            <label
              v-for="user in shareableUsers"
              :key="user.id"
              class="flex items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2 text-sm"
            >
              <input
                :checked="Boolean(sharePermissions[user.id])"
                type="checkbox"
                @change="handleShareUserToggle(user.id, $event)"
              />
              <span class="min-w-0 flex-1">
                <strong class="block truncate">{{ user.displayName }}</strong>
                <span class="block text-xs text-[var(--muted)]">{{ user.username }} · {{ user.role }}</span>
              </span>
              <select
                v-if="sharePermissions[user.id]"
                :value="sharePermissions[user.id]"
                class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                @change="handleSharePermissionChange(user.id, $event)"
              >
                <option value="write">可编辑</option>
                <option value="read">只读</option>
              </select>
            </label>
            <p v-if="!shareableUsers.length" class="text-xs text-[var(--muted)]">当前没有可委托的其他本地用户。</p>
          </div>
          <button
            class="mt-3 w-full rounded-xl bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
            type="button"
            :disabled="savingShare || (shareScope === 'delegated' && !hasDelegatedUsers)"
            @click="saveProjectSharing"
          >{{ savingShare ? '保存中…' : '保存共享设置' }}</button>
        </div>
        <div class="border-b border-[var(--border)] px-4 py-4">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-bold">项目成员</h2>
            <div class="flex items-center gap-2">
              <span class="text-xs text-[var(--muted)]">{{ members.length }} 人</span>
              <div class="relative">
                <button
                  class="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-semibold text-[var(--accent)] disabled:opacity-40"
                  type="button"
                  :disabled="running || !candidateMembers.length"
                  @click="addMemberOpen = !addMemberOpen"
                >＋ 新增</button>
                <div
                  v-if="addMemberOpen"
                  class="absolute right-0 top-8 z-20 w-56 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
                >
                  <p class="border-b border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted)]">加入后将重新规划并校验依赖</p>
                  <button
                    v-for="employee in candidateMembers"
                    :key="employee.id"
                    class="flex w-full items-center gap-2 p-2.5 text-left text-xs hover:bg-[var(--surface-muted)]"
                    type="button"
                    @click="requestAddMember(employee.id)"
                  >
                    <span class="grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">{{ employee.initials }}</span>
                    <strong>{{ employeeName(employee.id) }}</strong>
                  </button>
                  <p v-if="!candidateMembers.length" class="px-3 py-3 text-xs text-[var(--muted)]">没有可新增的员工</p>
                </div>
              </div>
            </div>
          </div>
          <p class="mt-1 text-xs text-[var(--muted)]">点击成员查看执行细节；新增/移除会触发协调员重规划。</p>
        </div>
        <div class="min-h-0 overflow-y-auto p-3">
          <div
            v-for="employee in members"
            :key="employee.id"
            class="mb-2 flex w-full items-center gap-2 rounded-xl border border-[var(--border)] p-3 transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/30"
          >
            <button
              class="flex min-w-0 flex-1 items-center gap-3 text-left"
              type="button"
              @click="openMember(employee.id)"
            >
              <span class="relative grid h-10 w-10 place-items-center rounded-xl text-[10px] font-bold text-white" :style="{ background: employee.color }">
                <i v-if="statusFor(employee.id) === 'running'" class="workmate-run-spin" />
                <i v-if="statusFor(employee.id) === 'running'" class="workmate-run-pulse" />
                {{ employee.initials }}
                <span :class="['absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
              </span>
              <span class="min-w-0 flex-1">
                <strong class="block text-sm">{{ employeeName(employee.id) }}</strong>
                <small class="mt-1 block text-[11px] text-[var(--muted)]">
                  {{ project.tasks.filter((task) => task.employeeId === employee.id).length }} 个任务
                </small>
                <span :class="['mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold', statusClass(statusFor(employee.id))]">
                  <i :class="['h-1.5 w-1.5 rounded-full', statusDotClass(statusFor(employee.id))]" />
                  {{ statusText(statusFor(employee.id)) }}
                </span>
              </span>
            </button>
            <button
              class="shrink-0 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
              type="button"
              :disabled="running || members.length <= 1"
              title="移除成员并重新规划"
              @click="requestRemoveMember(employee.id)"
            >移除</button>
          </div>
          <div v-if="totalAssets.length" class="mt-5 border-t border-[var(--border)] pt-4">
            <p class="text-xs font-bold">项目资产 · {{ totalAssets.length }}</p>
            <button
              v-for="asset in totalAssets.slice(0, 8)"
              :key="asset.id"
              class="mt-2 flex w-full items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-2.5 py-2 text-left text-xs"
              type="button"
              @click="download(asset.id)"
            >📦 <span class="truncate">{{ asset.name }}</span></button>
          </div>
        </div>
      </aside>
    </div>

    <div
      v-if="detailEmployee"
      class="fixed inset-0 z-40 flex justify-end bg-slate-950/25"
      @click.self="detailEmployeeId = null"
    >
      <aside class="h-full w-full max-w-xl overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="sticky top-0 flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4">
          <div>
            <p class="text-xs font-bold text-[var(--accent)]">MEMBER EXECUTION DETAIL</p>
            <h2 class="mt-1 text-lg font-bold">{{ employeeName(detailEmployee.id) }}</h2>
            <span :class="['mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold', statusClass(statusFor(detailEmployee.id))]">
              <i :class="['h-2 w-2 rounded-full', statusDotClass(statusFor(detailEmployee.id))]" />
              {{ statusText(statusFor(detailEmployee.id)) }}
            </span>
          </div>
          <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm" type="button" @click="detailEmployeeId = null">关闭</button>
        </header>
        <div class="space-y-4 p-5">
          <article v-for="task in detailTasks" :key="task.id" class="rounded-2xl border border-[var(--border)] p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="font-bold">{{ task.title }}</h3>
                <p class="mt-1 text-sm text-[var(--muted)]">{{ task.objective }}</p>
              </div>
              <span :class="['shrink-0 rounded-full px-2 py-1 text-xs font-bold', statusClass(task.status)]">{{ statusText(task.status) }}</span>
            </div>
            <pre
              v-if="task.transcript?.assistantContent"
              class="mt-3 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-xl bg-[var(--surface-muted)] p-3 font-sans text-xs leading-5"
            >{{ task.transcript.assistantContent }}</pre>
            <div v-if="task.transcript?.activities?.length" class="mt-3 space-y-1">
              <p
                v-for="(activity, index) in task.transcript.activities"
                :key="`${activity.toolName}-${index}`"
                class="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5 text-xs"
              ><strong>{{ activity.toolName }}</strong> · {{ activity.summary }}</p>
            </div>
            <div v-if="task.transcript?.model || task.transcript?.usage" class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 p-3 text-xs">
              <p class="font-bold">Run Trace</p>
              <p v-if="task.transcript?.model" class="mt-1 text-[var(--muted)]">
                模型：{{ task.transcript.model.providerLabel || task.transcript.model.provider }} / {{ task.transcript.model.chatModel }}
              </p>
              <p v-if="task.transcript?.usage" class="mt-1 text-[var(--muted)]">
                Tokens：输入 {{ formatNumber(task.transcript.usage.inputTokens) }}，输出 {{ formatNumber(task.transcript.usage.outputTokens) }}，总计 {{ formatNumber(task.transcript.usage.totalTokens) }}
              </p>
              <p
                v-if="task.transcript?.usage?.reasoningTokens || task.transcript?.usage?.cacheReadTokens || task.transcript?.usage?.cacheWriteTokens"
                class="mt-1 text-[var(--muted)]"
              >
                推理 {{ formatNumber(task.transcript.usage.reasoningTokens) }} / Cache Read {{ formatNumber(task.transcript.usage.cacheReadTokens) }} / Cache Write {{ formatNumber(task.transcript.usage.cacheWriteTokens) }}
              </p>
            </div>
            <div v-if="task.transcript?.sources?.length" class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/35 p-3 text-xs">
              <p class="font-bold">联网来源</p>
              <ul class="mt-2 space-y-1">
                <li v-for="source in task.transcript.sources" :key="source.url" class="truncate text-[var(--muted)]">
                  <a :href="source.url" target="_blank" rel="noreferrer" class="hover:text-[var(--accent)]">{{ source.title || source.url }}</a>
                </li>
              </ul>
            </div>
            <div v-if="task.transcript?.trace?.length" class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/35 p-3 text-xs">
              <p class="font-bold">事件轨迹</p>
              <div class="mt-2 space-y-1.5">
                <p v-for="(event, index) in task.transcript.trace.slice(-12)" :key="`${event.type}-${index}`" class="rounded-lg bg-[var(--surface)] px-2 py-1.5 text-[var(--muted)]">
                  <strong class="text-[var(--text)]">{{ event.type }}</strong>
                  <template v-if="event.toolName"> · {{ event.toolName }}</template>
                  <template v-if="event.summary"> · {{ event.summary }}</template>
                  <template v-else-if="event.message"> · {{ event.message }}</template>
                  <template v-else-if="event.reason"> · {{ event.reason }}</template>
                </p>
              </div>
            </div>
            <p
              v-else-if="task.status === 'running' && !task.transcript?.activities?.length"
              class="mt-3 text-xs leading-5 text-[var(--muted)]"
            >正在执行中。若长时间无过程输出，可能是进程刚重启，系统会自动回收卡住的任务。</p>
            <p
              v-else-if="task.error"
              class="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800"
            >{{ task.error }}</p>
          </article>
          <p v-if="!detailTasks.length" class="text-sm text-[var(--muted)]">该成员尚无任务记录。</p>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
/* Running-status polish: shimmering pill + orbiting/pulsing ring on the avatar. */
.workmate-running-pill {
  background: linear-gradient(90deg, #3b82f6 0%, #818cf8 45%, #22d3ee 100%);
  background-size: 200% 100%;
  color: #fff;
  animation: workmate-shimmer 1.7s linear infinite;
}
.workmate-run-spin,
.workmate-run-pulse {
  position: absolute;
  inset: -3px;
  border-radius: 16px;
  pointer-events: none;
}
.workmate-run-spin {
  border: 2px solid transparent;
  border-top-color: #818cf8;
  border-right-color: rgba(129, 140, 248, 0.55);
  filter: drop-shadow(0 0 4px rgba(99, 102, 241, 0.7));
  animation: workmate-spin 1.05s linear infinite;
}
.workmate-run-pulse {
  box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.7);
  animation: workmate-pulse 1.7s ease-out infinite;
}
@keyframes workmate-shimmer {
  to {
    background-position: -200% 0;
  }
}
@keyframes workmate-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes workmate-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.7);
  }
  100% {
    box-shadow: 0 0 0 12px rgba(99, 102, 241, 0);
  }
}
</style>
