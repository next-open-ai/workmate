import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KnowledgeBaseRuntime } from '@workmate/contracts';
import { planOntologyQuery, readOntologyGraph, writeOntologyGraph } from '../ontology-runtime.js';

test('ontology graph persists and expands aliases/relationships deterministically', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workmate-ontology-'));
  try {
    const kb = { id: 'kb-test', name: 'Test', provider: 'lancedb', dataDir: dir, enabled: true } as KnowledgeBaseRuntime;
    writeOntologyGraph(kb, {
      version: 1,
      nodes: [
        { id: 'issue', type: 'Issue', name: '退款未到账', aliases: ['退钱没收到'], properties: {}, status: 'published' },
        { id: 'flow', type: 'Process', name: '退款异常处理流程', aliases: [], properties: { documentId: 'doc-flow' }, status: 'published' },
      ],
      edges: [{ id: 'e1', subjectId: 'flow', predicate: '处理', objectId: 'issue', properties: {}, status: 'published' }],
    });
    assert.equal(readOntologyGraph(kb).nodes.length, 2);
    const plan = planOntologyQuery(kb, '客人退钱没收到怎么办');
    assert.equal(plan.matchedNodes[0]?.id, 'issue');
    assert.equal(plan.relatedNodes[0]?.id, 'flow');
    assert.ok(plan.expandedTerms.includes('退款未到账'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
