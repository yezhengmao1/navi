import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { layoutFor } from './team-layout-fixture.mjs';
const { registerPanes } = await load('../../../../.pi/extensions/agent-team/panes');
const { TeamController } = await load('../../../../.pi/extensions/agent-team/team-controller');

function fixture() {
  const calls = [], saves = [], notices = [], confirms = [], agents = new Map();
  let count = 0;
  const control = { approve: true, failStart: false, failPrompt: false, replaceOnConfirm: false, now: 100000 };
  const state = { version: 2, scope: 'test', label: 'team', workspace: 'w1', anchor: 'w1:p1', members: [], tasks: [], notify: 'wake', resources: [] };
  const io = {
    check() {}, now() { return control.now; }, save(s) { saves.push(s); }, notify(text, wake) { notices.push({ text, wake }); },
    async confirm(title, text) {
      confirms.push({ title, text });
      if (control.replaceOnConfirm) for (const a of agents.values()) a.agent_session.value = 'different';
      return control.approve;
    },
    async git(args) { calls.push(['git', ...args]); return args.includes('rev-parse') ? '/repo\n' : ''; },
    async herdr(args) {
      calls.push(args);
      if (args[0] === 'agent' && args[1] === 'list') return { agents: structuredClone([...agents.values()]) };
      if (args[1] === 'layout') return layoutFor(state.pages.find(p => p.panes.includes(args[3])));
      if (args[1] === 'split') return { pane: { pane_id: `w1:p${++count + 1}` } };
      if (args[1] === 'create') return { root_pane: { pane_id: `w2:p${++count}` }, tab: { tab_id: `w2:t${count}` }, workspace: { workspace_id: 'w2' } };
      if (args[1] === 'start') {
        const a = { agent: 'pi', agent_status: 'idle', pane_id: args[args.indexOf('--pane') + 1], terminal_id: `term${count}`, agent_session: { value: `session${count}` }, completion_seq: 0 };
        agents.set(args[2], a);
        if (control.failStart) throw new Error('startup blocked');
        return { agent: a };
      }
      if (args[1] === 'get') {
        const a = agents.get(args[2]);
        if (!a) throw new Error('not found');
        return { agent: structuredClone(a) };
      }
      if (args[1] === 'prompt') {
        if (control.failPrompt) throw new Error('timeout before observed activity');
        agents.get(args[2]).agent_status = 'working';
        return { status: 'working' };
      }
      if (args[1] === 'read') return { text: 'Verified result' };
      return {};
    },
  };
  const c = new TeamController(state, io);
  const spawn = (p = {}) => c.spawn({ name: 'analysis', instructions: 'Analyze relationships', ...p }, { cwd: '/repo', model: 'test/model', thinking: 'high', bridge: '/trusted/herdr-agent-state.ts' });
  return { c, state, io, calls, saves, notices, confirms, agents, control, spawn };
}

test('dynamic member, startup identity, inherited model/thinking and no focus', async () => {
  const f = fixture(); const m = await f.spawn();
  assert.ok(f.calls[0].includes('--no-focus'));
  assert.deepEqual(f.calls[0].slice(0, 2), ['tab', 'create']);
  assert.equal(m.slot, 1);
  const start = f.calls.find(c => c[1] === 'start');
  assert.ok(start.includes('test/model')); assert.ok(start.includes('high'));
  assert.ok(m.terminal); assert.ok(m.session);
  assert.equal(f.calls.filter(c => c[1] === 'prompt').length, 0);
  await assert.rejects(f.spawn(), /already exists/);
});

test('task queue, dependency results, review gate and one completion notification', async () => {
  const f = fixture(); const a = await f.spawn(); const b = await f.spawn({ name: 'other' });
  const first = f.c.enqueue({ name: a.name, task: 'Analyze' });
  const second = f.c.enqueue({ name: b.name, task: 'Summarize', dependsOn: [first.id] });
  await f.c.tick(); assert.equal(first.state, 'running'); assert.equal(second.state, 'queued');
  f.agents.get(a.target).agent_status = 'done'; f.agents.get(a.target).completion_seq = 1;
  await f.c.tick(); assert.equal(first.state, 'review'); assert.equal(second.state, 'queued');
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].wake, true);
  await f.c.tick(); assert.equal(f.notices.length, 1);
  f.c.resolve({ id: first.id, outcome: 'completed', summary: 'Evidence: tests passed' });
  await f.c.tick(); assert.equal(second.state, 'running');
  assert.match(f.calls.filter(c => c[1] === 'prompt').at(-1)[3], /Evidence: tests passed/);
});

