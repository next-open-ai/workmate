const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen, protocol, net } = require('electron');
const { fork, execFile, spawnSync } = require('node:child_process');
const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'workmate-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const apiPort = Number(process.env.WORKMATE_API_PORT || 4328);
/** Shared with the forked API so main-process KV can authenticate as system admin. */
const apiInternalToken = String(process.env.WORKMATE_INTERNAL_TOKEN || randomBytes(24).toString('hex'));
let mainWindow;
let apiProcess;
let gatewayProcess = null;
let database;
const storageRoot = () => path.join(app.getPath('home'), '.workmate');
const databaseFile = () => path.join(storageRoot(), 'workmate.sqlite');
/** @type {Map<string, string>} */
const previewRoots = new Map();

async function initializeDatabase() {
  mkdirSync(storageRoot(), { recursive: true, mode: 0o700 });
  const sqlJsRoot = app.isPackaged ? path.join(app.getAppPath(), 'stage', 'sqljs') : path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const initSqlJs = require(path.join(sqlJsRoot, 'sql-wasm.js'));
  const SQL = await initSqlJs({ wasmBinary: readFileSync(path.join(sqlJsRoot, 'sql-wasm.wasm')) });
  database = new SQL.Database(existsSync(databaseFile()) ? readFileSync(databaseFile()) : undefined);
  database.run('CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  database.run('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, conversation_id TEXT, employee_id TEXT, run_id TEXT NOT NULL, sha256 TEXT NOT NULL)');
  database.run('CREATE INDEX IF NOT EXISTS assets_created_at ON assets(created_at DESC)');
  migrateAssetsSchema();
  flushDatabase();
}

function assetColumnNames() {
  const info = database.exec('PRAGMA table_info(assets)');
  return new Set((info[0]?.values || []).map((row) => String(row[1])));
}

function migrateAssetsSchema() {
  const cols = assetColumnNames();
  if (!cols.has('project_id')) database.run('ALTER TABLE assets ADD COLUMN project_id TEXT');
  if (!cols.has('workspace_relative')) database.run('ALTER TABLE assets ADD COLUMN workspace_relative TEXT');
  database.run('CREATE INDEX IF NOT EXISTS assets_project_id ON assets(project_id)');
  // Backfill workspace_relative from basename for legacy rows.
  database.run(`UPDATE assets SET workspace_relative = name WHERE workspace_relative IS NULL OR workspace_relative = ''`);
}

function flushDatabase() { writeFileSync(databaseFile(), Buffer.from(database.export()), { mode: 0o600 }); }
function getStoredValue(key) { const result = database.exec('SELECT value FROM app_kv WHERE key = ?', [key]); return result[0]?.values[0]?.[0] ?? null; }
function setStoredValue(key, value) { database.run('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', [key, value, Date.now()]); flushDatabase(); }

function assetMimeType(name) {
  const extension = path.extname(name).toLowerCase();
  return ({ '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.zip': 'application/zip' })[extension] || 'application/octet-stream';
}
function mapAssetRow(row) {
  const [id, name, relativePath, mimeType, sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative] = row;
  return {
    id,
    name,
    relativePath,
    mimeType,
    sizeBytes,
    createdAt,
    conversationId,
    employeeId,
    runId,
    sha256,
    projectId: projectId || null,
    workspaceRelative: workspaceRelative || name || null,
  };
}
function assetRows(result) { return (result[0]?.values || []).map((row) => mapAssetRow(row)); }
const ASSET_SELECT = 'SELECT id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative FROM assets';
function listAssets() { return assetRows(database.exec(`${ASSET_SELECT} ORDER BY created_at DESC`)); }
function archiveArtifact(value) {
  const runId = String(value?.runId || '');
  const relativePath = String(value?.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^[a-f0-9-]{20,}$/i.test(runId) || !relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid artifact location.');
  // Intermediate generators / caches must never enter the asset library.
  // Intent contract: only files under output/ are business deliverables (any product type, including final .py/.js).
  const processDirs = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);
  const neverExt = new Set(['pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map']);
  const parts = relativePath.split('/');
  const base = parts[parts.length - 1] || '';
  const ext = path.extname(base).slice(1).toLowerCase();
  if (parts[0] !== 'output' || parts.length < 2 || parts.some((part) => processDirs.has(part)) || !ext || neverExt.has(ext) || (base.startsWith('.') && base !== '.gitkeep')) {
    throw new Error('Only business deliverables under output/ can be archived to the asset library.');
  }
  const workspaceRoot = path.resolve(storageRoot(), 'workspaces', runId);
  const source = path.resolve(workspaceRoot, relativePath);
  if (!source.startsWith(`${workspaceRoot}${path.sep}`) || !existsSync(source) || !statSync(source).isFile()) throw new Error('Generated artifact is no longer available.');
  const name = path.basename(source);
  const sizeBytes = statSync(source).size;
  if (sizeBytes > 100 * 1024 * 1024) throw new Error('Generated artifact exceeds the 100 MB asset limit.');
  const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
  // Idempotent: same run + path + content must not create duplicate asset cards.
  const existing = assetRows(database.exec(
    `${ASSET_SELECT} WHERE run_id = ? AND workspace_relative = ? AND sha256 = ? LIMIT 1`,
    [runId, relativePath, sha256],
  ))[0];
  if (existing) return existing;
  const id = randomUUID();
  const targetFolder = path.join(storageRoot(), 'assets', id);
  mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
  const target = path.join(targetFolder, name);
  copyFileSync(source, target, 0);
  const relativeAssetPath = path.relative(storageRoot(), target).split(path.sep).join('/');
  const createdAt = Date.now();
  const projectId = String(value?.projectId || '').trim() || null;
  const workspaceRelative = relativePath;
  const conversationId = String(value?.conversationId || '') || null;
  const employeeId = String(value?.employeeId || '') || null;
  database.run(
    'INSERT INTO assets (id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, relativeAssetPath, assetMimeType(name), sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative],
  );
  flushDatabase();
  return { id, name, relativePath: relativeAssetPath, mimeType: assetMimeType(name), sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative };
}
function assetFile(assetId) {
  const row = assetRows(database.exec(`${ASSET_SELECT} WHERE id = ?`, [String(assetId)]))[0];
  if (!row) throw new Error('Asset not found.');
  const target = path.resolve(storageRoot(), row.relativePath);
  if (!target.startsWith(`${path.resolve(storageRoot(), 'assets')}${path.sep}`) || !existsSync(target)) throw new Error('Asset file is unavailable.');
  return { row, target };
}

function linkAssetsToProject(value) {
  const projectId = String(value?.projectId || '').trim();
  const assetIds = Array.isArray(value?.assetIds) ? value.assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  if (!projectId) throw new Error('projectId is required.');
  if (!assetIds.length) return { updated: 0, copied: 0 };
  let updated = 0;
  for (const assetId of assetIds) {
    database.run('UPDATE assets SET project_id = ? WHERE id = ?', [projectId, assetId]);
    updated += 1;
  }
  flushDatabase();
  let copied = 0;
  const workspacePath = String(value?.workspacePath || '').trim();
  if (workspacePath) {
    const root = projectRoot(workspacePath);
    for (const assetId of assetIds) {
      try {
        const { row, target: source } = assetFile(assetId);
        const relative = String(row.workspaceRelative || row.name).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) continue;
        const dest = projectPath(root, relative);
        mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        copyFileSync(source, dest, 0);
        copied += 1;
      } catch (_) { /* Keep linking even if one file copy fails. */ }
    }
  }
  return { updated, copied, projectId };
}

function unlinkAssetsFromProject(assetIds) {
  const ids = Array.isArray(assetIds) ? assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  let updated = 0;
  for (const assetId of ids) {
    database.run('UPDATE assets SET project_id = NULL WHERE id = ?', [assetId]);
    updated += 1;
  }
  flushDatabase();
  return { updated };
}

