import type { EmployeeId } from './workspace.js';

export type PlanningMode = 'waterfall' | 'parallel' | 'discussion' | 'dag';

/** Result of the two-phase project coordinator (P2). */
export interface ProjectDraftResult {
  tasks: Array<{
    title: string;
    objective: string;
    employeeId: EmployeeId;
    skillIds: string[];
    dependsOn?: number[];
    contract?: {
      outputs?: string[];
      acceptance?: string;
      timeoutMs?: number;
      maxAttempts?: number;
    };
  }>;
  preferredMode: PlanningMode;
  suggestedMode: PlanningMode;
  modeFitsPreferred: boolean;
  modeRationale: string;
}

/**
 * Infer collaboration shape from numeric dependsOn indices (create-wizard drafts).
 */
export function inferCollaborationMode(
  tasks: Array<{ dependsOn?: number[] }>,
): PlanningMode {
  if (tasks.length <= 1) return 'parallel';
  const deps = tasks.map((task) => [...(task.dependsOn ?? [])]);
  const edgeCount = deps.reduce((sum, list) => sum + list.length, 0);
  if (edgeCount === 0) return 'parallel';

  let indexChain = true;
  for (let index = 0; index < deps.length; index += 1) {
    const list = deps[index];
    if (index === 0) {
      if (list.length) indexChain = false;
      continue;
    }
    if (list.length !== 1 || list[0] !== index - 1) indexChain = false;
  }
  if (indexChain) return 'waterfall';

  if (edgeCount === tasks.length - 1) {
    const incoming = tasks.map(() => 0);
    for (let i = 0; i < deps.length; i += 1) {
      for (const _d of deps[i]) incoming[i] += 1;
    }
    const roots = incoming.filter((v) => v === 0).length;
    const singleParent = incoming.filter((v) => v === 1).length;
    if (roots === 1 && singleParent === tasks.length - 1) return 'waterfall';
  }

  const last = deps[deps.length - 1] ?? [];
  const earlyIndependent = deps.slice(0, -1).every((list) => list.length === 0);
  if (earlyIndependent && last.length >= 2) return 'discussion';
  return 'dag';
}

const MODE_LABEL: Record<PlanningMode, string> = {
  waterfall: '瀑布（线性先后）',
  parallel: '并发（相互独立）',
  discussion: '讨论（多视角再整合）',
  dag: 'DAG（显式依赖）',
};

export function analyzeModeFit(
  preferred: PlanningMode,
  tasks: Array<{ dependsOn?: number[] }>,
): Pick<ProjectDraftResult, 'suggestedMode' | 'modeFitsPreferred' | 'modeRationale'> {
  if (preferred === 'dag') {
    return {
      suggestedMode: 'dag',
      modeFitsPreferred: true,
      modeRationale: '已按 DAG 偏好保留显式依赖。',
    };
  }
  const suggestedMode = inferCollaborationMode(tasks);
  if (suggestedMode === preferred) {
    return {
      suggestedMode,
      modeFitsPreferred: true,
      modeRationale: `规划结果符合「${MODE_LABEL[preferred]}」协作形态。`,
    };
  }
  return {
    suggestedMode,
    modeFitsPreferred: false,
    modeRationale: `目标更适合「${MODE_LABEL[suggestedMode]}」，与当前偏好「${MODE_LABEL[preferred]}」不一致。建议切换后按真实依赖调度。`,
  };
}

export function modeLabel(mode: PlanningMode): string {
  return MODE_LABEL[mode];
}
