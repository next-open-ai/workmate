/**
 * 用户手册：以 docs/user-manual.md 为单一事实来源，构建应用内可渲染的 HTML。
 * 渲染器只支持手册中用到的 Markdown 子集：标题 / 段落 / 列表 / 代码块 / 引用 / 表格 / 链接 / 强调。
 * 安全策略：先按结构切块，再对每块的文本内容做 HTML 转义后执行白名单变换，杜绝注入。
 */
import manualSource from '../../../../docs/user-manual.md?raw';
import imgOverview from '../../../../docs/images/user-manual-1-overview.png?url';
import imgModelConfig from '../../../../docs/images/user-manual-2-model-config.png?url';
import imgChat from '../../../../docs/images/user-manual-3-chat.png?url';
import imgKnowledge from '../../../../docs/images/user-manual-4-knowledge.png?url';
import imgEnvCheck from '../../../../docs/images/user-manual-5-env-check.png?url';
import imgFaq from '../../../../docs/images/user-manual-6-faq.png?url';

/** 手册内相对路径图片 → 打包资源地址的映射（仅映射已在 md 中引用的截图）。 */
const IMAGE_URLS: Record<string, string> = {
  'images/user-manual-1-overview.png': imgOverview,
  'images/user-manual-2-model-config.png': imgModelConfig,
  'images/user-manual-3-chat.png': imgChat,
  'images/user-manual-4-knowledge.png': imgKnowledge,
  'images/user-manual-5-env-check.png': imgEnvCheck,
  'images/user-manual-6-faq.png': imgFaq,
};

export interface ManualHeading {
  level: number;
  text: string;
  id: string;
}

type ManualBlock = { kind: 'code' | 'heading' | 'hr' | 'blockquote' | 'table' | 'list' | 'p'; data: string[] };

interface ListItemNode {
  ordered: boolean;
  text: string;
  depth: number;
  children: ListItemNode[];
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内渲染：输入必须是已转义文本，输出受控 HTML。 */
function renderInline(input: string): string {
  return input
    .replace(/`([^`]+)`/g, (_m, code: string) => `<code class="manual-code">${code}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => `<img class="manual-img" src="${src}" alt="${alt}" loading="lazy" />`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
      const href = url.startsWith('#') ? `#${encodeURIComponent(url.slice(1))}` : url;
      return `<a class="manual-a" href="${href}">${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, (_m, text: string) => `<strong>${text}</strong>`);
}

/** 提取标题纯文本与锚点 id（支持 pandoc 风格 `{#anchor}`）。 */
function headingParts(line: string): { level: number; text: string; id: string } | null {
  const m = line.match(/^(#{1,6})\s+(.+)$/);
  if (!m) return null;
  const raw = m[2].trim();
  const anchor = raw.match(/\{#?([\w-]+)\}\s*$/);
  const text = anchor ? raw.slice(0, anchor.index).trim() : raw;
  return {
    level: m[1].length,
    text: text.replace(/[*`[\]]/g, '').trim(),
    id: anchor ? anchor[1] : text.replace(/[*`[\]]/g, '').trim(),
  };
}

function splitBlocks(): ManualBlock[] {
  const lines = manualSource.split('\n');
  const blocks: ManualBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [lang];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合围栏
      blocks.push({ kind: 'code', data: buf });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      blocks.push({ kind: 'heading', data: [line] });
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        buf.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'blockquote', data: buf });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ kind: 'hr', data: [] });
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        buf.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ kind: 'table', data: buf });
      continue;
    }
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const baseIndent = listMatch[1].length;
      const buf: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (m && m[1].length >= baseIndent) {
          buf.push(lines[i]);
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ kind: 'list', data: buf });
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^```/.test(lines[i].trim())
      && !/^(#{1,6})\s/.test(lines[i])
      && !lines[i].trimStart().startsWith('>')
      && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trim())
      && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'p', data: buf });
  }
  return blocks;
}

function renderBlock(block: ManualBlock): string {
  switch (block.kind) {
    case 'code': {
      const [, ...body] = block.data;
      return `<pre class="manual-pre"><code>${escapeHtml(body.join('\n'))}</code></pre>`;
    }
    case 'heading': {
      const heading = headingParts(block.data[0]);
      if (!heading) return '';
      const display = block.data[0].replace(/^#{1,6}\s+/, '').replace(/\{#?[\w-]+\}\s*$/, '').trim();
      return `<h${heading.level} class="manual-h${heading.level}" id="${heading.id}">${renderInline(escapeHtml(display))}</h${heading.level}>`;
    }
    case 'hr':
      return '<hr class="manual-hr" />';
    case 'blockquote': {
      const body = block.data.map((l) => `<p>${renderInline(escapeHtml(l))}</p>`).join('');
      return `<blockquote class="manual-blockquote">${body}</blockquote>`;
    }
    case 'table': {
      const rows = block.data.map((row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
      const header = rows[0] ?? [];
      const body = rows.slice(2);
      return [
        '<div class="manual-table-wrap"><table class="manual-table">',
        '<thead><tr>',
        header.map((cell) => `<th>${renderInline(escapeHtml(cell))}</th>`).join(''),
        '</tr></thead><tbody>',
        body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(escapeHtml(cell))}</td>`).join('')}</tr>`).join(''),
        '</tbody></table></div>',
      ].join('');
    }
    case 'list': {
      const tree = buildListTree(block.data, 0);
      return renderListTree(tree.nodes);
    }
    default: {
      return `<p class="manual-p">${renderInline(escapeHtml(block.data.join(' ')))}</p>`;
    }
  }
}

/** 把连续列表行构造成缩进树（每 2 空格一层），支持嵌套子列表。 */
function buildListTree(lines: string[], start: number): { nodes: ListItemNode[]; next: number } {
  const nodes: ListItemNode[] = [];
  const stack: ListItemNode[] = [];
  let i = start;
  let baseDepth = -1;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (!m) break;
    const depth = Math.floor(m[1].length / 2);
    if (baseDepth === -1) baseDepth = depth;
    if (depth < baseDepth) break;
    const node: ListItemNode = { ordered: /^\d+\.$/.test(m[2]), text: m[3], depth, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else nodes.push(node);
    stack.push(node);
    i += 1;
  }
  return { nodes, next: i };
}

function renderListTree(nodes: ListItemNode[]): string {
  let out = '';
  let i = 0;
  while (i < nodes.length) {
    const ordered = nodes[i].ordered;
    const baseDepth = nodes[i].depth;
    const items: string[] = [];
    while (i < nodes.length && nodes[i].ordered === ordered && nodes[i].depth === baseDepth) {
      const node = nodes[i];
      const children = node.children.length ? renderListTree(node.children) : '';
      items.push(`<li>${renderInline(escapeHtml(node.text))}${children}</li>`);
      i += 1;
    }
    const tag = ordered ? 'ol' : 'ul';
    out += `<${tag} class="manual-${tag}">${items.join('')}</${tag}>`;
  }
  return out;
}

export function renderManualHtml(): string {
  const html = splitBlocks().map(renderBlock).join('');
  return html.replace(/src="(images\/[^"]+)"/g, (_m, src: string) => (IMAGE_URLS[src] ? `src="${IMAGE_URLS[src]}"` : _m));
}

export function manualHeadings(): ManualHeading[] {
  const list: ManualHeading[] = [];
  for (const line of manualSource.split('\n')) {
    const parts = headingParts(line);
    if (parts) list.push({ level: parts.level, text: parts.text, id: parts.id });
  }
  return list;
}
