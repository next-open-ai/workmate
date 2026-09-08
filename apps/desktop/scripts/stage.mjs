import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsRoot = path.resolve(desktopRoot, '..');
const projectRoot = path.resolve(appsRoot, '..');
const stageRoot = path.join(desktopRoot, 'stage');
const runtimeRoot = path.join(projectRoot, 'runtimes', 'agentscope-runtime');
const sources = [
  { from: path.join(appsRoot, 'renderer', 'dist'), to: path.join(stageRoot, 'renderer') },
  { from: path.join(appsRoot, 'api', 'dist'), to: path.join(stageRoot, 'api') },
  { from: path.dirname(createRequire(path.join(desktopRoot, 'package.json')).resolve('sql.js/dist/sql-wasm.js')), to: path.join(stageRoot, 'sqljs') },
];

rmSync(stageRoot, { recursive: true, force: true });
for (const source of sources) {
  if (!existsSync(source.from)) throw new Error(`Missing build output: ${source.from}`);
  cpSync(source.from, source.to, { recursive: true, dereference: true });
}

// pi-coding-agent resolves its package root by walking up from main.cjs and
// reading package.json. Packaged API lives under Resources/api/, so the
// manifest must sit next to the bundle or the child exits on startup.
const apiPackageJson = path.join(appsRoot, 'api', 'package.json');
cpSync(apiPackageJson, path.join(stageRoot, 'api', 'package.json'));

// Electron Builder must never follow pnpm workspace links into the repository
// root. Stage the API's production dependency closure explicitly instead.
const apiManifest = JSON.parse(readFileSync(apiPackageJson, 'utf8'));
const stagedDeps = path.join(stageRoot, 'api', 'node_deps');
const seen = new Set();

function resolvePackageDir(name, resolver) {
  const entry = resolver.resolve(name);
  let current = path.dirname(realpathSync(entry));
  while (current.startsWith(projectRoot)) {
    const manifestPath = path.join(current, 'package.json');
    if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, 'utf8')).name === name) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function copyDereferenced(source, destination) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    copyDereferenced(realpathSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    if (['.bin', '.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache'].includes(path.basename(source))) return;
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) copyDereferenced(path.join(source, entry), path.join(destination, entry));
    return;
  }
  cpSync(source, destination);
}

function stageDependency(name, resolver) {
  if (seen.has(name) || name.startsWith('@workmate/')) return;
  // Some runtime dependencies (e.g. apache-arrow) wrongly list @types/* in
  // their runtime `dependencies`. Those are compile-time only and may not even
  // be resolvable in the CI pnpm layout — never stage or recurse into them.
  if (name.startsWith('@types/')) return;
  const source = resolvePackageDir(name, resolver);
  if (!source) throw new Error(`Unable to resolve API production dependency: ${name}`);
  seen.add(name);
  const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  const dependencyResolver = createRequire(path.join(source, 'package.json'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) stageDependency(dependency, dependencyResolver);
  copyDereferenced(source, path.join(stagedDeps, name));
}

const apiResolver = createRequire(path.join(appsRoot, 'api', 'package.json'));
for (const dependency of Object.keys(apiManifest.dependencies ?? {})) stageDependency(dependency, apiResolver);
console.log(`Staged ${seen.size} API production packages.`);

const stagedRuntime = path.join(stageRoot, 'agentscope-runtime');
mkdirSync(stagedRuntime, { recursive: true });
for (const entry of ['src', 'pyproject.toml', 'requirements.txt', '.venv']) {
  const source = path.join(runtimeRoot, entry);
  if (!existsSync(source)) continue;
  copyDereferenced(source, path.join(stagedRuntime, entry));
}
console.log(`Staged AgentScope runtime from ${runtimeRoot}.`);
