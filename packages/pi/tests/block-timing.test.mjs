import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, root, tui } from './helpers.mjs';
const { BlockClock, blockTimingAdapter, messageKey, timingRow, guardTimingLabel, default: register } = await load('block-timing');
const native = path => import(pathToFileURL(join(root, 'dist/modes/interactive', path)).href);
const { initTheme } = await native('theme/theme.js');
initTheme('dark', false);
const { AssistantMessageComponent } = await native('components/assistant-message.js');
const { ToolExecutionComponent } = await native('components/tool-execution.js');
const plain = lines => lines.map(tui.stripTerminalSequences).join('\n');
const message = () => ({ role: 'assistant', provider: 'test', model: 'test', timestamp: 1,
  content: [{ type: 'thinking', thinking: '分析中文' }, { type: 'text', text: 'Hello world' }], stopReason: 'stop' });

test('discovery skips previously decorated content but updateContent decorates new children', () => {
  let reads = 0;
  const m = { ...message(), get content() { reads++; return [{ type: 'text', text: 'hello' }]; } };
  const node = {
    lastMessage: m,
    contentContainer: { children: [{}, { render: () => ['hello'] }] },
    updateContent() { this.contentContainer.children = [{}, { render: () => ['new'] }]; },
  };
  const adapter = blockTimingAdapter(new BlockClock(), s => s);
  const root = { children: [node] };
  adapter.update(root);
  assert.ok(reads > 0);
  reads = 0;
  for (let i = 0; i < 100; i++) adapter.update(root);
  assert.equal(reads, 0, 'unchanged history must not be scanned again');
  node.updateContent();
  assert.ok(reads > 0);
  assert.match(node.contentContainer.children[1].render(80).join('\n'), /Output/);
  adapter.dispose();
});

test('file tool titles lose OSC 8 links without changing colors, output or other tools', () => {
  for (const terminator of ['\x07', '\x1b\\']) {
    for (const toolName of ['read', 'edit', 'write', 'bash']) {
      const path = '\x1b[36m/tmp/file.ts\x1b[39m';
      const linked = `\x1b]8;;file:///tmp/file.ts${terminator}${path}\x1b]8;;${terminator}`;
      const node = { toolName, toolCallId: 'a', updateResult() {}, render: () => [`${toolName} ${linked}`, linked] };
      const original = node.render;
      const adapter = blockTimingAdapter(new BlockClock(), s => s);
      adapter.update({ children: [node] });
      const rendered = node.render(80);
      assert.deepEqual(rendered, [`${toolName} ${toolName === 'bash' ? linked : path}`, linked]);
      adapter.dispose();
      assert.equal(node.render, original);
    }
  }
});

test('turn completion closes only active spans, preserves completed history and clears tracking', () => {
  const clock = new BlockClock();
  // Completed history must never be walked at agent_end, even in huge sessions.
  for (let i = 0; i < 10_000; i++) clock.messages.set(`old-${i}`, {
    values() { throw new Error('historical scan'); },
  });
  clock.update('current', 'thinking_start', 0, 10);
  clock.update('current', 'text_start', 1, 20);
  clock.startTool('done', 10); clock.finishTool('done', 20, 8);
  clock.startTool('running', 15);
  clock.finishActive(50);
  assert.equal(clock.elapsed('current', [0], 100), 10);
  assert.equal(clock.elapsed('current', [1], 100), 30);
  assert.deepEqual(clock.tools.get('done'), { start: 10, end: 20, duration: 8 });
  assert.equal(clock.tools.get('running').end, 50);
  clock.finishActive(100);
  assert.equal(clock.tools.get('running').end, 50);
  clock.finishTool('running', 110, 95);
  assert.deepEqual(clock.tools.get('running'), { start: 15, end: 110, duration: 95 }, 'late final execution timing overrides estimated close');
  const restored = { kind: 'text', start: 60 };
  clock.restoreMessage('restored', new Map([[0, restored]]));
  clock.finishActive(80);
  assert.equal(restored.end, 80);
  clock.startTool('orphan', 90);
  const orphan = clock.tools.get('orphan');
  clock.clear(); clock.finishActive(100);
  assert.equal(orphan.end, undefined);
});

test('stream deltas and finish only inspect active blocks, not completed content in the same message', () => {
  const clock = new BlockClock();
  for (let i = 0; i < 5000; i++) clock.update('long', 'text_start', i, i);
  const history = clock.messages.get('long');
  history[Symbol.iterator] = history.values = () => { throw new Error('historical block traversal'); };
  for (let i = 0; i < 100; i++) clock.update('long', 'text_delta', 4999, 5000 + i);
  clock.update('long', 'thinking_start', 5000, 5100);
  assert.equal(clock.elapsed('long', [4999, 5000], 5200), 201);
  clock.finish('long', 5300);
  assert.equal(clock.elapsed('long', [5000], 9000), 200);
  assert.equal(clock.elapsed('missing', [0], 9000), undefined);
});

