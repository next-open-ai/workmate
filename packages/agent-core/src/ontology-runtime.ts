import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OntologyGraphSchema, OntologyWorkflowSchema, type KnowledgeBaseRuntime, type OntologyCandidate, type OntologyEdge, type OntologyGraph, type OntologyNode, type OntologyWorkflow } from '@workmate/contracts';

export type OntologyQueryPlan = { query: string; matchedNodes: Array<OntologyNode & { score: number }>; relatedNodes: OntologyNode[]; edges: OntologyEdge[]; expandedTerms: string[]; filters: Record<string, string> };
type SqlValue = string | number | Uint8Array | null;
type SqlDatabase = { run(sql: string, params?: SqlValue[]): void; exec(sql: string, params?: SqlValue[]): Array<{ columns: string[]; values: SqlValue[][] }>; export(): Uint8Array; close(): void };
type SqlJs = { Database: new (bytes?: Uint8Array) => SqlDatabase };
const require = createRequire(import.meta.url);
let sqlPromise: Promise<SqlJs> | null = null;
const queues = new Map<string, Promise<unknown>>();

function dir(kb: KnowledgeBaseRuntime) { return kb.dataDir?.trim() ? path.resolve(kb.dataDir) : path.resolve(process.env.WORKMATE_KNOWLEDGE_DIR?.trim() || '.workmate-knowledge', kb.id); }
function dbPath(kb: KnowledgeBaseRuntime) { return path.join(dir(kb), 'ontology.sqlite'); }
function emptyGraph(): OntologyGraph { return { version: 1, nodes: [], edges: [] }; }

async function sqlJs(): Promise<SqlJs> {
  if (!sqlPromise) sqlPromise = Promise.resolve().then(async () => {
    const root = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
    const init = require(path.join(root, 'sql-wasm.js')) as (options: { wasmBinary: Buffer }) => Promise<SqlJs>;
    return init({ wasmBinary: readFileSync(path.join(root, 'sql-wasm.wasm')) });
  });
  return sqlPromise;
}

