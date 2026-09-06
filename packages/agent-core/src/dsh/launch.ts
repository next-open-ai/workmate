import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export type DshLaunchSpec = {
  command: string;
  args: string[];
  /** Absolute path to cordis.yml (passed as argv and/or DSH_CORDIS_CONFIG). */
  cordisConfig: string;
  /** Working directory for the runtime process (plugin resolution). */
  spawnCwd?: string;
  /** Hint for diagnostics. */
  source: string;
};

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function isHarnessRoot(dir: string): boolean {
  return exists(path.join(dir, 'pnpm-workspace.yaml'))
    && (
      exists(path.join(dir, 'packages/examples/jsonrpc-demo'))
      || exists(path.join(dir, 'examples/jsonrpc-agent'))
    );
}

/**
 * Walk ancestors of `start` looking for a sibling `deepseek-harness` checkout.
 * Works from agent-core source, agent-core dist, bundled api/dist, and
 * Electron cwd (`apps/desktop`).
 */
function findSiblingHarness(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    const sibling = path.resolve(dir, '../deepseek-harness');
    if (isHarnessRoot(sibling)) return sibling;
    const nested = path.join(dir, 'deepseek-harness');
    if (isHarnessRoot(nested)) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function siblingHarnessRoot(): string | null {
  const fromEnv = process.env.WORKMATE_DSH_ROOT?.trim();
  if (fromEnv && isHarnessRoot(fromEnv)) return path.resolve(fromEnv);
  if (fromEnv && exists(fromEnv)) return path.resolve(fromEnv);

  return findSiblingHarness(moduleDir())
    || findSiblingHarness(process.cwd())
    || null;
}

function resolveCordis(harnessRoot: string | null): string | null {
  const fromEnv = process.env.WORKMATE_DSH_CORDIS?.trim();
  if (fromEnv && exists(fromEnv)) return path.resolve(fromEnv);
  if (!harnessRoot) return null;
  const example = path.join(harnessRoot, 'examples/jsonrpc-agent/cordis.yml');
  if (exists(example)) return example;
  return null;
}

function resolveBin(harnessRoot: string | null): { command: string; args: string[]; source: string } | null {
  const binEnv = process.env.WORKMATE_DSH_BIN?.trim();
  if (binEnv) {
    const extra = String(process.env.WORKMATE_DSH_ARGS || '')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    return { command: binEnv, args: extra, source: 'WORKMATE_DSH_BIN' };
  }

  // Prefer a globally installed dsh-jsonrpc-agent if present.
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin');
    if (resolved) return { command: process.execPath, args: [resolved], source: 'node_modules' };
  } catch {
    /* not installed in workmate */
  }

  if (harnessRoot) {
    const built = path.join(harnessRoot, 'packages/examples/jsonrpc-demo/lib/bin.js');
    if (exists(built)) {
      return { command: process.execPath, args: [built], source: `sibling:${built}` };
    }
    const srcBin = path.join(harnessRoot, 'packages/examples/jsonrpc-demo/src/bin.ts');
    const tsxCandidates = [
      path.join(harnessRoot, 'node_modules/.bin/tsx'),
      path.join(harnessRoot, 'node_modules/tsx/dist/cli.mjs'),
    ];
    const tsxBin = tsxCandidates.find((item) => exists(item));
    if (exists(srcBin) && tsxBin) {
      // Prefer node + cli.mjs so we do not depend on a shell shim.
      if (tsxBin.endsWith('.mjs') || tsxBin.endsWith('.js')) {
        return {
          command: process.execPath,
          args: [tsxBin, srcBin],
          source: `sibling-tsx:${srcBin}`,
        };
      }
      return {
        command: tsxBin,
        args: [srcBin],
        source: `sibling-tsx:${srcBin}`,
      };
    }
  }

  return null;
}

/**
 * Resolve how to spawn the DeepSeek Harness JSON-RPC runtime.
 * @param options.cordisConfig — absolute cordis.yml (Workmate-generated or override).
 */
export function resolveDshLaunch(options?: { cordisConfig?: string }): DshLaunchSpec {
  const harnessRoot = siblingHarnessRoot();
  const cordisConfig = (() => {
    const fromOpt = options?.cordisConfig?.trim();
    if (fromOpt) {
      const resolved = path.resolve(fromOpt);
      if (!exists(resolved)) {
        throw new Error(`DeepSeek Harness cordis config not found: ${resolved}`);
      }
      return resolved;
    }
    return resolveCordis(harnessRoot);
  })();
  const bin = resolveBin(harnessRoot);

  if (!bin) {
    throw new Error(
      'DeepSeek Harness runtime not found. Set WORKMATE_DSH_BIN to dsh-jsonrpc-agent '
      + '(or node path to its bin). Optional: WORKMATE_DSH_ROOT=/path/to/deepseek-harness '
      + `(looked relative to ${moduleDir()} and cwd ${process.cwd()}).`,
    );
  }
  if (!cordisConfig) {
    throw new Error(
      'DeepSeek Harness cordis config missing. Workmate normally generates one per run; '
      + 'or set WORKMATE_DSH_CORDIS to an absolute cordis.yml path.',
    );
  }

  return {
    command: bin.command,
    args: [...bin.args, cordisConfig],
    cordisConfig,
    spawnCwd: harnessRoot ?? path.dirname(cordisConfig),
    source: bin.source,
  };
}

export function resolveDshWorkspace(input: {
  runId?: string;
  projectWorkspacePath?: string;
}): string {
  const project = String(input.projectWorkspacePath || '').trim();
  if (project) {
    fs.mkdirSync(project, { recursive: true });
    return path.resolve(project);
  }
  const runId = String(input.runId || 'dsh-run').replace(/[^a-zA-Z0-9._-]/g, '_');
  const root = process.env.WORKMATE_WORKSPACES_DIR?.trim()
    || path.join(process.env.WORKMATE_DATA_DIR?.trim() || path.join(os.homedir(), '.workmate'), 'workspaces');
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
