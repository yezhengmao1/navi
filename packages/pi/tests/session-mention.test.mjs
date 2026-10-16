import test from 'node:test';
import assert from 'node:assert/strict';
import { load, tui } from './helpers.mjs';
const { sessionAutocomplete, referenceIds, resolveReference, citeSessions, sessionListCache, default: register } = await load('session-mention');

test('real MagicEditor opens dollar candidates and Escape cancels without changing text', async () => {
  const { default: registerEditor } = await load('editor-footer');
  const handlers = new Map();
  const identity = s => s;
  const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity,
    description: identity, scrollInfo: identity, noMatch: identity } };
  let editor;
  const ctx = { mode: 'tui', hasUI: true, ui: {
    theme: { fg: (_, text) => text, style: text => text,
      colors: { userMessageBg: tui.rgbColor(0, 0, 0), accent: tui.rgbColor(255, 255, 255), warning: tui.rgbColor(255, 255, 0) } },
    setEditorComponent(factory) { editor = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, { matches: () => false }); },
    setFooter() {}, setWorkingMessage() {},
  } };
  registerEditor({ on(name, handler) { handlers.set(name, handler); }, events: {
    on() { return () => {}; }, emit(name, event) {
      if (name === 'magic-ui:session-completion') event.provider = sessionAutocomplete(event.provider,
        async () => [{ id: 'abc', name: '候选会话', cwd: '/work' }]);
    },
  } });
  handlers.get('session_start')({}, ctx);
  editor.setAutocompleteProvider(new tui.CombinedAutocompleteProvider([], '/tmp'));
  editor.handleInput('$');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(editor.isShowingAutocomplete(), true);
  assert.match(editor.render(80).join('\n'), /候选会话/);
  assert.equal(editor.getText(), '$', 'one match must not be auto-inserted');
  editor.handleInput('\x1b');
  assert.equal(editor.isShowingAutocomplete(), false);
  assert.equal(editor.getText(), '$');
  editor.handleInput('x');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(editor.getText(), '$x');
});

test('session list cache shares pending requests, expires, changes scope and retries errors', async () => {
  let time = 0, calls = 0, resolve;
  const ctx = { cwd: '/a', sessionManager: { getSessionDir: () => '/sessions' } };
  const cache = sessionListCache(() => { calls++; return new Promise(done => { resolve = done; }); }, () => time, 10);
  const first = cache.get(ctx);
  time = 100;
  assert.equal(cache.get(ctx), first, 'in-flight loads do not expire');
  resolve([{ id: 'a', allMessagesText: 'large transcript' }]);
  assert.deepEqual(await first, [{ id: 'a', allMessagesText: '' }]);
  assert.equal(cache.get(ctx), first);
  time = 111;
  const expired = cache.get(ctx);
  resolve([]); await expired;
  assert.equal(calls, 2);
  const scoped = cache.get({ ...ctx, cwd: '/b' });
  resolve([]); await scoped;
  assert.equal(calls, 3);
  cache.clear();
  const fresh = cache.get(ctx); resolve([]); await fresh;
  assert.equal(calls, 4);
  let attempts = 0;
  const retry = sessionListCache(async () => { if (++attempts === 1) throw new Error('offline'); return []; });
  await assert.rejects(retry.get(ctx), /offline/);
  assert.deepEqual(await retry.get(ctx), []);
});

test('clearing pending session loads does not resurrect stale cache entries', async () => {
  const ctx = { cwd: '/a', sessionManager: { getSessionDir: () => '/sessions' } };
  const resolvers = [];
  const cache = sessionListCache(() => new Promise(done => resolvers.push(done)));
  const old = cache.get(ctx); cache.clear();
  const current = cache.get(ctx);
  resolvers[0]([{ id: 'old' }]); await old;
  resolvers[1]([{ id: 'new' }]); await current;
  assert.equal(cache.get(ctx), current);
});

test('mentions are explicit, deduplicated, and leave file paths/email alone', () => {
  assert.deepEqual(referenceIds('参考 $session:abcd，和 $session:abcd $session:efgh'), ['abcd', 'efgh']);
  assert.deepEqual(referenceIds('@src/file.ts @session:abcd a$session:abcd test@example.com'), []);
});
test('inline dollar completion delegates native input, filters, inserts and cancels stale results', async () => {
  let calls = 0;
  const native = { triggerCharacters: ['#'], getSuggestions: async () => { calls++; return null; },
    applyCompletion: () => 'native', shouldTriggerFileCompletion: () => true };
  const provider = sessionAutocomplete(native, async () => [{ id: 'abc', name: '训练实验', cwd: '/work', firstMessage: '' }]);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  assert.deepEqual(provider.triggerCharacters, ['#', '$']);
  await provider.getSuggestions(['@file'], 0, 5, options);
  assert.equal(calls, 1);
  const suggestions = await provider.getSuggestions(['参考 $训练'], 0, 6, options);
  assert.equal(suggestions.prefix, '$训练');
  assert.equal(suggestions.items[0].value, '$session:abc');
  assert.deepEqual(provider.applyCompletion(['参考 $训练 后文'], 0, 6, suggestions.items[0], '$训练'),
    { lines: ['参考 $session:abc  后文'], cursorLine: 0, cursorCol: 16 });
  assert.equal(provider.shouldTriggerFileCompletion(['$'], 0, 1), true);
  assert.equal(provider.shouldTriggerFileCompletion(['@'], 0, 1), true);
  controller.abort();
  assert.equal(await provider.getSuggestions(['$'], 0, 1, options), null);
  assert.deepEqual(referenceIds('$session:abc @session:old'), ['abc']);
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
  for (const event of ['input', 'session_start', 'session_switch', 'session_info_changed', 'session_shutdown']) assert.ok(handlers.has(event));
  assert.equal(await handlers.get('input')({ text: '@src/index.ts explain this' }, {}), undefined);
  for (const text of ['@', '@@', '@session:old', '$', '参考 $keyword', '$HOME']) {
    assert.equal(await handlers.get('input')({ text }, {}), undefined);
  }
  assert.equal(await handlers.get('input')({ text: '参考 @ 本地目录' }, {}), undefined);
});