function safeProjectFolderName(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/gi, '-').replace(/(^-|-$)/g, '').slice(0, 64) || 'project'; }
function projectRoot(folder) { const root = path.resolve(String(folder || '')); if (!root || root === path.parse(root).root) throw new Error('Invalid project workspace.'); return root; }
function projectPath(root, relative) { const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, ''); if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid project file path.'); const target = path.resolve(projectRoot(root), normalized); if (!target.startsWith(`${projectRoot(root)}${path.sep}`)) throw new Error('Project file is outside its workspace.'); return target; }
function createProjectWorkspace(value) {
  const parent = value?.parentDirectory ? path.resolve(String(value.parentDirectory)) : path.join(storageRoot(), 'projects');
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const folder = `${safeProjectFolderName(value?.name)}-${randomUUID().slice(0, 8)}`;
  const root = path.join(parent, folder);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
function listProjectFiles(root, directory = projectRoot(root), relative = '', depth = 0, result = []) {
  if (depth > 8 || !existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.python-packages') continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { result.push({ relative: childRelative, type: 'directory' }); listProjectFiles(root, target, childRelative, depth + 1, result); }
    else if (entry.isFile() && statSync(target).size <= 8 * 1024 * 1024) result.push({ relative: childRelative, type: 'file' });
  }
  return result;
}
function readProjectFile(root, relative) { const file = projectPath(root, relative); if (!existsSync(file) || !statSync(file).isFile()) throw new Error('Project file is unavailable.'); return { relative, content: readFileSync(file, 'utf8') }; }
function writeProjectFile(root, relative, content) { const file = projectPath(root, relative); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, String(content), { mode: 0o600 }); return { relative, content: String(content) }; }
// 只把真正交付给用户的文件同步进项目目录；中间过渡脚本/产物留在运行工作区。
const DELIVERABLE_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'md', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'json', 'pdf', 'txt', 'csv', 'ico', 'woff', 'woff2', 'ttf']);
// 运行中间件/脚本/模板目录：这些内容不进入项目目录。
const INTERMEDIATE_DIRS = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);
function isDeliverablePath(from) {
  const base = path.basename(from);
  if (INTERMEDIATE_DIRS.has(base)) return false;
  if (['.DS_Store', '.git'].includes(base)) return false;
  const parts = from.split(path.sep);
  if (parts.some((part) => INTERMEDIATE_DIRS.has(part))) return false;
  if (String(base).startsWith('.') && base !== '.gitkeep') return false;
  // cpSync：对目录返回 false 会跳过整棵子树（含根目录），必须允许目录遍历。
  try {
    if (existsSync(from) && statSync(from).isDirectory()) return true;
  } catch { /* treat as file below */ }
  const ext = path.extname(base).slice(1).toLowerCase();
  // 脚本/源文件属于中间件，不进项目目录。
  if (['py', 'sh', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'map'].includes(ext)) return false;
  return DELIVERABLE_EXT.has(ext);
}

/** 编排层 runId 与 agent-core 实际工作区目录可能不一致；从 RunRecord.eventLog 解析真实 workspace id。 */
function resolveWorkspaceRunIds(runId) {
  const ids = new Set([String(runId)]);
  try {
    const domainPath = path.join(storageRoot(), 'domain.json');
    if (!existsSync(domainPath)) return [...ids];
    const domain = JSON.parse(readFileSync(domainPath, 'utf8'));
    const raw = domain?.kv?.[`run:${runId}`];
    if (!raw) return [...ids];
    const run = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const event of Array.isArray(run?.eventLog) ? run.eventLog : []) {
      if (event && typeof event.runId === 'string' && event.runId.trim()) ids.add(event.runId.trim());
    }
  } catch { /* best-effort recovery */ }
  return [...ids];
}

function syncRunWorkspaceToProject(root, runId) {
  const target = projectRoot(root);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const id of resolveWorkspaceRunIds(runId)) {
    const source = path.join(storageRoot(), 'workspaces', String(id));
    if (!existsSync(source) || !statSync(source).isDirectory()) continue;
    cpSync(source, target, {
      recursive: true,
      filter: (from) => isDeliverablePath(from),
    });
  }
  return listProjectFiles(target);
}
function materializeProjectAssets(root, assetIds) {
  const targetRoot = projectRoot(root);
  const ids = Array.isArray(assetIds) ? assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  for (const assetId of ids) {
    try {
      const { row, target: source } = assetFile(assetId);
      const relative = String(row.workspaceRelative || row.name).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) continue;
      const dest = projectPath(targetRoot, relative);
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      copyFileSync(source, dest, 0);
    } catch (_) { /* Skip missing assets so one failure does not block the tree. */ }
  }
  return listProjectFiles(root);
}

function registerPreviewRoot(root) {
  const resolved = projectRoot(root);
  for (const [token, existing] of previewRoots.entries()) {
    if (existing === resolved) return { token, origin: `workmate-preview://${token}` };
  }
  const token = randomUUID().replace(/-/g, '').slice(0, 16);
  previewRoots.set(token, resolved);
  return { token, origin: `workmate-preview://${token}` };
}

function revealProjectFile(root, relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    const folder = projectRoot(root);
    if (!existsSync(folder)) throw new Error('Project workspace is unavailable.');
    void shell.openPath(folder);
    return true;
  }
  const file = projectPath(root, normalized);
  if (!existsSync(file)) throw new Error('Project file is unavailable.');
  shell.showItemInFolder(file);
  return true;
}

function previewBinaryLimit(name) {
  if (/\.pdf$/i.test(name)) return 40 * 1024 * 1024;
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name) ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
}

function readProjectPreview(root, relative) {
  const file = projectPath(root, relative);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error('Project file is unavailable.');
  const name = path.basename(file);
  const size = statSync(file).size;
  if (size > previewBinaryLimit(name)) throw new Error('File is too large to preview.');
  const textLike = /\.(md|markdown|txt|html?|css|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|xml|svg|csv)$/i.test(name);
  if (textLike) {
    return { kind: 'text', name, relative: safePreviewRelative(relative), content: readFileSync(file, 'utf8'), bytes: size };
  }
  return { kind: 'binary', name, relative: safePreviewRelative(relative), base64: readFileSync(file).toString('base64'), bytes: size };
}

function safePreviewRelative(relative) {
  return String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function readAssetPreview(assetId) {
  const { row, target } = assetFile(assetId);
  const size = statSync(target).size;
  if (size > previewBinaryLimit(row.name)) throw new Error('File is too large to preview.');
  const textLike = /\.(md|markdown|txt|html?|css|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|xml|svg|csv)$/i.test(row.name);
  if (textLike) {
    return { kind: 'text', name: row.name, mimeType: row.mimeType, content: readFileSync(target, 'utf8'), bytes: size };
  }
  return { kind: 'binary', name: row.name, mimeType: row.mimeType, base64: readFileSync(target).toString('base64'), bytes: size };
}

function registerAssetPreviewRoot(assetId) {
  const { target } = assetFile(assetId);
  return registerPreviewRoot(path.dirname(target));
}

/** Open a local file with the OS default app (no temp HTTP server). */
async function openAbsolutePathInBrowser(absolutePath) {
  const file = path.resolve(String(absolutePath || ''));
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error('File is unavailable.');
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
  return { ok: true, url: pathToFileURL(file).href };
}

function openAssetInBrowser(assetId) {
  const { target } = assetFile(assetId);
  return openAbsolutePathInBrowser(target);
}

function openProjectFileInBrowser(root, relative) {
  return openAbsolutePathInBrowser(projectPath(root, relative));
}

function readModelConfig() {
  try {
    const stored = getStoredValue('model-settings');
    if (!stored) return {};
    const config = JSON.parse(stored);
    if (Array.isArray(config.providerInstances)) {
      config.providerInstances = config.providerInstances.map((provider) => ({
        ...provider,
        apiKey: provider.apiKey && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(provider.apiKey, 'base64'))
          : provider.apiKey || '',
      }));
      return config;
    }
    if (Array.isArray(config.providers)) {
      config.providers = config.providers.map((provider) => ({
        ...provider,
        apiKey: provider.apiKey && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(provider.apiKey, 'base64'))
          : provider.apiKey || '',
      }));
    } else if (config.apiKey && safeStorage.isEncryptionAvailable()) {
      config.apiKey = safeStorage.decryptString(Buffer.from(config.apiKey, 'base64'));
    }
    return config;
  } catch (_) { return {}; }
}

