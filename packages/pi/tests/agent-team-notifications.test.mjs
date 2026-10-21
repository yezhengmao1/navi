import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { decodeHerdrResponse } = await load('../../../../.pi/extensions/agent-team/herdr-response');
const { PendingTeamNotices } = await load('../../../../.pi/extensions/agent-team/team-notifications');
const { registerPanes } = await load('../../../../.pi/extensions/agent-team/panes');

test('terminal reads are literal text, including Unicode, empty output and JSON-looking member output', () => {
  for (const text of [' You are team member', ' codex-backend', ' .agents/skills', '┃\n  ▀▀█ v1', '│\n Task task-1', '', '{"result":{"not":"an envelope"}}']) {
    assert.deepEqual(decodeHerdrResponse(['agent', 'read', 'member'], text), { text });
    assert.deepEqual(decodeHerdrResponse(['pane', 'read', 'w:p1'], text), { text });
  }
  assert.deepEqual(decodeHerdrResponse(['agent', 'get', 'member'], '{"result":{"agent":"pi"}}'), { agent: 'pi' });
  assert.throws(() => decodeHerdrResponse(['agent', 'get', 'member'], 'not JSON'));
});

test('pending notices revalidate current task state, coalesce by ID, and use current evidence/mode', () => {
  const pending = new PendingTeamNotices();
  const state = { label: 'team', notify: 'wake', tasks: [
    { id: 'done', member: 'a', state: 'review', output: 'old' },
    { id: 'fresh', member: 'b', state: 'blocked', error: 'ask lead' },
  ] };
  pending.add([{ id: 'done', state: 'review' }, { id: 'fresh', state: 'blocked' }, { id: 'fresh', state: 'blocked' }]);
  state.tasks[0].state = 'completed';
  const notice = pending.take(state);
  assert.equal(notice.details.notices.length, 1); assert.doesNotMatch(notice.content, /old|done \(/);
  assert.equal(pending.take(state), undefined);
  pending.add([{ id: 'fresh', state: 'blocked' }]); state.tasks[1].state = 'running';
  assert.equal(pending.take(state), undefined);
  state.tasks[1].state = 'review'; state.tasks[1].output = 'new result'; delete state.tasks[1].error;
  pending.add([{ id: 'fresh', state: 'review' }]); state.notify = 'message';
  assert.equal(pending.take(state).wake, false);
  pending.add([{ id: 'fresh', state: 'review' }]); pending.clear(); assert.equal(pending.take(state), undefined);
});

function adapterFixture() {
  const old = { ...process.env };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p0', HERDR_SOCKET_PATH: '/fake' });
  const hooks = new Map(), sent = [], prompts = [], entries = [], widgets = [], memberStates = new Map(); let tool, command, idle = false, beforeRead = async () => {};
  const members = ['a', 'b'].map(name => ({ name, target: name, pane: `w:${name}`, terminal: name, session: `/${name}.jsonl`, cwd: '/repo', state: 'working' }));
  for (const m of members) memberStates.set(m.name, 'done');
  entries.push({ type: 'custom', customType: 'agent-team', data: { version: 2, scope: '/fake:w:p0:lead', label: 'team', anchor: 'w:p0', members,
    tasks: members.map(m => ({ id: `task-${m.name}`, member: m.name, text: 'Inspect', state: 'running', active: true, dependsOn: [] })), notify: 'wake', resources: [] } });
  const agent = m => ({ agent: 'pi', pane_id: m.pane, terminal_id: m.terminal, agent_session: { value: m.session }, agent_status: memberStates.get(m.name) });
  const pi = {
    on(n, fn) { hooks.set(n, fn); }, registerTool(t) { tool = t; }, registerCommand(_name, c) { command = c; },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    sendMessage(message, options) { sent.push({ message, options }); if (options.triggerTurn) idle = false; },
    sendUserMessage(message) { prompts.push(message); },
    async exec(_binary, args) {
      // Real CLI contract: reads print raw text, control commands print JSON envelopes.
      if (args[1] === 'read') { await beforeRead(); return { code: 0, stdout: `│ Report from ${args[2]}\nVerified findings` }; }
      const result = args[1] === 'list' ? { agents: members.map(agent) } : { agent: agent(members.find(m => m.name === args[2])) };
      return { code: 0, stdout: JSON.stringify({ result }) };
    },
  };
  const ctx = { cwd: '/repo', mode: 'tui', hasUI: true, isIdle: () => idle, ui: { notify() {}, setWidget(key, value) { widgets.push({ key, value }); } }, sessionManager: { getSessionId: () => 'lead', getBranch: () => entries } };
  registerPanes(pi);
  return {
    sent, prompts, hooks, ctx, entries, widgets,
    command: args => command.handler(args, ctx),
    setIdle(value) { idle = value; },
    beforeRead(fn) { beforeRead = fn; },
    invoke: p => tool.execute('id', p, undefined, undefined, ctx),
    boundary(extra = {}) { return hooks.get('agent_before_settle')({ outcome: 'completed', context: { canContinue: true }, entries: [], ...extra }, ctx); },
    async close() {
      await hooks.get('session_shutdown')();
      for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH']) {
        if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
      }
    },
  };
}

