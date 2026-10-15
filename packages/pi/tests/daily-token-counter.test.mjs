import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, appendFile, rm, rename, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './helpers.mjs';
const { DailyTokenCounter, mayBeCompleteObject, dailyUsage } = await load('editor-footer');
const now = new Date();
const record = (id, tokens, timestamp = now.getTime()) => JSON.stringify({
  id, type: 'message', message: { role: 'assistant', timestamp, provider: 'test', model: 'test', usage: { totalTokens: tokens } },
}) + '\n';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'magic-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'session.jsonl'), counter: new DailyTokenCounter() };
}

test('usage incrementally parses appends, caches unchanged files and deduplicates copied branches', async t => {
  const { dir, path, counter } = await fixture(t);
  await writeFile(path, record('a', 10));
  assert.equal(await counter.read([dir], now), 10);
  assert.equal(await counter.read([dir, dir], now), 10);
  await appendFile(path, record('b', 20));
  assert.equal(await counter.read([dir], now), 30);
  await writeFile(join(dir, 'branch.jsonl'), record('a', 10) + record('c', 5));
  assert.equal(await counter.read([dir], now), 35);
  await rm(path);
  assert.equal(await counter.read([dir], now), 15);
});

test('partial lines and split UTF-8 survive refreshes; malformed complete lines are skipped', async t => {
  const { dir, path, counter } = await fixture(t);
  const line = Buffer.from(record('中文', 42));
  const split = line.indexOf(Buffer.from('中')) + 1;
  await writeFile(path, line.subarray(0, split));
  assert.equal(await counter.read([dir], now), 0);
  assert.equal(await counter.read([dir], now), 0);
  await appendFile(path, line.subarray(split));
  assert.equal(await counter.read([dir], now), 42);
  await appendFile(path, 'not json\n' + record('next', 8));
  assert.equal(await counter.read([dir], now), 50);
});

test('valid final records without a newline count once when subsequently completed', async t => {
  const { dir, path, counter } = await fixture(t);
  await writeFile(path, record('a', 10).trimEnd());
  assert.equal(await counter.read([dir], now), 10);
  await appendFile(path, '\n' + record('b', 20));
  assert.equal(await counter.read([dir], now), 30);
});

test('unfinished object gate inspects only the tail and preserves valid newline-free objects', () => {
  assert.equal(mayBeCompleteObject([]), false);
  assert.equal(mayBeCompleteObject([Buffer.from(' \t\r')]), false);
  assert.equal(mayBeCompleteObject([Buffer.from('{"text":"unfinished')]), false);
  assert.equal(mayBeCompleteObject([Buffer.from('{}'), Buffer.from(' \t\r')]), true);
  // A necessary condition only: the real parser still rejects nested/incomplete JSON.
  assert.equal(mayBeCompleteObject([Buffer.from('{"nested":{}')]), true);
  const chunks = [Buffer.alloc(4 * 1024 * 1024, 120), Buffer.from('x')];
  Object.defineProperty(chunks, 0, { get() { throw new Error('must not inspect old chunks'); } });
  assert.equal(mayBeCompleteObject(chunks), false);
});

test('tool-only appends reuse usage history without reaggregation; later usage still counts', async t => {
  const { dir, path, counter } = await fixture(t);
  await writeFile(path, record('a', 10));
  assert.equal(await counter.read([dir], now), 10);
  const keys = counter.ledger.files.get(path).keys;
  const contribution = keys.values().next().value;
  let inspected = 0;
  Object.defineProperty(contribution, 'count', { get() { inspected++; return 10; } });
  for (let i = 0; i < 3; i++) {
    await appendFile(path, JSON.stringify({ type: 'message', message: { role: 'toolResult', content: 'x'.repeat(10_000) } }) + '\n');
    assert.equal(await counter.read([dir], now), 10);
    assert.equal(counter.ledger.files.get(path).keys, keys);
  }
  assert.equal(inspected, 0, 'tool-only appends must not scan historical usage');
  await appendFile(path, record('b', 20));
  assert.equal(await counter.read([dir], now), 30);
  assert.equal(inspected, 0, 'new assistant usage must not reaggregate unrelated history');
  assert.equal(keys.size, 2);
});

test('large non-usage lines cross chunk boundaries without losing subsequent usage', async t => {
  const { dir, path, counter } = await fixture(t);
  await writeFile(path, JSON.stringify({ type: 'custom', data: '文'.repeat(100_000) }) + '\n' + record('a', 3));
  assert.equal(await counter.read([dir], now), 3);
  await appendFile(path, record('b', 4));
  assert.equal(await counter.read([dir], now), 7);
});

