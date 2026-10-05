import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactToolDetail } from '../pi-runtime.js';

test('bash diagnostic details redact common credentials and remain bounded', () => {
  const detail = redactToolDetail('curl -H "Authorization: Bearer top-secret" "https://example.test?a=1&token=abc" API_KEY=xyz');
  assert.equal(detail.includes('top-secret'), false);
  assert.equal(detail.includes('token=abc'), false);
  assert.equal(detail.includes('API_KEY=xyz'), false);
  assert.match(detail, /\[REDACTED\]/);
  assert.ok(redactToolDetail('x'.repeat(20), 8).startsWith('xxxxxxxx'));
});
