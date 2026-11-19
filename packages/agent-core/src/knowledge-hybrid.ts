import type { KnowledgeSearchChunk, KnowledgeKeywordHit, KnowledgeRetrieval } from '@workmate/contracts';

/** Equal-weight reciprocal ranks; never compare BM25 magnitudes with cosine scores. */
export function fuseKnowledgeRanks(
  keywords: KnowledgeKeywordHit[], vectors: Array<KnowledgeSearchChunk & { score: number }>, degraded = false,
): Array<KnowledgeSearchChunk & { score: number; retrieval: KnowledgeRetrieval }> {
  const merged = new Map<string, KnowledgeSearchChunk & { score: number; retrieval: KnowledgeRetrieval }>();
  for (const [channel, rows] of [['keyword', keywords], ['vector', vectors]] as const) {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      const hit = merged.get(row.id) ?? { id: row.id, documentId: row.documentId, title: row.title,
        content: row.content, source: row.source, score: 0, retrieval: { channels: [], ranking: 'rrf', degraded } };
      hit.score += 61 / (2 * (60 + index + 1));
      hit.retrieval.channels.push(channel);
      merged.set(row.id, hit);
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