function writeModelConfig(value) {
  if (Number(value?.version) === 2 || Array.isArray(value?.providerInstances)) {
    const config = {
      version: 2,
      providerInstances: Array.isArray(value?.providerInstances)
        ? value.providerInstances.map((provider) => ({
            id: String(provider.id || ''),
            type: String(provider.type || ''),
            name: String(provider.name || ''),
            baseUrl: String(provider.baseUrl || ''),
            apiKey: String(provider.apiKey || ''),
            disableThinking: Boolean(provider.disableThinking),
          }))
        : [],
      models: Array.isArray(value?.models)
        ? value.models.map((model) => ({
            id: String(model.id || ''),
            providerInstanceId: String(model.providerInstanceId || ''),
            capability: String(model.capability || 'chat'),
            modelId: String(model.modelId || ''),
            label: model.label ? String(model.label) : undefined,
            supportsBuiltinWebSearch: Boolean(model.supportsBuiltinWebSearch) || undefined,
          }))
        : [],
      activeChatModelId: value?.activeChatModelId ? String(value.activeChatModelId) : null,
      employeeDefaultModelIds: value?.employeeDefaultModelIds && typeof value.employeeDefaultModelIds === 'object'
        ? Object.fromEntries(Object.entries(value.employeeDefaultModelIds).map(([key, modelId]) => [String(key), String(modelId)]))
        : {},
    };
    const persisted = {
      ...config,
      providerInstances: config.providerInstances.map((provider) => ({
        ...provider,
        apiKey: provider.apiKey && safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(provider.apiKey).toString('base64')
          : provider.apiKey,
      })),
    };
    setStoredValue('model-settings', JSON.stringify(persisted));
    pushSecretsToApi();
    return config;
  }
  const config = {
    activeProvider: String(value?.activeProvider || 'openai'),
    providers: Array.isArray(value?.providers)
      ? value.providers.map((provider) => ({
          provider: String(provider.provider || ''),
          baseUrl: String(provider.baseUrl || ''),
          chatModel: String(provider.chatModel || ''),
          chatModels: Array.isArray(provider.chatModels) ? provider.chatModels.map((item) => String(item)) : [],
          disableThinking: Boolean(provider.disableThinking),
          imageModel: String(provider.imageModel || ''),
          embeddingModel: String(provider.embeddingModel || ''),
          asrModel: String(provider.asrModel || ''),
          ttsModel: String(provider.ttsModel || ''),
          apiKey: String(provider.apiKey || ''),
        }))
      : [],
  };
  const persisted = {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey && safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(provider.apiKey).toString('base64')
        : provider.apiKey,
    })),
  };
  setStoredValue('model-settings', JSON.stringify(persisted));
  pushSecretsToApi();
  return config;
}

function readSearchConfig() {
  try {
    const stored = getStoredValue('search-settings'); if (!stored) return {};
    const config = JSON.parse(stored);
    config.providers = Array.isArray(config.providers) ? config.providers.map((provider) => ({ ...provider, apiKey: provider.apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(provider.apiKey, 'base64')) : provider.apiKey || '' })) : [];
    return config;
  } catch (_) { return {}; }
}
function writeSearchConfig(value) {
  const allowed = new Set(['bocha', 'tavily', 'brave', 'exa', 'zhipu', 'aliyun']);
  const config = { version: 1, defaultProvider: allowed.has(String(value?.defaultProvider)) ? String(value.defaultProvider) : 'auto', providers: Array.isArray(value?.providers) ? value.providers.filter((provider) => allowed.has(String(provider?.id))).map((provider) => ({ id: String(provider.id), label: String(provider.label || provider.id), apiKey: String(provider.apiKey || ''), baseUrl: String(provider.baseUrl || ''), enabled: Boolean(provider.enabled) })) : [] };
  const persisted = { ...config, providers: config.providers.map((provider) => ({ ...provider, apiKey: provider.apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(provider.apiKey).toString('base64') : provider.apiKey })) };
  setStoredValue('search-settings', JSON.stringify(persisted));
  pushSecretsToApi();
  return config;
}

/* ------------------------------------------------------------------ *
 * M2: channel/connection settings (P1)
 * Meta (enabled/allowlist/defaults) → orchestrator KV channels.v1.
 * Secrets (tokens) → main-process sql.js key settings.channels.v1
 * encrypted via safeStorage; released to children only over fork IPC.
 * ------------------------------------------------------------------ */

function channelEncrypt(value) {
  if (!value) return '';
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(String(value)).toString('base64') : String(value);
}
function channelDecrypt(encoded) {
  if (!encoded) return '';
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(String(encoded), 'base64')) : String(encoded);
  } catch (_) { return String(encoded || ''); }
}

function readChannelSecrets() {
  try {
    const raw = JSON.parse(getStoredValue('settings.channels.v1') || '{}');
    const secrets = raw?.secrets && typeof raw.secrets === 'object' ? raw.secrets : {};
    return {
      telegram: { botToken: channelDecrypt(secrets.telegram?.botToken) },
      feishu: { appSecret: channelDecrypt(secrets.feishu?.appSecret) },
      relay: { token: channelDecrypt(secrets.relay?.token) },
    };
  } catch (_) {
    return { telegram: { botToken: '' }, feishu: { appSecret: '' }, relay: { token: '' } };
  }
}

function writeChannelSecrets(tokens) {
  const secrets = {
    telegram: { botToken: channelEncrypt(tokens?.telegram?.botToken) },
    feishu: { appSecret: channelEncrypt(tokens?.feishu?.appSecret) },
    relay: { token: channelEncrypt(tokens?.relay?.token) },
  };
  setStoredValue('settings.channels.v1', JSON.stringify({ version: 1, secrets, updatedAt: Date.now() }));
}

function cleanChannelMeta(value) {
  const source = value && typeof value === 'object' ? value : {};
  const channels = source.channels && typeof source.channels === 'object' ? source.channels : {};
  const telegram = channels.telegram && typeof channels.telegram === 'object' ? channels.telegram : {};
  const feishu = channels.feishu && typeof channels.feishu === 'object' ? channels.feishu : {};
  const relay = channels.relay && typeof channels.relay === 'object' ? channels.relay : {};
  const allowlist = Array.isArray(source.allowlist) ? source.allowlist.map((entry) => String(entry).trim()).filter(Boolean) : [];
  return {
    version: 1,
    defaultEmployeeId: String(source.defaultEmployeeId || 'general'),
    channels: {
      telegram: { enabled: Boolean(telegram.enabled) },
      feishu: {
        enabled: Boolean(feishu.enabled),
        ...(String(feishu.appId || '').trim() ? { appId: String(feishu.appId).trim() } : {}),
      },
      relay: {
        enabled: Boolean(relay.enabled),
        ...(String(relay.baseUrl || '').trim() ? { baseUrl: String(relay.baseUrl).trim() } : {}),
        ...(String(relay.deviceId || '').trim() ? { deviceId: String(relay.deviceId).trim() } : {}),
      },
    },
    ...(allowlist.length ? { allowlist } : {}),
  };
}

async function getChannelSettings() {
  let meta = {};
  try {
    const raw = await apiKvGet('channels.v1');
    meta = raw ? JSON.parse(raw) : {};
  } catch { /* not configured */ }
  return { meta, secrets: readChannelSecrets() };
}

async function saveChannelSettings(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const meta = cleanChannelMeta(source.meta);
  const secretsIn = source.secrets && typeof source.secrets === 'object' ? source.secrets : {};
  writeChannelSecrets({
    telegram: { botToken: secretsIn.telegram?.botToken },
    feishu: { appSecret: secretsIn.feishu?.appSecret },
    relay: { token: secretsIn.relay?.token },
  });
  await apiKvSet('channels.v1', JSON.stringify(meta));
  return { ok: true, meta };
}

