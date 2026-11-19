import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { generateConfabTitle, cleanTitle } = await load('confab-title');
const lines = [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '修复会话时间显示' }] } })];
test('title generation uses model and sanitized bounded excerpt', async () => {
  const ctx = { model: {}, modelRegistry: { complete: async (_m, request) => {
    assert.match(request.messages[0].content[0].text, /修复会话时间显示/);
    return { stopReason: 'stop', content: [{ type: 'text', text: '会话同步时间修复' }] };
  } } };
  assert.equal(await generateConfabTitle(ctx, lines, new AbortController().signal), '会话同步时间修复');
});
test('missing model and provider failure fall back to first user text', async () => {
  assert.equal(await generateConfabTitle({}, lines, new AbortController().signal), '修复会话时间显示');
  const ctx = { model: {}, modelRegistry: { complete: async () => { throw Error('private failure'); } } };
  assert.equal(await generateConfabTitle(ctx, lines, new AbortController().signal), '修复会话时间显示');
  assert.doesNotMatch(cleanTitle('api_key=secret-value'), /secret-value/);
  assert.ok(Array.from(cleanTitle('中'.repeat(100))).length <= 60);
});
test('cancellation releases title work even if provider ignores abort', async () => {
  const controller = new AbortController();
  const ctx = { model: {}, modelRegistry: { complete: () => new Promise(() => {}) } };
  const result = generateConfabTitle(ctx, lines, controller.signal);
  controller.abort();
  assert.equal(await result, '修复会话时间显示');
});
