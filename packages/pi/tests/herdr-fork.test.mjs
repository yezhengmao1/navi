import test from 'node:test';
import assert from 'node:assert/strict';
import { forkWorkflow, decodeResponse, sessionLabels, splitDirection } from '../extensions/magic-ui/herdr-fork/workflow.mjs';

function fixture(overrides = {}) {
  const calls = [], notices = [];
  const session = { path: '/tmp/a strange; session.jsonl', id: 'abc12345', cwd: '/project', modified: new Date(), firstMessage: 'hello' };
  const options = {
    args: '', env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' },
    ctx: { mode: 'tui', cwd: '/project', sessionManager: { getSessionFile: () => session.path },
      ui: { select: async (_, labels) => labels[0], confirm: async () => true, notify: (...x) => notices.push(x) } },
    list: async () => [session], uuid: () => '12345678-abcd-0000',
    run: async argv => {
      calls.push(argv);
      if (argv[1] === 'layout') return { layout: { panes: [{ pane_id: 'w1:p1', rect: { width: 200, height: 50 } }] } };
      if (argv[1] === 'split') return { pane: { pane_id: 'w1:p2' } };
      return {};
    }, ...overrides,
  };
  return { options, calls, notices, session };
}

test('selection creates a sibling with native fork args, not resume or shell interpolation', async () => {
  const f = fixture(); await forkWorkflow(f.options);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[1], ['pane', 'split', '--pane', 'w1:p1', '--direction', 'right', '--cwd', '/project', '--no-focus']);
  assert.deepEqual(f.calls[2].slice(-3), ['--', '--fork', f.session.path]);
  assert.equal(f.notices.at(-1)[1], 'info');
});
test('cancel has no side effects', async () => {
  const f = fixture(); f.options.ctx.ui.select = async () => undefined;
  await forkWorkflow(f.options); assert.equal(f.calls.length, 0);
});
test('outside herdr / noninteractive / invalid args never list or mutate', async () => {
  for (const change of [{ env: {} }, { args: 'wrong' }, { args: 'all' }]) {
    const f = fixture({ ...change, list: async () => { throw new Error('must not list'); } });
    await forkWorkflow(f.options); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.options.ctx.mode = 'rpc';
  await forkWorkflow(f.options); assert.equal(f.calls.length, 0);
});
test('declined cross-project confirmation', async () => {
  const f = fixture(); f.session.cwd = '/other';
  f.options.list = async () => [f.session];
  f.options.ctx.ui.confirm = async () => false;
  await forkWorkflow(f.options); assert.equal(f.calls.length, 0);
});
test('startup failure preserves pane and reports its ID without retry', async () => {
  const f = fixture(); const run = f.options.run;
  f.options.run = async argv => { const result = await run(argv); if (argv[0] === 'agent') throw new Error('timeout'); return result; };
  await forkWorkflow(f.options);
  assert.equal(f.calls.length, 3);
  assert.match(f.notices.at(-1)[0], /w1:p2/);
  assert.equal(f.notices.at(-1)[1], 'error');
});
test('missing pane ID prevents startup; empty sessions create nothing', async () => {
  const f = fixture(); f.options.run = async argv => { f.calls.push(argv); return {}; };
  await forkWorkflow(f.options); assert.equal(f.calls.length, 2);
  const empty = fixture({ list: async () => [] }); await forkWorkflow(empty.options); assert.equal(empty.calls.length, 0);
});
test('layout heuristic and terminal-safe unique labels', () => {
  assert.equal(splitDirection({}, 'p'), 'down');
  assert.equal(splitDirection({ panes: [{ pane_id: 'p', rect: { width: 100, height: 60 } }] }, 'p'), 'down');
  const f = fixture(); f.session.name = '\x1b[31mhello\nworld';
  const labels = sessionLabels([f.session, f.session], f.session.path);
  assert.notEqual(labels[0], labels[1]); assert.doesNotMatch(labels[0], /[\x00-\x1f]/);
});
test('CLI failures and malformed responses are rejected', () => {
  assert.deepEqual(decodeResponse({ code: 0, stdout: '{"result":{"ok":true}}' }), { ok: true });
  for (const result of [{ code: 1, stderr: 'offline' }, { code: 0, stdout: '?' }, { code: 0, stdout: '{"error":"failed"}' }, { code: 0, stdout: '{}' }]) {
    assert.throws(() => decodeResponse(result));
  }
});
