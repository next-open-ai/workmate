import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { strFromU8, unzipSync } from 'fflate';
import { extractText } from 'unpdf';
import { detectBundledPython, pythonArgv } from './python-runtime.js';

const execFileAsync = promisify(execFile);
const BINARY_DOCUMENT = /\.(pdf|docx|pptx|ppsx)$/i;
const PPTX_DOCUMENT = /\.(pptx|ppsx)$/i;
const PDF_DOCUMENT = /\.pdf$/i;
const DOCX_DOCUMENT = /\.docx$/i;

export type ParsedDocument = {
  markdown: string;
  parser: 'builtin' | 'markitdown' | 'docling';
  warnings: string[];
};

export function supportsLocalDocumentParsing(fileName: string): boolean {
  return BINARY_DOCUMENT.test(path.basename(fileName));
}

export function pptxEnhancedComponentRoot(): string {
  const dataRoot = process.env.WORKMATE_DATA_DIR?.trim() || path.join(os.homedir(), '.workmate');
  return path.join(dataRoot, 'components', 'pptx-enhanced');
}

export function doclingEnhancedComponentRoot(): string {
  const dataRoot = process.env.WORKMATE_DATA_DIR?.trim() || path.join(os.homedir(), '.workmate');
  return path.join(dataRoot, 'components', 'docling-enhanced');
}

export async function hasPptxEnhancedParser(): Promise<boolean> {
  try {
    await access(path.join(pptxEnhancedComponentRoot(), 'installed.json'));
    return true;
  } catch {
    return false;
  }
}

export async function hasDoclingEnhancedParser(): Promise<boolean> {
  try {
    await access(path.join(doclingEnhancedComponentRoot(), 'installed.json'));
    return true;
  } catch {
    return false;
  }
}

export function documentTextLooksUsable(markdown: string): boolean {
  const compact = markdown.replace(/\s+/g, ' ').trim();
  if (compact.length < 80) return false;
  const replacementCount = (compact.match(/�/g) || []).length;
  return replacementCount / compact.length < 0.02;
}

function runtimeRoot(): string {
  return process.env.WORKMATE_AGENTSCOPE_ROOT?.trim()
    || path.resolve(process.cwd(), 'runtimes', 'agentscope-runtime');
}

function parserPython(): string {
  return process.env.WORKMATE_AGENTSCOPE_PYTHON?.trim()
    || detectBundledPython(runtimeRoot())?.command
    || (process.platform === 'win32' ? 'python' : 'python3');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

async function parseBuiltInDocument(fileName: string, bytes: Buffer): Promise<ParsedDocument> {
  if (PDF_DOCUMENT.test(fileName)) {
    const result = await extractText(new Uint8Array(bytes), { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    const markdown = pages
      .map((text, index) => String(text || '').trim() ? `## Page ${index + 1}\n\n${String(text).trim()}` : '')
      .filter(Boolean)
      .join('\n\n');
    if (!markdown) throw new Error('PDF contains no extractable text. Scanned PDFs require an OCR-capable enhanced parser.');
    return { markdown, parser: 'builtin', warnings: [] };
  }
  if (DOCX_DOCUMENT.test(fileName)) {
    const archive = unzipSync(new Uint8Array(bytes));
    const document = archive['word/document.xml'];
    if (!document) throw new Error('DOCX is missing word/document.xml.');
    const xml = strFromU8(document);
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)]
      .map((match) => [...match[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
        .map((text) => decodeXmlText(text[1]))
        .join('')
        .trim())
      .filter(Boolean);
    const markdown = paragraphs.join('\n\n');
    if (!markdown) throw new Error('DOCX contains no extractable paragraph text.');
    return { markdown, parser: 'builtin', warnings: [] };
  }
  throw new Error('Built-in parsing supports PDF and DOCX only.');
}

/** Parse an uploaded PDF/DOCX, or an optionally enhanced PPTX/PPSX, through the bundled runtime. */
export async function parseLocalDocument(input: {
  fileName: string;
  bytes: Buffer;
  timeoutMs?: number;
}): Promise<ParsedDocument> {
  if (!supportsLocalDocumentParsing(input.fileName)) {
    throw new Error('Local document parsing currently supports PDF, DOCX, PPTX and PPSX files.');
  }
  if (PPTX_DOCUMENT.test(input.fileName) && !(await hasPptxEnhancedParser())) {
    throw new Error('PPTX enhanced parsing component is not installed.');
  }
  let builtin: ParsedDocument | null = null;
  let builtinError = '';
  if (PDF_DOCUMENT.test(input.fileName) || DOCX_DOCUMENT.test(input.fileName)) {
    try {
      builtin = await parseBuiltInDocument(input.fileName, input.bytes);
      if (documentTextLooksUsable(builtin.markdown) || !(await hasDoclingEnhancedParser())) return builtin;
    } catch (cause) {
      builtinError = cause instanceof Error ? cause.message : String(cause);
      if (!(await hasDoclingEnhancedParser())) {
        throw new Error(`Unable to parse ${path.extname(input.fileName).toUpperCase()} locally: ${builtinError}`);
      }
    }
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'workmate-document-'));
  const safeName = path.basename(input.fileName).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'document';
  const sourcePath = path.join(tempRoot, safeName);
  try {
    await writeFile(sourcePath, input.bytes, { mode: 0o600 });
    const root = runtimeRoot();
    const invocation = pythonArgv(parserPython(), [
      '-m', 'workmate_agentscope_runtime.document_parser', sourcePath,
    ]);
    const pythonPath = [
      path.join(pptxEnhancedComponentRoot(), 'python-packages'),
      path.join(doclingEnhancedComponentRoot(), 'python-packages'),
      path.join(root, 'src'),
      process.env.PYTHONPATH,
    ].filter(Boolean).join(path.delimiter);
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      cwd: tempRoot,
      timeout: input.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONPATH: pythonPath, PYTHONIOENCODING: 'utf-8' },
    });
    const parsed = JSON.parse(stdout) as Partial<ParsedDocument>;
    if (!parsed.markdown?.trim() || !['builtin', 'markitdown', 'docling'].includes(String(parsed.parser))) {
      throw new Error('Document parser returned no readable content.');
    }
    return {
      markdown: parsed.markdown.trim(),
      parser: parsed.parser as ParsedDocument['parser'],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (builtin) return { ...builtin, warnings: [...builtin.warnings, `Enhanced parser unavailable: ${detail}`] };
    throw new Error(`Unable to parse ${path.extname(input.fileName).toUpperCase()} locally: ${detail}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
