import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { ControlQueue } = await load('../../../../.pi/extensions/agent-team/control-queue');
const { registerPanes } = await load('../../../../.pi/extensions/agent-team/panes');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const promptly = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('control operation blocked')), 1000); })]); }
  finally { clearTimeout(timer); }
};

test('member queues isolate stalls, preserve FIFO, urgent work aborts only its own lane', async () => {
  const q = new ControlQueue(), started = deferred(), events = [];
  const first = q.run('a', signal => new Promise((_, reject) => {
    started.resolve(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const firstRejected = assert.rejects(first, /cancelled/);
  await started.promise;
  const queued = q.run('a', async () => events.push('must not run'));
  const queuedRejected = assert.rejects(queued, /cancelled/);
  await promptly(q.run('b', async () => events.push('b')));
  await promptly(q.run('a', async () => events.push('stop-a'), undefined, true));
  await Promise.all([firstRejected, queuedRejected]);
  assert.deepEqual(events, ['b', 'stop-a']);
  assert.equal(q.busy('a'), false);
});

test('adapter pause/status/other-member close bypass blocked read; same-member stop cancels control I/O', async () => {
  const old = { ...process.env };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p0', HERDR_SOCKET_PATH: '/fake' });
  const entries = [], hooks = new Map(), calls = [], readStarted = deferred(); let tool;
  const members = ['slow', 'fast'].map(name => ({ name, target: name, pane: `w:${name}`, terminal: name, session: `session-${name}`, cwd: '/repo', state: 'ready' }));
  entries.push({ type: 'custom', customType: 'agent-team', data: { version: 2, scope: '/fake:w:p0:lead', label: 'test', anchor: 'w:p0', members, tasks: [], notify: 'silent', resources: [] } });
  const live = m => ({ agent: 'pi', pane_id: m.pane, terminal_id: m.terminal, agent_session: { value: m.session }, agent_status: 'idle' });
  const pi = {
    on(n, fn) { hooks.set(n, fn); }, registerTool(t) { tool = t; }, registerCommand() {}, sendMessage() {},
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    async exec(_bin, args, options) {
      calls.push({ args, timeout: options.timeout });
      if (args[1] === 'read' && args[2] === 'slow') {
        readStarted.resolve();
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      }
      const result = args[1] === 'list' ? { agents: members.map(live) } : args[1] === 'get' ? { agent: live(members.find(m => m.name === args[2])) } : {};
      return { code: 0, stdout: JSON.stringify({ result }) };
    },
  };
  const ctx = { cwd: '/repo', mode: 'tui', hasUI: true, ui: { confirm: async () => true, notify() {} }, sessionManager: { getSessionId: () => 'lead', getBranch: () => entries } };
  registerPanes(pi);
  const invoke = p => tool.execute('id', p, undefined, undefined, ctx);
  try {
    const pending = invoke({ action: 'read', name: 'slow' });
    const cancelled = assert.rejects(pending, /cancelled/);
    await readStarted.promise;
    const pause = await promptly(invoke({ action: 'monitor', enabled: false }));
    assert.equal(pause.details.dispatch, false);
    const status = await promptly(invoke({ action: 'status' }));
    assert.deepEqual(status.details.busyMembers, ['slow']);
    await promptly(invoke({ action: 'close', name: 'fast' }));
    await promptly(invoke({ action: 'stop', name: 'slow' }));
    await cancelled;
    assert.equal(calls.filter(c => c.args[1] === 'close').length, 1);
    assert.ok(calls.every(c => c.timeout === 5000));
    ctx.ui.confirm = async () => assert.fail('Ordinary team management is approved by lead policy, not a member/user dialog');
    await promptly(invoke({ action: 'recover', name: 'slow' }));
    await promptly(invoke({ action: 'close', name: 'slow' }));
    assert.equal(calls.filter(c => c.args[1] === 'close').length, 2);
  } finally {
    hooks.get('session_shutdown')();
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
});

test('pause during worktree creation is immediate and a late spawn cannot re-enable dispatch', async () => {
  const old = { ...process.env };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p0', HERDR_SOCKET_PATH: '/fake' });
  const entries = [], hooks = new Map(), started = deferred(), release = deferred();
  // Saved state supplies the workspace independently of the host environment.
  entries.push({ type: 'custom', customType: 'agent-team', data: { scope: '/fake:w:p0:lead', workspace: 'w1' } }); let tool, agent;
  const pi = {
    on(n, fn) { hooks.set(n, fn); }, registerTool(t) { tool = t; }, registerCommand() {}, sendMessage() {},
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    async exec(bin, args, options) {
      if (bin === 'git') {
        if (args.includes('rev-parse')) return { code: 0, stdout: '/repo' };
        assert.equal(options.timeout, 120000); started.resolve(); await release.promise;
        return { code: 0, stdout: '' };
      }
      let result = {};
      if (args[1] === 'layout') result = { layout: { panes: [{ pane_id: 'w:p0', rect: { width: 200, height: 40 } }] } };
      if (args[1] === 'split') result = { pane: { pane_id: 'w:p1' } };
      if (args[0] === 'tab' && args[1] === 'create') result = { root_pane: { pane_id: 'w:p1' }, tab: { tab_id: 'w:t1' } };
      if (args[1] === 'start') {
        assert.equal(options.timeout, 35000);
        agent = { agent: 'pi', pane_id: 'w:p1', terminal_id: 'new', agent_session: { value: 'new-session' }, agent_status: 'idle' };
      }
      if (args[1] === 'get') result = { agent };
      if (args[1] === 'list') result = { agents: agent ? [agent] : [] };
      assert.notEqual(args[1], 'prompt', 'paused team must not dispatch');
      return { code: 0, stdout: JSON.stringify({ result }) };
    },
  };
  const ctx = { cwd: '/repo', mode: 'tui', hasUI: true, ui: { confirm: async () => true, notify() {} }, sessionManager: { getSessionId: () => 'lead', getBranch: () => entries } };
  registerPanes(pi);
  const invoke = p => tool.execute('id', p, undefined, undefined, ctx);
  try {
    const spawn = invoke({ action: 'spawn', name: 'new', instructions: 'Build', task: 'Queued', worktree: true });
    await started.promise;
    await promptly(invoke({ action: 'monitor', enabled: false }));
    release.resolve(); await spawn;
    const status = await invoke({ action: 'status' });
    assert.equal(status.details.monitoring, false);
    assert.equal(status.details.counts.queued, 1);
  } finally {
    release.resolve(); await hooks.get('session_shutdown')();
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
});

test('task output stored separately once and restored without copying into metadata snapshots', async () => {
  const old = { ...process.env };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p0', HERDR_SOCKET_PATH: '/fake' });
  const entries = [{ type: 'custom', customType: 'agent-team', data: {
    version: 2, scope: '/fake:w:p0:lead', label: 'test', anchor: 'w:p0', notify: 'silent', resources: [],
    members: [{ name: 'done', target: 'done', pane: 'w:p1', terminal: 'term', session: 'session', state: 'ready', cwd: '/repo' }],
    tasks: [{ id: 'task-result', member: 'done', text: 'x', state: 'review', dependsOn: [], output: 'evidence'.repeat(1000) }],
  } }];
  const hooks = new Map(); let tool;
  const pi = {
    on(n, fn) { hooks.set(n, fn); }, registerTool(t) { tool = t; }, registerCommand() {}, sendMessage() {},
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    async exec() { return { code: 0, stdout: JSON.stringify({ result: { agents: [{ agent: 'pi', pane_id: 'w:p1', terminal_id: 'term', agent_session: { value: 'session' }, agent_status: 'idle' }] } }) }; },
  };
  const ctx = { cwd: '/repo', mode: 'tui', hasUI: true, ui: { notify() {} }, sessionManager: { getSessionId: () => 'lead', getBranch: () => entries } };
  registerPanes(pi);
  const invoke = p => tool.execute('id', p, undefined, undefined, ctx);
  try {
    await invoke({ action: 'status' }); await invoke({ action: 'status' });
    assert.equal(entries.filter(e => e.customType === 'agent-team-result').length, 1);
    assert.ok(entries.filter(e => e.customType === 'agent-team').slice(1).every(e => e.data.tasks.every(t => t.output === undefined)));
    hooks.get('session_shutdown')(); registerPanes(pi);
    const read = await invoke({ action: 'read', id: 'task-result' });
    assert.equal(read.details.output, 'evidence'.repeat(1000));
    await invoke({ action: 'status' });
    assert.equal(entries.filter(e => e.customType === 'agent-team-result').length, 1);
  } finally {
    hooks.get('session_shutdown')();
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
});
