<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  CollaborationDelivery,
  CollaborationRun,
  Conversation,
  Employee,
  EmployeeId,
  Message,
} from "../../app/workspace";
import ChatReplyPending from "./ChatReplyPending.vue";
import ChatAutoScheduleRail from "./ChatAutoScheduleRail.vue";
import type { ProviderConfig } from "../../app/model-config";
import type { ToolActivity, ToolApproval } from "../../services/api";
import type { ExecutionLevel } from "../../app/capabilities";
import { useCapabilities } from "../../app/capabilities";
import { useEmployeeRuntimePrefs } from "../../app/employee-prefs";
import { useMcpConfig, isAssociableMcp } from "../../app/mcp-config";
import type { Asset } from "../../app/assets";
import { downloadAssetBestEffort } from "../../app/platform-actions.js";
import { useI18n } from "../../app/i18n";
import { useNotify } from "../../app/notify";
import { employeeDisplayDescription, employeeDisplayName } from "../../app/employees";
import { getServerRuntimeConfig } from "../../services/api";

type EngineId = "pi" | "agentscope" | "dsh";
function isEngineId(value: unknown): value is EngineId {
  return value === "pi" || value === "agentscope" || value === "dsh";
}

const props = defineProps<{
  employee: Employee;
  selectedEmployeeId: EmployeeId;
  employees: Employee[];
  conversation: Conversation | null;
  modelConfigured: boolean;
  model: ProviderConfig;
  availableModels: ProviderConfig[];
  chatEndpointToken: string;
  permissionTier: ExecutionLevel;
  sendMessage: (
    content: string,
    collaboratorIds?: EmployeeId[],
    collaborationDelivery?: CollaborationDelivery,
    onlineSearch?: boolean,
    autoSchedule?: boolean,
  ) => Promise<void>;
  abortMessage?: () => void;
  approve: (
    conversationId: string,
    approval: ToolApproval,
    scope: "session" | "always",
  ) => Promise<void>;
}>();
const emit = defineEmits<{
  selectEmployee: [id: EmployeeId];
  selectEndpoint: [token: string];
  setPermissionTier: [tier: ExecutionLevel];
  clearConversation: [id: string];
  openAssets: [];
  openSettings: [];
}>();

const { t } = useI18n();
const notify = useNotify();
const draft = ref("");
const menuOpen = ref(false);
const collaboratorMenuOpen = ref(false);
const collaboratorIds = ref<EmployeeId[]>([]);
const mentionMenuOpen = ref(false);
const mentionActiveIndex = ref(0);
const collaborationDelivery = ref<CollaborationDelivery>("direct");
const onlineSearch = ref(true);
const autoSchedule = ref(false);
const sending = ref(false);
const approving = ref("");
const { allowedSkillsFor } = useCapabilities();
const { get: getEmployeePrefs } = useEmployeeRuntimePrefs();
const { connections: mcpConnections } = useMcpConfig();
/** Global default from Settings → 执行引擎 (fallback when employee inherits). */
const runtimeDefaultEngine = ref<EngineId>("pi");
const approvalLabel: Record<ToolApproval["capability"], string> = {
  "workspace-write": "写入运行工作区",
  "script-execution": "执行本地脚本",
  "network-access": "访问网络资源",
};
const tiers: Array<{ value: ExecutionLevel; label: string }> = [
  { value: "read-only", label: "只读" },
  { value: "default", label: "默认工作权限" },
  { value: "full", label: "完全权限（危险操作除外）" },
];

function displayTool(activity: ToolActivity) {
  return activity.toolName.replace(/_/g, " ");
}
function handlePermissionTierChange(event: Event) {
  emit(
    "setPermissionTier",
    (event.target as HTMLSelectElement).value as ExecutionLevel,
  );
}
function handleEndpointChange(event: Event) {
  emit("selectEndpoint", (event.target as HTMLSelectElement).value);
}
function stateLabel(activity: ToolActivity) {
  return activity.status === "running"
    ? "执行中"
    : activity.status === "failed"
      ? "未完成"
      : "已完成";
}
function hasFailedActivities(activities?: ToolActivity[]) {
  return activities?.some((activity) => activity.status === "failed") ?? false;
}
function hasRunningActivities(activities?: ToolActivity[]) {
  return activities?.some((activity) => activity.status === "running") ?? false;
}
function activityOutcome(message: Message) {
  const activities = message.activities ?? [];
  if (hasRunningActivities(activities)) {
    return {
      label: "运行中",
      tone: "accent" as const,
      detail: `${activities.length} 步执行中`,
    };
  }
  if (hasFailedActivities(activities)) {
    const recovered = completedCount(activities) > 0
      && (message.assets?.length ?? 0) > 0;
    return recovered
      ? {
          label: "已完成，含重试",
          tone: "warn" as const,
          detail: "过程中有重试，最终已成功交付",
        }
      : {
          label: "需要处理",
          tone: "danger" as const,
          detail: "存在未完成步骤",
        };
  }
  return {
    label: "已完成 · 查看详情",
    tone: "success" as const,
    detail: "流程已顺利完成",
  };
}
function shouldExpand(activities?: ToolActivity[]) {
  return (
    activities?.some(
      (activity) =>
        activity.status === "running" || activity.status === "failed",
    ) ?? false
  );
}
function completedCount(activities?: ToolActivity[]) {
  return (
    activities?.filter((activity) => activity.status === "completed").length ??
    0
  );
}

