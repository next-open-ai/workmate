<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  Employee,
  EmployeeId,
  ProjectTaskTranscript,
  ProjectTaskDraft,
} from "../../app/workspace.js";
import type { AuthUser } from "../../services/auth.js";
import type { ProjectDraftResult } from "../../app/project-planning.js";
import { employeeDisplayName } from "../../app/employees.js";
import type { ProviderConfig, ProviderId } from "../../app/model-config.js";
import { useModelConfig } from "../../app/model-config.js";
import { createManagedWorkspace, materializeWorkspaceAssets, syncWorkspaceRun, type ToolActivity, type ToolApproval } from "../../services/api.js";
import { useCapabilities } from "../../app/capabilities.js";
import { useEmployeeRuntimePrefs } from "../../app/employee-prefs.js";
import { useMcpConfig, isAssociableMcp } from "../../app/mcp-config.js";
import { readStored, writeStored } from "../../app/storage.js";
import {
  useProjects,
  type Project,
  type ProjectMessage,
  type ProjectMode,
  type ProjectTask,
  type ProjectTaskInput,
} from "../../app/projects.js";
import { useProjectTemplates } from "../../app/project-templates.js";
import { buildDependencyBlock, buildSummaryEvidence, fitObjective } from "../../app/context-budget.js";
import ProjectConversationWorkspace from "./ProjectConversationWorkspace.vue";
import ProjectDagPreview from "./ProjectDagPreview.vue";
import * as orch from "../../services/orchestration.js";
import { isDesktopShell } from "../../app/platform.js";
import { getCurrentUser, listLocalUsers } from "../../services/auth.js";

type Transcript = ProjectTaskTranscript;
const props = defineProps<{
  employees: Employee[];
  models: ProviderConfig[];
  generateDraft: (
    goal: string,
    model: ProviderConfig,
    options?: { employeeIds?: EmployeeId[]; preferredMode?: ProjectMode },
  ) => Promise<ProjectDraftResult | ProjectTaskDraft[]>;
  runTask: (
    input: {
      projectId: string;
      taskId: string;
      prompt: string;
      employeeId: EmployeeId;
      skillIds: string[];
      permissionTier: "read-only" | "default" | "full";
      model: ProviderConfig;
      workspacePath?: string;
    },
    onActivity?: (activity: ToolActivity) => void,
    onDelta?: (delta: string) => void,
  ) => Promise<Transcript>;
}>();
const { load: loadSkills, allowedSkillsFor } = useCapabilities();
const { load: loadRuntimePrefs, get: getRuntimePrefs } = useEmployeeRuntimePrefs();
const { connections: mcpConnections, load: loadMcp } = useMcpConfig();
const { templates: savedTemplates, load: loadProjectTemplates, save: saveProjectTemplate, remove: removeProjectTemplate } = useProjectTemplates();
const {
  projects,
  runs,
  load,
  createDraft,
  update,
  remove,
  createRun,
  finishRun,
} = useProjects();

/* ------------------------------------------------------------------ *
 * M0 managed (server-orchestrated) projects.
 *
 * New projects created from this page live on the orchestration server
 * (`/api/orch/projects`); the server owns scheduling, approvals and durable
 * state — the page only mirrors it (poll + on-demand transcript hydration).
 * Legacy local projects keep the original scheduler below.
 * ------------------------------------------------------------------ */
const managedPollers = new Map<string, ReturnType<typeof setInterval>>();
const managedPollCounts = new Map<string, number>();
function stopManagedPoll(projectId: string) {
  const timer = managedPollers.get(projectId);
  if (timer) clearInterval(timer);
  managedPollers.delete(projectId);
  managedPollCounts.delete(projectId);
}
const hydratedKeys = new Set<string>();

function managedProvider(): ProviderId {
  return props.models[0]?.provider ?? "openai";
}
function managedModel(): string {
  return props.models[0]?.chatModel ?? "";
}

function serverToTranscript(run: orch.ServerRunRecord): Transcript {
  return {
    assistantContent: run.transcript,
    reasoningContent: run.reasoning,
    activities: run.activities.map((activity) => ({
      toolName: activity.toolName,
      summary: activity.summary,
      status:
        activity.status === "completed" || activity.status === "failed"
          ? activity.status
          : ("running" as const),
    })),
    approvals: run.approvals.map((approval) => ({
      skillId: approval.skillId,
      capability: approval.capability,
      summary: approval.summary,
    })),
    assets: run.artifacts
      .filter((artifact) => artifact.assetId)
      .map((artifact) => ({
        id: artifact.assetId!,
        name: artifact.assetName || artifact.path,
        sizeBytes: artifact.assetSizeBytes ?? 0,
        runId: run.id,
      })),
    ...(run.sources?.length ? { sources: run.sources } : {}),
    ...(run.usage ? { usage: run.usage } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.eventLog?.length
      ? {
          trace: run.eventLog
            .filter((event) => event.type !== "message.delta")
            .map((event) => ({
              type: event.type,
              ...(event.toolName ? { toolName: event.toolName } : {}),
              ...(event.summary ? { summary: event.summary } : {}),
              ...(event.message ? { message: event.message } : {}),
              ...(event.reason ? { reason: event.reason } : {}),
            })),
        }
      : {}),
    runId: run.id,
  };
}

/** Server project → local Project mirror (keeps previously hydrated data). */
function adoptServerProject(sp: orch.ServerProject, previous?: Project): Project {
  const provider: ProviderId = (sp.coordinator?.provider ?? managedProvider()) as ProviderId;
  const model = sp.coordinator?.model ?? managedModel();
  const previousTasks = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  const previousMessages = previous?.messages ?? [];
  const project: Project = {
    id: sp.id,
    orgId: sp.orgId,
    ownerUserId: sp.ownerUserId,
    userId: sp.userId,
    name: sp.name,
    goal: sp.goal,
    status: sp.status,
    accessScope: sp.accessScope ?? "private",
    accessGrants: sp.accessGrants ?? [],
    coordinatorProvider: provider,
    coordinatorModel: model,
    mode: sp.mode,
    workspacePath: sp.workspacePath,
    tasks: sp.tasks.map((task) => {
      const old = previousTasks.get(task.id);
      const sameAttempt = Boolean(old?.runId && task.runId && old.runId === task.runId);
      const transcript = sameAttempt && old?.transcript ? old.transcript : undefined;
      return {
        id: task.id,
        title: task.title,
        objective: task.objective,
        employeeId: task.employeeId,
        provider,
        model,
        skillIds: task.skillIds ?? [],
        dependsOn: task.dependsOn ?? [],
        permissionTier: task.permissionTier ?? "default",
        status: task.status,
        attempts: task.attempts ?? 0,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        transcript,
        runId: task.runId,
        error: task.error,
        contract: task.contract,
        planVersion: task.planVersion,
      };
    }),
    messages: [],
    createdAt: sp.createdAt,
    updatedAt: sp.updatedAt,
    activeRunId: sp.activeRunId,
    summary: sp.summary,
    plan: sp.plan,
    planHistory: sp.planHistory,
    changeSets: sp.changeSets,
    managedServer: true,
  };
  const runChanged = Boolean(previous?.activeRunId && sp.activeRunId && previous.activeRunId !== sp.activeRunId);
  if (runChanged || !previousMessages.length) {
    for (const message of sp.messages) {
      project.messages.push({
        id: message.id,
        role: message.role,
        content: message.content,
        employeeId: message.employeeId,
        taskId: message.taskId,
        createdAt: message.createdAt,
        runId: message.runId ?? sp.activeRunId,
        assets: [],
        activities: [],
      });
    }
  } else {
    const known = new Map(previousMessages.map((message) => [message.id, message]));
    for (const message of sp.messages) {
      const old = known.get(message.id);
      if (old) {
        project.messages.push({
          ...old,
          content: message.content || old.content,
          runId: message.runId ?? old.runId ?? sp.activeRunId,
        });
      } else {
        project.messages.push({
          id: message.id,
          role: message.role,
          content: message.content,
          employeeId: message.employeeId,
          taskId: message.taskId,
          createdAt: message.createdAt,
          runId: message.runId ?? sp.activeRunId,
          assets: [],
          activities: [],
        });
      }
    }
  }
  return project;
}

async function refreshManaged(projectId: string): Promise<boolean> {
  const count = (managedPollCounts.get(projectId) ?? 0) + 1;
  managedPollCounts.set(projectId, count);
  // 防失控：超过约 15 分钟仍未结束则停轮询，避免无限刷请求。
  if (count > 1200) { stopManagedPoll(projectId); return false; }
  const sp = await orch.getProject(projectId);
  const index = projects.value.findIndex((item) => item.id === projectId);
  if (!sp || index < 0) { stopManagedPoll(projectId); return false; }

  // Always adopt server truth first. Previously we returned early when
  // `activeRunId` was cleared at finish — local UI stayed stuck on「执行中」.
  const next = adoptServerProject(sp, projects.value[index]);
  projects.value = [...projects.value.slice(0, index), next, ...projects.value.slice(index + 1)];

  for (const task of next.tasks) {
    if (task.status === "completed" && !task.transcript) {
      void hydrateManagedTask(next, task.id);
    } else if (task.status === "failed" && !task.transcript && task.runId) {
      void hydrateManagedTask(next, task.id);
    } else if (task.status === "running" && task.runId) {
      void hydrateManagedTask(next, task.id, { allowRefresh: true });
    } else if (task.status === "running" && /等待审批|approval/i.test(task.error ?? "")) {
      void hydratePendingApprovals(next, task);
    }
  }

  const settled =
    !sp.activeRunId ||
    sp.status === "completed" ||
    sp.status === "failed" ||
    sp.status === "cancelled";
  if (settled) {
    await finishManagedRun(next);
    stopManagedPoll(projectId);
    return false;
  }
  return sp.status === "running";
}

