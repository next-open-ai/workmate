import { computed, ref } from 'vue';
import { useI18n } from './i18n';

export type NotifyKind = 'success' | 'error' | 'info' | 'warning';

export interface NotifyItem {
  id: string;
  kind: NotifyKind;
  title: string;
  detail?: string;
  createdAt: number;
}

const items = ref<NotifyItem[]>([]);
const DEFAULT_TTL_MS = 5200;

function push(kind: NotifyKind, title: string, detail?: string, ttlMs = DEFAULT_TTL_MS) {
  const id = crypto.randomUUID();
  items.value = [{ id, kind, title, detail, createdAt: Date.now() }, ...items.value].slice(0, 5);
  window.setTimeout(() => dismiss(id), ttlMs);
  return id;
}

export function dismiss(id: string) {
  items.value = items.value.filter((item) => item.id !== id);
}

/** Map raw/technical errors to stable i18n keys when possible. */
export function classifyErrorKey(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : String(raw || '');
  const lower = message.toLowerCase();
  if (!message.trim()) return 'notify.error.unknown';
  if (/fetch failed|failed to fetch|networkerror|econnrefused|enotfound|network/i.test(lower)) return 'notify.error.network';
  if (/timeout|aborted|abort/i.test(lower)) return 'notify.error.timeout';
  if (/api key|unauthorized|401|invalid.*key|authentication/i.test(lower)) return 'notify.error.auth';
  if (/403|forbidden|permission|denied/i.test(lower)) return 'notify.error.permission';
  if (/404|not found/i.test(lower)) return 'notify.error.notFound';
  if (/429|rate limit|too many/i.test(lower)) return 'notify.error.rateLimit';
  if (/5\d\d|server error|internal/i.test(lower)) return 'notify.error.server';
  if (/invalid url|url/i.test(lower) && /base|endpoint|address/i.test(lower)) return 'notify.error.invalidUrl';
  if (/model.*required|尚未配置|not configured|api key 不可用/i.test(lower)) return 'notify.error.modelMissing';
  if (/chat request failed|api health/i.test(lower)) return 'notify.error.service';
  return 'notify.error.generic';
}

export function useNotify() {
  const { t } = useI18n();
  const list = computed(() => items.value);

  const success = (titleKey: string, detail?: string) => push('success', t(titleKey), detail);
  const info = (titleKey: string, detail?: string) => push('info', t(titleKey), detail);
  const warning = (titleKey: string, detail?: string) => push('warning', t(titleKey), detail);

  const error = (raw: unknown, titleKey = 'notify.error.title') => {
    const key = classifyErrorKey(raw);
    const friendly = t(key);
    const detail = raw instanceof Error ? raw.message : String(raw || '');
    // Always keep Bailian/OpenAPI technical detail visible (permission classification used to hide it).
    const keepDetail = Boolean(detail)
      && detail !== friendly
      && (key === 'notify.error.generic' || /bailian|openapi|oss upload|aliyun|AccessKey|workspace|category/i.test(detail));
    return push('error', t(titleKey), keepDetail ? `${friendly} · ${detail}` : friendly);
  };

  const errorMessage = (raw: unknown) => {
    const key = classifyErrorKey(raw);
    if (key === 'notify.error.generic') {
      const detail = raw instanceof Error ? raw.message : String(raw || '');
      return detail || t(key);
    }
    return t(key);
  };

  return { list, success, info, warning, error, errorMessage, dismiss, pushRaw: push };
}
