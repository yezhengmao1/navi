import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './helpers.mjs';
const { registerPanes } = await load('../../../../.pi/extensions/agent-team/panes');

test('unified background run uses nested-tool pipeline without Herdr and preserves failures', async () => {
  let tool;
  registerPanes({ registerTool(t) { tool = t; }, registerCommand() {}, on() {} });
  let captured;
  const ctx = { mode: 'json', async executeTool(...args) {
    captured = args;
    return { result: { content: [{ type: 'text', text: 'failure evidence' }], details: { useful: true }, usage: [{ cost: 1 }] }, isError: true };
  } };
  const params = { action: 'run', backend: 'background', name: 'metrics', instructions: 'Analyze metrics', task: 'Find keys' };
  const result = await tool.execute('x', params, undefined, undefined, ctx);
  assert.equal(captured[0], 'subagent');
  assert.equal(captured[1].definitions[0].instructions, 'Analyze metrics');
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'failure evidence');
  assert.equal(result.usage, undefined, 'nested usage is automatically aggregated by Pi');
  assert.deepEqual(tool.reachesTools(params), ['subagent']);
  await assert.rejects(tool.execute('x', { ...params, readOnly: true }, undefined, undefined, ctx), /require pane/);
  await assert.rejects(tool.execute('x', { ...params, backend: undefined }, undefined, undefined, ctx), /explicit backend/);
});

test('dynamic background definitions execute without role files; parallel/chain remain compatible', async t => {
  const { default: register } = await load('../../../../.pi/extensions/agent-team/index');
  const tools = new Map();
  const pi = { registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, on() {}, events: { emit() {} } };
  register(pi);
  const dir = mkdtempSync(join(tmpdir(), 'pi-dynamic-agent-'));
  const script = join(dir, 'child.cjs');
  const oldScript = process.argv[1];
  t.after(() => { process.argv[1] = oldScript; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(script, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const prompt = fs.readFileSync(args[args.indexOf('--append-system-prompt') + 1], 'utf8');
    console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:prompt + '\\n' + args.at(-1)}], stopReason:'stop'}}));
  `);
  process.argv[1] = script;
  const tool = tools.get('subagent');
  const ctx = { cwd: dir, mode: 'json', hasUI: false, ui: {} };
  const invoke = p => tool.execute('dynamic', p, undefined, undefined, ctx);
  const definitions = [{ name: 'metric-a', instructions: 'Analyze A' }, { name: 'metric-b', instructions: 'Analyze B' }];
  const single = await invoke({ definitions, agent: 'metric-a', task: 'Inspect data' });
  assert.match(single.content[0].text, /Analyze A/);
  const parallel = await invoke({ definitions, tasks: definitions.map(d => ({ agent: d.name, task: 'Inspect' })) });
  assert.equal(parallel.details.results.length, 2);
  const chain = await invoke({ definitions, chain: [{ agent: 'metric-a', task: 'First' }, { agent: 'metric-b', task: 'Use {previous}' }] });
  assert.match(chain.content[0].text, /Analyze A/);
  assert.match(chain.content[0].text, /Analyze B/);
  await assert.rejects(invoke({ definitions: [definitions[0], definitions[0]], agent: 'metric-a', task: 'x' }), /unique valid names/);
});