function elapsedLabel(elapsedMs?: number) {
  if (typeof elapsedMs !== 'number' || elapsedMs < 0) return '';
  const seconds = Math.round(elapsedMs / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
async function submit() {
  if (!draft.value.trim() || !props.modelConfigured || sending.value) return;
  const text = draft.value;
  const selected = autoSchedule.value ? [] : [...collaboratorIds.value];
  const delivery = collaborationDelivery.value;
  const useAutoSchedule = autoSchedule.value;
  draft.value = "";
  if (!useAutoSchedule) {
    collaboratorIds.value = [];
  }
  collaborationDelivery.value = "direct";
  mentionMenuOpen.value = false;
  collaboratorMenuOpen.value = false;
  sending.value = true;
  stickToBottom.value = true;
  void nextTick(() => scrollMessagesToBottom(true));
  try {
    await props.sendMessage(text, selected, delivery, onlineSearch.value, useAutoSchedule);
  } catch (cause) {
    notify.error(cause);
  } finally {
    sending.value = false;
  }
}
function stopGeneration() {
  if (!sending.value) return;
  props.abortMessage?.();
}
async function approve(item: ToolApproval, scope: "session" | "always") {
  if (!props.conversation) return;
  const key = `${item.skillId}:${item.capability}`;
  approving.value = key;
  try {
    await props.approve(props.conversation.id, item, scope);
  } finally {
    approving.value = "";
  }
}
function clearCurrentConversation() {
  if (
    props.conversation &&
    window.confirm("清空当前对话的所有消息？此会话会保留在左侧列表中。")
  )
    emit("clearConversation", props.conversation.id);
}
function approvalKey(item: ToolApproval) {
  return `${item.skillId}:${item.capability}`;
}
function formatBytes(value: number) {
  return value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function assetType(asset: Asset) {
  return asset.name.split(".").pop()?.toUpperCase() || "FILE";
}
async function downloadAsset(asset: Asset) {
  await downloadAssetBestEffort(asset.id);
}
function toggleCollaborator(id: EmployeeId) {
  if (autoSchedule.value) return;
  collaboratorIds.value = collaboratorIds.value.includes(id)
    ? collaboratorIds.value.filter((item) => item !== id)
    : [...collaboratorIds.value, id].slice(0, 3);
  if (collaboratorIds.value.length === 1)
    collaborationDelivery.value = "direct";
}
function closeCollaboratorMenu() {
  collaboratorMenuOpen.value = false;
}
function handleDraftInput() {
  if (autoSchedule.value) {
    mentionMenuOpen.value = false;
    return;
  }
  const opened = /@[^\s]*$/.test(draft.value);
  if (opened && !mentionMenuOpen.value) mentionActiveIndex.value = 0;
  mentionMenuOpen.value = opened;
}
function chooseMention(id: EmployeeId) {
  if (!collaboratorIds.value.includes(id)) toggleCollaborator(id);
  draft.value = draft.value.replace(/@[^\s]*$/, `@${collaboratorName(id)} `);
  mentionMenuOpen.value = false;
}
const availableMentionEmployees = computed(() =>
  props.employees.filter(
    (item) =>
      item.id !== props.selectedEmployeeId &&
      !collaboratorIds.value.includes(item.id),
  ),
);
function handleDraftKeydown(event: KeyboardEvent) {
  if (mentionMenuOpen.value && availableMentionEmployees.value.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value + 1) % availableMentionEmployees.value.length;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value - 1 + availableMentionEmployees.value.length) % availableMentionEmployees.value.length;
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = availableMentionEmployees.value[mentionActiveIndex.value] ?? availableMentionEmployees.value[0];
      chooseMention(selected.id);
      return;
    }
  }
  if (event.key === 'Escape' && mentionMenuOpen.value) {
    event.preventDefault();
    mentionMenuOpen.value = false;
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}
function collaboratorName(id: EmployeeId) {
  return employeeDisplayName(props.employees.find((item) => item.id === id), t) || id;
}
function summarizeNames(names: string[], emptyLabel: string) {
  if (!names.length) return emptyLabel;
  const head = names.slice(0, 3).join("、");
  return names.length > 3 ? `${head} 等 ${names.length} 项` : head;
}
const activeSkillNames = computed(() =>
  allowedSkillsFor(props.employee.id)
    .map((skill) => skill.name),
);
const activeMcpNames = computed(() => {
  const selected = new Set(getEmployeePrefs(props.employee.id).mcpIds || []);
  return mcpConnections.value
    .filter((item) => selected.has(item.id) && isAssociableMcp(item))
    .map((item) => item.name);
});
const employeeEngineOverride = computed(() => {
  const raw = getEmployeePrefs(props.employee.id).engine;
  return isEngineId(raw) ? raw : null;
});
/** Expected engine for the next turn (employee override → global default). */
const expectedEngine = computed<EngineId>(
  () => employeeEngineOverride.value ?? runtimeDefaultEngine.value,
);
/** Live engine from the latest assistant turn when SSE reported it. */
const liveTurnEngine = computed<EngineId | null>(() => {
  const messages = props.conversation?.messages;
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "assistant" && isEngineId(msg.engine)) return msg.engine;
  }
  return null;
});
const displayEngine = computed<EngineId>(() => liveTurnEngine.value ?? expectedEngine.value);
const engineInherited = computed(() => !employeeEngineOverride.value && !liveTurnEngine.value);
const runtimePreview = computed(() => ({
  skillCount: activeSkillNames.value.length,
  mcpCount: activeMcpNames.value.length,
  skillSummary: summarizeNames(activeSkillNames.value, "无额外 Skills"),
  mcpSummary: summarizeNames(activeMcpNames.value, "未关联 MCP"),
  engine: displayEngine.value,
  engineLabel: t(`employee.engine.${displayEngine.value}`),
  engineInherited: engineInherited.value,
}));