test('restored simultaneous active blocks close correctly on transitions and replacement', () => {
  const clock = new BlockClock();
  const a = { kind: 'thinking', start: 10 }, b = { kind: 'text', start: 20 };
  clock.restoreMessage('a', new Map([[0, a], [1, b]]));
  clock.update('a', 'text_delta', 1, 30);
  assert.equal(a.end, 30); assert.equal(b.end, undefined);
  clock.restoreMessage('a', new Map([[2, { kind: 'text', start: 40 }]]));
  clock.finishActive(50);
  assert.equal(b.end, undefined, 'replacement must untrack old open spans');
  assert.equal(clock.elapsed('a', [2], 100), 10);
  clock.update('a', 'text_start', 3, 60);
  clock.clear(); clock.finishActive(80);
  assert.equal(clock.elapsed('a', [3], 100), undefined);
});

test('separate block clocks exclude initial waiting, close on end/transition, freeze on abort', () => {
  const clock = new BlockClock();
  clock.update('a', 'thinking_start', 0, 1000);
  clock.update('a', 'thinking_delta', 0, 1200);
  clock.update('a', 'thinking_end', 0, 1500);
  clock.update('a', 'text_start', 1, 2000);
  clock.update('a', 'text_delta', 1, 2500);
  assert.equal(clock.elapsed('a', [0], 9000), 500);
  assert.equal(clock.elapsed('a', [1], 2600), 600);
  clock.finish('a', 2800);
  assert.equal(clock.elapsed('a', [1], 9999), 800);
  assert.equal(clock.elapsed('unknown', [0], 9999), undefined);
  clock.update('b', 'thinking_delta', 0, 3000);
  clock.update('b', 'text_start', 1, 3100);
  assert.equal(clock.elapsed('b', [0], 9999), 100);
});

test('right aligned annotation fits ANSI and CJK even at narrow widths', () => {
  for (const width of [0, 1, 4, 8, 20, 80]) {
    const row = timingRow('\x1b[36m中文标题很长\x1b[0m', '12.6s', width, s => `\x1b[2m${s}\x1b[0m`);
    assert.equal(tui.visibleWidth(row), width);
  }
});

test('timing labels leave two background-painted columns clear for overlay scrollbars', () => {
  for (const width of [0, 1, 2, 4, 8, 20, 80]) {
    const row = timingRow('bash ' + 'x'.repeat(100), '0.1s', width, s => s,
      s => `\x1b[44m${s}\x1b[49m`);
    const text = tui.stripTerminalSequences(row);
    assert.equal(tui.visibleWidth(row), width);
    assert.ok(text.endsWith(' '.repeat(Math.min(2, width))));
    if (width >= 8) {
      assert.ok(text.endsWith('0.1s  '));
      assert.ok((text.slice(0, -1) + '│').includes('0.1s'));
      assert.ok(row.endsWith('  \x1b[49m'));
    }
  }
});

test('native assistant blocks render timings, survive update/collapse/resize, restore cleanly', () => {
  const m = message();
  const clock = new BlockClock();
  const key = messageKey(m);
  clock.update(key, 'thinking_start', 0, 0);
  clock.update(key, 'thinking_end', 0, 8200);
  clock.update(key, 'text_start', 1, 8300);
  clock.finish(key, 11700);
  const node = new AssistantMessageComponent(m);
  const original = node.updateContent;
  const tree = { getMountedRoots: () => [{ children: [node] }] };
  const adapter = blockTimingAdapter(clock, s => s, () => 15000);
  adapter.update(tree);
  let result = plain(node.render(60));
  assert.match(result, /Thinking +8\.2s/);
  assert.match(result, /Output +3\.4s/);
  assert.match(result, /分析中文/);
  node.setHideThinkingBlock(true);
  result = plain(node.render(60));
  assert.match(result, /Thinking\.\.\. +8\.2s/);
  assert.doesNotMatch(result, /分析中文/);
  node.setHideThinkingBlock(false);
  node.invalidate();
  adapter.update(tree);
  result = plain(node.render(60));
  assert.equal((result.match(/8\.2s/g) ?? []).length, 1);
  for (const width of [8, 20, 80]) for (const line of node.render(width)) assert.ok(tui.visibleWidth(line) <= width);
  adapter.dispose();
  assert.equal(node.updateContent, original);
  assert.doesNotMatch(plain(node.render(60)), /8\.2s|3\.4s/);
  assert.equal(m.content[0].thinking, '分析中文');
});

test('native tool blocks use distinct live clocks and persisted final duration', () => {
  const clock = new BlockClock();
  clock.tools.set('a', { start: 1000 });
  clock.tools.set('b', { start: 2000 });
  const a = new ToolExecutionComponent('bash', 'a', { command: 'pwd' }, {}, undefined, { requestRender() {} }, '/tmp');
  const b = new ToolExecutionComponent('read', 'b', { path: 'x' }, {}, undefined, { requestRender() {} }, '/tmp');
  const adapter = blockTimingAdapter(clock, s => s, () => 3500);
  adapter.update({ children: [a, b] });
  assert.match(plain(a.render(60)), /2\.5s/);
  assert.match(plain(b.render(60)), /1\.5s/);
  a.updateResult({ content: [{ type: 'text', text: 'done' }], durationMs: 1234, isError: false });
  clock.clear();
  assert.match(plain(a.render(60)), /1\.2s/);
  a.setExpanded(true);
  assert.match(plain(a.render(60)), /1\.2s/);
  assert.doesNotMatch(plain(b.render(60)), /\d\.\ds/);
  adapter.dispose();
  assert.doesNotMatch(plain(a.render(60)), /1\.2s/);
});

