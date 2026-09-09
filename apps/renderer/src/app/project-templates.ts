import { ref } from "vue";
import type { AccessScope, ProjectTaskInput } from "./projects.js";
import { readStored, writeStored } from "./storage.js";

export interface SavedProjectTemplate {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  basic: {
    projectName?: string;
    goal: string;
    accessScope: AccessScope;
    coordinatorId?: string;
  };
  mode: "dag";
  tasks: ProjectTaskInput[];
}

const key = "projects.templates.v1";
const templates = ref<SavedProjectTemplate[]>([]);
const loaded = ref(false);

function normalizeTask(task: ProjectTaskInput): ProjectTaskInput {
  return {
    title: String(task.title || "").trim(),
    objective: String(task.objective || "").trim(),
    employeeId: task.employeeId,
    skillIds: Array.isArray(task.skillIds) ? task.skillIds.filter((item): item is string => typeof item === "string") : [],
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter((item) => Number.isInteger(item) && item >= 0) : [],
    contract: task.contract
      ? {
          outputs: Array.isArray(task.contract.outputs)
            ? task.contract.outputs.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20)
            : undefined,
          acceptance: typeof task.contract.acceptance === "string" ? task.contract.acceptance.trim() : undefined,
          maxSteps:
            typeof task.contract.maxSteps === "number" && task.contract.maxSteps > 0
              ? Math.min(64, Math.max(4, Math.floor(task.contract.maxSteps)))
              : undefined,
          timeoutMs:
            typeof task.contract.timeoutMs === "number" && task.contract.timeoutMs > 0
              ? Math.floor(task.contract.timeoutMs)
              : undefined,
          maxAttempts:
            typeof task.contract.maxAttempts === "number" && task.contract.maxAttempts > 0
              ? Math.min(10, Math.floor(task.contract.maxAttempts))
              : undefined,
        }
      : undefined,
  };
}

function normalizeTemplate(input: SavedProjectTemplate): SavedProjectTemplate {
  const now = Date.now();
  return {
    id: String(input.id || crypto.randomUUID()),
    name: String(input.name || "").trim() || "未命名模板",
    createdAt: Number(input.createdAt || now),
    updatedAt: Number(input.updatedAt || now),
    basic: {
      projectName: input.basic?.projectName?.trim() || undefined,
      goal: String(input.basic?.goal || "").trim(),
      accessScope:
        input.basic?.accessScope === "org-shared" || input.basic?.accessScope === "delegated"
          ? input.basic.accessScope
          : "private",
      coordinatorId: input.basic?.coordinatorId?.trim() || undefined,
    },
    mode: "dag",
    tasks: Array.isArray(input.tasks) ? input.tasks.map(normalizeTask) : [],
  };
}

export function useProjectTemplates() {
  const persist = async () => {
    await writeStored(key, JSON.stringify(templates.value));
  };

  const load = async () => {
    if (loaded.value) return;
    try {
      const raw = JSON.parse((await readStored(key)) || "[]") as SavedProjectTemplate[];
      templates.value = Array.isArray(raw) ? raw.map(normalizeTemplate) : [];
    } catch {
      templates.value = [];
    }
    loaded.value = true;
  };

  const save = async (input: Omit<SavedProjectTemplate, "id" | "createdAt" | "updatedAt" | "mode"> & { id?: string }) => {
    const now = Date.now();
    const next = normalizeTemplate({
      id: input.id || crypto.randomUUID(),
      name: input.name,
      createdAt: now,
      updatedAt: now,
      basic: input.basic,
      mode: "dag",
      tasks: input.tasks,
    });
    const index = templates.value.findIndex((item) => item.id === next.id);
    if (index >= 0) {
      next.createdAt = templates.value[index].createdAt;
      templates.value = [...templates.value.slice(0, index), next, ...templates.value.slice(index + 1)];
    } else {
      templates.value = [next, ...templates.value];
    }
    await persist();
    return next;
  };

  const remove = async (id: string) => {
    templates.value = templates.value.filter((item) => item.id !== id);
    await persist();
  };

  return { templates, load, save, remove };
}