test('uncertain submissions are never replayed; reload retains task state', async () => {
  const f = fixture(); await f.spawn(); f.control.failPrompt = true;
  const task = f.c.enqueue({ name: 'analysis', task: 'Possibly delivered' });
  await f.c.tick(); assert.equal(task.state, 'awaiting-activity');
  f.control.now += 16000;
  await f.c.tick(); assert.equal(task.state, 'uncertain');
  const restored = new TeamController(structuredClone(f.state), f.io);
  await restored.tick(); await restored.tick();
  assert.equal(f.calls.filter(c => c[1] === 'prompt').length, 1);
});

test('slow submission gets a persisted observation window, not a replay or premature failure', async () => {
  const f = fixture(); const m = await f.spawn(); f.control.failPrompt = true;
  const task = f.c.enqueue({ name: m.name, task: 'Slow start' });
  await f.c.tick(); assert.equal(task.state, 'awaiting-activity'); assert.equal(f.notices.length, 0);
  const restored = new TeamController(structuredClone(f.state), f.io);
  f.control.now += 10000;
  await restored.tick(); assert.equal(restored.state.tasks[0].state, 'awaiting-activity');
  f.agents.get(m.target).agent_status = 'working';
  await restored.tick(); assert.equal(restored.state.tasks[0].state, 'running');
  f.agents.get(m.target).agent_status = 'done';
  await restored.tick(); assert.equal(restored.state.tasks[0].state, 'review');
  assert.equal(f.calls.filter(c => c[1] === 'prompt').length, 1);
  assert.equal(f.notices.length, 1);
});

test('bulk idle polling, idle backoff and batched bounded completion notice', async () => {
  const f = fixture(); const a = await f.spawn(); const b = await f.spawn({ name: 'other' });
  const before = f.calls.length;
  await f.c.tick(); assert.deepEqual(f.calls.slice(before), [['agent', 'list']]);
  assert.equal(f.c.pollDelay(), 30000);
  const first = f.c.enqueue({ name: a.name, task: 'A' }); const second = f.c.enqueue({ name: b.name, task: 'B' });
  assert.equal(f.c.pollDelay(), 3000);
  await f.c.tick();
  f.agents.get(a.target).agent_status = 'done'; f.agents.get(b.target).agent_status = 'done';
  await f.c.tick();
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].text, new RegExp(first.id)); assert.match(f.notices[0].text, new RegExp(second.id));
  assert.ok(f.notices[0].text.length < 1500);
  const overview = f.c.summary();
  assert.equal(overview.counts.review, 2); assert.ok(overview.lastObservedAt);
  assert.equal(overview.tasks[0].output, undefined);
  assert.match(f.c.taskDetail(first.id).output, /Verified result/);
});

test('members use dedicated four-corner tabs; fifth member starts next tab', async () => {
  const f = fixture(), members = [];
  for (let i = 0; i < 5; i++) members.push(await f.spawn({ name: `member-${i}` }));
  assert.equal(f.calls.filter(c => c[0] === 'tab' && c[1] === 'create').length, 2);
  assert.deepEqual(members.map(m => m.slot), [1, 2, 3, 4, 1]);
  const splits = f.calls.filter(c => c[1] === 'split');
  assert.deepEqual(splits.map(c => c[c.indexOf('--direction') + 1]), ['right', 'down', 'down']);
  assert.deepEqual(splits.map(c => c[3]), [members[0].pane, members[0].pane, members[1].pane]);
  assert.ok(splits.every(c => c[3] !== f.state.anchor));
});