test('consecutive thinking blocks group their own durations; old messages remain unchanged', () => {
  const m = message();
  m.content.splice(1, 0, { type: 'thinking', thinking: '第二段' });
  const clock = new BlockClock();
  clock.update(messageKey(m), 'thinking_start', 0, 0);
  clock.update(messageKey(m), 'thinking_end', 0, 1000);
  clock.update(messageKey(m), 'thinking_start', 1, 1000);
  clock.finish(messageKey(m), 3000);
  const node = new AssistantMessageComponent(m);
  const adapter = blockTimingAdapter(clock, s => s);
  adapter.update({ children: [node] });
  assert.match(plain(node.render(60)), /Thinking +3\.0s/);
  assert.match(plain(node.render(60)), /Output/);
  adapter.dispose();
});

test('lifecycle persists only custom data, restores branch and cleans up', () => {
  const handlers = new Map();
  const entries = [];
  const pi = { events: { on: () => () => {} }, on: (name, fn) => handlers.set(name, fn), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  const controller = register(pi);
  const ctx = { mode: 'tui', ui: { theme: { fg: (_, s) => s } }, sessionManager: { getBranch: () => entries } };
  const m = message();
  const node = new AssistantMessageComponent(m);
  const tree = { children: [node], requestRender() {} };
  handlers.get('session_start')({}, ctx);
  controller.mount(tree, ctx);
  handlers.get('agent_start')({}, ctx);
  handlers.get('message_update')({ message: m, assistantMessageEvent: { type: 'text_start', contentIndex: 1 } });
  handlers.get('message_end')({ message: m });
  handlers.get('agent_end')();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, 'magic-ui:block-timing');
  assert.match(plain(node.render(60)), /Output +0\.0s/);
  handlers.get('session_switch')({}, ctx);
  assert.match(plain(node.render(60)), /Output +0\.0s/);
  entries.length = 0;
  handlers.get('session_tree')({}, ctx);
  assert.match(plain(node.render(60)), /Output/);
  assert.doesNotMatch(plain(node.render(60)), /0\.0s/);
  handlers.get('session_shutdown')();
});

test('guard stages exclude execution while reviewing, waiting, or blocked', () => {
  const guard = { toolCallId: 'a', reviewMs: 1200, waitMs: 0, phase: 'confirm', phaseStarted: 2000 };
  assert.equal(guardTimingLabel(guard, 99999, 7300), '审查 1.2s · 等待确认 5.3s');
  assert.equal(guardTimingLabel({ ...guard, phase: undefined, waitMs: 5300, status: 'passed' }, 100, 9000), '审查 1.2s · 等待确认 5.3s · 执行 0.1s');
  assert.match(guardTimingLabel({ ...guard, phase: undefined, status: 'blocked' }, 99999, 9000), /已阻止$/);
  assert.doesNotMatch(guardTimingLabel({ ...guard, status: 'interrupted' }, 99999, 9000), /执行/);
  assert.equal(guardTimingLabel(undefined, 100, 9000), '0.1s');
});

test('truncated timing titles paint the ellipsis in all tool states and fit narrow widths', () => {
  for (const bg of ['\x1b[44m', '\x1b[42m', '\x1b[41m']) {
    for (const width of [0, 1, 4, 6, 7, 8, 20, 80]) {
      const row = timingRow(`${bg}\x1b[1mbash scp 中文 ${'x'.repeat(100)} (timeout: 120)\x1b[0m`,
        '3.9s', width, s => s, s => `${bg}${s}\x1b[49m`);
      assert.equal(tui.visibleWidth(row), width);
      if (width >= 9) {
        assert.ok(row.includes(`${bg}…`), 'ellipsis must restore the tool background');
      }
    }
  }
});

test('timing tail paints padding and label with the tool background and resets title attributes', () => {
  const backgrounds = { pending: '\x1b[44m', success: '\x1b[42m', error: '\x1b[41m' };
  for (const bg of Object.values(backgrounds)) {
    const row = timingRow(`${bg}\x1b[1mbash\x1b[22m\x1b[49m`, '1.2s', 30,
      s => `\x1b[90m${s}\x1b[39m`, s => `${bg}${s}\x1b[49m`);
    const tail = row.slice(row.lastIndexOf(bg));
    assert.ok(tail.startsWith(bg + '\x1b[22;23;39m'));
    assert.match(tail, / +\x1b\[90m1\.2s/);
    assert.ok(tail.endsWith('\x1b[49m'));
    assert.equal(tui.visibleWidth(row), 30);
  }
});
