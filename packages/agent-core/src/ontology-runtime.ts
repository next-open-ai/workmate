import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OntologyWorkflowSchema, type KnowledgeBaseRuntime, type OntologyCandidate, type OntologyEdge, type OntologyGraph, type OntologyNode, type OntologyWorkflow } from '@workmate/contracts';

export type OntologyQueryPlan = {
  query: string;
  matchedNodes: Array<OntologyNode & { score: number }>;
  relatedNodes: OntologyNode[];
  edges: OntologyEdge[];
  expandedTerms: string[];
  filters: Record<string, string>;
};

function graphPath(kb: KnowledgeBaseRuntime) {
  const dir = kb.dataDir?.trim() ? path.resolve(kb.dataDir) : path.resolve(process.env.WORKMATE_KNOWLEDGE_DIR?.trim() || '.workmate-knowledge', kb.id);
  return path.join(dir, 'ontology.json');
}

function workflowPath(kb: KnowledgeBaseRuntime) {
  return path.join(path.dirname(graphPath(kb)), 'ontology-workflow.json');
}

function emptyGraph(): OntologyGraph { return { version: 1, nodes: [], edges: [] }; }

export function readOntologyGraph(kb: KnowledgeBaseRuntime): OntologyGraph {
  const file = graphPath(kb);
  if (!existsSync(file)) return emptyGraph();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as OntologyGraph;
    return { version: Number(parsed.version) || 1, nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [], edges: Array.isArray(parsed.edges) ? parsed.edges : [] };
  } catch { return emptyGraph(); }
}

export function writeOntologyGraph(kb: KnowledgeBaseRuntime, graph: OntologyGraph) {
  const file = graphPath(kb);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...graph, version: Math.max(1, graph.version || 1) }, null, 2), 'utf8');
  return { ok: true as const, path: file, nodes: graph.nodes.length, edges: graph.edges.length };
}

function emptyWorkflow(): OntologyWorkflow {
  return { draft: emptyGraph(), candidates: [], updatedAt: Date.now() };
}

export function readOntologyWorkflow(kb: KnowledgeBaseRuntime): OntologyWorkflow {
  const file = workflowPath(kb);
  if (!existsSync(file)) {
    const current = readOntologyGraph(kb);
    return { ...emptyWorkflow(), draft: current, ...(current.nodes.length || current.edges.length ? { published: current } : {}) };
  }
  try { return OntologyWorkflowSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { return emptyWorkflow(); }
}

function writeWorkflow(kb: KnowledgeBaseRuntime, value: OntologyWorkflow) {
  const file = workflowPath(kb);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...value, updatedAt: Date.now() }, null, 2), 'utf8');
  return readOntologyWorkflow(kb);
}

export function saveOntologyDraft(kb: KnowledgeBaseRuntime, graph: OntologyGraph) {
  const state = readOntologyWorkflow(kb);
  return writeWorkflow(kb, { ...state, draft: { ...graph, version: Math.max(1, graph.version || 1) }, updatedAt: Date.now() });
}

export function publishOntologyDraft(kb: KnowledgeBaseRuntime) {
  const state = readOntologyWorkflow(kb);
  const published = { ...state.draft, version: Math.max((state.published?.version || 0) + 1, state.draft.version || 1) };
  writeOntologyGraph(kb, published);
  return writeWorkflow(kb, { ...state, draft: published, published, updatedAt: Date.now() });
}

export function importOntologyCandidates(kb: KnowledgeBaseRuntime, candidates: OntologyCandidate[]) {
  const state = readOntologyWorkflow(kb);
  const byId = new Map(state.candidates.map((item) => [item.id, item]));
  for (const candidate of candidates) byId.set(candidate.id, candidate);
  return writeWorkflow(kb, { ...state, candidates: [...byId.values()], updatedAt: Date.now() });
}

export function reviewOntologyCandidates(kb: KnowledgeBaseRuntime, ids: string[], decision: 'accepted' | 'rejected', note?: string) {
  const wanted = new Set(ids);
  const state = readOntologyWorkflow(kb);
  const candidates = state.candidates.map((item) => wanted.has(item.id)
    ? { ...item, status: decision, reviewedAt: Date.now(), ...(note ? { reviewNote: note } : {}) }
    : item);
  return writeWorkflow(kb, { ...state, candidates, updatedAt: Date.now() });
}

