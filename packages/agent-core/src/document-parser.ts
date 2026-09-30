import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { detectBundledPython, pythonArgv } from './python-runtime.js';

const execFileAsync = promisify(execFile);
const BINARY_DOCUMENT = /\.(pdf|docx|pptx|ppsx)$/i;
const PPTX_DOCUMENT = /\.(pptx|ppsx)$/i;

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
    throw new Error(`Unable to parse ${path.extname(input.fileName).toUpperCase()} locally: ${detail}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
