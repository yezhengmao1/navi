import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './helpers.mjs';
const { ExternalSessionSources, formatSourceList, LIMITS } = await load('external-sessions');
const { default: register } = await load('session-mention');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'source-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'registry'), directory = join(root, 'sessions');
  await mkdir(join(directory, 'nested'), { recursive: true });
  const sources = new ExternalSessionSources(registry);
  await sources.add(directory, root, 'Owner');
  return { root, registry, directory, sources };
}
const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'PRIVATE_ID', name: 'PRIVATE_TITLE', cwd: '/PRIVATE_CWD' } });

test('list reports overlap, invalid metadata, links, and counts without leaking session metadata or writing files', async t => {
  const { root, registry, directory, sources } = await fixture(t);
  const child = join(directory, 'nested');
  await sources.add(child, root, 'Child');
  const text = meta + '\n' + JSON.stringify({ type: 'response_item', payload: 'PRIVATE_BODY' });
  const file = join(child, 'a.jsonl'); await writeFile(file, text);
  await writeFile(join(directory, 'bad.jsonl'), '{broken');
  await symlink(file, join(directory, 'link.jsonl'));
  const registryBefore = await Promise.all((await readdir(registry)).map(async name => [name, await readFile(join(registry, name), 'utf8')]));
  const result = await sources.scan();
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sources.map(s => [s.indexed, s.assigned, s.files]), [[1, 1, 2], [1, 0, 0]]);
  assert.equal(result.sources[0].invalid, 1);
  assert.equal(result.sources[0].skippedLinks, 1);
  assert.deepEqual(result.sources[1].status, ['overlap']);
  const report = formatSourceList(result);
  assert.match(report, /codex · Owner/); assert.ok(report.includes(directory));
  assert.match(report, /overlap/); assert.doesNotMatch(report, /PRIVATE_/);
  assert.equal(await readFile(file, 'utf8'), text);
  assert.deepEqual(await Promise.all((await readdir(registry)).map(async name => [name, await readFile(join(registry, name), 'utf8')])), registryBefore);
});

test('empty, missing, replaced symlink and corrupt registry are not silently reported healthy', async t => {
  const { root, registry, directory, sources } = await fixture(t);
  assert.equal((await sources.scan()).sources[0].indexed, 0);
  await rm(directory, { recursive: true });
  const missing = await sources.scan();
  assert.deepEqual(missing.sources[0].status, ['ENOENT']);
  assert.equal(missing.sources[0].errors, 1);
  const target = join(root, 'target'); await mkdir(target);
  await symlink(target, directory);
  assert.deepEqual((await sources.scan()).sources[0].status, ['symlink-skipped']);
  const names = await readdir(registry); await writeFile(join(registry, names[0]), '{broken');
  const broken = await sources.scan();
  assert.ok(broken.warnings.length); assert.doesNotMatch(formatSourceList(broken), /尚未注册/);
  assert.match(formatSourceList(await new ExternalSessionSources(join(root, 'absent')).scan()), /尚未注册/);
});

test('global budget and prefix limits are explicitly reported including unvisited sources', async t => {
  const { root, directory, sources } = await fixture(t);
  await writeFile(join(directory, 'oversize.jsonl'), 'x'.repeat(LIMITS.fileBytes + 1));
  assert.deepEqual((await sources.scan()).sources[0].status, ['prefix-limit']);
  const other = join(root, 'z-other'); await mkdir(other); await sources.add(other, root);
  const previous = LIMITS.files; LIMITS.files = 1;
  try {
    const result = await sources.scan();
    assert.ok(result.sources[1].status.includes('limit'));
    assert.equal(result.sources[1].files, 0);
  } finally { LIMITS.files = previous; }
});

test('input dispatch supports fresh list, validates arguments and preserves native /session', async t => {
  const { sources } = await fixture(t);
  const handlers = new Map(), notices = [], commands = [];
  register({ events: { on() {} }, on: (name, fn) => handlers.set(name, fn), registerCommand: name => commands.push(name) }, sources);
  const ctx = { hasUI: true, ui: { notify: (...args) => notices.push(args) } };
  const input = handlers.get('input');
  assert.equal(await input({ text: '/session' }, ctx), undefined);
  assert.ok(!commands.includes('session'));
  assert.deepEqual(await input({ text: ' /session list  ' }, ctx), { action: 'handled' });
  assert.match(notices.at(-1)[0], /codex · Owner/);
  await input({ text: '/session list unexpected' }, ctx);
  assert.equal(notices.at(-1)[1], 'error');
  await assert.rejects(input({ text: '/session list' }, { hasUI: false }), /交互模式/);
});
