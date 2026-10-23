import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { Scheduler, registerScheduler } = await load('../../../../.pi/extensions/agent-team/scheduler');
const spec = {agent: 'test', task: 'check', intervalSeconds: 1, maxRuns: 2, timeoutSeconds: 5};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('delayed first run, non-overlap, completion based interval and bounded runs', async t => {
 t.mock.timers.enable({apis: ['setTimeout', 'Date']});
 let resolve, runs = 0;
 const reports = [];
 const scheduler = new Scheduler(() => { runs++; return new Promise(r => resolve = r); }, (...args) => reports.push(args));
 scheduler.add(spec);
 assert.equal(runs, 0);
 t.mock.timers.tick(1000); assert.equal(runs, 1);
 t.mock.timers.tick(2000); assert.equal(runs, 1);
 resolve('one'); await flush();
 t.mock.timers.tick(999); assert.equal(runs, 1);
 t.mock.timers.tick(1); assert.equal(runs, 2);
 resolve('two'); await flush();
 t.mock.timers.tick(10000); assert.equal(runs, 2);
 assert.equal(scheduler.list()[0].state, 'completed');
 assert.equal(reports.length, 2);
 scheduler.clear();
});

test('cancellation aborts running work and suppresses late delivery', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 let signal, resolve;
 const reports = [];
 const scheduler = new Scheduler((_job, s) => { signal = s; return new Promise(r => resolve = r); }, text => reports.push(text));
 const id = scheduler.add(spec);
 t.mock.timers.tick(1000);
 scheduler.cancel(id);
 assert.equal(signal.aborted, true);
 resolve('late'); await flush();
 assert.deepEqual(reports, []);
 assert.deepEqual(scheduler.list(), []);
});

test('timeout aborts child and reports failure; invalid parameters rejected', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 const reports = [];
 const scheduler = new Scheduler((_job, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort')))), (_id, text) => reports.push(text));
 assert.throws(() => scheduler.add({...spec, intervalSeconds: NaN}));
 assert.throws(() => scheduler.add({...spec, maxRuns: 0}));
 scheduler.add({...spec, maxRuns: 1, timeoutSeconds: 1});
 t.mock.timers.tick(1000); t.mock.timers.tick(1000); await flush();
 assert.match(reports[0], /timed out/);
 assert.equal(scheduler.list()[0].state, 'completed');
 scheduler.clear();
});

test('project confirmation, background delivery and session cleanup', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 const cwd = mkdtempSync(join(tmpdir(), 'pi-schedule-test-'));
 t.after(() => rmSync(cwd, {recursive: true, force: true}));
 mkdirSync(join(cwd, '.pi/agents'), {recursive: true});
 writeFileSync(join(cwd, '.pi/agents/check.md'), '---\nname: check\ndescription: test\n---\nCheck only.');
 let tool, approved = false, executions = 0;
 const hooks = new Map(), messages = [];
 registerScheduler({registerTool: x => tool = x, registerCommand() {}, on: (name, fn) => hooks.set(name, fn),
  sendMessage: (...args) => messages.push(args)}, async () => { executions++; return 'ok'; });
 const ctx = {cwd, mode: 'tui', hasUI: true, isProjectTrusted: () => false,
  ui: {confirm: async () => approved}};
 const params = {action: 'create', agent: 'check', agentScope: 'project', task: 'check once', intervalSeconds: 1};
 await assert.rejects(tool.execute('', params, undefined, undefined, ctx), /not approved/);
 approved = true;
 await tool.execute('', params, undefined, undefined, ctx);
 t.mock.timers.tick(1000); await flush();
 assert.equal(executions, 1);
 assert.equal(messages[0][1].triggerTurn, false);
 hooks.get('session_switch')();
 t.mock.timers.tick(10000); await flush();
 assert.equal(executions, 1);
 const result = await tool.execute('', {action: 'list'}, undefined, undefined, ctx);
 assert.equal(result.content[0].text, '[]');
});