async function hydrateManagedTask(
  project: Project,
  taskId: string,
  options: { allowRefresh?: boolean } = {},
): Promise<void> {
  const key = `${project.id}:${taskId}`;
  if (hydratedKeys.has(key) && !options.allowRefresh) return;
  if (!options.allowRefresh) hydratedKeys.add(key);
  const task = project.tasks.find((item) => item.id === taskId);
  const run = task ? await orch.projectTranscript(project.id, taskId) : null;
  if (!task || !run) {
    if (!options.allowRefresh) hydratedKeys.delete(key);
    return;
  }
  // Running tasks with empty checkpoints stay quiet until progress lands.
  if (run.status === "running" && !run.transcript && !(run.activities?.length) && !(run.artifacts?.length)) {
    return;
  }
  if (!options.allowRefresh) hydratedKeys.add(key);
  else if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    hydratedKeys.add(key);
  }
  task.transcript = serverToTranscript(run);
  task.runId = run.id;
  const existingMsg = project.messages.find(
    (message) => message.taskId === taskId && message.role === "assistant",
  );
  if (existingMsg) {
    // Finalize the live-streamed message with the authoritative transcript.
    existingMsg.content = run.transcript || existingMsg.content;
    existingMsg.reasoning = run.reasoning || existingMsg.reasoning;
    existingMsg.activities = task.transcript.activities;
    existingMsg.assets = task.transcript.assets;
  } else {
    project.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      employeeId: task.employeeId,
      taskId,
      content: run.transcript || "(无文本输出)",
      reasoning: run.reasoning || "",
      assets: task.transcript.assets,
      activities: task.transcript.activities,
      createdAt: Date.now(),
    });
  }
  if (project.workspacePath && run.id) {
    try {
      await syncWorkspaceRun(project.workspacePath, run.id);
    } catch {
      /* keep going even if folder sync fails */
    }
  }
  projects.value = [...projects.value];
}

async function finishManagedRun(project: Project): Promise<void> {
  const index = projects.value.findIndex((item) => item.id === project.id);
  if (index < 0) return;
  const current = projects.value[index];
  const stop = managedPollers.get(project.id);
  if (stop) {
    clearInterval(stop);
    managedPollers.delete(project.id);
  }
  stopManagedStream(project.id);
  if (!current.summary && (current.status === "completed" || current.status === "failed")) {
    const completed = current.tasks.filter((task) => task.status === "completed").length;
    const failed = current.tasks.filter((task) => task.status === "failed").length;
    current.summary = failed
      ? `项目已结束：${completed} 项任务完成，${failed} 项失败。${current.tasks.find((task) => task.error)?.error ?? ""}`
      : `项目已完成：${completed} 项任务成功。`;
    if (!current.messages.some((message) => message.role === "system" && message.content.startsWith("本轮调度已结束"))) {
      current.messages.push({
        id: crypto.randomUUID(),
        role: "system",
        content: "本轮调度已结束，服务端已完成任务编排。",
        createdAt: Date.now(),
      });
    }
    projects.value = [...projects.value];
  }
}

/* ------------------------------------------------------------------ *
 * Live streaming per-task process info (managed projects).
 *
 * The server publishes run deltas/activities/artifacts on the project topic
 * (`GET /events?project=`). We subscribe while the project is running and
 * mirror them into the local tasks + conversation messages so the member's
 * thinking/activity shows live instead of only after the task settles.
 * The 800ms poll remains the source of truth for task status; this live pass
 * is purely additive (delta text + activity/approval/asset progress).
 * ------------------------------------------------------------------ */
const managedStreams = new Map<string, () => void>();

function stopManagedStream(projectId: string): void {
  const stop = managedStreams.get(projectId);
  if (stop) {
    stop();
    managedStreams.delete(projectId);
  }
}

function startManagedStream(projectId: string): void {
  if (managedStreams.has(projectId)) return;
  const stop = orch.subscribeProjectEvents(projectId, (event) => {
    applyManagedEvent(projectId, event);
  });
  managedStreams.set(projectId, stop);
}

function taskForEvent(project: Project, event: orch.OrcEvent): ProjectTask | undefined {
  return project.tasks.find(
    (task) =>
      (event.taskId && task.id === event.taskId) ||
      (event.runId && task.runId === event.runId),
  );
}

function ensureTaskTranscript(task: ProjectTask): NonNullable<ProjectTask["transcript"]> {
  if (!task.transcript) {
    task.transcript = {
      assistantContent: "",
        reasoningContent: "",
      activities: [],
      approvals: [],
      assets: [],
      runId: task.runId,
    };
  }
  return task.transcript;
}

function ensureTaskMessage(project: Project, task: ProjectTask): ProjectMessage {
  const existing = project.messages.find(
    (message) =>
      message.taskId === task.id
      && message.role === "assistant"
      && (!project.activeRunId || !message.runId || message.runId === project.activeRunId),
  );
  if (existing) return existing;
  const message: ProjectMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    employeeId: task.employeeId,
    taskId: task.id,
    content: "",
    activities: [],
    assets: [],
    createdAt: Date.now(),
    runId: project.activeRunId,
  };
  project.messages.push(message);
  return message;
}

function bumpProject(): void {
  projects.value = [...projects.value];
}

function applyManagedEvent(projectId: string, event: orch.OrcEvent): void {
  const project = projects.value.find((item) => item.id === projectId);
  if (!project || project.status !== "running") return;
  const task = taskForEvent(project, event);
  if (!task) return;

  if (event.type === "run.started") {
    // A new attempt is beginning: reset the previous attempt's streamed state so
    // an approval-resumed (or retried) run does not append onto stale content.
    if (task.transcript && (task.transcript.assistantContent || task.transcript.activities.length)) {
      task.transcript.assistantContent = "";
      task.transcript.reasoningContent = "";
      task.transcript.activities = [];
      task.transcript.approvals = [];
      task.transcript.assets = [];
    }
    const message = project.messages.find((m) => m.taskId === task.id && m.role === "assistant");
    if (message) {
      message.content = "";
      message.reasoning = "";
      message.activities = [];
      message.approvals = [];
      message.assets = [];
    }
    bumpProject();
  } else if (event.type === "run.delta" && event.text) {
    const transcript = ensureTaskTranscript(task);
    transcript.assistantContent += event.text;
    const message = ensureTaskMessage(project, task);
    message.content += event.text;
    bumpProject();
  } else if (event.type === "run.reasoning.delta" && event.text) {
    const transcript = ensureTaskTranscript(task);
    transcript.reasoningContent = `${transcript.reasoningContent || ""}${event.text}`;
    const message = ensureTaskMessage(project, task);
    message.reasoning = `${message.reasoning || ""}${event.text}`;
    bumpProject();
  } else if (event.type === "run.activity" && event.activity) {
    const transcript = ensureTaskTranscript(task);
    const activity = event.activity;
    const existing = transcript.activities.find(
      (item) => item.toolName === activity.toolName && item.status === "running",
    );
    if (existing && activity.status !== "running") Object.assign(existing, activity);
    else transcript.activities.push({ toolName: activity.toolName, summary: activity.summary, status: activity.status });
    const message = ensureTaskMessage(project, task);
    message.activities = [...transcript.activities];
    bumpProject();
  } else if (event.type === "run.approval" && event.approval) {
    const transcript = ensureTaskTranscript(task);
    const approval = event.approval;
    if (!transcript.approvals.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) {
      transcript.approvals.push({ id: approval.id, skillId: approval.skillId, capability: approval.capability, summary: approval.summary });
    }
    const message = ensureTaskMessage(project, task);
    message.approvals = [...transcript.approvals];
    bumpProject();
  } else if (event.type === "run.artifact" && event.artifact && event.runId) {
    bumpProject();
  } else if (event.type === "project.file.published") {
    fileTreeEpoch.value += 1;
    bumpProject();
  } else if (event.type === "project.task" && event.taskId && event.status) {
    const target = project.tasks.find((task) => task.id === event.taskId);
    if (target && target.status !== event.status) target.status = event.status as ProjectTask["status"];
    bumpProject();
  }
}

const pendingApprovalFetched = new Set<string>();

/** Surface pending approvals for an already-parked task (e.g. after reload). */
async function hydratePendingApprovals(project: Project, task: ProjectTask): Promise<void> {
  if (!task.runId || pendingApprovalFetched.has(task.runId)) return;
  pendingApprovalFetched.add(task.runId);
  const run = await orch.projectTranscript(project.id, task.id).catch(() => null);
  if (!run) return;
  const pending = run.approvals.filter((approval) => approval.status === "pending");
  if (!pending.length) return;
  const transcript = ensureTaskTranscript(task);
  for (const approval of pending) {
    if (!transcript.approvals.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) {
      transcript.approvals.push({ id: approval.id, skillId: approval.skillId, capability: approval.capability, summary: approval.summary });
    }
  }
  const message = ensureTaskMessage(project, task);
  message.approvals = [...transcript.approvals];
  bumpProject();
}

