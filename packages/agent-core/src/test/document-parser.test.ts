import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { documentTextLooksUsable, hasPptxEnhancedParser, parseLocalDocument, supportsLocalDocumentParsing } from '../document-parser.js';

test('local document parser accepts only the supported binary formats', () => {
  assert.equal(supportsLocalDocumentParsing('report.pdf'), true);
  assert.equal(supportsLocalDocumentParsing('brief.DOCX'), true);
  assert.equal(supportsLocalDocumentParsing('deck.PPTX'), true);
  assert.equal(supportsLocalDocumentParsing('show.ppsx'), true);
  assert.equal(supportsLocalDocumentParsing('legacy.doc'), false);
  assert.equal(supportsLocalDocumentParsing('../report.pdf.exe'), false);
});

test('PPTX enhanced parser is enabled only by its isolated component marker', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-pptx-component-test-'));
  const previous = process.env.WORKMATE_DATA_DIR;
  process.env.WORKMATE_DATA_DIR = root;
  try {
    assert.equal(await hasPptxEnhancedParser(), false);
    const component = path.join(root, 'components', 'pptx-enhanced');
    mkdirSync(component, { recursive: true });
    writeFileSync(path.join(component, 'installed.json'), '{"schemaVersion":1}');
    assert.equal(await hasPptxEnhancedParser(), true);
  } finally {
    if (previous === undefined) delete process.env.WORKMATE_DATA_DIR;
    else process.env.WORKMATE_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('document quality gate rejects empty and replacement-heavy output', () => {
  assert.equal(documentTextLooksUsable('short'), false);
  assert.equal(documentTextLooksUsable('A useful paragraph '.repeat(10)), true);
  assert.equal(documentTextLooksUsable(`Readable ${'�'.repeat(100)}`), false);
});

test('document parser invokes the isolated runtime and consumes structured output', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workmate-parser-test-'));
  const packageRoot = path.join(root, 'src', 'workmate_agentscope_runtime');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, '__init__.py'), '');
  writeFileSync(path.join(packageRoot, 'document_parser.py'), [
    'import json, sys',
    'print(json.dumps({"markdown": "# Parsed\\n\\n" + "content " * 20, "parser": "markitdown", "warnings": []}))',
  ].join('\n'));
  const previousRoot = process.env.WORKMATE_AGENTSCOPE_ROOT;
  const previousPython = process.env.WORKMATE_AGENTSCOPE_PYTHON;
  process.env.WORKMATE_AGENTSCOPE_ROOT = root;
  delete process.env.WORKMATE_AGENTSCOPE_PYTHON;
  try {
    const result = await parseLocalDocument({ fileName: 'brief.docx', bytes: Buffer.from('test') });
    assert.equal(result.parser, 'markitdown');
    assert.match(result.markdown, /^# Parsed/);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKMATE_AGENTSCOPE_ROOT;
    else process.env.WORKMATE_AGENTSCOPE_ROOT = previousRoot;
    if (previousPython === undefined) delete process.env.WORKMATE_AGENTSCOPE_PYTHON;
    else process.env.WORKMATE_AGENTSCOPE_PYTHON = previousPython;
    rmSync(root, { recursive: true, force: true });
  }
});