test('dynamic schedule works without role files and captures its definition for every run', async t => {
 t.mock.timers.enable({apis: ['setTimeout', 'Date']});
 const cwd = mkdtempSync(join(tmpdir(), 'pi-schedule-inline-'));
 t.after(() => rmSync(cwd, {recursive: true, force: true}));
 const hooks = new Map(), executions = [], messages = []; let tool;
 registerScheduler({registerTool: value => tool = value, registerCommand() {}, on: (name, fn) => hooks.set(name, fn),
  sendMessage: (...args) => messages.push(args)}, async (agent, task, ctx) => {
   executions.push(structuredClone({agent, task, ctx})); return 'checked';
  });
 t.after(() => hooks.get('session_shutdown')());
 const definition = {name: 'job-check', instructions: 'Read logs only; do not modify jobs.', model: 'provider/reviewer', tools: ['read', 'bash']};
 const ctx = {cwd, mode: 'tui', hasUI: true, isProjectTrusted: () => false, thinkingLevel: 'high', model: {provider: 'lead', id: 'original'},
  ui: {confirm() { assert.fail('explicit inline instructions are not a saved project role'); }}};
 const created = await tool.execute('', {action: 'create', agent: definition.name, definitions: [definition], agentScope: 'project',
  task: 'Check these logs; report progress, no changes.', intervalSeconds: 180, maxRuns: 2, timeoutSeconds: 150}, undefined, undefined, ctx);
 assert.ok(JSON.parse(created.content[0].text).id);
 assert.deepEqual(readdirSync(cwd), [], 'no role/config file is created');
 definition.instructions = 'mutated'; definition.tools.push('write'); definition.model = 'other/model';
 ctx.cwd = '/changed'; ctx.thinkingLevel = 'low'; ctx.model = {provider: 'other', id: 'changed'};
 t.mock.timers.tick(179999); assert.equal(executions.length, 0);
 t.mock.timers.tick(1); await flush(); assert.equal(executions.length, 1);
 t.mock.timers.tick(180000); await flush(); assert.equal(executions.length, 2);
 for (const execution of executions) {
  assert.equal(execution.agent.systemPrompt, 'Read logs only; do not modify jobs.');
  assert.deepEqual(execution.agent.tools, ['read', 'bash']); assert.equal(execution.agent.model, 'provider/reviewer');
  assert.equal(execution.agent.filePath, '<inline-definition>');
  assert.equal(execution.ctx.cwd, cwd); assert.equal(execution.ctx.thinkingLevel, 'high');
  assert.equal(execution.ctx.model.id, 'original');
 }
 assert.equal(messages.length, 2); assert.ok(messages.every(([, options]) => options.triggerTurn === false));
 assert.equal(JSON.parse((await tool.execute('', {action: 'list'}, undefined, undefined, ctx)).content[0].text)[0].state, 'completed');
});

test('dynamic schedule rejects missing/mismatched/invalid roles before arming timers', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 const cwd = mkdtempSync(join(tmpdir(), 'pi-schedule-invalid-'));
 t.after(() => rmSync(cwd, {recursive: true, force: true}));
 const hooks = new Map(); let tool;
 registerScheduler({registerTool: value => tool = value, registerCommand() {}, on: (name, fn) => hooks.set(name, fn)}, async () => assert.fail('invalid schedule must never run'));
 t.after(() => hooks.get('session_shutdown')());
 const ctx = {cwd, mode: 'tui'};
 const params = {action: 'create', agent: 'job-check', agentScope: 'project', task: 'check', intervalSeconds: 180};
 const invoke = extra => tool.execute('', {...params, ...extra}, undefined, undefined, ctx);
 await assert.rejects(invoke({}), /Available: none.*Supply definitions/);
 await assert.rejects(invoke({agent: undefined}), /agent, task and intervalSeconds required/);
 const valid = {name: 'job-check', instructions: 'Check only'};
 await assert.rejects(invoke({definitions: [{...valid, name: 'other'}]}), /Unknown agent.*Supply definitions/);
 await assert.rejects(invoke({definitions: [valid, valid]}), /unique valid names/);
 await assert.rejects(invoke({definitions: [{...valid, name: '../bad'}]}), /unique valid names/);
 await assert.rejects(invoke({definitions: [{...valid, instructions: '  '}]}), /nonempty instructions/);
 await assert.rejects(invoke({definitions: [{...valid, tools: [123]}]}), /array of strings/);
 await assert.rejects(invoke({definitions: Array.from({length: 9}, (_, i) => ({...valid, name: `agent-${i}`}))}), /At most 8/);
 t.mock.timers.tick(180000); await flush();
 assert.equal((await tool.execute('', {action: 'list'}, undefined, undefined, ctx)).content[0].text, '[]');
});