export function commitOntologyCandidates(kb: KnowledgeBaseRuntime) {
  const state = readOntologyWorkflow(kb);
  const base = state.published || readOntologyGraph(kb);
  const nodes = new Map(base.nodes.map((item) => [item.id, item]));
  const edges = new Map(base.edges.map((item) => [item.id, item]));
  const committedIds = new Set<string>();
  for (const item of state.candidates) {
    if (item.status !== 'accepted') continue;
    const evidence = item.evidence[0];
    if (item.kind === 'node' && item.node) nodes.set(item.node.id, { ...item.node, status: 'published', source: evidence.source || evidence.documentId, properties: { ...item.node.properties, documentId: evidence.documentId, ...(evidence.chunkId ? { chunkId: evidence.chunkId } : {}) } });
    if (item.kind === 'edge' && item.edge && nodes.has(item.edge.subjectId) && nodes.has(item.edge.objectId)) edges.set(item.edge.id, { ...item.edge, status: 'published', source: evidence.source || evidence.documentId, properties: { ...item.edge.properties, documentId: evidence.documentId, ...(evidence.chunkId ? { chunkId: evidence.chunkId } : {}) } });
    else if (item.kind === 'edge') continue;
    committedIds.add(item.id);
  }
  const published = { version: Math.max(1, base.version + (committedIds.size ? 1 : 0)), nodes: [...nodes.values()], edges: [...edges.values()] };
  writeOntologyGraph(kb, published);
  const candidates = state.candidates.map((item) => committedIds.has(item.id) ? { ...item, status: 'committed' as const } : item);
  const next = writeWorkflow(kb, { ...state, draft: published, published, candidates, updatedAt: Date.now() });
  return { ...next, committed: committedIds.size };
}

function normalize(value: string) { return value.trim().toLocaleLowerCase().replace(/[\s\-_]+/g, ''); }

/** Deterministic phase-1 planner: no LLM or graph database required. */
export function planOntologyQuery(kb: KnowledgeBaseRuntime, query: string, maxHops = 1): OntologyQueryPlan {
  const graph = readOntologyGraph(kb);
  const q = normalize(query);
  const matched = graph.nodes.filter((node) => node.status !== 'archived').map((node) => {
    const labels = [node.name, ...(node.aliases || [])];
    let score = 0;
    for (const label of labels) {
      const n = normalize(label);
      if (n && q.includes(n)) score = Math.max(score, n === q ? 1 : n.length / Math.max(q.length, n.length));
    }
    return { ...node, score };
  }).filter((node) => node.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  const ids = new Set(matched.map((node) => node.id));
  const edges = graph.edges.filter((edge) => edge.status !== 'archived' && (ids.has(edge.subjectId) || ids.has(edge.objectId)));
  const related = new Set<string>();
  for (const edge of edges) {
    if (ids.has(edge.subjectId)) related.add(edge.objectId);
    if (ids.has(edge.objectId)) related.add(edge.subjectId);
  }
  const relatedNodes = graph.nodes.filter((node) => related.has(node.id) && !ids.has(node.id) && node.status !== 'archived');
  const expandedTerms = [...new Set(matched.flatMap((node) => [node.name, ...(node.aliases || [])]).filter(Boolean))];
  const filters: Record<string, string> = {};
  for (const node of [...matched, ...relatedNodes]) for (const [key, value] of Object.entries(node.properties || {})) if (typeof value === 'string') filters[key] ||= value;
  if (maxHops < 1) return { query, matchedNodes: matched, relatedNodes: [], edges: [], expandedTerms, filters };
  return { query, matchedNodes: matched, relatedNodes, edges, expandedTerms, filters };
}

export function graphDocumentHints(plan: OntologyQueryPlan) {
  const hints = new Set<string>();
  for (const node of [...plan.matchedNodes, ...plan.relatedNodes]) {
    if (node.properties.documentId) hints.add(String(node.properties.documentId));
    if (node.properties.source) hints.add(String(node.properties.source));
  }
  return [...hints];
}
