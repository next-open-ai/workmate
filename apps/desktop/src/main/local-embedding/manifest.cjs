const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const DEFAULT_MANIFEST = {
  runtimeId: 'local-embedding-default',
  version: 'v1',
  providerName: 'Local Embedding (System)',
  providerType: 'openai-compatible',
  modelId: 'local-embedding-default',
  dimension: 1024,
  normalize: true,
  sizeBytes: 800 * 1024 * 1024,
  platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'],
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function embeddingRuntimeRoot(storageRoot) {
  return path.join(storageRoot, 'runtime', 'embedding');
}

function embeddingRuntimePaths(storageRoot) {
  const root = embeddingRuntimeRoot(storageRoot);
  return {
    root,
    manifests: path.join(root, 'manifests'),
    downloads: path.join(root, 'downloads'),
    models: path.join(root, 'models'),
    sidecar: path.join(root, 'sidecar'),
    logs: path.join(root, 'logs'),
    stateFile: path.join(root, 'state.json'),
  };
}

function defaultManifest() {
  return {
    ...DEFAULT_MANIFEST,
    platform: platformKey(),
    supported: DEFAULT_MANIFEST.platforms.includes(platformKey()),
  };
}

function ensureManifestFile(storageRoot) {
  const paths = embeddingRuntimePaths(storageRoot);
  mkdirSync(paths.manifests, { recursive: true, mode: 0o700 });
  const file = path.join(paths.manifests, 'current.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(defaultManifest(), null, 2), { mode: 0o600 });
  return file;
}

module.exports = {
  defaultManifest,
  ensureManifestFile,
  embeddingRuntimePaths,
  embeddingRuntimeRoot,
  platformKey,
};
