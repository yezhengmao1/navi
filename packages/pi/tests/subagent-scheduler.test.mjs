import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
