import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AgentSkillRuntime } from '@workmate/contracts';
import { Type, StringEnum, defineAgentTool, type AgentTool } from './pi-tools.js';

const MAX_FILE_BYTES = 96_000;
/** Soft cap per tool-call body so models do not emit fragile multi‑10KB JSON strings. */
const MAX_WRITE_CHUNK = 6_000;
const MAX_WRITE_CONTENT = 24_000;
const MAX_WRITE_CHUNKS = 24;
const MAX_NETWORK_BYTES = 256_000;
const MAX_SCRIPT_OUTPUT = 32_000;
const SCRIPT_TIMEOUT_MS = 30_000;
const textFilePattern = /\.(md|txt|json|ya?ml|csv|html?|css|ts|js|mjs|cjs|py|sh)$/i;
const executablePattern = /^scripts\/.+\.(sh|js|mjs|cjs|py)$/i;

/** Canonical directory for finished business deliverables inside a run workspace. */
export const WORKSPACE_OUTPUT_DIR = 'output';

/** Process / cache directories — never auto-archived or promoted. */
const PROCESS_ONLY_DIRS = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);

/** Bytecode / native objects — never deliverables, even under output/. */
const NEVER_DELIVERABLE_EXT = new Set([
  'pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map',
]);

/**
 * Document-like files that LLMs often write at workspace root by mistake.
 * After a script run we stage these into output/ so they still reach the asset library,
 * without treating generator sources (.py/.sh/…) as deliverables.
 */
const STAGEABLE_ROOT_DOCUMENT_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
  'html', 'htm', 'css', 'md', 'markdown', 'txt', 'csv', 'json',
  'zip', 'gz', 'tgz', 'mp3', 'mp4', 'webm', 'wav',
]);

function normalizeWorkspacePath(relative: string) {
  return relative.replace(/\\/g, '/').replace(/^\/+/, '');
}

function pathParts(relative: string) {
  return normalizeWorkspacePath(relative).split('/').filter(Boolean);
}

function safeRelative(value: string) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Path must be a safe relative path.');
  }
  return normalized;
}

function isNeverDeliverableFile(base: string) {
  if (!base || (base.startsWith('.') && base !== '.gitkeep')) return true;
  const ext = path.extname(base).slice(1).toLowerCase();
  return !ext || NEVER_DELIVERABLE_EXT.has(ext);
}

/** True when the path is under the canonical business-output directory. */
export function isUnderWorkspaceOutput(relative: string) {
  const parts = pathParts(relative);
  return parts[0] === WORKSPACE_OUTPUT_DIR && parts.length >= 2;
}

/**
 * True when a run-workspace relative path is a finished business deliverable.
 * Policy (intent, not extension guesswork):
 * - Must live under `output/` (or be placed there via register_deliverable).
 * - Process trees (scripts/tools/tmp/…) are never deliverables.
 * - Bytecode/cache files are never deliverables even under output/.
 * - Under output/, source files such as .py/.js ARE allowed (they can be the product).
 */
export function isBusinessDeliverablePath(relative: string) {
  const normalized = normalizeWorkspacePath(relative);
  const parts = pathParts(normalized);
  if (!normalized || parts.some((part) => part === '.' || part === '..')) return false;
  if (parts.some((part) => PROCESS_ONLY_DIRS.has(part))) return false;
  if (!isUnderWorkspaceOutput(normalized)) return false;
  return !isNeverDeliverableFile(parts[parts.length - 1] || '');
}

/** @deprecated Use isBusinessDeliverablePath — kept for call-site compatibility. */
export function isProjectDeliverablePath(relative: string) {
  return isBusinessDeliverablePath(relative);
}

function toOutputPath(relative: string, destName?: string) {
  const normalized = safeRelative(relative);
  if (isUnderWorkspaceOutput(normalized) && !destName) return normalized;
  const base = destName ? path.basename(safeRelative(destName)) : path.basename(normalized);
  if (!base || base === '.' || base === '..') throw new Error('Invalid deliverable file name.');
  return `${WORKSPACE_OUTPUT_DIR}/${base}`;
}

