const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { ensureRuntimeFolders } = require('./state-store.cjs');

function settingsFile(storageRoot) {
  return path.join(ensureRuntimeFolders(storageRoot).root, 'settings.json');
}

function defaultSettings() {
  return {
    autoRestart: false,
    backendUrl: '',
    backendModel: '',
    backendApiKey: '',
    updatedAt: 0,
  };
}

function encryptSecret(value) {
  if (!value) return '';
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(String(value)).toString('base64')
    : String(value);
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(String(value), 'base64'))
      : String(value);
  } catch {
    return String(value || '');
  }
}

function readLocalEmbeddingSettings(storageRoot) {
  const file = settingsFile(storageRoot);
  if (!existsSync(file)) return defaultSettings();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      ...defaultSettings(),
      ...raw,
      backendUrl: String(raw?.backendUrl || ''),
      backendModel: String(raw?.backendModel || ''),
      backendApiKey: decryptSecret(raw?.backendApiKey),
    };
  } catch {
    return defaultSettings();
  }
}

function writeLocalEmbeddingSettings(storageRoot, patch) {
  const file = settingsFile(storageRoot);
  const next = {
    ...readLocalEmbeddingSettings(storageRoot),
    ...(patch && typeof patch === 'object' ? patch : {}),
    updatedAt: Date.now(),
  };
  const persisted = {
    ...next,
    backendUrl: String(next.backendUrl || ''),
    backendModel: String(next.backendModel || ''),
    backendApiKey: encryptSecret(next.backendApiKey),
  };
  writeFileSync(file, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  return next;
}

module.exports = {
  defaultSettings,
  readLocalEmbeddingSettings,
  writeLocalEmbeddingSettings,
};