test('team start prompt delegates primary work and limits lead to coordination and evidence review', async () => {
  const f = adapterFixture();
  try {
    await f.command('start 从代码整洁和功能正确性审查修改');
    assert.equal(f.prompts.length, 1);
    const prompt = f.prompts[0];
    assert.match(prompt, /主体工作交给成员执行/);
    assert.match(prompt, /不要自行重复执行/);
    assert.match(prompt, /独立交叉核验/);
    assert.match(prompt, /不要执行 bash sleep/);
    assert.match(prompt, /结束当前轮/);
    assert.match(prompt, /不自行恢复监控/);
    assert.match(prompt, /小规模证据抽查/);
    assert.match(prompt, /先向用户说明原因和接手范围/);
    assert.match(prompt, /均使用中文/);
    assert.ok(prompt.endsWith('目标：从代码整洁和功能正确性审查修改'));
  } finally { await f.close(); }
});

test('status command renders a panel without waking the lead, updates on pause, and hides/cleans up', async () => {
  const f = adapterFixture();
  const theme = { fg: (_color, text) => text };
  const panelText = () => f.widgets.at(-1).value(undefined, theme).render(120).join('\n');
  try {
    await f.command('');
    assert.equal(f.widgets.at(-1).key, 'agent-team-status');
    assert.match(panelText(), /团队 · team/); assert.match(panelText(), /待验收/);
    assert.doesNotMatch(panelText(), /"members"|"tasks"/); assert.equal(f.sent.length, 0);
    await f.command('resume'); assert.match(panelText(), /监控：运行中/);
    await f.command('pause'); assert.match(panelText(), /监控：已暂停/);
    await f.command('hide'); assert.equal(f.widgets.at(-1).value, undefined);
    await f.command('status'); assert.equal(typeof f.widgets.at(-1).value, 'function');
  } finally { await f.close(); }
  assert.equal(f.widgets.at(-1).value, undefined);
});

