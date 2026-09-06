import { ref } from 'vue';
import type { SearchProviderId } from './search-config';
import type { KnowledgeProviderId } from './kb-config';
import { knowledgeProviderIds } from './kb-config';
import { readStored, writeStored } from './storage';

export type EmployeeSearchMode = 'inherit' | 'auto' | 'off' | 'llm-builtin' | SearchProviderId;
/** Which knowledge provider this employee uses; then pick bases under that provider. */
export type EmployeeKnowledgeProvider = KnowledgeProviderId | 'off';

export interface EmployeeRuntimePrefs {
  /** null / empty = follow workspace active model */
  defaultModelId: string | null;
  searchMode: EmployeeSearchMode;
  /** Agent tool/LLM step budget; default 28 */
  maxSteps: number;
  /** Whole-run wall-clock timeout in ms. */
  runTimeoutMs: number;
  /** Per MCP tool call timeout in ms. */
  mcpToolTimeoutMs: number;
  /** Associated MCP connector ids (enabled connectors are injected at runtime). */
  mcpIds: string[];
  /** Knowledge provider this employee is bound to (`off` = no KB tools). */
  knowledgeProvider: EmployeeKnowledgeProvider;
  /** Associated knowledge base ids (must belong to knowledgeProvider). */
  knowledgeBaseIds: string[];
}

export const DEFAULT_MAX_STEPS = 28;
export const MIN_MAX_STEPS = 4;
export const MAX_MAX_STEPS = 64;

export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
export const MIN_RUN_TIMEOUT_MS = 60_000;
export const MAX_RUN_TIMEOUT_MS = 1_800_000;

export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;
export const MIN_MCP_TOOL_TIMEOUT_MS = 5_000;
export const MAX_MCP_TOOL_TIMEOUT_MS = 300_000;

export const defaultEmployeeRuntimePrefs = (): EmployeeRuntimePrefs => ({
  defaultModelId: null,
  searchMode: 'inherit',
  maxSteps: DEFAULT_MAX_STEPS,
  runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  mcpToolTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
  mcpIds: [],
  knowledgeProvider: 'off',
  knowledgeBaseIds: [],
});

const key = 'workspace.employee-runtime-prefs';
const prefsByEmployee = ref<Record<string, EmployeeRuntimePrefs>>({});
const loaded = ref(false);

function clampSteps(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(MIN_MAX_STEPS, Math.round(n)));
}

function clampTimeout(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeKnowledgeProvider(value: unknown): EmployeeKnowledgeProvider {
  if (value === 'off') return 'off';
  if (typeof value === 'string' && knowledgeProviderIds.includes(value as KnowledgeProviderId)) {
    return value as KnowledgeProviderId;
  }
  return 'off';
}

function normalizeOne(value: unknown): EmployeeRuntimePrefs {
  const raw = value && typeof value === 'object' ? (value as Partial<EmployeeRuntimePrefs> & { knowledgeBaseIds?: unknown }) : {};
  const searchMode = raw.searchMode;
  const allowedSearch =
    searchMode === 'inherit' ||
    searchMode === 'auto' ||
    searchMode === 'off' ||
    searchMode === 'llm-builtin' ||
    searchMode === 'bocha' ||
    searchMode === 'tavily' ||
    searchMode === 'brave' ||
    searchMode === 'exa' ||
    searchMode === 'zhipu' ||
    searchMode === 'aliyun';
  const knowledgeBaseIds = Array.isArray(raw.knowledgeBaseIds)
    ? raw.knowledgeBaseIds.map((id) => String(id)).filter(Boolean).slice(0, 24)
    : [];
  return {
    defaultModelId: raw.defaultModelId ? String(raw.defaultModelId) : null,
    searchMode: allowedSearch ? searchMode : 'inherit',
    maxSteps: clampSteps(raw.maxSteps),
    runTimeoutMs: clampTimeout(raw.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS, MIN_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS),
    mcpToolTimeoutMs: clampTimeout(raw.mcpToolTimeoutMs, DEFAULT_MCP_TOOL_TIMEOUT_MS, MIN_MCP_TOOL_TIMEOUT_MS, MAX_MCP_TOOL_TIMEOUT_MS),
    mcpIds: Array.isArray(raw.mcpIds) ? raw.mcpIds.map((id) => String(id)).filter(Boolean).slice(0, 24) : [],
    knowledgeProvider: normalizeKnowledgeProvider(raw.knowledgeProvider),
    knowledgeBaseIds,
  };
}

function normalizeAll(value: unknown): Record<string, EmployeeRuntimePrefs> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([id, prefs]) => [id, normalizeOne(prefs)]),
  );
}

export function useEmployeeRuntimePrefs() {
  const load = async () => {
    if (loaded.value) return;
    try {
      prefsByEmployee.value = normalizeAll(JSON.parse((await readStored(key)) || '{}'));
    } catch {
      prefsByEmployee.value = {};
    }
    loaded.value = true;
  };

  const persist = async () => {
    await writeStored(key, JSON.stringify(prefsByEmployee.value));
  };

  const get = (employeeId: string): EmployeeRuntimePrefs =>
    prefsByEmployee.value[employeeId] ? { ...prefsByEmployee.value[employeeId] } : defaultEmployeeRuntimePrefs();

  const set = async (employeeId: string, patch: Partial<EmployeeRuntimePrefs>) => {
    const next = normalizeOne({ ...get(employeeId), ...patch });
    prefsByEmployee.value = { ...prefsByEmployee.value, [employeeId]: next };
    await persist();
    return next;
  };

  const reset = async (employeeId: string) => {
    const next = { ...prefsByEmployee.value };
    delete next[employeeId];
    prefsByEmployee.value = next;
    await persist();
  };

  return { prefsByEmployee, load, get, set, reset, defaultEmployeeRuntimePrefs };
}
