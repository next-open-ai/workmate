import { computed, ref } from 'vue';
import { getStoredSessionToken } from '../../services/auth';
import type { EnvCheckReport } from '../../services/api';
import { DSH_ENV_CHECK_ID, DSH_ENV_FIX_ACTION_ID } from './environment-ui';
import { restoreDemotedEmployeesToDsh } from './engine-fallback';

export type DshInstallPhase =
  | 'idle'
  | 'prepare'
  | 'resolve-npm'
  | 'npm-install'
  | 'verify'
  | 'activate'
  | 'done'
  | 'error'
  | 'skipped';

export type DshInstallUiEvent = {
  type: 'phase' | 'log' | 'done' | 'error' | 'complete';
  phase?: DshInstallPhase;
  message: string;
  percent?: number;
  detail?: string;
  ok?: boolean;
  skipped?: boolean;
  report?: EnvCheckReport;
};

const busy = ref(false);
const phase = ref<DshInstallPhase>('idle');
const percent = ref(0);
const message = ref('');
const detail = ref('');
const error = ref('');
const logs = ref<string[]>([]);
const lastReport = ref<EnvCheckReport | null>(null);
const source = ref<'manual' | 'startup' | null>(null);

export const dshInstallState = {
  busy,
  phase,
  percent,
  message,
  detail,
  error,
  logs,
  lastReport,
  source,
};

export const dshInstallPhaseLabel = computed(() => {
  const map: Record<DshInstallPhase, string> = {
    idle: '待命',
    prepare: '准备目录',
    'resolve-npm': '解析 npm',
    'npm-install': '下载安装依赖',
    verify: '校验二进制',
    activate: '激活 runtime',
    done: '完成',
    error: '失败',
    skipped: '已就绪（跳过）',
  };
  return map[phase.value] || phase.value;
});

function apiBase() {
  return window.location.protocol === 'file:' ? 'http://127.0.0.1:4328' : '';
}

function resetProgress(nextSource: 'manual' | 'startup') {
  busy.value = true;
  phase.value = 'prepare';
  percent.value = 1;
  message.value = '正在准备安装 dsh 编码引擎…';
  detail.value = '';
  error.value = '';
  logs.value = [];
  source.value = nextSource;
}

function pushLog(line: string) {
  const text = line.trim();
  if (!text) return;
  logs.value = [...logs.value.slice(-80), text];
}

function applyEvent(event: DshInstallUiEvent) {
  if (typeof event.percent === 'number' && Number.isFinite(event.percent)) {
    percent.value = Math.max(percent.value, Math.min(100, Math.round(event.percent)));
  }
  if (event.phase) phase.value = event.phase;
  if (event.message) {
    message.value = event.message;
    if (event.type === 'log' || event.type === 'phase') pushLog(event.message);
  }
  if (event.detail) detail.value = event.detail;
  if (event.report) lastReport.value = event.report;
  if (event.type === 'error') {
    error.value = event.message;
    phase.value = 'error';
  }
  if (event.type === 'done' || event.type === 'complete') {
    if (event.phase === 'skipped') phase.value = 'skipped';
    else if (event.ok !== false) phase.value = 'done';
    percent.value = 100;
  }
}

async function readSseStream(
  response: Response,
  onEvent: (event: DshInstallUiEvent) => void,
) {
  if (!response.body) throw new Error('安装接口未返回可读流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          onEvent(JSON.parse(raw) as DshInstallUiEvent);
        } catch {
          pushLog(raw);
        }
      }
    }
  }
}

/**
 * Stream-install dsh runtime. `reinstall=false` skips when already available.
 */
export async function installDshRuntimeWithProgress(options?: {
  reinstall?: boolean;
  source?: 'manual' | 'startup';
}): Promise<{ ok: boolean; skipped?: boolean; message: string; report?: EnvCheckReport | null }> {
  if (busy.value) {
    return { ok: false, message: 'dsh 安装正在进行中' };
  }
  resetProgress(options?.source || 'manual');
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      Accept: 'text/event-stream',
    };
    const token = getStoredSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${apiBase()}/api/environment/dsh/install`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        reinstall: Boolean(options?.reinstall),
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(body.message || `安装失败：HTTP ${response.status}`);
    }

    const summary = {
      ok: false,
      skipped: false,
      message: '',
      report: null as EnvCheckReport | null,
    };
    await readSseStream(response, (event) => {
      applyEvent(event);
      if (event.type === 'complete') {
        summary.ok = event.ok !== false;
        summary.skipped = Boolean(event.skipped);
        summary.message = event.message || message.value || 'dsh 安装完成';
        if (event.report) summary.report = event.report;
      }
      if (event.type === 'error' && event.ok === false) {
        summary.ok = false;
        summary.message = event.message || 'dsh 安装失败';
      }
    });

    if (!summary.ok && error.value) {
      throw new Error(error.value || summary.message || 'dsh 安装失败');
    }
    if (!summary.ok && summary.message && phase.value === 'error') {
      throw new Error(summary.message);
    }
    const finalMessage = summary.message || message.value || 'dsh 安装完成';
    message.value = finalMessage;
    const result = {
      ok: true,
      skipped: summary.skipped || phase.value === 'skipped',
      message: finalMessage,
      report: summary.report || lastReport.value,
    };
    // Restore employees that were temporarily switched to pi while dsh was missing.
    if (result.ok && phase.value !== 'error') {
      await restoreDemotedEmployeesToDsh().catch(() => undefined);
    }
    return result;
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    error.value = text;
    phase.value = 'error';
    message.value = text;
    throw cause instanceof Error ? cause : new Error(text);
  } finally {
    busy.value = false;
  }
}

export function isDshCheckMissing(report: EnvCheckReport | null | undefined): boolean {
  if (!report) return false;
  const item = report.checks.find((check) => check.id === DSH_ENV_CHECK_ID);
  return Boolean(item && item.status !== 'ok');
}

export { DSH_ENV_FIX_ACTION_ID, DSH_ENV_CHECK_ID };