async function loadManagedProjects(): Promise<void> {
  const server = await orch.listProjects().catch(() => [] as orch.ServerProject[]);
  if (!server.length) return;
  const byId = new Map(projects.value.map((project) => [project.id, project]));
  const next = [...projects.value];
  const seen = new Set<string>();
  for (const sp of server) {
    seen.add(sp.id);
    const existingIndex = next.findIndex((item) => item.id === sp.id);
    const adopted = adoptServerProject(sp, existingIndex >= 0 ? next[existingIndex] : undefined);
    if (existingIndex >= 0) next[existingIndex] = adopted;
    else next.unshift(adopted);
    if (sp.status === "running") {
      managedPollers.set(
        sp.id,
        setInterval(() => void refreshManaged(sp.id), 800),
      );
      startManagedStream(sp.id);
    }
  }
  projects.value = next.filter((project) => !project.managedServer || seen.has(project.id));
}

async function runManagedProject(project: Project): Promise<void> {
  error.value = "";
  try {
    await orch.confirmProject(project.id);
    await refreshManaged(project.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "服务端编排启动失败。";
    // 启动失败仍为草稿：允许下次进入对话时再次自动尝试。
    autoStartedDrafts.delete(project.id);
    return;
  }
  const existing = managedPollers.get(project.id);
  if (existing) clearInterval(existing);
  managedPollers.set(
    project.id,
    setInterval(() => void refreshManaged(project.id), 3000),
  );
  startManagedStream(project.id);
}

async function cancelManagedProject(project: Project): Promise<void> {
  try {
    await orch.cancelProject(project.id);
  } catch {
    /* the poll will reflect server truth */
  }
  await refreshManaged(project.id);
}

async function resolveManagedApproval(input: { taskId: string; approvalId: string; allow: boolean; scope: "session" | "always" }): Promise<void> {
  const project = selected.value;
  if (!project || !project.managedServer) return;
  try {
    await orch.resolveTaskApproval({
      projectId: project.id,
      taskId: input.taskId,
      approvalId: input.approvalId,
      allow: input.allow,
      scope: input.scope,
    });
  } catch {
    /* surface via refresh below */
  }
  // Drop the resolved approval from the local mirror so the card disappears.
  const task = project.tasks.find((item) => item.id === input.taskId);
  if (task?.transcript) task.transcript.approvals = task.transcript.approvals.filter((item) => item.id !== input.approvalId);
  const message = project.messages.find((m) => m.taskId === input.taskId);
  if (message?.approvals) message.approvals = message.approvals.filter((item) => item.id !== input.approvalId);
  projects.value = [...projects.value];
  await refreshManaged(project.id);
}

async function deleteProject(project: Project | null): Promise<void> {
  if (!project) return;
  if (project.managedServer) {
    const stop = managedPollers.get(project.id);
    if (stop) {
      clearInterval(stop);
      managedPollers.delete(project.id);
    }
    stopManagedStream(project.id);
    await orch.deleteProject(project.id).catch(() => undefined);
  }
  await remove(project.id);
}

const tab = ref<"projects" | "runs">("projects");
const selectedId = ref<string | null>(null);
/** Bumped when agents publish files into the shared project workspace. */
const fileTreeEpoch = ref(0);
const creating = ref(false);
const createMethod = ref<"blank" | "template">("blank");
const createStep = ref<1 | 2>(1);
const planning = ref(false);
const savingTemplate = ref(false);
const error = ref("");
const name = ref("");
const goal = ref("");
const mode = ref<ProjectMode>("dag");
const coordinatorId = ref<string>(props.models[0]?.id ?? "");
const coordinator = computed(
  () => props.models.find((item) => item.id === coordinatorId.value) ?? props.models[0] ?? null,
);
const workspaceParent = ref("");
const selectedTemplateId = ref("");
const templateName = ref("");
const draftTasks = ref<ProjectTaskInput[]>([]);
const detailTaskId = ref<string | null>(null);
const accessScope = ref<"private" | "org-shared" | "delegated">("private");
const delegatedPermissions = ref<Record<string, "read" | "write">>({});
const localUsers = ref<AuthUser[]>([]);
const currentUserId = ref<string>("");
const visibilityFilter = ref<"all" | "mine" | "org-shared" | "delegated">("all");
const searchQuery = ref("");
const desktopBridge = () => (window as Window & { workmateDesktop?: any }).workmateDesktop;
const shareableUsers = computed(() =>
  localUsers.value.filter((item) => item.id !== currentUserId.value),
);
function isOwnedByCurrentUser(project: Project) {
  const ownerId = project.ownerUserId ?? project.userId;
  return Boolean(ownerId && ownerId === currentUserId.value);
}
function isOrgSharedProject(project: Project) {
  return project.accessScope === "org-shared";
}
function isDelegatedToCurrentUser(project: Project) {
  if (isOwnedByCurrentUser(project)) return false;
  if (project.accessScope !== "delegated") return false;
  return (project.accessGrants ?? []).some((grant) => grant.subjectType === "user" && grant.subjectId === currentUserId.value);
}
function matchesProjectSearch(project: Project) {
  const keyword = searchQuery.value.trim().toLowerCase();
  if (!keyword) return true;
  const haystack = [
    project.name,
    project.goal,
    ...project.tasks.map((task) => task.title),
    ...project.tasks.map((task) => task.objective),
    ...project.tasks.map((task) => employeeName(task.employeeId)),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(keyword);
}
const filteredProjects = computed(() =>
  projects.value.filter((project) => {
    if (!matchesProjectSearch(project)) return false;
    switch (visibilityFilter.value) {
      case "mine":
        return isOwnedByCurrentUser(project);
      case "org-shared":
        return isOrgSharedProject(project);
      case "delegated":
        return isDelegatedToCurrentUser(project);
      default:
        return true;
    }
  }),
);
const visibilityFilterOptions = computed(() => [
  { id: "all" as const, label: "全部可见", count: projects.value.length },
  { id: "mine" as const, label: "我创建的", count: projects.value.filter(isOwnedByCurrentUser).length },
  { id: "org-shared" as const, label: "组织共享", count: projects.value.filter(isOrgSharedProject).length },
  { id: "delegated" as const, label: "委托给我的", count: projects.value.filter(isDelegatedToCurrentUser).length },
]);
function summarizeNames(names: string[], emptyLabel: string) {
  if (!names.length) return emptyLabel;
  const head = names.slice(0, 2).join("、");
  return names.length > 2 ? `${head} 等 ${names.length} 项` : head;
}
function taskRuntimeSkillNames(task: { employeeId: EmployeeId; skillIds?: string[] }) {
  const scoped = new Set(task.skillIds ?? []);
  return allowedSkillsFor(task.employeeId)
    .filter((skill) => !scoped.size || scoped.has(skill.id))
    .map((skill) => skill.name);
}
function taskRuntimeMcpNames(task: { employeeId: EmployeeId }) {
  const selected = new Set(getRuntimePrefs(task.employeeId).mcpIds || []);
  return mcpConnections.value
    .filter((item) => selected.has(item.id) && isAssociableMcp(item))
    .map((item) => item.name);
}
function taskRuntimeSummary(task: { employeeId: EmployeeId; skillIds?: string[]; permissionTier?: string }) {
  const skills = taskRuntimeSkillNames(task);
  const mcps = taskRuntimeMcpNames(task);
  return {
    permissionTier: task.permissionTier ?? "default",
    skillCount: skills.length,
    mcpCount: mcps.length,
    skillSummary: summarizeNames(skills, "无额外 Skills"),
    mcpSummary: summarizeNames(mcps, "未关联 MCP"),
  };
}
const cancelling = new Set<string>();
const selected = computed(
  () => projects.value.find((item) => item.id === selectedId.value) ?? null,
);
const selectedProject = computed(() => selected.value);
function currentSelectedProject(): Project {
  if (!selectedProject.value) throw new Error("No selected project.");
  return selectedProject.value;
}
const detailTask = computed(
  () =>
    selected.value?.tasks.find((task) => task.id === detailTaskId.value) ??
    selected.value?.tasks.find((task) => task.status === "running") ??
    selected.value?.tasks[0] ??
    null,
);
const modeName = (mode?: ProjectMode) =>
  ({
    waterfall: "瀑布项目",
    parallel: "并发项目",
    discussion: "讨论项目",
    dag: "DAG 项目",
  })[mode ?? "dag"] ?? "DAG 项目";
const { modelForEmployee } = useModelConfig();
const modelLabel = (model: ProviderConfig) =>
  `${model.providerLabel || model.provider} · ${model.chatModel}`;
function employeeName(id: EmployeeId) {
  const employee = props.employees.find((item) => item.id === id);
  return employeeDisplayName(employee, (key) => ({
    'employee.general.name': '通用助理',
    'employee.research.name': '研究助理',
    'employee.code.name': '编程助理',
    'employee.administrator.name': '系统管理员',
  } as Record<string, string>)[key] || key) || id;
}
function modelFor(task: ProjectTask) {
  const byTask =
    props.models.find(
      (item) =>
        item.provider === task.provider && item.chatModel === task.model,
    ) ??
    props.models.find((item) => item.provider === task.provider) ??
    null;
  return modelForEmployee(task.employeeId, byTask) ?? byTask ?? props.models[0] ?? null;
}
function statusStyle(status: string) {
  return (
    (
      {
        draft: "bg-slate-500/10 text-slate-600",
        queued: "bg-slate-500/10 text-slate-600",
        running: "bg-blue-500/10 text-blue-600",
        completed: "bg-emerald-500/10 text-emerald-600",
        failed: "bg-rose-500/10 text-rose-600",
        cancelled: "bg-amber-500/10 text-amber-700",
      } as Record<string, string>
    )[status] ?? "bg-slate-500/10"
  );
}
function statusText(status: string) {
  return (
    (
      {
        draft: "待确认",
        queued: "等待",
        running: "执行中",
        completed: "完成",
        failed: "失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[status] ?? status
  );
}
function accessScopeLabel(scope?: "private" | "org-shared" | "delegated") {
  return scope === "org-shared" ? "组织共享" : scope === "delegated" ? "指定用户" : "仅自己";
}
function date(value?: number) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(value)
    : "—";
}
function cloneTaskDraft(task: ProjectTaskInput): ProjectTaskInput {
  return {
    ...task,
    skillIds: [...(task.skillIds ?? [])],
    dependsOn: task.dependsOn ? [...task.dependsOn] : [],
    contract: task.contract
      ? {
          outputs: task.contract.outputs ? [...task.contract.outputs] : undefined,
          acceptance: task.contract.acceptance,
          maxSteps: task.contract.maxSteps,
          timeoutMs: task.contract.timeoutMs,
          maxAttempts: task.contract.maxAttempts,
        }
      : undefined,
  };
}
function openCreate(method: "blank" | "template" = "blank", templateId = "") {
  creating.value = true;
  createMethod.value = method;
  createStep.value = 1;
  error.value = "";
  name.value = "";
  goal.value = "";
  mode.value = "dag";
  draftTasks.value = [];
  coordinatorId.value = props.models[0]?.id ?? "";
  workspaceParent.value = "";
  accessScope.value = "private";
  delegatedPermissions.value = {};
  selectedTemplateId.value = "";
  templateName.value = "";
  if (method === "template" && templateId) applySavedTemplate(templateId);
}
function closeCreate() {
  creating.value = false;
  createStep.value = 1;
  error.value = "";
}
async function continueCreate() {
  // 名称可选；描述与协调员模型必填。规划成功进入「确认运行」步骤。
  if (!goal.value.trim() || !coordinator.value) {
    error.value = "请填写项目描述并选择协调员模型。";
    return;
  }
  if (planning.value) return;
  await generateTasks();
  if (!error.value && draftTasks.value.length) createStep.value = 2;
}
function addProjectMessage(project: Project, message: ProjectMessage) {
  project.messages.push(message);
  void update(project);
}
async function generateTasks() {
  if (!goal.value.trim() || !coordinator.value) {
    error.value = "请先填写目标并选择协调员模型。";
    return;
  }
  planning.value = true;
  error.value = "";
  try {
    const raw = await props.generateDraft(goal.value, coordinator.value, {
      preferredMode: "dag",
    });
    const result: ProjectDraftResult = Array.isArray(raw)
      ? {
          tasks: raw,
          preferredMode: "dag",
          suggestedMode: "dag",
          modeFitsPreferred: true,
          modeRationale: "",
        }
      : raw;
    draftTasks.value = result.tasks.map((task, index) => ({
      ...task,
      dependsOn: task.dependsOn?.length ? task.dependsOn : [],
    }));
    mode.value = "dag";
    if (!templateName.value.trim()) templateName.value = `${name.value.trim() || goal.value.trim().slice(0, 24) || "项目"}模板`;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "生成任务草案失败。";
  } finally {
    planning.value = false;
  }
}
function toggleDelegatedUser(userId: string, checked: boolean) {
  if (checked) delegatedPermissions.value = { ...delegatedPermissions.value, [userId]: delegatedPermissions.value[userId] ?? "write" };
  else {
    const next = { ...delegatedPermissions.value };
    delete next[userId];
    delegatedPermissions.value = next;
  }
}
function handleDelegatedUserToggle(userId: string, event: Event) {
  toggleDelegatedUser(userId, (event.target as HTMLInputElement | null)?.checked === true);
}
function setDelegatedPermission(userId: string, permission: "read" | "write") {
  delegatedPermissions.value = { ...delegatedPermissions.value, [userId]: permission };
}
function handleDelegatedPermissionChange(userId: string, event: Event) {
  const value = (event.target as HTMLSelectElement | null)?.value;
  setDelegatedPermission(userId, value === "read" ? "read" : "write");
}
function delegatedAccessGrants() {
  return Object.entries(delegatedPermissions.value).map(([userId, permission]) => ({
    subjectType: "user" as const,
    subjectId: userId,
    permissions: permission === "write" ? (["read", "write"] as Array<"read" | "write">) : (["read"] as Array<"read" | "write">),
    createdAt: Date.now(),
  }));
}
async function confirmCreate() {
  if (
    !coordinator.value ||
    !goal.value.trim() ||
    !draftTasks.value.length ||
    draftTasks.value.some(
      (task) => !task.title.trim() || !task.objective.trim(),
    )
  ) {
    error.value = "请完善项目目标和所有任务。";
    return;
  }
  if (accessScope.value === "delegated" && !Object.keys(delegatedPermissions.value).length) {
    error.value = "请选择至少一位被委托用户。";
    return;
  }
  const workspacePath = isDesktopShell()
    ? (workspaceParent.value || await desktopBridge()?.createProjectWorkspace({
      name: name.value || goal.value,
    }))
    : await createManagedWorkspace(name.value);
  if (isDesktopShell() && !workspacePath) {
    error.value = "无法创建项目空间目录。";
    return;
  }
  // M0: new projects are created on the orchestration server; the page
  // mirrors server state (scheduling/persistence live server-side).
  const serverProject = await orch.createProject({
    name: name.value,
    goal: goal.value,
    mode: mode.value,
    workspacePath: workspacePath ?? '',
    accessScope: accessScope.value,
    accessGrants: accessScope.value === "delegated"
      ? delegatedAccessGrants()
      : [],
    coordinator: {
      provider: coordinator.value.provider,
      model: coordinator.value.chatModel,
    },
    tasks: (() => {
      const ids = draftTasks.value.map(() => crypto.randomUUID());
      return draftTasks.value.map((task, index) => ({
        id: ids[index],
        title: task.title,
        objective: task.objective,
        employeeId: task.employeeId,
        skillIds: task.skillIds ?? [],
        dependsOn: (task.dependsOn ?? [])
          .map((item) => ids[item])
          .filter(Boolean),
        contract: task.contract,
      }));
    })(),
  });
  const adopted = adoptServerProject(serverProject);
  projects.value = [adopted, ...projects.value];
  selectedId.value = adopted.id;
  detailTaskId.value = adopted.tasks[0]?.id ?? null;
  closeCreate();
  autoStartIfDraft(adopted);
}
async function chooseWorkspaceParent() {
  if (!isDesktopShell()) return;
  const selected = await desktopBridge()?.pickProjectDirectory();
  if (selected) workspaceParent.value = selected;
}
function applySavedTemplate(templateId: string) {
  const hit = savedTemplates.value.find((item) => item.id === templateId);
  selectedTemplateId.value = templateId;
  if (!hit) return;
  templateName.value = hit.name;
  name.value = hit.basic.projectName ?? "";
  goal.value = hit.basic.goal;
  accessScope.value = hit.basic.accessScope;
  if (hit.basic.coordinatorId && props.models.some((item) => item.id === hit.basic.coordinatorId)) {
    coordinatorId.value = hit.basic.coordinatorId;
  }
  draftTasks.value = hit.tasks.map(cloneTaskDraft);
}

function toggleDraftDependency(taskIndex: number, dependencyIndex: number) {
  if (dependencyIndex >= taskIndex) return;
  const task = draftTasks.value[taskIndex];
  if (!task) return;
  const current = new Set(task.dependsOn ?? []);
  if (current.has(dependencyIndex)) current.delete(dependencyIndex);
  else current.add(dependencyIndex);
  task.dependsOn = [...current].sort((a, b) => a - b);
}
async function saveCurrentDagAsTemplate() {
  if (!draftTasks.value.length) {
    error.value = "请先完成规划，再保存模板。";
    return;
  }
  savingTemplate.value = true;
  try {
    const saved = await saveProjectTemplate({
      id: selectedTemplateId.value || undefined,
      name: templateName.value.trim() || name.value.trim() || goal.value.trim().slice(0, 24) || "项目模板",
      basic: {
        projectName: name.value.trim() || undefined,
        goal: goal.value.trim(),
        accessScope: accessScope.value,
        coordinatorId: coordinatorId.value || undefined,
      },
      tasks: draftTasks.value.map(cloneTaskDraft),
    });
    selectedTemplateId.value = saved.id;
    templateName.value = saved.name;
  } finally {
    savingTemplate.value = false;
  }
}
async function deleteSavedTemplate(templateId: string) {
  await removeProjectTemplate(templateId);
  if (selectedTemplateId.value === templateId) {
    selectedTemplateId.value = "";
    templateName.value = "";
  }
}
const autoStartedDrafts = new Set<string>();
/** 进入项目对话即自动启动（仅草稿项目触发一次；状态离开 draft 后允许再次进入时重试）。 */
function autoStartIfDraft(project: Project | null | undefined) {
  if (!project || project.status !== "draft") return;
  if (autoStartedDrafts.has(project.id)) return;
  autoStartedDrafts.add(project.id);
  void run(project);
}

function openProject(project: Project) {
  selectedId.value = project.id;
  detailTaskId.value =
    project.tasks.find((task) => task.status === "running")?.id ??
    project.tasks[0]?.id ??
    null;
  autoStartIfDraft(project);
  // Re-sync managed projects so a finished server status is not stuck as「执行中」.
  if (project.managedServer) void refreshManaged(project.id);
}
function runSelectedProject() {
  if (selectedProject.value) void run(selectedProject.value);
}
function cancelSelectedProject() {
  if (selectedProject.value) cancel(selectedProject.value);
}
function removeSelectedProject() {
  if (!selectedProject.value) return;
  void deleteProject(selectedProject.value);
  selectedId.value = null;
}
function dispatchSelectedProject(input: { employeeId: EmployeeId; content: string }) {
  if (selectedProject.value) void dispatchProjectInstruction(selectedProject.value, input);
}
function addMemberToSelectedProject(employeeId: EmployeeId) {
  if (selectedProject.value) void addProjectMember(selectedProject.value, employeeId);
}
function removeMemberFromSelectedProject(employeeId: EmployeeId) {
  if (selectedProject.value) void removeProjectMember(selectedProject.value, employeeId);
}
function updateTask(task: ProjectTask, patch: Partial<ProjectTask>) {
  Object.assign(task, patch);
  if (selected.value) void update(selected.value);
}
function toggleSkill(task: ProjectTask, id: string) {
  updateTask(task, {
    skillIds: task.skillIds.includes(id)
      ? task.skillIds.filter((item) => item !== id)
      : [...task.skillIds, id],
  });
}
function isCancelled(project: Project) {
  return cancelling.has(project.id);
}
function cancel(project: Project) {
  if (project.managedServer) {
    void cancelManagedProject(project);
    return;
  }
  cancelling.add(project.id);
  project.tasks
    .filter((task) => task.status === "queued")
    .forEach((task) => {
      task.status = "cancelled";
    });
  void update(project);
}
function dependencyContext(project: Project, task: ProjectTask) {
  const parents = project.tasks.filter((item) =>
    task.dependsOn.includes(item.id),
  );
  return buildDependencyBlock(
    parents.map((item) => ({
      title: item.title,
      content: item.transcript?.assistantContent ?? "无可用结果",
    })),
  );
}
async function executeTask(project: Project, task: ProjectTask) {
  const model = modelFor(task);
  if (!model) {
    updateTask(task, {
      status: "failed",
      error: "该任务选择的模型未配置。",
      finishedAt: Date.now(),
    });
    return;
  }
  updateTask(task, {
    status: "running",
    startedAt: Date.now(),
    attempts: task.attempts + 1,
    error: undefined,
    transcript: {
      assistantContent: "",
      activities: [],
      approvals: [],
      assets: [],
    },
  });
  const message: ProjectMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    employeeId: task.employeeId,
    taskId: task.id,
    content: "",
    activities: [],
    assets: [],
    createdAt: Date.now(),
  };
  project.messages.push(message);
  void update(project);
  detailTaskId.value ??= task.id;
  try {
    const transcript = await props.runTask(
      {
        projectId: project.id,
        taskId: task.id,
        prompt: `项目模式：${modeName(project.mode)}\n项目目标：${project.goal}\n\n当前任务：${fitObjective(task.objective)}${dependencyContext(project, task)}\n\n请给出结构化结果：结论、关键依据、交付物/资产、风险与下一步。`,
        employeeId: task.employeeId,
        skillIds: task.skillIds,
        permissionTier: task.permissionTier,
        model,
        workspacePath: project.workspacePath,
      },
      (activity) => {
        const current = task.transcript!;
        const existing = current.activities.find(
          (item) =>
            item.toolName === activity.toolName && item.status === "running",
        );
        if (existing && activity.status !== "running")
          Object.assign(existing, activity);
        else current.activities.push(activity);
        message.activities = current.activities;
        void update(project);
      },
      (delta) => {
        task.transcript!.assistantContent += delta;
        message.content += delta;
        void update(project);
      },
    );
    updateTask(task, {
      status: "completed",
      transcript,
      finishedAt: Date.now(),
    });
    if (project.workspacePath) {
      const runIds = [...new Set([transcript.runId, ...transcript.assets.map((asset) => asset.runId)].filter((id): id is string => Boolean(id)))];
      for (const runId of runIds) await syncWorkspaceRun(project.workspacePath, runId);
      if (!runIds.length && transcript.assets.length) {
        await materializeWorkspaceAssets(project.workspacePath, transcript.assets.map((asset) => ({
          assetId: asset.id,
          relativePath: asset.name,
          name: asset.name,
        })));
      }
    }
    message.content = transcript.assistantContent;
    message.activities = transcript.activities;
    message.assets = transcript.assets;
    void update(project);
  } catch (cause) {
    updateTask(task, {
      status: "failed",
      error: cause instanceof Error ? cause.message : "任务执行失败",
      finishedAt: Date.now(),
    });
    message.content ||= `任务未完成：${task.error ?? "执行发生异常。"}`;
    void update(project);
  }
}
async function run(project: Project) {
  if (project.managedServer) {
    await runManagedProject(project);
    return;
  }
  if (project.status === "running") return;
  error.value = "";
  const record = await createRun(project);
  try {
    while (!isCancelled(project)) {
      const pending = project.tasks.filter(
        (task) =>
          task.status === "queued" ||
          task.status === "draft" ||
          task.status === "stale" ||
          task.status === "failed",
      );
      if (!pending.length) break;
      const ready = pending.filter((task) =>
        task.dependsOn.every((id) => {
          const dep = project.tasks.find((item) => item.id === id);
          if (!dep || dep.status === "superseded") return true;
          return dep.status === "completed" || dep.status === "cancelled";
        }),
      );
      const blocked = pending.filter((task) =>
        task.dependsOn.some((id) =>
          ["failed", "cancelled"].includes(
            project.tasks.find((item) => item.id === id)?.status ?? "failed",
          ),
        ),
      );
      blocked.forEach((task) =>
        updateTask(task, {
          status: "cancelled",
          error: "前置任务未成功完成。",
        }),
      );
      if (!ready.length) {
        if (!blocked.length)
          pending.forEach((task) =>
            updateTask(task, {
              status: "failed",
              error: "任务依赖存在循环或无效引用。",
            }),
          );
        continue;
      }
      await Promise.all(ready.map((task) => executeTask(project, task)));
    }
    if (isCancelled(project)) {
      cancelling.delete(project.id);
      await finishRun(project, record, "cancelled");
      return;
    }
    const done = project.tasks.filter((task) => task.status === "completed");
    const aggregator =
      coordinator.value ?? modelFor(done[0] ?? project.tasks[0]);
    if (!aggregator) throw new Error("没有可用协调员模型。");
    const evidence = buildSummaryEvidence(
      done.map((task) => ({
        title: `${task.title}（${employeeName(task.employeeId)}）`,
        content: task.transcript?.assistantContent ?? "",
      })),
    );
    const synthesis = await props.runTask({
      projectId: project.id,
      taskId: `summary-${record.id}`,
      prompt: `你是项目协调员。仅依据以下子任务结果，输出项目完成情况、合并结论、资产清单、遗留风险与下一步。不要虚构信息。\n\n项目目标：${project.goal}\n\n${evidence}`,
      employeeId: "administrator",
      skillIds: [],
      permissionTier: "read-only",
      model: aggregator,
      workspacePath: project.workspacePath,
    });
    project.summary = synthesis.assistantContent;
    addProjectMessage(project, {
      id: crypto.randomUUID(),
      role: "system",
      content: "本轮调度已结束，协调员已生成项目汇总。",
      createdAt: Date.now(),
      assets: synthesis.assets,
    });
    await finishRun(
      project,
      record,
      project.tasks.some((task) => task.status === "failed")
        ? "failed"
        : "completed",
      synthesis.assistantContent,
    );
  } catch (cause) {
    await finishRun(
      project,
      record,
      "failed",
      undefined,
      cause instanceof Error ? cause.message : "项目运行失败",
    );
  }
}
function downstreamTasks(project: Project, taskId: string) {
  const affected = new Set<string>();
  const visit = (parentId: string) =>
    project.tasks
      .filter((task) => task.dependsOn.includes(parentId))
      .forEach((task) => {
        if (affected.has(task.id)) return;
        affected.add(task.id);
        visit(task.id);
      });
  visit(taskId);
  return project.tasks.filter((task) => affected.has(task.id));
}

function validateLocalTaskGraph(tasks: ProjectTask[]): string | null {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) return `任务「${task.title}」依赖了不存在的任务。`;
    }
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): string | null => {
    if (visited.has(id)) return null;
    if (visiting.has(id)) return "任务依赖存在环，无法调度。";
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const err = visit(dep);
      if (err) return err;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const task of tasks) {
    const err = visit(task.id);
    if (err) return err;
  }
  return null;
}