test('bare /team toggles the panel, while status shows and hide hides explicitly', async () => {
  const f = adapterFixture();
  try {
    await f.command('');
    assert.equal(typeof f.widgets.at(-1).value, 'function');
    await f.command('   ');
    assert.equal(f.widgets.at(-1).value, undefined);
    await f.command('');
    assert.equal(typeof f.widgets.at(-1).value, 'function');
    await f.command('status');
    assert.equal(typeof f.widgets.at(-1).value, 'function');
    await f.command('hide');
    assert.equal(f.widgets.at(-1).value, undefined);
    await f.command('hide');
    assert.equal(f.widgets.at(-1).value, undefined);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test('hide wins over a slow status command completing later', async () => {
  for (const viaTool of [false, true]) {
    const f = adapterFixture();
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    f.beforeRead(async () => { entered(); await wait; });
    let pending;
    try {
      pending = f.command('status');
      await ready;
      if (viaTool) await f.invoke({ action: 'hide' }); else await f.command('hide');
      release(); await pending;
      assert.equal(f.widgets.at(-1).value, undefined);
      assert.ok(!f.widgets.some(w => typeof w.value === 'function'), 'late status must not recreate hidden widget');
      await f.command('status');
      assert.equal(typeof f.widgets.at(-1).value, 'function', 'explicit new status can show panel');
    } finally { release(); await pending; await f.close(); }
  }
});

test('team hide tool is idempotent and leaves monitoring, dispatch and tasks unchanged', async () => {
  const f = adapterFixture();
  try {
    const empty = await f.invoke({ action: 'hide' });
    assert.deepEqual(empty.details, { hidden: true, wasVisible: false });
    await f.command('status');
    await f.invoke({ action: 'monitor', enabled: true });
    const before = (await f.invoke({ action: 'status' })).details;
    const hidden = await f.invoke({ action: 'hide' });
    assert.deepEqual(hidden.details, { hidden: true, wasVisible: true });
    assert.equal(f.widgets.at(-1).value, undefined);
    const after = (await f.invoke({ action: 'status' })).details;
    assert.equal(after.monitoring, true); assert.equal(after.dispatch, true);
    assert.deepEqual(after.tasks, before.tasks);
    assert.equal(f.widgets.at(-1).value, undefined, 'polling must not reopen a hidden panel');
    assert.deepEqual((await f.invoke({ action: 'hide' })).details, { hidden: true, wasVisible: false });
  } finally { await f.close(); }
});

test('busy lead does not accumulate follow-ups; resolved notices disappear before settlement', async () => {
  const f = adapterFixture();
  try {
    await f.invoke({ action: 'monitor', enabled: true });
    await f.invoke({ action: 'status' });
    assert.equal(f.sent.length, 0);
    const evidence = await f.invoke({ action: 'read', id: 'task-a' });
    assert.equal(evidence.details.output, '│ Report from a\nVerified findings');
    await f.invoke({ action: 'resolve', id: 'task-a', outcome: 'completed', summary: 'Checked A' });
    await f.invoke({ action: 'resolve', id: 'task-b', outcome: 'failed', summary: 'Not sufficient' });
    assert.equal(f.boundary(), undefined);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test('fresh notices form one boundary message, preserving other extensions entries and no duplicate turns', async () => {
  const f = adapterFixture();
  try {
    await f.invoke({ action: 'monitor', enabled: true }); await f.invoke({ action: 'status' });
    const existing = { type: 'custom', customType: 'other', data: {} };
    const result = f.boundary({ entries: [existing] });
    assert.equal(result.entries.length, 2); assert.equal(result.entries[0], existing);
    assert.equal(result.continue, true);
    assert.match(result.entries[1].content, /task-a/); assert.match(result.entries[1].content, /task-b/);
    assert.equal(f.boundary(), undefined); assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test('pause discards buffered notices; status while paused cannot enqueue more wakeups', async () => {
  const f = adapterFixture();
  try {
    await f.invoke({ action: 'monitor', enabled: true }); await f.invoke({ action: 'status' });
    await f.invoke({ action: 'monitor', enabled: false });
    f.setIdle(true); await f.invoke({ action: 'status' });
    assert.equal(f.boundary(), undefined); assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test('message mode never requests continuation; idle wake mode sends one immediate batch without followUp', async () => {
  for (const mode of ['message', 'wake']) {
    const f = adapterFixture();
    try {
      await f.invoke({ action: 'monitor', enabled: true, notify: mode });
      if (mode === 'wake') f.setIdle(true);
      await f.invoke({ action: 'status' });
      if (mode === 'message') {
        const result = f.boundary(); assert.equal(result.entries.length, 1); assert.equal(result.continue, undefined);
        assert.equal(f.sent.length, 0);
      } else {
        assert.equal(f.sent.length, 1); assert.equal(f.sent[0].options.triggerTurn, true);
        assert.equal(f.sent[0].options.deliverAs, undefined);
      }
    } finally { await f.close(); }
  }
});