test('truncation, same-size rewrite and inode replacement reset file state', async t => {
  const { dir, path, counter } = await fixture(t);
  await writeFile(path, record('a', 10) + record('b', 20));
  assert.equal(await counter.read([dir], now), 30);
  await writeFile(path, record('c', 40));
  assert.equal(await counter.read([dir], now), 40);
  await writeFile(path, record('d', 50));
  await utimes(path, now, new Date(now.getTime() + 1000));
  assert.equal(await counter.read([dir], now), 50);
  const replacement = join(dir, 'replacement.tmp');
  await writeFile(replacement, record('e', 60) + record('f', 70));
  await rename(replacement, path);
  assert.equal(await counter.read([dir], now), 130);
});

test('fast polls update active files; global discovery is throttled and root changes invalidate it', async t => {
  const { dir, path, counter } = await fixture(t);
  const options = { discoveryIntervalMs: 60_000, activeFile: path };
  await writeFile(path, record('a', 10));
  assert.equal(await counter.read([dir], now, options), 10);
  const other = join(dir, 'other.jsonl');
  await writeFile(other, record('b', 20));
  await appendFile(path, record('c', 30));
  assert.equal(await counter.read([dir], now, options), 40, 'active appends are immediate');
  const later = new Date(now.getTime() + 60_001);
  // Keep synthetic time within the same local day, including near-midnight test runs.
  if (later.getDate() === now.getDate()) {
    assert.equal(await counter.read([dir], later, options), 60, 'global files appear on discovery');
    await rm(other);
    assert.equal(await counter.read([dir], later, options), 60, 'no global stat during fast poll');
  }
  await rm(other, { force: true });
  assert.equal(await counter.read([dir, join(dir, 'missing')], now, options), 40, 'root change forces discovery');
  await rm(path);
  assert.equal(await counter.read([dir, join(dir, 'missing')], now, options), 0, 'active deletion is immediate');
});

test('normalized cached usage matches the reference for missing/invalid counts and duplicate keys', async t => {
  const { dir, path, counter } = await fixture(t);
  const variants = [undefined, {}, { totalTokens: 0, input: 10 }, { totalTokens: -1 },
    { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }, { totalTokens: 7 }, { totalTokens: '9' }];
  const entries = variants.map((usage, i) => ({ id: String(i), type: 'message', timestamp: now.toISOString(),
    message: { role: 'assistant', provider: 'test', model: 'test', usage } }));
  const duplicates = entries.map(e => ({ ...e, message: { ...e.message, usage: { totalTokens: 999 } } }));
  await writeFile(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(await counter.read([dir], now), dailyUsage(entries, now));
  await appendFile(path, duplicates.map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(await counter.read([dir], now), dailyUsage([...entries, ...duplicates], now));
});

test('incremental dedup preserves file precedence through inode replacement and deletion', async t => {
  const { dir, path, counter } = await fixture(t);
  await writeFile(path, record('shared', 10));
  assert.equal(await counter.read([dir], now), 10);
  const branch = join(dir, 'branch.jsonl');
  await writeFile(branch, record('shared', 90));
  assert.equal(await counter.read([dir], now), 10);
  const replacement = join(dir, 'replacement.tmp');
  await writeFile(replacement, record('shared', 20));
  await rename(replacement, path);
  assert.equal(await counter.read([dir], now), 20);
  await rm(path);
  assert.equal(await counter.read([dir], now), 90);
  await writeFile(path, record('shared', 30));
  assert.equal(await counter.read([dir], now), 90);
  await rm(branch);
  assert.equal(await counter.read([dir], now), 30);
});

test('provisional valid tail is removed if an append makes it malformed', async t => {
  const { dir, path, counter } = await fixture(t);
  await writeFile(path, record('a', 10).trimEnd());
  assert.equal(await counter.read([dir], now), 10);
  await appendFile(path, 'invalid suffix');
  assert.equal(await counter.read([dir], now), 0);
  await appendFile(path, '\n' + record('b', 20));
  assert.equal(await counter.read([dir], now), 20);
});

test('day rollover drops old usage but counts new appends in the same file', async t => {
  const { dir, path, counter } = await fixture(t);
  await writeFile(path, record('a', 10));
  assert.equal(await counter.read([dir], now), 10);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(await counter.read([dir], tomorrow), 0);
  await appendFile(path, record('b', 20, tomorrow.getTime()));
  await utimes(path, tomorrow, tomorrow);
  assert.equal(await counter.read([dir], tomorrow), 20);
});
