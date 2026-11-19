import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { ConfabApi, normalizeBackend } = await load('confab-api');
const credential = { backend: 'https://confab.test', token: 'secret-token' };
const signal = () => new AbortController().signal;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const generic = { message: 'Confab request failed.' };
function fixture(replies) {
  const calls = [];
  const api = new ConfabApi(async (url, options) => {
    calls.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    const reply = replies.shift();
    assert.ok(reply, 'unexpected request');
    return typeof reply === 'function' ? reply(calls.at(-1)) : json(reply);
  });
  return { api, calls };
}

test('backend origins: TLS or loopback only; no lossy URL normalization', () => {
  for (const [input, expected] of [['https://EXAMPLE.com:443/', 'https://example.com'], ['http://localhost:8000', 'http://localhost:8000'], ['http://127.0.0.1', 'http://127.0.0.1'], ['http://[::1]', 'http://[::1]']]) assert.equal(normalizeBackend(input), expected);
  for (const input of ['http://example.com', 'https://a/path', 'https://a/.', 'https://a?', 'https://a#', 'https://user:pass@a', 'https://a\\evil', ' https://a', 'https://a\n', 'file:///tmp', 'http://localhost.evil']) assert.throws(() => normalizeBackend(input), generic);
});

test('validation uses GET bearer and requires valid:true', async () => {
  const { api, calls } = fixture([{ valid: true }, { valid: false }]);
  await api.validate(credential, signal());
  assert.equal(calls[0].url, 'https://confab.test/api/v1/auth/validate');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].body, undefined);
  await assert.rejects(api.validate(credential, signal()), generic);
});

test('device schema and pending polling; verification callback and bearer result', async () => {
  const { api, calls } = fixture([
    { device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://confab.test/auth/device', expires_in: 60, interval: 1 },
    () => json({ error: 'authorization_pending' }, 400),
    { access_token: 'cfb_token', token_type: 'Bearer' },
  ]);
  const seen = [];
  assert.deepEqual(await api.deviceLogin(credential.backend, signal(), (...args) => seen.push(args)), { backend: credential.backend, token: 'cfb_token' });
  assert.deepEqual(seen, [['https://confab.test/auth/device', 'ABCD-EFGH']]);
  assert.deepEqual(calls[0].body, { key_name: 'Pi compatibility export' });
  assert.equal(calls[0].url, 'https://confab.test/auth/device/code');
  assert.equal(calls[1].url, 'https://confab.test/auth/device/token');
  assert.deepEqual(calls[1].body, { device_code: 'device-secret' });
  assert.equal(calls[1].headers.Authorization, undefined);
});

test('unsafe verification links never reach callback', async () => {
  for (const verification_uri of ['https://evil.test/auth/device', 'http://confab.test/auth/device', 'https://u:p@confab.test/auth/device', 'https://confab.test/\u001b', 'https://confab.test/%0a', 'https://confab.test/#secret']) {
    const { api } = fixture([{ device_code: 'secret', user_code: 'ABCD-EFGH', verification_uri, expires_in: 60, interval: 1 }]);
    await assert.rejects(api.deviceLogin(credential.backend, signal(), () => assert.fail('unsafe link')), generic);
  }
});

test('sync exact schema, resume and re-init each attempt', async () => {
  const init = { session_id: 'server-id', files: { 'pi-transcript.jsonl': { last_synced_line: 1 } } };
  const { api, calls } = fixture([init, { last_synced_line: 3 }, { session_id: 'server-id', files: { 'pi-transcript.jsonl': { last_synced_line: 3 } } }]);
  const snapshot = { externalId: 'external-id', lines: ['one', 'two', 'three'], title: '修复会话同步与标题' };
  await api.sync(credential, snapshot, signal());
  await api.sync(credential, snapshot, signal());
  assert.deepEqual(calls[0].body, { provider: 'claude-code', external_id: 'external-id', transcript_path: 'pi-transcript.jsonl' });
  assert.deepEqual(calls[1].body, { session_id: 'server-id', file_name: 'pi-transcript.jsonl', file_type: 'transcript', first_line: 2, lines: ['two', 'three'], metadata: { summary: '修复会话同步与标题' } });
  assert.ok(calls[2].url.endsWith('/sync/init'));
});

test('title-only changes patch summary without uploading duplicate lines', async () => {
  const { api, calls } = fixture([{ session_id: 's', files: { 'pi-transcript.jsonl': { last_synced_line: 1 } } }, { status: 'ok' }]);
  await api.sync(credential, { externalId: 'pi-live-existing', lines: ['{}'], title: '新标题', updateTitle: true }, signal());
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /sessions\/pi-live-existing\/summary$/);
  assert.deepEqual(calls[1].body, { summary: '新标题' });
  assert.equal(calls[1].method, 'PATCH');
});

