import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../apps/api/src/modules/orchestration/context-assembler.ts', import.meta.url), 'utf8');
assert.match(source, /user:\$\{ownerUserId\.trim\(\)\}:\$\{MCP_KEY\}/);
assert.match(source, /scopedRows\.length > 0 \? scopedRows : rows\(await kvJson\(store, MCP_KEY\)/);
assert.match(source, /mcpConnectionsFor\(store, prefs, ownerUserId\)/);
console.log('User-scoped MCP runtime regression passed.');
