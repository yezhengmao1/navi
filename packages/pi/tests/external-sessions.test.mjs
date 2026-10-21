import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './helpers.mjs';
const { ExternalSessionSources, LIMITS } = await load('external-sessions');
const { addSessionSource, mergeSessions, sessionAutocomplete, citeSessions, default: register } = await load('session-mention');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'sessions with spaces'); await mkdir(join(source, 'nested'), { recursive: true });
  return { root, source, registry: join(root, 'registry') };
}
const meta = id => JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work', timestamp: '2026-01-01T00:00:00Z' } });

test('typed literal paths, validation, persistence and canonical deduplication', async t => {
  const { root, source, registry } = await fixture(t);
  const sources = new ExternalSessionSources(registry);
  for (const text of ['/session add', '/session add codex', '/session add pi /x', '/session add claude /x', '/session add wat /x', '/session add codex "oops'])
    await assert.rejects(addSessionSource(text, root, sources));
  await assert.rejects(sources.add('missing', root));
  const file = join(root, 'file'); await writeFile(file, '');
  await assert.rejects(sources.add(file, root), /目录/);
  assert.equal((await addSessionSource(`/session add codex "${source}"`, root, sources)).added, true);
  const alias = join(root, 'alias'); await symlink(source, alias);
  assert.equal((await sources.add(alias, root)).added, false);
  assert.deepEqual(await new ExternalSessionSources(registry).directories(), [source]);
});

test('aliases persist per canonical source, update explicitly, and retain citation identity', async t => {
  const { root, source, registry } = await fixture(t);
  const sources = new ExternalSessionSources(registry);
  const command = `/session add codex "${source}"`;
  for (const suffix of ['--wat x', '--name', '--name ""', '--name a --name b', '--name --wat', '--name "oops', 'extra', '--name "a\u001bb"'])
    await assert.rejects(addSessionSource(`${command} ${suffix}`, root, sources));
  assert.deepEqual(await sources.directories(), []);
  await addSessionSource(`${command} --name 'First Person'`, root, sources);
  assert.deepEqual(await new ExternalSessionSources(registry).list(), [{ directory: source, name: 'First Person' }]);
  await writeFile(join(source, 'a.jsonl'), JSON.stringify({ type: 'session_meta', payload: {
    id: 'original', name: 'Codex custom title', cwd: '/work',
  } }));
  const before = (await sources.scan()).sessions[0];
  const alias = join(root, 'link'); await symlink(source, alias);
  const result = await addSessionSource(`/session add codex --name yxing02 '${alias}'`, root, sources);
  assert.equal(result.added, false); assert.equal(result.updated, true);
  await sources.add(source, root);
  const fresh = new ExternalSessionSources(registry);
  assert.deepEqual(await fresh.list(), [{ directory: source, name: 'yxing02' }]);
  const session = (await fresh.scan()).sessions[0];
  assert.equal(session.id, before.id); assert.equal(session.sourceId, before.sourceId);
  const provider = sessionAutocomplete({}, async () => [session]);
  const suggestions = await provider.getSuggestions(['$yxing02'], 0, 8, { signal: new AbortController().signal });
  assert.equal(suggestions.items[0].label, '[Codex · yxing02] original');
  assert.equal(suggestions.items[0].description, '/work');
  assert.equal(suggestions.items[0].value, `$session:${session.id}`);
  const citation = JSON.parse(citeSessions([session]).split('\n')[1]);
  assert.equal(citation.sourceName, 'yxing02'); assert.equal(citation.sourceId, before.sourceId);
  assert.equal(citation.sourceDirectory, source); assert.equal(citation.externalId, 'original');
});

test('recursive bounded metadata reads skip malformed files and symlinks without modifying source', async t => {
  const { root, source, registry } = await fixture(t);
  const sources = new ExternalSessionSources(registry); await sources.add(source, root);
  const text = 'bad json\nnull\n' + meta('same-id') + '\n' + JSON.stringify({ type: 'response_item', payload: 'SECRET BODY' });
  const path = join(source, 'nested', 'a.jsonl'); await writeFile(path, text);
  await writeFile(join(source, 'b.jsonl'), meta('same-id'));
  await writeFile(join(source, 'bad.jsonl'), '{partial');
  await writeFile(join(source, 'oversize.jsonl'), 'x'.repeat(LIMITS.fileBytes + 1) + '\n' + meta('hidden'));
  await symlink(path, join(source, 'link.jsonl'));
  await symlink(source, join(source, 'loop'));
  const result = await sources.scan();
  assert.equal(result.sessions.length, 2);
  assert.equal(new Set(result.sessions.map(s => s.id)).size, 2);
  assert.ok(result.warnings.length);
  assert.ok(result.sessions.every(s => s.source === 'codex-external' && s.allMessagesText === '' && s.messageCount === 0));
  assert.equal(await readFile(path, 'utf8'), text);
  await sources.add(join(source, 'nested'), root);
  assert.equal((await sources.scan()).sessions.length, 2, 'overlapping roots dedupe paths');
});

test('multiple sources and Pi ID collisions remain individually addressable and visibly external', async t => {
  const { root, source, registry } = await fixture(t);
  const other = join(root, 'other'); await mkdir(other);
  const sources = new ExternalSessionSources(registry);
  for (const dir of [source, other]) { await sources.add(dir, root); await writeFile(join(dir, 'a.jsonl'), meta('same')); }
  const { sessions } = await sources.scan();
  const native = { ...sessions[0], source: undefined, id: sessions[0].id, path: '/pi.jsonl' };
  const merged = mergeSessions([native], sessions);
  assert.equal(new Set(merged.map(s => s.id)).size, 3);
  assert.equal(new Set(sessions.map(s => s.sourceId)).size, 2);
  const provider = sessionAutocomplete({}, async () => merged);
  const result = await provider.getSuggestions(['$codex/external'], 0, 15, { signal: new AbortController().signal });
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(i => i.label === '[Codex/external] same' && i.description === '/work'));
  const all = await provider.getSuggestions(['$'], 0, 1, { signal: new AbortController().signal });
  assert.ok(all.items.every(i => i.description === '/work'), 'native and external descriptions only show cwd');
  assert.equal(new Set(all.items.map(i => i.value)).size, 3, 'full IDs still distinguish same-path sessions');
  const citation = citeSessions(sessions);
  assert.match(citation, /"externalId":"same"/); assert.match(citation, /"sourceId"/);
  assert.doesNotMatch(citation, /SECRET BODY/);
});

test('input command persists without path prompting and preserves bare /session statistics', async t => {
  const { root, source, registry } = await fixture(t);
  const handlers = new Map(), notices = [];
  register({ events: { on() {} }, on: (name, handler) => handlers.set(name, handler), registerCommand() {} }, new ExternalSessionSources(registry));
  const ctx = { cwd: root, hasUI: true, ui: { notify: (...args) => notices.push(args) } };
  const input = handlers.get('input');
  assert.equal(await input({ text: '/session' }, ctx), undefined);
  assert.deepEqual(await input({ text: `/session add codex '${source}' --name 'First Person'` }, ctx), { action: 'handled' });
  assert.match(notices[0][0], /Codex\/external · First Person/);
  await input({ text: `/session add codex '${source}' --name yxing02` }, ctx);
  assert.match(notices.at(-1)[0], /已更新.*yxing02/);
  assert.deepEqual(await input({ text: '/session add claude /missing' }, ctx), { action: 'handled' });
  assert.equal(notices.at(-1)[1], 'error');
});
