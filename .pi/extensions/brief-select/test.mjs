#!/usr/bin/env node
// Offline: real Pi extension loader, simulated terminal input, no model/network calls.
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (!process.env.PI_PACKAGE_DIR) throw new Error('Set PI_PACKAGE_DIR');
const { loadExtensions } = await import(pathToFileURL(resolve(process.env.PI_PACKAGE_DIR, 'dist/core/extensions/loader.js')));
const loaded = await loadExtensions([resolve(root, '.pi/extensions/brief-select/index.ts')], root);
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get('brief_select').definition;
assert.equal(tool.exposure, 'model-only');
const down = '\x1b[B';
const enter = '\r';
async function run(params, keys, { mode = 'tui', abort = false } = {}) {
  const controller = new AbortController();
  let renders = 0;
  const ctx = { mode, ui: { custom: factory => new Promise(resolve => {
    const component = factory({ requestRender() { renders++; } }, { fg: (_, s) => s }, {}, resolve);
    for (const width of [12, 40, 100]) assert.ok(component.render(width).length > 0);
    for (const key of keys) component.handleInput(key);
    if (abort) controller.abort();
    component.invalidate();
    component.dispose?.();
  }) } };
  const value = await tool.execute('test', params, controller.signal, undefined, ctx);
  assert.deepEqual(JSON.parse(value.content[0].text), value.details);
  return value.details;
}
const submit = [...Array(8).fill(down), enter];
let r = await run({}, submit);
assert.equal(r.cancelled, false);
assert.equal(r.sources.length, 6);
assert.equal(r.feishu, false);
assert.equal(r.siyuan, true);
r = await run({ sources: ['arxiv'] }, [' ', down, ' ', ...Array(5).fill(down), ' ', down, ' ', down, enter]);
assert.deepEqual(r, { cancelled: false, sources: ['hfpapers'], feishu: true, siyuan: false });
r = await run({}, ['a', ...submit, 'a', enter]); // Empty selection cannot submit; select all and retry.
assert.equal(r.sources.length, 6);
assert.equal(r.cancelled, false);
assert.equal((await run({}, ['\x1b'])).cancelled, true);
assert.equal((await run({}, [...Array(9).fill(down), enter])).cancelled, true);
assert.equal((await run({}, [], { abort: true })).cancelled, true);
for (const mode of ['rpc', 'json', 'print']) {
  r = await run({}, [], { mode });
  assert.equal(r.cancelled, true);
  assert.deepEqual(r.sources, []);
}
console.log('PASS: extension loading, defaults, multi-select, output toggles, empty selection, cancellation, abort, non-TUI guard, narrow rendering');
