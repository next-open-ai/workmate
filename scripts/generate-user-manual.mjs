import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'docs/guides/user-manual.md');
const outputPath = path.join(repoRoot, 'apps/renderer/src/generated/user-manual.json');
// Git may check this file out with CRLF on Windows. Normalize before parsing:
// several block regexes intentionally anchor at end-of-line and a retained
// carriage return can otherwise leave the parser on the same line forever.
const manualSource = (await readFile(sourcePath, 'utf8')).replace(/\r\n?/g, '\n');

function escapeHtml(input) {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(input) {
  return input
    .replace(/`([^`]+)`/g, (_m, code) => `<code class="manual-code">${code}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img class="manual-img" src="${src}" alt="${alt}" width="1600" height="1000" loading="lazy" decoding="async" />`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
      const href = url.startsWith('#') ? `#${encodeURIComponent(url.slice(1))}` : url;
      return `<a class="manual-a" href="${href}">${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, (_m, text) => `<strong>${text}</strong>`);
}

function headingParts(line) {
  const match = line.match(/^(#{1,6})\s+(.+)$/);
  if (!match) return null;
  const raw = match[2].trim();
  const anchor = raw.match(/\{#?([\w-]+)\}\s*$/);
  const text = anchor ? raw.slice(0, anchor.index).trim() : raw;
  return {
    level: match[1].length,
    text: text.replace(/[*`[\]]/g, '').trim(),
    id: anchor ? anchor[1] : text.replace(/[*`[\]]/g, '').trim(),
  };
}

function splitBlocks() {
  const lines = manualSource.split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const iterationStart = index;
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (/^```/.test(line.trim())) {
      const buffer = [line.trim().slice(3).trim()];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) buffer.push(lines[index++]);
      index += 1;
      blocks.push({ kind: 'code', data: buffer });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) { blocks.push({ kind: 'heading', data: [line] }); index += 1; continue; }
    if (line.trimStart().startsWith('>')) {
      const buffer = [];
      while (index < lines.length && lines[index].trimStart().startsWith('>')) buffer.push(lines[index++].trimStart().replace(/^>\s?/, ''));
      blocks.push({ kind: 'blockquote', data: buffer });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) { blocks.push({ kind: 'hr', data: [] }); index += 1; continue; }
    if (line.trimStart().startsWith('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[index + 1])) {
      const buffer = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) buffer.push(lines[index++].trim());
      blocks.push({ kind: 'table', data: buffer });
      continue;
    }
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const baseIndent = listMatch[1].length;
      const buffer = [];
      while (index < lines.length) {
        const match = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!match || match[1].length < baseIndent) break;
        buffer.push(lines[index++]);
      }
      blocks.push({ kind: 'list', data: buffer });
      continue;
    }
    const buffer = [];
    while (index < lines.length && lines[index].trim() && !/^```/.test(lines[index].trim()) && !/^(#{1,6})\s/.test(lines[index]) && !lines[index].trimStart().startsWith('>') && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index].trim()) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[index])) buffer.push(lines[index++]);
    blocks.push({ kind: 'p', data: buffer });
    if (index === iterationStart) throw new Error(`User manual parser stalled at line ${index + 1}: ${JSON.stringify(line)}`);
  }
  return blocks;
}

function buildListTree(lines) {
  const nodes = [];
  const stack = [];
  for (const line of lines) {
    const match = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (!match) continue;
    const depth = Math.floor(match[1].length / 2);
    const node = { ordered: /^\d+\.$/.test(match[2]), text: match[3], depth, children: [] };
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    if (stack.length) stack.at(-1).children.push(node); else nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

function renderListTree(nodes) {
  let output = '';
  let index = 0;
  while (index < nodes.length) {
    const ordered = nodes[index].ordered;
    const depth = nodes[index].depth;
    const items = [];
    while (index < nodes.length && nodes[index].ordered === ordered && nodes[index].depth === depth) {
      const node = nodes[index++];
      items.push(`<li>${renderInline(escapeHtml(node.text))}${node.children.length ? renderListTree(node.children) : ''}</li>`);
    }
    const tag = ordered ? 'ol' : 'ul';
    output += `<${tag} class="manual-${tag}">${items.join('')}</${tag}>`;
  }
  return output;
}

function renderBlock(block) {
  if (block.kind === 'code') return `<pre class="manual-pre"><code>${escapeHtml(block.data.slice(1).join('\n'))}</code></pre>`;
  if (block.kind === 'heading') {
    const heading = headingParts(block.data[0]);
    if (!heading) return '';
    const display = block.data[0].replace(/^#{1,6}\s+/, '').replace(/\{#?[\w-]+\}\s*$/, '').trim();
    return `<h${heading.level} class="manual-h${heading.level}" id="${heading.id}">${renderInline(escapeHtml(display))}</h${heading.level}>`;
  }
  if (block.kind === 'hr') return '<hr class="manual-hr" />';
  if (block.kind === 'blockquote') return `<blockquote class="manual-blockquote">${block.data.map((line) => `<p>${renderInline(escapeHtml(line))}</p>`).join('')}</blockquote>`;
  if (block.kind === 'table') {
    const rows = block.data.map((row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
    return `<div class="manual-table-wrap"><table class="manual-table"><thead><tr>${(rows[0] || []).map((cell) => `<th>${renderInline(escapeHtml(cell))}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map((row) => `<tr>${row.map((cell) => `<td>${renderInline(escapeHtml(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  if (block.kind === 'list') return renderListTree(buildListTree(block.data));
  return `<p class="manual-p">${renderInline(escapeHtml(block.data.join(' ')))}</p>`;
}

const headings = manualSource.split('\n').map(headingParts).filter(Boolean);
const groups = [];
let current = { id: 'manual-overview', title: '手册说明', blocks: [], headingIds: [] };
for (const block of splitBlocks()) {
  if (block.kind === 'heading') {
    const heading = headingParts(block.data[0]);
    if (heading?.level === 2) {
      if (current.blocks.length) groups.push(current);
      current = { id: heading.id, title: heading.text, blocks: [], headingIds: [] };
    }
    if (heading) current.headingIds.push(heading.id);
  }
  current.blocks.push(block);
}
if (current.blocks.length) groups.push(current);

const payload = {
  source: 'docs/guides/user-manual.md',
  headings,
  sections: groups.map((group) => ({ id: group.id, title: group.title, headingIds: group.headingIds, html: group.blocks.map(renderBlock).join('') })),
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`generated ${path.relative(repoRoot, outputPath)}: ${payload.sections.length} sections, ${payload.headings.length} headings`);
