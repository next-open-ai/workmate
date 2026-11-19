import { WikiGenerationInputSchema, WikiGeneratedPageSchema,
  type WikiGenerationInput, type WikiGeneratedPage } from '@workmate/contracts';

function fits(input: WikiGenerationInput): boolean {
  const chunks = input.batches.flatMap((b) => b.chunks);
  return chunks.length <= 100 && chunks.reduce((n, c) => n + c.content.length, 0) <= 48000
    && JSON.stringify(input.batches).length <= 128000;
}

/** Keep original child blocks and identities intact; never silently slice a source. */
export function planWikiBatches(input: WikiGenerationInput): WikiGenerationInput[] {
  const snapshot = WikiGenerationInputSchema.parse(input);
  const result: WikiGenerationInput[] = [];
  let current: WikiGenerationInput = { batches: [] };
  for (const batch of snapshot.batches) for (const chunk of batch.chunks) {
    const candidate: WikiGenerationInput = { batches: current.batches.map((b) => ({ ...b, chunks: [...b.chunks] })) };
    const existing = candidate.batches.find((b) => b.documentId === batch.documentId);
    if (existing) existing.chunks.push(chunk);
    else candidate.batches.push({ ...batch, parentChunks: undefined, chunks: [chunk] });
    if (fits(candidate)) current = candidate;
    else {
      if (current.batches.length) result.push(current);
      current = { batches: [{ ...batch, parentChunks: undefined, chunks: [chunk] }] };
      if (!fits(current)) throw new Error('LIMIT_EXCEEDED');
    }
  }
  if (current.batches.length) result.push(current);
  if (result.length > 8) throw new Error('LIMIT_EXCEEDED');
  return result;
}

/** Same title means a collection of sections, not a claim that conflicting facts agree. */
export function mergeWikiBatches(batches: WikiGeneratedPage[][]): WikiGeneratedPage[] {
  if (batches.length === 1) return batches[0];
  const groups = new Map<string, { page: WikiGeneratedPage; batch: number }[]>();
  batches.forEach((pages, batch) => pages.forEach((page) => {
    const group = groups.get(page.content.title) ?? [];
    group.push({ page, batch }); groups.set(page.content.title, group);
  }));
  const redirects = new Map<string, string>();
  const output: WikiGeneratedPage[] = [];
  for (const group of groups.values()) {
    const pages = group.map((item) => item.page);
    if (pages.length === 1 || new Set(group.map((item) => item.batch)).size !== group.length) {
      output.push(...pages); continue;
    }
    const combined = structuredClone(pages[0]);
    const content = combined.content;
    content.bodyMarkdown = ''; content.sections = []; content.evidenceRefs = []; content.links = [];
    content.aliases = [...new Set(pages.flatMap((p) => p.content.aliases))];
    content.summary = pages.map((p) => p.content.summary).filter(Boolean).join('\n\n');
    for (const page of pages) {
      for (const section of page.content.sections) {
        if (content.sections.length) content.bodyMarkdown += '\n\n';
        const start = content.bodyMarkdown.length;
        const sectionId = `s-${content.sections.length + 1}`;
        content.bodyMarkdown += page.content.bodyMarkdown.slice(section.start, section.end);
        content.sections.push({ ...section, sectionId, start, end: content.bodyMarkdown.length });
        for (const ref of page.content.evidenceRefs.filter((r) => r.sectionId === section.sectionId)) {
          content.evidenceRefs.push({ ...ref, sectionId, refId: `ref-${content.evidenceRefs.length + 1}` });
        }
        for (const link of page.content.links.filter((l) => l.sourceSectionId === section.sectionId)) {
          content.links.push({ ...link, sourceSectionId: sectionId });
        }
      }
    }
    // Capacity fallback retains every candidate instead of dropping text or citations.
    if (!WikiGeneratedPageSchema.safeParse(combined).success) { output.push(...pages); continue; }
    output.push(combined);
    for (const page of pages) redirects.set(page.pageId, combined.pageId);
  }
  return output.map((page) => WikiGeneratedPageSchema.parse({ ...page, content: { ...page.content,
    links: page.content.links.map((link) => ({ ...link, targetPageId: redirects.get(link.targetPageId) ?? link.targetPageId }))
      .filter((link) => link.targetPageId !== page.pageId),
  } }));
}