test('cancelled completion read remains reconcilable and does not lose its notification', async () => {
  const f = fixture(); const m = await f.spawn();
  const task = f.c.enqueue({ name: m.name, task: 'Complete then read' });
  await f.c.tick(); f.agents.get(m.target).agent_status = 'done';
  const original = f.io.herdr;
  let cancelled = false;
  f.io.check = () => { if (cancelled) throw new Error('cancelled'); };
  f.io.herdr = async args => {
    if (args[1] === 'read') { cancelled = true; throw new Error('cancelled'); }
    return original(args);
  };
  await assert.rejects(f.c.tick(), /cancelled/);
  assert.equal(task.state, 'running'); assert.equal(task.output, undefined); assert.equal(f.notices.length, 0);
  cancelled = false; f.io.herdr = original;
  await f.c.tick();
  assert.equal(task.state, 'review'); assert.match(task.output, /Verified result/); assert.equal(f.notices.length, 1);
});

test('read-only missing bridge fails before creating any resources', async () => {
  const f = fixture();
  await assert.rejects(f.c.spawn({ name: 'readonly', instructions: 'Read', readOnly: true }, { cwd: '/repo' }), /trusted Herdr status bridge/);
  assert.equal(f.calls.length, 0);
});

test('fast completion on timeout is detected using completion sequence', async () => {
  const f = fixture(); const m = await f.spawn();
  const original = f.io.herdr;
  f.io.herdr = async args => {
    if (args[1] === 'prompt') { f.agents.get(m.target).completion_seq++; throw new Error('timeout'); }
    return original(args);
  };
  const t = f.c.enqueue({ name: m.name, task: 'Fast' });
  await f.c.tick(); assert.equal(t.state, 'review'); assert.match(t.output, /Verified result/);
});

test('blocked members notify once; no auto approval, no queued dependency dispatch', async () => {
  const f = fixture(); const m = await f.spawn(); const task = f.c.enqueue({ name: m.name, task: 'Do work' });
  await f.c.tick(); f.agents.get(m.target).agent_status = 'blocked';
  await f.c.tick(); await f.c.tick();
  assert.equal(task.state, 'blocked'); assert.equal(f.notices.length, 1);
  await assert.rejects(f.c.stop(m.name), /blocked/);
  assert.equal(f.calls.filter(c => c[1] === 'send-keys').length, 0);
});

test('close cancellation and replaced occupant are fail-closed', async () => {
  const f = fixture(); await f.spawn(); f.control.approve = false;
  await assert.rejects(f.c.stop('analysis', true), /Cancelled/);
  assert.equal(f.calls.filter(c => c[1] === 'close').length, 0);
  f.control.approve = true; f.control.replaceOnConfirm = true;
  await assert.rejects(f.c.stop('analysis', true), /occupant\/session changed/);
  assert.equal(f.calls.filter(c => c[1] === 'close').length, 0);
});

test('confirmed close only owned member, cancels queued tasks and retains worktree', async () => {
  const f = fixture(); const m = await f.spawn({ worktree: true });
  const task = f.c.enqueue({ name: m.name, task: 'Queued' });
  await assert.rejects(f.c.stop('unknown', true), /Unknown member/);
  await f.c.stop(m.name, true);
  assert.equal(m.state, 'closed'); assert.equal(task.state, 'cancelled');
  assert.equal(f.calls.filter(c => c[1] === 'close').length, 1);
  assert.equal(f.state.resources[0].kind, 'worktree');
  assert.equal(f.calls.filter(c => c[0] === 'git' && c.includes('remove')).length, 0);
});

test('new workspace root, custom cwd and read-only tool preset', async () => {
  const f = fixture(); await f.c.create({ topology: 'workspace', label: 'research', workspace: 'w1' }, '/custom');
  const m = await f.spawn({ readOnly: true });
  assert.equal(m.cwd, '/custom'); assert.equal(m.pane, 'w2:p2');
  assert.equal(m.slot, 1);
  assert.equal(f.calls.filter(c => c[1] === 'split').length, 0);
  const start = f.calls.find(c => c[1] === 'start');
  for (const arg of ['--no-extensions', '--extension', '/trusted/herdr-agent-state.ts', '--no-mcp', '--tools', 'read,grep,find,ls']) assert.ok(start.includes(arg));
  assert.equal(f.confirms.length, 1);
});

