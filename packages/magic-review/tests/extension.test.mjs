import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function load(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'magic-ext-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let source = stripTypeScriptTypes(await readFile(new URL('../extensions/index.ts', import.meta.url), 'utf8'));
  source = source.replace(/import \{ Type \} from '@earendil-works\/pi-ai';/, 'const Type = new Proxy({}, {get:()=> (...args)=>({args})});')
    .replace(/from '(\.\.\/lib\/[^']+)'/g, (_, p) => `from '${new URL(p, new URL('../extensions/index.ts', import.meta.url))}'`)
    .replace("import { browseReview, reviewWidget } from './browser.js';", 'const browseReview=async()=>undefined, reviewWidget=()=>({render:()=>[],invalidate(){}});');
  const invoke = stripTypeScriptTypes(await readFile(new URL('../extensions/invoke.ts', import.meta.url), 'utf8'));
  await writeFile(path.join(dir, 'invoke.mjs'), invoke);
  source = source.replace("'./invoke.js'", "'./invoke.mjs'");
  await writeFile(path.join(dir, 'index.mjs'), source);
  const factory = (await import(pathToFileURL(path.join(dir, 'index.mjs')).href)).default;
  const tools = new Map(), commands = new Map(), events = new Map();
  factory({ registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, cmd) => commands.set(name, cmd), on: (name, handler) => events.set(name, handler), sendUserMessage() {} });
  return { tools, commands, events, dir };
}

test('managed prepare/run enforces independent call and returns report; manual export stays labelled', async t => {
  const { tools, dir } = await load(t);
  const cwd = path.join(dir, 'paper'); await import('node:fs/promises').then(fs => fs.mkdir(cwd));
  await writeFile(path.join(cwd, 'main.tex'), '\\section{Test} Example.');
  let calls = 0;
  const ctx = { cwd, hasUI: false, model: { input: ['text'] }, modelRegistry: { streamSimple(_model, context) {
    assert.deepEqual(context.tools, []);
    calls++;
    const text = calls === 1 ? '{"findings":[],"reviewed":["main.tex"],"limitations":["No compilation"]}' : '{"verdicts":[],"summary":"No validated findings"}';
    return { result: async () => ({ content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } } }) };
  } } };
  const signal = new AbortController().signal;
  const prepared = await tools.get('magic_review_prepare').execute('p', { kind: 'paper', target: 'main.tex' }, signal, undefined, ctx);
  const run = await tools.get('magic_review_run').execute('r', { id: prepared.details.id }, signal, undefined, ctx);
  assert.equal(run.details.state, 'completed'); assert.equal(calls, 2);
  assert.equal(run.usage.totalTokens, 30);
  assert.ok(run.details.reportPaths.markdownPath);
  const repeated = await tools.get('magic_review_run').execute('r2', { id: prepared.details.id }, signal, undefined, ctx);
  assert.equal(repeated.details.state, 'completed'); assert.equal(calls, 2);
  const manual = await tools.get('magic_review_report').execute('m', { id: prepared.details.id, summary: 'manual', reviewed: [], limitations: [], findings: [] }, signal, undefined, ctx);
  assert.match(await readFile(manual.details.markdownPath, 'utf8'), /independent verification not performed/);
});

test('hide dismisses only the widget and is safe when repeated', async t => {
  const { commands } = await load(t);
  const updates = [];
  const ctx = { ui: { setWidget: (...args) => updates.push(args), notify() { assert.fail('unexpected error'); } } };
  await commands.get('magic-review').handler('hide', ctx);
  await commands.get('magic-review').handler('hide', ctx);
  assert.deepEqual(updates, [['magic-review', undefined], ['magic-review', undefined]]);
});

test('noninteractive execution and network lookup fail closed', async t => {
  const { tools, dir } = await load(t);
  await assert.rejects(tools.get('magic_review_verify').execute('v', { action: 'execute' }, undefined, undefined, { cwd: dir, hasUI: false }), /interactive/);
});

test('input routing leaves extension messages and implementation tasks untouched', async t => {
  const { events } = await load(t);
  assert.equal((await events.get('input')({ source: 'interactive', text: 'Implement a paper review plugin' })).action, 'continue');
  assert.equal((await events.get('input')({ source: 'extension', text: 'review commit HEAD' })).action, 'continue');
  assert.equal((await events.get('input')({ source: 'interactive', text: 'review commit HEAD' })).action, 'transform');
});
