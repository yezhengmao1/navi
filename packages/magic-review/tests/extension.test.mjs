import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function load(t, missingCollectExports = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'magic-ext-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let source = stripTypeScriptTypes(await readFile(new URL('../extensions/magic-review.ts', import.meta.url), 'utf8'));
  source = source.replace(/import \{ Type \} from '@earendil-works\/pi-ai';/, 'const Type = new Proxy({}, {get:()=> (...args)=>({args})});')
    .replace(/import\('(\.\.\/lib\/[^']+)'\)/g, (_, p) => `import('${new URL(p, new URL('../extensions/magic-review.ts', import.meta.url))}')`)
    .replace("import { browseReview, reviewWidget } from './browser.js';", 'const browseReview=async()=>undefined, reviewWidget=()=>({render:()=>[],invalidate(){}});')
    .replace("import { showConfirmation } from '../../pi/extensions/magic-ui/confirmation.js';", 'const showConfirmation = (ctx, ...args) => ctx.ui.custom(...args);')
    .replace("import { selectCard, inputCard } from '../../pi/extensions/magic-ui/dialogs.js';", 'const selectCard = (ctx, ...args) => ctx.ui.custom(...args), inputCard = selectCard;');
  if (missingCollectExports) source = source.replace(/await import\('[^']*\/lib\/collect\.mjs'\)/, 'await Promise.resolve({})');
  const invoke = stripTypeScriptTypes(await readFile(new URL('../extensions/invoke.ts', import.meta.url), 'utf8'));
  await writeFile(path.join(dir, 'invoke.mjs'), invoke);
  source = source.replace("'./invoke.js'", "'./invoke.mjs'");
  await writeFile(path.join(dir, 'index.mjs'), source);
  const factory = (await import(pathToFileURL(path.join(dir, 'index.mjs')).href)).default;
  const tools = new Map(), commands = new Map(), events = new Map();
  await factory({ registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, cmd) => commands.set(name, cmd), on: (name, handler) => events.set(name, handler), sendUserMessage() {} });
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

test('backend=team requires subagent, then runs three tracks and a separate verifier without team', async t => {
  const { tools, dir } = await load(t);
  const run = tools.get('magic_review_run');
  assert.deepEqual(run.reachesTools({ backend: 'team' }), ['subagent']);
  assert.deepEqual(run.reachesTools({ backend: 'model' }), []);
  assert.deepEqual(run.reachesTools({}), ['subagent']); // resume can inherit backend=team
  const calls = [];
  const ctx = { cwd: dir, tools: [{ name: 'team' }], async executeTool(name, args, { signal }) {
    assert.equal(name, 'subagent');
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(args).sort(), ['agent', 'agentScope', 'cwd', 'definitions', 'task']);
    assert.equal(args.cwd, dir);
    assert.equal(args.agentScope, 'user');
    assert.equal(args.definitions.length, 1);
    const [definition] = args.definitions;
    assert.equal(definition.name, args.agent);
    assert.deepEqual(definition.tools, ['read']);
    assert.match(args.task, /main\.tex/);
    const verifying = definition.instructions.includes('magic-review verify worker');
    if (verifying) assert.equal(calls.length, 3);
    else assert.match(definition.instructions, /magic-review discover worker/);
    calls.push(args.agent);
    const text = verifying ? '{"verdicts":[],"summary":"Verified"}' : '{"findings":[],"reviewed":["main.tex"],"limitations":[]}';
    const worker = { exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 1, cost: 0 } };
    return { isError: false, result: { details: { mode: 'single', results: [worker] } } };
  } };
  await writeFile(path.join(dir, 'main.tex'), '\\section{Test}');
  const prepared = await tools.get('magic_review_prepare').execute('p', { kind: 'paper', target: 'main.tex' }, undefined, undefined, ctx);
  const args = { id: prepared.details.id, backend: 'team' };
  const missing = await run.execute('r1', args, undefined, undefined, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.details.error, /requires the subagent tool/);
  assert.equal(calls.length, 0);
  ctx.tools = [{ name: 'subagent' }];
  const completed = await run.execute('r2', args, undefined, undefined, ctx);
  assert.equal(completed.details.state, 'completed', completed.details.error);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls).size, 4);
  assert.equal(completed.details.summary, 'Verified');
  assert.equal(completed.details.usage.totalTokens, 40);
});

test('missing library exports fail at startup with an actionable error', async t => {
  await assert.rejects(load(t, true), /Magic Review: missing function export collectCode.*same package revision/);
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
