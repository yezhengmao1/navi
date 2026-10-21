import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, tui } from './helpers.mjs';
const { ExternalSessionSources, sourceId } = await load('external-sessions');
const { default: register } = await load('session-mention');
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: t => t };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'source-remove-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'original'), registry = join(root, 'registry');
  await mkdir(directory);
  const file = join(directory, 'session.jsonl');
  await writeFile(file, 'original contents');
  const sources = new ExternalSessionSources(registry);
  await sources.add(directory, root, 'Owner');
  const handlers = new Map(), notices = [], screens = [], keys = [];
  register({ events: { on() {}, emit() {} }, on: (n, fn) => handlers.set(n, fn), registerCommand() {} }, sources);
  const ctx = { mode: 'tui', hasUI: true, ui: {
    notify: (...args) => notices.push(args),
    custom: factory => new Promise(resolve => {
      const view = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, resolve);
      screens.push(view.render(100).join('\n'));
      for (const key of keys.shift() ?? ['\x1b']) view.handleInput(key);
    }),
  } };
  return { directory, registry, file, sources, ctx, notices, screens, keys,
    input: text => handlers.get('input')({ text }, ctx) };
}

test('remove requires selection and separate explicit yes; cancellation/default no never writes', async t => {
  const f = await fixture(t);
  const before = await readdir(f.registry);
  for (const steps of [[['\x1b']], [[' ', '\r'], ['\x1b']], [[' ', '\r'], ['\r']]]) {
    f.keys.push(...steps);
    assert.deepEqual(await f.input('/session remove'), { action: 'handled' });
    assert.deepEqual(await readdir(f.registry), before);
  }
  f.keys.push([' ', '\r'], [' ', '\r']);
  await f.input('/session remove');
  assert.deepEqual(await f.sources.list(), []);
  assert.equal(await readFile(f.file, 'utf8'), 'original contents');
  assert.match(f.notices.at(-1)[0], /已移除注册/);
});

test('exact source ID supports missing directories; rejects paths, prefixes and non-TUI removal', async t => {
  const f = await fixture(t);
  const id = sourceId(f.directory);
  assert.equal(await f.sources.remove('../original'), false);
  await f.input('/session remove ' + id.slice(0, 20));
  assert.equal(f.notices.at(-1)[1], 'error');
  f.ctx.mode = 'rpc';
  await f.input('/session remove ' + id);
  assert.equal((await f.sources.list()).length, 1);
  f.ctx.mode = 'tui';
  await rm(f.directory, { recursive: true });
  f.keys.push([' ', '\r']);
  await f.input('/session remove ' + id);
  assert.equal((await f.sources.list()).length, 0);
  assert.equal(await f.sources.remove(id), false);
});

test('list uses direct picker and cancellation preserves registrations; detail shows source ID', async t => {
  const f = await fixture(t);
  await f.input('/session list');
  assert.match(f.screens[0], /查看详情/);
  assert.match(f.screens[0], /Owner/);
  assert.equal((await f.sources.list()).length, 1);
  f.keys.push(['\r']);
  await f.input('/session list');
  assert.ok(f.notices.at(-1)[0].includes(sourceId(f.directory)));
  assert.equal(await readFile(f.file, 'utf8'), 'original contents');
});

test('shared questionnaire scrolls all 64 sources and stays bounded after resize', async () => {
  const { showQuestionnaire } = await load('questionnaire');
  let view;
  const pending = showQuestionnaire({ events: { emit() {} } }, { mode: 'tui', ui: {
    custom: factory => new Promise(resolve => { view = factory({ terminal: { rows: 18 }, requestRender() {} }, theme, {}, resolve); }),
  } }, { title: '来源', questions: [{ id: 'source', type: 'single', prompt: '选择', options: Array.from({ length: 64 }, (_, i) => ({ value: String(i), label: '来源-' + i })) }] });
  for (let i = 0; i < 63; i++) view.handleInput('\x1b[B');
  for (const width of [24, 40, 100]) {
    const lines = view.render(width);
    assert.ok(lines.length <= 14);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
    assert.match(lines.join('\n'), /来源-63/);
  }
  view.handleInput(' '); view.handleInput('\r');
  assert.equal((await pending).answers.source, '63');
});