async function refreshRuntimeDefaultEngine() {
  try {
    const value = (await getServerRuntimeConfig()) as { defaultEngine?: string };
    const def = String(value.defaultEngine || "pi").trim().toLowerCase();
    runtimeDefaultEngine.value = isEngineId(def) ? def : "pi";
  } catch {
    runtimeDefaultEngine.value = "pi";
  }
}
onMounted(() => {
  void refreshRuntimeDefaultEngine();
});
watch(
  () => props.employee.id,
  () => {
    void refreshRuntimeDefaultEngine();
  },
);
function collaborationState(item: CollaborationRun) {
  return item.status === "running"
    ? "协作中"
    : item.status === "completed"
      ? "已完成"
      : "未完成";
}
function collaborationStateClass(item: CollaborationRun) {
  return item.status === "running"
    ? "text-[var(--accent)]"
    : item.status === "completed"
      ? "text-emerald-600"
      : "text-rose-600";
}

function hasAssistantVisibleProgress(message: Message) {
  return Boolean(
    message.content.trim()
    || message.reasoning?.trim()
    || message.activities?.length
    || message.collaborations?.length
    || message.schedule?.tasks.length
    || message.schedule?.status === 'planning',
  );
}

const activeScheduleMessage = computed(() => {
  const messages = props.conversation?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.schedule) return message;
  }
  return null;
});

const showScheduleRail = computed(() => Boolean(activeScheduleMessage.value?.schedule));

function selectScheduleTask(taskId: string) {
  const schedule = activeScheduleMessage.value?.schedule;
  if (!schedule) return;
  schedule.selectedTaskId = taskId;
}

function toggleAutoSchedule() {
  if (sending.value) return;
  autoSchedule.value = !autoSchedule.value;
  if (autoSchedule.value) {
    collaboratorIds.value = [];
    collaboratorMenuOpen.value = false;
    mentionMenuOpen.value = false;
  }
}

const pendingAssistantId = computed(() => {
  if (!sending.value || !props.conversation?.messages.length) return null;
  const last =
    props.conversation.messages[props.conversation.messages.length - 1];
  // Hide as soon as any visible progress arrives (answer text, reasoning, or tool UI).
  if (last.role !== "assistant" || hasAssistantVisibleProgress(last)) return null;
  return last.id;
});

const showStandalonePending = computed(() => {
  if (!sending.value) return false;
  if (!props.conversation) return true;
  const hasVisibleProgress = props.conversation.messages.some((message) =>
    message.role === 'assistant' && hasAssistantVisibleProgress(message),
  );
  // This indicator means "still waiting for the first visible response", not
  // "the whole run is active". A server-side mirror can temporarily contain
  // an extra empty assistant placeholder, so inspect the whole conversation
  // rather than only its last item.
  return !hasVisibleProgress;
});

function isAwaitingReply(message: Message) {
  if (message.role !== "assistant" || pendingAssistantId.value !== message.id) return false;
  // Render-time guard: never keep the waiting bar once this message already
  // shows progress (also covers stale computed after raw-object stream writes).
  return !hasAssistantVisibleProgress(message);
}

const messageScrollRef = ref<HTMLElement | null>(null);
const messageListRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
const SCROLL_NEAR_BOTTOM_PX = 96;
let listResizeObserver: ResizeObserver | null = null;

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_NEAR_BOTTOM_PX;
}

function scrollMessagesToBottom(force = false) {
  const el = messageScrollRef.value;
  if (!el) return;
  if (!force && !stickToBottom.value && !sending.value) return;
  el.scrollTo({ top: el.scrollHeight, behavior: force ? "auto" : "smooth" });
}

