import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './helpers.mjs';
const { default: register } = await load('confab');
const { snapshot, redact, CredentialStore } = await load('confab-data');
const credential = { backend: 'https://example.test', token: 'test-token' };
const message = (role, content) => ({ type: 'message', timestamp: '2026-11-12T08:00:00.000Z', message: { role, content, metadata: 'secret-meta' } });
const tick = () => new Promise(r => setImmediate(r));
function harness(overrides = {}) {
  const events = {}, commands = {}, notices = [], calls = [];
  let id = 'session-a';
  const states = new Map();
  const syncState = overrides.syncState ?? { load: scope => structuredClone(states.get(scope) ?? []),
    save: (scope, records) => states.set(scope, structuredClone(records)), lock: () => () => {} };
  const ctx = { mode: 'tui', hasUI: true, ui: { notify: t => notices.push(t) }, sessionManager: {
    getSessionId: () => id, getBranch: () => [message('user', 'hello')], getEntries: () => { throw Error('all entries forbidden'); },
  } };
  const api = { validate: async () => {}, deviceLogin: async () => credential, sync: async (...args) => { calls.push(args); }, ...overrides.api };
  let saves = 0, loads = 0, asks = 0;
  register({ on: (e, f) => events[e] = f, registerCommand: (n, c) => commands[n] = c }, {
    syncState,
    promptKey: overrides.promptKey ?? (async () => 'private-test-key'),
    api, store: { load: () => { loads++; return overrides.noCredential ? undefined : credential; }, save: () => saves++ },
    ask: async (...args) => { asks++; return overrides.ask ? overrides.ask(...args) : { cancelled: false, answers: { allow: true } }; },
  });
  return { ctx, events, notices, calls, commands, syncState, run: s => commands.confab.handler(s, ctx), switchId: () => id = 'session-b',
    counts: () => ({ saves, loads, asks }) };
}