function schema(db: SqlDatabase) {
  db.run('CREATE TABLE IF NOT EXISTS ontology_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_nodes (layer TEXT NOT NULL,id TEXT NOT NULL,type TEXT NOT NULL,name TEXT NOT NULL,aliases_json TEXT NOT NULL,properties_json TEXT NOT NULL,source TEXT,status TEXT NOT NULL,PRIMARY KEY(layer,id))');
  db.run('CREATE INDEX IF NOT EXISTS idx_ontology_nodes_name ON ontology_nodes(layer,name)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_edges (layer TEXT NOT NULL,id TEXT NOT NULL,subject_id TEXT NOT NULL,predicate TEXT NOT NULL,object_id TEXT NOT NULL,properties_json TEXT NOT NULL,source TEXT,status TEXT NOT NULL,PRIMARY KEY(layer,id))');
  db.run('CREATE INDEX IF NOT EXISTS idx_ontology_edges_subject ON ontology_edges(layer,subject_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ontology_edges_object ON ontology_edges(layer,object_id)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_candidates (id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,confidence REAL NOT NULL,status TEXT NOT NULL,node_json TEXT,edge_json TEXT,evidence_json TEXT NOT NULL,reviewed_at INTEGER,review_note TEXT)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ontology_candidates_status ON ontology_candidates(status)');
  db.run('CREATE TABLE IF NOT EXISTS ontology_versions (version INTEGER PRIMARY KEY NOT NULL,graph_json TEXT NOT NULL,published_at INTEGER NOT NULL)');
}
function rows(db: SqlDatabase, sql: string, params: SqlValue[] = []) { const result = db.exec(sql, params)[0]; return result ? result.values.map((values) => Object.fromEntries(result.columns.map((column, i) => [column, values[i]]))) : []; }
function meta(db: SqlDatabase, key: string) { const value = rows(db, 'SELECT value FROM ontology_meta WHERE key=?', [key])[0]?.value; return value == null ? undefined : String(value); }
function setMeta(db: SqlDatabase, key: string, value: string | number) { db.run('INSERT INTO ontology_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]); }

function readLayer(db: SqlDatabase, layer: 'draft' | 'published'): OntologyGraph {
  const nodes = rows(db, 'SELECT * FROM ontology_nodes WHERE layer=? ORDER BY rowid', [layer]).map((r) => ({ id: String(r.id), type: String(r.type), name: String(r.name), aliases: JSON.parse(String(r.aliases_json)), properties: JSON.parse(String(r.properties_json)), ...(r.source == null ? {} : { source: String(r.source) }), status: String(r.status) as OntologyNode['status'] }));
  const edges = rows(db, 'SELECT * FROM ontology_edges WHERE layer=? ORDER BY rowid', [layer]).map((r) => ({ id: String(r.id), subjectId: String(r.subject_id), predicate: String(r.predicate), objectId: String(r.object_id), properties: JSON.parse(String(r.properties_json)), ...(r.source == null ? {} : { source: String(r.source) }), status: String(r.status) as OntologyEdge['status'] }));
  return OntologyGraphSchema.parse({ version: Number(meta(db, `${layer}_version`)) || 1, nodes, edges });
}
function replaceLayer(db: SqlDatabase, layer: 'draft' | 'published', graph: OntologyGraph) {
  const parsed = OntologyGraphSchema.parse(graph); db.run('DELETE FROM ontology_nodes WHERE layer=?', [layer]); db.run('DELETE FROM ontology_edges WHERE layer=?', [layer]);
  for (const n of parsed.nodes) db.run('INSERT INTO ontology_nodes VALUES(?,?,?,?,?,?,?,?)', [layer, n.id, n.type, n.name, JSON.stringify(n.aliases), JSON.stringify(n.properties), n.source ?? null, n.status]);
  for (const e of parsed.edges) db.run('INSERT INTO ontology_edges VALUES(?,?,?,?,?,?,?,?)', [layer, e.id, e.subjectId, e.predicate, e.objectId, JSON.stringify(e.properties), e.source ?? null, e.status]);
  setMeta(db, `${layer}_version`, parsed.version); setMeta(db, `${layer}_exists`, 1);
}
function readCandidates(db: SqlDatabase): OntologyCandidate[] { return rows(db, 'SELECT * FROM ontology_candidates ORDER BY rowid').map((r) => ({ id: String(r.id), kind: String(r.kind) as OntologyCandidate['kind'], ...(r.node_json == null ? {} : { node: JSON.parse(String(r.node_json)) }), ...(r.edge_json == null ? {} : { edge: JSON.parse(String(r.edge_json)) }), evidence: JSON.parse(String(r.evidence_json)), confidence: Number(r.confidence), status: String(r.status) as OntologyCandidate['status'], ...(r.reviewed_at == null ? {} : { reviewedAt: Number(r.reviewed_at) }), ...(r.review_note == null ? {} : { reviewNote: String(r.review_note) }) })); }
function replaceCandidates(db: SqlDatabase, candidates: OntologyCandidate[]) { db.run('DELETE FROM ontology_candidates'); for (const c of candidates) db.run('INSERT INTO ontology_candidates VALUES(?,?,?,?,?,?,?,?,?)', [c.id, c.kind, c.confidence, c.status, c.node ? JSON.stringify(c.node) : null, c.edge ? JSON.stringify(c.edge) : null, JSON.stringify(c.evidence), c.reviewedAt ?? null, c.reviewNote ?? null]); }
function workflow(db: SqlDatabase): OntologyWorkflow { const published = meta(db, 'published_exists') === '1' ? readLayer(db, 'published') : undefined; return OntologyWorkflowSchema.parse({ draft: meta(db, 'draft_exists') === '1' ? readLayer(db, 'draft') : (published || emptyGraph()), ...(published ? { published } : {}), candidates: readCandidates(db), updatedAt: Number(meta(db, 'updated_at')) || Date.now() }); }
function replaceWorkflow(db: SqlDatabase, value: OntologyWorkflow) { const parsed = OntologyWorkflowSchema.parse(value); replaceLayer(db, 'draft', parsed.draft); if (parsed.published) replaceLayer(db, 'published', parsed.published); else { db.run('DELETE FROM ontology_nodes WHERE layer=?', ['published']); db.run('DELETE FROM ontology_edges WHERE layer=?', ['published']); setMeta(db, 'published_exists', 0); } replaceCandidates(db, parsed.candidates); setMeta(db, 'updated_at', parsed.updatedAt); }

function legacy(kb: KnowledgeBaseRuntime): OntologyWorkflow | null {
  try {
    const wf = path.join(dir(kb), 'ontology-workflow.json'); if (existsSync(wf)) return OntologyWorkflowSchema.parse(JSON.parse(readFileSync(wf, 'utf8')));
    const graphFile = path.join(dir(kb), 'ontology.json'); if (existsSync(graphFile)) { const graph = OntologyGraphSchema.parse(JSON.parse(readFileSync(graphFile, 'utf8'))); return { draft: graph, published: graph, candidates: [], updatedAt: Date.now() }; }
  } catch { /* Keep invalid legacy files untouched for manual recovery. */ }
  return null;
}
async function withDb<T>(kb: KnowledgeBaseRuntime, mutate: boolean, fn: (db: SqlDatabase) => T | Promise<T>): Promise<T> {
  const file = dbPath(kb), prior = queues.get(file) || Promise.resolve();
  const task = prior.catch(() => undefined).then(async () => { const SQL = await sqlJs(), existed = existsSync(file); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const db = new SQL.Database(existed ? readFileSync(file) : undefined); try { schema(db); if (!existed) { const old = legacy(kb); if (old) replaceWorkflow(db, old); setMeta(db, 'schema_version', 1); } const result = await fn(db); if (mutate || !existed) writeFileSync(file, Buffer.from(db.export()), { mode: 0o600 }); return result; } finally { db.close(); } });
  const settled = task.then(() => undefined, () => undefined); queues.set(file, settled); try { return await task; } finally { if (queues.get(file) === settled) queues.delete(file); }
}
function transaction<T>(db: SqlDatabase, fn: () => T): T { db.run('BEGIN'); try { const result = fn(); db.run('COMMIT'); return result; } catch (error) { db.run('ROLLBACK'); throw error; } }

export async function readOntologyGraph(kb: KnowledgeBaseRuntime) { return withDb(kb, false, (db) => meta(db, 'published_exists') === '1' ? readLayer(db, 'published') : emptyGraph()); }
export async function writeOntologyGraph(kb: KnowledgeBaseRuntime, graph: OntologyGraph) { return withDb(kb, true, (db) => transaction(db, () => { replaceLayer(db, 'published', graph); if (meta(db, 'draft_exists') !== '1') replaceLayer(db, 'draft', graph); setMeta(db, 'updated_at', Date.now()); db.run('INSERT OR REPLACE INTO ontology_versions VALUES(?,?,?)', [graph.version, JSON.stringify(graph), Date.now()]); return { ok: true as const, path: dbPath(kb), nodes: graph.nodes.length, edges: graph.edges.length }; })); }
export async function readOntologyWorkflow(kb: KnowledgeBaseRuntime) { return withDb(kb, false, workflow); }
export async function saveOntologyDraft(kb: KnowledgeBaseRuntime, graph: OntologyGraph) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db); replaceWorkflow(db, { ...state, draft: { ...graph, version: Math.max(1, graph.version || 1) }, updatedAt: Date.now() }); return workflow(db); })); }
export async function publishOntologyDraft(kb: KnowledgeBaseRuntime) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), published = { ...state.draft, version: Math.max((state.published?.version || 0) + 1, state.draft.version || 1) }; replaceWorkflow(db, { ...state, draft: published, published, updatedAt: Date.now() }); db.run('INSERT OR REPLACE INTO ontology_versions VALUES(?,?,?)', [published.version, JSON.stringify(published), Date.now()]); return workflow(db); })); }
export async function importOntologyCandidates(kb: KnowledgeBaseRuntime, candidates: OntologyCandidate[]) { return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), byId = new Map(state.candidates.map((c) => [c.id, c])); for (const candidate of candidates) byId.set(candidate.id, candidate); replaceWorkflow(db, { ...state, candidates: [...byId.values()], updatedAt: Date.now() }); return workflow(db); })); }
export async function reviewOntologyCandidates(kb: KnowledgeBaseRuntime, ids: string[], decision: 'accepted' | 'rejected', note?: string) { return withDb(kb, true, (db) => transaction(db, () => { const wanted = new Set(ids), state = workflow(db), candidates = state.candidates.map((c) => wanted.has(c.id) ? { ...c, status: decision, reviewedAt: Date.now(), ...(note ? { reviewNote: note } : {}) } : c); replaceWorkflow(db, { ...state, candidates, updatedAt: Date.now() }); return workflow(db); })); }
export async function commitOntologyCandidates(kb: KnowledgeBaseRuntime) {
  return withDb(kb, true, (db) => transaction(db, () => { const state = workflow(db), base = state.published || emptyGraph(), nodes = new Map(base.nodes.map((n) => [n.id, n])), edges = new Map(base.edges.map((e) => [e.id, e])), committed = new Set<string>();
    for (const c of state.candidates) { if (c.status !== 'accepted') continue; const ev = c.evidence[0]; if (c.kind === 'node' && c.node) nodes.set(c.node.id, { ...c.node, status: 'published', source: ev.source || ev.documentId, properties: { ...c.node.properties, documentId: ev.documentId, ...(ev.chunkId ? { chunkId: ev.chunkId } : {}) } }); if (c.kind === 'edge' && c.edge && nodes.has(c.edge.subjectId) && nodes.has(c.edge.objectId)) edges.set(c.edge.id, { ...c.edge, status: 'published', source: ev.source || ev.documentId, properties: { ...c.edge.properties, documentId: ev.documentId, ...(ev.chunkId ? { chunkId: ev.chunkId } : {}) } }); else if (c.kind === 'edge') continue; committed.add(c.id); }
    const published = { version: Math.max(1, base.version + (committed.size ? 1 : 0)), nodes: [...nodes.values()], edges: [...edges.values()] }, candidates = state.candidates.map((c) => committed.has(c.id) ? { ...c, status: 'committed' as const } : c); replaceWorkflow(db, { ...state, draft: published, published, candidates, updatedAt: Date.now() }); db.run('INSERT OR REPLACE INTO ontology_versions VALUES(?,?,?)', [published.version, JSON.stringify(published), Date.now()]); return { ...workflow(db), committed: committed.size }; }));
}

