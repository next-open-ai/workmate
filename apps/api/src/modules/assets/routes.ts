import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth/service.js';
import { canReadOwnedResource, canWriteOwnedResource } from '../auth/ownership.js';
import { getOrchestrator } from '../orchestration/routes.js';

const require = createRequire(import.meta.url);

type SqlDatabase = {
  exec: (sql: string, params?: unknown[]) => Array<{ values?: unknown[][] }>;
  run: (sql: string, params?: unknown[]) => void;
  export: () => Uint8Array;
};

type AssetAccessGrant = {
  subjectType: 'user';
  subjectId: string;
  permissions: Array<'read' | 'write'>;
  createdAt: number;
  expiresAt?: number;
};

let databasePromise: Promise<SqlDatabase> | null = null;

function dataDir(): string {
  return process.env.WORKMATE_DATA_DIR || path.join(os.homedir(), '.workmate');
}

function conversationStagingRoot(runId: string) {
  const configured = process.env.WORKMATE_ASSET_STAGING_DIR?.trim() || process.env.WORKMATE_WORKSPACES_DIR?.trim();
  return path.resolve(configured || path.join(dataDir(), 'assets', '.staging'), runId);
}

function legacyConversationWorkspaceRoot(runId: string) {
  return path.resolve(dataDir(), 'workspaces', runId);
}

function databaseFile() {
  return path.join(dataDir(), 'workmate.sqlite');
}

async function database(): Promise<SqlDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
      const sqlJsRoot = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
      const initSqlJs = require(path.join(sqlJsRoot, 'sql-wasm.js'));
      const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(sqlJsRoot, 'sql-wasm.wasm')) });
      const db = new SQL.Database(fs.existsSync(databaseFile()) ? fs.readFileSync(databaseFile()) : undefined) as SqlDatabase;
      db.run('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, conversation_id TEXT, employee_id TEXT, run_id TEXT NOT NULL, sha256 TEXT NOT NULL)');
      db.run('CREATE INDEX IF NOT EXISTS assets_created_at ON assets(created_at DESC)');
      const cols = new Set((db.exec('PRAGMA table_info(assets)')[0]?.values || []).map((row) => String(row[1])));
      if (!cols.has('project_id')) db.run('ALTER TABLE assets ADD COLUMN project_id TEXT');
      if (!cols.has('workspace_relative')) db.run('ALTER TABLE assets ADD COLUMN workspace_relative TEXT');
      if (!cols.has('org_id')) db.run('ALTER TABLE assets ADD COLUMN org_id TEXT');
      if (!cols.has('user_id')) db.run('ALTER TABLE assets ADD COLUMN user_id TEXT');
      if (!cols.has('owner_user_id')) db.run('ALTER TABLE assets ADD COLUMN owner_user_id TEXT');
      if (!cols.has('access_scope')) db.run(`ALTER TABLE assets ADD COLUMN access_scope TEXT DEFAULT 'private'`);
      if (!cols.has('access_grants')) db.run('ALTER TABLE assets ADD COLUMN access_grants TEXT');
      if (!cols.has('kind')) db.run(`ALTER TABLE assets ADD COLUMN kind TEXT DEFAULT 'file'`);
      if (!cols.has('entry_path')) db.run('ALTER TABLE assets ADD COLUMN entry_path TEXT');
      if (!cols.has('manifest_json')) db.run('ALTER TABLE assets ADD COLUMN manifest_json TEXT');
      db.run('CREATE INDEX IF NOT EXISTS assets_project_id ON assets(project_id)');
      // `output/` is a runtime-only delivery boundary.  Never expose it as a
      // user workspace folder, and keep linked project files at their natural
      // relative location instead of under an implementation directory.
      db.run(`UPDATE assets SET workspace_relative = name WHERE workspace_relative IS NULL OR workspace_relative = ''`);
      db.run(`UPDATE assets SET workspace_relative = substr(workspace_relative, 8) WHERE workspace_relative LIKE 'output/%'`);
      db.run(`UPDATE assets SET owner_user_id = user_id WHERE (owner_user_id IS NULL OR owner_user_id = '') AND user_id IS NOT NULL AND user_id != ''`);
      db.run(`UPDATE assets SET access_scope = 'private' WHERE access_scope IS NULL OR access_scope = ''`);
      db.run(`UPDATE assets SET access_grants = '[]' WHERE access_grants IS NULL OR access_grants = ''`);
      fs.writeFileSync(databaseFile(), Buffer.from(db.export()), { mode: 0o600 });
      return db;
    })();
  }
  return databasePromise;
}