/**
 * Copy every deliverable under output/ from an isolated run workspace into the
 * shared project workspace. End-of-run safety net; prefer explicit publish.
 */
export async function promoteWorkspaceDeliverablesToProject(
  workspaceRoot: string,
  projectRoot: string,
): Promise<Array<{ path: string; projectPath: string }>> {
  const published: Array<{ path: string; projectPath: string }> = [];
  const root = path.resolve(workspaceRoot);
  const destRoot = path.resolve(projectRoot);
  const outputRoot = path.join(root, WORKSPACE_OUTPUT_DIR);

  async function walk(folder: string, depth = 0) {
    if (depth > 8 || published.length >= 200) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (!isBusinessDeliverablePath(relative)) continue;
      // Promote as output-relative path without forcing the "output/" prefix into the project tree.
      const projectPath = relative.startsWith(`${WORKSPACE_OUTPUT_DIR}/`)
        ? relative.slice(WORKSPACE_OUTPUT_DIR.length + 1)
        : relative;
      if (!projectPath || projectPath.split('/').some((part) => !part || part === '.' || part === '..')) continue;
      const dest = path.join(destRoot, ...projectPath.split('/'));
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await copyFile(target, dest);
      published.push({ path: relative, projectPath });
      if (published.length >= 200) return;
    }
  }

  try {
    await walk(outputRoot);
  } catch {
    /* best-effort */
  }
  return published;
}

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value;
}

async function pathInside(root: string, relative: string) {
  const resolvedRoot = await realpath(root);
  const candidate = path.resolve(resolvedRoot, safeRelative(relative));
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Path escapes its permitted root.');
  return candidate;
}

async function ensureWorkspaceScaffold(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, WORKSPACE_OUTPUT_DIR), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'scripts'), { recursive: true, mode: 0o700 });
}

async function listSkillFiles(root: string, folder = root, depth = 0, entries: string[] = []): Promise<string[]> {
  if (depth > 5 || entries.length >= 80) return entries;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const target = path.join(folder, entry.name);
    const relative = path.relative(root, target).split(path.sep).join('/');
    if (entry.isDirectory()) await listSkillFiles(root, target, depth + 1, entries);
    else if (entry.isFile() && textFilePattern.test(entry.name)) entries.push(relative);
    if (entries.length >= 80) break;
  }
  return entries;
}

/**
 * List finished deliverables under output/ only.
 */
async function listOutputDeliverables(root: string, folder = path.join(root, WORKSPACE_OUTPUT_DIR), depth = 0, entries: string[] = []): Promise<string[]> {
  if (depth > 5 || entries.length >= 40) return entries;
  let listing: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    listing = await readdir(folder, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of listing) {
    if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      await listOutputDeliverables(root, target, depth + 1, entries);
    } else if (entry.isFile()) {
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (isBusinessDeliverablePath(relative)) entries.push(relative);
    }
    if (entries.length >= 40) break;
  }
  return entries;
}

function isStageableRootDocument(relative: string) {
  const parts = pathParts(relative);
  if (parts.length !== 1) return false;
  if (isNeverDeliverableFile(parts[0])) return false;
  const ext = path.extname(parts[0]).slice(1).toLowerCase();
  return STAGEABLE_ROOT_DOCUMENT_EXT.has(ext);
}

/**
 * After a generator script runs:
 * 1) collect new/changed files under output/
 * 2) stage accidental root documents (pdf/html/…) into output/ (generators stay put)
 */
async function collectScriptDeliverables(root: string, before: Set<string>, startedAtMs: number): Promise<string[]> {
  const staged = new Set<string>();

  // Walk whole tree lightly for root-document staging + output discovery.
  async function walk(folder: string, depth = 0) {
    if (depth > 5) return;
    let listing: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      listing = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of listing) {
      if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, target).split(path.sep).join('/');
      let info: { mtimeMs: number };
      try {
        info = await stat(target);
      } catch {
        continue;
      }
      const isNewOrTouched = !before.has(relative) || info.mtimeMs >= startedAtMs - 1_000;
      if (!isNewOrTouched) continue;

      if (isBusinessDeliverablePath(relative)) {
        staged.add(relative);
        continue;
      }
      if (!isStageableRootDocument(relative)) continue;
      const destRel = toOutputPath(relative);
      const destAbs = path.join(root, ...destRel.split('/'));
      await mkdir(path.dirname(destAbs), { recursive: true, mode: 0o700 });
      await copyFile(target, destAbs);
      staged.add(destRel);
    }
  }

  await walk(root);
  // Also pick up anything already under output/ that may have been missed if walk skipped.
  for (const item of await listOutputDeliverables(root).catch(() => [])) {
    if (!before.has(item)) staged.add(item);
  }
  return [...staged];
}

