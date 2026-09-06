import { randomUUID } from 'node:crypto';
import type {
  Project,
  ProjectChangeSet,
  ProjectMode,
  ProjectPlan,
  ProjectTask,
  ProjectTaskContract,
  ProjectTaskStatus,
} from './types.js';

export const MAX_PLAN_HISTORY = 20;
export const MAX_CHANGE_SETS = 40;

/** Statuses that still participate in scheduling. */
export function isSchedulableStatus(status: ProjectTaskStatus): boolean {
  return status !== 'superseded';
}

/** Statuses treated as terminal success/skip for dependency satisfaction. */
export function isDependencySatisfied(status: ProjectTaskStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'superseded';
}

/** Statuses that count as "done enough" for project completion. */
export function isTerminalTaskStatus(status: ProjectTaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'superseded' ||
    status === 'failed'
  );
}

/**
 * Materialize DAG edges from a planning strategy when the draft left dependsOn empty.
 * Runtime scheduling is always DAG-based; mode only shapes the graph.
 */
export function applyPlanningStrategy(
  strategy: ProjectMode,
  tasks: Array<{ id: string; dependsOn?: string[] }>,
): void {
  if (strategy === 'parallel' || strategy === 'dag') return;
  // waterfall / discussion → linear chain when no explicit edges exist
  const anyEdge = tasks.some((task) => (task.dependsOn ?? []).length > 0);
  if (anyEdge) return;
  for (let index = 1; index < tasks.length; index += 1) {
    tasks[index].dependsOn = [tasks[index - 1].id];
  }
}

export function concurrencyForStrategy(strategy: ProjectMode): number {
  return strategy === 'parallel' || strategy === 'dag' ? 4 : 1;
}

export function collectDownstreamTaskIds(
  tasks: Array<{ id: string; dependsOn?: string[]; status?: ProjectTaskStatus }>,
  rootId: string,
): Set<string> {
  const affected = new Set<string>();
  const visit = (parentId: string) => {
    for (const task of tasks) {
      if (task.status === 'superseded') continue;
      if (!(task.dependsOn ?? []).includes(parentId) || affected.has(task.id)) continue;
      affected.add(task.id);
      visit(task.id);
    }
  };
  visit(rootId);
  return affected;
}

/**
 * Mark a task stale and cascade to dependents (P1 explicit invalidation).
 * Does not clear objectives of dependents — only marks them for re-run.
 */
export function invalidateTaskCascade(
  tasks: ProjectTask[],
  rootId: string,
  options: { clearRootRun?: boolean; planVersion?: number } = {},
): string[] {
  const invalidated: string[] = [];
  const root = tasks.find((task) => task.id === rootId);
  if (root && root.status !== 'superseded') {
    root.status = 'stale';
    root.error = undefined;
    if (options.clearRootRun !== false) root.runId = undefined;
    if (options.planVersion !== undefined) root.planVersion = options.planVersion;
    invalidated.push(root.id);
  }
  const downstream = collectDownstreamTaskIds(tasks, rootId);
  for (const task of tasks) {
    if (!downstream.has(task.id) || task.status === 'superseded') continue;
    task.status = 'stale';
    task.error = undefined;
    task.runId = undefined;
    if (options.planVersion !== undefined) task.planVersion = options.planVersion;
    invalidated.push(task.id);
  }
  return invalidated;
}

export function buildPlan(
  strategy: ProjectMode,
  tasks: Array<{ id: string }>,
  options: { version?: number; note?: string; createdAt?: number } = {},
): ProjectPlan {
  return {
    version: options.version ?? 1,
    createdAt: options.createdAt ?? Date.now(),
    strategy,
    taskIds: tasks.filter((task) => true).map((task) => task.id),
    note: options.note,
  };
}

export function ensureProjectPlan(project: Project, note?: string): ProjectPlan {
  if (project.plan) return project.plan;
  const active = project.tasks.filter((task) => task.status !== 'superseded');
  project.plan = buildPlan(project.mode, active, { version: 1, note });
  return project.plan;
}

export function pushChangeSet(project: Project, changeSet: ProjectChangeSet): void {
  const list = project.changeSets ?? [];
  list.push(changeSet);
  project.changeSets = list.slice(-MAX_CHANGE_SETS);
}

export function bumpPlan(
  project: Project,
  note: string,
  activeTasks: Array<{ id: string }>,
): ProjectPlan {
  const current = ensureProjectPlan(project);
  const history = project.planHistory ?? [];
  history.push({ ...current });
  project.planHistory = history.slice(-MAX_PLAN_HISTORY);
  const next: ProjectPlan = {
    version: current.version + 1,
    createdAt: Date.now(),
    strategy: project.mode,
    taskIds: activeTasks.map((task) => task.id),
    note,
  };
  project.plan = next;
  return next;
}

export function normalizeContract(
  input?: ProjectTaskContract | null,
): ProjectTaskContract | undefined {
  if (!input) return undefined;
  const outputs = Array.isArray(input.outputs)
    ? input.outputs.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : undefined;
  const acceptance =
    typeof input.acceptance === 'string' ? input.acceptance.trim().slice(0, 2000) : undefined;
  const timeoutMs =
    typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : undefined;
  const maxAttempts =
    typeof input.maxAttempts === 'number' && input.maxAttempts > 0
      ? Math.min(10, Math.floor(input.maxAttempts))
      : undefined;
  if (!outputs?.length && !acceptance && !timeoutMs && !maxAttempts) return undefined;
  return { outputs, acceptance, timeoutMs, maxAttempts };
}