function flushDatabase(db: SqlDatabase) {
  fs.writeFileSync(databaseFile(), Buffer.from(db.export()), { mode: 0o600 });
}

function assetMimeType(name: string) {
  const extension = path.extname(name).toLowerCase();
  return ({
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.zip': 'application/zip',
  } as Record<string, string>)[extension] || 'application/octet-stream';
}

function parseAccessGrants(raw: unknown): AssetAccessGrant[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        subjectType: 'user' as const,
        subjectId: String(item?.subjectId || '').trim(),
        permissions: Array.isArray(item?.permissions)
          ? item.permissions.filter((value: unknown): value is 'read' | 'write' => value === 'read' || value === 'write')
          : [],
        createdAt: Number(item?.createdAt || 0) || Date.now(),
        expiresAt: item?.expiresAt ? Number(item.expiresAt) : undefined,
      }))
      .filter((item) => item.subjectId && item.permissions.length > 0);
  } catch {
    return [];
  }
}

function mapAssetRow(row: unknown[]) {
  const [id, name, relativePath, mimeType, sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative, orgId, ownerUserId, userId, accessScope, accessGrants, kind, entryPath, manifestJson] = row;
  return {
    id: String(id),
    name: String(name),
    relativePath: String(relativePath),
    mimeType: String(mimeType),
    sizeBytes: Number(sizeBytes),
    createdAt: Number(createdAt),
    conversationId: conversationId ? String(conversationId) : null,
    employeeId: employeeId ? String(employeeId) : null,
    runId: String(runId),
    sha256: String(sha256),
    projectId: projectId ? String(projectId) : null,
    workspaceRelative: workspaceRelative ? String(workspaceRelative) : String(name),
    orgId: orgId ? String(orgId) : null,
    ownerUserId: ownerUserId ? String(ownerUserId) : (userId ? String(userId) : null),
    userId: userId ? String(userId) : (ownerUserId ? String(ownerUserId) : null),
    accessScope: (accessScope === 'org-shared' || accessScope === 'delegated' ? accessScope : 'private') as 'private' | 'org-shared' | 'delegated',
    accessGrants: parseAccessGrants(accessGrants),
    kind: kind === 'bundle' ? 'bundle' : 'file',
    entryPath: entryPath ? String(entryPath) : null,
    manifest: (() => { try { return manifestJson ? JSON.parse(String(manifestJson)) : null; } catch { return null; } })(),
  };
}

function assetRows(result: Array<{ values?: unknown[][] }>) {
  return (result[0]?.values || []).map((row) => mapAssetRow(row));
}

const ASSET_SELECT = 'SELECT id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative, org_id, owner_user_id, user_id, access_scope, access_grants, kind, entry_path, manifest_json FROM assets';

async function listAssets(auth?: { orgId: string; userId: string }) {
  const db = await database();
  if (!auth) return assetRows(db.exec(`${ASSET_SELECT} ORDER BY created_at DESC`));
  return assetRows(db.exec(`${ASSET_SELECT} WHERE COALESCE(owner_user_id, user_id) = ? AND (org_id IS NULL OR org_id = ?) ORDER BY created_at DESC`, [auth.userId, auth.orgId]));
}

async function assetFile(assetId: string) {
  const db = await database();
  const row = assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [String(assetId)]))[0];
  if (!row) throw new Error('Asset not found.');
  const target = path.resolve(dataDir(), row.relativePath);
  if (!target.startsWith(`${path.resolve(dataDir(), 'assets')}${path.sep}`) || !fs.existsSync(target)) {
    throw new Error('Asset file is unavailable.');
  }
  return { row, target, db };
}

