import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
const { SubagentStatus } = await load('../../../../.pi/extensions/subagent/status');

test('independent rows, queued/running/terminal states and next batch reset', () => {
  const status = new SubagentStatus();
  let lines;
  const publish = value => { lines = value; };
  const batch = status.start('one', ['worker', 'worker'], publish);
  batch.set(0, 'running');
  assert.match(lines[0], /0\/2/);
  assert.match(lines[1], /运行中/);
  assert.match(lines[2], /等待中/);
  batch.set(0, 'completed');
  assert.match(lines[0], /1\/2/);
  batch.set(1, 'failed');
  batch.finish(false);
  assert.match(lines[0], /2\/2/);
  status.start('two', ['scout'], publish);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /0\/1/);
});

test('concurrent batches and reset ignore stale completions', () => {
  const status = new SubagentStatus();
  let lines;
  const publish = value => { lines = value; };
  const a = status.start('a', ['worker'], publish);
  a.set(0, 'running');
  const b = status.start('b', ['worker'], publish);
  b.set(0, 'completed');
  assert.match(lines[0], /1\/2/);
  status.reset();
  status.start('a', ['new'], publish);
  a.set(0, 'completed');
  assert.match(lines[1], /new/);
  assert.match(lines[0], /0\/1/);
});

test('chain stops skip remaining steps; abort cancels queued steps', () => {
  for (const cancelled of [false, true]) {
    let lines;
    const batch = new SubagentStatus().start('a', ['first', 'next'], value => { lines = value; });
    batch.set(0, cancelled ? 'cancelled' : 'failed');
    batch.finish(cancelled);
    assert.match(lines[2], cancelled ? /已取消/ : /已跳过/);
    assert.match(lines[0], /2\/2/);
  }
});

test('finished status auto-hides; a new batch cancels the previous timer', async () => {
  const status = new SubagentStatus(15);
  let lines;
  const publish = value => { lines = value; };
  const first = status.start('first', ['a'], publish);
  first.set(0, 'completed');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(lines, undefined);

  const second = status.start('second', ['b'], publish);
  second.set(0, 'failed');
  const third = status.start('third', ['c'], publish);
  third.set(0, 'running');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(lines[1], /运行中.*c/);
  third.set(0, 'completed');
  status.reset();
  lines = ['reset'];
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(lines, ['reset']);
});

test('extension loads and registers status reset hooks', async () => {
  const { default: register } = await load('../../../../.pi/extensions/subagent/index');
  const events = new Map();
  let tool;
  register({ events: { emit() {} }, registerCommand() {}, on: (name, fn) => events.set(name, fn), registerTool: value => { tool = value; } });
  assert.equal(tool.name, 'subagent');
  const frames = [];
  const result = await tool.execute('missing-agent', { agent: '__nonexistent_status_test__', task: 'test' },
    new AbortController().signal, undefined, {
      cwd: '/tmp', mode: 'tui', hasUI: true,
      ui: { setWidget: (_id, content) => frames.push(typeof content === 'function'
        ? content({}, { fg: (_color, text) => text }).render(80) : content) },
    });
  assert.equal(result.isError, true);
  assert.ok(frames.some(lines => lines.some(line => line.includes('运行中'))));
  assert.equal(frames.at(-1)[0], '');
  assert.match(frames.at(-1)[1], /子任务/);
  assert.match(frames.at(-1)[2], /失败/);
  for (const event of ['session_start', 'session_switch', 'session_shutdown']) {
    let cleared = false;
    events.get(event)({}, { mode: 'tui', ui: { setWidget: (id, lines) => {
      assert.equal(id, 'subagent-status');
      assert.equal(lines, undefined);
      cleared = true;
    } } });
    assert.ok(cleared);
  }
});