/**
 * End-of-run safety net for engines without register_deliverable (e.g. dsh):
 * stage root PDF/HTML/… into output/ and return relative deliverable paths for
 * artifact.created events. Call once before run.completed.
 */
export async function harvestWorkspaceDeliverables(
  workspaceRoot: string,
  options?: { startedAtMs?: number; before?: Iterable<string> },
): Promise<string[]> {
  const root = path.resolve(workspaceRoot);
  const startedAtMs = options?.startedAtMs ?? Date.now();
  const before = new Set(options?.before ?? []);
  if (!before.size) {
    for (const item of await listOutputDeliverables(root).catch(() => [])) before.add(item);
  }
  return collectScriptDeliverables(root, before, startedAtMs);
}

function approvedSkillRoot(skill: AgentSkillRuntime) {
  const configuredRoot = process.env.WORKMATE_SKILLS_DIR;
  if (!configuredRoot || !skill.rootPath) return null;
  const root = path.resolve(configuredRoot);
  const candidate = path.resolve(skill.rootPath);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

function approval(skillId: string, capability: 'workspace-write' | 'script-execution' | 'network-access', error: string) {
  return { ok: false, error, approval: { skillId, capability } };
}

function runProcess(command: string, args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? SCRIPT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout = truncate(stdout + String(chunk), MAX_SCRIPT_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = truncate(stderr + String(chunk), MAX_SCRIPT_OUTPUT); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }); });
  });
}

function pythonImportProbeModuleName(dependency: string) {
  return dependency
    .replace(/==.*$/, '')
    .trim()
    .replace(/-/g, '_');
}

/**
 * The local execution boundary for Agent Skills. Skill packages are immutable
 * at runtime; generated artifacts belong in a separate, run-scoped workspace.
 * When `projectRoot` is set (project tasks), deliverables may be promoted into
 * the shared project directory via `publish_to_project`.
 *
 * Tools are native pi AgentTool + TypeBox (no Vercel AI SDK tool()).
 */