test('single command registration, factory and agent_end never upload by default', async () => {
  const h = harness(); assert.deepEqual(Object.keys(h.commands), ['confab']); assert.deepEqual(h.counts(), { saves: 0, loads: 0, asks: 0 });
  await h.events.agent_end({}, h.ctx); await h.run('sync'); await h.run('disable'); assert.equal(h.calls.length, 0);
  const index = readFileSync(new URL('../extensions/magic-ui/index.ts', import.meta.url), 'utf8'); assert.match(index, /registerConfab\(pi\)/);
});
test('login separate from enable, scoped runtime consent and local status/vis', async () => {
  const h = harness(); await h.run('login https://example.test'); assert.equal(h.counts().saves, 1);
  await h.run('sync'); assert.equal(h.calls.length, 0);
  await h.run('enable'); await h.events.agent_end({}, h.ctx); await tick(); assert.equal(h.calls.length, 1);
  h.switchId(); await h.run('sync'); assert.equal(h.calls.length, 1);
  await h.run('vis'); assert.match(h.notices.at(-1), /不能设置私密\/团队\/公开权限/);
  await h.run('status'); assert.match(h.notices.at(-1), /已关闭/);
});
test('HTTP requires separate Chinese consent before any login request', async () => {
  let logins = 0;
  const h = harness({ ask: async (_pi, _ctx, form) => {
    assert.match(form.questions[0].prompt, /明文传输/);
    return { cancelled: true, answers: {} };
  }, api: { deviceLogin: async () => { logins++; return credential; } } });
  await h.run('login http://confab.example.test');
  assert.equal(logins, 0); assert.equal(h.counts().asks, 1);
});
test('API key HTTP login validates only after consent and never uploads automatically', async () => {
  const previous = process.env.CONFAB_API_KEY;
  process.env.CONFAB_API_KEY = 'private-test-key';
  try {
    let validated;
    const h = harness({ api: { deviceLogin: async () => { throw Error('must not use device login'); }, validate: async c => { validated = c; } } });
    await h.run('login-key http://confab.example.test');
    assert.deepEqual(validated, { backend: 'http://confab.example.test', token: 'private-test-key', allowHttp: true });
    assert.equal(h.counts().asks, 2); assert.equal(h.counts().saves, 1);
    await h.run('sync'); assert.equal(h.calls.length, 0);
    assert.doesNotMatch(h.notices.join(''), /private-test-key/);
    const x = harness({ ask: async () => ({ cancelled: true, answers: {} }), api: { validate: async () => { throw Error('unexpected request'); } } });
    await x.run('login-key http://confab.example.test'); assert.equal(x.counts().saves, 0);
  } finally { if (previous === undefined) delete process.env.CONFAB_API_KEY; else process.env.CONFAB_API_KEY = previous; }
});
test('sync reuses AI title and updates explicit name without changing remote identity', async () => {
  const h = harness(); let generations = 0;
  h.ctx.model = {};
  h.ctx.modelRegistry = { complete: async () => { generations++; return { stopReason: 'stop', content: [{ type: 'text', text: '中文主题标题' }] }; } };
  await h.run('enable'); await h.run('sync'); await tick();
  await h.run('sync'); await tick();
  assert.equal(generations, 1);
  assert.equal(h.calls[0][1].title, '中文主题标题');
  assert.equal(h.calls[0][1].externalId, h.calls[1][1].externalId);
  h.ctx.sessionManager.getSessionName = () => '用户自定标题';
  await h.run('sync'); await tick();
  assert.equal(h.calls[2][1].title, '用户自定标题');
  assert.equal(h.calls[0][1].externalId, h.calls[2][1].externalId);
  assert.equal(h.calls[2][1].updateTitle, true);
  assert.equal(generations, 1);
});
test('restart resumes same remote ID and title; divergent branches get another ID', async () => {
  const h = harness();
  await h.run('enable'); await h.run('sync'); await tick();
  const first = h.calls[0][1];
  const x = harness({ syncState: h.syncState });
  x.ctx.sessionManager.getBranch = () => [message('user', 'hello'), message('assistant', 'new answer')];
  await x.run('enable'); await x.run('sync'); await tick();
  assert.equal(x.calls[0][1].externalId, first.externalId);
  assert.equal(x.calls[0][1].title, first.title);
  assert.equal(x.calls[0][1].lines[0], first.lines[0]);
  x.ctx.sessionManager.getBranch = () => [message('user', 'hello'), message('assistant', 'alternate answer')];
  await x.run('sync'); await tick();
  assert.notEqual(x.calls[1][1].externalId, first.externalId);
});
test('failed upload keeps reserved prefix for retry, without copying remote error text', async () => {
  let externalId;
  const h = harness({ api: { sync: async (_c, data) => { externalId = data.externalId; throw Error('SECRET'); } } });
  await h.run('enable'); await h.run('sync'); await tick();
  const retry = harness({ syncState: h.syncState });
  await retry.run('enable'); await retry.run('sync'); await tick();
  assert.equal(retry.calls[0][1].externalId, externalId);
  assert.doesNotMatch(h.notices.join(''), /SECRET/);
});
test('cancelled or stale key dialog never validates or saves', async () => {
  let validations = 0;
  const h = harness({ promptKey: async () => undefined, api: { validate: async () => { validations++; } } });
  await h.run('login-key https://example.test');
  assert.equal(validations, 0); assert.equal(h.counts().saves, 0);
  let finish;
  const x = harness({ promptKey: () => new Promise(resolve => { finish = resolve; }), api: { validate: async () => { validations++; } } });
  const pending = x.run('login-key https://example.test'); await tick();
  x.events.session_before_switch(); finish('stale-secret'); await pending;
  assert.equal(validations, 0); assert.equal(x.counts().saves, 0);
});
test('device login failure explains stage in Chinese without leaking errors', async () => {
  const h = harness({ api: { deviceLogin: async () => { throw Error('SECRET remote error'); } } });
  await h.run('login https://example.test');
  assert.match(h.notices.at(-1), /设备授权未完成/);
  assert.doesNotMatch(h.notices.join(''), /SECRET/);
  assert.equal(h.counts().saves, 0);
});
test('first URL required; nonTUI and cancelled questionnaires fail closed', async () => {
  const h = harness({ noCredential: true }); await h.run('login'); assert.equal(h.counts().asks, 0); assert.match(h.notices.at(-1), /首次登录请使用/);
  for (const mode of ['rpc', 'print', 'json']) { const x = harness(); x.ctx.mode = mode; await x.run('enable'); await x.run('login https://example.test'); assert.equal(x.counts().asks, 0); assert.equal(x.counts().loads, 0); }
  const x = harness({ ask: async () => ({ cancelled: true, answers: { allow: true } }) }); await x.run('enable'); await x.run('sync'); assert.equal(x.calls.length, 0);
});
test('disable invalidates pending consent and login validation; no stale save', async () => {
  let finish; const h = harness({ ask: () => new Promise(r => finish = r) });
  const p = h.run('enable'); await tick(); await h.run('disable'); finish({ cancelled: false, answers: { allow: true } }); await p; await h.run('sync'); assert.equal(h.calls.length, 0);
  let validated; const x = harness({ api: { validate: () => new Promise(r => validated = r) } });
  const login = x.run('login https://example.test'); await tick(); x.events.session_shutdown(); validated(); await login; assert.equal(x.counts().saves, 0);
});
test('serial bounded coalescing; disable cancels and drops queue', async () => {
  let finish, signal, count = 0;
  const h = harness({ api: { sync: async (_c, _s, sig) => { signal = sig; count++; await new Promise(r => finish = r); } } });
  await h.run('enable'); await h.run('sync');
  for (let i = 0; i < 20; i++) await h.events.agent_end({}, h.ctx);
  assert.equal(count, 1); finish(); await tick(); assert.equal(count, 2);
  await h.run('sync'); await h.run('disable'); assert.equal(signal.aborted, true); finish(); await tick(); assert.equal(count, 2);
});
test('switch, fork and shutdown cancel; generic errors disable uploads', async () => {
  for (const event of ['session_before_switch', 'session_before_fork', 'session_shutdown']) {
    const h = harness(); await h.run('enable'); h.events[event](); await h.run('sync'); assert.equal(h.calls.length, 0);
  }
  const h = harness({ api: { sync: async () => { throw Error('SECRET remote body'); } } });
  await h.run('enable'); await h.run('sync'); await tick(); await h.run('status');
  assert.match(h.notices.at(-1), /已关闭/); assert.ok(!h.notices.join('').includes('SECRET'));
});
test('expanded content, binary exclusion, branch snapshot hash and account scoping', () => {
  const branch = [{ type: 'custom', data: 'NO_CUSTOM' },
    message('user', [{ type: 'image', data: 'NO_IMAGE' }, { type: 'text', text: 'hi' }]),
    message('assistant', [{ type: 'thinking', thinking: 'reasoning record' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'file.ts' } }, { type: 'text', text: 'answer' }])];
  const s = snapshot(branch, credential); assert.equal(s.lines.length, 2); assert.doesNotMatch(s.lines.join(''), /NO_|metadata|secret-meta/);
  assert.match(s.lines.join(''), /reasoning record|tool_use/);
  const user = JSON.parse(s.lines[0]), assistant = JSON.parse(s.lines[1]);
  assert.equal(user.cwd, ''); assert.equal(user.timestamp, '2026-11-12T08:00:00.000Z');
  assert.equal(user.parentUuid, null); assert.equal(assistant.parentUuid, user.uuid);
  assert.equal(assistant.message.type, 'message'); assert.deepEqual(assistant.message.usage, { input_tokens: 0, output_tokens: 0 });
  assert.match(assistant.message.model, /Pi compatibility export/);
  assert.deepEqual(snapshot(branch, credential), s); assert.notEqual(snapshot([...branch, message('user', 'next')], credential).externalId, s.externalId);
  assert.notEqual(snapshot(branch, { ...credential, token: 'other' }).externalId, s.externalId);
  assert.notEqual(snapshot(branch, { ...credential, backend: 'https://other.test' }).externalId, s.externalId);
});
test('snapshot preserves source timestamps and never invents epoch or sync time', () => {
  const user = message('user', 'hello');
  user.message.timestamp = Date.parse('2026-11-12T07:30:00Z');
  const assistant = message('assistant', 'answer');
  assistant.timestamp = '2026-11-12T16:00:00+08:00';
  const s = snapshot([user, assistant], credential);
  assert.equal(JSON.parse(s.lines[0]).timestamp, '2026-11-12T07:30:00.000Z');
  assert.equal(JSON.parse(s.lines[1]).timestamp, '2026-11-12T08:00:00.000Z');
  assert.deepEqual(snapshot([user, assistant], credential), s);
  user.message.timestamp += 1000;
  assert.notEqual(snapshot([user, assistant], credential).externalId, s.externalId);
  delete user.message.timestamp; user.timestamp = 'invalid';
  assert.throws(() => snapshot([user], credential), { code: 'timestamp' });
});
test('secret redaction including multiline before bounds; oversized fails closed', () => {
  const input = '-----BEGIN PRIVATE KEY-----\nPEM_SECRET\n-----END PRIVATE KEY-----\npassword="MULTI\nSECRET"\nauthorization: Bearer AUTH_SECRET\napi_key=KEY_SECRET\nsk-abcdefghijklm';
  assert.doesNotMatch(redact('key=KEYSECRET\nauth="AUTHSECRET"\npassword:\n  MULTILINESECRET'), /KEYSECRET|AUTHSECRET|MULTILINESECRET/);
  const out = redact(input); assert.doesNotMatch(out, /PEM_SECRET|MULTI|AUTH_SECRET|KEY_SECRET|sk-abcdefgh/);
  const s = snapshot([message('user', '-----BEGIN PRIVATE KEY-----\nCROSS'), message('assistant', 'SECRET\n-----END PRIVATE KEY-----')], credential);
  assert.doesNotMatch(s.lines.join(''), /CROSS|SECRET/);
  assert.throws(() => snapshot([message('user', 'a'.repeat(65 * 1024 * 1024))], credential));
});
test('private storage roundtrip, symlink/hard permission refusal, no CLI files', () => {
  const base = mkdtempSync(join(tmpdir(), 'pi-confab-test-'));
  try {
    const dir = join(base, 'owned'), store = new CredentialStore(dir); assert.equal(store.load(), undefined);
    store.save(credential); assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(join(dir, 'credential.json')).mode & 0o777, 0o600); assert.deepEqual(store.load(), credential);
    chmodSync(join(dir, 'credential.json'), 0o644); assert.throws(() => store.load()); chmodSync(join(dir, 'credential.json'), 0o600);
    const alias = join(base, 'alias'); symlinkSync(dir, alias); assert.throws(() => new CredentialStore(alias).load());
    rmSync(join(dir, 'credential.json')); const target = join(base, 'target'); writeFileSync(target, 'untouched'); symlinkSync(target, join(dir, 'credential.json'));
    assert.throws(() => store.load()); assert.throws(() => store.save(credential)); assert.equal(readFileSync(target, 'utf8'), 'untouched');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