function onMessageScroll() {
  const el = messageScrollRef.value;
  if (!el) return;
  stickToBottom.value = isNearBottom(el);
}

const chatScrollSignal = computed(() => {
  const conv = props.conversation;
  if (!conv?.messages.length) return `empty:${conv?.id ?? ""}`;
  const last = conv.messages[conv.messages.length - 1];
  const activities = (last.activities ?? [])
    .map((item) => `${item.toolName}:${item.status}:${item.summary.length}`)
    .join("|");
  const collaborations = (last.collaborations ?? [])
    .map((item) => `${item.employeeId}:${item.status}:${item.summary.length}`)
    .join("|");
  return [
    conv.id,
    conv.messages.length,
    last.id,
    last.role,
    last.content.length,
    activities,
    collaborations,
    last.assets?.length ?? 0,
    last.approvals?.length ?? 0,
    sending.value,
    pendingAssistantId.value ?? "",
  ].join("\0");
});

watch(
  () => props.conversation?.id,
  () => {
    stickToBottom.value = true;
    void nextTick(() => scrollMessagesToBottom(true));
  },
);

watch(chatScrollSignal, () => {
  void nextTick(() => scrollMessagesToBottom(sending.value || stickToBottom.value));
});

watch(messageListRef, (el, _, onCleanup) => {
  listResizeObserver?.disconnect();
  listResizeObserver = null;
  if (!el) return;
  listResizeObserver = new ResizeObserver(() => {
    if (stickToBottom.value || sending.value) scrollMessagesToBottom(false);
  });
  listResizeObserver.observe(el);
  onCleanup(() => {
    listResizeObserver?.disconnect();
    listResizeObserver = null;
  });
});