function gatewayStatus() {
  return {
    running: Boolean(gatewayProcess && !gatewayProcess.killed && gatewayProcess.exitCode === null),
    pid: gatewayProcess && !gatewayProcess.killed ? gatewayProcess.pid : null,
  };
}

async function gatewayRestart() {
  if (gatewayProcess && !gatewayProcess.killed) {
    gatewayProcess.kill('SIGTERM');
    gatewayProcess = null;
  }
  await startGatewayIfEnabled().catch((error) => console.warn('[gateway] restart failed:', error));
  return gatewayStatus();
}

async function testProviderConnection(value) {
  const type = String(value?.type || '');
  const baseUrl = String(value?.baseUrl || '').trim();
  const apiKey = String(value?.apiKey || '').trim();
  if (type === 'ollama') {
    const root = (baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const payload = await response.json();
    const count = Array.isArray(payload.models) ? payload.models.length : 0;
    return { ok: true, message: `已连接 Ollama，发现 ${count} 个本地模型。` };
  }
  if (type === 'anthropic') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const response = await fetch(`${root}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Anthropic 返回 ${response.status}`);
    return { ok: true, message: 'Anthropic 连接成功。' };
  }
  if (type === 'google') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const response = await fetch(`${root}/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Google 返回 ${response.status}`);
    return { ok: true, message: 'Google 连接成功。' };
  }
  // OpenAI-compatible: openai / deepseek / qwen / openai-compatible
  if (!baseUrl) throw new Error('请填写 API 地址');
  if (type !== 'ollama' && !apiKey) throw new Error('请填写 API Key');
  const root = baseUrl.replace(/\/$/, '');
  const response = await fetch(`${root}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`接口返回 ${response.status}`);
  const payload = await response.json();
  const count = Array.isArray(payload?.data) ? payload.data.length : 0;
  return { ok: true, message: count ? `连接成功，接口返回 ${count} 个模型。` : '连接成功。' };
}

async function listProviderModels(value) {
  const type = String(value?.type || '');
  const baseUrl = String(value?.baseUrl || '').trim();
  const apiKey = String(value?.apiKey || '').trim();
  if (type === 'ollama') {
    const root = (baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const payload = await response.json();
    return (payload.models ?? []).map((item) => String(item.name || '')).filter(Boolean);
  }
  if (type === 'anthropic') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const response = await fetch(`${root}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Anthropic 返回 ${response.status}`);
    const payload = await response.json();
    return (payload.data ?? []).map((item) => String(item.id || '')).filter(Boolean);
  }
  if (type === 'google') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const response = await fetch(`${root}/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Google 返回 ${response.status}`);
    const payload = await response.json();
    return (payload.models ?? [])
      .map((item) => String(item.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  if (!baseUrl) throw new Error('请填写 API 地址');
  const root = baseUrl.replace(/\/$/, '');
  const response = await fetch(`${root}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`接口返回 ${response.status}`);
  const payload = await response.json();
  return (payload.data ?? []).map((item) => String(item.id || '')).filter(Boolean);
}

function safeSkillName(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 64); }
function normalizeSkillSource(value) {
  const source = String(value || '').trim();
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/.test(source)) return source;
  try {
    const url = new URL(source);
    if (url.protocol === 'https:' && /(^|\.)(github\.com|gitlab\.com|gitee\.com)$/i.test(url.hostname)) return url.toString().replace(/\.git$/, '');
  } catch (_) { /* invalid source */ }
  throw new Error('Enter a skill reference or an HTTPS GitHub, GitLab, or Gitee repository URL.');
}
function readSkillManifest(file) {
  if (!file || path.basename(file).toLowerCase() !== 'skill.md') throw new Error('Please choose a SKILL.md file.');
  const content = readFileSync(file, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || !/^name:\s*.+/m.test(match[1]) || !/^description:\s*.+/m.test(match[1])) throw new Error('SKILL.md must include name and description frontmatter.');
  return { path: file, content };
}
function manifestName(content) {
  const raw = content.match(/^name:\s*(.+)$/mi)?.[1]?.trim() || '';
  return safeSkillName(raw.replace(/^['"]|['"]$/g, ''));
}
function findSkillManifests(directory, depth = 0, matches = []) {
  if (depth > 5) return matches;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) findSkillManifests(target, depth + 1, matches);
    else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') matches.push(readSkillManifest(target));
  }
  return matches;
}
function withoutAnsi(value) { return String(value || '').replace(/\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -\/]*[@-~])/g, '').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\s{2,}/g, ' ').trim(); }
function skillsSearchError(value) {
  const clean = withoutAnsi(value).replace(/[^\p{L}\p{N}\s:.,/@_\-()[\]]/gu, '').slice(-500);
  return clean ? `Skills.sh 搜索暂不可用：${clean}` : 'Skills.sh 搜索暂不可用。请稍后重试，或直接在 skills.sh 浏览技能。';
}
function registryResults(output) {
  const lines = withoutAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([^\s]+\/[^\s@]+@[^\s]+)\s+([\d.]+[KMB]?)\s+installs$/i);
    if (!match) continue;
    const reference = match[1];
    const [source, slug] = reference.split('@');
    const next = lines[index + 1]?.replace(/^└\s*/, '');
    items.push({ reference, source, slug, name: slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), description: '', installs: match[2], url: /^https:\/\//.test(next || '') ? next : `https://skills.sh/${source}/${slug}` });
  }
  return items;
}
async function enrichRegistryItem(item) {
  try {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return item;
    const html = await response.text();
    const encoded = html.match(/"description":"((?:\\.|[^"\\])+)"/)?.[1];
    const description = encoded ? JSON.parse(`"${encoded}"`) : '';
    return { ...item, description: String(description).trim().slice(0, 420) };
  } catch (_) { return item; }
}
function findManifest(directory, skillName) {
  const { readdirSync } = require('node:fs');
  const visit = (folder, depth) => {
    if (depth > 5) return null;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) { const found = visit(target, depth + 1); if (found) return found; }
      else if (entry.isFile() && entry.name === 'SKILL.md') {
        const manifest = readSkillManifest(target);
        if (!skillName || new RegExp(`^name:\\s*${skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(manifest.content)) return manifest;
      }
    }
    return null;
  };
  return visit(directory, 0);
}
function runSkillsCli(reference) {
  const source = normalizeSkillSource(reference);
  const skillsDirectory = path.join(storageRoot(), 'skills');
  mkdirSync(skillsDirectory, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => execFile(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['skills', 'add', source, '--yes'], { cwd: skillsDirectory, timeout: 120000, windowsHide: true }, (error, stdout, stderr) => {
    if (error) return reject(new Error(withoutAnsi(stderr || stdout || error.message).slice(-2000)));
    const manifest = findManifest(skillsDirectory, source.includes('@') ? source.split('@').pop() : null);
    resolve({ manifest, output: withoutAnsi(stdout || stderr).slice(-1000) });
  }));
}
async function importGitSkillRepository(value) {
  const source = normalizeSkillSource(value);
  if (!source.startsWith('https://')) throw new Error('Use an HTTPS Git repository URL.');
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'workmate-skill-'));
  const checkout = path.join(temporaryRoot, 'repository');
  try {
    await new Promise((resolve, reject) => execFile('git', ['clone', '--depth', '1', source, checkout], { timeout: 120000, windowsHide: true }, (error, _stdout, stderr) => error ? reject(new Error(`Unable to clone repository: ${String(stderr || error.message).slice(-1200)}`)) : resolve()));
    const imported = [];
    const skipped = [];
    for (const manifest of findSkillManifests(checkout)) {
      const name = manifestName(manifest.content);
      if (!name) { skipped.push(path.dirname(manifest.path)); continue; }
      const targetFolder = path.join(storageRoot(), 'skills', name);
      const target = path.join(targetFolder, 'SKILL.md');
      if (existsSync(target)) { skipped.push(name); continue; }
      mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
      writeFileSync(target, manifest.content, { mode: 0o600 });
      // A portable skill commonly references one of these sibling folders.
      // Copy only declared resource locations rather than the entire repository.
      for (const resource of ['scripts', 'references', 'assets', 'agents']) {
        const sourceFolder = path.join(path.dirname(manifest.path), resource);
        if (existsSync(sourceFolder)) cpSync(sourceFolder, path.join(targetFolder, resource), { recursive: true, force: false });
      }
      imported.push(readSkillManifest(target));
    }
    if (!imported.length) throw new Error('No new valid SKILL.md file was found in this repository.');
    return { manifests: imported, skipped };
  } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
}
function writeSkillDraft(value) {
  const name = safeSkillName(value?.name);
  const content = String(value?.content || '');
  if (!name || content.length < 40 || content.length > 100000) throw new Error('Invalid skill draft.');
  if (!/^---\r?\n[\s\S]*?^name:\s*[^\r\n]+[\s\S]*?^description:\s*[^\r\n]+[\s\S]*?^---/m.test(content)) throw new Error('A skill draft must contain name and description frontmatter.');
  const folder = path.join(storageRoot(), 'skills', name);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, 'SKILL.md');
  writeFileSync(file, content, { mode: 0o600 });
  return readSkillManifest(file);
}
function readSkillDraft(file) {
  const root = path.resolve(storageRoot(), 'skills') + path.sep;
  const target = path.resolve(String(file || ''));
  if (!target.startsWith(root) || path.basename(target) !== 'SKILL.md') throw new Error('Skill file is outside the managed local skill library.');
  return readSkillManifest(target);
}
function managedSkillPath(file) {
  const root = path.resolve(storageRoot(), 'skills') + path.sep;
  const target = path.resolve(String(file || ''));
  if (!target.startsWith(root)) throw new Error('Skill file is outside the managed local skill library.');
  return target;
}
function listSkillFiles(file) {
  const root = path.dirname(managedSkillPath(file));
  const entries = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const target = path.join(folder, entry.name);
      const relative = path.relative(root, target);
      entries.push({ path: target, relative, type: entry.isDirectory() ? 'directory' : 'file' });
      if (entry.isDirectory()) visit(target);
    }
  };
  if (existsSync(root)) visit(root);
  return entries;
}
function readManagedSkillFile(file) { const target = managedSkillPath(file); return { path: target, content: readFileSync(target, 'utf8') }; }
function writeManagedSkillFile(file, content) {
  const target = managedSkillPath(file);
  if (String(content || '').length > 100000) throw new Error('Skill file is too large.');
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, String(content || ''), { mode: 0o600 });
  return { path: target, content: String(content || '') };
}
function deleteManagedSkill(file) {
  const root = path.resolve(storageRoot(), 'skills') + path.sep;
  const target = path.resolve(String(file || ''));
  if (!target.startsWith(root) || path.basename(target) !== 'SKILL.md') return false;
  rmSync(path.dirname(target), { recursive: true, force: true });
  return true;
}
function findSkills(query) {
  const value = String(query || '').trim();
  if (!value || value.length > 120) throw new Error('Enter a short skill search query.');
  return (async () => {
    let response;
    try { response = await fetch(`https://skills.sh/api/search?${new URLSearchParams({ q: value, limit: '20' })}`, { signal: AbortSignal.timeout(15000) }); }
    catch (cause) { throw new Error(skillsSearchError(cause instanceof Error ? cause.message : String(cause))); }
    if (!response.ok) throw new Error(`Skills.sh 搜索暂不可用（HTTP ${response.status}）。请稍后重试或在 skills.sh 浏览。`);
    const data = await response.json();
    const rawSkills = Array.isArray(data?.skills) ? data.skills : [];
    const items = await Promise.all(rawSkills.map((skill) => {
      const source = String(skill?.source || ''); const name = String(skill?.name || ''); const slug = String(skill?.id || ''); const installs = Number(skill?.installs || 0);
      const formattedInstalls = installs >= 1_000_000 ? `${(installs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : installs >= 1_000 ? `${(installs / 1_000).toFixed(1).replace(/\.0$/, '')}K` : installs ? String(installs) : '';
      return enrichRegistryItem({ reference: source && name ? `${source}@${name}` : slug, source, slug, name: name || slug.split('/').pop() || 'Skill', description: '', installs: formattedInstalls, url: `https://skills.sh/${slug}` });
    }));
    return { items, hasMore: false };
  })();
}

function apiEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'api', 'main.cjs')
    : path.resolve(__dirname, '../../../api/dist/main.cjs');
}

