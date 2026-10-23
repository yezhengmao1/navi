import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { load, tui } from './helpers.mjs';
const { registerScheduler, renderScheduleWidget, Scheduler } = await load('../../../../.pi/extensions/agent-team/scheduler');
const { renderSelectionCard } = await load('editor-footer');
const { visibleWidth } = tui;
const flush = () => new Promise(resolve => setImmediate(resolve));
const theme = {fg: (_color, text) => text, bold: text => text};

function fixture(t) {
 t.mock.timers.enable({apis: ['setTimeout', 'Date']});
 let tool, command;
 const hooks = new Map(), widgets = new Map([['subagent-status', 'existing'], ['team-status', 'existing']]);
 const updates = [], pending = [], messages = [];
 registerScheduler({registerTool: value => tool = value, registerCommand: (_name, value) => command = value,
  on: (name, fn) => hooks.set(name, fn), sendMessage: (...args) => messages.push(args)},
  (_agent, _task, _ctx, signal) => new Promise(resolve => pending.push({resolve, signal})));
 const ctx = {cwd: process.cwd(), mode: 'tui', ui: {
  setWidget(key, value) { updates.push(key); widgets.set(key, value); }, notify() {},
 }};
 const invoke = params => tool.execute('', params, undefined, undefined, ctx);
 const create = async (extra = {}) => JSON.parse((await invoke({action: 'create', agent: 'check',
  definitions: [{name: 'check', instructions: 'Check only'}], task: 'Check logs', intervalSeconds: 3,
  maxRuns: 1, ...extra})).content[0].text);
 const lines = () => widgets.get('subagent-schedules')?.({}, theme).render(200).join('\n') ?? '';
 t.after(() => hooks.get('session_shutdown')());
 return {hooks, widgets, updates, pending, messages, ctx, invoke, create, lines, command};
}

test('persistent widget updates countdown, FIFO states and progress, retains completion without refresh timers', async t => {
 const f = fixture(t);
 assert.equal(f.widgets.has('subagent-schedules'), false);
 const a = await f.create(); await f.create(); await f.create();
 assert.match(f.lines(), /等待 3s · 0\/1 · check/);
 assert.match(f.lines(), new RegExp(a.id.slice(0, 8)));
 assert.match(f.lines(), /Check logs/);
 t.mock.timers.tick(1000); assert.match(f.lines(), /等待 2s/);
 t.mock.timers.tick(2000);
 assert.equal(f.pending.length, 2);
 assert.match(f.lines(), /运行中 · 1\/1/); assert.match(f.lines(), /排队中 · 0\/1/);
 const updates = f.updates.length;
 t.mock.timers.tick(1000); assert.equal(f.updates.length, updates, 'no polling when none waiting');
 f.pending[0].resolve('ok'); await flush();
 assert.equal(f.pending.length, 3); assert.match(f.lines(), /已完成 · 1\/1/);
 f.pending[1].resolve('ok'); f.pending[2].resolve('ok'); await flush();
 assert.equal(f.messages.length, 3); assert.ok(f.messages.every(([, opts]) => opts.triggerTurn === false));
 const completedUpdates = f.updates.length;
 t.mock.timers.tick(20000); assert.equal(f.updates.length, completedUpdates);
 assert.match(f.lines(), /已完成/);
 assert.ok(f.updates.every(key => key === 'subagent-schedules'));
 assert.equal(f.widgets.get('subagent-status'), 'existing');
 await f.command.handler('stop all', f.ctx); assert.equal(f.lines(), '');
});

test('subsequent countdown begins at completion, with a single refreshed widget timer', async t => {
 const f = fixture(t);
 await f.create({maxRuns: 2});
 t.mock.timers.tick(3000); t.mock.timers.tick(2000);
 assert.match(f.lines(), /运行中 · 1\/2/);
 f.pending[0].resolve('first'); await flush();
 assert.match(f.lines(), /等待 3s · 1\/2/);
 const updates = f.updates.length;
 t.mock.timers.tick(1000); assert.equal(f.updates.length, updates + 1);
 assert.match(f.lines(), /等待 2s/);
 t.mock.timers.tick(2000); assert.match(f.lines(), /运行中 · 2\/2/);
 f.pending[1].resolve('last'); await flush(); assert.match(f.lines(), /已完成 · 2\/2/);
});

test('cancel removes waiting, queued and running rows; late completion cannot resurrect widget', async t => {
 const f = fixture(t);
 const waiting = await f.create();
 await f.invoke({action: 'cancel', id: waiting.id}); assert.equal(f.lines(), '');
 const running = await f.create(); await f.create(); const queued = await f.create();
 t.mock.timers.tick(3000);
 await f.command.handler(`stop ${queued.id}`, f.ctx); assert.doesNotMatch(f.lines(), /排队中/);
 await f.invoke({action: 'cancel', id: running.id}); assert.equal(f.pending[0].signal.aborted, true);
 await f.invoke({action: 'cancel', id: 'all'}); assert.equal(f.lines(), '');
 const updates = f.updates.length;
 for (const p of f.pending) p.resolve('late'); await flush();
 t.mock.timers.tick(10000);
 assert.equal(f.updates.length, updates); assert.deepEqual(f.messages, []);
 await f.create(); assert.match(f.lines(), /等待 3s/);
});

for (const event of ['session_start', 'session_switch', 'session_shutdown']) {
 test(`${event} clears widget and timers idempotently, suppresses late delivery`, async t => {
  const f = fixture(t);
  await f.create(); t.mock.timers.tick(3000); await f.create();
  f.hooks.get(event)(); f.hooks.get(event)();
  assert.equal(f.lines(), ''); assert.equal(f.pending[0].signal.aborted, true);
  const updates = f.updates.length;
  f.pending[0].resolve('late'); await flush(); t.mock.timers.tick(10000);
  assert.equal(f.updates.length, updates); assert.deepEqual(f.messages, []);
 });
}

