import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform, validateSpec } from '../src/core/transform.js';
import { nextRetryDelay, MAX_ATTEMPTS } from '../src/core/retry.js';

/** JSONata results carry extra metadata (null prototypes, `sequence` flags on arrays); normalize for comparison. */
const norm = (v: unknown) => JSON.parse(JSON.stringify(v));

const input = {
  headers: { 'x-source': 'shop' },
  body: {
    user: { name: 'Ada', email: 'ada@example.com' },
    total: 4200,
    line_items: [
      { id: 'sku-1', quantity: 2 },
      { id: 'sku-2', quantity: 1 },
    ],
  },
  route: { slug: 'orders', name: 'Orders' },
};

test('passthrough spec returns the body unchanged', async () => {
  assert.deepEqual(await transform('body', input), input.body);
});

test('field mapping and expressions', async () => {
  const spec = `{
    "customer": body.user.email,
    "amount": body.total / 100,
    "source": headers.\`x-source\`
  }`;
  assert.deepEqual(norm(await transform(spec, input)), {
    customer: 'ada@example.com',
    amount: 42,
    source: 'shop',
  });
});

test('string concatenation and route context', async () => {
  const spec = `{ "text": "New order via " & route.name & " from " & body.user.name }`;
  assert.deepEqual(norm(await transform(spec, input)), { text: 'New order via Orders from Ada' });
});

test('array reshaping', async () => {
  const spec = `{ "items": body.line_items.{ "sku": id, "qty": quantity } }`;
  assert.deepEqual(norm(await transform(spec, input)), {
    items: [{ sku: 'sku-1', qty: 2 }, { sku: 'sku-2', qty: 1 }],
  });
});

test('missing fields evaluate to undefined, not an error', async () => {
  const result = await transform('{ "x": body.does.not.exist }', input);
  assert.deepEqual(norm(result), {});
});

test('validateSpec catches syntax errors', () => {
  assert.equal(validateSpec('body'), null);
  assert.ok(validateSpec('{ "x": ')); // returns an error message
});

test('retry schedule backs off then gives up', () => {
  assert.equal(nextRetryDelay(1), 30);
  assert.equal(nextRetryDelay(2), 120);
  assert.equal(nextRetryDelay(5), 21600);
  assert.equal(nextRetryDelay(6), null);
  assert.equal(MAX_ATTEMPTS, 6);
});
