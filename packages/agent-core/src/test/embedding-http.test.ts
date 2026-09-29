import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { embedOpenAiCompatible } from '../embedding-http.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('embedding honors configured batches and preserves vector order', async () => {
  const batchSizes: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    batchSizes.push(body.input.length);
    return new Response(JSON.stringify({ model: 'embed', data: body.input.map((text) => ({ embedding: [Number(text), 1] })) }), { status: 200 });
  };
  const result = await embedOpenAiCompatible({ baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'embed', maxBatch: 2 }, ['1', '2', '3', '4', '5']);
  assert.deepEqual(batchSizes, [2, 2, 1]);
  assert.deepEqual(result.vectors.map((row) => row[0]), [1, 2, 3, 4, 5]);
});

test('embedding learns an upstream batch limit and retries without losing inputs', async () => {
  const batchSizes: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    batchSizes.push(body.input.length);
    if (body.input.length > 10) {
      return new Response(JSON.stringify({ error: { message: 'Value error, batch size is invalid, it should not be larger than 10.: input.contents' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ data: body.input.map((text) => ({ embedding: [Number(text), 1] })) }), { status: 200 });
  };
  const inputs = Array.from({ length: 23 }, (_, index) => String(index));
  const config = { baseUrl: 'https://limit.example.test/v1', apiKey: 'key', model: 'embed', maxBatch: 32 };
  const result = await embedOpenAiCompatible(config, inputs);
  assert.deepEqual(batchSizes, [23, 10, 10, 3]);
  assert.deepEqual(result.vectors.map((row) => row[0]), Array.from({ length: 23 }, (_, index) => index));
  batchSizes.length = 0;
  await embedOpenAiCompatible(config, inputs.slice(0, 12));
  assert.deepEqual(batchSizes, [10, 2], 'learned provider limit should prevent another rejected request');
});

test('embedding applies the configured per-input character bound', async () => {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    assert.deepEqual(body.input, ['abcd']);
    return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 });
  };
  await embedOpenAiCompatible({ baseUrl: 'https://example.test/v1', apiKey: '', model: 'embed', maxInputChars: 4 }, ['abcdefgh']);
});
