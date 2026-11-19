export const DEEPSEEK_SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
export function isOfficialDeepSeekConnection(value: unknown): boolean {
  const item = record(value);
  if (item.type !== 'deepseek') return false;
  if (!String(item.baseUrl || '').trim()) return true;
  try {
    const url = new URL(String(item.baseUrl));
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && !url.port && !url.username && !url.password;
  } catch { return false; }
}
/** Persist only the connection reference; never copy a model key into search settings. */
export function linkDeepSeekSearchSettings(search: unknown, models: unknown): Row {
  const settings = record(search), model = record(models), providers = rows(settings.providers);
  const existing = providers.find(item => item.id === 'deepseek');
  const candidates = rows(model.providerInstances).filter(item => typeof item.id === 'string' && item.id.trim() && isOfficialDeepSeekConnection(item) && String(item.apiKey || '').trim());
  const active = rows(model.models).find(item => item.id === model.activeChatModelId);
  const selected = candidates.find(item => item.id === existing?.providerInstanceId)
    ?? candidates.find(item => item.id === active?.providerInstanceId) ?? candidates[0];
  if (!selected) return stripLinkedSearchSecrets(settings);
  const linked = { ...existing, id: 'deepseek', label: 'DeepSeek 在线搜索', apiKey: '',
    baseUrl: existing?.providerInstanceId ? existing.baseUrl || DEEPSEEK_SEARCH_ENDPOINT : DEEPSEEK_SEARCH_ENDPOINT,
    enabled: (existing?.providerInstanceId || existing?.apiKey) ? existing.enabled ?? true : true,
    providerInstanceId: String(selected.id) };
  return stripLinkedSearchSecrets({ ...settings, version: 1, defaultProvider: settings.defaultProvider || 'auto',
    providers: [...providers.filter(item => item.id !== 'deepseek'), linked] });
}
export function stripLinkedSearchSecrets(search: unknown): Row {
  const settings = record(search);
  return { ...settings, providers: rows(settings.providers).map(item =>
    item.id === 'deepseek' && item.providerInstanceId ? { ...item, apiKey: '' } : { ...item }) };
}
/** Runtime-only hydration. Missing or changed connection fails closed, never falls back to an old key. */
export function resolveLinkedSearchSettings(search: unknown, models: unknown): Row {
  const settings = record(search), instances = rows(record(models).providerInstances);
  return { ...settings, providers: rows(settings.providers).map(item => {
    if (item.id !== 'deepseek' || !item.providerInstanceId) return { ...item };
    const connection = instances.find(candidate => candidate.id === item.providerInstanceId && isOfficialDeepSeekConnection(candidate));
    return { ...item, apiKey: String(connection?.apiKey || '').trim() };
  }) };
}
