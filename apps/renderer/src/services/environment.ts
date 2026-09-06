import { computed, ref } from 'vue';
import { getEnvironmentReport, type EnvCheckReport } from './api.js';

/**
 * Startup/manual environment checks (Node/Python/pip/git/npx/storage dir).
 * Desktop / Web / Docker now share the same API-backed environment report.
 */

export type EnvRunStatus = 'idle' | 'checking' | 'ready';

export interface EnvProgressRow {
  id: string;
  name: string;
  required: string;
  state: 'checking' | 'done';
  status?: EnvCheckItem['status'];
  found?: string;
}

const runStatus = ref<EnvRunStatus>('idle');
const report = ref<EnvCheckReport | null>(null);
const errorMessage = ref('');
const progressRows = ref<EnvProgressRow[]>([]);
let inFlight = false;

export async function runEnvironmentCheck(): Promise<EnvCheckReport | null> {
  if (inFlight) return report.value;
  inFlight = true;
  runStatus.value = 'checking';
  errorMessage.value = '';
  progressRows.value = [];
  try {
    const result = await getEnvironmentReport();
    report.value = result;
    if (result) {
      progressRows.value = result.checks.map((item) => ({
        id: item.id,
        name: item.name,
        required: item.required,
        state: 'done',
        status: item.status,
        found: item.found,
      }));
    }
    return result;
  } catch (cause) {
    errorMessage.value = cause instanceof Error ? cause.message : String(cause);
    report.value = null;
    return null;
  } finally {
    runStatus.value = 'ready';
    inFlight = false;
  }
}

export const environmentState = {
  runStatus,
  report,
  errorMessage,
  progressRows,
};

/** Number of items that need attention (errors + warnings). */
export const environmentIssueCount = computed(() => {
  const summary = report.value?.summary;
  return summary ? summary.error + summary.warn : 0;
});

/** Short text for badges, e.g. "3 项需处理". */
export function environmentSummaryText(): string {
  const summary = report.value?.summary;
  if (!summary) return '环境检查未完成';
  if (summary.error === 0 && summary.warn === 0) return `环境就绪（${summary.ok}/${summary.total}）`;
  const parts: string[] = [];
  if (summary.error) parts.push(`${summary.error} 项不满足`);
  if (summary.warn) parts.push(`${summary.warn} 项建议`);
  return parts.join('，');
}
