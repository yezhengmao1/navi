import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { layoutFor } from './team-layout-fixture.mjs';
const { allocateTeamPane } = await load('../../../../.pi/extensions/agent-team/tab-layout');

function fixture() {
  const calls = [], snapshots = [], pages = [];
  let tabs = 0, panes = 0;
  const options = {
    pages, label: 'team', workspace: 'w:1', cwd: '/repo', check() {},
    save(state) { snapshots.push(structuredClone(state)); },
    async run(args) {
      calls.push(args);
      assert.equal(snapshots.at(-1).at(-1).state, 'pending');
      if (args[1] === 'layout') return layoutFor(pages.find(p => p.panes.includes(args[3])));
      const pane_id = `w:p${++panes}`;
      return args[0] === 'tab'
        ? { root_pane: { pane_id }, tab: { tab_id: `w:t${++tabs}` } }
        : { pane: { pane_id } };
    },
  };
  return { calls, snapshots, pages, options };
}
const flag = (args, name) => args[args.indexOf(name) + 1];

test('1..9 allocate dedicated tabs in TL/TR/BL/BR order with per-member cwd and no focus', async () => {
  const f = fixture(), results = [];
  for (let n = 1; n <= 9; n++) results.push(await allocateTeamPane({ ...f.options, cwd: `/repo-${n}` }));
  assert.deepEqual(results.map(r => r.slot), [1, 2, 3, 4, 1, 2, 3, 4, 1]);
  assert.deepEqual(results.map(r => r.tab), ['w:t1', 'w:t1', 'w:t1', 'w:t1', 'w:t2', 'w:t2', 'w:t2', 'w:t2', 'w:t3']);
  assert.deepEqual(f.pages.map(p => p.panes.length), [4, 4, 1]);
  assert.deepEqual(f.calls.filter(a => a[0] === 'tab').map(a => [flag(a, '--label'), flag(a, '--workspace')]),
    [['team-1', 'w:1'], ['team-2', 'w:1'], ['team-3', 'w:1']]);
  assert.deepEqual(f.calls.filter(a => a[1] === 'split').map(a => [flag(a, '--pane'), flag(a, '--direction'), flag(a, '--ratio')]),
    [['w:p1', 'right', '0.5'], ['w:p1', 'down', '0.5'], ['w:p2', 'down', '0.5'],
      ['w:p5', 'right', '0.5'], ['w:p5', 'down', '0.5'], ['w:p6', 'down', '0.5']]);
  f.calls.filter(a => a[1] !== 'layout').forEach((args, i) => {
    assert.ok(args.includes('--no-focus'));
    assert.ok(!args.includes('--focus') && !args.includes('--current'));
    assert.equal(flag(args, '--cwd'), `/repo-${i + 1}`);
  });
});

for (const operation of ['create', 'split']) test(`${operation} timeout persists intent and cannot be blindly retried, including after reload`, async () => {
  const f = fixture();
  if (operation === 'split') await allocateTeamPane(f.options);
  let calls = 0;
  const original = f.options.run;
  f.options.run = async args => {
    if (args[1] === 'layout') return original(args);
    calls++;
    assert.equal(f.snapshots.at(-1).at(-1).intent.operation, operation);
    throw new Error('timeout');
  };
  await assert.rejects(allocateTeamPane(f.options), /timeout/);
  assert.equal(f.pages.at(-1).state, 'uncertain');
  for (const pages of [f.pages, f.snapshots.at(-1), f.snapshots.at(-2)])
    await assert.rejects(allocateTeamPane({ ...f.options, pages: structuredClone(pages) }), /pending or uncertain/);
  assert.equal(calls, 1);
});

test('failed intent persistence never invokes CLI', async () => {
  const f = fixture();
  await assert.rejects(allocateTeamPane({ ...f.options, save() { throw new Error('disk'); } }), /disk/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(allocateTeamPane(f.options), /pending or uncertain/);
});

test('malformed response and failed final persistence quarantine page', async () => {
  for (const mode of ['response', 'save']) {
    const f = fixture();
    if (mode === 'response') f.options.run = async () => ({ root_pane: { pane_id: '--bad' }, tab: { tab_id: 't1' } });
    else { const save = f.options.save; let n = 0; f.options.save = state => { if (++n === 2) throw new Error('disk'); save(state); }; }
    await assert.rejects(allocateTeamPane(f.options));
    assert.equal(f.pages[0].state, 'uncertain');
    await assert.rejects(allocateTeamPane(f.options), /uncertain/);
  }
});

test('missing/closed anchor failure retains consumed slots and does not retry', async () => {
  const f = fixture();
  await allocateTeamPane(f.options);
  await allocateTeamPane(f.options);
  f.options.run = async args => { assert.equal(flag(args, '--pane'), 'w:p1'); throw new Error('pane missing'); };
  await assert.rejects(allocateTeamPane(f.options), /pane missing/);
  assert.deepEqual(f.pages[0].panes, ['w:p1', 'w:p2']);
  assert.equal(f.pages[0].intent.slot, 3);
  await assert.rejects(allocateTeamPane(f.options), /uncertain/);
});

test('moved anchor, extra panes, zoom and modified geometry never get split', async () => {
  for (const change of [
    layout => { layout.tab_id = 'another-tab'; },
    layout => { layout.panes.push({ pane_id: 'outsider', rect: { x: 0, y: 0, width: 10, height: 10 } }); },
    layout => { layout.zoomed = true; },
    layout => { layout.panes[0].rect.width = 150; },
  ]) {
    const f = fixture(); await allocateTeamPane(f.options); await allocateTeamPane(f.options);
    const original = f.options.run; let mutations = 0;
    f.options.run = async args => {
      if (args[1] !== 'layout') mutations++;
      const result = await original(args);
      if (args[1] === 'layout') change(result.layout);
      return result;
    };
    await assert.rejects(allocateTeamPane(f.options), /changed/);
    assert.equal(mutations, 0); assert.equal(f.pages[0].state, 'uncertain');
  }
});

test('invalid inputs, persisted IDs and cancellation cannot issue commands', async () => {
  for (const patch of [{ workspace: '--current' }, { cwd: 'relative' }, { label: '\n' }, { check() { throw new Error('cancelled'); } }]) {
    const f = fixture();
    await assert.rejects(allocateTeamPane({ ...f.options, ...patch }));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await allocateTeamPane(f.options);
  f.pages[0].panes[0] = '';
  await assert.rejects(allocateTeamPane(f.options), /ID/);
  assert.equal(f.calls.length, 1);
});
