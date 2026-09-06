import { ref } from 'vue';
import type { EmployeeId } from './workspace.js';
import type { ProviderId } from './model-config.js';
import type { ToolActivity, ToolApproval } from '../services/api.js';
import { readStored, writeStored } from './storage.js';

export type AutomationSchedule = { kind: 'once'; at: number } | { kind: 'interval'; everyMinutes: number } | { kind: 'recurring'; frequency: 'daily' | 'weekly' | 'monthly'; time: string; weekdays?: number[]; dayOfMonth?: number };
export interface Automation { id: string; name: string; prompt: string; employeeId: EmployeeId; provider: ProviderId; modelId?: string; skillIds: string[]; schedule: AutomationSchedule; enabled: boolean; createdAt: number; updatedAt: number; nextRunAt: number; lastRunAt?: number; lastStatus?: 'success' | 'failed'; lastError?: string; }
export interface AutomationRunTranscript {
  prompt: string;
  conversationId: string | null;
  assistantContent: string;
  activities: ToolActivity[];
  approvals: ToolApproval[];
  assets: Array<{ id: string; name: string; sizeBytes: number }>;
}
export interface AutomationRun { id: string; automationId: string; automationName: string; employeeId: EmployeeId; provider: ProviderId; startedAt: number; finishedAt?: number; status: 'running' | 'success' | 'failed'; error?: string; trigger: 'scheduled' | 'manual'; transcript?: AutomationRunTranscript; }
const key = 'automations.v1';
const runKey = 'automation-runs.v1';
const automations = ref<Automation[]>([]);
const runs = ref<AutomationRun[]>([]);
let timer: ReturnType<typeof setInterval> | undefined;
function atTime(base: Date, time: string) { const [hours, minutes] = time.split(':').map(Number); const next = new Date(base); next.setHours(hours || 0, minutes || 0, 0, 0); return next; }
function nextRecurring(schedule: Extract<AutomationSchedule, { kind: 'recurring' }>, from: number) {
  const now = new Date(from); const candidate = atTime(now, schedule.time);
  if (schedule.frequency === 'daily') { if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1); return candidate.getTime(); }
  if (schedule.frequency === 'weekly') {
    const days = (schedule.weekdays?.length ? schedule.weekdays : [1]).sort();
    for (let offset = 0; offset <= 7; offset += 1) { const next = new Date(candidate); next.setDate(now.getDate() + offset); if (days.includes(next.getDay()) && next.getTime() > from) return next.getTime(); }
  }
  const day = Math.min(Math.max(1, schedule.dayOfMonth ?? 1), 28);
  candidate.setDate(day); if (candidate.getTime() <= from) candidate.setMonth(candidate.getMonth() + 1); return candidate.getTime();
}
function nextRun(schedule: AutomationSchedule, from = Date.now()) { if (schedule.kind === 'once') return schedule.at; if (schedule.kind === 'interval') return from + schedule.everyMinutes * 60_000; return nextRecurring(schedule, from); }

export function useAutomations() {
  const persist = async () => writeStored(key, JSON.stringify(automations.value));
  const persistRuns = async () => writeStored(runKey, JSON.stringify(runs.value.slice(0, 200)));
  const load = async () => { try { automations.value = JSON.parse((await readStored(key)) || '[]') as Automation[]; } catch { automations.value = []; } };
  const loadRuns = async () => { try { runs.value = JSON.parse((await readStored(runKey)) || '[]') as AutomationRun[]; } catch { runs.value = []; } };
  const beginRun = async (item: Automation, trigger: AutomationRun['trigger']) => { const run: AutomationRun = { id: crypto.randomUUID(), automationId: item.id, automationName: item.name, employeeId: item.employeeId, provider: item.provider, startedAt: Date.now(), status: 'running', trigger }; runs.value = [run, ...runs.value]; await persistRuns(); return run; };
  const finishRun = async (run: AutomationRun, status: 'success' | 'failed', error?: string, transcript?: AutomationRunTranscript) => {
    run.status = status;
    run.finishedAt = Date.now();
    run.error = error;
    if (transcript) run.transcript = transcript;
    runs.value = [...runs.value];
    await persistRuns();
  };
  const save = async (input: Omit<Automation, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt'>) => {
    const now = Date.now(); const item: Automation = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now, nextRunAt: nextRun(input.schedule, now) };
    automations.value = [item, ...automations.value]; await persist(); return item;
  };
  const update = async (item: Automation) => { item.updatedAt = Date.now(); automations.value = [...automations.value]; await persist(); };
  const remove = async (id: string) => { automations.value = automations.value.filter((item) => item.id !== id); await persist(); };
  const startScheduler = (run: (item: Automation) => Promise<AutomationRunTranscript | undefined>) => {
    if (timer) clearInterval(timer);
    const tick = async () => {
      for (const item of automations.value.filter((candidate) => candidate.enabled && candidate.nextRunAt <= Date.now())) {
        item.enabled = item.schedule.kind !== 'once'; item.lastRunAt = Date.now(); item.nextRunAt = nextRun(item.schedule, item.lastRunAt);
        const record = await beginRun(item, 'scheduled');
        try {
          const transcript = await run(item);
          item.lastStatus = 'success'; item.lastError = undefined;
          await finishRun(record, 'success', undefined, transcript);
        } catch (error) {
          item.lastStatus = 'failed'; item.lastError = error instanceof Error ? error.message : '运行失败';
          await finishRun(record, 'failed', item.lastError);
        }
        await update(item);
      }
    };
    void tick(); timer = setInterval(() => void tick(), 30_000);
    return () => { if (timer) clearInterval(timer); timer = undefined; };
  };
  return { automations, runs, load, loadRuns, save, update, remove, beginRun, finishRun, startScheduler };
}