function buildReplannedTasks(
  project: Project,
  drafts: ProjectTaskDraft[],
): ProjectTask[] {
  const ids = drafts.map(() => crypto.randomUUID());
  return drafts.map((draft, index) => ({
    id: ids[index],
    title: draft.title,
    objective: draft.objective,
    employeeId: draft.employeeId,
    provider: project.coordinatorProvider,
    model: project.coordinatorModel,
    skillIds: [...(draft.skillIds ?? [])],
    dependsOn: (draft.dependsOn ?? [])
      .map((item) => ids[item])
      .filter(Boolean),
    contract: draft.contract
      ? {
          outputs: draft.contract.outputs ? [...draft.contract.outputs] : undefined,
          acceptance: draft.contract.acceptance,
          maxSteps: draft.contract.maxSteps,
          timeoutMs: draft.contract.timeoutMs,
          maxAttempts: draft.contract.maxAttempts,
        }
      : undefined,
    permissionTier: "default" as const,
    status: "draft" as const,
    attempts: 0,
  }));
}

const rosterBusy = ref(false);

async function replanProjectRoster(project: Project, nextMemberIds: EmployeeId[]) {
  if (project.status === "running" || rosterBusy.value) return;
  const roster = [...new Set(nextMemberIds)];
  if (!roster.length) {
    error.value = "至少保留一名项目成员。";
    return;
  }
  const model =
    coordinator.value ??
    props.models.find(
      (item) =>
        item.provider === project.coordinatorProvider &&
        item.chatModel === project.coordinatorModel,
    ) ??
    props.models[0];
  if (!model) {
    error.value = "没有可用协调员模型，无法重新规划。";
    return;
  }
  rosterBusy.value = true;
  error.value = "";
  try {
    const generated = await props.generateDraft(project.goal, model, {
      employeeIds: roster,
      preferredMode: project.mode,
    });
    const taskDrafts = Array.isArray(generated) ? generated : generated.tasks;
    const tasks = buildReplannedTasks(project, taskDrafts);
    // Keep completed nodes when employee+title still match (local Plan merge).
    const kept = new Map<string, ProjectTask>();
    for (const old of project.tasks) {
      if (old.status !== "completed") continue;
      const hit = tasks.find(
        (task) => task.employeeId === old.employeeId && task.title === old.title,
      );
      if (hit) kept.set(hit.id, old);
    }
    for (const task of tasks) {
      const prev = kept.get(task.id);
      if (!prev) continue;
      task.status = "completed";
      task.transcript = prev.transcript;
      task.runId = prev.runId;
      task.finishedAt = prev.finishedAt;
      task.attempts = prev.attempts;
    }
    const graphError = validateLocalTaskGraph(tasks);
    if (graphError) {
      error.value = graphError;
      return;
    }
    const planVersion = (project.plan?.version ?? 1) + 1;
    const note = `协调员已发布 Plan v${planVersion}（${roster.map((id) => employeeName(id)).join("、")}），并完成依赖校验。调度器将按 DAG 执行。`;
    project.planHistory = [...(project.planHistory ?? []), ...(project.plan ? [project.plan] : [])].slice(-20);
    project.plan = {
      version: planVersion,
      createdAt: Date.now(),
      strategy: project.mode,
      taskIds: tasks.map((task) => task.id),
      note,
    };
    if (project.managedServer) {
      await orch.replanProject(project.id, {
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          objective: task.objective,
          employeeId: task.employeeId,
          skillIds: task.skillIds,
          dependsOn: task.dependsOn,
          contract: task.contract,
        })),
        note,
      });
      await refreshManaged(project.id);
      await runManagedProject(project);
      return;
    }
    project.tasks = tasks;
    project.status = "draft";
    project.summary = undefined;
    project.activeRunId = undefined;
    addProjectMessage(project, {
      id: crypto.randomUUID(),
      role: "system",
      content: note,
      createdAt: Date.now(),
    });
    await update(project);
    await run(project);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "成员变更后重新规划失败。";
  } finally {
    rosterBusy.value = false;
  }
}

