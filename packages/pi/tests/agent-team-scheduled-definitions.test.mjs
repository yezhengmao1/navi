import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './helpers.mjs';

// Exercise the real scheduler -> isolated subagent executor path, but replace
// the model CLI with a local JSON fixture. No model requests or live monitors.
test('inline scheduled role reaches the isolated child with its prompt/model/tools', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { default: register } = await load('../../../../.pi/extensions/agent-team/index');
  const cwd = mkdtempSync(join(tmpdir(), 'pi-scheduled-child-'));
  const script = join(cwd, 'child.cjs');
  writeFileSync(script, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const prompt = fs.readFileSync(args[args.indexOf('--append-system-prompt') + 1], 'utf8');
    const model = args[args.indexOf('--model') + 1];
    const tools = args[args.indexOf('--tools') + 1];
    console.log(JSON.stringify({type: 'message_end', message: {role: 'assistant',
      content: [{type: 'text', text: [prompt, model, tools, args.at(-1)].join('\\n')}], stopReason: 'stop'}}));
  `);
  const oldScript = process.argv[1]; process.argv[1] = script;
  const hooks = new Map(), tools = new Map(); let deliver;
  const reported = new Promise(resolve => { deliver = resolve; });
  register({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
    events: { emit() {} }, on(name, fn) { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); },
    sendMessage(message, options) { deliver({ message, options }); } });
  t.after(async () => {
    for (const fn of hooks.get('session_shutdown') ?? []) await fn({}, { mode: 'json' });
    process.argv[1] = oldScript;
    rmSync(cwd, { recursive: true, force: true });
  });
  const tool = tools.get('subagent_schedule');
  const ctx = { cwd, mode: 'tui', hasUI: false, thinkingLevel: 'low', isProjectTrusted: () => false };
  await tool.execute('schedule', { action: 'create', agent: 'monitor-fixture', agentScope: 'project',
    definitions: [{ name: 'monitor-fixture', instructions: 'Read logs only. Never modify jobs.', model: 'test/model', tools: ['read', 'bash'] }],
    task: 'Inspect log fixture once.', intervalSeconds: 1, maxRuns: 1, timeoutSeconds: 5 }, undefined, undefined, ctx);
  t.mock.timers.tick(1000);
  const result = await reported;
  assert.match(result.message.content, /Completed: monitor-fixture/);
  assert.match(result.message.content, /Read logs only. Never modify jobs./);
  assert.match(result.message.content, /test\/model/);
  assert.match(result.message.content, /read,bash/);
  assert.match(result.message.content, /Inspect log fixture once./);
  assert.equal(result.options.triggerTurn, false);
});
