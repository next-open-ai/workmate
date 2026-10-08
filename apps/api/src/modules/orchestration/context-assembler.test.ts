import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore, type ProjectTask } from '@workmate/orchestrator';
import { resolveSkillRuntimeFor } from './context-assembler.js';

const task = {
  id: 'voice-pdf', title: 'PDF', objective: '生成 PDF', employeeId: 'general', skillIds: [],
  dependsOn: [], permissionTier: 'default', status: 'draft', attempts: 0,
} satisfies ProjectTask;

test('VWB-R10: server-originated voice work loads the owner-scoped employee PDF Skill', async () => {
  const store = new MemoryStore();
  const owner = 'owner-a';
  await store.set(`user:${owner}:capabilities.skills.v2`, JSON.stringify([{
    id: 'skill-baseline-pdf-report', name: 'PDF 报告生成', description: '生成 PDF',
    instructions: 'Use render_pdf_report.',
    execution: { allowWorkspaceWrite: true, allowScriptExecution: true, allowedNetworkHosts: [] },
  }]));
  await store.set(`user:${owner}:capabilities.employee-policies`, JSON.stringify([{
    employeeId: 'general', skillId: 'skill-baseline-pdf-report', mode: 'default',
  }]));
  // A different user's grants must not leak into this run.
  await store.set('user:owner-b:capabilities.employee-policies', JSON.stringify([{
    employeeId: 'general', skillId: 'unrelated-skill', mode: 'default',
  }]));

  const skills = await resolveSkillRuntimeFor(store, task, 'default', owner);
  assert.deepEqual(skills.map((skill) => skill.id), ['skill-baseline-pdf-report']);
  assert.equal(skills[0].mode, 'default');
  assert.equal(skills[0].instructions, 'Use render_pdf_report.');
  assert.equal(skills[0].execution.allowWorkspaceWrite, true);
  assert.equal(skills[0].execution.allowScriptExecution, true);
});

test('VWB-R10: legacy unscoped Skill configuration remains readable', async () => {
  const store = new MemoryStore();
  await store.set('capabilities.skills.v2', JSON.stringify([{
    id: 'legacy-skill', name: 'Legacy', description: '', execution: {},
  }]));
  await store.set('capabilities.employee-policies', JSON.stringify([{
    employeeId: 'general', skillId: 'legacy-skill', mode: 'available',
  }]));
  const skills = await resolveSkillRuntimeFor(store, task, 'read-only', 'owner-without-settings');
  assert.deepEqual(skills.map((skill) => skill.id), ['legacy-skill']);
  assert.equal(skills[0].execution.allowWorkspaceWrite, false);
  assert.equal(skills[0].execution.allowScriptExecution, false);
});
