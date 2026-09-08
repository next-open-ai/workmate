const { existsSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const { defaultManifest, embeddingRuntimePaths, ensureManifestFile } = require('./manifest.cjs');
const { writeState } = require('./state-store.cjs');

function modelFolder(storageRoot, manifest = defaultManifest()) {
  return path.join(embeddingRuntimePaths(storageRoot).models, `${manifest.runtimeId}-${manifest.version}`);
}

function downloadSnapshot(storageRoot, manifest = defaultManifest()) {
  const folder = modelFolder(storageRoot, manifest);
  const ready = existsSync(folder) && statSync(folder).isDirectory() && readdirSync(folder).length > 0;
  return {
    downloadStatus: ready ? 'ready' : 'missing',
    modelDir: ready ? folder : '',
    expectedSizeBytes: manifest.sizeBytes,
  };
}

function markDownloadIntent(storageRoot, manifest = defaultManifest()) {
  ensureManifestFile(storageRoot);
  return writeState(storageRoot, {
    enabled: true,
    runtimeId: manifest.runtimeId,
    version: manifest.version,
    downloadStatus: 'missing',
    serviceStatus: 'stopped',
    checkedAt: Date.now(),
    lastError: '',
  });
}

module.exports = {
  downloadSnapshot,
  ensureManifestFile,
  markDownloadIntent,
  modelFolder,
};