async function archiveArtifact(value: { runId?: string; relativePath?: string; conversationId?: string; employeeId?: string; projectId?: string; orgId?: string; ownerUserId?: string; userId?: string; accessScope?: 'private' | 'org-shared' | 'delegated'; accessGrants?: AssetAccessGrant[] }) {
  const runId = String(value?.runId || '');
  const relativePath = String(value?.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^[a-f0-9-]{20,}$/i.test(runId) || !relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid artifact location.');
  }
  const processDirs = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);
  const neverExt = new Set(['pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map']);
  const parts = relativePath.split('/');
  const base = parts[parts.length - 1] || '';
  const ext = path.extname(base).slice(1).toLowerCase();
  if (parts[0] !== 'output' || parts.length < 2 || parts.some((part) => processDirs.has(part)) || !ext || neverExt.has(ext) || (base.startsWith('.') && base !== '.gitkeep')) {
    throw new Error('Only business deliverables under output/ can be archived to the asset library.');
  }
  let workspaceRoot = conversationStagingRoot(runId);
  let source = path.resolve(workspaceRoot, relativePath);
  // Retain read compatibility for runs created before staging moved under
  // assets/.staging. New runs never use this legacy path.
  if (!fs.existsSync(source)) {
    workspaceRoot = legacyConversationWorkspaceRoot(runId);
    source = path.resolve(workspaceRoot, relativePath);
  }
  if (!source.startsWith(`${workspaceRoot}${path.sep}`) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error('Generated artifact is no longer available.');
  }
  const db = await database();
  const name = path.basename(source);
  const sizeBytes = fs.statSync(source).size;
  if (sizeBytes > 100 * 1024 * 1024) throw new Error('Generated artifact exceeds the 100 MB asset limit.');
  const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const workspaceRelative = relativePath.replace(/^output\//, '');
  // A deliverable can be written in several append calls. The first
  // artifact.created event must not freeze an early, partial copy in the asset
  // library: refresh the same run/path asset in place whenever its contents
  // change, while keeping a repeated event for unchanged content idempotent.
  const existing = assetRows(db.exec(`${ASSET_SELECT} WHERE run_id = ? AND workspace_relative = ? LIMIT 1`, [runId, workspaceRelative]))[0];
  if (existing) {
    if (existing.sha256 !== sha256 || existing.sizeBytes !== sizeBytes) {
      const target = path.resolve(dataDir(), existing.relativePath);
      if (!target.startsWith(`${path.resolve(dataDir(), 'assets')}${path.sep}`)) {
        throw new Error('Existing asset location is invalid.');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target, 0);
      db.run('UPDATE assets SET name = ?, mime_type = ?, size_bytes = ?, sha256 = ? WHERE id = ?', [
        name,
        assetMimeType(name),
        sizeBytes,
        sha256,
        existing.id,
      ]);
      flushDatabase(db);
      return {
        ...existing,
        name,
        mimeType: assetMimeType(name),
        sizeBytes,
        sha256,
      };
    }
    return existing;
  }
  const id = randomUUID();
  const targetFolder = path.join(dataDir(), 'assets', id);
  fs.mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
  const target = path.join(targetFolder, name);
  fs.copyFileSync(source, target, 0);
  const relativeAssetPath = path.relative(dataDir(), target).split(path.sep).join('/');
  const createdAt = Date.now();
  const projectId = String(value?.projectId || '').trim() || null;
  const conversationId = String(value?.conversationId || '') || null;
  const employeeId = String(value?.employeeId || '') || null;
  const orgId = String(value?.orgId || '').trim() || null;
  const ownerUserId = String(value?.ownerUserId || value?.userId || '').trim() || null;
  const userId = ownerUserId;
  const accessScope = value?.accessScope === 'org-shared' || value?.accessScope === 'delegated' ? value.accessScope : 'private';
  const accessGrants = JSON.stringify(Array.isArray(value?.accessGrants) ? value.accessGrants : []);
  db.run(
    'INSERT INTO assets (id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative, org_id, owner_user_id, user_id, access_scope, access_grants) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, relativeAssetPath, assetMimeType(name), sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative, orgId, ownerUserId, userId, accessScope, accessGrants],
  );
  flushDatabase(db);
  return { id, name, relativePath: relativeAssetPath, mimeType: assetMimeType(name), sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative, orgId, ownerUserId, userId, accessScope, accessGrants: parseAccessGrants(accessGrants) };
}

