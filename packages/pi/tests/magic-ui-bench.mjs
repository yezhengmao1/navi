/** Offline synthetic benchmark. Snapshot the previous magic-ui directory first:
 * MAGIC_UI_BASELINE=/tmp/magic-ui-before node tests/magic-ui-bench.mjs
 * Wall-clock measurements are illustrative, not CI timing assertions.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load, root } from './helpers.mjs';

if (!process.env.MAGIC_UI_BASELINE) throw new Error('Set MAGIC_UI_BASELINE to a snapshot of the previous magic-ui directory');
const require = createRequire(join(root, 'package.json'));
const jiti = require('jiti').createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
} });
const before = name => jiti.import(join(resolve(process.env.MAGIC_UI_BASELINE), `${name}.ts`));
const oldCompact = (await before('compact')).compactThinking;
const newCompact = (await load('compact')).compactThinking;
const OldClock = (await before('block-timing')).BlockClock;
const NewClock = (await load('block-timing')).BlockClock;
const OldCounter = (await before('editor-footer')).DailyTokenCounter;
const NewCounter = (await load('editor-footer')).DailyTokenCounter;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function report(name, old, next) {
  console.log(JSON.stringify({ name, beforeMs: +old.toFixed(3), afterMs: +next.toFixed(3) }));
}
function syncTime(fn, rounds = 100) {
  for (let i = 0; i < 5; i++) fn();
  const samples = [];
  for (let i = 0; i < rounds; i++) { const t = performance.now(); fn(); samples.push(performance.now() - t); }
  return median(samples);
}
const text = 'reasoning line 12345\n'.repeat(100_000);
assert.equal(newCompact(text), oldCompact(text));
report('thinking: 100k lines / 2.1M chars', syncTime(() => oldCompact(text)), syncTime(() => newCompact(text)));
const oldClock = new OldClock(), nextClock = new NewClock();
for (const clock of [oldClock, nextClock]) for (let i = 0; i < 20_000; i++) {
  clock.update(String(i), 'text_start', 0, 1); clock.finish(String(i), 2);
  clock.tools.set(String(i), { start: 1, end: 2 });
}
let oldIndex = 0, nextIndex = 0;
report('finish turn: 20k historical messages + tools', syncTime(() => {
  oldClock.update(`live-${oldIndex++}`, 'text_start', 0, 3);
  if (typeof oldClock.finishActive === 'function') oldClock.finishActive(4);
  else {
    for (const key of oldClock.messages.keys()) oldClock.finish(key, 4);
    for (const span of oldClock.tools.values()) span.end ??= 4;
  }
}), syncTime(() => {
  nextClock.update(`live-${nextIndex++}`, 'text_start', 0, 3);
  nextClock.finishActive(4);
}));

const oldStream = new OldClock(), nextStream = new NewClock();
for (const clock of [oldStream, nextStream]) for (let i = 0; i < 5000; i++) clock.update('long', 'text_start', i, i);
const deltas = clock => { for (let i = 0; i < 200; i++) clock.update('long', 'text_delta', 4999, 6000 + i); };
report('200 streaming deltas after 5k completed/current blocks', syncTime(() => deltas(oldStream), 20), syncTime(() => deltas(nextStream), 20));
assert.equal(oldStream.elapsed('long', [0, 4999], 7000), nextStream.elapsed('long', [0, 4999], 7000));

const dir = await mkdtemp(join(tmpdir(), 'magic-ui-bench-'));
const now = new Date();
const record = id => JSON.stringify({ id, type: 'message', message: { role: 'assistant',
  timestamp: now.getTime(), provider: 'bench', model: 'bench', usage: { totalTokens: 10 } } }) + '\n';
async function counterScenario(name, initial, addition, expected) {
  const folder = join(dir, name); await mkdir(folder);
  const path = join(folder, 'session.jsonl'); await writeFile(path, initial);
  const old = new OldCounter(), next = new NewCounter();
  const options = { activeFile: path, discoveryIntervalMs: 60_000 };
  assert.equal(await old.read([folder], now, options), await next.read([folder], now, options));
  const oldTimes = [], newTimes = [];
  for (let i = 0; i < 10; i++) {
    await appendFile(path, addition(i));
    let t = performance.now(); const a = await old.read([folder], now, options); oldTimes.push(performance.now() - t);
    t = performance.now(); const b = await next.read([folder], now, options); newTimes.push(performance.now() - t);
    assert.equal(a, b); assert.equal(b, expected(i));
  }
  report(name, median(oldTimes), median(newTimes));
}
try {
  const history = Array.from({ length: 20_000 }, (_, i) => record(`history-${i}`)).join('');
  await counterScenario('tool-only append after 20k usage records', history,
    () => JSON.stringify({ type: 'message', message: { role: 'toolResult', content: 'x'.repeat(4096) } }) + '\n', () => 200_000);
  await counterScenario('assistant append after 20k usage records', history,
    i => record(`new-${i}`), i => 200_000 + (i + 1) * 10);
  await counterScenario('append to unfinished 2MiB JSON string', '{"type":"custom","data":"' + 'x'.repeat(2 * 1024 * 1024),
    () => 'x'.repeat(16 * 1024), () => 0);
  if (global.gc) {
    const folder = join(dir, 'retained-usage'); await mkdir(folder);
    await writeFile(join(folder, 'session.jsonl'), history);
    const retained = async Counter => {
      global.gc(); const before = process.memoryUsage().heapUsed;
      const counter = new Counter(); await counter.read([folder], now);
      await new Promise(setImmediate); global.gc();
      const bytes = process.memoryUsage().heapUsed - before;
      // Keep the counter live through measurement rather than relying on GC liveness.
      assert.equal(await counter.read([folder], now), 200_000);
      return bytes;
    };
    console.log(JSON.stringify({ name: 'retained heap for 20k usage records (approximate)',
      beforeMiB: +((await retained(OldCounter)) / 1024 / 1024).toFixed(2),
      afterMiB: +((await retained(NewCounter)) / 1024 / 1024).toFixed(2) }));
  }
} finally { await rm(dir, { recursive: true, force: true }); }
