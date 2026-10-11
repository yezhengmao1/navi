import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers.mjs';
const { default: register, legacyAccountId, quotaSummary } = await load('quota');
const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.signature`;
function harness(provider = 'openai', hasUI = true) {
  const events = {}, commands = {}, statuses = [], notifications = [];
  register({ on(n, h) { events[n] = h; }, registerCommand(n, c) { commands[n] = c; } });
  const ctx = { hasUI, model: { provider, baseUrl: 'https://chatgpt.com/backend-api' },
    modelRegistry: { isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
    ui: { setStatus: (...v) => statuses.push(v), notify: (...v) => notifications.push(v) } };
  return { events, commands, statuses, notifications, ctx };
}
test('new OpenAI login never polls or touches credentials', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No requests'));
  t.mock.method(globalThis, 'setInterval', () => assert.fail('No polling'));
  const h = harness();
  h.ctx.modelRegistry = new Proxy({}, { get() { assert.fail('No credentials'); } });
  for (const event of ['session_start', 'session_switch', 'model_select', 'session_shutdown']) h.events[event]({}, h.ctx);
  await h.commands.quota.handler('', h.ctx);
  assert.match(h.notifications[0][0], /尚无已验证/);
  assert.ok(h.statuses.every(([,value]) => value === undefined));
});
test('non-UI and unrelated providers never fetch', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No requests'));
  for (const [provider, ui] of [['other', true], ['openai-codex', false]]) {
    const h = harness(provider, ui); await h.commands.quota.handler('', h.ctx);
    assert.ok(!h.statuses.some(([,v]) => v));
  }
});
test('window labels use duration, never assume secondary means week', () => {
  assert.equal(quotaSummary({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 50.5, limit_window_seconds: 604800 } } }), '5h剩余 80% · 周剩余 49.5%');
  for (const used_percent of [-1, 101, NaN, '10']) assert.equal(quotaSummary({ rate_limit: {
    primary_window: { used_percent, limit_window_seconds: 18000 } } }), undefined);
  assert.equal(quotaSummary(null), undefined);
  assert.equal(quotaSummary({ rate_limit: { secondary_window: { used_percent: 1 } } }), undefined);
  assert.equal(legacyAccountId('api-key'), undefined);
  assert.equal(legacyAccountId(token), 'test-account');
});
test('manual legacy query uses official endpoint, no redirects, sanitized snapshot', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    count++;
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['ChatGPT-Account-Id'], 'test-account');
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }) };
  });
  const h = harness('openai-codex'); await h.commands.quota.handler('', h.ctx);
  assert.equal(count, 1); assert.match(h.statuses.at(-1)[1], /5h剩余 90%.*快照/);
  assert.ok(!JSON.stringify(h.notifications).includes(token));
});
test('custom gateway and non-OAuth are not queried', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Do not send gateway credentials'));
  const h = harness('openai-codex'); h.ctx.model.baseUrl = 'https://example.com';
  await h.commands.quota.handler('', h.ctx);
  h.ctx.model.baseUrl = 'https://chatgpt.com/backend-api'; h.ctx.modelRegistry.isUsingOAuth = () => false;
  await h.commands.quota.handler('', h.ctx);
});
test('401 is reported without leaking body or guessing percentage', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401 }));
  const h = harness('openai-codex'); await h.commands.quota.handler('', h.ctx);
  assert.match(h.notifications[0][0], /HTTP 401/);
  assert.ok(!h.statuses.some(([,v]) => v));
});
test('model change aborts pending query and discards late response', async t => {
  const h = harness('openai-codex');
  t.mock.method(globalThis, 'fetch', async () => {
    h.events.model_select({}, h.ctx);
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }) };
  });
  await h.commands.quota.handler('', h.ctx);
  assert.equal(h.notifications.length, 0); assert.ok(h.statuses.every(([,v]) => v === undefined));
});
