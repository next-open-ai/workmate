import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commitOntologyCandidates, importOntologyCandidates, planOntologyQuery, publishOntologyDraft, readOntologyWorkflow, reviewOntologyCandidates, saveOntologyDraft } from '../ontology-runtime.js';

test('ontology draft, publish, candidate review and commit form a closed loop', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workmate-ontology-flow-'));
  const kb = { id: 'kb-flow', name: 'Flow', provider: 'lancedb' as const, enabled: true, dataDir: dir };
  try {
    await saveOntologyDraft(kb, { version: 1, nodes: [{ id: 'customer-a', type: 'customer', name: '客户A', aliases: ['A公司'], properties: {}, status: 'draft' }], edges: [] });
    const published = await publishOntologyDraft(kb);
    assert.equal(published.published?.nodes.length, 1);
    await importOntologyCandidates(kb, [{
      id: 'candidate-project', kind: 'node', confidence: 0.96, status: 'pending',
      node: { id: 'project-x', type: 'project', name: '项目X', aliases: [], properties: {}, status: 'draft' },
      evidence: [{ documentId: 'doc-1', chunkId: 'chunk-2', quote: '客户A负责项目X', source: '合同.pdf' }],
    }, {
      id: 'candidate-edge', kind: 'edge', confidence: 0.91, status: 'pending',
      edge: { id: 'edge-a-x', subjectId: 'customer-a', predicate: '负责', objectId: 'project-x', properties: {}, status: 'draft' },
      evidence: [{ documentId: 'doc-1', chunkId: 'chunk-2', quote: '客户A负责项目X', source: '合同.pdf' }],
    }]);
    await reviewOntologyCandidates(kb, ['candidate-project', 'candidate-edge'], 'accepted');
    const committed = await commitOntologyCandidates(kb);
    assert.equal(committed.committed, 2);
    assert.equal((await readOntologyWorkflow(kb)).candidates.every((item) => item.status === 'committed'), true);
    const plan = await planOntologyQuery(kb, 'A公司负责哪个项目');
    assert.equal(plan.matchedNodes[0]?.id, 'customer-a');
    assert.equal(plan.relatedNodes[0]?.id, 'project-x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
