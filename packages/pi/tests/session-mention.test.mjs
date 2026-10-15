import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { referenceIds, resolveReference, citeSessions, default: register } = await load('session-mention');

test('mentions are explicit, deduplicated, and leave file paths/email alone', () => {
  assert.deepEqual(referenceIds('参考 @session:abcd，和 @session:abcd @session:efgh'), ['abcd', 'efgh']);
  assert.deepEqual(referenceIds('@src/file.ts a@session:abcd test@example.com'), []);
});
test('resolve exact and unique prefixes only', () => {
  const sessions = [{ id: 'abcd-1' }, { id: 'abcd-2' }];
  assert.equal(resolveReference(sessions, 'abcd-1'), sessions[0]);
  assert.throws(() => resolveReference(sessions, 'abcd'), /不唯一/);
  assert.throws(() => resolveReference(sessions, 'missing'), /找不到/);
});
test('citation contains only ID and path, never session content or title', () => {
  const result = citeSessions([{ id: 'abcd', path: '/sessions/example.jsonl',
    name: 'secret title', firstMessage: 'secret prompt', allMessagesText: 'secret history'.repeat(10000) }]);
  assert.match(result, /\/sessions\/example.jsonl/);
  assert.match(result, /abcd/);
  assert.doesNotMatch(result, /secret/);
  assert.ok(result.length < 500);
});
test('registers command without replacing editor and leaves ordinary input untouched', async () => {
  const handlers = new Map(); const commands = new Map();
  register({ events: { on() {} }, on: (name, handler) => handlers.set(name, handler), registerCommand: (name, value) => commands.set(name, value) });
  assert.ok(commands.has('mention'));
  assert.deepEqual([...handlers.keys()], ['input']);
  assert.equal(await handlers.get('input')({ text: '@src/index.ts explain this' }, {}), undefined);
  assert.equal(await handlers.get('input')({ text: '@' }, {}), undefined);
  assert.equal(await handlers.get('input')({ text: '参考 @ 本地目录' }, {}), undefined);
});
