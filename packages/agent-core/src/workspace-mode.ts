import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';

/**
 * Dual workspace modes for every execution backend (pi / dsh / …):
 *
 * - conversation: isolated run dir; finished files under output/ → artifact.created → session assets
 * - project: cwd is the shared project root; write the real tree at root → project.file.published
 */
export type WorkspaceMode = 'conversation' | 'project';

const INTERNAL_SNAPSHOT_SKIP = new Set([
  '.agents',
  '.dsh-sessions',
  '.git',
  '.python-packages',
  '.workmate-workspaces',
  'node_modules',
  '__pycache__',
]);

export function resolveWorkspaceMode(projectWorkspacePath?: string | null): WorkspaceMode {
  return String(projectWorkspacePath || '').trim() ? 'project' : 'conversation';
}

export function workspacesRootDir() {
  // Conversation runs write directly into the asset subsystem's private
  // staging area.  The controller promotes a completed run into an immutable
  // asset; incomplete/cancelled runs never enter the asset library.
  return process.env.WORKMATE_ASSET_STAGING_DIR?.trim()
    || process.env.WORKMATE_WORKSPACES_DIR?.trim()
    || path.join(process.env.WORKMATE_DATA_DIR?.trim() || path.join(os.homedir(), '.workmate'), 'assets', '.staging');
}

/** Same root resolution for pi and dsh so mode behaviour stays aligned. */
export function resolveAgentWorkspaceRoot(input: {
  runId: string;
  projectWorkspacePath?: string | null;
}): string {
  const project = String(input.projectWorkspacePath || '').trim();
  if (project) {
    fs.mkdirSync(project, { recursive: true });
    return path.resolve(project);
  }
  const runId = String(input.runId || 'run').replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(workspacesRootDir(), runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function conversationModeContract() {
  return [
    '[Workspace mode: conversation]',
    'This run uses an isolated conversation workspace.',
    'Finished user-facing files (PDF, DOCX, HTML, Markdown, CSV, images, …) MUST be written under output/',
    '(create the directory if needed). Prefer output/<clear-name> over workspace-root files.',
    'Process files (generators/scripts/tmp) stay outside output/.',
    'Deliverables are archived to the session asset library via output/.',
  ].join('\n');
}

export function projectModeContract() {
  return [
    '[Workspace mode: project]',
    'The current working directory is the final shared project root.',
    'Create and edit the actual project structure directly here (index.html, src/, assets/, …).',
    'Do not wrap the product in an output/ directory.',
    'Keep temporary process files out of the final project tree when possible (prefer scripts/ or hidden dirs).',
    'Deliverables appear in the project file tree, not as conversation-only assets.',
  ].join('\n');
}

export function workspaceModeContract(mode: WorkspaceMode) {
  return mode === 'project' ? projectModeContract() : conversationModeContract();
}

/** Fingerprint project/conversation tree for end-of-run publish detection. */
export async function snapshotWorkspaceFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string, relative = '', depth = 0): Promise<void> => {
    if (depth > 12 || files.size >= 2_000) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (INTERNAL_SNAPSHOT_SKIP.has(entry.name) || entry.name === '.workmate-dsh.cordis.yml') continue;
      if (entry.name.startsWith('.') && entry.name !== '.gitkeep') continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target, childRelative, depth + 1);
      } else if (entry.isFile() && childRelative.length <= 240) {
        const info = await stat(target).catch(() => null);
        if (info) files.set(childRelative, `${info.size}:${info.mtimeMs}`);
      }
      if (files.size >= 2_000) return;
    }
  };
  await visit(path.resolve(root));
  return files;
}
