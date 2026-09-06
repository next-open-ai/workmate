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

function siblingHarnessRoot(): string | null {
  const fromEnv = process.env.WORKMATE_DSH_ROOT?.trim();
  if (fromEnv && exists(fromEnv)) return path.resolve(fromEnv);
  // agent-core lives at workmate/packages/agent-core → ../../../deepseek-harness
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, '../../../../../deepseek-harness');
  if (exists(path.join(candidate, 'pnpm-workspace.yaml'))) return candidate;
  const fromCwd = path.resolve(process.cwd(), '../deepseek-harness');
  if (exists(path.join(fromCwd, 'pnpm-workspace.yaml'))) return fromCwd;
  return null;
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
    const tsxBin = path.join(harnessRoot, 'node_modules/.bin/tsx');
    if (exists(srcBin) && exists(tsxBin)) {
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
      + '(or node path to its bin). Optional: WORKMATE_DSH_ROOT=/path/to/deepseek-harness.',
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
