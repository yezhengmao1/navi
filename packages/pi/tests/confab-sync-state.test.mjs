import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './helpers.mjs';
const { SyncStateStore } = await load('confab-sync-state');
const scope = 'private-account/private-session';
const record = { externalId: 'pi-live-' + 'a'.repeat(64), hashes: ['b'.repeat(64)], title: '同步标题' };
function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), 'confab-state-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'parent', 'state');
  const file = join(dir, createHash('sha256').update(scope).digest('hex') + '.json');
  return { base, dir, file, store: new SyncStateStore(dir) };
}

test('lazy construction, missing state, private roundtrip and scope isolation', t => {
  const { base, dir, file, store } = fixture(t);
  assert.deepEqual(fs.readdirSync(base), []);
  assert.deepEqual(store.load(scope), []);
  assert.equal(fs.existsSync(dir), false);
  store.save(scope, [record]);
  assert.deepEqual(new SyncStateStore(dir).load(scope), [record]);
  assert.equal(fs.statSync(dir).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o7777, 0o600);
  assert.equal(fs.statSync(file).uid, process.getuid());
  assert.equal(fs.statSync(file).nlink, 1);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-account|private-session/);
  assert.deepEqual(store.load('other-account/private-session'), []);
  assert.deepEqual(store.load('private-account/other-session'), []);
  store.save('other', []);
  const before = fs.statSync(file).ino;
  store.save(scope, [{ ...record, title: 'updated' }]);
  assert.notEqual(fs.statSync(file).ino, before);
  assert.equal(store.load(scope)[0].title, 'updated');
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('scope lock excludes concurrent writers and duplicate remote IDs are rejected', t => {
  const { dir, store } = fixture(t);
  const release = store.lock(scope);
  const second = new SyncStateStore(dir);
  assert.throws(() => second.lock(scope));
  const otherRelease = second.lock('other'); otherRelease();
  release(); release();
  const retryRelease = second.lock(scope); retryRelease();
  assert.throws(() => store.save(scope, [record, { ...record, hashes: [] }]));
});
test('reject symlink directories, ancestors and dangling ancestors without factory IO', t => {
  const { base, dir, store } = fixture(t);
  store.save(scope, []);
  for (const target of [dir, join(base, 'absent')]) {
    const alias = join(base, 'alias');
    fs.symlinkSync(target, alias);
    for (const path of [alias, join(alias, 'child')]) {
      const other = new SyncStateStore(path);
      assert.throws(() => other.load(scope));
      assert.throws(() => other.save(scope, []));
    }
    fs.unlinkSync(alias);
  }
});

test('reject file symlinks, dangling symlinks, hardlinks and nonfiles on load and save', t => {
  const { base, file, store } = fixture(t);
  store.save(scope, []);
  fs.unlinkSync(file);
  const target = join(base, 'target');
  fs.writeFileSync(target, '[]', { mode: 0o600 });
  for (const make of [() => fs.symlinkSync(target, file),
    () => fs.symlinkSync(join(base, 'missing'), file),
    () => fs.linkSync(target, file), () => fs.mkdirSync(file, { mode: 0o600 })]) {
    make();
    assert.throws(() => store.load(scope));
    assert.throws(() => store.save(scope, [record]));
    assert.equal(fs.readFileSync(target, 'utf8'), '[]');
    fs.rmSync(file, { recursive: true });
  }
});

test('reject unsafe permissions and foreign owners rather than repairing them', t => {
  const { dir, file, store } = fixture(t);
  store.save(scope, []);
  for (const [path, bad, good] of [[dir, 0o755, 0o700], [file, 0o644, 0o600]]) {
    fs.chmodSync(path, bad);
    assert.throws(() => store.load(scope));
    assert.throws(() => store.save(scope, []));
    fs.chmodSync(path, good);
  }
  if (process.getuid() === 0) {
    for (const path of [dir, file]) {
      fs.chownSync(path, 65534, 65534);
      assert.throws(() => store.load(scope));
      assert.throws(() => store.save(scope, []));
      fs.chownSync(path, 0, 0);
    }
  }
});

test('strict schema, byte and count limits; failed writes preserve old registry', t => {
  const { file, store } = fixture(t);
  store.save(scope, [record]);
  const bad = [null, {}, [null], Array(101).fill(record),
    [{ ...record, externalId: 'pi-live-' + 'A'.repeat(64) }],
    [{ ...record, hashes: Array(20001).fill('b'.repeat(64)) }],
    [{ ...record, hashes: ['g'.repeat(64)] }], [{ ...record, hashes: ['b'.repeat(63)] }],
    [{ ...record, hashes: Array(1) }], [{ ...record, title: null }],
    [{ ...record, title: '界'.repeat(81) }], [{ ...record, title: 'x\n' }],
    [{ ...record, title: '\u0085' }], [{ ...record, title: '\u202e' }],
    [{ ...record, conversation: 'must not persist' }]];
  for (const value of bad) {
    assert.throws(() => store.save(scope, value));
    assert.deepEqual(store.load(scope), [record]);
  }
  const boundary = { ...record, title: '界'.repeat(80), hashes: Array(20000).fill('A'.repeat(64)) };
  store.save(scope, [boundary]);
  assert.deepEqual(store.load(scope), [boundary]);
  store.save(scope, Array.from({ length: 100 }, (_, i) => ({ ...record, externalId: 'pi-live-' + i.toString(16).padStart(64, '0'), hashes: [] })));
  assert.equal(store.load(scope).length, 100);
  assert.throws(() => store.save(scope, Array.from({ length: 51 }, (_, i) => ({ ...boundary, externalId: 'pi-live-' + i.toString(16).padStart(64, '0') })))); // >64 MiB aggregate
  assert.equal(store.load(scope).length, 100);
  for (const content of ['SECRET corrupt JSON', '{}', '[null]', JSON.stringify([{ ...record, hashes: [3] }]), Buffer.from([0xff])]) {
    fs.writeFileSync(file, content);
    assert.throws(() => store.load(scope), e => !e.message.includes('SECRET'));
    assert.throws(() => store.save(scope, []));
  }
});

test('oversized sparse files rejected before reading, with no unsafe overwrite', t => {
  const { dir, file, store } = fixture(t);
  store.save(scope, []);
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  assert.throws(() => store.load(scope));
  assert.throws(() => store.save(scope, []));
  assert.equal(fs.statSync(file).size, 64 * 1024 * 1024 + 1);
  assert.equal(fs.readdirSync(dir).length, 1);
});