test('invalid offsets and acknowledgements fail closed', async () => {
  for (const offset of [-1, 1.5, 3, '1', null]) {
    const { api, calls } = fixture([{ session_id: 's', files: { 'pi-transcript.jsonl': { last_synced_line: offset } } }]);
    await assert.rejects(api.sync(credential, { externalId: 'e', lines: ['a', 'b'] }, signal()), generic);
    assert.equal(calls.length, 1);
  }
  for (const ack of [0, 2, '1', null]) {
    const { api } = fixture([{ session_id: 's', files: {} }, { last_synced_line: ack }]);
    await assert.rejects(api.sync(credential, { externalId: 'e', lines: ['a'] }, signal()), generic);
  }
});

test('chunk boundaries are contiguous and bounded', async () => {
  const { api, calls } = fixture([{ session_id: 's', files: {} }, { last_synced_line: 500 }, { last_synced_line: 501 }]);
  await api.sync(credential, { externalId: 'e', lines: Array(501).fill('{}') }, signal());
  assert.equal(calls[1].body.lines.length, 500);
  assert.equal(calls[2].body.first_line, 501);
});

test('large records stay whole and chunking counts JSON escape overhead', async () => {
  const { api, calls } = fixture([{ session_id: 's', files: {} }, { last_synced_line: 1 }, { last_synced_line: 2 }]);
  const line = '\\'.repeat(4 * 1024 * 1024);
  await api.sync(credential, { externalId: 'large', lines: [line, line] }, signal());
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.lines.length, 1);
  assert.equal(calls[2].body.first_line, 2);
  assert.equal(calls[1].body.lines[0], line);
  assert.equal(calls[2].body.lines[0], line);
  for (const call of calls.slice(1)) assert.ok(Buffer.byteLength(JSON.stringify(call.body)) < 16 * 1024 * 1024);
});

test('redirects, oversized bodies, invalid JSON and upstream errors are generic', async () => {
  for (const reply of [() => new Response('', { status: 302, headers: { Location: 'https://evil.test' } }), () => new Response('x'.repeat(262145)), () => new Response('private-server-detail'), () => { throw new Error('secret-token'); }]) {
    const { api } = fixture([reply]);
    await assert.rejects(api.validate(credential, signal()), generic);
  }
});

test('cancellation handles uncooperative fetch and streaming body; pre-abort sends nothing', async () => {
  let calls = 0;
  const api = new ConfabApi(() => { calls++; return new Promise(() => {}); });
  const controller = new AbortController();
  const pending = api.validate(credential, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort('private-reason');
  await assert.rejects(pending, generic);
  await assert.rejects(api.validate(credential, controller.signal), generic);
  assert.equal(calls, 1);
  let cancelled = false;
  const streaming = new ConfabApi(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const streamController = new AbortController();
  const streamPending = streaming.validate(credential, streamController.signal);
  await new Promise(resolve => setImmediate(resolve));
  streamController.abort();
  await assert.rejects(streamPending, generic);
  assert.equal(cancelled, true);
});
