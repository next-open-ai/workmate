import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('apps/renderer/src/app/AppSidebar.vue', 'utf8');

assert.match(source, /aria-haspopup="menu"/);
assert.match(source, /:aria-expanded="accountMenuOpen"/);
assert.match(source, /role="menu"/);
assert.match(source, /role="menuitem"/);
assert.match(source, /event\.key === 'Escape'/);
assert.match(source, /accountMenuRoot\.value\?\.contains/);
assert.match(source, /v-if="collapsed"[\s\S]{0,240}title="展开侧栏"/);
assert.doesNotMatch(source, /rounded-2xl border border-\[var\(--border\)\] bg-\[var\(--surface\)\] p-3\.5/);

console.log('SIDEBAR-ACCOUNT-T1 PASS: compact account trigger and accessible menu behavior.');