test('render sanitizes input, respects narrow/Unicode widths and applies current theme', () => {
 const rows = [{id: 'abcdefgh-rest', agent: '\x1b[31m测试\nagent', task: '\x1b]0;evil\x07任务\t👋', runs: 0, maxRuns: 2, state: 'waiting', nextRunAt: 1500}];
 for (const width of [0, 1, 2, 3, 4, 5, 8, 30, 80]) {
  const lines = renderScheduleWidget(rows, width, theme, 1000);
  assert.ok(lines.every(line => visibleWidth(line) <= width));
  assert.ok(lines.every(line => !/[\x00-\x1f\x7f]/.test(stripVTControlCharacters(line))));
  assert.ok(lines.every(line => !line.includes('\x1b[31m') && !line.includes('evil')));
 }
 const text = renderScheduleWidget(rows, 200, theme, 2000).join('\n');
 assert.match(text, /等待 0s/); assert.match(text, /测试 agent/); assert.doesNotMatch(text, /evil/);
 const colors = [];
 renderScheduleWidget(rows, 200, {...theme, fg: (color, text) => { colors.push(color); return text; }});
 assert.deepEqual(colors.slice(0, 3), ['accent', 'muted', 'dim']);
 assert.ok(colors.slice(3).length > 0);
 assert.ok(colors.slice(3).every(color => color === 'border'), 'frame uses the questionnaire border theme color');
});

test('render adds one blank line and the questionnaire frame with ANSI-safe column widths', () => {
 const rows = ['waiting', 'running', 'queued', 'completed'].map(state => ({
  id: 'abcdefgh-rest', agent: '测试👩‍💻e\u0301', task: '任务 👋 e\u0301'.repeat(30),
  runs: 1, maxRuns: 2, state, nextRunAt: 2000,
 }));
 const styled = {
  fg: (color, text) => `\x1b[${{border: 90, accent: 36, muted: 37, dim: 2, success: 32}[color]}m${text}\x1b[0m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
 };
 for (const width of [6, 8, 17, 30, 80, 200]) {
  const lines = renderScheduleWidget(rows, width, styled, 1000);
  const plain = lines.map(stripVTControlCharacters);
  assert.equal(lines[0], '', 'exactly one leading blank line');
  assert.equal(lines.length, rows.length + 5);
  assert.equal(plain[1], `┌${'─'.repeat(width - 2)}┐`);
  assert.equal(plain[3], `├${'─'.repeat(width - 2)}┤`);
  assert.equal(plain.at(-1), `└${'─'.repeat(width - 2)}┘`);
  assert.ok(lines.slice(1).every(line => visibleWidth(line) === width), `aligned at width ${width}`);
  assert.ok([plain[2], ...plain.slice(4, -1)].every(line => line.startsWith('│ ') && line.endsWith(' │')));
 }
 const plain = renderScheduleWidget(rows, 200, styled, 1000).map(stripVTControlCharacters);
 assert.match(plain[2], /^│ 🤖 定时子任务  4/);
 assert.match(plain[4], /测试👩‍💻e\u0301/);
 for (const width of [1, 2, 3, 4, 5]) {
  const lines = renderScheduleWidget(rows, width, styled);
  assert.equal(lines[0], '');
  assert.equal(lines.length, rows.length + 2, 'tiny widths omit the box');
  assert.ok(lines.every(line => visibleWidth(line) <= width));
 }
 // Compare ANSI output with the actual questionnaire renderer, not a separate
 // invented box. Scheduler has no actions/hints, so omit that footer's divider.
 for (const width of [1, 2, 3, 4, 5, 6, 17, 80, 200, 80.9]) {
  for (const activeTheme of [theme, styled]) {
   const bodyLines = rows.map(job => {
    const status = {waiting: '[ ] 等待 1s', running: '[>] 运行中', queued: '[ ] 排队中', completed: '[+] 已完成'}[job.state];
    const color = job.state === 'completed' ? 'success' : job.state === 'running' ? 'accent' : 'muted';
    return activeTheme.fg(color, `${status} · 1/2 · ${job.agent} #abcdefgh`)
     + activeTheme.fg('dim', ` · ${job.task}`);
   });
   const expected = renderSelectionCard({width, theme: activeTheme,
    title: '🤖 定时子任务  4', items: [], cursor: -1, hints: [], bodyLines});
   if (width >= 6) expected.splice(-2, 1);
   assert.deepEqual(renderScheduleWidget(rows, width, activeTheme, 1000), ['', ...expected]);
  }
 }
 assert.deepEqual(renderScheduleWidget([], 80, styled), []);
 assert.deepEqual(renderScheduleWidget(rows, 0, styled), []);
});

test('render observer failures cannot break scheduling semantics', async t => {
 t.mock.timers.enable({apis: ['setTimeout']});
 let runs = 0;
 const scheduler = new Scheduler(async () => { runs++; return 'ok'; }, () => {}, 2, () => {}, () => { throw Error('UI'); });
 scheduler.add({agent: 'a', task: 't', intervalSeconds: 1, maxRuns: 1, timeoutSeconds: 2});
 t.mock.timers.tick(1000); await flush();
 assert.equal(runs, 1); assert.equal(scheduler.list()[0].state, 'completed'); scheduler.clear();
});

test('non-TUI list/cancel and rejected create never install widgets', async t => {
 const f = fixture(t); f.ctx.mode = 'rpc';
 await assert.rejects(f.create(), /interactive/);
 await f.invoke({action: 'list'}); await f.invoke({action: 'cancel', id: 'all'});
 assert.deepEqual(f.updates, []);
});