export function createSkillExecutionTools(input: {
  skills: AgentSkillRuntime[];
  runId: string;
  projectRoot?: string;
  workspaceAccess?: 'read' | 'write' | 'full';
}): AgentTool[] {
  const packages = new Map(input.skills.map((skill) => [skill.id, skill]));
  const workspaceRoot = path.join(process.env.WORKMATE_WORKSPACES_DIR || path.join(process.cwd(), '.workmate-workspaces'), input.runId);
  const projectRoot = input.projectRoot?.trim() ? path.resolve(input.projectRoot.trim()) : '';
  const workspaceAccess = input.workspaceAccess ?? 'write';
  const canWriteWorkspace = workspaceAccess === 'write' || workspaceAccess === 'full';
  // "write" is the normal task tier. It must retain the controlled local
  // execution needed to produce artifacts (for example, a PDF renderer).
  // "full" is reserved for future elevated capabilities such as networked
  // execution; it is not required merely to run a workspace script.
  const canRunWorkspaceScript = workspaceAccess === 'write' || workspaceAccess === 'full';
  const writeDenied = () => ({ ok: false, error: 'Workspace write is not permitted for this run.' });
  const scriptDenied = () => ({ ok: false, error: 'Workspace script execution is not permitted for this run.' });
  // Preloaded instructions are for first-turn reasoning, not implicit execution
  // of every skill. Workspace operations are platform tools, never a Skill.
  const loaded = new Set(
    input.skills
      .filter((skill) => skill.mode === 'default' && skill.instructions)
      .map((skill) => skill.id),
  );
  const getSkill = (skillId: string) => {
    const skill = packages.get(skillId);
    if (!skill) throw new Error('Skill is not authorized for this run.');
    return skill;
  };
  const ensureLoaded = (skillId: string) => {
    if (!loaded.has(skillId)) throw new Error('Load the Skill before accessing its files or execution capabilities.');
  };
  const workspacePath = async (relative: string) => {
    await ensureWorkspaceScaffold(workspaceRoot);
    return pathInside(workspaceRoot, relative);
  };
  const projectPath = async (relative: string) => {
    if (!projectRoot) throw new Error('Current run is not bound to a project workspace.');
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    return pathInside(projectRoot, relative);
  };
  const runWorkspaceScript = async (relative: string, args: string[]) => {
    if (!canRunWorkspaceScript) return scriptDenied();
    const normalized = safeRelative(relative);
    if (!/\.(sh|js|mjs|cjs|py)$/i.test(normalized)) return { ok: false, error: 'Only .sh, .js, .mjs, .cjs, or .py workspace scripts may run.' };
    let script: string;
    try {
      script = await workspacePath(normalized);
      if (!(await stat(script)).isFile()) throw new Error('Not a file');
    } catch (_) { return { ok: false, error: `Workspace script is unavailable: ${normalized}. Write it first with write_workspace_file.` }; }
    const extension = path.extname(script).toLowerCase();
    const command = extension === '.py' ? 'python3' : extension === '.sh' ? 'bash' : process.execPath;
    const dependencyRoot = path.join(workspaceRoot, '.python-packages');
    await ensureWorkspaceScaffold(workspaceRoot);
    const before = new Set(await listOutputDeliverables(workspaceRoot).catch(() => []));
    const startedAtMs = Date.now();
    const result = await runProcess(command, [script, ...args], workspaceRoot, { env: { ...process.env, PYTHONPATH: dependencyRoot } });
    const artifacts = await collectScriptDeliverables(workspaceRoot, before, startedAtMs).catch(() => []);
    return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, artifacts };
  };

  return [
    defineAgentTool({
      name: 'load_skill',
      description: 'Load the full SKILL.md instructions for a relevant authorized user Skill.',
      parameters: Type.Object({ skillId: Type.String({ minLength: 1 }) }),
      execute: async ({ skillId }) => {
        const skill = getSkill(skillId);
        if (!skill.instructions) return { ok: false, error: 'This Skill has metadata only; portable instructions are unavailable.' };
        loaded.add(skillId);
        const root = approvedSkillRoot(skill);
        const files = root ? await listSkillFiles(root).catch(() => []) : [];
        return {
          ok: true,
          skill: { id: skill.id, name: skill.name, instructions: skill.instructions },
          files: [...new Set([...files, ...skill.resources.map((resource) => resource.path)])],
          note: 'Only open a file listed in files. Do not guess scripts or paths that are not listed.',
        };
      },
    }),
    defineAgentTool({
      name: 'read_skill_file',
      description: 'Read a text file belonging to a loaded Skill. Path must be relative to that Skill directory; binary files and paths outside the Skill are blocked.',
      parameters: Type.Object({
        skillId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1, maxLength: 240 }),
      }),
      execute: async ({ skillId, path: relative }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!textFilePattern.test(relative)) return { ok: false, error: 'Only approved text resource formats can be read.' };
        const root = approvedSkillRoot(skill);
        if (!root) return { ok: false, error: 'Local Skill filesystem access is unavailable for this package.' };
        try {
          const file = await pathInside(root, relative);
          return { ok: true, path: safeRelative(relative), content: truncate(await readFile(file, 'utf8'), MAX_FILE_BYTES) };
        } catch {
          return { ok: false, error: `Skill file is unavailable: ${safeRelative(relative)}. Load the Skill and use only a path returned in its files list.` };
        }
      },
    }),
    defineAgentTool({
      name: 'read_workspace_file',
      description: 'Read a text artifact from this run\'s isolated workspace. Use only a relative path.',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }) }),
      execute: async ({ path: relative }) => {
        if (!textFilePattern.test(relative)) return { ok: false, error: 'Only approved text formats can be read from the workspace.' };
        const file = await workspacePath(relative);
        return { ok: true, path: safeRelative(relative), content: truncate(await readFile(file, 'utf8'), MAX_FILE_BYTES) };
      },
    }),
    defineAgentTool({
      name: 'write_workspace_file',
      description:
        'Write a text file to this run\'s isolated workspace. Process files (generators/scripts) stay outside output/. Finished business deliverables must use path under output/ or pass deliverable=true (auto-places under output/). Keep each call small: prefer content ≤12KB, or chunks (≤6KB each, up to 24); use mode "append" for large files.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        content: Type.Optional(Type.String({ maxLength: MAX_WRITE_CONTENT })),
        chunks: Type.Optional(Type.Array(Type.String({ maxLength: MAX_WRITE_CHUNK }), { maxItems: MAX_WRITE_CHUNKS })),
        mode: Type.Optional(StringEnum(['replace', 'append'] as const)),
        /** When true, file is written under output/ and archived as a business deliverable. */
        deliverable: Type.Optional(Type.Boolean()),
      }),
      execute: async ({ path: relative, content, chunks, mode, deliverable }) => {
        if (!canWriteWorkspace) return writeDenied();
        const writeMode = mode === 'append' ? 'append' : 'replace';
        const requested = safeRelative(relative);
        const asDeliverable = Boolean(deliverable) || isUnderWorkspaceOutput(requested);
        const targetRel = asDeliverable ? toOutputPath(requested) : requested;
        if (!textFilePattern.test(targetRel)) return { ok: false, error: 'Only approved text formats can be written.' };
        if (asDeliverable && !isBusinessDeliverablePath(targetRel)) {
          return { ok: false, error: 'Deliverable path is invalid. Use output/<filename> and avoid cache/bytecode names.' };
        }
        const body = typeof content === 'string' && content.length ? content : (chunks ?? []).join('');
        if (!body) return { ok: false, error: 'Write body is empty. Pass content or chunks.' };
        if (Buffer.byteLength(body) > MAX_FILE_BYTES) return { ok: false, error: `Single write exceeds ${MAX_FILE_BYTES} bytes. Split with mode "append".` };
        const file = await workspacePath(targetRel);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        if (writeMode === 'append') await writeFile(file, body, { encoding: 'utf8', flag: 'a', mode: 0o600 });
        else await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
        const size = (await stat(file)).size;
        return {
          ok: true,
          path: targetRel,
          bytes: Buffer.byteLength(body),
          totalBytes: size,
          mode: writeMode,
          deliverable: asDeliverable,
        };
      },
    }),
    defineAgentTool({
      name: 'register_deliverable',
      description:
        'Mark an existing run-workspace file as a finished business deliverable. Copies it into output/ (if needed) so it can be archived to the asset library / published to a project. Use this for final products of any type (including .py/.js) — do not register generator scripts you only needed as intermediate tooling.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        destName: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
      }),
      execute: async ({ path: relative, destName }) => {
        if (!canWriteWorkspace) return writeDenied();
        const sourceRel = safeRelative(relative);
        if (PROCESS_ONLY_DIRS.has(pathParts(sourceRel)[0] || '')) {
          return { ok: false, error: 'Files under scripts/tools/tmp/… are process files and cannot be registered as deliverables. Copy the final product out first, or write it under output/.' };
        }
        let source: string;
        try {
          source = await workspacePath(sourceRel);
          if (!(await stat(source)).isFile()) throw new Error('Not a file');
        } catch {
          return { ok: false, error: `Run workspace file is unavailable: ${sourceRel}.` };
        }
        // A file already under output/ is already a business deliverable. Do
        // not turn a harmless "register" confirmation into a second renamed
        // PDF and a duplicate asset card.
        if (isBusinessDeliverablePath(sourceRel)) {
          const bytes = (await stat(source)).size;
          return {
            ok: true,
            path: sourceRel,
            sourcePath: sourceRel,
            bytes,
            deliverable: true,
            alreadyRegistered: true,
          };
        }
        const destRel = toOutputPath(sourceRel, destName);
        if (!isBusinessDeliverablePath(destRel)) {
          return { ok: false, error: 'Deliverable name is invalid (cache/bytecode names are blocked).' };
        }
        const dest = await workspacePath(destRel);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        if (path.resolve(source) !== path.resolve(dest)) await copyFile(source, dest);
        const bytes = (await stat(dest)).size;
        return { ok: true, path: destRel, sourcePath: sourceRel, bytes, deliverable: true };
      },
    }),
    defineAgentTool({
      name: 'run_skill_script',
      description: 'Run a bundled script under scripts/ for a loaded Skill, in the isolated run workspace. No shell expressions are accepted. Requires explicit execution permission.',
      parameters: Type.Object({
        skillId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1, maxLength: 240 }),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 16 })),
      }),
      execute: async ({ skillId, path: relative, args }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!skill.execution.allowScriptExecution) return approval(skillId, 'script-execution', 'Running this Skill script requires your approval.');
        const normalized = safeRelative(relative);
        if (!executablePattern.test(normalized)) return { ok: false, error: 'Only script files under scripts/ with an approved extension may run.' };
        const root = approvedSkillRoot(skill);
        if (!root) return { ok: false, error: 'Local Skill script execution is unavailable for this package.' };
        let script: string;
        try {
          script = await pathInside(root, normalized);
          if (!(await stat(script)).isFile()) throw new Error('Not a file');
        } catch {
          return { ok: false, error: `Script is unavailable: ${normalized}. Use only a script listed by load_skill.` };
        }
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const extension = path.extname(script).toLowerCase();
        const command = extension === '.py' ? 'python3' : extension === '.sh' ? 'bash' : process.execPath;
        const before = new Set(await listOutputDeliverables(workspaceRoot).catch(() => []));
        const startedAtMs = Date.now();
        // Dependencies installed by install_python_dependency are deliberately
        // isolated under this run workspace.  Skill scripts must receive the
        // same PYTHONPATH as workspace scripts; otherwise a successful install
        // is invisible to the bundled renderer and agents fall back to copying
        // the renderer into the workspace.
        const dependencyRoot = path.join(workspaceRoot, '.python-packages');
        const result = await runProcess(command, [script, ...(args ?? [])], workspaceRoot, {
          env: { ...process.env, PYTHONPATH: dependencyRoot },
        });
        const declared = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('WORKMATE_DELIVERABLE:'))
          .map((line) => line.slice('WORKMATE_DELIVERABLE:'.length))
          .filter((item) => isBusinessDeliverablePath(item));
        const artifacts = declared.length
          ? [...new Set(declared)]
          : await collectScriptDeliverables(workspaceRoot, before, startedAtMs).catch(() => []);
        return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, artifacts };
      },
    }),
    defineAgentTool({
      name: 'run_workspace_script',
      description: 'Run a script previously written to this isolated run workspace to create or verify an artifact. No shell expressions are accepted.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 16 })),
      }),
      execute: async ({ path: relative, args }) => runWorkspaceScript(relative, args ?? []),
    }),
    defineAgentTool({
      name: 'publish_to_project',
      description:
        'Promote a finished business deliverable from this run workspace into the shared project workspace. Source must be under output/ (or already registered). Process files under scripts/tools/tmp stay in the run workspace. Requires a project-bound run.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 240 }),
        destPath: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      }),
      execute: async ({ path: relative, destPath }) => {
        if (!canWriteWorkspace) return writeDenied();
        if (!projectRoot) {
          return { ok: false, error: 'Current run is not bound to a project workspace. publish_to_project is only available for project tasks.' };
        }
        const sourceRel = safeRelative(relative);
        const stagedRel = isBusinessDeliverablePath(sourceRel) ? sourceRel : toOutputPath(sourceRel);
        const destRel = safeRelative(destPath || (isUnderWorkspaceOutput(sourceRel)
          ? sourceRel.slice(WORKSPACE_OUTPUT_DIR.length + 1)
          : path.basename(sourceRel)));
        if (!isBusinessDeliverablePath(stagedRel)) {
          return {
            ok: false,
            error: 'Only files under output/ may be published. Write/register the finished product with deliverable=true or register_deliverable first.',
          };
        }
        let source: string;
        try {
          source = await workspacePath(isBusinessDeliverablePath(sourceRel) ? sourceRel : stagedRel);
          if (!(await stat(source)).isFile()) throw new Error('Not a file');
        } catch {
          // If caller passed a non-output path that exists, stage then publish.
          try {
            const raw = await workspacePath(sourceRel);
            if (!(await stat(raw)).isFile()) throw new Error('Not a file');
            const stagedAbs = await workspacePath(stagedRel);
            await mkdir(path.dirname(stagedAbs), { recursive: true, mode: 0o700 });
            await copyFile(raw, stagedAbs);
            source = stagedAbs;
          } catch {
            return { ok: false, error: `Run workspace file is unavailable: ${sourceRel}. Write it with write_workspace_file first.` };
          }
        }
        const dest = await projectPath(destRel);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await copyFile(source, dest);
        const bytes = (await stat(dest)).size;
        return { ok: true, path: stagedRel, projectPath: destRel, bytes, projectRoot, deliverable: true };
      },
    }),
    defineAgentTool({
      name: 'install_python_dependency',
      description: 'Install a Python package into this run workspace only when required to create or verify an artifact. This is allowed by default work permission; it never modifies system Python.',
      parameters: Type.Object({
        package: Type.String({ minLength: 1, maxLength: 120 }),
      }),
      execute: async ({ package: dependency }) => {
        if (!canRunWorkspaceScript) return scriptDenied();
        if (!/^[a-zA-Z0-9_.-]+(?:==[a-zA-Z0-9_.+-]+)?$/.test(dependency)) return { ok: false, error: 'Only a simple PyPI package name with an optional exact version is permitted.' };
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const dependencyRoot = path.join(workspaceRoot, '.python-packages');
        const moduleName = pythonImportProbeModuleName(dependency);
        const probe = await runProcess('python3', ['-c', `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`], workspaceRoot, { timeoutMs: 10_000 }).catch(() => null);
        if (probe?.exitCode === 0) {
          return {
            ok: true,
            package: dependency,
            exitCode: 0,
            alreadyAvailable: true,
            stdout: `Python module already available: ${moduleName}`,
            stderr: '',
          };
        }
        const result = await runProcess('python3', ['-m', 'pip', 'install', '--disable-pip-version-check', '--target', dependencyRoot, dependency], workspaceRoot, { timeoutMs: 120_000 });
        return { ok: result.exitCode === 0, package: dependency, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    }),
    defineAgentTool({
      name: 'fetch_skill_url',
      description: 'Fetch a public HTTPS URL for a loaded Skill. The URL host must be explicitly allowlisted by that Skill. This tool only performs GET requests and returns bounded text.',
      parameters: Type.Object({
        skillId: Type.String({ minLength: 1 }),
        url: Type.String({ minLength: 1, maxLength: 2_000 }),
      }),
      execute: async ({ skillId, url }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        let target: URL;
        try {
          target = new URL(url);
        } catch {
          return { ok: false, error: 'Invalid URL.' };
        }
        if (target.protocol !== 'https:') return { ok: false, error: 'Only HTTPS network requests are permitted.' };
        if (!skill.execution.allowAllNonDestructive && !skill.execution.allowedNetworkHosts.includes(target.hostname)) {
          return approval(skillId, 'network-access', `Network access to ${target.hostname} requires your approval and an allowlist entry.`);
        }
        const response = await fetch(target, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: { accept: 'text/plain, text/markdown, application/json, text/html;q=0.5' },
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) return { ok: false, status: response.status, error: `Network request failed with HTTP ${response.status}.` };
        if (!/^(text\/|application\/(json|xml|javascript))/i.test(contentType)) {
          return { ok: false, error: `Unsupported response content type: ${contentType || 'unknown'}.` };
        }
        const content = truncate(await response.text(), MAX_NETWORK_BYTES);
        return { ok: true, url: target.toString(), contentType, content };
      },
    }),
  ];
}