function bundleFiles(root: string, folder = root, out: Array<{ path: string; bytes: number; sha256: string; mimeType: string }> = []) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) bundleFiles(root, target, out);
    else if (entry.isFile()) {
      const relative = path.relative(root, target).split(path.sep).join('/');
      const bytes = fs.statSync(target).size;
      out.push({ path: relative, bytes, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'), mimeType: assetMimeType(relative) });
    }
  }
  return out;
}

async function archiveBundle(value: Parameters<typeof archiveArtifact>[0]) {
  const runId = String(value.runId || '');
  let workspaceRoot = conversationStagingRoot(runId);
  let source = path.join(workspaceRoot, 'output');
  if (!fs.existsSync(source)) {
    workspaceRoot = legacyConversationWorkspaceRoot(runId);
    source = path.join(workspaceRoot, 'output');
  }
  if (!/^[a-f0-9-]{20,}$/i.test(runId) || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('Bundle output is unavailable.');
  const files = bundleFiles(source);
  const entry = files.some((item) => item.path === 'index.html') ? 'index.html' : files[0]?.path;
  if (!files.length || !entry) throw new Error('Bundle has no deliverable files.');
  const db = await database();
  const manifest = { version: 1, files, entryPath: entry };
  const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const name = path.basename(entry) === 'index.html' ? '网站交付包' : path.basename(entry);
  const sizeBytes = files.reduce((n, f) => n + f.bytes, 0);
  const existing = assetRows(db.exec(`${ASSET_SELECT} WHERE run_id = ? AND kind = 'bundle' LIMIT 1`, [runId]))[0];
  const id = existing?.id || randomUUID();
  const assetRoot = path.join(dataDir(), 'assets', id);
  const folder = path.join(assetRoot, 'files');
  const temporary = path.join(dataDir(), 'assets', `.bundle-${id}-${randomUUID()}`);
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  fs.cpSync(source, path.join(temporary, 'files'), { recursive: true });
  fs.rmSync(assetRoot, { recursive: true, force: true });
  fs.renameSync(temporary, assetRoot);
  const relativePath = path.relative(dataDir(), path.join(folder, entry)).split(path.sep).join('/');
  if (existing) {
    db.run('UPDATE assets SET name=?,relative_path=?,mime_type=?,size_bytes=?,sha256=?,entry_path=?,manifest_json=? WHERE id=?', [name, relativePath, 'application/x-workmate-bundle', sizeBytes, sha256, entry, JSON.stringify(manifest), id]);
  } else {
    db.run('INSERT INTO assets (id,name,relative_path,mime_type,size_bytes,created_at,conversation_id,employee_id,run_id,sha256,project_id,workspace_relative,org_id,owner_user_id,user_id,access_scope,access_grants,kind,entry_path,manifest_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id,name,relativePath,'application/x-workmate-bundle',sizeBytes,Date.now(),value.conversationId||null,value.employeeId||null,runId,sha256,value.projectId||null,'output',value.orgId||null,value.ownerUserId||null,value.ownerUserId||null,value.accessScope||'private',JSON.stringify(value.accessGrants||[]),'bundle',entry,JSON.stringify(manifest)]);
  }
  flushDatabase(db); return assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [id]))[0];
}

