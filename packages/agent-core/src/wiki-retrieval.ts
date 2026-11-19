import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { KnowledgeEvidenceStore, KnowledgeSourceStore, ImmutableFileStore } from '@workmate/storage';
import type { KnowledgeWikiStore } from '@workmate/storage';
import type { KnowledgeBaseRuntime, WikiRecall, WikiSearchHit } from '@workmate/contracts';

/** The host supplies this runtime only after catalog authorization; never derive ownership from a page. */
function withWiki<T>(kb: KnowledgeBaseRuntime, directory: string, empty: T, read: (wiki: KnowledgeWikiStore) => T): T {
  if (kb.provider !== 'lancedb' || kb.wikiRetrievalEnabled !== true) return empty;
  if (!kb.wikiAccess) throw new Error('Wiki 检索缺少授权上下文，请重新打开知识库。');
  const { orgId, userId, sourceRoot } = kb.wikiAccess;
  const owner = { orgId, userId };
  const dbPath = path.join(directory, 'knowledge-evidence.sqlite');
  const sourcesPath = path.join(sourceRoot, 'sources.sqlite'), objects = path.join(sourceRoot, 'objects');
  if (!existsSync(dbPath)) return empty;
  if ([directory, dbPath, sourceRoot, sourcesPath, objects].some(p => existsSync(p) && lstatSync(p).isSymbolicLink())) {
    throw new Error('Wiki 检索存储路径不可用。');
  }
  let evidence: KnowledgeEvidenceStore | undefined, sources: KnowledgeSourceStore | undefined;
  try {
    evidence = new KnowledgeEvidenceStore(dbPath, { existingOnly: true, readOnly: true });
    // A missing archive must not let derived content bypass source validation.
    if (!existsSync(sourcesPath) || !existsSync(objects)) {
      if (!evidence.openExistingWiki({ ...owner, knowledgeBaseId: kb.id }, () => false)) return empty;
      throw new Error('Wiki 原文归档不可用。');
    }
    sources = new KnowledgeSourceStore(sourcesPath, new ImmutableFileStore(objects), { readOnly: true });
    const wiki = evidence.openExistingWiki({ ...owner, knowledgeBaseId: kb.id }, ref => {
      if (ref.evidence.verification !== 'versioned') return false;
      const snapshot = sources!.get(owner, ref.evidence.documentVersionId);
      return snapshot?.provider === 'lancedb' && snapshot.knowledgeBaseId === kb.id && snapshot.documentId === ref.evidence.documentId;
    });
    return wiki ? read(wiki) : empty;
  } finally { sources?.close(); evidence?.close(); }
}

type RecallHit = WikiSearchHit & { wiki: WikiRecall };
export function recallWiki(kb: KnowledgeBaseRuntime, directory: string, query: string, limit: number): RecallHit[] {
  if (!query.trim()) return [];
  return withWiki(kb, directory, [], store => {
    const direct: RecallHit[] = store.search(query.slice(0, 256), Math.min(20, limit)).flatMap(hit => {
    const view = store.read(hit.pageId);
    if (!view || view.freshness !== 'current' || view.page.publishedRevisionId !== hit.revisionId) return [];
    return [{ ...hit, wiki: { pageId: hit.pageId, revisionId: hit.revisionId,
      evidenceRefs: view.revision.content.evidenceRefs.slice(0, 8), sourcesTruncated: view.revision.content.evidenceRefs.length > 8 } }];
    });
    return direct;
  });
}

export function currentWikiRevisions(kb: KnowledgeBaseRuntime, directory: string, refs: WikiRecall[]): Set<string> {
  return withWiki(kb, directory, new Set<string>(), store => new Set(refs.filter(ref => {
    const view = store.read(ref.pageId);
    return view?.freshness === 'current' && view.page.publishedRevisionId === ref.revisionId;
  }).map(ref => `${ref.pageId}:${ref.revisionId}`)));
}
