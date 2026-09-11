import fs from 'node:fs';
import path from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { workspacesRootDir } from './workspace-mode.js';

/** Resolve conversation staging path without creating it. */
export function conversationStagingPath(runId: string): string {
  const safe = String(runId || 'run').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.resolve(path.join(workspacesRootDir(), safe));
}

/** Top-level dirs/files treated as Agent process scrap (safe to delete). */
export const WORKSPACE_SCRAP_TOP_LEVEL = [
  '.python-packages',
  'scripts',
  'tools',
  'tmp',
  'deps',
  '__pycache__',
  'node_modules',
] as const;

export type WorkspaceScrapEntry = {
  relative: string;
  absolute: string;
  bytes: number;
  kind: 'dir' | 'file';
};

export type WorkspaceScrapReport = {
  root: string;
  entries: WorkspaceScrapEntry[];
  totalBytes: number;
};

export type WorkspaceScrapCleanResult = {
  root: string;
  removed: string[];
  failed: Array<{ relative: string; error: string }>;
  freedBytes: number;
};

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function dirBytes(target: string): Promise<number> {
  const info = await stat(target).catch(() => null);
  if (!info) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) {
        const file = await stat(child).catch(() => null);
        if (file) total += file.size;
      }
    }
  }
  return total;
}

function assertInsideRoot(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to touch path outside workspace: ${candidate}`);
  }
}

/** Scan process-only scrap under a workspace / project root. */
export async function scanWorkspaceScrap(root: string): Promise<WorkspaceScrapReport> {
  const resolvedRoot = path.resolve(root);
  const entries: WorkspaceScrapEntry[] = [];
  if (!fs.existsSync(resolvedRoot)) return { root: resolvedRoot, entries, totalBytes: 0 };

  for (const name of WORKSPACE_SCRAP_TOP_LEVEL) {
    const absolute = path.join(resolvedRoot, name);
    if (!fs.existsSync(absolute)) continue;
    const info = await stat(absolute).catch(() => null);
    if (!info) continue;
    const bytes = await dirBytes(absolute);
    entries.push({
      relative: name,
      absolute,
      bytes,
      kind: info.isDirectory() ? 'dir' : 'file',
    });
  }

  // Nested __pycache__ outside listed tops (best-effort shallow walk).
  const walk = async (directory: string, relative = '', depth = 0): Promise<void> => {
    if (depth > 6) return;
    const listing = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of listing) {
      if (WORKSPACE_SCRAP_TOP_LEVEL.includes(entry.name as typeof WORKSPACE_SCRAP_TOP_LEVEL[number])) continue;
      const childRel = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbs = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === '__pycache__') {
        if (entries.some((item) => item.absolute === childAbs)) continue;
        entries.push({
          relative: childRel,
          absolute: childAbs,
          bytes: await dirBytes(childAbs),
          kind: 'dir',
        });
        continue;
      }
      if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(childAbs, childRel, depth + 1);
    }
  };
  await walk(resolvedRoot);

  const totalBytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  return { root: resolvedRoot, entries, totalBytes };
}

/** Remove scrap dirs/files under a workspace. Never deletes the workspace root itself. */
export async function cleanWorkspaceScrap(root: string): Promise<WorkspaceScrapCleanResult> {
  const report = await scanWorkspaceScrap(root);
  const removed: string[] = [];
  const failed: Array<{ relative: string; error: string }> = [];
  let freedBytes = 0;

  for (const entry of report.entries) {
    try {
      assertInsideRoot(report.root, entry.absolute);
      await rm(entry.absolute, { recursive: true, force: true });
      removed.push(entry.relative);
      freedBytes += entry.bytes;
    } catch (error) {
      failed.push({ relative: entry.relative, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { root: report.root, removed, failed, freedBytes };
}

/** Remove an entire conversation run staging directory (after session delete). */
export async function removeConversationRunWorkspace(runId: string): Promise<{ path: string; removed: boolean; error?: string }> {
  const stagingRoot = path.resolve(workspacesRootDir());
  const target = conversationStagingPath(runId);
  try {
    assertInsideRoot(stagingRoot, target);
  } catch (error) {
    return { path: target, removed: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!fs.existsSync(target)) return { path: target, removed: false };
  try {
    await rm(target, { recursive: true, force: true });
    return { path: target, removed: true };
  } catch (error) {
    return { path: target, removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function cleanupConversationSessionWorkspaces(runIds: string[]): Promise<{
  removedPaths: string[];
  failed: Array<{ path: string; error: string }>;
}> {
  const removedPaths: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const runId of [...new Set(runIds.map((id) => String(id || '').trim()).filter(Boolean))]) {
    const result = await removeConversationRunWorkspace(runId);
    if (result.removed) removedPaths.push(result.path);
    else if (result.error) failed.push({ path: result.path, error: result.error });
  }
  return { removedPaths, failed };
}

/** Aggregate scrap across conversation staging + optional project roots. */
export async function scanManagedWorkspaceScrap(projectRoots: string[] = []): Promise<{
  stagingRoot: string;
  reports: WorkspaceScrapReport[];
  totalBytes: number;
}> {
  const stagingRoot = path.resolve(workspacesRootDir());
  const reports: WorkspaceScrapReport[] = [];

  if (fs.existsSync(stagingRoot)) {
    const children = await readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const report = await scanWorkspaceScrap(path.join(stagingRoot, child.name));
      if (report.totalBytes > 0 || report.entries.length) reports.push(report);
    }
  }

  for (const projectRoot of projectRoots) {
    const trimmed = String(projectRoot || '').trim();
    if (!trimmed || !fs.existsSync(trimmed)) continue;
    const report = await scanWorkspaceScrap(trimmed);
    if (report.totalBytes > 0 || report.entries.length) reports.push(report);
  }

  const totalBytes = reports.reduce((sum, item) => sum + item.totalBytes, 0);
  return { stagingRoot, reports, totalBytes };
}

export async function cleanManagedWorkspaceScrap(projectRoots: string[] = []): Promise<{
  results: WorkspaceScrapCleanResult[];
  freedBytes: number;
  failedCount: number;
}> {
  const scan = await scanManagedWorkspaceScrap(projectRoots);
  const results: WorkspaceScrapCleanResult[] = [];
  for (const report of scan.reports) {
    results.push(await cleanWorkspaceScrap(report.root));
  }
  return {
    results,
    freedBytes: results.reduce((sum, item) => sum + item.freedBytes, 0),
    failedCount: results.reduce((sum, item) => sum + item.failed.length, 0),
  };
}
