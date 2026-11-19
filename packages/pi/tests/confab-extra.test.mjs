import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { ConfabApi } = await load('confab-api');
const credential = { backend: 'https://example.test', token: 'test-token' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('HTTP credentials require explicit allowance for validation and sync', async () => {
  const calls = [];
  const api = new ConfabApi(async (url, options) => {
    calls.push([url, options]);
    return url.endsWith('/validate') ? json({ valid: true }) : json({ session_id: 's', files: {} });
  });
  const c = { backend: 'http://internal.test', token: 'private-key' };
  const signal = new AbortController().signal;
  await assert.rejects(api.validate(c, signal));
  await assert.rejects(api.sync(c, { externalId: 'pi-test', lines: [] }, signal));
  assert.equal(calls.length, 0);
  await api.validate({ ...c, allowHttp: true }, signal);
  await api.sync({ ...c, allowHttp: true }, { externalId: 'pi-test', lines: [] }, signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer private-key');
  assert.equal(calls[0][1].redirect, 'error');
});
test('HTTP 413 has an actionable safe diagnostic even for non-JSON proxy responses', async () => {
  const { exportDiagnostic } = await load('confab-errors');
  const api = new ConfabApi(async () => new Response('SECRET proxy detail', { status: 413 }));
  let error;
  try { await api.sync(credential, { externalId: 'e', lines: ['{}'] }, new AbortController().signal); } catch (e) { error = e; }
  assert.equal(error.status, 413);
  assert.match(exportDiagnostic(error), /HTTP 413/);
  assert.doesNotMatch(exportDiagnostic(error), /SECRET/);
  assert.equal(exportDiagnostic(new Error('SECRET proxy detail')), undefined);
});
test('auth HTTP failures never leak response bodies', async () => {
  for (const status of [401, 403, 429, 500]) {
    const api = new ConfabApi(async () => json({ valid: true, error: 'PRIVATE BODY' }, status));
    await assert.rejects(api.validate(credential, new AbortController().signal), { message: 'Confab request failed.' });
  }
});
test('cancel device polling before next request', async () => {
  const controller = new AbortController(); let calls = 0;
  const api = new ConfabApi(async () => { calls++; return json({ device_code: 'secret', user_code: 'ABCD-EFGH', verification_uri: 'https://example.test/auth/device', expires_in: 60, interval: 5 }); });
  await assert.rejects(api.deviceLogin(credential.backend, controller.signal, () => controller.abort()), { message: 'Confab request failed.' });
  assert.equal(calls, 1);
});
test('uncertain chunk acceptance reconciles init before sending anything else', async () => {
  const requests = []; let attempt = 0;
  const api = new ConfabApi(async (url, options) => {
    requests.push(url);
    if (url.endsWith('/init')) return json({ session_id: 's', files: attempt ? { 'pi-transcript.jsonl': { last_synced_line: 1 } } : {} });
    attempt++; throw Error('connection lost after server acceptance');
  });
  const snapshot = { externalId: 'pi-compat-hash', lines: ['{}'] };
  await assert.rejects(api.sync(credential, snapshot, new AbortController().signal));
  await api.sync(credential, snapshot, new AbortController().signal);
  assert.deepEqual(requests.map(u => u.split('/').at(-1)), ['init', 'chunk', 'init']);
});
