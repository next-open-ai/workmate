/** Shared storage contracts and dedicated knowledge evidence/Wiki repositories. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  #values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.#values.get(key) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.#values.set(key, value); }
}

export { KnowledgeEvidenceStore, KnowledgeEvidenceStoreError } from './knowledge-evidence-store.js';
export { KnowledgeWikiStore, KnowledgeWikiError, type WikiSourceAuthorizer } from './knowledge-wiki-store.js';
export { ImmutableFileStore, ImmutableFileError } from './immutable-file-store.js';
export { KnowledgeSourceStore, KnowledgeSourceStoreError } from './knowledge-source-store.js';