function normalize(value: string) { return value.trim().toLocaleLowerCase().replace(/[\s\-_]+/g, ''); }
export async function planOntologyQuery(kb: KnowledgeBaseRuntime, query: string, maxHops = 1): Promise<OntologyQueryPlan> {
  const graph = await readOntologyGraph(kb), q = normalize(query); const matched = graph.nodes.filter((n) => n.status !== 'archived').map((n) => { let score = 0; for (const label of [n.name, ...(n.aliases || [])]) { const normalized = normalize(label); if (normalized && q.includes(normalized)) score = Math.max(score, normalized === q ? 1 : normalized.length / Math.max(q.length, normalized.length)); } return { ...n, score }; }).filter((n) => n.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  const ids = new Set(matched.map((n) => n.id)), edges = graph.edges.filter((e) => e.status !== 'archived' && (ids.has(e.subjectId) || ids.has(e.objectId))), related = new Set<string>(); for (const e of edges) { if (ids.has(e.subjectId)) related.add(e.objectId); if (ids.has(e.objectId)) related.add(e.subjectId); }
  const relatedNodes = graph.nodes.filter((n) => related.has(n.id) && !ids.has(n.id) && n.status !== 'archived'), expandedTerms = [...new Set(matched.flatMap((n) => [n.name, ...(n.aliases || [])]).filter(Boolean))], filters: Record<string, string> = {}; for (const n of [...matched, ...relatedNodes]) for (const [key, value] of Object.entries(n.properties || {})) if (typeof value === 'string') filters[key] ||= value;
  return maxHops < 1 ? { query, matchedNodes: matched, relatedNodes: [], edges: [], expandedTerms, filters } : { query, matchedNodes: matched, relatedNodes, edges, expandedTerms, filters };
}
export function graphDocumentHints(plan: OntologyQueryPlan) { const hints = new Set<string>(); for (const node of [...plan.matchedNodes, ...plan.relatedNodes]) { if (node.properties.documentId) hints.add(String(node.properties.documentId)); if (node.properties.source) hints.add(String(node.properties.source)); } return [...hints]; }