const orchestratorApiBase = () => `http://127.0.0.1:${apiPort}/api/orch`;

/**
 * M0 domain-storage unification: the API process is the single writer of
 * domain KV (employees/skills/policies/sessions/projects/...). The renderer's
 * existing `storageGet/storageSet` IPC handlers are forwarded to the
 * orchestrator's KV endpoint; secrets (model/search settings) stay in the
 * main-process store behind safeStorage and are never migrated.
 */
async function apiKvGet(key) {
  try {
    const response = await fetch(`${orchestratorApiBase()}/kv?key=${encodeURIComponent(String(key))}`, {
      headers: { 'x-workmate-internal': apiInternalToken },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.value ?? null;
  } catch {
    return getStoredValue(String(key)); // degrade to the legacy sql.js store
  }
}

async function apiKvSet(key, value) {
  try {
    const response = await fetch(`${orchestratorApiBase()}/kv`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-workmate-internal': apiInternalToken,
      },
      body: JSON.stringify({ key: String(key), value: String(value) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`orchestrator kv ${response.status}`);
  } catch {
    setStoredValue(String(key), String(value)); // degrade to the legacy sql.js store
  }
}

async function migrateDomainKvToApi() {
  const marker = 'kv.api.migrated.v1';
  if (getStoredValue(marker)) return 0;
  const rows = database.exec('SELECT key, value FROM app_kv');
  const skip = new Set(['model-settings', 'search-settings']);
  let migrated = 0;
  for (const row of rows[0]?.values || []) {
    const key = String(row[0]);
    const value = String(row[1] ?? '');
    if (skip.has(key)) continue;
    const existing = await apiKvGet(key);
    if (existing == null) {
      await apiKvSet(key, value);
      migrated += 1;
    }
  }
  setStoredValue(marker, String(Date.now()));
  return migrated;
}

function pushSecretsToApi() {
  if (!apiProcess || apiProcess.killed) return;
  try {
    apiProcess.send?.({
      type: 'workmate:secrets',
      payload: { model: readModelConfig(), search: readSearchConfig() },
    });
  } catch (_) {
    /* child may not be ready yet */
  }
}

function bundledAgentscopeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'agentscope-runtime')
    : path.resolve(__dirname, '../../../../runtimes/agentscope-runtime');
}

function bundledAgentscopePython(runtimeRoot = bundledAgentscopeRoot()) {
  if (process.env.WORKMATE_AGENTSCOPE_PYTHON?.trim()) return process.env.WORKMATE_AGENTSCOPE_PYTHON.trim();
  const candidates = process.platform === 'win32'
    ? [
        path.join(runtimeRoot, '.venv', 'Scripts', 'python.exe'),
        path.join(runtimeRoot, 'python', 'python.exe'),
      ]
    : [
        path.join(runtimeRoot, '.venv', 'bin', 'python3'),
        path.join(runtimeRoot, 'python', 'bin', 'python3'),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'python3';
}

function startApi() {
  const agentscopeRoot = process.env.WORKMATE_AGENTSCOPE_ROOT || bundledAgentscopeRoot();
  apiProcess = fork(apiEntry(), [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WORKMATE_API_PORT: String(apiPort),
      WORKMATE_INTERNAL_TOKEN: apiInternalToken,
      WORKMATE_DATA_DIR: storageRoot(),
      WORKMATE_SKILLS_DIR: path.join(storageRoot(), 'skills'),
      WORKMATE_WORKSPACES_DIR: path.join(storageRoot(), 'workspaces'),
      WORKMATE_KNOWLEDGE_DIR: path.join(storageRoot(), 'knowledge'),
      WORKMATE_EXPERIENCE_DIR: path.join(storageRoot(), 'experience'),
      WORKMATE_AGENT_ENGINE: process.env.WORKMATE_AGENT_ENGINE || 'pi',
      WORKMATE_AGENTSCOPE_ENABLED: process.env.WORKMATE_AGENTSCOPE_ENABLED || '0',
      WORKMATE_AGENTSCOPE_PYTHON: bundledAgentscopePython(agentscopeRoot),
      WORKMATE_AGENTSCOPE_ROOT: agentscopeRoot,
      // The API is unpacked under Resources together with its minimal
      // production dependency closure, not the desktop workspace node_modules.
      ...(app.isPackaged ? { NODE_PATH: path.join(process.resourcesPath, 'api', 'node_deps') } : {}),
    },
    stdio: 'inherit',
  });
  // M0 keyring: the child requests a decrypted snapshot of model and
  // search provider settings over the fork IPC channel. Never persisted.
  // Parent also pushes on spawn / after settings saves so mid-session
  // configuration (common on first run) reaches the API.
  apiProcess.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    const payload = /** @type {{type?: string}} */ (message);
    if (payload.type !== 'workmate:secrets:request') return;
    pushSecretsToApi();
  });
  apiProcess.once('spawn', () => pushSecretsToApi());
  setTimeout(() => pushSecretsToApi(), 300);
  setTimeout(() => pushSecretsToApi(), 1500);
}

