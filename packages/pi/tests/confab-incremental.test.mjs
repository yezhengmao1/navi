import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { snapshot } = await load('confab-data');
const { planSync } = await load('confab-incremental');
const c = { backend: 'https://test.invalid', token: 'private-key' };
const msg = (id, text) => ({ id, type: 'message', timestamp: '2026-11-12T08:00:00Z', message: { role: 'user', content: text } });
const lines = branch => snapshot(branch, c, 'session-a').lines;
test('append-stable wire IDs, parent links and session IDs', () => {
  const a = lines([msg('1', 'first')]); const b = lines([msg('1', 'first'), msg('2', 'second')]);
  assert.equal(a[0], b[0]);
  assert.equal(JSON.parse(b[1]).parentUuid, JSON.parse(a[0]).uuid);
  const plan = planSync('scope', a, []);
  const next = planSync('scope', b, plan.records);
  assert.equal(next.record.externalId, plan.record.externalId);
  assert.equal(planSync('scope', b, next.records).record.externalId, plan.record.externalId);
});
test('branch divergence, rollback and changed redaction fork instead of corrupting old prefix', () => {
  const a = [msg('1', 'first'), msg('2', 'second')];
  const p = planSync('scope', lines(a), []);
  const branch = planSync('scope', lines([a[0], msg('3', 'other')]), p.records);
  assert.notEqual(branch.record.externalId, p.record.externalId);
  assert.notEqual(planSync('scope', lines([a[0]]), branch.records).record.externalId, p.record.externalId);
  assert.equal(planSync('scope', lines(a), branch.records).record.externalId, p.record.externalId);
  const edited = planSync('scope', lines([msg('1', 'changed'), a[1]]), p.records);
  assert.notEqual(edited.record.externalId, p.record.externalId);
  const open = [msg('1', '-----BEGIN PRIVATE KEY-----\npart')];
  const prev = planSync('scope', lines(open), []);
  const closed = planSync('scope', lines([...open, msg('2', 'end\n-----END PRIVATE KEY-----')]), prev.records);
  assert.equal(closed.record.externalId, prev.record.externalId); // appending END no longer changes earlier redaction
});
test('rollback to the original seed cannot collide with a grown remote history', () => {
  const a = msg('1', 'first'), b = msg('2', 'second'), c = msg('3', 'alternate');
  const first = planSync('scope', lines([a]), []);
  const grown = planSync('scope', lines([a, b]), first.records);
  const restored = JSON.parse(JSON.stringify(grown.records)); // Also represents uncertain acceptance.
  const rollback = planSync('scope', lines([a]), restored);
  assert.notEqual(rollback.record.externalId, first.record.externalId);
  const alternate = planSync('scope', lines([a, c]), rollback.records);
  assert.equal(alternate.record.externalId, rollback.record.externalId);
  const original = alternate.records.find(r => r.externalId === first.record.externalId);
  assert.deepEqual(original.hashes, grown.record.hashes);
  assert.equal(new Set(alternate.records.map(r => r.externalId)).size, alternate.records.length);
});
test('end-to-end init reconciliation appends only new rows across restart and forks safely', async () => {
  const { ConfabApi } = await load('confab-api');
  const remote = new Map(), uploads = [];
  const api = new ConfabApi(async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/init')) {
      if (!remote.has(body.external_id)) remote.set(body.external_id, []);
      return new Response(JSON.stringify({ session_id: body.external_id, files: { 'pi-transcript.jsonl': { last_synced_line: remote.get(body.external_id).length } } }));
    }
    assert.ok(url.endsWith('/chunk'));
    const rows = remote.get(body.session_id);
    assert.equal(body.first_line, rows.length + 1);
    rows.push(...body.lines); uploads.push(body.lines.length);
    return new Response(JSON.stringify({ last_synced_line: rows.length }));
  });
  let registry = [];
  const sync = async branch => {
    const wire = lines(branch), p = planSync('scope', wire, registry);
    registry = JSON.parse(JSON.stringify(p.records)); // reservation survives process restart
    await api.sync(c, { externalId: p.record.externalId, lines: wire }, new AbortController().signal);
    return p.record.externalId;
  };
  const a = msg('1', 'first'), b = msg('2', 'second'), d = msg('3', 'alternate');
  const initial = await sync([a]);
  assert.equal(await sync([a, b]), initial);
  assert.equal(await sync([a, b]), initial);
  assert.deepEqual(uploads, [1, 1]);
  const fork = await sync([a]); assert.notEqual(fork, initial);
  assert.equal(await sync([a, d]), fork);
  assert.deepEqual(remote.get(initial), lines([a, b]));
  assert.deepEqual(remote.get(fork), lines([a, d]));
});
test('persisted reservation survives uncertain upload; title is not identity', () => {
  const a = lines([msg('1', 'first')]); const p = planSync('scope', a, []);
  p.record.title = '已有标题';
  const restarted = planSync('scope', a, JSON.parse(JSON.stringify(p.records)));
  assert.equal(restarted.record.externalId, p.record.externalId);
  assert.equal(restarted.record.title, '已有标题');
  assert.notEqual(planSync('different scope', a, []).record.externalId, p.record.externalId);
});
