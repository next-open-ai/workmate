import path from 'node:path';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';

/**
 * Engine-neutral execution boundary. Adapters (Pi today, other runtimes later)
 * translate their tool protocol into these capabilities; policy never lives in
 * an individual model adapter.
 */
export type CapabilityPermission = 'workspace.read' | 'workspace.write' | 'workspace.execute' | 'artifact.commit';

export type CapabilityContext = {
  runId: string;
  workspaceRoot: string;
  workspaceAccess: 'read' | 'write' | 'full';
  workspaceMode: 'conversation' | 'project';
};

export type CapabilityResult = {
  ok: boolean;
  path?: string;
  bytes?: number;
  deliverable?: boolean;
  error?: { code: string; message: string; retryable: boolean };
};

const BLOCKED_COMMAND = /(^|\s)(rm\s+-[a-z]*[rf][a-z]*\b|mkfs\b|diskutil\s+erase|shutdown\b|reboot\b|killall\b|curl\b|wget\b|nc\b|ssh\b)(\s|$)/i;
const PROCESS_DIRECTORIES = new Set(['scripts', 'tools', 'tmp', 'node_modules', '.python-packages', '__pycache__']);

function normalizedRelative(value: string) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Path must be a safe path inside this run workspace.');
  }
  return normalized;
}

function relativeTo(root: string, candidate: string) {
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the authorized workspace.');
  }
  return normalizedRelative(relative);
}

export class WorkspaceCapabilityKernel {
  readonly root: string;

  constructor(readonly context: CapabilityContext) {
    this.root = path.resolve(context.workspaceRoot);
  }

  assertReadPath(candidate: string) {
    return relativeTo(this.root, path.resolve(candidate));
  }

  assertWritePath(candidate: string) {
    if (this.context.workspaceAccess !== 'write' && this.context.workspaceAccess !== 'full') {
      throw new Error('Workspace write is not permitted for this run.');
    }
    return relativeTo(this.root, path.resolve(candidate));
  }

  assertCommand(command: string) {
    if (this.context.workspaceAccess !== 'write' && this.context.workspaceAccess !== 'full') {
      throw new Error('Workspace script execution is not permitted for this run.');
    }
    if (BLOCKED_COMMAND.test(command)) {
      throw new Error('This command is blocked by the workspace execution policy. Use a safe local build command instead.');
    }
    return command;
  }

  /**
   * Atomically publish a verified conversation deliverable. Nothing becomes an
   * asset until this succeeds. Project runs already write their final tree.
   */
  async commitArtifact(relativePath: string): Promise<CapabilityResult> {
    try {
      if (this.context.workspaceAccess !== 'write' && this.context.workspaceAccess !== 'full') {
        throw new Error('Artifact commit is not permitted for this run.');
      }
      const requested = normalizedRelative(relativePath);
      const source = path.resolve(this.root, requested);
      const sourceRelative = this.assertReadPath(source);
      if (PROCESS_DIRECTORIES.has(sourceRelative.split('/')[0] || '')) {
        throw new Error('Process files cannot be committed as business artifacts.');
      }
      const info = await stat(source);
      if (!info.isFile() || info.size <= 0) throw new Error('Artifact file is missing or empty.');

      if (this.context.workspaceMode === 'project') {
        return { ok: true, path: sourceRelative, bytes: info.size, deliverable: true };
      }

      const outputRelative = sourceRelative.startsWith('output/')
        ? sourceRelative
        : `output/${path.basename(sourceRelative)}`;
      const target = path.resolve(this.root, outputRelative);
      this.assertWritePath(target);
      if (target !== source) {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.workmate-${this.context.runId}.tmp`;
        await copyFile(source, temporary);
        // The staging file lives beside target, so this final replacement is
        // atomic on the workspace filesystem.
        await rename(temporary, target);
      }
      const committed = await stat(target);
      return { ok: true, path: outputRelative, bytes: committed.size, deliverable: true };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'ARTIFACT_COMMIT_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }
  }
}
