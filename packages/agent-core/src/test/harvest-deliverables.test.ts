import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { harvestWorkspaceDeliverables, isBusinessDeliverablePath, WORKSPACE_OUTPUT_DIR } from '../skill-runtime.js';

test('harvestWorkspaceDeliverables stages root PDF into output/', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-harvest-'));
  try {
    const pdfName = '上海到三亚5日行程.pdf';
    writeFileSync(path.join(root, pdfName), '%PDF-1.4 fake');
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'gen.py'), 'print(1)');

    const started = Date.now() - 5_000;
    const harvested = await harvestWorkspaceDeliverables(root, { startedAtMs: started });
    assert.ok(harvested.includes(`${WORKSPACE_OUTPUT_DIR}/${pdfName}`));
    assert.ok(existsSync(path.join(root, WORKSPACE_OUTPUT_DIR, pdfName)));
    assert.ok(isBusinessDeliverablePath(`${WORKSPACE_OUTPUT_DIR}/${pdfName}`));
    // Generator sources must not become deliverables.
    assert.ok(!harvested.some((item) => item.includes('gen.py')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('harvestWorkspaceDeliverables picks up files already under output/', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-harvest-out-'));
  try {
    mkdirSync(path.join(root, WORKSPACE_OUTPUT_DIR), { recursive: true });
    writeFileSync(path.join(root, WORKSPACE_OUTPUT_DIR, 'report.pdf'), '%PDF-1.4');
    const harvested = await harvestWorkspaceDeliverables(root, { startedAtMs: Date.now() - 1_000, before: [] });
    assert.ok(harvested.includes(`${WORKSPACE_OUTPUT_DIR}/report.pdf`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
