import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { KnowledgeEvidenceStore } from '@workmate/storage';
import type { KnowledgeEvidence, KnowledgeRetrievalVisibility } from '@workmate/contracts';
import { knowledgeContentHash, legacyKnowledgeEvidence } from './knowledge-evidence.js';

export function evidencePath(dataDir: string): string { return path.join(dataDir, 'knowledge-evidence.sqlite'); }
export function openKnowledgeEvidence(dataDir: string): KnowledgeEvidenceStore {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return new KnowledgeEvidenceStore(evidencePath(dataDir));
}
export function readVisibility(dataDir: string): KnowledgeRetrievalVisibility {
  if (!existsSync(evidencePath(dataDir))) return { activeChunkIds: [], inactiveChunkIds: [], suppressedChunkIds: [] };
  const store = openKnowledgeEvidence(dataDir);
  try { return store.getVisibility(); } finally { store.close(); }
}
export function visiblePredicate(visibility: KnowledgeRetrievalVisibility): (row: { id: string }) => boolean {
  const active = new Set(visibility.activeChunkIds), suppressed = new Set([...visibility.suppressedChunkIds, ...visibility.inactiveChunkIds]);
  return (row) => !suppressed.has(row.id) && (!row.id.startsWith('ch-') || active.has(row.id));
}
export function visibilitySql(visibility: KnowledgeRetrievalVisibility): string {
  const literals = (ids: string[]) => ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
  const active = visibility.activeChunkIds.length ? ` OR id IN (${literals(visibility.activeChunkIds)})` : '';
  const excluded = [...new Set([...visibility.suppressedChunkIds, ...visibility.inactiveChunkIds])];
  const suppressed = excluded.length ? ` AND id NOT IN (${literals(excluded)})` : '';
  return `(id NOT LIKE 'ch-%'${active})${suppressed}`;
}

/** Recheck after asynchronous vector reads; never turn missing managed evidence into legacy evidence. */
export function withCurrentEvidence<T extends { id: string; documentId: string; content: string }>(
  dataDir: string, kbId: string, rows: T[],
): Array<T & { evidence: KnowledgeEvidence }> {
  const store = existsSync(evidencePath(dataDir)) ? openKnowledgeEvidence(dataDir) : undefined;
  try {
    const visible = visiblePredicate(store?.getVisibility() ?? { activeChunkIds: [], inactiveChunkIds: [], suppressedChunkIds: [] });
    const current = rows.filter(visible);
    const evidenceById = store?.getEvidenceMany(current.map(row => row.id));
    return current.map((row) => {
      const evidence = evidenceById?.get(row.id);
      if (evidence?.verification === 'versioned') {
        if (evidence.contentHash !== knowledgeContentHash(row.content) || evidence.documentId !== row.documentId
          || evidence.knowledgeBaseId !== kbId || evidence.provider !== 'lancedb') throw new Error('Knowledge evidence does not match its retrieval copy.');
        return { ...row, evidence };
      }
      if (row.id.startsWith('ch-')) throw new Error('Managed knowledge evidence is unavailable.');
      return { ...row, evidence: legacyKnowledgeEvidence({ provider: 'lancedb', knowledgeBaseId: kbId, documentId: row.documentId }, row.id) };
    });
  } finally { store?.close(); }
}
