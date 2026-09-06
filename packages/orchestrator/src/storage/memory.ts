import type { KeyValueStore } from './kv.js';

/** In-memory store used by unit tests and ephemeral (headless) runs. */
export class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async keys(prefix = ''): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async flush(): Promise<void> {
    /* nothing to flush in memory */
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
