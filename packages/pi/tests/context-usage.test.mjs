import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { load } from './helpers.mjs';
const { contextUsageCache } = await load('context-usage');

test('context usage coalesces invalidations, reads outside render and only repaints changes', async () => {
  let reads = 0, renders = 0;
  let value = { tokens: 10, contextWindow: 100, percent: 10 };
  const ctx = { getContextUsage() { reads++; return { ...value }; } };
  const cache = contextUsageCache(() => renders++);
  try {
    for (let i = 0; i < 100; i++) cache.invalidate(ctx);
    assert.equal(reads, 0);
    await sleep(10);
    assert.deepEqual([reads, renders], [1, 1]);
    for (let i = 0; i < 1000; i++) assert.deepEqual(cache.get(), value);
    assert.equal(reads, 1);
    cache.invalidate(ctx); await sleep(10);
    assert.deepEqual([reads, renders], [2, 1]);
    value = { tokens: null, contextWindow: 200, percent: null };
    cache.invalidate(ctx); await sleep(10);
    assert.deepEqual(cache.get(), value);
    assert.equal(renders, 2);
    cache.invalidate({ getContextUsage: () => undefined }); await sleep(10);
    assert.equal(cache.get(), undefined);
    assert.equal(renders, 3);
  } finally { cache.dispose(); }
});

test('latest context wins; disposal cancels pending refresh and rejects future refreshes', async () => {
  let reads = 0;
  const cache = contextUsageCache(() => {});
  cache.invalidate({ getContextUsage() { throw new Error('stale context'); } });
  cache.invalidate({ getContextUsage() { reads++; return { tokens: 5, percent: 5, contextWindow: 100 }; } });
  await sleep(10);
  assert.equal(cache.get().tokens, 5);
  const ctx = { getContextUsage() { reads++; } };
  cache.invalidate(ctx); cache.dispose(); cache.invalidate(ctx);
  await sleep(10);
  assert.equal(reads, 1);
});