onBeforeUnmount(() => {
  listResizeObserver?.disconnect();
  listResizeObserver = null;
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <header
      class="flex min-h-[72px] items-center justify-between border-b border-[var(--border)] px-5 py-3 sm:px-8"
    >
      <div class="relative">
        <button
          class="flex items-center gap-2 rounded-xl p-1 text-left hover:bg-[var(--surface-muted)]"
          @click="menuOpen = !menuOpen"
        >
          <span
            class="grid h-8 w-8 place-items-center rounded-[10px] text-[11px] font-extrabold text-white"
            :style="{ background: employee.color }"
            >{{ employee.initials }}</span
          ><span
            ><strong class="block text-[13px]">{{ employeeDisplayName(employee, t) }}</strong
            ><small class="block text-[11px] text-[var(--muted)]"
              >{{ t("employee.default") }} · {{ t("chat.engine") }} {{ runtimePreview.engineLabel }}</small
            ></span
          ><span>⌄</span>
        </button>
        <div
          v-if="menuOpen"
          class="absolute left-0 top-12 z-10 w-52 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl"
        >
          <button
            v-for="item in employees"
            :key="item.id"
            class="flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]"
            @click="
              emit('selectEmployee', item.id);
              menuOpen = false;
            "
          >
            {{ employeeDisplayName(item, t) }}
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2 sm:gap-3">
        <button
          v-if="conversation"
          class="hidden rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--muted)] transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-600 sm:inline-flex"
          type="button"
          title="清空当前对话内容"
          @click="clearCurrentConversation"
        >
          清空对话</button
        ><select
          class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 text-xs font-semibold"
          :value="permissionTier"
          title="当前数字员工权限档位"
          @change="handlePermissionTierChange"
        >
          <option v-for="tier in tiers" :key="tier.value" :value="tier.value">
            {{ tier.label }}
          </option></select
        ><span
          :class="[
            'hidden text-xs sm:inline',
            modelConfigured ? 'text-emerald-600' : 'text-[var(--muted)]',
          ]"
          >●
          {{ modelConfigured ? t("chat.modelReady") : t("chat.model") }}</span
        >
      </div>
    </header>

    <div
      v-if="!conversation && !showStandalonePending"
      class="flex flex-1 flex-col items-center justify-center px-5 text-center"
    >
      <h1 class="text-4xl font-bold">{{ t("chat.greeting") }}</h1>
      <p class="mt-3 text-[var(--muted)]">{{ t("chat.subheading") }}</p>
    </div>
    <div v-else-if="!conversation" class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[1240px] flex-col gap-6 px-6 py-9 lg:px-10">
        <ChatReplyPending :accent="employee.color" />
      </div>
    </div>
    <div
      v-else
      class="mx-auto flex min-h-0 w-full max-w-[1560px] flex-1 gap-4 overflow-hidden px-6 lg:px-10"
    >
      <div
        ref="messageScrollRef"
        class="min-h-0 min-w-0 flex-1 overflow-y-auto"
        @scroll="onMessageScroll"
      >
      <div
        ref="messageListRef"
        class="mx-auto flex w-full max-w-[1240px] flex-col gap-6 py-9"
      >
        <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/55 px-4 py-3 text-xs text-[var(--muted)]">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="rounded-full px-2.5 py-1 font-semibold"
              :class="
                runtimePreview.engine === 'dsh'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'bg-[var(--surface)] text-[var(--text)]'
              "
              :title="t('chat.engineHelp')"
            >{{ t('chat.engine') }}：{{ runtimePreview.engineLabel }}<template v-if="runtimePreview.engineInherited"> · {{ t('chat.engineInheritShort') }}</template></span>
            <span class="rounded-full bg-[var(--surface)] px-2.5 py-1 font-semibold text-[var(--text)]">权限：{{ tiers.find((item) => item.value === permissionTier)?.label ?? permissionTier }}</span>
            <span class="rounded-full bg-[var(--surface)] px-2.5 py-1">Skills：{{ runtimePreview.skillCount }}</span>
            <span class="rounded-full bg-[var(--surface)] px-2.5 py-1">MCP：{{ runtimePreview.mcpCount }}</span>
          </div>
          <p class="mt-2">本次员工执行画像 · Skill：{{ runtimePreview.skillSummary }} · MCP：{{ runtimePreview.mcpSummary }}</p>
        </section>
        <article
          v-for="message in conversation.messages"
          :key="message.id"
          :class="[
            'flex gap-2.5',
            message.role === 'user' ? 'max-w-[88%] self-end' : 'max-w-[96%]',
          ]"
        >
          <span
            v-if="message.role === 'assistant'"
            class="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[11px] font-extrabold text-white"
            :style="{ background: employee.color }"
            >{{ employee.initials }}</span
          >
          <div class="min-w-0 flex-1">
            <small class="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--muted)]">
              <span>{{ message.role === "user" ? t("chat.you") : t("chat.assistant") }}</span>
              <span
                v-if="message.role === 'assistant' && message.engine"
                class="rounded-full bg-[var(--surface)] px-1.5 py-0.5 font-medium text-[10px] text-[var(--text)]"
                :title="t('chat.engineTurnHelp')"
              >{{ t('chat.engine') }} · {{ t(`employee.engine.${message.engine}`) }}</span>
            </small>
            <p
              v-if="message.content"
              :class="[
                'mt-1 max-w-none whitespace-pre-wrap border px-4 py-3.5 leading-7 text-[var(--text)] shadow-[0_10px_30px_rgba(15,23,42,0.04)]',
                message.role === 'user'
                  ? 'rounded-[18px_6px_18px_18px] border-[var(--accent)]/15 bg-[var(--accent-soft)]'
                  : 'rounded-[8px_18px_18px_18px] border-[var(--border)] bg-[var(--surface)]',
              ]"
            >
              {{ message.content }}
            </p>
            <details
              v-if="message.role === 'assistant' && message.reasoning"
              class="mt-2 overflow-hidden rounded-lg border border-[var(--border)]/80 bg-[var(--surface)]/92 text-[11px] shadow-[0_4px_14px_rgba(15,23,42,0.035)]"
            >
              <summary class="cursor-pointer px-2.5 py-1.5 text-[var(--muted)]">思维过程（与主回答分离）</summary>
              <pre class="border-t border-[var(--border)] px-3 py-2.5 whitespace-pre-wrap text-[var(--muted)]">{{ message.reasoning }}</pre>
            </details>
            <ChatReplyPending
              v-if="isAwaitingReply(message)"
              :accent="employee.color"
              :started-at="message.startedAt"
            />
            <details
              v-if="
                message.role === 'assistant' && message.collaborations?.length
              "
              class="group mt-2 overflow-hidden rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-soft)]/30 text-xs"
              :open="
                message.collaborations.some((item) => item.status === 'running')
              "
            >
              <summary
                class="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5"
              >
                <span
                  class="grid h-5 w-5 place-items-center rounded-md bg-[var(--surface)] text-[10px] text-[var(--accent)]"
                  >◎</span
                ><strong>指定员工协作</strong
                ><span class="text-[var(--muted)]"
                  >{{ message.collaborations.length }} 位员工</span
                ><span
                  v-if="
                    message.collaborations.some(
                      (item) => item.status === 'running',
                    )
                  "
                  class="ml-auto text-[var(--accent)]"
                  >协作中</span
                ><span v-else class="ml-auto text-emerald-600">已汇总</span
                ><span class="transition-transform group-open:rotate-180"
                  >⌄</span
                >
              </summary>
              <div class="space-y-2 border-t border-[var(--accent)]/15 p-2">
                <article
                  v-for="item in message.collaborations"
                  :key="item.employeeId"
                  class="rounded-lg bg-[var(--surface)] p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <strong>{{ collaboratorName(item.employeeId) }}</strong
                    ><span
                      :class="['font-semibold', collaborationStateClass(item)]"
                      >{{ collaborationState(item) }}</span
                    >
                  </div>
                  <p class="mt-1 text-[11px] leading-4 text-[var(--muted)]">
                    分工：{{ item.task }}
                  </p>
                  <p
                    v-if="item.summary"
                    class="mt-2 whitespace-pre-wrap leading-5 text-[var(--muted)]"
                  >
                    {{ item.summary }}
                  </p>
                  <p v-if="item.error" class="mt-2 text-rose-600">
                    {{ item.error }}
                  </p>
                  <div
                    v-if="item.activities.length"
                    class="mt-2 flex flex-wrap gap-1"
                  >
                    <span
                      v-for="(activity, index) in item.activities"
                      :key="`${activity.toolName}-${index}`"
                      class="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[10px]"
                      >{{ displayTool(activity) }} ·
                      {{ stateLabel(activity) }}</span
                    >
                  </div>
                </article>
              </div>
            </details>
            <details
              v-if="message.role === 'assistant' && message.activities?.length"
              class="group mt-2 overflow-hidden rounded-lg border border-[var(--border)]/80 bg-[var(--surface)]/92 text-[11px] shadow-[0_4px_14px_rgba(15,23,42,0.035)]"
              :open="shouldExpand(message.activities)"
            >
              <summary
                class="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-muted)]"
              >
                <span
                  class="grid h-5 w-5 place-items-center rounded-md bg-[var(--accent-soft)] text-[9px] font-black text-[var(--accent)]"
                  >⌘</span
                ><span class="min-w-0">
                  <strong class="block text-[11px] font-semibold leading-4 text-[var(--text)]"
                    >执行过程</strong
                  ><span class="block text-[10px] leading-3.5"
                    >{{ message.activities.length }} 步 ·
                    {{ completedCount(message.activities) }} 已完成<span v-if="elapsedLabel(message.elapsedMs)"> · 耗时 {{ elapsedLabel(message.elapsedMs) }}</span></span
                  ></span
                ><span
                  v-if="
                    message.activities.some((item) => item.status === 'running')
                  "
                  :class="[
                    'ml-auto rounded-full px-2 py-0.5 text-[9px] font-semibold',
                    activityOutcome(message).tone === 'accent'
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : activityOutcome(message).tone === 'danger'
                        ? 'bg-rose-500/10 text-rose-600'
                        : activityOutcome(message).tone === 'warn'
                          ? 'bg-amber-500/10 text-amber-700'
                          : 'bg-emerald-500/10 text-emerald-600',
                  ]"
                  >{{ activityOutcome(message).label }}</span
                ><span class="transition-transform group-open:rotate-180"
                  >⌄</span
                >
              </summary>
              <ol class="space-y-0.5 border-t border-[var(--border)] p-1">
                <li
                  v-for="(activity, index) in message.activities"
                  :key="`${activity.toolName}-${index}`"
                  :class="[
                    'relative overflow-hidden rounded-md border px-1.5 py-1 shadow-sm transition-all',
                    activity.status === 'running'
                      ? 'border-[var(--accent)]/20 bg-[var(--accent-soft)]/55'
                      : activity.status === 'failed'
                        ? 'border-rose-500/20 bg-rose-500/5'
                        : 'border-emerald-500/15 bg-emerald-500/5',
                  ]"
                >
                  <div class="flex items-start gap-1">
                    <span
                      :class="[
                        'grid h-4 w-4 shrink-0 place-items-center rounded text-[8px] font-black',
                        activity.status === 'running'
                          ? 'bg-[var(--accent)] text-white'
                          : activity.status === 'failed'
                            ? 'bg-rose-500 text-white'
                            : 'bg-emerald-500 text-white',
                      ]"
                    >{{ String(index + 1).padStart(2, '0') }}</span>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between gap-2">
                        <strong class="text-[10px] font-medium leading-4 tracking-[0.01em]">{{
                          displayTool(activity)
                        }}</strong
                        ><span
                          :class="[
                            'shrink-0 rounded-full px-1.5 py-0 text-[8px] font-semibold',
                            activity.status === 'failed'
                              ? 'bg-rose-500/10 text-rose-600'
                              : activity.status === 'running'
                                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                                : 'bg-emerald-500/10 text-emerald-600',
                          ]"
                          >{{ stateLabel(activity) }}</span
                        >
                      </div>
                      <p class="mt-0.5 break-words text-[10px] leading-3.5 text-[var(--muted)]">
                        {{ activity.summary }}
                      </p>
                    </div>
                  </div>
                </li>
              </ol>
            </details>
            <section
              v-if="message.role === 'assistant' && message.approvals?.length"
              class="mt-2 space-y-2"
            >
              <article
                v-for="item in message.approvals"
                :key="approvalKey(item)"
                class="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs"
              >
                <p class="font-bold text-amber-700">
                  需要你的批准 · {{ approvalLabel[item.capability] }}
                </p>
                <p class="mt-1 text-[var(--muted)]">{{ item.summary }}</p>
                <div class="mt-3 flex gap-2">
                  <button
                    class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 font-semibold text-white disabled:opacity-50"
                    :disabled="approving === approvalKey(item)"
                    @click="approve(item, 'session')"
                  >
                    仅本会话允许</button
                  ><button
                    class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 font-semibold"
                    :disabled="approving === approvalKey(item)"
                    @click="approve(item, 'always')"
                  >
                    始终允许
                  </button>
                </div>
              </article>
            </section>
            <section
              v-if="message.role === 'assistant' && message.sources?.length"
              class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div class="mb-2 flex items-center gap-2 text-xs"><span class="grid h-5 w-5 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]">↗</span><strong>联网来源</strong><span class="text-[var(--muted)]">{{ message.sources.length }} 个可核查链接</span></div>
              <div class="space-y-1.5">
                <a v-for="source in message.sources" :key="source.url" :href="source.url" target="_blank" rel="noreferrer" class="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-muted)] px-2.5 py-2 text-xs hover:text-[var(--accent)]"><span class="min-w-0 truncate">{{ source.title }}</span><span class="shrink-0 text-[10px] text-[var(--muted)]">{{ source.source || source.provider }} ↗</span></a>
              </div>
            </section>
            <section
              v-if="message.role === 'assistant' && message.assets?.length"
              class="mt-3 space-y-2"
            >
              <article
                v-for="asset in message.assets"
                :key="asset.id"
                class="flex items-center gap-3 rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-soft)]/45 p-3"
              >
                <span
                  class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--surface)] text-[10px] font-extrabold text-[var(--accent)]"
                  >{{ assetType(asset) }}</span
                >
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-bold">{{ asset.name }}</p>
                  <p class="mt-0.5 text-xs text-[var(--muted)]">
                    已归档至资产库 · {{ assetType(asset) }} ·
                    {{ formatBytes(asset.sizeBytes) }}
                  </p>
                </div>
                <div class="flex shrink-0 gap-2">
                  <button
                    class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold hover:border-[var(--accent)]"
                    type="button"
                    @click="downloadAsset(asset)"
                  >
                    下载</button
                  ><button
                    class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-white"
                    type="button"
                    @click="emit('openAssets')"
                  >
                    资产库
                  </button>
                </div>
              </article>
            </section>
          </div>
        </article>
        <ChatReplyPending
          v-if="showStandalonePending && !pendingAssistantId"
          :accent="employee.color"
        />
      </div>
      </div>
      <div
        v-if="showScheduleRail && activeScheduleMessage?.schedule"
        class="hidden min-h-0 w-[272px] shrink-0 py-9 xl:flex"
      >
        <ChatAutoScheduleRail
          class="w-full"
          :schedule="activeScheduleMessage.schedule"
          :employees="employees"
          @select-task="selectScheduleTask"
        />
      </div>
    </div>

    <div class="mx-auto mb-7 w-full max-w-[1560px] shrink-0 px-6 lg:px-10">
      <form
        class="relative grid gap-2 rounded-[19px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg"
        @submit.prevent="submit"
      >
        <textarea
          v-model="draft"
          rows="3"
          class="min-h-[76px] w-full resize-y border-0 bg-transparent p-0 outline-none"
          :placeholder="t('chat.placeholder')"
          :disabled="!modelConfigured || sending"
          @input="handleDraftInput"
          @keydown="handleDraftKeydown"
        ></textarea>
        <div
          v-if="mentionMenuOpen"
          class="absolute bottom-[104px] left-4 z-30 w-[280px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
        >
          <div class="border-b border-[var(--border)] px-3 py-2">
            <p class="text-xs font-bold">@ 添加协作者</p>
            <p class="mt-1 text-[11px] text-[var(--muted)]">
              选择一位未加入本轮的数字员工
            </p>
          </div>
          <div class="max-h-52 overflow-y-auto p-2">
            <button
              v-for="item in availableMentionEmployees"
              :key="item.id"
              :class="[
                'flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]',
                availableMentionEmployees[mentionActiveIndex]?.id === item.id
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : '',
              ]"
              type="button"
              @click="chooseMention(item.id)"
            >
              <span
                class="grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white"
                :style="{ background: item.color }"
                >{{ item.initials }}</span
              ><span class="min-w-0 flex-1"
                ><strong class="block">{{ employeeDisplayName(item, t) }}</strong
                ><small
                  class="block truncate text-[11px] text-[var(--muted)]"
                  >{{ employeeDisplayDescription(item, t) }}</small
                ></span
              >
            </button>
            <p
              v-if="!availableMentionEmployees.length"
              class="px-2 py-3 text-xs text-[var(--muted)]"
            >
              可协作的员工均已加入本轮。
            </p>
          </div>
        </div>
        <div v-if="collaboratorIds.length" class="flex flex-wrap gap-1.5">
          <span
            v-for="id in collaboratorIds"
            :key="id"
            class="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-xs font-semibold text-[var(--accent)]"
            >◎ {{ collaboratorName(id)
            }}<button
              class="ml-0.5 text-sm leading-none"
              type="button"
              @click="toggleCollaborator(id)"
            >
              ×
            </button></span
          ><select
            v-if="collaboratorIds.length === 1"
            v-model="collaborationDelivery"
            class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1 text-xs font-semibold"
          >
            <option value="synthesize">交付：主员工整合</option>
            <option value="direct">交付：专家直接答复</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <div class="relative">
            <button
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              :disabled="sending || autoSchedule"
              :title="autoSchedule ? t('chat.autoScheduleBlocksCollaborators') : undefined"
              @click="collaboratorMenuOpen = !collaboratorMenuOpen"
            >
              ◎ 添加协作者<span
                v-if="collaboratorIds.length"
                class="ml-1 text-[var(--accent)]"
                >{{ collaboratorIds.length }}</span
              ></button
            ><button
              v-if="collaboratorMenuOpen && !autoSchedule"
              class="fixed inset-0 z-10 cursor-default"
              aria-label="关闭协作者选择"
              type="button"
              @click="closeCollaboratorMenu"
            />
            <div
              v-if="collaboratorMenuOpen && !autoSchedule"
              class="absolute bottom-11 left-0 z-20 w-[280px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
            >
              <div class="border-b border-[var(--border)] px-3 py-2.5">
                <p class="text-xs font-bold">选择本轮协作者</p>
                <p
                  class="mt-1 break-words whitespace-normal text-[11px] leading-4 text-[var(--muted)]"
                >
                  协作者按员工职责分工，以隔离、只读上下文提供分析；主员工会统一整理最终答复。
                </p>
              </div>
              <div class="max-h-60 overflow-y-auto p-2">
                <button
                  v-for="item in employees.filter(
                    (item) => item.id !== selectedEmployeeId,
                  )"
                  :key="item.id"
                  :class="[
                    'flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]',
                    collaboratorIds.includes(item.id)
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : '',
                  ]"
                  type="button"
                  @click="toggleCollaborator(item.id)"
                >
                  <span
                    class="grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white"
                    :style="{ background: item.color }"
                    >{{ item.initials }}</span
                  ><span class="min-w-0 flex-1"
                    ><strong class="block">{{ employeeDisplayName(item, t) }}</strong
                    ><small
                      class="block truncate text-[11px] text-[var(--muted)]"
                      >{{ employeeDisplayDescription(item, t) }}</small
                    ></span
                  ><span v-if="collaboratorIds.includes(item.id)">✓</span>
                </button>
              </div>
              <div
                class="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface-muted)]/60 px-3 py-2"
              >
                <span class="text-[10px] text-[var(--muted)]"
                  >已选 {{ collaboratorIds.length }} / 3</span
                ><button
                  class="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white"
                  type="button"
                  @click="closeCollaboratorMenu"
                >
                  完成选择
                </button>
              </div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="autoSchedule"
            :disabled="sending"
            :title="t('chat.autoScheduleHelp')"
            :class="[
              'group inline-flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-semibold transition',
              autoSchedule
                ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_0_0_0_1px_rgba(59,130,246,0.12)]'
                : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)] hover:border-[var(--accent)]/35',
              sending ? 'cursor-not-allowed opacity-50' : '',
            ]"
            @click="toggleAutoSchedule"
          >
            <span
              :class="[
                'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition',
                autoSchedule ? 'bg-[var(--accent)]' : 'bg-[var(--border)]',
              ]"
            >
              <span
                :class="[
                  'absolute h-3 w-3 rounded-full bg-white shadow transition',
                  autoSchedule ? 'translate-x-3.5' : 'translate-x-0.5',
                ]"
              />
            </span>
            <span>{{ t('chat.autoSchedule') }}</span>
          </button>
          <label
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2 text-xs font-semibold"
            :title="t('chat.onlineSearchHelp')"
          >
            <input v-model="onlineSearch" type="checkbox" :disabled="sending" />
            <span :class="onlineSearch ? 'text-[var(--accent)]' : 'text-[var(--muted)]'">{{ t('chat.onlineSearch') }}</span>
          </label>
          <select
            v-if="availableModels.length"
            class="max-w-[min(100%,280px)] truncate rounded-lg bg-[var(--surface-muted)] px-2 py-2 text-xs"
            :value="chatEndpointToken"
            @change="
              handleEndpointChange($event)
            "
          >
            <option
              v-for="item in availableModels"
              :key="item.id"
              :value="item.id"
            >
              {{ item.providerLabel }} · {{ item.chatModel }}
            </option></select
          ><button
            v-if="sending"
            type="button"
            class="ml-auto grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--danger,#c0392b)] text-sm font-semibold text-white"
            :title="t('chat.stop')"
            @click="stopGeneration"
          >
            ■
          </button>
          <button
            v-else
            type="submit"
            class="ml-auto grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--accent)] text-xl text-white disabled:opacity-35"
            :disabled="!draft.trim() || !modelConfigured"
          >
            ↑
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
