import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { load } from './helpers.mjs';
const { PermissionBroker, requestApproval } = await load('../../../../.pi/extensions/agent-team/permission-broker');
const { registerPanes } = await load('../../../../.pi/extensions/agent-team/panes');
const { default: registerMember } = await load('../../../../.pi/extensions/agent-team/member-permissions');
const req = (risk = 'medium') => ({ source: 'safety-guard', session: '/session/member.jsonl', risk, title: '操作审批', body: '完整命令：移动文件', toolCallId: 'call-1', toolName: 'bash', input: { command: 'mv 源文件 目标文件' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const rawRequest = (config, input) => new Promise((resolve, reject) => {
  const socket = net.createConnection(config.socket); socket.setEncoding('utf8'); let raw = '';
  socket.on('connect', () => socket.write(JSON.stringify(input) + '\n'));
  socket.on('data', chunk => { raw += chunk; if (raw.includes('\n')) { socket.destroy(); resolve(JSON.parse(raw)); } });
  socket.on('error', reject);
});

test('broker binds exact member/session, rejects replay/bad token, survives controlled reload', async () => {
  const decisions = [], validations = [];
  let expectedSession = req().session;
  const decide = async r => { decisions.push(r); return { allow: r.risk !== 'high' }; };
  const validate = async r => { validations.push(r); if (r.session !== expectedSession) throw new Error('stale session'); };
  let broker = new PermissionBroker(undefined, decide, validate);
  const directory = broker.directory;
  try {
    await broker.start();
    const path = broker.register('member'), config = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(statSync(directory).mode & 0o077, 0); assert.equal(statSync(path).mode & 0o077, 0);
    assert.equal((await requestApproval(config, req())).allow, true);
    assert.deepEqual(decisions[0].input, req().input);
    assert.equal(validations.length, 2, 'identity rechecked after decision');
    assert.equal((await requestApproval(config, req('high'))).allow, false);
    const replay = { ...req(), id: 'same-id', member: 'member', token: config.token };
    assert.equal((await rawRequest(config, replay)).allow, true);
    assert.equal((await rawRequest(config, replay)).allow, false);
    const before = decisions.length;
    assert.equal((await rawRequest(config, { ...replay, id: 'bad-token', token: 'wrong' })).allow, false);
    assert.equal(decisions.length, before);
    expectedSession = 'changed';
    assert.equal((await requestApproval(config, req())).allow, false);
    await broker.close();
    assert.equal((await requestApproval(config, req(), undefined, 100)).allow, false);
    expectedSession = req().session;
    broker = new PermissionBroker(directory, decide, validate); await broker.start();
    assert.equal(broker.register('member'), path);
    assert.equal((await requestApproval(config, req())).allow, true);
  } finally { await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('reload during broker startup closes the socket and permits a clean restart', { timeout: 2000 }, async () => {
  const broker = new PermissionBroker(undefined, async () => ({ allow: false }), async () => {});
  let replacement;
  try {
    const starting = broker.start();
    await Promise.allSettled([starting, broker.close()]);
    replacement = new PermissionBroker(broker.directory, async () => ({ allow: false }), async () => {});
    await replacement.start();
  } finally {
    await broker.close(); await replacement?.close();
    rmSync(broker.directory, { recursive: true, force: true });
  }
});

test('disconnect/cancellation revokes a pending high-risk approval and never permits late consent', async () => {
  const entered = deferred(), release = deferred(); let approvalSignal;
  const broker = new PermissionBroker(undefined, async (_r, signal) => { approvalSignal = signal; entered.resolve(); await release.promise; return { allow: true }; }, async () => {});
  try {
    await broker.start(); const config = JSON.parse(readFileSync(broker.register('member'), 'utf8'));
    const abort = new AbortController();
    const pending = requestApproval(config, req('high'), abort.signal);
    await entered.promise; abort.abort();
    assert.equal((await pending).allow, false);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(approvalSignal.aborted, true);
    release.resolve();
  } finally { release.resolve(); await broker.close(); rmSync(broker.directory, { recursive: true, force: true }); }
});

function events() {
  const listeners = new Map();
  return {
    on(name, fn) { const list = listeners.get(name) ?? new Set(); list.add(fn); listeners.set(name, list); return () => list.delete(fn); },
    emit(name, value) { for (const fn of listeners.get(name) ?? []) fn(value); },
  };
}

test('lead centrally auto-approves medium, asks user for high, and launches managed children in dedicated tabs', async () => {
  const old = { ...process.env };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p0', HERDR_WORKSPACE_ID: 'w', HERDR_SOCKET_PATH: '/fake' });
  const entries = [], hooks = new Map(), dialogs = [], calls = [], bus = events(); let tool, startArgs, agent, approve = false, directory;
  const pi = {
    events: bus, on(n, fn) { hooks.set(n, fn); }, registerTool(t) { tool = t; }, registerCommand() {}, sendMessage() {},
    getActiveTools: () => ['read', 'bash', 'network_search'],
    getAllTools: () => ['read', 'bash', 'network_search'].map(name => ({ name })),
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    async exec(_bin, args) {
      calls.push(args); let result = {};
      if (args[0] === 'tab' && args[1] === 'create') result = { root_pane: { pane_id: 'w:p1' }, tab: { tab_id: 'w:t1' } };
      if (args[1] === 'start') {
        startArgs = args;
        agent = { agent: 'pi', pane_id: 'w:p1', terminal_id: 'member-terminal', agent_session: { value: req().session }, agent_status: 'idle' };
      }
      if (args[1] === 'get') result = { agent };
      if (args[1] === 'list') result = { agents: agent ? [agent] : [] };
      return { code: 0, stdout: JSON.stringify({ result }) };
    },
  };
  const ctx = { cwd: '/repo', mode: 'tui', hasUI: true, ui: { notify() {}, confirm: async (...args) => { dialogs.push(args); return approve; } }, sessionManager: { getSessionId: () => 'lead', getBranch: () => entries } };
  registerPanes(pi);
  const invoke = p => tool.execute('id', p, undefined, undefined, ctx);
  try {
    await invoke({ action: 'spawn', name: 'member', instructions: 'Build requested feature' });
    await invoke({ action: 'monitor', enabled: false });
    assert.deepEqual(calls[0].slice(0, 2), ['tab', 'create']); assert.ok(calls[0].includes('--no-focus'));
    for (const flag of ['--no-extensions', '--no-mcp', '--no-approve']) assert.ok(!startArgs.includes(flag), `default profile must not disable lead resources: ${flag}`);
    assert.ok(startArgs.includes('--team-approval-config'));
    assert.equal(startArgs.filter(x => x === '--extension').length, 3);
    const config = JSON.parse(readFileSync(startArgs[startArgs.indexOf('--team-approval-config') + 1], 'utf8'));
    directory = entries.find(e => e.data.approvalDirectory)?.data.approvalDirectory;
    assert.deepEqual(config.activeTools, ['read', 'bash', 'network_search']);
    assert.equal((await requestApproval(config, req())).allow, true); assert.equal(dialogs.length, 0);
    assert.equal((await requestApproval(config, req('high'))).allow, false); assert.equal(dialogs.length, 1);
    assert.match(dialogs[0][0], /member/); assert.match(dialogs[0][1], /mv 源文件 目标文件/);
    approve = true;
    assert.equal((await requestApproval(config, req('high'))).allow, true);
    assert.ok(entries.some(e => e.customType === 'agent-team-approval' && e.data.automatic && e.data.allow));
    // The lead's own safety-guard uses the identical central policy.
    const localDecision = new Promise(resolve => bus.emit('agent-team:approval', { ...req(), ctx, handled: false, reply: resolve }));
    assert.equal((await localDecision).allow, true);
    assert.equal(dialogs.length, 2);
    // The actual member extension claims the guard request and relays it; no member UI is used.
    const childBus = events(), childHooks = new Map();
    let selectedTools;
    registerMember({ events: childBus, registerFlag() {}, getFlag: () => startArgs[startArgs.indexOf('--team-approval-config') + 1],
      getAllTools: pi.getAllTools, setActiveTools: tools => { selectedTools = tools; }, on: (n, f) => childHooks.set(n, f) });
    const childCtx = { mode: 'tui', hasUI: true, sessionManager: { getSessionFile: () => req().session },
      ui: { notify() {}, confirm() { assert.fail('must not prompt in member'); } } };
    childHooks.get('session_start')({}, childCtx);
    childHooks.get('before_agent_start')({}, childCtx);
    assert.deepEqual(selectedTools, ['read', 'bash', 'network_search']);
    assert.equal(await childCtx.ui.confirm('Ordinary extension permission', 'Use the configured network tool'), true);
    assert.equal(dialogs.length, 2, 'ordinary extension confirm is automatically decided by lead');
    approve = false;
    const childResult = await new Promise(resolve => childBus.emit('agent-team:approval', { ...req('high'), ctx: childCtx, handled: false, reply: resolve }));
    assert.equal(childResult.allow, false); assert.equal(dialogs.length, 3);
    childHooks.get('session_shutdown')();
    // A member session changed after consent invalidates that approval.
    ctx.ui.confirm = async () => { agent.agent_session.value = '/different/session'; return true; };
    assert.equal((await requestApproval(config, req('high'))).allow, false);
  } finally {
    await hooks.get('session_shutdown')();
    if (directory) rmSync(directory, { recursive: true, force: true });
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
});
