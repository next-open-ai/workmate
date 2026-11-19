import { z } from 'zod';
import { KnowledgeEvidenceSchema } from './knowledge-evidence.js';

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(200);
export const WikiScopeSchema = z.object({ orgId: id, userId: id, knowledgeBaseId: id }).strict();
export type WikiScope = z.infer<typeof WikiScopeSchema>;
export const WikiSectionSchema = z.object({
  sectionId: id, headingPath: z.array(text).min(1).max(6),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).strict().refine((v) => v.end > v.start, 'Invalid section range');
export const WikiEvidenceRefSchema = z.object({
  refId: id, sectionId: id, sourceKind: z.literal('local-evidence'),
  evidence: KnowledgeEvidenceSchema.refine((e) => e.verification === 'versioned' && e.provider === 'lancedb', 'Local versioned evidence required'),
  excerptHash: digest,
}).strict();
export type WikiEvidenceRef = z.infer<typeof WikiEvidenceRefSchema>;
export const WikiLinkSchema = z.object({ targetPageId: id, sourceSectionId: id, label: text }).strict();
export const WikiContentSchema = z.object({
  title: text, aliases: z.array(text).max(50), summary: z.string().max(2000),
  categoryPath: z.array(text).max(6),
  bodyMarkdown: z.string().min(1).max(256 * 1024).refine((s) => new TextEncoder().encode(s).length <= 256 * 1024, 'Wiki body exceeds 256 KiB'),
  sections: z.array(WikiSectionSchema).min(1).max(500),
  evidenceRefs: z.array(WikiEvidenceRefSchema).min(1).max(2000), links: z.array(WikiLinkSchema).max(500),
}).strict().superRefine((v, ctx) => {
  const sections = new Set<string>();
  let end = 0;
  for (const section of v.sections) {
    if (sections.has(section.sectionId) || section.start < end || section.end > v.bodyMarkdown.length
      || v.bodyMarkdown.slice(end, section.start).trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Sections must cover the body without overlaps or duplicate IDs' });
    }
    // Do not accept positions splitting a UTF-16 surrogate pair.
    for (const pos of [section.start, section.end]) {
      if (pos > 0 && /[\uD800-\uDBFF]/.test(v.bodyMarkdown[pos - 1]) && /[\uDC00-\uDFFF]/.test(v.bodyMarkdown[pos] ?? '')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Section splits a Unicode character' });
      }
    }
    sections.add(section.sectionId); end = section.end;
  }
  if (v.bodyMarkdown.slice(end).trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Untracked body content' });
  const refs = new Set<string>();
  for (const ref of v.evidenceRefs) {
    if (!sections.has(ref.sectionId) || refs.has(ref.refId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid evidence section or duplicate reference' });
    refs.add(ref.refId);
  }
  for (const sectionId of sections) {
    if (!v.evidenceRefs.some((ref) => ref.sectionId === sectionId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Every section requires evidence' });
  }
  const links = new Set<string>();
  for (const link of v.links) {
    const key = JSON.stringify([link.sourceSectionId, link.targetPageId]);
    if (!sections.has(link.sourceSectionId) || links.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid or duplicate link' });
    links.add(key);
  }
});
export type WikiContent = z.infer<typeof WikiContentSchema>;
export const WikiPageSchema = z.object({
  schemaVersion: z.literal(1), pageId: id, knowledgeBaseId: id, slug: text,
  generation: z.number().int().nonnegative(), publishedRevisionId: id.nullable(),
  draftRevisionId: id.nullable(), archivedAt: z.string().datetime().nullable(),
}).strict();
export type WikiPage = z.infer<typeof WikiPageSchema>;
export const WikiRevisionSchema = z.object({
  schemaVersion: z.literal(1), revisionId: id, pageId: id, parentRevisionId: id.nullable(),
  content: WikiContentSchema, contentHash: digest, authorType: z.enum(['human', 'model']),
  createdBy: id, createdAt: z.string().datetime(),
}).strict();
export type WikiRevision = z.infer<typeof WikiRevisionSchema>;
export const WikiMutationSchema = z.object({
  baseGeneration: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(128),
}).strict();
export type WikiMutation = z.infer<typeof WikiMutationSchema>;
export const WikiSaveDraftSchema = WikiMutationSchema.extend({
  pageId: id, slug: text, content: WikiContentSchema, authorType: z.enum(['human', 'model']),
}).strict();
export type WikiSaveDraft = z.infer<typeof WikiSaveDraftSchema>;
export const WikiPublishSchema = WikiMutationSchema.extend({
  pageId: id, draftRevisionId: id, contentHash: digest,
}).strict();
export type WikiPublish = z.infer<typeof WikiPublishSchema>;
export const WikiSearchSchema = z.object({
  query: z.string().max(256), limit: z.number().int().min(1).max(50).default(20),
}).strict();
export const WikiFreshnessSchema = z.enum(['current', 'stale', 'blocked']);
export type WikiFreshness = z.infer<typeof WikiFreshnessSchema>;
export const WikiSearchHitSchema = z.object({
  pageId: id, revisionId: id, title: z.string(), snippet: z.string(),
  matchKinds: z.array(z.enum(['title-exact', 'alias-exact', 'keyword'])),
  rank: z.number().int().positive(), freshness: z.literal('current'), bm25: z.number().nullable(),
}).strict();
export type WikiSearchHit = z.infer<typeof WikiSearchHitSchema>;
export const WikiRecallSchema = z.object({
  pageId: id, revisionId: id, evidenceRefs: z.array(WikiEvidenceRefSchema).max(8), sourcesTruncated: z.boolean(),
  expansion: z.object({ seedPageId: id, depth: z.literal(1) }).strict().optional(),
}).strict();
export type WikiRecall = z.infer<typeof WikiRecallSchema>;
export const WikiPageViewSchema = z.object({
  page: WikiPageSchema, revision: WikiRevisionSchema, freshness: z.enum(['current', 'stale']),
}).strict();
export type WikiPageView = z.infer<typeof WikiPageViewSchema>;
export const WikiRelatedPageSchema = z.object({
  pageId: id, revisionId: id, title: text, seedPageId: id, direction: z.enum(['in', 'out']),
}).strict();
export type WikiRelatedPage = z.infer<typeof WikiRelatedPageSchema>;

// HTTP boundaries never accept scope, storage paths or model author identity.
export const WikiHttpParamsSchema = z.object({ knowledgeBaseId: id, pageId: id.optional() }).strict();
export const WikiListQuerySchema = z.object({
  view: z.enum(['published', 'drafts']).default('published'),
  limit: z.coerce.number().int().min(1).max(50).default(20), afterPageId: id.optional(),
}).strict();
export const WikiReadQuerySchema = z.object({
  view: z.enum(['published', 'drafts']).default('published'), revisionId: id.optional(),
}).strict();
export const WikiHttpSearchSchema = WikiSearchSchema.extend({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const WikiRelatedQuerySchema = z.object({
  direction: z.enum(['in', 'out', 'both']).default('both'), limit: z.coerce.number().int().min(1).max(10).default(10),
}).strict();
export const WikiEditBodySchema = WikiSaveDraftSchema.omit({ pageId: true, authorType: true });
export const WikiPublishBodySchema = WikiPublishSchema.omit({ pageId: true });
export const WikiDirectorySchema = z.object({
  items: z.array(z.object({ page: WikiPageSchema, title: z.string(), summary: z.string(), freshness: z.enum(['current', 'stale']) })),
  nextAfterPageId: id.nullable(),
});
export type WikiDirectory = z.infer<typeof WikiDirectorySchema>;
export const WikiSourcesSchema = z.object({ items: z.array(z.object({
  refId: id, sectionId: id, evidence: KnowledgeEvidenceSchema, text: z.string(), fileName: z.string(),
})) });
export type WikiSources = z.infer<typeof WikiSourcesSchema>;
export const WikiMergeTargetSchema = z.object({ targetPageId: id }).strict();
export const WikiMergeBodySchema = WikiMergeTargetSchema.extend({
  sourceRevisionId: id, targetRevisionId: id, sourceGeneration: z.number().int().nonnegative(),
  baseGeneration: z.number().int().nonnegative(), previewHash: digest,
  idempotencyKey: z.string().min(1).max(128),
}).strict();
export type WikiMergeBody = z.infer<typeof WikiMergeBodySchema>;
export const WikiMergePreviewSchema = WikiMergeBodySchema.omit({ idempotencyKey: true }).extend({
  content: WikiContentSchema, targetBody: z.string(), addedSections: z.number().int().nonnegative(),
  skippedSections: z.number().int().nonnegative(),
}).strict();
export type WikiMergePreview = z.infer<typeof WikiMergePreviewSchema>;
