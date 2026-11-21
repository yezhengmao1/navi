import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { default: register } = await load('../magic-go');
function setup(branch = []) {
  const hooks = {}, commands = {}, tools = {}, sent = [], notices = [];
  let active = ['read'], aborts = 0;
  const ctx = { ui: { setStatus() {}, notify: msg => notices.push(msg) },
    sessionManager: { getBranch: () => branch }, isIdle: () => true,
    abort: () => aborts++, hasPendingMessages: () => false };
  register({ on: (n, h) => hooks[n] = h, registerCommand: (n, c) => commands[n] = c.handler,
    registerTool: t => tools[t.name] = t, getActiveTools: () => active, setActiveTools: names => active = names,
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
    sendMessage: (...args) => sent.push(args) });
  const fire = (n, e = {}) => hooks[n](e, ctx);
  const turn = (usage = { output: 9, totalTokens: 200 }, outcome = 'completed') => fire('turn_end', { message: { role: 'assistant', usage }, outcome });
  fire('session_start');
  return { ctx, branch, state: () => branch.at(-1)?.data, go: s => commands.go(s, ctx), fire, turn, sent, notices,
    active: () => active, aborts: () => aborts,
    settle: (overrides = {}) => fire('agent_before_settle', { outcome: 'completed', entries: [], continue: false, context: { pendingMessages: [] }, ...overrides }),
    report: (status, summary = 'test evidence') => tools.magic_go_report.execute('id', { status, summary }, undefined, undefined, ctx) };
}

test('explicit start triggers one run; continuation preserves prior proposals and yields to queued work', async () => {
  const h = setup();
  for (const s of ['', 'status', '--tokens 0 task', '--tokens -2 task', '--tokens 1k', '--other task']) await h.go(s);
  assert.equal(h.sent.length, 0); assert.equal(h.settle(), undefined);
  await h.go('--tokens 2k 修复测试');
  assert.equal(h.state().budget, 2000); assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1].triggerTurn, true); assert.deepEqual(h.active(), ['read', 'magic_go_report']);
  const prior = { type: 'custom', customType: 'another', data: {} };
  const next = h.settle({ entries: [prior] });
  assert.equal(next.entries[0], prior); assert.match(next.entries[1].content, /修复测试/); assert.equal(next.continue, true);
  assert.equal(h.settle({ continue: true }), undefined);
  assert.equal(h.settle({ context: { pendingMessages: [{}] } }), undefined);
  h.ctx.hasPendingMessages = () => true; assert.equal(h.settle(), undefined);
});

test('account the final tool turn; only an active goal accepts a verified completion or blocker report', async () => {
  const h = setup();
  await assert.rejects(h.report('complete'));
  await h.go('检查构建'); assert.equal(h.state().budget, 1_000_000); h.fire('turn_start');
  await assert.rejects(h.report('complete', '  '));
  await h.report('blocked', '需要用户选择目标平台'); h.turn({ input: 10, output: 2, cacheRead: 3, cacheWrite: 1 });
  assert.equal(h.state().status, 'paused'); assert.equal(h.state().used, 2); assert.equal(h.settle(), undefined);
  await h.go('resume'); h.fire('turn_start'); await h.report('complete'); h.turn();
  assert.equal(h.state().used, 11); assert.equal(h.state().status, 'complete'); assert.deepEqual(h.active(), ['read']);
  assert.equal(h.settle(), undefined); await h.go('resume'); assert.equal(h.sent.length, 2);
});

test('per-turn soft budget and missing usage stop continuation instead of spinning', async () => {
  for (const [usage, status] of [[{ output: 12 }, 'budget'], [{ totalTokens: 12 }, 'paused'], [{}, 'paused']]) {
    const h = setup(); await h.go('--tokens 10 run'); h.fire('turn_start'); h.turn(usage);
    assert.equal(h.state().status, status); assert.equal(h.aborts(), 1); assert.equal(h.settle(), undefined);
    if (status === 'budget') { await h.go('resume'); assert.equal(h.sent.length, 1); }
  }
});

test('input and cache do not consume the output budget; zero is a valid output count', async () => {
  const h = setup(); await h.go('run');
  for (const output of [0, 7, 999_993]) {
    h.fire('turn_start'); h.turn({ input: 2_000_000, cacheRead: 3_000_000, cacheWrite: 500, output, totalTokens: 5_000_500 + output });
    assert.equal(h.state().status, output === 999_993 ? 'budget' : 'active');
  }
  assert.equal(h.state().used, 1_000_000);
});

test('legacy totals are not silently relabelled as output after reload', async () => {
  const h = setup([{type: 'custom', customType: 'magic-go', data: { objective: 'old', status: 'active', budget: 200, used: 150, note: '' }}]);
  await h.go('status'); assert.match(h.notices.at(-1), /150\/200 旧版总 tokens/);
  await h.go('resume'); assert.equal(h.state().used, 0); assert.equal(h.state().unit, 'output');
  h.fire('turn_start'); h.turn({ output: 2, totalTokens: 99 }); assert.equal(h.state().used, 2);
});

test('pause, abort, error and clear never restart a stopped goal', async () => {
  const h = setup(); h.ctx.isIdle = () => false; await h.go('no busy start'); assert.equal(h.sent.length, 0);
  h.ctx.isIdle = () => true; await h.go('first'); await h.go('do not replace');
  assert.equal(h.state().objective, 'first');
  h.ctx.isIdle = () => false; await h.go('pause'); assert.equal(h.state().status, 'paused'); assert.equal(h.aborts(), 1);
  h.ctx.isIdle = () => true; await h.go('resume'); h.fire('agent_settled', { aborted: true });
  assert.equal(h.state().status, 'paused'); await h.go('resume'); assert.equal(h.settle({ outcome: 'error' }), undefined);
  assert.equal(h.state().status, 'paused'); await h.go('clear'); assert.equal(h.state(), null); assert.equal(h.settle(), undefined);
});

test('reopening or navigating a branch only restores that branch, paused and without traffic', async () => {
  const original = setup(); await original.go('branch A'); const fork = setup([...original.branch]);
  assert.equal(fork.state().status, 'paused'); assert.equal(fork.sent.length, 0); assert.equal(fork.settle(), undefined);
  await fork.go('resume'); assert.equal(fork.state().status, 'active');
  fork.branch.length = 0; fork.fire('session_tree'); assert.deepEqual(fork.active(), ['read']); assert.equal(fork.settle(), undefined);
  await fork.go('branch B'); fork.fire('session_shutdown'); assert.equal(fork.settle(), undefined);
  assert.equal(original.state().objective, 'branch A');
});
