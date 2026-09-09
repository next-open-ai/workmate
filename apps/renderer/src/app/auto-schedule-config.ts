import { computed, ref } from 'vue';
import { readStored, writeStored } from './storage.js';

export interface AutoScheduleConfig {
  /** Prefer the fewest agents; collapse to primary when sufficient. */
  preferMinimal: boolean;
  /** Only keep agents that are a strong fit for a distinct need. */
  strongFitOnly: boolean;
  /** Hard cap on distinct agents in a planned schedule. */
  maxAgents: number;
}

export const DEFAULT_AUTO_SCHEDULE_MAX_AGENTS = 5;
export const MIN_AUTO_SCHEDULE_MAX_AGENTS = 1;
export const MAX_AUTO_SCHEDULE_MAX_AGENTS = 12;

const STORAGE_KEY = 'workspace.auto-schedule-config';

export const defaultAutoScheduleConfig = (): AutoScheduleConfig => ({
  preferMinimal: true,
  strongFitOnly: true,
  maxAgents: DEFAULT_AUTO_SCHEDULE_MAX_AGENTS,
});

function clampMaxAgents(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AUTO_SCHEDULE_MAX_AGENTS;
  return Math.min(MAX_AUTO_SCHEDULE_MAX_AGENTS, Math.max(MIN_AUTO_SCHEDULE_MAX_AGENTS, Math.round(n)));
}

function normalizeConfig(raw: unknown): AutoScheduleConfig {
  const base = defaultAutoScheduleConfig();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<AutoScheduleConfig>;
  return {
    preferMinimal: value.preferMinimal !== false,
    strongFitOnly: value.strongFitOnly !== false,
    maxAgents: clampMaxAgents(value.maxAgents),
  };
}

const config = ref<AutoScheduleConfig>(defaultAutoScheduleConfig());
const loaded = ref(false);

export function useAutoScheduleConfig() {
  const load = async () => {
    try {
      const raw = await readStored(STORAGE_KEY);
      config.value = normalizeConfig(raw ? JSON.parse(raw) : null);
    } catch {
      config.value = defaultAutoScheduleConfig();
    } finally {
      loaded.value = true;
    }
  };

  const save = async (next: AutoScheduleConfig) => {
    const normalized = normalizeConfig(next);
    config.value = normalized;
    await writeStored(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  };

  const update = async (patch: Partial<AutoScheduleConfig>) => {
    return save({ ...config.value, ...patch });
  };

  return {
    config: computed(() => config.value),
    loaded: computed(() => loaded.value),
    load,
    save,
    update,
    clampMaxAgents,
  };
}