/**
 * Merge a replan draft onto an existing project: keep completed tasks whose
 * employee remains in the roster when the new draft references the same id or
 * the same employee+title; otherwise mark old nodes superseded.
 */
export function mergeReplanTasks(
  existing: ProjectTask[],
  incoming: ProjectTask[],
  rosterEmployeeIds: Set<string>,
): ProjectTask[] {
  const byId = new Map(existing.map((task) => [task.id, task]));
  const usedExisting = new Set<string>();
  const merged: ProjectTask[] = [];

  for (const next of incoming) {
    const prev =
      (next.id && byId.get(next.id)) ||
      existing.find(
        (task) =>
          !usedExisting.has(task.id) &&
          task.status === 'completed' &&
          task.employeeId === next.employeeId &&
          task.title === next.title &&
          rosterEmployeeIds.has(task.employeeId),
      );
    if (prev && prev.status === 'completed' && rosterEmployeeIds.has(prev.employeeId)) {
      usedExisting.add(prev.id);
      merged.push({
        ...prev,
        title: next.title,
        objective: next.objective,
        skillIds: [...next.skillIds],
        dependsOn: [...next.dependsOn],
        contract: next.contract ?? prev.contract,
        status: 'completed',
        permissionTier: next.permissionTier ?? prev.permissionTier,
      });
      continue;
    }
    if (prev) usedExisting.add(prev.id);
    merged.push(next);
  }

  for (const old of existing) {
    if (usedExisting.has(old.id)) continue;
    if (old.status === 'superseded') {
      merged.push(old);
      continue;
    }
    merged.push({
      ...old,
      status: 'superseded',
      error: '成员/计划变更后已从当前 Plan 移除。',
    });
  }

  return merged;
}

export function createChangeSet(input: {
  kind: ProjectChangeSet['kind'];
  summary: string;
  targetTaskIds: string[];
  invalidatedTaskIds: string[];
  planVersionBefore: number;
  planVersionAfter: number;
}): ProjectChangeSet {
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    ...input,
  };
}

/** Build a stable attempt key for idempotent task starts (P3). */
export function buildAttemptKey(taskId: string, planVersion: number, attemptNo: number): string {
  return `${taskId}:plan${Math.max(1, planVersion)}:attempt${Math.max(1, attemptNo)}`;
}

/**
 * Infer the collaboration shape of a dependency graph (P2 mode-fit).
 * Used when the coordinator cannot honor the user-preferred template.
 */
export function inferCollaborationMode(
  tasks: Array<{ dependsOn?: Array<string | number> }>,
): ProjectMode {
  if (tasks.length <= 1) return 'parallel';
  const deps = tasks.map((task) => [...(task.dependsOn ?? [])]);
  const edgeCount = deps.reduce((sum, list) => sum + list.length, 0);
  if (edgeCount === 0) return 'parallel';

  const numeric = deps.every((list) => list.every((item) => typeof item === 'number'));
  if (numeric) {
    const asNums = deps as number[][];
    // Linear chain by index: i depends only on i-1.
    let indexChain = true;
    for (let index = 0; index < asNums.length; index += 1) {
      const list = asNums[index];
      if (index === 0) {
        if (list.length) indexChain = false;
        continue;
      }
      if (list.length !== 1 || list[0] !== index - 1) indexChain = false;
    }
    if (indexChain) return 'waterfall';

    // Topological chain: n-1 edges, exactly one root, every other node indegree 1.
    if (edgeCount === tasks.length - 1) {
      const incoming = tasks.map(() => 0);
      for (let i = 0; i < asNums.length; i += 1) {
        for (const _d of asNums[i]) incoming[i] += 1;
      }
      const roots = incoming.filter((v) => v === 0).length;
      const singleParent = incoming.filter((v) => v === 1).length;
      if (roots === 1 && singleParent === tasks.length - 1) return 'waterfall';
    }

    // Discussion: early tasks independent, last fans in from 2+.
    const last = asNums[asNums.length - 1] ?? [];
    const earlyIndependent = asNums.slice(0, -1).every((list) => list.length === 0);
    if (earlyIndependent && last.length >= 2) return 'discussion';
  } else if (edgeCount === tasks.length - 1) {
    return 'waterfall';
  }

  const last = deps[deps.length - 1] ?? [];
  const earlyIndependent = deps.slice(0, -1).every((list) => list.length === 0);
  if (earlyIndependent && last.length >= 2) return 'discussion';

  return 'dag';
}

export function analyzeModeFit(
  preferred: ProjectMode,
  tasks: Array<{ dependsOn?: string[] | number[] }>,
): { suggestedMode: ProjectMode; modeFitsPreferred: boolean; rationale: string } {
  const suggestedMode = inferCollaborationMode(tasks);
  if (preferred === suggestedMode || preferred === 'dag') {
    // dag accepts any shape; preferred dag always "fits"
    if (preferred === 'dag') {
      return {
        suggestedMode: preferred,
        modeFitsPreferred: true,
        rationale: '已按 DAG 偏好保留显式依赖。',
      };
    }
    return {
      suggestedMode,
      modeFitsPreferred: true,
      rationale: `规划结果符合「${preferred}」协作形态。`,
    };
  }
  const labels: Record<ProjectMode, string> = {
    waterfall: '瀑布（线性先后）',
    parallel: '并发（相互独立）',
    discussion: '讨论（多视角再整合）',
    dag: 'DAG（显式依赖）',
  };
  return {
    suggestedMode,
    modeFitsPreferred: false,
    rationale: `目标更适合「${labels[suggestedMode]}」，与当前偏好「${labels[preferred]}」不一致。建议切换后按真实依赖调度。`,
  };
}

