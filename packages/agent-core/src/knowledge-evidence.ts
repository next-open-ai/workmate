import { createHash } from 'node:crypto';
import { z } from 'zod';
import { KnowledgeDocumentScopeSchema, KnowledgeEvidenceSchema, KnowledgeProcessingRecipeSchema, type KnowledgeDocumentScope, type KnowledgeEvidence, type KnowledgeProcessingRecipe } from '@workmate/contracts';
export type { KnowledgeProcessingRecipe } from '@workmate/contracts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function knowledgeContentHash(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function identifyKnowledgeVersion(scope: KnowledgeDocumentScope, sourceBytes: Uint8Array) {
  const parsed = KnowledgeDocumentScopeSchema.parse(scope);
  const sourceHash = knowledgeContentHash(sourceBytes);
  return { sourceHash, documentVersionId: 'dv-' + knowledgeContentHash(canonical({ ...parsed, sourceHash })) };
}

export function identifyKnowledgeProcessing(documentVersionId: string, recipe: KnowledgeProcessingRecipe): string {
  z.string().min(1).parse(documentVersionId);
  const parsed = KnowledgeProcessingRecipeSchema.parse(recipe);
  return 'pr-' + knowledgeContentHash(canonical({ documentVersionId, recipe: parsed }));
}

export function createVersionedKnowledgeEvidence(input: {
  scope: KnowledgeDocumentScope;
  documentVersionId: string;
  processingRevisionId: string;
  ordinal: number;
  content: string;
  parentChunkId?: string;
  headingPath?: string[];
  sourceLocation?: { coordinateSystem: 'normalized-text-utf16'; start: number; end: number };
}): Extract<KnowledgeEvidence, { verification: 'versioned' }> {
  z.number().int().nonnegative().parse(input.ordinal);
  const contentHash = knowledgeContentHash(input.content);
  const scope = KnowledgeDocumentScopeSchema.parse(input.scope);
  const chunkId = 'ch-' + knowledgeContentHash(canonical({ ...scope, documentVersionId: input.documentVersionId,
    processingRevisionId: input.processingRevisionId, ordinal: input.ordinal, contentHash }));
  const evidence = KnowledgeEvidenceSchema.parse({ ...scope, schemaVersion: 1, verification: 'versioned', chunkId,
    documentVersionId: input.documentVersionId, processingRevisionId: input.processingRevisionId, contentHash,
    parentChunkId: input.parentChunkId, sourceLocation: input.sourceLocation, headingPath: input.headingPath });
  if (evidence.verification !== 'versioned') throw new TypeError('Expected versioned evidence');
  return evidence;
}

export function legacyKnowledgeEvidence(scope: KnowledgeDocumentScope, chunkId: string): KnowledgeEvidence {
  return KnowledgeEvidenceSchema.parse({ ...KnowledgeDocumentScopeSchema.parse(scope), schemaVersion: 1,
    verification: 'legacy-unverified', chunkId });
}
