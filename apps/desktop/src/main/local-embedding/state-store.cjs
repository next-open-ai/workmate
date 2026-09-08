const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { embeddingRuntimePaths } = require('./manifest.cjs');

function ensureRuntimeFolders(storageRoot) {
  const paths = embeddingRuntimePaths(storageRoot);
  for (const folder of [paths.root, paths.manifests, paths.downloads, paths.models, paths.sidecar, paths.logs]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  return paths;
}

function defaultState() {
  return {
    enabled: false,
    runtimeId: 'local-embedding-default',
    version: 'v1',
    downloadStatus: 'missing',
    serviceStatus: 'stopped',
    endpoint: '',
    port: null,
    pid: null,
    checkedAt: 0,
    lastError: '',
    updatedAt: Date.now(),
  };
}

function readState(storageRoot) {
  const paths = ensureRuntimeFolders(storageRoot);
  if (!existsSync(paths.stateFile)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
    return {
      ...defaultState(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    };
  } catch {
    return defaultState();
  }
}

function writeState(storageRoot, patch) {
  const paths = ensureRuntimeFolders(storageRoot);
  const next = {
    ...readState(storageRoot),
    ...(patch && typeof patch === 'object' ? patch : {}),
    updatedAt: Date.now(),
  };
  writeFileSync(paths.stateFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

module.exports = {
  defaultState,
  ensureRuntimeFolders,
  readState,
  writeState,
};