test('failed start persists recoverable member; no automatic respawn', async () => {
  const f = fixture(); f.control.failStart = true;
  await assert.rejects(f.spawn(), /retained/);
  assert.equal(f.state.members[0].state, 'needs-inspection');
  await f.c.recover('analysis');
  assert.equal(f.state.members[0].state, 'ready');
  assert.equal(f.calls.filter(c => c[1] === 'start').length, 1);
});

test('validation precedes mutations and dependencies cannot reference future tasks', async () => {
  const f = fixture();
  await assert.rejects(f.spawn({ name: '../bad' }), /name must/);
  await assert.rejects(f.spawn({ cwd: 'relative' }), /absolute/);
  await assert.rejects(f.spawn({ task: 'x', dependsOn: ['future'] }), /Unknown dependency/);
  assert.equal(f.calls.length, 0);
});

test('cancelled location/worktree creation has no side effects', async () => {
  const f = fixture(); f.control.approve = false;
  await assert.rejects(f.c.create({ topology: 'workspace', label: 'cancelled', workspace: 'w1' }, '/other'), /Cancelled/);
  assert.equal(f.state.label, 'team'); assert.equal(f.state.cwd, undefined);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.spawn({ worktree: true }), /Cancelled/);
  assert.equal(f.calls.filter(c => c.includes('add') || c.includes('split')).length, 0);
  assert.equal(f.state.resources.length, 0);
});

test('independent members run concurrently; message and silent modes do not wake lead', async () => {
  const f = fixture(); const a = await f.spawn(); const b = await f.spawn({ name: 'second' });
  f.state.notify = 'message';
  const x = f.c.enqueue({ name: a.name, task: 'A' }); const y = f.c.enqueue({ name: b.name, task: 'B' });
  await f.c.tick(); assert.equal(x.state, 'running'); assert.equal(y.state, 'running');
  f.agents.get(a.target).agent_status = 'idle'; await f.c.tick();
  assert.equal(f.notices[0].wake, false);
  f.state.notify = 'silent'; f.agents.get(b.target).agent_status = 'idle'; await f.c.tick();
  assert.equal(y.state, 'review'); assert.equal(f.notices.length, 1);
});

test('adapter guards, persistence, lifecycle abort and reload does not replay work', async () => {
  const old = { ...process.env };
  process.env.HERDR_ENV = '1'; process.env.HERDR_PANE_ID = 'w1:p1'; process.env.HERDR_SOCKET_PATH = '/mock'; process.env.HERDR_WORKSPACE_ID = 'w1';
  const f = fixture(); const entries = [], hooks = new Map(); let tool;
  const pi = {
    registerTool(t) { tool = t; }, registerCommand() {}, on(n, fn) { hooks.set(n, fn); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    sendMessage() {},
    async exec(binary, args) { return { code: 0, stdout: JSON.stringify({ result: await f.io.herdr(args) }) }; },
  };
  const ctx = { mode: 'tui', cwd: '/repo', hasUI: true, sessionManager: { getSessionId: () => 'lead', getBranch: () => entries }, ui: { confirm: async () => true, notify() {} } };
  registerPanes(pi);
  const invoke = (p, signal) => tool.execute('id', p, signal, undefined, ctx);
  try {
    process.env.HERDR_ENV = '0';
    await assert.rejects(invoke({ action: 'status' }), /require interactive/);
    process.env.HERDR_ENV = '1';
    const abort = new AbortController(); abort.abort();
    await assert.rejects(invoke({ action: 'spawn', name: 'x', instructions: 'x' }, abort.signal), /cancelled/);
    const results = await Promise.allSettled([1, 2].map(() => invoke({ action: 'spawn', name: 'api', instructions: 'Build API' })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    await invoke({ action: 'send', name: 'api', task: 'Queued task' });
    await hooks.get('session_shutdown')();
    registerPanes(pi);
    await invoke({ action: 'status' });
    assert.equal(f.calls.filter(c => c[1] === 'prompt').length, 0);
    assert.equal(entries.at(-1).data.tasks.length, 1);
    await hooks.get('session_shutdown')();
  } finally {
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_WORKSPACE_ID']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
});
