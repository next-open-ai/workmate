/** Shared project deliverable filtering for project workspace & asset library trees. */

export type ProjectFileEntry = { relative: string; type: 'directory' | 'file' };

/** Agent process / scaffolding scripts — not shown as deliverables. */
export function isAgentProcessFile(relative: string) {
  const name = relative.split('/').pop() ?? relative;
  if (/\.(py|sh)$/i.test(name)) return true;
  if (/^(gen_|patch_|scaffold_|tmp_)/i.test(name) && /\.(js|mjs|cjs|ts)$/i.test(name) && !relative.includes('/')) return true;
  return false;
}

export function deliverableEntries(entries: ProjectFileEntry[]): ProjectFileEntry[] {
  const keptFiles = entries.filter((entry) => entry.type === 'file' && !isAgentProcessFile(entry.relative));
  const keptPaths = keptFiles.map((entry) => entry.relative);
  return entries.filter((entry) => {
    if (entry.type === 'file') return !isAgentProcessFile(entry.relative);
    if (entry.type !== 'directory') return false;
    return keptPaths.some((path) => path === entry.relative || path.startsWith(`${entry.relative}/`));
  });
}

export function fileExt(name: string) {
  return name.split('.').pop()?.toLowerCase() || '';
}

export type PreviewKind = 'html' | 'markdown' | 'image' | 'pdf' | 'code' | 'text' | 'unsupported';

export function previewKindForName(name: string): PreviewKind {
  const ext = fileExt(name);
  if (/^html?$/.test(ext)) return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return 'image';
  if (/^(css|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|xml|txt|csv)$/i.test(ext)) return 'code';
  return 'unsupported';
}

/** Minimal Markdown → HTML for asset preview (no external dependency). */
export function markdownToHtml(source: string) {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escape(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineMd(escape(raw.replace(/^\s*[-*]\s+/, '')))}</li>`);
      continue;
    }
    closeList();
    if (/^###\s+/.test(raw)) html.push(`<h3>${inlineMd(escape(raw.slice(4)))}</h3>`);
    else if (/^##\s+/.test(raw)) html.push(`<h2>${inlineMd(escape(raw.slice(3)))}</h2>`);
    else if (/^#\s+/.test(raw)) html.push(`<h1>${inlineMd(escape(raw.slice(2)))}</h1>`);
    else if (!raw.trim()) html.push('<br/>');
    else html.push(`<p>${inlineMd(escape(raw))}</p>`);
  }
  closeList();
  if (inCode) html.push(`<pre><code>${escape(codeBuf.join('\n'))}</code></pre>`);
  return html.join('\n');
}

function inlineMd(value: string) {
  return value
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}