async function linkAssetsToProject(value: { projectId?: string; assetIds?: string[]; workspacePath?: string }) {
  const db = await database();
  const projectId = String(value?.projectId || '').trim();
  const assetIds = Array.isArray(value?.assetIds) ? value.assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  if (!projectId) throw new Error('projectId is required.');
  if (!assetIds.length) return { updated: 0, copied: 0, projectId };
  let updated = 0;
  for (const assetId of assetIds) {
    db.run('UPDATE assets SET project_id = ? WHERE id = ?', [projectId, assetId]);
    updated += 1;
  }
  flushDatabase(db);
  let copied = 0;
  const workspacePath = String(value?.workspacePath || '').trim();
  if (workspacePath) {
    const root = path.resolve(workspacePath);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const assetId of assetIds) {
      try {
        const { row, target: source } = await assetFile(assetId);
        const relative = String(row.workspaceRelative || row.name).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) continue;
        const dest = path.resolve(root, relative);
        if (!dest.startsWith(`${root}${path.sep}`)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, dest, 0);
        copied += 1;
      } catch {
        /* Keep linking even if one file copy fails. */
      }
    }
  }
  return { updated, copied, projectId };
}

async function unlinkAssetsFromProject(assetIds: string[]) {
  const db = await database();
  const ids = Array.isArray(assetIds) ? assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  let updated = 0;
  for (const assetId of ids) {
    db.run('UPDATE assets SET project_id = NULL WHERE id = ?', [assetId]);
    updated += 1;
  }
  flushDatabase(db);
  return { updated };
}

async function deleteAssets(assetIds: string[]) {
  const db = await database();
  const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const assetsRoot = path.resolve(dataDir(), 'assets');
  let deleted = 0;
  for (const assetId of ids) {
    const rows = assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [assetId]));
    const row = rows[0];
    if (!row) continue;
    db.run('DELETE FROM assets WHERE id = ?', [assetId]);
    deleted += 1;
    const folder = path.resolve(assetsRoot, assetId);
    if (folder.startsWith(`${assetsRoot}${path.sep}`) && fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    } else if (row.relativePath) {
      const target = path.resolve(dataDir(), row.relativePath);
      if (target.startsWith(`${assetsRoot}${path.sep}`) && fs.existsSync(target)) {
        fs.rmSync(path.dirname(target), { recursive: true, force: true });
      }
    }
  }
  if (deleted) flushDatabase(db);
  return { deleted };
}

function previewBinaryLimit(name: string) {
  if (/\.pdf$/i.test(name)) return 40 * 1024 * 1024;
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name) ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
}

async function readAssetPreview(assetId: string) {
  const { row, target } = await assetFile(assetId);
  const size = fs.statSync(target).size;
  if (size > previewBinaryLimit(row.name)) throw new Error('File is too large to preview.');
  const textLike = /\.(md|markdown|txt|html?|css|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|xml|svg|csv)$/i.test(row.name);
  if (textLike) {
    return { kind: 'text' as const, name: row.name, mimeType: row.mimeType, content: fs.readFileSync(target, 'utf8'), bytes: size };
  }
  return { kind: 'binary' as const, name: row.name, mimeType: row.mimeType, base64: fs.readFileSync(target).toString('base64'), bytes: size };
}

async function assetContent(assetId: string) {
  const { row, target } = await assetFile(assetId);
  return { row, target };
}