function gatewayEntry() {
  // M1 channel gateway child (apps/gateway). Packaged layout is staged later.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'gateway', 'main.js')
    : path.resolve(__dirname, '../../../gateway/dist/main.js');
}

/** Forks the gateway child when channels.v1 has any enabled channel. */
async function startGatewayIfEnabled() {
  let config = null;
  try {
    const raw = await apiKvGet('channels.v1');
    config = raw ? JSON.parse(raw) : null;
  } catch { /* not configured yet */ }
  const channels = config?.channels && typeof config.channels === 'object' ? config.channels : {};
  const enabled = Object.values(channels).some((entry) => Boolean(entry && entry.enabled));
  if (!enabled) {
    console.log('[gateway] disabled (no enabled channel in channels.v1)');
    return;
  }
  gatewayProcess = fork(gatewayEntry(), [], {
    env: {
      ...process.env,
      WORKMATE_API_URL: `http://127.0.0.1:${apiPort}/api/orch`,
    },
    stdio: 'inherit',
  });
  console.log(`[gateway] started pid ${gatewayProcess.pid}`);
  // M2: release decrypted channel credentials to the gateway child on demand.
  gatewayProcess.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    const payload = /** @type {{type?: string}} */ (message);
    if (payload.type !== 'workmate:channels:secrets:request') return;
    gatewayProcess.send?.({
      type: 'workmate:channels:secrets',
      payload: { channels: readChannelSecrets() },
    });
  });
}

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      if (response.ok) return;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Workmate local API did not become ready.');
}

