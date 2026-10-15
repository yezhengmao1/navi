import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers.mjs';
const { UsageLedger } = await load('usage-ledger');
const record = (key, count) => ({ key, count });
const reference = files => {
  const seen = new Set(); let total = 0;
  for (const records of files.values()) for (const { key, count } of records) {
    if (!seen.has(key)) { seen.add(key); total += count; }
  }
  return total;
};

test('ledger preserves earliest-file/first-record precedence on appends, rewrites and deletions', () => {
  const ledger = new UsageLedger();
  ledger.replace('early', []); // Empty files still reserve insertion order.
  ledger.append('late', [record('shared', 90), record('other', 5)]);
  assert.equal(ledger.total, 95);
  ledger.append('early', [record('shared', 10), record('shared', 999)]);
  assert.equal(ledger.total, 15);
  ledger.append('early', [], record('shared', 999));
  assert.equal(ledger.total, 15, 'removing a duplicate tail must not remove the first occurrence');
  ledger.replace('early', [record('shared', 20)]);
  assert.equal(ledger.total, 25, 'replacement preserves precedence');
  ledger.delete('early'); assert.equal(ledger.total, 95);
  ledger.append('early', [record('shared', 30)]);
  assert.equal(ledger.total, 95, 'deleted and re-added file is now later');
  ledger.delete('late'); assert.equal(ledger.total, 30);
  ledger.append('early', [], record('shared', 30)); assert.equal(ledger.total, 0);
  ledger.clear(); ledger.append('fresh', [record('shared', 4)]); assert.equal(ledger.total, 4);
});

test('ledger updates match full aggregation over randomized file and EOF-tail mutations', () => {
  const ledger = new UsageLedger(), files = new Map();
  let seed = 123456;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let step = 0; step < 5000; step++) {
    const path = `file-${random(11)}`;
    const records = Array.from({ length: random(5) }, () => record(`key-${random(23)}`, random(100)));
    const op = random(20);
    if (op === 0) { ledger.clear(); files.clear(); }
    else if (op < 4) { ledger.delete(path); files.delete(path); }
    else if (op < 8) { ledger.replace(path, records); files.set(path, [...records]); }
    else {
      const previous = files.get(path) ?? [];
      const tail = op < 14 ? previous.pop() : undefined;
      ledger.append(path, records, tail);
      previous.push(...records); files.set(path, previous);
    }
    assert.equal(ledger.total, reference(files), `step ${step}`);
  }
  for (const path of files.keys()) ledger.delete(path);
  assert.equal(ledger.total, 0);
  assert.equal(ledger.files.size, 0);
  assert.equal(ledger.heads.size, 0, 'deleted file contributions must not remain indexed');
});

test('append does not enumerate historical keys; references prevent premature deletion', () => {
  const ledger = new UsageLedger();
  ledger.replace('history', Array.from({ length: 10_000 }, (_, i) => record(String(i), 1)));
  const keys = ledger.files.get('history').keys;
  keys[Symbol.iterator] = () => { throw new Error('history traversal'); };
  ledger.append('history', [record('new', 10), record('new', 20)]);
  assert.equal(ledger.total, 10_010);
  ledger.append('history', [], record('new', 20)); assert.equal(ledger.total, 10_010);
  ledger.append('history', [], record('new', 10)); assert.equal(ledger.total, 10_000);
});
