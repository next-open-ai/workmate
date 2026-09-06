/** Storage contract. SQLite implementation is intentionally deferred until sessions are introduced. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  #values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.#values.get(key) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.#values.set(key, value); }
}