async function addProjectMember(project: Project, employeeId: EmployeeId) {
  const current = [...new Set(project.tasks.map((task) => task.employeeId))];
  if (current.includes(employeeId)) return;
  await replanProjectRoster(project, [...current, employeeId]);
}

async function removeProjectMember(project: Project, employeeId: EmployeeId) {
  const current = [...new Set(project.tasks.map((task) => task.employeeId))];
  if (!current.includes(employeeId)) return;
  if (current.length <= 1) {
    error.value = "至少保留一名项目成员。";
    return;
  }
  await replanProjectRoster(
    project,
    current.filter((id) => id !== employeeId),
  );
}

async function dispatchProjectInstruction(
  project: Project,
  input: { employeeId: EmployeeId; content: string },
) {
  if (project.status === "running" || rosterBusy.value) return;
  if (project.managedServer) {
    error.value = "";
    try {
      await orch.dispatchProjectInstruction(project.id, {
        employeeId: input.employeeId,
        content: input.content,
        employeeLabel: employeeName(input.employeeId),
      });
      await refreshManaged(project.id);
      const existing = managedPollers.get(project.id);
      if (existing) clearInterval(existing);
      managedPollers.set(
        project.id,
        setInterval(() => void refreshManaged(project.id), 3000),
      );
      startManagedStream(project.id);
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : "服务端调度追加指令失败。";
    }
    return;
  }
  addProjectMessage(project, {
    id: crypto.randomUUID(),
    role: "user",
    content: `@${employeeName(input.employeeId)} ${input.content}`,
    employeeId: input.employeeId,
    createdAt: Date.now(),
  });
  const target =
    [...project.tasks]
      .reverse()
      .find((task) => task.employeeId === input.employeeId) ??
    project.tasks.find((task) => task.employeeId === input.employeeId);
  if (!target) {
    error.value = "所选员工不在当前项目成员中。";
    return;
  }
  target.objective = `${target.objective}\n\n本轮项目指令：${input.content}`;
  target.status = "stale";
  target.error = undefined;
  // Keep prior transcript as evidence until the new attempt finishes.
  const downstream = downstreamTasks(project, target.id);
  downstream.forEach((task) => {
    if (task.status === "superseded") return;
    task.status = "stale";
    task.error = undefined;
  });
  addProjectMessage(project, {
    id: crypto.randomUUID(),
    role: "system",
    content: downstream.length
      ? `ChangeSet 已应用：失效 ${employeeName(input.employeeId)} 及 ${downstream.length} 个下游节点（stale）；上游已完成任务保留，调度器按 DAG 增量重跑。`
      : `ChangeSet 已应用：失效 ${employeeName(input.employeeId)}（无下游依赖）；调度器将增量重跑。`,
    createdAt: Date.now(),
  });
  await update(project);
  await run(project);
}
onMounted(async () => {
  await Promise.all([load(), loadSkills(), loadRuntimePrefs(), loadMcp(), loadProjectTemplates()]);
  const [users, me] = await Promise.all([
    listLocalUsers().catch(() => [] as AuthUser[]),
    getCurrentUser().catch(() => null),
  ]);
  localUsers.value = users;
  currentUserId.value = me?.id ?? "";
  await loadManagedProjects();
  const focusId = await readStored("projects.focus-id");
  if (focusId && projects.value.some((project) => project.id === focusId)) {
    selectedId.value = focusId;
    await writeStored("projects.focus-id", "");
    autoStartIfDraft(projects.value.find((project) => project.id === focusId));
  }
});

