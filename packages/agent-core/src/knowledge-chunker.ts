export const STRUCTURED_CHUNKER = { version: 'structured-utf16-v1', childMax: 1200, parentMax: 3600 } as const;
type Span = { start: number; end: number; headingPath: string[] };
export type StructuredPiece = Span & { content: string; title: string; parentIndex?: number };

export function normalizeKnowledgeText(content: string): string { return content.replace(/\r\n?/g, '\n').trim(); }

/** A bounded Markdown/text heuristic, not an AST; offsets always address unchanged normalized text. */
export function chunkStructuredKnowledge(content: string, title: string) {
  const normalizedText = normalizeKnowledgeText(content);
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  for (const text of normalizedText.split('\n')) {
    lines.push({ text, start: offset, end: Math.min(normalizedText.length, offset + text.length + 1) });
    offset += text.length + 1;
  }
  const atx = (line: string) => /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})/.exec(line);
  const list = (line: string) => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
  const tableRule = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const setext = (line: string) => /^ {0,3}(=+|-+)\s*$/.exec(line);
  const blocks: Array<Span & { section: number }> = [];
  let headings: string[] = [], section = 0;
  for (let i = 0; i < lines.length;) {
    if (!lines[i].text.trim()) { i++; continue; }
    const start = i, heading = atx(lines[i].text), underline = i + 1 < lines.length ? setext(lines[i + 1].text) : null;
    const opening = fence(lines[i].text);
    if (heading || (underline && !opening && !list(lines[i].text))) {
      const level = heading ? heading[1].length : underline![1][0] === '=' ? 1 : 2;
      headings = headings.slice(0, level - 1);
      headings[level - 1] = heading ? heading[2] : lines[i].text.trim();
      section++;
      i += heading ? 1 : 2;
    } else if (opening) {
      i++;
      const close = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`);
      while (i < lines.length) { if (close.test(lines[i++].text)) break; }
    } else if (i + 1 < lines.length && lines[i].text.includes('|') && tableRule(lines[i + 1].text)) {
      i += 2;
      while (i < lines.length && lines[i].text.includes('|') && lines[i].text.trim()) i++;
    } else {
      const inList = list(lines[i].text);
      i++;
      while (i < lines.length && lines[i].text.trim() && !atx(lines[i].text) && !fence(lines[i].text)) {
        if (!inList && list(lines[i].text)) break;
        if (i + 1 < lines.length && (setext(lines[i + 1].text) || tableRule(lines[i + 1].text))) break;
        i++;
      }
    }
    blocks.push({ start: lines[start].start, end: lines[i - 1].end, headingPath: headings.filter(Boolean), section });
  }
  const atoms: Array<Span & { section: number }> = [];
  for (const block of blocks) {
    for (let start = block.start; start < block.end;) {
      let end = Math.min(start + STRUCTURED_CHUNKER.childMax, block.end);
      if (end < block.end) {
        const window = normalizedText.slice(start, end);
        const newline = window.lastIndexOf('\n');
        const boundaries = [...window.matchAll(/[。！？.!?;；]\s*|\s+/gu)];
        const last = boundaries.at(-1);
        const candidate = newline >= window.length / 2 ? newline + 1 : last ? last.index! + last[0].length : 0;
        if (candidate >= window.length / 2) end = start + candidate;
        const code = normalizedText.charCodeAt(end);
        if (code >= 0xdc00 && code <= 0xdfff) end--;
      }
      if (normalizedText.slice(start, end).trim()) atoms.push({ ...block, start, end });
      start = end;
    }
  }
  const children: Array<Span & { section: number }> = [];
  for (const atom of atoms) {
    const previous = children.at(-1);
    if (previous && previous.section === atom.section && atom.end - previous.start <= STRUCTURED_CHUNKER.childMax) previous.end = atom.end;
    else children.push({ ...atom });
  }
  const parents: StructuredPiece[] = [], chunks: StructuredPiece[] = [];
  const piece = (span: Span): StructuredPiece => ({ start: span.start, end: span.end, headingPath: [...span.headingPath],
    content: normalizedText.slice(span.start, span.end), title: [title, ...span.headingPath].filter(Boolean).join(' · ') });
  for (let i = 0; i < children.length;) {
    let j = i + 1;
    while (j < children.length && children[j].section === children[i].section
      && children[j].end - children[i].start <= STRUCTURED_CHUNKER.parentMax) j++;
    const parentIndex = j - i > 1 ? parents.length : undefined;
    if (parentIndex !== undefined) parents.push(piece({ ...children[i], end: children[j - 1].end }));
    for (; i < j; i++) chunks.push({ ...piece(children[i]), ...(parentIndex !== undefined ? { parentIndex } : {}) });
  }
  return { normalizedText, chunks, parents };
}
