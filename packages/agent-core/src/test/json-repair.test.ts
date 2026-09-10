import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeTruncatedJson,
  extractLooseJsonStringField,
  parseJsonLenient,
  repairControlCharsInJsonStrings,
  salvageToolCallArguments,
  withLenientJsonParse,
} from '../json-repair.js';

test('repairControlCharsInJsonStrings escapes raw newlines inside strings', () => {
  const broken = '{"path":"a.css","content":"line1\nline2\ttab"}';
  const repaired = repairControlCharsInJsonStrings(broken);
  assert.equal(repaired, '{"path":"a.css","content":"line1\\nline2\\ttab"}');
  const parsed = JSON.parse(repaired) as { content: string };
  assert.equal(parsed.content, 'line1\nline2\ttab');
});

test('parseJsonLenient accepts tool args with literal newlines', () => {
  const broken = '{"path":"index.html","content":"<div>\n  hello\n</div>","deliverable":true}';
  const parsed = parseJsonLenient(broken) as { path: string; content: string; deliverable: boolean };
  assert.equal(parsed.path, 'index.html');
  assert.match(parsed.content, /hello/);
  assert.equal(parsed.deliverable, true);
});

test('parseJsonLenient closes truncated tool JSON', () => {
  const truncated = '{"path":"output/x.html","content":"<!DOCTYPE html><html>partial';
  const parsed = parseJsonLenient(truncated) as { path: string; content: string };
  assert.equal(parsed.path, 'output/x.html');
  assert.match(parsed.content, /partial/);
});

test('parseJsonLenient salvages unescaped quotes inside content', () => {
  const broken = '{"path":"output/x.html","content":"<div class="hero">ok</div>","deliverable":true}';
  const parsed = parseJsonLenient(broken) as { path: string; content: string; deliverable: boolean };
  assert.equal(parsed.path, 'output/x.html');
  assert.match(parsed.content, /class="hero"/);
  assert.match(parsed.content, />ok</);
  assert.equal(parsed.deliverable, true);
});

test('extractLooseJsonStringField keeps raw attribute quotes', () => {
  const raw = '{"content":"<em class="x">y</em>","mode":"replace"}';
  assert.equal(extractLooseJsonStringField(raw, 'content'), '<em class="x">y</em>');
});

test('salvageToolCallArguments recovers staged append fields', () => {
  const raw = '{"writeId":"abc-1234-def","seq":2,"text":".hero{color:red","total":4}';
  const salvaged = salvageToolCallArguments(raw);
  assert.ok(salvaged);
  assert.equal(salvaged!.writeId, 'abc-1234-def');
  assert.equal(salvaged!.seq, 2);
  assert.equal(salvaged!.total, 4);
  assert.match(String(salvaged!.text), /hero/);
});

test('closeTruncatedJson closes open brace and string', () => {
  const closed = closeTruncatedJson('{"a":"hi');
  assert.equal(closed, '{"a":"hi"}');
  assert.deepEqual(JSON.parse(closed), { a: 'hi' });
});

test('parseJsonLenient still rejects garbage without salvageable fields', () => {
  assert.throws(() => parseJsonLenient('{not-json'), /JSON|Unexpected|Expected/i);
});

test('withLenientJsonParse patches JSON.parse for the call duration', async () => {
  const broken = '{"a":"x\ny"}';
  assert.throws(() => JSON.parse(broken));
  const value = await withLenientJsonParse(async () => JSON.parse(broken) as { a: string });
  assert.equal(value.a, 'x\ny');
  assert.throws(() => JSON.parse(broken));
});
