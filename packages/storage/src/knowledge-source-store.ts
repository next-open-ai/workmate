import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { KnowledgeSourceSnapshotSchema, type FileOwner, type KnowledgeSourceSnapshot } from '@workmate/contracts';
import { fileOwnerKey, ImmutableFileStore } from './immutable-file-store.js';

const APPLICATION_ID = 0x57454b53;
export class KnowledgeSourceStoreError extends Error {
  constructor(public readonly code: 'UNSUPPORTED_SOURCE_SCHEMA' | 'SOURCE_VERSION_CONFLICT') {
    super(code); this.name = 'KnowledgeSourceStoreError';
  }
}
/** Source references only. Deliberately separate from assets' mutable sql.js database. */
export class KnowledgeSourceStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly files: ImmutableFileStore, options: { readOnly?: boolean } = {}) {
    const { DatabaseSync: SQLite } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.db = new SQLite(databasePath, { readOnly: options.readOnly ?? false });
    try {
      if (options.readOnly) {
        if (this.db.prepare('PRAGMA user_version').get()!.user_version !== 1
          || this.db.prepare('PRAGMA application_id').get()!.application_id !== APPLICATION_ID) {
          throw new KnowledgeSourceStoreError('UNSUPPORTED_SOURCE_SCHEMA');
        }
        return;
      }
      this.db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      const application = this.db.prepare('PRAGMA application_id').get()!.application_id;
      if (version === 0 && application === 0 && !this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        this.db.exec(`CREATE TABLE sources (owner TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(owner, version)); PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`);
      } else if (version !== 1 || application !== APPLICATION_ID) {
        throw new KnowledgeSourceStoreError('UNSUPPORTED_SOURCE_SCHEMA');
      }
      this.db.exec('COMMIT; PRAGMA journal_mode=WAL');
    } catch (error) { this.db.close(); throw error; }
  }
  put(owner: FileOwner, input: KnowledgeSourceSnapshot): KnowledgeSourceSnapshot {
    const snapshot = KnowledgeSourceSnapshotSchema.parse(input);
    // References are committed only after verifying the immutable file exists and matches its hash.
    this.files.read(owner, snapshot.file);
    const key = fileOwnerKey(owner);
    const payload = JSON.stringify(snapshot);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT payload FROM sources WHERE owner=? AND version=?').get(key, snapshot.documentVersionId);
      if (existing && existing.payload !== payload) throw new KnowledgeSourceStoreError('SOURCE_VERSION_CONFLICT');
      this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?,?)').run(key, snapshot.documentVersionId, payload);
      this.db.exec('COMMIT');
      return snapshot;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(owner: FileOwner, version: string): KnowledgeSourceSnapshot | undefined {
    const row = this.db.prepare('SELECT payload FROM sources WHERE owner=? AND version=?').get(fileOwnerKey(owner), version);
    return row ? KnowledgeSourceSnapshotSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }
  read(owner: FileOwner, version: string): { snapshot: KnowledgeSourceSnapshot; bytes: Buffer } | undefined {
    const snapshot = this.get(owner, version);
    return snapshot ? { snapshot, bytes: this.files.read(owner, snapshot.file) } : undefined;
  }
  close(): void { this.db.close(); }
}
