import { createHash } from 'node:crypto';
import { WikiContentSchema, type WikiContent, type WikiPageView } from '@workmate/contracts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Conservative append: equal text with different evidence remains distinct. */
export function appendWikiSections(source: WikiPageView, target: WikiPageView) {
  const content = structuredClone(target.revision.content);
  const signature = (value: WikiContent, section: WikiContent['sections'][number]) => JSON.stringify({
    heading: section.headingPath, body: value.bodyMarkdown.slice(section.start, section.end),
    refs: value.evidenceRefs.filter((r) => r.sectionId === section.sectionId)
      .map((r) => JSON.stringify([r.evidence, r.excerptHash])).sort(),
    links: value.links.filter((l) => l.sourceSectionId === section.sectionId && l.targetPageId !== target.page.pageId && l.targetPageId !== source.page.pageId)
      .map((l) => JSON.stringify([l.targetPageId, l.label])).sort(),
  });
  const known = new Set(content.sections.map((section) => signature(content, section)));
  let addedSections = 0, skippedSections = 0;
  for (const section of source.revision.content.sections) {
    const key = signature(source.revision.content, section);
    if (known.has(key)) { skippedSections++; continue; }
    known.add(key);
    const prefix = digest(JSON.stringify([source.page.pageId, source.revision.revisionId, section.sectionId]));
    const sectionId = `merged-${prefix}`;
    const start = content.bodyMarkdown.length + 2;
    content.bodyMarkdown += '\n\n' + source.revision.content.bodyMarkdown.slice(section.start, section.end);
    content.sections.push({ ...section, sectionId, start, end: content.bodyMarkdown.length });
    for (const ref of source.revision.content.evidenceRefs.filter((r) => r.sectionId === section.sectionId)) {
      content.evidenceRefs.push({ ...ref, sectionId, refId: `merged-${digest(prefix + ':' + ref.refId)}` });
    }
    for (const link of source.revision.content.links.filter((l) => l.sourceSectionId === section.sectionId)) {
      if (link.targetPageId !== target.page.pageId && link.targetPageId !== source.page.pageId) {
        content.links.push({ ...link, sourceSectionId: sectionId });
      }
    }
    addedSections++;
  }
  return { content: WikiContentSchema.parse(content), addedSections, skippedSections };
}
