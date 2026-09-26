import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KnowledgeBaseRuntime, OntologyEdge, OntologyGraph, OntologyNode } from '@workmate/contracts';

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
