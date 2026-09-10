import { useEmployeeRuntimePrefs } from '../../app/employee-prefs';
import { PRESET_EMPLOYEES } from '../../app/employees';
import { readStored, writeStored } from '../../app/storage';

/**
 * Preset employees that prefer the dsh coding engine when available.
 * On first run / when dsh is missing we temporarily demote them to `pi`,
 * and restore `dsh` after a successful install/fix.
 */
export const DSH_PREFERRED_PRESET_IDS = ['code'] as const;

const FALLBACK_KEY = 'dsh.engine-fallback.v1';

type FallbackState = {
  /** Employee ids demoted from dsh → pi while runtime was unavailable. */
  demotedIds: string[];
};

async function readFallbackState(): Promise<FallbackState> {
  try {
    const raw = JSON.parse((await readStored(FALLBACK_KEY)) || '{}') as Partial<FallbackState>;
    const demotedIds = Array.isArray(raw.demotedIds)
      ? raw.demotedIds.map((id) => String(id)).filter(Boolean)
      : [];
    return { demotedIds };
  } catch {
    return { demotedIds: [] };
  }
}

async function writeFallbackState(state: FallbackState) {
  await writeStored(FALLBACK_KEY, JSON.stringify(state));
}

/**
 * Ensure preset coding employees are pinned to dsh when unset.
 * Does not overwrite a user-chosen non-dsh engine.
 */
export async function ensurePresetEmployeesPreferDsh(): Promise<string[]> {
  const prefsApi = useEmployeeRuntimePrefs();
  await prefsApi.load({ force: true });
  const touched: string[] = [];
  for (const id of DSH_PREFERRED_PRESET_IDS) {
    if (!PRESET_EMPLOYEES.some((item) => item.id === id)) continue;
    const current = prefsApi.get(id);
    if (current.engine == null) {
      await prefsApi.set(id, { engine: 'dsh' });
      touched.push(id);
    }
  }
  return touched;
}

/**
 * When dsh runtime is unavailable: switch employees currently on dsh to pi,
 * and remember them so we can restore after a successful install.
 */
export async function demoteDshEmployeesToPi(): Promise<string[]> {
  const prefsApi = useEmployeeRuntimePrefs();
  await prefsApi.load({ force: true });
  await ensurePresetEmployeesPreferDsh();

  const state = await readFallbackState();
  const demoted = new Set(state.demotedIds);
  const newly: string[] = [];

  const allIds = new Set([
    ...Object.keys(prefsApi.prefsByEmployee.value),
    ...DSH_PREFERRED_PRESET_IDS,
  ]);

  for (const id of allIds) {
    const current = prefsApi.get(id);
    if (current.engine !== 'dsh') continue;
    await prefsApi.set(id, { engine: 'pi' });
    demoted.add(id);
    newly.push(id);
  }

  await writeFallbackState({ demotedIds: [...demoted] });
  return newly;
}

/**
 * After dsh becomes available: restore demoted employees back to dsh.
 * Also re-apply preferred preset pins that were left on pi by the fallback.
 */
export async function restoreDemotedEmployeesToDsh(): Promise<string[]> {
  const prefsApi = useEmployeeRuntimePrefs();
  await prefsApi.load({ force: true });
  const state = await readFallbackState();
  const restored: string[] = [];
  const remaining: string[] = [];

  for (const id of state.demotedIds) {
    const current = prefsApi.get(id);
    // Only restore if still on the temporary pi fallback (user may have changed it).
    if (current.engine === 'pi' || current.engine == null) {
      await prefsApi.set(id, { engine: 'dsh' });
      restored.push(id);
    } else {
      remaining.push(id);
    }
  }

  // Preferred presets: if still unset/pi after a successful fix, pin to dsh once.
  for (const id of DSH_PREFERRED_PRESET_IDS) {
    if (restored.includes(id)) continue;
    const current = prefsApi.get(id);
    if (current.engine == null || (current.engine === 'pi' && state.demotedIds.includes(id))) {
      await prefsApi.set(id, { engine: 'dsh' });
      if (!restored.includes(id)) restored.push(id);
    }
  }

  await writeFallbackState({ demotedIds: remaining });
  return restored;
}