onBeforeUnmount(() => {
  for (const id of [...managedStreams.keys()]) stopManagedStream(id);
  for (const timer of managedPollers.values()) clearInterval(timer);
  managedPollers.clear();
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <div
      :class="['mx-auto flex h-full min-h-0 w-full flex-col', selected ? 'max-w-none p-0' : 'max-w-7xl px-6 py-9 sm:px-12']"
    >
      <header v-if="!selected" class="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">Workmate / PROJECT ORCHESTRATION</p>
          <h1 class="mt-2 text-4xl font-bold tracking-[-.045em]">我的项目</h1>
          <p class="mt-3 text-[var(--muted)]">默认只展示当前登录用户归属的项目。把复杂目标交给多个数字员工：先确认编排，再让任务在隔离上下文中可靠运行。</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white" @click="openCreate('blank')">＋ 创建项目</button>
          <button class="rounded-xl border border-[var(--accent)]/40 bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--accent)]" @click="openCreate('template')">从模板创建</button>
        </div>
      </header>

      <div v-if="!selected" class="mt-6 inline-flex w-fit rounded-xl bg-[var(--surface-muted)] p-1">
        <button :class="['rounded-lg px-4 py-2 text-sm font-semibold', tab === 'projects' ? 'bg-[var(--surface)] shadow-sm' : 'text-[var(--muted)]']" @click="tab = 'projects'; selectedId = null;">项目</button>
        <button :class="['rounded-lg px-4 py-2 text-sm font-semibold', tab === 'runs' ? 'bg-[var(--surface)] shadow-sm' : 'text-[var(--muted)]']" @click="tab = 'runs'">运行记录 <span class="ml-1 rounded bg-[var(--surface)] px-1.5 text-xs">{{ runs.length }}</span></button>
      </div>

      <div :class="[selected ? 'min-h-0 flex-1 overflow-hidden flex flex-col' : 'mt-6 min-h-0 flex-1 overflow-y-auto pr-1']">
        <!-- 新建项目向导：①信息与规划 → ②确认运行 -->
        <section v-if="creating" class="rounded-2xl border border-[var(--accent)]/30 bg-[var(--surface)] shadow-sm">
          <div class="flex items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-5">
            <div class="min-w-0">
              <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--accent)]">CREATE · PLAN · RUN</p>
              <h2 class="mt-1 text-xl font-bold tracking-tight">
                {{ createStep === 1 ? (createMethod === 'template' ? '从模板创建项目' : '创建项目并规划 DAG') : '确认执行方案' }}
              </h2>
              <p class="mt-1 text-sm text-[var(--muted)]">
                {{ createStep === 1 ? (createMethod === 'template' ? '选择现有模板复制为新项目草稿；复制后所有信息都可修改，原模板不会改变。' : '录入基本信息后，由规划器生成可编辑的 DAG 项目草稿。') : '核对项目资料、任务分工、依赖与目录后，确认进入项目对话工作台。' }}
              </p>
            </div>
            <button class="shrink-0 rounded-lg px-2 py-1 text-sm text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]" type="button" @click="closeCreate">关闭</button>
          </div>
          <div class="p-6">
            <ol class="mb-7 flex items-center gap-2 text-xs font-semibold">
              <div v-for="step in [1, 2]" :key="step" class="contents">
                <span :class="['grid h-6 w-6 place-items-center rounded-full', createStep >= step ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)]']">{{ step }}</span>
                <span :class="createStep >= step ? 'text-[var(--text)]' : 'text-[var(--muted)]'">{{ step === 1 ? '信息与规划' : '确认方案' }}</span>
                <i v-if="step < 2" class="h-px w-8 bg-[var(--border)]" />
              </div>
            </ol>

            <!-- ① 信息与规划 -->
            <div v-if="createStep === 1">
              <div class="space-y-5">
                <div v-if="createMethod === 'blank'" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 p-4">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p class="text-[11px] font-bold tracking-[0.12em] text-[var(--muted)]">DAG PLANNER</p>
                      <h3 class="mt-1 text-sm font-bold">由规划器直接生成 DAG</h3>
                      <p class="mt-1 text-xs leading-5 text-[var(--muted)]">不再选择瀑布 / 并发 / 讨论模板，项目会统一进入 DAG 规划，再按真实依赖调度。</p>
                    </div>
                    <span class="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-[11px] font-bold text-[var(--accent)]">默认模式：DAG</span>
                  </div>
                </div>

                <div v-if="createMethod === 'template'" class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <p class="text-[11px] font-bold tracking-[0.12em] text-[var(--muted)]">SAVED TEMPLATES</p>
                      <h3 class="mt-1 text-sm font-bold">已保存模板</h3>
                    </div>
                    <span class="text-xs text-[var(--muted)]">{{ savedTemplates.length }} 个</span>
                  </div>
                  <div v-if="savedTemplates.length" class="mt-3 grid gap-2 md:grid-cols-2">
                    <div v-for="item in savedTemplates" :key="item.id" class="rounded-xl border border-[var(--border)] bg-[var(--background)]/50 p-3">
                      <div class="flex items-start justify-between gap-2">
                        <button class="min-w-0 text-left" type="button" @click="applySavedTemplate(item.id)">
                          <strong class="block truncate text-sm">{{ item.name }}</strong>
                          <span class="mt-1 block text-xs text-[var(--muted)]">{{ item.tasks.length }} 个任务 · {{ modeName(item.mode) }}</span>
                        </button>
                        <button class="rounded-md px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50" type="button" @click="deleteSavedTemplate(item.id)">删除</button>
                      </div>
                    </div>
                  </div>
                  <p v-else class="mt-3 text-xs text-[var(--muted)]">当前还没有可用模板。请先创建项目并在确认页将方案保存为模板。</p>
                </div>
              </div>
            </div>

            <p v-if="error" class="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>

            <div v-if="createStep === 1" class="space-y-5 mt-5">
              <label class="block text-sm font-semibold">
                项目名称
                <span class="ml-1 font-normal text-[var(--muted)]">（可选）</span>
                <input
                  v-model="name"
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 font-normal outline-none transition focus:border-[var(--accent)]"
                  placeholder="例如：计生用品官方网站"
                />
              </label>

              <label class="block text-sm font-semibold">
                项目描述
                <textarea
                  v-model="goal"
                  class="mt-2 min-h-36 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 font-normal outline-none transition focus:border-[var(--accent)]"
                  placeholder="描述最终目标、边界、对象和期望产出。协调员会据此生成可编辑的任务草案…"
                />
              </label>

              <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/60 px-3.5 py-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-[11px] font-bold tracking-wide text-[var(--muted)]">项目空间</p>
                    <p class="mt-1 break-all text-xs leading-5 text-[var(--text)]">
                      {{ isDesktopShell() ? (workspaceParent || '未指定时默认创建到 ~/.workmate/projects/项目名称-随机标识；若已选择目录，则该目录本身就是项目根目录。') : '将创建服务端托管项目空间。' }}
                    </p>
                  </div>
                  <button
                    v-if="isDesktopShell()"
                    class="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--accent)]/50"
                    type="button"
                    @click="chooseWorkspaceParent"
                  >
                    {{ workspaceParent ? '更换' : '选择目录' }}
                  </button>
                </div>
                <p class="mt-2 text-[11px] text-[var(--muted)]">
                  {{ isDesktopShell() ? '若已选择目录，将直接以该目录作为工作主目录，不再额外套一层项目子目录。' : '交付物将写入服务端托管工作区，并可导入/导出 zip。' }}
                </p>
              </div>

              <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p class="text-[11px] font-bold tracking-[0.12em] text-[var(--muted)]">项目共享</p>
                <div class="mt-3 grid gap-2 md:grid-cols-3">
                  <button :class="['rounded-xl border px-3 py-3 text-left text-sm', accessScope === 'private' ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]']" type="button" @click="accessScope = 'private'">
                    <strong class="block">仅自己</strong>
                    <span class="mt-1 block text-xs text-[var(--muted)]">只有 owner 可读写</span>
                  </button>
                  <button :class="['rounded-xl border px-3 py-3 text-left text-sm', accessScope === 'org-shared' ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]']" type="button" @click="accessScope = 'org-shared'">
                    <strong class="block">组织共享</strong>
                    <span class="mt-1 block text-xs text-[var(--muted)]">同组织可读，owner/admin 可写</span>
                  </button>
                  <button :class="['rounded-xl border px-3 py-3 text-left text-sm', accessScope === 'delegated' ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]']" type="button" @click="accessScope = 'delegated'">
                    <strong class="block">指定用户</strong>
                    <span class="mt-1 block text-xs text-[var(--muted)]">仅授权用户可读写</span>
                  </button>
                </div>
                <div v-if="accessScope === 'delegated'" class="mt-4">
                  <p class="text-xs text-[var(--muted)]">选择可协作该项目的本地用户：</p>
                  <div class="mt-2 grid gap-2 md:grid-cols-2">
                    <label
                      v-for="user in shareableUsers"
                      :key="user.id"
                      class="flex items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2 text-sm"
                    >
                      <input
                        :checked="Boolean(delegatedPermissions[user.id])"
                        type="checkbox"
                        @change="handleDelegatedUserToggle(user.id, $event)"
                      />
                      <span class="min-w-0 flex-1">
                        <strong class="block truncate">{{ user.displayName }}</strong>
                        <span class="block text-xs text-[var(--muted)]">{{ user.username }} · {{ user.role }}</span>
                      </span>
                      <select
                        v-if="delegatedPermissions[user.id]"
                        :value="delegatedPermissions[user.id]"
                        class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                        @change="handleDelegatedPermissionChange(user.id, $event)"
                      >
                        <option value="write">可编辑</option>
                        <option value="read">只读</option>
                      </select>
                    </label>
                  </div>
                  <p v-if="!shareableUsers.length" class="mt-2 text-xs text-[var(--muted)]">当前没有可委托的其他本地用户。</p>
                </div>
              </div>

              <div class="flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-end sm:justify-between">
                <button
                  class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--text)]"
                  type="button"
                  @click="closeCreate"
                >
                  取消
                </button>

                <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end sm:gap-2.5">
                  <label class="block w-full sm:w-[min(100%,300px)]">
                    <span class="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">
                      协调员模型
                    </span>
                    <select
                      v-model="coordinatorId"
                      class="h-11 w-full truncate rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm outline-none focus:border-[var(--accent)]"
                      :disabled="!models.length || planning"
                    >
                      <option v-if="!models.length" disabled value="">请先在设置中配置模型</option>
                      <option v-for="model in models" :key="model.id" :value="model.id">
                        {{ modelLabel(model) }}
                      </option>
                    </select>
                  </label>
                  <button
                    class="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[var(--accent)] px-6 text-sm font-semibold tracking-wide text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                    type="button"
                    :disabled="planning || !coordinator || !goal.trim()"
                    @click="continueCreate"
                  >
                    <span v-if="planning" class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
                    {{ planning ? '正在规划…' : (createMethod === 'template' && draftTasks.length ? '按当前信息重新规划' : '进行规划') }}
                  </button>
                  <button
                    v-if="draftTasks.length"
                    class="inline-flex h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-xl border border-[var(--border)] px-5 text-sm font-semibold text-[var(--muted)] hover:text-[var(--accent)]"
                    type="button"
                    @click="createStep = 2"
                  >
                    {{ createMethod === 'template' ? '编辑模板副本' : '使用当前方案' }}
                  </button>
                </div>
              </div>
            </div>

            <!-- ② 确认运行（可编辑） -->
            <div v-if="createStep === 2" class="space-y-5">
              <div class="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 class="font-bold">执行方案</h3>
                  <p class="mt-1 text-xs text-[var(--muted)]">可编辑标题、目标与负责员工；下方动画展示依赖与数据流。</p>
                </div>
                <button
                  class="rounded-lg border border-dashed border-[var(--accent)]/50 px-3 py-1.5 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  type="button"
                  @click="draftTasks.push({ title: '新任务', objective: '', employeeId: 'general', skillIds: [] })"
                >
                  ＋ 添加任务
                </button>
              </div>

              <ProjectDagPreview
                :tasks="draftTasks.map((task, index) => ({ id: `draft-${index}`, title: task.title || `任务 ${index + 1}`, subtitle: employeeName(task.employeeId), dependsOn: (task.dependsOn ?? []).map((dep) => `draft-${dep}`), status: 'draft' }))"
              />

              <div class="space-y-2">
                <article
                  v-for="(task, index) in draftTasks"
                  :key="index"
                  class="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)]/40 p-3 md:grid-cols-[.9fr_1.7fr_150px_auto]"
                >
                  <input v-model="task.title" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm outline-none focus:border-[var(--accent)]" placeholder="任务标题" />
                  <input v-model="task.objective" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm outline-none focus:border-[var(--accent)]" placeholder="任务目标" />
                  <select v-model="task.employeeId" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm outline-none focus:border-[var(--accent)]">
                    <option v-for="employee in employees" :key="employee.id" :value="employee.id">{{ employeeName(employee.id) }}</option>
                  </select>
                  <button class="rounded-lg px-2 py-2 text-sm text-rose-600 hover:bg-rose-50" type="button" @click="draftTasks.splice(index, 1)">删除</button>
                  <div class="md:col-span-4 flex flex-wrap items-center gap-2 pt-1 text-[11px] text-[var(--muted)]">
                    <span class="rounded-full bg-[var(--surface)] px-2 py-1">权限：{{ taskRuntimeSummary(task).permissionTier }}</span>
                    <span class="rounded-full bg-[var(--surface)] px-2 py-1">Skills：{{ taskRuntimeSummary(task).skillCount }}</span>
                    <span class="rounded-full bg-[var(--surface)] px-2 py-1">MCP：{{ taskRuntimeSummary(task).mcpCount }}</span>
                    <span class="basis-full">执行画像 · Skill：{{ taskRuntimeSummary(task).skillSummary }} · MCP：{{ taskRuntimeSummary(task).mcpSummary }}</span>
                  </div>
                  <div v-if="index > 0" class="md:col-span-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                    <span class="text-[11px] font-semibold text-[var(--muted)]">前置依赖（可多选）</span>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <label v-for="dependencyIndex in index" :key="dependencyIndex" class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px]">
                        <input
                          :checked="(task.dependsOn ?? []).includes(dependencyIndex - 1)"
                          type="checkbox"
                          @change="toggleDraftDependency(index, dependencyIndex - 1)"
                        />
                        {{ draftTasks[dependencyIndex - 1]?.title || `任务 ${dependencyIndex}` }}
                      </label>
                    </div>
                  </div>
                </article>
              </div>

              <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-4 text-sm">
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <p><strong>项目：</strong>{{ name || '（未命名）' }}</p>
                  <p><strong>形态：</strong>{{ modeName(mode) }}</p>
                  <p class="text-xs text-[var(--muted)]">{{ draftTasks.length }} 项任务</p>
                  <p v-if="coordinator" class="text-xs text-[var(--muted)]">
                    协调员 · {{ modelLabel(coordinator) }}
                  </p>
                </div>
                <p class="mt-2 text-[var(--muted)]">{{ goal }}</p>
              </div>

              <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div class="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <label class="block flex-1">
                    <span class="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">存为模板</span>
                    <input
                      v-model="templateName"
                      class="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
                      placeholder="例如：官网建设标准 DAG"
                    />
                  </label>
                  <button
                    class="rounded-lg border border-[var(--accent)]/40 px-4 py-2.5 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-45"
                    type="button"
                    :disabled="savingTemplate || !draftTasks.length"
                    @click="saveCurrentDagAsTemplate"
                  >
                    {{ savingTemplate ? '保存中…' : '存为模板' }}
                  </button>
                </div>
                <p class="mt-2 text-xs text-[var(--muted)]">模板会保存项目基本信息与当前规划 DAG；下次新建项目时可直接载入，再按新项目修改基本信息。</p>
              </div>

              <div class="flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
                <button class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)]" type="button" @click="createStep = 1">
                  ← 返回修改描述
                </button>
                <button
                  class="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-45"
                  type="button"
                  :disabled="!draftTasks.length"
                  @click="confirmCreate"
                >
                  确认并进入对话工作台
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 项目列表（未选择时） -->
        <section v-else-if="tab === 'projects' && !selected" class="grid gap-5">
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <label class="block w-full md:max-w-sm">
              <input
                v-model="searchQuery"
                class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
                placeholder="搜索项目名、目标、任务或成员"
              />
            </label>
            <div class="flex flex-wrap gap-2">
            <button
              v-for="item in visibilityFilterOptions"
              :key="item.id"
              :class="[
                'rounded-xl px-3 py-2 text-sm font-semibold transition',
                visibilityFilter === item.id
                  ? 'bg-[var(--accent)] text-white shadow-sm'
                  : 'bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)]',
              ]"
              @click="visibilityFilter = item.id"
            >
              {{ item.label }}
              <span :class="['ml-1 rounded px-1.5 py-0.5 text-xs', visibilityFilter === item.id ? 'bg-white/20 text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)]']">{{ item.count }}</span>
            </button>
            </div>
          </div>
          <template v-if="projects.length">
            <div class="grid gap-4 md:grid-cols-2">
              <button
                v-for="project in filteredProjects"
                :key="project.id"
                class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left hover:border-[var(--accent)]/60"
                @click="openProject(project)"
              >
                <div class="flex justify-between gap-3">
                  <div class="flex flex-wrap gap-2">
                    <span class="rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-bold text-[var(--accent)]">{{ modeName(project.mode) }}</span>
                    <span class="rounded-lg bg-[var(--surface-muted)] px-2 py-1 text-[11px] font-semibold text-[var(--muted)]">{{ accessScopeLabel(project.accessScope) }}</span>
                  </div>
                  <span :class="['rounded-full px-2 py-1 text-[10px] font-bold', statusStyle(project.status)]">{{ statusText(project.status) }}</span>
                </div>
                <h2 class="mt-4 text-lg font-bold">{{ project.name }}</h2>
                <p class="mt-2 line-clamp-2 text-sm text-[var(--muted)]">{{ project.goal }}</p>
                <p class="mt-5 text-xs text-[var(--muted)]">{{ project.tasks.length }} 个任务 · 更新于 {{ date(project.updatedAt) }}</p>
              </button>
            </div>
            <div v-if="!filteredProjects.length" class="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center text-sm text-[var(--muted)]">
              当前筛选下暂无项目。
            </div>
          </template>
          <div v-else class="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-14 text-center">
            <h2 class="text-xl font-bold">创建一个由规划器驱动的 DAG 项目</h2>
            <p class="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-[var(--muted)]">录入基本信息后，协调员会直接产出可编辑的 DAG 任务图；你也可以复用已保存模板。</p>
            <div class="mt-6 flex justify-center gap-2">
              <button class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white" @click="openCreate('blank')">创建第一个项目</button>
              <button class="rounded-xl border border-[var(--accent)]/40 px-4 py-2.5 text-sm font-semibold text-[var(--accent)]" @click="openCreate('template')">从模板创建</button>
            </div>
          </div>
          <div>
            <h2 class="text-lg font-bold">项目模板</h2>
            <div v-if="savedTemplates.length" class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <button v-for="item in savedTemplates" :key="item.id" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left hover:border-[var(--accent)]" @click="openCreate('template', item.id)">
                <span class="text-lg font-bold text-[var(--accent)]">◇</span>
                <strong class="mt-3 block">{{ item.name }}</strong>
                <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">{{ item.basic.goal || '已保存的项目基础信息与 DAG 任务图。' }}</p>
                <span class="mt-3 inline-block text-[11px] font-semibold text-[var(--accent)]">{{ item.tasks.length }} 个任务</span>
              </button>
            </div>
            <p v-else class="mt-3 text-sm text-[var(--muted)]">还没有保存过模板。先规划一个项目，再点击“存为模板”即可复用。</p>
          </div>
        </section>

        <!-- 项目对话工作台（已选择） -->
        <section v-else-if="tab === 'projects' && selected" class="min-h-0 flex-1 flex flex-col">
          <ProjectConversationWorkspace
            :project="currentSelectedProject()"
            :employees="employees"
            :users="localUsers"
            :current-user-id="currentUserId"
            :template-name="modeName(selected?.mode)"
            :running="selected?.status === 'running' || rosterBusy"
            :file-tree-epoch="fileTreeEpoch"
            @back="selectedId = null"
            @start="runSelectedProject"
            @cancel="cancelSelectedProject"
            @remove="removeSelectedProject"
            @dispatch="dispatchSelectedProject"
            @add-member="addMemberToSelectedProject"
            @remove-member="removeMemberFromSelectedProject"
          />
        </section>

        <!-- 运行记录 -->
        <section v-else-if="tab === 'runs'" class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div v-if="!runs.length" class="p-14 text-center text-sm text-[var(--muted)]">尚无项目运行记录。</div>
          <button v-for="item in runs" :key="item.id" class="flex w-full items-center justify-between border-b border-[var(--border)] px-5 py-4 text-left last:border-0">
            <span>
              <strong>{{ projects.find((project) => project.id === item.projectId)?.name ?? '已删除项目' }}</strong>
              <span class="ml-3 text-xs text-[var(--muted)]">{{ statusText(item.status) }}</span>
              <span class="ml-3 text-xs text-[var(--muted)]">{{ item.taskIds.length }} 项任务</span>
            </span>
            <span class="text-xs text-[var(--muted)]">{{ date(item.finishedAt ?? item.startedAt) }}</span>
          </button>
        </section>
      </div>
    </div>
  </section>
</template>