test('dynamic definitions override saved roles without modifying them; cancellation and reload clear schedules', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 const cwd = mkdtempSync(join(tmpdir(), 'pi-schedule-override-'));
 t.after(() => rmSync(cwd, {recursive: true, force: true}));
 mkdirSync(join(cwd, '.pi/agents'), {recursive: true});
 writeFileSync(join(cwd, '.pi/agents/check.md'), '---\nname: check\ndescription: test\n---\nSaved role.');
 const hooks = new Map(), executions = []; let tool;
 registerScheduler({registerTool: value => tool = value, registerCommand() {}, on: (name, fn) => hooks.set(name, fn), sendMessage() {}},
  async agent => { executions.push(agent.systemPrompt); return 'ok'; });
 t.after(() => hooks.get('session_shutdown')());
 const ctx = {cwd, mode: 'tui', isProjectTrusted: () => true};
 const base = {action: 'create', agent: 'check', agentScope: 'project', task: 'check', intervalSeconds: 1, maxRuns: 1};
 const invoke = params => tool.execute('', params, undefined, undefined, ctx);
 const inline = {...base, definitions: [{name: 'check', instructions: 'Inline role.'}]};
 await invoke(inline); await invoke(base);
 t.mock.timers.tick(1000); await flush(); assert.deepEqual(executions.sort(), ['Inline role.', 'Saved role.']);
 const cancelled = JSON.parse((await invoke(inline)).content[0].text);
 await invoke({action: 'cancel', id: cancelled.id});
 await invoke(inline); hooks.get('session_shutdown')();
 t.mock.timers.tick(10000); await flush(); assert.equal(executions.length, 2);
 assert.equal((await invoke({action: 'list'})).content[0].text, '[]');
});

test('shared concurrency is FIFO; queued cancellation does not consume a run', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 const started = [], pending = [], released = [];
 const scheduler = new Scheduler(job => {
  started.push(job.task); return new Promise(resolve => pending.push(resolve));
 }, () => {}, 2, id => released.push(id));
 const ids = ['a', 'b', 'c', 'd'].map(task => scheduler.add({...spec, task, maxRuns: 1}));
 t.mock.timers.tick(1000);
 assert.deepEqual(started, ['a', 'b']);
 assert.equal(scheduler.list()[2].state, 'queued');
 assert.equal(scheduler.list()[2].runs, 0);
 scheduler.cancel(ids[2]);
 pending.shift()('a'); await flush();
 assert.deepEqual(started, ['a', 'b', 'd']);
 pending.shift()('b'); pending.shift()('d'); await flush();
 assert.equal(new Set(released).size, 4);
 assert.ok(scheduler.list().every(job => job.state === 'completed'));
 scheduler.clear();
});

test('clear does not free a running slot until its aborted child settles', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 let resolve;
 const started = [];
 const scheduler = new Scheduler(job => { started.push(job.task); return new Promise(r => resolve = r); }, () => {}, 1);
 scheduler.add({...spec, task: 'old'});
 t.mock.timers.tick(1000);
 scheduler.clear();
 scheduler.add({...spec, task: 'new', maxRuns: 1});
 t.mock.timers.tick(1000);
 assert.deepEqual(started, ['old']);
 resolve('late'); await flush();
 assert.deepEqual(started, ['old', 'new']);
 resolve('new'); await flush();
 scheduler.clear();
});

test('on_change reports first result and changes, including changes beyond display cap', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 const reports = [];
 const prefix = 'x'.repeat(13000);
 const results = [prefix + 'a', prefix + 'a', prefix + 'b', 'Failed: error', 'recovered'];
 const scheduler = new Scheduler(async () => results.shift(), (_id, text) => reports.push(text));
 scheduler.add({...spec, maxRuns: 5, report: 'on_change'});
 for (let i = 0; i < 5; i++) { t.mock.timers.tick(1000); await flush(); }
 assert.equal(reports.length, 4);
 assert.match(reports[0], /Output truncated/);
 assert.equal(scheduler.list()[0].runs, 5);
 assert.equal(scheduler.list()[0].lastResult, 'recovered');
 assert.equal('reportedHash' in scheduler.list()[0], false);
 scheduler.clear();
});

test('default reports every run; on_change retries after synchronous delivery failure', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 let always = 0, attempts = 0;
 const a = new Scheduler(async () => 'same', () => always++);
 const b = new Scheduler(async () => 'same', () => { if (++attempts === 1) throw new Error('delivery'); });
 a.add(spec); b.add({...spec, report: 'on_change'});
 for (let i = 0; i < 2; i++) { t.mock.timers.tick(1000); await flush(); }
 assert.equal(always, 2); assert.equal(attempts, 2);
 a.clear(); b.clear();
});

test('registers tool and command; disallows non-interactive creation', async () => {
 let tool, command;
 const hooks = [];
 registerScheduler({registerTool: t => tool = t, registerCommand: (name, c) => command = name, on: name => hooks.push(name)}, async () => 'ok');
 assert.equal(tool.name, 'subagent_schedule'); assert.equal(command, 'schedules');
 assert.deepEqual(hooks, ['session_start', 'session_switch', 'session_shutdown']);
 await assert.rejects(tool.execute('', {action: 'create'}, undefined, undefined, {mode: 'print'}), /interactive/);
});
