import type { KeyValueStore } from './storage/kv.js';

export async function readJson<T>(store: KeyValueStore, key: string): Promise<T | null> {
  const raw = await store.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(store: KeyValueStore, key: string, value: unknown): Promise<void> {
  await store.set(key, JSON.stringify(value));
}

export async function deleteKey(store: KeyValueStore, key: string): Promise<void> {
  await store.delete(key);
}

export async function listJsonIds(store: KeyValueStore, prefix: string): Promise<string[]> {
  const keys = await store.keys(prefix);
  return keys.map((key) => key.slice(prefix.length));
}