/** Only nudge if the window is completely off every screen; never clamp mid-drag. */
function ensureWindowOnScreen(win) {
  if (!win || win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return;
  const bounds = win.getBounds();
  const displays = screen.getAllDisplays();
  const onScreen = displays.some((display) => {
    const a = display.workArea;
    return bounds.x < a.x + a.width && bounds.x + bounds.width > a.x
      && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y;
  });
  if (onScreen) return;
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({
    x: area.x + 48,
    y: area.y + 48,
    width: Math.min(bounds.width, Math.max(640, area.width - 96)),
    height: Math.min(bounds.height, Math.max(480, area.height - 96)),
  }, false);
}

async function createWindow() {
  await waitForApi();
  // Near work-area size on launch; do not clamp position on every `moved`
  // (that blocks dragging across monitors).
  const workArea = screen.getPrimaryDisplay().workArea;
  const margin = 24;
  const width = Math.max(640, workArea.width - margin * 2);
  const height = Math.max(480, workArea.height - margin * 2);
  mainWindow = new BrowserWindow({
    x: workArea.x + margin,
    y: workArea.y + margin,
    width,
    height,
    minWidth: 640,
    minHeight: 480,
    resizable: true,
    movable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    fullscreen: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // After the user finishes dragging, only rescue a fully off-screen window.
  let settleTimer = null;
  const scheduleEnsureVisible = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => ensureWindowOnScreen(mainWindow), 400);
  };
  mainWindow.on('moved', scheduleEnsureVisible);
  screen.on('display-metrics-changed', scheduleEnsureVisible);
  mainWindow.on('closed', () => {
    if (settleTimer) clearTimeout(settleTimer);
    screen.removeListener('display-metrics-changed', scheduleEnsureVisible);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    console.error(`[renderer] failed to load (${code}): ${description} (${validatedUrl})`);
  });
  mainWindow.webContents.on('console-message', (_event, details) => {
    if (details.level >= 2) console.error(`[renderer] ${details.sourceId}:${details.lineNumber} ${details.message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => console.error(`[renderer] process gone: ${details.reason}`));
  const rendererUrl = process.env.WORKMATE_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else {
    const rendererEntry = app.isPackaged
      ? path.join(app.getAppPath(), 'stage', 'renderer', 'index.html')
      : path.resolve(__dirname, '../../../renderer/dist/index.html');
    await mainWindow.loadFile(rendererEntry);
  }
  // In development, a renderer failure can prevent ready-to-show from firing
  // and leave a hidden process with no visible window. Loading has completed
  // at this point, so show the shell deterministically.
  if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  mainWindow.show();
}

/* ------------------------------------------------------------------ *
 * Environment checks (startup / “环境” page)
 * ------------------------------------------------------------------ */

function execCapture(command, args, timeoutMs = 8000) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (result.error) return null;
    return { code: result.status ?? -1, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
  } catch (_) {
    return null;
  }
}

function semverFirstTwo(text) {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: match[3] ? Number(match[3]) : 0 } : null;
}

function platformLabel() {
  const p = process.platform;
  if (p === 'darwin') return 'macOS';
  if (p === 'win32') return 'Windows';
  if (p === 'linux') return 'Linux';
  return p;
}

/** Detects a usable Python 3 interpreter (python3 / python / py). */
function detectPython() {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    const args = command === 'py' ? ['-3', '--version'] : ['--version'];
    const result = execCapture(command, args, 6000);
    if (result && result.code === 0) {
      const text = `${result.stdout || ''} ${result.stderr || ''}`;
      const version = semverFirstTwo(text);
      if (version) return { command, version };
    }
  }
  return null;
}

function detectBundledAgentscopePython() {
  const runtimeRoot = bundledAgentscopeRoot();
  const candidate = bundledAgentscopePython(runtimeRoot);
  if (!candidate || !existsSync(candidate)) return null;
  const result = execCapture(candidate, ['--version'], 6000);
  if (!result || result.code !== 0) return null;
  const version = semverFirstTwo(`${result.stdout || ''} ${result.stderr || ''}`);
  if (!version) return null;
  return { command: candidate, version, runtimeRoot };
}

async function runEnvironmentChecks(onProgress) {
  const push = (payload) => { try { onProgress?.(payload); } catch (_) { /* ignore */ } };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const isWin = process.platform === 'win32';
  const items = [];

  const begin = async (id, name, required) => { push({ kind: 'start', id, name, required }); await tick(); };
  const finish = async (item) => { items.push(item); push({ kind: 'item', item }); await tick(); };

  // Node.js / Electron（信息性）
  await begin('node', 'Node.js（运行时）', '>= 22');
  const nodeVersion = semverFirstTwo(process.versions.node);
  const nodeOk = nodeVersion && nodeVersion.major >= 22;
  await finish({
    id: 'node', name: 'Node.js（运行时）', status: nodeOk ? 'ok' : 'error', required: '>= 22', found: `v${process.versions.node}`,
    help: nodeOk
      ? '桌面与本地服务依赖 Node 22+ 运行时。'
      : `当前 Node 为 v${process.versions.node}。请安装 Node.js 22+（推荐 22 LTS）后重启应用。\nmacOS: brew install node@22；Windows: winget install OpenJS.NodeJS.LTS 或从 nodejs.org 安装；Linux: 使用 nvm 或发行版源安装 Node 22。`,
  });

  await begin('electron', 'Electron（桌面壳）', '随应用内置');
  await finish({ id: 'electron', name: 'Electron（桌面壳）', status: 'ok', required: '随应用内置', found: `v${process.versions.electron}`, help: 'Electron 随安装包内置，无需单独安装。' });

  // Python 3
  await begin('python', 'Python 3（脚本/依赖安装）', '3.9+（python3/python/py）');
  const python = detectPython();
  const pythonOk = Boolean(python && python.version.major === 3 && python.version.minor >= 9);
  await finish({
    id: 'python', name: 'Python 3（脚本/依赖安装）', status: pythonOk ? 'ok' : 'error', required: '3.9+（命令解析为 python3/python/py）',
    found: python ? `${python.command} v${python.version.major}.${python.version.minor}.${python.version.patch}` : '未检测到可用的 Python 3',
    command: python ? `${python.command} --version` : undefined,
    help: pythonOk
      ? `将使用 ${python.command} 执行 Skill/工作区脚本并用 python -m pip install --target 安装隔离依赖。`
      : isWin
        ? '未找到 Python 3。安装方式：\n  1) Microsoft Store：安装 “Python 3.12”；\n  2) 或 winget install Python.Python.3.12；\n  3) 或 python.org 下载安装器并勾选 “Add python.exe to PATH”。\n安装后请重启本应用。若系统只有 “py” 启动器，我们已自动使用 py -3 探测。'
        : process.platform === 'darwin'
          ? '未找到 Python 3。推荐安装：\n  brew install python@3.12\n安装后请重启本应用（/usr/local/bin 或 /opt/homebrew/bin 需在 PATH）。'
          : '未找到 Python 3。推荐安装：\n  sudo apt update && sudo apt install -y python3 python3-pip（Debian/Ubuntu）\n  或 dnf install python3 python3-pip（Fedora）\n安装后请重启本应用。',
  });

  // pip
  await begin('pip', 'pip（Python 包安装，隔离安装到运行工作区）', '可用（python -m pip）');
  let pipOk = false;
  let pipFound = '未检测到 pip';
  if (python) {
    const args = python.command === 'py' ? ['-3', '-m', 'pip', '--version'] : ['-m', 'pip', '--version'];
    const pip = execCapture(python.command, args, 8000);
    pipOk = Boolean(pip && pip.code === 0);
    pipFound = pipOk ? `${python.command} -m pip` : '未检测到 pip（python -m pip 失败）';
  }
  await finish({
    id: 'pip', name: 'pip（Python 包安装，隔离安装到运行工作区）', status: pipOk ? 'ok' : 'error', required: '可用（python -m pip）', found: pipFound,
    help: pipOk
      ? '将以 python -m pip install --target 把依赖安装到每次运行的隔离工作区，不改系统 Python。'
      : pythonOk
        ? '检测到 Python 但 pip 不可用。多数发行版需单独安装：macOS: brew install python@3.12（含 pip）；Debian/Ubuntu: sudo apt install -y python3-pip；Windows: 使用 python.org 安装器（勾选 pip）或 python -m ensurepip。'
        : '需先按上方 Python 指引安装 Python 3（一般自带 pip）。',
  });

  await begin('agentscope-python', 'AgentScope Python Runtime', '随应用内置或系统 Python 3.10+');
  const bundledAgentscope = detectBundledAgentscopePython();
  const agentscopePython = bundledAgentscope ?? python;
  const agentscopeOk = Boolean(agentscopePython && agentscopePython.version.major === 3 && agentscopePython.version.minor >= 10);
  await finish({
    id: 'agentscope-python',
    name: 'AgentScope Python Runtime',
    status: agentscopeOk ? 'ok' : 'error',
    required: '>= 3.10（优先使用应用内置 Runtime）',
    found: bundledAgentscope
      ? `内置 ${bundledAgentscope.command} v${bundledAgentscope.version.major}.${bundledAgentscope.version.minor}.${bundledAgentscope.version.patch}`
      : agentscopePython
        ? `${agentscopePython.command} v${agentscopePython.version.major}.${agentscopePython.version.minor}.${agentscopePython.version.patch}`
        : '未检测到 AgentScope 可用 Python',
    command: bundledAgentscope?.command || (agentscopePython ? `${agentscopePython.command} --version` : undefined),
    help: bundledAgentscope
      ? `AgentScope Sidecar 将优先使用应用内置运行时：${bundledAgentscope.runtimeRoot}`
      : agentscopeOk
        ? '未发现应用内置 AgentScope Runtime，将回退到系统 Python 3.10+。如需离线分发，请使用打包命令重新生成安装包。'
        : 'AgentScope 运行时需要 Python 3.10+。开发环境可设置 WORKMATE_AGENTSCOPE_PYTHON，正式安装包建议内置 runtime 后再分发。',
  });

  // git
  await begin('git', 'Git（Skills 仓库导入/克隆）', '可用（git --version）');
  const git = execCapture(isWin ? 'git' : 'git', ['--version'], 5000);
  const gitOk = Boolean(git && git.code === 0);
  await finish({
    id: 'git', name: 'Git（Skills 仓库导入/克隆）', status: gitOk ? 'ok' : 'error', required: '可用（git --version）',
    found: gitOk ? (git.stdout || git.stderr || 'git') : '未检测到 git',
    help: gitOk
      ? '用于从 GitHub/GitLab/Gitee 导入 Skills 仓库。'
      : isWin
        ? '未检测到 git。请从 git-scm.com 下载安装并勾选 “Add to PATH”，安装 Git for Windows 后重启本应用。'
        : process.platform === 'darwin'
          ? '未检测到 git。macOS 首次使用会弹出 “command line developer tools”，或执行：xcode-select --install；也可 brew install git。安装后重启本应用。'
          : '未检测到 git。Debian/Ubuntu: sudo apt install -y git；Fedora: sudo dnf install git。安装后重启本应用。',
  });

  // npx
  await begin('npx', 'npx（Skills 生态安装器）', '可用（随 Node 提供）');
  const npx = execCapture(isWin ? 'npx.cmd' : 'npx', ['--version'], 8000);
  const npxOk = Boolean(npx && npx.code === 0);
  await finish({
    id: 'npx', name: 'npx（Skills 生态安装器）', status: npxOk ? 'ok' : 'warn', required: '可用（随 Node 提供）',
    found: npxOk ? `v${npx.stdout || npx.stderr || ''}`.trim() || 'npx' : '未检测到 npx',
    help: npxOk
      ? '用于 npx skills add … 安装公开 Skill 包。'
      : '未检测到 npx。npx 随 Node.js 一起提供：请先按 Node 指引安装 Node 22+，或重装 Node（勾选 npm）。安装后重启本应用。',
  });

  // 数据目录可写（~/.workmate）
  await begin('storage', '本地数据目录（~/.workmate）', '可读写');
  let storageOk = true;
  let storageError = '';
  try {
    const root = storageRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const probe = path.join(root, '.write-probe');
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch (cause) {
    storageOk = false;
    storageError = cause instanceof Error ? cause.message : String(cause);
  }
  await finish({
    id: 'storage', name: '本地数据目录（~/.workmate）', status: storageOk ? 'ok' : 'error', required: '可读写',
    found: storageOk ? storageRoot() : storageError,
    help: storageOk
      ? '会话、项目、资产、Skill 与域数据保存在该目录。'
      : `无法写入 ${storageRoot()}。请检查磁盘空间、目录权限；macOS/Linux 可执行 chmod 700，Windows 请确认用户对该路径有写权限后重启本应用。`,
  });

  const summary = {
    total: items.length,
    ok: items.filter((item) => item.status === 'ok').length,
    warn: items.filter((item) => item.status === 'warn').length,
    error: items.filter((item) => item.status === 'error').length,
  };
  const report = { platform: platformLabel(), checks: items, summary, checkedAt: Date.now() };
  push({ kind: 'done', report });
  return report;
}

app.whenReady().then(async () => {
  protocol.handle('workmate-preview', async (request) => {
    try {
      const url = new URL(request.url);
      const root = previewRoots.get(url.hostname);
      if (!root) return new Response('Forbidden', { status: 403 });
      let relative = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (!relative) relative = 'index.html';
      if (relative.endsWith('/')) relative = `${relative}index.html`;
      const file = projectPath(root, relative);
      if (!existsSync(file) || !statSync(file).isFile()) return new Response('Not found', { status: 404 });
      const name = path.basename(file);
      // Explicit MIME helps Chromium's PDF viewer and SVG; file:// fetch alone is flaky for custom schemes.
      if (/\.(pdf|svg)$/i.test(name)) {
        const data = readFileSync(file);
        return new Response(data, {
          headers: {
            'Content-Type': assetMimeType(name),
            'Content-Length': String(data.length),
            'Cache-Control': 'no-store',
          },
        });
      }
      return net.fetch(pathToFileURL(file).href);
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
    }
  });
  await initializeDatabase();
  startApi();
  ipcMain.handle('workmate:pick-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('workmate:pick-project-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择项目空间目录', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('workmate:create-project-workspace', (_, value) => createProjectWorkspace(value));
  ipcMain.handle('workmate:list-project-files', (_, root) => listProjectFiles(root));
  ipcMain.handle('workmate:read-project-file', (_, root, relative) => readProjectFile(root, relative));
  ipcMain.handle('workmate:write-project-file', (_, root, relative, content) => writeProjectFile(root, relative, content));
  ipcMain.handle('workmate:sync-project-workspace', (_, root, runId) => syncRunWorkspaceToProject(root, runId));
  ipcMain.handle('workmate:materialize-project-assets', (_, root, assetIds) => materializeProjectAssets(root, assetIds));
  ipcMain.handle('workmate:register-preview-root', (_, root) => registerPreviewRoot(root));
  ipcMain.handle('workmate:register-asset-preview-root', (_, assetId) => registerAssetPreviewRoot(assetId));
  ipcMain.handle('workmate:read-project-preview', (_, root, relative) => readProjectPreview(root, relative));
  ipcMain.handle('workmate:read-asset-preview', (_, assetId) => readAssetPreview(assetId));
  ipcMain.handle('workmate:reveal-project-file', (_, root, relative) => revealProjectFile(root, relative));
  ipcMain.handle('workmate:open-asset-in-browser', (_, assetId) => openAssetInBrowser(assetId));
  ipcMain.handle('workmate:open-project-file-in-browser', (_, root, relative) => openProjectFileInBrowser(root, relative));
  ipcMain.handle('workmate:pick-skill', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose SKILL.md', filters: [{ name: 'Agent Skill manifest', extensions: ['md'] }], properties: ['openFile'] });
    return result.canceled ? null : readSkillManifest(result.filePaths[0]);
  });
  ipcMain.handle('workmate:create-skill', (_, value) => {
    const name = safeSkillName(value?.name);
    const description = String(value?.description || '').trim().slice(0, 500);
    if (!name || !description) throw new Error('A skill name and description are required.');
    const folder = path.join(storageRoot(), 'skills', name);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, 'SKILL.md');
    if (existsSync(file)) throw new Error('A local skill with this name already exists.');
    writeFileSync(file, `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n# ${name}\n\n## Instructions\n\nDescribe when the agent should use this skill and the safe workflow to follow.\n\n## References\n\nPlace optional reference material in this folder and load it only when needed.\n`, { mode: 0o600 });
    return readSkillManifest(file);
  });
  ipcMain.handle('workmate:write-skill-draft', (_, value) => writeSkillDraft(value));
  ipcMain.handle('workmate:read-skill-draft', (_, file) => readSkillDraft(file));
  ipcMain.handle('workmate:list-skill-files', (_, file) => listSkillFiles(file));
  ipcMain.handle('workmate:read-skill-file', (_, file) => readManagedSkillFile(file));
  ipcMain.handle('workmate:write-skill-file', (_, file, content) => writeManagedSkillFile(file, content));
  ipcMain.handle('workmate:delete-managed-skill', (_, file) => deleteManagedSkill(file));
  ipcMain.handle('workmate:install-skill', async (_, reference) => runSkillsCli(reference));
  ipcMain.handle('workmate:import-git-skill', async (_, url) => importGitSkillRepository(url));
  ipcMain.handle('workmate:find-skills', async (_, query, batchCount) => findSkills(query, batchCount));
  ipcMain.handle('workmate:open-external', (_, value) => shell.openExternal(String(value)));
  ipcMain.handle('workmate:get-model-config', () => readModelConfig());
  ipcMain.handle('workmate:save-model-config', (_, value) => writeModelConfig(value));
  ipcMain.handle('workmate:get-search-config', () => readSearchConfig());
  ipcMain.handle('workmate:save-search-config', (_, value) => writeSearchConfig(value));
  ipcMain.handle('workmate:test-provider', (_, value) => testProviderConnection(value));
  ipcMain.handle('workmate:list-provider-models', (_, value) => listProviderModels(value));
  ipcMain.handle('workmate:list-ollama-models', async (_, baseUrl) => {
    return listProviderModels({ type: 'ollama', baseUrl });
  });
  ipcMain.handle('workmate:pull-ollama-model', async (_, baseUrl, modelName) => {
    const root = String(baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const name = String(modelName || '').trim();
    if (!name) throw new Error('缺少模型名称');
    const response = await fetch(`${root}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: false }),
      signal: AbortSignal.timeout(900000),
    });
    if (!response.ok) throw new Error(`Ollama 拉取失败 ${response.status}`);
    const payload = await response.json();
    return String(payload.status || 'success');
  });
  ipcMain.handle('workmate:storage-get', async (_, key) => apiKvGet(key));
  ipcMain.handle('workmate:storage-set', async (_, key, value) => { await apiKvSet(key, value); });
  ipcMain.handle('workmate:get-channel-settings', () => getChannelSettings());
  ipcMain.handle('workmate:save-channel-settings', async (_, payload) => saveChannelSettings(payload));
  ipcMain.handle('workmate:gateway-status', () => gatewayStatus());
  ipcMain.handle('workmate:env-check', async (event) => runEnvironmentChecks((payload) => event.sender.send('workmate:env-check-progress', payload)));
  ipcMain.handle('workmate:gateway-restart', () => gatewayRestart());
  ipcMain.handle('workmate:list-assets', () => listAssets());
  ipcMain.handle('workmate:archive-artifact', (_, value) => archiveArtifact(value));
  ipcMain.handle('workmate:link-assets-to-project', (_, value) => linkAssetsToProject(value));
  ipcMain.handle('workmate:unlink-assets-from-project', (_, assetIds) => unlinkAssetsFromProject(assetIds));
  ipcMain.handle('workmate:save-asset', async (_, assetId) => {
    const { row, target } = assetFile(assetId);
    const result = await dialog.showSaveDialog(mainWindow, { title: '下载资产', defaultPath: row.name });
    if (result.canceled || !result.filePath) return false;
    copyFileSync(target, result.filePath);
    return true;
  });
  ipcMain.handle('workmate:reveal-asset', (_, assetId) => { const { target } = assetFile(assetId); shell.showItemInFolder(target); });
  // One-time one-way seed of legacy sql.js domain keys into the orchestrator
  // store (only keys the orchestrator does not already have). Runs after the
  // local API is reachable so renderer stores and the gateway see one state.
  await waitForApi().catch(() => { /* fall back to legacy sql.js forwarding */ });
  const migratedCount = await migrateDomainKvToApi().catch(() => 0);
  if (migratedCount > 0) console.log(`[orch] migrated ${migratedCount} legacy domain keys`);
  await startGatewayIfEnabled().catch((error) => console.warn('[gateway] start failed:', error));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { apiProcess?.kill('SIGTERM'); gatewayProcess?.kill('SIGTERM'); });