export const assetRoutes: FastifyPluginAsync = async (app) => {
  app.get('/assets', async (request) => listAssets(requireAuth(request)));

  app.post('/assets/archive', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const orch = getOrchestrator();
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
      if (conversationId) {
        const session = await orch.chat.getChatSession(conversationId);
        if (!canWriteOwnedResource(session, auth, { allowLegacyUnowned: true })) throw new Error('Chat session not found.');
      }
      if (projectId) {
        const project = await orch.projects.getProject(projectId);
        if (!canWriteOwnedResource(project, auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
      }
      return await archiveArtifact({
        runId: typeof body.runId === 'string' ? body.runId : undefined,
        relativePath: typeof body.relativePath === 'string' ? body.relativePath : undefined,
        conversationId,
        employeeId: typeof body.employeeId === 'string' ? body.employeeId : undefined,
        projectId,
        orgId: auth.orgId,
        ownerUserId: auth.userId,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/assets/archive-bundle', async (request, reply) => {
    const auth = requireAuth(request); const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    try {
      const orch = getOrchestrator();
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
      if (conversationId && !canWriteOwnedResource(await orch.chat.getChatSession(conversationId), auth, { allowLegacyUnowned: true })) throw new Error('Chat session not found.');
      if (projectId && !canWriteOwnedResource(await orch.projects.getProject(projectId), auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
      return await archiveBundle({ runId: String(body.runId || ''), conversationId, employeeId: typeof body.employeeId === 'string' ? body.employeeId : undefined, projectId, orgId: auth.orgId, ownerUserId: auth.userId });
    }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }); }
  });

  app.post('/assets/link', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const orch = getOrchestrator();
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
      const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id || '')) : [];
      const project = projectId ? await orch.projects.getProject(projectId) : null;
      if (!canWriteOwnedResource(project, auth, { allowLegacyUnowned: true })) throw new Error('Project not found.');
      for (const assetId of assetIds) {
        const { row } = await assetFile(assetId);
        if (!canWriteOwnedResource(row, auth)) throw new Error('Asset not found.');
      }
      return await linkAssetsToProject({
        projectId,
        assetIds,
        workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/assets/unlink', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id || '')) : [];
      for (const assetId of assetIds) {
        const { row } = await assetFile(assetId);
        if (!canWriteOwnedResource(row, auth)) throw new Error('Asset not found.');
      }
      return await unlinkAssetsFromProject(assetIds);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/assets/delete', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id || '')) : [];
      if (!assetIds.length) return { deleted: 0 };
      const db = await database();
      for (const assetId of assetIds) {
        const row = assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [assetId]))[0];
        if (!row || !canWriteOwnedResource(row, auth)) throw new Error('Asset not found.');
      }
      return await deleteAssets(assetIds);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/preview', async (request, reply) => {
    const auth = requireAuth(request);
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      const preview = await readAssetPreview(String(query.assetId || ''));
      const { row } = await assetFile(String(query.assetId || ''));
      if (!canReadOwnedResource(row, auth)) throw new Error('Asset not found.');
      return preview;
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/content', async (request, reply) => {
    const auth = requireAuth(request);
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      const { row, target } = await assetContent(String(query.assetId || ''));
      if (!canReadOwnedResource(row, auth)) throw new Error('Asset not found.');
      reply.header('content-type', row.mimeType || 'application/octet-stream');
      reply.header('content-disposition', String(query.download || '') === '1' ? `attachment; filename="${encodeURIComponent(row.name)}"` : `inline; filename="${encodeURIComponent(row.name)}"`);
      return reply.send(fs.createReadStream(target));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/bundle-content', async (request, reply) => {
    const auth = requireAuth(request); const query = request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {};
    try {
      const { row } = await assetFile(String(query.assetId || '')); if (!canReadOwnedResource(row, auth) || row.kind !== 'bundle') throw new Error('Asset not found.');
      const relative = String(query.path || row.entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid bundle path.');
      const target = path.resolve(dataDir(), 'assets', row.id, 'files', relative); const root = path.resolve(dataDir(), 'assets', row.id, 'files');
      if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('Bundle file is unavailable.');
      reply.header('content-type', assetMimeType(relative)); return reply.send(fs.createReadStream(target));
    } catch (error) { return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) }); }
  });

  app.get('/assets/bundle/:assetId/*', async (request, reply) => {
    const auth = requireAuth(request); const params = request.params as { assetId: string; '*': string };
    try {
      const { row } = await assetFile(params.assetId); if (!canReadOwnedResource(row, auth) || row.kind !== 'bundle') throw new Error('Asset not found.');
      const relative = String(params['*'] || row.entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid bundle path.');
      const root = path.resolve(dataDir(), 'assets', row.id, 'files'); const target = path.resolve(root, relative);
      if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('Bundle file is unavailable.');
      reply.header('content-type', assetMimeType(relative)); return reply.send(fs.createReadStream(target));
    } catch (error) { return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) }); }
  });
};
