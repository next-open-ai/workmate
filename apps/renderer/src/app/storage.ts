let storageNamespace: string | null = null;

export function setStorageNamespace(value: string | null) {
  storageNamespace = value?.trim() || null;
}

function scopedKey(key: string) {
  if (!storageNamespace || key.startsWith('auth.')) return key;
  return `${storageNamespace}:${key}`;
}

export async function readStored(key: string): Promise<string | null> {
  const actualKey = scopedKey(key);
  if (window.workmateDesktop) return window.workmateDesktop.storageGet(actualKey);
  return window.localStorage.getItem(actualKey);
}

export async function writeStored(key: string, value: string): Promise<void> {
  const actualKey = scopedKey(key);
  if (window.workmateDesktop) return window.workmateDesktop.storageSet(actualKey, value);
  window.localStorage.setItem(actualKey, value);
}
