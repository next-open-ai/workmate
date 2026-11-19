import { z } from 'zod';

const identity = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json),
]));
export const KnowledgeProcessingRecipeSchema = z.object({
  parser: z.string().min(1),
  chunker: z.string().min(1),
  config: z.record(json),
}).strict();
export type KnowledgeProcessingRecipe = z.infer<typeof KnowledgeProcessingRecipeSchema>;

export const KnowledgeSourceLocationSchema = z.object({
  coordinateSystem: z.literal('normalized-text-utf16'),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).strict().refine((value) => value.end > value.start, 'end must be greater than start');

export const KnowledgeDocumentScopeSchema = z.object({
  provider: identity,
  knowledgeBaseId: identity,
  documentId: identity,
}).strict();

const base = KnowledgeDocumentScopeSchema.extend({
  schemaVersion: z.literal(1),
  chunkId: identity,
});

export const KnowledgeEvidenceSchema = z.discriminatedUnion('verification', [
  base.extend({
    verification: z.literal('versioned'),
    documentVersionId: identity,
    processingRevisionId: identity,
    contentHash: hash,
    parentChunkId: identity.optional(),
    headingPath: z.array(z.string()).max(6).optional(),
    sourceLocation: KnowledgeSourceLocationSchema.optional(),
  }).strict(),
  base.extend({ verification: z.literal('legacy-unverified') }).strict(),
]);

export type KnowledgeDocumentScope = z.infer<typeof KnowledgeDocumentScopeSchema>;
export type KnowledgeEvidence = z.infer<typeof KnowledgeEvidenceSchema>;

const evidenceChunk = z.object({
  evidence: KnowledgeEvidenceSchema.refine((value) => value.verification === 'versioned'),
  content: z.string(),
}).strict();

export const KnowledgeEvidenceBatchSchema = KnowledgeDocumentScopeSchema.extend({
  documentVersionId: identity,
  processingRevisionId: identity,
  sourceHash: hash,
  recipe: KnowledgeProcessingRecipeSchema.optional(),
  documentTitle: z.string().optional(),
  source: z.string().optional(),
  chunks: z.array(evidenceChunk).min(1),
  parentChunks: z.array(evidenceChunk).optional(),
}).strict();
export type KnowledgeEvidenceBatch = z.infer<typeof KnowledgeEvidenceBatchSchema>;
export const KnowledgeEvidenceHeadSchema = z.object({
  processingRevisionId: identity.nullable(),
  generation: z.number().int().nonnegative(),
}).strict();
export type KnowledgeEvidenceHead = z.infer<typeof KnowledgeEvidenceHeadSchema>;

export const FileOwnerSchema = z.object({ orgId: identity, userId: identity }).strict();
export type FileOwner = z.infer<typeof FileOwnerSchema>;
export const ImmutableFileSchema = z.object({
  blobId: hash,
  sha256: hash,
  sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
}).strict();
export type ImmutableFile = z.infer<typeof ImmutableFileSchema>;
export const KnowledgeSourceSnapshotSchema = KnowledgeDocumentScopeSchema.extend({
  documentVersionId: identity,
  file: ImmutableFileSchema,
  fileName: z.string().min(1).max(240),
  origin: z.enum(['upload', 'text', 'asset']),
  assetId: identity.optional(),
  status: z.literal('archived'),
}).strict();
export type KnowledgeSourceSnapshot = z.infer<typeof KnowledgeSourceSnapshotSchema>;

export const KnowledgeRetrievalVisibilitySchema = z.object({
  activeChunkIds: z.array(identity),
  inactiveChunkIds: z.array(identity),
  suppressedChunkIds: z.array(identity),
}).strict();
export type KnowledgeRetrievalVisibility = z.infer<typeof KnowledgeRetrievalVisibilitySchema>;

export const KnowledgeSearchChunkSchema = z.object({
  id: identity, documentId: identity, title: z.string(), content: z.string(), source: z.string().optional(),
}).strict();
export type KnowledgeSearchChunk = z.infer<typeof KnowledgeSearchChunkSchema>;
export const KnowledgeKeywordHitSchema = KnowledgeSearchChunkSchema.extend({ bm25: z.number().finite() });
export type KnowledgeKeywordHit = z.infer<typeof KnowledgeKeywordHitSchema>;
export const KnowledgeRetrievalSchema = z.object({
  channels: z.array(z.enum(['keyword', 'vector'])),
  ranking: z.literal('rrf'),
  degraded: z.boolean(),
}).strict();
export type KnowledgeRetrieval = z.infer<typeof KnowledgeRetrievalSchema>;

export const KnowledgeParentContextSchema = evidenceChunk.extend({
  matchedChunkIds: z.array(identity).min(1),
}).strict();
export type KnowledgeParentContext = z.infer<typeof KnowledgeParentContextSchema>;
